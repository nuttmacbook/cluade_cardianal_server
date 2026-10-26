/* explorerscan/ui/pages/tx.js [แก้ได้ · หน้าตา]
   หน้า tx (#tx/<hash>): สถานะ, ค่าแก๊ส, ค่าที่คืน, ยอดที่เปลี่ยน, แผนภาพการเรียกโปรแกรม (trace), event */

// ---------- transaction ----------
//   Program calls = a small top-down tree: one numbered box per call (order only), arrows from caller to callee
//   clicking a box shows that call's details (input / value / result or error / gas) below the diagram
let traceCalls = [];
let traceNames = {};
const flowSize = () => (innerWidth <= 260 ? { row: 40, slot: 32, box: 24, h: 24 } : { row: 46, slot: 40, box: 28, h: 28 });

/** parent of each call = the nearest earlier call one level shallower (calls arrive in depth-first order) */
function traceParents(trace) {
  const stack = [];
  return trace.map((c, i) => {
    stack.length = c.depth;
    const parent = c.depth ? stack[c.depth - 1] ?? -1 : -1;
    stack[c.depth] = i;
    return parent;
  });
}

function traceView(trace, sender, names = {}) {
  traceCalls = trace;
  traceNames = names;
  const failed = trace.filter((c) => c.status !== "success").length;
  const deepest = Math.max(...trace.map((c) => c.depth));
  const parents = traceParents(trace);
  const { row, slot, box, h } = flowSize();
  // top-down tree: the tx sender on top, each call one level below its caller, siblings left → right in call order
  // every leaf takes one column (slot); a caller sits centred over its first and last callee
  const kids = trace.map(() => []), roots = [];
  parents.forEach((p, i) => (p < 0 ? roots : kids[p]).push(i));
  const col = new Array(trace.length);
  let leaves = 0;
  const place = (i) => {
    for (const k of kids[i]) place(k);
    col[i] = kids[i].length ? (col[kids[i][0]] + col[kids[i].at(-1)]) / 2 : leaves++;
  };
  roots.forEach(place);
  const rootCol = roots.length ? (col[roots[0]] + col[roots.at(-1)]) / 2 : 0;
  const x = (c) => c * slot + (slot - box) / 2 + 4;
  const y = (level) => level * row + 6;
  const width = Math.max(leaves, 1) * slot + 8, height = y(deepest + 1) + h + 6;
  const arrows = trace.map((c, i) => {
    const from = parents[i];
    const px = x(from < 0 ? rootCol : col[from]) + box / 2, py = y(from < 0 ? 0 : trace[from].depth + 1) + h;
    const cx = x(col[i]) + box / 2, cy = y(c.depth + 1), mid = cy - (row - h) / 2;
    return `<path class="${c.status === "success" ? "" : "fail"}" d="M${px} ${py} V${mid} H${cx} V${cy - 3}" marker-end="url(#arrow${c.status === "success" ? "" : "-bad"})"/>`;
  }).join("");
  const label = (a) => names[String(a).toLowerCase()] ?? a;
  const boxes = trace.map((c, i) => {
    const ok = c.status === "success";
    return `<button class="node ${ok ? "" : "fail"} ${i === 0 ? "on" : ""}" data-call="${i}" onclick="pickCall(${i})"
        style="left:${x(col[i])}px;top:${y(c.depth + 1)}px;width:${box}px;height:${h}px"
        title="#${i + 1} ${attr(label(c.program))}.${attr(c.method)}()${ok ? "" : " (failed)"}">${i + 1}</button>`;
  }).join("");
  const start = `<div class="node start" style="left:${x(rootCol)}px;top:${y(0)}px;width:${box}px;height:${h}px" title="Sent by ${attr(label(sender))}">tx</div>`;
  return `<div class="calls">
    <div class="calls-sum">${plural(trace.length, "call")} · max depth ${deepest}${failed ? ` · <span class="bad">${failed} failed</span>` : ""} · click a box for its details</div>
    <div class="calls-body">
    <div class="flowwrap"><div class="flow" style="width:${width}px;height:${height}px">
      <svg class="links" width="${width}" height="${height}" aria-hidden="true">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="head"/></marker>
          <marker id="arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="head bad"/></marker>
        </defs>${arrows}</svg>
      ${start}${boxes}
    </div></div>
    <div id="call-detail" class="${trace[0]?.status === "success" ? "" : "fail"}">${callDetail(0)}</div>
    </div>
  </div>`;
}

