// หน้าจอของ Data Layer (Commit 6): ข้อมูลเชิงพื้นที่ (Point · Asset · Binding · สถานะติดตั้ง) และ "ตำแหน่งที่ต้องตรวจสอบ"
// อ่านจาก SpatialDataService เท่านั้น · แก้ได้เฉพาะ Playground ข้อมูลทดลอง (ยังไม่มีระบบผู้ใช้/สิทธิ์จริง)
// ข้อจำกัด: RoleGate และ Scope ในเบราว์เซอร์กันข้อมูลปนโดยไม่ตั้งใจเท่านั้น — ไม่ใช่ความปลอดภัย (ต้องมี Server-side Authorization ก่อน Production)
import { h, replaceChildren, confirmClick } from './dom.js';
import { REMAP_REASONS } from '../data/coords.js';
import { INSTALL_STATUSES, INSTALL_LABEL, REJECT_REASONS as LIFECYCLE_REJECT } from '../data/lifecycle.js';
import { can, currentRole, ROLE_LABEL } from './roleGate.js';
import { fmtDateTime } from '../domain/time.js';

/** เหตุผลที่ต้องตรวจตำแหน่ง (ภาษาไทย) */
export const REMAP_TEXT = Object.freeze({
  ...REMAP_REASONS,
  'anchor-not-found': 'ไม่พบวัตถุอ้างอิงในโมเดล',
  manual: 'ทำเครื่องหมายให้ตรวจ (หน้างาน)',
  'status-mismatch': 'สถานะจุดกับอุปกรณ์ไม่ตรงกัน',
});

const MAPPING_TEXT = { mapped: 'ผูกกับวัตถุในโมเดลแล้ว', unanchored: 'วางจากผัง (ยังไม่ผูกวัตถุในโมเดล)', needs_remapping: 'ต้องตรวจตำแหน่ง' };
const TYPE_TEXT = { pump: 'ปั๊ม', tank: 'ถัง', pit: 'บ่อ', ahu: 'AHU', panel: 'ตู้ไฟ' };
const ROLE_TEXT = { level: 'ระดับ', run: 'สถานะเดิน', current: 'กระแส', temperature: 'อุณหภูมิ', humidity: 'ความชื้น' };
const shortHash = (v) => (v ? v.replace(/^sha256:/, '').split('+').map((x) => x.slice(0, 8)).join('+') : '—');
const f4 = (n) => (typeof n === 'number' ? n.toFixed(4) : '—');
const f3 = (n) => (typeof n === 'number' ? n.toFixed(3) : '—');

/** แท็บย่อยของหน้า "ตั้งค่า" */
export const SETTINGS_TABS = [['points', 'ตั้งค่าจุด'], ['spatial', 'ข้อมูลเชิงพื้นที่ (Data Layer)'], ['review', 'ตำแหน่งที่ต้องตรวจสอบ']];

export function settingsTabs(app, active) {
  const n = app.ctl.spatial?.service?.reviewList().length ?? 0;
  return h('div.seg.settings-tabs', { role: 'tablist', 'aria-label': 'หมวดการตั้งค่า' },
    SETTINGS_TABS.filter(([id]) => id === 'points' || can('spatial.view')).map(([id, label]) => h('button', {
      type: 'button', role: 'tab', class: `btn small ${active === id ? 'active' : ''}`, 'aria-selected': String(active === id), 'data-testid': `settings-tab-${id}`,
      onclick: () => app.setState({ settingsTab: id }),
    }, label, id === 'review' && n ? h('span.count', String(n)) : null)));
}

function limitsNote(app) {
  return h('div.notice.dl-limits',
    h('strong', 'ข้อจำกัดของรอบนี้ (ยังไม่ใช่ระบบ Production): '),
    'ขอบเขตโครงการ (Scope) และสิทธิ์ (RoleGate) ตรวจในเบราว์เซอร์เท่านั้น ช่วยกันข้อมูลปนโดยไม่ตั้งใจ แต่ไม่ใช่ความปลอดภัย — ',
    `บทบาทของเครื่องนี้: ${ROLE_LABEL[currentRole()]} (ยังไม่มีระบบผู้ใช้จริง)`,
    app.ctl.canEditSpatial ? ' · หน้านี้อยู่ใน Playground ข้อมูลทดลอง เปลี่ยนสถานะได้และรีเซ็ตได้' : ' · แก้สถานะได้เฉพาะ Playground ข้อมูลทดลอง');
}

