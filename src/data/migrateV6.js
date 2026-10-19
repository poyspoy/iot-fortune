// Migration การตั้งค่า v5 → เอกสารข้อมูลเชิงพื้นที่ v6 (ฟังก์ชันบริสุทธิ์ คืนสำเนาใหม่ ไม่แก้ของเดิม)
// - ตรวจคีย์ Telemetry ชนกันก่อน: พบ = หยุด คืนรายการที่ชน (ไม่เลือก ไม่เขียนทับ)
// - UUID v5 ของทุก Entity: namespace ถาวรขององค์กร + Project UUID + ชนิด + รหัสเดิม → ทำซ้ำได้ผลเดิมทุกไบต์
// - ตำแหน่ง/ค่า/ชื่อ/เกณฑ์ของเดิมคงไว้ทุกค่า (plan.x/y → position.plan.u/v ตัวเลขเดียวกัน)
import { legacyEntityId } from './ids.js';
import { floorFrame, floorVersions, COORDINATE_SYSTEM } from './coords.js';
import { telemetryKeyConflicts, validateSpatialDoc, SCHEMA_V6 } from './entities.js';
import { FORTUNE_LEGACY_EQUIPMENT, FORTUNE_GAUGE_ASSETS } from './fortuneTenancy.js';

export const V5 = 5;

/**
 * คีย์ Telemetry ที่ชนกันในการตั้งค่า v5 (รวมค่าวัดซ้ำในจุดเดียวกัน — BD-001)
 * จุด v5 ทุกจุดที่ active ถือคีย์ (ยังไม่มีสถานะติดตั้ง)
 */
export function precheckV5(config, projectId) {
  const pts = (config?.points ?? []).map((p) => ({ ...p, projectId }));
  return telemetryKeyConflicts(pts, { codeOf: (p) => p.id });
}

const sc = (t) => ({ organizationId: t.organization.id, projectId: t.project.id, buildingId: t.building.id });

/**
 * @param {object} config  การตั้งค่า v5 (ผ่าน migrateConfig ของรุ่นเดิมมาแล้ว)
 * @param {{ tenancy: object, manifest: object|null, equipment?: object, gaugeAssets?: object }} o
 * @returns {{ ok: true, doc, idMap } | { ok: false, stage: 'schema'|'precheck'|'validate', conflicts?: Array, errors?: string[] }}
 */
