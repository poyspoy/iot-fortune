import { h, select, replaceChildren } from './dom.js';
import { sevBadge, sourceBadge, valueText } from './format.js';
import { SEVERITY, SOURCE_LABEL } from '../domain/constants.js';
import { fmtDateTime } from '../domain/time.js';
import { isEpisodeActive, isEpisodeAcknowledged, isEpisodeUnresolved } from '../domain/alarms.js';

/** การ์ดเหตุการณ์แจ้งเตือน (ใช้ทั้งหน้าแจ้งเตือนและแผงรายละเอียด) */
export function episodeCard(app, ep, { compact = false, readonly = false } = {}) {
  const idx = app.index;
  const p = idx.points.get(ep.pointId);
  const m = idx.metric(ep.pointId, ep.metricId);
  const active = isEpisodeActive(ep);
  const acked = isEpisodeAcknowledged(ep);
  const ack = ep.acks?.[ep.acks.length - 1];
  const stateText = active ? 'ยังเกิดอยู่' : ep.recoveredAt ? 'กลับสู่ปกติแล้ว' : 'ยุติเพราะปิดกฎ';
  const canAck = !readonly && ep.source === app.ctl.mode && !acked;
  const fmt = (v) => (m ? valueText(m, v) : String(v));
  return h('article', { class: `episode sev-${ep.severity} ${active ? 'active' : 'ended'} ${acked ? 'acked' : 'unacked'}`, 'aria-label': `${p?.name ?? ep.pointId} ${m?.name ?? ''} ${SEVERITY[ep.severity].label} ${stateText}` },
    h('div.episode-head',
      sevBadge(ep.severity),
      h('span', { class: `badge ${active ? 'state-active' : 'state-recovered'}` }, stateText),
      h('span', { class: `badge ${acked ? 'ack-yes' : 'ack-no'}` }, acked ? 'รับทราบแล้ว' : 'ยังไม่รับทราบ'),
      compact ? null : sourceBadge(ep.source)),
    h('div.episode-title',
      compact ? null : h('button.linkish', { type: 'button', title: 'เปิดโมเดลเดี่ยวของชั้นที่เกิดเหตุ', onclick: () => app.openFloorFor(ep.pointId) }, `${app.numberOf(ep.pointId) ?? '–'}. ${p?.name ?? ep.pointId}`),
      h('span', ` ${ep.pointId} · ${m?.name ?? ep.metricId} · ${app.floorName(p?.floorId)}`)),
    h('dl.meta.small',
      h('dt', 'ค่า'), h('dd', `เริ่ม ${fmt(ep.openValue)} · ล่าสุด `, h('span', { 'data-ep-last': ep.id }, fmt(ep.lastValue)), ep.peakSeverity !== ep.severity ? ` · สูงสุดระดับ${SEVERITY[ep.peakSeverity].label}` : ''),
      h('dt', 'เกิดเมื่อ'), h('dd', `${fmtDateTime(ep.openedAt)}${ep.conditionSince && ep.conditionSince !== ep.openedAt ? ` (เริ่มเกินขีด ${fmtDateTime(ep.conditionSince)})` : ''}`),
      ep.escalatedAt ? [h('dt', 'ยกระดับ'), h('dd', fmtDateTime(ep.escalatedAt))] : null,
      ep.recoveredAt ? [h('dt', 'กลับสู่ปกติ'), h('dd', fmtDateTime(ep.recoveredAt))] : null,
      ep.endReason ? [h('dt', 'ยุติ'), h('dd', `${fmtDateTime(ep.endedAt)} — ปิดกฎ (ไม่ใช่การกลับสู่ปกติ)`)] : null,
      ack ? [h('dt', 'รับทราบ'), h('dd', `${ack.by} · ${fmtDateTime(ack.at)}${ack.note ? ` — “${ack.note}”` : ''}`)] : null,
      ep.acks?.length > 1 ? [h('dt', 'รับทราบก่อนหน้า'), h('dd', ep.acks.slice(0, -1).map((a) => `${a.by} ${fmtDateTime(a.at)}`).join(' / '))] : null),
    !compact && p ? h('button.btn.small.open-floor', { type: 'button', 'data-focus-key': `open-floor-${ep.id}`, onclick: () => app.openFloorFor(ep.pointId) }, `เปิดโมเดล${app.floorName(p.floorId)}`) : null,
    canAck ? ackForm(app, ep) : null,
  );
}

