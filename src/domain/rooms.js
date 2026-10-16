// ข้อมูลห้อง/พื้นที่จากโมเดล Blender ของผู้ใช้ (public/models/floors/rooms-<ชั้น>.json, ส่งออกด้วย scripts/blender/export_rooms.py)
// ไม่พึ่ง DOM/three.js — ทดสอบใน Node ได้
// ชื่อร้าน/เลขห้องที่พิมพ์ในผังเก็บเป็นภาพในโมเดล (ยังไม่ได้ถอดเป็นข้อความ) จึงไม่เดาเลขห้อง — แสดงภาพจากผังต้นฉบับแทน

export const ROOM_KIND = {
  shop: 'ร้าน / พื้นที่เช่า',
  walkway: 'ทางเดิน',
  elevator: 'ลิฟต์',
  escalator: 'บันไดเลื่อน',
  toilet: 'ห้องน้ำ',
  exit: 'ทางออก',
  stair: 'บันไดหนีไฟ',
  floor: 'พื้นอาคาร',
  door: 'ประตู',
};

// ลำดับความสำคัญเมื่อหลายพื้นที่ซ้อนกันที่จุดเดียว (สัญลักษณ์เล็ก > ร้าน > ทางเดิน > พื้น)
const PRIORITY = { elevator: 0, escalator: 0, toilet: 0, exit: 0, stair: 0, door: 1, shop: 2, walkway: 3, floor: 4 };

const COLOR_GROUP = { Pink: 'ชมพู', Green: 'เขียว', Orange: 'ส้ม' };

/** ชื่อแสดงผล (ภาษาไทย) จากชื่อวัตถุในโมเดล — ใช้เฉพาะสิ่งที่อยู่ในชื่อ ไม่เดาเพิ่ม */
export function roomTitle(room) {
  const id = room.id;
  let m;
  if ((m = /Shop_(Pink|Green|Orange)_(\d+)/.exec(id))) return `พื้นที่เช่า กลุ่มสี${COLOR_GROUP[m[1]]} ลำดับ ${Number(m[2])}`;
  if (/Parking/.test(id)) return 'ที่จอดรถ';
  if ((m = /^Zone_([A-Z])(?:_(Left|Right))?_(\d+)_sqm/.exec(id))) return `โซน ${m[1]}${m[2] ? (m[2] === 'Left' ? ' (ซ้าย)' : ' (ขวา)') : ''} · ${m[3]} ตร.ม. ตามชื่อในโมเดล`;
  if ((m = /^Lift_Passenger_(\d+)/.exec(id))) return `ลิฟต์โดยสาร ${m[1]}`;
  if (/^Lift_Goods/.test(id)) return 'ลิฟต์ขนของ';
  if (/^AHU_(\w+)/.test(id)) return `ห้องเครื่องปรับอากาศ (${id})`;
  if (/^Electrical/.test(id)) return 'ห้องไฟฟ้า';
  if (/Hotel/.test(id)) return 'พื้นที่โรงแรม (อ้างอิงตามผัง)';
  if (/Circulation/.test(id)) return 'พื้นที่สัญจร';
  if (/Interior/.test(id)) return 'พื้นที่ภายในอาคาร';
  if (/Outline/.test(id)) return 'พื้นอาคาร (ขอบเขต)';
  if (/FireStair/.test(id)) return `บันไดหนีไฟ${/West/.test(id) ? ' (ฝั่งตะวันตก)' : /East/.test(id) ? ' (ฝั่งตะวันออก)' : ''}`;
  if (/^Toilet_/.test(id)) return `ห้องน้ำ (${id.replace('Toilet_', '')})`;
  return ROOM_KIND[room.category] ?? id;
}

/** กลุ่มสีตามผัง (จากชื่อวัตถุ) — ความหมายของสีขึ้นกับคำอธิบายผังต้นฉบับ */
export function roomColorGroup(room) {
  const m = /Shop_(Pink|Green|Orange)/.exec(room.id);
  return m ? COLOR_GROUP[m[1]] : null;
}

function inTri(x, y, t, i) {
  const ax = t[i], ay = t[i + 1], bx = t[i + 2], by = t[i + 3], cx = t[i + 4], cy = t[i + 5];
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** จุด (X, Y) ในพิกัด Blender อยู่ในพื้นที่ (ผิวด้านบน) ของห้องหรือไม่ */
export function roomContains(room, X, Y) {
  const [x0, y0, x1, y1] = room.bbox;
  if (X < x0 - 1e-6 || X > x1 + 1e-6 || Y < y0 - 1e-6 || Y > y1 + 1e-6) return false;
  const t = room.tris;
  for (let i = 0; i < t.length; i += 6) if (inTri(X, Y, t, i)) return true;
  return false;
}

/** เลือกห้องที่จุดนั้น: ความสำคัญสูงก่อน (สัญลักษณ์ > ร้าน > ทางเดิน > พื้น) แล้วพื้นที่เล็กที่สุด */
export function pickRoom(rooms, X, Y) {
  let best = null;
  for (const r of rooms) {
    if (!roomContains(r, X, Y)) continue;
    const p = PRIORITY[r.category] ?? 5;
    if (!best || p < best.p || (p === best.p && r.area_m2 < best.r.area_m2)) best = { r, p };
  }
  return best?.r ?? null;
}

/** หมายเหตุจากไฟล์โมเดล (ค่าที่ผู้สร้างโมเดลบันทึกไว้) — ไม่รวมพิกัดดิบ */
export function roomNotes(room) {
  const label = {
    source_number: 'เลขห้อง', evidence: 'ที่มา', door_evidence: 'ที่มาประตู', vertical_rise: 'ความสูงระหว่างชั้น',
    source: 'ผังต้นฉบับ', reused_from_previous_G: 'ใช้ซ้ำจากโมเดล G รุ่นก่อน', rise: 'ความสูง', source_label: 'ป้าย',
  };
  return Object.entries(room.props ?? {}).filter(([k]) => k !== 'source_polygon').map(([k, v]) => ({ key: label[k] ?? k, value: v }));
}
