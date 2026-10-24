/**
 * Merkle Patricia Trie แบบ Ethereum (ระยะ 4.3) — stateRoot ของ block = รากของ trie ของ state ทั้งหมด
 *
 *   const trie = new StateTrie({ load: (path) => hex | undefined });   // อ่าน node ที่เก็บไว้ตาม path
 *   const { root, writes } = trie.update([{ dbKey, value }, { dbKey, value: undefined }]);   // undefined = ลบ
 *   trie.proof(dbKey)               → { value, proof: [hex ของ node ตามทางจากราก] }
 *   verifyProof(root, dbKey, proof) → { exists, value }   (ใช้ฝั่ง client ได้ · ไม่มี dependency นอกจาก keccak)
 *
 * รูปแบบตรงกับ Ethereum ทุกไบต์ (hex-prefix · RLP · node ที่ encode สั้นกว่า 32 byte ฝังในตัวพ่อ · ราก = keccak(rlp(root)))
 *   key ใน trie = keccak256(utf8(dbKey)) ("secure trie" แบบ state ของ Ethereum) · value = utf8(canonicalJson(ค่า))
 *   trie ว่าง = EMPTY_ROOT (0x56e8…b421) เหมือน Ethereum
 *
 * การเก็บ node: ตาม path (nibble จากราก) ไม่ใช่ตาม hash — "trie:<nibbles>" → hex ของ node
 *   เก็บแค่ trie ล่าสุด (เขียนทับที่เดิม · node ที่หายไปถูกลบ) → พื้นที่ไม่โตตามจำนวน block (แบบ path-based ของ geth)
 *   ตำแหน่งของ node ใน trie ขึ้นกับ key ที่อยู่ใต้มันเท่านั้น: node ที่ย้ายที่ (leaf / extension ที่ถูกแยกหรือรวม) ถูกโหลดระหว่าง update เสมอ
 *   → path ที่โหลดมาแล้วไม่ถูกเขียนใหม่ = ไม่มี node อยู่ตรงนั้นแล้ว → ลบ
 *   ราก (path ว่าง) เก็บเสมอแม้สั้นกว่า 32 byte
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "./encoding.js";

export const TRIE_PREFIX = "trie:";
export const trieNodeKey = (path) => `${TRIE_PREFIX}${path}`;

const EMPTY = new Uint8Array(0);
const LEAF = 0, EXT = 1, BRANCH = 2;
const hex0x = (bytes) => `0x${bytesToHex(bytes)}`;
const fromHex = (value) => hexToBytes(String(value).replace(/^0x/, ""));

// ---------- RLP (item = Uint8Array | item[] | { raw: Uint8Array } = RLP ที่ encode แล้ว ฝังทั้งก้อน) ----------

function lengthPrefix(length, offset) {
  if (length <= 55) return Uint8Array.of(offset + length);
  const bytes = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(offset + 55 + bytes.length, ...bytes);
}

function concat(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export function rlpEncode(item) {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat([lengthPrefix(item.length, 0x80), item]);
  }
  if (item?.raw instanceof Uint8Array) return item.raw;
  const payload = concat(item.map(rlpEncode));
  return concat([lengthPrefix(payload.length, 0xc0), payload]);
}

export function rlpDecode(bytes) {
  const [item, end] = rlpItem(bytes, 0);
  if (end !== bytes.length) throw new Error("RLP มีข้อมูลเกิน");
  return item;
}

function rlpItem(bytes, at) {
  if (at >= bytes.length) throw new Error("RLP สั้นเกินไป");
  const first = bytes[at];
  const readLength = (count, from) => {
    if (from + count > bytes.length) throw new Error("RLP สั้นเกินไป");
    let length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[from + i];
    return length;
  };
  if (first < 0x80) return [bytes.subarray(at, at + 1), at + 1];
  if (first <= 0xb7) return slice(at + 1, first - 0x80);
  if (first <= 0xbf) { const count = first - 0xb7; return slice(at + 1 + count, readLength(count, at + 1)); }
  const list = (start, length) => {
    const end = start + length;
    if (end > bytes.length) throw new Error("RLP สั้นเกินไป");
    const items = [];
    for (let i = start; i < end;) { const [item, next] = rlpItem(bytes, i); items.push(item); i = next; }
    return [items, end];
  };
  if (first <= 0xf7) return list(at + 1, first - 0xc0);
  const count = first - 0xf7;
  return list(at + 1 + count, readLength(count, at + 1));

  function slice(start, length) {
    if (start + length > bytes.length) throw new Error("RLP สั้นเกินไป");
    return [bytes.subarray(start, start + length), start + length];
  }
}

// ---------- nibble / hex-prefix ----------

/** key → nibble เป็น string ของ hex ("0a3f…") */
const nibblesOf = (bytes) => bytesToHex(bytes);
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

