import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY, num } from "./helpers.js";
import { WALLET, TREASURY, TOKEN } from "./programs.js";

/*
 * value attached to tx / runProgram, user-set gasLimit
 * and splitting gas fees with the block sealer (feeRecipient / burnPercent)
 */

const T = 1_700_000_000_000;
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

function setup(options = {}, balances = {}) {
  const { vm: base } = { vm: new VM.VirtualMachine(new MemoryDB(), { ...options, gas: { ...API_GAS_ONLY, ...options.gas } }) };
  const plain = new VM.VirtualMachine(base.db);
  const save = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    base.commit(res.writes);
    return res;
  };
  for (const [id, code] of [["wallet", WALLET], ["wallet2", WALLET], ["treasury", TREASURY]]) {
    save(plain.deploy({ programUuid: id, code, context: user("owner") }));
    save(plain.init({ programUuid: id }));
  }
  base.commit(Object.entries(balances).map(([address, value]) => ({ type: "put", dbKey: `${address}:native:received`, value })));
  return base;
}

const native = (vm, address) => num(vm.nativeBalanceOf(address).balance);
const nativeWrites = (res) => Object.fromEntries(res.writes.filter((w) => w.dbKey.includes(":native:")).map((w) => [w.dbKey.replace(":native:", ":"), num(w.value)]));

// ---------------------------------------------------------------------------
//  value attached to a tx
// ---------------------------------------------------------------------------

test("value: value attached to a call → moves from sender to the program, and the program sees params.value", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 250 });

  assert.equal(res.status, "success");
  assert.equal(res.result, "250n");
  assert.deepEqual(nativeWrites(res), { "alice:sended": 250, "wallet:received": 250 });
  vm.commit(res.writes);
  assert.equal(native(vm, "wallet"), 250);
  assert.equal(vm.db.readKeys(["wallet:storage:deposits:alice"])[0], "250n");
});

test("value: none attached → params.value = 0 and no native writes", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });
  assert.equal(res.result, "0n");
  assert.deepEqual(nativeWrites(res), {});
});

test("value: insufficient balance → nothing changes", () => {
  const vm = setup({}, { alice: 100 });
  const res = vm.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 500 });
  assert.equal(res.error.code, "PROGRAM_ERROR");
  assert.match(res.error.message, /insufficient native balance for 'alice'/);
  assert.deepEqual(res.writes, []);
});

test("value: must be a non-negative integer", () => {
  const vm = setup({}, { alice: 1000 });
  for (const value of [-1, 1.5, "1.5", "abc", "-5n", null]) {   // "10" / "10n" / 10n are accepted (amounts above 2^53 are sent as strings)
    assert.equal(vm.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value }).error.code, "INVALID_REQUEST");
  }
});

test("value: program refuses the funds (throw) → everything is refunded", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "rejectMoney", context: user("alice"), value: 10 });
  assert.equal(res.error.message, "does not accept funds");
  assert.deepEqual(res.writes, []);
  assert.equal(native(vm, "alice"), 1000);
});

// ---------------------------------------------------------------------------
//  value attached to runProgram
// ---------------------------------------------------------------------------

test("runProgram: passes value on to the next program", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "forward", input: { target: "wallet2", value: 60 }, context: user("alice"), value: 100 });

  assert.equal(res.status, "success");
  assert.equal(res.result, "60n");
  assert.deepEqual(nativeWrites(res), { "alice:sended": 100, "wallet:received": 100, "wallet:sended": 60, "wallet2:received": 60 });
  // the inner recipient sees origin alice, but the funds come from wallet's balance
  assert.deepEqual(res.calls.map((c) => `${c.programUuid}.${c.functionName}:${c.sender}`), ["wallet.forward:alice", "wallet2.deposit:wallet"]);
  vm.commit(res.writes);
  assert.equal(vm.db.readKeys(["wallet2:storage:deposits:alice"])[0], "60n");
});

test("runProgram: forwards everything received", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "forwardAll", input: { target: "wallet2" }, context: user("alice"), value: 100 });
  assert.deepEqual(nativeWrites(res), { "alice:sended": 100, "wallet:received": 100, "wallet:sended": 100, "wallet2:received": 100 });
});

test("runProgram: attaching more than the program has → a catchable error, and the funds revert", () => {
  const vm = setup({}, { alice: 1000 });
  const failed = vm.call({ programUuid: "wallet", functionName: "forwardTooMuch", input: { target: "wallet2" }, context: user("alice"), value: 50 });
  assert.equal(failed.error.code, "PROGRAM_ERROR");
  assert.match(failed.error.message, /insufficient native balance for 'wallet'/);

  const caught = vm.call({ programUuid: "wallet", functionName: "forwardSafe", input: { target: "wallet2", value: 999 }, context: user("alice"), value: 50 });
  assert.equal(caught.status, "success");
  assert.deepEqual(nativeWrites(caught), { "alice:sended": 50, "wallet:received": 50 }); // the value attached to the tx stays with wallet
  assert.equal(caught.writes.at(-1).dbKey, "wallet:storage:lastError");
});

test("runProgram: target throws → the attached value reverts too", () => {
  const vm = setup({}, { alice: 1000 });
  const res = vm.call({
    programUuid: "wallet", functionName: "forwardSafe",
    input: { target: "wallet2", value: 10 }, context: user("alice"), value: 50,
  });
  vm.commit(res.writes);
  assert.equal(native(vm, "wallet2"), 10); // normal case: forwarding works

  const vm2 = setup({}, { alice: 1000 });
  const rejected = vm2.call({ programUuid: "wallet", functionName: "forward", input: { target: "treasury", value: 10 }, context: user("alice"), value: 50 });
  assert.equal(rejected.status, "throw"); // treasury has no deposit function
  assert.deepEqual(rejected.writes, []);
});

