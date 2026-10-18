# Data Layer กลาง — Architecture · รายการไฟล์ · แผน Migration (ส่งตรวจก่อนแก้โค้ด)

สาขา `feature/data-layer` (ฐาน `7555525`) · ขอบเขต: `Point`, `Asset`, `Tank`, `Pump` · **ยังไม่แก้โค้ดแอปจนกว่าเอกสารนี้ได้รับอนุมัติ**
ไม่รวม: Adaptive Governor, Mobility Optimization, NEXZA Theme, Backend/DB จริง (ออกแบบไว้ใน `design/floor-plan-platform`)

## 1. ปัญหาของโค้ดปัจจุบัน

| ปัญหา | ที่อยู่ | ผล |
|---|---|---|
| ปั๊มผูกรหัสจุดในโค้ด `'P-003'` | `scene3d.js #buildEquipment`, `app.js #updateSpatial` | โครงการใหม่ต้องแก้โค้ด |
| ถัง/บ่อสร้างจาก `metric.gauge` ในฉาก 3D และคำนวณตำแหน่งเอง (+0.42 / −0.6) | `scene3d.js` | 2D (แผงเกจ) กับ 3D คำนวณคนละที่ |
| Point กับอุปกรณ์ปนกัน (`equipmentId` เป็นข้อความ ไม่มี Entity Asset) | `defaultConfig.js` | Point แยกจาก Asset ไม่ได้ |
| ไม่มีสถานะการติดตั้ง — ทุกจุด `active` ส่งค่าเข้า KPI/Alarm | `kpi.js`, `normalize.js`, `demoAdapter.js` | จุดที่ยังไม่ติดตั้งจะมีข้อมูลปลอมได้ |
| แปลงพิกัด 2D↔3D มีหลายสูตรกระจาย (`planTo3D`, `threeDToPlan`, offset ในฉาก) | `geometry.js`, `scene3d.js`, `app.js` | ไม่มีระบบพิกัดกลาง |
| ไม่มี `Needs Remapping` | — | นำเข้าโมเดลใหม่แล้วจุดหายเงียบได้ |

## 2. Architecture

```
 config (IndexedDB / ค่าเริ่มต้น / API ในอนาคต)
        │  migrateConfig v5 → v6 (ครั้งเดียว ไม่เปลี่ยนค่าเดิม)
        ▼
 ┌──────────────────────── src/data/ (ไม่พึ่ง DOM / WebGL) ────────────────────────┐
 │ coords.js        Building CRS + FloorFrame (affine2d) : plan(u,v) ⇄ building(x,y,z) │
 │ lifecycle.js     installation status · mappingStatus · กติกาว่าอะไรส่งค่าได้          │
 │ entities.js      normalize/validate Point, Asset (pump, tank, pit, ahu, …)         │
 │ spatialData.js   SpatialDataService — แหล่งความจริงเดียวของตำแหน่งและความสัมพันธ์     │
 └──────────────────────────────────────────────────────────────────────────────┘
        │ อ่านอย่างเดียว (snapshot ที่ไม่เปลี่ยน + onChange)
   ┌────┴───────────────┬──────────────────────┬─────────────────────┐
   ▼                    ▼                      ▼                     ▼
 scene3d.js         plan2d.js / app.js      waterPanel.js        engine / kpi / normalize
 (หมุด ถัง ปั๊ม)       (หมุด ผัง 2D รายการ)     (เกจ 2D)              (เฉพาะจุดที่ติดตั้งแล้ว)
```

### 2.1 ระบบพิกัดกลาง (Building CRS)

- แกน: `x` ขวา, `z` ใต้ (ตามผัง), `y` ขึ้น · หน่วย = หน่วยโมเดลของแอป (Fortune: 1 หน่วย ≈ ไม่ใช่เมตรสำรวจ — เป็นการจับคู่เชิงแผนภาพเหมือนเดิม)
- ทุกชั้นมี `FloorFrame`: `planTransform = affine2d [a, b, c, d, e, f]` → `x = a·u + b·v + c`, `z = d·u + e·v + f` และ `elevation`
- Fortune สร้าง FloorFrame จาก `floor.model` เดิม: `a = width, b = 0, c = cx − width/2, d = 0, e = depth, f = cz − depth/2` — **ตัวเลขเท่ากับ `planTo3D` เดิมทุกตัว** (ทดสอบความต่าง ≤ 1e-12)
- API: `planToBuilding(floorId, {u,v}) → {x,z}`, `buildingToPlan(floorId, {x,z}) → {u,v}`, `entityPosition(entity, { mode, offset })` — แทน `planTo3D/threeDToPlan/pointPosition/markerPosition` (ไฟล์ `geometry.js` เดิมเรียกผ่าน coords.js เพื่อให้โค้ดอื่นไม่ต้องเปลี่ยนพร้อมกัน)
- โมเดลรายละเอียด Blender (`detailTransform`) ไม่เปลี่ยน — ยังอิงสูตรเดิม

