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
  if (config.schemaVersion !== 1) return config; // ไม่รู้จัก — ให้การตรวจรายงานข้อผิดพลาด
  const out = structuredClone(config);
  const def = createDefaultConfig();
  const towerFloors = def.building.floors.filter((f) => f.kind === 'tower');
  const towerIds = new Set(towerFloors.map((f) => f.id));
  const hasOF = out.building?.floors?.some((f) => f.id === 'OF');
  if (hasOF) {
    out.building.floors = [...out.building.floors.filter((f) => f.id !== 'OF' && !towerIds.has(f.id)), ...towerFloors];
    out.building.areas = [...out.building.areas.filter((a) => a.floorId !== 'OF' && !towerIds.has(a.floorId)), ...def.building.areas.filter((a) => towerIds.has(a.floorId))];
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
  if (def.building.towerNote && !out.building.towerNote) out.building.towerNote = def.building.towerNote;
  out.schemaVersion = SCHEMA_VERSION;
  return out;
}
