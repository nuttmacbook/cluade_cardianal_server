/* explorerscan/core/router.js [ระบบ · ไม่ต้องแก้]
   เปลี่ยนหน้า: go() / render() อ่าน location.hash (#block/… #tx/… #address/… #programs #deploy) แล้วเรียกหน้าใน ui/pages/
   + ช่องค้นหา · เพิ่มหน้าใหม่ = เพิ่มไฟล์ใน ui/pages/ แล้วเพิ่มบรรทัดใน render() */

const go = (hash) => { location.hash = hash; render(); };
async function search() {
  const value = document.getElementById("q").value.trim();
  if (!value) return;
  if (/^\d+$/.test(value)) return go(`#block/${value}`);
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return go(`#tx/${value}`);
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return go(`#address/${value}`);
  const found = await api(`/name/${encodeURIComponent(value)}`);
  if (found.address) return go(`#address/${found.address}`);
  el(panel("Nothing found", `<div class="empty">Nothing matches "${esc(value)}" — try a block number, tx hash, address or name</div>`));
}

/** soft = redraw in place (page / tab change) without the loading placeholder, keeping the scroll position */
let renderSeq = 0;
async function render(soft) {
  const [kind, value] = location.hash.slice(1).split("/");
  const y = scrollY;
  const seq = ++renderSeq;
  markNav();
  // only the newest render may draw: a slower earlier one (another page / tab / page number) is dropped
  const draw = (html) => { if (seq === renderSeq) el(html); };
  if (!soft) document.getElementById("view").innerHTML = '<div class="panel"><div class="empty">Loading…</div></div>';
  if (kind === "block") await block(value, draw);
  else if (kind === "tx") await tx(value, draw);
  else if (kind === "address") await address(value, draw);
  else if (kind === "programs") await programs(draw);
  else if (kind === "deploy") deployPage(draw);
  else await home(draw);
  if (soft && seq === renderSeq) scrollTo(0, y);
}
