import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool, EXPIRED_REASON } from "../src/node/mempool.js";
import { applyBlock } from "../src/node/sync.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN, FAULTY } from "./programs.js";

/* tx ที่ถูกปฏิเสธ (ผ่านลายเซ็นแต่ไม่ได้รัน) ถูกบันทึกใน block: อยู่ใน hash ของ block · replay / rebuild / sync ต้องได้ผลเดิม · ไม่แตะ state */

const T = Date.parse("2025-03-01T00:00:00Z");
const ALICE_KEY = sign.randomPrivateKey();
const BOB_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);
const bob = sign.addressOf(BOB_KEY);
const OPTIONS = { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true };
const HASH = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const entry = (n, extra = {}) => ({ hash: HASH(n), sender: alice, nonce: n, action: "call", to: "token", gasPrice: "1", reason: `เหตุผล ${n}`, stage: "sendtx", ...extra });

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, ...options });
  // stateRoot = trie ของ state ทั้งหมด → ผู้ผลิตกับผู้อ่านต้องเริ่มจาก state เดียวกันทุกไบต์ (เวลาตอน deploy คงที่ · เขียนผ่าน commit ให้เข้า trie)
  vm.commit([{ type: "put", dbKey: `${alice}:native:received`, value: "1000000000000n" }, { type: "put", dbKey: `${bob}:native:received`, value: "1000000000000n" }]);
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: { sender: alice, origin: alice }, initInput: { supply: 10_000 } }, { timestamp: T - 2 }).writes);
  vm.commit(plain.init({ programUuid: "token" }, { timestamp: T - 1 }).writes);
  return vm;
}

const callTx = (from, nonce, gasPrice = 1, amount = 1) =>
  ({ chainId: 1, action: "call", from, to: "token", method: "transfer", input: { to: "0xcarol", amount }, value: 0, nonce, gasLimit: 0, gasPrice });
const signed = (tx, key = ALICE_KEY) => ({ tx, signature: sign.signTransaction(tx, key) });
let clock = T;
const mine = (vm, pool) => {
  clock += 1000;
  const block = vm.createBlock({ timestamp: clock, feeRecipient: "miner" });
  const included = pool.take(block);
  block.commit();
  return { header: vm.getBlock(block.number), included };
};

// ---------------------------------------------------------------------------
//  Block / header / replay
// ---------------------------------------------------------------------------

test("header: rejectedCount + rejectedRoot อยู่ใน hash ของ block · block ที่ไม่มีรายการ hash เหมือนเดิมทุกไบต์", () => {
  const build = (list) => {
    const vm = setup();
    const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
    for (const item of list) block.recordRejected(item);
    return block.header();
  };
  const plain = build([]);
  assert.equal(plain.rejectedCount, undefined);
  assert.equal(plain.rejectedRoot, undefined);
  const one = build([entry(1)]);
  const other = build([entry(1, { reason: "อื่น" })]);
  const swapped = build([entry(2), entry(1)]);
  const ordered = build([entry(1), entry(2)]);
  assert.equal(one.rejectedCount, 1);
  assert.match(one.rejectedRoot, /^0x[0-9a-f]{64}$/);
  assert.equal(new Set([plain.hash, one.hash, other.hash, swapped.hash, ordered.hash]).size, 5);   // ทุกฟิลด์และลำดับอยู่ใน hash
  assert.equal(one.stateRoot, plain.stateRoot);                                                    // ไม่แตะ state
  assert.equal(one.txCount, 0);
});

test("recordRejected: ตรวจรูปแบบ (hash 32 byte / sender / stage) · ตัดเหตุผลยาวเกิน 500 ตัว", () => {
  const block = setup().createBlock({ timestamp: T });
  assert.throws(() => block.recordRejected({ ...entry(1), hash: "0x12" }), /hash/);
  assert.throws(() => block.recordRejected({ ...entry(1), sender: "" }), /sender/);
  assert.throws(() => block.recordRejected({ ...entry(1), stage: "other" }), /stage/);
  const saved = block.recordRejected({ ...entry(1), hash: HASH(1).toUpperCase().replace("0X", "0x"), sender: alice.toUpperCase().replace("0X", "0x"), reason: "x".repeat(900), nonce: 1.5 });
  assert.deepEqual([saved.hash, saved.sender, saved.reason.length, saved.nonce], [HASH(1), alice, 500, null]);
});

