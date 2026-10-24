import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { instrument, METER_FNS, PLAIN_HELPERS, BIGINT_MAX_BITS } from "../src/core/gasmeter.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";

/*
 * แก๊สตามงานของ CPU: regex / BigInt ใหญ่ (src/core/gasmeter.js · src/core/sandbox.js "BigInt: แก๊สตามงานของ CPU")
 * เดิม regex แบบ backtrack ทวีคูณ และ BigInt ใหญ่ (2n ** 10n ** 9n, toString ของ 300k bit) เผา CPU เป็นวินาทีด้วยแก๊สหลักร้อย
 *   หยุดได้แค่ timeout ตามเวลาจริง (ผลไม่แน่นอนข้ามเครื่อง)
 * ตอนนี้: regex ปิดทั้งหมด · BigInt คิดแก๊สตามขนาด (คิดก่อนทำสำหรับ ** << และการแปลง string) · เพดาน 8192 bit
 *   ค่า ≤ 512 bit ไม่คิดเพิ่ม → แก๊สของโปรแกรมเดิม (token / uint256) เท่าเดิม
 */

const T = 1_700_000_000_000;
const as = (who) => ({ sender: who, origin: who });
const TIMEOUT_MS = 20_000;
const FAST_MS = 3_000;   // หยุดด้วยแก๊สเร็วกว่า timeout มาก (เดิมแต่ละกรณีใช้ ≥ 1 วินาทีหรือ timeout)

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

const TYPE_ERROR = "โปรแกรมทำงานผิดพลาด (TypeError)";
const RANGE_ERROR = "โปรแกรมทำงานผิดพลาด (RangeError)";

