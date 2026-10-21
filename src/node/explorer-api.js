/**
 * ข้อมูลที่ explorer ใช้แสดง storage ของโปรแกรม แยกตามจำนวนชั้นของ key
 *
 *   key 1 ชั้น   owner, price, supply          → แถบ program info (แสดงทุกตัวพร้อมค่า)
 *   key 2 ชั้น   balances:<address>, items:<id> → แถบ storage     (เลือก key แรกจาก dropdown แล้ว list key ที่ 2)
 *   key 3+ ชั้น  allow:<owner>:<spender>        → แถบ get storage (ไม่ list · กรอก key เองแล้วอ่านทีละตัว)
 *
 * แยกจาก server.js เพื่อให้เทสต์เรียกตรงกับ VM ได้โดยไม่ต้องเปิด server
 */
import { storageKey, map } from "../core/virtualmachine.js";
import { checkTokenStandard } from "../standards/token.js";
import { checkNftStandard } from "../standards/nft.js";
import { checkMultiTokenStandard } from "../standards/multitoken.js";

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
    return { status: 400, body: { error: `Enter 1–${MAX_KEY_PARTS} key parts, none empty` } };
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

// ---------- token ----------

/** ข้อมูล token ตามมาตรฐาน (src/standards/token.js) · ไม่ใช่ token → null */
export function tokenInfo(vm, program) {
  const address = lower(program);
  const code = vm.read(`${address}${SEP}code`);
  if (code === undefined || !checkTokenStandard(code).ok) return null;
  const read = (functionName, input = {}) => {
    const result = vm.query({ programUuid: address, functionName, input });
    return result.status === "success" ? result.result : null;
  };
  return { address, name: read("name"), ticker: read("ticker"), decimals: read("decimals"), totalSupply: read("totalSupply") };
}

/**
 * เหรียญที่ address นี้ถืออยู่: รายชื่อโปรแกรมมาจาก event Transfer ที่ส่งมาถึง address นี้ (ดัชนี holding:)
 * ยอดอ่านจาก balanceOf ของโปรแกรม · ยอด 0 ไม่แสดง
 */
export function tokenHoldings(vm, address) {
  const who = lower(address);
  const tokens = [];
  for (const { program } of vm.listHoldings(who)) {
    const info = tokenInfo(vm, program);
    if (!info) continue;
    const result = vm.query({ programUuid: program, functionName: "balanceOf", input: { who } });
    const balance = result.status === "success" ? result.result : null;
    if (balance === null || /^0n?$/.test(String(balance))) continue;
    tokens.push({ ...info, balance });
  }
  return tokens;
}

// ---------- NFT / multi-token ----------

/** มาตรฐานของโค้ด: "ERC-721" (src/standards/nft.js) | "ERC-1155" (src/standards/multitoken.js) | null */
export function collectionStandard(code) {
  if (code === undefined || code === null) return null;
  if (checkNftStandard(code).ok) return "ERC-721";
  return checkMultiTokenStandard(code).ok ? "ERC-1155" : null;
}

/** ข้อมูล NFT / multi-token ตามมาตรฐาน → { address, standard, name, symbol, totalSupply? } · ไม่ใช่ → null */
export function collectionInfo(vm, program) {
  const address = lower(program);
  const standard = collectionStandard(vm.read(`${address}${SEP}code`));
  if (!standard) return null;
  const read = (functionName) => {
    const result = vm.query({ programUuid: address, functionName, input: {} });
    return result.status === "success" ? result.result : null;
  };
  return { address, standard, name: read("name"), symbol: read("symbol"), ...(standard === "ERC-721" ? { totalSupply: read("totalSupply") } : {}) };
}

/**
 * NFT / multi-token ที่ address นี้ถืออยู่: โปรแกรมมาจากดัชนี holding: (event Transfer / TransferSingle / TransferBatch)
 * ชิ้นที่ถือมาจาก storage ของโปรแกรม — ERC-721: owned:<address>:<tokenId> · ERC-1155: balances:<address>:<id> (ยอด 0 ไม่แสดง)
 * → [{ program, standard, name, symbol, tokenId, amount, uri }]
 */
