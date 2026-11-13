import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY, num } from "./helpers.js";
import { TOKEN, WALLET, SHOP, COUNTER, FAULTY } from "./programs.js";

/* receipts per tx (vm.buildReceipt) and for the whole block (block.receipt) */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const GAS = { ...API_GAS_ONLY, call: 100, read: 10, write: 50, stateKey: 0, byte: 0, price: 1 };
let endpointCounter = 0;

function setup(options = {}, balances = { alice: 100_000 }) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, gas: GAS, burnPercent: 50, ...options,
  });
  const plain = new VM.VirtualMachine(vm.db);
  const save = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    vm.commit(res.writes);
  };
  save(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }));
  save(plain.init({ programUuid: "token" }));
  save(plain.deploy({ programUuid: "wallet", code: WALLET, context: user("alice") }));
  save(plain.init({ programUuid: "wallet" }));
  save(plain.deploy({ programUuid: "shop", code: SHOP, context: user("alice"), initInput: { shopId: "shop", token: "token", price: 100 } }));
  save(plain.init({ programUuid: "shop" }));
  vm.commit(Object.entries(balances).map(([address, value]) => ({ type: "put", dbKey: `${address}:native:received`, value })));
  return vm;
}

/** sends a request and returns its receipt directly */
function receiptOf(vm, action, request, index = 0) {
  return vm.buildReceipt(request, vm[action](request, { timestamp: T }), { index, action });
}

// ---------------------------------------------------------------------------
//  simple cases
// ---------------------------------------------------------------------------

test("receipt: transfer between wallets", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "transfer", { from: "ALICE", to: "0xBoB", amount: 500, nonce: 0 });

  assert.match(receipt.hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(receipt, {
    hash: receipt.hash,
    index: 0,
    digest: null,
    action: "transfer",
    timestamp: T,
    time: "2024-06-01T10:00:00.000Z",
    status: "success",
    from: "alice",
    to: "0xbob",
    method: "transfer",
    input: null,
    value: "500n",   // native amounts in the receipt look like "123n" (BigInt sent as JSON)
    result: { from: "alice", to: "0xbob", amount: "500n" },
    error: null,
    gasUsed: GAS.call + 2 * (GAS.read + GAS.write),
    gasPrice: null,
    // EIP-1559: no price given = pays the base fee (no tip) · no feeRecipient → everything burned
    type: 0,
    effectiveGasPrice: "1n",
    baseFeePerGas: "1n",
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    burnedFee: receipt.fee,
    producerFee: "0n",
    fee: `${GAS.call + 2 * (GAS.read + GAS.write)}n`,
    nonce: 1,
    events: [],
    trace: [],
    nativeChanges: [
      { address: "alice", field: "sended", after: "500n" },
      { address: "0xbob", field: "received", after: "500n" },
      { address: "alice", field: "consumed", after: receipt.fee },
      { address: VM.BURN_ADDRESS, field: "received", after: receipt.fee }, // no feeRecipient set → everything burned
    ],
    stateChanges: [],
    programChanges: [],
  });
});

test("receipt: plain call (read only)", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("alice"), nonce: 0 });

  assert.equal(receipt.status, "success");
  assert.equal(receipt.result, "1000n");
  assert.deepEqual(receipt.stateChanges, []);
  assert.deepEqual(receipt.trace, [{ depth: 0, program: "token", method: "balanceOf", from: "alice", origin: "alice", input: { account: "alice" }, value: "0n", result: "1000n", gasUsed: GAS.call + GAS.read, status: "success", error: null }]);
  assert.equal(receipt.gasUsed, GAS.call + GAS.read);
  assert.deepEqual(receipt.nativeChanges, [
    { address: "alice", field: "consumed", after: receipt.fee },
    { address: VM.BURN_ADDRESS, field: "received", after: receipt.fee }, // no feeRecipient set → everything burned
  ]);
});

