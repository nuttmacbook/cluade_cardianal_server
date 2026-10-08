import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import * as sign from "../src/crypto/signature.js";

/*
 * ตรวจข้ามกับไลบรารีมาตรฐาน (ethers) ซึ่งใช้อัลกอริทึมเดียวกับ MetaMask
 *   - ลายเซ็นที่เราสร้าง → ethers ตรวจผ่าน
 *   - ลายเซ็นที่ wallet (ethers) สร้าง → เรากู้ address ได้ถูกต้อง
 * ผ่านเทสต์ชุดนี้ = ผู้ใช้เซ็นด้วย MetaMask ได้เลย ไม่ต้องทำ wallet เอง
 */

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const wallet = new ethers.Wallet(PRIVATE_KEY);

const TX = {
  chainId: 1,
  action: "call",
  from: wallet.address.toLowerCase(),
  to: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  method: "transfer",
  input: { to: "0xfabb0ac9d68b0b445fb7357272ff202c5651694a", amount: 30 },
  value: 0,
  nonce: 3,
  gasLimit: 50000,
};

/** โครงสร้างที่ส่งให้ ethers (ตัด EIP712Domain ออกตามที่ ethers ต้องการ) */
function forEthers(tx) {
  const typed = sign.buildTypedData(tx);
  const { EIP712Domain, ...types } = typed.types;
  return { domain: typed.domain, types, message: typed.message };
}

test("address: ที่ได้จาก private key ตรงกับของ ethers", () => {
  assert.equal(sign.addressOf(PRIVATE_KEY), wallet.address.toLowerCase());
});

test("digest: EIP-712 hash ตรงกับที่ ethers คำนวณ", () => {
  const { domain, types, message } = forEthers(TX);
  assert.equal(sign.hashTypedData(TX), ethers.TypedDataEncoder.hash(domain, types, message));
});

test("ลายเซ็นของเรา → ethers ตรวจแล้วได้ address เดิม", () => {
  const signature = sign.signTransaction(TX, PRIVATE_KEY);
  const { domain, types, message } = forEthers(TX);
  assert.equal(ethers.verifyTypedData(domain, types, message, signature).toLowerCase(), wallet.address.toLowerCase());
});

test("ลายเซ็นจาก wallet (แบบเดียวกับ MetaMask) → เรากู้ address ได้ถูกต้อง", async () => {
  const { domain, types, message } = forEthers(TX);
  const signature = await wallet.signTypedData(domain, types, message);   // = eth_signTypedData_v4

  assert.equal(sign.recoverSigner(TX, signature), wallet.address.toLowerCase());
  const verified = sign.verifyTransaction({ tx: TX, signature });
  assert.equal(verified.sender, wallet.address.toLowerCase());
  assert.equal(verified.action, "call");
  assert.deepEqual(verified.request.context, { sender: wallet.address.toLowerCase(), origin: wallet.address.toLowerCase() });
});

test("ลายเซ็นของเรากับของ wallet เป็นค่าเดียวกันทุกตัวอักษร", async () => {
  const { domain, types, message } = forEthers(TX);
  const ours = sign.signTransaction(TX, PRIVATE_KEY);
  const theirs = await wallet.signTypedData(domain, types, message);
  assert.equal(ours, theirs);
});

test("ทุก action เซ็นและกู้กลับได้ตรงกับ ethers", async () => {
  const variants = [
    TX,
    { ...TX, action: "transfer", to: "0xfabb0ac9d68b0b445fb7357272ff202c5651694a", method: "", input: {}, value: 250 },
    { ...TX, action: "deploy", to: "", method: "", input: { start: 1 }, code: "function program() {\n  function a() {}\n  return { a }\n}" },
  ];

  for (const tx of variants) {
    const { domain, types, message } = forEthers(tx);
    const signature = await wallet.signTypedData(domain, types, message);
    assert.equal(sign.recoverSigner(tx, signature), wallet.address.toLowerCase(), tx.action);
    assert.equal(sign.hashTypedData(tx), ethers.TypedDataEncoder.hash(domain, types, message), tx.action);
  }
});

test("แก้ tx หลังเซ็น → ethers ก็กู้ได้เป็นคนอื่น (ตรงกับผลของเรา)", async () => {
  const { domain, types, message } = forEthers(TX);
  const signature = await wallet.signTypedData(domain, types, message);
  const tampered = { ...TX, input: { ...TX.input, amount: 999 } };

  const theirs = ethers.verifyTypedData(...Object.values(forEthers(tampered)), signature).toLowerCase();
  assert.notEqual(theirs, wallet.address.toLowerCase());
  assert.equal(sign.recoverSigner(tampered, signature), theirs);
  assert.throws(() => sign.verifyTransaction({ tx: tampered, signature }), /ลายเซ็นไม่ตรงกับ from/);
});

test("สิ่งที่ผู้ใช้เห็นใน MetaMask", () => {
  const typed = sign.buildTypedData(TX);
  assert.deepEqual(typed.domain, { name: "ProgramVM", version: "1", chainId: 1 });
  assert.deepEqual(typed.message, {
    action: "call",
    from: TX.from,
    to: TX.to,
    method: "transfer",
    input: JSON.stringify({ code: null, input: { amount: 30, to: TX.input.to } }),
    value: 0,
    nonce: 3,
    gasLimit: 50000,
    gasPrice: 0,
  });
});
