/**
 * fuzz เขตแดนระหว่างโปรแกรม (QuickJS) กับ host — สุ่มค่าแปลก ๆ ส่งเข้า API ทุกตัว / คืนจากฟังก์ชัน / ส่งเป็น input
 *
 *   npm run fuzz                                   # 2,000 รอบ seed สุ่ม
 *   npm run fuzz -- --iterations 20000 --seed 42   # ทำซ้ำรอบที่ล้มได้ด้วย seed เดิม
 *
 * กติกาที่ต้องจริงทุกรอบ (ผิดข้อเดียว = รายงาน seed + โค้ดของรอบนั้น แล้ว exit 1)
 *   1. VM ไม่ throw ออกมาถึงผู้เรียก · status เป็น success / throw · error ไม่ใช่ INTERNAL (= host พัง ไม่ใช่โปรแกรมผิด)
 *   2. deterministic: รันซ้ำบน VM ใหม่ได้ status / gasUsed / result / writes / events เหมือนเดิมทุกไบต์
 *   3. host ไม่ถูกแตะ: Object.prototype / Array.prototype / globalThis ไม่มีอะไรเพิ่ม · ค่าที่ได้จากโปรแกรมเป็นข้อมูลล้วน (ไม่มี function / prototype แปลก)
 *   4. sandbox ยังใช้ต่อได้: หลังรอบที่ล้ม (รวม OUT_OF_MEMORY / OUT_OF_GAS) tx ปกติถัดไปได้ผลเดิม
 */
import { VirtualMachine, ERROR_CODE } from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js";
import { decodeFromGuest, encodeForGuest } from "../src/core/sandbox.js";

/** PRNG ที่ทำซ้ำได้ (mulberry32) */
export function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (list) => list[Math.floor(next() * list.length)] };
}

// ค่าแปลกฝั่งโปรแกรม: เขียนเป็นโค้ด (รันใน sandbox) · depth จำกัดความลึกของค่าที่ซ้อน
const LEAVES = [
  "0n", "1n", "-1n", "(2n ** 255n)", "(-(2n ** 256n))", "(2n ** 8000n)", "0", "1.5", "-0", "NaN", "Infinity", "undefined", "null", "true", "false",
  '""', '"a"', '"\\u0000"', '"\\ud800"', '"__proto__"', '"constructor"', '"x:y"', '"0x" + "ab".repeat(32)', '"z".repeat(70000)', '"🙂".repeat(5)',
  "Symbol('s')", "(() => 1)", "function f() {}", "class {}", "new Date(0)", "new Map([[1n, 2n]])", "new Set([1n])", "new Uint8Array(4)", "new ArrayBuffer(8)",
  "new Error('e')", "Math", "JSON", "globalThis", "Object.prototype", "Array.prototype", "BigInt", "Proxy",
  "[]", "{}", "Object.create(null)", "Object.freeze({ a: 1n })", "[, , 1n]", "new Array(5)", '"0x"', '"0xzz"', '"0x" + "00".repeat(65)',
];
const KEYS = ['"a"', '"__proto__"', '"constructor"', '"prototype"', '"\\u0000"', '"toJSON"', '"0"', '"length"', '"valueOf"', '"toString"', '"x".repeat(2000)', "Symbol.iterator"];

