import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import * as sign from "../src/crypto/signature.js";

/*
 * mempool + ลายเซ็นกับค่าแก๊สแบบ EIP-1559
 *   เรียงตาม tip ที่ผู้ผลิตได้จริง = min(priority, maxFee - baseFee) · maxFee < baseFee → ยังไม่หยิบ (รอในคิว)
 *   แทนที่ใบเดิมต้องเพิ่มทั้ง maxFee และ priority ≥ 10% (แบบ geth) · tx ที่เซ็นแบบเดิม (gasPrice) ใช้ได้เหมือนเดิม
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const KEYS = [sign.randomPrivateKey(), sign.randomPrivateKey(), sign.randomPrivateKey()];
const [alice, bob, carol] = KEYS.map(sign.addressOf);
const MIN = 1000n;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, gas: { price: MIN }, maxBlockGas: 10_000, ...options,
  });
  vm.db.load(Object.fromEntries([alice, bob, carol].map((address) => [`${address}:native:received`, "1000000000000n"])));
  return vm;
}
const transferTx = (from, nonce, fees = {}) => ({ chainId: 1, action: "transfer", from, to: from, value: 0, nonce, gasLimit: 0, ...fees });
const signed = (tx, key) => ({ tx, signature: sign.signTransaction(tx, key) });
const keyOf = (address) => KEYS[[alice, bob, carol].indexOf(address)];
const add = (pool, from, nonce, fees, now = T) => pool.add(signed(transferTx(from, nonce, fees), keyOf(from)), { now });
let clock = T;
function mine(vm, pool) {
  clock += 1000;
  const block = vm.createBlock({ timestamp: clock, feeRecipient: "0x00000000000000000000000000000000000000aa" });
  const included = pool.take(block);
  block.commit();
  return { block, included, header: vm.getBlock(block.number) };
}

test("ลายเซ็น: tx แบบ 1559 ใช้ชนิด Transaction ที่มี maxFeePerGas / maxPriorityFeePerGas · แบบเดิมได้ digest เดิม", () => {
  const legacy = transferTx(alice, 0, { gasPrice: 5 });
  const typed = transferTx(alice, 0, { maxFeePerGas: "2000", maxPriorityFeePerGas: "3" });
  const legacyData = sign.buildTypedData(legacy);
  const typedData = sign.buildTypedData(typed);
  assert.deepEqual(legacyData.types.Transaction.map((f) => f.name).slice(-2), ["gasLimit", "gasPrice"]);
  assert.deepEqual(typedData.types.Transaction.map((f) => f.name).slice(-3), ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"]);
  assert.equal(typedData.message.gasPrice, undefined);
  assert.notEqual(sign.hashTypedData(legacy), sign.hashTypedData(typed));
  // digest แบบเดิมคำนวณจากชนิดเดิมทุกไบต์ (เทียบกับการคำนวณด้วยมือผ่าน TRANSACTION_TYPE)
  assert.equal(sign.TRANSACTION_TYPE.at(-1).name, "gasPrice");

  const verified = sign.verifyTransaction(signed(typed, KEYS[0]));
  assert.equal(verified.sender, alice);
  assert.deepEqual([verified.request.maxFeePerGas, verified.request.maxPriorityFeePerGas, verified.request.gasPrice], ["2000", "3", undefined]);
  // ลายเซ็นผูกกับค่าแก๊ส: แก้ priority หลังเซ็น → ผู้เซ็นเปลี่ยน
  assert.throws(() => sign.verifyTransaction({ tx: { ...typed, maxPriorityFeePerGas: "300" }, signature: signed(typed, KEYS[0]).signature }), /ลายเซ็นไม่ตรงกับ from/);
  assert.throws(() => sign.verifyTransaction(signed({ ...typed, gasPrice: 7 }, KEYS[0])), /gasPrice คู่กับ maxFeePerGas/);
  // maxFeePerGas 0 = ไม่ระบุ (VM ใช้ baseFee + priority)
  assert.equal(sign.verifyTransaction(signed(transferTx(alice, 0, { maxPriorityFeePerGas: "5" }), KEYS[0])).request.maxFeePerGas, undefined);
});

test("mempool: เรียงตาม tip จริงของ block (ไม่ใช่ maxFee) · maxFee < baseFee ไม่ถูกหยิบแต่ยังรอในคิว", () => {
  const vm = setup({ minBaseFee: 1000n });
  const pool = new Mempool(vm);
  // base fee 1000: alice tip = min(50, 5000-1000) = 50 · bob tip = min(900, 1100-1000) = 100 · carol แบบเดิม 1080 → tip 80
  add(pool, alice, 0, { maxFeePerGas: "5000", maxPriorityFeePerGas: "50" });
  add(pool, bob, 0, { maxFeePerGas: "1100", maxPriorityFeePerGas: "900" });
  add(pool, carol, 0, { gasPrice: "1080" });
  const { block, included } = mine(vm, pool);
  assert.equal(block.baseFee, 1000n);
  const order = block.results().map((r) => r.gasPrice);
  assert.deepEqual(order, ["1100n", "1080n", "1050n"]);   // bob (tip 100) → carol (80) → alice (50)
  assert.equal(included.length, 3);

  assert.deepEqual(VM.sortPendingTransactions([
    { request: { from: "a", nonce: 0, maxFeePerGas: "5000", maxPriorityFeePerGas: "50" } },
    { request: { from: "b", nonce: 0, maxFeePerGas: "1100", maxPriorityFeePerGas: "900" } },
  ], { baseFee: 1000n }).map((item) => item.request.from), ["b", "a"]);
  assert.equal(VM.effectiveTip({ maxFeePerGas: "900" }, 1000n), null);
  assert.equal(VM.effectiveTip({ gasPrice: "1300" }, 1000n), 300n);
});

test("mempool: รับใบ maxFee ต่ำ (ไม่มี simulate) → block ที่ base fee สูงข้ามไป · base fee ลงแล้วได้เข้า", () => {
  const vm = setup({ gasTarget: 1000, maxBlockGas: 50_000 });
  const pool = new Mempool(vm, { rateLimit: 1000 });
  for (let n = 0; n < 4; n += 1) add(pool, alice, n, {});
  mine(vm, pool);
  const raised = vm.currentBaseFee();
  const waiting = add(pool, bob, 0, { maxFeePerGas: String(MIN + 100n), maxPriorityFeePerGas: "1" }, clock);
  assert.ok(waiting.ok);
  assert.ok(raised > MIN + 100n);
  const skipped = mine(vm, pool);
  assert.equal(skipped.included.length, 0);
  assert.equal(pool.has(waiting.hash), true);           // ยังรออยู่ ไม่ถูกบันทึกว่าถูกปฏิเสธ
  assert.equal(skipped.header.rejectedCount, undefined);
  let rounds = 0;
  while (pool.has(waiting.hash) && rounds < 20) { mine(vm, pool); rounds += 1; }   // block ว่าง → base fee ลง 12.5% ต่อ block
  assert.equal(pool.has(waiting.hash), false);
  assert.equal(vm.getTransaction(vm.getBlock(vm.latestBlockNumber()).txHashes[0]).from, bob);
});

test("แทนที่: ต้องเพิ่มทั้ง maxFee และ priority ≥ 10% · แบบเดิม → แบบ 1559 ก็ได้", () => {
  const pool = new Mempool(setup());
  const old = add(pool, alice, 0, { maxFeePerGas: "2000", maxPriorityFeePerGas: "100" });
  assert.ok(old.ok);
  const onlyMax = add(pool, alice, 0, { maxFeePerGas: "3000", maxPriorityFeePerGas: "105" });
  assert.equal(onlyMax.ok, false);
  assert.match(onlyMax.reason, /maxFeePerGas ≥ 2200 และ maxPriorityFeePerGas ≥ 110/);
  assert.deepEqual([onlyMax.minimumMaxFeePerGas, onlyMax.minimumMaxPriorityFeePerGas], ["2200", "110"]);
  const onlyTip = add(pool, alice, 0, { maxFeePerGas: "2100", maxPriorityFeePerGas: "500" });
  assert.equal(onlyTip.ok, false);
  const both = add(pool, alice, 0, { maxFeePerGas: "2200", maxPriorityFeePerGas: "110" });
  assert.deepEqual([both.ok, both.replaced], [true, old.hash]);

  // แบบเดิม gasPrice 1000 = maxFee 1000 / priority 1000 → ใบใหม่ต้อง ≥ 1100 ทั้งคู่
  const legacy = add(pool, bob, 0, { gasPrice: "1000" });
  assert.equal(add(pool, bob, 0, { maxFeePerGas: "5000", maxPriorityFeePerGas: "1099" }).ok, false);
  const upgraded = add(pool, bob, 0, { maxFeePerGas: "1100", maxPriorityFeePerGas: "1100" });
  assert.deepEqual([upgraded.ok, upgraded.replaced], [true, legacy.hash]);
  assert.deepEqual(pool.minimumReplacementFees({ gasPrice: "1000" }), { maxFee: 1100n, priority: 1100n });
  // /pending แสดงค่าแก๊สแบบ 1559
  const listed = pool.list().find((item) => item.hash === upgraded.hash);
  assert.deepEqual([listed.maxFeePerGas, listed.maxPriorityFeePerGas], ["1100", "1100"]);
});

test("แทนที่แบบเดิม (gasPrice ทั้งสองใบ): ข้อความเดิม · ใบที่เข้า block จ่ายตามราคาใหม่", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  add(pool, carol, 0, { gasPrice: "1000" });
  const low = add(pool, carol, 0, { gasPrice: "1099" });
  assert.equal(low.reason, "ราคาแก๊สต่ำเกินไปสำหรับการแทนที่ (ต้องอย่างน้อย 1100)");
  assert.ok(add(pool, carol, 0, { gasPrice: "1100" }).ok);
  const { block } = mine(vm, pool);
  assert.equal(block.results()[0].gasPrice, "1100n");
  assert.equal(block.results()[0].producerFee, `${(1100 - 1000) * block.results()[0].gasUsed}n`);
});
