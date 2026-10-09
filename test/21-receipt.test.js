import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN, WALLET, SHOP, COUNTER, FAULTY } from "./programs.js";

/* receipt ของแต่ละ tx (vm.buildReceipt) และของทั้ง block (block.receipt) */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const GAS = { call: 100, read: 10, write: 50, byte: 0, price: 1 };
let endpointCounter = 0;

function setup(options = {}, balances = { alice: 100_000 }) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, gas: GAS, burnPercent: 50, ...options,
  });
  const plain = new VM.VirtualMachine(vm.db);
  const save = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    vm.commit(res.writes);
  };
  save(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }));
  save(plain.init({ programUuid: "token" }));
  save(plain.deploy({ programUuid: "wallet", code: WALLET, context: user("alice") }));
  save(plain.init({ programUuid: "wallet" }));
  save(plain.deploy({ programUuid: "shop", code: SHOP, context: user("alice"), initInput: { shopId: "shop", token: "token", price: 100 } }));
  save(plain.init({ programUuid: "shop" }));
  vm.commit(Object.entries(balances).map(([address, value]) => ({ type: "put", dbKey: `${address}:native:received`, value })));
  return vm;
}

/** ยิง request แล้วได้ receipt เลย */
function receiptOf(vm, action, request, index = 0) {
  return vm.buildReceipt(request, vm[action](request, { timestamp: T }), { index, action });
}

// ---------------------------------------------------------------------------
//  แบบง่าย
// ---------------------------------------------------------------------------

test("receipt: transfer ระหว่าง wallet", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "transfer", { from: "ALICE", to: "0xBoB", amount: 500, nonce: 0 });

  assert.match(receipt.hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(receipt, {
    hash: receipt.hash,
    index: 0,
    digest: null,
    action: "transfer",
    timestamp: T,
    time: "2024-06-01T10:00:00.000Z",
    status: "success",
    from: "alice",
    to: "0xbob",
    method: "transfer",
    input: null,
    value: 500,
    result: { from: "alice", to: "0xbob", amount: 500 },
    error: null,
    gasUsed: GAS.call + 2 * (GAS.read + GAS.write),
    gasPrice: null,
    fee: GAS.call + 2 * (GAS.read + GAS.write),
    nonce: 1,
    events: [],
    trace: [],
    nativeChanges: [
      { address: "alice", field: "sended", after: 500 },
      { address: "0xbob", field: "received", after: 500 },
      { address: "alice", field: "consumed", after: receipt.fee },
      { address: VM.BURN_ADDRESS, field: "received", after: receipt.fee }, // ไม่ได้ตั้ง feeRecipient → เผาทั้งหมด
    ],
    stateChanges: [],
    programChanges: [],
  });
});

test("receipt: call ธรรมดา (อ่าน อย่างเดียว)", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("alice"), nonce: 0 });

  assert.equal(receipt.status, "success");
  assert.equal(receipt.result, 1000);
  assert.deepEqual(receipt.stateChanges, []);
  assert.deepEqual(receipt.trace, [{ depth: 0, program: "token", method: "balanceOf", from: "alice", origin: "alice", input: { account: "alice" }, value: 0, result: 1000, gasUsed: GAS.call + GAS.read, status: "success", error: null }]);
  assert.equal(receipt.gasUsed, GAS.call + GAS.read);
  assert.deepEqual(receipt.nativeChanges, [
    { address: "alice", field: "consumed", after: receipt.fee },
    { address: VM.BURN_ADDRESS, field: "received", after: receipt.fee }, // ไม่ได้ตั้ง feeRecipient → เผาทั้งหมด
  ]);
});

test("receipt: call ที่เปลี่ยนข้อมูล", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 30 }, context: user("alice"), nonce: 0 });

  assert.deepEqual(receipt.result, { from: "alice", to: "bob", amount: 30 });
  assert.deepEqual(receipt.stateChanges, [
    { program: "token", key: ["balances", "alice"], after: 970 },
    { program: "token", key: ["balances", "bob"], after: 30 },
  ]);
  assert.equal(receipt.nonce, 1);
});

test("receipt: call ที่ล้ม", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 0 });

  assert.equal(receipt.status, "throw");
  assert.deepEqual(receipt.error, { code: "PROGRAM_ERROR", message: "ยอดไม่พอ" });
  assert.equal(receipt.result, null);
  assert.deepEqual(receipt.stateChanges, []);
  assert.deepEqual(receipt.trace[0].error, { code: "PROGRAM_ERROR", message: "ยอดไม่พอ" });
  assert.equal(receipt.nonce, 1);                       // ล้มก็กิน nonce
  assert.ok(receipt.fee > 0);                           // และจ่ายค่าแก๊ส
});

