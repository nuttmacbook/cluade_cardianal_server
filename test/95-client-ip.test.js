import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { clientIp } from "../src/node/client-ip.js";

/*
 * rate limiting behind a reverse proxy (src/node/client-ip.js · TRUST_PROXY)
 *   0 = the socket IP · N = counted from the right of X-Forwarded-For + socket (users can only forge the left part)
 */

const ROOT = path.join(import.meta.dirname, "..");
const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });

test("clientIp: TRUST_PROXY 0 / 1 / 2 · forging the left of the header has no effect · no header = the socket IP", () => {
  assert.equal(clientIp(req("10.0.0.1", "1.1.1.1"), 0), "10.0.0.1");               // header not trusted
  assert.equal(clientIp(req("10.0.0.1", "1.1.1.1"), 1), "1.1.1.1");                // nginx appends the user IP
  assert.equal(clientIp(req("10.0.0.1", "6.6.6.6, 1.1.1.1"), 1), "1.1.1.1");       // the user sent 6.6.6.6 themselves → ignored
  assert.equal(clientIp(req("10.0.0.1", "6.6.6.6, 1.1.1.1, 172.16.0.9"), 2), "1.1.1.1");   // CDN + nginx
  assert.equal(clientIp(req("10.0.0.1", "1.1.1.1"), 3), "1.1.1.1");                // fewer hops than configured = leftmost
  assert.equal(clientIp(req("10.0.0.1"), 1), "10.0.0.1");
  assert.equal(clientIp(req("10.0.0.1", ["6.6.6.6", "1.1.1.1"]), 1), "1.1.1.1");   // header repeated on several lines
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
  throw new Error("server did not start");
}

const post = (url, xff) => fetch(`${url}/query`, { method: "POST", headers: { "content-type": "application/json", ...(xff ? { "x-forwarded-for": xff } : {}) },
  body: JSON.stringify({ programUuid: "0x0000000000000000000000000000000000000001", functionName: "x" }) }).then((r) => r.status);

test("server behind a proxy: TRUST_PROXY=1 counts quota per user · unset = everyone shares the proxy's quota", async () => {
  const behind = await startServer({ TRUST_PROXY: "1", RATE_LIMIT: "2" });
  try {
    assert.notEqual(await post(behind.url, "1.1.1.1"), 429);
    assert.notEqual(await post(behind.url, "1.1.1.1"), 429);
    assert.equal(await post(behind.url, "1.1.1.1"), 429);
    assert.equal(await post(behind.url, "9.9.9.9, 1.1.1.1"), 429);   // forging the left part does not help
    assert.notEqual(await post(behind.url, "2.2.2.2"), 429);         // another user still has quota
  } finally { behind.child.kill(); }

  const direct = await startServer({ RATE_LIMIT: "2" });
  try {
    assert.notEqual(await post(direct.url, "1.1.1.1"), 429);
    assert.notEqual(await post(direct.url, "2.2.2.2"), 429);
    assert.equal(await post(direct.url, "3.3.3.3"), 429);            // header ignored: everyone is 127.0.0.1
  } finally { direct.child.kill(); }
});
