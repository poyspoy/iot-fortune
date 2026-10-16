// ตัวจำลองลิฟต์ (ไม่ใช่ข้อมูลจริง ไม่มีคำสั่งถึงลิฟต์จริง) — ตรรกะล้วน ทดสอบใน Node ได้
//
// การเคลื่อนที่สมจริง: ออกตัว → เร่ง → วิ่งความเร็วคงที่ → ชะลอ → จอดตรงระดับพื้น (โปรไฟล์ความเร็วรูปสี่เหลี่ยมคางหมู)
// ลำดับต่อหนึ่งการเดินทาง: ประตูปิดสนิท → เคลื่อนที่ → หยุดตรงชั้น → ประตูเปิด → รอ → (ไปต่อ)
// เดินเวลาด้วยก้าวคงที่ (stepMs) จากเวลาจริงที่ผ่านไป — ไม่ผูกกับจำนวนเฟรม
// โหมด: อัตโนมัติวนตามเส้นทาง (สุ่มเวลารอ/ชั้นเล็กน้อย) · คำสั่งผู้ใช้มีสิทธิ์ก่อน แล้วกลับอัตโนมัติหลังรอ 8–10 วินาที
// ค่าเวลาทั้งหมดตั้งได้จาก ELEVATOR_DEMO_CONFIG (ภายหลังปรับให้ใกล้ลิฟต์จริงได้)

export const ELEVATOR_DEMO_CONFIG = Object.freeze({
  doorMs: 1100, // เวลาประตูปิด/เปิด
  maxSpeed: 0.85, // ชั้น/วินาที (ย่นเวลาสำหรับสาธิต)
  accel: 0.75, // ชั้น/วินาที²
  creep: 0.04, // ความเร็วต่ำสุดตอนเข้าจอด (กันค้างก่อนถึง)
  dwellMs: [2000, 4000], // ประตูเปิดรอที่ชั้น (สุ่มในช่วง)
  userHoldMs: [8000, 10000], // หลังส่งผู้ใช้ถึงชั้น รอแล้วจึงกลับโหมดอัตโนมัติ
  minDwellBeforeUserMs: 1000, // ประตูเปิดอย่างน้อยเท่านี้ก่อนปิดไปตามคำสั่งใหม่
  route: Object.freeze(['G', '3', '5', '1', '4', 'G']), // เส้นทางอัตโนมัติ (วนซ้ำ)
  randomDetour: 0.2, // โอกาสเปลี่ยนชั้นถัดไปแบบสุ่ม (ไม่ให้ดูซ้ำเป็นหุ่นยนต์)
  stepMs: 10,
});

