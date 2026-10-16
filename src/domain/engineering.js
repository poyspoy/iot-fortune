// ข้อมูลแบบวิศวกรรม (Engineering Drawing) — แยกจากหน้าจอและฉาก 3 มิติ
// รูปแบบ: คล้าย GeoJSON (Feature: Point / LineString / Polygon) พิกัด [x, y] เป็นพิกัดปกติบนผังชั้น 0–1
// ตอนนี้มาจากไฟล์จำลอง public/engineering/floor-<ชั้น>.json; อนาคตแปลงจาก DXF/SVG/GeoJSON หรือรับจาก Backend
// แล้วส่งผ่าน parseEngineering() ชุดเดียวกัน — หน้าจอและฉากไม่ต้องแก้

export const ENGINEERING_SCHEMA = 'iot-fortune.engineering/v1';
export const ENG_DISCLAIMER = 'แบบวิศวกรรมจำลอง · ไม่ใช่แบบก่อสร้างจริง';

export const KIND_LABEL = {
  grid: 'เส้นกริด', column: 'เสา', beam: 'คาน',
  cable: 'แนวสายไฟ', panel: 'ตู้ไฟฟ้า', device: 'อุปกรณ์ไฟฟ้า',
  pipe: 'แนวท่อ', valve: 'วาล์ว',
};

const PROP_LABEL = {
  size: 'ขนาด', material: 'วัสดุ', load: 'น้ำหนักบรรทุก', rating: 'พิกัด', feeder: 'ต้นทาง', cable: 'สาย', length: 'ความยาว',
  zone: 'พื้นที่', dia: 'ขนาดท่อ', flow: 'ของไหล', pressure: 'แรงดัน', type: 'ชนิด', state: 'สถานะ', to: 'ปลายทาง',
};

const isXY = (p) => Array.isArray(p) && p.length >= 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= -0.05 && v <= 1.05);

/**
 * ตรวจและจัดรูปข้อมูลแบบวิศวกรรม — คืน { ok, errors, data }
 * data = { floorId, simulated, disclaimer, layers: [{ id, name, system, color, description, features: [{ id, kind, code, name, geom, props }] }] }
 */
export function parseEngineering(json) {
  const errors = [];
  if (!json || typeof json !== 'object') return { ok: false, errors: ['ไม่ใช่ข้อมูล JSON'], data: null };
  if (json.schema !== ENGINEERING_SCHEMA) errors.push(`schema ไม่รองรับ: ${json.schema}`);
  if (json.coordSpace && json.coordSpace !== 'plan-normalized') errors.push(`coordSpace ไม่รองรับ: ${json.coordSpace}`);
  const ids = new Set();
  const layers = (Array.isArray(json.layers) ? json.layers : []).map((l) => {
    if (!l.id || !l.name) errors.push('เลเยอร์ต้องมี id และ name');
    const features = [];
    for (const f of Array.isArray(l.features) ? l.features : []) {
      const g = f.geometry ?? {};
      const coords = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates?.[0] : null;
      if (!f.id || ids.has(f.id)) { errors.push(`รหัสซ้ำหรือว่าง: ${f.id}`); continue; }
      if (!coords || !coords.length || !coords.every(isXY) || (g.type !== 'Point' && coords.length < 2)) { errors.push(`พิกัดไม่ถูกต้อง: ${f.id}`); continue; }
      ids.add(f.id);
      const { kind = 'other', code = f.id, name = f.id, ...props } = f.properties ?? {};
      features.push({ id: f.id, kind, code, name, geom: { type: g.type, coords }, props, layerId: l.id });
    }
    return { id: l.id, name: l.name, system: l.system ?? l.id, color: l.color ?? '#9fb6bc', description: l.description ?? '', features };
  });
  if (!layers.length) errors.push('ไม่มีเลเยอร์');
  const data = { floorId: json.floorId, simulated: json.simulated !== false, disclaimer: json.disclaimer ?? ENG_DISCLAIMER, source: json.source ?? null, layers };
  return { ok: errors.length === 0, errors, data };
}

/** ข้อมูลสำหรับการ์ดรายละเอียดเมื่อคลิกเส้น/อุปกรณ์ */
export function featureInfo(data, featureId) {
  for (const l of data?.layers ?? []) {
    const f = l.features.find((x) => x.id === featureId);
    if (!f) continue;
    return {
      id: f.id, code: f.code, name: f.name, kind: KIND_LABEL[f.kind] ?? f.kind,
      system: l.name, systemCode: l.system, color: l.color, simulated: data.simulated,
      rows: Object.entries(f.props).map(([k, v]) => [PROP_LABEL[k] ?? k, String(v)]),
    };
  }
  return null;
}

/** เลเยอร์ที่มองเห็นเมื่อกด "แสดงเฉพาะระบบนี้" */
export function soloVisibility(data, layerId) {
  return Object.fromEntries((data?.layers ?? []).map((l) => [l.id, l.id === layerId]));
}

/** ความยาวรวมของเส้น (หน่วยผัง) และจำนวนชิ้นต่อชนิด — ใช้สรุปในแผง */
export function layerSummary(layer) {
  const count = {};
  for (const f of layer.features) count[f.kind] = (count[f.kind] ?? 0) + 1;
  return Object.entries(count).map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`).join(' · ');
}
