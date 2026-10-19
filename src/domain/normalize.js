import { TELEMETRY_SCHEMA_VERSION, SAMPLE_QUALITY, FUTURE_TOLERANCE_MS } from './constants.js';

/**
 * ตรวจและแปลงข้อมูล telemetry ให้เป็น Sample ภายใน
 *
 * กติกา (เอกสารใน README):
 * - payload ต้องเป็น { schemaVersion: 1, samples: [...] }
 * - pointId จับคู่กับ sourceKey ของจุด (ค่าเริ่มต้น = รหัสจุด) และต้องเป็นจุดที่ active
 * - metricId จับคู่กับ sourceKey ของค่าวัด
 * - ค่าตัวเลขต้องเป็น number จริงและ finite (ไม่รับข้อความ "42") ค่า 0 ถูกต้อง
 * - หน่วยต้องตรงกับที่ตั้งไว้ หรือมีการแปลงหน่วยกำหนดไว้ชัดเจน
 * - ค่าต้องอยู่ในช่วงที่เป็นไปได้ (plausible) ที่ตั้งไว้
 * - observedAt ต้องเป็น ISO-8601 ที่มีเขตเวลา (Z หรือ ±hh:mm) และไม่ล้ำอนาคตเกิน 60 วินาที
 * - quality: good | uncertain | bad — ถ้าไม่ส่งมาถือเป็น uncertain, bad ถูกปฏิเสธ
 * - ลำดับ/การซ้ำ ต่อหนึ่งค่าวัด (หลังเรียงชุดข้อมูลตาม observedAt, sequence):
 *   - observedAt และ sequence เท่ากับค่าล่าสุด หรือ observedAt เท่ากันและค่าเท่ากัน → ซ้ำ (ข้าม ไม่นับ)
 *   - observedAt เท่ากันแต่ค่าต่างกัน → ปฏิเสธ (conflict)
 *   - observedAt เก่ากว่าค่าล่าสุด หรือ sequence ไม่เพิ่มขึ้น → ปฏิเสธ (out-of-order)
 */

export const REJECT_REASONS = {
  'bad-payload': 'รูปแบบข้อมูลไม่ถูกต้อง',
  'bad-schema': 'schemaVersion ไม่รองรับ',
  'unknown-point': 'ไม่รู้จักรหัสจุด',
  'archived-point': 'จุดถูกเก็บถาวรแล้ว',
  'unknown-metric': 'ไม่รู้จักรหัสค่าวัด',
  'invalid-value': 'ค่าไม่ใช่ตัวเลขที่ถูกต้อง',
  'invalid-state': 'สถานะไม่อยู่ในรายการที่กำหนด',
  'unit-mismatch': 'หน่วยไม่ตรงกับที่ตั้งไว้',
  implausible: 'ค่าอยู่นอกช่วงที่เป็นไปได้',
  'bad-timestamp': 'เวลา observedAt ไม่ถูกต้อง',
  'future-timestamp': 'เวลา observedAt ล้ำอนาคตเกินค่าที่ยอมรับ',
  'quality-bad': 'อุปกรณ์รายงานคุณภาพ bad',
  'invalid-quality': 'ค่า quality ไม่รู้จัก',
  'invalid-sequence': 'sequence ต้องเป็นจำนวนเต็มไม่ติดลบ',
  'out-of-order': 'มาช้ากว่าค่าล่าสุด (ไม่เขียนทับ)',
  conflict: 'เวลาเดียวกับค่าล่าสุดแต่ค่าต่างกัน',
  // กติกา Lifecycle (src/data/lifecycle.js telemetryDecision) — จุด/อุปกรณ์ยังไม่ติดตั้งหรือปลดระวาง
  'not-installed': 'จุดยังไม่ติดตั้ง (ร่าง/เสนอ/รออนุมัติ/อนุมัติแล้ว)',
  'point-retired': 'จุดไม่อนุมัติหรือปลดระวางแล้ว',
  'asset-retired': 'อุปกรณ์ที่ผูกอยู่ไม่อนุมัติหรือปลดระวางแล้ว',
};

/** เหตุผลที่ทำให้ค่าวัดนั้นถูกแสดงเป็น "ข้อมูลไม่ถูกต้อง" */
export const QUALITY_AFFECTING = new Set([
  'invalid-value', 'invalid-state', 'unit-mismatch', 'implausible', 'bad-timestamp',
  'future-timestamp', 'quality-bad', 'invalid-quality', 'conflict',
]);