export function nftHoldings(vm, address, { limit = 200 } = {}) {
  const who = lower(address);
  const items = [];
  for (const { program } of vm.listHoldings(who)) {
    const info = collectionInfo(vm, program);
    if (!info) continue;
    const nft = info.standard === "ERC-721";
    const prefix = `${baseOf(program)}${nft ? "owned" : "balances"}${SEP}${encodeURIComponent(who)}${SEP}`;
    for (const dbKey of vm.listKeys(prefix, { limit: limit - items.length })) {
      const id = decodeURIComponent(dbKey.slice(prefix.length));
      if (id.includes(SEP)) continue;
      const amount = nft ? "1n" : vm.read(dbKey);
      if (bigOf(amount) <= 0n) continue;
      const uri = vm.query({ programUuid: info.address, functionName: nft ? "tokenURI" : "uri", input: nft ? { tokenId: `${id}n` } : { id: `${id}n` } });
      items.push({ program: info.address, standard: info.standard, name: info.name, symbol: info.symbol, tokenId: `${id}n`, amount,
        uri: uri.status === "success" ? uri.result : null });
    }
    if (items.length >= limit) break;
  }
  return items;
}

// ---------- แบ่งหน้า (explorer กดเลขหน้า / ข้ามหน้าได้) ----------

export const PAGE_SCAN = 50_000;   // นับ key ไม่เกินเท่านี้ต่อรายการ (เกินแล้วตอบ truncated: true)
export const MAX_PAGE_SIZE = 100;

/** อ่าน page / limit จาก query string · page เริ่มที่ 1 */
export function pageOf(query) {
  const limit = Math.min(Math.max(Number(query?.get?.("limit")) || 20, 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.floor(Number(query?.get?.("page"))) || 1, 1);
  return { page, limit };
}

/** ตัดหน้า: items ของหน้านั้น + จำนวนทั้งหมด · page เกินหน้าสุดท้าย → หน้าสุดท้าย */
export function slicePage(list, { page = 1, limit = 20 } = {}, { truncated = false } = {}) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(Math.max(page, 1), pages);
  return { items: list.slice((current - 1) * limit, current * limit), total, page: current, pages, limit, truncated };
}

/** key ใต้ prefix แบบแบ่งหน้า (ใหม่ไปเก่า) → อ่านค่าเฉพาะ key ของหน้านั้น */
function pageEntries(vm, prefix, paging, { sort } = {}) {
  const keys = vm.listKeys(prefix, { limit: PAGE_SCAN + 1, reverse: true });
  const truncated = keys.length > PAGE_SCAN;
  const list = keys.slice(0, PAGE_SCAN);
  if (sort) list.sort(sort);
  const result = slicePage(list, paging, { truncated });
  return { ...result, items: result.items.map((dbKey) => vm.read(dbKey)) };
}

/** header ของ block ใหม่ไปเก่า · คำนวณจากเลข block จึงไม่ต้องไล่ key */
export function pageBlocks(vm, { page = 1, limit = 20 } = {}) {
  const total = vm.latestBlockNumber() ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(Math.max(page, 1), pages);
  const items = [];
  for (let n = total - (current - 1) * limit; n > 0 && items.length < limit; n -= 1) {
    const block = vm.getBlock(n);
    if (block) items.push(block);
  }
  return { items, total, page: current, pages, limit, truncated: false };
}

/** tx ที่ address นี้ส่ง · nonce ใน key ไม่ได้เติม 0 ข้างหน้า จึงเรียงด้วยตัวเลขของ nonce (มากไปน้อย) */
export function pageTransactionsOf(vm, address, paging) {
  const nonceOf = (dbKey) => Number(dbKey.split(SEP)[2]);
  return pageEntries(vm, `${lower(address)}${SEP}txn${SEP}`, paging, { sort: (a, b) => nonceOf(b) - nonceOf(a) });
}

/** tx ที่เข้ามาหา address นี้ (ได้รับเงิน / โปรแกรมถูกเรียก) */
export const pageTransactionsTo = (vm, address, paging) => pageEntries(vm, `txto${SEP}${lower(address)}${SEP}`, paging);

/** event ที่โปรแกรม emit · name = เฉพาะชื่อนั้น */
export const pageEvents = (vm, program, paging, name = "") =>
  pageEntries(vm, `event${SEP}${lower(program)}${SEP}${name ? `${name}${SEP}` : ""}`, paging);

/** รายการใน key 2 ชั้นของกลุ่ม name แบบแบ่งหน้า (ข้าม key 3 ชั้นขึ้นไป) */
export function pageStorageMap(vm, address, name, paging) {
  const prefix = `${baseOf(address)}${encodeURIComponent(name)}${SEP}`;
  const keys = vm.listKeys(prefix, { limit: PAGE_SCAN + 1 });
  const truncated = keys.length > PAGE_SCAN;
  const list = keys.slice(0, PAGE_SCAN).filter((dbKey) => !dbKey.slice(prefix.length).includes(SEP));
  const result = slicePage(list, paging, { truncated });
  return { name, ...result, items: result.items.map((dbKey) => ({ key: decodeURIComponent(dbKey.slice(prefix.length)), value: vm.read(dbKey) })) };
}

