import { test } from "node:test";
import assert from "node:assert/strict";
import { runFuzz, fuzzOnce, fuzzDecoder, random, guestProgram } from "../scripts/fuzz-sandbox.js";

/*
 * ระยะ 2.1: fuzz เขตแดน sandbox ↔ host (scripts/fuzz-sandbox.js · รันยาวด้วย npm run fuzz -- --iterations 20000)
 *   ค่าแปลก (วน / getter / Proxy / toJSON / prototype / Symbol / ซ้อนลึก / ใหญ่) เข้า API ทุกตัว + คืนจากฟังก์ชัน + input จาก host
 *   ต้องไม่ INTERNAL · ไม่ throw ถึงผู้เรียก · deterministic · host ไม่ถูกแตะ · sandbox ใช้ต่อได้
 * seed คงที่ → CI ได้ชุดเดิมทุกครั้ง
 */

test("fuzz 150 รอบ (seed คงที่): ไม่มีรอบไหนผิดกติกา", () => {
  const result = runFuzz({ seed: 20261024, iterations: 150 });
  assert.deepEqual(result.failures.map((f) => `${f.seed}: ${f.problem}`), []);
  assert.deepEqual(result.decoder, []);
});

test("ตัวสุ่มทำซ้ำได้: seed เดิม = โปรแกรมเดิม · ผลของรอบเดิมเหมือนเดิม", () => {
  assert.equal(guestProgram(random(7)), guestProgram(random(7)));
  assert.notEqual(guestProgram(random(7)), guestProgram(random(8)));
  assert.equal(fuzzOnce(7), null);
});

test("ตัวถอดข้อความจากโปรแกรม: ป้ายแปลก / __proto__ ไม่แก้ prototype ของ host", () => {
  assert.deepEqual(fuzzDecoder(1, 2000), []);
  assert.equal(({}).polluted, undefined);
});
