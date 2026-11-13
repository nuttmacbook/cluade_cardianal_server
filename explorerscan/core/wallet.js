/* explorerscan/core/wallet.js [ระบบ · ไม่ต้องแก้]
   กระเป๋า + ลายเซ็น: ต่อ MetaMask, เพิ่มเชนเข้า MetaMask, เซ็น tx แบบ EIP-712 แล้วส่ง /sendtx
   ⚠️ canonical() / signingInput() ต้องตรงกับ VM ทุกไบต์ (เทสต์ 46 คุม) แก้ผิด = ลายเซ็นจากหน้าเว็บใช้ไม่ได้ทั้งหมด */

// ---------- wallet ----------
// no chainId in the domain → the wallet signs whatever chain it has open (no need to add this chain) · chainId sits in the message
// and the node rejects a different one (no replay across chains) · must match signature.js (DOMAIN_TYPE / TRANSACTION_TYPE)
const DOMAIN = { name: "Bluewolfchain", version: "2" };
const DOMAIN_TYPE = [{ name: "name", type: "string" }, { name: "version", type: "string" }];
const SIGNED_ON = { name: "signedOnChainId", type: "uint256" };   // the chain the wallet had open (shown on the tx page)
const BASE_TYPE = [
  { name: "chainId", type: "uint256" }, { name: "action", type: "string" }, { name: "from", type: "address" }, { name: "to", type: "string" },
  { name: "method", type: "string" }, { name: "input", type: "string" }, { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "gasLimit", type: "uint256" }, { name: "gasPrice", type: "uint256" },
];
const TX_TYPE = [...BASE_TYPE, SIGNED_ON];
// EIP-1559: same fields without gasPrice, plus maxFeePerGas / maxPriorityFeePerGas (TRANSACTION_TYPE_1559 in signature.js)
const TX_TYPE_1559 = [...BASE_TYPE.filter((f) => f.name !== "gasPrice"),
  { name: "maxFeePerGas", type: "uint256" }, { name: "maxPriorityFeePerGas", type: "uint256" }, SIGNED_ON];
let wallet = null;          // lower-case: for the node (from / nonce / balance)
let walletAccount = null;   // exactly as the wallet returned it: Brave Wallet only signs for that exact string (MetaMask accepts any case)

/** canonical JSON, same as the VM (sorted keys, bigint as "123n") */
function canonical(value) {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** signed input + code — must match buildTypedData() in signature.js (0x… hex strings lower-cased, values and keys) */
function signingInput(tx) {
  const lower = (v) => (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? v.toLowerCase() : v);
  const deep = (v) => (Array.isArray(v) ? v.map(deep)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [lower(k), deep(x)])) : lower(v));
  // deploy with an upgrader: upgrader joins input + code (no upgrader = left out, so the signed text is unchanged)
  return canonical({ input: deep(tx.input ?? {}), code: tx.code ?? null, ...(tx.upgrader ? { upgrader: String(tx.upgrader).toLowerCase() } : {}) });
}

// ---------- provider: Reown (WalletConnect + any wallet) when EXPLORER.reownProjectId is set · else the browser wallet (window.ethereum) ----------
const REOWN_CDN = "https://cdn.jsdelivr.net/npm/@reown/appkit-cdn@1.8.24/dist/appkit.js";   // exact version · change both together when upgrading
let reownProvider = null;    // EIP-1193 provider of the wallet connected through Reown (null = use window.ethereum)
let reownKitLoad = null;    // Promise<AppKit | null> · null result = Reown not set up / failed to load → browser wallet
const walletProvider = () => {
  const p = reownProvider ?? window.ethereum;
  if (!p) throw new Error(EXPLORER.reownProjectId ? "No wallet connected — press Connect wallet" : "No wallet found — install MetaMask first");
  return p;
};

function showWallet() {
  const button = document.getElementById("wbtn");
  if (button) button.textContent = wallet ? cut(wallet) : "Connect wallet";
}
function useAccount(account) {
  walletAccount = account ? String(account) : null;
  wallet = walletAccount ? walletAccount.toLowerCase() : null;
  showWallet();
}

