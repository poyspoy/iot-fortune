import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig, TOWER_FIRST, TOWER_LAST } from '../src/domain/defaultConfig.js';
import { validateConfig } from '../src/domain/config.js';
import { migrateConfig } from '../src/domain/migrate.js';
import { validateBackup, makeBackup } from '../src/domain/backup.js';
import { isolatedOffset, assembledOffset, markerPosition, threeDToPlan, planTo3D } from '../src/domain/geometry.js';
import { sampleId } from '../src/domain/normalize.js';

test('สำนักงานแยกเป็นชั้น 11–32 รายชั้น ใช้ผังอ้างอิงร่วม', () => {
  const c = createDefaultConfig();
  const tower = c.building.floors.filter((f) => f.kind === 'tower');
  assert.equal(tower.length, TOWER_LAST - TOWER_FIRST + 1);
  assert.deepEqual(tower.map((f) => f.id), Array.from({ length: 22 }, (_, i) => String(11 + i)));
  assert.match(tower.at(-1).plan.note, /ยังไม่ได้รับผังชั้น 32/);
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
  assert.equal(m.schemaVersion, 5);
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
  assert.equal(v.data.config.schemaVersion, 5);
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

test('ย้ายการตั้งค่ารุ่น 2 (ชั้น 11–31) → เพิ่มชั้น 32 และรูปทรงทาวเวอร์ โดยคงจุดและการแก้ไขเดิม', () => {
  const c = createDefaultConfig();
  c.schemaVersion = 2;
  c.building.floors = c.building.floors.filter((f) => f.id !== '32').map((f) => (f.kind === 'tower' ? { ...f, footprint: [[0.004, 0.03], [0.996, 0.03], [0.996, 0.97], [0.004, 0.97]] } : f));
  c.building.areas = c.building.areas.filter((a) => a.floorId !== '32');
  c.points.find((p) => p.id === 'P-007').name = 'ชื่อที่ผู้ใช้แก้';
  const m = migrateConfig(c);
  assert.deepEqual(validateConfig(m).errors, []);
  assert.ok(m.building.floors.some((f) => f.id === '32'));
  assert.equal(m.building.floors.at(-1).id, '32');
  assert.ok(m.building.floors.find((f) => f.id === '20').footprint.length > 10, 'รูปทรงมุมโค้งตามผัง');
  assert.equal(m.points.find((p) => p.id === 'P-007').name, 'ชื่อที่ผู้ใช้แก้');
  assert.equal(m.points.length, 8);
});

import { detailFrame, detailTransform, planToBlender } from '../src/domain/geometry.js';

test('โมเดล Blender ของผู้ใช้: สูตรพิกัดตรงกับสคริปต์ต้นฉบับ (ห้างและสำนักงาน)', () => {
  const c = createDefaultConfig();
  const G = c.building.floors.find((f) => f.id === 'G');
  // จุดภาพต้นฉบับ (sx, sy) = (1000·5966/2000, 336.5·2009/673) ต้องได้ X = Y = 0 ตาม coord() ของ build_floors.py
  const u = (1000 * 5966 / 2000 - 250) / 5510; const v = (336.5 * 2009 / 673 - 380) / 950;
  const b = planToBlender(G.detail, { x: u, y: v });
  assert.ok(Math.abs(b.X) < 1e-9 && Math.abs(b.Y) < 1e-9);
  const O = c.building.floors.find((f) => f.id === '11');
  // op(770, 460) → X = Y = 0 ตาม build_office.py
  const bo = planToBlender(O.detail, { x: (770 - 95) / 1360, y: (460 - 180) / 555 });
  assert.ok(Math.abs(bo.X) < 1e-9 && Math.abs(bo.Y) < 1e-9);
});

test('โมเดล Blender ทุกชั้นวางตรงกับผังของแอป (ทุกจุด u,v) และไม่ยืดผิดสัดส่วน', () => {
  const c = createDefaultConfig();
  const withDetail = c.building.floors.filter((f) => f.detail);
  assert.deepEqual(withDetail.map((f) => f.id), ['G', '1', '2', '3', '4', '5', ...Array.from({ length: 21 }, (_, i) => String(11 + i))]);
  assert.equal(c.building.floors.find((f) => f.id === '32').detail, undefined, 'ชั้น 32 ยังไม่มีโมเดลของผู้ใช้');
  for (const f of withDetail) {
    const t = detailTransform(f);
    const fr = detailFrame(f.detail);
    for (const p of [{ x: 0, y: 0 }, { x: 0.37, y: 0.81 }, { x: 1, y: 1 }]) {
      const x = (fr.ax * p.x + fr.bx) * t.scale.x + t.position.x;
      const z = (fr.az * p.y + fr.bz) * t.scale.z + t.position.z;
      const app = planTo3D(f, p);
      assert.ok(Math.abs(x - app.x) < 1e-9 && Math.abs(z - app.z) < 1e-9, `ชั้น ${f.id}`);
    }
    assert.ok(Math.abs(t.scale.x / t.scale.z - 1) < 0.005, `ชั้น ${f.id} สเกล x/z ${t.scale.x / t.scale.z}`);
  }
});

test('v4 → v5: จุด P-001/P-002 เดิมเปลี่ยนเป็น WL-001/WL-002 พร้อมกฎ ไม่สร้างจุดซ้ำ', async () => {
  const { migrateConfig } = await import('../src/domain/migrate.js');
  const c = createDefaultConfig();
  c.schemaVersion = 4;
  for (const p of c.points) if (p.id.startsWith('WL-')) { const old = p.id === 'WL-001' ? 'P-001' : 'P-002'; p.id = old; p.sourceKey = old; p.name = p.id === 'P-001' ? 'บ่อสูบน้ำ (ตัวอย่าง)' : 'ถังเก็บน้ำ (ตัวอย่าง)'; }
  for (const r of c.rules) if (r.pointId === 'WL-001') r.pointId = 'P-001'; else if (r.pointId === 'WL-002') r.pointId = 'P-002';
  const m = migrateConfig(c);
  assert.equal(m.schemaVersion, 5);
  assert.deepEqual(m.points.filter((p) => /^(P-00[12]|WL-)/.test(p.id)).map((p) => [p.id, p.name]), [['WL-001', 'ระดับน้ำบ่อสูบน้ำ'], ['WL-002', 'ระดับน้ำถังเก็บน้ำ']]);
  assert.ok(m.rules.some((r) => r.pointId === 'WL-001') && !m.rules.some((r) => r.pointId === 'P-001'));
});
