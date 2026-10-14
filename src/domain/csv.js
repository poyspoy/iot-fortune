import { fmtDateTime, isoUtc } from './time.js';
import { isEpisodeActive, isEpisodeAcknowledged } from './alarms.js';
import { SEVERITY, SOURCE_LABEL } from './constants.js';

/**
 * เซลล์ CSV ที่ปลอดภัย
 * - ข้อความที่ขึ้นต้นด้วย = + - @ แท็บ หรือ CR จะถูกเติม ' นำหน้า เพื่อไม่ให้ Excel/Sheets ตีความเป็นสูตร
 * - ครอบด้วย " และ escape " ภายในเป็น ""
 * - ตัวเลข (type number) ไม่ถูกเติม ' (ค่าติดลบยังเป็นตัวเลข)
 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function readingsCsv(samples, index) {
  const header = ['source', 'point_id', 'point_name', 'metric_id', 'metric_name', 'value', 'unit', 'quality',
    'observed_at_utc', 'observed_at_bangkok', 'received_at_utc', 'sequence'];
  const rows = samples.map((s) => {
    const p = index.points.get(s.pointId);
    const m = index.metric(s.pointId, s.metricId);
    return [SOURCE_LABEL[s.source] ?? s.source, s.pointId, p?.name ?? '', s.metricId, m?.name ?? '', s.value, s.unit, s.quality,
      isoUtc(s.observedAt), fmtDateTime(s.observedAt), isoUtc(s.receivedAt), s.sequence];
  });
  return toCsv(header, rows);
}

export function alertsCsv(episodes, index) {
  const header = ['episode_id', 'source', 'point_id', 'point_name', 'metric_id', 'rule_id', 'severity', 'peak_severity',
    'state', 'open_value', 'last_value', 'unit', 'opened_at_utc', 'escalated_at_utc', 'recovered_at_utc', 'ended_reason',
    'acknowledged', 'ack_by', 'ack_at_utc', 'ack_note'];
  const rows = episodes.map((e) => {
    const ack = e.acks?.[e.acks.length - 1];
    return [e.id, SOURCE_LABEL[e.source] ?? e.source, e.pointId, index.points.get(e.pointId)?.name ?? '', e.metricId, e.ruleId,
      SEVERITY[e.severity]?.label, SEVERITY[e.peakSeverity]?.label,
      isEpisodeActive(e) ? 'ยังเกิดอยู่' : (e.recoveredAt ? 'กลับสู่ปกติ' : 'ยุติ (ปิดกฎ)'),
      e.openValue, e.lastValue, e.unit, isoUtc(e.openedAt), isoUtc(e.escalatedAt), isoUtc(e.recoveredAt), e.endReason ?? '',
      isEpisodeAcknowledged(e) ? 'ใช่' : 'ไม่', ack?.by ?? '', isoUtc(ack?.at), ack?.note ?? ''];
  });
  return toCsv(header, rows);
}
