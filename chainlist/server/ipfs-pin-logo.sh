#!/usr/bin/env bash
# ติดตั้ง IPFS (Kubo) บนเซิร์ฟเวอร์เชน (Ubuntu) แล้ว pin โลโก้ Bluewolfchain ไว้ถาวร
# รันบนเซิร์ฟเวอร์:  sudo bash ipfs-pin-logo.sh
# - รันเป็น service ของ systemd ชื่อ ipfs (user ipfs, ข้อมูลที่ /var/lib/ipfs) เปิดเองหลังรีบูต
# - gateway / API ฟังแค่ 127.0.0.1 (ไม่เปิดออกเน็ต) · เปิดพอร์ต 4001 ให้ node อื่นดึงไฟล์ได้
# - ดึงโลโก้ด้วย CID จาก IPFS (ตอนนี้มีที่ Mac อยู่) ถ้าไม่เจอ ให้ copy ไฟล์ icon.png มาวางข้างสคริปต์นี้
set -euo pipefail
CID="bafkreig6oeqowtgyt5mvjsrbzzzcqzmpnki4o3kf6dkbxqdmouxucv564a"
HERE="$(cd "$(dirname "$0")" && pwd)"
export IPFS_PATH=/var/lib/ipfs/.ipfs
[[ $EUID -eq 0 ]] || { echo "รันด้วย sudo"; exit 1; }
as_ipfs() { sudo -u ipfs IPFS_PATH="$IPFS_PATH" "$@"; }

# 1) ติดตั้ง kubo (เวอร์ชันล่าสุดที่ไม่ใช่ rc)
if ! command -v ipfs >/dev/null; then
  ARCH="$(dpkg --print-architecture)"   # amd64 / arm64
  VER="$(curl -fsSL https://dist.ipfs.tech/kubo/versions | grep -v -- '-rc' | tail -1)"
  echo "ติดตั้ง kubo $VER ($ARCH)"
  TMP="$(mktemp -d)"
  curl -fsSL "https://dist.ipfs.tech/kubo/$VER/kubo_${VER}_linux-${ARCH}.tar.gz" | tar xz -C "$TMP"
  bash "$TMP/kubo/install.sh"
  rm -rf "$TMP"
fi
ipfs version

# 2) user + repo
id ipfs >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/ipfs --shell /usr/sbin/nologin ipfs
if [[ ! -f "$IPFS_PATH/config" ]]; then
  as_ipfs ipfs init --profile server
  as_ipfs ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8081   # กันชนพอร์ตอื่นบนเครื่อง
  as_ipfs ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
  as_ipfs ipfs config Datastore.StorageMax 5GB
fi

# 3) systemd
cat > /etc/systemd/system/ipfs.service <<UNIT
[Unit]
Description=IPFS (Kubo) - pins Bluewolfchain logo
After=network-online.target
Wants=network-online.target

[Service]
User=ipfs
Environment=IPFS_PATH=$IPFS_PATH
ExecStart=/usr/local/bin/ipfs daemon --migrate=true
Restart=on-failure
MemoryMax=1G

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ipfs
command -v ufw >/dev/null && ufw allow 4001 >/dev/null && echo "เปิดพอร์ต 4001 (tcp+udp) ใน ufw แล้ว"

echo "รอ daemon พร้อม..."
for i in $(seq 1 30); do as_ipfs ipfs id >/dev/null 2>&1 && break; sleep 2; done

# 4) pin โลโก้
if [[ -f "$HERE/icon.png" ]]; then
  GOT="$(as_ipfs ipfs add -Q --cid-version=1 --raw-leaves --pin=true < "$HERE/icon.png")"
  [[ "$GOT" == "$CID" ]] || { echo "CID ไม่ตรง: ได้ $GOT ต้องเป็น $CID (ไฟล์ icon.png ผิดตัว)"; exit 1; }
else
  echo "ดึงโลโก้จาก IPFS (ต้องมี node อื่นถือไฟล์อยู่ เช่น Mac) รอได้ถึง 10 นาที..."
  timeout 600 sudo -u ipfs IPFS_PATH="$IPFS_PATH" ipfs pin add --progress "$CID"
fi
as_ipfs ipfs pin ls --type=recursive "$CID"
as_ipfs ipfs routing provide "$CID" >/dev/null 2>&1 || true
SIZE="$(as_ipfs ipfs cat "$CID" | wc -c)"
echo
echo "เสร็จ: เซิร์ฟเวอร์นี้ pin โลโก้ไว้แล้ว ($SIZE bytes) · service: systemctl status ipfs"
echo "ปิด ipfs บน Mac ได้แล้ว (ipfs shutdown)"