function hexPrefix(nibbles, leaf) {
  const odd = nibbles.length % 2;
  const flag = (leaf ? 2 : 0) + odd;
  return hexToBytes(odd ? `${flag.toString(16)}${nibbles}` : `${flag.toString(16)}0${nibbles}`);
}

function fromHexPrefix(bytes) {
  const text = bytesToHex(bytes);
  const flag = parseInt(text[0], 16);
  if (flag > 3) throw new Error("hex-prefix ผิดรูปแบบ");
  return { leaf: flag >= 2, nibbles: text.slice(flag % 2 ? 1 : 2) };
}

// ---------- node ----------
//   { kind: LEAF, key, value }  ·  { kind: EXT, key, child }  ·  { kind: BRANCH, children[16], value }
//   ลูก = node | { stored: hash } (ยังไม่ได้โหลด อยู่ที่ path ของตัวเอง) | null
//   node ที่ยังไม่ถูกแก้ (clean) มี enc / hash ของตัวเองไว้แล้ว · ที่สร้าง / แก้ใน update นี้ = dirty

const leafNode = (key, value) => ({ kind: LEAF, key, value, dirty: true });
const extNode = (key, child) => ({ kind: EXT, key, child, dirty: true });
const branchNode = (children, value) => ({ kind: BRANCH, children, value, dirty: true });

/** item ของ RLP → node (clean) · ลูกที่เป็น hash = { stored } · ลูกที่ฝังมา = node */
function nodeFromItem(item, enc = rlpEncode(item)) {
  if (!Array.isArray(item)) throw new Error("node ของ trie ต้องเป็น list");
  let node;
  if (item.length === 17) {
    node = { kind: BRANCH, children: item.slice(0, 16).map(childFromItem), value: item[16].length ? item[16] : null };
  } else if (item.length === 2) {
    const { leaf, nibbles } = fromHexPrefix(item[0]);
    node = leaf ? { kind: LEAF, key: nibbles, value: item[1] } : { kind: EXT, key: nibbles, child: childFromItem(item[1]) };
  } else {
    throw new Error(`node ของ trie ต้องมี 2 หรือ 17 ช่อง (ได้ ${item.length})`);
  }
  node.dirty = false;
  node.enc = enc;
  return node;
}

function childFromItem(item) {
  if (Array.isArray(item)) return nodeFromItem(item);
  if (item.length === 0) return null;
  if (item.length !== 32) throw new Error("ลูกของ node ต้องเป็น hash 32 byte หรือ node ที่ฝังมา");
  return { stored: item };
}

const decodeNode = (bytes) => nodeFromItem(rlpDecode(bytes), bytes);

/** ref ที่พ่อใช้อ้างถึง node นี้: hash (enc ≥ 32 byte) หรือ RLP ทั้งก้อน (ฝัง) */
function refOf(node) {
  if (node === null) return EMPTY;
  if (node.stored) return node.stored;
  if (node.enc.length < 32) return { raw: node.enc };
  return (node.hash ??= keccak_256(node.enc));
}

