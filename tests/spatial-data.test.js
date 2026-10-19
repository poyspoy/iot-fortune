import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDoc, T, fixtureId as fid } from './spatial-fixture.js';
import { makeScope, ScopeError } from '../src/data/scope.js';
import { validateSpatialDoc, buildTelemetryIndex, telemetryKeyConflicts } from '../src/data/entities.js';
import { telemetryDecision, statusMismatches, defaultPointInstallStatus, isDisplayable, INSTALL_STATUSES, PRE_INSTALL, LIVE, RETIRED } from '../src/data/lifecycle.js';
import { SpatialDataService, SpatialDataError } from '../src/data/spatialData.js';
import { IngestAudit } from '../src/data/ingestAudit.js';

const scope = makeScope({ organizationId: T.org, projectId: T.proj, buildingId: T.bld });
const svc = (doc = makeDoc()) => new SpatialDataService(doc, scope);
const withPoint = (doc, code, fn) => { fn(doc.points.find((p) => p.pointCode === code)); return doc; };

// ------------------------------------------------------------------ Lifecycle

test('ตารางสถานะติดตั้ง × (แสดงตำแหน่ง / รับข้อมูล / KPI-Alarm) ครบทุกช่อง', () => {
  for (const s of INSTALL_STATUSES) {
    const p = { status: 'active', installation: { status: s } };
    const d = telemetryDecision(p);
    if (LIVE.includes(s)) { assert.deepEqual(d, { accept: true, reason: null }, s); assert.ok(isDisplayable(p)); }
    if (PRE_INSTALL.includes(s)) { assert.deepEqual(d, { accept: false, reason: 'not-installed' }, s); assert.ok(isDisplayable(p), `${s} ต้องแสดงตำแหน่งได้`); }
    if (RETIRED.includes(s)) { assert.deepEqual(d, { accept: false, reason: 'point-retired' }, s); assert.equal(isDisplayable(p), false); }
  }
  assert.deepEqual(telemetryDecision({ status: 'archived', installation: { status: 'installed' } }), { accept: false, reason: 'archived-point' });
  assert.equal(isDisplayable({ installation: { status: 'unknown' } }), false);
});

test('Point × Asset: Point ตัดสิน · Asset ยับยั้งได้แต่อนุญาตแทนไม่ได้ · ไม่ตรงกันขึ้นรายการตรวจสอบ', () => {
  const live = { id: 'p', status: 'active', installation: { status: 'installed' } };
  const pre = { id: 'p2', status: 'active', installation: { status: 'proposed' } };
  const a = (s) => ({ id: `a-${s}`, installation: { status: s } });
  assert.equal(telemetryDecision(live, [a('proposed')]).accept, true, 'Asset ยังไม่ติดตั้ง ไม่ยับยั้ง (แต่รายงานไม่ตรงกัน)');
  assert.deepEqual(telemetryDecision(live, [a('decommissioned')]), { accept: false, reason: 'asset-retired' });
  assert.deepEqual(telemetryDecision(live, [a('installed'), a('rejected')]), { accept: false, reason: 'asset-retired' });
  assert.deepEqual(telemetryDecision(pre, [a('installed')]), { accept: false, reason: 'not-installed' }, 'Asset ติดตั้งแล้วไม่ทำให้ Point ที่ยังไม่ติดตั้งรับข้อมูล');
  assert.equal(statusMismatches(live, [a('proposed')]).length, 1);
  assert.equal(statusMismatches(pre, [a('installed')]).length, 1);
  assert.equal(statusMismatches(live, [a('commissioned')]).length, 0);
});

