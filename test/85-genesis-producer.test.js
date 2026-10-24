import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { signTypedDataDigest } from "../src/crypto/program-signature.js";
import { resolveSettings, startupProblems } from "../src/node/genesis.js";
import { applyBlock, syncOnce, verifyProducer } from "../src/node/sync.js";

/*
 * ระยะ 1.1–1.4
 *   genesis.config ล็อกค่าที่ทุกเครื่องต้องเหมือนกัน · env ตั้งต่าง = server ไม่ยอมเริ่ม
 *   ไม่ใช่ DEV → ต้องมี ADMINS + PRODUCER_KEY
 *   ผู้ผลิตเซ็น hash ของ block · producer อยู่ใน hash · sync ตรวจลายเซ็นกับรายชื่อใน genesis
 *   replay / rebuild / sync รัน tx ด้วย replayTimeoutMs (ไม่ใช่ timeout ของผู้ผลิต)
 */

const T = Date.parse("2026-01-01T00:00:00Z");
const ROOT = new URL("..", import.meta.url).pathname;
const PRODUCER_KEY = sign.randomPrivateKey();
const PRODUCER = sign.addressOf(PRODUCER_KEY);
const OTHER_KEY = sign.randomPrivateKey();
const producerOf = (key) => ({ address: sign.addressOf(key), sign: (hash) => signTypedDataDigest(hash, key) });
const OPTIONS = { recordBlocks: true, recordHistory: true, recordTransactions: true };
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";

function chain({ key = PRODUCER_KEY, blocks = 3, options = {} } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, producer: key ? producerOf(key) : null, ...options });
  vm.db.load({ [`${ALICE}:native:received`]: "1000n" });
  for (let n = 1; n <= blocks; n += 1) {
    const block = vm.createBlock({ timestamp: T + n * 1000 });
    assert.equal(block.transfer({ from: ALICE, to: BOB, amount: "1n" }).status, "success");
    block.commit();
  }
  return vm;
}
const itemsOf = (vm, from = 1) => {
  const items = [];
  for (let n = from; n <= vm.latestBlockNumber(); n += 1) items.push({ header: vm.getBlock(n), body: vm.getBlockBody(n), rejected: vm.getBlockRejected(n) });
  return items;
};
const follower = () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  vm.db.load({ [`${ALICE}:native:received`]: "1000n" });
  return vm;
};

test("resolveSettings: genesis ก่อน env · env ที่ต่างจาก genesis = error · ไม่มี config = ใช้ env", () => {
  const genesis = { chainId: 7, config: { burnPercent: 50, minBaseFee: "2000000000", admins: ["0xAA", "0xbb"], producers: [PRODUCER] } };
  const ok = resolveSettings(genesis, { BURN_PERCENT: "50", ADMINS: "0xbb,0xaa", BLOCK_MS: "500" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.settings.chainId, 7);
  assert.equal(ok.settings.burnPercent, 50);
  assert.equal(ok.settings.minBaseFee, 2_000_000_000n);
  assert.deepEqual(ok.settings.admins, ["0xaa", "0xbb"]);
  assert.equal(ok.settings.blockMs, 500);            // ไม่อยู่ใน genesis → env
  assert.deepEqual(ok.locked.sort(), ["admins", "burnPercent", "chainId", "minBaseFee", "producers"]);

  const bad = resolveSettings(genesis, { BURN_PERCENT: "100", CHAIN_ID: "1", ADMINS: "0xaa" });
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors.join("\n"), /BURN_PERCENT=100 ไม่ตรงกับ genesis/);
  assert.match(bad.errors.join("\n"), /CHAIN_ID=1/);

  const dev = resolveSettings({ chainId: 1, balances: {} }, { BURN_PERCENT: "80", GAS_TARGET: "100" });
  assert.deepEqual(dev.errors, []);
  assert.equal(dev.settings.burnPercent, 80);
  assert.equal(dev.settings.gasTarget, 100);
  assert.equal(dev.settings.admins, null);
  assert.equal(resolveSettings({}, {}).settings.minBaseFee, 1_000_000_000n);
  assert.match(resolveSettings({}, { BLOCK_MS: "abc" }).errors[0], /BLOCK_MS/);
});

