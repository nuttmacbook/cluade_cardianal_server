import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, mockData, resetVM, ok, fails, activate, callAs, trace, TEST_TIMEOUT_MS } from "./helpers.js";
import { FAULTY, PROBE, LOOP_AT_LOAD, THROW_AT_LOAD } from "./programs.js";

beforeEach(resetVM);

test("error: ข้อความจาก throw แบบต่าง ๆ", () => {
  activate("faulty", FAULTY);
  fails(callAs("a", "faulty", "throwError"), "PROGRAM_ERROR", "error message");
  fails(callAs("a", "faulty", "throwTypeError"), "PROGRAM_ERROR", /โปรแกรมทำงานผิดพลาด \(TypeError\)/);
  fails(callAs("a", "faulty", "throwReference"), "PROGRAM_ERROR", "โปรแกรมทำงานผิดพลาด (ReferenceError)");
  fails(callAs("a", "faulty", "throwString"), "PROGRAM_ERROR", "plain string");
  fails(callAs("a", "faulty", "throwNumber"), "PROGRAM_ERROR", "42");
  fails(callAs("a", "faulty", "throwObject"), "PROGRAM_ERROR", "[object Object]");
  fails(callAs("a", "faulty", "stackOverflow"), "PROGRAM_ERROR", "โปรแกรมทำงานผิดพลาด (RangeError)");
});

test("error: โปรแกรม catch error ของตัวเองได้", () => {
  activate("faulty", FAULTY);
  assert.equal(ok(callAs("a", "faulty", "catchOwnError")).result, "recovered: inside");
});

test("error: throw ตอนโหลดโปรแกรม (โค้ดนอกฟังก์ชัน)", () => {
  activate("throw-at-load", THROW_AT_LOAD);
  const res = fails(callAs("a", "throw-at-load", "hello"), "PROGRAM_ERROR", "load failed");
  assert.deepEqual(trace(res), ["0:throw-at-load.hello:throw:PROGRAM_ERROR"]);
});

test("error: object ที่ปลอม code timeout จากโปรแกรมซ้อน catch ได้ปกติ", () => {
  activate("faulty", FAULTY);
  activate("other", FAULTY);
  const res = ok(callAs("a", "faulty", "fakeTimeoutCaught", { target: "other" }));
  assert.equal(res.result, "TIMEOUT");
  assert.deepEqual(trace(res), ["0:faulty.fakeTimeoutCaught:success", "1:other.throwFakeTimeout:throw:TIMEOUT"]);
});

test("timeout: ลูปไม่รู้จบ → TIMEOUT ภายในเวลาที่กำหนด ไม่มี writes", () => {
  activate("faulty", FAULTY);
  const started = Date.now();
  const res = fails(callAs("a", "faulty", "spin"), "TIMEOUT", "โปรแกรมทำงานเกินเวลาที่กำหนด");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= TEST_TIMEOUT_MS - 5 && elapsed < TEST_TIMEOUT_MS + 200, `ใช้เวลา ${elapsed}ms`);
  assert.deepEqual(trace(res), ["0:faulty.spin:throw:TIMEOUT"]);
});

test("timeout: ชั้นในวนไม่รู้จบแม้ชั้นนอก catch → TIMEOUT ทั้งหมด (catch ไม่ได้)", () => {
  activate("faulty", FAULTY);
  activate("other", FAULTY);
  const res = fails(callAs("a", "faulty", "spinCatch", { target: "other" }), "TIMEOUT");
  assert.deepEqual(trace(res), ["0:faulty.spinCatch:throw:TIMEOUT", "1:other.spin:throw:TIMEOUT"]);
});

test("timeout: ลูปตอนโหลดโปรแกรม", () => {
  activate("loop", LOOP_AT_LOAD);
  fails(callAs("a", "loop", "hello"), "TIMEOUT");
});

test("timeout: เวลาถูกนับรวมทั้งสายการเรียก", () => {
  activate("faulty", FAULTY);
  activate("other", FAULTY);
  const half = Math.floor(TEST_TIMEOUT_MS * 0.6);
  const res = fails(callAs("a", "faulty", "busyThenCall", { ms: half, target: "other" }), "TIMEOUT");
  assert.deepEqual(trace(res), ["0:faulty.busyThenCall:throw:TIMEOUT", "1:other.busy:throw:TIMEOUT"]);
});

test("timeout: งานที่ใช้เวลาไม่เกินกำหนด → success", () => {
  activate("faulty", FAULTY);
  activate("other", FAULTY);
  const res = ok(callAs("a", "faulty", "busyThenCall", { ms: Math.floor(TEST_TIMEOUT_MS * 0.2), target: "other" }));
  assert.equal(res.result, Math.floor(TEST_TIMEOUT_MS * 0.2));
});

test("timeout: request ถัดไปได้เวลาใหม่ และ VM ใช้งานต่อได้", () => {
  activate("faulty", FAULTY);
  fails(callAs("a", "faulty", "spin"), "TIMEOUT");
  assert.equal(ok(callAs("a", "faulty", "returnNumber")).result, 1.5);
  ok(callAs("a", "faulty", "busy", { ms: Math.floor(TEST_TIMEOUT_MS * 0.5) }));
  ok(callAs("a", "faulty", "busy", { ms: Math.floor(TEST_TIMEOUT_MS * 0.5) }));
});

