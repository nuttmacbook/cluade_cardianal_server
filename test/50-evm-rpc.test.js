import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { createEvmRpc, EVM_ERROR, toBig } from "../src/node/evm-rpc.js";

/* ตัวแปลง JSON-RPC แบบ EVM (POST /evm): อ่านข้อมูลเชนเดิมแล้วตอบในรูปแบบ EVM · ไม่เขียนอะไรลงเชน */

const T = "0x00000000000000000000000000000000000000f1";
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const MINER = "0x1111111111111111111111111111111111111111";
const START = Date.parse("2026-01-01T00:00:00Z");

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 7777, recordBlocks: true, recordTransactions: true, recordHistory: true,
    requireNonce: true, chargeGas: true });
  vm.applyGenesis({ chainId: 7777, balances: { [OWNER]: 1_000_000 } });
  let number = 0;
  const block = (fn) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: START + number * 1000, feeRecipient: MINER });
    const results = fn(b);
    b.commit();
    return results;
  };
  const as = { sender: OWNER, origin: OWNER };
  block((b) => [
    b.deploy({ programUuid: T, code: TOKEN_PROGRAM, context: as, nonce: 0, initInput: { name: "Test", ticker: "TST", decimals: "2n", supply: "1000000n" } }),
    b.init({ programUuid: T }),
  ]).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  const [pay] = block((b) => [b.transfer({ from: OWNER, to: BOB, amount: 500, nonce: 1 })]);
  assert.equal(pay.status, "success", JSON.stringify(pay.error));
  const [send] = block((b) => [b.call({ programUuid: T, functionName: "transfer", input: { to: BOB, amount: "250n" }, context: as, nonce: 2 })]);
  assert.equal(send.status, "success", JSON.stringify(send.error));
  return { vm, rpc: createEvmRpc({ vm, decimals: 18 }) };   // เทสต์นี้ใส่ยอดเป็นเหรียญ (ไม่มีทศนิยม) → ให้ตัวแปลงเติม 18 ทศนิยม
}
const ask = (rpc, method, ...params) => {
  const reply = rpc.handle({ jsonrpc: "2.0", id: 1, method, params });
  assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const abiWord = (hex) => BigInt(`0x${hex.replace(/^0x/, "").slice(-64)}`);

test("evm: chainId / blockNumber / balance (×10^18) / nonce เป็น hex ตรงกับเชน", () => {
  const { vm, rpc } = chain();
  assert.equal(ask(rpc, "eth_chainId"), "0x1e61");
  assert.equal(ask(rpc, "net_version"), "7777");
  assert.equal(ask(rpc, "eth_blockNumber"), "0x3");
  const balance = vm.nativeBalanceOf(BOB).balance;
  assert.equal(BigInt(ask(rpc, "eth_getBalance", BOB, "latest")), BigInt(balance) * 10n ** 18n);
  assert.equal(ask(rpc, "eth_getTransactionCount", OWNER, "latest"), "0x3");
  assert.equal(BigInt(createEvmRpc({ vm, decimals: 0 }).handle({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [BOB] }).result), BigInt(balance));
});

test("evm: block มีฟิลด์ครบแบบ EVM · timestamp เป็นวินาที · block 0 = genesis และ parentHash ต่อกัน", () => {
  const { vm, rpc } = chain();
  const latest = ask(rpc, "eth_getBlockByNumber", "latest", false);
  for (const field of ["number", "hash", "parentHash", "miner", "gasLimit", "gasUsed", "timestamp", "logsBloom", "transactionsRoot", "stateRoot", "transactions"]) {
    assert.ok(field in latest, field);
  }
  assert.equal(latest.timestamp, `0x${((START + 3000) / 1000).toString(16)}`);
  assert.equal(latest.miner, MINER);
  assert.deepEqual(latest.transactions, vm.getBlock(3).txHashes);
  const genesis = ask(rpc, "eth_getBlockByNumber", "0x0", false);
  assert.equal(genesis.hash, vm.genesisHash());
  assert.equal(ask(rpc, "eth_getBlockByNumber", "0x1", false).parentHash, genesis.hash);
  assert.equal(ask(rpc, "eth_getBlockByHash", latest.hash, false).number, "0x3");
  assert.equal(ask(rpc, "eth_getBlockByNumber", "0x99", false), null);
  const full = ask(rpc, "eth_getBlockByNumber", "0x2", true);
  assert.equal(full.transactions[0].hash, vm.getBlock(2).txHashes[0]);
});

test("evm: tx + receipt ของการโอน native · status 0x1 · value ×10^18", () => {
  const { vm, rpc } = chain();
  const [hash] = vm.getBlock(2).txHashes;
  const tx = ask(rpc, "eth_getTransactionByHash", hash);
  assert.deepEqual([tx.from, tx.to, BigInt(tx.value), tx.nonce, tx.blockNumber, tx.input], [OWNER, BOB, 500n * 10n ** 18n, "0x1", "0x2", "0x"]);
  const receipt = ask(rpc, "eth_getTransactionReceipt", hash);
  assert.deepEqual([receipt.status, receipt.transactionHash, receipt.blockNumber, receipt.logs.length], ["0x1", hash, "0x2", 0]);
  assert.equal(ask(rpc, "eth_getTransactionReceipt", `0x${"ab".repeat(32)}`), null);
});

test("evm: deploy → contractAddress · event Transfer ของ token มาตรฐาน → log แบบ ERC-20", () => {
  const { vm, rpc } = chain();
  const deploy = ask(rpc, "eth_getTransactionReceipt", vm.getBlock(1).txHashes[0]);
  assert.equal(deploy.contractAddress, T);
  const [hash] = vm.getBlock(3).txHashes;
  const [log] = ask(rpc, "eth_getTransactionReceipt", hash).logs;
  assert.equal(log.address, T);
  assert.deepEqual(log.topics, [
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",   // keccak("Transfer(address,address,uint256)")
    `0x${OWNER.slice(2).padStart(64, "0")}`, `0x${BOB.slice(2).padStart(64, "0")}`,
  ]);
  assert.equal(abiWord(log.data), 250n);
  assert.equal(ask(rpc, "eth_getTransactionByHash", hash).to, T);
});

test("evm: eth_call ฟังก์ชันอ่านของ ERC-20 บน token มาตรฐาน · getCode บอกว่าเป็นโปรแกรม", () => {
  const { vm, rpc } = chain();
  const call = (data) => ask(rpc, "eth_call", { to: T, data }, "latest");
  const pad = (address) => address.slice(2).padStart(64, "0");
  assert.equal(abiWord(call(`0x70a08231${pad(BOB)}`)), 250n);
  assert.equal(abiWord(call("0x313ce567")), 2n);
  assert.equal(abiWord(call("0x18160ddd")), 1_000_000n);
  assert.equal(abiWord(call(`0xdd62ed3e${pad(OWNER)}${pad(BOB)}`)), 0n);
  const symbol = call("0x95d89b41").slice(2);
  assert.equal(Buffer.from(symbol.slice(128, 128 + Number(abiWord(symbol.slice(64, 128))) * 2), "hex").toString(), "TST");
  assert.equal(Buffer.from(ask(rpc, "eth_getCode", T, "latest").slice(2), "hex").toString(), TOKEN_PROGRAM);   // ซอร์ส JS เป็น UTF-8 hex
  assert.equal(ask(rpc, "eth_getCode", BOB, "latest"), "0x");
  const other = rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: T, data: "0xa9059cbb" }] });
  assert.equal(other.error.code, EVM_ERROR.SERVER);
  assert.equal(vm.nativeBalanceOf(BOB).balance, 500n);   // อ่านอย่างเดียว ไม่มีอะไรเปลี่ยน
});

