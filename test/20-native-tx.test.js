import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { FUNDED, WALLET } from "./programs.js";

/* vm.transfer (โอน native ระหว่าง address) และ value ที่แนบมากับ deploy */

const T = 1_700_000_000_000;
const user = (name) => ({ sender: name, origin: name });
const GAS = { call: 100, read: 0, write: 0, byte: 0, code: 0, price: 1 }; // code: 0 เพื่อให้ตัวเลขในเทสต์อ่านง่าย
let endpointCounter = 0;

function setup(options = {}, balances = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), options);
  vm.commit(Object.entries(balances).map(([address, value]) => ({ type: "put", dbKey: `${address}:native:received`, value })));
  return vm;
}

const native = (vm, address) => vm.nativeBalanceOf(address).balance;
const nativeWrites = (res) => Object.fromEntries(res.writes.filter((w) => w.dbKey.includes(":native:")).map((w) => [w.dbKey.replace(":native:", ":"), w.value]));

// ---------------------------------------------------------------------------
//  vm.transfer
// ---------------------------------------------------------------------------

test("transfer: โอนระหว่าง wallet โดยไม่เรียกโปรแกรม", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.transfer({ from: "alice", to: "BOB", amount: 300 });

  assert.equal(res.status, "success");
  assert.deepEqual(res.result, { from: "alice", to: "bob", amount: 300 });
  assert.deepEqual(res.calls, []);
  assert.deepEqual(res.writes, [
    { type: "put", dbKey: "alice:native:sended", value: 300 },
    { type: "put", dbKey: "bob:native:received", value: 300 },
  ]);
  vm.commit(res.writes);
  assert.equal(native(vm, "alice"), 700);
  assert.equal(native(vm, "bob"), 300);
});

test("transfer: โอนเข้ากระเป๋าโปรแกรมก็ได้ (ไม่มีโค้ดทำงาน)", () => {
  const vm = setup({}, { alice: 1000 });
  vm.commit(vm.transfer({ from: "alice", to: "wallet", amount: 100 }).writes);
  assert.equal(native(vm, "wallet"), 100);
});

test("transfer: ยอดไม่พอ / ค่าไม่ถูกต้อง", () => {
  const vm = setup({}, { alice: 100 });
  assert.equal(vm.transfer({ from: "alice", to: "bob", amount: 200 }).error.message, "ยอด native ของ 'alice' ไม่พอ");
  for (const request of [
    { from: "", to: "bob", amount: 1 },
    { from: "alice", to: "", amount: 1 },
    { from: "alice", to: "bob", amount: 0 },
    { from: "alice", to: "bob", amount: -5 },
    { from: "alice", to: "bob", amount: 1.5 },
    {},
  ]) {
    assert.equal(vm.transfer(request).error.code, "INVALID_REQUEST");
  }
  assert.equal(native(vm, "alice"), 100);
});

test("transfer: คิดค่าแก๊สและกิน nonce เหมือน tx อื่น", () => {
  const vm = setup({ requireNonce: true, chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 0 }, { alice: 10_000 });
  const res = vm.transfer({ from: "alice", to: "bob", amount: 500, nonce: 0 });

  assert.equal(res.gasUsed, GAS.call); // read / write คิด 0 ในเทสต์นี้
  assert.deepEqual(nativeWrites(res), { "alice:sended": 500, "bob:received": 500, "alice:consumed": 100, "miner:received": 100 });
  assert.equal(res.writes.find((w) => w.dbKey === "alice:nonce").value, 1);
  vm.commit(res.writes);
  assert.equal(vm.transfer({ from: "alice", to: "bob", amount: 1, nonce: 0 }).error.code, "INVALID_REQUEST");
});

test("transfer: ยอดต้องพอทั้งจำนวนที่โอนและค่าแก๊ส", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 1000 });
  assert.equal(vm.transfer({ from: "alice", to: "bob", amount: 1000 }).error.code, "OUT_OF_GAS");
  const res = vm.transfer({ from: "alice", to: "bob", amount: 900 });
  assert.equal(res.status, "success");
  assert.deepEqual(nativeWrites(res), { "alice:sended": 900, "bob:received": 900, "alice:consumed": 100, [`${VM.BURN_ADDRESS}:received`]: 100 });
});

