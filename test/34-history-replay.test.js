import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN, COUNTER } from "./programs.js";

/*
 * history:<key>:<block> + blockundo:<block>
 *   - stateAt      ค่าของ key ณ block ใดก็ได้ (seek ครั้งเดียว)
 *   - replayBlock  receipt เต็มของ block เก่า โดยไม่แตะ DB จริง
 *   - rebuildFrom  กู้ระบบด้วยการรัน block ใหม่จาก body
 *   - sigtx        ค้น tx จาก hash ที่ผู้ใช้เซ็นได้ด้วย
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const OPTIONS = {
  requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true,
  gas: { call: 100, read: 10, write: 50, byte: 1, price: 1 },
};

/** เชน 5 block: deploy+init แล้วโอน token ทีละ block */
function buildChain(vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS)) {
  vm.db.load({ "alice:native:received": 1_000_000 });

  const first = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  first.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 });
  first.init({ programUuid: "token" });
  first.commit();

  for (let i = 0; i < 4; i += 1) {
    const block = vm.createBlock({ timestamp: T + (i + 1) * 1000, feeRecipient: "miner" });
    block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 10 }, context: user("alice"), nonce: i + 1 });
    block.commit();
  }
  return vm;
}

const BALANCE = "token:storage:balances:alice";

// ---------------------------------------------------------------------------
//  เก็บ history
// ---------------------------------------------------------------------------

test("history: เก็บค่าก่อนเปลี่ยนของทุก key ที่ block แตะ", () => {
  const vm = buildChain();
  const undo = vm.getBlockUndo(3);

  assert.ok(undo.includes(BALANCE));
  assert.ok(undo.includes("alice:nonce"));
  assert.equal(undo.some((key) => key.startsWith("block:")), false); // ข้อมูลของ chain เองไม่ต้องเก็บ
  assert.deepEqual(vm.db.readKeys([`history:${BALANCE}:000000000003`])[0], { existed: true, before: 990 });
  assert.deepEqual(vm.db.readKeys(["history:alice:nonce:000000000001"])[0], { existed: false }); // เพิ่งสร้างใน block 1
});

test("history: ปิด recordHistory → ไม่มี key เหล่านี้", () => {
  const vm = buildChain(new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, recordHistory: false }));
  assert.equal(vm.getBlockUndo(1), null);
  assert.deepEqual(vm.db.listKeys("history:"), []);
});

// ---------------------------------------------------------------------------
//  stateAt
// ---------------------------------------------------------------------------

test("stateAt: ค่าของ key ย้อนหลังทุก block", () => {
  const vm = buildChain();
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => vm.stateAt(n, BALANCE)), [undefined, 1000, 990, 980, 970, 960]);
  assert.equal(vm.db.readKeys([BALANCE])[0], 960);
});

test("stateAt: key ที่เพิ่งสร้าง / ถูกลบ / ไม่เคยถูกแตะ", () => {
  const vm = buildChain();
  assert.equal(vm.stateAt(0, "alice:nonce"), undefined);   // ยังไม่มีใน block 0
  assert.equal(vm.stateAt(1, "alice:nonce"), 1);
  assert.equal(vm.stateAt(5, "alice:nonce"), 5);

  assert.equal(vm.stateAt(2, "ไม่มีใครแตะ"), undefined);
  vm.db.load({ "ของนอกเชน": 7 });
  assert.equal(vm.stateAt(2, "ของนอกเชน"), 7);            // ไม่อยู่ใน history → ค่าปัจจุบัน

  // key ที่ถูกลบ: pending ถูกลบตอน init (block 1)
  assert.deepEqual(vm.stateAt(0, "pending:token"), undefined);
  assert.equal(vm.stateAt(1, "pending:token"), undefined);
});

test("stateAt: prefix ของ key ไม่ชนกัน", () => {
  const vm = buildChain();
  assert.equal(vm.stateAt(2, "alice"), undefined);           // ไม่ใช่ alice:nonce
  assert.equal(vm.stateAt(2, "alice:nonce"), 2);
});

test("stateAt: ต้นทุนคงที่ — อ่าน DB จำนวนครั้งเท่ากันไม่ว่าย้อนไกลแค่ไหน", () => {
  const vm = buildChain();
  for (let i = 0; i < 30; i += 1) {   // ต่อเชนให้ยาวขึ้นอีก 30 block
    const block = vm.createBlock({ timestamp: T + 100_000 + i * 1000, feeRecipient: "miner" });
    block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice"), nonce: 5 + i });
    block.commit();
  }

  const counted = { reads: 0 };
  const original = vm.db.readKeys.bind(vm.db);
  vm.db.readKeys = (keys) => { counted.reads += keys.length; return original(keys); };

  counted.reads = 0;
  vm.stateAt(34, BALANCE);
  const near = counted.reads;
  counted.reads = 0;
  vm.stateAt(1, BALANCE);
  const far = counted.reads;

  vm.db.readKeys = original;
  assert.equal(near, far, "ย้อนใกล้กับย้อนไกลต้องอ่านเท่ากัน");
  assert.ok(far <= 3, `อ่าน ${far} ครั้ง`);
});