/** details of one call: caller → program.method(), gas, value, origin, input, result or error */
function callDetail(i) {
  const c = traceCalls[i];
  if (!c) return "";
  const ok = c.status === "success";
  const io = (lbl, inner) => `<div class="io"><span class="lbl">${lbl}</span>${inner}</div>`;
  const empty = (v) => v === null || v === undefined || (isObject(v) && !Array.isArray(v) && !Object.keys(v).length);
  const name = (a) => (traceNames[String(a).toLowerCase()] ? ` <span class="dim">(${esc(traceNames[String(a).toLowerCase()])})</span>` : "");
  return `<div class="call ${ok ? "" : "fail"}">
    <div class="call-h"><span class="tag ${ok ? "ok" : "bad"}">${ok ? "✓ Success" : "✗ Failed"}</span>
      <b>${c.type === "create" ? "Create" : "Call"} #${i + 1}</b>${c.type === "create" ? ' <span class="tag">CREATE</span>' : ""}<span class="dim">depth ${c.depth}</span></div>
    <div class="call-path">${addr(c.from)}${name(c.from)} <span class="dim">→</span> ${addr(c.program)}${name(c.program)}<span class="mono">.${esc(c.method)}()</span></div>
    <div class="call-m"><span>Gas ${gas(c.gasUsed ?? null)}</span><span>Value <span class="mono">${coin(c.value ?? 0)}</span></span>
      ${c.origin && c.origin !== c.from ? `<span>Origin ${addr(c.origin)}</span>` : ""}</div>
    <div class="call-b">
      ${io("Input", empty(c.input) ? '<span class="dim mono">{}</span>' : json(c.input))}
      ${ok ? io("Result", empty(c.result) ? `<span class="dim mono">${c.result === null || c.result === undefined ? "null" : "{}"}</span>` : anyValue(c.result))
           : io("Error", `<span class="tag bad">${esc(c.error?.code ?? "ERROR")}</span> <span class="bad">${esc(c.error?.message ?? "")}</span>`)}
    </div></div>`;
}

function pickCall(i) {
  for (const node of document.querySelectorAll(".flow .node[data-call]")) node.classList.toggle("on", Number(node.dataset.call) === i);
  const box = document.getElementById("call-detail");
  box.innerHTML = callDetail(i);
  box.classList.toggle("fail", traceCalls[i]?.status !== "success");
  box.scrollTop = 0;
  labelCells(box);
  decorate(box);
}

async function tx(hash, draw = el) {
  // where the tx is first: in a block, waiting in the mempool, replaced (same nonce, higher gas price) or rejected (never ran)
  const queued = await api(`/tx/${hash}`).catch(() => null);
  const inBlock = queued && !queued.error && queued.status !== "pending" && queued.status !== "replaced" && queued.status !== "rejected";
  const r = inBlock ? await api(`/tx/${hash}/receipt`) : { error: queued?.error ?? "Transaction not found" };
  if (r.error && !r.hash) {
    if (queued?.status === "replaced") return draw(panel("Transaction", kv([
      ["Status", `<span class="tag bad">Replaced</span> <span class="dim">by a transaction with the same nonce and a higher gas price</span>`],
      ["Tx hash", full(hash)],
      ["Replaced by", txLink(queued.replacedBy, queued.replacedBy)],
    ])));
    if (queued?.status === "rejected") return draw(rejectedView(queued, hash));
    if (queued?.status === "pending") return draw(panel("Transaction", kv([
      ["Status", state("pending") + ' <span class="dim">waiting for the next block</span>'],
      ["Tx hash", full(hash)],
    ])));
    return draw(panel("Transaction not found", `<div class="empty">${esc(r.error)}</div>`));
  }
  // namespace of every address in the diagram (box labels read better as names)
  const names = {};
  const inTrace = [...new Set((r.trace ?? []).flatMap((c) => [c.program, c.from]).concat(r.from ?? []).map((a) => String(a).toLowerCase()))].slice(0, 30);
  const abis = {};   // metadata.abi of each program, to name the event fields
  await Promise.all(inTrace.map((a) => api(`/address/${a}?limit=1`).then((d) => {
    if (d.metadata?.namespace) names[a] = d.metadata.namespace;
    if (d.metadata?.abi) abis[a] = d.metadata.abi;
  }).catch(() => {})));
  draw(panel("Transaction", kv([
      ["Status", state(r.status) + (r.error ? ` <span class="bad">${esc(r.error.message ?? r.error)}</span>` : "")],
      ["Tx hash", full(r.hash)],
      r.digest && ["Signed hash", full(r.digest)],
      r.signature && ["Signature", full(r.signature)],
      ["Type", actionTag(r.action)],
      ["From", addr(r.from, r.from)],
      ["To", r.to ? addr(r.to, r.to) : '<span class="dim">—</span>'],
      r.method && ["Method", `<span class="mono">${esc(r.method)}</span>`],
      ["Value", `<span class="mono">${coin(r.value ?? 0)}</span>`],
      ["Nonce", r.nonce ?? "—"],
      ["Gas", `${gas(r.gasUsed)} <span class="dim">× ${r.gasPrice ? `${gwei(r.gasPrice)} gwei` : "min price"} = ${coin(r.fee)}</span>`],
      ...feeRows(r),
      ["Block", blockNo(r.blockNumber)],
      ["Time", when(r.timestamp)],
      ["Return value", r.status === "success" ? returnValue(r.result) : '<span class="dim">— (failed)</span>'],
    ]))
    + (r.input && Object.keys(r.input).length ? panel("Input", json(r.input), true) : "")
    + (r.trace?.length ? panel(`Program calls (${r.trace.length})`, traceView(r.trace, r.from, names)) : "")
    + (r.events?.length ? panel(`Events (${r.events.length})`, table(["Name", "Program", "Data"], r.events.map((e) =>
        `<tr><td><span class="tag">${esc(e.name)}</span></td><td>${addr(e.program)}</td>
         <td>${eventData(e, abis[String(e.program).toLowerCase()])}</td></tr>`))) : "")
    + (r.stateChanges?.length ? panel(`State changes (${r.stateChanges.length})`, table(["Program", "Key", "New value"], r.stateChanges.map((s) =>
        `<tr><td>${addr(s.program)}</td><td>${keyChips(s.key)}</td><td>${s.after === undefined ? '<span class="dim">Deleted</span>' : anyValue(s.after)}</td></tr>`))) : "")
    + (r.nativeChanges?.length ? panel(`Balance changes (${r.nativeChanges.length})`, balanceLines(r.nativeChanges)) : ""));
}

