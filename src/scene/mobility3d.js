import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ภาพคนและรถจำลองแบบเรียบ สุภาพ (ไม่เหมือนเกม) — ใช้ InstancedMesh: คนทั้งหมด 1 ชุด รถ 1 ชุด เงานุ่ม 1 ชุด
// ไม่มีลูปแยกต่อตัว: update() ถูกเรียกจากลูปวาดหลักของฉากครั้งเดียวต่อเฟรม

const PEOPLE_COLORS = ['#3f6e72', '#5c6f78', '#8a7a62', '#4f7a63', '#7a5f63', '#56688a', '#9a968c', '#36494f', '#2f8f83']; // โทนหม่น เข้ากับ CI Nexza
const CAR_COLORS = ['#e7e9e6', '#9aa6ab', '#4f5d63', '#c9c3b6', '#2f8f83', '#b8c3c6'];
const MAX_PEOPLE = 24; const MAX_CARS = 8;

function blobTexture(inner = 'rgba(0,0,0,0.45)') {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  gr.addColorStop(0, inner); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class MobilityView {
  /**
   * @param {import('../domain/mobilitySim.js').MobilitySim} sim
   * @param {{ floorGroup: THREE.Object3D, floorY: number, outdoor: THREE.Object3D, small: boolean, vehicles: object }} o
   */
  constructor(sim, { floorGroup, floorY, outdoor, small, vehicles }) {
    this.sim = sim;
    this.small = small;
    const seg = small ? 6 : 10;
    // คน: ลำตัวทรงแคปซูลเรียบ + ศีรษะ (สูง ~1.7 ม. ตามสเกลผัง)
    const body = new THREE.CylinderGeometry(0.03, 0.034, 0.17, seg, 1); body.translate(0, 0.085, 0); // สูงรวม ~0.24 หน่วย ≈ 1.7 ม.
    const head = new THREE.SphereGeometry(0.029, seg, Math.max(4, seg - 2)); head.translate(0, 0.212, 0);
    this.peopleGeo = mergeGeometries([body, head]); body.dispose(); head.dispose();
    this.peopleMat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 });
    this.people = new THREE.InstancedMesh(this.peopleGeo, this.peopleMat, MAX_PEOPLE);
    this.people.name = 'mobility-people';
    this.people.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.people.frustumCulled = false;
    // รถ: ตัวถังมนเล็กน้อย + ห้องโดยสาร (ยาว ~4.6 ม.)
    const carBody = new THREE.BoxGeometry(0.22, 0.075, 0.54); carBody.translate(0, 0.055, 0);
    const cabin = new THREE.BoxGeometry(0.19, 0.07, 0.28); cabin.translate(0, 0.125, -0.03);
    const glass = new THREE.BoxGeometry(0.195, 0.045, 0.27); glass.translate(0, 0.128, -0.03);
    this.carGeo = mergeGeometries([carBody, cabin]); carBody.dispose(); cabin.dispose();
    this.glassGeo = glass;
    this.carMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.15 });
    this.glassMat = new THREE.MeshStandardMaterial({ color: '#2a3a40', roughness: 0.2, metalness: 0.3 });
    this.cars = new THREE.InstancedMesh(this.carGeo, this.carMat, MAX_CARS);
    this.carGlass = new THREE.InstancedMesh(this.glassGeo, this.glassMat, MAX_CARS);
    for (const m of [this.cars, this.carGlass]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.name = 'mobility-cars'; }
    const col = new THREE.Color();
    for (let i = 0; i < MAX_PEOPLE; i++) this.people.setColorAt(i, col.set(PEOPLE_COLORS[i % PEOPLE_COLORS.length]));
    for (let i = 0; i < MAX_CARS; i++) this.cars.setColorAt(i, col.set(CAR_COLORS[i % CAR_COLORS.length]));
    // เงานุ่มใต้ตัว (ไม่ใช้ shadow map — ประหยัด) · ปิดบนมือถือ
    this.blobTex = small ? null : blobTexture();
    this.blobMat = small ? null : new THREE.MeshBasicMaterial({ map: this.blobTex, transparent: true, depthWrite: false });
    this.blobGeo = small ? null : new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    // คน: วงแสงสีเขียว Nexza จาง ๆ ใต้เท้า ให้มองเห็นตำแหน่งชัดจากมุมสูง (แสดงทั้งบนมือถือ)
    this.ringTex = blobTexture('rgba(47,190,175,0.75)');
    this.ringMat = new THREE.MeshBasicMaterial({ map: this.ringTex, transparent: true, depthWrite: false, toneMapped: false });
    this.blobGeo ??= new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.peopleBlob = new THREE.InstancedMesh(this.blobGeo, this.ringMat, MAX_PEOPLE);
    this.carBlob = small ? null : new THREE.InstancedMesh(this.blobGeo, this.blobMat, MAX_CARS);
    for (const m of [this.peopleBlob, this.carBlob]) if (m) { m.frustumCulled = false; m.renderOrder = 2; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }

    this.indoor = new THREE.Group(); this.indoor.name = 'mobility-indoor';
    this.indoor.position.y = floorY;
    this.indoor.add(this.people); if (this.peopleBlob) this.indoor.add(this.peopleBlob);
    floorGroup.add(this.indoor);
    this.outdoorGroup = new THREE.Group(); this.outdoorGroup.name = 'mobility-outdoor';
    this.outdoorGroup.add(this.cars, this.carGlass); if (this.carBlob) this.outdoorGroup.add(this.carBlob);
    this.#buildLot(vehicles);
    outdoor.add(this.outdoorGroup);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.sc = new THREE.Vector3(); this.up = new THREE.Vector3(0, 1, 0);
    this.update();
  }

  /** ถนนและช่องจอดบนลานหน้าอาคาร (เส้นบาง ๆ สีอ่อน) */
  #buildLot(v) {
    const g = new THREE.Group(); g.name = 'mobility-lot';
    this.lotMats = [];
    const road = new THREE.Mesh(new THREE.PlaneGeometry(v.road.xIn - v.road.xOut, v.road.width).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#33403f', roughness: 0.95, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -1 }));
    road.position.set((v.road.xIn + v.road.xOut) / 2, 0.004, v.road.z);
    this.lotMats.push(road.material);
    const lineMat = new THREE.LineBasicMaterial({ color: '#d7e2df', transparent: true, opacity: 0.55 });
    const dashMat = new THREE.LineDashedMaterial({ color: '#d7e2df', transparent: true, opacity: 0.45, dashSize: 0.25, gapSize: 0.2 });
    this.lotMats.push(lineMat, dashMat);
    const pts = []; const { w, d } = v.stallSize;
    for (const s of v.stalls) { const z0 = s.z - d / 2 + 0.02; const z1 = s.z + d / 2; for (const x of [s.x - w / 2, s.x + w / 2]) pts.push(new THREE.Vector3(x, 0.006, z0), new THREE.Vector3(x, 0.006, z1)); }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
    const center = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(v.road.xOut, 0.006, v.road.z), new THREE.Vector3(v.road.xIn, 0.006, v.road.z)]), dashMat);
    center.computeLineDistances();
    g.add(road, lines, center);
    this.outdoorGroup.add(g);
  }

  /** วางทุกตัวตามสถานะของตัวจำลอง (เรียกจากลูปวาดหลักครั้งเดียวต่อเฟรม) */
  update() {
    const { sim, m, q, v, sc, up } = this;
    let n = 0;
    for (const p of sim.people) {
      if (n >= MAX_PEOPLE) break;
      const pose = sim.pose(p);
      const vis = p.visible;
      q.setFromAxisAngle(up, pose.h); v.set(pose.x, 0, pose.z);
      // เดิน: โยกตัวเล็กน้อยตามความเร็ว (นุ่ม ไม่เด้ง)
      const bob = p.state === 'walk' ? Math.sin(sim.t * 9 + p.id) * 0.004 * Math.min(1, p.v / 0.15) : 0;
      v.y = bob;
      sc.setScalar(vis ? 1 : 0);
      this.people.setMatrixAt(n, m.compose(v, q, sc));
      if (this.peopleBlob) { v.y = 0.004; sc.set(vis ? 0.16 : 0, 1, vis ? 0.16 : 0); this.peopleBlob.setMatrixAt(n, m.compose(v, q, sc)); }
      n++;
    }
    for (let i = n; i < MAX_PEOPLE; i++) { this.people.setMatrixAt(i, m.makeScale(0, 0, 0)); this.peopleBlob?.setMatrixAt(i, m); }
    this.people.instanceMatrix.needsUpdate = true; if (this.peopleBlob) this.peopleBlob.instanceMatrix.needsUpdate = true;
    let k = 0;
    for (const c of sim.cars) {
      if (k >= MAX_CARS) break;
      const pose = sim.pose(c);
      q.setFromAxisAngle(up, pose.h); v.set(pose.x, 0.002, pose.z); sc.setScalar(c.visible ? 1 : 0);
      m.compose(v, q, sc); this.cars.setMatrixAt(k, m); this.carGlass.setMatrixAt(k, m);
      if (this.carBlob) { v.y = 0.004; sc.set(c.visible ? 0.34 : 0, 1, c.visible ? 0.66 : 0); this.carBlob.setMatrixAt(k, m.compose(v, q, sc)); }
      k++;
    }
    for (let i = k; i < MAX_CARS; i++) { m.makeScale(0, 0, 0); this.cars.setMatrixAt(i, m); this.carGlass.setMatrixAt(i, m); this.carBlob?.setMatrixAt(i, m); }
    this.cars.instanceMatrix.needsUpdate = true; this.carGlass.instanceMatrix.needsUpdate = true; if (this.carBlob) this.carBlob.instanceMatrix.needsUpdate = true;
  }

  setVisible({ indoor, outdoor }) { this.indoor.visible = indoor; this.outdoorGroup.visible = outdoor; }

  dispose() {
    this.indoor.parent?.remove(this.indoor); this.outdoorGroup.parent?.remove(this.outdoorGroup);
    for (const o of [this.indoor, this.outdoorGroup]) o.traverse((x) => { if (x.geometry && x.geometry !== this.blobGeo) x.geometry.dispose(); });
    for (const x of [this.peopleGeo, this.carGeo, this.glassGeo, this.blobGeo]) x?.dispose();
    for (const x of [this.peopleMat, this.carMat, this.glassMat, this.blobMat, this.ringMat, ...this.lotMats]) x?.dispose();
    this.blobTex?.dispose(); this.ringTex?.dispose();
    for (const im of [this.people, this.cars, this.carGlass, this.peopleBlob, this.carBlob]) im?.dispose?.();
  }
}
