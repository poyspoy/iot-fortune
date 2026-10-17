import { ELEVATOR_L1 } from './elevator.js';
import { ElevatorSim, ELEVATOR_DEMO_CONFIG } from './elevatorSim.js';

// บริการลิฟต์จำลอง — แยกจากการวาดภาพ (ไม่ใช้ three.js / WebGL)
// ฉาก 3D, ผัง 2D และแผงลิฟต์อ่านสถานะจากที่เดียวกัน จึงทำงานได้แม้เครื่องแสดง 3D ไม่ได้
//   - เดินเวลาด้วยตัวจับเวลาของตัวเอง (ค่าเริ่มต้นทุก 100 ms) และฉาก 3D เรียก step() ทุกเฟรมเพื่อความลื่น
//   - step() เรียกซ้ำกี่ครั้งก็ได้ (ตัวจำลองเดินถึงเวลาปัจจุบันแล้วหยุด) — ไม่มีการเดินซ้อน
//   - แจ้งผู้ฟังเมื่อสถานะที่แสดงผลเปลี่ยนเท่านั้น
// ข้อมูลจำลอง ไม่มีการเชื่อมต่อหรือส่งคำสั่งถึงลิฟต์จริง

/** ชั้นที่ลิฟต์จอดได้จริงในอาคารนี้ (ตามสเปก ∩ ชั้นที่มีในการตั้งค่า) เรียงตามลำดับชั้น */
export function liftStops(spec, buildingFloors) {
  const have = new Map((buildingFloors ?? []).map((f) => [f.id, f]));
  return spec.floors.filter((id) => have.has(id)).sort((a, b) => have.get(a).order - have.get(b).order);
}

export class ElevatorService {
  /**
   * @param {{ spec?:object, config?:object, clock?:()=>number, scheduler?:{setInterval:Function, clearInterval:Function}, intervalMs?:number, seed?:number }} [o]
   */
  constructor({ spec = ELEVATOR_L1, config = ELEVATOR_DEMO_CONFIG, clock, scheduler = globalThis, intervalMs = 100, seed } = {}) {
    this.spec = spec;
    this.config = config;
    this.clock = clock ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.scheduler = scheduler;
    this.intervalMs = intervalMs;
    this.seed = seed;
    this.sim = null;
    this.stops = [];
    this.listeners = new Set();
    this.sig = '';
    this.manualNow = null;
    this.timer = null;
  }

  /** เวลาที่ใช้ขับลิฟต์ — ปกติเป็นเวลาจริง; การทดสอบ/บันทึกคลิปตั้งนาฬิกาเองได้ */
  now() { return this.manualNow ?? this.clock(); }
  setManualClock(t) { this.manualNow = t; }
  /** ทดสอบ: เดินเวลาไป ms มิลลิวินาที (ใช้นาฬิกาที่ตั้งเอง) */
  advance(ms) { if (this.manualNow == null) this.manualNow = this.clock(); this.manualNow += ms; this.step(); }

  /**
   * ตั้งอาคาร — ถ้าชั้นที่จอดเหมือนเดิม ตัวจำลองเดิมเดินต่อ (ไม่เริ่มใหม่ที่ชั้นแรก)
   * @param {{id:string, order:number}[]} buildingFloors
   */
  setBuilding(buildingFloors) {
    const stops = liftStops(this.spec, buildingFloors);
    if (stops.length < 2) { this.sim = null; this.stops = []; this.#emit(true); return this; }
    if (this.sim && this.stops.join() === stops.join()) return this;
    this.stops = stops;
    this.sim = new ElevatorSim(stops, { config: this.config, now: this.now(), seed: this.seed ?? ((Date.now() & 0xffff) || 7) });
    this.#emit(true);
    return this;
  }

  get available() { return !!this.sim; }
  floors() { return [...this.stops]; }
  status() { return this.sim ? this.sim.status() : null; }

  /** เดินตัวจำลองถึงเวลาปัจจุบัน แล้วแจ้งผู้ฟังถ้าสถานะเปลี่ยน */
  step(now = this.now()) {
    if (!this.sim) return null;
    this.sim.step(now);
    this.#emit();
    return this.sim;
  }

  /** คำสั่งผู้ใช้ — คืน 'started' | 'same-floor' | 'unknown-floor' | 'none' */
  request(floorId) {
    if (!this.sim) return 'none';
    const r = this.sim.request(floorId, this.now());
    this.#emit(true);
    return r === 'same-floor' || r === 'unknown-floor' ? r : 'started';
  }

  setAuto(on) { if (!this.sim) return; this.sim.setAuto(on); this.#emit(true); }
  setPaused(on) { if (!this.sim) return; this.sim.setPaused(on); this.#emit(true); }
  reset() { if (!this.sim) return; this.sim.reset(this.now()); this.#emit(true); }

  /** @param {(status:object|null)=>void} fn @returns {()=>void} ยกเลิกการฟัง */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** เริ่มตัวจับเวลาของบริการ (ทำงานแม้ไม่มีฉาก 3D) */
  start() {
    if (this.timer != null) return this;
    this.timer = this.scheduler.setInterval(() => this.step(), this.intervalMs);
    return this;
  }
  stop() { if (this.timer != null) this.scheduler.clearInterval(this.timer); this.timer = null; return this; }
  get running() { return this.timer != null; }
  dispose() { this.stop(); this.listeners.clear(); }

  #emit(force = false) {
    const st = this.sim ? this.sim.status() : null;
    const sig = st ? `${st.phase}|${st.target}|${st.nearest}|${st.direction}|${st.doors}|${st.mode}|${st.auto}|${st.paused}|${st.queue.join()}` : 'none';
    if (!force && sig === this.sig) return;
    this.sig = sig;
    for (const fn of this.listeners) fn(st);
  }
}
