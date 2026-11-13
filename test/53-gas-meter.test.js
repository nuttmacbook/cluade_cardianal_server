import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY } from "./helpers.js";
import { instrument, METER_FNS, PLAIN_HELPERS } from "../src/core/gasmeter.js";

/* step-counted gas: the counter injected at compile time (src/core/gasmeter.js) */

const T = 1_700_000_000_000;

/** Run instrumented code in V8 (size-based helpers are identity) → { result, gas } */
function runInstrumented(body) {
  let gas = 0;
  const helpers = { ...PLAIN_HELPERS, __gas: (n) => { gas += n; } };
  const result = new Function(...METER_FNS, instrument(body))(...METER_FNS.map((name) => helpers[name]));
  return { result, gas };
}
const as = (who) => ({ sender: who, origin: who });

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, ...options });
  const run = (request) => {
    const res = vm.call(request, { timestamp: T });
    if (res.status === "success") vm.commit(res.writes);
    return res;
  };
  const activate = (programUuid, code) => {
    vm.commit(vm.deploy({ programUuid, code, context: as("owner") }, { timestamp: T }).writes);
    vm.commit(vm.init({ programUuid }, { timestamp: T }).writes);
  };
  const call = (programUuid, functionName, input = {}) => run({ programUuid, functionName, input, context: as("alice") });
  return { vm, activate, call };
}

const LOOPS = `function program() {
  function count(params) { let total = 0; for (let i = 0; i < params.input.n; i++) total += i; return total }
  function spin() { while (true) {} }
  function swallow() { while (true) { try { while (true) {} } catch (e) {} } }
  function swallowFinally() { try { while (true) {} } finally { return 1 } }
  function recurse() { return recurse() + 1 }
  return { count, spin, swallow, swallowFinally, recurse }
}`;

test("instrumented code gives the same results for every construct (if / switch / try / loops / arrow / built-in methods)", () => {
  const body = `
    function pick(x) { if (x > 2) return "big"; else if (x > 0) { return "small" } else return "zero" }
    function kind(x) { switch (x) { case 1: return "one"; case 2: case 3: { return "few" } default: return "many" } }
    function safe(f) { try { return f() } catch (e) { return "caught:" + e.message } finally { log.push("f") } }
    const log = [];
    const doubled = [1, 2, 3].map((x) => x * 2).filter((x) => x > 2);
    const text = "a,b,c".split(",").join(";").toUpperCase();
    const obj = { list: [3, 1, 2] };
    const sorted = obj.list.slice().sort((a, b) => a - b);
    const name = "join";
    const dynamic = [1, 2][name]("-");
    const json = JSON.parse(JSON.stringify({ a: [1, { b: 2 }] }));
    let n = 0; for (const v of [1, 2, 3]) n += v; do { n++ } while (n < 10); while (n < 12) n++;
    const spread = [...doubled, ...[7, 8]]; const merged = { ...obj, extra: Math.max(...spread) };
    const { list, ...others } = merged; const [first, ...tail] = spread; let joined = ""; joined += \`\${first}-\${tail.length}\` + "!";
    return [pick(3), pick(1), pick(0), kind(1), kind(3), kind(9), safe(() => { throw new Error("x") }), safe(() => 5), log.length, doubled, text, sorted, dynamic, json, n, Object.keys({ p: 1, q: 2 }), spread, others, list, joined];
  `;
  const expected = new Function(body)();
  const { result, gas } = runInstrumented(body);
  assert.deepEqual(result, expected);
  assert.ok(gas > 0);
});

test("line numbers do not change after instrumentation (errors still point to the same line)", () => {
  const body = "const a = [1]\n  .map((x) => x)\n  .join(',');\nfunction f() {\n  return 1\n}";
  assert.equal(instrument(body).split("\n").length, body.split("\n").length);
});

test("gas grows with loop iterations (same value every time)", () => {
  const { activate, call } = setup();
  activate("loops", LOOPS);
  const g = (n) => call("loops", "count", { n }).gasUsed;
  const [g10, g20, g30] = [g(10), g(20), g(30)];
  assert.equal(g20 - g10, g30 - g20);   // constant per iteration
  assert.ok(g20 - g10 > 0);
  assert.equal(g(20), g20);             // repeatable
});

test("infinite loop → OUT_OF_GAS at the maxTxGas cap (no wait for timeout) even when gas is not charged", () => {
  const { activate, call } = setup({ maxTxGas: 1_000_000 });
  activate("loops", LOOPS);
  const res = call("loops", "spin");
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.ok(res.gasUsed > 1_000_000 && res.gasUsed < 1_000_010);   // stops at the first step past the cap
});

test("catch / finally cannot swallow OUT_OF_GAS", () => {
  const { activate, call } = setup({ maxTxGas: 1_000_000 });
  activate("loops", LOOPS);
  assert.equal(call("loops", "swallow").error.code, "OUT_OF_GAS");
  assert.equal(call("loops", "swallowFinally").error.code, "OUT_OF_GAS");
});

