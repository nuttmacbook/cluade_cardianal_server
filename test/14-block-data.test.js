import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN, SHOP, PROBE, COUNTER } from "./programs.js";

/*
 * tests block-level data: results / loadValues / afterValues / writes / timestamp
 * each test uses its own VM + DB (unique endpoint)
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const bal = (account) => `token:storage:balances:${account}`;

let endpointCounter = 0;

/** a fresh VM with token (owner 1000, alice 100) and shop (price 30) ready */
function setup({ aliceBalance = 100 } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const block = vm.createBlock({ timestamp: T - 1000 });
  block.deploy({ programUuid: "token", code: TOKEN, context: user("owner"), initInput: { supply: 1000 } });
  block.init({ programUuid: "token" });
  block.deploy({ programUuid: "shop", code: SHOP, context: user("owner"), initInput: { shopId: "shop", token: "token", price: 30 } });
  block.init({ programUuid: "shop" });
  block.deploy({ programUuid: "probe", code: PROBE, context: user("owner") });
  block.init({ programUuid: "probe" });
  if (aliceBalance) block.call(transfer("owner", "alice", aliceBalance));
  assert.ok(block.results().every((r) => r.status === "success"));
  block.commit();
  return vm;
}

const transfer = (from, to, amount) => ({ programUuid: "token", functionName: "transfer", input: { to, amount }, context: user(from) });
const approve = (owner, spender, amount) => ({ programUuid: "token", functionName: "approve", input: { spender, amount }, context: user(owner) });
const buy = (buyer, fn = "buy") => ({ programUuid: "shop", functionName: fn, context: user(buyer) });

const readDb = (vm, keys) => Object.fromEntries(keys.map((key, i) => [key, vm.db.readKeys(keys)[i]]));

// ---------------------------------------------------------------------------
//  full data shape
// ---------------------------------------------------------------------------

test("full summary: 2 successful txs + 1 failed tx", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("alice", "jane", 50));
  block.call(transfer("alice", "bob", 999));

  const record = (status, error) => ({
    depth: 0, programUuid: "token", functionName: "transfer", sender: "alice", origin: "alice", status, ...(error && { error }),
  });

  const summary = block.summary();
  for (const result of summary.results) {
    assert.equal(typeof result.gasUsed, "number");   // gas is always counted, even with gas charging off
    assert.equal(result.fee, "0n");
    assert.equal(result.accepted, true);
    delete result.gasUsed;
    delete result.fee;
    delete result.accepted;
    delete result.gasPrice;
    assert.deepEqual([result.baseFee, result.burnedFee, result.producerFee], ["1n", "0n", "0n"]);   // no gas charged → nothing burned
    delete result.baseFee;
    delete result.burnedFee;
    delete result.producerFee;
    assert.deepEqual(result.events, []);
    delete result.events;
    delete result.debug;
    for (const call of result.calls) {   // each call's input / value / result / gas is tested separately in 16-transfer-flow
      assert.equal(call.input.from ?? "alice", "alice");
      assert.equal(typeof call.gasUsed, "number");
      for (const field of ["input", "value", "gasStart", "result", "gasUsed"]) delete call[field];
    }
  }
  assert.deepEqual(summary, {
    timestamp: T,
    results: [
      {
        status: "success",
        timestamp: T,
        result: { from: "alice", to: "bob", amount: "30n" },
        calls: [record("success")],
        loadValues: [{ dbKey: bal("alice"), loadValue: "100n" }, { dbKey: bal("bob"), loadValue: undefined }],
        afterValues: [{ dbKey: bal("alice"), afterValue: "70n", changed: true }, { dbKey: bal("bob"), afterValue: "30n", changed: true }],
        writes: [{ type: "put", dbKey: bal("alice"), value: "70n" }, { type: "put", dbKey: bal("bob"), value: "30n" }],
      },
      {
        status: "success",
        timestamp: T,
        result: { from: "alice", to: "jane", amount: "50n" },
        calls: [record("success")],
        loadValues: [{ dbKey: bal("alice"), loadValue: "70n" }, { dbKey: bal("jane"), loadValue: undefined }],
        afterValues: [{ dbKey: bal("alice"), afterValue: "20n", changed: true }, { dbKey: bal("jane"), afterValue: "50n", changed: true }],
        writes: [{ type: "put", dbKey: bal("alice"), value: "20n" }, { type: "put", dbKey: bal("jane"), value: "50n" }],
      },
      {
        status: "throw",
        timestamp: T,
        error: { code: "PROGRAM_ERROR", message: "insufficient balance" },
        calls: [record("throw", { code: "PROGRAM_ERROR", message: "insufficient balance" })],
        writes: [],
      },
    ],
    loadValues: [
      { dbKey: bal("alice"), loadValue: "100n" },
      { dbKey: bal("bob"), loadValue: undefined },
      { dbKey: bal("jane"), loadValue: undefined },
    ],
    afterValues: [
      { dbKey: bal("alice"), afterValue: "20n", changed: true },
      { dbKey: bal("bob"), afterValue: "30n", changed: true },
      { dbKey: bal("jane"), afterValue: "50n", changed: true },
    ],
    writes: [
      { type: "put", dbKey: bal("alice"), value: "20n" },
      { type: "put", dbKey: bal("bob"), value: "30n" },
      { type: "put", dbKey: bal("jane"), value: "50n" },
    ],
  });
});