test("startupProblems: ไม่ใช่ DEV ต้องมี ADMINS + PRODUCER_KEY · producer ต้องอยู่ในรายชื่อ genesis", () => {
  const empty = resolveSettings({}, {}).settings;
  assert.equal(startupProblems({ settings: empty }).length, 2);
  assert.deepEqual(startupProblems({ settings: empty, dev: true }), []);
  const settings = resolveSettings({ config: { admins: ["0xaa"], producers: [PRODUCER] } }, {}).settings;
  assert.deepEqual(startupProblems({ settings, producer: PRODUCER }), []);
  assert.match(startupProblems({ settings, producer: sign.addressOf(OTHER_KEY) })[0], /ไม่อยู่ในรายชื่อผู้ผลิต/);
  assert.deepEqual(startupProblems({ settings: empty, errors: ["x"], dev: true }), ["x"]);
});

test("server.js: ไม่ตั้ง ADMINS / PRODUCER_KEY = ไม่ยอมเริ่ม · env ต่างจาก genesis = ไม่ยอมเริ่ม", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-"));
  const run = (env) => spawnSync(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { PATH: process.env.PATH, PORT: "0", ...env }, encoding: "utf8", timeout: 20_000,
  });
  const missing = run({});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ต้องตั้ง ADMINS/);
  assert.match(missing.stderr, /ต้องตั้ง PRODUCER_KEY/);

  const file = path.join(dir, "genesis.json");
  fs.writeFileSync(file, JSON.stringify({ chainId: 5, balances: {}, config: { burnPercent: 100, admins: ["0xaa"] } }));
  const mismatch = run({ GENESIS: file, BURN_PERCENT: "50", PRODUCER_KEY });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /BURN_PERCENT=50 ไม่ตรงกับ genesis/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ผู้ผลิตเซ็น block: producer อยู่ใน header + hash · ลายเซ็นกู้ได้ address ผู้ผลิต", () => {
  const vm = chain();
  const header = vm.getBlock(1);
  assert.equal(header.producer, PRODUCER);
  assert.equal(verifyProducer(header, [PRODUCER]), PRODUCER);
  // producer อยู่ใน hash: chain เดียวกันแต่ไม่มีผู้ผลิต → hash ต่าง · ไม่มีผู้ผลิต = header แบบเดิม (ไม่มี field)
  const plain = chain({ key: null });
  assert.notEqual(plain.getBlock(1).hash, header.hash);
  assert.equal("producer" in plain.getBlock(1), false);
  assert.equal("producerSignature" in plain.getBlock(1), false);
});

test("sync: ตรวจลายเซ็นผู้ผลิตกับรายชื่อ · block ปลอม / ผู้ผลิตนอกรายชื่อ / ไม่มีผู้ผลิต = หยุด", async () => {
  const source = chain();
  const reader = follower();
  assert.equal(await syncOnce(reader, async (from) => itemsOf(source, from), { producers: [PRODUCER] }), 3);
  assert.equal(reader.getBlock(3).hash, source.getBlock(3).hash);
  assert.equal(reader.getBlock(3).producerSignature, source.getBlock(3).producerSignature);   // node ผู้อ่านเก็บลายเซ็นเดิม

  // ผู้ผลิตอื่นที่ไม่อยู่ในรายชื่อ (ลายเซ็นถูกของ key ตัวเอง)
  const stranger = chain({ key: OTHER_KEY, blocks: 1 });
  assert.throws(() => applyBlock(follower(), itemsOf(stranger)[0], { producers: [PRODUCER] }), /ไม่อยู่ในรายชื่อผู้ผลิต/);
  // แก้ producer ใน header ให้เป็นชื่อที่อยู่ในรายชื่อ → ลายเซ็นไม่ตรง
  const forged = itemsOf(stranger)[0];
  assert.throws(() => applyBlock(follower(), { ...forged, header: { ...forged.header, producer: PRODUCER } }, { producers: [PRODUCER] }), /ลายเซ็นผู้ผลิตไม่ถูกต้อง/);
  // ลายเซ็นหาย
  const [first] = itemsOf(source);
  assert.throws(() => applyBlock(follower(), { ...first, header: { ...first.header, producerSignature: null } }), /ลายเซ็นผู้ผลิตไม่ถูกต้อง/);
  // genesis กำหนดผู้ผลิต แต่ block ไม่มีผู้ผลิต
  assert.throws(() => applyBlock(follower(), itemsOf(chain({ key: null, blocks: 1 }))[0], { producers: [PRODUCER] }), /ไม่มีผู้ผลิต/);
  // ไม่ส่งรายชื่อ (ช่วงพัฒนา) → block ไม่มีผู้ผลิตซิงก์ได้เหมือนเดิม
  assert.equal(applyBlock(follower(), itemsOf(chain({ key: null, blocks: 1 }))[0]).number, 1);
});

