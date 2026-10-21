/**
 * sandbox ของโปรแกรม: รันโค้ดของผู้ใช้ใน QuickJS ที่คอมไพล์เป็น WebAssembly (quickjs-emscripten แบบ sync)
 *
 *   const sandbox = new Sandbox(tx, { memoryLimitBytes, maxStackBytes, nodeGas, builtinGas, timestamp, wallClock, map })
 *   sandbox.invoke({ programUuid, source, functionName, params, api, blockNumber })  → outcome
 *   sandbox.dispose()                                                               ← ทุก tx ต้องเรียก (runAction ทำให้)
 *
 * โครงสร้าง
 *   QuickJS สำหรับรันโปรแกรมมี instance เดียว (WebAssembly memory ของตัวเอง) และ runtime เดียว
 *   ตอน import: สร้าง runtime + context สำรองไว้ POOL_SIZE ตัว (โหลด prelude แล้ว) → ถ่าย snapshot ของ memory
 *   ต้น tx ชั้นนอกสุด: คืน memory เป็น snapshot (≈ 0.1 ms) → ทุก tx เริ่มจาก heap ที่เหมือนกันทุกไบต์
 *     · หน่วยความจำ / stack / เวลา นับรวมทั้งสายการเรียกของ tx (runProgram ซ้อนรันใน runtime เดียวกัน)
 *     · 1 โปรแกรม (address + โค้ด) = 1 context — โปรแกรมต่างตัวไม่เห็น global ของกันและกัน
 *     · ไม่มีอะไรจาก tx ก่อนหน้าค้างอยู่เลย (global ที่โปรแกรมแก้ / object / ขยะของ GC)
 *   ทุก call รันฟังก์ชัน factory ของโปรแกรมใหม่ → ตัวแปรระดับบนสุดไม่ค้างข้าม call (เหมือนเดิม)
 *   โค้ดในโปรแกรมไม่มีทางได้ object ของ host: ค่าทุกตัวข้ามเขตแดนเป็นข้อความ JSON (BigInt / undefined / ค่าพิเศษติดป้าย)
 *
 * แก๊ส: __gas(n) นับใน sandbox เอง (ตัวนับของแต่ละ call) แล้วส่งยอดค้างให้ host ทุกครั้งที่เรียก API
 *   เกินยอดที่เหลือ → ถาม host ทันที → OUT_OF_GAS ตรงจุดเดียวกับการนับทีละครั้ง (ตัวเลขแก๊สเท่าเดิมทุกหน่วย)
 *
 * หน่วยความจำ: memory limit ในตัว QuickJS ใช้ไม่ได้บน emscripten (นับแค่ 8 ไบต์ต่อก้อน) จึงคุมที่ heap ของ WebAssembly แทน
 *   ต้น tx (หลังคืน snapshot): จองก้อน "ลูกโป่ง" ให้เหลือที่ว่างพอดี memoryLimitBytes + สำรองของ host แล้วล็อกไม่ให้ memory โต
 *   → malloc ล้มที่จุดเดียวกันทุกเครื่อง (ไม่ขึ้นกับขนาด memory ที่เคยโตไว้) · ล็อกโดนแตะเมื่อไร = OUT_OF_MEMORY (catch ไม่ได้)
 */
import { getQuickJS, newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from "quickjs-emscripten";

export const SANDBOX_DEFAULTS = {
  memoryLimitBytes: 32 * 1024 * 1024,   // หน่วยความจำต่อ tx (รวมทุกโปรแกรมในสายการเรียก)
  maxStackBytes: 256 * 1024,            // stack ของ QuickJS ต่อ tx (≈ 1,400 ชั้นของการเรียกฟังก์ชันซ้อน) — มากกว่านี้เสี่ยง stack ของ Node เอง
};

/** ช่วงที่ตั้งได้: stack ของ QuickJS ใช้ stack จริงของ Node ด้วย — 512 KB ทำให้ Node stack ล้นจน WebAssembly พัง */
export const SANDBOX_LIMITS = {
  memoryLimitBytes: [1024 * 1024, 1024 * 1024 * 1024],
  maxStackBytes: [16 * 1024, 256 * 1024],
};

const PAGE = 64 * 1024;
const HOST_RESERVE = 2 * 1024 * 1024;   // ที่สำรองให้ host ใช้ต่อหลังโปรแกรมใช้หน่วยความจำจนเต็ม
const HOST_HEADROOM = 256 * 1024;       // host ตรวจว่ายังมีที่ว่างเท่านี้ก่อนทำงานทุกครั้ง (ไม่มี = OUT_OF_MEMORY)
const POOL_SIZE = 8;                    // context ที่เตรียมไว้ใน snapshot (tx ที่ใช้โปรแกรมมากกว่านี้สร้างเพิ่มเอง ช้ากว่า)
const LOW_REGION = 1024 * 1024;         // ส่วนล่างของ memory: ข้อมูล static ของ QuickJS / malloc (~90 KB) ที่เหลือคือ stack ของ C
const MAX_MEMORY_PAGES = 32768;         // 2 GB (เพดานของ wasm32)

// ---------------------------------------------------------------------------
//  instance ของ QuickJS
// ---------------------------------------------------------------------------

const realGrow = WebAssembly.Memory.prototype.grow;
const executorMemory = new WebAssembly.Memory({ initial: 256, maximum: MAX_MEMORY_PAGES });
let memoryLocked = false;
let current = null;   // sandbox ที่กำลังถือ heap (มีได้ทีละตัว)

// emscripten ขยาย memory ผ่าน grow เท่านั้น → ระหว่าง tx ห้ามโต (malloc ล้ม = เกินกำหนด)
executorMemory.grow = function grow(delta) {
  if (memoryLocked) {
    current?.flagOutOfMemory();
    throw new RangeError("sandbox memory limit");
  }
  return realGrow.call(this, delta);
};

/** QuickJS สำหรับรันโปรแกรม (heap แยกจากตัวตรวจ syntax) */
const executor = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: executorMemory }));
/** QuickJS สำหรับตรวจ syntax ตอนคอมไพล์ (ไม่รันโค้ด) */
const checker = await getQuickJS();
const checkerContext = checker.newContext();
const heap = executor.module;   // emscripten module: _malloc / _free

