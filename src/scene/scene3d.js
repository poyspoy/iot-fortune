import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { timberTexture, slateFloorTexture, textSprite } from './textures.js';
import { planTo3D, isolatedOffset, assembledOffset, markerPosition, detailTransform } from '../domain/geometry.js';
import { severityRank } from '../domain/constants.js';
import { ELEVATOR_L1, createElevator, requestFloor, stepElevator, elevatorStatus } from '../domain/elevator.js';
import { ElevatorRig } from './elevator3d.js';
import { prepareDetail } from './detailModel.js';
import { pickRoom } from '../domain/rooms.js';

// โมเดลห้างจำลองบนโต๊ะไม้ในห้องทดลอง — เรขาคณิตสร้างด้วยโค้ดทั้งหมด
// รูปทรงลากจากผังพื้นที่เช่าโดยประมาณ ไม่ใช่แบบก่อสร้าง

const BASE_Y = 0.2; // ความสูงฐานโมเดล (กรอบไม้) เหนือผิวโต๊ะ
const SLAB_T = 0.1;
const CLICK_PX = 6; // ระยะเลื่อนเมาส์สูงสุดที่ยังนับเป็น "คลิก" ไม่ใช่ "ลากหมุน"
// จุดกลางฐานโมเดล — ชั้นที่แยกดูจะถูกเลื่อนมาไว้ตรงนี้ (พิกัดใน root)
const ISO_CENTER = { x: -0.3, y: 0.02, z: -2.1 };

export const PRESET_LABELS = {
  fit: 'พอดีทั้งชั้น',
  all: 'ทั้งอาคาร',
  floor: 'ชั้นที่เลือก',
  plant: 'ห้องเครื่อง',
  roof: 'ดาดฟ้า',
  underfloor: 'ระบบใต้พื้น',
  top: 'มุมบน',
  lift: 'มุมลิฟต์',
};

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

const COLORS = {
  normal: '#2f8f83', warning: '#d99a1e', critical: '#c8423a', unknown: '#7d8a91',
};

