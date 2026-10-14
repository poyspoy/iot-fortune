import { severityRank } from './constants.js';

/**
 * กฎการแจ้งเตือน (ทดสอบได้โดยไม่ต้องใช้ DOM)
 *
 * ขอบเขต (inclusive): ค่าเท่ากับขีดจำกัดพอดีถือว่า "ถึงขีดจำกัดแล้ว"
 *   high : v ≥ วิกฤต → วิกฤต, v ≥ เตือน → เตือน
 *   low  : v ≤ วิกฤต → วิกฤต, v ≤ เตือน → เตือน
 *   range: v ≤ วิกฤตล่าง หรือ v ≥ วิกฤตบน → วิกฤต, v ≤ เตือนล่าง หรือ v ≥ เตือนบน → เตือน
 * ฮิสเทอรีซิส h: การลดระดับ/กลับสู่ปกติต้องพ้นขีดจำกัดไปอีก h แบบเคร่งครัด
 *   high: ต้อง v < ขีด − h,  low: ต้อง v > ขีด + h
 * เวลาคงค่า (dwell): การเพิ่มระดับต้องมีค่าที่ถูกต้องต่อเนื่องที่ระดับนั้นนาน ≥ dwell วินาที
 *   (นับจาก observedAt ของค่าแรกจนถึงค่าปัจจุบัน) ช่องว่างระหว่างค่าที่นานกว่าเวลาหมดอายุ
 *   หรือข้อมูลเก่า/ไม่ถูกต้อง จะล้างการนับ dwell — การไม่มีข้อมูลยืนยันการเกินขีดไม่ได้
 * การลดระดับและการกลับสู่ปกติเกิดทันทีเมื่อพ้นฮิสเทอรีซิส และต้องมาจากค่าที่ถูกต้องเท่านั้น
 */

const LEVELS = ['normal', 'warning', 'critical'];
const atLeast = (a, b) => severityRank(a) >= severityRank(b);
const maxL = (a, b) => (severityRank(a) >= severityRank(b) ? a : b);
const minL = (a, b) => (severityRank(a) <= severityRank(b) ? a : b);

function highPart(v, w, c) {
  if (v >= c) return 'critical';
  if (v >= w) return 'warning';
  return 'normal';
}
function lowPart(v, w, c) {
  if (v <= c) return 'critical';
  if (v <= w) return 'warning';
  return 'normal';
}

/** ระดับดิบ ไม่คิดฮิสเทอรีซิส */
export function rawLevel(rule, value) {
  switch (rule.type) {
    case 'high': return highPart(value, rule.warning, rule.critical);
    case 'low': return lowPart(value, rule.warning, rule.critical);
    case 'range': return maxL(highPart(value, rule.warningHigh, rule.criticalHigh), lowPart(value, rule.warningLow, rule.criticalLow));
    case 'discrete': return rule.states?.[value] ?? 'normal';
    default: return 'normal';
  }
}

/** ระดับเมื่อคิดฮิสเทอรีซิสจากระดับปัจจุบัน */
export function levelWithHysteresis(rule, value, current) {
  const raw = rawLevel(rule, value);
  if (rule.type === 'discrete' || atLeast(raw, current)) return raw;
  const h = rule.hysteresis || 0;
  let held;
  if (rule.type === 'high') held = highPart(value + h, rule.warning, rule.critical);
  else if (rule.type === 'low') held = lowPart(value - h, rule.warning, rule.critical);
  else held = maxL(highPart(value + h, rule.warningHigh, rule.criticalHigh), lowPart(value - h, rule.warningLow, rule.criticalLow));
  return maxL(raw, minL(current, held));
}

export function isEpisodeActive(ep) {
  return !ep.recoveredAt && !ep.endedAt;
}
export function isEpisodeAcknowledged(ep) {
  const last = ep.acks?.[ep.acks.length - 1];
  return !!last && severityRank(last.severity) >= severityRank(ep.peakSeverity);
}
/** "ยังไม่ปิด" = ยังเกิดอยู่ หรือยังไม่ได้รับทราบ */
export function isEpisodeUnresolved(ep) {
  return isEpisodeActive(ep) || !isEpisodeAcknowledged(ep);
}

/** รับทราบ — ไม่เปลี่ยนสถานะการเกิด/การกลับสู่ปกติ */
export function acknowledgeEpisode(ep, { by, note, at }) {
  const name = String(by ?? '').trim();
  if (!name) throw new Error('ต้องระบุชื่อผู้รับทราบ');
  const copy = structuredClone(ep);
  copy.acks = [...(copy.acks || []), { by: name.slice(0, 80), note: String(note ?? '').slice(0, 1000), at, severity: copy.peakSeverity }];
  return copy;
}

export class AlarmEvaluator {
  /** @param {{ idGen: () => string, source: string }} opts */
  constructor({ idGen, source }) {
    this.idGen = idGen;
    this.source = source;
    this.states = new Map(); // ruleId → { level, since: {warning, critical}, lastObservedAt, episodeId }
    this.episodes = new Map();
    this.pendingEvents = [];
  }

  /** เหตุการณ์ที่เกิดตั้งแต่เรียกครั้งก่อน (ใช้เล่นเสียง/แจ้งในแอป) */
  drainEvents() {
    const e = this.pendingEvents;
    this.pendingEvents = [];
    return e;
  }

  loadEpisodes(list) {
    for (const ep of list) {
      this.episodes.set(ep.id, ep);
      if (isEpisodeActive(ep)) {
        this.states.set(ep.ruleId, { level: ep.severity, since: {}, lastObservedAt: ep.lastObservedAt, episodeId: ep.id });
      }
    }
  }

