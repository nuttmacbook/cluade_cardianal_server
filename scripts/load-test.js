/**
 * load test: เวลาที่เชนใช้ปิด block ภายใต้โหลด — LMDB บนดิสก์จริง เทียบ MemoryDB
 *
 *   npm run load:test                                   # ชุดเต็ม: native / token / mix × 100 / 250 / 500 tx × LMDB + memory
 *   npm run load:test -- --quick                        # ชุดเล็ก (~10 วินาที · ตัวที่เทสต์ 80 ใช้)
 *   npm run load:test -- --db lmdb --workload token --txs 500 --blocks 30 --out load.json
 *   npm run load:test -- --url http://localhost:3000 --txs 200 --blocks 5    # ยิง /sendtx ของ server ที่รันอยู่ (end-to-end)
 *
 * โหมดในโปรเซส (ค่าเริ่ม) ใช้ของจริงทั้งหมดแบบเดียวกับ server.js — ไม่ผ่าน HTTP
 *   VirtualMachine (option เดียวกับ server: maxTransactions 500 · ต่อ sender 16 · maxBlockGas / maxTxGas 3M · EIP-1559 · history ฯลฯ)
 *   + DB (LMDB ในโฟลเดอร์ชั่วคราวบนดิสก์) หรือ MemoryDB · Mempool + simulate + reviewProgram ตอนรับ tx (= /sendtx ลบ HTTP)
 *   ทุก block: เซ็น tx (ฝั่ง client · ไม่จับเวลา) → mempool.add ทีละใบ (ตรวจลายเซ็น + simulate) → createBlock → mempool.take → commit
 *   ผู้ส่งหลายกระเป๋าจาก genesis (1 ใบต่อกระเป๋าต่อ block) → ไม่ติดเพดาน 16 ใบต่อ sender
 *
 * ที่วัดต่อ block
 *   add      mempool.add ทั้ง block (ตรวจลายเซ็น + simulate)  · sim = ส่วนของ simulate
 *   take     createBlock + mempool.take (รัน tx ทุกใบใน block)
 *   roots    block.hashes() (stateRoot / txRoot / receiptsRoot / logsBloom) — วัดแยกอีกครั้ง ไม่นับรวมใน close
 *   commit   block.commit() ทั้งหมด = ประกอบ header / body / ดัชนี / history (+ คำนวณ root ข้างใน) + db.writeKeys
 *   write    เฉพาะ db.writeKeys (LMDB transaction)
 *   close    take + commit (= เวลาที่ miner ของ server ใช้ใน setInterval)
 *   slot     add + close (server เป็น thread เดียว: ทั้งสองต้องเสร็จใน BLOCK_MS)
 *
 * workload
 *   native   โอน native (ครึ่งหนึ่งไป address ใหม่ทุกใบ)
 *   token    TOKEN_PROGRAM.transfer (ครึ่งหนึ่งไป address ใหม่)
 *   mix      token 30% · native 20% · MIX.work (ลูป --rounds รอบ + keccak256 + เขียน 3 key + emit) 35% · MIX.probe (runProgram ไป token) 15%
 *
 * ตัวเลือก
 *   --db lmdb|memory|both   (both)          --workload native,token,mix|all (all)     --txs 100,250,500
 *   --blocks <n>  block ที่วัดต่อชุด (10)    --warmup <n> block อุ่นเครื่องที่ไม่นับ (2)  --rounds <n> รอบลูปของ MIX.work (200)
 *   --data-dir <dir>  ที่สร้างโฟลเดอร์ LMDB ชั่วคราว (os.tmpdir())   --keep  ไม่ลบโฟลเดอร์ LMDB หลังจบ
 *   --out <file>  รายงาน JSON     --quick  ชุดเล็ก (txs 20 · blocks 2 · warmup 1)    --seed <text>
 *   --url <url>   โหมด end-to-end: เติมเงินกระเป๋าผ่าน tx จริงแล้วยิง /sendtx (ต้องเปิด server ด้วย RATE_LIMIT=0)
 *                 --funder-key <key> (Hardhat #1 ที่ genesis.json ให้เงิน) · --admin-key <key> ถ้า server ตั้ง ADMINS
 *                 --concurrency <n> request พร้อมกัน (16) · กระเป๋าไม่เกิน 800 (ส่งต่อผ่านกระเป๋ากลางเพราะ rate limit 60 ใบ/นาที/address)
 *
 * ⚠️ key ของกระเป๋าสร้างจาก --seed เพื่อทดสอบเท่านั้น
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { reviewProgram } from "../src/core/autoreview.js";
import { DB, MemoryDB } from "../src/storage/db.js";
import { Mempool } from "../src/node/mempool.js";
import { simulate } from "../src/node/simulate.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const flag = (name) => args.includes(`--${name}`);
const list = (value) => String(value).split(",").map((item) => item.trim()).filter(Boolean);

const QUICK = flag("quick");
const WORKLOADS = ["native", "token", "mix"];
const OPTIONS = {
  url: option("url", null),
  db: option("db", "both"),
  workloads: (() => { const w = option("workload", "all"); return w === "all" ? WORKLOADS : list(w); })(),
  txs: list(option("txs", QUICK ? "20" : "100,250,500")).map(Number),
  blocks: Number(option("blocks", QUICK ? 2 : 10)),
  warmup: Number(option("warmup", QUICK ? 1 : 2)),
  rounds: Number(option("rounds", 200)),
  dataDir: option("data-dir", os.tmpdir()),
  keep: flag("keep"),
  out: option("out", null),
  seed: option("seed", null),
  funderKey: option("funder-key", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
  adminKey: option("admin-key", null),
  concurrency: Number(option("concurrency", 16)),
};
for (const w of OPTIONS.workloads) if (!WORKLOADS.includes(w)) throw new Error(`workload ไม่รู้จัก: ${w} (${WORKLOADS.join(" / ")})`);
if (!["lmdb", "memory", "both"].includes(OPTIONS.db)) throw new Error("--db ต้องเป็น lmdb / memory / both");
if (OPTIONS.txs.some((n) => !Number.isInteger(n) || n < 1)) throw new Error("--txs ต้องเป็นจำนวนเต็มบวก เช่น 100,250,500");

// option ของ VM เหมือน server.js (ค่าเริ่มของ env) — ตัวเลขที่วัดได้จึงใช้กับ server จริงได้ตรง ๆ
const MINER = "0x1111111111111111111111111111111111111111";
const GWEI = 10n ** 9n;
const COIN = 10n ** 18n;
const VM_OPTIONS = {
  chainId: 1, requireNonce: true, chargeGas: true, deriveProgramAddress: true,
  recordTransactions: true, recordBlocks: true, recordHistory: true,
  feeRecipient: MINER, burnPercent: 100, timeoutMs: 5000, minBaseFee: GWEI, gasTarget: null, baseFeeChangeDenominator: 8,
  memoryLimitBytes: 32 * 1024 * 1024, maxStackBytes: 256 * 1024, gas: { price: GWEI },
  maxTransactions: 500, maxTransactionsPerSender: 16, maxBlockGas: 3_000_000, maxTxGas: 3_000_000,
  admins: null, upgradeDelayBlocks: 0,
};
// base fee ขึ้นได้ 12.5% ต่อ block ที่ใช้แก๊สเกินเป้า (1.5M) → ตั้ง maxFee สูงไว้ ไม่ให้ tip
const FEES = { gasLimit: 500_000, maxFeePerGas: `${10_000n * GWEI}`, maxPriorityFeePerGas: "0" };

// ---------- โปรแกรมของ workload "mix" ----------
const MIX_PROGRAM = `function program() {
  function initialization(params) {
    writeDB("token", params.input.token)
  }
  function work(params) {
    const sender = params.context.sender
    let acc = readDB(map("acc", sender)) || 1n
    for (let i = 0n; i < params.input.rounds; i++) {
      acc = (acc * 31n + i) % 1000000007n
    }
    const digest = keccak256({ sender: sender, acc: acc })
    writeDB(map("acc", sender), acc)
    writeDB(map("digest", sender), digest)
    writeDB(map("count", sender), (readDB(map("count", sender)) || 0n) + 1n)
    emit("Worked", { sender: sender, acc: acc }, { indexed: ["sender"] })
    return acc
  }
  function probe(params) {
    const balance = runProgram(readDB("token"), "balanceOf", { who: params.context.sender })
    writeDB(map("seen", params.context.sender), balance)
    emit("Probed", { who: params.context.sender, balance: balance })
    return balance
  }
  return { work, probe }
}`;

// ---------- ตัวช่วย ----------
const keyOf = (text) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;
const walletOf = (text) => { const key = keyOf(text); return { key, address: sign.addressOf(key) }; };
const freshAddress = (text) => `0x${keyOf(`addr:${text}`).slice(-40)}`;
const ms = (start) => performance.now() - start;
const sum = (values) => values.reduce((a, b) => a + b, 0);
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const stats = (values) => ({ p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null,
  mean: values.length ? sum(values) / values.length : null });
const round = (value, digits = 1) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));
const fmt = (value, digits = 0) => (value === null || value === undefined ? "-" : value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const bytes = (value) => (value === null || value === undefined ? "-" : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024).toFixed(0)} KB`);
const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));

/** สุ่มแบบกำหนด seed ได้ (mulberry32) — workload เดิมได้ลำดับ tx เดิม */
function rng(seedText) {
  let state = parseInt(keyOf(seedText).slice(2, 10), 16);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ฟิลด์ของ tx ใบถัดไปตาม workload (ยังไม่ใส่ nonce / from) */
function makeTx(workload, { random, programs, senders, index, rounds }) {
  const to = random() < 0.5 ? freshAddress(index) : senders[Math.floor(random() * senders.length)].address;
  const native = () => ({ action: "transfer", to, value: `${1000n + BigInt(index % 1000)}` });
  const token = () => ({ action: "call", to: programs.token, method: "transfer", input: { to, amount: "1n" } });
  if (workload === "native") return native();
  if (workload === "token") return token();
  const pick = random();
  if (pick < 0.3) return token();
  if (pick < 0.5) return native();
  if (pick < 0.85) return { action: "call", to: programs.mix, method: "work", input: { rounds: `${rounds}n` } };
  return { action: "call", to: programs.mix, method: "probe", input: {} };
}

/** แปลงฟิลด์เป็น tx ที่เซ็นแล้ว */
function signed(wallet, fields, nonce, chainId) {
  const tx = { chainId, from: wallet.address, to: "", method: "", input: {}, value: 0, nonce, ...FEES, ...fields };
  return { tx, signature: sign.signTransaction(tx, wallet.key) };
}

// ============================================================================
//  โหมดในโปรเซส
// ============================================================================

function dbStats(db, dir) {
  if (!dir) return { entries: db.size, fileBytes: null, diskBytes: null };
  const stat = fs.statSync(path.join(dir, "data.mdb"));
  const lmdb = db.server.getStats();
  return { entries: lmdb.entryCount, fileBytes: stat.size, diskBytes: stat.blocks * 512, usedBytes: (lmdb.lastPageNumber + 1) * lmdb.pageSize };
}

/** chain ใหม่ 1 ชุด (VM + DB + mempool) แบบเดียวกับ server.js · จับเวลา db.writeKeys */
function createChain(kind, { senderCount, seed }) {
  let dir = null;
  let db;
  if (kind === "lmdb") {
    fs.mkdirSync(OPTIONS.dataDir, { recursive: true });
    dir = fs.mkdtempSync(path.join(OPTIONS.dataDir, "load-test-"));
    db = new DB(dir);
  } else db = new MemoryDB();
  const timing = { writeMs: 0, writes: 0 };
  const writeKeys = db.writeKeys.bind(db);
  db.writeKeys = (writes) => {
    const start = performance.now();
    try { return writeKeys(writes); } finally { timing.writeMs += ms(start); timing.writes += writes.length; }
  };
  const vm = new VirtualMachine(db, VM_OPTIONS);
  const mempool = new Mempool(vm, { maxRejectedPerBlock: 1000 });
  const funder = walletOf(`${seed}:funder`);
  const senders = Array.from({ length: senderCount }, (_, i) => walletOf(`${seed}:sender:${i}`));
  const balances = { [funder.address]: `${100_000_000n * COIN}n` };
  for (const sender of senders) balances[sender.address] = `${1_000_000n * COIN}n`;
  vm.applyGenesis({ chainId: VM_OPTIONS.chainId, balances });
  return { kind, dir, db, vm, mempool, timing, funder, senders, nonces: new Map(), lastTimestamp: 0 };
}

/** = handlePost("/sendtx") ของ server ลบ HTTP: mempool.add + reviewProgram (deploy) + simulate */
function addTx(chain, item, simTiming) {
  const check = (verified) => {
    if (item.tx.action === "deploy" || item.tx.action === "upgrade") {
      const reviewed = reviewProgram(item.tx.code);
      if (!reviewed.ok) return { ok: false, error: "โค้ดไม่ผ่านการตรวจ", issues: reviewed.issues };
    }
    const start = performance.now();
    try { return simulate(chain.vm, verified); } finally { simTiming.ms += ms(start); }
  };
  return chain.mempool.add(item, { simulate: check });
}

function sendFrom(chain, wallet, fields, simTiming = { ms: 0 }) {
  const nonce = chain.nonces.get(wallet.address) ?? 0;
  const result = addTx(chain, signed(wallet, fields, nonce, VM_OPTIONS.chainId), simTiming);
  if (result.ok) chain.nonces.set(wallet.address, nonce + 1);
  return result;
}

/** ปิด block แบบ miner ของ server.js → เวลาแต่ละช่วง */
function mine(chain, { measureRoots = false } = {}) {
  const timestamp = Math.max(Date.now(), chain.lastTimestamp + 1);
  chain.lastTimestamp = timestamp;
  const writeBefore = chain.timing.writeMs;
  const writesBefore = chain.timing.writes;
  let start = performance.now();
  const block = chain.vm.createBlock({ timestamp, feeRecipient: MINER });
  const included = chain.mempool.take(block);
  const takeMs = ms(start);
  let rootsMs = null;
  if (measureRoots) { start = performance.now(); block.hashes(); rootsMs = ms(start); }
  start = performance.now();
  block.commit();
  const commitMs = ms(start);
  const header = chain.vm.getBlock(block.number);
  const results = block.results?.() ?? [];
  return {
    number: block.number, txs: header.txCount, gasUsed: header.gasUsed, rejected: block.rejectedTransactions().length,
    failed: results.filter((r) => r.status !== "success").length, firstError: results.find((r) => r.status !== "success")?.error?.message ?? null,
    takeMs, rootsMs, commitMs, writeMs: chain.timing.writeMs - writeBefore, dbWrites: chain.timing.writes - writesBefore,
    closeMs: takeMs + commitMs, included: included.length,
  };
}

function mustOk(result, label) {
  if (!result.ok) throw new Error(`${label} ถูกปฏิเสธ: ${result.reason ?? result.simulation?.error ?? JSON.stringify(result)}`);
  return result;
}

/** deploy token + MIX → init → แจก token ให้ทุกกระเป๋า (ผ่าน mempool + block จริง) */
function setupPrograms(chain, workload) {
  if (workload === "native") return {};
  const { vm, funder } = chain;
  const programs = { token: vm.programAddressFor(funder.address, chain.nonces.get(funder.address) ?? 0) };
  mustOk(sendFrom(chain, funder, { action: "deploy", code: TOKEN_PROGRAM,
    input: { name: "Load Token", ticker: "LOAD", decimals: "6n", supply: `${10n ** 30n}n` } }), "deploy token");
  if (workload === "mix") {
    programs.mix = vm.programAddressFor(funder.address, chain.nonces.get(funder.address));
    mustOk(sendFrom(chain, funder, { action: "deploy", code: MIX_PROGRAM, input: { token: programs.token } }), "deploy mix");
  }
  mine(chain);
  for (const name of Object.keys(programs)) mustOk(sendFrom(chain, funder, { action: "init", to: programs[name] }), `init ${name}`);
  mine(chain);
  const batches = [];
  for (let i = 0; i < chain.senders.length; i += 100) batches.push(chain.senders.slice(i, i + 100));
  for (let i = 0; i < batches.length; i += 16) {
    for (const batch of batches.slice(i, i + 16)) {
      mustOk(sendFrom(chain, funder, { action: "call", to: programs.token, method: "multiTransfer",
        input: { transfers: batch.map((s) => ({ to: s.address, amount: `${10n ** 18n}n` })) } }), "multiTransfer");
    }
    const closed = mine(chain);
    if (closed.failed) throw new Error(`แจก token ล้ม: ${closed.firstError}`);
  }
  return programs;
}

function runInProcess(kind, workload, txs) {
  const seed = OPTIONS.seed ?? `load:${workload}:${txs}`;
  const chain = createChain(kind, { senderCount: Math.max(txs, 16), seed });
  try {
    const programs = setupPrograms(chain, workload);
    const random = rng(seed);   // LMDB กับ memory ได้ลำดับ tx เดียวกัน
    const sizeBefore = dbStats(chain.db, chain.dir);
    const blocks = [];
    let cursor = 0;
    let index = 0;
    let rejectedAdds = 0;
    const rejectReasons = {};
    for (let b = 0; b < OPTIONS.warmup + OPTIONS.blocks; b += 1) {
      // เติมคิวให้ครบ txs ใบ (block ที่แก๊สเต็มทิ้งใบที่เหลือไว้ในคิว → เติมแค่ส่วนที่ขาด)
      const need = Math.max(0, txs - chain.mempool.size);
      const items = [];
      for (let i = 0; i < need; i += 1) {
        const wallet = chain.senders[cursor % chain.senders.length];
        cursor += 1;
        const nonce = chain.nonces.get(wallet.address) ?? 0;
        items.push({ wallet, nonce, item: signed(wallet, makeTx(workload, { random, programs, senders: chain.senders, index: index++, rounds: OPTIONS.rounds }), nonce, VM_OPTIONS.chainId) });
        chain.nonces.set(wallet.address, nonce + 1);
      }
      const sim = { ms: 0 };
      const addTimes = [];
      const addStart = performance.now();
      for (const { wallet, nonce, item } of items) {
        const start = performance.now();
        const result = addTx(chain, item, sim);
        addTimes.push(ms(start));
        if (!result.ok) {
          rejectedAdds += 1;
          const reason = String(result.reason ?? "").replace(/\d+/g, "N").slice(0, 80);
          rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
          // nonce ที่จองไว้ใช้ไม่ได้ → ถอยให้ใบถัดไปของกระเป๋านี้ใช้ nonce เดิม
          if (chain.nonces.get(wallet.address) === nonce + 1) chain.nonces.set(wallet.address, nonce);
        }
      }
      const addMs = ms(addStart);
      const closed = mine(chain, { measureRoots: true });
      const entry = { ...closed, submitted: items.length, addMs, simMs: sim.ms, addPerTxMs: addTimes.length ? addMs / addTimes.length : 0,
        addP95Ms: percentile(addTimes, 95), slotMs: addMs + closed.closeMs, pending: chain.mempool.size, warmup: b < OPTIONS.warmup };
      blocks.push(entry);
      if (!QUICK) process.stdout.write(`\r  ${kind.padEnd(6)} ${workload.padEnd(6)} ${String(txs).padStart(3)} tx  block ${b + 1}/${OPTIONS.warmup + OPTIONS.blocks}  close ${fmt(closed.closeMs)} ms   `);
    }
    if (!QUICK) process.stdout.write("\r\x1b[K");
    const sizeAfter = dbStats(chain.db, chain.dir);
    return summarize({ mode: "in-process", db: kind, workload, txs, blocks, sizeBefore, sizeAfter, rejectedAdds, rejectReasons });
  } finally {
    if (chain.dir) {
      chain.db.close();
      if (!OPTIONS.keep) fs.rmSync(chain.dir, { recursive: true, force: true });
      else console.log(`  เก็บ LMDB ไว้ที่ ${chain.dir}`);
    }
  }
}

function summarize({ blocks, sizeBefore, sizeAfter, ...rest }) {
  const measured = blocks.filter((b) => !b.warmup);
  const pick = (field) => measured.map((b) => b[field]).filter((v) => v !== null && v !== undefined);
  const txTotal = sum(pick("txs"));
  const gasTotal = sum(pick("gasUsed"));
  const closeTotal = sum(pick("closeMs"));
  const slotTotal = sum(pick("slotMs"));
  const timing = {};
  for (const field of ["addMs", "simMs", "addPerTxMs", "takeMs", "rootsMs", "commitMs", "writeMs", "closeMs", "slotMs"]) {
    const s = stats(pick(field));
    timing[field] = { p50: round(s.p50, 2), p95: round(s.p95, 2), max: round(s.max, 2), mean: round(s.mean, 2) };
  }
  const growth = sizeBefore && sizeAfter ? {
    entries: sizeAfter.entries - sizeBefore.entries,
    fileBytes: sizeAfter.fileBytes === null ? null : sizeAfter.fileBytes - sizeBefore.fileBytes,
    usedBytes: sizeAfter.usedBytes === undefined ? null : sizeAfter.usedBytes - sizeBefore.usedBytes,
  } : null;
  return {
    ...rest,
    measuredBlocks: measured.length,
    txPerBlock: measured.length ? round(txTotal / measured.length, 1) : 0,
    gasPerBlock: measured.length ? Math.round(gasTotal / measured.length) : 0,
    gasPerTx: txTotal ? Math.round(gasTotal / txTotal) : 0,
    failedTxs: sum(pick("failed")),
    closeTxPerSec: closeTotal ? round((txTotal / closeTotal) * 1000, 0) : null,          // รัน + commit อย่างเดียว
    slotTxPerSec: slotTotal ? round((txTotal / slotTotal) * 1000, 0) : null,             // รวมรับ tx (ตรวจลายเซ็น + simulate)
    closeGasPerSec: closeTotal ? Math.round((gasTotal / closeTotal) * 1000) : null,
    timing, sizeBefore, sizeAfter, growth,
    bytesPerTx: growth?.usedBytes && txTotal ? Math.round(growth.usedBytes / sum(blocks.map((b) => b.txs))) : null,
    blocks: blocks.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === "number" ? round(v, 2) : v]))),
  };
}

