# สเปคสำหรับสร้าง Explorer

เอกสารนี้อธิบายทุกอย่างที่ต้องรู้เพื่อสร้างหน้า explorer ของ chain นี้
ผู้อ่านคือคนหรือ agent ที่จะเขียนฝั่งหน้าเว็บ ไม่ต้องอ่านโค้ดของ VM

---

## 1. ภาพรวมของ chain

- server เดียวเป็นผู้ผลิต block, ปิด block ทุก ~3 วินาที, block ว่างจะไม่ถูกสร้าง
- ทุก tx เซ็นด้วย EIP-712 (secp256k1) เหมือน Ethereum จึงใช้ MetaMask ได้
- address เป็นตัวพิมพ์เล็กเสมอ รูปแบบ `0x` + 40 hex — **ต้อง lowercase ก่อนค้นเสมอ**
- โปรแกรม (smart contract) เขียนด้วย JavaScript และมี address แบบเดียวกับ wallet

### tx มี 5 ประเภท

| action | ความหมาย | ฟิลด์ที่ใช้ |
|---|---|---|
| `call` | เรียกฟังก์ชันของโปรแกรม | `to` (โปรแกรม), `method`, `input`, `value` |
| `deploy` | ส่งโค้ดขึ้น chain (ยังใช้งานไม่ได้จนกว่าจะ init) | `code`, `input` (initInput), `metadata`, `value` |
| `init` / `reject` | ทีมงานอนุมัติหรือปฏิเสธโปรแกรม | `to` (โปรแกรม) |
| `transfer` | โอนเหรียญหลัก ไม่เกี่ยวกับโปรแกรม | `to`, `value` |
| `metadata` | ตั้งชื่อ/คำอธิบายของ address ตัวเอง | `input` |

**สถานะของโปรแกรม:** `deploy` → รอรีวิว (`pending`) → `init` → ใช้งานได้ (`active`) หรือ `reject` → ถูกปฏิเสธและคืนเงิน
หน้า explorer ควรแยกให้เห็นว่าโปรแกรมไหนยังรอรีวิวอยู่

---

## 2. เรื่องที่ต้องรู้ก่อนเขียนโค้ด (สำคัญมาก)

### 2.1 ตัวเลขเป็น string ลงท้าย `n`

ตัวเลขในโปรแกรมเป็น BigInt เสมอ ตัวเลขทุกตัวที่มาจากโปรแกรมและจาก storage จึงเป็น string แบบนี้

```json
{ "amount": "1000n", "balance": "999999999999999999999n" }
```

**ห้ามใช้ `Number()`** เพราะค่าใหญ่เกิน 2^53 ได้ ให้แปลงด้วย `BigInt(value.slice(0, -1))` แล้วจัดรูปแบบเอง
ยอดเหรียญหลัก (native, wei 18 ทศนิยม) ก็เป็น `"123n"` เช่นกัน ส่วนค่าของระบบ (ค่าแก๊ส, nonce, เลข block, timestamp) ยังเป็น number ปกติ

### 2.2 tx มี 2 hash ที่ค้นได้ทั้งคู่

| ชื่อ | มาจากไหน | ใช้ที่ไหน |
|---|---|---|
| `hash` | VM คำนวณเอง | key ใน DB, `txHashes` ของ block |
| `digest` | EIP-712 ที่ผู้ใช้เซ็น | สิ่งที่ wallet แสดงให้ผู้ใช้เห็น |

`GET /tx/:hash` รับได้ทั้งสองค่า **แนะนำให้แสดง `digest` เป็นเลขที่ tx ในหน้าเว็บ** เมื่อมี เพราะตรงกับที่ผู้ใช้เห็นตอนเซ็น แล้วใช้ `hash` เป็นกลไกภายใน

### 2.3 tx ที่ล้มมี 2 แบบ ต้องแสดงต่างกัน

