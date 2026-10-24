# ลอง MetaMask กับเชนจริง (checklist ระยะ 3.1)

ผมรันขั้นที่ทำแทนได้ด้วย ethers ผ่าน `/evm` ไปแล้ว (เทสต์ `94-evm-send-raw` และ smoke test บน process จริงที่ chainId 7777: โอน native ✓ · อ่าน token ✓ · โอน ERC-20 ✓)
ส่วนที่เหลือต้องใช้ MetaMask จริง เพราะหน้าจอของกระเป๋า การเลือกค่าแก๊ส และปุ่ม speed up / cancel ทำงานต่างจาก ethers
กรอกผลในคอลัมน์ "ผล" (✓ / ✗ + หมายเหตุ) แล้วส่งกลับมา ข้อที่ ✗ ผมจะแก้ให้

## 0. เตรียมเชน (ห้ามใช้ chainId 1)

`genesis.json` ปัจจุบันตั้ง `chainId: 1` ซึ่งเป็นเลขของ Ethereum mainnet: MetaMask จะเข้าใจผิดว่าเป็น mainnet (ชื่อ / ราคา / ลิงก์ผิด) จึงต้องใช้ genesis แยกที่เลขไม่ชนใคร

```bash
cat > genesis-metamask.json <<'EOF'
{ "chainId": 7777, "balances": { "0x70997970c51812dc3a010c7d01b50e0d17dc79c8": "10000000000000000000000000n" } }
EOF
GENESIS=genesis-metamask.json DATA=./data-metamask npm run dev      # ไม่ตั้ง DATA = เก็บในหน่วยความจำ (ปิดแล้วหาย)
node scripts/seed.js http://localhost:3000                          # อีกหน้าต่าง: สร้าง token MTK (namespace mytoken) + tx ตัวอย่าง
```

- บัญชีทดสอบที่มีเหรียญ: private key `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` (address `0x7099…79c8` = บัญชีที่ 1 ของ Hardhat ซึ่งเป็น key สาธารณะ **ห้ามใช้กับเงินจริง**)
- ดู address ของ token: `curl -s localhost:3000/name/mytoken`
- ถ้าเคยต่อ MetaMask กับเชนนี้แล้วล้างเชนใหม่: MetaMask → Settings → Advanced → **Clear activity tab data** (ไม่งั้น nonce ค้างของเดิม)

## 1. ต่อเครือข่าย

| # | ทำ | ควรเห็น | ผล |
|---|---|---|---|
| 1.1 | MetaMask → Networks → Add network manually: RPC URL `http://localhost:3000/evm` · Chain ID `7777` · Symbol `CARD` · Block explorer `http://localhost:3000/evm/explorer` | บันทึกได้ ไม่เตือนว่า chainId ไม่ตรง | |
| 1.2 | Import account ด้วย private key ทดสอบข้างบน | ยอด CARD ประมาณ 10,000,000 (ลดลงเล็กน้อยจากค่าแก๊สของ seed) | |
| 1.3 | สลับไปเครือข่ายอื่นแล้วกลับมา | ยอดเดิม · ไม่มี error สีแดง | |

## 2. โอน native

| # | ทำ | ควรเห็น | ผล |
|---|---|---|---|
| 2.1 | Send → `0xfabb0ac9d68b0b445fb7357272ff202c5651694a` จำนวน 1 CARD (ปล่อยค่าแก๊สตามที่ MetaMask เลือก) | หน้ายืนยันขึ้นค่าแก๊สได้ (ไม่ขึ้น "unable to estimate") | |
| 2.2 | Confirm | Activity ขึ้น Pending แล้วเป็น Confirmed ภายในไม่กี่วินาที (1 block) | |
| 2.3 | กด "View on block explorer" ใน Activity | เปิดหน้า tx ของ explorer เชนนี้ เห็น from / to / ยอด ตรงกัน | |
| 2.4 | ลองโอนแบบ Legacy (Settings → Advanced → เปิด "Customize transaction nonce" / เลือก gas แบบ legacy ถ้ามี) | ผ่านเหมือนกัน | |

