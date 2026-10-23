/**
 * ตัวแปลง JSON-RPC แบบ EVM (POST /evm) — อ่านข้อมูลเชนเดิมแล้วตอบในรูปแบบที่ MetaMask / ethers / viem เข้าใจ
 *
 *   const rpc = createEvmRpc({ vm, mempool });
 *   rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })   // → { jsonrpc, id, result: "0x1" }
 *
 * อ่านอย่างเดียว: ไม่เขียน DB ไม่แตะ mempool ไม่เปลี่ยนกฎของเชน
 *   - ส่ง tx ผ่าน MetaMask ไม่ได้ (eth_sendRawTransaction) เพราะเชนรับเฉพาะลายเซ็น EIP-712 ของตัวเอง → ตอบ error
 *   - native ของเชนเป็นหน่วยย่อย 18 ทศนิยมแบบ wei อยู่แล้ว → ส่งตรง ๆ (decimals = ทศนิยมที่ต้องเติมเพิ่ม ค่าเริ่มต้น 0)
 *   - token มาตรฐาน (src/standards/token.js) ตอบ eth_call แบบ ERC-20 ได้ (balanceOf / decimals / symbol / name / totalSupply / allowance)
 *   - NFT / multi-token มาตรฐาน (src/standards/nft.js / multitoken.js) emit แบบ indexed → log แบบ ERC-721 (tokenId เป็น topic ที่ 4) / ERC-1155
 *   - event → log ด้วย eventLog() ของ VM (ค่าเดียวกับที่ใช้ทำ logsBloom / receiptsRoot ใน header):
 *       emit แบบ indexed → topic0 = keccak("ชื่อ(ชนิด,…)") + topic ของ field ที่ indexed (Transfer ของ token มาตรฐาน = log แบบ ERC-20)
 *       ไม่มี indexed → topic0 = keccak(ชื่อ), data = JSON เป็น hex
 *   - EIP-1559: baseFeePerGas ใน block · eth_feeHistory · eth_maxPriorityFeePerGas · eth_gasPrice = base fee ถัดไป + tip ที่แนะนำ
 *     tx แบบ 1559 → type 0x2 + maxFeePerGas / maxPriorityFeePerGas · receipt มี effectiveGasPrice
 *   - eth_getLogs: ข้าม block ด้วย logsBloom ของ header · มี topic0 + topic อื่น → ใช้ดัชนี eventidx: replay เฉพาะ block ที่ตรง
 *   - cardianal_getAbi(address) → metadata.abi ของโปรแกรมแปลงเป็น JSON ABI แบบ Ethereum (null = ไม่ได้ประกาศ)
 *     eth_call ของทั้งสองแบบ: name / symbol / balanceOf / ownerOf / tokenURI / getApproved / uri / isApprovedForAll / supportsInterface
 *   - ยอด / nonce / code / eth_call ตามเลข block อ่านจาก history ของเชน (vm.stateAt) · ต้องเปิด recordHistory
 *   - debug_trace* (callTracer) แปลงจาก trace + nativeChanges ของการ replay block · ผล replay เก็บ cache ไว้ต่อ block
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { NATIVE_FIELD, codeKey, nativeKey, nonceKey, normalizeAddress, metadataKey, eventLog, logsBloom, bloomContains, toEvmAbi, decodeDbKey } from "../core/virtualmachine.js";
import { checkTokenStandard, unescapeCode } from "../standards/token.js";
import { checkNftStandard } from "../standards/nft.js";
import { checkMultiTokenStandard } from "../standards/multitoken.js";

export const EVM_ERROR = { PARSE: -32700, REQUEST: -32600, METHOD: -32601, PARAMS: -32602, INTERNAL: -32603, SERVER: -32000, LIMIT: -32005 };

const ZERO_HASH = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const EMPTY_BLOOM = `0x${"0".repeat(512)}`;
const EMPTY_UNCLES = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";   // keccak(rlp([]))
const BLOCK_GAS_LIMIT = 30_000_000;   // ใช้เมื่อเชนไม่ได้ตั้ง maxBlockGas
const REPLAY_CACHE = 64;              // จำนวน block ที่เก็บผล replay ไว้
const LOG_RANGE = 1000;               // ช่วง block สูงสุดของ eth_getLogs
const TRANSFER_GAS = 21_000;   // gas ที่ MetaMask ตั้งให้การโอนธรรมดา (ใช้ตอบ eth_estimateGas เท่านั้น)

const SELECTOR = {   // ERC-20 ที่ token มาตรฐานตอบได้
  "0x70a08231": "balanceOf", "0x313ce567": "decimals", "0x95d89b41": "symbol",
  "0x06fdde03": "name", "0x18160ddd": "totalSupply", "0xdd62ed3e": "allowance",
};
const selectors = (map) => Object.fromEntries(Object.entries(map).map(([signature, fn]) => [keccakHex(signature).slice(0, 10), fn]));
const NFT_SELECTOR = selectors({   // ERC-721 ที่ NFT มาตรฐานตอบได้
  "name()": "name", "symbol()": "symbol", "totalSupply()": "totalSupply", "balanceOf(address)": "balanceOf",
  "ownerOf(uint256)": "ownerOf", "tokenURI(uint256)": "tokenURI", "getApproved(uint256)": "getApproved",
  "isApprovedForAll(address,address)": "isApprovedForAll", "supportsInterface(bytes4)": "supportsInterface",
});
const MULTITOKEN_SELECTOR = selectors({   // ERC-1155 ที่ multi-token มาตรฐานตอบได้
  "name()": "name", "symbol()": "symbol", "balanceOf(address,uint256)": "balanceOf", "uri(uint256)": "uri",
  "totalSupply(uint256)": "totalSupply", "isApprovedForAll(address,address)": "isApprovedForAll", "supportsInterface(bytes4)": "supportsInterface",
});

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const fail = (code, message, data) => { throw new RpcError(code, message, data); };

function keccakHex(text) { return `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`; }
const hexBytes = (hex) => Buffer.from(String(hex).replace(/^0x/, ""), "hex");

const bloomOf = logsBloom;   // แบบเดียวกับ header ของ block (ดู virtualmachine.js)
const FEE_HISTORY_BLOCKS = 1024;   // eth_feeHistory ขอได้สูงสุดกี่ block
const TIP_SAMPLE_BLOCKS = 20;      // tip ที่แนะนำ = มัธยฐานของ tip ใน block ล่าสุดเท่านี้

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
 * @param {{ vm: import("../core/virtualmachine.js").VirtualMachine, mempool?: object, decimals?: number, clientVersion?: string, logRange?: number }} options
 */
