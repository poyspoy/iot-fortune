import { h, s, fmtNum } from './dom.js';
import { fmtClock, fmtDateTime, fmtShortDT } from '../domain/time.js';

const DEF_W = 640; const DEF_H = 190;
// ขนาดพื้นที่วาดของกราฟที่กำลังสร้าง — ค่าเริ่มต้น 640×190 (หน้าอื่นใช้เหมือนเดิม)
// การ์ดแนวโน้มส่งขนาดจริงเป็นพิกเซล (size) ให้ตัวอักษร แกน และ Tooltip มีขนาดจริง ไม่ถูกย่อ/ขยายตามความกว้างจอ
let VW = DEF_W; let VH = DEF_H;
const M = { l: 50, r: 14, t: 14, b: 26 };

function ticksTime(from, to) {
  const span = to - from;
  const steps = [60e3, 300e3, 600e3, 1800e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3];
  const step = steps.find((st) => span / st <= 6) ?? 86400e3;
  const out = [];
  const tzOff = 7 * 3600e3; // จัดเส้นแบ่งตามเวลาไทย
  for (let t = Math.ceil((from + tzOff) / step) * step - tzOff; t <= to; t += step) out.push(t);
  return { ticks: out, long: span > 36 * 3600e3 };
}

function niceTicks(min, max, n = 4) {
  const span = max - min || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((st) => span / st <= n + 1);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function thresholdsOf(rules) {
  const out = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.type === 'high' || r.type === 'low') {
      out.push({ v: r.warning, sev: 'warning', label: `เตือน ${r.type === 'high' ? '≥' : '≤'} ${r.warning}` });
      out.push({ v: r.critical, sev: 'critical', label: `วิกฤต ${r.type === 'high' ? '≥' : '≤'} ${r.critical}` });
    } else if (r.type === 'range') {
      out.push({ v: r.warningLow, sev: 'warning', label: `เตือน ≤ ${r.warningLow}` }, { v: r.warningHigh, sev: 'warning', label: `เตือน ≥ ${r.warningHigh}` });
      out.push({ v: r.criticalLow, sev: 'critical', label: `วิกฤต ≤ ${r.criticalLow}` }, { v: r.criticalHigh, sev: 'critical', label: `วิกฤต ≥ ${r.criticalHigh}` });
    }
  }
  return out;
}

/** ช่วงที่ไม่มีข้อมูล: ช่องว่างระหว่างค่าที่นานกว่าเวลาหมดอายุ และช่วงท้ายที่ข้อมูลเก่า */
export function gapIntervals(samples, staleMs, from, to) {
  const gaps = [];
  if (!samples.length) return [[from, to]];
  if (samples[0].observedAt - from > staleMs) gaps.push([from, samples[0].observedAt]);
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].observedAt; const b = samples[i].observedAt;
    if (b - a > staleMs) gaps.push([a + staleMs, b]);
  }
  const last = samples[samples.length - 1].observedAt;
  if (to - last > staleMs) gaps.push([last + staleMs, to]);
  return gaps;
}

