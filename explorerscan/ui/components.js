/* explorerscan/ui/components.js [แก้ได้ · หน้าตา]
   ชิ้นส่วนที่ใช้ซ้ำทุกหน้า: panel, ตาราง, key/value, ลิงก์ address / tx, ไอคอน, tag สถานะ, กล่อง JSON, ตัวแบ่งหน้า, แท็บ
   แก้ HTML ที่นี่ = เปลี่ยนทุกหน้าพร้อมกัน · สีและขนาดอยู่ใน theme/style.css (ชื่อ class ตรงกัน) */

/** every address and hash is clickable and copyable */
const copy = (value) => `<button class="copy" title="Copy" onclick="event.stopPropagation();copyText('${value}')">⧉</button>`;
const icon = (a, big) => `<span class="ico${big ? " big" : ""}" data-ico="${attr(String(a).toLowerCase())}"></span>`;
const addr = (a, label) => (a ? `<span class="mono">${icon(a)}<a onclick="go('#address/${a}')" title="${attr(a)}">${esc(label ?? cut(a))}</a>${copy(a)}</span>` : '<span class="dim">—</span>');

/** { } / [ ] values → coloured JSON box · "123n" shown as a number */
function jsonHtml(v, depth = 0) {
  const pad = "  ".repeat(depth + 1), end = "  ".repeat(depth);
  if (typeof v === "string" && /^-?\d+n$/.test(v)) return `<span class="n">${esc(v.slice(0, -1))}</span>`;
  if (typeof v === "string") return `<span class="s">"${esc(v)}"</span>`;
  if (typeof v === "number") return `<span class="n">${v}</span>`;
  if (v === null || typeof v === "boolean" || v === undefined) return `<span class="b">${v ?? null}</span>`;
  if (Array.isArray(v)) return v.length ? `<span class="p">[</span>\n${v.map((x) => pad + jsonHtml(x, depth + 1)).join('<span class="p">,</span>\n')}\n${end}<span class="p">]</span>` : '<span class="p">[]</span>';
  const keys = Object.keys(v);
  return keys.length ? `<span class="p">{</span>\n${keys.map((k) => `${pad}<span class="k">"${esc(k)}"</span><span class="p">:</span> ${jsonHtml(v[k], depth + 1)}`).join('<span class="p">,</span>\n')}\n${end}<span class="p">}</span>` : '<span class="p">{}</span>';
}
const json = (v) => `<pre class="json">${jsonHtml(v)}</pre>`;
const isObject = (v) => v !== null && typeof v === "object";
/** any value: object → JSON box · address → link · number → thousands separators */
const anyValue = (v) => (isObject(v) ? json(v) : isAddress(v) ? addr(v) : `<span class="mono">${esc(num(v))}</span>`);
/** multi-part key ["allowance","0xab…","0xcd…"] → joined badges */
const keyChips = (parts) => `<span class="kchips">${parts.map((p) =>
  `<span class="kchip" title="${attr(p)}">${esc(isAddress(p) ? cut(p) : p)}</span>`).join("")}</span>`;
const gas = (v) => `<span class="mono" style="white-space:nowrap"><span class="ico gas" title="Gas"></span>${num(v)}</span>`;
const blockNo = (n) => (n === undefined || n === null ? '<span class="dim">—</span>'
  : `<span style="white-space:nowrap"><span class="ico blk" title="Block"></span><a onclick="go('#block/${n}')">${num(n)}</a></span>`);
