/**
 * ABI encoding แบบ Solidity สำหรับ eth_call ของโปรแกรมที่ประกาศ metadata.abi (ระยะ 3.2)
 *
 *   const fns = abiFunctions(metadataAbi);                    // selector → { name, inputs, outputs, signature }
 *   const fn = fns.get(data.slice(0, 10));
 *   const input = decodeInput(fn, data);                       // calldata → input ของโปรแกรม ({ ชื่อ: ค่า })
 *   const hex = encodeOutput(fn, result);                      // ผลของโปรแกรม → returndata
 *
 * ชนิดของ metadata.abi → Solidity (เหมือน toEvmAbi): uint → uint256 · int → int256 · address · bool · string · bytes
 *   object / array / any → string ที่เป็น JSON (BigInt เขียนเป็น "123n" แบบเดียวกับ input ของ /sendtx)
 * ค่าที่ส่งให้โปรแกรม: uint / int → "123n" (BigInt ใน sandbox) · address → ตัวเล็ก · bytes → "0x…" · object / array / any → ค่าที่ parse จาก JSON
 * outputs หลายตัว: ผลของโปรแกรมเป็น array (ตามลำดับ) หรือ object (ตามชื่อของ output) · ไม่ได้ประกาศ outputs = returndata ว่าง
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { toEvmAbi } from "../core/virtualmachine.js";

const WORD = 64;   // ตัวอักษร hex ต่อ 32 ไบต์
const MAX_UINT = (1n << 256n) - 1n;
const MIN_INT = -(1n << 255n);
const MAX_INT = (1n << 255n) - 1n;
const DYNAMIC = new Set(["string", "bytes"]);
const JSON_TYPES = new Set(["object", "array", "any"]);

export class AbiError extends Error {}
const bad = (message) => { throw new AbiError(message); };

/** metadata.abi → Map(selector → { name, signature, inputs: [{ name, type, evm }], outputs }) */
export function abiFunctions(abi) {
  const evm = toEvmAbi(abi).filter((entry) => entry.type === "function");
  const functions = new Map();
  for (const [i, fn] of (abi?.functions ?? []).entries()) {
    const typed = (fields, evmFields) => (fields ?? []).map((field, j) => ({ name: field.name, type: field.type, evm: evmFields[j].type }));
    const inputs = typed(fn.inputs, evm[i].inputs);
    const signature = `${fn.name}(${inputs.map((field) => field.evm).join(",")})`;
    const selector = `0x${bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8)}`;
    functions.set(selector, { name: fn.name, signature, inputs, outputs: typed(fn.outputs, evm[i].outputs) });
  }
  return functions;
}

// ---------- ถอด calldata ----------

const toJsonText = (value) => JSON.stringify(value ?? null, (key, v) => (typeof v === "bigint" ? `${v}n` : v));

function readWord(hex, offset) {
  const text = hex.slice(offset, offset + WORD);
  if (text.length !== WORD) bad("calldata สั้นเกินไป");
  return BigInt(`0x${text}`);
}

function decodeValue(field, hex, head) {
  const value = readWord(hex, head);
  if (field.evm === "address") {
    if (value >> 160n) bad(`${field.name}: address ไม่ถูกต้อง`);
    return `0x${value.toString(16).padStart(40, "0")}`;
  }
  if (field.evm === "uint256") return `${value}n`;
  if (field.evm === "int256") return `${value > MAX_INT ? value - (1n << 256n) : value}n`;
  if (field.evm === "bool") {
    if (value > 1n) bad(`${field.name}: bool ไม่ถูกต้อง`);
    return value === 1n;
  }
  // dynamic: word ที่หัว = offset (ไบต์) ของข้อมูลนับจากต้น argument
  const start = Number(value) * 2;
  if (value > BigInt(hex.length) || start % 2) bad(`${field.name}: offset ไม่ถูกต้อง`);
  const length = readWord(hex, start);
  if (length * 2n > BigInt(hex.length - start - WORD)) bad(`${field.name}: ความยาวเกินข้อมูล`);
  const body = hex.slice(start + WORD, start + WORD + Number(length) * 2);
  if (field.evm === "bytes") return `0x${body}`;
  const text = Buffer.from(body, "hex").toString("utf8");
  if (!JSON_TYPES.has(field.type)) return text;
  try { return JSON.parse(text); }
  catch { if (field.type === "any") return text; return bad(`${field.name}: ต้องเป็น JSON`); }
}

/** calldata (0x + selector + argument) → input ของโปรแกรม */
export function decodeInput(fn, data) {
  const hex = String(data).replace(/^0x/, "").slice(8).toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex)) bad("calldata ไม่ใช่ hex");
  return Object.fromEntries(fn.inputs.map((field, i) => [field.name, decodeValue(field, hex, i * WORD)]));
}

// ---------- เข้ารหัสผล ----------

const word = (value) => value.toString(16).padStart(WORD, "0");

function toBigInt(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "string" && /^-?\d+n?$/.test(value)) return BigInt(value.replace(/n$/, ""));
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (value === null || value === undefined) return 0n;
  return bad(`${label}: ไม่ใช่ตัวเลข`);
}

function encodeStatic(field, value) {
  if (field.evm === "address") {
    const text = String(value ?? "0x0").toLowerCase();
    if (!/^0x[0-9a-f]{0,40}$/.test(text)) bad(`${field.label}: ไม่ใช่ address`);
    return text.slice(2).padStart(WORD, "0");
  }
  if (field.evm === "bool") return word(value === true || value === "true" ? 1n : 0n);
  const big = toBigInt(value, field.label);
  if (field.evm === "uint256") {
    if (big < 0n || big > MAX_UINT) bad(`${field.label}: เกินช่วง uint256`);
    return word(big);
  }
  if (big < MIN_INT || big > MAX_INT) bad(`${field.label}: เกินช่วง int256`);
  return word(big < 0n ? (1n << 256n) + big : big);
}

function dynamicBytes(field, value) {
  if (field.evm === "bytes" && typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value)) return value.slice(2).toLowerCase();
  if (field.evm === "bytes" && value instanceof Uint8Array) return bytesToHex(value);
  const text = JSON_TYPES.has(field.type) || (typeof value === "object" && value !== null) ? toJsonText(value) : String(value ?? "");
  return bytesToHex(utf8ToBytes(text));
}

/** ผลของโปรแกรม → returndata ตาม outputs */
export function encodeOutput(fn, result) {
  const outputs = fn.outputs.map((field, i) => ({ ...field, label: field.name || `output ${i}` }));
  if (outputs.length === 0) return "0x";
  const values = outputs.length === 1 ? [result]
    : Array.isArray(result) ? result
      : outputs.map((field) => (field.name && result && typeof result === "object" ? result[field.name] : undefined));
  let head = "";
  let tail = "";
  for (const [i, field] of outputs.entries()) {
    if (!DYNAMIC.has(field.evm)) { head += encodeStatic(field, values[i]); continue; }
    const body = dynamicBytes(field, values[i]);
    head += word(BigInt(outputs.length * 32 + tail.length / 2));
    tail += word(BigInt(body.length / 2)) + body.padEnd(Math.ceil(body.length / WORD) * WORD, "0");
  }
  return `0x${head}${tail}`;
}
