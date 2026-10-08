import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN, TREASURY, COUNTER } from "./programs.js";

/*
 * nonce (<addr>:nonce) และค่าแก๊ส (<addr>:native:consumed)
 *   - เปิดด้วย requireNonce / chargeGas ตอนสร้าง VM
 *   - ผู้จ่ายค่าแก๊สคือ sender ของ tx ชั้นนอกสุดเท่านั้น
 *   - tx ที่ล้มก็ยังกิน nonce และค่าแก๊ส
 */

const T = 1_700_000_000_000;
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

function setup({ requireNonce = true, chargeGas = true, gas, balances = {} } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce, chargeGas, gas });
  const plain = new VM.VirtualMachine(vm.db); // VM ที่ไม่เก็บค่าแก๊ส ใช้เตรียมข้อมูล
  const save = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    vm.commit(res.writes);
    return res;
  };
  save(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }));
  save(plain.init({ programUuid: "token" }));
  save(plain.deploy({ programUuid: "treasury", code: TREASURY, context: user("alice") }));
  save(plain.init({ programUuid: "treasury" }));
  vm.commit(Object.entries(balances).map(([address, value]) => ({ type: "put", dbKey: `${address}:native:received`, value })));
  return { vm, plain };
}

const balanceOf = (vm, address) => vm.nativeBalanceOf(address).balance;
const nonceOf = (vm, address) => vm.db.readKeys([`${address}:nonce`])[0];
const transfer = (nonce, amount = 10) => ({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount }, context: user("alice"), nonce });

// ---------------------------------------------------------------------------
//  nonce
// ---------------------------------------------------------------------------

test("nonce: tx แรกต้องเป็น 0 แล้วเพิ่มทีละ 1", () => {
  const { vm } = setup({ chargeGas: false });
  const first = vm.call(transfer(0));
  assert.equal(first.status, "success");
  assert.deepEqual(first.writes.at(-1), { type: "put", dbKey: "alice:nonce", value: 1 });
  vm.commit(first.writes);

  const second = vm.call(transfer(1));
  assert.equal(second.status, "success");
  vm.commit(second.writes);
  assert.equal(nonceOf(vm, "alice"), 2);
});

test("nonce: ซ้ำหรือข้าม → INVALID_REQUEST และไม่มี writes เลย", () => {
  const { vm } = setup({ chargeGas: false });
  vm.commit(vm.call(transfer(0)).writes);

  for (const [nonce, message] of [[0, "nonce ไม่ถูกต้อง: ต้องเป็น 1 แต่ได้ 0"], [5, "nonce ไม่ถูกต้อง: ต้องเป็น 1 แต่ได้ 5"], [undefined, "nonce ไม่ถูกต้อง: ต้องเป็น 1 แต่ได้ undefined"]]) {
    const res = vm.call(transfer(nonce));
    assert.equal(res.error.code, "INVALID_REQUEST");
    assert.equal(res.error.message, message);
    assert.deepEqual(res.writes, []); // nonce ผิด = ไม่รับ tx เลย จึงไม่กิน nonce
  }
  assert.equal(nonceOf(vm, "alice"), 1);
});

test("nonce: tx ที่ล้มก็กิน nonce", () => {
  const { vm } = setup({ chargeGas: false });
  const res = vm.call(transfer(0, 99999)); // ยอดไม่พอ
  assert.equal(res.error.code, "PROGRAM_ERROR");
  assert.deepEqual(res.writes, [{ type: "put", dbKey: "alice:nonce", value: 1 }]);
  vm.commit(res.writes);
  assert.equal(vm.call(transfer(0)).error.code, "INVALID_REQUEST");
  assert.equal(vm.call(transfer(1)).status, "success");
});

test("nonce: แยกกันตาม address และ deploy ก็กิน nonce", () => {
  const { vm } = setup({ chargeGas: false });
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("carol"), nonce: 0 }).writes);
  assert.equal(nonceOf(vm, "carol"), 1);
  assert.equal(nonceOf(vm, "alice"), undefined);
  assert.equal(vm.call(transfer(0)).status, "success"); // alice ยังเริ่มที่ 0
});

