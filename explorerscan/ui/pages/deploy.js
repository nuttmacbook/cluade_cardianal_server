/* explorerscan/ui/pages/deploy.js [แก้ได้ · หน้าตา]
   หน้า deploy โปรแกรมใหม่ (#deploy): ช่องโค้ด + input + upgrader แล้วเซ็นส่ง */

// ---------- deploy a program (signed by the wallet, then waits for review) ----------
let deployDraft = { code: "function program() {\n  function initialization(params) {}\n  function ping(params) { return 1n; }\n  return { ping };\n}", input: "{}", value: "0", upgrader: "" };

function deployPage(draw = el) {
  const d = deployDraft;
  draw(panel("Deploy a program", `<div class="pad form" id="deploy-form">
    ${walletRow("Deploying sends a signed transaction · the program runs after an admin approves it")}
    <label>Code<textarea id="dp-code" rows="12" spellcheck="false">${esc(d.code)}</textarea></label>
    <label>Init input (JSON, passed to initialization)<textarea id="dp-input" rows="2" spellcheck="false">${esc(d.input)}</textarea></label>
    <label>Attached value (coins)<input id="dp-value" value="${attr(d.value)}" inputmode="decimal"></label>
    <label>Upgrader (optional · empty = the code can never change)<input id="dp-upgrader" value="${attr(d.upgrader)}" placeholder="0x…" spellcheck="false" autocomplete="off"></label>
    <div class="row"><button class="btn" onclick="useMyWallet()">Use my wallet as upgrader</button>
      <button class="btn solid" id="dp-send" onclick="sendDeploy()">Deploy (send transaction)</button></div>
    <div class="out" id="dp-out">Not sent yet</div>
  </div>`));
}

function saveDeployDraft() {
  for (const field of ["code", "input", "value", "upgrader"]) {
    const input = document.getElementById(`dp-${field}`);
    if (input) deployDraft[field] = input.value;
  }
}

async function useMyWallet() {
  saveDeployDraft();
  try { if (!wallet) await connect(false); } catch (error) { return writeOut("dp-out", esc(error.message)); }
  deployDraft.upgrader = wallet;
  document.getElementById("dp-upgrader").value = wallet;
}

async function sendDeploy() {
  saveDeployDraft();
  let fields;
  try {
    const { code, upgrader } = deployDraft;
    if (!code.trim()) throw new Error("Enter the program code");
    if (upgrader.trim() && !isAddress(upgrader.trim())) throw new Error("Upgrader must be an address 0x… (40 hex characters) or empty");
    fields = { action: "deploy", code, input: jsonInput("dp-input", "Init input"), value: toWei(deployDraft.value),
      ...(upgrader.trim() ? { upgrader: upgrader.trim().toLowerCase() } : {}) };
  } catch (error) { return writeOut("dp-out", esc(error.message)); }
  const receipt = await signedAction("dp-out", "Deploy", fields);
  const program = receipt?.result?.programUuid;
  if (program) writeOut("dp-out", `<span class="tag ok">✓ Deployed</span> ${addr(program, program)} <span class="dim">awaiting approval</span>${txLinkBtn(receipt.hash)}`);
  decorate();
}
