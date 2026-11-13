import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { StateTrie, EMPTY_ROOT, verifyProof, TRIE_PREFIX, buildTrie, trieKeyOf, trieValueOf } from "../src/core/trie.js";

/*
 * Merkle Patricia Trie (phase 4.3 · src/core/trie.js)
 *   byte-identical to Ethereum (vectors from geth trie_test.go) · nodes stored by path: block-by-block updates = a full rebuild · no stale nodes
 */

function memoryTrie(options) {
  const store = new Map();
  const trie = new StateTrie({ load: (path) => store.get(path), ...options });
  const apply = ({ root, writes }) => {
    for (const write of writes) {
      const path = write.dbKey.slice(TRIE_PREFIX.length);
      if (write.type === "put") store.set(path, write.value);
      else { assert.ok(store.has(path), `deleting a missing node '${path}'`); store.delete(path); }
    }
    return root;
  };
  return { store, trie, update: (entries) => apply(trie.update(entries)) };
}

const plain = (text) => bytesToHex(utf8ToBytes(text));   // unhashed keys (like geth's vectors)
const raw = (dbKey, value) => ({ dbKey, key: plain(dbKey), bytes: value ? utf8ToBytes(value) : undefined });

test("matches Ethereum: empty trie · doe/dog/dogglesworth · insert then delete (geth TestInsert / TestDelete)", () => {
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

/** Random inserts / updates / deletes in rounds (like blocks), compared with a trie rebuilt from the final values · stored nodes must match exactly */
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
    assert.equal(root, rebuilt, `root mismatch at round ${round}`);
    assert.deepEqual([...inc.store].sort(), [...fresh.store].sort(), `stored nodes mismatch at round ${round}`);
    // building at once from sorted keys (rebuildTrie) = the same root + nodes
    const items = [...live].map(([dbKey, value]) => ({ key: (keyOf ?? trieKeyOf)(dbKey), bytes: trieValueOf(value) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const built = new Map();
    assert.equal(buildTrie(items, (path, enc) => built.set(path, enc)), root, `buildTrie mismatch at round ${round}`);
    if (live.size) assert.deepEqual([...built].sort(), [...inc.store].sort(), `buildTrie nodes mismatch at round ${round}`);
  }
  return { inc, live };
}

test("200 random rounds: incremental = rebuilt · no stale nodes · delete all = empty trie", () => {
  const { inc, live } = randomRounds(7, 200, 12, 60);
  assert.ok(live.size > 10);
  inc.update([...live.keys()].map((dbKey) => ({ dbKey, value: undefined })));
  assert.equal(inc.trie.root, EMPTY_ROOT);
  assert.equal(inc.store.size, 0);
});

test("unhashed keys that are prefixes of each other (k1 / k10 / k100) + short values: values in branches · nodes embedded in the parent · 300 random rounds", () => {
  const { inc, live } = randomRounds(5, 300, 6, 150, { keyOf: plain, short: true });
  for (const [dbKey, value] of live) {
    const { value: got, proof } = inc.trie.proof(dbKey);
    assert.equal(got, value);
    assert.deepEqual(verifyProof(inc.trie.root, dbKey, proof, { keyOf: plain }), { exists: true, value });
  }
  assert.deepEqual(verifyProof(inc.trie.root, "k1000", inc.trie.proof("k1000").proof, { keyOf: plain }), { exists: false });
});

test("re-inserting the same value / deleting a missing key = same root, no writes", () => {
  const t = memoryTrie();
  const root = t.update([{ dbKey: "a", value: 1 }, { dbKey: "b", value: { x: [1, 2] } }, { dbKey: "c", value: "c" }]);
  const again = t.trie.update([{ dbKey: "a", value: 1 }, { dbKey: "zz", value: undefined }]);
  assert.equal(again.root, root);
  assert.deepEqual(again.writes, []);
});

test("proofs: presence / absence verify against the root · altered value / wrong root / missing node = fail", () => {
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
  assert.throws(() => verifyProof(otherRoot, dbKey, proof), /incomplete proof/);
  assert.throws(() => verifyProof(root, dbKey, proof.slice(0, -1)), /incomplete proof/);
  const forged = [...proof];
  forged[forged.length - 1] = forged.at(-1).replace(/..$/, (h) => (h === "00" ? "01" : "00"));
  assert.throws(() => verifyProof(root, dbKey, forged));
  assert.deepEqual(verifyProof(EMPTY_ROOT, dbKey, []), { exists: false });
});

test("a tampered stored node = update / proof detects it (hash differs from what the parent references)", () => {
  const { inc } = randomRounds(3, 5, 30, 500);
  const path = [...inc.store.keys()].find((p) => p.length === 1);
  const node = Uint8Array.from(inc.store.get(path));
  node[5] ^= 1;   // inside a child hash / key (RLP structure still valid)
  inc.store.set(path, node);
  const keys = [...Array(64).keys()].map((i) => `s:prog${i % 4}:k${i}`);
  assert.throws(() => { for (const dbKey of keys) inc.trie.proof(dbKey); }, /does not match the hash/);
});
