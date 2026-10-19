import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { migrateConfig } from '../src/domain/migrate.js';
import { planTo3D } from '../src/domain/geometry.js';
import { IdbRepo } from '../src/store/idbRepo.js';
import { MonitorEngine } from '../src/engine.js';
import { ManualClock } from '../src/domain/time.js';
import { demoPayloadBetween } from '../src/adapters/demoAdapter.js';
import { FORTUNE_TENANCY } from '../src/data/fortuneTenancy.js';
import { migrateConfigToV6, precheckV5 } from '../src/data/migrateV6.js';
import { migrateDatabase, dumpDb, readV5Backup, rollbackV6, v6Name, BACKUP_KEY } from '../src/data/migrateDb.js';
import { legacyEntityId, isUuid } from '../src/data/ids.js';
import { makeScope } from '../src/data/scope.js';
import { SpatialDataService } from '../src/data/spatialData.js';
import { T0, idGen } from './helpers.js';

const manifest = JSON.parse(readFileSync('public/asset-manifest.json', 'utf8'));
const T = FORTUNE_TENANCY;
const scope = makeScope({ organizationId: T.organization.id, projectId: T.project.id, buildingId: T.building.id });
const run = (cfg = createDefaultConfig()) => migrateConfigToV6(cfg, { tenancy: T, manifest });
const NOW = () => 1_800_000_000_000;

// ------------------------------------------------------------------ การตั้งค่า (ฟังก์ชันบริสุทธิ์)

test('Fortune v5 → v6: ผ่านการตรวจ · 8 จุดรหัสเดิม · ติดตั้งแล้วทั้งหมด · Scope ของ Fortune ทุก Entity', () => {
  const r = run();
  assert.equal(r.ok, true, JSON.stringify(r.errors ?? r.conflicts));
  const { doc } = r;
  assert.deepEqual(doc.points.map((p) => p.pointCode), ['WL-001', 'WL-002', 'P-003', 'P-004', 'P-005', 'P-006', 'P-007', 'P-008']);
  assert.ok(doc.points.every((p) => p.installation.status === 'installed' && p.isDemo === true && isUuid(p.id)));
  for (const list of [doc.floors, doc.areas, doc.points, doc.assets, doc.bindings, doc.rules]) {
    for (const e of list) {
      assert.equal(e.organizationId, T.organization.id); assert.equal(e.projectId, T.project.id); assert.equal(e.buildingId, T.building.id);
    }
  }
  assert.equal(doc.project.settings.defaultPointInstallStatus, 'installed');
  assert.equal(doc.floors.length, 28);
  assert.ok(doc.floors.every((f) => /^sha256:[0-9a-f]{64}$/.test(f.floorPlanVersion) && /^sha256:[0-9a-f]{64}/.test(f.modelVersion)));
});

test('Fortune: Asset 4 ตัว รหัสสาธิต FRT-DEMO-* และ Binding ตามบทบาท (แหล่งความสัมพันธ์เดียว)', () => {
  const { doc } = run();
  const a = Object.fromEntries(doc.assets.map((x) => [x.assetCode, x]));
  assert.deepEqual(Object.keys(a).sort(), ['FRT-DEMO-AHU-001', 'FRT-DEMO-PIT-001', 'FRT-DEMO-PUMP-001', 'FRT-DEMO-TANK-001']);
  assert.ok(doc.assets.every((x) => x.isDemo === true));
  const code = Object.fromEntries(doc.points.map((p) => [p.id, p.pointCode]));
  const b = doc.bindings.map((x) => [doc.assets.find((y) => y.id === x.assetId).assetCode, code[x.pointId], x.role, x.metricId]).sort();
  assert.deepEqual(b, [
    ['FRT-DEMO-AHU-001', 'P-004', 'temperature', 'chwr'], ['FRT-DEMO-AHU-001', 'P-004', 'temperature', 'chws'],
    ['FRT-DEMO-PIT-001', 'WL-001', 'level', 'level'],
    ['FRT-DEMO-PUMP-001', 'P-003', 'current', 'current'], ['FRT-DEMO-PUMP-001', 'P-003', 'run', 'run'],
    ['FRT-DEMO-TANK-001', 'WL-002', 'level', 'level'],
  ]);
  assert.ok(doc.points.every((p) => !('assetId' in p)), 'ไม่มี point.assetId ซ้ำซ้อนกับ Binding');
  assert.deepEqual(a['FRT-DEMO-PUMP-001'].visual, { kind: 'pump', offset: { x: -0.6, z: 0 } });
  assert.deepEqual(a['FRT-DEMO-PIT-001'].visual, { kind: 'pit', offset: { x: 0.42, z: 0 } });
  assert.deepEqual(a['FRT-DEMO-TANK-001'].visual, { kind: 'tank', offset: { x: 0.42, z: 0 } });
  assert.equal(a['FRT-DEMO-AHU-001'].visual, null);
});