test("receipt: call that changes data", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 30 }, context: user("alice"), nonce: 0 });

  assert.deepEqual(receipt.result, { from: "alice", to: "bob", amount: "30n" });
  assert.deepEqual(receipt.stateChanges, [
    { program: "token", key: ["balances", "alice"], after: "970n" },
    { program: "token", key: ["balances", "bob"], after: "30n" },
  ]);
  assert.equal(receipt.nonce, 1);
});

test("receipt: failed call", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 0 });

  assert.equal(receipt.status, "throw");
  assert.deepEqual(receipt.error, { code: "PROGRAM_ERROR", message: "ยอดไม่พอ" });
  assert.equal(receipt.result, null);
  assert.deepEqual(receipt.stateChanges, []);
  assert.deepEqual(receipt.trace[0].error, { code: "PROGRAM_ERROR", message: "ยอดไม่พอ" });
  assert.equal(receipt.nonce, 1);                       // failure still consumes the nonce
  assert.ok(num(receipt.fee) > 0);                      // and pays gas
});

test("receipt: wrong nonce → no nonce consumed, no gas paid", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("alice"), nonce: 7 });

  assert.equal(receipt.error.code, "INVALID_REQUEST");
  assert.equal(receipt.nonce, null);
  assert.equal(receipt.fee, "0n");
  assert.deepEqual(receipt.nativeChanges, []);
});

test("receipt: deploy / init / reject", () => {
  const vm = setup();
  const deployed = receiptOf(vm, "deploy", { programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 3 }, value: 250, nonce: 0 });
  assert.equal(deployed.action, "deploy");
  assert.equal(deployed.method, "deploy");
  assert.equal(deployed.value, "250n");
  assert.deepEqual(deployed.programChanges, [{ kind: "pending", address: "counter", removed: false }]);
  assert.deepEqual(deployed.nativeChanges, [
    { address: "alice", field: "sended", after: "250n" },
    { address: "counter", field: "received", after: "250n" },
    { address: "alice", field: "consumed", after: deployed.fee },
    { address: VM.BURN_ADDRESS, field: "received", after: deployed.fee }, // no feeRecipient set → everything burned
  ]);
  // the receipt above was not committed, so alice's nonce is still 0
  vm.commit(vm.deploy({ programUuid: "counter2", code: COUNTER, context: user("alice"), initInput: { start: 3 }, nonce: 0 }, { timestamp: T }).writes);

  const initialized = receiptOf(vm, "init", { programUuid: "counter2" });
  assert.equal(initialized.action, "init");
  assert.equal(initialized.method, "init");
  assert.equal(initialized.from, null);                  // init comes from the team, not a user
  assert.equal(initialized.nonce, null);
  assert.deepEqual(initialized.stateChanges, [{ program: "counter2", key: ["count"], after: "3n" }]);
  assert.deepEqual(initialized.programChanges, [
    { kind: "code", address: "counter2", removed: false },
    { kind: "context", address: "counter2", removed: false },
    { kind: "this", address: "counter2", removed: false },
    { kind: "pending", address: "counter2", removed: true },
  ]);

  vm.commit(vm.deploy({ programUuid: "counter3", code: COUNTER, context: user("alice"), value: 40, nonce: 1 }, { timestamp: T }).writes);
  const rejected = receiptOf(vm, "reject", { programUuid: "counter3" });
  assert.equal(rejected.result.refund, "40n");
  assert.deepEqual(rejected.programChanges, [{ kind: "pending", address: "counter3", removed: true }]);
  assert.deepEqual(rejected.nativeChanges.map((c) => `${c.address}:${c.field}`), ["counter3:sended", "alice:received"]);
});

// ---------------------------------------------------------------------------
//  complex cases
// ---------------------------------------------------------------------------

