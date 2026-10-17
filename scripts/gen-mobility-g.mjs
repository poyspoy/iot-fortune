// สร้างข้อมูลเส้นทางคนและรถจำลอง (ชั้น G + ลานด้านหน้าอาคาร) → public/mobility/floor-G.json
// คน: หาเส้นทางด้วย A* บนตารางพื้นที่ทางเดิน (walkway จากโมเดล Blender ของผู้ใช้) ลบร้านค้า ห้องน้ำ บันไดเลื่อน ลิฟต์ออก
//      ให้ค่าใช้จ่ายสูงเมื่อชิดผนัง → เส้นทางอยู่กลางทางเดิน ไม่ทะลุผนัง/ร้าน แล้วทำให้เรียบ (string-pulling + Chaikin)
// รถ: เส้นทางบนลานด้านหน้าอาคาร (ทางเข้า → ช่องจอด → ถอยออก → ทางออก) แยกจากทางเดินคนทั้งหมด
// พิกัดคน = พิกัดปกติบนผังชั้น (0–1) · พิกัดรถ = พิกัดฉาก (หน่วยโมเดล) บนผิวฐานอาคาร
//   node scripts/gen-mobility-g.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { planToBlender } from '../src/domain/geometry.js';

const floor = createDefaultConfig().building.floors.find((f) => f.id === 'G');
const rooms = JSON.parse(readFileSync('public/models/floors/rooms-G.json')).rooms;
const a = planToBlender(floor.detail, { x: 0, y: 0 }); const b = planToBlender(floor.detail, { x: 1, y: 1 });
const toPlan = (X, Y) => [(X - a.X) / (b.X - a.X), (Y - a.Y) / (b.Y - a.Y)];

// ---------------- ตารางพื้นที่เดินได้
const GW = 1200; const GH = 208; // ช่องละ ~0.018 หน่วยฉาก
const grid = new Uint8Array(GW * GH); // 1 = เดินได้
const fillTris = (r, v) => {
  for (let i = 0; i < r.tris.length; i += 6) {
    const P = [0, 2, 4].map((k) => toPlan(r.tris[i + k], r.tris[i + k + 1]).map((c, j) => c * (j ? GH : GW)));
    const minX = Math.max(0, Math.floor(Math.min(...P.map((p) => p[0])))); const maxX = Math.min(GW - 1, Math.ceil(Math.max(...P.map((p) => p[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...P.map((p) => p[1])))); const maxY = Math.min(GH - 1, Math.ceil(Math.max(...P.map((p) => p[1]))));
    const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const p = [x + 0.5, y + 0.5];
      const d1 = s(p, P[0], P[1]); const d2 = s(p, P[1], P[2]); const d3 = s(p, P[2], P[0]);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) grid[y * GW + x] = v;
    }
  }
};
for (const r of rooms.filter((r) => r.category === 'walkway')) fillTris(r, 1);
for (const r of rooms.filter((r) => ['shop', 'toilet', 'escalator', 'elevator'].includes(r.category))) fillTris(r, 0);

// ระยะห่างจากผนัง (ช่อง) — ใช้กันชิดผนัง
const dist = new Float32Array(GW * GH).fill(1e9);
const q = [];
for (let i = 0; i < GW * GH; i++) if (!grid[i]) { dist[i] = 0; q.push(i); }
for (let h = 0; h < q.length; h++) { const i = q[h]; const x = i % GW; const y = (i / GW) | 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx; const ny = y + dy; if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue; const j = ny * GW + nx; if (dist[j] > dist[i] + 1) { dist[j] = dist[i] + 1; q.push(j); } } }
const CLEAR = 1; // ต้องห่างผนังอย่างน้อย 1 ช่อง (ทางเดินในผังแคบ) — ค่าใช้จ่ายชิดผนังทำให้เส้นทางอยู่กลางทางเดิน
const ok = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH && grid[y * GW + x] && dist[y * GW + x] >= CLEAR;