export function guestValue(rng, depth = 0) {
  const roll = rng.int(depth > 2 ? 3 : 16);
  if (roll <= 2) return rng.pick(LEAVES);
  switch (roll) {
    case 3: return `[${Array.from({ length: rng.int(4) }, () => guestValue(rng, depth + 1)).join(", ")}]`;
    case 4: return `({ ${Array.from({ length: rng.int(4) }, () => `[${rng.pick(KEYS)}]: ${guestValue(rng, depth + 1)}`).join(", ")} })`;
    case 5: return `(() => { const o = {}; o.self = o; o.v = ${guestValue(rng, depth + 1)}; return o })()`;   // วน
    case 6: return `(() => { const a = []; a.push(a, ${guestValue(rng, depth + 1)}); return a })()`;
    case 7: return `({ get a() { throw new Error("getter") }, b: ${guestValue(rng, depth + 1)} })`;
    case 8: return `({ toJSON() { return ${guestValue(rng, depth + 1)} } })`;
    case 9: return `new Proxy(${rng.pick(["{}", "[]", "{ a: 1n }"])}, { ${rng.pick(["get() { throw new Error('trap') }", "ownKeys() { return ['a', 'a'] }",
      "getOwnPropertyDescriptor() { return { value: 1n, enumerable: true, configurable: true } }", "has() { return true }", "getPrototypeOf() { return Array.prototype }"])} })`;
    case 10: return `Object.defineProperty({}, ${rng.pick(KEYS)}, { enumerable: true, get() { return ${guestValue(rng, depth + 1)} } })`;
    case 11: return `Object.setPrototypeOf({ a: ${guestValue(rng, depth + 1)} }, ${rng.pick(["null", "Array.prototype", "Map.prototype", "Date.prototype"])})`;
    case 12: return `Object.assign([], { length: ${rng.pick(["3", "100000", "2 ** 31"])} })`;
    case 13: return `(() => { let o = ${guestValue(rng, depth + 1)}; for (let i = 0; i < ${rng.pick([10, 200, 5000])}; i++) o = [o]; return o })()`;   // ซ้อนลึก
    case 14: return `new (class X { constructor() { this.v = ${guestValue(rng, depth + 1)} } })()`;
    default: return `({ valueOf() { return 1n }, toString() { throw new Error("str") } })`;
  }
}

// API ในโปรแกรม (ชื่อ, จำนวน argument) — ทุกตัวต้องรับค่าแปลกได้โดย host ไม่พัง
const API = [
  ["readDB", 1], ["writeDB", 2], ["deleteDB", 1], ["map", 3], ["emit", 3], ["setMetadata", 2], ["keccak256", 1], ["ecrecover", 2],
  ["sha256", 1], ["ripemd160", 1], ["blake2b", 1], ["modexp", 3], ["keccak256Bytes", 1], ["ecrecoverDigest", 2],
  ["eip712Digest", 4], ["eip712DomainSeparator", 2], ["BalanceOf", 1], ["IsProgram", 1], ["MetadataOf", 2], ["BlockHash", 1],
  ["CodeHashOf", 1], ["CodeSizeOf", 1], ["runProgram", 4], ["transferNative", 2], ["cloneProgram", 3],
  ["ThisAddress", 0], ["ThisBalance", 0], ["BlockNumber", 0], ["ChainId", 0], ["Coinbase", 0], ["BlockGasLimit", 0], ["GasPrice", 0], ["BaseFee", 0], ["GasLeft", 0],
];

/** โปรแกรม 1 ตัวต่อรอบ: เรียก API แบบสุ่ม (catch ไว้เป็นส่วนใหญ่) แล้วคืนค่าแปลก */
export function guestProgram(rng) {
  const steps = Array.from({ length: 1 + rng.int(4) }, () => {
    const [name, arity] = rng.pick(API);
    const args = Array.from({ length: rng.int(arity + 2) }, () => guestValue(rng)).join(", ");
    const call = `${name}(${args})`;
    return rng.next() < 0.85 ? `try { out.push(${call}) } catch (e) { out.push(String(e && e.message).slice(0, 40)) }` : `out.push(${call})`;
  });
  const result = rng.next() < 0.5 ? "out" : guestValue(rng);
  return `function program() {
  function initialization(params) { writeDB("seed", 1n) }
  function fuzz(params) {
    const out = []
    ${steps.join("\n    ")}
    return ${result}
  }
  function echo(params) { return params.input }
  function ok(params) { writeDB("ok", (readDB("ok") || 0n) + 1n); return readDB("ok") }
  return { fuzz, echo, ok }
}`;
}

