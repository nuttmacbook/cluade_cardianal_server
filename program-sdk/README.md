# เขียนโปรแกรมสำหรับ Program VM

```bash
npm install          # ดึง programvm จาก github
npm test             # ทดสอบโปรแกรมในเครื่อง (รันบน VM ตัวจริง)
PRIVATE_KEY=0x… npm run deploy
```

## โครงสร้างโปรแกรม

โปรแกรม 1 ตัว = ไฟล์ JavaScript 1 ไฟล์ ที่มีฟังก์ชันครอบตัวเดียว

```js
export default function program() {
  function initialization(params) {      // รันครั้งเดียวตอนติดตั้ง เรียกจากภายนอกไม่ได้
    writeDB("owner", params.context.sender);
  }

  function helper() {}                   // ไม่อยู่ใน return = ใช้ภายในเท่านั้น

  function greet(params) {
    return "สวัสดี " + params.input.name;
  }

  return { greet };                      // รายชื่อฟังก์ชันที่คนอื่นเรียกได้
}
```

กติกา
- **ทั้งไฟล์อยู่ใน scope เดียว** ห้ามมีอะไรอยู่นอกฟังก์ชันครอบ
- **ห้าม import** โปรแกรมต้องอยู่ได้ด้วยตัวเอง
- `export default` ข้างหน้าใช้เพื่อทดสอบในเครื่องเท่านั้น ตอนส่งขึ้น chain ใช้ `String(program)` ซึ่งไม่มีคำนี้ติดไป

## `params` ที่ทุกฟังก์ชันได้รับ

| ฟิลด์ | ความหมาย |
|---|---|
| `params.input` | ข้อมูลที่ผู้เรียกส่งมา |
| `params.context.sender` | ผู้เรียกชั้นนี้ (เป็นโปรแกรมได้ถ้าถูกเรียกต่อ) |
| `params.context.origin` | ผู้เริ่ม tx เสมอ |
| `params.value` | native ที่แนบมากับการเรียกนี้ |
| `params.block.timestamp` | เวลาของ block |

## API ที่ใช้ได้ในโปรแกรม

```js
readDB(key)                  // อ่านข้อมูลของโปรแกรมตัวเอง
writeDB(key, value)          // เขียน (ค่าต้องเป็น JSON)
deleteDB(key)
map("balances", address)     // ประกอบ key หลายส่วน → "balances:0x…"
runProgram(address, "method", input, { value })   // เรียกโปรแกรมอื่น
transferNative(to, amount)   // โอนเงินจากกระเป๋าของโปรแกรมเอง
setMetadata(field, value)    // ตั้ง namespace / description ของโปรแกรม
emit("Transfer", { from, to, amount })   // บันทึก event ให้ explorer (ถูกย้อนถ้ากิ่งนั้นล้ม)
ThisAddress()                // address ของโปรแกรมตัวเอง
keccak256(value)             // hash ของ string หรือ object (object เรียง key ให้เอง)
ecrecover(message, signature) // → address ผู้เซ็น หรือ null ถ้าลายเซ็นใช้ไม่ได้
ThisBalance()                // ยอด native คงเหลือของโปรแกรมตัวเอง
BalanceOf(address)           // ยอด native ของ address อื่น
IsProgram(address)           // address นั้นเป็นโปรแกรมหรือ wallet
MetadataOf(address, field)   // อ่าน metadata เช่น namespace / creator
BlockNumber()                // เลข block ที่ tx นี้อยู่
Date.now()                   // เวลาของ block (เท่ากันทุก tx ใน block เดียว)
Math.random()                // สุ่มแบบ deterministic (รันซ้ำได้ค่าเดิม)
```

**ห้ามใช้** `process`, `fetch`, `globalThis`, `performance`, `async`/`await`, `setTimeout` และการ import ทุกชนิด โค้ดที่ใช้สิ่งเหล่านี้จะไม่ผ่านการรีวิว

## ตัวเลขเป็น BigInt

เมื่อ chain เปิดโหมด `bigintValues` ตัวเลขทุกตัวในโปรแกรมต้องเป็น BigInt

```js
const balance = readDB(map("balances", who)) || 0n;   // ✅ 0n ไม่ใช่ 0
writeDB(map("balances", who), balance - params.input.amount);
if (balance < params.input.amount) throw new Error("ยอดไม่พอ");
```

