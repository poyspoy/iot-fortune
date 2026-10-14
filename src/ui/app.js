import { h, select, replaceChildren } from './dom.js';
import { sevBadge, qualBadge, sourceBadge, systemLabel, valueText, ruleText, reasonText } from './format.js';
import { renderPlan } from './plan2d.js';
import { renderMetricChart } from './chart.js';
import { SEVERITY, QUALITY, SYSTEMS, SOURCE_LABEL, severityRank } from '../domain/constants.js';
import { fmtDateTime, fmtClock } from '../domain/time.js';
import { ageText } from '../domain/quality.js';
import { isEpisodeActive, isEpisodeAcknowledged, isEpisodeUnresolved } from '../domain/alarms.js';
import { SCENARIOS, SPEEDS } from '../adapters/demoAdapter.js';
import { renderAlertsView, episodeCard } from './alertsView.js';
import { renderHistoryView } from './historyView.js';
import { renderSettingsView } from './settingsView.js';
import { Sound } from './sound.js';
import { viewingFloorId, normalizeViewState } from '../domain/viewState.js';

const VIEWS = [
  ['overview', 'ภาพรวม'],
  ['points', 'จุดตรวจวัด'],
  ['alerts', 'แจ้งเตือน'],
  ['history', 'ประวัติข้อมูล'],
  ['settings', 'ตั้งค่าจุด'],
];
const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };

export class App {
  constructor(root, ctl) {
    this.root = root;
    this.ctl = ctl;
    const ui = ctl.ui ?? {};
    this.state = {
      view: VIEWS.some(([v]) => v === ui.view) ? ui.view : 'overview',
      selectedId: ui.selectedId ?? null,
      floorId: ui.floorId ?? 'G',
      isolated: ui.isolated ?? false, // true = แยกดูชั้นเดี่ยวในโมเดล 3D
      viewMode: ui.viewMode ?? '3d',
      sceneMode: ui.sceneMode ?? 'exterior',
      layers: { electrical: true, hvac: true, water: true, environment: true, ...(ui.layers ?? {}) },
      filters: { search: '', floor: '', area: '', system: '', severity: '', quality: '', attention: false, ...(ui.filters ?? {}) },
      detailsOpen: matchMedia('(max-width: 760px)').matches ? false : (ui.detailsOpen ?? true),
      sceneOpen: ui.sceneOpen ?? !matchMedia('(max-width: 760px)').matches,
      trendRange: ui.trendRange ?? '1h',
      planZoom: 1,
      alertFilter: { state: 'unresolved', severity: '', source: '' },
      history: { pointId: null, range: '6h', source: '' },
      editing: null,
    };
    Object.assign(this.state, this.normalizeView(this.state)); // ค่าที่บันทึกไว้จากรอบก่อนอาจไม่สอดคล้องกัน
    this.sound = new Sound();
    this.scene = null;
    this.sceneError = null;
    this.trendSig = '';
    this.lastLive = 0;
    this.liveTimer = null;
    this.toasts = [];
  }

