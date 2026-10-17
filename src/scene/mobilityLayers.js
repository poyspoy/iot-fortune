import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PersonAgent } from '../domain/personSim.js';
import { PersonRig, LOOKS } from './person3d.js';
import { VehicleSim } from '../domain/vehicleSim.js';
import { VehicleRig } from './vehicle3d.js';

// เลเยอร์ "คนจำลอง" และ "รถจำลอง" (แยกเปิด–ปิด · ค่าเริ่มต้นปิด) — ข้อมูลจำลอง ไม่ใช่ข้อมูลติดตามบุคคลจริง
// เปิด: โหลดโมเดลครั้งแรก แล้วค่อย ๆ ปรากฏ (~0.6 วิ) · ปิด: ค่อย ๆ จางหาย แล้วถอดออกจากฉาก หยุดประมวลผลทั้งหมด
// ไม่แก้โมเดลอาคาร/วัสดุเดิม: ทุกชิ้นเป็นวัตถุใหม่ในกลุ่มของตัวเอง (คนอยู่ในกลุ่มชั้น G, รถอยู่บนลานหน้าอาคาร)

const FADE_S = 0.6;
const loader = new GLTFLoader();
const cache = new Map();
const load = (url) => { if (!cache.has(url)) cache.set(url, new Promise((res, rej) => loader.load(url, res, undefined, rej))); return cache.get(url); };

function setOpacity(materials, k) {
  for (const m of materials) {
    const u = m.userData;
    u.baseOpacity ??= m.opacity; u.baseTransparent ??= m.transparent; u.baseDepthWrite ??= m.depthWrite;
    if (u.fadeK === k) continue; u.fadeK = k;
    const tr = k < 0.999 || u.baseTransparent;
    if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
    m.opacity = u.baseOpacity * k; m.depthWrite = u.baseDepthWrite && k > 0.5;
  }
}


export class MobilityLayers {
  /**
   * @param {{ data:object, floorGroup:THREE.Object3D, floorY:number, outdoor:THREE.Object3D, toLocal:(p:[number,number])=>[number,number], small:boolean, assign:(o:THREE.Object3D)=>void }} o
   */
  constructor({ data, floorGroup, floorY, outdoor, toLocal, small, assign }) {
    Object.assign(this, { data, floorGroup, floorY, outdoor, toLocal, small, assign });
    this.poi = new Map(data.people.poi.map((p) => [p.id, p]));
    this.people = null; // { group, list:[{agent, rig, fade, state}], fade, on }
    this.cars = null;
    this.peopleTarget = small ? 3 : 4; // ทดลอง 3–4 คน (มือถือ 3)
    this.rng = 1234567;
  }

  rand() { this.rng = (this.rng * 1103515245 + 12345) & 0x7fffffff; return this.rng / 0x7fffffff; }
  pick(a) { return a[Math.floor(this.rand() * a.length)]; }

  pathOf(a, b) { const k = this.data.people.paths[`${a}>${b}`]; return k ?? [...this.data.people.paths[`${b}>${a}`]].reverse(); }

  /** ทริปสุ่ม: ทางเข้า → จุดแวะ 1–2 แห่ง (ร้าน/ทางเดิน/ลิฟต์/บันไดเลื่อน) → ทางออก หรือขึ้นลิฟต์/บันไดเลื่อน */
  trip(startAt = null) {
    const ents = [...this.poi.values()].filter((p) => p.kind === 'entrance').map((p) => p.id);
    const stops = [...this.poi.values()].filter((p) => p.kind === 'shop' || p.kind === 'corridor').map((p) => p.id);
    const plan = [startAt ?? this.pick(ents)];
    const n = 1 + Math.floor(this.rand() * 2);
    for (let i = 0; i < n; i++) { let s; do s = this.pick(stops); while (s === plan.at(-1)); plan.push(s); }
    const r = this.rand();
    plan.push(r < 0.2 ? 'lift-L1' : r < 0.35 ? this.pick(['esc-1', 'esc-2']) : this.pick(ents.filter((e) => e !== plan.at(-1))));
    return plan.map((id, i) => {
      if (i === 0) return null;
      const to = this.poi.get(id);
      return { points: this.pathOf(plan[i - 1], id).map(this.toLocal), stop: { kind: to.kind, face: to.faceTo ? this.toLocal(to.faceTo) : null, dwell: to.kind === 'shop' ? 2.5 + this.rand() * 2.5 : to.kind === 'corridor' ? 0.8 : 2 + this.rand() } };
    }).filter(Boolean);
  }