const snap = ([px, py]) => { // จุดเดินได้ที่ใกล้ที่สุด และห่างผนังพอ
  let best = null; let bd = 1e9;
  const cx = px * GW; const cy = py * GH;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (ok(x, y) && dist[y * GW + x] >= CLEAR + 1) { const d = (x - cx) ** 2 + ((y - cy) * 1) ** 2; if (d < bd) { bd = d; best = [x, y]; } }
  return best;
};

function astar(s, t) {
  const N = GW * GH; const g = new Float32Array(N).fill(Infinity); const from = new Int32Array(N).fill(-1); const open = [];
  const key = (x, y) => y * GW + x; const hfn = (x, y) => Math.hypot(x - t[0], y - t[1]);
  const push = (i, f) => { open.push([f, i]); let k = open.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (open[p][0] <= open[k][0]) break; [open[p], open[k]] = [open[k], open[p]]; k = p; } };
  const pop = () => { const top = open[0]; const last = open.pop(); if (open.length) { open[0] = last; let k = 0; for (;;) { const l = 2 * k + 1; const r = l + 1; let m = k; if (l < open.length && open[l][0] < open[m][0]) m = l; if (r < open.length && open[r][0] < open[m][0]) m = r; if (m === k) break; [open[m], open[k]] = [open[k], open[m]]; k = m; } } return top; };
  const si = key(...s); g[si] = 0; push(si, hfn(...s));
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  while (open.length) {
    const [, i] = pop(); const x = i % GW; const y = (i / GW) | 0;
    if (x === t[0] && y === t[1]) break;
    for (const [dx, dy, c] of D) {
      const nx = x + dx; const ny = y + dy; if (!ok(nx, ny)) continue;
      const j = key(nx, ny); const wall = Math.max(0, 9 - dist[j]) * 0.6; // ชิดผนังแพงขึ้น → เดินกลางทาง
      const ng = g[i] + c + wall; if (ng < g[j]) { g[j] = ng; from[j] = i; push(j, ng + hfn(nx, ny)); }
    }
  }
  const out = []; for (let i = key(...t); i !== -1; i = from[i]) out.push([i % GW, (i / GW) | 0]);
  if (out.at(-1)[0] !== s[0] || out.at(-1)[1] !== s[1]) throw new Error('no path');
  return out.reverse();
}
const los = (p, q2) => { const n = Math.ceil(Math.hypot(q2[0] - p[0], q2[1] - p[1]) * 2); for (let k = 0; k <= n; k++) { const x = Math.round(p[0] + ((q2[0] - p[0]) * k) / n); const y = Math.round(p[1] + ((q2[1] - p[1]) * k) / n); if (!ok(x, y) || dist[y * GW + x] < CLEAR + 1) return false; } return true; };
const pull = (pts) => { const out = [pts[0]]; let i = 0; while (i < pts.length - 1) { let j = pts.length - 1; while (j > i + 1 && !los(pts[i], pts[j])) j--; out.push(pts[j]); i = j; } return out; };
const chaikin = (pts, n = 2) => { let p = pts; for (let k = 0; k < n; k++) { const o = [p[0]]; for (let i = 0; i < p.length - 1; i++) { const [x0, y0] = p[i]; const [x1, y1] = p[i + 1]; o.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]); } o.push(p.at(-1)); p = o; } return p; };
const toN = ([x, y]) => [+((x + 0.5) / GW).toFixed(5), +((y + 0.5) / GH).toFixed(5)]; // กึ่งกลางช่อง

