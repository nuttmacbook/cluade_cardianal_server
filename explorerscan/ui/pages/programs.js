/* explorerscan/ui/pages/programs.js [แก้ได้ · หน้าตา]
   หน้ารายชื่อโปรแกรม (#programs): อนุมัติแล้ว / รออนุมัติ */

// ---------- programs: approved / awaiting approval ----------
const openPrograms = (id) => { tabState["#programs"] = id; go("#programs"); };
// type of program: standard token / NFT collection (ERC-721) / multi-token (ERC-1155) / anything else
const kindTag = (token, collection) => `<span class="tag">${token ? "Token" : collection === "ERC-721" ? "NFT" : collection ? "Multi-token" : "Program"}</span>`;
const bytes = (n) => `${num(n ?? 0)} B`;
async function programs(draw = el) {
  const [counts, pending, approved] = await Promise.all([
    api("/programs"), paged("/programs/pending", "pending"), paged("/programs/approved", "approved"),
  ]);
  const empty = (text) => `<div class="empty">${text}</div>`;
  draw(tabs([
    { id: "pending", label: "Awaiting approval", count: counts.pending, body: pending.total
      ? `<div class="pad">${walletRow("Approving or rejecting needs an admin wallet (any wallet when the chain has no admin list)")}</div>`
        + table(["Program", "Name", "Type", "Deployer", "Value", "Code size", "Review"], pending.items.map((p) => txRow(p, [
          addr(p.address), p.name ? esc(p.name) : '<span class="dim">—</span>', kindTag(p.token, p.collection), addr(p.deployer), coin(p.value), bytes(p.codeSize),
          `<span class="row"><button class="btn sm solid" data-review="init" onclick="reviewProgram('${p.address}','init')">Approve</button>
           <button class="btn sm" data-review="reject" onclick="reviewProgram('${p.address}','reject')">Reject</button></span>`,
        ]))) + pager(pending, "setPage('pending',$)") + '<div class="pad"><div class="out" id="review-out">Nothing sent yet</div></div>'
      : empty("No programs are waiting for approval") },
    { id: "approved", label: "Approved", count: counts.approved, body: approved.total
      ? table(["Program", "Name", "Type", "Creator", "Approved", "Code size"], approved.items.map((p) => txRow(p, [
          addr(p.address), p.name ? esc(p.name) : '<span class="dim">—</span>', kindTag(p.token, p.collection), addr(p.creator), age(p.createdAt), bytes(p.codeSize),
        ]))) + pager(approved, "setPage('approved',$)")
      : empty("No approved programs yet") },
  ]));
}