function encodeNode(node) {
  if (node.kind === LEAF) return rlpEncode([hexPrefix(node.key, true), node.value]);
  if (node.kind === EXT) return rlpEncode([hexPrefix(node.key, false), refOf(node.child)]);
  return rlpEncode([...node.children.map(refOf), node.value ?? EMPTY]);
}

export const EMPTY_ROOT = hex0x(keccak_256(rlpEncode(EMPTY)));

/** key ของ dbKey ใน trie (nibble) */
export const trieKeyOf = (dbKey) => nibblesOf(keccak_256(utf8ToBytes(dbKey)));
/** ค่าของ state ใน trie (byte) — ตรงกับที่ verifyProof ถอดกลับ */
export const trieValueOf = (value) => utf8ToBytes(canonicalJson(value));

// ---------- trie ----------

/**
 * อ่านจาก storage ทุกครั้ง (ไม่ถือ trie ไว้ใน RAM) — ผู้เรียกต้องบันทึก writes ของ update ก่อนเรียก update / proof ครั้งถัดไป
 * (หรือให้ load มองเห็น writes ที่ยังไม่ commit)
 */
export class StateTrie {
  #load;
  #gone = new Set();   // path ของ node ที่เก็บไว้แล้วถูกแทน / ลบใน update นี้ → ลบถ้าไม่มี node ใหม่เขียนลงที่เดิม

  /** load(path) → hex ของ node ที่เก็บไว้ที่ path นั้น | undefined · keyOf: dbKey → nibble (ค่าเริ่ม = secure) */
  constructor({ load, keyOf = trieKeyOf } = {}) {
    this.#load = load;
    this.keyOf = keyOf;
  }

