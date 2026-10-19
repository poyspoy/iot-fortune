// เอกสาร v6 ขนาดเล็กสำหรับทดสอบ Data Layer (ไม่ใช่ข้อมูล Fortune)
import { legacyEntityId } from '../src/data/ids.js';

export const T = Object.freeze({
  ns: '3c1d0c52-8f6e-4d7a-9a51-2e8b7c6d5f40',
  org: '5a0b6c7d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  proj: '6b1c7d8e-2f3a-4b4c-9d5e-6f7a8b9c0d1e',
  bld: '7c2d8e9f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
  proj2: '8d3e9f0a-4b5c-4d6e-9f7a-8b9c0d1e2f3a',
});

const id = (type, code, proj = T.proj) => legacyEntityId(T.ns, proj, type, code);

export function makeDoc({ proj = T.proj, points: pOver = {}, extraPoints = [], assets: aOver = {}, bindings: bOver = null } = {}) {
  const scope = { organizationId: T.org, projectId: proj, buildingId: T.bld };
  const floor = (code, order) => ({
    id: id('floor', code, proj), code, name: `ชั้น ${code}`, order, ...scope,
    frame: { transform: [20, 0, -10, 0, 4, -2], elevation: order * 0.8, height: 0.8 },
    floorPlanVersion: `sha256:plan-${code}`, modelVersion: `sha256:model-${code}`,
  });
  const pos = (u, v, floorCode = 'G') => ({ plan: { u, v }, xyz: null, mappingStatus: 'unanchored', anchor: null, remapReasons: [],
    resolvedAgainst: { coordinateSystemVersion: 'crs-1', floorPlanVersion: `sha256:plan-${floorCode}`, modelVersion: `sha256:model-${floorCode}` } });
  const point = (code, floorCode, metrics, over = {}) => ({
    id: id('point', code, proj), pointCode: code, ...scope, floorId: id('floor', floorCode, proj), areaId: null,
    sourceKey: code, name: `จุด ${code}`, system: 'water', status: 'active', isDemo: true,
    installation: { status: 'installed' }, position: pos(0.5, 0.5, floorCode),
    metrics: metrics.map((m) => ({ id: m, sourceKey: m, name: m, kind: 'numeric', unit: 'x', staleAfterSec: 60 })), ...over,
  });
  const points = [
    point('WL-1', 'G', ['level'], pOver['WL-1']),
    point('P-1', 'G', ['run', 'current'], pOver['P-1']),
    point('T-1', '1', ['temp', 'rh'], pOver['T-1']),
    ...extraPoints.map((e) => point(e.code, e.floor ?? 'G', e.metrics, e.over)),
  ];
  const asset = (code, type, pointCode, over = {}) => ({
    id: id('asset', code, proj), assetCode: code, ...scope, type, name: code, isDemo: true,
    floorId: points.find((p) => p.pointCode === pointCode).floorId, areaId: null,
    installation: { status: 'installed' }, position: pos(0.5, 0.5), visual: null, ...over,
  });
  const assets = [asset('DEMO-PIT-1', 'pit', 'WL-1', aOver['DEMO-PIT-1']), asset('DEMO-PUMP-1', 'pump', 'P-1', aOver['DEMO-PUMP-1'])];
  const binding = (assetCode, pointCode, role, metricId) => ({
    id: id('binding', `${assetCode}:${role}:${metricId}`, proj), ...scope,
    assetId: id('asset', assetCode, proj), pointId: id('point', pointCode, proj), role, metricId,
  });
  const bindings = bOver ?? [binding('DEMO-PIT-1', 'WL-1', 'level', 'level'), binding('DEMO-PUMP-1', 'P-1', 'run', 'run'), binding('DEMO-PUMP-1', 'P-1', 'current', 'current')];
  return {
    schemaVersion: 6,
    organization: { id: T.org, namespaceId: T.ns, name: 'องค์กรทดสอบ' },
    project: { id: proj, organizationId: T.org, code: 'TST', name: 'โครงการทดสอบ', settings: {} },
    building: { id: T.bld, organizationId: T.org, projectId: proj, code: 'B1', name: 'อาคารทดสอบ', coordinateSystem: { version: 'crs-1' } },
    floors: [floor('G', 0), floor('1', 1)],
    areas: [],
    points, assets, bindings, rules: [],
  };
}

export { id as fixtureId };
