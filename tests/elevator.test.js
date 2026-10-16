import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELEVATOR_L1, ELEVATOR_TIMING as T, createElevator, requestFloor, stepElevator, elevatorStatus, easeInOut, travelMs } from '../src/domain/elevator.js';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';

/** จำลองการเดินทางทีละ 16 ms แล้วตรวจกฎทุกเฟรม คืนประวัติ */
function run(state, floorId, t0) {
  const r = requestFloor(state, floorId, t0);
  assert.equal(r.result, 'started');
  let s = r.state; const log = [];
  let prevPos = s.pos; let maxStep = 0; let t = t0;
  while (s.phase !== 'open' || t === t0) {
    t += 16;
    s = stepElevator(s, t);
    const st = elevatorStatus(s);
    log.push({ t, phase: s.phase, pos: s.pos, door: s.door, st });
    // ประตูเปิด (door > 0) ได้เฉพาะเมื่อจอดตรงชั้นปลายทางแล้วเท่านั้น
    if (s.phase === 'moving') assert.equal(s.door, 0, 'ประตูต้องปิดสนิทระหว่างเคลื่อนที่');
    if (s.phase === 'opening' || (s.phase === 'open')) {
      assert.equal(s.pos, s.to, 'เปิดประตูเมื่อพื้นห้องลิฟต์ตรงชั้นพอดี');
      assert.ok(Number.isInteger(s.pos));
    }
    if (s.pos !== s.to) assert.ok(s.door === 0 || s.phase === 'closing', 'ห้ามเปิดประตูขณะยังไม่ตรงชั้น');
    if (s.phase === 'closing') { assert.equal(s.pos, s.from, 'ไม่ออกตัวก่อนประตูปิดสนิท'); assert.equal(st.direction, null, 'ลูกศรแสดงหลังประตูปิด'); }
    maxStep = Math.max(maxStep, Math.abs(s.pos - prevPos));
    prevPos = s.pos;
    assert.equal(st.buttonsEnabled, s.phase === 'open');
    if (t - t0 > 60000) throw new Error('ไม่ถึงปลายทาง');
  }
  return { s, log, maxStep, t };
}

test('ลิฟต์ L1 จอดเฉพาะชั้นที่มีในอาคารจริง และอยู่ภายในกรอบชั้นเหล่านั้น', () => {
  const cfg = createDefaultConfig();
  for (const id of ELEVATOR_L1.floors) assert.ok(cfg.building.floors.find((x) => x.id === id), `ไม่พบชั้น ${id}`);
  // ชั้นที่ยืนยันจากผัง: ปล่องอยู่ในกรอบชั้นนั้น
  for (const id of ELEVATOR_L1.verifiedFloors) {
    const m = cfg.building.floors.find((x) => x.id === id).model;
    assert.ok(Math.abs(ELEVATOR_L1.x - m.cx) < m.width / 2 && Math.abs(ELEVATOR_L1.z - m.cz) < m.depth / 2);
  }
  // ตำแหน่งปล่องห่างจากสัญลักษณ์ลิฟต์ทุกชั้นไม่เกินครึ่งความกว้างปล่อง + ระยะคลาดของผัง
  for (const e of ELEVATOR_L1.evidence) assert.ok(Math.hypot(e.x - ELEVATOR_L1.x, e.z - ELEVATOR_L1.z) < 0.2, e.floor);
});

test('easeInOut: เริ่ม/จบที่ความเร็วศูนย์ และต่อเนื่อง', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  const d0 = easeInOut(0.001) / 0.001; const d1 = (1 - easeInOut(0.999)) / 0.001;
  assert.ok(d0 < 0.01 && d1 < 0.01);
  assert.ok(easeInOut(0.5) > 0.49 && easeInOut(0.5) < 0.51);
});

