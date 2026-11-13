import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import * as sign from "../src/crypto/signature.js";

/*
 * 1 s blocks · 1M gas: less gas per block → txs that don't fit in the block's remaining gas happen more often
 *   a tx that doesn't fit the remaining gas but fits an empty block → waits for the next block (previously rejected → the same sender's next-nonce tx got stuck until it expired)
 *   a tx larger than an empty block → still rejected as before (test 60)
 *   server: no tx can enter a block (nonce gap) + minimum base fee → no empty block every second · /health does not count it as stalled
 */

const T = Date.parse("2026-02-01T00:00:00Z");
const KEYS = [sign.randomPrivateKey(), sign.randomPrivateKey(), sign.randomPrivateKey()];
const [alice, bob, carol] = KEYS.map((key) => sign.addressOf(key));
const OPTIONS = { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true };

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, ...options });
  vm.commit([alice, bob, carol].map((address) => ({ type: "put", dbKey: `${address}:native:received`, value: "1000000000000n" })));
  return vm;
}
// every tx sends native to a fresh address → same gas for every tx
const callTx = (from, nonce) =>
  ({ chainId: 1, action: "transfer", from, to: `0x${"c".repeat(38)}${nonce}${[alice, bob, carol].indexOf(from)}`, value: 1, nonce, gasLimit: 0, gasPrice: 10 });   // price leaves room for the base fee rising after full blocks
const signed = (tx) => ({ tx, signature: sign.signTransaction(tx, KEYS[[alice, bob, carol].indexOf(tx.from)]) });
let clock = T;
const mine = (vm, pool) => {
  clock += 1000;
  const block = vm.createBlock({ timestamp: clock, feeRecipient: "miner" });
  const included = pool.take(block);
  block.commit();
  return { header: vm.getBlock(block.number), included };
};

test("not enough gas left in the block → that tx waits for the next block (not rejected) · the same sender's next-nonce tx follows in order", () => {
  const probe = setup();
  const probePool = new Mempool(probe, { ttlMs: 60_000 });
  probePool.add(signed(callTx(alice, 0)), { now: clock });
  const gas = mine(probe, probePool).header.gasUsed;   // gas of one transfer
  assert.ok(gas > 0);
  const vm = setup({ maxBlockGas: Math.floor(gas * 2.5) });   // fits 2 txs per block
  const pool = new Mempool(vm, { ttlMs: 60_000 });
  const added = [callTx(alice, 0), callTx(bob, 0), callTx(carol, 0), callTx(carol, 1)].map((tx) => pool.add(signed(tx), { now: clock }));
  assert.ok(added.every((item) => item.ok), JSON.stringify(added));

  const first = mine(vm, pool);
  assert.equal(first.header.txCount, 2);
  assert.equal(vm.getBlockRejected(first.header.number).length, 0);   // no tx rejected
  assert.equal(pool.size, 2);
  const second = mine(vm, pool);
  assert.equal(second.header.txCount, 2);
  assert.equal(pool.size, 0);
  const statuses = added.map((item) => vm.getTransaction(item.hash)?.status);
  assert.deepEqual(statuses, ["success", "success", "success", "success"]);
  // carol's nonce 1 tx lands after nonce 0 (same or next block · queue order depends on the random addresses)
  const blockOf = (item) => vm.getTransaction(item.hash).blockNumber;
  assert.ok(blockOf(added[3]) >= blockOf(added[2]));
});

test("server: a tx stuck on a nonce gap → no empty blocks · /health does not report stalled ", async () => {
  process.env.GAS_PRICE ??= "1000000000";   // this test uses the dev gas price of 1 gwei (the chain default of 10,000 gwei is tested in 107)
  process.env.MAX_BLOCK_GAS ??= "1000000";   // numbers in this test assume 1M blocks (chain default 5M)
  const { vm, miner, mempool, mineOnce, health, minerState, STALL_MS, server } = await import("../server.js");
  clearInterval(miner);
  try {
    assert.equal(vm.maxBlockGas, 1_000_000);
    const key = sign.randomPrivateKey();
    const from = sign.addressOf(key);
    vm.db.load({ [`${from}:native:received`]: "1000000000000000000n" });
    const tx = (nonce, value = "1n") => ({ chainId: vm.chainId, action: "transfer", from, to: "0x00000000000000000000000000000000000000b0", value, nonce, gasLimit: 21_000, gasPrice: "1000000000" });
    // the nonce 0 tx drops out of the queue (as used to happen when block gas was full) → the nonce 1 tx waits for the missing one
    const first = mempool.add({ tx: tx(0), signature: sign.signTransaction(tx(0), key) });
    assert.equal(first.ok, true);
    assert.equal(mempool.add({ tx: tx(1), signature: sign.signTransaction(tx(1), key) }).ok, true);
    mempool.remove([first.hash]);
    assert.equal(mempool.size, 1);

    const later = Date.now() + STALL_MS + 1000;
    for (let i = 0; i < 5; i += 1) assert.equal(mineOnce(later + i * 1000), null);   // 5 rounds, no empty block
    assert.equal(vm.latestBlockNumber(), null);
    assert.equal(minerState.idleAt, later + 4000);
    assert.deepEqual(health(later + 4500).problems, []);
    assert.match(health(later + 60_000).problems.join(), /^stalled/);   // miner absent for a long time = really stalled

  } finally {
    server.close();
  }
});
