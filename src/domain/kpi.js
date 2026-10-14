import { severityRank } from './constants.js';
import { worstQuality } from './quality.js';
import { isEpisodeActive, isEpisodeUnresolved } from './alarms.js';

/**
 * สรุปสถานะของจุดแบบระมัดระวัง
 * - severity : ระดับสูงสุดของการแจ้งเตือนที่ยังเกิดอยู่ในทุกค่าวัดของจุด
 * - quality  : คุณภาพแย่ที่สุดของทุกค่าวัด (ไม่ถูกต้อง > เก่า > ยังไม่มีข้อมูล > สดใหม่)
 * - attention: ต้องดูแล ถ้ามีการแจ้งเตือนที่ยังเกิดอยู่ หรือมีค่าวัดใดไม่สดใหม่
 *   (ข้อมูลไม่สดใหม่ไม่ถือว่า "ปกติ" — ไม่สามารถยืนยันได้)
 */
export function pointStatus(point, qualities, episodes) {
  let severity = 'normal';
  for (const ep of episodes) {
    if (ep.pointId === point.id && isEpisodeActive(ep) && severityRank(ep.severity) > severityRank(severity)) severity = ep.severity;
  }
  const quality = worstQuality(point.metrics.map((m) => qualities(point.id, m.id)));
  return { severity, quality, attention: severity !== 'normal' || quality !== 'fresh' };
}

/**
 * ตัวชี้วัด (นับเป็น "จำนวนจุด" ยกเว้นที่ระบุว่าเป็น "เหตุการณ์")
 * - activePoints      : จุดที่ active (ไม่รวมจุดเก็บถาวร)
 * - attentionPoints   : จุดที่ต้องดูแล (นับจุดละ 1 แม้มีหลายค่าวัดผิดปกติ)
 * - criticalPoints    : จุดที่มีการแจ้งเตือนระดับวิกฤตที่ยังเกิดอยู่
 * - notFreshPoints    : จุดที่มีค่าวัดอย่างน้อยหนึ่งค่าไม่สดใหม่
 * - unresolvedAlerts  : เหตุการณ์แจ้งเตือนระดับค่าวัดที่ยังเกิดอยู่ หรือยังไม่ได้รับทราบ
 * - activeAlerts      : เหตุการณ์ที่ยังเกิดอยู่ (ระดับค่าวัด)
 */
export function computeKpis(points, qualities, episodes) {
  const active = points.filter((p) => p.status === 'active');
  const activeIds = new Set(active.map((p) => p.id));
  const k = { activePoints: active.length, attentionPoints: 0, criticalPoints: 0, notFreshPoints: 0, unresolvedAlerts: 0, activeAlerts: 0 };
  for (const p of active) {
    const st = pointStatus(p, qualities, episodes);
    if (st.attention) k.attentionPoints++;
    if (st.severity === 'critical') k.criticalPoints++;
    if (st.quality !== 'fresh') k.notFreshPoints++;
  }
  for (const ep of episodes) {
    if (!activeIds.has(ep.pointId)) continue;
    if (isEpisodeUnresolved(ep)) k.unresolvedAlerts++;
    if (isEpisodeActive(ep)) k.activeAlerts++;
  }
  return k;
}