test("receipt: nonce ผิด → ไม่กิน nonce ไม่เสียค่าแก๊ส", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("alice"), nonce: 7 });

  assert.equal(receipt.error.code, "INVALID_REQUEST");
  assert.equal(receipt.nonce, null);
  assert.equal(receipt.fee, 0);
  assert.deepEqual(receipt.nativeChanges, []);
});

test("receipt: deploy / init / reject", () => {
  const vm = setup();
  const deployed = receiptOf(vm, "deploy", { programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 3 }, value: 250, nonce: 0 });
  assert.equal(deployed.action, "deploy");
  assert.equal(deployed.method, "deploy");
  assert.equal(deployed.value, 250);
  assert.deepEqual(deployed.programChanges, [{ kind: "pending", address: "counter", removed: false }]);
  assert.deepEqual(deployed.nativeChanges, [
    { address: "alice", field: "sended", after: 250 },
    { address: "counter", field: "received", after: 250 },
    { address: "alice", field: "consumed", after: deployed.fee },
    { address: VM.BURN_ADDRESS, field: "received", after: deployed.fee }, // ไม่ได้ตั้ง feeRecipient → เผาทั้งหมด
  ]);
  // receipt ด้านบนไม่ได้ commit ดังนั้น nonce ของ alice ยังเป็น 0
  vm.commit(vm.deploy({ programUuid: "counter2", code: COUNTER, context: user("alice"), initInput: { start: 3 }, nonce: 0 }, { timestamp: T }).writes);

  const initialized = receiptOf(vm, "init", { programUuid: "counter2" });
  assert.equal(initialized.action, "init");
  assert.equal(initialized.method, "init");
  assert.equal(initialized.from, null);                  // init มาจากทีมงาน ไม่ใช่ user
  assert.equal(initialized.nonce, null);
  assert.deepEqual(initialized.stateChanges, [{ program: "counter2", key: ["count"], after: 3 }]);
  assert.deepEqual(initialized.programChanges, [
    { kind: "code", address: "counter2", removed: false },
    { kind: "context", address: "counter2", removed: false },
    { kind: "this", address: "counter2", removed: false },
    { kind: "pending", address: "counter2", removed: true },
  ]);

  vm.commit(vm.deploy({ programUuid: "counter3", code: COUNTER, context: user("alice"), value: 40, nonce: 1 }, { timestamp: T }).writes);
  const rejected = receiptOf(vm, "reject", { programUuid: "counter3" });
  assert.equal(rejected.result.refund, 40);
  assert.deepEqual(rejected.programChanges, [{ kind: "pending", address: "counter3", removed: true }]);
  assert.deepEqual(rejected.nativeChanges.map((c) => `${c.address}:${c.field}`), ["counter3:sended", "alice:received"]);
});

// ---------------------------------------------------------------------------
//  แบบซับซ้อน
// ---------------------------------------------------------------------------

test("receipt: เรียกข้ามโปรแกรม (shop → token) — trace 2 ชั้น", () => {
  const vm = setup();
  vm.commit(vm.call({ programUuid: "token", functionName: "approve", input: { spender: "shop", amount: 500 }, context: user("alice"), nonce: 0 }, { timestamp: T }).writes);
  const receipt = receiptOf(vm, "call", { programUuid: "shop", functionName: "buy", context: user("alice"), nonce: 1 }, 3);

  assert.equal(receipt.index, 3);
  assert.deepEqual(receipt.trace, [
    { depth: 0, program: "shop", method: "buy", from: "alice", origin: "alice", input: {}, value: 0, result: 1, gasUsed: 550, status: "success", error: null },
    { depth: 1, program: "token", method: "transferFrom", from: "shop", origin: "alice", input: { from: "alice", to: "shop", amount: 100 }, value: 0, result: { from: "alice", to: "shop", amount: 100 }, gasUsed: 290, status: "success", error: null },
  ]);
  assert.deepEqual(receipt.stateChanges.map((c) => `${c.program}/${c.key.join("/")} = ${c.after}`), [
    "token/allowance/alice/shop = 400",
    "token/balances/alice = 900",
    "token/balances/shop = 100",
    "shop/items/alice = 1",
    "shop/sales = 1",
  ]);
});

test("receipt: โปรแกรมที่ถูกเรียกล้มแต่ผู้เรียก catch ไว้ — trace เห็น throw ข้างใน แต่ tx สำเร็จ", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "shop", functionName: "buySafe", context: user("alice"), nonce: 0 });

  assert.equal(receipt.status, "success");
  assert.deepEqual(receipt.trace.map((t) => `${t.depth} ${t.program}.${t.method} ${t.status}`), [
    "0 shop.buySafe success",
    "1 token.transferFrom throw",
  ]);
  assert.deepEqual(receipt.stateChanges.map((c) => c.program), ["shop", "shop"]); // เฉพาะ log ของ shop, ของ token ถูกย้อน
});