  #fetch(path) {
    const stored = this.#load(path);
    if (stored === undefined || stored === null) return null;
    const node = decodeNode(fromHex(stored));
    node.persisted = true;
    return node;
  }

  /** ลูกที่ยังไม่โหลด → โหลดจาก path ของมัน (ตรวจ hash ให้ตรงกับที่พ่ออ้างไว้) */
  #resolve(child, path) {
    if (!child?.stored) return child;
    const node = this.#fetch(path);
    if (!node) throw new Error(`trie: ไม่พบ node ที่ path '${path}'`);
    const hash = keccak_256(node.enc);
    if (bytesToHex(hash) !== bytesToHex(child.stored)) throw new Error(`trie: node ที่ path '${path}' ไม่ตรงกับ hash ที่พ่ออ้างไว้`);
    node.hash = hash;
    return node;
  }

  /** root ปัจจุบันใน storage */
  get root() {
    const node = this.#fetch("");
    return node ? hex0x(keccak_256(node.enc)) : EMPTY_ROOT;
  }

  /**
   * ใส่ / ลบหลาย key แล้วคืน root ใหม่ + writes ของ node (ยังไม่บันทึก — ผู้เรียก commit เอง)
   * entries: [{ dbKey, value }] · value undefined = ลบ · (เทสต์: key = nibble ตรง ๆ · bytes = ค่าดิบ) · ลำดับมีผลเมื่อ key ซ้ำ (ตัวหลังชนะ)
   */
  update(entries) {
    this.#gone = new Set();
    let root = this.#fetch("");
    for (const { dbKey, value, key = this.keyOf(dbKey), bytes = value === undefined ? undefined : trieValueOf(value) } of entries) {
      root = bytes === undefined ? this.#delete(root, "", key) : this.#insert(root, "", key, bytes);
    }
    const writes = [];
    const written = new Set();
    let rootHash = EMPTY_ROOT;
    if (root) {
      this.#finalize(root, "", writes, written);
      rootHash = hex0x(root.hash ??= keccak_256(root.enc));
    }
    for (const path of this.#gone) if (!written.has(path)) writes.push({ type: "del", dbKey: trieNodeKey(path) });
    this.#gone = new Set();
    return { root: rootHash, writes };
  }

  /** ref → node ใหม่ (หรือ ref เดิมถ้าไม่เปลี่ยน) · node ที่เก็บไว้แล้วถูกแทน → จด path ไว้ลบ */
  #replace(ref, path, change) {
    const node = this.#resolve(ref, path);
    const next = change(node);
    if (next === node) return ref;
    if (node.persisted) this.#gone.add(path);
    return next;
  }

  #insert(ref, path, key, value) {
    if (ref === null) return leafNode(key, value);
    return this.#replace(ref, path, (node) => this.#insertInto(node, path, key, value));
  }

  #insertInto(node, path, key, value) {
    if (node.kind === LEAF) {
      const c = commonPrefix(node.key, key);
      if (c === node.key.length && c === key.length) {
        return bytesToHex(node.value) === bytesToHex(value) ? node : leafNode(key, value);
      }
      const branch = branchNode(new Array(16).fill(null), null);
      if (c === node.key.length) branch.value = node.value;
      else branch.children[parseInt(node.key[c], 16)] = leafNode(node.key.slice(c + 1), node.value);
      if (c === key.length) branch.value = value;
      else branch.children[parseInt(key[c], 16)] = leafNode(key.slice(c + 1), value);
      return c ? extNode(key.slice(0, c), branch) : branch;
    }
    if (node.kind === EXT) {
      const c = commonPrefix(node.key, key);
      if (c === node.key.length) {
        const child = this.#insert(node.child, path + node.key, key.slice(c), value);
        return child === node.child ? node : extNode(node.key, child);
      }
      const branch = branchNode(new Array(16).fill(null), null);
      const rest = node.key.slice(c + 1);
      branch.children[parseInt(node.key[c], 16)] = rest.length ? extNode(rest, node.child) : node.child;
      if (c === key.length) branch.value = value;
      else branch.children[parseInt(key[c], 16)] = leafNode(key.slice(c + 1), value);
      return c ? extNode(key.slice(0, c), branch) : branch;
    }
    if (key.length === 0) {
      if (node.value && bytesToHex(node.value) === bytesToHex(value)) return node;
      return branchNode([...node.children], value);
    }
    const index = parseInt(key[0], 16);
    const child = this.#insert(node.children[index], path + key[0], key.slice(1), value);
    if (child === node.children[index]) return node;
    const children = [...node.children];
    children[index] = child;
    return branchNode(children, node.value);
  }

  #delete(ref, path, key) {
    if (ref === null) return null;
    return this.#replace(ref, path, (node) => this.#deleteFrom(node, path, key));
  }

  #deleteFrom(node, path, key) {
    if (node.kind === LEAF) return node.key === key ? null : node;
    if (node.kind === EXT) {
      if (!key.startsWith(node.key)) return node;
      const childPath = path + node.key;
      const child = this.#delete(node.child, childPath, key.slice(node.key.length));
      if (child === node.child) return node;
      return this.#joinExt(node.key, child, childPath);
    }
    let children = node.children;
    let value = node.value;
    if (key.length === 0) {
      if (!value) return node;
      value = null;
    } else {
      const index = parseInt(key[0], 16);
      const child = this.#delete(children[index], path + key[0], key.slice(1));
      if (child === children[index]) return node;
      children = [...children];
      children[index] = child;
    }
    const used = children.reduce((list, child, index) => (child ? [...list, index] : list), []);
    if (used.length >= 2 || (used.length === 1 && value)) return branchNode(children, value);
    if (used.length === 0) return value ? leafNode("", value) : null;
    // เหลือลูกตัวเดียว ไม่มีค่า → รวมกับลูก (ต้องโหลดมาดูชนิด)
    const nibble = used[0].toString(16);
    return this.#joinExt(nibble, children[used[0]], path + nibble);
  }

  /** extension(prefix) → child: รวม prefix เข้ากับลูกที่เป็น leaf / extension (ลูกย้ายขึ้นไปที่ path ของพ่อ) */
  #joinExt(prefix, child, childPath) {
    if (child === null) return null;
    const node = this.#resolve(child, childPath);
    if (node.kind === BRANCH) return extNode(prefix, child);   // branch อยู่ที่เดิม
    if (node.persisted) this.#gone.add(childPath);
    if (node.kind === LEAF) return leafNode(prefix + node.key, node.value);
    return extNode(prefix + node.key, node.child);
  }

  /** encode node ที่ dirty จากล่างขึ้นบน · node ที่ไม่ฝังในพ่อ (≥ 32 byte) + ราก → เขียนลง path ของมัน */
  #finalize(node, path, writes, written) {
    if (!node || node.stored || !node.dirty) return;
    if (node.kind === EXT) this.#finalize(node.child, path + node.key, writes, written);
    if (node.kind === BRANCH) node.children.forEach((child, index) => this.#finalize(child, path + index.toString(16), writes, written));
    node.enc = encodeNode(node);
    node.hash = undefined;
    node.dirty = false;
    if (node.enc.length >= 32 || path === "") {
      writes.push({ type: "put", dbKey: trieNodeKey(path), value: bytesToHex(node.enc) });
      written.add(path);
    }
  }

  /** หลักฐานของ dbKey: node ทุกตัวที่ถูกอ้างด้วย hash ตามทางจากรากถึง key (ราก ก่อน) */
  proof(dbKey) {
    let rest = this.keyOf(dbKey);
    let node = this.#fetch("");
    let path = "";
    const proof = [];
    if (node) proof.push(hex0x(node.enc));
    while (node) {
      if (node.stored) {
        node = this.#resolve(node, path);
        proof.push(hex0x(node.enc));
      }
      if (node.kind === LEAF) return { value: node.key === rest ? parseValue(node.value) : undefined, proof };
      if (node.kind === EXT) {
        if (!rest.startsWith(node.key)) return { value: undefined, proof };
        path += node.key;
        rest = rest.slice(node.key.length);
        node = node.child;
        continue;
      }
      if (rest.length === 0) return { value: node.value ? parseValue(node.value) : undefined, proof };
      path += rest[0];
      node = node.children[parseInt(rest[0], 16)];
      rest = rest.slice(1);
    }
    return { value: undefined, proof };
  }
}

