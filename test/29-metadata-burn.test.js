import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, num } from "./helpers.js";
import { COUNTER, PROFILE } from "./programs.js";

const nativeOf = (vm, address) => num(vm.nativeBalanceOf(address));

/* burned funds → 0x000…000  and per-address metadata */

const T = 1_700_000_000_000;
const user = (name) => ({ sender: name, origin: name });
const GAS = { call: 100, read: 0, write: 0, byte: 0, price: 1 };

function setup(options = {}, balances = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), options);
  vm.db.load(Object.fromEntries(Object.entries(balances).map(([address, value]) => [`${address}:native:received`, value])));
  return vm;
}

const save = (vm, res) => {
  assert.equal(res.status, "success", JSON.stringify(res.error));
  vm.commit(res.writes);
  return res;
};

// ---------------------------------------------------------------------------
//  burned funds
// ---------------------------------------------------------------------------

test("burn: burned gas goes to 0x000…000 rather than vanishing", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 10_000 });
  save(vm, vm.transfer({ from: "alice", to: "bob", amount: 100 }));

  assert.equal(VM.BURN_ADDRESS, `0x${"0".repeat(40)}`);
  assert.deepEqual(nativeOf(vm, VM.BURN_ADDRESS), { received: 100, sended: 0, consumed: 0, balance: 100 });
});

test("burn: the block sealer gets a share, the rest goes to 0x000…000", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 30 }, { alice: 10_000 });
  save(vm, vm.transfer({ from: "alice", to: "bob", amount: 100 }));

  assert.equal(nativeOf(vm, "miner").balance, 70);
  assert.equal(nativeOf(vm, VM.BURN_ADDRESS).balance, 30);
  assert.equal(nativeOf(vm, "alice").consumed, 100);
});

test("burn: the system-wide total stays constant (including the burn address)", () => {
  const vm = setup({ chargeGas: true, gas: GAS, feeRecipient: "miner", burnPercent: 50 }, { alice: 10_000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner", burnPercent: 50 });
  block.transfer({ from: "alice", to: "bob", amount: 300 });
  block.transfer({ from: "bob", to: "carol", amount: 50 });
  block.commit();

  const total = ["alice", "bob", "carol", "miner", VM.BURN_ADDRESS]
    .reduce((sum, address) => sum + nativeOf(vm, address).balance, 0);
  assert.equal(total, 10_000);
});

test("burn: funds at the burn address cannot be taken out (nobody holds the key of 0x000…000)", () => {
  const vm = setup({ chargeGas: true, gas: GAS }, { alice: 1000 });
  save(vm, vm.transfer({ from: "alice", to: "bob", amount: 10 }));
  assert.ok(nativeOf(vm, VM.BURN_ADDRESS).balance > 0);
  // transferring out is possible in theory, but needs a signature from 0x000…000, which nobody can produce
  assert.equal(vm.transfer({ from: VM.BURN_ADDRESS, to: "alice", amount: 999_999 }).error.code, "PROGRAM_ERROR");
});

// ---------------------------------------------------------------------------
//  program metadata
// ---------------------------------------------------------------------------

test("metadata: init fills in type / creator / createdAt automatically", () => {
  const vm = setup();
  save(vm, vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice") }, { timestamp: T }));
  save(vm, vm.init({ programUuid: "counter" }, { timestamp: T }));

  assert.deepEqual(vm.getMetadata("counter"), { type: "program", creator: "alice", createdAt: T });
});

test("metadata: deploy can attach metadata, which is saved at init", () => {
  const vm = setup();
  const metadata = { namespace: "MyCounter", description: "A counter", tags: ["demo", "counter"], url: "https://example.com" };
  save(vm, vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), metadata }, { timestamp: T }));
  save(vm, vm.init({ programUuid: "counter" }, { timestamp: T }));

  assert.deepEqual(vm.getMetadata("counter"), {
    namespace: "mycounter", // the name is lowercased
    description: "A counter",
    tags: ["demo", "counter"],
    url: "https://example.com",
    type: "program",
    creator: "alice",
    createdAt: T,
  });
  assert.equal(vm.resolveNamespace("MyCounter"), "counter"); // lookup by name works
});

test("metadata: deploy attaching system fields → rejected", () => {
  const vm = setup();
  for (const field of ["type", "creator", "createdAt"]) {
    const res = vm.deploy({ programUuid: "p", code: COUNTER, context: user("alice"), metadata: { [field]: "x" } });
    assert.equal(res.error.code, "FORBIDDEN");
    assert.match(res.error.message, /เป็นฟิลด์ของระบบ/);
  }
  assert.equal(vm.deploy({ programUuid: "p", code: COUNTER, context: user("alice"), metadata: { "bad name!": 1 } }).error.code, "INVALID_REQUEST");
  assert.equal(vm.deploy({ programUuid: "p", code: COUNTER, context: user("alice"), metadata: "x" }).error.code, "INVALID_REQUEST");
});

