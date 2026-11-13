import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY, num } from "./helpers.js";
import { TOKEN, TREASURY, COUNTER } from "./programs.js";

/*
 * nonce (<addr>:nonce) and gas fees (<addr>:native:consumed)
 *   - enabled with requireNonce / chargeGas when creating the VM
 *   - only the outermost tx's sender pays gas
 *   - failed txs still consume a nonce and gas
 */

const T = 1_700_000_000_000;
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

function setup({ requireNonce = true, chargeGas = true, gas, balances = {} } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce, chargeGas, gas: { ...API_GAS_ONLY, ...gas } });
  const plain = new VM.VirtualMachine(vm.db); // VM that charges no gas, used for data setup
  const save = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    vm.commit(res.writes);
    return res;
  };
  save(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }));
  save(plain.init({ programUuid: "token" }));
  save(plain.deploy({ programUuid: "treasury", code: TREASURY, context: user("alice") }));
  save(plain.init({ programUuid: "treasury" }));
  vm.commit(Object.entries(balances).map(([address, value]) => ({ type: "put", dbKey: `${address}:native:received`, value })));
  return { vm, plain };
}

const balanceOf = (vm, address) => num(vm.nativeBalanceOf(address).balance);
const nonceOf = (vm, address) => vm.db.readKeys([`${address}:nonce`])[0];
const transfer = (nonce, amount = 10) => ({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount }, context: user("alice"), nonce });

// ---------------------------------------------------------------------------
//  nonce
// ---------------------------------------------------------------------------

test("nonce: the first tx must be 0, then increments by 1", () => {
  const { vm } = setup({ chargeGas: false });
  const first = vm.call(transfer(0));
  assert.equal(first.status, "success");
  assert.deepEqual(first.writes.at(-1), { type: "put", dbKey: "alice:nonce", value: 1 });
  vm.commit(first.writes);

  const second = vm.call(transfer(1));
  assert.equal(second.status, "success");
  vm.commit(second.writes);
  assert.equal(nonceOf(vm, "alice"), 2);
});

test("nonce: repeated or skipped → INVALID_REQUEST and no writes at all", () => {
  const { vm } = setup({ chargeGas: false });
  vm.commit(vm.call(transfer(0)).writes);

  for (const [nonce, message] of [[0, "invalid nonce: expected 1 but got 0"], [5, "invalid nonce: expected 1 but got 5"], [undefined, "invalid nonce: expected 1 but got undefined"]]) {
    const res = vm.call(transfer(nonce));
    assert.equal(res.error.code, "INVALID_REQUEST");
    assert.equal(res.error.message, message);
    assert.deepEqual(res.writes, []); // wrong nonce = tx not accepted at all, so no nonce consumed
  }
  assert.equal(nonceOf(vm, "alice"), 1);
});

test("nonce: failed txs consume a nonce", () => {
  const { vm } = setup({ chargeGas: false });
  const res = vm.call(transfer(0, 99999)); // insufficient balance
  assert.equal(res.error.code, "PROGRAM_ERROR");
  assert.deepEqual(res.writes, [{ type: "put", dbKey: "alice:nonce", value: 1 }]);
  vm.commit(res.writes);
  assert.equal(vm.call(transfer(0)).error.code, "INVALID_REQUEST");
  assert.equal(vm.call(transfer(1)).status, "success");
});

test("nonce: separate per address, and deploy consumes a nonce too", () => {
  const { vm } = setup({ chargeGas: false });
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("carol"), nonce: 0 }).writes);
  assert.equal(nonceOf(vm, "carol"), 1);
  assert.equal(nonceOf(vm, "alice"), undefined);
  assert.equal(vm.call(transfer(0)).status, "success"); // alice still starts at 0
});

test("nonce: team init / reject use no nonce", () => {
  const { vm } = setup({ chargeGas: false });
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("carol"), nonce: 0 }).writes);
  const res = vm.init({ programUuid: "counter" });
  assert.equal(res.status, "success");
  assert.equal(res.writes.some((w) => w.dbKey.endsWith(":nonce")), false);
});

test("nonce: requireNonce off → no nonce needed and no nonce writes", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false });
  const res = vm.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice") });
  assert.equal(res.status, "success");
  assert.equal(res.writes.some((w) => w.dbKey.endsWith(":nonce")), false);
});

// ---------------------------------------------------------------------------
//  gas fees
// ---------------------------------------------------------------------------