test("receipt: cross-program call (shop → token) — 2-level trace", () => {
  const vm = setup();
  vm.commit(vm.call({ programUuid: "token", functionName: "approve", input: { spender: "shop", amount: 500 }, context: user("alice"), nonce: 0 }, { timestamp: T }).writes);
  const receipt = receiptOf(vm, "call", { programUuid: "shop", functionName: "buy", context: user("alice"), nonce: 1 }, 3);

  assert.equal(receipt.index, 3);
  assert.deepEqual(receipt.trace, [
    { depth: 0, program: "shop", method: "buy", from: "alice", origin: "alice", input: {}, value: "0n", result: "1n", gasUsed: 550, status: "success", error: null },
    { depth: 1, program: "token", method: "transferFrom", from: "shop", origin: "alice", input: { from: "alice", to: "shop", amount: "100n" }, value: "0n", result: { from: "alice", to: "shop", amount: "100n" }, gasUsed: 290, status: "success", error: null },
  ]);
  assert.deepEqual(receipt.stateChanges.map((c) => `${c.program}/${c.key.join("/")} = ${c.after}`), [
    "token/allowance/alice/shop = 400n",
    "token/balances/alice = 900n",
    "token/balances/shop = 100n",
    "shop/items/alice = 1n",
    "shop/sales = 1n",
  ]);
});

test("receipt: the callee fails but the caller catches — the trace shows the inner throw, but the tx succeeds", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", { programUuid: "shop", functionName: "buySafe", context: user("alice"), nonce: 0 });

  assert.equal(receipt.status, "success");
  assert.deepEqual(receipt.trace.map((t) => `${t.depth} ${t.program}.${t.method} ${t.status}`), [
    "0 shop.buySafe success",
    "1 token.transferFrom throw",
  ]);
  assert.deepEqual(receipt.stateChanges.map((c) => c.program), ["shop", "shop"]); // only shop's log, token's was reverted
});

test("receipt: attach value and forward it — multi-hop funds in one tx", () => {
  const vm = setup();
  const receipt = receiptOf(vm, "call", {
    programUuid: "wallet", functionName: "forward",
    input: { target: "wallet", value: 40 }, context: user("alice"), value: 100, nonce: 0,
  });

  assert.equal(receipt.value, "100n");
  assert.deepEqual(receipt.trace.map((t) => `${t.depth} ${t.program}.${t.method} ← ${t.from}`), [
    "0 wallet.forward ← alice",
    "1 wallet.deposit ← wallet",
  ]);
  assert.deepEqual(receipt.nativeChanges, [
    { address: "alice", field: "sended", after: "100n" },
    { address: "wallet", field: "received", after: "140n" }, // 100 from alice + 40 from itself
    { address: "wallet", field: "sended", after: "40n" },
    { address: "alice", field: "consumed", after: receipt.fee },
    { address: VM.BURN_ADDRESS, field: "received", after: receipt.fee }, // no feeRecipient set → everything burned
  ]);
});

