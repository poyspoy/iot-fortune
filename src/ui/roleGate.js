// RoleGate — จุดเดียวที่ตัดสินว่าบทบาทปัจจุบันทำอะไรได้ (DATA-LAYER-PLAN ข้อ 2.6)
// Fortune Demo ยังไม่มีระบบผู้ใช้: บทบาทของเครื่อง = ผู้ดูแลระบบ (เหมือนวันนี้ที่ทุกคนเข้าหน้า "ตั้งค่า" ได้)
// ⚠ การซ่อนเมนูในหน้าเว็บไม่ใช่การควบคุมสิทธิ์ — ก่อน Production ต้องมี Authentication + Server-side Authorization
//   ตรวจ Project Membership/Role ทุกคำขอ (ห้ามเชื่อ projectId จาก Frontend)

export const ROLE_LABEL = Object.freeze({ admin: 'ผู้ดูแลระบบ', editor: 'ผู้แก้ไข', viewer: 'ผู้ดู' });

const PERMISSIONS = Object.freeze({
  admin: ['spatial.view', 'spatial.review', 'spatial.edit'],
  editor: ['spatial.view', 'spatial.review', 'spatial.edit'],
  viewer: [],
});

let role = 'admin';
export const currentRole = () => role;
/** สำหรับทดสอบ/เชื่อมระบบผู้ใช้ในอนาคต */
export function setRole(r) { if (r in PERMISSIONS) role = r; }
export const can = (action, r = role) => PERMISSIONS[r]?.includes(action) ?? false;
