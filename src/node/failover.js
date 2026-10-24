/**
 * ย้ายการผลิต block ไปเครื่องสำรองอย่างปลอดภัย (กรณีเครื่องหลักเสีย · key เดิม)
 *   เครื่องสำรอง: FOLLOW=<url เครื่องหลัก> → ซิงก์ตามตลอด ไม่ผลิต block ไม่รับ tx
 *   ย้ายไปผลิต: restart เครื่องสำรองด้วย PRODUCER_KEY + FAILOVER_FROM=<url เครื่องเดิม> (ไม่ตั้ง FOLLOW)
 *     → prepareFailover ถามเครื่องเดิมก่อนเริ่มผลิต
 *       ติดต่อได้ + ยังผลิตอยู่ (role "producer")  = ไม่ยอมเริ่ม (กันผู้ผลิต 2 เครื่องใช้ key เดียวกัน → เชนแยก)
 *       ติดต่อได้ + ไม่ผลิตแล้ว (ตั้งเป็น FOLLOW / key ถูกถอด) = ซิงก์ block ที่ยังขาดให้ครบก่อน แล้วผลิตต่อ
 *       ติดต่อไม่ได้ = เริ่มได้ + เตือน (ผู้ดูแลต้องแน่ใจเองว่าเครื่องเดิมดับจริง ไม่ใช่แค่เครือข่ายขาด)
 * ห้ามเปิดเครื่องเดิมเป็นผู้ผลิตอีก: ให้กลับมาเป็น FOLLOW=<url เครื่องใหม่> แทน
 */
import { syncOnce } from "./sync.js";

/** ถามสถานะของเครื่องเดิม → { reachable, role, latest, error } (ไม่ throw) */
export async function probeNode(url, { fetch = globalThis.fetch, timeoutMs = 3000 } = {}) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();   // /health ตอบ 503 พร้อม body เมื่อมีปัญหา — ยังถือว่าติดต่อได้
    return { reachable: true, role: body?.role ?? "producer", latest: body?.latest ?? null };   // ไม่บอก role = server รุ่นเก่า (ผลิตเสมอ)
  } catch (error) {
    return { reachable: false, role: null, latest: null, error: error.message };
  }
}

/**
 * ตรวจก่อนเริ่มผลิต → { reachable, synced, warning } · throw = ห้ามเริ่ม
 *   producers = รายชื่อ หรือ (เลข block) => รายชื่อ (ตรวจ block ที่ซิงก์มาแบบเดียวกับ startSync)
 */
export async function prepareFailover(vm, { url, producers = null, fetch = globalThis.fetch, timeoutMs = 3000, limit = 50 } = {}) {
  const probe = await probeNode(url, { fetch, timeoutMs });
  if (!probe.reachable) {
    return { reachable: false, synced: 0,
      warning: `ติดต่อเครื่องเดิม ${url} ไม่ได้ (${probe.error}) — เริ่มผลิตต่อจาก block ${vm.latestBlockNumber() ?? 0} · ต้องแน่ใจว่าเครื่องเดิมดับจริงและจะไม่กลับมาผลิตอีก` };
  }
  if (probe.role === "producer") {
    throw new Error(`เครื่องเดิม ${url} ยังผลิต block อยู่ (block ${probe.latest}) — หยุดเครื่องเดิม หรือเปลี่ยนเป็น FOLLOW ก่อน ไม่งั้นมีผู้ผลิต 2 เครื่อง`);
  }
  const fetchBlocks = async (from, count) => {
    const response = await fetch(`${url}/sync?from=${from}&limit=${count}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`sync จากเครื่องเดิมล้มเหลว: ${response.status}`);
    return response.json();
  };
  let synced = 0;
  for (let added = await syncOnce(vm, fetchBlocks, { limit, producers }); added > 0; added = await syncOnce(vm, fetchBlocks, { limit, producers })) {
    synced += added;
  }
  const latest = vm.latestBlockNumber() ?? 0;
  if (probe.latest !== null && latest < probe.latest) throw new Error(`ซิงก์จากเครื่องเดิมไม่ครบ (มี ${latest} / เครื่องเดิม ${probe.latest})`);
  return { reachable: true, synced };
}
