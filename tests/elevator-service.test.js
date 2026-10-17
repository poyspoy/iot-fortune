import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElevatorService, liftStops } from '../src/domain/elevatorService.js';
import { ElevatorSim } from '../src/domain/elevatorSim.js';
import { ELEVATOR_L1 } from '../src/domain/elevator.js';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';

const FLOORS = createDefaultConfig().building.floors;

/** นาฬิกาและตัวจับเวลาปลอม (ไม่ต้องรอเวลาจริง) */
function fakeEnv(t0 = 1000) {
  const env = { t: t0, timers: new Map(), id: 0 };
  env.clock = () => env.t;
  env.scheduler = {
    setInterval: (fn, ms) => { const id = ++env.id; env.timers.set(id, { fn, ms, next: env.t + ms }); return id; },
    clearInterval: (id) => env.timers.delete(id),
  };
  env.advance = (ms) => {
    const end = env.t + ms;
    for (;;) {
      let due = null;
      for (const tm of env.timers.values()) if (tm.next <= end && (!due || tm.next < due.next)) due = tm;
      if (!due) break;
      env.t = due.next; due.next += due.ms; due.fn();
    }
    env.t = end;
  };
  return env;
}

/** เดินเวลาทีละ 100 ms จนเงื่อนไขเป็นจริง (คืนเวลาที่ใช้) */
function waitFor(env, cond, maxMs = 60000) {
  for (let t = 0; t <= maxMs; t += 100) { if (cond()) return t; env.advance(100); }
  throw new Error('หมดเวลารอ');
}

const make = (env, o = {}) => new ElevatorService({ clock: env.clock, scheduler: env.scheduler, seed: 7, ...o });

test('ชั้นที่จอด = สเปก ∩ ชั้นในอาคาร เรียงตามลำดับ', () => {
  assert.deepEqual(liftStops(ELEVATOR_L1, FLOORS), ['G', '1', '2', '3', '4', '5']);
  assert.deepEqual(liftStops(ELEVATOR_L1, FLOORS.filter((f) => f.id !== '2')), ['G', '1', '3', '4', '5']);
  assert.deepEqual(liftStops(ELEVATOR_L1, [{ id: '3', order: 3 }, { id: 'G', order: 0 }]), ['G', '3']);
  assert.deepEqual(liftStops(ELEVATOR_L1, []), []);
});

test('ไม่มี three.js / DOM: บริการทำงานใน Node ได้ทั้งหมด', () => {
  const env = fakeEnv();
  const svc = make(env).setBuilding(FLOORS);
  assert.ok(svc.available);
  assert.equal(svc.status().atFloor, 'G');
  assert.equal(typeof globalThis.document, 'undefined');
});

test('อาคารที่มีชั้นจอดน้อยกว่า 2 ชั้น: ไม่มีลิฟต์ คำสั่งคืน none', () => {
  const env = fakeEnv();
  const svc = make(env).setBuilding([{ id: 'G', order: 0 }]);
  assert.equal(svc.available, false);
  assert.equal(svc.status(), null);
  assert.equal(svc.request('3'), 'none');
  assert.equal(svc.step(), null);
});

test('ตัวจับเวลาของบริการพาลิฟต์ไปถึงชั้นที่สั่ง โดยไม่มีฉาก 3D', () => {
  const env = fakeEnv();
  const svc = make(env).setBuilding(FLOORS).start();
  assert.equal(svc.request('3'), 'started');
  const ms = waitFor(env, () => svc.status().atFloor === '3' && svc.status().phase === 'open');
  assert.ok(ms > 2000 && ms < 20000, `ใช้เวลา ${ms} ms`);
});

test('ผลเหมือนตัวจำลองเดิมทุกประการ (seed และนาฬิกาเดียวกัน)', () => {
  const env = fakeEnv(0);
  const svc = make(env).setBuilding(FLOORS);
  const ref = new ElevatorSim(['G', '1', '2', '3', '4', '5'], { now: 0, seed: 7 });
  svc.request('4'); ref.request('4', 0);
  for (let t = 16; t <= 40000; t += 16) {
    env.t = t; svc.step(); ref.step(t);
    if (t % 800 === 0) assert.deepEqual(svc.status(), ref.status(), `t=${t}`);
  }
});

