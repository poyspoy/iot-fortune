import { createDefaultConfig } from '../src/domain/defaultConfig.js';
import { indexConfig } from '../src/domain/config.js';

export const T0 = Date.parse('2026-10-14T03:00:00Z');
export const iso = (ms) => new Date(ms).toISOString();

export function setup() {
  const config = createDefaultConfig();
  return { config, index: indexConfig(config) };
}

export function payload(samples) {
  return { schemaVersion: 1, samples };
}

export function s(pointId, metricId, value, unit, at, extra = {}) {
  return { pointId, metricId, value, unit, observedAt: iso(at), quality: 'good', ...extra };
}

export function idGen() {
  let n = 0;
  return () => `E${++n}`;
}

export const rule = (o) => ({ id: 'R', pointId: 'P', metricId: 'm', enabled: true, hysteresis: 0, dwellSec: 0, ...o });
export const metric = (o = {}) => ({ id: 'm', kind: 'numeric', unit: 'u', staleAfterSec: 120, ...o });
export const obs = (value, at, unit = 'u') => ({ value, observedAt: at, unit });
