import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";

/*
 * gas by the size of data copied / created (src/core/sandbox.js "gas by data size" · src/core/gasmeter.js)
 *   builtin 1 gas per unit · 1 unit = 1 element (array / property / Set / Map / argument) or 32 characters / bytes (rounded up)
 * previously [...a, ...a] / f(...a) / { ...o } / a + "" cost only 1 gas per node → a doubling loop could allocate 32 MB for ~230 gas
 * tests take the gas difference between n and 2n items (the code's fixed costs cancel out) → the per-unit price shows directly
 */

const T = 1_700_000_000_000;
const as = (who) => ({ sender: who, origin: who });
const units = (length) => Math.ceil(length / 32);   // 32 characters / bytes = 1 unit

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 20_000, ...options });
  const activate = (programUuid, code) => {
    const deployed = vm.deploy({ programUuid, code, context: as("owner") }, { timestamp: T });
    assert.equal(deployed.status, "success", JSON.stringify(deployed.error));
    vm.commit(deployed.writes);
    vm.commit(vm.init({ programUuid }, { timestamp: T }).writes);
  };
  const call = (programUuid, functionName, input = {}) => {
    const res = vm.call({ programUuid, functionName, input, context: as("alice") }, { timestamp: T });
    if (res.status === "success") vm.commit(res.writes);
    return res;
  };
  return { vm, activate, call };
}

/** A program whose every function first builds data of size n (prepare), then does one op */
function program(prepare, ops) {
  const fns = Object.entries(ops).map(([name, op]) => `function ${name}(params) { const n = Number(params.input.n); ${prepare} ${op}; return 1n }`);
  return `function program() {
  function count(...xs) { return xs.length }
  class Box { constructor(...xs) { this.size = xs.length } }
  function base(params) { const n = Number(params.input.n); ${prepare} return 1n }
  ${fns.join("\n  ")}
  return { base, ${Object.keys(ops).join(", ")} }
}`;
}

/** Extra gas the op uses when data grows from n to 2n (minus what prepare used) */
function perGrowth(call, uuid, name, n) {
  const gas = (fn, size) => {
    const res = call(uuid, fn, { n: `${size}n` });
    assert.equal(res.status, "success", `${name}(${size}): ${JSON.stringify(res.error)}`);
    return res.gasUsed;
  };
  return (gas(name, 2 * n) - gas(name, n)) - (gas("base", 2 * n) - gas("base", n));
}

test("doubling [...a, ...a] loop: gas grows with element count · runs out of gas (OUT_OF_GAS) before the 32 MB memory cap", () => {
  const code = `function program() {
    function double(params) { let a = [1n]; for (let i = 0n; i < params.input.k; i++) a = [...a, ...a]; return BigInt(a.length) }
    function keep(params) { let a = [1n]; const all = []; for (let i = 0n; i < params.input.k; i++) { a = [...a, ...a]; all.push(a) } return BigInt(a.length) }
    return { double, keep }
  }`;
  const { activate, call } = setup({ maxTxGas: 3_000_000 });   // same per-tx cap as the server
  activate("lab", code);
  const gas = (k) => call("lab", "double", { k: `${k}n` }).gasUsed;
  // round k copies 2^k elements → the second difference = exactly 2^k (same code per round)
  const [g10, g11, g12] = [gas(10), gas(11), gas(12)];
  assert.equal((g12 - g11) - (g11 - g10), 2 ** 12 - 2 ** 11);
  assert.ok(g12 - g11 > 2 ** 12, "round 12 must cost at least 4,096 (elements copied)");
  // 2^20 elements (~8 MB) take ~2.1M gas · 2^21 needs another 2.1M → out of gas at 3M before reaching 32 MB
  const twenty = call("lab", "double", { k: "20n" });
  assert.equal(twenty.status, "success");
  assert.ok(twenty.gasUsed > 2 ** 21 && twenty.gasUsed < 2 ** 21 + 10_000, String(twenty.gasUsed));
  const runaway = call("lab", "double", { k: "64n" });
  assert.equal(runaway.error.code, "OUT_OF_GAS");          // previously: OUT_OF_MEMORY at ~230 gas
  assert.ok(runaway.gasUsed > 3_000_000);
  // keeping every chunk (like the old GAS_LAB_PROGRAM trap) also runs out of gas first
  assert.equal(call("lab", "keep", { k: "64n" }).error.code, "OUT_OF_GAS");
});

