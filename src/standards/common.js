/**
 * ชิ้นโค้ดที่โปรแกรมกลางใช้ร่วมกัน (ใส่ใน function program() { … } ด้วย template string)
 *   SET_METADATA  → setProgramMetadata(input): ตั้ง namespace / icon / url / contact / description จาก input ตอน initialization
 *   CHECK_ADDRESS → checkAddress(address, label): ตรวจว่าเป็น address 0x + 40 ตัว แล้วคืนเป็นตัวพิมพ์เล็ก
 */
/** ตั้ง metadata ของโปรแกรมจาก input ตอน initialization (ตั้งได้จากโค้ดเท่านั้น) */
export const SET_METADATA = `function setProgramMetadata(input) {
    if (typeof input.namespace === "string" && input.namespace !== "") setMetadata("namespace", input.namespace)
    if (typeof input.icon === "string" && input.icon !== "") setMetadata("icon", input.icon)
    if (typeof input.url === "string" && input.url !== "") setMetadata("url", input.url)
    if (typeof input.contact === "string" && input.contact !== "") setMetadata("contact", input.contact)
    if (typeof input.description === "string" && input.description !== "") setMetadata("description", input.description)
  }`;

export const CHECK_ADDRESS = `function checkAddress(address, label) {
    // 0x + 40 ตัวอักษร hex เท่านั้น (ตัวอื่นเป็น key ที่ไม่มีใครเซ็นได้ → ของที่ส่งไปหายถาวร)
    if (typeof address !== "string" || address.length !== 42 || !address.startsWith("0x")) throw new Error(label + " must be an address")
    const lower = address.toLowerCase()
    for (let i = 2; i < 42; i++) if (!"0123456789abcdef".includes(lower.charAt(i))) throw new Error(label + " must be an address")
    return lower
  }`;