test("nonce: init / reject ของทีมงานไม่ใช้ nonce", () => {
  const { vm } = setup({ chargeGas: false });
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("carol"), nonce: 0 }).writes);
  const res = vm.init({ programUuid: "counter" });
  assert.equal(res.status, "success");
  assert.equal(res.writes.some((w) => w.dbKey.endsWith(":nonce")), false);
});

test("nonce: ปิด requireNonce → ไม่ต้องส่ง nonce และไม่มี writes ของ nonce", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false });
  const res = vm.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice") });
  assert.equal(res.status, "success");
  assert.equal(res.writes.some((w) => w.dbKey.endsWith(":nonce")), false);
});

// ---------------------------------------------------------------------------
//  ค่าแก๊ส
// ---------------------------------------------------------------------------

test("gas: คิดตามจำนวน call / read / write + ขนาดข้อมูล แล้วเข้าช่อง consumed ของผู้เรียก", () => {
  const { vm } = setup({ requireNonce: false, balances: { alice: 1_000_000 } });
  const value = "0123456789"; // JSON = "\"0123456789\"" = 12 byte
  const res = vm.call({ programUuid: "treasury", functionName: "gasProbe", input: { value }, context: user("alice") });

  // gasProbe = 1 call + readDB 1 ครั้ง (ค่าว่าง) + writeDB 1 ครั้ง (12 byte)
  const { call, read, write, byte } = VM.DEFAULT_GAS;
  const expected = call + read + write + byte * JSON.stringify(value).length;
  assert.equal(res.gasUsed, expected);

  const fee = expected * VM.DEFAULT_GAS.price;
  assert.deepEqual(res.writes.slice(-2), [
    { type: "put", dbKey: "alice:native:consumed", value: fee },
    { type: "put", dbKey: `${VM.BURN_ADDRESS}:native:received`, value: fee }, // ไม่มี feeRecipient → เผาเข้า 0x000…000
  ]);
  vm.commit(res.writes);
  assert.equal(balanceOf(vm, "alice"), 1_000_000 - fee);
});

test("gas: อ่านข้อมูลใหญ่กินแก๊สมากกว่าอ่านข้อมูลเล็ก", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false });
  const small = vm.call({ programUuid: "treasury", functionName: "gasProbe", input: { value: "x" }, context: user("alice") });
  vm.commit(small.writes);
  const large = vm.call({ programUuid: "treasury", functionName: "gasProbe", input: { value: "x".repeat(1000) }, context: user("alice") });
  assert.ok(large.gasUsed > small.gasUsed + 1000);
});

test("gas: ตารางค่าแก๊สปรับได้", () => {
  const { vm } = setup({ requireNonce: false, gas: { call: 1, read: 0, write: 0, byte: 0, price: 2 }, balances: { alice: 1000 } });
  const res = vm.call({ programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("alice") });
  assert.equal(res.gasUsed, 1);
  assert.deepEqual(res.writes, [
    { type: "put", dbKey: "alice:native:consumed", value: 2 }, // 1 gas × price 2
    { type: "put", dbKey: `${VM.BURN_ADDRESS}:native:received`, value: 2 },
  ]);
});

test("gas: การเรียกข้ามโปรแกรมคิดค่า call ทุกชั้น และผู้จ่ายคือผู้เรียกชั้นนอกสุดเท่านั้น", () => {
  const { vm } = setup({ requireNonce: false, gas: { call: 100, read: 0, write: 0, byte: 0, price: 1 }, balances: { alice: 10_000, treasury: 500 } });
  const res = vm.call({ programUuid: "treasury", functionName: "relayPayout", input: { target: "treasury", to: "bob", amount: 5 }, context: user("alice") });

  assert.equal(res.status, "success");
  assert.equal(res.gasUsed, 200); // 2 call
  const native = Object.fromEntries(res.writes.filter((w) => w.dbKey.includes(":native:")).map((w) => [w.dbKey, w.value]));
  assert.deepEqual(native, {
    "treasury:native:sended": 5,
    "bob:native:received": 5,
    "alice:native:consumed": 200, // ค่าแก๊สเก็บจาก alice คนเดียว
    [`${VM.BURN_ADDRESS}:native:received`]: 200,
  });
});

