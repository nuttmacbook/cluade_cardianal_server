/**
 * EVM-style JSON-RPC adapter (POST /evm) — reads the existing chain data and answers in the format MetaMask / ethers / viem understand
 *
 *   const rpc = createEvmRpc({ vm, mempool });
 *   rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })   // → { jsonrpc, id, result: "0x1" }
 *
 * Read-only: doesn't write the DB, touch the mempool or change chain rules (except eth_sendRawTransaction, which goes through the server's submit)
 *   - eth_sendRawTransaction (src/node/evm-raw.js): legacy (EIP-155) / type 2 txs → native transfer · ERC-20 on standard tokens · functions per metadata.abi
 *     forwarded to the server's submit(verified) (through the mempool + simulate, same as /sendtx) · hash = keccak(raw)
 *   - eth_estimateGas: program calls = simulated with vm.query plus a 25% margin (chain gas)
 *   - the chain's native coin already uses 18-decimal wei-style units → passed through as is (decimals = extra decimals to add, default 0)
 *   - standard tokens (src/standards/token.js) answer ERC-20 eth_calls (balanceOf / decimals / symbol / name / totalSupply / allowance)
 *   - standard NFTs / multi-tokens (src/standards/nft.js / multitoken.js) emit indexed → ERC-721 logs (tokenId as the 4th topic) / ERC-1155
 *   - events → logs via the VM's eventLog() (the same values used for logsBloom / receiptsRoot in the header):
 *       indexed emit → topic0 = keccak("name(type,…)") + topics for indexed fields (a standard token's Transfer = an ERC-20 log)
 *       no indexed → topic0 = keccak(name), data = JSON as hex
 *   - EIP-1559: baseFeePerGas in blocks · eth_feeHistory · eth_maxPriorityFeePerGas · eth_gasPrice = next base fee + suggested tip
 *     1559 txs → type 0x2 + maxFeePerGas / maxPriorityFeePerGas · receipts have effectiveGasPrice
 *   - eth_getLogs: skips blocks using the header's logsBloom · with topic0 + another topic → uses the eventidx: index, replaying only matching blocks
 *   - cardianal_getAbi(address) → the program's metadata.abi converted to an Ethereum JSON ABI (bundled programs get their ABI from code: src/standards/system-abi.js · null = not declared)
 *   - cardianal_getProof([key, …]) → Merkle proofs of keys in the latest state against the latest block's stateRoot (vm.getProof)
 *       key = dbKey ("0xprog:storage:balances:0xabc") or { program, key } (key is a string or an array = map(...))
 *     eth_getProof returns an error: the chain's state is not an EVM account trie (no storageHash / 32-byte slots) → use cardianal_getProof
 *     eth_call for both: name / symbol / balanceOf / ownerOf / tokenURI / getApproved / uri / isApprovedForAll / supportsInterface
 *   - eth_call on other programs that declare metadata.abi: decoded / encoded per the Solidity ABI (src/node/evm-abi.js) → dApps can read them directly with ethers / viem
 *   - balance / nonce / code / eth_call at a block number are read from chain history (vm.stateAt) · requires recordHistory
 *   - debug_trace* (callTracer) built from the trace + nativeChanges of a block replay · replay results are cached per block
 *   - HTTP filters (ethers contract.on over JsonRpcProvider uses these): eth_newFilter / eth_newBlockFilter / eth_newPendingTransactionFilter
 *       → eth_getFilterChanges (new since the last call) · eth_getFilterLogs · eth_uninstallFilter
 *       kept in the node's memory (restart = lost → "filter not found", the dApp recreates it) · not polled within filterTtlMs = deleted (like geth)
 *       capped at maxFilters per node and maxFiltersPerClient per IP · log filters scan at most logRange blocks per call
 *       pending filters get hashes from mempool.onAdded · buffer at most PENDING_BUFFER hashes (excess drops the oldest)
 *   - eth_createAccessList: the chain has no access lists → empty accessList + gasUsed equal to eth_estimateGas
 *   - eth_simulateV1: runs several calls in sequence on a simulated next block (no commit) · returns status / returnData / gasUsed / logs per call
 *       supports 1 blockStateCalls set · no stateOverrides / blockOverrides · charges gas like a real tx (the sender needs enough balance)
 *       nonces filled in order within the simulated block · traceTransfers doesn't create logs for native transfers
 */
import crypto from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { NATIVE_FIELD, codeKey, nativeKey, nonceKey, normalizeAddress, metadataKey, eventLog, logsBloom, bloomContains, toEvmAbi, decodeDbKey,
  storageKey, map } from "../core/virtualmachine.js";
import { checkTokenStandard, unescapeCode } from "../standards/token.js";
import { resolveAbi } from "../standards/system-abi.js";
import { checkNftStandard } from "../standards/nft.js";
import { checkMultiTokenStandard } from "../standards/multitoken.js";
import { abiFunctions, decodeInput, encodeOutput, AbiError } from "./evm-abi.js";
import { decodeRawTransaction, rawToVerified, RawTxError } from "./evm-raw.js";

export const EVM_ERROR = { PARSE: -32700, REQUEST: -32600, METHOD: -32601, PARAMS: -32602, INTERNAL: -32603, SERVER: -32000, LIMIT: -32005 };

const ZERO_HASH = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const EMPTY_BLOOM = `0x${"0".repeat(512)}`;
const EMPTY_UNCLES = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";   // keccak(rlp([]))
const BLOCK_GAS_LIMIT = 30_000_000;   // used when the chain doesn't set maxBlockGas
const REPLAY_CACHE = 64;              // number of blocks whose replay results are cached
const LOG_RANGE = 1000;               // max block range for eth_getLogs
const TRANSFER_GAS = 21_000;   // gas MetaMask sets for a plain transfer (used only for eth_estimateGas answers)
const FILTER_TTL_MS = 5 * 60_000;     // filters not polled for this long are deleted (same as geth)
const MAX_FILTERS = 10_000;           // filters per node
const MAX_FILTERS_PER_CLIENT = 100;   // filters per IP
const PENDING_BUFFER = 10_000;        // hashes a pending filter can buffer
const SIMULATE_MAX_CALLS = 100;       // calls per eth_simulateV1

const TOKEN_WRITE = {   // ERC-20 sent by wallets (eth_sendRawTransaction) → standard token functions
  "0xa9059cbb": { method: "transfer", args: 2 }, "0x095ea7b3": { method: "approve", args: 2 }, "0x23b872dd": { method: "transferFrom", args: 3 },
};
const SELECTOR = {   // ERC-20 that standard tokens can answer
  "0x70a08231": "balanceOf", "0x313ce567": "decimals", "0x95d89b41": "symbol",
  "0x06fdde03": "name", "0x18160ddd": "totalSupply", "0xdd62ed3e": "allowance",
};
const selectors = (map) => Object.fromEntries(Object.entries(map).map(([signature, fn]) => [keccakHex(signature).slice(0, 10), fn]));
const NFT_SELECTOR = selectors({   // ERC-721 that standard NFTs can answer
  "name()": "name", "symbol()": "symbol", "totalSupply()": "totalSupply", "balanceOf(address)": "balanceOf",
  "ownerOf(uint256)": "ownerOf", "tokenURI(uint256)": "tokenURI", "getApproved(uint256)": "getApproved",
  "isApprovedForAll(address,address)": "isApprovedForAll", "supportsInterface(bytes4)": "supportsInterface",
});
const MULTITOKEN_SELECTOR = selectors({   // ERC-1155 that standard multi-tokens can answer
  "name()": "name", "symbol()": "symbol", "balanceOf(address,uint256)": "balanceOf", "uri(uint256)": "uri",
  "totalSupply(uint256)": "totalSupply", "isApprovedForAll(address,address)": "isApprovedForAll", "supportsInterface(bytes4)": "supportsInterface",
});

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const fail = (code, message, data) => { throw new RpcError(code, message, data); };

function keccakHex(text) { return `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`; }
const hexBytes = (hex) => Buffer.from(String(hex).replace(/^0x/, ""), "hex");

