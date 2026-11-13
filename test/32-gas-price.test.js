import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY, num } from "./helpers.js";
import { TOKEN } from "./programs.js";

/* sender-chosen gasPrice: pay more to be picked into a block first */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const GAS = { ...API_GAS_ONLY, call: 100, read: 0, write: 0, stateKey: 0, byte: 0, price: 2 }; // minimum price 2

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true,
    gas: GAS, feeRecipient: "miner", burnPercent: 50, ...options,
  });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  vm.db.load({ "alice:native:received": "1000000n", "bob:native:received": "1000000n" });
  return vm;
}

const transfer = (sender, nonce, gasPrice) => ({
  programUuid: "token", functionName: "transfer", input: { to: "carol", amount: 1 }, context: user(sender), nonce, gasPrice,
});

// ---------------------------------------------------------------------------
//  gas charged at the offered price
// ---------------------------------------------------------------------------

test("gasPrice: not given → uses the system minimum price", () => {
  const vm = setup();
  const res = vm.call(transfer("alice", 0), { timestamp: T });
  assert.equal(res.gasPrice, `${GAS.price}n`);   // prices / fees are exported as "123n"
  assert.equal(num(res.fee), res.gasUsed * GAS.price);
});

test("gasPrice: higher offer → pays proportionally more", () => {
  const vm = setup();
  const cheap = vm.call(transfer("alice", 0), { timestamp: T });
  const expensive = vm.call(transfer("bob", 0, 10), { timestamp: T });

  assert.equal(expensive.gasPrice, "10n");
  assert.equal(expensive.gasUsed, cheap.gasUsed);          // same work
  assert.equal(num(expensive.fee), cheap.gasUsed * 10);    // but pays 5× more
  assert.equal(num(expensive.fee), num(cheap.fee) * 5);
});

test("gasPrice: the block sealer gets a larger share as the paid price rises", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner", burnPercent: 50 });
  const expensive = block.call(transfer("alice", 0, 20));
  block.commit();

  // EIP-1559: half of the base fee part (gas × 2) is burned per burnPercent · everything paid above the base fee (tip) goes to the block sealer
  const base = expensive.gasUsed * GAS.price;
  assert.equal(num(vm.nativeBalanceOf("miner").balance), num(expensive.fee) - base + Math.floor(base / 2));
  assert.equal(num(expensive.producerFee) + num(expensive.burnedFee), num(expensive.fee));
  assert.equal(num(vm.nativeBalanceOf("alice").consumed), num(expensive.fee));
});

test("gasPrice: below the minimum or malformed → rejected", () => {
  const vm = setup();
  for (const gasPrice of [1, 0, -5, 1.5, "1.5", "abc"]) {
    const res = vm.call(transfer("alice", 0, gasPrice), { timestamp: T });
    assert.equal(res.error.code, "INVALID_REQUEST", `gasPrice ${gasPrice}`);
    assert.match(res.error.message, /gasPrice/);
  }
  assert.equal(vm.call(transfer("alice", 0, 2), { timestamp: T }).status, "success"); // equal to the minimum is fine
});

test("gasPrice: the gas cap is computed from the offered price — a higher price means the balance covers less", () => {
  const vm = setup();
  vm.db.clear();
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  vm.db.load({ "alice:native:received": "150n" }); // enough for 100 gas at price 1 but not at price 10

  const res = vm.call(transfer("alice", 0, 10), { timestamp: T });
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.equal(res.fee, "150n"); // pays what it has
});

test("gasPrice: part of the tx hash (different price = different tx)", () => {
  const vm = setup();
  const base = vm.hashTransaction(transfer("alice", 0));
  assert.notEqual(base, vm.hashTransaction(transfer("alice", 0, 5)));
  assert.equal(vm.hashTransaction(transfer("alice", 0, 5)), vm.hashTransaction(transfer("alice", 0, 5)));
  assert.equal(vm.transactionPayload(transfer("alice", 0, 5)).gasPrice, 5);
});

test("gasPrice: present in the tx receipt", () => {
  const vm = setup();
  const request = transfer("alice", 0, 7);
  const receipt = vm.buildReceipt(request, vm.call(request, { timestamp: T }));
  assert.equal(receipt.gasPrice, "7n");
  assert.equal(num(receipt.fee), receipt.gasUsed * 7);
});

// ---------------------------------------------------------------------------
//  queue ordered by price
// ---------------------------------------------------------------------------

