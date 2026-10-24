import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";

/*
 * แก๊สตามขนาดข้อมูลที่ถูกคัดลอก / สร้าง (src/core/sandbox.js "แก๊สตามขนาดข้อมูล" · src/core/gasmeter.js)
 *   builtin 1 gas ต่อหน่วย · 1 หน่วย = 1 สมาชิก (array / property / Set / Map / argument) หรือ 32 ตัวอักษร / byte (ปัดขึ้น)
 * เดิม [...a, ...a] / f(...a) / { ...o } / a + "" คิดแค่ 1 gas ต่อ node → ลูปทวีคูณจองหน่วยความจำ 32 MB ได้ด้วย ~230 gas
 * เทสต์คิดส่วนต่างของแก๊สระหว่างข้อมูล n กับ 2n ตัว (ส่วนคงที่ของโค้ดหักล้างกันหมด) → เห็นราคาต่อหน่วยตรง ๆ
 */

const T = 1_700_000_000_000;
const as = (who) => ({ sender: who, origin: who });
const units = (length) => Math.ceil(length / 32);   // 32 ตัวอักษร / byte = 1 หน่วย

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

/** โปรแกรมที่ทุกฟังก์ชันสร้างข้อมูลขนาด n ก่อน (prepare) แล้วทำ op หนึ่งอย่าง */
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

/** แก๊สที่ op ใช้เพิ่มเมื่อข้อมูลโตจาก n เป็น 2n (หักส่วนที่ prepare ใช้แล้ว) */
function perGrowth(call, uuid, name, n) {
  const gas = (fn, size) => {
    const res = call(uuid, fn, { n: `${size}n` });
    assert.equal(res.status, "success", `${name}(${size}): ${JSON.stringify(res.error)}`);
    return res.gasUsed;
  };
  return (gas(name, 2 * n) - gas(name, n)) - (gas("base", 2 * n) - gas("base", n));
}

test("ลูป [...a, ...a] ทวีคูณ: แก๊สโตตามจำนวนสมาชิก · หมดแก๊ส (OUT_OF_GAS) ก่อนถึงเพดานหน่วยความจำ 32 MB", () => {
  const code = `function program() {
    function double(params) { let a = [1n]; for (let i = 0n; i < params.input.k; i++) a = [...a, ...a]; return BigInt(a.length) }
    function keep(params) { let a = [1n]; const all = []; for (let i = 0n; i < params.input.k; i++) { a = [...a, ...a]; all.push(a) } return BigInt(a.length) }
    return { double, keep }
  }`;
  const { activate, call } = setup({ maxTxGas: 3_000_000 });   // เพดานต่อ tx เท่า server
  activate("lab", code);
  const gas = (k) => call("lab", "double", { k: `${k}n` }).gasUsed;
  // รอบที่ k คัดลอก 2^k สมาชิก → ส่วนต่างของส่วนต่าง = 2^k พอดี (โค้ดต่อรอบเท่าเดิม)
  const [g10, g11, g12] = [gas(10), gas(11), gas(12)];
  assert.equal((g12 - g11) - (g11 - g10), 2 ** 12 - 2 ** 11);
  assert.ok(g12 - g11 > 2 ** 12, "รอบที่ 12 ต้องคิดอย่างน้อย 4,096 (จำนวนสมาชิกที่คัดลอก)");
  // 2^20 สมาชิก (~8 MB) ใช้ ~2.1M gas · 2^21 ต้องใช้อีก 2.1M → หมดแก๊สที่ 3M ก่อนจองถึง 32 MB
  const twenty = call("lab", "double", { k: "20n" });
  assert.equal(twenty.status, "success");
  assert.ok(twenty.gasUsed > 2 ** 21 && twenty.gasUsed < 2 ** 21 + 10_000, String(twenty.gasUsed));
  const runaway = call("lab", "double", { k: "64n" });
  assert.equal(runaway.error.code, "OUT_OF_GAS");          // เดิม: OUT_OF_MEMORY ที่ ~230 gas
  assert.ok(runaway.gasUsed > 3_000_000);
  // เก็บทุกก้อนไว้ (แบบกับดักเดิมของ GAS_LAB_PROGRAM) ก็หมดแก๊สก่อนเช่นกัน
  assert.equal(call("lab", "keep", { k: "64n" }).error.code, "OUT_OF_GAS");
});