test("empty block", () => {
  const vm = setup();
  assert.deepEqual(vm.createBlock({ timestamp: T }).summary(), { timestamp: T, results: [], loadValues: [], afterValues: [], writes: [] });
});

test("every tx fails → only results", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(transfer("nobody", "bob", 1));
  block.call({ programUuid: "missing", functionName: "x", context: user("a") });
  const summary = block.summary();
  assert.deepEqual(summary.results.map((r) => r.error.code), ["PROGRAM_ERROR", "NOT_FOUND"]);
  assert.deepEqual([summary.loadValues, summary.afterValues, summary.writes], [[], [], []]);
});

// ---------------------------------------------------------------------------
//  relations between the data (must always hold)
// ---------------------------------------------------------------------------

/** checks block invariants against the DB before and after commit */
function assertBlockInvariants(vm, block) {
  const summary = block.summary();
  const storageWrites = summary.writes.filter((w) => w.dbKey.includes(":storage:"));
  const touched = new Set(summary.afterValues.map((v) => v.dbKey));
  const allKeys = [...new Set([...summary.loadValues.map((v) => v.dbKey), ...touched, ...summary.writes.map((w) => w.dbKey)])];
  const dbBefore = readDb(vm, allKeys);

  // 1) loadValue = the DB value before the block
  for (const { dbKey, loadValue } of summary.loadValues) assert.deepEqual(loadValue, dbBefore[dbKey], `loadValue ${dbKey}`);

  // 2) every read key must also be in afterValues
  for (const { dbKey } of summary.loadValues) assert.ok(touched.has(dbKey), `loadValues ⊆ afterValues: ${dbKey}`);

  // 3) changed = the DB value before the block ≠ afterValue
  for (const { dbKey, afterValue, changed } of summary.afterValues) {
    assert.equal(changed, JSON.stringify(dbBefore[dbKey]) !== JSON.stringify(afterValue), `changed ${dbKey}`);
  }

  // 4) every changed key must be in writes, every storage write must be in afterValues
  const writeKeys = new Set(summary.writes.map((w) => w.dbKey));
  for (const { dbKey, changed } of summary.afterValues) if (changed) assert.ok(writeKeys.has(dbKey), `changed → write: ${dbKey}`);
  for (const { dbKey } of storageWrites) assert.ok(touched.has(dbKey), `storage write → afterValues: ${dbKey}`);

  // 5) writes have 1 entry per key
  assert.equal(writeKeys.size, summary.writes.length);

  // 6) results cover every tx and timestamps match
  assert.ok(summary.results.every((r) => r.timestamp === summary.timestamp));

  // 7) after commit: DB = afterValues for every key
  block.commit();
  const dbAfter = readDb(vm, allKeys);
  for (const { dbKey, afterValue } of summary.afterValues) assert.deepEqual(dbAfter[dbKey], afterValue, `after commit ${dbKey}`);
  for (const write of summary.writes) assert.deepEqual(dbAfter[write.dbKey], write.type === "del" ? undefined : write.value, `write ${write.dbKey}`);
}

test("invariant: multi-hop transfers", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("bob", "carol", 10));
  block.call(transfer("carol", "alice", 10));
  block.call(transfer("dave", "alice", 5)); // fails
  assertBlockInvariants(vm, block);
});

test("invariant: cross-program (approve → shop.buy via token.transferFrom)", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(approve("alice", "shop", 70));
  block.call(buy("alice"));
  block.call(buy("alice"));
  block.call(buy("alice")); // allowance down to 10 → the whole tx fails
  block.call(buy("alice", "buySafe")); // fails but caught → shop records failed

  const summary = block.summary();
  assert.deepEqual(summary.results.map((r) => r.status), ["success", "success", "success", "throw", "success"]);
  // ordered by first touch (shop reads token / shopId / price before calling token)
  assert.deepEqual(summary.afterValues.map((v) => [v.dbKey, v.afterValue]), [
    ["token:storage:allowance:alice:shop", "10n"],
    ["shop:storage:token", "token"],
    ["shop:storage:shopId", "shop"],
    ["shop:storage:price", "30n"],
    ["token:storage:balances:alice", "40n"],
    ["token:storage:balances:shop", "60n"],
    ["shop:storage:items:alice", "2n"],
    ["shop:storage:sales", "2n"],
    ["shop:storage:attempts:alice", "1n"],
    ["shop:storage:failed:alice", "insufficient allowance"],
  ]);
  assertBlockInvariants(vm, block);
});

