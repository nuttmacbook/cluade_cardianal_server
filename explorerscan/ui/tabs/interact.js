/* explorerscan/ui/tabs/interact.js [แก้ได้ · หน้าตา]
   แท็บ Interact: ฟอร์มเรียกฟังก์ชัน (ช่องกรอกเดาจาก core/interact.js หรือพิมพ์ JSON) + กล่องผลลัพธ์ */

let ix = { program: null, code: "", fn: "", mode: "fields", values: {}, json: "{}", extra: {} };
try { if (localStorage.getItem("ix-mode") === "json") ix.mode = "json"; } catch {}

const TYPE_LABEL = { list: "list (JSON)", object: "object (JSON)", address: "address", number: "whole number", boolean: "yes / no", text: "text" };

// metadata.abi type → field type of the form (uint / int → whole number · array → list …)
const ABI_FIELD = { address: "address", uint: "number", int: "number", bool: "boolean", string: "text", bytes: "text", object: "object", array: "list", any: "text" };
/** the chosen function in metadata.abi (null = not declared → guess from the code) */
const abiFunction = () => (ix.abi?.functions ?? []).find((f) => f.name === ix.fn) ?? null;

function ixFields() {
  const declared = abiFunction();
  if (declared) return (declared.inputs ?? []).map((f) => ({ name: f.name, type: ABI_FIELD[f.type] ?? "text", description: f.description }));
  return inferInputs(ix.code, ix.fn);
}

function ixInner() {
  if (ix.mode === "json") {
    const rows = Math.min(16, Math.max(4, ix.json.split("\n").length + 1));
    return `<textarea id="args" spellcheck="false" aria-label="Input (JSON)" rows="${rows}">${esc(ix.json)}</textarea>`;
  }
  const fields = ixFields();
  const extra = Object.keys(ix.extra);
  const rows = fields.map((f) => {
    const v = ix.values[f.name] ?? "";
    const id = `ix-${f.name}`;
    const control = f.type === "boolean"
      ? `<select class="ix-f" id="${id}" data-name="${attr(f.name)}" data-type="boolean">${["", "true", "false"].map((o) => `<option value="${o}" ${o === v ? "selected" : ""}>${o === "" ? "— not set —" : o === "true" ? "Yes (true)" : "No (false)"}</option>`).join("")}</select>`
      : f.type === "list" || f.type === "object"
        ? `<textarea class="ix-f" id="${id}" data-name="${attr(f.name)}" data-type="${f.type}" spellcheck="false" rows="3" placeholder="${attr(JSON.stringify(sampleOf(f)))}">${esc(v)}</textarea>`
        : `<input class="ix-f" id="${id}" data-name="${attr(f.name)}" data-type="${f.type}" value="${attr(v)}" autocomplete="off" spellcheck="false"
            ${f.type === "number" ? 'inputmode="numeric" placeholder="0"' : f.type === "address" ? 'placeholder="0x…"' : ""}>`;
    return `<label for="${id}"><span class="ix-name"><span class="mono">${esc(f.name)}</span><span class="ix-type">${TYPE_LABEL[f.type]}</span></span>${control}${
      f.description ? `<span class="dim">${esc(f.description)}</span>` : ""}</label>`;
  }).join("");
  const declared = abiFunction();
  const about = declared ? `<div class="dim ix-none"><span class="tag ok">ABI</span> ${esc(declared.description ?? "Fields from the program's published ABI")}${
    declared.readonly ? " · read-only" : declared.payable ? " · accepts value" : ""}${
    declared.outputs?.length ? ` · returns ${esc(declared.outputs.map((o) => o.name ? `${o.name}: ${o.type}` : o.type).join(", "))}` : ""}</div>` : "";
  return `${about}${rows ? `<div class="ix-fields">${rows}</div>`
    : '<div class="dim ix-none">This function reads nothing from params.input. Switch to JSON to send a custom input.</div>'}
    ${extra.length ? `<div class="dim ix-none">Also sent from the JSON: <span class="mono">${esc(extra.join(", "))}</span></div>` : ""}`;
}