| แบบ | `accepted` | อยู่ใน block ไหม | เสียค่าแก๊สไหม |
|---|---|---|---|
| โปรแกรม throw / เงินไม่พอ | `true` | ✅ มี status `throw` | ✅ เสีย |
| nonce ผิด / เกินโควตา / ส่งถี่ / simulate ไม่ผ่าน / หมดเวลา / หมดอายุในคิว | `false` | ✅ อยู่ในรายการ **rejected** ของ block (ไม่ได้รัน) | ❌ ไม่เสีย ไม่กิน nonce |

แบบที่สอง (ผ่านการตรวจลายเซ็นแล้ว) ถูกผู้ผลิตบันทึกไว้ใน block ถัดไป: `GET /tx/:hash` → `{ status: "rejected", block, reason, stage, … }`
(`block: null` = ยังรอ block ถัดไป) · `stage`: `sendtx` (ตอนส่ง) · `block` (ตอนปิด block) · `expired` (ค้างในคิวเกินเวลา)
ลายเซ็นผิดไม่ถูกบันทึก (hash / ผู้ส่งเชื่อไม่ได้) · แสดงเป็น "Rejected" + เหตุผล ไม่ใช่ "Failed"

### 2.4 เหรียญหลักเก็บเป็น 3 ช่องสะสม

```
ยอดคงเหลือ = received - sended - consumed
```

ทุกช่องเพิ่มอย่างเดียว ไม่เคยลด `consumed` คือค่าแก๊สสะสมที่จ่ายไปทั้งชีวิต
แสดงทั้ง 3 ค่าได้เลยเป็นสถิติที่ EVM ไม่มี

### 2.5 address พิเศษ

`0x0000000000000000000000000000000000000000` คือที่เก็บค่าแก๊สส่วนที่ถูกเผา
ยอด `received` ของมันคือจำนวนเหรียญที่หายออกจากระบบทั้งหมด — เหมาะทำเป็นตัวเลขหน้าแรก

---

## 3. API

ทุก endpoint คืน JSON, `limit` สูงสุด 100, เวลาเป็น unix milliseconds

### อ่านอย่างเดียว (เปิดสาธารณะได้)

| endpoint | คืนอะไร |
|---|---|
| `GET /blocks?limit=20` | header ของ block ล่าสุด ใหม่ไปเก่า |
| `GET /block/latest` | header ล่าสุด |
| `GET /block/:number` | header ของ block นั้น |
| `GET /block/:number?full=1` | **receipt เต็ม** — tx ทุกใบพร้อม input, result, trace, stateChanges, events |
| `GET /tx/:hash` | ตำแหน่งและสถานะของ tx (รับทั้ง hash และ digest) · ยังรอในคิว → `{ status: "pending" }` · ถูกแทนที่ → `{ status: "replaced", hash, replacedBy }` (จำถาวรแบบมีเพดาน อยู่รอด restart) · ถูกปฏิเสธ → `{ status: "rejected", block, blockNumber, index, reason, code, stage, sender, nonce, action, to, gasPrice, timestamp }` |
| `GET /rejected?address=&limit=&cursor=` | tx ที่ถูกปฏิเสธ ใหม่ไปเก่า `{ items, next }` (ส่ง `next` กลับมาเป็น `cursor`) · ไม่ระบุ address = ทั้งเชน · `GET /address/:a/rejected` = ของผู้ส่งคนนั้น |
| `GET /program/:a/interactions?limit=&cursor=` | tx / call ที่เข้ามาหาโปรแกรม แบบ cursor `{ items, next }` (ไม่นับทั้งรายการ ไม่มีเพดาน) |
| `GET /program/:a/events?limit=&cursor=&name=` | event แบบ cursor `{ items, next }` (ส่ง `cursor` ว่างได้ = หน้าแรก) · ไม่ส่ง `cursor` = แบบเลขหน้า `?page=` เดิม · `/address/:a/incoming?cursor=` ก็เช่นกัน |
| `GET /program/:a/events?name=Transfer&to=0x…&from=0x…` | ค้นด้วยดัชนีของ field ที่ emit แบบ indexed (หลาย field = AND · ต้องมี `name` ไม่งั้น 400) → `{ items, next, limit }` ใหม่ไปเก่า · `cursor` / `limit` ใช้ได้ · field ที่ไม่ได้ indexed = ว่าง |
| `GET /program/:a/abi` | `{ address, abi, evmAbi }` — `abi` = `metadata.abi` ที่โปรแกรมประกาศ (null = ไม่มี) · `evmAbi` = JSON ABI แบบ Ethereum |
| `GET /program/:a/groups?scan=&cursor=` | นับ key ของ storage ตามชื่อ key แรก ทีละช่วง (`scan` ≤ 50,000 ต่อ request) → `{ total, groups, scanned, next, complete }` · ยังไม่ครบ → ส่ง `cursor=next` แล้วบวกผลเอง |
| `GET /tx/:hash/receipt` | receipt ของ tx ใบเดียว |
| `GET /address/:address` | ยอดเงิน, nonce, metadata, เป็นโปรแกรมหรือไม่, tx ล่าสุด |
| `GET /program/:address` | โค้ด, ผู้สร้าง, metadata, ยอดเงิน, storage, `token` / `collection` (NFT ERC-721 / multi-token ERC-1155 มาตรฐาน · ไม่ใช่ = null) |
| `GET /address/:address/nfts` | NFT / multi-token ที่ถือ `[{ program, standard, name, symbol, tokenId, amount, uri }]` |
| `GET /events?program=&name=&limit=` | event ที่โปรแกรม emit ใหม่ไปเก่า |
| `GET /name/:namespace` | ชื่อ → address |
| `GET /state/:address?block=42` | storage ของโปรแกรม ณ block นั้น |
| `GET /nonce/:address` | nonce ถัดไปที่ควรใช้ (นับ tx ที่รออยู่ในคิวด้วย) |
| `GET /pending` | tx ที่รออยู่ในคิว ยังไม่เข้า block · `rejectedPending` = tx ที่ถูกปฏิเสธที่รอลง block |
| `POST /query` | เรียกฟังก์ชันของโปรแกรมแบบอ่านอย่างเดียว ไม่เสียค่าแก๊ส |

