import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN } from "./programs.js";

/* แทนที่ tx ที่ยังรอในคิว (nonce เดิม + gasPrice สูงกว่าเดิม ≥ 10%) · ยกเลิกด้วยการโอน 0 ให้ตัวเอง (แบบ EVM) */

const T = Date.parse("2024-06-01T10:00:00Z");
const ALICE_KEY = sign.randomPrivateKey();
const BOB_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);
const bob = sign.addressOf(BOB_KEY);

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, ...options,
  });
  vm.db.load({ [`${alice}:native:received`]: "1000000000000n", [`${bob}:native:received`]: "1000000000000n" });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: { sender: alice, origin: alice }, initInput: { supply: 10_000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  return vm;
}

const callTx = (from, nonce, gasPrice, amount = 1) =>
  ({ chainId: 1, action: "call", from, to: "token", method: "transfer", input: { to: "0xcarol", amount }, value: 0, nonce, gasLimit: 0, gasPrice });
const cancelTx = (from, nonce, gasPrice) =>
  ({ chainId: 1, action: "transfer", from, to: from, value: 0, nonce, gasLimit: 0, gasPrice });   // ยกเลิก = โอน 0 ให้ตัวเอง
const signed = (tx, key = ALICE_KEY) => ({ tx, signature: sign.signTransaction(tx, key) });

// ---------------------------------------------------------------------------

test("แทนที่: gasPrice +10% → แทนที่ได้, ใบเดิมหายจากคิว และจำ replacedBy ไว้", () => {
  const pool = new Mempool(setup());
  const old = pool.add(signed(callTx(alice, 0, 100)), { now: T });
  const next = pool.add(signed(callTx(alice, 0, 110, 2)), { now: T + 1 });
  assert.deepEqual([next.ok, next.replaced], [true, old.hash]);
  assert.equal(pool.size, 1);
  assert.equal(pool.has(old.hash), false);
  assert.equal(pool.has(next.hash), true);
  assert.equal(pool.replacedBy(old.hash, { now: T + 2 }), next.hash);
  assert.equal(pool.nextNonce(alice), 1);                         // แทนที่ไม่ขยับ nonce ถัดไป
});

test("แทนที่: gasPrice +9% → ปฏิเสธ และใบเดิมยังอยู่", () => {
  const pool = new Mempool(setup());
  const old = pool.add(signed(callTx(alice, 0, 100)), { now: T });
  const res = pool.add(signed(callTx(alice, 0, 109, 2)), { now: T });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "ราคาแก๊สต่ำเกินไปสำหรับการแทนที่ (ต้องอย่างน้อย 110)");
  assert.equal(pool.has(old.hash), true);
  assert.equal(pool.size, 1);
});

test("แทนที่: ขอบพอดี (wei ใหญ่ เป็น string) และปัดขึ้น · ไม่ระบุ gasPrice = ราคาตั้งต้นของ VM", () => {
  const pool = new Mempool(setup({ gas: { price: 1_000_000_000n } }));
  pool.add(signed(callTx(alice, 0, "1000000000")), { now: T });
  assert.equal(pool.add(signed(callTx(alice, 0, "1099999999n")), { now: T }).ok, false);
  assert.equal(pool.add(signed(callTx(alice, 0, "1100000000n")), { now: T }).ok, true);   // = เดิม × 1.1 พอดี

  // ใบที่ไม่ระบุ gasPrice นับเป็นราคาตั้งต้นของ VM (1 gwei)
  const { gasPrice, ...noPrice } = callTx(alice, 1, 0);
  assert.equal(pool.add(signed(noPrice), { now: T }).ok, true);
  assert.match(pool.add(signed(callTx(alice, 1, 1_000_000_000)), { now: T }).reason, /ต้องอย่างน้อย 1100000000\)/);
  assert.equal(pool.add(signed(callTx(alice, 1, 1_100_000_000)), { now: T }).ok, true);

  // ราคาเล็ก: 10% ของ 1 ปัดขึ้น → ต้องเป็น 2
  const small = new Mempool(setup());
  small.add(signed(callTx(alice, 0, 1)), { now: T });
  assert.match(small.add(signed(callTx(alice, 0, 1, 3)), { now: T }).reason, /ต้องอย่างน้อย 2\)/);
  assert.equal(small.add(signed(callTx(alice, 0, 2)), { now: T }).ok, true);
});

