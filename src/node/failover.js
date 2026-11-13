/**
 * Safely move block production to a standby machine (when the primary fails · same key)
 *   standby: FOLLOW=<primary url> → keeps syncing, doesn't produce blocks or accept txs
 *   switch to producing: restart the standby with PRODUCER_KEY + FAILOVER_FROM=<old machine url> (FOLLOW unset)
 *     → prepareFailover asks the old machine before producing
 *       reachable + still producing (role "producer")  = refuses to start (prevents 2 producers on the same key → chain split)
 *       reachable + no longer producing (set to FOLLOW / key removed) = syncs the missing blocks first, then continues producing
 *       unreachable = may start + warns (the operator must be sure the old machine is really down, not just cut off from the network)
 * Never start the old machine as a producer again: bring it back as FOLLOW=<new machine url> instead
 */
import { syncOnce } from "./sync.js";

/** ask the old machine's status → { reachable, role, latest, error } (doesn't throw) */
export async function probeNode(url, { fetch = globalThis.fetch, timeoutMs = 3000 } = {}) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();   // /health answers 503 with a body when unhealthy — still counts as reachable
    return { reachable: true, role: body?.role ?? "producer", latest: body?.latest ?? null };   // no role = old server version (always produces)
  } catch (error) {
    return { reachable: false, role: null, latest: null, error: error.message };
  }
}

/**
 * Check before producing → { reachable, synced, warning } · throw = must not start
 *   producers = a list, or (block number) => list (checks synced blocks the same way as startSync)
 */
export async function prepareFailover(vm, { url, producers = null, fetch = globalThis.fetch, timeoutMs = 3000, limit = 50 } = {}) {
  const probe = await probeNode(url, { fetch, timeoutMs });
  if (!probe.reachable) {
    return { reachable: false, synced: 0,
      warning: `cannot reach the old machine ${url} (${probe.error}) — resuming production from block ${vm.latestBlockNumber() ?? 0} · make sure the old machine is really down and will never produce again` };
  }
  if (probe.role === "producer") {
    throw new Error(`the old machine ${url} is still producing blocks (block ${probe.latest}) — stop it or switch it to FOLLOW first, otherwise there will be 2 producers`);
  }
  const fetchBlocks = async (from, count) => {
    const response = await fetch(`${url}/sync?from=${from}&limit=${count}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`sync from the old machine failed: ${response.status}`);
    return response.json();
  };
  let synced = 0;
  for (let added = await syncOnce(vm, fetchBlocks, { limit, producers }); added > 0; added = await syncOnce(vm, fetchBlocks, { limit, producers })) {
    synced += added;
  }
  const latest = vm.latestBlockNumber() ?? 0;
  if (probe.latest !== null && latest < probe.latest) throw new Error(`incomplete sync from the old machine (have ${latest} / old machine ${probe.latest})`);
  return { reachable: true, synced };
}