test("snapshotAt: ดูข้อมูลของโปรแกรม ณ block เก่า", () => {
  const vm = buildChain();
  assert.deepEqual(vm.snapshotAt(2, "token:storage:"), {
    "token:storage:balances:alice": 990,
    "token:storage:balances:bob": 10,
    "token:storage:owner": "alice",
    "token:storage:totalSupply": 1000,
  });
  assert.deepEqual(vm.snapshotAt(0, "token:storage:"), {});
});

// ---------------------------------------------------------------------------
//  replayBlock
// ---------------------------------------------------------------------------

test("replayBlock: ได้ receipt เต็มของ block เก่า และ DB จริงไม่เปลี่ยน", () => {
  const vm = buildChain();
  const before = vm.db.snapshot();
  const receipt = vm.replayBlock(2);

  assert.equal(receipt.number, 2);
  assert.equal(receipt.hash, vm.getBlock(2).hash);
  assert.equal(receipt.txCount, 1);
  assert.deepEqual(receipt.transactions[0].stateChanges, [
    { program: "token", key: ["balances", "alice"], after: 990 },
    { program: "token", key: ["balances", "bob"], after: 10 },
  ]);
  assert.deepEqual(receipt.transactions[0].trace[0].method, "transfer");
  assert.deepEqual(receipt.transactions[0].result, { from: "alice", to: "bob", amount: 10 });
  assert.deepEqual(vm.db.snapshot(), before);
});

test("replayBlock: block แรกที่มี deploy + init ก็ย้อนดูได้", () => {
  const vm = buildChain();
  const receipt = vm.replayBlock(1);
  assert.deepEqual(receipt.transactions.map((tx) => tx.action), ["deploy", "init"]);
  assert.equal(receipt.transactions[0].input, null);
  assert.equal(receipt.hash, vm.getBlock(1).hash);
});

test("replayBlock: ทุก block ในเชนย้อนดูได้และ hash ตรงหมด", () => {
  const vm = buildChain();
  for (let number = 1; number <= vm.latestBlockNumber(); number += 1) {
    assert.equal(vm.replayBlock(number).hash, vm.getBlock(number).hash, `block ${number}`);
  }
});

test("replayBlock: ข้อมูลเสียหาย → ตรวจจับได้", () => {
  const vm = buildChain();
  vm.db.writeKeys([{ type: "put", dbKey: `history:${BALANCE}:000000000003`, value: { existed: true, before: 9999 } }]);
  assert.throws(() => vm.replayBlock(3), { code: "INTERNAL", message: /hash ไม่ตรง/ });
  assert.equal(vm.replayBlock(3, { verify: false }).number, 3); // ปิดการตรวจเพื่อดูว่าเพี้ยนตรงไหนได้
});

test("replayBlock: block ที่ไม่มี → NOT_FOUND", () => {
  const vm = buildChain();
  assert.throws(() => vm.replayBlock(99), { code: "NOT_FOUND" });
});

// ---------------------------------------------------------------------------
//  rebuildFrom
// ---------------------------------------------------------------------------

test("rebuildFrom: ย้อนทั้งระบบไป block 2 แล้ว state ตรงกับตอนนั้นเป๊ะ", () => {
  const vm = buildChain();
  const stateKeys = (snapshot) => Object.fromEntries(Object.entries(snapshot).filter(([key]) => !/^(block|blockbody|blockundo|blockhash|latestblock|history)[:$]/.test(key) && key !== "latestblock"));
  const expected = stateKeys(vm.snapshotAt(2));
  const stateRoot = vm.getBlock(2).stateRoot;

  const result = vm.rebuildFrom(2);
  assert.deepEqual({ from: result.from, to: result.to, blocks: result.blocks }, { from: 5, to: 2, blocks: 2 });
  assert.equal(result.stateRoot, stateRoot);

  assert.equal(vm.latestBlockNumber(), 2);
  assert.equal(vm.db.readKeys([BALANCE])[0], 990);
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], 2);
  assert.equal(vm.getBlock(3), null);
  assert.equal(vm.getBlockBody(3), null);
  assert.deepEqual(vm.db.listKeys("history:").filter((key) => key.endsWith("000000000004")), []);
  assert.deepEqual(stateKeys(vm.db.snapshot()), expected);
});

test("rebuildFrom: ดัชนีของ explorer ถูกย้อนด้วย", () => {
  const vm = buildChain();
  const discarded = vm.getBlock(4).txHashes[0];
  const kept = vm.getBlock(2).txHashes[0];

  vm.rebuildFrom(2);
  assert.equal(vm.getTransaction(discarded), null);         // tx ของ block ที่ทิ้งหายไป
  assert.equal(vm.getTransaction(kept).blockNumber, 2);
  assert.deepEqual(vm.listTransactionsOf("alice").map((tx) => tx.nonce), [1, 0]);
  assert.equal(vm.db.listKeys("blockhash:").length, 2);
});

