# Data Layer กลาง — Architecture · รายการไฟล์ · แผน Migration (ฉบับแก้ไขครั้งที่ 3)

สาขา `feature/data-layer` (ฐาน `7555525`) · ขอบเขต: `Point`, `Asset`, `Tank`, `Pump` · **ยังไม่แก้โค้ดแอปจนกว่าเอกสารนี้ได้รับอนุมัติ**
ไม่รวม: Adaptive Governor, Mobility Optimization, Theme, Backend/DB จริง (ออกแบบไว้ใน `design/floor-plan-platform`) · ไม่แตะ Demo ปัจจุบัน, `main`, `gh-pages`

ฉบับนี้แก้ตามคำตัดสิน 18 ต.ค. 2569 (2 ข้อความ) และ 19 ต.ค. 2569 (5 ข้อ) — สรุปการเปลี่ยนแปลงอยู่ที่ข้อ 8 และ 9
อนุมัติให้เริ่ม Commit 1–3 หลัง Baseline ของ `7555525` ผ่าน แล้วหยุดส่งผลก่อนเชื่อม 3D/2D/KPI/Alarm

## 1. ปัญหาของโค้ดปัจจุบัน

| ปัญหา | ที่อยู่ | ผล |
|---|---|---|
| ปั๊มผูกรหัสจุดในโค้ด `'P-003'` | `scene3d.js #buildEquipment`, `app.js #updateSpatial` | โครงการใหม่ต้องแก้โค้ด |
| ถัง/บ่อสร้างจาก `metric.gauge` ในฉาก 3D และคำนวณตำแหน่งเอง (+0.42 / −0.6) | `scene3d.js` | 2D (แผงเกจ) กับ 3D คำนวณคนละที่ |
| Point กับอุปกรณ์ปนกัน (`equipmentId` เป็นข้อความ ไม่มี Entity Asset) | `defaultConfig.js` | Point แยกจาก Asset ไม่ได้ |
| รหัสที่คนอ่าน (`P-003`) ใช้เป็น ID ระบบ และค้นด้วยรหัสอย่างเดียว | ทั้งแอป + IndexedDB | เปลี่ยนรหัสไม่ได้ · ข้อมูลคนละโครงการชนกันได้ |
| ไม่มีขอบเขต organization / project / building | — | ไม่มีอะไรกันข้อมูลรั่วข้ามโครงการ |
| ไม่มีสถานะการติดตั้ง — ทุกจุด `active` ส่งค่าเข้า KPI/Alarm | `kpi.js`, `normalize.js`, `demoAdapter.js` | จุดที่ยังไม่ติดตั้งจะมีข้อมูลปลอมได้ |
| แปลงพิกัด 2D↔3D หลายสูตรกระจาย | `geometry.js`, `scene3d.js`, `app.js` | ไม่มีระบบพิกัดกลาง |
| ไม่มี `Needs Remapping` และไม่มีเวอร์ชันผัง/โมเดล | — | เปลี่ยนแปลน/โมเดลแล้วตรวจไม่พบ จุดคลาดหรือหายเงียบได้ |

## 2. Architecture

```
 config v5 (IndexedDB "iot-fortune…")       ← ไม่ถูกแก้ = สำรอง + ทางย้อนกลับ
        │  migrate → v6 (คัดลอกไปฐานข้อมูลใหม่ "…@v6" ไม่เขียนทับของเดิม)
        ▼
 ┌──────────────────────── src/data/ (ไม่พึ่ง DOM / WebGL) ────────────────────────┐
 │ ids.js           UUID (สุ่มสำหรับของใหม่ · v5 กำหนดได้สำหรับ migration)           │
 │ scope.js         Scope { organizationId, projectId, buildingId } — บังคับทุกการค้น    │
 │ coords.js        Building CRS + FloorFrame (affine2d) + เวอร์ชันพิกัด/ผัง/โมเดล         │
 │ lifecycle.js     สถานะติดตั้ง · กติกาตัดสิน (Point × Asset) · mappingStatus            │
 │ entities.js      Point, Asset, Binding — validate + unique (projectId, code)          │
 │ spatialData.js   SpatialDataService — แหล่งความจริงเดียว (snapshot อ่านอย่างเดียว)      │
 │ ingestAudit.js   บันทึกข้อมูลที่ถูกปฏิเสธ (not-installed ฯลฯ) — ไม่ทิ้งเงียบ               │
 └──────────────────────────────────────────────────────────────────────────────┘
        │ อ่านอย่างเดียว (snapshot + onChange)
   ┌────┴───────────────┬──────────────────────┬─────────────────────┐
   ▼                    ▼                      ▼                     ▼
 scene3d.js         plan2d.js / app.js      waterPanel.js        engine / kpi / normalize
 (หมุด ถัง ปั๊ม)       (หมุด ผัง 2D รายการ)     (เกจ 2D)              (ตามกติกา lifecycle)
```

### 2.1 ID, Code และขอบเขตข้อมูล

