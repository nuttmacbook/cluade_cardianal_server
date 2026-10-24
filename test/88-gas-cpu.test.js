import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { measure, WORKLOADS, MAX_TX_GAS } from "../scripts/bench-gas.js";

/*
 * ระยะ 2.2: แก๊สตามงาน CPU (วัดด้วย npm run bench:gas — scripts/bench-gas.js)
 * งานที่เคย "ถูกแต่ช้า" (เวลาต่อแก๊สเกิน baseline หลายสิบเท่า) ถูกคิดเพิ่ม:
 *   JSON.stringify ซ้อนลึก (เดิม 275 เท่า: tx 3M แก๊สใช้ 47 วิ) · Map / Set ที่ key เป็น string ยาว (68 เท่า) · switch / === / < กับ string ยาว (13–16 เท่า)
 *   sort ปริยาย (14) · flat ลึก (12) · normalize (11) · JSON.parse
 * เทสต์นี้คุมสูตรแก๊ส (ค่าแน่นอน) + เวลาแบบหลวม ๆ ของงานที่แย่ที่สุด (tx เต็ม 3M แก๊สต้องจบในไม่กี่วินาที)
 */

const T = Date.parse("2026-01-01T00:00:00Z");
const A = "0x00000000000000000000000000000000000000a1";
const as = { sender: A, origin: A };

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { maxTxGas: MAX_TX_GAS, timeoutMs: 60_000 });
  const run = (body, setupCode = "") => {
    const code = `function program() {
      function initialization() {}
      function f(params) { ${setupCode}; ${body}; return 0n }
      function base(params) { ${setupCode}; return 0n }
      return { f, base }
    }`;
    const id = `p${Math.random().toString(36).slice(2, 8)}`;
    const deployed = vm.deploy({ programUuid: id, code, context: as }, { timestamp: T });
    assert.equal(deployed.status, "success", JSON.stringify(deployed.error));
    vm.commit(deployed.writes);
    vm.commit(vm.init({ programUuid: id }, { timestamp: T }).writes);
    const gas = (fn) => vm.call({ programUuid: id, functionName: fn, input: {}, context: as }, { timestamp: T }).gasUsed;
    return gas("f") - gas("base");
  };
  return { run };
}

test("string ยาว: === / < / == / switch คิดตามความยาว · string สั้นแก๊สเท่าเดิม", () => {
  const { run } = setup();
  const S = "const K = 'k'.repeat(32000); const J = 'k'.repeat(32000); let x";
  const SHORT = "const K = 'k'.repeat(32); const J = 'k'.repeat(32); let x";
  // 32,000 ตัวอักษร = 1,000 หน่วย · 32 ตัวแรกรวมใน operator → คิดเพิ่ม 999
  const extra = 999;
  assert.equal(run("x = K === J", S) - run("x = K === J", SHORT), extra);
  assert.equal(run("x = K !== J", S) - run("x = K !== J", SHORT), extra);
  assert.equal(run("x = K < J", S) - run("x = K < J", SHORT), extra);
  assert.equal(run("x = K == J", S) - run("x = K == J", SHORT), extra);
  assert.equal(run("switch (K) { case J: x = 1; break; case 'a': x = 2 }", S) - run("switch (K) { case J: x = 1; break; case 'a': x = 2 }", SHORT), 2 * extra);
  // ความยาวต่างกัน: === รู้ทันที ไม่คิดเพิ่ม · ข้างหนึ่งเป็นค่าคงที่: ไม่ครอบเลย
  assert.equal(run("x = K === J + 'z'", S) - run("x = K === J + 'z'", SHORT), run("const t = J + 'z'", S) - run("const t = J + 'z'", SHORT));
  assert.equal(run("x = K === 'abc'", S), run("x = K === 'abc'", SHORT));
});