  async start() {
    this.#buildShell();
    this.ctl.on((e) => this.#onCtl(e));
    this.render();
    setInterval(() => this.#scheduleLive(), 1000);
  }

  // ------------------------------------------------------------------ helpers
  get config() { return this.ctl.config; }
  get engine() { return this.ctl.engine; }
  get index() { return this.ctl.index; }

  activePoints() { return this.config.points.filter((p) => p.status === 'active').sort((a, b) => a.id.localeCompare(b.id)); }
  numberOf(id) { const i = this.activePoints().findIndex((p) => p.id === id); return i < 0 ? null : i + 1; }
  floorName(id) { return this.index.floors.get(id)?.name ?? id; }
  areaName(id) { return this.index.areas.get(id)?.name ?? '—'; }

  status(point) {
    if (!this.engine) return { severity: 'normal', quality: 'nodata', attention: true };
    return this.engine.pointStatus(point);
  }

  items() {
    return this.activePoints().map((p, i) => {
      const st = this.status(p);
      return { point: p, number: i + 1, ...st, label: `${i + 1}. ${p.name} (${p.id}) — ${SEVERITY[st.severity].label} · ${QUALITY[st.quality].label}` };
    });
  }

  setState(patch, { render = true } = {}) {
    Object.assign(this.state, patch);
    const st = this.state;
    this.ctl.saveUi({ view: st.view, selectedId: st.selectedId, floorId: st.floorId, isolated: st.isolated, viewMode: st.viewMode, sceneMode: st.sceneMode, layers: st.layers, filters: st.filters, detailsOpen: st.detailsOpen, sceneOpen: st.sceneOpen, trendRange: st.trendRange });
    if (render) this.render();
  }

  // ================================================================== กติกาชั้น/การเลือก (แหล่งเดียว)
  // ทุกเส้นทาง (dropdown, ผัง 2D, หมุด 3D, ตาราง, แจ้งเตือน, toast, รีโหลด, เปลี่ยนการตั้งค่า) ผ่าน normalizeView/changeView
  //  1) มุมมองชั้นเดียว = แยกชั้นใน 3D หรือ ผัง 2D → "ชั้นที่กำลังดู" = floorId
  //  2) ถ้าจุดที่เลือกไม่อยู่บนชั้นที่กำลังดู ให้ล้างการเลือก (รายละเอียด กราฟ ไฮไลต์)
  //  3) จุดไม่ถูกย้าย/คัดลอกไปชั้นอื่น ชั้นของจุดมาจากการตั้งค่าเท่านั้น

  /** ชั้นที่กำลังดูแบบชั้นเดียว (null = ทั้งอาคาร) */
  viewingFloorId(st = this.state) { return viewingFloorId(st); }

  normalizeView(st) { return normalizeViewState(st, this.index, this.config.building.floors[0]?.id); }

  /** เปลี่ยนชั้น/มุมมอง/การเลือก แล้วซิงก์ทุกส่วนของหน้าจอให้ตรงกัน */
  changeView(patch, { full = false } = {}) {
    const prev = { ...this.state };
    const next = this.normalizeView({ ...prev, ...patch });
    this.setState(next, { render: false });
    const st = this.state;
    if (full || st.view !== prev.view || (st.view === 'overview' && st.viewMode !== prev.viewMode)) { this.render(); return; }
    if (st.view === 'overview') {
      const floorChanged = st.floorId !== prev.floorId || st.isolated !== prev.isolated;
      if (this.scene && st.viewMode === '3d') {
        if (st.isolated) { if (this.scene.isolated !== st.floorId) this.scene.isolate(st.floorId); }
        else { this.scene.setFloor(st.floorId); if (this.scene.isolated) this.scene.assemble(); }
        this.scene.setSelected(st.selectedId);
      }
      this.detailsEl?.parentElement?.classList.toggle('details-closed', !st.detailsOpen);
      if (floorChanged) {
        if (this.stageToolbar?.isConnected) this.#renderToolbar();
        if (st.viewMode !== '3d' || !this.scene) this.#mountViewport();
      }
      this.#updateSpatial();
      this.#renderFloorBanner();
      if (this.viewingFloorId() !== this.tableFloorKey) this.#renderPointTable(true); else this.#renderTableBody();
      this.#renderDetails(true);
      this.trendSig = ''; this.trendStruct = ''; this.#renderTrends();
    } else if (st.view === 'points') {
      this.detailsEl?.parentElement?.classList.toggle('details-closed', !st.detailsOpen);
      this.#renderTableBody();
      this.#renderDetails(true);
    } else {
      this.render();
    }
  }

  /** เลือกจุด: ถ้ากำลังดูชั้นเดียวและจุดอยู่ชั้นอื่น จะเปลี่ยนไปชั้นจริงของจุด (ไม่ย้ายจุด) */
  select(id, { zoom = false, fromList = false } = {}) {
    const p = this.index.points.get(id);
    if (!p || p.status !== 'active') return;
    this.changeView({ selectedId: id, detailsOpen: true, floorId: p.floorId });
    const st = this.state;
    if (st.view === 'overview' && this.scene && st.viewMode === '3d' && (zoom || !st.isolated)) this.scene.focusPoint(id);
    if (fromList && matchMedia('(min-width: 761px)').matches) this.detailsEl?.scrollIntoView?.({ block: 'nearest' });
  }

  /** แยกชั้นออกมาเป็นโมเดลเดี่ยว (ใช้กับทุกชั้น) */
  isolateFloor(floorId) {
    if (!this.index.floors.get(floorId)) return;
    this.changeView({ floorId, isolated: true });
  }

  /** กลับไปดูทั้งอาคาร: ประกอบชั้นกลับตำแหน่งเดิม */
  showBuilding() {
    this.changeView({ isolated: false });
  }

  /** สลับ 3D/2D: ผัง 2D ต้องมีชั้นเดียว — ใช้ชั้นของจุดที่เลือก (ถ้ามี) เพื่อไม่ให้การเลือกหลุดโดยไม่จำเป็น */
  setViewMode(mode) {
    const sel = this.state.selectedId ? this.index.points.get(this.state.selectedId) : null;
    const patch = { viewMode: mode };
    if (mode === '2d' && !this.viewingFloorId() && sel) patch.floorId = sel.floorId;
    this.changeView(patch);
  }

  /** เปิดชั้นจริงของจุด (จากการแจ้งเตือน/toast) แล้วเลือกและซูมไปที่จุด */
  openFloorFor(pointId) {
    const p = this.index.points.get(pointId);
    if (!p || p.status !== 'active') return;
    const viewMode = this.sceneError ? '2d' : '3d';
    this.changeView({
      view: 'overview', floorId: p.floorId, isolated: true, viewMode, selectedId: pointId, detailsOpen: true, sceneOpen: true,
      planZoom: viewMode === '2d' ? 2 : this.state.planZoom,
    }, { full: true });
    if (this.scene && viewMode === '3d') this.scene.focusPoint(pointId);
    requestAnimationFrame(() => this.viewport?.scrollIntoView?.({ block: 'nearest' }));
  }

  /** ป้าย "กำลังดู" บนพื้นที่แสดงผล */
  #renderFloorBanner() {
    const el = this.floorBannerEl;
    if (!el?.isConnected) return;
    const st = this.state;
    const is3d = st.viewMode === '3d' && this.scene;
    const f = this.index.floors.get(st.floorId);
    if (is3d && !st.isolated) {
      replaceChildren(el, h('strong.fb-title', { 'data-testid': 'viewing' }, 'กำลังดู: ทั้งอาคาร'), h('span.fb-meta', 'เลือกชั้นจากรายการเพื่อแยกดูเป็นโมเดลเดี่ยว'));
      return;
    }
    const pts = this.activePoints().filter((p) => p.floorId === st.floorId);
    replaceChildren(el,
      h('strong.fb-title', { 'data-testid': 'viewing' }, `กำลังดู: ${f?.name ?? st.floorId}`),
      f?.plan.shared ? h('span.fb-chip', f.plan.sharedLabel ?? 'ผังอ้างอิงร่วม') : null,
      h('span.fb-meta', pts.length ? `${pts.length} จุดตรวจวัดในชั้นนี้` : 'ยังไม่มีจุดตรวจวัดในชั้นนี้'),
      is3d ? h('button.btn.small.primary.fb-back', { type: 'button', 'data-focus-key': 'back-building', onclick: () => this.showBuilding() }, 'กลับไปดูทั้งอาคาร') : null);
  }

  // ------------------------------------------------------------------ โครง
  #buildShell() {
    this.headerEl = h('header.app-header');
    this.modebarEl = h('div.modebar', { role: 'region', 'aria-label': 'แหล่งข้อมูลและสถานะการเชื่อมต่อ' });
    this.noticeEl = h('div.notices', { 'aria-live': 'polite' });
    this.navEl = h('nav.app-nav', { 'aria-label': 'เมนูหลัก' });
    this.kpiEl = h('section.kpis', { 'aria-label': 'ตัวชี้วัดสรุป' });
    this.viewEl = h('main.view', { id: 'main' });
    this.toastEl = h('div.toasts', { role: 'status', 'aria-live': 'assertive' });
    this.sceneHost = h('div.scene-host');
    this.root.replaceChildren(
      h('a.skip', { href: '#main' }, 'ข้ามไปเนื้อหาหลัก'),
      this.headerEl, this.modebarEl, this.noticeEl, this.navEl, this.kpiEl, this.viewEl, this.toastEl,
    );
  }

