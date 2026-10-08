# เขียนโปรแกรมให้ปลอดภัย

## 1. reentrancy — ช่องโหว่ที่ทำให้เงินหายได้จริง

`runProgram` เรียกโปรแกรมอื่นได้ และโปรแกรมนั้นเรียกกลับมาหาเราได้ **ระหว่างที่ฟังก์ชันเดิมยังทำงานค้างอยู่** ค่าที่ `readDB` อ่านได้ตอนนั้นคือค่าที่เขียนไปแล้วเท่านั้น

### ❌ ผิด — โอนออกก่อน อัปเดตทีหลัง

```js
function withdraw(params) {
  const balance = readDB(map("balances", params.context.sender)) || 0;
  if (balance <= 0) throw new Error("ไม่มีเงิน");
  runProgram(params.context.sender, "receive", {}, { value: balance });   // ← ถูกเรียกกลับตรงนี้
  writeDB(map("balances", params.context.sender), 0);                     // ← สายเกินไป
}
```

ผู้โจมตีฝาก 100 แล้วถอนซ้ำได้จนเงินของคนอื่นหมดตู้ ทดสอบไว้แล้วใน `test/38-reentrancy.test.js` ของ VM

### ✅ ถูก — checks-effects-interactions

```js
function withdraw(params) {
  const who = params.context.sender;
  const balance = readDB(map("balances", who)) || 0;   // checks
  if (balance <= 0) throw new Error("ไม่มีเงิน");
  writeDB(map("balances", who), 0);                    // effects — อัปเดตก่อนเสมอ
  transferNative(who, balance);                        // interactions — ทำท้ายสุด
}
```

### ✅ ถูก — ล็อกด้วย flag เมื่อเลี่ยงการเรียกออกกลางทางไม่ได้

```js
function withdraw(params) {
  if (readDB("locked")) throw new Error("กำลังทำงานอยู่");
  writeDB("locked", true);
  try {
    // … งานที่มีการเรียกออกไปข้างนอก …
  } finally {
    deleteDB("locked");        // ต้องปลดเสมอ
  }
}
```

ถ้า tx ล้ม ทุก write รวมถึง `locked` ถูกย้อนอัตโนมัติ จึงไม่ค้างไป tx หน้า

## 2. modifier — ตรวจสิทธิ์ให้อ่านง่ายและไม่ลืม

```js
function program() {
  function onlyOwner(fn) {
    return function (params) {
      if (params.context.sender !== readDB("owner")) throw new Error("ไม่ใช่เจ้าของ");
      return fn(params);
    };
  }

  function nonReentrant(fn) {
    return function (params) {
      if (readDB("locked")) throw new Error("กำลังทำงานอยู่");
      writeDB("locked", true);
      try { return fn(params); } finally { deleteDB("locked"); }
    };
  }

  const setPrice = onlyOwner(function (params) {
    writeDB("price", params.input.price);
    return readDB("price");
  });

  const withdraw = onlyOwner(nonReentrant(function (params) { … }));

  return { setPrice, withdraw };     // export ตัวที่ห่อแล้ว
}
```

ซ้อนกันได้ตามต้องการ ตัว modifier เองไม่ต้อง return ออกไป จึงไม่มีใครเรียกข้ามได้

## 3. ตรวจ `sender` ไม่ใช่ `origin`

```js
if (params.context.sender !== readDB("owner")) throw new Error("ไม่ใช่เจ้าของ");   // ✅
if (params.context.origin !== readDB("owner")) throw new Error("ไม่ใช่เจ้าของ");   // ❌
```

`origin` คือผู้เริ่ม tx เสมอ ถ้าเจ้าของถูกหลอกให้เรียกโปรแกรมของคนอื่น โปรแกรมนั้นจะเรียกต่อมาหาเราโดยที่ `origin` ยังเป็นเจ้าของอยู่

## 4. โอนเงินเข้า address ที่รับเงินไม่เป็น

```js
if (IsProgram(params.input.to)) throw new Error("ปลายทางเป็นโปรแกรม");
transferNative(params.input.to, amount);
```

เงินที่โอนเข้าโปรแกรมซึ่งไม่มีฟังก์ชันถอน จะค้างอยู่ตลอดไป

## 5. ตรวจค่าที่รับมาเสมอ

```js
const amount = params.input.amount;
if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("amount ไม่ถูกต้อง");
```

`input` มาจากผู้ใช้โดยตรง VM ตรวจแค่ว่าเป็น JSON เท่านั้น

## 6. ระวังการเรียกออกที่ทำให้ tx ทั้งใบล้ม

`runProgram` ที่ล้มแล้วไม่ catch จะลากทั้ง tx ล้มตาม ถ้าไม่อยากให้เป็นแบบนั้น

```js
try {
  runProgram(target, "notify", {});
} catch (error) {
  emit("NotifyFailed", { target, reason: error.message });   // งานหลักเดินต่อได้
}
```

## 7. ลายเซ็นที่เซ็นไว้ล่วงหน้าต้องมี nonce

```js
const who = ecrecover(params.input.message, params.input.signature);
if (who !== readDB("admin")) throw new Error("ลายเซ็นไม่ถูกต้อง");
if (readDB(map("used", params.input.message.nonce))) throw new Error("ใช้ไปแล้ว");
writeDB(map("used", params.input.message.nonce), true);
```

ไม่มี nonce = ใครก็เอาลายเซ็นเดิมมายิงซ้ำได้ไม่จำกัด

## 8. ขนาดของ key และข้อมูล

- key ของ storage ยาวได้ไม่เกิน **1,000 ไบต์** (ภาษาไทย 1 ตัว = 9 ไบต์หลัง encode)
- อย่าเอาข้อความยาวจากผู้ใช้มาทำ key ตรง ๆ ให้ hash ก่อน

```js
writeDB(map("posts", keccak256(params.input.title)), params.input.title);
```
