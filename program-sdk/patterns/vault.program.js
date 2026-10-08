/** ตัวอย่างโปรแกรมที่ใช้ pattern ปลอดภัยครบ: modifier + checks-effects-interactions + ล็อก */
export default function program() {
  // ---------- modifier ----------
  function onlyOwner(fn) {
    return function (params) {
      if (params.context.sender !== readDB("owner")) throw new Error("ไม่ใช่เจ้าของ");
      return fn(params);
    };
  }

  function nonReentrant(fn) {
    return function (params) {
      if (readDB("locked")) throw new Error("กำลังทำงานอยู่");
      writeDB("locked", true);
      try {
        return fn(params);
      } finally {
        deleteDB("locked");
      }
    };
  }

  // ---------- ภายใน ----------
  function initialization(params) {
    writeDB("owner", params.context.sender);
    writeDB("paused", false);
  }

  function balanceOf(account) {
    return readDB(map("balances", account)) || 0;
  }

  function requireAmount(amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("amount ไม่ถูกต้อง");
    return amount;
  }

  // ---------- ให้เรียกจากภายนอก ----------
  function deposit(params) {
    if (readDB("paused")) throw new Error("ปิดรับฝากชั่วคราว");
    const who = params.context.sender;
    writeDB(map("balances", who), balanceOf(who) + params.value);
    emit("Deposited", { who, amount: params.value });
    return balanceOf(who);
  }

  const withdraw = nonReentrant(function (params) {
    const who = params.context.sender;
    const amount = requireAmount(params.input.amount);
    if (balanceOf(who) < amount) throw new Error("ยอดไม่พอ");

    writeDB(map("balances", who), balanceOf(who) - amount);   // effects ก่อน
    transferNative(who, amount);                              // interactions ทีหลัง
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