test("spread / rest ของ array: 1 หน่วยต่อสมาชิก ([...a] · f(...a) · new F(...a) · apply · const [x, ...r] = a · Set / Map)", () => {
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
    mapCtor: 2 * n + n,    // Object.entries (เข้า n + ออก n) + Map n
    arrayFrom: 2 * n,      // ข้อมูลเข้า n + ผลลัพธ์ n
    arrayOnly: 0,          // Array(n) ไม่จองที่ให้สมาชิก (QuickJS) → ไม่คิด · fill / spread / map … คิดตาม length ตอนใช้
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(perGrowth(call, "arr", name, n), expected, name);
});

test("{ ...o } และ const { a, ...rest } = o: 1 หน่วยต่อ property ที่ถูกคัดลอก", () => {
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

test("เมธอดของ array คิดเท่ากันทุกทางที่เรียก (.call / Reflect.apply / เก็บใส่ตัวแปร / แปลงเป็น string โดยนัย)", () => {
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
  // "7,7,…" ยาว 2n − 1 ตัวอักษร
  const joined = n + units(2 * (2 * n) - 1) - units(2 * n - 1);   // ข้อมูลเข้า n สมาชิก + ผลลัพธ์ (ต่อ 32 ตัวอักษร)
  const cases = {
    join: joined, joinCall: joined, joinReflect: joined, joinAlias: joined,
    toStringImplicit: joined + units(4 * n - 1) - units(2 * n - 1),   // + string ที่ได้จาก a + ''
    template: n + joined + (units(4 * n - 1) - units(2 * n - 1)),       // "".concat(a): เข้า a (n สมาชิก) → join ข้างใน → ออก
    stringCall: joined,
    stringify: 3 * n + units(4 * n + 1) - units(2 * n + 1),            // "[7,7,…]" + 2 หน่วยต่อค่าที่แปลง (เทสต์ 88)
    keys: 2 * n, slice: 2 * n, concat: 4 * n, fill: 2 * n, toSorted: 2 * n, reverse: 2 * n,
    flat: 2 * n,                     // สมาชิกที่ไล่ทุกชั้น (เทสต์ 88) + ผลลัพธ์
    splice: n, fromLength: n,
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(perGrowth(call, "methods", name, n), expected, name);
});

test("string: ต่อด้วย + / += / template · repeat / padEnd / split / replaceAll / concat คิด 1 หน่วยต่อ 32 ตัวอักษร", () => {
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
  const n = 32_000;   // 1,000 หน่วย
  const u = units(n);
  const cases = {
    plus: 2 * u, plusAssign: 2 * u,
    template: 2 * u + 2 * u,         // QuickJS สร้าง template ด้วย "".concat(…) → เข้า s + s · ออก 2n ตัวอักษร
    concat: 2 * u + 2 * u,           // เข้า s + s · ออก 2n ตัวอักษร
    upper: 2 * u,
    padEnd: u + 2 * u,               // เข้า s · ผลลัพธ์ 2n ตัวอักษรคิดก่อนสร้าง
    replaceAll: u + 2 * u,
    split: u + n,                    // ผลลัพธ์ = n สมาชิก
    repeatCall: 2 * u,               // "ab" × n = 2n ตัวอักษร คิดก่อนสร้าง
    parse: 2 * u + 3 * u,            // stringify (เข้า + ออก) + parse (เข้า + ออก + งานแปลงต่อตัวอักษร เทสต์ 88)
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(perGrowth(call, "text", name, n), expected, name);
});

test("ArrayBuffer / typed array คิดตามขนาดที่จอง · คิดก่อนจองจึงหยุดได้ก่อนสร้างข้อมูล · RegExp ปิด (เทสต์ 81)", () => {
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
  assert.equal(perGrowth(call, "bytes", "bytes", n), n);                // typed array = 1 หน่วยต่อสมาชิก
  assert.equal(perGrowth(call, "bytes", "words", n), n);
  assert.equal(perGrowth(call, "bytes", "copy", n), 2 * n + n);          // fill (เข้า + ออก) + สมาชิกที่คัดลอก
  // RegExp ถูกปิดทั้งหมด (backtrack คิดแก๊สล่วงหน้าไม่ได้ — ดูเทสต์ 81) เดิม: คิดตามความยาว pattern
  assert.equal(call("bytes", "regexp", { n: "10n" }).error.message, "โปรแกรมทำงานผิดพลาด (TypeError)");
  const started = Date.now();
  assert.equal(call("bytes", "buffer", { n: "2000000000n" }).error.code, "OUT_OF_GAS");   // ไม่ได้จองจริง
  assert.equal(call("bytes", "bytes", { n: "100000000n" }).error.code, "OUT_OF_GAS");
  assert.ok(Date.now() - started < 1000);
});

test("ช่องทางเลี่ยง: iterator ที่สร้างก่อนข้อมูลโต · Proxy ที่ ownKeys ตอบไม่เหมือนกัน · แก้ iterator ในตัว", () => {
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
  // iterator สร้างตอน array ยังว่าง แล้วค่อยเติม → [...it] ยังถูกคิดต่อสมาชิก
  assert.equal(perGrowth(call, "tricks", "staleIterator", 1000), 1000);
  // copy ของ Proxy ถาม ownKeys ครั้งเดียว (ตามมาตรฐาน) แล้วคิดตามคำตอบนั้น — engine ไม่ได้ถามซ้ำให้ตอบอีกแบบ
  assert.deepEqual(call("tricks", "lyingProxy").result, ["0n", "1n"]);
  assert.deepEqual(call("tricks", "patchIterator").result, "TypeError");
  assert.deepEqual(call("tricks", "patchNext").result, "TypeError");
  // ตัวห่อดูเหมือนของจริง (ชื่อ / length / toString)
  assert.deepEqual(call("tricks", "nativeLook").result, ["function join() {\n    [native code]\n}", "join", "1n", "1n"]);
});

test("...rest ในตำแหน่งที่คิดแก๊สไม่ได้ (พารามิเตอร์ / for…of / catch / ซ้อน) → deploy ไม่ผ่าน · function f(...args) ใช้ได้", () => {
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

test("input / ผลของ runProgram คิดตามขนาด JSON (1 หน่วยต่อ 32 byte ทั้งขาไปและขากลับ)", () => {
  const { activate, call } = setup();
  activate("echo", "function program() { function echo(params) { return params.input.text } return { echo } }");
  activate("caller", `function program() {
    function base(params) { const text = "x".repeat(Number(params.input.n)); return 1n }
    function relay(params) { const text = "x".repeat(Number(params.input.n)); runProgram("echo", "echo", { text: text }); return 1n }
    return { base, relay }
  }`);
  const n = 32_000;
  // {"text":"xxx…"} ขาไป + "xxx…" ขากลับ: ส่วนที่โตตาม n = 2 × n byte
  assert.equal(perGrowth(call, "caller", "relay", n), units(2 * n + 11) - units(n + 11) + units(2 * n + 2) - units(n + 2));
});

test("หน่วยความจำเกิน (OUT_OF_MEMORY) เสียค่าแก๊สของงานที่ทำไปจริง ไม่ใช่แค่ส่วนที่ส่งให้ host แล้ว", () => {
  const { activate, call } = setup({ maxTxGas: 3_000_000 });
  activate("mem", `function program() {
    function grow() { const keep = []; while (true) keep.push("x".repeat(1048576)) }
    return { grow }
  }`);
  const res = call("mem", "grow");
  assert.equal(res.error.code, "OUT_OF_MEMORY");
  assert.ok(res.gasUsed > 900_000 && res.gasUsed < 1_200_000, String(res.gasUsed));   // ≈ 32 MB ÷ 32 = 1M หน่วย
});

test("ผลเหมือนเดิมทุกครั้ง (คิดแก๊สตามขนาดข้อมูลไม่ขึ้นกับเครื่อง)", () => {
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
