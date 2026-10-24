/**
 * snapshot ของ state (ระยะ 4.1) — node ใหม่เริ่มจาก state ณ block N แทนการ replay ตั้งแต่ block 1
 *
 *   await writeSnapshot(vm, "snap-1000.ndjson.gz")               // ฝั่งผู้ผลิต (หรือ node ใดก็ได้)
 *   await loadSnapshot(vm, readSnapshotFile("snap-1000.ndjson.gz"), { producers })   // DB ว่าง → state ณ block 1000
 *   await syncFromSnapshot(vm, { url, producers })              // ดาวน์โหลดจาก /snapshot ของ node อื่น แล้ว startSync ต่อจาก block N + 1
 *
 * ไฟล์ = JSON lines (gzip):
 *   บรรทัดแรก   { type: "cardianal-snapshot", version, chainId, genesisHash, number, hash, stateRoot }
 *   ต่อมา        { header } ของ block max(1, N − 255) … N (BlockHash ย้อนได้ 256 block · base fee ของ block ถัดไปมาจาก header N)
 *   ต่อมา        [dbKey, value] ของ state ณ block N (key ซ้ำได้ ค่าเดียวกัน)
 *   บรรทัดท้าย   { end: true, lines } (ไม่มี = ไฟล์ไม่ครบ)
 *
 * ผู้โหลดไม่ต้องเชื่อคนส่ง: hash ของทุก header คำนวณกลับได้ · ต่อกันด้วย parentHash · ผู้ผลิตเซ็น header N (producers)
 *   → stateRoot ของ header N เชื่อได้ → สร้าง trie จาก state ที่โหลดมาแล้วต้องได้ root เดียวกันทุกไบต์ (ไม่ตรง = ล้างแล้ว throw)
 * export ไม่หยุดเชน: อ่านทีละชุดสลับกับงานอื่น · block ที่ปิดระหว่างนั้นไม่กระทบ (อ่านค่า ณ block N จาก history · ต้อง recordHistory)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { Readable } from "node:stream";
import { isStateKey, blockKey, blockHashKey, LATEST_BLOCK_KEY, HISTORY_FROM_KEY, BLOCK_HASH_WINDOW } from "../core/virtualmachine.js";
import { verifyProducer } from "./sync.js";

export const SNAPSHOT_TYPE = "cardianal-snapshot";
export const SNAPSHOT_VERSION = 1;
const GENESIS_KEY = "genesis";
// ช่วงของ key ที่ไม่ใช่ state (กระโดดข้ามทั้งช่วงตอน export · ไม่ต้องไล่ history / block / ดัชนีทีละ key)
const SKIP_HEADS = new Set(["history", "block", "blockbody", "blockundo", "blockhash", "blockrejected", "tx", "sigtx", "txto",
  "event", "eventidx", "eventsig", "holding", "rejtx", "rejfrom", "trie"]);
const pause = () => new Promise((resolve) => setImmediate(resolve));

/**
 * บรรทัดของ snapshot ณ block number (ค่าเริ่ม = ล่าสุด) — async: พักทุก batch key ให้ server ทำงานอื่นได้
 */
