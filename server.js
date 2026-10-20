/**
 * server จริง — node server.js    (ใช้ node:http ล้วน ไม่มี dependency เพิ่ม)
 *   PORT=3000 DATA=./data MINER=0x… ADMINS=0x… node server.js
 *   TIMEOUT_MS=5000   เวลาสูงสุดที่โปรแกรมรันได้ต่อ tx / query (ms) — ตัวกันสุดท้าย ลูปไม่รู้จบหมดแก๊สก่อน
 *   MEMORY_LIMIT_MB=32   หน่วยความจำของ sandbox (QuickJS) ต่อ tx รวมทุกโปรแกรมในสายการเรียก — เกิน = OUT_OF_MEMORY (1–1024)
 *   STACK_LIMIT_KB=256   stack ของ sandbox ต่อ tx (เรียกฟังก์ชันซ้อนลึกเกิน = RangeError ที่ catch ได้) (16–256)
 *   GAS_PRICE=1000000000   ราคาแก๊สขั้นต่ำ (wei ต่อแก๊ส · native มี 18 ทศนิยม · ค่าเริ่มต้น 1 gwei)
 *   RATE_LIMIT=120    จำนวน POST (/sendtx, /query) ต่อ IP ต่อนาที — 0 = ไม่จำกัด
 *   EVM_RATE_LIMIT=600  จำนวน request ของ /evm ต่อ IP ต่อนาที (นับแยกจาก RATE_LIMIT: กระเป๋า EVM ถามถี่ ไม่ให้ไปกินโควตาของ /sendtx)
 *   EVM_DECIMALS=0    ทศนิยมที่ /evm เติมให้ยอด native (native เป็น wei 18 ทศนิยมอยู่แล้ว จึงเป็น 0)
 *   EVM_NAME=Cardianal EVM_SYMBOL=CARD   ชื่อ / สัญลักษณ์เหรียญใน GET /evm (ค่าสำหรับ wallet_addEthereumChain)
 *   UPGRADE_DELAY_BLOCKS=0   timelock ของการอัปเกรดโปรแกรม: โค้ดใหม่เริ่มใช้ที่ block (ที่อนุมัติ + N) · 0 = ทันที
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { VirtualMachine } from "./src/core/virtualmachine.js";
import { reviewProgram } from "./src/core/autoreview.js";
import { DB, MemoryDB } from "./src/storage/db.js";
import { verifyTransaction } from "./src/crypto/signature.js";
import { Mempool } from "./src/node/mempool.js";
import { simulate } from "./src/node/simulate.js";
import { RateLimiter } from "./src/node/ratelimit.js";
import { createEvmRpc, parseError } from "./src/node/evm-rpc.js";
import { attachEvmWebSocket } from "./src/node/evm-ws.js";
import { storageLayout, storageMap, storageGet, programFlags, tokenInfo, tokenHoldings,
  pageOf, pageBlocks, pageTransactionsOf, pageTransactionsTo, pageEvents, pageStorageMap, pageHolders,
  programCounts, pagePendingPrograms, pageApprovedPrograms } from "./src/node/explorer-api.js";

const PORT = Number(process.env.PORT ?? 3000);
const MINER = process.env.MINER ?? "0x1111111111111111111111111111111111111111";
const BLOCK_MS = Number(process.env.BLOCK_MS ?? 3000);
// โปรแกรมทำงานแบบ sync ใน thread เดียวกับ HTTP → ระหว่างรัน server ตอบใครไม่ได้เลย จึงต้องสั้น
// (ลูปหมดแก๊สเองแล้ว ดู src/core/gasmeter.js — เวลานี้เป็นตัวกันสุดท้าย)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 5000);
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 120);
// sandbox ของโปรแกรม (ดู src/core/sandbox.js): ทุกเครื่องในเครือข่ายต้องตั้งค่าเดียวกัน ไม่งั้นผลของ tx ที่ใช้หน่วยความจำมากจะต่างกัน
const MEMORY_LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB ?? 32);
const STACK_LIMIT_KB = Number(process.env.STACK_LIMIT_KB ?? 256);
const GAS_PRICE = BigInt(process.env.GAS_PRICE ?? 1_000_000_000);   // wei ต่อแก๊ส (1 gwei)

export const vm = new VirtualMachine(process.env.DATA ? new DB(process.env.DATA) : new MemoryDB(), {
  chainId: Number(process.env.CHAIN_ID ?? 1),
  requireNonce: true, chargeGas: true, deriveProgramAddress: true,
  recordTransactions: true, recordBlocks: true, recordHistory: true,
  feeRecipient: MINER, burnPercent: 50, timeoutMs: TIMEOUT_MS,
  memoryLimitBytes: MEMORY_LIMIT_MB * 1024 * 1024, maxStackBytes: STACK_LIMIT_KB * 1024,
  gas: { price: GAS_PRICE },   // native 18 ทศนิยม (wei) · ราคาแก๊สขั้นต่ำ 1 gwei แบบ ETH
  maxTransactions: 500, maxTransactionsPerSender: 16, maxBlockGas: 3_000_000, maxTxGas: 3_000_000,
  admins: process.env.ADMINS ? process.env.ADMINS.split(",") : null,
  upgradeDelayBlocks: Number(process.env.UPGRADE_DELAY_BLOCKS ?? 0),   // timelock ของการอัปเกรด (0 = ใช้โค้ดใหม่ทันทีที่อนุมัติ)
});
export const mempool = new Mempool(vm);
// POST ทุกตัวอาจรันโปรแกรม → จำกัดต่อ IP (ส่วน /sendtx ยังมี rate limit ต่อ address ใน mempool อีกชั้น)
export const postLimiter = new RateLimiter({ limit: RATE_LIMIT, windowMs: 60_000 });
// ตัวแปลงสำหรับกระเป๋า / เครื่องมือ EVM (อ่านอย่างเดียว ไม่เปลี่ยนอะไรในเชน) — ดู src/node/evm-rpc.js
export const evmLimiter = new RateLimiter({ limit: Number(process.env.EVM_RATE_LIMIT ?? 600), windowMs: 60_000 });
export const evmRpc = createEvmRpc({ vm, mempool, decimals: Number(process.env.EVM_DECIMALS ?? 0) });   // native เป็น wei (18 ทศนิยม) อยู่แล้ว
if (fs.existsSync("genesis.json")) vm.applyGenesis(JSON.parse(fs.readFileSync("genesis.json", "utf8")));

let mining = false;
export const miner = setInterval(() => {
  if (mining || mempool.size === 0) return;
  mining = true;
  try {
    const block = vm.createBlock({ timestamp: Date.now(), feeRecipient: MINER });
    const included = mempool.take(block);
    block.commit();
    console.log(`block ${block.number} ปิดแล้ว (${included.length} tx)`);
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
  "/pending": () => ({ size: mempool.size, transactions: mempool.list() }),
  // โปรแกรม: จำนวนที่อนุมัติแล้ว / รออนุมัติ + รายการแบบแบ่งหน้า
  "/programs": () => programCounts(vm),
  "/programs/pending": (query) => pagePendingPrograms(vm, pageOf(query)),
  "/programs/approved": (query) => pageApprovedPrograms(vm, pageOf(query)),
  "/events": (query) => vm.listEvents({ program: query.get("program") ?? undefined, name: query.get("name") ?? "", limit: limitOf(query) }),
  "/is-program": (query) => programFlags(vm, (query.get("addresses") ?? "").split(",").filter(Boolean)),
  "/genesis": () => ({ hash: vm.genesisHash(), chainId: vm.chainId, latest: vm.latestBlockNumber(), pending: mempool.size,
    gasPrice: vm.gas.price, decimals: 18,   // ราคาแก๊สขั้นต่ำ (wei) · native มี 18 ทศนิยม
    burned: vm.nativeBalanceOf("0x0000000000000000000000000000000000000000").balance }),
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
    try { return { ...vm.replayBlock(found.blockNumber).transactions[found.index], blockNumber: found.blockNumber }; }
    catch (error) { return { status: 409, body: { error: error.message, tx: found } }; }
  }],
  [/^\/tx\/([^/]+)$/, (m) => {
    const found = vm.getTransaction(m[1]);
    if (found) return found;
    if (mempool.has(m[1])) return { status: "pending", hash: m[1] };
    const replacedBy = mempool.replacedBy(m[1]);   // ถูกแทนที่ด้วยใบ nonce เดิมที่ราคาแก๊สสูงกว่า (จำไว้ ttlMs)
    if (replacedBy) return { status: "replaced", hash: m[1], replacedBy };
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
      events: vm.listEvents({ program: m[1], limit: limitOf(query) }), token: tokenInfo(vm, m[1]) };
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
  [/^\/program\/([^/]+)\/groups$/, (m, query) => {
    const address = lower(m[1]);
    const counts = new Map();
    let total = 0;
    for (const key of vm.listKeys(`${address}:storage:`, { limit: 5000 })) {
      const [head] = key.slice(`${address}:storage:`.length).split(":");
      counts.set(head, (counts.get(head) ?? 0) + 1);
      total += 1;
    }
    return { total, groups: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) };
  }],
  // แถบ "ข้อมูล" ของ explorer: variable (key 1 ชั้น) / contract (2 ชั้น) / get storage (3 ชั้นขึ้นไป)
  // เหรียญที่ address ถือ (นับจาก event Transfer) / ข้อมูล token ตามมาตรฐาน
  [/^\/address\/([^/]+)\/tokens$/, (m) => tokenHoldings(vm, m[1])],
  [/^\/token\/([^/]+)$/, (m) => tokenInfo(vm, m[1]) ?? { status: 404, body: { error: "Not a standard token" } }],
  [/^\/address\/([^/]+)\/txs$/, (m, query) => pageTransactionsOf(vm, m[1], pageOf(query))],
  [/^\/address\/([^/]+)\/incoming$/, (m, query) => pageTransactionsTo(vm, m[1], pageOf(query))],
  [/^\/program\/([^/]+)\/events$/, (m, query) => pageEvents(vm, m[1], pageOf(query), query.get("name") ?? "")],
  [/^\/program\/([^/]+)\/entries$/, (m, query) => pageStorageMap(vm, m[1], query.get("name") ?? "", pageOf(query))],
  [/^\/token\/([^/]+)\/holders$/, (m, query) => pageHolders(vm, m[1], pageOf(query))],
  [/^\/program\/([^/]+)\/layout$/, (m) => storageLayout(vm, m[1])],
  [/^\/program\/([^/]+)\/map$/, (m, query) => storageMap(vm, m[1], query.get("name") ?? "", { limit: Math.min(Number(query.get("limit")) || 50, 200), start: query.get("start") || undefined })],
  [/^\/program\/([^/]+)\/get$/, (m, query) => storageGet(vm, m[1], query.getAll("key"))],
  [/^\/nonce\/([^/]+)$/, (m) => ({ address: lower(m[1]), nonce: mempool.nextNonce(m[1]) })],
  [/^\/name\/([^/]+)$/, (m) => ({ namespace: lower(m[1]), address: vm.resolveNamespace(m[1]) })],
  [/^\/state\/([^/]+)$/, (m, query) => {
    const block = Number(query.get("block"));
    return Number.isInteger(block) ? vm.snapshotAt(block, `${lower(m[1])}:storage:`) : vm.listProgramStorage(m[1]);
  }],
  [/^\/sync$/, (m, query) => {
    const from = Math.max(1, Number(query.get("from")) || 1);
    const blocks = [];
    for (let n = from; n <= Math.min(vm.latestBlockNumber() ?? 0, from + 49); n += 1) blocks.push({ header: vm.getBlock(n), body: vm.getBlockBody(n) });
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
      if (tx.action === "deploy" || tx.action === "upgrade") {   // โค้ดใหม่ของการอัปเกรดผ่านการตรวจเดียวกับ deploy
        const reviewed = reviewProgram(tx.code);
        if (!reviewed.ok) return { ok: false, error: "โค้ดไม่ผ่านการตรวจ", issues: reviewed.issues };
      }
      return simulate(vm, item);
    };
    const queued = mempool.add({ tx, signature }, { simulate: check });
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

if (process.argv[1]?.endsWith("server.js")) server.listen(PORT, () => console.log(`chain ทำงานที่ http://localhost:${PORT}`));
