// ย้ายฐานข้อมูลในเบราว์เซอร์ (IndexedDB) v5 → v6 แบบไม่แตะฐานเดิม
// - อ่านฐานเดิมแบบอ่านอย่างเดียว (ไม่เปิดแบบอัปเกรด ไม่มี transaction เขียน) → ฐานเดิม = สำรอง + ทางย้อนกลับ
// - เขียนลงฐานใหม่ชื่อ `<ชื่อเดิม>@v6` · เก็บสำเนา config v5 ทั้งก้อนใน kv 'migration.backup.v5'
// - คีย์ Telemetry ชนกัน = หยุดก่อนสร้างฐานใหม่ คืนรายการที่ชน (ไม่เลือก ไม่เขียนทับ)
// - ผิดพลาดระหว่างเขียน = ลบฐานใหม่ที่เขียนไม่ครบทิ้ง (ฐานเดิมไม่ถูกแตะอยู่แล้ว)
import { migrateConfig } from '../domain/migrate.js';
import { migrateConfigToV6, sampleIdV6 } from './migrateV6.js';

export const V6_DB_VERSION = 1;
export const v6Name = (sourceName) => `${sourceName}@v6`;
export const BACKUP_KEY = 'migration.backup.v5';
export const REPORT_KEY = 'migration.report';

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error ?? new Error('aborted')); });

/** เปิดฐานที่มีอยู่แล้วโดยไม่อัปเกรด — ถ้าไม่มี คืน null และลบฐานว่างที่เผลอสร้างทิ้ง */
async function openExisting(idb, name) {
  let created = false;
  const r = idb.open(name);
  r.onupgradeneeded = () => { created = true; };
  const db = await req(r);
  if (created) { db.close(); await req(idb.deleteDatabase(name)); return null; }
  return db;
}

async function exists(idb, name) {
  if (typeof idb.databases === 'function') return (await idb.databases()).some((d) => d.name === name);
  const db = await openExisting(idb, name);
  if (db) db.close();
  return !!db;
}

/** อ่านทุก store ของฐาน v5 (อ่านอย่างเดียว) */
export async function dumpDb(idb, name) {
  const db = await openExisting(idb, name);
  if (!db) return null;
  try {
    const stores = [...db.objectStoreNames];
    const tx = db.transaction(stores, 'readonly');
    const out = {};
    for (const s of stores) out[s] = await req(tx.objectStore(s).getAll());
    await txDone(tx);
    return out;
  } finally { db.close(); }
}

function openV6(idb, name) {
  const r = idb.open(name, V6_DB_VERSION);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('kv', { keyPath: 'key' });
    const s = db.createObjectStore('samples', { keyPath: 'id' });
    s.createIndex('bySeries', ['source', 'pointId', 'metricId', 'observedAt']);
    s.createIndex('byObserved', 'observedAt');
    s.createIndex('bySource', 'source');
    const e = db.createObjectStore('episodes', { keyPath: 'id' });
    e.createIndex('bySource', 'source');
    const a = db.createObjectStore('rejected_ingestion', { keyPath: 'seq', autoIncrement: true });
    a.createIndex('byProject', 'projectId');
    a.createIndex('byReceived', 'receivedAt');
  };
  return req(r);
}

/**
 * @param {{ indexedDB: IDBFactory, sourceName: string, tenancy: object, manifest: object|null, now?: () => number }} o
 * @returns {Promise<{ ok: boolean, stage?: string, conflicts?: Array, errors?: string[], targetName?: string, existing?: boolean, counts?: object }>}
 */
export async function migrateDatabase({ indexedDB: idb, sourceName, tenancy, manifest, now = () => Date.now() }) {
  const targetName = v6Name(sourceName);
  if (await exists(idb, targetName)) return { ok: true, existing: true, targetName };
  const src = await dumpDb(idb, sourceName);
  if (!src) return { ok: false, stage: 'no-source', errors: ['ไม่มีฐานข้อมูลเดิม'] };
  const kv = new Map((src.kv ?? []).map((r) => [r.key, r.value]));
  const raw = kv.get('config');
  if (!raw) return { ok: false, stage: 'no-config', errors: ['ฐานข้อมูลเดิมไม่มีการตั้งค่า'] };
  const v5 = migrateConfig(raw); // v1–v4 → v5 ด้วยกติกาเดิม (คืนสำเนาใหม่)
  const res = migrateConfigToV6(v5, { tenancy, manifest });
  if (!res.ok) return { ...res, targetName };
  const { doc, idMap } = res;
  const pid = (code) => idMap.point[code] ?? null;

  const unknown = new Set();
  const samples = (src.samples ?? []).map((s) => {
    const id = pid(s.pointId);
    if (!id) { unknown.add(s.pointId); return null; }
    return { ...s, pointId: id, id: sampleIdV6(s.source, id, s.metricId, s.observedAt), legacyPointCode: s.pointId };
  });
  const episodes = (src.episodes ?? []).map((e) => {
    const id = pid(e.pointId);
    if (!id) { unknown.add(e.pointId); return null; }
    return { ...e, pointId: id, ruleId: idMap.rule[e.ruleId] ?? e.ruleId, legacyPointCode: e.pointId };
  });
  if (unknown.size) return { ok: false, stage: 'orphans', errors: [`ข้อมูลอ้างถึงจุดที่ไม่มีในการตั้งค่า: ${[...unknown].join(', ')}`], targetName };

  const outKv = [];
  for (const [key, value] of kv) {
    if (key === 'config') continue;
    const v = structuredClone(value);
    if (key === 'ui' && v?.selectedId) v.selectedId = pid(v.selectedId);
    if (key === 'settings' && v?.demo?.lossPointId) v.demo = { ...v.demo, lossPointId: pid(v.demo.lossPointId) ?? v.demo.lossPointId };
    outKv.push({ key, value: v });
  }
  outKv.push({ key: 'config', value: doc });
  outKv.push({ key: BACKUP_KEY, value: { sourceName, sourceSchemaVersion: raw.schemaVersion, at: now(), config: structuredClone(raw) } });
  const counts = { samples: samples.length, episodes: episodes.length, kv: kv.size, points: doc.points.length, assets: doc.assets.length, bindings: doc.bindings.length };
  outKv.push({ key: REPORT_KEY, value: { at: now(), sourceName, targetName, counts, idMap } });

  let db = null;
  try {
    db = await openV6(idb, targetName);
    const tx = db.transaction(['kv', 'samples', 'episodes'], 'readwrite');
    for (const r of outKv) tx.objectStore('kv').put(r);
    for (const s of samples) tx.objectStore('samples').put(s);
    for (const e of episodes) tx.objectStore('episodes').put(e);
    await txDone(tx);
  } catch (e) {
    db?.close(); db = null;
    await req(idb.deleteDatabase(targetName)).catch(() => {});
    return { ok: false, stage: 'write', errors: [String(e?.message ?? e)], targetName };
  } finally { db?.close(); }
  return { ok: true, targetName, counts };
}

/** อ่าน config v5 ที่สำรองไว้ในฐาน v6 (ใช้กู้คืน/ตรวจย้อนหลัง) */
export async function readV5Backup(idb, sourceName) {
  const d = await dumpDb(idb, v6Name(sourceName));
  return d?.kv?.find((r) => r.key === BACKUP_KEY)?.value ?? null;
}

/** ย้อนกลับ: ลบฐาน v6 (ฐานเดิมไม่เคยถูกแก้ จึงใช้ต่อได้ทันที) */
export async function rollbackV6(idb, sourceName) {
  await req(idb.deleteDatabase(v6Name(sourceName)));
}
