import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as sign from "../src/crypto/signature.js";

/* มีแต่ใบที่ถูกปฏิเสธ → server ไม่ปิด block ทันที: ติดไปกับ block ที่มี tx จริง หรือปิดเมื่อใบที่รอนานสุดครบ REJECTED_HOLD_MS (ค่าเริ่ม 60 วิ) */

const KEY = sign.randomPrivateKey();   // กระเป๋าไม่มีเหรียญ
const me = sign.addressOf(KEY);
const CODE = "function program() {\n  function ping(params) { return 1n }\n  return { ping };\n}";

let server, vm, mempool, shouldMine, REJECTED_HOLD_MS, url, chainId;

before(async () => {
  let miner;
  ({ server, vm, mempool, miner, shouldMine, REJECTED_HOLD_MS } = await import("../server.js"));
  clearInterval(miner);
  chainId = vm.chainId;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (p, body) => fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

test("ค่าเริ่ม 60 วิ · /pending บอกค่าที่ตั้ง", async () => {
  assert.equal(REJECTED_HOLD_MS, 60_000);
  assert.equal((await fetch(`${url}/pending`).then((r) => r.json())).rejectedHoldMs, 60_000);
});

test("ใบที่ถูกปฏิเสธอย่างเดียว: ยังไม่ปิด block จนกว่าใบที่รอนานสุดครบ 60 วิ", async () => {
  assert.equal(shouldMine(), false, "คิวว่าง");
  const tx = { chainId, from: me, to: "", method: "", input: {}, value: 0, gasLimit: 500_000, maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "0", nonce: 0, action: "deploy", code: CODE };
  const sent = await post("/sendtx", { tx, signature: sign.signTransaction(tx, KEY) });
  assert.equal(sent.queued, false);
  assert.equal(mempool.rejectedPending, 1);
  const at = mempool.oldestRejectionAt;
  assert.ok(Number.isFinite(at));
  assert.equal(shouldMine(at), false);
  assert.equal(shouldMine(at + 59_999), false);
  assert.equal(shouldMine(at + 60_000), true, "ครบ 60 วิ → ปิด block บันทึกใบที่ถูกปฏิเสธ");
});

test("มี tx จริงในคิว → ปิด block ทันที และใบที่ถูกปฏิเสธติดไปด้วย · เวลาไม่ถูกบันทึกลง block", async () => {
  const key = sign.randomPrivateKey();
  assert.equal(mempool.rejectedPending, 1);
  // tx จริง (simulate ผ่าน) เข้าคิว
  const tx = { chainId, from: sign.addressOf(key), to: me, method: "", input: {}, value: 0, gasLimit: 0, gasPrice: "1000000000", nonce: 0, action: "transfer" };
  const queued = mempool.add({ tx, signature: sign.signTransaction(tx, key) }, { simulate: () => ({ ok: true }) });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(shouldMine(mempool.oldestRejectionAt), true, "มี tx จริง → ไม่ต้องรอ");
  const block = vm.createBlock({ timestamp: Date.now(), feeRecipient: "0x1111111111111111111111111111111111111111" });
  mempool.take(block);
  const rejected = block.rejectedTransactions();
  block.commit();
  assert.equal(rejected.length, 1);
  assert.equal("at" in rejected[0], false);
  assert.equal(mempool.rejectedPending, 0);
  assert.equal(mempool.oldestRejectionAt, null);
});

test("env: REJECTED_HOLD_MS ตั้งได้ · AUTO_REVIEW=0 ปิดการตรวจโค้ดที่ /sendtx (ค่าเริ่ม = เปิด)", async () => {
  const { execFileSync } = await import("node:child_process");
  const read = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    "const m = await import('./server.js'); clearInterval(m.miner); console.log(JSON.stringify([m.AUTO_REVIEW, m.REJECTED_HOLD_MS])); process.exit(0)"],
  { env: { ...process.env, PORT: "0", ...env }, encoding: "utf8" }).trim().split("\n").at(-1));
  assert.deepEqual(read({}), [true, 60_000]);
  assert.deepEqual(read({ AUTO_REVIEW: "0", REJECTED_HOLD_MS: "0" }), [false, 0]);
  assert.deepEqual(read({ AUTO_REVIEW: "off" }), [false, 60_000]);
  assert.deepEqual(read({ AUTO_REVIEW: "1" }), [true, 60_000]);
});