/** event data: fields named and typed from metadata.abi when declared · indexed fields (searchable) are marked */
function eventData(e, abi) {
  const declared = (abi?.events ?? []).find((x) => x.name === e.name);
  const indexed = new Set([...(e.indexed ?? []), ...(declared?.fields ?? []).filter((f) => f.indexed).map((f) => f.name)]);
  if (!declared && !indexed.size) return json(e.data);
  const data = e.data ?? {};
  const order = [...(declared?.fields ?? []).map((f) => f.name), ...Object.keys(data)].filter((k, i, all) => all.indexOf(k) === i && k in data);
  const typeOf = (k) => declared?.fields.find((f) => f.name === k)?.type;
  return `<div class="ev">${order.map((k) => `<div><span class="mono">${esc(k)}</span>${typeOf(k) ? ` <span class="dim">${esc(typeOf(k))}</span>` : ""}${
    indexed.has(k) ? ' <span class="tag" title="Indexed: searchable with /program/:address/events?name=…&amp;field=value and eth_getLogs topics">indexed</span>' : ""}
    ${typeOf(k) === "address" || /^0x[0-9a-fA-F]{40}$/.test(String(data[k])) ? addr(data[k]) : anyValue(data[k])}</div>`).join("")}</div>`;
}

/** metadata.abi as a short list: functions with their inputs, events with their fields */
function abiView(abi) {
  const params = (list) => (list ?? []).map((f) => `${f.indexed ? "indexed " : ""}${f.type}${f.name ? ` ${f.name}` : ""}`).join(", ");
  const fn = (f) => `<div class="mono">function ${esc(f.name)}(${esc(params(f.inputs))})${f.outputs?.length ? ` → (${esc(params(f.outputs))})` : ""}${
    f.readonly ? ' <span class="tag">read-only</span>' : f.payable ? ' <span class="tag">payable</span>' : ""}${f.description ? ` <span class="dim">${esc(f.description)}</span>` : ""}</div>`;
  const ev = (e) => `<div class="mono">event ${esc(e.name)}(${esc(params(e.fields))})${e.description ? ` <span class="dim">${esc(e.description)}</span>` : ""}</div>`;
  return `${(abi.functions ?? []).map(fn).join("")}${(abi.events ?? []).map(ev).join("")}
    <div class="dim" style="margin-top:8px">Ethereum JSON ABI: <span class="mono">GET /program/:address/abi</span> or <span class="mono">cardianal_getAbi</span> on /evm</div>`;
}

/** a program's return value, shown the same way everywhere (Interact result box and the tx page) */
const returnValue = (value) => (value === undefined || value === null
  ? `<span class="dim mono">${value === null ? "null" : "nothing returned"}</span>` : anyValue(value));

/** native counters (received / sent / gas) as one short line each: address · field · +change (new total) */
const NATIVE_LABEL = { received: "received", sended: "sent", consumed: "gas paid" };
function balanceLines(changes) {
  return `<div class="bal">${changes.map((n) => {
    const delta = n.before === undefined ? null : toBig(n.after) - toBig(n.before);
    const sign = n.field === "received" ? "+" : "−";   // received adds to the balance, sent / gas take from it
    return `<div class="bal-row">${addr(n.address)}<span class="dim">${esc(NATIVE_LABEL[n.field] ?? n.field)}</span>
      <span class="mono ${n.field === "received" ? "up" : "bad"}">${delta === null ? "" : `${sign}${coin(delta)}`}</span>
      <span class="dim mono" title="Running total of this counter">total ${coin(n.after)}</span></div>`;
  }).join("")}</div>`;
}
