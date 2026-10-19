// Commit 4–6: กติกา Lifecycle ต่อเข้ากับ engine / KPI / แจ้งเตือน / เดโม และ Controller (overlay + Playground)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { IdbRepo } from '../src/store/idbRepo.js';
import { MonitorEngine } from '../src/engine.js';
import { Controller } from '../src/app/controller.js';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { ManualClock } from '../src/domain/time.js';
import { demoPayloadBetween, DEMO_STEP_MS } from '../src/adapters/demoAdapter.js';
import { SpatialRuntime, buildSpatialDoc, OVERLAY_KEY } from '../src/data/runtime.js';
import { playgroundConfig, playgroundOverlay, playgroundEnabled, PLAYGROUND_SEED_KEY } from '../src/data/playground.js';
import { legacyEntityId } from '../src/data/ids.js';
import { FORTUNE_TENANCY as T } from '../src/data/fortuneTenancy.js';
import { T0, iso, idGen } from './helpers.js';

const manifest = JSON.parse(readFileSync('public/asset-manifest.json', 'utf8'));
const pid = (code) => legacyEntityId(T.organization.namespaceId, T.project.id, 'point', code);
const aid = (code) => legacyEntityId(T.organization.namespaceId, T.project.id, 'asset', code);
const P = (samples) => ({ schemaVersion: 1, samples });
const repo = (name = 'lc') => new IdbRepo({ indexedDB: new IDBFactory(), IDBKeyRange, name }).open();

async function engineFor(config, spatial, clock = new ManualClock(T0)) {
  const rejected = [];
  const e = await new MonitorEngine({
    repo: await repo(), config, source: 'api', clock, idGen: idGen(), retention: null,
    decide: spatial ? (code) => spatial.decisionByCode(code) : undefined,
    onRejected: (list) => rejected.push(...list),
  }).init();
  return { e, rejected };
}

test('Fortune เดิม: ทุกจุดรับข้อมูลได้ · ผล KPI/คุณภาพเท่ากับ engine ที่ไม่มีกติกา Lifecycle', async () => {
  const cfg = createDefaultConfig();
  const sp = new SpatialRuntime(cfg, { manifest });
  assert.equal(sp.error, null);
  for (const p of cfg.points) assert.deepEqual(sp.decisionByCode(p.id), { accept: true, reason: null });
  const payload = demoPayloadBetween(T0 - 10 * DEMO_STEP_MS, T0, { seed: 1, scenario: 'both', scenarioStartedAt: T0 - 3600_000, speed: 1 });
  const a = await engineFor(cfg, sp); const b = await engineFor(cfg, null);
  const ra = await a.e.ingest(payload, { receivedAt: T0 }); const rb = await b.e.ingest(payload, { receivedAt: T0 });
  assert.equal(ra.accepted.length, rb.accepted.length);
  assert.deepEqual(a.e.kpis(), b.e.kpis());
  for (const p of cfg.points) assert.deepEqual(a.e.pointStatus(p), b.e.pointStatus(p));
  assert.equal(a.rejected.length, 0);
});

test('จุดยังไม่ติดตั้ง: ปฏิเสธ not-installed + ส่ง audit · คุณภาพ "ยังไม่ติดตั้ง" · ไม่นับ KPI · ไม่แจ้งเตือนแม้ค่าเกินเกณฑ์', async () => {
  const cfg = playgroundConfig();
  const sp = new SpatialRuntime(cfg, { manifest, overlay: playgroundOverlay() });
  assert.equal(sp.error, null);
  assert.deepEqual(sp.decisionByCode('PG-102'), { accept: false, reason: 'not-installed' });
  const { e, rejected } = await engineFor(cfg, sp);
  const hot = (v, t) => ({ pointId: 'PG-102', metricId: 'temp', value: v, unit: '°C', observedAt: iso(t), quality: 'good', sequence: t / 1000 });
  const r = await e.ingest(P([hot(35, T0 - 120_000), hot(36, T0 - 60_000), hot(37, T0)]), { receivedAt: T0 });
  assert.equal(r.accepted.length, 0);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['not-installed', 'not-installed', 'not-installed']);
  assert.equal(rejected.length, 3);
  assert.equal(e.quality('PG-102', 'temp'), 'not-installed');
  const pg = cfg.points.find((p) => p.id === 'PG-102');
  assert.equal(e.pointStatus(pg).quality, 'not-installed');
  assert.equal(e.pointStatus(pg).attention, false);
  assert.equal(e.episodes().filter((x) => x.pointId === 'PG-102').length, 0);
  // KPI: 8 จุดเดิม (ติดตั้งแล้ว/ส่งมอบแล้ว) — จุดทดลองที่ยังไม่ติดตั้งไม่นับ
  assert.equal(e.kpis().activePoints, 8);
});

