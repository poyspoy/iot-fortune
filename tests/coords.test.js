import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { planTo3D, threeDToPlan, MARKER_LIFT as GEO_LIFT } from '../src/domain/geometry.js';
import { floorFrame, planToBuilding, buildingToPlan, planToMarker3D, floorVersions, remapCheck, COORDINATE_SYSTEM, MARKER_LIFT } from '../src/data/coords.js';
import { buildManifest } from '../scripts/build-asset-manifest.mjs';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EPS = 1e-12;
const cfg = createDefaultConfig();
const SAMPLES = [[0, 0], [1, 1], [0.5, 0.5], [0.12, 0.87], [0.88, 0.86], [0.349, 0.16], [0.999, 0.001]];

test('ค่าคงที่หมุดตรงกับ geometry.js เดิม', () => {
  assert.equal(MARKER_LIFT, GEO_LIFT);
});

test('FloorFrame ของทุก 28 ชั้น ให้ตำแหน่ง 3D เท่ากับ planTo3D เดิม (≤ 1e-12) รวมจุด Fortune ทั้ง 8 จุด', () => {
  assert.equal(cfg.building.floors.length, 28);
  let n = 0;
  for (const f of cfg.building.floors) {
    const fr = floorFrame(f);
    const pts = [...SAMPLES.map(([x, y]) => ({ x, y })), ...cfg.points.filter((p) => p.floorId === f.id).map((p) => p.plan)];
    for (const pl of pts) {
      const old = planTo3D(f, pl);
      const neu = planToMarker3D(fr, { u: pl.x, v: pl.y });
      for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(old[k] - neu[k]) <= EPS, `${f.id} ${k} ${old[k]} vs ${neu[k]}`);
      const oldE = planTo3D(f, pl, 7.25); const neuE = planToMarker3D(fr, { u: pl.x, v: pl.y }, 7.25);
      for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(oldE[k] - neuE[k]) <= EPS);
      n++;
    }
  }
  assert.ok(n >= 28 * SAMPLES.length + 8);
});

test('แปลงกลับ 3D → ผัง เท่ากับ threeDToPlan เดิม และไป–กลับได้ค่าเดิม', () => {
  for (const f of cfg.building.floors) {
    const fr = floorFrame(f);
    for (const [u, v] of SAMPLES) {
      const p = planToBuilding(fr, { u, v });
      const back = buildingToPlan(fr, p);
      assert.ok(Math.abs(back.u - u) <= EPS && Math.abs(back.v - v) <= EPS, `${f.id} round trip`);
      const old = threeDToPlan(f, { x: p.x, z: p.z });
      assert.ok(Math.abs(old.x - back.u) <= EPS && Math.abs(old.y - back.v) <= EPS);
    }
  }
});

test('affine ทั่วไป (หมุน/เฉือน) แปลงไป–กลับได้ และ det = 0 ถูกปฏิเสธ', () => {
  const fr = { transform: [3, 1, 2, -1, 2, 5] };
  const p = planToBuilding(fr, { u: 0.3, v: 0.7 });
  const b = buildingToPlan(fr, p);
  assert.ok(Math.abs(b.u - 0.3) < EPS && Math.abs(b.v - 0.7) < EPS);
  assert.throws(() => buildingToPlan({ transform: [1, 2, 0, 2, 4, 0] }, { x: 1, z: 1 }), /det/);
});

test('FloorFrame แก้ไขไม่ได้ และมีเวอร์ชันระบบพิกัด', () => {
  const fr = floorFrame(cfg.building.floors[0]);
  assert.ok(Object.isFrozen(fr) && Object.isFrozen(fr.transform));
  assert.equal(fr.coordinateSystemVersion, COORDINATE_SYSTEM.version);
});

test('asset-manifest.json ในคลังตรงกับไฟล์จริง (SHA-256)', () => {
  const committed = JSON.parse(readFileSync('public/asset-manifest.json', 'utf8'));
  assert.deepEqual(committed, buildManifest('public'));
  for (const f of cfg.building.floors) {
    const v = floorVersions(f, committed);
    assert.match(v.floorPlanVersion, /^sha256:[0-9a-f]{64}$/, `${f.id} plan`);
    assert.match(v.modelVersion, /^sha256:[0-9a-f]{64}/, `${f.id} model`);
  }
});

test('ไฟล์ชื่อเดิม ขนาดเท่าเดิม แต่เนื้อหาต่าง → เวอร์ชันต่าง → ต้องตรวจตำแหน่งใหม่', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-'));
  mkdirSync(join(dir, 'plans')); mkdirSync(join(dir, 'models', 'floors'), { recursive: true });
  writeFileSync(join(dir, 'plans', 'floor-G.webp'), 'AAAA');
  writeFileSync(join(dir, 'models', 'floors', 'floor-G.glb'), 'BBBB');
  const m1 = buildManifest(dir);
  writeFileSync(join(dir, 'plans', 'floor-G.webp'), 'AAAB'); // ขนาดเท่าเดิม
  const m2 = buildManifest(dir);
  const floor = { id: 'G', plan: { src: 'plans/floor-G.webp' }, detail: { src: 'models/floors/floor-G.glb' } };
  const v1 = floorVersions(floor, m1); const v2 = floorVersions(floor, m2);
  assert.notEqual(v1.floorPlanVersion, v2.floorPlanVersion);
  assert.equal(v1.modelVersion, v2.modelVersion);
  const r = remapCheck({ coordinateSystemVersion: 'crs-1', ...v1 }, { coordinateSystemVersion: 'crs-1', ...v2 });
  assert.deepEqual(r, { needsRemapping: true, reasons: ['plan-changed'] });
});

test('remapCheck: แยกเหตุผล crs/plan/model · ไม่ทราบเวอร์ชัน (null) ไม่ถือว่าเปลี่ยน · ยังไม่เคยวาง = ไม่ต้องตรวจ', () => {
  const cur = { coordinateSystemVersion: 'crs-2', floorPlanVersion: 'sha256:a', modelVersion: 'sha256:m2' };
  assert.deepEqual(remapCheck({ coordinateSystemVersion: 'crs-1', floorPlanVersion: 'sha256:a', modelVersion: 'sha256:m1' }, cur).reasons, ['crs-changed', 'model-changed']);
  assert.equal(remapCheck({ coordinateSystemVersion: 'crs-2', floorPlanVersion: null, modelVersion: 'sha256:m2' }, cur).needsRemapping, false);
  assert.equal(remapCheck(null, cur).needsRemapping, false);
  assert.equal(remapCheck({ ...cur }, cur).needsRemapping, false);
});

test('ชั้นที่ไม่มีโมเดลรายละเอียดใช้เวอร์ชันโมเดลแบบเบา · ไฟล์ไม่อยู่ใน manifest = null', () => {
  const m = { files: { 'models/fortune.glb': 'f'.repeat(64), 'plans/p.webp': 'a'.repeat(64) } };
  assert.deepEqual(floorVersions({ plan: { src: 'plans/p.webp' } }, m), { floorPlanVersion: `sha256:${'a'.repeat(64)}`, modelVersion: `sha256:${'f'.repeat(64)}` });
  assert.deepEqual(floorVersions({ plan: { src: 'plans/x.webp' }, detail: { src: 'models/floors/floor-9.glb' } }, m), { floorPlanVersion: null, modelVersion: null });
});
