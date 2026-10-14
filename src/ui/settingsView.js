import { h, select, field, replaceChildren, download } from './dom.js';
import { ruleText } from './format.js';
import { renderPlan } from './plan2d.js';
import { SYSTEMS, RULE_TYPES, SEVERITY, AREA_KINDS } from '../domain/constants.js';
import { floorBounds, validatePos3d, planTo3D } from '../domain/geometry.js';
import { validEndpointText } from './validators.js';
import { createDefaultConfig } from '../domain/defaultConfig.js';
import { fmtDateTime } from '../domain/time.js';

const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

export function renderSettingsView(app, { live = false } = {}) {
  if (live) return; // ไม่รีเฟรชฟอร์มขณะผู้ใช้กรอก
  const el = app.viewEl;
  replaceChildren(el, h('section.settings-view',
    h('div.card-head', h('h2', 'ตั้งค่าจุด'), h('p.muted.small', 'การตั้งค่าทั้งหมดบันทึกใน IndexedDB ของเบราว์เซอร์นี้เท่านั้น')),
    sourceSection(app),
    pointsSection(app),
    rulesOverview(app),
    storageSection(app),
  ));
}

// --------------------------------------------------------------- แหล่งข้อมูล
function sourceSection(app) {
  const ctl = app.ctl;
  const s = ctl.settings;
  let mode = s.mode;
  const url = h('input', { type: 'url', value: s.api.url, placeholder: 'https://iot-gateway.example.com/telemetry', inputmode: 'url', 'aria-describedby': 'api-help' });
  const interval = h('input', { type: 'number', min: 5, max: 3600, step: 1, value: s.api.intervalSec });
  const timeout = h('input', { type: 'number', min: 1, max: 120, step: 1, value: s.api.timeoutSec });
  const msg = h('p.form-msg', { role: 'status' });
  const apiFields = h('div.api-fields', { hidden: mode !== 'api' },
    field('URL ของ API (GET, JSON)', url),
    h('div.row', field('รอบการดึง (วินาที)', interval, 'ค่าเริ่มต้น 10'), field('หมดเวลา (วินาที)', timeout, 'ต้องน้อยกว่ารอบการดึง')),
    h('div.help', { id: 'api-help' },
      h('p', 'แอปอ่านข้อมูลจาก URL นี้เท่านั้น ไม่ค้นหาอุปกรณ์หรือสแกนเครือข่าย ไม่ส่งคำสั่งควบคุมใด ๆ'),
      h('p', 'ต้องเป็น HTTPS (ยกเว้น http://localhost สำหรับทดสอบ) และเซิร์ฟเวอร์ต้องส่ง CORS header เช่น Access-Control-Allow-Origin ให้ตรงกับ origin ของหน้านี้ มิฉะนั้นเบราว์เซอร์จะบล็อก'),
      h('p', 'ห้ามใส่รหัสผ่าน/API key ถาวรในแอปนี้ ข้อมูลที่ต้องยืนยันตัวตนควรผ่านบริการฝั่งเซิร์ฟเวอร์ (proxy) ที่ดูแลสิทธิ์เอง')));
  const radio = (v, label, desc) => h('label.radio', h('input', {
    type: 'radio', name: 'srcmode', value: v, checked: mode === v,
    onchange: () => { mode = v; apiFields.hidden = v !== 'api'; },
  }), h('span', h('strong', label), h('span.hint', desc)));
  return h('section.card',
    h('h3', 'แหล่งข้อมูล'),
    h('div.radios',
      radio('demo', 'ข้อมูลจำลอง', 'สร้างค่าในเบราว์เซอร์ตามสถานการณ์ที่เลือก ไม่ใช่ข้อมูลจริง'),
      radio('api', 'ข้อมูลจาก API', 'ดึงจาก HTTP endpoint ที่กำหนดเองตามสัญญา JSON ใน README')),
    apiFields,
    h('p.hint', 'สลับแหล่งข้อมูลจะเริ่ม engine ใหม่ ประวัติของแต่ละแหล่งแยกกัน ค่าจำลองจะไม่ถูกใช้แทนค่าจาก API เมื่อเชื่อมต่อล้มเหลว'),
    h('button.btn.primary', {
      type: 'button',
      onclick: async () => {
        if (mode === 'api') {
          const err = validEndpointText(url.value.trim());
          const iv = num(interval.value); const to = num(timeout.value);
          if (err) { msg.textContent = err; url.focus(); return; }
          if (!(iv >= 5 && iv <= 3600)) { msg.textContent = 'รอบการดึงต้องอยู่ระหว่าง 5–3600 วินาที'; return; }
          if (!(to >= 1 && to < iv)) { msg.textContent = 'เวลาหมดต้องอย่างน้อย 1 วินาที และน้อยกว่ารอบการดึง'; return; }
          msg.textContent = 'กำลังบันทึก…';
          const r = await app.ctl.switchMode('api', { url: url.value.trim(), intervalSec: iv, timeoutSec: to });
          msg.textContent = r.ok ? 'บันทึกในอุปกรณ์นี้แล้ว และเริ่มดึงข้อมูลจาก API' : `บันทึกไม่สำเร็จ: ${r.error}`;
        } else {
          const r = await app.ctl.switchMode('demo');
          msg.textContent = r.ok ? 'บันทึกแล้ว ใช้ข้อมูลจำลอง' : `บันทึกไม่สำเร็จ: ${r.error}`;
        }
      },
    }, 'บันทึกและเริ่มใช้'),
    msg);
}

