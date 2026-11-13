/**
 * WebSocket for /evm (ws://host/evm) — lets Blockscout / ethers receive new blocks in realtime via eth_subscribe
 *
 *   attachEvmWebSocket(server, { rpc, vm, allow: (ip) => limiter.allow(ip) });
 *
 * Read-only like POST /evm: every other method is forwarded to rpc.handle
 *   - eth_subscribe("newHeads")            → the header of every new block
 *   - eth_subscribe("logs", { address, topics }) → logs of new blocks matching the filter
 *   - eth_subscribe("newPendingTransactions"[, true]) → hashes of txs as soon as they enter the mempool (true = full tx like eth_getTransactionByHash)
 *   - eth_unsubscribe(id)
 * Load protection: allow(ip) counts every request (a batch counts each item) · allowSend(ip) additionally counts eth_sendRawTransaction (same quota as /sendtx)
 *   batches at most maxBatch · subscriptions per connection at most maxSubscriptions · connections per IP at most maxConnectionsPerIp
 * No external library: handshake + frames per RFC 6455 (text / ping / close only, no fragmented frames)
 * new blocks are detected from vm.latestBlockNumber() every pollMs, only while someone is subscribed (doesn't touch the block producer)
 */
import crypto from "node:crypto";
import { EVM_ERROR, parseError } from "./evm-rpc.js";
import { clientIp } from "./client-ip.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 1 << 20;
const OP = { TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function frame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** cut complete frames off the buffer → { frames, rest } · malformed frame → null */
function readFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let at = offset + 2;
    if (length === 126) {
      if (buffer.length < at + 2) break;
      length = buffer.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      if (buffer.length < at + 8) break;
      const big = buffer.readBigUInt64BE(at);
      if (big > BigInt(MAX_PAYLOAD)) return null;
      length = Number(big);
      at += 8;
    }
    if (!masked || length > MAX_PAYLOAD || (first & 0x80) === 0) return null;   // clients must mask · no fragmented frames
    if (buffer.length < at + 4 + length) break;
    const mask = buffer.subarray(at, at + 4);
    const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    frames.push({ opcode: first & 0x0f, payload });
    offset = at + 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * @param {import("node:http").Server} server
 * @param {{ rpc: ReturnType<import("./evm-rpc.js").createEvmRpc>, vm: object, path?: string, pollMs?: number, allow?: (ip: string) => boolean }} options
 */
export function attachEvmWebSocket(server, { rpc, vm, path = "/evm", pollMs = 1000, allow = () => true, allowSend = () => true,
  maxBatch = 1000, maxSubscriptions = 100, maxConnectionsPerIp = 20 } = {}) {
  const clients = new Set();
  let timer = null;
  let seen = vm.latestBlockNumber() ?? 0;

  const subscribed = () => [...clients].some((client) => client.subscriptions.size > 0);
  const call = (method, params) => rpc.handle({ jsonrpc: "2.0", id: 0, method, params }).result;
  // a tx enters the mempool → send immediately (no waiting for poll) · filtered at send time: nobody subscribed = nothing to do
  const stopPending = rpc.onPendingTransaction?.((hash) => {
    let full;
    for (const client of clients) {
      for (const [id, { kind, filter }] of client.subscriptions) {
        if (kind !== "newPendingTransactions") continue;
        if (filter === true) full ??= call("eth_getTransactionByHash", [hash]);
        client.notify(id, filter === true ? full ?? hash : hash);
      }
    }
  });

  function poll() {
    const latest = vm.latestBlockNumber() ?? 0;
    for (let number = seen + 1; number <= latest; number += 1) {
      const quantity = `0x${number.toString(16)}`;
      let head = null;
      for (const client of clients) {
        for (const [id, { kind, filter }] of client.subscriptions) {
          if (kind === "newPendingTransactions") continue;
          if (kind === "newHeads") {
            head ??= (({ transactions, uncles, totalDifficulty, size, ...header }) => header)(call("eth_getBlockByNumber", [quantity, false]));
            client.notify(id, head);
          } else {
            for (const log of call("eth_getLogs", [{ ...filter, fromBlock: quantity, toBlock: quantity }]) ?? []) client.notify(id, log);
          }
        }
      }
    }
    seen = Math.max(seen, latest);
    if (!subscribed()) { clearInterval(timer); timer = null; }
  }
  const startPolling = () => {
    if (timer) return;
    seen = vm.latestBlockNumber() ?? 0;
    timer = setInterval(() => { try { poll(); } catch (error) { console.error(error); } }, pollMs);
    timer.unref?.();
  };

  function handle(client, message) {
    const id = message?.id ?? null;
    if (message?.method === "eth_subscribe") {
      const [kind, filter = {}] = Array.isArray(message.params) ? message.params : [];
      if (kind !== "newHeads" && kind !== "logs" && kind !== "newPendingTransactions") {
        return { jsonrpc: "2.0", id, error: { code: EVM_ERROR.PARAMS, message: `unsupported subscription: ${kind}` } };
      }
      if (kind === "logs") {   // validate the filter first (bad address → error immediately)
        const check = rpc.handle({ jsonrpc: "2.0", id, method: "eth_getLogs", params: [{ ...filter, fromBlock: "latest", toBlock: "latest" }] });
        if (check.error) return check;
      }
      if (client.subscriptions.size >= maxSubscriptions) {
        return { jsonrpc: "2.0", id, error: { code: EVM_ERROR.LIMIT, message: `too many subscriptions on this connection (max ${maxSubscriptions})` } };
      }
      const subscription = `0x${crypto.randomBytes(16).toString("hex")}`;
      client.subscriptions.set(subscription, { kind, filter });
      if (kind !== "newPendingTransactions") startPolling();
      return { jsonrpc: "2.0", id, result: subscription };
    }
    if (message?.method === "eth_unsubscribe") {
      return { jsonrpc: "2.0", id, result: client.subscriptions.delete(message.params?.[0]) };
    }
    if (message?.method === "eth_sendRawTransaction" && !allowSend(client.ip)) {
      return { jsonrpc: "2.0", id, error: { code: EVM_ERROR.LIMIT, message: "Too many requests, try again later" } };
    }
    return rpc.handle(message, { client: client.ip });
  }

  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url, "http://localhost");
    const key = request.headers["sec-websocket-key"];
    if (url.pathname !== path || !key || String(request.headers.upgrade).toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const ip = clientIp(request);
    if ([...clients].filter((other) => other.ip === ip).length >= maxConnectionsPerIp) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");   // can't keep many connections open per IP
      return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

    const client = {
      ip,
      subscriptions: new Map(),
      send: (value) => { if (!socket.destroyed) socket.write(frame(OP.TEXT, Buffer.from(JSON.stringify(value)))); },
      notify: (subscription, result) => client.send({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result } }),
    };
    clients.add(client);
    let buffer = Buffer.alloc(0);
    const close = () => { clients.delete(client); socket.destroy(); };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const read = readFrames(buffer);
      if (!read) { socket.end(frame(OP.CLOSE, Buffer.from([0x03, 0xea]))); return close(); }   // 1002 protocol error
      buffer = read.rest;
      for (const { opcode, payload } of read.frames) {
        if (opcode === OP.CLOSE) { socket.end(frame(OP.CLOSE)); return close(); }
        if (opcode === OP.PING) { socket.write(frame(OP.PONG, payload)); continue; }
        if (opcode !== OP.TEXT) continue;
        if (!allow(ip)) {
          client.send({ jsonrpc: "2.0", id: null, error: { code: EVM_ERROR.LIMIT, message: "Too many requests, try again later" } });
          continue;
        }
        let body;
        try { body = JSON.parse(payload.toString("utf8")); } catch { client.send(parseError()); continue; }
        if (Array.isArray(body) && body.length > maxBatch) {
          client.send({ jsonrpc: "2.0", id: null, error: { code: EVM_ERROR.REQUEST, message: `batch too large (max ${maxBatch})` } });
          continue;
        }
        if (Array.isArray(body) && body.slice(1).some(() => !allow(ip))) {   // the first one was already counted above
          client.send({ jsonrpc: "2.0", id: null, error: { code: EVM_ERROR.LIMIT, message: "Too many requests, try again later" } });
          continue;
        }
        try {
          client.send(Array.isArray(body) && body.length ? body.map((message) => handle(client, message)) : handle(client, body));
        } catch (error) {
          console.error(error);
          client.send({ jsonrpc: "2.0", id: null, error: { code: EVM_ERROR.INTERNAL, message: error.message } });
        }
      }
    });
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));
  });

  return { clients, poll, close: () => { clearInterval(timer); timer = null; stopPending?.(); for (const c of clients) c.subscriptions.clear(); } };
}
