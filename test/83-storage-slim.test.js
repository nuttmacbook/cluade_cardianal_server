import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";
import { pageTransactionsOf, pageTransactionsTo, cursorTransactionsTo } from "../src/node/explorer-api.js";

/*
 * ลดข้อมูลซ้ำโดยไม่เสียความสามารถ
 *   - ดัชนี (tx / txn / txto / sigtx / event / eventidx / eventsig / holding / rejected) ไม่มี history และไม่อยู่ใน blockundo
 *   - rebuildFrom ลบดัชนีทั้งหมดแล้วให้ replay สร้างใหม่ → ได้ดัชนีเหมือนเชนที่สร้างถึง block นั้นตรง ๆ
 *   - txn ไม่เก็บ signature / digest (อยู่ใน blockbody / ดัชนี tx แล้ว) แต่ยังอ่านได้ครบ
 *   - txto ไม่เก็บ blockNumber / index (อยู่ใน key) และ timestamp (อยู่ใน header) แต่ API ได้ field ครบ
 */

const T = Date.parse("2026-01-01T00:00:00Z");
const OPTIONS = {
  requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true, deriveProgramAddress: false,
  gas: { call: 100, read: 10, write: 50, byte: 1, price: 1 },
};
const ALICE_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);
const BOB = "0x00000000000000000000000000000000000000b0";
const TOKEN = `function program() {
  function initialization(params) { writeDB(map("balances", params.context.sender), 1000n) }
  function transfer(params) {
    const from = params.context.sender
    writeDB(map("balances", from), (readDB(map("balances", from)) || 0n) - params.input.amount)
    writeDB(map("balances", params.input.to), (readDB(map("balances", params.input.to)) || 0n) + params.input.amount)
    emit("Transfer", { from, to: params.input.to, amount: params.input.amount }, { indexed: ["from", "to"] })
  }
  return { transfer }
}`;

/** เชน: block 1 deploy + init · block 2.. โอน token ด้วย tx ที่เซ็นแล้ว */
function buildChain(blocks = 5) {
  const vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  vm.db.load({ [`${alice}:native:received`]: "1000000n" });
  const first = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  first.deploy({ programUuid: "token", code: TOKEN, context: { sender: alice, origin: alice }, nonce: 0 });
  first.init({ programUuid: "token" });
  first.commit();
  const signatures = [];
  for (let n = 2; n <= blocks; n += 1) {
    const tx = { chainId: 1, action: "call", from: alice, to: "token", method: "transfer", input: { to: BOB, amount: "10n" }, value: 0, nonce: n - 1, gasLimit: 0, gasPrice: 0 };
    const signature = sign.signTransaction(tx, ALICE_KEY);
    const verified = sign.verifyTransaction({ tx, signature });
    const block = vm.createBlock({ timestamp: T + n * 1000, feeRecipient: "miner" });
    assert.equal(block[verified.method](verified.request).status, "success");
    block.commit();
    signatures.push({ hash: vm.getBlock(n).txHashes[0], signature, digest: verified.hash });
  }
  return { vm, signatures };
}

const INDEX_PATTERN = /^(tx|sigtx|txto|event|eventidx|eventsig|holding|rejtx|rejfrom|blockrejected):|:txn:/;
const indexes = (vm) => Object.fromEntries(Object.entries(vm.db.snapshot()).filter(([key]) => INDEX_PATTERN.test(key)));

test("ดัชนีไม่มี history และไม่อยู่ใน blockundo · state ยังมีครบ", () => {
  const { vm } = buildChain();
  const historyOf = vm.db.listKeys("history:").map((key) => VM.decodeDbKey(key).dbKey);
  assert.ok(historyOf.length > 0);
  assert.deepEqual(historyOf.filter((key) => VM.isIndexKey(key)), []);
  assert.ok(historyOf.includes(`token:storage:balances:${BOB}`));
  for (let n = 1; n <= 5; n += 1) {
    const undo = vm.getBlockUndo(n);
    assert.ok(undo.length > 0);
    assert.deepEqual(undo.filter((key) => VM.isIndexKey(key)), [], `block ${n}`);
  }
  // ดัชนียังถูกเขียนครบทุกชนิด
  for (const kind of ["tx:", "sigtx:", "txto:", "event:", "eventidx:", "eventsig:", "holding:"]) assert.ok(vm.db.listKeys(kind).length > 0, kind);
  assert.ok(vm.db.listKeys(`${alice}:txn:`).length > 0);
});

test("isIndexKey: แยกดัชนีกับ state", () => {
  for (const key of ["tx:0xab", "sigtx:0xab", "txto:0xa:000000000001:0000:0000", "event:p:E:000000000001:0000:0000", "eventidx:p:E:f:t:000000000001:0000:0000",
    "eventsig:0xt:p:E", "holding:0xa:p", "0xa:txn:0:0xab", "rejtx:0xab", "rejfrom:0xa:000000000001:000000", "blockrejected:000000000001"]) assert.equal(VM.isIndexKey(key), true, key);
  for (const key of ["token:storage:balances:0xa", "0xa:nonce", "0xa:native:received", "token:code", "pending:token", "block:000000000001"]) assert.equal(VM.isIndexKey(key), false, key);
});

