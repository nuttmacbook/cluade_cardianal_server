/**
 * snapshot ของ state (ระยะ 4.1 · src/node/snapshot.js)
 *
 *   npm run snapshot -- export --data ./data --out snap.ndjson.gz [--block N]   # ทำจาก LMDB (server ทำงานอยู่ได้)
 *   npm run snapshot -- import --data ./new-data --file snap.ndjson.gz           # node ใหม่: โหลดลง DATA ที่ยังไม่มี block
 *   npm run snapshot -- import --data ./new-data --url https://node1.example.com # ดาวน์โหลด /snapshot ล่าสุดของ node นั้น
 *   npm run snapshot -- verify --file snap.ndjson.gz                             # ตรวจไฟล์ (โหลดลง DB ในหน่วยความจำ)
 *
 * chainId / ผู้ผลิตที่อนุญาตมาจาก GENESIS (ค่าเริ่ม genesis.json) — header ที่ผู้ผลิตไม่ได้อยู่ในรายชื่อ = ไม่รับ
 * import เสร็จแล้วเปิด node ด้วย DATA เดิม: ซิงก์ต่อจาก block N + 1 (startSync) · ย้อนดู state / replay ได้ตั้งแต่ block N + 1
 */
import fs from "node:fs";
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { DB, MemoryDB } from "../src/storage/db.js";
import { resolveSettings } from "../src/node/genesis.js";
import { writeSnapshot, loadSnapshot, readSnapshotFile, syncFromSnapshot } from "../src/node/snapshot.js";

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 1) if (rest[i].startsWith("--")) args[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") ? true : rest[++i] ?? true;

const GENESIS_FILE = process.env.GENESIS ?? "genesis.json";
const genesis = fs.existsSync(GENESIS_FILE) ? JSON.parse(fs.readFileSync(GENESIS_FILE, "utf8")) : {};
const { settings } = resolveSettings(genesis, process.env);
const open = (data) => new VirtualMachine(data ? new DB(data) : new MemoryDB(), { chainId: settings.chainId, recordBlocks: true, recordHistory: true });
const producers = settings.producers ?? null;
const report = (result) => console.log(JSON.stringify(result, null, 2));

try {
  if (command === "export") {
    if (!args.data || !args.out) throw new Error("ต้องมี --data และ --out");
    const vm = open(args.data);
    report(await writeSnapshot(vm, args.out, args.block ? { number: Number(args.block) } : {}));
  } else if (command === "import") {
    if (!args.data || (!args.file && !args.url)) throw new Error("ต้องมี --data และ --file หรือ --url");
    const vm = open(args.data);
    if (genesis.balances) vm.applyGenesis(genesis);   // genesis ต้องตรงกับของ snapshot
    const loaded = args.url ? await syncFromSnapshot(vm, { url: args.url, producers }) : await loadSnapshot(vm, readSnapshotFile(args.file), { producers });
    if (!loaded) throw new Error("ต้นทางไม่มี snapshot หรือ DATA มี block แล้ว");
    report({ number: loaded.number, hash: loaded.hash, stateRoot: loaded.stateRoot, keys: loaded.keys });
  } else if (command === "verify") {
    if (!args.file) throw new Error("ต้องมี --file");
    const loaded = await loadSnapshot(open(null), readSnapshotFile(args.file), { producers });
    report({ ok: true, number: loaded.number, hash: loaded.hash, stateRoot: loaded.stateRoot, keys: loaded.keys });
  } else {
    console.log("ใช้: npm run snapshot -- export|import|verify (ดูหัวไฟล์ scripts/snapshot.js)");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`snapshot ล้มเหลว: ${error.message}`);
  process.exitCode = 1;
}