### 2.2 Entity และความสัมพันธ์

| Entity | ฟิลด์หลัก | หมายเหตุ |
|---|---|---|
| **Point** | `id` (Stable ID), `sourceKey`, `floorId`, `areaId`, `assetId \| null`, `position {plan:{u,v}, xyz \| null, mappingStatus, anchor}`, `installation {status, …}`, `status` (active/archived — การติดตามเดิม), `metrics[]` | จุดวัด/ส่งข้อมูล |
| **Asset** | `id`, `type` (`pump`, `tank`, `pit`, `ahu`, `panel`, …), `name`, `floorId`, `areaId`, `position` (เหมือน Point), `installation`, `visual` (รูปแบบภาพ + ระยะเลื่อนจากตำแหน่ง), `simulated` | อุปกรณ์ที่มีภาพในโมเดล |
| **Tank / Pit** | Asset `type: 'tank' \| 'pit'` + `levelPoint` = Point ที่มีค่าวัด `gauge` | ภาพถัง 3D และเกจ 2D อ่านจาก Asset เดียวกัน |
| **Pump** | Asset `type: 'pump'` + `runPoint` = Point ที่มีค่าวัด `run` | ใบพัดหมุนเฉพาะค่า `run` สดใหม่ (เหมือนเดิม) — ไม่ผูก `'P-003'` ในโค้ด |

- Point ↔ Asset เชื่อมด้วย `point.assetId` (Stable ID) · หนึ่ง Asset มีได้หลาย Point
- รหัสแสดงผล (`P-003`, `WL-001`) = Stable ID เดิม ไม่เปลี่ยน (ประวัติค่าวัด/เหตุการณ์ใน IndexedDB อ้างรหัสนี้)

### 2.3 Lifecycle (สถานะการติดตั้ง แยกจาก active/archived)

| `installation.status` | แสดงตำแหน่ง 2D/3D | รับค่า Sensor | KPI / Alarm | สัญลักษณ์ |
|---|---|---|---|---|
| `proposed` | ✅ | ❌ (ปฏิเสธที่ normalize + Demo ไม่สร้างค่า) | ❌ | หมุดเส้นประ + ป้าย "เสนอ" |
| `pending_approval` | ✅ | ❌ | ❌ | เส้นประ + "รออนุมัติ" |
| `approved` | ✅ | ❌ | ❌ | เส้นทึบบาง + "อนุมัติแล้ว · ยังไม่ติดตั้ง" |
| `installed` | ✅ | ✅ | ✅ | หมุดเดิม (สีตามสถานะ) |
| `commissioned` | ✅ | ✅ | ✅ | หมุดเดิม |
| `rejected` / `decommissioned` | ❌ (อยู่ในรายการตรวจสอบ/ประวัติ) | ❌ | ❌ | — |

- กติกาเดียวอยู่ที่ `lifecycle.js`: `feedsTelemetry(point) = status === 'active' && installation ∈ {installed, commissioned}` — ใช้ร่วมกันใน `normalize.js`, `demoAdapter.js`, `kpi.js`, `alarms`, การนับหมายเลขหมุด
- จุดที่ยังไม่ติดตั้ง **ไม่มีค่า ไม่มีกราฟ ไม่มีสีสถานะ** แผงรายละเอียดแสดง "ยังไม่ติดตั้ง — ไม่มีข้อมูล Sensor" แทน (ไม่สร้างค่าปลอม)

### 2.4 Needs Remapping

- `position.mappingStatus ∈ {mapped, unanchored, needs_remapping}` (Fortune ทุกจุด = `unanchored`: วางจากผัง ยังไม่ผูกวัตถุในโมเดล)
- `needs_remapping` ยังคงอยู่ใน `SpatialDataService.reviewList()` เสมอ — **ไม่ลบ ไม่ซ่อนเงียบ** · แสดงที่ตำแหน่งล่าสุดที่รู้ พร้อมป้าย "ต้องตรวจตำแหน่ง"
- ถ้ายังส่งค่าได้ (installed) ยังรับค่า/แจ้งเตือนตามปกติ — ตำแหน่งไม่แน่นอนไม่ใช่เหตุให้ทิ้งข้อมูลจริง
- รายการตรวจสอบแสดงในหน้า "ตั้งค่า" (เมนูผู้ดูแล) — ไม่เพิ่มอะไรในหน้าหลักของ Fortune (ไม่มีจุดสถานะนี้)

## 3. รายการไฟล์ที่จะเปลี่ยน

**ใหม่**

