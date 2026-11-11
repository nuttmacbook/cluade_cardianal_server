/**
 * metadata.abi ของโปรแกรมแถม (multicall / wcard / multisig / factory / multisender) — ดู src/standards/system-abi.js
 * ชนิด: object / array / any = string ที่เป็น JSON (BigInt ข้างใน JSON เขียนเป็น "123n")
 */

const f = (name, type) => ({ name, type });
const ro = (name, inputs, outputs, description) => ({ name, inputs, outputs, readonly: true, ...(description ? { description } : {}) });
const tx = (name, inputs, outputs, description) => ({ name, inputs, ...(outputs ? { outputs } : {}), ...(description ? { description } : {}) });
const pay = (name, inputs, outputs, description) => ({ ...tx(name, inputs, outputs, description), payable: true });
const out = (type) => [{ type }];
const ev = (name, fields, indexed = [], description) => ({
  name, fields: fields.map(([n, type]) => ({ name: n, type, ...(indexed.includes(n) ? { indexed: true } : {}) })), ...(description ? { description } : {}),
});

// ---------- multicall ----------
export const MULTICALL_ABI = {
  functions: [
    tx("aggregate", [f("calls", "array"), f("readonly", "bool")], out("array"),
      "calls = JSON [{ target, fn, input? }]. Any failure reverts all. readonly=true runs every call as static call."),
    tx("tryAggregate", [f("calls", "array"), f("readonly", "bool"), f("requireSuccess", "bool")], out("array"),
      "Like aggregate but returns [{ success, result } | { success: false, error, code }]; requireSuccess=true reverts on any failure."),
    ro("getBlockNumber", [], out("uint")),
    ro("getChainId", [], out("uint")),
    ro("getNativeBalance", [f("who", "address")], out("uint")),
  ],
  events: [],
};

// ---------- WCARD (token core + wrap) ----------
const TOKEN_CORE_FUNCTIONS = [
  ro("name", [], out("string")),
  ro("ticker", [], out("string")),
  ro("decimals", [], out("uint")),
  ro("totalSupply", [], out("uint")),
  ro("balanceOf", [f("who", "address")], out("uint")),
  ro("allowance", [f("owner", "address"), f("spender", "address")], out("uint")),
  tx("transfer", [f("to", "address"), f("amount", "uint")], out("bool")),
  tx("multiTransfer", [f("transfers", "array")], out("uint"), "transfers = JSON [{ to, amount }]; returns the number of transfers."),
  tx("approve", [f("spender", "address"), f("amount", "uint")], out("bool")),
  tx("transferFrom", [f("from", "address"), f("to", "address"), f("amount", "uint")], out("bool")),
  tx("permit", [f("owner", "address"), f("spender", "address"), f("value", "uint"), f("deadline", "uint"), f("signature", "bytes")], out("bool"),
    "ERC-2612 permit (EIP-712 signature by owner). deadline in unix seconds."),
  ro("nonces", [f("owner", "address")], out("uint")),
  ro("permitDomain", [], out("object"), "EIP-712 domain { name, version, chainId, verifyingContract }."),
  ro("DOMAIN_SEPARATOR", [], out("bytes"), "EIP-712 domain separator (32 bytes)."),
];
const TOKEN_EVENTS = [
  ev("Transfer", [["from", "address"], ["to", "address"], ["amount", "uint"]], ["from", "to"]),
  ev("Approval", [["owner", "address"], ["spender", "address"], ["amount", "uint"]], ["owner", "spender"]),
];

export const WCARD_ABI = {
  functions: [
    ...TOKEN_CORE_FUNCTIONS,
    pay("deposit", [], out("uint"), "Wrap the attached native value 1:1; returns the amount."),
    pay("depositTo", [f("to", "address")], out("uint"), "Wrap the attached native value for 'to'."),
    tx("withdraw", [f("amount", "uint")], out("bool"), "Burn wrapped tokens and receive native coin."),
    tx("withdrawTo", [f("to", "address"), f("amount", "uint")], out("bool"), "Burn wrapped tokens and send native coin to 'to'."),
  ],
  events: [
    ...TOKEN_EVENTS,
    ev("Deposit", [["to", "address"], ["amount", "uint"]], ["to"]),
    ev("Withdrawal", [["from", "address"], ["to", "address"], ["amount", "uint"]], ["from", "to"]),
  ],
};