/** แบ่งเส้นกราฟเป็นช่วง ไม่ลากเส้นข้ามช่วงที่ขาดข้อมูล */
export function segments(samples, staleMs) {
  const segs = [];
  let cur = [];
  for (let i = 0; i < samples.length; i++) {
    if (i > 0 && samples[i].observedAt - samples[i - 1].observedAt > staleMs) { segs.push(cur); cur = []; }
    cur.push(samples[i]);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

export function renderMetricChart({ metric, samples, rules = [], from, to, title, size = null }) {
  VW = Math.max(240, Math.round(size?.w ?? DEF_W)); VH = Math.max(120, Math.round(size?.h ?? DEF_H));
  try { return buildChart({ metric, samples, rules, from, to, title }); } finally { VW = DEF_W; VH = DEF_H; }
}

function buildChart({ metric, samples, rules, from, to, title }) {
  const staleMs = metric.staleAfterSec * 1000;
  const inRange = samples.filter((x) => x.observedAt >= from && x.observedAt <= to);
  const fig = h('figure.chart');
  const heading = h('figcaption.chart-title', title ?? `${metric.name}${metric.unit ? ` (${metric.unit})` : ''}`);
  fig.appendChild(heading);
  if (!inRange.length) {
    fig.appendChild(h('p.chart-empty', 'ไม่มีค่าที่บันทึกในอุปกรณ์นี้สำหรับช่วงเวลานี้'));
    return fig;
  }
  const svg = metric.kind === 'numeric'
    ? numericSvg(metric, inRange, thresholdsOf(rules), from, to, staleMs)
    : discreteSvg(metric, inRange, rules, from, to, staleMs);
  fig.appendChild(svg);
  fig.appendChild(dataTable(metric, inRange));
  return fig;
}

function xScale(from, to) { const w = VW; return (t) => M.l + ((t - from) / (to - from || 1)) * (w - M.l - M.r); } // คงความกว้างของกราฟนี้ (ใช้ตอนชี้เมาส์ภายหลัง)

function timeAxis(g, from, to, x) {
  const { ticks, long } = ticksTime(from, to);
  // กราฟแคบ (มือถือ): แสดงป้ายเวลาเว้นช่องไม่ให้ทับกัน — เส้นกริดยังครบทุกเส้น ข้อมูลไม่เปลี่ยน
  const gap = ticks.length > 1 ? Math.abs(x(ticks[1]) - x(ticks[0])) : Infinity;
  const stride = Math.max(1, Math.ceil((long ? 70 : 38) / gap));
  ticks.forEach((t, i) => {
    g.appendChild(s('line', { x1: x(t), x2: x(t), y1: M.t, y2: VH - M.b, class: 'grid' }));
    if (i % stride === 0) g.appendChild(s('text', { x: x(t), y: VH - 8, 'text-anchor': 'middle', class: 'axis', text: long ? fmtShortDT(t) : fmtClock(t).slice(0, 5) }));
  });
}

function gapRects(g, samples, staleMs, from, to, x) {
  for (const [a, b] of gapIntervals(samples, staleMs, from, to)) {
    if (b <= a) continue;
    g.appendChild(s('rect', { x: x(a), y: M.t, width: Math.max(1, x(b) - x(a)), height: VH - M.t - M.b, class: 'gap' }, s('title', { text: 'ไม่มีข้อมูล / ข้อมูลขาดช่วง' })));
  }
}

function numericSvg(metric, data, th, from, to, staleMs) {
  const vals = data.map((d) => d.value);
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  for (const t of th) if (t.v >= lo - (hi - lo + 1) * 0.6 && t.v <= hi + (hi - lo + 1) * 0.6) { lo = Math.min(lo, t.v); hi = Math.max(hi, t.v); }
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.1;
  lo -= pad; hi += pad;
  const x = xScale(from, to);
  const vh = VH;
  const y = (v) => vh - M.b - ((v - lo) / (hi - lo)) * (vh - M.t - M.b);
  const svg = s('svg', { viewBox: `0 0 ${VW} ${VH}`, class: 'chart-svg', role: 'img', tabindex: 0,
    'aria-label': `กราฟ ${metric.name} หน่วย ${metric.unit} จำนวน ${data.length} ค่า ใช้ลูกศรซ้าย/ขวาเพื่ออ่านค่า` });
  const g = s('g');
  svg.appendChild(g);
  gapRects(g, data, staleMs, from, to, x);
  for (const v of niceTicks(lo, hi)) {
    g.appendChild(s('line', { x1: M.l, x2: VW - M.r, y1: y(v), y2: y(v), class: 'grid' }));
    g.appendChild(s('text', { x: M.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis', text: fmtNum(v, 2) }));
  }
  timeAxis(g, from, to, x);
  for (const t of th) {
    if (t.v < lo || t.v > hi) continue;
    g.appendChild(s('line', { x1: M.l, x2: VW - M.r, y1: y(t.v), y2: y(t.v), class: `thr thr-${t.sev}` }));
    g.appendChild(s('text', { x: VW - M.r - 4, y: y(t.v) - 4, 'text-anchor': 'end', class: `thr-label thr-${t.sev}`, text: t.label }));
  }
  for (const seg of segments(data, staleMs)) {
    if (seg.length === 1) g.appendChild(s('circle', { cx: x(seg[0].observedAt), cy: y(seg[0].value), r: 2.5, class: 'pt' }));
    else g.appendChild(s('path', { d: seg.map((d, i) => `${i ? 'L' : 'M'}${x(d.observedAt).toFixed(1)},${y(d.value).toFixed(1)}`).join(''), class: 'line' }));
  }
  g.appendChild(s('text', { x: 6, y: M.t + 2, class: 'axis unit', text: metric.unit }));
  attachCursor(svg, data, x, (d) => y(d.value), (d) => `${fmtNum(d.value, metric.decimals ?? 1)} ${metric.unit}`);
  return svg;
}

function discreteSvg(metric, data, rules, from, to, staleMs) {
  const alarmStates = new Map();
  for (const r of rules) if (r.enabled && r.type === 'discrete') for (const [k, v] of Object.entries(r.states)) alarmStates.set(k, v);
  const label = new Map(metric.states.map((st) => [st.value, st.label]));
  const x = xScale(from, to);
  const svg = s('svg', { viewBox: `0 0 ${VW} 96`, class: 'chart-svg', role: 'img', tabindex: 0,
    'aria-label': `ไทม์ไลน์สถานะ ${metric.name} จำนวน ${data.length} ค่า ใช้ลูกศรซ้าย/ขวาเพื่ออ่านค่า` });
  const g = s('g');
  svg.appendChild(g);
  const top = 22; const bh = 34;
  for (let i = 0; i < data.length; i++) {
    const a = data[i].observedAt;
    const next = data[i + 1]?.observedAt;
    const end = Math.min(next !== undefined && next - a <= staleMs ? next : a + staleMs, to);
    const sev = alarmStates.get(data[i].value) ?? 'normal';
    g.appendChild(s('rect', { x: x(a), y: top, width: Math.max(1.5, x(end) - x(a)), height: bh, class: `state st-${sev} sv-${data[i].value}` }, s('title', { text: `${label.get(data[i].value) ?? data[i].value} · ${fmtDateTime(a)}` })));
  }
  const { ticks, long } = ticksTime(from, to);
  for (const t of ticks) g.appendChild(s('text', { x: x(t), y: 90, 'text-anchor': 'middle', class: 'axis', text: long ? fmtShortDT(t) : fmtClock(t).slice(0, 5) }));
  let lx = M.l;
  for (const st of metric.states) {
    const sev = alarmStates.get(st.value) ?? 'normal';
    g.appendChild(s('rect', { x: lx, y: 4, width: 10, height: 10, class: `state st-${sev} sv-${st.value}` }));
    g.appendChild(s('text', { x: lx + 14, y: 13, class: 'axis', text: st.label }));
    lx += 70;
  }
  attachCursor(svg, data, x, () => top + bh / 2, (d) => label.get(d.value) ?? d.value, 96);
  return svg;
}

/** เคอร์เซอร์อ่านค่า: เมาส์ชี้ หรือแป้นลูกศรเมื่อ focus ที่กราฟ */
function attachCursor(svg, data, x, yOf, text, height = VH) {
  const vw = VW; const vh = VH; // ขนาดของกราฟนี้ (คงค่าไว้ใช้ตอนชี้เมาส์ภายหลัง)
  const cur = s('g', { class: 'cursor', visibility: 'hidden' });
  const line = s('line', { y1: M.t, y2: height - (height === vh ? M.b : 14) });
  const dot = s('circle', { r: 4 });
  const bg = s('rect', { rx: 4, height: 34 });
  const t1 = s('text', { class: 'tip' });
  const t2 = s('text', { class: 'tip sub' });
  cur.append(line, dot, bg, t1, t2);
  svg.appendChild(cur);
  let idx = data.length - 1;
  const show = (i) => {
    idx = Math.max(0, Math.min(data.length - 1, i));
    const d = data[idx];
    const px = x(d.observedAt); const py = yOf(d);
    line.setAttribute('x1', px); line.setAttribute('x2', px);
    dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    t1.textContent = text(d);
    t2.textContent = fmtDateTime(d.observedAt);
    const w = 168;
    const bx = px + w + 12 > vw ? px - w - 8 : px + 8;
    bg.setAttribute('x', bx); bg.setAttribute('y', 6); bg.setAttribute('width', w);
    t1.setAttribute('x', bx + 8); t1.setAttribute('y', 20);
    t2.setAttribute('x', bx + 8); t2.setAttribute('y', 34);
    cur.setAttribute('visibility', 'visible');
  };
  const near = (clientX) => {
    const r = svg.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * vw;
    let best = 0; let bd = Infinity;
    for (let i = 0; i < data.length; i++) { const dd = Math.abs(x(data[i].observedAt) - vx); if (dd < bd) { bd = dd; best = i; } }
    return best;
  };
  svg.addEventListener('pointermove', (e) => show(near(e.clientX)));
  svg.addEventListener('pointerleave', () => { if (document.activeElement !== svg) cur.setAttribute('visibility', 'hidden'); });
  svg.addEventListener('focus', () => show(idx));
  svg.addEventListener('blur', () => cur.setAttribute('visibility', 'hidden'));
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1); }
    if (e.key === 'Home') { e.preventDefault(); show(0); }
    if (e.key === 'End') { e.preventDefault(); show(data.length - 1); }
  });
}

function dataTable(metric, data) {
  const rows = data.slice(-300).reverse();
  const label = new Map((metric.states ?? []).map((st) => [st.value, st.label]));
  return h('details.chart-table',
    h('summary', `ตารางค่า (${data.length.toLocaleString('th-TH')} ค่า${data.length > 300 ? ' แสดง 300 ล่าสุด' : ''})`),
    h('div.table-scroll', h('table',
      h('thead', h('tr', h('th', { scope: 'col' }, 'เวลาสังเกต (เวลาไทย)'), h('th', { scope: 'col' }, 'ค่า'), h('th', { scope: 'col' }, 'คุณภาพ'))),
      h('tbody', rows.map((d) => h('tr',
        h('td', fmtDateTime(d.observedAt)),
        h('td', metric.kind === 'numeric' ? `${fmtNum(d.value, metric.decimals ?? 1)} ${metric.unit}` : (label.get(d.value) ?? d.value)),
        h('td', d.quality === 'good' ? 'ดี' : 'ไม่แน่นอน'))))),
    ));
}
