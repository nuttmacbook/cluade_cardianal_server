import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN, COUNTER } from "./programs.js";

/* hash ของ tx: คำนวณจาก request ของ user เท่านั้น จึงรู้ได้ตั้งแต่ก่อนส่ง และ tx ที่ล้มก็มี hash */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, ...options });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  vm.commit([{ type: "put", dbKey: "alice:native:received", value: 1_000_000 }]);
  return vm;
}

const callTx = (nonce = 0, amount = 30) => ({
  programUuid: "token", functionName: "transfer", input: { to: "bob", amount }, context: user("alice"), nonce,
});

// ---------------------------------------------------------------------------
//  คุณสมบัติพื้นฐาน
// ---------------------------------------------------------------------------

test("hash: รูปแบบ 0x + 64 hex และได้ค่าเดิมทุกครั้ง", () => {
  const vm = setup();
  const hash = vm.hashTransaction(callTx());
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(vm.hashTransaction(callTx()), hash);
});

test("hash: ไม่ขึ้นกับลำดับ field ที่ใส่มา", () => {
  const vm = setup();
  const a = { programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 30 }, context: { sender: "alice", origin: "alice" }, nonce: 0 };
  const b = { nonce: 0, context: { origin: "alice", sender: "alice" }, input: { amount: 30, to: "bob" }, functionName: "transfer", programUuid: "token" };
  assert.equal(vm.hashTransaction(a), vm.hashTransaction(b));
});

test("hash: address ตัวพิมพ์ต่างกันได้ hash เดียวกัน", () => {
  const vm = setup();
  const upper = { ...callTx(), programUuid: "TOKEN", context: user("ALICE") };
  assert.equal(vm.hashTransaction(upper), vm.hashTransaction(callTx()));
});

test("hash: เปลี่ยนอะไรก็ได้ hash ใหม่", () => {
  const vm = setup();
  const base = vm.hashTransaction(callTx());
  const variants = [
    { ...callTx(), nonce: 1 },
    { ...callTx(), input: { to: "bob", amount: 31 } },
    { ...callTx(), functionName: "balanceOf" },
    { ...callTx(), programUuid: "other" },
    { ...callTx(), context: user("bob") },
    { ...callTx(), value: 1 },
    { ...callTx(), gasLimit: 5000 },
  ];
  const hashes = variants.map((request) => vm.hashTransaction(request));
  assert.equal(new Set([base, ...hashes]).size, variants.length + 1);
});

test("hash: chainId ต่างกัน → hash ต่างกัน (กัน replay ข้ามระบบ)", () => {
  const one = setup({ chainId: 1 });
  const two = setup({ chainId: 2 });
  assert.notEqual(one.hashTransaction(callTx()), two.hashTransaction(callTx()));
});

test("hash: tx เหมือนกันเป๊ะต้องต่างกันที่ nonce เท่านั้น", () => {
  const vm = setup();
  assert.notEqual(vm.hashTransaction(callTx(0)), vm.hashTransaction(callTx(1)));
});

test("hash: เปลี่ยนไปใช้ hash ตัวอื่นได้ (เช่น keccak256)", () => {
  const fake = (text) => `0x${createHash("sha512").update(text).digest("hex").slice(0, 64)}`;
  const vm = setup({ hashFunction: fake });
  assert.equal(vm.hashTransaction(callTx()), fake(VM.canonicalJson(vm.transactionPayload(callTx()))));
  assert.notEqual(vm.hashTransaction(callTx()), setup().hashTransaction(callTx()));
});

// ---------------------------------------------------------------------------
//  แต่ละ action
// ---------------------------------------------------------------------------

test("hash: transfer / deploy / call ใช้ payload คนละชุด", () => {
  const vm = setup();
  const transfer = { from: "alice", to: "bob", amount: 100, nonce: 0 };
  assert.deepEqual(vm.transactionPayload(transfer), {
    chainId: 1, action: "transfer", from: "alice", to: "bob", amount: 100, nonce: 0, gasLimit: null, gasPrice: null,
  });
  assert.deepEqual(vm.transactionPayload(callTx(2)), {
    chainId: 1, action: "call", from: "alice", to: "token", method: "transfer",
    input: { to: "bob", amount: 30 }, value: 0, nonce: 2, gasLimit: null, gasPrice: null,
  });

  const deploy = { programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 1 }, nonce: 3, value: 50 };
  const payload = vm.transactionPayload(deploy);
  assert.equal(payload.action, "deploy");
  assert.equal(payload.code, VM.toOneLine(COUNTER)); // โค้ดถูกทำเป็นบรรทัดเดียวก่อน hash
  assert.deepEqual([payload.from, payload.to, payload.value, payload.nonce], ["alice", "counter", 50, 3]);
});

