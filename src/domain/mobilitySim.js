// ตัวจำลองคนและรถ (ข้อมูลจำลอง · ไม่ใช่ข้อมูลติดตามบุคคลจริง)
// หนึ่งลูปสำหรับทุกตัว: step(dt) คำนวณจากเวลาจริงที่ผ่านไป (วินาที) จึงไม่ขึ้นกับอัตราเฟรม
// เคลื่อนตามเส้นทางที่คำนวณไว้ล่วงหน้า (ไม่ทะลุผนัง) ด้วยการเร่ง วิ่งคงที่ ชะลอก่อนจุดหยุด และหันตัวอย่างนุ่มนวล

export const MOBILITY_LEVELS = Object.freeze({
  off: { people: 0, cars: 0, label: 'ปิด' },
  low: { people: 6, cars: 2, label: 'ต่ำ' },
  medium: { people: 10, cars: 3, label: 'ปานกลาง' },
  high: { people: 15, cars: 5, label: 'สูง' },
});

export const MOBILITY_CONFIG = Object.freeze({
  person: { vmin: 0.16, vmax: 0.24, accel: 0.35, decel: 0.45, turnRate: 6, dwell: [2, 6], lane: 0.018, respawn: [1.5, 5] },
  car: { vmax: 0.75, vTurn: 0.28, vReverse: 0.2, accel: 0.45, decel: 0.7, turnRate: 4, park: [6, 12], gap: 0.95, respawn: [2, 6] },
});

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** เส้นทางพร้อมความยาวสะสม — ตำแหน่งที่ระยะ s ได้จากการประมาณค่าเชิงเส้นระหว่างจุด */
export class Route {
  constructor(points) {
    this.p = points;
    this.cum = [0];
    for (let i = 1; i < points.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    this.length = this.cum.at(-1);
  }
  at(s) {
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0; let hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    const seg = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / seg;
    const a = this.p[lo]; const b = this.p[hi];
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: b[0] - a[0], dz: b[1] - a[1] };
  }
  /** ความโค้งข้างหน้า (มุมเลี้ยวรวมในระยะ look) — ใช้ชะลอก่อนเลี้ยว */
  bendAhead(s, look) {
    const a = this.at(s); const b = this.at(s + look * 0.5); const c = this.at(s + look);
    const h1 = Math.atan2(b.z - a.z, b.x - a.x); const h2 = Math.atan2(c.z - b.z, c.x - b.x);
    return Math.abs(wrap(h2 - h1));
  }
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * @param {object} data   ข้อมูลเส้นทาง (public/mobility/floor-<ชั้น>.json)
 * @param {(p:[number,number])=>[number,number]} toLocal  แปลงพิกัดผังคน → พิกัดในกลุ่มชั้น (x, z)
 */
export class MobilitySim {
  constructor(data, toLocal, { seed = 7, level = 'medium', small = false, config = MOBILITY_CONFIG, cars = true } = {}) {
    this.carsEnabled = cars; // รถแบบกล่องเดิม — ปิดเมื่อใช้รถ 3 มิติจริง (VehicleSim)
    this.cfg = config;
    this.rng = mulberry32(seed);
    this.t = 0;
    this.small = small;
    this.poi = new Map(data.people.poi.map((p) => [p.id, p]));
    this.pathCache = new Map();
    this.rawPaths = data.people.paths;
    this.toLocal = toLocal;
    this.stalls = data.vehicles.stalls.map((s) => ({ ...s, busy: null, inR: new Route(s.in), outR: new Route(s.out), exitR: new Route(s.exit) }));
    this.road = data.vehicles.road;
    this.people = [];
    this.cars = [];
    this.nextId = 1;
    this.setLevel(level);
  }

  rand(a, b) { return a + (b - a) * this.rng(); }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }

