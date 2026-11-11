import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, user } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";

/*
 * เจ้าของเชน (admins ใน genesis) ปรับขั้นต่ำของ gas price กลางทางด้วย tx setGasConfig — ไม่ต้อง fork / ล้างเชน
 *   minBaseFee: base fee ขั้นต่ำ (wei) · null = กลับไปใช้ค่าใน genesis · ราคาต่อหน่วยปรับบนเชนไม่ได้ (fork เท่านั้น)
 *   เขียน gasconfig ใน state → มีผลตั้งแต่ block ถัดไป · replay / sync อ่าน state ก่อน block ได้ผลเดิม
 */

const T = 1_700_000_000_000;
const ADMIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const GWEI = 1_000_000_000n;

const chain = (options = {}) => new VM.VirtualMachine(new MemoryDB(), {
  recordBlocks: true, recordHistory: true, recordTransactions: true,
  admins: [ADMIN], minBaseFee: GWEI, maxBlockGas: 1_000_000, gas: { price: GWEI }, ...options,
});

let clock = T;
/** ปิด block ที่มี tx ตาม fill(block) · คืน { block, results } */
function seal(vm, fill = () => []) {
  clock += 1000;
  const block = vm.createBlock({ timestamp: clock });
  const results = [fill(block)].flat();
  block.commit();
  return { block, results };
}
const transfer = (block) => block.transfer({ from: ALICE, to: BOB, amount: 1 });
const setGas = (block, change, sender = ADMIN) => block.setGasConfig({ ...change, context: user(sender) });

test("setGasConfig minBaseFee: ลดขั้นต่ำ → base fee ลงทีละ 12.5% จนถึงขั้นต่ำใหม่ · มีผลตั้งแต่ block ถัดไป", () => {
  const vm = chain();
  seal(vm);
  assert.equal(vm.currentBaseFee(), GWEI);

  const { block, results: [set] } = seal(vm, (b) => [setGas(b, { minBaseFee: "100000000" }), transfer(b)]);
  assert.equal(set.status, "success", JSON.stringify(set.error));
  assert.equal(set.result.minBaseFee, "100000000");
  assert.equal(set.result.effectiveFrom, block.number + 1);
  assert.equal(block.baseFee, GWEI);   // block ที่ตั้งยังใช้ขั้นต่ำเดิม
  assert.deepEqual(vm.gasConfig(), { minBaseFee: "100000000", block: block.number, by: ADMIN });
  assert.equal(vm.minBaseFeeNow(), 100_000_000n);

  // block ว่าง ๆ ใช้แก๊สต่ำกว่าเป้า → base fee ลง 1/8 ต่อ block (เดิมติดขั้นต่ำ 1 gwei)
  const fees = [];
  for (let i = 0; i < 20; i += 1) fees.push(seal(vm, transfer).block.baseFee);
  assert.ok(fees[0] < GWEI && fees[0] >= GWEI - GWEI / 8n, `${fees[0]}`);
  assert.ok(fees.every((fee, i) => i === 0 || fee <= fees[i - 1]));
  assert.equal(fees.at(-1), 100_000_000n);   // ลงถึงขั้นต่ำใหม่แล้วหยุด
  const paid = seal(vm, transfer).results[0];
  assert.equal(paid.gasPrice, "100000000n");   // ค่า tx = แก๊สเท่าเดิม × base fee ใหม่

  // ขึ้นขั้นต่ำ → ใช้ทันทีที่ block ถัดไป
  seal(vm, (b) => setGas(b, { minBaseFee: 2n * GWEI }));
  assert.equal(seal(vm).block.baseFee, 2n * GWEI);

  // null = กลับไปใช้ค่าใน genesis
  seal(vm, (b) => setGas(b, { minBaseFee: null }));
  assert.equal(vm.minBaseFeeNow(), GWEI);
});

test("setGasConfig: ราคาต่อหน่วย (gas) ปรับบนเชนไม่ได้ · tx อื่นใน block เดียวกันใช้ราคาเดิม", () => {
  const vm = chain();
  assert.equal(seal(vm, transfer).results[0].gasUsed, 1300);
  const refused = seal(vm, (b) => setGas(b, { gas: { call: 0 } })).results[0];
  assert.notEqual(refused.status, "success");
  assert.match(refused.error.message, /ปรับบนเชนไม่ได้/);
  const mixed = seal(vm, (b) => setGas(b, { minBaseFee: 1, gas: { write: 0 } })).results[0];
  assert.match(mixed.error.message, /ปรับบนเชนไม่ได้/);
  assert.equal(vm.gasConfig(), null);
  assert.equal(seal(vm, transfer).results[0].gasUsed, 1300);
  assert.equal(vm.gasAt().call, 100);
});

