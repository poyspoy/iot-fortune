# รายงาน Performance บน GPU จริง — build `194ccdd` (Adaptive Quality step 1: ลิฟต์ออกจากฉาก 3D)

ตัวเลขทั้งหมดอยู่ใน `IoT-Fortune-Performance-GPU.xlsx` (แผ่น `สรุปสถานะ` เป็นหน้าแรก)
อุปกรณ์: Intel Iris Xe (ANGLE D3D11) · เบราว์เซอร์ในแอป Claude (Chromium 152) · pixel ratio 1.25 · Cloudflare Branch Preview

## สรุปแยกหมวด — ห้ามอ่านรวมว่า "FPS ผ่านทั้งหมด"

| หมวด | สถานะ | ผล |
|---|---|---|
| **Stability Pass** | ✅ ผ่าน | ใช้งานต่อเนื่อง 10 นาที เปิด–ปิด Layer ซ้ำ: Texture/Geometry/Program กลับค่าเดิมทุกรอบ · JS Heap แกว่ง 25–56 MB ไม่ไต่ขึ้น · ลิฟต์ 1 / คน 0 / รถ 0 / Canvas 1 / Listener 1 · Page Error 0 |
| **Regression Pass** | ✅ ผ่าน | เทียบ `ddc56f0`: ทึบ +0.8 · โปร่งใส+ลิฟต์ +0.1 · หนักสุด +3.6 FPS |
| **Performance Target Fail** | ❌ ไม่ผ่าน | Desktop หนักสุด **34.4 FPS** < 45 · โปร่งใส+ลิฟต์ 44.9 (ต่ำกว่าเล็กน้อย) · ทึบ 52.4 ถึงเป้า — ปัญหาเดิมจาก Layer คน/รถ (`ddc56f0` ได้ 30.8) |
| Mobile Real Device Test | ⏸ **Deferred by owner** | ยังไม่ได้ทดสอบ ไม่ถือว่าผ่านหรือไม่ผ่าน และต้องทดสอบก่อน Production Release · คู่มือ `MOBILE-REAL-DEVICE-TEST.md` และ Bookmarklet `scripts/perf/` เก็บไว้ใช้ภายหลัง · มีเพียง Mobile Viewport Simulation (ไม่ใช่มือถือจริง) |
| Console Error = 0 | ✅ | 404 ในแท็บทดสอบเดิมไม่เกิดซ้ำในแท็บใหม่ → **Stale/External Console Entry** |

## งานที่บันทึกไว้ทำภายหลัง (ไม่แก้ใน Checkpoint ลิฟต์)

- FPS กรณีหนักสุด (โปร่งใส + คน + รถ) → งานของ Adaptive Quality / Mobility Optimization
- Mobile Real Device Test: Deferred by owner (18 ต.ค. 2569) — ต้องทดสอบบนมือถือจริงก่อน Production Release
- เกณฑ์เดินหน้าพัฒนารอบนี้: ผล Desktop GPU จริง (ตัดสินโดยเจ้าของงาน)

## ตรวจ Console 404 ซ้ำ

- เปิด Browser tab ใหม่ (Console/Network ว่าง) → โหลด build เดิม → ใช้งานครบ: คน, รถ, โปร่งใส, โครงอาคาร, ชั้นเดี่ยว 3 และ 11, ทั้งอาคาร, ลิฟต์ไปชั้น 5, สถานการณ์ทั้งสองเหตุการณ์, 2D, 3D, รีเซ็ต → โหลดซ้ำ
- Console 0 รายการทั้งสองครั้ง · Network 20 คำขอ ทุกคำขอ 200 · Resource Timing ไม่มี 4xx/5xx · resource error / page error / promise rejection = 0
- 404 เดิมพบเฉพาะในแท็บที่เคยเปิด URL อื่นมาก่อนหลายครั้ง และไม่มีใน network log ของแท็บนั้น → จัดเป็น Stale/External Console Entry (Request URL / Initiator / Resource Type: ไม่มี เพราะไม่เกิดซ้ำ)
