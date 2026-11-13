/**
 * Verifies tx signatures before they go into the VM (runs on the server side, doesn't touch virtualmachine.js)
 *
 *   wallet side:  signTransaction(tx, privateKey)           → signature
 *   server side:  verifyTransaction({ tx, signature })       → { action, request, sender, hash }
 *                 vm[action](request)
 *
 * Signature format: EIP-712 over secp256k1, the same as EVM-family wallets
 *   - users see fields (action / from / to / method / value / nonce), not a bare hash
 *   - context.sender passed into the VM always comes from the signature, never from what the user typed
 *   - origin = sender always for user txs (forwarding origin is runProgram's job)
 *   - can be signed from a wallet on any EVM chain (no need to add this chain): the domain has no chainId (MetaMask requires the domain's chainId
 *     to match the active chain) · this chain's chainId is in the message instead → the node checks it matches its own chain (mempool) = prevents cross-chain replay
 *     an EIP-712 message signature is not an EVM tx → it can't be submitted on another chain
 *   - signedOnChainId = the chain the wallet was on when signing (the web page fills it from eth_chainId · it's in the signature but is not proof) → shown in the explorer for reference
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, normalizeAddress, normalizeHexDeep } from "../core/encoding.js";

export const DOMAIN_NAME = "Bluewolfchain";
export const DOMAIN_VERSION = "2";
/** the domain has no chainId (signable from any chain) · chainId is in the message */
export const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
];

/** signed fields (order matters, do not reorder) · signedOnChainId is appended for every type (before sponsor) */
const SIGNED_ON_FIELD = { name: "signedOnChainId", type: "uint256" };
const BASE_FIELDS = [
  { name: "chainId", type: "uint256" },
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
export const TRANSACTION_TYPE = [...BASE_FIELDS, SIGNED_ON_FIELD];

/**
 * EIP-1559 tx (has maxFeePerGas or maxPriorityFeePerGas): these two fields replace gasPrice
 * the type name is still "Transaction" but the fields differ → digests don't collide with the legacy form · legacy txs sign / verify byte-for-byte as before
 */
export const TRANSACTION_TYPE_1559 = [
  ...BASE_FIELDS.filter((field) => field.name !== "gasPrice"),
  { name: "maxFeePerGas", type: "uint256" },
  { name: "maxPriorityFeePerGas", type: "uint256" },
  SIGNED_ON_FIELD,
];

/**
 * tx with a gas sponsor (paymaster / fee payer): the sponsor field is appended to the end of the original type (legacy or 1559)
 * the sender signs including sponsor → the payer can't be swapped · the sponsor signs the same digest (sponsorSignature) = agrees to pay this tx's gas
 * no sponsor = the field isn't in the type → the original tx digest is unchanged
 */
export const SPONSOR_FIELD = { name: "sponsor", type: "address" };
export const isSponsoredTx = (tx = {}) => tx.sponsor !== undefined && tx.sponsor !== null && tx.sponsor !== "";

/** Transaction type for the shape of the tx */
export const transactionTypeOf = (tx = {}) => [...(isFeeMarketTx(tx) ? TRANSACTION_TYPE_1559 : TRANSACTION_TYPE), ...(isSponsoredTx(tx) ? [SPONSOR_FIELD] : [])];

/** does this tx use EIP-1559 gas pricing? */
export const isFeeMarketTx = (tx = {}) => (tx.maxFeePerGas ?? null) !== null || (tx.maxPriorityFeePerGas ?? null) !== null;

const ACTIONS = new Set(["call", "deploy", "transfer", "metadata", "init", "reject",
  "upgrade", "setUpgrader", "initUpgrade", "rejectUpgrade", "setGasConfig"]);
const HASH_LENGTH = 32;
const SIGNATURE_LENGTH = 65;

const fail = (message) => {
  throw new Error(message);
};

const keccak = (bytes) => keccak_256(bytes);
const keccakHex = (bytes) => `0x${bytesToHex(keccak(bytes))}`;
const encodeString = (text) => keccak(utf8ToBytes(text));

/** numbers in a tx: number (safe integer), BigInt or decimal string ("123" / "123n") — native amounts above 2^53 are sent as strings */
export function parseUint(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+n?$/.test(value)) return BigInt(value.replace(/n$/, ""));
  return null;
}

const encodeUint = (value) => {
  const parsed = parseUint(value);
  if (parsed === null || parsed < 0n || parsed >= 2n ** 256n) fail("numbers in a tx must be non-negative integers");
  const bytes = new Uint8Array(32);
  let rest = parsed;
  for (let i = 31; i >= 0 && rest > 0n; i -= 1) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
};

const encodeAddress = (address) => {
  const hex = String(address).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,40}$/.test(hex)) fail(`invalid address: ${address}`);
  const bytes = new Uint8Array(32);
  bytes.set(hexToBytes(hex.padStart(40, "0")), 12);
  return bytes;
};