| ฟิลด์ | ความหมาย | ตัวอย่าง Fortune |
|---|---|---|
| `id` | **UUID ถาวร** — ใช้เชื่อมความสัมพันธ์ ประวัติค่าวัด เหตุการณ์ สถานะหน้าจอ ไม่เปลี่ยนตลอดอายุ | `3f6c…` |
| `pointCode` / `assetCode` | รหัสที่คนอ่านและแก้ได้ ใช้แสดงผลเท่านั้น · **Unique ต่อ (projectId, code)** | `P-003`, `WL-001` / `FRT-DEMO-PUMP-001` |
| `isDemo` | อุปกรณ์/จุดจำลอง (แทน `example`/`simulated` เดิม ซึ่งคงไว้อ่านย้อนหลัง) | `true` |
| `organizationId`, `projectId`, `buildingId`, `floorId` | ขอบเขตบนทุก Point และ Asset | UUID ของ org/โครงการ/อาคาร/ชั้น Fortune |

- ทุก Entity (Floor, Point, Asset, Binding) มี `organizationId`, `projectId`, `buildingId` และ Point/Asset มี `floorId` (UUID ของชั้น) · ชั้นมี `floorCode` (`G`, `5`, `11` …) สำหรับแสดงผล ชื่อไฟล์ผัง/โมเดล และค่าใน dropdown เดิม
- `SpatialDataService` รับ `Scope` ตอนสร้าง และ **ทุกฟังก์ชันค้นตรวจ scope** — Entity ที่ scope ไม่ตรงถูกปฏิเสธตั้งแต่ตอนโหลด (ไม่ใช่กรองตอนแสดง) · การค้นด้วยรหัสต้องเป็น `byCode(projectId, code)` ไม่มีฟังก์ชันค้นด้วยรหัสอย่างเดียว
- ข้อมูลเข้า (telemetry) จับคู่ด้วย `(projectId, sourceKey)` ภายใน scope ปัจจุบัน
- UUID ของข้อมูลที่ migrate มา: **UUID v5( namespace = `organization.namespaceId`, name = `${projectId}:${entityType}:${legacyCode}` )**
  - `organization.namespaceId` = UUID ถาวรขององค์กร (สุ่มครั้งเดียว ไม่เปลี่ยนตลอดอายุ แยกจาก `organizationId` และไม่ใช้ชื่อ/รหัสองค์กร) → UUID ของคนละองค์กรไม่ชนกันแม้ใช้รหัสเดิมเหมือนกัน
  - `projectId` = UUID ของโครงการ (ไม่ใช้ `projectCode` ที่อาจซ้ำหรือถูกเปลี่ยน) · `entityType` ∈ `floor`, `point`, `asset`, `binding` · `legacyCode` = รหัสเดิม (`P-003`, `G`, …)
  - Fortune: `namespaceId`, `organizationId`, `projectId`, `buildingId` เป็นค่าคงที่ที่สร้างครั้งเดียวและ commit ในค่าเริ่มต้น → migration ได้ UUID เดียวกันทุกเครื่อง ทดสอบซ้ำได้
  - UUID ที่สร้างแล้วถูกเก็บถาวร ไม่คำนวณใหม่ → เปลี่ยน code ภายหลังได้โดย UUID ไม่เปลี่ยน · ของที่สร้างใหม่ใช้ UUID v4
- เมื่อได้รหัสอุปกรณ์จริง: แก้เฉพาะ `assetCode` — Point/Binding/ประวัติยังเชื่อมด้วย UUID เดิม (มี Unit Test)

### 2.2 ระบบพิกัดกลางและเวอร์ชัน

- Building CRS: `x` ขวา, `z` ใต้ (ตามผัง), `y` ขึ้น · หน่วย = หน่วยโมเดลของแอป (เป็นการจับคู่เชิงแผนภาพเหมือนเดิม ไม่ใช่พิกัดสำรวจ)
- `building.coordinateSystem = { version: coordinateSystemVersion, axes, unit }`
- ทุกชั้นมี `FloorFrame`: `planTransform = affine2d [a, b, c, d, e, f]` (`x = a·u + b·v + c`, `z = d·u + e·v + f`), `elevation`, **`floorPlanVersion`** และ **`modelVersion`** (ทั้งโมเดลเบาและโมเดลรายละเอียด)
- Fortune: `a = width, b = 0, c = cx − width/2, d = 0, e = depth, f = cz − depth/2` — **เท่ากับ `planTo3D` เดิมทุกตัว** (ทดสอบ ≤ 1e-12)
- **เวอร์ชันมาจากเนื้อหาไฟล์ ไม่ใช่ชื่อ/ขนาด**: ขั้น build สร้าง `asset-manifest.json` (SHA-256 ของไฟล์ผัง `.webp`, โมเดลเบา `fortune.glb`, โมเดลรายละเอียด `floor-*.glb`, `rooms-*.json`) — `floorPlanVersion = sha256:<ผัง>` · `modelVersion = sha256:<โมเดลรายละเอียด>` (ชั้นที่ไม่มีโมเดลรายละเอียดใช้โมเดลเบา) · เมื่อมี Backend/Import Job ใช้ Revision ID ที่ออกเมื่อเนื้อหาเปลี่ยนแทน
  - ไฟล์ใหม่ที่ชื่อและขนาดเท่าเดิมแต่เนื้อหาต่าง → แฮชต่าง → จุดเข้า `needs_remapping` (มี Unit Test)
  - แอปอ่าน manifest ที่ build สร้าง ไม่คำนวณแฮชจากการดาวน์โหลดไฟล์ระหว่างใช้งาน (ไม่เพิ่มภาระโหลด) · manifest เป็นไฟล์ใหม่ใน `dist` ไม่กระทบภาพหรือ Flow
