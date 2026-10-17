// ตัวจำลองรถยนต์ 1 คัน (ข้อมูลจำลอง): ทางเข้า → ช่องจอด (เดินหน้า) → จอดรอ → ถอยออก → ขับออกจากพื้นที่ → วนใหม่
// เส้นทาง = เส้นโค้ง Catmull-Rom (centripetal) ผ่านจุดควบคุม · ตัวรถหันตามแนวเส้นสัมผัส (ไม่ไถลด้านข้าง)
// ความเร็ว: เร่ง/ชะลอจำกัด และจำกัดตามความโค้ง (แรงเหวี่ยงด้านข้าง) · หยุดสนิทที่ปลายช่วง
// ล้อ: มุมหมุน = ระยะทาง / รัศมีล้อ · มุมเลี้ยวล้อหน้า = atan(ฐานล้อ × ความโค้ง) ค่อย ๆ หมุนเข้า/คืนตรง

export const VEHICLE_CONFIG = Object.freeze({
  vRoad: 0.5, vLot: 0.3, vReverse: 0.16, accel: 0.22, decel: 0.32, latAccel: 0.22,
  steerMax: 0.55, steerRate: 1.1, park: 3.5, pause: 1.0, respawn: 2.5,
});

/** จุดบนเส้นโค้ง Catmull-Rom แบบ centripetal (alpha = 0.5) ระหว่าง p1–p2 */
function crPoint(p0, p1, p2, p3, t) {
  const tj = (a, b) => Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5);
  const t0 = 0; const t1 = t0 + tj(p0, p1); const t2 = t1 + tj(p1, p2); const t3 = t2 + tj(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const L = (a, b, ta, tb) => [((tb - u) / (tb - ta)) * a[0] + ((u - ta) / (tb - ta)) * b[0], ((tb - u) / (tb - ta)) * a[1] + ((u - ta) / (tb - ta)) * b[1]];
  const A1 = L(p0, p1, t0, t1); const A2 = L(p1, p2, t1, t2); const A3 = L(p2, p3, t2, t3);
  const B1 = L(A1, A2, t0, t2); const B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}

/** เส้นทางโค้งพร้อมตารางความยาว ทิศทาง และความโค้งตามระยะทาง */
export class Curve {
  constructor(ctrl, samplesPerSeg = 24) {
    const P = [[2 * ctrl[0][0] - ctrl[1][0], 2 * ctrl[0][1] - ctrl[1][1]], ...ctrl, [2 * ctrl.at(-1)[0] - ctrl.at(-2)[0], 2 * ctrl.at(-1)[1] - ctrl.at(-2)[1]]];
    const pts = [];
    for (let i = 1; i < P.length - 2; i++) for (let k = 0; k < samplesPerSeg; k++) pts.push(crPoint(P[i - 1], P[i], P[i + 1], P[i + 2], k / samplesPerSeg));
    pts.push(ctrl.at(-1));
    this.p = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.length = this.cum.at(-1);
    // ทิศทาง (heading) ที่แต่ละจุด และความโค้ง dθ/ds
    this.h = pts.map((_, i) => { const a = pts[Math.max(0, i - 1)]; const b = pts[Math.min(pts.length - 1, i + 1)]; return Math.atan2(b[0] - a[0], b[1] - a[1]); });
    this.k = this.h.map((_, i) => {
      const i0 = Math.max(0, i - 2); const i1 = Math.min(pts.length - 1, i + 2);
      const ds = this.cum[i1] - this.cum[i0] || 1;
      return wrap(this.h[i1] - this.h[i0]) / ds;
    });
  }
  #idx(s) { let lo = 0; let hi = this.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; } return [lo, hi]; }
  sample(s) {
    s = Math.max(0, Math.min(this.length, s));
    const [lo, hi] = this.#idx(s);
    const t = (s - this.cum[lo]) / (this.cum[hi] - this.cum[lo] || 1);
    const a = this.p[lo]; const b = this.p[hi];
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, h: this.h[lo] + wrap(this.h[hi] - this.h[lo]) * t, k: this.k[lo] + (this.k[hi] - this.k[lo]) * t };
  }
  /** ความโค้งสูงสุดในช่วง [s, s+look] — ใช้ชะลอก่อนเข้าโค้ง */
  maxCurv(s, look) {
    let m = 0;
    for (let d = 0; d <= look; d += look / 8) m = Math.max(m, Math.abs(this.sample(s + d).k));
    return m;
  }
}
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * แผนการวิ่ง 1 รอบจากข้อมูลลาน (mobility data.vehicles) และช่องจอดที่เลือก
 * ช่วง: in (เดินหน้าเข้าช่องจอด) → out (ถอยออก ท้ายรถเลี้ยวไปทางตะวันออก ให้หน้ารถหันไปทางออก) → exit (เดินหน้าออก)
 */
