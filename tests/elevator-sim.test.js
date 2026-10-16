import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElevatorSim, ELEVATOR_DEMO_CONFIG as C } from '../src/domain/elevatorSim.js';

const FLOORS = ['G', '1', '2', '3', '4', '5'];

/** เดินเวลาทีละ 16 ms (เหมือนเฟรม) แล้วตรวจกติกาทุกก้าว */
function runUntil(sim, cond, maxMs = 120000, check = true) {
  const samples = [];
  let prev = { pos: sim.pos, vel: sim.vel };
  const t0 = sim.t;
  while (!cond(sim)) {
    sim.step(sim.t + 16);
    const s = { t: sim.t, pos: sim.pos, vel: sim.vel, door: sim.door, phase: sim.phase, target: sim.target };
    if (check) {
      if (s.door > 0) assert.ok(Number.isInteger(s.pos) || Math.abs(s.pos - Math.round(s.pos)) < 1e-9, `ประตูเปิด ${s.door} ขณะไม่ตรงชั้น pos=${s.pos}`);
      if (s.phase === 'moving') assert.equal(s.door, 0, 'ประตูปิดสนิทระหว่างเคลื่อนที่');
      assert.ok(Math.abs(s.pos - prev.pos) <= C.maxSpeed * 0.016 + 1e-9, 'ไม่กระโดดข้ามตำแหน่ง');
      assert.ok(s.vel <= C.maxSpeed + 1e-9);
    }
    samples.push(s); prev = s;
    if (sim.t - t0 > maxMs) throw new Error('timeout');
  }
  return samples;
}

test('เริ่มอัตโนมัติทันที: วนเส้นทาง G → 3 → 5 → 1 → 4 → G โดยไม่ต้องกดอะไร (ไม่มีชั้นสุ่ม)', () => {
  const sim = new ElevatorSim(FLOORS, { config: { ...C, randomDetour: 0 }, now: 0 });
  const opened = [];
  runUntil(sim, (s) => { const l = s.log.filter((e) => e.type === 'opened'); return l.length >= 6; }, 300000);
  for (const e of sim.log.filter((x) => x.type === 'opened')) opened.push(e.floor);
  assert.deepEqual(opened.slice(0, 6), ['3', '5', '1', '4', 'G', '3']);
});

test('ลำดับสมจริง: จอด → ประตูเปิด → รอ 2–4 วินาที → ประตูปิด → เคลื่อน (เร่ง/คงที่/ชะลอ)', () => {
  const sim = new ElevatorSim(FLOORS, { config: { ...C, randomDetour: 0 }, now: 0 });
  const samples = runUntil(sim, (s) => s.log.filter((e) => e.type === 'opened').length >= 3, 300000);
  // ลำดับเฟส
  const seq = samples.map((x) => x.phase).filter((p, i, a) => p !== a[i - 1]);
  assert.deepEqual(seq.slice(0, 9), ['open', 'closing', 'moving', 'opening', 'open', 'closing', 'moving', 'opening', 'open']);
  // เวลารอประตูเปิด 2–4 วินาที
  const opens = sim.log.filter((e) => e.type === 'opened');
  const closes = sim.log.filter((e) => e.type === 'closing');
  for (let i = 0; i < 2; i++) {
    const wait = closes[i + 1].t - opens[i].t;
    assert.ok(wait >= 2000 - 20 && wait <= 4000 + 20, `รอ ${wait} ms`);
  }
  // โปรไฟล์ความเร็ว: G → 3 มีช่วงเร่ง ช่วงคงที่ ช่วงชะลอ
  const mv = samples.filter((x) => x.phase === 'moving');
  const firstLeg = mv.filter((x) => x.target === 3);
  const vmax = Math.max(...firstLeg.map((x) => x.vel));
  assert.ok(Math.abs(vmax - C.maxSpeed) < 1e-6, 'ถึงความเร็วสูงสุด');
  const cruise = firstLeg.filter((x) => Math.abs(x.vel - C.maxSpeed) < 1e-9).length;
  assert.ok(cruise > 10, 'มีช่วงวิ่งความเร็วคงที่');
  assert.ok(firstLeg[0].vel < vmax * 0.1 && firstLeg.at(-1).vel < vmax * 0.3, 'ออกตัวช้าและชะลอก่อนจอด');
});