export async function* snapshotLines(vm, { number = vm.latestBlockNumber(), batch = 2_000 } = {}) {
  if (number === null || number === undefined || number < 1) throw new Error("ยังไม่มี block ให้ทำ snapshot");
  const header = vm.getBlock(number);
  if (!header) throw new Error(`ไม่มี block ${number}`);
  let lines = 0;
  const line = (value) => { lines += 1; return `${JSON.stringify(value)}\n`; };
  yield line({ type: SNAPSHOT_TYPE, version: SNAPSHOT_VERSION, chainId: vm.chainId, genesisHash: vm.genesisHash(),
    number, hash: header.hash, stateRoot: header.stateRoot });
  for (let n = Math.max(1, number - BLOCK_HASH_WINDOW + 1); n <= number; n += 1) {
    const item = vm.getBlock(n);
    if (!item) throw new Error(`ไม่มี header ของ block ${n}`);
    yield line({ header: item });
  }

  // state ณ block N = ค่าตอนนี้ย้อนด้วย history ของ block หลัง N (stateAt) · key ที่ถูกลบหลัง N เก็บจาก blockundo ด้านล่าง
  const valueAt = (dbKey) => (vm.latestBlockNumber() === number ? vm.read(dbKey) : vm.stateAt(number, dbKey));
  for (let start; ;) {
    const keys = vm.listKeys("", { start, limit: batch + 1 });
    const out = [];
    let jump = null;
    for (const dbKey of keys.slice(0, batch)) {
      const head = dbKey.split(":", 1)[0];
      if (SKIP_HEADS.has(head) && dbKey.startsWith(`${head}:`)) { jump = `${head};`; break; }
      if (!isStateKey(dbKey)) continue;
      const value = valueAt(dbKey);
      if (value !== undefined) out.push(line([dbKey, value]));
    }
    if (out.length) yield out.join("");
    if (jump) { start = jump; continue; }
    if (keys.length <= batch) break;
    start = keys[batch];
    await pause();
  }
  const latest = vm.latestBlockNumber();
  if (latest > number) {
    if (!vm.recordHistory || (vm.historyFrom() ?? 1) > number + 1) throw new Error(`history หลัง block ${number} ไม่ครบ (มี block ใหม่ระหว่าง export) — เปิด recordHistory / เพิ่ม HISTORY_KEEP_BLOCKS`);
    const seen = new Set();
    for (let n = number + 1; n <= latest; n += 1) {
      const out = [];
      for (const dbKey of vm.getBlockUndo(n) ?? []) {
        if (seen.has(dbKey)) continue;
        seen.add(dbKey);
        const value = vm.stateAt(number, dbKey);
        if (value !== undefined) out.push(line([dbKey, value]));
      }
      if (out.length) yield out.join("");
    }
  }
  yield line({ end: true, lines: lines + 1 });
}

/** เขียน snapshot ลงไฟล์ (.gz = gzip) แบบเขียนไฟล์ชั่วคราวแล้วเปลี่ยนชื่อ → { file, number, hash, stateRoot, size } */
export async function writeSnapshot(vm, file, options = {}) {
  const tmp = `${file}.tmp`;
  const out = fs.createWriteStream(tmp);
  const sink = file.endsWith(".gz") ? zlib.createGzip() : null;
  if (sink) sink.pipe(out);
  const target = sink ?? out;
  let manifest = null;
  try {
    for await (const chunk of snapshotLines(vm, options)) {
      manifest ??= JSON.parse(chunk.slice(0, chunk.indexOf("\n")));
      if (!target.write(chunk)) await new Promise((resolve) => target.once("drain", resolve));
    }
    await new Promise((resolve, reject) => { out.once("finish", resolve); out.once("error", reject); target.end(); });
    fs.renameSync(tmp, file);
  } catch (error) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return { file, number: manifest.number, hash: manifest.hash, stateRoot: manifest.stateRoot, size: fs.statSync(file).size };
}

/** บรรทัดของไฟล์ / stream (gzip หรือไม่ก็ได้ — ดูจาก 2 byte แรก) */
export async function* snapshotStreamLines(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  const head = Buffer.from(first.value);
  const rest = Readable.from((async function* () { yield head; for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; } })());
  const source = head[0] === 0x1f && head[1] === 0x8b ? rest.pipe(zlib.createGunzip()) : rest;
  for await (const text of readline.createInterface({ input: source, crlfDelay: Infinity })) if (text) yield text;
}

export const readSnapshotFile = (file) => snapshotStreamLines(fs.createReadStream(file));

/**
 * โหลด snapshot ลง DB ที่ยังไม่มี block → manifest · ตรวจทุกอย่างก่อนตั้ง latestblock (ไม่ผ่าน = ล้าง state ที่เขียนไปแล้ว throw)
 *   producers = รายชื่อผู้ผลิตใน genesis (ไม่ส่ง = header ที่มีลายเซ็นต้องเซ็นถูก แต่ไม่บังคับว่าเป็นใคร)
 */
