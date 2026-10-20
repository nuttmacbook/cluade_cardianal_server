import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY } from "./helpers.js";
import { sandboxStats, sandboxMemoryBytes } from "../src/core/sandbox.js";

/* sandbox ของโปรแกรม (QuickJS ใน WebAssembly — src/core/sandbox.js): หน่วยความจำ / stack / การแยกจาก host / การเก็บกวาด */

const T = 1_700_000_000_000;
const as = (who) => ({ sender: who, origin: who });
const MB = 1024 * 1024;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, ...options });
  const run = (request) => {
    const res = vm.call(request, { timestamp: T });
    if (res.status === "success") vm.commit(res.writes);
    return res;
  };
  const activate = (programUuid, code) => {
    vm.commit(vm.deploy({ programUuid, code, context: as("owner") }, { timestamp: T }).writes);
    const init = vm.init({ programUuid }, { timestamp: T });
    assert.equal(init.status, "success", JSON.stringify(init.error));
    vm.commit(init.writes);
  };
  const call = (programUuid, functionName, input = {}) => run({ programUuid, functionName, input, context: as("alice") });
  return { vm, activate, call };
}

const HOG = `function program() {
  function fill(n) { const list = []; for (let i = 0; i < n; i++) list.push([i, "block " + i, { i }]); return list }
  function hog() { writeDB("before", 1n); const keep = []; while (true) keep.push(fill(1000)) }
  function hogCaught() { try { hog() } catch (e) { writeDB("caught", String(e)); return "caught" } }
  function hogFinally() { try { hog() } finally { writeDB("finally", 1n); return "finally" } }
  function nested(params) { try { return runProgram(params.input.target, "hog", {}) } catch (e) { return "caught nested" } }
  function some(params) { return BigInt(fill(Number(params.input.n)).length) }
  function half(params) { const keep = fill(Number(params.input.n)); return [BigInt(keep.length), runProgram(params.input.target, "some", { n: params.input.n })] }
  return { hog, hogCaught, hogFinally, nested, some, half }
}`;

test("หน่วยความจำเกินกำหนด → OUT_OF_MEMORY ทั้ง tx ล้ม catch / finally ไม่ได้ ไม่มี writes", () => {
  const { activate, call } = setup({ gas: API_GAS_ONLY, memoryLimitBytes: 4 * MB });
  activate("hog", HOG);
  activate("other", HOG);
  for (const name of ["hog", "hogCaught", "hogFinally"]) {
    const res = call("hog", name);
    assert.equal(res.status, "throw", name);
    assert.equal(res.error.code, "OUT_OF_MEMORY", name);
    assert.match(res.error.message, /หน่วยความจำเกินกำหนด \(4194304 ไบต์ต่อ tx\)/);
    assert.deepEqual(res.writes, [], name);
  }
  // โปรแกรมซ้อนใช้เกิน → ผู้เรียก catch ไม่ได้เช่นกัน
  const nested = call("hog", "nested", { target: "other" });
  assert.equal(nested.error.code, "OUT_OF_MEMORY");
  assert.deepEqual(nested.calls.map((c) => c.error?.code), ["OUT_OF_MEMORY", "OUT_OF_MEMORY"]);
  // tx ถัดไปเริ่มใหม่ได้เต็มกำหนด
  assert.equal(call("hog", "some", { n: 1000 }).result, "1000n");
});

test("หน่วยความจำนับรวมทั้งสายการเรียก และจุดที่เกินแน่นอนทุกครั้ง (แก๊สเท่ากัน)", () => {
  const { activate, call } = setup({ memoryLimitBytes: 4 * MB, maxTxGas: 50_000_000 });
  activate("hog", HOG);
  activate("other", HOG);
  // แต่ละฝั่งใช้ไม่ถึงกำหนด แต่รวมกันเกิน
  assert.equal(call("hog", "some", { n: 12000 }).status, "success");
  const both = call("hog", "half", { n: 12000, target: "other" });
  assert.equal(both.error.code, "OUT_OF_MEMORY");
  // เกินที่จุดเดียวกันทุกครั้ง ไม่ว่าก่อนหน้านั้น memory ของ WebAssembly จะเคยโตไปแค่ไหน
  const first = call("hog", "hog");
  call("hog", "some", { n: 40000 });   // tx อื่นคั่น (ใช้หน่วยความจำมาก แต่ไม่เกิน)
  const second = call("hog", "hog");
  assert.equal(first.error.code, "OUT_OF_MEMORY");
  assert.equal(second.gasUsed, first.gasUsed);
});