test("ไม่รัน ไม่กิน nonce ไม่เสียค่าแก๊ส · ดัชนีค้นจาก hash / ผู้ส่ง · replayBlock ได้รายการเดิมและ hash ตรง", () => {
  const vm = setup();
  const nonceBefore = vm.checkTransaction({ from: alice, nonce: -1 }).expectedNonce;
  const balanceBefore = vm.nativeBalanceOf(alice).balance;
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.recordRejected(entry(1));
  block.recordRejected(entry(2, { sender: bob, stage: "expired" }));
  block.commit();
  assert.equal(vm.checkTransaction({ from: alice, nonce: -1 }).expectedNonce, nonceBefore);
  assert.equal(vm.nativeBalanceOf(alice).balance, balanceBefore);
  assert.deepEqual(vm.getBlockRejected(1).map((item) => item.hash), [HASH(1), HASH(2)]);
  assert.deepEqual({ ...vm.getRejectedTransaction(HASH(2)), timestamp: 0 },
    { ...entry(2, { sender: bob, stage: "expired", to: "token" }), code: null, blockNumber: 1, index: 1, timestamp: 0 });
  assert.deepEqual(vm.listRejectedOf(alice).map(({ value }) => value.hash), [HASH(1)]);

  const replay = vm.replayBlock(1);
  assert.equal(replay.hash, vm.getBlock(1).hash);
  assert.deepEqual(replay.rejected.map((item) => item.hash), [HASH(1), HASH(2)]);
});

test("แก้รายการที่ถูกปฏิเสธใน DB ย้อนหลัง → replayBlock ตรวจพบ (hash ไม่ตรง)", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.recordRejected(entry(1));
  block.commit();
  const [saved] = vm.getBlockRejected(1);
  vm.commit([{ type: "put", dbKey: VM.blockRejectedKey(1), value: [{ ...saved, reason: "ปลอม" }] }]);
  assert.throws(() => vm.replayBlock(1), /hash ไม่ตรง/);
  assert.equal(vm.replayBlock(1, { verify: false }).rejected[0].reason, "ปลอม");
});

test("rebuildFrom: สร้าง block ใหม่พร้อมรายการที่ถูกปฏิเสธ hash ตรง · block ที่ถูกตัดทิ้ง ดัชนีหายด้วย", () => {
  const vm = setup();
  for (let n = 1; n <= 3; n += 1) {
    const block = vm.createBlock({ timestamp: T + n * 1000 });
    block.recordRejected(entry(n));
    block.commit();
  }
  const hashes = [1, 2].map((n) => vm.getBlock(n).hash);
  vm.rebuildFrom(2);
  assert.deepEqual([1, 2].map((n) => vm.getBlock(n).hash), hashes);
  assert.equal(vm.getBlock(3), null);
  assert.equal(vm.getRejectedTransaction(HASH(2)).blockNumber, 2);
  assert.equal(vm.getRejectedTransaction(HASH(3)), null);
  assert.deepEqual(vm.getBlockRejected(3), []);
  assert.deepEqual(vm.listRejectedOf(alice).map(({ value }) => value.hash), [HASH(2), HASH(1)]);
});

test("BlockHash(n) ของ block ที่มีรายการถูกปฏิเสธ = hash ใน header (รวม rejectedRoot) · replay block ที่เรียก BlockHash ได้ hash ตรง", () => {
  const vm = setup();
  const plain = new VM.VirtualMachine(vm.db);
  const code = "function program() { function h(params) { return BlockHash(params.input.n) } return { h } }";
  vm.commit(plain.deploy({ programUuid: "hasher", code, context: { sender: alice, origin: alice } }).writes);
  vm.commit(plain.init({ programUuid: "hasher" }).writes);
  const first = vm.createBlock({ timestamp: T });
  first.recordRejected(entry(1));
  first.commit();
  const second = vm.createBlock({ timestamp: T + 1000 });
  const res = second.call({ programUuid: "hasher", functionName: "h", input: { n: "1n" }, context: { sender: alice, origin: alice }, nonce: 0 });
  assert.equal(res.result, vm.getBlock(1).hash);
  second.recordRejected(entry(2));
  second.commit();
  assert.equal(vm.replayBlock(2).hash, vm.getBlock(2).hash);
  assert.equal(vm.replayBlock(2).transactions[0].result, vm.getBlock(1).hash);
});

