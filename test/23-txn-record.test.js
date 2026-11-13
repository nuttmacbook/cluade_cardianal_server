import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VM, MemoryDB, num } from "./helpers.js";
import { TOKEN, COUNTER } from "./programs.js";

/* keccak256 + tx records written to the DB: <address>:txn:<nonce>:<txhash> */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    recordTransactions: true, requireNonce: true, chargeGas: true,
    gas: { call: 100, read: 10, write: 50, byte: 0, price: 1 }, ...options,
  });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  vm.commit([{ type: "put", dbKey: "alice:native:received", value: "1000000n" }]);
  return vm;
}

const callTx = (nonce, amount = 30) => ({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount }, context: user("alice"), nonce });
const txnWrites = (res) => res.writes.filter((w) => w.dbKey.includes(":txn:"));

// ---------------------------------------------------------------------------
//  keccak256
// ---------------------------------------------------------------------------

test("hash: keccak256 is the default (matches EVM)", () => {
  assert.equal(VM.keccak256Hex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(VM.keccak256Hex("hello"), `0x${Buffer.from(keccak_256(new TextEncoder().encode("hello"))).toString("hex")}`);

  const vm = setup();
  const request = callTx(0);
  assert.equal(vm.hashTransaction(request), VM.keccak256Hex(VM.canonicalJson(vm.transactionPayload(request))));
});

// ---------------------------------------------------------------------------
//  tx records
// ---------------------------------------------------------------------------

test("txn: a successful tx writes <address>:txn:<nonce>:<hash>", () => {
  const vm = setup();
  const request = callTx(0);
  const hash = vm.hashTransaction(request);
  const res = vm.call(request, { timestamp: T });

  assert.deepEqual(txnWrites(res), [{
    type: "put",
    dbKey: `alice:txn:0:${hash}`,
    value: { hash, action: "call", nonce: 0, status: "success", error: null, timestamp: T, gasUsed: res.gasUsed, fee: res.fee },
  }]);
  vm.commit(res.writes);
  assert.equal(vm.db.readKeys([`alice:txn:0:${hash}`])[0].status, "success");
});

test("txn: a failed tx is recorded too, with the reason", () => {
  const vm = setup();
  const request = callTx(0, 99999);
  const res = vm.call(request, { timestamp: T });
  const record = txnWrites(res)[0].value;

  assert.equal(res.status, "throw");
  assert.equal(record.status, "throw");
  assert.deepEqual(record.error, { code: "PROGRAM_ERROR", message: "ยอดไม่พอ" });
  assert.equal(record.hash, vm.hashTransaction(request));
  assert.ok(num(record.fee) > 0);
});

test("txn: wrong nonce → nothing recorded", () => {
  const vm = setup();
  const res = vm.call(callTx(9), { timestamp: T });
  assert.equal(res.error.code, "INVALID_REQUEST");
  assert.deepEqual(res.writes, []);
});

test("txn: deploy / transfer are recorded too, but init / reject are not (no user address)", () => {
  const vm = setup();
  const deployed = vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 1 }, nonce: 0 }, { timestamp: T });
  assert.equal(txnWrites(deployed)[0].value.action, "deploy");
  vm.commit(deployed.writes);

  const initialized = vm.init({ programUuid: "counter" }, { timestamp: T });
  assert.deepEqual(txnWrites(initialized), []);
  vm.commit(initialized.writes);

  const transferred = vm.transfer({ from: "alice", to: "carol", amount: 10, nonce: 1 }, { timestamp: T });
  assert.equal(txnWrites(transferred)[0].value.action, "transfer");
  assert.equal(txnWrites(transferred)[0].dbKey, `alice:txn:1:${vm.hashTransaction({ from: "alice", to: "carol", amount: 10, nonce: 1 })}`);
});

test("txn: keys sort by nonce — an address's txs can be walked by prefix", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(callTx(0, 1));
  block.call(callTx(1, 99999)); // fails
  block.transfer({ from: "alice", to: "carol", amount: 5, nonce: 2 });
  block.commit();

  const keys = [...vm.db.data.keys()].filter((key) => key.startsWith("alice:txn:")).sort();
  assert.deepEqual(keys.map((key) => VM.decodeDbKey(key).nonce), [0, 1, 2]);
  assert.deepEqual(keys.map((key) => vm.db.readKeys([key])[0].status), ["success", "throw", "success"]);
  assert.deepEqual(keys.map((key) => vm.db.readKeys([key])[0].action), ["call", "call", "transfer"]);
});

test("txn: decodeDbKey parses tx record keys", () => {
  const hash = VM.keccak256Hex("x");
  assert.deepEqual(VM.decodeDbKey(`0xabc:txn:7:${hash}`), { kind: "txn", address: "0xabc", nonce: 7, hash });
});

test("txn: recordTransactions off (default) → no such key", () => {
  const vm = setup({ recordTransactions: false });
  const res = vm.call(callTx(0), { timestamp: T });
  assert.deepEqual(txnWrites(res), []);
});

test("txn: records even with nonce and gas fees off (nonce counted from the DB)", () => {
  const vm = setup({ requireNonce: false, chargeGas: false });
  const request = { programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice") };
  const res = vm.call(request, { timestamp: T });

  assert.deepEqual(txnWrites(res)[0].dbKey, `alice:txn:0:${vm.hashTransaction(request)}`);
  assert.equal(res.writes.some((w) => w.dbKey === "alice:nonce"), false); // requireNonce is off, so no nonce is written
});

test("txn: in a block, included in the block's writes", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call(callTx(0, 1));
  block.call(callTx(1, 2));

  const records = block.writes().filter((w) => w.dbKey.includes(":txn:"));
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((w) => w.value.nonce), [0, 1]);

  // not mixed into the receipt's stateChanges / nativeChanges
  const receipt = block.receipt({ number: 3 });
  assert.equal(receipt.stateChanges.some((c) => c.program === "alice"), false);
  assert.deepEqual(receipt.transactions.map((tx) => tx.hash), records.map((w) => w.value.hash));
});

test("txn: the record's hash matches the receipt's hash", () => {
  const vm = setup();
  const request = callTx(0);
  const result = vm.call(request, { timestamp: T });
  assert.equal(vm.buildReceipt(request, result).hash, txnWrites(result)[0].value.hash);
});
