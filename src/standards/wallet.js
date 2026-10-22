/**
 * ตรวจลายเซ็นของโปรแกรม (คล้าย ERC-1271) — ให้ "กระเป๋าที่เป็นโปรแกรม" รับรองลายเซ็นแทนตัวเองได้
 *
 * ข้อตกลง (ERC-1271)
 *   isValidSignature({ hash, signature }) → "0x1626ba7e" (ERC1271_MAGIC_VALUE) ถ้าลายเซ็นใช้ได้ · อย่างอื่น = ใช้ไม่ได้
 *     hash      = digest "0x…" 32 byte (เช่นผลของ eip712Digest / keccak256Bytes ในโปรแกรม)
 *     signature = string ที่โปรแกรมกระเป๋าตีความเอง (WALLET_PROGRAM ใช้ r||s||v 65 byte ของเจ้าของที่เซ็น digest นั้นตรง ๆ)
 *   ต้องอ่านอย่างเดียว: ผู้ตรวจเรียกด้วย runProgram(..., { readonly: true }) → เขียน / emit / โอนเงินไม่ได้
 *
 * โปรแกรมอื่นที่อยากรับลายเซ็นทั้งจากกระเป๋าคน (EOA) และกระเป๋าโปรแกรม ใส่ SIGNATURE_CHECKER ไว้ในโค้ด
 * แล้วเรียก isValidSignatureNow(signer, hash, signature) (แบบ SignatureChecker ของ OpenZeppelin)
 *   signer เป็นกระเป๋าคน   → ecrecoverDigest(hash, signature) === signer
 *   signer เป็นโปรแกรม      → runProgram(signer, "isValidSignature", { hash, signature }, { readonly: true }) === magic
 * (โปรแกรม import กันไม่ได้ จึงแจกเป็นซอร์สให้แทรกด้วย template string — TOKEN_PROGRAM ใช้แบบนี้ใน permit)
 *
 * ฝั่ง wallet: เจ้าของ WALLET_PROGRAM เซ็น digest ตรง ๆ — สำหรับ permit คือเซ็น typed data ของ permit ที่ owner = กระเป๋าโปรแกรม
 * ด้วย eth_signTypedData_v4 ได้เลย (signPermit / signWalletHash ใน src/crypto/program-signature.js ให้ลายเซ็นเดียวกัน)
 * ⚠️ แบบเดียวกับ ERC-1271 ทั่วไป: ถ้าคนเดียวเป็นเจ้าของหลายกระเป๋า ลายเซ็นของ digest เดียวกันใช้ได้กับทุกกระเป๋า
 *    — permit ปลอดภัยเพราะ owner อยู่ใน message (digest ต่างกันตามกระเป๋า)
 */

export const ERC1271_MAGIC_VALUE = "0x1626ba7e";
export const ERC1271_INVALID_VALUE = "0xffffffff";
/** ค่าตอบรับของ hook ตอนรับ NFT / multi-token (เหมือน ERC-721 / ERC-1155) */
export const ERC721_RECEIVED = "0x150b7a02";
export const ERC1155_RECEIVED = "0xf23a6e61";
export const ERC1155_BATCH_RECEIVED = "0xbc197c81";

/**
 * ซอร์สของ isValidSignatureNow(signer, hash, signature) → true / false (ไม่ throw)
 * hash = digest "0x…" 32 byte (eip712Digest / keccak256Bytes) · ข้อความ JSON แบบเดิมให้ hash เองก่อน (ไม่แนะนำ — MetaMask เซ็นไม่ได้)
 */
export const SIGNATURE_CHECKER = `function isValidSignatureNow(signer, hash, signature) {
    if (typeof signer !== "string" || typeof hash !== "string" || typeof signature !== "string") return false
    try {
      if (IsProgram(signer)) {
        const reply = runProgram(signer, "isValidSignature", { hash: hash, signature: signature }, { readonly: true })
        return reply === "${ERC1271_MAGIC_VALUE}"
      }
      return ecrecoverDigest(hash, signature) === signer.toLowerCase()
    } catch (e) {
      return false
    }
  }`;

export const WALLET_FUNCTIONS = ["isValidSignature"];

/**
 * กระเป๋าโปรแกรมตัวอย่าง: เจ้าของ 1 คน (private key) — input ตอน deploy: { owner? } (ไม่ส่ง = ผู้ deploy)
 *   owner()                                   → address เจ้าของ
 *   isValidSignature({ hash, signature })     → magic ถ้าเจ้าของเซ็น digest (32 byte) นั้นตรง ๆ (ecrecoverDigest)
 *   execute({ target, fn, input, value? })    → เจ้าของสั่งให้กระเป๋าเรียกโปรแกรมอื่น (sender = กระเป๋า) คืนผลของปลายทาง
 *   transferOwnership({ owner })              → เปลี่ยนเจ้าของ (emit OwnershipTransferred)
 *   onERC721Received / onERC1155Received / onERC1155BatchReceived → รับ NFT / multi-token แบบ safe transfer ได้
 */
export const WALLET_PROGRAM = `function program() {
  function initialization(params) {
    writeDB("owner", params.input.owner || params.context.sender)
  }

  function owner() { return readDB("owner") }

  function onlyOwner(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("only owner")
  }

  function isValidSignature(params) {
    const hash = params.input.hash
    const signature = params.input.signature
    if (typeof hash !== "string" || typeof signature !== "string") return "${ERC1271_INVALID_VALUE}"
    let signer = null
    try { signer = ecrecoverDigest(hash, signature) } catch (e) { signer = null }
    return signer !== null && signer === readDB("owner") ? "${ERC1271_MAGIC_VALUE}" : "${ERC1271_INVALID_VALUE}"
  }

  function execute(params) {
    onlyOwner(params)
    const value = params.input.value || 0n
    return runProgram(params.input.target, params.input.fn, params.input.input || {}, value > 0n ? { value: value } : {})
  }

  function transferOwnership(params) {
    onlyOwner(params)
    if (typeof params.input.owner !== "string" || params.input.owner.length !== 42) throw new Error("owner must be an address")
    emit("OwnershipTransferred", { previousOwner: readDB("owner"), newOwner: params.input.owner }, { indexed: ["previousOwner", "newOwner"] })
    writeDB("owner", params.input.owner)
    return true
  }

  function onERC721Received() { return "${ERC721_RECEIVED}" }
  function onERC1155Received() { return "${ERC1155_RECEIVED}" }
  function onERC1155BatchReceived() { return "${ERC1155_BATCH_RECEIVED}" }

  return { owner, isValidSignature, execute, transferOwnership, onERC721Received, onERC1155Received, onERC1155BatchReceived }
}`;
