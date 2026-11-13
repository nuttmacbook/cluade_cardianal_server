import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, resetVM, user, ok, fails, activate, callAs, trace } from "./helpers.js";
import { COUNTER, PROBE, NO_EXPORTS, STATEFUL, FAULTY } from "./programs.js";

beforeEach(resetVM);

test("call: calls an exported function and returns result / calls", () => {
  activate("counter", COUNTER, { initInput: { start: 1 } });
  const res = ok(callAs("alice", "counter", "add", { amount: 4 }));
  assert.equal(res.result, "5n");
  assert.deepEqual(res.calls, [{ depth: 0, programUuid: "counter", functionName: "add", sender: "alice", origin: "alice", input: { amount: 4 }, value: "0n", gasStart: 0, result: "5n", gasUsed: 1750, status: "success" }]);   // 1708 from APIs (including stateKey 1,000 for the written key) + 42 from executed nodes
});

test("call: internal functions can be called from inside the program but not from outside, and are not recorded in calls", () => {
  activate("probe", PROBE);
  assert.equal(ok(callAs("a", "probe", "callInternal")).result, "secret");
  fails(callAs("a", "probe", "internalOnly"), "FORBIDDEN", "เรียก 'internalOnly' ไม่ได้ (ไม่มีหรือไม่ได้ export)");

  activate("counter", COUNTER);
  assert.deepEqual(trace(ok(callAs("a", "counter", "addTwice", { amount: 1 }))), ["0:counter.addTwice:success"]);
});

test("call: odd function names / prototype / no name → FORBIDDEN", () => {
  activate("probe", PROBE);
  for (const functionName of [undefined, "", "constructor", "__proto__", "toString", "hasOwnProperty", "nope"]) {
    fails(callAs("a", "probe", functionName), "FORBIDDEN");
  }
});

test("call: program with no exports → nothing can be called", () => {
  activate("hidden", NO_EXPORTS);
  fails(callAs("a", "hidden", "hidden"), "FORBIDDEN");
});

test("call: program not found / still pending → NOT_FOUND", () => {
  fails(callAs("a", "missing", "x"), "NOT_FOUND", "ไม่พบโปรแกรม 'missing'");
  ok(vm.deploy({ programUuid: "pending", code: PROBE, context: user("a") }));
  fails(callAs("a", "pending", "whoami"), "NOT_FOUND");
});

test("call: validates the request", () => {
  activate("probe", PROBE);
  fails(vm.call(), "INVALID_REQUEST");
  fails(vm.call({ programUuid: "probe", functionName: "whoami" }), "INVALID_REQUEST", /context/);
  fails(vm.call({ programUuid: "a:b", functionName: "whoami", context: user("a") }), "INVALID_REQUEST", /programUuid/);
});

test("call: no params.input → {} and params.context has only sender / origin", () => {
  activate("probe", PROBE);
  assert.deepEqual(ok(callAs("a", "probe", "echo")).result, {});
  const res = ok(vm.call({ programUuid: "probe", functionName: "whoami", context: { sender: "s", origin: "o", role: "admin" } }));
  assert.deepEqual(res.result, { sender: "s", origin: "s" }); // origin is forced to equal sender
});

test("call: input is copied — a program modifying input does not affect the caller's object", () => {
  activate("probe", PROBE);
  const input = { nested: { value: "original" } };
  const res = ok(callAs("a", "probe", "mutateInput", input));
  assert.equal(res.result.nested.value, "changed");
  assert.equal(input.nested.value, "original");
});

test("call: non-JSON input → INVALID_REQUEST", () => {
  activate("probe", PROBE);
  fails(callAs("a", "probe", "echo", { big: 1n }), "INVALID_REQUEST", "input ต้องเป็นข้อมูล JSON");
});

test("call: return values are converted as JSON (BigInt → \"123n\")", () => {
  activate("faulty", FAULTY);
  const result = (fn) => ok(callAs("a", "faulty", fn)).result;

  assert.equal(result("returnUndefined"), undefined);
  assert.equal(result("returnNull"), null);
  assert.equal(result("returnBigInt"), "10n");
  assert.equal(result("returnString"), "สวัสดี 🎉");
  assert.deepEqual(result("returnNested"), { a: ["1n", { b: true }], c: null });
  assert.deepEqual(result("returnWithUndefinedField"), { a: "1n" });

  // numbers (including decimals / NaN) must be BigInt
  fails(callAs("a", "faulty", "returnNumber"), "INVALID_REQUEST", "ค่าที่ return: ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น (เช่น 10n)");
  fails(callAs("a", "faulty", "returnNaN"), "INVALID_REQUEST", "ค่าที่ return: ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น (เช่น 10n)");
  // non-plain objects (Date / function) are not JSON
  fails(callAs("a", "faulty", "returnDate"), "INVALID_REQUEST", "ค่าที่ return ต้องเป็นข้อมูล JSON");
  fails(callAs("a", "faulty", "returnFunction"), "INVALID_REQUEST", "ค่าที่ return ต้องเป็นข้อมูล JSON");
  fails(callAs("a", "faulty", "returnCircular"), "PROGRAM_ERROR", /RangeError/);
});

test("call: async / thenable not supported", () => {
  activate("faulty", FAULTY);
  fails(callAs("a", "faulty", "asyncFn"), "PROGRAM_ERROR", "ไม่รองรับ async");
  fails(callAs("a", "faulty", "thenable"), "PROGRAM_ERROR", "ไม่รองรับ async");
});

test("call: top-level program variables do not persist across calls", () => {
  activate("stateful", STATEFUL);
  assert.equal(ok(callAs("a", "stateful", "hit")).result, "1n");
  assert.equal(ok(callAs("a", "stateful", "hit")).result, "1n");
  assert.equal(ok(callAs("a", "stateful", "hitTwice")).result, "2n");
});

test("call: strict mode — an accidental global variable → error", () => {
  activate("faulty", FAULTY);
  fails(callAs("a", "faulty", "implicitGlobal"), "PROGRAM_ERROR", /โปรแกรมทำงานผิดพลาด \(ReferenceError\)/);
  assert.equal(globalThis.leakedGlobal, undefined);
});

test("call: each request is independent (unsaved writes don't affect the next call)", () => {
  activate("counter", COUNTER, { initInput: { start: 0 } });
  vm.call({ programUuid: "counter", functionName: "add", input: { amount: 5 }, context: user("a") }); // not saved
  assert.equal(ok(callAs("a", "counter", "get")).result, "0n");
});

