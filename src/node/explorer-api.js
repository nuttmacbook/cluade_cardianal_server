/**
 * Data the explorer uses to show a program's storage, grouped by the number of key parts
 *
 *   1-part key   owner, price, supply          → program info tab (shows all with values)
 *   2-part key   balances:<address>, items:<id> → storage tab     (pick the first part from a dropdown, then list the 2nd parts)
 *   3+-part key  allow:<owner>:<spender>        → get storage tab (not listed · type the key and read one at a time)
 *
 * Separate from server.js so tests can call it directly against the VM without starting the server
 */
import { storageKey, map, toEvmAbi } from "../core/virtualmachine.js";
import { checkTokenStandard } from "../standards/token.js";
import { checkNftStandard } from "../standards/nft.js";
import { checkMultiTokenStandard } from "../standards/multitoken.js";
import { resolveAbi } from "../standards/system-abi.js";

const SEP = ":";
export const SCAN_LIMIT = 20_000;   // scan at most this many keys per call (beyond that answers truncated: true)
export const MAX_VARIABLES = 200;
export const MAX_KEY_PARTS = 16;

const lower = (value) => String(value ?? "").toLowerCase();
const baseOf = (address) => `${lower(address)}${SEP}storage${SEP}`;
const decode = (parts) => parts.map(decodeURIComponent);

/** storage layout: variables (with values) + 2-part group names + 3+-part group names */
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

