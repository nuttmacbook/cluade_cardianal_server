import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN } from "./programs.js";

/* คิวฝั่ง server: กัน tx ซ้ำ, rate limit, TTL, โควตาต่อ address, เรียงตามราคา */

const T = Date.parse("2024-06-01T10:00:00Z");
const ALICE_KEY = sign.randomPrivateKey();
const BOB_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);
const bob = sign.addressOf(BOB_KEY);

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, ...options,
  });
  vm.db.load({ [`${alice}:native:received`]: 1_000_000, [`${bob}:native:received`]: 1_000_000 });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: { sender: alice, origin: alice }, initInput: { supply: 10_000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  return vm;
}

const makeTx = (from, nonce, { gasPrice = 1, amount = 1 } = {}) =>
  ({ chainId: 1, action: "call", from, to: "token", method: "transfer", input: { to: "0xcarol", amount }, value: 0, nonce, gasLimit: 0, gasPrice });

const signed = (from, key, nonce, options) => {
  const tx = makeTx(from, nonce, options);
  return { tx, signature: sign.signTransaction(tx, key) };
};

// ---------------------------------------------------------------------------

test("add: ลายเซ็นถูกต้อง → เข้าคิว, ลายเซ็นผิด → ปฏิเสธ", () => {
  const pool = new Mempool(setup());
  assert.deepEqual(pool.add(signed(alice, ALICE_KEY, 0)).ok, true);
  assert.equal(pool.size, 1);

  const forged = { ...signed(alice, ALICE_KEY, 1), signature: sign.signTransaction(makeTx(alice, 1), BOB_KEY) };
  const res = pool.add(forged);
  assert.equal(res.ok, false);
  assert.match(res.reason, /ลายเซ็นไม่ตรงกับ from/);
});

test("add: ส่ง nonce ต่อกันหลายใบได้ แต่ข้ามเลขไม่ได้", () => {
  const pool = new Mempool(setup());
  for (const nonce of [0, 1, 2]) assert.equal(pool.add(signed(alice, ALICE_KEY, nonce)).ok, true);

  const skipped = pool.add(signed(alice, ALICE_KEY, 5));
  assert.equal(skipped.ok, false);
  assert.deepEqual([skipped.reason, skipped.expectedNonce], ["nonce ต้องเป็น 3", 3]);
  assert.equal(pool.nextNonce(alice), 3);
});

test("add: tx เดิมส่งซ้ำ → ปฏิเสธ แม้จะเข้า block ไปแล้ว", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  const item = signed(alice, ALICE_KEY, 0);
  assert.equal(pool.add(item).ok, true);
  assert.equal(pool.add(item).reason, "tx นี้ถูกส่งมาแล้ว");

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  pool.take(block);
  block.commit();
  assert.equal(pool.size, 0);
  assert.equal(pool.add(item).reason, "tx นี้ถูกส่งมาแล้ว");   // กันยิงซ้ำหลัง commit
});

test("โควตา: address เดียวค้างในคิวได้ไม่เกิน maxPerSender", () => {
  const pool = new Mempool(setup(), { maxPerSender: 3 });
  for (const nonce of [0, 1, 2]) assert.equal(pool.add(signed(alice, ALICE_KEY, nonce)).ok, true);
  assert.equal(pool.add(signed(alice, ALICE_KEY, 3)).reason, "คิวของ address นี้เต็ม");
  assert.equal(pool.add(signed(bob, BOB_KEY, 0)).ok, true);   // คนอื่นยังส่งได้
});

test("โควตา: คิวทั้งหมดเต็ม", () => {
  const pool = new Mempool(setup(), { maxSize: 2 });
  assert.equal(pool.add(signed(alice, ALICE_KEY, 0)).ok, true);
  assert.equal(pool.add(signed(bob, BOB_KEY, 0)).ok, true);
  assert.equal(pool.add(signed(alice, ALICE_KEY, 1)).reason, "คิวเต็ม");
});

test("rate limit: ส่งถี่เกินกำหนดถูกปฏิเสธ แล้วกลับมาส่งได้เมื่อพ้นช่วงเวลา", () => {
  const pool = new Mempool(setup(), { rateLimit: 2, rateWindowMs: 1000, maxPerSender: 16 });
  const now = T;
  assert.equal(pool.add(signed(alice, ALICE_KEY, 0), { now }).ok, true);
  assert.equal(pool.add(signed(alice, ALICE_KEY, 1), { now }).ok, true);
  assert.equal(pool.add(signed(alice, ALICE_KEY, 2), { now }).reason, "ส่งถี่เกินกำหนด");

  assert.equal(pool.add(signed(alice, ALICE_KEY, 2), { now: now + 1500 }).ok, true); // พ้นช่วงแล้ว
  assert.equal(pool.add(signed(bob, BOB_KEY, 0), { now }).ok, true);                  // นับแยกตาม address
});

test("TTL: ใบที่ค้างเกินเวลาถูกทิ้ง", () => {
  const pool = new Mempool(setup(), { ttlMs: 60_000 });
  pool.add(signed(alice, ALICE_KEY, 0), { now: T });
  pool.add(signed(bob, BOB_KEY, 0), { now: T + 50_000 });

  const dropped = pool.prune({ now: T + 70_000 });
  assert.equal(dropped.length, 1);
  assert.deepEqual(pool.list().map((item) => item.sender), [bob]);
});

test("take: เรียงตาม gasPrice และ nonce แล้วใส่เข้า block", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  pool.add(signed(alice, ALICE_KEY, 0, { gasPrice: 1 }));
  pool.add(signed(alice, ALICE_KEY, 1, { gasPrice: 1 }));
  pool.add(signed(bob, BOB_KEY, 0, { gasPrice: 50 }));

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  const included = pool.take(block);
  block.commit();

  assert.equal(included.length, 3);
  assert.equal(pool.size, 0);
  assert.deepEqual(
    vm.getBlock(1).txHashes.map((hash) => (vm.getTransaction(hash).from === bob ? "bob" : "alice")),
    ["bob", "alice", "alice"],
  );
});

test("take: ใบที่ block รับไม่ไหวค้างไว้ในคิวต่อ", () => {
  const vm = setup({ maxTransactionsPerSender: 1 });   // block รับของ alice ได้ใบเดียว
  const pool = new Mempool(vm);
  pool.add(signed(alice, ALICE_KEY, 0));
  pool.add(signed(alice, ALICE_KEY, 1));

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  assert.equal(pool.take(block).length, 1);
  block.commit();
  assert.equal(pool.size, 1);                          // ใบที่เหลือรอ block ถัดไป

  const next = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  assert.equal(pool.take(next).length, 1);
  next.commit();
  assert.equal(pool.size, 0);
});


test("take: จำกัดจำนวนใบต่อ block ได้", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  for (const nonce of [0, 1, 2]) pool.add(signed(alice, ALICE_KEY, nonce));

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  assert.equal(pool.take(block, { limit: 2 }).length, 2);
  assert.equal(pool.size, 1);
});

test("nextNonce: บอก nonce ถัดไปที่ควรใช้ (นับใบในคิวด้วย)", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  assert.equal(pool.nextNonce(alice), 0);
  pool.add(signed(alice, ALICE_KEY, 0));
  pool.add(signed(alice, ALICE_KEY, 1));
  assert.equal(pool.nextNonce(alice), 2);

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  pool.take(block);
  block.commit();
  assert.equal(pool.nextNonce(alice), 2);        // หลังเข้า block แล้วนับจาก DB
});