test("sync: ผู้อ่านใส่รายการตามที่ส่งมาแล้วเทียบ hash · ไม่ส่ง / ส่งไม่ครบ = ไม่ตรง หยุดทันที", () => {
  const source = setup();
  const block = source.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "0xcarol", amount: 1 }, context: { sender: alice, origin: alice }, nonce: 0 });
  block.recordRejected(entry(1));
  block.recordRejected(entry(2));
  block.commit();
  const item = { header: source.getBlock(1), body: source.getBlockBody(1), rejected: source.getBlockRejected(1) };

  assert.throws(() => applyBlock(setup(), { header: item.header, body: item.body }), /ไม่ตรงกับผู้ผลิต/);
  assert.throws(() => applyBlock(setup(), { ...item, rejected: item.rejected.slice(1) }), /ไม่ตรงกับผู้ผลิต/);
  const reader = setup();
  applyBlock(reader, item);
  assert.equal(reader.getBlock(1).hash, item.header.hash);
  assert.equal(reader.getRejectedTransaction(HASH(2)).index, 1);
});

// ---------------------------------------------------------------------------
//  Mempool → block
// ---------------------------------------------------------------------------

test("mempool: ปฏิเสธตอนรับเข้าคิว (nonce ผิด / simulate ไม่ผ่าน / ส่งถี่) → ลง block ถัดไปตามลำดับที่เกิด · ลายเซ็นผิด / ส่งซ้ำ ไม่ลง", () => {
  const vm = setup();
  const pool = new Mempool(vm, { rateLimit: 3 });
  const wrongNonce = pool.add(signed(callTx(alice, 5)), { now: clock });
  const failing = pool.add(signed(callTx(alice, 0, 1, 2)), { now: clock, simulate: () => ({ ok: false, error: "ยอดไม่พอ", errorCode: "PROGRAM_ERROR" }) });
  const ok = pool.add(signed(callTx(alice, 0)), { now: clock });
  assert.equal(ok.ok, true);
  const duplicate = pool.add(signed(callTx(alice, 0)), { now: clock });
  assert.equal(duplicate.reason, "tx นี้ถูกส่งมาแล้ว");
  const badSignature = pool.add({ tx: callTx(alice, 1), signature: "0x1234" }, { now: clock });
  assert.equal(badSignature.ok, false);
  pool.add(signed(callTx(alice, 1, 1, 9)), { now: clock });
  const limited = pool.add(signed(callTx(alice, 2, 1, 3)), { now: clock });
  assert.equal(limited.reason, "ส่งถี่เกินกำหนด");
  assert.deepEqual(pool.pendingRejections().map((item) => item.hash), [wrongNonce.hash, failing.hash, limited.hash]);
  assert.equal(pool.pendingRejection(failing.hash).code, "PROGRAM_ERROR");

  const { header, included } = mine(vm, pool);
  assert.equal(included.length, 2);
  assert.equal(header.rejectedCount, 3);
  const list = vm.getBlockRejected(header.number);
  assert.deepEqual(list.map((item) => [item.hash, item.stage, item.reason, item.nonce]), [
    [wrongNonce.hash, "sendtx", "nonce ต้องเป็น 0", 5],
    [failing.hash, "sendtx", "ยอดไม่พอ", 0],
    [limited.hash, "sendtx", "ส่งถี่เกินกำหนด", 2],
  ]);
  assert.deepEqual([list[0].sender, list[0].action, list[0].to, list[0].gasPrice], [alice, "call", "token", "1"]);
  assert.equal(pool.rejectedPending, 0);
  assert.equal(vm.replayBlock(header.number).hash, header.hash);
});

test("mempool: ถูกปฏิเสธแล้วส่งใบเดิมซ้ำผ่าน → ไม่บันทึกว่าถูกปฏิเสธ · ปฏิเสธซ้ำ = เหลืออันล่าสุดท้ายคิว", () => {
  const vm = setup();
  const pool = new Mempool(vm, { maxPerSender: 1 });
  pool.add(signed(callTx(alice, 0)), { now: clock });
  const full = pool.add(signed(callTx(alice, 1)), { now: clock });
  assert.equal(full.reason, "คิวของ address นี้เต็ม");
  const other = pool.add(signed(callTx(bob, 3), BOB_KEY), { now: clock });
  pool.add(signed(callTx(alice, 1)), { now: clock });                       // ปฏิเสธซ้ำ → ย้ายไปท้าย
  assert.deepEqual(pool.pendingRejections().map((item) => item.hash), [other.hash, full.hash]);
  mine(vm, pool);                                                         // nonce 0 เข้า block · รายการถูกปฏิเสธลง block
  assert.equal(pool.add(signed(callTx(alice, 1)), { now: clock }).ok, true);   // ส่งใบเดิมอีกครั้ง ผ่าน
  const again = pool.add(signed(callTx(bob, 9), BOB_KEY), { now: clock });
  pool.add(signed(callTx(alice, 1)), { now: clock });                       // ซ้ำกับใบที่รออยู่ = duplicate ไม่บันทึก
  assert.deepEqual(pool.pendingRejections().map((item) => item.hash), [again.hash]);
});

