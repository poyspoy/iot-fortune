import { h, fmtNum } from './dom.js';
import { SEVERITY, QUALITY, SYSTEMS, SOURCE_LABEL, RULE_TYPES } from '../domain/constants.js';
import { REJECT_REASONS } from '../domain/normalize.js';

export function sevBadge(sev) {
  return h('span', { class: `badge sev-${sev}` }, h('span.badge-icon', { 'aria-hidden': 'true' }, sev === 'critical' ? '!!' : sev === 'warning' ? '!' : '✓'), SEVERITY[sev].label);
}
export function qualBadge(q) {
  const icon = { fresh: '●', stale: '◷', nodata: '○', invalid: '✕', 'not-installed': '◌' }[q];
  return h('span', { class: `badge q-${q}` }, h('span.badge-icon', { 'aria-hidden': 'true' }, icon), QUALITY[q].label);
}
export function sourceBadge(source) {
  return h('span', { class: `badge src-${source}` }, SOURCE_LABEL[source]);
}
export function systemLabel(sys) { return SYSTEMS[sys]?.label ?? sys; }

export function valueText(metric, value) {
  if (value === undefined || value === null) return '—';
  if (metric.kind === 'discrete') return metric.states.find((s) => s.value === value)?.label ?? String(value);
  return `${fmtNum(value, metric.decimals ?? 1)} ${metric.unit}`;
}

export function ruleText(rule, metric) {
  const u = metric?.unit ? ` ${metric.unit}` : '';
  const tail = `${rule.hysteresis ? ` · ฮิสเทอรีซิส ${rule.hysteresis}${u}` : ''}${rule.dwellSec ? ` · คงค่า ${rule.dwellSec} วินาที` : ''}${rule.enabled ? '' : ' · (ปิดอยู่)'}`;
  switch (rule.type) {
    case 'high': return `เตือน ≥ ${rule.warning}${u}, วิกฤต ≥ ${rule.critical}${u}${tail}`;
    case 'low': return `เตือน ≤ ${rule.warning}${u}, วิกฤต ≤ ${rule.critical}${u}${tail}`;
    case 'range': return `ยอมรับ ${rule.warningLow}–${rule.warningHigh}${u} (วิกฤต ≤ ${rule.criticalLow} หรือ ≥ ${rule.criticalHigh})${tail}`;
    case 'discrete': return `${Object.entries(rule.states).map(([k, v]) => `${metric?.states?.find((s) => s.value === k)?.label ?? k} → ${SEVERITY[v].label}`).join(', ')}${tail}`;
    default: return RULE_TYPES[rule.type] ?? '';
  }
}

export function reasonText(r) { return REJECT_REASONS[r] ?? r; }
