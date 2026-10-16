import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PersonAgent, PERSON_CONFIG } from '../src/domain/personSim.js';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { planTo3D } from '../src/domain/geometry.js';

const data = JSON.parse(readFileSync(new URL('../public/mobility/floor-G.json', import.meta.url)));
const floor = createDefaultConfig().building.floors.find((f) => f.id === 'G');
const toLocal = ([x, y]) => { const p = planTo3D(floor, { x, y }, 0); return [p.x, p.z]; };
const poi = new Map(data.people.poi.map((p) => [p.id, p]));
const pathOf = (a, b) => data.people.paths[`${a}>${b}`] ?? [...data.people.paths[`${b}>${a}`]].reverse();
const plan = ['ent-center', 'shop-2', 'lift-L1', 'esc-2', 'ent-center'];
const legs = () => plan.slice(0, -1).map((a, i) => { const to = poi.get(plan[i + 1]); return { points: pathOf(a, plan[i + 1]).map(toLocal), stop: { kind: to.kind, face: to.faceTo ? toLocal(to.faceTo) : null } }; });

test('ลำดับพฤติกรรม: เดิน → หันเข้าร้าน → ยืนดู → เดินต่อ (มีหมุนตัวอยู่กับที่)', () => {
  const a = new PersonAgent(legs(), { loop: false });
  for (let i = 0; i < 60 * 240 && a.state !== 'done'; i++) a.step(1 / 60);
  const seq = a.log.map((l) => l.state);
  assert.ok(seq.includes('turn') && seq.includes('idle') && seq.includes('walk'), seq.join(','));
  assert.equal(a.state, 'done');
  const firstIdle = a.log.findIndex((l) => l.state === 'idle');
  assert.equal(a.log[firstIdle - 1].state, 'turn', 'หันหน้าเข้าร้านก่อนยืนดู');
});

test('หันตัวนุ่มนวล: มุมเปลี่ยนต่อช่วงเวลาไม่เกินอัตราที่กำหนด และความเร็วต่อเนื่อง', () => {
  const a = new PersonAgent(legs(), { loop: false });
  let ph = a.heading; let pv = 0; let maxDh = 0; let maxDv = 0;
  for (let i = 0; i < 100 * 120; i++) {
    a.step(0.01);
    maxDh = Math.max(maxDh, Math.abs(Math.atan2(Math.sin(a.heading - ph), Math.cos(a.heading - ph)))); ph = a.heading;
    maxDv = Math.max(maxDv, Math.abs(a.v - pv)); pv = a.v;
  }
  assert.ok(maxDh <= PERSON_CONFIG.turnRateWalk * 0.01 + 1e-9, `dh ${maxDh}`);
  assert.ok(maxDv <= PERSON_CONFIG.decel * 0.01 + 0.011, `dv ${maxDv}`);
});

test('ไม่ขึ้นกับอัตราเฟรม', () => {
  const a = new PersonAgent(legs()); const b = new PersonAgent(legs());
  for (let i = 0; i < 60 * 40; i++) a.step(1 / 60);
  for (let i = 0; i < 24 * 40; i++) b.step(1 / 24);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.005, `${a.x},${a.z} vs ${b.x},${b.z}`);
});