export function migrateConfigToV6(config, { tenancy, manifest, equipment = FORTUNE_LEGACY_EQUIPMENT, gaugeAssets = FORTUNE_GAUGE_ASSETS }) {
  if (config?.schemaVersion !== V5) return { ok: false, stage: 'schema', errors: [`ต้องเป็นการตั้งค่า schemaVersion 5 (ได้ ${config?.schemaVersion})`] };
  const T = tenancy; const S = sc(T); const ns = T.organization.namespaceId; const pid = T.project.id;
  const conflicts = precheckV5(config, pid);
  if (conflicts.length) return { ok: false, stage: 'precheck', conflicts };

  const uid = (type, code) => legacyEntityId(ns, pid, type, code);
  const idMap = { floor: {}, area: {}, point: {}, asset: {}, binding: {}, rule: {} };
  const v5 = structuredClone(config);

  const floors = v5.building.floors.map((f) => {
    const versions = floorVersions(f, manifest);
    const fr = floorFrame(f, versions);
    const id = uid('floor', f.id); idMap.floor[f.id] = id;
    return {
      id, code: f.id, ...S, name: f.name, order: f.order, kind: f.kind,
      plan: f.plan, footprint: f.footprint, model: f.model, detail: f.detail ?? null,
      frame: { transform: [...fr.transform], elevation: fr.elevation, height: fr.height },
      floorPlanVersion: versions.floorPlanVersion, modelVersion: versions.modelVersion,
    };
  });
  const floorV = Object.fromEntries(floors.map((f) => [f.code, { coordinateSystemVersion: COORDINATE_SYSTEM.version, floorPlanVersion: f.floorPlanVersion, modelVersion: f.modelVersion }]));
  const areas = v5.building.areas.map((a) => {
    const id = uid('area', a.id); idMap.area[a.id] = id;
    return { id, code: a.id, ...S, floorId: idMap.floor[a.floorId], name: a.name, kind: a.kind };
  });
  const position = (plan, xyz, floorCode) => ({
    plan: { u: plan.x, v: plan.y }, xyz: xyz ? { ...xyz } : null, mappingStatus: 'unanchored', anchor: null, remapReasons: [],
    resolvedAgainst: { ...floorV[floorCode] },
  });

  const points = v5.points.map((p) => {
    const id = uid('point', p.id); idMap.point[p.id] = id;
    return {
      id, pointCode: p.id, ...S, floorId: idMap.floor[p.floorId], areaId: p.areaId ? idMap.area[p.areaId] ?? null : null,
      sourceKey: p.sourceKey || p.id, name: p.name, system: p.system, status: p.status, isDemo: !!p.example,
      installation: { status: 'installed', note: 'ย้ายจากรุ่นก่อน — คงพฤติกรรมเดิม (รับข้อมูล/KPI/แจ้งเตือน)' },
      position: position(p.plan, p.pos3d, p.floorId),
      metrics: structuredClone(p.metrics),
      legacy: { equipmentId: p.equipmentId ?? '', example: !!p.example },
    };
  });

  const assets = []; const bindings = [];
  const addBinding = (assetId, assetCode, pointCode, role, metricId) => {
    const key = `${assetCode}:${role}:${metricId}`;
    const id = uid('binding', key); idMap.binding[key] = id;
    bindings.push({ id, ...S, assetId, pointId: idMap.point[pointCode], role, metricId });
  };
  // อุปกรณ์จาก equipmentId (ตามตารางของโครงการ) — equipmentId ที่ไม่รู้จักยังไม่สร้าง Asset (ไม่เดาชนิด)
  const byEquip = new Map();
  for (const p of v5.points) if (p.equipmentId && equipment[p.equipmentId]) { if (!byEquip.has(p.equipmentId)) byEquip.set(p.equipmentId, []); byEquip.get(p.equipmentId).push(p); }
  for (const [eq, pts] of byEquip) {
    const def = equipment[eq]; const host = pts[0];
    const id = uid('asset', def.assetCode); idMap.asset[def.assetCode] = id;
    assets.push({
      id, assetCode: def.assetCode, ...S, type: def.type, name: def.name, isDemo: pts.every((p) => !!p.example),
      floorId: idMap.floor[host.floorId], areaId: host.areaId ? idMap.area[host.areaId] ?? null : null,
      installation: { status: 'installed', note: 'ย้ายจากรุ่นก่อน (equipmentId เดิม)' }, position: position(host.plan, null, host.floorId),
      visual: def.visual ? structuredClone(def.visual) : null, legacy: { equipmentId: eq },
    });
    for (const p of pts) for (const m of p.metrics) if (def.roles[m.id]) addBinding(id, def.assetCode, p.id, def.roles[m.id], m.id);
  }
  // ถัง/บ่อจากค่าวัดที่มี gauge
  const seq = {};
  for (const p of v5.points) {
    const m = p.metrics.find((x) => x.gauge);
    if (!m) continue;
    const kind = m.gauge.visual === 'pit' ? 'pit' : 'tank';
    const g = gaugeAssets[kind];
    seq[kind] = (seq[kind] ?? 0) + 1;
    const code = `${g.codePrefix}${String(seq[kind]).padStart(3, '0')}`;
    const id = uid('asset', code); idMap.asset[code] = id;
    assets.push({
      id, assetCode: code, ...S, type: g.type, name: `${g.namePrefix} — ${p.name}`, isDemo: !!p.example,
      floorId: idMap.floor[p.floorId], areaId: p.areaId ? idMap.area[p.areaId] ?? null : null,
      installation: { status: 'installed', note: 'ย้ายจากรุ่นก่อน (ภาพถังจากค่าวัด gauge)' }, position: position(p.plan, null, p.floorId),
      visual: { kind, offset: { ...g.offset } }, legacy: { gaugePoint: p.id },
    });
    addBinding(id, code, p.id, 'level', m.id);
  }

  const rules = v5.rules.map((r) => {
    const id = uid('rule', r.id); idMap.rule[r.id] = id;
    return { ...structuredClone(r), id, ruleCode: r.id, ...S, pointId: idMap.point[r.pointId] };
  });

  const doc = {
    schemaVersion: SCHEMA_V6,
    organization: { ...T.organization },
    project: { id: pid, organizationId: T.organization.id, code: T.project.code, name: T.project.name, settings: { ...T.project.settings } },
    building: {
      id: T.building.id, organizationId: T.organization.id, projectId: pid, code: T.building.code, name: v5.building.name,
      coordinateSystem: { ...COORDINATE_SYSTEM },
      legacy: { id: v5.building.id, referenceStatus: v5.building.referenceStatus, referenceNote: v5.building.referenceNote, modelSrc: v5.building.modelSrc, towerNote: v5.building.towerNote },
    },
    floors, areas, points, assets, bindings, rules,
    migratedFrom: { schemaVersion: V5 },
  };
  const v = validateSpatialDoc(doc);
  if (!v.ok) return { ok: false, stage: 'validate', errors: v.errors, conflicts: v.conflicts };
  return { ok: true, doc, idMap };
}

/** รหัสตัวอย่างของข้อมูลค่าวัดหลังเปลี่ยน pointId เป็น UUID (รูปแบบเดิมของ sampleId) */
export const sampleIdV6 = (source, pointId, metricId, observedAt) => `${source}:${pointId}:${metricId}:${observedAt}`;