| ไฟล์ | หน้าที่ |
|---|---|
| `src/data/coords.js` | FloorFrame, affine2d, planToBuilding / buildingToPlan / entityPosition |
| `src/data/lifecycle.js` | สถานะติดตั้ง, `feedsTelemetry`, `isDisplayable`, ป้ายและคลาสสัญลักษณ์ |
| `src/data/entities.js` | normalize/validate Point และ Asset, ความสัมพันธ์ Stable ID |
| `src/data/spatialData.js` | `SpatialDataService` (snapshot, ดัชนีตามชั้น, tanks(), pumps(), reviewList(), onChange) |
| `tests/coords.test.js`, `tests/lifecycle.test.js`, `tests/spatial-data.test.js`, `tests/migrate-v6.test.js` | Unit + Migration |
| `scripts/e2e_data_layer.py` | Regression เฉพาะ Data Layer (2D/3D ตำแหน่งตรงกัน, ถัง/ปั๊ม, lifecycle ด้วยข้อมูลทดสอบ) |
| `scripts/visual_compare.py` | ภาพก่อน–หลัง (build `7555525` vs build ใหม่) |

**แก้ไข** (ไม่เปลี่ยนภาพ/Flow ของ Fortune)

| ไฟล์ | การแก้ |
|---|---|
| `src/domain/constants.js` | `SCHEMA_VERSION = 6` |
| `src/domain/migrate.js` | v5 → v6: เพิ่ม `assets[]`, `point.assetId`, `point.installation`, `point.position` |
| `src/domain/defaultConfig.js` | ค่าเริ่มต้น v6 ของ Fortune (ค่าเดียวกับผล migration) |
| `src/domain/config.js` | ตรวจ Asset, assetId อ้างถึงได้จริง, สถานะติดตั้ง |
| `src/domain/geometry.js` | ฟังก์ชันเดิมเรียกผ่าน `coords.js` (ผลเท่าเดิม) |
| `src/domain/kpi.js`, `src/domain/normalize.js`, `src/adapters/demoAdapter.js` | ใช้ `feedsTelemetry` (Fortune ทุกจุด installed → ผลเท่าเดิม) |
| `src/scene/scene3d.js` | `#buildEquipment` อ่าน tanks()/pumps() จาก Service · ลบ `'P-003'` · หมุดใช้ `entityPosition` · สัญลักษณ์สถานะยังไม่ติดตั้ง |
| `src/ui/app.js` | สร้าง Service ครั้งเดียว ส่งให้ 3D/2D/แผงเกจ · `pumpRunning` จาก Asset ปั๊ม แทน `'P-003'` |
| `src/ui/plan2d.js` | หมุดอ่านตำแหน่งจาก Service · คลาสสัญลักษณ์สถานะติดตั้ง |
| `src/ui/waterPanel.js` | อ่าน tanks() จาก Service |
| `src/ui/settingsView.js` | แสดง/ตั้งสถานะติดตั้ง + Asset ที่ผูก · ส่วน "รายการตรวจสอบตำแหน่ง" |
| `src/style.css` | คลาสหมุดสถานะยังไม่ติดตั้ง/ต้องตรวจตำแหน่ง (ไม่แตะคลาสเดิม) |
| `scripts/e2e*.py` | ไม่แก้ (ใช้เป็น Regression ตามเดิม) |

ไม่แตะ: โมเดล GLB, ผัง, `elevator*`, `mobility*`, `materials*`, `detailModel.js`, `dist` ของสาขาอื่น

## 4. แผน Migration ของ Fortune (v5 → v6)

1. ทุก Point เดิมได้ `installation: { status: 'installed', note: 'จุดตัวอย่างของโครงการสาธิต (ข้อมูลจำลอง) — คงพฤติกรรมเดิม' }` → KPI/Alarm/กราฟ/ข้อมูลจำลองเหมือนเดิมทุกค่า · `example: true` คงเดิม
2. `position = { plan: {u: plan.x, v: plan.y}, xyz: pos3d, mappingStatus: 'unanchored', anchor: null }` — เก็บ `plan`/`pos3d` เดิมไว้ด้วยในรอบนี้ (โค้ดเดิม/สำรองข้อมูลรุ่นก่อนยังอ่านได้)
3. สร้าง Asset จากข้อมูลที่มีอยู่ — **ตำแหน่ง/ระยะเลื่อนเท่าที่ฉากวาดอยู่ตอนนี้ทุกค่า**

| Asset (เสนอรหัส) | type | มาจาก | ตำแหน่ง | visual |
|---|---|---|---|---|
| `PUMP-EX-01` | pump | `P-003.equipmentId` | ผังของ P-003 | ปั๊มเดิม, เลื่อน x −0.6 |
| `AHU-EX` | ahu | `P-004.equipmentId` | ผังของ P-004 | ไม่มีภาพ (เหมือนเดิม) |
| `PIT-WL-001` | pit | WL-001 `gauge.visual = 'pit'` | ผังของ WL-001 | บ่อเดิม, เลื่อน x +0.42 |
| `TANK-WL-002` | tank | WL-002 `gauge.visual = 'tank'` | ผังของ WL-002 | ถังเดิม, เลื่อน x +0.42 |

