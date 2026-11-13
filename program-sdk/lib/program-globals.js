/**
 * Fake API for quickly testing programs locally without running the VM
 *   const api = createFakeApi({ balances: { "0xabc": 100n } });
 *   Object.assign(globalThis, api);
 *   const { transfer } = program();
 *
 * Numbers are BigInt as on chain: balances / params.value / params.block.timestamp / BlockNumber()
 * (unlike the chain, input / storage are not converted for you — pass 10n yourself)
 *
 * For behavior identical to the chain in every respect (gas fees, rollback on throw, block time)
 * use createChain() from lib/testkit.js instead, which runs on the real VM
 */
import { createHash } from "node:crypto";

/** Data → text the same way as on chain (keys sorted alphabetically · BigInt as "123n") */
const canonical = (value) => {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const digest = (algorithm) => (value) =>
  `0x${createHash(algorithm).update(typeof value === "string" ? value : canonical(value), "utf8").digest("hex")}`;

/**
 * @typedef {object} Params
 * @property {object} input                 data sent by the caller
 * @property {{ sender: string, origin: string }} context  caller of this frame / tx originator
 * @property {bigint} value                 native attached to this call
 * @property {{ timestamp: bigint }} block  block time
 */

/**
 * @param {object} [options]
 * @param {Record<string, any>} [options.storage]   initial program data
 * @param {Record<string, bigint>} [options.balances] native balance of each address
 * @param {Record<string, object>} [options.metadata] metadata of each address
 * @param {string[]} [options.programs]             addresses treated as programs
 * @param {string} [options.self]                   address of the program under test
 * @param {number} [options.blockNumber]
 * @param {number} [options.timestamp]
 * @param {Record<number, string>} [options.blockHashes] hashes of previous blocks (block number → hash) for BlockHash()
 * @param {Record<string, string>} [options.code]      code of each address for CodeSizeOf()
 * @param {number} [options.chainId]
 * @param {string|null} [options.coinbase]           block producer
 * @param {number|null} [options.blockGasLimit]
 * @param {bigint} [options.gasPrice]               actual tx price (GasPrice())
 * @param {bigint} [options.baseFee]                block base fee (BaseFee() · EIP-1559)
 */
export function createFakeApi({
  storage = {},
  balances = {},
  metadata = {},
  programs = [],
  self = "0xprogram",
  blockNumber = 1,
  timestamp = Date.parse("2025-01-01T00:00:00Z"),
  blockHashes = {},
  code = {},
  chainId = 1,
  coinbase = null,
  blockGasLimit = null,
  gasPrice = 1_000_000_000n,
  baseFee = 1_000_000_000n,
} = {}) {
  const store = new Map(Object.entries(storage));
  const meta = new Map(Object.entries(metadata));
  const programSet = new Set([self, ...programs].map((address) => address.toLowerCase()));
  const events = [];
  const transfers = [];

  const toKey = (key) => (typeof key === "string" ? key : key.parts.join(":"));
  const lower = (address) => String(address).toLowerCase();
  const native = new Map(Object.entries(balances).map(([address, value]) => [lower(address), BigInt(value)]));
  const balanceOf = (address) => native.get(lower(address)) ?? 0n;

  return {
    // ---------- program data ----------
    /** @param {string|object} key */
    readDB: (key) => store.get(toKey(key)),
    /** @param {string|object} key @param {any} value */
    writeDB: (key, value) => void store.set(toKey(key), value),
    /** @param {string|object} key */
    deleteDB: (key) => void store.delete(toKey(key)),
    /** @param {...(string|number|bigint)} parts */
    map: (...parts) => ({ parts: parts.map(String) }),

    // ---------- money ----------
    /** The program's own remaining native balance */
    ThisBalance: () => balanceOf(self),
    /** @param {string} address */
    BalanceOf: (address) => balanceOf(address),
    /** @param {string} to @param {bigint} amount */
    transferNative: (to, amount) => {
      if (typeof amount !== "bigint") throw new Error("amount: numbers in programs must be BigInt only (e.g. 10n)");
      if (amount <= 0n) throw new Error("amount must be a positive integer");
      if (balanceOf(self) < amount) throw new Error(`insufficient native balance of '${self}'`);
      native.set(lower(self), balanceOf(self) - amount);
      native.set(lower(to), balanceOf(to) + amount);
      transfers.push({ from: lower(self), to: lower(to), amount });
      return true;
    },

    // ---------- address data ----------
    /** The program's own address */
    ThisAddress: () => self,
    /** @param {string} address */
    IsProgram: (address) => programSet.has(lower(address)),
    /** @param {string} address @param {string} field */
    MetadataOf: (address, field) => meta.get(lower(address))?.[field] ?? null,
    /** @param {string} field @param {any} value */
    setMetadata: (field, value) => {
      const current = meta.get(lower(self)) ?? {};
      if (value === null) delete current[field];
      else current[field] = value;
      meta.set(lower(self), current);
      return true;
    },

    // ---------- event / block ----------
    /** @param {string} name @param {object} [data] @param {{ indexed?: string[] }} [options] fields searchable by value (max 3) */
    emit: (name, data = {}, options) => {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)) throw new Error("invalid event name");
      const indexed = options?.indexed ?? [];
      if (!Array.isArray(indexed) || indexed.length > 3 || new Set(indexed).size !== indexed.length
        || indexed.some((field) => !Object.hasOwn(data, field))) throw new Error("emit: invalid indexed");
      events.push({ index: events.length, name, data, ...(indexed.length ? { indexed: [...indexed] } : {}) });
      return true;
    },
    BlockNumber: () => BigInt(blockNumber),
    /** hash of a previous block (up to 256 blocks back) · current / future block → null @param {bigint} n */
    BlockHash: (n) => {
      if (typeof n !== "bigint") throw new Error("BlockHash: numbers in programs must be BigInt only (e.g. 10n)");
      if (n >= BigInt(blockNumber) || n < BigInt(blockNumber) - 256n) return null;
      return blockHashes[Number(n)] ?? null;
    },
    ChainId: () => BigInt(chainId),
    Coinbase: () => (coinbase === null ? null : lower(coinbase)),
    BlockGasLimit: () => (blockGasLimit === null ? null : BigInt(blockGasLimit)),
    GasPrice: () => BigInt(gasPrice),
    BaseFee: () => BigInt(baseFee),
    /** This mode doesn't meter gas → always null (use createChain() for real values) */
    GasLeft: () => null,

    // ---------- address code ----------
    /** @param {string} address */
    CodeSizeOf: (address) => (code[lower(address)] === undefined ? 0n : BigInt(Buffer.byteLength(code[lower(address)], "utf8"))),
    /** keccak256 of code can't be computed in this mode (node:crypto has no keccak) — use createChain() instead */
    CodeHashOf: (address) => {
      if (code[lower(address)] === undefined) return null;
      throw new Error("fast test mode can't compute CodeHashOf, use createChain() instead");
    },

    // ---------- precompile ----------
    /** @param {string|object} value */
    sha256: digest("sha256"),
    /** @param {string|object} value */
    ripemd160: digest("ripemd160"),
    /** BLAKE2b-512 @param {string|object} value */
    blake2b: digest("blake2b512"),
    /** (base ** exponent) % modulus · modulus = 0n → 0n @param {bigint} base @param {bigint} exponent @param {bigint} modulus */
    modexp: (base, exponent, modulus) => {
      for (const value of [base, exponent, modulus]) {
        if (typeof value !== "bigint" || value < 0n) throw new Error("modexp: base / exponent / modulus must be non-negative BigInt");
      }
      if (modulus === 0n) return 0n;
      let result = 1n % modulus;
      for (let b = base % modulus, e = exponent; e > 0n; e >>= 1n, b = (b * b) % modulus) if (e & 1n) result = (result * b) % modulus;
      return result;
    },

    // ---------- raw bytes / EIP-712 (needs keccak256, which node:crypto lacks → use createChain() instead) ----------
    /** keccak256 of raw bytes "0x…" @param {string} hex */
    keccak256Bytes: () => { throw new Error("fast test mode can't compute keccak256Bytes, use createChain() instead"); },
    /** Recover an address from a 32-byte digest + signature @param {string} digest @param {string} signature */
    ecrecoverDigest: () => { throw new Error("fast test mode can't compute ecrecoverDigest, use createChain() instead"); },
    /** eth_signTypedData_v4-style digest @param {object} domain @param {object} types @param {string} primaryType @param {object} message */
    eip712Digest: () => { throw new Error("fast test mode can't compute eip712Digest, use createChain() instead"); },
    /** EIP-712 domainSeparator @param {object} domain @param {object} [types] */
    eip712DomainSeparator: () => { throw new Error("fast test mode can't compute eip712DomainSeparator, use createChain() instead"); },

    /** Can't call other programs in this mode — use createChain() from testkit instead */
    runProgram: () => { throw new Error("fast test mode can't call other programs, use createChain() instead"); },
    /** Can't create new programs in this mode — use createChain() from testkit instead */
    cloneProgram: () => { throw new Error("fast test mode can't create new programs, use createChain() instead"); },

    // ---------- for checking results in tests ----------
    store, native, meta, events, transfers,
    params: (input = {}, { sender = "0xalice", value = 0n } = {}) =>
      ({ input, context: { sender, origin: sender }, value: BigInt(value), block: { timestamp: BigInt(timestamp) } }),
  };
}
