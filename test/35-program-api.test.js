import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY } from "./helpers.js";
import { INSPECTOR, TOKEN } from "./programs.js";

/* APIs programs can call: ThisBalance / BalanceOf / IsProgram / MetadataOf / BlockNumber */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });

function setup({ balances = {}, ...options } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, recordHistory: true, ...options, gas: { ...API_GAS_ONLY, ...options.gas } });
  vm.db.load(Object.fromEntries(Object.entries(balances).map(([address, value]) => [`${address}:native:received`, value])));

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "inspector", code: INSPECTOR, context: user("owner"), initInput: { name: "auditor" } });
  block.init({ programUuid: "inspector" });
  block.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 100 } });
  block.init({ programUuid: "token" });
  block.commit();
  return vm;
}

const call = (vm, functionName, input = {}, options = {}) =>
  vm.call({ programUuid: "inspector", functionName, input, context: user("alice"), ...options }, { timestamp: T + 1000 });

// ---------------------------------------------------------------------------

test("ThisBalance: the program's own balance, updated as it receives funds", () => {
  const vm = setup({ balances: { alice: 1000 } });
  assert.equal(call(vm, "me").result.balance, "0n");

  const res = call(vm, "me", {}, { value: 250 });   // value attached to the call
  assert.equal(res.result.balance, "250n");
  vm.commit(res.writes);
  assert.equal(call(vm, "me").result.balance, "250n");
});

test("ThisBalance: sees the latest balance after sending out in the same call", () => {
  const vm = setup({ balances: { alice: 1000 } });
  vm.commit(vm.transfer({ from: "alice", to: "inspector", amount: 500 }, { timestamp: T + 500 }).writes);

  const res = call(vm, "sendAll", { to: "bob" });
  assert.equal(res.result, "0n");                       // everything sent out, balance is 0 immediately
  assert.equal(res.writes.find((w) => w.dbKey === "bob:native:received").value, "500n");
});

test("BalanceOf: can read another address's balance", () => {
  const vm = setup({ balances: { alice: 1000, bob: 42 } });
  assert.equal(call(vm, "look", { address: "bob" }).result.balance, "42n");
  assert.equal(call(vm, "look", { address: "nobody" }).result.balance, "0n");
  assert.equal(call(vm, "look", { address: "0xALICE" }).result.balance, "0n"); // a different address from alice
});

test("IsProgram: tells wallets and programs apart", () => {
  const vm = setup({ balances: { alice: 1000 } });
  assert.equal(call(vm, "look", { address: "token" }).result.isProgram, true);
  assert.equal(call(vm, "look", { address: "inspector" }).result.isProgram, true);
  assert.equal(call(vm, "look", { address: "alice" }).result.isProgram, false);
});

test("IsProgram: guards against sending to programs that cannot receive funds", () => {
  const vm = setup({ balances: { alice: 1000 } });
  vm.commit(vm.transfer({ from: "alice", to: "inspector", amount: 300 }, { timestamp: T + 500 }).writes);

  assert.equal(call(vm, "payIfWallet", { to: "bob", amount: 100 }).result, "200n");
  const blocked = call(vm, "payIfWallet", { to: "token", amount: 100 });
  assert.equal(blocked.error.message, "ปลายทางเป็นโปรแกรม");
});

test("MetadataOf: reads another address's metadata", () => {
  const vm = setup({ balances: { alice: 1000 } });
  const result = call(vm, "look", { address: "inspector" }).result;
  assert.equal(result.namespace, "auditor");
  assert.equal(result.creator, "owner");

  assert.equal(call(vm, "look", { address: "alice" }).result.namespace, null); // a wallet with no name set
});

test("BlockNumber: number of the block the tx is in (null outside a block)", () => {
  const vm = setup({ balances: { alice: 1000 } });
  assert.equal(call(vm, "me").result.block, null);   // called directly via vm.call

  const block = vm.createBlock({ timestamp: T + 2000, feeRecipient: "miner" });
  const res = block.call({ programUuid: "inspector", functionName: "me", context: user("alice") });
  assert.equal(res.result.block, "2n");
  assert.equal(block.number, 2);
});

test("input validation: empty address / empty field → INVALID_REQUEST", () => {
  const vm = setup({ balances: { alice: 1000 } });
  assert.equal(call(vm, "look", { address: "" }).error.code, "INVALID_REQUEST");
  assert.equal(call(vm, "look", { address: 123 }).error.code, "INVALID_REQUEST");
});

test("gas: APIs that read the DB charge gas per key read", () => {
  const gas = { call: 0, read: 10, write: 0, byte: 0, code: 0, price: 1 };
  const vm = setup({ balances: { alice: 1_000_000 }, chargeGas: true, gas });

  const balance = call(vm, "me");                                   // ThisBalance = 3 read
  assert.equal(balance.gasUsed, 3 * gas.read);

  const look = call(vm, "look", { address: "token" });               // 3 (BalanceOf) + 1 (IsProgram) + 2 (MetadataOf)
  assert.equal(look.gasUsed, 6 * gas.read);
});

test("the new APIs also work in nested program calls", () => {
  const vm = setup({ balances: { alice: 1000 } });
  vm.commit(vm.transfer({ from: "alice", to: "inspector", amount: 100 }, { timestamp: T + 500 }).writes);

  // token.transfer called from inspector → inspector still sees its own balance correctly
  const res = call(vm, "me");
  assert.equal(res.result.balance, "100n");
  assert.equal(res.result.address, "inspector");
});
