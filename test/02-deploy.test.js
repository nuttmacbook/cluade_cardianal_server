import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, resetVM, user, ok, fails, activate } from "./helpers.js";
import { COUNTER, LOOP_AT_LOAD, THROW_AT_LOAD, INVALID_CODES, NO_INIT } from "./programs.js";

beforeEach(resetVM);

test("deploy: คืน writes แค่ pending พร้อมโค้ดบรรทัดเดียว และไม่รันโค้ด", () => {
  const res = ok(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 5 } }));

  assert.deepEqual(res.result, { programUuid: "counter", code: VM.toOneLine(COUNTER), state: "pending_review", value: 0 });
  assert.deepEqual(res.writes, [{
    type: "put",
    dbKey: "pending:counter",
    value: { code: VM.toOneLine(COUNTER), context: user("alice"), initInput: { start: 5 }, metadata: {}, value: 0 },
  }]);
  assert.deepEqual(res.calls, []);
  assert.deepEqual(res.loadValues, []);
  assert.deepEqual(res.afterValues, []);
});

test("deploy: initInput ไม่ส่ง → {} และ context เก็บเฉพาะ sender / origin", () => {
  const res = ok(vm.deploy({ programUuid: "p", code: NO_INIT, context: { sender: "a", origin: "b", extra: "ignored" } }));
  assert.deepEqual(res.writes[0].value.initInput, {});
  assert.deepEqual(res.writes[0].value.context, { sender: "a", origin: "a" }); // origin ถูกบังคับให้เท่ากับ sender
});

test("deploy: โค้ดที่วนไม่รู้จบหรือ throw ตอนโหลด ผ่าน deploy (ไม่ถูกรัน)", () => {
  const started = Date.now();
  ok(vm.deploy({ programUuid: "loop", code: LOOP_AT_LOAD, context: user("a") }));
  ok(vm.deploy({ programUuid: "throw", code: THROW_AT_LOAD, context: user("a") }));
  assert.ok(Date.now() - started < 100);
});

test("deploy: ตรวจ programUuid", () => {
  for (const programUuid of [null, "", 123, {}, "a:b", ":", "a:"]) {
    fails(vm.deploy({ programUuid, code: NO_INIT, context: user("a") }), "INVALID_REQUEST", /programUuid/);
  }
  ok(vm.deploy({ programUuid: "uuid-with.dots_and-dashes/slash ไทย", code: NO_INIT, context: user("a") }));
  ok(vm.deploy({ code: NO_INIT, context: user("a") })); // ไม่ส่ง programUuid → VM คำนวณ address ให้
});

test("deploy: ตรวจ context", () => {
  const contexts = [undefined, null, {}, { sender: "a" }, { origin: "a" }, { sender: "", origin: "a" }, { sender: "a", origin: 1 }];
  for (const context of contexts) {
    fails(vm.deploy({ programUuid: "p", code: NO_INIT, context }), "INVALID_REQUEST", /context/);
  }
});

test("deploy: ตรวจ code", () => {
  fails(vm.deploy({ programUuid: "p", code: 123, context: user("a") }), "INVALID_REQUEST", /code ต้องเป็น string/);
  fails(vm.deploy({ programUuid: "p", context: user("a") }), "INVALID_REQUEST", /code ต้องเป็น string/);
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.importUsed, context: user("a") }), "INVALID_REQUEST", /import/);
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.exportDefault, context: user("a") }), "INVALID_REQUEST", /import/);
  // ต้องเป็นฟังก์ชันเดียวครอบทั้งไฟล์ (ชื่ออะไรก็ได้) — โค้ดที่ไม่ได้อยู่ใน scope เดียวถูกปฏิเสธ
  ok(vm.deploy({ programUuid: "p-named", code: "function token() {\n  function a() { return 1 }\n  return { a }\n}", context: user("a") }));
  fails(vm.deploy({ programUuid: "p", code: "const x = 1", context: user("a") }), "INVALID_REQUEST", /function program/);
  fails(vm.deploy({ programUuid: "p", code: "function a() {}\nfunction b() {}", context: user("a") }), "INVALID_REQUEST", /syntax error/);
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.syntaxError, context: user("a") }), "INVALID_REQUEST", /syntax error/);
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.exportMissing, context: user("a") }), "INVALID_REQUEST", "export 'b' แต่ไม่มีฟังก์ชันนี้ในระดับบนสุด");
  // export initialization ได้ (เพื่อให้ editor ไม่ฟ้อง) แต่ยังเรียกจากภายนอกไม่ได้
  const exported = ok(vm.deploy({ programUuid: "p-init", code: INVALID_CODES.exportInitialization, context: user("a") }));
  assert.equal(exported.result.state, "pending_review");
  // const ที่เป็นฟังก์ชัน (เช่นผลของ modifier) export ได้
  ok(vm.deploy({ programUuid: "p-arrow", code: INVALID_CODES.exportArrow, context: user("a") }));
  // const ที่ไม่ใช่ฟังก์ชัน deploy ผ่าน แต่เรียกไม่ได้ (ตรวจตอนรัน)
  ok(vm.deploy({ programUuid: "p-value", code: INVALID_CODES.exportValue, context: user("a") }));
  fails(vm.deploy({ programUuid: "p", code: INVALID_CODES.shadowApi, context: user("a") }), "INVALID_REQUEST", /syntax error/);
});