test("infinite loop in a block: runs out of gas per balance → enters the block and pays gas (result does not depend on machine speed)", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true, recordBlocks: true, timeoutMs: 5000 });
  vm.db.load({ "alice:native:received": "50000n" });
  const plain = new VM.VirtualMachine(vm.db);   // set up the program without using nonce / gas
  plain.commit(plain.deploy({ programUuid: "loops", code: LOOPS, context: as("owner") }, { timestamp: T }).writes);
  plain.commit(plain.init({ programUuid: "loops" }, { timestamp: T }).writes);
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  const res = block.call({ programUuid: "loops", functionName: "spin", context: as("alice"), nonce: 0 });
  block.commit();
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.equal(res.accepted, true);
  assert.equal(vm.nativeBalanceOf("alice").balance, 0n);   // pays all it has
  assert.equal(vm.getBlock(1).txCount, 1);
});

test("built-in methods charge gas by data size · a large repeat is stopped before building the data", () => {
  const code = `function program() {
    function joinN(params) { const list = []; list.length = Number(params.input.n); return BigInt(list.fill("x").join("").length) }
    function huge() { return "x".repeat(1e9).length }
    return { joinN, huge }
  }`;
  const { activate, call } = setup({ maxTxGas: 5_000_000 });
  activate("b", code);
  const small = call("b", "joinN", { n: 1_000 }).gasUsed;
  const big = call("b", "joinN", { n: 2_000 }).gasUsed;
  // fill (in + out) + join (in) = 3 per added element × 1,000 · join's result is charged per 32 characters: ⌈2000/32⌉ − ⌈1000/32⌉ = 31
  // (formerly 4,000 when strings cost 1 per character; now strings cost 1 per 32 characters, like every other way of building a string)
  assert.equal(big - small, 3_031);
  const started = Date.now();
  assert.equal(call("b", "huge").error.code, "OUT_OF_GAS");
  assert.ok(Date.now() - started < 1000);
});

test("per-node / builtin prices are configurable · 0 = charge only APIs, as before", () => {
  const plain = setup({ gas: API_GAS_ONLY });
  const priced = setup({ gas: { node: 3 } });
  for (const s of [plain, priced]) s.activate("loops", LOOPS);
  const base = plain.call("loops", "count", { n: 5 }).gasUsed;
  assert.equal(base, VM.DEFAULT_GAS.call);
  assert.ok(priced.call("loops", "count", { n: 5 }).gasUsed > base);
});

test("names __gas / __call / __str / __props / __spread are reserved → deploy fails", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  for (const code of [
    "function program() { function f() { const __gas = () => 0; while (true) {} } return { f } }",
    "function program() { function f() { return __call } return { f } }",
    "function program() { function f() { const __str = (v) => v; return __str } return { f } }",
    "function program() { function f(__props) { return 1 } return { f } }",
    "function program() { function f() { return __spread } return { f } }",
  ]) {
    const res = vm.deploy({ programUuid: "x", code, context: as("owner") }, { timestamp: T });
    assert.equal(res.status, "throw");
    assert.match(res.error.message, /is reserved/);
  }
});

// gasmeter used to rewrite method calls into __call(…) and once rewrote (255).toString(36) wrongly; it no longer rewrites calls (methods are wrapped in the sandbox)
// but we still check that such code stays valid after instrumentation and keeps its line numbers
test("method calls on numbers / parenthesized values: (255).toString(36) · 1..toString() · (1n).toString(16) remain valid code after instrumentation", () => {
  const cases = [
    "(255).toString(36)", "1..toString()", "1.5.toString()", "(1n).toString(16)", "((255)) . toString ( 2 )",
    "(list).join('-')", "(list.join)('+')", "(((list.join)))('*')", "((list)[name])('/')", "list[(name)]('|')",
    "(list.slice(1)).join(',')", "list /* .x( */ . join /* ) */ ('~')", "(\n255\n)\n.toString(\n36\n)",
  ];
  for (const expr of cases) {
    const body = `const list = ["a", "b", "c"]; const name = "join"; return ${expr};`;
    const expected = new Function(body)();
    const code = instrument(body);
    assert.equal(runInstrumented(body).result, expected, `${expr} → ${code}`);
    assert.equal(code.split("\n").length, body.split("\n").length, `${expr}: line count must not change`);
  }
});

test("programs using (255).toString(36) / 1..toString() / (1n).toString(16) deploy and run (pass autoreview)", () => {
  const code = `function program() {
    function show() { return [(255).toString(36), 1..toString(), (1n).toString(16), (255n).toString(2), ("ab").toUpperCase()] }
    return { show }
  }`;
  const { activate, call } = setup({ autoReview: true });
  activate("lit", code);
  const res = call("lit", "show");
  assert.equal(res.status, "success", JSON.stringify(res.error));
  assert.deepEqual(res.result, ["73", "1", "1", "11111111", "AB"]);
});
