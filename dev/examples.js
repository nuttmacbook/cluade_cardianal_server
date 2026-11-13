/**
 * Example requests to send into the system: node examples.js
 * The client signs with a private key (or MetaMask) and sends { tx, signature } to the server
 */
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js";
import * as sign from "../src/crypto/signature.js";

const CHAIN_ID = 1;
const MINER = "0x1111111111111111111111111111111111111111";

// --- user wallets (in production these live in MetaMask) ---
const ALICE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const alice = sign.addressOf(ALICE_KEY);
const bob = "0xfabb0ac9d68b0b445fb7357272ff202c5651694a";

// native has 18 decimals (wei) like ETH · tx amounts are sent as strings because they can exceed 2^53
const GWEI = 10n ** 9n;
const gwei = (amount) => `${BigInt(amount) * GWEI}`;

/** Numbers in programs are always BigInt (0n, 10n) — numeric inputs are converted to BigInt automatically */
const TOKEN_CODE = `
function program() {
  function initialization(params) {
    writeDB("owner", params.context.sender)
    writeDB(map("balances", params.context.sender), params.input.supply)
  }
  function transfer(params) {
    const from = params.context.sender
    const balance = readDB(map("balances", from)) || 0n
    if (balance < params.input.amount) throw new Error("insufficient balance")
    writeDB(map("balances", from), balance - params.input.amount)
    writeDB(map("balances", params.input.to), (readDB(map("balances", params.input.to)) || 0n) + params.input.amount)
    return true
  }
  return { transfer }
}
`;

/** Client side: build the tx and sign it */
const makeRequest = (tx, key = ALICE_KEY) => ({ tx, signature: sign.signTransaction(tx, key) });

const base = { chainId: CHAIN_ID, from: alice, to: "", method: "", input: {}, value: 0, gasLimit: 200_000, gasPrice: gwei(1) };   // 1 gwei

// ============================================================================
//  Server side
// ============================================================================

const vm = new VirtualMachine(new MemoryDB(), {
  chainId: CHAIN_ID,
  requireNonce: true,
  chargeGas: true,
  recordTransactions: true,
  recordBlocks: true,
  deriveProgramAddress: true,
  burnPercent: 50,
  gas: { price: gwei(1) },        // minimum gas price 1 gwei (same as server.js)
  maxTransactions: 500,           // cap per block
  maxTransactionsPerSender: 16,   // cap per address in 1 block
  maxBlockGas: 3_000_000,
});
vm.db.load({ [`${alice}:native:received`]: `${1_000n * 10n ** 18n}n` }); // genesis: 1,000 coins (18 decimals)

/** Receives { tx, signature } → verifies the signature → adds it to the block */
function submit(block, request) {
  const { method, request: vmRequest, sender, hash } = sign.verifyTransaction(request);
  const pre = block.checkTransaction(vmRequest);
  if (!pre.ok) return { hash, sender, rejected: pre.reason };   // dropped before running the program

  const result = block[method](vmRequest);
  return { hash, sender, status: result.status, error: result.error?.message, result: result.result };
}

// --- block 1: deploy + init ---
const deployRequest = makeRequest({ ...base, action: "deploy", code: TOKEN_CODE, input: { supply: 1000 }, nonce: 0 });
const tokenAddress = vm.programAddressFor(alice, 0); // the client can compute this in advance

let block = vm.createBlock({ timestamp: Date.now(), feeRecipient: MINER });
console.log("1. deploy   :", submit(block, deployRequest));
console.log("   init     :", block.init({ programUuid: tokenAddress }).status, "(approved by the team, no signature needed)");
block.commit();

// --- block 2: call / transfer / metadata + error cases ---
const requests = [
  makeRequest({ ...base, action: "call", to: tokenAddress, method: "transfer", input: { to: bob, amount: 300 }, nonce: 1 }),
  makeRequest({ ...base, action: "transfer", to: bob, value: gwei(5_000), nonce: 2 }),
  makeRequest({ ...base, action: "metadata", input: { namespace: "alice", icon: "👩" }, nonce: 3 }),
  makeRequest({ ...base, action: "call", to: tokenAddress, method: "transfer", input: { to: bob, amount: 999_999 }, nonce: 4 }), // insufficient balance
  makeRequest({ ...base, action: "call", to: tokenAddress, method: "transfer", input: { to: bob, amount: 1 }, nonce: 1 }),       // duplicate nonce
  makeRequest({ ...base, action: "call", to: tokenAddress, method: "transfer", input: { to: bob, amount: 1 }, nonce: 5, gasPrice: gwei(20) }), // pays more
];

block = vm.createBlock({ timestamp: Date.now() + 1, feeRecipient: MINER });
requests.forEach((request, index) => console.log(`${index + 2}. ${request.tx.action.padEnd(9)}:`, submit(block, request)));
block.commit();

// ============================================================================
//  Results
// ============================================================================

console.log("\n--- example request sent by the client ---");
console.log(JSON.stringify(requests[0], null, 2));

console.log("\n--- typed data MetaMask will show (eth_signTypedData_v4) ---");
console.log(JSON.stringify(sign.buildTypedData(requests[0].tx), null, 2));

console.log("\n--- block 2 ---");
const receipt = vm.getBlock(2);
console.log(JSON.stringify({ ...receipt, txHashes: receipt.txHashes.length }, null, 2));

console.log("\n--- state ---");
console.log("token address :", tokenAddress);
console.log("alice         :", vm.nativeBalanceOf(alice), "namespace:", vm.getMetadata(alice).namespace);
console.log("miner         :", vm.nativeBalanceOf(MINER).balance, "| burned:", vm.nativeBalanceOf(vm.constructor.BURN_ADDRESS ?? "0x0000000000000000000000000000000000000000").balance);
console.log("token balances:", vm.listProgramStorage(tokenAddress).map((e) => `${e.key.join("/")}=${e.value}`).join(", "));
