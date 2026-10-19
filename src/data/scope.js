// ขอบเขตข้อมูล (Scope) — organizationId / projectId / buildingId
//
// ข้อจำกัดสำคัญ (DATA-LAYER-PLAN ข้อ 2.6.1): การตรวจ Scope ในเบราว์เซอร์ช่วยกันข้อมูลคนละโครงการ
// ปนกัน "โดยไม่ตั้งใจ" (โค้ดผิด/ตั้งค่าผิด) เท่านั้น — ไม่ใช่ความปลอดภัยของระบบหลายโครงการ
// ก่อน Production ต้องมี Authentication + Server-side Authorization + Database/RLS ตรวจทุกคำขอ
import { isUuid } from './ids.js';

export class ScopeError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ScopeError';
    this.detail = detail;
  }
}

const KEYS = ['organizationId', 'projectId', 'buildingId'];

/** สร้าง Scope (แก้ไขไม่ได้) — ทุกค่าต้องเป็น UUID */
export function makeScope({ organizationId, projectId, buildingId }) {
  const s = { organizationId, projectId, buildingId };
  for (const k of KEYS) if (!isUuid(s[k])) throw new ScopeError(`${k} ต้องเป็น UUID`, { [k]: s[k] });
  return Object.freeze(s);
}

/** Entity อยู่ใน Scope นี้หรือไม่ (ตรวจครบทั้ง 3 ระดับ) */
export function inScope(entity, scope) {
  return !!entity && KEYS.every((k) => entity[k] === scope[k]);
}

/** ยืนยันว่า Entity อยู่ใน Scope — ไม่อยู่ = โยน ScopeError (ไม่กรองเงียบ ๆ) */
export function assertInScope(entity, scope, what = 'ข้อมูล') {
  if (!inScope(entity, scope)) {
    throw new ScopeError(`${what} อยู่นอกขอบเขตโครงการปัจจุบัน`, {
      id: entity?.id ?? null,
      expected: { ...scope },
      got: Object.fromEntries(KEYS.map((k) => [k, entity?.[k] ?? null])),
    });
  }
  return entity;
}

/** ฟิลด์ Scope สำหรับติดให้ Entity ใหม่ */
export function scopeFields(scope) {
  return { organizationId: scope.organizationId, projectId: scope.projectId, buildingId: scope.buildingId };
}