// --------------------------------------------------------------- จุดตรวจวัด
function pointsSection(app) {
  const cfg = app.config;
  const host = h('div.editor-host');
  const list = h('div.table-scroll', h('table.compact',
    h('thead', h('tr', h('th', 'รหัส'), h('th', 'ชื่อ'), h('th', 'ชั้น'), h('th', 'ค่าวัด'), h('th', 'สถานะ'), h('th', h('span.sr-only', 'การทำงาน')))),
    h('tbody', cfg.points.map((p) => h('tr', { class: p.status === 'archived' ? 'archived' : '' },
      h('td.mono', p.id), h('td', p.name), h('td', app.floorName(p.floorId)),
      h('td', p.metrics.map((m) => `${m.name}${m.unit ? ` (${m.unit})` : ''}`).join(', ')),
      h('td', p.status === 'active' ? 'ติดตาม' : 'เก็บถาวร'),
      h('td', h('button.btn.small', { type: 'button', onclick: () => { app.state.editing = p.id; openEditor(app, host, p.id); } }, 'แก้ไข')))))));
  const sec = h('section.card',
    h('div.card-head', h('h3', 'จุดตรวจวัด'), h('button.btn.small.primary', { type: 'button', onclick: () => { app.state.editing = 'new'; openEditor(app, host, 'new'); } }, '+ เพิ่มจุด')),
    h('p.hint', 'จุดที่เก็บถาวรจะไม่ถูกติดตามและไม่นับใน KPI แต่ประวัติยังเก็บอยู่ (ไม่มีการลบจุดเพื่อรักษาความสัมพันธ์ของประวัติ)'),
    list, host);
  if (app.state.editing) queueMicrotask(() => openEditor(app, host, app.state.editing));
  return sec;
}

function newPointDraft(app) {
  const ids = new Set(app.config.points.map((p) => p.id));
  let n = app.config.points.length + 1;
  while (ids.has(`P-${String(n).padStart(3, '0')}`)) n++;
  const floorId = app.state.floorId;
  return {
    id: `P-${String(n).padStart(3, '0')}`, sourceKey: '', name: '', system: 'environment', equipmentId: '',
    floorId, areaId: app.config.building.areas.find((a) => a.floorId === floorId)?.id ?? '',
    plan: { x: 0.5, y: 0.5 }, pos3d: null, status: 'active', example: false,
    metrics: [{ id: 'value', sourceKey: 'value', name: 'ค่าวัด', kind: 'numeric', unit: '', decimals: 1, plausible: { min: 0, max: 100 }, staleAfterSec: 120, explain: '' }],
  };
}

