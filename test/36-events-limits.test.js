import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { EVENTFUL, PROBE } from "./programs.js";

/* emit ของโปรแกรม และเพดานความยาว key ของ storage */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, recordHistory: true, ...options });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "token", code: EVENTFUL, context: user("alice"), initInput: { supply: 1000 } });
  block.init({ programUuid: "token" });
  block.deploy({ programUuid: "relayer", code: EVENTFUL, context: user("alice"), initInput: { supply: 500 } });
  block.init({ programUuid: "relayer" });
  block.commit();
  return vm;
}

const call = (vm, programUuid, functionName, input = {}, sender = "alice") =>
  vm.call({ programUuid, functionName, input, context: user(sender) }, { timestamp: T + 1000 });

// ---------------------------------------------------------------------------
//  emit
// ---------------------------------------------------------------------------

test("emit: event อยู่ในผลลัพธ์ของ tx", () => {
  const vm = setup();
  const res = call(vm, "token", "transfer", { to: "bob", amount: 30 });

  assert.equal(res.status, "success");
  assert.deepEqual(res.events, [
    { index: 0, depth: 0, program: "token", name: "Transfer", data: { from: "alice", to: "bob", amount: 30 } },
  ]);
});

test("emit: initialization ก็ emit ได้ และเห็นตอน init", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  vm.commit(vm.deploy({ programUuid: "token", code: EVENTFUL, context: user("alice"), initInput: { supply: 10 } }, { timestamp: T }).writes);
  const res = vm.init({ programUuid: "token" }, { timestamp: T });
  assert.deepEqual(res.events, [{ index: 0, depth: 0, program: "token", name: "Created", data: { owner: "alice", supply: 10 } }]);
});

test("emit: เรียกซ้อน → เห็น event ของทุกชั้นพร้อม depth และชื่อโปรแกรม", () => {
  const vm = setup();
  vm.commit(call(vm, "token", "transfer", { to: "relayer", amount: 100 }).writes);
  const res = call(vm, "relayer", "relay", { target: "token", to: "carol", amount: 10 }, "relayer");

  assert.deepEqual(res.events.map((event) => `${event.depth} ${event.program}.${event.name}`), [
    "0 relayer.RelayStart",
    "1 token.Transfer",
    "0 relayer.RelayDone",
  ]);
  assert.deepEqual(res.events[1].data, { from: "relayer", to: "carol", amount: 10 });
});

test("emit: กิ่งที่ถูกย้อน → event ของกิ่งนั้นหายไปด้วย", () => {
  const vm = setup();
  const res = call(vm, "relayer", "relaySafe", { target: "token", to: "carol", amount: 999_999 }, "nobody");

  assert.equal(res.status, "success");
  assert.deepEqual(res.events.map((event) => event.name), ["RelayFailed"]); // ไม่มี Transfer ของกิ่งที่ล้ม
  assert.match(res.events[0].data.reason, /ยอดไม่พอ/);
});

test("emit: tx ที่ล้มทั้งใบ → ไม่มี event เลย", () => {
  const vm = setup();
  const res = call(vm, "token", "transfer", { to: "bob", amount: 999_999 });
  assert.equal(res.status, "throw");
  assert.deepEqual(res.events, []);
});

test("emit: ชื่อ event ต้องเป็นตัวอักษรอังกฤษ", () => {
  const vm = setup();
  assert.equal(call(vm, "token", "badName").error.code, "INVALID_REQUEST");
});

test("emit: อยู่ใน receipt ทั้งระดับ tx และระดับ block", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T + 2000, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 10 }, context: user("alice") });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "carol", amount: 20 }, context: user("alice") });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "dave", amount: 999_999 }, context: user("alice") }); // ล้ม

  const receipt = block.receipt();
  assert.deepEqual(receipt.transactions.map((tx) => tx.events.length), [1, 1, 0]);
  assert.deepEqual(receipt.events.map((event) => `${event.txIndex} ${event.name} ${event.data.to}`), [
    "0 Transfer bob",
    "1 Transfer carol",
  ]);
  assert.equal(receipt.events[0].txHash, receipt.transactions[0].hash);
});