/** AppKit loaded once (the chain itself is the default network: chainId / name / symbol / RPC / explorer from GET /evm) */
function reown() {
  if (!EXPLORER.reownProjectId) return Promise.resolve(null);
  reownKitLoad ??= (async () => {
    const [{ createAppKit, WagmiAdapter }, evm] = await Promise.all([import(REOWN_CDN), api("/evm")]);
    const id = Number(BigInt(evm.chainId));
    const chain = { id, caipNetworkId: `eip155:${id}`, chainNamespace: "eip155", name: evm.chainName, nativeCurrency: evm.nativeCurrency,
      rpcUrls: { default: { http: evm.rpcUrls } },
      ...(evm.blockExplorerUrls?.[0] ? { blockExplorers: { default: { name: evm.chainName, url: evm.blockExplorerUrls[0] } } } : {}) };
    const projectId = EXPLORER.reownProjectId;
    const kit = createAppKit({ adapters: [new WagmiAdapter({ projectId, networks: [chain] })], networks: [chain], defaultNetwork: chain, projectId,
      metadata: { name: document.title, description: document.title, url: location.origin, icons: [`${location.origin}/favicon.ico`] },
      features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, history: false } });
    // connected / switched / disconnected in the Reown window or in the wallet → follow it
    kit.subscribeAccount((state) => {
      reownProvider = state?.isConnected ? kit.getWalletProvider() ?? reownProvider : null;
      useAccount(state?.isConnected ? state.address : null);
    });
    return kit;
  })().catch((error) => { console.warn("Reown failed to load — using the browser wallet", error); return null; });
  return reownKitLoad;
}

/** wait until the Reown window connects a wallet (rejects when it is closed first) */
function reownConnect(kit) {
  return new Promise((resolve, reject) => {
    let opened = false;
    const stop = [];
    const done = (fn, value) => { stop.forEach((off) => off?.()); fn(value); };
    stop.push(kit.subscribeAccount((state) => {
      if (state?.isConnected && state.address) {
        reownProvider = kit.getWalletProvider() ?? reownProvider;
        useAccount(state.address);
        if (reownProvider) done(resolve);
      }
    }));
    stop.push(kit.subscribeState((state) => {
      if (state?.open) opened = true;
      else if (opened && !wallet) done(reject, new Error("Wallet not connected"));
    }));
    kit.open();
  });
}

/** rerender = false while sending a tx — redrawing would remove the result box (#out) */
async function connect(rerender = true) {
  const kit = await reown();
  if (kit) {
    if (!wallet || !reownProvider) await reownConnect(kit);
  } else {
    const [account] = await walletProvider().request({ method: "eth_requestAccounts" });
    useAccount(account);
  }
  if (rerender) render(true);
}

/** header button: Reown → its window (connect / switch account or network / disconnect) · browser wallet → ask for the account */
async function walletButton() {
  const kit = await reown();
  if (kit && wallet) return kit.open();
  return connect();
}

/**
 * the account to sign with, still authorized for this site right now
 *   MetaMask only signs for accounts the site was granted (eth_accounts) · switching / disconnecting the account in the wallet
 *   after connecting leaves the old address here → error 4100 "not authorized" · so ask again whenever it is not in the list
 */
async function ensureWallet() {
  const kit = await reown();
  if (kit && !reownProvider) { await connect(false); return wallet; }
  let accounts = [];
  try { accounts = (await walletProvider().request({ method: "eth_accounts" })) ?? []; } catch {}
  const same = accounts.find((a) => String(a).toLowerCase() === wallet);
  if (wallet && same) { walletAccount = String(same); return wallet; }
  if (accounts.length) {   // the wallet switched to another authorized account → use the one it has selected
    useAccount(accounts[0]);
    return wallet;
  }
  await connect(false);   // not authorized (yet / any more) → the wallet asks the user to connect
  return wallet;
}

// account switched / disconnected in the wallet → follow it (no stale address left to sign with)
// (Reown follows its own wallet through subscribeAccount · start Reown early so a wallet connected before reconnects on reload)
window.ethereum?.on?.("accountsChanged", (accounts) => { if (!reownProvider) useAccount(accounts?.[0]); });
reown();

/** add this chain to the wallet (MetaMask): chainId / name / symbol / rpcUrls / explorer come from GET /evm of the node */
async function addNetwork() {
  if (EXPLORER.reownProjectId && !reownProvider) await connect(false);
  await walletProvider().request({ method: "wallet_addEthereumChain", params: [await api("/evm")] });
}

/** chain the wallet has open right now (any EVM chain works · recorded as signedOnChainId) */
async function walletChainId() {
  try { return Number(BigInt(await walletProvider().request({ method: "eth_chainId" }))); } catch { return null; }
}

/**
 * balance + fee before signing — the wallet cannot show them while it is on another chain (it asks that chain's node, not this one)
 *   call: gas from POST /query + the per-tx base · transfer: per-tx base + 1 call + 2 reads / writes · other actions: the gas limit (upper bound)
 *   → { balance, gas, fee, maxFee, exact } (wei / gas as BigInt) · throws when the balance cannot cover value + fee
 */
