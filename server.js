/**
 * server จริง — node server.js    (ใช้ node:http ล้วน ไม่มี dependency เพิ่ม)
 *   PORT=3000 DATA=./data PRODUCER_KEY=0x… ADMINS=0x… node server.js      (ช่วงพัฒนา: DEV=1 node server.js หรือ npm run dev)
 *   DEV=1             ช่วงพัฒนา: ไม่บังคับ ADMINS / PRODUCER_KEY (ไม่ตั้ง ADMINS = ใครก็อนุมัติ deploy / upgrade ได้)
 *   GENESIS=genesis.json   ไฟล์ genesis · config ในไฟล์ล็อกค่าที่ทุกเครื่องต้องเหมือนกัน (src/node/genesis.js) — env ตั้งต่างจาก genesis = ไม่ยอมเริ่ม
 *   PRODUCER_KEY=0x…  key ของผู้ผลิต block (เซ็น hash ของทุก block · node ผู้อ่านตรวจกับ config.producers ใน genesis)
 *   MINER=0x…         ผู้รับค่าแก๊สของ block (ค่าเริ่ม = address ของ PRODUCER_KEY)
 *   TIMEOUT_MS=5000   เวลาสูงสุดที่โปรแกรมรันได้ต่อ tx / query (ms) — ตัวกันสุดท้าย ลูปไม่รู้จบหมดแก๊สก่อน
 *   MEMORY_LIMIT_MB=32   หน่วยความจำของ sandbox (QuickJS) ต่อ tx รวมทุกโปรแกรมในสายการเรียก — เกิน = OUT_OF_MEMORY (1–1024)
 *   STACK_LIMIT_KB=256   stack ของ sandbox ต่อ tx (เรียกฟังก์ชันซ้อนลึกเกิน = RangeError ที่ catch ได้) (16–256)
 *   GAS_PRICE=1000000000   base fee ต่ำสุด (wei ต่อแก๊ส · native มี 18 ทศนิยม · ค่าเริ่มต้น 1 gwei) — EIP-1559: base fee ของแต่ละ block ไม่ต่ำกว่านี้
 *   GAS_TARGET=1500000     แก๊สเป้าหมายต่อ block (ค่าเริ่มต้น = maxBlockGas / 2) · ใช้มากกว่า → base fee ขึ้น ใช้น้อยกว่า → ลง
 *   BASE_FEE_DENOMINATOR=8 base fee เปลี่ยนได้ไม่เกิน 1/ค่านี้ ต่อ block (8 = 12.5% แบบ Ethereum)
 *   BURN_PERCENT=100       ส่วนของ base fee ที่เผาทิ้ง (tip เข้าผู้ปิด block เสมอ) — ทุกเครื่องในเครือข่ายต้องตั้งเหมือนกัน
 *   RATE_LIMIT=120    จำนวน POST (/sendtx, /query) ต่อ IP ต่อนาที — 0 = ไม่จำกัด
 *   EVM_RATE_LIMIT=600  จำนวน request ของ /evm ต่อ IP ต่อนาที (นับแยกจาก RATE_LIMIT: กระเป๋า EVM ถามถี่ ไม่ให้ไปกินโควตาของ /sendtx)
 *   EVM_DECIMALS=0    ทศนิยมที่ /evm เติมให้ยอด native (native เป็น wei 18 ทศนิยมอยู่แล้ว จึงเป็น 0)
 *   EVM_NAME=Cardianal EVM_SYMBOL=CARD   ชื่อ / สัญลักษณ์เหรียญใน GET /evm (ค่าสำหรับ wallet_addEthereumChain)
 *   UPGRADE_DELAY_BLOCKS=0   timelock ของการอัปเกรดโปรแกรม: โค้ดใหม่เริ่มใช้ที่ block (ที่อนุมัติ + N) · 0 = ทันที
 *   REJECTED_PER_BLOCK=1000  tx ที่ถูกปฏิเสธ (ผ่านลายเซ็นแต่ไม่ได้รัน) ที่บันทึกลง block ได้ต่อ block (ที่เกินยกไป block ถัดไป)
 *   REPLACED_LOG_MAX=100000  ใบที่ถูกแทนที่ที่จำไว้ (off-chain · มี DATA = เก็บในไฟล์ <DATA>/replaced-tx.jsonl อยู่รอด restart)
 *   REPLACED_LOG_DAYS=30     อายุสูงสุดของบันทึกใบที่ถูกแทนที่
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { VirtualMachine } from "./src/core/virtualmachine.js";
import { reviewProgram } from "./src/core/autoreview.js";
import { DB, MemoryDB, DEFAULT_MAP_SIZE, parseSize } from "./src/storage/db.js";
import { verifyTransaction, addressOf } from "./src/crypto/signature.js";
import { signTypedDataDigest } from "./src/crypto/program-signature.js";
import { resolveSettings, startupProblems } from "./src/node/genesis.js";
import { Mempool } from "./src/node/mempool.js";
import { TxLog } from "./src/node/txlog.js";
import { simulate } from "./src/node/simulate.js";
import { RateLimiter } from "./src/node/ratelimit.js";
import { createEvmRpc, parseError } from "./src/node/evm-rpc.js";
import { attachEvmWebSocket } from "./src/node/evm-ws.js";
import { storageLayout, storageMap, storageGet, programFlags, tokenInfo, tokenHoldings, collectionInfo, nftHoldings,
  pageOf, pageBlocks, pageTransactionsOf, pageTransactionsTo, pageEvents, pageStorageMap, pageHolders,
  programCounts, pagePendingPrograms, pageApprovedPrograms, cursorOf, cursorTransactionsTo, cursorEvents,
  storageGroups, pageRejected, indexedFilterOf, cursorIndexedEvents, programAbi } from "./src/node/explorer-api.js";

const PORT = Number(process.env.PORT ?? 3000);
export const DEV = ["1", "true", "yes", "on"].includes(String(process.env.DEV ?? "").toLowerCase());
// genesis: ยอดเริ่มต้น + ค่าที่ทุกเครื่องต้องเหมือนกัน (config) — env ที่ตั้งต่างจาก genesis = ไม่ยอมเริ่ม (ดู startupProblems)
const GENESIS_FILE = process.env.GENESIS ?? "genesis.json";
export const genesis = fs.existsSync(GENESIS_FILE) ? JSON.parse(fs.readFileSync(GENESIS_FILE, "utf8")) : null;
export const { settings, errors: settingErrors } = resolveSettings(genesis ?? {}, process.env);
// ผู้ผลิต block: เซ็น hash ของ block ทุกอันด้วย key นี้ (key อยู่ในเครื่องนี้เท่านั้น ไม่มี endpoint ไหนรับ / ส่ง key)
const PRODUCER_KEY = process.env.PRODUCER_KEY || null;
export const producer = PRODUCER_KEY
  ? { address: addressOf(PRODUCER_KEY), sign: (hash) => signTypedDataDigest(hash, PRODUCER_KEY) }
  : null;
const MINER = process.env.MINER ?? producer?.address ?? "0x1111111111111111111111111111111111111111";
const BLOCK_MS = settings.blockMs;
// โปรแกรมทำงานแบบ sync ใน thread เดียวกับ HTTP → ระหว่างรัน server ตอบใครไม่ได้เลย จึงต้องสั้น
// (ลูปหมดแก๊สเองแล้ว ดู src/core/gasmeter.js — เวลานี้เป็นตัวกันสุดท้าย)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 5000);
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 120);
// sandbox ของโปรแกรม (ดู src/core/sandbox.js): ทุกเครื่องในเครือข่ายต้องตั้งค่าเดียวกัน ไม่งั้นผลของ tx ที่ใช้หน่วยความจำมากจะต่างกัน
const MEMORY_LIMIT_MB = settings.memoryLimitMb;
const STACK_LIMIT_KB = settings.stackLimitKb;
const GAS_PRICE = settings.minBaseFee;   // wei ต่อแก๊ส (1 gwei)
// ตรวจโค้ดอัตโนมัติ (src/core/autoreview.js) ตอน /sendtx deploy / upgrade · AUTO_REVIEW=0 = ปิด (sandbox + แก๊สยังคุมอยู่)
export const AUTO_REVIEW = !["0", "false", "off", "no"].includes(String(process.env.AUTO_REVIEW ?? "1").toLowerCase());

// LMDB จองพื้นที่ได้สูงสุดเท่านี้ (เต็ม = เขียนไม่ได้ เชนหยุด) · ค่าเริ่ม 1T · ดูที่ใช้ไปแล้วที่ /health
const LMDB_MAP_SIZE = process.env.LMDB_MAP_SIZE ? parseSize(process.env.LMDB_MAP_SIZE) : DEFAULT_MAP_SIZE;
export const vm = new VirtualMachine(process.env.DATA ? new DB(process.env.DATA, { mapSize: LMDB_MAP_SIZE }) : new MemoryDB(), {
  chainId: settings.chainId,
  requireNonce: true, chargeGas: true, deriveProgramAddress: true,
  recordTransactions: true, recordBlocks: true, recordHistory: true,
  // EIP-1559: base fee (ปรับตามความเต็มของ block) เผาทิ้ง · tip (maxPriorityFeePerGas) เข้าผู้ปิด block
  feeRecipient: MINER, burnPercent: settings.burnPercent, timeoutMs: TIMEOUT_MS,
  minBaseFee: GAS_PRICE, gasTarget: settings.gasTarget,
  baseFeeChangeDenominator: settings.baseFeeDenominator,
  producer,
  memoryLimitBytes: MEMORY_LIMIT_MB * 1024 * 1024, maxStackBytes: STACK_LIMIT_KB * 1024,
  gas: { price: GAS_PRICE },   // native 18 ทศนิยม (wei) · ราคาแก๊สขั้นต่ำ 1 gwei แบบ ETH
  maxTransactions: 500, maxTransactionsPerSender: 16, maxBlockGas: 3_000_000, maxTxGas: 3_000_000,
  admins: settings.admins,
  upgradeDelayBlocks: settings.upgradeDelayBlocks,   // timelock ของการอัปเกรด (0 = ใช้โค้ดใหม่ทันทีที่อนุมัติ)
});
// ใบที่ถูกแทนที่ (replace-by-fee): จำแบบ off-chain มีเพดาน · มี DATA = ไฟล์ JSON lines ข้าง LMDB → /tx ตอบ "replaced" ได้แม้ restart
export const replacedLog = new TxLog({
  file: process.env.DATA ? path.join(process.env.DATA, "replaced-tx.jsonl") : null,
  maxEntries: Number(process.env.REPLACED_LOG_MAX ?? 100_000),
  maxAgeMs: Number(process.env.REPLACED_LOG_DAYS ?? 30) * 24 * 60 * 60_000,
});
// tx ที่ถูกปฏิเสธ (ผ่านลายเซ็นแล้ว) ถูกบันทึกลง block ถัดไป (block.recordRejected) — ดู src/node/mempool.js
export const mempool = new Mempool(vm, { replacedLog, maxRejectedPerBlock: Number(process.env.REJECTED_PER_BLOCK ?? 1000) });
// POST ทุกตัวอาจรันโปรแกรม → จำกัดต่อ IP (ส่วน /sendtx ยังมี rate limit ต่อ address ใน mempool อีกชั้น)
export const postLimiter = new RateLimiter({ limit: RATE_LIMIT, windowMs: 60_000 });
// ตัวแปลงสำหรับกระเป๋า / เครื่องมือ EVM (อ่านอย่างเดียว ไม่เปลี่ยนอะไรในเชน) — ดู src/node/evm-rpc.js
export const evmLimiter = new RateLimiter({ limit: Number(process.env.EVM_RATE_LIMIT ?? 600), windowMs: 60_000 });
export const evmRpc = createEvmRpc({ vm, mempool, decimals: Number(process.env.EVM_DECIMALS ?? 0) });   // native เป็น wei (18 ทศนิยม) อยู่แล้ว
if (genesis) vm.applyGenesis(genesis);

// มีแค่ tx ที่ถูกปฏิเสธ → พักไว้ให้ติดไปกับ block ที่มี tx จริง หรือปิด block เมื่อใบที่รอนานสุดครบ REJECTED_HOLD_MS (0 = ปิดทันที)
export const REJECTED_HOLD_MS = Number(process.env.REJECTED_HOLD_MS ?? 60_000);
export function shouldMine(now = Date.now()) {
  if (mempool.size > 0) return true;
  if (mempool.rejectedPending === 0) return false;
  return now - (mempool.oldestRejectionAt ?? now) >= REJECTED_HOLD_MS;
}

let mining = false;
export const miner = setInterval(() => {
  if (mining || !shouldMine()) return;
  mining = true;
  try {
    const block = vm.createBlock({ timestamp: Date.now(), feeRecipient: MINER });
    const included = mempool.take(block);
    block.commit();
    const rejected = block.rejectedTransactions().length;
    console.log(`block ${block.number} ปิดแล้ว (${included.length} tx${rejected ? ` · ปฏิเสธ ${rejected}` : ""})`);
  } catch (error) {
    console.error("ปิด block ล้มเหลว:", error.message);
  } finally { mining = false; }
}, BLOCK_MS);
miner.unref?.();

const lower = (value) => String(value ?? "").toLowerCase();
const limitOf = (query) => Math.min(Number(query.get("limit")) || 20, 200);

const ROUTES = {
  "/blocks": (query) => {
    const before = Number(query.get("before"));
    const latest = vm.latestBlockNumber() ?? 0;
    const from = Number.isInteger(before) && before > 0 ? before - 1 : latest;
    const list = [];
    for (let n = from; n > 0 && list.length < limitOf(query); n -= 1) { const b = vm.getBlock(n); if (b) list.push(b); }
    return list;
  },
  // แบบแบ่งหน้า: ?page=<เลขหน้า>&limit=<ต่อหน้า> → { items, total, page, pages, limit, truncated }
  "/blocks/page": (query) => pageBlocks(vm, pageOf(query)),
  "/block/latest": () => vm.getBlock(vm.latestBlockNumber()) ?? { error: "No blocks yet" },
  "/pending": () => ({ size: mempool.size, transactions: mempool.list(), rejectedPending: mempool.rejectedPending, rejectedHoldMs: REJECTED_HOLD_MS }),
  // tx ที่ถูกปฏิเสธ (บันทึกใน block) ใหม่ไปเก่า: ?address=<ผู้ส่ง>&limit=&cursor= → { items, next }
  "/rejected": (query) => pageRejected(vm, { address: query.get("address") || undefined, ...cursorOf(query) }),
  // โปรแกรม: จำนวนที่อนุมัติแล้ว / รออนุมัติ + รายการแบบแบ่งหน้า
  "/programs": () => programCounts(vm),
  "/programs/pending": (query) => pagePendingPrograms(vm, pageOf(query)),
  "/programs/approved": (query) => pageApprovedPrograms(vm, pageOf(query)),
  "/events": (query) => vm.listEvents({ program: query.get("program") ?? undefined, name: query.get("name") ?? "", limit: limitOf(query) }),
  "/is-program": (query) => programFlags(vm, (query.get("addresses") ?? "").split(",").filter(Boolean)),
  // สถานะของ node: block ล่าสุด · ย้อนดูได้ตั้งแต่ block ไหน · พื้นที่ LMDB ที่ใช้ไป (เกิน mapSize = เขียนไม่ได้)
  "/health": () => ({ ok: true, latest: vm.latestBlockNumber(), historyFrom: vm.historyFrom(), pending: mempool.size,
    db: typeof vm.db.stats === "function" ? vm.db.stats() : null }),
  "/genesis": () => ({ hash: vm.genesisHash(), chainId: vm.chainId, latest: vm.latestBlockNumber(), pending: mempool.size,
    gasPrice: vm.gas.price, decimals: 18,   // base fee ต่ำสุด (wei) · native มี 18 ทศนิยม
    baseFee: vm.currentBaseFee(), gasTarget: vm.gasTarget, maxBlockGas: vm.maxBlockGas, burnPercent: vm.burnPercent,   // EIP-1559: base fee ของ block ถัดไป
    burned: vm.nativeBalanceOf("0x0000000000000000000000000000000000000000").balance,
    // ผู้ผลิต block ของ node นี้ + รายชื่อผู้ผลิตที่ genesis อนุญาต (node ผู้อ่านส่งให้ startSync({ producers }))
    producer: producer?.address ?? null, producers: settings.producers }),
};

const DYNAMIC = [
  [/^\/block\/(\d+)$/, (m, query) => {
    const header = vm.getBlock(Number(m[1]));
    if (!header) return { status: 404, body: { error: "Block not found" } };
    if (query.get("full") !== "1") return header;
    try { return vm.replayBlock(Number(m[1])); } catch (error) { return { status: 409, body: { error: error.message, header } }; }
  }],
  [/^\/tx\/([^/]+)\/receipt$/, (m) => {
    const found = vm.getTransaction(m[1]);
    if (!found) return { status: 404, body: { error: "Transaction not found" } };
    try { return { ...vm.replayBlock(found.blockNumber).transactions[found.index], blockNumber: found.blockNumber, signature: vm.transactionSignature(found) }; }
    catch (error) { return { status: 409, body: { error: error.message, tx: found } }; }
  }],
  [/^\/tx\/([^/]+)$/, (m) => {
    const found = vm.getTransaction(m[1], { signature: true });
    if (found) return found;
    if (mempool.has(m[1])) return { status: "pending", hash: m[1] };
    const replacedBy = mempool.replacedBy(m[1]);   // ถูกแทนที่ด้วยใบ nonce เดิมที่ราคาแก๊สสูงกว่า (off-chain · มี DATA = อยู่รอด restart)
    if (replacedBy) return { status: "replaced", hash: m[1], replacedBy };
    // ถูกปฏิเสธ (ไม่ได้รัน): บันทึกอยู่ใน block แล้ว หรือยังรอ block ถัดไป (block: null)
    const rejected = vm.getRejectedTransaction(m[1]);
    if (rejected) return { status: "rejected", ...rejected, block: rejected.blockNumber };
    const waiting = mempool.pendingRejection(m[1]);
    if (waiting) return { status: "rejected", ...waiting, block: null, blockNumber: null };
    return { status: 404, body: { error: "Transaction not found" } };
  }],
  [/^\/address\/([^/]+)$/, (m, query) => ({
    address: lower(m[1]), native: vm.nativeBalanceOf(m[1]),
    nonce: vm.checkTransaction({ from: m[1], nonce: -1 }).expectedNonce,
    metadata: vm.getMetadata(m[1]), isProgram: vm.read(`${lower(m[1])}:this`) !== undefined,
    transactions: vm.listTransactionsOf(m[1], { limit: limitOf(query) }),
    incoming: vm.listTransactionsTo(m[1], { limit: limitOf(query) }),
  })],
  [/^\/program\/([^/]+)$/, (m, query) => {
    const code = vm.read(`${lower(m[1])}:code`);
    if (!code) return { status: 404, body: { error: "Program not found (it may not be initialized yet)" } };
    return { address: lower(m[1]), code, context: vm.read(`${lower(m[1])}:context`), metadata: vm.getMetadata(m[1]),
      // อัปเกรด: รอรีวิว / อนุมัติแล้วรอ timelock (ไม่มี = null)
      pendingUpgrade: vm.read(`pending-upgrade:${lower(m[1])}`) ?? null, scheduledUpgrade: vm.read(`scheduled-upgrade:${lower(m[1])}`) ?? null,
      native: vm.nativeBalanceOf(m[1]), storage: vm.listProgramStorage(m[1], { limit: 50 }),
      interactions: vm.listTransactionsTo(m[1], { limit: limitOf(query) }),
      events: vm.listEvents({ program: m[1], limit: limitOf(query) }), token: tokenInfo(vm, m[1]),
      collection: collectionInfo(vm, m[1]) };   // NFT (ERC-721) / multi-token (ERC-1155) มาตรฐาน · ไม่ใช่ = null
  }],
  [/^\/program\/([^/]+)\/storage$/, (m, query) => {
    const address = lower(m[1]);
    const group = query.get("prefix") ?? "";
    const limit = limitOf(query);
    const base = `${address}:storage:`;
    const start = query.get("start") || undefined;

    // key ที่เป็นใบเดี่ยว (เช่น "owner") ไม่มีลูก จึงต้องอ่านตรง ๆ ไม่ใช่ค้นด้วย prefix
    const leaf = group && !start ? vm.read(base + group) : undefined;
    const head = leaf === undefined ? [] : [{ key: [group], value: leaf }];

    const rows = vm.listEntries(`${base}${group ? group + ":" : ""}`, { limit: limit + 1 - head.length, start });
    const hasMore = rows.length > limit - head.length;
    const items = [...head, ...rows.slice(0, limit - head.length)
      .map(({ dbKey, value }) => ({ key: dbKey.slice(base.length).split(":"), value }))];
    return { items, next: hasMore ? rows[limit - head.length].dbKey : null, prefix: group };
  }],
  // โค้ดทุกเวอร์ชันของโปรแกรมที่เคยอัปเกรด [{ version, code, blockNumber, timestamp }]
  [/^\/program\/([^/]+)\/versions$/, (m) => vm.listCodeVersions(m[1])],
  // ABI ที่โปรแกรมประกาศใน metadata.abi (ไม่มี = null) + แบบ JSON ABI ของ Ethereum
  [/^\/program\/([^/]+)\/abi$/, (m) => programAbi(vm, m[1])],
  // นับ key ตามชื่อ key แรก ทีละช่วง ?scan=<key ต่อครั้ง ≤ 50,000>&cursor=<next> → { total, groups, scanned, next, complete }
  [/^\/program\/([^/]+)\/groups$/, (m, query) => storageGroups(vm, m[1], { cursor: query.get("cursor") || undefined, scan: query.get("scan") })],
  // แบบ cursor (ไม่นับทั้งรายการ): ?limit=&cursor=<next> → { items, next }
  [/^\/program\/([^/]+)\/interactions$/, (m, query) => cursorTransactionsTo(vm, m[1], cursorOf(query))],
  // แถบ "ข้อมูล" ของ explorer: variable (key 1 ชั้น) / contract (2 ชั้น) / get storage (3 ชั้นขึ้นไป)
  // เหรียญที่ address ถือ (นับจาก event Transfer) / ข้อมูล token ตามมาตรฐาน
  [/^\/address\/([^/]+)\/tokens$/, (m) => tokenHoldings(vm, m[1])],
  // NFT / multi-token ที่ address ถือ (โปรแกรมจากดัชนี holding: · ชิ้นจาก storage ของโปรแกรม)
  [/^\/address\/([^/]+)\/nfts$/, (m) => nftHoldings(vm, m[1])],
  [/^\/token\/([^/]+)$/, (m) => tokenInfo(vm, m[1]) ?? { status: 404, body: { error: "Not a standard token" } }],
  [/^\/address\/([^/]+)\/txs$/, (m, query) => pageTransactionsOf(vm, m[1], pageOf(query))],
  [/^\/address\/([^/]+)\/incoming$/, (m, query) => (query.has("cursor") ? cursorTransactionsTo(vm, m[1], cursorOf(query)) : pageTransactionsTo(vm, m[1], pageOf(query)))],
  // ?page= → เลขหน้า (นับรวมไม่เกิน 50,000) · ?cursor= (ว่างได้ = หน้าแรก) → แบบ cursor ไม่มีเพดาน
  // ?name=<event>&<field>=<ค่า> → ค้นด้วยดัชนีของ field ที่ emit แบบ indexed (cursor) — ดู indexedEventsQuery
  [/^\/program\/([^/]+)\/events$/, (m, query) => (indexedFilterOf(query) ? cursorIndexedEvents(vm, m[1], query.get("name") ?? "", indexedFilterOf(query), cursorOf(query))
    : query.has("cursor") ? cursorEvents(vm, m[1], cursorOf(query), query.get("name") ?? "")
    : pageEvents(vm, m[1], pageOf(query), query.get("name") ?? ""))],
  [/^\/address\/([^/]+)\/rejected$/, (m, query) => pageRejected(vm, { address: m[1], ...cursorOf(query) })],
  [/^\/program\/([^/]+)\/entries$/, (m, query) => pageStorageMap(vm, m[1], query.get("name") ?? "", pageOf(query))],
  [/^\/token\/([^/]+)\/holders$/, (m, query) => pageHolders(vm, m[1], pageOf(query))],
  [/^\/program\/([^/]+)\/layout$/, (m) => storageLayout(vm, m[1])],
  [/^\/program\/([^/]+)\/map$/, (m, query) => storageMap(vm, m[1], query.get("name") ?? "", { limit: Math.min(Number(query.get("limit")) || 50, 200), start: query.get("start") || undefined })],
  [/^\/program\/([^/]+)\/get$/, (m, query) => storageGet(vm, m[1], query.getAll("key"))],
  [/^\/nonce\/([^/]+)$/, (m) => ({ address: lower(m[1]), nonce: mempool.nextNonce(m[1]) })],
  [/^\/name\/([^/]+)$/, (m) => ({ namespace: lower(m[1]), address: vm.resolveNamespace(m[1]) })],
  [/^\/state\/([^/]+)$/, (m, query) => {
    const block = Number(query.get("block"));
    if (!Number.isInteger(block)) return vm.listProgramStorage(m[1]);
    const prefix = `${lower(m[1])}:storage:`;
    // ?limit=&cursor= → { items: { dbKey: value }, next } (ต้นทุนตามจำนวน key ที่ขอ ไม่ใช่ความยาวเชน) · ไม่ส่ง = ทั้งหมดแบบเดิม
    try {
      if (!query.has("limit") && !query.has("cursor")) return vm.snapshotAt(block, prefix);
      const page = vm.pageSnapshotAt(block, prefix, { limit: limitOf(query), after: query.get("cursor") || undefined });
      return { items: Object.fromEntries(page.items), next: page.next };
    } catch (error) { return { status: 409, body: { error: error.message } }; }
  }],
  [/^\/sync$/, (m, query) => {
    const from = Math.max(1, Number(query.get("from")) || 1);
    const blocks = [];
    // rejected = tx ที่ถูกปฏิเสธที่บันทึกใน block (อยู่ใน hash ของ block ผู้ซิงก์ต้องใส่ครบตามลำดับ)
    for (let n = from; n <= Math.min(vm.latestBlockNumber() ?? 0, from + 49); n += 1) {
      blocks.push({ header: vm.getBlock(n), body: vm.getBlockBody(n), rejected: vm.getBlockRejected(n) });
    }
    return blocks;
  }],
];

function handlePost(url, body) {
  if (url === "/sendtx") {
    const { tx, signature } = body ?? {};
    let verified;
    try { verified = verifyTransaction({ tx, signature }); }
    catch (error) { return { status: 400, body: { queued: false, error: error.message } }; }

    // ตรวจโค้ด + simulate (ส่วนที่แพง) ทำหลัง mempool ตรวจ rate limit / โควตา / nonce แล้วเท่านั้น
    const check = (item) => {
      if (AUTO_REVIEW && (tx.action === "deploy" || tx.action === "upgrade")) {   // โค้ดใหม่ของการอัปเกรดผ่านการตรวจเดียวกับ deploy
        const reviewed = reviewProgram(tx.code);
        if (!reviewed.ok) return { ok: false, error: "โค้ดไม่ผ่านการตรวจ", issues: reviewed.issues };
      }
      return simulate(vm, item);
    };
    const queued = mempool.add({ tx, signature }, { simulate: check, verified });   // ตรวจลายเซ็นแล้วข้างบน → ไม่ recover ซ้ำ
    if (queued.simulation?.issues) return { status: 400, body: { queued: false, error: queued.simulation.error, issues: queued.simulation.issues } };
    if (queued.simulation && !queued.ok) return { status: 400, body: { queued: false, hash: verified.hash, simulation: queued.simulation } };
    if (!queued.ok) return { status: 400, body: { queued: false, ...queued } };
    return { queued: true, hash: queued.hash, sender: queued.sender, simulation: queued.simulation };
  }
  if (url === "/query") {
    const result = vm.query(body ?? {});
    return result.status === "success" ? result : { status: 400, body: result };
  }
  return { status: 404, body: { error: "Endpoint not found" } };
}

const send = (response, status, data) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(data, (key, value) => (typeof value === "bigint" ? `${value}n` : value)));
};

/**
 * /evm — JSON-RPC แบบ EVM (POST) · ค่าสำหรับเพิ่มเชนใน MetaMask (GET /evm)
 * /evm/explorer/{tx,address,token,block}/:id — ลิงก์ "ดูใน explorer" ของกระเป๋า → หน้า explorer เดิม
 */