test('ตำแหน่งก่อน–หลัง Migration เท่ากันทุกค่า: หมุด 8 จุด และฐานของถัง/บ่อ/ปั๊ม (≤ 1e-12)', () => {
  const v5 = createDefaultConfig();
  const { doc } = run(v5);
  const s = new SpatialDataService(doc, scope);
  const floor5 = Object.fromEntries(v5.building.floors.map((f) => [f.id, f]));
  for (const p5 of v5.points) {
    const p6 = s.pointByCode(T.project.id, p5.id);
    assert.deepEqual(p6.position.plan, { u: p5.plan.x, v: p5.plan.y }, `${p5.id} plan`);
    const old = planTo3D(floor5[p5.floorId], p5.plan); const neu = s.position(p6).marker3d;
    for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(old[k] - neu[k]) <= 1e-12, `${p5.id} ${k}`);
    assert.equal(s.floor(p6.floorId).code, p5.floorId);
  }
  // ฐานของภาพอุปกรณ์ในฉากปัจจุบัน: planTo3D(จุดที่ผูก) + offset.x — ต้องเท่ากับตำแหน่ง Asset + visual.offset
  for (const [code, pointCode, dx] of [['FRT-DEMO-PIT-001', 'WL-001', 0.42], ['FRT-DEMO-TANK-001', 'WL-002', 0.42], ['FRT-DEMO-PUMP-001', 'P-003', -0.6]]) {
    const a = s.assetByCode(T.project.id, code); const p5 = v5.points.find((p) => p.id === pointCode);
    const old = planTo3D(floor5[p5.floorId], p5.plan);
    const base = s.position(a).building;
    assert.ok(Math.abs(base.x + a.visual.offset.x - (old.x + dx)) <= 1e-12 && Math.abs(base.z - old.z) <= 1e-12, code);
  }
  assert.deepEqual(s.tanks().map((t) => [t.asset.assetCode, t.point.pointCode]), [['FRT-DEMO-PIT-001', 'WL-001'], ['FRT-DEMO-TANK-001', 'WL-002']]);
  assert.deepEqual(s.pumps().map((p) => [p.asset.assetCode, p.point.pointCode, p.metricId]), [['FRT-DEMO-PUMP-001', 'P-003', 'run']]);
});

test('ข้อมูลเดิมคงไว้ทุกค่า: ชื่อ ค่าวัด เกณฑ์แจ้งเตือน พื้นที่ ผัง โมเดล (เทียบทีละฟิลด์)', () => {
  const v5 = createDefaultConfig();
  const { doc, idMap } = run(v5);
  for (const p5 of v5.points) {
    const p6 = doc.points.find((p) => p.pointCode === p5.id);
    assert.equal(p6.name, p5.name); assert.equal(p6.system, p5.system); assert.equal(p6.status, p5.status);
    assert.equal(p6.sourceKey, p5.sourceKey); assert.deepEqual(p6.metrics, p5.metrics);
    assert.equal(p6.areaId, idMap.area[p5.areaId]); assert.equal(p6.legacy.equipmentId, p5.equipmentId);
  }
  for (const r5 of v5.rules) {
    const r6 = doc.rules.find((r) => r.ruleCode === r5.id);
    const { id, ruleCode, pointId, organizationId, projectId, buildingId, ...rest6 } = r6;
    const { id: _i, pointId: p5, ...rest5 } = r5;
    assert.deepEqual(rest6, rest5); assert.equal(pointId, idMap.point[p5]);
  }
  for (const f5 of v5.building.floors) {
    const f6 = doc.floors.find((f) => f.code === f5.id);
    assert.deepEqual([f6.name, f6.order, f6.kind, f6.plan, f6.footprint, f6.model, f6.detail], [f5.name, f5.order, f5.kind, f5.plan, f5.footprint, f5.model, f5.detail ?? null]);
  }
});

