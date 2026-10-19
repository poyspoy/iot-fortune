// SpatialDataService — แหล่งความจริงเดียวของตำแหน่ง ความสัมพันธ์ และกติกาการรับข้อมูล
// 2D และ 3D จะอ่านจาก Service เดียวกัน (ยังไม่เชื่อมกับหน้าจอในขั้นนี้)
//
// - รับเอกสาร v6 + Scope ตอนสร้าง: ตรวจเอกสาร และ Entity ที่อยู่นอก Scope ถูกปฏิเสธตั้งแต่ตอนโหลด (ไม่กรองตอนแสดง)
// - snapshot อ่านอย่างเดียว (deep freeze) — แก้จากภายนอกไม่ได้
// - ค้นด้วยรหัสต้องระบุ projectId เสมอ ไม่มีฟังก์ชันค้นด้วยรหัสอย่างเดียว
// ข้อจำกัด: การตรวจ Scope ในเบราว์เซอร์กันข้อมูลปนโดยไม่ตั้งใจเท่านั้น ไม่ใช่ความปลอดภัยของระบบหลายโครงการ
import { assertInScope, ScopeError } from './scope.js';
import { validateSpatialDoc, buildTelemetryIndex } from './entities.js';
import { telemetryDecision, statusMismatches, isDisplayable } from './lifecycle.js';
import { planToBuilding, planToMarker3D, remapCheck } from './coords.js';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export class SpatialDataError extends Error {
  constructor(message, errors = []) { super(message); this.name = 'SpatialDataError'; this.errors = errors; }
}

export class SpatialDataService {
  #listeners = new Set();

  /** @param {object} doc เอกสาร v6  @param {object} scope จาก makeScope() */
  constructor(doc, scope) {
    this.scope = scope;
    this.#load(doc);
  }

