import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MobilitySim, MOBILITY_LEVELS, Route } from '../src/domain/mobilitySim.js';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { planTo3D } from '../src/domain/geometry.js';

const data = JSON.parse(readFileSync(new URL('../public/mobility/floor-G.json', import.meta.url)));
const floor = createDefaultConfig().building.floors.find((f) => f.id === 'G');
const toLocal = ([x, y]) => { const p = planTo3D(floor, { x, y }, 0); return [p.x, p.z]; };

test('ข้อมูลเส้นทาง: ทุกคู่จุดหมายมีเส้นทาง และรถมีช่องจอด', () => {
  const ids = data.people.poi.map((p) => p.id);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) assert.ok(data.people.paths[`${ids[i]}>${ids[j]}`]?.length >= 2, `${ids[i]}>${ids[j]}`);
  assert.ok(data.vehicles.stalls.length >= 5);
  assert.match(data.disclaimer, /ไม่ใช่ข้อมูลติดตามบุคคลจริง/);
});

test('จำนวนตามระดับ และมือถือลดลงอัตโนมัติ · ปรับระดับไม่รีเซ็ตตัวเดิม', () => {
  const sim = new MobilitySim(data, toLocal, { level: 'high' });
  assert.equal(sim.people.length, MOBILITY_LEVELS.high.people);
  assert.equal(sim.cars.length, MOBILITY_LEVELS.high.cars);
  sim.step(20);
  const keep = sim.people[0];
  sim.setLevel('low');
  assert.equal(sim.people.length, 6); assert.equal(sim.cars.length, 2);
  assert.equal(sim.people[0], keep);
  sim.setLevel('off'); assert.equal(sim.people.length + sim.cars.length, 0);
  const m = new MobilitySim(data, toLocal, { level: 'high', small: true });
  assert.ok(m.people.length < 15 && m.cars.length < 5);
});

test('ไม่ขึ้นกับอัตราเฟรม: เดิน 30 วินาทีด้วย 60 fps เท่ากับ 15 fps', () => {
  const a = new MobilitySim(data, toLocal, { seed: 3, level: 'medium' });
  const b = new MobilitySim(data, toLocal, { seed: 3, level: 'medium' });
  for (let i = 0; i < 1800; i++) a.step(1 / 60);
  for (let i = 0; i < 450; i++) b.step(1 / 15);
  for (let i = 0; i < a.people.length; i++) { assert.ok(Math.abs(a.people[i].x - b.people[i].x) < 0.02); assert.ok(Math.abs(a.people[i].z - b.people[i].z) < 0.02); }
  for (let i = 0; i < a.cars.length; i++) assert.ok(Math.hypot(a.cars[i].x - b.cars[i].x, a.cars[i].z - b.cars[i].z) < 0.05);
});

test('ความเร็วเปลี่ยนต่อเนื่อง (เร่ง/ชะลอ) ไม่กระโดด และรถจอดแล้วออกจากพื้นที่', () => {
  const sim = new MobilitySim(data, toLocal, { seed: 9, level: 'high' });
  const dt = 1 / 30; let maxDv = 0; const prev = new Map();
  const states = new Set();
  for (let i = 0; i < 30 * 120; i++) {
    sim.step(dt);
    for (const c of sim.cars) { const pv = prev.get(c.id); if (pv !== undefined && c.visible) maxDv = Math.max(maxDv, Math.abs(c.v - pv)); prev.set(c.id, c.visible ? c.v : 0); states.add(c.state); }
  }
  assert.ok(maxDv <= sim.cfg.car.decel * dt + 0.031, `dv ${maxDv}`); // ยอมให้หยุดสนิทจากความเร็วคืบ 0.03
  for (const s of ['in', 'parked', 'out', 'exit']) assert.ok(states.has(s), s);
  // ช่องจอดไม่ถูกใช้ซ้อนกัน
  const busy = sim.stalls.filter((s) => s.busy).map((s) => s.busy);
  assert.equal(new Set(busy).size, busy.length);
});

test('Route: ตำแหน่งตามระยะทาง', () => {
  const r = new Route([[0, 0], [3, 0], [3, 4]]);
  assert.equal(r.length, 7);
  assert.deepEqual([r.at(5).x, r.at(5).z], [3, 2]);
});