/** the signed data: fills in values not provided and normalizes addresses to lowercase */
export function normalizeTransaction(tx = {}) {
  const action = tx.action ?? "call";
  if (!ACTIONS.has(action)) fail(`invalid action: ${action}`);

  const chainId = tx.chainId ?? 1;
  if (parseUint(chainId) === null) fail("chainId must be a non-negative integer");
  const signedOnChainId = tx.signedOnChainId ?? chainId;   // omitted = signed on this chain (scripts / SDK)
  if (parseUint(signedOnChainId) === null) fail("signedOnChainId must be a non-negative integer");
  return {
    chainId: Number(parseUint(chainId)),
    signedOnChainId: Number(parseUint(signedOnChainId)),
    action,
    from: normalizeAddress(tx.from ?? ""),
    to: normalizeAddress(tx.to ?? ""),
    method: tx.method ?? "",
    input: normalizeHexDeep(tx.input ?? {}),
    code: tx.code ?? null,
    // deploy: who may upgrade (omitted = the program is immutable) — when omitted the signed data is byte-for-byte as before
    ...(tx.upgrader === undefined || tx.upgrader === null || tx.upgrader === "" ? {} : { upgrader: normalizeAddress(tx.upgrader) }),
    value: tx.value ?? 0,
    nonce: tx.nonce ?? 0,
    gasLimit: tx.gasLimit ?? 0,
    ...feeOf(tx),
    ...(isSponsoredTx(tx) ? { sponsor: normalizeAddress(tx.sponsor) } : {}),
  };
}

/** tx gas pricing: legacy { gasPrice } (0 = system price) · EIP-1559 { maxFeePerGas (0 = baseFee + priority), maxPriorityFeePerGas } */
function feeOf(tx) {
  if (!isFeeMarketTx(tx)) return { gasPrice: tx.gasPrice ?? 0 };   // 0 = pay the block's base fee
  if (parseUint(tx.gasPrice ?? 0)) fail("gasPrice cannot be combined with maxFeePerGas / maxPriorityFeePerGas");
  return { maxFeePerGas: tx.maxFeePerGas ?? 0, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0 };
}

/** the EIP-712 structure the wallet shows the user before signing */
export function buildTypedData(rawTx) {
  const tx = normalizeTransaction(rawTx);
  return {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION },
    types: {
      EIP712Domain: DOMAIN_TYPE,
      Transaction: transactionTypeOf(tx),
    },
    primaryType: "Transaction",
    message: {
      chainId: tx.chainId,
      action: tx.action,
      from: tx.from,
      to: tx.to,
      method: tx.method,
      // input + code are combined into one canonical string so any data type can be signed
      input: canonicalJson({ input: tx.input, code: tx.code, upgrader: tx.upgrader }),   // missing upgrader = dropped
      value: tx.value,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      ...(isFeeMarketTx(tx) ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : { gasPrice: tx.gasPrice }),
      signedOnChainId: tx.signedOnChainId,
      ...(tx.sponsor ? { sponsor: tx.sponsor } : {}),
    },
  };
}

const typeHashOf = (name, fields) => encodeString(`${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`);

const encodeField = ({ type }, value) => {
  if (type === "string") return encodeString(value);
  if (type === "address") return encodeAddress(value);
  if (type === "uint256") return encodeUint(value);
  return fail(`unsupported type ${type}`);
};