test("hash: deploy ที่โค้ดต่างกันแค่การขึ้นบรรทัด (CRLF) ได้ hash เดียวกัน", () => {
  const vm = setup();
  const make = (code) => ({ programUuid: "counter", code, context: user("alice"), nonce: 0 });
  assert.equal(vm.hashTransaction(make(COUNTER)), vm.hashTransaction(make(COUNTER.replace(/\n/g, "\r\n"))));
});

test("hash: init / reject ใช้ blockNumber + index เพราะไม่มี nonce", () => {
  const vm = setup();
  const request = { programUuid: "counter" };
  const first = vm.hashTransaction(request, { action: "init", blockNumber: 10, index: 0 });
  assert.notEqual(first, vm.hashTransaction(request, { action: "init", blockNumber: 10, index: 1 }));
  assert.notEqual(first, vm.hashTransaction(request, { action: "init", blockNumber: 11, index: 0 }));
  assert.notEqual(first, vm.hashTransaction(request, { action: "reject", blockNumber: 10, index: 0 }));
});

test("hash: เดา action เองได้จากหน้าตาของ request", () => {
  const vm = setup();
  assert.equal(vm.transactionPayload({ from: "a", to: "b", amount: 1 }).action, "transfer");
  assert.equal(vm.transactionPayload({ programUuid: "p", code: "x", context: user("a") }).action, "deploy");
  assert.equal(vm.transactionPayload(callTx()).action, "call");
});

// ---------------------------------------------------------------------------
//  hash ใน receipt
// ---------------------------------------------------------------------------

test("receipt: hash ตรงกับที่คำนวณก่อนส่ง ทั้ง tx ที่สำเร็จและที่ล้ม", () => {
  const vm = setup();
  const good = callTx(0);
  const bad = callTx(1, 99999);
  const expected = [vm.hashTransaction(good), vm.hashTransaction(bad)];

  const block = vm.createBlock({ timestamp: T });
  block.call(good);
  block.call(bad);

  const receipt = block.receipt({ number: 5 });
  assert.deepEqual(receipt.transactions.map((tx) => tx.hash), expected);
  assert.deepEqual(receipt.transactions.map((tx) => tx.status), ["success", "throw"]);
});

test("receipt: tx ที่ถูกปฏิเสธเพราะ nonce ผิด ก็ยังมี hash", () => {
  const vm = setup();
  const request = callTx(9);
  const result = vm.call(request, { timestamp: T });
  assert.equal(result.error.code, "INVALID_REQUEST");
  assert.equal(vm.buildReceipt(request, result).hash, vm.hashTransaction(request));
});

test("receipt: hash ของทุก tx ใน block ไม่ซ้ำกัน", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call(callTx(0, 1));
  block.call(callTx(1, 1));             // เหมือนกันทุกอย่างยกเว้น nonce
  block.transfer({ from: "alice", to: "carol", amount: 1, nonce: 2 });
  block.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), nonce: 3 });
  block.init({ programUuid: "counter" });
  block.reject({ programUuid: "counter" });

  const hashes = block.receipt({ number: 12 }).transactions.map((tx) => tx.hash);
  assert.equal(new Set(hashes).size, hashes.length);
  assert.ok(hashes.every((hash) => /^0x[0-9a-f]{64}$/.test(hash)));
});

test("receipt: hash เดียวกันเมื่อรัน block ซ้ำด้วย request ชุดเดิม", () => {
  const first = setup();
  const second = setup();
  const requests = [callTx(0, 5), callTx(1, 6)];
  const run = (vm) => {
    const block = vm.createBlock({ timestamp: T });
    for (const request of requests) block.call(request);
    return block.receipt({ number: 1 }).transactions.map((tx) => tx.hash);
  };
  assert.deepEqual(run(first), run(second));
});

test("canonicalJson: เรียง key และข้าม undefined", () => {
  assert.equal(VM.canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(VM.canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(VM.canonicalJson([1, "a", null, { z: 1, y: 2 }]), '[1,"a",null,{"y":2,"z":1}]');
  assert.equal(VM.canonicalJson(undefined), "null");
  assert.equal(VM.canonicalJson("ไทย 🎉"), JSON.stringify("ไทย 🎉"));
});

test("hash: address ที่อยู่ใน input ก็ถูก normalize ก่อน hash", () => {
  const vm = setup();
  const lower = { ...callTx(), input: { to: "0xfabb0ac9", amount: 30 } };
  const upper = { ...callTx(), input: { to: "0xFABB0Ac9", amount: 30 } };
  assert.equal(vm.hashTransaction(lower), vm.hashTransaction(upper));
});
