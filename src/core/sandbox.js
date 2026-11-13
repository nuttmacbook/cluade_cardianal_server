/**
 * Program sandbox: runs user code in QuickJS compiled to WebAssembly (quickjs-emscripten, sync variant)
 *
 *   const sandbox = new Sandbox(tx, { memoryLimitBytes, maxStackBytes, nodeGas, builtinGas, timestamp, wallClock, map })
 *   sandbox.invoke({ programUuid, source, functionName, params, api, blockNumber })  → outcome
 *   sandbox.dispose()                                                               ← required for every tx (runAction does it)
 *
 * Structure
 *   There is a single QuickJS instance for running programs (with its own WebAssembly memory) and a single runtime
 *   At import: create the runtime + POOL_SIZE spare contexts (prelude loaded) → take a snapshot of memory
 *   At the start of each outermost tx: restore memory to the snapshot (≈ 0.1 ms) → every tx starts from a byte-identical heap
 *     · memory / stack / time are counted across the tx's whole call chain (nested runProgram runs in the same runtime)
 *     · 1 program (address + code) = 1 context; different programs cannot see each other's globals
 *     · nothing from earlier txs is left over (globals a program modified / objects / GC garbage)
 *   Every call runs the program's factory function afresh → top-level variables do not persist across calls (as before)
 *   Program code can never get a host object: every value crosses the boundary as JSON text (BigInt / undefined / special values are tagged)
 *
 * Gas: __gas(n) is counted inside the sandbox (per-call counter), and the pending total is sent to the host on every API call
 *   exceeding the remaining budget → ask the host immediately → OUT_OF_GAS at exactly the same point as counting one by one (gas figures identical to the unit)
 *   tx fails midway (memory exceeded) → the pending total is sent back in "f<n>|" for the host to charge too
 *
 * Gas by data size (prelude): builtin per unit · 1 unit = 1 element / property or 32 characters / bytes (rounded up)
 *   built-in methods that copy / create data are wrapped before user code runs (the originals live only in a closure) → charged the same however they are called
 *   __spread (array spread / rest) · __props (object spread / rest) · __str (strings from + / +=), inserted by gasmeter.js
 *   built-in iterators of array / string / Set / Map are locked → __spread knows exactly how many elements the engine will copy (fast copy as before)
 *   ArrayBuffer / typed array / RegExp / Set / Map / WeakSet / WeakMap / AggregateError are wrapped with Proxy (global + prototype.constructor)
 *   Proxies created by the program are tracked (ownKeys / length can answer differently every time → copied manually property by property)
 *
 * Gas by BigInt CPU work (prelude "BigInt" · test 81): operators that gasmeter.js rewrites to __mul / __lt … are charged by number of 64-bit words
 *   values ≤ 512 bits cost nothing extra · work whose size is known up front (** / << / * / string conversion) is charged before running · results above BIGINT_MAX_BITS (8192 bits) = RangeError
 *   (the ceiling bounds work the engine does on its own without the counter: converting BigInt to string inside built-in methods ≈ W²; 8192 bits ≈ 0.4 ms per call)
 *   every path where the engine converts BigInt ↔ string is charged first: operators / property names / function return values / built-in methods that take or return BigInt
 * regular expressions are fully disabled (RegExp / match / matchAll / search / exec / test …): exponential backtracking cannot be charged up front
 *
 * Memory: QuickJS's built-in memory limit does not work on emscripten (it counts only 8 bytes per block), so the WebAssembly heap is controlled instead
 *   At tx start (after restoring the snapshot): allocate a "balloon" block so that exactly memoryLimitBytes + the host reserve stays free, then lock memory from growing
 *   → malloc fails at the same point on every machine (independent of how far memory had grown) · touching the lock = OUT_OF_MEMORY (cannot be caught)
 */
import { getQuickJS, newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from "quickjs-emscripten";
import { BIGINT_MAX_BITS } from "./gasmeter.js";

export const SANDBOX_DEFAULTS = {
  memoryLimitBytes: 32 * 1024 * 1024,   // memory per tx (across all programs in the call chain)
  maxStackBytes: 256 * 1024,            // QuickJS stack per tx (≈ 1,400 levels of nested function calls); more than this risks overflowing Node's own stack
};

/** allowed range: the QuickJS stack also uses Node's real stack; 512 KB overflows Node's stack and breaks WebAssembly */
export const SANDBOX_LIMITS = {
  memoryLimitBytes: [1024 * 1024, 1024 * 1024 * 1024],
  maxStackBytes: [16 * 1024, 256 * 1024],
};

const PAGE = 64 * 1024;
const HOST_RESERVE = 2 * 1024 * 1024;   // reserve left for the host to keep working after a program fills memory
const HOST_HEADROOM = 256 * 1024;       // the host checks that at least this much is free before every operation (otherwise = OUT_OF_MEMORY)
const POOL_SIZE = 8;                    // contexts prepared in the snapshot (txs that use more programs than this create extra ones, which is slower)
const LOW_REGION = 1024 * 1024;         // bottom of memory: QuickJS / malloc static data (~90 KB); the rest is the C stack
const MAX_MEMORY_PAGES = 32768;         // 2 GB (the wasm32 ceiling)

// ---------------------------------------------------------------------------
//  QuickJS instance
// ---------------------------------------------------------------------------

const realGrow = WebAssembly.Memory.prototype.grow;
const executorMemory = new WebAssembly.Memory({ initial: 256, maximum: MAX_MEMORY_PAGES });
let memoryLocked = false;
let current = null;   // the sandbox currently holding the heap (only one at a time)

// emscripten grows memory only via grow → no growing during a tx (malloc fails = limit exceeded)
executorMemory.grow = function grow(delta) {
  if (memoryLocked) {
    current?.flagOutOfMemory();
    throw new RangeError("sandbox memory limit");
  }
  return realGrow.call(this, delta);
};

/** QuickJS for running programs (heap separate from the syntax checker) */
const executor = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: executorMemory }));
/** QuickJS for checking syntax at compile time (does not run code) */
const checker = await getQuickJS();
const checkerContext = checker.newContext();
const heap = executor.module;   // emscripten module: _malloc / _free

let brokenReason = null;   // WebAssembly broke (should never happen) → every tx fails as INTERNAL instead of running on a corrupted heap

/** stats for testing that nothing leaks: sandbox holding the heap / extra contexts created / handles not yet released */
export const sandboxStats = { active: 0, extraContexts: 0, handles: 0, transactions: 0 };
export const sandboxMemoryBytes = () => executorMemory.buffer.byteLength;