function openEditor(app, host, id) {
  const isNew = id === 'new';
  const existing = isNew ? null : app.config.points.find((p) => p.id === id);
  if (!isNew && !existing) { host.replaceChildren(); return; }
  const draft = app.editDraft?.key === id ? app.editDraft.point : (isNew ? newPointDraft(app) : structuredClone(existing));
  const rules = app.editDraft?.key === id ? app.editDraft.rules : structuredClone(app.config.rules.filter((r) => r.pointId === (existing?.id ?? draft.id)));
  app.editDraft = { key: id, point: draft, rules };
  const msg = h('div.form-msg', { role: 'status', tabindex: -1 });
  const redraw = () => openEditor(app, host, id);

  const floors = app.config.building.floors;
  const areas = app.config.building.areas.filter((a) => a.floorId === draft.floorId);
  const floor = app.index.floors.get(draft.floorId);
  const planBox = h('div.place-plan');
  const xIn = h('input', { type: 'number', min: 0, max: 1, step: 0.001, value: draft.plan.x });
  const yIn = h('input', { type: 'number', min: 0, max: 1, step: 0.001, value: draft.plan.y });
  const drawPlan = () => {
    const others = app.items().filter((it) => it.point.floorId === draft.floorId && it.point.id !== draft.id);
    replaceChildren(planBox, renderPlan({ floor, items: others, placing: true, placeMark: draft.plan, compact: true, onPlace: (xy) => { draft.plan = xy; xIn.value = xy.x; yIn.value = xy.y; drawPlan(); } }));
  };
  xIn.addEventListener('input', () => { draft.plan = { ...draft.plan, x: num(xIn.value) }; drawPlan(); });
  yIn.addEventListener('input', () => { draft.plan = { ...draft.plan, y: num(yIn.value) }; drawPlan(); });
  drawPlan();

  const b = floorBounds(floor);
  const auto = planTo3D(floor, draft.plan);
  const use3d = h('input', { type: 'checkbox', checked: !!draft.pos3d, onchange: (e) => { draft.pos3d = e.target.checked ? { x: +auto.x.toFixed(2), y: +auto.y.toFixed(2), z: +auto.z.toFixed(2) } : null; redraw(); } });
  const p3 = (k) => h('input', { type: 'number', step: 0.01, value: draft.pos3d?.[k] ?? '', disabled: !draft.pos3d, oninput: (e) => { draft.pos3d = { ...draft.pos3d, [k]: num(e.target.value) }; } });

  const text = (obj, key, props = {}) => h('input', { type: 'text', value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; }, ...props });

  const editorEl = h('form.editor', {
    'aria-label': isNew ? 'เพิ่มจุดใหม่' : `แก้ไขจุด ${draft.id}`,
    onsubmit: async (e) => {
      e.preventDefault();
      const cfg = structuredClone(app.config);
      const pt = structuredClone(draft);
      if (!pt.sourceKey) pt.sourceKey = pt.id;
      for (const m of pt.metrics) if (!m.sourceKey) m.sourceKey = m.id;
      if (existing) {
        const kept = new Set(pt.metrics.map((m) => m.id));
        const lost = existing.metrics.filter((m) => !kept.has(m.id)).map((m) => m.id);
        if (lost.length) { showErr(msg, [`ลบหรือเปลี่ยนรหัสค่าวัดที่มีอยู่ไม่ได้ (${lost.join(', ')}) เพื่อรักษาความสัมพันธ์กับประวัติ — เปลี่ยนชื่อที่แสดงได้ หรือเก็บถาวรจุดแล้วสร้างจุดใหม่`]); return; }
      }
      const pos3dErr = pt.pos3d ? validatePos3d(floor, pt.pos3d) : [];
      if (pos3dErr.length) { showErr(msg, pos3dErr); return; }
      if (isNew) {
        if (cfg.points.some((p) => p.id === pt.id)) { showErr(msg, [`รหัสจุด ${pt.id} มีอยู่แล้ว`]); return; }
        cfg.points.push(pt);
      } else {
        cfg.points = cfg.points.map((p) => (p.id === existing.id ? pt : p));
      }
      cfg.rules = [...cfg.rules.filter((r) => r.pointId !== pt.id), ...rules.map((r) => ({ ...r, pointId: pt.id }))];
      msg.textContent = 'กำลังตรวจและบันทึก…';
      const r = await app.ctl.saveConfig(cfg);
      if (!r.ok) { showErr(msg, r.errors); return; }
      app.editDraft = null;
      app.state.editing = null;
      app.render();
      app.ctl.storageNotice = { ok: true, text: `บันทึกจุด ${pt.id} ในอุปกรณ์นี้แล้ว — เกณฑ์ใหม่ประเมินกับค่าสดใหม่ทันที กราฟเปลี่ยนเมื่อมีค่าใหม่`, at: Date.now() };
    },
  },
  h('h4', isNew ? 'เพิ่มจุดใหม่' : `แก้ไขจุด ${draft.id}`),
  h('div.grid-form',
    field('รหัสจุด (คงที่)', text(draft, 'id', { required: true, pattern: '[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}', disabled: !isNew })),
    field('ชื่อ', text(draft, 'name', { required: true, maxlength: 120 })),
    field('ระบบ', select(Object.entries(SYSTEMS).map(([k, v]) => [k, v.label]), draft.system, { onchange: (e) => { draft.system = e.target.value; } })),
    field('รหัสอุปกรณ์ (ถ้ามี)', text(draft, 'equipmentId', { maxlength: 64 })),
    field('รหัสอ้างอิงต้นทาง (pointId ใน API)', text(draft, 'sourceKey', { placeholder: draft.id, maxlength: 64 }), 'เว้นว่าง = ใช้รหัสจุด'),
    field('ชั้น', select(floors.map((f) => [f.id, f.name]), draft.floorId, { onchange: (e) => { draft.floorId = e.target.value; draft.areaId = app.config.building.areas.find((a) => a.floorId === draft.floorId)?.id ?? ''; draft.pos3d = null; redraw(); } })),
    field('พื้นที่', select([['', '— ไม่ระบุ —'], ...areas.map((a) => [a.id, `${a.name} (${AREA_KINDS[a.kind]})`])], draft.areaId ?? '', { onchange: (e) => { draft.areaId = e.target.value; } })),
  ),
  h('fieldset.place',
    h('legend', 'ตำแหน่งบนผัง — คลิกบนผังเพื่อวาง หรือพิมพ์พิกัด 0–1'),
    planBox,
    h('div.row', field('x (0–1 จากซ้าย)', xIn), field('y (0–1 จากบน)', yIn)),
    h('p.hint', 'พิกัดเป็นตำแหน่งสัมพัทธ์บนภาพผัง ไม่ใช่พิกัดสำรวจจริง และไม่มีการแปลงพิกัดอัตโนมัติที่แม่นยำ'),
    h('label.check', use3d, 'กำหนดพิกัด 3D เอง (ถ้าไม่กำหนด คำนวณจากผัง)'),
    h('div.row', field('X', p3('x')), field('Y', p3('y')), field('Z', p3('z'))),
    h('p.hint', `ขอบเขตชั้นนี้: X ${b.minX.toFixed(2)}–${b.maxX.toFixed(2)}, Y ${b.minY.toFixed(2)}–${b.maxY.toFixed(2)}, Z ${b.minZ.toFixed(2)}–${b.maxZ.toFixed(2)}`)),
  metricsEditor(draft, redraw),
  rulesEditor(draft, rules, redraw),
  h('div.btn-row',
    h('button.btn.primary', { type: 'submit' }, 'บันทึกจุดและเกณฑ์'),
    !isNew ? h('button.btn', {
      type: 'button',
      onclick: async () => {
        const cfg = structuredClone(app.config);
        const target = cfg.points.find((p) => p.id === existing.id);
        target.status = target.status === 'active' ? 'archived' : 'active';
        const r = await app.ctl.saveConfig(cfg);
        if (!r.ok) return showErr(msg, r.errors);
        app.editDraft = null; app.state.editing = null; app.render();
      },
    }, existing.status === 'active' ? 'เก็บถาวร (หยุดติดตาม)' : 'นำกลับมาติดตาม') : null,
    h('button.btn.ghost', { type: 'button', onclick: () => { app.editDraft = null; app.state.editing = null; host.replaceChildren(); } }, 'ยกเลิก')),
  msg);
  replaceChildren(host, editorEl);
}

