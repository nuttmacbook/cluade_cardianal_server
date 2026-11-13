/**
 * Client-side SDK for the chain (phase 3.3) — works in both node and the browser (doesn't pull in the VM / sandbox / LMDB)
 *
 *   import { createClient, keySigner, walletSigner } from "programvm/client";
 *   const client = createClient({ url: "http://localhost:3000" });
 *   const signer = keySigner(PRIVATE_KEY);                         // or await walletSigner(window.ethereum) = MetaMask signs
 *   const sent = await client.send({ action: "call", to: TOKEN, method: "transfer", input: { to: BOB, amount: "5n" } }, signer);
 *   const done = await client.wait(sent.hash);                     // in a block / rejected / replaced (follows the replacement)
 *   await client.query({ programUuid: TOKEN, functionName: "balanceOf", input: { who: BOB } });
 *
 *   await client.send(fields, userSigner, { sponsor: keySigner(SPONSOR_KEY) })   // someone else pays the gas (the user needs no coins)
 * send() fills in: chainId (/genesis) · from (the signer's address) · nonce (/nonce/:address) · EIP-1559 gas fees
 *   (maxFeePerGas = 2 × next base fee, tip 0 · passing gasPrice yourself = a legacy tx) · gasLimit 500000
 * numbers in server responses are "123n" (BigInt), the chain's format → fromChainValue() converts them back to BigInt
 * signatures match /sendtx byte for byte (uses the same src/crypto/signature.js as the server)
 */
import { addressOf, buildTypedData, hashTypedData, signTransaction, normalizeTransaction, randomPrivateKey, parseUint, DOMAIN_NAME, DOMAIN_VERSION }
  from "../src/crypto/signature.js";
import { signPermit, permitTypedData, signProgramMessage, recoverProgramMessage, signTypedDataDigest, recoverTypedDataDigest, typedDataDigest }
  from "../src/crypto/program-signature.js";
import { verifyProof, EMPTY_ROOT } from "../src/core/trie.js";
import { keccak256Hex, canonicalJson, headerFields } from "../src/core/encoding.js";

export { addressOf, buildTypedData, hashTypedData, signTransaction, normalizeTransaction, randomPrivateKey, parseUint, DOMAIN_NAME, DOMAIN_VERSION };
export { signPermit, permitTypedData, signProgramMessage, recoverProgramMessage, signTypedDataDigest, recoverTypedDataDigest, typedDataDigest };
/** verify a Merkle proof from /proof · cardianal_getProof against the stateRoot of a trusted header (signed by the producer) → { exists, value } · mismatch = throw */
export { verifyProof, EMPTY_ROOT, headerFields };

export const DEFAULT_GAS_LIMIT = 500_000;

/** error from the server (status ≠ 2xx) · body = the data the server returned (e.g. simulation / issues) */
export class ChainError extends Error {
  constructor(message, { status, body } = {}) { super(message); this.status = status; this.body = body; }
}

/** "123n" → 123n across a whole object (other values unchanged) */
export function fromChainValue(value) {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  if (Array.isArray(value)) return value.map(fromChainValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromChainValue(item)]));
  return value;
}
/** BigInt → "123n" (the form chain input accepts) */
export const toChainValue = (value) => JSON.parse(JSON.stringify(value ?? null, (key, item) => (typeof item === "bigint" ? `${item}n` : item)));

/** signer from a private key (node / script / test) */
export function keySigner(privateKey) {
  const address = addressOf(privateKey);
  return { address, signTransaction: async (tx) => signTransaction(tx, privateKey) };
}

/**
 * typed data for wallets (eth_signTypedData_v4): like buildTypedData but uint256 fields are plain decimal
 * (the chain accepts "5n" / 5n / "0x5", but ordinary wallets can't read "5n") · same digest
 */
export function walletTypedData(tx) {
  const typed = buildTypedData(tx);
  const message = { ...typed.message };
  for (const field of typed.types.Transaction) {
    if (field.type === "uint256" && message[field.name] !== undefined) message[field.name] = String(parseUint(message[field.name]) ?? message[field.name]);
  }
  return { ...typed, message };
}

/**
 * signer from an EIP-1193 wallet (MetaMask: window.ethereum) — signs with eth_signTypedData_v4 (typed data from buildTypedData)
 * address omitted = request access via eth_requestAccounts and use the first account
 */
export async function walletSigner(provider, address) {
  const account = String(address ?? (await provider.request({ method: "eth_requestAccounts" }))[0]).toLowerCase();
  return {
    address: account,
    signTransaction: (tx) => provider.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(walletTypedData(tx))] }),
  };
}

/**
 * @param {{ url: string, fetch?: typeof fetch, gasLimit?: number }} options
 */
