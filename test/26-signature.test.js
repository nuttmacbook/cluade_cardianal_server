import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN, COUNTER } from "./programs.js";

/* ตรวจลายเซ็นก่อนส่งเข้า VM: sender / origin มาจากลายเซ็นเท่านั้น */

let endpointCounter = 0;
const ALICE_KEY = sign.randomPrivateKey();
const BOB_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);
const bob = sign.addressOf(BOB_KEY);

/** server: รับ { tx, signature } → ตรวจ → ส่งเข้า VM */
function submit(vm, tx, signature) {
  const { method, request } = sign.verifyTransaction({ tx, signature });
  const result = vm[method](request);
  if (result.status === "success") vm.commit(result.writes);
  return result;
}

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, recordTransactions: true, deriveProgramAddress: true, ...options,
  });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: { sender: alice, origin: alice }, initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  return vm;
}

const transferTx = (nonce = 0, overrides = {}) => ({
  chainId: 1, action: "call", from: alice, to: "token", method: "transfer",
  input: { to: bob, amount: 30 }, value: 0, nonce, gasLimit: 0, ...overrides,
});

// ---------------------------------------------------------------------------
//  key / address / ลายเซ็น
// ---------------------------------------------------------------------------

test("key: address มาจาก private key แบบเดียวกับ EVM", () => {
  assert.match(alice, /^0x[0-9a-f]{40}$/);
  assert.notEqual(alice, bob);
  assert.equal(sign.addressOf(ALICE_KEY), alice); // ได้ค่าเดิมเสมอ
});

test("sign / recover: กู้ address ของผู้เซ็นได้ถูกต้อง", () => {
  const tx = transferTx();
  const signature = sign.signTransaction(tx, ALICE_KEY);
  assert.match(signature, /^0x[0-9a-f]{130}$/); // r(32) + s(32) + v(1)
  assert.equal(sign.recoverSigner(tx, signature), alice);
  assert.equal(sign.recoverSigner(tx, sign.signTransaction(tx, BOB_KEY)), bob);
});

test("hash: tx เดิมได้ digest เดิม, เปลี่ยนอะไรก็ได้ digest ใหม่", () => {
  const base = sign.hashTypedData(transferTx());
  assert.equal(base, sign.hashTypedData(transferTx()));
  assert.match(base, /^0x[0-9a-f]{64}$/);

  const variants = [
    transferTx(1),
    transferTx(0, { input: { to: bob, amount: 31 } }),
    transferTx(0, { to: "other" }),
    transferTx(0, { method: "approve" }),
    transferTx(0, { value: 1 }),
    transferTx(0, { gasLimit: 5000 }),
    transferTx(0, { chainId: 2 }),
    transferTx(0, { from: bob }),
  ];
  assert.equal(new Set([base, ...variants.map(sign.hashTypedData)]).size, variants.length + 1);
});

test("typed data: โครงสร้าง EIP-712 ที่ wallet จะแสดงให้ผู้ใช้ดู", () => {
  const typed = sign.buildTypedData(transferTx(3));
  assert.deepEqual(typed.domain, { name: "ProgramVM", version: "1", chainId: 1 });
  assert.equal(typed.primaryType, "Transaction");
  assert.deepEqual(typed.types.Transaction.map((field) => field.name), ["action", "from", "to", "method", "input", "value", "nonce", "gasLimit", "gasPrice"]);
  assert.deepEqual(
    { ...typed.message, input: JSON.parse(typed.message.input) },
    { action: "call", from: alice, to: "token", method: "transfer", input: { code: null, input: { to: bob, amount: 30 } }, value: 0, nonce: 3, gasLimit: 0, gasPrice: 0 },
  );
});

test("verify: ลายเซ็นปลอม / แก้ tx หลังเซ็น / from ไม่ตรง → ถูกปฏิเสธ", () => {
  const tx = transferTx();
  const signature = sign.signTransaction(tx, ALICE_KEY);

  assert.throws(() => sign.verifyTransaction({ tx: transferTx(0, { input: { to: bob, amount: 999 } }), signature }), /ลายเซ็นไม่ตรงกับ from/);
  assert.throws(() => sign.verifyTransaction({ tx: { ...tx, from: bob }, signature }), /ลายเซ็นไม่ตรงกับ from/);
  assert.throws(() => sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, BOB_KEY) }), /ลายเซ็นไม่ตรงกับ from/);
  assert.throws(() => sign.verifyTransaction({ tx, signature: "0x1234" }), /signature ต้องยาว 65 byte/);
  assert.throws(() => sign.verifyTransaction({ tx, signature: `${signature.slice(0, -2)}05` }), /v ต้องเป็น 27 หรือ 28/);
});

test("verify: tx ที่เซ็นในอีก chain ใช้ที่นี่ไม่ได้", () => {
  const tx = transferTx(0, { chainId: 999 });
  const signature = sign.signTransaction(tx, ALICE_KEY);
  assert.equal(sign.verifyTransaction({ tx, signature }).sender, alice);              // ถูกต้องใน chain ของมันเอง
  assert.throws(() => sign.verifyTransaction({ tx: { ...tx, chainId: 1 }, signature }), /ลายเซ็นไม่ตรงกับ from/);
});

// ---------------------------------------------------------------------------
//  ใช้งานจริงกับ VM
// ---------------------------------------------------------------------------

test("flow: tx ที่เซ็นถูกต้องทำงานได้ และ sender มาจากลายเซ็น", () => {
  const vm = setup();
  const tx = transferTx(0);
  const res = submit(vm, tx, sign.signTransaction(tx, ALICE_KEY));

  assert.equal(res.status, "success");
  assert.equal(res.calls[0].sender, alice);
  assert.equal(vm.db.readKeys([`token:storage:balances:${bob}`])[0], 30);
});

