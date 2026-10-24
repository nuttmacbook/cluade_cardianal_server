/**
 * eth_sendRawTransaction (ระยะ 3.5): tx แบบ Ethereum ที่กระเป๋า / Hardhat / Remix เซ็นมา → tx ของเชน
 *
 *   const decoded = decodeRawTransaction(raw);              // { type, chainId, nonce, gasLimit, to, value, data, sender, hash, signature, fees }
 *   const verified = rawToVerified(decoded, { resolveCall }); // รูปเดียวกับ verifyTransaction() → mempool.add(…, { verified })
 *
 * รับ: type 0 (legacy ที่มี chainId แบบ EIP-155 เท่านั้น — กัน replay ข้ามเชน) และ type 2 (EIP-1559 · access list ต้องว่าง)
 * ไม่รับ: type 1 / 3 / 4 · deploy bytecode (to ว่าง) — โปรแกรมของเชนเป็น JS ไม่ใช่ EVM bytecode
 * การแปลง:
 *   to ไม่ใช่โปรแกรม + data ว่าง          → transfer native (value)
 *   to เป็นโปรแกรม + data = selector + args → call (resolveCall แปลงเป็น method + input: ERC-20 ของ token มาตรฐาน หรือ metadata.abi)
 * hash = keccak(raw) แบบ Ethereum (เก็บเป็น digest ของ tx → /tx/:hash · eth_getTransactionReceipt หาเจอด้วย hash นี้)
 * ผู้ส่ง = recover จากลายเซ็น · nonce / ค่าแก๊สใช้ตัวนับเดียวกับ tx แบบ EIP-712
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";

export class RawTxError extends Error {}
const bad = (message) => { throw new RawTxError(message); };

// ---------- RLP ----------

function rlpDecode(bytes) {
  const [item, end] = rlpItem(bytes, 0);
  if (end !== bytes.length) bad("RLP มีข้อมูลเกิน");
  return item;
}

function rlpItem(bytes, at) {
  if (at >= bytes.length) bad("RLP สั้นเกินไป");
  const prefix = bytes[at];
  const length = (start, size) => {
    if (start + size > bytes.length) bad("RLP สั้นเกินไป");
    let value = 0;
    for (let i = 0; i < size; i += 1) value = value * 256 + bytes[start + i];
    if (size > 0 && bytes[start] === 0) bad("RLP ความยาวมีศูนย์นำหน้า");
    return value;
  };
  const slice = (start, size) => {
    if (start + size > bytes.length) bad("RLP สั้นเกินไป");
    return bytes.slice(start, start + size);
  };
  if (prefix < 0x80) return [bytes.slice(at, at + 1), at + 1];
  if (prefix <= 0xb7) {
    const size = prefix - 0x80;
    const value = slice(at + 1, size);
    if (size === 1 && value[0] < 0x80) bad("RLP ไม่เป็นรูปมาตรฐาน");
    return [value, at + 1 + size];
  }
  if (prefix <= 0xbf) {
    const sizeOfSize = prefix - 0xb7;
    const size = length(at + 1, sizeOfSize);
    if (size <= 55) bad("RLP ไม่เป็นรูปมาตรฐาน");
    return [slice(at + 1 + sizeOfSize, size), at + 1 + sizeOfSize + size];
  }
  const long = prefix > 0xf7;
  const sizeOfSize = long ? prefix - 0xf7 : 0;
  const size = long ? length(at + 1, sizeOfSize) : prefix - 0xc0;
  if (long && size <= 55) bad("RLP ไม่เป็นรูปมาตรฐาน");
  const start = at + 1 + sizeOfSize;
  const end = start + size;
  if (end > bytes.length) bad("RLP สั้นเกินไป");
  const items = [];
  for (let cursor = start; cursor < end;) {
    const [item, next] = rlpItem(bytes, cursor);
    items.push(item);
    cursor = next;
  }
  return [items, end];
}

const rlpLength = (size, offset) => {
  if (size <= 55) return new Uint8Array([offset + size]);
  const hex = size.toString(16).padStart(Math.ceil(size.toString(16).length / 2) * 2, "0");
  return concatBytes(new Uint8Array([offset + 55 + hex.length / 2]), hexToBytes(hex));
};

export function rlpEncode(item) {
  if (Array.isArray(item)) {
    const body = concatBytes(...item.map(rlpEncode));
    return concatBytes(rlpLength(body.length, 0xc0), body);
  }
  if (item.length === 1 && item[0] < 0x80) return item;
  return concatBytes(rlpLength(item.length, 0x80), item);
}

// ---------- ค่า ----------

const isBytes = (item) => item instanceof Uint8Array;
function uint(item, label) {
  if (!isBytes(item)) bad(`${label} ต้องเป็นตัวเลข`);
  if (item.length > 32) bad(`${label} ใหญ่เกิน 256 bit`);
  if (item.length > 0 && item[0] === 0) bad(`${label} มีศูนย์นำหน้า`);
  return item.length ? BigInt(`0x${bytesToHex(item)}`) : 0n;
}
const safe = (value, label) => (value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : bad(`${label} ใหญ่เกินไป`));
const uintBytes = (value) => (value === 0n ? new Uint8Array() : hexToBytes(value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, "0")));

function recover(signingHash, r, s, recovery) {
  if (r === 0n || s === 0n || r >= secp256k1.Point.CURVE().n || s >= secp256k1.Point.CURVE().n) bad("ลายเซ็นไม่ถูกต้อง");
  if (s > secp256k1.Point.CURVE().n / 2n) bad("ลายเซ็นไม่ถูกต้อง (s สูงเกิน: EIP-2)");
  const signature = concatBytes(new Uint8Array([recovery]), hexToBytes(r.toString(16).padStart(64, "0")), hexToBytes(s.toString(16).padStart(64, "0")));
  let publicKey;
  try { publicKey = secp256k1.recoverPublicKey(signature, signingHash, { prehash: false }); }
  catch { return bad("ลายเซ็นไม่ถูกต้อง"); }
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false).slice(1);
  return `0x${bytesToHex(keccak_256(uncompressed)).slice(-40)}`;
}

/** raw tx (0x…) → ข้อมูลของ tx + ผู้ส่ง (recover) */
export function decodeRawTransaction(raw) {
  if (typeof raw !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(raw)) bad("raw transaction ต้องเป็น hex");
  if (raw.length > 2 + 2 * 128 * 1024) bad("raw transaction ใหญ่เกิน 128 KB");
  const bytes = hexToBytes(raw.slice(2));
  const hash = `0x${bytesToHex(keccak_256(bytes))}`;
  let fields;
  let type;
  if (bytes[0] >= 0xc0) {
    type = 0;
    fields = rlpDecode(bytes);
    if (!Array.isArray(fields) || fields.length !== 9) bad("legacy tx ต้องมี 9 ฟิลด์");
  } else if (bytes[0] === 0x02) {
    type = 2;
    fields = rlpDecode(bytes.slice(1));
    if (!Array.isArray(fields) || fields.length !== 12) bad("tx type 2 ต้องมี 12 ฟิลด์");
  } else {
    bad(`ไม่รองรับ tx type ${bytes[0]} (รับ legacy แบบ EIP-155 และ type 2)`);
  }
  if (fields.some((field, i) => !isBytes(field) && !(type === 2 && i === 8))) bad("ฟิลด์ของ tx ต้องเป็น bytes");

  if (type === 0) {
    const [nonce, gasPrice, gasLimit, to, value, data, v, r, s] = fields;
    const vNumber = uint(v, "v");
    if (vNumber === 27n || vNumber === 28n) bad("tx ไม่มี chainId (ต้องเป็น EIP-155 กันการนำไปใช้ซ้ำข้ามเชน)");
    if (vNumber < 35n) bad("v ไม่ถูกต้อง");
    const chainId = (vNumber - 35n) / 2n;
    const recovery = Number((vNumber - 35n) % 2n);
    const signingHash = keccak_256(rlpEncode([nonce, gasPrice, gasLimit, to, value, data, uintBytes(chainId), new Uint8Array(), new Uint8Array()]));
    const rBig = uint(r, "r");
    const sBig = uint(s, "s");
    return {
      type, hash, chainId, nonce: safe(uint(nonce, "nonce"), "nonce"), gasLimit: safe(uint(gasLimit, "gasLimit"), "gasLimit"),
      to: address(to), value: uint(value, "value"), data: `0x${bytesToHex(data)}`,
      fees: { gasPrice: uint(gasPrice, "gasPrice") },
      sender: recover(signingHash, rBig, sBig, recovery), signature: signatureHex(rBig, sBig, recovery), raw: raw.toLowerCase(),
    };
  }
  const [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, yParity, r, s] = fields;
  if (!Array.isArray(accessList)) bad("accessList ต้องเป็น list");
  if (accessList.length) bad("ไม่รองรับ accessList (ต้องว่าง)");
  const parity = uint(yParity, "yParity");
  if (parity > 1n) bad("yParity ไม่ถูกต้อง");
  const signingHash = keccak_256(concatBytes(new Uint8Array([2]), rlpEncode(fields.slice(0, 9))));
  const rBig = uint(r, "r");
  const sBig = uint(s, "s");
  const maxFee = uint(maxFeePerGas, "maxFeePerGas");
  const maxPriority = uint(maxPriorityFeePerGas, "maxPriorityFeePerGas");
  if (maxPriority > maxFee) bad("maxPriorityFeePerGas สูงกว่า maxFeePerGas");
  return {
    type, hash, chainId: uint(chainId, "chainId"), nonce: safe(uint(nonce, "nonce"), "nonce"), gasLimit: safe(uint(gasLimit, "gasLimit"), "gasLimit"),
    to: address(to), value: uint(value, "value"), data: `0x${bytesToHex(data)}`,
    fees: { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority },
    sender: recover(signingHash, rBig, sBig, Number(parity)), signature: signatureHex(rBig, sBig, Number(parity)), raw: raw.toLowerCase(),
  };
}