### เขียน

| endpoint | หมายเหตุ |
|---|---|
| `POST /sendtx` | `{ tx, signature }` — ตอบ 400 พร้อม `simulation` ถ้าจะล้ม · action: `call` `transfer` (value 0 ได้ = ยกเลิกใบที่ค้างด้วยการโอน 0 ให้ตัวเอง) `deploy` (`upgrader` ไม่บังคับ อยู่ในข้อมูลที่เซ็น) `init` `reject` `metadata` `upgrade` (`code` + `input` = migrate input) `setUpgrader` (`input: { upgrader: "0x…" \| null }`) `initUpgrade` `rejectUpgrade` |

**`POST /query`** สำคัญมากสำหรับ explorer เพราะใช้อ่านค่าจากโปรแกรมได้โดยไม่ต้องส่ง tx

```json
POST /query
{ "programUuid": "0x4e6d…", "functionName": "balanceOf", "input": { "who": "0x7099…" } }
→ { "status": "success", "result": "1000n", "readOnly": true }
```

---

## 4. รูปแบบข้อมูล

### block header — `GET /block/:number`

```json
{
  "number": 42,
  "hash": "0x…", "parentHash": "0x…",
  "timestamp": 1735689605000,
  "feeRecipient": "0x…", "burnPercent": 100,
  "txCount": 3, "successCount": 2, "failedCount": 1,
  "gasUsed": 4210, "fee": "4210000000000n",
  "baseFeePerGas": "1000000000n", "gasTarget": 1500000, "burnedFee": "4210000000000n", "producerFee": "0n",
  "parentStateRoot": "0x…", "txRoot": "0x…", "stateRoot": "0x…",
  "receiptsRoot": "0x…", "logsBloom": "0x…(512 hex)",
  "txHashes": ["0x…", "0x…", "0x…"],
  "rejectedCount": 1, "rejectedRoot": "0x…"
}
```

`rejectedCount` / `rejectedRoot` มีเฉพาะ block ที่มี tx ถูกปฏิเสธ (อยู่ใน hash ของ block) · รายการอยู่ใน `?full=1` → `rejected: [{ hash, sender, nonce, action, to, gasPrice, reason, code, stage }]`

