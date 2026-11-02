# deploy: เปิดเชนสาธารณะแบบเครื่องเดียว

เครื่องเดียว = ผลิต block + RPC + explorer ในเครื่องเดียว ไม่มีเครื่องสำรองที่ซิงก์ตาม
เครื่องล่ม = เชนหยุดจนกว่าจะกู้จาก backup ดังนั้น **backup ต้องดีกว่าปกติ** (ข้อ 5)

ไฟล์ในโฟลเดอร์นี้:

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `genesis.mainnet.example.json` | copy เป็น `genesis.mainnet.json` แล้วแก้ `0xADDRESS_…` (ข้อ 1) · ไม่มีความลับ commit ได้ และทุกเครื่องต้องใช้ไฟล์เดียวกัน |
| `producer.env.example` | copy เป็น `producer.env` (ข้อ 2) · มี key · อยู่ใน .gitignore |
| `follower.env.example` | เครื่องสำรอง (ถ้ามีภายหลัง) |
| `nginx.conf` | HTTPS ข้างหน้า (ข้อ 3) |
| `cardianal.service` | systemd (ข้อ 4) · ตรวจด้วย preflight ก่อนเริ่มทุกครั้ง |
| `crontab.example` | backup + monitor (ข้อ 5) |
| `check.sh` | ตรวจจากข้างนอกหลังเปิด (ข้อ 6) |
| `../scripts/preflight.js` | ตรวจ genesis + env ก่อนเปิด ไม่แตะข้อมูล |

ลำดับสั้น ๆ:
```
cp deploy/genesis.mainnet.example.json deploy/genesis.mainnet.json   # แก้ address
cp deploy/producer.env.example deploy/producer.env && chmod 600 deploy/producer.env   # ใส่ key
node --env-file=deploy/producer.env scripts/preflight.js            # ต้องขึ้น "ผ่าน"
sudo cp deploy/cardianal.service /etc/systemd/system/ && sudo systemctl enable --now cardianal
./deploy/check.sh https://chain.example.com 272727
```

---

## 0. ลองในเครื่องก่อน (key ทดสอบ · ไม่ใช้กับเชนจริง)

```
# key 5 ตัว: admin1 admin2 producer spare rich (rich = ได้เหรียญตั้งต้น)
node -e 'import("./src/crypto/signature.js").then(s=>{const out={};for(const n of ["admin1","admin2","producer","spare","rich"]){const k=s.randomPrivateKey();out[n]={key:k,address:s.addressOf(k)}}console.log(JSON.stringify(out,null,2))})' > deploy/test-keys.json

# genesis จากตัวอย่าง (แทน 0xADDRESS_… ด้วย address ข้างบน)
node -e 'const fs=require("fs");const k=require("./deploy/test-keys.json");let t=fs.readFileSync("deploy/genesis.mainnet.example.json","utf8").replace("0xADDRESS_ที่ได้เหรียญตั้งต้น",k.rich.address).replace("0xADDRESS_ADMIN_1",k.admin1.address).replace("0xADDRESS_ADMIN_2",k.admin2.address).replace("0xADDRESS_ผู้ผลิตหลัก",k.producer.address).replace("0xADDRESS_ผู้ผลิตสำรอง",k.spare.address);fs.writeFileSync("deploy/genesis.mainnet.json",t)'

# env: key ผู้ผลิต + เก็บข้อมูลที่ ./data-test
node -e 'const fs=require("fs");const k=require("./deploy/test-keys.json");fs.writeFileSync("deploy/producer.env",fs.readFileSync("deploy/producer.env.example","utf8").replace("0x<key ผู้ผลิตหลัก>",k.producer.key).replace("/var/lib/cardianal","./data-test"))'

node --env-file=deploy/producer.env scripts/preflight.js                    # "ผ่าน · เปิดได้" (เตือน TRUST_PROXY ได้ ไม่เป็นไร)
EVM_RATE_LIMIT=0 node --env-file=deploy/producer.env server.js              # http://127.0.0.1:3000
curl 127.0.0.1:3000/genesis                                                 # chainId 272727 · role producer · producers 2
```

- MetaMask: RPC `http://127.0.0.1:3000/evm` (**http** ไม่ใช่ https · server ไม่มี TLS เอง) · ง่ายสุดกดปุ่ม Add network ในหน้า `http://127.0.0.1:3000/` · import `rich.key` เพื่อโอนทดสอบ
- `EVM_RATE_LIMIT=0` เฉพาะในเครื่อง: ทุกอย่างมาจาก 127.0.0.1 IP เดียว (MetaMask + Blockscout) เกิน 600/นาทีแล้วได้ 429 → MetaMask ขึ้น "This RPC provider is limiting requests" · เครื่องจริงหลัง nginx นับแยกต่อผู้ใช้ ไม่ต้องตั้ง
- network เก่าใน MetaMask ที่ chain ID ไม่ใช่ 272727 ใช้ RPC นี้ไม่ได้ ลบแล้วเพิ่มใหม่
- เริ่มใหม่: หยุด server แล้ว `rm -rf data-test` · `deploy/test-keys.json` และ `data-test/` อยู่ใน .gitignore แล้ว
- key จริงสร้างบนเครื่องที่ไม่ต่อเน็ต · admin ใช้ hardware wallet

