import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import * as sign from "../src/crypto/signature.js";

/*
 * block 1 วิ · 1M แก๊ส: แก๊สต่อ block น้อยลง → ใบที่ใส่ไม่พอในแก๊สที่เหลือของ block เกิดบ่อยขึ้น
 *   ใบที่แก๊สเหลือไม่พอ แต่ block ว่างรับได้ → รอ block ถัดไป (เดิมถูกปฏิเสธ → ใบ nonce ถัดไปของคนเดิมค้างจนหมดอายุ)
 *   ใบที่ใหญ่เกิน block ว่าง → ยังถูกปฏิเสธเหมือนเดิม (เทสต์ 60)
 *   server: ไม่มีใบที่เข้า block ได้ (nonce ขาด) + base fee ขั้นต่ำ → ไม่ปิด block ว่างทุกวินาที · /health ไม่นับเป็น stalled
 */

const T = Date.parse("2026-02-01T00:00:00Z");
const KEYS = [sign.randomPrivateKey(), sign.randomPrivateKey(), sign.randomPrivateKey()];
const [alice, bob, carol] = KEYS.map((key) => sign.addressOf(key));
const OPTIONS = { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true };

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, ...options });
  vm.commit([alice, bob, carol].map((address) => ({ type: "put", dbKey: `${address}:native:received`, value: "1000000000000n" })));
  return vm;
}
// โอน native ไป address ใหม่ทุกใบ → แก๊สเท่ากันทุกใบ
const callTx = (from, nonce) =>
  ({ chainId: 1, action: "transfer", from, to: `0x${"c".repeat(38)}${nonce}${[alice, bob, carol].indexOf(from)}`, value: 1, nonce, gasLimit: 0, gasPrice: 10 });   // ราคาเผื่อ base fee ที่ขึ้นหลัง block เต็ม
const signed = (tx) => ({ tx, signature: sign.signTransaction(tx, KEYS[[alice, bob, carol].indexOf(tx.from)]) });
let clock = T;
const mine = (vm, pool) => {
  clock += 1000;
  const block = vm.createBlock({ timestamp: clock, feeRecipient: "miner" });
  const included = pool.take(block);
  block.commit();
  return { header: vm.getBlock(block.number), included };
};

test("แก๊สที่เหลือใน block ไม่พอ → ใบนั้นรอ block ถัดไป (ไม่ถูกปฏิเสธ) · ใบ nonce ถัดไปของคนเดิมเข้าตามลำดับ", () => {
  const probe = setup();
  const probePool = new Mempool(probe, { ttlMs: 60_000 });
  probePool.add(signed(callTx(alice, 0)), { now: clock });
  const gas = mine(probe, probePool).header.gasUsed;   // แก๊สของ transfer 1 ใบ
  assert.ok(gas > 0);
  const vm = setup({ maxBlockGas: Math.floor(gas * 2.5) });   // ใส่ได้ 2 ใบต่อ block
  const pool = new Mempool(vm, { ttlMs: 60_000 });
  const added = [callTx(alice, 0), callTx(bob, 0), callTx(carol, 0), callTx(carol, 1)].map((tx) => pool.add(signed(tx), { now: clock }));
  assert.ok(added.every((item) => item.ok), JSON.stringify(added));

  const first = mine(vm, pool);
  assert.equal(first.header.txCount, 2);
  assert.equal(vm.getBlockRejected(first.header.number).length, 0);   // ไม่มีใบไหนถูกปฏิเสธ
  assert.equal(pool.size, 2);
  const second = mine(vm, pool);
  assert.equal(second.header.txCount, 2);
  assert.equal(pool.size, 0);
  const statuses = added.map((item) => vm.getTransaction(item.hash)?.status);
  assert.deepEqual(statuses, ["success", "success", "success", "success"]);
  // ใบ nonce 1 ของ carol เข้าหลังใบ nonce 0 (block เดียวกันหรือถัดไป · ลำดับในคิวขึ้นกับ address ที่สุ่ม)
  const blockOf = (item) => vm.getTransaction(item.hash).blockNumber;
  assert.ok(blockOf(added[3]) >= blockOf(added[2]));
});

test("server: ใบที่รอติด nonce ขาด → ไม่ปิด block ว่าง · /health ไม่ขึ้น stalled ", async () => {
  const { vm, miner, mempool, mineOnce, health, minerState, STALL_MS, server } = await import("../server.js");
  clearInterval(miner);
  try {
    assert.equal(vm.maxBlockGas, 1_000_000);
    const key = sign.randomPrivateKey();
    const from = sign.addressOf(key);
    vm.db.load({ [`${from}:native:received`]: "1000000000000000000n" });
    const tx = (nonce, value = "1n") => ({ chainId: vm.chainId, action: "transfer", from, to: "0x00000000000000000000000000000000000000b0", value, nonce, gasLimit: 21_000, gasPrice: "1000000000" });
    // ใบ nonce 0 หลุดจากคิว (แบบที่เคยเกิดตอนแก๊สของ block เต็ม) → ใบ nonce 1 รอใบที่ขาด
    const first = mempool.add({ tx: tx(0), signature: sign.signTransaction(tx(0), key) });
    assert.equal(first.ok, true);
    assert.equal(mempool.add({ tx: tx(1), signature: sign.signTransaction(tx(1), key) }).ok, true);
    mempool.remove([first.hash]);
    assert.equal(mempool.size, 1);

    const later = Date.now() + STALL_MS + 1000;
    for (let i = 0; i < 5; i += 1) assert.equal(mineOnce(later + i * 1000), null);   // 5 รอบ ไม่มี block ว่าง
    assert.equal(vm.latestBlockNumber(), null);
    assert.equal(minerState.idleAt, later + 4000);
    assert.deepEqual(health(later + 4500).problems, []);
    assert.match(health(later + 60_000).problems.join(), /^stalled/);   // miner ไม่ได้มาดูนาน = stalled จริง

  } finally {
    server.close();
  }
});