// ค่าแปลกฝั่ง host (ส่งเป็น input) — ข้ามเขตแดนเข้าไปเป็น JSON ติดป้าย
export function hostValue(rng, depth = 0) {
  const leaves = [0n, -1n, 2n ** 300n, "", "\u0000", "__proto__", "x".repeat(5000), null, true, undefined, 1, -0, NaN, Infinity, "1n"];
  const roll = rng.int(depth > 2 ? 2 : 6);
  if (roll <= 1) return rng.pick(leaves);
  if (roll === 2) return Array.from({ length: rng.int(4) }, () => hostValue(rng, depth + 1));
  if (roll === 3) return Object.fromEntries(Array.from({ length: rng.int(4) }, () => [rng.pick(["a", "__proto__", "\u0000", "constructor", "toJSON"]), hostValue(rng, depth + 1)]));
  if (roll === 4) return JSON.parse('{"__proto__": {"polluted": 1}, "x": 1}');
  return { [rng.pick(["\u0000", "b"])]: rng.pick(["b", "u", "x", "o"]), v: rng.pick(["1", "zz", [], [["a", 1]]]) };
}

const ALICE = "0x00000000000000000000000000000000000000a1";
const as = { sender: ALICE, origin: ALICE };
const T = Date.parse("2026-01-01T00:00:00Z");
const OPTIONS = { chargeGas: false, recordBlocks: true, maxTxGas: 2_000_000, timeoutMs: 20_000, memoryLimitBytes: 8 * 1024 * 1024 };

/** VM ใหม่ + deploy โปรแกรม → ผลของการเรียก fn (ตัดให้เหลือส่วนที่ต้องเหมือนกันทุกครั้ง) */
function runOnce(code, fn, input) {
  const vm = new VirtualMachine(new MemoryDB(), OPTIONS);
  vm.db.load({ [`${ALICE}:native:received`]: "1000000n", "tmpl:this": "tmpl" });
  const block = vm.createBlock({ timestamp: T });
  const deployed = block.deploy({ programUuid: "fz", code, context: as });
  if (deployed.status !== "success") return { vm, deploy: deployed, summary: { deploy: deployed.status, error: deployed.error?.code } };
  block.init({ programUuid: "fz", context: as });
  const res = block.call({ programUuid: "fz", functionName: fn, input, context: as });
  const after = block.call({ programUuid: "fz", functionName: "ok", input: {}, context: as });   // กติกา 4
  return {
    vm, res, after,
    summary: { status: res.status, code: res.error?.code ?? null, message: res.error?.message ?? null, gasUsed: res.gasUsed,
      result: encodeForGuest(res.result), writes: encodeForGuest(res.writes), events: encodeForGuest(res.events ?? null),
      after: [after.status, encodeForGuest(after.result)] },
  };
}

const snapshotHost = () => JSON.stringify([Object.getOwnPropertyNames(Object.prototype), Object.getOwnPropertyNames(Array.prototype),
  Object.getOwnPropertyNames(globalThis).length, ({}).polluted, [].polluted]);

/** ค่าจากโปรแกรมต้องเป็นข้อมูลล้วน: plain object / array / ค่าพื้นฐาน / BigInt (GuestValue = ป้ายของค่าที่ไม่ใช่ข้อมูล) */
function plainData(value, seen = new Set()) {
  if (value === null || ["string", "number", "boolean", "bigint", "undefined"].includes(typeof value)) return true;
  if (typeof value === "function" || typeof value === "symbol") return false;
  if (seen.has(value)) return false;   // ค่าวนข้ามเขตแดนไม่ได้
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (!(Array.isArray(value) ? proto === Array.prototype : proto === Object.prototype || proto === null || value.constructor?.name === "GuestValue")) return false;
  return Object.values(value).every((item) => plainData(item, seen));
}