- `params.input` ที่เป็นตัวเลขถูกแปลงเป็น BigInt ให้อัตโนมัติ ไม่ว่า client จะส่ง `30` หรือ `"30n"` มา
- `params.value`, `params.block.timestamp`, `ThisBalance()`, `BalanceOf()`, `BlockNumber()` เป็น BigInt ทั้งหมด
- ค่าที่ return ออกไปและ event จะกลายเป็น string ลงท้าย `n` เช่น `"970n"` เพราะ JSON ไม่มี BigInt
- ใช้ `number` ที่ไหนก็ตามจะถูกปฏิเสธพร้อมข้อความบอกจุดที่ผิด

## modifier

ห่อฟังก์ชันด้วยฟังก์ชัน แล้ว return ตัวที่ห่อแล้ว

```js
function onlyOwner(fn) {
  return function (params) {
    if (params.context.sender !== readDB("owner")) throw new Error("ไม่ใช่เจ้าของ");
    return fn(params);
  };
}

const setPrice = onlyOwner(function (params) { writeDB("price", params.input.price); });

return { setPrice };
```

**อ่าน `patterns/SAFE-PATTERNS.md` ก่อนเขียนโปรแกรมที่เกี่ยวกับเงิน** โดยเฉพาะหัวข้อ reentrancy ซึ่งทำให้เงินของคนอื่นหายได้จริง และดูตัวอย่างที่ใช้ pattern ครบใน `patterns/vault.program.js`

## ทดสอบในเครื่อง

```js
import { createChain } from "../lib/testkit.js";
import program from "./hello.program.js";

const hello = createChain().deploy(program, { as: "owner", initInput: { greeting: "สวัสดี" } });

hello.call("greet", { name: "โลก" });              // → "สวัสดี โลก (ครั้งที่ 1)"
hello.call("greet", {}, { as: "alice" });          // เรียกในนามคนอื่น
hello.callRaw("greet", { name: "โลก" });           // ดู gasUsed / writes / trace
hello.state();                                      // ข้อมูลทั้งหมดที่โปรแกรมเก็บไว้
hello.address;                                      // address ของโปรแกรม
```

### ทดสอบเร็ว ๆ โดยไม่รัน VM

```js
import { createFakeApi } from "../lib/program-globals.js";
const api = createFakeApi({ self: "0xhello", balances: { "0xhello": 500 }, programs: ["0xtoken"] });
Object.assign(globalThis, api);
const { greet } = program();

greet(api.params({ name: "โลก" }, { sender: "0xalice", value: 0 }));
api.store / api.native / api.events / api.transfers   // ตรวจผลได้ตรง ๆ
```

รองรับ API ครบทุกตัวยกเว้น `runProgram` ซึ่งต้องใช้ `createChain()`

`createChain()` รันบน VM ตัวจริง พฤติกรรมจึงเหมือนบน chain ทุกอย่าง ทั้งการย้อนข้อมูลเมื่อ throw, ค่าแก๊ส และเวลาของ block

ตัวเลือกเพิ่มเติม

```js
createChain({ chargeGas: true, balances: { alice: 1_000_000 } });   // ทดสอบเรื่องค่าแก๊ส
chain.transfer("alice", "bob", 100);
chain.balanceOf("alice");    // { received, sended, consumed, balance }
chain.setTime(Date.parse("2025-01-01"));
```

## ส่งขึ้น chain

```js
import program from "./hello-world/hello.program.js";
const code = String(program);    // ← สิ่งที่ส่งไปคือ string นี้

const tx = { chainId: 1, action: "deploy", from: me, to: "", method: "",
             input: { greeting: "สวัสดี" }, code, value: 0, nonce, gasLimit: 200000, gasPrice: 1 };
await fetch("/sendtx", { method: "POST", body: JSON.stringify({ tx, signature: signTransaction(tx, key) }) });
```

เซ็นด้วย MetaMask ก็ได้ (`eth_signTypedData_v4`) โครงสร้างที่ต้องเซ็นสร้างได้จาก `buildTypedData(tx)` ใน `programvm/signature.js`

หลัง deploy โปรแกรมจะอยู่ในสถานะรอรีวิว ใช้งานได้เมื่อทีมงานส่ง tx `init` ให้แล้ว
