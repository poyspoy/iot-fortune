# Floor Plan Platform v2 — Project Hierarchy + Photo & Diagram View (ร่างออกแบบเพื่ออนุมัติ)

> สาขา `feature/platform-hierarchy-photo-design` (แยกจาก `feature/data-layer` `270f050`) · **เอกสารออกแบบเท่านั้น ยังไม่เขียนระบบจริง**
> **ฉบับแก้ครั้งที่ 2** ตามคำตัดสิน 20 ต.ค. 2569 (ข้อ 1–10) — สรุปการเปลี่ยนแปลงในข้อ 9
> Pilot Project = Fortune (FRT) · Demo `cloudflare-preview` `4ab02db` Freeze ไม่แตะ · ไม่ Merge `main` · ไม่แตะ `gh-pages`
> ต่อยอดจาก `design/floor-plan-platform` (ARCHITECTURE/MIGRATION/RELEASE-CHECKLIST — อ่านอย่างเดียว ไม่แก้สาขานั้น) และ Data Layer (`docs/data-layer/DATA-LAYER-PLAN.md` rev3)

| ไฟล์ | เนื้อหา |
|---|---|
| `README.md` | เอกสารนี้: Architecture, ลำดับโมดูล 1–5, เกณฑ์ผ่าน, ประเด็นที่ต้องตัดสิน |
| `db/hierarchy_photo.sql` | Database Schema (PostgreSQL 16) + Row-Level Security + trigger |
| `db/test_hierarchy_photo.sql` | ทดสอบ schema บน PostgreSQL 16 จริง — **ผ่าน 34/34** (แยกโครงการ, IDOR, Hotspot, เปลี่ยนรูป, Site เสริม, เปลี่ยน Device แล้วประวัติ/กราฟ/Alarm/การรับทราบคงอยู่, บทบาท 6 แบบ, AI/บัญชีระบบอนุมัติหรือ Commission ไม่ได้, Audit) |
| `api/hierarchy-photo.openapi.yaml` | API Contract (OpenAPI 3.1) — ผ่าน `openapi-spec-validator` (20 path, 18 schema) |
| `wireframes/wireframes.html` + `w1–w8.png` | Wireframe Desktop/มือถือ (ภาพร่างโครง ไม่ใช่ดีไซน์สุดท้าย) · W7 เปลี่ยน Device + สถานะตามบทบาท · W8 โครงการหลาย Site |
| `MODULE-0-PLAN.md` | แผนโมดูล 0 (UUID ภายใน + ฐาน `@v6`) — ประตูผ่าน Performance, Backup, Dry Run, Migration Report, Rollback, การทดสอบ |
| `TDR-001-database-and-auth.md` | Technical Decision Record: Supabase + Microsoft Entra ID เทียบ PostgreSQL ของเราเอง |

---

## 1. เป้าหมายและเกณฑ์รับมอบ

1. ลำดับชั้นเดียวของทุกโครงการ: **องค์กร → โครงการ → (ไซต์ — ระดับเสริม) → อาคาร → ชั้น → ห้อง/พื้นที่ → Asset → Monitoring Point → ค่าวัด (Metric)** · **Device** (เครื่องเซนเซอร์/เกตเวย์) ติดตั้งที่ Monitoring Point เป็น Entity แยก
2. ดูข้อมูลบน **รูปจริง/แผนภาพ** ได้ (รูปห้อง รูปเครื่องจักร แผนภาพระบบ) ด้วย Hotspot ที่แสดงค่า/สถานะสด
3. **จุดเดียวกัน = Stable ID เดียวกัน**: เปิดจาก Photo, 2D หรือ 3D แล้วได้ ข้อมูล กราฟ และ Alarm ชุดเดียวกัน (ทดสอบรับมอบ W5)
4. Fortune เป็นโครงการแรกบนโครงสร้างนี้ โดย **ภาพ สี ตำแหน่ง หมุด ถัง ปั๊ม ลิฟต์ ห้อง และ Flow เดิมไม่เปลี่ยน**
5. แยกโครงการระดับฐานข้อมูล (ไม่ใช่แค่ซ่อนเมนู) — ตามข้อกำหนดเดิม: Backend ตรวจ Project Membership ทุกคำขอ ไม่เชื่อ `projectId` จาก Frontend

