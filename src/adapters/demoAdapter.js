// อะแดปเตอร์ข้อมูลจำลอง (deterministic)
// ค่าทุกค่าเป็นฟังก์ชันบริสุทธิ์ของ (seed, จุด, ค่าวัด, เวลา, สถานการณ์, เวลาเริ่มสถานการณ์)
// จึงได้ผลเหมือนเดิมทุกครั้ง ไม่ขึ้นกับจังหวะ tick — ส่งออกในรูปแบบสัญญา HTTP เดียวกับ API จริง
// ค่าเหล่านี้ "ไม่ใช่" ข้อมูลจริงของฟอร์จูน

export const DEMO_STEP_MS = 30_000;
export const DEMO_BACKFILL_MS = 30 * 60_000;
export const SCENARIOS = {
  normal: 'ปกติ',
  'sump-rising': 'ระดับน้ำบ่อสูง',
  'tank-low': 'ระดับน้ำถังต่ำ',
  both: 'จำลองทั้งสองเหตุการณ์',
  'room-hot': 'ห้องไฟฟ้าอุณหภูมิสูง',
  leak: 'ตรวจพบน้ำรั่ว',
  'device-loss': 'อุปกรณ์ขาดการติดต่อ',
};
export const SPEEDS = [1, 10, 60];
const ENERGY_EPOCH = Date.parse('2026-01-01T00:00:00Z');

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** สัญญาณรบกวนแบบกำหนดได้ในช่วง [-1, 1] */
export function noise(seed, key, k) {
  let x = hash32(`${seed}|${key}|${k}`);
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

const r1 = (v) => Math.round(v * 10) / 10;

/** ค่าของทุกค่าวัด ณ เวลา t (คืน [] ถ้าอุปกรณ์ขาดการติดต่อ) */
export function demoValuesAt(t, { seed, scenario, scenarioStartedAt, lossPointId, prev }) {
  const k = Math.floor(t / DEMO_STEP_MS);
  const n = (key) => noise(seed, key, k);
  const inScenario = (name) => scenario === name || (scenario === 'both' && (name === 'sump-rising' || name === 'tank-low'));
  const active = (name) => inScenario(name) && scenarioStartedAt != null && t >= scenarioStartedAt;
  const el = (name) => (active(name) ? (t - scenarioStartedAt) / 60_000 : 0);
  // ค่าเบี่ยงเบนจากสถานการณ์: เพิ่มขึ้นตามเวลา และเมื่อเปลี่ยนสถานการณ์ ค่อย ๆ กลับสู่ปกติ (ไม่กระโดด)
  const inPrev = (name) => prev && prev.endedAt != null && (prev.scenario === name || (prev.scenario === 'both' && (name === 'sump-rising' || name === 'tank-low')));
  const offset = (name, perMin, recoverPerMin, cap) => {
    if (active(name)) return Math.min(cap, perMin * el(name));
    if (inPrev(name) && t >= prev.endedAt && prev.startedAt != null) {
      const peak = Math.min(cap, (perMin * Math.max(0, prev.endedAt - prev.startedAt)) / 60_000);
      return Math.max(0, peak - (recoverPerMin * (t - prev.endedAt)) / 60_000);
    }
    return 0;
  };

  const minuteOfCycle = (t / 60_000) % 20;
  const running = minuteOfCycle < 12;
  const day = ((t + 7 * 3600_000) % 86_400_000) / 86_400_000; // เวลาไทย 0–1
  const out = [
    ['WL-001', 'level', r1(Math.min(195, 60 + 2.5 * n('p1') + offset('sump-rising', 6, 15, 133))), 'cm'],
    ['WL-002', 'level', r1(Math.max(12, 75 + 1.2 * n('p2') - offset('tank-low', 4, 10, 63))), '%'],
    ['P-003', 'run', running ? 'run' : 'stop', ''],
    ['P-003', 'current', running ? r1(12 + 0.6 * n('p3')) : 0, 'A'],
    ['P-004', 'chws', r1(7 + 0.3 * n('p4s')), '°C'],
    ['P-004', 'chwr', r1(12 + 0.4 * n('p4r')), '°C'],
    ['P-005', 'temp', r1(25 + 0.4 * n('p5t')), '°C'],
    ['P-005', 'rh', r1(55 + 3 * n('p5h')), '%RH'],
    ['P-006', 'power', r1(190 + 70 * Math.sin((day - 0.3) * Math.PI * 2) + 10 * n('p6')), 'kW'],
    ['P-006', 'energy', Math.round(1_250_000 + (200 * (t - ENERGY_EPOCH)) / 3_600_000), 'kWh'],
    ['P-007', 'temp', r1(Math.min(41, 28 + 0.4 * n('p7') + 0.9 * el('room-hot'))), '°C'],
    ['P-008', 'leak', active('leak') && el('leak') >= 1 ? 'wet' : 'dry', ''],
  ];
  const lost = active('device-loss') ? lossPointId : null;
  return out.filter(([p]) => p !== lost);
}

/**
 * สร้างชุดข้อมูลตามสัญญา HTTP สำหรับช่วงเวลา (from, to]
 * @param {(pointId: string) => boolean} [accept]  กติกา Lifecycle — จุดที่ยังไม่ติดตั้ง/ปลดระวาง เดโมไม่สร้างค่าให้
 */
export function demoPayloadBetween(fromExclusive, toInclusive, params, accept = null) {
  const samples = [];
  let t = Math.floor(fromExclusive / DEMO_STEP_MS) * DEMO_STEP_MS + DEMO_STEP_MS;
  for (; t <= toInclusive; t += DEMO_STEP_MS) {
    for (const [pointId, metricId, value, unit] of demoValuesAt(t, params)) {
      if (accept && !accept(pointId)) continue;
      samples.push({ pointId, metricId, value, unit, observedAt: new Date(t).toISOString(), quality: 'good', sequence: t / DEMO_STEP_MS });
    }
  }
  return { schemaVersion: 1, samples };
}

/**
 * ตัวขับเดโม: เดินนาฬิกาจำลองตามความเร็ว แล้วส่งชุดข้อมูลให้ engine
 * นาฬิกาจำลองเป็นแหล่งเวลาเดียวของโหมดเดโม (ความสดใหม่ ฯลฯ คิดจากเวลาจำลอง)
 */
export class DemoAdapter {
  constructor({ params, simStart, lastEmittedAt, realClock, scheduler, onPayload, tickMs = 1000, accept = null }) {
    this.kind = 'demo';
    this.accept = accept;
    this.params = { ...params };
    this.simNow = simStart;
    this.lastEmittedAt = lastEmittedAt ?? simStart - DEMO_BACKFILL_MS;
    this.realClock = realClock;
    this.scheduler = scheduler;
    this.onPayload = onPayload;
    this.tickMs = tickMs;
    this.timer = null;
    this.lastReal = null;
    this.disposed = false;
  }
  now() { return this.simNow; }
  start() {
    this.lastReal = this.realClock.now();
    this.emit();
    this.timer = this.scheduler.setInterval(() => this.tick(), this.tickMs);
  }
  tick() {
    if (this.disposed) return;
    const real = this.realClock.now();
    const dt = Math.max(0, Math.min(real - this.lastReal, 10_000)); // ป้องกันกระโดดเมื่อแท็บถูกพัก
    this.lastReal = real;
    this.simNow += dt * this.params.speed;
    this.emit();
  }
  emit() {
    if (this.simNow <= this.lastEmittedAt) return;
    const payload = demoPayloadBetween(this.lastEmittedAt, this.simNow, this.params, this.accept);
    this.lastEmittedAt = Math.floor(this.simNow / DEMO_STEP_MS) * DEMO_STEP_MS;
    if (payload.samples.length) this.onPayload(payload, { receivedAt: this.simNow });
  }
  setParams(p) { this.params = { ...this.params, ...p }; }
  dispose() {
    this.disposed = true;
    if (this.timer) this.scheduler.clearInterval(this.timer);
    this.timer = null;
  }
}