test("receipt: OUT_OF_GAS and TIMEOUT", () => {
  const vm = setup({ gas: { ...GAS, price: 1 } }, { alice: 150 });
  const outOfGas = receiptOf(vm, "call", { programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice"), nonce: 0 });
  assert.equal(outOfGas.error.code, "OUT_OF_GAS");
  assert.deepEqual(outOfGas.nativeChanges, [
    { address: "alice", field: "consumed", after: "150n" }, // pays what it has
    { address: VM.BURN_ADDRESS, field: "received", after: "150n" },
  ]);
  assert.deepEqual(outOfGas.stateChanges, []);

  const slow = setup({ requireNonce: false, chargeGas: false });
  slow.timeoutMs = 100;
  slow.commit(slow.deploy({ programUuid: "faulty", code: FAULTY, context: user("alice") }, { timestamp: T }).writes);
  slow.commit(slow.init({ programUuid: "faulty" }, { timestamp: T }).writes);
  const timeout = slow.buildReceipt(
    { programUuid: "faulty", functionName: "spin", context: user("alice") },
    slow.call({ programUuid: "faulty", functionName: "spin", context: user("alice") }, { timestamp: T }),
    { action: "call" },
  );
  assert.equal(timeout.error.code, "TIMEOUT");
  assert.deepEqual(timeout.trace, [{ depth: 0, program: "faulty", method: "spin", from: "alice", origin: "alice", input: {}, value: "0n", result: null, gasUsed: 150, status: "throw", error: { code: "TIMEOUT", message: "โปรแกรมทำงานเกินเวลาที่กำหนด" } }]);
});

test("receipt: infers the action when none is given", () => {
  const vm = setup();
  const transfer = vm.transfer({ from: "alice", to: "bob", amount: 10, nonce: 0 }, { timestamp: T });
  assert.equal(vm.buildReceipt({ from: "alice", to: "bob", amount: 10 }, transfer).action, "transfer");
  assert.equal(vm.buildReceipt({ programUuid: "token", functionName: "x", context: user("a") }, {}).action, "call");
  assert.equal(vm.buildReceipt({ programUuid: "p", code: "x", context: user("a") }, {}).action, "deploy");
  assert.equal(vm.buildReceipt({}, {}).action, "unknown");
});

// ---------------------------------------------------------------------------
//  block.receipt()
// ---------------------------------------------------------------------------

test("block.receipt: summarizes every tx with totals", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "approve", input: { spender: "shop", amount: 500 }, context: user("alice"), nonce: 0 });
  block.call({ programUuid: "shop", functionName: "buy", context: user("alice"), nonce: 1 });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 2 });
  block.transfer({ from: "alice", to: "carol", amount: 300, nonce: 3 });
  block.call({ programUuid: "wallet", functionName: "deposit", context: user("alice"), value: 50, nonce: 4 });

  const receipt = block.receipt({ number: 1024 });
  assert.equal(receipt.number, 1024);
  assert.equal(receipt.time, "2024-06-01T10:00:00.000Z");
  assert.deepEqual([receipt.txCount, receipt.successCount, receipt.failedCount], [5, 4, 1]);
  assert.equal(receipt.feeRecipient, "miner");
  assert.equal(receipt.burnPercent, 50);
  assert.equal(num(receipt.fee), receipt.transactions.reduce((sum, tx) => sum + num(tx.fee), 0));
  assert.equal(receipt.gasUsed, receipt.transactions.reduce((sum, tx) => sum + tx.gasUsed, 0));

  assert.deepEqual(receipt.transactions.map((tx) => `${tx.index} ${tx.action} ${tx.from}→${tx.to}.${tx.method} ${tx.status}`), [
    "0 call alice→token.approve success",
    "1 call alice→shop.buy success",
    "2 call alice→token.transfer throw",
    "3 transfer alice→carol.transfer success",
    "4 call alice→wallet.deposit success",
  ]);
  assert.deepEqual(receipt.stateChanges.map((c) => `${c.program}/${c.key.join("/")}`), [
    "token/allowance/alice/shop",
    "token/balances/alice",
    "token/balances/shop",
    "shop/items/alice",
    "shop/sales",
    "wallet/deposits/alice",
  ]);

  const native = Object.fromEntries(receipt.nativeChanges.map((c) => [`${c.address}:${c.field}`, num(c.after)]));
  assert.equal(native["carol:received"], 300);
  assert.equal(native["wallet:received"], 50);
  assert.equal(native["miner:received"], Math.floor(num(receipt.fee) / 2));
  assert.equal(native["alice:sended"], 350);            // 300 + 50
  assert.equal(native["alice:consumed"], num(receipt.fee));
});

test("block.receipt: each tx's nativeChanges include the value before that tx (chained within the block) → shows how much changed", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.transfer({ from: "alice", to: "carol", amount: 300, nonce: 0 });
  block.transfer({ from: "alice", to: "carol", amount: 200, nonce: 1 });
  const [first, second] = block.receipt({ number: 3 }).transactions;
  const changes = (tx) => Object.fromEntries(tx.nativeChanges.map((c) => [`${c.address}:${c.field}`, num([c.before, c.after])]));

  assert.deepEqual(changes(first)["carol:received"], [0, 300]);
  assert.deepEqual(changes(second)["carol:received"], [300, 500]);          // continues from the previous tx in the same block
  assert.deepEqual(changes(second)["alice:sended"], [300, 500]);
  const [before, after] = changes(second)["alice:consumed"];
  assert.equal(after - before, num(second.fee));                                 // only this tx's gas
  for (const tx of [first, second]) for (const c of tx.nativeChanges) assert.ok(num(c.after) >= num(c.before), `${c.address}:${c.field}`);
});

