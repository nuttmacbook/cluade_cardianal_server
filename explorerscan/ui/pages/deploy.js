/* explorerscan/ui/pages/deploy.js [editable · look]
   Deploy new program page (#deploy): code box + input + upgrader, then sign and send */

// ---------- deploy a program (signed by the wallet, then waits for review) ----------
let deployDraft = { code: "function program() {\n  function initialization(params) {}\n  function ping(params) { return 1n; }\n  return { ping };\n}", input: "{}", value: "0", upgrader: "", gasLimit: "" };

function deployPage(draw = el) {
  const d = deployDraft;
  draw(panel("Deploy a program", `<div class="pad form" id="deploy-form">
    ${walletRow("Deploying sends a signed transaction · the program runs after an admin approves it")}
    <label>Code<textarea id="dp-code" rows="12" spellcheck="false">${esc(d.code)}</textarea></label>
    <label>Init input (JSON, passed to initialization)<textarea id="dp-input" rows="2" spellcheck="false">${esc(d.input)}</textarea></label>
    <label>Attached value (coins)<input id="dp-value" value="${attr(d.value)}" inputmode="decimal"></label>
    <label>Gas limit (optional · empty = automatic, up to the per-transaction cap · only the gas used is charged)<input id="dp-gasLimit" value="${attr(d.gasLimit)}" inputmode="numeric" placeholder="automatic" spellcheck="false" autocomplete="off"></label>
    <label>Upgrader (optional · empty = the code can never change)<input id="dp-upgrader" value="${attr(d.upgrader)}" placeholder="0x…" spellcheck="false" autocomplete="off"></label>
    <div class="row"><button class="btn" onclick="useMyWallet()">Use my wallet as upgrader</button>
      <button class="btn solid" id="dp-send" onclick="sendDeploy()">Deploy (send transaction)</button></div>
    <div class="out" id="dp-out">Not sent yet</div>
  </div>`));
}

function saveDeployDraft() {
  for (const field of ["code", "input", "value", "upgrader", "gasLimit"]) {
    const input = document.getElementById(`dp-${field}`);
    if (input) deployDraft[field] = input.value;
  }
}

async function useMyWallet() {
  saveDeployDraft();
  try { await ensureWallet(); } catch (error) { return writeOut("dp-out", esc(error.message)); }
  deployDraft.upgrader = wallet;
  document.getElementById("dp-upgrader").value = wallet;
}

async function sendDeploy() {
  saveDeployDraft();
  let fields;
  try {
    const { code, upgrader } = deployDraft;
    if (!code.trim()) throw new Error("Enter the program code");
    const gasLimit = deployDraft.gasLimit.replace(/[\s,_]/g, "");
    if (gasLimit && !/^[1-9]\d{0,8}$/.test(gasLimit)) throw new Error("Gas limit must be a whole number (e.g. 1500000) or empty for automatic");
    if (upgrader.trim() && !isAddress(upgrader.trim())) throw new Error("Upgrader must be an address 0x… (40 hex characters) or empty");
    fields = { action: "deploy", code, input: jsonInput("dp-input", "Init input"), value: toWei(deployDraft.value),
      ...(gasLimit ? { gasLimit: Number(gasLimit) } : {}),
      ...(upgrader.trim() ? { upgrader: upgrader.trim().toLowerCase() } : {}) };
  } catch (error) { return writeOut("dp-out", esc(error.message)); }
  const receipt = await signedAction("dp-out", "Deploy", fields);
  const program = receipt?.result?.programUuid;
  if (program) writeOut("dp-out", `<span class="tag ok">✓ Deployed</span> ${addr(program, program)} <span class="dim">awaiting approval</span>${txLinkBtn(receipt.hash)}`);
  decorate();
}