function showErr(msg, errors) {
  replaceChildren(msg, h('div.notice.error', h('strong', 'บันทึกไม่ได้ — โปรดแก้ไข:'), h('ul', errors.slice(0, 12).map((e) => h('li', e)))));
  msg.focus();
}

function metricsEditor(draft, redraw) {
  const rows = draft.metrics.map((m, i) => {
    const set = (k, parse = (v) => v) => (e) => { m[k] = parse(e.target.value); };
    return h('div.metric-row',
      h('div.grid-form',
        field('รหัสค่าวัด', h('input', { type: 'text', value: m.id, oninput: set('id'), required: true })),
        field('รหัสต้นทาง (metricId)', h('input', { type: 'text', value: m.sourceKey ?? '', placeholder: m.id, oninput: set('sourceKey') })),
        field('ชื่อ', h('input', { type: 'text', value: m.name, oninput: set('name'), required: true })),
        field('ชนิด', select([['numeric', 'ตัวเลข'], ['discrete', 'สถานะ']], m.kind, {
          onchange: (e) => {
            m.kind = e.target.value;
            if (m.kind === 'discrete') { m.unit = ''; m.states = m.states?.length ? m.states : [{ value: 'on', label: 'ทำงาน' }, { value: 'off', label: 'ไม่ทำงาน' }]; delete m.plausible; } else { m.plausible ??= { min: 0, max: 100 }; delete m.states; }
            redraw();
          },
        })),
        m.kind === 'numeric' ? [
          field('หน่วย', h('input', { type: 'text', value: m.unit, oninput: set('unit'), required: true, placeholder: 'เช่น °C, cm, kW' })),
          field('ค่าต่ำสุดที่เป็นไปได้', h('input', { type: 'number', step: 'any', value: m.plausible?.min ?? '', oninput: (e) => { m.plausible = { ...m.plausible, min: num(e.target.value) }; } })),
          field('ค่าสูงสุดที่เป็นไปได้', h('input', { type: 'number', step: 'any', value: m.plausible?.max ?? '', oninput: (e) => { m.plausible = { ...m.plausible, max: num(e.target.value) }; } })),
          field('ทศนิยม', h('input', { type: 'number', min: 0, max: 4, value: m.decimals ?? 1, oninput: set('decimals', num) })),
        ] : field('สถานะ (ค่า:ชื่อ คั่นด้วยจุลภาค)', h('input', {
          type: 'text', value: (m.states ?? []).map((s) => `${s.value}:${s.label}`).join(', '),
          oninput: (e) => { m.states = e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [v, ...l] = x.split(':'); return { value: v.trim(), label: (l.join(':') || v).trim() }; }); },
        })),
        field('ข้อมูลเก่าเมื่อไม่มีค่าใหม่เกิน (วินาที)', h('input', { type: 'number', min: 5, step: 1, value: m.staleAfterSec, oninput: set('staleAfterSec', num) })),
        field('คำอธิบายหน่วย/ความหมาย', h('input', { type: 'text', value: m.explain ?? '', oninput: set('explain') })),
      ),
      draft.metrics.length > 1 ? h('button.btn.small.ghost', { type: 'button', onclick: () => { draft.metrics.splice(i, 1); redraw(); } }, 'ลบค่าวัดนี้') : null);
  });
  return h('fieldset', h('legend', 'ค่าวัด (หน่วยต่างกันให้แยกค่าวัด เช่น kW กับ kWh)'), rows,
    h('button.btn.small', { type: 'button', onclick: () => { draft.metrics.push({ id: `m${draft.metrics.length + 1}`, sourceKey: '', name: 'ค่าวัดใหม่', kind: 'numeric', unit: '', decimals: 1, plausible: { min: 0, max: 100 }, staleAfterSec: 120, explain: '' }); redraw(); } }, '+ เพิ่มค่าวัด'));
}

