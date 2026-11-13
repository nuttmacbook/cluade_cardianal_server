/**
 * Token standard (similar to ERC-20) — the explorer counts the coins each address holds from the Transfer events of programs that follow it
 *
 * Required functions (read-only)
 *   name()            → string               full name, e.g. "Thai Baht Coin"
 *   ticker()          → string               short name, e.g. "THBC"
 *   decimals()        → bigint               number of decimal places, e.g. 6n (balance 1_500_000n = 1.5 coins)
 *   totalSupply()     → bigint
 *   balanceOf({ who })               → bigint
 *   allowance({ owner, spender })    → bigint
 * State-changing functions
 *   transfer({ to, amount })                 → true
 *   approve({ spender, amount })             → true
 *   transferFrom({ from, to, amount })       → true   (uses the allowance from approved for the caller)
 * Optional functions (not required by the standard)
 *   multiTransfer({ transfers: [{ to, amount }, …] }) → number of entries   send to many wallets in one tx (one Transfer per entry)
 *   permit({ owner, spender, value, deadline, signature }) → true    set an allowance with the owner's signature (real ERC-2612 + EIP-712)
 *   nonces({ owner }) → bigint · permitDomain() → { name, version, chainId, verifyingContract } · DOMAIN_SEPARATOR() → the EIP-712 domainSeparator
 *
 * permit = ERC-2612: the owner can sign directly with eth_signTypedData_v4 (MetaMask) / ethers Wallet.signTypedData
 *   domain = { name: name(), version: "1", chainId: ChainId(), verifyingContract: ThisAddress() }
 *   types  = { Permit: PERMIT_TYPES.Permit } = Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)
 *   digest = eip712Digest(domain, types, "Permit", { owner, spender, value, nonce, deadline })   (see permitTypedData in src/crypto/program-signature.js)
 *   deadline = **seconds** (unix seconds, as in EIP-2612) · compared with params.block.timestamp / 1000n (block time is milliseconds, rounded down)
 *     → block seconds > deadline = "permit expired" (equal is still valid)
 *   the owner's nonce increments by 1 on every successful permit (old signatures can't be reused) · another chain / token → the signature is invalid
 *   owner is a program → asks owner.isValidSignature({ hash: digest, signature }) readonly (ERC-1271, src/standards/wallet.js)
 *   tokens deployed before the switch to EIP-712 keep their old code (digest = keccak256 of canonical JSON · deadline in milliseconds) until redeployed
 * Events that must be emitted
 *   Transfer { from, to, amount }      on every balance move · minting uses from = ZERO_ADDRESS
 *   Approval { owner, spender, amount } on every allowance change
 *
 * All amounts are bigint in the smallest unit (like wei) · the web UI divides by 10^decimals for display
 */

import { SIGNATURE_CHECKER } from "./wallet.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** permit encodeType (EIP-712 / ERC-2612) */
export const PERMIT_TYPE = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";
/** permit types as used by eth_signTypedData_v4 / ethers (EIP712Domain excluded) */
export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
export const PERMIT_VERSION = "1";
const PERMIT_TYPES_SOURCE = `{ Permit: [${PERMIT_TYPES.Permit.map(({ name, type }) => `{ name: "${name}", type: "${type}" }`).join(", ")}] }`;
export const TOKEN_FUNCTIONS = ["name", "ticker", "decimals", "totalSupply", "balanceOf", "allowance", "transfer", "approve", "transferFrom"];
export const TOKEN_EVENTS = ["Transfer", "Approval"];

/**
 * All token functions except initialization (shared with other programs that are also tokens, e.g. WCARD in system.js)
 * storage: name / ticker / decimals / totalSupply / owner · balances:<who> · allowance:<owner>:<spender> · nonces:<owner>
 */
