/** Test before deploying: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChain } from "../lib/testkit.js";
import program from "./hello.program.js";

/** Installs a fresh program for every test */
const setup = () => createChain().deploy(program, { as: "owner", initInput: { greeting: "Hello" } });

test("greet: greets and counts visits", () => {
  const hello = setup();
  assert.equal(hello.call("greet", { name: "world" }), "Hello world (visit 1)");
  assert.equal(hello.call("greet", {}, { as: "alice" }), "Hello alice (visit 2)");
  assert.deepEqual(hello.state(), { greeting: "Hello", owner: "owner", count: "2n", "visits/alice": "2n" });   // numbers stored as "123n"
});

test("setGreeting: the owner can change the greeting", () => {
  const hello = setup();
  assert.equal(hello.call("setGreeting", { greeting: "Hi" }, { as: "owner" }), "Hi");
  assert.equal(hello.call("greet", { name: "world" }), "Hi world (visit 1)");
});

test("setGreeting: others cannot change it", () => {
  const hello = setup();
  assert.throws(() => hello.call("setGreeting", { greeting: "nope" }, { as: "alice" }), /owner only/);
  assert.equal(hello.state().greeting, "Hello");   // data unchanged when it throws
});

test("functions not in the return cannot be called from outside", () => {
  const hello = setup();
  assert.throws(() => hello.call("bump"), { code: "FORBIDDEN" });
  assert.throws(() => hello.call("initialization"), { code: "FORBIDDEN" });
});

test("info: ThisAddress and block time", () => {
  const hello = setup();
  const info = hello.call("info");
  assert.equal(info.address, hello.address);
  assert.equal(info.owner, "owner");
  assert.match(info.time, /^\d+n$/);   // BigInt comes out as "123n"
});

test("see the actual gas cost", () => {
  const hello = setup();
  const result = hello.callRaw("greet", { name: "world" });
  assert.equal(result.status, "success");
  assert.ok(result.gasUsed > 0);
  assert.deepEqual(result.writes.map((write) => write.dbKey.replace(`${hello.address}:storage:`, "")), ["count", "visits:alice"]);
});
