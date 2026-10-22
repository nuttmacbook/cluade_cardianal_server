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
 *   tx ล้มกลางทาง (หน่วยความจำเกิน) → ยอดค้างส่งกลับใน "f<n>|" ให้ host คิดด้วย
 *
 * แก๊สตามขนาดข้อมูล (prelude): builtin ต่อหน่วย · 1 หน่วย = 1 สมาชิก / property หรือ 32 ตัวอักษร / byte (ปัดขึ้น)
 *   เมธอดในตัวที่คัดลอก / สร้างข้อมูลถูกห่อไว้ก่อนโค้ดของผู้ใช้รัน (ของจริงอยู่ใน closure เท่านั้น) → เรียกทางไหนก็คิดเท่ากัน
 *   __spread (spread / rest ของ array) · __props (spread / rest ของ object) · __str (string จาก + / +=) — gasmeter.js แทรกให้
 *   iterator ในตัวของ array / string / Set / Map ถูกล็อก → __spread รู้แน่ว่า engine จะคัดลอกกี่สมาชิก (คัดลอกแบบเร็วเหมือนเดิม)
 *   ArrayBuffer / typed array / RegExp / Set / Map / WeakSet / WeakMap / AggregateError ถูกห่อด้วย Proxy (global + prototype.constructor)
 *   Proxy ที่โปรแกรมสร้างถูกจดไว้ (ownKeys / length ตอบไม่เหมือนกันได้ทุกครั้ง → คัดลอกเองทีละ property)
 *
 * แก๊สตามงาน CPU ของ BigInt (prelude "BigInt" · เทสต์ 81): operator ที่ gasmeter.js แปลงเป็น __mul / __lt … คิดตามจำนวน word 64 bit
 *   ค่า ≤ 512 bit ไม่คิดเพิ่ม · งานที่รู้ขนาดล่วงหน้า (** / << / * / แปลง string) คิดก่อนทำ · ผลเกิน BIGINT_MAX_BITS (8192 bit) = RangeError
 *   (เพดานกันงานที่ engine ทำเองโดยไม่ผ่านตัวนับ: แปลง BigInt เป็น string ข้างในเมธอดในตัว ≈ W² — 8192 bit ≈ 0.4 ms ต่อครั้ง)
 *   ทุกทางที่ engine แปลง BigInt ↔ string ถูกคิดก่อน: operator / ชื่อ property / ค่าที่ฟังก์ชันคืน / เมธอดในตัวที่รับหรือคืน BigInt
 * regular expression ปิดทั้งหมด (RegExp / match / matchAll / search / exec / test …) — backtrack แบบ exponential คิดแก๊สล่วงหน้าไม่ได้
 *
 * หน่วยความจำ: memory limit ในตัว QuickJS ใช้ไม่ได้บน emscripten (นับแค่ 8 ไบต์ต่อก้อน) จึงคุมที่ heap ของ WebAssembly แทน
 *   ต้น tx (หลังคืน snapshot): จองก้อน "ลูกโป่ง" ให้เหลือที่ว่างพอดี memoryLimitBytes + สำรองของ host แล้วล็อกไม่ให้ memory โต
 *   → malloc ล้มที่จุดเดียวกันทุกเครื่อง (ไม่ขึ้นกับขนาด memory ที่เคยโตไว้) · ล็อกโดนแตะเมื่อไร = OUT_OF_MEMORY (catch ไม่ได้)
 */