test('กติกาเดียว: Asset ปลดระวางยับยั้งข้อมูลของจุดที่ผูก · Asset "เสนอ" ไม่ยับยั้ง แต่ขึ้นรายการตรวจสอบ', async () => {
  const cfg = createDefaultConfig();
  const sp = new SpatialRuntime(cfg, { manifest });
  sp.setOverlayEntry('asset', aid('FRT-DEMO-PUMP-001'), { installation: 'decommissioned' });
  sp.setOverlayEntry('asset', aid('FRT-DEMO-AHU-001'), { installation: 'proposed' });
  sp.rebuild(cfg);
  assert.deepEqual(sp.decisionByCode('P-003'), { accept: false, reason: 'asset-retired' });
  assert.deepEqual(sp.decisionByCode('P-004'), { accept: true, reason: null });
  const review = sp.service.reviewList();
  assert.ok(review.some((x) => x.issue === 'status-mismatch' && x.code === 'P-004'));
  assert.ok(review.some((x) => x.issue === 'status-mismatch' && x.code === 'P-003'));
  // ปั๊มที่ปลดระวางไม่แสดงภาพ (pumps() เฉพาะที่แสดงได้)
  assert.equal(sp.pumps().length, 0);
  const { e } = await engineFor(cfg, sp);
  const r = await e.ingest(P([{ pointId: 'P-003', metricId: 'run', value: 'run', unit: '', observedAt: iso(T0), quality: 'good', sequence: 1 }]), { receivedAt: T0 });
  assert.equal(r.rejected[0].reason, 'asset-retired');
});

test('เดโม: ไม่สร้างค่าให้จุดที่กติกาไม่รับ (เปลี่ยนสถานะกลับ = สร้างต่อ ไม่ย้อนเติมช่วงที่ปิด)', () => {
  const params = { seed: 1, scenario: 'normal', scenarioStartedAt: null, speed: 1 };
  const all = demoPayloadBetween(T0 - 5 * DEMO_STEP_MS, T0, params);
  const some = demoPayloadBetween(T0 - 5 * DEMO_STEP_MS, T0, params, (code) => code !== 'WL-001');
  assert.ok(all.samples.some((s) => s.pointId === 'WL-001'));
  assert.equal(some.samples.filter((s) => s.pointId === 'WL-001').length, 0);
  assert.equal(some.samples.length, all.samples.length - all.samples.filter((s) => s.pointId === 'WL-001').length);
});

test('ตำแหน่ง: ผังที่ใช้วางต่างจากผังปัจจุบัน → needs_remapping (plan-changed) ตรวจพบเอง · ยืนยันแล้วหายจากรายการ', () => {
  const cfg = playgroundConfig();
  const sp = new SpatialRuntime(cfg, { manifest, overlay: playgroundOverlay() });
  const m = sp.mappingByCode('P-005');
  assert.equal(m.status, 'needs_remapping');
  assert.deepEqual(m.reasons, ['plan-changed']);
  const review = sp.service.reviewList();
  assert.ok(review.find((x) => x.code === 'P-005' && x.issue === 'needs-remapping'));
  assert.ok(review.find((x) => x.code === 'FRT-DEMO-PUMP-001' && x.issue === 'needs-remapping' && x.reasons.includes('manual')));
  // จุดที่ต้องตรวจตำแหน่งยังรับข้อมูล/แจ้งเตือนตามปกติ (ติดตั้งแล้ว)
  assert.equal(sp.decisionByCode('P-005').accept, true);
  const f = sp.service.floor(sp.pointByCode('P-005').floorId);
  sp.setOverlayEntry('point', pid('P-005'), { resolvedAgainst: { coordinateSystemVersion: 'crs-1', floorPlanVersion: f.floorPlanVersion, modelVersion: f.modelVersion }, mapping: { status: 'unanchored', reasons: [] } });
  sp.rebuild(cfg);
  assert.equal(sp.mappingByCode('P-005').status, 'unanchored');
  assert.ok(!sp.service.reviewList().some((x) => x.code === 'P-005'));
});

test('ถัง/บ่อ/ปั๊ม จาก Asset + Binding (ไม่มีรหัสจุดในโค้ด) · ตำแหน่ง 2D→3D ตรงกับสูตรเดิม', async () => {
  const { planTo3D } = await import('../src/domain/geometry.js');
  const cfg = playgroundConfig();
  const sp = new SpatialRuntime(cfg, { manifest, overlay: playgroundOverlay() });
  const tanks = sp.tanks();
  assert.deepEqual(tanks.map((t) => [t.asset.assetCode, t.pointCode, t.asset.installation.status]), [
    ['FRT-DEMO-PIT-001', 'WL-001', 'installed'], ['FRT-DEMO-TANK-001', 'WL-002', 'installed'], ['FRT-DEMO-TANK-002', 'PG-104', 'proposed'],
  ]);
  for (const t of tanks) {
    const p = cfg.points.find((x) => x.id === t.pointCode);
    const floor = cfg.building.floors.find((f) => f.id === p.floorId);
    const old = planTo3D(floor, p.plan, 0);
    assert.ok(Math.abs(t.position.building.x - old.x) < 1e-12 && Math.abs(t.position.building.z - old.z) < 1e-12);
  }
  const pumps = sp.pumps();
  assert.deepEqual(pumps.map((p) => [p.asset.assetCode, p.pointCode, p.metricId]), [['FRT-DEMO-PUMP-001', 'P-003', 'run']]);
});