test("emit: ย้อนดู event ของ block เก่าได้ด้วย replayBlock", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T + 2000, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 10 }, context: user("alice") });
  block.commit();

  for (let i = 0; i < 3; i += 1) {   // ปิด block เพิ่มอีก 3 อัน
    const next = vm.createBlock({ timestamp: T + 3000 + i * 1000, feeRecipient: "miner" });
    next.call({ programUuid: "token", functionName: "transfer", input: { to: "carol", amount: 1 }, context: user("alice") });
    next.commit();
  }

  const receipt = vm.replayBlock(2);
  assert.deepEqual(receipt.events.map((event) => event.data), [{ from: "alice", to: "bob", amount: 10 }]);
});

test("emit: คิดค่าแก๊สตามจำนวน event และขนาดข้อมูล", () => {
  const gas = { call: 0, read: 0, write: 0, byte: 0, event: 200, code: 0, price: 1 };
  const vm = setup({ chargeGas: true, gas });
  vm.db.load({ "alice:native:received": 1_000_000 });

  // transfer emit 1 event / relaySafe emit 1 event แต่ relay (สำเร็จ) emit 2
  const one = call(vm, "token", "transfer", { to: "bob", amount: 30 });
  assert.equal(one.gasUsed, gas.event);

  vm.commit(one.writes);
  vm.commit(call(vm, "token", "transfer", { to: "relayer", amount: 100 }).writes);
  const three = call(vm, "relayer", "relay", { target: "token", to: "carol", amount: 10 });
  assert.equal(three.events.length, 3);
  assert.equal(three.gasUsed, 3 * gas.event);
});

test("emit: ข้อมูลใน event ยิ่งใหญ่ยิ่งแพง", () => {
  const gas = { call: 0, read: 0, write: 0, byte: 1, event: 0, code: 0, price: 1 };
  const vm = setup({ chargeGas: true, gas });
  vm.db.load({ "alice:native:received": 1_000_000 });

  const small = call(vm, "token", "transfer", { to: "b", amount: 1 });
  const large = call(vm, "token", "transfer", { to: "b".repeat(100), amount: 1 });
  assert.equal(large.gasUsed - small.gasUsed, 99); // ชื่อผู้รับที่ยาวขึ้นอยู่ในข้อมูลของ event
});


// ---------------------------------------------------------------------------
//  เพดานความยาว key
// ---------------------------------------------------------------------------

test("key: ยาวเกิน 1000 ไบต์ → tx ล้มใบเดียว ไม่ลาก block", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  vm.commit(vm.deploy({ programUuid: "probe", code: PROBE, context: user("alice") }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "probe" }, { timestamp: T }).writes);

  const block = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  const ok = block.call({ programUuid: "probe", functionName: "writeKey", input: { key: "x".repeat(900), value: 1 }, context: user("alice") });
  const tooLong = block.call({ programUuid: "probe", functionName: "writeKey", input: { key: "x".repeat(1100), value: 1 }, context: user("alice") });

  assert.equal(ok.status, "success");
  assert.equal(tooLong.error.code, "INVALID_REQUEST");
  assert.match(tooLong.error.message, /key ของ storage ยาวเกินกำหนด/);
  block.commit();
  assert.equal(vm.getBlock(1).successCount, 1);
});

test("key: ภาษาไทยนับตามจำนวน byte จริง", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { maxKeySize: 200 });
  vm.commit(vm.deploy({ programUuid: "probe", code: PROBE, context: user("alice") }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "probe" }, { timestamp: T }).writes);

  const write = (key) => vm.call({ programUuid: "probe", functionName: "writeKey", input: { key, value: 1 }, context: user("alice") }, { timestamp: T });
  assert.equal(write("ก".repeat(10)).status, "success");     // 10 ตัว = 90 ไบต์หลัง encode
  assert.equal(write("ก".repeat(30)).error.code, "INVALID_REQUEST"); // 270 ไบต์
});

test("key: ค่าเริ่มต้นคือ 1000 ไบต์", () => {
  assert.equal(VM.DEFAULT_OPTIONS.maxKeySize, 1000);
});
