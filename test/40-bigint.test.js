import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";

/*
 * Numbers in programs must be BigInt only (the VM always works this way; there is no number mode anymore)
 *   - stored in the DB as strings ending in n ("1000n")
 *   - converted to BigInt automatically on the way into a program, and back to strings on the way out
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
    if (balance < params.input.amount) throw new Error("insufficient balance")
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
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, ...options });
  vm.db.load({ "alice:native:received": "1000000n" });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } });
  block.init({ programUuid: "token" });
  block.commit();
  return vm;
}

const call = (vm, functionName, input = {}, extra = {}) =>
  vm.call({ programUuid: "token", functionName, input, context: user("alice"), ...extra }, { timestamp: T + 1000 });

// ---------------------------------------------------------------------------

test("stored in the DB as strings ending in n", () => {
  const vm = setup();
  assert.equal(vm.db.readKeys(["token:storage:balances:alice"])[0], "1000n");
  assert.equal(vm.db.readKeys(["token:storage:owner"])[0], "alice");   // strings stay strings
});

test("plain number input is converted to BigInt automatically", () => {
  const vm = setup();
  const res = call(vm, "transfer", { to: "bob", amount: 30 });         // client sends a plain 30
  assert.equal(res.status, "success");
  assert.equal(res.result, "970n");                                    // the result comes out as a string
  vm.commit(res.writes);
  assert.deepEqual(vm.db.readKeys(["token:storage:balances:alice", "token:storage:balances:bob"]), ["970n", "30n"]);
});

test("input sent as \"123n\" also works", () => {
  const vm = setup();
  const res = call(vm, "transfer", { to: "bob", amount: "250n" });
  assert.equal(res.result, "750n");
});

test("numbers above 2^53 work correctly", () => {
  const vm = setup();
  const huge = 10n ** 30n;
  const res = call(vm, "bigMath", { a: `${huge}n`, b: "3n" });
  assert.deepEqual(res.result, { sum: `${huge + 3n}n`, product: `${huge * 3n}n` });
});

test("time / block number / balances are BigInt inside programs", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T + 2000, feeRecipient: "miner" });
  const res = block.call({ programUuid: "token", functionName: "info", context: user("alice"), value: 500 });

  assert.deepEqual(res.result, { time: `${T + 2000}n`, block: "2n", balance: "500n", value: "500n" });
});

test("transferNative takes BigInt", () => {
  const vm = setup();
  vm.commit(vm.transfer({ from: "alice", to: "token", amount: 1000 }, { timestamp: T + 500 }).writes);
  const res = call(vm, "payout", { to: "bob", amount: 400 });
  assert.equal(res.result, "600n");
  vm.commit(res.writes);
  assert.equal(vm.nativeBalanceOf("bob").balance, 400n);
});

test("events store numbers as strings ending in n", () => {
  const vm = setup();
  const res = call(vm, "transfer", { to: "bob", amount: 30 });
  assert.deepEqual(res.events[0].data, { from: "alice", to: "bob", amount: "30n" });
});

test("using number inside a program → rejected", () => {
  const vm = setup();
  assert.match(call(vm, "useNumber").error.message, /must be BigInt/);
  assert.match(call(vm, "writeNumber").error.message, /must be BigInt/);
});

test("decimals in input → rejected", () => {
  const vm = setup();
  assert.match(call(vm, "balanceOf", { who: "alice", extra: 1.5 }).error.message, /must be BigInt/);
});

test("comparisons and arithmetic across functions work normally", () => {
  const vm = setup();
  assert.equal(call(vm, "balanceOf", { who: "alice" }).result, "1000n");
  assert.equal(call(vm, "balanceOf", { who: "nobody" }).result, "0n");
  assert.match(call(vm, "transfer", { to: "bob", amount: 99_999 }).error.message, /insufficient balance/);
});

test("no number mode anymore: passing bigintValues: false still gives BigInt", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, bigintValues: false });
  assert.equal("bigintValues" in VM.DEFAULT_OPTIONS, false);
  const code = `function program() {
  function initialization() { writeDB("count", 0n) }
  function add(params) { writeDB("count", readDB("count") + params.input.amount); return readDB("count") }
  function addNumber() { writeDB("count", 1) }
  return { add, addNumber }
}`;
  vm.commit(vm.deploy({ programUuid: "counter", code, context: user("alice") }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "counter" }, { timestamp: T }).writes);
  const res = vm.call({ programUuid: "counter", functionName: "add", input: { amount: 5 }, context: user("alice") }, { timestamp: T });
  assert.equal(res.result, "5n");
  assert.equal(vm.db.readKeys(["counter:storage:count"])[0], "0n");
  const number = vm.call({ programUuid: "counter", functionName: "addNumber", context: user("alice") }, { timestamp: T });
  assert.equal(number.error.code, "INVALID_REQUEST");
  assert.match(number.error.message, /must be BigInt/);
});

test("helpers convert values both ways", () => {
  assert.deepEqual(VM.encodeBigints({ a: 10n, b: ["x", 2n] }), { a: "10n", b: ["x", "2n"] });
  assert.deepEqual(VM.decodeBigints({ a: "10n", b: 5, c: "plain" }), { a: 10n, b: 5n, c: "plain" });
  assert.equal(VM.canonicalJson({ amount: 10n }), '{"amount":"10n"}');
});
