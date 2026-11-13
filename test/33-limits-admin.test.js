import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY, num } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN, COUNTER } from "./programs.js";

/* block limits (per block / per address / total gas) and team-signed init-reject */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const GAS = { ...API_GAS_ONLY, call: 100, read: 0, write: 0, stateKey: 0, byte: 0, price: 1 };

const ADMIN_KEY = sign.randomPrivateKey();
const admin = sign.addressOf(ADMIN_KEY);
const OUTSIDER_KEY = sign.randomPrivateKey();
const outsider = sign.addressOf(OUTSIDER_KEY);

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, gas: GAS, ...options,
  });
  vm.db.load({
    "alice:native:received": "1000000n",
    "bob:native:received": "1000000n",
    [`${admin}:native:received`]: "1000000n",
    [`${outsider}:native:received`]: "1000000n",
  });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1_000_000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  vm.commit(plain.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1000 }, context: user("alice") }).writes);
  return vm;
}

const send = (sender, nonce) => ({ programUuid: "token", functionName: "transfer", input: { to: "carol", amount: 1 }, context: user(sender), nonce });

// ---------------------------------------------------------------------------
//  per-block limits
// ---------------------------------------------------------------------------

test("limit: txs per block", () => {
  const vm = setup({ maxTransactions: 3 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });

  const results = [0, 1, 2, 3, 4].map((nonce) => block.call(send("alice", nonce)));
  assert.deepEqual(results.map((res) => res.status), ["success", "success", "success", "throw", "throw"]);
  assert.deepEqual(results.slice(3).map((res) => res.error.code), ["LIMIT_EXCEEDED", "LIMIT_EXCEEDED"]);
  assert.ok(results.slice(3).every((res) => res.accepted === false && res.writes.length === 0));

  block.commit();
  assert.equal(vm.getBlock(1).txCount, 3);
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], 3); // excess txs don't consume a nonce
});

test("limit: txs per address in a single block", () => {
  const vm = setup({ maxTransactionsPerSender: 2 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });

  assert.equal(block.call(send("alice", 0)).status, "success");
  assert.equal(block.call(send("alice", 1)).status, "success");
  const third = block.call(send("alice", 2));
  assert.equal(third.error.code, "LIMIT_EXCEEDED");
  assert.match(third.error.message, /per-block quota/);

  assert.equal(block.call(send("bob", 0)).status, "success"); // others can still send
  block.commit();
  assert.equal(vm.getBlock(1).txCount, 3);
});

test("limit: total block gas", () => {
  const vm = setup({ maxBlockGas: 250 }); // 1 tx uses 100 gas
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });

  assert.equal(block.call(send("alice", 0)).status, "success");
  assert.equal(block.call(send("alice", 1)).status, "success");
  const third = block.call(send("alice", 2));
  assert.equal(third.error.code, "LIMIT_EXCEEDED");
  assert.match(third.error.message, /block gas/);

  block.commit();
  assert.equal(vm.getBlock(1).gasUsed, 200);
});

test("limit: capacity() reports remaining quota, and checkTransaction rejects before running", () => {
  const vm = setup({ maxTransactions: 3, maxTransactionsPerSender: 2, maxBlockGas: 1000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });

  assert.deepEqual(block.capacity("alice"), { transactions: 3, perSender: 2, gas: 1000 });
  block.call(send("alice", 0));
  assert.deepEqual(block.capacity("alice"), { transactions: 2, perSender: 1, gas: 900 });

  block.call(send("alice", 1));
  assert.equal(block.checkTransaction(send("alice", 2)).ok, false);  // alice's quota is full
  assert.equal(block.checkTransaction(send("bob", 0)).ok, true);
});

test("limit: unset → unlimited (the original default)", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  for (let nonce = 0; nonce < 30; nonce += 1) block.call(send("alice", nonce));
  assert.equal(block.results().length, 30);
  assert.deepEqual(block.capacity("alice"), { transactions: Infinity, perSender: Infinity, gas: Infinity });
});

// ---------------------------------------------------------------------------
//  consecutive nonces within one block
// ---------------------------------------------------------------------------