test("transfer: ใช้ใน block ได้ และ tx ถัดไปเห็นยอดล่าสุด", () => {
  const vm = setup({}, { alice: 1000 });
  const block = vm.createBlock({ timestamp: T });
  block.transfer({ from: "alice", to: "bob", amount: 600 });
  const second = block.transfer({ from: "bob", to: "carol", amount: 500 });
  const failed = block.transfer({ from: "bob", to: "carol", amount: 500 });

  assert.equal(second.status, "success");
  assert.equal(failed.error.message, "ยอด native ของ 'bob' ไม่พอ");
  block.commit();
  assert.deepEqual([native(vm, "alice"), native(vm, "bob"), native(vm, "carol")], [400, 100, 500]);
});

// ---------------------------------------------------------------------------
//  value ตอน deploy
// ---------------------------------------------------------------------------

test("deploy พร้อม value: เงินย้ายไปที่โปรแกรมทันที และ initialization เห็น params.value", () => {
  const vm = setup({}, { alice: 1000 });
  const deployed = vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 400 });

  assert.equal(deployed.result.value, 400);
  assert.deepEqual(nativeWrites(deployed), { "alice:sended": 400, "funded:received": 400 });
  assert.equal(deployed.writes.find((w) => w.dbKey === "pending:funded").value.value, 400);
  vm.commit(deployed.writes);

  const initialized = vm.init({ programUuid: "funded" });
  assert.equal(initialized.result.value, 400);
  vm.commit(initialized.writes);
  assert.equal(vm.db.readKeys(["funded:storage:seed"])[0], 400);
  assert.equal(native(vm, "funded"), 400); // เงินยังอยู่ที่โปรแกรม
});

test("deploy พร้อม value: reject คืนเงินให้ผู้ deploy", () => {
  const vm = setup({}, { alice: 1000 });
  vm.commit(vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 400 }).writes);
  assert.equal(native(vm, "alice"), 600);

  const rejected = vm.reject({ programUuid: "funded" });
  assert.equal(rejected.result.refund, 400);
  assert.deepEqual(nativeWrites(rejected), { "funded:sended": 400, "alice:received": 1400 });
  vm.commit(rejected.writes);
  assert.equal(native(vm, "alice"), 1000);
  assert.equal(native(vm, "funded"), 0);
});

test("deploy พร้อม value: ยอดไม่พอ → ไม่มีอะไรเปลี่ยน", () => {
  const vm = setup({}, { alice: 100 });
  const res = vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 500 });
  assert.equal(res.error.message, "ยอด native ของ 'alice' ไม่พอ");
  assert.deepEqual(res.writes, []);
});

test("deploy: ไม่แนบ value → params.value = 0 และ refund = 0", () => {
  const vm = setup({}, { alice: 1000 });
  vm.commit(vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice") }).writes);
  vm.commit(vm.init({ programUuid: "funded" }).writes);
  assert.equal(vm.db.readKeys(["funded:storage:seed"])[0], 0);
});

test("deploy พร้อม value: โปรแกรมใช้เงินก้อนนั้นต่อได้หลัง init", () => {
  const vm = setup({}, { alice: 1000 });
  const block = vm.createBlock({ timestamp: T });
  block.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 400 });
  block.init({ programUuid: "funded" });
  const paid = block.call({ programUuid: "funded", functionName: "payBack", input: { amount: 150 }, context: user("alice") });

  assert.equal(paid.result, 150);
  block.commit();
  assert.equal(native(vm, "funded"), 250);
  assert.equal(native(vm, "alice"), 750);
});

test("deploy พร้อม value + ค่าแก๊ส: value + ค่าแก๊ส ต้องไม่เกินยอดที่มี", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 500 });
  assert.equal(vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 500 }).error.code, "OUT_OF_GAS");
  const res = vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 300 });
  assert.equal(res.status, "success");
  assert.deepEqual(nativeWrites(res), { "alice:sended": 300, "funded:received": 300, "alice:consumed": 100, [`${VM.BURN_ADDRESS}:received`]: 100 });
});

