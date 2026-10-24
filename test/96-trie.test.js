import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { StateTrie, EMPTY_ROOT, verifyProof, TRIE_PREFIX } from "../src/core/trie.js";

/*
 * Merkle Patricia Trie (ระยะ 4.3 · src/core/trie.js)
 *   ตรงกับ Ethereum ทุกไบต์ (เวกเตอร์จาก geth trie_test.go) · node เก็บตาม path: แก้ทีละ block = สร้างใหม่ทั้งต้น · ไม่มี node ค้าง
 */

function memoryTrie(options) {
  const store = new Map();
  const trie = new StateTrie({ load: (path) => store.get(path), ...options });
  const apply = ({ root, writes }) => {
    for (const write of writes) {
      const path = write.dbKey.slice(TRIE_PREFIX.length);
      if (write.type === "put") store.set(path, write.value);
      else { assert.ok(store.has(path), `ลบ node ที่ไม่มี '${path}'`); store.delete(path); }
    }
    return root;
  };
  return { store, trie, update: (entries) => apply(trie.update(entries)) };
}

const plain = (text) => bytesToHex(utf8ToBytes(text));   // key ไม่ hash (แบบเวกเตอร์ของ geth)
const raw = (dbKey, value) => ({ dbKey, key: plain(dbKey), bytes: value ? utf8ToBytes(value) : undefined });

test("ตรงกับ Ethereum: trie ว่าง · doe/dog/dogglesworth · ใส่แล้วลบ (geth TestInsert / TestDelete)", () => {
  assert.equal(EMPTY_ROOT, "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");
  const a = memoryTrie();
  assert.equal(a.trie.root, EMPTY_ROOT);
  assert.equal(a.update([raw("doe", "reindeer"), raw("dog", "puppy"), raw("dogglesworth", "cat")]),
    "0x8aad789dff2f538bca5d8ea56e8abe10f4c7ba3a5dea95fea4cd6e7c3a1168d3");

  const b = memoryTrie();
  let root;
  for (const [k, v] of [["do", "verb"], ["ether", "wookiedoo"], ["horse", "stallion"], ["shaman", "horse"], ["doge", "coin"], ["ether", ""], ["dog", "puppy"], ["shaman", ""]]) {
    root = b.update([raw(k, v)]);
  }
  assert.equal(root, "0x5991bb8c6514148a29db676a14ac506cd2cd5775ace63c30a4fe457715e9ac84");
  assert.equal(b.trie.root, root);
});