test("setGasConfig: replay block เก่าได้ hash เดิม (อ่าน gasconfig จาก state ก่อน block)", () => {
  const vm = chain();
  seal(vm, transfer);
  const setAt = seal(vm, (b) => setGas(b, { minBaseFee: "500000000" })).block.number;
  for (let i = 0; i < 4; i += 1) seal(vm, transfer);
  seal(vm, (b) => setGas(b, { minBaseFee: GWEI * 3n }));
  for (let i = 0; i < 2; i += 1) seal(vm, transfer);
  const latest = vm.latestBlockNumber();
  for (let number = 1; number <= latest; number += 1) {
    assert.equal(vm.replayBlock(number).hash, vm.getBlock(number).hash, `block ${number}`);
  }
  assert.ok(latest > setAt);
  // เครื่องที่ไม่รู้จัก gasconfig (สร้าง block เดิมจาก body โดยไม่สนค่าที่ตั้ง) จะได้แก๊สต่างไปตั้งแต่ block หลัง setAt → hash ไม่ตรง (ตรวจเจอ)
  assert.notEqual(vm.getBlock(setAt + 1).baseFeePerGas, vm.getBlock(setAt).baseFeePerGas);
});

test("setGasConfig: เฉพาะ admins · เชนที่ไม่ตั้ง admins ปรับไม่ได้ · ค่าผิดไม่รับ", () => {
  const vm = chain();
  const notAdmin = seal(vm, (b) => setGas(b, { minBaseFee: 1 }, ALICE)).results[0];
  assert.notEqual(notAdmin.status, "success");
  assert.match(notAdmin.error.message, /ไม่มีสิทธิ์ปรับค่าแก๊ส/);
  assert.equal(vm.gasConfig(), null);

  const open = chain({ admins: null });
  const refused = seal(open, (b) => setGas(b, { minBaseFee: 1 })).results[0];
  assert.match(refused.error.message, /เฉพาะเชนที่ตั้ง admins/);

  for (const [change, pattern] of [
    [{ minBaseFee: 0 }, /wei ≥ 1/],
    [{ minBaseFee: "-5" }, /wei ≥ 1/],
    [{ minBaseFee: "abc" }, /wei ≥ 1/],
    [{}, /ต้องส่ง minBaseFee/],
  ]) {
    const result = seal(vm, (b) => setGas(b, change)).results[0];
    assert.notEqual(result.status, "success", JSON.stringify(change));
    assert.match(result.error.message, pattern, JSON.stringify(change));
  }
  assert.equal(vm.gasConfig(), null);
});

test("setGasConfig: tx ที่เซ็นแล้ว (action setGasConfig) → request ของ VM", () => {
  const key = `0x${"11".repeat(32)}`;
  const admin = sign.addressOf(key);
  const tx = { chainId: 1, from: admin, to: "", action: "setGasConfig", method: "", input: { minBaseFee: "100000000" }, value: 0, nonce: 0 };
  const verified = sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, key) });
  assert.equal(verified.method, "setGasConfig");
  assert.equal(verified.request.minBaseFee, "100000000");
  assert.equal(Object.hasOwn(verified.request, "gas"), false);
  assert.equal(verified.request.context.sender, admin);

  const vm = chain({ admins: [admin], requireNonce: true });
  const result = seal(vm, (b) => b[verified.method](verified.request)).results[0];
  assert.equal(result.status, "success", JSON.stringify(result.error));
  assert.equal(vm.minBaseFeeNow(), 100_000_000n);
  // ใส่ gas มาในใบที่เซ็น → VM ปฏิเสธ (ค่าเดิมไม่เปลี่ยน)
  const withGas = { ...tx, nonce: 1, input: { minBaseFee: "200000000", gas: { call: 0 } } };
  const second = sign.verifyTransaction({ tx: withGas, signature: sign.signTransaction(withGas, key) });
  assert.match(seal(vm, (b) => b[second.method](second.request)).results[0].error.message, /ปรับบนเชนไม่ได้/);
  assert.equal(vm.minBaseFeeNow(), 100_000_000n);
});

