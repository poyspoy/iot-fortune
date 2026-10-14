import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rawLevel, levelWithHysteresis, AlarmEvaluator, isEpisodeActive, isEpisodeAcknowledged, isEpisodeUnresolved,
} from '../src/domain/alarms.js';
import { rule, metric, obs, idGen, T0 } from './helpers.js';

const high = rule({ type: 'high', warning: 100, critical: 150, hysteresis: 5 });
const low = rule({ type: 'low', warning: 40, critical: 25, hysteresis: 3 });
const range = rule({ type: 'range', criticalLow: 30, warningLow: 40, warningHigh: 70, criticalHigh: 80, hysteresis: 2 });
const disc = rule({ type: 'discrete', states: { wet: 'critical' } });

test('ขอบเขต inclusive: ค่าเท่ากับขีดพอดีถือว่าถึงขีดแล้ว', () => {
  assert.equal(rawLevel(high, 99.999), 'normal');
  assert.equal(rawLevel(high, 100), 'warning');
  assert.equal(rawLevel(high, 150), 'critical');
  assert.equal(rawLevel(low, 40.001), 'normal');
  assert.equal(rawLevel(low, 40), 'warning');
  assert.equal(rawLevel(low, 25), 'critical');
  assert.equal(rawLevel(range, 40), 'warning');
  assert.equal(rawLevel(range, 55), 'normal');
  assert.equal(rawLevel(range, 70), 'warning');
  assert.equal(rawLevel(range, 80), 'critical');
  assert.equal(rawLevel(range, 30), 'critical');
  assert.equal(rawLevel(disc, 'wet'), 'critical');
  assert.equal(rawLevel(disc, 'dry'), 'normal');
});

test('ฮิสเทอรีซิสกฎค่าสูง: ต้องต่ำกว่า ขีด − h แบบเคร่งครัด', () => {
  assert.equal(levelWithHysteresis(high, 96, 'warning'), 'warning');
  assert.equal(levelWithHysteresis(high, 95, 'warning'), 'warning'); // 95 = 100−5 ยังไม่พ้น
  assert.equal(levelWithHysteresis(high, 94.9, 'warning'), 'normal');
  assert.equal(levelWithHysteresis(high, 146, 'critical'), 'critical');
  assert.equal(levelWithHysteresis(high, 144, 'critical'), 'warning');
  assert.equal(levelWithHysteresis(high, 90, 'critical'), 'normal');
});

test('ฮิสเทอรีซิสกฎค่าต่ำ: ต้องสูงกว่า ขีด + h แบบเคร่งครัด', () => {
  assert.equal(levelWithHysteresis(low, 43, 'warning'), 'warning');
  assert.equal(levelWithHysteresis(low, 43.1, 'warning'), 'normal');
  assert.equal(levelWithHysteresis(low, 27, 'critical'), 'critical');
  assert.equal(levelWithHysteresis(low, 28.5, 'critical'), 'warning');
});

test('ฮิสเทอรีซิสกฎช่วง ทั้งด้านบนและด้านล่าง', () => {
  assert.equal(levelWithHysteresis(range, 69, 'warning'), 'warning');
  assert.equal(levelWithHysteresis(range, 67.9, 'warning'), 'normal');
  assert.equal(levelWithHysteresis(range, 41, 'warning'), 'warning');
  assert.equal(levelWithHysteresis(range, 42.1, 'warning'), 'normal');
});

function feed(ev, r, m, values, step = 30_000, start = T0) {
  const out = [];
  values.forEach((v, i) => out.push(...ev.apply(r, m, obs(v, start + i * step))));
  return out;
}

test('dwell: ต้องเกินขีดต่อเนื่องครบเวลาจึงเปิดการแจ้งเตือน', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  const r = { ...high, dwellSec: 60 };
  const m = metric();
  feed(ev, r, m, [120, 120]); // t=0, 30s → ยังไม่ครบ 60s
  assert.equal(ev.episodes.size, 0);
  assert.deepEqual(ev.pendingLevel(r.id)?.level, 'warning');
  ev.apply(r, m, obs(121, T0 + 60_000));
  assert.equal(ev.episodes.size, 1);
  const ep = [...ev.episodes.values()][0];
  assert.equal(ep.severity, 'warning');
  assert.equal(ep.conditionSince, T0);
  assert.equal(ep.openedAt, T0 + 60_000);
});

