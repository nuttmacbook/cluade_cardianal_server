import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { warmStats, clearWarmCache } from "../src/core/sandbox.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";

/*
 * ระยะ 2.4: snapshot อุ่นต่อโปรแกรม (src/core/sandbox.js warmImage) — ไม่คอมไพล์ factory ของโปรแกรมแรกของ tx ซ้ำทุก tx
 * ภาพอุ่น = ผลของ (snapshot ตั้งต้น, source) อย่างเดียว → มีใน cache หรือไม่ ผลของ tx ต้องเหมือนกันทุกไบต์
 * รวมจุดที่ OUT_OF_MEMORY (ขึ้นกับการจัดวาง heap) และแก๊สที่ใช้ถึงจุดนั้น
 */

const T = Date.parse("2026-01-01T00:00:00Z");
const A = "0x00000000000000000000000000000000000000a1";
const as = { sender: A, origin: A };
const HOG = `function program() {
  function initialization() {}
  function hog(params) { const keep = []; for (let i = 0; i < 1000000; i++) keep.push("x".repeat(1000) + i); return 0n }
  function leak(params) { const before = typeof globalThis.leaked; globalThis.leaked = 1; return before }
  function relay(params) { return runProgram("token", "balanceOf", { who: params.input.who }) }
  return { hog, leak, relay }
}`;

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { maxTxGas: 50_000_000, timeoutMs: 60_000, memoryLimitBytes: 4 * 1024 * 1024 });
  for (const [id, code, initInput] of [["hog", HOG, {}], ["token", TOKEN_PROGRAM, { name: "T", ticker: "T", decimals: "0n", supply: "1000n" }]]) {
    const deployed = vm.deploy({ programUuid: id, code, context: as, initInput }, { timestamp: T });
    assert.equal(deployed.status, "success", JSON.stringify(deployed.error));
    vm.commit(deployed.writes);
    vm.commit(vm.init({ programUuid: id }, { timestamp: T }).writes);
  }
  const call = (programUuid, functionName, input = {}) => {
    const res = vm.call({ programUuid, functionName, input, context: as }, { timestamp: T });
    return { status: res.status, code: res.error?.code ?? null, gasUsed: res.gasUsed, result: res.result, writes: res.writes };
  };
  return { call };
}

const SCRIPT = [["hog", "hog"], ["hog", "leak"], ["hog", "leak"], ["token", "balanceOf", { who: A }], ["hog", "relay", { who: A }], ["hog", "hog"]];
const play = () => {
  const { call } = chain();
  return SCRIPT.map(([id, fn, input]) => call(id, fn, input));
};

test("ภาพอุ่นมี / ไม่มีใน cache / ปิด cache: ผลทุก tx เหมือนกันทุกไบต์ (รวมจุด OUT_OF_MEMORY)", () => {
  const limit = warmStats.limit;
  try {
    clearWarmCache();
    const cold = play();                        // ทุกโปรแกรมสร้างภาพครั้งแรก
    const hitsBefore = warmStats.hits;
    const warm = play();                        // ใช้ภาพจาก cache
    assert.ok(warmStats.hits > hitsBefore);
    warmStats.limit = 0;
    clearWarmCache();
    const none = play();                        // ไม่จำภาพ: คอมไพล์ในที่ทุก tx ไม่คัดลอก memory
    assert.equal(warmStats.size, 0);
    warmStats.limit = 1;
    clearWarmCache();
    const thrash = play();                      // ภาพถูกไล่ทิ้งสลับกัน: miss / hit ปนกัน
    assert.deepEqual(warm, cold);
    assert.deepEqual(thrash, cold);
    assert.deepEqual(none, cold);
    assert.equal(cold[0].code, "OUT_OF_MEMORY");
    assert.equal(cold[5].gasUsed, cold[0].gasUsed);   // จุดเดียวกันทุกครั้ง
    assert.equal(cold[1].result, "undefined");        // global ของ tx ก่อนไม่ค้าง
    assert.equal(cold[2].result, "undefined");
    assert.equal(cold[4].status, "success");          // โปรแกรมที่สองของ tx คอมไพล์ใน tx ได้ตามปกติ
  } finally {
    warmStats.limit = limit;
  }
});

test("cache มีเพดาน: เกิน limit ทิ้งตัวที่ใช้นานที่สุด", () => {
  const limit = warmStats.limit;
  try {
    clearWarmCache();
    warmStats.limit = 1;
    const { call } = chain();
    call("hog", "leak");
    call("token", "balanceOf", { who: A });
    assert.equal(warmStats.size, 1);
    const misses = warmStats.misses;
    call("hog", "leak");                        // ถูกทิ้งไปแล้ว → สร้างใหม่
    assert.equal(warmStats.misses, misses + 1);
  } finally {
    warmStats.limit = limit;
  }
});