test('Controller: ไม่ใช่ Playground = ไม่สร้างข้อมูลทดลอง และแก้สถานะไม่ได้', async () => {
  const ctl = new Controller({ dbName: 'normal', idb: { indexedDB: new IDBFactory(), IDBKeyRange }, manifest });
  await ctl.init();
  try {
    assert.equal(ctl.config.points.length, 8);
    assert.equal(await ctl.repo.getKV(PLAYGROUND_SEED_KEY), undefined);
    const r = await ctl.setInstallStatus('point', pid('WL-001'), 'proposed');
    assert.equal(r.ok, false);
    assert.equal(ctl.decisionOf('WL-001').accept, true);
  } finally { ctl.stopSource(); }
});

test('Controller Playground: สร้างข้อมูลทดลอง · เปลี่ยนสถานะบันทึกถาวร · รีเซ็ตกลับค่าเริ่มต้น', async () => {
  const idb = { indexedDB: new IDBFactory(), IDBKeyRange };
  const ctl = new Controller({ dbName: 'pg', idb, manifest, playground: true });
  await ctl.init();
  try {
    assert.equal(ctl.config.points.length, 12);
    assert.equal(ctl.decisionOf('PG-101').reason, 'not-installed');
    assert.equal(ctl.engine.kpis().activePoints, 8);
    assert.equal((await ctl.setInstallStatus('point', pid('WL-001'), 'proposed')).ok, true);
    assert.equal(ctl.decisionOf('WL-001').reason, 'not-installed');
    assert.equal(ctl.engine.quality('WL-001', 'level'), 'not-installed');
    assert.equal(ctl.engine.kpis().activePoints, 7);
    const saved = await ctl.repo.getKV(OVERLAY_KEY);
    assert.equal(saved.points[pid('WL-001')].installation, 'proposed');
    assert.equal((await ctl.setMapping('point', pid('P-005'), 'confirm')).ok, true);
    assert.ok(!ctl.spatial.service.reviewList().some((x) => x.code === 'P-005'));
    assert.equal((await ctl.resetPlayground()).ok, true);
    assert.equal(ctl.decisionOf('WL-001').accept, true);
    assert.ok(ctl.spatial.service.reviewList().some((x) => x.code === 'P-005'));
    assert.deepEqual(await ctl.repo.getKV(OVERLAY_KEY), playgroundOverlay());
  } finally { ctl.stopSource(); }
  // เปิดใหม่ (รีโหลด) ไม่สร้างข้อมูลทดลองซ้ำทับของเดิม
  const again = new Controller({ dbName: 'pg', idb, manifest, playground: true });
  await again.init();
  again.stopSource();
  assert.equal(again.config.points.length, 12);
});

test('Playground เปิดเฉพาะ build ของสาขานี้ + ฐานข้อมูล data-layer-playground + ไม่ใช่โดเมน Demo', () => {
  assert.equal(playgroundEnabled({ buildFlag: true, dbParam: 'data-layer-playground', hostname: 'feature-data-layer.iot-fortune-preview.pages.dev' }), true);
  assert.equal(playgroundEnabled({ buildFlag: true, dbParam: 'data-layer-playground-2', hostname: 'localhost' }), true);
  assert.equal(playgroundEnabled({ buildFlag: false, dbParam: 'data-layer-playground', hostname: 'localhost' }), false);
  assert.equal(playgroundEnabled({ buildFlag: true, dbParam: 'test1', hostname: 'localhost' }), false);
  assert.equal(playgroundEnabled({ buildFlag: true, dbParam: null, hostname: 'localhost' }), false);
  assert.equal(playgroundEnabled({ buildFlag: true, dbParam: 'data-layer-playground', hostname: 'iot-fortune-preview.pages.dev' }), false);
  assert.equal(playgroundEnabled({ buildFlag: true, dbParam: 'data-layer-playground', hostname: 'poyspoy.github.io' }), false);
});

test('overlay ใช้ UUID เป็นคีย์ · ค่าที่ไม่รู้จักถูกตัดทิ้ง · ไม่ทำให้เอกสารไม่ผ่านการตรวจ', () => {
  const cfg = createDefaultConfig();
  const r = buildSpatialDoc(cfg, { manifest, overlay: { points: { [pid('WL-001')]: { installation: 'bogus', mapping: { status: 'weird' } }, 'not-a-uuid': { installation: 'installed' } } } });
  assert.equal(r.ok, true);
  assert.equal(r.doc.points.find((p) => p.pointCode === 'WL-001').installation.status, 'installed');
});
