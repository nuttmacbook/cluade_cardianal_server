import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalJson } from "../src/core/virtualmachine.js";
import { buildTypedData } from "../src/crypto/signature.js";

/* the explorer (explorerscan/core/wallet.js) has its own copy of canonical JSON; if its output differs from the VM's by even one character, every signature from the web page is invalid */

const html = fs.readFileSync(new URL("../explorerscan/core/wallet.js", import.meta.url), "utf8");

/** Extract a function from the explorer's file and run it in Node */
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in explorerscan/core/wallet.js`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`function ${name} is incomplete`);
}

const page = new Function(`${extract("canonical")}\n${extract("signingInput")}\nreturn { canonical, signingInput };`)();

const CASES = {
  "empty object": {},
  "key order": { b: 1, a: 2, c: { z: 1, y: [3, 2, 1] } },
  "BigInt": { amount: 10n ** 30n, neg: -5n },
  "BigInt already a string": { amount: "123n" },
  "Thai + emoji": { name: "โทเคนทดสอบ 🚀", note: "สวัสดี\nบรรทัดใหม่\t\"quote\"" },   // Thai on purpose: tests non-ASCII canonical output
  "special characters": { s: "\u0000\u001f  \\/" },
  "numeric keys + Thai key": { 10: "a", 2: "b", "ก": 1, "a": 0 },   // Thai key on purpose: tests non-ASCII key ordering
  "null / boolean / numbers": { n: null, t: true, f: false, x: 1.5, z: 0, big: 9007199254740991 },
  "nested arrays": [[1, [2, [3]]], { a: [] }],
  "bare string": "hello",
  "upper-case address": { to: "0xAbCdEf0000000000000000000000000000000001" },
};

for (const [label, value] of Object.entries(CASES)) {
  test(`explorer canonical matches the VM: ${label}`, () => {
    assert.equal(page.canonical(value), canonicalJson(value));
  });
}

test("the message the explorer asks the wallet to sign matches what the server computes (including upper-case addresses in input)", () => {
  const input = { to: "0xAbCdEf0000000000000000000000000000000001", amount: "5n", list: ["0xFF", "plain"], ["0xAB"]: 1 };
  for (const code of [undefined, "function program() { return {} }"]) {
    const tx = { input, code };
    assert.equal(page.signingInput(tx), buildTypedData(tx).message.input);
  }
});
