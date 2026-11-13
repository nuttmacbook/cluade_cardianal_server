import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { measure, WORKLOADS, MAX_TX_GAS } from "../dev/bench-gas.js";

/*
 * Phase 2.2: gas by CPU work (measured with npm run bench:gas, dev/bench-gas.js)
 * work that used to be "cheap but slow" (time per gas tens of times over baseline) now costs more:
 *   deeply nested JSON.stringify (was 275×: a 3M-gas tx took 47 s) · Map / Set with long string keys (68×) · switch / === / < on long strings (13–16×)
 *   default sort (14) · deep flat (12) · normalize (11) · JSON.parse
 * this test pins the gas formulas (exact values) + loose timings for the worst cases (a full 3M-gas tx must finish in a few seconds)
 */

const T = Date.parse("2026-01-01T00:00:00Z");
const A = "0x00000000000000000000000000000000000000a1";
const as = { sender: A, origin: A };

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { maxTxGas: MAX_TX_GAS, timeoutMs: 60_000 });
  const run = (body, setupCode = "") => {
    const code = `function program() {
      function initialization() {}
      function f(params) { ${setupCode}; ${body}; return 0n }
      function base(params) { ${setupCode}; return 0n }
      return { f, base }
    }`;
    const id = `p${Math.random().toString(36).slice(2, 8)}`;
    const deployed = vm.deploy({ programUuid: id, code, context: as }, { timestamp: T });
    assert.equal(deployed.status, "success", JSON.stringify(deployed.error));
    vm.commit(deployed.writes);
    vm.commit(vm.init({ programUuid: id }, { timestamp: T }).writes);
    const gas = (fn) => vm.call({ programUuid: id, functionName: fn, input: {}, context: as }, { timestamp: T }).gasUsed;
    return gas("f") - gas("base");
  };
  return { run };
}

test("long strings: === / < / == / switch cost by length · short strings keep the same gas", () => {
  const { run } = setup();
  const S = "const K = 'k'.repeat(32000); const J = 'k'.repeat(32000); let x";
  const SHORT = "const K = 'k'.repeat(32); const J = 'k'.repeat(32); let x";
  // 32,000 characters = 1,000 units · the first 32 are included in the operator → 999 extra
  const extra = 999;
  assert.equal(run("x = K === J", S) - run("x = K === J", SHORT), extra);
  assert.equal(run("x = K !== J", S) - run("x = K !== J", SHORT), extra);
  assert.equal(run("x = K < J", S) - run("x = K < J", SHORT), extra);
  assert.equal(run("x = K == J", S) - run("x = K == J", SHORT), extra);
  assert.equal(run("switch (K) { case J: x = 1; break; case 'a': x = 2 }", S) - run("switch (K) { case J: x = 1; break; case 'a': x = 2 }", SHORT), 2 * extra);
  // different lengths: === knows at once, no extra cost · one side a constant: not wrapped at all
  assert.equal(run("x = K === J + 'z'", S) - run("x = K === J + 'z'", SHORT), run("const t = J + 'z'", S) - run("const t = J + 'z'", SHORT));
  assert.equal(run("x = K === 'abc'", S), run("x = K === 'abc'", SHORT));
});

test("Map / Set: long string keys cost by length (get / has / delete × 1 · set / add × 2)", () => {
  const { run } = setup();
  const S = "const K = 'k'.repeat(32000); const m = new Map(); const s = new Set()";
  const SHORT = "const K = 'k'.repeat(32); const m = new Map(); const s = new Set()";
  const diff = (body) => run(body, S) - run(body, SHORT);
  assert.equal(diff("m.get(K)"), 999);
  assert.equal(diff("m.has(K)"), 999);
  assert.equal(diff("m.delete(K)"), 999);
  assert.equal(diff("m.set(K, 1n)"), 2 * 999);
  assert.equal(diff("s.add(K)"), 2 * 999);
  assert.equal(diff("Map.prototype.get.call(m, K)") - diff("const g = Map.prototype.get"), 999);   // every way of calling costs the same
  assert.equal(run("m.set(1n, 2n); m.get(1n)", S), run("m.set(1n, 2n); m.get(1n)", SHORT));   // non-string key: unchanged
});

test("deeply nested JSON.stringify costs by depth · flat costs every level walked · default sort costs per comparison · results match the engine", () => {
  const { run } = setup();
  const deep = (n) => run("JSON.stringify(o)", `let o = 1n; for (let i = 0; i < ${n}; i++) o = [o]`) ;
  // 2 + ⌊depth / 8⌋ per array · cost grows quadratically with depth
  assert.ok(deep(400) - deep(200) > 2 * (deep(200) - deep(100)));
  const flat = (n) => run("x.flat(Infinity)", `let x = [1n]; for (let i = 0; i < ${n}; i++) x = [x]`);
  assert.equal(flat(200) - flat(100), 100 * 9);   // 8 + 1 element per array walked

  // same as the engine: array replacer (order follows the list · duplicates / other types skipped) · function replacer · space · toJSON
  const vm = new VM.VirtualMachine(new MemoryDB(), {});
  const code = `function program() {
    function initialization() {}
    function f() {
      const o = { b: 1, a: { b: 2, c: 3, a: [1, { a: 1, b: 2 }] }, c: "x", d: { toJSON() { return { a: 9 } } } }
      return [
        JSON.stringify(o, ["a", "b", "a", 1, {}, new String("d")]),
        JSON.stringify(o, (k, v) => (k === "c" ? undefined : v), 2),
        JSON.stringify([new Number(1), new String("s"), Object(true)], ["x"]),
        JSON.stringify({ a: [1, [2, [3]]] }.a.flat(Infinity)),
        ["b", "a", "c"].sort().join(""),
      ]
    }
    return { f }
  }`;
  vm.commit(vm.deploy({ programUuid: "j", code, context: as }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "j" }, { timestamp: T }).writes);
  const result = vm.call({ programUuid: "j", functionName: "f", input: {}, context: as }, { timestamp: T }).result;
  const o = { b: 1, a: { b: 2, c: 3, a: [1, { a: 1, b: 2 }] }, c: "x", d: { toJSON() { return { a: 9 } } } };
  assert.deepEqual(result, [
    JSON.stringify(o, ["a", "b", "a", 1, {}, new String("d")]),
    JSON.stringify(o, (k, v) => (k === "c" ? undefined : v), 2),
    JSON.stringify([new Number(1), new String("s"), Object(true)], ["x"]),
    "[1,2,3]",
    "abc",
  ]);
});

test("former worst cases: a full 3M-gas tx finishes in a few seconds (was 12–47 seconds)", () => {
  for (const name of ["JSON.stringify deeply nested", "Map set long string", "Map long key", "switch string long", "string < long", "array sort default"]) {
    const row = measure(name, WORKLOADS[name], { repeat: 1 });
    assert.equal(row.code, "OUT_OF_GAS", name);
    assert.ok(row.ms < 4000, `${name}: ${row.ms.toFixed(0)} ms`);
  }
});