function statusControl(app, kind, e, msg) {
  const st = e.installation?.status;
  if (!app.ctl.canEditSpatial || !can('spatial.edit')) return h('span', { class: `inst inst-${st}` }, INSTALL_LABEL[st] ?? st);
  const code = kind === 'asset' ? e.assetCode : e.pointCode;
  return h('select', {
    'aria-label': `สถานะติดตั้งของ ${code}`, 'data-testid': `inst-${code}`,
    onchange: async (ev) => {
      msg.textContent = 'กำลังบันทึก…';
      const r = await app.ctl.setInstallStatus(kind, e.id, ev.target.value);
      msg.textContent = r.ok ? `บันทึกสถานะ ${code} = ${INSTALL_LABEL[ev.target.value]} แล้ว` : `บันทึกไม่สำเร็จ: ${r.error}`;
    },
  }, INSTALL_STATUSES.map((s) => h('option', { value: s, selected: s === st, text: INSTALL_LABEL[s] })));
}

/** เปิดดูจุด/อุปกรณ์ใน 2D หรือ 3D (ชั้นของรายการนั้น) */
function openIn(app, mode, { floorCode, pointCode }) {
  app.setState({ view: 'overview' }, { render: false });
  app.changeView({ viewMode: mode, floorId: floorCode, isolated: true, selectedId: pointCode ?? null, detailsOpen: !!pointCode }, { full: true });
}

