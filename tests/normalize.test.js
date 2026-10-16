import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBatch } from '../src/domain/normalize.js';
import { indexConfig } from '../src/domain/config.js';
import { setup, payload, s, T0 } from './helpers.js';

function run(samples, { latest = new Map(), receivedAt = T0 + 1000, config } = {}) {
  const env = setup();
  if (config) config(env.config);
  const index = indexConfig(env.config);
  return { ...normalizeBatch(payload(samples), { index, source: 'api', receivedAt, latest }), latest };
}

test('ค่า 0 เป็นค่าตัวเลขที่ถูกต้อง', () => {
  const r = run([s('P-003', 'current', 0, 'A', T0)]);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].value, 0);
});

test('ปฏิเสธค่าที่ไม่ใช่ตัวเลขจริง: ข้อความ, NaN, Infinity, null', () => {
  const r = run([
    s('WL-001', 'level', '42', 'cm', T0),
    s('WL-001', 'level', null, 'cm', T0 + 1),
    { ...s('WL-001', 'level', 1, 'cm', T0 + 2), value: Number.NaN },
    { ...s('WL-001', 'level', 1, 'cm', T0 + 3), value: Infinity },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['invalid-value', 'invalid-value', 'invalid-value', 'invalid-value']);
});

test('หน่วยไม่ตรงถูกปฏิเสธ เว้นแต่มีการแปลงหน่วย', () => {
  const r = run([s('WL-001', 'level', 1000, 'mm', T0), s('P-005', 'temp', 77, '°F', T0)]);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].value, 100); // 1000 mm × 0.1 = 100 cm
  assert.equal(r.accepted[0].unit, 'cm');
  assert.equal(r.rejected[0].reason, 'unit-mismatch');
});

test('ค่านอกช่วงที่เป็นไปได้ และสถานะที่ไม่รู้จัก ถูกปฏิเสธ', () => {
  const r = run([s('WL-002', 'level', 120, '%', T0), s('P-008', 'leak', 'damp', '', T0)]);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['implausible', 'invalid-state']);
});

test('รหัสจุด/ค่าวัดที่ไม่รู้จัก และเวลาไม่มีเขตเวลา ถูกปฏิเสธ', () => {
  const r = run([
    s('P-999', 'level', 1, 'cm', T0),
    s('WL-001', 'nope', 1, 'cm', T0),
    { ...s('WL-001', 'level', 1, 'cm', T0), observedAt: '2026-10-14 03:00:00' },
  ]);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['unknown-point', 'unknown-metric', 'bad-timestamp']);
});

test('เวลาในอนาคต: ยอมรับได้ภายใน 60 วินาที เกินกว่านั้นปฏิเสธ', () => {
  const rec = T0;
  const r = run([s('WL-001', 'level', 1, 'cm', rec + 60_000), s('P-005', 'temp', 25, '°C', rec + 60_001)], { receivedAt: rec });
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected[0].reason, 'future-timestamp');
});

test('quality bad ถูกปฏิเสธ และไม่ส่ง quality ถือเป็น uncertain', () => {
  const r = run([s('WL-001', 'level', 1, 'cm', T0, { quality: 'bad' }), s('P-005', 'temp', 25, '°C', T0, { quality: undefined })]);
  assert.equal(r.rejected[0].reason, 'quality-bad');
  assert.equal(r.accepted[0].quality, 'uncertain');
});

test('ข้อมูลมาช้ากว่าค่าล่าสุดไม่เขียนทับค่าใหม่', () => {
  const latest = new Map();
  run([s('WL-001', 'level', 50, 'cm', T0 + 10_000)], { latest });
  const r = run([s('WL-001', 'level', 99, 'cm', T0)], { latest, receivedAt: T0 + 20_000 });
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0].reason, 'out-of-order');
  assert.equal(latest.get('WL-001|level').value, 50);
});

test('poll ซ้ำได้ค่าเดิมไม่นับเป็นการสังเกตใหม่', () => {
  const latest = new Map();
  const a = run([s('WL-001', 'level', 50, 'cm', T0, { sequence: 7 })], { latest });
  const b = run([s('WL-001', 'level', 50, 'cm', T0, { sequence: 7 })], { latest, receivedAt: T0 + 10_000 });
  assert.equal(a.accepted.length, 1);
  assert.equal(b.accepted.length, 0);
  assert.equal(b.duplicates, 1);
  assert.equal(b.rejected.length, 0);
});

test('เวลาเดียวกันแต่ค่าต่างกัน = conflict, sequence ถอยหลัง = out-of-order', () => {
  const latest = new Map();
  run([s('WL-001', 'level', 50, 'cm', T0, { sequence: 7 })], { latest });
  const r = run([
    s('WL-001', 'level', 51, 'cm', T0, { sequence: 8 }),
    s('P-005', 'temp', 25, '°C', T0, { sequence: 3 }),
    s('P-005', 'temp', 25.5, '°C', T0 + 1000, { sequence: 2 }),
  ], { latest });
  assert.deepEqual(r.rejected.map((x) => x.reason).sort(), ['conflict', 'out-of-order']);
});

test('ชุดข้อมูลที่ไม่เรียงลำดับถูกเรียงตามเวลาก่อนประมวลผล', () => {
  const r = run([s('WL-001', 'level', 3, 'cm', T0 + 2000), s('WL-001', 'level', 1, 'cm', T0), s('WL-001', 'level', 2, 'cm', T0 + 1000)]);
  assert.deepEqual(r.accepted.map((x) => x.value), [1, 2, 3]);
});

test('จุดที่เก็บถาวรไม่รับข้อมูลใหม่', () => {
  const r = run([s('WL-001', 'level', 1, 'cm', T0)], { config: (c) => { c.points[0].status = 'archived'; } });
  assert.equal(r.rejected[0].reason, 'archived-point');
});

test('payload ผิดรูปแบบหรือ schemaVersion ไม่รองรับ', () => {
  const { index } = setup();
  const latest = new Map();
  assert.equal(normalizeBatch({ samples: 'x' }, { index, source: 'api', receivedAt: T0, latest }).rejected[0].reason, 'bad-payload');
  assert.equal(normalizeBatch({ schemaVersion: 2, samples: [] }, { index, source: 'api', receivedAt: T0, latest }).rejected[0].reason, 'bad-schema');
});

test('sourceKey: รหัสจุดจาก API ที่ต่างจากรหัสภายในจับคู่ได้', () => {
  const r = run([s('SUMP-A', 'level', 10, 'cm', T0)], { config: (c) => { c.points[0].sourceKey = 'SUMP-A'; } });
  assert.equal(r.accepted[0].pointId, 'WL-001');
});
