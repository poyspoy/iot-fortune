import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * เตรียมโมเดลรายชั้นจาก Blender ของผู้ใช้ (GLB) สำหรับแสดงผล
 * - ไม่เปลี่ยนรูปทรง สี ป้าย หรือสัญลักษณ์: ใช้ geometry และวัสดุเดิมทุกชิ้น
 * - รวมชิ้นส่วนที่ใช้วัสดุเดียวกันเป็นก้อนเดียว (ตำแหน่งจุดยอดเดิมทุกจุด) เพื่อลดจำนวนการวาดต่อเฟรม
 *   เดิมหลายร้อยชิ้นต่อชั้น → เหลือเท่าจำนวนวัสดุ ทำให้แสดงทุกชั้นพร้อมกันในมุมมองทั้งอาคารได้
 * - ป้าย/ภาพต้นฉบับ (emissiveMap) แสดงสีตามภาพเดิมโดยไม่ขึ้นกับแสง (ตรงกับ Emission ใน Blender)
 * @param {THREE.Object3D} source  gltf.scene (ไม่ถูกแก้ไข)
 * @returns {{ group: THREE.Group, stats: { sourceMeshes:number, drawables:number, triangles:number } }}
 */
export function prepareDetail(source) {
  source.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(source.matrixWorld).invert();
  const buckets = new Map();
  let sourceMeshes = 0;
  source.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    sourceMeshes++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.length !== 1) { // หลายวัสดุในชิ้นเดียว — ไม่รวม คงไว้ตามเดิม
      const keep = new THREE.Mesh(o.geometry, o.material);
      keep.name = o.name;
      keep.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld));
      buckets.set(`solo-${o.uuid}`, { solo: keep });
      return;
    }
    const g = o.geometry;
    const m0 = mats[0];
    const geo = g.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld));
    // วัสดุสีล้วน (ไม่มีภาพ ไม่โปร่ง): เก็บสีเดิมไว้ที่จุดยอด (ค่าสีเดียวกันทุกประการ) แล้วรวมกับชิ้นที่ค่าวัสดุอื่นเหมือนกัน
    const bake = canBake(m0) && !geo.attributes.color;
    if (bake) {
      for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
      const n = geo.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = m0.color.r; col[i * 3 + 1] = m0.color.g; col[i * 3 + 2] = m0.color.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const attrs = Object.keys(geo.attributes).sort().join(',');
    const key = `${bake ? `baked|${materialKey(m0, true)}` : materialKey(m0)}|${attrs}|${geo.index ? 'i' : 'n'}`;
    for (const k of Object.keys(geo.morphAttributes)) delete geo.morphAttributes[k];
    let b = buckets.get(key);
    if (!b) {
      let material = m0; // วัสดุที่ค่าเหมือนกันทุกค่า ใช้ตัวแรก
      if (bake) { material = m0.clone(); material.color.set(1, 1, 1); material.vertexColors = true; material.name = 'baked-colors'; }
      b = { material, geos: [], names: [] }; buckets.set(key, b);
    }
    b.geos.push(geo);
    b.names.push(o.name);
  });
  const group = new THREE.Group();
  let triangles = 0;
  for (const b of buckets.values()) {
    if (b.solo) { group.add(b.solo); continue; }
    const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (!merged) { for (const gg of b.geos) group.add(makeMesh(gg, b.material)); continue; }
    if (b.geos.length > 1) for (const gg of b.geos) gg.dispose();
    const mesh = makeMesh(merged, b.material);
    mesh.name = b.names.length === 1 ? b.names[0] : `${b.material.name || 'material'} ×${b.names.length}`;
    mesh.userData.sourceNames = b.names;
    group.add(mesh);
  }
  group.traverse((m) => { if (m.isMesh) triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; });
  return { group, stats: { sourceMeshes, drawables: group.children.length, triangles: Math.round(triangles) } };
}

function makeMesh(geo, m) {
  let material = m;
  if (m?.emissiveMap) {
    material = new THREE.MeshBasicMaterial({ map: m.emissiveMap, side: m.side, toneMapped: false, transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest, name: m.name });
  } else if (m) {
    m.toneMapped = false; // คงโทนสีตามที่ออกแบบไว้ (ไม่ผ่าน ACES)
  }
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.castShadow = !m?.emissiveMap;
  return mesh;
}

/** ลายเซ็นค่าวัสดุ — วัสดุคนละชื่อแต่ค่าเหมือนกันทุกค่า (สี พื้นผิว ความโปร่ง ฯลฯ) แสดงผลเหมือนกัน จึงรวมกันได้ */
function canBake(m) {
  return !!m && m.isMeshStandardMaterial && !m.transparent && m.opacity >= 1 && !m.vertexColors
    && !m.map && !m.emissiveMap && !m.normalMap && !m.roughnessMap && !m.metalnessMap && !m.alphaMap && !m.aoMap;
}

function materialKey(m, ignoreColor = false) {
  if (!m) return 'none';
  const c = (x) => (x ? x.getHexString() : '-');
  const t = (x) => (x ? `${x.source?.uuid ?? x.uuid}:${x.offset.x},${x.offset.y},${x.repeat.x},${x.repeat.y},${x.rotation},${x.flipY},${x.channel ?? 0},${x.wrapS},${x.wrapT}` : '-');
  const r = (x) => (typeof x === 'number' ? x.toFixed(3) : '-');
  return [m.type, ignoreColor ? '*' : c(m.color), c(m.emissive), r(m.emissiveIntensity), r(m.roughness), r(m.metalness), r(m.opacity), m.transparent, m.side,
    r(m.alphaTest), m.vertexColors, m.depthWrite, t(m.map), t(m.emissiveMap), t(m.normalMap), t(m.roughnessMap), t(m.metalnessMap), t(m.alphaMap), t(m.aoMap)].join('|');
}
