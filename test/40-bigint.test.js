import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";

/*
 * โหมด bigintValues: ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น
 *   - เก็บใน DB เป็น string ลงท้าย n ("1000n")
 *   - แปลงเป็น BigInt อัตโนมัติเมื่อส่งเข้าโปรแกรม แปลงกลับเป็น string เมื่อออกจากโปรแกรม
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });

const TOKEN = `
function program() {
  function initialization(params) {
    writeDB("owner", params.context.sender)
    writeDB(map("balances", params.context.sender), params.input.supply)
  }

  function balanceOf(params) { return readDB(map("balances", params.input.who)) || 0n }

  function transfer(params) {
    const from = params.context.sender
    const balance = readDB(map("balances", from)) || 0n
    if (balance < params.input.amount) throw new Error("ยอดไม่พอ")
    writeDB(map("balances", from), balance - params.input.amount)
    writeDB(map("balances", params.input.to), (readDB(map("balances", params.input.to)) || 0n) + params.input.amount)
    emit("Transfer", { from, to: params.input.to, amount: params.input.amount })
    return balance - params.input.amount
  }

  function bigMath(params) {
    return { sum: params.input.a + params.input.b, product: params.input.a * params.input.b }
  }

  function info(params) {
    return { time: params.block.timestamp, block: BlockNumber(), balance: ThisBalance(), value: params.value }
  }

  function payout(params) { transferNative(params.input.to, params.input.amount); return ThisBalance() }

  function useNumber() { return 1 + 1 }
  function writeNumber() { writeDB("bad", 5) }

  return { balanceOf, transfer, bigMath, info, payout, useNumber, writeNumber }
}
`;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { bigintValues: true, recordBlocks: true, ...options });
  vm.db.load({ "alice:native:received": 1_000_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } });
  block.init({ programUuid: "token" });
  block.commit();
  return vm;
}

const call = (vm, functionName, input = {}, extra = {}) =>
  vm.call({ programUuid: "token", functionName, input, context: user("alice"), ...extra }, { timestamp: T + 1000 });

// ---------------------------------------------------------------------------

test("เก็บใน DB เป็น string ลงท้าย n", () => {
  const vm = setup();
  assert.equal(vm.db.readKeys(["token:storage:balances:alice"])[0], "1000n");
  assert.equal(vm.db.readKeys(["token:storage:owner"])[0], "alice");   // string ยังเป็น string
});

test("input ที่เป็นตัวเลขธรรมดาถูกแปลงเป็น BigInt ให้อัตโนมัติ", () => {
  const vm = setup();
  const res = call(vm, "transfer", { to: "bob", amount: 30 });         // client ส่ง 30 มาปกติ
  assert.equal(res.status, "success");
  assert.equal(res.result, "970n");                                    // ผลลัพธ์ออกมาเป็น string
  vm.commit(res.writes);
  assert.deepEqual(vm.db.readKeys(["token:storage:balances:alice", "token:storage:balances:bob"]), ["970n", "30n"]);
});

test("input ที่ส่งมาเป็น \"123n\" ก็ใช้ได้", () => {
  const vm = setup();
  const res = call(vm, "transfer", { to: "bob", amount: "250n" });
  assert.equal(res.result, "750n");
});

test("ตัวเลขใหญ่เกิน 2^53 ทำงานได้ถูกต้อง", () => {
  const vm = setup();
  const huge = 10n ** 30n;
  const res = call(vm, "bigMath", { a: `${huge}n`, b: "3n" });
  assert.deepEqual(res.result, { sum: `${huge + 3n}n`, product: `${huge * 3n}n` });
});

test("เวลา / เลข block / ยอดเงิน ที่โปรแกรมเห็นเป็น BigInt", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T + 2000, feeRecipient: "miner" });
  const res = block.call({ programUuid: "token", functionName: "info", context: user("alice"), value: 500 });

  assert.deepEqual(res.result, { time: `${T + 2000}n`, block: "2n", balance: "500n", value: "500n" });
});

test("transferNative รับ BigInt", () => {
  const vm = setup();
  vm.commit(vm.transfer({ from: "alice", to: "token", amount: 1000 }, { timestamp: T + 500 }).writes);
  const res = call(vm, "payout", { to: "bob", amount: 400 });
  assert.equal(res.result, "600n");
  vm.commit(res.writes);
  assert.equal(vm.nativeBalanceOf("bob").balance, 400);
});

test("event เก็บตัวเลขเป็น string ลงท้าย n", () => {
  const vm = setup();
  const res = call(vm, "transfer", { to: "bob", amount: 30 });
  assert.deepEqual(res.events[0].data, { from: "alice", to: "bob", amount: "30n" });
});

test("ใช้ number ในโปรแกรม → ถูกปฏิเสธ", () => {
  const vm = setup();
  assert.match(call(vm, "useNumber").error.message, /ต้องเป็น BigInt/);
  assert.match(call(vm, "writeNumber").error.message, /ต้องเป็น BigInt/);
});

test("ทศนิยมใน input → ถูกปฏิเสธ", () => {
  const vm = setup();
  assert.match(call(vm, "balanceOf", { who: "alice", extra: 1.5 }).error.message, /ต้องเป็น BigInt/);
});

test("เทียบค่าและคำนวณข้ามฟังก์ชันได้ปกติ", () => {
  const vm = setup();
  assert.equal(call(vm, "balanceOf", { who: "alice" }).result, "1000n");
  assert.equal(call(vm, "balanceOf", { who: "ไม่มีใคร" }).result, "0n");
  assert.match(call(vm, "transfer", { to: "bob", amount: 99_999 }).error.message, /ยอดไม่พอ/);
});

test("ปิดโหมด bigint → ใช้ number ได้เหมือนเดิม", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  const code = `function program() {
  function initialization() { writeDB("count", 0) }
  function add(params) { writeDB("count", readDB("count") + params.input.amount); return readDB("count") }
  return { add }
}`;
  vm.commit(vm.deploy({ programUuid: "counter", code, context: user("alice") }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "counter" }, { timestamp: T }).writes);
  const res = vm.call({ programUuid: "counter", functionName: "add", input: { amount: 5 }, context: user("alice") }, { timestamp: T });
  assert.equal(res.result, 5);
  assert.equal(vm.db.readKeys(["counter:storage:count"])[0], 0);
});

test("helper แปลงค่าไปกลับ", () => {
  assert.deepEqual(VM.encodeBigints({ a: 10n, b: ["x", 2n] }), { a: "10n", b: ["x", "2n"] });
  assert.deepEqual(VM.decodeBigints({ a: "10n", b: 5, c: "ปกติ" }), { a: 10n, b: 5n, c: "ปกติ" });
  assert.equal(VM.canonicalJson({ amount: 10n }), '{"amount":"10n"}');
});