  /** เส้นทางคนระหว่างจุดหมาย a → b (กลับทิศได้) แปลงเป็นพิกัดในกลุ่มชั้นครั้งเดียว */
  path(a, b) {
    const k = `${a}>${b}`;
    if (!this.pathCache.has(k)) {
      let pts = this.rawPaths[k];
      if (!pts) { pts = this.rawPaths[`${b}>${a}`]; pts = pts ? [...pts].reverse() : null; }
      this.pathCache.set(k, pts ? new Route(pts.map((p) => this.toLocal(p))) : null);
    }
    return this.pathCache.get(k);
  }

  /** จำนวนตามระดับ (มือถือลดลงอัตโนมัติ) — ปรับเพิ่ม/ลดโดยไม่รีเซ็ตตัวที่มีอยู่ */
  setLevel(level) {
    this.level = MOBILITY_LEVELS[level] ? level : 'medium';
    const L = MOBILITY_LEVELS[this.level];
    const k = this.small ? 0.6 : 1;
    this.target = { people: L.people ? Math.max(3, Math.round(L.people * k)) : 0, cars: L.cars && this.carsEnabled ? Math.max(1, Math.round(L.cars * k)) : 0 };
    while (this.people.length > this.target.people) this.people.pop();
    while (this.cars.length > this.target.cars) { const c = this.cars.pop(); if (c.stall) c.stall.busy = null; }
    while (this.people.length < this.target.people) this.people.push(this.#newPerson(true));
    while (this.cars.length < this.target.cars) this.cars.push(this.#newCar(this.cars.length * this.rand(2, 5)));
  }

  // ---------------- คน
  #trip() {
    const ents = [...this.poi.values()].filter((p) => p.kind === 'entrance').map((p) => p.id);
    const stops = [...this.poi.values()].filter((p) => p.kind === 'shop' || p.kind === 'corridor').map((p) => p.id);
    const start = this.pick(ents);
    const plan = [];
    const n = 1 + Math.floor(this.rng() * 3);
    let prev = start;
    for (let i = 0; i < n; i++) { let s; do s = this.pick(stops); while (s === prev); plan.push(s); prev = s; }
    plan.push(this.rng() < 0.3 ? 'lift-L1' : this.pick(ents.filter((e) => e !== prev)));
    return { start, plan };
  }

  #newPerson(spread = false) {
    const P = this.cfg.person;
    const { start, plan } = this.#trip();
    const p = { id: this.nextId++, at: start, plan, route: null, s: 0, v: 0, vmax: this.rand(P.vmin, P.vmax), lane: this.rand(-P.lane, P.lane),
      state: 'wait', until: this.t + (spread ? this.rand(0, 8) : this.rand(...P.respawn)), x: 0, z: 0, heading: 0, visible: false, color: Math.floor(this.rng() * 1000) };
    const pos = this.toLocal(this.poi.get(start).pos); p.x = pos[0]; p.z = pos[1];
    if (spread) { this.#nextLeg(p); if (p.route) { p.s = this.rand(0, p.route.length * 0.8); p.state = 'walk'; p.visible = true; p.v = p.vmax * 0.7; } }
    return p;
  }

  /** ไปจุดหมายถัดไป — คืน false เมื่อจบทริปแล้ว (เริ่มคนใหม่ที่ทางเข้า) */
  #nextLeg(p) {
    const to = p.plan.shift();
    if (!to) { this.#respawn(p); return false; }
    p.route = this.path(p.at, to);
    p.to = to; p.s = 0;
    if (!p.route) { p.at = to; return this.#nextLeg(p); }
    return true;
  }

  #respawn(p) { const id = p.id; for (const k of Object.keys(p)) delete p[k]; Object.assign(p, this.#newPerson(false), { id }); }

  #stepPerson(p, dt) {
    const P = this.cfg.person;
    if (p.state === 'wait' || p.state === 'dwell') {
      if (this.t < p.until) return;
      if (p.leaving) { this.#respawn(p); return; } // ขึ้นลิฟต์ไปแล้ว
      if (p.state === 'dwell') p.at = p.to;
      if (!this.#nextLeg(p)) return;
      p.state = 'walk'; p.visible = true; if (p.v === undefined) p.v = 0;
    }
    const r = p.route;
    const remain = r.length - p.s;
    const brake = (p.v * p.v) / (2 * P.decel) + 0.005;
    const bend = r.bendAhead(p.s, 0.12);
    const vt = remain <= brake ? 0 : p.vmax * (bend > 0.9 ? 0.65 : 1);
    p.v = vt > p.v ? Math.min(vt, p.v + P.accel * dt) : Math.max(vt, p.v - P.decel * dt);
    if (remain <= brake) p.v = Math.max(0.02, Math.min(p.v, Math.sqrt(2 * P.decel * Math.max(0, remain))));
    p.s = Math.min(r.length, p.s + p.v * dt);
    const a = r.at(p.s);
    const len = Math.hypot(a.dx, a.dz) || 1;
    // แนวเดินแยกเลนเล็กน้อย (ไม่เดินทับกัน) — ค่อย ๆ ลดลงใกล้ปลายทาง
    const k = Math.min(1, p.s / 0.08, (r.length - p.s) / 0.08);
    p.x = a.x + (-a.dz / len) * p.lane * k; p.z = a.z + (a.dx / len) * p.lane * k;
    const h = Math.atan2(a.dx, a.dz);
    p.heading += wrap(h - p.heading) * Math.min(1, P.turnRate * dt);
    if (p.s >= r.length - 1e-4) {
      p.v = 0;
      const poi = this.poi.get(p.to);
      if (poi.kind === 'entrance' && p.plan.length === 0) { this.#respawn(p); return; } // ออกจากอาคาร
      if (poi.kind === 'lift' && p.plan.length === 0) { p.state = 'dwell'; p.until = this.t + this.rand(2, 4); p.leaving = true; return; } // รอลิฟต์แล้วขึ้นลิฟต์
      p.state = 'dwell'; p.until = this.t + this.rand(...P.dwell);
    }
  }

  // ---------------- รถ
  #newCar(delay = 0) {
    return { id: this.nextId++, state: 'wait', until: this.t + delay + this.rand(0, 2), stall: null, route: null, s: 0, v: 0, x: this.road.xIn, z: this.road.z, heading: -Math.PI / 2, visible: false, reverse: false, color: Math.floor(this.rng() * 1000) };
  }

  #carBlocked(c, dirX, dirZ, gap) {
    for (const o of this.cars) {
      if (o === c || !o.visible) continue;
      const rx = o.x - c.x; const rz = o.z - c.z;
      const ahead = rx * dirX + rz * dirZ; const side = Math.abs(rx * -dirZ + rz * dirX);
      if (ahead > 0 && ahead < gap && side < 0.3) return true;
    }
    return false;
  }

  #stepCar(c, dt) {
    const C = this.cfg.car;
    if (c.state === 'wait') {
      if (this.t < c.until) return;
      const free = this.stalls.filter((s) => !s.busy);
      if (!free.length || this.#carBlocked({ x: this.road.xIn + 0.5, z: this.road.z }, -1, 0, 1.3)) { c.until = this.t + 1; return; }
      c.stall = this.pick(free); c.stall.busy = c.id;
      c.route = c.stall.inR; c.s = 0; c.v = 0; c.state = 'in'; c.reverse = false; c.visible = true;
    }
    if (c.state === 'parked' || c.state === 'pause') {
      if (this.t < c.until) return;
      if (c.state === 'parked') { c.route = c.stall.outR; c.s = 0; c.state = 'out'; c.reverse = true; }
      else { c.route = c.stall.exitR; c.s = 0; c.state = 'exit'; c.reverse = false; c.stall.busy = null; c.stall = null; }
    }
    const r = c.route;
    const remain = r.length - c.s;
    const stopAtEnd = c.state !== 'exit';
    const brake = (c.v * c.v) / (2 * C.decel) + 0.01;
    let vmax = c.reverse ? C.vReverse : C.vmax;
    const bend = r.bendAhead(c.s, 0.9);
    if (bend > 0.25) vmax = Math.min(vmax, C.vTurn + (C.vmax - C.vTurn) * Math.max(0, 1 - bend / 0.9));
    const a0 = r.at(c.s); const l0 = Math.hypot(a0.dx, a0.dz) || 1;
    const dirX = (a0.dx / l0) * (c.reverse ? 1 : 1); const dirZ = a0.dz / l0;
    let vt = stopAtEnd && remain <= brake ? 0 : vmax;
    if (!c.reverse && this.#carBlocked(c, dirX, dirZ, C.gap)) vt = 0; // เว้นระยะคันหน้า
    c.v = vt > c.v ? Math.min(vt, c.v + C.accel * dt) : Math.max(vt, c.v - C.decel * dt);
    if (stopAtEnd && remain <= brake) c.v = Math.max(0.03, Math.min(c.v, Math.sqrt(2 * C.decel * Math.max(0, remain))));
    c.s = Math.min(r.length, c.s + c.v * dt);
    const a = r.at(c.s);
    c.x = a.x; c.z = a.z;
    let h = Math.atan2(a.dx, a.dz); if (c.reverse) h += Math.PI; // ถอย: หน้ารถหันกลับทิศการเคลื่อนที่
    c.heading += wrap(h - c.heading) * Math.min(1, C.turnRate * dt);
    if (c.s >= r.length - 1e-4) {
      c.v = 0;
      if (c.state === 'in') { c.state = 'parked'; c.until = this.t + this.rand(...C.park); }
      else if (c.state === 'out') { c.state = 'pause'; c.until = this.t + 0.8; }
      else if (c.state === 'exit') { const id = c.id; Object.assign(c, this.#newCar(this.rand(...C.respawn)), { id }); }
    }
  }

  /**
   * เดินเวลา dt วินาที — ใช้ช่วงเวลาคงที่ 20 ms (ผลเท่ากันทุกอัตราเฟรม) แล้วประมาณค่าระหว่างสองสถานะ (interpolation)
   * ให้ภาพเคลื่อนนุ่มนวลแม้เฟรมไม่ตรงกับช่วงเวลาคงที่
   */
  step(dt) {
    const H = 0.02;
    this.acc = (this.acc ?? 0) + Math.max(0, Math.min(dt, 5));
    while (this.acc >= H - 1e-9) {
      for (const a of this.people) { a.px = a.x; a.pz = a.z; a.ph = a.heading; }
      for (const a of this.cars) { a.px = a.x; a.pz = a.z; a.ph = a.heading; }
      this.t += H;
      for (const p of this.people) this.#stepPerson(p, H);
      for (const c of this.cars) this.#stepCar(c, H);
      this.acc -= H;
    }
    this.alpha = this.acc / H;
  }

  /** ตำแหน่งสำหรับวาด (ประมาณค่าระหว่างสถานะก่อนหน้าและปัจจุบัน) */
  pose(a) {
    const k = this.alpha ?? 1;
    if (a.px === undefined || Math.hypot(a.x - a.px, a.z - a.pz) > 0.5) return { x: a.x, z: a.z, h: a.heading };
    return { x: a.px + (a.x - a.px) * k, z: a.pz + (a.z - a.pz) * k, h: a.ph + wrap(a.heading - a.ph) * k };
  }

  stats() {
    return { t: +this.t.toFixed(1), level: this.level, people: this.people.length, peopleVisible: this.people.filter((p) => p.visible).length, cars: this.cars.length,
      carsVisible: this.cars.filter((c) => c.visible).length, parked: this.cars.filter((c) => c.state === 'parked').length, busyStalls: this.stalls.filter((s) => s.busy).length };
  }
}