function rulesEditor(draft, rules, redraw) {
  const metricOpts = draft.metrics.map((m) => [m.id, m.name]);
  const rows = rules.map((r, i) => {
    const m = draft.metrics.find((x) => x.id === r.metricId) ?? draft.metrics[0];
    const n = (k, label) => field(label, h('input', { type: 'number', step: 'any', value: r[k] ?? '', oninput: (e) => { r[k] = num(e.target.value); } }));
    const types = m?.kind === 'discrete' ? [['discrete', RULE_TYPES.discrete]] : Object.entries(RULE_TYPES).filter(([k]) => k !== 'discrete');
    let body;
    if (r.type === 'discrete') {
      body = (m?.states ?? []).map((s) => field(`เมื่อเป็น "${s.label}"`, select([['', 'ปกติ'], ['warning', SEVERITY.warning.label], ['critical', SEVERITY.critical.label]], r.states?.[s.value] ?? '', {
        onchange: (e) => { r.states = { ...(r.states ?? {}) }; if (e.target.value) r.states[s.value] = e.target.value; else delete r.states[s.value]; },
      })));
    } else if (r.type === 'range') {
      body = [n('criticalLow', 'วิกฤตล่าง ≤'), n('warningLow', 'เตือนล่าง ≤'), n('warningHigh', 'เตือนบน ≥'), n('criticalHigh', 'วิกฤตบน ≥'), n('hysteresis', 'ฮิสเทอรีซิส')];
    } else {
      const op = r.type === 'high' ? '≥' : '≤';
      body = [n('warning', `เตือน ${op}`), n('critical', `วิกฤต ${op}`), n('hysteresis', 'ฮิสเทอรีซิส')];
    }
    return h('div.rule-row',
      h('span.sample-tag', 'เกณฑ์ตัวอย่าง — รออนุมัติสำหรับอุปกรณ์จริง'),
      h('div.grid-form',
        field('รหัสกฎ', h('input', { type: 'text', value: r.id, oninput: (e) => { r.id = e.target.value; } })),
        field('ค่าวัด', select(metricOpts, r.metricId, {
          onchange: (e) => { r.metricId = e.target.value; const mm = draft.metrics.find((x) => x.id === r.metricId); r.type = mm?.kind === 'discrete' ? 'discrete' : (r.type === 'discrete' ? 'high' : r.type); redraw(); },
        })),
        field('ชนิดกฎ', select(types, r.type, { onchange: (e) => { r.type = e.target.value; redraw(); } })),
        body,
        field('เวลาคงค่า (วินาที)', h('input', { type: 'number', min: 0, step: 1, value: r.dwellSec, oninput: (e) => { r.dwellSec = num(e.target.value); } })),
        h('label.check', h('input', { type: 'checkbox', checked: r.enabled, onchange: (e) => { r.enabled = e.target.checked; } }), 'เปิดใช้'),
      ),
      h('button.btn.small.ghost', { type: 'button', onclick: () => { rules.splice(i, 1); redraw(); } }, 'ลบกฎนี้'));
  });
  return h('fieldset', h('legend', 'เกณฑ์แจ้งเตือน'),
    h('p.hint', 'ค่าเท่ากับขีดพอดีถือว่าถึงขีด · การกลับสู่ปกติต้องพ้นขีดไปอีกเท่าค่าฮิสเทอรีซิส · เวลาคงค่า = ต้องเกินขีดต่อเนื่องด้วยค่าที่ถูกต้องนานเท่านี้ก่อนแจ้ง · เปลี่ยนเกณฑ์แล้วมีผลทันทีกับค่าที่สดใหม่อยู่ แต่กราฟประวัติจะเปลี่ยนเมื่อมีค่าใหม่เท่านั้น'),
    rows.length ? rows : h('p.muted', 'ยังไม่มีเกณฑ์'),
    h('button.btn.small', {
      type: 'button',
      onclick: () => {
        const m = draft.metrics[0];
        const ids = new Set(rules.map((r) => r.id));
        let k = rules.length + 1;
        while (ids.has(`${draft.id}-R${k}`)) k++;
        rules.push(m.kind === 'discrete'
          ? { id: `${draft.id}-R${k}`, pointId: draft.id, metricId: m.id, type: 'discrete', states: {}, enabled: true, sampleSetting: true, hysteresis: 0, dwellSec: 0 }
          : { id: `${draft.id}-R${k}`, pointId: draft.id, metricId: m.id, type: 'high', warning: 0, critical: 0, hysteresis: 0, dwellSec: 60, enabled: true, sampleSetting: true });
        redraw();
      },
    }, '+ เพิ่มเกณฑ์'));
}

