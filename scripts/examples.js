/**
 * ตัวอย่าง request สำหรับยิงเข้าระบบ: node examples.js
 * ฝั่ง client เซ็นด้วย private key (หรือ MetaMask) แล้วส่ง { tx, signature } มาที่ server
 */
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js";
import * as sign from "../src/crypto/signature.js";

const CHAIN_ID = 1;
const MINER = "0x1111111111111111111111111111111111111111";

// --- wallet ของ user (ของจริงอยู่ใน MetaMask) ---
const ALICE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const alice = sign.addressOf(ALICE_KEY);
const bob = "0xfabb0ac9d68b0b445fb7357272ff202c5651694a";

const TOKEN_CODE = `
function program() {
  function initialization(params) {
    writeDB("owner", params.context.sender)
    writeDB(map("balances", params.context.sender), params.input.supply)
  }
  function transfer(params) {
    const from = params.context.sender
    const balance = readDB(map("balances", from)) || 0
    if (balance < params.input.amount) throw new Error("ยอดไม่พอ")
    writeDB(map("balances", from), balance - params.input.amount)
    writeDB(map("balances", params.input.to), (readDB(map("balances", params.input.to)) || 0) + params.input.amount)
    return true
  }
  return { transfer }
}
`;

/** ฝั่ง client: ประกอบ tx แล้วเซ็น */
const makeRequest = (tx, key = ALICE_KEY) => ({ tx, signature: sign.signTransaction(tx, key) });

const base = { chainId: CHAIN_ID, from: alice, to: "", method: "", input: {}, value: 0, gasLimit: 200_000, gasPrice: 1 };

// ============================================================================
//  ฝั่ง server
// ============================================================================

const vm = new VirtualMachine(new MemoryDB(), {
  chainId: CHAIN_ID,
  requireNonce: true,
  chargeGas: true,
  recordTransactions: true,
  recordBlocks: true,
  deriveProgramAddress: true,
  burnPercent: 50,
  maxTransactions: 500,           // เพดานต่อ block
  maxTransactionsPerSender: 16,   // เพดานต่อ address ใน 1 block
  maxBlockGas: 3_000_000,
});
vm.db.load({ [`${alice}:native:received`]: 1_000_000 }); // genesis

/** รับ { tx, signature } → ตรวจลายเซ็น → ใส่เข้า block */
function submit(block, request) {
  const { method, request: vmRequest, sender, hash } = sign.verifyTransaction(request);
  const pre = block.checkTransaction(vmRequest);
  if (!pre.ok) return { hash, sender, rejected: pre.reason };   // ทิ้งตั้งแต่ยังไม่รันโปรแกรม

  const result = block[method](vmRequest);
  return { hash, sender, status: result.status, error: result.error?.message, result: result.result };
}

// --- block 1: deploy + init ---
const deployRequest = makeRequest({ ...base, action: "deploy", code: TOKEN_CODE, input: { supply: 1000 }, nonce: 0 });
const tokenAddress = vm.programAddressFor(alice, 0); // client คำนวณล่วงหน้าได้

let block = vm.createBlock({ timestamp: Date.now(), feeRecipient: MINER });
console.log("1. deploy   :", submit(block, deployRequest));
console.log("   init     :", block.init({ programUuid: tokenAddress }).status, "(ทีมงานอนุมัติ ไม่ต้องเซ็น)");
block.commit();

// --- block 2: call / transfer / metadata + กรณีผิดพลาด ---
const requests = [
  makeRequest({ ...base, action: "call", to: tokenAddress, method: "transfer", input: { to: bob, amount: 300 }, nonce: 1 }),
  makeRequest({ ...base, action: "transfer", to: bob, value: 5_000, nonce: 2 }),
  makeRequest({ ...base, action: "metadata", input: { namespace: "alice", icon: "👩" }, nonce: 3 }),
  makeRequest({ ...base, action: "call", to: tokenAddress, method: "transfer", input: { to: bob, amount: 999_999 }, nonce: 4 }), // ยอดไม่พอ
  makeRequest({ ...base, action: "call", to: tokenAddress, method: "transfer", input: { to: bob, amount: 1 }, nonce: 1 }),       // nonce ซ้ำ
  makeRequest({ ...base, action: "call", to: tokenAddress, method: "transfer", input: { to: bob, amount: 1 }, nonce: 5, gasPrice: 20 }), // จ่ายแพงกว่า
];

block = vm.createBlock({ timestamp: Date.now() + 1, feeRecipient: MINER });
requests.forEach((request, index) => console.log(`${index + 2}. ${request.tx.action.padEnd(9)}:`, submit(block, request)));
block.commit();

// ============================================================================
//  ผลลัพธ์
// ============================================================================

console.log("\n--- ตัวอย่าง request ที่ client ส่งมา ---");
console.log(JSON.stringify(requests[0], null, 2));

console.log("\n--- typed data ที่ MetaMask จะแสดง (eth_signTypedData_v4) ---");
console.log(JSON.stringify(sign.buildTypedData(requests[0].tx), null, 2));

console.log("\n--- block 2 ---");
const receipt = vm.getBlock(2);
console.log(JSON.stringify({ ...receipt, txHashes: receipt.txHashes.length }, null, 2));

console.log("\n--- สถานะ ---");
console.log("token address :", tokenAddress);
console.log("alice         :", vm.nativeBalanceOf(alice), "namespace:", vm.getMetadata(alice).namespace);
console.log("miner         :", vm.nativeBalanceOf(MINER).balance, "| เผา:", vm.nativeBalanceOf(vm.constructor.BURN_ADDRESS ?? "0x0000000000000000000000000000000000000000").balance);
console.log("token balances:", vm.listProgramStorage(tokenAddress).map((e) => `${e.key.join("/")}=${e.value}`).join(", "));
