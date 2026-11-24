# ขอลงรายชื่อที่ chainlist.org (เตรียมไว้แล้ว ส่งได้วันเปิด)

## สถานะ

อัปเดต 2026-11-11: เปลี่ยนเป็น Bluewolfchain / BWSC / chainId 41234 แล้ว (config.json + out/ สร้างใหม่)

| อย่าง | สถานะ |
|---|---|
| ไฟล์ PR ทั้ง 2 ที่ + ข้อความ PR | ✅ สร้างจาก config.json อัตโนมัติ (`out/`) |
| ตรวจตามกฎ CI ของ ethereum-lists | ✅ ในสคริปต์ (ฟิลด์, ชื่อ, สัญลักษณ์, URL, โลโก้) |
| เลข / ชื่อ / shortName ไม่ซ้ำ | ✅ 41234 ยังว่างใน ethereum-lists และ DefiLlama (ตรวจ 2026-11-11) · ชื่อ "Bluewolfchain Mainnet" / shortName `bwsc` ยังไม่ได้ตรวจกับรายชื่อทั้งหมด → `submit-prs.sh` ตรวจให้ตอนซ้อม |
| explorer แบบ EIP-3091 | ✅ PR #50 (`/evm/explorer` + block ด้วย hash) |
| โลโก้ | ⚠️ ยังเป็นร่างตัว "C" ของชื่อเดิม (Cardianal) · ต้องเปลี่ยนเป็นโลโก้ Bluewolfchain ก่อนส่ง (png 512×512 ไม่เกิน 250 KB) |
| สคริปต์ส่ง PR | ✅ `submit-prs.sh` ซ้อมผ่านแล้ว (fork, branch, prettier, commit) |
| **ที่เหลือวันเปิด** | ใส่โดเมนจริงใน config · อัปโลโก้ขึ้น IPFS · รันสคริปต์ |

## ส่งที่ไหน

| ที่ | ไฟล์ | ผล |
|---|---|---|
| github.com/ethereum-lists/chains (หลัก) | `_data/chains/eip155-41234.json` + `_data/icons/bluewolfchain.json` | จอง chainId · chainlist.org และกระเป๋า / เว็บอีกหลายที่ดึงรายชื่อนี้ |
| github.com/DefiLlama/chainlist (เสริม) | `constants/additionalChainRegistry/chainid-41234.js` | ขึ้น chainlist.org เร็วกว่า ถ้า PR หลักยังรอรีวิว |

## วันเปิด: 4 ขั้น

ทำหลังขั้น 3 ใน launch-plan.md (เครื่องจริงเปิดแล้ว มี HTTPS) เพราะ CI ของ ethereum-lists เปิด explorer และต่อ RPC จริง

**1. แก้ config.json**
- `rpc`: `https://<โดเมน>/evm`
- `explorer.url`: `https://<โดเมน>/evm/explorer` (ห้ามลงท้าย `/`)
- `infoURL`: เว็บโครงการ
- `chainId`: ต้องตรงกับ genesis (41234)
- เปลี่ยนโลโก้: วางไฟล์ png 512×512 ไม่เกิน 250 KB แล้วชี้ `icon.file`
- testnet: name "Bluewolfchain Testnet", shortName "bwsc-test", `"status": "incubating"` ได้

**2. ตั้ง env บน server ให้ตรง** `EVM_NAME=Bluewolfchain EVM_SYMBOL=BWSC` (ค่าเดียวกับ `deploy/producer.env.example`) (เป็นค่าที่ปุ่ม Add to wallet ของ explorer ส่งให้ MetaMask)

**3. อัปโลโก้ขึ้น IPFS** ไฟล์ `out/icon.png` (สร้างใหม่ทุกครั้งที่รันสคริปต์)
- สคริปต์คำนวณ CID ไว้ให้แล้ว (`bafkrei…` ใน `out/ethereum-lists/_data/icons/bluewolfchain.json`)
- ทางที่ได้ CID ตรงกัน: ติดตั้ง Kubo แล้ว `ipfs add --cid-version=1 --raw-leaves out/icon.png` และเปิด node ไว้ หรือใช้บริการ pin ที่รับไฟล์ (เช่น Filebase / web3.storage)
- ถ้าบริการให้ CID อื่นมา ใส่ใน `icon.cid` ของ config.json แทน
- README ของ ethereum-lists ห้ามใช้ pinata · ต้องดึงด้วย `ipfs get` ได้

**4. รันสคริปต์**
```
./submit-prs.sh          # ซ้อม: ดึงรายชื่อล่าสุด ตรวจทั้งหมด (--live) เตรียม commit แต่ไม่ส่ง
./submit-prs.sh --go     # ส่งจริง: push ไป fork ของคุณ แล้วเปิด PR ทั้ง 2 ที่
```
ต้องมี node, git, gh (`gh auth login` แล้ว) · มี java 17+ จะรันตัวตรวจจริงของ ethereum-lists (`./gradlew run` + `singleChainCheck` แบบเดียวกับ CI) ด้วย

หลังส่ง: CI ของ ethereum-lists ต้องเขียวก่อนถึงจะมีคนรีวิว (แก้แล้วกด re-request review) · หลัง merge ดูที่ `https://chainlist.org/chain/41234`

## สิ่งที่สคริปต์ตรวจ (`make-chainlist.mjs`)

ไม่ต่อเน็ต:
- ฟิลด์ครบ / ไม่มีฟิลด์เกิน · ชื่อใช้ตัวอักษรที่อนุญาต · สัญลักษณ์สั้นกว่า 7 ตัว · decimals 18
- rpc ขึ้นต้น https / wss · explorer https ไม่ลงท้าย `/`
- โลโก้: ชนิดไฟล์, ขนาดจริงจากไฟล์, ไม่เกิน 250 KB, CID
- `--registry`: chainId / ชื่อ / shortName / ชื่อโลโก้ ไม่ซ้ำ

`--live`:
- RPC: eth_chainId และ net_version ตรง chainId · web3_clientVersion / eth_blockNumber / eth_gasPrice ตอบ · มี block แล้ว · CORS + preflight · `GET /evm` ชื่อ / สัญลักษณ์ตรง config
- explorer: หน้าแรก, `/block/1`, `/address/0x0…` ได้ 2xx
- โลโก้: ดึงจาก IPFS gateway แล้วได้ไฟล์เดียวกัน

## ค่าที่สคริปต์ตั้งให้เอง

- `networkId` = chainId (server ตอบ net_version เท่ากับ chainId)
- `features`: EIP155 + EIP1559
- `explorers[].standard` = `EIP3091`: `/evm/explorer/tx/<hash>`, `/address/<addr>`, `/token/<addr>`, `/block/<เลขหรือ hash>` พาไปหน้าเดิมของ explorer (ต้องใช้โค้ดหลัง PR #50)
- ไฟล์ของ DefiLlama ไม่ใส่ `icon` เพราะไม่มีไฟล์ไอคอนคู่กันใน repo นั้น

## ไฟล์ในโฟลเดอร์นี้

- `config.json` ค่าของเชน (แก้ไฟล์นี้ไฟล์เดียว)
- `make-chainlist.mjs` สร้าง + ตรวจ
- `submit-prs.sh` ส่ง PR ทั้ง 2 ที่
- `logo/` โลโก้ร่าง (svg ต้นฉบับ + png)
- `out/` ผลลัพธ์ (สร้างใหม่ทุกครั้ง) · `.work/` repo ที่สคริปต์ clone มา (ลบได้)
