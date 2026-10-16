import { h } from './dom.js';

// แผงเซนเซอร์ระดับน้ำ (WL-001 บ่อสูบน้ำ, WL-002 ถังเก็บน้ำ) — เกจแสดงปริมาณน้ำเป็นภาพ + ค่า + สถานะ + เวลาล่าสุด
// สร้าง DOM ครั้งเดียว อัปเดตเฉพาะค่า (เกจเลื่อนนุ่มด้วย CSS transition)

const SEV = { normal: 'ปกติ', warning: 'เฝ้าระวัง', critical: 'วิกฤต', unknown: 'ไม่มีข้อมูล' };

export class WaterPanel {
  /** @param {{ ids:string[], onSelect:(id:string)=>void }} opts */
  constructor(opts) {
    this.opts = opts;
    this.cards = new Map();
    this.el = h('section.water-panel', { 'data-testid': 'water-panel', 'aria-label': 'เซนเซอร์ระดับน้ำ (จำลอง)' },
      h('header.wp-head', h('strong', 'เซนเซอร์ระดับน้ำ'), h('span.lift-sim', 'ข้อมูลจำลอง')));
    for (const id of opts.ids) {
      const fill = h('div.wp-fill');
      const lines = h('div.wp-lines');
      const value = h('strong.wp-value', '—');
      const status = h('span.wp-status', '');
      const time = h('span.wp-time', '');
      const title = h('div.wp-title', '');
      const card = h('button.wp-card', { type: 'button', 'data-testid': `water-${id}`, onclick: () => opts.onSelect(id) },
        h('div.wp-gauge', { 'aria-hidden': 'true' }, fill, lines),
        h('div.wp-info', title, h('div.wp-row', value, status), time));
      this.el.append(card);
      this.cards.set(id, { card, fill, lines, value, status, time, title, sig: '' });
    }
  }

  /**
   * @param {Array<{ id, name, floorName, unit, decimals, value:number|null, frac:number|null, severity, quality, observedAt:number|null,
   *                 thresholds:Array<{frac:number, level:'warning'|'critical'}>, selected:boolean }>} rows
   */
  update(rows) {
    for (const r of rows) {
      const c = this.cards.get(r.id);
      if (!c) continue;
      const sev = r.value === null ? 'unknown' : r.severity;
      c.card.className = `wp-card sev-${sev}${r.selected ? ' selected' : ''}`;
      c.card.dataset.severity = sev;
      c.card.setAttribute('aria-label', `${r.id} ${r.name} ${r.value === null ? 'ไม่มีข้อมูล' : `${r.value} ${r.unit}`} สถานะ${SEV[sev]}`);
      c.title.textContent = `${r.id} · ${r.name} · ${r.floorName}`;
      c.value.textContent = r.value === null ? '—' : `${r.value.toFixed(r.decimals)} ${r.unit}`;
      c.status.textContent = SEV[sev];
      c.time.textContent = r.observedAt ? `ล่าสุด ${new Date(r.observedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} (เวลาจำลอง)` : 'ยังไม่มีข้อมูล';
      c.fill.style.height = `${Math.round(Math.max(0, Math.min(1, r.frac ?? 0)) * 1000) / 10}%`;
      const sig = JSON.stringify(r.thresholds);
      if (sig !== c.sig) {
        c.sig = sig;
        c.lines.replaceChildren(...r.thresholds.map((t) => h('i', { class: `wp-line ${t.level}`, style: { bottom: `${t.frac * 100}%` } })));
      }
    }
  }
}
