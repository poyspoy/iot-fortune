// กติกาเดียวของ "ชั้นที่กำลังดู" กับ "จุดที่เลือก" (ไม่พึ่ง DOM — ทดสอบได้ใน Node)
//  - มุมมองชั้นเดียว = แยกชั้นใน 3D (isolated) หรือผัง 2D → ชั้นที่กำลังดู = floorId
//  - จุดที่เลือกต้องอยู่บนชั้นที่กำลังดู มิฉะนั้นล้างการเลือก
//  - จุดที่ถูกเก็บถาวร/ไม่มีอยู่ ถูกล้างการเลือก
//  - ไม่มีการย้ายหรือคัดลอกจุด: ชั้นของจุดมาจากการตั้งค่าเท่านั้น

export function viewingFloorId(st) {
  return st.isolated || st.viewMode === '2d' ? st.floorId : null;
}

/** @param {{ floors: Map<string, any>, points: Map<string, any> }} index */
export function normalizeViewState(st, index, fallbackFloorId) {
  const next = { ...st };
  if (!index.floors.get(next.floorId)) next.floorId = fallbackFloorId;
  const sel = next.selectedId ? index.points.get(next.selectedId) : null;
  if (next.selectedId && (!sel || sel.status !== 'active')) next.selectedId = null;
  const vf = viewingFloorId(next);
  if (sel && vf && sel.floorId !== vf) next.selectedId = null;
  return next;
}

/** จุดที่ควรแสดง (หมุด/รายการ) บนชั้นที่กำลังดู */
export function pointsOnFloor(points, floorId) {
  return points.filter((p) => p.status === 'active' && p.floorId === floorId);
}
