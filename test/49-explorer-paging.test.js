import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import {
  slicePage, pageOf, pageBlocks, pageTransactionsTo, pageEvents, pageStorageMap, pageHolders, tokenHoldings,
} from "../src/node/explorer-api.js";

/* รายการของ explorer แบบแบ่งหน้า (กดเลขหน้า / ข้ามหน้า) + multiTransfer ของ token */

const T = "0x00000000000000000000000000000000000000f1";
const OWNER = "0x00000000000000000000000000000000000000a1";
const wallet = (i) => `0x${String(i + 1).padStart(40, "0")}`;

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { bigintValues: true, recordBlocks: true });
  let number = 0;
  const block = (fn) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: number * 1000, feeRecipient: OWNER });
    const results = fn(b);
    b.commit();
    return results;
  };
  const as = (who) => ({ sender: who, origin: who });
  block((b) => [
    b.deploy({ programUuid: T, code: TOKEN_PROGRAM, context: as(OWNER), initInput: { name: "Test", ticker: "TST", decimals: "2n", supply: "1000000n" } }),
    b.init({ programUuid: T }),
  ]).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  const call = (functionName, input) => block((b) => b.call({ programUuid: T, functionName, input, context: as(OWNER) }));
  return { vm, call, block };
}

test("slicePage / pageOf: นับหน้า, หน้าเกินท้าย → หน้าสุดท้าย, limit มีเพดาน", () => {
  const list = Array.from({ length: 45 }, (_, i) => i);
  assert.deepEqual(slicePage(list, { page: 3, limit: 20 }), { items: [40, 41, 42, 43, 44], total: 45, page: 3, pages: 3, limit: 20, truncated: false });
  assert.equal(slicePage(list, { page: 99, limit: 20 }).page, 3);
  assert.deepEqual(slicePage([], { page: 1, limit: 20 }), { items: [], total: 0, page: 1, pages: 1, limit: 20, truncated: false });
  assert.deepEqual(pageOf(new URLSearchParams("page=4&limit=500")), { page: 4, limit: 100 });
  assert.deepEqual(pageOf(new URLSearchParams("page=-2&limit=x")), { page: 1, limit: 20 });
});

test("multiTransfer: โอนหลายกระเป๋าใน tx เดียว · Transfer ต่อรายการ · ยอดไม่พอ → ล้มทั้ง tx", () => {
  const { vm, call } = chain();
  const transfers = Array.from({ length: 30 }, (_, i) => ({ to: wallet(i), amount: `${i + 1}n` }));
  const ok = call("multiTransfer", { transfers });
  assert.equal(ok.status, "success", JSON.stringify(ok.error));
  assert.equal(ok.result, "30n");
  assert.equal(ok.events.length, 30);
  assert.deepEqual(tokenHoldings(vm, wallet(29)).map((t) => t.balance), ["30n"]);

  const tooMuch = call("multiTransfer", { transfers: [{ to: wallet(0), amount: "1n" }, { to: wallet(1), amount: "99999999n" }] });
  assert.equal(tooMuch.status, "throw");
  assert.deepEqual(tokenHoldings(vm, wallet(0)).map((t) => t.balance), ["1n"]);   // รายการแรกถูกย้อนด้วย
  assert.equal(call("multiTransfer", { transfers: [] }).status, "throw");
});

test("pageHolders: ผู้ถือเรียงยอดมากไปน้อย ข้ามยอด 0 แบ่งหน้าได้ · ไม่ใช่ token → 404", () => {
  const { vm, call } = chain();
  call("multiTransfer", { transfers: Array.from({ length: 45 }, (_, i) => ({ to: wallet(i), amount: `${i + 1}n` })) });
  call("transfer", { to: wallet(50), amount: "5n" });
  // ย้ายยอดของ wallet(50) กลับจนเหลือ 0 → ไม่ถูกนับ
  const back = (() => { const b = vm.createBlock({ number: 4, timestamp: 4000, feeRecipient: OWNER }); const r = b.call({ programUuid: T, functionName: "transfer", input: { to: OWNER, amount: "5n" }, context: { sender: wallet(50), origin: wallet(50) } }); b.commit(); return r; })();
  assert.equal(back.status, "success");

  const first = pageHolders(vm, T, { page: 1, limit: 20 });
  assert.equal(first.total, 46);   // owner + 45
  assert.equal(first.pages, 3);
  assert.equal(first.items[0].address, OWNER);
  assert.deepEqual(first.items.slice(1, 3).map((h) => h.balance), ["45n", "44n"]);
  const last = pageHolders(vm, T, { page: 3, limit: 20 });
  assert.deepEqual(last.items.map((h) => h.balance), ["6n", "5n", "4n", "3n", "2n", "1n"]);
  assert.equal(pageHolders(vm, OWNER, { page: 1 }).status, 404);
});