test("evm: ไม่ได้ต่อ submit = ส่ง tx ไม่ได้ (error ชัดเจน · ส่งได้จริงดู test 94) · method ที่ไม่รองรับ / batch / params ผิด", () => {
  const { rpc } = chain();
  const send = rpc.handle({ jsonrpc: "2.0", id: 9, method: "eth_sendRawTransaction", params: ["0x02f8"] });
  assert.equal(send.id, 9);
  assert.equal(send.error.code, EVM_ERROR.SERVER);
  assert.match(send.error.message, /not enabled/);
  assert.equal(rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_newFilter", params: [] }).error.code, EVM_ERROR.METHOD);
  assert.equal(rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["nope"] }).error.code, EVM_ERROR.PARAMS);
  assert.equal(rpc.handle({ id: 1 }).error.code, EVM_ERROR.REQUEST);
  const batch = rpc.handle([{ jsonrpc: "2.0", id: 1, method: "eth_chainId" }, { jsonrpc: "2.0", id: 2, method: "nope" }]);
  assert.deepEqual(batch.map((r) => [r.id, r.result ?? r.error.code]), [[1, "0x1e61"], [2, EVM_ERROR.METHOD]]);
  assert.equal(rpc.handle([]).error.code, EVM_ERROR.REQUEST);
});