const parseValue = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

/**
 * ตรวจหลักฐานกับ root (ไม่ต้องเชื่อ node ที่ส่งมา)
 *   → { exists: true, value } | { exists: false } · หลักฐานไม่ครบ / ไม่ตรง root = throw
 * keyOf: ค่าเริ่ม = secure (keccak ของ dbKey) เหมือนที่เชนใช้
 */
export function verifyProof(root, dbKey, proof, { keyOf = trieKeyOf } = {}) {
  if (String(root).toLowerCase() === EMPTY_ROOT) return { exists: false };
  const byHash = new Map(proof.map((node) => { const bytes = fromHex(node); return [bytesToHex(keccak_256(bytes)), bytes]; }));
  let rest = keyOf(dbKey);
  let ref = fromHex(root);
  for (;;) {
    let item;
    if (Array.isArray(ref)) {
      item = ref;                                        // node ที่ฝังในพ่อ
    } else {
      if (ref.length === 0) return { exists: false };
      const bytes = byHash.get(bytesToHex(ref));
      if (!bytes) throw new Error("หลักฐานไม่ครบ: ไม่มี node ที่ hash ตรงกับที่อ้างไว้");
      item = rlpDecode(bytes);
    }
    if (item.length === 17) {
      if (rest.length === 0) return item[16].length ? { exists: true, value: parseValue(item[16]) } : { exists: false };
      ref = item[parseInt(rest[0], 16)];
      rest = rest.slice(1);
      continue;
    }
    if (item.length !== 2) throw new Error("หลักฐานมี node ผิดรูปแบบ");
    const { leaf, nibbles } = fromHexPrefix(item[0]);
    if (leaf) return nibbles === rest ? { exists: true, value: parseValue(item[1]) } : { exists: false };
    if (!rest.startsWith(nibbles)) return { exists: false };
    rest = rest.slice(nibbles.length);
    ref = item[1];
  }
}