test('ขึ้นจากชั้นล่างสุดไปชั้นบนสุด → ลงกลับชั้นล่าง → หยุดชั้นกลาง: ประตูเปิดหลังหยุดตรงชั้นทุกครั้ง', () => {
  let s = createElevator(ELEVATOR_L1);
  assert.equal(elevatorStatus(s).headline, 'จอดที่ชั้น G');
  // ขึ้นบนสุด
  let r = run(s, '3', 1000);
  assert.equal(r.s.pos, 3); assert.equal(r.s.door, 1);
  assert.equal(elevatorStatus(r.s).headline, 'ถึงชั้น 3');
  assert.equal(elevatorStatus(r.s).doorText, 'ประตูเปิด');
  assert.ok(r.log.some((x) => x.st.direction === 'up' && x.st.headline === '▲ กำลังขึ้นไปชั้น 3'));
  // ลำดับเฟส
  const phases = r.log.map((x) => x.phase).filter((p, i, a) => p !== a[i - 1]);
  assert.deepEqual(phases, ['closing', 'moving', 'opening', 'open']);
  // ไม่กระโดด: ระยะต่อเฟรม (16 ms) น้อยกว่า 0.03 ชั้น
  assert.ok(r.maxStep < 0.03, `step ${r.maxStep}`);
  // ออกตัวช้า ชะลอก่อนหยุด: ช่วงแรกและช่วงท้ายของการเคลื่อนที่เร็วน้อยกว่าช่วงกลาง
  const mv = r.log.filter((x) => x.phase === 'moving');
  const v = (i) => Math.abs(mv[i + 1].pos - mv[i].pos);
  const mid = Math.floor(mv.length / 2);
  assert.ok(v(0) < v(mid) / 10 && v(mv.length - 2) < v(mid) / 10);
  // ลงกลับชั้นล่าง
  s = r.s;
  r = run(s, 'G', r.t + 500);
  assert.equal(r.s.pos, 0);
  assert.ok(r.log.some((x) => x.st.direction === 'down' && x.st.arrow === '▼'));
  assert.equal(elevatorStatus(r.s).headline, 'ถึงชั้น G');
  // หยุดชั้นกลาง
  r = run(r.s, '2', r.t + 500);
  assert.equal(r.s.pos, 2);
  assert.equal(elevatorStatus(r.s).atFloor, '2');
  assert.equal(r.s.trips, 3);
});

test('กดชั้นเดิมไม่เดินทาง และระหว่างเดินทางไม่รับคำสั่งใหม่', () => {
  const s = createElevator(ELEVATOR_L1);
  assert.equal(requestFloor(s, 'G', 0).result, 'same-floor');
  const r = requestFloor(s, '2', 0);
  assert.equal(requestFloor(r.state, '3', 10).result, 'busy');
  const mid = stepElevator(r.state, T.doorMs + 500);
  assert.equal(mid.phase, 'moving');
  assert.equal(requestFloor(mid, '1', T.doorMs + 600).result, 'busy');
  assert.equal(elevatorStatus(mid).buttonsEnabled, false);
  assert.equal(requestFloor(s, '9', 0).result, 'unknown-floor');
});

test('กระโดดเวลาไกล (แท็บถูกพัก) ยังจบที่ชั้นปลายทางพร้อมประตูเปิด ไม่ข้ามลำดับ', () => {
  const s = createElevator(ELEVATOR_L1);
  const r = requestFloor(s, '3', 0);
  const end = stepElevator(r.state, 999999);
  assert.equal(end.phase, 'open'); assert.equal(end.pos, 3); assert.equal(end.door, 1);
  assert.equal(travelMs(0, 3), 3 * T.perFloorMs);
  assert.ok(T.doorMs >= 800 && T.doorMs <= 1200, 'ประตูปิด/เปิดประมาณ 1 วินาที');
  assert.equal(travelMs(0, 1), T.minTravelMs);
});

test('สาธิต: ขึ้น–ลงทุกชั้น และลำดับอัตโนมัติ G → 3 → 1 → 5 → G ประตูเปิดหลังหยุดตรงชั้นทุกครั้ง', () => {
  let s = createElevator(ELEVATOR_L1);
  let t = 0;
  const floors = ELEVATOR_L1.floors;
  const seq = [...floors.slice(1), ...[...floors].reverse().slice(1), '3', '1', '5', 'G'];
  for (const f of seq) {
    const r = run(s, f, t + 1000);
    assert.equal(floors[r.s.pos], f);
    assert.equal(r.s.door, 1);
    s = r.s; t = r.t;
  }
  assert.equal(s.trips, seq.length);
});
