import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN, COUNTER } from "./programs.js";

/* tx hash: computed only from the user's request, so it is known before sending, and failed txs have a hash too */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, ...options });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  vm.commit([{ type: "put", dbKey: "alice:native:received", value: "1000000n" }]);
  return vm;
}

const callTx = (nonce = 0, amount = 30) => ({
  programUuid: "token", functionName: "transfer", input: { to: "bob", amount }, context: user("alice"), nonce,
});

// ---------------------------------------------------------------------------
//  basic properties
// ---------------------------------------------------------------------------

test("hash: format 0x + 64 hex and the same value every time", () => {
  const vm = setup();
  const hash = vm.hashTransaction(callTx());
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(vm.hashTransaction(callTx()), hash);
});

test("hash: independent of field order", () => {
  const vm = setup();
  const a = { programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 30 }, context: { sender: "alice", origin: "alice" }, nonce: 0 };
  const b = { nonce: 0, context: { origin: "alice", sender: "alice" }, input: { amount: 30, to: "bob" }, functionName: "transfer", programUuid: "token" };
  assert.equal(vm.hashTransaction(a), vm.hashTransaction(b));
});

test("hash: addresses in different case give the same hash", () => {
  const vm = setup();
  const upper = { ...callTx(), programUuid: "TOKEN", context: user("ALICE") };
  assert.equal(vm.hashTransaction(upper), vm.hashTransaction(callTx()));
});

test("hash: any change gives a new hash", () => {
  const vm = setup();
  const base = vm.hashTransaction(callTx());
  const variants = [
    { ...callTx(), nonce: 1 },
    { ...callTx(), input: { to: "bob", amount: 31 } },
    { ...callTx(), functionName: "balanceOf" },
    { ...callTx(), programUuid: "other" },
    { ...callTx(), context: user("bob") },
    { ...callTx(), value: 1 },
    { ...callTx(), gasLimit: 5000 },
  ];
  const hashes = variants.map((request) => vm.hashTransaction(request));
  assert.equal(new Set([base, ...hashes]).size, variants.length + 1);
});

test("hash: different chainId → different hash (prevents cross-system replay)", () => {
  const one = setup({ chainId: 1 });
  const two = setup({ chainId: 2 });
  assert.notEqual(one.hashTransaction(callTx()), two.hashTransaction(callTx()));
});

test("hash: otherwise identical txs differ only by nonce", () => {
  const vm = setup();
  assert.notEqual(vm.hashTransaction(callTx(0)), vm.hashTransaction(callTx(1)));
});

test("hash: another hash function can be used (e.g. keccak256)", () => {
  const fake = (text) => `0x${createHash("sha512").update(text).digest("hex").slice(0, 64)}`;
  const vm = setup({ hashFunction: fake });
  assert.equal(vm.hashTransaction(callTx()), fake(VM.canonicalJson(vm.transactionPayload(callTx()))));
  assert.notEqual(vm.hashTransaction(callTx()), setup().hashTransaction(callTx()));
});

// ---------------------------------------------------------------------------
//  per action
// ---------------------------------------------------------------------------

test("hash: transfer / deploy / call use different payloads", () => {
  const vm = setup();
  const transfer = { from: "alice", to: "bob", amount: 100, nonce: 0 };
  assert.deepEqual(vm.transactionPayload(transfer), {
    chainId: 1, action: "transfer", from: "alice", to: "bob", amount: 100, nonce: 0, gasLimit: null, gasPrice: null,
  });
  assert.deepEqual(vm.transactionPayload(callTx(2)), {
    chainId: 1, action: "call", from: "alice", to: "token", method: "transfer",
    input: { to: "bob", amount: 30 }, value: 0, nonce: 2, gasLimit: null, gasPrice: null,
  });

  const deploy = { programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 1 }, nonce: 3, value: 50 };
  const payload = vm.transactionPayload(deploy);
  assert.equal(payload.action, "deploy");
  assert.equal(payload.code, VM.toOneLine(COUNTER)); // code is made one-line before hashing
  assert.deepEqual([payload.from, payload.to, payload.value, payload.nonce], ["alice", "counter", 50, 3]);
});

