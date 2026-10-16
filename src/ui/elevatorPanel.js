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
      type: 'button', class: 'lift-btn', 'data-floor': id, 'data-focus-key': `lift-${id}`, 'aria-label': `สั่งลิฟต์จำลองไปชั้น ${id}`,
      onclick: () => opts.onRequest(id),
    }, id)]));
    this.viewBtn = h('button.btn.small', { type: 'button', 'aria-pressed': 'false', 'data-testid': 'lift-cut', onclick: () => { this.liftView = !this.liftView; opts.onLiftView(this.liftView); this.#sync(); } }, 'เปิดปล่อง');
    this.camBtn = h('button.btn.small', { type: 'button', 'data-testid': 'lift-cam', onclick: () => opts.onCamera() }, 'มุมกล้องลิฟต์');
    this.openBtn = h('button.btn.small.ghost', { type: 'button', 'data-testid': 'lift-open-floor', onclick: () => this.status?.atFloor && opts.onOpenFloor(this.status.atFloor) }, '');
    this.isoNote = h('div.lift-iso', h('span', 'ดูชั้นเดียว · ลิฟต์ยังวิ่งเบื้องหลัง'),
      h('button.btn.small', { type: 'button', onclick: () => opts.onShowBuilding() }, 'ดูลิฟต์'));
    this.mini = h('span.lift-mini', { 'aria-hidden': 'true' }, '');
    // ข้อมูลสถานะครบ 4 ค่า: ชั้นปัจจุบัน ชั้นเป้าหมาย ทิศทาง ประตู
    this.cur = h('dd', { 'data-testid': 'lift-current' }, '—');
    this.tgt = h('dd', { 'data-testid': 'lift-target' }, '—');
    this.dir = h('dd', { 'data-testid': 'lift-direction' }, '—');
    this.door = h('dd', { 'data-testid': 'lift-door-state' }, '—');
    this.info = h('dl.lift-info', h('dt', 'ชั้นปัจจุบัน'), this.cur, h('dt', 'ชั้นเป้าหมาย'), this.tgt, h('dt', 'ทิศทาง'), this.dir, h('dt', 'ประตู'), this.door);
    // โหมดอัตโนมัติ (สวิตช์) · หยุดชั่วคราว · รีเซ็ต — ปุ่มชั้นกดได้เสมอ (คำสั่งผู้ใช้มีสิทธิ์ก่อน แล้วกลับสู่อัตโนมัติ)
    this.autoBtn = h('button.lift-switch', { type: 'button', role: 'switch', 'aria-checked': 'true', 'data-testid': 'lift-auto', onclick: () => opts.onAuto?.(!this.auto) },
      h('i', { 'aria-hidden': 'true' }), h('span.ls-text', 'ลิฟต์อัตโนมัติ: เปิด'));
    this.pauseBtn = h('button.btn.small', { type: 'button', 'aria-pressed': 'false', 'data-testid': 'lift-pause', onclick: () => opts.onPause?.(!this.paused) }, '⏸ หยุดชั่วคราว');
    this.resetBtn = h('button.btn.small', { type: 'button', 'data-testid': 'lift-reset', onclick: () => opts.onReset?.() }, '⟲ รีเซ็ต (กลับชั้น G)');
    this.modeText = h('span.lift-mode', { 'data-testid': 'lift-mode' }, '');
    this.body = h('div.lift-body',
      h('div.lift-status', { role: 'status', 'aria-live': 'polite' }, this.arrow, h('div.lift-text', this.headline, this.doorText, this.detail)),
      this.info,
      h('div.lift-modebar', this.autoBtn, this.modeText),
      h('div.lift-buttons', { role: 'group', 'aria-label': 'เลือกชั้นปลายทาง' }, h('span.lift-go', 'สั่งลิฟต์ไปชั้น'), [...this.buttons.values()]),
      h('div.lift-demo', this.pauseBtn, this.resetBtn),
      h('div.lift-actions', this.camBtn, this.viewBtn),
      h('p.lift-note', h('span.sim-chip', 'ลิฟต์จำลอง · ไม่ใช่ข้อมูลจริง'), ' ', opts.note));
    this.el = h('section.lift-panel', { 'data-testid': 'lift-panel', 'aria-label': `${opts.name} (จำลอง)` },
      h('header.lift-head', h('strong', opts.name), h('span.lift-sim', { title: opts.note }, 'จำลอง · ไม่ใช่ข้อมูลจริง'), this.mini,
        h('button.lift-toggle', { type: 'button', 'aria-expanded': 'true', 'aria-label': 'ย่อ/ขยายแผงลิฟต์', onclick: (e) => {
          const open = this.el.classList.toggle('collapsed') === false;
          e.currentTarget.setAttribute('aria-expanded', String(open));
        } }, '▾')),
      this.body, this.isoNote);
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
    this.el.classList.toggle('iso', !!this.isolated); // ดูชั้นเดียว: ลิฟต์ยังวิ่งเบื้องหลัง แผงยังแสดงสถานะจริงของตัวจำลอง
    this.viewBtn.setAttribute('aria-pressed', String(this.liftView));
    this.viewBtn.classList.toggle('active', this.liftView);
    if (!st) return;
    this.auto = !!st.auto; this.paused = !!st.paused;
    this.autoBtn.setAttribute('aria-checked', String(this.auto));
    this.autoBtn.classList.toggle('on', this.auto);
    this.autoBtn.querySelector('.ls-text').textContent = `ลิฟต์อัตโนมัติ: ${this.auto ? 'เปิด' : 'ปิด'}`;
    this.pauseBtn.textContent = this.paused ? '▶ เดินต่อ' : '⏸ หยุดชั่วคราว';
    this.pauseBtn.setAttribute('aria-pressed', String(this.paused));
    this.pauseBtn.classList.toggle('active', this.paused);
    this.modeText.textContent = st.modeText ?? '';
    this.el.dataset.mode = st.mode ?? '';
    this.el.dataset.phase = st.phase;
    this.el.dataset.target = st.target;
    this.el.dataset.direction = st.direction ?? '';
    this.headline.textContent = st.headline;
    this.mini.textContent = `${st.headline} · ${st.doorText}`;
    this.arrow.textContent = st.arrow;
    this.arrow.className = `lift-arrow ${st.direction ?? 'none'}`;
    this.doorText.textContent = st.doorText;
    this.detail.textContent = st.detail;
    this.cur.textContent = `ชั้น ${st.nearest}`;
    this.tgt.textContent = st.phase === 'open' && st.atFloor ? '—' : `ชั้น ${st.target}`;
    this.dir.textContent = st.direction === 'up' ? '▲ ขึ้น' : st.direction === 'down' ? '▼ ลง' : 'หยุดนิ่ง';
    this.door.textContent = st.doorText;
    this.door.className = `door-${st.doors}`;
    for (const [id, b] of this.buttons) {
      b.disabled = false; // กดได้เสมอ
      const here = st.atFloor === id;
      b.classList.toggle('here', here);
      b.classList.toggle('target', !st.atFloor && st.target === id);
      b.setAttribute('aria-current', here ? 'true' : 'false');
    }
    this.openBtn.hidden = !st.atFloor || st.phase !== 'open';
    this.openBtn.textContent = st.atFloor ? `แยกดูชั้น ${st.atFloor}` : '';
  }
}