export function createEvmRpc({ vm, mempool = null, decimals = 0, clientVersion = "cardianal/evm-adapter", logRange = LOG_RANGE } = {}) {
  const scale = 10n ** BigInt(decimals);
  const native = (value) => toBig(value) * scale;
  const latest = () => vm.latestBlockNumber() ?? 0;

  // ---------- state ณ block ----------
  /** tag → null (ค่าปัจจุบัน) หรือเลข block ที่ต้องย้อนไปอ่าน */
  const stateBlock = (tag) => {
    if (tag === undefined || tag === null || tag === "pending") return null;
    const number = blockNumberOf(tag);
    if (number > latest()) fail(EVM_ERROR.SERVER, "header not found");
    return number >= latest() ? null : number;
  };
  /** ค่าของ key ณ ตอนที่ block นั้นปิด (history ของเชน) · null = ค่าปัจจุบัน */
  const readAt = (at, dbKey) => (at === null ? vm.read(dbKey) : vm.stateAt(at, dbKey));
  const isProgramAt = (address, at = null) => readAt(at, codeKey(address)) !== undefined;
  /** อ่านฟังก์ชันของโปรแกรมบน state ณ block นั้น (ไม่เขียนอะไร) */
  const queryAt = (at, programUuid, functionName, input = {}) => {
    const options = at === null ? {} : { read: (dbKey) => vm.stateAt(at, dbKey), blockNumber: at, timestamp: headerAt(at)?.timestamp || undefined };
    return vm.query({ programUuid, functionName, input }, options);
  };
  /** ข้อมูล token มาตรฐาน ณ block (null = ไม่ใช่ token มาตรฐาน / ยังไม่ได้ deploy) */
  const tokenAt = (address, at = null) => {
    const source = readAt(at, codeKey(address));
    if (source === undefined || !checkTokenStandard(source).ok) return null;
    const read = (fn) => { const r = queryAt(at, address, fn); return r.status === "success" ? r.result : null; };
    return { address, name: read("name"), ticker: read("ticker"), decimals: read("decimals"), totalSupply: read("totalSupply") };
  };
  /** NFT / multi-token มาตรฐาน ณ block → "erc721" | "erc1155" | null (ดูจากโค้ดอย่างเดียว ไม่รันโปรแกรม) */
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
  // genesis ไม่มีเวลา → ใช้เวลาของ block 1 (Blockscout จะได้ไม่แสดงเป็นปี 1970)
  const genesisBlock = () => ({
    number: 0, hash: vm.genesisHash(), parentHash: ZERO_HASH, timestamp: vm.getBlock(1)?.timestamp ?? 0, feeRecipient: ZERO_ADDRESS,
    gasUsed: 0, stateRoot: ZERO_HASH, txRoot: ZERO_HASH, txHashes: [],
  });
  const headerAt = (number) => (number === 0 ? genesisBlock() : vm.getBlock(number));

  // ผล replay ต่อ block (cache ตาม hash: block ที่ปิดแล้วไม่เปลี่ยน) → receipt ทุกใบ + logIndex / gas สะสมทั้ง block
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
   * tx ที่ถูกปฏิเสธที่บันทึกใน block นี้ → แสดงต่อท้าย tx จริงเป็น tx ที่ล้ม (status 0x0, gasUsed 0) ให้ Blockscout เห็น
   * ข้าม hash ที่ภายหลังเข้า block จริงแล้ว หรือถูกปฏิเสธซ้ำใน block หลัง (1 hash = 1 tx ในมุมของ EVM)
   * index ของ EVM = จำนวน tx จริง + ลำดับในรายการนี้
   */
  function rejectedIn(header) {
    if (!header?.rejectedCount) return [];
    const base = header.txHashes?.length ?? 0;
    return vm.getBlockRejected(header.number)
      .filter((entry) => !vm.getTransaction(entry.hash) && vm.getRejectedTransaction(entry.hash)?.blockNumber === header.number)
      .map((entry, i) => ({ ...entry, evmIndex: base + i }));
  }
  /** hash ทุกใบของ block ในมุมของ EVM: tx จริงตามลำดับ แล้วตามด้วย tx ที่ถูกปฏิเสธ */
  const evmHashes = (header) => [...(header?.txHashes ?? []), ...rejectedIn(header).map((entry) => entry.hash)];
  /** tx ที่ถูกปฏิเสธ → { found, receipt, block, logStart, cumulativeGas } แบบเดียวกับ tx จริง (ไม่มี log · gas ไม่เพิ่ม) */
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
    // logsBloom / receiptsRoot มาจาก header (อยู่ใน hash ของ block) · header เก่าที่ไม่มี → คำนวณจาก receipt
    let bloom = header.logsBloom ?? EMPTY_BLOOM;
    if (!header.logsBloom && hashes.length) {
      try { bloom = bloomOf(blockReceipts(number).flatMap((r) => r.logs)); } catch { /* ไม่มี history → bloom ว่าง */ }
    }
    return {
      number: quantity(number), hash: header.hash,
      parentHash: header.parentHash ?? (number === 1 ? vm.genesisHash() : ZERO_HASH),
      nonce: "0x0000000000000000", sha3Uncles: EMPTY_UNCLES, logsBloom: bloom,
      transactionsRoot: header.txRoot ?? ZERO_HASH, stateRoot: header.stateRoot ?? ZERO_HASH, receiptsRoot: header.receiptsRoot ?? ZERO_HASH,
      baseFeePerGas: quantity(native(header.baseFeePerGas ?? vm.minBaseFee ?? vm.gas.price)),
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
  /** tag หรือ hash ของ block (แบบที่ eth_getBlockReceipts / debug_trace* รับ) → เลข block */
  const blockRef = (ref) => (isHash(ref) ? headerByHash(ref)?.number ?? null : blockNumberOf(ref));

  // ---------- tx ----------
  /** ผลของ tx เดิมจากการ replay block (แบบเดียวกับ GET /tx/:hash/receipt) */
  function located(hash) {
    if (!isHash(hash)) fail(EVM_ERROR.PARAMS, `invalid transaction hash: ${hash}`);
    const found = vm.getTransaction(hash.toLowerCase());
    if (!found) {
      // ถูกปฏิเสธ (บันทึกใน block) → tx ที่ล้มแบบ EVM
      const entry = vm.getRejectedTransaction(hash.toLowerCase());
      const header = entry ? headerAt(entry.blockNumber) : null;
      const listed = header ? rejectedIn(header).find((item) => item.hash === entry.hash) : null;
      return listed ? rejectedTx(listed, header, replayed(header.number).offsets) : null;
    }
    const { header, transactions, offsets } = replayed(found.blockNumber);
    return { found, receipt: transactions[found.index], block: header, ...offsets[found.index] };
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
      gas: quantity(receipt.gasLimit ?? receipt.gasUsed ?? 0), gasPrice: quantity(native(receipt.effectiveGasPrice ?? receipt.gasPrice ?? vm.gas.price)),
      input: inputOf({ ...receipt, action: found.action }),
      ...feeFieldsOf(receipt), chainId: quantity(vm.chainId),
      ...signatureParts(vm.transactionSignature(found)),   // ลายเซ็นอยู่ใน blockbody
    };
  }
  /** type ของ tx แบบ EVM: 0x2 (EIP-1559) มี maxFeePerGas / maxPriorityFeePerGas · แบบเดิม 0x0 */
  function feeFieldsOf(receipt) {
    if (receipt.type !== 2) return { type: "0x0" };
    return { type: "0x2", maxFeePerGas: quantity(native(receipt.maxFeePerGas ?? receipt.effectiveGasPrice ?? 0)),
      maxPriorityFeePerGas: quantity(native(receipt.maxPriorityFeePerGas ?? 0)), accessList: [] };
  }
  /** tx ที่ยังรอใน mempool (มีแค่ข้อมูลที่ mempool.list() ให้) */
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
   * event ของเชน → log แบบ EVM (logIndex นับต่อเนื่องทั้ง block)
   * topics / data มาจาก eventLog ของ VM = ค่าเดียวกับที่ใช้ทำ logsBloom / receiptsRoot ของ header
   * โปรแกรมมาตรฐาน (token / NFT / multi-token) emit แบบ indexed → log แบบ ERC-20 / ERC-721 / ERC-1155 ตรงตัว
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
  /** ทุก tx ของ block จาก replay ครั้งเดียว: { found, receipt, block, logStart, cumulativeGas } */
  function blockTransactions(number) {
    const data = number === null ? null : replayed(number);
    if (!data) return null;
    const real = (data.header.txHashes ?? []).map((hash, index) => {
      const receipt = data.transactions[index];
      const found = { hash, blockNumber: number, index, action: receipt.action, from: receipt.from };
      return { found, receipt, block: data.header, ...data.offsets[index] };
    });
    return [...real, ...rejectedIn(data.header).map((entry) => rejectedTx(entry, data.header, data.offsets))];
  }
  const blockReceipts = (number) => blockTransactions(number)?.map(formatReceipt) ?? null;

  // ---------- internal tx (debug_trace* แบบ callTracer ของ geth) ----------
  const frameError = (entry) => (entry?.status && entry.status !== "success" ? entry.error?.message ?? entry.status : undefined);
  const frameOf = (fields) => {
    const frame = { type: "CALL", gas: "0x0", gasUsed: "0x0", input: "0x", output: "0x", value: "0x0", ...fields };
    for (const key of Object.keys(frame)) if (frame[key] === undefined) delete frame[key];
    return frame;
  };
  const codeHex = (source) => `0x${bytesToHex(utf8ToBytes(unescapeCode(source ?? "")))}`;

  /**
   * native ที่โปรแกรมโอนด้วย transferNative ไม่อยู่ใน trace → หาจาก nativeChanges
   * ตัด value ของทุกชั้นใน trace และค่าธรรมเนียม (consumed → address ศูนย์ / feeRecipient) ออกก่อน ที่เหลือจับคู่ผู้ส่ง → ผู้รับ
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

    // trace เรียงแบบ pre-order (depth 0 = ชั้นนอกสุด) → ซ้อนเป็น calls[]
    const frames = [{ frame: root, to: root.to }];
    const stack = [root];
    for (const entry of trace) {
      if (entry.depth === 0) continue;
      const frame = frameOf({
        // cloneProgram = สร้างโปรแกรมใหม่ระหว่างทาง · runProgram แบบ { readonly: true } = STATICCALL
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
  /** header ของ block นี้อาจมี log ที่ตรง filter ไหม (ดูจาก logsBloom · ไม่มี bloom = ต้องดู) */
  const bloomAllows = (header, addresses, topics) => {
    if (!header?.logsBloom) return true;
    if (addresses && !addresses.some((address) => bloomContains(header.logsBloom, address))) return false;
    return topics.every((t) => t === null || [t].flat().some((topic) => bloomContains(header.logsBloom, topic)));
  };
  /**
   * เลข block ที่มี log ตรงเงื่อนไขจากดัชนี eventidx: (ใช้ได้เมื่อมี topic0 และ topic ตำแหน่งอื่นอย่างน้อย 1 ตัว) · ใช้ไม่ได้ → null
   * topic0 → (โปรแกรม, ชื่อ event, field ที่ indexed) จาก eventsig: แล้วค้นค่าของ topic ตำแหน่ง i ใน field ที่ i
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
    // มีดัชนีให้ใช้ → replay เฉพาะ block ที่มี event ตรง · ไม่งั้นไล่ทุก block แต่ข้ามด้วย logsBloom ของ header
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

  // ---------- ค่าแก๊ส (EIP-1559) ----------
  const gasLimitOf = () => vm.maxBlockGas ?? BLOCK_GAS_LIMIT;
  /** tip ต่อแก๊สของทุก tx ใน block (จากดัชนี tx: ไม่ต้อง replay) → [{ tip, gasUsed }] เรียงจากน้อยไปมาก */
  const tipsOf = (header) => (header?.txHashes ?? []).map((hash) => vm.getTransaction(hash))
    .filter(Boolean).map((tx) => ({ tip: toBig(tx.tip ?? 0), gasUsed: Number(tx.gasUsed ?? 0) }))
    .sort((a, b) => (a.tip === b.tip ? 0 : a.tip < b.tip ? -1 : 1));
  /** tip ที่แนะนำ = มัธยฐานของ tip ใน TIP_SAMPLE_BLOCKS block ล่าสุด (ไม่มี tx = 0) */
  function suggestedTip() {
    const tips = [];
    for (let n = latest(); n > 0 && n > latest() - TIP_SAMPLE_BLOCKS; n -= 1) tips.push(...tipsOf(vm.getBlock(n)).map((item) => item.tip));
    if (!tips.length) return 0n;
    tips.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
    return tips[Math.floor(tips.length / 2)];
  }
  /** eth_feeHistory(blockCount, newestBlock, rewardPercentiles) แบบ geth (reward ถ่วงด้วยแก๊สที่ใช้) */
  function feeHistory(blockCount, newest, percentiles) {
    // blockCount เป็น quantity ("0x5") หรือตัวเลข
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
      baseFees.push(quantity(native(header?.baseFeePerGas ?? vm.minBaseFee)));
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
    // ช่องสุดท้าย = base fee ของ block ถัดจาก newest
    if (count > 0) baseFees.push(quantity(native(end >= latest() ? vm.currentBaseFee() : headerAt(end + 1)?.baseFeePerGas ?? vm.minBaseFee)));
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
  // ไม่ใช่ bytecode: ซอร์ส JS ของโปรแกรมเป็น UTF-8 hex (Blockscout กดดูแบบ UTF-8 ได้) · กระเป๋า → 0x
  const code = (address, tag) => {
    const source = readAt(stateBlock(tag), codeKey(needAddress(address)));
    return source === undefined ? "0x" : codeHex(source);
  };

  /** eth_call: เฉพาะฟังก์ชันอ่านของ ERC-20 / ERC-721 / ERC-1155 บนโปรแกรมมาตรฐาน · รันบน state ณ block ที่ขอ */
  function call(request = {}, tag) {
    const to = needAddress(request.to);
    const at = stateBlock(tag);
    const data = String(request.data ?? request.input ?? "0x").toLowerCase();
    const arg = (i) => `0x${data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64)}`;
    const query = (functionName, input = {}) => {
      const result = queryAt(at, to, functionName, input);
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

  /** eth_call ของ NFT (ERC-721) / multi-token (ERC-1155) มาตรฐาน */
  function collectionCall(to, at, data, arg, query) {
    const kind = collectionAt(to, at);
    const fn = kind === "erc721" ? NFT_SELECTOR[data.slice(0, 10)] : kind === "erc1155" ? MULTITOKEN_SELECTOR[data.slice(0, 10)] : undefined;
    if (!fn) fail(EVM_ERROR.SERVER, "execution reverted: only ERC-20 / ERC-721 / ERC-1155 reads on standard programs are supported");
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
    eth_gasPrice: () => quantity(native(vm.currentBaseFee() + suggestedTip())),   // base fee ของ block ถัดไป + tip ที่แนะนำ
    eth_maxPriorityFeePerGas: () => quantity(native(suggestedTip())),
    eth_feeHistory: ([blockCount, newest, percentiles]) => feeHistory(blockCount, newest, percentiles),
    cardianal_getAbi: ([address]) => {
      const abi = vm.read(metadataKey(needAddress(address), "abi"));
      return abi ? toEvmAbi(abi) : null;
    },
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
    eth_estimateGas: ([request = {}]) => {
      if (request.to && isProgramAt(needAddress(request.to))) fail(EVM_ERROR.SERVER, "calling programs from EVM wallets is not supported");
      return quantity(TRANSFER_GAS);
    },
    eth_sendRawTransaction: () => fail(EVM_ERROR.SERVER,
      "this chain only accepts its own EIP-712 signed transactions — send from the chain's explorer instead"),
    eth_sendTransaction: () => fail(EVM_ERROR.SERVER, "eth_sendTransaction is not supported"),
    debug_traceTransaction: ([hash, options]) => traceTransaction(hash, options),
    debug_traceBlockByNumber: ([tag, options]) => traceBlock(tag, options),
    debug_traceBlockByHash: ([hash, options]) => traceBlock(hash, options),
    txpool_content: () => txpoolContent(),
    txpool_inspect: () => txpoolInspect(),
    txpool_status: () => ({ pending: quantity(pendingItems().length), queued: "0x0" }),
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
        nativeCurrency: { name, symbol, decimals: 18 },   // MetaMask บังคับ 18 · เชนเป็น wei อยู่แล้ว
        rpcUrls: rpcUrl ? [rpcUrl] : [], blockExplorerUrls: explorerUrl ? [explorerUrl] : [],
      };
    },
  };
}

export const parseError = () => ({ jsonrpc: "2.0", id: null, error: { code: EVM_ERROR.PARSE, message: "parse error" } });