let brokenReason = null;   // WebAssembly พัง (ไม่ควรเกิด) → ทุก tx ล้มเป็น INTERNAL แทนที่จะรันต่อบน heap ที่เสีย

/** สถิติสำหรับทดสอบว่าไม่มีของค้าง: sandbox ที่ถือ heap / context ที่สร้างเพิ่ม / handle ที่ยังไม่คืน */
export const sandboxStats = { active: 0, extraContexts: 0, handles: 0, transactions: 0 };
export const sandboxMemoryBytes = () => executorMemory.buffer.byteLength;

/**
 * ตรวจ syntax ด้วย QuickJS (V8 กับ QuickJS รับ syntax ไม่ตรงกันทุกข้อ) — คืนข้อความ error หรือ null
 * compileOnly: ไม่มีโค้ดของผู้ใช้ถูกรัน
 */
export function checkGuestSyntax(source) {
  const result = checkerContext.evalCode(source, "program", { compileOnly: true });
  if (result.error) {
    const error = checkerContext.dump(result.error);
    result.error.dispose();
    return `${error?.name ?? "SyntaxError"}: ${error?.message ?? String(error)}`;
  }
  result.value.dispose();
  return null;
}

// ---------------------------------------------------------------------------
//  ข้อตกลงระหว่าง host ↔ โปรแกรม
// ---------------------------------------------------------------------------

/**
 * API ที่เรียกข้ามไป host: [ชื่อ, ชนิดของ argument แต่ละตัว]
 *   k = key (string / map(...))   p = ค่าเดี่ยว (object ถูกส่งเป็น "ไม่ใช่ข้อมูล")   d = ข้อมูลทั้งก้อน
 *   R = options ของ runProgram ({ value, readonly })   C = options ของ cloneProgram ({ salt, value })
 */
export const API_OPS = [
  ["readDB", "k"], ["writeDB", "kd"], ["deleteDB", "k"],
  ["runProgram", "ppdR"], ["transferNative", "pp"], ["setMetadata", "pd"], ["emit", "pdd"],
  ["keccak256", "d"], ["ecrecover", "dp"], ["cloneProgram", "pdC"],
  ["ThisBalance", ""], ["BalanceOf", "p"], ["IsProgram", "p"], ["MetadataOf", "pp"],
  ["sha256", "d"], ["ripemd160", "d"], ["blake2b", "d"], ["modexp", "ppp"],
  ["BlockHash", "p"], ["ChainId", ""], ["Coinbase", ""], ["BlockGasLimit", ""], ["GasPrice", ""], ["BaseFee", ""], ["GasLeft", ""],
  ["CodeHashOf", "p"], ["CodeSizeOf", "p"],
];
const OP = { sync: 0, random: 1, clock: 2, check: 3, api: 10 };

const TAG = "\u0000";   // ป้ายของค่าที่ JSON ไม่มี: { "\u0000": "b", v: "123" } = 123n

/** ค่าจากโปรแกรมที่ไม่ใช่ข้อมูล (function / symbol / Date / class ...) — host เห็นเป็น object ที่ไม่ใช่ plain object */
export class GuestValue {
  constructor(type) {
    this.type = type;
  }
}

function hostReplacer(key, value) {
  switch (typeof value) {
    case "bigint": return { [TAG]: "b", v: `${value}` };
    case "undefined": return { [TAG]: "u" };
    case "number":
      if (Number.isFinite(value) && !Object.is(value, -0)) return value;
      return { [TAG]: "n", v: Object.is(value, -0) ? "-0" : String(value) };
    case "function":
    case "symbol": return { [TAG]: "x", t: typeof value };
    case "object":
      if (value !== null && !Array.isArray(value) && Object.hasOwn(value, TAG)) {
        return { [TAG]: "o", v: Object.keys(value).map((name) => [name, value[name]]) };
      }
      return value;
    default: return value;
  }
}

/** ค่าของ host → ข้อความ (BigInt / undefined / NaN ติดป้าย) */
export const encodeForGuest = (value) => JSON.stringify(value, hostReplacer);

/** ข้อความจากโปรแกรม → ค่าของ host (object / array ใหม่ทั้งหมด ไม่มี reference ข้ามฝั่ง) */
export function decodeFromGuest(text, makeMap) {
  const revive = (node) => {
    if (typeof node !== "object" || node === null) return node;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = revive(node[i]);
      return node;
    }
    if (Object.hasOwn(node, TAG)) {
      switch (node[TAG]) {
        case "b": return BigInt(node.v);
        case "u": return undefined;
        case "n": return Number(node.v);
        case "x": return new GuestValue(String(node.t));
        case "m": return makeMap(...node.v.map(revive));
        case "o": return Object.fromEntries(node.v.map(([name, item]) => [name, revive(item)]));
        default: throw new Error(`ป้ายข้อมูลไม่รู้จัก: ${node[TAG]}`);
      }
    }
    for (const name of Object.keys(node)) node[name] = revive(node[name]);
    return node;
  };
  return revive(JSON.parse(text));
}

// ---------------------------------------------------------------------------
//  โค้ดฝั่งโปรแกรม (prelude): รันก่อนโค้ดของผู้ใช้ในทุก context
//  ฟังก์ชันนี้ถูกแปลงเป็นข้อความ (toString) — ห้ามอ้างอะไรนอกตัวมันเอง
// ---------------------------------------------------------------------------

