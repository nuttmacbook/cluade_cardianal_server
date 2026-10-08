import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { COUNTER, PROFILE } from "./programs.js";

/* เงินที่ถูกเผา → 0x000…000  และ metadata ของแต่ละ address */

const T = 1_700_000_000_000;
const user = (name) => ({ sender: name, origin: name });
const GAS = { call: 100, read: 0, write: 0, byte: 0, price: 1 };

function setup(options = {}, balances = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), options);
  vm.db.load(Object.fromEntries(Object.entries(balances).map(([address, value]) => [`${address}:native:received`, value])));
  return vm;
}

const save = (vm, res) => {
  assert.equal(res.status, "success", JSON.stringify(res.error));
  vm.commit(res.writes);
  return res;
};

// ---------------------------------------------------------------------------
//  เงินที่ถูกเผา
// ---------------------------------------------------------------------------

test("burn: ค่าแก๊สที่เผาเข้าไปที่ 0x000…000 ไม่ได้หายไปเฉย ๆ", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 10_000 });
  save(vm, vm.transfer({ from: "alice", to: "bob", amount: 100 }));

  assert.equal(VM.BURN_ADDRESS, `0x${"0".repeat(40)}`);
  assert.deepEqual(vm.nativeBalanceOf(VM.BURN_ADDRESS), { received: 100, sended: 0, consumed: 0, balance: 100 });
});

test("burn: แบ่งให้ผู้ปิด block ที่เหลือเข้า 0x000…000", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 30 }, { alice: 10_000 });
  save(vm, vm.transfer({ from: "alice", to: "bob", amount: 100 }));

  assert.equal(vm.nativeBalanceOf("miner").balance, 70);
  assert.equal(vm.nativeBalanceOf(VM.BURN_ADDRESS).balance, 30);
  assert.equal(vm.nativeBalanceOf("alice").consumed, 100);
});

test("burn: ยอดรวมทั้งระบบคงที่เสมอ (รวมกระเป๋าเผา)", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 50 }, { alice: 10_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner", burnPercent: 50 });
  block.transfer({ from: "alice", to: "bob", amount: 300 });
  block.transfer({ from: "bob", to: "carol", amount: 50 });
  block.commit();

  const total = ["alice", "bob", "carol", "miner", VM.BURN_ADDRESS]
    .reduce((sum, address) => sum + vm.nativeBalanceOf(address).balance, 0);
  assert.equal(total, 10_000);
});

test("burn: เงินในกระเป๋าเผาเอาออกไม่ได้ (ไม่มีใครมี key ของ 0x000…000)", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 1000 });
  save(vm, vm.transfer({ from: "alice", to: "bob", amount: 10 }));
  assert.ok(vm.nativeBalanceOf(VM.BURN_ADDRESS).balance > 0);
  // ยังโอนออกได้ทางทฤษฎี แต่ต้องมีลายเซ็นของ 0x000…000 ซึ่งไม่มีใครทำได้
  assert.equal(vm.transfer({ from: VM.BURN_ADDRESS, to: "alice", amount: 999_999 }).error.code, "PROGRAM_ERROR");
});

// ---------------------------------------------------------------------------
//  metadata ของโปรแกรม
// ---------------------------------------------------------------------------

test("metadata: init ใส่ type / creator / createdAt ให้อัตโนมัติ", () => {
  const vm = setup();
  save(vm, vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice") }, { timestamp: T }));
  save(vm, vm.init({ programUuid: "counter" }, { timestamp: T }));

  assert.deepEqual(vm.getMetadata("counter"), { type: "program", creator: "alice", createdAt: T });
});

test("metadata: deploy แนบ metadata มาได้ และถูกบันทึกตอน init", () => {
  const vm = setup();
  const metadata = { namespace: "MyCounter", description: "ตัวนับ", tags: ["demo", "counter"], url: "https://example.com" };
  save(vm, vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), metadata }, { timestamp: T }));
  save(vm, vm.init({ programUuid: "counter" }, { timestamp: T }));

  assert.deepEqual(vm.getMetadata("counter"), {
    namespace: "mycounter", // ชื่อถูกทำเป็นตัวพิมพ์เล็ก
    description: "ตัวนับ",
    tags: ["demo", "counter"],
    url: "https://example.com",
    type: "program",
    creator: "alice",
    createdAt: T,
  });
  assert.equal(vm.resolveNamespace("MyCounter"), "counter"); // ค้นจากชื่อได้
});

test("metadata: deploy ที่แนบฟิลด์ของระบบ → ถูกปฏิเสธ", () => {
  const vm = setup();
  for (const field of ["type", "creator", "createdAt"]) {
    const res = vm.deploy({ programUuid: "p", code: COUNTER, context: user("alice"), metadata: { [field]: "x" } });
    assert.equal(res.error.code, "FORBIDDEN");
    assert.match(res.error.message, /เป็นฟิลด์ของระบบ/);
  }
  assert.equal(vm.deploy({ programUuid: "p", code: COUNTER, context: user("alice"), metadata: { "ชื่อผิด!": 1 } }).error.code, "INVALID_REQUEST");
  assert.equal(vm.deploy({ programUuid: "p", code: COUNTER, context: user("alice"), metadata: "x" }).error.code, "INVALID_REQUEST");
});

