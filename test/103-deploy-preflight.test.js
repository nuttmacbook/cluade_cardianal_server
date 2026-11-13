import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import * as sign from "../src/crypto/signature.js";

/*
 * deploy/: example files for launching a single-machine public chain
 *   scripts/preflight.js checks genesis + env before launch: unedited example values / dev genesis = fail · fully filled in = pass
 *   HOST=127.0.0.1 → server listens on localhost only
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

test("preflight: unedited example files / dev genesis / DEV = fail · fully filled in = pass", () => {
  const example = preflight({ GENESIS: "deploy/genesis.mainnet.example.json", PRODUCER_KEY: sign.randomPrivateKey() });
  assert.equal(example.status, 1);
  assert.match(example.stdout, /config\.admins มีค่าที่ไม่ใช่ address/);
  assert.match(example.stdout, /balances มีค่าที่ไม่ใช่ address/);
  assert.match(example.stdout, /ไม่อยู่ในรายชื่อผู้ผลิต/);

  const dev = preflight({ GENESIS: "genesis.json" });
  assert.equal(dev.status, 1);
  assert.match(dev.stdout, /ไม่มี config/);
  assert.doesNotMatch(dev.stdout, /chainId = 1 ชนกับ Ethereum/);   // the repo's genesis.json uses chainId 41234 (Bluewolfchain)

  const { genesis, key } = filled();
  const ok = preflight({ GENESIS: genesis, PRODUCER_KEY: key, DATA: "/tmp/x", HOST: "127.0.0.1", TRUST_PROXY: "1" });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /chainId 41234 · block 2000 ms · maxBlockGas 5000000 · gasTarget 2500000 · upgradeDelayBlocks 3600/);
  assert.doesNotMatch(ok.stdout, /เตือน/);
  assert.equal(preflight({ GENESIS: genesis, PRODUCER_KEY: key, DEV: "1" }).status, 1);   // DEV must never be used on a real chain
  const loose = preflight({ GENESIS: genesis, PRODUCER_KEY: key });
  assert.equal(loose.status, 0);
  assert.match(loose.stdout, /เตือน: TRUST_PROXY/);
  assert.match(loose.stdout, /เตือน: HOST/);
  assert.match(ok.stdout, /forks: bluewolf@0/);

  // forks missing → fail (the chain would launch with the old gas table: a native transfer costs 1,300 gas instead of 17,300)
  const noFork = JSON.parse(fs.readFileSync(genesis, "utf8"));
  delete noFork.forks;
  fs.writeFileSync(genesis, JSON.stringify(noFork));
  const missing = preflight({ GENESIS: genesis, PRODUCER_KEY: key, DATA: "/tmp/x", HOST: "127.0.0.1", TRUST_PROXY: "1" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /genesis ไม่มี fork "bluewolf"/);
});

test("server: HOST=127.0.0.1 listens on localhost only · a fully filled-in example file starts the server", async () => {
  const { dir, genesis, key } = filled();
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { PATH: process.env.PATH, GENESIS: genesis, DATA: path.join(dir, "data"), PRODUCER_KEY: key, HOST: "127.0.0.1", PORT: "0" } });
  try {
    const line = await new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; if (/ทำงานที่/.test(out)) resolve(out); });
      child.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
    });
    const port = Number(line.match(/127\.0\.0\.1:(\d+)/)[1]);
    assert.ok(port > 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())).role, "producer");
    // other network interfaces of the machine (if any) cannot connect
    const external = Object.values(os.networkInterfaces()).flat().find((item) => item.family === "IPv4" && !item.internal)?.address;
    if (external) await assert.rejects(fetch(`http://${external}:${port}/health`, { signal: AbortSignal.timeout(2000) }));
  } finally { child.kill(); }
});
