import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { vm, mockData, resetVM, user, ok, fails, activate, stored, trace } from "./helpers.js";
import { TOKEN, SELF_AWARE } from "./programs.js";

beforeEach(resetVM);

test("init writes <address>:this and ThisAddress() returns the same value", () => {
  const res = ok(vm.deploy({ programUuid: "Vault", code: SELF_AWARE, context: user("alice"), initInput: { token: "token" } }));
  const initialized = ok(vm.init({ programUuid: res.result.programUuid }));

  assert.equal(initialized.writes.some((w) => w.dbKey === "vault:this" && w.value === "vault"), true);
  assert.equal(mockData.get("vault:this"), "vault");
  assert.equal(stored("vault", "bornAs"), "vault"); // ThisAddress() is usable already inside initialization
  assert.equal(ok(vm.call({ programUuid: "vault", functionName: "whoAmI", context: user("bob") })).result, "vault");
});

test("each program's ThisAddress() is its own, even in nested calls", () => {
  activate("vault-a", SELF_AWARE, { initInput: { token: "token" } });
  activate("vault-b", SELF_AWARE, { initInput: { token: "token" } });
  const res = ok(vm.call({ programUuid: "vault-a", functionName: "askOther", input: { target: "vault-b" }, context: user("alice") }));
  assert.deepEqual(res.result, { me: "vault-a", other: "vault-b" });
});

test("a program can receive funds into its own wallet without knowing its address in advance", () => {
  activate("token", TOKEN, { context: user("alice"), initInput: { supply: 1000 } });
  activate("vault", SELF_AWARE, { initInput: { token: "token" } });
  ok(vm.call({ programUuid: "token", functionName: "approve", input: { spender: "vault", amount: 500 }, context: user("alice") }));

  const res = ok(vm.call({ programUuid: "vault", functionName: "collect", input: { amount: 120 }, context: user("alice") }));
  assert.equal(res.result, "vault");
  assert.deepEqual(trace(res), ["0:vault.collect:success", "1:token.transferFrom:success"]);
  assert.equal(stored("token", "balances", "vault"), "120n");
  assert.equal(stored("token", "balances", "alice"), "880n");
  assert.equal(stored("vault", "collected"), "120n");
});

test("ThisAddress is always lowercase (matches the key the VM uses)", () => {
  activate("0xE7F1725E7734CE288F8367e1Bb143E90bb3F0512", SELF_AWARE, { initInput: { token: "token" } });
  const address = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
  assert.equal(mockData.get(`${address}:this`), address);
  assert.equal(ok(vm.call({ programUuid: address, functionName: "whoAmI", context: user("a") })).result, address);
});

test("a program cannot override ThisAddress with its own function", () => {
  const code = "function program() {\n  function ThisAddress() { return \"fake\" }\n  function a() { return 1 }\n  return { a }\n}";
  fails(vm.deploy({ programUuid: "p", code, context: user("a") }), "INVALID_REQUEST", /syntax error/);
});

test("<address>:this exists only for programs — wallets have no keys at all", () => {
  activate("token", TOKEN, { context: user("alice"), initInput: { supply: 10 } });
  ok(vm.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice") }));

  assert.equal(mockData.get("token:this"), "token");
  for (const suffix of [":this", ":code", ":context"]) {
    assert.equal(mockData.has(`alice${suffix}`), false);
    assert.equal(mockData.has(`bob${suffix}`), false);
  }
  // a wallet exists only through other programs' data
  assert.equal(stored("token", "balances", "bob"), "1n");
});
