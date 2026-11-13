/**
 * The client's IP for rate limiting
 *
 *   TRUST_PROXY=0   (default) use the socket IP directly — the server receives requests from users itself
 *   TRUST_PROXY=1   one reverse proxy (nginx / Caddy) in front → use the IP the proxy appends to X-Forwarded-For
 *   TRUST_PROXY=N   N proxy hops (e.g. CDN + nginx = 2)
 *
 * Not set while behind a proxy = everyone gets the proxy's IP → the whole network shares one quota
 * Counted from the right: users can only forge the left part that the proxy didn't append
 *   nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   Caddy: reverse_proxy appends it itself
 * ⚠️ Setting TRUST_PROXY > 0 without a proxy = users can spoof their IP (expose the server port only to the proxy)
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