/* eslint-disable no-new-func */
function prelude(host, opText) {
  "use strict";
  // ---- เก็บของจริงไว้ก่อนโค้ดของผู้ใช้ได้รัน (ผู้ใช้แก้ global / prototype ทีหลังก็ไม่กระทบตัวนี้) ----
  const G = globalThis;
  const { keys, getPrototypeOf, freeze, defineProperty, hasOwn } = Object;
  const ObjectProto = Object.prototype;
  const isArray = Array.isArray;
  const { apply, construct, get: reflectGet } = Reflect;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const NumberFn = Number;
  const numberIsFinite = Number.isFinite;
  const BigIntFn = BigInt;
  const StringFn = String;
  const ArrayBufferFn = ArrayBuffer;
  const ProxyFn = Proxy;
  const DateFn = Date;
  const MathObj = Math;
  const WeakMapFn = WeakMap;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;
  const wmHas = WeakMap.prototype.has;
  const indexOf = String.prototype.indexOf;
  const ErrorFn = Error;
  const EvalErrorFn = EvalError;
  const ERROR_TYPES = { __proto__: null, Error, TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError };

  const OP = jsonParse(opText);
  // ค่าของ tx: ตั้งโดย configure() ตอนโปรแกรมได้ context นี้ (context ถูกเตรียมไว้ก่อนมี tx)
  let NODE_GAS = 0;
  let BUILTIN_GAS = 0;
  let TIMESTAMP = 0;
  const TAG = "\u0000";
  const TAG_IN_JSON = "\\u0000";
  const UNDEFINED = '{"\\u0000":"u"}';

  const MAP_PARTS = new WeakMapFn();     // object จาก map(...) → ส่วนของ key
  const HOST_ERRORS = new WeakMapFn();   // error ที่มาจาก host → เลขอ้างอิง (throw ต่อ = host ได้ error ตัวเดิม)
  const DEAD = new ErrorFn("transaction aborted");
  let dead = false;   // แก๊สหมด / หมดเวลา / DB พัง / หน่วยความจำเกิน → ทุกอย่างหลังจากนี้ throw ซ้ำ (catch ไม่ได้)
  const die = () => {
    dead = true;
    throw DEAD;
  };

  // ---- แปลงค่าเป็นข้อความ ----
  const opaque = (type) => '{"\\u0000":"x","t":"' + type + '"}';
  const isMap = (value) => apply(wmHas, MAP_PARTS, [value]);
  function encodeNumber(value) {
    if (value !== value) return '{"\\u0000":"n","v":"NaN"}';
    if (value === Infinity) return '{"\\u0000":"n","v":"Infinity"}';
    if (value === -Infinity) return '{"\\u0000":"n","v":"-Infinity"}';
    if (value === 0 && 1 / value < 0) return '{"\\u0000":"n","v":"-0"}';
    return "" + value;
  }
  /** ค่าเดี่ยว: object ทั่วไปไม่ถูกเปิดดู (host ตรวจชนิดแล้วปฏิเสธเหมือนเดิม) */
  function encodeShallow(value) {
    switch (typeof value) {
      case "string": return jsonStringify(value);
      case "number": return encodeNumber(value);
      case "boolean": return value ? "true" : "false";
      case "bigint": return '{"\\u0000":"b","v":"' + value + '"}';
      case "undefined": return UNDEFINED;
      case "symbol": return opaque("symbol");
      case "function": return opaque("function");
      default:
        if (value === null) return "null";
        return isMap(value) ? encodeMap(value) : opaque("object");
    }
  }
  function encodeMap(value) {
    const parts = apply(wmGet, MAP_PARTS, [value]);
    let text = '{"\\u0000":"m","v":[';
    for (let i = 0; i < parts.length; i++) text += (i ? "," : "") + encodeShallow(parts[i]);
    return text + "]}";
  }
  /** ข้อมูลทั้งก้อน: array / plain object ลงลึก · อย่างอื่นเป็น "ไม่ใช่ข้อมูล" */
  function encode(value) {
    if (typeof value !== "object" || value === null) return encodeShallow(value);
    if (isMap(value)) return encodeMap(value);
    if (isArray(value)) {
      let text = "[";
      const length = value.length;
      for (let i = 0; i < length; i++) text += (i ? "," : "") + encode(value[i]);
      return text + "]";
    }
    const proto = getPrototypeOf(value);
    if (proto !== ObjectProto && proto !== null) return opaque("object");
    const names = keys(value);
    let escaped = false;
    for (let i = 0; i < names.length; i++) if (names[i] === TAG) escaped = true;
    if (escaped) {
      let text = '{"\\u0000":"o","v":[';
      for (let i = 0; i < names.length; i++) text += (i ? "," : "") + "[" + jsonStringify(names[i]) + "," + encode(value[names[i]]) + "]";
      return text + "]}";
    }
    let text = "{";
    for (let i = 0; i < names.length; i++) text += (i ? "," : "") + jsonStringify(names[i]) + ":" + encode(value[names[i]]);
    return text + "}";
  }

  // ---- แปลงข้อความจาก host เป็นค่า ----
  function revive(node) {
    if (typeof node !== "object" || node === null) return node;
    if (isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = revive(node[i]);
      return node;
    }
    if (hasOwn(node, TAG)) {
      const tag = node[TAG];
      if (tag === "b") return BigIntFn(node.v);
      if (tag === "u") return undefined;
      if (tag === "n") return NumberFn(node.v);
      if (tag === "o") {
        const out = {};
        const pairs = node.v;
        for (let i = 0; i < pairs.length; i++) {
          defineProperty(out, pairs[i][0], { value: revive(pairs[i][1]), writable: true, enumerable: true, configurable: true });
        }
        return out;
      }
    }
    const names = keys(node);
    for (let i = 0; i < names.length; i++) node[names[i]] = revive(node[names[i]]);
    return node;
  }
  const decode = (text) => (apply(indexOf, text, [TAG_IN_JSON]) === -1 ? jsonParse(text) : revive(jsonParse(text)));

  function hostError(desc) {
    const Type = ERROR_TYPES[desc.name] ?? ErrorFn;
    const error = new Type(desc.message);
    if (desc.code !== undefined) defineProperty(error, "code", { value: desc.code, writable: true, enumerable: true, configurable: true });
    apply(wmSet, HOST_ERRORS, [error, desc.id]);
    return error;
  }

  /** คำตอบจาก host: "f" = tx ล้มทั้งใบ · [ชนิด, แก๊สที่เหลือ, ค่า] */
  function receive(act, reply) {
    if (reply === "f" || typeof reply !== "string") die();
    const message = decode(reply);
    act.budget = message[1];
    if (message[0] === "e") throw hostError(message[2]);
    return message[2];
  }

  // ---- เวลาของ block / ตัวสุ่มของ tx (เหมือนที่ host เคยให้) ----
  const BLOCK_DATE = new ProxyFn(DateFn, {
    construct: (target, args, newTarget) => construct(target, args.length ? args : [TIMESTAMP], newTarget),
    apply: () => new DateFn(TIMESTAMP).toString(),
    get: (target, prop, receiver) => (prop === "now" ? () => TIMESTAMP : reflectGet(target, prop, receiver)),
  });
  const random = () => {
    const reply = host(OP.random, 0, "");
    if (reply === "f" || typeof reply !== "string") die();
    return NumberFn(reply);
  };
  const SEEDED_MATH = new ProxyFn(MathObj, { get: (target, prop, receiver) => (prop === "random" ? random : reflectGet(target, prop, receiver)) });

  // ---- global ของ context: ไม่มีอะไรที่ไม่แน่นอนหรือหนีการนับแก๊สได้ ----
  const define = (target, name, value) => defineProperty(target, name, { value, writable: true, enumerable: false, configurable: true });
  define(G, "Date", BLOCK_DATE);
  define(G, "Math", SEEDED_MATH);
  // โค้ดที่สร้างตอนรัน (eval / new Function) ไม่ผ่านตัวนับแก๊ส → ปิด
  const deny = () => {
    throw new EvalErrorFn("eval / Function ใช้ในโปรแกรมไม่ได้");
  };
  const lock = (Constructor) => new ProxyFn(Constructor, { apply: deny, construct: deny });
  const FUNCTION_TYPES = [
    Function,
    getPrototypeOf(async function () {}).constructor,
    getPrototypeOf(function* () {}).constructor,
    getPrototypeOf(async function* () {}).constructor,
  ];
  for (let i = 0; i < FUNCTION_TYPES.length; i++) define(FUNCTION_TYPES[i].prototype, "constructor", lock(FUNCTION_TYPES[i]));
  define(G, "Function", lock(Function));
  define(G, "eval", function evalDisabled() { deny(); });
  define(G, "console", freeze({ log() {}, info() {}, warn() {}, error() {}, debug() {} }));   // ใช้ได้แต่ไม่พิมพ์อะไร

  // ---- API ของแต่ละ call ----
  function makeMap(...parts) {
    const key = {};
    apply(wmSet, MAP_PARTS, [key, parts]);
    return key;
  }
  function sizeOf(value) {
    if (typeof value === "string" || isArray(value)) return value.length;
    if (value !== null && typeof value === "object") return keys(value).length;
    return 1;
  }
  const count = (value) => (numberIsFinite(NumberFn(value)) && NumberFn(value) > 0 ? NumberFn(value) : 0);
  function expectedSize(target, method, args) {
    if (method === "repeat" && typeof target === "string") return target.length * count(args[0]);
    if ((method === "padStart" || method === "padEnd") && typeof target === "string") return count(args[0]);
    if (method === "from" && args[0] && typeof args[0] === "object") return count(args[0].length);
    return 0;
  }

  const ENCODERS = { k: encodeShallow, p: encodeShallow, d: encode,
    R: (options) => (options !== null && (typeof options === "object" || typeof options === "function")
      ? '{"value":' + encodeShallow(options.value) + ',"readonly":' + encodeShallow(options.readonly) + "}" : encodeShallow(options)),
    C: (options) => (options !== null && (typeof options === "object" || typeof options === "function")
      ? '{"salt":' + encodeShallow(options.salt) + ',"value":' + encodeShallow(options.value) + "}" : encodeShallow(options)) };

  function makeApi(act, address, blockNumber) {
    const call = (op, payload) => {
      if (dead) throw DEAD;
      const pending = act.pending;
      act.pending = 0;
      return receive(act, host(op, pending, payload));
    };
    const charge = (amount) => {
      if (dead) throw DEAD;
      act.pending += amount;
      if (act.pending > act.budget) call(OP.sync, "");
    };
    const api = {
      __gas: (nodes) => charge(nodes * NODE_GAS),
      __call: (target, method, args) => {
        const fn = target[method];   // target เป็น null / undefined → TypeError แบบเดียวกับการเรียกปกติ
        if (typeof fn !== "function") return fn.apply(target, args);
        let size = sizeOf(target);
        for (let i = 0; i < args.length; i++) size += sizeOf(args[i]);
        charge(BUILTIN_GAS * (size + expectedSize(target, method, args)));
        const result = apply(fn, target, args);
        charge(BUILTIN_GAS * sizeOf(result));
        return result;
      },
      map: makeMap,
      Date: BLOCK_DATE,
      Math: SEEDED_MATH,
      ThisAddress: () => address,
      BlockNumber: () => blockNumber,
    };
    for (let i = 0; i < OP.names.length; i++) {
      const op = OP.api + i;
      const kinds = OP.kinds[i];
      api[OP.names[i]] = (a, b, c, d) => {
        const args = [a, b, c, d];
        let payload = "[";
        for (let j = 0; j < kinds.length; j++) payload += (j ? "," : "") + ENCODERS[kinds[j]](args[j]);
        return call(op, payload + "]");
      };
    }
    return freeze(api);
  }

  function describe(error) {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
      const id = apply(wmGet, HOST_ERRORS, [error]);
      if (id !== undefined) return '{"t":"h","id":' + id + "}";
    }
    if (error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return '{"t":"t"}';
    if (error instanceof ErrorFn) {
      const stack = error.stack;
      return '{"t":"e","name":' + encode(error.constructor?.name ?? "Error") + ',"message":' + encode(error.message)
        + ',"stack":' + (typeof stack === "string" ? jsonStringify(stack) : "null") + "}";
    }
    return '{"t":"s","text":' + jsonStringify(StringFn(error)) + "}";
  }

  /** รัน 1 call: ผล = "v<แก๊สค้าง>|<ค่า>" · "e<แก๊สค้าง>|<error>" · "a<แก๊สค้าง>|" (async) · "f" (tx ล้มทั้งใบ) */
  function invoke(factory, name, paramsText, address, blockNumberText, budget) {
    const act = { pending: 0, budget };
    let outcome;
    try {
      const api = makeApi(act, address, blockNumberText === "" ? null : BigIntFn(blockNumberText));
      const result = factory(api)[name](decode(paramsText));
      outcome = typeof result?.then === "function" ? "a" + act.pending + "|" : "v" + act.pending + "|" + encode(result);
    } catch (error) {
      try {
        outcome = dead ? "f" : "e" + act.pending + "|" + describe(error);
      } catch {
        outcome = dead ? "f" : "e" + act.pending + '|{"t":"s","text":"โปรแกรมทำงานผิดพลาด"}';
      }
    }
    // ต้องเหลือที่ว่างให้ส่งผลกลับ host (เต็มพอดีโดยไม่ล้ม = ให้ host ตรวจ / ปล่อยที่สำรอง)
    try {
      new ArrayBufferFn(4096);
    } catch {
      host(OP.check, 0, "");
    }
    return outcome;
  }

  /** ผูก context กับ tx: แก๊สต่อหน่วย / เวลาของ block / นาฬิกาจริง (เทสต์เท่านั้น) → คืน invoke */
  return function configure(configText) {
    const config = jsonParse(configText);
    NODE_GAS = config.nodeGas;
    BUILTIN_GAS = config.builtinGas;
    TIMESTAMP = config.timestamp;
    if (config.wallClock) define(G, "performance", freeze({ now: () => {
      const reply = host(OP.clock, 0, "");
      if (reply === "f" || typeof reply !== "string") die();
      return NumberFn(reply);
    } }));
    return invoke;
  };
}

