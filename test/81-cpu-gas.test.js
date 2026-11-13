import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { instrument, METER_FNS, PLAIN_HELPERS, BIGINT_MAX_BITS } from "../src/core/gasmeter.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";

/*
 * gas by CPU work: regex / large BigInt (src/core/gasmeter.js · src/core/sandbox.js "BigInt: gas by CPU work")
 * previously exponential-backtracking regexes and large BigInts (2n ** 10n ** 9n, toString of 300k bits) burned seconds of CPU for a few hundred gas
 *   and could only be stopped by a wall-clock timeout (results varied across machines)
 * now: regex fully disabled · BigInt gas by size (charged up front for ** << and string conversion) · 8192-bit cap
 *   values ≤ 512 bits cost nothing extra → existing programs (token / uint256) keep their gas
 */

const T = 1_700_000_000_000;
const as = (who) => ({ sender: who, origin: who });
const TIMEOUT_MS = 20_000;
const FAST_MS = 3_000;   // stopping by gas is much faster than the timeout (each case used to take ≥ 1 second or time out)

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: TIMEOUT_MS, ...options });
  const activate = (programUuid, code) => {
    const deployed = vm.deploy({ programUuid, code, context: as("owner") }, { timestamp: T });
    assert.equal(deployed.status, "success", JSON.stringify(deployed.error));
    vm.commit(deployed.writes);
    vm.commit(vm.init({ programUuid }, { timestamp: T }).writes);
  };
  const call = (programUuid, functionName, input = {}) => {
    const started = performance.now();
    const res = vm.call({ programUuid, functionName, input, context: as("alice") }, { timestamp: T });
    res.ms = performance.now() - started;
    if (res.status === "success") vm.commit(res.writes);
    return res;
  };
  return { vm, activate, call };
}

const program = (fns) => `function program() {
  ${Object.entries(fns).map(([name, body]) => `function ${name}(params) { ${body} }`).join("\n  ")}
  return { ${Object.keys(fns).join(", ")} }
}`;

const TYPE_ERROR = "program error (TypeError)";
const RANGE_ERROR = "program error (RangeError)";

test("regex: literals are rejected at deploy · RegExp / match / search / matchAll / species fail even with autoreview off · replace / split with strings still work", () => {
  const { vm, activate, call } = setup({ maxTxGas: 3_000_000 });
  const literal = vm.deploy({ programUuid: "lit", code: program({ f: "return /(a+)+$/.test('a')" }), context: as("owner") }, { timestamp: T });
  assert.equal(literal.status, "throw");
  assert.match(literal.error.message, /regular expressions are not allowed in programs/);

  const evil = `const s = "a".repeat(30) + "b";`;   // (a+)+$ on a×30 + b = ~2^30 backtracking steps (it used to take ~2 seconds at 24 chars)
  activate("re", program({
    ctor: `${evil} return new RegExp("(a+)+$").test(s)`,
    call: `${evil} return RegExp("(a+)+$").test(s)`,
    match: `${evil} return s.match("(a+)+$")`,
    search: `${evil} return s.search("(a+)+$")`,
    matchAll: `${evil} return [...s.matchAll("(a+)+$")]`,
    species: `${evil} return RegExp.prototype[Symbol.split].call({ flags: "", toString() { return "(a+)+$" } }, s)`,
    protoTest: `${evil} return RegExp.prototype.test.call({ exec() { return null } }, s)`,
    construct: `return Reflect.construct(RegExp, ["a"])`,
    strings: `return ["a-b-c".split("-").length, "a-b".replace("-", "+"), "a-b-a".replaceAll("a", "x"), "abc".includes("b"), "abc".indexOf("c")].join()`,
  }));
  for (const fn of ["ctor", "call", "match", "search", "matchAll", "species", "protoTest", "construct"]) {
    const res = call("re", fn);
    assert.equal(res.status, "throw", fn);
    assert.equal(res.error.message, TYPE_ERROR, fn);
    assert.ok(res.ms < FAST_MS, `${fn} ${res.ms}ms`);
  }
  assert.equal(call("re", "strings").result, "3,a+b,x-b-x,true,2");
});

