/**
 * Measures CPU time per gas for each kind of work → finds work that is "cheap but slow" (could stuff blocks at low cost)
 *
 *   npm run bench:gas                 # every workload · reports ns/gas sorted most expensive first
 *   npm run bench:gas -- --json       # results as JSON
 *   npm run bench:gas -- --only sort  # only workloads whose name contains this word
 *
 * Each workload is a program that repeats one thing until maxTxGas (3M · server default = MAX_BLOCK_GAS 5M) runs out or the loop ends
 * ns/gas = time (minus empty-tx overhead) ÷ gas used · baseline = a plain number loop
 * Good result = every workload is close to baseline · over LIMIT times = priced too low (guarded by test 88)
 */
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js";

export const MAX_TX_GAS = 3_000_000;
/** How many times slower than baseline counts as priced too low */
export const LIMIT = 8;

const A = "0x00000000000000000000000000000000000000a1";
const as = { sender: A, origin: A };

// setup = code before the loop · body = work per iteration (variables i, s, a, o, m, big are ready to use)
export const WORKLOADS = {
  "baseline: number loop": { body: "x = x + 1" },
  "property read/write": { body: "o.a = o.a + 1" },
  "function call": { setup: "const f = (v) => v + 1", body: "x = f(x)" },
  "closure create": { body: "const g = () => i; x = x + 1" },
  "object literal": { body: "const t = { a: 1, b: 2, c: 3 }" },
  "array push/pop": { body: "a.push(1); a.pop()" },
  "try/catch throw": { body: "try { throw 1 } catch (e) { x = x + 1 }" },
  "string + (short)": { body: "const t = 'ab' + 'cd'" },
  "string concat long": { setup: "let t = ''", body: "t = t + 'x'; if (t.length > 4000) t = ''" },
  "template literal": { body: "const t = `${x}-${x}`" },
  "string indexOf long": { setup: "const L = 'a'.repeat(20000) + 'b'", body: "x = x + L.indexOf('b')" },
  "string includes long": { setup: "const L = 'a'.repeat(20000) + 'b'", body: "x = x + (L.includes('ab') ? 1 : 0)" },
  "string lastIndexOf long": { setup: "const L = 'b' + 'a'.repeat(20000)", body: "x = x + L.lastIndexOf('b')" },
  "string startsWith/endsWith": { setup: "const L = 'a'.repeat(20000)", body: "x = x + (L.endsWith('a') ? 1 : 0)" },
  "string compare long": { setup: "const L = 'a'.repeat(20000); const M = 'a'.repeat(20000)", body: "x = x + (L === M ? 1 : 0)" },
  "string < long": { setup: "const L = 'a'.repeat(20000); const M = 'a'.repeat(20000) + 'b'", body: "x = x + (L < M ? 1 : 0)" },
  "string split": { setup: "const L = 'a,'.repeat(500)", body: "x = x + L.split(',').length" },
  "string replaceAll": { setup: "const L = 'ab'.repeat(500)", body: "x = x + L.replaceAll('a', 'c').length" },
  "string slice": { setup: "const L = 'a'.repeat(20000)", body: "x = x + L.slice(1).length" },
  "string padStart": { body: "x = x + 'a'.padStart(500).length" },
  "string repeat": { body: "x = x + 'ab'.repeat(500).length" },
  "string toUpperCase": { setup: "const L = 'a'.repeat(2000)", body: "x = x + L.toUpperCase().length" },
  "string localeCompare": { setup: "const L = 'a'.repeat(2000); const M = 'a'.repeat(2000)", body: "x = x + L.localeCompare(M)" },
  "string normalize": { setup: "const L = 'é'.repeat(2000)", body: "x = x + L.normalize('NFD').length" },
  "string charCodeAt": { setup: "const L = 'abc'", body: "x = x + L.charCodeAt(1)" },
  "string trim": { setup: "const L = ' '.repeat(5000) + 'a' + ' '.repeat(5000)", body: "x = x + L.trim().length" },
  "array indexOf long": { setup: "const L = new Array(5000).fill(0); L.push(1)", body: "x = x + L.indexOf(1)" },
  "array includes long": { setup: "const L = new Array(5000).fill(0)", body: "x = x + (L.includes(1) ? 1 : 0)" },
  "array lastIndexOf long": { setup: "const L = [1].concat(new Array(5000).fill(0))", body: "x = x + L.lastIndexOf(1)" },
  "array join": { setup: "const L = new Array(1000).fill('ab')", body: "x = x + L.join(',').length" },
  "array sort numeric": { setup: "const L = Array.from({ length: 500 }, (_, k) => (k * 7919) % 500)", body: "x = x + L.slice().sort((p, q) => p - q)[0]" },
  "array sort default": { setup: "const L = Array.from({ length: 500 }, (_, k) => String((k * 7919) % 500))", body: "x = x + L.slice().sort().length" },
  "array reverse": { setup: "const L = new Array(2000).fill(1)", body: "x = x + L.reverse().length" },
  "array map/filter/reduce": { setup: "const L = new Array(200).fill(1)", body: "x = x + L.map((v) => v + 1).filter((v) => v > 1).reduce((p, q) => p + q, 0)" },
  "array find long": { setup: "const L = new Array(3000).fill(0)", body: "x = x + (L.find((v) => v === 1) ?? 0)" },
  "array concat": { setup: "const L = new Array(1000).fill(0)", body: "x = x + L.concat(L).length" },
  "array splice": { setup: "const L = new Array(3000).fill(0)", body: "L.splice(0, 1); L.push(0)" },
  "array shift/unshift": { setup: "const L = new Array(3000).fill(0)", body: "L.shift(); L.push(0)" },
  "array fill": { setup: "const L = new Array(3000)", body: "x = x + L.fill(1).length" },
  "array flat deep": { setup: "let L = [1]; for (let k = 0; k < 200; k++) L = [L]", body: "x = x + L.flat(Infinity).length" },
  "spread array": { setup: "const L = new Array(200).fill(1)", body: "x = x + [...L].length" },
  "spread object": { setup: "const O = Object.fromEntries(Array.from({ length: 100 }, (_, k) => ['k' + k, k]))", body: "x = x + Object.keys({ ...O }).length" },
  "Object.keys large": { setup: "const O = Object.fromEntries(Array.from({ length: 1000 }, (_, k) => ['k' + k, k]))", body: "x = x + Object.keys(O).length" },
  "Object.entries large": { setup: "const O = Object.fromEntries(Array.from({ length: 1000 }, (_, k) => ['k' + k, k]))", body: "x = x + Object.entries(O).length" },
  "for...in large": { setup: "const O = Object.fromEntries(Array.from({ length: 1000 }, (_, k) => ['k' + k, k]))", body: "for (const k in O) x = x + 1" },
  "in operator": { body: "x = x + ('a' in o ? 1 : 0)" },
  "delete property": { body: "o.z = 1; delete o.z" },
  "JSON.stringify": { setup: "const O = { a: [1, 2, 3], b: 'x'.repeat(100), c: { d: 1 } }", body: "x = x + JSON.stringify(O).length" },
  "JSON.parse": { setup: "const T = JSON.stringify(Array.from({ length: 200 }, (_, k) => ({ k })))", body: "x = x + JSON.parse(T).length" },
  "JSON.stringify deeply nested": { setup: "let O = 1; for (let k = 0; k < 300; k++) O = [O]", body: "x = x + JSON.stringify(O).length" },
  "Map set/get": { body: "m.set(i, i); x = x + m.get(i); m.delete(i)" },
  "Set add/has": { body: "set.add(i); x = x + (set.has(i) ? 1 : 0); set.delete(i)" },
  "Map large iterate": { setup: "const M = new Map(Array.from({ length: 1000 }, (_, k) => [k, k]))", body: "for (const [k] of M) x = x + 1" },
  "Math ops": { body: "x = x + Math.floor(Math.sqrt(i) * Math.sin(i))" },
  "Math.max(...long)": { setup: "const L = new Array(3000).fill(1)", body: "x = x + Math.max(...L)" },
  "Number toString": { body: "x = x + String(i * 1.5).length" },
  "Number toFixed large": { body: "x = x + (1e21).toFixed(100).length" },
  "parseInt/parseFloat": { setup: "const L = '1'.repeat(300)", body: "x = x + (parseFloat(L) > 0 ? 1 : 0)" },
  "Date": { body: "x = x + new Date(i).getUTCFullYear()" },
  "BigInt small": { setup: "let b = 1n", body: "b = b + 3n * 7n" },
  "BigInt 4096 bit": { setup: "const B = 2n ** 4096n - 1n", body: "big = B * B % (B - 2n)" },
  "BigInt toString 8192 bit": { setup: "const B = 2n ** 8000n", body: "x = x + B.toString().length" },
  "recursion": { setup: "const r = (n) => (n === 0 ? 0 : r(n - 1) + 1)", body: "x = x + r(50)" },
  "class + new": { setup: "class P { constructor(v) { this.v = v } get w() { return this.v } }", body: "x = x + new P(i).w" },
  "generator": { setup: "function* g() { yield 1; yield 2 }", body: "for (const v of g()) x = x + v" },
  "getter/setter": { setup: "const G = { _v: 0, get v() { return this._v }, set v(n) { this._v = n } }", body: "G.v = G.v + 1" },
  "Array.from length": { body: "x = x + Array.from({ length: 300 }).length" },
  "typed array": { setup: "const U = new Uint8Array(3000)", body: "x = x + U.slice(1).length" },
  "readDB": { body: "readDB('k' + (i % 10))", api: true },
  "writeDB": { body: "writeDB('k' + (i % 10), 1n)", api: true },
  "keccak256": { body: "keccak256('abc')", api: true },
  "keccak256 long": { setup: "const L = 'a'.repeat(5000)", body: "keccak256(L)", api: true },
  "emit": { body: "emit('E', { a: 1n })", api: true },
  "map()": { body: "map('a', 'b', 'c')", api: true },
  "long key o[k]": { setup: "const K = 'k'.repeat(20000); const O = { [K]: 1 }", body: "x = x + O[K]" },
  "long key new": { setup: "const K = 'k'.repeat(20000)", body: "const t = {}; t[K + i] = 1" },
  "Map long key": { setup: "const K = 'k'.repeat(20000); const M = new Map([[K, 1]])", body: "x = x + M.get(K)" },
  "Set long add": { setup: "const K = 'k'.repeat(20000)", body: "set.add(K + i); set.clear()" },
  "switch string long": { setup: "const K = 'k'.repeat(20000); const J = 'k'.repeat(20000)", body: "switch (K) { case J: x = x + 1 }" },
  "String(object)": { setup: "const O = { toString() { return 'abc' } }", body: "x = x + String(O).length" },
  "array includes long string": { setup: "const K = 'k'.repeat(5000); const L = new Array(100).fill('k'.repeat(5000))", body: "x = x + (L.includes(K + '') ? 1 : 0)" },
  "Object.assign large": { setup: "const O = Object.fromEntries(Array.from({ length: 500 }, (_, k) => ['k' + k, k]))", body: "x = x + Object.keys(Object.assign({}, O)).length" },
  "array indexOf similar strings": { setup: "const L = Array.from({ length: 50 }, (_, k) => 'k'.repeat(5000) + k)", body: "x = x + L.indexOf('k'.repeat(5000) + 'z')" },
  "Map set long string": { setup: "const K = 'k'.repeat(20000)", body: "m.set(K, 1); m.delete(K)" },
  "object long key new each iteration": { setup: "const K = 'k'.repeat(20000)", body: "o[K + (i % 2)] = 1" },
  "structured nested object": { setup: "let O = {}; for (let k = 0; k < 200; k++) O = { o: O }", body: "let p = O; while (p.o) p = p.o" },
};