test("nonce: several consecutive txs in one block are allowed, but no skipping numbers", () => {
  const vm = setup({ maxTransactionsPerSender: 16 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });

  for (let nonce = 0; nonce < 5; nonce += 1) assert.equal(block.call(send("alice", nonce)).status, "success");

  const skipped = block.call(send("alice", 6)); // skips 5
  assert.equal(skipped.accepted, false);
  assert.match(skipped.error.message, /invalid nonce: expected 5/);
  assert.equal(block.call(send("alice", 5)).status, "success"); // filling the gap makes it pass

  block.commit();
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], 6);
  assert.deepEqual(vm.listTransactionsOf("alice").map((tx) => tx.nonce), [5, 4, 3, 2, 1, 0]);
});

// ---------------------------------------------------------------------------
//  signed init / reject
// ---------------------------------------------------------------------------

const adminTx = (action, programUuid, nonce) => ({
  chainId: 1, action, from: admin, to: programUuid, method: "", input: {}, value: 0, nonce, gasLimit: 0, gasPrice: 0,
});

function submit(vm, tx, key) {
  const { method, request } = sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, key) });
  return vm[method](request, { timestamp: T });
}

test("admin: signed init — consumes a nonce, pays gas, and has its own hash", () => {
  const vm = setup({ admins: [admin] });
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 1 }, nonce: 0 }, { timestamp: T }).writes);

  const res = submit(vm, adminTx("init", "counter", 0), ADMIN_KEY);
  assert.equal(res.status, "success");
  assert.equal(res.result.state, "active");
  assert.ok(num(res.fee) > 0);
  vm.commit(res.writes);

  assert.equal(vm.db.readKeys([`${admin}:nonce`])[0], 1);
  assert.deepEqual(vm.listTransactionsOf(admin).map((tx) => tx.action), ["init"]);
  assert.equal(vm.nativeBalanceOf(admin).consumed, VM.readNative(res.fee));
});

test("admin: signed reject refunds the deployer as before", () => {
  const vm = setup({ admins: [admin] });
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), value: 500, nonce: 0 }, { timestamp: T }).writes);

  const res = submit(vm, adminTx("reject", "counter", 0), ADMIN_KEY);
  assert.equal(res.result.refund, "500n");
  vm.commit(res.writes);
  assert.equal(vm.nativeBalanceOf("counter").balance, 0n);
});

test("admin: someone not on the list cannot init", () => {
  const vm = setup({ admins: [admin] });
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), nonce: 0 }, { timestamp: T }).writes);

  const res = submit(vm, { ...adminTx("init", "counter", 0), from: outsider }, OUTSIDER_KEY);
  assert.equal(res.error.code, "FORBIDDEN");
  assert.match(res.error.message, /not authorized to init/);

  // a direct call without a signature also fails when an admin list is set
  assert.equal(vm.init({ programUuid: "counter" }).error.code, "FORBIDDEN");
});

test("admin: no list set → init can be called directly as before", () => {
  const vm = setup();
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), nonce: 0 }, { timestamp: T }).writes);
  assert.equal(vm.init({ programUuid: "counter" }, { timestamp: T }).status, "success");
});

test("admin: each init tx has a unique hash and is in the block as usual", () => {
  const vm = setup({ admins: [admin] });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "a", code: COUNTER, context: user("alice"), nonce: 0 });
  block.deploy({ programUuid: "b", code: COUNTER, context: user("alice"), nonce: 1 });

  const first = sign.verifyTransaction({ tx: adminTx("init", "a", 0), signature: sign.signTransaction(adminTx("init", "a", 0), ADMIN_KEY) });
  const second = sign.verifyTransaction({ tx: adminTx("init", "b", 1), signature: sign.signTransaction(adminTx("init", "b", 1), ADMIN_KEY) });
  block.init(first.request);
  block.init(second.request);
  block.commit();

  const header = vm.getBlock(1);
  assert.equal(header.txCount, 4);
  assert.equal(new Set(header.txHashes).size, 4);
  assert.deepEqual(vm.listTransactionsOf(admin).map((tx) => tx.nonce), [1, 0]);
  assert.deepEqual(header.txHashes.slice(2), [
    vm.hashTransaction(first.request, { action: "init" }),   // the tx hash (different from the signed digest)
    vm.hashTransaction(second.request, { action: "init" }),
  ]);
});