test("rebuildFrom: ดัชนีหลัง rebuild = ดัชนีของเชนที่สร้างถึง block นั้นตรง ๆ", () => {
  const { vm } = buildChain(5);
  const { vm: short } = buildChain(3);
  vm.rebuildFrom(3);
  assert.equal(vm.latestBlockNumber(), 3);
  // ลายเซ็นสุ่มคนละชุด → เทียบชื่อ key ของดัชนีที่ไม่ขึ้นกับ hash + ค่าของดัชนีที่เป็น state ของ explorer
  const shape = (vm) => Object.keys(indexes(vm)).map((key) => key.replace(/0x[0-9a-f]{64}/g, "<hash>")).sort();
  assert.deepEqual(shape(vm), shape(short));
  assert.equal(vm.db.listKeys("tx:").length, 4);       // block 1 มี 2 ใบ + block 2, 3
  assert.equal(vm.db.listKeys("event:").length, 2);
  assert.equal(vm.listTransactionsOf(alice).length, 3);
  assert.deepEqual(vm.listHoldings(BOB).map((h) => h.lastBlock), [3]);
});

test("rebuildFrom(0): ดัชนีหายหมด · state กลับไปเป็น genesis", () => {
  const { vm } = buildChain(4);
  vm.rebuildFrom(0);
  assert.deepEqual(indexes(vm), {});
  assert.equal(vm.latestBlockNumber(), null);
  assert.equal(vm.db.readKeys([`${alice}:native:received`])[0], "1000000n");
});

test("txn ไม่เก็บ signature / digest ซ้ำ แต่ยังอ่านได้ครบ (tx page · wallet list · /evm)", () => {
  const { vm, signatures } = buildChain(3);
  const [{ hash, signature, digest }] = signatures;
  const raw = vm.db.listEntries(`${alice}:txn:`).map((entry) => entry.value);
  assert.ok(raw.every((record) => !("signature" in record) && !("digest" in record)));

  const found = vm.getTransaction(hash, { signature: true });
  assert.equal(found.record.signature, signature);
  assert.equal(found.record.digest, digest);
  assert.equal(sign.recoverSigner({ chainId: 1, action: "call", from: alice, to: "token", method: "transfer", input: { to: BOB, amount: "10n" }, value: 0, nonce: 1, gasLimit: 0, gasPrice: 0 }, found.record.signature), alice);
  assert.equal(vm.getTransaction(hash).record.signature, undefined);   // ไม่ขอ → ไม่อ่าน blockbody
  assert.deepEqual(vm.getTransaction(digest, { signature: true }), found);   // ค้นจาก digest ได้เหมือนเดิม

  // wallet list: digest เติมจากดัชนี tx
  assert.equal(vm.listTransactionsOf(alice).find((r) => r.hash === hash).digest, digest);
  assert.equal(pageTransactionsOf(vm, alice, { page: 1, limit: 20 }).items.find((r) => r.hash === hash).digest, digest);

  // /evm: v r s มาจากลายเซ็นใน blockbody
  const rpc = createEvmRpc({ vm });
  const tx = rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }).result;
  const hex = signature.slice(2);
  assert.equal(tx.r, `0x${hex.slice(0, 64)}`);
  assert.equal(tx.s, `0x${hex.slice(64, 128)}`);
});

test("txto ไม่เก็บ blockNumber / index / timestamp แต่ API ได้ field ครบ", () => {
  const { vm, signatures } = buildChain(3);
  const raw = vm.db.listEntries("txto:token:").map((entry) => entry.value);
  assert.ok(raw.length > 0);
  assert.ok(raw.every((value) => !("blockNumber" in value) && !("index" in value) && !("timestamp" in value)));

  const [latest] = vm.listTransactionsTo("token", { limit: 1 });
  assert.deepEqual(latest, { hash: signatures[1].hash, action: "call", status: "success", from: alice, method: "transfer", value: 0, blockNumber: 3, index: 0, timestamp: T + 3000 });
  assert.deepEqual(pageTransactionsTo(vm, "token", { page: 1, limit: 20 }).items[0], latest);
  assert.deepEqual(cursorTransactionsTo(vm, "token", { limit: 1 }).items[0], latest);
  assert.deepEqual(vm.listTransactionsTo("token").map((t) => [t.blockNumber, t.timestamp]), [[3, T + 3000], [2, T + 2000], [1, T], [1, T]]);
});

test("replayBlock / stateAt / snapshotAt ยังได้ผลเดิม", () => {
  const { vm } = buildChain(4);
  for (let n = 1; n <= 4; n += 1) assert.equal(vm.replayBlock(n).hash, vm.getBlock(n).hash);
  assert.equal(vm.stateAt(2, `token:storage:balances:${BOB}`), "10n");
  assert.equal(vm.stateAt(1, `token:storage:balances:${BOB}`), undefined);
  assert.deepEqual(vm.snapshotAt(3, "token:storage:"), { [`token:storage:balances:${alice}`]: "980n", [`token:storage:balances:${BOB}`]: "20n" });
  assert.deepEqual(Object.keys(vm.snapshotAt(2)).filter((key) => VM.isIndexKey(key)), []);   // ดัชนีไม่ใช่ state ณ block
});