test("evm: chainParams สำหรับ wallet_addEthereumChain · toBig อ่านเลขทุกแบบของเชน", () => {
  const { rpc } = chain();
  assert.deepEqual(rpc.chainParams({ rpcUrl: "https://x/evm", explorerUrl: "https://x/evm/explorer", name: "Test", symbol: "TT" }), {
    chainId: "0x1e61", chainName: "Test", nativeCurrency: { name: "Test", symbol: "TT", decimals: 18 },
    rpcUrls: ["https://x/evm"], blockExplorerUrls: ["https://x/evm/explorer"],
  });
  assert.deepEqual([toBig("12n"), toBig(12), toBig("12"), toBig(12n), toBig(null)], [12n, 12n, 12n, 12n, 0n]);
});

test("evm: ยอด / nonce / code / eth_call ตามเลข block อ่านจาก history (ไม่ใช่ยอดล่าสุดเสมอ)", () => {
  const { vm, rpc } = chain();
  const coins = (n) => BigInt(n) * 10n ** 18n;
  assert.equal(BigInt(ask(rpc, "eth_getBalance", OWNER, "0x0")), coins(1_000_000));
  assert.equal(BigInt(ask(rpc, "eth_getBalance", BOB, "0x1")), 0n);
  assert.equal(BigInt(ask(rpc, "eth_getBalance", BOB, "0x2")), coins(500));
  const owner = (n) => BigInt(ask(rpc, "eth_getBalance", OWNER, n));
  assert.ok(owner("0x0") > owner("0x1") && owner("0x1") > owner("0x2") && owner("0x2") > owner("0x3"));   // ค่าแก๊ส + โอน ทีละ block
  assert.equal(owner("latest"), coins(vm.nativeBalanceOf(OWNER).balance));
  assert.equal(owner({ blockNumber: "0x0" }), coins(1_000_000));
  assert.deepEqual(["0x0", "0x1", "0x2", "0x3"].map((n) => ask(rpc, "eth_getTransactionCount", OWNER, n)), ["0x0", "0x1", "0x2", "0x3"]);
  assert.equal(ask(rpc, "eth_getCode", T, "0x0"), "0x");
  assert.notEqual(ask(rpc, "eth_getCode", T, "0x1"), "0x");
  const pad = (address) => address.slice(2).padStart(64, "0");
  const balanceOf = (who, n) => abiWord(ask(rpc, "eth_call", { to: T, data: `0x70a08231${pad(who)}` }, n));
  assert.deepEqual([balanceOf(BOB, "0x2"), balanceOf(BOB, "0x3"), balanceOf(OWNER, "0x1"), balanceOf(OWNER, "0x3")], [0n, 250n, 1_000_000n, 999_750n]);
  assert.equal(rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: T, data: "0x18160ddd" }, "0x0"] }).error.code, EVM_ERROR.SERVER);   // ยังไม่ deploy
  assert.equal(rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [BOB, "0x99"] }).error.message, "header not found");
});