/**
 * Check syntax with QuickJS (V8 and QuickJS do not accept exactly the same syntax); returns the error message or null
 * compileOnly: no user code is executed
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
//  host ↔ program contract
// ---------------------------------------------------------------------------

/**
 * APIs that call across to the host: [name, kind of each argument]
 *   k = key (string / map(...))   p = single value (objects are sent as "not data")   d = whole data structure
 *   R = runProgram options ({ value, readonly })   C = cloneProgram options ({ salt, value })
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

const TAG = "\u0000";   // tags for values JSON lacks: { "\u0000": "b", v: "123" } = 123n

/** non-data values from a program (function / symbol / Date / class ...); the host sees them as an object that is not a plain object */
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

/** host value → text (BigInt / undefined / NaN tagged) */
export const encodeForGuest = (value) => JSON.stringify(value, hostReplacer);

/** text from a program → host value (all new objects / arrays, no references across the boundary) */
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
        default: throw new Error(`Unknown data tag: ${node[TAG]}`);
      }
    }
    for (const name of Object.keys(node)) node[name] = revive(node[name]);
    return node;
  };
  return revive(JSON.parse(text));
}

// ---------------------------------------------------------------------------
//  program-side code (prelude): runs before user code in every context
//  this function is converted to text (toString); it must not reference anything outside itself
// ---------------------------------------------------------------------------

