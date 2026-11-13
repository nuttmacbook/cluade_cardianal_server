import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Interface, id as topicId } from "ethers";
import { VM, MemoryDB } from "./helpers.js";
import { createEvmRpc, EVM_ERROR } from "../src/node/evm-rpc.js";
import { attachEvmWebSocket } from "../src/node/evm-ws.js";
import { Mempool } from "../src/node/mempool.js";
import * as sign from "../src/crypto/signature.js";

/*
 * added EVM-style RPCs:
 *   filters over HTTP: eth_newFilter / eth_newBlockFilter / eth_newPendingTransactionFilter / eth_getFilterChanges / eth_getFilterLogs / eth_uninstallFilter
 *   ws eth_subscribe("newPendingTransactions") · eth_createAccessList · eth_simulateV1
 */

const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";
const P = "0x00000000000000000000000000000000000000c1";
const CODE = `function program() {
  function initialization() { writeDB("count", 0n) }
  function bump(params) {
    const next = readDB("count") + params.input.by
    writeDB("count", next)
    emit("Bumped", { who: params.context.sender, by: params.input.by }, { indexed: ["who"] })
    return next
  }
  function count() { return readDB("count") }
  function boom() { throw new Error("nope") }
  return { bump, count, boom }
}`;
const ABI = { functions: [
  { name: "bump", inputs: [{ name: "by", type: "uint" }], outputs: [{ type: "uint" }] },
  { name: "count", outputs: [{ type: "uint" }], readonly: true },
  { name: "boom" },
] };
const iface = new Interface(["function bump(uint256 by) returns (uint256)", "function boom()"]);
const BUMPED = topicId("Bumped(address,uint256)");

function chain(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 7777, recordBlocks: true, recordTransactions: true, recordHistory: true });
  let number = 0;
  const as = { sender: OWNER, origin: OWNER };
  const block = (...requests) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: 1_700_000_000_000 + number * 1000 });
    requests.forEach(([method, request]) => assert.equal(b[method](request).status, "success"));
    b.commit();
  };
  block(["deploy", { programUuid: P, code: CODE, context: as, metadata: { abi: ABI } }], ["init", { programUuid: P }]);
  const bump = (by) => block(["call", { programUuid: P, functionName: "bump", input: { by: `${by}n` }, context: as }]);
  return { vm, block, bump, rpc: createEvmRpc({ vm, ...options }) };
}
const send = (rpc, method, params = [], client) => rpc.handle({ jsonrpc: "2.0", id: 1, method, params }, { client });
const ask = (rpc, method, params = [], client) => {
  const reply = send(rpc, method, params, client);
  assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

test("eth_newFilter: getFilterChanges returns logs new since the last poll · getFilterLogs returns the whole range · not found after uninstall", () => {
  const { rpc, bump } = chain();
  bump(1);   // block 2: before the filter is created
  const filter = ask(rpc, "eth_newFilter", [{ address: P, topics: [BUMPED], fromBlock: "0x1" }]);
  assert.match(filter, /^0x[0-9a-f]{32}$/);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [filter]), []);   // old entries don't count as new
  bump(2);
  bump(3);
  const changes = ask(rpc, "eth_getFilterChanges", [filter]);
  assert.deepEqual(changes.map((log) => log.blockNumber), ["0x3", "0x4"]);
  assert.equal(changes[0].topics[0], BUMPED);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [filter]), []);   // already read = not sent again
  assert.deepEqual(ask(rpc, "eth_getFilterLogs", [filter]).map((log) => log.blockNumber), ["0x2", "0x3", "0x4"]);

  // topic mismatch → nothing · malformed address → error on creation
  const other = ask(rpc, "eth_newFilter", [{ topics: [topicId("Other()")] }]);
  bump(4);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [other]), []);
  assert.equal(send(rpc, "eth_newFilter", [{ address: "0x12" }]).error.code, EVM_ERROR.PARAMS);
  assert.equal(send(rpc, "eth_newFilter", [{ blockHash: `0x${"1".repeat(64)}` }]).error.code, EVM_ERROR.PARAMS);

  assert.equal(ask(rpc, "eth_uninstallFilter", [filter]), true);
  assert.equal(ask(rpc, "eth_uninstallFilter", [filter]), false);
  assert.deepEqual(send(rpc, "eth_getFilterChanges", [filter]).error, { code: EVM_ERROR.SERVER, message: "filter not found" });
});

