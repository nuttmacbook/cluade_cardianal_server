import { test } from "node:test";
import assert from "node:assert/strict";
import { VM } from "./helpers.js";

const SAMPLES = {
  lf: "function a() {\n  return 1\n}",
  crlf: "function a() {\r\n  return 1\r\n}",
  cr: "function a() {\r  return 1\r}",
  tabsAndThai: "function\tทดสอบ() {\n\treturn \"สวัสดี 🎉\"\n}",
  quotesAndBackslash: String.raw`const s = "a\"b" + 'c\'d' + "\\n" + /\d+\n/.source`,
  template: "const t = `line1\nline2 ${1 + 1}`",
  unicodeLineSeparators: "const s = \"a\u2028b\u2029c\"",
  commentsNoSemicolon: "// comment\nwriteDB(\"a\", 1)\nwriteDB(\"b\", 2) // trailing",
};

test("toOneLine: ผลลัพธ์ไม่มีตัวขึ้นบรรทัดใหม่จริง", () => {
  for (const [name, code] of Object.entries(SAMPLES)) {
    const line = VM.toOneLine(code);
    assert.doesNotMatch(line, /[\n\r\u2028\u2029]/, name);
  }
});

test("fromOneLine(toOneLine(code)) คืนโค้ดเดิม (หลัง normalize บรรทัดและ trim)", () => {
  for (const [name, code] of Object.entries(SAMPLES)) {
    const normalized = code.replace(/\r\n?/g, "\n").trim();
    assert.equal(VM.fromOneLine(VM.toOneLine(code)), normalized, name);
  }
});

test("โค้ดเดียวกันจาก LF / CRLF / CR และช่องว่างหัวท้าย ได้ one-line เดียวกัน (hash เท่ากัน)", () => {
  const expected = VM.toOneLine(SAMPLES.lf);
  assert.equal(VM.toOneLine(SAMPLES.crlf), expected);
  assert.equal(VM.toOneLine(SAMPLES.cr), expected);
  assert.equal(VM.toOneLine(`\n\n  ${SAMPLES.lf}  \n`), expected);
});

test("toOneLine ไม่ idempotent: ห้ามแปลงซ้ำกับโค้ดที่แปลงแล้ว", () => {
  const once = VM.toOneLine(SAMPLES.lf);
  assert.notEqual(VM.toOneLine(once), once);
});
