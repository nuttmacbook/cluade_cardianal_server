import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { VM, MemoryDB } from "./helpers.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";
import { attachEvmWebSocket } from "../src/node/evm-ws.js";
import { RateLimiter } from "../src/node/ratelimit.js";

/*
 * load protection before opening the public chain
 *   HTTP: body over MAX_BODY_BYTES = 413 (not read in full) · /evm batch over EVM_MAX_BATCH = rejected · every request in a batch counts toward EVM_RATE_LIMIT
 *   ws: batch over maxBatch · every batch item counts · eth_sendRawTransaction counts toward allowSend (the /sendtx quota)
 *       subscriptions per connection ≤ maxSubscriptions · connections per IP ≤ maxConnectionsPerIp
 */

// ---------------------------------------------------------------------------
//  server.js over real HTTP

let server, url;

before(async () => {
  process.env.MAX_BODY_BYTES = "2048";
  process.env.EVM_MAX_BATCH = "3";
  process.env.EVM_RATE_LIMIT = "8";
  process.env.RATE_LIMIT = "0";
  process.env.GAS_PRICE ??= "1000000000";
  ({ server } = await import("../server.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.closeAllConnections?.(); server.close(); });

const post = (path, body) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const call = (id, method = "eth_chainId") => ({ jsonrpc: "2.0", id, method, params: [] });

test("server: body over MAX_BODY_BYTES → 413 on /sendtx /query /evm · normal size passes", async () => {
  const big = JSON.stringify({ pad: "x".repeat(4096) });
  for (const path of ["/sendtx", "/query"]) {
    const res = await post(path, big);
    assert.equal(res.status, 413, path);
    assert.match((await res.json()).error, /body exceeds 2048/);
    assert.notEqual((await post(path, { pad: "x".repeat(1024) })).status, 413, path);
  }
  const evm = await post("/evm", big);
  assert.equal(evm.status, 413);
  assert.equal((await evm.json()).error.code, -32600);
  // also cut off without content-length (chunked)
  const chunked = await new Promise((resolve, reject) => {
    const request = http.request(`${url}/query`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, resolve);
    request.on("error", reject);
    for (let i = 0; i < 8; i += 1) request.write("x".repeat(512));
    request.end();
  });
  assert.equal(chunked.statusCode, 413);
  chunked.resume();
});

test("server: /evm batch over EVM_MAX_BATCH is rejected · every request in a batch counts toward EVM_RATE_LIMIT", async () => {
  // the previous test (413) is not counted · EVM_RATE_LIMIT = 8
  const tooMany = await post("/evm", [call(1), call(2), call(3), call(4)]);   // counts as 1 → 1 used
  assert.equal(tooMany.status, 200);
  assert.match((await tooMany.json()).error.message, /batch too large \(max 3\)/);

  const ok = await post("/evm", [call(1), call(2), call(3)]);                 // 4 used
  assert.deepEqual((await ok.json()).map((item) => item.id), [1, 2, 3]);
  assert.equal((await post("/evm", [call(1), call(2), call(3)])).status, 200);   // 7 used
  const limited = await post("/evm", [call(1), call(2), call(3)]);            // first = 8 passes · second exceeds
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await limited.json()).error.code, -32005);
});

// ---------------------------------------------------------------------------
//  ws connected directly to attachEvmWebSocket

async function wsServer(options) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 7777, recordBlocks: true });
  vm.applyGenesis({ chainId: 7777, balances: {} });
  const http1 = http.createServer((request, response) => response.end());
  const ws = attachEvmWebSocket(http1, { rpc: createEvmRpc({ vm }), vm, pollMs: 20, ...options });
  await new Promise((resolve) => http1.listen(0, "127.0.0.1", resolve));
  return {
    port: http1.address().port,
    async close() { ws.close(); http1.closeAllConnections?.(); await new Promise((resolve) => http1.close(resolve)); },
  };
}

async function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/evm`);
  const inbox = [];
  const waiters = [];
  socket.onmessage = (event) => { inbox.push(JSON.parse(event.data)); waiters.splice(0).forEach((w) => w()); };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("ws connect failed")); });
  const next = async () => {
    while (!inbox.length) await new Promise((resolve) => waiters.push(resolve));
    return inbox.shift();
  };
  return { socket, ask: async (body) => { socket.send(JSON.stringify(body)); return next(); } };
}

test("ws: batch over maxBatch is rejected · every batch item counts against allow · subscriptions per connection are capped", async () => {
  const limiter = new RateLimiter({ limit: 6, windowMs: 60_000 });
  const node = await wsServer({ allow: (ip) => limiter.allow(ip), maxBatch: 2, maxSubscriptions: 2 });
  try {
    const { socket, ask } = await connect(node.port);
    assert.match((await ask([call(1), call(2), call(3)])).error.message, /batch too large \(max 2\)/);   // 1 used
    assert.equal((await ask({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] })).result.length, 34);   // 2
    assert.ok((await ask({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] })).result);               // 3
    const third = await ask({ jsonrpc: "2.0", id: 3, method: "eth_subscribe", params: ["newHeads"] });                    // 4
    assert.equal(third.error.code, -32005);
    assert.match(third.error.message, /too many subscriptions/);
    assert.deepEqual((await ask([call(4), call(5)])).map((item) => item.id), [4, 5]);   // 6
    const limited = await ask([call(6), call(7)]);                                     // first = 7 exceeds
    assert.equal(limited.error.code, -32005);
    socket.close();
  } finally {
    await node.close();
  }
});

test("ws: eth_sendRawTransaction counts toward allowSend (same quota as /sendtx) · read methods don't count", async () => {
  const sends = [];
  const node = await wsServer({ allowSend: (ip) => { sends.push(ip); return sends.length <= 1; } });
  try {
    const { socket, ask } = await connect(node.port);
    assert.equal((await ask(call(1))).result, "0x1e61");
    assert.equal(sends.length, 0);
    const first = await ask({ jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x00"] });
    assert.notEqual(first.error?.code, -32005);   // passes the quota (the tx is invalid and rejected for another reason)
    const second = await ask({ jsonrpc: "2.0", id: 3, method: "eth_sendRawTransaction", params: ["0x00"] });
    assert.equal(second.error.code, -32005);
    assert.deepEqual(sends, ["127.0.0.1", "127.0.0.1"]);
    socket.close();
  } finally {
    await node.close();
  }
});

test("ws: connections per IP over maxConnectionsPerIp → 429 · close an old one, then reconnect", async () => {
  const node = await wsServer({ maxConnectionsPerIp: 2 });
  try {
    const a = await connect(node.port);
    const b = await connect(node.port);
    await assert.rejects(connect(node.port), /ws connect failed/);
    const closed = new Promise((resolve) => { a.socket.onclose = resolve; });
    a.socket.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));   // let the server side see the close
    const c = await connect(node.port);
    assert.equal((await c.ask(call(9))).id, 9);
    b.socket.close();
    c.socket.close();
  } finally {
    await node.close();
  }
});
