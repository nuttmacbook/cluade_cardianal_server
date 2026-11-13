import { test } from "node:test";
import assert from "node:assert/strict";
import * as sign from "../src/crypto/signature.js";
import { VerifyPool } from "../src/node/verify-pool.js";

/*
 * Phase 2.3: verify /sendtx signatures in a worker thread (src/node/verify-pool.js)
 *   results byte-identical to verifyTransaction on the main thread · bad signature = same message · the main thread is not blocked during checks
 */

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OTHER = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const FROM = sign.addressOf(KEY);
const base = { chainId: 1, from: FROM, nonce: 0, gasLimit: 200_000, gasPrice: "1000000000" };
const TXS = [
  { ...base, action: "transfer", to: "0x00000000000000000000000000000000000000b0", value: "1n" },
  { ...base, action: "call", to: "token", method: "transfer", input: { to: "0x00000000000000000000000000000000000000b0", amount: "12345678901234567890n", nested: { list: [1, "a", null, true] } } },
  { ...base, action: "deploy", to: "", code: "function program() { function initialization() {} return {} }", input: {} },
  { ...base, action: "call", to: "token", method: "x", input: {}, maxFeePerGas: "3000000000", maxPriorityFeePerGas: "1", gasPrice: undefined },
];
const signed = (tx, key = KEY) => ({ tx, signature: sign.signTransaction(tx, key) });

test("the worker matches verifyTransaction byte for byte · bad signature / bad data = the same error message", async () => {
  const pool = new VerifyPool({ size: 2 });
  try {
    for (const tx of TXS) {
      const item = signed(tx);
      assert.deepEqual(await pool.verify(item), sign.verifyTransaction(item));
    }
    const forged = { tx: TXS[0], signature: sign.signTransaction(TXS[0], OTHER) };
    const expected = (() => { try { sign.verifyTransaction(forged); } catch (error) { return error.message; } })();
    assert.match(expected, /signature does not match from/);
    await assert.rejects(pool.verify(forged), { message: expected });
    await assert.rejects(pool.verify({ tx: TXS[0], signature: "0x1234" }));
    await assert.rejects(pool.verify({}));
    await assert.rejects(pool.verify({ tx: { ...TXS[0], input: () => 1 }, signature: "0x" }));   // cannot cross threads → rejects instead of hanging
  } finally {
    await pool.close();
  }
});

test("size 0 = check on the main thread · can be called again after close (creates a new worker)", async () => {
  const inline = new VerifyPool({ size: 0 });
  const item = signed(TXS[1]);
  assert.deepEqual(await inline.verify(item), sign.verifyTransaction(item));
  await assert.rejects(inline.verify({}));

  const pool = new VerifyPool({ size: 1 });
  assert.equal((await pool.verify(item)).sender, FROM);
  await pool.close();
  assert.equal((await pool.verify(item)).sender, FROM);
  await pool.close();
});

test("verifying 200 txs at once: the main thread stays responsive · all results present, in order", async () => {
  const pool = new VerifyPool({ size: 2 });
  try {
    const items = Array.from({ length: 200 }, (_, nonce) => signed({ ...TXS[0], nonce }));
    await pool.verify(items[0]);   // warm up the worker
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    const started = performance.now();
    const results = await Promise.all(items.map((item) => pool.verify(item)));
    const elapsed = performance.now() - started;
    clearInterval(timer);
    assert.deepEqual(results.map((result) => result.request.nonce), items.map((item) => item.tx.nonce));
    assert.ok(results.every((result) => result.sender === FROM));
    // on the main thread this work would block continuously (timers never run) · with a worker, timers must run while waiting
    assert.ok(ticks >= Math.min(5, elapsed / 20), `timer ran ${ticks} times in ${elapsed.toFixed(0)} ms`);
  } finally {
    await pool.close();
  }
});