/** สุ่มใส่ / แก้ / ลบ เป็นรอบ ๆ (เหมือน block) แล้วเทียบกับ trie ที่สร้างใหม่จากค่าสุดท้าย · node ในที่เก็บต้องเท่ากันทุกตัว */
function randomRounds(seed, rounds, perRound, keySpace, { keyOf, short = false } = {}) {
  let state = seed;
  const random = (n) => {   // mulberry32
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const live = new Map();
  const inc = memoryTrie({ keyOf });
  for (let round = 0; round < rounds; round++) {
    const entries = [];
    for (let i = 0; i < perRound; i++) {
      const dbKey = short ? `k${random(keySpace)}` : `s:prog${random(4)}:k${random(keySpace)}`;
      const value = random(4) === 0 ? undefined : short ? random(100) : { n: random(1000), pad: "x".repeat(random(40)) };
      entries.push({ dbKey, value });
      if (value === undefined) live.delete(dbKey); else live.set(dbKey, value);
    }
    const root = inc.update(entries);
    const fresh = memoryTrie({ keyOf });
    const rebuilt = fresh.update([...live].map(([dbKey, value]) => ({ dbKey, value })));
    assert.equal(root, rebuilt, `root ไม่ตรงที่รอบ ${round}`);
    assert.deepEqual([...inc.store].sort(), [...fresh.store].sort(), `node ในที่เก็บไม่ตรงที่รอบ ${round}`);
  }
  return { inc, live };
}

test("สุ่ม 200 รอบ: แก้ทีละรอบ = สร้างใหม่ · ไม่มี node ค้าง · ลบหมด = trie ว่าง", () => {
  const { inc, live } = randomRounds(7, 200, 12, 60);
  assert.ok(live.size > 10);
  inc.update([...live.keys()].map((dbKey) => ({ dbKey, value: undefined })));
  assert.equal(inc.trie.root, EMPTY_ROOT);
  assert.equal(inc.store.size, 0);
});

test("key ไม่ hash ที่เป็น prefix กัน (k1 / k10 / k100) + ค่าสั้น: ค่าใน branch · node ฝังในพ่อ · สุ่ม 300 รอบ", () => {
  const { inc, live } = randomRounds(5, 300, 6, 150, { keyOf: plain, short: true });
  for (const [dbKey, value] of live) {
    const { value: got, proof } = inc.trie.proof(dbKey);
    assert.equal(got, value);
    assert.deepEqual(verifyProof(inc.trie.root, dbKey, proof, { keyOf: plain }), { exists: true, value });
  }
  assert.deepEqual(verifyProof(inc.trie.root, "k1000", inc.trie.proof("k1000").proof, { keyOf: plain }), { exists: false });
});

test("ใส่ค่าเดิมซ้ำ / ลบ key ที่ไม่มี = root เดิม ไม่มี write", () => {
  const t = memoryTrie();
  const root = t.update([{ dbKey: "a", value: 1 }, { dbKey: "b", value: { x: [1, 2] } }, { dbKey: "c", value: "c" }]);
  const again = t.trie.update([{ dbKey: "a", value: 1 }, { dbKey: "zz", value: undefined }]);
  assert.equal(again.root, root);
  assert.deepEqual(again.writes, []);
});

test("หลักฐาน: มีค่า / ไม่มีค่า ตรวจกับ root ได้ · แก้ค่า / root ผิด / node ขาด = ไม่ผ่าน", () => {
  const { inc, live } = randomRounds(11, 30, 20, 200);
  const root = inc.trie.root;
  for (const [dbKey, value] of [...live].slice(0, 30)) {
    const { value: got, proof } = inc.trie.proof(dbKey);
    assert.deepEqual(got, value);
    assert.deepEqual(verifyProof(root, dbKey, proof), { exists: true, value });
  }
  for (const dbKey of ["s:none:1", "s:prog0:k999999", "x"]) {
    const { value, proof } = inc.trie.proof(dbKey);
    assert.equal(value, undefined);
    assert.deepEqual(verifyProof(root, dbKey, proof), { exists: false });
  }
  const [dbKey] = live.keys();
  const { proof } = inc.trie.proof(dbKey);
  const otherRoot = memoryTrie().update([{ dbKey, value: 1 }]);
  assert.throws(() => verifyProof(otherRoot, dbKey, proof), /หลักฐานไม่ครบ/);
  assert.throws(() => verifyProof(root, dbKey, proof.slice(0, -1)), /หลักฐานไม่ครบ/);
  const forged = [...proof];
  forged[forged.length - 1] = forged.at(-1).replace(/..$/, (h) => (h === "00" ? "01" : "00"));
  assert.throws(() => verifyProof(root, dbKey, forged));
  assert.deepEqual(verifyProof(EMPTY_ROOT, dbKey, []), { exists: false });
});

test("node ในที่เก็บถูกแก้ = update / proof ตรวจเจอ (hash ไม่ตรงกับที่พ่ออ้างไว้)", () => {
  const { inc } = randomRounds(3, 5, 30, 500);
  const path = [...inc.store.keys()].find((p) => p.length === 1);
  inc.store.set(path, inc.store.get(path).replace(/..$/, (h) => (h === "00" ? "01" : "00")));
  const keys = [...Array(64).keys()].map((i) => `s:prog${i % 4}:k${i}`);
  assert.throws(() => { for (const dbKey of keys) inc.trie.proof(dbKey); }, /ไม่ตรงกับ hash/);
});
