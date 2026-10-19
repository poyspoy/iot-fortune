// ต่อ Data Layer เข้ากับแอปที่ยังใช้การตั้งค่า v5 (Commit 4–6)
//
// รอบนี้การตั้งค่า v5 (รหัสจุด P-003 ฯลฯ) ยังเป็นที่เก็บหลักของแอป แล้วสร้างเอกสาร v6 ในหน่วยความจำทุกครั้งที่โหลด/บันทึก
// ด้วย migrateConfigToV6 (UUID v5 → ได้ UUID เดิมทุกครั้ง) จากนั้นซ้อน "overlay" ที่เก็บสิ่งที่ v5 ไม่มี:
//   - สถานะการติดตั้งของ Point/Asset
//   - สถานะตำแหน่ง (needs_remapping + เหตุผล) และเวอร์ชันผัง/โมเดลตอนวางจุด (resolvedAgainst)
// overlay ใช้ UUID เป็นคีย์ (ไม่ใช่รหัสที่คนอ่าน) — เปลี่ยนรหัสภายหลังได้โดยไม่หลุด
//
// ข้อจำกัด (ยังไม่ใช่ Production): ID ภายในหน้าจอ/ฐานข้อมูลค่าวัดยังเป็นรหัสเดิม แปลงเป็น UUID ที่ขอบ Service
// และยังไม่ย้ายไปฐาน `@v6` (Commit 3 มีฟังก์ชันย้ายพร้อมแล้ว แต่ยังไม่เปิดใช้ในแอป)
import { migrateConfigToV6 } from './migrateV6.js';
import { SpatialDataService } from './spatialData.js';
import { makeScope } from './scope.js';
import { FORTUNE_TENANCY } from './fortuneTenancy.js';
import { isKnownInstallStatus, MAPPING_STATUSES } from './lifecycle.js';

export const OVERLAY_KEY = 'spatial.overlay';
export const OVERLAY_VERSION = 1;

export const emptyOverlay = () => ({ version: OVERLAY_VERSION, points: {}, assets: {} });

/** ตรวจ/ทำความสะอาด overlay ที่อ่านจากที่เก็บ (ค่าที่ไม่รู้จักถูกตัดทิ้ง ไม่โยน) */
export function sanitizeOverlay(o) {
  const out = emptyOverlay();
  if (!o || typeof o !== 'object') return out;
  for (const kind of ['points', 'assets']) {
    for (const [id, v] of Object.entries(o[kind] ?? {})) {
      if (!v || typeof v !== 'object') continue;
      const e = {};
      if (isKnownInstallStatus(v.installation)) e.installation = v.installation;
      if (v.mapping && MAPPING_STATUSES.includes(v.mapping.status)) {
        e.mapping = { status: v.mapping.status, reasons: Array.isArray(v.mapping.reasons) ? v.mapping.reasons.filter((r) => typeof r === 'string').slice(0, 8) : [] };
      }
      if (v.resolvedAgainst && typeof v.resolvedAgainst === 'object') {
        const r = v.resolvedAgainst; const s = (x) => (typeof x === 'string' || x === null ? x : undefined);
        e.resolvedAgainst = { coordinateSystemVersion: s(r.coordinateSystemVersion) ?? null, floorPlanVersion: s(r.floorPlanVersion) ?? null, modelVersion: s(r.modelVersion) ?? null };
      }
      if (Object.keys(e).length) out[kind][id] = e;
    }
  }
  return out;
}

function applyEntity(e, ov) {
  if (!ov) return e;
  const out = { ...e };
  if (ov.installation) out.installation = { ...e.installation, status: ov.installation, note: 'ตั้งค่าในหน้า "ข้อมูลเชิงพื้นที่"' };
  if (ov.mapping || ov.resolvedAgainst) {
    out.position = { ...e.position };
    if (ov.mapping) { out.position.mappingStatus = ov.mapping.status; out.position.remapReasons = [...ov.mapping.reasons]; }
    if (ov.resolvedAgainst) out.position.resolvedAgainst = { ...ov.resolvedAgainst };
  }
  return out;
}

/**
 * การตั้งค่า v5 + overlay → เอกสาร v6
 * @returns {{ ok: true, doc, idMap } | { ok: false, stage, errors?, conflicts? }}
 */