export function buildPlan(veh, stall) {
  const z = veh.road.z; const sx = stall.x; const sz = stall.z - 0.02;
  return [
    { id: 'in', reverse: false, vmax: veh.vLot ?? null, ctrl: [[veh.road.xIn, z], [sx + 3.0, z], [sx + 1.2, z], [sx + 0.55, z + 0.25], [sx + 0.12, z + 0.75], [sx, sz]] },
    { id: 'out', reverse: true, ctrl: [[sx, sz], [sx, sz - 0.45], [sx + 0.3, z + 0.3], [sx + 0.95, z + 0.03]] },
    { id: 'exit', reverse: false, ctrl: [[sx + 0.95, z + 0.03], [sx + 0.2, z], [sx - 1.5, z], [veh.road.xOut, z]] },
  ];
}

export class VehicleSim {
  /** @param {{ wheelbase:number, wheelRadius:number }} dims  หน่วยฉาก */
  constructor(veh, dims, { stallId = null, config = VEHICLE_CONFIG } = {}) {
    this.veh = veh; this.dims = dims; this.cfg = config;
    this.stall = veh.stalls.find((s) => s.id === stallId) ?? veh.stalls[Math.floor(veh.stalls.length / 2)];
    this.plan = buildPlan(veh, this.stall).map((p) => ({ ...p, curve: new Curve(p.ctrl) }));
    this.t = 0;
    this.restart();
  }

  restart() {
    this.seg = 0; this.s = 0; this.v = 0; this.state = 'drive'; this.until = 0;
    this.spin = 0; this.steer = 0; this.brake = false; this.accelNow = 0; this.visible = true; this.odometer = 0;
    const p = this.plan[0].curve.sample(0);
    this.x = p.x; this.z = p.z; this.heading = p.h;
  }

  get segment() { return this.plan[this.seg]; }

