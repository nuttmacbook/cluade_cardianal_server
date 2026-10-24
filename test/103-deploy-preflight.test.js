import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import * as sign from "../src/crypto/signature.js";

/*
 * deploy/: ไฟล์ตัวอย่างสำหรับเปิดเชนสาธารณะเครื่องเดียว
 *   scripts/preflight.js ตรวจ genesis + env ก่อนเปิด: ค่าตัวอย่างที่ลืมแก้ / genesis ของช่วงพัฒนา = ไม่ผ่าน · กรอกครบ = ผ่าน
 *   HOST=127.0.0.1 → server ฟังเฉพาะในเครื่อง
 */

const ROOT = path.join(import.meta.dirname, "..");
const preflight = (env) => spawnSync(process.execPath, [path.join(ROOT, "scripts/preflight.js")],
  { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000 });

function filled() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-"));
  const keys = Array.from({ length: 5 }, () => sign.randomPrivateKey());
  const [rich, admin1, admin2, main, spare] = keys.map((key) => sign.addressOf(key));
  const text = fs.readFileSync(path.join(ROOT, "deploy/genesis.mainnet.example.json"), "utf8")
    .replace("0xADDRESS_ที่ได้เหรียญตั้งต้น", rich).replace("0xADDRESS_ADMIN_1", admin1).replace("0xADDRESS_ADMIN_2", admin2)
    .replace("0xADDRESS_ผู้ผลิตหลัก", main).replace("0xADDRESS_ผู้ผลิตสำรอง", spare);
  fs.writeFileSync(path.join(dir, "genesis.json"), text);
  return { dir, genesis: path.join(dir, "genesis.json"), key: keys[3] };
}

test("preflight: ไฟล์ตัวอย่างที่ยังไม่แก้ / genesis ของช่วงพัฒนา / DEV = ไม่ผ่าน · กรอกครบ = ผ่าน", () => {
  const example = preflight({ GENESIS: "deploy/genesis.mainnet.example.json", PRODUCER_KEY: sign.randomPrivateKey() });
  assert.equal(example.status, 1);
  assert.match(example.stdout, /config\.admins มีค่าที่ไม่ใช่ address/);
  assert.match(example.stdout, /balances มีค่าที่ไม่ใช่ address/);
  assert.match(example.stdout, /ไม่อยู่ในรายชื่อผู้ผลิต/);

  const dev = preflight({ GENESIS: "genesis.json" });
  assert.equal(dev.status, 1);
  assert.match(dev.stdout, /ไม่มี config/);
  assert.match(dev.stdout, /chainId = 1 ชนกับ Ethereum/);

  const { genesis, key } = filled();
  const ok = preflight({ GENESIS: genesis, PRODUCER_KEY: key, DATA: "/tmp/x", HOST: "127.0.0.1", TRUST_PROXY: "1" });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /chainId 272727 · block 1000 ms · maxBlockGas 1000000 · gasTarget 500000 · upgradeDelayBlocks 3600/);
  assert.doesNotMatch(ok.stdout, /เตือน/);
  assert.equal(preflight({ GENESIS: genesis, PRODUCER_KEY: key, DEV: "1" }).status, 1);   // DEV ห้ามใช้กับเชนจริง
  const loose = preflight({ GENESIS: genesis, PRODUCER_KEY: key });
  assert.equal(loose.status, 0);
  assert.match(loose.stdout, /เตือน: TRUST_PROXY/);
  assert.match(loose.stdout, /เตือน: HOST/);
});

test("server: HOST=127.0.0.1 ฟังเฉพาะในเครื่อง · ไฟล์ตัวอย่างที่กรอกครบเปิด server ได้", async () => {
  const { dir, genesis, key } = filled();
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { PATH: process.env.PATH, GENESIS: genesis, DATA: path.join(dir, "data"), PRODUCER_KEY: key, HOST: "127.0.0.1", PORT: "0" } });
  try {
    const line = await new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; if (/ทำงานที่/.test(out)) resolve(out); });
      child.on("exit", (code) => reject(new Error(`server จบ ${code}: ${out}`)));
    });
    const port = Number(line.match(/127\.0\.0\.1:(\d+)/)[1]);
    assert.ok(port > 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())).role, "producer");
    // interface อื่นของเครื่อง (ถ้ามี) ต่อไม่ได้
    const external = Object.values(os.networkInterfaces()).flat().find((item) => item.family === "IPv4" && !item.internal)?.address;
    if (external) await assert.rejects(fetch(`http://${external}:${port}/health`, { signal: AbortSignal.timeout(2000) }));
  } finally { child.kill(); }
});
