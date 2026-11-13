/**
 * Playground: run with  node demo.js
 * Edit the code in this file freely · shows which keys and values are in the DB after each step
 */
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js"; // in production use new DB("./data") instead

const vm = new VirtualMachine(new MemoryDB(), {
  requireNonce: true,
  chargeGas: true,
  recordTransactions: true,
  recordBlocks: true,
  gas: { call: 100, read: 10, write: 50, byte: 1, price: 1 },
  burnPercent: 50,
});

const alice = { sender: "alice", origin: "alice" };
/** Numbers in programs are always BigInt (0n) — stored in the DB as "123n" */
const TOKEN = `
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

// fund alice to pay for gas
vm.db.load({ "alice:native:received": 1_000_000 });

// ---------- 1. deploy + init ----------
const deployed = vm.deploy({ programUuid: "token", code: TOKEN, context: alice, initInput: { supply: 1000 }, nonce: 0 });
console.log("deploy:", deployed.status, deployed.writes.map((w) => w.dbKey));
vm.commit(deployed.writes);
vm.commit(vm.init({ programUuid: "token" }).writes);

console.log("\n=== after init ===");
vm.db.print("", { grouped: true });

// ---------- 2. a block with several txs ----------
const block = vm.createBlock({ timestamp: Date.parse("2024-06-01T10:00:00Z"), feeRecipient: "miner" }); // the VM chains blocks for you
block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 300 }, context: alice, nonce: 1 });
block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: alice, nonce: 2 }); // fails
block.transfer({ from: "alice", to: "carol", amount: 500, nonce: 3 });

console.log("\n=== writes to be recorded (not committed yet) ===");
console.log(JSON.stringify(block.writes(), null, 2));

console.log("\n=== block header ===");
console.log(JSON.stringify(block.header(), null, 2));

console.log("\n=== block receipt ===");
const receipt = block.receipt({ number: 1 });
console.log(JSON.stringify({ ...receipt, transactions: receipt.transactions.map((t) => `${t.index} ${t.hash.slice(0, 10)}… ${t.from}→${t.to}.${t.method} ${t.status}`) }, null, 2));

block.commit();

// ---------- 3. inspect the DB after commit ----------
console.log("\n=== whole DB (grouped) ===");
vm.db.print("", { grouped: true });

console.log("\n=== token storage only ===");
console.log(vm.db.dump({ prefix: "token:storage:" }));

console.log("\n=== alice's txs ===");
console.log(vm.db.dump({ prefix: "alice:txn:" }));

console.log("\nnative balances:", { alice: vm.nativeBalanceOf("alice"), miner: vm.nativeBalanceOf("miner") });
console.log("total keys:", vm.db.size);
