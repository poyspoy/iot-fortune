import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VehicleSim, Curve, wrap } from '../src/domain/vehicleSim.js';

const veh = JSON.parse(readFileSync(new URL('../public/mobility/floor-G.json', import.meta.url))).vehicles;
const dims = { wheelbase: 2.7 * 0.118, wheelRadius: 0.33 * 0.118 };

function run(dtFrame, secs) {
  const sim = new VehicleSim(veh, dims, { stallId: 'P05' });
  const log = [];
  for (let t = 0; t < secs; t += dtFrame) { sim.step(dtFrame); log.push({ ...sim.status(), h: sim.heading }); }
  return { sim, log };
}

test('ครบรอบ: เข้า → จอด (ไฟเบรก) → ถอยออก → ขับออก แล้ววนใหม่', () => {
  const { log } = run(1 / 60, 140);
  const order = []; for (const l of log) { const k = `${l.seg}:${l.state}`; if (order.at(-1) !== k) order.push(k); }
  for (const k of ['in:drive', 'in:parked', 'out:drive', 'out:pause', 'exit:drive']) assert.ok(order.includes(k), k);
  assert.ok(log.filter((l) => l.state === 'parked').every((l) => l.brake), 'จอดแล้วไฟเบรกติด');
  assert.ok(order.lastIndexOf('in:drive') > order.indexOf('exit:drive'), 'วนรอบใหม่');
});

test('ความเร็วต่อเนื่อง ไม่กระโดด และความเร็วไม่ติดลบ', () => {
  const { log } = run(1 / 60, 60);
  for (let i = 1; i < log.length; i++) {
    assert.ok(log[i].v >= 0);
    if (log[i].state === 'drive' && log[i - 1].state === 'drive') assert.ok(Math.abs(log[i].v - log[i - 1].v) < 0.32 / 60 + 0.002, `dv @${i}`);
  }
});

test('ล้อหมุนตามระยะทางจริง: มุมหมุนรวม = ระยะเดินหน้า − ระยะถอย หารรัศมีล้อ', () => {
  const sim = new VehicleSim(veh, dims, { stallId: 'P05' });
  let fwd = 0; let rev = 0; let last = sim.odometer;
  for (let i = 0; i < 100 * 45; i++) { const seg = sim.segment; sim.step(0.01); const d = sim.odometer - last; last = sim.odometer; if (seg?.reverse) rev += d; else fwd += d; }
  assert.ok(Math.abs(sim.spin - (fwd - rev) / dims.wheelRadius) < 1e-6);
});

test('ล้อหน้าเลี้ยวในโค้ง และคืนตรงบนทางตรง · หัวรถไม่สะบัด', () => {
  const { log } = run(1 / 60, 40);
  const turning = log.filter((l) => l.seg === 'in' && Math.abs(l.steer) > 0.15);
  assert.ok(turning.length > 10, 'มีช่วงหักเลี้ยว');
  const straight = log.filter((l) => l.seg === 'in' && l.x > 2 && l.state === 'drive');
  assert.ok(straight.every((l) => Math.abs(l.steer) < 0.02), 'ทางตรงล้อตรง');
  for (let i = 1; i < log.length; i++) if (log[i].state === 'drive' && log[i - 1].state === 'drive' && log[i].seg === log[i - 1].seg) assert.ok(Math.abs(wrap(log[i].h - log[i - 1].h)) < 0.05, `heading jump @${i}`);
});

test('ไม่ขึ้นกับอัตราเฟรม', () => {
  const a = run(1 / 60, 30).sim.status(); const b = run(1 / 20, 30).sim.status();
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.01, JSON.stringify([a, b]));
});

test('Curve: ผ่านจุดควบคุมต้น–ปลาย และความยาวสมเหตุสมผล', () => {
  const c = new Curve([[0, 0], [1, 0], [2, 1]]);
  assert.deepEqual([c.sample(0).x, c.sample(0).z], [0, 0]);
  const e = c.sample(c.length); assert.ok(Math.abs(e.x - 2) < 1e-9 && Math.abs(e.z - 1) < 1e-9);
  assert.ok(c.length > 2.3 && c.length < 2.6);
});
