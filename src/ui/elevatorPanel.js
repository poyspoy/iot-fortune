import { h } from './dom.js';

// แผงควบคุมลิฟต์จำลอง — ปุ่มเลือกชั้นตามชั้นจริงที่ลิฟต์จอด สถานะปลายทาง/ลูกศร/ประตู
// สร้าง DOM ครั้งเดียวแล้วอัปเดตเฉพาะข้อความ/สถานะปุ่ม (ปุ่มไม่หลุดโฟกัสระหว่างลิฟต์วิ่ง)

export class ElevatorPanel {
  /**
   * @param {{ floors:string[], name:string, note:string, onRequest:(id:string)=>void, onCamera:()=>void,
   *           onLiftView:(on:boolean)=>void, onOpenFloor:(id:string)=>void, onShowBuilding:()=>void }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.liftView = false;
    this.headline = h('strong.lift-headline', { 'data-testid': 'lift-headline' }, '');
    this.arrow = h('span.lift-arrow', { 'aria-hidden': 'true' }, '');
    this.doorText = h('span.lift-door', { 'data-testid': 'lift-door' }, '');
    this.detail = h('span.lift-detail', '');
    this.buttons = new Map(opts.floors.map((id) => [id, h('button', {
      type: 'button', class: 'lift-btn', 'data-floor': id, 'data-focus-key': `lift-${id}`, 'aria-label': `ไปชั้น ${id}`,
      onclick: () => opts.onRequest(id),
    }, id)]));
    this.viewBtn = h('button.btn.small', { type: 'button', 'aria-pressed': 'false', 'data-testid': 'lift-cut', onclick: () => { this.liftView = !this.liftView; opts.onLiftView(this.liftView); this.#sync(); } }, 'เปิดปล่อง');
    this.camBtn = h('button.btn.small', { type: 'button', 'data-testid': 'lift-cam', onclick: () => opts.onCamera() }, 'มุมกล้องลิฟต์');
    this.openBtn = h('button.btn.small.ghost', { type: 'button', 'data-testid': 'lift-open-floor', onclick: () => this.status?.atFloor && opts.onOpenFloor(this.status.atFloor) }, '');
    this.isoNote = h('div.lift-iso', h('span', 'ลิฟต์แสดงในมุมมองทั้งอาคาร'),
      h('button.btn.small', { type: 'button', onclick: () => opts.onShowBuilding() }, 'ดูลิฟต์'));
    this.mini = h('span.lift-mini', { 'aria-hidden': 'true' }, '');
    this.body = h('div.lift-body',
      h('div.lift-status', { role: 'status', 'aria-live': 'polite' }, this.arrow, h('div.lift-text', this.headline, this.doorText, this.detail)),
      h('div.lift-buttons', { role: 'group', 'aria-label': 'เลือกชั้นปลายทาง' }, h('span.lift-go', 'ไปชั้น'), [...this.buttons.values()]),
      h('div.lift-actions', this.camBtn, this.viewBtn, this.openBtn),
      h('p.lift-note', opts.note));
    const small = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
    this.el = h('section.lift-panel', { 'data-testid': 'lift-panel', 'aria-label': `${opts.name} (จำลอง)` },
      h('header.lift-head', h('strong', opts.name), h('span.lift-sim', { title: opts.note }, 'จำลอง · ไม่ใช่ข้อมูลจริง'), this.mini,
        h('button.lift-toggle', { type: 'button', 'aria-expanded': String(!small), 'aria-label': 'ย่อ/ขยายแผงลิฟต์', onclick: (e) => {
          const open = this.el.classList.toggle('collapsed') === false;
          e.currentTarget.setAttribute('aria-expanded', String(open));
        } }, '▾')),
      this.body, this.isoNote);
    if (small) this.el.classList.add('collapsed'); // จอเล็ก: เริ่มแบบย่อ ไม่บังโมเดล
  }

  /** ข้อความสั้นชั่วคราว (เช่น กดชั้นเดิม) */
  flash(text) {
    this.detail.textContent = text;
    clearTimeout(this.flashT);
    this.flashT = setTimeout(() => { if (this.status) this.detail.textContent = this.status.detail; }, 2200);
  }

  setIsolated(iso) { this.isolated = iso; this.#sync(); }

  update(status) { this.status = status; this.#sync(); }

  #sync() {
    const st = this.status;
    this.el.classList.toggle('iso', !!this.isolated);
    this.viewBtn.setAttribute('aria-pressed', String(this.liftView));
    this.viewBtn.classList.toggle('active', this.liftView);
    if (!st) return;
    this.el.dataset.phase = st.phase;
    this.el.dataset.target = st.target;
    this.el.dataset.direction = st.direction ?? '';
    this.headline.textContent = st.headline;
    this.mini.textContent = `${st.headline} · ${st.doorText}`;
    this.arrow.textContent = st.arrow;
    this.arrow.className = `lift-arrow ${st.direction ?? 'none'}`;
    this.doorText.textContent = st.doorText;
    this.detail.textContent = st.detail;
    for (const [id, b] of this.buttons) {
      b.disabled = !st.buttonsEnabled;
      const here = st.atFloor === id;
      b.classList.toggle('here', here);
      b.classList.toggle('target', !st.atFloor && st.target === id);
      b.setAttribute('aria-current', here ? 'true' : 'false');
    }
    this.openBtn.hidden = !st.atFloor || st.phase !== 'open';
    this.openBtn.textContent = st.atFloor ? `แยกดูชั้น ${st.atFloor}` : '';
  }
}