`stateRoot` เป็นแบบสะสม ถ้ามีใครแก้ข้อมูลเก่า ค่าของ block หลังจากนั้นจะไม่ตรงทั้งหมด

`baseFeePerGas` (EIP-1559 · คำนวณจาก block ก่อนหน้า) · `receiptsRoot` (hash ของ receipt ย่อทุกใบ) · `logsBloom` (bloom ของ log แบบ EVM) **อยู่ใน hash ของ block**
`burnedFee` / `producerFee` = ค่าแก๊สส่วนที่เผา / ส่วนที่ `feeRecipient` ได้ (tip + base fee ส่วนที่ไม่เผา) · explorer แสดงเป็น Base fee + Fee split
`?full=1` มี `baseFeePerGas` `gasTarget` `burnedFee` `producerFee` `receiptsRoot` `logsBloom` เหมือนกัน

### receipt เต็ม — `GET /block/:number?full=1`

```json
{
  "number": 42, "hash": "0x…", "time": "2025-01-01T00:00:05.000Z",
  "txCount": 2, "gasUsed": 4210,
  "transactions": [ /* ดูด้านล่าง */ ],
  "events": [{ "name": "Transfer", "data": {…}, "depth": 0, "program": "0x…", "txIndex": 0, "txHash": "0x…" }],
  "stateChanges": [{ "program": "0x…", "key": ["balances", "0x…"], "after": "970n" }],
  "nativeChanges": [{ "address": "0x…", "field": "consumed", "after": 813 }]
}
```

### tx receipt

```json
{
  "hash": "0x…", "digest": "0x…", "index": 0,
  "action": "call", "status": "success",
  "from": "0x…", "to": "0x…", "method": "transfer",
  "input": { "to": "0x…", "amount": "30n" },
  "result": true,
  "error": null,
  "nonce": 5, "gasUsed": 813, "gasPrice": "1000000000n", "fee": "813000000000n",
  "type": 2, "effectiveGasPrice": "1000000000n", "baseFeePerGas": "1000000000n",
  "maxFeePerGas": "2000000000n", "maxPriorityFeePerGas": "0n", "burnedFee": "813000000000n", "producerFee": "0n",
  "events": [{ "index": 0, "depth": 0, "program": "0x…", "name": "Transfer", "data": { "amount": "30n" } }],
  "trace": [{ "depth": 0, "program": "0x…", "method": "transfer", "from": "0x…", "origin": "0x…", "status": "success" }],
  "stateChanges": [{ "program": "0x…", "key": ["balances", "0x…"], "after": "970n" }],
  "nativeChanges": [{ "address": "0x…", "field": "consumed", "after": 813 }]
}
```

**`trace` คือจุดขายของ chain นี้** เพราะเห็นการเรียกโปรแกรมซ้อนกันทุกชั้นโดยไม่ต้องเปิดโหมด debug
`depth` 0 คือ user เรียก, depth 1 คือโปรแกรมเรียกโปรแกรมอื่นต่อ
`from` คือผู้เรียกชั้นนั้น (เป็น address ของโปรแกรมได้), `origin` คือ user ที่เริ่ม tx เสมอ

### address — `GET /address/:address`

```json
{
  "address": "0x…",
  "native": { "received": 1000000, "sended": 5000, "consumed": 3013, "balance": 991987 },
  "nonce": 6,
  "metadata": { "namespace": "alice", "type": "program", "creator": "0x…", "createdAt": 1735689600000 },
  "isProgram": false,
  "transactions": [{ "hash": "0x…", "action": "call", "nonce": 5, "status": "success", "timestamp": …, "gasUsed": 813, "fee": 813, "signature": "0x…", "digest": "0x…" }]
}
```

`metadata.type === "program"` บอกว่าเป็นโปรแกรม ส่วน `namespace` คือชื่อที่ไม่ซ้ำทั้งระบบ **ควรแสดงชื่อแทน address เมื่อมี**

### program — `GET /program/:address`