const PRELUDE_SOURCE = `(${prelude.toString()})`;
const OP_TEXT = JSON.stringify({ ...OP, names: API_OPS.map(([name]) => name), kinds: API_OPS.map(([, kinds]) => kinds) });

const HOST_CALL = Symbol("host call");
const INTERRUPT = Symbol("interrupt");

// ---------------------------------------------------------------------------
//  runtime + context สำรอง + snapshot (สร้างครั้งเดียวตอน import)
// ---------------------------------------------------------------------------

/** context ใหม่ที่โหลด prelude แล้ว: { ctx, configure } (configure(configText) → invoke) */
function createContext(rt) {
  const ctx = rt.newContext();
  // ฟังก์ชันเดียวที่โปรแกรมเรียกออกมาได้: ส่งต่อให้ sandbox ของ tx ที่กำลังรัน (ไม่มี tx = tx ล้มแล้ว)
  const host = ctx.newFunction("host", (op, pending, payload) =>
    (current ? current[HOST_CALL](ctx, op, pending, payload) : ctx.newString("f")));
  const opHandle = ctx.newString(OP_TEXT);
  let failure = null;
  let configure = null;
  const preludeResult = ctx.evalCode(PRELUDE_SOURCE, "vm-prelude", { strict: true });
  if (preludeResult.error) {
    failure = readError(ctx, preludeResult.error);
  } else {
    const result = ctx.callFunction(preludeResult.value, ctx.undefined, host, opHandle);
    preludeResult.value.dispose();
    if (result.error) failure = readError(ctx, result.error);
    else configure = result.value;
  }
  opHandle.dispose();
  host.dispose();
  if (failure) {
    ctx.dispose();
    throw new Error(`เตรียม context ของ sandbox ไม่สำเร็จ: ${failure.name}: ${failure.message}`);
  }
  return { ctx, configure };
}

