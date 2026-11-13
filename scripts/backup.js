/**
 * Back up / restore a node's data (LMDB + the replaced-tx log)
 *
 *   npm run backup -- --data ./data --out ./backups               # back up while the server runs → ./backups/<time>/
 *   npm run backup -- --data ./data --out ./backups --keep 7      # keep the 7 latest sets (delete older ones)
 *   npm run backup -- --data ./data --out ./backups --compact     # skip free pages (smaller files, slower)
 *   npm run backup -- --verify ./backups/2026-10-24T05-00-00Z     # verify a backup set
 *   npm run backup -- --restore ./backups/2026-10-24T05-00-00Z --data ./data   # restore (stop the server first)
 *
 * Backup set = a folder with data.mdb (an LMDB copy at a single commit) + replaced-tx.jsonl (if any) + manifest.json
 * Verified after every backup: the copy opens · latest block matches the manifest · parentHash chains back --check-blocks blocks (default 1000)
 *   and blockhash:<hash> points back to the same number
 * Restore: the --data folder must be empty or absent · existing data → --force required (moves it to <data>.before-restore-<time>)
 */
import fs from "node:fs";
import path from "node:path";
import { DB } from "../src/storage/db.js";
import { blockKey, blockHashKey, LATEST_BLOCK_KEY } from "../src/core/virtualmachine.js";

const SIDE_FILES = ["replaced-tx.jsonl"];
const stamp = (date = new Date()) => date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

/** verify a backup set (or a data folder) → { latest, latestHash, genesis, checked } · invalid = throw */
export function verifyBackup(dir, { checkBlocks = 1000, expect = null } = {}) {
  if (!fs.existsSync(path.join(dir, "data.mdb"))) throw new Error(`${dir} has no data.mdb`);
  const db = new DB(dir);
  try {
    const [latest, genesis] = db.readKeys([LATEST_BLOCK_KEY, "genesis"]);
    let checked = 0;
    let latestHash = null;
    if (latest !== undefined && latest !== null) {
      let header = db.readKeys([blockKey(latest)])[0];
      if (!header) throw new Error(`no header for block ${latest}`);
      latestHash = header.hash;
      for (let n = latest; n >= 1 && checked < checkBlocks; n -= 1) {
        if (!header || header.number !== n) throw new Error(`header of block ${n} missing / number mismatch`);
        if (db.readKeys([blockHashKey(header.hash)])[0] !== n) throw new Error(`blockhash of block ${n} does not point back`);
        checked += 1;
        if (n === 1) break;
        const parent = db.readKeys([blockKey(n - 1)])[0];
        if (!parent || parent.hash !== header.parentHash) throw new Error(`block ${n} parentHash does not match block ${n - 1}`);
        header = parent;
      }
    }
    if (expect && (expect.latest !== (latest ?? null) || expect.latestHash !== latestHash)) {
      throw new Error(`does not match the manifest (manifest: block ${expect.latest} ${expect.latestHash} · copy: block ${latest} ${latestHash})`);
    }
    return { latest: latest ?? null, latestHash, genesis: genesis ?? null, checked };
  } finally {
    db.close();
  }
}

/** back up data → <out>/<time>/ → { dir, manifest } */
export async function backup({ data, out, compact = false, keep = null, checkBlocks = 1000, now = new Date() }) {
  if (!fs.existsSync(path.join(data, "data.mdb"))) throw new Error(`${data} has no data.mdb (not a server DATA folder)`);
  const dir = path.join(out, stamp(now));
  const db = new DB(data);
  try {
    await db.backup(dir, { compact });
  } finally {
    db.close();
  }
  // the log next to LMDB (append-only · the copy may miss a last line being written, which TxLog already skips as unreadable)
  for (const name of SIDE_FILES) if (fs.existsSync(path.join(data, name))) fs.copyFileSync(path.join(data, name), path.join(dir, name));
  const info = verifyBackup(dir, { checkBlocks });
  const manifest = { createdAt: now.toISOString(), source: path.resolve(data), compact, ...info,
    bytes: fs.statSync(path.join(dir, "data.mdb")).size, files: fs.readdirSync(dir).filter((name) => name !== "lock.mdb") };
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(path.join(dir, "lock.mdb"), { force: true });
  if (keep) prune(out, keep);
  return { dir, manifest };
}

/** keep the latest `keep` backup sets (only folders with manifest.json) → names deleted */
export function prune(out, keep) {
  const sets = fs.readdirSync(out).filter((name) => fs.existsSync(path.join(out, name, "manifest.json"))).sort();
  const removed = sets.slice(0, Math.max(0, sets.length - keep));
  for (const name of removed) fs.rmSync(path.join(out, name), { recursive: true, force: true });
  return removed;
}

/** restore a backup set to data (the server must be stopped) → { data, moved } */
export function restore({ from, data, force = false, now = new Date() }) {
  const manifestFile = path.join(from, "manifest.json");
  const expect = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
  verifyBackup(from, { expect });
  let moved = null;
  if (fs.existsSync(data) && fs.readdirSync(data).length) {
    if (!force) throw new Error(`${data} already has data — pass --force to move it aside before restoring`);
    moved = `${path.resolve(data)}.before-restore-${stamp(now)}`;
    fs.renameSync(data, moved);
  }
  fs.mkdirSync(data, { recursive: true });
  for (const name of ["data.mdb", ...SIDE_FILES]) if (fs.existsSync(path.join(from, name))) fs.copyFileSync(path.join(from, name), path.join(data, name));
  return { data: path.resolve(data), moved };
}

if (process.argv[1]?.endsWith("backup.js")) {
  const args = process.argv.slice(2);
  const option = (name, fallback = null) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
  };
  try {
    if (option("verify")) {
      const dir = option("verify");
      const manifestFile = path.join(dir, "manifest.json");
      const expect = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
      const info = verifyBackup(dir, { expect, checkBlocks: Number(option("check-blocks", 1000)) });
      console.log(`backup is valid: latest block ${info.latest} (${info.latestHash}) · checked ${info.checked} blocks`);
    } else if (option("restore")) {
      const result = restore({ from: option("restore"), data: option("data", "./data"), force: args.includes("--force") });
      console.log(`restored to ${result.data}${result.moved ? ` · old data moved to ${result.moved}` : ""} — start the server with DATA=${result.data}`);
    } else {
      const { dir, manifest } = await backup({ data: option("data", process.env.DATA ?? "./data"), out: option("out", "./backups"),
        compact: args.includes("--compact"), keep: option("keep") ? Number(option("keep")) : null, checkBlocks: Number(option("check-blocks", 1000)) });
      console.log(`backed up: ${dir} · latest block ${manifest.latest} · ${(manifest.bytes / 1024 / 1024).toFixed(1)} MB · checked ${manifest.checked} blocks`);
    }
  } catch (error) {
    console.error(`failed: ${error.message}`);
    process.exit(1);
  }
}
