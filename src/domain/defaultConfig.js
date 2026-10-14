import { SCHEMA_VERSION } from './constants.js';

// -----------------------------------------------------------------------------
// การตั้งค่าเริ่มต้น
// - ผังชั้น G, 1, 2, 3, 4, 5 และผังสำนักงานชั้น 11–31 มาจากภาพที่ผู้ใช้แนบ
//   (ผังพื้นที่เช่า/ป้ายบอกทาง ไม่ใช่แบบก่อสร้าง) รูปทรงอาคารลากโดยประมาณ
// - จุด IoT ทั้ง 8 จุดเป็น "ตัวอย่าง" ไม่ใช่รายการอุปกรณ์จริงของฟอร์จูน
// - ค่าเตือน/วิกฤตทั้งหมดเป็นค่าตัวอย่าง ต้องได้รับอนุมัติก่อนใช้กับอุปกรณ์จริง
// -----------------------------------------------------------------------------

// รูปทรงอาคาร (พิกัดปกติ 0–1 ของภาพผังที่ครอปแล้ว) ลากจากภาพผังโดยประมาณ
const PODIUM_G3 = [
  [0.005, 0.344], [0.702, 0.344], [0.702, 0.127], [0.983, 0.031], [0.994, 0.517],
  [0.936, 0.542], [0.933, 0.973], [0.718, 0.808], [0.005, 0.815],
];
const PODIUM_4 = [
  [0.005, 0.343], [0.658, 0.343], [0.658, 0.114], [0.980, 0.029], [0.993, 0.48],
  [0.925, 0.526], [0.921, 0.972], [0.658, 0.752], [0.005, 0.794],
];
const PODIUM_W = 22;
const PODIUM_D = +(PODIUM_W * 950 / 5510).toFixed(3); // อัตราส่วนตามภาพผังที่ครอป
const FLOOR_H = 0.8;

function mallFloor(id, name, order, plan, footprint, note) {
  return {
    id, name, order, kind: 'mall',
    plan: { src: `plans/floor-${id}.webp`, width: plan[0], height: plan[1], note },
    footprint,
    model: { cx: 0, cz: 0, width: PODIUM_W, depth: PODIUM_D, elevation: order * FLOOR_H, height: FLOOR_H },
  };
}