/** the hash actually signed (EIP-712 digest) */
export function hashTypedData(rawTx) {
  const { domain, types, message } = buildTypedData(rawTx);

  const domainSeparator = keccak(concatBytes(
    typeHashOf("EIP712Domain", types.EIP712Domain),
    encodeString(domain.name),
    encodeString(domain.version),
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
  if (length && bytes.length !== length) fail(`${label} must be ${length} bytes`);
  return bytes;
};

const addressOfPublicKey = (publicKey) => {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false).slice(1); // drop the 0x04 prefix
  return `0x${bytesToHex(keccak(uncompressed)).slice(-40)}`;
};

export const addressOf = (privateKey) => addressOfPublicKey(secp256k1.getPublicKey(toBytes(privateKey, 32, "privateKey"), true));

// ---------- sign / recover ----------

/** sign a tx (normally the wallet's job — provided for tests and for building clients) */
export function signTransaction(tx, privateKey) {
  const digest = toBytes(hashTypedData(tx), HASH_LENGTH, "digest");
  const signed = secp256k1.sign(digest, toBytes(privateKey, 32, "privateKey"), { format: "recovered", prehash: false });
  const recovery = signed[0];
  return `0x${bytesToHex(signed.slice(1))}${(27 + recovery).toString(16).padStart(2, "0")}`; // r || s || v
}

/** the signer's address */
export function recoverSigner(tx, signature) {
  const bytes = toBytes(signature, SIGNATURE_LENGTH, "signature");
  const v = bytes[64];
  if (v !== 27 && v !== 28) fail("corrupt signature (v must be 27 or 28)");

  const digest = toBytes(hashTypedData(tx), HASH_LENGTH, "digest");
  const recovered = concatBytes(new Uint8Array([v - 27]), bytes.slice(0, 64));
  const publicKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  return addressOfPublicKey(publicKey);
}

// ---------- server side ----------

/** convert a signed tx into a VM request (sender / origin come from the signature only) */
export function toVmRequest(tx, sender, signature, digest, sponsorSignature) {
  const context = { sender, origin: sender };
  const given = (value) => (parseUint(value) ? value : undefined);   // 0 / "0" = not specified (use the system value)
  // EIP-1559: maxFeePerGas 0 = not specified (VM uses baseFee + priority) · maxPriorityFeePerGas 0 = no tip (always specified = a 1559 tx)
  const fees = isFeeMarketTx(tx)
    ? { maxFeePerGas: given(tx.maxFeePerGas), maxPriorityFeePerGas: String(parseUint(tx.maxPriorityFeePerGas ?? 0) ?? 0n) }
    : { gasPrice: given(tx.gasPrice) };
  const common = { context, signedOnChainId: tx.signedOnChainId, nonce: tx.nonce, gasLimit: given(tx.gasLimit) === undefined ? undefined : Number(parseUint(tx.gasLimit)), ...fees, signature, digest,
    ...(tx.sponsor ? { sponsor: tx.sponsor, sponsorSignature } : {}) };   // gas sponsor (none = the request is byte-for-byte as before)

  if (tx.action === "transfer") return { from: sender, to: tx.to, amount: tx.value, ...common, context: undefined };
  if (tx.action === "metadata") return { metadata: tx.input, ...common };
  if (tx.action === "init" || tx.action === "reject") return { programUuid: tx.to, ...common };
  if (tx.action === "deploy") return { programUuid: tx.to || undefined, code: tx.code, initInput: tx.input, value: tx.value, ...(tx.upgrader ? { upgrader: tx.upgrader } : {}), ...common };
  // upgrade: to = program · code = new code · input = migrateInput
  if (tx.action === "upgrade") return { programUuid: tx.to, code: tx.code, migrateInput: tx.input, ...common };
  // transfer the upgrade right: input = { upgrader: "0x…" } or { upgrader: null } = renounce
  if (tx.action === "setUpgrader") return { programUuid: tx.to, upgrader: tx.input?.upgrader ?? null, ...common };
  if (tx.action === "initUpgrade" || tx.action === "rejectUpgrade") return { programUuid: tx.to, ...common };
  // admin adjusts the minimum gas price: input = { minBaseFee: "wei" | null } (no to)
  if (tx.action === "setGasConfig") {
    return { ...(tx.input && Object.hasOwn(tx.input, "minBaseFee") ? { minBaseFee: tx.input.minBaseFee } : {}),
      ...(tx.input && Object.hasOwn(tx.input, "gas") ? { gas: tx.input.gas } : {}), ...common };   // gas → the VM rejects it with a reason
  }
  return { programUuid: tx.to, functionName: tx.method, input: tx.input, value: tx.value, ...common };
}

/** VM method name used for each action */
export const VM_METHOD = { call: "call", deploy: "deploy", transfer: "transfer", metadata: "setMetadata", init: "init", reject: "reject",
  upgrade: "upgrade", setUpgrader: "setUpgrader", initUpgrade: "initUpgrade", rejectUpgrade: "rejectUpgrade", setGasConfig: "setGasConfig" };

/**
 * Verify the signature and return a request ready for the VM
 * a tx with a sponsor must have sponsorSignature = the sponsor's signature over the same digest (sponsor pays gas · the sender uses its own nonce + pays value)
 * @returns {{ action: string, method: string, sender: string, request: object, hash: string, sponsor?: string }}
 */
export function verifyTransaction({ tx, signature, sponsorSignature } = {}) {
  const normalized = normalizeTransaction(tx);
  const sender = recoverSigner(normalized, signature);
  if (normalized.from && sender !== normalized.from) fail(`signature does not match from: signed by ${sender}`);
  if (normalized.sponsor) {
    if (normalized.sponsor === sender) fail("sponsor must not be the sender");
    if (sponsorSignature === undefined || sponsorSignature === null) fail("a tx with a sponsor needs a sponsorSignature");
    const sponsor = recoverSigner(normalized, sponsorSignature);
    if (sponsor !== normalized.sponsor) fail(`sponsorSignature does not match sponsor: signed by ${sponsor}`);
  } else if (sponsorSignature !== undefined && sponsorSignature !== null) {
    fail("sponsorSignature given but the tx has no sponsor");
  }

  const digest = hashTypedData(normalized);
  return {
    action: normalized.action,
    method: VM_METHOD[normalized.action],
    chainId: normalized.chainId,   // mempool checks it matches this chain (prevents cross-chain replay)
    sender,
    hash: digest,   // the hash the user signed — also searchable in the explorer (see sigtx:<digest>)
    request: toVmRequest(normalized, sender, signature, digest, sponsorSignature),
    ...(normalized.sponsor ? { sponsor: normalized.sponsor } : {}),
  };
}
