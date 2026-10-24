import { test } from "node:test";
import assert from "node:assert/strict";
import { TypedDataEncoder } from "ethers";
import * as sign from "../src/crypto/signature.js";
import { createClient, keySigner, walletTypedData } from "../client-sdk/index.js";

/*
 * ระยะ 3.4: ผู้จ่ายแก๊สแทน (paymaster / fee payer)
 *   tx.sponsor อยู่ในข้อมูลที่ผู้ส่งเซ็น · sponsor เซ็น digest เดียวกัน (sponsorSignature) · VM หักแก๊สจาก sponsor
 *   ผู้ส่งใช้ nonce ของตัวเองและจ่าย value เอง · tx ที่ไม่มี sponsor = digest เดิมทุกไบต์
 */

const FUNDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";   // มียอดใน genesis.json
const USER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const OTHER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const BOB = "0x00000000000000000000000000000000000000b0";
const SPONSOR = sign.addressOf(FUNDER_KEY);
const USER = sign.addressOf(USER_KEY);
const base = { chainId: 1, action: "transfer", from: USER, to: BOB, value: "1n", nonce: 0, gasLimit: 21_000, maxFeePerGas: "2000000000", maxPriorityFeePerGas: "0" };

test("ลายเซ็น: ไม่มี sponsor = ชนิดเดิม · มี sponsor = ต่อท้ายชนิด (ethers คิด digest ตรงกัน) · ผู้ส่งเปลี่ยน sponsor ไม่ได้", () => {
  assert.deepEqual(sign.buildTypedData(base).types.Transaction, sign.TRANSACTION_TYPE_1559);
  assert.deepEqual(sign.buildTypedData({ ...base, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, gasPrice: "1" }).types.Transaction, sign.TRANSACTION_TYPE);

  const sponsored = { ...base, sponsor: SPONSOR.toUpperCase().replace("0X", "0x") };
  const typed = walletTypedData(sponsored);
  assert.deepEqual(typed.types.Transaction.at(-1), { name: "sponsor", type: "address" });
  const { EIP712Domain, ...types } = typed.types;
  assert.equal(TypedDataEncoder.hash(typed.domain, types, typed.message), sign.hashTypedData(sponsored));
  assert.notEqual(sign.hashTypedData(sponsored), sign.hashTypedData(base));

  const signature = sign.signTransaction(sponsored, USER_KEY);
  const sponsorSignature = sign.signTransaction(sponsored, FUNDER_KEY);
  const verified = sign.verifyTransaction({ tx: sponsored, signature, sponsorSignature });
  assert.equal(verified.sender, USER);
  assert.equal(verified.sponsor, SPONSOR);
  assert.equal(verified.request.sponsor, SPONSOR);
  assert.equal(verified.request.sponsorSignature, sponsorSignature);
  assert.equal(sign.verifyTransaction({ tx: base, signature: sign.signTransaction(base, USER_KEY) }).request.sponsor, undefined);

  assert.throws(() => sign.verifyTransaction({ tx: sponsored, signature }), /ต้องมี sponsorSignature/);
  assert.throws(() => sign.verifyTransaction({ tx: sponsored, signature, sponsorSignature: sign.signTransaction(sponsored, OTHER_KEY) }), /sponsorSignature ไม่ตรงกับ sponsor/);
  assert.throws(() => sign.verifyTransaction({ tx: { ...sponsored, sponsor: sign.addressOf(OTHER_KEY) }, signature, sponsorSignature }), /ลายเซ็นไม่ตรงกับ from/);
  assert.throws(() => sign.verifyTransaction({ tx: base, signature: sign.signTransaction(base, USER_KEY), sponsorSignature }), /ไม่ได้ระบุ sponsor/);
  const self = { ...base, sponsor: USER };
  assert.throws(() => sign.verifyTransaction({ tx: self, signature: sign.signTransaction(self, USER_KEY), sponsorSignature: sign.signTransaction(self, USER_KEY) }), /ไม่ใช่ผู้ส่งเอง/);
});

test("เชน: ผู้ใช้ไม่มีเหรียญส่ง tx ได้เมื่อมี sponsor · แก๊สหักจาก sponsor · nonce / value เป็นของผู้ส่ง", async () => {
  const { server, vm, miner, mempool } = await import("../server.js");
  clearInterval(miner);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createClient({ url: `http://127.0.0.1:${server.address().port}` });
  const mine = () => { const block = vm.createBlock({ timestamp: Date.now() }); mempool.take(block); block.commit(); };
  const user = keySigner(USER_KEY);
  const sponsor = keySigner(FUNDER_KEY);
  try {
    assert.equal(await client.balance(USER), 0n);
    // ไม่มี sponsor + ไม่มีเหรียญ → ไม่ผ่าน
    const alone = await client.send({ action: "transfer", to: BOB, value: "0n", gasLimit: 21_000 }, user).catch((error) => error);
    assert.equal(alone.status, 400);

    const sponsoredZero = await client.send({ action: "transfer", to: BOB, value: "0n", gasLimit: 21_000 }, user, { sponsor });
    assert.equal(sponsoredZero.queued, true, JSON.stringify(sponsoredZero));
    const before = await client.balance(SPONSOR);
    mine();
    const done = await client.wait(sponsoredZero.hash, { intervalMs: 10 });
    assert.equal(done.blockNumber, 1);
    const receipt = await client.receipt(sponsoredZero.hash);
    assert.equal(receipt.status, "success");
    assert.equal(receipt.sponsor, SPONSOR);
    const fee = BigInt(String(receipt.fee).replace(/n$/, ""));
    assert.ok(fee > 0n);
    assert.equal(await client.balance(USER), 0n);                 // ผู้ใช้ไม่เสียอะไร
    assert.equal(await client.balance(SPONSOR), before - fee);    // sponsor จ่ายแก๊ส
    assert.equal(await client.nonce(USER), 1);                    // nonce ของผู้ส่งขยับ
    assert.equal(await client.nonce(SPONSOR), 0);                 // nonce ของ sponsor ไม่ขยับ

    // value ต้องเป็นเงินของผู้ส่งเอง (sponsor จ่ายแค่แก๊ส)
    const noValue = await client.send({ action: "transfer", to: BOB, value: "5n", gasLimit: 21_000 }, user, { sponsor }).catch((error) => error);
    assert.equal(noValue.status, 400);
  } finally {
    server.close();
  }
});
