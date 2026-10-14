// เวลา: เก็บเป็น UTC milliseconds เสมอ แสดงผลเป็นเวลาไทย (Asia/Bangkok)

export const TZ = 'Asia/Bangkok';

const fmtFull = new Intl.DateTimeFormat('th-TH', {
  timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const fmtTime = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtShort = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function fmtDateTime(ms) {
  return ms == null || !Number.isFinite(ms) ? '—' : fmtFull.format(ms);
}
export function fmtClock(ms) {
  return ms == null || !Number.isFinite(ms) ? '—' : fmtTime.format(ms);
}
export function fmtShortDT(ms) {
  return ms == null || !Number.isFinite(ms) ? '—' : fmtShort.format(ms);
}
export function isoUtc(ms) {
  return ms == null || !Number.isFinite(ms) ? '' : new Date(ms).toISOString();
}

/** นาฬิกาจริง */
export const systemClock = { now: () => Date.now() };

/** นาฬิกาจำลองที่ควบคุมได้ (ใช้ในเดโมและการทดสอบ) */
export class ManualClock {
  constructor(t = 0) { this.t = t; }
  now() { return this.t; }
  set(t) { this.t = t; }
  advance(ms) { this.t += ms; }
}
