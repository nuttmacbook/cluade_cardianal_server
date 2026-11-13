/**
 * Signatures that a "program" verifies with ecrecover (not tx signatures — those are in signature.js)
 *
 *   in a program:  ecrecover(message, signature) → signer address
 *               message = string or object (object → canonical JSON: sorted keys, bigint as "123n")
 *               digest  = keccak256(UTF-8 of that message) · signature = r || s || v (65 bytes, v = 27 / 28)
 *   wallet / test side: signProgramMessage(message, privateKey) gives a signature the ecrecover above recovers exactly
 *
 * TOKEN_PROGRAM's permit = real ERC-2612 + EIP-712 (byte-for-byte identical to MetaMask eth_signTypedData_v4 / ethers Wallet.signTypedData)
 *   const typed = permitTypedData({ name, chainId, verifyingContract, owner, spender, value, nonce, deadline })
 *                 // → { domain, types: { EIP712Domain, Permit }, primaryType: "Permit", message } can be passed straight to eth_signTypedData_v4
 *   const signature = signPermit({ ... }, ownerKey)            // owner is a personal wallet, or the owner of a program wallet (owner = the wallet)
 *   const signature = signWalletHash(permitDigest({ ... }), walletOwnerKey)   // same as the line above (signs the digest directly)
 *   vm.call({ programUuid: token, functionName: "permit", input: { owner, spender, value, deadline, signature } })
 *   deadline = unix **seconds** (EIP-2612) · nonce = nonces({ owner })
 *
 * General helpers: signTypedDataDigest(digest, key) signs a 32-byte digest (recoverable by ecrecoverDigest in a program)
 *               typedDataDigest(domain, types, primaryType, message) = eip712Digest, same as in a program
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, keccak256Hex, normalizeHex, normalizeHexDeep } from "../core/encoding.js";
import { PERMIT_TYPES, PERMIT_VERSION } from "../standards/token.js";
import { DOMAIN_FIELDS, eip712Digest, eip712DomainSeparator, recoverAddress } from "./eip712.js";

const fail = (message) => { throw new Error(message); };

/** JS-side number (number / bigint / "123" / "123n") → bigint as a program sees it */
const big = (value, label) => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+n?$/.test(value)) return BigInt(value.replace(/n$/, ""));
  return fail(`${label} must be an integer`);
};

/** message → the text that ecrecover / keccak256 in a program hash (hex in input is lowercased, like the VM) */
export function programMessageText(value) {
  if (typeof value === "string") return value;
  return canonicalJson(normalizeHexDeep(value));
}

/** the digest actually signed = keccak256(text) — equals keccak256(message) in a program */
export const programMessageHash = (value) => keccak256Hex(programMessageText(value));

const keyBytes = (privateKey) => {
  const bytes = hexToBytes(String(privateKey).replace(/^0x/, ""));
  if (bytes.length !== 32) fail("privateKey must be 32 bytes");
  return bytes;
};

/** sign a 32-byte digest ("0x…") directly, no prefix → "0x" + r + s + v (v = 27 / 28) — recoverable by ecrecoverDigest in a program */
export function signTypedDataDigest(digest, privateKey) {
  const bytes = hexToBytes(String(digest).replace(/^0x/, ""));
  if (bytes.length !== 32) fail("digest must be 32 bytes");
  const signed = secp256k1.sign(bytes, keyBytes(privateKey), { format: "recovered", prehash: false });
  return `0x${bytesToHex(signed.slice(1))}${(27 + signed[0]).toString(16).padStart(2, "0")}`;
}

/** recover the address from a 32-byte digest + signature (like ecrecoverDigest in a program) · invalid → null */
export const recoverTypedDataDigest = (digest, signature) => recoverAddress(String(digest), signature);

/** eth_signTypedData_v4-style digest (same value as eip712Digest in a program) */
export const typedDataDigest = (domain, types, primaryType, message) => eip712Digest(domain, types, primaryType, message);

/** sign a message so ecrecover(message, signature) in a program recovers the privateKey's address → "0x" + r + s + v */
export function signProgramMessage(value, privateKey) {
  return signTypedDataDigest(programMessageHash(value), privateKey);
}

/** recover the address from a message + signature (same as ecrecover in a program) · invalid → null */
export const recoverProgramMessage = (value, signature) => recoverAddress(programMessageHash(value), signature);

// ---------- permit (TOKEN_PROGRAM · ERC-2612) ----------

/**
 * permit typed data that TOKEN_PROGRAM verifies — pass the whole object to eth_signTypedData_v4 (JSON.stringify-safe: numbers are decimal strings)
 * name = the token's name (name()) · chainId = the chain's ChainId() · verifyingContract = the token's address
 * nonce = current nonces({ owner }) · deadline = unix seconds (compared with block time ÷ 1000)
 */
export function permitTypedData({ name, version = PERMIT_VERSION, chainId, verifyingContract, owner, spender, value, nonce, deadline }) {
  if (typeof name !== "string") fail("name (token name) must be a string");
  for (const [label, address] of [["verifyingContract", verifyingContract], ["owner", owner], ["spender", spender]]) {
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) fail(`${label} must be an address`);
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

/** the token's domainSeparator (= DOMAIN_SEPARATOR() in the program) */
export function permitDomainSeparator(fields) {
  const { domain } = permitTypedData({ owner: fields.verifyingContract, spender: fields.verifyingContract, value: 0, nonce: 0, deadline: 0, ...fields });
  return eip712DomainSeparator(domain);
}

/** permit digest = what ethers TypedDataEncoder.hash / MetaMask sign (and what the token passes to a program wallet's isValidSignature) */
export function permitDigest(fields) {
  const typed = permitTypedData(fields);
  return eip712Digest(typed.domain, typed.types, typed.primaryType, typed.message);
}

/** sign a permit with key (= the eth_signTypedData_v4 / ethers signTypedData signature) · owner is a personal wallet, or a program wallet that key owns */
export const signPermit = (fields, privateKey) => signTypedDataDigest(permitDigest(fields), privateKey);

/** the WALLET_PROGRAM owner signs a 32-byte digest directly (ERC-1271: isValidSignature({ hash, signature }) → ecrecoverDigest) */
export const signWalletHash = (hash, privateKey) => signTypedDataDigest(String(hash).toLowerCase(), privateKey);