function rulesOverview(app) {
  const rows = app.config.rules.map((r) => {
    const p = app.index.points.get(r.pointId);
    const m = app.index.metric(r.pointId, r.metricId);
    return h('tr', h('td.mono', r.id), h('td', `${r.pointId} ${p?.name ?? ''}`), h('td', m?.name ?? r.metricId), h('td', RULE_TYPES[r.type]), h('td', ruleText(r, m)));
  });
  return h('section.card',
    h('details', h('summary', h('strong', `เกณฑ์แจ้งเตือนทั้งหมด (${app.config.rules.length})`), ' — ค่าตัวอย่าง ต้องอนุมัติก่อนใช้กับอุปกรณ์จริง'),
      h('div.table-scroll', h('table.compact', h('thead', h('tr', h('th', 'รหัส'), h('th', 'จุด'), h('th', 'ค่าวัด'), h('th', 'ชนิด'), h('th', 'เกณฑ์'))), h('tbody', rows))),
      h('p.hint', 'แก้ไขเกณฑ์ได้จากปุ่ม "แก้ไข" ของแต่ละจุด')));
}

// --------------------------------------------------------------- เก็บข้อมูล/สำรอง
function storageSection(app) {
  const ctl = app.ctl;
  const ret = ctl.settings.retention;
  const days = h('input', { type: 'number', min: 1, max: 30, step: 1, value: ret.maxDays });
  const max = h('input', { type: 'number', min: 1000, max: 500000, step: 1000, value: ret.maxSamples });
  const retMsg = h('p.form-msg', { role: 'status' });
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json' });
  const preview = h('div.import-preview', { 'aria-live': 'polite' });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) { replaceChildren(preview, h('p.notice.error', 'ไฟล์ใหญ่เกิน 200 MB')); return; }
    const res = ctl.previewImport(await f.text());
    if (!res.ok) {
      replaceChildren(preview, h('div.notice.error', h('strong', 'ไฟล์ไม่ผ่านการตรวจ — ไม่มีการเปลี่ยนแปลงข้อมูล'), h('ul', res.errors.slice(0, 15).map((e) => h('li', e)))));
      return;
    }
    const s = res.summary;
    const cur = { points: app.config.points.length };
    replaceChildren(preview, h('div.notice.warn',
      h('strong', 'ตรวจไฟล์ผ่านแล้ว — ตรวจสอบก่อนยืนยัน'),
      h('ul',
        h('li', `ส่งออกเมื่อ ${s.exportedAt}`),
        h('li', `จุด ${s.points} (ติดตาม ${s.activePoints}) — ปัจจุบัน ${cur.points}`),
        h('li', `เกณฑ์ ${s.rules} · ค่าวัด ${s.samples.toLocaleString('th-TH')} (จำลอง ${s.perSource.demo.toLocaleString('th-TH')}, API ${s.perSource.api.toLocaleString('th-TH')}) · เหตุการณ์ ${s.episodes}`),
        s.observedRange ? h('li', `ช่วงเวลาสังเกต ${fmtDateTime(s.observedRange[0])} – ${fmtDateTime(s.observedRange[1])} (คงเวลาเดิม ความสดใหม่คำนวณใหม่)`) : null),
      h('p', 'การนำเข้าจะ "แทนที่" การตั้งค่า ประวัติ และการแจ้งเตือนทั้งหมดในอุปกรณ์นี้ ถ้าล้มเหลวกลางทาง ข้อมูลเดิมยังอยู่ครบ'),
      h('button.btn.danger', {
        type: 'button',
        onclick: async (e) => {
          e.target.disabled = true;
          // ผลลัพธ์แสดงในแถบแจ้งเตือนด้านบน (หน้าตั้งค่าจะถูกวาดใหม่หลังนำเข้า)
          await ctl.confirmImport(res.data);
          app.editDraft = null;
          app.render();
          app.noticeEl?.scrollIntoView?.({ block: 'nearest' });
        },
      }, 'ยืนยัน: แทนที่ข้อมูลทั้งหมดในอุปกรณ์นี้'),
      h('button.btn.ghost', { type: 'button', onclick: () => { fileIn.value = ''; preview.replaceChildren(); } }, 'ยกเลิก')));
  });

  return h('section.card',
    h('h3', 'การเก็บข้อมูลและสำรองข้อมูล'),
    h('p.hint', 'ข้อมูลเก็บใน IndexedDB ของเบราว์เซอร์นี้เท่านั้น — ไม่ซิงก์ระหว่างเครื่อง/ผู้ใช้ และหายเมื่อล้างข้อมูลเว็บไซต์ ควรสำรองเป็นไฟล์เป็นระยะ'),
    h('div.row',
      field('เก็บย้อนหลัง (วัน)', days),
      field('จำนวนค่าวัดสูงสุด', max),
      h('button.btn', {
        type: 'button',
        onclick: async () => {
          const d = num(days.value); const m = num(max.value);
          if (!(d >= 1 && d <= 30) || !(m >= 1000 && m <= 500000)) { retMsg.textContent = 'ช่วงที่อนุญาต: 1–30 วัน และ 1,000–500,000 ค่า'; return; }
          const r = await ctl.saveSettings({ retention: { maxDays: d, maxSamples: m } });
          if (ctl.engine) ctl.engine.retention = ctl.settings.retention;
          retMsg.textContent = r.ok ? 'บันทึกนโยบายในอุปกรณ์นี้แล้ว (มีผลในรอบล้างข้อมูลถัดไป)' : `บันทึกไม่สำเร็จ: ${r.error}`;
        },
      }, 'บันทึกนโยบาย')),
    retMsg,
    h('div.btn-row',
      h('button.btn.primary', {
        type: 'button',
        onclick: async () => {
          const b = await ctl.exportBackup();
          download(`iot-fortune-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, JSON.stringify(b));
        },
      }, 'ส่งออกสำรอง (JSON)'),
      field('นำเข้าสำรอง (JSON)', fileIn)),
    preview,
    h('details', h('summary', 'คืนค่าการตั้งค่าจุดเริ่มต้น'),
      h('p.hint', 'แทนที่การตั้งค่าจุดและเกณฑ์ด้วยค่าตัวอย่างเริ่มต้น (ประวัติไม่ถูกลบ)'),
      h('button.btn.danger', {
        type: 'button',
        onclick: async () => {
          if (!confirm('คืนค่าการตั้งค่าจุดและเกณฑ์เป็นค่าเริ่มต้น?')) return;
          // จุดที่ผู้ใช้เพิ่มเองถูกเก็บถาวรไว้ เพื่อให้ประวัติยังอ้างอิงได้
          const def = createDefaultConfig();
          const ids = new Set(def.points.map((p) => p.id));
          for (const p of app.config.points) if (!ids.has(p.id)) def.points.push({ ...structuredClone(p), status: 'archived' });
          const r = await ctl.saveConfig(def);
          if (!r.ok) alert(r.errors.join('\n'));
          app.editDraft = null; app.render();
        },
      }, 'คืนค่าเริ่มต้น')),
    h('p', h('a', { href: 'materials.html' }, 'แหล่งที่มา สัญญาอนุญาต และข้อจำกัดของต้นแบบ →')));
}
