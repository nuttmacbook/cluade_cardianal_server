# explorerscan — หน้า explorer ของเชน

ไฟล์ HTML / CSS / JS ธรรมดา **ไม่ต้อง build ไม่มี dependency** · copy โฟลเดอร์นี้ไปแต่งเป็นหน้าตาของเชนตัวเองได้เลย

```
explorerscan/
├── index.html            🎨 โครงหน้า: ชื่อเว็บ, โลโก้, เมนูบน, เมนูข้าง, ลำดับโหลดไฟล์
├── config.js             🎨 ตั้งค่า: ที่อยู่ node, สีจุดในเมนูข้าง, ความถี่ถามสถานะ, รายชื่อโปรแกรมกลาง
├── theme/                🎨 ความสวยงาม
│   ├── colors.css            สีทั้งหมดของธีม (ตัวแปร --bg --card --accent …) — เปลี่ยนธีมแก้ไฟล์นี้ก่อน
│   └── style.css             พื้นหลัง, แถบบน, เมนูข้าง, ตาราง, การ์ด, ฟอร์ม, มือถือ (@media)
├── ui/                   🎨 การแสดงผล (HTML ของแต่ละหน้า)
│   ├── components.js         ชิ้นส่วนที่ใช้ทุกหน้า: panel, ตาราง, ลิงก์ address / tx, tag, กล่อง JSON, ตัวแบ่งหน้า, แท็บ
│   ├── sidebar.js            เมนูข้าง: ไฮไลต์หน้าปัจจุบัน + โปรแกรมล่าสุด
│   ├── pages/                หน้าเต็มหนึ่งหน้า ต่อหนึ่ง URL
│   │   ├── home.js               #               ภาพรวม + block ล่าสุด
│   │   ├── programs.js           #programs       โปรแกรมที่อนุมัติแล้ว / รออนุมัติ
│   │   ├── block.js              #block/<เลข>
│   │   ├── tx.js                 #tx/<hash>      รวมแผนภาพการเรียกโปรแกรม
│   │   ├── address.js            #address/<addr> ข้อมูลหลัก + เลือกแท็บ
│   │   ├── deploy.js             #deploy         ส่งโปรแกรมใหม่
│   │   └── system.js             #system         โปรแกรมกลาง (Multicall, WCARD, Factory …) จาก config.js
│   └── tabs/                 แท็บในหน้า address / โปรแกรม
│       ├── interact.js           เรียกฟังก์ชัน (ฟอร์ม / JSON) + ผลลัพธ์
│       ├── storage.js            ข้อมูลที่โปรแกรมเก็บ
│       ├── permit.js             Permit ของโทเคน (ERC-2612)
│       ├── upgrade.js            อัปเกรดโปรแกรม / สิทธิ์อัปเกรด
│       └── metadata.js           แก้ชื่อ / ไอคอน / ลิงก์ของ address ตัวเอง
└── core/                 ⚙️ ระบบ — ทุกโปรเจกต์ต้องมี ไม่ต้องแก้
    ├── chain.js              อ่านข้อมูลจากเชน: api() + การแบ่งหน้า (เลขหน้า / cursor)
    ├── wallet.js             ต่อ MetaMask, Add network, เซ็น tx EIP-712, ส่ง /sendtx
    ├── actions.js            เซ็น + ส่ง + รอผลจาก block แล้วรายงานสถานะ
    ├── interact.js           อ่านโค้ดโปรแกรมเพื่อเดาช่องกรอกของแต่ละฟังก์ชัน
    ├── format.js             แปลงค่า: เลข BigInt, หน่วยเหรียญ, เวลา, escape HTML
    ├── router.js             เปลี่ยนหน้าตาม #hash + ช่องค้นหา
    └── start.js              เริ่มทำงาน + ถามสถานะเชนเป็นระยะ (โหลดเป็นไฟล์สุดท้าย)
```

🎨 = แก้ได้ตามใจ · ⚙️ = ระบบ (แก้ผิด = อ่านข้อมูลผิด หรือลายเซ็นใช้ไม่ได้) · บรรทัดแรกของทุกไฟล์บอกว่าเป็นส่วนไหน

## อยากเปลี่ยนอะไร แก้ที่ไหน

| อยากเปลี่ยน | ไฟล์ |
|---|---|
| ธีมสี (พื้น, การ์ด, ปุ่ม, ลิงก์) | `theme/colors.css` |
| พื้นหลัง / กริด / ขนาด / ระยะห่าง / มือถือ | `theme/style.css` |
| ชื่อเว็บ, โลโก้, ปุ่มบนสุด, เมนูข้าง | `index.html` |
| ต่อกับ node ของเชนตัวเอง | `config.js` → `api: "https://chain.example.com"` |
| คอลัมน์ / ข้อความในหน้า block, tx, address … | `ui/pages/<หน้า>.js` |
| หน้าตาตาราง, ลิงก์ address, tag สถานะ ทุกหน้าพร้อมกัน | `ui/components.js` |
| รูปแบบวันที่ / ตัวเลข | `core/format.js` (`when` `ago` `num`) |
| เพิ่มหน้าใหม่ | ไฟล์ใหม่ใน `ui/pages/` + เพิ่ม `<script>` ใน `index.html` + เพิ่มบรรทัดใน `render()` ของ `core/router.js` |

## ใช้ยังไง

**กับ server ของ repo นี้** (ค่าเริ่ม): `node server.js` แล้วเปิด `http://localhost:3000/` · แก้ไฟล์แล้วกด refresh เห็นผลทันที ไม่ต้อง restart

**fork ไปแต่งเอง** มี 2 แบบ
1. copy โฟลเดอร์ไปที่อื่น แล้วเปิด server ด้วย `EXPLORER_DIR=/path/to/my-explorer node server.js`
2. โฮสต์แยกเป็นเว็บ static (nginx, GitHub Pages, Netlify ฯลฯ): ตั้ง `api` ใน `config.js` เป็นที่อยู่ node · server ตอบ CORS ให้แล้ว

## กติกาของระบบ (อย่าทำพัง)

- ไฟล์ทั้งหมดเป็น `<script>` ธรรมดา ใช้ตัวแปรร่วมกัน (ไม่ใช่ module) · **ลำดับใน `index.html` สำคัญ**: `config.js` → `core/` → `ui/` → `core/router.js` → `core/start.js`
- ปุ่มใน HTML เรียกฟังก์ชันด้วย `onclick="ชื่อฟังก์ชัน(...)"` เปลี่ยนชื่อฟังก์ชันต้องเปลี่ยนทุกที่ที่เรียก
- `canonical()` / `signingInput()` ใน `core/wallet.js` ต้องตรงกับ VM ทุกไบต์ (เทสต์ `46-explorer-canonical` คุม)
- ชื่อ class ใน `ui/` ผูกกับ `theme/style.css` เปลี่ยนชื่อ class ต้องแก้ทั้งสองฝั่ง
- เทสต์หน้าเว็บ: `npm run test:e2e` (`test/e2e/explorer.e2e.js`) · ไฟล์ที่ server เสิร์ฟ: `test/104-explorerscan-static.test.js`