test("receipt: แนบเงินและส่งต่อ — เงินหลายทอดในใบเดียว", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", {
    programUuid: "wallet", functionName: "forward",
    input: { target: "wallet", value: 40 }, context: user("alice"), value: 100, nonce: 0,
  });

  assert.equal(receipt.value, 100);
  assert.deepEqual(receipt.trace.map((t) => `${t.depth} ${t.program}.${t.method} ← ${t.from}`), [
    "0 wallet.forward ← alice",
    "1 wallet.deposit ← wallet",
  ]);
  assert.deepEqual(receipt.nativeChanges, [
    { address: "alice", field: "sended", after: 100 },
    { address: "wallet", field: "received", after: 140 }, // รับจาก alice 100 + รับจากตัวเอง 40
    { address: "wallet", field: "sended", after: 40 },
    { address: "alice", field: "consumed", after: receipt.fee },
    { address: VM.BURN_ADDRESS, field: "received", after: receipt.fee }, // ไม่ได้ตั้ง feeRecipient → เผาทั้งหมด
  ]);
});

test("receipt: OUT_OF_GAS และ TIMEOUT", () => {
  const vm = setup({ gas: { ...GAS, price: 1 } }, { alice: 150 });
  const outOfGas = receiptOf(vm, "call", { programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice"), nonce: 0 });
  assert.equal(outOfGas.error.code, "OUT_OF_GAS");
  assert.deepEqual(outOfGas.nativeChanges, [
    { address: "alice", field: "consumed", after: 150 }, // จ่ายเท่าที่มี
    { address: VM.BURN_ADDRESS, field: "received", after: 150 },
  ]);
  assert.deepEqual(outOfGas.stateChanges, []);

  const slow = setup({ requireNonce: false, chargeGas: false });
  slow.timeoutMs = 100;
  slow.commit(slow.deploy({ programUuid: "faulty", code: FAULTY, context: user("alice") }, { timestamp: T }).writes);
  slow.commit(slow.init({ programUuid: "faulty" }, { timestamp: T }).writes);
  const timeout = slow.buildReceipt(
    { programUuid: "faulty", functionName: "spin", context: user("alice") },
    slow.call({ programUuid: "faulty", functionName: "spin", context: user("alice") }, { timestamp: T }),
    { action: "call" },
  );
  assert.equal(timeout.error.code, "TIMEOUT");
  assert.deepEqual(timeout.trace, [{ depth: 0, program: "faulty", method: "spin", from: "alice", origin: "alice", input: {}, value: 0, result: null, gasUsed: 150, status: "throw", error: { code: "TIMEOUT", message: "โปรแกรมทำงานเกินเวลาที่กำหนด" } }]);
});

test("receipt: เดา action เองได้เมื่อไม่ได้ระบุ", () => {
  const vm = setup();
  const transfer = vm.transfer({ from: "alice", to: "bob", amount: 10, nonce: 0 }, { timestamp: T });
  assert.equal(vm.buildReceipt({ from: "alice", to: "bob", amount: 10 }, transfer).action, "transfer");
  assert.equal(vm.buildReceipt({ programUuid: "token", functionName: "x", context: user("a") }, {}).action, "call");
  assert.equal(vm.buildReceipt({ programUuid: "p", code: "x", context: user("a") }, {}).action, "deploy");
  assert.equal(vm.buildReceipt({}, {}).action, "unknown");
});

// ---------------------------------------------------------------------------
//  block.receipt()
// ---------------------------------------------------------------------------

test("block.receipt: สรุปทุก tx พร้อมยอดรวม", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "approve", input: { spender: "shop", amount: 500 }, context: user("alice"), nonce: 0 });
  block.call({ programUuid: "shop", functionName: "buy", context: user("alice"), nonce: 1 });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 2 });
  block.transfer({ from: "alice", to: "carol", amount: 300, nonce: 3 });
  block.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 50, nonce: 4 });

  const receipt = block.receipt({ number: 1024 });
  assert.equal(receipt.number, 1024);
  assert.equal(receipt.time, "2024-06-01T10:00:00.000Z");
  assert.deepEqual([receipt.txCount, receipt.successCount, receipt.failedCount], [5, 4, 1]);
  assert.equal(receipt.feeRecipient, "miner");
  assert.equal(receipt.burnPercent, 50);
  assert.equal(receipt.fee, receipt.transactions.reduce((sum, tx) => sum + tx.fee, 0));
  assert.equal(receipt.gasUsed, receipt.transactions.reduce((sum, tx) => sum + tx.gasUsed, 0));

  assert.deepEqual(receipt.transactions.map((tx) => `${tx.index} ${tx.action} ${tx.from}→${tx.to}.${tx.method} ${tx.status}`), [
    "0 call alice→token.approve success",
    "1 call alice→shop.buy success",
    "2 call alice→token.transfer throw",
    "3 transfer alice→carol.transfer success",
    "4 call alice→wallet.deposit success",
  ]);
  assert.deepEqual(receipt.stateChanges.map((c) => `${c.program}/${c.key.join("/")}`), [
    "token/allowance/alice/shop",
    "token/balances/alice",
    "token/balances/shop",
    "shop/items/alice",
    "shop/sales",
    "wallet/deposits/alice",
  ]);

  const native = Object.fromEntries(receipt.nativeChanges.map((c) => [`${c.address}:${c.field}`, c.after]));
  assert.equal(native["carol:received"], 300);
  assert.equal(native["wallet:received"], 50);
  assert.equal(native["miner:received"], Math.floor(receipt.fee / 2));
  assert.equal(native["alice:sended"], 350);            // 300 + 50
  assert.equal(native["alice:consumed"], receipt.fee);
});

