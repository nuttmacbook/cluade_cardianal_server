/* explorerscan/core/chain.js [ระบบ · ไม่ต้องแก้]
   อ่านข้อมูลจากเชน: api() เรียก HTTP API ของ node (ที่อยู่จาก EXPLORER.api ใน config.js)
   + การแบ่งหน้า (เลขหน้า / cursor) ที่จำไว้ต่อหน้า · ทุกหน้าใน ui/ อ่านข้อมูลผ่านไฟล์นี้ */

const api = (p, o) => fetch((EXPLORER.api || location.origin) + p, o).then((r) => r.json());

// ---------- pagination ----------
//   every long list is fetched one page at a time: { items, total, page, pages, limit }
//   page numbers are remembered per page of the explorer (location.hash) and per list
const pageState = {};
const pageKey = (id) => `${location.hash}|${id}`;
const pageOf = (id) => pageState[pageKey(id)] ?? 1;
function setPage(id, page) {
  const n = Math.floor(Number(page));
  if (!Number.isFinite(n) || n < 1) return;
  pageState[pageKey(id)] = n;
  render(true);
}
/** client-side paging for lists that arrive whole (txs of one block, tokens held) */
function slicePage(list, page, limit = 25) {
  const pages = Math.max(1, Math.ceil(list.length / limit));
  const current = Math.min(Math.max(page, 1), pages);
  return { items: list.slice((current - 1) * limit, current * limit), total: list.length, page: current, pages, limit };
}
/** page numbers to show: first, last, and two around the current page · gaps become "…" */
function pageNumbers(page, pages) {
  const set = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages));
  const list = [...set].sort((a, b) => a - b);
  return list.flatMap((n, i) => (i && n - list[i - 1] > 1 ? ["…", n] : [n]));
}
const paged = (path, id, limit = 20) => api(`${path}${path.includes("?") ? "&" : "?"}page=${pageOf(id)}&limit=${limit}`)
  .catch(() => ({ items: [], total: 0, page: 1, pages: 1, limit }));

// ---------- cursor pagination (same idea as the storage maps: the server reads only one page, no counting) ----------
//   { items, next } · the cursors of the pages seen so far are kept per explorer page + list, so "Newer" can go back
const cursorState = {};
const cursorStack = (id) => (cursorState[pageKey(id)] ??= [""]);
function cursorGo(id, step) {
  const stack = cursorStack(id);
  if (step > 0 && cursorNext[pageKey(id)]) stack.push(cursorNext[pageKey(id)]);
  else if (step < 0 && stack.length > 1) stack.pop();
  else return;
  render(true);
}
const cursorNext = {};
const cursored = (path, id, limit = 20) => {
  const stack = cursorStack(id);
  return api(`${path}${path.includes("?") ? "&" : "?"}limit=${limit}&cursor=${encodeURIComponent(stack.at(-1))}`)
    .catch(() => ({ items: [], next: null, limit }))
    .then((res) => { cursorNext[pageKey(id)] = res.next ?? null; return { ...res, pageNo: stack.length }; });
};