export function buildSpatialDoc(config, { manifest = null, overlay = null, tenancy = FORTUNE_TENANCY } = {}) {
  const res = migrateConfigToV6(config, { tenancy, manifest });
  if (!res.ok) return res;
  const ov = sanitizeOverlay(overlay);
  const doc = res.doc;
  doc.points = doc.points.map((p) => applyEntity(p, ov.points[p.id]));
  doc.assets = doc.assets.map((a) => applyEntity(a, ov.assets[a.id]));
  return { ok: true, doc, idMap: res.idMap };
}

export const fortuneScope = (t = FORTUNE_TENANCY) => makeScope({ organizationId: t.organization.id, projectId: t.project.id, buildingId: t.building.id });

/**
 * ตัวช่วยของแอป: Service + ตารางแปลงรหัส v5 ↔ UUID
 * ใช้ร่วมกันทั้งกติกา Lifecycle (engine/KPI/alarm/demo) และ 3D/2D/แผงเกจ
 */
export class SpatialRuntime {
  constructor(config, { manifest = null, overlay = null, tenancy = FORTUNE_TENANCY } = {}) {
    this.tenancy = tenancy;
    this.manifest = manifest;
    this.scope = fortuneScope(tenancy);
    this.overlay = sanitizeOverlay(overlay);
    this.service = null;
    this.error = null;
    this.rebuild(config);
  }

  /** สร้างใหม่จากการตั้งค่า (และ overlay ปัจจุบัน) — ไม่ผ่าน = คงของเดิม + error */
  rebuild(config) {
    const r = buildSpatialDoc(config, { manifest: this.manifest, overlay: this.overlay, tenancy: this.tenancy });
    if (!r.ok) {
      this.error = r.errors?.[0] ?? (r.conflicts?.length ? `คีย์ข้อมูลเข้าชนกัน ${r.conflicts.length} รายการ` : r.stage);
      return false;
    }
    if (this.service) this.service.replace(r.doc); else this.service = new SpatialDataService(r.doc, this.scope);
    this.idMap = r.idMap;
    this.error = null;
    return true;
  }

  get projectId() { return this.scope.projectId; }
  pointByCode(code) { return this.service?.pointByCode(this.projectId, code) ?? null; }
  assetByCode(code) { return this.service?.assetByCode(this.projectId, code) ?? null; }
  codeOfPoint(id) { return this.service?.point(id)?.pointCode ?? null; }

  /** กติกาเดียว (lifecycle.telemetryDecision) ด้วยรหัสจุด v5 — จุดที่ไม่รู้จักใน Service = ยอมรับตามพฤติกรรมเดิม */
  decisionByCode(code) {
    const p = this.pointByCode(code);
    if (!p) return { accept: true, reason: null };
    return this.service.decision(p.id);
  }

  installStatusByCode(code) { return this.pointByCode(code)?.installation?.status ?? null; }

  /** สถานะตำแหน่งของจุด (needs_remapping + เหตุผล) */
  mappingByCode(code) {
    const p = this.pointByCode(code);
    return p ? this.service.mapping(p) : null;
  }

  /** ถัง/บ่อ ที่มี Binding level — คืนรหัสจุด v5 ให้ส่วนหน้าจอที่ยังใช้รหัส */
  tanks() {
    return this.service ? this.service.tanks().map((t) => ({ ...t, pointCode: t.point?.pointCode ?? null, position: this.service.position(t.asset) })) : [];
  }

  pumps() {
    return this.service ? this.service.pumps().map((p) => ({ ...p, pointCode: p.point?.pointCode ?? null, position: this.service.position(p.asset) })) : [];
  }

  // ---------------------------------------------------------------- overlay
  setOverlayEntry(kind, id, patch) {
    const list = kind === 'asset' ? this.overlay.assets : this.overlay.points;
    const cur = { ...(list[id] ?? {}), ...patch };
    for (const k of Object.keys(cur)) if (cur[k] === undefined || cur[k] === null) delete cur[k];
    if (Object.keys(cur).length) list[id] = cur; else delete list[id];
    this.overlay = sanitizeOverlay(this.overlay);
  }
}
