#!/usr/bin/env bash
# ตรวจเชนที่เปิดแล้วจากข้างนอก (ผ่าน HTTPS) · ./deploy/check.sh https://chain.example.com [chainId]
set -uo pipefail
URL="${1:?ใส่ URL เช่น https://chain.example.com}"; WANT="${2:-}"; FAIL=0
ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; FAIL=1; }

health="$(curl -fsS "$URL/health")" || bad "/health เปิดไม่ได้"
[[ -n "${health:-}" ]] && { echo "$health" | grep -q '"ok":true' && ok "/health ok" || bad "/health: $(echo "$health" | head -c 300)"; }
genesis="$(curl -fsS "$URL/genesis")" || bad "/genesis เปิดไม่ได้"
[[ -n "${genesis:-}" ]] && echo "     genesis hash $(echo "$genesis" | sed -n 's/.*"hash":"\([^"]*\)".*/\1/p')"
id="$(curl -fsS -X POST "$URL/evm" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')"
if [[ -z "$id" ]]; then bad "/evm eth_chainId ไม่ตอบ"; elif [[ -n "$WANT" && $((id)) -ne $WANT ]]; then bad "chainId $((id)) ไม่ใช่ $WANT"; else ok "/evm chainId $((id))"; fi
curl -fsS -o /dev/null "$URL/evm/explorer" && ok "explorer เปิดได้" || bad "explorer เปิดไม่ได้"
rpcurl="$(curl -fsS "$URL/evm" | sed -n 's/.*"rpcUrls":\["\([^"]*\)".*/\1/p')"
[[ "$rpcurl" == https://* ]] && ok "Add network ใช้ $rpcurl" || bad "GET /evm ให้ rpcUrl เป็น '$rpcurl' (nginx ขาด X-Forwarded-Proto?)"
host="${URL#https://}"; host="${host%%/*}"
if curl -s -m 5 -o /dev/null "http://$host:3000/health"; then bad "พอร์ต 3000 เปิดออกนอก (คนนอกข้าม HTTPS / rate limit ได้)"; else ok "พอร์ต 3000 ปิดจากข้างนอก"; fi
exit $FAIL
