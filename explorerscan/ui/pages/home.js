/* explorerscan/ui/pages/home.js [แก้ได้ · หน้าตา]
   หน้าแรก (#): ตัวเลขภาพรวม + รายการ block ล่าสุด */

// ---------- home ----------
async function home(draw = el) {
  const [info, blocks, pending, programs] = await Promise.all([api("/genesis"), paged("/blocks/page", "blocks", 15), api("/pending"),
    api("/programs").catch(() => ({ approved: 0, pending: 0 }))]);
  draw(panel("Overview", `<div class="stats">
      <div class="stat"><b>${num(info.latest ?? 0)}</b><span>Latest block</span></div>
      <div class="stat"><b>${num(pending.size)}</b><span>Pending txs</span></div>
      <a class="stat" data-programs="approved" onclick="openPrograms('approved')"><b>${num(programs.approved)}</b><span>Approved programs</span></a>
      <a class="stat" data-programs="pending" onclick="openPrograms('pending')"><b>${num(programs.pending)}</b><span>Awaiting approval</span></a>
      <div class="stat"><b>${coin(info.burned)}</b><span>Burned coins</span></div>
      <div class="stat"><b>${info.chainId}</b><span>Chain ID</span></div></div>`)
    + panel("Latest blocks", table(["Block", "Age", "Txs", "Result", "Gas", "Fee recipient"], blocks.items.map((b) => txRow(b, [
        blockNo(b.number),
        `<span title="${when(b.timestamp)}">${age(b.timestamp)}</span>`,
        num(b.txCount),
        (b.txCount ? `<span class="tag ${b.failedCount ? "bad" : "ok"}">${b.successCount}/${b.txCount}</span>` : "")
          + (b.rejectedCount ? ` <span class="tag bad" title="Rejected: recorded only, never ran">Rejected ${num(b.rejectedCount)}</span>` : "")
          || '<span class="dim">Empty</span>',
        gas(b.gasUsed), addr(b.feeRecipient),
      ]))) + pager(blocks, "setPage('blocks',$)"))
    + (pending.size ? panel("Pending", table(["Hash", "Sender", "Type", "Nonce"], pending.transactions.slice(0, 50).map((t) =>
        txRow(t, [plain(t.hash), addr(t.sender), actionTag(t.action), t.nonce])))) : ""));
}
