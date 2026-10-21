/**
 * ลายเซ็นที่ "โปรแกรม" ตรวจด้วย ecrecover (ไม่ใช่ลายเซ็นของ tx — นั่นอยู่ใน signature.js)
 *
 *   ในโปรแกรม:  ecrecover(ข้อความ, signature) → address ผู้เซ็น
 *               ข้อความ = string หรือ object (object → canonical JSON: เรียง key, bigint เป็น "123n")
 *               digest  = keccak256(UTF-8 ของข้อความนั้น) · signature = r || s || v (65 byte, v = 27 / 28)
 *   ฝั่ง wallet / เทสต์: signProgramMessage(ข้อความ, privateKey) ได้ลายเซ็นที่ ecrecover ข้างบนกู้ได้ตรง
 *
 * permit ของ TOKEN_PROGRAM (คล้าย ERC-2612 + ข้อความแบบ EIP-712 แต่ hash เป็น JSON แทน ABI เพราะ keccak256 ในโปรแกรมรับข้อความ)
 *   const typed = permitTypedData({ name, chainId, verifyingContract, owner, spender, value, nonce, deadline })
 *   const signature = signPermit({ ... }, ownerKey)            // owner เป็นกระเป๋าคน
 *   const signature = signWalletHash(permitDigest({ ... }), walletOwnerKey)   // owner เป็นกระเป๋าโปรแกรม (ERC-1271)
 *   vm.call({ programUuid: token, functionName: "permit", input: { owner, spender, value, deadline, signature } })
 *
 * MetaMask ใช้ eth_signTypedData_v4 กับข้อความนี้ไม่ได้ (คนละวิธี hash) → wallet ต้องเซ็น digest ตรง ๆ (แบบ eth_sign ไม่มี prefix)
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, keccak256Hex, normalizeHexDeep } from "../core/virtualmachine.js";
import { PERMIT_TYPE, PERMIT_VERSION } from "../standards/token.js";

const fail = (message) => { throw new Error(message); };

/** ตัวเลขฝั่ง JS (number / bigint / "123" / "123n") → bigint แบบที่โปรแกรมเห็น */
const big = (value, label) => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+n?$/.test(value)) return BigInt(value.replace(/n$/, ""));
  return fail(`${label} ต้องเป็นจำนวนเต็ม`);
};

/** ข้อความ → text ที่ ecrecover / keccak256 ในโปรแกรม hash (hex ใน input ถูกทำเป็นตัวพิมพ์เล็กเหมือน VM) */
export function programMessageText(value) {
  if (typeof value === "string") return value;
  return canonicalJson(normalizeHexDeep(value));
}

/** digest ที่ถูกเซ็นจริง = keccak256(text) — เท่ากับ keccak256(ข้อความ) ในโปรแกรม */
export const programMessageHash = (value) => keccak256Hex(programMessageText(value));

const keyBytes = (privateKey) => {
  const bytes = hexToBytes(String(privateKey).replace(/^0x/, ""));
  if (bytes.length !== 32) fail("privateKey ต้องยาว 32 byte");
  return bytes;
};

/** เซ็นข้อความให้ ecrecover(ข้อความ, signature) ในโปรแกรมกู้ address ของ privateKey ได้ → "0x" + r + s + v */
export function signProgramMessage(value, privateKey) {
  const digest = hexToBytes(programMessageHash(value).slice(2));
  const signed = secp256k1.sign(digest, keyBytes(privateKey), { format: "recovered", prehash: false });
  return `0x${bytesToHex(signed.slice(1))}${(27 + signed[0]).toString(16).padStart(2, "0")}`;
}

/** กู้ address จากข้อความ + ลายเซ็น (ทำแบบเดียวกับ ecrecover ในโปรแกรม) · ใช้ไม่ได้ → null */
export function recoverProgramMessage(value, signature) {
  try {
    const bytes = hexToBytes(String(signature).replace(/^0x/, ""));
    if (bytes.length !== 65 || (bytes[64] !== 27 && bytes[64] !== 28)) return null;
    const digest = hexToBytes(programMessageHash(value).slice(2));
    const publicKey = secp256k1.recoverPublicKey(new Uint8Array([bytes[64] - 27, ...bytes.slice(0, 64)]), digest, { prehash: false });
    return `0x${bytesToHex(keccak_256(secp256k1.Point.fromBytes(publicKey).toBytes(false).slice(1))).slice(-40)}`;
  } catch {
    return null;
  }
}

// ---------- permit (TOKEN_PROGRAM) ----------

/**
 * ข้อความ permit ที่ TOKEN_PROGRAM สร้างแล้วตรวจ (ต้องตรงทุกฟิลด์)
 * name = ชื่อ token (name()) · chainId = ChainId() ของเชน · verifyingContract = address ของ token
 * nonce = nonces({ owner }) ปัจจุบัน · deadline = มิลลิวินาที (เทียบกับ params.block.timestamp)
 */
export function permitTypedData({ name, version = PERMIT_VERSION, chainId, verifyingContract, owner, spender, value, nonce, deadline }) {
  if (typeof name !== "string") fail("name (ชื่อ token) ต้องเป็น string");
  for (const [label, address] of [["verifyingContract", verifyingContract], ["owner", owner], ["spender", spender]]) {
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) fail(`${label} ต้องเป็น address`);
  }
  return {
    domain: { name, version, chainId: big(chainId, "chainId"), verifyingContract: verifyingContract.toLowerCase() },
    primaryType: "Permit",
    types: PERMIT_TYPE,
    message: { owner: owner.toLowerCase(), spender: spender.toLowerCase(), value: big(value, "value"), nonce: big(nonce, "nonce"), deadline: big(deadline, "deadline") },
  };
}

/** digest ของ permit (ค่า hash ที่ token ส่งให้ isValidSignature ของกระเป๋าโปรแกรม) */
export const permitDigest = (fields) => programMessageHash(permitTypedData(fields));

/** owner เป็นกระเป๋าคน: เซ็นข้อความ permit ด้วย key ของ owner */
export const signPermit = (fields, privateKey) => signProgramMessage(permitTypedData(fields), privateKey);

/** owner เป็นกระเป๋าโปรแกรม (WALLET_PROGRAM): เจ้าของกระเป๋าเซ็น hash (string) นั้นเป็นข้อความ */
export const signWalletHash = (hash, privateKey) => signProgramMessage(String(hash).toLowerCase(), privateKey);