// ------------------------------------------------------------------ ข้อมูลเชิงพื้นที่
export function spatialSection(app) {
  const sp = app.ctl.spatial; const svc = sp?.service;
  if (!svc) return h('section.card', h('h3', 'ข้อมูลเชิงพื้นที่'), h('p.notice.warn', `ยังสร้างข้อมูลเชิงพื้นที่ไม่ได้: ${sp?.error ?? 'ไม่ทราบสาเหตุ'}`));
  const msg = h('p.form-msg', { role: 'status', 'data-testid': 'dl-msg' });
  const fc = (id) => svc.floor(id)?.code ?? '—';
  const fname = (id) => app.floorName(fc(id));
  const eqPos = new Map((app.scene?.equipmentPositions?.() ?? []).map((x) => [x.assetId, x]));

  const pointRows = svc.doc.points.map((p) => {
    const d = svc.decision(p.id); const m = svc.mapping(p); const pos = svc.position(p);
    return h('tr', { 'data-testid': `dl-point-${p.pointCode}`, class: d.accept ? '' : 'dl-off' },
      h('td.mono', p.pointCode), h('td', p.name), h('td', fname(p.floorId)), h('td.mono', p.sourceKey),
      h('td', statusControl(app, 'point', p, msg)),
      h('td', d.accept ? h('span.dl-yes', '✓ รับข้อมูล · นับ KPI · แจ้งเตือน') : h('span.dl-no', `✕ ${LIFECYCLE_REJECT[d.reason] ?? d.reason}`)),
      h('td.mono', `u ${f4(pos.plan.u)}, v ${f4(pos.plan.v)}`, h('br'), `x ${f3(pos.building.x)}, z ${f3(pos.building.z)}`),
      h('td', m.status === 'needs_remapping' ? h('span.dl-remap-txt', `! ${MAPPING_TEXT[m.status]} (${m.reasons.map((r) => REMAP_TEXT[r] ?? r).join(', ')})`) : MAPPING_TEXT[m.status]),
      h('td.mono.small', { title: p.id }, p.id.slice(0, 8)),
      app.ctl.canEditSpatial && can('spatial.edit') ? h('td', m.status === 'needs_remapping'
        ? null
        : h('button.btn.small.ghost', { type: 'button', 'data-testid': `mark-remap-${p.pointCode}`, onclick: async () => { const r = await app.ctl.setMapping('point', p.id, 'needs_remapping', ['manual']); msg.textContent = r.ok ? `${p.pointCode} ขึ้นรายการตรวจตำแหน่งแล้ว` : r.error; } }, 'ให้ตรวจตำแหน่ง')) : null);
  });

  const assetRows = svc.doc.assets.map((a) => {
    const pos = svc.position(a); const off = a.visual?.offset ?? null; const drawn = eqPos.get(a.id);
    const want = off ? { x: pos.building.x + off.x, z: pos.building.z + (off.z ?? 0) } : null;
    const match = drawn && want ? Math.abs(drawn.local.x - want.x) < 1e-9 && Math.abs(drawn.local.z - want.z) < 1e-9 : null;
    const binds = svc.bindingsOfAsset(a.id);
    return h('tr', { 'data-testid': `dl-asset-${a.assetCode}` },
      h('td.mono', a.assetCode), h('td', TYPE_TEXT[a.type] ?? a.type), h('td', a.name), h('td', fname(a.floorId)),
      h('td', statusControl(app, 'asset', a, msg)),
      h('td.mono', `u ${f4(pos.plan.u)}, v ${f4(pos.plan.v)}`),
      h('td.mono', want ? `x ${f3(want.x)}, z ${f3(want.z)}` : 'ไม่มีภาพ 3D', off ? h('span.hint', ` (ระยะเลื่อน x ${off.x >= 0 ? '+' : ''}${off.x})`) : null),
      h('td', { 'data-testid': `dl-asset-match-${a.assetCode}` }, match === true ? h('span.dl-yes', '✓ 2D/3D ตรงกัน') : match === false ? h('span.dl-no', '✕ ไม่ตรงกัน') : h('span.muted', want ? 'ยังไม่ได้วาด (เปิดโมเดล 3D)' : '—')),
      h('td', binds.map((b) => `${ROLE_TEXT[b.role] ?? b.role} ← ${svc.point(b.pointId)?.pointCode}/${b.metricId}`).join(' · ')));
  });

  const bindingRows = svc.doc.bindings.map((b) => {
    const a = svc.asset(b.assetId); const p = svc.point(b.pointId);
    return h('tr', h('td.mono', a?.assetCode), h('td', ROLE_TEXT[b.role] ?? b.role), h('td.mono', p?.pointCode), h('td.mono', b.metricId), h('td.mono.small', { title: b.id }, b.id.slice(0, 8)));
  });

  const audit = app.ctl.audit.list().slice(-12).reverse();
  const counts = app.ctl.audit.counts;
  const table = (cols, rows, label) => h('div.table-scroll', h('table.compact.dl-table', { 'aria-label': label }, h('thead', h('tr', cols.map((c) => h('th', c)))), h('tbody', rows)));
  const editCol = app.ctl.canEditSpatial && can('spatial.edit') ? [h('span.sr-only', 'การทำงาน')] : [];
  return h('div.dl-view', { 'data-testid': 'dl-view' },
    limitsNote(app),
    h('section.card',
      h('div.card-head', h('h3', `จุดตรวจวัด (Point) · ${svc.doc.points.length}`), h('span.hint', 'โครงการ ', h('span.mono', svc.project.code), ' · ตำแหน่ง u,v บนผัง → x,z ใน Building CRS (FloorFrame เดียวกันทั้ง 2D และ 3D)')),
      table(['รหัส', 'ชื่อ', 'ชั้น', 'sourceKey', 'สถานะติดตั้ง', 'กติกาข้อมูล', 'ตำแหน่ง', 'สถานะตำแหน่ง', 'UUID', ...editCol], pointRows, 'จุดตรวจวัด'),
      msg),
    h('section.card',
      h('div.card-head', h('h3', `อุปกรณ์ (Asset) · ${svc.doc.assets.length}`), h('span.hint', 'ถัง/บ่อ/ปั๊มบนโมเดล 3D และแผงเกจ 2D อ่านจากรายการนี้ (ไม่มีรหัสจุดในโค้ด) · รหัส FRT-DEMO-* เป็นรหัสสาธิต')),
      table(['รหัส', 'ประเภท', 'ชื่อ', 'ชั้น', 'สถานะติดตั้ง', 'ตำแหน่งบนผัง (2D)', 'ตำแหน่งภาพ 3D', 'ตรวจ 2D/3D', 'Binding'], assetRows, 'อุปกรณ์')),
    h('section.card',
      h('div.card-head', h('h3', `ความสัมพันธ์ (Binding) · ${svc.doc.bindings.length}`), h('span.hint', 'ความสัมพันธ์จุด–อุปกรณ์อยู่ที่นี่ที่เดียว')),
      table(['อุปกรณ์', 'บทบาท', 'จุด', 'ค่าวัด', 'UUID'], bindingRows, 'Binding')),
    h('section.card',
      h('div.card-head', h('h3', 'ข้อมูลเข้าที่ถูกปฏิเสธตามสถานะติดตั้ง (Audit)'), h('span.hint', 'เก็บในหน่วยความจำของหน้านี้ (ยังไม่บันทึกถาวร) · ไม่ทิ้งเงียบ')),
      h('p', { 'data-testid': 'dl-audit-counts' }, Object.keys(counts).length ? Object.entries(counts).map(([r, n]) => `${LIFECYCLE_REJECT[r] ?? r}: ${n.toLocaleString('th-TH')}`).join(' · ') : 'ยังไม่มีข้อมูลที่ถูกปฏิเสธ (เดโมไม่สร้างค่าให้จุดที่ยังไม่ติดตั้ง — จะเห็นรายการเมื่อมีข้อมูลจาก API ส่งเข้าจุดเหล่านั้น)'),
      app.ctl.playground ? h('p', h('button.btn.small', { type: 'button', 'data-testid': 'dl-inject', onclick: async () => {
        const r = await app.ctl.injectRejectedTest();
        msg.textContent = r.ok ? `ส่งค่าทดสอบ ${r.sent} ค่าเข้าจุดที่ยังไม่ติดตั้ง/ปลดระวาง → ถูกปฏิเสธ ${r.rejected} · รับ ${r.accepted}` : r.error;
        app.render();
      } }, 'ทดสอบ: ส่งค่าเข้าจุดที่ยังไม่ติดตั้ง'), h('span.hint', ' จำลองอุปกรณ์/API ส่งค่ามาก่อนติดตั้ง — ต้องถูกปฏิเสธและขึ้นในตารางนี้')) : null,
      audit.length ? table(['เวลารับ', 'จุด', 'ค่าวัด', 'เหตุผล'], audit.map((e) => h('tr', h('td', fmtDateTime(e.receivedAt)), h('td.mono', e.pointCode), h('td.mono', e.metricKey), h('td', LIFECYCLE_REJECT[e.reason] ?? e.reason))), 'Audit') : null),
  );
}