## 2. ลำดับชั้นข้อมูล (Project Hierarchy)

```mermaid
erDiagram
  ORGANIZATION ||--o{ PROJECT : owns
  PROJECT ||--o{ PROJECT_MEMBER : "สิทธิ์"
  PROJECT ||--o{ SITE : has
  SITE ||--o{ BUILDING : has
  BUILDING ||--o{ FLOOR : has
  FLOOR ||--o{ SPACE : contains
  SPACE ||--o{ SPACE : "โซน > ห้อง"
  FLOOR ||--o{ ASSET : "located on"
  SPACE ||--o{ ASSET : "located in"
  PROJECT ||--o{ BUILDING : "ไม่มี Site ก็ได้"
  FLOOR ||--o{ MONITORING_POINT : "placed on"
  SPACE ||--o{ MONITORING_POINT : "placed in"
  ASSET ||--o{ BINDING : "บทบาท"
  MONITORING_POINT ||--o{ BINDING : ""
  MONITORING_POINT ||--o{ METRIC : "ค่าวัด"
  MONITORING_POINT ||--o{ DEVICE_INSTALLATION : "ประวัติเครื่อง"
  DEVICE ||--o{ DEVICE_INSTALLATION : ""
  METRIC ||--o{ TELEMETRY_SAMPLE : "ประวัติ/กราฟ"
  METRIC ||--o{ ALARM_EPISODE : "Alarm"
  ALARM_EPISODE ||--o{ ALARM_ACK : "การรับทราบ"
  VIEW ||--o{ PLACEMENT : "ตำแหน่งบนมุมมอง"
  MONITORING_POINT ||--o{ PLACEMENT : """"
  ASSET ||--o{ PLACEMENT : ""
  MEDIA_FILE ||--o{ VIEW : "เวอร์ชันไฟล์"
```

| ระดับ | ความหมาย | Fortune (Pilot) |
|---|---|---|
| Organization | เจ้าของข้อมูล/สัญญา · มี `namespace_id` สำหรับ UUID v5 ของข้อมูลเดิม | Fortune Demo Organization (UUID เดิมจาก Data Layer) |
| Project | หน่วยสิทธิ์ผู้ใช้ · ค่าตั้งต้น (เช่นสถานะเริ่มต้นของจุดใหม่) | FRT · `defaultPointInstallStatus = installed` |
| Site (เสริม) | ที่ตั้งทางกายภาพ · อาคารอยู่ใต้ Site หรือใต้โครงการโดยตรงก็ได้ · **โครงการที่มี Site ไม่เกิน 1 แห่ง UI ซ่อนระดับนี้อัตโนมัติ** (`showSiteLevel`) | ฟอร์จูนทาวน์ (1 แห่ง → ซ่อน) |
| Building | ระบบพิกัดอาคาร (Building CRS) | FORTUNE-TOWN (โพเดียม + ทาวเวอร์) |
| Floor | ลำดับ ระดับความสูง FloorFrame (affine) มุมมองผัง/โมเดลปัจจุบัน | G, 1–5, 11–32 |
| Space | โซน/ห้อง/ร้าน ซ้อนกันได้ · รูปทรงบนผัง | `G-SVC`, `3-MALL` + ห้องจาก `rooms-*.json` |
| Asset | อุปกรณ์/เครื่องจักร (ชนิดจาก Asset Catalog) | ปั๊ม, บ่อ, ถัง, AHU (`FRT-DEMO-*`) |
| **Monitoring Point** | จุดตรวจวัด: ตำแหน่งที่วัดซึ่งคนเห็นและมีประวัติ · **UUID ถาวร** | P-003, WL-001 |
| **Device** | เครื่องเซนเซอร์/เกตเวย์จริง · เปลี่ยนได้ (ประวัติการติดตั้งแยก) | GW-01 → GW-02 (ติดที่ WL-001) |
| Metric (ค่าวัด) | ช่องข้อมูลของ Monitoring Point (หน่วย ช่วง เกจ) | level, temp, rh, run, current |

