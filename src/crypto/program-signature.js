/**
 * ลายเซ็นที่ "โปรแกรม" ตรวจด้วย ecrecover (ไม่ใช่ลายเซ็นของ tx — นั่นอยู่ใน signature.js)
 *
 *   ในโปรแกรม:  ecrecover(ข้อความ, signature) → address ผู้เซ็น
 *               ข้อความ = string หรือ object (object → canonical JSON: เรียง key, bigint เป็น "123n")
 *               digest  = keccak256(UTF-8 ของข้อความนั้น) · signature = r || s || v (65 byte, v = 27 / 28)
 *   ฝั่ง wallet / เทสต์: signProgramMessage(ข้อความ, privateKey) ได้ลายเซ็นที่ ecrecover ข้างบนกู้ได้ตรง
 *
 * permit ของ TOKEN_PROGRAM = ERC-2612 + EIP-712 จริง (ตรงกับ MetaMask eth_signTypedData_v4 / ethers Wallet.signTypedData ทุกไบต์)
 *   const typed = permitTypedData({ name, chainId, verifyingContract, owner, spender, value, nonce, deadline })
 *                 // → { domain, types: { EIP712Domain, Permit }, primaryType: "Permit", message } ส่งให้ eth_signTypedData_v4 ได้เลย
 *   const signature = signPermit({ ... }, ownerKey)            // owner เป็นกระเป๋าคน หรือเจ้าของกระเป๋าโปรแกรม (owner = กระเป๋า)
 *   const signature = signWalletHash(permitDigest({ ... }), walletOwnerKey)   // เท่ากับบรรทัดบน (เซ็น digest ตรง ๆ)
 *   vm.call({ programUuid: token, functionName: "permit", input: { owner, spender, value, deadline, signature } })
 *   deadline = unix **วินาที** (EIP-2612) · nonce = nonces({ owner })
 *
 * ตัวช่วยทั่วไป: signTypedDataDigest(digest, key) เซ็น digest 32 byte (ที่ ecrecoverDigest ในโปรแกรมกู้ได้)
 *               typedDataDigest(domain, types, primaryType, message) = eip712Digest แบบเดียวกับในโปรแกรม
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, keccak256Hex, normalizeHex, normalizeHexDeep } from "../core/virtualmachine.js";
import { PERMIT_TYPES, PERMIT_VERSION } from "../standards/token.js";
import { DOMAIN_FIELDS, eip712Digest, eip712DomainSeparator, recoverAddress } from "./eip712.js";

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

/** เซ็น digest 32 byte ("0x…") ตรง ๆ ไม่มี prefix → "0x" + r + s + v (v = 27 / 28) — ecrecoverDigest ในโปรแกรมกู้ได้ */
export function signTypedDataDigest(digest, privateKey) {
  const bytes = hexToBytes(String(digest).replace(/^0x/, ""));
  if (bytes.length !== 32) fail("digest ต้องยาว 32 byte");
  const signed = secp256k1.sign(bytes, keyBytes(privateKey), { format: "recovered", prehash: false });
  return `0x${bytesToHex(signed.slice(1))}${(27 + signed[0]).toString(16).padStart(2, "0")}`;
}

/** กู้ address จาก digest 32 byte + ลายเซ็น (แบบ ecrecoverDigest ในโปรแกรม) · ใช้ไม่ได้ → null */
export const recoverTypedDataDigest = (digest, signature) => recoverAddress(String(digest), signature);

/** digest แบบ eth_signTypedData_v4 (ค่าเดียวกับ eip712Digest ในโปรแกรม) */
export const typedDataDigest = (domain, types, primaryType, message) => eip712Digest(domain, types, primaryType, message);

/** เซ็นข้อความให้ ecrecover(ข้อความ, signature) ในโปรแกรมกู้ address ของ privateKey ได้ → "0x" + r + s + v */
export function signProgramMessage(value, privateKey) {
  return signTypedDataDigest(programMessageHash(value), privateKey);
}

/** กู้ address จากข้อความ + ลายเซ็น (ทำแบบเดียวกับ ecrecover ในโปรแกรม) · ใช้ไม่ได้ → null */
export const recoverProgramMessage = (value, signature) => recoverAddress(programMessageHash(value), signature);

// ---------- permit (TOKEN_PROGRAM · ERC-2612) ----------

/**
 * typed data ของ permit ที่ TOKEN_PROGRAM ตรวจ — ส่งให้ eth_signTypedData_v4 ได้ทั้งก้อน (JSON.stringify ได้: ตัวเลขเป็น string ทศนิยม)
 * name = ชื่อ token (name()) · chainId = ChainId() ของเชน · verifyingContract = address ของ token
 * nonce = nonces({ owner }) ปัจจุบัน · deadline = unix วินาที (เทียบกับเวลาของ block ÷ 1000)
 */
export function permitTypedData({ name, version = PERMIT_VERSION, chainId, verifyingContract, owner, spender, value, nonce, deadline }) {
  if (typeof name !== "string") fail("name (ชื่อ token) ต้องเป็น string");
  for (const [label, address] of [["verifyingContract", verifyingContract], ["owner", owner], ["spender", spender]]) {
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) fail(`${label} ต้องเป็น address`);
  }
  return {
    types: { EIP712Domain: DOMAIN_FIELDS.slice(0, 4), Permit: PERMIT_TYPES.Permit },
    primaryType: "Permit",
    domain: { name, version, chainId: String(big(chainId, "chainId")), verifyingContract: normalizeHex(verifyingContract) },
    message: {
      owner: normalizeHex(owner), spender: normalizeHex(spender),
      value: String(big(value, "value")), nonce: String(big(nonce, "nonce")), deadline: String(big(deadline, "deadline")),
    },
  };
}

/** domainSeparator ของ token (= DOMAIN_SEPARATOR() ในโปรแกรม) */
export function permitDomainSeparator(fields) {
  const { domain } = permitTypedData({ owner: fields.verifyingContract, spender: fields.verifyingContract, value: 0, nonce: 0, deadline: 0, ...fields });
  return eip712DomainSeparator(domain);
}

/** digest ของ permit = ค่าที่ ethers TypedDataEncoder.hash / MetaMask เซ็น (และที่ token ส่งให้ isValidSignature ของกระเป๋าโปรแกรม) */
export function permitDigest(fields) {
  const typed = permitTypedData(fields);
  return eip712Digest(typed.domain, typed.types, typed.primaryType, typed.message);
}

/** เซ็น permit ด้วย key (= ลายเซ็นของ eth_signTypedData_v4 / ethers signTypedData) · owner เป็นกระเป๋าคน หรือกระเป๋าโปรแกรมที่ key เป็นเจ้าของ */
export const signPermit = (fields, privateKey) => signTypedDataDigest(permitDigest(fields), privateKey);

/** เจ้าของ WALLET_PROGRAM เซ็น digest 32 byte ตรง ๆ (ERC-1271: isValidSignature({ hash, signature }) → ecrecoverDigest) */
export const signWalletHash = (hash, privateKey) => signTypedDataDigest(String(hash).toLowerCase(), privateKey);