async function handleEvm(request, response, url) {
  const explorerLink = /^\/evm\/explorer\/(tx|address|token|block)\/([^/]+)$/.exec(url.pathname);
  if (explorerLink) {
    const [, kind, id] = explorerLink;
    response.writeHead(302, { location: `/#${kind === "token" ? "address" : kind}/${encodeURIComponent(id)}` });
    return response.end();
  }
  if (url.pathname !== "/evm") return send(response, 404, { error: "Endpoint not found" });
  if (request.method === "OPTIONS") {   // dApp ในเบราว์เซอร์ส่ง content-type: application/json → ต้องตอบ preflight
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type" });
    return response.end();
  }
  if (request.method === "GET") {
    const origin = `${request.headers["x-forwarded-proto"] ?? "http"}://${request.headers.host ?? "localhost"}`;
    return send(response, 200, evmRpc.chainParams({ rpcUrl: `${origin}/evm`, explorerUrl: `${origin}/evm/explorer`,
      name: process.env.EVM_NAME ?? "Cardianal", symbol: process.env.EVM_SYMBOL ?? "CARD" }));
  }
  if (request.method !== "POST") return send(response, 405, { error: "Use POST for JSON-RPC" });
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const ip = request.socket.remoteAddress ?? "unknown";
  if (!evmLimiter.allow(ip)) {
    response.setHeader("retry-after", String(evmLimiter.retryAfter(ip)));
    return send(response, 429, { jsonrpc: "2.0", id: null, error: { code: -32005, message: "Too many requests, try again later" } });
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(response, 200, parseError()); }
  try { return send(response, 200, evmRpc.handle(body)); }
  catch (error) { console.error(error); return send(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: error.message } }); }
}