export class MallScene {
  /**
   * @param {HTMLElement} container
   * @param {{ onSelect:(id:string)=>void }} opts
   */
  constructor(container, opts) {
    this.container = container;
    this.onSelect = opts.onSelect;
    this.onDetail = opts.onDetail ?? (() => {});
    this.onElevator = opts.onElevator ?? (() => {});
    this.onRoom = opts.onRoom ?? (() => {});
    this.roomSel = null; // { floorId, room, mesh }
    this.liftView = false; // มุมมองเปิดปล่อง: ซ่อนผนัง/กระจกแบบง่ายของห้าง ให้เห็นห้องลิฟต์ในปล่อง
    this.detailCache = new Map(); // src → Promise<THREE.Object3D> (โหลดครั้งเดียว ใช้ซ้ำ)
    this.mode = 'exterior';
    this.floorId = null;
    this.isolatedId = null; // ชั้นที่แยกดูเดี่ยว (null = ทั้งอาคาร)
    this.layers = { electrical: true, hvac: true, water: true, environment: true };
    this.selectedId = null;
    this.points = [];
    this.floorGroups = new Map();
    this.markerObjs = new Map();
    this.tween = null;
    this.dynamic = {};
    this.disposed = false;
    this.clock = new THREE.Clock();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'scene-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(this.renderer.domElement);

    this.overlay = document.createElement('div');
    this.overlay.className = 'marker-layer';
    container.appendChild(this.overlay);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#1f282c');
    this.scene.fog = new THREE.Fog('#1f282c', 40, 75);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camera.position.set(4, 15, 22);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 48;
    this.controls.target.set(0, 2, 0);
    this.controls.addEventListener('start', () => { this.tween = null; this.autoFit = false; });

    this.#buildRoom();
    this.root = new THREE.Group();
    this.root.position.y = BASE_Y;
    this.scene.add(this.root);
    this.raycaster = new THREE.Raycaster();

    this.#bindPointer();
    this.resizeObs = new ResizeObserver(() => this.#resize());
    this.resizeObs.observe(container);
    this.#resize();
    this.loopFn = () => this.#frame();
    this.raf = requestAnimationFrame(this.loopFn);
  }

  // ---------------------------------------------------------------- ห้อง/โต๊ะ
  #buildRoom() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#f1efe4', '#39444a', 0.95));
    const key = new THREE.DirectionalLight('#fff3df', 1.5);
    key.position.set(-10, 22, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = -18; sc.right = 18; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 60;
    key.shadow.bias = -0.0008;
    s.add(key);
    const fill = new THREE.DirectionalLight('#cfe6e3', 0.35);
    fill.position.set(12, 8, -10);
    s.add(fill);

    const floorTex = slateFloorTexture();
    floorTex.repeat.set(16, 16);
    const roomFloor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }));
    roomFloor.rotation.x = -Math.PI / 2;
    roomFloor.position.y = -4.2;
    roomFloor.receiveShadow = true;
    s.add(roomFloor);
    const wallMat = new THREE.MeshStandardMaterial({ color: '#34424a', roughness: 1 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(120, 30), wallMat);
    back.position.set(0, 10, -26);
    s.add(back);

    // โต๊ะไม้
    const wood = timberTexture();
    wood.repeat.set(3, 1.6);
    const woodMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.62, metalness: 0.02 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(30, 0.5, 15), woodMat);
    top.position.set(0, -0.25, -1.5);
    top.receiveShadow = true;
    s.add(top);
    const legMat = new THREE.MeshStandardMaterial({ color: '#5b3d22', roughness: 0.8 });
    for (const [x, z] of [[-14, 5.4], [14, 5.4], [-14, -8.4], [14, -8.4]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 3.7, 0.6), legMat);
      leg.position.set(x, -2.35, z);
      s.add(leg);
    }
    // ฐานโมเดลพร้อมกรอบ
    const baseMat = new THREE.MeshStandardMaterial({ color: '#e7ece4', roughness: 0.9 });
    const frameMat = new THREE.MeshStandardMaterial({ color: '#3b2a1c', roughness: 0.7 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(24.4, BASE_Y, 13.2), baseMat);
    base.position.set(-0.3, BASE_Y / 2, -2.1);
    base.receiveShadow = true;
    s.add(base);
    const fw = 0.22;
    for (const [w, d, x, z] of [[24.8, fw, -0.3, 4.5], [24.8, fw, -0.3, -8.7], [fw, 13.4, -12.6, -2.1], [fw, 13.4, 12.0, -2.1]]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(w, BASE_Y + 0.08, d), frameMat);
      f.position.set(x, (BASE_Y + 0.08) / 2, z);
      f.castShadow = true;
      s.add(f);
    }
    // อุปกรณ์ห้องทดลองแบบแผนภาพ (ประกอบฉากเท่านั้น)
    const instMat = new THREE.MeshStandardMaterial({ color: '#56656c', roughness: 0.6, metalness: 0.3 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 1.2), instMat);
    box.position.set(12.6, 0.55, -7.2);
    box.castShadow = true;
    s.add(box);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.6), new THREE.MeshBasicMaterial({ color: '#2fa39a' }));
    screen.position.set(12.6, 0.62, -6.59);
    s.add(screen);
  }

  // ---------------------------------------------------------------- อาคาร
  setConfig(config) {
    this.config = config;
    for (const g of this.floorGroups.values()) { g.detailObj?.parent?.remove(g.detailObj); this.root.remove(g.group); disposeTree(g.group); }
    this.floorGroups.clear();
    this.texCache = new Map(); // ชั้นสำนักงานใช้ผังอ้างอิงร่วม — โหลดภาพครั้งเดียว
    const loader = new THREE.TextureLoader();
    for (const f of config.building.floors) {
      this.floorGroups.set(f.id, this.#buildFloor(f, loader));
    }
    this.#buildTowerDeco();
    this.#buildEquipment();
    this.#loadModel();
    this.#buildElevator();
    this.#loadAllDetails();
    if (this.isolatedId && !this.floorGroups.has(this.isolatedId)) this.isolatedId = null;
    if (!this.floorId) this.floorId = config.building.floors[0]?.id;
    this.#applyMode(true);
  }

  #shape(floor) {
    const m = floor.model;
    return new THREE.Shape(floor.footprint.map(([nx, ny]) => new THREE.Vector2(m.cx + (nx - 0.5) * m.width, -(m.cz + (ny - 0.5) * m.depth))));
  }

  #buildFloor(floor, loader) {
    const m = floor.model;
    const group = new THREE.Group();
    group.name = `floor-${floor.id}`;
    const shape = this.#shape(floor);
    const slabMat = new THREE.MeshStandardMaterial({ color: floor.kind === 'parking' ? '#8d8f8a' : '#d9dfd6', roughness: 0.85 });
    const slabT = floor.kind === 'tower' ? 0.05 : SLAB_T;
    const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: slabT, bevelEnabled: false }), slabMat);
    slab.rotation.x = -Math.PI / 2;
    slab.castShadow = true; slab.receiveShadow = true;
    group.add(slab);

    // ผังพื้นบนแผ่นพื้น (UV จากพิกัดปกติของภาพผัง)
    const topGeo = new THREE.ShapeGeometry(shape);
    const pos = topGeo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const nx = (pos.getX(i) - m.cx) / m.width + 0.5;
      const ny = (-pos.getY(i) - m.cz) / m.depth + 0.5;
      uv[i * 2] = nx; uv[i * 2 + 1] = 1 - ny;
    }
    topGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const planMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, transparent: true, opacity: 0.95 });
    let texP = this.texCache.get(floor.plan.src);
    if (!texP) {
      texP = new Promise((res, rej) => loader.load(floor.plan.src, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        res(tex);
      }, undefined, rej));
      this.texCache.set(floor.plan.src, texP);
    }
    texP.then((tex) => { planMat.map = tex; planMat.needsUpdate = true; }, () => { planMat.color.set('#cfd8cc'); });
    const plan = new THREE.Mesh(topGeo, planMat);
    plan.rotation.x = -Math.PI / 2;
    plan.position.y = slabT + 0.004;
    plan.receiveShadow = true;
    group.add(plan);

    // ผนังโปร่งแสง (เปลือกอาคาร)
    const shellH = Math.max(m.height - slabT, 0.15);
    const shellMat = new THREE.MeshStandardMaterial({ color: '#dfe9e2', transparent: true, opacity: 0.3, roughness: 0.4, side: THREE.DoubleSide, depthWrite: false });
    const shell = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: shellH, bevelEnabled: false }), shellMat);
    shell.rotation.x = -Math.PI / 2;
    shell.position.y = slabT;
    shell.renderOrder = 2;
    group.add(shell);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(shell.geometry, 25), new THREE.LineBasicMaterial({ color: '#8fa79f', transparent: true, opacity: 0.55 }));
    edges.rotation.x = -Math.PI / 2;
    edges.position.y = slabT;
    group.add(edges);

    const label = textSprite(floor.plan.shared ? `${floor.name} · ${floor.plan.sharedLabel ?? 'ผังอ้างอิงร่วม'}` : floor.name, { scale: 0.011 });
    label.position.set(m.cx - m.width / 2 - 0.2, floor.kind === 'tower' ? 0.12 : 0.35, m.cz + m.depth / 2);
    label.center.set(1, 0.5);
    group.add(label);

    this.root.add(group);
    return { group, slab, slabT, plan, shell, shellMat, edges, label, floor, planMat, target: new THREE.Vector3() };
  }

  /**
   * โมเดลรายละเอียดจาก Blender (ผนังกระจก เสาเอ็น ผนังตัดจากเส้นในผัง) ติดเข้ากับกลุ่มชั้นเดิม
   * จึงเลื่อน/แยกชั้นพร้อมผังและหมุด ถ้าโหลดไม่ได้ใช้เปลือกอาคารแบบสร้างด้วยโค้ดต่อไป
   */
  #loadModel() {
    const src = this.config.building.modelSrc;
    this.modelToken = (this.modelToken ?? 0) + 1;
    const token = this.modelToken;
    this.modelLoaded = false;
    if (!src) return;
    this.glassMat ??= new THREE.MeshStandardMaterial({ color: '#a9d2cd', transparent: true, opacity: 0.26, roughness: 0.08, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide });
    new GLTFLoader().load(src, (gltf) => {
      if (token !== this.modelToken || this.disposed) return;
      for (const fg of this.floorGroups.values()) {
        const node = gltf.scene.getObjectByName(`floor-${fg.floor.id}`);
        if (!node) continue;
        const clone = node.clone(true); // ใช้ geometry ร่วม (ทุกชั้นสำนักงานใช้ชุดเดียวกัน)
        clone.position.set(0, 0, 0);
        fg.facade = []; fg.walls = [];
        clone.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true; o.receiveShadow = true;
          const name = o.material?.name;
          if (name === 'Glass') { o.material = this.glassMat; o.renderOrder = 3; o.castShadow = false; fg.facade.push(o); }
          else if (name === 'Frame') fg.facade.push(o);
          else if (name === 'Wall') fg.walls.push(o);
        });
        fg.model?.parent?.remove(fg.model);
        fg.model = clone;
        fg.group.add(clone);
      }
      this.modelLoaded = true;
      this.#applyMode();
    }, undefined, () => { this.modelLoaded = false; });
  }

  // ---------------------------------------------------------------- ลิฟต์จำลอง
  /** ปล่อง + ห้องลิฟต์ L1 — จอดเฉพาะชั้นที่มีอยู่ในการตั้งค่าอาคาร (ลำดับตาม order) */
  #buildElevator() {
    if (this.lift) { this.root.remove(this.lift.rig.group); disposeTree(this.lift.rig.group); }
    const have = new Map(this.config.building.floors.map((f) => [f.id, f]));
    const floors = ELEVATOR_L1.floors.filter((id) => have.has(id)).sort((a, b) => have.get(a).order - have.get(b).order);
    if (floors.length < 2) { this.lift = null; return; }
    const spec = { ...ELEVATOR_L1, floors };
    const levelOf = (id) => { const fg = this.floorGroups.get(id); return fg ? fg.group.position.y + fg.slabT : null; };
    const heightOf = (id) => have.get(id)?.model.height ?? 0.8;
    const rig = new ElevatorRig(spec, levelOf, heightOf, (id) => this.floorGroups.get(id)?.group.visible !== false);
    // คงตำแหน่งลิฟต์เดิมเมื่อโหลดการตั้งค่าใหม่ (ถ้าชั้นนั้นยังอยู่)
    const prev = this.lift?.state;
    const start = prev && floors.includes(prev.floors[prev.to]) && prev.phase === 'open' ? prev.floors[prev.to] : floors[0];
    this.lift = { spec, rig, state: { ...createElevator(spec, { startFloor: start, now: this.#now() }), trips: prev?.trips ?? 0 }, sig: '' };
    this.root.add(rig.group);
    rig.update(this.lift.state);
  }

  /** สั่งลิฟต์ไปชั้น — คืน 'started' | 'same-floor' | 'busy' | 'unknown-floor' | 'none' */
  requestElevator(floorId) {
    if (!this.lift) return 'none';
    const r = requestFloor(this.lift.state, floorId, this.#now());
    this.lift.state = r.state;
    this.#emitElevator(true);
    return r.result;
  }

  elevatorFloors() { return this.lift ? [...this.lift.spec.floors] : []; }
  elevatorStatus() { return this.lift ? elevatorStatus(this.lift.state) : null; }

  /** ข้อมูลตรวจสอบ (ใช้ในการทดสอบเบราว์เซอร์): ความสูงพื้นห้องลิฟต์เทียบกับพื้นชั้น และระยะเปิดประตู */
  elevatorProbe() {
    if (!this.lift) return null;
    const { rig, state } = this.lift;
    const levels = Object.fromEntries(rig.spec.floors.map((id, i) => [id, rig.levels()[i]]));
    // ระดับพื้นของโมเดลห้องจาก Blender (Z = 0 ของโมเดล) ในพิกัดเดียวกับห้องลิฟต์
    const modelFloor = Object.fromEntries(rig.spec.floors.map((id) => {
      const fg = this.floorGroups.get(id);
      return [id, fg?.detailObj ? fg.group.position.y + fg.detailObj.position.y : null];
    }));
    return { phase: state.phase, pos: state.pos, door: state.door, carY: rig.car.position.y, levels, modelFloor, target: state.floors[state.to],
      doorGap: rig.doorR.position.x - rig.doorL.position.x - rig.spec.car.w / 2, visible: rig.group.visible };
  }

  /** เวลาที่ใช้ขับลิฟต์ — ปกติเป็นเวลาจริง; การทดสอบ/บันทึกคลิปตั้งนาฬิกาเองได้ (เดินทีละเฟรมคงที่) */
  #now() { return this.manualNow ?? performance.now(); }
  setManualClock(t) { this.manualNow = t; }
  /** ทดสอบ: เดินเวลาลิฟต์ไป ms มิลลิวินาที (ใช้นาฬิกาที่ตั้งเอง) แล้ววางห้องลิฟต์/ประตูทันทีโดยไม่ต้องรอเฟรม */
  debugStepLift(ms) {
    if (this.manualNow == null) this.manualNow = performance.now();
    this.manualNow += ms;
    this.#stepLift();
  }

  /** หยุด/เดินลูปวาดอัตโนมัติ (ใช้ตอนบันทึกคลิปทีละเฟรม) */
  setPaused(on) { this.paused = !!on; }

  /** วาดหนึ่งเฟรมทันที (ใช้กับนาฬิกาที่ตั้งเอง) — อ่านภาพจาก canvas ได้ในงานเดียวกันหลังเรียก */
  renderNow() {
    this.#stepLift();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.#projectMarkers();
  }

  #stepLift() {
    if (!this.lift) return;
    this.lift.state = stepElevator(this.lift.state, this.#now());
    this.lift.rig.update(this.lift.state);
    this.#emitElevator();
  }

  setLiftView(on) { this.liftView = !!on; this.#applyMode(); }

  #emitElevator(force = false) {
    const st = elevatorStatus(this.lift.state);
    const sig = `${st.phase}|${st.target}|${st.nearest}|${st.direction}|${st.doors}`;
    this.lift.rig.setDisplay(st.phase === 'moving' || st.phase === 'closing' ? st.nearest : st.target, st.arrow);
    if (!force && sig === this.lift.sig) return;
    this.lift.sig = sig;
    this.onElevator(st);
  }

  /** ฐานจาง ๆ ใต้ทาวเวอร์ (ชั้นล่างที่ไม่มีผัง) และป้ายทาวเวอร์ — แสดงเฉพาะมุมมองทั้งอาคาร */
  #buildTowerDeco() {
    if (this.towerDeco) { this.root.remove(this.towerDeco); disposeTree(this.towerDeco); }
    this.towerDeco = null;
    const tower = this.config.building.floors.filter((f) => f.kind === 'tower').sort((a, b) => a.order - b.order);
    if (!tower.length) return;
    const m = tower[0].model;
    const top = tower[tower.length - 1].model;
    const g = new THREE.Group();
    if (m.elevation > 0.05) {
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(m.width, m.elevation, m.depth), new THREE.MeshStandardMaterial({ color: '#b9c6c1', transparent: true, opacity: 0.35, depthWrite: false }));
      plinth.position.set(m.cx, m.elevation / 2, m.cz);
      g.add(plinth);
    }
    const label = textSprite(`ทาวเวอร์สำนักงาน ชั้น ${tower[0].id}–${tower[tower.length - 1].id} · ผังอ้างอิงร่วม · ตำแหน่งยังไม่ยืนยัน`, { scale: 0.011 });
    label.position.set(m.cx, top.elevation + top.height + 0.45, m.cz);
    g.add(label);
    this.towerDeco = g;
    this.root.add(g);
  }

  #buildEquipment() {
    this.equipment?.forEach((e) => { e.parent?.remove(e); disposeTree(e); });
    this.equipment = [];
    const tankPoint = this.config.points.find((p) => p.id === 'P-002' && p.status === 'active');
    const pumpPoint = this.config.points.find((p) => p.id === 'P-003' && p.status === 'active');
    if (tankPoint) {
      const fg = this.floorGroups.get(tankPoint.floorId);
      const f = fg.floor;
      const p = planTo3D(f, tankPoint.plan, 0);
      const g = new THREE.Group();
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.6, 28, 1, true), new THREE.MeshStandardMaterial({ color: '#d7ebe8', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
      glass.position.y = 0.3;
      const water = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1, 28), new THREE.MeshStandardMaterial({ color: '#2a9d94', roughness: 0.2, transparent: true, opacity: 0.85 }));
      water.position.y = 0.01;
      water.scale.y = 0.001;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.015, 6, 28), new THREE.MeshStandardMaterial({ color: '#56656c' }));
      rim.rotation.x = Math.PI / 2; rim.position.y = 0.6;
      g.add(glass, water, rim);
      g.position.set(p.x + 0.65, SLAB_T, p.z);
      fg.group.add(g);
      this.tank = { group: g, water, floorId: tankPoint.floorId };
      this.equipment.push(g);
    } else this.tank = null;
    if (pumpPoint) {
      const fg = this.floorGroups.get(pumpPoint.floorId);
      const p = planTo3D(fg.floor, pumpPoint.plan, 0);
      const g = new THREE.Group();
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.42, 20), new THREE.MeshStandardMaterial({ color: '#6f7f86', metalness: 0.4, roughness: 0.5 }));
      motor.rotation.z = Math.PI / 2;
      motor.position.y = 0.18;
      const fan = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.24, 0.06), new THREE.MeshStandardMaterial({ color: '#2f8f83' }));
        blade.rotation.x = (i * Math.PI) / 2;
        fan.add(blade);
      }
      fan.position.set(0.24, 0.18, 0);
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 12), new THREE.MeshStandardMaterial({ color: '#3a8fb7' }));
      pipe.rotation.x = Math.PI / 2; pipe.position.set(-0.3, 0.12, 0.2);
      g.add(motor, fan, pipe);
      g.position.set(p.x - 0.6, SLAB_T, p.z);
      fg.group.add(g);
      this.pump = { group: g, fan, floorId: pumpPoint.floorId };
      this.equipment.push(g);
    } else this.pump = null;
  }

  /** ค่าที่ขับภาพเคลื่อนไหว — ใช้เฉพาะค่าที่ได้รับและยังสดใหม่ */
  setDynamic({ tankLevel, pumpRunning }) {
    this.dynamic = { tankLevel, pumpRunning };
    if (this.tank) {
      const lv = typeof tankLevel === 'number' ? Math.max(0, Math.min(100, tankLevel)) : null;
      this.tank.water.visible = lv !== null;
      if (lv !== null) {
        const h = 0.58 * (lv / 100) + 0.001;
        this.tank.water.scale.y = h;
        this.tank.water.position.y = 0.01 + h / 2;
      }
    }
  }

  // ---------------------------------------------------------------- จุด IoT
  /** @param {Array<{point, number, severity, quality, label}>} items */
  setPoints(items) {
    this.points = items;
    const seen = new Set();
    for (const it of items) {
      seen.add(it.point.id);
      let o = this.markerObjs.get(it.point.id);
      if (!o) {
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), new THREE.MeshStandardMaterial({ color: COLORS.normal, emissive: '#000000' }));
        sphere.userData.pointId = it.point.id;
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), new THREE.MeshBasicMaterial({ color: '#2b3a3f', transparent: true, opacity: 0.7 }));
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.025, 8, 32), new THREE.MeshBasicMaterial({ color: '#0f6f69' }));
        ring.rotation.x = Math.PI / 2;
        ring.visible = false;
        this.root.add(sphere, pin, ring);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.tabIndex = -1; // การเข้าถึงด้วยแป้นพิมพ์ใช้รายการจุด/ผัง 2D
        btn.className = 'marker';
        btn.addEventListener('click', (e) => { e.stopPropagation(); this.onSelect(it.point.id); });
        this.overlay.appendChild(btn);
        o = { sphere, pin, ring, btn };
        this.markerObjs.set(it.point.id, o);
      }
      o.item = it;
      const color = it.quality !== 'fresh' && it.severity === 'normal' ? COLORS.unknown : COLORS[it.severity];
      o.sphere.material.color.set(color);
      o.btn.className = `marker sev-${it.severity} q-${it.quality}`;
      o.btn.textContent = String(it.number);
      o.btn.setAttribute('aria-label', it.label);
      o.btn.title = it.label;
    }
    for (const [id, o] of this.markerObjs) {
      if (!seen.has(id)) {
        this.root.remove(o.sphere, o.pin, o.ring);
        disposeTree(o.sphere); disposeTree(o.pin); disposeTree(o.ring);
        o.btn.remove();
        this.markerObjs.delete(id);
      }
    }
    this.#placeMarkers();
  }

  setSelected(id) {
    this.selectedId = id;
    for (const [pid, o] of this.markerObjs) {
      o.ring.visible = pid === id;
      o.btn.classList.toggle('selected', pid === id);
    }
  }

  /** ซูมไปที่จุด — ใช้ตำแหน่งปลายทางของชั้น (ไม่ใช่ระหว่างเคลื่อนย้าย) จึงถูกต้องแม้เพิ่งสั่งแยกชั้น */
  focusPoint(id) {
    const o = this.markerObjs.get(id);
    const p = o?.item.point;
    const fg = p && this.floorGroups.get(p.floorId);
    if (!fg) return;
    const local = markerPosition(p, fg.floor, fg.target);
    const wp = this.root.localToWorld(new THREE.Vector3(local.x, local.y, local.z));
    this.autoFit = false;
    let pos;
    if (this.isolatedId) {
      const dist = Math.max(3.2, Math.min(7, fg.floor.model.width * 0.45));
      const e = THREE.MathUtils.degToRad(50);
      pos = wp.clone().add(new THREE.Vector3(0, Math.sin(e) * dist, Math.cos(e) * dist));
    } else {
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      const dist = Math.min(this.camera.position.distanceTo(this.controls.target), 11);
      pos = wp.clone().add(dir.multiplyScalar(dist));
    }
    this.#tweenTo(pos, wp);
  }

  /** สถานะโมเดลรายละเอียดของชั้น: none | loading | ready | error */
  detailState(id) {
    const fg = this.floorGroups.get(id);
    if (!fg?.floor.detail) return 'none';
    return fg.detailState ?? 'idle';
  }

  /**
   * โหลดโมเดลรายชั้นจาก Blender ของผู้ใช้ (GLB) — ไม่แก้รูปทรง สี ป้าย หรือสัญลักษณ์
   * วางด้วย detailTransform จึงตรงกับผังและหมุดทุกจุด และพื้นโมเดล (Z = 0 ใน Blender) อยู่ที่ระดับพื้นชั้น
   * (กลุ่มชั้น + slabT) ซึ่งเป็นระดับเดียวกับที่ลิฟต์จอด · ถ้าโหลดไม่ได้ใช้โมเดลแบบง่ายต่อไป
   * @returns {Promise<void>}
   */
  #ensureDetail(id) {
    const fg = this.floorGroups.get(id);
    const det = fg?.floor.detail;
    if (!det || fg.detailObj) return Promise.resolve();
    if (fg.detailPromise) return fg.detailPromise;
    fg.detailState = 'loading';
    this.onDetail(id, 'loading');
    let p = this.detailCache.get(det.src);
    if (!p) {
      p = new Promise((res, rej) => new GLTFLoader().load(det.src, (g) => res(prepareDetail(g.scene)), undefined, rej));
      this.detailCache.set(det.src, p);
    }
    const cfg = this.config;
    fg.detailPromise = p.then((prep) => {
      if (this.disposed || this.config !== cfg || this.floorGroups.get(id) !== fg) return;
      const obj = prep.group.clone(true); // ใช้ geometry/วัสดุร่วมกับที่โหลดไว้
      const t = detailTransform(fg.floor);
      obj.scale.set(t.scale.x, t.scale.y, t.scale.z);
      obj.position.set(t.position.x, fg.slabT, t.position.z);
      obj.name = `detail-${id}`;
      obj.userData.stats = prep.stats;
      fg.detailObj = obj;
      fg.group.add(obj);
      fg.detailState = 'ready';
      this.#loadRooms(fg);
      this.#applyMode();
      this.onDetail(id, 'ready');
    }, () => {
      if (this.floorGroups.get(id) !== fg) return;
      fg.detailState = 'error';
      fg.detailPromise = null;
      this.detailCache.delete(det.src);
      this.onDetail(id, 'error');
    });
    return fg.detailPromise;
  }

  // ---------------------------------------------------------------- ห้อง/พื้นที่ (กดเพื่อดูข้อมูล)
  /** ข้อมูลห้องของชั้น (rooms-<ชั้น>.json คู่กับไฟล์โมเดล) */
  #loadRooms(fg) {
    if (fg.rooms || fg.roomsPromise) return;
    const src = fg.floor.detail.src.replace(/floor-([^/]+)\.glb$/, 'rooms-$1.json');
    this.roomCache ??= new Map();
    let p = this.roomCache.get(src);
    if (!p) { p = fetch(src).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))); this.roomCache.set(src, p); }
    fg.roomsPromise = p.then((d) => { fg.rooms = d.rooms; fg.roomsMeta = { source: d.source, scale: d.scale_status, alignment: d.alignment }; },
      () => { fg.rooms = []; this.roomCache.delete(src); });
  }

  roomsOf(id) { return this.floorGroups.get(id)?.rooms ?? null; }

  /** หาห้องที่ตำแหน่งบนจอ (พิกัด NDC) — ใช้ผิวโมเดลจริงที่มองเห็น แล้วเทียบกับพื้นที่ห้องในโมเดล */
  #roomAtNdc(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const objs = [];
    for (const fg of this.floorGroups.values()) if (fg.group.visible && fg.detailObj?.visible && fg.rooms) objs.push(fg.detailObj);
    const hits = this.raycaster.intersectObjects(objs, true);
    for (const h of hits) {
      if (this.liftView && !this.isolatedId && this.clipPlane && this.clipPlane.distanceToPoint(h.point) < 0) continue; // ส่วนที่ถูกตัดออก
      let o = h.object; while (o && !o.name.startsWith('detail-')) o = o.parent;
      if (!o) continue;
      const fg = this.floorGroups.get(o.name.slice(7));
      const local = o.worldToLocal(h.point.clone());
      const room = pickRoom(fg.rooms, local.x, -local.z);
      if (room) return { floorId: fg.floor.id, room };
    }
    return null;
  }

  /** เลือกห้อง (ไฮไลต์บนโมเดล) — null = ยกเลิก */
  selectRoom(floorId, roomId) {
    if (this.roomSel?.mesh) { this.roomSel.mesh.parent?.remove(this.roomSel.mesh); this.roomSel.mesh.geometry.dispose(); }
    this.roomSel = null;
    const fg = floorId && this.floorGroups.get(floorId);
    const room = fg?.rooms?.find((r) => r.id === roomId);
    if (!room || !fg.detailObj) return null;
    const t = room.tris; const pos = new Float32Array((t.length / 2) * 3);
    const y = room.top_z + 0.08;
    for (let i = 0, j = 0; i < t.length; i += 2, j += 3) { pos[j] = t[i]; pos[j + 1] = y; pos[j + 2] = -t[i + 1]; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.roomHlMat ??= new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(geo, this.roomHlMat);
    mesh.renderOrder = 6;
    mesh.name = 'room-highlight';
    fg.detailObj.add(mesh);
    this.roomSel = { floorId, room, mesh };
    return room;
  }

  /** ทดสอบ: กดที่ตำแหน่งบนจอ (พิกเซลในพื้นที่แสดงผล) */
  clickAt(px, py) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return this.#handleClick(new THREE.Vector2((px / r.width) * 2 - 1, -(py / r.height) * 2 + 1));
  }

  /** ทดสอบ: ตำแหน่งบนจอของจุดกลางห้อง (พิกเซลในพื้นที่แสดงผล) */
  roomScreenPos(floorId, roomId) {
    const fg = this.floorGroups.get(floorId);
    const room = fg?.rooms?.find((r) => r.id === roomId);
    if (!room || !fg.detailObj) return null;
    const t = room.tris;
    const cx = (t[0] + t[2] + t[4]) / 3; const cy = (t[1] + t[3] + t[5]) / 3; // จุดกลางสามเหลี่ยมแรก (อยู่ในห้องเสมอ)
    fg.detailObj.updateWorldMatrix(true, false);
    const w = fg.detailObj.localToWorld(new THREE.Vector3(cx, room.top_z, -cy)).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (w.x * 0.5 + 0.5) * r.width, y: (-w.y * 0.5 + 0.5) * r.height };
  }

  #handleClick(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = [...this.markerObjs.values()].filter((o) => o.visible).map((o) => o.sphere);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (hit) { this.onSelect(hit.object.userData.pointId); return { point: hit.object.userData.pointId }; }
    const r = this.#roomAtNdc(ndc);
    if (r) { this.selectRoom(r.floorId, r.room.id); this.onRoom({ floorId: r.floorId, room: r.room, meta: this.floorGroups.get(r.floorId).roomsMeta }); return { room: r.room.id, floorId: r.floorId }; }
    this.selectRoom(null); this.onRoom(null);
    return null;
  }

  /** มุมมองทั้งอาคาร: โหลดโมเดลห้องของทุกชั้นทีละ 2 ไฟล์ — ชั้นที่ลิฟต์จอดก่อน ตามด้วยห้างและสำนักงาน */
  #loadAllDetails() {
    const token = (this.allToken = (this.allToken ?? 0) + 1);
    const lift = new Set(this.lift?.spec.floors ?? []);
    // จอเล็ก (มือถือ): โหลดเฉพาะชั้นห้าง ชั้นสำนักงานโหลดเมื่อแยกดูชั้นนั้น (ลดการดาวน์โหลด ~11 MB และภาระการวาด)
    this.towerOnDemand = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
    const order = [...this.floorGroups.values()].filter((g) => g.floor.detail && !(this.towerOnDemand && g.floor.kind === 'tower'))
      .sort((a, b) => (lift.has(b.floor.id) - lift.has(a.floor.id)) || ((a.floor.kind === 'tower') - (b.floor.kind === 'tower')) || a.floor.order - b.floor.order)
      .map((g) => g.floor.id);
    const next = () => {
      if (token !== this.allToken || this.disposed || !order.length) return;
      this.#ensureDetail(order.shift()).then(next, next);
    };
    next(); next();
  }

  #cutPlane() {
    if (!this.clipPlane) {
      this.renderer.localClippingEnabled = true;
      const z = this.lift ? this.lift.spec.z + this.lift.spec.shaft.d / 2 + 0.012 : 0;
      this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), z); // คงส่วนที่ z ≤ หน้าปล่อง
    }
    return this.clipPlane;
  }

  #setClip(obj, plane) {
    const want = plane ? [plane] : null;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if ((m.clippingPlanes?.length ?? 0) === (want?.length ?? 0)) continue;
        m.clippingPlanes = want;
        m.needsUpdate = true;
      }
    });
  }

  /** จำนวนชั้นที่โหลดโมเดลห้องแล้ว / ทั้งหมด */
  detailProgress() {
    const all = [...this.floorGroups.values()].filter((g) => g.floor.detail && !(this.towerOnDemand && g.floor.kind === 'tower' && !g.detailObj));
    return { ready: all.filter((g) => g.detailObj).length, total: all.length, towerOnDemand: !!this.towerOnDemand };
  }

  setLayers(layers) { this.layers = { ...layers }; this.#placeMarkers(); }
  setFloor(id) { this.floorId = id; this.#applyMode(); }
  setMode(mode) { this.mode = mode; this.#applyMode(); }
  get isolated() { return this.isolatedId; }

  /**
   * แยกชั้นออกมาเป็นโมเดลเดี่ยว: ซ่อนชั้นอื่นและส่วนอาคารอื่นทั้งหมด (คงโต๊ะ/ห้องทดลอง)
   * เลื่อนทั้งชั้นพร้อมผัง อุปกรณ์ และหมุดไปกลางฐานด้วยค่าเลื่อนเดียวกัน แล้วปรับกล้องให้เห็นทั้งชั้น
   */
  isolate(id, { instant = false } = {}) {
    if (!this.floorGroups.has(id)) return;
    const prev = this.isolatedId;
    this.isolatedId = id;
    this.floorId = id;
    // ชั้นที่เพิ่งถูกแสดง เริ่มจากตำแหน่งในอาคารเพื่อให้เห็นการเคลื่อนย้ายมากลาง
    if (prev !== id) {
      const fg = this.floorGroups.get(id);
      if (!fg.group.visible || prev) { const a = assembledOffset(fg.floor, this.mode); fg.group.position.set(a.x, a.y, a.z); }
    }
    this.#ensureDetail(id);
    this.#applyMode(instant);
    this.autoFit = true; // ปรับกล้องให้พอดีชั้นอีกครั้งเมื่อขนาดพื้นที่แสดงผลเปลี่ยน จนกว่าผู้ใช้จะหมุน/ซูมเอง
    this.preset('fit', { instant });
  }

  /** กลับไปดูทั้งอาคาร: ประกอบชั้นกลับตำแหน่งเดิม */
  assemble({ instant = false } = {}) {
    if (!this.isolatedId) return;
    const id = this.isolatedId;
    this.isolatedId = null;
    for (const fg of this.floorGroups.values()) {
      if (fg.floor.id === id) continue;
      const a = assembledOffset(fg.floor, this.mode);
      fg.group.position.set(a.x, a.y, a.z); // ชั้นอื่นปรากฏที่ตำแหน่งเดิมทันที ชั้นที่แยกเลื่อนกลับ
    }
    this.#applyMode(instant);
    this.preset('all', { instant });
  }

  #applyMode(instant = false) {
    const sel = this.config?.building.floors.find((f) => f.id === this.floorId);
    const iso = this.isolatedId;
    for (const fg of this.floorGroups.values()) {
      const f = fg.floor;
      const isSel = f.id === this.floorId;
      const t = iso === f.id ? isolatedOffset(f, ISO_CENTER) : assembledOffset(f, this.mode);
      fg.target.set(t.x, t.y, t.z);
      if (instant) { fg.group.position.copy(fg.target); fg.anim = null; }
      else if (fg.group.position.distanceToSquared(fg.target) > 1e-10) {
        // เคลื่อนย้ายแบบกำหนดเวลา (จบแน่นอนภายใน 0.9 วินาที ไม่ขึ้นกับอัตราเฟรม)
        fg.anim = { from: fg.group.position.clone(), start: performance.now(), dur: 900 };
      }
      let visible = true;
      if (iso) visible = f.id === iso;
      else if (this.mode === 'cutaway' && sel && sel.kind !== 'tower' && f.kind !== 'tower') visible = f.order <= sel.order;
      fg.group.visible = visible;
      if (iso) {
        fg.shellMat.opacity = 0.1;
      } else {
        fg.shellMat.opacity = this.mode === 'exterior' ? (isSel ? 0.18 : (f.kind === 'tower' ? 0.3 : 0.42)) : (this.mode === 'cutaway' ? (isSel ? 0.05 : 0.14) : 0.08);
      }
      // มีโมเดล Blender: ซ่อนเปลือกแบบโค้ด ใช้ผนังกระจกในมุมมองอาคาร และซ่อนกระจกในมุมมองชั้นเดี่ยว (เห็นผนังตัดแบบผังสามมิติ)
      const hasModel = !!fg.model;
      // มุมมองชั้นเดี่ยว + มีโมเดลรายชั้นของผู้ใช้: แสดงเฉพาะโมเดลนั้น (แผ่นพื้น ผัง และผนังแบบง่ายซ่อน)
      const showDetail = !!fg.detailObj && (!iso || iso === f.id);
      if (fg.detailObj) fg.detailObj.visible = !!showDetail;
      fg.slab.visible = fg.plan.visible = !showDetail;
      if (fg.model) fg.model.visible = !showDetail;
      fg.shell.visible = !hasModel && !showDetail;
      fg.edges.visible = (!hasModel || isSel) && !(showDetail && iso);
      // มุมมองเปิดปล่อง: ซ่อนกระจก/ผนังแบบง่ายของห้าง (แผ่นพื้นและผังสีร้านคงเดิม)
      const cut = this.liftView && !iso && f.kind !== 'tower';
      if (fg.facade) for (const o of fg.facade) o.visible = !iso && !cut;
      if (fg.walls) for (const o of fg.walls) o.visible = !cut;
      if (cut) fg.shellMat.opacity = Math.min(fg.shellMat.opacity, 0.06);
      // โมเดลห้องของผู้ใช้: ตัดหน้าตัดด้านหน้าปล่องออก (ระนาบตัด) ให้เห็นห้องลิฟต์ — ไม่เปลี่ยนสีหรือรูปทรง
      if (fg.detailObj) this.#setClip(fg.detailObj, cut ? this.#cutPlane() : null);
      for (const eq of [this.tank, this.pump]) if (eq && eq.floorId === f.id) eq.group.visible = !showDetail;
      fg.edges.material.color.set(isSel ? '#0f6f69' : '#8fa79f');
      fg.edges.material.opacity = isSel ? 0.95 : (f.kind === 'tower' ? 0.3 : 0.5);
      fg.label.visible = iso ? false : (isSel || (this.mode === 'exploded' && f.kind !== 'tower')); // มุมมองเดี่ยวใช้ป้าย "กำลังดู" แทน
    }
    if (this.towerDeco) this.towerDeco.visible = !iso;
    if (this.lift) this.lift.rig.group.visible = !iso; // มุมมองชั้นเดี่ยวใช้สัญลักษณ์ลิฟต์ในโมเดลของผู้ใช้
    if (this.roomSel && !this.floorGroups.get(this.roomSel.floorId)?.group.visible) { this.selectRoom(null); this.onRoom(null); }
    this.#placeMarkers();
  }

  #placeMarkers() {
    if (!this.config) return;
    const floors = new Map(this.config.building.floors.map((f) => [f.id, f]));
    for (const [, o] of this.markerObjs) {
      const p = o.item.point;
      const f = floors.get(p.floorId);
      const fg = this.floorGroups.get(p.floorId);
      if (!f || !fg) { o.visible = false; continue; }
      // หมุดใช้ค่าเลื่อนเดียวกับกลุ่มชั้น จึงอยู่ตำแหน่งเดิมเมื่อเทียบกับผังเสมอ
      const pos = markerPosition(p, f, fg.group.position);
      o.sphere.position.set(pos.x, pos.y, pos.z);
      const baseY = fg.group.position.y + fg.slabT;
      o.pin.scale.y = Math.max(0.01, pos.y - baseY);
      o.pin.position.set(pos.x, (pos.y + baseY) / 2, pos.z);
      o.ring.position.set(pos.x, baseY + 0.02, pos.z);
      o.visible = fg.group.visible && this.layers[p.system] !== false && (!this.isolatedId || p.floorId === this.isolatedId);
      o.sphere.visible = o.pin.visible = o.visible;
      o.ring.visible = o.visible && p.id === this.selectedId;
    }
  }

  // ---------------------------------------------------------------- กล้อง
  availablePresets() {
    if (this.isolatedId) return ['fit', 'top'];
    const out = ['all', 'floor'];
    const kinds = new Set();
    if (this.config) {
      const areaKind = new Map(this.config.building.areas.map((a) => [a.id, a.kind]));
      for (const p of this.config.points) if (p.status === 'active' && p.areaId) kinds.add(areaKind.get(p.areaId));
    }
    // แสดงเฉพาะ preset ที่มีพื้นที่ประเภทนั้นกำหนดไว้จริง (และมีจุดอยู่) ในการตั้งค่า
    if (kinds.has('plant')) out.push('plant');
    if (kinds.has('roof')) out.push('roof');
    if (kinds.has('underfloor')) out.push('underfloor');
    out.push('top');
    if (this.lift) out.push('lift');
    return out;
  }

  /** ระยะกล้องที่เห็นกรอบกว้าง w × ลึก d ได้ทั้งหมด */
  #fitDistance(w, d, elevDeg) {
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const e = THREE.MathUtils.degToRad(elevDeg);
    const needW = (w / 2) / Math.tan(hfov / 2);
    const needD = ((d * Math.sin(e) + 0.4 * Math.cos(e)) / 2) / Math.tan(vfov / 2);
    return Math.max(needW, needD) * 1.06 + Math.max(w, d) * 0.04;
  }

  preset(name, { instant = false } = {}) {
    const floors = this.config.building.floors;
    const sel = floors.find((f) => f.id === this.floorId) ?? floors[0];
    const fg = this.floorGroups.get(sel.id);
    let pos; let target;
    if (this.isolatedId && (name === 'fit' || name === 'floor' || name === 'top')) {
      const f = this.floorGroups.get(this.isolatedId).floor;
      const t = isolatedOffset(f, ISO_CENTER);
      const c = new THREE.Vector3(ISO_CENTER.x, BASE_Y + t.y + 0.2, ISO_CENTER.z);
      if (name === 'top') {
        const dist = this.#fitDistance(f.model.width, f.model.depth, 89) ;
        target = c; pos = c.clone().add(new THREE.Vector3(0, dist, 0.01));
      } else {
        const elev = 52;
        const dist = this.#fitDistance(f.model.width, f.model.depth, elev);
        const er = THREE.MathUtils.degToRad(elev);
        target = c; pos = c.clone().add(new THREE.Vector3(0, Math.sin(er) * dist, Math.cos(er) * dist));
      }
    } else {
      const center = (f, g) => new THREE.Vector3(f.model.cx, BASE_Y + (g?.target.y ?? f.model.elevation) + 0.3, f.model.cz);
      const kindTarget = (kind) => {
        const areaKind = new Map(this.config.building.areas.map((a) => [a.id, a.kind]));
        const pts = this.config.points.filter((p) => p.status === 'active' && areaKind.get(p.areaId) === kind);
        const v = new THREE.Vector3();
        let n = 0;
        for (const p of pts) { const o = this.markerObjs.get(p.id); if (o) { v.add(this.root.localToWorld(o.sphere.position.clone())); n++; } }
        return n ? v.multiplyScalar(1 / n) : null;
      };
      switch (name) {
        case 'floor': target = center(sel, fg); pos = target.clone().add(new THREE.Vector3(sel.kind === 'tower' ? 2 : 3, sel.model.width > 10 ? 9 : 5, sel.model.width > 10 ? 10 : 6)); break;
        case 'plant': case 'roof': case 'underfloor': {
          target = kindTarget(name);
          if (!target) return;
          pos = target.clone().add(new THREE.Vector3(2.5, 4, 5)); break;
        }
        case 'top': target = new THREE.Vector3(0, 2, -2); pos = new THREE.Vector3(0, 30, -1.9); break;
        case 'lift': {
          // มองด้านหน้าเฉียงเล็กน้อย เห็นปล่องตั้งแต่ชั้นล่างถึงชั้นบนในภาพเดียว (ยังหมุน/ซูมได้ตามปกติ)
          if (!this.lift) return;
          const b = this.lift.rig.bounds();
          const H = b.y1 - b.y0 + 0.4;
          const vfov = THREE.MathUtils.degToRad(this.camera.fov);
          const dist = Math.max(3.5, (H / 2) / Math.tan(vfov / 2) * 1.08);
          target = new THREE.Vector3(b.x, BASE_Y + (b.y0 + b.y1) / 2, b.z);
          const dir = new THREE.Vector3(0.42, 0.16, 1).normalize();
          // เลื่อนกรอบภาพให้ปล่องอยู่ค่อนซ้าย (แผงลิฟต์อยู่ด้านขวาของภาพ)
          const right = new THREE.Vector3().crossVectors(dir.clone().negate(), new THREE.Vector3(0, 1, 0)).normalize();
          const halfW = Math.tan(vfov / 2) * dist * this.camera.aspect;
          target.add(right.multiplyScalar(halfW * 0.22));
          pos = target.clone().add(dir.multiplyScalar(dist));
          break;
        }
        default: target = new THREE.Vector3(-0.5, 2.2, -1.8); pos = new THREE.Vector3(4, 15, 20);
      }
    }
    if (instant) { this.tween = null; this.camera.position.copy(pos); this.controls.target.copy(target); this.controls.update(); }
    else this.#tweenTo(pos, target);
  }

  #tweenTo(pos, target) {
    this.tween = { t: 0, start: performance.now(), fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), pos, target };
  }

  // ---------------------------------------------------------------- อินพุต
  #bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > CLICK_PX) return; // เป็นการลากหมุนกล้อง ไม่ใช่คลิก
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.#handleClick(ndc); // หมุด IoT ก่อน แล้วจึงห้อง/พื้นที่ในโมเดล
    });
  }

  #resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const prevAspect = this.camera.aspect;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.isolatedId && this.autoFit && w > 10 && h > 10 && Math.abs(prevAspect - this.camera.aspect) > 1e-3) this.preset('fit', { instant: !this.tween });
  }

  // ---------------------------------------------------------------- ลูปวาด
  #frame() {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loopFn);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.paused || document.hidden || !this.container.isConnected || this.container.offsetParent === null) return;
    let moving = false;
    const nowMs = performance.now();
    for (const fg of this.floorGroups.values()) {
      if (!fg.anim) continue;
      const k = Math.min(1, (nowMs - fg.anim.start) / fg.anim.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      fg.group.position.lerpVectors(fg.anim.from, fg.target, e);
      if (k >= 1) { fg.group.position.copy(fg.target); fg.anim = null; }
      moving = true;
    }
    if (moving) this.#placeMarkers();
    this.#stepLift();
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, (nowMs - tw.start) / 800);
      const k = tw.t < 0.5 ? 2 * tw.t * tw.t : 1 - (-2 * tw.t + 2) ** 2 / 2;
      this.camera.position.lerpVectors(tw.fromPos, tw.pos, k);
      this.controls.target.lerpVectors(tw.fromTarget, tw.target, k);
      if (tw.t >= 1) this.tween = null;
    }
    // ปั๊มหมุนเฉพาะเมื่อได้รับสถานะ run ที่สดใหม่ (ไม่ใช่การยืนยันสภาพเครื่อง)
    if (this.pump && this.dynamic.pumpRunning === true) this.pump.fan.rotation.x += dt * 9;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.#projectMarkers();
    this.frameNo = (this.frameNo ?? 0) + 1;
  }

  #projectMarkers() {
    const w = this.container.clientWidth; const h = this.container.clientHeight;
    const slabs = [...this.floorGroups.values()].filter((g) => g.group.visible).map((g) => g.slab);
    const placed = [];
    const items = [...this.markerObjs.values()].sort((a, b) => {
      const pa = (a.item.point.id === this.selectedId ? 10 : 0) + severityRank(a.item.severity) * 2 + (a.item.quality !== 'fresh' ? 1 : 0);
      const pb = (b.item.point.id === this.selectedId ? 10 : 0) + severityRank(b.item.severity) * 2 + (b.item.quality !== 'fresh' ? 1 : 0);
      return pb - pa;
    });
    const camPos = this.camera.position;
    for (const o of items) {
      if (!o.visible) { o.btn.hidden = true; continue; }
      const wp = this.root.localToWorld(o.sphere.position.clone());
      const v = wp.clone().project(this.camera);
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) { o.btn.hidden = true; continue; }
      const x = (v.x * 0.5 + 0.5) * w; const y = (-v.y * 0.5 + 0.5) * h;
      // ถูกบังโดยแผ่นพื้นชั้นอื่นหรือไม่
      const dir = wp.clone().sub(camPos);
      const dist = dir.length();
      this.raycaster.set(camPos, dir.normalize());
      this.raycaster.far = dist - 0.2;
      const occluded = this.raycaster.intersectObjects(slabs, false).length > 0;
      this.raycaster.far = Infinity;
      const crowded = placed.some((p) => Math.hypot(p.x - x, p.y - y) < 24);
      if (!crowded) placed.push({ x, y });
      o.btn.hidden = false;
      o.btn.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      o.btn.classList.toggle('occluded', occluded && o.item.point.id !== this.selectedId);
      o.btn.classList.toggle('stacked', crowded && o.item.point.id !== this.selectedId);
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }
}

function disposeTree(obj) {
  obj.traverse?.((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
  });
}