test("sortPendingTransactions: higher payers go first", () => {
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

test("sortPendingTransactions: txs from the same address always stay in nonce order", () => {
  const items = [
    { request: transfer("alice", 2, 100) },  // expensive but a later nonce
    { request: transfer("alice", 0, 3) },
    { request: transfer("alice", 1, 3) },
    { request: transfer("bob", 0, 50) },
  ];
  assert.deepEqual(
    VM.sortPendingTransactions(items).map((item) => `${item.request.context.sender}#${item.request.nonce}`),
    ["bob#0", "alice#0", "alice#1", "alice#2"], // alice uses the lowest price in her own queue (3), so she comes after bob
  );
});

test("sortPendingTransactions: equal price → first come, first served", () => {
  const items = [
    { request: transfer("bob", 0, 5), receivedAt: 200 },
    { request: transfer("alice", 0, 5), receivedAt: 100 },
  ];
  assert.deepEqual(
    VM.sortPendingTransactions(items).map((item) => item.request.context.sender),
    ["alice", "bob"],
  );
});

test("sortPendingTransactions: no price → counted as the minimum, and transfer txs are supported", () => {
  const items = [
    { request: { from: "alice", to: "x", amount: 1, nonce: 0 } },
    { request: { from: "bob", to: "x", amount: 1, nonce: 0, gasPrice: 9 } },
  ];
  assert.deepEqual(
    VM.sortPendingTransactions(items, { defaultGasPrice: 1 }).map((item) => item.request.from),
    ["bob", "alice"],
  );
});

test("flow: the price-sorted queue really goes into a block", () => {
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
    ["bob", "bob", "alice"], // the higher-paying tx runs first
  );
});

// ---------------------------------------------------------------------------
//  deploy gas depends on code size
// ---------------------------------------------------------------------------

test("deploy: gas depends on code size (longer = more expensive)", () => {
  const vm = setup({ requireNonce: false, gas: { ...GAS, code: 10 } });
  const small = "function program() {\n  function a() { return 1 }\n  return { a }\n}";
  const large = `function program() {\n  function a() { return 1 }\n  // ${"x".repeat(500)}\n  return { a }\n}`;

  const cheap = vm.deploy({ programUuid: "small", code: small, context: user("alice") });
  const expensive = vm.deploy({ programUuid: "large", code: large, context: user("alice") });

  assert.equal(cheap.gasUsed, GAS.call + 10 * Buffer.byteLength(VM.toOneLine(small)));
  const sizeOf = (code) => Buffer.byteLength(VM.toOneLine(code));
  assert.equal(expensive.gasUsed - cheap.gasUsed, 10 * (sizeOf(large) - sizeOf(small))); // differs by the number of added bytes
  assert.equal(num(expensive.fee), expensive.gasUsed * GAS.price);
});

test("deploy: non-ASCII code is charged by its real byte count", () => {
  const vm = setup({ requireNonce: false, gas: { ...GAS, code: 1 } });
  const ascii = 'function program() {\n  function a() { return "abc" }\n  return { a }\n}';
  // non-ASCII text is intentional: tests UTF-8 byte counting
  const cjk = 'function program() {\n  function a() { return "中文字" }\n  return { a }\n}';

  const plain = vm.deploy({ programUuid: "ascii", code: ascii, context: user("alice") });
  const unicode = vm.deploy({ programUuid: "cjk", code: cjk, context: user("alice") });
  assert.equal(unicode.gasUsed - plain.gasUsed, 6); // 3 CJK characters = 9 bytes instead of 3
});

test("deploy: code longer than maxCodeSize → rejected", () => {
  const vm = setup({ requireNonce: false, maxCodeSize: 200 });
  const long = `function program() {\n  // ${"x".repeat(300)}\n  return {}\n}`;
  const res = vm.deploy({ programUuid: "big", code: long, context: user("alice") });

  assert.equal(res.error.code, "INVALID_REQUEST");
  assert.match(res.error.message, /code too long/);
  assert.equal(vm.deploy({ programUuid: "ok", code: "function program() { return {} }", context: user("alice") }).status, "success");
});

test("deploy: the default maxCodeSize is 64KB", () => {
  assert.equal(VM.DEFAULT_OPTIONS.maxCodeSize, 64 * 1024);
  assert.equal(VM.DEFAULT_GAS.code, 10);
});