function printTable(runs) {
  const head = ["db", "work", "tx/blk", "gas/blk", "add p50", "take p50", "roots p50", "commit p50", "write p50", "close p50", "close p95", "close max", "slot p95", "tx/s close", "tx/s slot", "Mgas/s", "DB +/tx"];
  const rows = runs.map((r) => [r.db, r.workload, `${fmt(r.txPerBlock)}`, fmt(r.gasPerBlock), fmt(r.timing.addMs.p50), fmt(r.timing.takeMs.p50),
    fmt(r.timing.rootsMs.p50, 1), fmt(r.timing.commitMs.p50), fmt(r.timing.writeMs.p50, 1), fmt(r.timing.closeMs.p50), fmt(r.timing.closeMs.p95),
    fmt(r.timing.closeMs.max), fmt(r.timing.slotMs.p95), fmt(r.closeTxPerSec), fmt(r.slotTxPerSec), fmt(r.closeGasPerSec / 1e6, 2),
    r.bytesPerTx === null ? "-" : `${fmt(r.bytesPerTx)} B`]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) => cells.map((cell, i) => (i < 2 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]))).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log("(ms ต่อ block · add = mempool.add ทั้ง block (ลายเซ็น + simulate) · close = take + commit · slot = add + close · DB +/tx = LMDB ที่ใช้เพิ่มต่อ tx)");
}

