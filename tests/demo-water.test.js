import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoValuesAt, SCENARIOS } from '../src/adapters/demoAdapter.js';

const T0 = Date.parse('2026-10-16T08:00:00Z');
const val = (t, params, id) => demoValuesAt(t, { seed: 1, lossPointId: null, ...params }).find(([p]) => p === id)[2];

test('สถานการณ์สาธิตครบ: ปกติ / บ่อสูง / ถังต่ำ / ทั้งสอง', () => {
  for (const k of ['normal', 'sump-rising', 'tank-low', 'both']) assert.ok(SCENARIOS[k], k);
});

test('ปกติ: บ่อ ~60 cm ถัง ~75 %', () => {
  const p = { scenario: 'normal', scenarioStartedAt: null };
  assert.ok(Math.abs(val(T0, p, 'WL-001') - 60) < 4);
  assert.ok(Math.abs(val(T0, p, 'WL-002') - 75) < 2);
});

test('บ่อสูงขึ้นค่อย ๆ ผ่านเฝ้าระวัง (120) แล้ววิกฤต (150) — ไม่กระโดด', () => {
  const p = { scenario: 'sump-rising', scenarioStartedAt: T0 };
  let prev = val(T0, p, 'WL-001'); let warnAt = null; let critAt = null;
  for (let i = 1; i <= 40; i++) {
    const t = T0 + i * 30_000; const v = val(t, p, 'WL-001');
    assert.ok(Math.abs(v - prev) < 8, `ก้าวละไม่เกิน 8 cm (${prev}→${v})`);
    if (warnAt === null && v >= 120) warnAt = i; if (critAt === null && v >= 150) critAt = i;
    prev = v;
  }
  assert.ok(warnAt && critAt && critAt > warnAt);
});

test('ทั้งสองเหตุการณ์: บ่อสูงขึ้นและถังลดลงพร้อมกัน แล้วค่อย ๆ กลับสู่ปกติเมื่อเลือก "ทำงานปกติ"', () => {
  const both = { scenario: 'both', scenarioStartedAt: T0 };
  const tEnd = T0 + 20 * 60_000;
  assert.ok(val(tEnd, both, 'WL-001') >= 150 && val(tEnd, both, 'WL-002') <= 25);
  const back = { scenario: 'normal', scenarioStartedAt: tEnd, prev: { scenario: 'both', startedAt: T0, endedAt: tEnd } };
  const a = val(tEnd + 30_000, back, 'WL-001');
  assert.ok(a > 140, 'ไม่กระโดดกลับทันที');
  assert.ok(val(tEnd + 20 * 60_000, back, 'WL-001') < 70 && val(tEnd + 20 * 60_000, back, 'WL-002') > 70, 'กลับสู่ปกติในที่สุด');
});
