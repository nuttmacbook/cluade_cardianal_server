import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { WALLET, TREASURY, TOKEN } from "./programs.js";

/*
 * value ที่แนบไปกับ tx / runProgram, gasLimit ที่ user กำหนด
 * และการแบ่งค่าแก๊สให้ผู้ปิด block (feeRecipient / burnPercent)
 */

const T = 1_700_000_000_000;
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

function setup(options = {}, balances = {}) {
  const { vm: base } = { vm: new VM.VirtualMachine(new MemoryDB(), options) };
  const plain = new VM.VirtualMachine(base.db);
  const save = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    base.commit(res.writes);
    return res;
  };
  for (const [id, code] of [["wallet", WALLET], ["wallet2", WALLET], ["treasury", TREASURY]]) {
    save(plain.deploy({ programUuid: id, code, context: user("owner") }));
    save(plain.init({ programUuid: id }));
  }
  base.commit(Object.entries(balances).map(([address, value]) => ({ type: "put", dbKey: `${address}:native:received`, value })));
  return base;
}

const native = (vm, address) => vm.nativeBalanceOf(address).balance;
const nativeWrites = (res) => Object.fromEntries(res.writes.filter((w) => w.dbKey.includes(":native:")).map((w) => [w.dbKey.replace(":native:", ":"), w.value]));

// ---------------------------------------------------------------------------
//  value ที่แนบไปกับ tx
// ---------------------------------------------------------------------------

test("value: แนบเงินไปกับ call → โอนจาก sender ไปโปรแกรม และโปรแกรมเห็น params.value", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 250 });

  assert.equal(res.status, "success");
  assert.equal(res.result, 250);
  assert.deepEqual(nativeWrites(res), { "alice:sended": 250, "wallet:received": 250 });
  vm.commit(res.writes);
  assert.equal(native(vm, "wallet"), 250);
  assert.equal(vm.db.readKeys(["wallet:storage:deposits:alice"])[0], 250);
});

test("value: ไม่แนบ → params.value = 0 และไม่มี writes ของ native", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });
  assert.equal(res.result, 0);
  assert.deepEqual(nativeWrites(res), {});
});

test("value: ยอดไม่พอ → ไม่มีอะไรเปลี่ยน", () => {
  const vm = setup({}, { alice: 100 });
  const res = vm.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 500 });
  assert.equal(res.error.code, "PROGRAM_ERROR");
  assert.match(res.error.message, /ยอด native ของ 'alice' ไม่พอ/);
  assert.deepEqual(res.writes, []);
});

test("value: ต้องเป็นจำนวนเต็มไม่ติดลบ", () => {
  const vm = setup({}, { alice: 1000 });
  for (const value of [-1, 1.5, "10", null]) {
    assert.equal(vm.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value }).error.code, "INVALID_REQUEST");
  }
});

test("value: โปรแกรมปฏิเสธเงิน (throw) → เงินกลับคืนทั้งหมด", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "rejectMoney", context: user("alice"), value: 10 });
  assert.equal(res.error.message, "ไม่รับเงิน");
  assert.deepEqual(res.writes, []);
  assert.equal(native(vm, "alice"), 1000);
});

// ---------------------------------------------------------------------------
//  value ที่แนบไปกับ runProgram
// ---------------------------------------------------------------------------

test("runProgram: แนบเงินต่อไปยังโปรแกรมถัดไป", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "forward", input: { target: "wallet2", value: 60 }, context: user("alice"), value: 100 });

  assert.equal(res.status, "success");
  assert.equal(res.result, 60);
  assert.deepEqual(nativeWrites(res), { "alice:sended": 100, "wallet:received": 100, "wallet:sended": 60, "wallet2:received": 60 });
  // ผู้รับเงินชั้นในเห็น origin เป็น alice แต่เงินมาจากกระเป๋าของ wallet
  assert.deepEqual(res.calls.map((c) => `${c.programUuid}.${c.functionName}:${c.sender}`), ["wallet.forward:alice", "wallet2.deposit:wallet"]);
  vm.commit(res.writes);
  assert.equal(vm.db.readKeys(["wallet2:storage:deposits:alice"])[0], 60);
});