// ============================================================================
//  โหมด --url: end-to-end ผ่าน /sendtx ของ server ที่รันอยู่
// ============================================================================

async function runUrl() {
  const API = OPTIONS.url.replace(/\/$/, "");
  const get = async (route) => (await fetch(API + route)).json();
  const post = async (route, body) => {
    const response = await fetch(API + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 429) throw new Error("server ตอบ 429 — เปิด server ด้วย RATE_LIMIT=0");
    return response.json();
  };
  const genesis = await get("/genesis");
  const chainId = genesis.chainId;
  const seed = OPTIONS.seed ?? `load-url:${Date.now()}`;
  const txs = Math.max(...OPTIONS.txs);
  const senderCount = Math.max(txs, 16);
  if (senderCount > 800) throw new Error("โหมด --url รองรับไม่เกิน 800 tx ต่อ block (กระเป๋าละ 1 ใบ)");
  const funder = { key: OPTIONS.funderKey, address: sign.addressOf(OPTIONS.funderKey) };
  const admin = OPTIONS.adminKey ? { key: OPTIONS.adminKey, address: sign.addressOf(OPTIONS.adminKey) } : funder;
  const senders = Array.from({ length: senderCount }, (_, i) => walletOf(`${seed}:sender:${i}`));
  const hubs = Array.from({ length: Math.ceil(senderCount / 50) }, (_, i) => walletOf(`${seed}:hub:${i}`));
  const nonces = new Map();
  const nonceOf = async (wallet) => { if (!nonces.has(wallet.address)) nonces.set(wallet.address, (await get(`/nonce/${wallet.address}`)).nonce); return nonces.get(wallet.address); };
  const send = async (wallet, fields, label) => {
    const nonce = await nonceOf(wallet);
    const result = await post("/sendtx", signed(wallet, fields, nonce, chainId));
    if (!result.queued) throw new Error(`${label} ถูกปฏิเสธ: ${JSON.stringify(result.simulation?.error ?? result.error ?? result.reason ?? result)}`);
    nonces.set(wallet.address, nonce + 1);
    return result.hash;
  };
  let lastSeen = genesis.latest ?? 0;
  const nextBlock = async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const { latest } = await get("/genesis");
      if ((latest ?? 0) > lastSeen) return (lastSeen = latest);
      await wait(50);
    }
    throw new Error("ไม่มี block ใหม่ใน 120 วินาที");
  };
  const settle = async (hashes) => {
    for (const hash of hashes) {
      for (;;) {
        const found = await get(`/tx/${hash}`);
        if (found.blockNumber) { if (found.status !== "success") throw new Error(`tx ${hash} ล้ม: ${JSON.stringify(found.error)}`); break; }
        if (found.status !== "pending") throw new Error(`tx ${hash}: ${JSON.stringify(found)}`);
        await nextBlock();
      }
    }
  };

  console.log(`โหมด end-to-end: ${API} · chainId ${chainId} · ${senderCount} กระเป๋า · ${hubs.length} กระเป๋ากลาง`);
  // เติม native: funder → กระเป๋ากลาง → ผู้ส่ง (≤ 50 ใบต่อกระเป๋ากลาง ไม่เกิน rate limit 60 ใบ/นาที)
  const perSender = 10n * COIN;
  const hubFunding = [];
  for (const [i, hub] of hubs.entries()) hubFunding.push(await send(funder, { action: "transfer", to: hub.address, value: `${perSender * 51n}` }, `fund hub ${i}`));
  await settle(hubFunding);
  for (let round = 0; round < 4; round += 1) {
    const hashes = [];
    for (const [h, hub] of hubs.entries()) {
      const mine = senders.slice(h * 50, h * 50 + 50).slice(round * 15, round * 15 + 15);
      for (const sender of mine) hashes.push(await send(hub, { action: "transfer", to: sender.address, value: `${perSender}` }, "fund sender"));
    }
    if (hashes.length) await settle(hashes);
  }
  const programs = {};
  const workload = OPTIONS.workloads[0];
  if (workload !== "native") {
    programs.token = new VirtualMachine(new MemoryDB(), { chainId }).programAddressFor(funder.address, await nonceOf(funder));
    const deploys = [await send(funder, { action: "deploy", code: TOKEN_PROGRAM, input: { name: "Load Token", ticker: "LOAD", decimals: "6n", supply: `${10n ** 30n}n` } }, "deploy token")];
    if (workload === "mix") {
      programs.mix = new VirtualMachine(new MemoryDB(), { chainId }).programAddressFor(funder.address, await nonceOf(funder));
      deploys.push(await send(funder, { action: "deploy", code: MIX_PROGRAM, input: { token: programs.token } }, "deploy mix"));
    }
    await settle(deploys);
    const inits = [];
    for (const name of Object.keys(programs)) inits.push(await send(admin, { action: "init", to: programs[name] }, `init ${name}`));
    await settle(inits);
    const transfers = [];
    for (let i = 0; i < senders.length; i += 100) {
      transfers.push(await send(funder, { action: "call", to: programs.token, method: "multiTransfer",
        input: { transfers: senders.slice(i, i + 100).map((s) => ({ to: s.address, amount: `${10n ** 18n}n` })) } }, "multiTransfer"));
    }
    await settle(transfers);
  }
  console.log(`เตรียมเสร็จ (block ${lastSeen}) · ยิง ${txs} tx × ${OPTIONS.blocks} รอบ · workload ${workload}`);

  const random = rng(`${seed}:url`);
  const rounds = [];
  let index = 0;
  for (let r = 0; r < OPTIONS.blocks; r += 1) {
    const items = senders.slice(0, txs).map((wallet) => ({ wallet, fields: makeTx(workload, { random, programs, senders, index: index++, rounds: OPTIONS.rounds }) }));
    const signedItems = [];
    for (const { wallet, fields } of items) {
      const nonce = await nonceOf(wallet);
      signedItems.push({ wallet, nonce, body: signed(wallet, fields, nonce, chainId) });
    }
    const latencies = [];
    const accepted = [];
    const rejected = {};
    const startBlock = lastSeen;
    const start = performance.now();
    let next = 0;
    await Promise.all(Array.from({ length: OPTIONS.concurrency }, async () => {
      while (next < signedItems.length) {
        const item = signedItems[next++];
        const t = performance.now();
        const result = await post("/sendtx", item.body);
        latencies.push(ms(t));
        if (result.queued) { accepted.push(result.hash); nonces.set(item.wallet.address, item.nonce + 1); }
        else { const reason = String(result.simulation?.error ?? result.error ?? result.reason).slice(0, 80); rejected[reason] = (rejected[reason] ?? 0) + 1; }
      }
    }));
    const sendMs = ms(start);
    await settle(accepted);
    const includeMs = ms(start);
    const headers = [];
    for (let n = startBlock + 1; n <= lastSeen; n += 1) headers.push(await get(`/block/${n}`));
    const s = stats(latencies);
    rounds.push({ submitted: signedItems.length, accepted: accepted.length, rejected, sendMs: round(sendMs, 1), includeMs: round(includeMs, 1),
      sendtxPerSec: round((signedItems.length / sendMs) * 1000, 0), latency: { p50: round(s.p50, 1), p95: round(s.p95, 1), max: round(s.max, 1) },
      blocks: headers.map((h) => ({ number: h.number, txCount: h.txCount, gasUsed: h.gasUsed, timestamp: h.timestamp })) });
    console.log(`รอบ ${r + 1}: /sendtx ${signedItems.length} ใบใน ${fmt(sendMs)} ms (${fmt((signedItems.length / sendMs) * 1000)} req/s · p50 ${fmt(s.p50, 1)} p95 ${fmt(s.p95, 1)} max ${fmt(s.max, 1)} ms)`
      + ` · รับ ${accepted.length} · เข้า block ${headers.map((h) => `#${h.number}:${h.txCount}`).join(" ")} ใน ${fmt(includeMs)} ms`);
  }
  const all = rounds.flatMap((r) => r.latency ? [r] : []);
  return { mode: "url", url: API, workload, txs, rounds, summary: {
    sendtxPerSec: stats(all.map((r) => r.sendtxPerSec)), latencyP95: stats(all.map((r) => r.latency.p95)),
    acceptedRate: sum(rounds.map((r) => r.accepted)) / sum(rounds.map((r) => r.submitted)) } };
}