test("large BigInt runs out of gas fast (charged before computing) instead of waiting for the timeout", () => {
  const { activate, call } = setup({ maxTxGas: 3_000_000 });
  const prep = `const B = (1n << 8191n) - 12345n; const H = (1n << 4095n) - 77n; const S = String(B); const o = {}; let sink;`;
  const attacks = {
    powHuge: "sink = 2n ** 1000000000n",          // previously: actually computed until RangeError / timeout
    pow10M: "for (;;) sink = 2n ** 10000000n",
    powCap: "for (;;) sink = 3n ** 5000n",
    shlHuge: "for (;;) { try { sink = 1n << 100000000n } catch (e) {} }",
    mul: "for (;;) sink = H * H",
    div: "for (;;) sink = B / H",
    addGrow: "let x = B; for (;;) { try { x = x + x } catch (e) { x = B } }",
    toText: "for (;;) sink = B.toString()",
    template: "for (;;) sink = `${B}`",
    key: "for (;;) o[B] = 1",
    join: "const a = [B]; for (;;) sink = a.join()",
    errorMsg: "for (;;) sink = new Error(B)",
    hasOwn: "for (;;) sink = Object.hasOwn(o, B)",
    parse: "for (;;) sink = BigInt(S)",
    looseEq: "for (;;) sink = S == B",
  };
  activate("big", program(Object.fromEntries(Object.entries(attacks).map(([k, op]) => [k, `${prep} ${op}`]))));
  for (const fn of Object.keys(attacks)) {
    const res = call("big", fn);
    assert.equal(res.error?.code, "OUT_OF_GAS", `${fn}: ${JSON.stringify(res.error)}`);
    assert.ok(res.ms < FAST_MS, `${fn} ${res.ms}ms`);
  }
  // ** whose result surely exceeds the cap is charged in full before computing → 2n ** 10n ** 9n runs out of gas in one step
  assert.ok(call("big", "powHuge").gasUsed > 1e14);
});

test("8192-bit BigInt cap: large literals rejected · results over the cap → RangeError · values exactly at the cap work", () => {
  assert.equal(BIGINT_MAX_BITS, 8192);
  const { vm, activate, call } = setup();
  const lit = vm.deploy({ programUuid: "lit", code: program({ f: `return 0x${"f".repeat(2049)}n` }), context: as("owner") }, { timestamp: T });
  assert.equal(lit.status, "throw");
  assert.match(lit.error.message, /BigInt exceeds 8192 bits/);
  activate("cap", program({
    max: "const m = ((1n << 8191n) - 1n) * 2n + 1n; return BigInt(m.toString(16).length)",   // 2^8192 − 1 (1n << 8192n itself is already over)
    shl: "return 1n << 8192n",
    mul: "const h = 1n << 4096n; return h * h",
    add: "const m = ((1n << 8191n) - 1n) * 2n + 1n; return m + 1n",
    pow: "return 2n ** 8192n",
    parse: `return BigInt("1" + "0".repeat(2500))`,
    caught: "try { return 1n << 9000n } catch (e) { return e instanceof RangeError && e.message.includes('8192') }",
  }));
  const max = call("cap", "max");
  assert.equal(max.status, "success", JSON.stringify(max.error));
  assert.equal(max.result, "2048n");
  for (const fn of ["shl", "mul", "add", "pow", "parse"]) assert.equal(call("cap", fn).error?.message, RANGE_ERROR, fn);
  assert.equal(call("cap", "caught").result, true);
});

