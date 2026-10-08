# Program VM

VM สำหรับรันโปรแกรม JavaScript บน chain ของตัวเอง พร้อมระบบ block, ค่าแก๊ส, ลายเซ็น และการย้อนดูข้อมูล

```bash
npm install
npm test          # 550 เคส
npm run demo      # สนามทดลอง
npm run examples  # ตัวอย่าง request ทุกประเภท

npm start         # server จริง + explorer ที่ http://localhost:3000
npm run seed      # สร้างข้อมูลตัวอย่างผ่าน HTTP (ต้องรัน server ไว้ก่อน)
```

`server.js` รวมทุกอย่างเข้าด้วยกัน: VM + mempool + autoreview + simulate + ปิด block อัตโนมัติ
และเสิร์ฟหน้า explorer ที่ `public/explorer.html` ตั้งค่าผ่าน env: `PORT`, `DATA`, `MINER`, `ADMINS`, `BLOCK_MS`, `CHAIN_ID`
ยอดเงินตั้งต้นอ่านจาก `genesis.json`

## โครงสร้าง

```
src/
  core/virtualmachine.js   VM, Transaction, Block, Compiler — ตรรกะทั้งหมดของ chain
  core/autoreview.js       ตรวจโค้ดที่ผู้ใช้ส่งมาด้วยบัญชีขาว (ใช้แทนการรีวิวด้วยคน)
  storage/db.js            DB (LMDB) และ MemoryDB — readKeys / writeKeys / listKeys
  crypto/signature.js      EIP-712 บน secp256k1 — เซ็นและตรวจลายเซ็น
  node/
    mempool.js             คิว tx: rate limit, TTL, กัน tx ซ้ำ, เรียงตาม gasPrice
    sync.js                node ผู้อ่าน: ดึง block มารันเองแล้วเทียบ hash
    routes.js              endpoint ครบชุด + ปิด block อัตโนมัติ

server.js                  server จริง (node:http ไม่มี dependency เพิ่ม)
public/explorer.html       หน้า explorer ไฟล์เดียว
genesis.json               ยอดเงินตั้งต้น
index.js                   จุดเข้าเดียว — import ทุกอย่างจากที่นี่ได้
scripts/                   demo.js, examples.js
client/                    ตัวอย่างฝั่งผู้ใช้ + SAFE-PATTERNS.md
program-sdk/               ชุดแยกสำหรับคนที่จะเขียนโปรแกรมมารันบน VM
test/                      44 ไฟล์ · 550 เคส
HANDOFF.md                 เอกสารส่งต่อโปรเจค — อ่านไฟล์นี้ก่อน
CHECKPOINT.md              สถานะปัจจุบัน ค่าตั้งต้นที่แนะนำ และรายการที่ยังไม่ได้ทำ
```

## แต่ละส่วนทำอะไร

| ส่วน | รับผิดชอบ | ไม่รู้จัก |
|---|---|---|
| `core` | รันโปรแกรม, คิดค่าแก๊ส, ประกอบ block, hash, ย้อนดูข้อมูล | ลายเซ็น, HTTP, คิว |
| `storage` | เก็บและอ่าน key ทั้งหมด | ความหมายของ key |
| `crypto` | EIP-712 และ secp256k1 | DB, block |
| `node` | สิ่งที่อยู่รอบ VM: คิว, การซิงก์, HTTP | ตรรกะภายในของโปรแกรม |

ทิศทางการพึ่งพาเป็นทางเดียวเสมอ คือ `node` → `crypto` → `core` → `storage`

## เริ่มใช้งาน

```js
import { VirtualMachine, DB, Mempool, signature } from "programvm";

const vm = new VirtualMachine(new DB("./data"), {
  chainId: 1, requireNonce: true, chargeGas: true, recordBlocks: true, recordHistory: true,
});
vm.applyGenesis({ chainId: 1, balances: { "0x…": 1_000_000 } });

const mempool = new Mempool(vm);
mempool.add({ tx, signature: sig });

const block = vm.createBlock({ timestamp: Date.now(), feeRecipient: MINER });
mempool.take(block);
block.commit();
```

ดูค่าตั้งต้นที่แนะนำทั้งหมดใน `CHECKPOINT.md` และวิธีเขียนโปรแกรมใน `program-sdk/README.md`