- ตำแหน่งของ Point/Asset เก็บ `resolvedAgainst = { coordinateSystemVersion, floorPlanVersion, modelVersion }` — เวอร์ชันที่ใช้วางจุดนั้น
- ตรวจตอนโหลด: เวอร์ชันปัจจุบันของชั้น ≠ `resolvedAgainst` → จุดนั้นเป็น `needs_remapping` พร้อมเหตุผล (`plan-changed` / `model-changed` / `crs-changed`) — แสดงที่ตำแหน่งเดิม ไม่ลบ ไม่ซ่อน
- โมเดลรายละเอียด Blender (`detailTransform`) ไม่เปลี่ยนสูตร

### 2.3 Entity และความสัมพันธ์ (แหล่งข้อมูลหลักเดียว)

| Entity | ฟิลด์หลัก |
|---|---|
| **Point** | `id`, `pointCode`, scope + `floorId`, `areaId`, `sourceKey`, `position`, `installation`, `status` (active/archived — การติดตามเดิม), `metrics[]`, `isDemo` |
| **Asset** | `id`, `assetCode`, scope + `floorId`, `areaId`, `type` (`pump`, `tank`, `pit`, `ahu`, `panel`, …), `name`, `position`, `installation`, `visual` (แบบภาพ + ระยะเลื่อน), `isDemo` |
| **Binding** | `id`, scope, `assetId`, `pointId`, `role` (`level`, `run`, `current`, `temperature`, `humidity`, …), `metricId` |

- **ความสัมพันธ์ Point–Asset อยู่ใน Binding เท่านั้น** — ไม่มี `point.assetId`, `asset.levelPoint`, `asset.runPoint` (ไม่มีข้อมูลซ้ำให้ขัดกัน) · Service สร้างดัชนีทั้งสองทิศจาก Binding
- Unique: `(projectId, pointCode)`, `(projectId, assetCode)`, `(assetId, role)` สำหรับบทบาทเดี่ยว (`level`, `run`) · Binding ต้องอ้าง Point/Asset ใน scope เดียวกันและชั้นเดียวกัน (ต่างชั้น = ข้อผิดพลาดตรวจสอบ)
- **การจับคู่ Telemetry (ต้องไม่คลุมเครือ)**: ข้อมูลเข้าระบุด้วย `(projectId, sourceKey, metricSourceKey)` → ได้ `(pointId, metricId)` เพียงหนึ่งเดียว
  - `sourceKey` = รหัสอุปกรณ์/ช่องสัญญาณที่ส่งข้อมูล (ของ Point) · `metricSourceKey` = คีย์ของค่าวัดในข้อมูลที่ส่ง (ของ Metric)
  - อุปกรณ์หนึ่งตัวส่งหลายค่าได้: Point หลายจุดใช้ `sourceKey` เดียวกันได้ ถ้า `metricSourceKey` ไม่ซ้ำกัน (เช่น Gateway `GW-01` ส่ง `ch1_level` → WL-001, `ch2_temp` → P-005)
  - **Unique**: `(projectId, sourceKey, metricSourceKey)` ในบรรดาจุดที่ยังใช้งาน (ไม่ใช่ `rejected`/`decommissioned`/`archived`) — ซ้ำ = การตั้งค่าไม่ผ่านการตรวจ (ไม่เลือกตัวใดตัวหนึ่งให้เอง)
  - Existing Baseline Defect BD-001 (`docs/reports/BASELINE-DEFECTS.md`): `validateConfig` ตรวจ sourceKey ของจุดซ้ำอยู่แล้ว แต่ไม่ตรวจ `metric.sourceKey` ซ้ำในจุดเดียวกัน (ค่าวัดที่สองไม่ได้รับข้อมูลเงียบ ๆ) และ `indexConfig` ทับเงียบ ๆ ถ้าได้การตั้งค่าที่ไม่ผ่านการตรวจ — แทนด้วยดัชนีคู่ที่ตรวจซ้ำก่อนสร้าง
  - Migration v6 ตรวจคู่ซ้ำในการตั้งค่าของแต่ละเครื่องก่อนอัปเกรด ถ้าพบ: หยุด แสดงรายการจุด/ค่าวัดที่ชนกัน คงฐานข้อมูลเดิมไว้ (ไม่เลือก ไม่เขียนทับ) · Fortune ค่าเริ่มต้นตรวจแล้วไม่ซ้ำ
  - ไม่พบคู่ใน scope → ปฏิเสธ `unknown-point` / `unknown-metric` + บันทึก audit (ไม่ตกไปหาโครงการอื่น ไม่เดา)
  - Unit Test: อุปกรณ์เดียวหลายค่าเข้าคนละจุดถูกต้อง · คีย์ซ้ำถูกปฏิเสธตอนตรวจการตั้งค่า · รหัสเดียวกันต่างโครงการไม่ปนกัน · ข้อมูลของจุด retired ไม่เข้าจุดใหม่ที่ใช้รหัสเดิมย้อนหลัง · สุ่มข้อมูลจำนวนมากแล้วทุกค่าเข้าจุดที่คาดไว้เท่านั้น