export async function loadSnapshot(vm, lines, { producers = null, batch = 5_000 } = {}) {
  if (vm.latestBlockNumber() !== null) throw new Error("โหลด snapshot ได้เฉพาะ DB ที่ยังไม่มี block");
  let manifest = null;
  const headers = [];
  let pending = [];
  let ended = false;
  let keys = 0;
  wipeState(vm, batch);   // genesis ที่ใส่ไว้แล้ว (applyGenesis) ถูกแทนด้วย state ของ snapshot ทั้งชุด
  const flush = () => { if (pending.length) vm.db.writeKeys(pending); keys += pending.length; pending = []; };
  try {
    for await (const text of lines) {
      if (ended) throw new Error("snapshot มีข้อมูลหลังบรรทัดท้าย");
      const item = JSON.parse(text);
      if (!manifest) {
        manifest = checkManifest(vm, item);
      } else if (Array.isArray(item)) {
        const [dbKey, value] = item;
        if (typeof dbKey !== "string" || !isStateKey(dbKey) || value === undefined) throw new Error(`snapshot มี key ที่ไม่ใช่ state: ${dbKey}`);
        pending.push({ type: "put", dbKey, value });
        if (pending.length >= batch) { flush(); await pause(); }
      } else if (item?.header) {
        headers.push(item.header);
      } else if (item?.end) {
        ended = true;
      } else {
        throw new Error("snapshot มีบรรทัดที่ไม่รู้จัก");
      }
    }
    if (!manifest) throw new Error("snapshot ว่าง");
    if (!ended) throw new Error("snapshot ไม่ครบ (ไม่มีบรรทัดท้าย)");
    flush();
    const tip = checkHeaders(vm, manifest, headers, producers);
    const { root } = vm.rebuildTrie();
    if (root !== tip.stateRoot) throw new Error(`state ใน snapshot ไม่ตรงกับ stateRoot ของ block ${tip.number} (ได้ ${root} / header ${tip.stateRoot})`);
  } catch (error) {
    wipeState(vm, batch);
    throw error;
  }
  vm.db.writeKeys([
    ...headers.flatMap((header) => [
      { type: "put", dbKey: blockKey(header.number), value: header },
      { type: "put", dbKey: blockHashKey(header.hash), value: header.number },
    ]),
    { type: "put", dbKey: GENESIS_KEY, value: manifest.genesisHash },
    { type: "put", dbKey: HISTORY_FROM_KEY, value: manifest.number + 1 },   // ไม่มี history ก่อนหน้า: ย้อนดู / replay ได้ตั้งแต่ block ถัดไป
    { type: "put", dbKey: LATEST_BLOCK_KEY, value: manifest.number },
  ]);
  return { ...manifest, keys };
}

function checkManifest(vm, item) {
  if (item?.type !== SNAPSHOT_TYPE) throw new Error("ไม่ใช่ไฟล์ snapshot");
  if (item.version !== SNAPSHOT_VERSION) throw new Error(`snapshot รุ่น ${item.version} (รองรับ ${SNAPSHOT_VERSION})`);
  if (item.chainId !== vm.chainId) throw new Error(`snapshot เป็นของ chainId ${item.chainId} (node นี้ ${vm.chainId})`);
  const genesis = vm.genesisHash();
  if (genesis !== null && genesis !== item.genesisHash) throw new Error(`genesis ไม่ตรง (snapshot ${item.genesisHash} / node นี้ ${genesis})`);
  if (!Number.isSafeInteger(item.number) || item.number < 1) throw new Error("เลข block ของ snapshot ไม่ถูกต้อง");
  return item;
}

/** header ต่อกันถึง block N · hash คำนวณกลับได้ · ผู้ผลิตเซ็น → header N */
function checkHeaders(vm, manifest, headers, producers) {
  const first = Math.max(1, manifest.number - BLOCK_HASH_WINDOW + 1);
  if (headers.length !== manifest.number - first + 1) throw new Error(`snapshot ต้องมี header ของ block ${first}–${manifest.number}`);
  headers.forEach((header, index) => {
    if (header.number !== first + index) throw new Error("header ใน snapshot ไม่เรียงต่อกัน");
    if (vm.hashHeader(header) !== header.hash) throw new Error(`hash ของ header ${header.number} ไม่ตรงกับข้อมูลใน header`);
    if (index > 0 && header.parentHash !== headers[index - 1].hash) throw new Error(`header ${header.number} ไม่ต่อกับ block ก่อนหน้า`);
    verifyProducer(header, producers);
  });
  const tip = headers.at(-1);
  if (tip.hash !== manifest.hash || tip.stateRoot !== manifest.stateRoot) throw new Error("บรรทัดแรกของ snapshot ไม่ตรงกับ header ของ block นั้น");
  return tip;
}