**Monitoring Point, Device, Asset และ Metric เป็น 4 Entity แยกกัน (ไม่รวม)** — Monitoring Point คือ "ตำแหน่งที่วัด" (UUID ถาวร) · Device คือฮาร์ดแวร์ที่เปลี่ยนได้ · Asset คือสิ่งที่ถูกวัด (ปั๊ม บ่อ) ผูกกับจุดผ่าน Binding · Metric คือค่าวัดของจุด
- ค่าวัด Alarm และการรับทราบ อ้างด้วย `(projectId, pointId, metricId)` — **ไม่อ้าง Device** · Device ถูกเก็บเป็น "แหล่งที่มา" ของแต่ละค่าเท่านั้น
- เปลี่ยนเครื่อง = ปิดแถวติดตั้งเดิม + เปิดแถวใหม่ในธุรกรรมเดียว → กราฟต่อเนื่อง, Alarm เดิมยังอยู่และรับทราบได้ (ทดสอบข้อ 10–13, W7)
- ข้อมูลเข้าจับคู่ด้วย `(projectId, device.source_key, metric.source_key)` → หา Monitoring Point จาก Device ที่ติดอยู่ ณ เวลานั้น แล้วตรวจกติกา Lifecycle เดียวเหมือน Data Layer ปัจจุบัน

## 3. Photo & Diagram View

| เรื่อง | การออกแบบ |
|---|---|
| มุมมอง (View) | `plan` (ผังชั้น), `model` (3D), `photo` (รูปห้อง/เครื่องจักร), `diagram` (แผนภาพระบบ เช่น one-line, P&ID) · แต่ละ View ผูกกับชั้น/ห้อง/Asset และไฟล์ 1 เวอร์ชัน |
| Hotspot | = **Placement** ของ Point/Asset/Space บน View: หมุด / กรอบ / หลายเหลี่ยม ในพิกัด u,v (0–1) ของภาพ → ไม่ขึ้นกับความละเอียดหรือการย่อรูป · 3D ใช้ x,y,z ใน Building CRS |
| ค่าที่แสดง | ค่า/สถานะ/ชื่อ/ไอคอน · สี เส้นประ (ยังไม่ติดตั้ง) และ “!” (ต้องตรวจตำแหน่ง) **ใช้กติกาเดียวกับหมุด 2D/3D** (`telemetryDecision` + `pointStatus`) |
| แตะ Hotspot | เปิด **แผงรายละเอียดตัวเดียวกับ 2D/3D** (ค่า กราฟ แจ้งเตือน) + ปุ่ม “ดูจุดนี้ในมุมมองอื่น” จาก `/appearances` |
| เปลี่ยนรูป | อัปโหลดรูปใหม่ = ไฟล์ใหม่ (SHA-256 ใหม่) · Hotspot ไม่ถูกลบ → `needs_remapping (image-changed)` แสดงที่ตำแหน่งเดิม · หน้าตรวจแบบรูปเดิม/รูปใหม่ข้างกัน แล้ว “ยืนยัน” หรือ “ย้าย” (W4) |
| อนุมัติ | View แบบ draft → review_required → approved → published · อนุมัติ/เผยแพร่ได้เฉพาะคน (AI/บัญชีบริการถูก DB ปฏิเสธ — ทดสอบข้อ 8) |
| ภาพของ Fortune Pilot | **ใช้ภาพจำลอง หรือภาพที่ลบข้อมูลสำคัญแล้วเท่านั้น** (ป้าย "ภาพจำลอง" บนภาพ) · ห้ามภาพจริงของลูกค้าใน Public Preview จนกว่า Backend + Authentication + Project Isolation เสร็จและผ่าน Security Review |
| ความเป็นส่วนตัว | รูปอาจมีคน/ข้อมูลหน้างาน: bucket แบบ private เท่านั้น (ไม่ใช่ CDN สาธารณะเหมือนผัง), signed URL อายุสั้น, worker **เข้ารหัสใหม่และตัด EXIF/GPS** ก่อนใช้, แนวทางถ่ายรูป (ไม่ถ่ายหน้าคน/เอกสาร), ลบได้ตามคำขอ (เก็บ audit) |
| ความปลอดภัยไฟล์ | pre-signed PUT ≤ 10 นาที, ตรวจ SHA-256 + magic bytes + ขนาดภาพ (≤ 50 MB, ≤ 12,000 px ต่อด้าน), สแกนไวรัส, เข้ารหัสภาพใหม่ (ตัด polyglot/สคริปต์ฝัง), ไม่ยอมรับ SVG ที่ผู้ใช้อัปโหลด (กัน XSS) |
| ประสิทธิภาพ | ขนาดย่อ 480 / 1600 / 4096 px (WebP) · โหลดตามขนาดจอ · Hotspot วาดเป็น SVG ชั้นบนรูป ≤ 300 ต่อรูป · ค่าสดใช้ข้อมูลชุดเดียวกับ 2D/3D (ไม่ดึงแยกต่อ Hotspot) · ไม่ใช้ WebGL ในหน้ารูป → เครื่องสเปกต่ำใช้ได้ |
| มือถือ | ถ่างนิ้วซูม/ลาก · แตะ Hotspot เปิด Bottom Sheet · ปุ่ม ≥ 44 px · สลับ 2D/3D/รูป ด้วยแท็บเดียว (W3) |

