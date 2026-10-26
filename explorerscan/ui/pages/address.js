/* explorerscan/ui/pages/address.js [แก้ได้ · หน้าตา]
   หน้า address / โปรแกรม (#address/<address>): ข้อมูลหลัก + แท็บ (เนื้อหาแท็บอยู่ใน ui/tabs/) · ปุ่มอนุมัติของ admin */

// ---------- address / program ----------
/** token URI of an NFT: http(s) → link · ipfs:// and others → text (never a script link) */
function nftUri(uri) {
  if (!uri) return '<span class="dim">—</span>';
  const href = /^https?:\/\//i.test(uri) ? safeHref(uri) : null;
  return href ? `<a class="mono" href="${attr(href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(cut(uri))} ↗</a>`
    : `<span class="mono" title="${attr(uri)}">${esc(cut(uri))}</span>`;
}
async function address(value, draw = el) {
  const [data, tokens, nfts] = await Promise.all([api(`/address/${value}?limit=1`), api(`/address/${value}/tokens`).catch(() => []),
    api(`/address/${value}/nfts`).catch(() => [])]);
  const program = data.isProgram ? await api(`/program/${value}?limit=1`) : null;
  // programs: calls and events page by cursor (no counting cap) · the tab counts come from one cheap counted request
  const [incoming, outgoing, events, holders, , rejected, callCount, eventCount] = await Promise.all([
    program ? cursored(`/program/${value}/interactions`, "in") : paged(`/address/${value}/incoming`, "in"),
    paged(`/address/${value}/txs`, "out"),
    program ? cursored(`/program/${value}/events`, "events") : null,
    program?.token ? paged(`/token/${value}/holders`, "holders", 25) : null,
    program ? loadLayout(program.address) : null,
    cursored(`/address/${value}/rejected`, "rej"),
    program ? api(`/address/${value}/incoming?limit=1`).catch(() => null) : null,
    program ? api(`/program/${value}/events?limit=1`).catch(() => null) : null,
  ]);
  const countOf = (res) => (res ? `${num(res.total)}${res.truncated ? "+" : ""}` : undefined);

  // Status = the whole tx (same as the tx page) · a nested call that failed inside a successful tx says so beside it
  const callState = (t) => {
    const tx = t.txStatus ?? t.status;
    const call = t.depth && t.status !== "success" && tx === "success"
      ? ` <span class="warn" title="This call into the program failed, but a program above caught the error, so the transaction still succeeded">⚠ caught</span>` : "";
    return state(tx) + call;
  };
  const inRows = incoming.items.map((t) => `<tr><td>${txLink(t.hash)}</td><td>${addr(t.from)}${
      t.depth ? ` <span class="tag" title="Called through another program">Nested · depth ${t.depth}</span>` : ""}</td><td>${actionTag(t.action)}</td>
    <td class="mono">${t.method ? esc(t.method) : "—"}</td><td>${callState(t)}</td>
    <td>${blockNo(t.blockNumber)}</td>
    <td class="dim" title="${when(t.timestamp)}">${age(t.timestamp)}</td></tr>`);
  const outRows = outgoing.items.map((t) => `<tr><td>${txLink(t.hash)}</td><td>${actionTag(t.action)}</td>
    <td>${t.nonce}</td><td>${state(t.status)}</td><td>${gas(t.gasUsed)}</td>
    <td class="dim" title="${when(t.timestamp)}">${age(t.timestamp)}</td></tr>`);

  // tokens held: found from Transfer events sent to this address · zero balances hidden
  const held = slicePage(tokens, pageOf("tokens"));
  const tokenRows = held.items.map((t) => `<tr><td><span class="ico coin"></span><b>${esc(t.ticker)}</b></td>
    <td>${addr(t.address, t.name)}</td><td class="mono" style="text-align:right">${units(t.balance, t.decimals)}</td>
    <td class="dim">${num(t.decimals)}</td></tr>`);
  // NFTs held (ERC-721 pieces / ERC-1155 balances): collections found from transfer events · zero balances hidden
  const nftPage = slicePage(nfts, pageOf("nfts"));
  const nftRows = nftPage.items.map((n) => `<tr><td>${addr(n.program, n.name || n.symbol)}</td><td><span class="tag">${esc(n.standard)}</span></td>
    <td class="mono">#${num(n.tokenId)}</td><td class="mono" style="text-align:right">${num(n.amount)}</td><td>${nftUri(n.uri)}</td></tr>`);
  const groups = [
    ...(tokens.length ? [{ id: "tokens", label: "Tokens", count: tokens.length,
      body: table(["Token", "Program", "Balance", "Decimals"], tokenRows) + pager(held, "setPage('tokens',$)") }] : []),
    ...(nfts.length ? [{ id: "nfts", label: "NFTs", count: nfts.length,
      body: table(["Collection", "Standard", "Token ID", "Amount", "URI"], nftRows) + pager(nftPage, "setPage('nfts',$)") }] : []),
  ];
  if (holders) {
    const supply = toBig(program.token.totalSupply);
    const holderRows = holders.items.map((h, i) => {
      const share = supply > 0n ? Number((toBig(h.balance) * 1_000_000n) / supply) / 10_000 : 0;
      return `<tr><td class="dim">${num((holders.page - 1) * holders.limit + i + 1)}</td><td>${addr(h.address)}</td>
        <td class="mono" style="text-align:right">${units(h.balance, program.token.decimals)}</td>
        <td class="mono"><span class="share" style="width:${Math.max(2, Math.min(60, share * 0.6))}px"></span>${share.toFixed(4)}%</td></tr>`;
    });
    groups.push({ id: "holders", label: "Holders", count: holders.total,
      body: table(["Rank", "Address", "Balance", "Share"], holderRows) + pager(holders, "setPage('holders',$)") });
  }
  groups.push(
    { id: "in", label: program ? "Calls" : "Incoming", count: program ? countOf(callCount) : incoming.total,
      body: table(["Hash", "From", "Type", "Method", "Status", "Block", "Age"], inRows) + (program ? cursorPager(incoming, "in") : pager(incoming, "setPage('in',$)")) },
    { id: "out", label: "Outgoing", count: outgoing.total,
      body: table(["Hash", "Type", "Nonce", "Status", "Gas", "Age"], outRows) + pager(outgoing, "setPage('out',$)") },
  );
  // txs this address sent that were turned away (recorded in blocks, never ran)
  if (rejected.items.length || rejected.pageNo > 1) {
    groups.push({ id: "rejected", label: "Rejected", body: table(["Hash", "Type", "Nonce", "Stage", "Reason", "Block", "Age"], rejected.items.map((r) => txRow(r, [
      txLink(r.hash), actionTag(r.action), r.nonce ?? "—", stageTag(r.stage), `<span class="bad">${esc(r.reason)}</span>`, blockNo(r.blockNumber),
      `<span class="dim" title="${when(r.timestamp)}">${age(r.timestamp)}</span>`]))) + cursorPager(rejected, "rej") });
  }
  if (program) {
    groups.push({ id: "code", label: "Code", pad: true, body: `<pre>${esc(JSON.parse('"' + program.code + '"'))}</pre>` });
    const abi = data.metadata?.abi ?? null;
    groups.push({ id: "interact", label: "Interact", body: interactPanel(program, abi) });
    groups.push({ id: "event", label: "Events", count: countOf(eventCount),
      body: table(["Name", "Data", "Tx", "Block"], events.items.map((e) =>
        `<tr><td><span class="tag">${esc(e.name)}</span></td><td>${eventData(e, abi)}</td>
         <td>${txLink(e.txHash)}</td><td>${blockNo(e.blockNumber)}</td></tr>`)) + cursorPager(events, "events") });
    if (abi) groups.push({ id: "abi", label: "ABI", pad: true, body: abiView(abi) });
    groups.push({ id: "storage", label: "Storage", count: storageView.layout?.scanned, body: storagePanel() });
    groups.push({ id: "upgrade", label: "Upgrade", body: upgradePanel(program, data.metadata ?? {}) });
    if (hasEip712Permit(program)) groups.push({ id: "permit", label: "Permit", body: permitPanel(program) });
  } else {
    // a wallet sets its own metadata (signed by that wallet) · a program's metadata comes from its code (setMetadata)
    groups.push({ id: "meta", label: "Edit metadata", body: metaPanel(data) });
  }

  const meta = data.metadata ?? {};
  draw(panel(data.isProgram ? "Program" : "Address", kv([
      ["Address", `<span class="mono full">${icon(data.address, true)}${esc(data.address)}</span>${copy(data.address)}`],
      ["Information", `<div class="info" id="meta-info">${avatar(meta)}${meta.namespace ? `<span class="tag">${esc(meta.namespace)}</span>` : '<span class="dim">No name set</span>'}</div>`],
      meta.description && ["Description", esc(meta.description)],
      (meta.url || meta.contact) && ["Links", `<div class="links">${meta.url ? extLink("url", meta.url) : ""}${meta.contact ? extLink("contact", meta.contact) : ""}</div>`],
      ["Balance", `<b>${coin(data.native.balance)}</b>`],
      ["Received / sent / gas paid", `${coin(data.native.received)} · ${coin(data.native.sended)} · ${coin(data.native.consumed)}`],
      ["Nonce", data.nonce],
      program?.token && ["Token", `<span class="ico coin"></span><b>${esc(program.token.name)}</b> <span class="tag">${esc(program.token.ticker)}</span>
        <span class="dim">· ${num(program.token.decimals)} decimals · supply ${units(program.token.totalSupply, program.token.decimals)}</span>`],
      program?.collection && ["Collection", `<b>${esc(program.collection.name || "—")}</b>${program.collection.symbol ? ` <span class="tag">${esc(program.collection.symbol)}</span>` : ""}
        <span class="dim">· ${esc(program.collection.standard)}${program.collection.totalSupply ? ` · ${num(program.collection.totalSupply)} minted` : ""}</span>`],
      program && ["Creator", addr(data.metadata.creator)],
      program && ["Created", when(data.metadata.createdAt)],
      // upgrade / clone: version (no metadata = 1), who may upgrade (none = immutable), template it was cloned from
      program && ["Version", `${esc(meta.version ?? 1)}${program.pendingUpgrade ? ' <span class="tag">Upgrade pending review</span>' : ""}${
        program.scheduledUpgrade ? ` <span class="tag">Upgrade active from block ${esc(program.scheduledUpgrade.activateAt)}</span>` : ""}`],
      program && ["Upgrader", meta.upgrader ? addr(meta.upgrader) : '<span class="dim">None (immutable)</span>'],
      program && meta.template && ["Template", addr(meta.template)],
    ])) + tabs(groups));
}

// ---------- review a deployed program (admin: init / reject) ----------
async function reviewProgram(address, action) {
  const done = await signedAction("review-out", action === "init" ? "Approve program" : "Reject program", { action, to: address });
  if (done) { await render(true); writeOut("review-out", `<span class="tag ok">✓ Success</span> ${action === "init" ? "Approved" : "Rejected"} ${addr(address)}`); decorate(); }
}