test("runProgram: ส่งต่อทั้งก้อนที่รับมา", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "forwardAll", input: { target: "wallet2" }, context: user("alice"), value: 100 });
  assert.deepEqual(nativeWrites(res), { "alice:sended": 100, "wallet:received": 100, "wallet:sended": 100, "wallet2:received": 100 });
});

test("runProgram: แนบเกินกว่าที่โปรแกรมมี → error ที่ catch ได้ และเงินถูกย้อน", () => {
  const vm = setup({}, { alice: 1000 });
  const failed = vm.call({ programUuid: "wallet", functionName: "forwardTooMuch", input: { target: "wallet2" }, context: user("alice"), value: 50 });
  assert.equal(failed.error.code, "PROGRAM_ERROR");
  assert.match(failed.error.message, /ยอด native ของ 'wallet' ไม่พอ/);

  const caught = vm.call({ programUuid: "wallet", functionName: "forwardSafe", input: { target: "wallet2", value: 999 }, context: user("alice"), value: 50 });
  assert.equal(caught.status, "success");
  assert.deepEqual(nativeWrites(caught), { "alice:sended": 50, "wallet:received": 50 }); // เงินที่แนบมากับ tx ยังอยู่ที่ wallet
  assert.equal(caught.writes.at(-1).dbKey, "wallet:storage:lastError");
});

test("runProgram: ปลายทาง throw → เงินที่แนบไปถูกย้อนด้วย", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({
    programUuid: "wallet", functionName: "forwardSafe",
    input: { target: "wallet2", value: 10 }, context: user("alice"), value: 50,
  });
  vm.commit(res.writes);
  assert.equal(native(vm, "wallet2"), 10); // กรณีปกติ: ส่งต่อได้

  const vm2 = setup({}, { alice: 1000 });
  const rejected = vm2.call({ programUuid: "wallet", functionName: "forward", input: { target: "treasury", value: 10 }, context: user("alice"), value: 50 });
  assert.equal(rejected.status, "throw"); // treasury ไม่มีฟังก์ชัน deposit
  assert.deepEqual(rejected.writes, []);
});

// ---------------------------------------------------------------------------
//  gasLimit จาก user
// ---------------------------------------------------------------------------

test("gasLimit: ต่ำเกินไป → OUT_OF_GAS และหักเท่าที่ใช้ (ไม่เกิน limit)", () => {
  const vm = setup({ chargeGas: true }, { alice: 1_000_000 });
  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice"), gasLimit: 150 });

  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.deepEqual(nativeWrites(res), { "alice:consumed": 150, [`${VM.BURN_ADDRESS}:received`]: 150 }); // จ่ายเท่าเพดานที่ตั้งไว้
});

test("gasLimit: พอดี → สำเร็จและจ่ายตามจริง", () => {
  const vm = setup({ chargeGas: true }, { alice: 1_000_000 });
  const measured = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });
  assert.equal(measured.status, "success");

  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice"), gasLimit: measured.gasUsed });
  assert.equal(res.status, "success");
  assert.deepEqual(nativeWrites(res), { "alice:consumed": measured.gasUsed, [`${VM.BURN_ADDRESS}:received`]: measured.gasUsed });
});

test("gasLimit: ต้องเป็นจำนวนเต็มบวก และใช้ได้แม้ปิด chargeGas", () => {
  const vm = setup({}, { alice: 1000 });
  for (const gasLimit of [0, -1, 1.5, "100"]) {
    assert.equal(vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice"), gasLimit }).error.code, "INVALID_REQUEST");
  }
  const limited = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice"), gasLimit: 1 });
  assert.equal(limited.error.code, "OUT_OF_GAS"); // จำกัดงานได้แม้ไม่เก็บค่าแก๊ส
  assert.deepEqual(limited.writes, []);
});

test("gasLimit: value + ค่าแก๊ส ต้องไม่เกินยอดที่มี", () => {
  const vm = setup({ chargeGas: true }, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 1000 });
  assert.equal(res.error.code, "OUT_OF_GAS"); // แนบไปหมดแล้วไม่เหลือจ่ายค่าแก๊ส
  assert.deepEqual(res.writes, []);
});

// ---------------------------------------------------------------------------
//  ส่วนแบ่งค่าแก๊สให้ผู้ปิด block
// ---------------------------------------------------------------------------

