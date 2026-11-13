/**
 * State snapshots (phase 4.1 · src/node/snapshot.js)
 *
 *   npm run snapshot -- export --data ./data --out snap.ndjson.gz [--block N]   # built from LMDB (the server may keep running)
 *   npm run snapshot -- import --data ./new-data --file snap.ndjson.gz           # new node: load into a DATA with no blocks yet
 *   npm run snapshot -- import --data ./new-data --url https://node1.example.com # download that node's latest /snapshot
 *   npm run snapshot -- verify --file snap.ndjson.gz                             # verify a file (loads into an in-memory DB)
 *
 * chainId / allowed producers come from GENESIS (default genesis.json) — headers from producers not in the list = rejected
 * after import, start the node with the same DATA: it syncs on from block N + 1 (startSync) · state lookback / replay available from block N + 1
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
const open = (data) => new VirtualMachine(data ? new DB(data) : new MemoryDB(), { chainId: settings.chainId, forks: settings.forks, recordBlocks: true, recordHistory: true });
const producers = settings.producers ?? null;
const report = (result) => console.log(JSON.stringify(result, null, 2));

try {
  if (command === "export") {
    if (!args.data || !args.out) throw new Error("--data and --out are required");
    const vm = open(args.data);
    report(await writeSnapshot(vm, args.out, args.block ? { number: Number(args.block) } : {}));
  } else if (command === "import") {
    if (!args.data || (!args.file && !args.url)) throw new Error("--data and --file or --url are required");
    const vm = open(args.data);
    if (genesis.balances) vm.applyGenesis(genesis);   // genesis must match the snapshot's
    const loaded = args.url ? await syncFromSnapshot(vm, { url: args.url, producers }) : await loadSnapshot(vm, readSnapshotFile(args.file), { producers });
    if (!loaded) throw new Error("the source has no snapshot, or DATA already has blocks");
    report({ number: loaded.number, hash: loaded.hash, stateRoot: loaded.stateRoot, keys: loaded.keys });
  } else if (command === "verify") {
    if (!args.file) throw new Error("--file is required");
    const loaded = await loadSnapshot(open(null), readSnapshotFile(args.file), { producers });
    report({ ok: true, number: loaded.number, hash: loaded.hash, stateRoot: loaded.stateRoot, keys: loaded.keys });
  } else {
    console.log("usage: npm run snapshot -- export|import|verify (see the header of scripts/snapshot.js)");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`snapshot failed: ${error.message}`);
  process.exitCode = 1;
}
