import { parseEngineering } from '../domain/engineering.js';

// แหล่งข้อมูลแบบวิศวกรรม — ตอนนี้อ่านไฟล์จำลองจาก public/engineering/
// อนาคต: เปลี่ยนเฉพาะไฟล์นี้ให้เรียก Backend API หรือแปลงจาก DXF/SVG/GeoJSON แล้วส่งเข้า parseEngineering() เหมือนเดิม
const cache = new Map();

/** @returns {Promise<object|null>} ข้อมูลที่ผ่านการตรวจ (null = ชั้นนี้ยังไม่มีแบบ) */
export function loadEngineering(floorId) {
  if (!cache.has(floorId)) {
    cache.set(floorId, fetch(`engineering/floor-${encodeURIComponent(floorId)}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!json) return null;
        const r = parseEngineering(json);
        if (r.errors.length) console.warn('engineering data issues', r.errors);
        return r.data;
      })
      .catch(() => { cache.delete(floorId); return null; }));
  }
  return cache.get(floorId);
}

/** ชั้นที่มีตัวอย่างแบบวิศวกรรม (รอบนี้: ชั้น G) */
export const ENGINEERING_FLOORS = ['G'];