export const TOKEN_CORE = `  function name() { return readDB("name") }
  function ticker() { return readDB("ticker") }
  function decimals() { return readDB("decimals") }
  function totalSupply() { return readDB("totalSupply") }
  function balanceOf(params) { return readDB(map("balances", params.input.who)) || 0n }
  function allowance(params) { return readDB(map("allowance", params.input.owner, params.input.spender)) || 0n }

  function move(from, to, amount) {
    if (amount <= 0n) throw new Error("amount must be greater than 0")
    const balance = readDB(map("balances", from)) || 0n
    if (balance < amount) throw new Error("insufficient balance")
    writeDB(map("balances", from), balance - amount)
    writeDB(map("balances", to), (readDB(map("balances", to)) || 0n) + amount)
    emit("Transfer", { from: from, to: to, amount: amount }, { indexed: ["from", "to"] })
  }

  function transfer(params) {
    move(params.context.sender, params.input.to, params.input.amount)
    return true
  }

  function multiTransfer(params) {
    let count = 0n
    for (const item of params.input.transfers) {
      move(params.context.sender, item.to, item.amount)
      count = count + 1n
    }
    if (count === 0n) throw new Error("no transfers")
    return count
  }

  function setAllowance(owner, spender, amount) {
    writeDB(map("allowance", owner, spender), amount)
    emit("Approval", { owner: owner, spender: spender, amount: amount }, { indexed: ["owner", "spender"] })
  }

  function approve(params) {
    setAllowance(params.context.sender, params.input.spender, params.input.amount)
    return true
  }

  ${SIGNATURE_CHECKER}

  function permitDomain() {
    return { name: readDB("name"), version: "${PERMIT_VERSION}", chainId: ChainId(), verifyingContract: ThisAddress() }
  }
  function DOMAIN_SEPARATOR() { return eip712DomainSeparator(permitDomain()) }
  function nonces(params) { return readDB(map("nonces", params.input.owner)) || 0n }

  // ERC-2612 · ${PERMIT_TYPE}
  const PERMIT_TYPES = ${PERMIT_TYPES_SOURCE}

  function permit(params) {
    const owner = params.input.owner
    const spender = params.input.spender
    const value = params.input.value
    const deadline = params.input.deadline
    if (typeof owner !== "string" || typeof spender !== "string" || owner.length !== 42 || spender.length !== 42) {
      throw new Error("owner and spender must be addresses")
    }
    if (typeof value !== "bigint" || value < 0n) throw new Error("value must be a non-negative bigint")
    if (typeof deadline !== "bigint") throw new Error("deadline must be a bigint (unix seconds, like EIP-2612)")
    if (params.block.timestamp / 1000n > deadline) throw new Error("permit expired")
    const nonce = readDB(map("nonces", owner)) || 0n
    const digest = eip712Digest(permitDomain(), PERMIT_TYPES, "Permit",
      { owner: owner, spender: spender, value: value, nonce: nonce, deadline: deadline })
    if (!isValidSignatureNow(owner, digest, params.input.signature)) throw new Error("invalid permit signature")
    writeDB(map("nonces", owner), nonce + 1n)
    setAllowance(owner, spender, value)
    return true
  }

  function transferFrom(params) {
    const spender = params.context.sender
    const allowed = readDB(map("allowance", params.input.from, spender)) || 0n
    if (allowed < params.input.amount) throw new Error("insufficient allowance")
    writeDB(map("allowance", params.input.from, spender), allowed - params.input.amount)
    move(params.input.from, params.input.to, params.input.amount)
    return true
  }
`;
/** function names TOKEN_CORE provides (put into the program's return { … }) */
export const TOKEN_CORE_EXPORTS = "name, ticker, decimals, totalSupply, balanceOf, allowance, transfer, multiTransfer, approve, transferFrom, permit, nonces, permitDomain, DOMAIN_SEPARATOR";

/**
 * Standard token program — input on deploy: { name, ticker, decimals, supply, owner?, namespace?, icon?, url?, contact?, description? }
 * owner = receives the entire supply (omitted = the deployer · the factory in src/standards/system.js passes = the creator)
 * supply is in the smallest unit (6 decimals + supply 1_000_000_000_000n = 1,000,000 coins)
 */
export const TOKEN_PROGRAM = `function program() {
  function initialization(params) {
    // owner may be passed (a factory cloning the template passes owner = the creator) · omitted = the deployer
    const owner = params.input.owner || params.context.sender
    if (params.input.owner !== undefined && (typeof owner !== "string" || owner.length !== 42)) throw new Error("owner must be an address")
    writeDB("name", params.input.name)
    writeDB("ticker", params.input.ticker)
    writeDB("decimals", params.input.decimals)
    writeDB("totalSupply", params.input.supply)
    writeDB("owner", owner)
    writeDB(map("balances", owner), params.input.supply)
    if (params.input.namespace) setMetadata("namespace", params.input.namespace)
    // program metadata can only be set from code: icon / url / contact / description may be passed at deploy
    if (params.input.icon) setMetadata("icon", params.input.icon)
    if (params.input.url) setMetadata("url", params.input.url)
    if (params.input.contact) setMetadata("contact", params.input.contact)
    if (params.input.description) setMetadata("description", params.input.description)
    if (params.input.supply > 0n) emit("Transfer", { from: "${ZERO_ADDRESS}", to: owner, amount: params.input.supply }, { indexed: ["from", "to"] })
  }

${TOKEN_CORE}
  return { ${TOKEN_CORE_EXPORTS} }
}`;

/** code stored by the VM has literal \\n (JSON-style escapes) → return normal code */
export function unescapeCode(code) {
  const raw = String(code ?? "");
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

/** function names in the program's last return { … } */
export function exportedFunctions(code) {
  const source = unescapeCode(code);
  return /return\s*\{([^}]*)\}\s*;?\s*\}\s*$/.exec(source)?.[1].split(",").map((name) => name.trim()).filter(Boolean) ?? [];
}

/** does this code export every function and emit every event in the lists? → { ok, missing: [] } (shared by all standards) */
export function checkStandard(code, functions, events) {
  const source = unescapeCode(code);
  const exported = exportedFunctions(source);
  const missing = [
    ...functions.filter((name) => !exported.includes(name)),
    ...events.filter((name) => !new RegExp(`emit\\(\\s*["'\`]${name}["'\`]`).test(source)).map((name) => `event ${name}`),
  ];
  return { ok: missing.length === 0, missing };
}

/** does this code follow the token standard (judged by exported functions and emitted events)? → { ok, missing: [] } */
export const checkTokenStandard = (code) => checkStandard(code, TOKEN_FUNCTIONS, TOKEN_EVENTS);