test("setGasConfig: เชนที่ตั้ง admins แล้ว DB พัง → tx ยังล้มเป็น INTERNAL (ไม่ throw ออกไป)", () => {
  const vm = new VM.VirtualMachine({ readKeys: () => { throw new Error("503"); }, writeKeys: () => {} }, { admins: [ADMIN] });
  const res = vm.transfer({ from: ALICE, to: BOB, amount: 1 });
  assert.equal(res.status, "throw");
  assert.deepEqual(res.error, { code: "INTERNAL", message: "อ่านข้อมูลจาก DB ไม่สำเร็จ: 503" });
});

// ---------- server.js จริง: scripts/set-gas.js → ผู้ผลิตใช้ค่าใหม่ · เครื่องตาม (FOLLOW) ซิงก์แล้วได้ hash เดิม ----------

test("server.js + scripts/set-gas.js: เจ้าของลดขั้นต่ำของ gas price กลางทาง · เครื่องตามซิงก์ได้ผลเดิม", { timeout: 90_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const net = await import("node:net");
  const ROOT = new URL("..", import.meta.url).pathname;
  const producerKey = sign.randomPrivateKey();
  const adminKey = sign.randomPrivateKey();
  const admin = sign.addressOf(adminKey);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gas-config-"));
  const genesisFile = path.join(dir, "genesis.json");
  fs.writeFileSync(genesisFile, JSON.stringify({ chainId: 9, balances: { [admin]: "1000000000000000000n" },
    config: { admins: [admin], producers: [sign.addressOf(producerKey)] } }));
  const freePort = () => new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const run = (file, args, env) => {
    const child = spawn(process.execPath, [path.join(ROOT, file), ...args], {
      cwd: ROOT, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    return { child, output: () => output, exited };
  };
  const startNode = async (env) => {
    const port = await freePort();
    const node = run("server.js", [], { PORT: String(port), BLOCK_MS: "100", VERIFY_WORKERS: "0", GENESIS: genesisFile, RATE_LIMIT: "0", GAS_PRICE: "1000000000", ...env });
    const until = Date.now() + 20_000;
    while (!node.output().includes("chain ทำงานที่")) {
      if (Date.now() > until) throw new Error(node.output());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ...node, url: `http://127.0.0.1:${port}` };
  };
  const get = (url) => fetch(url).then((response) => response.json());
  const nodes = [];
  try {
    const producer = await startNode({ PRODUCER_KEY: producerKey });
    nodes.push(producer);
    assert.equal((await get(`${producer.url}/genesis`)).minBaseFee, "1000000000n");

    const script = run("scripts/set-gas.js", [producer.url, "--min-base-fee", "0.1gwei"], { ADMIN_KEY: adminKey });
    assert.equal(await script.exited, 0, script.output());
    assert.match(script.output(), /✓ อยู่ใน block \d+ · มีผลตั้งแต่ block \d+/);
    const info = await get(`${producer.url}/genesis`);
    assert.equal(info.minBaseFee, "100000000n");
    assert.equal(info.genesisMinBaseFee, "1000000000n");
    assert.equal(info.gas.call, 100);   // ราคาต่อหน่วยไม่เปลี่ยน
    assert.equal(info.gasConfig.by, admin.toLowerCase());

    // คนที่ไม่ใช่ admin → สคริปต์หยุดก่อนส่ง
    const stranger = run("scripts/set-gas.js", [producer.url, "--min-base-fee", "1"], { ADMIN_KEY: sign.randomPrivateKey() });
    assert.equal(await stranger.exited, 1);
    assert.match(stranger.output(), /ไม่อยู่ใน admins/);

    const follower = await startNode({ FOLLOW: producer.url, DATA: path.join(dir, "follower") });
    nodes.push(follower);
    const latest = (await get(`${producer.url}/health`)).latest;
    const until = Date.now() + 20_000;
    while ((await get(`${follower.url}/health`).catch(() => ({}))).latest < latest) {
      if (Date.now() > until) throw new Error(follower.output());
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (let number = 1; number <= latest; number += 1) {
      assert.equal((await get(`${follower.url}/block/${number}`)).hash, (await get(`${producer.url}/block/${number}`)).hash, `block ${number}`);
    }
    assert.equal((await get(`${follower.url}/genesis`)).minBaseFee, "100000000n");
  } finally {
    for (const node of nodes) node.child.kill("SIGKILL");
    await Promise.all(nodes.map((node) => node.exited));
  }
});
