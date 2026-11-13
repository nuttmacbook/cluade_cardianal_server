// Intercepts JSON-RPC requests sent to /evm (to see what Blockscout asks and what we answer) — doesn't touch the chain
//   node dev/evm-proxy.mjs          → listens on :3001, forwards to http://127.0.0.1:3000/evm
//   PORT=3001 TARGET=http://127.0.0.1:3000/evm node dev/evm-proxy.mjs · how to use with Blockscout: docs/blockscout.md
import http from "node:http";
import zlib from "node:zlib";

const TARGET = process.env.TARGET ?? "http://127.0.0.1:3000/evm";
const PORT = Number(process.env.PORT ?? 3001);
const short = (value, n) => { const s = JSON.stringify(value ?? null); return s.length > n ? `${s.slice(0, n)}…` : s; };

http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body = Buffer.concat(chunks);
  const gzip = /gzip/i.test(request.headers["content-encoding"] ?? "");
  if (gzip) body = zlib.gunzipSync(body);
  let asks = [];
  try { asks = [JSON.parse(body.toString("utf8"))].flat(); } catch { /* not JSON */ }
  let status = 502;
  let text = "";
  try {
    const reply = await fetch(TARGET, { method: request.method, headers: { "content-type": "application/json" }, body: request.method === "POST" ? body : undefined });
    status = reply.status;
    text = await reply.text();
  } catch (error) {
    console.log("forward failed:", error.message);
  }
  let answers = [];
  try { answers = [JSON.parse(text)].flat(); } catch { /* not JSON */ }
  if (!asks.length) console.log(`${request.method} ${request.url} unreadable body: ${body.toString("utf8").slice(0, 200)} → HTTP ${status}`);
  for (const ask of asks) {
    const answer = answers.find((a) => a?.id === ask?.id);
    const result = answer?.error ? `ERROR ${short(answer.error, 300)}` : short(answer?.result, 200);
    console.log(`${gzip ? "[gzip] " : ""}${ask?.method} ${short(ask?.params, 150)} → ${result}`);
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}).listen(PORT, "0.0.0.0", () => console.log(`proxy :${PORT} → ${TARGET}`));