/* โปรแกรม R เรียก token ซ้อน 2 ครั้ง แล้วโอน native ต่อด้วย transferNative · block 2 มี 2 tx ที่ emit Transfer */
const R = "0x00000000000000000000000000000000000000f2";
const RELAY = `function program() {
  function pay(params) {
    const before = runProgram(params.input.token, "balanceOf", { who: params.input.to })
    runProgram(params.input.token, "transfer", { to: params.input.to, amount: 5n })
    transferNative(params.input.to, 7n)
    return before
  }
  function boom(params) { throw new Error("nope") }
  return { pay, boom }
}`;
function nested({ maxBlockGas = null } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 7777, recordBlocks: true, recordTransactions: true, recordHistory: true,
    requireNonce: true, chargeGas: true, maxBlockGas, burnPercent: 50, feeRecipient: MINER });
  vm.applyGenesis({ chainId: 7777, balances: { [OWNER]: 1_000_000 } });
  const as = { sender: OWNER, origin: OWNER };
  const run = (number, fn) => {
    const b = vm.createBlock({ number, timestamp: START + number * 1000, feeRecipient: MINER });
    fn(b).forEach((r) => assert.ok(r.accepted, JSON.stringify(r.error)));
    b.commit();
  };
  run(1, (b) => [
    b.deploy({ programUuid: R, code: RELAY, context: as, nonce: 0 }), b.init({ programUuid: R }),
    b.deploy({ programUuid: T, code: TOKEN_PROGRAM, context: as, nonce: 1, initInput: { name: "Test", ticker: "TST", decimals: "2n", supply: "1000n" } }),
    b.init({ programUuid: T }),
    b.call({ programUuid: T, functionName: "transfer", input: { to: R, amount: "100n" }, context: as, nonce: 2 }),
  ]);
  run(2, (b) => [
    b.call({ programUuid: T, functionName: "transfer", input: { to: BOB, amount: "1n" }, context: as, nonce: 3 }),
    b.call({ programUuid: R, functionName: "pay", input: { token: T, to: BOB }, context: as, nonce: 4, value: 100 }),
    b.call({ programUuid: R, functionName: "boom", input: {}, context: as, nonce: 5 }),
    b.transfer({ from: OWNER, to: BOB, amount: 3, nonce: 6 }),
  ]);
  return { vm, rpc: createEvmRpc({ vm, decimals: 18 }) };
}

