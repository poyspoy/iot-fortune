import { SCHEMA_VERSION } from './constants.js';
import { createDefaultConfig } from './defaultConfig.js';

/**
 * ย้ายการตั้งค่ารุ่นเก่าให้เป็นรุ่นปัจจุบัน (คืนสำเนาใหม่ ไม่แก้ของเดิม)
 * v1 → v2: ชั้นสำนักงานเดียว "OF" (ผังทั่วไป 11–31) ถูกแยกเป็นชั้น 11 … 31
 *   - จุดบน OF ที่มีในค่าเริ่มต้นย้ายไปชั้นตามค่าเริ่มต้น (P-004 → 11, P-007 → 12)
 *   - จุดอื่นบน OF ย้ายไปชั้น 11 (ไม่คัดลอกไปทุกชั้น) และล้างพิกัด 3D ที่กำหนดเอง เพราะกรอบโมเดลเปลี่ยน
 *   - ประวัติค่าวัดและเหตุการณ์อ้างถึงรหัสจุด/ค่าวัดเท่านั้น จึงใช้ต่อได้โดยไม่ต้องแก้
 */
export function migrateConfig(config) {
  if (!config || typeof config !== 'object') return config;
  if (config.schemaVersion === SCHEMA_VERSION) return config;
  if (![1, 2, 3, 4].includes(config.schemaVersion)) return config; // ไม่รู้จัก — ให้การตรวจรายงานข้อผิดพลาด
  const out = structuredClone(config);
  const def = createDefaultConfig();
  const towerFloors = def.building.floors.filter((f) => f.kind === 'tower');
  const towerIds = new Set(towerFloors.map((f) => f.id));
  // v1 → v2: ชั้น OF เดียว → แยกรายชั้น
  const hasOF = out.building?.floors?.some((f) => f.id === 'OF');
  if (hasOF) {
    out.building.floors = out.building.floors.filter((f) => f.id !== 'OF');
    out.building.areas = out.building.areas.filter((a) => a.floorId !== 'OF');
    for (const p of out.points ?? []) {
      if (p.floorId !== 'OF') continue;
      const d = def.points.find((x) => x.id === p.id);
      const fid = d && towerIds.has(d.floorId) ? d.floorId : '11';
      const suffix = typeof p.areaId === 'string' && p.areaId.startsWith('OF-') ? p.areaId.slice(3) : 'OFFICE';
      p.floorId = fid;
      p.areaId = def.building.areas.some((a) => a.id === `${fid}-${suffix}`) ? `${fid}-${suffix}` : `${fid}-OFFICE`;
      p.pos3d = null;
    }
  }
  // v2 → v3: ชั้นสำนักงานครบ 11–32 และรูปทรงทาวเวอร์ตามผัง (คงค่าที่ผู้ใช้แก้ไว้ของชั้นเดิม ยกเว้นรูปทรง)
  const existing = new Map(out.building.floors.map((f) => [f.id, f]));
  for (const tf of towerFloors) {
    const cur = existing.get(tf.id);
    if (!cur) out.building.floors.push(structuredClone(tf));
    else if (cur.kind === 'tower') { cur.footprint = tf.footprint; cur.plan = { ...tf.plan, ...cur.plan, note: tf.plan.note, sharedLabel: tf.plan.sharedLabel }; }
  }
  out.building.floors.sort((a, b) => a.order - b.order);
  const areaIds = new Set(out.building.areas.map((a) => a.id));
  for (const a of def.building.areas) if (towerIds.has(a.floorId) && !areaIds.has(a.id)) out.building.areas.push(structuredClone(a));
  // v3 → v4: เพิ่มโมเดลรายชั้นของผู้ใช้ และความลึกชั้น 4/5 ตามสัดส่วนภาพผัง (รูปทรง/จุดเดิมไม่เปลี่ยน)
  const defFloors = new Map(def.building.floors.map((f) => [f.id, f]));
  for (const f of out.building.floors) {
    const d = defFloors.get(f.id);
    if (!d) continue;
    if (d.detail) f.detail = structuredClone(d.detail); else delete f.detail;
    if (['4', '5'].includes(f.id) && f.model && d.model) f.model.depth = d.model.depth;
    if (f.id === '4' && d.plan) f.plan.note = d.plan.note;
  }
  // v4 → v5: จุดระดับน้ำตัวอย่าง P-001/P-002 → WL-001/WL-002 (รหัสใหม่สำหรับสาธิต) — ย้ายรหัสในจุดและกฎ ไม่สร้างจุดซ้ำ
  const RENAME = { 'P-001': 'WL-001', 'P-002': 'WL-002' };
  for (const [from, to] of Object.entries(RENAME)) {
    const p = out.points?.find((x) => x.id === from);
    if (!p || out.points.some((x) => x.id === to)) continue;
    const d = def.points.find((x) => x.id === to);
    p.id = to;
    if (p.sourceKey === from) p.sourceKey = to;
    if (d && /\(ตัวอย่าง\)$/.test(p.name ?? '')) p.name = d.name;
    for (const m of p.metrics ?? []) { const dm = d?.metrics.find((x) => x.id === m.id); if (dm?.gauge && !m.gauge) m.gauge = { ...dm.gauge }; }
    for (const r of out.rules ?? []) if (r.pointId === from) r.pointId = to;
  }
  out.building.towerNote = def.building.towerNote;
  if (!out.building.modelSrc) out.building.modelSrc = def.building.modelSrc;
  out.schemaVersion = SCHEMA_VERSION;
  return out;
}