  // ---------------- คนจำลอง
  async setPeople(on) {
    if (on && !this.active) this.lastWall = null; // เริ่มนับเวลาจางใหม่
    this.wantPeople = on;
    if (on) {
      if (this.people?.on) return;
      const gltf = await load('models/people/person.glb');
      if (this.disposed || !this.wantPeople) return;
      if (!this.people) {
        const group = new THREE.Group(); group.name = 'sim-people'; group.position.y = this.floorY;
        group.userData.keepOpaque = true;
        this.floorGroup.add(group);
        const list = [];
        for (let i = 0; i < this.peopleTarget; i++) {
          const rig = new PersonRig(gltf, LOOKS[i % LOOKS.length], { shadows: false });
          group.add(rig.root);
          const agent = new PersonAgent(this.trip(), { loop: false, lane: 0.017 });
          for (let k = 0; k < 40 + i * 70; k++) agent.step(0.1); // กระจายตำแหน่งเริ่มต้น
          list.push({ agent, rig, k: 0, phase: 'in' });
        }
        this.assign(group);
        this.people = { group, list, fade: 0, on: true, gltf };
      }
      this.people.on = true; this.people.group.visible = true;
    } else if (this.people) this.people.on = false;
  }

  // ---------------- รถจำลอง
  async setCars(on) {
    if (on && !this.active) this.lastWall = null; // เริ่มนับเวลาจางใหม่
    this.wantCars = on;
    if (on) {
      if (this.cars?.on) return;
      const gltf = await load('models/vehicles/sedan.glb');
      if (this.disposed || !this.wantCars) return;
      if (!this.cars) {
        const group = new THREE.Group(); group.name = 'sim-cars';
        this.outdoor.add(group);
        const rig = new VehicleRig(gltf.scene, { shadows: false });
        group.add(rig.root, this.#lot());
        const sim = new VehicleSim(this.data.vehicles, { wheelbase: rig.wheelbase, wheelRadius: rig.wheelRadius }, { stallId: 'P05' });
        this.assign(group);
        const lotMats = []; group.children.find((o) => o.name === 'sim-lot').traverse((o) => { if (o.material) lotMats.push(o.material); });
        this.cars = { group, rig, sim, lotMats, fade: 0, on: true };
      }
      this.cars.on = true; this.cars.group.visible = true;
    } else if (this.cars) this.cars.on = false;
  }

  /** ถนนและช่องจอดบนลานหน้าอาคาร (เส้นสีอ่อน) */
  #lot() {
    const v = this.data.vehicles; const g = new THREE.Group(); g.name = 'sim-lot';
    const road = new THREE.Mesh(new THREE.PlaneGeometry(v.road.xIn - v.road.xOut, v.road.width).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#33403f', roughness: 0.95, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -1 }));
    road.position.set((v.road.xIn + v.road.xOut) / 2, 0.004, v.road.z);
    const pts = []; const { w, d } = v.stallSize;
    for (const s of v.stalls) { const z0 = s.z - d / 2 + 0.02; const z1 = s.z + d / 2; for (const x of [s.x - w / 2, s.x + w / 2]) pts.push(new THREE.Vector3(x, 0.006, z0), new THREE.Vector3(x, 0.006, z1)); }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#d7e2df', transparent: true, opacity: 0.55 }));
    const center = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(v.road.xOut, 0.006, v.road.z), new THREE.Vector3(v.road.xIn, 0.006, v.road.z)]),
      new THREE.LineDashedMaterial({ color: '#d7e2df', transparent: true, opacity: 0.45, dashSize: 0.25, gapSize: 0.2 }));
    center.computeLineDistances();
    g.add(road, lines, center);
    return g;
  }

  /** เรียกครั้งเดียวต่อเฟรมจากลูปหลัก (ไม่มีลูปแยกต่อตัว) */
  update(dt) {
    // การจางเข้า/ออกใช้เวลาจริง (ไม่ผูกกับ dt ที่ถูกจำกัดต่อเฟรม) — เครื่องช้าก็ยังถอดออกจากฉากภายใน ~0.6 วิ
    const now = performance.now();
    const fdt = Math.max(dt, this.lastWall == null ? 0 : Math.min(1, (now - this.lastWall) / 1000));
    this.lastWall = now;
    const P = this.people;
    if (P) {
      P.fade = Math.max(0, Math.min(1, P.fade + (P.on ? fdt : -fdt) / FADE_S));
      for (const p of P.list) this.#stepPerson(p, dt, P);
      if (!P.on && P.fade <= 0) this.#disposePeople();
    }
    const C = this.cars;
    if (C) {
      C.fade = Math.max(0, Math.min(1, C.fade + (C.on ? fdt : -fdt) / FADE_S));
      C.sim.step(dt);
      const pose = C.sim.pose();
      C.rig.update(pose, C.sim.brake, C.sim.visible);
      // จางเข้า/ออกที่ขอบลาน (ทางเข้า–ออก) และตามสวิตช์
      const edge = Math.min(1, (this.data.vehicles.road.xIn - pose.x) / 0.8, (pose.x - this.data.vehicles.road.xOut) / 0.8);
      const k = C.fade * Math.max(0, Math.min(1, edge));
      setOpacity(C.rig.materials, k); setOpacity([C.rig.shadowMat], k);
      setOpacity(C.lotMats, C.fade);
      if (!C.on && C.fade <= 0) this.#disposeCars();
    }
  }

  #stepPerson(p, dt, P) {
    const a = p.agent;
    // กันชนกัน: มีคนอยู่ข้างหน้าใกล้กว่า ~0.6 ม. ในทิศเดิน → ชะลอ/ยืนรอ (ผู้ที่ id น้อยกว่าไปก่อนเมื่อเผชิญหน้ากัน)
    const fx = Math.sin(a.heading); const fz = Math.cos(a.heading);
    a.blocked = P.list.some((o) => {
      if (o === p || o.phase === 'gone') return false;
      const rx = o.agent.x - a.x; const rz = o.agent.z - a.z; const d = Math.hypot(rx, rz);
      if (d > 0.075 || d < 1e-6) return false;
      const ahead = (rx * fx + rz * fz) / d;
      if (ahead < 0.6) return false;
      const facing = Math.sin(o.agent.heading) * fx + Math.cos(o.agent.heading) * fz < -0.5;
      return !(facing && P.list.indexOf(p) < P.list.indexOf(o));
    });
    a.step(dt);
    // ปรากฏตัวที่ทางเข้า / จางหายเมื่อออกจากอาคาร ขึ้นลิฟต์ หรือบันไดเลื่อน แล้วเริ่มทริปใหม่
    if (a.state === 'done' && p.phase !== 'out') p.phase = 'out';
    p.k = Math.max(0, Math.min(1, p.k + (p.phase === 'out' ? -dt : dt) / FADE_S));
    if (p.phase === 'out' && p.k <= 0) { p.agent = new PersonAgent(this.trip(), { loop: false, lane: 0.017 }); p.phase = 'in'; }
    p.rig.update(a.pose(), dt);
    p.rig.root.visible = p.k > 0.01 && P.fade > 0.01;
    setOpacity(p.rig.materials, p.k * P.fade); setOpacity([p.rig.shadowMat], p.k * P.fade);
  }

  #disposePeople() {
    const P = this.people; if (!P) return;
    for (const p of P.list) p.rig.dispose();
    P.group.parent?.remove(P.group);
    this.people = null; // หยุดประมวลผลทั้งหมด (โหลดใหม่จากแคชเมื่อเปิดอีกครั้ง)
  }

  #disposeCars() {
    const C = this.cars; if (!C) return;
    C.rig.dispose();
    C.group.traverse((o) => o.geometry?.dispose());
    for (const m of C.lotMats) m.dispose();
    C.group.parent?.remove(C.group);
    this.cars = null;
  }

  get active() { return !!(this.people || this.cars); }
  counts() {
    return { people: this.people ? this.people.list.filter((p) => p.phase !== 'gone' && p.k > 0.01).length : 0, peopleOn: !!this.people?.on, cars: this.cars?.on && this.cars.group.visible ? 1 : 0, carsOn: !!this.cars?.on };
  }

  probe() {
    return {
      people: this.people ? this.people.list.map((p) => ({ state: p.agent.state, v: +p.agent.v.toFixed(3), k: +p.k.toFixed(2), x: +p.agent.x.toFixed(3), z: +p.agent.z.toFixed(3), look: p.rig.look?.id, walkScale: +p.rig.actions.Walk.getEffectiveTimeScale().toFixed(2), w: Object.fromEntries(Object.entries(p.rig.w).map(([k, v]) => [k, +v.toFixed(2)])) })) : null,
      peopleFade: this.people ? +this.people.fade.toFixed(2) : 0,
      car: this.cars ? { ...this.cars.sim.status(), fade: +this.cars.fade.toFixed(2) } : null,
    };
  }

  dispose() { this.disposed = true; this.#disposePeople(); this.#disposeCars(); }
}