  state(ruleId) {
    let s = this.states.get(ruleId);
    if (!s) { s = { level: 'normal', since: {}, lastObservedAt: null, episodeId: null }; this.states.set(ruleId, s); }
    return s;
  }

  pendingLevel(ruleId) {
    const s = this.states.get(ruleId);
    if (!s) return null;
    for (const L of ['critical', 'warning']) if (s.since[L] != null && severityRank(L) > severityRank(s.level)) return { level: L, since: s.since[L] };
    return null;
  }

  /** ข้อมูลเก่า/ไม่ถูกต้อง → ล้างการนับ dwell ที่ค้างอยู่ (ไม่ล้างการแจ้งเตือนที่เกิดแล้ว) */
  breakPending(ruleId) {
    const s = this.states.get(ruleId);
    if (s && (s.since.warning != null || s.since.critical != null)) { s.since = {}; return true; }
    return false;
  }

  /**
   * ป้อนค่าที่ถูกต้องหนึ่งค่า คืนรายการ episode ที่เปลี่ยน
   * @param {object} rule  @param {object} metric  @param {{value:any, observedAt:number, unit:string}} sample
   */
  apply(rule, metric, sample, { reevaluate = false } = {}) {
    if (!rule.enabled) return [];
    const s = this.state(rule.id);
    const t = sample.observedAt;
    const staleMs = metric.staleAfterSec * 1000;
    if (!reevaluate && s.lastObservedAt != null && t - s.lastObservedAt > staleMs) s.since = {};
    s.lastObservedAt = Math.max(s.lastObservedAt ?? t, t);

    const target = levelWithHysteresis(rule, sample.value, s.level);
    const changed = [];

    if (severityRank(target) > severityRank(s.level)) {
      for (const L of ['warning', 'critical']) {
        if (severityRank(L) <= severityRank(s.level)) continue;
        if (atLeast(target, L)) s.since[L] ??= t; else s.since[L] = null;
      }
      let confirm = null;
      for (const L of ['critical', 'warning']) {
        if (severityRank(L) > severityRank(s.level) && s.since[L] != null && t - s.since[L] >= (rule.dwellSec || 0) * 1000) { confirm = L; break; }
      }
      if (confirm) {
        const since = s.since[confirm];
        changed.push(this.#transition(rule, s, confirm, sample, since));
        for (const L of LEVELS) if (severityRank(L) <= severityRank(confirm)) s.since[L] = null;
      } else if (s.episodeId) {
        changed.push(this.#touch(s, sample));
      }
    } else {
      s.since = {};
      if (severityRank(target) < severityRank(s.level)) changed.push(this.#transition(rule, s, target, sample, t));
      else if (s.episodeId) changed.push(this.#touch(s, sample));
    }
    return changed.filter(Boolean);
  }

  /** ปิดกฎ: episode ที่ค้างอยู่ถูกยุติด้วยเหตุผล "ปิดกฎ" (ไม่ถือว่ากลับสู่ปกติ) */
  disableRule(ruleId, at) {
    const s = this.states.get(ruleId);
    this.states.delete(ruleId);
    if (!s?.episodeId) return [];
    const ep = structuredClone(this.episodes.get(s.episodeId));
    ep.endedAt = at; ep.endReason = 'rule-disabled';
    ep.events.push({ type: 'rule-disabled', at, level: ep.severity });
    this.episodes.set(ep.id, ep);
    return [ep];
  }

  acknowledge(episodeId, ack) {
    const ep = this.episodes.get(episodeId);
    if (!ep) throw new Error('ไม่พบเหตุการณ์แจ้งเตือน');
    const next = acknowledgeEpisode(ep, ack);
    this.episodes.set(next.id, next);
    return next;
  }

  #touch(s, sample) {
    const ep = this.episodes.get(s.episodeId);
    if (!ep || ep.lastObservedAt === sample.observedAt) return null;
    const next = { ...ep, lastValue: sample.value, lastObservedAt: sample.observedAt };
    this.episodes.set(next.id, next);
    return next;
  }

  #transition(rule, s, to, sample, conditionSince) {
    const from = s.level;
    s.level = to;
    const at = sample.observedAt;
    this.pendingEvents.push({ ruleId: rule.id, from, to, at });
    if (from === 'normal') {
      const ep = {
        id: this.idGen(), source: this.source, pointId: rule.pointId, metricId: rule.metricId, ruleId: rule.id,
        severity: to, peakSeverity: to, unit: sample.unit ?? '',
        conditionSince, openedAt: at, escalatedAt: null, recoveredAt: null, endedAt: null, endReason: null,
        openValue: sample.value, lastValue: sample.value, lastObservedAt: at, peakValue: sample.value,
        acks: [], events: [{ type: 'opened', at, level: to, value: sample.value }],
      };
      s.episodeId = ep.id;
      this.episodes.set(ep.id, ep);
      return ep;
    }
    const ep = structuredClone(this.episodes.get(s.episodeId));
    ep.lastValue = sample.value; ep.lastObservedAt = at;
    if (to === 'normal') {
      ep.recoveredAt = at;
      ep.events.push({ type: 'recovered', at, level: 'normal', value: sample.value });
      s.episodeId = null;
    } else if (severityRank(to) > severityRank(from)) {
      ep.severity = to; ep.escalatedAt = at; ep.peakSeverity = maxL(ep.peakSeverity, to); ep.peakValue = sample.value;
      ep.events.push({ type: 'escalated', at, level: to, value: sample.value });
    } else {
      ep.severity = to;
      ep.events.push({ type: 'deescalated', at, level: to, value: sample.value });
    }
    this.episodes.set(ep.id, ep);
    return ep;
  }
}
