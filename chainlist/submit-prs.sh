#!/usr/bin/env bash
# ส่ง PR ขอลงรายชื่อเชน 2 ที่ (ethereum-lists/chains + DefiLlama/chainlist) ด้วยบัญชี GitHub ของคุณ
#
#   ./submit-prs.sh          # ซ้อม: ตรวจทุกอย่าง + เตรียม branch ในเครื่อง แต่ไม่ push / ไม่เปิด PR
#   ./submit-prs.sh --go     # ส่งจริง
#
# ต้องมี: node 18+, git, gh (gh auth login แล้ว), npx · มี java 17+ จะรันตัวตรวจจริงของ ethereum-lists (./gradlew run) ด้วย
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GO=0; [[ "${1:-}" == "--go" ]] && GO=1
WORK="${WORK:-$HERE/.work}"
mkdir -p "$WORK"

need() { command -v "$1" >/dev/null || { echo "ต้องติดตั้ง $1 ก่อน"; exit 1; }; }
need node; need git; need gh; need npx
gh auth status >/dev/null 2>&1 || { echo "ยังไม่ได้ gh auth login"; exit 1; }
ME="$(gh api user --jq .login)"

ID="$(node -p "require('$HERE/config.json').chainId")"
SHORT="$(node -p "require('$HERE/config.json').shortName")"
ICON="$(node -p "require('$HERE/config.json').icon.name")"
BRANCH="add-$SHORT-$ID"
echo "บัญชี GitHub: $ME · chainId $ID · branch $BRANCH"

# ---- 1) ดึงรายชื่อล่าสุด แล้วตรวจ (กฎ CI + ซ้ำ + ของจริง)
fresh() {   # fresh <upstream> <dir>: clone fork ของเรา (สร้าง fork ถ้ายังไม่มี) + ตั้งต้นจาก upstream ล่าสุด
  local upstream="$1" dir="$2" repo="${1#*/}"
  if [[ ! -d "$dir/.git" ]]; then
    gh repo fork "$upstream" --clone=false >/dev/null 2>&1 || true
    git clone --depth 1 "https://github.com/$upstream.git" "$dir"
    git -C "$dir" remote add fork "https://github.com/$ME/$repo.git"
  fi
  local base; base="$(git -C "$dir" remote show origin | sed -n 's/.*HEAD branch: //p')"
  git -C "$dir" fetch --depth 1 origin "$base"
  git -C "$dir" checkout -q -f -B "$BRANCH" "origin/$base"
  git -C "$dir" clean -qfd   # ไฟล์ที่ค้างจากรอบก่อน
}
fresh ethereum-lists/chains "$WORK/chains"
fresh DefiLlama/chainlist "$WORK/chainlist"

node "$HERE/make-chainlist.mjs" ${LIVE---live} --registry "$WORK/chains/_data/chains"
[[ -f "$WORK/chainlist/constants/additionalChainRegistry/chainid-$ID.js" ]] && { echo "DefiLlama มี chainid-$ID.js อยู่แล้ว"; exit 1; }

# ---- 2) ethereum-lists/chains
cd "$WORK/chains"
cp "$HERE/out/ethereum-lists/_data/chains/eip155-$ID.json" _data/chains/
cp "$HERE/out/ethereum-lists/_data/icons/$ICON.json" _data/icons/
npx -y prettier@3 --write "_data/chains/eip155-$ID.json" "_data/icons/$ICON.json" >/dev/null
if command -v java >/dev/null; then
  ./gradlew -q run
  ./gradlew -q clean run --args="verbose singleChainCheck _data/chains/eip155-$ID.json"   # แบบเดียวกับ CI: เปิด explorer + ต่อ RPC จริง
  rm -rf output   # ไฟล์ที่ gradle สร้าง ไม่ส่งขึ้น PR
else
  echo "ไม่มี java: ข้าม ./gradlew run (CI ของ ethereum-lists จะรันให้ตอนเปิด PR)"
fi
git add "_data/chains/eip155-$ID.json" "_data/icons/$ICON.json"
git -c user.name="$ME" -c user.email="$ME@users.noreply.github.com" commit -q -m "$(head -1 "$HERE/out/PR-ethereum-lists.md")"
echo "ethereum-lists: commit พร้อม"; git show --stat HEAD | tail -3

# ---- 3) DefiLlama/chainlist
cd "$WORK/chainlist"
cp "$HERE/out/chainlist/chainid-$ID.js" constants/additionalChainRegistry/
git add "constants/additionalChainRegistry/chainid-$ID.js"
git -c user.name="$ME" -c user.email="$ME@users.noreply.github.com" commit -q -m "$(head -1 "$HERE/out/PR-chainlist.md")"
echo "chainlist: commit พร้อม"; git show --stat HEAD | tail -2

if [[ $GO -eq 0 ]]; then
  echo; echo "ซ้อมผ่านแล้ว ยังไม่ได้ส่ง · ส่งจริง: ./submit-prs.sh --go"; exit 0
fi

# ---- 4) push + เปิด PR
open_pr() {   # open_pr <dir> <upstream> <body file>
  local dir="$1" upstream="$2" body="$3"
  git -C "$dir" push -f fork "$BRANCH"
  gh pr create --repo "$upstream" --head "$ME:$BRANCH" --title "$(head -1 "$body")" --body "$(tail -n +3 "$body")"
}
open_pr "$WORK/chains" ethereum-lists/chains "$HERE/out/PR-ethereum-lists.md"
open_pr "$WORK/chainlist" DefiLlama/chainlist "$HERE/out/PR-chainlist.md"
echo "เปิด PR แล้วทั้ง 2 ที่ · CI ของ ethereum-lists ต้องเขียวก่อนถึงจะมีคนรีวิว (แก้แล้วกด re-request review)"