test("block.receipt: matches the real DB after commit", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 10 }, context: user("alice"), nonce: 0 });
  block.transfer({ from: "alice", to: "dave", amount: 25, nonce: 1 });
  block.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 1 }, nonce: 2 });
  block.init({ programUuid: "counter" });

  const receipt = block.receipt({ number: 7 });
  block.commit();

  for (const change of receipt.stateChanges) {
    const dbKey = `${change.program}:storage:${change.key.map(encodeURIComponent).join(":")}`;
    assert.deepEqual(vm.db.readKeys([dbKey])[0], change.after, dbKey);
  }
  for (const change of receipt.nativeChanges) {
    assert.equal(vm.db.readKeys([`${change.address}:native:${change.field}`])[0], change.after, change.address);
  }
  assert.deepEqual(receipt.transactions.map((tx) => tx.action), ["call", "transfer", "deploy", "init"]);
});

test("block.receipt: an empty block and a block where every tx fails", () => {
  const vm = setup();
  const empty = vm.createBlock({ timestamp: T }).receipt({ number: 1 });
  assert.deepEqual([empty.txCount, empty.successCount, empty.failedCount, empty.gasUsed, empty.fee, empty.writeCount], [0, 0, 0, 0, "0n", 0]);
  assert.deepEqual([empty.transactions, empty.stateChanges, empty.nativeChanges], [[], [], []]);

  const failed = vm.createBlock({ timestamp: T });
  failed.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 0 });
  failed.call({ programUuid: "missing", functionName: "x", context: user("alice"), nonce: 1 });
  const receipt = failed.receipt({ number: 2 });
  assert.deepEqual([receipt.txCount, receipt.successCount, receipt.failedCount], [2, 0, 2]);
  assert.deepEqual(receipt.stateChanges, []);
  assert.deepEqual(receipt.nativeChanges.map((c) => c.address), ["alice", VM.BURN_ADDRESS]); // no feeRecipient set → everything burned to 0x000…000
});

test("block.receipt: converts to JSON for the explorer", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice"), nonce: 0 });

  const json = JSON.parse(JSON.stringify(block.receipt({ number: 3 })));
  assert.equal(json.transactions[0].stateChanges[0].program, "token");
  assert.deepEqual(json.transactions[0].stateChanges[0].key, ["balances", "alice"]);
  assert.equal(json.transactions[0].trace[0].method, "transfer");
});

test("block.receipt: block data is unchanged even if the returned receipt is modified", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.transfer({ from: "alice", to: "bob", amount: 10, nonce: 0 });
  const receipt = block.receipt();
  receipt.transactions[0].value = 999;
  receipt.transactions.length = 0;
  assert.equal(block.receipt().transactions[0].value, "10n");
});

test("decodeDbKey: parses every key type", () => {
  assert.deepEqual(VM.decodeDbKey("pending:0xabc"), { kind: "pending", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:code"), { kind: "code", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:context"), { kind: "context", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:this"), { kind: "this", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:nonce"), { kind: "nonce", address: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("0xabc:native:received"), { kind: "native", address: "0xabc", field: "received" });
  assert.deepEqual(VM.decodeDbKey("0xabc:storage:balances:0xdef"), { kind: "storage", address: "0xabc", key: ["balances", "0xdef"] });
  assert.deepEqual(VM.decodeDbKey("0xabc:storage:a%3Ab"), { kind: "storage", address: "0xabc", key: ["a:b"] });
});