const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(s) {
  if (typeof s !== 'string' || !ISO_TZ.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function sampleId(source, pointId, metricId, observedAt) {
  return `${source}:${pointId}:${metricId}:${observedAt}`;
}

/**
 * @param {any} payload
 * @param {{ index: ReturnType<import('./config.js').indexConfig>, source: 'demo'|'api', receivedAt: number,
 *           latest: Map<string, {observedAt:number, sequence:number|null, value:any}>, futureToleranceMs?: number,
 *           decide?: (pointId: string) => { accept: boolean, reason: string|null } }} ctx
 *   `decide` = กติกา Lifecycle เดียว (ไม่ส่งมา = รับทุกจุด active ตามพฤติกรรมเดิม)
 *   `latest` = ค่าล่าสุดที่ยอมรับแล้วต่อค่าวัด (คีย์ pointId|metricId) จะถูกอัปเดตในฟังก์ชันนี้
 */
export function normalizeBatch(payload, ctx) {
  const { index, source, receivedAt, latest } = ctx;
  const tol = ctx.futureToleranceMs ?? FUTURE_TOLERANCE_MS;
  const accepted = [];
  const rejected = [];
  let duplicates = 0;
  const reject = (reason, raw, extra = {}) => rejected.push({ reason, raw, at: receivedAt, ...extra });

  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.samples)) {
    reject('bad-payload', null);
    return { accepted, rejected, duplicates };
  }
  if (payload.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    reject('bad-schema', { schemaVersion: payload.schemaVersion });
    return { accepted, rejected, duplicates };
  }

  // ขั้นที่ 1: ตรวจทีละรายการ
  const candidates = [];
  for (const raw of payload.samples) {
    if (!raw || typeof raw !== 'object') { reject('bad-payload', raw); continue; }
    const point = typeof raw.pointId === 'string' ? index.bySourceKey.get(raw.pointId) : null;
    if (!point) { reject('unknown-point', raw); continue; }
    if (point.status !== 'active') { reject('archived-point', raw, { pointId: point.id }); continue; }
    const dec = ctx.decide ? ctx.decide(point.id) : null;
    if (dec && !dec.accept) { reject(dec.reason ?? 'not-installed', raw, { pointId: point.id }); continue; }
    const metric = typeof raw.metricId === 'string' ? index.metricBySourceKey(point, raw.metricId) : null;
    if (!metric) { reject('unknown-metric', raw, { pointId: point.id }); continue; }
    const ids = { pointId: point.id, metricId: metric.id };

    const observedAt = parseInstant(raw.observedAt);
    if (observedAt === null) { reject('bad-timestamp', raw, ids); continue; }
    if (observedAt > receivedAt + tol) { reject('future-timestamp', raw, ids); continue; }

    let quality = raw.quality;
    if (quality === undefined || quality === null) quality = 'uncertain';
    if (!SAMPLE_QUALITY.includes(quality)) { reject('invalid-quality', raw, ids); continue; }
    if (quality === 'bad') { reject('quality-bad', raw, ids); continue; }

    let sequence = null;
    if (raw.sequence !== undefined && raw.sequence !== null) {
      if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 0) { reject('invalid-sequence', raw, ids); continue; }
      sequence = raw.sequence;
    }

    let value;
    if (metric.kind === 'numeric') {
      if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) { reject('invalid-value', raw, ids); continue; }
      value = raw.value;
      if (raw.unit !== metric.unit) {
        const conv = metric.unitConversions?.[raw.unit];
        if (!conv) { reject('unit-mismatch', raw, ids); continue; }
        value = value * conv.factor + (conv.offset ?? 0);
      }
      const p = metric.plausible;
      if (p && (value < p.min || value > p.max)) { reject('implausible', raw, ids); continue; }
    } else {
      if (typeof raw.value !== 'string' || !metric.states.some((s) => s.value === raw.value)) {
        reject('invalid-state', raw, ids); continue;
      }
      if (raw.unit !== undefined && raw.unit !== null && raw.unit !== '' && raw.unit !== metric.unit) {
        reject('unit-mismatch', raw, ids); continue;
      }
      value = raw.value;
    }
    candidates.push({ raw, ids, observedAt, sequence, value, quality, unit: metric.unit });
  }

  // ขั้นที่ 2: เรียงตามเวลา แล้วตรวจลำดับ/ซ้ำ ต่อค่าวัด
  candidates.sort((a, b) => a.observedAt - b.observedAt || (a.sequence ?? -1) - (b.sequence ?? -1));
  for (const c of candidates) {
    const key = `${c.ids.pointId}|${c.ids.metricId}`;
    const last = latest.get(key);
    if (last) {
      if (c.observedAt === last.observedAt) {
        const sameSeq = c.sequence !== null && c.sequence === last.sequence;
        if (sameSeq || c.value === last.value) { duplicates++; continue; }
        reject('conflict', c.raw, c.ids); continue;
      }
      if (c.observedAt < last.observedAt) { reject('out-of-order', c.raw, c.ids); continue; }
      if (c.sequence !== null && last.sequence !== null && c.sequence <= last.sequence) {
        reject('out-of-order', c.raw, c.ids); continue;
      }
    }
    const sample = {
      id: sampleId(source, c.ids.pointId, c.ids.metricId, c.observedAt),
      source, pointId: c.ids.pointId, metricId: c.ids.metricId,
      value: c.value, unit: c.unit, observedAt: c.observedAt, receivedAt,
      quality: c.quality, sequence: c.sequence,
    };
    accepted.push(sample);
    latest.set(key, { observedAt: c.observedAt, sequence: c.sequence, value: c.value });
  }
  return { accepted, rejected, duplicates };
}
