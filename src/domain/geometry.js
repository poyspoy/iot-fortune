// การแปลงพิกัดผัง 2D (ปกติ 0–1) ↔ พิกัดโมเดล 3D — เป็นการจับคู่เชิงแผนภาพ
// ไม่ใช่การแปลงพิกัดสำรวจจริง (no survey transformation)

export const MARKER_LIFT = 0.28;

/** พิกัดปกติบนผังของชั้น → ตำแหน่ง 3D ภายในกรอบโมเดลของชั้นนั้น */
export function planTo3D(floor, plan, elevationOverride) {
  const m = floor.model;
  const elev = elevationOverride ?? m.elevation;
  return {
    x: m.cx + (plan.x - 0.5) * m.width,
    y: elev + m.height * 0.12 + MARKER_LIFT,
    z: m.cz + (plan.y - 0.5) * m.depth,
  };
}

/** ตำแหน่ง 3D → พิกัดปกติบนผัง (ใช้แสดงหรือแปลงกลับ) */
export function threeDToPlan(floor, pos) {
  const m = floor.model;
  return { x: (pos.x - m.cx) / m.width + 0.5, y: (pos.z - m.cz) / m.depth + 0.5 };
}

export function floorBounds(floor) {
  const m = floor.model;
  return {
    minX: m.cx - m.width / 2, maxX: m.cx + m.width / 2,
    minY: m.elevation, maxY: m.elevation + Math.max(m.height, 0.3) + 1.0,
    minZ: m.cz - m.depth / 2, maxZ: m.cz + m.depth / 2,
  };
}

/** ตรวจพิกัด 3D ที่ผู้ใช้กำหนดเองว่าอยู่ในกรอบของชั้น */
export function validatePos3d(floor, pos) {
  const errors = [];
  if (!pos) return errors;
  for (const k of ['x', 'y', 'z']) {
    if (typeof pos[k] !== 'number' || !Number.isFinite(pos[k])) errors.push(`พิกัด ${k} ต้องเป็นตัวเลข`);
  }
  if (errors.length) return errors;
  const b = floorBounds(floor);
  if (pos.x < b.minX || pos.x > b.maxX) errors.push(`x ต้องอยู่ระหว่าง ${b.minX.toFixed(2)} ถึง ${b.maxX.toFixed(2)}`);
  if (pos.y < b.minY || pos.y > b.maxY) errors.push(`y ต้องอยู่ระหว่าง ${b.minY.toFixed(2)} ถึง ${b.maxY.toFixed(2)}`);
  if (pos.z < b.minZ || pos.z > b.maxZ) errors.push(`z ต้องอยู่ระหว่าง ${b.minZ.toFixed(2)} ถึง ${b.maxZ.toFixed(2)}`);
  return errors;
}

export function validPlanXY(plan) {
  return plan && Number.isFinite(plan.x) && Number.isFinite(plan.y)
    && plan.x >= 0 && plan.x <= 1 && plan.y >= 0 && plan.y <= 1;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** ระดับความสูงของชั้นตามโหมดมุมมอง (exploded = แยกชั้น) */
export function displayElevation(floor, mode, explodeGap = 1.1) {
  const m = floor.model;
  if (mode !== 'exploded' || floor.kind === 'tower') return m.elevation;
  return m.elevation + floor.order * explodeGap;
}

/** ตำแหน่งที่ใช้วาดจุด: ใช้พิกัด 3D ที่กำหนดเองถ้ามี มิฉะนั้นคำนวณจากผัง */
export function pointPosition(point, floor, mode = 'exterior') {
  const elev = displayElevation(floor, mode);
  if (point.pos3d) {
    return { x: point.pos3d.x, y: point.pos3d.y + (elev - floor.model.elevation), z: point.pos3d.z };
  }
  return planTo3D(floor, point.plan, elev);
}

/**
 * มุมมองชั้นเดี่ยว: เลื่อนทั้งชั้น (แผ่นพื้น ผัง อุปกรณ์ หมุด) ไปไว้กลางฐานโมเดลด้วยค่าเลื่อนเดียวกัน
 * หมุดจึงคงตำแหน่งเดิมเมื่อเทียบกับผัง (เป็นการเลื่อนแบบ rigid ไม่ยืด/หมุน)
 * @param {object} floor  @param {{x:number, y:number, z:number}} center  จุดกลางปลายทาง (พิกัดโมเดล)
 * @returns ค่าเลื่อนของกลุ่มชั้น (group position) เมื่ออยู่ในมุมมองเดี่ยว
 */
export function isolatedOffset(floor, center) {
  const m = floor.model;
  return { x: center.x - m.cx, y: center.y, z: center.z - m.cz };
}

/** ค่าเลื่อนของกลุ่มชั้นเมื่อประกอบเป็นอาคาร */
export function assembledOffset(floor, mode = 'exterior') {
  return { x: 0, y: displayElevation(floor, mode), z: 0 };
}

/** ตำแหน่งหมุดในพิกัดโมเดล เมื่อกลุ่มชั้นถูกเลื่อนด้วย offset (กลุ่มสร้างที่ y = 0 ของชั้น) */
export function markerPosition(point, floor, offset) {
  const pos = pointPosition(point, floor, 'exterior'); // พิกัดอาคาร ณ ระดับชั้นจริง
  return { x: pos.x + offset.x, y: pos.y - floor.model.elevation + offset.y, z: pos.z + offset.z };
}
