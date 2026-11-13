import { test } from "node:test";
import assert from "node:assert/strict";
import { runFuzz, fuzzOnce, fuzzDecoder, random, guestProgram } from "../dev/fuzz-sandbox.js";

/*
 * Phase 2.1: fuzz the sandbox ↔ host boundary (dev/fuzz-sandbox.js · long run with npm run fuzz -- --iterations 20000)
 *   odd values (cyclic / getter / Proxy / toJSON / prototype / Symbol / deeply nested / huge) into every API + returned from functions + input from the host
 *   must not be INTERNAL · must not throw to the caller · deterministic · host untouched · sandbox still usable
 * fixed seed → CI gets the same set every time
 */

test("fuzz 150 rounds (fixed seed): no round breaks the rules", () => {
  const result = runFuzz({ seed: 20261024, iterations: 150 });
  assert.deepEqual(result.failures.map((f) => `${f.seed}: ${f.problem}`), []);
  assert.deepEqual(result.decoder, []);
});

test("the generator is reproducible: same seed = same program · the same round gives the same result", () => {
  assert.equal(guestProgram(random(7)), guestProgram(random(7)));
  assert.notEqual(guestProgram(random(7)), guestProgram(random(8)));
  assert.equal(fuzzOnce(7), null);
});

test("the program message decoder: odd labels / __proto__ do not modify the host prototype", () => {
  assert.deepEqual(fuzzDecoder(1, 2000), []);
  assert.equal(({}).polluted, undefined);
});