test("หน่วยความจำเกินใน block: เข้า block และเสียค่าแก๊สเหมือนแก๊สหมด", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true, recordBlocks: true, timeoutMs: 5000, memoryLimitBytes: 4 * MB });
  vm.db.load({ "alice:native:received": "100000000n" });
  const plain = new VM.VirtualMachine(vm.db);
  plain.commit(plain.deploy({ programUuid: "hog", code: HOG, context: as("owner") }, { timestamp: T }).writes);
  plain.commit(plain.init({ programUuid: "hog" }, { timestamp: T }).writes);
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  const res = block.call({ programUuid: "hog", functionName: "hogCaught", context: as("alice"), nonce: 0 });
  block.commit();
  assert.equal(res.error.code, "OUT_OF_MEMORY");
  assert.equal(res.accepted, true);
  assert.ok(res.gasUsed > 0);
  assert.equal(vm.nativeBalanceOf("alice").balance, 100000000n - BigInt(res.gasUsed) * BigInt(vm.gas.price));
  assert.equal(vm.getBlock(1).txCount, 1);
  assert.equal(vm.db.readKeys(["hog:storage:caught"])[0], undefined);
});

test("stack ล้น → PROGRAM_ERROR (RangeError) ที่โปรแกรม catch ได้แล้วทำงานต่อได้", () => {
  const { activate, call } = setup({ gas: API_GAS_ONLY });
  activate("deep", `function program() {
    function down(n) { return down(n + 1) + 1 }
    function overflow() { return down(0) }
    function recover() { try { down(0) } catch (e) { return [e instanceof RangeError, String(e.name), BigInt([1, 2, 3].length)] } }
    function depth() { let max = 0; function go(n) { max = n; go(n + 1) } try { go(0) } catch (e) {} return BigInt(max) }
    return { overflow, recover, depth }
  }`);
  const res = call("deep", "overflow");
  assert.equal(res.error.code, "PROGRAM_ERROR");
  assert.equal(res.error.message, "โปรแกรมทำงานผิดพลาด (RangeError)");
  assert.deepEqual(call("deep", "recover").result, [false, "InternalError", "3n"]);
  const depth = Number(call("deep", "depth").result.slice(0, -1));
  assert.ok(depth > 500, `ซ้อนได้ ${depth} ชั้น`);
});

test("โปรแกรมเข้าถึง host ไม่ได้: ไม่มี process / require / globalThis ของ Node / Function constructor / eval", () => {
  const { activate, call } = setup({ gas: API_GAS_ONLY });
  activate("probe", `function program() {
    function attempt(fn) { try { const value = fn(); return typeof value === "function" ? "function" : typeof value === "object" && value !== null ? "object" : String(value) } catch (e) { return "blocked:" + e.name } }
    function globals() {
      return {
        process: typeof process, require: typeof require, module: typeof module, Buffer: typeof Buffer,
        setTimeout: typeof setTimeout, fetch: typeof fetch, WebAssembly: typeof WebAssembly, host: typeof host,
        globalProcess: typeof globalThis.process, names: Object.getOwnPropertyNames(globalThis).filter((n) => /^(process|require|host|Buffer|global|module|exports)$/.test(n)),
        thisValue: typeof this,
      }
    }
    function escapes() {
      return {
        Function: attempt(() => Function("return globalThis.process")()),
        newFunction: attempt(() => new Function("return 1")),
        viaPrototype: attempt(() => (function () {}).constructor("return this")()),
        viaArray: attempt(() => [].constructor.constructor("return this")()),
        viaApi: attempt(() => readDB.constructor("return this")()),
        viaApiProto: attempt(() => Object.getPrototypeOf(writeDB).constructor("return 1")()),
        async: attempt(() => Object.getPrototypeOf(async function () {}).constructor("return 1")),
        generator: attempt(() => Object.getPrototypeOf(function* () {}).constructor("yield 1")),
        eval: attempt(() => eval("1 + 1")),
        indirectEval: attempt(() => (0, globalThis.eval)("1 + 1")),
        hostError: attempt(() => { try { readDB({}) } catch (e) { return e.constructor.constructor("return this")() } }),
        hostErrorKeys: (() => { try { readDB({}) } catch (e) { return Object.keys(e).join(",") } })(),
      }
    }
    return { globals, escapes }
  }`);
  assert.deepEqual(call("probe", "globals").result, {
    process: "undefined", require: "undefined", module: "undefined", Buffer: "undefined",
    setTimeout: "undefined", fetch: "undefined", WebAssembly: "undefined", host: "undefined",
    globalProcess: "undefined", names: [], thisValue: "object",
  });
  const blocked = "blocked:EvalError";
  assert.deepEqual(call("probe", "escapes").result, {
    Function: blocked, newFunction: blocked, viaPrototype: blocked, viaArray: blocked, viaApi: blocked,
    viaApiProto: blocked, async: blocked, generator: blocked, eval: blocked, indirectEval: blocked,
    hostError: blocked, hostErrorKeys: "code",
  });
});

