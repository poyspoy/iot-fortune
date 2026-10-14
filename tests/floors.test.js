import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig, TOWER_FIRST, TOWER_LAST } from '../src/domain/defaultConfig.js';
import { validateConfig } from '../src/domain/config.js';
import { migrateConfig } from '../src/domain/migrate.js';
import { validateBackup, makeBackup } from '../src/domain/backup.js';
import { isolatedOffset, assembledOffset, markerPosition, threeDToPlan, planTo3D } from '../src/domain/geometry.js';
import { sampleId } from '../src/domain/normalize.js';

test('สำนักงานแยกเป็นชั้น 11–31 รายชั้น ใช้ผังอ้างอิงร่วม', () => {
  const c = createDefaultConfig();
  const tower = c.building.floors.filter((f) => f.kind === 'tower');
  assert.equal(tower.length, TOWER_LAST - TOWER_FIRST + 1);
  assert.deepEqual(tower.map((f) => f.id), Array.from({ length: 21 }, (_, i) => String(11 + i)));
  assert.ok(tower.every((f) => f.plan.shared && f.plan.src === tower[0].plan.src), 'ทุกชั้นใช้ภาพผังเดียวกันและระบุว่าเป็นผังอ้างอิงร่วม');
  const elev = tower.map((f) => f.model.elevation);
  assert.ok(elev.every((e, i) => i === 0 || e > elev[i - 1]), 'ชั้นสูงขึ้นตามลำดับ');
  assert.equal(c.building.floors.some((f) => f.id === 'OF'), false);
});

test('จุดตัวอย่างไม่ถูกคัดลอกไปทุกชั้นสำนักงาน', () => {
  const c = createDefaultConfig();
  const towerPts = c.points.filter((p) => Number(p.floorId) >= 11);
  assert.deepEqual(towerPts.map((p) => [p.id, p.floorId]), [['P-004', '11'], ['P-007', '12']]);
  assert.equal(c.points.length, 8);
  assert.deepEqual(validateConfig(c).errors, []);
});

function v1Config() {
  const c = createDefaultConfig();
  c.schemaVersion = 1;
  const tower = c.building.floors.filter((f) => f.kind === 'tower');
  c.building.floors = [...c.building.floors.filter((f) => f.kind !== 'tower'), { ...tower[0], id: 'OF', name: 'สำนักงาน ชั้น 11–31 (ผังทั่วไป)' }];
  c.building.areas = [...c.building.areas.filter((a) => Number.isNaN(Number(a.floorId.split('-')[0])) || Number(a.floorId) < 11),
    { id: 'OF-AHU', floorId: 'OF', name: 'AHU', kind: 'plant' }, { id: 'OF-ELEC', floorId: 'OF', name: 'ELEC', kind: 'electrical' }];
  c.building.areas = c.building.areas.filter((a) => !/^\d+$/.test(a.floorId) || Number(a.floorId) < 11);
  for (const p of c.points) {
    if (p.id === 'P-004') { p.floorId = 'OF'; p.areaId = 'OF-AHU'; }
    if (p.id === 'P-007') { p.floorId = 'OF'; p.areaId = 'OF-ELEC'; p.pos3d = { x: -5, y: 6, z: -4 }; }
  }
  c.points.push({ ...structuredClone(c.points[0]), id: 'P-100', sourceKey: 'P-100', floorId: 'OF', areaId: 'OF-AHU' });
  return c;
}

test('ย้ายการตั้งค่ารุ่น 1 (ชั้น OF เดียว) เป็นชั้นแยก', () => {
  const old = v1Config();
  const m = migrateConfig(old);
  assert.equal(m.schemaVersion, 2);
  assert.deepEqual(validateConfig(m).errors, []);
  const byId = Object.fromEntries(m.points.map((p) => [p.id, p]));
  assert.equal(byId['P-004'].floorId, '11');
  assert.equal(byId['P-004'].areaId, '11-AHU');
  assert.equal(byId['P-007'].floorId, '12');
  assert.equal(byId['P-007'].pos3d, null, 'พิกัด 3D เดิมใช้ไม่ได้กับกรอบใหม่');
  assert.equal(byId['P-100'].floorId, '11', 'จุดอื่นไปชั้น 11 ชั้นเดียว ไม่คัดลอก');
  assert.equal(old.schemaVersion, 1, 'ไม่แก้ของเดิม');
});

test('ไฟล์สำรองรุ่น 1 นำเข้าได้ ค่าวัดเดิมใช้ต่อได้', () => {
  const at = Date.parse('2026-10-14T00:00:00Z');
  const s = { id: sampleId('demo', 'P-004', 'chws', at), source: 'demo', pointId: 'P-004', metricId: 'chws', value: 7, unit: '°C', quality: 'good', observedAt: at, receivedAt: at, sequence: 1 };
  const b = { ...makeBackup({ config: v1Config(), samples: [s], episodes: [], exportedAt: at }), schemaVersion: 1 };
  const v = validateBackup(JSON.parse(JSON.stringify(b)));
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.equal(v.summary.migratedFrom, 1);
  assert.equal(v.data.config.schemaVersion, 2);
});

test('มุมมองชั้นเดี่ยว: หมุดคงตำแหน่งเดิมเมื่อเทียบกับผังทุกชั้น', () => {
  const c = createDefaultConfig();
  const center = { x: -0.3, y: 0.02, z: -2.1 };
  for (const f of c.building.floors) {
    const iso = isolatedOffset(f, center);
    const asm = assembledOffset(f);
    for (const plan of [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.93, y: 0.77 }]) {
      const point = { plan, pos3d: null };
      const a = markerPosition(point, f, asm);
      const b = markerPosition(point, f, iso);
      // ย้อนค่าเลื่อนแล้วต้องได้พิกัดผังเดิม
      const back = threeDToPlan(f, { x: b.x - iso.x, z: b.z - iso.z });
      assert.ok(Math.abs(back.x - plan.x) < 1e-9 && Math.abs(back.y - plan.y) < 1e-9, `ชั้น ${f.id}`);
      // ระยะระหว่างหมุดกับขอบแผ่นพื้นเท่าเดิม (เลื่อนแบบ rigid)
      assert.ok(Math.abs((b.x - iso.x) - (a.x - asm.x)) < 1e-9 && Math.abs((b.y - iso.y) - (a.y - asm.y)) < 1e-9);
      // ในมุมมองเดี่ยว ศูนย์กลางชั้นอยู่ตรงกลางฐาน
      const mid = planTo3D(f, { x: 0.5, y: 0.5 });
      assert.ok(Math.abs(mid.x + iso.x - center.x) < 1e-9 && Math.abs(mid.z + iso.z - center.z) < 1e-9);
    }
  }
});
