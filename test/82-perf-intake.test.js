import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN } from "./programs.js";

/* speedups from load test results: verify signatures once · mempool cleanup stops at the first unexpired entry · cache block.hashes() */

const T = Date.parse("2024-06-01T10:00:00Z");
const ALICE_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, ...options });
  vm.db.load({ [`${alice}:native:received`]: "1000000n" });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: { sender: alice, origin: alice }, initInput: { supply: 10_000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  return vm;
}

const signed = (nonce, amount = 1) => {
  const tx = { chainId: 1, action: "call", from: alice, to: "token", method: "transfer", input: { to: "0xcarol", amount }, value: 0, nonce, gasLimit: 0, gasPrice: 1 };
  return { tx, signature: sign.signTransaction(tx, ALICE_KEY) };
};

test("add({ verified }): uses the passed-in signature check, no second recover · same result as checking itself", () => {
  const item = signed(0);
  const verified = sign.verifyTransaction(item);
  const a = new Mempool(setup()).add(item, { now: T });
  const b = new Mempool(setup()).add(item, { now: T, verified });
  assert.deepEqual(b, a);
  assert.equal(b.ok, true);
  // the item's own signature is not checked again (the server already did) → a broken signature with verified still uses verified
  const broken = { ...signed(0), signature: "0x00" };
  assert.equal(new Mempool(setup()).add(broken, { now: T, verified: sign.verifyTransaction(signed(0)) }).ok, true);
  assert.equal(new Mempool(setup()).add(broken, { now: T }).ok, false, "no verified → checks itself as before");
});

test("duplicate tx: blocked within ttl × 2 of first sight, even before cleanup · can be resent afterwards", () => {
  const vm = setup();
  const pool = new Mempool(vm, { ttlMs: 1000 });
  const item = signed(0);
  assert.equal(pool.add(item, { now: T }).ok, true);
  const block = vm.createBlock({ timestamp: T + 10 });
  pool.take(block, { now: T + 10 });
  block.commit();
  assert.match(pool.add(item, { now: T + 1500 }).reason, /already submitted/);
  assert.match(pool.add(item, { now: T + 2000 }).reason, /already submitted/, "exactly ttl × 2 is still blocked");
  assert.doesNotMatch(String(pool.add(item, { now: T + 2001 }).reason ?? ""), /already submitted/, "past ttl × 2 → not a duplicate (hits the nonce check instead)");
});

test("expired queued txs are cleaned up when a new tx arrives (no wait for a block) and recorded as expired", () => {
  const pool = new Mempool(setup(), { ttlMs: 1000 });
  assert.equal(pool.add(signed(0), { now: T }).ok, true);
  assert.equal(pool.size, 1);
  // nonce 0 has expired → a new nonce 0 tx (same price) is accepted, not treated as a replacement
  const fresh = pool.add(signed(0, 2), { now: T + 1001 });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal(pool.size, 1);
  assert.ok(pool.pendingRejections().some((r) => r.stage === "expired"));
});

test("light cleanup stops at the first unexpired entry: every seen tx is still blocked as a duplicate", () => {
  const vm = setup();
  const pool = new Mempool(vm);
  const items = [0, 1, 2].map((n) => signed(n));
  for (const item of items) assert.equal(pool.add(item, { now: T }).ok, true);
  const block = vm.createBlock({ timestamp: T + 1 });
  pool.take(block, { now: T + 1 });
  block.commit();
  for (const item of items) assert.match(pool.add(item, { now: T + 2 }).reason, /already submitted/);
});

test("block.hashes(): cached · changes when a tx runs or a rejected tx is recorded · matches the recomputation on replay", () => {
  const vm = setup({ recordHistory: true });
  const block = vm.createBlock({ timestamp: T });
  const empty = block.hashes();
  assert.deepEqual(block.hashes(), empty, "repeated calls give the same result");
  const first = block.hashes();
  first.hash = "mutated return value";
  assert.equal(block.hashes().hash, empty.hash, "the returned value is a copy");

  const { tx, signature } = signed(0);
  const verified = sign.verifyTransaction({ tx, signature });
  block[verified.method](verified.request);
  const afterTx = block.hashes();
  assert.notEqual(afterTx.hash, empty.hash);
  assert.notEqual(afterTx.stateRoot, empty.stateRoot);

  block.recordRejected({ hash: `0x${"ab".repeat(32)}`, sender: alice, stage: "sendtx", reason: "test" });
  const afterReject = block.hashes();
  assert.notEqual(afterReject.hash, afterTx.hash);
  assert.ok(afterReject.rejectedRoot);

  const header = block.header();
  assert.equal(header.hash, afterReject.hash);
  block.commit();
  assert.equal(vm.getBlock(header.number).hash, header.hash);
  assert.equal(vm.replayBlock(header.number, { verify: true }).hash, header.hash, "replay recomputes the same root");
});
