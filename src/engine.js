import { indexConfig } from './domain/config.js';
import { normalizeBatch, QUALITY_AFFECTING } from './domain/normalize.js';
import { metricQuality } from './domain/quality.js';
import { AlarmEvaluator, isEpisodeActive } from './domain/alarms.js';
import { computeKpis, pointStatus } from './domain/kpi.js';

/** เหตุผลจากกติกา Lifecycle (ข้อมูลถูกปฏิเสธเพราะสถานะติดตั้ง — ส่งให้ audit) */
export const LIFECYCLE_REASONS = new Set(['not-installed', 'point-retired', 'asset-retired']);
const ACCEPT_ALL = () => ({ accept: true, reason: null });

/**
 * MonitorEngine — ประสานการรับข้อมูล → ตรวจ → บันทึก → ประเมินการแจ้งเตือน
 * ผูกกับแหล่งข้อมูลเดียว (demo หรือ api) เปลี่ยนแหล่งให้สร้าง engine ใหม่ ประวัติจึงไม่ปนกัน
 * ไม่พึ่ง DOM/WebGL — ทดสอบได้ใน Node
 */
export class MonitorEngine {
  /**
   * @param {object} o
   * @param {(pointId: string) => { accept: boolean, reason: string|null }} [o.decide]  กติกา Lifecycle เดียว
   *   (lifecycle.telemetryDecision ผ่าน SpatialDataService) ใช้ทั้งรับข้อมูล คุณภาพ KPI และการแจ้งเตือน — ไม่ส่ง = รับทุกจุดตามเดิม
   * @param {(rejected: object[], receivedAt: number) => void} [o.onRejected]  ข้อมูลที่ถูกปฏิเสธตามกติกา Lifecycle (บันทึก audit)
   */
  constructor({ repo, config, source, clock, idGen, retention, decide = ACCEPT_ALL, onRejected = null }) {
    this.repo = repo;
    this.decide = decide;
    this.onRejected = onRejected;
    this.source = source;
    this.clock = clock;
    this.retention = retention;
    this.evaluator = new AlarmEvaluator({ idGen, source });
    this.entries = new Map(); // pointId|metricId → { lastValid, lastRejectedAt, lastRejectReason }
    this.latest = new Map(); // สำหรับตรวจลำดับ/ซ้ำ
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.disposed = false;
    this.lastSaveError = null;
    this.lastSaveOkAt = null;
    this.diag = { accepted: 0, rejected: 0, duplicates: 0, byReason: {}, recent: [], lastBatchAt: null, lastIngestCount: 0 };
    this.#setConfig(config);
  }