test("gas: ยอดไม่พอ → OUT_OF_GAS, ไม่มี writes ของโปรแกรม, กิน nonce และเงินที่เหลือทั้งหมด", () => {
  const { vm } = setup({ balances: { alice: 250 } });
  const res = vm.call(transfer(0));

  assert.equal(res.status, "throw");
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.match(res.error.message, /แก๊สไม่พอ/);
  assert.deepEqual(res.writes, [
    { type: "put", dbKey: "alice:nonce", value: 1 },
    { type: "put", dbKey: "alice:native:consumed", value: 250 }, // จ่ายเท่าที่มี
    { type: "put", dbKey: `${VM.BURN_ADDRESS}:native:received`, value: 250 },
  ]);
  vm.commit(res.writes);
  assert.equal(balanceOf(vm, "alice"), 0);
  assert.equal(vm.db.readKeys(["token:storage:balances:bob"])[0], undefined);
});

test("gas: ไม่มียอด native เลย → OUT_OF_GAS ตั้งแต่ call แรก", () => {
  const { vm } = setup({ requireNonce: false });
  const res = vm.call({ programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("alice") });
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.deepEqual(res.writes, []);
});

test("gas: โปรแกรม catch OUT_OF_GAS ไม่ได้", () => {
  const { vm } = setup({ requireNonce: false, balances: { alice: 3000 } });
  const res = vm.call({
    programUuid: "treasury",
    functionName: "burnGas",
    input: { rounds: 50, data: "0123456789" },
    context: user("alice"),
  });
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.deepEqual(res.writes.map((w) => w.dbKey), ["alice:native:consumed", `${VM.BURN_ADDRESS}:native:received`]);
  assert.equal(res.writes[0].value, 3000); // จ่ายเท่าที่มีทั้งหมด
});

test("gas: ปิด chargeGas → ยังนับ gasUsed แต่ไม่หักเงิน", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false });
  const res = vm.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice") });
  assert.ok(res.gasUsed > 0);
  assert.equal(res.writes.some((w) => w.dbKey.includes(":native:")), false);
});

// ---------------------------------------------------------------------------
//  transferNative
// ---------------------------------------------------------------------------

test("transferNative: โอนจากกระเป๋าของโปรแกรมเอง", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false, balances: { treasury: 100 } });
  const res = vm.call({ programUuid: "treasury", functionName: "payout", input: { to: "0xFABB0Ac9", amount: 30 }, context: user("alice") });

  assert.equal(res.status, "success");
  assert.deepEqual(res.writes, [
    { type: "put", dbKey: "treasury:native:sended", value: 30 },
    { type: "put", dbKey: "0xfabb0ac9:native:received", value: 30 },   // address ถูก normalize
    { type: "put", dbKey: "treasury:storage:paid:0xfabb0ac9", value: 30 },
  ]);
  vm.commit(res.writes);
  assert.equal(balanceOf(vm, "0xfabb0ac9"), 30);
});

test("transferNative: โอนหลายครั้งใน tx เดียว เห็นยอดล่าสุดเสมอ", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false, balances: { treasury: 100 } });
  const items = [{ to: "bob", amount: 30 }, { to: "carol", amount: 50 }, { to: "bob", amount: 10 }];
  const res = vm.call({ programUuid: "treasury", functionName: "payoutMany", input: { items }, context: user("alice") });

  assert.equal(res.result, 3);
  vm.commit(res.writes);
  assert.equal(balanceOf(vm, "treasury"), 10);
  assert.equal(balanceOf(vm, "bob"), 40);
  assert.equal(balanceOf(vm, "carol"), 50);
});

