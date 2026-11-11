# dev/ — ใช้ทดสอบเท่านั้น (ไม่ต้องมีบนเครื่องที่เปิดเชนจริง · ลบได้)

server.js และเชนจริงไม่ได้ import ไฟล์ในโฟลเดอร์นี้ · ถ้าลบทั้งโฟลเดอร์ เชนยังทำงานได้ แต่เทสต์บางตัวใน `test/` และคำสั่ง npm ด้านล่างจะใช้ไม่ได้

| ไฟล์ | ใช้ทำอะไร | npm |
|---|---|---|
| demo.js · demo-chain.js · demo-market.js · examples.js | ตัวอย่างการใช้ VM / เชน | `demo` `demo:chain` `demo:market` `examples` |
| seed.js | ใส่ข้อมูลตัวอย่างลงเชนช่วงพัฒนา | `seed` |
| scenario.js · scenario-programs.js · scenario-full.js · scenario-full-programs.js | ยิง tx จำลองหลายรูปแบบ (กระเป๋าจำนวนมาก · โปรแกรมซ้อนกัน) | `scenario` `scenario:full` |
| simulate-users.js | จำลองผู้ใช้ 200 กระเป๋า | `simulate` |
| load-test.js | วัดว่า block ปิดทันไหม | `load:test` |
| bench-gas.js · bench-vm.js | วัดเวลาจริงต่อหน่วยแก๊ส (ใช้ตอนตั้งตารางแก๊ส) | `bench:gas` |
| fuzz-sandbox.js | สุ่มโค้ดโปรแกรมทดสอบ sandbox | `fuzz` |
| evm-proxy.mjs | ดักดูคำขอ JSON-RPC ที่ Blockscout ส่งมา | – |

สคริปต์เหล่านี้ใช้ key ทดสอบ (Hardhat) และ `genesis.json` ของ repo · ห้ามชี้ไปที่เชนจริงด้วย key จริง
