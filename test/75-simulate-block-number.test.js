import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { simulate } from "../src/node/simulate.js";

/*
 * simulate (ที่ /sendtx) จำลองเป็น block ถัดไปเสมอ
 * เดิมใช้ number: null → BlockNumber() ในโปรแกรมเป็น null ตอน simulate (แต่เป็น BigInt ตอนรันใน block)
 * → โปรแกรมที่คำนวณกับเลข block (เช่น BlockHash(BlockNumber() - 1n)) ถูกปฏิเสธที่ /sendtx ทั้งที่ใน block รันได้
 * (พบตอนทำ scripts/scenario-full.js หัวข้อ "API ในโปรแกรม")
 */

const CODE = `function program() {
  function look() {
    const n = BlockNumber()
    return { number: n, previous: BlockHash(n - 1n) }
  }
  return { look }
}`;

test("simulate: BlockNumber() = block ถัดไป และ BlockHash(n - 1) = hash ของ block ล่าสุด (เหมือนตอนเข้า block จริง)", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true, recordBlocks: true, recordTransactions: true, deriveProgramAddress: false });
  const key = sign.randomPrivateKey();
  const alice = sign.addressOf(key);
  vm.db.load({ [`${alice}:native:received`]: "1000000000000000000n" });
  let clock = 1_000;
  const mine = (fn) => { const block = vm.createBlock({ timestamp: (clock += 1000) }); const result = fn(block); block.commit(); return result; };
  mine((b) => b.deploy({ programUuid: "0x00000000000000000000000000000000000000b1", code: CODE, context: { sender: alice, origin: alice }, nonce: 0 }));
  mine((b) => b.init({ programUuid: "0x00000000000000000000000000000000000000b1" }));

  const tx = { chainId: vm.chainId, action: "call", from: alice, to: "0x00000000000000000000000000000000000000b1", method: "look", input: {}, value: 0, nonce: 1, gasLimit: 500_000, gasPrice: "1" };
  const verified = sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, key) });
  const result = simulate(vm, verified);
  assert.equal(result.ok, true, result.error);
  const latest = vm.latestBlockNumber();
  assert.deepEqual(result.result, { number: `${latest + 1}n`, previous: vm.getBlock(latest).hash });

  // simulate ไม่จองเลข block / ไม่บันทึกอะไร
  assert.equal(vm.latestBlockNumber(), latest);
  assert.ok(!vm.getBlock(latest + 1));
  // ผลตอนเข้า block จริงตรงกับที่ simulate บอก
  const real = mine((b) => b.call(verified.request));
  assert.deepEqual([real.status, real.result], ["success", result.result]);
});
