// ขอบเขตข้อมูลของโครงการ Fortune Demo — ค่าคงที่ สร้างครั้งเดียว ห้ามเปลี่ยน
// (UUID ของข้อมูลที่ย้ายจากรุ่นก่อนคำนวณจากค่าเหล่านี้ → ทุกเครื่องได้ UUID เดียวกัน)
// namespaceId แยกจาก organizationId และไม่ได้มาจากชื่อ/รหัสองค์กร

export const FORTUNE_TENANCY = Object.freeze({
  organization: Object.freeze({ id: '07fda8e7-e183-4174-9d18-9f16bcd92656', namespaceId: '93e09c66-06e5-4540-9abc-293dde3a26ad', name: 'Fortune Demo Organization' }),
  project: Object.freeze({
    id: '9e75d596-b5b8-4e96-a923-f575a1ebc3d5', code: 'FRT', name: 'IoT ฟอร์จูน (สาธิต)',
    // Fortune Demo: จุดใหม่ติดตั้งแล้วทันที เพื่อคง Flow เดิม — โครงการจริงไม่กำหนด = 'proposed'
    settings: Object.freeze({ defaultPointInstallStatus: 'installed' }),
  }),
  building: Object.freeze({ id: 'c9189748-40c5-4bc9-bd62-c618508e9061', code: 'FORTUNE-TOWN' }),
});

/**
 * อุปกรณ์เดิมของ Fortune (v5 มีเพียงข้อความ equipmentId) → Asset v6
 * ตำแหน่ง = ตำแหน่งบนผังของจุดที่ผูก · visual.offset = ระยะเลื่อนที่ฉาก 3D วาดอยู่ในปัจจุบัน (ไม่เปลี่ยนภาพ)
 * assetCode เป็นรหัสสาธิต (FRT-DEMO-*) ไม่ใช่รหัสอุปกรณ์จริง — ได้รหัสจริงแล้วแก้เฉพาะ assetCode
 */
export const FORTUNE_LEGACY_EQUIPMENT = Object.freeze({
  'PUMP-EX-01': Object.freeze({ type: 'pump', assetCode: 'FRT-DEMO-PUMP-001', name: 'ปั๊มน้ำ (สาธิต)', visual: Object.freeze({ kind: 'pump', offset: Object.freeze({ x: -0.6, z: 0 }) }), roles: Object.freeze({ run: 'run', current: 'current' }) }),
  'AHU-EX': Object.freeze({ type: 'ahu', assetCode: 'FRT-DEMO-AHU-001', name: 'เครื่องส่งลมเย็น AHU (สาธิต)', visual: null, roles: Object.freeze({ chws: 'temperature', chwr: 'temperature' }) }),
});

/** ภาพถัง/บ่อจากค่าวัดที่มี gauge (v5) */
export const FORTUNE_GAUGE_ASSETS = Object.freeze({
  pit: Object.freeze({ type: 'pit', codePrefix: 'FRT-DEMO-PIT-', namePrefix: 'บ่อสูบน้ำ (สาธิต)', offset: Object.freeze({ x: 0.42, z: 0 }) }),
  tank: Object.freeze({ type: 'tank', codePrefix: 'FRT-DEMO-TANK-', namePrefix: 'ถังเก็บน้ำ (สาธิต)', offset: Object.freeze({ x: 0.42, z: 0 }) }),
});