test("แก๊สหมด / หมดเวลา: โปรแกรม catch ไม่ได้ทั้งชั้นเดียวกันและชั้นที่เรียกซ้อน", () => {
  const code = `function program() {
    function spin() { while (true) {} }
    function swallow() { while (true) { try { spin() } catch (e) {} } }
    function nested(params) { try { runProgram(params.input.target, "spin", {}) } catch (e) { return "caught" } return "after" }
    return { spin, swallow, nested }
  }`;
  const gas = setup({ maxTxGas: 100_000 });
  gas.activate("loop", code);
  gas.activate("other", code);
  for (const [name, input] of [["swallow", {}], ["nested", { target: "other" }]]) {
    const res = gas.call("loop", name, input);
    assert.equal(res.error.code, "OUT_OF_GAS", name);
    assert.ok(res.gasUsed >= 100_000, name);
  }
  const time = setup({ timeoutMs: 100, maxTxGas: Infinity });
  time.activate("loop", code);
  time.activate("other", code);
  for (const [name, input] of [["swallow", {}], ["nested", { target: "other" }]]) {
    const started = Date.now();
    const res = time.call("loop", name, input);
    assert.equal(res.error.code, "TIMEOUT", name);
    assert.ok(Date.now() - started < 2000, name);
  }
});

test("โปรแกรมแยกจากกัน: global / prototype ที่แก้ไม่รั่วไปโปรแกรมอื่น และไม่ค้างข้าม tx · ตัวแปรระดับบนสุดไม่ค้างข้าม call", () => {
  const { activate, call } = setup({ gas: API_GAS_ONLY });
  const code = `function program() {
    let counter = 0;
    function look() { return { shared: typeof globalThis.shared, polluted: typeof ({}).polluted, push: [].push === Array.prototype.push && typeof Array.prototype.patched } }
    function pollute(params) {
      globalThis.shared = 1; Object.prototype.polluted = 1; Array.prototype.patched = 1;
      const self = look();
      const other = runProgram(params.input.target, "look", {});
      return { self, other }
    }
    function count() { counter += 1; return BigInt(counter) }
    function countTwice(params) { return [runProgram(params.input.target, "count", {}), runProgram(params.input.target, "count", {})] }
    return { look, pollute, count, countTwice }
  }`;
  activate("a", code);
  activate("b", code);
  assert.deepEqual(call("a", "pollute", { target: "b" }).result, {
    self: { shared: "number", polluted: "number", push: "number" },
    other: { shared: "undefined", polluted: "undefined", push: "undefined" },
  });
  // tx ถัดไป: โปรแกรมเดิมไม่เห็นสิ่งที่ตัวเองแก้ไว้
  assert.deepEqual(call("a", "look").result, { shared: "undefined", polluted: "undefined", push: "undefined" });
  assert.deepEqual(call("a", "countTwice", { target: "b" }).result, ["1n", "1n"]);
  assert.equal(call("b", "count").result, "1n");
});

