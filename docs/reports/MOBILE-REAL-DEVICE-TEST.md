# วิธีวัด Performance บนมือถือจริง — build `feature/adaptive-quality`

ผลในไฟล์ `IoT-Fortune-Performance-GPU.xlsx` แผ่น *Mobile Viewport Simulation* เป็นการจำลองขนาดจอบน GPU ของ Desktop **ไม่ใช่มือถือจริง** เอกสารนี้คือวิธีวัดบนอุปกรณ์จริงเพื่อตัดสินเกณฑ์ Mobile ≥ 30 FPS

## 1. ที่ทดสอบ (Preview แยก ไม่แตะ Demo/`main`/`gh-pages`)

- URL: `https://feature-adaptive-quality.iot-fortune-preview.pages.dev/?db=mobile-real`
  - เป็น Branch Preview ของ Cloudflare Pages ที่สร้างอัตโนมัติจากสาขา `feature/adaptive-quality` แยกจาก `iot-fortune-preview.pages.dev` และ Demo บน GitHub Pages
  - **ไม่ใส่ `?dpr=`** — ใช้ความละเอียดตามที่แอปเลือกให้มือถือจริง (บันทึกค่า devicePixelRatio และ pixel ratio ของ renderer ไว้ในผล)
  - `db=mobile-real` แยกฐานข้อมูลในเครื่อง (IndexedDB) ไม่ปนกับการใช้งานปกติ
- ทางเลือกเครือข่ายภายใน (ไม่ต้องใช้อินเทอร์เน็ต): บนคอมพิวเตอร์ที่อยู่ Wi-Fi เดียวกับมือถือ `git checkout 194ccdd` (หรือ commit ของ Checkpoint) → `npx vite preview --host 0.0.0.0 --port 4173` → เปิด `http://<IP คอมพิวเตอร์>:4173/?db=mobile-real` บนมือถือ
  - ข้อควรระวัง: `EXT_disjoint_timer_query` และ Clipboard บางเบราว์เซอร์ใช้ได้เฉพาะ HTTPS — ถ้าใช้ HTTP ค่า GPU ms อาจเป็น "–" และต้องคัดลอกผลจากกล่องข้อความเอง

## 2. อุปกรณ์ขั้นต่ำ

| กลุ่ม | ตัวอย่าง | เบราว์เซอร์ |
|---|---|---|
| Android ระดับกลาง | อายุเครื่อง 2–4 ปี (เช่น Galaxy A5x) | Chrome |
| iPhone | iPhone 12 ขึ้นไป | Safari |
| (ถ้ามี) เครื่องรุ่นเก่า/ราคาประหยัด | — | Chrome |

ก่อนวัด: ชาร์จแบตเกิน 50% · ปิดโหมดประหยัดพลังงาน · ปิดแอปอื่น · ตั้งจอไม่ให้ดับอัตโนมัติ · ถือแนวตั้ง

## 3. ตัววัด (ไม่แก้โค้ดแอป และไม่อยู่ใน build)

ไฟล์ `scripts/perf/mobile-probe.js` วัดเรียงกัน 4 กรณี (warm-up 2 วิ วัด 10 วิ; กรณีหนักสุด warm-up 4 วิ):

1. ทึบ · ทั้งอาคาร
2. โปร่งใส + ลิฟต์
3. หนักสุด: โปร่งใส + คน + รถ + ลิฟต์ + สถานการณ์ทั้งสองเหตุการณ์
4. หลังจบ: ปิดทุก Layer · ทึบ (รอ 30 วิ แล้ววัด 5 วิ) — ตรวจการคืนหน่วยความจำ

บันทึก: FPS, เฟรมที่วาดจริง, frame time ค่ากลาง/p95, เฟรม > 50/100 ms, Long Tasks, GPU/CPU render time, Draw Calls, Triangles, Textures/Geometries/Programs, JS Heap (ถ้าเบราว์เซอร์รองรับ), Page Error, ข้อมูลอุปกรณ์ (UA, จอ, DPR, ขนาด Canvas, GPU)
ถ้าระหว่างวัดหน้าถูกซ่อนหรือเสียโฟกัส จะติดธง **✗ ไม่ใช้** ในกรณีนั้นอัตโนมัติ

### วิธี A — Bookmarklet (ไม่ต้องต่อสาย ใช้ได้ทั้ง Android และ iPhone)

1. สร้างข้อความ: `node scripts/perf/make-bookmarklet.mjs > bookmarklet.txt`
2. บนมือถือ: เพิ่ม Bookmark หน้าใดก็ได้ ตั้งชื่อ `iotperf` แล้วแก้ URL ของ Bookmark เป็นข้อความทั้งหมดใน `bookmarklet.txt` (ขึ้นต้นด้วย `javascript:`)
3. เปิด URL ทดสอบ รอโมเดลอาคารขึ้นครบ
4. Android Chrome: พิมพ์ `iotperf` ในช่อง URL แล้วแตะรายการ Bookmark · iPhone Safari: เปิดรายการ Bookmark แล้วแตะ `iotperf`
5. วางเครื่องนิ่ง ห้ามแตะจอประมาณ 75 วิ จนตารางผลขึ้น
6. แตะ **คัดลอกผล** แล้วส่งข้อความ JSON กลับมา พร้อมรุ่นเครื่อง

### วิธี B — Remote debugging (ละเอียดกว่า เห็น Console/Network ด้วย)

- Android: เปิด Developer options → USB debugging → ต่อสายกับคอมพิวเตอร์ → Chrome บนคอมพิวเตอร์ เปิด `chrome://inspect` → Inspect แท็บทดสอบ → วางเนื้อหา `mobile-probe.js` ใน Console
- iPhone: ต้องใช้ Mac — Settings › Safari › Advanced › Web Inspector → ต่อสาย → Safari บน Mac › Develop › เลือกเครื่อง → วางสคริปต์ใน Console
- วิธีนี้ตรวจ Console Error และ Network (404) บนมือถือจริงได้ในรอบเดียวกัน

## 4. เกณฑ์อ่านผล

| หมวด | เกณฑ์ |
|---|---|
| Performance Target (Mobile) | FPS เฉลี่ย ≥ 30 ในกรณีใช้งานปกติ (ทึบ, โปร่งใส + ลิฟต์) · กรณีหนักสุดรายงานแยก |
| Stability | หลังจบ Textures กลับค่าเดิม · ไม่มี Page Error |
| ใช้ผลได้ | ทุกกรณีต้องเป็น ✓ (ไม่เสียโฟกัส/ไม่ถูกซ่อน) ถ้า ✗ ให้วัดซ้ำ |

ผลจะถูกเพิ่มในไฟล์ Excel เป็นแผ่น `Mobile Real Device` แยกจาก *Mobile Viewport Simulation*

## 5. ข้อจำกัดที่ทราบ

- Safari (iPhone) ไม่มี `performance.memory` และ Long Task API → Heap/Long Tasks เป็น "–"
- GPU time ต้องการ `EXT_disjoint_timer_query_webgl2` ซึ่งมือถือหลายรุ่นไม่เปิดให้ใช้ → GPU ms อาจเป็น "–" (FPS และ frame time ยังใช้ตัดสินได้)
- ตัววัดเปิด–ปิด Layer ผ่านฟังก์ชันเดียวกับปุ่มในแอป ไม่แก้ค่าหรือข้อมูลใด ๆ ของแอป