export function createClient({ url, fetch: fetchImpl = globalThis.fetch, gasLimit = DEFAULT_GAS_LIMIT } = {}) {
  if (!url) throw new Error("node url is required");
  if (typeof fetchImpl !== "function") throw new Error("no fetch available (node 18+ / browsers have it, or pass options.fetch)");
  const base = String(url).replace(/\/+$/, "");

  async function request(path, { method = "GET", body } = {}) {
    const response = await fetchImpl(base + path, method === "GET" ? {} : {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(toChainValue(body)),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    // /sendtx reports reasons in several fields: error (signature / code review) · reason (nonce / quota) · simulation.error (ran but failed)
    const message = data?.error ?? data?.reason ?? data?.simulation?.error?.message ?? data?.simulation?.error;
    if (!response.ok) throw new ChainError(typeof message === "string" ? message : `HTTP ${response.status}`, { status: response.status, body: data });
    return data;
  }
  const get = (path) => request(path);
  const post = (path, body) => request(path, { method: "POST", body });
  const id = (value) => encodeURIComponent(String(value));

  const client = {
    url: base,
    get, post,
    genesis: () => get("/genesis"),
    health: () => get("/health"),
    nonce: async (address) => (await get(`/nonce/${id(address)}`)).nonce,
    address: (address) => get(`/address/${id(address)}`),
    /** native balance (wei) as BigInt */
    balance: async (address) => fromChainValue((await client.address(address)).native?.balance ?? "0n"),
    transaction: (hash) => get(`/tx/${id(hash)}`),
    receipt: (hash) => get(`/tx/${id(hash)}/receipt`),
    program: (address) => get(`/program/${id(address)}`),
    abi: (address) => get(`/program/${id(address)}/abi`),
    query: ({ programUuid, functionName, input = {}, context } = {}) => post("/query", { programUuid, functionName, input, context }),

    /**
     * read state without trusting the node (phase 4.3): request Merkle proofs (/proof) + that block's header, then verify everything locally
     *   the header hash is recomputable · stateRoot matches the proof · producers (the list in genesis) → the producer signature must be valid
     *   → { blockNumber, blockHash, stateRoot, values: { dbKey: value | undefined } } · failure = throw
     */
    async verifiedState(keys, { producers = null } = {}) {
      const proof = await get(`/proof?${keys.map((key) => `key=${id(key)}`).join("&")}`);
      const header = await get(`/block/${proof.blockNumber}`);
      const { chainId } = await client.genesis();
      if (keccak256Hex(canonicalJson(headerFields(header, chainId))) !== header.hash) throw new Error("header hash does not match the header data");
      if (header.hash !== proof.blockHash || header.stateRoot !== proof.stateRoot) throw new Error("the proof is not from this block");
      if (producers) {
        const signer = header.producerSignature ? recoverTypedDataDigest(header.hash, header.producerSignature) : null;
        const allowed = typeof producers === "function" ? producers(header.number) : producers;   // a list, or (block number) => list
        if (!signer || !allowed?.map((p) => p.toLowerCase()).includes(signer)) throw new Error("invalid producer signature on the header");
      }
      const values = {};
      for (const item of proof.proofs) {
        const checked = verifyProof(header.stateRoot, item.dbKey, item.proof);
        values[item.dbKey] = checked.exists ? checked.value : undefined;
      }
      return { blockNumber: header.number, blockHash: header.hash, stateRoot: header.stateRoot, values };
    },

    /** fill in missing chainId / from / nonce / gas fees → a tx ready to sign */
    async prepare(fields = {}, { from } = {}) {
      const sender = String(fields.from ?? from ?? "").toLowerCase();
      if (!sender) throw new Error("from is required (or pass a signer)");
      const needsFee = fields.gasPrice === undefined && fields.maxFeePerGas === undefined;
      const info = fields.chainId === undefined || needsFee ? await client.genesis() : null;
      const baseFee = BigInt(String(info?.baseFee ?? info?.gasPrice ?? 1).replace(/n$/, ""));
      return {
        action: "call", to: "", method: "", input: {}, value: "0", gasLimit,
        ...(needsFee ? { maxFeePerGas: String(baseFee * 2n), maxPriorityFeePerGas: "0" } : {}),
        ...fields,
        chainId: fields.chainId ?? info.chainId,
        from: sender,
        nonce: fields.nonce ?? (await client.nonce(sender)),
      };
    },

    /** POST /sendtx for a signed tx (sponsorSignature = the gas sponsor's signature, when the tx has a sponsor) */
    submit: ({ tx, signature, sponsorSignature }) => post("/sendtx", { tx, signature, ...(sponsorSignature ? { sponsorSignature } : {}) }),

    /**
     * prepare → sign → POST /sendtx · failure (signature / simulate / nonce) = throws ChainError with the server's body
     * options.sponsor = the gas sponsor's signer: sets tx.sponsor, then has the sponsor sign the same digest
     *   (if the sponsor is another service: prepare({ ...fields, sponsor }) → signer signs → send { tx, signature } to that service to sign and submit)
     */
    async send(fields, signer, { sponsor } = {}) {
      if (!signer?.signTransaction) throw new Error("a signer is required (keySigner / walletSigner)");
      const tx = toChainValue(await client.prepare(sponsor ? { ...fields, sponsor: sponsor.address } : fields, { from: signer.address }));
      const signature = await signer.signTransaction(tx);
      const sponsorSignature = sponsor ? await sponsor.signTransaction(tx) : undefined;
      return { ...(await client.submit({ tx, signature, sponsorSignature })), tx, signature, ...(sponsorSignature ? { sponsorSignature } : {}) };
    },

    /**
     * wait until this tx finishes: in a block → the /tx result · rejected → that result · replaced → waits for the replacement (result has replaced: [old hashes …])
     * timeout = throws ChainError status 408
     */
    async wait(hash, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
      const deadline = Date.now() + timeoutMs;
      const replaced = [];
      let current = hash;
      for (;;) {
        let found = null;
        try { found = await client.transaction(current); }
        catch (error) { if (error.status !== 404) throw error; }
        if (found?.status === "replaced" && found.replacedBy) { replaced.push(current); current = found.replacedBy; continue; }
        if (found && found.status !== "pending" && (found.status === "rejected" || Number.isInteger(found.blockNumber))) {
          return replaced.length ? { ...found, replaced } : found;
        }
        if (Date.now() >= deadline) throw new ChainError(`waited for ${current} longer than ${timeoutMs} ms`, { status: 408 });
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  };
  return client;
}
