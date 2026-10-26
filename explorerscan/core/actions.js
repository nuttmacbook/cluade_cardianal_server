/* explorerscan/core/actions.js [ระบบ · ไม่ต้องแก้]
   เซ็น + ส่ง + รอผลจาก block แล้วเขียนสถานะลงกล่องผลลัพธ์ (signedAction / waitForTx) · อ่าน JSON ที่ผู้ใช้พิมพ์ */

// ---------- signed actions with a status box: send, wait for the block, report ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeOut = (id, v) => { const box = document.getElementById(id); if (box) box.innerHTML = typeof v === "string" ? v : jsonHtml(v); };

/** wait until the tx is in a block (→ receipt) or recorded as rejected (→ { status: "rejected" }) · null = still waiting */
async function waitForTx(hash, tries = 90) {
  for (let i = 0; i < tries; i += 1) {
    await sleep(700);
    const found = await api(`/tx/${hash}`).catch(() => null);
    if (found?.status === "rejected" && found.block) return found;
    if (found?.status === "replaced") return found;
    if (found?.blockNumber && found.status !== "rejected") return api(`/tx/${hash}/receipt`);
  }
  return null;
}

/** sign + send fields, wait for the outcome and write it to the box #outId · returns the receipt when it succeeded */
async function signedAction(outId, label, fields) {
  const out = (v) => writeOut(outId, v);
  try {
    out(esc(`${label}: waiting for the wallet signature…`));
    const sent = await sendTx(fields);
    if (!sent.queued) { out(sent); return null; }
    out(`${esc(label)}: sent · waiting for the next block…${txLinkBtn(sent.hash)}`);
    const result = await waitForTx(sent.hash);
    if (!result) { out(`${esc(label)}: still waiting for a block — check the transaction page${txLinkBtn(sent.hash)}`); return null; }
    if (result.status !== "success") {
      out(`<span class="tag bad">✗ ${esc(STATUS[result.status] ?? result.status)}</span> ${esc(label)}: ${esc(result.reason ?? result.error?.message ?? "")}${txLinkBtn(sent.hash)}`);
      return null;
    }
    out(`<span class="tag ok">✓ Success</span> ${esc(label)} · block ${num(result.blockNumber)}${txLinkBtn(sent.hash)}`);
    return result;
  } catch (error) { out(esc(`Error: ${error.message}`)); return null; }
}

/** typed JSON (input / migrate input) → object with whole numbers as "123n" */
function jsonInput(id, label) {
  const raw = document.getElementById(id)?.value.trim() || "{}";
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`${label} must be JSON, e.g. { "supply": 1000 }`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object { … }`);
  return bigints(value);
}