const txLink = (h, label) => (h ? `<span class="mono"><a onclick="go('#tx/${h}')" title="${attr(h)}">${esc(label ?? cut(h))}</a>${copy(h)}</span>` : '<span class="dim">—</span>');
/** icon from metadata.icon: image (url / data:image) as a square · short text (emoji) in a frame · none = first letter of the name */
function avatar(meta = {}, big) {
  const cls = `avatar${big ? " lg" : ""}`;
  if (isImage(meta.icon)) return `<span class="${cls}"><img src="${attr(meta.icon)}" alt="icon" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.textContent='?'"></span>`;
  const text = typeof meta.icon === "string" && meta.icon.trim() ? [...meta.icon.trim()].slice(0, 2).join("") : (meta.namespace?.[0] ?? "?").toUpperCase();
  return `<span class="${cls}">${esc(text)}</span>`;
}
const extLink = (label, value) => {
  const href = safeHref(value);
  const shown = esc(String(value).replace(/^mailto:/i, ""));
  return href ? `<a class="ext" href="${attr(href)}" target="_blank" rel="noopener noreferrer nofollow"><b>${label}</b><span>${shown} ↗</span></a>`
    : `<span class="ext"><b>${label}</b><span>${shown}</span></span>`;
};
/** hash in a table → short · on a detail page → full (wraps on small screens) */
const plain = (v) => (v ? `<span class="mono" title="${attr(v)}">${esc(cut(v))}${copy(v)}</span>` : '<span class="dim">—</span>');
const full = (v) => (v ? `<span class="mono full">${esc(v)}${copy(v)}</span>` : '<span class="dim">—</span>');
const STATUS = { success: "Success", throw: "Failed", pending: "Pending", rejected: "Rejected" };
/** where a rejected tx was turned away (it never ran: no state change, no nonce used, no fee) */
const STAGE_LABEL = { sendtx: "At submission", block: "At block time", expired: "Expired in the queue" };
const stageTag = (s) => `<span class="tag">${esc(STAGE_LABEL[s] ?? s ?? "—")}</span>`;
const state = (s) => `<span class="tag ${s === "success" ? "ok" : s === "pending" ? "" : "bad"}">${STATUS[s] ?? esc(s)}</span>`;

function copyText(value) {
  navigator.clipboard?.writeText(value);
  const toast = document.getElementById("toast");
  toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 1200);
}

