/**
 * SDK ฝั่ง client ของเชน (ระยะ 3.3) — ใช้ได้ทั้ง node และ browser (ไม่ดึง VM / sandbox / LMDB มาด้วย)
 *
 *   import { createClient, keySigner, walletSigner } from "programvm/client";
 *   const client = createClient({ url: "http://localhost:3000" });
 *   const signer = keySigner(PRIVATE_KEY);                         // หรือ await walletSigner(window.ethereum) = MetaMask เซ็น
 *   const sent = await client.send({ action: "call", to: TOKEN, method: "transfer", input: { to: BOB, amount: "5n" } }, signer);
 *   const done = await client.wait(sent.hash);                     // ถึง block แล้ว / rejected / replaced (ตามใบที่แทนให้)
 *   await client.query({ programUuid: TOKEN, functionName: "balanceOf", input: { who: BOB } });
 *
 *   await client.send(fields, userSigner, { sponsor: keySigner(SPONSOR_KEY) })   // คนอื่นจ่ายแก๊สแทน (ผู้ใช้ไม่ต้องมีเหรียญ)
 * send() เติมให้เอง: chainId (/genesis) · from (address ของ signer) · nonce (/nonce/:address) · ค่าแก๊สแบบ EIP-1559
 *   (maxFeePerGas = 2 × base fee ถัดไป, tip 0 · ส่ง gasPrice มาเอง = tx แบบเดิม) · gasLimit 500000
 * ตัวเลขในผลของ server เป็น "123n" (BigInt) ตามแบบของเชน → fromChainValue() แปลงกลับเป็น BigInt
 * ลายเซ็นตรงกับ /sendtx ทุกไบต์ (ใช้ src/crypto/signature.js ตัวเดียวกับ server)
 */
import { addressOf, buildTypedData, hashTypedData, signTransaction, normalizeTransaction, randomPrivateKey, parseUint, DOMAIN_NAME, DOMAIN_VERSION }
  from "../src/crypto/signature.js";
import { signPermit, permitTypedData, signProgramMessage, recoverProgramMessage, signTypedDataDigest, recoverTypedDataDigest, typedDataDigest }
  from "../src/crypto/program-signature.js";
import { verifyProof, EMPTY_ROOT } from "../src/core/trie.js";
import { keccak256Hex, canonicalJson, headerFields } from "../src/core/encoding.js";

export { addressOf, buildTypedData, hashTypedData, signTransaction, normalizeTransaction, randomPrivateKey, parseUint, DOMAIN_NAME, DOMAIN_VERSION };
export { signPermit, permitTypedData, signProgramMessage, recoverProgramMessage, signTypedDataDigest, recoverTypedDataDigest, typedDataDigest };
/** ตรวจหลักฐาน Merkle ของ /proof · cardianal_getProof กับ stateRoot ของ header ที่เชื่อได้ (ผู้ผลิตเซ็น) → { exists, value } · ไม่ตรง = throw */
export { verifyProof, EMPTY_ROOT, headerFields };

export const DEFAULT_GAS_LIMIT = 500_000;

/** error จาก server (status ≠ 2xx) · body = ข้อมูลที่ server ส่งมา (เช่น simulation / issues) */
export class ChainError extends Error {
  constructor(message, { status, body } = {}) { super(message); this.status = status; this.body = body; }
}

/** "123n" → 123n ทั้ง object (ค่าอื่นไม่เปลี่ยน) */
export function fromChainValue(value) {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  if (Array.isArray(value)) return value.map(fromChainValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromChainValue(item)]));
  return value;
}
/** BigInt → "123n" (แบบที่ input ของเชนรับ) */
export const toChainValue = (value) => JSON.parse(JSON.stringify(value ?? null, (key, item) => (typeof item === "bigint" ? `${item}n` : item)));

/** signer จาก private key (node / script / test) */
export function keySigner(privateKey) {
  const address = addressOf(privateKey);
  return { address, signTransaction: async (tx) => signTransaction(tx, privateKey) };
}

