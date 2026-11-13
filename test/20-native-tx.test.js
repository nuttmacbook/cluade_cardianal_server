import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, num } from "./helpers.js";
import { FUNDED, WALLET } from "./programs.js";

/* vm.transfer (native transfers between addresses) and value attached to deploy */

const T = 1_700_000_000_000;
const user = (name) => ({ sender: name, origin: name });
const GAS = { call: 100, read: 0, write: 0, byte: 0, code: 0, price: 1 }; // code: 0 keeps the test numbers readable
let endpointCounter = 0;

function setup(options = {}, balances = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), options);
  vm.commit(Object.entries(balances).map(([address, value]) => ({ type: "put", dbKey: `${address}:native:received`, value })));
  return vm;
}

const native = (vm, address) => num(vm.nativeBalanceOf(address).balance);
const balanceOf = (vm, address) => num(vm.nativeBalanceOf(address));
const nativeWrites = (res) => Object.fromEntries(res.writes.filter((w) => w.dbKey.includes(":native:")).map((w) => [w.dbKey.replace(":native:", ":"), num(w.value)]));

// ---------------------------------------------------------------------------
//  vm.transfer
// ---------------------------------------------------------------------------

test("transfer: transfer between wallets without calling a program", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.transfer({ from: "alice", to: "BOB", amount: 300 });

  assert.equal(res.status, "success");
  assert.deepEqual(res.result, { from: "alice", to: "bob", amount: "300n" });   // native amounts are exported as "123n"
  assert.deepEqual(res.calls, []);
  assert.deepEqual(res.writes, [
    { type: "put", dbKey: "alice:native:sended", value: "300n" },
    { type: "put", dbKey: "bob:native:received", value: "300n" },
  ]);
  vm.commit(res.writes);
  assert.equal(native(vm, "alice"), 700);
  assert.equal(native(vm, "bob"), 300);
});

test("transfer: transfer into a program's wallet works too (no code runs)", () => {
  const vm = setup({}, { alice: 1000 });
  vm.commit(vm.transfer({ from: "alice", to: "wallet", amount: 100 }).writes);
  assert.equal(native(vm, "wallet"), 100);
});

test("transfer: insufficient balance / invalid value", () => {
  const vm = setup({}, { alice: 100 });
  assert.equal(vm.transfer({ from: "alice", to: "bob", amount: 200 }).error.message, "insufficient native balance for 'alice'");
  for (const request of [
    { from: "", to: "bob", amount: 1 },
    { from: "alice", to: "", amount: 1 },
    { from: "alice", to: "bob", amount: -5 },
    { from: "alice", to: "bob", amount: "-1n" },
    { from: "alice", to: "bob", amount: 1.5 },
    {},
  ]) {
    assert.equal(vm.transfer(request).error.code, "INVALID_REQUEST");
  }
  assert.equal(native(vm, "alice"), 100);
});

test("transfer: transferring 0 is allowed (as in EVM) · still charges gas and consumes a nonce · 0 to self is allowed too", () => {
  const vm = setup({ requireNonce: true, chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 0 }, { alice: 10_000 });
  const res = vm.transfer({ from: "alice", to: "bob", amount: 0, nonce: 0 });
  assert.equal(res.status, "success");
  assert.deepEqual(res.result, { from: "alice", to: "bob", amount: "0n" });
  assert.equal(res.gasUsed, GAS.call);
  assert.equal(res.writes.find((w) => w.dbKey === "alice:nonce").value, 1);
  vm.commit(res.writes);
  assert.deepEqual([native(vm, "alice"), native(vm, "bob")], [10_000 - 100, 0]);   // pays only gas

  const self = vm.transfer({ from: "alice", to: "alice", amount: "0n", nonce: 1 });   // cancel a stuck tx = send 0 to self
  assert.equal(self.status, "success");
  vm.commit(self.writes);
  assert.equal(native(vm, "alice"), 10_000 - 200);
  assert.equal(vm.checkTransaction({ from: "alice", nonce: -1 }).expectedNonce, 2);
  assert.equal(vm.transfer({ from: "alice", to: "bob", amount: -1, nonce: 2 }).error.message, "amount must be a non-negative integer");
});