- **Tank / Pit** = Asset `type: 'tank' | 'pit'` + Binding `role: 'level'` → ภาพถัง 3D และเกจ 2D อ่านจาก Asset เดียวกัน (ช่วงเกจอยู่ใน metric ของ Point ตามเดิม)
- **Pump** = Asset `type: 'pump'` + Binding `role: 'run'` (และ `current` ถ้ามี) → ใบพัดหมุนเฉพาะค่า `run` สดใหม่เหมือนเดิม — **ไม่มี `'P-003'` ในโค้ด**
- `equipmentId` เดิมคงไว้อ่านย้อนหลังเท่านั้น ไม่ใช้ตัดสินความสัมพันธ์

### 2.4 Lifecycle และกติกาตัดสินเมื่อสถานะไม่ตรงกัน

สถานะติดตั้ง (`installation.status`) ใช้ได้ทั้ง Point และ Asset: `draft` · `proposed` · `pending_approval` · `approved` · `installed` · `commissioned` · `rejected` · `decommissioned`

| สถานะของ Point | แสดงตำแหน่ง 2D/3D | รับค่า Sensor | KPI / Alarm |
|---|---|---|---|
| `draft`, `proposed`, `pending_approval`, `approved` | ✅ หมุดแบบยังไม่ติดตั้ง | ❌ ปฏิเสธ `not-installed` + บันทึก | ❌ |
| `installed`, `commissioned` | ✅ หมุดเดิม | ✅ (ถ้าผ่านกติกา Asset ด้านล่าง) | ✅ |
| `rejected`, `decommissioned` | ❌ (อยู่ในประวัติ/รายการตรวจสอบ) | ❌ ปฏิเสธ `point-retired` + บันทึก | ❌ |

**กติกาตัดสินเดียว** `telemetryDecision(point, boundAssets)` ใน `lifecycle.js` (ใช้ร่วมกันที่ normalize, demoAdapter, kpi, alarms):

1. Point ตัดสินก่อน — ข้อมูลเป็นของ Point (เซนเซอร์คือสิ่งที่ส่งค่า) ต้อง `status = active` และ `installation ∈ {installed, commissioned}`
2. Asset ที่ผูกอยู่ **ยับยั้งได้ แต่อนุญาตแทนไม่ได้**: ถ้า Asset ใด ๆ ที่ผูกกับ Point อยู่ใน `rejected`/`decommissioned` → ปฏิเสธ `asset-retired`
3. สถานะอื่นที่ไม่ตรงกัน (เช่น Point `installed` แต่ Asset `proposed`, หรือ Asset `installed` แต่ Point `proposed`) → ใช้ผลตามข้อ 1–2 และ **ขึ้นรายการตรวจสอบ** เหตุผล `status-mismatch` (ไม่เดา ไม่แก้ให้เอง)
4. ผลตัดสินเดียวกันใช้ทั้งการรับข้อมูล, KPI และ Alarm — จะไม่มีกรณีรับค่าแต่ไม่แจ้งเตือน หรือแจ้งเตือนจากจุดที่ไม่รับค่า

- จุดที่ยังไม่ติดตั้ง: ไม่มีค่า ไม่มีกราฟ ไม่มีสีสถานะ · แผงรายละเอียดแสดง "ยังไม่ติดตั้ง — ไม่มีข้อมูล Sensor" · Demo ไม่สร้างค่าให้
- **ไม่ทิ้งเงียบ**: ทุกค่าที่ถูกปฏิเสธด้วย `not-installed` / `point-retired` / `asset-retired` → คืนเหตุผลในผลของ `ingest()` (มีอยู่แล้วใน `diag.byReason`) **และ** บันทึกลง `ingestAudit` (IndexedDB store ใหม่ `rejected_ingestion`: scope, pointId, pointCode, sourceKey, metric, observedAt, receivedAt, reason, source — เก็บแบบจำกัดจำนวน/อายุ) · รูปแบบเดียวกับตาราง Audit ของ Backend ในอนาคต (`design/floor-plan-platform`)

### 2.5 ค่าเริ่มต้นของจุดใหม่ (Project Configuration)

- `project.settings.defaultPointInstallStatus` — **ไม่ Hardcode ในโค้ด**
- Fortune Demo: `installed` (คง Flow เดิม: จุดใหม่จากหน้า "ตั้งค่า" รับค่าได้ทันที)
- ค่าเริ่มต้นของแพลตฟอร์ม/โครงการจริง (เมื่อไม่ได้กำหนด): `proposed` — ต้องผ่านการอนุมัติก่อนรับข้อมูลจริง

### 2.6 Needs Remapping และรายการตรวจสอบ

- `position.mappingStatus ∈ {mapped, unanchored, needs_remapping}` + `remapReason` (`plan-changed`, `model-changed`, `crs-changed`, `anchor-not-found`, `manual`)
- Fortune ทุกจุดเริ่มเป็น `unanchored` (วางจากผัง ยังไม่ผูกวัตถุในโมเดล — ปกติ ไม่ขึ้นรายการ)
- `needs_remapping` **ไม่ลบ ไม่ซ่อน**: แสดงที่ตำแหน่งล่าสุดที่รู้ด้วยสัญลักษณ์เฉพาะ + ข้อความ "ต้องตรวจตำแหน่ง" · ถ้าติดตั้งแล้วยังรับค่า/แจ้งเตือนตามปกติ
- **แท็บ `ตำแหน่งที่ต้องตรวจสอบ`** ในหน้า "ตั้งค่า" (เฉพาะ Admin/Editor): Point/Asset (code + ชื่อ) · ชั้นและพื้นที่ · สถานะ Anchor · สาเหตุ · Plan/Model Version (ที่วางไว้ เทียบกับปัจจุบัน) · ปุ่มเปิดดูใน 2D / 3D · รวมรายการ `status-mismatch`
- สิทธิ์: Fortune Demo ยังไม่มีระบบผู้ใช้ — ใช้ `RoleGate` เดียวในโค้ด (บทบาทปัจจุบันของเครื่อง = Admin เหมือนวันนี้ที่ทุกคนเข้าหน้า "ตั้งค่า" ได้) เพื่อให้ต่อกับ Access Control จริงได้

