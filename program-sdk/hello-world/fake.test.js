/** ทดสอบเร็ว ๆ ด้วย API ปลอม (ไม่ต้องรัน VM): node --test hello-world/fake.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeApi } from "../lib/program-globals.js";
import program from "./hello.program.js";

function setup(options) {
  const api = createFakeApi({ self: "0xhello", storage: { greeting: "สวัสดี", owner: "0xowner", count: 0 }, ...options });
  Object.assign(globalThis, api);
  return { api, program: program() };
}

test("greet: ใช้ข้อมูลใน store", () => {
  const { api, program: hello } = setup();
  assert.equal(hello.greet(api.params({ name: "โลก" })), "สวัสดี โลก (ครั้งที่ 1)");
  assert.equal(api.store.get("count"), 1);
});

test("setGreeting: คนอื่นเปลี่ยนไม่ได้", () => {
  const { api, program: hello } = setup();
  assert.throws(() => hello.setGreeting(api.params({ greeting: "x" }, { sender: "0xคนอื่น" })), /เฉพาะเจ้าของ/);
});

test("API ที่เกี่ยวกับเงินและ address", () => {
  const { api, program: hello } = setup({ balances: { "0xhello": 500, "0xbob": 10 }, programs: ["0xtoken"] });
  assert.equal(api.ThisBalance(), 500);
  assert.equal(api.BalanceOf("0xbob"), 10);
  assert.equal(api.IsProgram("0xtoken"), true);
  assert.equal(api.IsProgram("0xbob"), false);

  api.transferNative("0xbob", 200);
  assert.equal(api.ThisBalance(), 300);
  assert.deepEqual(api.transfers, [{ from: "0xhello", to: "0xbob", amount: 200 }]);
  assert.throws(() => api.transferNative("0xbob", 9999), /ไม่พอ/);

  assert.equal(hello.info(api.params()).address, "0xhello");
});

test("emit เก็บไว้ให้ตรวจได้", () => {
  const { api } = setup();
  api.emit("Transfer", { to: "0xbob", amount: 5 });
  assert.deepEqual(api.events, [{ index: 0, name: "Transfer", data: { to: "0xbob", amount: 5 } }]);
  assert.throws(() => api.emit("ชื่อไทย"), /ชื่อ event/);
});