function address(item) {
  if (item.length === 0) return null;
  if (item.length !== 20) bad("to ต้องยาว 20 byte");
  return `0x${bytesToHex(item)}`;
}
const signatureHex = (r, s, recovery) => `0x${r.toString(16).padStart(64, "0")}${s.toString(16).padStart(64, "0")}${(27 + recovery).toString(16)}`;

/**
 * tx ที่ถอดแล้ว → { action, method, sender, hash, request, tx } รูปเดียวกับ verifyTransaction (mempool.add({ tx }, { verified }))
 * @param {{ chainId: number, isProgram: (address) => boolean, resolveCall: (to, data) => { method: string, input: object } }} options
 *   resolveCall throw RawTxError เมื่อแปลง data ไม่ได้
 */
export function rawToVerified(decoded, { chainId, isProgram, resolveCall }) {
  if (decoded.chainId !== BigInt(chainId)) bad(`chainId ของ tx (${decoded.chainId}) ไม่ตรงกับเชน (${chainId})`);
  if (decoded.to === null) bad("deploy bytecode ไม่ได้: โปรแกรมของเชนเป็น JavaScript (deploy ผ่าน /sendtx)");
  const program = isProgram(decoded.to);
  const empty = decoded.data === "0x";
  if (!program && !empty) bad("ส่ง data ไปที่ address ที่ไม่ใช่โปรแกรมไม่ได้");
  if (program && empty) bad("โปรแกรมไม่มีฟังก์ชันรับเงินเปล่า (ต้องเรียกฟังก์ชันตาม metadata.abi)");

  const fees = decoded.type === 2
    ? { maxFeePerGas: decoded.fees.maxFeePerGas > 0n ? String(decoded.fees.maxFeePerGas) : undefined, maxPriorityFeePerGas: String(decoded.fees.maxPriorityFeePerGas) }
    : { gasPrice: decoded.fees.gasPrice > 0n ? String(decoded.fees.gasPrice) : undefined };
  const common = { nonce: decoded.nonce, gasLimit: decoded.gasLimit || undefined, ...fees, signature: decoded.signature, digest: decoded.hash, evmRaw: decoded.raw };
  const value = `${decoded.value}n`;
  const sender = decoded.sender;
  const tx = { chainId: Number(decoded.chainId), from: sender, to: decoded.to, value, nonce: decoded.nonce, gasLimit: decoded.gasLimit, evmRaw: decoded.raw };
  if (!program) {
    return { action: "transfer", method: "transfer", sender, hash: decoded.hash,
      request: { from: sender, to: decoded.to, amount: value, ...common }, tx: { ...tx, action: "transfer" } };
  }
  const { method, input } = resolveCall(decoded.to, decoded.data);
  return { action: "call", method: "call", sender, hash: decoded.hash,
    request: { programUuid: decoded.to, functionName: method, input, value, context: { sender, origin: sender }, ...common },
    tx: { ...tx, action: "call", method, input } };
}
