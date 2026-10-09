/**
 * ข้อมูลที่ explorer ใช้แสดง storage ของโปรแกรม แยกตามจำนวนชั้นของ key
 *
 *   key 1 ชั้น   owner, price, supply          → แถบ variable   (แสดงทุกตัวพร้อมค่า)
 *   key 2 ชั้น   balances:<address>, items:<id> → แถบ contract    (เลือก key แรกจาก dropdown แล้ว list key ที่ 2)
 *   key 3+ ชั้น  allow:<owner>:<spender>        → แถบ get storage (ไม่ list · กรอก key เองแล้วอ่านทีละตัว)
 *
 * แยกจาก server.js เพื่อให้เทสต์เรียกตรงกับ VM ได้โดยไม่ต้องเปิด server
 */
import { storageKey, map } from "../core/virtualmachine.js";

const SEP = ":";
export const SCAN_LIMIT = 20_000;   // ไล่ key ไม่เกินเท่านี้ต่อครั้ง (เกินแล้วตอบ truncated: true)
export const MAX_VARIABLES = 200;
export const MAX_KEY_PARTS = 16;

const lower = (value) => String(value ?? "").toLowerCase();
const baseOf = (address) => `${lower(address)}${SEP}storage${SEP}`;
const decode = (parts) => parts.map(decodeURIComponent);

/** โครงของ storage: variable (พร้อมค่า) + ชื่อกลุ่ม 2 ชั้น + ชื่อกลุ่ม 3 ชั้นขึ้นไป */
export function storageLayout(vm, address, { scanLimit = SCAN_LIMIT } = {}) {
  const base = baseOf(address);
  const keys = vm.listKeys(base, { limit: scanLimit + 1 });
  const truncated = keys.length > scanLimit;
  const variables = [];
  const maps = new Map();
  const deep = new Map();

  for (const dbKey of keys.slice(0, scanLimit)) {
    const parts = dbKey.slice(base.length).split(SEP);
    const [name] = decode(parts);
    if (parts.length === 1) { if (variables.length < MAX_VARIABLES) variables.push(dbKey); continue; }
    const group = parts.length === 2 ? maps : deep;
    const entry = group.get(name) ?? { name, count: 0, depth: parts.length };
    entry.count += 1;
    entry.depth = Math.max(entry.depth, parts.length);
    group.set(name, entry);
  }

  return {
    variables: variables.map((dbKey) => ({ key: decodeURIComponent(dbKey.slice(base.length)), value: vm.read(dbKey) })),
    maps: [...maps.values()].map(({ name, count }) => ({ name, count })),
    deep: [...deep.values()],
    scanned: Math.min(keys.length, scanLimit),
    truncated,
  };
}

/** รายการใน key 2 ชั้นของกลุ่ม name: [{ key: key ที่ 2, value }] + cursor หน้าถัดไป */
export function storageMap(vm, address, name, { limit = 50, start } = {}) {
  const prefix = `${baseOf(address)}${encodeURIComponent(name)}${SEP}`;
  const items = [];
  let cursor = start?.startsWith(prefix) ? start : undefined;
  // key 3 ชั้นที่อยู่ในกลุ่มเดียวกันถูกข้าม จึงต้องอ่านเป็นช่วง ๆ · อ่านเกิน 1 ตัวเพื่อรู้ว่ามีหน้าถัดไปไหม
  while (items.length <= limit) {
    const chunk = vm.listKeys(prefix, { start: cursor, limit: 200 });
    const fresh = cursor && chunk[0] === cursor ? chunk.slice(1) : chunk;   // start รวมตัวมันเองด้วย
    for (const dbKey of fresh) {
      const rest = dbKey.slice(prefix.length);
      if (!rest.includes(SEP)) items.push({ dbKey, key: decodeURIComponent(rest) });
      if (items.length > limit) break;
    }
    if (chunk.length < 200) break;
    cursor = chunk.at(-1);
  }
  const page = items.slice(0, limit);
  return {
    name,
    items: page.map(({ dbKey, key }) => ({ key, value: vm.read(dbKey) })),
    next: items.length > limit ? page.at(-1).dbKey : null,
  };
}

/** อ่านค่าของ key เดียว (ใส่ครบทุกชั้น) */
export function storageGet(vm, address, parts) {
  if (!parts.length || parts.length > MAX_KEY_PARTS || parts.some((part) => part === "")) {
    return { status: 400, body: { error: `ต้องใส่ key 1–${MAX_KEY_PARTS} ชั้น และห้ามเว้นว่าง` } };
  }
  const dbKey = storageKey(lower(address), parts.length === 1 ? parts[0] : map(...parts));
  const value = vm.read(dbKey);
  return { key: decode(dbKey.slice(baseOf(address).length).split(SEP)), exists: value !== undefined, value: value ?? null };
}

/** address ไหนเป็นโปรแกรม (มีโค้ดอยู่ หรือ deploy แล้วรอ init) → { "<address>": true | false } */
export function programFlags(vm, addresses) {
  return Object.fromEntries(addresses.slice(0, 200).map((value) => {
    const address = lower(value);
    return [address, vm.read(`${address}${SEP}code`) !== undefined || vm.read(`pending${SEP}${address}`) !== undefined];
  }));
}
