import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import { RateLimiter } from "../src/node/ratelimit.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN } from "./programs.js";

/* กันโปรแกรมที่รันนานทำให้ server ค้าง: timeout สั้น, rate limit ต่อ IP, ตรวจราคาถูกก่อน simulate */

const T = Date.parse("2024-06-01T10:00:00Z");
const KEY = sign.randomPrivateKey();
const alice = sign.addressOf(KEY);
const LOOP = `function program() {
  function spin(params) { while (true) {} }
  return { spin }
}`;

// ---------------------------------------------------------------------------
//  RateLimiter

test("RateLimiter: เกินกำหนด → ปฏิเสธ, ครั้งที่ถูกปฏิเสธไม่ถูกนับ, พ้นช่วงแล้วเรียกได้อีก", () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.allow("a", { now: T }), true);
  assert.equal(limiter.allow("a", { now: T + 100 }), true);
  assert.equal(limiter.allow("a", { now: T + 200 }), false);
  assert.equal(limiter.allow("a", { now: T + 300 }), false);
  assert.equal(limiter.retryAfter("a", { now: T + 300 }), 1);
  assert.equal(limiter.allow("b", { now: T + 300 }), true);       // นับแยกตาม key
  assert.equal(limiter.allow("a", { now: T + 1000 }), true);      // ครั้งแรกพ้นช่วงแล้ว
});

test("RateLimiter: limit 0 → ไม่จำกัด", () => {
  const limiter = new RateLimiter({ limit: 0 });
  for (let i = 0; i < 1000; i += 1) assert.equal(limiter.allow("a", { now: T }), true);
});

test("RateLimiter: จำ key ไม่เกิน maxKeys (ทิ้งตัวที่ไม่ได้ใช้นานสุด)", () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
  limiter.allow("a", { now: T });
  limiter.allow("b", { now: T });
  limiter.allow("c", { now: T });                                 // "a" ถูกทิ้ง
  assert.equal(limiter.allow("a", { now: T }), true);
  assert.equal(limiter.allow("c", { now: T }), false);
});

// ---------------------------------------------------------------------------
//  Mempool.add({ simulate })

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true });
  vm.db.load({ [`${alice}:native:received`]: 1_000_000 });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: { sender: alice, origin: alice }, initInput: { supply: 10_000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  return vm;
}

const signed = (nonce) => {
  const tx = { chainId: 1, action: "call", from: alice, to: "token", method: "transfer", input: { to: "0xcarol", amount: 1 },
    value: 0, nonce, gasLimit: 0, gasPrice: 1 };
  return { tx, signature: sign.signTransaction(tx, KEY) };
};

test("mempool: nonce ผิด → ไม่เรียก simulate เลย", () => {
  const pool = new Mempool(setup());
  let calls = 0;
  const res = pool.add(signed(5), { simulate: () => { calls += 1; return { ok: true }; } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "nonce ต้องเป็น 0");
  assert.equal(calls, 0);
});

test("mempool: simulate ไม่ผ่าน → ไม่เข้าคิว แต่ถูกนับใน rate limit", () => {
  const pool = new Mempool(setup(), { rateLimit: 2, rateWindowMs: 1000 });
  let calls = 0;
  const failing = () => { calls += 1; return { ok: false, error: "โปรแกรมทำงานเกินเวลาที่กำหนด" }; };

  const first = pool.add(signed(0), { now: T, simulate: failing });
  assert.deepEqual([first.ok, first.reason, first.simulation.ok], [false, "โปรแกรมทำงานเกินเวลาที่กำหนด", false]);
  assert.equal(pool.size, 0);
  pool.add(signed(0), { now: T, simulate: failing });

  const third = pool.add(signed(0), { now: T, simulate: failing });
  assert.equal(third.reason, "ส่งถี่เกินกำหนด");
  assert.equal(calls, 2);                                         // ครั้งที่ 3 ไม่ได้ simulate
});

test("mempool: simulate ผ่าน → เข้าคิวและคืนผล simulation", () => {
  const pool = new Mempool(setup());
  const res = pool.add(signed(0), { simulate: () => ({ ok: true, gasUsed: 123 }) });
  assert.deepEqual([res.ok, res.simulation.gasUsed, pool.size], [true, 123, 1]);
});

// ---------------------------------------------------------------------------
//  server.js ผ่าน HTTP จริง

let server, vm, url;

before(async () => {
  process.env.TIMEOUT_MS = "300";
  process.env.RATE_LIMIT = "4";
  ({ server, vm } = await import("../server.js"));
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "loop", code: LOOP, context: { sender: alice, origin: alice } }).writes);
  vm.commit(plain.init({ programUuid: "loop" }).writes);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (path, body) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("server: /query ที่วนไม่รู้จบถูกหยุดตาม TIMEOUT_MS ไม่ค้าง 30 วินาที", async () => {
  const started = Date.now();
  const res = await post("/query", { programUuid: "loop", functionName: "spin", input: {}, context: { sender: alice, origin: alice } });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "TIMEOUT");
  assert.ok(elapsed < 1500, `ใช้เวลา ${elapsed}ms`);
});

test("server: POST เกิน RATE_LIMIT ต่อ IP → 429 พร้อม retry-after", async () => {
  // เทสต์ก่อนหน้าใช้ไป 1 ครั้ง เหลือ 3
  for (let i = 0; i < 3; i += 1) assert.notEqual((await post("/query", {})).status, 429);
  const res = await post("/sendtx", {});
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
  assert.match((await res.json()).error, /ถี่เกินกำหนด/);
});

test("server: GET ไม่ถูกจำกัด", async () => {
  for (let i = 0; i < 10; i += 1) assert.equal((await fetch(`${url}/genesis`)).status, 200);
});