test('step() เรียกซ้ำในเวลาเดียวกันไม่ทำให้ลิฟต์เดินเร็วขึ้น (ฉาก 3D + ตัวจับเวลาเรียกพร้อมกันได้)', () => {
  const a = fakeEnv(0); const b = fakeEnv(0);
  const one = make(a).setBuilding(FLOORS); const many = make(b).setBuilding(FLOORS);
  one.request('5'); many.request('5');
  for (let t = 16; t <= 20000; t += 16) {
    a.t = t; one.step();
    b.t = t; many.step(); many.step(); many.step();
  }
  assert.deepEqual(many.status(), one.status());
});

test('แจ้งผู้ฟังเฉพาะเมื่อสถานะที่แสดงเปลี่ยน และยกเลิกการฟังได้', () => {
  const env = fakeEnv();
  const svc = make(env).setBuilding(FLOORS);
  const got = [];
  const off = svc.onChange((s) => got.push(s.headline));
  svc.step(); svc.step();
  assert.equal(got.length, 0, 'สถานะไม่เปลี่ยน = ไม่แจ้ง');
  svc.request('2');
  assert.ok(got.length >= 1, 'คำสั่งผู้ใช้แจ้งทันที');
  const n = got.length;
  off();
  svc.request('4');
  assert.equal(got.length, n);
});

test('ตั้งอาคารซ้ำด้วยชั้นเดิม: ตัวจำลองเดิมเดินต่อ (ไม่เริ่มใหม่ที่ G)', () => {
  const env = fakeEnv();
  const svc = make(env).setBuilding(FLOORS).start();
  svc.setAuto(false);
  svc.request('3'); waitFor(env, () => svc.status().atFloor === '3');
  const sim = svc.sim;
  svc.setBuilding(FLOORS.map((f) => ({ ...f })));
  assert.equal(svc.sim, sim);
  assert.equal(svc.status().atFloor, '3');
  svc.setBuilding(FLOORS.filter((f) => f.id !== '5'));
  assert.notEqual(svc.sim, sim, 'ชั้นที่จอดเปลี่ยน = ตัวจำลองใหม่');
  assert.deepEqual(svc.floors(), ['G', '1', '2', '3', '4']);
});

test('อัตโนมัติ / หยุดชั่วคราว / รีเซ็ต', () => {
  const env = fakeEnv();
  const svc = make(env).setBuilding(FLOORS).start();
  svc.setAuto(false); assert.equal(svc.status().auto, false);
  svc.setPaused(true); assert.equal(svc.status().paused, true);
  svc.setPaused(false); svc.setAuto(true);
  svc.request('4'); waitFor(env, () => svc.status().atFloor === '4');
  svc.reset(); waitFor(env, () => svc.status().atFloor === 'G' && svc.status().phase === 'open');
});

test('นาฬิกาที่ตั้งเอง (ใช้กับการทดสอบเบราว์เซอร์/บันทึกคลิป)', () => {
  const env = fakeEnv(5000);
  const svc = make(env).setBuilding(FLOORS);
  svc.setManualClock(0);
  svc.setAuto(false);
  svc.request('2');
  for (let i = 0; i < 1500; i++) svc.advance(16);
  assert.equal(svc.status().atFloor, '2');
  assert.equal(env.t, 5000, 'ไม่ใช้เวลาจริง');
});

test('start/stop/dispose: ไม่มีตัวจับเวลาค้าง', () => {
  const env = fakeEnv();
  const svc = make(env).setBuilding(FLOORS);
  svc.start(); svc.start();
  assert.equal(env.timers.size, 1, 'start ซ้ำไม่สร้างตัวจับเวลาเพิ่ม');
  svc.stop(); assert.equal(env.timers.size, 0);
  svc.start(); svc.dispose();
  assert.equal(env.timers.size, 0);
  assert.equal(svc.running, false);
});

test('ชั้นที่ไม่มี: unknown-floor · ชั้นเดิม: same-floor', () => {
  const env = fakeEnv();
  const svc = make(env).setBuilding(FLOORS);
  assert.equal(svc.request('99'), 'unknown-floor');
  assert.equal(svc.request('G'), 'same-floor');
});
