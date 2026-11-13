import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { vm, resetVM, user, ok, fails, activate, stored } from "./helpers.js";
import { CLOCK } from "./programs.js";

beforeEach(() => {
  resetVM();
  activate("clock", CLOCK);
  activate("clock2", CLOCK);
});

const T = Date.UTC(2024, 5, 1, 12, 0, 0); // 2024-06-01T12:00:00.000Z
/** numbers coming out of a program look like "123n" */
const n = (value) => `${value}n`;
const now = (programUuid = "clock") => ({ programUuid, functionName: "now", context: user("a") });

test("time in programs: Date.now / new Date / Date() / params.block.timestamp equal the given time", () => {
  const res = ok(vm.call(now(), { timestamp: T }));
  assert.equal(res.timestamp, T);
  assert.deepEqual(res.result, {
    block: n(T),
    dateNow: n(T),
    newDate: n(T),
    iso: "2024-06-01T12:00:00.000Z",
    // QuickJS does not append the time zone name "(Coordinated Universal Time)" like V8
    asString: new Date(T).toString().replace(/ \(.*\)$/, ""),
    isDate: true,
    epoch: "0n",
    fromString: n(Date.UTC(2020, 0, 1)),
    utc: n(Date.UTC(2020, 0, 1)),
    parse: n(Date.UTC(2020, 0, 1)),
  });
});

test("block: every tx sees exactly the same time, even when run apart", async () => {
  const block = vm.createBlock({ timestamp: T });
  const first = block.call(now());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = block.call(now());
  assert.equal(first.result.dateNow, n(T));
  assert.equal(second.result.dateNow, n(T));
  assert.equal(block.timestamp, T);
  assert.equal(block.summary().timestamp, T);
  assert.ok(block.results().every((r) => r.timestamp === T));
});

test("block: no timestamp → Date.now() is taken once when the block is created", async () => {
  const before = Date.now();
  const block = vm.createBlock();
  const after = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const res = block.call(now());
  assert.ok(block.timestamp >= before && block.timestamp <= after);
  assert.equal(res.result.dateNow, n(block.timestamp));
});

test("single call: no timestamp → uses the time of the call", () => {
  const before = Date.now();
  const res = ok(vm.call(now()));
  const after = Date.now();
  assert.ok(res.timestamp >= before && res.timestamp <= after);
  assert.equal(res.result.dateNow, n(res.timestamp));
});

test("chained programs (runProgram) see the same time", () => {
  const res = ok(vm.call({ programUuid: "clock", functionName: "nowNested", input: { target: "clock2" }, context: user("a") }, { timestamp: T }));
  assert.deepEqual(res.result, [n(T), n(T)]);
});

test("init: initialization sees the block time", () => {
  const block = vm.createBlock({ timestamp: T });
  block.deploy({ programUuid: "clock3", code: CLOCK, context: user("a") });
  block.init({ programUuid: "clock3" });
  block.commit();
  assert.equal(stored("clock3", "createdAt"), n(T));
  assert.equal(stored("clock3", "createdAtBlock"), n(T));
});

test("writes are identical with the same timestamp and differ with a different timestamp", () => {
  const run = (timestamp) => {
    const block = vm.createBlock({ timestamp });
    block.call({ programUuid: "clock", functionName: "stamp", input: { id: 1 }, context: user("a") });
    block.call({ programUuid: "clock", functionName: "stamp", input: { id: 2 }, context: user("a") });
    return JSON.stringify(block.summary());
  };
  assert.equal(run(T), run(T));
  assert.notEqual(run(T), run(T + 1));
});

test("Date in programs does not advance: waiting on Date.now() → TIMEOUT", () => {
  vm.timeoutMs = 100;
  fails(vm.call({ programUuid: "clock", functionName: "waitWithDate", context: user("a") }), "TIMEOUT");
});

test("program Date does not affect the system Date", () => {
  ok(vm.call(now(), { timestamp: 0 }));
  assert.ok(Date.now() > T);
  assert.ok(new Date().getTime() > T);
});

test("invalid timestamp → INVALID_REQUEST", () => {
  for (const timestamp of [-1, 1.5, "1", NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => vm.createBlock({ timestamp }), { code: "INVALID_REQUEST" });
    assert.throws(() => vm.call(now(), { timestamp }), { code: "INVALID_REQUEST" });
  }
  ok(vm.call(now(), { timestamp: 0 }));
});
