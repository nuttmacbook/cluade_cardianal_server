/** Quick test with the fake API (no VM needed): node --test hello-world/fake.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeApi } from "../lib/program-globals.js";
import program from "./hello.program.js";

function setup(options) {
  const api = createFakeApi({ self: "0xhello", storage: { greeting: "Hello", owner: "0xowner", count: 0n }, ...options });
  Object.assign(globalThis, api);
  return { api, program: program() };
}

test("greet: uses data in the store", () => {
  const { api, program: hello } = setup();
  assert.equal(hello.greet(api.params({ name: "world" })), "Hello world (visit 1)");
  assert.equal(api.store.get("count"), 1n);
});

test("setGreeting: others cannot change it", () => {
  const { api, program: hello } = setup();
  assert.throws(() => hello.setGreeting(api.params({ greeting: "x" }, { sender: "0xsomeoneelse" })), /owner only/);
});

test("money and address APIs", () => {
  const { api, program: hello } = setup({ balances: { "0xhello": 500n, "0xbob": 10n }, programs: ["0xtoken"] });
  assert.equal(api.ThisBalance(), 500n);
  assert.equal(api.BalanceOf("0xbob"), 10n);
  assert.equal(api.IsProgram("0xtoken"), true);
  assert.equal(api.IsProgram("0xbob"), false);

  api.transferNative("0xbob", 200n);
  assert.equal(api.ThisBalance(), 300n);
  assert.deepEqual(api.transfers, [{ from: "0xhello", to: "0xbob", amount: 200n }]);
  assert.throws(() => api.transferNative("0xbob", 9999n), /insufficient/);
  assert.throws(() => api.transferNative("0xbob", 1), /must be BigInt/);   // number not allowed, same as on chain

  assert.equal(hello.info(api.params()).address, "0xhello");
});

test("emit records events for checking", () => {
  const { api } = setup();
  api.emit("Transfer", { to: "0xbob", amount: 5n });
  assert.deepEqual(api.events, [{ index: 0, name: "Transfer", data: { to: "0xbob", amount: 5n } }]);
  assert.throws(() => api.emit("ชื่อไทย"), /event name/);   // Thai name on purpose: non-ASCII event names must be rejected
});
