import { h, select, replaceChildren, download } from './dom.js';
import { renderMetricChart } from './chart.js';
import { reasonText } from './format.js';
import { SOURCE_LABEL } from '../domain/constants.js';
import { fmtDateTime, fmtClock } from '../domain/time.js';
import { readingsCsv, alertsCsv } from '../domain/csv.js';
import { storageEstimate } from '../store/idbRepo.js';

const RANGES = [['1h', 'ชั่วโมงล่าสุด', 3600e3], ['6h', '6 ชั่วโมง', 6 * 3600e3], ['24h', '24 ชั่วโมง', 86400e3], ['7d', '7 วัน', 7 * 86400e3]];

export async function renderHistoryView(app, { live = false } = {}) {
  const el = app.viewEl;
  const st = app.state.history;
  const ctl = app.ctl;
  const points = app.config.points;
  if (!st.pointId || !app.index.points.get(st.pointId)) st.pointId = app.state.selectedId ?? points[0]?.id;
  const p = app.index.points.get(st.pointId);
  const source = st.source || ctl.mode;
  const range = RANGES.find((r) => r[0] === st.range) ?? RANGES[1];
  const now = ctl.now();
  // อัปเดตอัตโนมัติไม่บ่อยเกินไป และไม่รบกวนขณะผู้ใช้กำลังเลือกตัวกรอง
  if (live) {
    if (el.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    const sig = `${st.pointId}|${source}|${st.range}|${Math.floor(now / 15000)}|${ctl.engine?.diag.accepted}|${ctl.engine?.diag.rejected}`;
    if (sig === app.historySig) return;
    app.historySig = sig;
  }
  const from = now - range[2];
  const charts = p ? await Promise.all(p.metrics.map(async (m) => renderMetricChart({
    metric: m, samples: await ctl.repo.getSeries(source, p.id, m.id, from, now),
    rules: app.config.rules.filter((r) => r.pointId === p.id && r.metricId === m.id), from, to: now,
  }))) : [];
  const count = await ctl.repo.countSamples();
  const est = await storageEstimate();
  const d = ctl.engine?.diag;
  const ret = ctl.settings.retention;
  const set = (patch) => { app.state.history = { ...st, ...patch }; app.historySig = ''; renderHistoryView(app); };

  replaceChildren(el, h('section.history-view',
    h('div.card-head', h('h2', 'ประวัติข้อมูล'),
      h('p.muted.small', 'ประวัติที่บันทึกในอุปกรณ์นี้ — เก็บเฉพาะค่าที่ได้รับขณะเปิดแอป ช่วงที่แอปปิดหรือเชื่อมต่อไม่ได้จะว่างเปล่า (ไม่มีการเติมค่าย้อนหลัง)')),
    h('div.filters',
      h('label.field.grow', h('span.field-label', 'จุด'), select(points.map((x) => [x.id, `${x.id} ${x.name}${x.status === 'archived' ? ' (เก็บถาวร)' : ''}`]), st.pointId, { 'data-focus-key': 'h-point', onchange: (e) => set({ pointId: e.target.value }) })),
      h('label.field', h('span.field-label', 'ช่วงเวลา'), select(RANGES.map((r) => [r[0], r[1]]), range[0], { 'data-focus-key': 'h-range', onchange: (e) => set({ range: e.target.value }) })),
      h('label.field', h('span.field-label', 'แหล่งข้อมูล'), select([['', `ปัจจุบัน (${SOURCE_LABEL[ctl.mode]})`], ...['demo', 'api'].filter((x) => x !== ctl.mode).map((x) => [x, SOURCE_LABEL[x]])], st.source, { 'data-focus-key': 'h-src', onchange: (e) => set({ source: e.target.value }) })),
      h('div.btn-row',
        h('button.btn.small', {
          type: 'button', onclick: async () => {
            const rows = await ctl.repo.getSamplesBySource(source, from, now);
            download(`iot-fortune-readings-${source}-${stamp()}.csv`, readingsCsv(rows, app.index), 'text/csv;charset=utf-8');
          },
        }, 'ส่งออกค่าวัด CSV (ช่วงนี้ ทุกจุด)'),
        h('button.btn.small', {
          type: 'button', onclick: async () => {
            const eps = await ctl.episodesFor(source);
            download(`iot-fortune-alerts-${source}-${stamp()}.csv`, alertsCsv(eps, app.index), 'text/csv;charset=utf-8');
          },
        }, 'ส่งออกการแจ้งเตือน CSV'))),
    h('p.muted.small', `${SOURCE_LABEL[source]} · ${fmtDateTime(from)} ถึง ${fmtDateTime(now)}${source === 'demo' ? ' · ค่าจำลอง ไม่ใช่ข้อมูลจริงของฟอร์จูน' : ''}`),
    h('div.chart-grid', charts),
    h('div.two-col',
      h('section.card',
        h('h3', 'การเก็บข้อมูลในอุปกรณ์นี้'),
        h('dl.meta.small',
          h('dt', 'จำนวนค่าวัดที่เก็บ'), h('dd', `${count.toLocaleString('th-TH')} ค่า (ทุกแหล่งรวมกัน)`),
          h('dt', 'นโยบาย'), h('dd', `เก็บ ${ret.maxDays} วัน หรือ ${ret.maxSamples.toLocaleString('th-TH')} ค่า แล้วแต่ถึงก่อน — ลบค่าที่เวลาสังเกตเก่าที่สุดก่อน`),
          h('dt', 'พื้นที่ที่ใช้'), h('dd', est ? `${(est.usage / 1048576).toFixed(1)} MB จากโควตาประมาณ ${(est.quota / 1048576).toFixed(0)} MB` : 'เบราว์เซอร์ไม่รายงาน'),
          h('dt', 'ขอบเขต'), h('dd', 'เฉพาะเบราว์เซอร์และโปรไฟล์นี้ ไม่ซิงก์ไปเครื่องอื่น การล้างข้อมูลเว็บไซต์จะลบทั้งหมด'))),
      h('section.card',
        h('h3', 'การตรวจข้อมูลที่รับเข้า (ตั้งแต่เปิดแอป)'),
        d ? h('dl.meta.small',
          h('dt', 'รับได้'), h('dd', d.accepted.toLocaleString('th-TH')),
          h('dt', 'ซ้ำ (ข้าม)'), h('dd', d.duplicates.toLocaleString('th-TH')),
          h('dt', 'ปฏิเสธ'), h('dd', d.rejected.toLocaleString('th-TH')),
          h('dt', 'ชุดล่าสุด'), h('dd', fmtDateTime(d.lastBatchAt))) : null,
        d && Object.keys(d.byReason).length ? h('ul.reasons', Object.entries(d.byReason).map(([k, v]) => h('li', `${reasonText(k)}: ${v}`))) : h('p.muted.small', 'ยังไม่มีข้อมูลที่ถูกปฏิเสธ'),
        d?.recent.length ? h('details', h('summary', 'รายการที่ถูกปฏิเสธล่าสุด'), h('div.table-scroll', h('table',
          h('thead', h('tr', h('th', 'เวลา'), h('th', 'เหตุผล'), h('th', 'ข้อมูลดิบ'))),
          h('tbody', d.recent.map((r) => h('tr', h('td', fmtClock(r.at)), h('td', reasonText(r.reason)), h('td.mono', JSON.stringify(r.raw)?.slice(0, 160) ?? '—'))))))) : null),
    ),
  ));
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}