// ------------------------------------------------------------------ ตำแหน่งที่ต้องตรวจสอบ
export function reviewSection(app) {
  const svc = app.ctl.spatial?.service;
  if (!svc) return h('p.notice.warn', 'ยังสร้างข้อมูลเชิงพื้นที่ไม่ได้');
  if (!can('spatial.review')) return h('p.notice', 'เฉพาะผู้ดูแลระบบ/ผู้แก้ไข');
  const msg = h('p.form-msg', { role: 'status' });
  const list = svc.reviewList();
  const rows = list.map((x) => {
    const e = x.kind === 'asset' ? svc.asset(x.id) : svc.point(x.id);
    const area = e?.areaId ? svc.area(e.areaId)?.name : null;
    const pointCode = x.kind === 'point' ? x.code : (svc.bindingsOfAsset(x.id)[0] ? svc.point(svc.bindingsOfAsset(x.id)[0].pointId)?.pointCode : null);
    const shown = pointCode && app.activePoints().some((p) => p.id === pointCode);
    const ver = x.issue === 'needs-remapping'
      ? h('span.mono.small', `ผัง ${shortHash(x.resolvedAgainst?.floorPlanVersion)} → ${shortHash(x.current?.floorPlanVersion)}`, h('br'), `โมเดล ${shortHash(x.resolvedAgainst?.modelVersion)} → ${shortHash(x.current?.modelVersion)}`)
      : h('span.small', `จุด: ${INSTALL_LABEL[x.detail?.pointStatus] ?? '—'} · อุปกรณ์ ${svc.asset(x.detail?.assetId)?.assetCode ?? ''}: ${INSTALL_LABEL[x.detail?.assetStatus] ?? '—'}`);
    return h('tr', { 'data-testid': `review-${x.code}-${x.issue}` },
      h('td', h('strong.mono', x.code), h('br'), x.name, h('span.hint', x.kind === 'asset' ? ' (อุปกรณ์)' : ' (จุด)')),
      h('td', `${app.floorName(x.floorCode)}${area ? ` · ${area}` : ''}`),
      h('td', x.issue === 'needs-remapping' ? (e?.position?.anchor ? 'ผูกวัตถุแล้ว' : MAPPING_TEXT.unanchored) : '—'),
      h('td', x.reasons.map((r) => REMAP_TEXT[r] ?? r).join(', ')),
      h('td', ver),
      h('td.actions',
        h('button.btn.small', { type: 'button', 'data-testid': `review-2d-${x.code}`, onclick: () => openIn(app, '2d', { floorCode: x.floorCode, pointCode: shown ? pointCode : null }) }, 'เปิดดูใน 2D'),
        h('button.btn.small', { type: 'button', 'data-testid': `review-3d-${x.code}`, onclick: () => openIn(app, '3d', { floorCode: x.floorCode, pointCode: shown ? pointCode : null }) }, 'เปิดดูใน 3D'),
        x.issue === 'needs-remapping' && app.ctl.canEditSpatial && can('spatial.edit') ? h('button.btn.small.primary', {
          type: 'button', 'data-testid': `review-confirm-${x.code}`,
          onclick: async (ev) => confirmClick(ev.currentTarget, 'กดอีกครั้งเพื่อยืนยัน', async () => {
            const r = await app.ctl.setMapping(x.kind, x.id, 'confirm');
            msg.textContent = r.ok ? `ยืนยันตำแหน่ง ${x.code} กับผัง/โมเดลปัจจุบันแล้ว` : r.error;
          }),
        }, 'ยืนยันตำแหน่งแล้ว') : null));
  });
  return h('section.card.dl-review', { 'data-testid': 'dl-review' },
    h('div.card-head', h('h3', `ตำแหน่งที่ต้องตรวจสอบ · ${list.length}`), h('span.hint', 'ไม่ลบ ไม่ซ่อน — จุดยังแสดงที่ตำแหน่งล่าสุดที่รู้ และยังรับข้อมูลตามสถานะติดตั้ง')),
    limitsNote(app),
    list.length
      ? h('div.table-scroll', h('table.compact.dl-table', h('thead', h('tr', ['Point/Asset', 'ชั้นและพื้นที่', 'สถานะ Anchor', 'สาเหตุ', 'Plan/Model Version (ที่วางไว้ → ปัจจุบัน)', h('span.sr-only', 'การทำงาน')].map((c) => h('th', c)))), h('tbody', rows)))
      : h('p.muted', { 'data-testid': 'dl-review-empty' }, 'ไม่มีรายการที่ต้องตรวจสอบ'),
    msg);
}

/** แถบ Playground (แสดงเฉพาะเมื่อเปิด Playground ข้อมูลทดลอง) */
export function playgroundBar(app) {
  return h('div.notice.pg-bar', { 'data-testid': 'pg-bar', role: 'note' },
    h('strong', 'Playground ข้อมูลทดลอง · Data Layer'),
    h('span', ' — ฐานข้อมูลทดลองแยก ไม่ใช่ข้อมูลจริง และไม่เกี่ยวกับ Demo หลัก '),
    h('button.btn.small', { type: 'button', 'data-testid': 'pg-open', onclick: () => app.setState({ view: 'settings', settingsTab: 'spatial' }) }, 'ดูข้อมูลเชิงพื้นที่'),
    h('button.btn.small.danger', {
      type: 'button', 'data-testid': 'pg-reset',
      onclick: (ev) => confirmClick(ev.currentTarget, 'กดอีกครั้งเพื่อรีเซ็ต', async () => {
        ev.currentTarget.disabled = true;
        const r = await app.ctl.resetPlayground();
        if (r.ok) location.reload();
      }),
    }, 'รีเซ็ต Playground'));
}