function interactPanel(program, abi = null) {
  const names = callableOf(program.code);
  ix.abi = abi;
  if (ix.program !== program.address) ix = { ...ix, program: program.address, fn: names[0] ?? "", values: {}, json: "{}", extra: {} };
  if (!names.includes(ix.fn)) ix.fn = names[0] ?? "";
  ix.code = program.code;
  const options = names.map((n) => `<option ${n === ix.fn ? "selected" : ""}>${esc(n)}</option>`).join("");
  return `<div class="pad form">
    ${walletRow("Sending a transaction needs a wallet; reading does not")}
    <label>Function<select id="fn" onchange="pickFn(this.value)">${options || "<option>No callable functions</option>"}</select></label>
    <div class="ix-head"><span>Input</span>
      <span class="seg" role="group" aria-label="Input mode">
        <button type="button" data-mode="fields" class="${ix.mode === "fields" ? "on" : ""}" onclick="setMode('fields')">Fields</button>
        <button type="button" data-mode="json" class="${ix.mode === "json" ? "on" : ""}" onclick="setMode('json')">JSON</button>
      </span></div>
    <div id="ix-input" oninput="ixSave()" onchange="ixSave()">${ixInner()}</div>
    <label>Attached value (coins)<input id="val" value="0" inputmode="decimal"></label>
    <div class="row">
      <button class="btn" onclick="runQuery('${program.address}')">Read (no gas)</button>
      <button class="btn solid" onclick="runWrite('${program.address}')">Send transaction</button>
    </div>
    <div class="ixout" id="out" aria-live="polite"><div class="ix-status dim">The result will appear here</div></div>
  </div>`;
}

/** remember what is typed (switching function / mode or reconnecting the wallet keeps it) */
function ixSave() {
  const box = document.getElementById("ix-input");
  if (!box) return;
  if (ix.mode === "json") { ix.json = document.getElementById("args")?.value ?? ix.json; return; }
  for (const f of box.querySelectorAll(".ix-f")) ix.values[f.dataset.name] = f.value;
}

function drawIx() {
  const box = document.getElementById("ix-input");
  if (box) box.innerHTML = ixInner();
  for (const b of document.querySelectorAll(".ix-head .seg button")) b.classList.toggle("on", b.dataset.mode === ix.mode);
}

function pickFn(name) { ixSave(); ix.fn = name; drawIx(); }

/** fields → input object · throws with the field name when a value does not fit its type
 *  (loose = switching to JSON: a value that does not fit is copied as typed, so nothing is lost) */
function fieldsInput(loose = false) {
  const input = { ...ix.extra };
  for (const f of ixFields()) {
    const raw = String(ix.values[f.name] ?? "").trim();
    if (raw === "") { delete input[f.name]; continue; }
    if (f.type === "number") {
      if (!/^-?\d+n?$/.test(raw)) { if (loose) { input[f.name] = raw; continue; } throw new Error(`${f.name} must be a whole number`); }
      input[f.name] = `${raw.replace(/n$/, "")}n`;
    } else if (f.type === "boolean") input[f.name] = raw === "true";
    else if (f.type === "list" || f.type === "object") {
      let v;
      try { v = JSON.parse(raw); } catch {
        if (loose) { input[f.name] = raw; continue; }
        throw new Error(`${f.name} must be JSON, e.g. ${JSON.stringify(sampleOf(f))}`);
      }
      input[f.name] = bigints(v);
    } else input[f.name] = raw;
  }
  return input;
}

function setMode(mode) {
  if (mode === ix.mode) return;
  ixSave();
  try {
    if (mode === "json") ix.json = JSON.stringify(fieldsInput(true), null, 2);
    else {
      const parsed = JSON.parse(ix.json.trim() || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Input must be a JSON object { … }");
      const names = new Set(ixFields().map((f) => f.name));
      ix.values = {};
      ix.extra = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (!names.has(k)) ix.extra[k] = v;
        else ix.values[k] = typeof v === "string" ? (/^-?\d+n$/.test(v) ? v.slice(0, -1) : v)
          : typeof v === "boolean" || typeof v === "number" ? String(v) : JSON.stringify(v);
      }
    }
  } catch (error) { return show(error.message); }
  ix.mode = mode;
  try { localStorage.setItem("ix-mode", mode); } catch {}
  drawIx();
}

const readForm = () => {
  ixSave();
  return {
    functionName: document.getElementById("fn").value,
    input: ix.mode === "json" ? JSON.parse(ix.json || "{}") : fieldsInput(),
    value: toWei(document.getElementById("val").value),
  };
};
// ---------- interact results: the return value up front, the full response folded underneath ----------
//   the box is updated in place (old result stays dimmed while the next one loads) so the page never jumps or blinks
let outSeq = 0;
let fullOpen = false;   // keep "Full response" open / closed between runs
const outBox = () => document.getElementById("out");

