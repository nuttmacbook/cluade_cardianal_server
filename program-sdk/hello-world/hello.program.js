/**
 * โปรแกรม Hello World
 *
 * กติกา 3 ข้อ
 *   1. ทั้งไฟล์ต้องอยู่ใน scope เดียว คือฟังก์ชันครอบตัวเดียว (ชื่ออะไรก็ได้)
 *   2. return ท้ายฟังก์ชัน = รายชื่อฟังก์ชันที่ให้คนอื่นเรียกได้
 *   3. ห้าม import อะไรเข้ามา โปรแกรมต้องอยู่ได้ด้วยตัวเอง
 */
export default function program() {
  // รันครั้งเดียวตอนติดตั้ง — เรียกจากภายนอกไม่ได้
  function initialization(params) {
    writeDB("greeting", params.input.greeting ?? "สวัสดี");
    writeDB("owner", params.context.sender);
    writeDB("count", 0);
  }

  // ไม่อยู่ใน return = ใช้ภายในโปรแกรมเท่านั้น
  function bump() {
    const next = (readDB("count") ?? 0) + 1;
    writeDB("count", next);
    return next;
  }

  function greet(params) {
    const name = params.input.name ?? params.context.sender;
    const times = bump();
    writeDB(map("visits", params.context.sender), times);
    return `${readDB("greeting")} ${name} (ครั้งที่ ${times})`;
  }

  function setGreeting(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("เฉพาะเจ้าของเท่านั้น");
    writeDB("greeting", params.input.greeting);
    return readDB("greeting");
  }

  function info() {
    return {
      greeting: readDB("greeting"),
      owner: readDB("owner"),
      count: readDB("count") ?? 0,
      address: ThisAddress(),
      time: Date.now(),
    };
  }

  return { greet, setGreeting, info };
}