test("ค่าข้ามเขตแดน: BigInt / object ซ้อน / null ไปกลับครบ · function / symbol ถูกปฏิเสธ", () => {
  const { activate, call } = setup({ gas: API_GAS_ONLY });
  activate("echo", `function program() {
    function echo(params) { return params.input }
    function relay(params) { return runProgram(params.input.target, "echo", params.input.value) }
    function store(params) { writeDB("v", params.input.value); return readDB("v") }
    function badFunction() { writeDB("f", () => 1) }
    function badSymbol() { writeDB("s", Symbol("x")) }
    function badReturn() { return { f() {} } }
    return { echo, relay, store, badFunction, badSymbol, badReturn }
  }`);
  const value = { big: "123456789012345678901234567890n", list: ["one", "two", null, { deep: [true, "-5n"] }], empty: {}, nothing: null };
  assert.deepEqual(call("echo", "echo", value).result, value);
  assert.deepEqual(call("echo", "relay", { target: "echo", value }).result, value);
  assert.deepEqual(call("echo", "store", { value }).result, value);
  assert.equal(call("echo", "badFunction").error.message, "ค่าที่ writeDB ต้องเป็นข้อมูล JSON");
  assert.equal(call("echo", "badSymbol").error.message, "ค่าที่ writeDB ต้องเป็นข้อมูล JSON");
  assert.equal(call("echo", "badReturn").error.message, "ค่าที่ return ต้องเป็นข้อมูล JSON");
});

test("คืน handle / context ครบ: เรียกหลายพันครั้งแล้วหน่วยความจำไม่โต (รวม tx ที่ใช้โปรแกรมเกินจำนวน context ที่เตรียมไว้)", () => {
  const { activate, call } = setup({ maxCallDepth: 16 });
  activate("token", `function program() {
    function transfer(params) {
      const from = readDB(map("balance", params.context.sender)) ?? 1000000n;
      writeDB(map("balance", params.context.sender), from - 1n);
      emit("Transfer", { amount: 1n });
      return from - 1n
    }
    function chain(params) { const rest = params.input.rest; return rest.length === 0 ? 0n : 1n + runProgram(rest[0], "chain", { rest: rest.slice(1) }) }
    return { transfer, chain }
  }`);
  const names = Array.from({ length: 12 }, (_, i) => `link${i}`);
  for (const name of names) activate(name, `function program() {
    function chain(params) { const rest = params.input.rest; return rest.length === 0 ? 0n : 1n + runProgram(rest[0], "chain", { rest: rest.slice(1) }) }
    return { chain }
  }`);
  // 12 โปรแกรมใน tx เดียว (มากกว่า context ที่เตรียมไว้ 8 ตัว)
  assert.equal(call("token", "chain", { rest: names }).result, "12n");
  for (let i = 0; i < 100; i++) call("token", "transfer");
  const memory = sandboxMemoryBytes();
  const before = sandboxStats.transactions;
  for (let i = 0; i < 3000; i++) {
    const res = call("token", "transfer");
    assert.equal(res.status, "success");
    if (i % 500 === 0) assert.equal(call("token", "chain", { rest: names }).result, "12n");
  }
  assert.ok(sandboxStats.transactions - before >= 3000);
  assert.deepEqual({ active: sandboxStats.active, extraContexts: sandboxStats.extraContexts, handles: sandboxStats.handles },
    { active: 0, extraContexts: 0, handles: 0 });
  assert.equal(sandboxMemoryBytes(), memory);
  assert.equal(call("token", "transfer").result, `${1000000 - 3101}n`);
});

test("ตั้งขนาดหน่วยความจำ / stack นอกช่วงที่รองรับไม่ได้", () => {
  assert.throws(() => new VM.VirtualMachine(new MemoryDB(), { maxStackBytes: 1024 * 1024 }), /maxStackBytes ต้องเป็นจำนวนเต็มระหว่าง 16384 ถึง 262144/);
  assert.throws(() => new VM.VirtualMachine(new MemoryDB(), { memoryLimitBytes: 1000 }), /memoryLimitBytes/);
  assert.throws(() => new VM.VirtualMachine(new MemoryDB(), { memoryLimitBytes: 4 * MB + 0.5 }), /memoryLimitBytes/);
});