test("gas: charged per call / read / write + data size, then added to the caller's consumed counter", () => {
  const { vm } = setup({ requireNonce: false, balances: { alice: 1_000_000 } });
  const value = "0123456789"; // JSON = "\"0123456789\"" = 12 byte
  const res = vm.call({ programUuid: "treasury", functionName: "gasProbe", input: { value }, context: user("alice") });

  // gasProbe = 1 call + 1 readDB (empty) + 1 writeDB (12 bytes) + 1 written state key
  const { call, read, write, stateKey, byte } = VM.DEFAULT_GAS;
  const expected = call + read + write + stateKey + byte * JSON.stringify(value).length;
  assert.equal(res.gasUsed, expected);

  const fee = expected * VM.DEFAULT_GAS.price;
  assert.deepEqual(res.writes.slice(-2), [
    { type: "put", dbKey: "alice:native:consumed", value: `${fee}n` },
    { type: "put", dbKey: `${VM.BURN_ADDRESS}:native:received`, value: `${fee}n` }, // no feeRecipient → burned to 0x000…000
  ]);
  vm.commit(res.writes);
  assert.equal(balanceOf(vm, "alice"), 1_000_000 - fee);
});

test("gas: reading large data costs more gas than reading small data", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false });
  const small = vm.call({ programUuid: "treasury", functionName: "gasProbe", input: { value: "x" }, context: user("alice") });
  vm.commit(small.writes);
  const large = vm.call({ programUuid: "treasury", functionName: "gasProbe", input: { value: "x".repeat(1000) }, context: user("alice") });
  assert.ok(large.gasUsed > small.gasUsed + 1000);
});

test("gas: the gas table is configurable", () => {
  const { vm } = setup({ requireNonce: false, gas: { call: 1, read: 0, write: 0, stateKey: 0, byte: 0, price: 2 }, balances: { alice: 1000 } });
  const res = vm.call({ programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("alice") });
  assert.equal(res.gasUsed, 1);
  assert.deepEqual(res.writes, [
    { type: "put", dbKey: "alice:native:consumed", value: "2n" }, // 1 gas × price 2
    { type: "put", dbKey: `${VM.BURN_ADDRESS}:native:received`, value: "2n" },
  ]);
});

test("gas: cross-program calls charge call gas at every level, and only the outermost caller pays", () => {
  const { vm } = setup({ requireNonce: false, gas: { call: 100, read: 0, write: 0, stateKey: 0, byte: 0, price: 1 }, balances: { alice: 10_000, treasury: 500 } });
  const res = vm.call({ programUuid: "treasury", functionName: "relayPayout", input: { target: "treasury", to: "bob", amount: 5 }, context: user("alice") });

  assert.equal(res.status, "success");
  assert.equal(res.gasUsed, 200); // 2 call
  const native = Object.fromEntries(res.writes.filter((w) => w.dbKey.includes(":native:")).map((w) => [w.dbKey, w.value]));
  assert.deepEqual(native, {
    "treasury:native:sended": "5n",
    "bob:native:received": "5n",
    "alice:native:consumed": "200n", // gas is charged to alice alone
    [`${VM.BURN_ADDRESS}:native:received`]: "200n",
  });
});

test("gas: insufficient balance → OUT_OF_GAS, no program writes, consumes the nonce and all remaining funds", () => {
  const { vm } = setup({ balances: { alice: 250 } });
  const res = vm.call(transfer(0));

  assert.equal(res.status, "throw");
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.match(res.error.message, /out of gas/);
  assert.deepEqual(res.writes, [
    { type: "put", dbKey: "alice:nonce", value: 1 },
    { type: "put", dbKey: "alice:native:consumed", value: "250n" }, // pays what it has
    { type: "put", dbKey: `${VM.BURN_ADDRESS}:native:received`, value: "250n" },
  ]);
  vm.commit(res.writes);
  assert.equal(balanceOf(vm, "alice"), 0);
  assert.equal(vm.db.readKeys(["token:storage:balances:bob"])[0], undefined);
});

test("gas: no native balance at all → OUT_OF_GAS from the first call", () => {
  const { vm } = setup({ requireNonce: false });
  const res = vm.call({ programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("alice") });
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.deepEqual(res.writes, []);
});

test("gas: programs cannot catch OUT_OF_GAS", () => {
  const { vm } = setup({ requireNonce: false, balances: { alice: 3000 } });
  const res = vm.call({
    programUuid: "treasury",
    functionName: "burnGas",
    input: { rounds: 50, data: "0123456789" },
    context: user("alice"),
  });
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.deepEqual(res.writes.map((w) => w.dbKey), ["alice:native:consumed", `${VM.BURN_ADDRESS}:native:received`]);
  assert.equal(res.writes[0].value, "3000n"); // pays everything it has
});

test("gas: chargeGas off → gasUsed is still counted but nothing is charged", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false });
  const res = vm.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice") });
  assert.ok(res.gasUsed > 0);
  assert.equal(res.writes.some((w) => w.dbKey.includes(":native:")), false);
});

// ---------------------------------------------------------------------------
//  transferNative
// ---------------------------------------------------------------------------

test("transferNative: transfers from the program's own balance", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false, balances: { treasury: 100 } });
  const res = vm.call({ programUuid: "treasury", functionName: "payout", input: { to: "0xFABB0Ac9", amount: 30 }, context: user("alice") });

  assert.equal(res.status, "success");
  assert.deepEqual(res.writes, [
    { type: "put", dbKey: "treasury:native:sended", value: "30n" },
    { type: "put", dbKey: "0xfabb0ac9:native:received", value: "30n" },   // address is normalized
    { type: "put", dbKey: "treasury:storage:paid:0xfabb0ac9", value: "30n" },
  ]);
  vm.commit(res.writes);
  assert.equal(balanceOf(vm, "0xfabb0ac9"), 30);
});

