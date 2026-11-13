import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, mockData, resetVM, user, ok, fails, activate, trace, stored, dbKeys } from "./helpers.js";
import { COUNTER, NO_INIT, INIT_THROWS, INIT_LOOPS, INIT_CALLS_REGISTRY, REGISTRY, TOKEN } from "./programs.js";

beforeEach(resetVM);

test("init: runs initialization with the deploy context / initInput, then saves the program", () => {
  ok(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 10 } }));
  const res = ok(vm.init({ programUuid: "counter" }));

  assert.deepEqual(res.result, { programUuid: "counter", state: "active", initResult: "ready", value: "0n" });
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
  assert.deepEqual(res.afterValues, [{ dbKey: "counter:storage:count", afterValue: "10n", changed: true }]);
  assert.deepEqual(res.loadValues, []);

  assert.equal(mockData.has("pending:counter"), false);
  assert.equal(mockData.get("counter:code"), VM.toOneLine(COUNTER));
  assert.deepEqual(mockData.get("counter:context"), user("alice"));
  assert.equal(mockData.get("counter:this"), "counter");
  assert.equal(stored("counter", "count"), "10n");
});

test("init: program without initialization → no calls, but the program is saved", () => {
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

test("init: initialization throws → no writes, pending remains, init again after fixing the data", () => {
  ok(vm.deploy({ programUuid: "p", code: INIT_THROWS, context: user("a"), initInput: { ok: false } }));
  const res = fails(vm.init({ programUuid: "p" }), "PROGRAM_ERROR", "init failed");
  assert.deepEqual(trace(res), ["0:p.initialization:throw:PROGRAM_ERROR"]);
  assert.ok(mockData.has("pending:p"));
  assert.equal(stored("p", "partial"), undefined);

  mockData.get("pending:p").initInput = { ok: true }; // pretend the pending data was fixed in the DB
  ok(vm.init({ programUuid: "p" }));
  assert.equal(stored("p", "partial"), "1n");
});

test("init: initialization loops forever → TIMEOUT", () => {
  ok(vm.deploy({ programUuid: "p", code: INIT_LOOPS, context: user("a") }));
  const res = fails(vm.init({ programUuid: "p" }), "TIMEOUT");
  assert.deepEqual(trace(res), ["0:p.initialization:throw:TIMEOUT"]);
  assert.ok(mockData.has("pending:p"));
});

test("init: no pending / repeated init → NOT_FOUND", () => {
  fails(vm.init({ programUuid: "nothing" }), "NOT_FOUND", "no program pending review");
  activate("p", NO_INIT);
  fails(vm.init({ programUuid: "p" }), "NOT_FOUND");
  fails(vm.init({ programUuid: "a:b" }), "INVALID_REQUEST");
  fails(vm.init(), "INVALID_REQUEST");
});

test("init: if the first init's writes are not saved, a repeated init runs initialization again", () => {
  ok(vm.deploy({ programUuid: "c", code: COUNTER, context: user("a") }));
  const first = vm.init({ programUuid: "c" }, { timestamp: 1 }); // not saved
  const second = vm.init({ programUuid: "c" }, { timestamp: 1 });
  assert.deepEqual(first, second);
});

test("initialization can call other programs, with sender = the new program", () => {
  activate("registry", REGISTRY);
  ok(vm.deploy({ programUuid: "newbie", code: INIT_CALLS_REGISTRY, context: user("alice"), initInput: { registry: "registry" } }));
  const res = ok(vm.init({ programUuid: "newbie" }));

  assert.deepEqual(res.result.initResult, { sender: "newbie", origin: "alice" });
  assert.deepEqual(trace(res), ["0:newbie.initialization:success", "1:registry.register:success"]);
  assert.equal(stored("registry", "members", "newbie"), "alice");
});

test("initialization: users and other programs cannot call it", () => {
  activate("token", TOKEN, { initInput: { supply: 100 } });
  fails(vm.call({ programUuid: "token", functionName: "initialization", context: user("owner") }), "FORBIDDEN", "cannot call 'initialization' (missing or not exported)");
});

test("reject: removes pending, repeated reject is NOT_FOUND, the same id can be deployed again", () => {
  ok(vm.deploy({ programUuid: "p", code: NO_INIT, context: user("a") }));
  const res = ok(vm.reject({ programUuid: "p" }));
  assert.deepEqual(res.result, { programUuid: "p", state: "rejected", refund: "0n" });
  assert.deepEqual(dbKeys(res), ["del pending:p"]);

  fails(vm.reject({ programUuid: "p" }), "NOT_FOUND");
  ok(vm.deploy({ programUuid: "p", code: COUNTER, context: user("a") }));
});

test("reject: an active program cannot be rejected", () => {
  activate("p", NO_INIT);
  fails(vm.reject({ programUuid: "p" }), "NOT_FOUND");
});
