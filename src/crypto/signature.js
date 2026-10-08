/**
 * ตรวจลายเซ็นของ tx ก่อนส่งเข้า VM (ทำงานฝั่ง server, ไม่แตะ virtualmachine.js)
 *
 *   ฝั่ง wallet:  signTransaction(tx, privateKey)           → signature
 *   ฝั่ง server:  verifyTransaction({ tx, signature })       → { action, request, sender, hash }
 *                 vm[action](request)
 *
 * รูปแบบลายเซ็น: EIP-712 บน secp256k1 แบบเดียวกับ wallet ตระกูล EVM
 *   - ผู้ใช้เห็นเป็นฟิลด์ (action / from / to / method / value / nonce) ไม่ใช่ hash เปล่า ๆ
 *   - context.sender ที่ส่งเข้า VM มาจากลายเซ็นเสมอ ไม่ใช่สิ่งที่ user พิมพ์มา
 *   - origin = sender เสมอสำหรับ tx ของ user (การส่งต่อ origin เป็นหน้าที่ของ runProgram)
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, normalizeAddress, normalizeHexDeep } from "../core/virtualmachine.js";

export const DOMAIN_NAME = "ProgramVM";
export const DOMAIN_VERSION = "1";

/** ฟิลด์ที่ถูกเซ็น (ลำดับสำคัญ ห้ามสลับ) */
export const TRANSACTION_TYPE = [
  { name: "action", type: "string" },
  { name: "from", type: "address" },
  { name: "to", type: "string" },
  { name: "method", type: "string" },
  { name: "input", type: "string" },
  { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "gasLimit", type: "uint256" },
  { name: "gasPrice", type: "uint256" },
];

const ACTIONS = new Set(["call", "deploy", "transfer", "metadata", "init", "reject"]);
const HASH_LENGTH = 32;
const SIGNATURE_LENGTH = 65;

const fail = (message) => {
  throw new Error(message);
};

const keccak = (bytes) => keccak_256(bytes);
const keccakHex = (bytes) => `0x${bytesToHex(keccak(bytes))}`;
const encodeString = (text) => keccak(utf8ToBytes(text));

const encodeUint = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail("ค่าตัวเลขใน tx ต้องเป็นจำนวนเต็มไม่ติดลบ");
  const bytes = new Uint8Array(32);
  let rest = BigInt(value);
  for (let i = 31; i >= 0 && rest > 0n; i -= 1) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
};

const encodeAddress = (address) => {
  const hex = String(address).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,40}$/.test(hex)) fail(`address ไม่ถูกต้อง: ${address}`);
  const bytes = new Uint8Array(32);
  bytes.set(hexToBytes(hex.padStart(40, "0")), 12);
  return bytes;
};

/** ข้อมูลที่ถูกเซ็น: เติมค่าที่ไม่ได้ส่งมาให้ครบ และ normalize address ให้เป็นตัวพิมพ์เล็ก */
export function normalizeTransaction(tx = {}) {
  const action = tx.action ?? "call";
  if (!ACTIONS.has(action)) fail(`action ไม่ถูกต้อง: ${action}`);

  return {
    chainId: tx.chainId ?? 1,
    action,
    from: normalizeAddress(tx.from ?? ""),
    to: normalizeAddress(tx.to ?? ""),
    method: tx.method ?? "",
    input: normalizeHexDeep(tx.input ?? {}),
    code: tx.code ?? null,
    value: tx.value ?? 0,
    nonce: tx.nonce ?? 0,
    gasLimit: tx.gasLimit ?? 0,
    gasPrice: tx.gasPrice ?? 0,   // 0 = ใช้ราคาขั้นต่ำของระบบ
  };
}

/** โครงสร้าง EIP-712 ที่ wallet ใช้แสดงให้ผู้ใช้ดูก่อนเซ็น */
export function buildTypedData(rawTx) {
  const tx = normalizeTransaction(rawTx);
  return {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: tx.chainId },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      Transaction: TRANSACTION_TYPE,
    },
    primaryType: "Transaction",
    message: {
      action: tx.action,
      from: tx.from,
      to: tx.to,
      method: tx.method,
      // input + code ถูกรวมเป็น string เดียวแบบ canonical เพื่อให้เซ็นได้ทุกชนิดข้อมูล
      input: canonicalJson({ input: tx.input, code: tx.code }),
      value: tx.value,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
    },
  };
}

const typeHashOf = (name, fields) => encodeString(`${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`);

const encodeField = ({ type }, value) => {
  if (type === "string") return encodeString(value);
  if (type === "address") return encodeAddress(value);
  if (type === "uint256") return encodeUint(value);
  return fail(`ไม่รองรับชนิด ${type}`);
};

