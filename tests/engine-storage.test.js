import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { IdbRepo } from '../src/store/idbRepo.js';
import { MonitorEngine } from '../src/engine.js';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { ManualClock } from '../src/domain/time.js';
import { makeBackup, validateBackup } from '../src/domain/backup.js';
import { demoPayloadBetween, demoValuesAt, DEMO_STEP_MS } from '../src/adapters/demoAdapter.js';
import { isEpisodeActive } from '../src/domain/alarms.js';
import { T0, iso, idGen } from './helpers.js';

async function newRepo(name = 'test') {
  return new IdbRepo({ indexedDB: new IDBFactory(), IDBKeyRange, name }).open();
}

async function newEngine(repo, source = 'api', clock = new ManualClock(T0), config = createDefaultConfig()) {
  return new MonitorEngine({ repo, config, source, clock, idGen: idGen(), retention: { maxDays: 7, maxSamples: 100_000 } }).init();
}

const P = (samples) => ({ schemaVersion: 1, samples });
const lvl = (v, at, seq) => ({ pointId: 'P-001', metricId: 'level', value: v, unit: 'cm', observedAt: iso(at), quality: 'good', sequence: seq });

test('IndexedDB: บันทึกจริงและอ่านคืนหลังเปิดฐานข้อมูลใหม่ (จำลองการรีโหลด)', async () => {
  const factory = new IDBFactory();
  const a = await new IdbRepo({ indexedDB: factory, IDBKeyRange, name: 'persist' }).open();
  const clock = new ManualClock(T0);
  const e1 = await newEngine(a, 'api', clock);
  await e1.ingest(P([lvl(130, T0 - 60_000, 1), lvl(131, T0 - 30_000, 2), lvl(132, T0, 3)]), { receivedAt: T0 });
  const ep = e1.episodes()[0];
  await e1.acknowledge(ep.id, { by: 'ช่างเอ', note: 'กำลังตรวจ' });
  await a.putKV('config', createDefaultConfig());
  a.close();

  const b = await new IdbRepo({ indexedDB: factory, IDBKeyRange, name: 'persist' }).open();
  const e2 = await newEngine(b, 'api', clock);
  assert.equal(e2.entry('P-001', 'level').lastValid.value, 132);
  const ep2 = e2.episodes()[0];
  assert.equal(ep2.acks[0].note, 'กำลังตรวจ');
  assert.ok(isEpisodeActive(ep2));
  assert.equal((await b.getSeries('api', 'P-001', 'level')).length, 3);
  assert.ok(await b.getKV('config'));
});

test('แยกแหล่งข้อมูล: ประวัติเดโมไม่ปรากฏเป็นค่าปัจจุบันของ API', async () => {
  const repo = await newRepo();
  const demo = await newEngine(repo, 'demo');
  await demo.ingest(P([lvl(99, T0, 1)]), { receivedAt: T0 });
  const api = await newEngine(repo, 'api');
  assert.equal(api.entry('P-001', 'level'), null);
  assert.equal(api.quality('P-001', 'level'), 'nodata');
  assert.equal((await repo.getSeries('api', 'P-001', 'level')).length, 0);
  await repo.clearSource('demo');
  assert.equal((await repo.getSeries('demo', 'P-001', 'level')).length, 0);
});

test('ข้อมูลเก่าไม่ทำให้การแจ้งเตือนกลับสู่ปกติ และไม่แสดงเป็นค่าปกติ', async () => {
  const repo = await newRepo();
  const clock = new ManualClock(T0);
  const e = await newEngine(repo, 'api', clock);
  await e.ingest(P([lvl(130, T0 - 60_000, 1), lvl(131, T0 - 30_000, 2), lvl(132, T0, 3)]), { receivedAt: T0 });
  assert.equal(e.kpis().criticalPoints, 0);
  assert.equal(e.episodes().length, 1);
  clock.advance(10 * 60_000); // ไม่มีข้อมูลใหม่ 10 นาที
  e.tick();
  assert.equal(e.quality('P-001', 'level'), 'stale');
  assert.ok(isEpisodeActive(e.episodes()[0]), 'การแจ้งเตือนยังคงเกิดอยู่');
  const st = e.pointStatus(e.config.points[0]);
  assert.equal(st.severity, 'warning');
  assert.equal(st.quality, 'stale');
  assert.equal(st.attention, true);
  // poll สำเร็จแต่ได้ค่าเดิมซ้ำ → ยังเก่าอยู่
  await e.ingest(P([lvl(132, T0, 3)]), { receivedAt: clock.now() });
  assert.equal(e.quality('P-001', 'level'), 'stale');
});

