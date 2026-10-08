import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalJson } from "../src/core/virtualmachine.js";
import { buildTypedData } from "../src/crypto/signature.js";

/* explorer.html เขียน canonical JSON ซ้ำอีกชุด — ถ้าผลต่างจาก VM แม้ตัวเดียว ลายเซ็นจากหน้าเว็บจะใช้ไม่ได้ทั้งหมด */

const html = fs.readFileSync(new URL("../public/explorer.html", import.meta.url), "utf8");

/** ดึงฟังก์ชันจาก <script> ของ explorer ออกมารันใน Node */
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `ไม่พบ function ${name} ใน explorer.html`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`function ${name} ไม่ครบ`);
}

const page = new Function(`${extract("canonical")}\n${extract("signingInput")}\nreturn { canonical, signingInput };`)();

const CASES = {
  "object ว่าง": {},
  "เรียง key": { b: 1, a: 2, c: { z: 1, y: [3, 2, 1] } },
  "BigInt": { amount: 10n ** 30n, neg: -5n },
  "BigInt ที่เป็น string แล้ว": { amount: "123n" },
  "ภาษาไทย + emoji": { name: "โทเคนทดสอบ 🚀", note: "สวัสดี\nบรรทัดใหม่\t\"quote\"" },
  "ตัวอักษรพิเศษ": { s: "\u0000\u001f  \\/" },
  "key ตัวเลข + key ไทย": { 10: "a", 2: "b", "ก": 1, "a": 0 },
  "null / boolean / ตัวเลข": { n: null, t: true, f: false, x: 1.5, z: 0, big: 9007199254740991 },
  "array ซ้อน": [[1, [2, [3]]], { a: [] }],
  "string ล้วน": "hello",
  "address ตัวใหญ่": { to: "0xAbCdEf0000000000000000000000000000000001" },
};

for (const [label, value] of Object.entries(CASES)) {
  test(`canonical ของ explorer ตรงกับ VM: ${label}`, () => {
    assert.equal(page.canonical(value), canonicalJson(value));
  });
}

test("ข้อความที่ explorer ให้ wallet เซ็น ตรงกับที่ server คำนวณ (รวม address ตัวพิมพ์ใหญ่ใน input)", () => {
  const input = { to: "0xAbCdEf0000000000000000000000000000000001", amount: "5n", list: ["0xFF", "plain"], ["0xAB"]: 1 };
  for (const code of [undefined, "function program() { return {} }"]) {
    const tx = { input, code };
    assert.equal(page.signingInput(tx), buildTypedData(tx).message.input);
  }
});