test("flow: ปลอม from ไม่ได้ — bob เซ็นแต่อ้างว่าเป็น alice", () => {
  const vm = setup();
  const tx = transferTx(0, { from: alice });
  assert.throws(() => submit(vm, tx, sign.signTransaction(tx, BOB_KEY)), /ลายเซ็นไม่ตรงกับ from/);
  assert.equal(vm.db.readKeys([`token:storage:balances:${bob}`])[0], undefined);
});

test("flow: ส่ง tx เดิมซ้ำไม่ได้ (nonce กันไว้)", () => {
  const vm = setup();
  const tx = transferTx(0);
  const signature = sign.signTransaction(tx, ALICE_KEY);
  assert.equal(submit(vm, tx, signature).status, "success");
  assert.equal(submit(vm, tx, signature).error.code, "INVALID_REQUEST"); // nonce ใช้ไปแล้ว
});

test("flow: origin = sender เสมอ แม้ context ที่แนบมาจะมั่ว", () => {
  const vm = setup();
  const tx = transferTx(0);
  const { request } = sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, ALICE_KEY) });
  assert.deepEqual(request.context, { sender: alice, origin: alice });

  const tampered = { ...request, context: { sender: alice, origin: bob } }; // server เผลอส่ง origin ผิด
  const res = vm.call(tampered);
  assert.equal(res.calls[0].origin, alice); // VM บังคับให้เท่ากับ sender
});

test("flow: deploy ที่เซ็นแล้ว — address ของโปรแกรมคำนวณจากผู้เซ็น", () => {
  const vm = setup();
  const tx = { chainId: 1, action: "deploy", from: alice, to: "", method: "", input: { start: 5 }, code: COUNTER, value: 0, nonce: 0, gasLimit: 0 };
  const res = submit(vm, tx, sign.signTransaction(tx, ALICE_KEY));

  assert.equal(res.status, "success");
  assert.equal(res.result.programUuid, vm.programAddressFor(alice, 0));
  assert.equal(vm.init({ programUuid: res.result.programUuid }).status, "success");
});

test("flow: transfer native ที่เซ็นแล้ว", () => {
  const vm = setup();
  vm.db.load({ [`${alice}:native:received`]: 1000 });
  const tx = { chainId: 1, action: "transfer", from: alice, to: bob, method: "", input: {}, value: 250, nonce: 0, gasLimit: 0 };
  const res = submit(vm, tx, sign.signTransaction(tx, ALICE_KEY));

  assert.deepEqual(res.result, { from: alice, to: bob, amount: 250 });
  assert.equal(vm.nativeBalanceOf(bob).balance, 250);
});

test("flow: ลายเซ็นถูกเก็บไว้ตรวจย้อนหลังใน <addr>:txn:<nonce>:<hash>", () => {
  const vm = setup();
  const tx = transferTx(0);
  const signature = sign.signTransaction(tx, ALICE_KEY);
  submit(vm, tx, signature);

  const [record] = vm.listTransactionsOf(alice);
  assert.equal(record.signature, signature);
  assert.equal(record.status, "success");
  assert.equal(sign.recoverSigner(tx, record.signature), alice); // พิสูจน์ย้อนหลังได้ว่า alice เซ็นจริง
});

test("flow: tx ที่ล้มก็เก็บลายเซ็นไว้", () => {
  const vm = setup();
  const tx = transferTx(0, { input: { to: bob, amount: 99999 } });
  const signature = sign.signTransaction(tx, ALICE_KEY);
  const res = submit(vm, tx, signature);

  assert.equal(res.error.code, "PROGRAM_ERROR");
  vm.commit(res.writes); // tx ที่ล้มก็ยังต้องบันทึก nonce / record
  assert.equal(vm.listTransactionsOf(alice)[0].signature, signature);
});

test("flow: หลาย tx ใน block เดียว ทุกใบต้องผ่านการตรวจก่อน", () => {
  const vm = setup();
  vm.db.load({ [`${alice}:native:received`]: 1000 });
  const block = vm.createBlock({ timestamp: 1_700_000_000_000, number: 1, feeRecipient: "0xminer" });

  const signed = [transferTx(0), transferTx(1, { input: { to: bob, amount: 10 } })].map((tx) => ({ tx, signature: sign.signTransaction(tx, ALICE_KEY) }));
  for (const { tx, signature } of signed) {
    const { method, request } = sign.verifyTransaction({ tx, signature });
    block[method](request);
  }
  block.commit();

  assert.deepEqual(block.results().map((r) => r.status), ["success", "success"]);
  assert.equal(vm.db.readKeys([`token:storage:balances:${bob}`])[0], 40);
  assert.deepEqual(vm.listTransactionsOf(alice).map((r) => r.nonce), [1, 0]);
});

test("flow: metadata tx ที่เซ็นแล้ว — ตั้งชื่อให้ address ตัวเอง", () => {
  const vm = setup();
  const tx = { chainId: 1, action: "metadata", from: alice, to: "", method: "", input: { namespace: "Alice", icon: "👩" }, value: 0, nonce: 0, gasLimit: 0 };
  const res = submit(vm, tx, sign.signTransaction(tx, ALICE_KEY));

  assert.equal(res.status, "success");
  assert.equal(vm.resolveNamespace("alice"), alice);
  assert.deepEqual(vm.getMetadata(alice), { namespace: "alice", icon: "👩" });
  assert.throws(() => sign.verifyTransaction({ tx: { ...tx, from: bob }, signature: sign.signTransaction(tx, ALICE_KEY) }), /ลายเซ็นไม่ตรงกับ from/);
});