  step(dt) {
    const H = 0.01; // ช่วงเวลาคงที่ 10 ms
    this.acc = (this.acc ?? 0) + Math.max(0, Math.min(dt, 5));
    while (this.acc >= H - 1e-9) { this.prev = { x: this.x, z: this.z, h: this.heading, spin: this.spin, steer: this.steer }; this.#tick(H); this.acc -= H; }
    this.alpha = this.acc / H;
  }

  #tick(dt) {
    const C = this.cfg; this.t += dt;
    if (this.state === 'wait' || this.state === 'parked' || this.state === 'pause') {
      this.brake = this.state !== 'wait'; this.v = 0; this.accelNow = 0;
      this.steer += Math.max(-C.steerRate * dt, Math.min(C.steerRate * dt, 0 - this.steer)) * (this.state === 'pause' ? 0 : 0.6); // จอดแล้วคืนพวงมาลัยช้า ๆ
      if (this.t < this.until) return;
      if (this.state === 'wait') { this.restart(); return; }
      this.seg++; this.s = 0; this.state = 'drive';
      if (this.seg >= this.plan.length) { this.state = 'wait'; this.visible = false; this.until = this.t + C.respawn; }
      return;
    }
    const seg = this.segment; const cv = seg.curve;
    const remain = cv.length - this.s;
    // ความเร็วเป้าหมาย: ถนนเร็วกว่าในลาน · ถอยช้า · จำกัดตามความโค้งข้างหน้า · หยุดให้ทันที่ปลายช่วง (ยกเว้นช่วงออกนอกพื้นที่)
    let vt = seg.reverse ? C.vReverse : (Math.abs(cv.sample(this.s).k) < 0.05 && seg.id !== 'in' ? C.vRoad : C.vRoad);
    const kAhead = cv.maxCurv(this.s, Math.max(0.3, this.v * 2.2));
    if (kAhead > 1e-3) vt = Math.min(vt, Math.sqrt(C.latAccel / kAhead));
    if (seg.id === 'in' && remain < 1.2) vt = Math.min(vt, C.vLot);
    const stopEnd = seg.id !== 'exit';
    const brakeDist = (this.v * this.v) / (2 * C.decel) + 0.004;
    if (stopEnd && remain <= brakeDist) vt = 0;
    const v0 = this.v;
    this.v = vt > this.v ? Math.min(vt, this.v + C.accel * dt) : Math.max(vt, this.v - C.decel * dt);
    if (stopEnd && remain <= brakeDist) this.v = Math.max(Math.min(this.v, Math.sqrt(2 * C.decel * Math.max(0, remain))), Math.min(0.02, remain / dt)); // คืบเข้าจุดหยุดจนถึงพอดี ไม่ค้างก่อนถึง
    this.accelNow = (this.v - v0) / dt;
    this.brake = this.accelNow < -0.04 || this.v < 0.005;
    const ds = Math.min(remain, this.v * dt);
    this.s += ds; this.odometer += ds;
    const p = cv.sample(this.s);
    this.x = p.x; this.z = p.z;
    this.heading = seg.reverse ? p.h + Math.PI : p.h; // ถอย: หน้ารถหันกลับทิศการเคลื่อนที่ (ไม่ไถลด้านข้าง)
    // ล้อหมุนตามระยะทาง (ถอย = หมุนกลับ)
    this.spin += (seg.reverse ? -ds : ds) / this.dims.wheelRadius;
    // มุมเลี้ยวล้อหน้า: แบบจักรยาน δ = atan(L·κ) ของรถ (ถอย: κ ของรถ = −κ ของเส้นทาง) — จำกัดอัตราการหมุนพวงมาลัย
    const kCar = seg.reverse ? -p.k : p.k;
    const target = Math.max(-C.steerMax, Math.min(C.steerMax, Math.atan(this.dims.wheelbase * kCar)));
    this.steer += Math.max(-C.steerRate * dt, Math.min(C.steerRate * dt, target - this.steer));
    if (remain - ds <= 1e-4) {
      if (seg.id === 'in') { this.state = 'parked'; this.until = this.t + C.park; this.v = 0; }
      else if (seg.id === 'out') { this.state = 'pause'; this.until = this.t + C.pause; this.v = 0; }
      else { this.state = 'wait'; this.visible = false; this.until = this.t + C.respawn; this.v = 0; }
    }
  }

  /** สถานะสำหรับวาด (ประมาณค่าระหว่างสองช่วงเวลาคงที่) */
  pose() {
    const a = this.alpha ?? 1; const p = this.prev;
    if (!p) return { x: this.x, z: this.z, h: this.heading, spin: this.spin, steer: this.steer };
    return { x: p.x + (this.x - p.x) * a, z: p.z + (this.z - p.z) * a, h: p.h + wrap(this.heading - p.h) * a, spin: p.spin + (this.spin - p.spin) * a, steer: p.steer + (this.steer - p.steer) * a };
  }

  status() {
    return { seg: this.segment?.id ?? 'done', state: this.state, v: +this.v.toFixed(3), steer: +this.steer.toFixed(3), spin: +this.spin.toFixed(2), brake: this.brake, x: +this.x.toFixed(3), z: +this.z.toFixed(3), odometer: +this.odometer.toFixed(3) };
  }
}