/** error ที่ QuickJS throw ออกมาถึง host → { name, message } (คืน handle เสมอ) */
function readError(ctx, errorHandle) {
  try {
    const error = ctx.dump(errorHandle);
    if (error === null || typeof error !== "object") return { name: "Error", message: String(error) };
    return { name: String(error.name ?? "Error"), message: String(error.message ?? error) };
  } catch {
    return { name: "Error", message: "error" };
  } finally {
    if (errorHandle.alive) errorHandle.dispose();
  }
}

/**
 * ตำแหน่งใน memory ที่ malloc (dlmalloc) เก็บต้นของก้อนว่างก้อนสุดท้าย ("top") — เหนือ top ขึ้นไปไม่มีข้อมูลที่ใช้อยู่
 * หาจากการทดลอง: malloc ก้อนใหญ่ (ตัดจาก top เสมอ) แล้วดูว่าค่าไหนขยับจากต้นก้อนไปท้ายก้อนพอดี
 * หาไม่เจอ = null (snapshot จะเก็บ memory ทั้งก้อน: ถูกต้องแต่ช้ากว่า)
 */
function findTopAddress() {
  const scan = () => new Uint32Array(executorMemory.buffer, 0, LOW_REGION / 4).slice();
  const before = scan();
  const size = SANDBOX_DEFAULTS.memoryLimitBytes + HOST_RESERVE + 2 * PAGE;   // ขยาย memory ไว้ก่อนด้วยในตัว
  const block = heap._malloc(size);
  if (!block) return null;
  const after = scan();
  heap._free(block);
  const found = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === block - 8 && after[i] >= block + size && after[i] <= block + size + 64) found.push(i * 4);
  }
  return found.length === 1 ? found[0] : null;
}