test("transfer: charges gas and consumes a nonce like other txs", () => {
  const vm = setup({ requireNonce: true, chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 0 }, { alice: 10_000 });
  const res = vm.transfer({ from: "alice", to: "bob", amount: 500, nonce: 0 });

  assert.equal(res.gasUsed, GAS.call); // read / write cost 0 in this test
  assert.deepEqual(nativeWrites(res), { "alice:sended": 500, "bob:received": 500, "alice:consumed": 100, "miner:received": 100 });
  assert.equal(res.writes.find((w) => w.dbKey === "alice:nonce").value, 1);
  vm.commit(res.writes);
  assert.equal(vm.transfer({ from: "alice", to: "bob", amount: 1, nonce: 0 }).error.code, "INVALID_REQUEST");
});

test("transfer: balance must cover both the amount and the gas", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 1000 });
  assert.equal(vm.transfer({ from: "alice", to: "bob", amount: 1000 }).error.code, "OUT_OF_GAS");
  const res = vm.transfer({ from: "alice", to: "bob", amount: 900 });
  assert.equal(res.status, "success");
  assert.deepEqual(nativeWrites(res), { "alice:sended": 900, "bob:received": 900, "alice:consumed": 100, [`${VM.BURN_ADDRESS}:received`]: 100 });
});

test("transfer: works in a block, and the next tx sees the latest balance", () => {
  const vm = setup({}, { alice: 1000 });
  const block = vm.createBlock({ timestamp: T });
  block.transfer({ from: "alice", to: "bob", amount: 600 });
  const second = block.transfer({ from: "bob", to: "carol", amount: 500 });
  const failed = block.transfer({ from: "bob", to: "carol", amount: 500 });

  assert.equal(second.status, "success");
  assert.equal(failed.error.message, "insufficient native balance for 'bob'");
  block.commit();
  assert.deepEqual([native(vm, "alice"), native(vm, "bob"), native(vm, "carol")], [400, 100, 500]);
});

// ---------------------------------------------------------------------------
//  value at deploy
// ---------------------------------------------------------------------------

test("deploy with value: funds move to the program immediately, and initialization sees params.value", () => {
  const vm = setup({}, { alice: 1000 });
  const deployed = vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 400 });

  assert.equal(deployed.result.value, "400n");
  assert.deepEqual(nativeWrites(deployed), { "alice:sended": 400, "funded:received": 400 });
  assert.equal(deployed.writes.find((w) => w.dbKey === "pending:funded").value.value, "400n");
  vm.commit(deployed.writes);

  const initialized = vm.init({ programUuid: "funded" });
  assert.equal(initialized.result.value, "400n");
  vm.commit(initialized.writes);
  assert.equal(vm.db.readKeys(["funded:storage:seed"])[0], "400n");
  assert.equal(native(vm, "funded"), 400); // funds remain with the program
});

test("deploy with value: reject refunds the deployer", () => {
  const vm = setup({}, { alice: 1000 });
  vm.commit(vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 400 }).writes);
  assert.equal(native(vm, "alice"), 600);

  const rejected = vm.reject({ programUuid: "funded" });
  assert.equal(rejected.result.refund, "400n");
  assert.deepEqual(nativeWrites(rejected), { "funded:sended": 400, "alice:received": 1400 });
  vm.commit(rejected.writes);
  assert.equal(native(vm, "alice"), 1000);
  assert.equal(native(vm, "funded"), 0);
});

test("deploy with value: insufficient balance → nothing changes", () => {
  const vm = setup({}, { alice: 100 });
  const res = vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 500 });
  assert.equal(res.error.message, "insufficient native balance for 'alice'");
  assert.deepEqual(res.writes, []);
});

