/* explorerscan/ui/sidebar.js [แก้ได้ · หน้าตา]
   เมนูข้าง: ไฮไลต์หน้าที่เปิดอยู่ + รายชื่อโปรแกรมล่าสุด (สีจุดจาก EXPLORER.sideColors) · เมนูคงที่อยู่ใน index.html */

// ---------- sidebar (drawer on narrow screens) + highlighted section ----------
const sideInfo = { polls: 0 };
const sideOpen = (open) => document.body.classList.toggle("side-open", open);
const sideMenu = () => sideOpen(!document.body.classList.contains("side-open"));
const sideClose = () => sideOpen(false);
const sideGo = (hash) => { sideClose(); go(hash); };
function markNav() {
  const [kind, value] = location.hash.slice(1).split("/");
  const on = new Set(!kind ? ["explore", "home"] : kind === "programs" ? ["programs", `programs-${tabState["#programs"] ?? "pending"}`]
    : kind === "deploy" ? ["deploy"] : ["explore"]);
  if (kind === "block") on.add("block");
  if (kind === "address" && value) { on.add(`a:${value.toLowerCase()}`); if (wallet && value.toLowerCase() === wallet) on.add("me"); }
  for (const node of document.querySelectorAll("[data-nav]")) node.classList.toggle("on", on.has(node.dataset.nav));
  document.getElementById("dbtn").classList.toggle("on", kind === "deploy");
}
async function sidePrograms() {
  const [counts, list, info] = await Promise.all([api("/programs"), api("/programs/approved?limit=8"), api("/genesis")]).catch(() => []);
  if (!counts || !list) return;
  document.getElementById("side-latest").textContent = `#${info?.latest ?? 0}`;
  document.getElementById("side-approved").textContent = num(counts.approved ?? 0);
  document.getElementById("side-review").textContent = num(counts.pending ?? 0);
  document.getElementById("side-programs").innerHTML = (list.items ?? []).map((p, i) => {
    const label = p.name || cut(p.address);
    const kind = p.token ? "TOKEN" : p.collection === "ERC-721" ? "NFT" : p.collection ? "MULTI" : "";
    return `<a data-nav="a:${attr(String(p.address).toLowerCase())}" onclick="sideGo('#address/${attr(p.address)}')" title="${attr(p.address)}"><span class="dot" style="--c:${EXPLORER.sideColors[i % EXPLORER.sideColors.length]}">${esc(String(label).replace(/^0x/, "").slice(0, 1).toUpperCase())}</span><span>${esc(label)}</span>${kind ? `<span class="n">${kind}</span>` : ""}</a>`;
  }).join("") || '<div class="hint">No approved programs yet</div>';
  markNav();
}
