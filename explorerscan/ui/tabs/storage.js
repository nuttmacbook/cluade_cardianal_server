/* explorerscan/ui/tabs/storage.js [แก้ได้ · หน้าตา]
   แท็บ Storage: ข้อมูลที่โปรแกรมเก็บ แยกตามจำนวนส่วนของ key + ค้นค่าทีละ key */

// ---------- program storage, split by how many parts the key has ----------
//   Variables  1-part keys (owner, price)                → all shown with values
//   Maps       2-part keys (balances:<address>)          → pick the first key in the column header → paged list of second keys + values
//   Lookup     3+ part keys (allowance:<a>:<b>)          → not listed · type each key part (stacked, + adds a part) and read one value
let storageView = { address: null, layout: null, sub: "info", map: "", entries: null, page: 1, get: { name: "", parts: ["", ""] }, results: [] };
const MAP_PAGE = 25;

const keyCell = (k) => (isAddress(k) ? addr(k) : `<span class="mono">${esc(k)}</span>`);

/** reloaded on every draw of a program page (data changes every block) · same program keeps the chosen tab / key / page / lookups */
async function loadLayout(address) {
  const layout = await api(`/program/${address}/layout`).catch(() => ({ variables: [], maps: [], deep: [], scanned: 0 }));
  const same = storageView.address === address;
  const sub = same ? storageView.sub
    : layout.variables.length ? "info" : layout.maps.length ? "storage" : layout.deep.length ? "get" : "info";
  const map = same && layout.maps.some((m) => m.name === storageView.map) ? storageView.map : layout.maps[0]?.name ?? "";
  storageView = { address, layout, sub, map, entries: null, page: same && map === storageView.map ? storageView.page : 1,
    get: same ? storageView.get : { name: layout.deep[0]?.name ?? "", parts: ["", ""] }, results: same ? storageView.results : [] };
  if (map) await loadMap(storageView.page, false);
}

async function loadMap(page = 1, redraw = true) {
  const view = storageView;   // a newer page load may replace storageView while this one waits
  const wanted = Math.max(1, Math.floor(Number(page)) || 1);
  const entries = await api(`/program/${view.address}/entries?name=${encodeURIComponent(view.map)}&page=${wanted}&limit=${MAP_PAGE}`)
    .catch(() => null) ?? { items: [], total: 0, page: 1, pages: 1, limit: MAP_PAGE };
  view.entries = entries;
  view.page = entries.page ?? 1;
  if (redraw) drawStorage();
}

function drawStorage() {
  const box = document.getElementById("storage-panel");
  if (!box) return;
  box.innerHTML = storageInner();
  labelCells(box);
  decorate(box);
}

function pickSub(sub) { readKeys(); storageView.sub = sub; drawStorage(); }
async function pickMap(name) { storageView.map = name; await loadMap(1); }

/** keep what was typed before redrawing (pressing + or switching tabs keeps the inputs) */
function readKeys() {
  const name = document.getElementById("gk-name");
  if (!name) return;
  storageView.get.name = name.value;
  storageView.get.parts = [...document.querySelectorAll(".gk-part")].map((input) => input.value);
}
function addKey() {
  readKeys();
  storageView.get.parts.push("");
  drawStorage();
  [...document.querySelectorAll(".gk-part")].at(-1)?.focus();
}
function dropKey() { readKeys(); if (storageView.get.parts.length > 2) storageView.get.parts.pop(); drawStorage(); }

async function readStorage() {
  readKeys();
  const { name, parts } = storageView.get;
  const keys = [name, ...parts.map((p) => p.trim())];
  if (keys.some((k) => !k)) return alert("Fill in every key part");
  const query = keys.map((k) => `key=${encodeURIComponent(k)}`).join("&");
  const result = await api(`/program/${storageView.address}/get?${query}`);
  storageView.results = [result.error ? { key: keys, error: result.error } : result, ...storageView.results].slice(0, 20);
  drawStorage();
}

function storageBody() {
  const { layout, sub } = storageView;
  if (!layout) return '<div class="empty">Loading…</div>';
  const note = layout.truncated ? `<div class="pad dim" style="font-size:12.5px">Counted from the first ${num(layout.scanned)} keys only (there are more)</div>` : "";

  if (sub === "info") {
    return table(["Key", "Value"], layout.variables.map((v) => `<tr><td>${keyChips([v.key])}</td><td>${anyValue(v.value)}</td></tr>`)) + note;
  }

  if (sub === "storage") {
    if (!layout.maps.length) return '<div class="empty">No 2-part keys</div>';
    const { entries, map } = storageView;
    // the first-key dropdown sits in the column header
    const select = `<select id="map-name" title="First key" onchange="pickMap(this.value)">${layout.maps.map((m) =>
      `<option value="${attr(m.name)}" ${m.name === map ? "selected" : ""}>${esc(m.name)} (${num(m.count)})</option>`).join("")}</select>`;
    return table([select, "Value"], (entries?.items ?? []).map((i) => `<tr><td>${keyCell(i.key)}</td><td>${anyValue(i.value)}</td></tr>`))
      + pager(entries, "loadMap($)") + note;
  }

  // lookup: key parts stacked vertically, + adds a part below
  const { name, parts } = storageView.get;
  const names = layout.deep.map((d) => d.name);
  if (!names.length) return '<div class="empty">No keys with 3 or more parts</div>';
  const rows = parts.map((p, i) => `<label class="krow"><span>Key ${i + 2}</span><input class="gk-part" placeholder="key ${i + 2}" value="${attr(p)}"
      onkeydown="if(event.key==='Enter')readStorage()" spellcheck="false"></label>`).join("");
  const results = storageView.results.map((r) => `<tr><td>${keyChips(r.key)}</td><td>${
    r.error ? `<span class="tag bad">${esc(r.error)}</span>` : r.exists ? anyValue(r.value) : '<span class="dim">No value (never written)</span>'}</td></tr>`);
  return `<div class="pad">
      <div class="getkeys">
        <label class="krow"><span>Key 1</span><select id="gk-name">${names.map((n) =>
          `<option value="${attr(n)}" ${n === name ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
        ${rows}
        <div class="krow"><span></span><div class="row">
          <button class="btn" onclick="addKey()" title="Add a key part">+ key</button>
          ${parts.length > 2 ? '<button class="btn" onclick="dropKey()" title="Remove the last key part">− key</button>' : ""}
          <button class="btn solid" onclick="readStorage()">Read value</button>
        </div></div>
        <div class="krow"><span></span><span>${layout.deep.map((d) => `${esc(d.name)}: ${plural(d.count, "key")} · ${d.depth} parts deep`).join(" · ")}</span></div>
      </div>
    </div>` + (results.length ? table(["Key", "Value"], results) : "") + note;
}

const storagePanel = () => `<div id="storage-panel">${storageInner()}</div>`;

function storageInner() {
  const { layout, sub } = storageView;
  const count = (n) => `<b>${num(n)}</b>`;
  const tab = (id, label, n) => `<button class="tab ${sub === id ? "on" : ""}" data-sub="${id}" onclick="pickSub('${id}')">${label}${n === undefined ? "" : count(n)}</button>`;
  return `<div class="sub">
      ${tab("info", "Variables", layout?.variables.length ?? 0)}
      ${tab("storage", "Maps", layout?.maps.reduce((sum, m) => sum + m.count, 0) ?? 0)}
      ${tab("get", "Lookup")}
    </div>
    <div id="storage-box">${storageBody()}</div>`;
}
