#!/usr/bin/env bash
# check a live chain from outside (over HTTPS) · ./deploy/check.sh https://chain.example.com [chainId]
set -uo pipefail
URL="${1:?give a URL, e.g. https://chain.example.com}"; WANT="${2:-}"; FAIL=0
ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; FAIL=1; }

health="$(curl -fsS "$URL/health")" || bad "/health unreachable"
[[ -n "${health:-}" ]] && { echo "$health" | grep -q '"ok":true' && ok "/health ok" || bad "/health: $(echo "$health" | head -c 300)"; }
genesis="$(curl -fsS "$URL/genesis")" || bad "/genesis unreachable"
[[ -n "${genesis:-}" ]] && echo "     genesis hash $(echo "$genesis" | sed -n 's/.*"hash":"\([^"]*\)".*/\1/p')"
id="$(curl -fsS -X POST "$URL/evm" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')"
if [[ -z "$id" ]]; then bad "/evm eth_chainId not answering"; elif [[ -n "$WANT" && $((id)) -ne $WANT ]]; then bad "chainId $((id)) is not $WANT"; else ok "/evm chainId $((id))"; fi
curl -fsS -o /dev/null "$URL/evm/explorer" && ok "explorer reachable" || bad "explorer unreachable"
rpcurl="$(curl -fsS "$URL/evm" | sed -n 's/.*"rpcUrls":\["\([^"]*\)".*/\1/p')"
[[ "$rpcurl" == https://* ]] && ok "Add network uses $rpcurl" || bad "GET /evm gives rpcUrl '$rpcurl' (nginx missing X-Forwarded-Proto?)"
host="${URL#https://}"; host="${host%%/*}"
if curl -s -m 5 -o /dev/null "http://$host:3000/health"; then bad "port 3000 is open to the outside (outsiders can bypass HTTPS / rate limit)"; else ok "port 3000 closed from outside"; fi
exit $FAIL
