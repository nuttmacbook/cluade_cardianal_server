import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN } from "./programs.js";

/* gasPrice ที่ผู้ส่งกำหนดเอง: จ่ายแพงกว่าเพื่อให้ถูกเลือกเข้า block ก่อน */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const GAS = { call: 100, read: 0, write: 0, byte: 0, price: 2 }; // ราคาขั้นต่ำ 2

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true,
    gas: GAS, feeRecipient: "miner", burnPercent: 50, ...options,
  });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  vm.db.load({ "alice:native:received": 1_000_000, "bob:native:received": 1_000_000 });
  return vm;
}

const transfer = (sender, nonce, gasPrice) => ({
  programUuid: "token", functionName: "transfer", input: { to: "carol", amount: 1 }, context: user(sender), nonce, gasPrice,
});

// ---------------------------------------------------------------------------
//  คิดค่าแก๊สตามราคาที่เสนอ
// ---------------------------------------------------------------------------

test("gasPrice: ไม่ส่งมา → ใช้ราคาขั้นต่ำของระบบ", () => {
  const vm = setup();
  const res = vm.call(transfer("alice", 0), { timestamp: T });
  assert.equal(res.gasPrice, GAS.price);
  assert.equal(res.fee, res.gasUsed * GAS.price);
});

test("gasPrice: เสนอสูงกว่า → จ่ายแพงขึ้นตามสัดส่วน", () => {
  const vm = setup();
  const cheap = vm.call(transfer("alice", 0), { timestamp: T });
  const expensive = vm.call(transfer("bob", 0, 10), { timestamp: T });

  assert.equal(expensive.gasPrice, 10);
  assert.equal(expensive.gasUsed, cheap.gasUsed);          // งานเท่ากัน
  assert.equal(expensive.fee, cheap.gasUsed * 10);         // แต่จ่ายแพงกว่า 5 เท่า
  assert.equal(expensive.fee, cheap.fee * 5);
});

test("gasPrice: ผู้ปิด block ได้ส่วนแบ่งมากขึ้นตามราคาที่จ่าย", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner", burnPercent: 50 });
  const expensive = block.call(transfer("alice", 0, 20));
  block.commit();

  assert.equal(vm.nativeBalanceOf("miner").balance, Math.floor(expensive.fee / 2));
  assert.equal(vm.nativeBalanceOf("alice").consumed, expensive.fee);
});

test("gasPrice: ต่ำกว่าราคาขั้นต่ำ หรือรูปแบบผิด → ปฏิเสธ", () => {
  const vm = setup();
  for (const gasPrice of [1, 0, -5, 1.5, "10"]) {
    const res = vm.call(transfer("alice", 0, gasPrice), { timestamp: T });
    assert.equal(res.error.code, "INVALID_REQUEST", `gasPrice ${gasPrice}`);
    assert.match(res.error.message, /gasPrice/);
  }
  assert.equal(vm.call(transfer("alice", 0, 2), { timestamp: T }).status, "success"); // เท่าขั้นต่ำได้
});

test("gasPrice: เพดานแก๊สคิดจากราคาที่เสนอ — ราคาแพงทำให้ยอดเงินใช้ได้น้อยลง", () => {
  const vm = setup();
  vm.db.clear();
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  vm.db.load({ "alice:native:received": 150 }); // พอจ่าย 100 gas ที่ราคา 1 แต่ไม่พอที่ราคา 10

  const res = vm.call(transfer("alice", 0, 10), { timestamp: T });
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.equal(res.fee, 150); // จ่ายเท่าที่มี
});

test("gasPrice: เป็นส่วนหนึ่งของ tx hash (เปลี่ยนราคา = คนละ tx)", () => {
  const vm = setup();
  const base = vm.hashTransaction(transfer("alice", 0));
  assert.notEqual(base, vm.hashTransaction(transfer("alice", 0, 5)));
  assert.equal(vm.hashTransaction(transfer("alice", 0, 5)), vm.hashTransaction(transfer("alice", 0, 5)));
  assert.equal(vm.transactionPayload(transfer("alice", 0, 5)).gasPrice, 5);
});

test("gasPrice: อยู่ใน receipt ของ tx", () => {
  const vm = setup();
  const request = transfer("alice", 0, 7);
  const receipt = vm.buildReceipt(request, vm.call(request, { timestamp: T }));
  assert.equal(receipt.gasPrice, 7);
  assert.equal(receipt.fee, receipt.gasUsed * 7);
});

// ---------------------------------------------------------------------------
//  เรียงคิวตามราคา
// ---------------------------------------------------------------------------

test("sortPendingTransactions: จ่ายแพงกว่าได้ก่อน", () => {
  const items = [
    { request: transfer("alice", 0, 2) },
    { request: transfer("bob", 0, 50) },
    { request: transfer("carol", 0, 10) },
  ];
  assert.deepEqual(
    VM.sortPendingTransactions(items).map((item) => item.request.context.sender),
    ["bob", "carol", "alice"],
  );
});