## 4. Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser (Viewer เดิม + โมดูลใหม่)"]
    H[Hierarchy Tree / Drill-down]
    P[Photo & Diagram View]
    E[Hotspot Editor]
    D2[2D Plan] & D3[3D Scene]
    PD[Point Details<br/>ค่า · กราฟ · Alarm<br/>คอมโพเนนต์เดียว]
    SDS[SpatialDataService<br/>Data Layer กลาง]
  end
  subgraph Server
    API[API + Auth<br/>ตรวจ Membership ทุกคำขอ]
    W[Media Worker<br/>re-encode / EXIF / ขนาดย่อ / สแกน]
    ING[Ingest API<br/>Device Token ต่ออุปกรณ์+โครงการ]
    DB[(PostgreSQL 16<br/>FK คู่ + RLS)]
  end
  S3[(Private Object Storage)]
  H & P & E & D2 & D3 --> SDS
  P & D2 & D3 --> PD
  SDS -- REST --> API
  PD -- /points/id · /series · /alarms --> API
  E -- pre-signed PUT --> S3
  API --> DB
  W --> S3
  W -- internal --> API
  ING --> DB
```

- **Frontend**: เว็บเดิมตัวเดียว · โมดูลใหม่อ่านจาก `SpatialDataService` (ต่อยอด Data Layer ที่ผ่าน Regression แล้ว) — ไม่มีชื่อ/ตำแหน่ง/ไฟล์ของโครงการฝังในโค้ด
- **Backend**: ตามที่ออกแบบใน `design/floor-plan-platform` (Node + PostgreSQL + R2) โดยเปลี่ยนเป็น UUID + องค์กร + FK คู่ + RLS ตามไฟล์ schema ใหม่นี้
- **Project Isolation 3 ชั้น**: (1) API หา membership จาก session ไม่ใช่จาก body/path · (2) RLS ใน DB บังคับทุก query (ทดสอบ: ไม่มี session = ไม่เห็นอะไร, เดา UUID ข้ามโครงการไม่ได้) · (3) FK แบบคู่ `(project_id, id)` ทำให้ความสัมพันธ์ข้ามโครงการเป็นไปไม่ได้แม้โค้ดผิด · ตอบ 404 เหมือนกันทั้ง "ไม่มี" และ "ไม่มีสิทธิ์" (กันการเดา)
- **Device Token**: เก็บเฉพาะ hash · ผูกอุปกรณ์ + โครงการ · หมุนได้ · Service Key อยู่ฝั่ง Server เท่านั้น

## 5. Fortune เป็น Pilot — การย้ายโดยไม่เปลี่ยนภาพ

1. ใช้ UUID v5 เดิมของ Data Layer (namespace องค์กร + Project UUID + ชนิด + รหัสเดิม) → UUID ของ Point/Asset/Floor ใน DB ตรงกับที่ Preview ใช้อยู่ทุกตัว
2. Space: จาก `building.areas` (โซน) + `rooms-*.json` (ห้องจากโมเดล) เป็นลูกของโซน
3. View ผัง/โมเดล: จากไฟล์ใน `public/plans`, `public/models` + SHA-256 จาก asset manifest (มีอยู่แล้ว) · placement ของหมุดเดิม = `plan` u,v เดิม (ทดสอบ ≤ 1e-12 กับสูตรเดิม)
4. รูปห้อง/เครื่องจักร: **ภาพจำลอง** (สร้างใหม่ ไม่ใช่ภาพถ่ายลูกค้า) หรือภาพที่ลบข้อมูลสำคัญแล้ว (ป้าย ชื่อบริษัท ใบหน้า เอกสาร หน้าจอ) — ห้ามภาพจริงของลูกค้าใน Public Preview ก่อนโมดูล 5
5. เกณฑ์: ภาพ/พิกัด Fortune ก่อน–หลังเท่าเดิม (เครื่องมือเทียบฉากที่ใช้ในรอบ Data Layer), e2e ทั้ง 6 ชุด + Playground ผ่าน

## 6. ลำดับโมดูลที่เสนอ

| ลำดับ | โมดูล | ทำอะไร | ต้องมีก่อน | Checkpoint ย่อย (แต่ละข้อมี Preview แยก) |
|---|---|---|---|---|
| 0 | ปิดงาน Data Layer (**อนุมัติแล้ว · เริ่มได้หลังผ่านประตู Performance**) | เปลี่ยน ID ภายในเป็น UUID + ฐาน `@v6` + Audit ถาวร + แยก Device · Backup / Dry Run / Migration Report / Rollback (`MODULE-0-PLAN.md`) | **Performance `ff855b9` vs `7555525` บน GPU จริงผ่านเกณฑ์ 5.1** | 0-gate Performance · 0a UUID ภายใน · 0b Backup + Dry Run + Report · 0c ย้ายฐาน + Verify + Rollback · 0d ทดสอบประวัติ/กราฟ/Alarm/การรับทราบ/การตั้งค่าที่ผู้ใช้แก้ |
| 1 | **Project Hierarchy** | ต้นไม้/เจาะทีละระดับ, Space จากโซน+ห้อง, Device + ประวัติการติดตั้ง, สรุปสถานะต่อโหนด (W1, W6) | 0 | 1a โมเดลข้อมูลในเบราว์เซอร์ + Unit · 1b หน้า Hierarchy (Fortune อ่านอย่างเดียว) · 1c Device/ติดตั้ง |
| 2 | **Photo & Diagram View** | อัปโหลดรูป (ในเบราว์เซอร์ก่อน ยังไม่มี Backend), Hotspot, ค่าสดบนรูป, แก้ไข/ตรวจตำแหน่งหลังเปลี่ยนรูป (W2–W4) | 1 | 2a แสดงรูป + Hotspot อ่านอย่างเดียว · 2b Editor · 2c เปลี่ยนรูป → Needs Remapping |
| 3 | **Stable ID ข้ามมุมมอง** | `/appearances`, ปุ่ม “ดูในมุมมองอื่น”, ทดสอบรับมอบ W5 อัตโนมัติ (ค่า/กราฟ/Alarm เท่ากันทุกมุมมอง) | 1, 2 | 3a appearances · 3b e2e ข้ามมุมมอง |
| 4 | Sensor Placement & Installation Planning | Asset Catalog, ลากวาง Monitoring Point, Coverage (รัศมีครอบคลุม), Approval ตามบทบาท (เสนอ → อนุมัติ → ติดตั้ง Device → ส่งมอบ), BOM, PDF | 1–3 | 4a Catalog · 4b ลากวาง + Coverage · 4c Approval · 4d BOM/PDF |
| 5 | Backend/API, Authentication, Role, Project Isolation | ใช้ schema/API ชุดนี้จริง, Entra ID (ตาม TDR-001), RLS, Device Token, Audit, ทดสอบ IDOR/BOLA อัตโนมัติ, ย้ายข้อมูลจากเบราว์เซอร์ขึ้น Server | ตัดสิน TDR-001 | 5a Auth + Membership · 5b API อ่าน · 5c API เขียน + Audit · 5d Ingest + Device Token · 5e Security test |

หมายเหตุลำดับ: โมดูล 1–3 ทำในเบราว์เซอร์ก่อนได้ (เหมือน Data Layer) เพื่อให้ทดลองบน Preview เร็ว แต่ **ข้อมูลรูปจริงของลูกค้าไม่ควรใช้งานจริงก่อนโมดูล 5** (ไม่มีการยืนยันตัวตน/แยกโครงการฝั่ง Server) — Preview ของโมดูล 2 ใช้รูปตัวอย่าง/รูปที่อนุญาตเท่านั้น

## 7. เกณฑ์ผ่านทุก Checkpoint (ก่อนส่ง Preview และก่อนพิจารณารวม)

| หมวด | เกณฑ์ |
|---|---|
| Unit | ผ่านทั้งหมด + ทดสอบใหม่ของโมดูล |
| Regression | e2e ทั้ง 6 ชุด + Data Layer Playground ด้วยสคริปต์ฉบับเดียวกัน รันสลับกับ build ฐาน · ไม่มี FAIL ที่ไม่ได้จัดประเภท |
| ภาพ Fortune | โครงสร้างฉาก/ผัง 2D/ถัง/ปั๊ม/หมุดเท่าเดิม (ต่างเฉพาะสิ่งที่เคลื่อนตามเวลา) |
| Security | ทดสอบ schema (RLS/FK คู่/IDOR) ผ่านทุกข้อ · ไม่มีความลับใน Frontend/Git/Build · อัปโหลด: ชนิด/ขนาด/EXIF/SVG |
| Performance | GPU จริง (Intel Iris Xe) ตามเกณฑ์ 5.1: FPS ลดไม่เกิน 5%, p95 frame time ไม่เพิ่มเกิน 10%, Draw Calls เท่าเดิม · หน้ารูป: แสดงผลครั้งแรก ≤ 2.5 วิ บนมือถือเครือข่ายปกติ |
| Memory | JS Heap ไม่เพิ่มต่อเนื่องหลังใช้ 10 นาที (สลับรูป/ชั้น/มุมมอง 50 รอบ) |
| Desktop / Mobile | 1440, 1280, 820, 390, 360 px · ไม่ล้นแนวนอน · ปุ่ม ≥ 44 px บนมือถือ · Console/Network Error = 0 |

## 8. บทบาทและสิทธิ์

| บทบาท | ทำได้ | ทำไม่ได้ |
|---|---|---|
| Viewer | ดูลำดับชั้น ผัง 3D รูป ค่า กราฟ Alarm | แก้ไขใด ๆ · รับทราบ Alarm |
| Client Reviewer | Viewer + แสดงความเห็นต่อจุด/อุปกรณ์/รูป/Hotspot | แก้ข้อมูล · อนุมัติ |
| Technical Editor | สร้าง/แก้ลำดับชั้น Monitoring Point Asset Metric รูป Hotspot · ตั้ง ร่าง/เสนอ/รออนุมัติ · รับทราบ Alarm | อนุมัติ · ตั้ง "ติดตั้งแล้ว" · Commission |
| Installer | ลงทะเบียน/ติดตั้ง/เปลี่ยน Device · ตั้ง "ติดตั้งแล้ว" (ต้องมี Device ที่จุด) · รับทราบ Alarm | อนุมัติ · Commission |
| Client Approver | อนุมัติ/ไม่อนุมัติ (จาก "รออนุมัติ") · อนุมัติ/เผยแพร่รูปและแผนภาพ · รับทราบ Alarm | Commission |
| Commissioning Engineer | ส่งมอบใช้งาน (จาก "ติดตั้งแล้ว") · ปลดระวาง · รับทราบ Alarm | อนุมัติ |

- ผู้ใช้หนึ่งคนมีได้หลายบทบาท · การเพิ่ม/ลบสมาชิกโดย **ผู้ดูแลองค์กร** (`organization_admins`) ซึ่งไม่ได้สิทธิ์อนุมัติ/Commission โดยอัตโนมัติ
- **AI และบัญชีระบบ (`users.kind = service`) อนุมัติ เผยแพร่ หรือ Commission ไม่ได้ แม้ถูกกำหนดบทบาท** — บังคับใน DB trigger (ทดสอบข้อ 16, 21, 23) และ API
- ไม่มีบทบาทใดลบจุด/อุปกรณ์ได้ (ใช้เก็บถาวร/ปลดระวาง เพื่อรักษาประวัติ) · ทุกการเปลี่ยนสถานะติดตั้งมี Audit (ผู้ทำ, จาก → ถึง)
- การปิดปุ่มบนหน้าจอเป็นเพียงการช่วยผู้ใช้ — การตรวจจริงอยู่ที่ API และฐานข้อมูล

## 9. การเปลี่ยนแปลงในฉบับแก้ครั้งที่ 2 (คำตัดสิน 20 ต.ค. 2569)

| ข้อ | ฉบับที่ 1 | ฉบับนี้ |
|---|---|---|
| 1 Site | บังคับทุกอาคาร | ระดับเสริม (`buildings.site_id` ว่างได้) · ซ่อนใน UI เมื่อมี ≤ 1 แห่ง (`project_hierarchy_settings`, `showSiteLevel`) · W8 แสดงกรณีหลาย Site |
| 2 Entity | “Sensor = Point + Device” | Monitoring Point / Device / Asset / Metric แยกกัน · ค่าวัด Alarm การรับทราบ ผูกกับ Monitoring Point (ตาราง `telemetry_samples`, `alarm_episodes`, `alarm_acknowledgements`) · Device เป็นแหล่งที่มา |
| 3 คำเรียก | P-003 ถูกเรียก Sensor ใน Wireframe | P-003 = Monitoring Point · GW-02 = Device (ตาราง `points` → `monitoring_points`) |
| 4–5 โมดูล 0 | ข้อเสนอ | อนุมัติ + ประตู Performance + Backup/Dry Run/Report/Rollback/การทดสอบ (`MODULE-0-PLAN.md`) |
| 6 ภาพ Pilot | ภาพที่ทีมถ่าย | ภาพจำลอง/ลบข้อมูลสำคัญเท่านั้น จนกว่าโมดูล 5 เสร็จ (ป้าย "ภาพจำลอง" ใน W2/W3/W4) |
| 7 TDR | — | `TDR-001-database-and-auth.md` |
| 8 บทบาท | owner/admin/editor/installer/approver/viewer | Viewer · Client Reviewer · Technical Editor · Installer · Client Approver · Commissioning Engineer + trigger ตามบทบาท |

## 10. ประเด็นที่ยังต้องตัดสิน

1. TDR-001: Supabase + Entra ID (ข้อเสนอ) หรือ PostgreSQL ของเราเอง — ขึ้นกับข้อกำหนด PDPA/สัญญาลูกค้าเรื่องที่ตั้งข้อมูล
2. Tenant ของ Entra ID: ลูกค้าเข้าด้วย tenant ของตัวเอง (SAML ต่อ tenant) หรือเป็น Guest ใน tenant ของเรา
3. ภาพจำลองสำหรับ Pilot: สร้างภาพประกอบใหม่ (แนะนำ) หรือใช้ภาพจริงที่ลบข้อมูลสำคัญแล้ว — ใครเป็นผู้ตรวจว่าลบครบ
