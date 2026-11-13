/* explorerscan/config.js [editable · settings]
   Values to change when using the explorer with your own chain · colors are in theme/colors.css · name / logo / menu are in index.html */
const EXPLORER = {
  /** Address of the node the explorer reads from, e.g. "https://chain.example.com" · "" = the same host that serves this page (served by server.js) */
  api: "",
  /** Dot colors before program names in the sidebar (cycled in order) */
  sideColors: ["#2f6df0", "#db2777", "#7c5ce6", "#0d9488", "#d97706", "#4d53d0", "#16a34a", "#e11d48"],
  /**
   * Reown (WalletConnect) — the Connect wallet button opens Reown's wallet picker: browser wallets (MetaMask / Brave / Rabby …)
   * + scan a QR code with a mobile wallet (MetaMask / Trust / OKX / Bitget … over 500 wallets) · works on phones without a browser wallet too
   * Get a free Project ID at https://cloud.reown.com (create an AppKit project · add the explorer's domain to the Domain allowlist)
   * "" = don't use Reown (connect to the browser wallet directly, as before)
   */
  reownProjectId: "",
  /** Chain status poll interval in ms (block number in the header · home page auto-refresh) */
  pollMs: 2000,
  /**
   * The chain's system programs → #system page (System programs) · addresses are looked up by the name (namespace) set by scripts/deploy-system.js
   * If the native coin uses another symbol (SYMBOL=BNB) → wbwsc becomes wbnb · lines can be removed / added
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
