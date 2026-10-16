// ลิฟต์จำลอง (ไม่ใช่ข้อมูลลิฟต์จริง) — ตรรกะล้วน ไม่ขึ้นกับ three.js จึงทดสอบด้วย Node ได้
//
// ลำดับการทำงานต่อหนึ่งคำสั่ง:  open → closing → moving → opening → open
//   - ประตูต้องปิดสนิทก่อนออกตัว
//   - เคลื่อนที่แบบค่อย ๆ ออกตัว/ชะลอก่อนหยุด (ความเร็วเป็นศูนย์ที่ต้นทางและปลายทาง)
//   - เมื่อจบช่วงเคลื่อนที่ ตำแหน่งถูกตั้งเท่ากับชั้นปลายทางพอดี แล้วประตูจึงเริ่มเปิด
//   - ระหว่าง closing / moving / opening ไม่รับคำสั่งใหม่ (ปุ่มถูกปิดชั่วคราว)
//
// ตำแหน่งลิฟต์ (pos) เป็น "ดัชนีชั้นแบบต่อเนื่อง" 0 … n−1 ตามลำดับชั้นที่ลิฟต์จอด
// ฉาก 3D แปลง pos เป็นความสูงจริงด้วยระดับพื้นของแต่ละชั้น — pos เป็นจำนวนเต็มเมื่อพื้นห้องลิฟต์ตรงพื้นชั้น

export const ELEVATOR_TIMING = Object.freeze({
  doorMs: 1400, // เวลาปิด/เปิดประตู
  perFloorMs: 1500, // เวลาเดินทางต่อชั้น
  minTravelMs: 2200, // เวลาเดินทางขั้นต่ำ (ระยะ 1 ชั้นก็ยังเห็นการออกตัว/ชะลอ)
});

/**
 * ลิฟต์ตัวแรก (L1) — ตำแหน่งปล่องจากสัญลักษณ์ลิฟต์ในผังต้นฉบับ/โมเดล Blender ของผู้ใช้
 * โถงลิฟต์กลางห้างพบในผังชั้น G, 1, 2, 3 ตำแหน่งใกล้กัน (ต่างกันไม่เกิน ~2 ม.)
 * ชั้น 4 และ 5 ไม่มีสัญลักษณ์ลิฟต์ที่ตำแหน่งนี้ จึงยังไม่ให้ลิฟต์ตัวนี้จอด (รอยืนยัน)
 * พิกัด x/z เป็นพิกัดโมเดลของแอป (ค่าเฉลี่ยของตำแหน่งสัญลักษณ์ 4 ชั้น) — เป็นการจัดวางเชิงแผนภาพ ไม่ใช่การสำรวจ
 */
export const ELEVATOR_L1 = Object.freeze({
  id: 'L1',
  name: 'ลิฟต์โดยสาร L1',
  floors: Object.freeze(['G', '1', '2', '3']),
  x: -1.62,
  z: 0.05,
  shaft: Object.freeze({ w: 0.3, d: 0.3 }), // ≈ 2.5 × 2.5 ม. ตามสเกลผัง
  car: Object.freeze({ w: 0.23, d: 0.23, h: 0.33 }),
  doorSide: '+z', // ทิศหน้าประตู: ผังไม่ระบุ — สมมติหันไปทางด้านหน้าโมเดล
  evidence: Object.freeze([
    { floor: 'G', object: 'Elevators_Location.001', x: -1.589, z: 0.043 },
    { floor: '1', object: 'Elevators_Location.005', x: -1.743, z: 0.126 },
    { floor: '2', object: 'Elevators_Location.012', x: -1.636, z: -0.088 },
    { floor: '3', object: 'Elevators_Location.015', x: -1.517, z: 0.126 },
  ]),
  note: 'จำลองการทำงาน ไม่ได้เชื่อมข้อมูลลิฟต์จริง · ตำแหน่งปล่องตามสัญลักษณ์ลิฟต์ในผังชั้น G–3 · ทิศประตูสมมติ',
});

/** ความเร็วเป็นศูนย์ที่ต้นและปลาย (ease-in-out แบบโคไซน์) */
export function easeInOut(k) {
  const t = Math.min(1, Math.max(0, k));
  return (1 - Math.cos(Math.PI * t)) / 2;
}

export function travelMs(fromIdx, toIdx, timing = ELEVATOR_TIMING) {
  return Math.max(timing.minTravelMs, Math.abs(toIdx - fromIdx) * timing.perFloorMs);
}

