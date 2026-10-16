import { s } from './dom.js';

// แปลน 2D ของแบบวิศวกรรม: ภาพผังชั้นจางเป็นพื้นหลัง + เส้น/อุปกรณ์ตามข้อมูล (พิกัดปกติ 0–1 เดียวกับหมุด IoT)
// ข้อมูลมาจาก parseEngineering() — ไม่ผูกรหัสชิ้นในโค้ดหน้าจอ
export function renderEngPlan({ floor, data, vis, selectedId, onPick }) {
  const W = floor.plan.width; const H = floor.plan.height;
  const u = H / 414; // หน่วยความหนาเส้นตามขนาดผัง
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'eng-svg', role: 'group', 'aria-label': `แบบวิศวกรรมจำลอง ${floor.name}`, preserveAspectRatio: 'xMidYMid meet' });
  svg.appendChild(s('rect', { x: 0, y: 0, width: W, height: H, class: 'eng-paper' }));
  svg.appendChild(s('image', { href: floor.plan.src, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', class: 'eng-under' }));
  svg.appendChild(s('polygon', { points: floor.footprint.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' '), class: 'eng-outline' }));
  const P = ([x, y]) => [x * W, y * H];
  for (const l of data.layers) {
    const g = s('g', { class: `eng-layer eng-${l.id}`, 'data-layer': l.id, style: `--c:${l.color}` });
    if (vis[l.id] === false) g.setAttribute('display', 'none');
    for (const f of l.features) {
      const sel = f.id === selectedId;
      const fg = s('g', { class: `eng-f k-${f.kind}${sel ? ' sel' : ''}`, 'data-id': f.id, tabindex: f.kind === 'grid' ? null : 0, role: 'button', 'aria-label': `${l.name}: ${f.name} (${f.code})` });
      const pts = f.geom.coords.map(P);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      if (f.geom.type === 'LineString') {
        fg.appendChild(s('path', { d, class: 'eng-hit', 'stroke-width': 14 * u }));
        const w = { grid: 0.8, beam: 3.2, cable: 3, pipe: 4 }[f.kind] ?? 2.5;
        fg.appendChild(s('path', { d, class: 'eng-line', 'stroke-width': w * u, 'stroke-dasharray': f.kind === 'grid' ? `${10 * u} ${6 * u}` : null }));
        if (f.kind === 'grid') {
          const [x0, y0] = pts[0];
          const vertical = Math.abs(pts[1][0] - x0) < 1;
          const tx = vertical ? x0 : 10 * u; const ty = vertical ? 13 * u : y0;
          fg.appendChild(s('circle', { cx: tx, cy: ty, r: 8 * u, class: 'eng-bubble', 'stroke-width': u }));
          fg.appendChild(s('text', { x: tx, y: ty + 3.5 * u, class: 'eng-bubble-t', 'font-size': 10 * u }, f.code.replace('GL-', '')));
        }
      } else {
        const [x, y] = pts[0];
        const r = { column: 7, panel: 8, valve: 7, device: 5 }[f.kind] ?? 6;
        fg.appendChild(s('circle', { cx: x, cy: y, r: 14 * u, class: 'eng-hit' }));
        if (f.kind === 'column') fg.appendChild(s('rect', { x: x - r * u, y: y - r * u, width: 2 * r * u, height: 2 * r * u, class: 'eng-sym fill' }));
        else if (f.kind === 'panel') fg.appendChild(s('rect', { x: x - r * 1.4 * u, y: y - r * 0.8 * u, width: 2.8 * r * u, height: 1.6 * r * u, class: 'eng-sym', 'stroke-width': 2 * u }));
        else if (f.kind === 'valve') fg.appendChild(s('path', { d: `M${x - r * u} ${y - r * u}L${x + r * u} ${y + r * u}L${x + r * u} ${y - r * u}L${x - r * u} ${y + r * u}Z`, class: 'eng-sym', 'stroke-width': 2 * u }));
        else fg.appendChild(s('circle', { cx: x, cy: y, r: r * u, class: 'eng-sym', 'stroke-width': 2 * u }));
      }
      if (f.kind !== 'grid' || true) {
        const pick = (e) => { e.stopPropagation(); onPick?.(f.id); };
        fg.addEventListener('click', pick);
        fg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
      }
      g.appendChild(fg);
    }
    svg.appendChild(g);
  }
  return svg;
}
