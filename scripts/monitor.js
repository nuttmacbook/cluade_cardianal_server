/**
 * เฝ้า node ผ่าน GET /health แล้วเตือนเมื่อมีปัญหา (เชนหยุด / ปิด block ล้มเหลว / พื้นที่ใกล้เต็ม / ติดต่อไม่ได้)
 *
 *   npm run monitor -- --url http://localhost:3000
 *   npm run monitor -- --url http://localhost:3000 --interval 15 --webhook https://hooks.example.com/xyz
 *   npm run monitor -- --url http://localhost:3000 --once      # เช็คครั้งเดียว: exit 0 = ปกติ · 1 = มีปัญหา (ใช้กับ cron)
 *
 *   --url <url>          node ที่เฝ้า (ค่าเริ่ม http://localhost:3000)
 *   --interval <วินาที>   ความถี่ (ค่าเริ่ม 30)
 *   --webhook <url>      POST { text, url, problems, health } เมื่อสถานะเปลี่ยน (ปกติ → มีปัญหา / หายแล้ว) — Slack / Discord / LINE Notify ผ่านตัวกลาง
 *   --once               เช็คครั้งเดียวแล้วจบ
 *
 * เตือนเฉพาะตอนสถานะเปลี่ยน (ไม่ยิงซ้ำทุกรอบ) · ข้อความปัญหามาจาก /health ของ server (ดู health() ใน server.js)
 */
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const URL_BASE = option("url", "http://localhost:3000").replace(/\/$/, "");
const INTERVAL_MS = Number(option("interval", 30)) * 1000;
const WEBHOOK = option("webhook", null);
const ONCE = args.includes("--once");

/** ดึง /health → { ok, problems, health } (ติดต่อไม่ได้ = ปัญหา) */
export async function check(url = URL_BASE, { timeoutMs = 10_000 } = {}) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const health = await response.json();
    const problems = health.problems ?? (response.ok ? [] : [`HTTP ${response.status}`]);
    return { ok: response.ok && problems.length === 0, problems, health };
  } catch (error) {
    return { ok: false, problems: [`unreachable: ติดต่อ ${url} ไม่ได้ (${error.message})`], health: null };
  }
}

async function notify(text, result) {
  console.log(`[${new Date().toISOString()}] ${text}`);
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, url: URL_BASE, problems: result.problems, health: result.health }) });
  } catch (error) {
    console.error(`ส่ง webhook ไม่สำเร็จ: ${error.message}`);
  }
}

const summary = (result) => result.health
  ? `block ${result.health.latest ?? "-"} · อายุ ${result.health.blockAgeMs === null ? "-" : Math.round(result.health.blockAgeMs / 1000)} วิ · รอ ${result.health.pending} tx`
  + (result.health.db ? ` · LMDB ${result.health.db.usedPercent}%` : "")
  : "";

if (process.argv[1]?.endsWith("monitor.js")) {
  if (ONCE) {
    const result = await check();
    console.log(result.ok ? `ปกติ · ${summary(result)}` : `มีปัญหา:\n${result.problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(result.ok ? 0 : 1);
  }
  let previous = null;
  const tick = async () => {
    const result = await check();
    const key = result.ok ? "ok" : result.problems.join("|");
    if (key !== previous) {
      if (result.ok) await notify(previous === null ? `เริ่มเฝ้า ${URL_BASE}: ปกติ · ${summary(result)}` : `${URL_BASE} กลับมาปกติ · ${summary(result)}`, result);
      else await notify(`⚠️ ${URL_BASE} มีปัญหา:\n${result.problems.map((p) => `- ${p}`).join("\n")}`, result);
      previous = key;
    }
  };
  await tick();
  setInterval(tick, INTERVAL_MS);
}
