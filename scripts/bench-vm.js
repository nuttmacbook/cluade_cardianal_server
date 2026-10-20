/**
 * วัดความเร็วของ VM แบบไม่ผ่าน server
 *
 *   node scripts/bench-vm.js            # 1,000 token transfer ผ่าน vm.call + โปรแกรมที่คำนวณหนัก
 *   node scripts/bench-vm.js --n 5000   # จำนวน transfer
 *
 * รายงาน: เวลาเฉลี่ยต่อ tx, แก๊สเฉลี่ยต่อ tx, จำนวน tx ที่ต้องใช้เติม block 3,000,000 gas และเวลาที่ใช้
 */
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : Number(args[i + 1]); };
const N = option("n", 1000);
const BLOCK_GAS = 3_000_000;

const vm = new VirtualMachine(new MemoryDB(), { timeoutMs: 5000 });
const owner = "0x1111111111111111111111111111111111111111";
const context = { sender: owner, origin: owner };
const commit = (res) => {
  if (res.status !== "success") throw new Error(JSON.stringify(res.error));
  vm.commit(res.writes);
  return res;
};

commit(vm.deploy({ programUuid: "token", code: TOKEN_PROGRAM, context, initInput: { name: "Bench", ticker: "BEN", decimals: "6n", supply: "1000000000000000n" } }));
commit(vm.init({ programUuid: "token" }));

const HEAVY = `function program() {
  function work(params) {
    let total = 0n
    const items = []
    for (let i = 0n; i < params.input.n; i++) {
      total = total + i * 3n
      if (i % 100n === 0n) items.push(String(i))
    }
    return [total, BigInt(items.join(",").length)]
  }
  return { work }
}`;
commit(vm.deploy({ programUuid: "heavy", code: HEAVY, context }));
commit(vm.init({ programUuid: "heavy" }));

const recipient = (i) => `0x${(i + 1).toString(16).padStart(40, "0")}`;

// อุ่นเครื่อง
for (let i = 0; i < 50; i++) commit(vm.call({ programUuid: "token", functionName: "transfer", input: { to: recipient(i), amount: "1n" }, context }));

let gas = 0;
let start = performance.now();
for (let i = 0; i < N; i++) {
  const res = commit(vm.call({ programUuid: "token", functionName: "transfer", input: { to: recipient(i % 500), amount: "1n" }, context }));
  gas += res.gasUsed;
}
let ms = performance.now() - start;
const perTx = ms / N;
const gasPerTx = gas / N;
const txPerBlock = Math.ceil(BLOCK_GAS / gasPerTx);
console.log(`token transfer × ${N}: ${ms.toFixed(0)} ms · ${perTx.toFixed(3)} ms/tx · ${gasPerTx.toFixed(0)} gas/tx`);
console.log(`  เติม block ${BLOCK_GAS.toLocaleString()} gas ด้วย transfer: ${txPerBlock} tx ≈ ${(txPerBlock * perTx).toFixed(0)} ms`);

start = performance.now();
const res = commit(vm.call({ programUuid: "heavy", functionName: "work", input: { n: "200000n" }, context }));
ms = performance.now() - start;
console.log(`heavy loop: ${res.gasUsed.toLocaleString()} gas ใน ${ms.toFixed(0)} ms · ${(res.gasUsed / ms / 1000).toFixed(2)} M gas/s`);
console.log(`  เติม block ${BLOCK_GAS.toLocaleString()} gas ด้วยงานคำนวณ ≈ ${(BLOCK_GAS / (res.gasUsed / ms)).toFixed(0)} ms`);
