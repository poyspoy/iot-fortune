// ระบบพิกัดกลาง (Building CRS) และเวอร์ชันของผัง/โมเดล
//
// Building CRS: x ขวา, z ใต้ (ตามผัง), y ขึ้น · หน่วย = หน่วยโมเดลของแอป
// (เป็นการจับคู่เชิงแผนภาพเหมือนเดิม ไม่ใช่พิกัดสำรวจจริง)
//
// FloorFrame: แปลงพิกัดผังปกติ (u ขวา, v ลง; 0–1) ↔ (x, z) ด้วย affine2d [a, b, c, d, e, f]
//   x = a·u + b·v + c ,  z = d·u + e·v + f
// Fortune สร้างจาก floor.model เดิม → ผลเท่ากับ planTo3D / threeDToPlan เดิมทุกตัว (มี Unit Test)

export const COORDINATE_SYSTEM = Object.freeze({ version: 'crs-1', axes: 'x-right,z-south,y-up', unit: 'model-unit' });

/** ค่าเดียวกับ geometry.js (หมุดลอยเหนือผนังตัดของโมเดล) — แยกไว้เพื่อไม่ให้พึ่งกันเป็นวง */
export const MARKER_LIFT = 0.4;
const MARKER_BASE = 0.12; // สัดส่วนความสูงชั้นที่ฐานหมุด (ตาม planTo3D เดิม)

/** สร้าง affine จากกรอบโมเดลของชั้น (ไม่หมุน ไม่เฉือน) */
export function affineFromModel(model) {
  return Object.freeze([model.width, 0, model.cx - model.width / 2, 0, model.depth, model.cz - model.depth / 2]);
}

/**
 * FloorFrame ของชั้น
 * @param {object} floor  ชั้นตามการตั้งค่า (มี model, plan, detail)
 * @param {{ floorPlanVersion?: string|null, modelVersion?: string|null }} versions
 */
export function floorFrame(floor, versions = {}) {
  const m = floor.model;
  return Object.freeze({
    floorCode: floor.id,
    transform: affineFromModel(m),
    elevation: m.elevation,
    height: m.height,
    coordinateSystemVersion: COORDINATE_SYSTEM.version,
    floorPlanVersion: versions.floorPlanVersion ?? null,
    modelVersion: versions.modelVersion ?? null,
  });
}

/** พิกัดผัง (u, v) → (x, z) ใน Building CRS */
export function planToBuilding(frame, { u, v }) {
  const [a, b, c, d, e, f] = frame.transform;
  return { x: a * u + b * v + c, z: d * u + e * v + f };
}

/** (x, z) → พิกัดผัง (u, v) — อินเวอร์สของ affine ทั่วไป */
export function buildingToPlan(frame, { x, z }) {
  const [a, b, c, d, e, f] = frame.transform;
  const det = a * e - b * d;
  if (!det) throw new RangeError('affine ของชั้นนี้กลับค่าไม่ได้ (det = 0)');
  const dx = x - c; const dz = z - f;
  return { u: (e * dx - b * dz) / det, v: (a * dz - d * dx) / det };
}

/** ตำแหน่งหมุดบนผัง → ตำแหน่ง 3D (เท่ากับ planTo3D เดิม) — elevation ใช้ระดับจริงของชั้นถ้าไม่กำหนด */
export function planToMarker3D(frame, plan, elevationOverride) {
  const p = planToBuilding(frame, plan);
  const elev = elevationOverride ?? frame.elevation;
  return { x: p.x, y: elev + frame.height * MARKER_BASE + MARKER_LIFT, z: p.z };
}

// ---------------------------------------------------------------- เวอร์ชันจากเนื้อหาไฟล์

/**
 * เวอร์ชันของผังและโมเดลจาก asset manifest (SHA-256 ของเนื้อหาไฟล์ — ไม่ใช่ชื่อหรือขนาด)
 * modelVersion = โมเดลรายละเอียดของชั้น (+ ข้อมูลห้อง) ถ้ามี มิฉะนั้นโมเดลแบบเบาของอาคาร
 * ไฟล์ที่ไม่อยู่ใน manifest → null (ถือว่า "ไม่ทราบเวอร์ชัน" ไม่ใช่ "เปลี่ยน")
 */
export function floorVersions(floor, manifest, { lightModel = 'models/fortune.glb' } = {}) {
  const files = manifest?.files ?? {};
  const h = (path) => (path && files[path] ? `sha256:${files[path]}` : null);
  const plan = h(floor.plan?.src);
  let model;
  if (floor.detail?.src) {
    const glb = h(floor.detail.src);
    const rooms = h(floor.detail.src.replace(/floor-([^/]+)\.glb$/, 'rooms-$1.json'));
    model = glb ? (rooms ? `${glb}+${rooms}` : glb) : null;
  } else {
    model = h(lightModel);
  }
  return { floorPlanVersion: plan, modelVersion: model };
}

export const REMAP_REASONS = Object.freeze({
  'crs-changed': 'ระบบพิกัดอาคารเปลี่ยน',
  'plan-changed': 'ผังชั้นเปลี่ยน',
  'model-changed': 'โมเดลเปลี่ยน',
});

/**
 * ตรวจว่าจุด/อุปกรณ์ต้องตรวจตำแหน่งใหม่หรือไม่
 * @param {{ coordinateSystemVersion?: string|null, floorPlanVersion?: string|null, modelVersion?: string|null }|null} resolvedAgainst  เวอร์ชันตอนวางตำแหน่ง
 * @param {{ coordinateSystemVersion: string, floorPlanVersion: string|null, modelVersion: string|null }} current  เวอร์ชันปัจจุบันของชั้น
 * @returns {{ needsRemapping: boolean, reasons: string[] }}
 *   เปรียบเทียบเฉพาะค่าที่รู้ทั้งสองฝั่ง (null = ไม่ทราบ ไม่ตัดสินว่าเปลี่ยน)
 */
export function remapCheck(resolvedAgainst, current) {
  const reasons = [];
  if (!resolvedAgainst) return { needsRemapping: false, reasons };
  const diff = (k) => resolvedAgainst[k] != null && current[k] != null && resolvedAgainst[k] !== current[k];
  if (diff('coordinateSystemVersion')) reasons.push('crs-changed');
  if (diff('floorPlanVersion')) reasons.push('plan-changed');
  if (diff('modelVersion')) reasons.push('model-changed');
  return { needsRemapping: reasons.length > 0, reasons };
}