const engine = (() => {
  const firstBlock = heap._malloc(16);
  heap._free(firstBlock);
  const heapStart = Math.max(LOW_REGION, firstBlock - PAGE);   // ใต้ heap คือ stack ของ C (ไม่ต้องเก็บ)
  const topAddress = findTopAddress();

  const rt = executor.newRuntime();
  rt.setMaxStackSize(SANDBOX_DEFAULTS.maxStackBytes);
  rt.setInterruptHandler(() => (current ? current[INTERRUPT]() : false));
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) pool.push(createContext(rt));

  const memoryEnd = topAddress === null
    ? executorMemory.buffer.byteLength
    : new Uint32Array(executorMemory.buffer)[topAddress / 4] + PAGE;
  const view = new Uint8Array(executorMemory.buffer);
  return {
    rt,
    pool,
    heapStart,
    low: view.slice(0, LOW_REGION),
    high: view.slice(heapStart, memoryEnd),
  };
})();

/** memory ของ QuickJS กลับเป็นตอนเพิ่งสร้าง pool (ห้ามเรียกระหว่างอยู่ใน QuickJS) */
function restoreSnapshot() {
  const view = new Uint8Array(executorMemory.buffer);
  view.set(engine.low, 0);
  view.set(engine.high, engine.heapStart);
}

/**
 * ตรวจตอน import ว่า snapshot คืนสถานะได้ครบจริง (โครงสร้าง memory ของ quickjs-emscripten ตรงกับที่คาด)
 * รันโปรแกรมทดสอบ → ทำให้ heap สกปรก → คืน snapshot → รันซ้ำ: ผลและตำแหน่ง malloc ต้องตรงกันทุกอย่าง
 */
function selfCheck() {
  const { ctx, configure } = engine.pool[0];
  const evaluate = (code) => {
    const result = ctx.evalCode(code, "self-check");
    if (result.error) throw new Error(`sandbox self-check: ${JSON.stringify(readError(ctx, result.error))}`);
    return result.value;
  };
  const run = () => {
    restoreSnapshot();
    const config = ctx.newString(JSON.stringify({ nodeGas: 1, builtinGas: 1, timestamp: 0, wallClock: false }));
    const invokeResult = ctx.callFunction(configure, ctx.undefined, config);
    config.dispose();
    if (invokeResult.error) throw new Error(`sandbox self-check: ${JSON.stringify(readError(ctx, invokeResult.error))}`);
    const factory = evaluate(`(function (api) { return { f(input) {
      const items = [];
      for (let i = 0; i < 200; i++) items.push({ i, v: BigInt(i) * 3n, s: "x".repeat(i) });
      return [items.length, input.x, typeof globalThis.leak, new Date().getTime(), items[199].v];
    } }; })`);
    const args = ["f", encodeForGuest({ x: "y" }), "self-check", "", 1e9].map((value) =>
      (typeof value === "number" ? ctx.newNumber(value) : ctx.newString(value)));
    const result = ctx.callFunction(invokeResult.value, ctx.undefined, factory, ...args);
    for (const handle of args) handle.dispose();
    factory.dispose();
    invokeResult.value.dispose();
    if (result.error) throw new Error(`sandbox self-check: ${JSON.stringify(readError(ctx, result.error))}`);
    const text = ctx.getString(result.value);
    result.value.dispose();
    const probe = heap._malloc(16);
    heap._free(probe);
    return `${text}@${probe}`;
  };
  const first = run();
  const dirty = evaluate("globalThis.leak = []; for (let i = 0; i < 5000; i++) leak.push({ i }); Object.prototype.polluted = 1; 1");
  dirty.dispose();
  const second = run();
  restoreSnapshot();
  if (first !== second || !first.startsWith('v0|[200,"y","undefined",0,{"\\u0000":"b","v":"597"}]')) {
    throw new Error(`sandbox self-check ไม่ผ่าน: ${first} / ${second}`);
  }
}
selfCheck();

// ---------------------------------------------------------------------------
//  Sandbox: 1 ตัวต่อ tx ชั้นนอกสุด
// ---------------------------------------------------------------------------

export class Sandbox {
  #tx;
  #options;
  #configText;
  #active = false;
  #disposed = false;
  #programs = new Map();   // programUuid → Map(source → { ctx, invoke, factory, error })
  #owned = [];             // handle ที่อยู่ตลอด tx (invoke / factory) — คืนตอน dispose
  #extra = [];             // context ที่สร้างเพิ่มเมื่อ pool ไม่พอ
  #nextSlot = 0;
  #errors = new Map();     // เลขอ้างอิง → error ของ host ที่ส่งเข้าโปรแกรม
  #nextErrorId = 1;
  #stack = [];             // call ที่กำลังรัน (ตัวท้ายคือผู้เรียก API)
  #reserve = 0;
  outOfMemory = false;
  timedOut = false;