test('สุ่มเวลารอ/ชั้นเล็กน้อย แต่ทำซ้ำได้ด้วย seed เดิม', () => {
  const run = (seed) => { const s = new ElevatorSim(FLOORS, { seed, now: 0 }); runUntil(s, (x) => x.log.filter((e) => e.type === 'opened').length >= 8, 600000); return s.log.filter((e) => e.type === 'opened').map((e) => `${e.floor}@${Math.round(e.t / 100)}`); };
  assert.deepEqual(run(3), run(3));
  assert.notDeepEqual(run(3), run(4));
});

test('คำสั่งผู้ใช้มีสิทธิ์ก่อน แล้วรอ 8–10 วินาทีจึงกลับอัตโนมัติ', () => {
  const sim = new ElevatorSim(FLOORS, { config: { ...C, randomDetour: 0 }, now: 0 });
  runUntil(sim, (s) => s.phase === 'moving' && s.target === 3);
  const r = sim.request('2', sim.t); // อยู่ทิศเดียวกัน ยังชะลอทัน → เปลี่ยนปลายทางต่อจากตำแหน่งปัจจุบัน
  assert.equal(r, 'retargeted');
  runUntil(sim, (s) => s.phase === 'open');
  assert.equal(sim.floors[sim.pos], '2');
  const opened = sim.log.filter((e) => e.type === 'opened').at(-1);
  assert.equal(opened.mode, 'user');
  runUntil(sim, (s) => s.phase === 'closing');
  const hold = sim.t - opened.t;
  assert.ok(hold >= 8000 - 20 && hold <= 10000 + 20, `รอหลังส่งผู้ใช้ ${hold} ms`);
  runUntil(sim, (s) => s.phase === 'moving');
  assert.equal(sim.mode, 'auto');
});

test('เปลี่ยนเป้าหมายย้อนทิศระหว่างวิ่ง: จอดตามแผนก่อน (ไม่กลับตัวกลางปล่อง) แล้วไปตามคำสั่ง', () => {
  const sim = new ElevatorSim(FLOORS, { config: { ...C, randomDetour: 0 }, now: 0 });
  runUntil(sim, (s) => s.phase === 'moving' && s.pos > 1.5);
  assert.equal(sim.request('G', sim.t), 'queued');
  const samples = runUntil(sim, (s) => s.log.filter((e) => e.type === 'opened').length >= 2, 120000);
  const op = sim.log.filter((e) => e.type === 'opened');
  assert.deepEqual(op.map((e) => e.floor), ['3', 'G']);
  // ไม่มีการกลับทิศระหว่างวิ่ง
  const legs = samples.filter((x) => x.phase === 'moving');
  for (let i = 1; i < legs.length; i++) if (legs[i].target === legs[i - 1].target) assert.ok(Math.sign(legs[i].pos - legs[i - 1].pos) * Math.sign(legs[i].target - legs[i].pos) >= 0);
});

test('หยุดชั่วคราว/ปิดอัตโนมัติ: จอดนิ่งประตูปิด · เปิดใหม่แล้ววิ่งต่อ · รีเซ็ตกลับ G เปิดประตูแล้วเริ่มรอบใหม่', () => {
  const sim = new ElevatorSim(FLOORS, { config: { ...C, randomDetour: 0 }, now: 0 });
  sim.setPaused(true);
  runUntil(sim, (s) => s.phase === 'closed', 30000);
  const t = sim.t; runUntil(sim, (s) => s.t > t + 10000);
  assert.equal(sim.phase, 'closed');
  sim.setPaused(false);
  runUntil(sim, (s) => s.phase === 'moving');
  runUntil(sim, (s) => s.phase === 'open');
  sim.reset(sim.t);
  runUntil(sim, (s) => s.phase === 'open' && s.floors[s.target] === 'G', 60000);
  runUntil(sim, (s) => s.phase === 'moving', 30000);
  assert.equal(sim.floors[sim.target], '3', 'รอบใหม่เริ่มจากต้นเส้นทาง');
});

test('ตำแหน่งต่อเนื่อง: เดินเวลาแบบกระโดดยาว (แท็บถูกพัก) ได้ผลเท่ากับเดินทีละเฟรม', () => {
  const a = new ElevatorSim(FLOORS, { now: 0 }); const b = new ElevatorSim(FLOORS, { now: 0 });
  a.step(45_000); for (let t = 16; t <= 45_000; t += 16) b.step(t); b.step(45_000);
  assert.ok(Math.abs(a.pos - b.pos) < 1e-9 && a.phase === b.phase);
});