/**
 * typed data สำหรับกระเป๋า (eth_signTypedData_v4): เหมือน buildTypedData แต่ field uint256 เป็นเลขฐานสิบล้วน
 * (เชนรับ "5n" / 5n / "0x5" ได้ แต่กระเป๋าทั่วไปอ่าน "5n" ไม่ออก) · digest เท่าเดิม
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
 * signer จากกระเป๋า EIP-1193 (MetaMask: window.ethereum) — เซ็นด้วย eth_signTypedData_v4 (typed data จาก buildTypedData)
 * address ไม่ส่ง = ขอสิทธิ์ด้วย eth_requestAccounts แล้วใช้บัญชีแรก
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
  if (!url) throw new Error("ต้องระบุ url ของ node");
  if (typeof fetchImpl !== "function") throw new Error("ไม่มี fetch (node 18+ / browser มีให้ หรือส่ง options.fetch)");
  const base = String(url).replace(/\/+$/, "");

  async function request(path, { method = "GET", body } = {}) {
    const response = await fetchImpl(base + path, method === "GET" ? {} : {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(toChainValue(body)),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    // /sendtx ตอบเหตุผลไว้หลายช่อง: error (ลายเซ็น / ตรวจโค้ด) · reason (nonce / โควตา) · simulation.error (รันแล้วไม่ผ่าน)
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
    /** ยอด native (wei) เป็น BigInt */
    balance: async (address) => fromChainValue((await client.address(address)).native?.balance ?? "0n"),
    transaction: (hash) => get(`/tx/${id(hash)}`),
    receipt: (hash) => get(`/tx/${id(hash)}/receipt`),
    program: (address) => get(`/program/${id(address)}`),
    abi: (address) => get(`/program/${id(address)}/abi`),
    query: ({ programUuid, functionName, input = {}, context } = {}) => post("/query", { programUuid, functionName, input, context }),

    /**
     * อ่านค่าใน state แบบไม่ต้องเชื่อ node (ระยะ 4.3): ขอหลักฐาน Merkle (/proof) + header ของ block นั้น แล้วตรวจเองทั้งหมด
     *   hash ของ header คำนวณกลับได้ · stateRoot ตรงกับหลักฐาน · producers (รายชื่อใน genesis) → ลายเซ็นผู้ผลิตต้องถูก
     *   → { blockNumber, blockHash, stateRoot, values: { dbKey: ค่า | undefined } } · ไม่ผ่าน = throw
     */
    async verifiedState(keys, { producers = null } = {}) {
      const proof = await get(`/proof?${keys.map((key) => `key=${id(key)}`).join("&")}`);
      const header = await get(`/block/${proof.blockNumber}`);
      const { chainId } = await client.genesis();
      if (keccak256Hex(canonicalJson(headerFields(header, chainId))) !== header.hash) throw new Error("hash ของ header ไม่ตรงกับข้อมูลใน header");
      if (header.hash !== proof.blockHash || header.stateRoot !== proof.stateRoot) throw new Error("หลักฐานไม่ได้มาจาก block นี้");
      if (producers) {
        const signer = header.producerSignature ? recoverTypedDataDigest(header.hash, header.producerSignature) : null;
        if (!signer || !producers.map((p) => p.toLowerCase()).includes(signer)) throw new Error("ลายเซ็นผู้ผลิตของ header ไม่ถูกต้อง");
      }
      const values = {};
      for (const item of proof.proofs) {
        const checked = verifyProof(header.stateRoot, item.dbKey, item.proof);
        values[item.dbKey] = checked.exists ? checked.value : undefined;
      }
      return { blockNumber: header.number, blockHash: header.hash, stateRoot: header.stateRoot, values };
    },

    /** เติม chainId / from / nonce / ค่าแก๊สที่ยังไม่ได้ใส่ → tx ที่พร้อมเซ็น */
    async prepare(fields = {}, { from } = {}) {
      const sender = String(fields.from ?? from ?? "").toLowerCase();
      if (!sender) throw new Error("ต้องมี from (หรือส่ง signer)");
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

    /** POST /sendtx ของ tx ที่เซ็นแล้ว (sponsorSignature = ลายเซ็นของผู้จ่ายแก๊สแทน เมื่อ tx มี sponsor) */
    submit: ({ tx, signature, sponsorSignature }) => post("/sendtx", { tx, signature, ...(sponsorSignature ? { sponsorSignature } : {}) }),

    /**
     * เตรียม → เซ็น → POST /sendtx · ไม่ผ่าน (ลายเซ็น / simulate / nonce) = throw ChainError พร้อม body ของ server
     * options.sponsor = signer ของผู้จ่ายแก๊สแทน: ใส่ tx.sponsor ให้ แล้วให้ sponsor เซ็น digest เดียวกัน
     *   (ถ้า sponsor เป็นบริการอื่น: prepare({ ...fields, sponsor }) → signer เซ็น → ส่ง { tx, signature } ให้บริการนั้นเซ็นแล้ว submit)
     */
    async send(fields, signer, { sponsor } = {}) {
      if (!signer?.signTransaction) throw new Error("ต้องส่ง signer (keySigner / walletSigner)");
      const tx = toChainValue(await client.prepare(sponsor ? { ...fields, sponsor: sponsor.address } : fields, { from: signer.address }));
      const signature = await signer.signTransaction(tx);
      const sponsorSignature = sponsor ? await sponsor.signTransaction(tx) : undefined;
      return { ...(await client.submit({ tx, signature, sponsorSignature })), tx, signature, ...(sponsorSignature ? { sponsorSignature } : {}) };
    },

    /**
     * รอจนใบนี้จบ: อยู่ใน block แล้ว → ผลของ /tx · rejected → ผลนั้น · replaced → รอใบที่แทน (ผลมี replaced: [hash เดิม …])
     * เกินเวลา = throw ChainError status 408
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
        if (Date.now() >= deadline) throw new ChainError(`รอ ${current} เกิน ${timeoutMs} ms`, { status: 408 });
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  };
  return client;
}