test("ยกเลิก: แทนที่ call ด้วยการโอน 0 ให้ตัวเอง → block มีแค่ใบยกเลิก (กิน nonce + จ่ายแค่ค่าแก๊ส)", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  const call = pool.add(signed(callTx(alice, 0, 10)), { now: T });
  const cancel = pool.add(signed(cancelTx(alice, 0, 11)), { now: T });
  assert.deepEqual([cancel.ok, cancel.replaced], [true, call.hash]);
  assert.deepEqual(pool.list().map((item) => item.action), ["transfer"]);

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  assert.deepEqual(pool.take(block), [cancel.hash]);
  block.commit();
  assert.ok(vm.getTransaction(cancel.hash));
  assert.equal(vm.getTransaction(cancel.hash).status, "success");
  assert.ok(!vm.getTransaction(call.hash));
  assert.equal(vm.checkTransaction({ from: alice, nonce: -1 }).expectedNonce, 1);
  assert.equal(pool.add(signed(callTx(alice, 0, 10)), { now: T }).reason, "tx นี้ถูกส่งมาแล้ว");   // ส่งใบเดิมกลับเข้ามาไม่ได้
});

test("แทนที่: simulate ไม่ผ่าน → ใบเดิมยังอยู่ (แต่นับ rate limit)", () => {
  const pool = new Mempool(setup(), { rateLimit: 3 });
  const old = pool.add(signed(callTx(alice, 0, 10)), { now: T });
  const failing = () => ({ ok: false, error: "ยอดไม่พอ" });
  const res = pool.add(signed(callTx(alice, 0, 20)), { now: T, simulate: failing });
  assert.deepEqual([res.ok, res.reason], [false, "ยอดไม่พอ"]);
  assert.equal(pool.has(old.hash), true);
  assert.equal(pool.replacedBy(old.hash, { now: T }), null);

  pool.add(signed(callTx(alice, 0, 30)), { now: T, simulate: failing });
  assert.equal(pool.add(signed(callTx(alice, 0, 40)), { now: T, simulate: failing }).reason, "ส่งถี่เกินกำหนด");
  assert.equal(pool.has(old.hash), true);
});

test("แทนที่: ใบกลางคิว → block ยังหยิบตามลำดับ nonce", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  const first = pool.add(signed(callTx(alice, 0, 10)), { now: T });
  pool.add(signed(callTx(alice, 1, 10)), { now: T });
  const third = pool.add(signed(callTx(alice, 2, 10)), { now: T });
  const middle = pool.add(signed(cancelTx(alice, 1, 50)), { now: T + 1 });
  assert.equal(middle.ok, true);
  assert.equal(pool.nextNonce(alice), 3);

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  assert.deepEqual(pool.take(block), [first.hash, middle.hash, third.hash]);
  block.commit();
  assert.equal(pool.size, 0);
  assert.equal(vm.checkTransaction({ from: alice, nonce: -1 }).expectedNonce, 3);
});

test("nonce: ข้ามเลขยังถูกปฏิเสธ · nonce ที่เข้า block ไปแล้วแทนที่ไม่ได้", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  pool.add(signed(callTx(alice, 0, 10)), { now: T });
  const skipped = pool.add(signed(callTx(alice, 2, 10)), { now: T });
  assert.deepEqual([skipped.ok, skipped.reason, skipped.expectedNonce], [false, "nonce ต้องเป็น 1", 1]);

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  pool.take(block);
  block.commit();
  const late = pool.add(signed(callTx(alice, 0, 100)), { now: T });
  assert.deepEqual([late.ok, late.reason], [false, "nonce ต้องเป็น 1"]);
});