test("invariant: nested program reverted → touched keys are in afterValues but changed false, and absent from writes", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call({ programUuid: "probe", functionName: "relayCatch", input: { target: "token", fn: "transfer", args: { to: "x", amount: 1 } }, context: user("alice") });
  block.call({ programUuid: "probe", functionName: "beforeCatchAfter", input: { target: "probe" }, context: user("alice") });

  const summary = block.summary();
  assert.deepEqual(summary.afterValues.find((v) => v.dbKey === bal("probe")), { dbKey: bal("probe"), afterValue: undefined, changed: false });
  assert.deepEqual(summary.afterValues.find((v) => v.dbKey === "probe:storage:dirty"), { dbKey: "probe:storage:dirty", afterValue: undefined, changed: false });
  assert.equal(summary.writes.some((w) => w.dbKey === "probe:storage:dirty"), false);
  assertBlockInvariants(vm, block);
});

test("invariant: deploy + init + call in one block — system keys are in writes but not in loadValues / afterValues", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.deploy({ programUuid: "counter", code: COUNTER, context: user("a"), initInput: { start: 5 } });
  block.init({ programUuid: "counter" });
  block.call({ programUuid: "counter", functionName: "add", input: { amount: 2 }, context: user("a") });

  const summary = block.summary();
  assert.deepEqual(summary.loadValues, [{ dbKey: "counter:storage:count", loadValue: undefined }]);
  assert.deepEqual(summary.afterValues, [{ dbKey: "counter:storage:count", afterValue: "7n", changed: true }]);
  assert.deepEqual(summary.writes.map((w) => `${w.type} ${w.dbKey}`), [
    "del pending:counter",
    "put counter:storage:count",
    "put counter:code",
    "put counter:context",
    "put counter:this",
"put counter:metadata:type",
"put counter:metadata:creator",
"put counter:metadata:createdAt",
  ]);
  assertBlockInvariants(vm, block);
});

test("invariant: delete then recreate / create then delete within a block", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.deploy({ programUuid: "counter", code: COUNTER, context: user("a"), initInput: { start: 5 } });
  block.init({ programUuid: "counter" });
  block.commit();

  const next = vm.createBlock({ timestamp: T });
  next.call({ programUuid: "counter", functionName: "reset", context: user("a") });   // delete
  next.call({ programUuid: "counter", functionName: "add", input: { amount: 5 }, context: user("a") }); // recreate as 5 = the original value
  assert.deepEqual(next.afterValues(), [{ dbKey: "counter:storage:count", afterValue: "5n", changed: false }]);
  assert.deepEqual(next.writes(), [{ type: "put", dbKey: "counter:storage:count", value: "5n" }]);
  assertBlockInvariants(vm, next);

  const last = vm.createBlock({ timestamp: T });
  last.call({ programUuid: "counter", functionName: "add", input: { amount: 1 }, context: user("a") });
  last.call({ programUuid: "counter", functionName: "reset", context: user("a") });
  assert.deepEqual(last.afterValues(), [{ dbKey: "counter:storage:count", afterValue: undefined, changed: true }]);
  assert.deepEqual(last.writes(), [{ type: "del", dbKey: "counter:storage:count" }]);
  assertBlockInvariants(vm, last);
});

test("keys read only in failed txs are absent from the block data", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(transfer("zed", "bob", 1)); // reads zed, then fails
  block.call(transfer("alice", "bob", 1));
  const keys = block.loadValues().map((v) => v.dbKey);
  assert.deepEqual(keys, [bal("alice"), bal("bob")]);
  assert.equal(block.afterValues().some((v) => v.dbKey === bal("zed")), false);
});

// ---------------------------------------------------------------------------
//  block = running each tx and committing immediately one by one (results must be identical)
// ---------------------------------------------------------------------------

