import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricQuality } from '../src/domain/quality.js';
import { computeKpis, pointStatus } from '../src/domain/kpi.js';
import { csvCell, toCsv, readingsCsv } from '../src/domain/csv.js';
import { validateConfig, indexConfig } from '../src/domain/config.js';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { planTo3D, threeDToPlan, validatePos3d, pointInPolygon, pointPosition } from '../src/domain/geometry.js';
import { makeBackup, validateBackup } from '../src/domain/backup.js';
import { sampleId } from '../src/domain/normalize.js';
import { T0 } from './helpers.js';

const m = { staleAfterSec: 120 };

test('คุณภาพข้อมูล: ยังไม่มีข้อมูล / สดใหม่ / เก่า ตามเวลาสังเกต ไม่ใช่เวลา poll', () => {
  assert.equal(metricQuality(undefined, m, T0), 'nodata');
  const e = { lastValid: { observedAt: T0, receivedAt: T0 + 500_000 }, lastRejectedAt: null };
  assert.equal(metricQuality(e, m, T0 + 120_000), 'fresh', 'อายุเท่ากับขีดพอดียังสดใหม่');
  assert.equal(metricQuality(e, m, T0 + 120_001), 'stale', 'receivedAt ใหม่ไม่ทำให้ค่าเก่าสดใหม่');
});

test('คุณภาพข้อมูล: ค่าที่ถูกปฏิเสธล่าสุดทำให้เป็น "ไม่ถูกต้อง" โดยยังเก็บค่าที่ถูกต้องล่าสุดไว้', () => {
  const e = { lastValid: { observedAt: T0, value: 5 }, lastRejectedAt: T0 + 10_000 };
  assert.equal(metricQuality(e, m, T0 + 20_000), 'invalid');
  assert.equal(e.lastValid.value, 5);
  assert.equal(metricQuality(e, m, T0 + 200_000), 'stale', 'การปฏิเสธที่เก่าแล้วไม่ทำให้กลายเป็นสดใหม่');
  assert.equal(metricQuality({ lastValid: { observedAt: T0 + 20_000 }, lastRejectedAt: T0 + 10_000 }, m, T0 + 21_000), 'fresh');
});

test('KPI: จุดหลายค่าวัดนับเป็นหนึ่งจุด แต่เหตุการณ์นับตามค่าวัด', () => {
  const points = [
    { id: 'A', status: 'active', metrics: [{ id: 'x' }, { id: 'y' }] },
    { id: 'B', status: 'active', metrics: [{ id: 'x' }] },
    { id: 'C', status: 'archived', metrics: [{ id: 'x' }] },
  ];
  const q = (p, mid) => (p === 'B' ? 'stale' : 'fresh');
  const ep = (id, pointId, metricId, severity, extra = {}) => ({ id, pointId, metricId, severity, peakSeverity: severity, acks: [], recoveredAt: null, endedAt: null, ...extra });
  const episodes = [
    ep('1', 'A', 'x', 'critical'), ep('2', 'A', 'y', 'warning'),
    ep('3', 'A', 'x', 'warning', { recoveredAt: T0 }), // กลับสู่ปกติแต่ยังไม่รับทราบ
    ep('4', 'C', 'x', 'critical'), // จุดเก็บถาวร ไม่นับ
  ];
  const k = computeKpis(points, q, episodes);
  assert.deepEqual(k, { activePoints: 2, attentionPoints: 2, criticalPoints: 1, notFreshPoints: 1, unresolvedAlerts: 3, activeAlerts: 2 });
  assert.deepEqual(pointStatus(points[0], q, episodes), { severity: 'critical', quality: 'fresh', attention: true });
});

test('CSV: escape และป้องกันสูตร', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('@a'), "'@a");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
  assert.ok(toCsv(['a'], [['x']]).startsWith('﻿'));
});

test('CSV ค่าวัดมีทั้งเวลา UTC และเวลาไทย', () => {
  const c = createDefaultConfig();
  const csv = readingsCsv([{ source: 'demo', pointId: 'P-001', metricId: 'level', value: 0, unit: 'cm', quality: 'good', observedAt: T0, receivedAt: T0, sequence: 1 }], indexConfig(c));
  assert.match(csv, /2026-10-14T03:00:00.000Z/);
  assert.match(csv, /ข้อมูลจำลอง/);
});