function ackForm(app, ep) {
  const name = h('input', { type: 'text', required: true, maxlength: 80, value: app.ctl.settings.ackName ?? '', autocomplete: 'name', 'data-focus-key': `ackname-${ep.id}` });
  name.defaultValue = app.ctl.settings.ackName ?? '';
  const note = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'เช่น ส่งช่างตรวจหน้างานแล้ว', 'data-focus-key': `acknote-${ep.id}` });
  const msg = h('p.form-msg', { role: 'status' });
  return h('form.ack-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) { msg.textContent = 'กรุณาระบุชื่อผู้รับทราบ'; name.focus(); return; }
      msg.textContent = 'กำลังบันทึก…';
      const r = await app.ctl.acknowledge(ep.id, name.value.trim(), note.value.trim());
      msg.textContent = r.ok ? 'บันทึกการรับทราบแล้ว' : `ไม่สำเร็จ: ${r.error}`;
      if (r.ok) { name.defaultValue = name.value; note.value = ''; app.renderLive(); app.render(); }
    },
  },
  h('label.field', h('span.field-label', 'ชื่อผู้รับทราบ (ชื่อในเครื่องนี้ ไม่ใช่การยืนยันตัวตน)'), name),
  h('label.field', h('span.field-label', 'บันทึก'), note),
  h('button.btn.small.primary', { type: 'submit' }, 'รับทราบ'),
  h('p.hint', 'การรับทราบไม่ได้แปลว่าค่ากลับสู่ปกติ การแจ้งเตือนจะยังแสดงจนกว่าค่าที่ถูกต้องจะพ้นเกณฑ์'),
  msg);
}

export async function renderAlertsView(app, { live = false } = {}) {
  const el = app.viewEl;
  const f = app.state.alertFilter;
  if (live && el.querySelector('form.ack-form') && el.contains(document.activeElement)) return;
  const source = f.source || app.ctl.mode;
  const all = await app.ctl.episodesFor(source);
  let list = all.filter((ep) => (f.state === 'unresolved' ? isEpisodeUnresolved(ep) : f.state === 'active' ? isEpisodeActive(ep) : true));
  if (f.severity) list = list.filter((ep) => ep.severity === f.severity);
  list = app.episodesSorted(list);
  const sig = `${source}|${f.state}|${f.severity}|` + list.map((e) => `${e.id}:${e.severity}:${e.recoveredAt}:${e.endedAt}:${e.acks.length}`).join(',');
  if (live && sig === app.alertSig) {
    // โครงสร้างเหมือนเดิม — อัปเดตเฉพาะค่าล่าสุด ไม่วาดการ์ด/ปุ่มใหม่
    for (const ep of list) {
      const span = el.querySelector(`[data-ep-last="${CSS.escape(ep.id)}"]`);
      const m = app.index.metric(ep.pointId, ep.metricId);
      if (span) span.textContent = m ? valueText(m, ep.lastValue) : String(ep.lastValue);
    }
    return;
  }
  if (live && [...el.querySelectorAll('form.ack-form textarea')].some((t) => t.value)) return;
  app.alertSig = sig;
  const setF = (patch) => { app.state.alertFilter = { ...f, ...patch }; renderAlertsView(app); };
  replaceChildren(el, h('section.alerts-view',
    h('div.card-head', h('h2', 'การแจ้งเตือน'),
      h('p.muted.small', 'การแจ้งเตือนประเมินในเบราว์เซอร์นี้ขณะเปิดแอปเท่านั้น ไม่ใช่การเฝ้าระวัง 24 ชม. และไม่ซิงก์ระหว่างผู้ปฏิบัติงาน ไม่มีการส่ง LINE/อีเมล')),
    h('div.filters',
      h('div.seg', { role: 'group', 'aria-label': 'สถานะ' }, [['unresolved', 'ยังไม่ปิด'], ['active', 'กำลังเกิด'], ['all', 'ทั้งหมด']].map(([k, l]) => h('button', {
        type: 'button', class: `btn small ${f.state === k ? 'active' : ''}`, 'aria-pressed': String(f.state === k), 'data-focus-key': `af-${k}`, onclick: () => setF({ state: k }),
      }, l))),
      h('label.field', h('span.field-label', 'ระดับ'), select([['', 'ทุกระดับ'], ['warning', SEVERITY.warning.label], ['critical', SEVERITY.critical.label]], f.severity, { 'data-focus-key': 'af-sev', onchange: (e) => setF({ severity: e.target.value }) })),
      h('label.field', h('span.field-label', 'แหล่งข้อมูล'), select([['', `ปัจจุบัน (${SOURCE_LABEL[app.ctl.mode]})`], ...['demo', 'api'].filter((s) => s !== app.ctl.mode).map((s) => [s, `${SOURCE_LABEL[s]} (ประวัติ อ่านอย่างเดียว)`])], f.source, { 'data-focus-key': 'af-src', onchange: (e) => setF({ source: e.target.value }) })),
      h('p.table-count', `${list.length} เหตุการณ์`)),
    source !== app.ctl.mode ? h('p.notice.warn', `กำลังดูประวัติของ${SOURCE_LABEL[source]} ซึ่งไม่ใช่แหล่งข้อมูลปัจจุบัน — รับทราบได้เมื่อสลับไปใช้แหล่งนั้น`) : null,
    list.length ? h('div.episode-list', list.map((ep) => episodeCard(app, ep))) : h('p.empty', 'ไม่มีเหตุการณ์ตามตัวกรอง'),
  ));
}