export function createDefaultConfig() {
  const floors = [
    mallFloor('G', 'ชั้น G', 0, [2400, 414], PODIUM_G3, 'ผังพื้นที่เช่าชั้น G'),
    mallFloor('1', 'ชั้น 1', 1, [2400, 414], PODIUM_G3, 'ผังพื้นที่เช่าชั้น 1'),
    mallFloor('2', 'ชั้น 2', 2, [2400, 414], PODIUM_G3, 'ผังพื้นที่เช่าชั้น 2'),
    mallFloor('3', 'ชั้น 3', 3, [2400, 414], PODIUM_G3, 'ผังพื้นที่เช่าชั้น 3'),
    mallFloor('4', 'ชั้น 4', 4, [2400, 506], PODIUM_4,
      'ผังชั้น 4 วาดคนละสเกลกับชั้น G–3 ในแบบ 3D จึงยืดให้เข้ากรอบเดียวกันโดยประมาณ'),
    {
      id: '5', name: 'ชั้น 5 (ลานจอด)', order: 5, kind: 'parking',
      plan: { src: 'plans/floor-5.webp', width: 731, height: 701, note: 'ผังย่อลานจอดชั้น 5 ไม่ตามสเกล ตำแหน่งในแนวราบยังไม่ยืนยัน' },
      footprint: circle(0.5, 0.5, 0.42, 28),
      model: { cx: 6.4, cz: 0.15, width: 2.2, depth: 2.1, elevation: 5 * FLOOR_H, height: FLOOR_H },
    },
    ...towerFloors(),
  ];

  const areas = [
    { id: 'G-SVC', floorId: 'G', name: 'พื้นที่บริการฝั่งตะวันออก (ตัวอย่าง)', kind: 'service' },
    { id: '1-MALL', floorId: '1', name: 'พื้นที่ขายชั้น 1', kind: 'sales' },
    { id: '2-MALL', floorId: '2', name: 'พื้นที่ขายชั้น 2', kind: 'sales' },
    { id: '3-MALL', floorId: '3', name: 'พื้นที่ขายชั้น 3', kind: 'sales' },
    { id: '4-MALL', floorId: '4', name: 'พื้นที่ขายชั้น 4', kind: 'sales' },
    { id: '5-PARK', floorId: '5', name: 'ลานจอดรถชั้น 5', kind: 'parking' },
    ...towerAreas(),
  ];

  const num = (id, name, unit, min, max, extra = {}) => ({
    id, sourceKey: id, name, kind: 'numeric', unit, decimals: 1,
    plausible: { min, max }, staleAfterSec: 120, explain: '', ...extra,
  });
  const disc = (id, name, states, extra = {}) => ({
    id, sourceKey: id, name, kind: 'discrete', unit: '', states, staleAfterSec: 120, explain: '', ...extra,
  });

  const points = [
    {
      id: 'P-001', sourceKey: 'P-001', name: 'บ่อสูบน้ำ (ตัวอย่าง)', system: 'water', equipmentId: '',
      floorId: 'G', areaId: 'G-SVC', plan: { x: 0.88, y: 0.86 }, pos3d: null, status: 'active', example: true,
      metrics: [num('level', 'ระดับน้ำในบ่อ', 'cm', 0, 400, {
        unitConversions: { mm: { factor: 0.1, offset: 0 } },
        explain: 'ระดับน้ำเป็นเซนติเมตร (cm) วัดจากก้นบ่อ ยิ่งสูงยิ่งเสี่ยงล้น',
      })],
    },
    {
      id: 'P-002', sourceKey: 'P-002', name: 'ถังเก็บน้ำ (ตัวอย่าง)', system: 'water', equipmentId: '',
      floorId: '4', areaId: '4-MALL', plan: { x: 0.88, y: 0.40 }, pos3d: null, status: 'active', example: true,
      metrics: [num('level', 'ระดับน้ำในถัง', '%', 0, 100, { explain: 'ร้อยละของความจุถัง (%) ยิ่งต่ำยิ่งเสี่ยงน้ำไม่พอ' })],
    },
    {
      id: 'P-003', sourceKey: 'P-003', name: 'ปั๊มน้ำ (ตัวอย่าง)', system: 'water', equipmentId: 'PUMP-EX-01',
      floorId: 'G', areaId: 'G-SVC', plan: { x: 0.82, y: 0.78 }, pos3d: null, status: 'active', example: true,
      metrics: [
        disc('run', 'สถานะเดิน/หยุด', [{ value: 'run', label: 'เดิน' }, { value: 'stop', label: 'หยุด' }], {
          explain: 'สถานะจากสัญญาณ run feedback การหยุดไม่ได้แปลว่าเครื่องเสีย หากไม่มีบริบทการทำงานที่ตั้งไว้',
        }),
        num('current', 'กระแสมอเตอร์', 'A', 0, 100, { explain: 'กระแสไฟฟ้าเป็นแอมแปร์ (A) ค่า 0 เป็นค่าที่ถูกต้องเมื่อปั๊มหยุด' }),
      ],
    },
    {
      id: 'P-004', sourceKey: 'P-004', name: 'ห้อง AHU — น้ำเย็น (ตัวอย่าง)', system: 'hvac', equipmentId: 'AHU-EX',
      floorId: '11', areaId: '11-AHU', plan: { x: 0.349, y: 0.16 }, pos3d: null, status: 'active', example: true,
      metrics: [
        num('chws', 'น้ำเย็นจ่าย', '°C', -5, 40, { explain: 'อุณหภูมิน้ำเย็นจ่าย (supply) องศาเซลเซียส' }),
        num('chwr', 'น้ำเย็นกลับ', '°C', -5, 40, { explain: 'อุณหภูมิน้ำเย็นกลับ (return) องศาเซลเซียส' }),
      ],
    },
    {
      id: 'P-005', sourceKey: 'P-005', name: 'โซนพื้นที่ขายชั้น 3 (ตัวอย่าง)', system: 'environment', equipmentId: '',
      floorId: '3', areaId: '3-MALL', plan: { x: 0.58, y: 0.58 }, pos3d: null, status: 'active', example: true,
      metrics: [
        num('temp', 'อุณหภูมิห้อง', '°C', -10, 60, { explain: 'อุณหภูมิอากาศ องศาเซลเซียส' }),
        num('rh', 'ความชื้นสัมพัทธ์', '%RH', 0, 100, { explain: 'ความชื้นสัมพัทธ์ ร้อยละ (%RH)' }),
      ],
    },
    {
      id: 'P-006', sourceKey: 'P-006', name: 'ตู้ไฟหลัก (ตัวอย่าง)', system: 'electrical', equipmentId: 'MDB-EX',
      floorId: '1', areaId: '1-MALL', plan: { x: 0.42, y: 0.42 }, pos3d: null, status: 'active', example: true,
      metrics: [
        num('power', 'กำลังไฟฟ้า', 'kW', 0, 2000, { explain: 'กำลังไฟฟ้าขณะนั้น หน่วยกิโลวัตต์ (kW) — อัตราการใช้ไฟ' }),
        num('energy', 'พลังงานสะสม', 'kWh', 0, 1e9, { decimals: 0, explain: 'พลังงานไฟฟ้าสะสม หน่วยกิโลวัตต์-ชั่วโมง (kWh) — ปริมาณรวม ไม่ใช่อัตรา' }),
      ],
    },
    {
      id: 'P-007', sourceKey: 'P-007', name: 'ห้องไฟฟ้า ELEC. RM. (ตัวอย่าง)', system: 'electrical', equipmentId: '',
      floorId: '12', areaId: '12-ELEC', plan: { x: 0.585, y: 0.24 }, pos3d: null, status: 'active', example: true,
      metrics: [num('temp', 'อุณหภูมิห้อง', '°C', -10, 80, { explain: 'อุณหภูมิในห้องไฟฟ้า องศาเซลเซียส' })],
    },
    {
      id: 'P-008', sourceKey: 'P-008', name: 'จุดเสี่ยงน้ำรั่ว (ตัวอย่าง)', system: 'water', equipmentId: '',
      floorId: '2', areaId: '2-MALL', plan: { x: 0.20, y: 0.62 }, pos3d: null, status: 'active', example: true,
      metrics: [disc('leak', 'เซนเซอร์น้ำรั่ว', [{ value: 'dry', label: 'แห้ง' }, { value: 'wet', label: 'เปียก' }], {
        explain: 'อินพุตแบบสองสถานะ แห้ง/เปียก จากเซนเซอร์ตรวจน้ำรั่ว',
      })],
    },
  ];

  const r = (id, pointId, metricId, type, o) => ({
    id, pointId, metricId, type, enabled: true, sampleSetting: true,
    hysteresis: 0, dwellSec: 60, ...o,
  });
  const rules = [
    r('R-001', 'P-001', 'level', 'high', { warning: 120, critical: 150, hysteresis: 5 }),
    r('R-002', 'P-002', 'level', 'low', { warning: 40, critical: 25, hysteresis: 3 }),
    r('R-003', 'P-003', 'current', 'high', { warning: 18, critical: 22, hysteresis: 1 }),
    r('R-004', 'P-004', 'chws', 'high', { warning: 10, critical: 13, hysteresis: 0.5 }),
    r('R-005', 'P-005', 'temp', 'high', { warning: 27, critical: 29, hysteresis: 0.5 }),
    r('R-006', 'P-005', 'rh', 'range', { warningLow: 40, warningHigh: 70, criticalLow: 30, criticalHigh: 80, hysteresis: 2 }),
    r('R-007', 'P-006', 'power', 'high', { warning: 320, critical: 380, hysteresis: 10 }),
    r('R-008', 'P-007', 'temp', 'high', { warning: 32, critical: 35, hysteresis: 0.5 }),
    r('R-009', 'P-008', 'leak', 'discrete', { states: { wet: 'critical' }, dwellSec: 0 }),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    building: {
      id: 'fortune-town',
      name: 'ฟอร์จูนทาวน์',
      referenceStatus: 'plans-supplied',
      referenceNote: 'รูปทรงอาคารลากจากผังพื้นที่เช่าที่ได้รับโดยประมาณ ไม่ใช่แบบก่อสร้าง ตำแหน่งจุด IoT ทั้งหมดเป็นตัวอย่าง รอยืนยันตำแหน่งจริง',
      towerNote: 'ทาวเวอร์สำนักงานชั้น 11–31 ใช้ผังอ้างอิงร่วม ตำแหน่งทาวเวอร์บนโต๊ะยังไม่ยืนยัน ชั้น 6–10 ไม่มีผัง',
      floors, areas,
    },
    points, rules,
  };
}

