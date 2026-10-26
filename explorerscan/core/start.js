/* explorerscan/core/start.js [ระบบ · ไม่ต้องแก้]
   เริ่มทำงาน: วาดหน้าแรก, ฟังการเปลี่ยน hash, ถามสถานะเชนทุก EXPLORER.pollMs · โหลดเป็นไฟล์สุดท้ายเสมอ */

addEventListener("keydown", (e) => { if (e.key === "Escape") sideClose(); });
sidePrograms();

addEventListener("hashchange", () => render());
render();
setInterval(async () => {
  const info = await api("/genesis").catch(() => null);
  if (!info) return;
  document.getElementById("tick").textContent = `block ${info.latest ?? 0} · ${info.pending} pending`;
  document.getElementById("side-latest").textContent = `#${info.latest ?? 0}`;
  if (++sideInfo.polls % 10 === 0) sidePrograms();
  document.getElementById("wbtn").textContent = wallet ? cut(wallet) : "Connect wallet";
  // refresh the home page only while it shows the newest blocks and nothing is being typed
  if (!location.hash && pageOf("blocks") === 1 && !document.activeElement?.matches("#view input")) { const seq = renderSeq; home((html) => { if (seq === renderSeq && !location.hash) el(html); }); }
}, EXPLORER.pollMs);   // blocks every 1 s: poll every 2 s by default (each open tab hits /genesis + the home page)
