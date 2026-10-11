import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { VM, MemoryDB } from "./helpers.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";
import { attachEvmWebSocket } from "../src/node/evm-ws.js";

/* ws://host/evm: eth_subscribe newHeads / logs + method อื่นส่งต่อให้ตัวแปลงเดิม */

const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";

test("evm ws: eth_subscribe newHeads ได้ header ของ block ใหม่ · method อื่นตอบเหมือน POST /evm · path อื่นถูกปฏิเสธ", async () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 7777, recordBlocks: true, recordTransactions: true, recordHistory: true, requireNonce: true, chargeGas: true });
  vm.applyGenesis({ chainId: 7777, balances: { [OWNER]: 1_000_000 } });
  const server = http.createServer((request, response) => response.end());
  const ws = attachEvmWebSocket(server, { rpc: createEvmRpc({ vm }), vm, pollMs: 20 });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/evm`);
    const inbox = [];
    const waiters = [];
    socket.onmessage = (event) => { inbox.push(JSON.parse(event.data)); waiters.splice(0).forEach((w) => w()); };
    const next = async (match) => {
      for (;;) {
        const index = inbox.findIndex(match);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise((resolve) => waiters.push(resolve));
      }
    };
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }));
    assert.equal((await next((m) => m.id === 1)).result, "0x1e61");
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] }));
    const subscription = (await next((m) => m.id === 2)).result;
    assert.match(subscription, /^0x[0-9a-f]{32}$/);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_subscribe", params: ["pending"] }));
    assert.ok((await next((m) => m.id === 3)).error);
    socket.send("not json");
    assert.equal((await next((m) => m.id === null)).error.code, -32700);

    const block = vm.createBlock({ number: 1, timestamp: 5000, feeRecipient: BOB });
    block.transfer({ from: OWNER, to: BOB, amount: 5, nonce: 0 });
    block.commit();
    const head = await next((m) => m.method === "eth_subscription");
    assert.equal(head.params.subscription, subscription);
    assert.deepEqual([head.params.result.number, head.params.result.hash, head.params.result.timestamp], ["0x1", vm.getBlock(1).hash, "0x5"]);
    assert.equal(head.params.result.transactions, undefined);

    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "eth_unsubscribe", params: [subscription] }));
    assert.equal((await next((m) => m.id === 4)).result, true);
    socket.close();

    const rejected = await new Promise((resolve) => {
      const other = new WebSocket(`ws://127.0.0.1:${port}/nope`);
      other.onerror = () => resolve(true);
      other.onopen = () => resolve(false);
    });
    assert.equal(rejected, true);
  } finally {
    ws.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
