// ส่งออกรูปทรงชั้นจากการตั้งค่าเริ่มต้นเป็น JSON ให้สคริปต์ Blender ใช้ (แหล่งข้อมูลเดียวกับแอป)
//   node scripts/export-geometry.mjs > build/geometry.json
import { createDefaultConfig } from '../src/domain/defaultConfig.js';

const c = createDefaultConfig();
const floors = c.building.floors.map((f) => ({
  id: f.id, name: f.name, kind: f.kind, order: f.order,
  footprint: f.footprint, model: f.model, plan: f.plan,
}));
process.stdout.write(JSON.stringify({ schemaVersion: c.schemaVersion, floors }, null, 1));