test("Map / Set: key string ยาวคิดตามความยาว (get / has / delete × 1 · set / add × 2)", () => {
  const { run } = setup();
  const S = "const K = 'k'.repeat(32000); const m = new Map(); const s = new Set()";
  const SHORT = "const K = 'k'.repeat(32); const m = new Map(); const s = new Set()";
  const diff = (body) => run(body, S) - run(body, SHORT);
  assert.equal(diff("m.get(K)"), 999);
  assert.equal(diff("m.has(K)"), 999);
  assert.equal(diff("m.delete(K)"), 999);
  assert.equal(diff("m.set(K, 1n)"), 2 * 999);
  assert.equal(diff("s.add(K)"), 2 * 999);
  assert.equal(diff("Map.prototype.get.call(m, K)") - diff("const g = Map.prototype.get"), 999);   // ทุกทางที่เรียกคิดเท่ากัน
  assert.equal(run("m.set(1n, 2n); m.get(1n)", S), run("m.set(1n, 2n); m.get(1n)", SHORT));   // key ไม่ใช่ string: เท่าเดิม
});

test("JSON.stringify ซ้อนลึกคิดตามความลึก · flat คิดทุกชั้นที่ไล่ · sort ปริยายคิดต่อการเทียบ · ผลลัพธ์เหมือน engine", () => {
  const { run } = setup();
  const deep = (n) => run("JSON.stringify(o)", `let o = 1n; for (let i = 0; i < ${n}; i++) o = [o]`) ;
  // 2 + ⌊ชั้น / 8⌋ ต่อ array · ยิ่งลึกยิ่งแพงแบบกำลังสอง
  assert.ok(deep(400) - deep(200) > 2 * (deep(200) - deep(100)));
  const flat = (n) => run("x.flat(Infinity)", `let x = [1n]; for (let i = 0; i < ${n}; i++) x = [x]`);
  assert.equal(flat(200) - flat(100), 100 * 9);   // 8 + 1 สมาชิก ต่อ array ที่ไล่

  // ผลเหมือน engine: replacer แบบ array (ลำดับตามรายชื่อ · ซ้ำ / ชนิดอื่นถูกข้าม) · replacer แบบ function · space · toJSON
  const vm = new VM.VirtualMachine(new MemoryDB(), {});
  const code = `function program() {
    function initialization() {}
    function f() {
      const o = { b: 1, a: { b: 2, c: 3, a: [1, { a: 1, b: 2 }] }, c: "x", d: { toJSON() { return { a: 9 } } } }
      return [
        JSON.stringify(o, ["a", "b", "a", 1, {}, new String("d")]),
        JSON.stringify(o, (k, v) => (k === "c" ? undefined : v), 2),
        JSON.stringify([new Number(1), new String("s"), Object(true)], ["x"]),
        JSON.stringify({ a: [1, [2, [3]]] }.a.flat(Infinity)),
        ["b", "a", "c"].sort().join(""),
      ]
    }
    return { f }
  }`;
  vm.commit(vm.deploy({ programUuid: "j", code, context: as }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "j" }, { timestamp: T }).writes);
  const result = vm.call({ programUuid: "j", functionName: "f", input: {}, context: as }, { timestamp: T }).result;
  const o = { b: 1, a: { b: 2, c: 3, a: [1, { a: 1, b: 2 }] }, c: "x", d: { toJSON() { return { a: 9 } } } };
  assert.deepEqual(result, [
    JSON.stringify(o, ["a", "b", "a", 1, {}, new String("d")]),
    JSON.stringify(o, (k, v) => (k === "c" ? undefined : v), 2),
    JSON.stringify([new Number(1), new String("s"), Object(true)], ["x"]),
    "[1,2,3]",
    "abc",
  ]);
});

test("งานที่เคยแย่ที่สุด: tx เต็ม 3M แก๊สจบในไม่กี่วินาที (เดิม 12–47 วินาที)", () => {
  for (const name of ["JSON.stringify ซ้อนลึก", "Map set string ยาว", "Map key ยาว", "switch string ยาว", "string < ยาว", "array sort default"]) {
    const row = measure(name, WORKLOADS[name], { repeat: 1 });
    assert.equal(row.code, "OUT_OF_GAS", name);
    assert.ok(row.ms < 4000, `${name}: ${row.ms.toFixed(0)} ms`);
  }
});