test('การตั้งค่าเริ่มต้นผ่านการตรวจ', () => {
  const r = validateConfig(createDefaultConfig());
  assert.deepEqual(r.errors, []);
});

test('ตรวจการตั้งค่า: การอ้างอิง ขีดจำกัด และพิกัด', () => {
  const c = createDefaultConfig();
  c.points[0].floorId = 'X';
  c.points[1].plan = { x: 1.2, y: 0.5 };
  c.points[2].areaId = '3-MALL'; // พื้นที่อยู่คนละชั้น
  c.rules[0].critical = 50; // high: วิกฤต < เตือน
  c.rules[1].critical = 60; // low: วิกฤต > เตือน
  c.rules.push({ ...c.rules[0], id: 'R-001' });
  c.points[3].metrics[0].unit = '';
  const r = validateConfig(c);
  const txt = r.errors.join('\n');
  assert.equal(r.ok, false);
  for (const re of [/ชั้นที่ไม่มี X/, /0–1/, /ไม่ได้อยู่บนชั้น/, /≥ ค่าเตือน/, /≤ ค่าเตือน/, /รหัสกฎซ้ำ/, /ต้องมีหน่วย/]) assert.match(txt, re);
});

test('เรขาคณิต: ผัง ↔ 3D กลับไปกลับมาได้ และพิกัดอยู่ในกรอบ', () => {
  const c = createDefaultConfig();
  const f = c.building.floors.find((x) => x.id === '3');
  for (const p of c.points) {
    const fl = c.building.floors.find((x) => x.id === p.floorId);
    const pos = planTo3D(fl, p.plan);
    assert.deepEqual(validatePos3d(fl, pos), [], `${p.id} อยู่ในกรอบชั้น`);
    const back = threeDToPlan(fl, pos);
    assert.ok(Math.abs(back.x - p.plan.x) < 1e-9 && Math.abs(back.y - p.plan.y) < 1e-9);
    assert.ok(pointInPolygon(p.plan.x, p.plan.y, fl.footprint), `${p.id} อยู่ภายในรูปทรงอาคาร`);
  }
  assert.ok(validatePos3d(f, { x: 999, y: f.model.elevation, z: 0 }).length > 0);
  assert.ok(validatePos3d(f, { x: 0, y: 'a', z: 0 }).length > 0);
  const exploded = pointPosition(c.points[4], f, 'exploded');
  const normal = pointPosition(c.points[4], f, 'exterior');
  assert.ok(exploded.y > normal.y);
});

function sampleOf(source, pointId, metricId, value, observedAt) {
  return { id: sampleId(source, pointId, metricId, observedAt), source, pointId, metricId, value, unit: 'cm', quality: 'good', observedAt, receivedAt: observedAt, sequence: null };
}

test('สำรองข้อมูล: ไปกลับได้ และเวลาเดิมคงอยู่', () => {
  const config = createDefaultConfig();
  const samples = [sampleOf('api', 'P-001', 'level', 5, T0 - 86_400_000)];
  const b = JSON.parse(JSON.stringify(makeBackup({ config, samples, episodes: [], settings: null, exportedAt: T0 })));
  const v = validateBackup(b);
  assert.equal(v.ok, true, v.errors.join());
  assert.equal(b.samples[0].observedAt, T0 - 86_400_000);
  assert.deepEqual(v.summary.perSource, { demo: 0, api: 1 });
});

test('สำรองข้อมูล: ตรวจการอ้างอิงที่เสีย ก่อนเขียน', () => {
  const config = createDefaultConfig();
  const b = makeBackup({
    config,
    samples: [sampleOf('api', 'P-404', 'level', 5, T0), { ...sampleOf('demo', 'P-001', 'level', 5, T0), id: 'wrong' }],
    episodes: [{ id: 'E1', source: 'api', pointId: 'P-001', metricId: 'level', ruleId: 'R-404', severity: 'warning', peakSeverity: 'warning', openedAt: T0, acks: [], events: [] }],
    exportedAt: T0,
  });
  const v = validateBackup(b);
  assert.equal(v.ok, false);
  const txt = v.errors.join('\n');
  assert.match(txt, /P-404/);
  assert.match(txt, /รหัส sample ไม่ตรง/);
  assert.match(txt, /R-404/);
  assert.equal(validateBackup({ format: 'x' }).ok, false);
});