```json
{
  "address": "0x…",
  "code": "function program() {\\n  …",
  "context": { "sender": "0x…", "origin": "0x…" },
  "metadata": { "type": "program", "creator": "0x…", "createdAt": …, "namespace": "mytoken" },
  "native": { "balance": 5000, … },
  "storage": [{ "key": ["balances", "0x…"], "value": "970n" }]
}
```

`code` ถูกเก็บเป็นบรรทัดเดียวโดยขึ้นบรรทัดใหม่เป็น `\n` แบบ escape **ต้องแปลงกลับก่อนแสดง**

```js
const source = JSON.parse(`"${code}"`);
```

---

## 5. หน้าที่ควรมี

| หน้า | ใช้ endpoint | จุดที่ควรเน้น |
|---|---|---|
| หน้าแรก | `/blocks`, `/block/latest`, `/pending` | จำนวน block, tx ต่อวินาที, เหรียญที่ถูกเผา, tx ที่รออยู่ในคิว |
| block | `/block/:number?full=1` | รายการ tx, ค่าแก๊สรวม, ผู้ปิด block, ลิงก์ไป block ก่อน/หลัง |
| tx | `/tx/:hash/receipt` | **trace แบบต้นไม้**, event, การเปลี่ยนแปลง storage, ค่าแก๊ส |
| address | `/address/:address` | ยอด 3 ช่อง, ประวัติ tx, ชื่อ namespace |
| program | `/program/:address`, `/events?program=`, `POST /query` | โค้ดพร้อมไฮไลต์, ฟีด event, **ปุ่มเรียกฟังก์ชันแบบอ่านอย่างเดียว** |
| ค้นหา | ทุก endpoint | รับได้ทั้ง block number, tx hash, digest, address, namespace |

**ฟีเจอร์ที่ chain นี้ทำได้และ explorer ทั่วไปไม่มี**

1. **ย้อนดู state ณ block ใด ๆ** ด้วย `/state/:address?block=42` — ทำเป็น slider เลื่อนดูข้อมูลของโปรแกรมย้อนหลังได้
2. **เรียกฟังก์ชันอ่านค่าได้ฟรี** ด้วย `POST /query` — ทำเป็นหน้า "ทดลองเรียก" ได้เลย
3. **trace ทุก tx โดยไม่ต้องตั้งค่าอะไร**

---

## 6. ข้อควรระวัง

1. **`?full=1` ต้องรันทั้ง block ใหม่** ใช้เวลาหลักสิบมิลลิวินาที อย่าเรียกในหน้ารายการ ให้เรียกเฉพาะตอนผู้ใช้กดเข้าไปดู
2. **`GET /block/:number?full=1` อาจตอบ 409** ถ้า chain ไม่ได้เปิดเก็บประวัติ ให้ fallback ไปแสดง header อย่างเดียว
3. **`timestamp` ของ block มาจากผู้ผลิต block** ไม่ใช่เวลาที่ผู้ใช้ส่ง tx
4. **`method` เป็นสตริงว่างสำหรับ deploy/init/transfer/metadata** อย่าแสดงเป็น "undefined"
5. **`input` ของ deploy ไม่มี `code`** เพราะโค้ดอยู่ในฟิลด์แยก
6. **tx ที่รออยู่ในคิว (`/pending`) ยังไม่มี block และอาจไม่เข้าเลย** ให้แสดงสถานะเป็น "รอดำเนินการ" และ poll ซ้ำ
7. **event ของกิ่งที่ล้มแล้วถูก catch จะหายไป** ตัวเลขที่เห็นจึงเป็นเฉพาะกิ่งที่สำเร็จจริง
8. **อย่า cache `/pending` และ `/block/latest`** ส่วน block ที่ปิดแล้วไม่มีวันเปลี่ยน cache ได้ถาวร

---

## 7. ตัวอย่าง client

```js
const api = (path, options) => fetch(`${BASE}${path}`, options).then((r) => r.json());

const toBigInt = (value) => (typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value);

const block = await api("/block/42?full=1");
for (const tx of block.transactions) {
  for (const call of tx.trace) console.log("  ".repeat(call.depth) + `${call.program}.${call.method} → ${call.status}`);
}

const balance = await api("/query", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ programUuid: TOKEN, functionName: "balanceOf", input: { who: address } }),
});
console.log(toBigInt(balance.result));
```

