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

chain เปิดโหมด BigInt ตัวเลขทุกตัวที่มาจากโปรแกรมและจาก storage จะเป็น string แบบนี้

```json
{ "amount": "1000n", "balance": "999999999999999999999n" }
```

**ห้ามใช้ `Number()`** เพราะค่าใหญ่เกิน 2^53 ได้ ให้แปลงด้วย `BigInt(value.slice(0, -1))` แล้วจัดรูปแบบเอง
ส่วนค่าของระบบ (ค่าแก๊ส, nonce, เลข block, timestamp, ยอดเหรียญหลัก) ยังเป็น number ปกติ

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
| nonce ผิด / เกินโควตา / หมดเวลา | `false` | ❌ ไม่ปรากฏเลย | ❌ ไม่เสีย |

แบบที่สองจะไม่มีร่องรอยใน chain เลย explorer จึงไม่ต้องรองรับ

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
| `GET /tx/:hash` | ตำแหน่งและสถานะของ tx (รับทั้ง hash และ digest) |
| `GET /tx/:hash/receipt` | receipt ของ tx ใบเดียว |
| `GET /address/:address` | ยอดเงิน, nonce, metadata, เป็นโปรแกรมหรือไม่, tx ล่าสุด |
| `GET /program/:address` | โค้ด, ผู้สร้าง, metadata, ยอดเงิน, storage |
| `GET /events?program=&name=&limit=` | event ที่โปรแกรม emit ใหม่ไปเก่า |
| `GET /name/:namespace` | ชื่อ → address |
| `GET /state/:address?block=42` | storage ของโปรแกรม ณ block นั้น |
| `GET /nonce/:address` | nonce ถัดไปที่ควรใช้ (นับ tx ที่รออยู่ในคิวด้วย) |
| `GET /pending` | tx ที่รออยู่ในคิว ยังไม่เข้า block |
| `POST /query` | เรียกฟังก์ชันของโปรแกรมแบบอ่านอย่างเดียว ไม่เสียค่าแก๊ส |

### เขียน

| endpoint | หมายเหตุ |
|---|---|
| `POST /sendtx` | `{ tx, signature }` — ตอบ 400 พร้อม `simulation` ถ้าจะล้ม |

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
  "feeRecipient": "0x…", "burnPercent": 50,
  "txCount": 3, "successCount": 2, "failedCount": 1,
  "gasUsed": 4210, "fee": 4210,
  "parentStateRoot": "0x…", "txRoot": "0x…", "stateRoot": "0x…",
  "txHashes": ["0x…", "0x…", "0x…"]
}
```

`stateRoot` เป็นแบบสะสม ถ้ามีใครแก้ข้อมูลเก่า ค่าของ block หลังจากนั้นจะไม่ตรงทั้งหมด

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
  "nonce": 5, "gasUsed": 813, "gasPrice": 1, "fee": 813,
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
