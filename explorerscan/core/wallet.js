/* explorerscan/core/wallet.js [ระบบ · ไม่ต้องแก้]
   กระเป๋า + ลายเซ็น: ต่อ MetaMask, เพิ่มเชนเข้า MetaMask, เซ็น tx แบบ EIP-712 แล้วส่ง /sendtx
   ⚠️ canonical() / signingInput() ต้องตรงกับ VM ทุกไบต์ (เทสต์ 46 คุม) แก้ผิด = ลายเซ็นจากหน้าเว็บใช้ไม่ได้ทั้งหมด */

// ---------- wallet ----------
const DOMAIN_TYPE = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }];
const TX_TYPE = [
  { name: "action", type: "string" }, { name: "from", type: "address" }, { name: "to", type: "string" },
  { name: "method", type: "string" }, { name: "input", type: "string" }, { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "gasLimit", type: "uint256" }, { name: "gasPrice", type: "uint256" },
];
// EIP-1559: same fields without gasPrice, plus maxFeePerGas / maxPriorityFeePerGas (TRANSACTION_TYPE_1559 in signature.js)
const TX_TYPE_1559 = [...TX_TYPE.filter((f) => f.name !== "gasPrice"),
  { name: "maxFeePerGas", type: "uint256" }, { name: "maxPriorityFeePerGas", type: "uint256" }];
let wallet = null;

/** canonical JSON, same as the VM (sorted keys, bigint as "123n") */
function canonical(value) {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** signed input + code — must match buildTypedData() in signature.js (0x… hex strings lower-cased, values and keys) */
function signingInput(tx) {
  const lower = (v) => (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? v.toLowerCase() : v);
  const deep = (v) => (Array.isArray(v) ? v.map(deep)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [lower(k), deep(x)])) : lower(v));
  // deploy with an upgrader: upgrader joins input + code (no upgrader = left out, so the signed text is unchanged)
  return canonical({ input: deep(tx.input ?? {}), code: tx.code ?? null, ...(tx.upgrader ? { upgrader: String(tx.upgrader).toLowerCase() } : {}) });
}

/** rerender = false while sending a tx — redrawing would remove the result box (#out) */
async function connect(rerender = true) {
  if (!window.ethereum) throw new Error("No wallet found — install MetaMask first");
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  wallet = account.toLowerCase();
  document.getElementById("wbtn").textContent = cut(wallet);
  if (rerender) render(true);
}

/** add this chain to the wallet (MetaMask): chainId / name / symbol / rpcUrls / explorer come from GET /evm of the node */
async function addNetwork() {
  if (!window.ethereum) throw new Error("No wallet found — install MetaMask first");
  await window.ethereum.request({ method: "wallet_addEthereumChain", params: [await api("/evm")] });
}

/** sign and send to the chain — returns the /sendtx response */
async function sendTx(fields) {
  if (!wallet) await connect(false);
  const info = await api("/genesis");
  const { nonce } = await api(`/nonce/${wallet}`);
  // EIP-1559: pay at most 2 × the next base fee (room for it to rise while waiting) · no tip — the price is base fee only
  const baseFee = toBig(info.baseFee ?? info.gasPrice ?? 1);
  const tx = { chainId: info.chainId, action: "call", from: wallet, to: "", method: "", input: {},
    value: "0", nonce, gasLimit: 500000,
    ...(fields.gasPrice === undefined ? { maxFeePerGas: String(baseFee * 2n), maxPriorityFeePerGas: "0" } : {}), ...fields };   // wei per gas

  const legacy = tx.maxFeePerGas === undefined;   // a caller passing gasPrice signs the legacy type
  const message = { action: tx.action, from: tx.from, to: tx.to, method: tx.method,
    input: signingInput(tx),
    value: tx.value, nonce: tx.nonce, gasLimit: tx.gasLimit,
    ...(legacy ? { gasPrice: tx.gasPrice } : { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }) };

  const signature = await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [wallet, JSON.stringify({ domain: { name: "ProgramVM", version: "1", chainId: tx.chainId },
      types: { EIP712Domain: DOMAIN_TYPE, Transaction: legacy ? TX_TYPE : TX_TYPE_1559 }, primaryType: "Transaction", message })],
  });

  return api("/sendtx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx, signature }) });
}
