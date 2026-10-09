/**
 * โปรแกรมที่ใช้ใน scripts/scenario.js (แยกไฟล์เพื่อให้เทสต์ test/50-scenario-programs.test.js ตรวจได้โดยไม่ต้องเปิด server)
 *
 *   MULTISEND_PROGRAM  แจกเหรียญหลัก (native) หลายกระเป๋าใน tx เดียว: แนบ value = ผลรวม แล้ว transferNative ทีละรายการ
 *   CHAIN_PROGRAM      โปรแกรมต่อกันเป็นทอด ๆ: step() เรียก step() ของโปรแกรมถัดไปตาม path (deploy 6 ตัว → A→B→C→D→E→F)
 *                      บางตัวแวะเรียก balanceOf ของ token ข้างทาง (probe) · บางตัว catch ความผิดพลาดของชั้นล่าง (catch)
 *   ROUTER_PROGRAM     ส่งต่อ token + เหรียญหลักหลายทอด: ชั้นแรกดึง token จากผู้เรียก (transferFrom) แล้วทุกชั้นหัก 1%
 *                      โอน token ต่อให้ชั้นถัดไป พร้อมแนบ value ต่อไปด้วย ชั้นสุดท้ายโอนทั้งคู่ให้ผู้รับ
 *
 * โปรแกรมห้ามใช้ obj[key] (autoreview) จึงแยกหัว / หางของ path ด้วย for…of
 */

export const MULTISEND_PROGRAM = `function program() {
  function initialization(params) {
    setMetadata("namespace", params.input.name)
    setMetadata("description", "Sends native coins to many wallets in one transaction")
  }
  function multiSend(params) {
    let total = 0n
    let count = 0n
    for (const item of params.input.recipients) {
      if (item.amount <= 0n) throw new Error("amount must be greater than 0")
      total = total + item.amount
    }
    if (total !== params.value) throw new Error("attached value must equal the total")
    for (const item of params.input.recipients) {
      transferNative(item.to, item.amount)
      count = count + 1n
    }
    writeDB("sent", (readDB("sent") || 0n) + total)
    writeDB("count", (readDB("count") || 0n) + count)
    emit("MultiSend", { from: params.context.sender, count: count, total: total })
    return { count: count, total: total }
  }
  return { multiSend }
}`;

export const CHAIN_PROGRAM = `function program() {
  function initialization(params) {
    writeDB("label", params.input.label)
    writeDB("probe", params.input.probe || "")
    writeDB("catch", params.input.catch || false)
    setMetadata("namespace", params.input.name)
    setMetadata("description", "Call chain node " + params.input.label + ": calls the next program in the path")
  }
  function step(params) {
    const label = readDB("label")
    let next = ""
    const rest = []
    for (const hop of params.input.path) {
      if (next === "") next = hop
      else rest.push(hop)
    }
    if (params.input.failAt === label) throw new Error("requested failure at " + label)
    const count = (readDB("count") || 0n) + 1n
    writeDB("count", count)
    const probe = readDB("probe")
    const balance = probe ? runProgram(probe, "balanceOf", { who: params.context.origin }) : null
    emit("Step", { label: label, depth: params.input.depth, origin: params.context.origin })
    let below = null
    if (next !== "") {
      const input = { path: rest, depth: params.input.depth + 1n, failAt: params.input.failAt || "", note: params.input.note || "" }
      if (readDB("catch")) {
        try { below = runProgram(next, "step", input) } catch (error) { below = { caught: error.message } }
      } else {
        below = runProgram(next, "step", input)
      }
    }
    return { label: label, depth: params.input.depth, count: count, balance: balance, next: below }
  }
  function stats() { return { label: readDB("label"), count: readDB("count") || 0n } }
  return { step, stats }
}`;

export const ROUTER_PROGRAM = `function program() {
  function initialization(params) {
    setMetadata("namespace", params.input.name)
    setMetadata("description", "Multi-hop router: forwards tokens and native coins to the next router, keeping 1% per hop")
  }
  function forward(params) {
    const token = params.input.token
    const me = ThisAddress()
    if (params.input.pull) runProgram(token, "transferFrom", { from: params.context.sender, to: me, amount: params.input.amount })
    let next = ""
    const rest = []
    for (const hop of params.input.path) {
      if (next === "") next = hop
      else rest.push(hop)
    }
    const fee = params.input.amount / 100n
    const out = params.input.amount - fee
    writeDB("kept", (readDB("kept") || 0n) + fee)
    writeDB("hops", (readDB("hops") || 0n) + 1n)
    emit("Hop", { from: params.context.sender, to: next || params.input.to, amount: out, value: params.value })
    if (next !== "") {
      runProgram(token, "transfer", { to: next, amount: out })
      return runProgram(next, "forward", { token: token, path: rest, to: params.input.to, amount: out, pull: false }, { value: params.value })
    }
    runProgram(token, "transfer", { to: params.input.to, amount: out })
    if (params.value > 0n) transferNative(params.input.to, params.value)
    return { delivered: out, value: params.value, to: params.input.to }
  }
  return { forward }
}`;