test('UUID: ทำซ้ำได้ผลเดิมทุกไบต์ · ตรงกับ legacyEntityId · ไม่แก้ข้อมูลต้นทาง', () => {
  const v5 = createDefaultConfig(); const before = structuredClone(v5);
  const a = run(v5); const b = run(v5);
  assert.deepEqual(a, b);
  assert.deepEqual(v5, before, 'ต้นทางไม่ถูกแก้');
  const p3 = a.doc.points.find((p) => p.pointCode === 'P-003');
  assert.equal(p3.id, legacyEntityId(T.organization.namespaceId, T.project.id, 'point', 'P-003'));
  const other = migrateConfigToV6(v5, { tenancy: { ...T, organization: { ...T.organization, namespaceId: '11111111-2222-4333-8444-555555555555' } }, manifest });
  assert.notEqual(other.doc.points.find((p) => p.pointCode === 'P-003').id, p3.id, 'คนละ namespace องค์กร → UUID ต่างกัน');
});

test('การตั้งค่าที่ผู้ใช้แก้เอง: ตำแหน่ง/ชื่อ/จุดที่เพิ่มเอง/จุดเก็บถาวร/พิกัด 3D คงไว้', () => {
  const v5 = createDefaultConfig();
  const p5 = v5.points.find((p) => p.id === 'P-005'); p5.name = 'ชื่อที่ผู้ใช้แก้'; p5.plan = { x: 0.31, y: 0.62 };
  v5.points.find((p) => p.id === 'P-008').status = 'archived';
  v5.points.push({ id: 'P-009', sourceKey: 'P-009', name: 'จุดเพิ่มเอง', system: 'environment', equipmentId: '', floorId: '12', areaId: '', plan: { x: 0.4, y: 0.5 }, pos3d: { x: 1, y: 10, z: 0 }, status: 'active', example: false,
    metrics: [{ id: 'value', sourceKey: 'value', name: 'ค่าวัด', kind: 'numeric', unit: 'x', decimals: 1, staleAfterSec: 120, explain: '' }] });
  const { doc, ok } = run(v5);
  assert.equal(ok, true);
  const g = (c) => doc.points.find((p) => p.pointCode === c);
  assert.equal(g('P-005').name, 'ชื่อที่ผู้ใช้แก้'); assert.deepEqual(g('P-005').position.plan, { u: 0.31, v: 0.62 });
  assert.equal(g('P-008').status, 'archived');
  assert.deepEqual(g('P-009').position.xyz, { x: 1, y: 10, z: 0 }); assert.equal(g('P-009').isDemo, false);
  assert.equal(g('P-009').installation.status, 'installed'); assert.equal(g('P-009').areaId, null);
});

test('การตั้งค่ารุ่นเก่า (v4) ผ่าน migrateConfig เดิมก่อนแล้วย้ายเป็น v6 ได้', () => {
  const v4 = { ...createDefaultConfig(), schemaVersion: 4 };
  const r = migrateConfigToV6(migrateConfig(v4), { tenancy: T, manifest });
  assert.equal(r.ok, true);
  assert.equal(migrateConfigToV6(v4, { tenancy: T, manifest }).stage, 'schema', 'ไม่รับ v4 ตรง ๆ');
});

test('BD-001 ระหว่าง Migration: metricSourceKey ซ้ำในจุดเดียวกัน → หยุด แจ้งรายการที่ชน ไม่สร้างเอกสาร', () => {
  const v5 = createDefaultConfig(); const before = structuredClone(v5);
  v5.points.find((p) => p.id === 'P-005').metrics[1].sourceKey = 'temp';
  const snapshot = structuredClone(v5);
  const r = run(v5);
  assert.equal(r.ok, false); assert.equal(r.stage, 'precheck'); assert.equal(r.doc, undefined);
  assert.deepEqual(r.conflicts.map((c) => [c.sourceKey, c.metricSourceKey, c.entries.map((e) => `${e.pointCode}/${e.metricId}`)]), [['P-005', 'temp', ['P-005/temp', 'P-005/rh']]]);
  assert.deepEqual(v5, snapshot, 'ไม่แก้ข้อมูลต้นทาง');
  assert.notDeepEqual(v5, before);
});

