import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { vm, mockData, resetVM, user, ok, fails, activate, stored, trace } from "./helpers.js";
import { TOKEN, SELF_AWARE } from "./programs.js";

beforeEach(resetVM);

test("init เขียน <address>:this และ ThisAddress() คืนค่าเดียวกัน", () => {
  const res = ok(vm.deploy({ programUuid: "Vault", code: SELF_AWARE, context: user("alice"), initInput: { token: "token" } }));
  const initialized = ok(vm.init({ programUuid: res.result.programUuid }));

  assert.equal(initialized.writes.some((w) => w.dbKey === "vault:this" && w.value === "vault"), true);
  assert.equal(mockData.get("vault:this"), "vault");
  assert.equal(stored("vault", "bornAs"), "vault"); // ใช้ ThisAddress() ได้ตั้งแต่ใน initialization
  assert.equal(ok(vm.call({ programUuid: "vault", functionName: "whoAmI", context: user("bob") })).result, "vault");
});

test("ThisAddress() ของแต่ละโปรแกรมเป็นของตัวเอง แม้ถูกเรียกซ้อน", () => {
  activate("vault-a", SELF_AWARE, { initInput: { token: "token" } });
  activate("vault-b", SELF_AWARE, { initInput: { token: "token" } });
  const res = ok(vm.call({ programUuid: "vault-a", functionName: "askOther", input: { target: "vault-b" }, context: user("alice") }));
  assert.deepEqual(res.result, { me: "vault-a", other: "vault-b" });
});

test("โปรแกรมรับเงินเข้ากระเป๋าตัวเองได้โดยไม่ต้องรู้ address ล่วงหน้า", () => {
  activate("token", TOKEN, { context: user("alice"), initInput: { supply: 1000 } });
  activate("vault", SELF_AWARE, { initInput: { token: "token" } });
  ok(vm.call({ programUuid: "token", functionName: "approve", input: { spender: "vault", amount: 500 }, context: user("alice") }));

  const res = ok(vm.call({ programUuid: "vault", functionName: "collect", input: { amount: 120 }, context: user("alice") }));
  assert.equal(res.result, "vault");
  assert.deepEqual(trace(res), ["0:vault.collect:success", "1:token.transferFrom:success"]);
  assert.equal(stored("token", "balances", "vault"), 120);
  assert.equal(stored("token", "balances", "alice"), 880);
  assert.equal(stored("vault", "collected"), 120);
});

test("ThisAddress เป็นตัวพิมพ์เล็กเสมอ (ตรงกับ key ที่ VM ใช้)", () => {
  activate("0xE7F1725E7734CE288F8367e1Bb143E90bb3F0512", SELF_AWARE, { initInput: { token: "token" } });
  const address = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
  assert.equal(mockData.get(`${address}:this`), address);
  assert.equal(ok(vm.call({ programUuid: address, functionName: "whoAmI", context: user("a") })).result, address);
});

test("โปรแกรมประกาศฟังก์ชันชื่อ ThisAddress ทับไม่ได้", () => {
  const code = "function program() {\n  function ThisAddress() { return \"fake\" }\n  function a() { return 1 }\n  return { a }\n}";
  fails(vm.deploy({ programUuid: "p", code, context: user("a") }), "INVALID_REQUEST", /syntax error/);
});

test("<address>:this มีเฉพาะของโปรแกรม — wallet ไม่มี key ใด ๆ", () => {
  activate("token", TOKEN, { context: user("alice"), initInput: { supply: 10 } });
  ok(vm.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice") }));

  assert.equal(mockData.get("token:this"), "token");
  for (const suffix of [":this", ":code", ":context"]) {
    assert.equal(mockData.has(`alice${suffix}`), false);
    assert.equal(mockData.has(`bob${suffix}`), false);
  }
  // wallet มีตัวตนผ่านข้อมูลของโปรแกรมอื่นเท่านั้น
  assert.equal(stored("token", "balances", "bob"), 1);
});
