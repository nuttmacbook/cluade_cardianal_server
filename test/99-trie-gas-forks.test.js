import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY, user } from "./helpers.js";
import { resolveSettings } from "../src/node/genesis.js";

/*
 * trie gas (stateKey) + forks by block height
 *   stateKey: charged per state key a tx first writes / deletes (the cost of updating the Merkle trie + history at block close) → a block packed with new keys fits fewer keys
 *   fork: genesis.json "forks" = { name: block } · rules live in code (FORKS) · earlier blocks use the old rules → replay gives the same result · not in the genesis hash
 */

const T = 1_700_000_000_000;
const FILL = `function program() {
  function initialization() {}
  function fill(params) {
    for (let i = 0n; i < params.input.n; i++) writeDB(map("k", params.input.tag, i), 1n)
  }
  function twice() {
    writeDB("a", 1n)
    writeDB("a", 2n)
    deleteDB("a")
  }
  return { fill, twice }
}`;
const GAS = { ...API_GAS_ONLY, call: 0, read: 0, write: 10, byte: 0, stateKey: 100, price: 1 };

function deployed(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, recordHistory: true, ...options });
  const block = vm.createBlock({ timestamp: T });
  block.deploy({ programUuid: "fill", code: FILL, context: user("alice") });
  block.init({ programUuid: "fill" });
  block.commit();
  return vm;
}

test("stateKey: charged once per key per tx · rewriting / deleting the same key is not charged again", () => {
  const vm = deployed({ gas: GAS });
  const three = vm.call({ programUuid: "fill", functionName: "fill", input: { n: 3, tag: "x" }, context: user("alice") });
  assert.equal(three.status, "success");
  assert.equal(three.gasUsed, 3 * (GAS.write + GAS.stateKey));
  const same = vm.call({ programUuid: "fill", functionName: "twice", context: user("alice") });
  assert.equal(same.gasUsed, 3 * GAS.write + GAS.stateKey);   // 2 writes + 1 delete on one key
  assert.equal(VM.DEFAULT_GAS.stateKey, 1000);
});

test("stateKey: a block packed with new keys up to its gas has keys ≤ gas / (write + stateKey)", () => {
  const maxBlockGas = 200_000;
  const vm = deployed({ maxBlockGas, maxTxGas: maxBlockGas });
  const block = vm.createBlock({ timestamp: T + 1000 });
  let keys = 0;
  for (let i = 0; ; i += 1) {
    const result = block.call({ programUuid: "fill", functionName: "fill", input: { n: 20, tag: `t${i}` }, context: user("alice") });
    if (result.status !== "success") break;
    keys += 20;
  }
  const { write, stateKey } = VM.DEFAULT_GAS;
  assert.ok(keys > 0);
  assert.ok(keys <= maxBlockGas / (write + stateKey), `${keys} key`);
});

const RULES = { cheapWrite: { description: "cheaper writeDB · pricier stateKey", gas: { write: 5, stateKey: 300 } } };

test("fork: new rules from the given block · earlier blocks keep the old ones · forkActive / forkSchedule / gasAt", () => {
  const vm = deployed({ gas: GAS, forks: { cheapWrite: 3 }, forkRules: RULES });
  assert.deepEqual(vm.forkSchedule(), [{ name: "cheapWrite", block: 3, active: false, description: RULES.cheapWrite.description }]);
  assert.equal(vm.forkActive("cheapWrite"), false);   // next block = 2
  assert.equal(vm.gasAt(2).write, 10);
  assert.equal(vm.gasAt(3).write, 5);
  assert.equal(vm.gasAt(3).stateKey, 300);
  assert.equal(vm.gasAt(3), vm.gasAt(9));   // the same cached table

  const used = [];
  for (const number of [2, 3, 4]) {
    const block = vm.createBlock({ timestamp: T + number * 1000 });
    used.push(block.call({ programUuid: "fill", functionName: "fill", input: { n: 2, tag: `b${number}` }, context: user("alice") }).gasUsed);
    block.commit();
  }
  assert.deepEqual(used, [2 * 110, 2 * 305, 2 * 305]);
  assert.equal(vm.forkActive("cheapWrite"), true);
  assert.equal(vm.forkActive("cheapWrite", 2), false);
  assert.equal(vm.forkActive("other"), false);

  // replay gives the same results before and after the fork (each block uses its own rules)
  for (const number of [2, 3, 4]) assert.equal(vm.replayBlock(number).hash, vm.getBlock(number).hash);
  // a node without the fork → block 3 mismatches (chain split detected) · block 2 still matches
  const old = new VM.VirtualMachine(vm.db, { gas: GAS, recordBlocks: true, recordHistory: true });
  assert.equal(old.replayBlock(2).hash, vm.getBlock(2).hash);
  assert.throws(() => old.replayBlock(3), /hash ไม่ตรง/);
});

test("fork: a name unknown to the code / bad block / changing a nonexistent gas value = refuses to start", () => {
  const make = (options) => () => new VM.VirtualMachine(new MemoryDB(), options);
  assert.throws(make({ forks: { future: 10 } }), /ไม่รู้จัก fork 'future'/);
  assert.throws(make({ forks: { cheapWrite: -1 }, forkRules: RULES }), /block ต้องเป็นจำนวนเต็ม/);
  assert.throws(make({ forks: { cheapWrite: 1.5 }, forkRules: RULES }), /block ต้องเป็นจำนวนเต็ม/);
  assert.throws(make({ forks: { bad: 1 }, forkRules: { bad: { gas: { price: 2 } } } }), /เปลี่ยนค่าแก๊ส 'price' ไม่ได้/);
  assert.throws(make({ forks: { bad: 1 }, forkRules: { bad: { gas: { nope: 2 } } } }), /เปลี่ยนค่าแก๊ส 'nope' ไม่ได้/);
  assert.throws(make({ forks: [] }), /ต้องเป็น \{ ชื่อ: block \}/);
  assert.deepEqual(new VM.VirtualMachine(new MemoryDB()).forkSchedule(), []);
  assert.deepEqual(Object.keys(VM.FORKS), ["bluewolf"]);   // forks defined in code (genesis.json enables it from block 0)
});

test("fork: the genesis hash excludes forks (the schedule can be extended later) · resolveSettings reads forks from genesis", () => {
  const genesis = { chainId: 1, balances: { alice: "10n" } };
  const vm = new VM.VirtualMachine(new MemoryDB());
  const { hash } = vm.applyGenesis(genesis);
  assert.equal(vm.checkGenesis({ ...genesis, forks: { cheapWrite: 100 } }), hash);
  assert.equal(vm.applyGenesis({ ...genesis, forks: { cheapWrite: 100 } }).applied, false);
  assert.throws(() => vm.checkGenesis({ ...genesis, chainId: 2 }), /genesis ไม่ตรงกัน/);

  assert.deepEqual(resolveSettings({ ...genesis, forks: { cheapWrite: 100 } }, {}).settings.forks, { cheapWrite: 100 });
  assert.deepEqual(resolveSettings(genesis, {}).settings.forks, {});
  assert.match(resolveSettings({ forks: { x: "10" } }, {}).errors.join(), /genesis forks/);
  assert.match(resolveSettings({ forks: [1] }, {}).errors.join(), /genesis forks/);
});
