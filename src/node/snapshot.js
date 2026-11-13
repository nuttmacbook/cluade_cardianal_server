/**
 * State snapshots (phase 4.1) — a new node starts from the state at block N instead of replaying from block 1
 *
 *   await writeSnapshot(vm, "snap-1000.ndjson.gz")               // producer side (or any node)
 *   await loadSnapshot(vm, readSnapshotFile("snap-1000.ndjson.gz"), { producers })   // empty DB → state at block 1000
 *   await syncFromSnapshot(vm, { url, producers })              // download from another node's /snapshot, then startSync from block N + 1
 *
 * File = JSON lines (gzip):
 *   first line   { type: "cardianal-snapshot", version, chainId, genesisHash, number, hash, stateRoot }
 *   then         { header } of blocks max(1, N − 255) … N (BlockHash looks back 256 blocks · the next block's base fee comes from header N)
 *   then         [dbKey, value] of the state at block N (keys may repeat with the same value)
 *   last line    { end: true, lines } (missing = incomplete file)
 *
 * The loader needn't trust the sender: every header hash can be recomputed · chained by parentHash · the producer signed header N (producers)
 *   → header N's stateRoot is trustworthy → the trie built from the loaded state must give the same root byte for byte (mismatch = wipe, then throw)
 * Export doesn't stop the chain: reads in batches interleaved with other work · blocks sealed meanwhile don't matter (values at block N are read from history · requires recordHistory)
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
// key ranges that aren't state (skipped as whole ranges during export · no need to walk history / blocks / indexes key by key)
const SKIP_HEADS = new Set(["history", "block", "blockbody", "blockundo", "blockhash", "blockrejected", "tx", "sigtx", "txto",
  "event", "eventidx", "eventsig", "holding", "rejtx", "rejfrom", "trie"]);
const pause = () => new Promise((resolve) => setImmediate(resolve));

/**
 * snapshot lines at block number (default = latest) — async: yields every batch of keys so the server can do other work
 */