---

## 1. genesis.mainnet.json (ล็อกถาวร · แก้หลังเปิด = ล้างเชน)

| ค่า | ตั้งเป็น | เหตุผล |
|---|---|---|
| `chainId` | 272727 (หรือเลขที่เช็คแล้วว่าว่าง) | ต้องไม่ซ้ำเชนอื่น กัน tx ข้ามเชน |
| `balances` | address ของคุณ → ยอดตั้งต้น (wei + `n`) | เหรียญทั้งหมดที่มีตอนเริ่ม · ไม่มีการขุดเหรียญเพิ่ม |
| `config.admins` | 2 address (hardware wallet) | อนุมัติ deploy / upgrade โปรแกรม · มี 2 เผื่อหายหนึ่ง |
| `config.producers` | key หลัก + key สำรอง | **แม้มีเครื่องเดียวก็ใส่ key สำรอง** key หลักหาย = ใช้ key สำรองผลิตต่อได้ ไม่ต้องล้างเชน |
| `blockMs` | 1000 | ตามที่ตกลง |
| `maxBlockGas` | 1000000 | ~216 tx token / block · ปิด block ~0.3 วิ |
| `gasTarget` | 500000 | ใช้เกินครึ่ง base fee ขึ้น |
| `minBaseFee` | "1000000000" (1 gwei) | ราคาแก๊สต่ำสุด |
| `burnPercent` | 100 | base fee เผาทิ้งทั้งหมด ผู้ผลิตได้แค่ tip · ถ้าอยากให้ผู้ผลิตได้ค่าแก๊สด้วยให้ลดลง |
| `upgradeDelayBlocks` | 3600 | อนุมัติอัปเกรดแล้วต้องรอ 1 ชม. ผู้ใช้มีเวลาเห็นก่อนโค้ดใหม่ใช้จริง |
| `memoryLimitMb` / `stackLimitKb` | 32 / 256 | ค่าเดิมที่ทดสอบแล้ว |

## 2. env ของเครื่อง (`deploy/producer.env` · chmod 600 · ห้าม commit)

```
GENESIS=deploy/genesis.mainnet.json
DATA=/var/lib/cardianal
HOST=127.0.0.1
PORT=3000
PRODUCER_KEY=0x<key หลัก>
TRUST_PROXY=1
SNAPSHOT_EVERY=3600
EVM_NAME=Cardianal
EVM_SYMBOL=CARD
```

| ค่า | ทำไม |
|---|---|
| `HOST=127.0.0.1` | ฟังเฉพาะในเครื่อง มีแค่ nginx ที่เข้าได้ · คนนอกเข้าพอร์ต 3000 ตรงไม่ได้ (ข้าม HTTPS ได้ · ปลอม X-Forwarded-For หลบ rate limit ได้ · ส่ง body ใหญ่ไม่จำกัดได้) |
| `TRUST_PROXY=1` | อยู่หลัง nginx · ไม่ตั้ง = rate limit เห็นทุกคนเป็น IP เดียว (127.0.0.1) แล้วบล็อกทุกคนพร้อมกัน |
| `SNAPSHOT_EVERY=3600` | snapshot ทุกชั่วโมง ใช้กู้ / เปิดเครื่องใหม่เร็วกว่าซิงก์ตั้งแต่ block 1 |
| `EVM_NAME` / `EVM_SYMBOL` | ชื่อที่ MetaMask เห็นตอนกด Add network · ต้องตรงกับที่ลง chainlist |
| ไม่ตั้ง `DEV` | DEV=1 ปิดการบังคับ admin / key |
| ไม่ตั้ง `HISTORY_KEEP_BLOCKS` | เก็บประวัติทั้งหมดไว้ก่อน (ดิสก์ ~7–9 KB ต่อ tx) ตัดทีหลังได้ |
| ค่าเริ่มที่ไม่ต้องแตะ | `RATE_LIMIT=120` POST ต่อ IP ต่อนาที · `EVM_RATE_LIMIT=600` · `TIMEOUT_MS=5000` · `MAX_TX_PER_BLOCK=500` |

## 3. nginx (HTTPS ข้างหน้า)

