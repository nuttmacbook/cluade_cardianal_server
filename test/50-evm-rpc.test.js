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
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 7777, bigintValues: true, recordBlocks: true, recordTransactions: true, recordHistory: true,
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
  return { vm, rpc: createEvmRpc({ vm }) };
}
const ask = (rpc, method, ...params) => {
  const reply = rpc.handle({ jsonrpc: "2.0", id: 1, method, params });
  assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
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
  assert.equal(ask(rpc, "eth_getCode", T, "latest"), "0xfe");
  assert.equal(ask(rpc, "eth_getCode", BOB, "latest"), "0x");
  const other = rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: T, data: "0xa9059cbb" }] });
  assert.equal(other.error.code, EVM_ERROR.SERVER);
  assert.equal(vm.nativeBalanceOf(BOB).balance, 500);   // อ่านอย่างเดียว ไม่มีอะไรเปลี่ยน
});

test("evm: ส่ง tx จากกระเป๋า EVM ไม่ได้ (error ชัดเจน) · method ที่ไม่รองรับ / batch / params ผิด", () => {
  const { rpc } = chain();
  const send = rpc.handle({ jsonrpc: "2.0", id: 9, method: "eth_sendRawTransaction", params: ["0x02f8"] });
  assert.equal(send.id, 9);
  assert.equal(send.error.code, EVM_ERROR.SERVER);
  assert.match(send.error.message, /EIP-712/);
  assert.equal(rpc.handle({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [] }).error.code, EVM_ERROR.METHOD);
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
