import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { indexConfig } from '../src/domain/config.js';
import { normalizeViewState, viewingFloorId, pointsOnFloor } from '../src/domain/viewState.js';

const c = createDefaultConfig();
const idx = indexConfig(c);
const norm = (st) => normalizeViewState({ viewMode: '3d', isolated: false, selectedId: null, floorId: 'G', ...st }, idx, 'G');

test('ชั้นที่ไม่มีเซนเซอร์: การเลือกจากชั้นอื่นถูกล้าง (เคสชั้น 31 กับ P-007)', () => {
  const st = norm({ isolated: true, floorId: '31', selectedId: 'P-007' });
  assert.equal(st.selectedId, null);
  assert.equal(st.floorId, '31');
  assert.deepEqual(pointsOnFloor(c.points, '31'), []);
});

test('จุดอยู่ชั้นเดียวกับที่ดู → คงการเลือก ทั้ง 3D แยกชั้นและ 2D', () => {
  assert.equal(norm({ isolated: true, floorId: '12', selectedId: 'P-007' }).selectedId, 'P-007');
  assert.equal(norm({ viewMode: '2d', floorId: '12', selectedId: 'P-007' }).selectedId, 'P-007');
  assert.equal(norm({ viewMode: '2d', floorId: '11', selectedId: 'P-007' }).selectedId, null);
});

test('ทั้งอาคาร: เลือกจุดชั้นใดก็ได้', () => {
  assert.equal(viewingFloorId({ isolated: false, viewMode: '3d', floorId: '3' }), null);
  assert.equal(norm({ floorId: '3', selectedId: 'P-007' }).selectedId, 'P-007');
});

test('ทุกชั้น × ทุกจุด: เลือกได้เฉพาะจุดของชั้นนั้น ไม่มีการย้าย/คัดลอกจุด', () => {
  const before = JSON.stringify(c.points);
  for (const f of c.building.floors) {
    for (const p of c.points) {
      for (const mode of [{ isolated: true }, { viewMode: '2d' }]) {
        const st = norm({ ...mode, floorId: f.id, selectedId: p.id });
        assert.equal(st.selectedId, p.floorId === f.id ? p.id : null, `${f.id}/${p.id}`);
      }
    }
  }
  assert.equal(JSON.stringify(c.points), before, 'ข้อมูลจุดไม่ถูกแก้ไข');
});

test('ค่าที่บันทึกไว้เสีย: ชั้นไม่มีอยู่ หรือจุดถูกเก็บถาวร', () => {
  assert.equal(norm({ floorId: 'OF', isolated: true }).floorId, 'G');
  const c2 = structuredClone(c); c2.points[0].status = 'archived';
  const st = normalizeViewState({ viewMode: '3d', isolated: false, floorId: 'G', selectedId: 'WL-001' }, indexConfig(c2), 'G');
  assert.equal(st.selectedId, null);
});