test("mempool: ปฏิเสธตอนปิด block (แก๊สของ block เต็ม) → stage block · หมดอายุในคิว → stage expired", () => {
  const vm = setup({ maxBlockGas: 1 });
  const pool = new Mempool(vm, { ttlMs: 60_000 });
  const tx = pool.add(signed(callTx(alice, 0)), { now: clock });
  const later = pool.add(signed(callTx(bob, 7), BOB_KEY), { now: clock });   // nonce ผิด → sendtx
  const { header } = mine(vm, pool);
  assert.equal(header.txCount, 0);
  const list = vm.getBlockRejected(header.number);
  assert.deepEqual(list.map((item) => [item.hash, item.stage]), [[later.hash, "sendtx"], [tx.hash, "block"]]);
  assert.equal(list[1].code, "LIMIT_EXCEEDED");
  assert.equal(pool.size, 0);

  const vm2 = setup();
  const pool2 = new Mempool(vm2, { ttlMs: 1000 });
  const stuck = pool2.add(signed(callTx(alice, 0)), { now: clock });
  pool2.add(signed(callTx(alice, 1)), { now: clock });
  clock += 5000;
  const { header: second } = mine(vm2, pool2);
  const expired = vm2.getBlockRejected(second.number);
  assert.deepEqual(expired.map((item) => [item.stage, item.reason]), [["expired", EXPIRED_REASON], ["expired", EXPIRED_REASON]]);
  assert.equal(expired[0].hash, stuck.hash);
  assert.equal(second.txCount, 0);
});

test("mempool: เกิน maxRejectedPerBlock → ที่เหลือยกไป block ถัดไปตามลำดับ · maxRejectedQueue ทิ้งอันเก่าสุด", () => {
  const vm = setup();
  const pool = new Mempool(vm, { maxRejectedPerBlock: 2, rateLimit: 1000 });
  const hashes = [];
  for (let n = 10; n < 15; n += 1) hashes.push(pool.add(signed(callTx(alice, n)), { now: clock }).hash);
  const first = mine(vm, pool).header;
  const second = mine(vm, pool).header;
  const third = mine(vm, pool).header;
  assert.deepEqual([first, second, third].map((h) => h.rejectedCount), [2, 2, 1]);
  assert.deepEqual([first, second, third].flatMap((h) => vm.getBlockRejected(h.number).map((item) => item.hash)), hashes);
  assert.equal(pool.rejectedPending, 0);

  const small = new Mempool(setup(), { maxRejectedQueue: 2, rateLimit: 1000 });
  const kept = [];
  for (let n = 10; n < 13; n += 1) kept.push(small.add(signed(callTx(alice, n)), { now: clock }).hash);
  assert.deepEqual(small.pendingRejections().map((item) => item.hash), kept.slice(1));

  const off = new Mempool(setup(), { recordRejected: false });
  off.add(signed(callTx(alice, 9)), { now: clock });
  assert.equal(off.rejectedPending, 0);
});

test("mempool: TIMEOUT ตอนปิด block → ไม่เข้า block (ไม่กิน nonce) แต่ถูกบันทึกเป็น stage block code TIMEOUT", () => {
  const vm = setup({ timeoutMs: 50 });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "faulty", code: FAULTY, context: { sender: alice, origin: alice } }).writes);
  vm.commit(plain.init({ programUuid: "faulty" }).writes);
  const pool = new Mempool(vm);
  const slow = pool.add(signed({ ...callTx(alice, 0), to: "faulty", method: "busy", input: { ms: 200 } }), { now: clock });
  assert.equal(slow.ok, true);
  const { header } = mine(vm, pool);
  assert.equal(header.txCount, 0);
  const [saved] = vm.getBlockRejected(header.number);
  assert.deepEqual([saved.hash, saved.stage, saved.code, saved.to], [slow.hash, "block", "TIMEOUT", "faulty"]);
  assert.equal(vm.checkTransaction({ from: alice, nonce: -1 }).expectedNonce, 0);
});
