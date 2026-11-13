import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { applyBlock, syncOnce } from "../src/node/sync.js";
import { TOKEN } from "./programs.js";

/* reader node: fetches blocks, runs them itself, then compares hashes */

const T = Date.parse("2025-01-01T00:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const GENESIS = { chainId: 1, balances: { alice: 1_000_000 } };
const OPTIONS = { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true };

function producer() {
  const vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  vm.applyGenesis(GENESIS);
  const first = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  first.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 });
  first.init({ programUuid: "token" });
  first.commit();
  for (let i = 0; i < 3; i += 1) {
    const block = vm.createBlock({ timestamp: T + (i + 1) * 3000, feeRecipient: "miner" });
    block.call({ programUuid: "token", functionName: "transfer", input: { to: `user${i}`, amount: 10 }, context: user("alice"), nonce: i + 1 });
    block.commit();
  }
  return vm;
}

const feed = (source) => async (from, limit) => {
  const blocks = [];
  for (let n = from; n <= Math.min(source.latestBlockNumber(), from + limit - 1); n += 1) {
    blocks.push({ header: source.getBlock(n), body: source.getBlockBody(n) });
  }
  return blocks;
};

const reader = () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  vm.applyGenesis(GENESIS);
  return vm;
};

test("sync: fetching and running blocks gives state identical to the producer, byte for byte", async () => {
  const source = producer();
  const target = reader();
  assert.equal(await syncOnce(target, feed(source)), 4);

  assert.equal(target.latestBlockNumber(), source.latestBlockNumber());
  assert.deepEqual(target.db.snapshot(), source.db.snapshot());
});

test("sync: resumes syncing from where it stopped", async () => {
  const source = producer();
  const target = reader();
  await syncOnce(target, async (from, limit) => (await feed(source)(from, limit)).slice(0, 2));
  assert.equal(target.latestBlockNumber(), 2);

  await syncOnce(target, feed(source));
  assert.deepEqual(target.db.snapshot(), source.db.snapshot());
});

test("sync: tampered block → stops immediately, saves nothing", () => {
  const source = producer();
  const target = reader();
  const item = { header: { ...source.getBlock(1) }, body: source.getBlockBody(1) };
  item.body[0].request.initInput = { supply: 999 };       // tamper with a tx in transit

  assert.throws(() => applyBlock(target, item), /does not match the producer/);
  assert.equal(target.latestBlockNumber(), null);
});

test("genesis: mismatch → rejected before syncing", () => {
  const vm = reader();
  assert.equal(vm.genesisHash(), vm.hashData(GENESIS));
  assert.deepEqual(vm.applyGenesis(GENESIS), { hash: vm.genesisHash(), applied: false });   // repeatable, changes nothing
  assert.throws(() => vm.applyGenesis({ chainId: 1, balances: { alice: 999 } }), { code: "INTERNAL", message: /genesis mismatch/ });
  assert.equal(vm.nativeBalanceOf("alice").balance, 1_000_000n);
});

test("timeout: a timed-out tx does not enter the block (so results do not depend on machine speed)", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, chargeGas: false, timeoutMs: 50, maxTxGas: Infinity });   // no gas cap → stopped by time (with gas it runs out of gas first, see 53-gas-meter)
  vm.applyGenesis(GENESIS);
  const code = "function program() {\n  function spin() { while (true) {} }\n  return { spin }\n}";
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "spin", code, context: user("alice"), nonce: 0 });
  block.init({ programUuid: "spin" });
  const timedOut = block.call({ programUuid: "spin", functionName: "spin", context: user("alice"), nonce: 1 });
  block.commit();

  assert.equal(timedOut.error.code, "TIMEOUT");
  assert.equal(timedOut.accepted, false);        // not in the block
  assert.deepEqual(timedOut.writes, []);         // uses no nonce, pays no gas
  assert.equal(vm.getBlock(1).txCount, 2);       // only deploy and init
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], 1);
});

test("V8 errors are replaced with a fixed message (same result on every Node version)", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  const code = `function program() {
  function typeError() { return null.x }
  function ownError() { throw new Error("the program's own message") }
  return { typeError, ownError }
}`;
  vm.commit(vm.deploy({ programUuid: "p", code, context: user("alice") }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "p" }, { timestamp: T }).writes);

  const call = (fn) => vm.call({ programUuid: "p", functionName: fn, context: user("alice") }, { timestamp: T });
  assert.equal(call("typeError").error.message, "program error (TypeError)");
  assert.equal(call("ownError").error.message, "the program's own message");   // the program's own errors are unchanged
});
