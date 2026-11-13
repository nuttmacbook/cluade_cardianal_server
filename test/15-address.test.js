import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { vm, mockData, resetVM, ok, fails, activate, trace, stored } from "./helpers.js";
import { TOKEN, PROBE, ADDRESS_BOOK } from "./programs.js";

beforeEach(resetVM);

const ALICE = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const alice = ALICE.toLowerCase();
const BOB = "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a";
const bob = BOB.toLowerCase();
const TOKEN_ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const token = TOKEN_ADDR.toLowerCase();
const BOOK_ADDR = "0xE7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const book = BOOK_ADDR.toLowerCase();

const ctx = (address) => ({ sender: address, origin: address });

test("programUuid: deploy / init / call with different letter case give the same result", () => {
  const deployed = ok(vm.deploy({ programUuid: TOKEN_ADDR, code: TOKEN, context: ctx(ALICE), initInput: { supply: 100 } }));
  assert.equal(deployed.result.programUuid, token);
  assert.deepEqual(deployed.writes.map((w) => w.dbKey), [`pending:${token}`]);

  ok(vm.init({ programUuid: token.toUpperCase().replace("0X", "0x") }));
  assert.equal(mockData.has(`${token}:code`), true);

  const res = ok(vm.call({ programUuid: TOKEN_ADDR, functionName: "balanceOf", input: { account: ALICE }, context: ctx(bob) }));
  assert.equal(res.result, "100n");
  assert.equal(res.calls[0].programUuid, token);
});

test("programUuid: re-deploy with different letter case → counts as a duplicate", () => {
  ok(vm.deploy({ programUuid: TOKEN_ADDR, code: TOKEN, context: ctx(alice) }));
  fails(vm.deploy({ programUuid: token, code: TOKEN, context: ctx(alice) }), "INVALID_REQUEST", `programUuid '${token}' ถูกใช้แล้ว`);
});

test("context: sender / origin are lowercase in the program, calls and pending", () => {
  const deployed = ok(vm.deploy({ programUuid: BOOK_ADDR, code: ADDRESS_BOOK, context: ctx(ALICE), initInput: { admin: ALICE } }));
  assert.deepEqual(deployed.writes[0].value.context, ctx(alice));
  assert.deepEqual(deployed.writes[0].value.initInput, { admin: alice });
  ok(vm.init({ programUuid: BOOK_ADDR }));

  const res = ok(vm.call({ programUuid: BOOK_ADDR, functionName: "whoami", context: { sender: ALICE, origin: BOB } }));
  assert.deepEqual(res.result, { sender: alice, origin: alice }); // origin is forced to equal sender
  assert.equal(res.calls[0].sender, alice);
  assert.equal(res.calls[0].origin, alice);
});

test("comparing sender with a stored address: different case still matches", () => {
  activate(BOOK_ADDR, ADDRESS_BOOK, { context: ctx(ALICE), initInput: { admin: ALICE } });
  assert.equal(ok(vm.call({ programUuid: book, functionName: "isAdmin", context: ctx(alice) })).result, true);
  assert.equal(ok(vm.call({ programUuid: book, functionName: "isAdmin", context: ctx(ALICE.toUpperCase().replace("0X", "0x")) })).result, true);
  assert.equal(ok(vm.call({ programUuid: book, functionName: "isAdmin", context: ctx(BOB) })).result, false);
});

test("token: balances of the same address are not split by letter case", () => {
  activate(TOKEN_ADDR, TOKEN, { context: ctx(ALICE), initInput: { supply: 100 } });
  ok(vm.call({ programUuid: token, functionName: "transfer", input: { to: BOB, amount: 30 }, context: ctx(alice) }));
  ok(vm.call({ programUuid: token, functionName: "transfer", input: { to: bob, amount: 20 }, context: ctx(ALICE) }));

  assert.equal(stored(token, "balances", alice), "50n");
  assert.equal(stored(token, "balances", bob), "50n");
  assert.deepEqual([...mockData.keys()].filter((key) => key.includes(":balances:")).sort(), [
    `${token}:storage:balances:${alice}`,
    `${token}:storage:balances:${bob}`,
  ]);
});

