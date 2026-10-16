import { IdbRepo } from '../store/idbRepo.js';
import { MonitorEngine } from '../engine.js';
import { createDefaultConfig } from '../domain/defaultConfig.js';
import { validateConfig, indexConfig } from '../domain/config.js';
import { migrateConfig } from '../domain/migrate.js';
import { defaultSettings, makeBackup, validateBackup } from '../domain/backup.js';
import { DemoAdapter, DEMO_BACKFILL_MS } from '../adapters/demoAdapter.js';
import { HttpPoller, validateEndpoint } from '../adapters/httpPoller.js';
import { systemClock } from '../domain/time.js';

const browserScheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
};

function makeIdGen() {
  return () => `EP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * ตัวควบคุมแอป: ดูแลคลังข้อมูล การตั้งค่า engine และอะแดปเตอร์ตามแหล่งข้อมูลที่เลือก
 * เปลี่ยนแหล่งข้อมูล = dispose อะแดปเตอร์/engine เดิม แล้วสร้างใหม่ (ไม่ใช้ค่าเดิมเป็นค่าปัจจุบัน)
 */
export class Controller {
  constructor({ dbName, idb } = {}) {
    this.repo = new IdbRepo({ name: dbName, ...(idb ?? {}) });
    this.memoryOnly = !!idb;
    this.listeners = new Set();
    this.engine = null;
    this.adapter = null;
    this.adapterToken = 0;
    this.connection = null;
    this.storageNotice = null; // { ok, text, at }
    this.configWarning = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt) { for (const fn of this.listeners) fn(evt); }

  async init() {
    await this.repo.open();
    let config = await this.repo.getKV('config');
    if (!config) {
      config = createDefaultConfig();
      await this.repo.putKV('config', config);
    } else {
      if (config.schemaVersion !== createDefaultConfig().schemaVersion) {
        const migrated = migrateConfig(config);
        if (validateConfig(migrated).ok) {
          config = migrated;
          await this.repo.putKV('config', config);
        }
      }
      const v = validateConfig(config);
      if (!v.ok) {
        this.configWarning = `การตั้งค่าที่บันทึกไว้ไม่ผ่านการตรวจ (${v.errors[0]}) — ใช้ค่าเริ่มต้นชั่วคราว ข้อมูลเดิมยังไม่ถูกลบ`;
        config = createDefaultConfig();
      }
    }
    this.config = config;
    this.index = indexConfig(config);
    const saved = await this.repo.getKV('settings');
    const d = defaultSettings();
    this.settings = saved ? { ...d, ...saved, api: { ...d.api, ...saved.api }, demo: { ...d.demo, ...saved.demo }, retention: { ...d.retention, ...saved.retention } } : d;
    this.ui = (await this.repo.getKV('ui')) ?? {};
    await this.startSource();
  }

  get mode() { return this.settings.mode; }
  now() { return this.engine ? this.engine.now() : Date.now(); }

  async startSource() {
    this.stopSource();
    const token = ++this.adapterToken;
    const mode = this.settings.mode;
    let clock = systemClock;
    let demo = null;
    if (mode === 'demo') {
      const st = (await this.repo.getKV('demoState')) ?? null;
      const real = Date.now();
      const simStart = Math.max(st?.simNow ?? 0, real);
      const lastEmittedAt = st?.lastEmittedAt != null ? Math.max(st.lastEmittedAt, simStart - DEMO_BACKFILL_MS) : undefined;
      const p = this.settings.demo;
      if (p.scenario !== 'normal' && p.scenarioStartedAt == null) p.scenarioStartedAt = simStart;
      demo = new DemoAdapter({
        params: p, simStart, lastEmittedAt, realClock: systemClock, scheduler: browserScheduler,
        onPayload: (payload, meta) => this.#onPayload(token, payload, meta),
      });
      clock = { now: () => demo.now() };
    }
    const engine = new MonitorEngine({
      repo: this.repo, config: this.config, source: mode, clock, idGen: makeIdGen(), retention: this.settings.retention,
    });
    await engine.init();
    if (token !== this.adapterToken) { engine.dispose(); demo?.dispose(); return; }
    this.engine = engine;
    engine.subscribe((evt) => this.emit({ type: 'engine', evt }));
    this.connection = null;
    if (mode === 'demo') {
      this.adapter = demo;
      demo.start();
      this.demoSaveTimer = setInterval(() => this.#saveDemoState(), 5000);
    } else {
      const url = this.settings.api.url;
      const v = url ? validateEndpoint(url) : { ok: false, error: 'ยังไม่ได้ตั้งค่า URL ของ API' };
      if (!v.ok) {
        this.connection = { state: 'unconfigured', lastError: v.error };
      } else {
        this.adapter = new HttpPoller({
          url: v.url, intervalMs: this.settings.api.intervalSec * 1000, timeoutMs: this.settings.api.timeoutSec * 1000,
          scheduler: browserScheduler, clock: systemClock,
          onPayload: (json, meta) => this.#onPayload(token, json, meta),
          onStatus: (s) => { if (token === this.adapterToken) { this.connection = s; this.emit({ type: 'connection' }); } },
        });
        this.adapter.start();
      }
    }
    this.tickTimer = setInterval(() => { if (this.engine) { this.engine.tick(); this.emit({ type: 'tick' }); } }, 1000);
    this.emit({ type: 'source' });
  }

  #onPayload(token, payload, meta) {
    if (token !== this.adapterToken || !this.engine) return; // อะแดปเตอร์เก่า — ทิ้ง
    return this.engine.ingest(payload, meta);
  }

  async #saveDemoState() {
    if (this.adapter?.kind !== 'demo') return;
    try {
      await this.repo.putKV('demoState', { simNow: this.adapter.simNow, lastEmittedAt: this.adapter.lastEmittedAt });
    } catch { /* แสดงผ่าน storage notice ของ engine */ }
  }

  stopSource() {
    this.adapterToken++;
    clearInterval(this.tickTimer);
    clearInterval(this.demoSaveTimer);
    if (this.adapter?.kind === 'demo') this.#saveDemoState();
    this.adapter?.dispose();
    this.adapter = null;
    this.engine?.dispose();
    this.engine = null;
  }

  // ---------- การตั้งค่า ----------
  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    return this.#persist('settings', this.settings, 'บันทึกการตั้งค่าแหล่งข้อมูล');
  }

  async saveUi(ui) {
    this.ui = ui;
    try { await this.repo.putKV('ui', ui); } catch { /* ไม่สำคัญ */ }
  }

  async #persist(key, value, label) {
    try {
      await this.repo.putKV(key, value);
      this.storageNotice = { ok: true, text: `${label}ในอุปกรณ์นี้แล้ว`, at: Date.now() };
      return { ok: true };
    } catch (e) {
      this.storageNotice = { ok: false, text: `${label}ไม่สำเร็จ: ${e.message}`, at: Date.now() };
      return { ok: false, error: e.message };
    } finally {
      this.emit({ type: 'notice' });
    }
  }

  async switchMode(mode, api) {
    const next = { ...this.settings, mode };
    if (api) next.api = { ...next.api, ...api };
    const r = await this.saveSettings(next);
    if (!r.ok) return r;
    await this.startSource();
    return r;
  }

  async setDemoParams(patch) {
    if (this.mode !== 'demo' || !this.adapter) return;
    const d = { ...this.settings.demo, ...patch };
    if (patch.scenario !== undefined) {
      const old = this.settings.demo;
      // จำสถานการณ์ก่อนหน้า เพื่อให้ค่าค่อย ๆ กลับสู่ปกติแทนการกระโดด
      d.prev = old.scenario && old.scenario !== 'normal' && old.scenarioStartedAt != null
        ? { scenario: old.scenario, startedAt: old.scenarioStartedAt, endedAt: this.adapter.now() } : (old.prev ?? null);
      d.scenarioStartedAt = this.adapter.now();
    }
    this.settings.demo = d;
    this.adapter.setParams(d);
    await this.saveSettings({ demo: d });
    this.emit({ type: 'source' });
  }

  async resetDemo() {
    this.stopSource();
    await this.repo.clearSource('demo');
    this.settings.demo = { ...this.settings.demo, scenario: 'normal', scenarioStartedAt: null, speed: 1, prev: null };
    await this.saveSettings({ demo: this.settings.demo });
    await this.startSource();
  }

  /** บันทึกการตั้งค่าจุด/เกณฑ์ — แจ้งผลตามจริง */
  async saveConfig(config) {
    const v = validateConfig(config);
    if (!v.ok) return { ok: false, errors: v.errors };
    const r = await this.#persist('config', config, 'บันทึกการตั้งค่าจุด');
    if (!r.ok) return { ok: false, errors: [r.error] };
    this.config = config;
    this.index = indexConfig(config);
    await this.engine?.applyConfig(config);
    this.emit({ type: 'config' });
    return { ok: true };
  }

  async acknowledge(episodeId, by, note) {
    try {
      await this.engine.acknowledge(episodeId, { by, note });
      this.settings.ackName = by;
      await this.repo.putKV('settings', this.settings).catch(() => {});
      this.storageNotice = { ok: true, text: 'บันทึกการรับทราบในอุปกรณ์นี้แล้ว', at: Date.now() };
      return { ok: true };
    } catch (e) {
      this.storageNotice = { ok: false, text: `บันทึกการรับทราบไม่สำเร็จ: ${e.message}`, at: Date.now() };
      return { ok: false, error: e.message };
    } finally {
      this.emit({ type: 'notice' });
    }
  }

  // ---------- สำรอง/นำเข้า ----------
  async exportBackup() {
    const dump = await this.repo.exportAll();
    return makeBackup({ config: this.config, settings: this.settings, samples: dump.samples, episodes: dump.episodes, exportedAt: Date.now() });
  }

  previewImport(text) {
    let obj;
    try { obj = JSON.parse(text); } catch { return { ok: false, errors: ['ไฟล์ไม่ใช่ JSON ที่ถูกต้อง'] }; }
    const v = validateBackup(obj);
    return { ...v, data: v.ok ? v.data : null };
  }

  async confirmImport(data) {
    this.stopSource();
    try {
      const d = defaultSettings();
      const settings = data.settings ? { ...d, ...data.settings, api: { ...d.api, ...data.settings.api }, demo: { ...d.demo, ...data.settings.demo }, retention: { ...d.retention, ...data.settings.retention } } : this.settings;
      await this.repo.replaceAll({ config: data.config, settings, samples: data.samples, episodes: data.episodes });
      this.config = data.config;
      this.index = indexConfig(data.config);
      this.settings = settings;
      this.storageNotice = { ok: true, text: `นำเข้าแล้ว: ${data.samples.length.toLocaleString('th-TH')} ค่าวัด, ${data.episodes.length} เหตุการณ์`, at: Date.now() };
      return { ok: true };
    } catch (e) {
      this.storageNotice = { ok: false, text: `นำเข้าไม่สำเร็จ — ข้อมูลเดิมยังอยู่ครบ (${e.message})`, at: Date.now() };
      return { ok: false, error: e.message };
    } finally {
      await this.startSource();
      this.emit({ type: 'config' });
      this.emit({ type: 'notice' });
    }
  }

  async episodesFor(source) {
    if (source === this.mode && this.engine) return this.engine.episodes();
    return this.repo.getEpisodes(source);
  }
}
