/* explorerscan/ui/tabs/permit.js [แก้ได้ · หน้าตา]
   แท็บ Permit ของโทเคน (ERC-2612): เซ็นอนุญาตแบบ EIP-712 แล้วส่ง */

// ---------- permit tab of a token (ERC-2612): the owner signs EIP-712 typed data with eth_signTypedData_v4 ----------
//   domain { name: name(), version: "1", chainId, verifyingContract: token } · Permit(owner, spender, value, nonce, deadline)
//   deadline = unix seconds (EIP-2612) · tokens deployed before EIP-712 (JSON digest) have no eip712Digest in their code → no tab
const PERMIT_TYPE = [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }];
const hasEip712Permit = (program) => Boolean(program.token) && callableOf(program.code).includes("permit")
  && callableOf(program.code).includes("nonces") && sourceOf(program.code).includes("eip712Digest(");
let permitSigned = null;   // last signed permit { program, input, typed } — shown again after a redraw

/** typed amount in token units ("1.5") → smallest unit (bigint) */
function toUnits(text, decimals, label) {
  const d = Number(String(decimals ?? "0").replace(/n$/, "")) || 0;
  const t = String(text ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`${label} must be a number, e.g. 1.5`);
  const [whole, frac = ""] = t.split(".");
  if (frac.length > d) throw new Error(`${label}: at most ${d} decimals`);
  return BigInt(whole) * 10n ** BigInt(d) + BigInt(frac.padEnd(d, "0") || "0");
}

function permitPanel(program) {
  const token = program.token;
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const signed = permitSigned?.program === program.address ? permitSigned : null;
  return `<div class="pad form" id="permit-panel">
    ${walletRow("The owner (connected wallet) signs an EIP-2612 permit with eth_signTypedData_v4 — anyone can submit it")}
    <div class="dim">Domain: name <b>${esc(token.name)}</b> · version 1 · this chain's chainId · verifyingContract ${addr(program.address)}</div>
    <label>Spender<input id="permit-spender" placeholder="0x…" spellcheck="false" autocomplete="off"></label>
    <label>Value (${esc(token.ticker)})<input id="permit-value" inputmode="decimal" placeholder="1.5"></label>
    <label>Deadline (unix seconds)<input id="permit-deadline" inputmode="numeric" value="${soon}" oninput="permitWhen()"></label>
    <div class="dim" id="permit-when">${when(soon * 1000)}</div>
    <div class="row"><button class="btn" id="permit-sign" onclick="signPermit('${program.address}')">Sign permit</button>
      <button class="btn solid" id="permit-send" onclick="submitPermit('${program.address}')">Sign &amp; submit</button>
      <span class="dim">Submit sends permit(owner, spender, value, deadline, signature) as a transaction</span></div>
    <div class="out" id="permit-sig">${signed ? permitSigView(signed) : "Nothing signed yet"}</div>
    <div class="out" id="permit-out">Nothing sent yet</div>
  </div>`;
}

function permitWhen() {
  const seconds = Number(document.getElementById("permit-deadline")?.value);
  const box = document.getElementById("permit-when");
  if (box) box.textContent = Number.isSafeInteger(seconds) && seconds > 0 ? when(seconds * 1000) : "Deadline must be whole seconds";
}

const permitSigView = (signed) => `<div><span class="tag ok">✓ Signed</span> nonce ${esc(signed.typed.message.nonce)} · deadline ${esc(when(Number(signed.typed.message.deadline) * 1000))}</div>
  <div class="dim">Signature</div><div class="mono full" id="permit-signature">${esc(signed.input.signature)}</div>
  <details class="ix-full"><summary>permit input (submit from anywhere)</summary>${json(signed.input)}</details>
  <details class="ix-full"><summary>Typed data (eth_signTypedData_v4)</summary>${json(signed.typed)}</details>`;

/** build the typed data from the form, ask the wallet to sign it → { program, input, typed } */
async function signPermitData(program) {
  const view = await api(`/program/${program}`);
  const token = view.token;
  if (!token) throw new Error("This program is not a token");
  const spender = document.getElementById("permit-spender").value.trim();
  if (!isAddress(spender)) throw new Error("Spender must be an address 0x… (40 hex characters)");
  const value = toUnits(document.getElementById("permit-value").value, token.decimals, "Value");
  const deadline = document.getElementById("permit-deadline").value.trim();
  if (!/^\d+$/.test(deadline)) throw new Error("Deadline must be unix seconds (whole number)");
  if (!wallet) await connect(false);
  const info = await api("/genesis");
  const nonce = await api("/query", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ programUuid: program, functionName: "nonces", input: { owner: wallet } }) });
  if (nonce.status !== "success") throw new Error(errorText(nonce.error) ?? "Could not read nonces");
  const typed = {
    types: { EIP712Domain: [...DOMAIN_TYPE, { name: "verifyingContract", type: "address" }], Permit: PERMIT_TYPE },
    primaryType: "Permit",
    domain: { name: token.name, version: "1", chainId: info.chainId, verifyingContract: program },
    message: { owner: wallet, spender: spender.toLowerCase(), value: value.toString(), nonce: toBig(nonce.result).toString(), deadline },
  };
  const signature = await window.ethereum.request({ method: "eth_signTypedData_v4", params: [wallet, JSON.stringify(typed)] });
  const input = { owner: wallet, spender: spender.toLowerCase(), value: `${value}n`, deadline: `${deadline}n`, signature };
  return { program, input, typed };
}

async function signPermit(program) {
  try {
    writeOut("permit-sig", esc("Waiting for the wallet signature…"));
    permitSigned = await signPermitData(program);
    writeOut("permit-sig", permitSigView(permitSigned));
  } catch (error) { writeOut("permit-sig", esc(`Error: ${error.message}`)); }
}

/** sign (fresh, so the nonce is current) and send permit(...) as a transaction from the connected wallet */
async function submitPermit(program) {
  try {
    writeOut("permit-sig", esc("Waiting for the wallet signature…"));
    permitSigned = await signPermitData(program);
    writeOut("permit-sig", permitSigView(permitSigned));
  } catch (error) { return writeOut("permit-sig", esc(`Error: ${error.message}`)); }
  const done = await signedAction("permit-out", "Permit", { action: "call", to: program, method: "permit", input: permitSigned.input });
  if (!done) return;
  const allowance = await api("/query", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ programUuid: program, functionName: "allowance", input: { owner: permitSigned.input.owner, spender: permitSigned.input.spender } }) });
  const box = document.getElementById("permit-out");
  if (box) box.insertAdjacentHTML("beforeend", `<div id="permit-allowance">Allowance now <b class="mono">${esc(toBig(allowance.result).toString())}</b> (smallest unit)</div>`);
}
