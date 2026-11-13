import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, mockData, resetVM, user, ok, activate, trace, stored } from "./helpers.js";
import { TOKEN, SHOP, COUNTER, PROBE, FAULTY } from "./programs.js";

beforeEach(() => {
  resetVM();
  activate("token", TOKEN, { initInput: { supply: 1000 } });
  ok(vm.call({ programUuid: "token", functionName: "transfer", input: { to: "alice", amount: 100 }, context: user("owner") }));
});

const transfer = (from, to, amount) => ({ programUuid: "token", functionName: "transfer", input: { to, amount }, context: user(from) });

/** saves the block's writes to the DB via db.writeKeys */
const commit = (block) => block.commit();

test("block: tx2 sees tx1's effects before they reach the DB", () => {
  const block = vm.createBlock();
  const tx1 = block.call(transfer("alice", "bob", 30));
  const tx2 = block.call(transfer("alice", "jane", 50));

  assert.equal(tx1.status, "success");
  assert.equal(tx2.status, "success");
  assert.deepEqual(tx2.loadValues[0], { dbKey: "token:storage:balances:alice", loadValue: "70n" }); // value after tx1
  assert.equal(stored("token", "balances", "alice"), "100n"); // DB not changed yet

  commit(block);
  assert.equal(stored("token", "balances", "alice"), "20n");
  assert.equal(stored("token", "balances", "bob"), "30n");
  assert.equal(stored("token", "balances", "jane"), "50n");
});

test("block: writes merge to 1 entry per key (final value), in the order keys were first written", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("alice", "jane", 50));
  block.call(transfer("bob", "alice", 10));

  assert.deepEqual(block.writes(), [
    { type: "put", dbKey: "token:storage:balances:alice", value: "30n" },
    { type: "put", dbKey: "token:storage:balances:bob", value: "20n" },
    { type: "put", dbKey: "token:storage:balances:jane", value: "50n" },
  ]);
});

test("block: a throwing tx does not affect the block, and the next tx still works", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 60));
  const failed = block.call(transfer("alice", "jane", 60)); // 40 left, not enough
  const after = block.call(transfer("alice", "jane", 40));

  assert.equal(failed.status, "throw");
  assert.equal(failed.error.message, "ยอดไม่พอ");
  assert.equal(after.status, "success");
  assert.deepEqual(block.results().map((r) => r.status), ["success", "throw", "success"]);

  commit(block);
  assert.equal(stored("token", "balances", "alice"), "0n");
  assert.equal(stored("token", "balances", "jane"), "40n");
});

test("block: no successful tx → empty writes", () => {
  const block = vm.createBlock();
  block.call(transfer("nobody", "bob", 1));
  assert.deepEqual(block.writes(), []);
});

test("block: deploy → init → call in one block", () => {
  const block = vm.createBlock();
  assert.equal(block.deploy({ programUuid: "counter", code: COUNTER, context: user("a"), initInput: { start: 5 } }).status, "success");
  assert.equal(block.init({ programUuid: "counter" }).status, "success");
  const res = block.call({ programUuid: "counter", functionName: "add", input: { amount: 1 }, context: user("a") });
  assert.equal(res.result, "6n");
  assert.equal(mockData.has("counter:code"), false);

  const writes = block.writes();
  assert.deepEqual(writes.map((w) => `${w.type} ${w.dbKey}`), [
    "del pending:counter",
    "put counter:storage:count",
    "put counter:code",
    "put counter:context",
    "put counter:this",
"put counter:metadata:type",
"put counter:metadata:creator",
"put counter:metadata:createdAt",
  ]);
  commit(block);
  assert.equal(mockData.has("pending:counter"), false);
  assert.equal(stored("counter", "count"), "6n");
});

test("block: no duplicate deploy id in the same block / no init after reject", () => {
  const block = vm.createBlock();
  block.deploy({ programUuid: "p", code: COUNTER, context: user("a") });
  assert.equal(block.deploy({ programUuid: "p", code: COUNTER, context: user("a") }).error.code, "INVALID_REQUEST");
  block.reject({ programUuid: "p" });
  assert.equal(block.init({ programUuid: "p" }).error.code, "NOT_FOUND");
  assert.deepEqual(block.writes(), [{ type: "del", dbKey: "pending:p" }]);
});

