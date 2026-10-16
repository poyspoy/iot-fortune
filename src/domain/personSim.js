// คนจำลอง 1 คน (ข้อมูลจำลอง · ไม่ใช่ข้อมูลติดตามบุคคลจริง)
// เดินตามเส้นทางบนทางเดินจริง (คำนวณล่วงหน้า ไม่ทะลุผนัง/ร้าน) → หยุดดูร้าน/รอลิฟต์ → หันตัวช้า ๆ → เดินต่อ
// ความเร็วเปลี่ยนต่อเนื่อง (เร่ง/ชะลอ) · ตัวหันตามแนวทางอย่างนุ่มนวล · ถ้ามุมต่างมาก หยุดแล้วหมุนตัวอยู่กับที่ (Turn)
// ใช้ช่วงเวลาคงที่ 10 ms + ประมาณค่าระหว่างสถานะ → ผลเท่ากันทุกอัตราเฟรม

import { Route } from './mobilitySim.js';

export const PERSON_CONFIG = Object.freeze({
  vmax: 0.135,        // หน่วยฉาก/วินาที (≈ 1.15 ม./วิ) เดินในห้าง
  accel: 0.16, decel: 0.2,
  turnRateWalk: 2.2,  // เรเดียน/วินาที ขณะเดิน (หันตามทางโค้ง)
  turnRateStand: 1.7, // หมุนตัวอยู่กับที่
  turnInPlace: 0.75,  // มุมต่าง (เรเดียน) ที่ต้องหยุดหมุนตัวก่อนเดิน
  dwellShop: [3, 5], dwellLift: [3, 4],
});
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class PersonAgent {
  /**
   * @param {Array<{ points:[number,number][], stop?: { kind:string, face?:[number,number]|null, dwell?:number } }>} legs  พิกัดในกลุ่มชั้น (x, z)
   */
  constructor(legs, { config = PERSON_CONFIG, loop = true } = {}) {
    this.cfg = config; this.loop = loop;
    this.legs = legs.map((l) => ({ ...l, route: new Route(l.points) }));
    this.t = 0; this.restart();
  }

  restart() {
    this.leg = 0; this.s = 0; this.v = 0; this.state = 'turn'; this.until = 0; this.turnTarget = null;
    const a = this.legs[0].route.at(0.02);
    this.x = this.legs[0].points[0][0]; this.z = this.legs[0].points[0][1];
    this.heading = Math.atan2(a.dx, a.dz); this.turnRate = 0; this.log = [];
    this.state = 'walk';
  }

  get route() { return this.legs[this.leg]?.route; }

  step(dt) {
    const H = 0.01;
    this.acc = (this.acc ?? 0) + Math.max(0, Math.min(dt, 5));
    while (this.acc >= H - 1e-9) { this.prev = { x: this.x, z: this.z, h: this.heading }; this.#tick(H); this.acc -= H; }
    this.alpha = this.acc / H;
  }

  #setState(s) { if (this.state !== s) { this.state = s; this.log.push({ t: +this.t.toFixed(2), state: s, leg: this.leg }); } }

  #turnToward(target, rate, dt) {
    const d = wrap(target - this.heading);
    const step = Math.max(-rate * dt, Math.min(rate * dt, d));
    this.heading = wrap(this.heading + step);
    this.turnRate = step / dt;
    return Math.abs(d - step) < 0.02;
  }

  #tick(dt) {
    const C = this.cfg; this.t += dt; this.turnRate = 0;
    if (this.state === 'turn') {          // หมุนตัวอยู่กับที่ (Turn) จนหันตรงทิศที่ต้องการ
      this.v = 0;
      if (this.#turnToward(this.turnTarget, C.turnRateStand, dt)) {
        if (this.after === 'idle') { this.#setState('idle'); } else { this.#setState('walk'); }
      }
      return;
    }
    if (this.state === 'idle') {          // ยืนดูร้าน / ยืนรอ
      this.v = 0;
      if (this.t < this.until) return;
      this.leg++;
      if (this.leg >= this.legs.length) { if (!this.loop) { this.#setState('done'); return; } this.restart(); return; }
      this.s = 0;
      this.#beginLeg();
      return;
    }
    if (this.state === 'done') return;
    // เดิน
    const r = this.route; const remain = r.length - this.s;
    const brake = (this.v * this.v) / (2 * C.decel) + 0.002;
    const bend = r.bendAhead(this.s, 0.1);
    let vt = C.vmax * (bend > 1.0 ? 0.55 : bend > 0.5 ? 0.8 : 1);
    if (this.blocked) vt = 0;              // มีคนขวางหน้า: ชะลอ/ยืนรอ
    if (remain <= brake) vt = 0;
    this.v = vt > this.v ? Math.min(vt, this.v + C.accel * dt) : Math.max(vt, this.v - C.decel * dt);
    if (remain <= brake) this.v = Math.max(Math.min(this.v, Math.sqrt(2 * C.decel * Math.max(0, remain))), Math.min(0.01, remain / dt));
    this.s = Math.min(r.length, this.s + this.v * dt);
    const a = r.at(this.s);
    this.x = a.x; this.z = a.z;
    this.#turnToward(Math.atan2(a.dx, a.dz), C.turnRateWalk, dt);
    if (r.length - this.s <= 1e-4) this.#arrive();
  }

  #beginLeg() {
    const a = this.route.at(Math.min(0.03, this.route.length));
    const want = Math.atan2(a.dx, a.dz);
    if (Math.abs(wrap(want - this.heading)) > this.cfg.turnInPlace) { this.turnTarget = want; this.after = 'walk'; this.#setState('turn'); }
    else this.#setState('walk');
  }

  #arrive() {
    const C = this.cfg; this.v = 0;
    const stop = this.legs[this.leg].stop ?? {};
    const dwell = stop.dwell ?? (stop.kind === 'lift' || stop.kind === 'escalator' ? C.dwellLift[0] : stop.kind === 'shop' ? C.dwellShop[0] : 0.6);
    this.until = this.t + dwell + 0.0;
    if (stop.face) {                       // หันหน้าเข้าร้าน/ลิฟต์ก่อนยืนดู
      this.turnTarget = Math.atan2(stop.face[0] - this.x, stop.face[1] - this.z);
      this.after = 'idle'; this.#setState('turn');
      this.until = this.t + dwell + Math.abs(wrap(this.turnTarget - this.heading)) / C.turnRateStand;
    } else this.#setState('idle');
  }

  pose() {
    const a = this.alpha ?? 1; const p = this.prev;
    const base = { v: this.v, state: this.state, turnRate: this.turnRate };
    if (!p) return { x: this.x, z: this.z, h: this.heading, ...base };
    return { x: p.x + (this.x - p.x) * a, z: p.z + (this.z - p.z) * a, h: p.h + wrap(this.heading - p.h) * a, ...base };
  }
}