const GAS = { call: 100, read: 0, write: 0, byte: 0, price: 1 };

test("fee: แบ่งให้ผู้ปิด block ตาม burnPercent", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "0xMINER", burnPercent: 30 }, { alice: 10_000 });
  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });

  assert.equal(res.gasUsed, 100);
  assert.deepEqual(nativeWrites(res), { "alice:consumed": 100, "0xminer:received": 70, [`${VM.BURN_ADDRESS}:received`]: 30 }); // เผา 30% → 0x000…000
});

test("fee: เผาทั้งหมด (ค่าเริ่มต้น) → ไม่มีใครได้ส่วนแบ่ง", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 10_000 });
  assert.deepEqual(nativeWrites(vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") })), { "alice:consumed": 100, [`${VM.BURN_ADDRESS}:received`]: 100 });
});

test("fee: ตั้ง feeRecipient / burnPercent ต่อ block ได้ และสะสมข้าม tx", () => {
  const vm = setup({ chargeGas: true, gas: GAS, burnPercent: 100 }, { alice: 10_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner-a", burnPercent: 0 });
  block.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });
  block.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });

  assert.equal(block.feeRecipient, "miner-a");
  assert.deepEqual(block.writes().filter((w) => w.dbKey.includes(":native:")), [
    { type: "put", dbKey: "alice:native:consumed", value: 200 },   // 100 + 100
    { type: "put", dbKey: "miner-a:native:received", value: 200 },
  ]);
  block.commit();
  assert.equal(native(vm, "miner-a"), 200);
});

test("fee: tx ที่ล้มก็จ่ายส่วนแบ่งให้ผู้ปิด block", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 50 }, { alice: 10_000 });
  const res = vm.call({ programUuid: "wallet", functionName: "rejectMoney", context: user("alice"), value: 5 });
  assert.equal(res.status, "throw");
  assert.deepEqual(nativeWrites(res), { "alice:consumed": 100, "miner:received": 50, [`${VM.BURN_ADDRESS}:received`]: 50 }); // เงินที่แนบไปถูกย้อน เหลือแต่ค่าแก๊ส
});

test("fee: ผู้ปิด block เป็นผู้ส่ง tx เอง → รวมเป็น write เดียว", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "alice", burnPercent: 40 }, { alice: 10_000 });
  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });
  assert.deepEqual(nativeWrites(res), { "alice:consumed": 100, "alice:received": 10_060, [`${VM.BURN_ADDRESS}:received`]: 40 }); // จ่ายค่าแก๊ส ได้ส่วนแบ่งคืน 60 เผา 40
});

test("fee: burnPercent ต้องเป็น 0-100", () => {
  for (const burnPercent of [-1, 101, 1.5, "50"]) {
    assert.throws(() => new VM.VirtualMachine(new MemoryDB(), { burnPercent }), { code: "INVALID_REQUEST" });
  }
});

test("block: value + ค่าแก๊ส + ส่วนแบ่ง ทำงานร่วมกันทั้ง block", () => {
  const vm = setup({ chargeGas: true, requireNonce: true, gas: GAS, burnPercent: 50 }, { alice: 10_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 300, nonce: 0 });
  block.call({ programUuid: "wallet", functionName: "forward", input: { target: "wallet2", value: 100 }, context: user("alice"), value: 200, nonce: 1 });

  assert.deepEqual(block.results().map((r) => r.status), ["success", "success"]);
  const writes = Object.fromEntries(block.writes().map((w) => [w.dbKey, w.value]));
  assert.equal(writes["alice:native:sended"], 500);     // value 300 + 200
  assert.equal(writes["alice:native:consumed"], 300);   // ค่าแก๊ส (1 + 2 call)
  assert.equal(writes["wallet:native:received"], 500);
  assert.equal(writes["wallet:native:sended"], 100);
  assert.equal(writes["wallet2:native:received"], 100);
  assert.equal(writes["miner:native:received"], 150);   // 50% ของ 300
  assert.equal(writes["alice:nonce"], 2);

  block.commit();
  assert.equal(native(vm, "alice") + native(vm, "wallet") + native(vm, "wallet2") + native(vm, "miner"), 10_000 - 150); // ส่วนที่เผาไป
});
