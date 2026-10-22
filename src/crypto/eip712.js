/**
 * EIP-712 (typed structured data) แบบเดียวกับที่ MetaMask eth_signTypedData_v4 / ethers TypedDataEncoder เซ็น
 * ไม่พึ่ง VM — ใช้ทั้งใน VM (API eip712Digest / eip712DomainSeparator ของโปรแกรม) และฝั่ง wallet / เทสต์
 *
 *   eip712Digest(domain, types, primaryType, message)  → "0x…" 32 byte = keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))
 *   eip712DomainSeparator(domain, types?)              → "0x…" 32 byte = hashStruct("EIP712Domain", domain)
 *   eip712HashStruct(primaryType, types, value)        → "0x…" 32 byte
 *   eip712EncodeType(primaryType, types)               → "Mail(Person from,Person to,string contents)Person(string name,address wallet)"
 *
 * types = { ชื่อ struct: [{ name, type }, …] } · มี EIP712Domain หรือไม่มีก็ได้ (ไม่มี = ใช้ field ของ domain ที่มีค่า
 *   ตามลำดับ name, version, chainId, verifyingContract, salt แบบ ethers)
 * ค่า: uintN / intN = bigint / number (จำนวนเต็มปลอดภัย) / string ทศนิยมหรือ "0x…" · address = "0x" + 40 hex
 *      bool = true / false · bytesN = "0x…" ยาว N byte พอดี · bytes = "0x…" · string = ข้อความ (UTF-8)
 *      struct = object (field เกินถูกข้าม · ขาด = error) · T[] / T[k] = array
 * ทุกอย่าง deterministic · error = Error ธรรมดาพร้อมข้อความ (VM แปลงเป็น INVALID_REQUEST)
 * meter (ไม่บังคับ) = { hashes, bytes } นับจำนวนครั้งที่ keccak และจำนวน byte ที่ถูก hash → VM ใช้คิดแก๊ส
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";

/** ลำดับ field ของ EIP712Domain (ตาม EIP-712 / ethers) */
export const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];
/** ซ้อน array / struct ลึกได้ไม่เกินนี้ · จำนวน struct / field สูงสุด — กัน stack ของ host (ทุกเครื่องต้องล้มที่จุดเดียวกัน = deterministic) */
export const EIP712_MAX_DEPTH = 32;
export const EIP712_MAX_TYPES = 64;
export const EIP712_MAX_FIELDS = 128;

const NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ARRAY_PATTERN = /^(.+)\[(\d*)\]$/;
const INT_PATTERN = /^(u?)int(\d+)$/;
const BYTES_N_PATTERN = /^bytes(\d+)$/;

const fail = (message) => {
  throw new Error(message);
};
const describe = (value) => (typeof value === "bigint" ? `${value}n` : typeof value === "string" ? JSON.stringify(value) : String(value));
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** "0x…" → bytes (จำนวนไบต์เต็มเท่านั้น) */
export function hexBytes(value, label = "ค่า") {
  if (typeof value !== "string" || !HEX_BYTES_PATTERN.test(value)) fail(`${label} ต้องเป็น hex string "0x…" จำนวนไบต์เต็ม`);
  return hexToBytes(value.slice(2));
}

const keccakOf = (bytes, meter) => {
  if (meter) {
    meter.hashes += 1;
    meter.bytes += bytes.length;
  }
  return keccak_256(bytes);
};

/** จำนวนเต็มตามแบบที่ ethers รับ (BigNumberish) */
function toBigInt(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail(`${label}: number ต้องเป็นจำนวนเต็มปลอดภัย (ใช้ BigInt แทน)`);
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (/^-?(0|[1-9]\d*)$/.test(value)) return BigInt(value);
    if (/^-?0x[0-9a-fA-F]+$/.test(value)) return value.startsWith("-") ? -BigInt(value.slice(1)) : BigInt(value);
  }
  return fail(`${label}: ต้องเป็นจำนวนเต็ม (ได้ ${describe(value)})`);
}

