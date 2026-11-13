import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import { RateLimiter } from "../src/node/ratelimit.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN } from "./programs.js";

/* keep long-running programs from hanging the server: short timeout, per-IP rate limit, cheap checks before simulate */

const T = Date.parse("2024-06-01T10:00:00Z");
const KEY = sign.randomPrivateKey();
const alice = sign.addressOf(KEY);
const LOOP = `function program() {
  function spin(params) { while (true) {} }
  return { spin }
}`;

// ---------------------------------------------------------------------------
//  RateLimiter

test("RateLimiter: over the limit → rejected, rejected calls are not counted, allowed again once the window passes", () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.allow("a", { now: T }), true);
  assert.equal(limiter.allow("a", { now: T + 100 }), true);
  assert.equal(limiter.allow("a", { now: T + 200 }), false);
  assert.equal(limiter.allow("a", { now: T + 300 }), false);
  assert.equal(limiter.retryAfter("a", { now: T + 300 }), 1);
  assert.equal(limiter.allow("b", { now: T + 300 }), true);       // counted per key
  assert.equal(limiter.allow("a", { now: T + 1000 }), true);      // the first call has left the window
});

test("RateLimiter: limit 0 → unlimited", () => {
  const limiter = new RateLimiter({ limit: 0 });
  for (let i = 0; i < 1000; i += 1) assert.equal(limiter.allow("a", { now: T }), true);
});

test("RateLimiter: remembers at most maxKeys keys (drops the least recently used)", () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
  limiter.allow("a", { now: T });
  limiter.allow("b", { now: T });
  limiter.allow("c", { now: T });                                 // "a" is dropped
  assert.equal(limiter.allow("a", { now: T }), true);
  assert.equal(limiter.allow("c", { now: T }), false);
});

// ---------------------------------------------------------------------------
//  Mempool.add({ simulate })

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true });
  vm.db.load({ [`${alice}:native:received`]: "1000000n" });
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

test("mempool: wrong nonce → simulate is never called", () => {
  const pool = new Mempool(setup());
  let calls = 0;
  const res = pool.add(signed(5), { simulate: () => { calls += 1; return { ok: true }; } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "nonce must be 0");
  assert.equal(calls, 0);
});

test("mempool: simulate fails → not queued, but counted in the rate limit", () => {
  const pool = new Mempool(setup(), { rateLimit: 2, rateWindowMs: 1000 });
  let calls = 0;
  const failing = () => { calls += 1; return { ok: false, error: "program ran past the time limit" }; };

  const first = pool.add(signed(0), { now: T, simulate: failing });
  assert.deepEqual([first.ok, first.reason, first.simulation.ok], [false, "program ran past the time limit", false]);
  assert.equal(pool.size, 0);
  pool.add(signed(0), { now: T, simulate: failing });

  const third = pool.add(signed(0), { now: T, simulate: failing });
  assert.equal(third.reason, "sending too frequently");
  assert.equal(calls, 2);                                         // the 3rd call is not simulated
});

test("mempool: simulate passes → queued, simulation result returned", () => {
  const pool = new Mempool(setup());
  const res = pool.add(signed(0), { simulate: () => ({ ok: true, gasUsed: 123 }) });
  assert.deepEqual([res.ok, res.simulation.gasUsed, pool.size], [true, 123, 1]);
});

// ---------------------------------------------------------------------------
//  server.js over real HTTP

let server, vm, url;

before(async () => {
  process.env.TIMEOUT_MS = "1000";   // a 3M-gas loop in QuickJS takes ~100ms (slower under heavy load) and must run out of gas before the timeout
  process.env.RATE_LIMIT = "4";
  process.env.GAS_PRICE ??= "1000000000";   // this test uses the dev gas price of 1 gwei (the chain default of 10,000 gwei is tested in 107)
  ({ server, vm } = await import("../server.js"));
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "loop", code: LOOP, context: { sender: alice, origin: alice } }).writes);
  vm.commit(plain.init({ programUuid: "loop" }).writes);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (path, body) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("server: /query with an infinite loop runs out of gas (OUT_OF_GAS) instead of hanging 30 seconds", async () => {
  const started = Date.now();
  const res = await post("/query", { programUuid: "loop", functionName: "spin", input: {}, context: { sender: alice, origin: alice } });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "OUT_OF_GAS");   // server maxTxGas cap
  assert.ok(elapsed < 1500, `took ${elapsed}ms`);
});

test("server: POST over RATE_LIMIT per IP → 429 with retry-after", async () => {
  // the previous test used 1, leaving 3
  for (let i = 0; i < 3; i += 1) assert.notEqual((await post("/query", {})).status, 429);
  const res = await post("/sendtx", {});
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
  assert.match((await res.json()).error, /Too many requests/);
});

test("server: GET is not limited", async () => {
  for (let i = 0; i < 10; i += 1) assert.equal((await fetch(`${url}/genesis`)).status, 200);
});
