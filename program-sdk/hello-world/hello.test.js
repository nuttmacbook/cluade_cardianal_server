/** ทดสอบก่อน deploy: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChain } from "../lib/testkit.js";
import program from "./hello.program.js";

/** ติดตั้งโปรแกรมใหม่ทุกเทสต์ */
const setup = () => createChain().deploy(program, { as: "owner", initInput: { greeting: "สวัสดี" } });

test("greet: ทักทายพร้อมนับจำนวนครั้ง", () => {
  const hello = setup();
  assert.equal(hello.call("greet", { name: "โลก" }), "สวัสดี โลก (ครั้งที่ 1)");
  assert.equal(hello.call("greet", {}, { as: "alice" }), "สวัสดี alice (ครั้งที่ 2)");
  assert.deepEqual(hello.state(), { greeting: "สวัสดี", owner: "owner", count: 2, "visits/alice": 2 });
});

test("setGreeting: เจ้าของเปลี่ยนคำทักทายได้", () => {
  const hello = setup();
  assert.equal(hello.call("setGreeting", { greeting: "หวัดดี" }, { as: "owner" }), "หวัดดี");
  assert.equal(hello.call("greet", { name: "โลก" }), "หวัดดี โลก (ครั้งที่ 1)");
});

test("setGreeting: คนอื่นเปลี่ยนไม่ได้", () => {
  const hello = setup();
  assert.throws(() => hello.call("setGreeting", { greeting: "ไม่ได้" }, { as: "alice" }), /เฉพาะเจ้าของเท่านั้น/);
  assert.equal(hello.state().greeting, "สวัสดี");   // ข้อมูลไม่เปลี่ยนเมื่อ throw
});

test("ฟังก์ชันที่ไม่ได้ return ไว้ เรียกจากภายนอกไม่ได้", () => {
  const hello = setup();
  assert.throws(() => hello.call("bump"), { code: "FORBIDDEN" });
  assert.throws(() => hello.call("initialization"), { code: "FORBIDDEN" });
});

test("info: ThisAddress และเวลาของ block", () => {
  const hello = setup();
  const info = hello.call("info");
  assert.equal(info.address, hello.address);
  assert.equal(info.owner, "owner");
  assert.equal(typeof info.time, "number");
});

test("ดูค่าแก๊สที่จะใช้จริง", () => {
  const hello = setup();
  const result = hello.callRaw("greet", { name: "โลก" });
  assert.equal(result.status, "success");
  assert.ok(result.gasUsed > 0);
  assert.deepEqual(result.writes.map((write) => write.dbKey.replace(`${hello.address}:storage:`, "")), ["count", "visits:alice"]);
});
