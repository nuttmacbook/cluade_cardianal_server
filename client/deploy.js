/**
 * ตัวอย่าง client: ส่งโค้ดไป deploy แล้วรอให้ถูกอนุมัติ
 *   node client/deploy.js
 *
 * ขั้นตอน: อ่านไฟล์ → ประกอบ tx → เซ็น → POST /sendtx → POST /mine → ส่ง init → /mine
 */
import { addressOf, signTransaction, hashTypedData } from "../src/crypto/signature.js";
import program from "./token.program.js";

const API = process.env.API ?? "http://localhost:3000";
const API_KEY = process.env.API_KEY ?? "dev-key";
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 1);

const me = addressOf(PRIVATE_KEY);

async function api(endpoint, body) {
  const response = await fetch(`${API}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-api-key": API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${endpoint} → ${response.status} ${JSON.stringify(data)}`);
  return data;
}

/** ประกอบ tx ให้ครบทุกฟิลด์ (ฟิลด์ที่ไม่ใช้ให้เป็นค่าว่าง ห้ามตัดทิ้ง เพราะลายเซ็นผูกกับทุกฟิลด์) */
function buildTx({ action, to = "", method = "", input = {}, code, value = 0, nonce, gasLimit = 200_000, gasPrice = 1 }) {
  return { chainId: CHAIN_ID, action, from: me, to, method, input, ...(code === undefined ? {} : { code }), value, nonce, gasLimit, gasPrice };
}

/** เซ็นแล้วส่ง — ส่ง signature ไป ไม่ส่ง private key */
async function send(tx) {
  const signature = signTransaction(tx, PRIVATE_KEY);
  console.log(`  → ${tx.action} nonce ${tx.nonce}  digest ${hashTypedData(tx).slice(0, 12)}…`);
  return api("/sendtx", { tx, signature });
}

async function main() {
  const code = String(program);   // ฟังก์ชัน → string ส่งผ่าน API ได้เลย
  console.log(`deploy (${Buffer.byteLength(code)} ไบต์) โดย ${me}`);

  // 1) หา nonce ปัจจุบัน แล้วส่ง deploy
  const { nonce } = await api("/nonce/" + me);          // { nonce: 0 }  ← ฝั่ง server: vm.checkTransaction
  const deployTx = buildTx({ action: "deploy", input: { supply: 1000 }, code, nonce });
  const queued = await send(deployTx);
  console.log("  queued:", queued.queued, "| ประเมินผล:", queued.simulation?.status);

  // 2) ปิด block
  const block = await api("/mine", { feeRecipient: me });
  const receipt = block.transactions.find((entry) => entry.hash === queued.hash || entry.digest === queued.hash);
  const programAddress = receipt?.result?.programUuid;
  console.log(`  block ${block.number}: ${receipt?.status} → โปรแกรมอยู่ที่ ${programAddress}`);

  // 3) ทีมงานอนุมัติ (ใช้ key ของ admin จริง ๆ ในระบบ production)
  const initTx = buildTx({ action: "init", to: programAddress, nonce: nonce + 1 });
  await send(initTx);
  const approved = await api("/mine", { feeRecipient: me });
  console.log(`  block ${approved.number}: init → ${approved.transactions.at(-1).status}`);

  // 4) เรียกใช้งานได้แล้ว
  const callTx = buildTx({
    action: "call", to: programAddress, method: "transfer",
    input: { to: "0xfabb0ac9d68b0b445fb7357272ff202c5651694a", amount: 30 }, nonce: nonce + 2,
  });
  await send(callTx);
  const used = await api("/mine", { feeRecipient: me });
  console.log(`  block ${used.number}: transfer → ${used.transactions.at(-1).status}`);
}

main().catch((error) => {
  console.error("ล้มเหลว:", error.message);
  process.exit(1);
});
