// Playground ข้อมูลทดลองของ Data Layer — เปิดเฉพาะ Branch Preview ของสาขา feature/data-layer
//
// เงื่อนไขเปิด (ต้องครบทุกข้อ):
//   1) build นี้สร้างจากสาขา feature/data-layer (Cloudflare ส่งชื่อสาขาตอน build → __DL_PLAYGROUND__) หรือสั่ง DL_PLAYGROUND=1 ตอน build ในเครื่อง
//   2) ฐานข้อมูลชื่อขึ้นต้นด้วย data-layer-playground (?db=data-layer-playground…)
//   3) ไม่ใช่โดเมน Demo หลัก (iot-fortune-preview.pages.dev) หรือ GitHub Pages
// ข้อมูลทดลองไม่ใช่ข้อมูลจริง · จุดที่เพิ่มในนี้ไม่มีค่าจำลอง (เดโมสร้างค่าเฉพาะจุดเดิมของฟอร์จูน)
import { createDefaultConfig } from '../domain/defaultConfig.js';
import { legacyEntityId } from './ids.js';
import { FORTUNE_TENANCY } from './fortuneTenancy.js';
import { OVERLAY_VERSION } from './runtime.js';

export const PLAYGROUND_DB = 'data-layer-playground';
export const PLAYGROUND_SEED_KEY = 'playground.seed';
export const PLAYGROUND_VERSION = 1;
const BLOCKED_HOSTS = ['iot-fortune-preview.pages.dev'];

export function playgroundEnabled({ buildFlag, dbParam, hostname = '' }) {
  if (!buildFlag) return false;
  if (typeof dbParam !== 'string' || !dbParam.startsWith(PLAYGROUND_DB)) return false;
  if (BLOCKED_HOSTS.includes(hostname) || hostname.endsWith('.github.io')) return false;
  return true;
}

const num = (id, name, unit, min, max, extra = {}) => ({
  id, sourceKey: id, name, kind: 'numeric', unit, decimals: 1, plausible: { min, max }, staleAfterSec: 120, explain: '', ...extra,
});
const disc = (id, name, states, extra = {}) => ({ id, sourceKey: id, name, kind: 'discrete', unit: '', states, staleAfterSec: 120, explain: '', ...extra });

/** จุดทดลองที่เพิ่มต่อท้ายจุดเดิมของฟอร์จูน (รหัส PG-* · ไม่มีค่าจำลอง) */
export function playgroundExtraPoints() {
  const base = { status: 'active', example: true, pos3d: null, equipmentId: '' };
  return [
    { ...base, id: 'PG-101', sourceKey: 'PG-101', name: 'เซนเซอร์น้ำรั่วห้องปั๊ม (ทดลอง · เสนอติดตั้ง)', system: 'water', floorId: 'G', areaId: 'G-SVC', plan: { x: 0.7, y: 0.8 },
      metrics: [disc('leak', 'เซนเซอร์น้ำรั่ว', [{ value: 'dry', label: 'แห้ง' }, { value: 'wet', label: 'เปียก' }])] },
    { ...base, id: 'PG-102', sourceKey: 'PG-102', name: 'อุณหภูมิโซนขายชั้น 3 (ทดลอง · รออนุมัติ)', system: 'environment', floorId: '3', areaId: '3-MALL', plan: { x: 0.4, y: 0.5 },
      metrics: [num('temp', 'อุณหภูมิห้อง', '°C', -10, 60)] },
    { ...base, id: 'PG-103', sourceKey: 'PG-103', name: 'มิเตอร์ไฟฟ้าย่อย (ทดลอง · อนุมัติแล้ว ยังไม่ติดตั้ง)', system: 'electrical', floorId: '1', areaId: '1-MALL', plan: { x: 0.6, y: 0.35 },
      metrics: [num('power', 'กำลังไฟฟ้า', 'kW', 0, 2000)] },
    { ...base, id: 'PG-104', sourceKey: 'PG-104', name: 'ถังน้ำสำรอง (ทดลอง · เสนอติดตั้ง)', system: 'water', floorId: '4', areaId: '4-MALL', plan: { x: 0.78, y: 0.56 },
      metrics: [num('level', 'ระดับน้ำในถัง', '%', 0, 100, { gauge: { min: 0, max: 100, visual: 'tank' } })] },
  ];
}

/** การตั้งค่าเริ่มต้นของ Playground = ฟอร์จูนเดิม + จุดทดลอง + กฎของจุดทดลอง (เพื่อพิสูจน์ว่าไม่แจ้งเตือน) */
export function playgroundConfig() {
  const c = createDefaultConfig();
  c.points.push(...playgroundExtraPoints());
  c.rules.push({ id: 'R-PG-102', pointId: 'PG-102', metricId: 'temp', type: 'high', enabled: true, sampleSetting: true, hysteresis: 0.5, dwellSec: 60, warning: 27, critical: 29 });
  return c;
}

/** overlay เริ่มต้น: สถานะติดตั้ง/ตำแหน่งของ Playground (คีย์เป็น UUID เดียวกับที่ migration สร้าง) */
export function playgroundOverlay(t = FORTUNE_TENANCY) {
  const pid = (code) => legacyEntityId(t.organization.namespaceId, t.project.id, 'point', code);
  const aid = (code) => legacyEntityId(t.organization.namespaceId, t.project.id, 'asset', code);
  return {
    version: OVERLAY_VERSION,
    points: {
      [pid('P-006')]: { installation: 'commissioned' },
      // ผังที่ใช้วางจุดนี้ต่างจากผังปัจจุบัน → ระบบตรวจพบ "ผังชั้นเปลี่ยน" เอง (ทางเดียวกับเมื่อไฟล์ผังจริงเปลี่ยน)
      [pid('P-005')]: { resolvedAgainst: { coordinateSystemVersion: 'crs-1', floorPlanVersion: 'sha256:playground-old-plan', modelVersion: null } },
      [pid('PG-101')]: { installation: 'proposed' },
      [pid('PG-102')]: { installation: 'pending_approval' },
      [pid('PG-103')]: { installation: 'approved' },
      [pid('PG-104')]: { installation: 'proposed' },
    },
    assets: {
      [aid('FRT-DEMO-TANK-002')]: { installation: 'proposed' },
      // อุปกรณ์ยังเป็น "เสนอ" แต่จุดติดตั้งแล้ว → ขึ้นรายการตรวจสอบ (status-mismatch) โดยจุดยังรับข้อมูลตามกติกา
      [aid('FRT-DEMO-AHU-001')]: { installation: 'proposed' },
      [aid('FRT-DEMO-PUMP-001')]: { mapping: { status: 'needs_remapping', reasons: ['manual'] } },
    },
  };
}