test("block: delete in one tx, then the next tx reads undefined and can write again", () => {
  activate("counter", COUNTER, { initInput: { start: 3 } });
  const block = vm.createBlock();
  block.call({ programUuid: "counter", functionName: "reset", context: user("a") });
  const get = block.call({ programUuid: "counter", functionName: "get", context: user("a") });
  assert.equal(get.result, "0n");
  assert.deepEqual(block.writes(), [{ type: "del", dbKey: "counter:storage:count" }]);

  block.call({ programUuid: "counter", functionName: "add", input: { amount: 2 }, context: user("a") });
  assert.deepEqual(block.writes(), [{ type: "put", dbKey: "counter:storage:count", value: "2n" }]);
});

test("block: cross-program over several txs (approve, then buy)", () => {
  activate("shop", SHOP, { initInput: { shopId: "shop", token: "token", price: 30 } });
  const block = vm.createBlock();
  block.call({ programUuid: "token", functionName: "approve", input: { spender: "shop", amount: 100 }, context: user("alice") });
  const buys = [1, 2, 3, 4].map(() => block.call({ programUuid: "shop", functionName: "buy", context: user("alice") }));

  assert.deepEqual(buys.map((r) => r.status), ["success", "success", "success", "throw"]);
  assert.deepEqual(trace(buys[3]), ["0:shop.buy:throw:PROGRAM_ERROR", "1:token.transferFrom:throw:PROGRAM_ERROR"]);

  commit(block);
  assert.equal(stored("token", "balances", "alice"), "10n");
  assert.equal(stored("token", "balances", "shop"), "90n");
  assert.equal(stored("shop", "sales"), "3n");
});

test("block: one tx's timeout does not affect other txs (each tx has its own time budget)", () => {
  activate("faulty", FAULTY);
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  const spin = block.call({ programUuid: "faulty", functionName: "spin", context: user("a") });
  block.call(transfer("alice", "bob", 10));
  assert.equal(spin.error.code, "TIMEOUT");
  assert.deepEqual(block.writes().find((w) => w.dbKey === "token:storage:balances:bob"), { type: "put", dbKey: "token:storage:balances:bob", value: "20n" });
});

test("block: values from writes() / results() are copies — modifying them does not affect the block", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  block.writes()[0].value = 999;
  block.results().pop();
  assert.equal(block.writes()[0].value, "90n");
  assert.equal(block.results().length, 1);
});

test("block: DB fails mid-block → that tx is INTERNAL, earlier txs stay in the block", () => {
  let down = false;
  const block = vm.createBlock({ read: (dbKey) => { if (down) throw new Error("db down"); return mockData.get(dbKey); } });
  block.call(transfer("alice", "bob", 10));
  down = true;
  const failed = block.call(transfer("alice", "jane", 10));
  assert.equal(failed.error.code, "INTERNAL");
  assert.equal(block.writes().length, 2);
});

test("block: programs in different blocks are separate (blocks share no state)", () => {
  const a = vm.createBlock();
  const b = vm.createBlock();
  a.call(transfer("alice", "bob", 100));
  const res = b.call(transfer("alice", "jane", 100));
  assert.equal(res.status, "success"); // b still sees alice's balance = 100 from the DB
});

test("block: results are identical every time", () => {
  activate("probe", PROBE);
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const block = vm.createBlock({ timestamp: 1_700_000_000_000 });
    block.call(transfer("alice", "bob", 30));
    block.call(transfer("alice", "jane", 80));
    block.call({ programUuid: "probe", functionName: "relayCatch", input: { target: "token", fn: "transfer", args: { to: "x", amount: 1 } }, context: user("alice") });
    block.call(transfer("bob", "jane", 30));
    runs.push(JSON.stringify({ results: block.results(), writes: block.writes() }));
  }
  assert.equal(new Set(runs).size, 1);
});

test("block.commit: saves once and closes the block — no further use or repeated commit", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  assert.equal(block.committed, false);
  const trieNodes = vm.trieUpdate(block.writes()).writes.length;   // + trie nodes (stateRoot) in the same commit
  assert.equal(block.commit(), 2 + trieNodes);
  assert.equal(block.committed, true);
  assert.equal(stored("token", "balances", "bob"), "10n");

  assert.throws(() => block.commit(), { code: "INVALID_REQUEST", message: "block นี้ commit ไปแล้ว" });
  assert.throws(() => block.call(transfer("alice", "bob", 1)), { code: "INVALID_REQUEST" });
});

