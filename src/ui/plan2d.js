import { s, h } from './dom.js';

/**
 * ผัง 2D ของชั้นที่เลือก: ภาพผังที่ได้รับ + เส้นรูปทรงอาคาร + หมุดจุดแบบมีหมายเลข
 * หมุดเข้าถึงด้วยแป้นพิมพ์ได้ (Tab แล้ว Enter/Space)
 * โหมดวางตำแหน่ง: คลิกบนผังเพื่อได้พิกัดปกติ 0–1 (ไม่ใช่พิกัดสำรวจจริง)
 */
export function renderPlan({ floor, items = [], selectedId, onSelect, placing = false, onPlace, placeMark = null, compact = false, zoom = 1, assets = null }) {
  const W = floor.plan.width; const H = floor.plan.height;
  const r = (Math.max(W, H) * (compact ? 0.016 : 0.0125)) / Math.max(1, zoom * 0.8);
  const svg = s('svg', {
    viewBox: `0 0 ${W} ${H}`, class: `plan-svg${placing ? ' placing' : ''}`, role: 'group',
    'aria-label': `ผัง ${floor.name}${placing ? ' — คลิกเพื่อวางตำแหน่งจุด' : ''}`,
    preserveAspectRatio: 'xMidYMid meet',
    style: zoom > 1 ? `width:${zoom * 100}%;max-height:none` : null,
  });
  svg.appendChild(s('image', { href: floor.plan.src, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none' }));
  svg.appendChild(s('polygon', {
    points: floor.footprint.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' '),
    class: 'plan-outline',
  }));
  if (placing) {
    svg.addEventListener('click', (e) => {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const m = svg.getScreenCTM();
      if (!m) return;
      const p = pt.matrixTransform(m.inverse());
      const x = Math.min(1, Math.max(0, p.x / W)); const y = Math.min(1, Math.max(0, p.y / H));
      onPlace?.({ x: +x.toFixed(4), y: +y.toFixed(4) });
    });
  }
  for (const it of items) {
    const cx = it.point.plan.x * W; const cy = it.point.plan.y * H;
    const sel = it.point.id === selectedId;
    const g = s('g', {
      class: `plan-marker sev-${it.severity} q-${it.quality}${it.cls ? ` ${it.cls}` : ''}${sel ? ' selected' : ''}${placing ? ' muted' : ''}`,
      transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`,
      role: placing ? null : 'button', tabindex: placing ? null : 0,
      'aria-label': it.label, 'aria-pressed': placing ? null : String(sel), 'data-focus-key': `plan-${it.point.id}`,
    });
    g.appendChild(s('title', { text: it.label }));
    if (sel) g.appendChild(s('circle', { r: r * 1.7, class: 'halo' }));
    g.appendChild(s('circle', { r, class: 'dot' }));
    if (it.quality !== 'fresh') g.appendChild(s('circle', { r: r * 1.25, class: 'qring' }));
    g.appendChild(s('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': r * 1.15, text: String(it.number) }));
    // Data Layer: ยังไม่ติดตั้ง = ป้ายข้อความใต้หมุด · ต้องตรวจตำแหน่ง = สัญลักษณ์ ! มุมบนขวา (ไม่ใช้สีอย่างเดียว)
    if (it.dl?.tag) g.appendChild(s('text', { class: 'dl-tag', 'text-anchor': 'middle', y: r * 2.1, 'font-size': r * 0.85, text: it.dl.tag }));
    if (it.dl?.remap) {
      const b = s('g', { class: 'dl-remap-badge', transform: `translate(${(r * 0.95).toFixed(1)} ${(-r * 0.95).toFixed(1)})` });
      b.appendChild(s('circle', { r: r * 0.55 }));
      b.appendChild(s('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': r * 0.8, text: '!' }));
      g.appendChild(b);
    }
    if (!placing) {
      const act = (e) => { e.stopPropagation(); onSelect?.(it.point.id); };
      g.addEventListener('click', act);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e); } });
    }
    svg.appendChild(g);
  }
  // อุปกรณ์จาก Data Layer (ถัง/บ่อ/ปั๊ม) ที่ตำแหน่งเดียวกับภาพ 3D — แสดงเฉพาะเมื่อส่งมา (Playground)
  for (const a of assets ?? []) {
    const g = s('g', { class: `plan-asset kind-${a.kind}${a.preinstall ? ' dl-pre' : ''}`, transform: `translate(${(a.u * W).toFixed(1)} ${(a.v * H).toFixed(1)})`, 'data-asset': a.code });
    g.appendChild(s('title', { text: a.label }));
    g.appendChild(s('rect', { x: -r * 0.75, y: -r * 0.75, width: r * 1.5, height: r * 1.5, rx: a.kind === 'tank' ? r * 0.75 : r * 0.2 }));
    g.appendChild(s('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': r * 0.8, text: a.kind === 'pump' ? 'P' : a.kind === 'pit' ? 'บ' : 'ถ' }));
    svg.insertBefore(g, svg.querySelector('.plan-marker'));
  }
  if (placeMark) {
    const g = s('g', { class: 'place-mark', transform: `translate(${(placeMark.x * W).toFixed(1)} ${(placeMark.y * H).toFixed(1)})` });
    g.appendChild(s('circle', { r: r * 1.1 }));
    g.appendChild(s('path', { d: `M${-r * 1.8} 0 H${r * 1.8} M0 ${-r * 1.8} V${r * 1.8}` }));
    svg.appendChild(g);
  }
  return h('div', { class: `plan-wrap${floor.plan.width / floor.plan.height > 3 ? ' wide' : ''}` }, svg);
}
