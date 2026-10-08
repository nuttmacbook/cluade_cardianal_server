import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { EVENTFUL } from "./programs.js";

/* query แบบอ่านอย่างเดียว, ดัชนี event และเพดานขนาดค่า */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, ...options });
  vm.db.load({ "alice:native:received": 1_000_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "token", code: EVENTFUL, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 });
  block.init({ programUuid: "token" });
  block.commit();
  return vm;
}

// ---------------------------------------------------------------------------
//  query
// ---------------------------------------------------------------------------

test("query: อ่านค่าได้โดยไม่กิน nonce ไม่เสียค่าแก๊ส ไม่เขียน DB", () => {
  const vm = setup();
  const before = vm.db.snapshot();

  const res = vm.query({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 30 }, context: user("alice") });
  assert.equal(res.status, "success");
  assert.equal(res.readOnly, true);
  assert.equal(res.writes, undefined);
  assert.equal(res.fee, 0);
  assert.deepEqual(res.events.map((event) => event.name), ["Transfer"]);   // ยังเห็น event ที่จะเกิด

  assert.deepEqual(vm.db.snapshot(), before);          // DB ไม่เปลี่ยน
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], 1); // nonce ยังเท่าเดิม (จาก deploy)
});

test("query: ระบุผู้เรียกได้ และ error ของโปรแกรมยังบอกเหมือนเดิม", () => {
  const vm = setup();
  const ok = vm.query({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 10 }, context: user("alice") });
  assert.equal(ok.status, "success");

  const failed = vm.query({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99_999 }, context: user("alice") });
  assert.equal(failed.error.message, "ยอดไม่พอ");
});

// ---------------------------------------------------------------------------
//  ดัชนี event
// ---------------------------------------------------------------------------

test("event: ถูกทำดัชนีตอน commit และค้นย้อนหลังได้", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 10 }, context: user("alice"), nonce: 1 });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "carol", amount: 20 }, context: user("alice"), nonce: 2 });
  block.commit();

  const events = vm.listEvents({ program: "token", name: "Transfer" });
  assert.equal(events.length, 2);
  assert.equal(vm.listEvents({ program: "token" }).length, 3);   // รวม Created ตอน init
  assert.deepEqual(events.map((event) => event.data.to), ["carol", "bob"]);          // ใหม่ไปเก่า
  assert.equal(events[0].blockNumber, 2);
  assert.equal(events[0].txIndex, 1);
  assert.equal(events[0].txHash, vm.getBlock(2).txHashes[1]);
  assert.equal(vm.listEvents({ program: "token", name: "Transfer", limit: 1 }).length, 1);
  assert.equal(vm.listEvents({ program: "token", name: "Transfer", reverse: false })[0].data.to, "bob");
});

test("event: กรองตามชื่อ event ได้", () => {
  const vm = setup();
  assert.deepEqual(vm.listEvents({ program: "token", name: "Created" }).map((event) => event.name), ["Created"]);
  assert.deepEqual(vm.listEvents({ program: "token", name: "RelayDone" }), []);
  assert.deepEqual(vm.listEvents({ program: "ไม่มีโปรแกรมนี้" }), []);
});

test("event: tx ที่ล้มไม่เข้าดัชนี", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T + 1000, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99_999 }, context: user("alice"), nonce: 1 });
  block.commit();
  assert.deepEqual(vm.listEvents({ program: "token", name: "RelayDone" }), []);
});

test("event: decodeDbKey อ่าน key ของดัชนีออก", () => {
  assert.deepEqual(VM.decodeDbKey("event:token:Transfer:000000000002:0001:0000"),
    { kind: "event", program: "token", name: "Transfer", number: 2, txIndex: 1, eventIndex: 0 });
});

// ---------------------------------------------------------------------------
//  เพดานขนาดค่า
// ---------------------------------------------------------------------------

const BIG = `
function program() {
  function writeBig(params) { writeDB("big", "x".repeat(Number(params.input.size))) }
  function returnBig(params) { return "x".repeat(Number(params.input.size)) }
  function emitBig(params) { emit("Big", { data: "x".repeat(Number(params.input.size)) }) }
  return { writeBig, returnBig, emitBig }
}
`;

test("ค่าใหญ่เกิน maxValueSize → tx ล้มใบเดียว", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { maxValueSize: 1000, recordBlocks: true });
  vm.commit(vm.deploy({ programUuid: "big", code: BIG, context: user("alice") }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "big" }, { timestamp: T }).writes);

  const call = (fn, size) => vm.call({ programUuid: "big", functionName: fn, input: { size }, context: user("alice") }, { timestamp: T + 1 });
  for (const fn of ["writeBig", "returnBig", "emitBig"]) {
    assert.equal(call(fn, 100).status, "success", fn);
    const tooBig = call(fn, 5000);
    assert.equal(tooBig.error.code, "INVALID_REQUEST", fn);
    assert.match(tooBig.error.message, /ค่าใหญ่เกินกำหนด/);
  }
});

test("ค่าเริ่มต้นของเพดาน", () => {
  assert.equal(VM.DEFAULT_OPTIONS.maxValueSize, 64 * 1024);
  assert.equal(VM.DEFAULT_OPTIONS.maxKeySize, 1000);
});