test("block.receipt: ตรงกับ DB จริงหลัง commit", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 10 }, context: user("alice"), nonce: 0 });
  block.transfer({ from: "alice", to: "dave", amount: 25, nonce: 1 });
  block.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 1 }, nonce: 2 });
  block.init({ programUuid: "counter" });

  const receipt = block.receipt({ number: 7 });
  block.commit();

  for (const change of receipt.stateChanges) {
    const dbKey = `${change.program}:storage:${change.key.map(encodeURIComponent).join(":")}`;
    assert.deepEqual(vm.db.readKeys([dbKey])[0], change.after, dbKey);
  }
  for (const change of receipt.nativeChanges) {
    assert.equal(vm.db.readKeys([`${change.address}:native:${change.field}`])[0], change.after, change.address);
  }
  assert.deepEqual(receipt.transactions.map((tx) => tx.action), ["call", "transfer", "deploy", "init"]);
});

test("block.receipt: block ว่าง และ block ที่ทุก tx ล้ม", () => {
  const vm = setup();
  const empty = vm.createBlock({ timestamp: T }).receipt({ number: 1 });
  assert.deepEqual([empty.txCount, empty.successCount, empty.failedCount, empty.gasUsed, empty.fee, empty.writeCount], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([empty.transactions, empty.stateChanges, empty.nativeChanges], [[], [], []]);

  const failed = vm.createBlock({ timestamp: T });
  failed.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 0 });
  failed.call({ programUuid: "missing", functionName: "x", context: user("alice"), nonce: 1 });
  const receipt = failed.receipt({ number: 2 });
  assert.deepEqual([receipt.txCount, receipt.successCount, receipt.failedCount], [2, 0, 2]);
  assert.deepEqual(receipt.stateChanges, []);
  assert.deepEqual(receipt.nativeChanges.map((c) => c.address), ["alice", VM.BURN_ADDRESS]); // ไม่ได้ตั้ง feeRecipient → เผาทั้งหมดไปที่ 0x000…000
});

test("block.receipt: แปลงเป็น JSON ส่งให้ explorer ได้", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice"), nonce: 0 });

  const json = JSON.parse(JSON.stringify(block.receipt({ number: 3 })));
  assert.equal(json.transactions[0].stateChanges[0].program, "token");
  assert.deepEqual(json.transactions[0].stateChanges[0].key, ["balances", "alice"]);
  assert.equal(json.transactions[0].trace[0].method, "transfer");
});

test("block.receipt: ข้อมูลของ block ไม่เปลี่ยนแม้แก้ receipt ที่ได้ไป", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.transfer({ from: "alice", to: "bob", amount: 10, nonce: 0 });
  const receipt = block.receipt();
  receipt.transactions[0].value = 999;
  receipt.transactions.length = 0;
  assert.equal(block.receipt().transactions[0].value, 10);
});

test("decodeDbKey: อ่าน key ทุกแบบออก", () => {
  assert.deepEqual(VM.decodeDbKey("pending:0xabc"), { kind: "pending", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:code"), { kind: "code", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:context"), { kind: "context", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:this"), { kind: "this", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:nonce"), { kind: "nonce", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:native:received"), { kind: "native", address: "0xabc", field: "received" });
  assert.deepEqual(VM.decodeDbKey("0xabc:storage:balances:0xdef"), { kind: "storage", address: "0xabc", key: ["balances", "0xdef"] });
  assert.deepEqual(VM.decodeDbKey("0xabc:storage:a%3Ab"), { kind: "storage", address: "0xabc", key: ["a:b"] });
});