### 2.6.1 ขอบเขตด้านความปลอดภัยของรอบนี้ (ข้อจำกัดที่ต้องรู้)

> **Scope และ RoleGate ฝั่ง Frontend ในรอบนี้ช่วยป้องกันข้อมูลปนกันโดยไม่ตั้งใจ (โค้ดผิด/ตั้งค่าผิด) เท่านั้น — ยังไม่ใช่ความปลอดภัยของระบบหลายโครงการจริง**
> ทุกอย่างที่อยู่ในเบราว์เซอร์ผู้ใช้แก้หรือข้ามได้ (DevTools, แก้ IndexedDB, เรียก API ตรง) การซ่อนเมนูไม่ใช่การควบคุมสิทธิ์
>
> **ก่อน Production ต้องมีครบ** (ออกแบบไว้ใน `design/floor-plan-platform`):
> 1. Authentication (ผู้ใช้จริง, session ปลอดภัย)
> 2. Server-side Authorization ตรวจ Project Membership + Role ทุกคำขอ — ไม่เชื่อ `organizationId`/`projectId` ที่ส่งมาจาก Frontend
> 3. Database บังคับขอบเขต (Row-Level Security / composite FK) ตรวจ `organizationId`/`projectId` ทุกคำขอ
> 4. Device Token จำกัดเฉพาะอุปกรณ์และโครงการ · Service Key อยู่ฝั่ง Server เท่านั้น
> 5. ทดสอบ IDOR/BOLA อัตโนมัติ (ผู้ใช้โครงการ A อ่าน/แก้/ดาวน์โหลด/เดา URL ของโครงการ B ไม่ได้) พร้อม Audit การปฏิเสธ

### 2.7 รูปแบบหมุด

- หมุด Installed/Commissioned: **เหมือนเดิมทุกประการ** (คลาส/สี/ขนาด/ตัวเลขเดิม — ทดสอบด้วยภาพเทียบ 0 พิกเซล)
- Draft/Proposed/Pending/Approved: เส้นประ + รูปทรง/Badge ข้อความ (ไม่ใช้สีอย่างเดียว)
- Needs Remapping: สัญลักษณ์เฉพาะ + ข้อความ
- จะส่งภาพตัวอย่าง Desktop / Mobile × 2D / 3D จากข้อมูลทดสอบ (`?db=` แยก) ให้ตรวจก่อนรวม

## 3. รายการไฟล์ที่จะเปลี่ยน

**ใหม่**

| ไฟล์ | หน้าที่ |
|---|---|
| `src/data/ids.js` | UUID v4 / v5 (ไม่มี dependency ใหม่) |
| `src/data/scope.js` | Scope + การตรวจ scope |
| `src/data/coords.js` | FloorFrame, affine2d, เวอร์ชัน, planToBuilding / buildingToPlan / entityPosition, ตรวจ needs_remapping |
| `src/data/lifecycle.js` | สถานะติดตั้ง, `telemetryDecision`, ป้าย/คลาสสัญลักษณ์ |
| `src/data/entities.js` | Point, Asset, Binding — validate, unique (projectId, code) |
| `src/data/spatialData.js` | `SpatialDataService` |
| `src/data/ingestAudit.js` | บันทึกข้อมูลที่ถูกปฏิเสธ |
| `scripts/build-asset-manifest.mjs` | สร้าง `public/asset-manifest.json` (SHA-256 ของผัง/โมเดล) ก่อน build — เรียกจาก `npm run build` · มี `--check` ตรวจว่า manifest ตรงกับไฟล์จริง |
| `src/ui/positionReview.js` | แท็บ `ตำแหน่งที่ต้องตรวจสอบ` |
| `tests/ids.test.js`, `tests/coords.test.js`, `tests/lifecycle.test.js`, `tests/spatial-data.test.js`, `tests/migrate-v6.test.js`, `tests/ingest-audit.test.js` | Unit + Migration |
| `scripts/e2e_data_layer.py` | Regression ของ Data Layer (2D/3D ตรงกัน, ถัง/ปั๊ม, lifecycle, scope, ย้อนกลับ) |
| `scripts/visual_compare.py` | ภาพก่อน–หลัง + พิกัดก่อน–หลัง |

**แก้ไข** (ไม่เปลี่ยนภาพ/Flow ของ Fortune)