function program({ setup = "", body }) {
  return `function program() {
  function initialization() {}
  function run(params) {
    let x = 0
    const o = { a: 0 }
    const a = []
    const m = new Map()
    const set = new Set()
    let big = 0n
    ${setup}
    const n = Number(params.input.n)
    for (let i = 0; i < n; i++) { ${body} }
    return BigInt(Math.floor(Number(x) || 0) % 1000)
  }
  function empty() { return 0n }
  return { run, empty }
}`;
}

/** Measures 1 workload → { name, gas, ms, nsPerGas, iterations, status } */
export function measure(name, workload, { iterations = 1_000_000, repeat = 3 } = {}) {
  const vm = new VirtualMachine(new MemoryDB(), { maxTxGas: MAX_TX_GAS, timeoutMs: 60_000, chargeGas: false });
  const deployed = vm.deploy({ programUuid: "bench", code: program(workload), context: as });
  if (deployed.status !== "success") return { name, status: "deploy failed", error: deployed.error?.message };
  vm.commit(deployed.writes);
  vm.commit(vm.init({ programUuid: "bench" }).writes);
  const call = (fn, n) => {
    const started = performance.now();
    const res = vm.call({ programUuid: "bench", functionName: fn, input: { n: `${n}n` }, context: as });
    return { res, ms: performance.now() - started };
  };
  call("run", 10);   // warm up (compile + host JIT)
  const empty = Math.min(...Array.from({ length: 5 }, () => call("empty", 0).ms));
  const baseGas = call("run", 0).res.gasUsed;
  const runs = Array.from({ length: repeat }, () => call("run", iterations));
  const best = runs.reduce((p, q) => (q.ms < p.ms ? q : p));
  const gas = best.res.gasUsed - baseGas;
  const ms = Math.max(0, best.ms - empty);
  return { name, status: best.res.status, code: best.res.error?.code ?? null, error: best.res.error?.message, gas, ms, nsPerGas: gas > 0 ? (ms * 1e6) / gas : Infinity };
}

