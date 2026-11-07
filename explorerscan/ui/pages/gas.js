/* explorerscan/ui/pages/gas.js [แก้ได้ · หน้าตา]
   หน้าค่าแก๊สของเชน (#gas): base fee ขั้นต่ำ + ราคาต่อหน่วยที่ใช้อยู่ (จาก /genesis) · admin ปรับได้ด้วย tx setGasConfig (มีผลตั้งแต่ block ถัดไป) */

// ---------- chain gas settings: what a transaction costs now, and the admin form that changes it ----------
const GAS_FIELDS = [
  ["call", "Program call"], ["read", "DB read"], ["write", "DB write"], ["stateKey", "New state key (per tx)"], ["byte", "Byte read / written"],
  ["event", "Event"], ["topic", "Indexed field (topic)"], ["code", "Code byte (deploy)"], ["node", "Code step"], ["builtin", "Data copied"],
  ["hash", "keccak256"], ["recover", "ecrecover"], ["sha256", "sha256"], ["ripemd160", "ripemd160"], ["blake2b", "blake2b"], ["modexp", "modexp"], ["env", "Chain info read"],
];
let gasInfo = null;

/** "0.1" gwei → "100000000" wei · null = not a number */
function gweiToWei(text) {
  const match = String(text).replace(/,/g, "").trim().match(/^(\d*)(?:\.(\d{0,9}))?$/);
  if (!match || (!match[1] && !match[2])) return null;
  return (BigInt(match[1] || "0") * 10n ** 9n + BigInt((match[2] ?? "").padEnd(9, "0") || "0")).toString();
}

async function gasPage(draw = el) {
  const info = await api("/genesis");
  gasInfo = info;
  const prices = info.gas ?? {};
  const set = info.gasConfig?.gas ?? {};
  const changed = info.gasConfig && info.gasConfig.minBaseFee !== null && info.gasConfig.minBaseFee !== undefined;
  const transfer = toBig(prices.call) + 2n * toBig(prices.read) + 2n * toBig(prices.write);
  const rows = GAS_FIELDS.map(([field, label]) => `<tr><td><b>${esc(label)}</b><div class="dim">${esc(field)}</div></td>
    <td>${num(prices[field] ?? 0)}${Object.hasOwn(set, field) ? ' <span class="tag">set by admin</span>' : ""}</td>
    <td><input id="gas-${field}" value="${attr(prices[field] ?? 0)}" inputmode="numeric" style="max-width:9em"></td></tr>`);
  draw(panel("Gas settings", kv([
    ["Minimum base fee", `<b>${gwei(info.minBaseFee)} gwei</b>${changed ? ` <span class="tag">set by admin · genesis ${gwei(info.genesisMinBaseFee)} gwei</span>` : ' <span class="dim">(from genesis)</span>'}`],
    ["Base fee of the next block", `${gwei(info.baseFee)} gwei <span class="dim">· moves at most 12.5% per block toward the target · burned</span>`],
    ["Coin transfer costs", `${num(`${transfer}n`)} gas × ${gwei(info.baseFee)} gwei = <b>${coin(transfer * toBig(info.baseFee))}</b>`],
    info.gasConfig && ["Last change", `block ${num(info.gasConfig.block ?? 0)} by ${addr(info.gasConfig.by)}`],
  ])) + panel("Change gas (admin)", `<div class="pad form" id="gas-form">
    ${walletRow("Only an address in the chain's admins can send this · it applies from the next block, no fork or restart needed")}
    <label>Minimum base fee (gwei)<input id="gas-min" value="${attr(gwei(info.minBaseFee))}" inputmode="decimal"></label>
    <div class="hint">Every fee is gas × base fee, so lowering this makes all transactions cheaper in coins while gas per transaction stays the same.
      A lower minimum is reached gradually (−12.5% per block); a higher one applies at the next block.</div>
    ${table(["Unit", "Now (gas)", "New"], rows)}
    <div class="row"><button class="btn solid" onclick="sendGasConfig()">Send change</button>
      <button class="btn" onclick="resetGasConfig()">Reset to genesis / code defaults</button></div>
    <div class="out" id="gas-out">Not sent yet</div>
  </div>`));
}

async function sendGasConfig() {
  const info = gasInfo ?? await api("/genesis");
  const input = {};
  const wei = gweiToWei(document.getElementById("gas-min")?.value ?? "");
  if (wei === null || wei === "0") return writeOut("gas-out", esc("Minimum base fee must be a number above 0 (gwei, up to 9 decimals)"));
  if (wei !== toBig(info.minBaseFee).toString()) input.minBaseFee = wei;
  const gas = {};
  for (const [field] of GAS_FIELDS) {
    const raw = document.getElementById(`gas-${field}`)?.value.trim() ?? "";
    if (!/^\d+$/.test(raw)) return writeOut("gas-out", esc(`${field}: whole number ≥ 0`));
    if (Number(raw) !== Number(info.gas?.[field] ?? 0)) gas[field] = Number(raw);
  }
  if (Object.keys(gas).length) input.gas = gas;
  if (!Object.keys(input).length) return writeOut("gas-out", esc("Nothing changed"));
  if (await signedAction("gas-out", "Change gas", { action: "setGasConfig", input })) await gasPage();
}

async function resetGasConfig() {
  const info = gasInfo ?? await api("/genesis");
  const set = Object.keys(info.gasConfig?.gas ?? {});
  const input = { minBaseFee: null, ...(set.length ? { gas: Object.fromEntries(set.map((field) => [field, null])) } : {}) };
  if (await signedAction("gas-out", "Reset gas", { action: "setGasConfig", input })) await gasPage();
}
