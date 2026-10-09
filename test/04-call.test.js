import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, resetVM, user, ok, fails, activate, callAs, trace } from "./helpers.js";
import { COUNTER, PROBE, NO_EXPORTS, STATEFUL, FAULTY } from "./programs.js";

beforeEach(resetVM);

test("call: เรียกฟังก์ชันที่ export ได้ และคืน result / calls", () => {
  activate("counter", COUNTER, { initInput: { start: 1 } });
  const res = ok(callAs("alice", "counter", "add", { amount: 4 }));
  assert.equal(res.result, 5);
  assert.deepEqual(res.calls, [{ depth: 0, programUuid: "counter", functionName: "add", sender: "alice", origin: "alice", input: { amount: 4 }, value: 0, gasStart: 0, result: 5, gasUsed: 702, status: "success" }]);
});

test("call: ฟังก์ชัน internal เรียกจากในโปรแกรมได้ แต่เรียกจากข้างนอกไม่ได้ และไม่ถูกบันทึกใน calls", () => {
  activate("probe", PROBE);
  assert.equal(ok(callAs("a", "probe", "callInternal")).result, "secret");
  fails(callAs("a", "probe", "internalOnly"), "FORBIDDEN", "เรียก 'internalOnly' ไม่ได้ (ไม่มีหรือไม่ได้ export)");

  activate("counter", COUNTER);
  assert.deepEqual(trace(ok(callAs("a", "counter", "addTwice", { amount: 1 }))), ["0:counter.addTwice:success"]);
});

test("call: ชื่อฟังก์ชันแปลก ๆ / prototype / ไม่ส่งชื่อ → FORBIDDEN", () => {
  activate("probe", PROBE);
  for (const functionName of [undefined, "", "constructor", "__proto__", "toString", "hasOwnProperty", "nope"]) {
    fails(callAs("a", "probe", functionName), "FORBIDDEN");
  }
});

test("call: โปรแกรมไม่มี export → เรียกอะไรไม่ได้", () => {
  activate("hidden", NO_EXPORTS);
  fails(callAs("a", "hidden", "hidden"), "FORBIDDEN");
});

test("call: ไม่พบโปรแกรม / โปรแกรมที่ยัง pending → NOT_FOUND", () => {
  fails(callAs("a", "missing", "x"), "NOT_FOUND", "ไม่พบโปรแกรม 'missing'");
  ok(vm.deploy({ programUuid: "pending", code: PROBE, context: user("a") }));
  fails(callAs("a", "pending", "whoami"), "NOT_FOUND");
});

test("call: ตรวจ request", () => {
  activate("probe", PROBE);
  fails(vm.call(), "INVALID_REQUEST");
  fails(vm.call({ programUuid: "probe", functionName: "whoami" }), "INVALID_REQUEST", /context/);
  fails(vm.call({ programUuid: "a:b", functionName: "whoami", context: user("a") }), "INVALID_REQUEST", /programUuid/);
});

test("call: params.input ไม่ส่ง → {} และ params.context มีแค่ sender / origin", () => {
  activate("probe", PROBE);
  assert.deepEqual(ok(callAs("a", "probe", "echo")).result, {});
  const res = ok(vm.call({ programUuid: "probe", functionName: "whoami", context: { sender: "s", origin: "o", role: "admin" } }));
  assert.deepEqual(res.result, { sender: "s", origin: "s" }); // origin ถูกบังคับให้เท่ากับ sender
});

test("call: input ถูก copy — โปรแกรมแก้ input ไม่กระทบ object ของผู้เรียก", () => {
  activate("probe", PROBE);
  const input = { nested: { value: "original" } };
  const res = ok(callAs("a", "probe", "mutateInput", input));
  assert.equal(res.result.nested.value, "changed");
  assert.equal(input.nested.value, "original");
});

test("call: input ที่ไม่ใช่ JSON → INVALID_REQUEST", () => {
  activate("probe", PROBE);
  fails(callAs("a", "probe", "echo", { big: 1n }), "INVALID_REQUEST", "input ต้องเป็นข้อมูล JSON");
});

test("call: ค่าที่ return ถูกแปลงแบบ JSON", () => {
  activate("faulty", FAULTY);
  const result = (fn) => ok(callAs("a", "faulty", fn)).result;

  assert.equal(result("returnUndefined"), undefined);
  assert.equal(result("returnNull"), null);
  assert.equal(result("returnNumber"), 1.5);
  assert.equal(result("returnString"), "สวัสดี 🎉");
  assert.deepEqual(result("returnNested"), { a: [1, { b: true }], c: null });
  assert.equal(result("returnDate"), "1970-01-01T00:00:00.000Z");
  assert.equal(result("returnNaN"), null);
  assert.deepEqual(result("returnWithUndefinedField"), { a: 1 });

  fails(callAs("a", "faulty", "returnFunction"), "INVALID_REQUEST", "ค่าที่ return ต้องเป็นข้อมูล JSON");
  fails(callAs("a", "faulty", "returnBigInt"), "INVALID_REQUEST", "ค่าที่ return ต้องเป็นข้อมูล JSON");
  fails(callAs("a", "faulty", "returnCircular"), "INVALID_REQUEST", "ค่าที่ return ต้องเป็นข้อมูล JSON");
});

test("call: ไม่รองรับ async / thenable", () => {
  activate("faulty", FAULTY);
  fails(callAs("a", "faulty", "asyncFn"), "PROGRAM_ERROR", "ไม่รองรับ async");
  fails(callAs("a", "faulty", "thenable"), "PROGRAM_ERROR", "ไม่รองรับ async");
});

test("call: ตัวแปรระดับบนสุดของโปรแกรมไม่ค้างข้าม call", () => {
  activate("stateful", STATEFUL);
  assert.equal(ok(callAs("a", "stateful", "hit")).result, 1);
  assert.equal(ok(callAs("a", "stateful", "hit")).result, 1);
  assert.equal(ok(callAs("a", "stateful", "hitTwice")).result, 2);
});

test("call: strict mode — ประกาศตัวแปร global โดยไม่ตั้งใจ → error", () => {
  activate("faulty", FAULTY);
  fails(callAs("a", "faulty", "implicitGlobal"), "PROGRAM_ERROR", /โปรแกรมทำงานผิดพลาด \(ReferenceError\)/);
  assert.equal(globalThis.leakedGlobal, undefined);
});

test("call: แต่ละ request เป็นอิสระกัน (writes ที่ไม่ได้ save ไม่มีผลกับ call ถัดไป)", () => {
  activate("counter", COUNTER, { initInput: { start: 0 } });
  vm.call({ programUuid: "counter", functionName: "add", input: { amount: 5 }, context: user("a") }); // ไม่ save
  assert.equal(ok(callAs("a", "counter", "get")).result, 0);
});

