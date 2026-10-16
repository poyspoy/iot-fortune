// ค่าคงที่ของโดเมน — ไม่มีการพึ่ง DOM หรือ WebGL

export const SCHEMA_VERSION = 5; // v2: แยกสำนักงานรายชั้น · v3: สำนักงาน 11–32 · v4: โมเดลรายชั้นจาก Blender ของผู้ใช้ · v5: จุดระดับน้ำ WL-001/WL-002
export const TELEMETRY_SCHEMA_VERSION = 1;

export const SOURCES = /** @type {const} */ (['demo', 'api']);
export const SOURCE_LABEL = { demo: 'ข้อมูลจำลอง', api: 'ข้อมูลจาก API' };

export const SYSTEMS = {
  electrical: { label: 'ไฟฟ้า', icon: 'ฟ' },
  hvac: { label: 'ปรับอากาศ (HVAC)', icon: 'อ' },
  water: { label: 'ประปา/ระบายน้ำ', icon: 'น' },
  environment: { label: 'สภาพแวดล้อม', icon: 'ส' },
};

// คุณภาพข้อมูลของแต่ละค่าวัด (แยกจากสถานะการเชื่อมต่อ)
export const QUALITY = {
  fresh: { label: 'สดใหม่', rank: 0 },
  stale: { label: 'ข้อมูลเก่า', rank: 2 },
  nodata: { label: 'ยังไม่มีข้อมูล', rank: 1 },
  invalid: { label: 'ข้อมูลไม่ถูกต้อง', rank: 3 },
};

export const SEVERITY = {
  normal: { label: 'ปกติ', rank: 0 },
  warning: { label: 'เฝ้าระวัง', rank: 1 },
  critical: { label: 'วิกฤต', rank: 2 },
};

export const SAMPLE_QUALITY = ['good', 'uncertain', 'bad'];

export const RULE_TYPES = {
  high: 'สูงเกินกำหนด',
  low: 'ต่ำกว่ากำหนด',
  range: 'ช่วงค่าที่ยอมรับ',
  discrete: 'สถานะเฉพาะ',
};

export const AREA_KINDS = {
  sales: 'พื้นที่ขาย',
  service: 'พื้นที่บริการ',
  plant: 'ห้องเครื่อง',
  electrical: 'ห้องไฟฟ้า',
  parking: 'ลานจอดรถ',
  office: 'พื้นที่สำนักงาน',
  roof: 'ดาดฟ้า',
  underfloor: 'ระบบใต้พื้น',
};

export const DEFAULT_RETENTION = { maxDays: 7, maxSamples: 100_000 };
export const FUTURE_TOLERANCE_MS = 60_000;

export function severityRank(s) {
  return SEVERITY[s]?.rank ?? 0;
}
export function maxSeverity(a, b) {
  return severityRank(a) >= severityRank(b) ? a : b;
}
