import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN } from "./programs.js";

/* เร่งความเร็วจากผล load test: ตรวจลายเซ็นครั้งเดียว · ล้าง mempool แบบหยุดเมื่อเจอรายการที่ยังไม่หมดอายุ · จำผล block.hashes() */

const T = Date.parse("2024-06-01T10:00:00Z");
const ALICE_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, ...options });
  vm.db.load({ [`${alice}:native:received`]: "1000000n" });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: { sender: alice, origin: alice }, initInput: { supply: 10_000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  return vm;
}

const signed = (nonce, amount = 1) => {
  const tx = { chainId: 1, action: "call", from: alice, to: "token", method: "transfer", input: { to: "0xcarol", amount }, value: 0, nonce, gasLimit: 0, gasPrice: 1 };
  return { tx, signature: sign.signTransaction(tx, ALICE_KEY) };
};

test("add({ verified }): ใช้ผลตรวจลายเซ็นที่ส่งมา ไม่ recover ซ้ำ · ผลเหมือนตรวจเอง", () => {
  const item = signed(0);
  const verified = sign.verifyTransaction(item);
  const a = new Mempool(setup()).add(item, { now: T });
  const b = new Mempool(setup()).add(item, { now: T, verified });
  assert.deepEqual(b, a);
  assert.equal(b.ok, true);
  // ลายเซ็นในตัว item ไม่ถูกตรวจอีก (server ตรวจแล้ว) → ส่ง signature เสีย ๆ มาพร้อม verified ก็ยังใช้ verified
  const broken = { ...signed(0), signature: "0x00" };
  assert.equal(new Mempool(setup()).add(broken, { now: T, verified: sign.verifyTransaction(signed(0)) }).ok, true);
  assert.equal(new Mempool(setup()).add(broken, { now: T }).ok, false, "ไม่ส่ง verified → ตรวจเองเหมือนเดิม");
});

test("tx ซ้ำ: กันภายใน ttl × 2 จากเวลาที่เห็น แม้ยังไม่ได้ล้าง · พ้นแล้วส่งใหม่ได้", () => {
  const vm = setup();
  const pool = new Mempool(vm, { ttlMs: 1000 });
  const item = signed(0);
  assert.equal(pool.add(item, { now: T }).ok, true);
  const block = vm.createBlock({ timestamp: T + 10 });
  pool.take(block, { now: T + 10 });
  block.commit();
  assert.match(pool.add(item, { now: T + 1500 }).reason, /ถูกส่งมาแล้ว/);
  assert.match(pool.add(item, { now: T + 2000 }).reason, /ถูกส่งมาแล้ว/, "ครบ ttl × 2 พอดียังกัน");
  assert.doesNotMatch(String(pool.add(item, { now: T + 2001 }).reason ?? ""), /ถูกส่งมาแล้ว/, "พ้น ttl × 2 → ไม่ถือว่าซ้ำ (ไปติด nonce แทน)");
});

test("ใบในคิวที่หมดอายุถูกล้างตอนรับใบใหม่ (ไม่ต้องรอปิด block) และถูกบันทึกว่า expired", () => {
  const pool = new Mempool(setup(), { ttlMs: 1000 });
  assert.equal(pool.add(signed(0), { now: T }).ok, true);
  assert.equal(pool.size, 1);
  // nonce 0 หมดอายุแล้ว → ส่ง nonce 0 ใบใหม่ (ราคาเดิม) ได้เลย ไม่ถูกมองว่าเป็นการแทนที่
  const fresh = pool.add(signed(0, 2), { now: T + 1001 });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal(pool.size, 1);
  assert.ok(pool.pendingRejections().some((r) => r.stage === "expired"));
});

test("ล้างแบบเบาหยุดที่รายการแรกที่ยังไม่หมดอายุ: ใบที่เห็นแล้วทุกใบยังกันซ้ำได้", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  const items = [0, 1, 2].map((n) => signed(n));
  for (const item of items) assert.equal(pool.add(item, { now: T }).ok, true);
  const block = vm.createBlock({ timestamp: T + 1 });
  pool.take(block, { now: T + 1 });
  block.commit();
  for (const item of items) assert.match(pool.add(item, { now: T + 2 }).reason, /ถูกส่งมาแล้ว/);
});

test("block.hashes(): จำผลไว้ · เปลี่ยนเมื่อรัน tx หรือบันทึกใบที่ถูกปฏิเสธ · ตรงกับการคำนวณใหม่ตอน replay", () => {
  const vm = setup({ recordHistory: true });
  const block = vm.createBlock({ timestamp: T });
  const empty = block.hashes();
  assert.deepEqual(block.hashes(), empty, "เรียกซ้ำได้ผลเดิม");
  const first = block.hashes();
  first.hash = "แก้ค่าที่คืนไป";
  assert.equal(block.hashes().hash, empty.hash, "ผลที่คืนเป็น copy");

  const { tx, signature } = signed(0);
  const verified = sign.verifyTransaction({ tx, signature });
  block[verified.method](verified.request);
  const afterTx = block.hashes();
  assert.notEqual(afterTx.hash, empty.hash);
  assert.notEqual(afterTx.stateRoot, empty.stateRoot);

  block.recordRejected({ hash: `0x${"ab".repeat(32)}`, sender: alice, stage: "sendtx", reason: "ทดสอบ" });
  const afterReject = block.hashes();
  assert.notEqual(afterReject.hash, afterTx.hash);
  assert.ok(afterReject.rejectedRoot);

  const header = block.header();
  assert.equal(header.hash, afterReject.hash);
  block.commit();
  assert.equal(vm.getBlock(header.number).hash, header.hash);
  assert.equal(vm.replayBlock(header.number, { verify: true }).hash, header.hash, "replay คำนวณ root ใหม่ได้ค่าเดียวกัน");
});