test("sortPendingTransactions: ของ address เดียวกันยังเรียงตาม nonce เสมอ", () => {
  const items = [
    { request: transfer("alice", 2, 100) },  // ราคาแพงแต่ nonce หลัง
    { request: transfer("alice", 0, 3) },
    { request: transfer("alice", 1, 3) },
    { request: transfer("bob", 0, 50) },
  ];
  assert.deepEqual(
    VM.sortPendingTransactions(items).map((item) => `${item.request.context.sender}#${item.request.nonce}`),
    ["bob#0", "alice#0", "alice#1", "alice#2"], // alice ใช้ราคาต่ำสุดของคิวตัวเอง (3) จึงอยู่หลัง bob
  );
});

test("sortPendingTransactions: ราคาเท่ากัน → มาก่อนได้ก่อน", () => {
  const items = [
    { request: transfer("bob", 0, 5), receivedAt: 200 },
    { request: transfer("alice", 0, 5), receivedAt: 100 },
  ];
  assert.deepEqual(
    VM.sortPendingTransactions(items).map((item) => item.request.context.sender),
    ["alice", "bob"],
  );
});

test("sortPendingTransactions: ไม่ระบุราคา → นับเป็นราคาขั้นต่ำ และรองรับ transfer tx", () => {
  const items = [
    { request: { from: "alice", to: "x", amount: 1, nonce: 0 } },
    { request: { from: "bob", to: "x", amount: 1, nonce: 0, gasPrice: 9 } },
  ];
  assert.deepEqual(
    VM.sortPendingTransactions(items, { defaultGasPrice: 1 }).map((item) => item.request.from),
    ["bob", "alice"],
  );
});

test("flow: คิวเรียงตามราคาแล้วใส่เข้า block ได้จริง", () => {
  const vm = setup();
  const queue = [
    { request: transfer("alice", 0, 2), receivedAt: 1 },
    { request: transfer("bob", 0, 30), receivedAt: 2 },
    { request: transfer("bob", 1, 30), receivedAt: 3 },
  ];

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  for (const { request } of VM.sortPendingTransactions(queue)) {
    if (block.checkTransaction(request).ok) block.call(request);
  }
  block.commit();

  const receipt = vm.getBlock(1);
  assert.equal(receipt.txCount, 3);
  assert.deepEqual(
    receipt.txHashes.map((hash) => vm.getTransaction(hash).from),
    ["bob", "bob", "alice"], // ใบที่จ่ายแพงกว่าถูกรันก่อน
  );
});

// ---------------------------------------------------------------------------
//  ค่าแก๊สของ deploy คิดตามขนาดโค้ด
// ---------------------------------------------------------------------------

test("deploy: ค่าแก๊สคิดตามขนาดโค้ด (ยาวกว่า = แพงกว่า)", () => {
  const vm = setup({ requireNonce: false, gas: { ...GAS, code: 10 } });
  const small = "function program() {\n  function a() { return 1 }\n  return { a }\n}";
  const large = `function program() {\n  function a() { return 1 }\n  // ${"x".repeat(500)}\n  return { a }\n}`;

  const cheap = vm.deploy({ programUuid: "small", code: small, context: user("alice") });
  const expensive = vm.deploy({ programUuid: "large", code: large, context: user("alice") });

  assert.equal(cheap.gasUsed, GAS.call + 10 * Buffer.byteLength(VM.toOneLine(small)));
  const sizeOf = (code) => Buffer.byteLength(VM.toOneLine(code));
  assert.equal(expensive.gasUsed - cheap.gasUsed, 10 * (sizeOf(large) - sizeOf(small))); // ต่างกันตามจำนวน byte ที่เพิ่ม
  assert.equal(expensive.fee, expensive.gasUsed * GAS.price);
});

test("deploy: โค้ดภาษาไทยคิดตามจำนวน byte จริง", () => {
  const vm = setup({ requireNonce: false, gas: { ...GAS, code: 1 } });
  const ascii = 'function program() {\n  function a() { return "abc" }\n  return { a }\n}';
  const thai = 'function program() {\n  function a() { return "กขค" }\n  return { a }\n}';

  const plain = vm.deploy({ programUuid: "ascii", code: ascii, context: user("alice") });
  const unicode = vm.deploy({ programUuid: "thai", code: thai, context: user("alice") });
  assert.equal(unicode.gasUsed - plain.gasUsed, 6); // ไทย 3 ตัว = 9 byte แทน 3 byte
});

test("deploy: โค้ดยาวเกิน maxCodeSize → ปฏิเสธ", () => {
  const vm = setup({ requireNonce: false, maxCodeSize: 200 });
  const long = `function program() {\n  // ${"x".repeat(300)}\n  return {}\n}`;
  const res = vm.deploy({ programUuid: "big", code: long, context: user("alice") });

  assert.equal(res.error.code, "INVALID_REQUEST");
  assert.match(res.error.message, /โค้ดยาวเกินกำหนด/);
  assert.equal(vm.deploy({ programUuid: "ok", code: "function program() { return {} }", context: user("alice") }).status, "success");
});

test("deploy: ค่าเริ่มต้นของ maxCodeSize คือ 64KB", () => {
  assert.equal(VM.DEFAULT_OPTIONS.maxCodeSize, 64 * 1024);
  assert.equal(VM.DEFAULT_GAS.code, 10);
});
