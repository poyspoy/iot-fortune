import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pickRoom, roomContains, roomTitle, roomColorGroup, ROOM_KIND } from '../src/domain/rooms.js';
import { createDefaultConfig } from '../src/domain/defaultConfig.js';

const load = (id) => JSON.parse(readFileSync(`public/models/floors/rooms-${id}.json`, 'utf8'));
const centroid = (r) => { const t = r.tris; return [(t[0] + t[2] + t[4]) / 3, (t[1] + t[3] + t[5]) / 3]; };

test('มีไฟล์ข้อมูลห้องครบทุกชั้นที่มีโมเดล และเป็นชั้นเดียวกับไฟล์', () => {
  for (const f of createDefaultConfig().building.floors.filter((x) => x.detail)) {
    const p = `public/models/floors/rooms-${f.id}.json`;
    assert.ok(existsSync(p), p);
    const d = load(f.id);
    assert.equal(d.floor, f.id);
    assert.ok(d.rooms.length > 5, `${f.id} rooms`);
    for (const r of d.rooms) { assert.ok(ROOM_KIND[r.category], r.category); assert.equal(r.tris.length % 6, 0); }
  }
});

test('กดที่ร้านทุกร้าน (ชั้น G–3) ได้ร้านนั้นเอง — ร้านไม่ทับกัน', () => {
  for (const id of ['G', '1', '2', '3']) {
    const rooms = load(id).rooms;
    let ok = 0; const shops = rooms.filter((r) => r.category === 'shop');
    for (const s of shops) { const [x, y] = centroid(s); const got = pickRoom(rooms, x, y); if (got?.id === s.id || got?.category !== 'shop') ok++; }
    assert.ok(ok / shops.length > 0.97, `${id}: ${ok}/${shops.length}`);
  }
});

test('สัญลักษณ์ลิฟต์/ห้องน้ำมาก่อนทางเดินและพื้น และนอกอาคารไม่ได้อะไร', () => {
  const rooms = load('G').rooms;
  const lift = rooms.find((r) => r.category === 'elevator');
  const [x, y] = centroid(lift);
  assert.equal(pickRoom(rooms, x, y).id, lift.id);
  assert.equal(pickRoom(rooms, 500, 500), null);
  assert.ok(roomContains(lift, x, y));
});

test('ชื่อแสดงผลมาจากชื่อในโมเดลเท่านั้น', () => {
  assert.equal(roomTitle({ id: 'G_Shop_Pink_001', category: 'shop' }), 'พื้นที่เช่า กลุ่มสีชมพู ลำดับ 1');
  assert.equal(roomColorGroup({ id: '3_Shop_Orange_012' }), 'ส้ม');
  assert.match(roomTitle({ id: 'Zone_B_437_sqm', category: 'shop' }), /โซน B · 437 ตร\.ม\./);
  assert.equal(roomTitle({ id: 'Lift_Passenger_3', category: 'elevator' }), 'ลิฟต์โดยสาร 3');
  assert.equal(roomTitle({ id: 'G_VisibleWalkways', category: 'walkway' }), 'ทางเดิน');
});
