import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import * as sign from "../src/crypto/signature.js";

/*
 * เซ็นจากกระเป๋าที่เปิดเชน EVM ไหนก็ได้ (ไม่ต้อง add Bluewolfchain) + กัน replay ข้ามเชน
 *   domain ไม่มี chainId (MetaMask บังคับ chainId ของ domain = เชนที่เปิดอยู่) · chainId ของเชนอยู่ใน message → mempool ตรวจ
 *   signedOnChainId = เชนที่กระเป๋าเปิดอยู่ตอนเซ็น (อยู่ในลายเซ็น) → receipt / explorer แสดง
 */

const CHAIN = 41234;
const KEY = sign.randomPrivateKey();
const alice = sign.addressOf(KEY);
const bob = "0x0000000000000000000000000000000000000b0b";
let clock = Date.parse("2026-11-11T00:00:00Z");

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: CHAIN, requireNonce: true, recordTransactions: true, recordBlocks: true, recordHistory: true });
  vm.db.load({ [`${alice}:native:received`]: "1000000000000000000n" });
  return { vm, pool: new Mempool(vm) };
}
const transfer = (fields = {}) => ({ chainId: CHAIN, action: "transfer", from: alice, to: bob, value: "5", nonce: 0, gasLimit: 100_000, ...fields });
const signed = (tx) => ({ tx, signature: sign.signTransaction(tx, KEY) });
/** แบบเดียวกับ GET /tx/:hash/receipt (server.js) */
function receiptOf(vm, hash) {
  const found = vm.getTransaction(hash);
  return vm.replayBlock(found.blockNumber).transactions[found.index];
}
function mine(vm, pool) {
  const block = vm.createBlock({ timestamp: (clock += 2000) });
  const included = pool.take(block);
  block.commit();
  return included;
}

test("replay ข้ามเชน: ลายเซ็นของ chainId อื่น (เช่นเชนทดสอบ 272727) → mempool ปฏิเสธ · ไม่แตะ state", () => {
  const { vm, pool } = setup();
  const res = pool.add(signed(transfer({ chainId: 272727 })));
  assert.equal(res.ok, false);
  assert.match(res.reason, /chainId ของ tx \(272727\) ไม่ตรงกับเชน \(41234\)/);
  assert.equal(pool.size ?? pool.countOf(alice), 0);
  assert.equal(BigInt(vm.nativeBalanceOf(bob).balance), 0n);
});

test("เซ็นตอนกระเป๋าเปิด BSC (56) อยู่: ผ่าน · receipt มี signedOnChainId 56", () => {
  const { vm, pool } = setup();
  const res = pool.add(signed(transfer({ signedOnChainId: 56 })));
  assert.equal(res.ok, true, res.reason);
  mine(vm, pool);
  const receipt = receiptOf(vm, res.hash);
  assert.equal(receipt.status, "success");
  assert.equal(receipt.signedOnChainId, 56);
  assert.equal(BigInt(vm.nativeBalanceOf(bob).balance), 5n);
});

test("ไม่ส่ง signedOnChainId (สคริปต์ / SDK) = เซ็นบนเชนนี้", () => {
  const { vm, pool } = setup();
  const res = pool.add(signed(transfer()));
  assert.equal(res.ok, true, res.reason);
  mine(vm, pool);
  assert.equal(receiptOf(vm, res.hash).signedOnChainId, CHAIN);
});

test("ลายเซ็นจาก wallet มาตรฐาน (ethers = อัลกอริทึมเดียวกับ MetaMask) ที่ไม่มี chainId ใน domain → ตรวจผ่าน", async () => {
  const wallet = new ethers.Wallet(KEY);
  const tx = sign.normalizeTransaction(transfer({ signedOnChainId: 1 }));
  const typed = sign.buildTypedData(tx);
  const { EIP712Domain, ...types } = typed.types;
  assert.equal(typed.domain.chainId, undefined);
  const signature = await wallet.signTypedData(typed.domain, types, typed.message);
  assert.equal(sign.verifyTransaction({ tx: transfer({ signedOnChainId: 1 }), signature }).sender, alice);
});