test("โควตา: การแทนที่ไม่กิน maxPerSender / maxSize", () => {
  const pool = new Mempool(setup(), { maxPerSender: 2, maxSize: 2 });
  pool.add(signed(callTx(alice, 0, 10)), { now: T });
  pool.add(signed(callTx(alice, 1, 10)), { now: T });
  assert.equal(pool.add(signed(callTx(alice, 2, 10)), { now: T }).reason, "คิวเต็ม");
  assert.equal(pool.add(signed(callTx(alice, 1, 11)), { now: T }).ok, true);
  assert.equal(pool.add(signed(callTx(alice, 0, 11)), { now: T }).ok, true);
  assert.equal(pool.size, 2);

  const perSender = new Mempool(setup(), { maxPerSender: 2 });
  perSender.add(signed(callTx(alice, 0, 10)), { now: T });
  perSender.add(signed(callTx(alice, 1, 10)), { now: T });
  assert.equal(perSender.add(signed(callTx(alice, 2, 10)), { now: T }).reason, "คิวของ address นี้เต็ม");
  assert.equal(perSender.add(signed(callTx(alice, 1, 20)), { now: T }).ok, true);
  assert.equal(perSender.countOf(alice), 2);
});

test("replacedBy: ลืมเมื่อพ้น ttlMs · clear() ล้าง", () => {
  const pool = new Mempool(setup(), { ttlMs: 1000 });
  const old = pool.add(signed(callTx(alice, 0, 10)), { now: T });
  const next = pool.add(signed(callTx(alice, 0, 11)), { now: T });
  assert.equal(pool.replacedBy(old.hash, { now: T + 1000 }), next.hash);
  assert.equal(pool.replacedBy(old.hash, { now: T + 1001 }), null);
  pool.clear();
  assert.equal(pool.replacedBy(old.hash, { now: T }), null);
});

// ---------------------------------------------------------------------------
//  server.js: GET /tx/:hash ตอบ status "replaced"

let server, vm, mempool, url;

before(async () => {
  let miner;
  ({ server, vm, mempool, miner } = await import("../server.js"));
  clearInterval(miner);                                           // ไม่ให้ปิด block ระหว่างเทสต์
  vm.db.load({ [`${alice}:native:received`]: "1000000000000000000n" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (path, body) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((r) => r.json());
const get = (path) => fetch(url + path).then(async (r) => ({ status: r.status, body: await r.json() }));

test("server: แทนที่ผ่าน /sendtx → /tx เดิมตอบ replaced, /nonce ไม่ขยับ, txpool เห็นแค่ใบใหม่", async () => {
  const chainId = vm.chainId;
  const old = await post("/sendtx", signed({ ...cancelTx(alice, 0, 1_000_000_000), chainId }));
  assert.equal(old.queued, true, JSON.stringify(old));
  assert.deepEqual((await get(`/tx/${old.hash}`)).body, { status: "pending", hash: old.hash });

  const low = await post("/sendtx", signed({ ...cancelTx(alice, 0, 1_099_999_999), chainId }));
  assert.equal(low.queued, false);
  assert.equal(low.reason, "ราคาแก๊สต่ำเกินไปสำหรับการแทนที่ (ต้องอย่างน้อย 1100000000)");

  const next = await post("/sendtx", signed({ ...cancelTx(alice, 0, 1_100_000_000), chainId }));
  assert.equal(next.queued, true, JSON.stringify(next));
  assert.deepEqual((await get(`/tx/${old.hash}`)).body, { status: "replaced", hash: old.hash, replacedBy: next.hash });
  assert.equal((await get(`/tx/${next.hash}`)).body.status, "pending");
  assert.equal((await get(`/tx/0x${"ab".repeat(32)}`)).status, 404);
  assert.equal((await get(`/nonce/${alice}`)).body.nonce, 1);
  assert.deepEqual(mempool.list().map((item) => item.hash), [next.hash]);

  const rpc = (method, params = []) => post("/evm", { jsonrpc: "2.0", id: 1, method, params });
  assert.equal((await rpc("txpool_status")).result.pending, "0x1");
  assert.equal((await rpc("eth_getTransactionByHash", [old.hash])).result, null);
  assert.equal((await rpc("eth_getTransactionByHash", [next.hash])).result.hash, next.hash);
});
