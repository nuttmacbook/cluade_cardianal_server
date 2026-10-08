import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { INSPECTOR, TOKEN } from "./programs.js";

/* API ที่โปรแกรมเรียกได้: ThisBalance / BalanceOf / IsProgram / MetadataOf / BlockNumber */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });

function setup({ balances = {}, ...options } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, recordHistory: true, ...options });
  vm.db.load(Object.fromEntries(Object.entries(balances).map(([address, value]) => [`${address}:native:received`, value])));

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "inspector", code: INSPECTOR, context: user("owner"), initInput: { name: "ผู้ตรวจ" } });
  block.init({ programUuid: "inspector" });
  block.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 100 } });
  block.init({ programUuid: "token" });
  block.commit();
  return vm;
}

const call = (vm, functionName, input = {}, options = {}) =>
  vm.call({ programUuid: "inspector", functionName, input, context: user("alice"), ...options }, { timestamp: T + 1000 });

// ---------------------------------------------------------------------------

test("ThisBalance: ยอดของโปรแกรมเอง และเปลี่ยนตามการรับเงิน", () => {
  const vm = setup({ balances: { alice: 1000 } });
  assert.equal(call(vm, "me").result.balance, 0);

  const res = call(vm, "me", {}, { value: 250 });   // แนบเงินมากับ call
  assert.equal(res.result.balance, 250);
  vm.commit(res.writes);
  assert.equal(call(vm, "me").result.balance, 250);
});

test("ThisBalance: เห็นยอดล่าสุดหลังโอนออกในการเรียกเดียวกัน", () => {
  const vm = setup({ balances: { alice: 1000 } });
  vm.commit(vm.transfer({ from: "alice", to: "inspector", amount: 500 }, { timestamp: T + 500 }).writes);

  const res = call(vm, "sendAll", { to: "bob" });
  assert.equal(res.result, 0);                       // โอนออกหมดแล้ว ยอดเป็น 0 ทันที
  assert.equal(res.writes.find((w) => w.dbKey === "bob:native:received").value, 500);
});

test("BalanceOf: ดูยอดของ address อื่นได้", () => {
  const vm = setup({ balances: { alice: 1000, bob: 42 } });
  assert.equal(call(vm, "look", { address: "bob" }).result.balance, 42);
  assert.equal(call(vm, "look", { address: "ไม่มีใคร" }).result.balance, 0);
  assert.equal(call(vm, "look", { address: "0xALICE" }).result.balance, 0); // คนละ address กับ alice
});

test("IsProgram: แยก wallet กับโปรแกรมได้", () => {
  const vm = setup({ balances: { alice: 1000 } });
  assert.equal(call(vm, "look", { address: "token" }).result.isProgram, true);
  assert.equal(call(vm, "look", { address: "inspector" }).result.isProgram, true);
  assert.equal(call(vm, "look", { address: "alice" }).result.isProgram, false);
});

test("IsProgram: ใช้กันการโอนเข้าโปรแกรมที่รับเงินไม่เป็น", () => {
  const vm = setup({ balances: { alice: 1000 } });
  vm.commit(vm.transfer({ from: "alice", to: "inspector", amount: 300 }, { timestamp: T + 500 }).writes);

  assert.equal(call(vm, "payIfWallet", { to: "bob", amount: 100 }).result, 200);
  const blocked = call(vm, "payIfWallet", { to: "token", amount: 100 });
  assert.equal(blocked.error.message, "ปลายทางเป็นโปรแกรม");
});

test("MetadataOf: อ่าน metadata ของ address อื่น", () => {
  const vm = setup({ balances: { alice: 1000 } });
  const result = call(vm, "look", { address: "inspector" }).result;
  assert.equal(result.namespace, "ผู้ตรวจ");
  assert.equal(result.creator, "owner");

  assert.equal(call(vm, "look", { address: "alice" }).result.namespace, null); // wallet ที่ยังไม่ตั้งชื่อ
});

test("BlockNumber: เลข block ที่ tx อยู่ (null เมื่อรันนอก block)", () => {
  const vm = setup({ balances: { alice: 1000 } });
  assert.equal(call(vm, "me").result.block, null);   // เรียกตรงผ่าน vm.call

  const block = vm.createBlock({ timestamp: T + 2000, feeRecipient: "miner" });
  const res = block.call({ programUuid: "inspector", functionName: "me", context: user("alice") });
  assert.equal(res.result.block, 2);
  assert.equal(block.number, 2);
});

test("ตรวจค่าที่ส่งเข้ามา: address ว่าง / field ว่าง → INVALID_REQUEST", () => {
  const vm = setup({ balances: { alice: 1000 } });
  assert.equal(call(vm, "look", { address: "" }).error.code, "INVALID_REQUEST");
  assert.equal(call(vm, "look", { address: 123 }).error.code, "INVALID_REQUEST");
});

test("ค่าแก๊ส: API ที่อ่าน DB คิดค่าแก๊สตามจำนวน key ที่อ่าน", () => {
  const gas = { call: 0, read: 10, write: 0, byte: 0, code: 0, price: 1 };
  const vm = setup({ balances: { alice: 1_000_000 }, chargeGas: true, gas });

  const balance = call(vm, "me");                                   // ThisBalance = 3 read
  assert.equal(balance.gasUsed, 3 * gas.read);

  const look = call(vm, "look", { address: "token" });               // 3 (BalanceOf) + 1 (IsProgram) + 2 (MetadataOf)
  assert.equal(look.gasUsed, 6 * gas.read);
});

test("API ใหม่ใช้ได้ทั้งในโปรแกรมที่ถูกเรียกซ้อน", () => {
  const vm = setup({ balances: { alice: 1000 } });
  vm.commit(vm.transfer({ from: "alice", to: "inspector", amount: 100 }, { timestamp: T + 500 }).writes);

  // token.transfer เรียกจาก inspector → inspector ยังเห็นยอดของตัวเองถูกต้อง
  const res = call(vm, "me");
  assert.equal(res.result.balance, 100);
  assert.equal(res.result.address, "inspector");
});