test('สถานะเริ่มต้นของจุดใหม่มาจาก Project Configuration (ไม่ได้กำหนด = proposed)', () => {
  assert.equal(defaultPointInstallStatus({ settings: { defaultPointInstallStatus: 'installed' } }), 'installed');
  assert.equal(defaultPointInstallStatus({ settings: {} }), 'proposed');
  assert.equal(defaultPointInstallStatus(null), 'proposed');
  assert.equal(defaultPointInstallStatus({ settings: { defaultPointInstallStatus: 'decommissioned' } }), 'proposed');
  assert.equal(defaultPointInstallStatus({ settings: { defaultPointInstallStatus: 'bogus' } }), 'proposed');
});

// ------------------------------------------------------------------ BD-001 / คีย์ Telemetry

test('BD-001: ค่าวัดในจุดเดียวกันห้ามมี metricSourceKey ซ้ำ — เอกสารไม่ผ่านการตรวจ', () => {
  const doc = withPoint(makeDoc(), 'T-1', (p) => { p.metrics[1].sourceKey = 'temp'; });
  const v = validateSpatialDoc(doc);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /metricSourceKey ซ้ำ "temp"/.test(e)), v.errors.join('\n'));
  assert.equal(v.conflicts.length, 1);
  assert.deepEqual(v.conflicts[0].entries.map((e) => e.metricId), ['temp', 'rh']);
  assert.throws(() => svc(doc), SpatialDataError);
});

test('อุปกรณ์เดียวส่งหลายค่า: จุดคนละจุดใช้ sourceKey เดียวกันได้ ถ้า metricSourceKey ไม่ซ้ำ — ข้อมูลเข้าจุดที่ถูกต้อง', () => {
  const doc = makeDoc({ extraPoints: [
    { code: 'GW-A', metrics: ['ch1'], over: { sourceKey: 'GW-01' } },
    { code: 'GW-B', metrics: ['ch2'], over: { sourceKey: 'GW-01' }, floor: '1' },
  ] });
  const s = svc(doc);
  assert.deepEqual(s.resolveTelemetry(T.proj, 'GW-01', 'ch1'), { accept: true, reason: null, pointId: fid('point', 'GW-A'), metricId: 'ch1' });
  assert.deepEqual(s.resolveTelemetry(T.proj, 'GW-01', 'ch2'), { accept: true, reason: null, pointId: fid('point', 'GW-B'), metricId: 'ch2' });
  assert.equal(s.resolveTelemetry(T.proj, 'GW-01', 'ch3').reason, 'unknown-metric');
  assert.equal(s.resolveTelemetry(T.proj, 'NOPE', 'x').reason, 'unknown-point');
});

test('คีย์ (sourceKey, metricSourceKey) ซ้ำระหว่างจุด → ไม่ผ่าน ไม่เลือกให้เอง · ดัชนีโยนข้อผิดพลาดพร้อมรายการที่ชน', () => {
  const doc = makeDoc({ extraPoints: [{ code: 'DUP', metrics: ['level'], over: { sourceKey: 'WL-1' } }] });
  const v = validateSpatialDoc(doc);
  assert.equal(v.ok, false);
  assert.deepEqual(v.conflicts.map((c) => [c.sourceKey, c.metricSourceKey, c.entries.map((e) => e.pointCode)]), [['WL-1', 'level', ['WL-1', 'DUP']]]);
  assert.throws(() => buildTelemetryIndex(doc.points), (e) => e.name === 'TelemetryKeyConflict' && e.conflicts.length === 1);
});

test('จุดที่ปลดระวาง/เก็บถาวรไม่ถือคีย์ — จุดใหม่ใช้คีย์เดิมได้ และข้อมูลไม่เข้าจุดเก่า', () => {
  const doc = makeDoc({ extraPoints: [{ code: 'WL-1-NEW', metrics: ['level'], over: { sourceKey: 'WL-1' } }] });
  withPoint(doc, 'WL-1', (p) => { p.installation = { status: 'decommissioned' }; });
  doc.bindings = doc.bindings.filter((b) => b.pointId !== fid('point', 'WL-1'));
  const s = svc(doc);
  assert.equal(s.resolveTelemetry(T.proj, 'WL-1', 'level').pointId, fid('point', 'WL-1-NEW'));
  assert.equal(telemetryKeyConflicts(doc.points).length, 0);
  assert.equal(telemetryKeyConflicts(doc.points, { includeAll: true }).length, 1, 'ยังตรวจพบได้ถ้าต้องการรวมจุดที่ปลดระวาง');
});

