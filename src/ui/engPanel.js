import { h, replaceChildren } from './dom.js';
import { featureInfo, layerSummary } from '../domain/engineering.js';

// แผงแบบวิศวกรรม (Sidebar): มุมมอง 2D/3D · เปิด–ปิดระบบ · แสดงเฉพาะระบบนี้ · รายละเอียดชิ้นที่คลิก
export class EngPanel {
  /** @param {{ onView:(v:'2d'|'3d')=>void, onToggle:(id:string,on:boolean)=>void, onSolo:(id:string)=>void, onAll:()=>void, onClose:()=>void, onPick:(id:string|null)=>void }} opts */
  constructor(opts) {
    this.opts = opts;
    this.el = h('section.eng-panel', { 'data-testid': 'eng-panel', 'aria-label': 'แบบวิศวกรรม (จำลอง)' });
  }

  update({ data, view, vis, selectedId, floorName, onFloor }) {
    const o = this.opts;
    const info = selectedId ? featureInfo(data, selectedId) : null;
    const shown = data.layers.filter((l) => vis[l.id] !== false).length;
    replaceChildren(this.el,
      h('header.eng-head', h('strong', `แบบวิศวกรรม · ${floorName}`),
        h('button.acc-close', { type: 'button', title: 'ปิดแบบวิศวกรรม', 'aria-label': 'ปิดแบบวิศวกรรม', 'data-testid': 'eng-close', onclick: () => o.onClose() }, '×')),
      h('p.eng-disclaimer', { 'data-testid': 'eng-disclaimer' }, data.disclaimer),
      onFloor ? null : h('p.eng-note', 'ตัวอย่างรอบนี้มีเฉพาะชั้น G — เลือกชั้น G เพื่อดูแบบซ้อน'),
      h('div.seg.eng-view', { role: 'group', 'aria-label': 'มุมมองแบบวิศวกรรม' },
        [['2d', 'แปลน 2D'], ['3d', 'ซ้อนบนโมเดล 3D']].map(([k, t]) => h('button', { type: 'button', class: `btn small ${view === k ? 'active' : ''}`, 'aria-pressed': String(view === k), 'data-testid': `eng-view-${k}`, onclick: () => o.onView(k) }, t))),
      h('ul.eng-layers', data.layers.map((l) => h('li', { class: vis[l.id] === false ? 'off' : '' },
        h('label.eng-toggle', h('input', { type: 'checkbox', checked: vis[l.id] !== false, 'data-testid': `eng-layer-${l.id}`, onchange: (e) => o.onToggle(l.id, e.target.checked) }),
          h('i.eng-swatch', { style: `background:${l.color}`, 'aria-hidden': 'true' }),
          h('span', h('b', l.name), h('small', layerSummary(l)))),
        h('button.btn.small.ghost', { type: 'button', 'data-testid': `eng-solo-${l.id}`, title: `แสดงเฉพาะระบบ${l.name}`, onclick: () => o.onSolo(l.id) }, 'แสดงเฉพาะระบบนี้')))),
      shown < data.layers.length ? h('button.btn.small', { type: 'button', 'data-testid': 'eng-all', onclick: () => o.onAll() }, 'แสดงทุกระบบ') : null,
      info ? h('div.eng-info', { 'data-testid': 'eng-info', style: `--c:${info.color}` },
        h('div.eng-info-head', h('i.eng-swatch', { style: `background:${info.color}` }), h('strong', info.name),
          h('button.acc-close', { type: 'button', 'aria-label': 'ล้างการเลือก', onclick: () => o.onPick(null) }, '×')),
        h('dl.meta.small',
          h('dt', 'ระบบ'), h('dd', `${info.system} (${info.systemCode})`),
          h('dt', 'รหัส'), h('dd', { 'data-testid': 'eng-info-code' }, info.code),
          h('dt', 'ประเภท'), h('dd', info.kind),
          info.rows.map(([k, v]) => [h('dt', k), h('dd', v)])),
        h('span.sim-chip', 'ข้อมูลจำลอง'))
        : h('p.eng-hint', 'คลิกเส้นหรืออุปกรณ์บนแบบเพื่อดูชื่อระบบ รหัส และข้อมูล'),
    );
  }
}