const bloomOf = logsBloom;   // same as the block header (see virtualmachine.js)
const FEE_HISTORY_BLOCKS = 1024;   // max blocks eth_feeHistory can request
const TIP_SAMPLE_BLOCKS = 20;      // suggested tip = median tip over this many recent blocks

/** chain numeric value (number / "123n" / "123") → bigint */
export function toBig(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+n?$/.test(value)) return BigInt(value.replace(/n$/, ""));
  return 0n;
}
export const quantity = (value) => {
  const big = toBig(value);
  return `0x${(big < 0n ? 0n : big).toString(16)}`;
};
const word = (value) => toBig(value).toString(16).padStart(64, "0");
const addressWord = (address) => String(address ?? "").toLowerCase().replace(/^0x/, "").padStart(64, "0");
/** ABI: a single string */
const abiString = (text) => {
  const hex = bytesToHex(utf8ToBytes(String(text ?? "")));
  return `0x${word(32)}${word(hex.length / 2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};
const hexOfJson = (value) => `0x${bytesToHex(utf8ToBytes(JSON.stringify(value ?? null, (k, v) => (typeof v === "bigint" ? `${v}n` : v))))}`;

const isAddress = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isHash = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const needAddress = (value) => (isAddress(value) ? normalizeAddress(value) : fail(EVM_ERROR.PARAMS, `invalid address: ${value}`));

/**
 * @param {{ vm: import("../core/virtualmachine.js").VirtualMachine, mempool?: object, decimals?: number, clientVersion?: string, logRange?: number }} options
 */
export function createEvmRpc({ vm, mempool = null, decimals = 0, clientVersion = "cardianal/evm-adapter", logRange = LOG_RANGE, submit = null,
  filterTtlMs = FILTER_TTL_MS, maxFilters = MAX_FILTERS, maxFiltersPerClient = MAX_FILTERS_PER_CLIENT, now = () => Date.now() } = {}) {
  const scale = 10n ** BigInt(decimals);
  const native = (value) => toBig(value) * scale;
  const latest = () => vm.latestBlockNumber() ?? 0;

  // ---------- state at a block ----------
  /** tag → null (current value) or the block number to read back at */
  const stateBlock = (tag) => {
    if (tag === undefined || tag === null || tag === "pending") return null;
    const number = blockNumberOf(tag);
    if (number > latest()) fail(EVM_ERROR.SERVER, "header not found");
    return number >= latest() ? null : number;
  };
  /** a key's value as of when that block was sealed (chain history) · null = current value */
  const readAt = (at, dbKey) => (at === null ? vm.read(dbKey) : vm.stateAt(at, dbKey));
  const isProgramAt = (address, at = null) => readAt(at, codeKey(address)) !== undefined;
  /** read a program function on the state at that block (writes nothing) */
  const queryAt = (at, programUuid, functionName, input = {}, context = undefined) => {
    const options = at === null ? {} : { read: (dbKey) => vm.stateAt(at, dbKey), blockNumber: at, timestamp: headerAt(at)?.timestamp || undefined };
    return vm.query({ programUuid, functionName, input, context }, options);
  };
  /** standard token info at a block (null = not a standard token / not yet deployed) */
  const tokenAt = (address, at = null) => {
    const source = readAt(at, codeKey(address));
    if (source === undefined || !checkTokenStandard(source).ok) return null;
    const read = (fn) => { const r = queryAt(at, address, fn); return r.status === "success" ? r.result : null; };
    return { address, name: read("name"), ticker: read("ticker"), decimals: read("decimals"), totalSupply: read("totalSupply") };
  };
  /** standard NFT / multi-token at a block → "erc721" | "erc1155" | null (judged from the code only, without running the program) */
  const collectionAt = (address, at = null) => {
    const source = address ? readAt(at, codeKey(address)) : undefined;
    if (source === undefined) return null;
    if (checkNftStandard(source).ok) return "erc721";
    return checkMultiTokenStandard(source).ok ? "erc1155" : null;
  };

  // ---------- block ----------
  const blockNumberOf = (tag) => {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return latest();
    if (tag === "earliest") return 0;
    if (typeof tag === "string" && /^0x[0-9a-fA-F]+$/.test(tag)) return Number.parseInt(tag, 16);
    if (typeof tag === "number" && Number.isInteger(tag) && tag >= 0) return tag;
    if (tag && typeof tag === "object" && tag.blockNumber !== undefined) return blockNumberOf(tag.blockNumber);
    if (tag && typeof tag === "object" && tag.blockHash !== undefined) {
      const found = blockByHash(tag.blockHash, false);
      return found ? Number.parseInt(found.number, 16) : fail(EVM_ERROR.SERVER, "header not found");
    }
    return fail(EVM_ERROR.PARAMS, `invalid block tag: ${JSON.stringify(tag)}`);
  };
  // genesis has no time → use block 1's time (so Blockscout doesn't show the year 1970)
  const genesisBlock = () => ({
    number: 0, hash: vm.genesisHash(), parentHash: ZERO_HASH, timestamp: vm.getBlock(1)?.timestamp ?? 0, feeRecipient: ZERO_ADDRESS,
    gasUsed: 0, stateRoot: ZERO_HASH, txRoot: ZERO_HASH, txHashes: [],
  });
  const headerAt = (number) => (number === 0 ? genesisBlock() : vm.getBlock(number));

  // replay results per block (cached by hash: sealed blocks don't change) → every receipt + logIndex / cumulative gas for the block
  const replays = new Map();
  function replayed(number) {
    const header = headerAt(number);
    if (!header) return null;
    const key = `${number}:${header.hash}`;
    if (replays.has(key)) {
      const hit = replays.get(key);
      replays.delete(key);
      replays.set(key, hit);
      return hit;
    }
    const transactions = number === 0 ? [] : vm.replayBlock(number).transactions;
    let logs = 0;
    let gas = 0;
    const offsets = transactions.map((t) => {
      const at = { logStart: logs, logCount: t.events?.length ?? 0, cumulativeGas: (gas += Number(t.gasUsed ?? 0)) };
      logs += t.events?.length ?? 0;
      return at;
    });
    const value = { header, transactions, offsets };
    replays.set(key, value);
    if (replays.size > REPLAY_CACHE) replays.delete(replays.keys().next().value);
    return value;
  }

  /**
   * rejected txs recorded in this block → appended after the real txs as failed txs (status 0x0, gasUsed 0) so Blockscout sees them
   * skips hashes that were later actually included, or rejected again in a later block (1 hash = 1 tx from the EVM's point of view)
   * EVM index = number of real txs + position in this list
   */
  function rejectedIn(header) {
    if (!header?.rejectedCount) return [];
    const base = header.txHashes?.length ?? 0;
    return vm.getBlockRejected(header.number)
      .filter((entry) => !vm.getTransaction(entry.hash) && vm.getRejectedTransaction(entry.hash)?.blockNumber === header.number)
      .map((entry, i) => ({ ...entry, evmIndex: base + i }));
  }
  /** every tx hash of the block from the EVM's point of view: real txs in order, followed by rejected txs */
  const evmHashes = (header) => [...(header?.txHashes ?? []), ...rejectedIn(header).map((entry) => entry.hash)];
  /** a rejected tx → { found, receipt, block, logStart, cumulativeGas } like a real tx (no logs · gas unchanged) */
  function rejectedTx(entry, header, offsets) {
    const last = offsets.at(-1);
    const logStart = last ? last.logStart + (last.logCount ?? 0) : 0;
    return {
      found: { hash: entry.hash, blockNumber: header.number, index: entry.evmIndex, action: entry.action, from: entry.sender, nonce: entry.nonce, rejected: entry },
      receipt: { action: entry.action, status: "rejected", gasUsed: 0, gasPrice: entry.gasPrice ?? vm.gas.price, value: 0, to: entry.to,
        method: null, input: null, events: [], trace: [], nativeChanges: [], error: { code: entry.code ?? "REJECTED", message: entry.reason } },
      block: header, logStart, cumulativeGas: last?.cumulativeGas ?? 0,
    };
  }

  function formatBlock(header, full) {
    const number = header.number;
    const hashes = evmHashes(header);
    // logsBloom / receiptsRoot come from the header (part of the block hash) · old headers without them → computed from receipts
    let bloom = header.logsBloom ?? EMPTY_BLOOM;
    if (!header.logsBloom && hashes.length) {
      try { bloom = bloomOf(blockReceipts(number).flatMap((r) => r.logs)); } catch { /* no history → empty bloom */ }
    }
    return {
      number: quantity(number), hash: header.hash,
      parentHash: header.parentHash ?? (number === 1 ? vm.genesisHash() : ZERO_HASH),
      nonce: "0x0000000000000000", sha3Uncles: EMPTY_UNCLES, logsBloom: bloom,
      transactionsRoot: header.txRoot ?? ZERO_HASH, stateRoot: header.stateRoot ?? ZERO_HASH, receiptsRoot: header.receiptsRoot ?? ZERO_HASH,
      baseFeePerGas: quantity(native(header.baseFeePerGas ?? vm.minBaseFeeNow())),
      miner: header.feeRecipient ?? ZERO_ADDRESS, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x",
      size: quantity(1000 + hashes.length * 32), gasLimit: quantity(vm.maxBlockGas ?? BLOCK_GAS_LIMIT), gasUsed: quantity(header.gasUsed ?? 0),
      timestamp: quantity(Math.floor((header.timestamp ?? 0) / 1000)), mixHash: ZERO_HASH,
      transactions: full ? hashes.map((hash) => transactionByHash(hash)).filter(Boolean) : hashes,
      uncles: [],
    };
  }
  const blockByNumber = (tag, full) => {
    const number = blockNumberOf(tag);
    const header = headerAt(number);
    return header ? formatBlock(header, Boolean(full)) : null;
  };
  const headerByHash = (hash) => {
    if (!isHash(hash)) fail(EVM_ERROR.PARAMS, `invalid block hash: ${hash}`);
    if (hash.toLowerCase() === String(vm.genesisHash()).toLowerCase()) return genesisBlock();
    return vm.getBlockByHash(hash.toLowerCase()) ?? null;
  };
  const blockByHash = (hash, full) => {
    const header = headerByHash(hash);
    return header ? formatBlock(header, Boolean(full)) : null;
  };
  /** a block tag or hash (as eth_getBlockReceipts / debug_trace* accept) → block number */
  const blockRef = (ref) => (isHash(ref) ? headerByHash(ref)?.number ?? null : blockNumberOf(ref));

  // ---------- tx ----------
  /** the result of an existing tx from replaying its block (same as GET /tx/:hash/receipt) */
  function located(hash) {
    if (!isHash(hash)) fail(EVM_ERROR.PARAMS, `invalid transaction hash: ${hash}`);
    const found = vm.getTransaction(hash.toLowerCase());
    if (!found) {
      // rejected (recorded in a block) → an EVM-style failed tx
      const entry = vm.getRejectedTransaction(hash.toLowerCase());
      const header = entry ? headerAt(entry.blockNumber) : null;
      const listed = header ? rejectedIn(header).find((item) => item.hash === entry.hash) : null;
      return listed ? rejectedTx(listed, header, replayed(header.number).offsets) : null;
    }
    const { header, transactions, offsets } = replayed(found.blockNumber);
    const receipt = transactions[found.index];
    // tx from eth_sendRawTransaction: answer with the Ethereum-style hash (keccak(raw)) the wallet holds
    return { found: receipt?.evmHash ? { ...found, hash: receipt.evmHash } : found, receipt, block: header, ...offsets[found.index] };
  }
  const signatureParts = (signature) => {
    const hex = typeof signature === "string" ? signature.replace(/^0x/, "") : "";
    if (hex.length !== 130) return { v: "0x0", r: "0x0", s: "0x0" };
    return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v: quantity(Number.parseInt(hex.slice(128), 16)) };
  };
  /** EVM to: the program called / the recipient · deploy = null */
  const targetOf = (r) => (r.action === "deploy" ? null : r.to ?? (r.action === "call" ? r.programUuid ?? null : null));
  /** EVM input: the data actually sent (method + input) encoded as JSON, then hex */
  const inputOf = (r) => (r.action === "transfer" ? "0x" : hexOfJson({ action: r.action, method: r.method ?? null, input: r.input ?? null }));

  function formatTransaction({ found, receipt, block }) {
    return {
      hash: found.hash, nonce: quantity(found.nonce ?? 0),
      blockHash: block?.hash ?? null, blockNumber: quantity(found.blockNumber), transactionIndex: quantity(found.index),
      from: found.from ?? ZERO_ADDRESS, to: targetOf({ ...receipt, action: found.action }),
      value: quantity(native(receipt.value ?? 0)),
      gas: quantity(receipt.gasLimit ?? receipt.gasUsed ?? 0), gasPrice: quantity(native(receipt.effectiveGasPrice ?? receipt.gasPrice ?? vm.gas.price)),
      input: inputOf({ ...receipt, action: found.action }),
      ...feeFieldsOf(receipt), chainId: quantity(vm.chainId),
      ...signatureParts(vm.transactionSignature(found)),   // the signature is in the blockbody
    };
  }
  /** EVM tx type: 0x2 (EIP-1559) has maxFeePerGas / maxPriorityFeePerGas · legacy 0x0 */
  function feeFieldsOf(receipt) {
    if (receipt.type !== 2) return { type: "0x0" };
    return { type: "0x2", maxFeePerGas: quantity(native(receipt.maxFeePerGas ?? receipt.effectiveGasPrice ?? 0)),
      maxPriorityFeePerGas: quantity(native(receipt.maxPriorityFeePerGas ?? 0)), accessList: [] };
  }
  /** a tx still waiting in the mempool (only the data mempool.list() provides) */
  const pendingTransaction = (item) => ({
    hash: item.hash, nonce: quantity(item.nonce ?? 0), blockHash: null, blockNumber: null, transactionIndex: null,
    from: item.sender ?? null, to: item.to ?? null, value: "0x0", gas: "0x0",
    gasPrice: quantity(native(item.maxFeePerGas ?? item.gasPrice ?? vm.gas.price)),
    input: "0x", ...(item.maxFeePerGas !== undefined
      ? { type: "0x2", maxFeePerGas: quantity(native(item.maxFeePerGas)), maxPriorityFeePerGas: quantity(native(item.maxPriorityFeePerGas ?? 0)), accessList: [] }
      : { type: "0x0" }),
    chainId: quantity(vm.chainId), v: "0x0", r: "0x0", s: "0x0",
  });
  const transactionByHash = (hash) => {
    const tx = located(hash);
    if (tx) return formatTransaction(tx);
    if (mempool?.has?.(hash)) {
      const item = mempool.list().find((entry) => entry.hash === hash);
      return item ? pendingTransaction(item) : null;
    }
    return null;
  };
  const transactionAt = (number, index) => {
    const hash = number === null ? undefined : evmHashes(headerAt(number))[Number.parseInt(index, 16)];
    return hash ? transactionByHash(hash) : null;
  };

  /**
   * chain events → EVM logs (logIndex counts continuously across the block)
   * topics / data come from the VM's eventLog = the same values used for the header's logsBloom / receiptsRoot
   * standard programs (token / NFT / multi-token) emit indexed → exactly ERC-20 / ERC-721 / ERC-1155 logs
   */
  function formatLog(event, logIndex, base) {
    const { address, topics, data } = eventLog(event);
    return { address: address ?? ZERO_ADDRESS, topics, data, logIndex: quantity(logIndex), removed: false, ...base };
  }
  function formatReceipt({ found, receipt, block, logStart, cumulativeGas }) {
    const base = { blockHash: block?.hash ?? null, blockNumber: quantity(found.blockNumber), transactionHash: found.hash, transactionIndex: quantity(found.index) };
    const logs = (receipt.events ?? []).map((event, i) => formatLog(event, logStart + i, base));
    return {
      ...base, from: found.from ?? ZERO_ADDRESS, to: targetOf({ ...receipt, action: found.action }),
      cumulativeGasUsed: quantity(cumulativeGas), gasUsed: quantity(receipt.gasUsed ?? 0),
      effectiveGasPrice: quantity(native(receipt.effectiveGasPrice ?? receipt.gasPrice ?? vm.gas.price)),
      contractAddress: found.action === "deploy" ? receipt.result?.programUuid ?? null : null,
      logs, logsBloom: bloomOf(logs), type: feeFieldsOf(receipt).type,
      status: receipt.status === "success" ? "0x1" : "0x0",
    };
  }
  function transactionReceipt(hash) {
    const tx = located(hash);
    return tx ? formatReceipt(tx) : null;
  }
  /** every tx of a block from a single replay: { found, receipt, block, logStart, cumulativeGas } */
  function blockTransactions(number) {
    const data = number === null ? null : replayed(number);
    if (!data) return null;
    const real = (data.header.txHashes ?? []).map((hash, index) => {
      const receipt = data.transactions[index];
      const found = { hash: receipt.evmHash ?? hash, blockNumber: number, index, action: receipt.action, from: receipt.from };
      return { found, receipt, block: data.header, ...data.offsets[index] };
    });
    return [...real, ...rejectedIn(data.header).map((entry) => rejectedTx(entry, data.header, data.offsets))];
  }
  const blockReceipts = (number) => blockTransactions(number)?.map(formatReceipt) ?? null;

  // ---------- internal txs (geth callTracer-style debug_trace*) ----------
  const frameError = (entry) => (entry?.status && entry.status !== "success" ? entry.error?.message ?? entry.status : undefined);
  const frameOf = (fields) => {
    const frame = { type: "CALL", gas: "0x0", gasUsed: "0x0", input: "0x", output: "0x", value: "0x0", ...fields };
    for (const key of Object.keys(frame)) if (frame[key] === undefined) delete frame[key];
    return frame;
  };
  const codeHex = (source) => `0x${bytesToHex(utf8ToBytes(unescapeCode(source ?? "")))}`;

  /**
   * native sent by programs via transferNative isn't in the trace → derived from nativeChanges
   * subtract the value of every trace frame and the fees (consumed → zero address / feeRecipient) first, then pair the remaining senders → recipients
   */
  function nativeMoves(receipt, block, valueMoves) {
    const delta = new Map();
    const add = (address, field, amount) => {
      const key = `${String(address).toLowerCase()}|${field}`;
      delta.set(key, (delta.get(key) ?? 0n) + amount);
    };
    for (const change of receipt.nativeChanges ?? []) add(change.address, change.field, toBig(change.after) - toBig(change.before ?? 0));
    for (const move of valueMoves) {
      add(move.from, NATIVE_FIELD.SENDED, -move.value);
      add(move.to, NATIVE_FIELD.RECEIVED, -move.value);
    }
    let fee = 0n;
    for (const [key, amount] of delta) if (key.endsWith(`|${NATIVE_FIELD.CONSUMED}`)) fee += amount;
    for (const collector of [ZERO_ADDRESS, block?.feeRecipient]) {
      if (!collector || fee <= 0n) continue;
      const key = `${collector.toLowerCase()}|${NATIVE_FIELD.RECEIVED}`;
      const taken = (delta.get(key) ?? 0n) < fee ? delta.get(key) ?? 0n : fee;
      if (taken > 0n) { delta.set(key, delta.get(key) - taken); fee -= taken; }
    }
    const side = (field) => [...delta].filter(([key, amount]) => key.endsWith(`|${field}`) && amount > 0n)
      .map(([key, amount]) => ({ address: key.split("|")[0], amount }));
    const senders = side(NATIVE_FIELD.SENDED);
    const receivers = side(NATIVE_FIELD.RECEIVED);
    const moves = [];
    for (const sender of senders) {
      for (const receiver of receivers) {
        if (sender.amount === 0n) break;
        if (receiver.amount === 0n) continue;
        const value = sender.amount < receiver.amount ? sender.amount : receiver.amount;
        moves.push({ from: sender.address, to: receiver.address, value });
        sender.amount -= value;
        receiver.amount -= value;
      }
    }
    return moves;
  }

  function callFrame({ found, receipt, block }, { onlyTopCall = false } = {}) {
    const action = found.action ?? receipt.action;
    const trace = receipt.trace ?? [];
    const root = frameOf({
      type: action === "deploy" ? "CREATE" : "CALL",
      from: found.from ?? receipt.from ?? ZERO_ADDRESS, to: receipt.to ?? receipt.result?.programUuid ?? ZERO_ADDRESS,
      value: quantity(native(receipt.value ?? 0)),
      gas: quantity(receipt.gasLimit ?? receipt.gasUsed ?? 0), gasUsed: quantity(receipt.gasUsed ?? 0),
      input: inputOf({ ...receipt, action }),
      output: action === "deploy" && receipt.status === "success" ? codeHex(receipt.result?.code)
        : receipt.status === "success" && action !== "transfer" ? hexOfJson(receipt.result) : "0x",
      error: receipt.status === "success" ? undefined : receipt.error?.message ?? receipt.status,
    });
    if (onlyTopCall) return root;

    // trace is in pre-order (depth 0 = outermost) → nested into calls[]
    const frames = [{ frame: root, to: root.to }];
    const stack = [root];
    for (const entry of trace) {
      if (entry.depth === 0) continue;
      const frame = frameOf({
        // cloneProgram = creates a new program along the way · runProgram with { readonly: true } = STATICCALL
        type: entry.type === "create" ? "CREATE" : entry.type === "staticcall" ? "STATICCALL" : "CALL",
        from: entry.from, to: entry.program, value: quantity(native(entry.value ?? 0)),
        gas: quantity(entry.gasUsed ?? 0), gasUsed: quantity(entry.gasUsed ?? 0),
        input: hexOfJson({ method: entry.method ?? null, input: entry.input ?? null }),
        output: entry.status === "success" ? hexOfJson(entry.result) : "0x", error: frameError(entry),
      });
      stack.length = Math.max(1, Math.min(stack.length, entry.depth));
      const parent = stack[stack.length - 1];
      (parent.calls ??= []).push(frame);
      stack.push(frame);
      frames.push({ frame, to: entry.program });
    }

    const valueMoves = trace.length
      ? trace.filter((entry) => toBig(entry.value) > 0n).map((entry) => ({ from: entry.from, to: entry.program, value: toBig(entry.value) }))
      : toBig(receipt.value) > 0n ? [{ from: root.from, to: root.to, value: toBig(receipt.value) }] : [];
    for (const move of nativeMoves(receipt, block, valueMoves)) {
      const owner = [...frames].reverse().find((item) => String(item.to).toLowerCase() === move.from)?.frame ?? root;
      (owner.calls ??= []).push(frameOf({ from: move.from, to: move.to, value: quantity(native(move.value)) }));
    }
    return root;
  }
  const tracerOf = (options = {}) => {
    if (options?.tracer !== "callTracer") fail(EVM_ERROR.SERVER, "only { tracer: \"callTracer\" } is supported");
    return { onlyTopCall: Boolean(options.tracerConfig?.onlyTopCall) };
  };
  const traceTransaction = (hash, options) => {
    const config = tracerOf(options);
    const tx = located(hash);
    if (!tx) fail(EVM_ERROR.SERVER, `transaction ${hash} not found`);
    return callFrame(tx, config);
  };
  const traceBlock = (ref, options) => {
    const config = tracerOf(options);
    const transactions = blockTransactions(blockRef(ref));
    if (!transactions) fail(EVM_ERROR.SERVER, "block not found");
    return transactions.map((tx) => ({ txHash: tx.found.hash, result: callFrame(tx, config) }));
  };

  // ---------- log ----------
  const topicMatch = (filter, topic) => filter === null || filter === undefined
    || (Array.isArray(filter) ? filter.some((t) => String(t).toLowerCase() === topic) : String(filter).toLowerCase() === topic);
  /** might this block's header have logs matching the filter (judged from logsBloom · no bloom = must check) */
  const bloomAllows = (header, addresses, topics) => {
    if (!header?.logsBloom) return true;
    if (addresses && !addresses.some((address) => bloomContains(header.logsBloom, address))) return false;
    return topics.every((t) => t === null || [t].flat().some((topic) => bloomContains(header.logsBloom, topic)));
  };
  /**
   * block numbers with logs matching the filter from the eventidx: index (usable with topic0 and at least 1 other topic) · unusable → null
   * topic0 → (program, event name, indexed fields) from eventsig:, then look up the value of topic i in field i
   */
  function indexedBlocks(topics, addresses, from, to) {
    const topic0s = topics[0] === null || topics[0] === undefined ? null : [topics[0]].flat();
    const position = topics.findIndex((t, i) => i > 0 && t !== null && t !== undefined);
    if (!topic0s || position < 1) return null;
    const blocks = new Set();
    for (const topic0 of topic0s) {
      for (const { program, name, indexed } of vm.listEventSignatures(topic0)) {
        if (addresses && !addresses.includes(program)) continue;
        const field = indexed?.[position - 1];
        if (!field) continue;
        for (const topic of [topics[position]].flat()) {
          for (const ref of vm.indexedEventRefs({ program, name, field, topic, fromBlock: from, toBlock: to })) blocks.add(decodeDbKey(ref).number);
        }
      }
    }
    return [...blocks].sort((a, b) => a - b);
  }
  function getLogs(filter = {}) {
    let from;
    let to;
    if (filter.blockHash !== undefined) {
      const header = headerByHash(filter.blockHash);
      if (!header) fail(EVM_ERROR.SERVER, "block not found");
      from = to = header.number;
    } else {
      from = blockNumberOf(filter.fromBlock ?? "latest");
      to = Math.min(blockNumberOf(filter.toBlock ?? "latest"), latest());
    }
    if (to - from + 1 > logRange) fail(EVM_ERROR.LIMIT, `query exceeds max block range ${logRange}`);
    const addresses = filter.address === undefined || filter.address === null ? null
      : [filter.address].flat().map((address) => needAddress(address));
    const topics = (Array.isArray(filter.topics) ? filter.topics : []).map((t) => (t === null || t === undefined ? null
      : Array.isArray(t) ? t.map((x) => String(x).toLowerCase()) : String(t).toLowerCase()));
    const first = Math.max(from, 1);
    // index available → replay only blocks with matching events · otherwise walk every block, skipping via the header's logsBloom
    const numbers = indexedBlocks(topics, addresses, first, to) ?? Array.from({ length: Math.max(0, to - first + 1) }, (_, i) => first + i);
    const logs = [];
    for (const number of numbers) {
      const header = headerAt(number);
      if (!header?.txHashes?.length || !bloomAllows(header, addresses, topics)) continue;
      for (const receipt of blockReceipts(number)) {
        for (const log of receipt.logs) {
          if (addresses && !addresses.includes(log.address)) continue;
          if (topics.some((t, i) => !topicMatch(t, log.topics[i]) || (t !== null && log.topics[i] === undefined))) continue;
          logs.push(log);
        }
      }
    }
    return logs;
  }

  // ---------- gas fees (EIP-1559) ----------
  const gasLimitOf = () => vm.maxBlockGas ?? BLOCK_GAS_LIMIT;
  /** tip per gas of every tx in the block (from the tx: index, no replay) → [{ tip, gasUsed }] ascending */
  const tipsOf = (header) => (header?.txHashes ?? []).map((hash) => vm.getTransaction(hash))
    .filter(Boolean).map((tx) => ({ tip: toBig(tx.tip ?? 0), gasUsed: Number(tx.gasUsed ?? 0) }))
    .sort((a, b) => (a.tip === b.tip ? 0 : a.tip < b.tip ? -1 : 1));
  /** suggested tip = median tip over the last TIP_SAMPLE_BLOCKS blocks (no txs = 0) */
  function suggestedTip() {
    const tips = [];
    for (let n = latest(); n > 0 && n > latest() - TIP_SAMPLE_BLOCKS; n -= 1) tips.push(...tipsOf(vm.getBlock(n)).map((item) => item.tip));
    if (!tips.length) return 0n;
    tips.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
    return tips[Math.floor(tips.length / 2)];
  }
  /** geth-style eth_feeHistory(blockCount, newestBlock, rewardPercentiles) (rewards weighted by gas used) */
  function feeHistory(blockCount, newest, percentiles) {
    // blockCount is a quantity ("0x5") or a number
    const asked = typeof blockCount === "string" && /^0x[0-9a-fA-F]+$/.test(blockCount) ? Number.parseInt(blockCount, 16) : Number(toBig(blockCount));
    const count = Math.min(Math.max(asked || 0, 0), FEE_HISTORY_BLOCKS);
    const end = blockNumberOf(newest ?? "latest");
    if (end > latest()) fail(EVM_ERROR.SERVER, "header not found");
    const start = Math.max(end - count + 1, 0);
    const wanted = Array.isArray(percentiles) ? percentiles.map(Number) : null;
    if (wanted && wanted.some((p, i) => !(p >= 0 && p <= 100) || (i > 0 && p < wanted[i - 1]))) fail(EVM_ERROR.PARAMS, "invalid reward percentiles");
    const baseFees = [];
    const ratios = [];
    const rewards = [];
    for (let n = start; n <= end && count > 0; n += 1) {
      const header = headerAt(n);
      baseFees.push(quantity(native(header?.baseFeePerGas ?? vm.minBaseFeeNow())));
      ratios.push(Number(header?.gasUsed ?? 0) / gasLimitOf());
      if (!wanted) continue;
      const tips = tipsOf(header);
      const total = tips.reduce((sum, item) => sum + item.gasUsed, 0);
      rewards.push(wanted.map((p) => {
        if (!tips.length) return "0x0";
        const threshold = (total * p) / 100;
        let sum = 0;
        for (const item of tips) {
          sum += item.gasUsed;
          if (sum >= threshold) return quantity(native(item.tip));
        }
        return quantity(native(tips.at(-1).tip));
      }));
    }
    // last slot = base fee of the block after newest
    if (count > 0) baseFees.push(quantity(native(end >= latest() ? vm.currentBaseFee() : headerAt(end + 1)?.baseFeePerGas ?? vm.minBaseFeeNow())));
    return { oldestBlock: quantity(count > 0 ? start : end), baseFeePerGas: baseFees, gasUsedRatio: ratios, ...(wanted ? { reward: rewards } : {}) };
  }

  // ---------- account ----------
  const balance = (address, tag) => {
    const account = needAddress(address);
    const at = stateBlock(tag);
    if (at === null) return quantity(native(vm.nativeBalanceOf(account).balance));
    const [received, sended, consumed] = [NATIVE_FIELD.RECEIVED, NATIVE_FIELD.SENDED, NATIVE_FIELD.CONSUMED]
      .map((field) => toBig(readAt(at, nativeKey(account, field)) ?? 0));
    return quantity(native(received - sended - consumed));
  };
  const nonce = (address, tag) => {
    const account = needAddress(address);
    if (tag === "pending" && mempool?.nextNonce) return quantity(mempool.nextNonce(account));
    const at = stateBlock(tag);
    if (at === null) return quantity(vm.checkTransaction({ from: account, nonce: -1 }).expectedNonce ?? 0);
    return quantity(readAt(at, nonceKey(account)) ?? 0);
  };
  // not bytecode: the program's JS source as UTF-8 hex (Blockscout shows hex · decode it per docs/blockscout.md) · wallets → 0x
  const code = (address, tag) => {
    const source = readAt(stateBlock(tag), codeKey(needAddress(address)));
    return source === undefined ? "0x" : codeHex(source);
  };

  /** eth_call: only ERC-20 / ERC-721 / ERC-1155 read functions on standard programs · runs on the state at the requested block */
  function call(request = {}, tag) {
    const to = needAddress(request.to);
    const at = stateBlock(tag);
    const data = String(request.data ?? request.input ?? "0x").toLowerCase();
    const arg = (i) => `0x${data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64)}`;
    // from = the caller (the program's context.sender, like msg.sender) · omitted = vm.query's default
    const context = isAddress(request.from) ? { sender: normalizeAddress(request.from), origin: normalizeAddress(request.from) } : undefined;
    const query = (functionName, input = {}) => {
      const result = queryAt(at, to, functionName, input, context);
      if (result.status !== "success") fail(EVM_ERROR.SERVER, `execution reverted: ${result.error?.message ?? functionName}`);
      return result.result;
    };
    const fn = SELECTOR[data.slice(0, 10)];
    const info = fn ? tokenAt(to, at) : null;
    if (!info) return collectionCall(to, at, data, arg, query);
    if (fn === "symbol") return abiString(info.ticker);
    if (fn === "name") return abiString(info.name);
    if (fn === "decimals") return `0x${word(info.decimals)}`;
    if (fn === "totalSupply") return `0x${word(info.totalSupply)}`;
    if (fn === "balanceOf") return `0x${word(query("balanceOf", { who: arg(0) }))}`;
    return `0x${word(query("allowance", { owner: arg(0), spender: arg(1) }))}`;
  }

  /** eth_call for standard NFTs (ERC-721) / multi-tokens (ERC-1155) */
  function collectionCall(to, at, data, arg, query) {
    const kind = collectionAt(to, at);
    const fn = kind === "erc721" ? NFT_SELECTOR[data.slice(0, 10)] : kind === "erc1155" ? MULTITOKEN_SELECTOR[data.slice(0, 10)] : undefined;
    if (!fn) return abiCall(to, at, data, query);
    const uint = (i) => {
      const hex = data.slice(10 + i * 64, 10 + (i + 1) * 64);
      return `${/^[0-9a-f]+$/.test(hex) ? BigInt(`0x${hex}`) : 0n}n`;
    };
    const bool = (value) => `0x${word(value === true ? 1 : 0)}`;
    if (fn === "name" || fn === "symbol") return abiString(query(fn));
    if (fn === "supportsInterface") return bool(query(fn, { interfaceId: `0x${data.slice(10, 18)}` }));
    if (fn === "isApprovedForAll") return bool(query(fn, kind === "erc721" ? { owner: arg(0), operator: arg(1) } : { account: arg(0), operator: arg(1) }));
    if (kind === "erc721") {
      if (fn === "totalSupply") return `0x${word(query(fn))}`;
      if (fn === "balanceOf") return `0x${word(query(fn, { owner: arg(0) }))}`;
      if (fn === "tokenURI") return abiString(query(fn, { tokenId: uint(0) }));
      return `0x${addressWord(query(fn, { tokenId: uint(0) }) ?? ZERO_ADDRESS)}`;   // ownerOf / getApproved
    }
    if (fn === "balanceOf") return `0x${word(query(fn, { account: arg(0), id: uint(1) }))}`;
    if (fn === "totalSupply") return `0x${word(query(fn, { id: uint(0) }))}`;
    return abiString(query(fn, { id: uint(0) }));   // uri
  }

  /** eth_call on programs that declare metadata.abi: selector = keccak("name(type,…)") per toEvmAbi → decode arguments → query → encode the result per outputs */
  function abiCall(to, at, data, query) {
    const abi = resolveAbi((dbKey) => readAt(at, dbKey), to);   // declared ?? bundled program
    const fn = abi ? abiFunctions(abi).get(data.slice(0, 10)) : undefined;
    if (!fn) fail(EVM_ERROR.SERVER, abi ? `execution reverted: no function in metadata.abi matches selector ${data.slice(0, 10)}`
      : "execution reverted: program has no metadata.abi (only ERC-20 / ERC-721 / ERC-1155 reads on standard programs work without one)");
    try { return encodeOutput(fn, query(fn.name, decodeInput(fn, data))); }
    catch (error) {
      if (error instanceof AbiError) fail(EVM_ERROR.SERVER, `execution reverted: ${fn.signature}: ${error.message}`);
      throw error;
    }
  }

  // ---------- writes: eth_sendRawTransaction / eth_estimateGas ----------

  /** calldata a wallet sends to a program → { method, input }: ERC-20 on standard tokens first, then metadata.abi */
  function resolveCall(to, data) {
    const selector = data.slice(0, 10).toLowerCase();
    const word = (i) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
    const address = (i) => `0x${word(i).slice(24)}`;
    const amount = (i) => `${BigInt(`0x${word(i) || "0"}`)}n`;
    const write = TOKEN_WRITE[selector];
    if (write && checkTokenStandard(readAt(null, codeKey(to)) ?? "").ok) {
      if (data.length !== 10 + write.args * 64) throw new RawTxError(`calldata for ${write.method} has the wrong length`);
      if (write.method === "transfer") return { method: "transfer", input: { to: address(0), amount: amount(1) }, token: true };
      if (write.method === "approve") return { method: "approve", input: { spender: address(0), amount: amount(1) }, token: true };
      return { method: "transferFrom", input: { from: address(0), to: address(1), amount: amount(2) }, token: true };
    }
    const abi = resolveAbi((dbKey) => readAt(null, dbKey), to);
    const fn = abi ? abiFunctions(abi).get(selector) : undefined;
    if (!fn) throw new RawTxError(abi ? `no function in metadata.abi matches selector ${selector}` : "this program does not declare metadata.abi (EVM wallets can only call standard tokens / programs with an ABI)");
    try { return { method: fn.name, input: decodeInput(fn, data), fn }; }
    catch (error) { throw error instanceof AbiError ? new RawTxError(`${fn.signature}: ${error.message}`) : error; }
  }

  function sendRawTransaction(raw) {
    if (!submit) fail(EVM_ERROR.SERVER, "eth_sendRawTransaction is not enabled on this node");
    let verified;
    try {
      verified = rawToVerified(decodeRawTransaction(raw), { chainId: vm.chainId, isProgram: (address) => isProgramAt(address), resolveCall });
    } catch (error) {
      if (error instanceof RawTxError) fail(EVM_ERROR.SERVER, error.message);
      throw error;
    }
    const queued = submit(verified);
    if (!queued.ok) fail(EVM_ERROR.SERVER, queued.simulation?.error ?? queued.reason ?? queued.error ?? "transaction rejected", queued.simulation ?? undefined);
    return verified.hash;
  }

  /** chain gas (not EVM gas): native transfer = 21000 as wallets expect · program calls = simulated plus a 25% margin */
  function estimateGas(request = {}) {
    const to = request.to ? needAddress(request.to) : null;
    if (!to) fail(EVM_ERROR.SERVER, "deploying EVM bytecode is not supported");
    if (!isProgramAt(to)) return quantity(TRANSFER_GAS);
    const data = String(request.data ?? request.input ?? "0x");
    let call;
    try { call = resolveCall(to, data); }
    catch (error) { if (error instanceof RawTxError) fail(EVM_ERROR.SERVER, `execution reverted: ${error.message}`); throw error; }
    const from = isAddress(request.from) ? normalizeAddress(request.from) : ZERO_ADDRESS;
    const result = vm.query({ programUuid: to, functionName: call.method, input: call.input, context: { sender: from, origin: from }, value: `${/^0x[0-9a-f]+$/i.test(String(request.value ?? "")) ? BigInt(request.value) : toBig(request.value ?? 0)}n` });
    if (result.status !== "success") fail(EVM_ERROR.SERVER, `execution reverted: ${result.error?.message ?? call.method}`);
    // vm.query isn't a user tx → no per-tx base cost (gas.tx) · added here per the next block's table
    return quantity(Math.ceil(Number(result.gasUsed ?? 0) * 1.25) + 1000 + (vm.gasAt?.().tx ?? 0));
  }


  // ---------- HTTP filters ----------
  const filters = new Map();   // id → { kind: "logs" | "blocks" | "pending", client, touched, last, criteria?, hashes? }
  const exactBlock = (tag) => (tag === "earliest" ? 0 : typeof tag === "string" && /^0x[0-9a-fA-F]+$/.test(tag) ? Number.parseInt(tag, 16) : null);
  function pruneFilters() {
    const cutoff = now() - filterTtlMs;
    for (const [id, filter] of filters) if (filter.touched < cutoff) filters.delete(id);
  }
  function installFilter(kind, fields, client) {
    pruneFilters();
    if (filters.size >= maxFilters) fail(EVM_ERROR.LIMIT, "too many filters on this node, try again later");
    if (client !== undefined && client !== null) {
      let count = 0;
      for (const filter of filters.values()) if (filter.client === client) count += 1;
      if (count >= maxFiltersPerClient) fail(EVM_ERROR.LIMIT, `too many filters (max ${maxFiltersPerClient} per client): call eth_uninstallFilter on unused ones`);
    }
    const id = `0x${crypto.randomBytes(16).toString("hex")}`;
    filters.set(id, { kind, client: client ?? null, touched: now(), ...fields });
    return id;
  }
  function filterOf(id) {
    pruneFilters();
    const filter = typeof id === "string" ? filters.get(id.toLowerCase()) : undefined;
    if (!filter) fail(EVM_ERROR.SERVER, "filter not found");
    filter.touched = now();
    return filter;
  }
  function newFilter(criteria = {}, client) {
    if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) fail(EVM_ERROR.PARAMS, "filter must be an object");
    if (criteria.blockHash !== undefined) fail(EVM_ERROR.PARAMS, "blockHash is not supported in eth_newFilter (use eth_getLogs)");
    const { address, topics } = criteria;
    getLogs({ address, topics, fromBlock: "latest", toBlock: "latest" });   // bad address / topics → error at creation time
    const from = exactBlock(criteria.fromBlock);
    // new = blocks after the filter was created (or from fromBlock if it's in the future) · older ones via eth_getFilterLogs
    const last = Math.max(latest(), from === null ? 0 : from - 1);
    return installFilter("logs", { last, criteria: { address, topics, fromBlock: criteria.fromBlock, toBlock: criteria.toBlock } }, client);
  }
  function filterChanges(id) {
    const filter = filterOf(id);
    if (filter.kind === "pending") return filter.hashes.splice(0);
    const head = latest();
    const end = filter.kind === "logs" ? Math.min(head, exactBlock(filter.criteria.toBlock) ?? head) : head;
    const start = filter.last + 1;
    if (start > end) { filter.last = Math.max(filter.last, Math.min(head, end)); return []; }
    const stop = Math.min(end, start + logRange - 1);   // more than logRange behind → send in chunks, continue next time
    filter.last = stop;
    if (filter.kind === "blocks") return Array.from({ length: stop - start + 1 }, (_, i) => headerAt(start + i)?.hash).filter(Boolean);
    const { address, topics } = filter.criteria;
    return getLogs({ address, topics, fromBlock: quantity(start), toBlock: quantity(stop) });
  }
  function filterLogs(id) {
    const filter = filterOf(id);
    if (filter.kind !== "logs") fail(EVM_ERROR.SERVER, "filter not found");
    return getLogs(filter.criteria);
  }
  const pendingListeners = new Set();
  mempool?.onAdded?.((hash) => {
    for (const filter of filters.values()) {
      if (filter.kind !== "pending") continue;
      filter.hashes.push(hash);
      if (filter.hashes.length > PENDING_BUFFER) filter.hashes.splice(0, filter.hashes.length - PENDING_BUFFER);
    }
    for (const listener of pendingListeners) {
      try { listener(hash); } catch (error) { console.error(error); }
    }
  });

  // ---------- eth_simulateV1 ----------
  const valueOf = (value) => (value === undefined || value === null ? 0n
    : typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : toBig(value));
  const feeOf = (field) => (field === undefined || field === null ? undefined : String(valueOf(field)));
  function simulateCall(preview, request, index) {
    const from = isAddress(request?.from) ? normalizeAddress(request.from) : ZERO_ADDRESS;
    const to = request?.to === undefined || request?.to === null ? null : needAddress(request.to);
    if (to === null) return { error: "deploying EVM bytecode is not supported" };
    const data = String(request.data ?? request.input ?? "0x");
    const program = isProgramAt(to);
    if (!program && data !== "0x") return { error: "data sent to an address that is not a program" };
    if (program && data === "0x") return { error: "program has no plain receive function (call a function from metadata.abi)" };
    const fees = request.maxFeePerGas !== undefined || request.maxPriorityFeePerGas !== undefined
      ? { maxFeePerGas: feeOf(request.maxFeePerGas), maxPriorityFeePerGas: feeOf(request.maxPriorityFeePerGas) ?? "0" }
      : { gasPrice: feeOf(request.gasPrice) };
    const gasLimit = request.gas === undefined ? undefined : Number(valueOf(request.gas)) || undefined;
    const value = `${valueOf(request.value)}n`;
    const nonce = preview.checkTransaction({ from, nonce: -1 }).expectedNonce ?? 0;
    const common = { nonce, gasLimit, ...fees };
    if (!program) return { result: preview.transfer({ from, to, amount: value, ...common }) };
    let resolved;
    try { resolved = resolveCall(to, data); }
    catch (error) { if (error instanceof RawTxError) return { error: error.message }; throw error; }
    const result = preview.call({ programUuid: to, functionName: resolved.method, input: resolved.input, value, context: { sender: from, origin: from }, ...common });
    return { result, resolved, index };
  }
  function simulateV1(payload, tag) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.blockStateCalls)) fail(EVM_ERROR.PARAMS, "blockStateCalls must be an array");
    if (tag !== undefined && tag !== "latest" && tag !== "pending" && blockNumberOf(tag) !== latest()) fail(EVM_ERROR.PARAMS, "eth_simulateV1 runs on the latest block only");
    if (payload.blockStateCalls.length !== 1) fail(EVM_ERROR.PARAMS, "only 1 blockStateCalls entry is supported");
    const [{ calls = [], stateOverrides, blockOverrides } = {}] = payload.blockStateCalls;
    if (stateOverrides && Object.keys(stateOverrides).length) fail(EVM_ERROR.PARAMS, "stateOverrides is not supported");
    if (blockOverrides && Object.keys(blockOverrides).length) fail(EVM_ERROR.PARAMS, "blockOverrides is not supported");
    if (!Array.isArray(calls) || calls.length > SIMULATE_MAX_CALLS) fail(EVM_ERROR.PARAMS, `calls must be an array of at most ${SIMULATE_MAX_CALLS}`);
    const parent = headerAt(latest());
    const number = latest() + 1;
    const timestamp = Math.max(now(), (parent?.timestamp ?? 0) + 1);
    const preview = vm.createBlock({ timestamp, feeRecipient: ZERO_ADDRESS, number, checkChain: false, recordBlocks: false, recordHistory: false });
    const blockHash = ZERO_HASH;   // the simulated block has no real hash
    let logIndex = 0;
    let gasUsed = 0;
    const results = calls.map((request, index) => {
      const ran = simulateCall(preview, request ?? {}, index);
      const base = { blockHash, blockNumber: quantity(number), transactionHash: ZERO_HASH, transactionIndex: quantity(index) };
      if (ran.error) return { status: "0x0", returnData: "0x", gasUsed: "0x0", logs: [], error: { code: EVM_ERROR.SERVER, message: ran.error } };
      const { result, resolved } = ran;
      gasUsed += Number(result.gasUsed ?? 0);
      if (result.status !== "success") {
        return { status: "0x0", returnData: "0x", gasUsed: quantity(result.gasUsed ?? 0), logs: [],
          error: { code: 3, message: `execution reverted: ${result.error?.message ?? result.status}` } };
      }
      const logs = (result.events ?? []).map((event) => formatLog(event, logIndex++, base));
      let returnData = "0x";
      if (resolved?.token) returnData = `0x${word(1)}`;   // ERC-20 transfer / approve / transferFrom → true
      else if (resolved?.fn?.outputs?.length) {
        try { returnData = encodeOutput(resolved.fn, result.result); } catch (error) { if (!(error instanceof AbiError)) throw error; }
      }
      return { status: "0x1", returnData, gasUsed: quantity(result.gasUsed ?? 0), logs };
    });
    return [{
      number: quantity(number), hash: blockHash, parentHash: parent?.hash ?? ZERO_HASH,
      timestamp: quantity(Math.floor(timestamp / 1000)), gasLimit: quantity(gasLimitOf()), gasUsed: quantity(gasUsed),
      baseFeePerGas: quantity(native(preview.baseFee)), miner: ZERO_ADDRESS, logsBloom: bloomOf(results.flatMap((r) => r.logs)),
      transactions: [], uncles: [], calls: results,
    }];
  }

  // ---------- txpool ----------
  const pendingItems = () => mempool?.list?.() ?? [];
  const txpoolContent = () => {
    const pending = {};
    for (const item of pendingItems()) (pending[item.sender] ??= {})[String(item.nonce ?? 0)] = pendingTransaction(item);
    return { pending, queued: {} };
  };
  const txpoolInspect = () => {
    const pending = {};
    for (const item of pendingItems()) {
      (pending[item.sender] ??= {})[String(item.nonce ?? 0)] = `${item.action ?? "tx"}: 0 wei + 0 gas × ${native(item.maxFeePerGas ?? item.gasPrice ?? vm.gas.price)} wei`;
    }
    return { pending, queued: {} };
  };

  const METHODS = {
    web3_clientVersion: () => clientVersion,
    web3_sha3: ([data]) => `0x${bytesToHex(keccak_256(Buffer.from(String(data ?? "0x").replace(/^0x/, ""), "hex")))}`,
    net_version: () => String(vm.chainId),
    net_listening: () => true,
    net_peerCount: () => "0x0",
    eth_chainId: () => quantity(vm.chainId),
    eth_syncing: () => false,
    eth_mining: () => false,
    eth_hashrate: () => "0x0",
    eth_accounts: () => [],
    eth_coinbase: () => ZERO_ADDRESS,
    eth_blockNumber: () => quantity(latest()),
    eth_gasPrice: () => quantity(native(vm.currentBaseFee() + suggestedTip())),   // next block's base fee + suggested tip
    eth_maxPriorityFeePerGas: () => quantity(native(suggestedTip())),
    eth_feeHistory: ([blockCount, newest, percentiles]) => feeHistory(blockCount, newest, percentiles),
    cardianal_getAbi: ([address]) => {
      const abi = resolveAbi((dbKey) => vm.read(dbKey), needAddress(address));
      return abi ? toEvmAbi(abi) : null;
    },
    cardianal_getProof: ([keys]) => {
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > 100) fail(EVM_ERROR.PARAMS, "keys must be an array of 1-100 items");
      const dbKeys = keys.map((item) => {
        if (typeof item === "string" && item) return item;
        if (item && typeof item === "object" && typeof item.program === "string") {
          return storageKey(normalizeAddress(item.program), Array.isArray(item.key) ? map(...item.key) : item.key);
        }
        return fail(EVM_ERROR.PARAMS, "key must be a dbKey string or { program, key }");
      });
      return vm.getProof(dbKeys);
    },
    eth_getProof: () => fail(EVM_ERROR.METHOD, "eth_getProof is not supported: state is not an EVM account trie — use cardianal_getProof([dbKey | { program, key }])"),
    eth_getBalance: ([address, tag]) => balance(address, tag),
    eth_getTransactionCount: ([address, tag]) => nonce(address, tag),
    eth_getCode: ([address, tag]) => code(address, tag),
    eth_getBlockByNumber: ([tag, full]) => blockByNumber(tag, full),
    eth_getBlockByHash: ([hash, full]) => blockByHash(hash, full),
    eth_getBlockTransactionCountByNumber: ([tag]) => { const b = headerAt(blockNumberOf(tag)); return b ? quantity(evmHashes(b).length) : null; },
    eth_getBlockTransactionCountByHash: ([hash]) => { const b = headerByHash(hash); return b ? quantity(evmHashes(b).length) : null; },
    eth_getBlockReceipts: ([ref]) => blockReceipts(blockRef(ref)),
    eth_getUncleCountByBlockNumber: () => "0x0",
    eth_getUncleCountByBlockHash: () => "0x0",
    eth_getTransactionByHash: ([hash]) => transactionByHash(hash),
    eth_getTransactionByBlockNumberAndIndex: ([tag, index]) => transactionAt(blockNumberOf(tag), index),
    eth_getTransactionByBlockHashAndIndex: ([hash, index]) => transactionAt(headerByHash(hash)?.number ?? null, index),
    eth_getTransactionReceipt: ([hash]) => transactionReceipt(hash),
    eth_getLogs: ([filter]) => getLogs(filter),
    eth_call: ([request, tag]) => call(request, tag),
    eth_estimateGas: ([request = {}]) => estimateGas(request),
    eth_sendRawTransaction: ([raw]) => sendRawTransaction(raw),
    eth_sendTransaction: () => fail(EVM_ERROR.SERVER, "eth_sendTransaction is not supported"),
    debug_traceTransaction: ([hash, options]) => traceTransaction(hash, options),
    debug_traceBlockByNumber: ([tag, options]) => traceBlock(tag, options),
    debug_traceBlockByHash: ([hash, options]) => traceBlock(hash, options),
    txpool_content: () => txpoolContent(),
    txpool_inspect: () => txpoolInspect(),
    txpool_status: () => ({ pending: quantity(pendingItems().length), queued: "0x0" }),
    eth_newFilter: ([criteria], client) => newFilter(criteria, client),
    eth_newBlockFilter: (_, client) => installFilter("blocks", { last: latest() }, client),
    eth_newPendingTransactionFilter: (_, client) => installFilter("pending", { hashes: [] }, client),
    eth_getFilterChanges: ([id]) => filterChanges(id),
    eth_getFilterLogs: ([id]) => filterLogs(id),
    eth_uninstallFilter: ([id]) => typeof id === "string" && filters.delete(id.toLowerCase()),
    eth_createAccessList: ([request = {}]) => ({ accessList: [], gasUsed: estimateGas(request) }),
    eth_simulateV1: ([payload, tag]) => simulateV1(payload, tag),
  };

  function one(message, client) {
    const id = message?.id ?? null;
    try {
      if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
        fail(EVM_ERROR.REQUEST, "invalid request");
      }
      const method = METHODS[message.method];
      if (!method) fail(EVM_ERROR.METHOD, `method not supported: ${message.method}`);
      const params = message.params === undefined ? [] : message.params;
      if (!Array.isArray(params)) fail(EVM_ERROR.PARAMS, "params must be an array");
      return { jsonrpc: "2.0", id, result: method(params, client) ?? null };
    } catch (error) {
      const known = error instanceof RpcError;
      return { jsonrpc: "2.0", id, error: { code: known ? error.code : EVM_ERROR.INTERNAL, message: error.message,
        ...(known && error.data !== undefined && { data: error.data }) } };
    }
  }

  return {
    methods: Object.keys(METHODS),
    /** takes a parsed body (object or batch array) → JSON-RPC response · client = the caller's IP (for filter quotas) */
    handle(body, { client } = {}) {
      if (Array.isArray(body)) {
        if (body.length === 0) return { jsonrpc: "2.0", id: null, error: { code: EVM_ERROR.REQUEST, message: "empty batch" } };
        return body.map((message) => one(message, client));
      }
      return one(body, client);
    },
    /** listener(hash) whenever a tx enters the mempool (ws newPendingTransactions) · returns an unsubscribe function */
    onPendingTransaction(listener) {
      pendingListeners.add(listener);
      return () => pendingListeners.delete(listener);
    },
    /** number of unexpired filters */
    filterCount() { pruneFilters(); return filters.size; },
    /** values ready to pass to wallet_addEthereumChain */
    chainParams({ rpcUrl, explorerUrl, name = "Bluewolfchain", symbol = "BWSC" } = {}) {
      return {
        chainId: quantity(vm.chainId), chainName: name,
        nativeCurrency: { name, symbol, decimals: 18 },   // MetaMask requires 18 · the chain already uses wei
        rpcUrls: rpcUrl ? [rpcUrl] : [], blockExplorerUrls: explorerUrl ? [explorerUrl] : [],
      };
    },
  };
}

export const parseError = () => ({ jsonrpc: "2.0", id: null, error: { code: EVM_ERROR.PARSE, message: "parse error" } });