test('ค่ากลับลงระหว่าง dwell ล้างการนับ', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  const r = { ...high, dwellSec: 60 };
  feed(ev, r, metric(), [120, 50, 120, 120]);
  assert.equal(ev.episodes.size, 0);
});

test('ข้อมูลขาดหายระหว่าง dwell (ช่องว่าง > เวลาหมดอายุ) ล้างการนับ', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  const r = { ...high, dwellSec: 60 };
  const m = metric({ staleAfterSec: 40 });
  ev.apply(r, m, obs(120, T0));
  ev.apply(r, m, obs(120, T0 + 100_000)); // ช่องว่าง 100s > 40s → เริ่มนับใหม่
  assert.equal(ev.episodes.size, 0);
  ev.apply(r, m, obs(120, T0 + 130_000));
  assert.equal(ev.episodes.size, 0);
  ev.apply(r, m, obs(120, T0 + 160_000));
  assert.equal(ev.episodes.size, 1);
});

test('breakPending (ข้อมูลเก่า) ล้าง dwell ที่ค้างแต่ไม่ล้างการแจ้งเตือนที่เกิดแล้ว', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  const r = { ...high, dwellSec: 60 };
  const m = metric();
  feed(ev, r, m, [120, 120, 120, 160]); // เปิด warning ที่ 60s, เริ่มนับ critical ที่ 90s
  assert.equal(ev.pendingLevel(r.id)?.level, 'critical');
  assert.equal(ev.breakPending(r.id), true);
  assert.equal(ev.pendingLevel(r.id), null);
  const ep = [...ev.episodes.values()][0];
  assert.ok(isEpisodeActive(ep), 'การแจ้งเตือนยังคงเกิดอยู่');
});

test('ยกระดับ warning → critical ใช้ episode เดิม ไม่สร้างใหม่ทุกครั้งที่ poll', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  feed(ev, high, metric(), [110, 120, 130, 160, 170, 180]);
  assert.equal(ev.episodes.size, 1);
  const ep = [...ev.episodes.values()][0];
  assert.equal(ep.severity, 'critical');
  assert.equal(ep.peakSeverity, 'critical');
  assert.equal(ep.escalatedAt, T0 + 3 * 30_000);
  assert.deepEqual(ep.events.map((e) => e.type), ['opened', 'escalated']);
  assert.equal(ep.lastValue, 180);
});

test('ค่าวิกฤตต่อเนื่องครบ dwell → เปิดเป็นวิกฤตใน episode เดียว', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  const r = { ...high, dwellSec: 60 };
  feed(ev, r, metric(), [200, 200, 200]);
  const ep = [...ev.episodes.values()][0];
  assert.equal(ep.severity, 'critical');
  assert.equal(ev.episodes.size, 1);
});

test('กลับสู่ปกติโดยไม่ได้รับทราบ → ยังนับเป็นเหตุการณ์ที่ยังไม่ปิด', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  feed(ev, high, metric(), [120, 90]);
  const ep = [...ev.episodes.values()][0];
  assert.equal(ep.recoveredAt, T0 + 30_000);
  assert.equal(isEpisodeActive(ep), false);
  assert.equal(isEpisodeAcknowledged(ep), false);
  assert.equal(isEpisodeUnresolved(ep), true);
  const acked = ev.acknowledge(ep.id, { by: 'ช่างสมชาย', note: 'ตรวจแล้ว', at: T0 + 60_000 });
  assert.equal(acked.recoveredAt, T0 + 30_000, 'การรับทราบไม่เปลี่ยนเวลากลับสู่ปกติ');
  assert.equal(isEpisodeUnresolved(acked), false);
});

