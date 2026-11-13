/**
 * Data conversion helpers that do not depend on the VM / sandbox (used by both the node and the client-side SDK; see client-sdk/index.js)
 * virtualmachine.js re-exports these same helpers (existing imports from there keep working)
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const HEX_PATTERN = /^0x[0-9a-f]+$/i;

export const keccak256Hex = (text) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;

/** wallet / program addresses are always lowercase */
export const normalizeAddress = (value) => (typeof value === "string" ? value.toLowerCase() : value);

/** 0x… hex strings → lowercase; other strings unchanged */
export const normalizeHex = (value) => (typeof value === "string" && HEX_PATTERN.test(value) ? value.toLowerCase() : value);

/** walks a whole object / array: values and key names that are 0x… hex → lowercase */
export function normalizeHexDeep(value) {
  if (Array.isArray(value)) return value.map(normalizeHexDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [normalizeHex(key), normalizeHexDeep(item)]));
  }
  return normalizeHex(value);
}

/**
 * Serialize data to a string identically on every machine (sorted keys, no whitespace)
 * Used for tx hashes, so it must not depend on the order in which the user supplied fields
 */
export function canonicalJson(value) {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  try {
    const json = JSON.stringify(value === undefined ? null : value);
    return json === undefined ? JSON.stringify(String(value)) : json; // function / symbol
  } catch {
    return JSON.stringify(String(value)); // bigint etc.: real values are already rejected during input validation
  }
}

/**
 * The data hashed into a block hash (from header fields); VM.hashHeader and client-sdk (verifying received headers) use the same one
 *   block hash = keccak256(canonicalJson(headerFields(header, chainId)))
 */
export function headerFields({ number, parentHash, timestamp, feeRecipient, burnPercent, txCount, txRoot, stateRoot, writesRoot,
  baseFeePerGas = null, gasUsed = 0, receiptsRoot = null, logsBloom = null, rejectedCount = 0, rejectedRoot = null, producer = null }, chainId) {
  return {
    chainId, number, parentHash: parentHash ?? null, timestamp,
    feeRecipient: feeRecipient ?? null, burnPercent, txCount, txRoot, stateRoot, writesRoot,
    // EIP-1559 + receipt: block base fee / gas used (used to compute the next block's base fee) / receipt root / log bloom
    baseFeePerGas, gasUsed, receiptsRoot, logsBloom,
    ...(rejectedRoot ? { rejectedCount, rejectedRoot } : {}),
    // producer: in the hash only for blocks that have one · the producer signature signs this hash, so it sits outside the hash
    ...(producer ? { producer } : {}),
  };
}