// ============================================================================

async function main() {
  const report = { startedAt: new Date().toISOString(), node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model,
    options: { ...OPTIONS, funderKey: undefined, adminKey: undefined }, vmOptions: { ...VM_OPTIONS, gas: undefined, minBaseFee: `${VM_OPTIONS.minBaseFee}` } };
  if (OPTIONS.url) {
    report.url = await runUrl();
  } else {
    const kinds = OPTIONS.db === "both" ? ["lmdb", "memory"] : [OPTIONS.db];
    console.log(`load test ในโปรเซส · ${kinds.join(" + ")} · workload ${OPTIONS.workloads.join(", ")} · ${OPTIONS.txs.join(" / ")} tx · ${OPTIONS.blocks} block (+${OPTIONS.warmup} อุ่นเครื่อง)`
      + (kinds.includes("lmdb") ? ` · LMDB ที่ ${OPTIONS.dataDir}` : ""));
    report.runs = [];
    for (const workload of OPTIONS.workloads) {
      for (const txs of OPTIONS.txs) {
        for (const kind of kinds) report.runs.push(runInProcess(kind, workload, txs));
      }
    }
    console.log("");
    printTable(report.runs.map((r) => ({ ...r, workload: `${r.workload} ${r.txs}` })));
    const problems = report.runs.filter((r) => r.failedTxs || r.rejectedAdds);
    for (const r of problems) console.log(`⚠️ ${r.db} ${r.workload} ${r.txs}: tx ล้มใน block ${r.failedTxs} · ถูกปฏิเสธตอนรับ ${r.rejectedAdds} ${JSON.stringify(r.rejectReasons)}`);
  }
  report.finishedAt = new Date().toISOString();
  if (OPTIONS.out) {
    fs.writeFileSync(OPTIONS.out, JSON.stringify(report, (key, value) => (typeof value === "bigint" ? `${value}` : value), 2));
    console.log(`รายงาน JSON: ${OPTIONS.out}`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