test("rebuildFrom: ย้อนแล้วเดินหน้าต่อได้ และ parentHash ต่อถูกต้อง", () => {
  const vm = buildChain();
  vm.rebuildFrom(2);

  const block = vm.createBlock({ timestamp: T + 9000, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "carol", amount: 5 }, context: user("alice"), nonce: 2 });
  block.commit();

  assert.equal(vm.latestBlockNumber(), 3);
  assert.equal(vm.getBlock(3).parentHash, vm.getBlock(2).hash);
  assert.equal(vm.getBlock(3).parentStateRoot, vm.getBlock(2).stateRoot);
  assert.equal(vm.db.readKeys(["token:storage:balances:carol"])[0], 5);
});

test("rebuildFrom: ย้อนไป 0 = ล้างผลของทุก block แต่ข้อมูลนอกเชนยังอยู่", () => {
  const vm = buildChain();
  vm.db.load({ "ของนอกเชน": "ยังอยู่" });
  vm.rebuildFrom(0);

  assert.equal(vm.latestBlockNumber(), null);
  assert.equal(vm.db.readKeys([BALANCE])[0], undefined);
  assert.equal(vm.db.readKeys(["token:code"])[0], undefined);
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], undefined);
  assert.equal(vm.db.readKeys(["ของนอกเชน"])[0], "ยังอยู่");
  assert.equal(vm.nativeBalanceOf("alice").balance, 1_000_000); // genesis กลับมาเท่าเดิม
});

test("rebuildFrom: รันใหม่ไปจุดเดิมให้ผลเหมือนกันทุกครั้ง", () => {
  const first = buildChain();
  first.rebuildFrom(3);
  const second = buildChain();
  second.rebuildFrom(3);
  assert.deepEqual(first.db.snapshot(), second.db.snapshot());

  first.rebuildFrom(3); // ซ้ำอีกรอบ
  assert.deepEqual(first.db.snapshot(), second.db.snapshot());
});

test("rebuildFrom: เลข block ไม่ถูกต้อง → NOT_FOUND", () => {
  const vm = buildChain();
  for (const target of [6, -1, 1.5]) assert.throws(() => vm.rebuildFrom(target), { code: "NOT_FOUND" });
});

// ---------------------------------------------------------------------------
//  ค้น tx จาก hash ที่ผู้ใช้เซ็น
// ---------------------------------------------------------------------------

test("sigtx: ค้นได้ทั้ง hash ของระบบและ hash ที่ผู้ใช้เซ็น", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  const key = sign.randomPrivateKey();
  const alice = sign.addressOf(key);
  vm.db.load({ [`${alice}:native:received`]: 1_000_000 });

  const tx = { chainId: 1, action: "transfer", from: alice, to: "0xbob", method: "", input: {}, value: 100, nonce: 0, gasLimit: 0, gasPrice: 0 };
  const verified = sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, key) });

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block[verified.method](verified.request);
  block.commit();

  const vmHash = vm.getBlock(1).txHashes[0];
  assert.notEqual(vmHash, verified.hash);                          // คนละค่า
  assert.equal(vm.db.readKeys([`sigtx:${verified.hash}`])[0], vmHash);
  assert.deepEqual(vm.getTransaction(verified.hash), vm.getTransaction(vmHash)); // ค้นได้ทั้งสองทาง
  assert.equal(vm.getTransaction(verified.hash).digest, verified.hash);
  assert.equal(vm.listTransactionsOf(alice)[0].digest, verified.hash);
});

test("sigtx: tx ที่ไม่มีลายเซ็น → ไม่มีดัชนีนี้ และค้นด้วย hash ของระบบตามปกติ", () => {
  const vm = buildChain();
  const hash = vm.getBlock(2).txHashes[0];
  assert.equal(vm.getTransaction(hash).digest, null);
  assert.deepEqual(vm.db.listKeys("sigtx:"), []);
});

test("replayBlock: ไม่มี history ของ block ที่ใหม่กว่า → บอกตรง ๆ ว่าย้อนไม่ได้ (ไม่ใช่ hash ไม่ตรง)", () => {
  const vm = buildChain(new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, recordHistory: false }));
  assert.throws(() => vm.replayBlock(1), { code: "NOT_FOUND", message: /recordHistory/ });

  // เปิด history ทีหลัง → block เก่าที่ไม่มี undo ก็ยังย้อนไม่ได้
  vm.recordHistory = true;
  const block = vm.createBlock({ timestamp: T + 100_000, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice"), nonce: 5 });
  block.commit();
  assert.throws(() => vm.replayBlock(2), { code: "NOT_FOUND" });
  assert.equal(vm.replayBlock(vm.latestBlockNumber()).number, vm.latestBlockNumber()); // block ล่าสุดที่มี undo ครบ ย้อนได้
});
