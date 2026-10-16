import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEngineering, featureInfo, soloVisibility, layerSummary, ENG_DISCLAIMER } from '../src/domain/engineering.js';

const raw = JSON.parse(readFileSync(new URL('../public/engineering/floor-G.json', import.meta.url)));

test('ข้อมูลแบบวิศวกรรมชั้น G ผ่านการตรวจ และมี 3 เลเยอร์', () => {
  const r = parseEngineering(raw);
  assert.deepEqual(r.errors, []);
  assert.equal(r.data.floorId, 'G');
  assert.deepEqual(r.data.layers.map((l) => l.id), ['structure', 'electrical', 'plumbing']);
  assert.equal(r.data.disclaimer, ENG_DISCLAIMER);
  assert.ok(r.data.simulated);
  for (const l of r.data.layers) assert.ok(l.features.length > 5, l.id);
  const kinds = new Set(r.data.layers.flatMap((l) => l.features.map((f) => f.kind)));
  for (const k of ['grid', 'column', 'beam', 'cable', 'panel', 'pipe', 'valve']) assert.ok(kinds.has(k), k);
});

test('ข้อมูลผิดรูปแบบถูกปฏิเสธพร้อมเหตุผล', () => {
  const bad = { schema: 'x', layers: [{ id: 'a', name: 'A', features: [{ id: 'f1', geometry: { type: 'LineString', coordinates: [[0, 0]] } }, { id: 'f2', geometry: { type: 'Point', coordinates: [3, 3] } }] }] };
  const r = parseEngineering(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('schema')));
  assert.ok(r.errors.some((e) => e.includes('f1')));
  assert.ok(r.errors.some((e) => e.includes('f2')));
  assert.equal(r.data.layers[0].features.length, 0);
});

test('การ์ดรายละเอียด: ชื่อระบบ รหัส และข้อมูลจำลอง', () => {
  const { data } = parseEngineering(raw);
  const v = featureInfo(data, 'PLB-GV-01');
  assert.equal(v.system, 'ประปา');
  assert.equal(v.code, 'GV-01');
  assert.equal(v.kind, 'วาล์ว');
  assert.ok(v.simulated);
  assert.ok(v.rows.some(([k]) => k === 'ขนาดท่อ'));
  assert.equal(featureInfo(data, 'nope'), null);
});

test('แสดงเฉพาะระบบนี้ และสรุปจำนวน', () => {
  const { data } = parseEngineering(raw);
  assert.deepEqual(soloVisibility(data, 'electrical'), { structure: false, electrical: true, plumbing: false });
  assert.match(layerSummary(data.layers[2]), /วาล์ว \d+/);
});