async function estimateCost(tx, info) {
  const prices = info.gas ?? {};
  const base = toBig(info.baseFee ?? info.gasPrice ?? 1);
  const balance = toBig((await api(`/address/${wallet}?limit=1`).catch(() => ({}))).native?.balance);
  let gas = null;
  if (tx.action === "call") {
    const res = await api("/query", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ programUuid: tx.to, functionName: tx.method, input: tx.input, value: tx.value, context: { sender: wallet, origin: wallet } }) }).catch(() => null);
    if (res?.status === "success" && res.gasUsed !== undefined) gas = BigInt(res.gasUsed) + toBig(prices.tx ?? 0);
  } else if (tx.action === "transfer") {
    gas = toBig(prices.tx ?? 0) + toBig(prices.call) + 2n * toBig(prices.read) + 2n * toBig(prices.write);
  }
  const limit = BigInt(tx.gasLimit);
  const exact = gas !== null;
  if (!exact || gas > limit) gas = limit;
  const fee = gas * base;
  const maxFee = limit * toBig(tx.maxFeePerGas ?? tx.gasPrice ?? base);
  const value = toBig(tx.value);
  // no exact estimate → the limit is only a cap (the node lowers it to what the balance can pay · charges only the gas used) → check the value alone
  if (balance < value + (exact ? fee : 0n)) throw new Error(`Not enough ${info.symbol}: balance ${coin(balance)} · needs ≈ ${coin(value + (exact ? fee : 0n))} (value${exact ? " + fee" : ""})`);
  return { balance, gas, fee, maxFee, exact };
}
let nativeSymbol = null;   // from GET /evm (EVM_SYMBOL of the node) · read once
async function coinSymbol() {
  nativeSymbol ??= (await api("/evm").catch(() => null))?.nativeCurrency?.symbol ?? "BWSC";
  return nativeSymbol;
}

/** sign and send to the chain — returns the /sendtx response · onCost(text) shows balance + fee before the wallet pops up */
async function sendTx(fields, { onCost } = {}) {
  await ensureWallet();
  const info = await api("/genesis");
  const signedOn = await walletChainId();
  const { nonce } = await api(`/nonce/${wallet}`);
  // EIP-1559: pay at most 2 × the next base fee (room for it to rise while waiting) · no tip — the price is base fee only
  const baseFee = toBig(info.baseFee ?? info.gasPrice ?? 1);
  // gas limit: callers that set none get the per-tx cap (= block gas · e.g. a deploy of a big program needs ~1M) · only the gas used is charged
  // and when the gas can be estimated (call / transfer) the limit drops to the estimate + 30 %
  const maxGas = Number(info.maxBlockGas) > 0 ? Number(info.maxBlockGas) : 5_000_000;
  const autoLimit = fields.gasLimit === undefined;
  const tx = { chainId: info.chainId, signedOnChainId: signedOn ?? info.chainId, action: "call", from: wallet, to: "", method: "", input: {},
    value: "0", nonce, gasLimit: maxGas,
    ...(fields.gasPrice === undefined ? { maxFeePerGas: String(baseFee * 2n), maxPriorityFeePerGas: "0" } : {}), ...fields };   // wei per gas

  const legacy = tx.maxFeePerGas === undefined;   // a caller passing gasPrice signs the legacy type
  const symbol = await coinSymbol();
  const cost = await estimateCost(tx, { ...info, symbol });
  if (autoLimit && cost.exact) {
    tx.gasLimit = Math.min(maxGas, Math.ceil(Number(cost.gas) * 1.3));
    cost.maxFee = BigInt(tx.gasLimit) * toBig(tx.maxFeePerGas ?? tx.gasPrice ?? baseFee);
  }
  const text = `Balance ${coin(cost.balance)} ${symbol} · ${cost.exact ? `fee ≈ ${coin(cost.fee)} ${symbol} (max ${coin(cost.maxFee)})` : `fee = gas used × ${coin(baseFee)} ${symbol} (limit ${tx.gasLimit.toLocaleString()} gas)`}`
    + ` · signing on chain ${tx.signedOnChainId}${tx.signedOnChainId === info.chainId ? " (this chain)" : ""} — confirm in your wallet`;
  (onCost ?? (typeof busy === "function" ? busy : () => {}))(text);

  const message = { chainId: tx.chainId, action: tx.action, from: tx.from, to: tx.to, method: tx.method,
    input: signingInput(tx),
    value: tx.value, nonce: tx.nonce, gasLimit: tx.gasLimit,
    ...(legacy ? { gasPrice: tx.gasPrice } : { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }),
    signedOnChainId: tx.signedOnChainId };

  const signature = await walletProvider().request({
    method: "eth_signTypedData_v4",
    params: [walletAccount ?? wallet, JSON.stringify({ domain: DOMAIN,
      types: { EIP712Domain: DOMAIN_TYPE, Transaction: legacy ? TX_TYPE : TX_TYPE_1559 }, primaryType: "Transaction", message })],
  });

  return api("/sendtx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx, signature }) });
}