import { getQuickJS, newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from "quickjs-emscripten";
import { BIGINT_MAX_BITS } from "./gasmeter.js";

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
  ["keccak256Bytes", "p"], ["ecrecoverDigest", "pp"], ["eip712Digest", "ddpd"], ["eip712DomainSeparator", "dd"],
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
  const { keys, getPrototypeOf, freeze, defineProperty, hasOwn, getOwnPropertyDescriptor } = Object;
  const ObjectProto = Object.prototype;
  const ArrayProto = Array.prototype;
  const SymbolIterator = Symbol.iterator;
  const isArray = Array.isArray;
  const { apply, construct, get: reflectGet, ownKeys } = Reflect;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const NumberFn = Number;
  const BigIntFn = BigInt;
  const StringFn = String;
  const ArrayBufferFn = ArrayBuffer;
  const SharedArrayBufferFn = typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : null;
  const isView = ArrayBuffer.isView;
  const TypedArray = getPrototypeOf(Int8Array);
  const typedLength = getOwnPropertyDescriptor(TypedArray.prototype, "length").get;
  const viewByteLength = getOwnPropertyDescriptor(DataView.prototype, "byteLength").get;
  const bufferByteLength = getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
  const sharedByteLength = SharedArrayBufferFn && getOwnPropertyDescriptor(SharedArrayBufferFn.prototype, "byteLength").get;
  const setSize = getOwnPropertyDescriptor(Set.prototype, "size").get;
  const mapSize = getOwnPropertyDescriptor(Map.prototype, "size").get;
  const fnToString = Function.prototype.toString;
  const ProxyFn = Proxy;
  const proxyRevocable = Proxy.revocable;
  const DateFn = Date;
  const MathObj = Math;
  const ceil = Math.ceil;
  const floor = Math.floor;
  const WeakMapFn = WeakMap;
  const WeakSetFn = WeakSet;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;
  const wmHas = WeakMap.prototype.has;
  const wsAdd = WeakSet.prototype.add;
  const wsHas = WeakSet.prototype.has;
  const indexOf = String.prototype.indexOf;
  const ErrorFn = Error;
  const EvalErrorFn = EvalError;
  const TypeErrorFn = TypeError;
  const RangeErrorFn = RangeError;
  const ObjectFn = Object;
  const SymbolToPrimitive = Symbol.toPrimitive;
  const BigIntProto = BigInt.prototype;
  const bigintValueOf = BigInt.prototype.valueOf;
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
  let ACT = null;     // ตัวนับแก๊สของ call ที่กำลังรันใน context นี้ (invoke ตั้ง / คืนค่าเดิมเมื่อจบ — เรียกซ้อนกลับมาโปรแกรมเดิมได้)

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
      case "bigint":
        chargeConv(value);
        return '{"\\u0000":"b","v":"' + value + '"}';
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
      if (tag === "b") return reviveBigInt(node.v);
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
  /** BigInt จาก host (input ของ tx / ค่าใน DB): ยาวเกินเพดาน = RangeError ก่อนแปลง · ค่าแปลงสะสมไว้คิดหลังรู้ยอดแก๊สล่าสุด */
  let reviveUnits = 0;
  function reviveBigInt(text) {
    if (text.length > MAX_DIGITS) throw new RangeErrorFn(CAP_MESSAGE);
    reviveUnits += parseUnits(text);
    return checked(BigIntFn(text));
  }
  /** คิดค่าแปลง BigInt ที่ decode สะสมไว้ */
  function chargeRevive() {
    const units = reviveUnits;
    reviveUnits = 0;
    if (units > 0) chargeBig(units);
  }

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
    reviveUnits = 0;
    const message = decode(reply);
    act.budget = message[1];
    chargeRevive();
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

  // ---- แก๊สตามขนาดข้อมูล (ราคา BUILTIN_GAS ต่อ "หน่วย") ----
  //   1 หน่วย = 1 สมาชิก (array / typed array / Set / Map / property ของ object / argument) หรือ 32 ตัวอักษร / 32 byte (ปัดขึ้น)
  //   ตัวเลข / BigInt / boolean / function / null / undefined = 1 หน่วย
  // คิดก่อนทำงานเมื่อรู้ขนาดล่วงหน้า (ข้อมูลเข้า, repeat / padStart / ArrayBuffer(n) …) และคิดขนาดผลลัพธ์อีกครั้งหลังทำ
  const CHUNK = 32;
  const STRING_MAX = 1073741823;   // ความยาว string สูงสุดของ QuickJS — เกินนี้ engine throw RangeError เอง (ไม่คิดแก๊สล่วงหน้า)
  const BYTES_MAX = 2147483647;    // ขนาด ArrayBuffer สูงสุด — เกินนี้ engine throw RangeError เอง
  const textUnits = (length) => ceil(length / CHUNK);
  /** จำนวนเต็ม ≥ 0 จากค่าใดก็ได้ (แบบ ToIntegerOrInfinity ที่ติดลบ / NaN = 0) */
  const toCount = (value) => {
    const n = NumberFn(value);
    return n > 0 ? floor(n) : 0;
  };
  function brandSize(getter, value) {
    try {
      return apply(getter, value, []);
    } catch {
      return -1;
    }
  }
  function sizeOf(value) {
    switch (typeof value) {
      case "string": return textUnits(value.length);
      case "object": break;
      case "bigint": return isSmall(value) ? 1 : convUnits(value);   // เมธอดในตัวที่รับ BigInt อาจแปลงเป็น string (W²)
      default: return 1;
    }
    if (value === null) return 1;
    if (isArray(value)) return toCount(value.length);
    if (isView(value)) {
      const length = brandSize(typedLength, value);
      return length >= 0 ? length : textUnits(apply(viewByteLength, value, []));
    }
    let proto = getPrototypeOf(value);
    for (let depth = 0; proto !== null && proto !== ObjectProto && depth < 32; depth++) {
      let size = -1;
      if (proto === SetProto) size = brandSize(setSize, value);
      else if (proto === MapProto) size = brandSize(mapSize, value);
      else if (proto === BufferProto) size = textUnitsOf(bufferByteLength, value);
      else if (proto === SharedProto) size = textUnitsOf(sharedByteLength, value);
      else if (proto === BigIntProto) {
        const inner = brandSize(bigintValueOf, value);
        if (typeof inner === "bigint") size = sizeOf(inner);
      }
      if (size >= 0) return size;
      proto = getPrototypeOf(proto);
    }
    return keys(value).length;
  }
  const SetProto = Set.prototype;
  const MapProto = Map.prototype;
  const BufferProto = ArrayBuffer.prototype;
  const SharedProto = SharedArrayBufferFn ? SharedArrayBufferFn.prototype : null;
  function textUnitsOf(getter, value) {
    const bytes = brandSize(getter, value);
    return bytes >= 0 ? textUnits(bytes) : -1;
  }

  /** ส่งยอดค้างให้ host (เกินยอดที่เหลือ → host ตอบ "f" = OUT_OF_GAS) */
  function hostCall(act, op, payload) {
    if (dead) throw DEAD;
    const pending = act.pending;
    act.pending = 0;
    return receive(act, host(op, pending, payload));
  }
  function chargeGas(act, amount) {
    if (dead) throw DEAD;
    act.pending += amount;
    if (act.pending > act.budget) hostCall(act, OP.sync, "");
  }
  /** คิดแก๊สตามจำนวนหน่วยให้ call ที่กำลังรัน (ไม่มี call = โค้ดของ VM เอง ไม่คิด) */
  function chargeUnits(units) {
    if (dead) throw DEAD;
    if (ACT !== null && units > 0 && BUILTIN_GAS !== 0) chargeGas(ACT, units * BUILTIN_GAS);
  }

  // ---- BigInt: แก๊สตามงานของ CPU (เทสต์ 81) ----
  // W = จำนวน word 64 bit ของค่าสัมบูรณ์ (อย่างน้อย 1) · ค่าที่ ≤ 512 bit ไม่คิดเพิ่ม → แก๊สของโปรแกรมทั่วไปเท่าเดิม
  // ราคา (builtin ต่อหน่วย) เมื่อตัวตั้งหรือผลลัพธ์ > 512 bit (ขั้นต่ำ BIG_BASE = 16: ค่าวัดขนาด + จองหน่วยความจำ):
  //   + −    16 (≤ 1024 bit) · 64 (ใหญ่กว่า)                        — คิดหลังทำ (ตัวตั้งไม่เกินเพดาน งานต่อครั้งจึงจำกัด)
  //   ×      ⌈Wa·Wb / 4⌉                                            — คิดหลังทำ (≤ 128 × 128 word ≈ 0.1 ms)
  //   ÷ %    ⌈max(1, Wa − Wb + 1) · Wb / 4⌉                         — คิดหลังทำ
  //   **     ⌈Wr² / 4⌉ (Wr = word ของผลลัพธ์จาก bit × exponent)       — คิดก่อนคำนวณ: 2n ** 10n ** 9n หมดแก๊สทันที
  //   << >>  ⌈Wr / 2⌉                                               — คิดก่อนคำนวณ
  //   BigInt → string (ทุกฐาน) W² · string → BigInt W² (W = ⌈ความยาว / 19⌉) — คิดก่อนแปลง
  // ผลเกิน BIG_BITS → RangeError: engine แปลง BigInt เป็น string เองได้หลายที่ที่ไม่ผ่านตัวนับ (เช่น ข้างในเมธอดในตัวที่ไม่ได้ห่อ)
  //   เพดานทำให้งานที่หลุดตัวนับแบบใดก็ตามใช้เวลาไม่เกิน ~0.4 ms ต่อครั้ง (8192 bit) แทนที่จะเป็นวินาที (QuickJS รับได้ถึง ~1M bit)
  // ขนาดวัดด้วย Number(x) (เร็วกว่าเทียบ BigInt) — ปัดเศษตรงขอบ 2^k ได้ แต่ได้ค่าเดียวกันทุกเครื่อง (wasm + IEEE 754)
  const BIG_BITS = OP.bigBits;
  const SMALL_WORDS = 8;
  const BIG_BASE = 16;
  const MAX_DIGITS = ceil(BIG_BITS * 0.30103) + 1;   // ตัวอักษรของเลขฐาน 10 ที่ยาวที่สุดที่ไม่เกินเพดาน (รวมเครื่องหมาย)
  const MAX_UNITS = 4503599627370496;                // 2^52 — ค่าที่ใหญ่กว่านี้หมดแก๊สแน่นอนอยู่แล้ว
  const CAP_MESSAGE = "BigInt ใหญ่เกิน " + BIG_BITS + " bit (1024 ไบต์)";
  const SMALL_FLOAT = 2 ** 512;
  const TWO_32 = 4294967296;
  const SAFE = 9007199254740992;   // 2^53
  const MAX_INDEX = 9007199254740991;
  const LIMIT = BigIntFn(1) << BigIntFn(BIG_BITS);
  const NLIMIT = -LIMIT;
  const SHIFT_STEP = BigIntFn(1000);
  const clz32 = MathObj.clz32;
  const log2 = MathObj.log2;
  const isInfinite = (n) => n === Infinity || n === -Infinity;

  /** |x| < 2^512 (ตามค่า number ที่ปัดแล้ว) */
  function isSmall(x) {
    const n = NumberFn(x);
    return n < SMALL_FLOAT && n > -SMALL_FLOAT;
  }
  /** จำนวน bit ของ |x|: ตรงทุกค่าที่ < 2^53 · ใหญ่กว่านั้นอาจเกินจริง 1 bit (number ปัดขึ้นเป็น 2^k) */
  function bitsOf(x) {
    let n = NumberFn(x);
    let base = 0;
    while (isInfinite(n)) {   // ≥ 2^1024: เลื่อนลงทีละ 1000 bit (ค่าไม่เกินเพดาน → ไม่เกิน 9 รอบ)
      x = x >> SHIFT_STEP;
      base += 1000;
      n = NumberFn(x);
    }
    if (n < 0) n = -n;
    if (n < TWO_32) return base + 32 - clz32(n);
    if (n < SAFE) return base + 64 - clz32(floor(n / TWO_32));
    return base + floor(log2(n)) + 1;
  }
  function wordsOf(x) {
    const bits = bitsOf(x);
    return bits > 64 ? ceil(bits / 64) : 1;
  }
  function chargeBig(units) {
    if (units > 0) chargeUnits(units < MAX_UNITS ? ceil(units) : MAX_UNITS);
  }
  /** BigInt → string: W² (ค่า ≤ 512 bit = 0) */
  function convUnits(x) {
    if (isSmall(x)) return 0;
    const words = wordsOf(x);
    return words * words;
  }
  function chargeConv(x) {
    const units = convUnits(x);
    if (units > 0) chargeBig(units);
  }
  /** string → BigInt: W² จากความยาว (ฐาน 10 ≈ 19 ตัวอักษรต่อ word · ฐานอื่นคิดเท่ากัน)
   *  ≤ 171 ตัวอักษร (9 word: ค่า 512 bit ยาว 155 หลัก) ไม่คิดเพิ่ม เหมือนค่า ≤ 512 bit ของ BigInt → string */
  function parseUnits(text) {
    const words = ceil(text.length / 19);
    return words > SMALL_WORDS + 1 ? words * words : 0;
  }
  function overLimit() {
    throw new RangeErrorFn(CAP_MESSAGE);
  }
  function capped(r) {
    if (r < LIMIT && r > NLIMIT) return r;
    return overLimit();
  }
  /** ผลที่ไม่รู้ว่าเล็ก: ตรวจเพดานเฉพาะค่าที่ใหญ่ (ทางเร็วของค่าเล็กไม่ต้องเทียบ BigInt) */
  const checked = (r) => (isSmall(r) ? r : capped(r));
  /** + − ของค่าใหญ่: 16 (≤ ~1024 bit) / 64 */
  function linearCost(a, r) {
    chargeBig(isInfinite(NumberFn(a)) || isInfinite(NumberFn(r)) ? 64 : BIG_BASE);
    return capped(r);
  }
  function productCost(a, b, r) {
    const units = (wordsOf(a) * wordsOf(b)) / 4;
    chargeBig(units > BIG_BASE ? units : BIG_BASE);
    return capped(r);
  }
  function quotientCost(a, b) {
    const wb = wordsOf(b);
    const quotient = wordsOf(a) - wb + 1;
    const units = ((quotient > 1 ? quotient : 1) * wb) / 4;
    chargeBig(units > BIG_BASE ? units : BIG_BASE);
  }

  // ToPrimitive ตามมาตรฐาน (เรียก valueOf / toString / @@toPrimitive ของโปรแกรมครั้งเดียวเหมือน engine) →
  // operator ได้ค่าพื้นฐานก่อน engine จะแปลง string ↔ BigInt เอง
  const isObject = (value) => (typeof value === "object" && value !== null) || typeof value === "function";
  function toPrimitive(value, hint) {
    const exotic = value[SymbolToPrimitive];
    if (exotic !== undefined && exotic !== null) {
      if (typeof exotic !== "function") throw new TypeErrorFn("Symbol.toPrimitive is not a function");
      const result = apply(exotic, value, [hint]);
      if (isObject(result)) throw new TypeErrorFn("cannot convert object to primitive value");
      return result;
    }
    const first = hint === "string" ? "toString" : "valueOf";
    const second = hint === "string" ? "valueOf" : "toString";
    let method = value[first];
    if (typeof method === "function") {
      const result = apply(method, value, []);
      if (!isObject(result)) return result;
    }
    method = value[second];
    if (typeof method === "function") {
      const result = apply(method, value, []);
      if (!isObject(result)) return result;
    }
    throw new TypeErrorFn("cannot convert object to primitive value");
  }
  /** BigInt / object → ค่าที่ใช้เป็นชื่อ property (BigInt = แปลงเป็นเลขฐาน 10: W²) */
  function toKey(key) {
    if (typeof key === "bigint") {
      chargeConv(key);
      return key;
    }
    if (isObject(key)) {
      const primitive = toPrimitive(key, "string");
      if (typeof primitive === "bigint") chargeConv(primitive);
      return primitive;
    }
    return key;
  }
  /** ToString ของ engine (symbol → TypeError) โดยคิดค่าแปลง BigInt ก่อน */
  function toText(value) {
    switch (typeof value) {
      case "string": return value;
      case "bigint":
        chargeConv(value);
        return StringFn(value);
      case "symbol": throw new TypeErrorFn("cannot convert symbol to string");
      default: return StringFn(value);
    }
  }
  /** BigInt เทียบกับ string → engine แปลง string เป็น BigInt (W²) */
  function parseCost(a, b) {
    if (typeof a === "bigint") {
      if (typeof b === "string") chargeBig(parseUnits(b));
    } else if (typeof b === "bigint" && typeof a === "string") chargeBig(parseUnits(a));
  }

  // operator (gasmeter.js แปลง a OP b → __op(a, b)) · number ล้วนทำทันที · object → ToPrimitive ก่อนแบบ engine
  function bigAdd(a, b) {
    if (typeof a === "number" && typeof b === "number") return a + b;
    if (isObject(a)) a = toPrimitive(a, "default");
    if (isObject(b)) b = toPrimitive(b, "default");
    if (typeof a === "bigint") {
      if (typeof b === "bigint") {
        // ผลเล็กและ a เล็ก → b เล็กด้วย (|b| ≤ |a| + |a + b|)
        const r = a + b;
        return isSmall(r) && isSmall(a) ? r : linearCost(a, r);
      }
      if (typeof b === "string") chargeConv(a);
    } else if (typeof b === "bigint" && typeof a === "string") chargeConv(b);
    const r = a + b;
    if (typeof r === "string") chargeUnits(textUnits(r.length));   // แบบ __str เดิม
    return r;
  }
  function bigSub(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (isObject(a)) {
      a = toPrimitive(a, "number");
      if (typeof a === "symbol") return a - b;   // engine throw ก่อนแปลงตัวขวา
    }
    if (isObject(b)) b = toPrimitive(b, "number");
    const r = a - b;   // BigInt − BigInt เท่านั้นที่ได้ BigInt (ผสมกับ number = TypeError)
    return typeof r !== "bigint" || (isSmall(r) && isSmall(a)) ? r : linearCost(a, r);
  }
  function bigMul(a, b) {
    if (typeof a === "number" && typeof b === "number") return a * b;
    if (isObject(a)) {
      a = toPrimitive(a, "number");
      if (typeof a === "symbol") return a * b;
    }
    if (isObject(b)) b = toPrimitive(b, "number");
    // ตัวตั้งไม่เกินเพดาน → งานต่อครั้ง ≤ 128 × 128 word (~0.1 ms) จึงคำนวณก่อนแล้วคิดตามขนาดได้
    const r = a * b;   // ผลเล็ก → ตัวตั้งเล็กทั้งคู่ (หรือมี 0)
    return typeof r !== "bigint" || isSmall(r) ? r : productCost(a, b, r);
  }
  function bigDivide(a, b, modulo) {
    if (isObject(a)) {
      a = toPrimitive(a, "number");
      if (typeof a === "symbol") return modulo ? a % b : a / b;
    }
    if (isObject(b)) b = toPrimitive(b, "number");
    // งาน = ผลหาร × ตัวหาร → ไม่คิดเมื่อตัวตั้งเล็กทั้งคู่ (a / b: ผลหารเล็ก + ตัวหารเล็ก = ตัวตั้งเล็ก)
    if (modulo) {
      const r = a % b;
      if (typeof r === "bigint" && !(isSmall(a) && isSmall(b))) quotientCost(a, b);
      return r;
    }
    const r = a / b;
    if (typeof r === "bigint" && !(isSmall(r) && isSmall(b))) quotientCost(a, b);
    return r;
  }
  function bigDiv(a, b) {
    if (typeof a === "number" && typeof b === "number") return a / b;
    return bigDivide(a, b, false);
  }
  function bigMod(a, b) {
    if (typeof a === "number" && typeof b === "number") return a % b;
    return bigDivide(a, b, true);
  }
  function bigPow(a, b) {
    if (typeof a === "number" && typeof b === "number") return a ** b;
    if (isObject(a)) {
      a = toPrimitive(a, "number");
      if (typeof a === "symbol") return a ** b;
    }
    if (isObject(b)) b = toPrimitive(b, "number");
    if (typeof a !== "bigint" || typeof b !== "bigint") return a ** b;
    const base = NumberFn(a);
    const exponent = NumberFn(b);
    // exponent < 2 (ติดลบ = RangeError) หรือฐาน 0 / ±1 → ผลไม่โต engine ทำเร็วเอง
    if (exponent < 2 || (base < 2 && base > -2)) return a ** b;
    const bits = bitsOf(a);
    const words = ceil((bits * exponent) / 64);   // ผลลัพธ์ ≤ bits × exponent bit
    if (words > SMALL_WORDS) {
      const units = (words * words) / 4;
      chargeBig(units > BIG_BASE ? units : BIG_BASE);
    }
    // ผลลัพธ์ ≥ (bits − 1) × exponent + 1 bit (bits ของค่า ≥ 2^53 อาจเกินจริง 1 → หักเผื่อ) → เกินแน่นอนไม่ต้องคำนวณ
    if ((bits - (base < SAFE && base > -SAFE ? 1 : 2)) * exponent + 1 > BIG_BITS) return overLimit();
    return checked(a ** b);   // ถึงตรงนี้ผลลัพธ์ ≤ ~2 เท่าของเพดาน → งานจำกัด
  }
  function bigShift(a, b, left) {
    if (isObject(a)) {
      a = toPrimitive(a, "number");
      if (typeof a === "symbol") return left ? a << b : a >> b;
    }
    if (isObject(b)) b = toPrimitive(b, "number");
    if (typeof a === "bigint" && typeof b === "bigint") {
      const value = NumberFn(a);
      const amount = left ? NumberFn(b) : -NumberFn(b);   // จำนวน bit ที่เลื่อนไปทางซ้าย (>> ด้วยค่าติดลบ = เลื่อนซ้าย)
      if (value === 0) return left ? a << b : a >> b;
      if (amount > 0) {
        const bits = bitsOf(a);
        const words = ceil((bits + amount) / 64);
        if (words > SMALL_WORDS) chargeBig(words / 2 > BIG_BASE ? words / 2 : BIG_BASE);
        if (bits - (value < SAFE && value > -SAFE ? 0 : 1) + amount > BIG_BITS) return overLimit();
        return checked(left ? a << b : a >> b);
      }
      if (!isSmall(a)) chargeBig(isInfinite(value) ? 64 : BIG_BASE);   // เลื่อนขวา = งานเส้นตรงตามตัวตั้ง
    }
    return left ? a << b : a >> b;
  }
  function bigShl(a, b) {
    if (typeof a === "number" && typeof b === "number") return a << b;
    return bigShift(a, b, true);
  }
  function bigShr(a, b) {
    if (typeof a === "number" && typeof b === "number") return a >> b;
    return bigShift(a, b, false);
  }
  /** a < b ฯลฯ: ToPrimitive (number) ทั้งสองข้างก่อน แล้วคิดค่าแปลง string → BigInt */
  function relational(a, b) {
    if (typeof a === "object" || typeof a === "function") a = isObject(a) ? toPrimitive(a, "number") : a;
    if (typeof b === "object" || typeof b === "function") b = isObject(b) ? toPrimitive(b, "number") : b;
    parseCost(a, b);
    RELATION[0] = a;
    RELATION[1] = b;
  }
  const RELATION = [undefined, undefined];
  function bigLt(a, b) {
    if (typeof a !== "string" && typeof b !== "string" && typeof a !== "object" && typeof b !== "object"
      && typeof a !== "function" && typeof b !== "function") return a < b;
    relational(a, b);
    return RELATION[0] < RELATION[1];
  }
  function bigGt(a, b) {
    if (typeof a !== "string" && typeof b !== "string" && typeof a !== "object" && typeof b !== "object"
      && typeof a !== "function" && typeof b !== "function") return a > b;
    relational(a, b);
    return RELATION[0] > RELATION[1];
  }
  function bigLe(a, b) {
    if (typeof a !== "string" && typeof b !== "string" && typeof a !== "object" && typeof b !== "object"
      && typeof a !== "function" && typeof b !== "function") return a <= b;
    relational(a, b);
    return RELATION[0] <= RELATION[1];
  }
  function bigGe(a, b) {
    if (typeof a !== "string" && typeof b !== "string" && typeof a !== "object" && typeof b !== "object"
      && typeof a !== "function" && typeof b !== "function") return a >= b;
    relational(a, b);
    return RELATION[0] >= RELATION[1];
  }
  /** a == b: ชนิดเดียวกัน = เทียบตรง ๆ · object กับค่าพื้นฐาน → ToPrimitive (default) ตามมาตรฐาน */
  function bigEq(a, b) {
    if (typeof a === typeof b) return a == b;
    if (isObject(a)) {
      if (b !== null && b !== undefined && !isObject(b)) a = toPrimitive(a, "default");
    } else if (isObject(b) && a !== null && a !== undefined) b = toPrimitive(b, "default");
    parseCost(a, b);
    return a == b;
  }
  const bigNe = (a, b) => !bigEq(a, b);
  /** k in o (o ไม่ใช่ object → TypeError ก่อนแปลง k แบบ engine) */
  function bigIn(key, object) {
    if (!isObject(object)) return key in object;
    return toKey(key) in object;
  }
  /** ค่าที่ฟังก์ชันของโปรแกรมคืนเป็น BigInt ใหญ่ → คิดค่าแปลงเป็น string ไว้ก่อน (ผู้เรียกอาจเป็น engine เช่น valueOf / toString / getter) */
  function bigReturn(value) {
    chargeConv(value);
    return value;
  }
  const COMPOUND_OPS = { "+": bigAdd, "-": bigSub, "*": bigMul, "/": bigDiv, "%": bigMod, "**": bigPow, "<<": bigShl, ">>": bigShr };
  /** o[k] op= y เมื่อ o / k เป็นนิพจน์ซับซ้อน: อ่านค่าเดิมก่อนคำนวณ y ตามมาตรฐาน (y ส่งมาเป็นฟังก์ชัน) */
  function bigCompound(object, key, symbol, rhs) {
    let name = toKey(key);
    if (typeof name === "bigint") name = StringFn(name);   // แปลงครั้งเดียว (คิดแล้วใน toKey)
    const old = object[name];
    const result = COMPOUND_OPS[symbol](old, rhs());
    object[name] = result;
    return result;
  }

  // ---- เมธอดในตัว: ห่อของจริงไว้ (ของเดิมอยู่ใน closure นี้เท่านั้น โค้ดของโปรแกรมเอื้อมไม่ถึง) ----
  // สูตรทั่วไป: ก่อนเรียก = ขนาดของ this + ทุก argument (+ ขนาดที่รู้ล่วงหน้า) · หลังเรียก = ขนาดของผลลัพธ์
  // เรียกทางไหนก็คิดเท่ากัน: a.join() · Array.prototype.join.call(a) · Reflect.apply(…) · const j = a.join · แปลง array เป็น string โดยนัย
  // (Array.prototype.toString / ToPrimitive เรียก this.join → ตัวที่ห่อแล้ว)
  const WRAPPED = new WeakMapFn();     // ตัวห่อ → ของจริง (Function.prototype.toString แสดงของจริง)
  const WRAPPER_OF = new WeakMapFn();  // ของจริง → ตัวห่อ (ฟังก์ชันเดียวกันใน 2 ที่ เช่น trimLeft / trimStart ได้ตัวห่อเดียวกัน)
  // argument ได้ไม่เกิน 65,535 ตัว (เกิน = engine throw RangeError เอง) → คิดไม่เกินนั้น
  const MAX_ARGS = 65536;
  const listUnits = (list) => {
    const n = list !== null && typeof list === "object" ? toCount(list.length) : 0;
    return n < MAX_ARGS ? n : MAX_ARGS;
  };
  // ขนาดที่รู้ก่อนสร้างผลลัพธ์ (ค่าที่อ่านแล้วถูกใส่กลับใน args → engine เห็นค่าเดียวกับที่คิดแก๊ส)
  const EXPECT = new WeakMapFn();
  const expect = (fn, measure) => apply(wmSet, EXPECT, [fn, measure]);
  /**
   * ตัวเลขใน args[index] → ToNumber ครั้งเดียว (valueOf ของโปรแกรมรันครั้งเดียว) แล้วใส่ผลกลับให้ engine ใช้ค่าเดียวกัน
   * คืนจำนวนเต็ม ≥ 0 สำหรับคิดแก๊ส · BigInt / Symbol ไม่แตะ (engine throw TypeError เอง) · ค่าติดลบ / ใหญ่เกินส่งต่อให้ engine throw RangeError
   */
  function countArg(args, index) {
    if (index >= args.length) return 0;
    const value = args[index];
    if (typeof value === "bigint" || typeof value === "symbol") return 0;
    const n = +value;
    args[index] = n;
    return n > 0 ? floor(n) : 0;
  }
  expect(String.prototype.repeat, (self, args) => {
    const total = typeof self === "string" ? self.length * countArg(args, 0) : 0;
    return total <= STRING_MAX ? textUnits(total) : 0;
  });
  const padTo = (self, args) => {
    const n = countArg(args, 0);
    return n <= STRING_MAX ? textUnits(n) : 0;
  };
  expect(String.prototype.padStart, padTo);
  expect(String.prototype.padEnd, padTo);
  const fromLength = (self, args) => (args[0] !== null && typeof args[0] === "object" ? toCount(args[0].length) : 0);
  expect(Array.from, fromLength);
  expect(TypedArray.from, fromLength);
  const resizeTo = (self, args) => {
    const n = countArg(args, 0);
    return n <= BYTES_MAX ? textUnits(n) : 0;
  };
  if (BufferProto.resize) expect(BufferProto.resize, resizeTo);
  if (SharedProto?.grow) expect(SharedProto.grow, resizeTo);
  // คิดแทนสูตรทั่วไป (ไม่นับ this / ตัวอื่น): apply / construct คัดลอก array ของ argument
  const MEASURE = new WeakMapFn();
  apply(wmSet, MEASURE, [Function.prototype.apply, (self, args) => listUnits(args[1])]);
  apply(wmSet, MEASURE, [Reflect.apply, (self, args) => 1 + listUnits(args[2])]);
  apply(wmSet, MEASURE, [Reflect.construct, (self, args) => 1 + listUnits(args[1])]);
  const PROMISE_ALL = ["all", "allSettled", "any", "race"];
  for (let i = 0; i < PROMISE_ALL.length; i++) apply(wmSet, MEASURE, [Promise[PROMISE_ALL[i]], (self, args) => spreadFirst(args)]);

  function meterMethod(target, key) {
    const desc = getOwnPropertyDescriptor(target, key);
    if (desc === undefined || typeof desc.value !== "function") return;
    const original = desc.value;
    let wrapper = apply(wmGet, WRAPPER_OF, [original]);
    if (wrapper === undefined) {
      const extra = apply(wmGet, EXPECT, [original]);
      const measure = apply(wmGet, MEASURE, [original]);
      const name = typeof key === "symbol" ? "[" + key.description + "]" : key;
      wrapper = { [name](...args) {
        if (dead) throw DEAD;
        const metering = ACT !== null && BUILTIN_GAS !== 0;
        let prepaid = 0;   // ขนาดผลลัพธ์ที่คิดล่วงหน้าแล้ว (repeat / padStart …) → หลังทำคิดเฉพาะส่วนที่เกิน
        if (metering) {
          let units;
          if (measure !== undefined) units = measure(this, args);
          else {
            units = sizeOf(this);
            for (let i = 0; i < args.length; i++) units += sizeOf(args[i]);
            if (extra !== undefined) {
              prepaid = extra(this, args);
              units += prepaid;
            }
          }
          chargeUnits(units);
        }
        const result = apply(original, this, args);
        // apply / construct: ผลลัพธ์คือผลของฟังก์ชันปลายทาง (คิดเองแล้วถ้าเป็นเมธอดในตัว) → ไม่คิดซ้ำ
        if (metering && measure === undefined) chargeUnits(sizeOf(result) - prepaid);
        return result;
      } }[name];
      defineProperty(wrapper, "length", { value: original.length, writable: false, enumerable: false, configurable: true });
      const native = apply(wmGet, WRAPPED, [original]);   // ตัวที่เขียนใหม่ (join …) → แสดงของจริงของ engine
      apply(wmSet, WRAPPED, [wrapper, native === undefined ? original : native]);
      apply(wmSet, WRAPPER_OF, [original, wrapper]);
    }
    defineProperty(target, key, { value: wrapper, writable: desc.writable, enumerable: desc.enumerable, configurable: desc.configurable });
  }

  // ---- เมธอดในตัวที่ engine แปลงค่าที่อ่านจาก property เป็น string เอง (BigInt ใน array / message ของ error …) ----
  // เขียนใหม่ตามมาตรฐานทีละขั้น (อ่านแต่ละค่าครั้งเดียว) แล้วคิดค่าแปลง BigInt ก่อน · ตัวห่อ (meterMethod) คิดแก๊สตามขนาดเท่าเดิม
  const nativeJoin = ArrayProto.join;
  const toLength = (value) => {
    const n = +value;   // BigInt → TypeError เหมือน ToLength
    if (!(n > 0)) return 0;
    return n < MAX_INDEX ? floor(n) : MAX_INDEX;
  };
  const requireObject = (value) => {
    if (value === null || value === undefined) throw new TypeErrorFn("cannot convert undefined or null to object");
    return ObjectFn(value);
  };
  const IMPLEMENTED = [
    [ArrayProto, { join(separator) {
      const object = requireObject(this);
      const length = toLength(object.length);
      const sep = separator === undefined ? "," : toText(separator);
      const parts = [];
      for (let k = 0; k < length; k++) {
        const element = object[k];
        parts[k] = element === undefined || element === null ? "" : toText(element);
      }
      return apply(nativeJoin, parts, [sep]);
    } }.join],
    [ArrayProto, { sort(comparefn) {
      return apply(nativeSort, this, [comparefn === undefined ? compareText : comparefn]);
    } }.sort],
    [ArrayProto, { toSorted(comparefn) {
      return apply(nativeToSorted, this, [comparefn === undefined ? compareText : comparefn]);
    } }.toSorted],
    [Object, { fromEntries(iterable) {
      requireObject(iterable);
      const out = {};
      const iterator = iterable[SymbolIterator]();
      const next = iterator.next;
      for (;;) {
        const step = apply(next, iterator, []);
        if (!isObject(step)) throw new TypeErrorFn("iterator result is not an object");
        if (step.done) return out;
        const entry = step.value;
        try {
          if (!isObject(entry)) throw new TypeErrorFn("iterator value is not an entry object");
          const key = entry[0];
          const value = entry[1];
          defineProperty(out, toKey(key), { value, writable: true, enumerable: true, configurable: true });
        } catch (error) {
          try {
            const close = iterator.return;
            if (close !== undefined && close !== null) apply(close, iterator, []);
          } catch {
            // error เดิมสำคัญกว่า (ตามมาตรฐาน)
          }
          throw error;
        }
      }
    } }.fromEntries],
    [Error.prototype, { toString() {
      if (!isObject(this)) throw new TypeErrorFn("not an object");
      let name = this.name;
      name = name === undefined ? "Error" : toText(name);
      let message = this.message;
      message = message === undefined ? "" : toText(message);
      if (name === "") return message;
      if (message === "") return name;
      return name + ": " + message;
    } }.toString],
    [String, { raw(template, ...substitutions) {
      const literals = requireObject(requireObject(template).raw);
      const length = toLength(literals.length);
      let out = "";
      for (let i = 0; i < length; i++) {
        out += toText(literals[i]);
        if (i + 1 < length && i < substitutions.length) out += toText(substitutions[i]);
      }
      return out;
    } }.raw],
  ];
  const nativeSort = ArrayProto.sort;
  const nativeToSorted = ArrayProto.toSorted;
  /** ลำดับปริยายของ sort: เทียบแบบ string (คิดค่าแปลง BigInt ทุกครั้งที่ engine จะแปลง) */
  function compareText(x, y) {
    const a = toText(x);
    const b = toText(y);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  for (let i = 0; i < IMPLEMENTED.length; i++) {
    const target = IMPLEMENTED[i][0];
    const impl = IMPLEMENTED[i][1];
    const name = impl.name;
    const original = target[name];
    defineProperty(impl, "length", { value: original.length, writable: false, enumerable: false, configurable: true });
    apply(wmSet, WRAPPED, [impl, original]);   // Function.prototype.toString แสดงของจริง
    define(target, name, impl);
  }

  const ARRAY_METHODS = ["copyWithin", "every", "fill", "filter", "find", "findIndex", "findLast", "findLastIndex", "forEach", "includes",
    "indexOf", "join", "lastIndexOf", "map", "reduce", "reduceRight", "reverse", "slice", "some", "sort", "toLocaleString",
    "toReversed", "toSorted", "with"];
  const METERED = [
    [Array, ["from", "of"]],
    [Array.prototype, ARRAY_METHODS.concat(["concat", "flat", "flatMap", "shift", "splice", "toSpliced", "unshift"])],
    [TypedArray, ["from", "of"]],
    [TypedArray.prototype, ARRAY_METHODS.concat(["set"])],
    [String, ["fromCharCode", "fromCodePoint", "raw"]],
    [String.prototype, ["concat", "endsWith", "includes", "indexOf", "isWellFormed", "lastIndexOf", "localeCompare",
      "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "slice", "split", "startsWith", "substr", "substring",
      "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toUpperCase", "toWellFormed", "trim", "trimEnd", "trimStart", "trimLeft", "trimRight",
      "anchor", "big", "blink", "bold", "fixed", "fontcolor", "fontsize", "italics", "link", "small", "strike", "sub", "sup"]],
    [Object, ["assign", "create", "defineProperties", "entries", "freeze", "fromEntries", "getOwnPropertyDescriptors", "getOwnPropertyNames",
      "getOwnPropertySymbols", "groupBy", "isFrozen", "isSealed", "keys", "seal", "values"]],
    [Map, ["groupBy"]],
    [Set.prototype, ["difference", "forEach", "intersection", "isDisjointFrom", "isSubsetOf", "isSupersetOf", "symmetricDifference", "union"]],
    [Map.prototype, ["forEach"]],
    [Reflect, ["apply", "construct", "ownKeys"]],
    [Promise, PROMISE_ALL],
    [typeof Iterator === "function" ? Iterator.prototype : null, ["toArray"]],
    [Function.prototype, ["apply"]],
    [JSON, ["parse", "stringify"]],
    [RegExp.prototype, ["toString"]],
    [Number.prototype, ["toString"]],
    [BigInt.prototype, ["toString"]],
    [Error.prototype, ["toString"]],
    [BufferProto, ["resize", "slice", "transfer", "transferToFixedLength"]],
    [SharedProto, ["grow", "slice"]],
    [G, ["decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape"]],
  ];
  for (let i = 0; i < METERED.length; i++) {
    const target = METERED[i][0];
    const names = METERED[i][1];
    if (target === null) continue;
    for (let j = 0; j < names.length; j++) meterMethod(target, names[j]);
  }
  // Function.prototype.toString: ตัวห่อแสดงเป็นของจริง ("[native code]")
  define(Function.prototype, "toString", { toString() {
    if (dead) throw DEAD;
    const original = typeof this === "function" ? apply(wmGet, WRAPPED, [this]) : undefined;
    const result = apply(fnToString, original === undefined ? this : original, []);
    chargeUnits(sizeOf(result));
    return result;
  } }.toString);

  // ---- spread / rest ของ array: [...a] · f(...a) · new F(...a) · const [x, ...r] = a → __spread(a) ----
  // ล็อก iterator ในตัวของ array / string / Set / Map (แก้ไม่ได้) → รู้แน่ว่า engine จะคัดลอกกี่สมาชิก
  // array / string / Set / Map ธรรมดา = คิดตามขนาดแล้วให้ engine คัดลอกแบบเร็วเหมือนเดิม
  // อย่างอื่น (iterator ที่สร้างไว้ก่อน / generator / Proxy / ตัวที่มี [Symbol.iterator] ของตัวเอง) = วนเองทีละสมาชิก คิด 1 หน่วยต่อสมาชิก
  const fixProperty = (target, key) => {
    const desc = getOwnPropertyDescriptor(target, key);
    defineProperty(target, key, { value: desc.value, writable: false, enumerable: desc.enumerable, configurable: false });
  };
  const ITERABLES = [ArrayProto, String.prototype, Set.prototype, Map.prototype];
  for (let i = 0; i < ITERABLES.length; i++) {
    fixProperty(ITERABLES[i], SymbolIterator);
    fixProperty(getPrototypeOf(ITERABLES[i][SymbolIterator].call(i === 1 ? "" : i === 0 ? [] : i === 2 ? new Set() : new Map())), "next");
  }
  function spreadUnits(value) {
    if (typeof value === "string") return value.length;
    if (apply(wsHas, PROXIES, [value]) || hasOwn(value, SymbolIterator)) return -1;
    const proto = getPrototypeOf(value);
    if (proto === ArrayProto && isArray(value)) return toCount(value.length);
    if (proto === SetProto) return brandSize(setSize, value);
    if (proto === MapProto) return brandSize(mapSize, value);
    return -1;
  }
  function spreadValue(value) {
    if (dead) throw DEAD;
    if (value === null || (typeof value !== "object" && typeof value !== "function" && typeof value !== "string")) return value;   // engine throw "not iterable" เอง
    const units = spreadUnits(value);
    if (units >= 0) {
      chargeUnits(units);
      return value;
    }
    const iterator = value[SymbolIterator]();
    const next = iterator.next;
    const out = [];
    for (let n = 0; ; n++) {
      const step = apply(next, iterator, []);
      if (step === null || (typeof step !== "object" && typeof step !== "function")) throw new TypeErrorFn("iterator result is not an object");
      if (step.done) return out;
      chargeUnits(1);
      defineProperty(out, n, { value: step.value, writable: true, enumerable: true, configurable: true });
    }
  }

  // ---- constructor ที่จองหน่วยความจำตามตัวเลขที่ส่งมา ----
  // ห่อด้วย Proxy แล้วชี้ global + prototype.constructor มาที่ตัวห่อ (subclass / species ผ่านตัวห่อด้วย)
  // Array(n) ไม่ต้องห่อ: QuickJS ไม่จองที่ให้สมาชิกจนกว่าจะใส่ค่า (fill / map / spread … คิดตาม length อยู่แล้ว)
  function meterConstructor(name, before, after, callable = false) {
    const Ctor = G[name];
    if (typeof Ctor !== "function") return;
    const handler = {
      construct(target, args, newTarget) {
        if (dead) throw DEAD;
        chargeUnits(before(args));
        const object = construct(target, args, newTarget);
        if (after !== undefined) chargeUnits(after(args, object));
        return object;
      },
    };
    // เรียกแบบไม่มี new: typed array / ArrayBuffer throw TypeError เอง · RegExp(…) สร้างได้ → คิดแบบเดียวกัน
    if (callable) {
      handler.apply = (target, self, args) => {
        if (dead) throw DEAD;
        chargeUnits(before(args));
        return apply(target, self, args);
      };
    }
    const Wrapped = new ProxyFn(Ctor, handler);
    apply(wmSet, WRAPPED, [Wrapped, Ctor]);
    define(G, name, Wrapped);
    define(Ctor.prototype, "constructor", Wrapped);
  }
  const bufferUnits = (args) => {
    const length = countArg(args, 0);
    let max = length;
    const options = args[1];
    if (options !== null && typeof options === "object") {
      const limit = [options.maxByteLength];   // อ่านครั้งเดียว แล้วส่งค่าที่อ่านต่อให้ engine
      if (limit[0] !== undefined) {
        max = countArg(limit, 0);
        args[1] = { maxByteLength: limit[0] };
      }
    }
    if (max < length) max = length;
    return max <= BYTES_MAX ? textUnits(max) : 0;
  };
  meterConstructor("ArrayBuffer", bufferUnits);
  if (SharedArrayBufferFn) meterConstructor("SharedArrayBuffer", bufferUnits);
  // BigInt64Array / BigUint64Array: ใส่ string ลงช่อง (ta[i] = "999…") = engine แปลง string เป็น BigInt เองโดยไม่ผ่านตัวนับ → ปิด
  delete G.BigInt64Array;
  delete G.BigUint64Array;
  const TYPED_NAMES = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
    "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"];
  const isBuffer = (value) => textUnitsOf(bufferByteLength, value) >= 0 || (sharedByteLength !== undefined && sharedByteLength !== null && textUnitsOf(sharedByteLength, value) >= 0);
  for (let i = 0; i < TYPED_NAMES.length; i++) {
    const Ctor = G[TYPED_NAMES[i]];
    if (typeof Ctor !== "function") continue;
    const width = Ctor.BYTES_PER_ELEMENT;
    meterConstructor(TYPED_NAMES[i], (args) => {
      const source = args[0];
      if (source !== null && typeof source === "object") return 0;   // คัดลอกจาก array / iterable → คิดหลังสร้าง
      const length = countArg(args, 0);
      return length * width <= BYTES_MAX ? length : 0;
    }, (args, object) => {
      const source = args[0];
      if (source === null || typeof source !== "object" || isBuffer(source)) return 0;   // มุมมองบน buffer เดิม = ไม่คัดลอก
      return apply(typedLength, object, []);
    });
  }
  // ตัวที่รับ iterable แล้วคัดลอกทุกสมาชิก: แทน iterable ด้วยผลของ __spread (คิดแก๊สแล้ว)
  const spreadFirst = (args) => {
    if (args.length && args[0] !== null && args[0] !== undefined) args[0] = spreadValue(args[0]);
    return 0;
  };
  const COLLECTIONS = ["Set", "Map", "WeakSet", "WeakMap"];
  for (let i = 0; i < COLLECTIONS.length; i++) meterConstructor(COLLECTIONS[i], spreadFirst);
  meterConstructor("AggregateError", (args) => spreadFirst(args) + bigArgUnits(args[1]), undefined, true);   // + message (แปลงเป็น string)
  // ---- regular expression: ปิดทั้งหมด ----
  // engine ของ QuickJS backtrack ได้แบบ exponential (/(a+)+$/ กับ "aaa…b") และไม่มีทางรู้งานล่วงหน้า → คิดแก๊สให้ตรงกับ CPU ไม่ได้
  // ทางที่สร้าง / รัน regex: RegExp(…) · match / matchAll / search (สร้างจาก string) · exec / test / Symbol.* ของ RegExp.prototype
  //   (Symbol.split / matchAll สร้าง regex ใหม่จาก object ใดก็ได้ผ่าน species) · literal ถูก gasmeter.js ปฏิเสธตอน deploy
  const noRegExp = () => {
    throw new TypeErrorFn("regular expression ใช้ในโปรแกรมไม่ได้ (เวลาทำงานไม่แน่นอน — ใช้ indexOf / includes / split แทน)");
  };
  const RegExpFn = RegExp;
  const LockedRegExp = new ProxyFn(RegExpFn, { apply: noRegExp, construct: noRegExp });
  apply(wmSet, WRAPPED, [LockedRegExp, RegExpFn]);
  define(G, "RegExp", LockedRegExp);
  define(RegExpFn.prototype, "constructor", LockedRegExp);
  const REGEXP_ENTRIES = [
    [RegExpFn.prototype, ["exec", "test", "compile", Symbol.match, Symbol.matchAll, Symbol.replace, Symbol.search, Symbol.split]],
    [String.prototype, ["match", "matchAll", "search"]],
  ];
  for (let i = 0; i < REGEXP_ENTRIES.length; i++) {
    const target = REGEXP_ENTRIES[i][0];
    const names = REGEXP_ENTRIES[i][1];
    for (let j = 0; j < names.length; j++) {
      const key = names[j];
      const original = target[key];
      const name = typeof key === "symbol" ? "[" + key.description + "]" : key;
      const blocked = { [name]() { return noRegExp(); } }[name];
      defineProperty(blocked, "length", { value: original.length, writable: false, enumerable: false, configurable: true });
      apply(wmSet, WRAPPED, [blocked, original]);
      define(target, key, blocked);
    }
  }

  // ---- BigInt ที่ engine แปลงเป็น string เองในตัวเมธอด / ค่า BigInt ที่เมธอดในตัวคืนให้ engine ----
  // argument ที่เป็น BigInt ใหญ่ = W² (แปลงเป็นชื่อ property / string) · ผลที่เป็น BigInt ใหญ่ = W² (เผื่อผู้เรียกเป็น engine
  //   เช่น { toString: Array.prototype.pop } · Map.prototype.get.bind(…)) · ค่า ≤ 512 bit ไม่คิด → แก๊สเท่าเดิม
  function bigArgUnits(value) {
    return typeof value === "bigint" ? convUnits(value) : 0;
  }
  function guardBigInt(target, key) {
    if (target === null || target === undefined) return;
    const desc = getOwnPropertyDescriptor(target, key);
    if (desc === undefined || typeof desc.value !== "function") return;
    const original = desc.value;
    const name = typeof key === "symbol" ? "[" + key.description + "]" : key;
    const wrapper = { [name](...args) {
      if (dead) throw DEAD;
      for (let i = 0; i < args.length; i++) if (typeof args[i] === "bigint") chargeConv(args[i]);
      const result = apply(original, this, args);
      if (typeof result === "bigint") chargeConv(result);
      return result;
    } }[name];
    defineProperty(wrapper, "length", { value: original.length, writable: false, enumerable: false, configurable: true });
    apply(wmSet, WRAPPED, [wrapper, original]);
    defineProperty(target, key, { value: wrapper, writable: desc.writable, enumerable: desc.enumerable, configurable: desc.configurable });
    return wrapper;
  }
  const WeakMapProto = WeakMapFn.prototype;
  const GUARDED = [
    [Object, ["hasOwn", "defineProperty", "getOwnPropertyDescriptor"]],
    [ObjectProto, ["hasOwnProperty", "propertyIsEnumerable", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]],
    [Reflect, ["get", "set", "has", "defineProperty", "deleteProperty", "getOwnPropertyDescriptor"]],
    [Symbol, ["for"]],
    [DateFn, ["parse"]],
    [ArrayProto, ["pop", "at"]],
    [MapProto, ["get", "getOrInsert", "getOrInsertComputed"]],
    [WeakMapProto, ["get", "getOrInsert", "getOrInsertComputed"]],
    [typeof Iterator === "function" ? Iterator.prototype : null, ["find", "reduce"]],
    [BigIntProto, ["valueOf"]],
  ];
  for (let i = 0; i < GUARDED.length; i++) {
    const names = GUARDED[i][1];
    for (let j = 0; j < names.length; j++) guardBigInt(GUARDED[i][0], names[j]);
  }
  // parseInt / parseFloat: global กับ Number.* เป็นตัวเดียวกัน (ตามมาตรฐาน)
  define(NumberFn, "parseInt", guardBigInt(G, "parseInt"));
  define(NumberFn, "parseFloat", guardBigInt(G, "parseFloat"));
  // String(x) / new String(x) · Symbol(x) · Error(x) / new Error(x) …: argument แปลงเป็น string
  meterConstructor("String", (args) => bigArgUnits(args[0]), undefined, true);
  meterConstructor("Symbol", (args) => bigArgUnits(args[0]), undefined, true);
  const ERROR_NAMES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "InternalError"];
  for (let i = 0; i < ERROR_NAMES.length; i++) meterConstructor(ERROR_NAMES[i], (args) => bigArgUnits(args[0]), undefined, true);
  // BigInt(x): string → W² ก่อนแปลง · ผลเกินเพดาน = RangeError · ผลใหญ่ = W² (เผื่อผู้เรียกเป็น engine)
  function toBigIntInput(value) {
    if (isObject(value)) value = toPrimitive(value, "number");
    if (typeof value === "string") chargeBig(parseUnits(value));
    return value;
  }
  const LockedBigInt = new ProxyFn(BigIntFn, {
    apply(target, self, args) {
      if (dead) throw DEAD;
      const result = BigIntFn(args.length ? toBigIntInput(args[0]) : undefined);
      if (isSmall(result)) return result;
      capped(result);
      chargeConv(result);
      return result;
    },
  });
  apply(wmSet, WRAPPED, [LockedBigInt, BigIntFn]);
  define(G, "BigInt", LockedBigInt);
  define(BigIntProto, "constructor", LockedBigInt);
  // BigInt.asIntN / asUintN(bits, x): ผลยาวได้ถึง bits → คิดก่อน · asUintN ของค่าติดลบ = bits เต็ม (เกินเพดาน = RangeError)
  const AS_N = [["asIntN", true], ["asUintN", false]];
  for (let i = 0; i < AS_N.length; i++) {
    const name = AS_N[i][0];
    const signed = AS_N[i][1];
    const original = BigIntFn[name];
    const wrapper = { [name](bits, bigint) {
      if (dead) throw DEAD;
      const n = +bits;   // ToIndex (BigInt → TypeError) · ค่าที่แปลงแล้วส่งต่อให้ engine ตรวจช่วงเอง
      const value = toBigIntInput(bigint);
      if (typeof value === "bigint" && n > 0 && n <= MAX_INDEX) {
        const words = ceil((n < BIG_BITS + 64 ? n : BIG_BITS + 64) / 64);
        if (words > SMALL_WORDS) chargeBig(words / 8);
        if (!signed && NumberFn(value) < 0 && n > BIG_BITS) return overLimit();
      }
      const result = apply(original, BigIntFn, [n, value]);
      if (isSmall(result)) return result;
      capped(result);
      chargeConv(result);
      return result;
    } }[name];
    defineProperty(wrapper, "length", { value: original.length, writable: false, enumerable: false, configurable: true });
    apply(wmSet, WRAPPED, [wrapper, original]);
    define(BigIntFn, name, wrapper);
  }
  // DataView.setBigInt64 / setBigUint64(i, x): string → BigInt ในตัว engine → แปลงเอง (คิดแก๊ส) ก่อนส่งต่อ
  const DV_SETTERS = ["setBigInt64", "setBigUint64"];
  for (let i = 0; i < DV_SETTERS.length; i++) {
    const name = DV_SETTERS[i];
    const original = DataView.prototype[name];
    const wrapper = { [name](byteOffset, value, littleEndian) {
      if (dead) throw DEAD;
      const index = +byteOffset;
      return apply(original, this, [index, toBigIntInput(value), littleEndian]);
    } }[name];
    defineProperty(wrapper, "length", { value: original.length, writable: false, enumerable: false, configurable: true });
    apply(wmSet, WRAPPED, [wrapper, original]);
    define(DataView.prototype, name, wrapper);
  }

  // ---- Proxy ที่โปรแกรมสร้าง: จดไว้ (ownKeys / length ของ Proxy ตอบไม่เหมือนกันได้ทุกครั้งที่ถาม) ----
  const PROXIES = new WeakSetFn();
  const revocable = { revocable(target, handler) {
    const result = apply(proxyRevocable, ProxyFn, [target, handler]);
    apply(wsAdd, PROXIES, [result.proxy]);
    return result;
  } }.revocable;
  define(ProxyFn, "revocable", revocable);   // ของเดิมเก็บไว้ใน proxyRevocable เท่านั้น
  define(G, "Proxy", new ProxyFn(ProxyFn, {
    construct(target, args, newTarget) {
      const proxy = construct(target, args, newTarget);
      apply(wsAdd, PROXIES, [proxy]);
      return proxy;
    },
  }));

  /** a + b · a += b → ผลเป็น string = คิดตามความยาว (QuickJS ต่อแบบ rope แล้วคัดลอกจริงตอนใช้งาน — ก้อนใหญ่จึงต้องคิดตอนต่อ) */
  function meterString(value) {
    if (typeof value === "string") chargeUnits(textUnits(value.length));
    return value;
  }
  /** { ...x } และ const { a, ...rest } = x → คิดตามจำนวน property ที่จะถูกคัดลอก */
  function meterProps(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      chargeUnits(value.length);   // { ..."abc" } = 1 property ต่อตัวอักษร
      return value;
    }
    if (typeof value !== "object" && typeof value !== "function") return value;
    if (apply(wsHas, PROXIES, [value])) return copyProxy(value);
    if (isArray(value)) chargeUnits(toCount(value.length));
    else if (isView(value)) chargeUnits(brandSize(typedLength, value));
    else chargeUnits(keys(value).length);
    return value;
  }
  /** Proxy: คัดลอกเองทีละ property (คิดแก๊สตามรายการที่ ownKeys ตอบจริง) แล้วให้ engine คัดลอกสำเนาธรรมดาต่อ */
  function copyProxy(proxy) {
    const list = ownKeys(proxy);
    const length = list.length;
    chargeUnits(length);
    const out = {};
    for (let i = 0; i < length; i++) {
      const key = list[i];
      const desc = getOwnPropertyDescriptor(proxy, key);
      if (desc !== undefined && desc.enumerable) {
        defineProperty(out, key, { value: reflectGet(proxy, key, proxy), writable: true, enumerable: true, configurable: true });
      }
    }
    return out;
  }

  // ---- API ของแต่ละ call ----
  function makeMap(...parts) {
    const key = {};
    apply(wmSet, MAP_PARTS, [key, parts]);
    return key;
  }

  const ENCODERS = { k: encodeShallow, p: encodeShallow, d: encode,
    R: (options) => (options !== null && (typeof options === "object" || typeof options === "function")
      ? '{"value":' + encodeShallow(options.value) + ',"readonly":' + encodeShallow(options.readonly) + "}" : encodeShallow(options)),
    C: (options) => (options !== null && (typeof options === "object" || typeof options === "function")
      ? '{"salt":' + encodeShallow(options.salt) + ',"value":' + encodeShallow(options.value) + "}" : encodeShallow(options)) };

  function makeApi(act, address, blockNumber) {
    const api = {
      __gas: (nodes) => chargeGas(act, nodes * NODE_GAS),
      __str: meterString,
      __props: meterProps,
      __spread: spreadValue,
      __add: bigAdd, __sub: bigSub, __mul: bigMul, __div: bigDiv, __mod: bigMod, __pow: bigPow, __shl: bigShl, __shr: bigShr,
      __lt: bigLt, __gt: bigGt, __le: bigLe, __ge: bigGe, __eq: bigEq, __ne: bigNe, __in: bigIn,
      __key: toKey, __big: bigReturn, __opm: bigCompound,
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
        return hostCall(act, op, payload + "]");
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
    if (typeof error === "bigint") chargeConv(error);
    return '{"t":"s","text":' + jsonStringify(StringFn(error)) + "}";
  }

  /**
   * รัน 1 call: ผล = "v<แก๊สค้าง>|<ค่า>" · "e<แก๊สค้าง>|<error>" · "a<แก๊สค้าง>|" (async) · "f<แก๊สค้าง>|" (tx ล้มทั้งใบ)
   * แก๊สค้างของ "f" = งานที่ทำไปแล้วแต่ยังไม่ได้ส่ง host (หน่วยความจำเกินกลางทาง) → host คิดด้วย (ไม่เกิน gasLimit)
   */
  function invoke(factory, name, paramsText, address, blockNumberText, budget) {
    const act = { pending: 0, budget };
    const outer = ACT;   // โปรแกรมเดียวกันถูกเรียกซ้อน (A → B → A) → คืนตัวนับของชั้นนอกเมื่อจบ
    ACT = act;
    let outcome;
    try {
      const api = makeApi(act, address, blockNumberText === "" ? null : BigIntFn(blockNumberText));
      reviveUnits = 0;
      const params = decode(paramsText);
      chargeRevive();
      const result = factory(api)[name](params);
      outcome = typeof result?.then === "function" ? "a" + act.pending + "|" : "v" + act.pending + "|" + encode(result);
    } catch (error) {
      try {
        outcome = dead ? "f" + act.pending + "|" : "e" + act.pending + "|" + describe(error);
      } catch {
        outcome = dead ? "f" + act.pending + "|" : "e" + act.pending + '|{"t":"s","text":"โปรแกรมทำงานผิดพลาด"}';
      }
    }
    ACT = outer;
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
const OP_TEXT = JSON.stringify({ ...OP, names: API_OPS.map(([name]) => name), kinds: API_OPS.map(([, kinds]) => kinds), bigBits: BIGINT_MAX_BITS });

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
  // แก๊สค้าง (v<n>|) = ค่าของ "x".repeat(i) ที่คิดตามขนาดข้อมูล — ต้องเท่ากันทั้งสองรอบ
  if (first !== second || !/^v\d+\|\[200,"y","undefined",0,\{"\\u0000":"b","v":"597"\}\]/.test(first)) {
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
    const bar = text.indexOf("|");
    const pending = Number(text.slice(1, bar));
    if (this.outOfMemory || text[0] === "f") {
      // tx ล้มทั้งใบ: ยังคิดแก๊สของงานที่ทำไปแล้ว (หน่วยความจำเกิน = เสียค่าแก๊สเท่าที่ใช้จริง ไม่ใช่แค่ส่วนที่ส่งมาก่อนหน้า)
      if (pending > 0) tx.gasUsed = Math.min(tx.gasLimit, tx.gasUsed + pending);
      if (this.outOfMemory) return this.#fatal();
      if (!tx.fatal) tx.abort(this.timedOut ? "timeout" : "memory");
      return { kind: "fatal" };
    }
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
