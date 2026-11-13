import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as sign from "../src/crypto/signature.js";

/* only rejected txs → the server does not close a block right away: they ride along with a block that has real txs, or a block closes once the oldest has waited REJECTED_HOLD_MS (default 60 s) */

const KEY = sign.randomPrivateKey();   // wallet with no coins
const me = sign.addressOf(KEY);
const CODE = "function program() {\n  function ping(params) { return 1n }\n  return { ping };\n}";

let server, vm, mempool, shouldMine, REJECTED_HOLD_MS, url, chainId;

before(async () => {
  let miner;
  process.env.GAS_PRICE ??= "1000000000";   // this test uses the dev gas price of 1 gwei (the chain default of 10,000 gwei is tested in 107)
  ({ server, vm, mempool, miner, shouldMine, REJECTED_HOLD_MS } = await import("../server.js"));
  clearInterval(miner);
  chainId = vm.chainId;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (p, body) => fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

test("default 60 s · /pending shows the setting", async () => {
  assert.equal(REJECTED_HOLD_MS, 60_000);
  assert.equal((await fetch(`${url}/pending`).then((r) => r.json())).rejectedHoldMs, 60_000);
});

test("rejected txs only: no block until the oldest has waited 60 s", async () => {
  assert.equal(shouldMine(), false, "queue empty");
  const tx = { chainId, from: me, to: "", method: "", input: {}, value: 0, gasLimit: 500_000, maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "0", nonce: 0, action: "deploy", code: CODE };
  const sent = await post("/sendtx", { tx, signature: sign.signTransaction(tx, KEY) });
  assert.equal(sent.queued, false);
  assert.equal(mempool.rejectedPending, 1);
  const at = mempool.oldestRejectionAt;
  assert.ok(Number.isFinite(at));
  assert.equal(shouldMine(at), false);
  assert.equal(shouldMine(at + 59_999), false);
  assert.equal(shouldMine(at + 60_000), true, "60 s reached → close a block recording the rejected txs");
});

test("real txs in the queue → close a block right away, with the rejected txs included · the wait time is not recorded in the block", async () => {
  const key = sign.randomPrivateKey();
  assert.equal(mempool.rejectedPending, 1);
  // a real tx (simulate passes) enters the queue
  const tx = { chainId, from: sign.addressOf(key), to: me, method: "", input: {}, value: 0, gasLimit: 0, gasPrice: "1000000000", nonce: 0, action: "transfer" };
  const queued = mempool.add({ tx, signature: sign.signTransaction(tx, key) }, { simulate: () => ({ ok: true }) });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(shouldMine(mempool.oldestRejectionAt), true, "real tx present → no waiting");
  const block = vm.createBlock({ timestamp: Date.now(), feeRecipient: "0x1111111111111111111111111111111111111111" });
  mempool.take(block);
  const rejected = block.rejectedTransactions();
  block.commit();
  assert.equal(rejected.length, 1);
  assert.equal("at" in rejected[0], false);
  assert.equal(mempool.rejectedPending, 0);
  assert.equal(mempool.oldestRejectionAt, null);
});

test("env: REJECTED_HOLD_MS is configurable · AUTO_REVIEW=0 turns off code review at /sendtx (default = on)", async () => {
  const { execFileSync } = await import("node:child_process");
  const read = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    "const m = await import('./server.js'); clearInterval(m.miner); console.log(JSON.stringify([m.AUTO_REVIEW, m.REJECTED_HOLD_MS])); process.exit(0)"],
  { env: { ...process.env, PORT: "0", ...env }, encoding: "utf8" }).trim().split("\n").at(-1));
  assert.deepEqual(read({}), [true, 60_000]);
  assert.deepEqual(read({ AUTO_REVIEW: "0", REJECTED_HOLD_MS: "0" }), [false, 0]);
  assert.deepEqual(read({ AUTO_REVIEW: "off" }), [false, 60_000]);
  assert.deepEqual(read({ AUTO_REVIEW: "1" }), [true, 60_000]);
});