test("pageBlocks / pageEvents / pageTransactionsTo / pageStorageMap: total และหน้าตรงกับข้อมูลจริง", () => {
  const { vm, call } = chain();
  for (let i = 0; i < 24; i += 1) call("transfer", { to: wallet(i), amount: "1n" });

  const blocks = pageBlocks(vm, { page: 2, limit: 10 });
  assert.deepEqual([blocks.total, blocks.pages, blocks.page], [25, 3, 2]);
  assert.deepEqual(blocks.items.map((b) => b.number), [15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
  assert.deepEqual(pageBlocks(vm, { page: 3, limit: 10 }).items.map((b) => b.number), [5, 4, 3, 2, 1]);

  const events = pageEvents(vm, T, { page: 1, limit: 10 }, "Transfer");
  assert.equal(events.total, 25);   // mint + 24
  assert.equal(events.items[0].data.to, wallet(23));   // ใหม่ไปเก่า

  const incoming = pageTransactionsTo(vm, T, { page: 3, limit: 10 });
  assert.equal(incoming.total, 26);   // deploy + init + 24 transfer
  assert.equal(incoming.items.length, 6);

  const balances = pageStorageMap(vm, T, "balances", { page: 2, limit: 20 });
  assert.equal(balances.total, 25);
  assert.equal(balances.items.length, 5);
  assert.ok(balances.items.every((item) => typeof item.key === "string" && item.value !== undefined));
});

test("listTransactionsTo: การเรียกซ้อนที่ล้มแต่ชั้นบน catch ไว้ → status ของชั้นนั้น = throw, txStatus = success", () => {
  const HOP = `function program() {
    function hop(params) {
      const { path, failAt, catchAt } = params.input
      const self = path[0]
      if (failAt === self) throw new Error("fail at " + self)
      if (path.length === 1) return [self]
      const next = () => runProgram(path[1], "hop", { ...params.input, path: path.slice(1) })
      if (catchAt !== self) return [self, ...next()]
      try { return [self, ...next()] } catch (e) { return [self, "caught"] }
    }
    return { hop }
  }`;
  const { vm, block } = chain();
  const id = (c) => `0x${c.repeat(40)}`;
  const [d, e, f] = [id("d"), id("e"), id("f")];
  block((b) => [d, e, f].flatMap((programUuid) => [
    b.deploy({ programUuid, code: HOP, context: { sender: OWNER, origin: OWNER } }), b.init({ programUuid }),
  ])).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));

  const caught = block((b) => b.call({ programUuid: d, functionName: "hop", input: { path: [d, e, f], failAt: f, catchAt: d }, context: { sender: OWNER, origin: OWNER } }));
  assert.equal(caught.status, "success", JSON.stringify(caught.error));
  const [toE] = vm.listTransactionsTo(e);
  assert.deepEqual([toE.depth, toE.status, toE.txStatus], [1, "throw", "success"]);
  const [toF] = vm.listTransactionsTo(f);
  assert.deepEqual([toF.depth, toF.status, toF.txStatus], [2, "throw", "success"]);
  assert.equal(vm.listTransactionsTo(d)[0].status, "success");   // ชั้นนอกสุด = สถานะของ tx

  const failed = block((b) => b.call({ programUuid: d, functionName: "hop", input: { path: [d, e, f], failAt: f }, context: { sender: OWNER, origin: OWNER } }));
  assert.equal(failed.status, "throw");
  assert.deepEqual([vm.listTransactionsTo(e)[0].status, vm.listTransactionsTo(e)[0].txStatus], ["throw", "throw"]);
});