test("eth_newFilter: toBlock stops at that block · lagging more than logRange → sent one range at a time", () => {
  const { rpc, bump } = chain({ logRange: 2 });
  const capped = ask(rpc, "eth_newFilter", [{ address: P, toBlock: "0x3" }]);
  const all = ask(rpc, "eth_newFilter", [{ address: P }]);
  for (let i = 1; i <= 5; i += 1) bump(i);   // block 2..6
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [capped]).map((log) => log.blockNumber), ["0x2", "0x3"]);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [capped]), []);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [all]).map((log) => log.blockNumber), ["0x2", "0x3"]);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [all]).map((log) => log.blockNumber), ["0x4", "0x5"]);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [all]).map((log) => log.blockNumber), ["0x6"]);
});

test("eth_newBlockFilter returns new block hashes · filters expire when not polled · limited per client and per node", () => {
  let clock = 0;
  const { rpc, bump, vm } = chain({ now: () => clock, filterTtlMs: 1000, maxFiltersPerClient: 2, maxFilters: 3 });
  const blocks = ask(rpc, "eth_newBlockFilter", [], "1.1.1.1");
  bump(1);
  bump(1);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [blocks]), [vm.getBlock(2).hash, vm.getBlock(3).hash]);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [blocks]), []);

  ask(rpc, "eth_newBlockFilter", [], "1.1.1.1");
  assert.equal(send(rpc, "eth_newBlockFilter", [], "1.1.1.1").error.code, EVM_ERROR.LIMIT);
  ask(rpc, "eth_newBlockFilter", [], "2.2.2.2");
  assert.equal(send(rpc, "eth_newBlockFilter", [], "3.3.3.3").error.code, EVM_ERROR.LIMIT);   // node-wide limit reached
  clock = 900;
  ask(rpc, "eth_getFilterChanges", [blocks]);   // polled = renewed
  clock = 1500;
  assert.equal(rpc.filterCount(), 1);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [blocks]), []);
  clock = 2600;
  assert.equal(send(rpc, "eth_getFilterChanges", [blocks]).error.message, "filter not found");
  assert.match(ask(rpc, "eth_newBlockFilter", [], "1.1.1.1"), /^0x/);
});

const KEY = sign.randomPrivateKey();
const ALICE = sign.addressOf(KEY);
function pooled() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 1, requireNonce: true, recordTransactions: true, recordBlocks: true });
  const mempool = new Mempool(vm);
  const rpc = createEvmRpc({ vm, mempool });
  const add = (nonce) => {
    const tx = { chainId: 1, action: "transfer", from: ALICE, to: BOB, value: 0, nonce, gasLimit: 0, gasPrice: 0 };
    const result = mempool.add({ tx, signature: sign.signTransaction(tx, KEY) });
    assert.ok(result.ok, result.reason);
    return result.hash;
  };
  return { vm, mempool, rpc, add };
}

test("eth_newPendingTransactionFilter returns hashes of txs entering the mempool after the filter is created", () => {
  const { rpc, add } = pooled();
  const before = add(0);
  const filter = ask(rpc, "eth_newPendingTransactionFilter");
  const first = add(1);
  const second = add(2);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [filter]), [first, second]);
  assert.deepEqual(ask(rpc, "eth_getFilterChanges", [filter]), []);
  assert.ok(!ask(rpc, "eth_getFilterChanges", [filter]).includes(before));
  assert.equal(send(rpc, "eth_getFilterLogs", [filter]).error.message, "filter not found");   // getFilterLogs works with log filters only
});