test("value ทั้งสาย: deploy → init → call พร้อม value → transferNative กลับ", () => {
  const vm = setup({}, { alice: 1000 });
  const block = vm.createBlock({ timestamp: T });
  block.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 100 });
  block.init({ programUuid: "funded" });
  block.deploy({ programUuid: "wallet", code: WALLET, context: user("alice") });
  block.init({ programUuid: "wallet" });
  block.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 200 });
  block.transfer({ from: "alice", to: "funded", amount: 50 });
  block.call({ programUuid: "funded", functionName: "payBack", input: { amount: 120 }, context: user("alice") });

  assert.ok(block.results().every((r) => r.status === "success"));
  block.commit();
  assert.equal(native(vm, "alice"), 1000 - 100 - 200 - 50 + 120);
  assert.equal(native(vm, "funded"), 100 + 50 - 120);
  assert.equal(native(vm, "wallet"), 200);
});

// ---------------------------------------------------------------------------
//  ยอดสะสม 3 ช่อง (received / sended / consumed)
// ---------------------------------------------------------------------------

test("native: ยอดคงเหลือ = received - sended - consumed และทุกช่องเพิ่มอย่างเดียว", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 1000 });
  assert.deepEqual(vm.nativeBalanceOf("alice"), { received: 1000, sended: 0, consumed: 0, balance: 1000 });

  vm.commit(vm.transfer({ from: "alice", to: "bob", amount: 200 }).writes);
  assert.deepEqual(vm.nativeBalanceOf("alice"), { received: 1000, sended: 200, consumed: 100, balance: 700 });
  assert.deepEqual(vm.nativeBalanceOf("bob"), { received: 200, sended: 0, consumed: 0, balance: 200 });

  vm.commit(vm.transfer({ from: "bob", to: "alice", amount: 50 }).writes);
  const alice = vm.nativeBalanceOf("alice");
  const bob = vm.nativeBalanceOf("bob");
  assert.deepEqual(alice, { received: 1050, sended: 200, consumed: 100, balance: 750 });
  assert.deepEqual(bob, { received: 200, sended: 50, consumed: 100, balance: 50 });
  for (const value of [alice.received, alice.sended, alice.consumed, bob.received, bob.sended, bob.consumed]) assert.ok(value >= 0);
});

test("native: address ที่ไม่เคยมีอะไรเลย → ทุกช่องเป็น 0", () => {
  const vm = setup();
  assert.deepEqual(vm.nativeBalanceOf("ไม่มีใคร"), { received: 0, sended: 0, consumed: 0, balance: 0 });
});

test("native: โปรแกรมก็มี 3 ช่องเหมือน wallet", () => {
  const vm = setup({}, { alice: 1000 });
  vm.commit(vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 400 }).writes);
  vm.commit(vm.init({ programUuid: "funded" }).writes);
  vm.commit(vm.call({ programUuid: "funded", functionName: "payBack", input: { amount: 150 }, context: user("alice") }).writes);

  assert.deepEqual(vm.nativeBalanceOf("funded"), { received: 400, sended: 150, consumed: 0, balance: 250 });
  assert.deepEqual(vm.nativeBalanceOf("alice"), { received: 1150, sended: 400, consumed: 0, balance: 750 }); // 1000 ตั้งต้น + 150 ที่ได้คืน
});

test("native: ยอดรวมของทั้งระบบ = เงินที่ใส่เข้ามา - ค่าแก๊สที่ถูกเผา", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 50 }, { alice: 10_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner", burnPercent: 50 });
  block.transfer({ from: "alice", to: "bob", amount: 100 });
  block.transfer({ from: "bob", to: "carol", amount: 40 });
  block.commit();

  const accounts = ["alice", "bob", "carol", "miner"].map((address) => vm.nativeBalanceOf(address));
  const total = accounts.reduce((sum, account) => sum + account.balance, 0);
  const burned = accounts.reduce((sum, account) => sum + account.consumed, 0) - vm.nativeBalanceOf("miner").received;
  assert.equal(total, 10_000 - burned);
});