test("input: 0x… hex strings at every level (including object key names) become lowercase, other strings are unchanged", () => {
  activate("probe", PROBE);
  const res = ok(vm.call({
    programUuid: "probe",
    functionName: "echo",
    input: {
      to: BOB,
      list: [ALICE, "Hello World", "0xNotHex", "0X1234"],
      nested: { [ALICE]: { owner: BOB, name: "Alice" } },
      hash: "0xABCDEF0123",
      number: 10,
    },
    context: ctx(alice),
  }));
  assert.deepEqual(res.result, {
    to: bob,
    list: [alice, "Hello World", "0xNotHex", "0x1234"], // "0X1234" also counts as hex
    nested: { [alice]: { owner: bob, name: "Alice" } },
    hash: "0xabcdef0123",
    number: "10n",
  });
});

test("runProgram: the target and input a program passes on are normalized the same way", () => {
  activate("probe", PROBE);
  activate(BOOK_ADDR, ADDRESS_BOOK, { initInput: { admin: alice } });
  const res = ok(vm.call({
    programUuid: "probe",
    functionName: "relay",
    input: { target: BOOK_ADDR, fn: "whoami" },
    context: ctx(ALICE),
  }));
  assert.deepEqual(res.result, { sender: "probe", origin: alice });
  assert.deepEqual(trace(res), ["0:probe.relay:success", `1:${book}.whoami:success`]);
});

test("storage key: addresses in program code (map) are always lowercase", () => {
  activate(BOOK_ADDR, ADDRESS_BOOK, { initInput: { admin: alice } });
  const res = ok(vm.call({ programUuid: book, functionName: "saveLiteral", context: ctx(alice) }));
  assert.equal(res.result, "1n");
  assert.deepEqual(res.writes.map((w) => w.dbKey), [`${book}:storage:balances:0xabcdef`]);

  ok(vm.call({ programUuid: book, functionName: "save", input: { address: ALICE, note: "x" }, context: ctx(alice) }));
  assert.deepEqual(ok(vm.call({ programUuid: book, functionName: "lookup", input: { address: alice }, context: ctx(bob) })).result, { address: alice, note: "x" });
});

test("storage key: strings that are not 0x… hex keep their case", () => {
  activate(BOOK_ADDR, ADDRESS_BOOK, { initInput: { admin: alice } });
  const res = ok(vm.call({ programUuid: book, functionName: "saveText", input: { key: "Alice", value: 1 }, context: ctx(alice) }));
  assert.deepEqual(res.writes.map((w) => w.dbKey), [`${book}:storage:text:Alice`]);
});

test("block: an address in different case across txs is the same account", () => {
  activate(TOKEN_ADDR, TOKEN, { context: ctx(ALICE), initInput: { supply: 100 } });
  const block = vm.createBlock({ timestamp: 1 });
  block.call({ programUuid: TOKEN_ADDR, functionName: "transfer", input: { to: BOB, amount: 10 }, context: ctx(ALICE) });
  block.call({ programUuid: token, functionName: "transfer", input: { to: ALICE, amount: 5 }, context: ctx(bob) });
  assert.deepEqual(block.afterValues(), [
    { dbKey: `${token}:storage:balances:${alice}`, afterValue: "95n", changed: true },
    { dbKey: `${token}:storage:balances:${bob}`, afterValue: "5n", changed: true },
  ]);
});

test("plain names (not 0x…) for programUuid / sender are lowercase too", () => {
  activate("Token", TOKEN, { context: ctx("Owner"), initInput: { supply: 10 } });
  assert.equal(mockData.has("token:code"), true);
  assert.equal(stored("token", "balances", "owner"), "10n");
  assert.equal(ok(vm.call({ programUuid: "TOKEN", functionName: "balanceOf", input: { account: "owner" }, context: ctx("OWNER") })).result, "10n");
});
