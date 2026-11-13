import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { storageLayout, storageMap, storageGet, programFlags } from "../src/node/explorer-api.js";
import { TOKEN } from "./programs.js";

/* the explorer's "Data" tab groups storage by key depth: variable (1) / contract (2) / get storage (3+) */

const P = "0x00000000000000000000000000000000000000aa";
const ALICE = "0xAbCdEf0000000000000000000000000000000001";

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const put = (key, value) => [VM.storageKey(P, key.length === 1 ? key[0] : VM.map(...key)), value];
  const rows = [
    put(["owner"], ALICE.toLowerCase()),
    put(["price"], "100n"),
    put(["title"], "shop:test"),
    put(["items", 1], { name: "chair" }),
    put(["items", 2], { name: "lamp" }),
    put(["allow", ALICE, "0xbb"], "5n"),
    put(["mixed", "a"], 1),            // the same group has both 2-level and 3-level keys
    put(["mixed", "a", "b"], 2),
    put(["deeper", "x", "y", "z"], true),
  ];
  for (let i = 0; i < 120; i += 1) rows.push(put(["balances", `0x${String(i).padStart(40, "0")}`], `${i}n`));
  vm.db.load(Object.fromEntries(rows));
  return vm;
}

test("layout: splits 1-level keys (with values) / 2-level (counted) / 3+ levels (counted + max depth)", () => {
  const layout = storageLayout(setup(), P.toUpperCase().replace("0X", "0x"));
  assert.deepEqual(layout.variables.map((v) => [v.key, v.value]).sort(), [
    ["owner", ALICE.toLowerCase()], ["price", "100n"], ["title", "shop:test"],
  ].sort());
  assert.deepEqual(layout.maps.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "balances", count: 120 }, { name: "items", count: 2 }, { name: "mixed", count: 1 }]);
  assert.deepEqual(layout.deep.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "allow", count: 1, depth: 3 }, { name: "deeper", count: 1, depth: 4 }, { name: "mixed", count: 1, depth: 3 }]);
  assert.equal(layout.scanned, 129);
  assert.equal(layout.truncated, false);
});

test("layout: scanning past the key limit → truncated", () => {
  const layout = storageLayout(setup(), P, { scanLimit: 10 });
  assert.equal(layout.truncated, true);
  assert.equal(layout.scanned, 10);
});

test("map: shows only the group's level-2 keys, paged by cursor to the end without repeats", () => {
  const vm = setup();
  const seen = [];
  let next;
  let pages = 0;
  do {
    const page = storageMap(vm, P, "balances", { limit: 50, start: next });
    seen.push(...page.items.map((item) => item.key));
    next = page.next;
    pages += 1;
  } while (next);
  assert.equal(pages, 3);
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.equal(storageMap(vm, P, "balances", { limit: 1 }).items[0].value, "0n");

  // a group with both 2 and 3 levels → only the 2-level keys
  assert.deepEqual(storageMap(vm, P, "mixed"), { name: "mixed", items: [{ key: "a", value: 1 }], next: null });
  // limit exactly equals the count → no next page
  assert.equal(storageMap(vm, P, "items", { limit: 2 }).next, null);
  assert.equal(storageMap(vm, P, "items", { limit: 1 }).next !== null, true);
});

test("map: a cursor from another group is ignored", () => {
  const page = storageMap(setup(), P, "items", { start: "0xzz:storage:zzz" });
  assert.equal(page.items.length, 2);
});

test("get: reads single keys at any depth (upper-case addresses / numbers work)", () => {
  const vm = setup();
  assert.deepEqual(storageGet(vm, P, ["allow", ALICE, "0xBB"]), { key: ["allow", ALICE.toLowerCase(), "0xbb"], exists: true, value: "5n" });
  assert.deepEqual(storageGet(vm, P, ["deeper", "x", "y", "z"]).value, true);
  assert.deepEqual(storageGet(vm, P, ["items", "1"]).value, { name: "chair" });
  assert.deepEqual(storageGet(vm, P, ["price"]).value, "100n");
  assert.deepEqual(storageGet(vm, P, ["allow", ALICE, "0xcc"]), { key: ["allow", ALICE.toLowerCase(), "0xcc"], exists: false, value: null });
  assert.equal(storageGet(vm, P, []).status, 400);
  assert.equal(storageGet(vm, P, ["allow", "", "x"]).status, 400);
});

test("is-program: has code (initialized) or awaiting init = program · plain wallet = not a program", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const plain = new VM.VirtualMachine(vm.db);
  const context = { sender: "0xalice", origin: "0xalice" };
  vm.commit(plain.deploy({ programUuid: "0xp1", code: TOKEN, context, initInput: { supply: 1 } }).writes);
  vm.commit(plain.init({ programUuid: "0xp1" }).writes);
  vm.commit(plain.deploy({ programUuid: "0xp2", code: TOKEN, context, initInput: { supply: 1 } }).writes);
  assert.deepEqual(programFlags(vm, ["0xP1", "0xp2", "0xalice"]), { "0xp1": true, "0xp2": true, "0xalice": false });
});