test("block.commit: writeKeys fails → the block stays open and commit can be retried", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  const original = vm.db.writeKeys;
  vm.db.writeKeys = () => { throw new Error("network error"); };
  try {
    assert.throws(() => block.commit(), /network error/);
  } finally {
    vm.db.writeKeys = original;
  }
  assert.equal(block.committed, false);
  block.commit();
  assert.equal(stored("token", "balances", "bob"), "10n");
});

// ---------------------------------------------------------------------------
//  block-level storage data
// ---------------------------------------------------------------------------

test("block: loadValues / afterValues for the whole block (values before the block → values after the whole block)", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("alice", "jane", 50));

  assert.deepEqual(block.loadValues(), [
    { dbKey: "token:storage:balances:alice", loadValue: "100n" },
    { dbKey: "token:storage:balances:bob", loadValue: undefined },
    { dbKey: "token:storage:balances:jane", loadValue: undefined },
  ]);
  assert.deepEqual(block.afterValues(), [
    { dbKey: "token:storage:balances:alice", afterValue: "20n", changed: true },
    { dbKey: "token:storage:balances:bob", afterValue: "30n", changed: true },
    { dbKey: "token:storage:balances:jane", afterValue: "50n", changed: true },
  ]);
});

test("block: a value changed and then changed back within the block → changed false", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("bob", "alice", 30));

  assert.deepEqual(block.afterValues(), [
    { dbKey: "token:storage:balances:alice", afterValue: "100n", changed: false },
    { dbKey: "token:storage:balances:bob", afterValue: "0n", changed: true }, // key did not exist before → 0
  ]);
  assert.equal(block.writes().length, 2);
});

test("block: a key read after an earlier tx wrote it → loadValue is still the DB value from before the block", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call({ programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("x") });

  const results = block.results();
  assert.equal(results[1].result, "70n");
  assert.deepEqual(results[1].loadValues, [{ dbKey: "token:storage:balances:alice", loadValue: "70n" }]); // call level: before this call
  assert.deepEqual(block.loadValues()[0], { dbKey: "token:storage:balances:alice", loadValue: "100n" });  // block level: before the block
});

test("block: throwing txs are not counted in the block's loadValues / afterValues", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("carol", "dave", 1)); // carol has no balance → throw

  const keys = (list) => list.map((v) => v.dbKey);
  assert.deepEqual(keys(block.loadValues()), ["token:storage:balances:alice", "token:storage:balances:bob"]);
  assert.deepEqual(keys(block.afterValues()), ["token:storage:balances:alice", "token:storage:balances:bob"]);
});

test("block: read only → changed false and no writes", () => {
  const block = vm.createBlock();
  block.call({ programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("x") });
  assert.deepEqual(block.afterValues(), [{ dbKey: "token:storage:balances:alice", afterValue: "100n", changed: false }]);
  assert.deepEqual(block.writes(), []);
});

test("block: a key deleted over the whole block → afterValue undefined", () => {
  activate("counter", COUNTER, { initInput: { start: 3 } });
  const block = vm.createBlock();
  block.call({ programUuid: "counter", functionName: "add", input: { amount: 1 }, context: user("a") });
  block.call({ programUuid: "counter", functionName: "reset", context: user("a") });
  assert.deepEqual(block.afterValues(), [{ dbKey: "counter:storage:count", afterValue: undefined, changed: true }]);
  assert.deepEqual(block.loadValues(), [{ dbKey: "counter:storage:count", loadValue: "3n" }]);
});

test("block: summary() combines results / loadValues / afterValues / writes", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  const summary = block.summary();
  assert.deepEqual(Object.keys(summary), ["timestamp", "results", "loadValues", "afterValues", "writes"]);
  assert.deepEqual(summary.writes, block.writes());
});

test("block: each key is read from the DB once per block (every tx sees the same data)", () => {
  const reads = [];
  const block = vm.createBlock({ read: (dbKey) => { reads.push(dbKey); return mockData.get(dbKey); } });
  const balanceOf = { programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("x") };
  block.call(balanceOf);
  block.call(balanceOf);
  block.call(transfer("alice", "bob", 1));
  block.call(balanceOf);
  assert.deepEqual(reads, ["token:code", "token:storage:balances:alice", "token:storage:balances:bob"]);
});
