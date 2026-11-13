/**
 * multicall — call several programs / functions in a single tx (or query)
 *
 *   aggregate({ calls: [{ target, fn, input? }, …], readonly? })   → [result of each call] in order
 *       runs calls one by one in order · any call throws → everything fails (all-or-nothing: writes of every call are reverted)
 *   tryAggregate({ calls, readonly?, requireSuccess? })            → [{ success: true, result } | { success: false, error, code }]
 *       a failed call reverts only itself (runProgram savepoint), the rest continue · requireSuccess: true = one failure fails all
 *   readonly: true → every call is runProgram(..., { readonly: true }) (STATICCALL): targets cannot modify state at any depth
 *       use with vm.query / POST /query to read many values in one round trip, guaranteeing no call writes anything
 *   getBlockNumber() / getChainId() / getNativeBalance({ who }) → helpers to read chain values in the same aggregate
 *
 * Caveat (same as Multicall3): targets see sender = the multicall's address, not the tx sender
 *   → use it to batch "reads" or calls that don't depend on the caller · to transfer your own coins to many recipients use the token's multiTransfer
 *   or the program wallet's execute (src/standards/wallet.js) instead
 */

export const MULTICALL_FUNCTIONS = ["aggregate", "tryAggregate"];

export const MULTICALL_PROGRAM = `function program() {
  // program name / description (optional), e.g. { namespace: "multicall" } when deploying the system program set (src/standards/system.js)
  function initialization(params) {
    if (typeof params.input.namespace === "string" && params.input.namespace !== "") setMetadata("namespace", params.input.namespace)
    if (typeof params.input.icon === "string" && params.input.icon !== "") setMetadata("icon", params.input.icon)
    if (typeof params.input.url === "string" && params.input.url !== "") setMetadata("url", params.input.url)
    if (typeof params.input.contact === "string" && params.input.contact !== "") setMetadata("contact", params.input.contact)
    if (typeof params.input.description === "string" && params.input.description !== "") setMetadata("description", params.input.description)
  }

  function callsOf(params) {
    const calls = params.input.calls
    if (!Array.isArray(calls)) throw new Error("calls must be an array of { target, fn, input }")
    for (const call of calls) {
      if (call === null || typeof call !== "object" || typeof call.target !== "string" || typeof call.fn !== "string") {
        throw new Error("each call needs target and fn")
      }
    }
    return calls
  }

  function callOne(call, readonly) {
    return runProgram(call.target, call.fn, call.input || {}, { readonly: readonly })
  }

  function aggregate(params) {
    const readonly = params.input.readonly === true
    const results = []
    for (const call of callsOf(params)) results.push(callOne(call, readonly))
    return results
  }

  function tryAggregate(params) {
    const readonly = params.input.readonly === true
    const results = []
    for (const call of callsOf(params)) {
      try {
        results.push({ success: true, result: callOne(call, readonly) })
      } catch (e) {
        if (params.input.requireSuccess === true) throw e
        results.push({ success: false, error: String(e.message), code: e.code || null })
      }
    }
    return results
  }

  function getBlockNumber() { return BlockNumber() }
  function getChainId() { return ChainId() }
  function getNativeBalance(params) { return BalanceOf(params.input.who) }

  return { aggregate, tryAggregate, getBlockNumber, getChainId, getNativeBalance }
}`;
