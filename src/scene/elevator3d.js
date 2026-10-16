import * as THREE from 'three';
import { textSprite } from './textures.js';

// ลิฟต์ 3 มิติ (จำลอง): ปล่องอยู่กับที่ · ห้องลิฟต์เป็นวัตถุแยกที่เลื่อนขึ้นลง · ประตูสองบานเป็นลูกของห้องลิฟต์ (เคลื่อนตามกัน)
// ระดับพื้นของแต่ละชั้นอ่านจากกลุ่มชั้นในฉากทุกเฟรม → ใช้ได้ทั้งมุมมองภายนอก ตัดชั้นบน และแยกชั้น

const GLASS = () => new THREE.MeshStandardMaterial({ color: '#9fd4cf', transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });

export class ElevatorRig {
  /**
   * @param {object} spec  ELEVATOR_L1
   * @param {(floorId:string)=>number|null} levelOf  ความสูงผิวพื้นของชั้น (พิกัดใน root)
   * @param {(floorId:string)=>number} heightOf  ความสูงชั้น
   */
  constructor(spec, levelOf, heightOf, visibleOf = () => true) {
    this.visibleOf = visibleOf;
    this.spec = spec;
    this.levelOf = levelOf;
    this.heightOf = heightOf;
    this.group = new THREE.Group();
    this.group.name = `elevator-${spec.id}`;
    this.group.position.set(spec.x, 0, spec.z);
    const { w, d } = spec.shaft;
    const c = spec.car;
    this.front = spec.doorSide === '-z' ? -1 : 1;

    // ---- ปล่อง (อยู่กับที่) — กระจกใส 4 ด้าน + เสามุม + รางนำ + ห้องเครื่องด้านบน
    const shaft = new THREE.Group();
    shaft.name = 'shaft';
    const glass = GLASS();
    this.shaftGlass = glass;
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const panel = (sx, sz, x, z) => { const m = new THREE.Mesh(unit, glass); m.scale.set(sx, 1, sz); m.position.set(x, 0.5, z); m.renderOrder = 4; return m; };
    this.panels = [panel(w, 0.006, 0, -this.front * d / 2), panel(0.006, d, -w / 2, 0), panel(0.006, d, w / 2, 0)]; // ด้านหน้าเปิดโล่ง เห็นตัวลิฟต์ภายใน
    const steel = new THREE.MeshStandardMaterial({ color: '#4a5a60', metalness: 0.6, roughness: 0.4 });
    this.posts = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => {
      const m = new THREE.Mesh(unit, steel); m.scale.set(0.016, 1, 0.016); m.position.set(sx * w / 2, 0.5, sz * d / 2); m.castShadow = true; return m;
    });
    const railMat = new THREE.MeshStandardMaterial({ color: '#8b979b', metalness: 0.7, roughness: 0.3 });
    this.rails = [-1, 1].map((sx) => { const m = new THREE.Mesh(unit, railMat); m.scale.set(0.008, 1, 0.012); m.position.set(sx * (c.w / 2 + 0.012), 0.5, 0); return m; });
    this.scaled = new THREE.Group(); // กลุ่มที่ยืดตามความสูงปล่อง
    this.scaled.add(...this.panels, ...this.posts, ...this.rails);
    shaft.add(this.scaled);
    this.cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.03, 0.09, d + 0.03), new THREE.MeshStandardMaterial({ color: '#56656c', metalness: 0.4, roughness: 0.5, transparent: true, opacity: 0.45, depthWrite: false })); // โปร่งให้เห็นห้องลิฟต์จากมุมบน
    this.cap.castShadow = true;
    this.pit = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), steel);
    shaft.add(this.cap, this.pit);
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(unit), new THREE.LineBasicMaterial({ color: '#2fa39a', transparent: true, opacity: 0.85 }));
    this.edges.scale.set(w, 1, d);
    shaft.add(this.edges);

    // ธรณีประตูหน้าชั้น + ป้ายชั้น ข้างปล่อง (ตรึงกับปล่อง)
    this.landings = spec.floors.map((id) => {
      const g = new THREE.Group();
      const sill = new THREE.Mesh(new THREE.BoxGeometry(c.w * 0.9, 0.012, 0.035), new THREE.MeshStandardMaterial({ color: '#c9a227', metalness: 0.5, roughness: 0.4 }));
      sill.position.set(0, 0.006, this.front * (d / 2 + 0.018));
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(c.w * 0.86, c.h * 0.92)), new THREE.LineBasicMaterial({ color: '#c9a227' }));
      frame.position.set(0, c.h * 0.46, this.front * (d / 2 + 0.004));
      const label = textSprite(`ชั้น ${id}`, { scale: 0.0036 });
      label.center.set(1, 0.5);
      label.position.set(-w / 2 - 0.1, 0.02, this.front * (d / 2));
      g.add(sill, frame, label);
      g.userData.floorId = id;
      shaft.add(g);
      return g;
    });
    // ป้ายชื่อใกล้ปล่อง
    this.title = textSprite('ลิฟต์โดยสาร L1 — ลิฟต์จำลอง · ไม่ใช่ข้อมูลจริง', { scale: 0.0048, color: '#ffffff', bg: 'rgba(15,111,105,0.95)' });
    this.title.center.set(0.5, 0);
    shaft.add(this.title);
    // เส้นบอกระดับชั้นแนวตั้งข้างปล่อง + จุดที่ระดับพื้นแต่ละชั้น
    const scaleX = -w / 2 - 0.06;
    this.scaleLine = new THREE.Mesh(unit, new THREE.MeshBasicMaterial({ color: '#2fe0c4', toneMapped: false }));
    this.scaleLine.scale.set(0.008, 1, 0.008);
    this.scaleLine.position.set(scaleX, 0.5, this.front * (d / 2));
    shaft.add(this.scaleLine);
    this.dots = spec.floors.map(() => {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
      dot.position.set(scaleX, 0, this.front * (d / 2));
      shaft.add(dot);
      return dot;
    });
    this.shaft = shaft;
    this.group.add(shaft);

    // ---- ห้องลิฟต์ (วัตถุแยก เคลื่อนที่ได้) — พื้นห้องอยู่ที่ y = 0 ของกลุ่ม car
    const car = new THREE.Group();
    car.name = 'car';
    const wallMat = new THREE.MeshStandardMaterial({ color: '#16a394', metalness: 0.1, roughness: 0.45, emissive: '#0f7f73', emissiveIntensity: 0.6 }); // เขียว Nexza เด่นจากตัวอาคาร
    const floorMat = new THREE.MeshStandardMaterial({ color: '#6b5a49', roughness: 0.8 });
    const t = 0.008;
    const box = (sx, sy, sz, x, y, z, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m; };
    const carFloor = box(c.w, t * 1.5, c.d, 0, t * 0.75, 0, floorMat);
    const back = box(c.w, c.h, t, 0, c.h / 2, -this.front * (c.d / 2 - t / 2), wallMat);
    const left = box(t, c.h, c.d, -c.w / 2 + t / 2, c.h / 2, 0, wallMat);
    const right = box(t, c.h, c.d, c.w / 2 - t / 2, c.h / 2, 0, wallMat);
    const roof = box(c.w, t, c.d, 0, c.h - t / 2, 0, wallMat);
    const lamp = new THREE.Mesh(new THREE.PlaneGeometry(c.w * 0.6, c.d * 0.6), new THREE.MeshBasicMaterial({ color: '#fff6d8', side: THREE.DoubleSide }));
    lamp.rotation.x = Math.PI / 2; lamp.position.y = c.h - t - 0.001;
    const sling = box(c.w + 0.02, 0.012, 0.012, 0, c.h + 0.006, 0, steel);
    car.add(carFloor, back, left, right, roof, lamp, sling);
    // ประตูสองบาน (ลูกของห้องลิฟต์ จึงเคลื่อนตามห้องลิฟต์)
    const doorMat = new THREE.MeshStandardMaterial({ color: '#d9f3ee', metalness: 0.25, roughness: 0.3, emissive: '#9fded4', emissiveIntensity: 0.55 });
    const dw = c.w / 2;
    const dz = this.front * (c.d / 2 - 0.004);
    this.doorL = box(dw, c.h - 0.02, 0.006, -dw / 2, (c.h - 0.02) / 2 + 0.006, dz, doorMat);
    this.doorR = box(dw, c.h - 0.02, 0.006, dw / 2, (c.h - 0.02) / 2 + 0.006, dz, doorMat);
    this.doorL.name = 'door-left'; this.doorR.name = 'door-right';
    const seam = box(0.003, c.h - 0.03, 0.008, 0, c.h / 2, dz + this.front * 0.002, new THREE.MeshBasicMaterial({ color: '#2b3a3f' }));
    this.seam = seam;
    car.add(this.doorL, this.doorR, seam);
    // จอแสดงชั้นเหนือประตู
    this.display = new THREE.Mesh(new THREE.PlaneGeometry(c.w * 0.5, 0.05), new THREE.MeshBasicMaterial({ color: '#1d2a2e' }));
    this.display.position.set(0, c.h + 0.04, this.front * (c.d / 2 + 0.002));
    if (this.front < 0) this.display.rotation.y = Math.PI;
    car.add(this.display);
    // เส้นขอบห้องลิฟต์สีทอง ให้เห็นตำแหน่งห้องลิฟต์ชัดเมื่อมองผ่านปล่อง
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(c.w + 0.006, c.h, c.d + 0.006)), new THREE.LineBasicMaterial({ color: '#7dffe0', toneMapped: false }));
    outline.position.y = c.h / 2;
    car.add(outline);
    // มองทะลุผนัง/กระจกอาคาร: กรอบและแสงเรืองของรถลิฟต์วาดทับเสมอ (depthTest ปิด) จึงเห็นรถเคลื่อนในมุมมองทั้งอาคาร
    const xray = new THREE.LineSegments(outline.geometry, new THREE.LineBasicMaterial({ color: '#7dffe0', transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false }));
    xray.position.y = c.h / 2;
    xray.renderOrder = 31;
    car.add(xray);
    // แสงเรืองรอบตัวลิฟต์ (นุ่ม ไม่กระพริบ)
    this.glow = new THREE.Mesh(new THREE.BoxGeometry(c.w + 0.05, c.h + 0.05, c.d + 0.05),
      new THREE.MeshBasicMaterial({ color: '#2fe0c4', transparent: true, opacity: 0.32, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.glow.position.y = c.h / 2;
    this.glow.renderOrder = 30;
    car.add(this.glow);
    // วงแสงนุ่มรอบรถลิฟต์ (sprite หันเข้ากล้อง) — เห็นตำแหน่งลิฟต์ได้แม้มองจากระยะไกล ไม่กระพริบ
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g2 = cv.getContext('2d'); const gr = g2.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(125,255,224,0.85)'); gr.addColorStop(0.35, 'rgba(47,224,196,0.45)'); gr.addColorStop(1, 'rgba(47,224,196,0)');
    g2.fillStyle = gr; g2.fillRect(0, 0, 128, 128);
    const haloTex = new THREE.CanvasTexture(cv); haloTex.colorSpace = THREE.SRGBColorSpace;
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.halo.scale.set(c.h * 4, c.h * 4, 1);
    this.halo.position.y = c.h / 2;
    this.halo.renderOrder = 29;
    car.add(this.halo);
    // ป้าย L1 บนตัวลิฟต์ (ด้านข้าง)
    const plate = textSprite('L1', { scale: 0.0052, color: '#ffffff', bg: 'rgba(15,111,105,0.95)' });
    this.plate = plate;
    plate.position.set(-c.w / 2 - 0.05, c.h * 0.55, 0);
    plate.visible = false; // ใช้ป้ายลอย "L1 ▲ ชั้น X" แทน (ไม่ซ้อนกัน)
    plate.material.depthTest = false; plate.renderOrder = 32;
    car.add(plate);
    const light = new THREE.PointLight('#bffff3', 0.6, 0.9);
    light.position.y = c.h * 0.8;
    car.add(light);
    this.car = car;
    this.group.add(car);

    // ---- ลวดสลิงและน้ำหนักถ่วง (เคลื่อนสวนทางห้องลิฟต์)
    this.cable = new THREE.Mesh(unit, new THREE.MeshBasicMaterial({ color: '#2b3a3f' }));
    this.cable.scale.set(0.003, 1, 0.003);
    this.counter = new THREE.Mesh(new THREE.BoxGeometry(c.w * 0.6, 0.18, 0.02), steel);
    this.counter.position.z = -this.front * (d / 2 - 0.02);
    this.group.add(this.cable, this.counter);
    this.doorOpenW = dw * 0.92;
    this.lastLevels = null;
  }

  /** ระดับผิวพื้นของทุกชั้นที่ลิฟต์จอด (ตามตำแหน่งชั้นในฉากตอนนี้) */
  levels() {
    return this.spec.floors.map((id) => this.levelOf(id));
  }

  /** แปลงดัชนีชั้นต่อเนื่อง → ความสูง (เส้นตรงระหว่างชั้นที่ติดกัน) */
  yAt(pos, lv = this.levels()) {
    const n = lv.length;
    const p = Math.min(n - 1, Math.max(0, pos));
    const i = Math.min(n - 2, Math.floor(p));
    if (n === 1) return lv[0];
    const k = p - i;
    return lv[i] + (lv[i + 1] - lv[i]) * k;
  }

  /** วางทุกชิ้นตามสถานะลิฟต์ (เรียกทุกเฟรม) */
  /**
   * วางทุกชิ้นตามสถานะลิฟต์ (เรียกทุกเฟรม)
   * @param {{pos:number, door:number}} state
   * @param {{levels?:number[], onlyIndex?:number, offset?:{x:number,z:number}}|null} opts  มุมมองชั้นเดียว: ระดับพื้นสมมติรอบชั้นนั้น
   */
  update(state, opts = null) {
    const lv = opts?.levels ?? this.levels();
    if (lv.some((v) => v == null)) { this.group.visible = false; return; }
    const only = opts?.onlyIndex ?? null;
    this.group.position.set(this.spec.x + (opts?.offset?.x ?? 0), 0, this.spec.z + (opts?.offset?.z ?? 0));
    // ดูชั้นเดียว: แสดงรถลิฟต์ ประตู และธรณีประตูของชั้นนั้นเท่านั้น (ไม่แสดงปล่องทั้งต้น)
    for (const o of [this.scaled, this.edges, this.cap, this.pit, this.title, this.scaleLine, this.cable, this.counter, ...this.dots]) o.visible = only === null;
    this.shaftChrome = only === null;
    const bottom = lv[0] - 0.03;
    const topFloor = this.spec.floors[this.spec.floors.length - 1];
    const top = lv[lv.length - 1] + Math.max(this.heightOf(topFloor), this.spec.car.h + 0.15);
    const H = top - bottom;
    this.scaled.position.y = bottom; this.scaled.scale.y = H;
    this.edges.position.y = bottom + H / 2; this.edges.scale.y = H;
    this.cap.position.y = top + 0.045;
    this.pit.position.y = bottom;
    this.landings.forEach((g, i) => { g.position.y = lv[i]; g.visible = only === null ? this.visibleOf(this.spec.floors[i]) : i === only; }); // ป้ายชั้นที่ถูกซ่อน (ตัดชั้นบน) ไม่แสดง
    this.title.position.set(0, top + 0.16, 0);
    this.scaleLine.scale.y = Math.max(0.001, lv[lv.length - 1] - lv[0]);
    this.scaleLine.position.y = (lv[0] + lv[lv.length - 1]) / 2;
    const near = Math.round(Math.max(0, Math.min(lv.length - 1, state.pos)));
    this.dots.forEach((dot, i) => {
      dot.position.y = lv[i];
      dot.material.color.set(i === near ? '#ffd23f' : '#ffffff'); // ชั้นที่ตัวลิฟต์อยู่/ผ่าน
      dot.scale.setScalar(i === near ? 1.5 : 1);
    });
    const y = this.yAt(state.pos, lv);
    this.car.position.y = y;
    const open = this.doorOpenW * state.door;
    const dw = this.spec.car.w / 2;
    this.doorL.position.x = -dw / 2 - open;
    this.doorR.position.x = dw / 2 + open;
    this.seam.visible = state.door < 0.02;
    const carTop = y + this.spec.car.h + 0.012;
    this.cable.scale.y = Math.max(0.001, top - carTop);
    this.cable.position.y = (top + carTop) / 2;
    this.counter.position.y = top - 0.15 - (y - bottom) * 0.9 > bottom + 0.1 ? top - 0.15 - (y - bottom) * 0.9 : bottom + 0.1;
    this.carY = y;
    this.lastLevels = lv;
  }

  /** วัตถุที่เป็นป้ายข้อความ (ให้ LayerManager ผูกกับเลเยอร์ labels) */
  labelObjects() { return [this.title, this.plate, ...this.landings.map((g) => g.children.find((c) => c.isSprite)).filter(Boolean)]; }

  /** แสดงชั้นบนจอเหนือประตูห้องลิฟต์ */
  setDisplay(text, arrow) {
    const key = `${arrow}${text}`;
    if (this.displayKey === key) return;
    this.displayKey = key;
    if (this.displayLabel) { this.car.remove(this.displayLabel); this.displayLabel.material.map?.dispose(); this.displayLabel.material.dispose(); }
    const s = textSprite(`${arrow ? arrow + ' ' : ''}${text}`, { scale: 0.0035, color: '#7dffb0', bg: 'rgba(16,26,30,0.92)' });
    s.position.set(0, this.spec.car.h + 0.1, this.front * (this.spec.car.d / 2 + 0.01));
    this.displayLabel = s;
    this.car.add(s);
    // ป้ายลอยตามรถลิฟต์ (อ่านได้จากมุมทั้งอาคาร): "L1 ▲ ชั้น 3"
    if (this.tag) { this.car.remove(this.tag); this.tag.material.map?.dispose(); this.tag.material.dispose(); }
    const t = textSprite(`L1 ${arrow ? arrow + ' ' : ''}ชั้น ${text}`, { scale: 0.0085, color: '#ffffff', bg: 'rgba(15,111,105,0.95)' });
    t.center.set(1, 0.5);
    t.position.set(-this.spec.car.w / 2 - 0.25, this.spec.car.h * 0.5, 0);
    t.renderOrder = 33;
    this.tag = t;
    this.car.add(t);
  }

  /** ช่วงเหนือ/ใต้ของปล่องในพิกัด root (ใช้จัดกล้อง) */
  bounds() {
    const lv = this.lastLevels ?? this.levels();
    const topFloor = this.spec.floors[this.spec.floors.length - 1];
    return { x: this.spec.x, z: this.spec.z, y0: lv[0], y1: lv[lv.length - 1] + this.heightOf(topFloor) };
  }
}
