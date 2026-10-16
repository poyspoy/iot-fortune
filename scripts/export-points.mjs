// ส่งออกจุดตรวจวัดที่ติดตาม พร้อมพิกัดในโมเดล Blender ของผู้ใช้ (ใช้วางหมุดบนภาพเรนเดอร์)
//   node scripts/export-points.mjs > build/points.json
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { planToBlender } from '../src/domain/geometry.js';

const c = createDefaultConfig();
const floors = Object.fromEntries(c.building.floors.map((f) => [f.id, f]));
const active = c.points.filter((p) => p.status === 'active').sort((a, b) => a.id.localeCompare(b.id));
const out = active.map((p, i) => {
  const f = floors[p.floorId];
  return {
    number: i + 1, id: p.id, name: p.name, floorId: p.floorId, floorName: f.name, plan: p.plan, example: !!p.example,
    blender: f.detail ? planToBlender(f.detail, p.plan) : null,
  };
});
process.stdout.write(JSON.stringify({ floors: Object.fromEntries(Object.entries(floors).map(([k, f]) => [k, f.detail ?? null])), points: out }, null, 1));
