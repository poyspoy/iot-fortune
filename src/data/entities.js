// ตรวจความถูกต้องของเอกสารข้อมูลเชิงพื้นที่ v6 (Floor / Area / Point / Asset / Binding)
// - ทุก Entity มี organizationId / projectId / buildingId ตรงกับโครงการของเอกสาร
// - id เป็น UUID · รหัสแสดงผล unique ต่อ (projectId, code)
// - ความสัมพันธ์ Point–Asset อยู่ใน Binding เท่านั้น (บทบาทระบุชัด)
// - คีย์ Telemetry (projectId, sourceKey, metricSourceKey) ไม่คลุมเครือ (แก้ BD-001)
import { isUuid } from './ids.js';
import { INSTALL_STATUSES, MAPPING_STATUSES, RETIRED, installStatusOf } from './lifecycle.js';

export const SCHEMA_V6 = 6;
export const ASSET_TYPES = Object.freeze(['pump', 'tank', 'pit', 'ahu', 'chiller', 'panel', 'meter', 'elevator', 'sensor-gateway', 'other']);
/** บทบาทที่ Asset มีได้ครั้งเดียว (ภาพถังใช้ระดับน้ำเดียว ปั๊มใช้สถานะเดินเดียว) */
export const SINGLE_ROLES = Object.freeze(['level', 'run']);
export const BINDING_ROLES = Object.freeze(['level', 'run', 'current', 'temperature', 'humidity', 'power', 'energy', 'leak', 'value']);

const SCOPE_KEYS = ['organizationId', 'projectId', 'buildingId'];

/** คีย์ข้อมูลเข้าของค่าวัด (ว่าง = ใช้รหัส) — ตามสัญญา Telemetry เดิม */
export const pointSourceKey = (p) => p.sourceKey || p.pointCode;
export const metricSourceKey = (m) => m.sourceKey || m.id;

/** จุดที่ยังถือคีย์ Telemetry อยู่ (ไม่รวมเก็บถาวร/ไม่อนุมัติ/ปลดระวาง) */
export const holdsTelemetryKey = (p) => p.status === 'active' && !RETIRED.includes(installStatusOf(p));

/**
 * คีย์ Telemetry ที่ชนกัน — ใช้ทั้งการตรวจเอกสาร v6 และการตรวจก่อน Migration
 * @param {Array} points  จุดที่มี projectId (v6) — หรือส่ง projectId แยกสำหรับข้อมูล v5
 * @returns {Array<{ projectId, sourceKey, metricSourceKey, entries: Array<{ pointId, pointCode, metricId }> }>}
 */
export function telemetryKeyConflicts(points, { projectId = null, codeOf = (p) => p.pointCode ?? p.id, includeAll = false } = {}) {
  const groups = new Map();
  for (const p of points) {
    if (!includeAll && !holdsTelemetryKey(p)) continue;
    const proj = p.projectId ?? projectId;
    const sk = p.sourceKey || codeOf(p);
    for (const m of p.metrics ?? []) {
      const key = JSON.stringify([proj, sk, metricSourceKey(m)]);
      if (!groups.has(key)) groups.set(key, { projectId: proj, sourceKey: sk, metricSourceKey: metricSourceKey(m), entries: [] });
      groups.get(key).entries.push({ pointId: p.id, pointCode: codeOf(p), metricId: m.id });
    }
  }
  return [...groups.values()].filter((g) => g.entries.length > 1);
}

/**
 * ดัชนี Telemetry: (projectId, sourceKey, metricSourceKey) → { pointId, metricId }
 * คีย์ชน = โยนข้อผิดพลาด (ไม่เลือกตัวใดตัวหนึ่งให้เอง ไม่ทับเงียบ)
 */
export function buildTelemetryIndex(points) {
  const conflicts = telemetryKeyConflicts(points);
  if (conflicts.length) {
    const e = new Error(`คีย์ข้อมูลเข้าซ้ำ ${conflicts.length} รายการ`);
    e.name = 'TelemetryKeyConflict';
    e.conflicts = conflicts;
    throw e;
  }
  const map = new Map();
  for (const p of points) {
    if (!holdsTelemetryKey(p)) continue;
    for (const m of p.metrics) map.set(JSON.stringify([p.projectId, pointSourceKey(p), metricSourceKey(m)]), { pointId: p.id, metricId: m.id });
  }
  return {
    size: map.size,
    /** ไม่พบ = null (ไม่ตกไปหาโครงการอื่น ไม่เดา) */
    lookup(projectId, sourceKey, metricKey) {
      return map.get(JSON.stringify([projectId, sourceKey, metricKey])) ?? null;
    },
  };
}

