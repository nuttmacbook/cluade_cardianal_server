import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, resetVM, user, ok, MemoryDB } from "./helpers.js";
import { COUNTER, FAULTY } from "./programs.js";

beforeEach(resetVM);

let endpointCounter = 0;

/** VM ที่มี DB ของตัวเอง (endpoint ไม่ซ้ำ) */
function createVm(options) {
  const vm = new VM.VirtualMachine(new MemoryDB(), options);
  const save = (res) => {
    if (res.status === "success") vm.commit(res.writes);
    return res;
  };
  const activate = (programUuid, code, initInput) => {
    save(vm.deploy({ programUuid, code, context: user("x"), initInput }));
    save(vm.init({ programUuid }));
  };
  return { vm, save, activate };
}

test("class: ค่าเริ่มต้นของ VirtualMachine", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  assert.equal(vm.timeoutMs, VM.DEFAULT_OPTIONS.timeoutMs);
  assert.equal(vm.maxCallDepth, VM.DEFAULT_OPTIONS.maxCallDepth);
  assert.ok(vm.db instanceof MemoryDB);
  assert.ok(vm.compiler instanceof VM.Compiler);
  assert.ok(vm.createBlock() instanceof VM.Block);
  assert.ok(vm.createTransaction() instanceof VM.Transaction);
});

test("class: ไม่ส่ง db หรือส่ง object ที่ไม่ครบ → error", () => {
  assert.throws(() => new VM.VirtualMachine(), { code: "INTERNAL", message: /readKeys/ });
  assert.throws(() => new VM.VirtualMachine({ readKeys: () => [] }), { code: "INTERNAL" });
});

test("class: หลาย instance คนละ endpoint ใช้ DB และ config แยกกัน", () => {
  const a = createVm();
  const b = createVm({ timeoutMs: 50 });

  a.activate("counter", COUNTER, { start: 1 });
  assert.equal(a.vm.call({ programUuid: "counter", functionName: "get", context: user("x") }).result, 1);
  assert.equal(b.vm.call({ programUuid: "counter", functionName: "get", context: user("x") }).error.code, "NOT_FOUND");

  a.activate("faulty", FAULTY);
  b.activate("faulty", FAULTY);
  ok(a.vm.call({ programUuid: "faulty", functionName: "busy", input: { ms: 100 }, context: user("x") }));
  assert.equal(b.vm.call({ programUuid: "faulty", functionName: "busy", input: { ms: 100 }, context: user("x") }).error.code, "TIMEOUT");
});

test("class: แก้ timeoutMs ของ instance ระหว่างใช้งานได้", () => {
  const { vm, activate } = createVm();
  activate("faulty", FAULTY);
  vm.timeoutMs = 30;
  assert.equal(vm.call({ programUuid: "faulty", functionName: "busy", input: { ms: 60 }, context: user("x") }).error.code, "TIMEOUT");
  vm.timeoutMs = 500;
  assert.equal(vm.call({ programUuid: "faulty", functionName: "busy", input: { ms: 60 }, context: user("x") }).status, "success");
});

test("class: Block ใช้ DB ของ VM ที่สร้างมัน", () => {
  const { vm, activate } = createVm();
  activate("counter", COUNTER, { start: 10 });

  const block = vm.createBlock();
  block.call({ programUuid: "counter", functionName: "add", input: { amount: 1 }, context: user("x") });
  assert.equal(block.call({ programUuid: "counter", functionName: "add", input: { amount: 1 }, context: user("x") }).result, 12);
  assert.equal(vm.db.readKeys(["counter:storage:count"])[0], 10);

  block.commit();
  assert.equal(vm.db.readKeys(["counter:storage:count"])[0], 12);
});

test("class: สถานะภายใน Block เข้าถึงจากข้างนอกไม่ได้", () => {
  const block = new VM.VirtualMachine(new MemoryDB()).createBlock();
  assert.deepEqual(Object.keys(block), []);
  assert.equal(block.state, undefined);
});
