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
const now = (programUuid = "clock") => ({ programUuid, functionName: "now", context: user("a") });

test("เวลาในโปรแกรม: Date.now / new Date / Date() / params.block.timestamp เท่ากับเวลาที่กำหนด", () => {
  const res = ok(vm.call(now(), { timestamp: T }));
  assert.equal(res.timestamp, T);
  assert.deepEqual(res.result, {
    block: T,
    dateNow: T,
    newDate: T,
    iso: "2024-06-01T12:00:00.000Z",
    asString: new Date(T).toString(),
    isDate: true,
    epoch: 0,
    fromString: Date.UTC(2020, 0, 1),
    utc: Date.UTC(2020, 0, 1),
    parse: Date.UTC(2020, 0, 1),
  });
});

test("block: ทุก tx เห็นเวลาเดียวกันเป๊ะ แม้รันห่างกัน", async () => {
  const block = vm.createBlock({ timestamp: T });
  const first = block.call(now());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = block.call(now());
  assert.equal(first.result.dateNow, T);
  assert.equal(second.result.dateNow, T);
  assert.equal(block.timestamp, T);
  assert.equal(block.summary().timestamp, T);
  assert.ok(block.results().every((r) => r.timestamp === T));
});

test("block: ไม่ส่ง timestamp → ใช้ Date.now() ครั้งเดียวตอนสร้าง block", async () => {
  const before = Date.now();
  const block = vm.createBlock();
  const after = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const res = block.call(now());
  assert.ok(block.timestamp >= before && block.timestamp <= after);
  assert.equal(res.result.dateNow, block.timestamp);
});

test("call เดี่ยว: ไม่ส่ง timestamp → ใช้เวลาตอนเรียก call", () => {
  const before = Date.now();
  const res = ok(vm.call(now()));
  const after = Date.now();
  assert.ok(res.timestamp >= before && res.timestamp <= after);
  assert.equal(res.result.dateNow, res.timestamp);
});

test("โปรแกรมที่เรียกต่อกัน (runProgram) เห็นเวลาเดียวกัน", () => {
  const res = ok(vm.call({ programUuid: "clock", functionName: "nowNested", input: { target: "clock2" }, context: user("a") }, { timestamp: T }));
  assert.deepEqual(res.result, [T, T]);
});

test("init: initialization เห็นเวลาของ block", () => {
  const block = vm.createBlock({ timestamp: T });
  block.deploy({ programUuid: "clock3", code: CLOCK, context: user("a") });
  block.init({ programUuid: "clock3" });
  block.commit();
  assert.equal(stored("clock3", "createdAt"), T);
  assert.equal(stored("clock3", "createdAtBlock"), T);
});

test("writes เหมือนเดิมทุกครั้งเมื่อใช้ timestamp เดียวกัน และต่างกันเมื่อ timestamp ต่างกัน", () => {
  const run = (timestamp) => {
    const block = vm.createBlock({ timestamp });
    block.call({ programUuid: "clock", functionName: "stamp", input: { id: 1 }, context: user("a") });
    block.call({ programUuid: "clock", functionName: "stamp", input: { id: 2 }, context: user("a") });
    return JSON.stringify(block.summary());
  };
  assert.equal(run(T), run(T));
  assert.notEqual(run(T), run(T + 1));
});

test("Date ในโปรแกรมไม่เดิน: รอด้วย Date.now() → TIMEOUT", () => {
  vm.timeoutMs = 100;
  fails(vm.call({ programUuid: "clock", functionName: "waitWithDate", context: user("a") }), "TIMEOUT");
});

test("Date ของโปรแกรมไม่กระทบ Date ของระบบ", () => {
  ok(vm.call(now(), { timestamp: 0 }));
  assert.ok(Date.now() > T);
  assert.ok(new Date().getTime() > T);
});

test("timestamp ไม่ถูกต้อง → INVALID_REQUEST", () => {
  for (const timestamp of [-1, 1.5, "1", NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => vm.createBlock({ timestamp }), { code: "INVALID_REQUEST" });
    assert.throws(() => vm.call(now(), { timestamp }), { code: "INVALID_REQUEST" });
  }
  ok(vm.call(now(), { timestamp: 0 }));
});
