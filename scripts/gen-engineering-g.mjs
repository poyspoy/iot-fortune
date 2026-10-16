// สร้างข้อมูลแบบวิศวกรรมจำลองของชั้น G (โครงสร้าง / ไฟฟ้า / ประปา) → public/engineering/floor-G.json
// รูปแบบคล้าย GeoJSON: พิกัด [x, y] เป็นพิกัดปกติบนผังชั้น (0–1) แบบเดียวกับตำแหน่งจุด IoT
// ข้อมูลทั้งหมดเป็นตัวอย่างจำลอง ไม่ใช่แบบก่อสร้างจริง — ในอนาคตแทนไฟล์นี้ด้วยข้อมูลที่แปลงจาก DXF/SVG/GeoJSON หรือจาก Backend
//   node scripts/gen-engineering-g.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';

const floor = createDefaultConfig().building.floors.find((f) => f.id === 'G');
const fp = floor.footprint;
const inside = ([x, y]) => { // จุดอยู่ในรูปทรงชั้น (ray casting)
  let c = false;
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const [xi, yi] = fp[i]; const [xj, yj] = fp[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const r4 = (v) => Math.round(v * 10000) / 10000;
const P = (x, y) => [r4(x), r4(y)];
const line = (id, coords, props) => ({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords }, properties: props });
const point = (id, xy, props) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: xy }, properties: props });

// ---------------- โครงสร้าง: Grid + เสา + คาน
const XS = Array.from({ length: 12 }, (_, i) => 0.04 + (i * 0.92) / 11); // แนว 1–12
const YS = { A: 0.2, B: 0.38, C: 0.52, D: 0.66, E: 0.79 };
const structure = [];
XS.forEach((x, i) => structure.push(line(`STR-GL-${i + 1}`, [P(x, 0.02), P(x, 0.98)], { kind: 'grid', code: `GL-${i + 1}`, name: `เส้นกริดแนว ${i + 1}` })));
for (const [k, y] of Object.entries(YS)) structure.push(line(`STR-GL-${k}`, [P(0, y), P(1, y)], { kind: 'grid', code: `GL-${k}`, name: `เส้นกริดแนว ${k}` }));
const cols = new Map();
XS.forEach((x, i) => { for (const [k, y] of Object.entries(YS)) if (inside([x, y])) cols.set(`${k}${i + 1}`, P(x, y)); });
for (const [code, xy] of cols) structure.push(point(`STR-C-${code}`, xy, { kind: 'column', code: `C-${code}`, name: `เสา ${code}`, size: '0.60 × 0.60 ม.', material: 'คอนกรีตเสริมเหล็ก', load: `${(380 + (code.charCodeAt(0) * 7 + code.length * 13) % 120)} ตัน (จำลอง)` }));
const beam = (a, b) => { if (cols.has(a) && cols.has(b)) structure.push(line(`STR-B-${a}-${b}`, [cols.get(a), cols.get(b)], { kind: 'beam', code: `B-${a}/${b}`, name: `คาน ${a}–${b}`, size: '0.40 × 0.80 ม.', material: 'คอนกรีตเสริมเหล็ก' })); };
const keys = Object.keys(YS);
XS.forEach((_, i) => { for (let k = 0; k < keys.length; k++) { beam(`${keys[k]}${i + 1}`, `${keys[k]}${i + 2}`); if (k + 1 < keys.length) beam(`${keys[k]}${i + 1}`, `${keys[k + 1]}${i + 1}`); } });

// ---------------- ไฟฟ้า: ตู้ MDB → สายป้อนหลัก → ตู้ย่อย DB → อุปกรณ์
const electrical = [];
const yMain = 0.585;
const mdb = P(0.03, 0.6);
electrical.push(point('ELE-MDB-G', mdb, { kind: 'panel', code: 'MDB-G', name: 'ตู้ไฟฟ้าหลัก MDB-G', rating: '1600 A · 400/230 V', feeder: 'จากหม้อแปลง TR-1 (จำลอง)' }));
electrical.push(line('ELE-FD-MAIN', [mdb, P(0.06, yMain), P(0.69, yMain), P(0.69, 0.45), P(0.95, 0.45)], { kind: 'cable', code: 'FD-G-01', name: 'สายป้อนหลัก (Cable tray)', cable: 'NYY 4×240 mm² (จำลอง)', length: '≈ 210 ม.' }));
const dbs = [[0.17, 'DB-G1', 'ร้านค้าโซนตะวันตก'], [0.33, 'DB-G2', 'ทางเดินกลาง'], [0.5, 'DB-G3', 'ร้านค้าโซนกลาง'], [0.66, 'DB-G4', 'โถงลิฟต์'], [0.86, 'DB-G5', 'ห้องเครื่องสูบน้ำ']];
for (const [x, code, zone] of dbs) {
  const yb = x < 0.69 ? yMain : 0.45; const yd = x < 0.69 ? 0.43 : 0.3;
  electrical.push(line(`ELE-BR-${code}`, [P(x, yb), P(x, yd)], { kind: 'cable', code: `BR-${code}`, name: `สายป้อนย่อยไป ${code}`, cable: 'THW 4×35 mm² (จำลอง)' }));
  electrical.push(point(`ELE-${code}`, P(x, yd), { kind: 'panel', code, name: `ตู้ไฟฟ้าย่อย ${code}`, zone, rating: '250 A (จำลอง)' }));
  // ดวงโคม/เต้ารับตามแนวทางเดินจากตู้ย่อย
  for (let j = 1; j <= 2; j++) {
    const xx = x + j * 0.035; const yy = yd;
    if (!inside([xx, yy])) continue;
    electrical.push(point(`ELE-${code}-L${j}`, P(xx, yy), { kind: 'device', code: `${code}-L${j}`, name: `ชุดโคมไฟ ${code}-L${j}`, load: '0.4 kW (จำลอง)' }));
  }
  electrical.push(line(`ELE-${code}-CIR`, [P(x, yd), P(x + 0.07, yd)].filter((p) => inside(p)).length === 2 ? [P(x, yd), P(x + 0.07, yd)] : [P(x, yd), P(x + 0.035, yd)], { kind: 'cable', code: `${code}-C1`, name: `วงจรแสงสว่าง ${code}-C1`, cable: 'THW 2×2.5 mm² (จำลอง)' }));
}
electrical.push(point('ELE-PUMP-CP', P(0.83, 0.71), { kind: 'device', code: 'CP-P003', name: 'ตู้ควบคุมปั๊มน้ำ P-003', rating: '30 A (จำลอง)' }));
electrical.push(line('ELE-PUMP-FD', [P(0.86, 0.3), P(0.86, 0.55), P(0.83, 0.71)], { kind: 'cable', code: 'BR-CP-P003', name: 'สายไฟฟ้าไปตู้ควบคุมปั๊ม', cable: 'THW 4×16 mm² (จำลอง)' }));