test("hash: deploys whose code differs only in line endings (CRLF) get the same hash", () => {
  const vm = setup();
  const make = (code) => ({ programUuid: "counter", code, context: user("alice"), nonce: 0 });
  assert.equal(vm.hashTransaction(make(COUNTER)), vm.hashTransaction(make(COUNTER.replace(/\n/g, "\r\n"))));
});

test("hash: init / reject use blockNumber + index because they have no nonce", () => {
  const vm = setup();
  const request = { programUuid: "counter" };
  const first = vm.hashTransaction(request, { action: "init", blockNumber: 10, index: 0 });
  assert.notEqual(first, vm.hashTransaction(request, { action: "init", blockNumber: 10, index: 1 }));
  assert.notEqual(first, vm.hashTransaction(request, { action: "init", blockNumber: 11, index: 0 }));
  assert.notEqual(first, vm.hashTransaction(request, { action: "reject", blockNumber: 10, index: 0 }));
});

test("hash: infers the action from the request's shape", () => {
  const vm = setup();
  assert.equal(vm.transactionPayload({ from: "a", to: "b", amount: 1 }).action, "transfer");
  assert.equal(vm.transactionPayload({ programUuid: "p", code: "x", context: user("a") }).action, "deploy");
  assert.equal(vm.transactionPayload(callTx()).action, "call");
});

// ---------------------------------------------------------------------------
//  hash in the receipt
// ---------------------------------------------------------------------------

test("receipt: hash matches the one computed before sending, for both successful and failed txs", () => {
  const vm = setup();
  const good = callTx(0);
  const bad = callTx(1, 99999);
  const expected = [vm.hashTransaction(good), vm.hashTransaction(bad)];

  const block = vm.createBlock({ timestamp: T });
  block.call(good);
  block.call(bad);

  const receipt = block.receipt({ number: 5 });
  assert.deepEqual(receipt.transactions.map((tx) => tx.hash), expected);
  assert.deepEqual(receipt.transactions.map((tx) => tx.status), ["success", "throw"]);
});

test("receipt: a tx rejected for a wrong nonce still has a hash", () => {
  const vm = setup();
  const request = callTx(9);
  const result = vm.call(request, { timestamp: T });
  assert.equal(result.error.code, "INVALID_REQUEST");
  assert.equal(vm.buildReceipt(request, result).hash, vm.hashTransaction(request));
});

test("receipt: every tx hash in a block is unique", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call(callTx(0, 1));
  block.call(callTx(1, 1));             // identical except for nonce
  block.transfer({ from: "alice", to: "carol", amount: 1, nonce: 2 });
  block.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), nonce: 3 });
  block.init({ programUuid: "counter" });
  block.reject({ programUuid: "counter" });

  const hashes = block.receipt({ number: 12 }).transactions.map((tx) => tx.hash);
  assert.equal(new Set(hashes).size, hashes.length);
  assert.ok(hashes.every((hash) => /^0x[0-9a-f]{64}$/.test(hash)));
});

test("receipt: same hash when re-running the block with the same requests", () => {
  const first = setup();
  const second = setup();
  const requests = [callTx(0, 5), callTx(1, 6)];
  const run = (vm) => {
    const block = vm.createBlock({ timestamp: T });
    for (const request of requests) block.call(request);
    return block.receipt({ number: 1 }).transactions.map((tx) => tx.hash);
  };
  assert.deepEqual(run(first), run(second));
});

test("canonicalJson: sorts keys and skips undefined", () => {
  assert.equal(VM.canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(VM.canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(VM.canonicalJson([1, "a", null, { z: 1, y: 2 }]), '[1,"a",null,{"y":2,"z":1}]');
  assert.equal(VM.canonicalJson(undefined), "null");
  assert.equal(VM.canonicalJson("中文 🎉"), JSON.stringify("中文 🎉"));   // non-ASCII is intentional: tests Unicode handling
});

test("hash: addresses inside input are normalized before hashing too", () => {
  const vm = setup();
  const lower = { ...callTx(), input: { to: "0xfabb0ac9", amount: 30 } };
  const upper = { ...callTx(), input: { to: "0xFABB0Ac9", amount: 30 } };
  assert.equal(vm.hashTransaction(lower), vm.hashTransaction(upper));
});
