import { SCHEMA_VERSION, SOURCES, SAMPLE_QUALITY, SEVERITY, DEFAULT_RETENTION } from './constants.js';
import { validateConfig, indexConfig } from './config.js';
import { sampleId } from './normalize.js';
import { migrateConfig } from './migrate.js';

export const BACKUP_FORMAT = 'iot-fortune-backup';

export function makeBackup({ config, samples, episodes, settings, exportedAt }) {
  return {
    format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: new Date(exportedAt).toISOString(),
    note: 'ข้อมูลสำรองจากเบราว์เซอร์เครื่องเดียว ค่าที่มาจากแหล่ง demo เป็นข้อมูลจำลอง',
    config, samples, episodes, settings: settings ?? null,
  };
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * ตรวจไฟล์สำรองทั้งหมดก่อนเขียน (ไม่มีการเขียนบางส่วน)
 * คืน { ok, errors, summary }
 */
export function validateBackup(obj, { maxErrors = 50 } = {}) {
  const errors = [];
  const err = (m) => { if (errors.length < maxErrors) errors.push(m); };
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['ไฟล์ไม่ใช่ JSON object'], summary: null };
  if (obj.format !== BACKUP_FORMAT) err('ไม่ใช่ไฟล์สำรองของ IoT ฟอร์จูน (format ไม่ตรง)');
  if (obj.schemaVersion !== SCHEMA_VERSION && ![1, 2, 3, 4].includes(obj.schemaVersion)) err(`schemaVersion ไม่รองรับ: ${obj.schemaVersion}`);
  // ไฟล์สำรองรุ่นเก่า ย้ายการตั้งค่าเป็นรุ่นปัจจุบันก่อนตรวจ (ค่าวัด/เหตุการณ์ใช้ต่อได้)
  if ([1, 2, 3, 4].includes(obj.schemaVersion) && obj.config) {
    obj = { ...obj, schemaVersion: SCHEMA_VERSION, config: migrateConfig(obj.config), migratedFrom: obj.schemaVersion };
  }
  const cv = validateConfig(obj.config);
  for (const e of cv.errors) err(`การตั้งค่า: ${e}`);
  if (!Array.isArray(obj.samples)) err('samples ต้องเป็นรายการ');
  if (!Array.isArray(obj.episodes)) err('episodes ต้องเป็นรายการ');
  if (errors.length) return { ok: false, errors, summary: null };

  const idx = indexConfig(obj.config);
  const ruleIds = new Set(obj.config.rules.map((r) => r.id));
  const sids = new Set();
  const perSource = { demo: 0, api: 0 };
  let minObs = Infinity; let maxObs = -Infinity;
  obj.samples.forEach((s, i) => {
    const w = `samples[${i}]`;
    if (!s || typeof s !== 'object') { err(`${w}: ไม่ใช่ object`); return; }
    if (!SOURCES.includes(s.source)) err(`${w}: source ไม่ถูกต้อง`);
    const m = idx.metric(s.pointId, s.metricId);
    if (!m) { err(`${w}: อ้างถึงจุด/ค่าวัดที่ไม่มีในการตั้งค่า (${s.pointId}/${s.metricId})`); return; }
    if (!fin(s.observedAt) || !fin(s.receivedAt)) err(`${w}: เวลาไม่ถูกต้อง`);
    if (m.kind === 'numeric' ? !fin(s.value) : !m.states.some((x) => x.value === s.value)) err(`${w}: ค่าไม่ถูกต้อง`);
    if (!SAMPLE_QUALITY.includes(s.quality)) err(`${w}: quality ไม่ถูกต้อง`);
    if (s.id !== sampleId(s.source, s.pointId, s.metricId, s.observedAt)) err(`${w}: รหัส sample ไม่ตรงกับเนื้อหา`);
    if (sids.has(s.id)) err(`${w}: รหัสซ้ำ`);
    sids.add(s.id);
    perSource[s.source] = (perSource[s.source] ?? 0) + 1;
    if (fin(s.observedAt)) { minObs = Math.min(minObs, s.observedAt); maxObs = Math.max(maxObs, s.observedAt); }
  });
  const eids = new Set();
  obj.episodes.forEach((e, i) => {
    const w = `episodes[${i}]`;
    if (!e || typeof e !== 'object' || typeof e.id !== 'string') { err(`${w}: ไม่ถูกต้อง`); return; }
    if (eids.has(e.id)) err(`${w}: รหัสซ้ำ`);
    eids.add(e.id);
    if (!SOURCES.includes(e.source)) err(`${w}: source ไม่ถูกต้อง`);
    if (!idx.metric(e.pointId, e.metricId)) err(`${w}: อ้างถึงจุด/ค่าวัดที่ไม่มี`);
    if (!ruleIds.has(e.ruleId)) err(`${w}: อ้างถึงกฎที่ไม่มี ${e.ruleId}`);
    if (!(e.severity in SEVERITY) || !(e.peakSeverity in SEVERITY)) err(`${w}: ระดับไม่ถูกต้อง`);
    if (!fin(e.openedAt)) err(`${w}: openedAt ไม่ถูกต้อง`);
    if (!Array.isArray(e.acks) || !Array.isArray(e.events)) err(`${w}: acks/events ต้องเป็นรายการ`);
  });
  const summary = {
    exportedAt: obj.exportedAt,
    points: obj.config.points.length,
    activePoints: obj.config.points.filter((p) => p.status === 'active').length,
    rules: obj.config.rules.length,
    samples: obj.samples.length, perSource,
    episodes: obj.episodes.length,
    observedRange: obj.samples.length ? [minObs, maxObs] : null,
  };
  if (obj.migratedFrom) summary.migratedFrom = obj.migratedFrom;
  return { ok: errors.length === 0, errors, summary, data: obj };
}

export function defaultSettings() {
  return {
    mode: 'demo',
    api: { url: '', intervalSec: 10, timeoutSec: 8 },
    demo: { seed: 20261014, speed: 1, scenario: 'normal', scenarioStartedAt: null, lossPointId: 'P-005' },
    retention: { ...DEFAULT_RETENTION },
    ackName: '',
  };
}