ไฟล์ `deploy/nginx.conf` → `/etc/nginx/conf.d/cardianal.conf` แทนโดเมน แล้ว `nginx -t && systemctl reload nginx`
- ใบรับรอง: `certbot --nginx -d chain.example.com`
- `/snapshot` เปิดให้ทุกคนโหลดได้ ถ้าไม่อยากให้คนนอกดึง ใส่ `location /snapshot { allow <IP ของคุณ>; deny all; proxy_pass … }`
- firewall: เปิดแค่ 80, 443, 22 (`ufw allow 22,80,443/tcp`) · ตั้ง `HOST=127.0.0.1` แล้วพอร์ต 3000 ปิดจากข้างนอกอยู่แล้ว firewall เป็นชั้นที่สอง

URL ที่ได้: RPC `https://chain.example.com/evm` · explorer `https://chain.example.com/` (หรือ `/evm/explorer` สำหรับ chainlist)

## 4. systemd (เปิดเองตอนบูต / ล่มแล้วเปิดใหม่)

ไฟล์ `deploy/cardianal.service` → `/etc/systemd/system/` แล้ว `sudo systemctl enable --now cardianal` · log: `journalctl -u cardianal -f`
ก่อนเริ่มทุกครั้งรัน `scripts/preflight.js` ถ้าตั้งค่าผิด server จะไม่เริ่ม (ดูเหตุผลใน log)
เครื่องเดียวจึง restart อัตโนมัติได้ปลอดภัย (ไม่มีเครื่องอื่นที่ผลิตพร้อมกัน)

## 5. backup + monitor (สำคัญกว่าปกติเพราะไม่มีเครื่องสำรอง)

ตัวอย่าง cron ใน `deploy/crontab.example`: backup ทุก 6 ชม. ส่งออกนอกเครื่อง · monitor ทุกนาทีจาก**เครื่องอื่น** (เครื่องเชนล่มแล้วเตือนตัวเองไม่ได้)
- ซ้อมกู้อย่างน้อย 1 ครั้งก่อนประกาศ: `node scripts/backup.js --verify <ชุด>` แล้ว `--restore` บนเครื่องทดสอบ
- เครื่องพัง: เครื่องใหม่ + restore ชุดล่าสุด + `PRODUCER_KEY` เดิม → ผลิตต่อจาก block ล่าสุดใน backup (tx ที่อยู่ใน block หลัง backup หาย · ยิ่ง backup ถี่ยิ่งหายน้อย)

## 6. ตรวจก่อนประกาศ

```
./deploy/check.sh https://chain.example.com 272727
```
ตรวจ /health, chainId, explorer, rpcUrl ของปุ่ม Add network เป็น https และพอร์ต 3000 ปิดจากข้างนอก · เก็บ genesis hash ที่พิมพ์ออกมาไว้ประกาศ
แล้วเพิ่มเชนใน MetaMask จากปุ่มในหน้า explorer · โอน 1 ครั้ง · ดูใน explorer

## 7. โปรแกรมกลาง (หลังเปิดเชน · ทำครั้งเดียว)

Multicall, WCARD (ห่อเหรียญหลัก), Factory (ให้ใครก็สร้าง token / NFT / multisig ได้ทันที) + ต้นแบบ · ใช้**กระเป๋า deployer ใหม่**ที่ไม่เคยส่ง tx (address ของโปรแกรมผูกกับ nonce 0–6 ของกระเป๋านี้)
```
node scripts/deploy-system.js --plan --deployer 0x<deployer> --chain-id 272727     # address ล่วงหน้า (ใส่เอกสาร / ประกาศได้เลย)
# โอนเหรียญให้ deployer ~0.01 แล้ว
DEPLOYER_KEY=0x… ADMIN_KEY=0x<admin> node scripts/deploy-system.js https://chain.example.com
```
- ได้ `deploy/system-programs.json` (address + ชื่อ) · explorer เมนู "System programs" แสดงให้เอง
- ไม่อยากใช้ key admin บนเครื่องนี้ (admin เป็น hardware wallet): ไม่ต้องส่ง `ADMIN_KEY` แล้วกด Approve ทีละตัวในหน้า Programs ของ explorer ด้วยกระเป๋า admin
- เหรียญหลักไม่ใช่ CARD: สคริปต์อ่านจาก `EVM_SYMBOL` ของ server (หรือตั้ง `SYMBOL=…`) → ชื่อเป็น `w<symbol>` · แก้ `systemPrograms` ใน `explorerscan/config.js` ให้ตรง

## เครื่องที่ควรใช้

ผลวัดที่ผ่านมาใช้ 4 vCPU (thread หลักใช้ ~70% ตอนเต็ม 1M แก๊ส/วิ) → **4 vCPU, RAM 8 GB, SSD 200 GB+** เริ่มได้ · ดิสก์โตตามจำนวน tx (~7–9 KB ต่อ tx) ดูจริงหลังเปิด 1–2 สัปดาห์