---

## 8. ถ้า endpoint ยังไม่ครบ

ฝั่ง VM มีฟังก์ชันเหล่านี้ให้เรียกตรง ๆ ถ้าจะเพิ่ม endpoint เอง

```js
vm.listBlocks({ limit, reverse })        vm.getBlock(n)          vm.getBlockBody(n)
vm.replayBlock(n)                        vm.getTransaction(hash) vm.listTransactionsOf(address)
vm.listEvents({ program, name, limit })  vm.listProgramStorage(address)
vm.nativeBalanceOf(address)              vm.getMetadata(address) vm.resolveNamespace(name)
vm.stateAt(blockNumber, dbKey)           vm.snapshotAt(blockNumber, prefix)
vm.query({ programUuid, functionName, input, context })
```

---

## 9. สไตล์หน้าเว็บ (ธีมม่วง)

อ้างอิงภาพ `design/explorer-style-ref.png` (แนว data app แบบ Space and Time) · ธีมมืดธีมเดียว ไม่มีโหมดสว่าง

- **หัวเว็บ**: แถบดำเกือบสนิท โลโก้หกเหลี่ยมซ้าย · ปุ่ม pill (`.pill` ตัวที่เลือก = ม่วงทึบ `#6d28d9`) · ช่องค้นหา `#q` · Deploy · ปุ่ม wallet เป็นชิปบัญชีมีวงกลมสีเขียว (ขวาสุด)
- **แถบข้าง** `#side`: หมวดพับได้ (`<details>`) Explorer / Programs / Wallet / Recent programs · ไอคอนวงกลมสีเล็ก ๆ · ตัวเลขเป็นชิป
  รายการโปรแกรมล่าสุดดึงจาก `/programs/approved?limit=8` · `markNav()` ใส่ `.on` ให้ `[data-nav]` ตามหน้าที่เปิด (เรียกในทุก `render()`)
  จอ ≤960px แถบข้างกลายเป็น drawer เปิดด้วยปุ่ม ☰ (`#menu-btn`) กดเลือกหรือกดพื้นหลัง / Esc แล้วปิด · ปุ่ม pill ในหัวเว็บซ่อน
- **พื้นหลัง**: ไล่สีวงกลม ม่วงเข้ม → ม่วงแดง (`#2a0a4a → #6b1a9a`) + เส้นกริดจาง ๆ + กริดพื้นแบบ perspective (`.canvas` fixed ไม่เลื่อนตาม)
- **การ์ด** (`.panel`): ป้ายชื่อเล็กสีดำอยู่เหนือการ์ด (`h2` ตัวพิมพ์ใหญ่ monospace · ตัวเลขใน "(N)" เป็นชิป `.cnt` โดยข้อความยังเหมือนเดิม)
  ตัวการ์ดม่วงโปร่งแสง ขอบบาง + เรืองแสง · หัวตารางแถบม่วงอ่อน · แถวแน่น · ชื่อแถวของตาราง `kv` ตัวพิมพ์ใหญ่มีไอคอนข้าวหลามตัด
  ใต้รายการมีชิป "● Showing …" แบบ footer · จอกว้างมีเส้นเชื่อมสีม่วงบาง ๆ ด้านซ้ายโยงการ์ดต่อกัน
- **แท็บ / ปุ่ม**: แท็บอยู่ในแถบดำหัวการ์ด ตัวที่เลือก = ม่วงทึบ · `.btn` ม่วงโปร่ง · `.btn.solid` ม่วงทึบเรืองแสง
- สีหลักอยู่ใน `:root` (`--card` `--head` `--violet` `--line-2` `--glow` `--mono`) · กล่อง JSON ยังเป็น `#04050d` (เทสต์ตรวจ)
- ห้ามเปลี่ยน id / data-* / ข้อความปุ่มที่เทสต์ e2e ใช้ · เทสต์ "ธีมม่วง" ตรวจแถบข้าง / drawer / หัวตาราง