/** สร้างสถานะเริ่มต้น: จอดที่ชั้นแรก ประตูเปิด */
export function createElevator(spec = ELEVATOR_L1, { startFloor, now = 0, timing = ELEVATOR_TIMING } = {}) {
  const floors = [...spec.floors];
  const idx = Math.max(0, startFloor != null ? floors.indexOf(String(startFloor)) : 0);
  return {
    floors, timing,
    phase: 'open', // open | closing | moving | opening
    pos: idx, // ดัชนีชั้นต่อเนื่อง
    door: 1, // 0 = ปิดสนิท, 1 = เปิดสุด
    from: idx, to: idx,
    phaseStart: now,
    arrived: true, // จอดตรงชั้นแล้ว (pos เป็นจำนวนเต็มเท่ากับ to)
    trips: 0,
  };
}

/**
 * สั่งไปชั้น — คืน { state, result }
 *   result: 'started' | 'same-floor' | 'busy' | 'unknown-floor'
 */
export function requestFloor(state, floorId, now) {
  const idx = state.floors.indexOf(String(floorId));
  if (idx < 0) return { state, result: 'unknown-floor' };
  if (state.phase !== 'open') return { state, result: 'busy' };
  if (idx === state.to && state.arrived) return { state, result: 'same-floor' };
  return { state: { ...state, phase: 'closing', from: state.to, to: idx, phaseStart: now, arrived: false }, result: 'started' };
}

/** เดินสถานะตามเวลา (บริสุทธิ์ — คืนสถานะใหม่) รองรับการกระโดดเวลาหลายช่วงในครั้งเดียว */
export function stepElevator(state, now) {
  let s = state;
  for (let guard = 0; guard < 4; guard++) {
    const t = now - s.phaseStart;
    const T = s.timing;
    if (s.phase === 'closing') {
      if (t < T.doorMs) return { ...s, door: 1 - easeInOut(t / T.doorMs) };
      s = { ...s, door: 0, phase: 'moving', phaseStart: s.phaseStart + T.doorMs };
    } else if (s.phase === 'moving') {
      const dur = travelMs(s.from, s.to, T);
      if (t < dur) return { ...s, door: 0, pos: s.from + (s.to - s.from) * easeInOut(t / dur) };
      // หยุดตรงชั้นพอดีก่อน แล้วจึงเริ่มเปิดประตู
      s = { ...s, pos: s.to, arrived: true, phase: 'opening', phaseStart: s.phaseStart + dur };
    } else if (s.phase === 'opening') {
      if (t < T.doorMs) return { ...s, door: easeInOut(t / T.doorMs) };
      s = { ...s, door: 1, phase: 'open', phaseStart: s.phaseStart + T.doorMs, trips: s.trips + 1 };
    } else {
      return s;
    }
  }
  return s;
}

/** ข้อความ/ค่าสถานะสำหรับแสดงผล — คำนวณจาก pos/phase เดียวกับที่ฉากใช้วาดห้องลิฟต์ */
export function elevatorStatus(state) {
  const { floors, phase } = state;
  const target = floors[state.to];
  const nearest = floors[Math.min(floors.length - 1, Math.max(0, Math.round(state.pos)))];
  const direction = phase === 'closing' || phase === 'moving' ? (state.to > state.from ? 'up' : 'down') : null;
  const doors = { open: 'open', closing: 'closing', moving: 'closed', opening: 'opening' }[phase];
  const doorText = { open: 'ประตูเปิด', closing: 'กำลังปิดประตู', closed: 'ประตูปิด', opening: 'กำลังเปิดประตู' }[doors];
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '';
  let headline;
  if (phase === 'open' || phase === 'opening') headline = state.trips === 0 && phase === 'open' ? `จอดที่ชั้น ${target}` : `ถึงชั้น ${target}`;
  else headline = `${arrow} ${direction === 'up' ? 'ขึ้น' : 'ลง'}ไปชั้น ${target}`;
  return {
    phase, target, direction, doors, doorText, headline,
    arrow,
    position: state.pos,
    nearest, // ชั้นที่ห้องลิฟต์อยู่ใกล้ที่สุดตอนนี้ (ตามตำแหน่งที่เห็น)
    atFloor: state.arrived ? target : null,
    buttonsEnabled: phase === 'open',
    detail: phase === 'moving' ? `ผ่านระดับชั้น ${nearest}` : '',
  };
}