| ไฟล์ | การแก้ |
|---|---|
| `package.json` | `build` เรียกสร้าง asset manifest ก่อน `vite build` (ไม่เพิ่ม dependency) |
| `src/domain/constants.js` | `SCHEMA_VERSION = 6` |
| `src/domain/migrate.js` | v5 → v6 (ข้อ 4) |
| `src/domain/defaultConfig.js` | ค่าเริ่มต้น v6 = ผล migration ของค่าเริ่มต้น v5 |
| `src/domain/config.js` | ตรวจ scope, unique code, Binding, สถานะ, เวอร์ชัน |
| `src/domain/geometry.js` | ฟังก์ชันเดิมเรียกผ่าน `coords.js` (ผลเท่าเดิม) |
| `src/domain/kpi.js`, `src/domain/alarms.js`, `src/domain/normalize.js`, `src/adapters/demoAdapter.js`, `src/engine.js` | ใช้ `telemetryDecision` · ID ภายในเป็น UUID · รหัสที่แสดงเป็น code |
| `src/store/idbRepo.js` | ฐานข้อมูล v6 แยกชื่อ + store `rejected_ingestion` + คัดลอกจากฐานเดิม |
| `src/app/controller.js` | สร้าง Scope + Service, ขั้นตอน migration/สำรอง |
| `src/scene/scene3d.js` | อุปกรณ์จาก `assets()` + Binding · ลบ `'P-003'` · ตำแหน่งจาก `entityPosition` · หมุดสถานะยังไม่ติดตั้ง/ต้องตรวจ |
| `src/ui/app.js` | ส่ง Service ให้ 3D/2D/แผงเกจ · `pumpRunning` จาก Binding `run` · แสดง code แทน id |
| `src/ui/plan2d.js`, `src/ui/waterPanel.js`, `src/ui/presenter.js`, `src/ui/alertsView.js`, `src/ui/historyView.js` | อ่านจาก Service · แสดง code |
| `src/ui/settingsView.js` | สถานะติดตั้ง + ค่าเริ่มต้นจาก Project Configuration + แท็บรายการตรวจสอบ (ผ่าน RoleGate) |
| `src/style.css` | คลาสหมุดใหม่ (ไม่แตะคลาสเดิม) |

ไม่แตะ: โมเดล GLB, ผัง, `elevator*`, `mobility*`, `materials*`, `detailModel.js` · การทดสอบ e2e เดิมไม่แก้ (ใช้เป็น Regression — ข้อความ/aria ยังแสดงรหัส `P-003` เหมือนเดิม)

## 4. แผน Migration ของ Fortune (v5 → v6)

1. **สำรองก่อนอัปเกรด**: ไม่แก้ฐานข้อมูลเดิม — สร้างฐานข้อมูลใหม่ชื่อ `<ชื่อเดิม>@v6` แล้วคัดลอก config/ค่าวัด/เหตุการณ์/สถานะหน้าจอเข้าไปพร้อมแปลง ID · เก็บสำเนา config v5 ทั้งก้อนไว้ใน kv `migration.backup.v5` ด้วย · ฐานเดิมอยู่ครบ = ทางย้อนกลับ (build เดิมอ่านฐานเดิมได้ทันที)
2. Scope: สร้าง Organization/Project/Building ของ Fortune (`projectCode: 'FRT'`) ด้วย UUID v5 · ชั้นทั้ง 28 ได้ UUID + `floorCode` เดิม + FloorFrame + เวอร์ชันเริ่มต้น
3. Point เดิม 8 จุด: `id` = UUID v5, `pointCode` = รหัสเดิม (`P-003`, `WL-001` …), `installation.status = 'installed'`, `isDemo = true`, `position = { plan: {u, v} = plan เดิม, xyz = pos3d เดิม, mappingStatus: 'unanchored', resolvedAgainst: เวอร์ชันปัจจุบัน }`
4. Asset (UUID v5 + Demo assetCode — ไม่ใช่รหัสจริง) — **ตำแหน่ง/ระยะเลื่อนเท่าที่ฉากวาดอยู่ตอนนี้ทุกค่า**

| assetCode | type | ตำแหน่ง | visual | Binding |
|---|---|---|---|---|
| `FRT-DEMO-PUMP-001` | pump | ผังของ P-003 | ปั๊มเดิม, x −0.6 | P-003 `run`, P-003 `current` |
| `FRT-DEMO-AHU-001` | ahu | ผังของ P-004 | ไม่มีภาพ (เหมือนเดิม) | P-004 `temperature` (chws, chwr) |
| `FRT-DEMO-PIT-001` | pit | ผังของ WL-001 | บ่อเดิม, x +0.42 | WL-001 `level` |
| `FRT-DEMO-TANK-001` | tank | ผังของ WL-002 | ถังเดิม, x +0.42 | WL-002 `level` |

5. ค่าวัดและเหตุการณ์: `pointId` เปลี่ยนจากรหัสเป็น UUID ระหว่างคัดลอก (ค่า เวลาสังเกต ลำดับ การรับทราบ บันทึก ไม่เปลี่ยน) · สถานะหน้าจอ (`selectedId` ฯลฯ) แปลงด้วยตารางเดียวกัน
6. `project.settings.defaultPointInstallStatus = 'installed'` สำหรับ Fortune Demo
7. Migration เป็นฟังก์ชันบริสุทธิ์ + idempotent · ค่าที่ผู้ใช้แก้เอง (ตำแหน่ง/ชื่อ/เกณฑ์/จุดที่เพิ่มเอง) ไม่ถูกเขียนทับ · จุดที่ผู้ใช้เพิ่มเองได้ UUID และ installed ตามพฤติกรรมเดิม
8. ไฟล์สำรองรุ่นเก่า (v1–v5) ที่นำเข้าผ่านหน้า "ตั้งค่า" ผ่าน migration เดียวกัน
9. **ทดสอบย้อนกลับ**: ใช้ `?db=` แยกเท่านั้น (ไม่ใช้ฐานของ Demo ปัจจุบัน) — สร้างข้อมูลด้วย build `7555525` → เปิด build ใหม่ (migrate) → เปิด build `7555525` อีกครั้ง ต้องเห็นข้อมูลเดิมครบ · ลบฐาน `@v6` แล้ว migrate ซ้ำ ได้ผลเหมือนเดิมทุกไบต์ (UUID v5)

