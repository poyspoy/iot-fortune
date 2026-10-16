import * as THREE from 'three';
import { planTo3D } from '../domain/geometry.js';

// เส้นแบบวิศวกรรมซ้อนบนโมเดล 3 มิติ — สร้างจากข้อมูล (parseEngineering) ไม่แก้โมเดล/วัสดุเดิมของอาคาร
// ติดกับกลุ่มชั้นจึงเลื่อนตามชั้นเมื่อแยกดูชั้น · แต่ละระบบอยู่ระดับความสูงของตัวเอง ให้อ่านง่ายในมุม 3 มิติ:
//   กริดบนพื้น · ท่อประปาใกล้พื้น · รางสายไฟกลางชั้น · คานใต้ฝ้า · เสาเต็มความสูง

const LEVEL = { grid: 0.012, pipe: 0.1, valve: 0.1, cable: 0.46, panel: 0.3, device: 0.46, beam: 0.7 };
const RADIUS = { pipe: 0.026, cable: 0.018, beam: 0.03 };

export class EngineeringOverlay {
  /**
   * @param {object} data   ผลจาก parseEngineering
   * @param {object} floor  ข้อมูลชั้น (model/footprint)
   * @param {number} slabT  ความหนาแผ่นพื้นในฉาก
   * @param {number} height ความสูงชั้นในฉาก
   */
  constructor(data, floor, slabT, height) {
    this.data = data;
    this.group = new THREE.Group();
    this.group.name = `engineering-${floor.id}`;
    this.layers = new Map();
    this.pickables = [];
    this.byId = new Map();
    this.materials = [];
    const H = height;
    const pos = (xy, kind) => {
      const p = planTo3D(floor, { x: xy[0], y: xy[1] }, 0);
      return new THREE.Vector3(p.x, slabT + (kind === 'beam' ? H * 0.88 : LEVEL[kind] ?? 0.2), p.z);
    };
    const up = new THREE.Vector3(0, 1, 0);
    for (const l of data.layers) {
      const g = new THREE.Group();
      g.name = `eng-layer-${l.id}`;
      const color = new THREE.Color(l.color);
      const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.95 });
      const gridMat = new THREE.LineDashedMaterial({ color, dashSize: 0.18, gapSize: 0.1, transparent: true, opacity: 0.75, toneMapped: false });
      this.materials.push(mat, gridMat);
      const gridPts = [];
      for (const f of l.features) {
        const pts = f.geom.coords.map((c) => pos(c, f.kind));
        const parts = [];
        if (f.kind === 'grid') {
          for (let i = 0; i < pts.length - 1; i++) gridPts.push(pts[i], pts[i + 1]);
          // เส้นกริดคลิกได้ด้วยแถบบาง ๆ โปร่งใส (ไม่วาดทับ)
        }
        if (f.geom.type === 'LineString' && f.kind !== 'grid') {
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i]; const b = pts[i + 1];
            const len = a.distanceTo(b);
            if (len < 1e-4) continue;
            const r = RADIUS[f.kind] ?? 0.02;
            const geo = f.kind === 'beam' ? new THREE.BoxGeometry(r * 1.4, r * 2.4, len) : new THREE.CylinderGeometry(r, r, len, 8, 1);
            const m = new THREE.Mesh(geo, mat);
            m.position.copy(a).add(b).multiplyScalar(0.5);
            const dir = b.clone().sub(a).normalize();
            if (f.kind === 'beam') m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
            else m.quaternion.setFromUnitVectors(up, dir);
            parts.push(m);
          }
          // ข้อต่อ (มุมเลี้ยว) ให้เส้นต่อเนื่อง
          if (f.kind !== 'beam') for (const p of pts.slice(1, -1)) { const j = new THREE.Mesh(new THREE.SphereGeometry((RADIUS[f.kind] ?? 0.02) * 1.15, 10, 8), mat); j.position.copy(p); parts.push(j); }
        } else if (f.geom.type === 'Point') {
          const p = pts[0];
          let m;
          if (f.kind === 'column') { m = new THREE.Mesh(new THREE.BoxGeometry(0.11, H * 0.92, 0.11), mat); m.position.set(p.x, slabT + H * 0.46, p.z); }
          else if (f.kind === 'panel') { m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.08), mat); m.position.copy(p); }
          else if (f.kind === 'valve') { m = new THREE.Mesh(new THREE.OctahedronGeometry(0.075), mat); m.position.copy(p); }
          else { m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), mat); m.position.copy(p); }
          parts.push(m);
        }
        if (f.kind === 'grid') {
          // แถบคลิกของเส้นกริด (มองไม่เห็น)
          const a = pts[0]; const b = pts[pts.length - 1];
          const hit = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, a.distanceTo(b)), new THREE.MeshBasicMaterial({ visible: false }));
          hit.position.copy(a).add(b).multiplyScalar(0.5);
          hit.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
          parts.push(hit);
        }
        const fgp = new THREE.Group();
        fgp.name = `eng-${f.id}`;
        for (const m of parts) { m.userData.engId = f.id; m.renderOrder = 8; fgp.add(m); this.pickables.push(m); }
        g.add(fgp);
        this.byId.set(f.id, { group: fgp, layerId: l.id, mat });
      }
      if (gridPts.length) {
        const lg = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPts), gridMat);
        lg.computeLineDistances();
        lg.renderOrder = 7;
        g.add(lg);
      }
      this.layers.set(l.id, { group: g, mat, gridMat, color });
      this.group.add(g);
    }
    this.selMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
    this.materials.push(this.selMat);
  }

  /** เปิด/ปิดแต่ละระบบ (visibility = { structure: true, ... }) */
  setVisibility(vis) {
    for (const [id, l] of this.layers) l.group.visible = vis[id] !== false;
  }

  /** ไฮไลต์ชิ้นที่เลือก (สีขาว) — คืนสีเดิมเมื่อเลือกชิ้นอื่น */
  select(id) {
    if (this.selected) for (const m of this.selected.group.children) if (m.material === this.selMat) m.material = this.selected.mat;
    this.selected = id ? this.byId.get(id) ?? null : null;
    if (this.selected) for (const m of this.selected.group.children) if (m.material?.visible !== false) m.material = this.selMat;
  }

  /** วัตถุที่คลิกได้ (เฉพาะระบบที่แสดงอยู่) */
  visiblePickables() {
    return this.pickables.filter((m) => { for (let o = m; o; o = o.parent) if (!o.visible) return false; return true; });
  }

  /** ค่อย ๆ ปรากฏ (0–1) */
  setFade(k) {
    for (const l of this.layers.values()) { l.mat.opacity = 0.95 * k; l.gridMat.opacity = 0.75 * k; }
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => o.geometry?.dispose?.());
    for (const m of this.materials) m.dispose();
  }
}