test("timeout: config.timeoutMs ปรับได้", () => {
  activate("faulty", FAULTY);
  vm.timeoutMs = 50;
  fails(callAs("a", "faulty", "busy", { ms: 100 }), "TIMEOUT");
  vm.timeoutMs = 500;
  ok(callAs("a", "faulty", "busy", { ms: 100 }));
});

test("timeout: initialization ที่เรียกโปรแกรมอื่นแล้ววน", () => {
  activate("faulty", FAULTY);
  const code = "function program() {\n  function initialization(params) {\n    try { runProgram(params.input.target, \"spin\", {}) } catch (e) {}\n  }\n}";
  ok(vm.deploy({ programUuid: "init-spin", code, context: { sender: "a", origin: "a" }, initInput: { target: "faulty" } }));
  const res = fails(vm.init({ programUuid: "init-spin" }), "TIMEOUT");
  assert.deepEqual(trace(res), ["0:init-spin.initialization:throw:TIMEOUT", "1:faulty.spin:throw:TIMEOUT"]);
  assert.ok(mockData.has("pending:init-spin"));
});

// ---------------------------------------------------------------------------
//  DB พัง: ทั้ง request ล้มเป็น INTERNAL เสมอ (โปรแกรม catch ไม่ได้)
// ---------------------------------------------------------------------------

const DB_DOWN = "อ่านข้อมูลจาก DB ไม่สำเร็จ: db down";

/** read ที่พังเมื่อ dbKey ตรงเงื่อนไข */
const failingRead = (shouldFail) => (dbKey) => {
  if (shouldFail(dbKey)) throw new Error("db down");
  return mockData.get(dbKey);
};

const runWith = (read, action) => vm.runAction(action, { read });
const ctxA = { sender: "a", origin: "a" };
const callWith = (read, programUuid, functionName, input) =>
  runWith(read, (tx) => vm.runFunction(tx, { programUuid, functionName, input, context: ctxA }));

test("DB พังตอนโหลดโค้ดโปรแกรม → INTERNAL", () => {
  const { timestamp, gasUsed, gasPrice, fee, accepted, events, debug, ...res } = callWith(() => { throw new Error("db down"); }, "p", "x");
  assert.equal(typeof timestamp, "number");
  assert.deepEqual(res, { status: "throw", error: { code: "INTERNAL", message: DB_DOWN }, calls: [], writes: [] });
});

test("DB พังระหว่าง readDB ในโปรแกรม → INTERNAL", () => {
  activate("probe", PROBE);
  const res = callWith(failingRead((k) => k.includes(":storage:")), "probe", "readKey", { key: "k" });
  assert.deepEqual(res.error, { code: "INTERNAL", message: DB_DOWN });
  assert.deepEqual(trace(res), ["0:probe.readKey:throw:INTERNAL"]);
});

test("DB พังแต่โปรแกรม catch ไว้ → ยัง INTERNAL และทุกชั้นเป็น throw", () => {
  activate("wrapper", PROBE);
  activate("probe", PROBE);
  const res = callWith(failingRead((k) => k.includes(":storage:")), "wrapper", "relayCatch", {
    target: "probe", fn: "readKey", args: { key: "k" },
  });
  assert.deepEqual(res.error, { code: "INTERNAL", message: DB_DOWN });
  assert.deepEqual(trace(res), ["0:wrapper.relayCatch:throw:INTERNAL", "1:probe.readKey:throw:INTERNAL"]);
});

test("DB พังตอนโหลดโค้ดของโปรแกรมปลายทาง แม้ผู้เรียก catch → INTERNAL", () => {
  activate("wrapper", PROBE);
  const res = callWith(failingRead((k) => k === "probe:code"), "wrapper", "relayCatch", { target: "probe", fn: "whoami" });
  assert.deepEqual(res.error, { code: "INTERNAL", message: DB_DOWN });
  assert.deepEqual(trace(res), ["0:wrapper.relayCatch:throw:INTERNAL"]);
});

test("DB พังครั้งเดียวแล้วกลับมาปกติ: โปรแกรม catch แล้วอ่านใหม่ก็ยัง INTERNAL", () => {
  const code = "function program() {\n  function retry() {\n    try { readDB(\"k\") } catch (e) {}\n    return readDB(\"k\")\n  }\n  return { retry }\n}";
  activate("retry", code);
  let failed = false;
  const flaky = failingRead((k) => k.includes(":storage:") && !failed && (failed = true));
  const res = callWith(flaky, "retry", "retry");
  assert.deepEqual(res.error, { code: "INTERNAL", message: DB_DOWN });
});

test("DB พังระหว่าง deploy / init → INTERNAL", () => {
  ok(vm.deploy({ programUuid: "p", code: PROBE, context: ctxA }));
  const originalGet = mockData.get;
  mockData.get = () => { throw new Error("db down"); }; // จำลอง readDB ใน mockupdb.js พัง
  try {
    fails(vm.deploy({ programUuid: "q", code: PROBE, context: ctxA }), "INTERNAL", DB_DOWN);
    fails(vm.init({ programUuid: "p" }), "INTERNAL", DB_DOWN);
    fails(vm.call({ programUuid: "p", functionName: "whoami", context: ctxA }), "INTERNAL", DB_DOWN);
  } finally {
    mockData.get = originalGet;
  }
});