test("evm: logIndex นับต่อเนื่องทั้ง block · eth_getBlockReceipts · eth_getLogs · ByBlockHashAndIndex · bloom", () => {
  const { vm, rpc } = nested();
  const block = vm.getBlock(2);
  const receipts = ask(rpc, "eth_getBlockReceipts", "0x2");
  assert.equal(receipts.length, 4);
  assert.deepEqual(receipts.flatMap((r) => r.logs.map((log) => log.logIndex)), ["0x0", "0x1"]);
  assert.deepEqual(receipts.map((r) => r.status), ["0x1", "0x1", "0x0", "0x1"]);
  assert.deepEqual(ask(rpc, "eth_getBlockReceipts", block.hash), receipts);
  assert.deepEqual(receipts[1], ask(rpc, "eth_getTransactionReceipt", block.txHashes[1]));
  assert.equal(Number(receipts[3].cumulativeGasUsed), receipts.reduce((sum, r) => sum + Number(r.gasUsed), 0));
  assert.equal(ask(rpc, "eth_getTransactionByBlockHashAndIndex", block.hash, "0x1").hash, block.txHashes[1]);
  assert.equal(ask(rpc, "eth_getTransactionByBlockHashAndIndex", block.hash, "0x9"), null);

  const transfers = ask(rpc, "eth_getLogs", { fromBlock: "0x0", toBlock: "latest", address: T, topics: [TRANSFER] });
  assert.deepEqual(transfers.map((log) => [log.blockNumber, abiWord(log.data)]), [["0x1", 1000n], ["0x1", 100n], ["0x2", 1n], ["0x2", 5n]]);
  const toBob = ask(rpc, "eth_getLogs", { fromBlock: "0x1", topics: [TRANSFER, null, `0x${BOB.slice(2).padStart(64, "0")}`] });
  assert.equal(toBob.length, 2);
  assert.equal(ask(rpc, "eth_getLogs", { blockHash: block.hash, address: [R] }).length, 0);
  const limited = createEvmRpc({ vm, logRange: 1 }).handle({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x2" }] });
  assert.equal(limited.error.code, EVM_ERROR.LIMIT);

  const header = ask(rpc, "eth_getBlockByNumber", "0x2", false);
  assert.notEqual(header.logsBloom, `0x${"0".repeat(512)}`);
  assert.equal(header.logsBloom, receipts.map((r) => r.logsBloom).reduce((a, b) =>
    `0x${[...a.slice(2)].map((c, i) => (Number.parseInt(c, 16) | Number.parseInt(b[i + 2], 16)).toString(16)).join("")}`));
});

test("evm: debug_traceTransaction / debug_traceBlockByNumber แบบ callTracer · เรียกซ้อน + transferNative + error", () => {
  const { vm, rpc } = nested();
  const [, payHash, boomHash, sendHash] = vm.getBlock(2).txHashes;
  const tracer = { tracer: "callTracer" };
  const coins = (n) => `0x${(BigInt(n) * 10n ** 18n).toString(16)}`;
  const pay = ask(rpc, "debug_traceTransaction", payHash, tracer);
  assert.deepEqual([pay.type, pay.from, pay.to, pay.value, pay.error], ["CALL", OWNER, R, coins(100), undefined]);
  assert.deepEqual(pay.calls.map((c) => [c.type, c.from, c.to, c.value]), [
    ["CALL", R, T, "0x0"], ["CALL", R, T, "0x0"], ["CALL", R, BOB, coins(7)],   // balanceOf, transfer, transferNative
  ]);
  assert.match(Buffer.from(pay.calls[1].input.slice(2), "hex").toString(), /"method":"transfer"/);
  assert.equal(ask(rpc, "debug_traceTransaction", payHash, { ...tracer, tracerConfig: { onlyTopCall: true } }).calls, undefined);

  const boom = ask(rpc, "debug_traceTransaction", boomHash, tracer);
  assert.deepEqual([boom.error, boom.output, boom.calls], ["nope", "0x", undefined]);
  const send = ask(rpc, "debug_traceTransaction", sendHash, tracer);
  assert.deepEqual([send.to, send.value, send.calls], [BOB, coins(3), undefined]);   // ค่าแก๊สไม่ถูกนับเป็น internal tx

  const deploy = ask(rpc, "debug_traceTransaction", vm.getBlock(1).txHashes[0], tracer);
  assert.deepEqual([deploy.type, deploy.to], ["CREATE", R]);
  assert.equal(Buffer.from(deploy.output.slice(2), "hex").toString(), RELAY);

  const block = ask(rpc, "debug_traceBlockByNumber", "0x2", tracer);
  assert.deepEqual(block.map((t) => t.txHash), vm.getBlock(2).txHashes);
  assert.deepEqual(block[1].result, pay);
  assert.deepEqual(ask(rpc, "debug_traceBlockByHash", vm.getBlock(2).hash, tracer), block);
  assert.equal(rpc.handle({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [payHash] }).error.code, EVM_ERROR.SERVER);
});

test("evm: genesis ใช้เวลาของ block 1 · gasLimit = maxBlockGas ของเชน · txpool จาก mempool", () => {
  const { vm } = nested({ maxBlockGas: 3_000_000 });
  const item = { hash: `0x${"cd".repeat(32)}`, sender: BOB, action: "call", nonce: 4, gasPrice: null, receivedAt: 1 };
  const mempool = { list: () => [item], has: (hash) => hash === item.hash, nextNonce: () => 5 };
  const rpc = createEvmRpc({ vm, mempool });
  const genesis = ask(rpc, "eth_getBlockByNumber", "earliest", false);
  assert.equal(genesis.timestamp, ask(rpc, "eth_getBlockByNumber", "0x1", false).timestamp);
  assert.equal(genesis.gasLimit, `0x${(3_000_000).toString(16)}`);
  assert.deepEqual(Object.keys(ask(rpc, "txpool_content").pending[BOB]), ["4"]);
  assert.equal(ask(rpc, "txpool_content").pending[BOB]["4"].hash, item.hash);
  assert.deepEqual(ask(rpc, "txpool_status"), { pending: "0x1", queued: "0x0" });
  assert.equal(ask(rpc, "eth_getTransactionCount", BOB, "pending"), "0x5");
  assert.equal(ask(rpc, "eth_getTransactionByHash", item.hash).blockNumber, null);
});
