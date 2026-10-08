/**
 * โปรแกรมอยู่ใน scope เดียวทั้งไฟล์ — เป็น JavaScript ที่ถูกต้อง เปิดใน editor ได้
 * ส่งผ่าน API ด้วย String(program) หรือก๊อปเนื้อฟังก์ชันไปวางเป็น string ก็ได้
 */
export default function program() {
  function initialization(params) {
    writeDB("owner", params.context.sender);
    writeDB("totalSupply", params.input.supply);
    writeDB(map("balances", params.context.sender), params.input.supply);
  }

  function balanceOf(account) {
    return readDB(map("balances", account)) || 0;
  }

  function transfer(params) {
    const from = params.context.sender;
    const balance = balanceOf(from);
    if (balance < params.input.amount) throw new Error("ยอดไม่พอ");

    writeDB(map("balances", from), balance - params.input.amount);
    writeDB(map("balances", params.input.to), balanceOf(params.input.to) + params.input.amount);
    return true;
  }

  function myBalance(params) {
    return balanceOf(params.context.sender);
  }

  return { transfer, myBalance };   // ฟังก์ชันที่ให้เรียกจากภายนอก
}