/* eslint-disable no-new-func */
function prelude(host, opText) {
  "use strict";
  // ---- Capture the originals before user code runs (later changes to globals / prototypes by the user do not affect these) ----
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
  // tx values: set by configure() when a program gets this context (the context is prepared before any tx exists)
  let NODE_GAS = 0;
  let BUILTIN_GAS = 0;
  let TIMESTAMP = 0;
  const TAG = "\u0000";
  const TAG_IN_JSON = "\\u0000";
  const UNDEFINED = '{"\\u0000":"u"}';

  const MAP_PARTS = new WeakMapFn();     // object from map(...) → its key parts
  const HOST_ERRORS = new WeakMapFn();   // error that came from the host → reference id (rethrowing it gives the host the same error)
  const DEAD = new ErrorFn("transaction aborted");
  let dead = false;   // out of gas / timeout / DB failure / memory exceeded → everything after this rethrows (cannot be caught)
  const die = () => {
    dead = true;
    throw DEAD;
  };
  let ACT = null;     // gas counter of the call currently running in this context (set by invoke / restored when it ends — a nested call back into the same program is allowed)

  // ---- Values to text ----
  const opaque = (type) => '{"\\u0000":"x","t":"' + type + '"}';
  const isMap = (value) => apply(wmHas, MAP_PARTS, [value]);
  function encodeNumber(value) {
    if (value !== value) return '{"\\u0000":"n","v":"NaN"}';
    if (value === Infinity) return '{"\\u0000":"n","v":"Infinity"}';
    if (value === -Infinity) return '{"\\u0000":"n","v":"-Infinity"}';
    if (value === 0 && 1 / value < 0) return '{"\\u0000":"n","v":"-0"}';
    return "" + value;
  }
  /** Single value: plain objects are not inspected (the host checks the type and rejects as before) */
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
  /** Whole data tree: recurse into arrays / plain objects · anything else is "not data" */
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

  // ---- Host text to values ----
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
  /** BigInt from the host (tx input / DB values): longer than the cap = RangeError before conversion · conversion cost is accumulated and charged once the latest gas balance is known */
  let reviveUnits = 0;
  function reviveBigInt(text) {
    if (text.length > MAX_DIGITS) throw new RangeErrorFn(CAP_MESSAGE);
    reviveUnits += parseUnits(text);
    return checked(BigIntFn(text));
  }
  /** Charge the accumulated BigInt decode conversion cost */
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

  /** Host reply: "f" = the whole tx fails · [type, remaining gas, value] */
  function receive(act, reply) {
    if (reply === "f" || typeof reply !== "string") die();
    reviveUnits = 0;
    const message = decode(reply);
    act.budget = message[1];
    chargeRevive();
    if (message[0] === "e") throw hostError(message[2]);
    return message[2];
  }

  // ---- Block time / tx randomness (same as the host used to provide) ----
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

  // ---- Context globals: nothing nondeterministic or able to escape gas metering ----
  const define = (target, name, value) => defineProperty(target, name, { value, writable: true, enumerable: false, configurable: true });
  define(G, "Date", BLOCK_DATE);
  define(G, "Math", SEEDED_MATH);
  // Code created at run time (eval / new Function) bypasses the gas meter → disabled
  const deny = () => {
    throw new EvalErrorFn("eval / Function are not allowed in programs");
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
  define(G, "console", freeze({ log() {}, info() {}, warn() {}, error() {}, debug() {} }));   // callable but prints nothing

  // ---- Gas by data size (BUILTIN_GAS price per "unit") ----
  // 1 unit = 1 element (array / typed array / Set / Map / object property / argument) or 32 characters / 32 bytes (rounded up)
  // number / BigInt / boolean / function / null / undefined = 1 unit
  // Charged before the work when the size is known in advance (input data, repeat / padStart / ArrayBuffer(n) …), and the result size is charged again afterwards
  const CHUNK = 32;
  const STRING_MAX = 1073741823;   // QuickJS maximum string length — beyond this the engine throws RangeError itself (not precharged)
  const BYTES_MAX = 2147483647;    // maximum ArrayBuffer size — beyond this the engine throws RangeError itself
  const textUnits = (length) => ceil(length / CHUNK);
  /** Integer ≥ 0 from any value (ToIntegerOrInfinity with negative / NaN = 0) */
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
      case "bigint": return isSmall(value) ? 1 : convUnits(value);   // builtins that take a BigInt may convert it to a string (W²)
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

  /** Send the pending amount to the host (more than what remains → host replies "f" = OUT_OF_GAS) */
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
  /** Charge gas by unit count to the running call (no call = the VM's own code, not charged) */
  function chargeUnits(units) {
    if (dead) throw DEAD;
    if (ACT !== null && units > 0 && BUILTIN_GAS !== 0) chargeGas(ACT, units * BUILTIN_GAS);
  }

  // ---- BigInt: gas by CPU work (test 81) ----
  // W = number of 64-bit words of the absolute value (at least 1) · values ≤ 512 bits cost nothing extra → gas for ordinary programs is unchanged
  // Prices (builtin per unit) when an operand or the result is > 512 bits (minimum BIG_BASE = 16: size measurement + allocation):
  //   + −    16 (≤ 1024 bits) · 64 (larger)                         — charged after (operands are within the cap, so work per op is bounded)
  //   ×      ⌈Wa·Wb / 4⌉                                            — charged after (≤ 128 × 128 words ≈ 0.1 ms)
  //   ÷ %    ⌈max(1, Wa − Wb + 1) · Wb / 4⌉                         — charged after
  //   **     ⌈Wr² / 4⌉ (Wr = result words from bits × exponent)      — charged before computing: 2n ** 10n ** 9n runs out of gas at once
  //   << >>  ⌈Wr / 2⌉                                               — charged before computing
  //   BigInt → string (any radix) W² · string → BigInt W² (W = ⌈length / 19⌉) — charged before converting
  // Result over BIG_BITS → RangeError: the engine converts BigInt to string by itself in many places the meter does not see (e.g. inside unwrapped builtins)
  //   the cap bounds any such unmetered work to ~0.4 ms per op (8192 bits) instead of seconds (QuickJS accepts up to ~1M bits)
  // Size is measured with Number(x) (faster than BigInt comparison) — may round at 2^k boundaries, but gives the same value on every machine (wasm + IEEE 754)
  const BIG_BITS = OP.bigBits;
  const SMALL_WORDS = 8;
  const BIG_BASE = 16;
  const MAX_DIGITS = ceil(BIG_BITS * 0.30103) + 1;   // characters of the longest base-10 number within the cap (sign included)
  const MAX_UNITS = 4503599627370496;                // 2^52 — anything larger certainly runs out of gas anyway
  const CAP_MESSAGE = "BigInt exceeds " + BIG_BITS + " bits (1024 bytes)";
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

  /** |x| < 2^512 (by the rounded number value) */
  function isSmall(x) {
    const n = NumberFn(x);
    return n < SMALL_FLOAT && n > -SMALL_FLOAT;
  }
  /** Bit count of |x|: exact for all values < 2^53 · larger values may be 1 bit too high (number rounds up to 2^k) */
  function bitsOf(x) {
    let n = NumberFn(x);
    let base = 0;
    while (isInfinite(n)) {   // ≥ 2^1024: shift down 1000 bits at a time (value within the cap → at most 9 rounds)
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
  /** BigInt → string: W² (values ≤ 512 bits = 0) */
  function convUnits(x) {
    if (isSmall(x)) return 0;
    const words = wordsOf(x);
    return words * words;
  }
  function chargeConv(x) {
    const units = convUnits(x);
    if (units > 0) chargeBig(units);
  }
  /** string → BigInt: W² from the length (base 10 ≈ 19 characters per word · other radixes charged the same)
   * ≤ 171 characters (9 words: a 512-bit value is 155 digits) cost nothing extra, like values ≤ 512 bits for BigInt → string */
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
  /** Result not known to be small: check the cap only for large values (fast path for small values skips the BigInt comparison) */
  const checked = (r) => (isSmall(r) ? r : capped(r));
  /** + − on large values: 16 (≤ ~1024 bits) / 64 */
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

  // Standard ToPrimitive (calls the program's valueOf / toString / @@toPrimitive once, like the engine) →
  // the operator gets primitives before the engine would convert string ↔ BigInt itself
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
  /** BigInt / object → value used as a property name (BigInt = converted to base 10: W²) */
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
  /** Engine ToString (symbol → TypeError), charging BigInt conversion first */
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
  /** BigInt compared with string → the engine converts the string to BigInt (W²) */
  function parseCost(a, b) {
    if (typeof a === "bigint") {
      if (typeof b === "string") chargeBig(parseUnits(b));
    } else if (typeof b === "bigint" && typeof a === "string") chargeBig(parseUnits(a));
  }

  // operators (gasmeter.js rewrites a OP b → __op(a, b)) · plain numbers run immediately · object → ToPrimitive first, like the engine
  function bigAdd(a, b) {
    if (typeof a === "number" && typeof b === "number") return a + b;
    if (isObject(a)) a = toPrimitive(a, "default");
    if (isObject(b)) b = toPrimitive(b, "default");
    if (typeof a === "bigint") {
      if (typeof b === "bigint") {
        // small result and small a → b is small too (|b| ≤ |a| + |a + b|)
        const r = a + b;
        return isSmall(r) && isSmall(a) ? r : linearCost(a, r);
      }
      if (typeof b === "string") chargeConv(a);
    } else if (typeof b === "bigint" && typeof a === "string") chargeConv(b);
    const r = a + b;
    if (typeof r === "string") chargeUnits(textUnits(r.length));   // as the old __str did
    return r;
  }
  function bigSub(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (isObject(a)) {
      a = toPrimitive(a, "number");
      if (typeof a === "symbol") return a - b;   // the engine throws before converting the right operand
    }
    if (isObject(b)) b = toPrimitive(b, "number");
    const r = a - b;   // only BigInt − BigInt yields a BigInt (mixing with number = TypeError)
    return typeof r !== "bigint" || (isSmall(r) && isSmall(a)) ? r : linearCost(a, r);
  }
  function bigMul(a, b) {
    if (typeof a === "number" && typeof b === "number") return a * b;
    if (isObject(a)) {
      a = toPrimitive(a, "number");
      if (typeof a === "symbol") return a * b;
    }
    if (isObject(b)) b = toPrimitive(b, "number");
    // operands are within the cap → work per op ≤ 128 × 128 words (~0.1 ms), so compute first and charge by size
    const r = a * b;   // small result → both operands are small (or one is 0)
    return typeof r !== "bigint" || isSmall(r) ? r : productCost(a, b, r);
  }
  function bigDivide(a, b, modulo) {
    if (isObject(a)) {
      a = toPrimitive(a, "number");
      if (typeof a === "symbol") return modulo ? a % b : a / b;
    }
    if (isObject(b)) b = toPrimitive(b, "number");
    // work = quotient × divisor → not charged when both operands are small (a / b: small quotient + small divisor = small operands)
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
    // exponent < 2 (negative = RangeError) or base 0 / ±1 → the result does not grow; the engine is fast on its own
    if (exponent < 2 || (base < 2 && base > -2)) return a ** b;
    const bits = bitsOf(a);
    const words = ceil((bits * exponent) / 64);   // result ≤ bits × exponent bits
    if (words > SMALL_WORDS) {
      const units = (words * words) / 4;
      chargeBig(units > BIG_BASE ? units : BIG_BASE);
    }
    // result ≥ (bits − 1) × exponent + 1 bits (bits of values ≥ 2^53 may be 1 too high → allow for it) → certainly over the cap, no need to compute
    if ((bits - (base < SAFE && base > -SAFE ? 1 : 2)) * exponent + 1 > BIG_BITS) return overLimit();
    return checked(a ** b);   // here the result is ≤ ~2× the cap → work is bounded
  }
  function bigShift(a, b, left) {
    if (isObject(a)) {
      a = toPrimitive(a, "number");
      if (typeof a === "symbol") return left ? a << b : a >> b;
    }
    if (isObject(b)) b = toPrimitive(b, "number");
    if (typeof a === "bigint" && typeof b === "bigint") {
      const value = NumberFn(a);
      const amount = left ? NumberFn(b) : -NumberFn(b);   // number of bits shifted left (>> by a negative amount = left shift)
      if (value === 0) return left ? a << b : a >> b;
      if (amount > 0) {
        const bits = bitsOf(a);
        const words = ceil((bits + amount) / 64);
        if (words > SMALL_WORDS) chargeBig(words / 2 > BIG_BASE ? words / 2 : BIG_BASE);
        if (bits - (value < SAFE && value > -SAFE ? 0 : 1) + amount > BIG_BITS) return overLimit();
        return checked(left ? a << b : a >> b);
      }
      if (!isSmall(a)) chargeBig(isInfinite(value) ? 64 : BIG_BASE);   // right shift = work linear in the operand
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
  /** a < b etc.: ToPrimitive (number) on both sides first, then charge string → BigInt conversion */
  function relational(a, b) {
    if (typeof a === "object" || typeof a === "function") a = isObject(a) ? toPrimitive(a, "number") : a;
    if (typeof b === "object" || typeof b === "function") b = isObject(b) ? toPrimitive(b, "number") : b;
    if (typeof a === "string" && typeof b === "string") chargeTextCompare(a.length < b.length ? a.length : b.length);
    else parseCost(a, b);
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
  /** a == b: same type = compare directly · object vs primitive → ToPrimitive (default) per the spec */
  function bigEq(a, b) {
    if (typeof a === typeof b) {
      if (typeof a === "string" && a.length === b.length) chargeTextCompare(a.length);
      return a == b;
    }
    if (isObject(a)) {
      if (b !== null && b !== undefined && !isObject(b)) a = toPrimitive(a, "default");
    } else if (isObject(b) && a !== null && a !== undefined) b = toPrimitive(b, "default");
    parseCost(a, b);
    return a == b;
  }
  const bigNe = (a, b) => !bigEq(a, b);
  /** a === b · a !== b: equal-length strings = the engine compares character by character (different lengths = known at once) */
  function strictEq(a, b) {
    if (typeof a === "string" && typeof b === "string" && a.length === b.length) chargeTextCompare(a.length);
    return a === b;
  }
  const strictNe = (a, b) => !strictEq(a, b);
  function meterSwitch(value, cases) {
    if (typeof value === "string" && value.length > CHUNK) chargeUnits((textUnits(value.length) - 1) * cases);
    return value;
  }
  /** String comparison: the first 32 characters are included in the operator's gas; beyond that, 1 unit per 32 characters (ordinary programs pay the same gas) */
  function chargeTextCompare(length) {
    if (length > CHUNK) chargeUnits(textUnits(length) - 1);
  }
  /** k in o (o not an object → TypeError before converting k, like the engine) */
  function bigIn(key, object) {
    if (!isObject(object)) return key in object;
    return toKey(key) in object;
  }
  /** A large BigInt returned by a program function → precharge its string conversion (the caller may be the engine, e.g. valueOf / toString / getter) */
  function bigReturn(value) {
    chargeConv(value);
    return value;
  }
  const COMPOUND_OPS = { "+": bigAdd, "-": bigSub, "*": bigMul, "/": bigDiv, "%": bigMod, "**": bigPow, "<<": bigShl, ">>": bigShr };
  /** o[k] op= y when o / k are complex expressions: read the old value before computing y, per the spec (y is passed as a function) */
  function bigCompound(object, key, symbol, rhs) {
    let name = toKey(key);
    if (typeof name === "bigint") name = StringFn(name);   // convert once (already charged in toKey)
    const old = object[name];
    const result = COMPOUND_OPS[symbol](old, rhs());
    object[name] = result;
    return result;
  }

  // ---- Builtin methods: wrap the originals (the originals live only in this closure, out of reach of program code) ----
  // General formula: before the call = size of this + every argument (+ any size known in advance) · after the call = size of the result
  // Every call path costs the same: a.join() · Array.prototype.join.call(a) · Reflect.apply(…) · const j = a.join · implicit array-to-string conversion
  // (Array.prototype.toString / ToPrimitive call this.join → the wrapped one)
  const WRAPPED = new WeakMapFn();     // wrapper → original (Function.prototype.toString shows the original)
  const WRAPPER_OF = new WeakMapFn();  // original → wrapper (one function in 2 places, e.g. trimLeft / trimStart, gets one wrapper)
  // at most 65,535 arguments (more = the engine throws RangeError itself) → charge no more than that
  const MAX_ARGS = 65536;
  const listUnits = (list) => {
    const n = list !== null && typeof list === "object" ? toCount(list.length) : 0;
    return n < MAX_ARGS ? n : MAX_ARGS;
  };
  // Sizes known before the result is built (values already read are put back into args → the engine sees the same values gas was charged for)
  const EXPECT = new WeakMapFn();
  const expect = (fn, measure) => apply(wmSet, EXPECT, [fn, measure]);
  /**
   * Number in args[index] → ToNumber once (the program's valueOf runs once), then put the result back so the engine uses the same value
   * Returns an integer ≥ 0 for gas · BigInt / Symbol untouched (the engine throws TypeError itself) · negative / too-large values are passed on for the engine to throw RangeError
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
  // Replaces the general formula (this / other arguments not counted): apply / construct copy the argument array
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
        let prepaid = 0;   // result size already precharged (repeat / padStart …) → afterwards charge only the excess
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
        // apply / construct: the result is the target function's result (already charged if it is a builtin) → do not charge twice
        if (metering && measure === undefined) chargeUnits(sizeOf(result) - prepaid);
        return result;
      } }[name];
      defineProperty(wrapper, "length", { value: original.length, writable: false, enumerable: false, configurable: true });
      const native = apply(wmGet, WRAPPED, [original]);   // rewritten ones (join …) → show the engine's original
      apply(wmSet, WRAPPED, [wrapper, native === undefined ? original : native]);
      apply(wmSet, WRAPPER_OF, [original, wrapper]);
    }
    defineProperty(target, key, { value: wrapper, writable: desc.writable, enumerable: desc.enumerable, configurable: desc.configurable });
  }

  // ---- Builtins where the engine itself converts values read from properties to strings (BigInts in arrays / error messages …) ----
  // Reimplemented step by step per the spec (each value read once), charging BigInt conversion first · the wrapper (meterMethod) charges by size as before
  const nativeJoin = ArrayProto.join;
  const toLength = (value) => {
    const n = +value;   // BigInt → TypeError, like ToLength
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
            // the original error takes precedence (per the spec)
          }
          throw error;
        }
      }
    } }.fromEntries],
    // flat: the engine walks every nested level itself (result may be small but work equals elements at all levels) → follow the spec ourselves, 1 unit per element visited
    [ArrayProto, { flat(depth) {
      const source = requireObject(this);
      const length = toLength(source.length);
      let limit = 1;
      if (depth !== undefined) {
        limit = +depth;   // BigInt → TypeError, like ToIntegerOrInfinity
        limit = limit !== limit || limit < 0 ? 0 : limit === Infinity ? Infinity : floor(limit);
      }
      const out = [];
      let n = 0;
      const flatten = (array, arrayLength, level) => {
        chargeUnits(FLAT_ARRAY_UNITS + arrayLength);   // per array visited (call + length read) + per element
        for (let k = 0; k < arrayLength; k++) {
          if (!(k in array)) continue;
          const element = array[k];
          if (level > 0 && isArray(element)) flatten(element, toLength(element.length), level - 1);
          else defineProperty(out, n++, { value: element, writable: true, enumerable: true, configurable: true });
        }
      };
      flatten(source, length, limit);
      return out;
    } }.flat],
    // JSON.stringify: QuickJS detects cycles by walking the stack of nested objects → work ≈ depth² (300 levels ≈ 0.8 ms per call)
    //   install a VM replacer: 1 unit + depth ÷ 8 per object converted (the program's replacer is still called as before)
    //   array replacer (property list) → converted to a new object holding only those properties in list order (same result as the engine)
    [JSON, { stringify(value, replacer, space) {
      const user = typeof replacer === "function" ? replacer : null;
      let names = null;
      if (user === null && isArray(replacer)) {
        names = [];
        const seen = new SetFn();
        const length = toLength(replacer.length);
        for (let k = 0; k < length; k++) {
          const item = replacer[k];
          let name;
          if (typeof item === "string") name = item;
          else if (typeof item === "number") name = toText(item);
          else if (isObject(item) && (isStringObject(item) || isNumberObject(item))) name = toText(item);
          if (name !== undefined && !apply(setHas, seen, [name])) {
            apply(setAdd, seen, [name]);
            names[names.length] = name;
          }
        }
      }
      const depths = new WeakMapFn();
      const meter = function (key, item) {
        let result = user === null ? item : apply(user, this, [key, item]);
        if (result === null || typeof result !== "object") {
          chargeUnits(2);   // per value converted (VM replacer call + conversion)
        } else {
          const depth = (isObject(this) ? apply(wmGet, depths, [this]) ?? 0 : 0) + 1;
          chargeUnits(4 + floor(depth / 8));
          if (names !== null && !isArray(result) && !isBoxed(result)) {
            const picked = {};
            for (let k = 0; k < names.length; k++) {
              const name = names[k];
              const field = result[name];
              if (field !== undefined) defineProperty(picked, name, { value: field, writable: true, enumerable: true, configurable: true });
            }
            result = picked;
          }
          apply(wmSet, depths, [result, depth]);
        }
        return result;
      };
      return apply(jsonStringify, JSON, [value, meter, space]);
    } }.stringify],
    // JSON.parse: per-character work exceeds copying → 1 extra unit per 32 characters before parsing (text converted once, then passed to the engine)
    [JSON, { parse(text, reviver) {
      const source = toText(text);
      chargeUnits(textUnits(source.length));
      return reviver === undefined ? apply(jsonParse, JSON, [source]) : apply(jsonParse, JSON, [source, reviver]);
    } }.parse],
    // normalize: Unicode mapping tables are about 10× slower than copying → 8 extra units per 32 characters
    [String.prototype, { normalize(form) {
      if (this === null || this === undefined) throw new TypeErrorFn("not an object");
      const self = toText(this);
      chargeUnits(textUnits(self.length) * 8);
      return form === undefined ? apply(stringNormalize, self, []) : apply(stringNormalize, self, [form]);
    } }.normalize],
    // Map / Set: string keys are hashed in full on every call (20,000 characters ≈ 25 µs per call) → charge by key length
    [MapProto, { get(key) { chargeKey(key, 1); return apply(mapGet, this, [key]); } }.get],
    [MapProto, { has(key) { chargeKey(key, 1); return apply(mapHas, this, [key]); } }.has],
    [MapProto, { set(key, value) { chargeKey(key, 2); return apply(mapSet, this, [key, value]); } }.set],
    [MapProto, { delete(key) { chargeKey(key, 1); return apply(mapDelete, this, [key]); } }.delete],
    [SetProto, { add(value) { chargeKey(value, 2); return apply(setAddFn, this, [value]); } }.add],
    [SetProto, { has(value) { chargeKey(value, 1); return apply(setHas, this, [value]); } }.has],
    [SetProto, { delete(value) { chargeKey(value, 1); return apply(setDeleteFn, this, [value]); } }.delete],
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
  const stringNormalize = String.prototype.normalize;
  const FLAT_ARRAY_UNITS = 8;
  const SetFn = Set;
  const setHas = Set.prototype.has;
  const setAdd = Set.prototype.add;
  const setAddFn = Set.prototype.add;
  const setDeleteFn = Set.prototype.delete;
  const mapGet = Map.prototype.get;
  const mapHas = Map.prototype.has;
  const mapSet = Map.prototype.set;
  const mapDelete = Map.prototype.delete;
  /** Long string keys of Map / Set: the first 32 characters are included in the call's gas; beyond that, factor units per 32 characters */
  function chargeKey(key, factor) {
    if (typeof key === "string" && key.length > CHUNK) chargeUnits((textUnits(key.length) - 1) * factor);
  }
  const stringValueOf = String.prototype.valueOf;
  const numberValueOf = Number.prototype.valueOf;
  const booleanValueOf = Boolean.prototype.valueOf;
  const hasBrand = (getter, value) => {
    try {
      apply(getter, value, []);
      return true;
    } catch {
      return false;
    }
  };
  const isStringObject = (value) => hasBrand(stringValueOf, value);
  const isNumberObject = (value) => hasBrand(numberValueOf, value);
  /** String / Number / Boolean / BigInt objects: the engine converts them to primitives itself without walking properties */
  const isBoxed = (value) => isStringObject(value) || isNumberObject(value) || hasBrand(booleanValueOf, value) || hasBrand(bigintValueOf, value);
  /** Default sort order: string comparison (charging BigInt conversion every time the engine converts) */
  function compareText(x, y) {
    const a = toText(x);
    const b = toText(y);
    // each default sort comparison = 1 unit + length scanned (the sort wrapper charges array size once, not the n log n comparisons)
    const length = a.length < b.length ? a.length : b.length;
    chargeUnits(length > CHUNK ? textUnits(length) + 1 : 2);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  for (let i = 0; i < IMPLEMENTED.length; i++) {
    const target = IMPLEMENTED[i][0];
    const impl = IMPLEMENTED[i][1];
    const name = impl.name;
    const original = target[name];
    defineProperty(impl, "length", { value: original.length, writable: false, enumerable: false, configurable: true });
    apply(wmSet, WRAPPED, [impl, original]);   // Function.prototype.toString shows the original
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
  // Function.prototype.toString: wrappers show as the original ("[native code]")
  define(Function.prototype, "toString", { toString() {
    if (dead) throw DEAD;
    const original = typeof this === "function" ? apply(wmGet, WRAPPED, [this]) : undefined;
    const result = apply(fnToString, original === undefined ? this : original, []);
    chargeUnits(sizeOf(result));
    return result;
  } }.toString);

  // ---- Array spread / rest: [...a] · f(...a) · new F(...a) · const [x, ...r] = a → __spread(a) ----
  // Lock the builtin iterators of array / string / Set / Map (cannot be changed) → we know exactly how many elements the engine will copy
  // plain array / string / Set / Map = charge by size, then let the engine do its fast copy as before
  // anything else (pre-made iterators / generators / Proxy / objects with their own [Symbol.iterator]) = iterate ourselves, 1 unit per element
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
    if (value === null || (typeof value !== "object" && typeof value !== "function" && typeof value !== "string")) return value;   // the engine throws "not iterable" itself
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

  // ---- Constructors that allocate memory based on a numeric argument ----
  // Wrapped in a Proxy, with the global + prototype.constructor pointing at the wrapper (subclasses / species go through the wrapper too)
  // Array(n) needs no wrapper: QuickJS allocates no element storage until values are set (fill / map / spread … already charge by length)
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
    // called without new: typed arrays / ArrayBuffer throw TypeError themselves · RegExp(…) constructs → charged the same way
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
      const limit = [options.maxByteLength];   // read once, then pass the read value on to the engine
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
  // BigInt64Array / BigUint64Array: storing a string into a slot (ta[i] = "999…") makes the engine convert string to BigInt unmetered → disabled
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
      if (source !== null && typeof source === "object") return 0;   // copying from an array / iterable → charged after construction
      const length = countArg(args, 0);
      return length * width <= BYTES_MAX ? length : 0;
    }, (args, object) => {
      const source = args[0];
      if (source === null || typeof source !== "object" || isBuffer(source)) return 0;   // a view over an existing buffer = no copy
      return apply(typedLength, object, []);
    });
  }
  // Constructors that take an iterable and copy every element: replace the iterable with the result of __spread (already charged)
  const spreadFirst = (args) => {
    if (args.length && args[0] !== null && args[0] !== undefined) args[0] = spreadValue(args[0]);
    return 0;
  };
  const COLLECTIONS = ["Set", "Map", "WeakSet", "WeakMap"];
  for (let i = 0; i < COLLECTIONS.length; i++) meterConstructor(COLLECTIONS[i], spreadFirst);
  meterConstructor("AggregateError", (args) => spreadFirst(args) + bigArgUnits(args[1]), undefined, true);   // + message (converted to string)
  // ---- Regular expressions: fully disabled ----
  // QuickJS's engine can backtrack exponentially (/(a+)+$/ against "aaa…b") and the work cannot be known in advance → gas cannot match CPU
  // Ways to create / run a regex: RegExp(…) · match / matchAll / search (built from a string) · exec / test / Symbol.* of RegExp.prototype
  //   (Symbol.split / matchAll build a new regex from any object via species) · literals are rejected by gasmeter.js at deploy
  const noRegExp = () => {
    throw new TypeErrorFn("regular expressions are not allowed in programs (unbounded run time — use indexOf / includes / split instead)");
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

  // ---- BigInts the engine converts to strings inside methods / BigInt values that builtins return to the engine ----
  // Large BigInt arguments = W² (converted to a property name / string) · large BigInt results = W² (in case the caller is the engine,
  //   e.g. { toString: Array.prototype.pop } · Map.prototype.get.bind(…)) · values ≤ 512 bits not charged → gas unchanged
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
  // parseInt / parseFloat: the global and Number.* are the same function (per the spec)
  define(NumberFn, "parseInt", guardBigInt(G, "parseInt"));
  define(NumberFn, "parseFloat", guardBigInt(G, "parseFloat"));
  // String(x) / new String(x) · Symbol(x) · Error(x) / new Error(x) …: the argument is converted to a string
  meterConstructor("String", (args) => bigArgUnits(args[0]), undefined, true);
  meterConstructor("Symbol", (args) => bigArgUnits(args[0]), undefined, true);
  const ERROR_NAMES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "InternalError"];
  for (let i = 0; i < ERROR_NAMES.length; i++) meterConstructor(ERROR_NAMES[i], (args) => bigArgUnits(args[0]), undefined, true);
  // BigInt(x): string → W² before converting · result over the cap = RangeError · large result = W² (in case the caller is the engine)
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
  // BigInt.asIntN / asUintN(bits, x): the result can be up to bits long → charged first · asUintN of a negative value = full bits (over the cap = RangeError)
  const AS_N = [["asIntN", true], ["asUintN", false]];
  for (let i = 0; i < AS_N.length; i++) {
    const name = AS_N[i][0];
    const signed = AS_N[i][1];
    const original = BigIntFn[name];
    const wrapper = { [name](bits, bigint) {
      if (dead) throw DEAD;
      const n = +bits;   // ToIndex (BigInt → TypeError) · the converted value is passed on for the engine to range-check
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
  // DataView.setBigInt64 / setBigUint64(i, x): string → BigInt happens inside the engine → convert ourselves (charged) before passing on
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

  // ---- Proxies created by programs: tracked (a Proxy's ownKeys / length may answer differently every time) ----
  const PROXIES = new WeakSetFn();
  const revocable = { revocable(target, handler) {
    const result = apply(proxyRevocable, ProxyFn, [target, handler]);
    apply(wsAdd, PROXIES, [result.proxy]);
    return result;
  } }.revocable;
  define(ProxyFn, "revocable", revocable);   // the original is kept only in proxyRevocable
  define(G, "Proxy", new ProxyFn(ProxyFn, {
    construct(target, args, newTarget) {
      const proxy = construct(target, args, newTarget);
      apply(wsAdd, PROXIES, [proxy]);
      return proxy;
    },
  }));

  /** a + b · a += b → string result = charged by length (QuickJS concatenates as a rope and copies on use — so large pieces must be charged at concatenation) */
  function meterString(value) {
    if (typeof value === "string") chargeUnits(textUnits(value.length));
    return value;
  }
  /** { ...x } and const { a, ...rest } = x → charged by the number of properties to be copied */
  function meterProps(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      chargeUnits(value.length);   // { ..."abc" } = 1 property per character
      return value;
    }
    if (typeof value !== "object" && typeof value !== "function") return value;
    if (apply(wsHas, PROXIES, [value])) return copyProxy(value);
    if (isArray(value)) chargeUnits(toCount(value.length));
    else if (isView(value)) chargeUnits(brandSize(typedLength, value));
    else chargeUnits(keys(value).length);
    return value;
  }
  /** Proxy: copy property by property ourselves (gas by the list ownKeys actually returns), then let the engine copy the plain copy */
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

  // ---- Per-call API ----
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
      __lt: bigLt, __gt: bigGt, __le: bigLe, __ge: bigGe, __eq: bigEq, __ne: bigNe, __in: bigIn, __seq: strictEq, __sne: strictNe,
      __sw: meterSwitch,
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
   * Run 1 call: result = "v<pending gas>|<value>" · "e<pending gas>|<error>" · "a<pending gas>|" (async) · "f<pending gas>|" (whole tx fails)
   * Pending gas of "f" = work already done but not yet reported to the host (memory exceeded midway) → the host charges it too (up to gasLimit)
   */
  function invoke(factory, name, paramsText, address, blockNumberText, budget) {
    const act = { pending: 0, budget };
    const outer = ACT;   // the same program called reentrantly (A → B → A) → restore the outer counter when done
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
        outcome = dead ? "f" + act.pending + "|" : "e" + act.pending + '|{"t":"s","text":"program error"}';
      }
    }
    ACT = outer;
    // must leave room to send the result back to the host (exactly full without failing = let the host check / release the reserve)
    try {
      new ArrayBufferFn(4096);
    } catch {
      host(OP.check, 0, "");
    }
    return outcome;
  }

  /** Bind the context to a tx: gas per unit / block time / real clock (tests only) → returns invoke */
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
//  runtime + spare contexts + snapshot (created once at import)
// ---------------------------------------------------------------------------

/** new context with the prelude loaded: { ctx, configure } (configure(configText) → invoke) */
function createContext(rt) {
  const ctx = rt.newContext();
  // the only function a program can call out to: forwarded to the sandbox of the running tx (no tx = the tx has already failed)
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
    throw new Error(`failed to prepare the sandbox context: ${failure.name}: ${failure.message}`);
  }
  return { ctx, configure };
}

/** error thrown out of QuickJS to the host → { name, message } (always releases the handle) */
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
 * The memory location where malloc (dlmalloc) stores the start of the last free block ("top"); nothing in use lies above top
 * Found by experiment: malloc a large block (always carved from top) and see which value moves from the block start to exactly the block end
 * Not found = null (the snapshot will store the whole memory: correct but slower)
 */
function findTopAddress() {
  const scan = () => new Uint32Array(executorMemory.buffer, 0, LOW_REGION / 4).slice();
  const before = scan();
  const size = SANDBOX_DEFAULTS.memoryLimitBytes + HOST_RESERVE + 2 * PAGE;   // grow memory up front with the built-in
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
  const heapStart = Math.max(LOW_REGION, firstBlock - PAGE);   // below the heap is the C stack (no need to store)
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
    topAddress,
    low: view.slice(0, LOW_REGION),
    high: view.slice(heapStart, memoryEnd),
  };
})();

/**
 * Image of the current memory (lower region + heap up to the last free block)
 * reuse = an old image evicted from the store: copy over its existing buffer if large enough (allocating a new 3 MB buffer is ~10× slower than copying over)
 */
function captureMemory(reuse = null) {
  const view = new Uint8Array(executorMemory.buffer);
  const memoryEnd = engine.topAddress === null
    ? executorMemory.buffer.byteLength
    : new Uint32Array(executorMemory.buffer)[engine.topAddress / 4] + PAGE;
  const length = memoryEnd - engine.heapStart;
  const low = reuse?.low ?? new Uint8Array(LOW_REGION);
  const store = reuse && reuse.store.length >= length ? reuse.store : new Uint8Array(length + 2 * PAGE);
  low.set(view.subarray(0, LOW_REGION));
  store.set(view.subarray(engine.heapStart, memoryEnd));
  return { low, high: store.subarray(0, length), store };
}

/** restore QuickJS memory to the stored image (default = right after the pool was created); must not be called while inside QuickJS */
function restoreSnapshot(image = engine) {
  const view = new Uint8Array(executorMemory.buffer);
  view.set(image.low, 0);
  view.set(image.high, engine.heapStart);
}

/**
 * Per-program "warm" snapshot: memory image = base snapshot + the program's compiled factory in the first context slot
 *   a tx whose first program is this source starts from this image instead → no recompiling every tx (compiling ≈ 1/3 of a token transfer's time)
 * deterministic: the image is a function of (base snapshot, source) only; cached or freshly built, the heap is byte-identical
 *   so every machine always starts a tx from the same heap, whether or not its cache has seen this program before (test 89 covers this)
 *   source that fails to compile = start from the base snapshot as before (also a function of the source alone)
 * the factory is stored as a property of the first slot's configure function (user code cannot reach configure)
 *
 * ~3.3 MB per image (the whole heap up to the last free block) → default 32 images ≈ 105 MB RAM
 * not in the store: restore the base snapshot → compile → current memory "is" the warm image already and can be used directly (no second restore)
 *   stored only when the store has room (SANDBOX_WARM_CACHE > 0) · 0 = never store, never copy memory (same cost as compiling every tx as before)
 *   the heap at tx start is byte-identical on all three paths (image present / just compiled and stored / just compiled, not stored) → settings may differ across machines
 */
export const WARM_FACTORY_KEY = "\u0000factory";
const warmImages = new Map();   // source → memory image | null (compile failed) · ordered by most recent use (LRU)
export const warmStats = { hits: 0, misses: 0, size: 0, limit: Number(process.env.SANDBOX_WARM_CACHE ?? 32) };

/** clear all warm images (tests / tools); tx results do not change, images just have to be rebuilt */
export function clearWarmCache() {
  warmImages.clear();
  warmStats.size = 0;
}

/**
 * Prepare memory as the warm image of source (or the base snapshot if it fails to compile)
 * returns true = memory is in the warm image state (factory in the first slot) · false = base snapshot
 */
function enterWarm(source) {
  const limit = Math.max(0, warmStats.limit);
  if (warmImages.has(source)) {
    const image = warmImages.get(source);
    warmImages.delete(source);
    warmImages.set(source, image);
    warmStats.hits += 1;
    restoreSnapshot(image ?? engine);
    return image !== null;
  }
  warmStats.misses += 1;
  restoreSnapshot();
  const { ctx, configure } = engine.pool[0];
  const result = ctx.evalCode(source, "program");
  if (result.error) {
    result.error.dispose();
    restoreSnapshot();   // a failed evalCode leaves garbage in the heap → restore the base snapshot, matching a machine that remembered "no image"
    if (limit > 0) remember(source, null, limit);
    return false;
  }
  ctx.setProp(configure, WARM_FACTORY_KEY, result.value);
  result.value.dispose();
  if (limit > 0) remember(source, (spare) => captureMemory(spare), limit);
  return true;
}

/** store an image (full = evict the least recently used one and let the new image reuse its buffer) */
function remember(source, makeImage, limit) {
  let spare = null;
  while (warmImages.size >= limit) {
    const oldest = warmImages.keys().next().value;
    spare = warmImages.get(oldest) ?? spare;
    warmImages.delete(oldest);
  }
  warmImages.set(source, typeof makeImage === "function" ? makeImage(spare) : makeImage);
  warmStats.size = warmImages.size;
}

/**
 * At import, check that the snapshot really restores state completely (quickjs-emscripten's memory layout matches expectations)
 * run a test program → dirty the heap → restore the snapshot → run again: the result and malloc positions must match exactly
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
  // pending gas (v<n>|) = the cost of "x".repeat(i) charged by data size; must be equal in both runs
  if (first !== second || !/^v\d+\|\[200,"y","undefined",0,\{"\\u0000":"b","v":"597"\}\]/.test(first)) {
    throw new Error(`sandbox self-check failed: ${first} / ${second}`);
  }
}
selfCheck();

// ---------------------------------------------------------------------------
//  Sandbox: 1 per outermost tx
// ---------------------------------------------------------------------------

export class Sandbox {
  #tx;
  #options;
  #configText;
  #active = false;
  #disposed = false;
  #programs = new Map();   // programUuid → Map(source → { ctx, invoke, factory, error })
  #owned = [];             // handles that live for the whole tx (invoke / factory), released at dispose
  #extra = [];             // contexts created on demand when the pool runs short
  #nextSlot = 0;
  #errors = new Map();     // reference number → host error passed into the program
  #nextErrorId = 1;
  #stack = [];             // calls currently running (the last one is the API caller)
  #reserve = 0;
  #warmSource = null;      // source whose factory is already in the warm image (first context slot)
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

  /** called from memory grow (in the middle of malloc; must not touch the heap here) */
  flagOutOfMemory() {
    this.outOfMemory = true;
  }

  // ---------- heap ----------

  /** start tx: restore snapshot → set stack → balloon + reserve → lock memory */
  #begin(source) {
    if (this.#disposed) throw new Error("sandbox has been disposed");
    if (this.#active) return;
    if (brokenReason) throw new Error(`QuickJS is unusable: ${brokenReason}`);
    if (current) throw new Error("sandbox is in use by another tx that has not finished");
    // the tx's first program is already compiled in the warm image (see enterWarm) · none = base snapshot
    this.#warmSource = enterWarm(source) ? source : null;
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
      const grow = heap._malloc(target - probe);   // let emscripten grow memory itself (the heap view must be updated too)
      if (!grow) throw new Error("failed to grow QuickJS memory");
      heap._free(grow);
    }
    // balloon: always leaves exactly capacity free after the probe, however far memory has grown (released automatically on snapshot restore)
    if (!heap._malloc(executorMemory.buffer.byteLength - (probe + capacity))) throw new Error("failed to allocate QuickJS memory");
    this.#reserve = heap._malloc(HOST_RESERVE);
    memoryLocked = true;
  }

  #releaseReserve() {
    if (this.#reserve) heap._free(this.#reserve);
    this.#reserve = 0;
  }

  /** the host is about to work: there must be enough free space, otherwise the program is treated as exceeding memory */
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

  /** QuickJS asks periodically while running: true = stop immediately (cannot be caught) */
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

  /** temporary handles of 1 call */
  static #temp(handle) {
    sandboxStats.handles += 1;
    return handle;
  }

  static #drop(handle) {
    if (handle.alive) handle.dispose();
    sandboxStats.handles -= 1;
  }

  // ---------- per-program contexts ----------

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
    const warm = slot === engine.pool[0] && source === this.#warmSource;
    const factoryResult = warm ? { value: ctx.getProp(slot.configure, WARM_FACTORY_KEY) } : ctx.evalCode(source, "program");
    if (factoryResult.error) {
      entry.error = readError(ctx, factoryResult.error);
      return entry;
    }
    entry.factory = this.#own(factoryResult.value);
    return entry;
  }

  // ---------- program calls the host ----------

  #reply(kind, value) {
    return JSON.stringify([kind, this.#tx.gasLimit - this.#tx.gasUsed, value], hostReplacer);
  }

  [HOST_CALL](ctx, opHandle, pendingHandle, payloadHandle) {
    const op = ctx.getNumber(opHandle);
    if (!this.#hasHeadroom()) return ctx.newString("f");
    if (Date.now() > this.#tx.deadline) {   // the interrupt handler may be called rarely when the program calls the host frequently → check here too
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
      if (!spec) throw new Error(`Unknown API: ${op}`);
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

  // ---------- run 1 call ----------

  /**
   * @returns {{ kind: "value", value } | { kind: "throw", hostError } | { kind: "throw", guestError: { name, message, stack } }
   *          | { kind: "throw", fakeTimeout: true } | { kind: "throw", text } | { kind: "async" } | { kind: "fatal" }}
   */
  invoke({ programUuid, source, functionName, params, api, blockNumber = null }) {
    try {
      this.#begin(source);
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
      return { kind: "throw", guestError: { ...error, stack: null } };   // error in the prelude itself (e.g. stack overflow while sending the result)
    }
    const text = ctx.getString(result.value);
    result.value.dispose();
    const bar = text.indexOf("|");
    const pending = Number(text.slice(1, bar));
    if (this.outOfMemory || text[0] === "f") {
      // whole tx fails: still charge gas for work already done (memory exceeded = pay the gas actually used, not just the part reported earlier)
      if (pending > 0) tx.gasUsed = Math.min(tx.gasLimit, tx.gasUsed + pending);
      if (this.outOfMemory) return this.#fatal();
      if (!tx.fatal) tx.abort(this.timedOut ? "timeout" : "memory");
      return { kind: "fatal" };
    }
    if (pending > 0) tx.useGas(pending);   // never exceeds the remaining budget (overruns were already sent for immediate checking)
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
        // QuickJS message → the same name as V8 (the engine's actual message is never exposed anyway)
        if (name === "InternalError" && (message === "stack overflow" || message === "string too long")) name = "RangeError";
        return { kind: "throw", guestError: { name, message, stack: desc.stack } };
      }
      default: return { kind: "throw", text: String(desc.text) };
    }
  }

  // ---------- cleanup ----------

  /** release the handles / contexts created in the tx, then release the heap (real memory is reset when the next tx restores the snapshot) */
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
