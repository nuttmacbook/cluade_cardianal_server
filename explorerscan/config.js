/* explorerscan/config.js [แก้ได้ · ตั้งค่า]
   ค่าที่ต้องเปลี่ยนเมื่อเอา explorer ไปใช้กับเชนตัวเอง · สีอยู่ใน theme/colors.css · ชื่อ / โลโก้ / เมนูอยู่ใน index.html */
const EXPLORER = {
  /** ที่อยู่ของ node ที่ explorer อ่านข้อมูล เช่น "https://chain.example.com" · "" = เครื่องเดียวกับที่เปิดหน้านี้ (server.js เสิร์ฟให้) */
  api: "",
  /** สีจุดหน้าชื่อโปรแกรมในเมนูข้าง (วนตามลำดับ) */
  sideColors: ["#2f6df0", "#db2777", "#7c5ce6", "#0d9488", "#d97706", "#4d53d0", "#16a34a", "#e11d48"],
  /** ถามสถานะเชนทุกกี่ ms (เลข block ที่หัวเว็บ · หน้าแรกอัปเดตเอง) */
  pollMs: 2000,
  /**
   * โปรแกรมกลางของเชน → หน้า #system (System programs) · หา address จากชื่อ (namespace) ที่ scripts/deploy-system.js ตั้งให้
   * เปลี่ยนเหรียญหลักเป็นสัญลักษณ์อื่น (SYMBOL=BNB) → ชื่อ wbwsc เป็น wbnb · ลบ / เพิ่มบรรทัดได้
   */
  systemPrograms: [
    { name: "multicall", title: "Multicall", about: "Read many values from many programs in one request (like Multicall3)" },
    { name: "wbwsc", title: "Wrapped BWSC", about: "Deposit the native coin, get the token 1:1 · withdraw any time (like WETH / WBNB)" },
    { name: "factory", title: "Factory", about: "Create your own token / NFT / multi-token / multisig instantly, no approval wait" },
    { name: "multisig-template", title: "Multisig template", about: "Team wallet: m-of-n owners confirm before anything moves · create one with factory.createMultisig" },
    { name: "token-template", title: "Token template", about: "Standard token with permit · create one with factory.createToken" },
    { name: "nft-template", title: "NFT template", about: "Standard NFT collection · create one with factory.createNft" },
    { name: "multitoken-template", title: "Multi-token template", about: "Standard multi-token (ERC-1155 style) · create one with factory.createMultiToken" },
    { name: "multisender", title: "Multisender", about: "Send the native coin / tokens / NFTs / multi-tokens to up to 100 addresses in one tx" },
    { name: "token-lock", title: "Token lock", about: "Lock tokens or LP until a date, with optional vesting (like PinkLock)" },
    { name: "dex", title: "DEX", about: "Swap tokens and the native coin, add liquidity (Uniswap V2 style · 0.3% fee to liquidity providers)" },
    { name: "dex-pair-template", title: "DEX pair template", about: "Template for trading pairs · the dex creates pairs from it" },
    { name: "staking", title: "Staking", about: "Flexible staking pools: stake and withdraw any time, rewards stream per second" },
    { name: "limit-order", title: "Limit order", about: "Place token ↔ token orders at your price · anyone can fill them" },
    { name: "nft-market", title: "NFT market", about: "Buy and sell NFTs and multi-tokens · make and accept offers" },
  ],
};