/** seedable random generator */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTxs(seed, count) {
  const rand = random(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const people = ["owner", "alice", "bob", "carol"];
  const txs = [];
  for (let i = 0; i < count; i++) {
    const kind = rand();
    const who = pick(people);
    if (kind < 0.55) txs.push(transfer(who, pick(people), 1 + Math.floor(rand() * 80)));
    else if (kind < 0.7) txs.push(approve(who, "shop", Math.floor(rand() * 100)));
    else if (kind < 0.85) txs.push(buy(who));
    else if (kind < 0.95) txs.push(buy(who, "buySafe"));
    else txs.push({ programUuid: "probe", functionName: "relayCatch", input: { target: "token", fn: "transfer", args: { to: pick(people), amount: 5 } }, context: user(who) });
  }
  return txs;
}

for (const seed of [1, 2, 3, 42, 2024]) {
  test(`block equals running each tx + committing one by one (seed ${seed}, 60 tx)`, () => {
    const txs = randomTxs(seed, 60);

    const blockVm = setup();
    const block = blockVm.createBlock({ timestamp: T });
    for (const tx of txs) block.call(tx);

    const sequentialVm = setup();
    const sequential = txs.map((tx) => {
      const res = sequentialVm.call(tx, { timestamp: T });
      if (res.status === "success") sequentialVm.commit(res.writes);
      return res;
    });

    // every tx result matches in every field
    assert.deepEqual(block.results(), sequential);

    // DB after commit is identical
    block.commit();
    assert.deepEqual(blockVm.db.snapshot(), sequentialVm.db.snapshot());

    // the token's total stays constant
    const total = Object.entries(blockVm.db.snapshot())
      .filter(([key]) => key.startsWith("token:storage:balances:"))
      .reduce((sum, [, value]) => sum + BigInt(value.slice(0, -1)), 0n);   // stored as "123n"
    assert.equal(total, 1000n);

    // includes both successful and failed txs
    const statuses = new Set(block.results().map((r) => r.status));
    assert.deepEqual([...statuses].sort(), ["success", "throw"]);
  });

  test(`randomized block invariants (seed ${seed})`, () => {
    const vm = setup();
    const block = vm.createBlock({ timestamp: T });
    for (const tx of randomTxs(seed, 60)) block.call(tx);
    assertBlockInvariants(vm, block);
  });
}

// ---------------------------------------------------------------------------
//  other data properties
// ---------------------------------------------------------------------------

test("returned data is a copy — modifying it does not affect the block", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(transfer("alice", "bob", 10));
  const summary = block.summary();
  summary.loadValues[0].loadValue = -1;
  summary.afterValues[0].afterValue = -1;
  summary.writes[0].value = -1;
  summary.results.length = 0;
  assert.equal(block.loadValues()[0].loadValue, "100n");
  assert.equal(block.afterValues()[0].afterValue, "90n");
  assert.equal(block.writes()[0].value, "90n");
  assert.equal(block.results().length, 1);
});

test("modifying tx results (from call or from results()) does not affect block data", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  const returned = block.call(transfer("alice", "bob", 10));
  returned.writes[0].value = 111;
  returned.status = "hacked";
  block.results()[0].writes[0].value = 222;
  block.results()[0].loadValues.length = 0;

  assert.equal(block.writes()[0].value, "90n");
  assert.equal(block.results()[0].status, "success");
  assert.equal(block.results()[0].writes[0].value, "90n");
  assert.equal(block.results()[0].loadValues.length, 2);
});

test("summary is readable before and after commit and stays the same", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(transfer("alice", "bob", 10));
  const before = block.summary();
  block.commit();
  assert.deepEqual(block.summary(), before);
});

test("summary converts to JSON (undefined loadValue disappears from the JSON)", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(transfer("alice", "bob", 10));
  const json = JSON.parse(JSON.stringify(block.summary()));
  assert.deepEqual(json.loadValues, [{ dbKey: bal("alice"), loadValue: "100n" }, { dbKey: bal("bob") }]);
});

test("large 500-tx block: data is correct and fast", () => {
  const vm = setup({ aliceBalance: 500 });
  const block = vm.createBlock({ timestamp: T });
  const started = Date.now();
  for (let i = 0; i < 500; i++) block.call(transfer("alice", `user${i % 50}`, 1));
  const elapsed = Date.now() - started;

  assert.equal(block.results().length, 500);
  assert.ok(block.results().every((r) => r.status === "success"));
  assert.equal(block.writes().length, 51); // alice + user0..49
  assert.deepEqual(block.afterValues().find((v) => v.dbKey === bal("alice")), { dbKey: bal("alice"), afterValue: "0n", changed: true });
  assert.deepEqual(block.afterValues().find((v) => v.dbKey === bal("user7")), { dbKey: bal("user7"), afterValue: "10n", changed: true });
  assert.ok(elapsed < 2000, `took ${elapsed}ms`);
  assertBlockInvariants(vm, block);
});