4. `point.assetId`: P-003 → PUMP-EX-01, P-004 → AHU-EX, WL-001 → PIT-WL-001, WL-002 → TANK-WL-002, จุดอื่น `null` · `equipmentId` เดิมคงไว้
5. Migration เป็นฟังก์ชันบริสุทธิ์ คืนสำเนาใหม่ · รันซ้ำได้ผลเท่าเดิม (idempotent) · การตั้งค่าที่ผู้ใช้แก้เอง (ตำแหน่ง/ชื่อ/เกณฑ์) ไม่ถูกเขียนทับ · ประวัติค่าวัดและเหตุการณ์ไม่ต้องย้าย (อ้าง Stable ID เดิม)
6. ไฟล์สำรองรุ่นเก่า (v1–v5) ที่นำเข้าผ่านหน้า "ตั้งค่า" ผ่าน migration เดียวกัน
7. Rollback: สาขาแยก · build เดิม `7555525` อ่าน config v6 ไม่ได้ → ใช้ `?db=` แยกระหว่างทดสอบ ไม่แตะฐานข้อมูลของ Demo

## 5. การทดสอบ

| ชุด | ตรวจ |
|---|---|
| Unit — coords | FloorFrame ของทุก 28 ชั้นให้ผลเท่า `planTo3D/threeDToPlan` เดิม (≤ 1e-12), ไป–กลับ plan→3D→plan |
| Unit — lifecycle | ตารางสถานะ × (แสดงตำแหน่ง/รับค่า/KPI/Alarm) ครบทุกช่อง |
| Unit — SpatialDataService | ดัชนีตามชั้น, Point↔Asset, tanks()/pumps() ไม่พึ่งรหัสในโค้ด, reviewList เก็บ needs_remapping เสมอ, snapshot ไม่ถูกแก้จากภายนอก |
| Migration | v1…v5 → v6 สำหรับค่าเริ่มต้นและค่าที่ผู้ใช้แก้, idempotent, ค่า plan/pos3d/ชื่อ/เกณฑ์เหมือนเดิมทุกไบต์, Asset ตามตาราง 4 |
| Ingestion | ข้อมูลของจุด proposed/pending/approved ถูกปฏิเสธ (`not-installed`) · Demo ไม่สร้างค่า · KPI ไม่นับ |
| Regression (เบราว์เซอร์) | e2e, e2e_site, e2e_elevator, e2e_floors, e2e_2d_fallback, e2e_lift_switch ทั้ง build ใหม่และ `7555525` + Unit ทั้งหมด |
| ภาพก่อน–หลัง | มุมเดียวกัน ฉากหยุดเวลา: ทึบ / โปร่งใส / โครงอาคาร × ทั้งอาคาร + ชั้น G, 3, 4, 11 × 3D และผัง 2D G, 4 + แผงเกจ — เกณฑ์: ต่างกัน 0 พิกเซล (ยกเว้นที่อธิบายได้) · พร้อมเทียบตัวเลขตำแหน่งหมุด/ถัง/ปั๊มในฉาก |
| Performance | วัดซ้ำบน Desktop GPU จริง (ทึบ / โปร่งใส+ลิฟต์ / หนักสุด) ต้องไม่ช้ากว่า `7555525` |

## 6. ขอการตัดสินใจ

1. **รหัส Asset ที่เสนอ** (`PUMP-EX-01`, `AHU-EX`, `PIT-WL-001`, `TANK-WL-002`) — ใช้ได้หรือมีรหัสจริงของฟอร์จูน
2. **จุดใหม่ที่สร้างจากหน้า "ตั้งค่า"**: ค่าเริ่มต้นสถานะติดตั้ง — เสนอ `installed` เพื่อคง Flow เดิม (จุดใหม่ส่งค่าได้ทันทีเหมือนวันนี้) หรือ `proposed` (ต้องเปลี่ยนสถานะก่อนรับค่า — เปลี่ยน Flow)
3. **รายการตรวจสอบตำแหน่ง** วางในหน้า "ตั้งค่า" (ผู้ดูแล) — ตกลงหรือไม่
4. สัญลักษณ์หมุดสถานะยังไม่ติดตั้ง (เส้นประ + ป้าย) — Fortune ไม่มีจุดสถานะนี้ จึงไม่เห็นในหน้าจอปัจจุบัน จะส่งภาพตัวอย่างจากข้อมูลทดสอบให้ดูก่อนใช้จริง
