import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM } from "./helpers.js";
import { DB } from "../src/storage/db.js";
import * as sign from "../src/crypto/signature.js";
import { backup, verifyBackup, restore, prune } from "../scripts/backup.js";
import { check } from "../scripts/monitor.js";

/*
 * ระยะ 1.5–1.6
 *   /health: problems (เชนหยุด / ปิด block ล้มเหลว / พื้นที่ใกล้เต็ม) · มีปัญหา = 503 · scripts/monitor.js อ่านค่านี้
 *   scripts/backup.js: สำรอง LMDB ขณะเปิดอยู่ · ตรวจสายของ block · กู้ลงโฟลเดอร์ว่าง · --force ย้ายของเดิมไปเก็บ
 */

const FUNDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";   // มียอดใน genesis.json
const T = Date.parse("2026-01-01T00:00:00Z");

test("/health: ปกติ = 200 · มี tx รอแต่ไม่มี block ใหม่ = stalled · ปิด block ล้มเหลว = 503 · monitor อ่านได้", async () => {
  const { server, vm, miner, mempool, health, minerState, STALL_MS } = await import("../server.js");
  clearInterval(miner);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const ok = await get("/health");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.problems, []);
    assert.equal(ok.body.latest, null);
    assert.equal((await check(url)).ok, true);

    // tx รอในคิว แต่ไม่มีใครปิด block (miner หยุด)
    const tx = { chainId: vm.chainId, action: "transfer", from: sign.addressOf(FUNDER_KEY), to: "0x00000000000000000000000000000000000000b0",
      value: "1n", nonce: 0, gasLimit: 21_000, gasPrice: "1000000000" };
    assert.equal(mempool.add({ tx, signature: sign.signTransaction(tx, FUNDER_KEY) }).ok, true);
    assert.deepEqual(health(Date.now()).problems, []);   // ยังไม่ถึง STALL_MS
    const stalled = health(Date.now() + STALL_MS + 1000);
    assert.equal(stalled.ok, false);
    assert.match(stalled.problems[0], /^stalled: มี 1 tx รอ/);

    Object.assign(minerState, { failures: 2, lastError: "disk full" });
    const failing = await get("/health");
    assert.equal(failing.status, 503);
    assert.match(failing.body.problems.join("\n"), /ปิด block ล้มเหลว 2 ครั้งติดกัน \(disk full\)/);
    const watched = await check(url);
    assert.equal(watched.ok, false);
    assert.match(watched.problems[0], /ปิด block ล้มเหลว/);
    minerState.failures = 0;

    // ปิด block แล้ว → อายุ block ล่าสุด + ไม่มีปัญหา
    const block = vm.createBlock({ timestamp: Date.now() });
    mempool.take(block);
    block.commit();
    const after = (await get("/health")).body;
    assert.equal(after.latest, 1);
    assert.ok(after.blockAgeMs >= 0);
    assert.deepEqual(after.problems, []);
  } finally {
    server.close();
  }
  const down = await check("http://127.0.0.1:1", { timeoutMs: 2000 });
  assert.equal(down.ok, false);
  assert.match(down.problems[0], /^unreachable/);
});

function lmdbChain(dir, blocks = 5) {
  const db = new DB(dir);
  const vm = new VM.VirtualMachine(db, { recordBlocks: true, recordHistory: true, recordTransactions: true });
  db.load({ "0x00000000000000000000000000000000000000a1:native:received": "1000n" });
  vm.applyGenesis({ chainId: 1, balances: {} });
  for (let n = 1; n <= blocks; n += 1) {
    const block = vm.createBlock({ timestamp: T + n * 1000 });
    block.transfer({ from: "0x00000000000000000000000000000000000000a1", to: "0x00000000000000000000000000000000000000b0", amount: "1n" });
    block.commit();
  }
  return { db, vm };
}

test("backup: สำรองขณะเปิด DB อยู่ · manifest + ตรวจสายของ block · เก็บ N ชุดล่าสุด", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
  const data = path.join(root, "data");
  const { db, vm } = lmdbChain(data);
  fs.writeFileSync(path.join(data, "replaced-tx.jsonl"), '{"hash":"0xaa","seq":1}\n');
  try {
    const out = path.join(root, "backups");
    const first = await backup({ data, out, now: new Date(T) });
    assert.equal(first.manifest.latest, 5);
    assert.equal(first.manifest.latestHash, vm.getBlock(5).hash);
    assert.equal(first.manifest.checked, 5);
    assert.equal(first.manifest.genesis, vm.genesisHash());
    assert.ok(fs.existsSync(path.join(first.dir, "replaced-tx.jsonl")));
    assert.equal(fs.existsSync(path.join(first.dir, "lock.mdb")), false);

    // DB ต้นทางเขียนต่อได้ระหว่าง / หลังสำรอง · สำเนาเป็นของ ณ ตอนสำรอง
    const block = vm.createBlock({ timestamp: T + 9000 });
    block.commit();
    assert.equal(verifyBackup(first.dir).latest, 5);

    await backup({ data, out, now: new Date(T + 60_000) });
    await backup({ data, out, now: new Date(T + 120_000), keep: 2 });
    assert.equal(fs.readdirSync(out).length, 2);
    assert.deepEqual(prune(out, 1).length, 1);
    await assert.rejects(() => db.backup(path.join(out, fs.readdirSync(out)[0])), /ไม่ว่าง/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verify / restore: ตรวจเจอ header หาย / manifest ไม่ตรง · กู้ลงโฟลเดอร์ว่าง · มีของเดิมต้อง --force", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
  const data = path.join(root, "data");
  const { db, vm } = lmdbChain(data, 4);
  const latestHash = vm.getBlock(4).hash;
  const { dir } = await backup({ data, out: path.join(root, "backups"), now: new Date(T) });
  db.close();
  try {
    assert.throws(() => verifyBackup(dir, { expect: { latest: 4, latestHash: "0xdead" } }), /ไม่ตรงกับ manifest/);
    assert.throws(() => verifyBackup(path.join(root, "nothing")), /ไม่มี data.mdb/);

    const target = path.join(root, "restored");
    assert.deepEqual(restore({ from: dir, data: target }).moved, null);
    const restored = new DB(target);
    assert.equal(new VM.VirtualMachine(restored, { recordBlocks: true }).getBlock(4).hash, latestHash);
    restored.close();
    assert.equal(fs.existsSync(path.join(target, "replaced-tx.jsonl")), false);   // ต้นทางไม่มีไฟล์นี้

    assert.throws(() => restore({ from: dir, data }), /มีข้อมูลอยู่แล้ว/);
    const forced = restore({ from: dir, data, force: true, now: new Date(T) });
    assert.ok(fs.existsSync(path.join(forced.moved, "data.mdb")));

    // สำเนาที่ header ของ block กลางสายหาย → ตรวจไม่ผ่าน
    const broken = new DB(target);
    broken.writeKeys([{ type: "del", dbKey: VM.blockKey(2) }]);
    broken.close();
    assert.throws(() => verifyBackup(target), /block 3 parentHash ไม่ตรงกับ block 2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
