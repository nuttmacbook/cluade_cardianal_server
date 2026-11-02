/* explorerscan/ui/pages/system.js [แก้ได้ · หน้าตา]
   หน้าโปรแกรมกลางของเชน (#system): รายชื่อจาก EXPLORER.systemPrograms (config.js) → หา address จากชื่อด้วย /name/<ชื่อ> */

// ---------- system programs: multicall · wrapped coin · factory · templates ----------
async function systemPage(draw = el) {
  const list = EXPLORER.systemPrograms ?? [];
  const found = await Promise.all(list.map((p) => api(`/name/${encodeURIComponent(p.name)}`).catch(() => ({}))));
  const rows = list.map((p, i) => `<tr>${[
    `<b>${esc(p.title)}</b><div class="dim">${esc(p.name)}</div>`,
    found[i]?.address ? addr(found[i].address) : '<span class="dim">Not deployed yet</span>',
    esc(p.about),
  ].map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
  const missing = found.filter((f) => !f?.address).length;
  draw(panel("System programs", `${table(["Program", "Address", "What it does"], rows)}
    <div class="pad hint">${missing === list.length
      ? "None deployed on this chain yet · the operator runs <code>scripts/deploy-system.js</code> once"
      : "Open a program → Interact to use it · e.g. Factory → <code>createToken</code> makes your own token right away"}</div>`));
}
