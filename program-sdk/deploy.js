/**
 * ส่งโปรแกรมขึ้น chain:  node deploy.js hello-world/hello.program.js
 *
 *   PRIVATE_KEY=0x…  API=https://api.example.com  node deploy.js <ไฟล์โปรแกรม>
 *
 * ขั้นตอน: โปรแกรม → string → เซ็นด้วย EIP-712 → POST /sendtx
 * ของจริงควรเซ็นในเบราว์เซอร์ด้วย MetaMask (ดู README) ไฟล์นี้ไว้ใช้ตอนทดสอบ
 */
import { addressOf, signTransaction, hashTypedData } from "programvm/signature.js";

const API = process.env.API ?? "http://localhost:3000";
const API_KEY = process.env.API_KEY ?? "";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 1);

if (!PRIVATE_KEY) {
  console.error("ต้องตั้ง PRIVATE_KEY ก่อน เช่น  PRIVATE_KEY=0x… node deploy.js hello-world/hello.program.js");
  process.exit(1);
}
const me = addressOf(PRIVATE_KEY);

async function api(endpoint, body) {
  const response = await fetch(`${API}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(API_KEY && { "x-api-key": API_KEY }) },
    body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${endpoint} → ${response.status} ${JSON.stringify(data)}`);
  return data;
}

/** ทุกฟิลด์ต้องมีครบ เพราะลายเซ็นผูกกับทุกฟิลด์ */
const buildTx = ({ action, to = "", method = "", input = {}, code, value = 0, nonce, gasLimit = 200_000, gasPrice = 1 }) =>
  ({ chainId: CHAIN_ID, action, from: me, to, method, input, ...(code === undefined ? {} : { code }), value, nonce, gasLimit, gasPrice });

const send = (tx) => api("/sendtx", { tx, signature: signTransaction(tx, PRIVATE_KEY) });

async function main() {
  const file = process.argv[2] ?? "hello-world/hello.program.js";
  const program = (await import(new URL(file, import.meta.url))).default;
  const code = String(program);     // ฟังก์ชัน → string (คำว่า export ไม่ติดไปด้วย)

  console.log(`deploy ${file} (${Buffer.byteLength(code)} ไบต์) โดย ${me}`);
  const { nonce } = await api(`/nonce/${me}`);

  const tx = buildTx({ action: "deploy", input: { greeting: "สวัสดี" }, code, nonce });
  console.log("  digest:", hashTypedData(tx));
  const queued = await send(tx);
  console.log("  เข้าคิวแล้ว:", queued.hash, "| ประเมินผล:", queued.simulation?.status);
  console.log("  รอให้ทีมงานอนุมัติ (init) แล้วโปรแกรมจะใช้งานได้");
}

main().catch((error) => {
  console.error("ล้มเหลว:", error.message);
  process.exit(1);
});