export const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/evm" || url.pathname.startsWith("/evm/")) return handleEvm(request, response, url);
  if (request.method === "OPTIONS") return send(response, 204, {});
  if (url.pathname === "/" || url.pathname === "/explorer") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(fs.readFileSync(path.join(import.meta.dirname, "public/explorer.html")));
  }
  try {
    let result;
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const ip = request.socket.remoteAddress ?? "unknown";
      if (!postLimiter.allow(ip)) {
        response.setHeader("retry-after", String(postLimiter.retryAfter(ip)));
        return send(response, 429, { error: "Too many requests, try again later" });
      }
      result = handlePost(url.pathname, chunks.length ? JSON.parse(Buffer.concat(chunks)) : {});
    } else if (ROUTES[url.pathname]) {
      result = ROUTES[url.pathname](url.searchParams);
    } else {
      const found = DYNAMIC.map(([pattern, handler]) => [pattern.exec(url.pathname), handler]).find(([match]) => match);
      result = found ? found[1](found[0], url.searchParams) : { status: 404, body: { error: "Endpoint not found" } };
    }
    if (result?.status && result?.body) return send(response, result.status, result.body);
    return send(response, 200, result);
  } catch (error) {
    console.error(error);
    return send(response, 500, { error: error.message });
  }
});

// ws://host/evm: eth_subscribe newHeads / logs (นับ rate limit ร่วมกับ POST /evm)
export const evmWs = attachEvmWebSocket(server, { rpc: evmRpc, vm, allow: (ip) => evmLimiter.allow(ip) });

if (process.argv[1]?.endsWith("server.js")) {
  const problems = startupProblems({ settings, errors: settingErrors, dev: DEV, producer: producer?.address ?? null });
  if (problems.length) {
    console.error(`server ไม่เริ่ม:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  if (DEV) console.warn("DEV=1: โหมดพัฒนา (ไม่บังคับ ADMINS / PRODUCER_KEY) — ห้ามใช้กับเครือข่ายจริง");
  server.listen(PORT, () => console.log(`chain ทำงานที่ http://localhost:${PORT}`));
}
