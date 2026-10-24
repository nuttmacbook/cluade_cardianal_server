import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { clientIp } from "../src/node/client-ip.js";

/*
 * rate limit หลัง reverse proxy (src/node/client-ip.js · TRUST_PROXY)
 *   0 = IP ของ socket · N = นับจากขวาของ X-Forwarded-For + socket (ผู้ใช้ปลอมได้แค่ส่วนซ้าย)
 */

const ROOT = path.join(import.meta.dirname, "..");
const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });

test("clientIp: TRUST_PROXY 0 / 1 / 2 · ปลอม header ทางซ้ายไม่ได้ผล · ไม่มี header = IP ของ socket", () => {
  assert.equal(clientIp(req("10.0.0.1", "1.1.1.1"), 0), "10.0.0.1");               // ไม่เชื่อ header
  assert.equal(clientIp(req("10.0.0.1", "1.1.1.1"), 1), "1.1.1.1");                // nginx เติม IP ผู้ใช้
  assert.equal(clientIp(req("10.0.0.1", "6.6.6.6, 1.1.1.1"), 1), "1.1.1.1");       // ผู้ใช้ส่ง 6.6.6.6 มาเอง → ไม่ใช้
  assert.equal(clientIp(req("10.0.0.1", "6.6.6.6, 1.1.1.1, 172.16.0.9"), 2), "1.1.1.1");   // CDN + nginx
  assert.equal(clientIp(req("10.0.0.1", "1.1.1.1"), 3), "1.1.1.1");                // ชั้นน้อยกว่าที่ตั้ง = ซ้ายสุด
  assert.equal(clientIp(req("10.0.0.1"), 1), "10.0.0.1");
  assert.equal(clientIp(req("10.0.0.1", ["6.6.6.6", "1.1.1.1"]), 1), "1.1.1.1");   // header ซ้ำหลายบรรทัด
  assert.equal(clientIp({ socket: {}, headers: {} }, 0), "unknown");
});

async function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, DEV: "1", PORT: String(port), BLOCK_MS: "60000", DATA: "", ...env }, stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${url}/health`); return { url, child }; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  child.kill();
  throw new Error("server ไม่เริ่ม");
}

const post = (url, xff) => fetch(`${url}/query`, { method: "POST", headers: { "content-type": "application/json", ...(xff ? { "x-forwarded-for": xff } : {}) },
  body: JSON.stringify({ programUuid: "0x0000000000000000000000000000000000000001", functionName: "x" }) }).then((r) => r.status);

test("server หลัง proxy: TRUST_PROXY=1 นับโควตาแยกตามผู้ใช้ · ไม่ตั้ง = ทุกคนใช้โควตาของ proxy ร่วมกัน", async () => {
  const behind = await startServer({ TRUST_PROXY: "1", RATE_LIMIT: "2" });
  try {
    assert.notEqual(await post(behind.url, "1.1.1.1"), 429);
    assert.notEqual(await post(behind.url, "1.1.1.1"), 429);
    assert.equal(await post(behind.url, "1.1.1.1"), 429);
    assert.equal(await post(behind.url, "9.9.9.9, 1.1.1.1"), 429);   // ปลอมทางซ้ายไม่ช่วย
    assert.notEqual(await post(behind.url, "2.2.2.2"), 429);         // ผู้ใช้อีกคนยังมีโควตา
  } finally { behind.child.kill(); }

  const direct = await startServer({ RATE_LIMIT: "2" });
  try {
    assert.notEqual(await post(direct.url, "1.1.1.1"), 429);
    assert.notEqual(await post(direct.url, "2.2.2.2"), 429);
    assert.equal(await post(direct.url, "3.3.3.3"), 429);            // header ถูกเมิน: ทุกคนคือ 127.0.0.1
  } finally { direct.child.kill(); }
});