test('ค่าที่ไม่ถูกต้องไม่เขียนทับค่าที่ถูกต้อง และคุณภาพแสดง "ไม่ถูกต้อง"', async () => {
  const repo = await newRepo();
  const clock = new ManualClock(T0);
  const e = await newEngine(repo, 'api', clock);
  await e.ingest(P([lvl(50, T0, 1)]), { receivedAt: T0 });
  clock.advance(10_000);
  await e.ingest(P([{ ...lvl(51, T0 + 10_000, 2), value: 'x' }]), { receivedAt: clock.now() });
  assert.equal(e.entry('P-001', 'level').lastValid.value, 50);
  assert.equal(e.quality('P-001', 'level'), 'invalid');
  assert.equal(e.diag.byReason['invalid-value'], 1);
});

test('dwell ถูกล้างเมื่อข้อมูลเก่าระหว่างรอ แล้วไม่มีการแจ้งเตือนจากการขาดข้อมูล', async () => {
  const repo = await newRepo();
  const clock = new ManualClock(T0);
  const e = await newEngine(repo, 'api', clock);
  await e.ingest(P([lvl(130, T0, 1)]), { receivedAt: T0 }); // dwell 60s เริ่มนับ
  assert.equal(e.evaluator.pendingLevel('R-001')?.level, 'warning');
  clock.advance(200_000);
  e.tick();
  assert.equal(e.evaluator.pendingLevel('R-001'), null);
  assert.equal(e.episodes().length, 0);
});

test('เปลี่ยนขีดจำกัด: ประเมินค่าสดใหม่ทันที', async () => {
  const repo = await newRepo();
  const clock = new ManualClock(T0);
  const e = await newEngine(repo, 'api', clock);
  await e.ingest(P([lvl(100, T0, 1)]), { receivedAt: T0 });
  const c = structuredClone(e.config);
  const r = c.rules.find((x) => x.id === 'R-001');
  r.warning = 90; r.dwellSec = 0;
  await e.applyConfig(c);
  assert.equal(e.episodes().length, 1);
  assert.equal(e.episodes()[0].severity, 'warning');
});

test('นโยบายเก็บข้อมูล: ลบตามอายุ แล้วตามจำนวน', async () => {
  const repo = await newRepo();
  const mk = (i, at) => ({ id: `api:P-001:level:${at}`, source: 'api', pointId: 'P-001', metricId: 'level', value: i, unit: 'cm', observedAt: at, receivedAt: at, quality: 'good', sequence: i });
  const day = 86_400_000;
  await repo.addSamples([mk(1, T0 - 10 * day), mk(2, T0 - 8 * day), ...Array.from({ length: 10 }, (_, i) => mk(10 + i, T0 - i * 1000))]);
  const deleted = await repo.enforceRetention(T0, { maxDays: 7, maxSamples: 6 });
  assert.equal(deleted, 6);
  const left = await repo.getSeries('api', 'P-001', 'level');
  assert.equal(left.length, 6);
  assert.equal(Math.min(...left.map((s) => s.observedAt)), T0 - 5000, 'เหลือค่าที่ใหม่ที่สุด');
});

