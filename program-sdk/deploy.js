/**
 * Sends a program to the chain:  node deploy.js hello-world/hello.program.js
 *
 *   PRIVATE_KEY=0x…  API=https://api.example.com  node deploy.js <program file>
 *
 * Steps: program → string → sign with EIP-712 → POST /sendtx
 * In production, sign in the browser with MetaMask (see README) · this file is for testing
 */
import { addressOf, signTransaction, hashTypedData } from "programvm/signature.js";

const API = process.env.API ?? "http://localhost:3000";
const API_KEY = process.env.API_KEY ?? "";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// chainId / gas price are read from the node's GET /genesis (or set CHAIN_ID / GAS_PRICE yourself) · wrong chainId = the node rejects it
let CHAIN_ID = process.env.CHAIN_ID === undefined ? undefined : Number(process.env.CHAIN_ID);
let GAS_PRICE = process.env.GAS_PRICE;

if (!PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY first, e.g.  PRIVATE_KEY=0x… node deploy.js hello-world/hello.program.js");
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

/** Every field is required because the signature covers every field */
const buildTx = ({ action, to = "", method = "", input = {}, code, value = 0, nonce, gasLimit = 1_500_000, gasPrice = GAS_PRICE }) =>   // pay for gas actually used · gasLimit = cap
  ({ chainId: CHAIN_ID, action, from: me, to, method, input, ...(code === undefined ? {} : { code }), value, nonce, gasLimit, gasPrice });

const send = (tx) => api("/sendtx", { tx, signature: signTransaction(tx, PRIVATE_KEY) });

async function main() {
  const file = process.argv[2] ?? "hello-world/hello.program.js";
  const program = (await import(new URL(file, import.meta.url))).default;
  const code = String(program);     // function → string (the export keyword is not included)

  console.log(`deploy ${file} (${Buffer.byteLength(code)} bytes) by ${me}`);
  const genesis = await api("/genesis");
  CHAIN_ID ??= genesis.chainId;
  GAS_PRICE ??= String(BigInt(String(genesis.baseFee ?? genesis.gasPrice).replace(/n$/, "")) * 2n);   // 2x the current base fee, in case it rises
  const { nonce } = await api(`/nonce/${me}`);

  const tx = buildTx({ action: "deploy", input: { greeting: "Hello" }, code, nonce });
  console.log("  digest:", hashTypedData(tx));
  const queued = await send(tx);
  console.log("  queued:", queued.hash, "| simulation:", queued.simulation?.status);
  console.log("  waiting for the team to approve (init), then the program will be usable");
}

main().catch((error) => {
  console.error("failed:", error.message);
  process.exit(1);
});
