/**
 * multicall — เรียกหลายโปรแกรม / หลายฟังก์ชันใน tx (หรือ query) เดียว
 *
 *   aggregate({ calls: [{ target, fn, input? }, …], readonly? })   → [ผลของแต่ละ call] ตามลำดับ
 *       ทำทีละ call ตามลำดับ · call ไหน throw → ทั้งหมดล้ม (all-or-nothing: การเขียนของทุก call ถูกย้อน)
 *   tryAggregate({ calls, readonly?, requireSuccess? })            → [{ success: true, result } | { success: false, error, code }]
 *       call ที่ล้มถูกย้อนเฉพาะตัวมันเอง (savepoint ของ runProgram) ที่เหลือทำต่อ · requireSuccess: true = ล้มตัวเดียวล้มหมด
 *   readonly: true → ทุก call เป็น runProgram(..., { readonly: true }) (STATICCALL): ปลายทางแก้ state ไม่ได้ทุกชั้น
 *       ใช้กับ vm.query / POST /query เพื่ออ่านหลายค่าในรอบเดียว และรับประกันว่าไม่มี call ไหนเขียนอะไร
 *   getBlockNumber() / getChainId() / getNativeBalance({ who }) → ตัวช่วยอ่านค่าของเชนใน aggregate เดียวกัน
 *
 * ข้อควรรู้ (เหมือน Multicall3): ปลายทางเห็น sender = address ของ multicall ไม่ใช่ผู้ส่ง tx
 *   → ใช้รวม "อ่าน" หรือรวม call ที่ไม่ขึ้นกับว่าใครเรียก · โอนเหรียญของตัวเองหลายรายการให้ใช้ multiTransfer ของ token
 *   หรือ execute ของกระเป๋าโปรแกรม (src/standards/wallet.js) แทน
 */

export const MULTICALL_FUNCTIONS = ["aggregate", "tryAggregate"];

export const MULTICALL_PROGRAM = `function program() {
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
