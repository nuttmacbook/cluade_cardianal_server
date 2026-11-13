/** Example program using every safe pattern: modifier + checks-effects-interactions + lock */
export default function program() {
  // ---------- modifier ----------
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
      try {
        return fn(params);
      } finally {
        deleteDB("locked");
      }
    };
  }

  // ---------- internal ----------
  function initialization(params) {
    writeDB("owner", params.context.sender);
    writeDB("paused", false);
  }

  function balanceOf(account) {
    return readDB(map("balances", account)) || 0n;
  }

  function requireAmount(amount) {
    if (typeof amount !== "bigint" || amount <= 0n) throw new Error("invalid amount");   // numbers are always BigInt
    return amount;
  }

  // ---------- callable from outside ----------
  function deposit(params) {
    if (readDB("paused")) throw new Error("deposits temporarily paused");
    const who = params.context.sender;
    writeDB(map("balances", who), balanceOf(who) + params.value);
    emit("Deposited", { who, amount: params.value });
    return balanceOf(who);
  }

  const withdraw = nonReentrant(function (params) {
    const who = params.context.sender;
    const amount = requireAmount(params.input.amount);
    if (balanceOf(who) < amount) throw new Error("insufficient balance");

    writeDB(map("balances", who), balanceOf(who) - amount);   // effects first
    transferNative(who, amount);                              // interactions after
    emit("Withdrawn", { who, amount });
    return balanceOf(who);
  });

  const setPaused = onlyOwner(function (params) {
    writeDB("paused", params.input.paused === true);
    emit("PausedChanged", { paused: readDB("paused") });
    return readDB("paused");
  });

  function myBalance(params) {
    return balanceOf(params.context.sender);
  }

  return { deposit, withdraw, setPaused, myBalance };
}