const bigOf = (value) => { try { return BigInt(String(value ?? 0).replace(/n$/, "")); } catch { return 0n; } };

/** ผู้ถือ token: อ่านจาก balances:<address> ของโปรแกรม · ข้ามยอด 0 · ยอดมากไปน้อย */
export function pageHolders(vm, program, paging) {
  if (!tokenInfo(vm, program)) return { status: 404, body: { error: "Not a standard token" } };
  const prefix = `${baseOf(program)}balances${SEP}`;
  const keys = vm.listKeys(prefix, { limit: PAGE_SCAN + 1 });
  const truncated = keys.length > PAGE_SCAN;
  const holders = keys.slice(0, PAGE_SCAN)
    .map((dbKey) => ({ address: decodeURIComponent(dbKey.slice(prefix.length)), balance: vm.read(dbKey) }))
    .filter(({ address, balance }) => !address.includes(SEP) && bigOf(balance) > 0n)
    .sort((a, b) => { const d = bigOf(b.balance) - bigOf(a.balance); return d > 0n ? 1 : d < 0n ? -1 : a.address.localeCompare(b.address); });
  return slicePage(holders, paging, { truncated });
}

// ---------- โปรแกรม: อนุมัติแล้ว / รออนุมัติ ----------

/**
 * address ของโปรแกรมที่อนุมัติแล้ว (มี <address>:this หลัง init) · ไม่มีดัชนีรวม จึงไล่ทีละ address:
 * อ่าน key แรกของ address แล้วกระโดดข้าม key ที่เหลือของ address นั้นทั้งหมด (";" อยู่ถัดจาก ":")
 * → อ่าน 1 key ต่อ address ไม่ใช่ทุก key ของทุกกระเป๋า
 */
export function approvedProgramAddresses(vm) {
  const programs = [];
  let start = "0x";
  for (;;) {
    const [dbKey] = vm.listKeys("0x", { start, limit: 1 });
    if (dbKey === undefined) break;
    const [address] = dbKey.split(SEP);
    if (vm.read(`${address}${SEP}this`) !== undefined) programs.push(address);
    start = `${address};`;
  }
  return programs;
}

/** จำนวนโปรแกรม { approved, pending } */
export function programCounts(vm) {
  return { approved: approvedProgramAddresses(vm).length, pending: vm.listKeys(`pending${SEP}`).length };
}

const codeSize = (code) => Buffer.byteLength(String(code ?? ""), "utf8");
/** { collection: "ERC-721" | "ERC-1155" } เฉพาะโปรแกรม NFT / multi-token (อย่างอื่นไม่มีฟิลด์นี้) */
const collectionField = (code) => { const standard = collectionStandard(code); return standard ? { collection: standard } : {}; };

/** โปรแกรมที่ deploy แล้วรอทีมงานอนุมัติ (init) หรือปฏิเสธ (reject) · เรียงตาม address */
export function pagePendingPrograms(vm, paging) {
  const prefix = `pending${SEP}`;
  const keys = vm.listKeys(prefix, { limit: PAGE_SCAN + 1 });
  const result = slicePage(keys.slice(0, PAGE_SCAN), paging, { truncated: keys.length > PAGE_SCAN });
  return { ...result, items: result.items.map((dbKey) => {
    const pending = vm.read(dbKey) ?? {};
    return { address: dbKey.slice(prefix.length), deployer: pending.context?.sender ?? null, name: pending.metadata?.namespace ?? pending.initInput?.namespace ?? null,
      value: pending.value ?? 0, codeSize: codeSize(pending.code), token: checkTokenStandard(pending.code ?? "").ok,
      ...collectionField(pending.code) };
  }) };
}

/** โปรแกรมที่อนุมัติแล้ว · ใหม่ไปเก่าตามเวลาที่อนุมัติ (createdAt) */
export function pageApprovedPrograms(vm, paging) {
  const programs = approvedProgramAddresses(vm).map((address) => ({ address, metadata: vm.getMetadata(address) }))
    .sort((a, b) => (Number(b.metadata.createdAt) || 0) - (Number(a.metadata.createdAt) || 0) || a.address.localeCompare(b.address));
  const result = slicePage(programs, paging);
  return { ...result, items: result.items.map(({ address, metadata }) => {
    const code = vm.read(`${address}${SEP}code`);
    return { address, name: metadata.namespace ?? null, creator: metadata.creator ?? null, createdAt: metadata.createdAt ?? null,
      codeSize: codeSize(code), token: checkTokenStandard(code ?? "").ok, ...collectionField(code) };
  }) };
}