// ---------------- จุดหมาย (POI) จากตำแหน่งในโมเดล
const centroid = (id) => { const r = rooms.find((x) => x.id === id); const P = []; for (let i = 0; i < r.tris.length; i += 2) P.push(toPlan(r.tris[i], r.tris[i + 1])); return [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length]; };
const shopNear = (x, y) => { let best = null; let bd = 9; for (const r of rooms.filter((r) => r.category === 'shop')) { const c = centroid(r.id); const d = Math.hypot(c[0] - x, (c[1] - y) * 0.2); if (d < bd) { bd = d; best = { id: r.id, c }; } } return best; };
const POI = [
  { id: 'ent-west', kind: 'entrance', name: 'ทางเข้า–ออก ฝั่งตะวันตก', at: centroid('Exits_Location') },
  { id: 'ent-center', kind: 'entrance', name: 'ทางเข้า–ออก กลางอาคาร', at: centroid('Exits_Location.001') },
  { id: 'ent-east', kind: 'entrance', name: 'ทางเข้า–ออก ฝั่งตะวันออก', at: [0.885, 0.86] },
  { id: 'lift-L1', kind: 'lift', name: 'หน้าลิฟต์ L1', at: [0.428, 0.6], faceTo: centroid('Elevators_Location.001') },
  { id: 'esc-1', kind: 'escalator', name: 'บันไดเลื่อน (ตะวันตก)', at: [0.136, 0.6], faceTo: centroid('Escalator_SourceFootprint') },
  { id: 'esc-2', kind: 'escalator', name: 'บันไดเลื่อน (กลาง)', at: [0.33, 0.585], faceTo: centroid('Escalator_SourceFootprint.001') },
  { id: 'hall-w', kind: 'corridor', name: 'ทางเดินหลัก (ตะวันตก)', at: [0.2, 0.5] },
  { id: 'hall-c', kind: 'corridor', name: 'ทางเดินหลัก (กลาง)', at: [0.55, 0.5] },
  { id: 'hall-e', kind: 'corridor', name: 'ทางเดินหลัก (ตะวันออก)', at: [0.78, 0.48] },
  ...[[0.18, 0.62], [0.36, 0.62], [0.5, 0.45], [0.62, 0.62], [0.74, 0.62], [0.86, 0.45]].map(([x, y], i) => {
    const s = shopNear(x, y); return { id: `shop-${i + 1}`, kind: 'shop', name: `หน้าร้าน ${s.id.replace(/^G_?/, '')}`, at: [s.c[0], s.c[1]], shop: s.id, faceTo: s.c };
  }),
];
for (const p of POI) { const sn = snap(p.at); if (!sn) throw new Error(`snap ${p.id}`); p.cell = sn; p.pos = toN(sn); }

// ---------------- ตรวจการเชื่อมต่อ (debug)
if (process.env.DBG) {
  const comp = new Int32Array(GW * GH).fill(-1); let nc = 0;
  for (let i = 0; i < GW * GH; i++) { if (comp[i] >= 0 || !ok(i % GW, (i / GW) | 0)) continue; const st = [i]; comp[i] = nc; let sz = 0;
    while (st.length) { const k = st.pop(); sz++; const x = k % GW; const y = (k / GW) | 0; for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nx = x + dx, ny = y + dy; if (!ok(nx, ny)) continue; const j = ny * GW + nx; if (comp[j] < 0) { comp[j] = nc; st.push(j); } } }
    if (sz > 200) console.log('comp', nc, sz); nc++; }
  for (const p of POI) console.log(p.id, p.cell, comp[p.cell[1] * GW + p.cell[0]]);
  const img = Buffer.alloc(GW * GH); for (let i = 0; i < GW * GH; i++) img[i] = ok(i % GW, (i / GW) | 0) ? 255 : grid[i] ? 120 : 0;
  writeFileSync('/tmp/claude-0/sp/mob/grid.raw', img); process.exit(0);
}
const segOk = (p, q2) => { const n = Math.ceil(Math.hypot(q2[0] - p[0], q2[1] - p[1]) * 3) + 1; for (let k = 0; k <= n; k++) { const x = Math.floor(p[0] + 0.5 + ((q2[0] - p[0]) * k) / n); const y = Math.floor(p[1] + 0.5 + ((q2[1] - p[1]) * k) / n); if (!grid[y * GW + x]) return false; } return true; };
// ---------------- เส้นทางทุกคู่
const paths = {};
for (let i = 0; i < POI.length; i++) for (let j = i + 1; j < POI.length; j++) {
  const raw = astar(POI[i].cell, POI[j].cell);
  // ทำให้เรียบ แต่ถ้าการตัดมุมทำให้เส้นออกนอกทางเดิน ให้ใช้เส้นที่ยังไม่ตัดมุม
  const pulled = pull(raw);
  const walkable = (pts) => pts.every((p, k) => k === 0 || segOk(pts[k - 1], p));
  let smooth = chaikin(pulled);
  if (!walkable(smooth)) smooth = chaikin(pulled, 1);
  if (!walkable(smooth)) smooth = pulled;
  paths[`${POI[i].id}>${POI[j].id}`] = smooth.map(toN);
}
// ตรวจ: ทุกจุดตัวอย่างบนเส้นทางต้องอยู่บนพื้นที่เดินได้ (ไม่ทะลุผนัง/ร้าน)
let bad = 0;
for (const pts of Object.values(paths)) for (let k = 0; k < pts.length - 1; k++) {
  const [x0, y0] = pts[k]; const [x1, y1] = pts[k + 1];
  const n = Math.ceil(Math.hypot((x1 - x0) * GW, (y1 - y0) * GH) * 3) + 1;
  for (let s = 0; s <= n; s++) { const x = Math.floor((x0 + ((x1 - x0) * s) / n) * GW); const y = Math.floor((y0 + ((y1 - y0) * s) / n) * GH); if (!grid[y * GW + x]) bad++; }
}