/** hash ที่ถูกเซ็นจริง (EIP-712 digest) */
export function hashTypedData(rawTx) {
  const { domain, types, message } = buildTypedData(rawTx);

  const domainSeparator = keccak(concatBytes(
    typeHashOf("EIP712Domain", types.EIP712Domain),
    encodeString(domain.name),
    encodeString(domain.version),
    encodeUint(domain.chainId),
  ));
  const structHash = keccak(concatBytes(
    typeHashOf("Transaction", types.Transaction),
    ...types.Transaction.map((field) => encodeField(field, message[field.name])),
  ));

  return keccakHex(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator, structHash));
}

// ---------- key / address ----------

export const randomPrivateKey = () => `0x${bytesToHex(secp256k1.utils.randomSecretKey())}`;

const toBytes = (hex, length, label) => {
  const bytes = hexToBytes(String(hex).replace(/^0x/, ""));
  if (length && bytes.length !== length) fail(`${label} ต้องยาว ${length} byte`);
  return bytes;
};

const addressOfPublicKey = (publicKey) => {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false).slice(1); // ตัด 0x04 ออก
  return `0x${bytesToHex(keccak(uncompressed)).slice(-40)}`;
};

export const addressOf = (privateKey) => addressOfPublicKey(secp256k1.getPublicKey(toBytes(privateKey, 32, "privateKey"), true));

// ---------- sign / recover ----------

/** เซ็น tx (ปกติเป็นงานของ wallet — มีไว้ให้ทดสอบและทำ client ได้) */
export function signTransaction(tx, privateKey) {
  const digest = toBytes(hashTypedData(tx), HASH_LENGTH, "digest");
  const signed = secp256k1.sign(digest, toBytes(privateKey, 32, "privateKey"), { format: "recovered", prehash: false });
  const recovery = signed[0];
  return `0x${bytesToHex(signed.slice(1))}${(27 + recovery).toString(16).padStart(2, "0")}`; // r || s || v
}

/** address ของผู้เซ็น */
export function recoverSigner(tx, signature) {
  const bytes = toBytes(signature, SIGNATURE_LENGTH, "signature");
  const v = bytes[64];
  if (v !== 27 && v !== 28) fail("signature เสียหาย (v ต้องเป็น 27 หรือ 28)");

  const digest = toBytes(hashTypedData(tx), HASH_LENGTH, "digest");
  const recovered = concatBytes(new Uint8Array([v - 27]), bytes.slice(0, 64));
  const publicKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  return addressOfPublicKey(publicKey);
}

// ---------- ใช้งานฝั่ง server ----------

/** แปลง tx ที่เซ็นแล้วเป็น request ของ VM (sender / origin มาจากลายเซ็นเท่านั้น) */
export function toVmRequest(tx, sender, signature, digest) {
  const context = { sender, origin: sender };
  const common = { context, nonce: tx.nonce, gasLimit: tx.gasLimit || undefined, gasPrice: tx.gasPrice || undefined, signature, digest };

  if (tx.action === "transfer") return { from: sender, to: tx.to, amount: tx.value, ...common, context: undefined };
  if (tx.action === "metadata") return { metadata: tx.input, ...common };
  if (tx.action === "init" || tx.action === "reject") return { programUuid: tx.to, ...common };
  if (tx.action === "deploy") return { programUuid: tx.to || undefined, code: tx.code, initInput: tx.input, value: tx.value, ...common };
  return { programUuid: tx.to, functionName: tx.method, input: tx.input, value: tx.value, ...common };
}

/** ชื่อเมธอดของ VM ที่ใช้กับแต่ละ action */
export const VM_METHOD = { call: "call", deploy: "deploy", transfer: "transfer", metadata: "setMetadata", init: "init", reject: "reject" };

/**
 * ตรวจลายเซ็นแล้วคืน request ที่พร้อมส่งเข้า VM
 * @returns {{ action: string, method: string, sender: string, request: object, hash: string }}
 */
export function verifyTransaction({ tx, signature } = {}) {
  const normalized = normalizeTransaction(tx);
  const sender = recoverSigner(normalized, signature);
  if (normalized.from && sender !== normalized.from) fail(`ลายเซ็นไม่ตรงกับ from: เซ็นโดย ${sender}`);

  const digest = hashTypedData(normalized);
  return {
    action: normalized.action,
    method: VM_METHOD[normalized.action],
    sender,
    hash: digest,   // hash ที่ผู้ใช้เซ็น — ค้นใน explorer ได้เช่นกัน (ดู sigtx:<digest>)
    request: toVmRequest(normalized, sender, signature, digest),
  };
}