/** ลบ state + trie ทั้งหมด (ใช้กับ DB ที่ยังไม่มี block เท่านั้น) */
function wipeState(vm, batch) {
  for (let start; ;) {
    const keys = vm.listKeys("", { start, limit: batch + 1 });
    const doomed = keys.slice(0, batch).filter((dbKey) => isStateKey(dbKey) || dbKey.startsWith("trie:"));
    if (doomed.length) vm.db.writeKeys(doomed.map((dbKey) => ({ type: "del", dbKey })));
    if (keys.length <= batch) break;
    start = keys[batch];
  }
}

/**
 * node ใหม่: DB ยังไม่มี block และ node ต้นทางมี snapshot → โหลด snapshot ล่าสุดของต้นทาง (ตรวจครบ) → manifest
 * ต้นทางไม่มี snapshot / DB มี block แล้ว → null (ซิงก์แบบเดิมตั้งแต่ block ถัดไป)
 */
export async function syncFromSnapshot(vm, { url, producers = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (vm.latestBlockNumber() !== null) return null;
  const info = await fetchImpl(`${url}/snapshot`);
  if (info.status === 404) return null;
  if (!info.ok) throw new Error(`ขอ snapshot ไม่ได้: ${info.status}`);
  const { number } = await info.json();
  const file = await fetchImpl(`${url}/snapshot/${number}`);
  if (!file.ok) throw new Error(`ดาวน์โหลด snapshot ไม่ได้: ${file.status}`);
  return loadSnapshot(vm, snapshotStreamLines(Readable.fromWeb(file.body)), { producers });
}

/**
 * ฝั่งที่ให้ snapshot: ถ่ายทุก every block ลง dir (snapshot-<N>.ndjson.gz) เก็บไว้ keep ไฟล์ล่าสุด
 *   const snapshots = createSnapshotter(vm, { dir, every: 10_000 });  snapshots.onBlock(number)  ·  snapshots.latest()
 * ถ่ายทีละครั้ง (ถ้ายังไม่เสร็จ block ที่ครบรอบถัดไปข้ามไป) · ล้ม = log แล้วรอรอบถัดไป
 */
export function createSnapshotter(vm, { dir, every, keep = 2, log = console } = {}) {
  if (!dir || !Number.isSafeInteger(every) || every < 1) throw new Error("ต้องมี dir และ every ≥ 1");
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (number) => path.join(dir, `snapshot-${String(number).padStart(12, "0")}.ndjson.gz`);
  const list = () => fs.readdirSync(dir).filter((name) => /^snapshot-\d{12}\.ndjson\.gz$/.test(name)).sort();
  let running = null;
  return {
    dir,
    fileOf,
    /** { number, file, size } ของ snapshot ล่าสุดที่เสร็จแล้ว · ไม่มี = null */
    latest() {
      const name = list().at(-1);
      if (!name) return null;
      const file = path.join(dir, name);
      return { number: Number(name.slice(9, 21)), file, size: fs.statSync(file).size };
    },
    /** เรียกหลัง commit ของทุก block → Promise ของการถ่ายรอบนี้ (ไม่ถึงรอบ / กำลังถ่าย = null) */
    onBlock(number) {
      if (number % every !== 0 || running) return null;
      running = writeSnapshot(vm, fileOf(number), { number })
        .then((result) => {
          for (const name of list().slice(0, -keep)) fs.rmSync(path.join(dir, name), { force: true });
          log?.log?.(`snapshot block ${number} เสร็จ (${(result.size / 1e6).toFixed(1)} MB)`);
          return result;
        })
        .catch((error) => { log?.error?.(`snapshot block ${number} ล้มเหลว:`, error.message); return null; })
        .finally(() => { running = null; });
      return running;
    },
    get running() { return running; },
  };
}
