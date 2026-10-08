import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN } from "./programs.js";

/*
 * ความถูกต้องของสาย block และการกัน tx ซ้ำ
 *   - VM ต่อ block ให้เอง (number / parentHash / parentStateRoot)
 *   - commit เลขซ้ำไม่ได้, timestamp ถอยหลังไม่ได้
 *   - tx ที่ nonce ผิด ไม่เข้า block และไม่ทับดัชนี tx ที่สำเร็จ
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const OPTIONS = { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, gas: { call: 100, read: 10, write: 50, byte: 1, price: 1 } };

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  vm.db.load({ "alice:native:received": 1_000_000 });
  const first = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  first.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 });
  first.init({ programUuid: "token" });
  first.commit();
  return vm;
}

const transfer = (nonce, amount = 10) => ({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount }, context: user("alice"), nonce });

// ---------------------------------------------------------------------------
//  สาย block
// ---------------------------------------------------------------------------

test("chain: block ที่สร้างต่อกันมี parentHash / parentStateRoot ครบ ไม่เป็น null อีก", () => {
  const vm = setup();
  const second = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  second.call(transfer(1));
  const header = second.header();
  second.commit();

  assert.equal(header.number, 2);
  assert.equal(header.parentHash, vm.getBlock(1).hash);
  assert.equal(header.parentStateRoot, vm.getBlock(1).stateRoot);

  // ตรวจสายทั้งเส้น
  let previous = null;
  for (let number = 1; number <= vm.latestBlockNumber(); number += 1) {
    const block = vm.getBlock(number);
    assert.equal(block.parentHash, previous?.hash ?? null);
    assert.equal(block.parentStateRoot, previous?.stateRoot ?? null);
    assert.ok(block.timestamp > (previous?.timestamp ?? -1));
    previous = block;
  }
});

test("chain: blockhash ไม่ค้าง เพราะ commit เลขเดิมซ้ำไม่ได้", () => {
  const vm = setup();
  const second = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  second.call(transfer(1));
  second.commit();
  assert.throws(() => second.commit(), { code: "INVALID_REQUEST" });

  const hashKeys = vm.db.listKeys("blockhash:");
  assert.equal(hashKeys.length, vm.latestBlockNumber()); // 1 hash ต่อ 1 block เท่านั้น
  assert.deepEqual(hashKeys.map((key) => vm.db.readKeys([key])[0]).sort(), [1, 2]);
});

// ---------------------------------------------------------------------------
//  tx ซ้ำ
// ---------------------------------------------------------------------------

test("nonce ผิด: ไม่เข้า block เลย — ไม่มี txHashes / body / ดัชนี และไม่ทับ tx ที่สำเร็จ", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  const ok = block.call(transfer(1));
  const hash = vm.hashTransaction(transfer(1), { action: "call" });

  const duplicates = [1, 2, 3].map(() => block.call(transfer(1))); // ส่งซ้ำ nonce เดิม
  assert.ok(duplicates.every((res) => res.status === "throw" && res.accepted === false));
  assert.ok(duplicates.every((res) => res.writes.length === 0));

  assert.equal(block.results().length, 1);       // มีแค่ใบที่ถูกรับ
  assert.equal(block.rejected().length, 3);      // ใบที่ถูกปฏิเสธแยกไว้ให้ดู
  const header = block.header();
  assert.deepEqual(header.txHashes, [hash]);
  assert.deepEqual([header.txCount, header.successCount, header.failedCount], [1, 1, 0]);
  block.commit();

  assert.equal(vm.getBlockBody(2).length, 1);
  assert.equal(vm.getTransaction(hash).status, "success"); // ไม่ถูกทับด้วยใบที่ล้ม
  assert.equal(vm.getTransaction(hash).blockNumber, 2);
  assert.equal(ok.status, "success");
});

test("nonce ผิด: ไม่กิน nonce และไม่เสียค่าแก๊ส", () => {
  const vm = setup();
  const before = vm.nativeBalanceOf("alice");
  const res = vm.call(transfer(99), { timestamp: T + 1000 });

  assert.equal(res.accepted, false);
  assert.deepEqual(res.writes, []);
  assert.deepEqual(vm.nativeBalanceOf("alice"), before);
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], 1);
});

test("checkTransaction: กรอง tx ซ้ำทิ้งก่อนเข้า block (อ่าน DB แค่ nonce)", () => {
  const vm = setup();
  assert.deepEqual(vm.checkTransaction(transfer(1)), { ok: true, expectedNonce: 1 });
  assert.deepEqual(vm.checkTransaction(transfer(0)), { ok: false, reason: "nonce ต้องเป็น 1", expectedNonce: 1 });
  assert.deepEqual(vm.checkTransaction(transfer(5)), { ok: false, reason: "nonce ต้องเป็น 1", expectedNonce: 1 });
  assert.deepEqual(vm.checkTransaction({ from: "alice", to: "bob", amount: 1, nonce: 1 }), { ok: true, expectedNonce: 1 });
  assert.equal(vm.checkTransaction({}).ok, false);

  // ใช้กรองก่อนใส่เข้า block
  const block = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  const queue = [transfer(1), transfer(1), transfer(1)];
  for (const request of queue) {
    if (!block.checkTransaction(request).ok) continue; // นับ tx ที่อยู่ใน block แล้วด้วย
    block.call(request);
  }
  assert.equal(block.results().length, 1);
  assert.equal(block.rejected().length, 0);
});

test("tx ที่ล้มจากโปรแกรม (ยอดไม่พอ) ยังเข้า block และเสียค่าแก๊สตามเดิม", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  const res = block.call(transfer(1, 99999));

  assert.equal(res.status, "throw");
  assert.equal(res.accepted, true);   // ผ่าน nonce แล้ว จึงถือว่าเข้าระบบ
  assert.ok(res.fee > 0);
  block.commit();

  assert.equal(vm.getBlock(2).failedCount, 1);
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], 2);
  assert.equal(vm.getTransaction(vm.getBlock(2).txHashes[0]).status, "throw");
});

test("replay: block ที่ได้มามีแต่ tx ที่ถูกรับแล้ว จึงรันซ้ำได้ตรง", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  block.call(transfer(1));
  block.call(transfer(1)); // ซ้ำ ถูกทิ้ง
  block.call(transfer(2, 5));
  block.commit();

  const target = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  target.db.load({ "alice:native:received": 1_000_000 });
  for (let number = 1; number <= vm.latestBlockNumber(); number += 1) {
    const header = vm.getBlock(number);
    const replayed = target.createBlock({
      number: header.number, parentHash: header.parentHash, timestamp: header.timestamp,
      feeRecipient: header.feeRecipient, burnPercent: header.burnPercent,
    });
    for (const { method, request } of vm.getBlockBody(number)) replayed[method](request);
    assert.equal(replayed.header().hash, header.hash);
    replayed.commit();
  }
  assert.deepEqual(target.db.snapshot(), vm.db.snapshot());
});
