/* explorerscan/core/format.js [ระบบ · ไม่ต้องแก้]
   แปลงค่าจากเชนเป็นข้อความ: escape HTML, เลข BigInt "123n", หน่วยเหรียญ (wei ↔ CARD), เวลา, ตรวจ address / URL
   ไม่มี HTML ของหน้าตาในไฟล์นี้ · ถ้าอยากเปลี่ยนรูปแบบวันที่ / ตัวเลข แก้ when / ago / num ได้ */

const esc = (v) => String(v ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const attr = (v) => esc(v).replace(/"/g, "&quot;").replace(/'/g, "&#39;");   // attribute values (storage keys come from programs)
/** shortened form wherever space is tight: 0x1234…abcd (4 characters each side) */
const cut = (v) => (typeof v !== "string" ? v ?? "—"
  : /^0x[0-9a-f]{9,}$/i.test(v) ? `${v.slice(0, 6)}…${v.slice(-4)}`
  : v.length > 20 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v);
const num = (v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)).toLocaleString("en-US")
  : typeof v === "number" ? v.toLocaleString("en-US") : v ?? "—");
const when = (t) => (t ? new Date(t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" }) : "—");
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${s | 0} sec ago` : s < 3600 ? `${s / 60 | 0} min ago` : s < 86400 ? `${s / 3600 | 0} hr ago` : `${s / 86400 | 0} days ago`; };
/** full date-time in UTC, small, under a relative age · seconds hidden on narrow screens (.sec) */
const utc = (t) => { if (!t) return "";
  const [date, time] = new Date(t).toISOString().split("T");
  return `<small class="utc">${date} ${time.slice(0, 5)}<span class="sec">${time.slice(5, 8)}</span> UTC</small>`; };
const age = (t) => (t ? `<span class="age">${ago(t)}${utc(t)}</span>` : "—");
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

const isAddress = (v) => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
const toBig = (raw) => { try { return BigInt(String(raw ?? "0").replace(/n$/, "") || "0"); } catch { return 0n; } };
/** token amount: smallest unit "1500000n" + decimals 6 → "1.5" */
function units(raw, decimals) {
  const value = toBig(raw);
  const d = Number(String(decimals ?? "0").replace(/n$/, "")) || 0;
  if (!d) return value.toLocaleString("en-US");
  const base = 10n ** BigInt(d), sign = value < 0n ? "-" : "", abs = value < 0n ? -value : value;
  const frac = (abs % base).toString().padStart(d, "0").replace(/0+$/, "");
  return `${sign}${(abs / base).toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}
/** native coin: wei (18 decimals, like ETH) → "1.5" */
const NATIVE_DECIMALS = 18;
const coin = (raw) => `${units(raw, NATIVE_DECIMALS)}`;
/** typed amount in coins ("1.5") → wei as a decimal string (no floating point) */
function toWei(text) {
  const t = String(text ?? "").trim() || "0";
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("Attached value must be a number of coins, e.g. 0.5");
  const [whole, frac = ""] = t.split(".");
  if (frac.length > NATIVE_DECIMALS) throw new Error(`Attached value: at most ${NATIVE_DECIMALS} decimals`);
  return (BigInt(whole) * 10n ** BigInt(NATIVE_DECIMALS) + BigInt(frac.padEnd(NATIVE_DECIMALS, "0") || "0")).toString();
}
/** gas price in wei → gwei text */
const gwei = (raw) => units(raw, 9);
/** safe external link: http(s) / mailto / tel · a bare email becomes mailto: · anything else is not a link */
function safeHref(value) {
  const v = String(value ?? "").trim();
  if (/^https?:\/\/[^\s]+$/i.test(v) || /^(mailto|tel):[^\s]+$/i.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  return null;
}
const isImage = (v) => typeof v === "string" && (/^https?:\/\/\S+$/i.test(v) || /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(v));