test('รับทราบโดยยังไม่กลับสู่ปกติ → ยังเป็นการแจ้งเตือนที่เกิดอยู่', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  feed(ev, high, metric(), [120]);
  const ep = [...ev.episodes.values()][0];
  const acked = ev.acknowledge(ep.id, { by: 'A', note: '', at: T0 + 1 });
  assert.equal(isEpisodeActive(acked), true);
  assert.equal(isEpisodeAcknowledged(acked), true);
  assert.equal(isEpisodeUnresolved(acked), true);
  assert.throws(() => ev.acknowledge(ep.id, { by: '  ', note: '', at: T0 }));
});

test('รับทราบที่ระดับเตือน แล้วยกระดับเป็นวิกฤต → ต้องรับทราบใหม่', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  const m = metric();
  ev.apply(high, m, obs(120, T0));
  const id = [...ev.episodes.keys()][0];
  ev.acknowledge(id, { by: 'A', note: '', at: T0 + 1 });
  assert.equal(isEpisodeAcknowledged(ev.episodes.get(id)), true);
  ev.apply(high, m, obs(160, T0 + 30_000));
  assert.equal(isEpisodeAcknowledged(ev.episodes.get(id)), false);
});

test('หลังกลับสู่ปกติแล้วเกินขีดอีก → เปิด episode ใหม่', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  feed(ev, high, metric(), [120, 90, 120]);
  assert.equal(ev.episodes.size, 2);
});

test('กฎสถานะ: เปียก → วิกฤต, แห้ง → กลับสู่ปกติ', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  const m = metric({ kind: 'discrete', unit: '' });
  feed(ev, disc, m, ['dry', 'wet', 'wet', 'dry']);
  const ep = [...ev.episodes.values()][0];
  assert.equal(ev.episodes.size, 1);
  assert.equal(ep.severity, 'critical');
  assert.ok(ep.recoveredAt);
});

test('ค่าซ้ำไม่ถูกป้อนซ้ำ จึงไม่สร้างเหตุการณ์ใหม่ และ touch ไม่เปลี่ยน episode', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  const m = metric();
  ev.apply(high, m, obs(120, T0));
  const c = ev.apply(high, m, obs(120, T0));
  assert.equal(c.length, 0);
  assert.equal(ev.episodes.size, 1);
});

test('ประเมินใหม่หลังเปลี่ยนขีด: ค่าสดเดิมใต้ขีดใหม่ → กลับสู่ปกติด้วยค่าที่ถูกต้อง', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  const m = metric();
  ev.apply(high, m, obs(120, T0));
  const r2 = { ...high, warning: 130, critical: 160 };
  const changed = ev.apply(r2, m, obs(120, T0), { reevaluate: true });
  assert.equal(changed[0].recoveredAt, T0);
});

test('ปิดกฎ: episode ยุติด้วยเหตุผลปิดกฎ ไม่ใช่การกลับสู่ปกติ', () => {
  const ev = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  ev.apply(high, metric(), obs(120, T0));
  const [ep] = ev.disableRule(high.id, T0 + 5);
  assert.equal(ep.recoveredAt, null);
  assert.equal(ep.endReason, 'rule-disabled');
  assert.equal(isEpisodeActive(ep), false);
});

test('โหลด episode ที่ยังเกิดอยู่คืน แล้วกลับสู่ปกติด้วยค่าใหม่ได้', () => {
  const a = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  a.apply(high, metric(), obs(160, T0));
  const b = new AlarmEvaluator({ idGen: idGen(), source: 'demo' });
  b.loadEpisodes([...a.episodes.values()]);
  b.apply(high, metric(), obs(146, T0 + 30_000));
  const ep = [...b.episodes.values()][0];
  assert.equal(ep.severity, 'critical', 'ยังไม่พ้นฮิสเทอรีซิส');
  b.apply(high, metric(), obs(80, T0 + 60_000));
  assert.ok([...b.episodes.values()][0].recoveredAt);
});
