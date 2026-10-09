/**
 * server จริง — node server.js    (ใช้ node:http ล้วน ไม่มี dependency เพิ่ม)
 *   PORT=3000 DATA=./data MINER=0x… ADMINS=0x… node server.js
 *   TIMEOUT_MS=2000   เวลาสูงสุดที่โปรแกรมรันได้ต่อ tx / query (ms)
 *   RATE_LIMIT=120    จำนวน POST (/sendtx, /query) ต่อ IP ต่อนาที — 0 = ไม่จำกัด
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
import { storageLayout, storageMap, storageGet, programFlags, tokenInfo, tokenHoldings,
  pageOf, pageBlocks, pageTransactionsOf, pageTransactionsTo, pageEvents, pageStorageMap, pageHolders } from "./src/node/explorer-api.js";

const PORT = Number(process.env.PORT ?? 3000);
const MINER = process.env.MINER ?? "0x1111111111111111111111111111111111111111";
const BLOCK_MS = Number(process.env.BLOCK_MS ?? 3000);
// โปรแกรมทำงานแบบ sync ใน thread เดียวกับ HTTP → ระหว่างรัน server ตอบใครไม่ได้เลย จึงต้องสั้น
// (ยังไม่มีแก๊สแบบนับขั้น ลูปที่ไม่แตะ DB จึงถูกหยุดได้ด้วยเวลานี้อย่างเดียว)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 2000);
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 120);

export const vm = new VirtualMachine(process.env.DATA ? new DB(process.env.DATA) : new MemoryDB(), {
  chainId: Number(process.env.CHAIN_ID ?? 1),
  requireNonce: true, chargeGas: true, deriveProgramAddress: true,
  recordTransactions: true, recordBlocks: true, recordHistory: true, bigintValues: true,
  feeRecipient: MINER, burnPercent: 50, timeoutMs: TIMEOUT_MS,
  maxTransactions: 500, maxTransactionsPerSender: 16, maxBlockGas: 3_000_000,
  admins: process.env.ADMINS ? process.env.ADMINS.split(",") : null,
});
export const mempool = new Mempool(vm);
// POST ทุกตัวอาจรันโปรแกรม → จำกัดต่อ IP (ส่วน /sendtx ยังมี rate limit ต่อ address ใน mempool อีกชั้น)
export const postLimiter = new RateLimiter({ limit: RATE_LIMIT, windowMs: 60_000 });
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
  "/block/latest": () => vm.getBlock(vm.latestBlockNumber()) ?? { error: "ยังไม่มี block" },
  "/pending": () => ({ size: mempool.size, transactions: mempool.list() }),
  "/events": (query) => vm.listEvents({ program: query.get("program") ?? undefined, name: query.get("name") ?? "", limit: limitOf(query) }),
  "/is-program": (query) => programFlags(vm, (query.get("addresses") ?? "").split(",").filter(Boolean)),
  "/genesis": () => ({ hash: vm.genesisHash(), chainId: vm.chainId, latest: vm.latestBlockNumber(), pending: mempool.size,
    burned: vm.nativeBalanceOf("0x0000000000000000000000000000000000000000").balance }),
};

const DYNAMIC = [
  [/^\/block\/(\d+)$/, (m, query) => {
    const header = vm.getBlock(Number(m[1]));
    if (!header) return { status: 404, body: { error: "ไม่พบ block" } };
    if (query.get("full") !== "1") return header;
    try { return vm.replayBlock(Number(m[1])); } catch (error) { return { status: 409, body: { error: error.message, header } }; }
  }],
  [/^\/tx\/([^/]+)\/receipt$/, (m) => {
    const found = vm.getTransaction(m[1]);
    if (!found) return { status: 404, body: { error: "ไม่พบ tx" } };
    try { return { ...vm.replayBlock(found.blockNumber).transactions[found.index], blockNumber: found.blockNumber }; }
    catch (error) { return { status: 409, body: { error: error.message, tx: found } }; }
  }],
  [/^\/tx\/([^/]+)$/, (m) => vm.getTransaction(m[1])
    ?? (mempool.has(m[1]) ? { status: "pending", hash: m[1] } : { status: 404, body: { error: "ไม่พบ tx" } })],
  [/^\/address\/([^/]+)$/, (m, query) => ({
    address: lower(m[1]), native: vm.nativeBalanceOf(m[1]),
    nonce: vm.checkTransaction({ from: m[1], nonce: -1 }).expectedNonce,
    metadata: vm.getMetadata(m[1]), isProgram: vm.read(`${lower(m[1])}:this`) !== undefined,
    transactions: vm.listTransactionsOf(m[1], { limit: limitOf(query) }),
    incoming: vm.listTransactionsTo(m[1], { limit: limitOf(query) }),
  })],
  [/^\/program\/([^/]+)$/, (m, query) => {
    const code = vm.read(`${lower(m[1])}:code`);
    if (!code) return { status: 404, body: { error: "ไม่พบโปรแกรม (อาจยังไม่ได้ init)" } };
    return { address: lower(m[1]), code, context: vm.read(`${lower(m[1])}:context`), metadata: vm.getMetadata(m[1]),
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
  [/^\/token\/([^/]+)$/, (m) => tokenInfo(vm, m[1]) ?? { status: 404, body: { error: "ไม่ใช่ token ตามมาตรฐาน" } }],
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
      if (tx.action === "deploy") {
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
  return { status: 404, body: { error: "ไม่พบ endpoint" } };
}

const send = (response, status, data) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(data, (key, value) => (typeof value === "bigint" ? `${value}n` : value)));
};

export const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
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
        return send(response, 429, { error: "เรียกถี่เกินกำหนด ลองใหม่ภายหลัง" });
      }
      result = handlePost(url.pathname, chunks.length ? JSON.parse(Buffer.concat(chunks)) : {});
    } else if (ROUTES[url.pathname]) {
      result = ROUTES[url.pathname](url.searchParams);
    } else {
      const found = DYNAMIC.map(([pattern, handler]) => [pattern.exec(url.pathname), handler]).find(([match]) => match);
      result = found ? found[1](found[0], url.searchParams) : { status: 404, body: { error: "ไม่พบ endpoint" } };
    }
    if (result?.status && result?.body) return send(response, result.status, result.body);
    return send(response, 200, result);
  } catch (error) {
    console.error(error);
    return send(response, 500, { error: error.message });
  }
});

if (process.argv[1]?.endsWith("server.js")) server.listen(PORT, () => console.log(`chain ทำงานที่ http://localhost:${PORT}`));