## 3. token (ERC-20)

| # | ทำ | ควรเห็น | ผล |
|---|---|---|---|
| 3.1 | Import tokens → ใส่ address ของ MTK | MetaMask เติม symbol `MTK` และ decimals `6` เอง | |
| 3.2 | ยอด MTK ของบัญชี | ตรงกับหน้า token ใน explorer | |
| 3.3 | Send MTK 1.5 → address ใน 2.1 | ยืนยันได้ · Confirmed · ยอดทั้งสองฝั่งเปลี่ยนตรงกับ explorer | |

## 4. แทนที่ / ยกเลิก tx

ให้ tx ค้างก่อน: รันเชนด้วย `BLOCK_MS=20000` (block ทุก 20 วินาที) แล้วส่ง 1 ใบ

| # | ทำ | ควรเห็น | ผล |
|---|---|---|---|
| 4.1 | ส่ง 0.1 CARD แล้วกด **Speed up** ระหว่าง Pending | ใบใหม่ Confirmed · ใบเดิมหายไป (explorer: หน้า tx เดิมขึ้น "replaced" ชี้ใบใหม่) | |
| 4.2 | ส่งอีกใบแล้วกด **Cancel** | Cancel Confirmed (เป็นการโอน 0 ให้ตัวเอง nonce เดิม) · ใบเดิมไม่ถูกรัน | |

## 5. เซ็นแบบของเชน (EIP-712 ใน explorer)

| # | ทำ | ควรเห็น | ผล |
|---|---|---|---|
| 5.1 | เปิด `http://localhost:3000` → Connect wallet | ต่อได้ เห็น address | |
| 5.2 | หน้า token MTK → แท็บเรียกฟังก์ชัน → `transfer` | MetaMask ขึ้นหน้าต่าง "Signature request" แสดงฟิลด์ action / to / method / input อ่านรู้เรื่อง | |
| 5.3 | Sign | tx เข้า block · Activity ของ MetaMask **ไม่** แสดงใบนี้ (เป็นลายเซ็น ไม่ใช่ tx ของ EVM) — ถือว่าปกติ | |
| 5.4 | หน้า token → แท็บ permit → เซ็น | ขึ้นหน้าต่าง EIP-2612 permit · ส่งได้ | |

## 6. เครื่องมือ dev (ถ้าสะดวก)

| # | ทำ | ควรเห็น | ผล |
|---|---|---|---|
| 6.1 | Remix → Deploy & run → Injected Provider (MetaMask) → At Address = MTK พร้อม ABI ERC-20 → เรียก `balanceOf` / `transfer` | อ่านได้ · ส่ง transfer ได้ | |
| 6.2 | Remix deploy contract Solidity | **ต้องไม่ผ่าน** พร้อมข้อความ "deploy bytecode ไม่ได้" (โปรแกรมของเชนเป็น JavaScript) | |

## ข้อจำกัดที่รู้แล้ว (ไม่ต้องรายงานซ้ำ)

- deploy bytecode ของ EVM ไม่ได้ (6.2) · เรียกโปรแกรมผ่านกระเป๋าได้เฉพาะ token มาตรฐาน และโปรแกรมที่ประกาศ `metadata.abi`
- tx ที่เซ็นแบบ EIP-712 (ข้อ 5) ไม่ขึ้นใน Activity ของ MetaMask
- `eth_estimateGas` ตอบแก๊สของเชน: โอน native = 21000 ตามที่กระเป๋าคาด ทั้งที่เชนใช้จริงน้อยกว่า (จ่ายตามที่ใช้จริง ไม่ใช่ตาม limit)
- รายการ tx ใน `eth_getBlockByNumber` (แบบไม่ full) ของใบที่ส่งจากกระเป๋ายังเป็น hash ภายในของเชน ส่วน receipt / getTransactionByHash ตอบ hash ของ Ethereum ที่กระเป๋าถือไว้
