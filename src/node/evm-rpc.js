/**
 * ตัวแปลง JSON-RPC แบบ EVM (POST /evm) — อ่านข้อมูลเชนเดิมแล้วตอบในรูปแบบที่ MetaMask / ethers / viem เข้าใจ
 *
 *   const rpc = createEvmRpc({ vm, mempool });
 *   rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })   // → { jsonrpc, id, result: "0x1" }
 *
 * อ่านอย่างเดียว: ไม่เขียน DB ไม่แตะ mempool ไม่เปลี่ยนกฎของเชน
 *   - ส่ง tx ผ่าน MetaMask ไม่ได้ (eth_sendRawTransaction) เพราะเชนรับเฉพาะลายเซ็น EIP-712 ของตัวเอง → ตอบ error
 *   - native ไม่มีทศนิยม แต่ MetaMask บังคับ 18 ตำแหน่ง → ยอดถูกคูณ 10^decimals (ค่าเริ่มต้น 18: 1 native = 1 เหรียญ)
 *   - token มาตรฐาน (src/standards/token.js) ตอบ eth_call แบบ ERC-20 ได้ (balanceOf / decimals / symbol / name / totalSupply / allowance)
 *   - event Transfer ของ token มาตรฐาน → log แบบ ERC-20 · event อื่น → topic0 = keccak(ชื่อ), data = JSON เป็น hex
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { DEFAULT_GAS, normalizeAddress } from "../core/virtualmachine.js";
import { tokenInfo } from "./explorer-api.js";

export const EVM_ERROR = { PARSE: -32700, REQUEST: -32600, METHOD: -32601, PARAMS: -32602, INTERNAL: -32603, SERVER: -32000 };

const ZERO_HASH = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const EMPTY_BLOOM = `0x${"0".repeat(512)}`;
const EMPTY_UNCLES = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";   // keccak(rlp([]))
const BLOCK_GAS_LIMIT = 30_000_000;
const TRANSFER_GAS = 21_000;   // gas ที่ MetaMask ตั้งให้การโอนธรรมดา (ใช้ตอบ eth_estimateGas เท่านั้น)

const SELECTOR = {   // ERC-20 ที่ token มาตรฐานตอบได้
  "0x70a08231": "balanceOf", "0x313ce567": "decimals", "0x95d89b41": "symbol",
  "0x06fdde03": "name", "0x18160ddd": "totalSupply", "0xdd62ed3e": "allowance",
};
const TRANSFER_TOPIC = keccakHex("Transfer(address,address,uint256)");

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const fail = (code, message, data) => { throw new RpcError(code, message, data); };

function keccakHex(text) { return `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`; }

/** ค่าตัวเลขของเชน (number / "123n" / "123") → bigint */
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
/** ABI: string ตัวเดียว */
const abiString = (text) => {
  const hex = bytesToHex(utf8ToBytes(String(text ?? "")));
  return `0x${word(32)}${word(hex.length / 2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
};
const hexOfJson = (value) => `0x${bytesToHex(utf8ToBytes(JSON.stringify(value ?? null, (k, v) => (typeof v === "bigint" ? `${v}n` : v))))}`;

const isAddress = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isHash = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const needAddress = (value) => (isAddress(value) ? normalizeAddress(value) : fail(EVM_ERROR.PARAMS, `invalid address: ${value}`));

/**
 * @param {{ vm: import("../core/virtualmachine.js").VirtualMachine, mempool?: object, decimals?: number, clientVersion?: string }} options
 */
export function createEvmRpc({ vm, mempool = null, decimals = 18, clientVersion = "cardianal/evm-adapter" } = {}) {
  const scale = 10n ** BigInt(decimals);
  const native = (value) => toBig(value) * scale;
  const latest = () => vm.latestBlockNumber() ?? 0;
  const isProgram = (address) => vm.read(`${address}:code`) !== undefined;

  // ---------- block ----------
  const blockNumberOf = (tag) => {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return latest();
    if (tag === "earliest") return 0;
    if (typeof tag === "string" && /^0x[0-9a-fA-F]+$/.test(tag)) return Number.parseInt(tag, 16);
    if (tag && typeof tag === "object" && tag.blockNumber !== undefined) return blockNumberOf(tag.blockNumber);
    return fail(EVM_ERROR.PARAMS, `invalid block tag: ${JSON.stringify(tag)}`);
  };
  const genesisBlock = () => ({
    number: 0, hash: vm.genesisHash(), parentHash: ZERO_HASH, timestamp: 0, feeRecipient: ZERO_ADDRESS,
    gasUsed: 0, stateRoot: ZERO_HASH, txRoot: ZERO_HASH, txHashes: [],
  });
  const headerAt = (number) => (number === 0 ? genesisBlock() : vm.getBlock(number));

  function formatBlock(header, full) {
    const number = header.number;
    const hashes = header.txHashes ?? [];
    return {
      number: quantity(number), hash: header.hash,
      parentHash: header.parentHash ?? (number === 1 ? vm.genesisHash() : ZERO_HASH),
      nonce: "0x0000000000000000", sha3Uncles: EMPTY_UNCLES, logsBloom: EMPTY_BLOOM,
      transactionsRoot: header.txRoot ?? ZERO_HASH, stateRoot: header.stateRoot ?? ZERO_HASH, receiptsRoot: ZERO_HASH,
      miner: header.feeRecipient ?? ZERO_ADDRESS, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x",
      size: quantity(1000 + hashes.length * 32), gasLimit: quantity(BLOCK_GAS_LIMIT), gasUsed: quantity(header.gasUsed ?? 0),
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
  const blockByHash = (hash, full) => {
    if (!isHash(hash)) fail(EVM_ERROR.PARAMS, `invalid block hash: ${hash}`);
    if (hash.toLowerCase() === String(vm.genesisHash()).toLowerCase()) return formatBlock(genesisBlock(), Boolean(full));
    const header = vm.getBlockByHash(hash.toLowerCase());
    return header ? formatBlock(header, Boolean(full)) : null;
  };

  // ---------- tx ----------
  /** ผลของ tx เดิมจากการ replay block (แบบเดียวกับ GET /tx/:hash/receipt) */
  function located(hash) {
    if (!isHash(hash)) fail(EVM_ERROR.PARAMS, `invalid transaction hash: ${hash}`);
    const found = vm.getTransaction(hash.toLowerCase());
    if (!found) return null;
    const receipt = vm.replayBlock(found.blockNumber).transactions[found.index];
    return { found, receipt, block: vm.getBlock(found.blockNumber) };
  }
  const signatureParts = (signature) => {
    const hex = typeof signature === "string" ? signature.replace(/^0x/, "") : "";
    if (hex.length !== 130) return { v: "0x0", r: "0x0", s: "0x0" };
    return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v: quantity(Number.parseInt(hex.slice(128), 16)) };
  };
  /** to ของ EVM: โปรแกรมที่ถูกเรียก / ผู้รับเงิน · deploy = null */
  const targetOf = (r) => (r.action === "deploy" ? null : r.to ?? (r.action === "call" ? r.programUuid ?? null : null));
  /** input ของ EVM: ข้อมูลที่ส่งไปจริง (method + input) เข้ารหัสเป็น JSON แล้วเป็น hex */
  const inputOf = (r) => (r.action === "transfer" ? "0x" : hexOfJson({ action: r.action, method: r.method ?? null, input: r.input ?? null }));

  function formatTransaction({ found, receipt, block }) {
    return {
      hash: found.hash, nonce: quantity(found.nonce ?? 0),
      blockHash: block?.hash ?? null, blockNumber: quantity(found.blockNumber), transactionIndex: quantity(found.index),
      from: found.from ?? ZERO_ADDRESS, to: targetOf({ ...receipt, action: found.action }),
      value: quantity(native(receipt.value ?? 0)),
      gas: quantity(receipt.gasLimit ?? receipt.gasUsed ?? 0), gasPrice: quantity(native(receipt.gasPrice ?? DEFAULT_GAS.price)),
      input: inputOf({ ...receipt, action: found.action }),
      type: "0x0", chainId: quantity(vm.chainId),
      ...signatureParts(found.record?.signature),
    };
  }
  const transactionByHash = (hash) => {
    const tx = located(hash);
    if (tx) return formatTransaction(tx);
    if (mempool?.has?.(hash)) {
      const item = mempool.list().find((entry) => entry.hash === hash);
      return item ? { hash, nonce: quantity(item.nonce ?? 0), blockHash: null, blockNumber: null, transactionIndex: null,
        from: item.sender ?? null, to: item.to ?? null, value: "0x0", gas: "0x0", gasPrice: quantity(native(DEFAULT_GAS.price)),
        input: "0x", type: "0x0", chainId: quantity(vm.chainId), v: "0x0", r: "0x0", s: "0x0" } : null;
    }
    return null;
  };

  /** event ของเชน → log แบบ EVM */
  function formatLog(event, logIndex, base) {
    const data = event.data ?? {};
    const standardTransfer = event.name === "Transfer" && isAddress(data.from) && isAddress(data.to) && data.amount !== undefined
      && tokenInfo(vm, event.program) !== null;
    return {
      address: event.program ?? ZERO_ADDRESS,
      topics: standardTransfer ? [TRANSFER_TOPIC, `0x${addressWord(data.from)}`, `0x${addressWord(data.to)}`] : [keccakHex(String(event.name))],
      data: standardTransfer ? `0x${word(data.amount)}` : hexOfJson(data),
      logIndex: quantity(logIndex), removed: false, ...base,
    };
  }
  function transactionReceipt(hash) {
    const tx = located(hash);
    if (!tx) return null;
    const { found, receipt, block } = tx;
    const base = { blockHash: block?.hash ?? null, blockNumber: quantity(found.blockNumber), transactionHash: found.hash, transactionIndex: quantity(found.index) };
    // gas สะสมใน block: บวก gasUsed ของ tx ก่อนหน้าใน block เดียวกัน
    const earlier = vm.replayBlock(found.blockNumber).transactions.slice(0, found.index + 1);
    const cumulative = earlier.reduce((sum, t) => sum + Number(t.gasUsed ?? 0), 0);
    return {
      ...base, from: found.from ?? ZERO_ADDRESS, to: targetOf({ ...receipt, action: found.action }),
      cumulativeGasUsed: quantity(cumulative), gasUsed: quantity(receipt.gasUsed ?? 0),
      effectiveGasPrice: quantity(native(receipt.gasPrice ?? DEFAULT_GAS.price)),
      contractAddress: found.action === "deploy" ? receipt.result?.programUuid ?? null : null,
      logs: (receipt.events ?? []).map((event, i) => formatLog(event, i, base)),
      logsBloom: EMPTY_BLOOM, type: "0x0",
      status: receipt.status === "success" ? "0x1" : "0x0",
    };
  }

  // ---------- account ----------
  const balance = (address) => quantity(native(vm.nativeBalanceOf(needAddress(address)).balance));
  const nonce = (address, tag) => {
    const account = needAddress(address);
    if (tag === "pending" && mempool?.nextNonce) return quantity(mempool.nextNonce(account));
    return quantity(vm.checkTransaction({ from: account, nonce: -1 }).expectedNonce ?? 0);
  };
  // ไม่ใช่ bytecode จริง: แค่บอกว่าที่ address นี้มีโปรแกรม (กระเป๋า EVM เช็ก getCode ว่าเป็น contract ไหม)
  const code = (address) => (isProgram(needAddress(address)) ? "0xfe" : "0x");

  /** eth_call: เฉพาะฟังก์ชันอ่านของ ERC-20 บน token มาตรฐาน */
  function call(request = {}) {
    const to = needAddress(request.to);
    const data = String(request.data ?? request.input ?? "0x").toLowerCase();
    const fn = SELECTOR[data.slice(0, 10)];
    const info = isProgram(to) ? tokenInfo(vm, to) : null;
    if (!info || !fn) fail(EVM_ERROR.SERVER, "execution reverted: only ERC-20 reads on standard tokens are supported");
    const arg = (i) => `0x${data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64)}`;
    const query = (functionName, input = {}) => {
      const result = vm.query({ programUuid: to, functionName, input });
      if (result.status !== "success") fail(EVM_ERROR.SERVER, `execution reverted: ${result.error?.message ?? functionName}`);
      return result.result;
    };
    if (fn === "symbol") return abiString(info.ticker);
    if (fn === "name") return abiString(info.name);
    if (fn === "decimals") return `0x${word(info.decimals)}`;
    if (fn === "totalSupply") return `0x${word(info.totalSupply)}`;
    if (fn === "balanceOf") return `0x${word(query("balanceOf", { who: arg(0) }))}`;
    return `0x${word(query("allowance", { owner: arg(0), spender: arg(1) }))}`;
  }

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
    eth_gasPrice: () => quantity(native(DEFAULT_GAS.price)),
    eth_maxPriorityFeePerGas: () => "0x0",
    eth_getBalance: ([address]) => balance(address),
    eth_getTransactionCount: ([address, tag]) => nonce(address, tag),
    eth_getCode: ([address]) => code(address),
    eth_getBlockByNumber: ([tag, full]) => blockByNumber(tag, full),
    eth_getBlockByHash: ([hash, full]) => blockByHash(hash, full),
    eth_getBlockTransactionCountByNumber: ([tag]) => { const b = headerAt(blockNumberOf(tag)); return b ? quantity(b.txHashes?.length ?? 0) : null; },
    eth_getBlockTransactionCountByHash: ([hash]) => { const b = blockByHash(hash, false); return b ? quantity(b.transactions.length) : null; },
    eth_getUncleCountByBlockNumber: () => "0x0",
    eth_getUncleCountByBlockHash: () => "0x0",
    eth_getTransactionByHash: ([hash]) => transactionByHash(hash),
    eth_getTransactionByBlockNumberAndIndex: ([tag, index]) => {
      const hash = headerAt(blockNumberOf(tag))?.txHashes?.[Number.parseInt(index, 16)];
      return hash ? transactionByHash(hash) : null;
    },
    eth_getTransactionReceipt: ([hash]) => transactionReceipt(hash),
    eth_call: ([request]) => call(request),
    eth_estimateGas: ([request = {}]) => {
      if (request.to && isProgram(needAddress(request.to))) fail(EVM_ERROR.SERVER, "calling programs from EVM wallets is not supported");
      return quantity(TRANSFER_GAS);
    },
    eth_sendRawTransaction: () => fail(EVM_ERROR.SERVER,
      "this chain only accepts its own EIP-712 signed transactions — send from the chain's explorer instead"),
    eth_sendTransaction: () => fail(EVM_ERROR.SERVER, "eth_sendTransaction is not supported"),
  };

  function one(message) {
    const id = message?.id ?? null;
    try {
      if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
        fail(EVM_ERROR.REQUEST, "invalid request");
      }
      const method = METHODS[message.method];
      if (!method) fail(EVM_ERROR.METHOD, `method not supported: ${message.method}`);
      const params = message.params === undefined ? [] : message.params;
      if (!Array.isArray(params)) fail(EVM_ERROR.PARAMS, "params must be an array");
      return { jsonrpc: "2.0", id, result: method(params) ?? null };
    } catch (error) {
      const known = error instanceof RpcError;
      return { jsonrpc: "2.0", id, error: { code: known ? error.code : EVM_ERROR.INTERNAL, message: error.message,
        ...(known && error.data !== undefined && { data: error.data }) } };
    }
  }

  return {
    methods: Object.keys(METHODS),
    /** รับ body ที่ parse แล้ว (object หรือ batch array) → คำตอบ JSON-RPC */
    handle(body) {
      if (Array.isArray(body)) {
        if (body.length === 0) return { jsonrpc: "2.0", id: null, error: { code: EVM_ERROR.REQUEST, message: "empty batch" } };
        return body.map(one);
      }
      return one(body);
    },
    /** ค่าที่ใส่ใน wallet_addEthereumChain ได้ทันที */
    chainParams({ rpcUrl, explorerUrl, name = "Cardianal", symbol = "CARD" } = {}) {
      return {
        chainId: quantity(vm.chainId), chainName: name,
        nativeCurrency: { name, symbol, decimals },
        rpcUrls: rpcUrl ? [rpcUrl] : [], blockExplorerUrls: explorerUrl ? [explorerUrl] : [],
      };
    },
  };
}

export const parseError = () => ({ jsonrpc: "2.0", id: null, error: { code: EVM_ERROR.PARSE, message: "parse error" } });