// ---------- multisig ----------
const SELF_ONLY = "Only callable by the multisig itself (submit a transaction targeting this multisig).";
export const MULTISIG_ABI = {
  functions: [
    ro("owners", [], out("array"), "JSON array of owner addresses."),
    ro("threshold", [], out("uint")),
    ro("isOwner", [f("who", "address")], out("bool")),
    ro("transactionCount", [], out("uint")),
    ro("getTransaction", [f("id", "uint")], out("object"), "{ target, fn, input, value, executed, submitter, confirmations }."),
    ro("isConfirmed", [f("id", "uint"), f("owner", "address")], out("bool")),
    tx("submit", [f("target", "address"), f("fn", "string"), f("input", "object"), f("value", "uint")], out("uint"),
      "Owner proposes a call (auto-confirms). fn empty = send native value to target. input = JSON object. Returns id."),
    tx("confirm", [f("id", "uint")], out("bool")),
    tx("revoke", [f("id", "uint")], out("bool")),
    tx("execute", [f("id", "uint")], out("any"), "Run a confirmed transaction; returns the target's result (true for a native transfer)."),
    tx("addOwner", [f("owner", "address"), f("threshold", "uint")], out("bool"), `${SELF_ONLY} threshold must be 1..owners (no keep-current default over EVM).`),
    tx("removeOwner", [f("owner", "address"), f("threshold", "uint")], out("bool"), `${SELF_ONLY} threshold must be 1..owners (no auto-clamp over EVM).`),
    tx("changeThreshold", [f("threshold", "uint")], out("bool"), SELF_ONLY),
    tx("approveHash", [f("hash", "bytes")], out("bool"), `${SELF_ONLY} hash = 32-byte digest; makes isValidSignature accept it (ERC-1271).`),
    ro("isValidSignature", [f("hash", "bytes")], out("bytes"), "ERC-1271: returns 0x1626ba7e if the hash was approved."),
    pay("deposit", [], out("uint"), "Receive native coin (attach value)."),
    ro("onERC721Received", [], out("bytes")),
    ro("onERC1155Received", [], out("bytes")),
    ro("onERC1155BatchReceived", [], out("bytes")),
  ],
  events: [
    ev("ThresholdChanged", [["threshold", "uint"]]),
    ev("Confirmed", [["id", "uint"], ["owner", "address"]], ["id", "owner"]),
    ev("Submitted", [["id", "uint"], ["submitter", "address"], ["target", "address"], ["fn", "string"], ["value", "uint"]], ["id", "submitter", "target"]),
    ev("Revoked", [["id", "uint"], ["owner", "address"]], ["id", "owner"]),
    ev("Executed", [["id", "uint"], ["executor", "address"]], ["id", "executor"]),
    ev("OwnerAdded", [["owner", "address"]], ["owner"]),
    ev("OwnerRemoved", [["owner", "address"]], ["owner"]),
    ev("HashApproved", [["hash", "string"]]),
    ev("Deposit", [["from", "address"], ["amount", "uint"]], ["from"]),
  ],
};

// ---------- factory ----------
const META_INPUTS = ["namespace", "icon", "url", "contact", "description"].map((name) => f(name, "string"));
const SALT = f("salt", "string");
const EMPTY = "Empty strings = not given (salt empty = auto).";
export const FACTORY_ABI = {
  functions: [
    tx("createToken", [f("name", "string"), f("ticker", "string"), f("decimals", "uint"), f("supply", "uint"), SALT, ...META_INPUTS], out("address"),
      `Clone a token; the caller gets the whole supply. ${EMPTY}`),
    tx("createNft", [f("name", "string"), f("symbol", "string"), f("baseURI", "string"), SALT, ...META_INPUTS], out("address"),
      `Clone an NFT collection owned by the caller. ${EMPTY}`),
    tx("createMultiToken", [f("name", "string"), f("symbol", "string"), f("uri", "string"), SALT, ...META_INPUTS], out("address"),
      `Clone a multi-token owned by the caller. ${EMPTY}`),
    tx("createMultisig", [f("owners", "array"), f("threshold", "uint"), SALT, ...META_INPUTS], out("address"),
      `Clone a multisig. owners = JSON array of addresses. ${EMPTY}`),
    ro("templates", [], out("object"), "{ token, nft, multiToken, multisig } template addresses."),
    ro("count", [], out("uint")),
    ro("created", [f("index", "uint")], out("object"), "{ kind, address, creator }."),
    ro("createdCount", [f("creator", "address")], out("uint")),
    ro("createdBy", [f("creator", "address"), f("index", "uint")], out("address")),
    ro("kindOf", [f("address", "address")], out("string"), "token / nft / multiToken / multisig, or empty if not created here."),
  ],
  events: [
    ev("Created", [["kind", "string"], ["address", "address"], ["creator", "address"]], ["address", "creator"]),
  ],
};

// ---------- multisender ----------
const SENT = [{ name: "count", type: "uint" }, { name: "total", type: "uint" }];
export const MULTISENDER_ABI = {
  functions: [
    pay("sendNative", [f("transfers", "array")], SENT, "transfers = JSON [{ to, amount }]; attach value = exact sum."),
    tx("sendToken", [f("token", "address"), f("transfers", "array")], SENT, "transfers = JSON [{ to, amount }]; approve the multisender first."),
    tx("sendTokens", [f("transfers", "array")], SENT, "transfers = JSON [{ token, to, amount }]; approve each token first."),
    tx("sendNft", [f("nft", "address"), f("transfers", "array"), f("safe", "bool"), f("data", "string")], SENT,
      "transfers = JSON [{ to, tokenId }]. safe=false uses transferFrom (pass true for the default safe transfer)."),
    tx("sendMultiToken", [f("multiToken", "address"), f("transfers", "array"), f("data", "string")], SENT,
      "transfers = JSON [{ to, id, amount }]; setApprovalForAll(multisender) first."),
  ],
  events: [
    ev("Sent", [["kind", "string"], ["asset", "address"], ["sender", "address"], ["count", "uint"], ["total", "uint"]], ["kind", "asset", "sender"]),
  ],
};