test("regex: literal ถูกปฏิเสธตอน deploy · RegExp / match / search / matchAll / species ใช้ไม่ได้แม้ปิด autoreview · replace / split ด้วย string ยังได้", () => {
  const { vm, activate, call } = setup({ maxTxGas: 3_000_000 });
  const literal = vm.deploy({ programUuid: "lit", code: program({ f: "return /(a+)+$/.test('a')" }), context: as("owner") }, { timestamp: T });
  assert.equal(literal.status, "throw");
  assert.match(literal.error.message, /regular expression ใช้ในโปรแกรมไม่ได้/);

  const evil = `const s = "a".repeat(30) + "b";`;   // (a+)+$ กับ a×30 + b = backtrack ~2^30 ขั้น (เดิม ~2 วินาทีที่ 24 ตัว)
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

test("BigInt ใหญ่หมดแก๊สเร็ว (คิดก่อนคำนวณ) แทนที่จะรอ timeout", () => {
  const { activate, call } = setup({ maxTxGas: 3_000_000 });
  const prep = `const B = (1n << 8191n) - 12345n; const H = (1n << 4095n) - 77n; const S = String(B); const o = {}; let sink;`;
  const attacks = {
    powHuge: "sink = 2n ** 1000000000n",          // เดิม: คำนวณจริงจน RangeError / timeout
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
  // ** ที่ผลลัพธ์เกินเพดานแน่นอนคิดแก๊สทั้งก้อนก่อนคำนวณ → 2n ** 10n ** 9n หมดแก๊สในครั้งเดียว
  assert.ok(call("big", "powHuge").gasUsed > 1e14);
});

test("เพดาน BigInt 8192 bit: literal ใหญ่ถูกปฏิเสธ · ผลเกินเพดาน RangeError · ค่าที่พอดีเพดานใช้ได้", () => {
  assert.equal(BIGINT_MAX_BITS, 8192);
  const { vm, activate, call } = setup();
  const lit = vm.deploy({ programUuid: "lit", code: program({ f: `return 0x${"f".repeat(2049)}n` }), context: as("owner") }, { timestamp: T });
  assert.equal(lit.status, "throw");
  assert.match(lit.error.message, /BigInt ใหญ่เกิน 8192 bit/);
  activate("cap", program({
    max: "const m = ((1n << 8191n) - 1n) * 2n + 1n; return BigInt(m.toString(16).length)",   // 2^8192 − 1 (1n << 8192n เองเกินแล้ว)
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

test("ราคา BigInt ตามสูตร: ×  ⌈Wa·Wb/4⌉ · ÷ %  ⌈(Wa−Wb+1)·Wb/4⌉ · ** ⌈Wr²/4⌉ · → string W² · string → BigInt W² · ค่า ≤ 512 bit ไม่คิดเพิ่ม", () => {
  const { activate, call } = setup();
  // A = k bit, B = 2k−1 bit · เทียบแก๊สของ op กับ base ที่เตรียมข้อมูลเหมือนกัน แล้วหักส่วนที่เป็นค่าเล็ก (k = 8) → เหลือราคาตามขนาดล้วน
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

  // ≤ 512 bit (uint256 × uint256 ไม่ถึง) → ไม่คิดเพิ่ม
  for (const fn of ["mul", "div", "mod", "add", "str", "parse", "lt"]) assert.equal(price(fn, 200), 0, fn);
  const k = 2048;   // A = 32 word, B = 4095 bit = 64 word
  assert.equal(price("mul", k), Math.ceil(32 * 32 / 4));                  // 256
  assert.equal(price("div", k), Math.ceil((64 - 32 + 1) * 32 / 4));       // 264
  assert.equal(price("mod", k), Math.ceil((64 - 32 + 1) * 32 / 4));
  assert.equal(price("add", k), 64);                                       // ≥ 2^1024: 64 (เส้นตรง)
  assert.equal(price("str", k), 64 * 64);                                  // 4096
  // 1233 หลัก → 65 word → 4225 · บวกค่าแปลงผลลัพธ์ใหญ่ 64² (BigInt ถูกเรียกจาก engine ได้ เช่น { toString: BigInt.bind(…) })
  assert.equal(price("parse", k), Math.ceil(digits(k) / 19) ** 2 + 64 * 64);
  assert.equal(price("lt", k), 0);                                         // เทียบค่าไม่คิดเพิ่ม (งานเส้นตรงเร็วมาก)
  // ** คิดจากขนาดผลลัพธ์ก่อนคำนวณ: 3 = 2 bit → 3n ** 2k ≤ 4k bit
  const powUnits = (bits) => { const w = words(2 * 2 * bits); return w > 8 ? Math.max(16, Math.ceil(w * w / 4)) : 0; };
  assert.equal(price("pow", 1500), powUnits(1500) - powUnits(8));
  assert.equal(words(4095), 64);
});

test("แก๊สแน่นอน: งาน BigInt / string / หมดแก๊ส ได้แก๊สเท่ากันทุกครั้ง ทุก VM", () => {
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

test("token transfer ทำงานเหมือนเดิม แก๊สเท่าเดิม (ค่า uint256 ไม่ถูกคิดเพิ่ม)", () => {
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
  // ตัวเลขเดียวกับก่อนเปลี่ยน (main 90facdb) — ค่า uint256 อยู่ในช่วง ≤ 512 bit ที่ไม่คิดเพิ่ม · บวก stateKey ของ balance 2 key (ผู้ส่ง / ผู้รับ)
  const { stateKey } = VM.DEFAULT_GAS;
  assert.equal(send(1000n), 2722 + 2 * stateKey);
  assert.equal(send(2n ** 254n + 12345n), 2875 + 2 * stateKey);
  const approve = vm.call({ programUuid: TOKEN, functionName: "approve", input: { spender: BOB, amount: String(2n ** 256n - 1n) + "n" }, context: as(OWNER) }, { timestamp: T });
  assert.equal(approve.gasUsed, 1979 + stateKey);   // allowance 1 key
  const balance = vm.call({ programUuid: TOKEN, functionName: "balanceOf", input: { who: BOB }, context: as(OWNER) }, { timestamp: T });
  assert.equal(balance.result, String(2n ** 254n + 12345n + 1000n) + "n");
});

test("number ไม่เปลี่ยนราคา · โค้ดที่แปลง operator / compound / key / return ให้ผลเหมือน JavaScript เดิมทุกกรณี", () => {
  // แก๊สของ number: 1 ต่อ node เหมือนเดิม (ตัวช่วย operator ไม่คิดแก๊สเอง)
  let gas = 0;
  const helpers = { ...PLAIN_HELPERS, __gas: (n) => { gas += n; } };
  const run = (body) => new Function(...METER_FNS, instrument(body))(...METER_FNS.map((name) => helpers[name]));
  const gasOf = (body) => { gas = 0; const result = run(body); return [String(result), gas]; };
  // ตัวเลขเดียวกับก่อนเปลี่ยน (main 90facdb)
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