export function benchAll({ only = null } = {}) {
  const rows = Object.entries(WORKLOADS).filter(([name]) => !only || name.includes(only)).map(([name, workload]) => measure(name, workload));
  const baseline = rows.find((row) => row.name.startsWith("baseline"))?.nsPerGas ?? measure("baseline: number loop", WORKLOADS["baseline: number loop"]).nsPerGas;
  for (const row of rows) row.ratio = row.nsPerGas / baseline;
  return { baseline, rows: rows.sort((p, q) => q.ratio - p.ratio) };
}

if (process.argv[1]?.endsWith("bench-gas.js")) {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
  const { baseline, rows } = benchAll({ only });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ baseline, rows }, null, 2));
  } else {
    console.log(`baseline ${baseline.toFixed(1)} ns/gas (${(1000 / baseline).toFixed(0)} M gas/s) · over ${LIMIT}x = priced too low\n`);
    console.log("x baseline | ns/gas | gas used | ms | workload");
    for (const row of rows) {
      const mark = row.ratio > LIMIT ? "⚠️ " : "   ";
      console.log(`${mark}${row.ratio.toFixed(1).padStart(6)} | ${row.nsPerGas.toFixed(1).padStart(7)} | ${String(row.gas).padStart(9)} | ${row.ms.toFixed(1).padStart(7)} | ${row.name}${row.status === "success" ? "" : ` (${row.code ?? row.status})`}`);
    }
  }
}
