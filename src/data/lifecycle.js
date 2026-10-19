// สถานะการติดตั้ง (Lifecycle) และกติกาตัดสินเดียวว่า "รับข้อมูล/นับ KPI/แจ้งเตือน" ได้หรือไม่
// ใช้ร่วมกันทุกที่ (normalize, demo, KPI, alarm) เพื่อไม่ให้มีกรณีรับค่าแต่ไม่แจ้งเตือน หรือแจ้งเตือนจากจุดที่ไม่รับค่า

export const INSTALL_STATUSES = Object.freeze(['draft', 'proposed', 'pending_approval', 'approved', 'installed', 'commissioned', 'rejected', 'decommissioned']);
export const PRE_INSTALL = Object.freeze(['draft', 'proposed', 'pending_approval', 'approved']);
export const LIVE = Object.freeze(['installed', 'commissioned']);
export const RETIRED = Object.freeze(['rejected', 'decommissioned']);

export const INSTALL_LABEL = Object.freeze({
  draft: 'ร่าง',
  proposed: 'เสนอ',
  pending_approval: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว · ยังไม่ติดตั้ง',
  installed: 'ติดตั้งแล้ว',
  commissioned: 'ส่งมอบใช้งานแล้ว',
  rejected: 'ไม่อนุมัติ',
  decommissioned: 'ปลดระวาง',
});

export const MAPPING_STATUSES = Object.freeze(['mapped', 'unanchored', 'needs_remapping']);

/** เหตุผลที่ปฏิเสธข้อมูล (คืนในผล ingest และบันทึก audit — ไม่ทิ้งเงียบ) */
export const REJECT_REASONS = Object.freeze({
  'archived-point': 'จุดถูกเก็บถาวรแล้ว',
  'not-installed': 'จุดยังไม่ติดตั้ง (ร่าง/เสนอ/รออนุมัติ/อนุมัติแล้ว)',
  'point-retired': 'จุดไม่อนุมัติหรือปลดระวางแล้ว',
  'asset-retired': 'อุปกรณ์ที่ผูกอยู่ไม่อนุมัติหรือปลดระวางแล้ว',
});

export const installStatusOf = (e) => e?.installation?.status ?? null;
export const isKnownInstallStatus = (s) => INSTALL_STATUSES.includes(s);

/** แสดงตำแหน่งบน 2D/3D ได้หรือไม่ (ทุกสถานะ ยกเว้นไม่อนุมัติ/ปลดระวาง) */
export function isDisplayable(entity) {
  const s = installStatusOf(entity);
  return isKnownInstallStatus(s) && !RETIRED.includes(s);
}

/**
 * กติกาตัดสินเดียว (DATA-LAYER-PLAN ข้อ 2.4)
 * 1) Point ตัดสินก่อน — ต้อง status = active และติดตั้งแล้ว (installed/commissioned)
 * 2) Asset ที่ผูกอยู่ "ยับยั้งได้ แต่อนุญาตแทนไม่ได้": ถ้ามี Asset ใด rejected/decommissioned → ปฏิเสธ
 * 3) สถานะไม่ตรงกันแบบอื่น ใช้ผลตามข้อ 1–2 และรายงานแยกใน statusMismatches() (ไม่เดา ไม่แก้ให้เอง)
 * @returns {{ accept: boolean, reason: null | keyof REJECT_REASONS }}
 */
export function telemetryDecision(point, boundAssets = []) {
  if (!point || point.status !== 'active') return { accept: false, reason: 'archived-point' };
  const s = installStatusOf(point);
  if (RETIRED.includes(s)) return { accept: false, reason: 'point-retired' };
  if (!LIVE.includes(s)) return { accept: false, reason: 'not-installed' };
  if (boundAssets.some((a) => RETIRED.includes(installStatusOf(a)))) return { accept: false, reason: 'asset-retired' };
  return { accept: true, reason: null };
}

/** สถานะ Point กับ Asset ที่ผูกอยู่ไม่สอดคล้องกัน (ใช้ขึ้นรายการตรวจสอบ) */
export function statusMismatches(point, boundAssets = []) {
  const ps = installStatusOf(point);
  const out = [];
  for (const a of boundAssets) {
    const as = installStatusOf(a);
    const pLive = LIVE.includes(ps); const aLive = LIVE.includes(as);
    if (pLive !== aLive || RETIRED.includes(ps) !== RETIRED.includes(as)) {
      out.push({ pointId: point.id, assetId: a.id, pointStatus: ps, assetStatus: as });
    }
  }
  return out;
}

/**
 * สถานะเริ่มต้นของจุดใหม่ — จาก Project Configuration เท่านั้น (ไม่ Hardcode ต่อโครงการ)
 * ไม่ได้กำหนด → 'proposed' (ค่าเริ่มต้นของแพลตฟอร์ม: ต้องอนุมัติก่อนรับข้อมูลจริง)
 */
export function defaultPointInstallStatus(project) {
  const s = project?.settings?.defaultPointInstallStatus;
  return isKnownInstallStatus(s) && !RETIRED.includes(s) ? s : 'proposed';
}