const word = (big) => {
  const out = new Uint8Array(32);
  let v = big;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

/** อ่าน types → Map(ชื่อ struct → [{ name, type }]) พร้อมตรวจรูปแบบ (ไม่รวม EIP712Domain) */
function readTypes(types) {
  if (!isPlainObject(types)) fail("types ต้องเป็น object ของ { ชื่อ struct: [{ name, type }] }");
  const map = new Map();
  if (Object.keys(types).length > EIP712_MAX_TYPES) fail(`types มี struct ได้ไม่เกิน ${EIP712_MAX_TYPES} ชนิด`);
  for (const typeName of Object.keys(types)) {
    if (!NAME_PATTERN.test(typeName)) fail(`ชื่อ struct ไม่ถูกต้อง: ${JSON.stringify(typeName)}`);
    const fields = types[typeName];
    if (!Array.isArray(fields)) fail(`types.${typeName} ต้องเป็น array ของ { name, type }`);
    if (fields.length > EIP712_MAX_FIELDS) fail(`types.${typeName} มี field ได้ไม่เกิน ${EIP712_MAX_FIELDS}`);
    const seen = new Set();
    const list = fields.map((field) => {
      if (!isPlainObject(field) || typeof field.name !== "string" || typeof field.type !== "string") {
        fail(`types.${typeName}: field ต้องเป็น { name, type }`);
      }
      if (!NAME_PATTERN.test(field.name)) fail(`types.${typeName}: ชื่อ field ไม่ถูกต้อง ${JSON.stringify(field.name)}`);
      if (seen.has(field.name)) fail(`types.${typeName}: field '${field.name}' ซ้ำ`);
      seen.add(field.name);
      return { name: field.name, type: field.type };
    });
    map.set(typeName, list);
  }
  // ตรวจชนิดของทุก field ว่ารู้จัก และไม่มี struct อ้างตัวเองเป็นวง (ethers ปฏิเสธเช่นกัน)
  for (const [typeName, fields] of map) {
    for (const field of fields) checkType(field.type, map, `${typeName}.${field.name}`);
  }
  for (const typeName of map.keys()) dependencies(typeName, map, true);
  return map;
}

/** ชนิดฐานของ array ("Person[][2]" → "Person") */
const baseType = (type) => {
  let base = type;
  for (let match = ARRAY_PATTERN.exec(base); match; match = ARRAY_PATTERN.exec(base)) base = match[1];
  return base;
};

function isAtomic(type) {
  if (type === "address" || type === "bool" || type === "string" || type === "bytes") return true;
  const int = INT_PATTERN.exec(type);
  if (int) {
    const width = Number(int[2]);
    return int[2] === String(width) && width >= 8 && width <= 256 && width % 8 === 0;
  }
  const bytes = BYTES_N_PATTERN.exec(type);
  if (bytes) {
    const width = Number(bytes[1]);
    return bytes[1] === String(width) && width >= 1 && width <= 32;
  }
  return false;
}

function checkType(type, map, where) {
  let depth = 0;
  for (let match = ARRAY_PATTERN.exec(type), rest = type; match; match = ARRAY_PATTERN.exec(rest)) {
    if (match[2] !== "" && match[2] !== String(Number(match[2]))) fail(`${where}: ขนาด array ไม่ถูกต้อง '${type}'`);
    rest = match[1];
    if (++depth > EIP712_MAX_DEPTH) fail(`${where}: array ซ้อนลึกเกิน ${EIP712_MAX_DEPTH} ชั้น`);
  }
  const base = baseType(type);
  if (!isAtomic(base) && !map.has(base)) fail(`${where}: ไม่รู้จักชนิด '${type}'`);
}

/** struct ที่ typeName อ้างถึง (ไม่รวมตัวเอง) · strict = ห้ามวน */
function dependencies(typeName, map, strict = false) {
  const found = new Set();
  const visit = (name, path) => {
    for (const field of map.get(name)) {
      const base = baseType(field.type);
      if (!map.has(base)) continue;
      if (strict && path.includes(base)) fail(`struct '${base}' อ้างถึงตัวเองเป็นวง`);
      if (found.has(base)) continue;
      found.add(base);
      visit(base, [...path, base]);
    }
  };
  visit(typeName, [typeName]);
  found.delete(typeName);
  return found;
}

const encodeStruct = (name, fields) => `${name}(${fields.map((field) => `${field.type} ${field.name}`).join(",")})`;

function encodeTypeOf(typeName, map) {
  if (!map.has(typeName)) fail(`ไม่รู้จัก struct '${typeName}'`);
  // เรียงชื่อแบบเดียวกับ ethers / MetaMask (เทียบ code unit · ชื่อเป็น ASCII อยู่แล้ว)
  const deps = [...dependencies(typeName, map)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [typeName, ...deps].map((name) => encodeStruct(name, map.get(name))).join("");
}

/** ตัวเข้ารหัสค่าของแต่ละ field เป็น 32 byte (ใช้ซ้ำใน call เดียว: typeHash ถูก cache) */
function makeEncoder(map, meter) {
  const typeHashes = new Map();
  const typeHash = (name) => {
    if (!typeHashes.has(name)) typeHashes.set(name, keccakOf(utf8ToBytes(encodeTypeOf(name, map)), meter));
    return typeHashes.get(name);
  };

  const encodeValue = (type, value, label, depth) => {
    if (depth > EIP712_MAX_DEPTH) fail(`${label}: ซ้อนลึกเกิน ${EIP712_MAX_DEPTH} ชั้น`);
    if (value === undefined || value === null) fail(`${label}: ไม่มีค่า (${type})`);
    const array = ARRAY_PATTERN.exec(type);
    if (array) {
      if (!Array.isArray(value)) fail(`${label}: ต้องเป็น array (${type})`);
      if (array[2] !== "" && value.length !== Number(array[2])) fail(`${label}: ต้องมี ${array[2]} ช่อง (ได้ ${value.length})`);
      const parts = value.map((item, i) => encodeValue(array[1], item, `${label}[${i}]`, depth + 1));
      return keccakOf(concatBytes(...parts), meter);
    }
    if (map.has(type)) return hashStructOf(type, value, label, depth + 1);
    if (type === "address") {
      if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) fail(`${label}: ต้องเป็น address "0x" + 40 hex (ได้ ${describe(value)})`);
      const out = new Uint8Array(32);
      out.set(hexToBytes(value.slice(2)), 12);
      return out;
    }
    if (type === "bool") {
      if (typeof value !== "boolean") fail(`${label}: ต้องเป็น true / false (ได้ ${describe(value)})`);
      return word(value ? 1n : 0n);
    }
    if (type === "string") {
      if (typeof value !== "string") fail(`${label}: ต้องเป็น string (ได้ ${describe(value)})`);
      return keccakOf(utf8ToBytes(value), meter);
    }
    if (type === "bytes") return keccakOf(hexBytes(value, label), meter);
    const bytesN = BYTES_N_PATTERN.exec(type);
    if (bytesN) {
      const bytes = hexBytes(value, label);
      if (bytes.length !== Number(bytesN[1])) fail(`${label}: ต้องยาว ${bytesN[1]} byte พอดี (ได้ ${bytes.length})`);
      const out = new Uint8Array(32);
      out.set(bytes, 0);
      return out;
    }
    const int = INT_PATTERN.exec(type);
    if (int) {
      const width = BigInt(int[2]);
      const number = toBigInt(value, label);
      const signed = int[1] === "";
      const min = signed ? -(1n << (width - 1n)) : 0n;
      const max = signed ? (1n << (width - 1n)) - 1n : (1n << width) - 1n;
      if (number < min || number > max) fail(`${label}: เกินช่วงของ ${type} (${number})`);
      return word(number < 0n ? (1n << 256n) + number : number);
    }
    return fail(`${label}: ไม่รู้จักชนิด '${type}'`);
  };

  const hashStructOf = (typeName, value, label, depth = 0) => {
    if (!isPlainObject(value)) fail(`${label}: ต้องเป็น object ของ struct ${typeName}`);
    const parts = [typeHash(typeName)];
    for (const field of map.get(typeName)) {
      if (!Object.hasOwn(value, field.name)) fail(`${label}.${field.name}: ไม่มีค่า (${field.type})`);
      parts.push(encodeValue(field.type, value[field.name], `${label}.${field.name}`, depth));
    }
    return keccakOf(concatBytes(...parts), meter);
  };

  return { hashStructOf };
}

/** ชนิดของ domain: types.EIP712Domain ถ้ามี · ไม่มี = field ที่ domain มีค่า (ลำดับมาตรฐาน) */
function domainFields(domain, types) {
  if (!isPlainObject(domain)) fail("domain ต้องเป็น object { name?, version?, chainId?, verifyingContract?, salt? }");
  if (isPlainObject(types) && Object.hasOwn(types, "EIP712Domain")) return null;   // ใช้ของ types
  for (const key of Object.keys(domain)) {
    if (!DOMAIN_FIELDS.some((field) => field.name === key)) fail(`domain: ไม่รู้จัก field '${key}'`);
  }
  return DOMAIN_FIELDS.filter((field) => domain[field.name] !== undefined && domain[field.name] !== null);
}

/** types ของ message โดยไม่มี EIP712Domain (ethers ห้ามมีใน types · MetaMask ต้องมี — รับทั้งสองแบบ) */
function messageTypes(types) {
  if (!isPlainObject(types)) fail("types ต้องเป็น object ของ { ชื่อ struct: [{ name, type }] }");
  const { EIP712Domain: _domain, ...rest } = types;
  return rest;
}

function domainSeparatorBytes(domain, types, meter) {
  const fields = domainFields(domain, types);
  const domainType = fields ?? types.EIP712Domain;
  const map = readTypes({ ...(fields ? {} : messageTypes(types)), EIP712Domain: domainType });
  for (const field of map.get("EIP712Domain")) {
    const known = DOMAIN_FIELDS.find((item) => item.name === field.name);
    if (!known || known.type !== field.type) fail(`EIP712Domain: field '${field.name} ${field.type}' ไม่ใช่ของมาตรฐาน`);
  }
  return makeEncoder(map, meter).hashStructOf("EIP712Domain", domain, "domain");
}

/** domainSeparator ของ domain (เท่ากับ ethers TypedDataEncoder.hashDomain) */
export function eip712DomainSeparator(domain, types, meter) {
  return `0x${bytesToHex(domainSeparatorBytes(domain, types, meter))}`;
}

/** hashStruct(primaryType, value) */
export function eip712HashStruct(primaryType, types, value, meter) {
  const map = readTypes(messageTypes(types));
  if (typeof primaryType !== "string" || !map.has(primaryType)) fail(`primaryType '${primaryType}' ไม่อยู่ใน types`);
  return `0x${bytesToHex(makeEncoder(map, meter).hashStructOf(primaryType, value, primaryType))}`;
}

/** encodeType ของ struct (ตัวมันเอง + struct ที่อ้างถึงเรียงตามชื่อ) */
export function eip712EncodeType(primaryType, types) {
  return encodeTypeOf(primaryType, readTypes(messageTypes(types)));
}

/**
 * digest ที่ eth_signTypedData_v4 เซ็น = keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))
 * primaryType = "EIP712Domain" → digest ของ domain อย่างเดียว (keccak256(0x1901 ‖ domainSeparator) แบบ MetaMask)
 */
export function eip712Digest(domain, types, primaryType, message, meter) {
  if (typeof primaryType !== "string" || primaryType === "") fail("primaryType ต้องเป็นชื่อ struct");
  const separator = domainSeparatorBytes(domain, types, meter);
  const parts = [new Uint8Array([0x19, 0x01]), separator];
  if (primaryType !== "EIP712Domain") {
    const map = readTypes(messageTypes(types));
    if (!map.has(primaryType)) fail(`primaryType '${primaryType}' ไม่อยู่ใน types`);
    parts.push(makeEncoder(map, meter).hashStructOf(primaryType, message, primaryType));
  }
  return `0x${bytesToHex(keccakOf(concatBytes(...parts), meter))}`;
}

/** keccak256 ของ byte ดิบ "0x…" → "0x…" 32 byte */
export const keccak256Bytes = (hex, meter) => `0x${bytesToHex(keccakOf(hexBytes(hex), meter))}`;

/**
 * ecrecover แบบ EVM: digest 32 byte ("0x…" หรือ Uint8Array) + ลายเซ็น "0x" + r + s + v (65 byte, v = 27 / 28) → address ตัวพิมพ์เล็ก
 * ลายเซ็นใช้ไม่ได้ → null (ไม่ throw) · ใช้ร่วมกันทั้ง ecrecover / ecrecoverDigest ใน VM และตัวช่วยฝั่ง wallet
 */
export function recoverAddress(digest, signature) {
  try {
    const hash = typeof digest === "string" ? hexToBytes(digest.replace(/^0x/, "")) : digest;
    const bytes = hexToBytes(String(signature).replace(/^0x/, ""));
    if (hash.length !== 32 || bytes.length !== 65) return null;
    const v = bytes[64];
    if (v !== 27 && v !== 28) return null;
    const publicKey = secp256k1.recoverPublicKey(new Uint8Array([v - 27, ...bytes.slice(0, 64)]), hash, { prehash: false });
    return `0x${bytesToHex(keccak_256(secp256k1.Point.fromBytes(publicKey).toBytes(false).slice(1))).slice(-40)}`;
  } catch {
    return null;
  }
}