test('รหัสเดียวกันต่างโครงการไม่ปนกัน: ข้อมูลของโครงการอื่นถูกปฏิเสธ', () => {
  const s = svc();
  assert.equal(s.resolveTelemetry(T.proj2, 'WL-1', 'level').accept, false);
  assert.equal(s.resolveTelemetry(T.proj2, 'WL-1', 'level').pointId, null);
  assert.equal(s.pointByCode(T.proj2, 'WL-1'), null);
  assert.ok(s.pointByCode(T.proj, 'WL-1'));
});

test('สุ่มข้อมูล 5,000 รายการ: ทุกค่าเข้าจุด/ค่าวัดที่คาดไว้เท่านั้น', () => {
  const doc = makeDoc({ extraPoints: Array.from({ length: 20 }, (_, i) => ({ code: `S-${i}`, metrics: ['a', 'b', 'c'], over: { sourceKey: `DEV-${i % 7}` }, floor: i % 2 ? '1' : 'G' }))
    .map((e, i) => ({ ...e, metrics: e.metrics.map((m) => `${m}${i}`) })) });
  const s = svc(doc);
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const expected = new Map();
  for (const p of doc.points) for (const m of p.metrics) expected.set(`${p.sourceKey}|${m.sourceKey}`, [p.id, m.id]);
  const keys = [...expected.keys()];
  for (let i = 0; i < 5000; i++) {
    const k = keys[Math.floor(rnd() * keys.length)];
    const [sk, mk] = k.split('|');
    const r = s.resolveTelemetry(T.proj, sk, mk);
    assert.deepEqual([r.pointId, r.metricId], expected.get(k), k);
  }
});

// ------------------------------------------------------------------ เอกสาร / Scope

test('เอกสารตัวอย่างผ่านการตรวจ · id ต้องเป็น UUID · รหัสแสดงผลซ้ำในโครงการไม่ผ่าน', () => {
  assert.deepEqual(validateSpatialDoc(makeDoc()).errors, []);
  const bad = makeDoc(); bad.points[0].id = 'WL-1';
  assert.ok(validateSpatialDoc(bad).errors.some((e) => /id ต้องเป็น UUID/.test(e)));
  const dup = makeDoc(); dup.points[1].pointCode = 'WL-1';
  assert.ok(validateSpatialDoc(dup).errors.some((e) => /pointCode ซ้ำในโครงการ WL-1/.test(e)));
  const adup = makeDoc(); adup.assets[1].assetCode = 'DEMO-PIT-1';
  assert.ok(validateSpatialDoc(adup).errors.some((e) => /assetCode ซ้ำในโครงการ/.test(e)));
});

test('Entity ที่ scope ไม่ตรงกับโครงการถูกปฏิเสธตั้งแต่ตอนโหลด (ไม่กรองเงียบ)', () => {
  const doc = makeDoc(); doc.points[2].projectId = T.proj2;
  assert.throws(() => svc(doc), SpatialDataError);
  const other = makeDoc({ proj: T.proj2 });
  assert.throws(() => new SpatialDataService(other, scope), ScopeError);
});

test('Binding: บทบาทเดี่ยวซ้ำ / ค่าวัดไม่มี / คนละชั้น / อ้างถึงสิ่งที่ไม่มี → ไม่ผ่าน', () => {
  const base = makeDoc();
  const b0 = base.bindings[0];
  const cases = [
    [[...base.bindings, { ...b0, id: fid('binding', 'x1') }], /บทบาท level ซ้ำ/],
    [[{ ...b0, metricId: 'nope' }], /ค่าวัด nope ไม่มี/],
    [[{ ...b0, pointId: fid('point', 'T-1'), metricId: 'temp' }], /คนละชั้น/],
    [[{ ...b0, assetId: fid('asset', 'ghost') }], /อุปกรณ์ที่ไม่มี/],
    [[{ ...b0, role: 'magic' }], /บทบาทไม่รู้จัก/],
  ];
  for (const [bindings, re] of cases) {
    const v = validateSpatialDoc(makeDoc({ bindings }));
    assert.ok(v.errors.some((e) => re.test(e)), `${re}: ${v.errors.join(' | ')}`);
  }
});

