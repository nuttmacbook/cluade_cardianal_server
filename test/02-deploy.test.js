import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, resetVM, user, ok, fails, activate } from "./helpers.js";
import { COUNTER, LOOP_AT_LOAD, THROW_AT_LOAD, INVALID_CODES, NO_INIT } from "./programs.js";

beforeEach(resetVM);

test("deploy: returns only the pending write with one-line code, and does not run the code", () => {
  const res = ok(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 5 } }));

  assert.deepEqual(res.result, { programUuid: "counter", code: VM.toOneLine(COUNTER), state: "pending_review", value: "0n" });
  assert.deepEqual(res.writes, [{
    type: "put",
    dbKey: "pending:counter",
    value: { code: VM.toOneLine(COUNTER), context: user("alice"), initInput: { start: 5 }, metadata: {}, value: "0n" },
  }]);
  assert.deepEqual(res.calls, []);
  assert.deepEqual(res.loadValues, []);
  assert.deepEqual(res.afterValues, []);
});

test("deploy: no initInput → {} and context keeps only sender / origin", () => {
  const res = ok(vm.deploy({ programUuid: "p", code: NO_INIT, context: { sender: "a", origin: "b", extra: "ignored" } }));
  assert.deepEqual(res.writes[0].value.initInput, {});
  assert.deepEqual(res.writes[0].value.context, { sender: "a", origin: "a" }); // origin is forced to equal sender
});

test("deploy: code that loops forever or throws on load passes deploy (not executed)", () => {
  const started = Date.now();
  ok(vm.deploy({ programUuid: "loop", code: LOOP_AT_LOAD, context: user("a") }));
  ok(vm.deploy({ programUuid: "throw", code: THROW_AT_LOAD, context: user("a") }));
  assert.ok(Date.now() - started < 100);
});

test("deploy: validates programUuid", () => {
  for (const programUuid of [null, "", 123, {}, "a:b", ":", "a:"]) {
    fails(vm.deploy({ programUuid, code: NO_INIT, context: user("a") }), "INVALID_REQUEST", /programUuid/);
  }
  ok(vm.deploy({ programUuid: "uuid-with.dots_and-dashes/slash ไทย", code: NO_INIT, context: user("a") }));   // Thai is intentional: tests Unicode in programUuid
  ok(vm.deploy({ code: NO_INIT, context: user("a") })); // no programUuid → the VM derives the address
});

test("deploy: validates context", () => {
  const contexts = [undefined, null, {}, { sender: "a" }, { origin: "a" }, { sender: "", origin: "a" }, { sender: "a", origin: 1 }];
  for (const context of contexts) {
    fails(vm.deploy({ programUuid: "p", code: NO_INIT, context }), "INVALID_REQUEST", /context/);
  }
});

test("deploy: validates code", () => {
  fails(vm.deploy({ programUuid: "p", code: 123, context: user("a") }), "INVALID_REQUEST", /code ต้องเป็น string/);
  fails(vm.deploy({ programUuid: "p", context: user("a") }), "INVALID_REQUEST", /code ต้องเป็น string/);
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.importUsed, context: user("a") }), "INVALID_REQUEST", /import/);
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.exportDefault, context: user("a") }), "INVALID_REQUEST", /import/);
  // must be a single function wrapping the whole file (any name) — code outside that one scope is rejected
  ok(vm.deploy({ programUuid: "p-named", code: "function token() {\n  function a() { return 1 }\n  return { a }\n}", context: user("a") }));
  fails(vm.deploy({ programUuid: "p", code: "const x = 1", context: user("a") }), "INVALID_REQUEST", /function program/);
  fails(vm.deploy({ programUuid: "p", code: "function a() {}\nfunction b() {}", context: user("a") }), "INVALID_REQUEST", /syntax error/);
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.syntaxError, context: user("a") }), "INVALID_REQUEST", /syntax error/);
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.exportMissing, context: user("a") }), "INVALID_REQUEST", "export 'b' แต่ไม่มีฟังก์ชันนี้ในระดับบนสุด");
  // initialization may be exported (to keep editors quiet) but still cannot be called from outside
  const exported = ok(vm.deploy({ programUuid: "p-init", code: INVALID_CODES.exportInitialization, context: user("a") }));
  assert.equal(exported.result.state, "pending_review");
  // a const holding a function (e.g. a modifier's result) can be exported
  ok(vm.deploy({ programUuid: "p-arrow", code: INVALID_CODES.exportArrow, context: user("a") }));
  // a non-function const passes deploy but cannot be called (checked at run time)
  ok(vm.deploy({ programUuid: "p-value", code: INVALID_CODES.exportValue, context: user("a") }));
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.shadowApi, context: user("a") }), "INVALID_REQUEST", /syntax error/);
});