test("BigInt pricing formula: ×  ⌈Wa·Wb/4⌉ · ÷ %  ⌈(Wa−Wb+1)·Wb/4⌉ · ** ⌈Wr²/4⌉ · → string W² · string → BigInt W² · values ≤ 512 bits cost nothing extra", () => {
  const { activate, call } = setup();
  // A = k bits, B = 2k−1 bits · compare the op's gas with a base that prepares the same data, then subtract the small-value case (k = 8) → leaves the pure size-based price
  const prep = `const k = BigInt(params.input.bits); const A = (1n << k) - 1n; const B = (1n << (2n * k - 1n)) - 12345n; const S = String(B); let sink;`;
  const ops = {
    mul: "sink = A * A", div: "sink = B / A", mod: "sink = B % A", add: "sink = B + 1n",
    str: "sink = String(B)", parse: "sink = BigInt(S)", lt: "sink = A < B",
    pow: "sink = 3n ** (k * 2n)",
  };
  activate("price", program({ base: `${prep} return 1n`, ...Object.fromEntries(Object.entries(ops).map(([k, op]) => [k, `${prep} ${op}; return 1n`])) }));
  const extra = (fn, bits) => call("price", fn, { bits: String(bits) }).gasUsed - call("price", "base", { bits: String(bits) }).gasUsed;
  const price = (fn, bits) => extra(fn, bits) - extra(fn, 8);
  const words = (bits) => Math.ceil(bits / 64);
  const digits = (bits) => String((1n << BigInt(2 * bits - 1)) - 12345n).length;

  // ≤ 512 bits (uint256 × uint256 stays under) → no extra cost
  for (const fn of ["mul", "div", "mod", "add", "str", "parse", "lt"]) assert.equal(price(fn, 200), 0, fn);
  const k = 2048;   // A = 32 word, B = 4095 bit = 64 word
  assert.equal(price("mul", k), Math.ceil(32 * 32 / 4));                  // 256
  assert.equal(price("div", k), Math.ceil((64 - 32 + 1) * 32 / 4));       // 264
  assert.equal(price("mod", k), Math.ceil((64 - 32 + 1) * 32 / 4));
  assert.equal(price("add", k), 64);                                       // ≥ 2^1024: 64 (linear)
  assert.equal(price("str", k), 64 * 64);                                  // 4096
  // 1233 digits → 65 words → 4225 · plus 64² for converting the large result (the engine can call BigInt, e.g. { toString: BigInt.bind(…) })
  assert.equal(price("parse", k), Math.ceil(digits(k) / 19) ** 2 + 64 * 64);
  assert.equal(price("lt", k), 0);                                         // comparisons cost nothing extra (linear work, very fast)
  // ** is charged by result size before computing: 3 = 2 bits → 3n ** 2k ≤ 4k bits
  const powUnits = (bits) => { const w = words(2 * 2 * bits); return w > 8 ? Math.max(16, Math.ceil(w * w / 4)) : 0; };
  assert.equal(price("pow", 1500), powUnits(1500) - powUnits(8));
  assert.equal(words(4095), 64);
});

test("deterministic gas: BigInt / string / out-of-gas work gives the same gas every time, on every VM", () => {
  const code = program({
    work: `let x = (1n << 4000n) + 12345n, acc = 0n, s = "";
      for (let i = 0n; i < 20n; i++) { x = (x * x) % ((1n << 4001n) - 1n); acc += x >> 3000n; s += String(x % 1000n); }
      const o = { [x]: 1 }; return [acc % 1000000n, s.length, Object.keys(o)[0].length, BigInt(String(x)) === x].join()`,
    oog: "let x = (1n << 8000n) - 1n, sink; for (;;) sink = x.toString() + (x * 3n)",
  });
  const runs = [0, 1].map(() => {
    const { activate, call } = setup({ maxTxGas: 2_000_000 });
    activate("d", code);
    return [call("d", "work"), call("d", "work"), call("d", "oog")];
  });
  const [first, second] = runs;
  assert.equal(first[0].status, "success", JSON.stringify(first[0].error));
  assert.equal(first[2].error.code, "OUT_OF_GAS");
  for (let i = 0; i < 3; i++) {
    assert.equal(first[i].gasUsed, second[i].gasUsed, `call ${i}`);
    assert.deepEqual(first[i].result, second[i].result);
  }
  assert.equal(first[0].gasUsed, first[1].gasUsed);
});

test("token transfer works as before with the same gas (uint256 values cost nothing extra)", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const OWNER = "0x00000000000000000000000000000000000000a1";
  const BOB = "0x00000000000000000000000000000000000000b2";
  const TOKEN = "0x00000000000000000000000000000000000000f1";
  for (const step of [
    () => vm.deploy({ programUuid: TOKEN, code: TOKEN_PROGRAM, context: as(OWNER), initInput: { name: "A", ticker: "A", decimals: "18n", supply: String(2n ** 255n) + "n" } }, { timestamp: T }),
    () => vm.init({ programUuid: TOKEN }, { timestamp: T }),
  ]) {
    const res = step();
    assert.equal(res.status, "success", JSON.stringify(res.error));
    vm.commit(res.writes);
  }
  const send = (amount) => {
    const res = vm.call({ programUuid: TOKEN, functionName: "transfer", input: { to: BOB, amount: String(amount) + "n" }, context: as(OWNER) }, { timestamp: T });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    vm.commit(res.writes);
    return res.gasUsed;
  };
  // same numbers as before the change (main 90facdb); uint256 values are within the free ≤ 512-bit range · plus stateKey for 2 balance keys (sender / recipient)
  const { stateKey } = VM.DEFAULT_GAS;
  assert.equal(send(1000n), 2722 + 2 * stateKey);
  assert.equal(send(2n ** 254n + 12345n), 2875 + 2 * stateKey);
  const approve = vm.call({ programUuid: TOKEN, functionName: "approve", input: { spender: BOB, amount: String(2n ** 256n - 1n) + "n" }, context: as(OWNER) }, { timestamp: T });
  assert.equal(approve.gasUsed, 1979 + stateKey);   // allowance 1 key
  const balance = vm.call({ programUuid: TOKEN, functionName: "balanceOf", input: { who: BOB }, context: as(OWNER) }, { timestamp: T });
  assert.equal(balance.result, String(2n ** 254n + 12345n + 1000n) + "n");
});