test('คีย์ชนข้ามจุด → หยุด แจ้งทั้งสองจุด ไม่เลือกจุดใดให้เอง', () => {
  const v5 = createDefaultConfig();
  v5.points.find((p) => p.id === 'P-007').sourceKey = 'P-005'; // P-007 มีค่าวัด temp เหมือน P-005
  const c = precheckV5(v5, T.project.id);
  assert.deepEqual(c.map((x) => [x.sourceKey, x.metricSourceKey, x.entries.map((e) => e.pointCode)]), [['P-005', 'temp', ['P-005', 'P-007']]]);
  assert.equal(run(v5).stage, 'precheck');
});

// ------------------------------------------------------------------ ฐานข้อมูล: สำรอง / ย้อนกลับ / กู้คืน

async function seedSource(factory, name, mutate = null) {
  const repo = await new IdbRepo({ indexedDB: factory, IDBKeyRange, name }).open();
  const config = createDefaultConfig(); mutate?.(config);
  await repo.putKV('config', config);
  await repo.putKV('ui', { selectedId: 'P-007', floorId: '12', view: 'overview' });
  await repo.putKV('settings', { demo: { seed: 1, scenario: 'sump-rising', lossPointId: 'P-005' } });
  const clock = new ManualClock(T0 + 20 * 60_000);
  const e = await new MonitorEngine({ repo, config: createDefaultConfig(), source: 'demo', clock, idGen: idGen(), retention: { maxDays: 7, maxSamples: 100_000 } }).init();
  await e.ingest(demoPayloadBetween(T0 - 60_000, T0 + 20 * 60_000, { seed: 1, scenario: 'sump-rising', scenarioStartedAt: T0, lossPointId: 'P-005' }), { receivedAt: clock.now() });
  await e.acknowledge(e.episodes()[0].id, { by: 'ช่างทดสอบ', note: 'ตรวจแล้ว' });
  repo.close();
  return config;
}