function checkPosition(pos, where, err) {
  if (!pos || typeof pos !== 'object') { err(`${where}: ต้องมีตำแหน่ง`); return; }
  const { u, v } = pos.plan ?? {};
  if (![u, v].every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) err(`${where}: ตำแหน่งบนผังต้องอยู่ระหว่าง 0–1`);
  if (pos.xyz != null && !['x', 'y', 'z'].every((k) => Number.isFinite(pos.xyz[k]))) err(`${where}: พิกัด 3D ต้องเป็นตัวเลข`);
  if (!MAPPING_STATUSES.includes(pos.mappingStatus)) err(`${where}: สถานะการผูกตำแหน่งไม่รู้จัก ${pos.mappingStatus}`);
}

/**
 * ตรวจเอกสาร v6 ทั้งก้อน
 * @returns {{ ok: boolean, errors: string[], conflicts: Array }}
 */
export function validateSpatialDoc(doc) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!doc || doc.schemaVersion !== SCHEMA_V6) return { ok: false, errors: ['ไม่ใช่เอกสาร schemaVersion 6'], conflicts: [] };
  const { organization: org, project, building } = doc;
  if (!isUuid(org?.id) || !isUuid(org?.namespaceId)) err('องค์กรต้องมี id และ namespaceId เป็น UUID');
  if (org?.id && org.id === org.namespaceId) err('namespaceId ต้องแยกจาก organizationId');
  if (!isUuid(project?.id) || project?.organizationId !== org?.id) err('โครงการต้องมี id เป็น UUID และอยู่ในองค์กรนี้');
  if (!isUuid(building?.id) || building?.projectId !== project?.id || building?.organizationId !== org?.id) err('อาคารต้องมี id เป็น UUID และอยู่ในโครงการนี้');
  const scope = { organizationId: org?.id, projectId: project?.id, buildingId: building?.id };
  const ids = new Set();
  const entity = (e, kind) => {
    const where = `${kind} ${e?.code ?? e?.pointCode ?? e?.assetCode ?? e?.id}`;
    if (!isUuid(e?.id)) err(`${where}: id ต้องเป็น UUID`);
    else if (ids.has(e.id)) err(`${where}: id ซ้ำ ${e.id}`);
    else ids.add(e.id);
    for (const k of SCOPE_KEYS) if (e?.[k] !== scope[k]) err(`${where}: ${k} ไม่ตรงกับโครงการของเอกสาร`);
    return where;
  };
  const uniqueCode = (list, codeKey, kind) => {
    const seen = new Map();
    for (const e of list) {
      const k = `${e.projectId}|${e[codeKey]}`;
      if (!e[codeKey]) err(`${kind} ${e.id}: ต้องมี ${codeKey}`);
      else if (seen.has(k)) err(`${kind}: ${codeKey} ซ้ำในโครงการ ${e[codeKey]}`);
      seen.set(k, e.id);
    }
  };

  const floors = Array.isArray(doc.floors) ? doc.floors : (err('ไม่มีรายการชั้น'), []);
  const areas = Array.isArray(doc.areas) ? doc.areas : [];
  const points = Array.isArray(doc.points) ? doc.points : (err('ไม่มีรายการจุด'), []);
  const assets = Array.isArray(doc.assets) ? doc.assets : [];
  const bindings = Array.isArray(doc.bindings) ? doc.bindings : [];
  const floorIds = new Set(); const areaFloor = new Map();
  for (const f of floors) {
    const w = entity(f, 'ชั้น'); floorIds.add(f.id);
    if (!f.frame || !Array.isArray(f.frame.transform) || f.frame.transform.length !== 6 || !f.frame.transform.every(Number.isFinite)) err(`${w}: ต้องมี frame.transform 6 ค่า`);
  }
  uniqueCode(floors, 'code', 'ชั้น');
  for (const a of areas) { const w = entity(a, 'พื้นที่'); if (!floorIds.has(a.floorId)) err(`${w}: อ้างถึงชั้นที่ไม่มี`); areaFloor.set(a.id, a.floorId); }
  uniqueCode(areas, 'code', 'พื้นที่');

  const pointById = new Map();
  for (const p of points) {
    const w = entity(p, 'จุด'); pointById.set(p.id, p);
    if (!floorIds.has(p.floorId)) err(`${w}: อ้างถึงชั้นที่ไม่มี`);
    if (p.areaId != null && areaFloor.get(p.areaId) !== p.floorId) err(`${w}: พื้นที่ไม่ได้อยู่บนชั้นเดียวกัน`);
    if (!['active', 'archived'].includes(p.status)) err(`${w}: สถานะการติดตามต้องเป็น active หรือ archived`);
    if (!INSTALL_STATUSES.includes(installStatusOf(p))) err(`${w}: สถานะการติดตั้งไม่รู้จัก ${installStatusOf(p)}`);
    checkPosition(p.position, w, err);
    if (!Array.isArray(p.metrics) || !p.metrics.length) err(`${w}: ต้องมีค่าวัดอย่างน้อย 1 ค่า`);
    const mids = new Set(); const mkeys = new Map();
    for (const m of p.metrics ?? []) {
      if (mids.has(m.id)) err(`${w}/${m.id}: รหัสค่าวัดซ้ำ`);
      mids.add(m.id);
      const k = metricSourceKey(m);
      // BD-001: ค่าวัดภายในจุดเดียวกันห้ามมี metricSourceKey ซ้ำ (ค่าวัดหลังจะไม่ได้รับข้อมูลเงียบ ๆ)
      if (mkeys.has(k)) err(`${w}: metricSourceKey ซ้ำ "${k}" ในค่าวัด ${mkeys.get(k)} และ ${m.id}`);
      mkeys.set(k, m.id);
    }
  }
  uniqueCode(points, 'pointCode', 'จุด');

  const assetById = new Map();
  for (const a of assets) {
    const w = entity(a, 'อุปกรณ์'); assetById.set(a.id, a);
    if (!ASSET_TYPES.includes(a.type)) err(`${w}: ชนิดอุปกรณ์ไม่รู้จัก ${a.type}`);
    if (!floorIds.has(a.floorId)) err(`${w}: อ้างถึงชั้นที่ไม่มี`);
    if (!INSTALL_STATUSES.includes(installStatusOf(a))) err(`${w}: สถานะการติดตั้งไม่รู้จัก`);
    if (typeof a.isDemo !== 'boolean') err(`${w}: ต้องระบุ isDemo`);
    checkPosition(a.position, w, err);
  }
  uniqueCode(assets, 'assetCode', 'อุปกรณ์');

  const single = new Set();
  for (const b of bindings) {
    const w = entity(b, 'การผูก');
    const p = pointById.get(b.pointId); const a = assetById.get(b.assetId);
    if (!p) err(`${w}: อ้างถึงจุดที่ไม่มี`);
    if (!a) err(`${w}: อ้างถึงอุปกรณ์ที่ไม่มี`);
    if (!BINDING_ROLES.includes(b.role)) err(`${w}: บทบาทไม่รู้จัก ${b.role}`);
    if (p && !p.metrics.some((m) => m.id === b.metricId)) err(`${w}: ค่าวัด ${b.metricId} ไม่มีในจุด ${p.pointCode}`);
    if (p && a && p.floorId !== a.floorId) err(`${w}: จุดและอุปกรณ์อยู่คนละชั้น`);
    if (SINGLE_ROLES.includes(b.role)) {
      const k = `${b.assetId}|${b.role}`;
      if (single.has(k)) err(`${w}: อุปกรณ์มีบทบาท ${b.role} ซ้ำ`);
      single.add(k);
    }
  }

  const conflicts = telemetryKeyConflicts(points);
  for (const c of conflicts) err(`คีย์ข้อมูลเข้าซ้ำ (${c.sourceKey}, ${c.metricSourceKey}): ${c.entries.map((e) => `${e.pointCode}/${e.metricId}`).join(', ')}`);
  return { ok: errors.length === 0, errors, conflicts };
}