  #load(doc) {
    if (doc?.project?.id !== this.scope.projectId || doc?.organization?.id !== this.scope.organizationId || doc?.building?.id !== this.scope.buildingId) {
      throw new ScopeError('เอกสารข้อมูลเป็นของโครงการอื่น', { expected: { ...this.scope } });
    }
    const v = validateSpatialDoc(doc);
    if (!v.ok) throw new SpatialDataError(`ข้อมูลเชิงพื้นที่ไม่ผ่านการตรวจ (${v.errors.length} รายการ): ${v.errors[0]}`, v.errors);
    const snap = deepFreeze(structuredClone(doc));
    for (const list of [snap.floors, snap.areas, snap.points, snap.assets, snap.bindings]) {
      for (const e of list ?? []) assertInScope(e, this.scope);
    }
    const byId = (list) => new Map((list ?? []).map((e) => [e.id, e]));
    const group = (list, key) => {
      const m = new Map();
      for (const e of list ?? []) { if (!m.has(e[key])) m.set(e[key], []); m.get(e[key]).push(e); }
      return m;
    };
    this.doc = snap;
    this.#idx = {
      floors: byId(snap.floors), areas: byId(snap.areas), points: byId(snap.points), assets: byId(snap.assets),
      floorByCode: new Map(snap.floors.map((f) => [`${f.projectId}|${f.code}`, f])),
      pointByCode: new Map(snap.points.map((p) => [`${p.projectId}|${p.pointCode}`, p])),
      assetByCode: new Map((snap.assets ?? []).map((a) => [`${a.projectId}|${a.assetCode}`, a])),
      pointsByFloor: group(snap.points, 'floorId'), assetsByFloor: group(snap.assets, 'floorId'),
      bindingsByAsset: group(snap.bindings, 'assetId'), bindingsByPoint: group(snap.bindings, 'pointId'),
      telemetry: buildTelemetryIndex(snap.points),
    };
  }

  #idx = null;

  /** แทนเอกสารทั้งก้อน (ตรวจใหม่ทั้งหมด) แล้วแจ้งผู้ฟัง — ผิดพลาด = คงข้อมูลเดิม */
  replace(doc) {
    const prev = { doc: this.doc, idx: this.#idx };
    try { this.#load(doc); } catch (e) { this.doc = prev.doc; this.#idx = prev.idx; throw e; }
    for (const fn of this.#listeners) fn(this);
  }

  onChange(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  // ------------------------------------------------------------ ค้นหา
  get project() { return this.doc.project; }
  floors() { return this.doc.floors; }
  floor(id) { return this.#idx.floors.get(id) ?? null; }
  floorByCode(projectId, code) { return this.#idx.floorByCode.get(`${projectId}|${code}`) ?? null; }
  area(id) { return this.#idx.areas.get(id) ?? null; }
  point(id) { return this.#idx.points.get(id) ?? null; }
  pointByCode(projectId, code) { return this.#idx.pointByCode.get(`${projectId}|${code}`) ?? null; }
  asset(id) { return this.#idx.assets.get(id) ?? null; }
  assetByCode(projectId, code) { return this.#idx.assetByCode.get(`${projectId}|${code}`) ?? null; }
  pointsOnFloor(floorId) { return this.#idx.pointsByFloor.get(floorId) ?? []; }
  assetsOnFloor(floorId) { return this.#idx.assetsByFloor.get(floorId) ?? []; }

  bindingsOfAsset(assetId) { return this.#idx.bindingsByAsset.get(assetId) ?? []; }
  bindingsOfPoint(pointId) { return this.#idx.bindingsByPoint.get(pointId) ?? []; }
  assetsOfPoint(pointId) { return this.bindingsOfPoint(pointId).map((b) => this.asset(b.assetId)); }
  /** Binding ของอุปกรณ์ตามบทบาท (เช่น 'level', 'run') */
  binding(assetId, role) { return this.bindingsOfAsset(assetId).find((b) => b.role === role) ?? null; }

  // ------------------------------------------------------------ อุปกรณ์ที่มีภาพ
  /** ถัง/บ่อ ที่มีจุดระดับน้ำ (บทบาท level) — ไม่พึ่งรหัสจุดในโค้ด */
  tanks() {
    return (this.doc.assets ?? []).filter((a) => (a.type === 'tank' || a.type === 'pit') && isDisplayable(a)).map((a) => {
      const b = this.binding(a.id, 'level');
      return b ? { asset: a, point: this.point(b.pointId), metricId: b.metricId } : null;
    }).filter(Boolean);
  }

  /** ปั๊มที่มีจุดสถานะเดิน (บทบาท run) */
  pumps() {
    return (this.doc.assets ?? []).filter((a) => a.type === 'pump' && isDisplayable(a)).map((a) => {
      const b = this.binding(a.id, 'run');
      return { asset: a, point: b ? this.point(b.pointId) : null, metricId: b?.metricId ?? null };
    });
  }

  // ------------------------------------------------------------ Lifecycle
  displayPoints() { return this.doc.points.filter(isDisplayable); }
  decision(pointId) { const p = this.point(pointId); return telemetryDecision(p, p ? this.assetsOfPoint(p.id) : []); }
  telemetryPoints() { return this.doc.points.filter((p) => this.decision(p.id).accept); }

  /**
   * จับคู่ข้อมูลเข้า (projectId, sourceKey, metricSourceKey) → จุด/ค่าวัด + ผลตัดสิน
   * โครงการอื่น/ไม่รู้จัก → ปฏิเสธพร้อมเหตุผล (ไม่ตกไปหาโครงการอื่น ไม่เดา)
   */
  resolveTelemetry(projectId, sourceKey, metricKey) {
    if (projectId !== this.scope.projectId) return { accept: false, reason: 'unknown-point', pointId: null, metricId: null };
    const hit = this.#idx.telemetry.lookup(projectId, sourceKey, metricKey);
    if (!hit) {
      const anyPoint = this.doc.points.some((p) => (p.sourceKey || p.pointCode) === sourceKey);
      return { accept: false, reason: anyPoint ? 'unknown-metric' : 'unknown-point', pointId: null, metricId: null };
    }
    return { ...this.decision(hit.pointId), ...hit };
  }

  // ------------------------------------------------------------ ตำแหน่ง
  /** สถานะการผูกตำแหน่งที่ใช้จริง: needs_remapping ถ้าเวอร์ชันพิกัด/ผัง/โมเดลเปลี่ยนจากตอนวาง */
  mapping(entity) {
    const f = this.floor(entity.floorId);
    const r = remapCheck(entity.position.resolvedAgainst ?? null, {
      coordinateSystemVersion: this.doc.building.coordinateSystem?.version ?? null,
      floorPlanVersion: f?.floorPlanVersion ?? null, modelVersion: f?.modelVersion ?? null,
    });
    const stored = entity.position.mappingStatus;
    const reasons = [...(entity.position.remapReasons ?? []), ...r.reasons];
    return { status: r.needsRemapping || stored === 'needs_remapping' ? 'needs_remapping' : stored, reasons: [...new Set(reasons)] };
  }

  /** ตำแหน่งของ Point/Asset: ผัง (u, v) · Building CRS (x, z) · ตำแหน่งหมุด 3D ระดับชั้นจริง */
  position(entity) {
    const f = this.floor(entity.floorId);
    const plan = entity.position.plan;
    return { plan, building: planToBuilding(f.frame, plan), marker3d: entity.position.xyz ?? planToMarker3D(f.frame, plan) };
  }

  // ------------------------------------------------------------ รายการตรวจสอบ
  /** needs_remapping (รวมที่ตรวจพบจากเวอร์ชัน) + สถานะ Point/Asset ไม่ตรงกัน — ไม่ลบ ไม่ซ่อน */
  reviewList() {
    const out = [];
    for (const [kind, list] of [['point', this.doc.points], ['asset', this.doc.assets ?? []]]) {
      for (const e of list) {
        const m = this.mapping(e);
        if (m.status !== 'needs_remapping') continue;
        const f = this.floor(e.floorId);
        out.push({
          kind, id: e.id, code: kind === 'point' ? e.pointCode : e.assetCode, name: e.name, issue: 'needs-remapping', reasons: m.reasons,
          floorId: e.floorId, floorCode: f?.code ?? null, areaId: e.areaId ?? null, anchor: e.position.anchor ?? null,
          resolvedAgainst: e.position.resolvedAgainst ?? null,
          current: { floorPlanVersion: f?.floorPlanVersion ?? null, modelVersion: f?.modelVersion ?? null },
        });
      }
    }
    for (const p of this.doc.points) {
      for (const mm of statusMismatches(p, this.assetsOfPoint(p.id))) {
        out.push({ kind: 'point', id: p.id, code: p.pointCode, name: p.name, issue: 'status-mismatch', reasons: ['status-mismatch'], floorId: p.floorId, floorCode: this.floor(p.floorId)?.code ?? null, detail: mm });
      }
    }
    return out;
  }
}
