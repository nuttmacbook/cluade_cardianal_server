# Writing safe programs

## 1. reentrancy — a vulnerability that can actually lose funds

`runProgram` can call other programs, and that program can call back into ours **while the original function is still running** · at that point `readDB` only sees values that have already been written

### ❌ Wrong — transfer out first, update later

```js
function withdraw(params) {
  const balance = readDB(map("balances", params.context.sender)) || 0n;
  if (balance <= 0n) throw new Error("no funds");
  runProgram(params.context.sender, "receive", {}, { value: balance });   // ← called back here
  writeDB(map("balances", params.context.sender), 0n);                    // ← too late
}
```

An attacker deposits 100 and then withdraws repeatedly until everyone else's funds are drained · tested in the VM's `test/38-reentrancy.test.js`

### ✅ Right — checks-effects-interactions

```js
function withdraw(params) {
  const who = params.context.sender;
  const balance = readDB(map("balances", who)) || 0n;  // checks
  if (balance <= 0n) throw new Error("no funds");
  writeDB(map("balances", who), 0n);                   // effects — always update first
  transferNative(who, balance);                        // interactions — do last
}
```

### ✅ Right — lock with a flag when an outgoing call midway can't be avoided

```js
function withdraw(params) {
  if (readDB("locked")) throw new Error("already in progress");
  writeDB("locked", true);
  try {
    // … work that calls out …
  } finally {
    deleteDB("locked");        // always release
  }
}
```

If the tx fails, every write including `locked` is rolled back automatically, so it never stays stuck for the next tx

## 2. modifier — permission checks that are easy to read and hard to forget

```js
function program() {
  function onlyOwner(fn) {
    return function (params) {
      if (params.context.sender !== readDB("owner")) throw new Error("not the owner");
      return fn(params);
    };
  }

  function nonReentrant(fn) {
    return function (params) {
      if (readDB("locked")) throw new Error("already in progress");
      writeDB("locked", true);
      try { return fn(params); } finally { deleteDB("locked"); }
    };
  }

  const setPrice = onlyOwner(function (params) {
    writeDB("price", params.input.price);
    return readDB("price");
  });

  const withdraw = onlyOwner(nonReentrant(function (params) { … }));

  return { setPrice, withdraw };     // export the wrapped versions
}
```

Nest them as needed · the modifiers themselves are not returned, so nobody can call around them

## 3. Check `sender`, not `origin`

```js
if (params.context.sender !== readDB("owner")) throw new Error("not the owner");   // ✅
if (params.context.origin !== readDB("owner")) throw new Error("not the owner");   // ❌
```

`origin` is always the tx originator · if the owner is tricked into calling someone else's program, that program can call into ours while `origin` is still the owner

## 4. Sending funds to an address that can't handle them

```js
if (IsProgram(params.input.to)) throw new Error("destination is a program");
transferNative(params.input.to, amount);
```

Funds sent to a program that has no withdraw function are stuck forever

## 5. Always validate inputs

```js
const amount = params.input.amount;
if (typeof amount !== "bigint" || amount <= 0n) throw new Error("invalid amount");   // numbers in input are always BigInt
```

`input` comes straight from the user · the VM only checks that it is JSON

## 6. Beware outgoing calls that fail the whole tx

A `runProgram` that fails and isn't caught takes the whole tx down with it · if you don't want that

```js
try {
  runProgram(target, "notify", {});
} catch (error) {
  emit("NotifyFailed", { target, reason: error.message });   // main work can continue
}
```

## 7. Pre-signed signatures need a nonce

```js
const who = ecrecover(params.input.message, params.input.signature);
if (who !== readDB("admin")) throw new Error("invalid signature");
if (readDB(map("used", params.input.message.nonce))) throw new Error("already used");
writeDB(map("used", params.input.message.nonce), true);
```

No nonce = anyone can replay the same signature without limit

For signatures users make with MetaMask, use `eip712Digest` + `ecrecoverDigest` and always put `chainId: ChainId()` + `verifyingContract: ThisAddress()` in the domain
otherwise the same signature can be reused on another chain / another program that uses an identical-looking message (see permit in `TOKEN_PROGRAM`)

## 8. Key and data size

- A storage key can be at most **1,000 bytes** (1 Thai character = 9 bytes after encoding)
- Don't use long user-supplied text directly as a key; hash it first

```js
writeDB(map("posts", keccak256(params.input.title)), params.input.title);
```