// ---------------- รถ: ลานด้านหน้าอาคาร (พิกัดฉาก หน่วยโมเดล บนผิวฐาน y = 0)
const ROAD_Z = 2.75; const STALL_Z = 4.05; const XIN = 12.1; const XOUT = -12.7;
const stalls = []; for (let k = 0; k < 12; k++) stalls.push({ id: `P${String(k + 1).padStart(2, '0')}`, x: +(-7.2 + k * 0.42).toFixed(3), z: STALL_Z });
const arc = (x0, z0, x1, z1, n = 8) => { const o = []; for (let i = 0; i <= n; i++) { const t = i / n; const e = t * t * (3 - 2 * t); o.push([+(x0 + (x1 - x0) * t).toFixed(3), +(z0 + (z1 - z0) * e).toFixed(3)]); } return o; };
const vehicle = {
  road: { z: ROAD_Z, xIn: XIN, xOut: XOUT, width: 0.62 },
  stallSize: { w: 0.36, d: 0.62 },
  stalls: stalls.map((s) => ({
    ...s,
    in: [[XIN, ROAD_Z], [s.x + 0.9, ROAD_Z], ...arc(s.x + 0.55, ROAD_Z, s.x, s.z - 0.08, 10).slice(0)], // เลี้ยวเข้าช่องจอด (เดินหน้า)
    out: [[s.x, s.z - 0.08], ...arc(s.x, s.z - 0.08, s.x - 0.55, ROAD_Z + 0.02, 10).slice(1)], // ถอยออกไปทางตะวันตก
    exit: [[s.x - 0.55, ROAD_Z + 0.02], [XOUT, ROAD_Z]],
  })),
};

const out = {
  schema: 'iot-fortune.mobility/v1', floorId: 'G', simulated: true,
  disclaimer: 'การเคลื่อนไหวจำลอง · ไม่ใช่ข้อมูลติดตามบุคคลจริง',
  source: { kind: 'generated', script: 'scripts/gen-mobility-g.mjs', walkable: 'rooms-G.json (walkway − shop − toilet − escalator − elevator)', grid: [GW, GH], clearanceCells: CLEAR },
  people: { coordSpace: 'plan-normalized', poi: POI.map(({ id, kind, name, pos, shop, faceTo }) => ({ id, kind, name, pos, ...(shop ? { shop } : {}), ...(faceTo ? { faceTo: faceTo.map((v) => +v.toFixed(5)) } : {}) })), paths },
  vehicles: { coordSpace: 'scene-root', ...vehicle },
};
mkdirSync('public/mobility', { recursive: true });
writeFileSync('public/mobility/floor-G.json', JSON.stringify(out));
console.log('POI', POI.length, 'paths', Object.keys(paths).length, 'points', Object.values(paths).reduce((s, p) => s + p.length, 0), 'off-walkway samples', bad, 'stalls', stalls.length);
// ภาพตรวจ (เฉพาะตอนพัฒนา)
writeFileSync('/tmp/claude-0/sp/mob/paths.json', JSON.stringify({ POI: POI.map((p) => ({ id: p.id, pos: p.pos })), paths }));