/** loading state: keep what is there, dim it, change only the status line */
function busy(text, extra = "") {
  const box = outBox();
  if (!box) return;
  box.classList.add("busy");
  const status = box.querySelector(".ix-status");
  status.className = "ix-status dim";
  status.innerHTML = `<span class="spin"></span>${esc(text)}${extra}`;
}

/** final state: status line · return value (or error) · full response folded */
function showResult({ ok, label, value, error, full, link = "" }) {
  const box = outBox();
  if (!box) return;
  const shown = returnValue(value);
  box.classList.remove("busy");
  box.innerHTML = `<div class="ix-status"><span class="tag ${ok ? "ok" : "bad"}">${ok ? "✓ Success" : "✗ Failed"}</span>
      <span class="dim">${label}</span>${link}</div>
    <div class="ix-ret"><span class="lbl">${ok ? "Return value" : "Error"}</span>
      ${ok ? shown : `<span class="bad">${esc(error ?? "Unknown error")}</span>`}</div>
    ${full === undefined ? "" : `<details class="ix-full" ${fullOpen ? "open" : ""} ontoggle="fullOpen = this.open"><summary>Full response</summary>${json(full)}</details>`}`;
  labelCells(box);
  decorate(box);
}
const show = (message) => showResult({ ok: false, label: "", error: message });
const errorText = (e) => (e == null ? undefined : typeof e === "string" ? e : [e.code, e.message].filter(Boolean).join(": "));
const txLinkBtn = (hash) => ` <a class="ix-link" onclick="go('#tx/${hash}')">View transaction →</a>`;

async function runQuery(program) {
  const seq = ++outSeq;
  try {
    const { functionName, input } = readForm();
    busy("Reading…");
    const res = await api("/query", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ programUuid: program, functionName, input }) });
    if (seq !== outSeq) return;
    const ok = res.status === "success";
    showResult({ ok, label: `Read · ${functionName}()${res.gasUsed !== undefined ? ` · gas ${num(res.gasUsed)}` : ""}`,
      value: res.result, error: errorText(res.error) ?? res.message, full: res });
  } catch (error) { if (seq === outSeq) show(error.message); }
}

/** send → wait for the block → show the call's return value (the user stays on this page) */
async function runWrite(program) {
  const seq = ++outSeq;
  try {
    const { functionName, input, value } = readForm();
    busy("Waiting for the wallet signature…");
    const sent = await sendTx({ action: "call", to: program, method: functionName, input, value });
    if (seq !== outSeq) return;
    if (!sent.queued) return showResult({ ok: false, label: `Transaction · ${functionName}()`, error: errorText(sent.error) ?? "Not accepted", full: sent });
    busy("Sent · waiting for the next block…", txLinkBtn(sent.hash));
    const box = outBox();
    for (let i = 0; i < 120; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (seq !== outSeq || !box.isConnected) return;   // another run started or the user left / redrew the page
      const found = await api(`/tx/${sent.hash}`).catch(() => null);
      if (found?.status === "replaced") {
        return showResult({ ok: false, label: `Transaction · ${functionName}()`, error: "Replaced by another transaction with the same nonce",
          full: found, link: txLinkBtn(found.replacedBy) });
      }
      if (found?.status === "rejected" && found.block) {
        return showResult({ ok: false, label: `Transaction · ${functionName}()`, error: `Rejected: ${found.reason}`, full: found, link: txLinkBtn(sent.hash) });
      }
      if (!found?.blockNumber || found.status === "rejected") continue;
      const receipt = await api(`/tx/${sent.hash}/receipt`);
      if (seq !== outSeq || !box.isConnected) return;
      return showResult({ ok: receipt.status === "success",
        label: `Transaction · ${functionName}() · block ${num(receipt.blockNumber)} · gas ${num(receipt.gasUsed)}`,
        value: receipt.result, error: errorText(receipt.error), full: receipt, link: txLinkBtn(sent.hash) });
    }
    busy("Still waiting for a block — check the transaction page", txLinkBtn(sent.hash));
  } catch (error) { if (seq === outSeq) show(error.message); }
}
