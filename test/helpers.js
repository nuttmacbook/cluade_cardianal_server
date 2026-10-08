import assert from "node:assert/strict";
import * as VM from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js";

export { MemoryDB };

/** VM ตัวเดียวที่ทุกเทสต์ใช้ */
export const vm = new VM.VirtualMachine(new MemoryDB());

/** ข้อมูลภายใน DB (Map) ใช้ตรวจ / จัดเตรียมข้อมูลในเทสต์ */
export const mockData = vm.db.data;

export { VM };

export const TEST_TIMEOUT_MS = 300;

/** ล้าง DB จำลองและคืนค่า config ก่อนทุกเทสต์ */
export function resetVM() {
  vm.db.clear();
  vm.timeoutMs = TEST_TIMEOUT_MS;
  vm.maxCallDepth = 8;
}

export const user = (name, origin = name) => ({ sender: name, origin });

/** VM ตัวใหม่ที่มี DB ของตัวเอง (ใช้เมื่อต้องการ option ต่างจากค่าเริ่มต้นของเทสต์) */
let extraVmCount = 0;
export function createVm(options = {}) {
  extraVmCount += 1;
  return new VM.VirtualMachine(new MemoryDB(), { timeoutMs: TEST_TIMEOUT_MS, ...options });
}

/** บันทึก writes ลง DB ผ่าน vm.commit → db.writeKeys (ทำเฉพาะเมื่อ success) */
export function save(res) {
  if (res.status === "success") vm.commit(res.writes);
  return res;
}

export function ok(res) {
  assert.equal(res.status, "success", `คาดว่า success แต่ได้ ${JSON.stringify(res.error)}`);
  return save(res);
}

export function fails(res, code, message) {
  assert.equal(res.status, "throw", `คาดว่า throw แต่ได้ success: ${JSON.stringify(res.result)}`);
  assert.equal(res.error.code, code, res.error.message);
  if (message instanceof RegExp) assert.match(res.error.message, message);
  else if (message !== undefined) assert.equal(res.error.message, message);
  assert.deepEqual(Object.keys(res).sort(), ["accepted", "calls", "debug", "error", "events", "fee", "gasPrice", "gasUsed", "status", "timestamp", "writes"], "throw ต้องไม่มี loadValues / afterValues");
  assert.deepEqual(res.writes, [], "throw ต้องไม่มี writes ของโปรแกรม (ยกเว้น nonce / ค่าแก๊ส)");
  return res;
}

/** deploy + init + บันทึก */
export function activate(programUuid, code, { context = user("owner"), initInput } = {}) {
  ok(vm.deploy({ programUuid, code, context, initInput }));
  return ok(vm.init({ programUuid }));
}

export function callAs(sender, programUuid, functionName, input) {
  return vm.call({ programUuid, functionName, input, context: user(sender) });
}

/** สรุป calls ให้อ่านง่าย: "depth:program.fn:status[:code]" */
export function trace(res) {
  return res.calls.map((c) => `${c.depth}:${c.programUuid}.${c.functionName}:${c.status}${c.error ? `:${c.error.code}` : ""}`);
}

/** อ่านค่าที่บันทึกแล้วของโปรแกรม: stored("token", "balances", "alice") */
export function stored(programUuid, ...parts) {
  const key = parts.length === 1 ? parts[0] : VM.map(...parts);
  return mockData.get(VM.storageKey(programUuid, key));
}

export const dbKeys = (res) => res.writes.map((w) => `${w.type} ${w.dbKey}`);
