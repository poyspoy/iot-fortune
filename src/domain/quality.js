import { QUALITY } from './constants.js';

/**
 * คุณภาพข้อมูลของค่าวัดหนึ่งค่า ณ เวลา now
 * - nodata  : ยังไม่เคยได้รับค่าที่ถูกต้องและไม่มีค่าที่ถูกปฏิเสธ
 * - invalid : ค่าที่ได้รับล่าสุด (ใหม่กว่าค่าที่ถูกต้องล่าสุด) ถูกปฏิเสธ และยังไม่เกินเวลาหมดอายุ
 * - stale   : ค่าที่ถูกต้องล่าสุดเก่ากว่า staleAfterSec (นับจาก observedAt ไม่ใช่เวลาที่ poll สำเร็จ)
 * - fresh   : ค่าที่ถูกต้องล่าสุดยังไม่หมดอายุ
 * ขอบเขต: อายุ = now - observedAt; อายุ > staleAfterSec*1000 ถือว่าเก่า (เท่ากับพอดียังสด)
 */
export function metricQuality(entry, metric, now) {
  const staleMs = metric.staleAfterSec * 1000;
  const lv = entry?.lastValid ?? null;
  const rj = entry?.lastRejectedAt ?? null;
  if (rj !== null && (lv === null || rj > lv.observedAt) && now - rj <= staleMs) return 'invalid';
  if (!lv) return rj !== null ? 'stale' : 'nodata';
  if (now - lv.observedAt > staleMs) return 'stale';
  return 'fresh';
}

export function worstQuality(qs) {
  let worst = 'fresh';
  for (const q of qs) if (QUALITY[q].rank > QUALITY[worst].rank) worst = q;
  return worst;
}

export function ageText(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} วินาที`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ชม. ${m % 60} นาที`;
  return `${Math.floor(h / 24)} วัน`;
}
