/**
 * สำรอง / กู้ข้อมูลของ node (LMDB + บันทึกใบที่ถูกแทนที่)
 *
 *   npm run backup -- --data ./data --out ./backups               # สำรองขณะ server ทำงานได้ → ./backups/<เวลา>/
 *   npm run backup -- --data ./data --out ./backups --keep 7      # เก็บไว้ 7 ชุดล่าสุด (ลบชุดเก่า)
 *   npm run backup -- --data ./data --out ./backups --compact     # ข้ามหน้าว่าง (ไฟล์เล็กลง ช้ากว่า)
 *   npm run backup -- --verify ./backups/2026-10-24T05-00-00Z     # ตรวจชุดสำรอง
 *   npm run backup -- --restore ./backups/2026-10-24T05-00-00Z --data ./data   # กู้ (ต้องหยุด server ก่อน)
 *
 * ชุดสำรอง = โฟลเดอร์ที่มี data.mdb (สำเนา LMDB ณ commit เดียว) + replaced-tx.jsonl (ถ้ามี) + manifest.json
 * ตรวจหลังสำรองทุกครั้ง: เปิดสำเนาได้ · block ล่าสุดตรงกับ manifest · parentHash ต่อกันย้อนหลัง --check-blocks block (ค่าเริ่ม 1000)
 *   และ blockhash:<hash> ชี้กลับมาที่เลขเดิม
 * กู้: โฟลเดอร์ --data ต้องว่างหรือไม่มี · มีของเดิม → ต้องส่ง --force (ย้ายของเดิมไปเป็น <data>.before-restore-<เวลา>)
 */
import fs from "node:fs";
import path from "node:path";
import { DB } from "../src/storage/db.js";
import { blockKey, blockHashKey, LATEST_BLOCK_KEY } from "../src/core/virtualmachine.js";

const SIDE_FILES = ["replaced-tx.jsonl"];
const stamp = (date = new Date()) => date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

/** ตรวจชุดสำรอง (หรือโฟลเดอร์ data) → { latest, latestHash, genesis, checked } · ผิด = throw */
export function verifyBackup(dir, { checkBlocks = 1000, expect = null } = {}) {
  if (!fs.existsSync(path.join(dir, "data.mdb"))) throw new Error(`${dir} ไม่มี data.mdb`);
  const db = new DB(dir);
  try {
    const [latest, genesis] = db.readKeys([LATEST_BLOCK_KEY, "genesis"]);
    let checked = 0;
    let latestHash = null;
    if (latest !== undefined && latest !== null) {
      let header = db.readKeys([blockKey(latest)])[0];
      if (!header) throw new Error(`ไม่มี header ของ block ${latest}`);
      latestHash = header.hash;
      for (let n = latest; n >= 1 && checked < checkBlocks; n -= 1) {
        if (!header || header.number !== n) throw new Error(`header ของ block ${n} หาย / เลขไม่ตรง`);
        if (db.readKeys([blockHashKey(header.hash)])[0] !== n) throw new Error(`blockhash ของ block ${n} ไม่ชี้กลับมา`);
        checked += 1;
        if (n === 1) break;
        const parent = db.readKeys([blockKey(n - 1)])[0];
        if (!parent || parent.hash !== header.parentHash) throw new Error(`block ${n} parentHash ไม่ตรงกับ block ${n - 1}`);
        header = parent;
      }
    }
    if (expect && (expect.latest !== (latest ?? null) || expect.latestHash !== latestHash)) {
      throw new Error(`ไม่ตรงกับ manifest (manifest: block ${expect.latest} ${expect.latestHash} · สำเนา: block ${latest} ${latestHash})`);
    }
    return { latest: latest ?? null, latestHash, genesis: genesis ?? null, checked };
  } finally {
    db.close();
  }
}

/** สำรอง data → <out>/<เวลา>/ → { dir, manifest } */
export async function backup({ data, out, compact = false, keep = null, checkBlocks = 1000, now = new Date() }) {
  if (!fs.existsSync(path.join(data, "data.mdb"))) throw new Error(`${data} ไม่มี data.mdb (ไม่ใช่โฟลเดอร์ DATA ของ server)`);
  const dir = path.join(out, stamp(now));
  const db = new DB(data);
  try {
    await db.backup(dir, { compact });
  } finally {
    db.close();
  }
  // บันทึกข้าง LMDB (เขียนแบบต่อท้าย · สำเนาอาจขาดบรรทัดท้ายที่กำลังเขียน ซึ่ง TxLog ข้ามบรรทัดที่อ่านไม่ได้อยู่แล้ว)
  for (const name of SIDE_FILES) if (fs.existsSync(path.join(data, name))) fs.copyFileSync(path.join(data, name), path.join(dir, name));
  const info = verifyBackup(dir, { checkBlocks });
  const manifest = { createdAt: now.toISOString(), source: path.resolve(data), compact, ...info,
    bytes: fs.statSync(path.join(dir, "data.mdb")).size, files: fs.readdirSync(dir).filter((name) => name !== "lock.mdb") };
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(path.join(dir, "lock.mdb"), { force: true });
  if (keep) prune(out, keep);
  return { dir, manifest };
}

/** เก็บชุดสำรอง keep ชุดล่าสุด (เฉพาะโฟลเดอร์ที่มี manifest.json) → ชื่อที่ลบ */
export function prune(out, keep) {
  const sets = fs.readdirSync(out).filter((name) => fs.existsSync(path.join(out, name, "manifest.json"))).sort();
  const removed = sets.slice(0, Math.max(0, sets.length - keep));
  for (const name of removed) fs.rmSync(path.join(out, name), { recursive: true, force: true });
  return removed;
}

/** กู้ชุดสำรองไปที่ data (server ต้องหยุดอยู่) → { data, moved } */
export function restore({ from, data, force = false, now = new Date() }) {
  const manifestFile = path.join(from, "manifest.json");
  const expect = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
  verifyBackup(from, { expect });
  let moved = null;
  if (fs.existsSync(data) && fs.readdirSync(data).length) {
    if (!force) throw new Error(`${data} มีข้อมูลอยู่แล้ว — ส่ง --force เพื่อย้ายของเดิมไปเก็บก่อนกู้`);
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
      console.log(`ชุดสำรองใช้ได้: block ล่าสุด ${info.latest} (${info.latestHash}) · ตรวจ ${info.checked} block`);
    } else if (option("restore")) {
      const result = restore({ from: option("restore"), data: option("data", "./data"), force: args.includes("--force") });
      console.log(`กู้แล้วที่ ${result.data}${result.moved ? ` · ของเดิมย้ายไป ${result.moved}` : ""} — เปิด server ด้วย DATA=${result.data}`);
    } else {
      const { dir, manifest } = await backup({ data: option("data", process.env.DATA ?? "./data"), out: option("out", "./backups"),
        compact: args.includes("--compact"), keep: option("keep") ? Number(option("keep")) : null, checkBlocks: Number(option("check-blocks", 1000)) });
      console.log(`สำรองแล้ว: ${dir} · block ล่าสุด ${manifest.latest} · ${(manifest.bytes / 1024 / 1024).toFixed(1)} MB · ตรวจ ${manifest.checked} block`);
    }
  } catch (error) {
    console.error(`ล้มเหลว: ${error.message}`);
    process.exit(1);
  }
}