// ---------------------------------------------------------------------------
//  user gasLimit
// ---------------------------------------------------------------------------

test("gasLimit: too low → OUT_OF_GAS, charging what was used (up to the limit)", () => {
  const vm = setup({ chargeGas: true }, { alice: 1_000_000 });
  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice"), gasLimit: 150 });

  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.deepEqual(nativeWrites(res), { "alice:consumed": 150, [`${VM.BURN_ADDRESS}:received`]: 150 }); // pays up to the set cap
});

test("gasLimit: exact → succeeds and pays the actual amount", () => {
  const vm = setup({ chargeGas: true }, { alice: 1_000_000 });
  const measured = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });
  assert.equal(measured.status, "success");

  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice"), gasLimit: measured.gasUsed });
  assert.equal(res.status, "success");
  assert.deepEqual(nativeWrites(res), { "alice:consumed": measured.gasUsed, [`${VM.BURN_ADDRESS}:received`]: measured.gasUsed });
});

test("gasLimit: must be a positive integer, and works even with chargeGas off", () => {
  const vm = setup({}, { alice: 1000 });
  for (const gasLimit of [0, -1, 1.5, "100"]) {
    assert.equal(vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice"), gasLimit }).error.code, "INVALID_REQUEST");
  }
  const limited = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice"), gasLimit: 1 });
  assert.equal(limited.error.code, "OUT_OF_GAS"); // limits work even when no gas is charged
  assert.deepEqual(limited.writes, []);
});

test("gasLimit: value + gas must not exceed the balance", () => {
  const vm = setup({ chargeGas: true }, { alice: 1000 });
  const res = vm.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 1000 });
  assert.equal(res.error.code, "OUT_OF_GAS"); // everything was attached, nothing left for gas
  assert.deepEqual(res.writes, []);
});

// ---------------------------------------------------------------------------
//  gas fee share for the block sealer
// ---------------------------------------------------------------------------

const GAS = { call: 100, read: 0, write: 0, stateKey: 0, byte: 0, price: 1 };

test("fee: split with the block sealer per burnPercent", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "0xMINER", burnPercent: 30 }, { alice: 10_000 });
  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });

  assert.equal(res.gasUsed, 100);
  assert.deepEqual(nativeWrites(res), { "alice:consumed": 100, "0xminer:received": 70, [`${VM.BURN_ADDRESS}:received`]: 30 }); // 30% burned → 0x000…000
});

test("fee: burn everything (default) → nobody gets a share", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 10_000 });
  assert.deepEqual(nativeWrites(vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") })), { "alice:consumed": 100, [`${VM.BURN_ADDRESS}:received`]: 100 });
});

test("fee: feeRecipient / burnPercent can be set per block and accumulate across txs", () => {
  const vm = setup({ chargeGas: true, gas: GAS, burnPercent: 100 }, { alice: 10_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner-a", burnPercent: 0 });
  block.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });
  block.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });

  assert.equal(block.feeRecipient, "miner-a");
  assert.deepEqual(block.writes().filter((w) => w.dbKey.includes(":native:")), [
    { type: "put", dbKey: "alice:native:consumed", value: "200n" },   // 100 + 100
    { type: "put", dbKey: "miner-a:native:received", value: "200n" },
  ]);
  block.commit();
  assert.equal(native(vm, "miner-a"), 200);
});

test("fee: failed txs also pay the block sealer's share", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 50 }, { alice: 10_000 });
  const res = vm.call({ programUuid: "wallet", functionName: "rejectMoney", context: user("alice"), value: 5 });
  assert.equal(res.status, "throw");
  assert.deepEqual(nativeWrites(res), { "alice:consumed": 100, "miner:received": 50, [`${VM.BURN_ADDRESS}:received`]: 50 }); // the attached value reverts, only gas remains
});

test("fee: the block sealer sends the tx itself → merged into a single write", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "alice", burnPercent: 40 }, { alice: 10_000 });
  const res = vm.call({ programUuid: "wallet", functionName: "seenValue", context: user("alice") });
  assert.deepEqual(nativeWrites(res), { "alice:consumed": 100, "alice:received": 10_060, [`${VM.BURN_ADDRESS}:received`]: 40 }); // pays gas, gets 60 back as its share, 40 burned
});

test("fee: burnPercent must be 0-100", () => {
  for (const burnPercent of [-1, 101, 1.5, "50"]) {
    assert.throws(() => new VM.VirtualMachine(new MemoryDB(), { burnPercent }), { code: "INVALID_REQUEST" });
  }
});

test("block: value + gas + share work together across the whole block", () => {
  const vm = setup({ chargeGas: true, requireNonce: true, gas: GAS, burnPercent: 50 }, { alice: 10_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 300, nonce: 0 });
  block.call({ programUuid: "wallet", functionName: "forward", input: { target: "wallet2", value: 100 }, context: user("alice"), value: 200, nonce: 1 });

  assert.deepEqual(block.results().map((r) => r.status), ["success", "success"]);
  const writes = Object.fromEntries(block.writes().map((w) => [w.dbKey, num(w.value)]));
  assert.equal(writes["alice:native:sended"], 500);     // value 300 + 200
  assert.equal(writes["alice:native:consumed"], 300);   // gas (1 + 2 calls)
  assert.equal(writes["wallet:native:received"], 500);
  assert.equal(writes["wallet:native:sended"], 100);
  assert.equal(writes["wallet2:native:received"], 100);
  assert.equal(writes["miner:native:received"], 150);   // 50% of 300
  assert.equal(writes["alice:nonce"], 2);

  block.commit();
  assert.equal(native(vm, "alice") + native(vm, "wallet") + native(vm, "wallet2") + native(vm, "miner"), 10_000 - 150); // the burned part
});
