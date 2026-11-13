import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { simulate } from "../src/node/simulate.js";

/*
 * simulate (at /sendtx) always simulates the next block
 * it used to pass number: null → BlockNumber() was null during simulate (but a BigInt when run in a block)
 * → programs computing with the block number (e.g. BlockHash(BlockNumber() - 1n)) were rejected at /sendtx even though they run fine in a block
 * (found while writing dev/scenario-full.js, section "API in programs")
 */

const CODE = `function program() {
  function look() {
    const n = BlockNumber()
    return { number: n, previous: BlockHash(n - 1n) }
  }
  return { look }
}`;

test("simulate: BlockNumber() = the next block and BlockHash(n - 1) = the latest block's hash (same as in a real block)", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true, recordBlocks: true, recordTransactions: true, deriveProgramAddress: false });
  const key = sign.randomPrivateKey();
  const alice = sign.addressOf(key);
  vm.db.load({ [`${alice}:native:received`]: "1000000000000000000n" });
  let clock = 1_000;
  const mine = (fn) => { const block = vm.createBlock({ timestamp: (clock += 1000) }); const result = fn(block); block.commit(); return result; };
  mine((b) => b.deploy({ programUuid: "0x00000000000000000000000000000000000000b1", code: CODE, context: { sender: alice, origin: alice }, nonce: 0 }));
  mine((b) => b.init({ programUuid: "0x00000000000000000000000000000000000000b1" }));

  const tx = { chainId: vm.chainId, action: "call", from: alice, to: "0x00000000000000000000000000000000000000b1", method: "look", input: {}, value: 0, nonce: 1, gasLimit: 500_000, gasPrice: "1" };
  const verified = sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, key) });
  const result = simulate(vm, verified);
  assert.equal(result.ok, true, result.error);
  const latest = vm.latestBlockNumber();
  assert.deepEqual(result.result, { number: `${latest + 1}n`, previous: vm.getBlock(latest).hash });

  // simulate reserves no block number / saves nothing
  assert.equal(vm.latestBlockNumber(), latest);
  assert.ok(!vm.getBlock(latest + 1));
  // the result in a real block matches what simulate reported
  const real = mine((b) => b.call(verified.request));
  assert.deepEqual([real.status, real.result], ["success", result.result]);
});