test("deploy: exporting a function nested in another function → rejected", () => {
  const code = "function program() {\n  function outer() {\n    function inner() { return 1 }\n    return inner()\n  }\n  return { outer, inner }\n}";
  fails(vm.deploy({ programUuid: "p", code, context: user("a") }), "INVALID_REQUEST", "export 'inner' แต่ไม่มีฟังก์ชันนี้ในระดับบนสุด");
});

test("deploy: function names inside strings / comments don't count as functions", () => {
  const code = "function program() {\n  const text = `\n  function fromString() {}\n  `\n  /*\n  function fromComment() {}\n  */\n  function real() { return text }\n  return { real, fromString }\n}";
  fails(vm.deploy({ programUuid: "p", code, context: user("a") }), "INVALID_REQUEST", "export 'fromString' แต่ไม่มีฟังก์ชันนี้ในระดับบนสุด");
  const onlyComment = "function program() {\n  /*\n  function fromComment() {}\n  */\n  function real() { return 1 }\n  return { fromComment }\n}";
  fails(vm.deploy({ programUuid: "p2", code: onlyComment, context: user("a") }), "INVALID_REQUEST", "export 'fromComment' แต่ไม่มีฟังก์ชันนี้ในระดับบนสุด");
});

test("deploy: indented / async top-level functions / ones sharing a name with an inner function can still be exported", () => {
  const code = "function program() {\n      function indented() { return 1n }\n  async function later() {}\n  function wrapper() {\n    function indented() { return 2n }\n    return indented()\n  }\n  return { indented, later, wrapper }\n}";
  activate("p", code);
  assert.equal(ok(vm.call({ programUuid: "p", functionName: "indented", context: user("a") })).result, "1n");
  assert.equal(ok(vm.call({ programUuid: "p", functionName: "wrapper", context: user("a") })).result, "2n");
});

test("deploy: a nested initialization does not count as the program's initialization", () => {
  const code = "function program() {\n  function helper() {\n    function initialization() {}\n  }\n  function hello() { return 1 }\n  return { hello }\n}";
  ok(vm.deploy({ programUuid: "p", code, context: user("a") }));
  assert.deepEqual(ok(vm.init({ programUuid: "p" })).calls, []);
});

test("deploy: initInput must be JSON", () => {
  fails(vm.deploy({ programUuid: "p", code: NO_INIT, context: user("a"), initInput: { n: 10n } }), "INVALID_REQUEST", "initInput ต้องเป็นข้อมูล JSON");
});

test("deploy: programUuid cannot duplicate a pending or active program", () => {
  ok(vm.deploy({ programUuid: "p", code: NO_INIT, context: user("a") }));
  fails(vm.deploy({ programUuid: "p", code: NO_INIT, context: user("a") }), "INVALID_REQUEST", "programUuid 'p' ถูกใช้แล้ว");

  activate("active", NO_INIT);
  fails(vm.deploy({ programUuid: "active", code: NO_INIT, context: user("a") }), "INVALID_REQUEST", "programUuid 'active' ถูกใช้แล้ว");
});

test("deploy: the same code can be used for several programUuids (separate storage)", () => {
  activate("c1", COUNTER, { initInput: { start: 1 } });
  activate("c2", COUNTER, { initInput: { start: 2 } });
  assert.equal(ok(vm.call({ programUuid: "c1", functionName: "get", context: user("a") })).result, "1n");
  assert.equal(ok(vm.call({ programUuid: "c2", functionName: "get", context: user("a") })).result, "2n");
});

test("deploy: CRLF code behaves like LF", () => {
  activate("crlf", COUNTER.replace(/\n/g, "\r\n"), { initInput: { start: 7 } });
  assert.equal(ok(vm.call({ programUuid: "crlf", functionName: "get", context: user("a") })).result, "7n");
});