test('สำรองและกู้คืนในฐานข้อมูลแยก: เวลาเดิมยังเก่า และนำเข้าล้มเหลวไม่ทำลายข้อมูลเดิม', async () => {
  const src = await newRepo('src');
  const clock = new ManualClock(T0);
  const e = await newEngine(src, 'api', clock);
  await e.ingest(P([lvl(40, T0 - 3 * 3600_000, 1)]), { receivedAt: T0 - 3 * 3600_000 });
  await src.putKV('config', createDefaultConfig());
  const dump = await src.exportAll();
  const backup = JSON.parse(JSON.stringify(makeBackup({ ...dump, exportedAt: T0 })));
  assert.equal(validateBackup(backup).ok, true);

  const dst = await newRepo('dst');
  await dst.putKV('config', { marker: 'old' });
  await dst.addSamples([{ id: 'demo:P-002:level:1', source: 'demo', pointId: 'P-002', metricId: 'level', value: 1, unit: '%', observedAt: 1, receivedAt: 1, quality: 'good', sequence: null }]);

  // นำเข้าที่ล้มเหลวกลาง transaction (คีย์เสีย) → ข้อมูลเดิมต้องอยู่ครบ
  const broken = structuredClone(backup);
  broken.samples.push({ bad: 'no id' });
  await assert.rejects(dst.replaceAll(broken));
  assert.deepEqual(await dst.getKV('config'), { marker: 'old' });
  assert.equal((await dst.getSeries('demo', 'P-002', 'level')).length, 1);

  await dst.replaceAll(backup);
  const restored = await newEngine(dst, 'api', clock);
  assert.equal(restored.entry('P-001', 'level').lastValid.observedAt, T0 - 3 * 3600_000);
  assert.equal(restored.quality('P-001', 'level'), 'stale', 'คำนวณความสดใหม่ใหม่ ไม่ทำให้ค่าเก่ากลายเป็นสด');
  assert.equal((await dst.getSeries('demo', 'P-002', 'level')).length, 0, 'แทนที่ทั้งหมด');
});

test('เดโม deterministic: seed และสถานการณ์เดียวกันให้ค่าเดิม ไม่ขึ้นกับการแบ่งช่วง', () => {
  const params = { seed: 7, scenario: 'sump-rising', scenarioStartedAt: T0, lossPointId: 'P-005' };
  const whole = demoPayloadBetween(T0, T0 + 10 * DEMO_STEP_MS, params).samples;
  const parts = [
    ...demoPayloadBetween(T0, T0 + 3 * DEMO_STEP_MS, params).samples,
    ...demoPayloadBetween(T0 + 3 * DEMO_STEP_MS, T0 + 10 * DEMO_STEP_MS, params).samples,
  ];
  assert.deepEqual(parts, whole);
  const lv = (t) => demoValuesAt(t, params).find((x) => x[0] === 'P-001')[2];
  assert.ok(lv(T0 + 20 * 60_000) > lv(T0) + 100);
  const lost = demoValuesAt(T0 + 60_000, { ...params, scenario: 'device-loss' });
  assert.equal(lost.filter((x) => x[0] === 'P-005').length, 0);
  const leak = demoValuesAt(T0 + 2 * 60_000, { ...params, scenario: 'leak' }).find((x) => x[0] === 'P-008');
  assert.equal(leak[2], 'wet');
});

test('เดโมทั้งระบบ: สถานการณ์บ่อสูบน้ำทำให้เกิดการแจ้งเตือนแล้วกลับสู่ปกติเมื่อเปลี่ยนเป็นปกติ', async () => {
  const repo = await newRepo();
  const clock = new ManualClock(T0 + 20 * 60_000);
  const e = await newEngine(repo, 'demo', clock);
  const params = { seed: 1, scenario: 'sump-rising', scenarioStartedAt: T0, lossPointId: 'P-005' };
  await e.ingest(demoPayloadBetween(T0 - 60_000, T0 + 20 * 60_000, params), { receivedAt: clock.now() });
  const ep = e.episodes().find((x) => x.pointId === 'P-001');
  assert.equal(ep.severity, 'critical');
  const params2 = { ...params, scenario: 'normal' };
  clock.advance(2 * 60_000);
  await e.ingest(demoPayloadBetween(T0 + 20 * 60_000, clock.now(), params2), { receivedAt: clock.now() });
  const after = e.episodes().find((x) => x.id === ep.id);
  assert.ok(after.recoveredAt, 'กลับสู่ปกติด้วยค่าที่ถูกต้องใหม่');
  assert.equal(after.acks.length, 0, 'การกลับสู่ปกติไม่ใช่การรับทราบ');
  assert.equal(e.kpis().unresolvedAlerts >= 1, true);
});