/** "Transactions (12)" → the count becomes a small chip on the card's label tab (text stays the same) */
const panelTitle = (title) => String(title).replace(/ \(([\d,]+)\)$/, ' <span class="cnt">($1)</span>');
const panel = (title, inner, pad) => `<section class="panel"><h2>${panelTitle(title)}</h2><div class="${pad ? "pad" : "body"}">${inner}</div></section>`;
const table = (head, rows) => (rows.length
  ? `<div class="twrap"><table class="grid"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
  : '<div class="empty">No data</div>');
const kv = (pairs) => `<table class="kv"><tbody>${pairs.filter(Boolean).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</tbody></table>`;
const el = (html) => { const view = document.getElementById("view"); view.innerHTML = html; labelCells(view); decorate(); };

/** phones show tables as cards: label every cell from its column (data-label) and wrap the value in .cv */
function labelCells(root) {
  for (const t of root.querySelectorAll("table.grid")) {
    const labels = [...t.querySelectorAll(":scope>thead th")].map((th) => (th.querySelector("select") ? "key" : th.textContent.trim()));
    for (const tr of t.querySelectorAll(":scope>tbody>tr")) {
      [...tr.children].forEach((td, i) => {
        td.dataset.label = labels[i] ?? "";
        if (td.firstElementChild?.classList.contains("cv")) return;
        const cv = document.createElement("div");
        cv.className = "cv";
        cv.append(...td.childNodes);
        td.append(cv);
      });
    }
  }
}

/** icon for every address on the page: has code = program (computer) · otherwise user wallet (person) */
const kinds = new Map();   // address → true (program) · only programs are cached, an empty wallet may be deployed to later
async function decorate(root = document) {
  const marks = [...root.querySelectorAll("[data-ico]")];
  const unknown = [...new Set(marks.map((m) => m.dataset.ico).filter((a) => !kinds.has(a)))];
  for (let i = 0; i < unknown.length; i += 200) {
    const flags = await api(`/is-program?addresses=${unknown.slice(i, i + 200).join(",")}`).catch(() => ({}));
    for (const [address, program] of Object.entries(flags)) if (program) kinds.set(address, true);
  }
  for (const mark of marks) {
    const program = kinds.get(mark.dataset.ico) === true;
    mark.classList.toggle("program", program);
    mark.classList.toggle("person", !program);
    mark.title = program ? "Program (has code)" : "User wallet";
  }
}

const txRow = (t, columns) => `<tr>${columns.map((c) => `<td>${c}</td>`).join("")}</tr>`;
// readable labels for program upgrade / clone actions (other actions show their raw name)
const ACTION_LABELS = { upgrade: "Upgrade", setUpgrader: "Set upgrader", initUpgrade: "Approve upgrade", rejectUpgrade: "Reject upgrade", create: "Create" };
const actionTag = (a) => `<span class="tag">${esc(ACTION_LABELS[a] ?? a)}</span>`;

/** pager below a list · handler is a call with $ for the page number, e.g. "setPage('in',$)" */
function pager(res, handler) {
  if (!res || !res.total) return "";
  const from = (res.page - 1) * res.limit + 1, to = Math.min(res.page * res.limit, res.total);
  const call = (n) => handler.replace("$", n);
  const info = `<span>Showing ${num(from)}–${num(to)} of ${num(res.total)}${res.truncated ? "+" : ""}</span>`;
  if (res.pages <= 1) return `<div class="pager">${info}</div>`;
  const buttons = pageNumbers(res.page, res.pages).map((n) => (n === "…" ? '<span class="gap">…</span>'
    : `<button class="pg ${n === res.page ? "on" : ""}" onclick="${call(n)}" ${n === res.page ? 'aria-current="page"' : ""}>${num(n)}</button>`)).join("");
  return `<div class="pager">${info}
    <div class="pages">
      <button class="pg" title="Previous page" onclick="${call(res.page - 1)}" ${res.page <= 1 ? "disabled" : ""}>‹</button>
      ${buttons}
      <button class="pg" title="Next page" onclick="${call(res.page + 1)}" ${res.page >= res.pages ? "disabled" : ""}>›</button>
    </div>
    <div class="jump"><span>Go to</span><input type="number" min="1" max="${res.pages}" placeholder="page" aria-label="Page number"
        onkeydown="if(event.key==='Enter'){${call("Math.min(" + res.pages + ",this.value)")}}">
      <button class="pg" onclick="${call("Math.min(" + res.pages + ",this.previousElementSibling.value)")}">Go</button></div>
  </div>`;
}
/** "‹ Newer · Page N · Older ›" below a cursor list */
function cursorPager(res, id) {
  if (!res || (!res.items?.length && res.pageNo <= 1)) return "";
  return `<div class="pager" data-cursor="${attr(id)}"><span>Page ${num(res.pageNo)} · ${plural(res.items.length, "item")}</span>
    <div class="pages">
      <button class="pg" title="Newer" onclick="cursorGo('${id}',-1)" ${res.pageNo <= 1 ? "disabled" : ""}>‹ Newer</button>
      <button class="pg" title="Older" onclick="cursorGo('${id}',1)" ${res.next ? "" : "disabled"}>Older ›</button>
    </div></div>`;
}

const walletRow = (note) => `<div class="row">
    ${wallet ? `<span class="tag ok">Connected</span> ${addr(wallet)}`
             : '<button class="btn solid" onclick="connect().catch((e) => alert(e.message))">Connect wallet</button>'}
    <span class="dim">${note}</span>
  </div>`;

// ---------- tabs ----------
let tabState = {};
function tabs(groups) {
  const key = location.hash;
  const active = tabState[key] ?? groups.find((g) => g.body)?.id ?? groups[0].id;
  const head = groups.map((g) => `<button class="tab ${g.id === active ? "on" : ""}" data-tab="${g.id}" onclick="pickTab('${g.id}')">${g.label}${
    g.count === undefined ? "" : `<b>${num(g.count)}</b>`}</button>`).join("");
  const current = groups.find((g) => g.id === active) ?? groups[0];
  return `<section class="panel"><div class="tabs scroll">${head}</div><div class="${current.pad ? "pad" : "body"}">${current.body}</div></section>`;
}
function pickTab(id) {
  if (document.querySelector("button.tab.on[data-tab]")?.dataset.tab === id) return;   // already open: keep what was typed
  tabState[location.hash] = id;
  render(true);
}
