/* explorerscan/ui/tabs/upgrade.js [แก้ได้ · หน้าตา]
   แท็บ Upgrade: ส่งโค้ดใหม่ (upgrader), โอน / สละสิทธิ์อัปเกรด, admin อนุมัติ / ปฏิเสธ */

// ---------- upgrade tab of a program: new code (upgrader) · upgrade rights · admin review ----------
const sourceOf = (code) => { try { return JSON.parse(`"${code}"`); } catch { return String(code ?? ""); } };
let renounceArmed = null;   // program whose "Renounce" button was clicked once (a second click sends)

function upgradePanel(program, meta) {
  const upgrader = meta.upgrader ?? null;
  const pending = program.pendingUpgrade, scheduled = program.scheduledUpgrade;
  const mine = wallet && upgrader === wallet;
  const head = (text) => `<div class="ix-head"><span><b>${text}</b></span></div>`;
  return `<div class="pad form" id="upgrade-panel">
    ${walletRow("Upgrades are signed by the wallet: new code and rights by the upgrader, review by an admin")}
    <div class="row"><span>Version <b id="up-version">${esc(meta.version ?? 1)}</b></span><span class="dim">·</span>
      <span>Upgrader ${upgrader ? addr(upgrader) : '<span class="dim">None (immutable)</span>'}</span>
      ${upgrader && wallet ? `<span class="tag ${mine ? "ok" : "bad"}">${mine ? "You are the upgrader" : "This wallet is not the upgrader"}</span>` : ""}</div>
    ${pending ? `${head("Pending upgrade · awaiting review")}
      <div class="dim">Submitted by ${addr(pending.context?.sender)} · migrate input</div>${json(pending.migrateInput ?? {})}
      <pre id="up-pending-code">${esc(sourceOf(pending.code))}</pre>
      <div class="row"><button class="btn solid" id="up-approve" onclick="reviewUpgrade('${program.address}','initUpgrade')">Approve upgrade</button>
        <button class="btn" id="up-reject" onclick="reviewUpgrade('${program.address}','rejectUpgrade')">Reject upgrade</button>
        <span class="dim">Admin only</span></div>` : ""}
    ${scheduled ? `<div class="dim">An approved upgrade becomes active at block ${esc(scheduled.activateAt)}</div>` : ""}
    ${upgrader ? `${head("Submit new code")}
      <label>New code<textarea id="up-code" rows="10" spellcheck="false">${esc(sourceOf(program.code))}</textarea></label>
      <label>Migrate input (JSON, passed to migrate)<textarea id="up-input" rows="2" spellcheck="false">{}</textarea></label>
      <div class="row"><button class="btn solid" id="up-send" onclick="sendUpgrade('${program.address}')">Send upgrade</button>
        <span class="dim">The new code waits for admin review before it runs</span></div>
      ${head("Upgrade rights")}
      <label>New upgrader<input id="up-next" placeholder="0x…" spellcheck="false" autocomplete="off"></label>
      <div class="row"><button class="btn" id="up-transfer" onclick="transferUpgrader('${program.address}')">Transfer upgrade rights</button>
        <button class="btn" id="up-renounce" onclick="renounceUpgrader('${program.address}')">${renounceArmed === program.address ? "Click again to renounce for good" : "Renounce (make immutable)"}</button></div>`
      : '<div class="dim">This program has no upgrader, so its code can never change.</div>'}
    <div class="out" id="up-out">Nothing sent yet</div>
  </div>`;
}

/** after a confirmed upgrade action: redraw the program (version / upgrader / pending) and keep the result line */
async function upgradeDone(label, receipt) {
  if (!receipt) return;
  await render(true);
  writeOut("up-out", `<span class="tag ok">✓ Success</span> ${esc(label)} · block ${num(receipt.blockNumber)}${txLinkBtn(receipt.hash)}`);
}

async function sendUpgrade(program) {
  let fields;
  try {
    const code = document.getElementById("up-code").value;
    if (!code.trim()) throw new Error("Enter the new code");
    fields = { action: "upgrade", to: program, code, input: jsonInput("up-input", "Migrate input") };
  } catch (error) { return writeOut("up-out", esc(error.message)); }
  upgradeDone("Upgrade submitted for review", await signedAction("up-out", "Upgrade", fields));
}

async function transferUpgrader(program) {
  const next = document.getElementById("up-next").value.trim();
  if (!isAddress(next)) return writeOut("up-out", esc("New upgrader must be an address 0x… (40 hex characters)"));
  upgradeDone("Upgrade rights transferred", await signedAction("up-out", "Transfer upgrade rights", { action: "setUpgrader", to: program, input: { upgrader: next.toLowerCase() } }));
}

async function renounceUpgrader(program) {
  if (renounceArmed !== program) {   // two clicks: renouncing can never be undone
    renounceArmed = program;
    document.getElementById("up-renounce").textContent = "Click again to renounce for good";
    return;
  }
  renounceArmed = null;
  upgradeDone("Upgrade rights renounced", await signedAction("up-out", "Renounce upgrade rights", { action: "setUpgrader", to: program, input: { upgrader: null } }));
}

async function reviewUpgrade(program, action) {
  const label = action === "initUpgrade" ? "Upgrade approved" : "Upgrade rejected";
  upgradeDone(label, await signedAction("up-out", action === "initUpgrade" ? "Approve upgrade" : "Reject upgrade", { action, to: program }));
}