/** entries of 2-part keys in group name: [{ key: the 2nd part, value }] + cursor for the next page */
export function storageMap(vm, address, name, { limit = 50, start } = {}) {
  const prefix = `${baseOf(address)}${encodeURIComponent(name)}${SEP}`;
  const items = [];
  let cursor = start?.startsWith(prefix) ? start : undefined;
  // 3-part keys in the same group are skipped, so read in chunks · read one extra to know whether there is a next page
  while (items.length <= limit) {
    const chunk = vm.listKeys(prefix, { start: cursor, limit: 200 });
    const fresh = cursor && chunk[0] === cursor ? chunk.slice(1) : chunk;   // start includes itself
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

/** read the value of a single key (all parts given) */
export function storageGet(vm, address, parts) {
  if (!parts.length || parts.length > MAX_KEY_PARTS || parts.some((part) => part === "")) {
    return { status: 400, body: { error: `Enter 1–${MAX_KEY_PARTS} key parts, none empty` } };
  }
  const dbKey = storageKey(lower(address), parts.length === 1 ? parts[0] : map(...parts));
  const value = vm.read(dbKey);
  return { key: decode(dbKey.slice(baseOf(address).length).split(SEP)), exists: value !== undefined, value: value ?? null };
}

/** which addresses are programs (have code, or deployed and awaiting init) → { "<address>": true | false } */
export function programFlags(vm, addresses) {
  return Object.fromEntries(addresses.slice(0, 200).map((value) => {
    const address = lower(value);
    return [address, vm.read(`${address}${SEP}code`) !== undefined || vm.read(`pending${SEP}${address}`) !== undefined];
  }));
}

// ---------- token ----------

/** token info per the standard (src/standards/token.js) · not a token → null */
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
 * Coins this address holds: the program list comes from Transfer events sent to this address (holding: index)
 * balances read from the program's balanceOf · zero balances are hidden
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

/** code standard: "ERC-721" (src/standards/nft.js) | "ERC-1155" (src/standards/multitoken.js) | null */
export function collectionStandard(code) {
  if (code === undefined || code === null) return null;
  if (checkNftStandard(code).ok) return "ERC-721";
  return checkMultiTokenStandard(code).ok ? "ERC-1155" : null;
}

/** NFT / multi-token info per the standard → { address, standard, name, symbol, totalSupply? } · not one → null */
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
 * NFTs / multi-tokens this address holds: programs come from the holding: index (events Transfer / TransferSingle / TransferBatch)
 * held items come from the program's storage — ERC-721: owned:<address>:<tokenId> · ERC-1155: balances:<address>:<id> (zero balances hidden)
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

// ---------- pagination (the explorer can click page numbers / jump pages) ----------

export const PAGE_SCAN = 50_000;   // count at most this many keys per list (beyond that answers truncated: true)
export const MAX_PAGE_SIZE = 100;

/** read page / limit from the query string · page starts at 1 */
export function pageOf(query) {
  const limit = Math.min(Math.max(Number(query?.get?.("limit")) || 20, 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.floor(Number(query?.get?.("page"))) || 1, 1);
  return { page, limit };
}

/** slice a page: that page's items + total count · page past the last page → the last page */
export function slicePage(list, { page = 1, limit = 20 } = {}, { truncated = false } = {}) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(Math.max(page, 1), pages);
  return { items: list.slice((current - 1) * limit, current * limit), total, page: current, pages, limit, truncated };
}

/** keys under a prefix, paginated (newest to oldest) → reads values only for that page's keys */
function pageEntries(vm, prefix, paging, { sort, read = (dbKey) => vm.read(dbKey) } = {}) {
  const keys = vm.listKeys(prefix, { limit: PAGE_SCAN + 1, reverse: true });
  const truncated = keys.length > PAGE_SCAN;
  const list = keys.slice(0, PAGE_SCAN);
  if (sort) list.sort(sort);
  const result = slicePage(list, paging, { truncated });
  return { ...result, items: result.items.map(read) };
}

/** block headers newest to oldest · computed from block numbers, so no key scan */
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

/** txs this address sent · the nonce in the key isn't zero-padded, so sort by nonce numerically (descending) */
export function pageTransactionsOf(vm, address, paging) {
  const nonceOf = (dbKey) => Number(dbKey.split(SEP)[2]);
  return pageEntries(vm, `${lower(address)}${SEP}txn${SEP}`, paging, { sort: (a, b) => nonceOf(b) - nonceOf(a), read: (dbKey) => vm.readTransactionRecord(dbKey) });
}

/** txs coming into this address (received funds / program was called) */
export function pageTransactionsTo(vm, address, paging) {
  const headers = new Map();
  return pageEntries(vm, `txto${SEP}${lower(address)}${SEP}`, paging, { read: (dbKey) => vm.readTransactionTo(dbKey, headers) });
}

/** events the program emitted · name = only that name */
export const pageEvents = (vm, program, paging, name = "") =>
  pageEntries(vm, `event${SEP}${lower(program)}${SEP}${name ? `${name}${SEP}` : ""}`, paging);

/** entries of 2-part keys in group name, paginated (skipping 3+-part keys) */
export function pageStorageMap(vm, address, name, paging) {
  const prefix = `${baseOf(address)}${encodeURIComponent(name)}${SEP}`;
  const keys = vm.listKeys(prefix, { limit: PAGE_SCAN + 1 });
  const truncated = keys.length > PAGE_SCAN;
  const list = keys.slice(0, PAGE_SCAN).filter((dbKey) => !dbKey.slice(prefix.length).includes(SEP));
  const result = slicePage(list, paging, { truncated });
  return { name, ...result, items: result.items.map((dbKey) => ({ key: decodeURIComponent(dbKey.slice(prefix.length)), value: vm.read(dbKey) })) };
}

const bigOf = (value) => { try { return BigInt(String(value ?? 0).replace(/n$/, "")); } catch { return 0n; } };

/** token holders: read from the program's balances:<address> · skips zero balances · largest first */
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

// ---------- programs: approved / pending approval ----------

/**
 * addresses of approved programs (have <address>:this after init) · there's no combined index, so walk address by address:
 * read an address's first key, then skip all of that address's remaining keys (";" sorts right after ":")
 * → reads 1 key per address, not every key of every wallet
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

/** number of programs { approved, pending } */
export function programCounts(vm) {
  return { approved: approvedProgramAddresses(vm).length, pending: vm.listKeys(`pending${SEP}`).length };
}

const codeSize = (code) => Buffer.byteLength(String(code ?? ""), "utf8");
/** { collection: "ERC-721" | "ERC-1155" } only for NFT / multi-token programs (others don't have this field) */
const collectionField = (code) => { const standard = collectionStandard(code); return standard ? { collection: standard } : {}; };

/** programs deployed and awaiting team approval (init) or rejection (reject) · sorted by address */
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

/** one program awaiting review, with its source (for the admin to read before init / reject) → null when not pending */
export function pendingProgram(vm, address) {
  const pending = vm.read(`pending${SEP}${String(address).toLowerCase()}`);
  if (!pending) return null;
  return { address: String(address).toLowerCase(), deployer: pending.context?.sender ?? null,
    name: pending.metadata?.namespace ?? pending.initInput?.namespace ?? null, value: pending.value ?? 0, code: pending.code ?? "" };
}

/** approved programs · newest to oldest by approval time (createdAt) */
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

// ---------- cursor-based (like the storage tab): reads only limit + 1 keys per call, no need to count the whole list ----------

/** read limit / cursor from the query string */
export function cursorOf(query) {
  const limit = Math.min(Math.max(Math.floor(Number(query?.get?.("limit"))) || 20, 1), MAX_PAGE_SIZE);
  return { limit, cursor: query?.get?.("cursor") || undefined };
}

/** newest to oldest → { items, next } · next = dbKey of the next page's first item (pass back as cursor) · null = done */
export function cursorEntries(vm, prefix, { limit = 20, cursor } = {}, map = (dbKey) => vm.read(dbKey)) {
  const start = typeof cursor === "string" && cursor.startsWith(prefix) ? cursor : undefined;   // a cursor from another list = start over
  const keys = vm.listKeys(prefix, { limit: limit + 1, reverse: true, start });
  return { items: keys.slice(0, limit).map(map), next: keys.length > limit ? keys[limit] : null, limit };
}

/** txs coming into an address / program (including nested calls), cursor-based */
export function cursorTransactionsTo(vm, address, options) {
  const headers = new Map();
  return cursorEntries(vm, `txto${SEP}${lower(address)}${SEP}`, options, (dbKey) => vm.readTransactionTo(dbKey, headers));
}

/** query string params other than paging controls (name / page / limit / cursor) = filters on indexed fields → [[field, value], ...] · none → null */
export function indexedFilterOf(query) {
  const filters = [...(query?.entries?.() ?? [])].filter(([key]) => !["name", "page", "limit", "cursor"].includes(key));
  return filters.length ? filters : null;
}

/**
 * events whose indexed fields have the requested values (GET /program/:a/events?name=Transfer&to=0x…), cursor-based → { items, next }
 *   uses the index of the first field (doesn't scan all events), then filters the remaining fields from the event data
 *   name is required · fields not emitted as indexed → not found (no index)
 */
export function cursorIndexedEvents(vm, program, name, filters, { limit = 20, cursor } = {}) {
  if (!name) return { status: 400, body: { error: "Filtering by field needs ?name=<event>" } };
  const [[field, value], ...rest] = filters;
  const matches = (event) => rest.every(([key, wanted]) => {
    const actual = event?.data?.[key];
    return String(actual ?? "").toLowerCase() === String(wanted).toLowerCase() || String(actual) === `${wanted}n`;
  });
  // read chunk by chunk until limit is reached (other fields may filter some out)
  const items = [];
  let next = cursor;
  do {
    const page = vm.listIndexedEvents({ program, name, field, value, limit: Math.max(limit, 20), cursor: next });
    for (const event of page.items) {
      if (items.length === limit) return { items, next: eventKeyOf(event), limit, field };
      if (matches(event)) items.push(event);
    }
    next = page.next;
  } while (next && items.length < limit);
  return { items, next: next ?? null, limit, field };
}
const eventKeyOf = (event) => `event${SEP}${event.program}${SEP}${event.name}${SEP}${String(event.blockNumber).padStart(12, "0")}${SEP}${String(event.txIndex).padStart(4, "0")}${SEP}${String(event.index).padStart(4, "0")}`;

/** a program's ABI (metadata.abi) → { address, abi, evmAbi } · not declared → abi: null */
export function programAbi(vm, program) {
  const address = lower(program);
  const abi = resolveAbi((dbKey) => vm.read(dbKey), address);   // declared ?? bundled program (src/standards/system-abi.js)
  return { address, abi, evmAbi: abi ? toEvmAbi(abi) : null };
}

/** a program's events, cursor-based · name = only that name */
export const cursorEvents = (vm, program, options, name = "") =>
  cursorEntries(vm, `event${SEP}${lower(program)}${SEP}${name ? `${name}${SEP}` : ""}`, options);

// ---------- storage groups (counts every key, in chunks) ----------

export const GROUP_SCAN = 20_000;      // keys per request by default
export const MAX_GROUP_SCAN = 50_000;  // cap per request

/**
 * count storage keys by first key part, chunk by chunk (at most scan keys per request → bounded cost per request)
 *   → { total, groups: [{ name, count }], scanned, next, complete }
 * total / groups = this chunk only · not finished (next is not null) → send cursor=next again and add the totals yourself
 */
export function storageGroups(vm, address, { cursor, scan = GROUP_SCAN } = {}) {
  const base = baseOf(address);
  const limit = Math.min(Math.max(Math.floor(Number(scan)) || GROUP_SCAN, 1), MAX_GROUP_SCAN);
  const start = typeof cursor === "string" && cursor.startsWith(base) ? cursor : undefined;
  const keys = vm.listKeys(base, { start, limit: limit + 1 });
  const counts = new Map();
  for (const dbKey of keys.slice(0, limit)) {
    const [head] = dbKey.slice(base.length).split(SEP);
    counts.set(head, (counts.get(head) ?? 0) + 1);
  }
  const scanned = Math.min(keys.length, limit);
  const next = keys.length > limit ? keys[limit] : null;
  return { total: scanned, groups: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1)),
    scanned, next, complete: next === null };
}