export async function* snapshotLines(vm, { number = vm.latestBlockNumber(), batch = 2_000 } = {}) {
  if (number === null || number === undefined || number < 1) throw new Error("no blocks to snapshot yet");
  const header = vm.getBlock(number);
  if (!header) throw new Error(`no block ${number}`);
  let lines = 0;
  const line = (value) => { lines += 1; return `${JSON.stringify(value)}\n`; };
  yield line({ type: SNAPSHOT_TYPE, version: SNAPSHOT_VERSION, chainId: vm.chainId, genesisHash: vm.genesisHash(),
    number, hash: header.hash, stateRoot: header.stateRoot });
  for (let n = Math.max(1, number - BLOCK_HASH_WINDOW + 1); n <= number; n += 1) {
    const item = vm.getBlock(n);
    if (!item) throw new Error(`no header for block ${n}`);
    yield line({ header: item });
  }

  // state at block N = current values rolled back via the history of blocks after N (stateAt) · keys deleted after N are collected from blockundo below
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
    if (!vm.recordHistory || (vm.historyFrom() ?? 1) > number + 1) throw new Error(`history after block ${number} is incomplete (new blocks arrived during export) — enable recordHistory / increase HISTORY_KEEP_BLOCKS`);
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

/** write a snapshot to a file (.gz = gzip) via a temp file then rename → { file, number, hash, stateRoot, size } */
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

/** lines of a file / stream (gzip or not — detected from the first 2 bytes) */
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
 * Load a snapshot into a DB with no blocks yet → manifest · checks everything before setting latestblock (failure = wipes the state already written, then throws)
 *   producers = the producer list in genesis (omitted = signed headers must have valid signatures, but the signer isn't restricted)
 */
export async function loadSnapshot(vm, lines, { producers = null, batch = 5_000 } = {}) {
  if (vm.latestBlockNumber() !== null) throw new Error("a snapshot can only be loaded into a DB with no blocks");
  let manifest = null;
  const headers = [];
  let pending = [];
  let ended = false;
  let keys = 0;
  wipeState(vm, batch);   // the genesis already applied (applyGenesis) is replaced by the snapshot's full state
  const flush = () => { if (pending.length) vm.db.writeKeys(pending); keys += pending.length; pending = []; };
  try {
    for await (const text of lines) {
      if (ended) throw new Error("snapshot has data after the last line");
      const item = JSON.parse(text);
      if (!manifest) {
        manifest = checkManifest(vm, item);
      } else if (Array.isArray(item)) {
        const [dbKey, value] = item;
        if (typeof dbKey !== "string" || !isStateKey(dbKey) || value === undefined) throw new Error(`snapshot has a non-state key: ${dbKey}`);
        pending.push({ type: "put", dbKey, value });
        if (pending.length >= batch) { flush(); await pause(); }
      } else if (item?.header) {
        headers.push(item.header);
      } else if (item?.end) {
        ended = true;
      } else {
        throw new Error("snapshot has an unknown line");
      }
    }
    if (!manifest) throw new Error("snapshot is empty");
    if (!ended) throw new Error("snapshot is incomplete (no last line)");
    flush();
    const tip = checkHeaders(vm, manifest, headers, producers);
    const { root } = vm.rebuildTrie();
    if (root !== tip.stateRoot) throw new Error(`state in the snapshot does not match the stateRoot of block ${tip.number} (got ${root} / header ${tip.stateRoot})`);
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
    { type: "put", dbKey: HISTORY_FROM_KEY, value: manifest.number + 1 },   // no earlier history: lookback / replay available from the next block
    { type: "put", dbKey: LATEST_BLOCK_KEY, value: manifest.number },
  ]);
  return { ...manifest, keys };
}

function checkManifest(vm, item) {
  if (item?.type !== SNAPSHOT_TYPE) throw new Error("not a snapshot file");
  if (item.version !== SNAPSHOT_VERSION) throw new Error(`snapshot version ${item.version} (supported: ${SNAPSHOT_VERSION})`);
  if (item.chainId !== vm.chainId) throw new Error(`snapshot is for chainId ${item.chainId} (this node: ${vm.chainId})`);
  const genesis = vm.genesisHash();
  if (genesis !== null && genesis !== item.genesisHash) throw new Error(`genesis mismatch (snapshot ${item.genesisHash} / this node ${genesis})`);
  if (!Number.isSafeInteger(item.number) || item.number < 1) throw new Error("invalid snapshot block number");
  return item;
}

/** headers chained up to block N · hashes recomputable · signed by the producer → header N */
function checkHeaders(vm, manifest, headers, producers) {
  const first = Math.max(1, manifest.number - BLOCK_HASH_WINDOW + 1);
  if (headers.length !== manifest.number - first + 1) throw new Error(`snapshot must contain headers for blocks ${first}–${manifest.number}`);
  headers.forEach((header, index) => {
    if (header.number !== first + index) throw new Error("headers in the snapshot are not consecutive");
    if (vm.hashHeader(header) !== header.hash) throw new Error(`hash of header ${header.number} does not match its data`);
    if (index > 0 && header.parentHash !== headers[index - 1].hash) throw new Error(`header ${header.number} does not link to the previous block`);
    verifyProducer(header, producers);
  });
  const tip = headers.at(-1);
  if (tip.hash !== manifest.hash || tip.stateRoot !== manifest.stateRoot) throw new Error("the snapshot's first line does not match that block's header");
  return tip;
}

/** delete all state + trie (only for a DB with no blocks) */
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
 * New node: the DB has no blocks and the source node has snapshots → load the source's latest snapshot (fully checked) → manifest
 * source has no snapshot / DB already has blocks → null (sync the usual way from the next block)
 */
export async function syncFromSnapshot(vm, { url, producers = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (vm.latestBlockNumber() !== null) return null;
  const info = await fetchImpl(`${url}/snapshot`);
  if (info.status === 404) return null;
  if (!info.ok) throw new Error(`cannot request snapshot: ${info.status}`);
  const { number } = await info.json();
  const file = await fetchImpl(`${url}/snapshot/${number}`);
  if (!file.ok) throw new Error(`cannot download snapshot: ${file.status}`);
  return loadSnapshot(vm, snapshotStreamLines(Readable.fromWeb(file.body)), { producers });
}

/**
 * Snapshot provider side: take one every `every` blocks into dir (snapshot-<N>.ndjson.gz), keeping the latest `keep` files
 *   const snapshots = createSnapshotter(vm, { dir, every: 10_000 });  snapshots.onBlock(number)  ·  snapshots.latest()
 * one at a time (if still running, the next due block is skipped) · failure = log and wait for the next round
 */
export function createSnapshotter(vm, { dir, every, keep = 2, log = console } = {}) {
  if (!dir || !Number.isSafeInteger(every) || every < 1) throw new Error("dir and every ≥ 1 are required");
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (number) => path.join(dir, `snapshot-${String(number).padStart(12, "0")}.ndjson.gz`);
  const list = () => fs.readdirSync(dir).filter((name) => /^snapshot-\d{12}\.ndjson\.gz$/.test(name)).sort();
  let running = null;
  return {
    dir,
    fileOf,
    /** { number, file, size } of the latest finished snapshot · none = null */
    latest() {
      const name = list().at(-1);
      if (!name) return null;
      const file = path.join(dir, name);
      return { number: Number(name.slice(9, 21)), file, size: fs.statSync(file).size };
    },
    /** called after every block commit → Promise of this round's snapshot (not due / already running = null) */
    onBlock(number) {
      if (number % every !== 0 || running) return null;
      running = writeSnapshot(vm, fileOf(number), { number })
        .then((result) => {
          for (const name of list().slice(0, -keep)) fs.rmSync(path.join(dir, name), { force: true });
          log?.log?.(`snapshot block ${number} done (${(result.size / 1e6).toFixed(1)} MB)`);
          return result;
        })
        .catch((error) => { log?.error?.(`snapshot block ${number} failed:`, error.message); return null; })
        .finally(() => { running = null; });
      return running;
    },
    get running() { return running; },
  };
}