test('Service: snapshot แก้ไม่ได้ · ถัง/ปั๊มหาจาก Binding ไม่ใช่รหัสจุด · ความสัมพันธ์สองทิศ', () => {
  const s = svc();
  assert.throws(() => { s.doc.points[0].name = 'x'; }, TypeError);
  const [tank] = s.tanks();
  assert.equal(tank.asset.assetCode, 'DEMO-PIT-1');
  assert.equal(tank.point.pointCode, 'WL-1');
  assert.equal(tank.metricId, 'level');
  const [pump] = s.pumps();
  assert.equal(pump.point.pointCode, 'P-1');
  assert.equal(pump.metricId, 'run');
  assert.deepEqual(s.assetsOfPoint(fid('point', 'P-1')).map((a) => a.assetCode), ['DEMO-PUMP-1']); // ไม่ซ้ำ แม้ผูก 2 บทบาท (Binding ยังมี 2)
  assert.equal(s.bindingsOfAsset(fid('asset', 'DEMO-PUMP-1')).length, 2);
});

test('เปลี่ยน assetCode (ได้รหัสจริง) → UUID/Binding/ความสัมพันธ์เดิมยังเชื่อมอยู่', () => {
  const doc = makeDoc(); doc.assets[1].assetCode = 'FRT-PUMP-REAL-77';
  const s = svc(doc);
  const a = s.assetByCode(T.proj, 'FRT-PUMP-REAL-77');
  assert.equal(a.id, fid('asset', 'DEMO-PUMP-1'));
  assert.equal(s.pumps()[0].point.pointCode, 'P-1');
  assert.equal(s.assetByCode(T.proj, 'DEMO-PUMP-1'), null);
});

test('Lifecycle ผ่าน Service: จุดเสนอแสดงตำแหน่งได้ แต่ไม่รับข้อมูล · อุปกรณ์ปลดระวางยับยั้งจุดที่ผูก', () => {
  const doc = withPoint(makeDoc(), 'T-1', (p) => { p.installation = { status: 'proposed' }; });
  doc.assets[1].installation = { status: 'decommissioned' };
  const s = svc(doc);
  assert.ok(s.displayPoints().some((p) => p.pointCode === 'T-1'));
  assert.deepEqual(s.resolveTelemetry(T.proj, 'T-1', 'temp').reason, 'not-installed');
  assert.deepEqual(s.resolveTelemetry(T.proj, 'P-1', 'run').reason, 'asset-retired');
  assert.deepEqual(s.telemetryPoints().map((p) => p.pointCode), ['WL-1']);
  assert.equal(s.pumps().length, 0, 'ปั๊มปลดระวางไม่แสดงภาพ');
});