// ---------- rejected txs (recorded in blocks) ----------

export const REJECTED_SCAN_BLOCKS = 1000;   // scan at most this many blocks per request (no address given)

/**
 * rejected txs, newest to oldest → { items, next }
 *   address = only this sender's (rejfrom: index · cursor = dbKey)
 *   not given = the whole chain, walking blocks newest to oldest (cursor = "<block>:<index>"), at most REJECTED_SCAN_BLOCKS blocks per call
 *            the cap was reached before limit was filled → fewer items than limit, with next to continue
 */
export function pageRejected(vm, { address, limit = 20, cursor } = {}) {
  if (address) return cursorEntries(vm, `rejfrom${SEP}${lower(address)}${SEP}`, { limit, cursor });
  const latest = vm.latestBlockNumber() ?? 0;
  const [rawBlock, rawIndex] = String(cursor ?? "").split(SEP);
  let number = Number(rawBlock) > 0 && Number.isSafeInteger(Number(rawBlock)) ? Math.min(Number(rawBlock), latest) : latest;
  let from = rawIndex !== undefined && rawIndex !== "" && Number.isSafeInteger(Number(rawIndex)) ? Number(rawIndex) : Infinity;
  const items = [];
  for (let scanned = 0; number > 0 && scanned < REJECTED_SCAN_BLOCKS; number -= 1, scanned += 1, from = Infinity) {
    const header = vm.getBlock(number);
    if (!header?.rejectedCount) continue;
    const list = vm.getBlockRejected(number);
    for (let index = Math.min(from, list.length - 1); index >= 0; index -= 1) {
      if (items.length === limit) return { items, next: `${number}${SEP}${index}`, limit };
      items.push({ ...list[index], blockNumber: number, index, timestamp: header.timestamp });
    }
  }
  return { items, next: number > 0 ? String(number) : null, limit };
}