## 5. การทดสอบ

| ชุด | ตรวจ |
|---|---|
| Unit — ids/scope | UUID รูปแบบถูกต้อง · v5 ซ้ำได้ · Entity ต่าง scope ถูกปฏิเสธ · ไม่มีการค้นด้วย code อย่างเดียว · code ซ้ำใน project เดียวกันถูกปฏิเสธ แต่ซ้ำต่าง project ได้ |
| Unit — coords | FloorFrame ทุก 28 ชั้น = `planTo3D/threeDToPlan` เดิม (≤ 1e-12) · ไป–กลับ · เปลี่ยน floorPlanVersion/modelVersion/coordinateSystemVersion → needs_remapping พร้อมเหตุผล และจุดยังอยู่ |
| Unit — lifecycle | ตาราง Point × Asset × (แสดง/รับค่า/KPI/Alarm) ครบทุกช่อง รวมกรณีไม่ตรงกัน |
| Unit — Service | ดัชนีตามชั้น · Binding สองทิศ · tanks()/pumps() ไม่พึ่งรหัส · reviewList เก็บ needs_remapping/status-mismatch เสมอ · snapshot แก้จากภายนอกไม่ได้ · เปลี่ยน assetCode แล้ว Binding/ประวัติยังเชื่อม |
| Migration | v1…v5 → v6 (ค่าเริ่มต้น + ค่าที่ผู้ใช้แก้) · idempotent · ค่าเดิมทุกไบต์ · Asset/Binding ตามตาราง · ค่าวัด/เหตุการณ์ครบจำนวนและค่าเดิม · ฐานเดิมไม่ถูกแก้ · ย้อนกลับได้ |
| Ingestion | จุด draft/proposed/pending/approved → `not-installed` ในผล ingest + บันทึก audit · Demo ไม่สร้างค่า · KPI/Alarm ไม่นับ · Asset retired ยับยั้ง |
| Regression (เบราว์เซอร์) | e2e, e2e_site, e2e_elevator, e2e_floors, e2e_2d_fallback, e2e_lift_switch — build ใหม่และ `7555525`/`ddc56f0` · Unit ทั้งหมด |
| ภาพ + พิกัดก่อน–หลัง | ฉากหยุดเวลา มุมเดียวกัน: ทึบ / โปร่งใส / โครงอาคาร × ทั้งอาคาร + ชั้น G, 3, 4, 11 × 3D · ผัง 2D G, 4 · แผงเกจ · Desktop + Mobile — เกณฑ์ 0 พิกเซล · พิกัดหมุด/ถัง/บ่อ/ปั๊มทุกตัวก่อน–หลังต่าง ≤ 1e-9 |
| Performance | Desktop GPU จริง เทียบ `7555525` — เกณฑ์ตัวเลขในข้อ 5.1 |

### 5.1 เกณฑ์ Performance Regression (ตัวเลข)

เงื่อนไขเดียวกันทั้งสอง build: เครื่องเดียวกัน (Intel Iris Xe, ANGLE D3D11), เบราว์เซอร์เดียวกัน, `?dpr=1.25`, ขนาดหน้าต่างเดียวกัน, หน้าต่างอยู่ด้านหน้าและมีโฟกัสตลอด (rAF ≈ 60 Hz ตรวจก่อนวัด), warm-up 2–3 วิ แล้ววัด 10 วิ, กรณี ทึบ / โปร่งใส + ลิฟต์ / หนักสุด (โปร่งใส + คน + รถ + ลิฟต์ + สถานการณ์ทั้งสอง), วัดกรณีละ 3 รอบสลับ build แล้วใช้ค่ากลาง · ช่วงที่เสียโฟกัส/ถูกซ่อน ไม่นำมาใช้

| ตัวชี้วัด | เกณฑ์ผ่าน (build ใหม่ เทียบ `7555525`) |
|---|---|
| FPS เฉลี่ย | ลดลงไม่เกิน **5%** |
| p95 frame time | เพิ่มขึ้นไม่เกิน **10%** |
| เฟรม > 50 ms | เพิ่มขึ้นไม่เกิน **10%** หรือไม่เกิน 2 เฟรม/10 วิ (ใช้ค่าที่มากกว่า) |
| GPU time ค่ากลาง | เพิ่มขึ้นไม่เกิน **10%** |
| Draw Calls, Triangles | **ต้องเท่าเดิม** — ถ้าต่างต้องมีคำอธิบายรายการต่อรายการและได้รับอนุมัติ (Fortune ไม่ควรต่างเพราะภาพไม่เปลี่ยน) |
| Textures / Geometries / Programs | เท่าเดิม หรือมีคำอธิบาย |
| JS Heap หลังใช้งาน 10 นาที | ไม่เพิ่มต่อเนื่อง (เกณฑ์ Stability เดิม) |
| Console Error | 0 |

