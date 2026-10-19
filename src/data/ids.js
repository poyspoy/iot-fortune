// รหัสถาวร (UUID) ของ Entity ใน Data Layer — ไม่พึ่ง DOM/WebGL/ไลบรารีภายนอก ทำงานได้ทั้งเบราว์เซอร์และ Node
// - uuidv4(): ของที่สร้างใหม่
// - uuidv5(namespace, name): รหัสที่กำหนดได้ (deterministic) สำหรับข้อมูลที่ย้ายจากรุ่นก่อน
//   ใช้ namespace = organization.namespaceId (ถาวรขององค์กร) และ name = `${projectId}:${entityType}:${legacyCode}`
//   (DATA-LAYER-PLAN ข้อ 2.1) — UUID ที่สร้างแล้วเก็บถาวร ไม่คำนวณใหม่เมื่อรหัสแสดงผลเปลี่ยน

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** ตรวจรูปแบบ UUID (ตัวพิมพ์เล็ก รุ่น 1–8, variant RFC 4122) */
export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20, 32)}`;
}

function uuidBytes(u) {
  if (!isUuid(u)) throw new TypeError(`namespace ต้องเป็น UUID: ${u}`);
  const h = u.replace(/-/g, '');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
}

/** UUID รุ่น 4 (สุ่ม) */
export function uuidv4(rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const b = rand(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return hex(b);
}

// SHA-1 แบบ synchronous (ใช้เฉพาะสร้าง UUID v5 ตาม RFC 4122 — ไม่ใช้เพื่อความปลอดภัย)
function sha1(bytes) {
  const ml = bytes.length;
  const withPad = new Uint8Array(((ml + 9 + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[ml] = 0x80;
  const bitLen = ml * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 2 ** 32));
  dv.setUint32(withPad.length - 4, bitLen >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((v, i) => odv.setUint32(i * 4, v));
  return out;
}

/** UUID รุ่น 5 (RFC 4122): SHA-1 ของ namespace + name (UTF-8) */
export function uuidv5(namespace, name) {
  if (typeof name !== 'string' || !name) throw new TypeError('name ต้องเป็นข้อความที่ไม่ว่าง');
  const ns = uuidBytes(namespace);
  const nb = new TextEncoder().encode(name);
  const buf = new Uint8Array(ns.length + nb.length);
  buf.set(ns); buf.set(nb, ns.length);
  const b = sha1(buf).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  return hex(b);
}

export const ENTITY_TYPES = Object.freeze(['organization', 'project', 'building', 'floor', 'area', 'point', 'asset', 'binding']);

/**
 * UUID ของข้อมูลที่ย้ายจากรุ่นก่อน — namespace ถาวรขององค์กร + Project UUID + ชนิด + รหัสเดิม
 * ห้ามใช้ projectCode (อาจซ้ำ/เปลี่ยนได้)
 */
export function legacyEntityId(orgNamespaceId, projectId, entityType, legacyCode) {
  if (!isUuid(projectId)) throw new TypeError(`projectId ต้องเป็น UUID: ${projectId}`);
  if (!ENTITY_TYPES.includes(entityType)) throw new TypeError(`ชนิด Entity ไม่รู้จัก: ${entityType}`);
  if (typeof legacyCode !== 'string' || !legacyCode) throw new TypeError('ต้องมีรหัสเดิม');
  return uuidv5(orgNamespaceId, `${projectId}:${entityType}:${legacyCode}`);
}