test("number prices unchanged · code with rewritten operators / compound assignments / keys / returns behaves exactly like plain JavaScript", () => {
  // number gas: 1 per node as before (operator helpers charge no gas themselves)
  let gas = 0;
  const helpers = { ...PLAIN_HELPERS, __gas: (n) => { gas += n; } };
  const run = (body) => new Function(...METER_FNS, instrument(body))(...METER_FNS.map((name) => helpers[name]));
  const gasOf = (body) => { gas = 0; const result = run(body); return [String(result), gas]; };
  // same numbers as before the change (main 90facdb)
  assert.deepEqual(gasOf("let x = 0; for (let i = 0; i < 100; i++) x = x + i * 2 - 1; return x"), ["9800", 1512]);
  assert.deepEqual(gasOf("let s = 0, o = { a: 1, b: [1, 2, 3] }; for (let i = 0; i < 50; i++) { s += o.b[i % 3] * 3 / 2; o.a <<= 1; o.a %= 1000; if (s > 10 && i in o.b) s -= 1 } return s"), ["148.5", 2124]);
  assert.deepEqual(gasOf("const m = 10n ** 18n; let t = 0n; for (let i = 0n; i < 30n; i++) t = t + i * m / 7n; return t"), ["62142857142857142845", 468]);

  const body = `
    const log = [];
    const o = { a: 1, b: { c: 2 }, list: [1, 2, 3], n: 5n };
    let x = 3, s = "s";
    x += 2; x -= 1; x *= 3; x /= 2; x %= 4; x **= 2; x <<= 3; x >>= 1;
    s += x; s += "!";
    o.a += 10; o.b.c *= 7; o["a"] -= 1; o.list[1] += 5; o.n **= 3n;
    let i = 0; const arr = [10, 20, 30];
    arr[i++] += 1; arr[i++] *= 2;
    const get = () => { log.push("get"); return o.b; };
    get().c += (log.push("rhs"), 1);
    const k = () => { log.push("key"); return "c"; };
    o.b[k()] += (log.push("rhs2"), 1);
    const big = 2n ** 64n * 3n - 1n / 1n % 5n;
    const cmp = [1 < 2, 2 > 1, 1 <= 1, 2 >= 3, 1 == "1", 1 != 2, 5n == 5, "a" in o, 0 in arr, 1n < 2, "10" > 9, null == undefined, NaN != NaN];
    const sh = [1 << 3, -16 >> 2, 1n << 70n, (1n << 70n) >> 3n, -1 >>> 28];
    const keys = { [1 + 1]: "two", ["x" + "y"]: "xy", [5n]: "five" };
    const ret = ((a, b) => a * b + 1)(3, 4);
    const seq = (() => (1, 2))();
    function f(a) { return a, a + 1 }
    class C { static [("m" + 1)]() { return 7 } #p = 1; inc() { this.#p += 5; return this.#p } has(o) { return #p in o } }
    const vals = [f(1), C.m1(), new C().inc(), new C().has(new C()), typeof (0 /* c */ * /* d */ 1)];
    let obj2 = { v: 1 }; const getObj = () => obj2;
    getObj()["v"] **= 3;
    const nested = arr[arr[0] > 5 ? 1 : 2] + o.list[o.list.length - 1];
    const str = 1 + 2 + "3" + 4 * 5 + 1n;
    let a2 = [1, 2]; a2[(log.push("idx"), 0)] += (log.push("val"), 9);
    const wrapped = { valueOf() { log.push("valueOf"); return 4 } };
    const viaObj = [wrapped + 1, wrapped * 2n === undefined, [1] + [2], {} + "", 7 - "2"].map(String);
    return [x, s, o, arr, log, big, cmp, sh, keys, ret, seq, vals, obj2, nested, str, a2, viaObj];
  `;
  const ser = (v) => JSON.stringify(v, (key, x) => (typeof x === "bigint" ? x + "n" : x));
  let expected;
  try { expected = new Function(body)(); } catch (e) { expected = e.constructor.name; }
  let actual;
  try { actual = run(body); } catch (e) { actual = e.constructor.name; }
  assert.equal(ser(actual), ser(expected));
});