test("deploy: no value attached → params.value = 0 and refund = 0", () => {
  const vm = setup({}, { alice: 1000 });
  vm.commit(vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice") }).writes);
  vm.commit(vm.init({ programUuid: "funded" }).writes);
  assert.equal(vm.db.readKeys(["funded:storage:seed"])[0], "0n");
});

test("deploy with value: the program can spend those funds after init", () => {
  const vm = setup({}, { alice: 1000 });
  const block = vm.createBlock({ timestamp: T });
  block.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 400 });
  block.init({ programUuid: "funded" });
  const paid = block.call({ programUuid: "funded", functionName: "payBack", input: { amount: 150 }, context: user("alice") });

  assert.equal(paid.result, "150n");
  block.commit();
  assert.equal(native(vm, "funded"), 250);
  assert.equal(native(vm, "alice"), 750);
});

test("deploy with value + gas: value + gas must not exceed the balance", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 500 });
  assert.equal(vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 500 }).error.code, "OUT_OF_GAS");
  const res = vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 300 });
  assert.equal(res.status, "success");
  assert.deepEqual(nativeWrites(res), { "alice:sended": 300, "funded:received": 300, "alice:consumed": 100, [`${VM.BURN_ADDRESS}:received`]: 100 });
});

test("value end to end: deploy → init → call with value → transferNative back", () => {
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
//  3 cumulative counters (received / sended / consumed)
// ---------------------------------------------------------------------------

test("native: balance = received - sended - consumed, and every counter only increases", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 1000 });
  assert.deepEqual(balanceOf(vm, "alice"), { received: 1000, sended: 0, consumed: 0, balance: 1000 });

  vm.commit(vm.transfer({ from: "alice", to: "bob", amount: 200 }).writes);
  assert.deepEqual(balanceOf(vm, "alice"), { received: 1000, sended: 200, consumed: 100, balance: 700 });
  assert.deepEqual(balanceOf(vm, "bob"), { received: 200, sended: 0, consumed: 0, balance: 200 });

  vm.commit(vm.transfer({ from: "bob", to: "alice", amount: 50 }).writes);
  const alice = balanceOf(vm, "alice");
  const bob = balanceOf(vm, "bob");
  assert.deepEqual(alice, { received: 1050, sended: 200, consumed: 100, balance: 750 });
  assert.deepEqual(bob, { received: 200, sended: 50, consumed: 100, balance: 50 });
  for (const value of [alice.received, alice.sended, alice.consumed, bob.received, bob.sended, bob.consumed]) assert.ok(value >= 0);
});

test("native: an address that never had anything → every counter is 0", () => {
  const vm = setup();
  assert.deepEqual(balanceOf(vm, "nobody"), { received: 0, sended: 0, consumed: 0, balance: 0 });
});

test("native: programs have the same 3 counters as wallets", () => {
  const vm = setup({}, { alice: 1000 });
  vm.commit(vm.deploy({ programUuid: "funded", code: FUNDED, context: user("alice"), value: 400 }).writes);
  vm.commit(vm.init({ programUuid: "funded" }).writes);
  vm.commit(vm.call({ programUuid: "funded", functionName: "payBack", input: { amount: 150 }, context: user("alice") }).writes);

  assert.deepEqual(balanceOf(vm, "funded"), { received: 400, sended: 150, consumed: 0, balance: 250 });
  assert.deepEqual(balanceOf(vm, "alice"), { received: 1150, sended: 400, consumed: 0, balance: 750 }); // 1000 initial + 150 returned
});

test("native: system-wide total = funds put in - gas burned", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 50 }, { alice: 10_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner", burnPercent: 50 });
  block.transfer({ from: "alice", to: "bob", amount: 100 });
  block.transfer({ from: "bob", to: "carol", amount: 40 });
  block.commit();

  const accounts = ["alice", "bob", "carol", "miner"].map((address) => balanceOf(vm, address));
  const total = accounts.reduce((sum, account) => sum + account.balance, 0);
  const burned = accounts.reduce((sum, account) => sum + account.consumed, 0) - balanceOf(vm, "miner").received;
  assert.equal(total, 10_000 - burned);
});
