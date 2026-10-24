/**
 * IP ของผู้ใช้สำหรับ rate limit
 *
 *   TRUST_PROXY=0   (ค่าเริ่ม) ใช้ IP ของ socket ตรง ๆ — server รับ request จากผู้ใช้เอง
 *   TRUST_PROXY=1   มี reverse proxy (nginx / Caddy) 1 ชั้นข้างหน้า → ใช้ IP ที่ proxy เติมท้าย X-Forwarded-For
 *   TRUST_PROXY=N   proxy N ชั้น (เช่น CDN + nginx = 2)
 *
 * ไม่ตั้งทั้งที่อยู่หลัง proxy = ทุกคนได้ IP ของ proxy → ใช้โควตาร่วมกันทั้งเครือข่าย
 * นับจากขวา: ผู้ใช้ปลอม X-Forwarded-For ได้แค่ส่วนซ้ายที่ proxy ไม่ได้เติม
 *   nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   Caddy: reverse_proxy เติมให้เอง
 * ⚠️ ตั้ง TRUST_PROXY > 0 ทั้งที่ไม่มี proxy = ผู้ใช้ปลอม IP ได้ (เปิด port ของ server ให้เฉพาะ proxy)
 */
export const TRUST_PROXY = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY ?? 0) || 0));

export function clientIp(request, trustProxy = TRUST_PROXY) {
  const socketIp = request.socket?.remoteAddress ?? "unknown";
  if (trustProxy === 0) return socketIp;
  const header = request.headers?.["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : String(header ?? ""))
    .split(",").map((part) => part.trim()).filter(Boolean);
  const chain = [...forwarded, socketIp];
  return chain[Math.max(0, chain.length - 1 - trustProxy)];
}