  #onCtl(e) {
    if (e.type === 'engine' && (e.evt.type === 'data' || e.evt.type === 'config')) {
      const up = (e.evt.transitions ?? []).filter((t) => severityRank(t.to) > severityRank(t.from));
      if (up.length) this.#announce(up);
      this.#scheduleLive();
    } else if (e.type === 'source' || e.type === 'config') {
      this.trendSig = '';
      this.render();
    } else {
      this.#scheduleLive();
    }
  }

  #announce(transitions) {
    const crit = transitions.some((t) => t.to === 'critical');
    this.sound.play(crit ? 'critical' : 'warning');
    for (const t of transitions) {
      const rule = this.config.rules.find((r) => r.id === t.ruleId);
      const p = rule && this.index.points.get(rule.pointId);
      const m = rule && this.index.metric(rule.pointId, rule.metricId);
      if (!p) continue;
      this.#toast(`${t.from === 'normal' ? 'แจ้งเตือนใหม่' : 'ยกระดับ'}: ${this.numberOf(p.id)}. ${p.name} (${this.floorName(p.floorId)}) — ${m?.name ?? ''} ${SEVERITY[t.to].label}`, t.to, p.id);
    }
  }

  #toast(text, sev, pointId) {
    const el = h('div', { class: `toast sev-${sev}` },
      h('span', text),
      h('button.btn.small', { type: 'button', onclick: () => { el.remove(); this.openFloorFor(pointId); } }, 'เปิดชั้นที่เกิดเหตุ'),
      h('button.btn.small.ghost', { type: 'button', 'aria-label': 'ปิดข้อความ', onclick: () => el.remove() }, '×'));
    this.toastEl.prepend(el);
    while (this.toastEl.children.length > 4) this.toastEl.lastChild.remove();
    setTimeout(() => el.remove(), 15000);
  }

  /** คืน true เมื่อลายเซ็นของส่วนนั้นเปลี่ยน (ใช้เลี่ยงการวาด DOM ใหม่ที่ไม่จำเป็น ซึ่งทำให้คลิกหลุด) */
  gate(key, sig) {
    this.sigs ??= new Map();
    if (this.sigs.get(key) === sig) return false;
    this.sigs.set(key, sig);
    return true;
  }

  #scheduleLive() {
    if (this.liveTimer) return;
    const wait = Math.max(0, 450 - (Date.now() - this.lastLive));
    this.liveTimer = setTimeout(() => { this.liveTimer = null; this.lastLive = Date.now(); this.renderLive(); }, wait);
  }

  // ------------------------------------------------------------------ เรนเดอร์
  render() {
    Object.assign(this.state, this.normalizeView(this.state)); // เช่น หลังแก้การตั้งค่า/เก็บถาวรจุด
    this.sigs?.clear();
    this.#renderHeader();
    this.#renderModebar();
    this.#renderNotices();
    this.#renderNav();
    this.#renderKpis();
    const v = this.state.view;
    if (v !== 'overview' && this.sceneHost.isConnected) this.sceneHost.remove();
    if (v === 'overview') this.#renderOverview();
    else if (v === 'points') this.#renderPointsView();
    else if (v === 'alerts') renderAlertsView(this);
    else if (v === 'history') renderHistoryView(this);
    else if (v === 'settings') renderSettingsView(this);
  }

  /** อัปเดตเฉพาะส่วนที่เปลี่ยนตามข้อมูล (ไม่ทำลายฟอร์มที่กำลังพิมพ์) */
  renderLive() {
    this.#renderHeader();
    this.#renderModebar(true);
    this.#renderNotices();
    this.#renderKpis();
    if (this.engine && this.gate('nav', String(this.engine.kpis().unresolvedAlerts)) && !this.navEl.contains(document.activeElement)) this.#renderNav();
    const v = this.state.view;
    if (v === 'overview' || v === 'points') {
      this.#updateSpatial();
      this.#renderPointTable();
      this.#renderDetails();
      if (v === 'overview') this.#renderTrends();
    } else if (v === 'alerts') renderAlertsView(this, { live: true });
    else if (v === 'history') renderHistoryView(this, { live: true });
    else if (v === 'settings') renderSettingsView(this, { live: true });
  }

  #renderHeader() {
    const mode = this.ctl.mode;
    const now = this.ctl.now();
    const clockText = `${mode === 'demo' ? 'เวลาจำลอง ' : ''}${fmtClock(now)}`;
    if (!this.gate('header', `${mode}|${this.sound.enabled}`) && this.clockEl?.isConnected) {
      this.clockEl.textContent = clockText;
      return;
    }
    this.clockEl = h('span.clock', { title: mode === 'demo' ? 'เวลาจำลองของเดโม' : 'เวลาปัจจุบัน (เวลาไทย)' }, clockText);
    replaceChildren(this.headerEl,
      h('div.brand', h('span.brand-mark', 'NEXZA'), h('span.brand-sep', { 'aria-hidden': 'true' }, '|'), h('span.brand-sub', 'FORTUNE IoT')),
      h('div.titles', h('h1', 'IoT ฟอร์จูน'), h('p.subtitle', 'ติดตามระบบอาคารตามจุด')),
      h('div.header-status',
        sourceBadge(mode),
        this.clockEl,
        h('button', {
          type: 'button', class: `btn small sound ${this.sound.enabled ? 'on' : ''}`, 'aria-pressed': String(this.sound.enabled), 'data-focus-key': 'sound',
          title: 'เสียงแจ้งเตือนในแอป (ทำงานเฉพาะขณะเปิดหน้านี้อยู่) การปิดเสียงไม่ซ่อนการแจ้งเตือน',
          onclick: () => { this.sound.toggle(); this.#renderHeader(); },
        }, this.sound.enabled ? '🔔 เสียงเตือน: เปิด' : '🔕 เสียงเตือน: ปิด'),
      ),
    );
  }

  #renderModebar(live = false) {
    const ctl = this.ctl;
    if (live && this.modebarEl.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    if (ctl.mode === 'demo') {
      const d = ctl.settings.demo;
      const volatile = `เริ่มสถานการณ์ ${d.scenarioStartedAt ? fmtClock(d.scenarioStartedAt) : '—'} · เวลาจำลอง ${fmtDateTime(ctl.now())}`;
      if (!this.gate('modebar', JSON.stringify(['demo', d.scenario, d.speed, d.lossPointId, d.scenarioStartedAt, this.config.points.length])) && this.modeVolatile?.isConnected) {
        this.modeVolatile.textContent = volatile;
        return;
      }
      this.modeVolatile = h('span.mode-meta', volatile);
      const lossOpts = this.activePoints().map((p) => [p.id, `${p.id} ${p.name}`]);
      replaceChildren(this.modebarEl,
        h('strong.mode-title', 'ข้อมูลจำลอง'),
        h('span.mode-note', 'ค่าทั้งหมดสร้างขึ้นในเบราว์เซอร์ ไม่ใช่ข้อมูลจริงของฟอร์จูน'),
        h('label.inline', h('span', 'สถานการณ์'), select(Object.entries(SCENARIOS), d.scenario, {
          'data-focus-key': 'scenario', onchange: (e) => ctl.setDemoParams({ scenario: e.target.value }),
        })),
        d.scenario === 'device-loss' ? h('label.inline', h('span', 'อุปกรณ์ที่ขาดการติดต่อ'), select(lossOpts, d.lossPointId, {
          'data-focus-key': 'loss', onchange: (e) => ctl.setDemoParams({ lossPointId: e.target.value, scenario: 'device-loss' }),
        })) : null,
        h('div.speed', { role: 'group', 'aria-label': 'ความเร็วการจำลอง' }, h('span', 'ความเร็วจำลอง'),
          SPEEDS.map((sp) => h('button', { type: 'button', class: `btn small ${d.speed === sp ? 'active' : ''}`, 'aria-pressed': String(d.speed === sp), 'data-focus-key': `speed-${sp}`, onclick: () => ctl.setDemoParams({ speed: sp }) }, `${sp}×`))),
        this.modeVolatile,
        h('button.btn.small.danger', {
          type: 'button', 'data-focus-key': 'reset-demo',
          onclick: async () => { if (confirm('ล้างประวัติและการแจ้งเตือนของข้อมูลจำลองทั้งหมด? (ข้อมูลจาก API ไม่ถูกแตะต้อง)')) await ctl.resetDemo(); },
        }, 'รีเซ็ตข้อมูลจำลอง'),
      );
    } else {
      const c = ctl.connection ?? { state: 'connecting' };
      const label = { idle: 'รอเริ่ม', connecting: 'กำลังเชื่อมต่อ', ok: 'poll สำเร็จ', retrying: 'เชื่อมต่อไม่ได้ — จะลองใหม่', unconfigured: 'ยังไม่ได้ตั้งค่า', stopped: 'หยุด' }[c.state] ?? c.state;
      const next = c.nextAt ? Math.max(0, Math.round((c.nextAt - Date.now()) / 1000)) : null;
      const volatile = next !== null && c.state !== 'unconfigured' ? `${c.state === 'retrying' ? `ลองใหม่ครั้งที่ ${c.failures} ใน` : 'poll ถัดไปใน'} ${next} วินาที` : '';
      if (!this.gate('modebar', JSON.stringify(['api', c.state, c.lastSuccessAt, c.lastFailureAt, c.lastError, c.failures, ctl.settings.api.url])) && this.modeVolatile?.isConnected) {
        this.modeVolatile.textContent = volatile;
        return;
      }
      this.modeVolatile = h('span.mode-meta', volatile);
      replaceChildren(this.modebarEl,
        h('strong.mode-title', 'ข้อมูลจาก API'),
        h('span', { class: `conn conn-${c.state}` }, `การเชื่อมต่อ: ${label}`),
        h('span.mode-meta', ctl.settings.api.url || 'ยังไม่ได้ระบุ URL'),
        h('span.mode-meta', `สำเร็จล่าสุด ${fmtClock(c.lastSuccessAt)} · ล้มเหลวล่าสุด ${fmtClock(c.lastFailureAt)}`),
        c.lastError ? h('span.mode-error', c.lastError) : null,
        this.modeVolatile,
        h('span.mode-note', 'สถานะการเชื่อมต่อแยกจากความสดของข้อมูลเซนเซอร์ — poll สำเร็จไม่ได้แปลว่าค่าวัดใหม่'),
        c.state === 'unconfigured' ? h('button.btn.small', { type: 'button', onclick: () => this.setState({ view: 'settings' }) }, 'ตั้งค่า API') : null,
      );
    }
  }

  #renderNotices() {
    const out = [];
    const ctl = this.ctl;
    if (ctl.configWarning) out.push(h('div.notice.warn', ctl.configWarning));
    const se = this.engine?.lastSaveError;
    if (se) out.push(h('div.notice.error', `${se.quota ? 'พื้นที่จัดเก็บเต็ม' : 'บันทึกข้อมูลไม่สำเร็จ'}: ${se.message} — ค่าที่แสดงล่าสุดอาจไม่ได้ถูกบันทึกในอุปกรณ์นี้`));
    const n = ctl.storageNotice;
    if (n && Date.now() - n.at < 8000) out.push(h('div', { class: `notice ${n.ok ? 'ok' : 'error'}` }, n.text));
    if (!this.gate('notices', out.map((x) => x.className + x.textContent).join('|'))) return;
    replaceChildren(this.noticeEl, out);
  }

  #renderNav() {
    const unresolved = this.engine ? this.engine.kpis().unresolvedAlerts : 0;
    replaceChildren(this.navEl, VIEWS.map(([id, label]) => h('button', {
      type: 'button', class: `nav-btn ${this.state.view === id ? 'active' : ''}`, 'aria-current': this.state.view === id ? 'page' : null,
      'data-focus-key': `nav-${id}`, onclick: () => this.setState({ view: id }),
    }, label, id === 'alerts' && unresolved ? h('span.count', { 'aria-label': `${unresolved} เหตุการณ์ยังไม่ปิด` }, String(unresolved)) : null)));
  }

  #renderKpis() {
    if (!this.engine) return;
    const k = this.engine.kpis();
    if (!this.gate('kpis', JSON.stringify(k))) return;
    const card = (key, n, label, def, onclick, tone = '') => h('button', {
      type: 'button', class: `kpi ${tone}`, 'data-focus-key': `kpi-${key}`, onclick, title: def,
    }, h('span.kpi-n', String(n)), h('span.kpi-label', label), h('span.kpi-def', def));
    replaceChildren(this.kpiEl,
      card('active', k.activePoints, 'จุดที่ติดตาม', 'นับจุดที่ใช้งาน (ไม่รวมจุดเก็บถาวร)', () => this.#drill({})),
      card('attention', k.attentionPoints, 'จุดที่ต้องดูแล', 'จุดที่มีการแจ้งเตือนเกิดอยู่ หรือค่าวัดใดไม่สดใหม่ (นับจุดละ 1)', () => this.#drill({ attention: true }), k.attentionPoints ? 'tone-warn' : ''),
      card('critical', k.criticalPoints, 'จุดวิกฤต', 'จุดที่มีการแจ้งเตือนระดับวิกฤตกำลังเกิดอยู่', () => this.#drill({ severity: 'critical' }), k.criticalPoints ? 'tone-crit' : ''),
      card('stale', k.notFreshPoints, 'จุดที่ข้อมูลไม่สดใหม่', 'จุดที่มีค่าวัดอย่างน้อยหนึ่งค่า เก่า/ไม่มี/ไม่ถูกต้อง', () => this.#drill({ quality: 'notfresh' }), k.notFreshPoints ? 'tone-grey' : ''),
      card('alerts', k.unresolvedAlerts, 'แจ้งเตือนยังไม่ปิด', `เหตุการณ์ระดับค่าวัดที่ยังเกิดอยู่หรือยังไม่รับทราบ (กำลังเกิด ${k.activeAlerts})`, () => this.setState({ view: 'alerts', alertFilter: { ...this.state.alertFilter, state: 'unresolved' } }), k.unresolvedAlerts ? 'tone-warn' : ''),
    );
  }

  #drill(f) {
    this.setState({ view: 'points', filters: { search: '', floor: '', area: '', system: '', severity: '', quality: '', attention: false, ...f } });
  }

  // ------------------------------------------------------------------ ภาพรวม
  #renderOverview() {
    const st = this.state;
    const stage = h('section.stage', { 'aria-label': 'มุมมองอาคาร' });
    this.stageToolbar = h('div.toolbar');
    this.viewport = h('div.viewport');
    this.legendEl = h('p.legend');
    stage.append(this.stageToolbar,
      h('details.scene-toggle', { open: st.sceneOpen, ontoggle: (e) => { if (e.target.open !== st.sceneOpen) this.setState({ sceneOpen: e.target.open }, { render: false }); } },
        h('summary', st.viewMode === '3d' ? 'แสดง/ซ่อนโมเดลอาคาร' : 'แสดง/ซ่อนผังชั้น'), this.viewport),
      this.legendEl);
    this.detailsEl = h('aside.details', { 'aria-label': 'รายละเอียดจุดที่เลือก' });
    this.trendsEl = h('section.trends', { 'aria-label': 'แนวโน้มของจุดที่เลือก' });
    this.tableHost = h('section.table-card', { 'aria-label': 'รายการจุด' });
    const layout = h('div', { class: `overview ${st.detailsOpen ? '' : 'details-closed'}` }, stage, this.detailsEl, h('div.below', this.trendsEl, this.tableHost));
    replaceChildren(this.viewEl, layout);
    this.#renderToolbar();
    this.#mountViewport();
    this.#renderDetails(true);
    this.#renderPointTable(true);
    this.trendSig = '';
    this.#renderTrends();
  }

  #renderToolbar() {
    const st = this.state;
    const floors = this.config.building.floors;
    const presets = this.scene ? this.scene.availablePresets() : [];
    const PRESET = { fit: 'พอดีทั้งชั้น', all: 'ทั้งอาคาร', floor: 'แยกชั้นที่เลือก', plant: 'ห้องเครื่อง', roof: 'ดาดฟ้า', underfloor: 'ระบบใต้พื้น', top: 'มุมบน' };
    const is3d = st.viewMode === '3d' && this.scene;
    const floorValue = is3d && !st.isolated ? '' : st.floorId;
    const opt = (f) => h('option', { value: f.id, selected: f.id === floorValue, text: f.plan.shared ? `${f.name} — ${f.plan.sharedLabel ?? 'ผังอ้างอิงร่วม'}` : f.name });
    const floorSel = h('select', {
      'data-focus-key': 'floor', 'aria-label': 'เลือกชั้นเพื่อแยกดู',
      onchange: (e) => { if (e.target.value === '') this.showBuilding(); else this.isolateFloor(e.target.value); },
    },
    is3d ? h('option', { value: '', selected: floorValue === '', text: 'ทั้งอาคาร (ประกอบทุกชั้น)' }) : null,
    h('optgroup', { label: 'ห้าง (โพเดียม)' }, floors.filter((f) => f.kind !== 'tower').map(opt)),
    floors.some((f) => f.kind === 'tower') ? h('optgroup', { label: 'สำนักงาน ชั้น 11–31 (ผังอ้างอิงร่วม ข้อมูลแยกรายชั้น)' }, floors.filter((f) => f.kind === 'tower').map(opt)) : null);
    replaceChildren(this.stageToolbar,
      h('div.seg', { role: 'group', 'aria-label': 'ชนิดมุมมอง' },
        ['3d', '2d'].map((m) => h('button', { type: 'button', class: `btn small ${st.viewMode === m ? 'active' : ''}`, 'aria-pressed': String(st.viewMode === m), 'data-focus-key': `vm-${m}`,
          disabled: m === '3d' && this.sceneError ? true : null,
          onclick: () => this.setViewMode(m) }, m === '3d' ? 'โมเดล 3D' : 'ผัง 2D'))),
      h('label.inline', h('span', 'ชั้น'), floorSel),
      is3d && st.isolated ? h('button.btn.small', { type: 'button', 'data-focus-key': 'back-building-tb', onclick: () => this.showBuilding() }, 'กลับไปดูทั้งอาคาร') : null,
      st.viewMode === '2d' ? h('div.seg', { role: 'group', 'aria-label': 'ขยายผัง' }, [1, 2, 3].map((z) => h('button', {
        type: 'button', class: `btn small ${st.planZoom === z ? 'active' : ''}`, 'aria-pressed': String(st.planZoom === z), 'data-focus-key': `zoom-${z}`,
        onclick: () => { this.state.planZoom = z; this.#renderToolbar(); this.sigs?.delete('plan'); this.#updateSpatial(); },
      }, `ขยาย ${z}×`))) : null,
      st.viewMode === '3d' && this.scene ? h('div.seg', { role: 'group', 'aria-label': 'มุมกล้อง' },
        presets.map((p) => h('button', { type: 'button', class: 'btn small ghost', 'data-focus-key': `preset-${p}`, onclick: () => (p === 'floor' ? this.isolateFloor(st.floorId) : this.scene.preset(p)) }, PRESET[p]))) : null,
      st.viewMode === '3d' && this.scene && !st.isolated ? h('label.inline', h('span', 'การแสดงผล'), select([['exterior', 'ภายนอก'], ['cutaway', 'ตัดชั้นบน'], ['exploded', 'แยกชั้น']], st.sceneMode, {
        'data-focus-key': 'scenemode', onchange: (e) => { this.setState({ sceneMode: e.target.value }, { render: false }); this.scene.setMode(e.target.value); },
      })) : null,
      h('fieldset.layers', h('legend', 'ชั้นข้อมูล'),
        Object.entries(SYSTEMS).map(([k, v]) => h('label.check', h('input', {
          type: 'checkbox', checked: st.layers[k], 'data-focus-key': `layer-${k}`,
          onchange: (e) => { this.setState({ layers: { ...st.layers, [k]: e.target.checked } }, { render: false }); this.#updateSpatial(); },
        }), v.label))),
    );
  }

  #mountViewport() {
    const st = this.state;
    const note = this.config.building.referenceNote;
    this.viewport.classList.toggle('mode-2d', st.viewMode !== '3d' || !!this.sceneError);
    if (st.viewMode === '3d' && !this.sceneError) {
      this.floorBannerEl = h('div.floor-banner', { 'aria-live': 'polite' });
      this.viewport.replaceChildren(this.sceneHost, this.floorBannerEl, h('div.ref-badge', note));
      if (!this.scene) {
        try {
          const { MallScene, webglAvailable } = this.sceneModule;
          if (!webglAvailable()) throw new Error('เบราว์เซอร์/อุปกรณ์นี้ไม่รองรับ WebGL');
          this.scene = new MallScene(this.sceneHost, { onSelect: (id) => this.select(id, { focus: false }) });
          this.scene.setConfig(this.config);
          this.scene.setFloor(st.floorId);
          this.scene.setMode(st.sceneMode);
          this.scene.setLayers(st.layers);
          if (st.isolated) this.scene.isolate(st.floorId, { instant: true });
          else this.scene.preset('all', { instant: true });
          this.#renderToolbar();
        } catch (e) {
          this.sceneError = e.message;
          this.scene = null;
          this.state.viewMode = '2d';
          return this.#mountViewport();
        }
      } else {
        if (this.sceneConfig !== this.config) this.scene.setConfig(this.config);
        // ซิงก์สถานะชั้นเดี่ยว/ทั้งอาคารกับฉากที่มีอยู่
        if (st.isolated && this.scene.isolated !== st.floorId) this.scene.isolate(st.floorId);
        else if (!st.isolated && this.scene.isolated) { this.scene.setFloor(st.floorId); this.scene.assemble(); }
        else this.scene.setFloor(st.floorId);
        this.#renderToolbar();
      }
      this.sceneConfig = this.config;
    } else {
      this.planHost = h('div.plan-host');
      this.sigs?.delete('plan');
      this.floorBannerEl = h('div.floor-banner.static', { 'aria-live': 'polite' });
      replaceChildren(this.viewport,
        this.sceneError ? h('p.notice.warn', `แสดงโมเดล 3D ไม่ได้ (${this.sceneError}) — ใช้ผัง 2D และรายการจุดได้ครบทุกฟังก์ชัน`) : null,
        this.floorBannerEl, this.planHost, h('div.ref-badge', this.index.floors.get(st.floorId)?.plan.note ?? ''));
    }
    this.#updateSpatial();
    this.#renderFloorBanner();
  }

  #updateSpatial() {
    if (this.state.view !== 'overview') return;
    const items = this.items();
    const st = this.state;
    if (st.viewMode === '3d' && this.scene) {
      this.scene.setPoints(items);
      this.scene.setSelected(st.selectedId);
      this.scene.setLayers(st.layers);
      const tank = this.#freshValue('P-002', 'level');
      const run = this.#freshValue('P-003', 'run');
      this.scene.setDynamic({ tankLevel: tank, pumpRunning: run === null ? null : run === 'run' });
      this.legendEl.textContent = `สีหมุด: เขียว = ปกติ, เหลือง = เฝ้าระวัง, แดง = วิกฤต, เทา = ข้อมูลไม่สดใหม่/ไม่ทราบ · ลากเพื่อหมุน เลื่อนล้อ/ถ่างนิ้วเพื่อซูม คลิกหมุดเพื่อเลือก${st.isolated ? ' · มุมมองชั้นเดี่ยว: หมุดอยู่ตำแหน่งเดิมเมื่อเทียบกับผัง' : ''} · ระดับน้ำในถังและใบพัดปั๊มเคลื่อนไหวตามค่าที่ได้รับและยังสดใหม่เท่านั้น ไม่ใช่การยืนยันสภาพเครื่อง`;
    } else if (this.planHost) {
      const floor = this.index.floors.get(st.floorId);
      const onFloor = items.filter((it) => it.point.floorId === st.floorId && st.layers[it.point.system] !== false);
      const planSig = JSON.stringify([floor.id, st.selectedId, onFloor.map((it) => [it.point.id, it.severity, it.quality, it.point.plan.x, it.point.plan.y])]);
      if (!this.gate('plan', `${planSig}|${st.planZoom}`) && this.planHost.firstChild) return;
      const prevScroll = this.planHost.querySelector('.plan-wrap')?.scrollLeft ?? 0;
      replaceChildren(this.planHost, renderPlan({ floor, items: onFloor, selectedId: st.selectedId, zoom: st.planZoom, onSelect: (id) => this.select(id, { focus: false }) }));
      const wrap = this.planHost.querySelector('.plan-wrap');
      if (wrap) {
        wrap.scrollLeft = prevScroll;
        const sel = onFloor.find((it) => it.point.id === st.selectedId);
        if (sel && st.planZoom > 1 && this.planFocusId !== sel.point.id) {
          this.planFocusId = sel.point.id;
          requestAnimationFrame(() => { wrap.scrollLeft = sel.point.plan.x * wrap.scrollWidth - wrap.clientWidth / 2; });
        }
      }
      const off = items.filter((it) => it.point.floorId !== st.floorId).length;
      this.legendEl.textContent = `แสดง ${onFloor.length} จุดบน${floor.name} (อีก ${off} จุดอยู่ชั้นอื่น) · หมุดเข้าถึงด้วยแป้น Tab แล้วกด Enter · ${floor.plan.note}`;
    }
  }

  #freshValue(pointId, metricId) {
    if (!this.engine || !this.index.points.get(pointId)) return null;
    if (this.engine.quality(pointId, metricId) !== 'fresh') return null;
    return this.engine.entry(pointId, metricId)?.lastValid?.value ?? null;
  }

  // ------------------------------------------------------------------ ตารางจุด
  filteredItems() {
    const f = { ...this.state.filters };
    // ภาพรวม: รายการจุดตามชั้นที่กำลังดู (เมื่อดูชั้นเดียว)
    const vf = this.state.view === 'overview' ? this.viewingFloorId() : null;
    if (vf) { f.floor = vf; f.area = f.area && this.index.areas.get(f.area)?.floorId === vf ? f.area : ''; }
    const q = f.search.trim().toLowerCase();
    return this.items().filter((it) => {
      const p = it.point;
      if (q && !(`${p.id} ${p.name} ${p.equipmentId} ${this.floorName(p.floorId)} ${this.areaName(p.areaId)}`.toLowerCase().includes(q))) return false;
      if (f.floor && p.floorId !== f.floor) return false;
      if (f.area && p.areaId !== f.area) return false;
      if (f.system && p.system !== f.system) return false;
      if (f.severity && it.severity !== f.severity) return false;
      if (f.quality === 'notfresh' ? it.quality === 'fresh' : (f.quality && it.quality !== f.quality)) return false;
      if (f.attention && !it.attention) return false;
      return true;
    });
  }

  #renderPointTable(force = false) {
    if (!this.tableHost?.isConnected) return;
    const compact = this.state.view === 'overview';
    if (!force && this.tableBody?.isConnected) {
      this.#renderTableBody(compact);
      return;
    }
    const f = this.state.filters;
    const setF = (patch) => { this.setState({ filters: { ...f, ...patch } }, { render: false }); this.#renderPointTable(true); this.#updateSpatial(); };
    const floors = this.config.building.floors;
    const vf = this.state.view === 'overview' ? this.viewingFloorId() : null;
    this.tableFloorKey = this.viewingFloorId();
    const areas = this.config.building.areas.filter((a) => (vf ? a.floorId === vf : !f.floor || a.floorId === f.floor));
    const filters = h('div.filters', { role: 'search' },
      h('label.field.grow', h('span.field-label', 'ค้นหา'), h('input', { type: 'search', value: f.search, placeholder: 'รหัส ชื่อ ชั้น พื้นที่…', 'data-focus-key': 'f-search', oninput: (e) => { this.state.filters.search = e.target.value; this.#renderTableBody(compact); } })),
      vf ? h('label.field', h('span.field-label', 'ชั้น (ตามมุมมอง)'), h('span.static', { 'data-testid': 'table-floor' }, this.floorName(vf)))
        : h('label.field', h('span.field-label', 'ชั้น'), select([['', 'ทุกชั้น'], ...floors.map((x) => [x.id, x.name])], f.floor, { 'data-focus-key': 'f-floor', onchange: (e) => setF({ floor: e.target.value, area: '' }) })),
      h('label.field', h('span.field-label', 'พื้นที่'), select([['', 'ทุกพื้นที่'], ...areas.map((x) => [x.id, x.name])], f.area, { 'data-focus-key': 'f-area', onchange: (e) => setF({ area: e.target.value }) })),
      h('label.field', h('span.field-label', 'ระบบ'), select([['', 'ทุกระบบ'], ...Object.entries(SYSTEMS).map(([k, v]) => [k, v.label])], f.system, { 'data-focus-key': 'f-system', onchange: (e) => setF({ system: e.target.value }) })),
      h('label.field', h('span.field-label', 'ระดับ'), select([['', 'ทุกระดับ'], ...Object.entries(SEVERITY).map(([k, v]) => [k, v.label])], f.severity, { 'data-focus-key': 'f-sev', onchange: (e) => setF({ severity: e.target.value }) })),
      h('label.field', h('span.field-label', 'คุณภาพข้อมูล'), select([['', 'ทั้งหมด'], ['notfresh', 'ไม่สดใหม่ (ทุกแบบ)'], ...Object.entries(QUALITY).map(([k, v]) => [k, v.label])], f.quality, { 'data-focus-key': 'f-q', onchange: (e) => setF({ quality: e.target.value }) })),
      h('label.field', h('span.field-label', 'แหล่งข้อมูล'), h('span.static', SOURCE_LABEL[this.ctl.mode])),
      h('label.check', h('input', { type: 'checkbox', checked: f.attention, 'data-focus-key': 'f-att', onchange: (e) => setF({ attention: e.target.checked }) }), 'เฉพาะที่ต้องดูแล'),
    );
    this.tableBody = h('tbody');
    this.tableCount = h('p.table-count', { 'aria-live': 'polite' });
    const head = h('thead', h('tr',
      h('th', { scope: 'col' }, '#'), h('th', { scope: 'col' }, 'จุด'), h('th', { scope: 'col' }, 'ชั้น / พื้นที่'),
      h('th', { scope: 'col', class: 'hide-sm' }, 'ระบบ'), h('th', { scope: 'col' }, 'สถานะ'), h('th', { scope: 'col' }, 'ค่าล่าสุด'),
      h('th', { scope: 'col', class: 'hide-sm' }, 'อายุข้อมูล')));
    replaceChildren(this.tableHost,
      h('div.card-head', h('h2', compact ? 'จุดตรวจวัด' : 'รายการจุดตรวจวัด'), this.tableCount),
      filters,
      h('div.table-scroll', h('table.points-table', h('caption.sr-only', 'รายการจุด ใช้ Tab ไปที่แถวแล้วกด Enter เพื่อเลือก'), head, this.tableBody)),
    );
    this.#renderTableBody(compact);
  }

  /** แถวตารางแบบคงที่ (keyed): อัปเดตเซลล์เฉพาะเมื่อข้อมูลเปลี่ยน แถวเดิมไม่ถูกแทนที่ คลิก/โฟกัสจึงไม่หลุด */
  #renderTableBody() {
    if (!this.tableBody) return;
    const items = this.filteredItems();
    const now = this.ctl.now();
    this.tableCount.textContent = `แสดง ${items.length} จาก ${this.activePoints().length} จุด`;
    if (this.rowBody !== this.tableBody) { this.rowBody = this.tableBody; this.rows = new Map(); }
    const want = [];
    for (const it of items) {
      const p = it.point;
      const sel = p.id === this.state.selectedId;
      const vals = p.metrics.map((m) => {
        const e = this.engine?.entry(p.id, m.id);
        return e?.lastValid ? valueText(m, e.lastValid.value) : '—';
      }).join(' · ');
      const ages = p.metrics.map((m) => this.engine?.entry(p.id, m.id)?.lastValid?.observedAt).filter(Boolean);
      const oldest = ages.length ? Math.min(...ages) : null;
      let r = this.rows.get(p.id);
      if (!r) {
        const tr = h('tr', {
          tabindex: 0, 'data-focus-key': `row-${p.id}`,
          onclick: () => this.select(p.id, { fromList: true }),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(p.id, { fromList: true }); }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); (e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling)?.focus(); }
          },
        });
        r = { tr, sig: null, age: null };
        this.rows.set(p.id, r);
      }
      const sig = JSON.stringify([it.number, it.severity, it.quality, p.name, p.floorId, p.areaId, p.system, vals]);
      if (sig !== r.sig) {
        r.sig = sig;
        r.age = h('td.hide-sm');
        r.tr.replaceChildren(
          h('td', h('span', { class: `num sev-${it.severity} q-${it.quality}` }, String(it.number))),
          h('td', h('div.pname', p.name), h('div.pid', p.id)),
          h('td', h('div', this.floorName(p.floorId)), h('div.pid', this.areaName(p.areaId))),
          h('td.hide-sm', systemLabel(p.system)),
          h('td', h('div.badges', sevBadge(it.severity), qualBadge(it.quality))),
          h('td.vals', vals),
          r.age);
      }
      r.tr.className = `${sel ? 'selected' : ''} sev-row-${it.severity}`;
      r.tr.setAttribute('aria-selected', String(sel));
      const ageTxt = oldest ? ageText(now - oldest) : '—';
      if (r.age.textContent !== ageTxt) r.age.textContent = ageTxt;
      want.push(r.tr);
    }
    if (!items.length) want.push(this.emptyRow ??= h('tr', h('td', { colspan: 7, class: 'empty' }, 'ไม่พบจุดตามตัวกรอง')));
    // จัดลำดับโดยย้ายเฉพาะแถวที่ไม่อยู่ตำแหน่งเดิม
    want.forEach((tr, i) => { if (this.tableBody.children[i] !== tr) this.tableBody.insertBefore(tr, this.tableBody.children[i] ?? null); });
    while (this.tableBody.children.length > want.length) this.tableBody.lastElementChild.remove();
  }

  #renderPointsView() {
    this.detailsEl = h('aside.details', { 'aria-label': 'รายละเอียดจุดที่เลือก' });
    this.tableHost = h('section.table-card', { 'aria-label': 'รายการจุด' });
    replaceChildren(this.viewEl, h('div', { class: `points-layout ${this.state.detailsOpen ? '' : 'details-closed'}` }, this.tableHost, this.detailsEl));
    this.#renderPointTable(true);
    this.#renderDetails(true);
  }

  // ------------------------------------------------------------------ รายละเอียด
  #renderDetails(force = false) {
    const el = this.detailsEl;
    if (!el?.isConnected) return;
    const st = this.state;
    const p = st.selectedId ? this.index.points.get(st.selectedId) : null;
    el.classList.toggle('open', !!(p && st.detailsOpen));
    const epSig = p ? (this.engine?.episodes() ?? []).filter((e) => e.pointId === p.id).map((e) => `${e.id}:${e.severity}:${e.peakSeverity}:${e.recoveredAt}:${e.endedAt}:${e.acks.length}`).join(',') : '';
    const pst = p ? this.status(p) : null;
    const structural = this.gate('details', JSON.stringify([p?.id, st.detailsOpen, pst?.severity, pst?.quality, this.ctl.mode, epSig, this.viewingFloorId()]));
    if (!force && !structural) {
      const live = el.querySelector('.details-live');
      if (live && p) replaceChildren(live, this.#detailsLive(p));
      return;
    }
    if (!force && el.querySelector('form.ack-form') && (el.contains(document.activeElement) || [...el.querySelectorAll('form.ack-form textarea, form.ack-form input')].some((i) => i.value && i.defaultValue !== i.value))) {
      // มีฟอร์มรับทราบที่กำลังกรอก — อัปเดตเฉพาะส่วนค่าวัด
      const live = el.querySelector('.details-live');
      if (live && p) replaceChildren(live, this.#detailsLive(p));
      return;
    }
    if (!p) {
      const vf = this.state.view === 'overview' ? this.viewingFloorId() : null;
      const onFloor = vf ? this.activePoints().filter((x) => x.floorId === vf).length : null;
      replaceChildren(el, h('div.details-empty', { 'data-testid': 'details-empty' },
        h('h2', vf ? `รายละเอียดจุด — ${this.floorName(vf)}` : 'รายละเอียดจุด'),
        vf && onFloor === 0 ? h('p.empty-floor', 'ยังไม่มีจุดตรวจวัดในชั้นนี้')
          : h('p', vf ? `เลือกจุดบน${this.floorName(vf)}จากโมเดล ผัง หรือรายการ (${onFloor} จุด)` : 'เลือกจุดจากโมเดล ผัง หรือรายการ เพื่อดูค่าวัด ความสดของข้อมูล เกณฑ์ และการแจ้งเตือน')));
      return;
    }
    if (!st.detailsOpen) {
      replaceChildren(el, h('button.btn.small', { type: 'button', 'aria-expanded': 'false', onclick: () => this.setState({ detailsOpen: true }) }, 'แสดงรายละเอียด'));
      return;
    }
    const n = this.numberOf(p.id);
    const status = this.status(p);
    const f = this.index.floors.get(p.floorId);
    const episodes = (this.engine?.episodes() ?? []).filter((e) => e.pointId === p.id).sort((a, b) => b.openedAt - a.openedAt);
    const open = episodes.filter(isEpisodeUnresolved);
    const past = episodes.filter((e) => !isEpisodeUnresolved(e)).slice(0, 5);
    replaceChildren(el,
      h('div.details-head',
        h('span', { class: `num big sev-${status.severity} q-${status.quality}` }, n ? String(n) : '–'),
        h('div', h('h2', p.name), h('p.pid', `${p.id}${p.equipmentId ? ` · อุปกรณ์ ${p.equipmentId}` : ''}`)),
        h('button.btn.small.ghost.close', { type: 'button', 'aria-label': 'ซ่อนรายละเอียด', 'aria-expanded': 'true', onclick: () => this.setState({ detailsOpen: false }) }, '×')),
      h('div.badges', sevBadge(status.severity), qualBadge(status.quality), sourceBadge(this.ctl.mode)),
      p.status === 'archived' ? h('p.notice.warn', 'จุดนี้ถูกเก็บถาวร ไม่ได้ติดตามแล้ว') : null,
      p.example ? h('p.example-note', 'จุดตัวอย่าง — ไม่ใช่อุปกรณ์จริงที่ยืนยันแล้ว ตำแหน่งรอยืนยัน') : null,
      h('dl.meta',
        h('dt', 'ตำแหน่ง'), h('dd', `${f?.name ?? p.floorId} · ${this.areaName(p.areaId)}`),
        h('dt', 'ระบบ'), h('dd', systemLabel(p.system)),
        h('dt', 'แหล่งข้อมูล'), h('dd', `${SOURCE_LABEL[this.ctl.mode]}${this.ctl.mode === 'demo' ? ' (ไม่ใช่ข้อมูลจริง)' : ''} · รหัสต้นทาง ${p.sourceKey || p.id}`)),
      h('div.details-live', this.#detailsLive(p)),
      h('section.details-alerts',
        h('h3', 'การแจ้งเตือนในอุปกรณ์นี้'),
        open.length ? open.map((ep) => episodeCard(this, ep, { compact: true })) : h('p.muted', 'ไม่มีการแจ้งเตือนที่ยังไม่ปิด'),
        past.length ? h('details', h('summary', `ประวัติที่ปิดแล้ว (${past.length})`), past.map((ep) => episodeCard(this, ep, { compact: true, readonly: true }))) : null),
      h('div.details-actions',
        h('button.btn.small', { type: 'button', 'data-focus-key': 'open-floor-details', onclick: () => this.openFloorFor(p.id) }, `ดู${f?.name ?? 'ชั้นนี้'}แบบเดี่ยว`),
        h('button.btn.small', { type: 'button', onclick: () => this.setState({ view: 'history', history: { ...this.state.history, pointId: p.id } }) }, 'ดูประวัติข้อมูล'),
        h('button.btn.small.ghost', { type: 'button', onclick: () => this.setState({ view: 'settings', editing: p.id }) }, 'แก้ไขจุด/เกณฑ์')),
    );
  }

  #detailsLive(p) {
    const now = this.ctl.now();
    return p.metrics.map((m) => {
      const e = this.engine?.entry(p.id, m.id);
      const q = this.engine ? this.engine.quality(p.id, m.id) : 'nodata';
      const rules = this.config.rules.filter((r) => r.pointId === p.id && r.metricId === m.id);
      const lv = e?.lastValid;
      const pending = rules.map((r) => this.engine?.evaluator.pendingLevel(r.id)).find(Boolean);
      const sev = (this.engine?.activeEpisodesFor(p.id) ?? []).filter((x) => x.metricId === m.id).reduce((a, x) => (severityRank(x.severity) > severityRank(a) ? x.severity : a), 'normal');
      return h('div', { class: `metric-card sev-${sev} q-${q}` },
        h('div.metric-top', h('span.metric-name', m.name), h('div.badges', sevBadge(sev), qualBadge(q))),
        h('div.metric-value', lv ? valueText(m, lv.value) : 'ยังไม่มีข้อมูล', q !== 'fresh' && lv ? h('span.stale-tag', ' (ค่าล่าสุดที่ถูกต้อง)') : null),
        h('dl.meta.small',
          h('dt', 'เวลาสังเกต'), h('dd', lv ? `${fmtDateTime(lv.observedAt)} (${ageText(now - lv.observedAt)}ที่แล้ว)` : '—'),
          h('dt', 'เวลารับข้อมูล'), h('dd', lv ? fmtDateTime(lv.receivedAt) : '—'),
          h('dt', 'หมดอายุเมื่อ'), h('dd', `ไม่มีค่าใหม่เกิน ${m.staleAfterSec} วินาที`),
          h('dt', 'เกณฑ์'), h('dd', rules.length ? rules.map((r) => ruleText(r, m)).join(' / ') : 'ไม่ได้ตั้งเกณฑ์'),
          e?.lastRejectedAt ? [h('dt', 'ค่าที่ถูกปฏิเสธ'), h('dd.err', `${fmtClock(e.lastRejectedAt)} — ${reasonText(e.lastRejectReason)}`)] : null,
          pending ? [h('dt', 'กำลังนับเวลาคงค่า'), h('dd', `${SEVERITY[pending.level].label} ตั้งแต่ ${fmtClock(pending.since)}`)] : null),
        m.explain ? h('p.explain', m.explain) : null,
        rules.some((r) => r.sampleSetting) ? h('p.sample-tag', 'เกณฑ์ตัวอย่าง — รออนุมัติสำหรับอุปกรณ์จริง') : null,
      );
    });
  }

  // ------------------------------------------------------------------ แนวโน้ม
  async #renderTrends() {
    const el = this.trendsEl;
    if (!el?.isConnected || !this.engine) return;
    const p = this.state.selectedId ? this.index.points.get(this.state.selectedId) : null;
    const range = RANGES[this.state.trendRange];
    const now = this.ctl.now();
    const lastObs = p ? p.metrics.map((m) => this.engine.entry(p.id, m.id)?.lastValid?.observedAt ?? 0).join(',') : '';
    const sig = `${p?.id}|${this.state.trendRange}|${lastObs}|${Math.floor(now / 30000)}|${this.ctl.mode}|${this.config.rules.length}`;
    if (sig === this.trendSig) return;
    // ค่าใหม่เข้ามาถี่ (เดโมเร่งความเร็ว) — วาดกราฟใหม่ไม่เกินทุก 5 วินาที ยกเว้นเปลี่ยนจุด/ช่วงเวลา
    const structural = `${p?.id}|${this.state.trendRange}|${this.ctl.mode}|${this.config.rules.length}`;
    if (this.trendStruct === structural && Date.now() - (this.trendAt ?? 0) < 5000) return;
    if (el.querySelector('details.chart-table[open]') && this.trendStruct === structural && Date.now() - (this.trendAt ?? 0) < 30000) return;
    this.trendStruct = structural;
    this.trendAt = Date.now();
    this.trendSig = sig;
    const head = h('div.card-head', h('h2', p ? `แนวโน้ม: ${p.name}` : 'แนวโน้ม'),
      h('div.seg', { role: 'group', 'aria-label': 'ช่วงเวลา' }, Object.keys(RANGES).map((k) => h('button', {
        type: 'button', class: `btn small ${this.state.trendRange === k ? 'active' : ''}`, 'aria-pressed': String(this.state.trendRange === k), 'data-focus-key': `tr-${k}`,
        onclick: () => { this.setState({ trendRange: k }, { render: false }); this.trendSig = ''; this.#renderTrends(); },
      }, { '1h': '1 ชม.', '6h': '6 ชม.', '24h': '24 ชม.', '7d': '7 วัน' }[k]))));
    if (!p) { replaceChildren(el, head, h('p.muted', 'เลือกจุดเพื่อดูกราฟ')); return; }
    const from = now - range;
    const engine = this.engine;
    const charts = await Promise.all(p.metrics.map(async (m) => {
      const data = await this.ctl.repo.getSeries(this.ctl.mode, p.id, m.id, from, now);
      return renderMetricChart({ metric: m, samples: data, rules: this.config.rules.filter((r) => r.pointId === p.id && r.metricId === m.id), from, to: now });
    }));
    if (engine !== this.engine || this.trendSig !== sig) return;
    replaceChildren(el, head,
      h('p.muted.small', `ประวัติที่บันทึกในอุปกรณ์นี้ (${SOURCE_LABEL[this.ctl.mode]}) · พื้นที่แรเงา = ไม่มีข้อมูล/ข้อมูลขาดช่วง ไม่ลากเส้นข้ามช่วงที่ขาด · แต่ละหน่วยแยกกราฟ`),
      h('div.chart-grid', charts));
  }

  // ------------------------------------------------------------------ เสียง
  episodesSorted(list) {
    return list.sort((a, b) => Number(isEpisodeActive(b)) - Number(isEpisodeActive(a)) || severityRank(b.severity) - severityRank(a.severity) || b.openedAt - a.openedAt);
  }
  ackState(ep) { return isEpisodeAcknowledged(ep); }
}