  /**
   * @param {object} tx  Transaction: useGas, gasUsed, gasLimit, fatal, deadline, Math, abort(kind)
   * @param {{ memoryLimitBytes, maxStackBytes, nodeGas, builtinGas, timestamp, wallClock, map }} options
   */
  constructor(tx, options) {
    this.#tx = tx;
    this.#options = { ...SANDBOX_DEFAULTS, ...options };
    this.#configText = JSON.stringify({
      nodeGas: this.#options.nodeGas,
      builtinGas: this.#options.builtinGas,
      timestamp: this.#options.timestamp,
      wallClock: Boolean(this.#options.wallClock),
    });
  }

  /** ถูกเรียกจาก grow ของ memory (อยู่ระหว่าง malloc — ห้ามแตะ heap ที่นี่) */
  flagOutOfMemory() {
    this.outOfMemory = true;
  }

  // ---------- heap ----------

  /** เริ่ม tx: คืน snapshot → ตั้ง stack → ลูกโป่ง + ที่สำรอง → ล็อก memory */
  #begin() {
    if (this.#disposed) throw new Error("sandbox ถูกปิดไปแล้ว");
    if (this.#active) return;
    if (brokenReason) throw new Error(`QuickJS ใช้งานไม่ได้: ${brokenReason}`);
    if (current) throw new Error("sandbox ถูกใช้โดย tx อื่นที่ยังไม่จบ");
    restoreSnapshot();
    current = this;
    this.#active = true;
    sandboxStats.active += 1;
    sandboxStats.transactions += 1;
    engine.rt.setMaxStackSize(this.#options.maxStackBytes);

    const probe = heap._malloc(16);
    heap._free(probe);
    const capacity = this.#options.memoryLimitBytes + HOST_RESERVE;
    const target = probe + capacity + PAGE;
    if (executorMemory.buffer.byteLength < target) {
      const grow = heap._malloc(target - probe);   // ให้ emscripten ขยาย memory เอง (ต้องอัปเดต view ของ heap ด้วย)
      if (!grow) throw new Error("ขยายหน่วยความจำของ QuickJS ไม่ได้");
      heap._free(grow);
    }
    // ลูกโป่ง: เหลือที่ว่างหลัง probe พอดี capacity เสมอ ไม่ว่า memory จะเคยโตไปเท่าไร (คืนเองตอนคืน snapshot)
    if (!heap._malloc(executorMemory.buffer.byteLength - (probe + capacity))) throw new Error("จองหน่วยความจำของ QuickJS ไม่ได้");
    this.#reserve = heap._malloc(HOST_RESERVE);
    memoryLocked = true;
  }

  #releaseReserve() {
    if (this.#reserve) heap._free(this.#reserve);
    this.#reserve = 0;
  }

  /** host จะทำงาน: ต้องมีที่ว่างพอ ไม่งั้นถือว่าโปรแกรมใช้หน่วยความจำเกิน */
  #hasHeadroom() {
    if (!this.outOfMemory) {
      const probe = heap._malloc(HOST_HEADROOM);
      if (probe) {
        heap._free(probe);
        return true;
      }
      this.outOfMemory = true;
    }
    this.#releaseReserve();
    this.#tx.abort("memory");
    return false;
  }

  /** QuickJS ถามเป็นระยะระหว่างรัน: true = หยุดทันที (catch ไม่ได้) */
  [INTERRUPT]() {
    if (this.outOfMemory || this.#tx.fatal) return true;
    if (Date.now() > this.#tx.deadline) {
      this.timedOut = true;
      return true;
    }
    return false;
  }

  // ---------- handle ----------

  #own(handle) {
    this.#owned.push(handle);
    sandboxStats.handles += 1;
    return handle;
  }

  /** handle ชั่วคราวของ 1 call */
  static #temp(handle) {
    sandboxStats.handles += 1;
    return handle;
  }

  static #drop(handle) {
    if (handle.alive) handle.dispose();
    sandboxStats.handles -= 1;
  }

  // ---------- context ของแต่ละโปรแกรม ----------

  #context(programUuid, source) {
    let bySource = this.#programs.get(programUuid);
    if (!bySource) this.#programs.set(programUuid, (bySource = new Map()));
    const cached = bySource.get(source);
    if (cached) return cached;

    const entry = { ctx: null, invoke: null, factory: null, error: null };
    bySource.set(source, entry);
    let slot = engine.pool[this.#nextSlot];
    if (slot) {
      this.#nextSlot += 1;
    } else {
      try {
        slot = createContext(engine.rt);
      } catch (error) {
        if (!this.outOfMemory && !this.timedOut && !this.#tx.fatal) throw error;
        entry.error = { name: "InternalError", message: "out of memory" };
        return entry;
      }
      this.#extra.push(slot);
      this.#own(slot.configure);
      sandboxStats.extraContexts += 1;
    }
    const { ctx } = slot;
    entry.ctx = ctx;
    const config = Sandbox.#temp(ctx.newString(this.#configText));
    const invokeResult = ctx.callFunction(slot.configure, ctx.undefined, config);
    Sandbox.#drop(config);
    if (invokeResult.error) {
      entry.error = readError(ctx, invokeResult.error);
      return entry;
    }
    entry.invoke = this.#own(invokeResult.value);
    const factoryResult = ctx.evalCode(source, "program");
    if (factoryResult.error) {
      entry.error = readError(ctx, factoryResult.error);
      return entry;
    }
    entry.factory = this.#own(factoryResult.value);
    return entry;
  }

  // ---------- โปรแกรมเรียก host ----------

  #reply(kind, value) {
    return JSON.stringify([kind, this.#tx.gasLimit - this.#tx.gasUsed, value], hostReplacer);
  }

  [HOST_CALL](ctx, opHandle, pendingHandle, payloadHandle) {
    const op = ctx.getNumber(opHandle);
    if (!this.#hasHeadroom()) return ctx.newString("f");
    if (Date.now() > this.#tx.deadline) {   // interrupt handler อาจถูกเรียกห่างเมื่อโปรแกรมเรียก host ถี่ → ตรวจที่นี่ด้วย
      this.timedOut = true;
      return ctx.newString("f");
    }
    if (op === OP.check) return undefined;
    const tx = this.#tx;
    try {
      if (op === OP.random) return ctx.newString(String(tx.Math.random()));
      if (op === OP.clock && this.#options.wallClock) return ctx.newString(String(performance.now()));
      const pending = ctx.getNumber(pendingHandle);
      if (pending > 0) tx.useGas(pending);
      if (op === OP.sync) return ctx.newString(this.#reply("v", undefined));
      const spec = API_OPS[op - OP.api];
      if (!spec) throw new Error(`API ไม่รู้จัก: ${op}`);
      const args = decodeFromGuest(ctx.getString(payloadHandle), this.#options.map);
      const value = this.#stack.at(-1).api[spec[0]](...args);
      if (this.outOfMemory) {
        this.#hasHeadroom();
        return ctx.newString("f");
      }
      return ctx.newString(this.#reply("v", value));
    } catch (error) {
      if (this.outOfMemory) this.#hasHeadroom();
      if (tx.fatal) return ctx.newString("f");
      const id = this.#nextErrorId++;
      this.#errors.set(id, error);
      const isError = error instanceof Error;
      const name = isError && error.constructor !== Error && typeof error.code !== "string" ? error.constructor?.name : "Error";
      return ctx.newString(this.#reply("e", {
        id,
        name: name ?? "Error",
        message: isError ? error.message : String(error),
        ...(isError && typeof error.code === "string" ? { code: error.code } : {}),
      }));
    }
  }

  // ---------- รัน 1 call ----------

  /**
   * @returns {{ kind: "value", value } | { kind: "throw", hostError } | { kind: "throw", guestError: { name, message, stack } }
   *          | { kind: "throw", fakeTimeout: true } | { kind: "throw", text } | { kind: "async" } | { kind: "fatal" }}
   */
  invoke({ programUuid, source, functionName, params, api, blockNumber = null }) {
    try {
      this.#begin();
      return this.#invoke({ programUuid, source, functionName, params, api, blockNumber });
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) brokenReason = error.message;
      throw error;
    }
  }

  #invoke({ programUuid, source, functionName, params, api, blockNumber }) {
    const tx = this.#tx;
    const entry = this.#context(programUuid, source);
    if (this.outOfMemory || !this.#hasHeadroom()) return this.#fatal();
    if (this.timedOut) return this.#timeout();
    if (entry.error) return { kind: "throw", guestError: { ...entry.error, stack: null } };
    const { ctx } = entry;
    const handles = [
      ctx.newString(functionName),
      ctx.newString(encodeForGuest(params)),
      ctx.newString(programUuid),
      ctx.newString(blockNumber === null ? "" : String(blockNumber)),
      ctx.newNumber(tx.gasLimit - tx.gasUsed),
    ].map((handle) => Sandbox.#temp(handle));
    this.#stack.push({ api });
    let result;
    try {
      result = ctx.callFunction(entry.invoke, ctx.undefined, entry.factory, ...handles);
    } finally {
      this.#stack.pop();
      for (const handle of handles) Sandbox.#drop(handle);
    }
    if (result.error) {
      const error = readError(ctx, result.error);
      if (this.outOfMemory) return this.#fatal();
      if (tx.fatal) return { kind: "fatal" };
      if (this.timedOut || (error.name === "InternalError" && error.message === "interrupted")) return this.#timeout();
      return { kind: "throw", guestError: { ...error, stack: null } };   // error ใน prelude เอง (เช่น stack ล้นตอนส่งผล)
    }
    const text = ctx.getString(result.value);
    result.value.dispose();
    if (this.outOfMemory) return this.#fatal();
    if (text === "f") {
      if (!tx.fatal) tx.abort(this.timedOut ? "timeout" : "memory");
      return { kind: "fatal" };
    }
    const bar = text.indexOf("|");
    const pending = Number(text.slice(1, bar));
    if (pending > 0) tx.useGas(pending);   // ไม่เกินยอดที่เหลือเสมอ (เกินถูกส่งมาให้ตรวจทันทีแล้ว)
    const body = text.slice(bar + 1);
    switch (text[0]) {
      case "v": return { kind: "value", value: decodeFromGuest(body, this.#options.map) };
      case "a": return { kind: "async" };
      default: return this.#describeThrow(JSON.parse(body));
    }
  }

  #fatal() {
    this.#releaseReserve();
    this.#tx.abort("memory");
    return { kind: "fatal" };
  }

  #timeout() {
    this.#tx.abort("timeout");
    return { kind: "fatal" };
  }

  #describeThrow(desc) {
    switch (desc.t) {
      case "h": return { kind: "throw", hostError: this.#errors.get(desc.id) };
      case "t": return { kind: "throw", fakeTimeout: true };
      case "e": {
        let name = decodeFromGuest(JSON.stringify(desc.name), this.#options.map);
        const message = decodeFromGuest(JSON.stringify(desc.message), this.#options.map);
        // ข้อความของ QuickJS → ชื่อแบบเดียวกับ V8 (ข้อความจริงของ engine ไม่ถูกส่งออกอยู่แล้ว)
        if (name === "InternalError" && (message === "stack overflow" || message === "string too long")) name = "RangeError";
        return { kind: "throw", guestError: { name, message, stack: desc.stack } };
      }
      default: return { kind: "throw", text: String(desc.text) };
    }
  }

  // ---------- เก็บกวาด ----------

  /** คืน handle / context ที่สร้างใน tx แล้วปล่อย heap (memory จริงถูกล้างตอน tx ถัดไปคืน snapshot) */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    if (!this.#active) return;
    try {
      for (const handle of this.#owned) if (handle.alive) handle.dispose();
      for (const slot of this.#extra) slot.ctx.dispose();
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) brokenReason = error.message;
      throw error;
    } finally {
      sandboxStats.handles -= this.#owned.length;
      sandboxStats.extraContexts -= this.#extra.length;
      sandboxStats.active -= 1;
      this.#owned = [];
      this.#extra = [];
      this.#programs.clear();
      this.#errors.clear();
      this.#reserve = 0;
      this.#active = false;
      memoryLocked = false;
      current = null;
    }
  }
}
