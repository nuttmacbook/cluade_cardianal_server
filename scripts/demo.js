/**
 * สนามทดลอง: รันด้วย  node demo.js
 * แก้โค้ดในไฟล์นี้ได้ตามใจ ใช้ดูว่า DB มีคีย์อะไร ค่าอะไร หลังแต่ละขั้น
 */
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js"; // ของจริงใช้ new DB("./data") แทน

const vm = new VirtualMachine(new MemoryDB(), {
  requireNonce: true,
  chargeGas: true,
  recordTransactions: true,
  recordBlocks: true,
  gas: { call: 100, read: 10, write: 50, byte: 1, price: 1 },
  burnPercent: 50,
});

const alice = { sender: "alice", origin: "alice" };
const TOKEN = `
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

// เติมเงินให้ alice ไว้จ่ายค่าแก๊ส
vm.db.load({ "alice:native:received": 1_000_000 });

// ---------- 1. deploy + init ----------
const deployed = vm.deploy({ programUuid: "token", code: TOKEN, context: alice, initInput: { supply: 1000 }, nonce: 0 });
console.log("deploy:", deployed.status, deployed.writes.map((w) => w.dbKey));
vm.commit(deployed.writes);
vm.commit(vm.init({ programUuid: "token" }).writes);

console.log("\n=== หลัง init ===");
vm.db.print("", { grouped: true });

// ---------- 2. block ที่มีหลาย tx ----------
const block = vm.createBlock({ timestamp: Date.parse("2024-06-01T10:00:00Z"), feeRecipient: "miner" }); // VM ต่อ block ให้เอง
block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 300 }, context: alice, nonce: 1 });
block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: alice, nonce: 2 }); // ล้ม
block.transfer({ from: "alice", to: "carol", amount: 500, nonce: 3 });

console.log("\n=== writes ที่จะบันทึก (ยังไม่ commit) ===");
console.log(JSON.stringify(block.writes(), null, 2));

console.log("\n=== header ของ block ===");
console.log(JSON.stringify(block.header(), null, 2));

console.log("\n=== receipt ของ block ===");
const receipt = block.receipt({ number: 1 });
console.log(JSON.stringify({ ...receipt, transactions: receipt.transactions.map((t) => `${t.index} ${t.hash.slice(0, 10)}… ${t.from}→${t.to}.${t.method} ${t.status}`) }, null, 2));

block.commit();

// ---------- 3. ดู DB หลัง commit ----------
console.log("\n=== DB ทั้งหมด (จัดกลุ่ม) ===");
vm.db.print("", { grouped: true });

console.log("\n=== เฉพาะ storage ของ token ===");
console.log(vm.db.dump({ prefix: "token:storage:" }));

console.log("\n=== รายการ tx ของ alice ===");
console.log(vm.db.dump({ prefix: "alice:txn:" }));

console.log("\nยอด native:", { alice: vm.nativeBalanceOf("alice"), miner: vm.nativeBalanceOf("miner") });
console.log("จำนวน key ทั้งหมด:", vm.db.size);
