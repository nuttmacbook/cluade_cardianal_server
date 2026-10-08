import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, mockData, resetVM, user, ok, fails, activate, trace, stored, dbKeys } from "./helpers.js";
import { COUNTER, NO_INIT, INIT_THROWS, INIT_LOOPS, INIT_CALLS_REGISTRY, REGISTRY, TOKEN } from "./programs.js";

beforeEach(resetVM);

test("init: รัน initialization ด้วย context / initInput ตอน deploy แล้วบันทึกโปรแกรม", () => {
  ok(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 10 } }));
  const res = ok(vm.init({ programUuid: "counter" }));

  assert.deepEqual(res.result, { programUuid: "counter", state: "active", initResult: "ready", value: 0 });
  assert.deepEqual(trace(res), ["0:counter.initialization:success"]);
  assert.equal(res.calls[0].sender, "alice");
  assert.deepEqual(dbKeys(res), [
    "put counter:storage:count",
    "put counter:code",
    "put counter:context",
    "put counter:this",
"put counter:metadata:type",
"put counter:metadata:creator",
"put counter:metadata:createdAt",
    "del pending:counter",
  ]);
  assert.deepEqual(res.afterValues, [{ dbKey: "counter:storage:count", afterValue: 10, changed: true }]);
  assert.deepEqual(res.loadValues, []);

  assert.equal(mockData.has("pending:counter"), false);
  assert.equal(mockData.get("counter:code"), VM.toOneLine(COUNTER));
  assert.deepEqual(mockData.get("counter:context"), user("alice"));
  assert.equal(mockData.get("counter:this"), "counter");
  assert.equal(stored("counter", "count"), 10);
});

test("init: โปรแกรมไม่มี initialization → ไม่มี calls แต่บันทึกโปรแกรม", () => {
  ok(vm.deploy({ programUuid: "p", code: NO_INIT, context: user("a") }));
  const res = ok(vm.init({ programUuid: "p" }));
  assert.deepEqual(res.calls, []);
  assert.equal(res.result.initResult, undefined);
  assert.deepEqual(dbKeys(res), [
    "put p:code", "put p:context", "put p:this",
    "put p:metadata:type", "put p:metadata:creator", "put p:metadata:createdAt",
    "del pending:p",
  ]);
});

test("init: initialization throw → ไม่มี writes, pending ยังอยู่, init ใหม่ได้หลังแก้ข้อมูล", () => {
  ok(vm.deploy({ programUuid: "p", code: INIT_THROWS, context: user("a"), initInput: { ok: false } }));
  const res = fails(vm.init({ programUuid: "p" }), "PROGRAM_ERROR", "init failed");
  assert.deepEqual(trace(res), ["0:p.initialization:throw:PROGRAM_ERROR"]);
  assert.ok(mockData.has("pending:p"));
  assert.equal(stored("p", "partial"), undefined);

  mockData.get("pending:p").initInput = { ok: true }; // สมมติว่าแก้ข้อมูล pending ใน DB
  ok(vm.init({ programUuid: "p" }));
  assert.equal(stored("p", "partial"), 1);
});

test("init: initialization วนไม่รู้จบ → TIMEOUT", () => {
  ok(vm.deploy({ programUuid: "p", code: INIT_LOOPS, context: user("a") }));
  const res = fails(vm.init({ programUuid: "p" }), "TIMEOUT");
  assert.deepEqual(trace(res), ["0:p.initialization:throw:TIMEOUT"]);
  assert.ok(mockData.has("pending:p"));
});

test("init: ไม่มี pending / init ซ้ำ → NOT_FOUND", () => {
  fails(vm.init({ programUuid: "nothing" }), "NOT_FOUND", "ไม่พบโปรแกรมที่รอรีวิว");
  activate("p", NO_INIT);
  fails(vm.init({ programUuid: "p" }), "NOT_FOUND");
  fails(vm.init({ programUuid: "a:b" }), "INVALID_REQUEST");
  fails(vm.init(), "INVALID_REQUEST");
});

test("init: ถ้าไม่บันทึก writes ของ init รอบแรก init ซ้ำจะรัน initialization ใหม่", () => {
  ok(vm.deploy({ programUuid: "c", code: COUNTER, context: user("a") }));
  const first = vm.init({ programUuid: "c" }, { timestamp: 1 }); // ไม่ save
  const second = vm.init({ programUuid: "c" }, { timestamp: 1 });
  assert.deepEqual(first, second);
});

test("initialization เรียกโปรแกรมอื่นได้ โดย sender = โปรแกรมใหม่", () => {
  activate("registry", REGISTRY);
  ok(vm.deploy({ programUuid: "newbie", code: INIT_CALLS_REGISTRY, context: user("alice"), initInput: { registry: "registry" } }));
  const res = ok(vm.init({ programUuid: "newbie" }));

  assert.deepEqual(res.result.initResult, { sender: "newbie", origin: "alice" });
  assert.deepEqual(trace(res), ["0:newbie.initialization:success", "1:registry.register:success"]);
  assert.equal(stored("registry", "members", "newbie"), "alice");
});

test("initialization: user และโปรแกรมอื่นเรียกเองไม่ได้", () => {
  activate("token", TOKEN, { initInput: { supply: 100 } });
  fails(vm.call({ programUuid: "token", functionName: "initialization", context: user("owner") }), "FORBIDDEN", "เรียก 'initialization' ไม่ได้ (ไม่มีหรือไม่ได้ export)");
});

test("reject: ลบ pending, reject ซ้ำ NOT_FOUND, deploy id เดิมใหม่ได้", () => {
  ok(vm.deploy({ programUuid: "p", code: NO_INIT, context: user("a") }));
  const res = ok(vm.reject({ programUuid: "p" }));
  assert.deepEqual(res.result, { programUuid: "p", state: "rejected", refund: 0 });
  assert.deepEqual(dbKeys(res), ["del pending:p"]);

  fails(vm.reject({ programUuid: "p" }), "NOT_FOUND");
  ok(vm.deploy({ programUuid: "p", code: COUNTER, context: user("a") }));
});

test("reject: โปรแกรมที่ active แล้ว reject ไม่ได้", () => {
  activate("p", NO_INIT);
  fails(vm.reject({ programUuid: "p" }), "NOT_FOUND");
});