/** 1 รอบ → null (ผ่าน) หรือข้อความที่ผิด */
export function fuzzOnce(seed) {
  const rng = random(seed);
  const code = guestProgram(rng);
  const mode = rng.int(3);   // 0 = เรียก API · 1 = echo input จาก host · 2 = ทั้งคู่ด้วย input แปลก
  const fn = mode === 1 ? "echo" : "fuzz";
  const input = mode === 0 ? {} : { v: hostValue(rng), w: hostValue(rng) };
  const before = snapshotHost();
  let first;
  let second;
  try {
    first = runOnce(code, fn, input);
    second = runOnce(code, fn, input);
  } catch (error) {
    return { seed, code, problem: `VM throw ออกมาถึงผู้เรียก: ${error.stack}` };
  }
  if (snapshotHost() !== before) return { seed, code, problem: "host ถูกแตะ (prototype / globalThis เปลี่ยน)" };
  if (first.deploy) return null;   // deploy ไม่ผ่าน (โค้ดผิด syntax / ใหญ่เกิน) = ปกติ
  const { res, summary } = first;
  if (!["success", "throw"].includes(res.status)) return { seed, code, problem: `status แปลก: ${res.status}` };
  if (res.error?.code === ERROR_CODE.INTERNAL) return { seed, code, problem: `INTERNAL: ${res.error.message}` };
  if (!Object.values(ERROR_CODE).includes(res.error?.code ?? ERROR_CODE.INVALID_REQUEST)) return { seed, code, problem: `error code แปลก: ${res.error.code}` };
  if (JSON.stringify(summary) !== JSON.stringify(second.summary)) {
    return { seed, code, problem: `ไม่ deterministic:\n  ${JSON.stringify(summary).slice(0, 400)}\n  ${JSON.stringify(second.summary).slice(0, 400)}` };
  }
  if (!plainData(res.result)) return { seed, code, problem: "ค่าที่คืนไม่ใช่ข้อมูลล้วน" };
  if (first.after.status !== "success") return { seed, code, problem: `sandbox ใช้ต่อไม่ได้หลังรอบนี้: ${JSON.stringify(first.after.error)}` };
  return null;
}

/** fuzz ตัวถอดข้อความจากโปรแกรม (host parser) โดยตรง: ข้อความ JSON สุ่ม + ป้ายแปลก */
export function fuzzDecoder(seed, iterations = 500) {
  const rng = random(seed);
  const pieces = ['{"\\u0000":"b","v":"1"}', '{"\\u0000":"b","v":"zz"}', '{"\\u0000":"u"}', '{"\\u0000":"n","v":"x"}', '{"\\u0000":"x","t":{}}',
    '{"\\u0000":"o","v":[["__proto__",{"polluted":1}]]}', '{"\\u0000":"o","v":5}', '{"\\u0000":"m","v":[]}', '{"\\u0000":"q"}',
    '{"__proto__":{"polluted":1}}', '{"constructor":{"prototype":{"polluted":1}}}', "[]", "1", '"s"', "null", "[[[[]]]]"];
  const failures = [];
  for (let i = 0; i < iterations; i += 1) {
    const text = Array.from({ length: 1 + rng.int(3) }, () => rng.pick(pieces)).reduce((acc, item) => `{"a":${acc},"b":${item}}`);
    try {
      decodeFromGuest(text, (...parts) => parts.join(":"));
    } catch (error) {
      if (!(error instanceof Error)) failures.push(`throw ค่าที่ไม่ใช่ Error: ${text}`);
    }
    if (({}).polluted !== undefined || Object.prototype.polluted !== undefined) failures.push(`prototype ถูกแก้: ${text}`);
  }
  return failures;
}

export function runFuzz({ seed = Date.now() % 1_000_000, iterations = 200, onProgress } = {}) {
  const failures = [];
  for (let i = 0; i < iterations; i += 1) {
    const failure = fuzzOnce(seed + i);
    if (failure) failures.push(failure);
    onProgress?.(i + 1, failures.length);
  }
  return { seed, iterations, failures, decoder: fuzzDecoder(seed) };
}

if (process.argv[1]?.endsWith("fuzz-sandbox.js")) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => (args.includes(`--${name}`) ? Number(args[args.indexOf(`--${name}`) + 1]) : fallback);
  const seed = option("seed", Date.now() % 1_000_000);
  const iterations = option("iterations", 2000);
  const started = performance.now();
  const result = runFuzz({ seed, iterations, onProgress: (n, bad) => { if (n % 250 === 0) console.log(`${n}/${iterations} รอบ · พบปัญหา ${bad}`); } });
  console.log(`seed ${seed} · ${iterations} รอบ · ${((performance.now() - started) / 1000).toFixed(1)} วิ · ปัญหา ${result.failures.length} · decoder ${result.decoder.length}`);
  for (const failure of result.failures.slice(0, 5)) console.log(`\n--- seed ${failure.seed}: ${failure.problem}\n${failure.code}`);
  for (const failure of result.decoder.slice(0, 5)) console.log(`decoder: ${failure}`);
  process.exit(result.failures.length || result.decoder.length ? 1 : 0);
}