/** RNG แบบกำหนดได้ (mulberry32) — สุ่มซ้ำได้ในการทดสอบ */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ElevatorSim {
  /**
   * @param {string[]} floors ลำดับชั้นจากล่างขึ้นบน
   * @param {{ config?:object, seed?:number, now?:number, startFloor?:string, auto?:boolean }} opts
   */
  constructor(floors, { config = ELEVATOR_DEMO_CONFIG, seed = 7, now = 0, startFloor, auto = true } = {}) {
    this.floors = [...floors];
    this.cfg = { ...config, route: config.route.filter((f) => floors.includes(f)) };
    this.rand = rng(seed);
    const i = Math.max(0, startFloor != null ? this.floors.indexOf(String(startFloor)) : 0);
    this.t = now;
    this.pos = i; this.vel = 0;
    this.door = 1; // 0 ปิดสนิท · 1 เปิดสุด
    this.phase = 'open'; // open | closing | moving | opening | closed
    this.from = i; this.target = i;
    this.queue = []; // คำสั่งผู้ใช้ (ดัชนีชั้น)
    this.auto = auto; this.paused = false;
    this.routeIdx = this.cfg.route[0] === this.floors[i] ? 1 : 0;
    this.mode = 'auto'; // ใครเป็นผู้กำหนดปลายทางปัจจุบัน: auto | user
    this.dwellUntil = now + this.#range(this.cfg.dwellMs);
    this.resumeAutoAt = now;
    this.openedAt = now;
    this.trips = 0;
    this.log = []; // เหตุการณ์สำคัญ (ใช้ตรวจลำดับในการทดสอบ)
  }

  #range([a, b]) { return a + (b - a) * this.rand(); }
  get index() { return Math.round(this.pos); }
  get atFloor() { return this.phase === 'open' || this.phase === 'opening' || this.phase === 'closed' ? this.floors[this.target] : null; }

  setAuto(on) { this.auto = !!on; }
  setPaused(on) { this.paused = !!on; }

  /**
   * คำสั่งผู้ใช้ (มีสิทธิ์ก่อนโหมดอัตโนมัติ)
   * @returns {'same-floor'|'retargeted'|'queued'|'accepted'|'unknown-floor'}
   */
  request(floorId, now = this.t) {
    this.step(now);
    const idx = this.floors.indexOf(String(floorId));
    if (idx < 0) return 'unknown-floor';
    if ((this.phase === 'open' || this.phase === 'opening' || this.phase === 'closed') && idx === this.target) {
      this.mode = 'user';
      this.dwellUntil = Math.max(this.dwellUntil, now + this.#range(this.cfg.userHoldMs));
      this.resumeAutoAt = this.dwellUntil;
      return 'same-floor';
    }
    if (this.phase === 'moving') {
      // เปลี่ยนปลายทางระหว่างวิ่ง: ถ้าอยู่ทิศเดียวกันและยังชะลอทัน → ต่อจากตำแหน่งปัจจุบัน; ไม่เช่นนั้นจอดตามแผนแล้วไปต่อ
      const dir = Math.sign(this.target - this.pos) || Math.sign(idx - this.pos);
      const ahead = (idx - this.pos) * dir;
      const stopDist = (this.vel * this.vel) / (2 * this.cfg.accel);
      if (ahead > stopDist + 0.02) {
        if (this.mode === 'auto') this.routeIdx = Math.max(0, this.routeIdx - 1); // ปลายทางอัตโนมัติที่ถูกแทนจะถูกเลือกใหม่ภายหลัง
        this.target = idx; this.mode = 'user';
        this.log.push({ t: now, type: 'retarget', to: this.floors[idx] });
        return 'retargeted';
      }
    }
    if (!this.queue.includes(idx)) this.queue.push(idx);
    // ถ้ากำลังรอที่ชั้น ปิดประตูไปตามคำสั่งหลังเปิดครบเวลาขั้นต่ำ
    if (this.phase === 'open') this.dwellUntil = Math.min(this.dwellUntil, Math.max(now, this.openedAt + this.cfg.minDwellBeforeUserMs));
    return this.phase === 'moving' ? 'queued' : 'accepted';
  }

  /** รีเซ็ตสาธิต: กลับชั้น G (ล่างสุด) เปิดประตู แล้วเริ่มรอบอัตโนมัติใหม่ */
  reset(now = this.t) {
    this.step(now);
    this.queue = [];
    this.routeIdx = 0;
    this.paused = false;
    this.auto = true;
    const r = this.request(this.floors[0], now);
    this.mode = 'reset';
    if (r === 'same-floor') { this.dwellUntil = now + this.#range(this.cfg.dwellMs); this.resumeAutoAt = now; }
    return r;
  }

  #nextTarget(now) {
    if (this.queue.length) { this.mode = 'user'; return this.queue.shift(); }
    if (!this.auto || this.paused || now < this.resumeAutoAt) return null;
    const route = this.cfg.route;
    if (!route.length) return null;
    let f = route[this.routeIdx % route.length];
    this.routeIdx = (this.routeIdx + 1) % route.length;
    let idx = this.floors.indexOf(f);
    if (this.rand() < this.cfg.randomDetour) {
      const others = this.floors.map((_, i) => i).filter((i) => i !== this.target && i !== idx);
      if (others.length) idx = others[Math.floor(this.rand() * others.length)];
    }
    if (idx === this.target) return this.#nextTarget(now); // ชั้นเดิม — ข้ามไปชั้นถัดไปในเส้นทาง
    this.mode = 'auto';
    return idx;
  }

  /** เดินเวลาไปถึง now (ก้าวคงที่) */
  step(now) {
    const dt = this.cfg.stepMs;
    let guard = 0;
    while (this.t + dt <= now && guard++ < 200000) this.#tick(dt);
    return this;
  }

  #tick(dtMs) {
    const now = this.t + dtMs;
    const dt = dtMs / 1000;
    const c = this.cfg;
    switch (this.phase) {
      case 'open':
      case 'closed': {
        if (this.phase === 'open' && now < this.dwellUntil) break;
        const next = this.#nextTarget(now);
        if (next === null) {
          // ไม่มีปลายทาง (ปิดอัตโนมัติ/หยุดชั่วคราว/รอผู้ใช้): ครบเวลารอแล้วปิดประตูจอดนิ่ง
          if (this.phase === 'open' && (!this.auto || this.paused)) { this.phase = 'closing'; this.pendingIdle = true; this.log.push({ t: now, type: 'closing' }); }
          break;
        }
        this.from = this.target; this.target = next; this.pendingIdle = false;
        if (this.phase === 'closed') { this.phase = 'moving'; this.vel = 0; this.log.push({ t: now, type: 'moving', from: this.floors[this.from], to: this.floors[next] }); }
        else { this.phase = 'closing'; this.log.push({ t: now, type: 'closing' }); }
        break;
      }
      case 'closing':
        this.door = Math.max(0, this.door - dtMs / c.doorMs);
        if (this.door <= 0) {
          this.door = 0;
          if (this.pendingIdle) { this.phase = 'closed'; this.pendingIdle = false; }
          else { this.phase = 'moving'; this.vel = 0; this.log.push({ t: now, type: 'moving', from: this.floors[this.from], to: this.floors[this.target] }); }
        }
        break;
      case 'moving': {
        this.door = 0;
        const remain = this.target - this.pos;
        const dir = Math.sign(remain);
        const dist = Math.abs(remain);
        const stopDist = (this.vel * this.vel) / (2 * c.accel);
        if (dist <= stopDist) this.vel = Math.max(c.creep, this.vel - c.accel * dt); // ชะลอ
        else this.vel = Math.min(c.maxSpeed, this.vel + c.accel * dt); // เร่ง/คงที่
        const move = this.vel * dt;
        if (move >= dist || dist < 1e-6) {
          this.pos = this.target; this.vel = 0; // หยุดตรงระดับพื้นพอดี แล้วจึงเปิดประตู
          this.phase = 'opening';
          this.log.push({ t: now, type: 'arrived', floor: this.floors[this.target] });
        } else this.pos += dir * move;
        break;
      }
      case 'opening':
        this.door = Math.min(1, this.door + dtMs / c.doorMs);
        if (this.door >= 1) {
          this.door = 1; this.phase = 'open'; this.openedAt = now; this.trips++;
          const user = this.mode === 'user';
          this.dwellUntil = now + this.#range(user ? c.userHoldMs : c.dwellMs);
          if (user || this.mode === 'reset') this.resumeAutoAt = this.dwellUntil;
          this.log.push({ t: now, type: 'opened', floor: this.floors[this.target], mode: this.mode });
        }
        break;
      default:
    }
    this.t = now;
  }

  /** สถานะสำหรับแสดงผล — คำนวณจากตำแหน่ง/ประตูเดียวกับที่ฉากใช้วาด */
  status() {
    const f = this.floors;
    const moving = this.phase === 'moving';
    const direction = moving ? (this.target > this.pos ? 'up' : 'down') : null;
    const heading = this.phase === 'closing' && !this.pendingIdle ? (this.target > this.from ? 'up' : 'down') : direction;
    const nearest = f[Math.min(f.length - 1, Math.max(0, Math.round(this.pos)))];
    const target = f[this.target];
    const doors = { open: 'open', closing: 'closing', moving: 'closed', opening: 'opening', closed: 'closed' }[this.phase];
    const doorText = { open: 'ประตูเปิด', closing: 'กำลังปิดประตู', closed: 'ประตูปิด', opening: 'กำลังเปิดประตู' }[doors];
    const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';
    let headline;
    if (moving) headline = `${arrow} กำลัง${direction === 'up' ? 'ขึ้น' : 'ลง'}ไปชั้น ${target}`;
    else if (this.phase === 'closing') headline = this.pendingIdle ? `จอดชั้น ${target} · กำลังปิดประตู` : `กำลังปิดประตู · ไปชั้น ${target}`;
    else if (this.phase === 'opening') headline = `ถึงชั้น ${target}`;
    else headline = `จอดชั้น ${target}`;
    const modeText = this.mode === 'user' ? 'ตามคำสั่งผู้ใช้' : this.mode === 'reset' ? 'รีเซ็ต → ชั้น G'
      : !this.auto ? 'ปิดโหมดอัตโนมัติ' : this.paused ? 'หยุดชั่วคราว' : 'อัตโนมัติ';
    return {
      phase: this.phase, target, nearest, direction, heading, doors, doorText, arrow, headline,
      atFloor: this.atFloor, position: this.pos, speed: this.vel, mode: this.mode, modeText,
      auto: this.auto, paused: this.paused, queue: this.queue.map((i) => f[i]),
      buttonsEnabled: true, // คำสั่งผู้ใช้รับได้ตลอด (มีสิทธิ์ก่อนโหมดอัตโนมัติ)
      detail: moving ? `ผ่านระดับชั้น ${nearest} · ${(this.vel * 1).toFixed(2)} ชั้น/วินาที` : '',
    };
  }
}