test("array spread / rest: 1 unit per element ([...a] · f(...a) · new F(...a) · apply · const [x, ...r] = a · Set / Map)", () => {
  const { activate, call } = setup();
  activate("arr", program("const a = Array(n).fill(7);", {
    arrayLiteral: "const b = [...a]",
    twice: "const b = [...a, 0, ...a]",
    callArgs: "count(...a)",
    newArgs: "new Box(...a)",
    applyArgs: "count.apply(null, a)",
    reflectApply: "Reflect.apply(count, null, a)",
    arrayRest: "const [x, ...rest] = a",
    assignRest: "let x, rest; [x, ...rest] = a",
    set: "new Set(a)",
    mapCtor: "new Map(Object.entries(a))",
    arrayFrom: "Array.from(a)",
    arrayOnly: "Array(2 * n)",
  }));
  const n = 1000;
  const cases = {
    arrayLiteral: n, twice: 2 * n, callArgs: n, newArgs: n, applyArgs: n, reflectApply: n, arrayRest: n, assignRest: n,
    set: n,
    mapCtor: 2 * n + n,    // Object.entries (in n + out n) + Map n
    arrayFrom: 2 * n,      // input n + result n
    arrayOnly: 0,          // Array(n) allocates no element storage (QuickJS) → free · fill / spread / map … charge by length when used
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(perGrowth(call, "arr", name, n), expected, name);
});

test("{ ...o } and const { a, ...rest } = o: 1 unit per copied property", () => {
  const { activate, call } = setup();
  activate("obj", program("const a = Array(n).fill(7); const o = Object.fromEntries(Object.entries(a));", {
    objectSpread: "const c = { ...o }",
    arraySpreadIntoObject: "const c = { ...a }",
    objectRest: "const { x, ...rest } = o",
    assignRest: "let x, rest; ({ x, ...rest } = o)",
    proxySpread: "const c = { ...new Proxy(o, {}) }",
    assign: "Object.assign({}, o)",
  }));
  const n = 1000;
  const cases = { objectSpread: n, arraySpreadIntoObject: n, objectRest: n, assignRest: n, proxySpread: n, assign: 2 * n };
  for (const [name, expected] of Object.entries(cases)) assert.equal(perGrowth(call, "obj", name, n), expected, name);
});

test("array methods cost the same however they are called (.call / Reflect.apply / stored in a variable / implicit string conversion)", () => {
  const { activate, call } = setup();
  activate("methods", program("const a = Array(n).fill(7);", {
    join: "a.join(',')",
    joinCall: "Array.prototype.join.call(a, ',')",
    joinReflect: "Reflect.apply(Array.prototype.join, a, [','])",
    joinAlias: "const j = a.join; j.call(a, ',')",
    toStringImplicit: "const s = a + ''",
    template: "const s = `${a}`",
    stringCall: "String(a)",
    stringify: "JSON.stringify(a)",
    keys: "Object.keys(a)",
    slice: "a.slice()",
    concat: "a.concat(a)",
    fill: "a.fill(1)",
    toSorted: "a.toSorted()",
    reverse: "a.reverse()",
    flat: "[a].flat()",
    splice: "a.splice(0, 1)",
    fromLength: "Array.from({ length: n })",
  }));
  const n = 1000;
  // "7,7,…" is 2n − 1 characters long
  const joined = n + units(2 * (2 * n) - 1) - units(2 * n - 1);   // input n elements + result (per 32 characters)
  const cases = {
    join: joined, joinCall: joined, joinReflect: joined, joinAlias: joined,
    toStringImplicit: joined + units(4 * n - 1) - units(2 * n - 1),   // + the string from a + ''
    template: n + joined + (units(4 * n - 1) - units(2 * n - 1)),       // "".concat(a): in a (n elements) → internal join → out
    stringCall: joined,
    stringify: 3 * n + units(4 * n + 1) - units(2 * n + 1),            // "[7,7,…]" + 2 units per converted value (test 88)
    keys: 2 * n, slice: 2 * n, concat: 4 * n, fill: 2 * n, toSorted: 2 * n, reverse: 2 * n,
    flat: 2 * n,                     // elements walked at every level (test 88) + result
    splice: n, fromLength: n,
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(perGrowth(call, "methods", name, n), expected, name);
});

test("string: concatenation with + / += / template · repeat / padEnd / split / replaceAll / concat cost 1 unit per 32 characters", () => {
  const { activate, call } = setup();
  activate("text", program("const s = 'x'.repeat(n);", {
    plus: "const t = s + s",
    plusAssign: "let t = s; t += s",
    template: "const t = `${s}:${s}`",
    concat: "s.concat(s)",
    upper: "s.toUpperCase()",
    padEnd: "s.padEnd(2 * n, 'y')",
    replaceAll: "s.replaceAll('x', 'yy')",
    split: "s.split('')",
    repeatCall: "String.prototype.repeat.call('ab', n)",
    parse: "JSON.parse(JSON.stringify(s))",
  }));
  const n = 32_000;   // 1,000 units
  const u = units(n);
  const cases = {
    plus: 2 * u, plusAssign: 2 * u,
    template: 2 * u + 2 * u,         // QuickJS builds templates with "".concat(…) → in s + s · out 2n characters
    concat: 2 * u + 2 * u,           // in s + s · out 2n characters
    upper: 2 * u,
    padEnd: u + 2 * u,               // in s · the 2n-character result is charged before it is built
    replaceAll: u + 2 * u,
    split: u + n,                    // result = n elements
    repeatCall: 2 * u,               // "ab" × n = 2n characters, charged before building
    parse: 2 * u + 3 * u,            // stringify (in + out) + parse (in + out + per-character conversion work, test 88)
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(perGrowth(call, "text", name, n), expected, name);
});

test("ArrayBuffer / typed arrays cost by allocated size · charged before allocating, so they stop before building data · RegExp disabled (test 81)", () => {
  const { activate, call } = setup({ maxTxGas: 3_000_000 });
  activate("bytes", program("", {
    buffer: "new ArrayBuffer(n)",
    resizable: "new ArrayBuffer(1, { maxByteLength: n })",
    bytes: "new Uint8Array(n)",
    words: "new Float64Array(n)",
    copy: "new Uint8Array(Array(n).fill(1))",
    regexp: "new RegExp('a'.repeat(n))",
  }));
  const n = 32_000;
  assert.equal(perGrowth(call, "bytes", "buffer", n), units(n));
  assert.equal(perGrowth(call, "bytes", "resizable", n), units(n));
  assert.equal(perGrowth(call, "bytes", "bytes", n), n);                // typed array = 1 unit per element
  assert.equal(perGrowth(call, "bytes", "words", n), n);
  assert.equal(perGrowth(call, "bytes", "copy", n), 2 * n + n);          // fill (in + out) + copied elements
  // RegExp is fully disabled (backtracking cannot be charged up front, see test 81); previously charged by pattern length
  assert.equal(call("bytes", "regexp", { n: "10n" }).error.message, "program error (TypeError)");
  const started = Date.now();
  assert.equal(call("bytes", "buffer", { n: "2000000000n" }).error.code, "OUT_OF_GAS");   // never actually allocated
  assert.equal(call("bytes", "bytes", { n: "100000000n" }).error.code, "OUT_OF_GAS");
  assert.ok(Date.now() - started < 1000);
});

test("bypass attempts: an iterator created before the data grows · a Proxy whose ownKeys answers inconsistently · patching built-in iterators", () => {
  const { activate, call } = setup();
  activate("tricks", `function program() {
    function base(params) { const n = Number(params.input.n); const a = []; a.push(...Array(n).fill(1)); return 1n }
    function staleIterator(params) {
      const n = Number(params.input.n); const a = []; const it = a.values(); a.push(...Array(n).fill(1)); const c = [...it]; return 1n
    }
    function lyingProxy() {
      let asked = 0
      const big = Object.fromEntries(Object.entries(Array(1000).fill(1)))
      const p = new Proxy(big, { ownKeys: (target) => (asked++ === 0 ? [] : Reflect.ownKeys(target)) })
      const copy = { ...p }
      return [BigInt(Object.keys(copy).length), BigInt(asked)]
    }
    function patchIterator() {
      try { Array.prototype[Symbol.iterator] = function* () { yield 1 }; return "patched" } catch (e) { return e.name }
    }
    function patchNext() {
      try { Object.getPrototypeOf([].values()).next = () => ({ done: true }); return "patched" } catch (e) { return e.name }
    }
    function nativeLook() { return [Function.prototype.toString.call([].join), [].join.name, BigInt([].join.length), BigInt("ab".padStart.length)] }
    return { base, staleIterator, lyingProxy, patchIterator, patchNext, nativeLook }
  }`);
  // iterator created while the array is empty, then filled → [...it] is still charged per element
  assert.equal(perGrowth(call, "tricks", "staleIterator", 1000), 1000);
  // copying a Proxy asks ownKeys once (per the spec) and charges by that answer; the engine never asks again for a different answer
  assert.deepEqual(call("tricks", "lyingProxy").result, ["0n", "1n"]);
  assert.deepEqual(call("tricks", "patchIterator").result, "TypeError");
  assert.deepEqual(call("tricks", "patchNext").result, "TypeError");
  // the wrappers look like the real thing (name / length / toString)
  assert.deepEqual(call("tricks", "nativeLook").result, ["function join() {\n    [native code]\n}", "join", "1n", "1n"]);
});

test("...rest in positions that cannot be metered (parameters / for…of / catch / nested) → deploy fails · function f(...args) is allowed", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  for (const body of [
    "function f({ a, ...rest }) { return rest }",
    "function f([a, ...rest]) { return rest }",
    "function f(params) { for (const { a, ...rest } of params.input.list) {} }",
    "function f(params) { const { list: [...copy] } = params.input; return copy }",
    "function f(params) { const [{ ...copy }] = params.input.list; return copy }",
  ]) {
    const res = vm.deploy({ programUuid: "x", code: `function program() { ${body} return { f } }`, context: as("owner") }, { timestamp: T });
    assert.equal(res.status, "throw", body);
    assert.match(res.error.message, /\.\.\.rest/, body);
  }
  const ok = vm.deploy({ programUuid: "y", code: "function program() { function f(...args) { const [a, ...rest] = args; const { b, ...others } = a || {}; return BigInt(rest.length) } return { f } }", context: as("owner") }, { timestamp: T });
  assert.equal(ok.status, "success", JSON.stringify(ok.error));
});

test("runProgram input / result are charged by JSON size (1 unit per 32 bytes, both directions)", () => {
  const { activate, call } = setup();
  activate("echo", "function program() { function echo(params) { return params.input.text } return { echo } }");
  activate("caller", `function program() {
    function base(params) { const text = "x".repeat(Number(params.input.n)); return 1n }
    function relay(params) { const text = "x".repeat(Number(params.input.n)); runProgram("echo", "echo", { text: text }); return 1n }
    return { base, relay }
  }`);
  const n = 32_000;
  // {"text":"xxx…"} going out + "xxx…" coming back: the part that grows with n = 2 × n bytes
  assert.equal(perGrowth(call, "caller", "relay", n), units(2 * n + 11) - units(n + 11) + units(2 * n + 2) - units(n + 2));
});

test("memory overflow (OUT_OF_MEMORY) pays gas for the work actually done, not just what reached the host", () => {
  const { activate, call } = setup({ maxTxGas: 3_000_000 });
  activate("mem", `function program() {
    function grow() { const keep = []; while (true) keep.push("x".repeat(1048576)) }
    return { grow }
  }`);
  const res = call("mem", "grow");
  assert.equal(res.error.code, "OUT_OF_MEMORY");
  assert.ok(res.gasUsed > 900_000 && res.gasUsed < 1_200_000, String(res.gasUsed));   // ≈ 32 MB ÷ 32 = 1M units
});

test("same results every time (size-based gas does not depend on the machine)", () => {
  const code = `function program() {
    function mix(params) {
      const a = Array(Number(params.input.n)).fill("ab")
      const o = { ...a, extra: [...a, ...a].join("-") }
      const { extra, ...rest } = o
      return BigInt(\`\${extra}\${Object.keys(rest)}\`.length)
    }
    return { mix }
  }`;
  const runs = [0, 1].map(() => {
    const { activate, call } = setup();
    activate("mix", code);
    return [call("mix", "mix", { n: "500n" }), call("mix", "mix", { n: "500n" })].map((r) => [r.status, r.result, r.gasUsed]);
  });
  assert.deepEqual(runs[0], runs[1]);
  assert.deepEqual(runs[0][0], runs[0][1]);
});