// ---------------- ประปา: ท่อเมนจากบ่อ/ปั๊ม → ท่อแยก → วาล์ว
const plumbing = [];
const pump = P(0.82, 0.78); const pit = P(0.88, 0.86);
plumbing.push(line('PLB-SUC', [pit, pump], { kind: 'pipe', code: 'WS-SUC-01', name: 'ท่อดูดจากบ่อสูบน้ำ', dia: 'Ø100 มม.', material: 'HDPE (จำลอง)', flow: 'น้ำดิบ' }));
const yP = 0.73;
plumbing.push(line('PLB-MAIN', [pump, P(0.8, yP), P(0.04, yP)], { kind: 'pipe', code: 'WS-MAIN-G', name: 'ท่อประปาเมนชั้น G', dia: 'Ø80 มม.', material: 'PPR PN20 (จำลอง)', pressure: '3.5 บาร์ (จำลอง)' }));
plumbing.push(point('PLB-CV-01', P(0.81, 0.765), { kind: 'valve', code: 'CV-01', name: 'วาล์วกันกลับ CV-01', type: 'Check valve', dia: 'Ø80 มม.', state: 'ปกติ (จำลอง)' }));
plumbing.push(point('PLB-GV-01', P(0.74, yP), { kind: 'valve', code: 'GV-01', name: 'ประตูน้ำ GV-01', type: 'Gate valve', dia: 'Ø80 มม.', state: 'เปิด (จำลอง)' }));
const branches = [[0.12, 'ห้องน้ำโซนตะวันตก'], [0.4, 'ห้องน้ำโซนกลาง'], [0.62, 'ร้านอาหาร (จุดจ่ายน้ำ)']];
branches.forEach(([x, zone], i) => {
  const code = `WS-BR-0${i + 1}`;
  plumbing.push(line(`PLB-${code}`, [P(x, yP), P(x, 0.66), P(x + 0.04, 0.66)], { kind: 'pipe', code, name: `ท่อแยกไป${zone}`, dia: 'Ø40 มม.', material: 'PPR PN20 (จำลอง)' }));
  plumbing.push(point(`PLB-BV-0${i + 2}`, P(x, 0.7), { kind: 'valve', code: `BV-0${i + 2}`, name: `บอลวาล์ว BV-0${i + 2}`, type: 'Ball valve', dia: 'Ø40 มม.', state: 'เปิด (จำลอง)' }));
});
plumbing.push(line('PLB-RISER', [P(0.04, yP), P(0.03, 0.66)], { kind: 'pipe', code: 'WS-RS-01', name: 'ท่อขึ้นถังเก็บน้ำชั้น 4 (Riser)', dia: 'Ø65 มม.', material: 'PPR PN20 (จำลอง)', to: 'ถังเก็บน้ำ WL-002 ชั้น 4' }));

const out = {
  schema: 'iot-fortune.engineering/v1',
  floorId: 'G',
  coordSpace: 'plan-normalized', // [x, y] 0–1 บนภาพผังชั้น (เหมือนตำแหน่งจุด IoT)
  simulated: true,
  disclaimer: 'แบบวิศวกรรมจำลอง · ไม่ใช่แบบก่อสร้างจริง',
  source: { kind: 'generated', script: 'scripts/gen-engineering-g.mjs', future: 'DXF / SVG / GeoJSON / Backend API' },
  layers: [
    { id: 'structure', name: 'โครงสร้าง', system: 'STR', color: '#d9a62e', description: 'เสา คาน และเส้นกริด', features: structure },
    { id: 'electrical', name: 'ไฟฟ้า', system: 'ELE', color: '#ff7a45', description: 'แนวสายไฟและตำแหน่งตู้/อุปกรณ์', features: electrical },
    { id: 'plumbing', name: 'ประปา', system: 'PLB', color: '#3fa7ff', description: 'แนวท่อและวาล์ว', features: plumbing },
  ],
};
mkdirSync('public/engineering', { recursive: true });
writeFileSync('public/engineering/floor-G.json', JSON.stringify(out, null, 1));
console.log(out.layers.map((l) => `${l.id}: ${l.features.length}`).join(' · '));