test("deploy: export ฟังก์ชันที่ซ้อนอยู่ในฟังก์ชันอื่น → ปฏิเสธ", () => {
  const code = "function program() {\n  function outer() {\n    function inner() { return 1 }\n    return inner()\n  }\n  return { outer, inner }\n}";
  fails(vm.deploy({ programUuid: "p", code, context: user("a") }), "INVALID_REQUEST", "export 'inner' แต่ไม่มีฟังก์ชันนี้ในระดับบนสุด");
});

test("deploy: ชื่อฟังก์ชันที่อยู่ใน string / comment ไม่นับเป็นฟังก์ชัน", () => {
  const code = "function program() {\n  const text = `\n  function fromString() {}\n  `\n  /*\n  function fromComment() {}\n  */\n  function real() { return text }\n  return { real, fromString }\n}";
  fails(vm.deploy({ programUuid: "p", code, context: user("a") }), "INVALID_REQUEST", "export 'fromString' แต่ไม่มีฟังก์ชันนี้ในระดับบนสุด");
  const onlyComment = "function program() {\n  /*\n  function fromComment() {}\n  */\n  function real() { return 1 }\n  return { fromComment }\n}";
  fails(vm.deploy({ programUuid: "p2", code: onlyComment, context: user("a") }), "INVALID_REQUEST", "export 'fromComment' แต่ไม่มีฟังก์ชันนี้ในระดับบนสุด");
});

test("deploy: ฟังก์ชันระดับบนสุดที่ย่อหน้า / async / ชื่อซ้ำกับฟังก์ชันด้านใน ยัง export ได้", () => {
  const code = "function program() {\n      function indented() { return 1 }\n  async function later() {}\n  function wrapper() {\n    function indented() { return 2 }\n    return indented()\n  }\n  return { indented, later, wrapper }\n}";
  activate("p", code);
  assert.equal(ok(vm.call({ programUuid: "p", functionName: "indented", context: user("a") })).result, 1);
  assert.equal(ok(vm.call({ programUuid: "p", functionName: "wrapper", context: user("a") })).result, 2);
});

test("deploy: initialization ที่ซ้อนอยู่ด้านในไม่นับเป็น initialization ของโปรแกรม", () => {
  const code = "function program() {\n  function helper() {\n    function initialization() {}\n  }\n  function hello() { return 1 }\n  return { hello }\n}";
  ok(vm.deploy({ programUuid: "p", code, context: user("a") }));
  assert.deepEqual(ok(vm.init({ programUuid: "p" })).calls, []);
});

test("deploy: initInput ต้องเป็น JSON", () => {
  fails(vm.deploy({ programUuid: "p", code: NO_INIT, context: user("a"), initInput: { n: 10n } }), "INVALID_REQUEST", "initInput ต้องเป็นข้อมูล JSON");
});

test("deploy: programUuid ซ้ำกับ pending หรือโปรแกรมที่ active ไม่ได้", () => {
  ok(vm.deploy({ programUuid: "p", code: NO_INIT, context: user("a") }));
  fails(vm.deploy({ programUuid: "p", code: NO_INIT, context: user("a") }), "INVALID_REQUEST", "programUuid 'p' ถูกใช้แล้ว");

  activate("active", NO_INIT);
  fails(vm.deploy({ programUuid: "active", code: NO_INIT, context: user("a") }), "INVALID_REQUEST", "programUuid 'active' ถูกใช้แล้ว");
});

test("deploy: โค้ดเดียวกันใช้กับหลาย programUuid ได้ (storage แยกกัน)", () => {
  activate("c1", COUNTER, { initInput: { start: 1 } });
  activate("c2", COUNTER, { initInput: { start: 2 } });
  assert.equal(ok(vm.call({ programUuid: "c1", functionName: "get", context: user("a") })).result, 1);
  assert.equal(ok(vm.call({ programUuid: "c2", functionName: "get", context: user("a") })).result, 2);
});

test("deploy: โค้ด CRLF ทำงานเหมือน LF", () => {
  activate("crlf", COUNTER.replace(/\n/g, "\r\n"), { initInput: { start: 7 } });
  assert.equal(ok(vm.call({ programUuid: "crlf", functionName: "get", context: user("a") })).result, 7);
});