test("replayBlock / rebuildFrom: block ที่มีผู้ผลิตได้ hash + ลายเซ็นเดิม แม้ node ไม่มี key", () => {
  const vm = chain({ blocks: 4 });
  const before = [1, 2, 3, 4].map((n) => vm.getBlock(n));
  for (let n = 1; n <= 4; n += 1) assert.equal(vm.replayBlock(n).hash, before[n - 1].hash);
  vm.producer = null;   // เปลี่ยนเครื่อง / ไม่มี key แล้ว
  vm.rebuildFrom(3);
  assert.equal(vm.latestBlockNumber(), 3);
  for (let n = 1; n <= 3; n += 1) {
    assert.equal(vm.getBlock(n).hash, before[n - 1].hash);
    assert.equal(vm.getBlock(n).producerSignature, before[n - 1].producerSignature);
  }
});

test("replay / sync ใช้ replayTimeoutMs: tx ที่ผู้ผลิตรันทันไม่ TIMEOUT บนเครื่องที่ตั้ง timeout สั้นกว่า", () => {
  // โปรแกรมที่ใช้เวลาพอสมควร (ลูปหลายรอบ) · ผู้ผลิตตั้ง timeout ยาว · ผู้อ่านตั้ง timeoutMs 1 ms แต่ replayTimeoutMs ยาว
  const CODE = `function program() {
    function initialization() {}
    function spin(params) { let total = 0; for (let i = 0; i < params.input.n; i += 1) total += i; writeDB("total", BigInt(total)) }
    return { spin }
  }`;
  const as = { sender: ALICE, origin: ALICE };
  const build = (vm) => {
    const first = vm.createBlock({ timestamp: T + 1000 });
    first.deploy({ programUuid: "spin", code: CODE, context: as });
    first.init({ programUuid: "spin", context: as });
    first.commit();
    const block = vm.createBlock({ timestamp: T + 2000 });
    assert.equal(block.call({ programUuid: "spin", functionName: "spin", input: { n: 200_000 }, context: as }).status, "success");
    block.commit();
  };
  const source = new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, timeoutMs: 30_000, maxTxGas: 100_000_000, producer: producerOf(PRODUCER_KEY) });
  build(source);

  const slow = (replayTimeoutMs) => new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, timeoutMs: 1, replayTimeoutMs, maxTxGas: 100_000_000 });
  const reader = slow(60_000);
  for (const item of itemsOf(source)) applyBlock(reader, item, { producers: [PRODUCER] });
  assert.equal(reader.getBlock(2).hash, source.getBlock(2).hash);
  assert.equal(reader.replayBlock(2).hash, source.getBlock(2).hash);
  // เทียบ: ถ้าใช้ timeout 1 ms ตอน sync (แบบเดิม) → tx TIMEOUT → hash ไม่ตรง
  // block 1 (deploy + init) ซิงก์ด้วย timeout ยาว ไม่งั้นเครื่องที่ยุ่ง (เทสต์รันขนานกัน) ก็ TIMEOUT ได้ตั้งแต่ block นี้
  const old = slow(60_000);
  applyBlock(old, itemsOf(source)[0]);
  old.replayTimeoutMs = 1;
  assert.throws(() => applyBlock(old, itemsOf(source)[1]), /block 2 ไม่ตรงกับผู้ผลิต/);
});