ไม่ผ่านข้อใดข้อหนึ่ง = Performance Regression ต้องแก้หรือรายงานก่อนรวม

## 6. ลำดับ Commit ย่อย

1. `src/data/ids.js`, `scope.js`, `coords.js`, asset manifest + Unit (ยังไม่มีผลต่อแอป)
2. `lifecycle.js`, `entities.js`, `spatialData.js`, `ingestAudit.js` + Unit
3. Migration v6 + ฐานข้อมูลแยก + สำรอง/ย้อนกลับ + Migration Test
4. ต่อ engine/normalize/kpi/demo เข้ากติกา lifecycle (Fortune ผลเท่าเดิม)
5. ต่อ 3D/2D/แผงเกจเข้า Service (ลบ `'P-003'`) + ภาพ/พิกัดก่อน–หลัง
6. หน้า "ตั้งค่า": สถานะติดตั้ง + แท็บตำแหน่งที่ต้องตรวจสอบ + ภาพตัวอย่างหมุดใหม่ (ส่งตรวจก่อนรวม)
7. Regression ทั้งหมด + Performance + Preview แยก (Cloudflare Branch Preview ของสาขานี้)

## 7. ประเด็นที่ยังเปิด (ไม่บล็อกการเริ่ม)

- `floorId` เป็น UUID ใน Data Layer แต่ส่วน UI ที่ไม่เกี่ยวกับ Point/Asset (ลิฟต์ คน/รถ ผัง โมเดล) ยังใช้ `floorCode` ภายในรอบนี้ — แปลงผ่าน Service ที่ขอบ เพื่อไม่แตะลิฟต์/Mobility (ห้ามเริ่มพร้อมกัน)
- บทบาทผู้ใช้จริง (Admin/Editor) รอระบบ Access Control — รอบนี้มี `RoleGate` จุดเดียวรองรับ

## 8. การเปลี่ยนแปลงจากฉบับก่อน (ตามคำตัดสิน 18 ต.ค. 2569)

| ข้อ | ฉบับก่อน | ฉบับนี้ |
|---|---|---|
| ID | รหัส `P-003` เป็น ID | UUID ถาวร + `pointCode`/`assetCode` สำหรับแสดงผล · Demo assetCode `FRT-DEMO-*` + `isDemo` |
| ขอบเขต | ไม่มี | organizationId, projectId, buildingId, floorId บนทุก Entity และทุกการค้น |
| Unique | ไม่กำหนด | (projectId, assetCode), (projectId, pointCode) · ไม่มีการค้นด้วยรหัสอย่างเดียว |
| ความสัมพันธ์ | `point.assetId` + `asset.levelPoint/runPoint` | Binding ที่ระบุบทบาท เป็นแหล่งเดียว |
| สถานะไม่ตรงกัน | ไม่ระบุ | Point ตัดสิน · Asset ยับยั้งได้อย่างเดียว · ไม่ตรงกัน → รายการตรวจสอบ |
| ข้อมูลถูกปฏิเสธ | ปฏิเสธที่ normalize | คืนเหตุผล + บันทึก `rejected_ingestion` |
| เวอร์ชัน | ไม่มี | coordinateSystemVersion, floorPlanVersion, modelVersion + resolvedAgainst |
| สำรอง/ย้อนกลับ | ใช้ `?db=` | ฐานข้อมูล `@v6` แยก + สำเนา v5 + ทดสอบย้อนกลับ |
| ค่าเริ่มต้นจุดใหม่ | เสนอ installed | `defaultPointInstallStatus` ใน Project Configuration (Fortune = installed, แพลตฟอร์ม = proposed) |
| รายการตรวจสอบ | ส่วนในหน้า "ตั้งค่า" | แท็บ `ตำแหน่งที่ต้องตรวจสอบ` เฉพาะ Admin/Editor พร้อมคอลัมน์ตามที่กำหนด |

## 9. การเปลี่ยนแปลงในฉบับที่ 3 (ตามคำตัดสิน 19 ต.ค. 2569)

| ข้อ | ฉบับที่ 2 | ฉบับที่ 3 |
|---|---|---|
| UUID v5 | namespace คงที่ + `projectCode:type:code` | namespace ถาวรขององค์กร + Project UUID + Entity Type + Legacy Code |
| เวอร์ชันผัง/โมเดล | แฮชของ URL + ขนาดไฟล์ | SHA-256 ของเนื้อหาไฟล์จาก Build Manifest (ภายหลัง: Revision ID จาก Backend) |
| การจับคู่ Telemetry | `(projectId, sourceKey)` | `(projectId, sourceKey, metricSourceKey)` unique ในจุดที่ใช้งาน · อุปกรณ์เดียวหลายค่า · ซ้ำ = ตั้งค่าไม่ผ่าน · Unit Test ไม่เข้าผิดจุด |
| ความปลอดภัย | กล่าวถึงสั้น ๆ | ข้อ 2.6.1: Scope/RoleGate ฝั่ง Frontend ป้องกันแค่ข้อมูลปนโดยไม่ตั้งใจ · รายการที่ต้องมีก่อน Production |
| Performance | "ไม่ช้ากว่า" | เกณฑ์ตัวเลข ข้อ 5.1 (FPS −5%, p95 +10%, Draw Calls/Triangles เท่าเดิม ฯลฯ) |