test('Needs Remapping: ผัง/โมเดลเปลี่ยน → อยู่ในรายการตรวจสอบพร้อมเหตุผล ไม่ลบ ไม่ซ่อน', () => {
  const doc = makeDoc(); doc.floors[0].floorPlanVersion = 'sha256:plan-G-v2';
  const s = svc(doc);
  const list = s.reviewList().filter((r) => r.issue === 'needs-remapping');
  assert.deepEqual(list.map((r) => r.code).sort(), ['DEMO-PIT-1', 'DEMO-PUMP-1', 'P-1', 'WL-1']);
  assert.ok(list.every((r) => r.reasons.includes('plan-changed') && r.floorCode === 'G' && r.current.floorPlanVersion === 'sha256:plan-G-v2'));
  assert.ok(s.displayPoints().some((p) => p.pointCode === 'WL-1'), 'ยังแสดงอยู่');
  assert.equal(s.resolveTelemetry(T.proj, 'WL-1', 'level').accept, true, 'ติดตั้งแล้วยังรับข้อมูลตามปกติ');
  const manual = withPoint(makeDoc(), 'T-1', (p) => { p.position.mappingStatus = 'needs_remapping'; p.position.remapReasons = ['anchor-not-found']; });
  assert.deepEqual(svc(manual).reviewList().map((r) => [r.code, r.reasons]), [['T-1', ['anchor-not-found']]]);
});

test('ตำแหน่ง: ผัง → Building CRS → หมุด 3D จาก FloorFrame เดียวกัน · พิกัด 3D ที่ยืนยันแล้วมาก่อน', () => {
  const s = svc();
  const p = s.pointByCode(T.proj, 'WL-1');
  const pos = s.position(p);
  assert.deepEqual(pos.building, { x: 0, z: 0 });
  assert.ok(Math.abs(pos.marker3d.y - (0 + 0.8 * 0.12 + 0.4)) < 1e-12);
  const doc = withPoint(makeDoc(), 'WL-1', (q) => { q.position.xyz = { x: 1, y: 2, z: 3 }; });
  assert.deepEqual(svc(doc).position(svc(doc).pointByCode(T.proj, 'WL-1')).marker3d, { x: 1, y: 2, z: 3 });
});

test('replace(): เอกสารใหม่ผิด → คงข้อมูลเดิม · ถูก → แจ้งผู้ฟัง', () => {
  const s = svc(); let n = 0; s.onChange(() => n++);
  const bad = makeDoc(); bad.points[0].installation = { status: 'weird' };
  assert.throws(() => s.replace(bad), SpatialDataError);
  assert.equal(s.pointByCode(T.proj, 'WL-1').installation.status, 'installed');
  assert.equal(n, 0);
  const good = makeDoc(); good.points[0].name = 'ใหม่';
  s.replace(good);
  assert.equal(s.pointByCode(T.proj, 'WL-1').name, 'ใหม่');
  assert.equal(n, 1);
});

// ------------------------------------------------------------------ Audit

test('Ingest Audit: บันทึกเหตุผล not-installed ไม่ทิ้งเงียบ · จำกัดจำนวนและอายุ · ส่งต่อให้ที่เก็บถาวร', () => {
  let t = 1_000_000; const persisted = [];
  const a = new IngestAudit({ maxEntries: 3, maxAgeMs: 1000, now: () => t, persist: (e) => persisted.push(...e) });
  const s = svc(withPoint(makeDoc(), 'T-1', (p) => { p.installation = { status: 'pending_approval' }; }));
  const r = s.resolveTelemetry(T.proj, 'T-1', 'temp');
  const e = a.record({ ...scope, pointId: r.pointId, pointCode: 'T-1', sourceKey: 'T-1', metricKey: 'temp', observedAt: t - 5, reason: r.reason, source: 'api' });
  assert.equal(e.reason, 'not-installed');
  assert.equal(e.pointId, fid('point', 'T-1'));
  assert.equal(persisted.length, 1);
  for (let i = 0; i < 4; i++) a.record({ ...scope, sourceKey: 'X', metricKey: 'y', reason: 'unknown-point' });
  assert.equal(a.entries.length, 3, 'จำกัดจำนวน');
  assert.equal(a.counts['not-installed'], 1);
  t += 5000;
  a.record({ ...scope, sourceKey: 'Z', metricKey: 'z', reason: 'unknown-point' });
  assert.equal(a.entries.length, 1, 'จำกัดอายุ');
  assert.throws(() => a.record({ sourceKey: 'x' }), /เหตุผล/);
  assert.deepEqual(a.list({ projectId: T.proj2 }), []);
});