test("transferNative: ยอดไม่พอ / amount ไม่ถูกต้อง → error ที่โปรแกรม catch ได้", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false, balances: { treasury: 10 } });
  const payout = (input) => vm.call({ programUuid: "treasury", functionName: "payout", input, context: user("alice") });

  assert.equal(payout({ to: "bob", amount: 50 }).error.message, "ยอด native ของ 'treasury' ไม่พอ");
  assert.equal(payout({ to: "bob", amount: 0 }).error.code, "INVALID_REQUEST");
  assert.equal(payout({ to: "bob", amount: 1.5 }).error.code, "INVALID_REQUEST");
  assert.equal(payout({ to: "", amount: 1 }).error.code, "INVALID_REQUEST");

  const caught = vm.call({ programUuid: "treasury", functionName: "payoutSafe", input: { to: "bob", amount: 50 }, context: user("alice") });
  assert.equal(caught.result, "ยอด native ของ 'treasury' ไม่พอ");
  assert.deepEqual(caught.writes, [{ type: "put", dbKey: "treasury:storage:lastError", value: "ยอด native ของ 'treasury' ไม่พอ" }]);
});

test("transferNative: โปรแกรมโอน native ของ address อื่นไม่ได้ (โอนได้เฉพาะของตัวเอง)", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false, balances: { alice: 1000, treasury: 5 } });
  const res = vm.call({ programUuid: "treasury", functionName: "payout", input: { to: "bob", amount: 100 }, context: user("alice") });
  assert.equal(res.error.message, "ยอด native ของ 'treasury' ไม่พอ"); // แม้ alice จะมีเงิน
});

test("transferNative: โอนออกจนจ่ายค่าแก๊สไม่ไหว → OUT_OF_GAS และไม่มีอะไรถูกบันทึก", () => {
  const { vm } = setup({ requireNonce: false, balances: { alice: 100_000, treasury: 100 } });
  // alice มีพอจ่ายค่าแก๊ส แต่โปรแกรมโอน native ของตัวเอง ไม่กระทบ → ต้องสำเร็จ
  const ok = vm.call({ programUuid: "treasury", functionName: "payout", input: { to: "bob", amount: 100 }, context: user("alice") });
  assert.equal(ok.status, "success");

  // alice มีน้อยกว่าค่าแก๊ส → OUT_OF_GAS
  const { vm: poor } = setup({ requireNonce: false, balances: { alice: 300, treasury: 100 } });
  const res = poor.call({ programUuid: "treasury", functionName: "payout", input: { to: "bob", amount: 10 }, context: user("alice") });
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.equal(res.writes.some((w) => w.dbKey.startsWith("bob:native:")), false);
});

// ---------------------------------------------------------------------------
//  block
// ---------------------------------------------------------------------------

test("block: tx ที่ล้มยังกิน nonce และค่าแก๊ส และ tx ถัดไปต้องใช้ nonce ถัดไป", () => {
  const { vm } = setup({ balances: { alice: 1_000_000 } });
  const block = vm.createBlock({ timestamp: T });
  const first = block.call(transfer(0, 99999));       // ล้ม
  const second = block.call(transfer(0, 10));         // nonce ซ้ำ → ถูกปฏิเสธ
  const third = block.call(transfer(1, 10));          // ผ่าน

  assert.deepEqual([first.status, second.status, third.status], ["throw", "throw", "success"]);
  assert.equal(second.error.code, "INVALID_REQUEST");
  assert.equal(block.writes().find((w) => w.dbKey === "alice:nonce").value, 2);

  const feeCharged = block.writes().find((w) => w.dbKey === "alice:native:consumed").value;
  assert.equal(feeCharged, first.gasUsed + third.gasUsed);

  block.commit();
  assert.equal(nonceOf(vm, "alice"), 2);
  assert.equal(balanceOf(vm, "alice"), 1_000_000 - feeCharged);
});

test("block: ค่าแก๊สหมดกลาง block → tx ถัดไป OUT_OF_GAS", () => {
  const { vm } = setup({ requireNonce: false, balances: { alice: 2000 } });
  const block = vm.createBlock({ timestamp: T });
  const results = [1, 2, 3].map(() => block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice") }));
  assert.deepEqual(results.map((r) => r.status), ["success", "throw", "throw"]);
  assert.deepEqual(results.slice(1).map((r) => r.error.code), ["OUT_OF_GAS", "OUT_OF_GAS"]);
  assert.equal(block.writes().find((w) => w.dbKey === "alice:native:consumed").value, 2000); // ใช้จนหมด
});