test('ฐานข้อมูล: ย้ายลงฐานใหม่ @v6 · ฐานเดิมไม่เปลี่ยนแม้แต่ไบต์เดียว · ค่าวัด/เหตุการณ์ครบและค่าเดิม', async () => {
  const f = new IDBFactory();
  const raw = await seedSource(f, 'iot-fortune-x');
  const before = await dumpDb(f, 'iot-fortune-x');
  const r = await migrateDatabase({ indexedDB: f, sourceName: 'iot-fortune-x', tenancy: T, manifest, now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.targetName, v6Name('iot-fortune-x'));
  assert.deepEqual(await dumpDb(f, 'iot-fortune-x'), before, 'ฐานเดิมไม่เปลี่ยน');
  const after = await dumpDb(f, r.targetName);
  assert.equal(after.samples.length, before.samples.length);
  assert.equal(after.episodes.length, before.episodes.length);
  assert.ok(after.samples.length > 100 && after.episodes.length >= 1);
  const { doc } = run(raw);
  const byCode = Object.fromEntries(doc.points.map((p) => [p.pointCode, p.id]));
  const oldById = new Map(before.samples.map((s) => [s.id, s]));
  for (const s of after.samples) {
    assert.ok(isUuid(s.pointId));
    const o = oldById.get(`${s.source}:${s.legacyPointCode}:${s.metricId}:${s.observedAt}`);
    assert.ok(o, 'มีค่าเดิมคู่กัน');
    assert.equal(s.pointId, byCode[o.pointId]);
    for (const k of ['value', 'observedAt', 'receivedAt', 'sequence', 'quality', 'source', 'metricId']) assert.deepEqual(s[k], o[k], k);
  }
  const ep = after.episodes[0]; const ep0 = before.episodes.find((e) => e.id === ep.id);
  assert.equal(ep.pointId, byCode[ep0.pointId]); assert.deepEqual(ep.acks, ep0.acks); assert.equal(ep.severity, ep0.severity);
  const kv = Object.fromEntries(after.kv.map((x) => [x.key, x.value]));
  assert.equal(kv.ui.selectedId, byCode['P-007']); assert.equal(kv.settings.demo.lossPointId, byCode['P-005']);
  assert.deepEqual(kv.config, doc);
  assert.deepEqual(kv[BACKUP_KEY].config, raw, 'สำรอง config v5 ทั้งก้อน');
  assert.deepEqual(after.rejected_ingestion, []);
});

test('ย้อนกลับ (Rollback): ลบฐาน @v6 → ฐานเดิมใช้กับโค้ดรุ่นเดิมได้ทันที ข้อมูลครบ', async () => {
  const f = new IDBFactory();
  await seedSource(f, 'rb');
  const before = await dumpDb(f, 'rb');
  assert.equal((await migrateDatabase({ indexedDB: f, sourceName: 'rb', tenancy: T, manifest, now: NOW })).ok, true);
  await rollbackV6(f, 'rb');
  assert.equal(await dumpDb(f, v6Name('rb')), null, 'ฐาน v6 ถูกลบ');
  const repo = await new IdbRepo({ indexedDB: f, IDBKeyRange, name: 'rb' }).open();
  assert.deepEqual(await repo.getKV('config'), before.kv.find((x) => x.key === 'config').value);
  const e = await new MonitorEngine({ repo, config: createDefaultConfig(), source: 'demo', clock: new ManualClock(T0 + 30 * 60_000), idGen: idGen(), retention: { maxDays: 7, maxSamples: 100_000 } }).init();
  assert.ok(e.entry('WL-001', 'level').lastValid.value > 60, 'โค้ดรุ่นเดิมอ่านค่าล่าสุดได้');
  assert.equal(e.episodes()[0].acks[0].note, 'ตรวจแล้ว');
  repo.close();
});

test('กู้คืน (Restore): ย้ายซ้ำหลังลบได้ผลเหมือนเดิมทุกไบต์ · อ่าน config v5 จากสำรองได้ · ย้ายซ้ำขณะมีฐานอยู่ไม่เขียนทับ', async () => {
  const f = new IDBFactory();
  const raw = await seedSource(f, 'rs');
  await migrateDatabase({ indexedDB: f, sourceName: 'rs', tenancy: T, manifest, now: NOW });
  const first = await dumpDb(f, v6Name('rs'));
  const again = await migrateDatabase({ indexedDB: f, sourceName: 'rs', tenancy: T, manifest, now: () => 1 });
  assert.equal(again.existing, true);
  assert.deepEqual(await dumpDb(f, v6Name('rs')), first, 'ไม่เขียนทับฐาน v6 ที่มีอยู่');
  assert.deepEqual((await readV5Backup(f, 'rs')).config, raw);
  await rollbackV6(f, 'rs');
  await migrateDatabase({ indexedDB: f, sourceName: 'rs', tenancy: T, manifest, now: NOW });
  assert.deepEqual(await dumpDb(f, v6Name('rs')), first);
});

test('Migration หยุดเมื่อคีย์ชน: ไม่สร้างฐาน @v6 · ฐานเดิมไม่เปลี่ยน · คืนรายการจุด/ค่าวัดที่ชน', async () => {
  const f = new IDBFactory();
  await seedSource(f, 'cf', (c) => { c.points.find((p) => p.id === 'P-005').metrics[1].sourceKey = 'temp'; });
  const before = await dumpDb(f, 'cf');
  const r = await migrateDatabase({ indexedDB: f, sourceName: 'cf', tenancy: T, manifest, now: NOW });
  assert.equal(r.ok, false); assert.equal(r.stage, 'precheck');
  assert.deepEqual(r.conflicts[0].entries.map((e) => `${e.pointCode}/${e.metricId}`), ['P-005/temp', 'P-005/rh']);
  assert.equal(await dumpDb(f, v6Name('cf')), null, 'ไม่มีฐาน v6');
  assert.deepEqual(await dumpDb(f, 'cf'), before, 'ฐานเดิมไม่เปลี่ยน');
});

test('เขียนฐานใหม่ล้มเหลวกลางทาง → ลบฐาน @v6 ที่ไม่ครบทิ้ง · ฐานเดิมไม่เปลี่ยน', async () => {
  const real = new IDBFactory();
  await seedSource(real, 'wf');
  const before = await dumpDb(real, 'wf');
  const broken = new Proxy(real, { get(t, k) {
    if (k !== 'open') { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
    return (name, ver) => {
      const r = t.open(name, ver);
      if (name.endsWith('@v6')) r.addEventListener('success', () => { const db = r.result; db.transaction = () => { throw new Error('จำลองดิสก์เต็ม'); }; });
      return r;
    };
  } });
  const res = await migrateDatabase({ indexedDB: broken, sourceName: 'wf', tenancy: T, manifest, now: NOW });
  assert.equal(res.ok, false); assert.equal(res.stage, 'write'); assert.match(res.errors[0], /ดิสก์เต็ม/);
  assert.equal(await dumpDb(real, v6Name('wf')), null);
  assert.deepEqual(await dumpDb(real, 'wf'), before);
});
