/**
 * Syncs blocks from the producer node, re-executes them locally and compares hashes
 *   const stop = startSync(vm, { url: "https://node1.example.com", genesis, producers: genesis.config.producers });
 *
 * the reader node doesn't trust the state it is sent; it runs the blockbody itself and compares the blockHash
 * mismatch = the data disagrees; stop immediately and record nothing further
 *
 * Producer (header.producer is in the hash · header.producerSignature = signature over the hash):
 *   signed → must always recover the producer's address
 *   producers passed (the list in genesis, or producerSetOf(genesis), which changes per producerSchedule) → every block must have a producer in that block's list with a valid signature (block without a producer = rejected)
 * txs in a block run with vm.replayTimeoutMs (the producer already filtered out TIMEOUTs → slower machines don't diverge)
 * snapshot: true → the DB has no blocks yet and the source has /snapshot = load state at block N first (checked against the stateRoot the producer signed), then sync on from N + 1
 */
import { recoverTypedDataDigest } from "../crypto/program-signature.js";
import { syncFromSnapshot } from "./snapshot.js";
import { producerSetOf } from "./genesis.js";

const lower = (value) => String(value ?? "").toLowerCase();

/**
 * Check a header's producer → throw if not acceptable
 *   producers = a list, or (block number) => list (producerSetOf(genesis) · the list changes per producerSchedule)
 */
export function verifyProducer(header, producers = null) {
  const list = typeof producers === "function" ? producers(header.number) : producers;
  const allowed = list ? list.map(lower) : null;
  if (!header.producer) {
    if (allowed) throw new Error(`block ${header.number} has no producer (genesis defines producers)`);
    return null;
  }
  const producer = lower(header.producer);
  if (allowed && !allowed.includes(producer)) throw new Error(`block ${header.number} was produced by ${producer}, who is not in the producer list`);
  const signer = header.producerSignature ? recoverTypedDataDigest(header.hash, header.producerSignature) : null;
  if (signer !== producer) throw new Error(`block ${header.number} has an invalid producer signature`);
  return producer;
}

/** run one fetched block, then compare hashes */
export function applyBlock(vm, { header, body, rejected = [] }, { producers = null } = {}) {
  verifyProducer(header, producers);
  const block = vm.createBlock({
    number: header.number,
    parentHash: header.parentHash,
    parentStateRoot: header.parentStateRoot,
    timestamp: header.timestamp,
    feeRecipient: header.feeRecipient,
    burnPercent: header.burnPercent,
    producer: header.producer ?? null,
    producerSignature: header.producerSignature ?? null,
    timeoutMs: vm.replayTimeoutMs,
    checkChain: false,
    maxTransactions: null,
    maxTransactionsPerSender: null,
    maxBlockGas: null,
  });
  for (const { method, request } of body) block[method](request);
  for (const entry of rejected ?? []) block.recordRejected(entry);   // rejected txs: part of the block hash (rejectedRoot)

  const local = block.header();
  if (local.hash !== header.hash) {
    throw new Error(`block ${header.number} does not match the producer (ours ${local.hash} / received ${header.hash})`);
  }
  block.commit();
  return local;
}

/** fetch missing blocks and run them all → number of blocks added */
export async function syncOnce(vm, fetchBlocks, { limit = 50, producers = null } = {}) {
  const from = (vm.latestBlockNumber() ?? 0) + 1;
  const blocks = await fetchBlocks(from, limit);
  for (const item of blocks) applyBlock(vm, item, { producers });
  return blocks.length;
}

/** continuous sync — returns a function to stop it */
export function startSync(vm, { url, genesis, producers = producerSetOf(genesis), intervalMs = 3000, limit = 50, snapshot = false,
  onError, onBlock, onSnapshot } = {}) {
  if (genesis) vm.applyGenesis(genesis);           // stops immediately if the genesis doesn't match

  const fetchBlocks = async (from, count) => {
    const response = await fetch(`${url}/sync?from=${from}&limit=${count}`);
    if (!response.ok) throw new Error(`sync failed: ${response.status}`);
    return response.json();
  };

  let running = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      if (snapshot) {
        snapshot = false;   // only once, at startup
        const loaded = await syncFromSnapshot(vm, { url, producers });
        if (loaded) onSnapshot?.(loaded);
      }
      const added = await syncOnce(vm, fetchBlocks, { limit, producers });
      if (added) onBlock?.(vm.latestBlockNumber());
    } catch (error) {
      stopped = true;                               // data mismatch = stop, don't continue
      clearInterval(timer);
      onError?.(error);
    } finally {
      running = false;
    }
  }, intervalMs);

  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/** producer side: serve blocks to other nodes (for fastify) */
export function syncRoute(app) {
  app.get("/sync", async (request) => {
    const from = Math.max(1, Number(request.query.from) || 1);
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const latest = app.vm.latestBlockNumber() ?? 0;

    const blocks = [];
    for (let number = from; number <= Math.min(latest, from + limit - 1); number += 1) {
      const header = app.vm.getBlock(number);
      const body = app.vm.getBlockBody(number);
      if (header && body) blocks.push({ header, body, rejected: app.vm.getBlockRejected(number) });
    }
    return blocks;
  });

  app.get("/genesis", async () => ({ hash: app.vm.genesisHash() }));
}