test("transferNative: several transfers in one tx always see the latest balance", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false, balances: { treasury: 100 } });
  const items = [{ to: "bob", amount: 30 }, { to: "carol", amount: 50 }, { to: "bob", amount: 10 }];
  const res = vm.call({ programUuid: "treasury", functionName: "payoutMany", input: { items }, context: user("alice") });

  assert.equal(res.result, "3n");
  vm.commit(res.writes);
  assert.equal(balanceOf(vm, "treasury"), 10);
  assert.equal(balanceOf(vm, "bob"), 40);
  assert.equal(balanceOf(vm, "carol"), 50);
});

test("transferNative: insufficient balance / invalid amount → an error the program can catch", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false, balances: { treasury: 10 } });
  const payout = (input) => vm.call({ programUuid: "treasury", functionName: "payout", input, context: user("alice") });

  assert.equal(payout({ to: "bob", amount: 50 }).error.message, "insufficient native balance for 'treasury'");
  assert.equal(payout({ to: "bob", amount: 0 }).error.code, "INVALID_REQUEST");
  assert.equal(payout({ to: "bob", amount: 1.5 }).error.code, "INVALID_REQUEST");
  assert.equal(payout({ to: "", amount: 1 }).error.code, "INVALID_REQUEST");

  const caught = vm.call({ programUuid: "treasury", functionName: "payoutSafe", input: { to: "bob", amount: 50 }, context: user("alice") });
  assert.equal(caught.result, "insufficient native balance for 'treasury'");
  assert.deepEqual(caught.writes, [{ type: "put", dbKey: "treasury:storage:lastError", value: "insufficient native balance for 'treasury'" }]);
});

test("transferNative: a program cannot transfer another address's native (only its own)", () => {
  const { vm } = setup({ requireNonce: false, chargeGas: false, balances: { alice: 1000, treasury: 5 } });
  const res = vm.call({ programUuid: "treasury", functionName: "payout", input: { to: "bob", amount: 100 }, context: user("alice") });
  assert.equal(res.error.message, "insufficient native balance for 'treasury'"); // even though alice has funds
});

test("transferNative: transferring out until gas cannot be paid → OUT_OF_GAS and nothing is saved", () => {
  const { vm } = setup({ requireNonce: false, balances: { alice: 100_000, treasury: 100 } });
  // alice can pay the gas, and the program transfers its own native, unaffected → must succeed
  const ok = vm.call({ programUuid: "treasury", functionName: "payout", input: { to: "bob", amount: 100 }, context: user("alice") });
  assert.equal(ok.status, "success");

  // alice has less than the gas → OUT_OF_GAS
  const { vm: poor } = setup({ requireNonce: false, balances: { alice: 300, treasury: 100 } });
  const res = poor.call({ programUuid: "treasury", functionName: "payout", input: { to: "bob", amount: 10 }, context: user("alice") });
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.equal(res.writes.some((w) => w.dbKey.startsWith("bob:native:")), false);
});

// ---------------------------------------------------------------------------
//  block
// ---------------------------------------------------------------------------

test("block: a failed tx still consumes a nonce and gas, and the next tx must use the next nonce", () => {
  const { vm } = setup({ balances: { alice: 1_000_000 } });
  const block = vm.createBlock({ timestamp: T });
  const first = block.call(transfer(0, 99999));       // fails
  const second = block.call(transfer(0, 10));         // repeated nonce → rejected
  const third = block.call(transfer(1, 10));          // passes

  assert.deepEqual([first.status, second.status, third.status], ["throw", "throw", "success"]);
  assert.equal(second.error.code, "INVALID_REQUEST");
  assert.equal(block.writes().find((w) => w.dbKey === "alice:nonce").value, 2);

  const feeCharged = num(block.writes().find((w) => w.dbKey === "alice:native:consumed").value);
  assert.equal(feeCharged, first.gasUsed + third.gasUsed);

  block.commit();
  assert.equal(nonceOf(vm, "alice"), 2);
  assert.equal(balanceOf(vm, "alice"), 1_000_000 - feeCharged);
});

test("block: gas runs out mid-block → the next tx is OUT_OF_GAS", () => {
  const { vm } = setup({ requireNonce: false, balances: { alice: 4000 } });
  const block = vm.createBlock({ timestamp: T });
  const results = [1, 2, 3].map(() => block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice") }));
  assert.deepEqual(results.map((r) => r.status), ["success", "throw", "throw"]);
  assert.deepEqual(results.slice(1).map((r) => r.error.code), ["OUT_OF_GAS", "OUT_OF_GAS"]);
  assert.equal(block.writes().find((w) => w.dbKey === "alice:native:consumed").value, "4000n"); // used up
});