test("metadata: โปรแกรมตั้ง metadata ของตัวเองได้ด้วย setMetadata()", () => {
  const vm = setup();
  save(vm, vm.deploy({ programUuid: "profile", code: PROFILE, context: user("alice"), initInput: { name: "Shop" } }, { timestamp: T }));
  save(vm, vm.init({ programUuid: "profile" }, { timestamp: T }));
  assert.equal(vm.getMetadata("profile").namespace, "shop");
  assert.equal(vm.getMetadata("profile").description, "โปรแกรมตัวอย่าง");

  save(vm, vm.call({ programUuid: "profile", functionName: "setField", input: { field: "icon", value: "🛒" }, context: user("bob") }));
  assert.equal(vm.getMetadata("profile").icon, "🛒");

  save(vm, vm.call({ programUuid: "profile", functionName: "clearField", input: { field: "icon" }, context: user("bob") }));
  assert.equal(vm.getMetadata("profile").icon, undefined);
});

test("metadata: โปรแกรมแก้ฟิลด์ของระบบไม่ได้", () => {
  const vm = setup();
  save(vm, vm.deploy({ programUuid: "profile", code: PROFILE, context: user("alice"), initInput: { name: "shop2" } }));
  save(vm, vm.init({ programUuid: "profile" }));

  const res = vm.call({ programUuid: "profile", functionName: "tryReserved", context: user("bob") });
  assert.equal(res.error.code, "FORBIDDEN");
  assert.equal(vm.getMetadata("profile").creator, "alice");
});

// ---------------------------------------------------------------------------
//  metadata ของ wallet (vm.setMetadata)
// ---------------------------------------------------------------------------

test("setMetadata: user ตั้ง metadata ของ address ตัวเอง", () => {
  const vm = setup({ requireNonce: true });
  const res = save(vm, vm.setMetadata({
    metadata: { namespace: "Alice", description: "ผู้ใช้คนแรก", icon: "👩" },
    context: user("0xA1"), nonce: 0,
  }, { timestamp: T }));

  assert.deepEqual(res.result, { address: "0xa1", metadata: ["namespace", "description", "icon"] });
  assert.deepEqual(vm.getMetadata("0xA1"), { namespace: "alice", description: "ผู้ใช้คนแรก", icon: "👩" });
  assert.equal(vm.resolveNamespace("alice"), "0xa1");
  assert.equal(vm.db.readKeys(["0xa1:nonce"])[0], 1); // กิน nonce เหมือน tx อื่น
});

test("setMetadata: ตั้งได้เฉพาะของตัวเอง (address มาจาก sender)", () => {
  const vm = setup();
  save(vm, vm.setMetadata({ metadata: { namespace: "bob" }, context: { sender: "bob", origin: "carol" } }));
  assert.equal(vm.resolveNamespace("bob"), "bob"); // ใช้ sender ไม่ใช่ origin
  assert.deepEqual(vm.getMetadata("carol"), {});
});

test("namespace: ห้ามซ้ำ และเปลี่ยนชื่อแล้วชื่อเดิมถูกปล่อย", () => {
  const vm = setup();
  save(vm, vm.setMetadata({ metadata: { namespace: "shop" }, context: user("alice") }));

  const taken = vm.setMetadata({ metadata: { namespace: "SHOP" }, context: user("bob") });
  assert.equal(taken.error.code, "FORBIDDEN");
  assert.match(taken.error.message, /ถูกใช้โดย alice/);

  save(vm, vm.setMetadata({ metadata: { namespace: "market" }, context: user("alice") })); // เปลี่ยนชื่อ
  assert.equal(vm.resolveNamespace("shop"), null);   // ชื่อเดิมถูกปล่อย
  assert.equal(vm.resolveNamespace("market"), "alice");
  save(vm, vm.setMetadata({ metadata: { namespace: "shop" }, context: user("bob") })); // bob ใช้ชื่อเดิมได้แล้ว
  assert.equal(vm.resolveNamespace("shop"), "bob");
});

test("namespace: ตั้งเป็น null เพื่อยกเลิกชื่อ", () => {
  const vm = setup();
  save(vm, vm.setMetadata({ metadata: { namespace: "alice" }, context: user("alice") }));
  save(vm, vm.setMetadata({ metadata: { namespace: null }, context: user("alice") }));
  assert.equal(vm.resolveNamespace("alice"), null);
  assert.deepEqual(vm.getMetadata("alice"), {});
});

test("namespace: รูปแบบไม่ถูกต้อง", () => {
  const vm = setup();
  for (const namespace of ["", "มี:โคลอน", "x".repeat(65), 123]) {
    assert.equal(vm.setMetadata({ metadata: { namespace }, context: user("alice") }).error.code, "INVALID_REQUEST");
  }
});

test("metadata: ใช้ใน block และมีใน writes / receipt", () => {
  const vm = setup({ requireNonce: true, recordTransactions: true });
  const block = vm.createBlock({ timestamp: T, number: 1 });
  block.setMetadata({ metadata: { namespace: "alice" }, context: user("alice"), nonce: 0 });

  assert.deepEqual(block.writes().map((w) => `${w.type} ${w.dbKey}`).slice(0, 2), [
    "put alice:metadata:namespace",
    "put namespace:alice",
  ]);
  const receipt = block.receipt({ number: 1 });
  assert.equal(receipt.transactions[0].action, "metadata");
  assert.match(receipt.transactions[0].hash, /^0x[0-9a-f]{64}$/);
  block.commit();
  assert.equal(vm.resolveNamespace("alice"), "alice");
});

test("metadata: decodeDbKey อ่าน key ของ metadata และ namespace ออก", () => {
  assert.deepEqual(VM.decodeDbKey("0xabc:metadata:namespace"), { kind: "metadata", address: "0xabc", field: "namespace" });
  assert.deepEqual(VM.decodeDbKey("namespace:alice"), { kind: "namespace", name: "alice" });
});