test("ws: eth_subscribe newPendingTransactions sends the hash immediately · true = the full tx", async () => {
  const { vm, rpc, add } = pooled();
  const server = http.createServer((request, response) => response.end());
  const ws = attachEvmWebSocket(server, { rpc, vm, pollMs: 20 });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/evm`);
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
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newPendingTransactions"] }));
    const hashes = (await next((m) => m.id === 1)).result;
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newPendingTransactions", true] }));
    const full = (await next((m) => m.id === 2)).result;
    const hash = add(0);
    const got = await next((m) => m.params?.subscription === hashes);
    assert.equal(got.params.result, hash);
    const tx = await next((m) => m.params?.subscription === full);
    assert.deepEqual([tx.params.result.hash, tx.params.result.from, tx.params.result.blockNumber], [hash, ALICE, null]);
    // filters also work over ws (forwarded to rpc with the IP)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_newBlockFilter" }));
    assert.match((await next((m) => m.id === 3)).result, /^0x[0-9a-f]{32}$/);
    socket.close();
  } finally {
    ws.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("eth_createAccessList: empty accessList + gasUsed equals eth_estimateGas · revert → error", () => {
  const { rpc } = chain();
  const request = { from: OWNER, to: P, data: iface.encodeFunctionData("bump", [3]) };
  const result = ask(rpc, "eth_createAccessList", [request, "latest"]);
  assert.deepEqual(result, { accessList: [], gasUsed: ask(rpc, "eth_estimateGas", [request]) });
  assert.deepEqual(ask(rpc, "eth_createAccessList", [{ from: OWNER, to: BOB }]), { accessList: [], gasUsed: "0x5208" });
  assert.match(send(rpc, "eth_createAccessList", [{ from: OWNER, to: P, data: iface.encodeFunctionData("boom") }]).error.message, /execution reverted: nope/);
});

test("eth_simulateV1: chained calls see each other's effects · returnData / logs / revert · no commit", () => {
  const { rpc, vm } = chain();
  const before = vm.latestBlockNumber();
  const bump = (by) => ({ from: OWNER, to: P, data: iface.encodeFunctionData("bump", [by]) });
  const [block] = ask(rpc, "eth_simulateV1", [{ blockStateCalls: [{ calls: [bump(5), bump(7), { from: OWNER, to: P, data: iface.encodeFunctionData("boom") },
    { from: OWNER, to: BOB, value: "0x0" }, { from: OWNER, to: BOB, data: "0x1234" }] }] }, "latest"]);
  assert.equal(block.number, `0x${(before + 1).toString(16)}`);
  assert.equal(block.parentHash, vm.getBlock(before).hash);
  const [a, b, boom, transfer, bad] = block.calls;
  assert.deepEqual([a.status, iface.decodeFunctionResult("bump", a.returnData)[0]], ["0x1", 5n]);
  assert.deepEqual([b.status, iface.decodeFunctionResult("bump", b.returnData)[0]], ["0x1", 12n]);   // sees the previous call's effect
  assert.deepEqual([b.logs[0].address, b.logs[0].topics[0], b.logs[0].logIndex], [P, BUMPED, "0x1"]);
  assert.equal(boom.status, "0x0");
  assert.match(boom.error.message, /execution reverted: nope/);
  assert.equal(transfer.status, "0x1");
  assert.deepEqual([bad.status, bad.error.message], ["0x0", "data sent to an address that is not a program"]);
  assert.ok(Number(block.gasUsed) > 0);
  // no state change / no block created
  assert.equal(vm.latestBlockNumber(), before);
  assert.equal(vm.query({ programUuid: P, functionName: "count" }).result, "0n");

  const fails = (payload, pattern) => assert.match(send(rpc, "eth_simulateV1", [payload]).error.message, pattern);
  fails({}, /blockStateCalls must be an array/);
  fails({ blockStateCalls: [{ calls: [] }, { calls: [] }] }, /only 1 blockStateCalls/);
  fails({ blockStateCalls: [{ calls: [], stateOverrides: { [OWNER]: { balance: "0x1" } } }] }, /stateOverrides is not supported/);
  fails({ blockStateCalls: [{ calls: [], blockOverrides: { time: "0x1" } }] }, /blockOverrides is not supported/);
  assert.match(send(rpc, "eth_simulateV1", [{ blockStateCalls: [{ calls: [] }] }, "0x0"]).error.message, /latest block only/);
});
