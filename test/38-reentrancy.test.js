import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { VULNERABLE_VAULT, ATTACKER } from "./programs.js";

/*
 * reentrancy: a program calls out and gets called back in while it is still running
 * The VM allows it (like the EVM); guarding against it is the program author's job
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });

function setup({ rounds = 2 } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  vm.db.load({ "alice:native:received": "1000n", "victim:native:received": "0n" });

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "vault", code: VULNERABLE_VAULT, context: user("owner") });
  block.init({ programUuid: "vault" });
  block.deploy({ programUuid: "attacker", code: ATTACKER, context: user("alice"), initInput: { vault: "vault", rounds } });
  block.init({ programUuid: "attacker" });
  block.commit();

  // the victim deposits 500 in the vault
  vm.commit(vm.transfer({ from: "alice", to: "victim", amount: 500 }, { timestamp: T + 500 }).writes);
  vm.commit(vm.call({ programUuid: "vault", functionName: "deposit", context: user("victim"), value: 500 }, { timestamp: T + 600 }).writes);
  return vm;
}

const attack = (vm, method, value = 100) =>
  vm.call({ programUuid: "attacker", functionName: "attack", input: { method }, context: user("alice"), value }, { timestamp: T + 1000 });

// ---------------------------------------------------------------------------

test("⚠️ withdrawUnsafe: repeated withdrawals drain other users' funds", () => {
  const vm = setup({ rounds: 2 });
  const res = attack(vm, "withdrawUnsafe");

  assert.equal(res.status, "success");
  vm.commit(res.writes);
  assert.equal(vm.nativeBalanceOf("attacker").balance, 300n);   // deposited 100 but withdrew 300
  assert.equal(vm.nativeBalanceOf("vault").balance, 300n);      // the victim lost 200
  assert.equal(vm.db.readKeys(["vault:storage:balances:attacker"])[0], "0n");
});

test("withdrawSafe: update the balance before calling out (checks-effects-interactions) → re-withdrawal gets 0", () => {
  const vm = setup({ rounds: 3 });
  const res = attack(vm, "withdrawSafe");

  assert.equal(res.status, "success");
  vm.commit(res.writes);
  assert.equal(vm.nativeBalanceOf("attacker").balance, 100n);   // gets back only what was deposited
  assert.equal(vm.nativeBalanceOf("vault").balance, 500n);      // the victim's funds are intact
});

test("withdrawGuarded: lock with a flag → reentrant call is rejected", () => {
  const vm = setup({ rounds: 2 });
  const res = attack(vm, "withdrawGuarded");

  assert.equal(res.status, "success");
  vm.commit(res.writes);
  assert.equal(vm.db.readKeys(["attacker:storage:lastError"])[0], "already running");  // reentrant call fails
  assert.equal(vm.nativeBalanceOf("attacker").balance, 100n);   // gets back only what was deposited
  assert.equal(vm.nativeBalanceOf("vault").balance, 500n);      // the victim's funds are intact
  assert.equal(vm.db.readKeys(["vault:storage:locked"])[0], undefined); // lock released
});

test("a reentrant call sees data already written by the outer level", () => {
  const vm = setup({ rounds: 1 });
  const res = attack(vm, "withdrawSafe");
  const depths = res.calls.map((call) => `${call.depth} ${call.programUuid}.${call.functionName}`);

  assert.deepEqual(depths, [
    "0 attacker.attack",
    "1 vault.deposit",
    "1 vault.withdrawSafe",
    "2 attacker.receive",
    "3 vault.withdrawSafe",     // called back in while level 1 is still running
  ]);
  assert.equal(res.calls.at(-1).status, "throw");   // the reentrant level already sees a balance of 0
  assert.equal(res.status, "success");
});

test("reentrancy depth is capped by maxCallDepth", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { maxCallDepth: 4, recordBlocks: true });
  vm.db.load({ "alice:native:received": "1000n" });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "vault", code: VULNERABLE_VAULT, context: user("owner") });
  block.init({ programUuid: "vault" });
  block.deploy({ programUuid: "attacker", code: ATTACKER, context: user("alice"), initInput: { vault: "vault", rounds: 99 } });
  block.init({ programUuid: "attacker" });
  block.commit();
  vm.commit(vm.call({ programUuid: "vault", functionName: "deposit", context: user("alice"), value: 100 }, { timestamp: T + 100 }).writes);

  const res = vm.call({ programUuid: "attacker", functionName: "attack", input: { method: "withdrawUnsafe" }, context: user("alice"), value: 100 }, { timestamp: T + 200 });
  assert.equal(Math.max(...res.calls.map((call) => call.depth)), 4);   // no deeper than maxCallDepth
  vm.commit(res.writes);
  assert.match(vm.db.readKeys(["attacker:storage:lastError"])[0], /calls cannot exceed 4 levels/);  // the extra level is rejected
});

test("the lock does not carry over to the next tx", () => {
  const vm = setup({ rounds: 2 });
  vm.commit(attack(vm, "withdrawGuarded").writes);
  assert.equal(vm.db.readKeys(["vault:storage:locked"])[0], undefined);

  const normal = vm.call({ programUuid: "vault", functionName: "balanceOf", input: { who: "victim" }, context: user("bob") }, { timestamp: T + 2000 });
  assert.equal(normal.result, "500n");
});
