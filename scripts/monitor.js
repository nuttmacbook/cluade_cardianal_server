/**
 * Watch a node via GET /health and alert on problems (chain stalled / block seal failing / disk nearly full / unreachable)
 *
 *   npm run monitor -- --url http://localhost:3000
 *   npm run monitor -- --url http://localhost:3000 --interval 15 --webhook https://hooks.example.com/xyz
 *   npm run monitor -- --url http://localhost:3000 --once      # check once: exit 0 = healthy · 1 = problems (for cron)
 *
 *   --url <url>          node to watch (default http://localhost:3000)
 *   --interval <seconds>   how often (default 30)
 *   --webhook <url>      POST { text, url, problems, health } when the status changes (healthy → problems / recovered) — Slack / Discord / LINE Notify via a relay
 *   --once               check once and exit
 *
 * Alerts only when the status changes (no repeat every round) · problem messages come from the server's /health (see health() in server.js)
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

/** fetch /health → { ok, problems, health } (unreachable = a problem) */
export async function check(url = URL_BASE, { timeoutMs = 10_000 } = {}) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const health = await response.json();
    const problems = health.problems ?? (response.ok ? [] : [`HTTP ${response.status}`]);
    return { ok: response.ok && problems.length === 0, problems, health };
  } catch (error) {
    return { ok: false, problems: [`unreachable: cannot reach ${url} (${error.message})`], health: null };
  }
}

async function notify(text, result) {
  console.log(`[${new Date().toISOString()}] ${text}`);
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, url: URL_BASE, problems: result.problems, health: result.health }) });
  } catch (error) {
    console.error(`failed to send webhook: ${error.message}`);
  }
}

const summary = (result) => result.health
  ? `block ${result.health.latest ?? "-"} · age ${result.health.blockAgeMs === null ? "-" : Math.round(result.health.blockAgeMs / 1000)} s · ${result.health.pending} tx pending`
  + (result.health.db ? ` · LMDB ${result.health.db.usedPercent}%` : "")
  : "";

if (process.argv[1]?.endsWith("monitor.js")) {
  if (ONCE) {
    const result = await check();
    console.log(result.ok ? `healthy · ${summary(result)}` : `problems:\n${result.problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(result.ok ? 0 : 1);
  }
  let previous = null;
  const tick = async () => {
    const result = await check();
    const key = result.ok ? "ok" : result.problems.join("|");
    if (key !== previous) {
      if (result.ok) await notify(previous === null ? `started watching ${URL_BASE}: healthy · ${summary(result)}` : `${URL_BASE} recovered · ${summary(result)}`, result);
      else await notify(`⚠️ ${URL_BASE} has problems:\n${result.problems.map((p) => `- ${p}`).join("\n")}`, result);
      previous = key;
    }
  };
  await tick();
  setInterval(tick, INTERVAL_MS);
}