  #setConfig(config) {
    this.config = config;
    this.index = indexConfig(config);
  }

  async init() {
    const eps = await this.repo.getEpisodes(this.source);
    this.evaluator.loadEpisodes(eps);
    for (const p of this.config.points) {
      for (const m of p.metrics) {
        const last = await this.repo.latestSample(this.source, p.id, m.id);
        if (last) {
          this.entries.set(`${p.id}|${m.id}`, { lastValid: last, lastRejectedAt: null, lastRejectReason: null });
          this.latest.set(`${p.id}|${m.id}`, { observedAt: last.observedAt, sequence: last.sequence, value: last.value });
        }
      }
    }
    return this;
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #emit(evt) { for (const fn of this.listeners) fn(evt); }

  now() { return this.clock.now(); }

  entry(pointId, metricId) { return this.entries.get(`${pointId}|${metricId}`) ?? null; }

  /** จุดนี้รับข้อมูล/นับ KPI/แจ้งเตือนได้ตามกติกา Lifecycle หรือไม่ */
  accepts(pointId) { return this.decide(pointId).accept; }

  quality(pointId, metricId) {
    const m = this.index.metric(pointId, metricId);
    if (!m) return 'nodata';
    if (!this.accepts(pointId)) return 'not-installed';
    return metricQuality(this.entry(pointId, metricId), m, this.now());
  }

  episodes() { return [...this.evaluator.episodes.values()]; }
  activeEpisodesFor(pointId) { return this.episodes().filter((e) => e.pointId === pointId && isEpisodeActive(e)); }

  pointStatus(point) {
    if (!this.accepts(point.id)) return { severity: 'normal', quality: 'not-installed', attention: false, decision: this.decide(point.id) };
    return pointStatus(point, (p, m) => this.quality(p, m), this.episodes());
  }
  /** KPI นับเฉพาะจุดที่กติกา Lifecycle ยอมรับ (ติดตั้งแล้ว/ส่งมอบแล้ว) — จุดยังไม่ติดตั้งไม่นับ และเหตุการณ์ของจุดนั้นไม่นับ */
  kpis() { return computeKpis(this.config.points.filter((p) => this.accepts(p.id)), (p, m) => this.quality(p, m), this.episodes()); }

  /** รับชุดข้อมูลจากอะแดปเตอร์ (เรียงคิว ไม่ประมวลผลซ้อน) */
  ingest(payload, meta) {
    const run = this.queue.then(() => this.#ingest(payload, meta));
    this.queue = run.catch(() => {});
    return run;
  }

  async #ingest(payload, { receivedAt }) {
    if (this.disposed) return null;
    const res = normalizeBatch(payload, { index: this.index, source: this.source, receivedAt, latest: this.latest, decide: this.decide });
    const lifecycleRejected = res.rejected.filter((r) => LIFECYCLE_REASONS.has(r.reason));
    if (lifecycleRejected.length && this.onRejected) { try { this.onRejected(lifecycleRejected, receivedAt); } catch { /* audit ห้ามทำให้การรับข้อมูลล้ม */ } }
    const d = this.diag;
    d.lastBatchAt = receivedAt;
    d.accepted += res.accepted.length;
    d.duplicates += res.duplicates;
    d.rejected += res.rejected.length;
    d.lastIngestCount = res.accepted.length;
    for (const r of res.rejected) {
      d.byReason[r.reason] = (d.byReason[r.reason] ?? 0) + 1;
      d.recent.unshift(r);
      if (r.pointId && r.metricId && QUALITY_AFFECTING.has(r.reason)) {
        const k = `${r.pointId}|${r.metricId}`;
        const e = this.entries.get(k) ?? { lastValid: null, lastRejectedAt: null, lastRejectReason: null };
        e.lastRejectedAt = receivedAt; e.lastRejectReason = r.reason;
        this.entries.set(k, e);
      }
    }
    d.recent.length = Math.min(d.recent.length, 40);

    // บันทึกก่อน แล้วจึงประเมิน ถ้าบันทึกไม่สำเร็จ ยังแสดงค่าได้แต่แจ้งชัดเจนว่าไม่ได้บันทึก
    try {
      await this.repo.addSamples(res.accepted);
      if (res.accepted.length) { this.lastSaveOkAt = receivedAt; this.lastSaveError = null; }
    } catch (e) {
      this.lastSaveError = e;
    }

    const changed = new Map();
    for (const s of res.accepted) {
      const k = `${s.pointId}|${s.metricId}`;
      const e = this.entries.get(k) ?? { lastValid: null, lastRejectedAt: null, lastRejectReason: null };
      e.lastValid = s;
      this.entries.set(k, e);
      const metric = this.index.metric(s.pointId, s.metricId);
      for (const rule of this.index.rulesByMetric.get(k) ?? []) {
        for (const ep of this.evaluator.apply(rule, metric, s)) changed.set(ep.id, ep);
      }
    }
    await this.#persistEpisodes([...changed.values()]);
    if (this.retention && res.accepted.length) await this.#maybeRetention();
    const transitions = this.evaluator.drainEvents();
    this.#emit({ type: 'data', result: res, changed: [...changed.values()], transitions });
    return res;
  }

  async #persistEpisodes(list) {
    if (!list.length) return;
    try { await this.repo.putEpisodes(list); } catch (e) { this.lastSaveError = e; }
  }

  #retentionAt = 0;
  async #maybeRetention() {
    const now = this.now();
    if (now - this.#retentionAt < 60_000) return;
    this.#retentionAt = now;
    try { this.lastRetentionDeleted = await this.repo.enforceRetention(now, this.retention); } catch (e) { this.lastSaveError = e; }
  }

  /** เรียกเป็นระยะ: ข้อมูลไม่สดใหม่ → ล้างการนับ dwell (ไม่ล้างการแจ้งเตือนที่เกิดแล้ว) */
  tick() {
    let broke = 0;
    for (const [k, rules] of this.index.rulesByMetric) {
      const [p, m] = k.split('|');
      if (this.quality(p, m) !== 'fresh') for (const r of rules) if (this.evaluator.breakPending(r.id)) broke++;
    }
    return broke;
  }

  /** ใช้การตั้งค่าใหม่ทันที: ประเมินค่าที่ "สดใหม่" อยู่ด้วยขีดใหม่ (กราฟเปลี่ยนเมื่อมีค่าใหม่เท่านั้น) */
  async applyConfig(config) {
    return this.queue = this.queue.then(async () => {
      const oldRules = new Map(this.config.rules.map((r) => [r.id, r]));
      this.#setConfig(config);
      const changed = [];
      const now = this.now();
      const newIds = new Set(config.rules.map((r) => r.id));
      for (const [id, old] of oldRules) {
        const nr = config.rules.find((r) => r.id === id);
        if (!newIds.has(id) || !nr.enabled || nr.type !== old.type || nr.metricId !== old.metricId || nr.pointId !== old.pointId) {
          changed.push(...this.evaluator.disableRule(id, now));
        }
      }
      for (const rule of config.rules) {
        if (!rule.enabled) continue;
        const e = this.entry(rule.pointId, rule.metricId);
        const metric = this.index.metric(rule.pointId, rule.metricId);
        if (!e?.lastValid || !metric || this.quality(rule.pointId, rule.metricId) !== 'fresh') continue;
        changed.push(...this.evaluator.apply(rule, metric, e.lastValid, { reevaluate: true }));
      }
      await this.#persistEpisodes(changed);
      this.#emit({ type: 'config', changed, transitions: this.evaluator.drainEvents() });
      return changed;
    });
  }

  async acknowledge(episodeId, ack) {
    const ep = this.evaluator.acknowledge(episodeId, { ...ack, at: ack.at ?? this.now() });
    await this.repo.putEpisodes([ep]);
    this.#emit({ type: 'ack', episode: ep });
    return ep;
  }

  dispose() { this.disposed = true; this.listeners.clear(); }
}