// ทาวเวอร์สำนักงาน: แยกชั้น 11–31 รายชั้น ทุกชั้นใช้ "ผังอ้างอิงร่วม" (ผังมาตรฐานชั้น 11–31 ภาพเดียวกัน)
// แต่จุดตรวจวัด/ข้อมูลเซนเซอร์แยกตามชั้น ไม่คัดลอกจุดตัวอย่างไปทุกชั้น
export const TOWER_FIRST = 11;
export const TOWER_LAST = 31;
export const TOWER_FLOOR_H = 0.27;
const TOWER_BASE = 0.6; // ฐานจาง ๆ แทนชั้นด้านล่างที่ไม่มีผัง
const TOWER_W = 5.2;
const TOWER_D = +(TOWER_W * 555 / 1360).toFixed(3);
export const SHARED_OFFICE_PLAN = {
  src: 'plans/floor-OF.webp', width: 1360, height: 555, shared: true,
  sharedLabel: 'ผังอ้างอิงร่วม ชั้น 11–31',
  note: 'ผังอ้างอิงร่วม: ใช้ผังมาตรฐานสำนักงานชั้น 11–31 ภาพเดียวกันทุกชั้น — จุดตรวจวัดและข้อมูลเซนเซอร์แยกตามชั้น',
};

export function towerFloors() {
  const out = [];
  for (let n = TOWER_FIRST; n <= TOWER_LAST; n++) {
    out.push({
      id: String(n), name: `ชั้น ${n} (สำนักงาน)`, order: n, kind: 'tower',
      plan: { ...SHARED_OFFICE_PLAN },
      footprint: [[0.004, 0.03], [0.996, 0.03], [0.996, 0.97], [0.004, 0.97]],
      // ตำแหน่งทาวเวอร์บนโต๊ะจัดวางแยกจากโพเดียม (ตำแหน่งจริงยังไม่ยืนยัน)
      model: { cx: -5.5, cz: -4.4, width: TOWER_W, depth: TOWER_D, elevation: +(TOWER_BASE + (n - TOWER_FIRST) * TOWER_FLOOR_H).toFixed(3), height: TOWER_FLOOR_H },
    });
  }
  return out;
}

export function towerAreas() {
  const out = [];
  for (let n = TOWER_FIRST; n <= TOWER_LAST; n++) {
    out.push(
      { id: `${n}-OFFICE`, floorId: String(n), name: `พื้นที่สำนักงานชั้น ${n}`, kind: 'office' },
      { id: `${n}-AHU`, floorId: String(n), name: `ห้อง AHU ชั้น ${n} (ตามผังอ้างอิง)`, kind: 'plant' },
      { id: `${n}-ELEC`, floorId: String(n), name: `ELEC. RM. ชั้น ${n} (ตามผังอ้างอิง)`, kind: 'electrical' },
    );
  }
  return out;
}

function circle(cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([+(cx + Math.cos(a) * r).toFixed(4), +(cy + Math.sin(a) * r).toFixed(4)]);
  }
  return pts;
}
