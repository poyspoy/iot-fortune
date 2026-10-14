import { SCHEMA_VERSION, SYSTEMS, RULE_TYPES, AREA_KINDS, SEVERITY } from './constants.js';
import { validPlanXY, validatePos3d } from './geometry.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function cloneConfig(c) {
  return structuredClone(c);
}

/** สร้างดัชนีค้นหาเร็ว */
export function indexConfig(config) {
  const floors = new Map(config.building.floors.map((f) => [f.id, f]));
  const areas = new Map(config.building.areas.map((a) => [a.id, a]));
  const points = new Map(config.points.map((p) => [p.id, p]));
  const bySourceKey = new Map();
  for (const p of config.points) {
    bySourceKey.set(p.sourceKey || p.id, p);
  }
  const rulesByMetric = new Map();
  for (const r of config.rules) {
    const k = `${r.pointId}|${r.metricId}`;
    if (!rulesByMetric.has(k)) rulesByMetric.set(k, []);
    rulesByMetric.get(k).push(r);
  }
  return {
    floors, areas, points, bySourceKey, rulesByMetric,
    metric(pointId, metricId) {
      return points.get(pointId)?.metrics.find((m) => m.id === metricId) ?? null;
    },
    metricBySourceKey(point, key) {
      return point.metrics.find((m) => (m.sourceKey || m.id) === key) ?? null;
    },
  };
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** ตรวจความถูกต้องของการตั้งค่าทั้งหมด คืน { ok, errors[] } */
export function validateConfig(config) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!config || typeof config !== 'object') return { ok: false, errors: ['ไม่พบข้อมูลการตั้งค่า'] };
  if (config.schemaVersion !== SCHEMA_VERSION) err(`schemaVersion ต้องเป็น ${SCHEMA_VERSION}`);
  const b = config.building;
  if (!b || !Array.isArray(b.floors) || !Array.isArray(b.areas)) {
    return { ok: false, errors: [...errors, 'ข้อมูลอาคาร/ชั้น/พื้นที่ ไม่ครบ'] };
  }
  const floorIds = new Set();
  for (const f of b.floors) {
    if (!isValidId(f.id)) err(`รหัสชั้นไม่ถูกต้อง: ${f.id}`);
    if (floorIds.has(f.id)) err(`รหัสชั้นซ้ำ: ${f.id}`);
    floorIds.add(f.id);
    const m = f.model;
    if (!m || ![m.cx, m.cz, m.width, m.depth, m.elevation, m.height].every(num) || m.width <= 0 || m.depth <= 0) {
      err(`ชั้น ${f.id}: กรอบโมเดล 3D ไม่ถูกต้อง`);
    }
    if (!Array.isArray(f.footprint) || f.footprint.length < 3) err(`ชั้น ${f.id}: รูปทรงอาคารต้องมีอย่างน้อย 3 จุด`);
  }
  const areaIds = new Set();
  for (const a of b.areas) {
    if (!isValidId(a.id)) err(`รหัสพื้นที่ไม่ถูกต้อง: ${a.id}`);
    if (areaIds.has(a.id)) err(`รหัสพื้นที่ซ้ำ: ${a.id}`);
    areaIds.add(a.id);
    if (!floorIds.has(a.floorId)) err(`พื้นที่ ${a.id} อ้างถึงชั้นที่ไม่มี: ${a.floorId}`);
    if (!(a.kind in AREA_KINDS)) err(`พื้นที่ ${a.id}: ประเภทไม่รู้จัก ${a.kind}`);
  }
  const areaFloor = new Map(b.areas.map((a) => [a.id, a.floorId]));
  const floorMap = new Map(b.floors.map((f) => [f.id, f]));

  if (!Array.isArray(config.points)) return { ok: false, errors: [...errors, 'ไม่มีรายการจุด'] };
  const pointIds = new Set();
  const sourceKeys = new Set();
  const metricKeys = new Map();
  for (const p of config.points) {
    const where = `จุด ${p.id}`;
    if (!isValidId(p.id)) err(`รหัสจุดไม่ถูกต้อง: ${p.id}`);
    if (pointIds.has(p.id)) err(`รหัสจุดซ้ำ: ${p.id}`);
    pointIds.add(p.id);
    const sk = p.sourceKey || p.id;
    if (sourceKeys.has(sk)) err(`${where}: รหัสอ้างอิงต้นทาง (sourceKey) ซ้ำ ${sk}`);
    sourceKeys.add(sk);
    if (!p.name || typeof p.name !== 'string') err(`${where}: ต้องมีชื่อ`);
    if (!(p.system in SYSTEMS)) err(`${where}: ระบบไม่รู้จัก ${p.system}`);
    if (!floorIds.has(p.floorId)) err(`${where}: อ้างถึงชั้นที่ไม่มี ${p.floorId}`);
    if (p.areaId && areaFloor.get(p.areaId) !== p.floorId) err(`${where}: พื้นที่ ${p.areaId} ไม่ได้อยู่บนชั้น ${p.floorId}`);
    if (!['active', 'archived'].includes(p.status)) err(`${where}: สถานะต้องเป็น active หรือ archived`);
    if (!validPlanXY(p.plan)) err(`${where}: ตำแหน่งบนผังต้องอยู่ระหว่าง 0–1`);
    if (p.pos3d && floorMap.has(p.floorId)) {
      for (const e of validatePos3d(floorMap.get(p.floorId), p.pos3d)) err(`${where}: ${e}`);
    }
    if (!Array.isArray(p.metrics) || p.metrics.length === 0) err(`${where}: ต้องมีค่าวัดอย่างน้อย 1 ค่า`);
    const mids = new Set();
    for (const m of p.metrics || []) {
      const mw = `${where}/${m.id}`;
      if (!isValidId(m.id)) err(`${mw}: รหัสค่าวัดไม่ถูกต้อง`);
      if (mids.has(m.id)) err(`${mw}: รหัสค่าวัดซ้ำ`);
      mids.add(m.id);
      metricKeys.set(`${p.id}|${m.id}`, m);
      if (!num(m.staleAfterSec) || m.staleAfterSec < 5) err(`${mw}: เวลาหมดอายุข้อมูลต้องไม่น้อยกว่า 5 วินาที`);
      if (m.kind === 'numeric') {
        if (!m.unit || typeof m.unit !== 'string') err(`${mw}: ค่าตัวเลขต้องมีหน่วย`);
        if (m.plausible && (!num(m.plausible.min) || !num(m.plausible.max) || m.plausible.min > m.plausible.max)) {
          err(`${mw}: ช่วงค่าที่เป็นไปได้ไม่ถูกต้อง`);
        }
        for (const [u, conv] of Object.entries(m.unitConversions || {})) {
          if (!num(conv?.factor) || conv.factor === 0 || !num(conv?.offset ?? 0)) err(`${mw}: การแปลงหน่วย ${u} ไม่ถูกต้อง`);
        }
      } else if (m.kind === 'discrete') {
        if (!Array.isArray(m.states) || m.states.length < 2) err(`${mw}: ค่าสถานะต้องมีอย่างน้อย 2 สถานะ`);
        const sv = new Set();
        for (const s of m.states || []) {
          if (typeof s.value !== 'string' || !s.value) err(`${mw}: ค่าสถานะต้องเป็นข้อความ`);
          if (sv.has(s.value)) err(`${mw}: ค่าสถานะซ้ำ ${s.value}`);
          sv.add(s.value);
        }
      } else {
        err(`${mw}: ชนิดค่าวัดต้องเป็น numeric หรือ discrete`);
      }
    }
  }

  const ruleIds = new Set();
  for (const r of config.rules || []) {
    const rw = `กฎ ${r.id}`;
    if (!isValidId(r.id)) err(`รหัสกฎไม่ถูกต้อง: ${r.id}`);
    if (ruleIds.has(r.id)) err(`รหัสกฎซ้ำ: ${r.id}`);
    ruleIds.add(r.id);
    const m = metricKeys.get(`${r.pointId}|${r.metricId}`);
    if (!m) { err(`${rw}: อ้างถึงค่าวัดที่ไม่มี ${r.pointId}/${r.metricId}`); continue; }
    if (!(r.type in RULE_TYPES)) { err(`${rw}: ชนิดกฎไม่รู้จัก`); continue; }
    if (!num(r.dwellSec) || r.dwellSec < 0) err(`${rw}: เวลาคงค่า (dwell) ต้อง ≥ 0`);
    if (r.type === 'discrete') {
      if (m.kind !== 'discrete') err(`${rw}: กฎสถานะใช้ได้กับค่าวัดแบบสถานะเท่านั้น`);
      const allowed = new Set((m.states || []).map((s) => s.value));
      const entries = Object.entries(r.states || {});
      if (entries.length === 0) err(`${rw}: ต้องกำหนดสถานะที่ถือว่าผิดปกติ`);
      for (const [s, sev] of entries) {
        if (!allowed.has(s)) err(`${rw}: สถานะ ${s} ไม่มีในค่าวัด`);
        if (!(sev in SEVERITY) || sev === 'normal') err(`${rw}: ระดับของสถานะ ${s} ต้องเป็น warning หรือ critical`);
      }
      continue;
    }
    if (m.kind !== 'numeric') err(`${rw}: กฎตัวเลขใช้ได้กับค่าวัดแบบตัวเลขเท่านั้น`);
    if (!num(r.hysteresis) || r.hysteresis < 0) err(`${rw}: ฮิสเทอรีซิสต้อง ≥ 0`);
    if (r.type === 'high') {
      if (!num(r.warning) || !num(r.critical)) err(`${rw}: ต้องกำหนดค่าเตือนและค่าวิกฤต`);
      else if (r.critical < r.warning) err(`${rw}: ค่าวิกฤตต้อง ≥ ค่าเตือน (กฎค่าสูง)`);
    } else if (r.type === 'low') {
      if (!num(r.warning) || !num(r.critical)) err(`${rw}: ต้องกำหนดค่าเตือนและค่าวิกฤต`);
      else if (r.critical > r.warning) err(`${rw}: ค่าวิกฤตต้อง ≤ ค่าเตือน (กฎค่าต่ำ)`);
    } else if (r.type === 'range') {
      const v = [r.criticalLow, r.warningLow, r.warningHigh, r.criticalHigh];
      if (!v.every(num)) err(`${rw}: ต้องกำหนดขอบเขตครบทั้ง 4 ค่า`);
      else if (!(v[0] <= v[1] && v[1] < v[2] && v[2] <= v[3])) err(`${rw}: ต้องเรียง วิกฤตล่าง ≤ เตือนล่าง < เตือนบน ≤ วิกฤตบน`);
    }
  }
  return { ok: errors.length === 0, errors };
}