test("metadata: a program can set its own metadata with setMetadata()", () => {
  const vm = setup();
  save(vm, vm.deploy({ programUuid: "profile", code: PROFILE, context: user("alice"), initInput: { name: "Shop" } }, { timestamp: T }));
  save(vm, vm.init({ programUuid: "profile" }, { timestamp: T }));
  assert.equal(vm.getMetadata("profile").namespace, "shop");
  assert.equal(vm.getMetadata("profile").description, "โปรแกรมตัวอย่าง");

  save(vm, vm.call({ programUuid: "profile", functionName: "setField", input: { field: "icon", value: "🛒" }, context: user("bob") }));
  assert.equal(vm.getMetadata("profile").icon, "🛒");

  save(vm, vm.call({ programUuid: "profile", functionName: "clearField", input: { field: "icon" }, context: user("bob") }));
  assert.equal(vm.getMetadata("profile").icon, undefined);
});

test("metadata: a program cannot change system fields", () => {
  const vm = setup();
  save(vm, vm.deploy({ programUuid: "profile", code: PROFILE, context: user("alice"), initInput: { name: "shop2" } }));
  save(vm, vm.init({ programUuid: "profile" }));

  const res = vm.call({ programUuid: "profile", functionName: "tryReserved", context: user("bob") });
  assert.equal(res.error.code, "FORBIDDEN");
  assert.equal(vm.getMetadata("profile").creator, "alice");
});

// ---------------------------------------------------------------------------
//  wallet metadata (vm.setMetadata)
// ---------------------------------------------------------------------------

test("setMetadata: a user sets metadata for their own address", () => {
  const vm = setup({ requireNonce: true });
  const res = save(vm, vm.setMetadata({
    metadata: { namespace: "Alice", description: "first user", icon: "👩" },
    context: user("0xA1"), nonce: 0,
  }, { timestamp: T }));

  assert.deepEqual(res.result, { address: "0xa1", metadata: ["namespace", "description", "icon"] });
  assert.deepEqual(vm.getMetadata("0xA1"), { namespace: "alice", description: "first user", icon: "👩" });
  assert.equal(vm.resolveNamespace("alice"), "0xa1");
  assert.equal(vm.db.readKeys(["0xa1:nonce"])[0], 1); // consumes a nonce like other txs
});

test("setMetadata: only your own can be set (address comes from sender)", () => {
  const vm = setup();
  save(vm, vm.setMetadata({ metadata: { namespace: "bob" }, context: { sender: "bob", origin: "carol" } }));
  assert.equal(vm.resolveNamespace("bob"), "bob"); // uses sender, not origin
  assert.deepEqual(vm.getMetadata("carol"), {});
});

test("namespace: must be unique, and renaming releases the old name", () => {
  const vm = setup();
  save(vm, vm.setMetadata({ metadata: { namespace: "shop" }, context: user("alice") }));

  const taken = vm.setMetadata({ metadata: { namespace: "SHOP" }, context: user("bob") });
  assert.equal(taken.error.code, "FORBIDDEN");
  assert.match(taken.error.message, /ถูกใช้โดย alice/);

  save(vm, vm.setMetadata({ metadata: { namespace: "market" }, context: user("alice") })); // rename
  assert.equal(vm.resolveNamespace("shop"), null);   // old name released
  assert.equal(vm.resolveNamespace("market"), "alice");
  save(vm, vm.setMetadata({ metadata: { namespace: "shop" }, context: user("bob") })); // bob can now use the old name
  assert.equal(vm.resolveNamespace("shop"), "bob");
});

test("namespace: set to null to drop the name", () => {
  const vm = setup();
  save(vm, vm.setMetadata({ metadata: { namespace: "alice" }, context: user("alice") }));
  save(vm, vm.setMetadata({ metadata: { namespace: null }, context: user("alice") }));
  assert.equal(vm.resolveNamespace("alice"), null);
  assert.deepEqual(vm.getMetadata("alice"), {});
});

test("namespace: invalid format", () => {
  const vm = setup();
  for (const namespace of ["", "has:colon", "x".repeat(65), 123]) {
    assert.equal(vm.setMetadata({ metadata: { namespace }, context: user("alice") }).error.code, "INVALID_REQUEST");
  }
});

test("metadata: used in a block and present in writes / receipt", () => {
  const vm = setup({ requireNonce: true, recordTransactions: true });
  const block = vm.createBlock({ timestamp: T, number: 1 });
  block.setMetadata({ metadata: { namespace: "alice" }, context: user("alice"), nonce: 0 });

  assert.deepEqual(block.writes().map((w) => `${w.type} ${w.dbKey}`).slice(0, 2), [
    "put alice:metadata:namespace",
    "put namespace:alice",
  ]);
  const receipt = block.receipt({ number: 1 });
  assert.equal(receipt.transactions[0].action, "metadata");
  assert.match(receipt.transactions[0].hash, /^0x[0-9a-f]{64}$/);
  block.commit();
  assert.equal(vm.resolveNamespace("alice"), "alice");
});

test("metadata: decodeDbKey parses metadata and namespace keys", () => {
  assert.deepEqual(VM.decodeDbKey("0xabc:metadata:namespace"), { kind: "metadata", address: "0xabc", field: "namespace" });
  assert.deepEqual(VM.decodeDbKey("namespace:alice"), { kind: "namespace", name: "alice" });
});
