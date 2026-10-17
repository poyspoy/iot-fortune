import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { textSprite } from './textures.js';
import { planTo3D, isolatedOffset, assembledOffset, markerPosition, detailTransform } from '../domain/geometry.js';
import { severityRank } from '../domain/constants.js';
import { ELEVATOR_L1 } from '../domain/elevator.js';
import { ElevatorSim, ELEVATOR_DEMO_CONFIG } from '../domain/elevatorSim.js';
import { LayerManager } from './layers.js';
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

/** รูปแบบอาคาร: a = ความทึบของวัสดุอาคาร (คูณค่าเดิม), l = ความเข้มของเส้นโครง */
const BUILDING_STYLES = { solid: { a: 1, l: 0 }, transparent: { a: 0.22, l: 0 }, wire: { a: 0, l: 1 } };

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
    this.onFloorPick = opts.onFloorPick ?? (() => {});
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
    // อาคารเป็นวัตถุคงที่: ไม่คำนวณเงาใหม่ทุกเฟรม — คำนวณเฉพาะเมื่อฉากเปลี่ยน (โหลดโมเดล เปลี่ยนชั้น/มุมมอง/รูปแบบอาคาร/เลเยอร์)
    // ส่วนที่เคลื่อนที่ (ห้องลิฟต์ ประตู) ไม่ทอดเงาลงแผนที่เงาคงที่ — ตรวจแล้วเงาของห้องลิฟต์ไม่ปรากฏในมุมมองใด
    this.renderer.shadowMap.autoUpdate = false;
    this.shadowDirty = true;
    this.renderer.domElement.className = 'scene-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(this.renderer.domElement);

    this.overlay = document.createElement('div');
    this.overlay.className = 'marker-layer';
    container.appendChild(this.overlay);

    this.scene = new THREE.Scene();
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
    // เลเยอร์ของฉาก (base/building/floor-plan/assets/sensors/elevator/alerts/labels …) — ซ่อน/แสดงทั้งเลเยอร์ได้ ค่าเงาใช้ชุดเดียวกับกล้องหลัก
    this.sceneLayers = new LayerManager(this.camera, this.raycaster);
    this.sceneLayers.onChange = () => { if (this.config) this.#placeMarkers(); };
    this.sceneLayers.assign(this.baseGroup, 'base');

    this.#bindPointer();
    this.resizeObs = new ResizeObserver(() => this.#resize());
    this.resizeObs.observe(container);
    this.#resize();
    this.loopFn = () => this.#frame();
    this.raf = requestAnimationFrame(this.loopFn);
  }

  // ---------------------------------------------------------------- ห้อง/โต๊ะ
  #buildRoom() {
    // ฉากแบบ Digital Twin: พื้นหลังเรียบโทนเข้ม ฐานอาคารสีเทาเข้มขอบเขียว Nexza แสงนุ่ม เงาเบา
    const s = this.scene;
    s.background = new THREE.Color('#141b1f');
    s.fog = new THREE.Fog('#141b1f', 45, 90);
    s.add(new THREE.HemisphereLight('#eef4f2', '#2a3438', 1.05));
    const key = new THREE.DirectionalLight('#ffffff', 1.25);
    key.position.set(-12, 24, 14);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -18; sc.right = 18; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 70;
    key.shadow.bias = -0.0006;
    key.shadow.radius = 4;
    s.add(key);
    const fill = new THREE.DirectionalLight('#cfe9e5', 0.45);
    fill.position.set(14, 10, -12);
    s.add(fill);

    // พื้นฉาก (ไกล) + เส้นกริดจาง ๆ — รวมไว้ในกลุ่มฐาน (เลเยอร์ base) แยกจากไฟ
    this.baseGroup = new THREE.Group();
    this.baseGroup.name = 'layer-base';
    s.add(this.baseGroup);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#182125', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.62;
    ground.receiveShadow = true;
    this.baseGroup.add(ground);
    const grid = new THREE.GridHelper(120, 60, '#24343a', '#1e2a2f');
    grid.position.y = -0.6;
    this.baseGroup.add(grid);

    // ฐานอาคาร: แท่นสีเทาเข้ม ผิวบนเรียบ ขอบเรืองแสงสีเขียว Nexza
    const W = 25.2; const D = 13.8; const cx = -0.3; const cz = -2.1;
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(W, 0.6, D), new THREE.MeshStandardMaterial({ color: '#2b3539', roughness: 0.85, metalness: 0.05 }));
    plinth.position.set(cx, -0.3, cz);
    plinth.receiveShadow = true;
    this.baseGroup.add(plinth);
    const top = new THREE.Mesh(new THREE.BoxGeometry(W - 0.4, BASE_Y, D - 0.4), new THREE.MeshStandardMaterial({ color: '#3a464b', roughness: 0.9 }));
    top.position.set(cx, BASE_Y / 2, cz);
    top.receiveShadow = true;
    this.baseGroup.add(top);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W - 0.4, BASE_Y, D - 0.4)), new THREE.LineBasicMaterial({ color: '#2fa39a', transparent: true, opacity: 0.85 }));
    edge.position.copy(top.position);
    this.baseGroup.add(edge);
    const baseGrid = new THREE.GridHelper(24, 24, '#4a585d', '#435055');
    baseGrid.scale.set((W - 0.4) / 24, 1, (D - 0.4) / 24);
    baseGrid.position.set(cx, BASE_Y + 0.002, cz);
    baseGrid.material.transparent = true; baseGrid.material.opacity = 0.35;
    this.baseGroup.add(baseGrid);
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
    // มุมมองทั้งอาคารใช้โมเดลอาคารแบบเบา (fortune.glb + ผัง) — โมเดลรายละเอียดโหลดเฉพาะชั้นที่เลือกดู
    for (const fg of this.floorGroups.values()) this.sceneLayers.assign(fg.group, 'building');
    if (this.towerDeco) this.sceneLayers.assign(this.towerDeco, 'building');
    for (const t of this.tanks.values()) this.sceneLayers.assign(t.group, 'assets');
    if (this.pump) this.sceneLayers.assign(this.pump.group, 'assets');
    if (this.isolatedId && !this.floorGroups.has(this.isolatedId)) this.isolatedId = null;
    if (!this.floorId) this.floorId = config.building.floors[0]?.id;
    this.#applyMode(true);
    // คอมไพล์ shader ของฉากเริ่มต้นแบบไม่บล็อกหน้าเว็บ (KHR_parallel_shader_compile) ก่อนวาดเฟรมแรก — เดิมคอมไพล์ตอนวาดครั้งแรกทำให้หน้าค้าง
    this.compiling = true;
    this.#compile(this.scene).finally(() => { this.compiling = false; });
  }

  /** คอมไพล์วัสดุของวัตถุล่วงหน้าแบบ async (ใช้แสง/หมอกของฉากหลัก) — ถ้าเบราว์เซอร์ไม่รองรับก็ผ่านไปตามเดิม */
  #compile(obj) {
    const r = this.renderer;
    if (typeof r.compileAsync !== 'function') return Promise.resolve();
    return r.compileAsync(obj, this.camera, this.scene).catch(() => {});
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

    // ป้ายชื่อชั้นข้างแผ่นชั้น (หันเข้ากล้องเสมอ) — ใช้คำว่า "ชั้น …" ไม่ใช่เลขเดี่ยว เพื่อไม่สับสนกับหมายเลขจุดตรวจวัด
    // ห้าง: ด้านซ้ายนอกตัวอาคาร · ชั้น 5 (ลานจอด) อยู่ค่อนขวา จึงวางด้านขวานอกตัวอาคาร · สำนักงาน: ด้านซ้ายของทาวเวอร์
    const tower = floor.kind === 'tower';
    const lblScale = tower ? 0.0045 : 0.0125;
    const lblText = `ชั้น ${floor.id}`; // รูปแบบเดียวกันทุกชั้น
    const label = textSprite(lblText, { scale: lblScale });
    const hlLabel = textSprite(lblText, { scale: lblScale * 1.12, color: '#ffffff', bg: 'rgba(15,111,105,0.96)' });
    const podiumHalf = 11.25; // ขอบอาคารห้าง (กว้าง 22) + ระยะห่าง
    const right = false; // ทุกชั้นห้าง (G–5) วางด้านซ้ายนอกอาคาร ตำแหน่งเดียวกัน
    for (const l of [label, hlLabel]) {
      l.center.set(right ? 0 : 1, 0.5);
      l.position.set(right ? podiumHalf : (tower ? m.cx - m.width / 2 - 0.1 : -podiumHalf), tower ? 0.12 : 0.3, tower ? m.cz + m.depth / 2 : 1.9); // ห้าง: แนวเดียวกันทุกชั้น (ขอบหน้าชั้น G–3)
      l.renderOrder = 11;
      group.add(l);
    }
    label.name = 'floor-label'; hlLabel.name = 'floor-label-hl';

    // ป้ายชื่อชั้นตัวใหญ่ข้างโมเดล — แสดงเมื่อแยกดูชั้นนี้
    const isoLabel = textSprite(floor.name, { scale: 0.022, size: 44, color: '#ffffff', bg: 'rgba(15,111,105,0.95)' });
    isoLabel.center.set(0, 0);
    isoLabel.position.set(m.cx - m.width / 2, 0.6, m.cz - m.depth / 2); // มุมซ้ายด้านหลัง เหนือผนัง (ไม่บังห้อง)
    isoLabel.visible = false;
    isoLabel.name = 'iso-label';
    group.add(isoLabel);

    this.root.add(group);
    return { group, slab, slabT, plan, shell, shellMat, edges, label, hlLabel, isoLabel, floor, planMat, target: new THREE.Vector3() };
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
    this.glassMat ??= new THREE.MeshStandardMaterial({ color: '#a9d2cd', transparent: true, opacity: 0.26, roughness: 0.08, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }); // กระจกบาง: วาดรอบเดียว (ไม่แยกด้านหลัง/หน้า 2 รอบ)
    new GLTFLoader().load(src, async (gltf) => {
      if (token !== this.modelToken || this.disposed) return;
      // ตั้งค่าเงา/กระจกบนต้นฉบับก่อน (ทุกชั้นโคลนจากต้นฉบับ) แล้วคอมไพล์ shader แบบไม่บล็อก ก่อนนำเข้าฉาก
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        if (o.material?.name === 'Glass') { o.material = this.glassMat; o.castShadow = false; }
      });
      await this.#compile(gltf.scene);
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
          if (o.material === this.glassMat || name === 'Glass') { o.material = this.glassMat; o.renderOrder = 3; o.castShadow = false; fg.facade.push(o); }
          else if (name === 'Frame') fg.facade.push(o);
          else if (name === 'Wall') fg.walls.push(o);
        });
        fg.model?.parent?.remove(fg.model);
        fg.model = clone;
        fg.group.add(clone);
        this.sceneLayers.assign(clone, 'building');
      }
      this.modelLoaded = true;
      this.shadowDirty = true;
      this.#applyStyle();
      this.onDetail?.("building", "ready");
      this.#applyMode();
    }, undefined, () => { this.modelLoaded = false; });
  }

  // ---------------------------------------------------------------- ลิฟต์จำลอง
  /** ปล่อง + ห้องลิฟต์ L1 — จอดเฉพาะชั้นที่มีอยู่ในการตั้งค่าอาคาร (ลำดับตาม order) */
  #buildElevator() {
    if (this.lift) { this.sceneLayers.release(this.lift.rig.group); this.root.remove(this.lift.rig.group); disposeTree(this.lift.rig.group); }
    const have = new Map(this.config.building.floors.map((f) => [f.id, f]));
    const floors = ELEVATOR_L1.floors.filter((id) => have.has(id)).sort((a, b) => have.get(a).order - have.get(b).order);
    if (floors.length < 2) { this.lift = null; return; }
    const spec = { ...ELEVATOR_L1, floors };
    const levelOf = (id) => { const fg = this.floorGroups.get(id); return fg ? fg.group.position.y + fg.slabT : null; };
    const heightOf = (id) => have.get(id)?.model.height ?? 0.8;
    const rig = new ElevatorRig(spec, levelOf, heightOf, (id) => this.floorGroups.get(id)?.group.visible !== false);
    // ตัวจำลองเดิมเดินต่อ (ไม่เริ่มใหม่ที่ G) เมื่อโหลดการตั้งค่าใหม่ ถ้าชั้นที่จอดยังเหมือนเดิม
    const prev = this.lift?.sim;
    const sim = prev && prev.floors.join() === floors.join() ? prev
      : new ElevatorSim(floors, { config: this.liftConfig ?? ELEVATOR_DEMO_CONFIG, now: this.#now(), seed: (Date.now() & 0xffff) || 7 });
    this.lift = { spec, rig, sim, sig: '' };
    this.sceneLayers.assign(rig.group, 'elevator');
    for (const o of rig.labelObjects()) this.sceneLayers.assign(o, 'labels');
    this.root.add(rig.group);
    this.#stepLift();
  }

  /** สั่งลิฟต์จำลองไปชั้น (คำสั่งผู้ใช้มีสิทธิ์ก่อนโหมดอัตโนมัติ) — คืน 'started' | 'same-floor' | 'unknown-floor' | 'none' */
  requestElevator(floorId) {
    if (!this.lift) return 'none';
    const r = this.lift.sim.request(floorId, this.#now());
    this.#emitElevator(true);
    return r === 'same-floor' || r === 'unknown-floor' ? r : 'started';
  }

  setLiftAuto(on) { if (!this.lift) return; this.lift.sim.setAuto(on); this.#emitElevator(true); }
  setLiftPaused(on) { if (!this.lift) return; this.lift.sim.setPaused(on); this.#emitElevator(true); }
  resetLift() { if (!this.lift) return; this.lift.sim.reset(this.#now()); this.#emitElevator(true); }

  elevatorFloors() { return this.lift ? [...this.lift.spec.floors] : []; }
  elevatorStatus() { return this.lift ? this.lift.sim.status() : null; }

  /** ข้อมูลตรวจสอบ (ใช้ในการทดสอบเบราว์เซอร์): ความสูงพื้นห้องลิฟต์เทียบกับพื้นชั้น และระยะเปิดประตู */
  elevatorProbe() {
    if (!this.lift) return null;
    const { rig, sim } = this.lift;
    const lv = rig.lastLevels ?? rig.levels();
    const levels = Object.fromEntries(rig.spec.floors.map((id, i) => [id, lv[i]]));
    const modelFloor = Object.fromEntries(rig.spec.floors.map((id) => {
      const fg = this.floorGroups.get(id);
      return [id, fg?.detailObj ? fg.group.position.y + fg.detailObj.position.y : null];
    }));
    return { phase: sim.phase, pos: sim.pos, vel: sim.vel, door: sim.door, carY: rig.car.position.y, levels, modelFloor, target: sim.floors[sim.target], mode: sim.mode,
      doorGap: rig.doorR.position.x - rig.doorL.position.x - rig.spec.car.w / 2, visible: rig.group.visible, carVisible: rig.group.visible && rig.car.visible };
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
    if (this.styleAnim) this.#styleFrame(performance.now());
    this.controls.update();
    this.#flushShadows();
    this.renderer.render(this.scene, this.camera);
    this.#projectMarkers();
  }

  #stepLift() {
    if (!this.lift) return;
    const { sim, rig } = this.lift;
    sim.step(this.#now()); // ตัวจำลองเดินเบื้องหลังเสมอ (รวมตอนดูชั้นเดียว)
    const iso = this.isolatedId;
    if (!iso) {
      rig.update(sim, null);
    } else {
      // ดูชั้นเดียว: แสดงรถลิฟต์/ประตูในชั้นนั้นเมื่อลิฟต์อยู่ใกล้ระดับชั้นนี้ (ตำแหน่งปล่องเลื่อนตามชั้นที่แยกมา)
      const idx = rig.spec.floors.indexOf(iso);
      const fg = this.floorGroups.get(iso);
      if (idx < 0 || !fg) { rig.group.visible = false; }
      else {
        const base = fg.group.position.y + fg.slabT;
        const h = fg.floor.model.height ?? 0.8;
        rig.update(sim, { levels: rig.spec.floors.map((_, i) => base + (i - idx) * h), onlyIndex: idx, offset: { x: fg.group.position.x, z: fg.group.position.z } });
        rig.group.visible = Math.abs(sim.pos - idx) < 0.85 && !(fg.fade && fg.fade.to === 0);
      }
    }
    this.#emitElevator();
  }

  setLiftView(on) { this.liftView = !!on; this.#applyMode(); }

  #emitElevator(force = false) {
    const st = this.lift.sim.status();
    const sig = `${st.phase}|${st.target}|${st.nearest}|${st.direction}|${st.doors}|${st.mode}|${st.auto}|${st.paused}|${st.queue.join()}`;
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
    const label = textSprite(`ชั้นสำนักงาน ${tower[0].id}–${tower[tower.length - 1].id} · ผังอ้างอิงร่วม`, { scale: 0.011 });
    label.position.set(m.cx, top.elevation + top.height + 0.45, m.cz);
    g.add(label);
    this.towerDeco = g;
    this.root.add(g);
    this.towerCenter = new THREE.Vector3(m.cx, BASE_Y + (m.elevation + top.elevation + top.height) / 2, m.cz);
  }

  #buildEquipment() {
    this.equipment?.forEach((e) => { e.parent?.remove(e); disposeTree(e); });
    this.equipment = [];
    const pumpPoint = this.config.points.find((p) => p.id === 'P-003' && p.status === 'active');
    // ถังแสดงระดับน้ำ (เซนเซอร์ระดับน้ำจำลอง) — วางข้างหมุดของจุดนั้น น้ำค่อย ๆ ขึ้น/ลงตามค่า
    this.tanks = new Map();
    // ทุกจุดที่มีค่าวัดกำหนด gauge (จากการตั้งค่า/ API ในอนาคต) ได้ภาพถังบนโมเดล — ไม่ผูกรหัสจุดในโค้ดหน้าจอ
    for (const pt of this.config.points.filter((p) => p.status === 'active')) {
      const gm = pt.metrics.find((m) => m.gauge);
      if (!gm || !this.floorGroups.get(pt.floorId)) continue;
      const id = pt.id; const kind = gm.gauge.visual === 'pit' ? 'pit' : 'tank';
      const fg = this.floorGroups.get(pt.floorId);
      const p = planTo3D(fg.floor, pt.plan, 0);
      const R = 0.17; const H = 0.38;
      const g = new THREE.Group();
      g.name = `water-${id}`;
      g.userData.keepOpaque = true; // ถังเซนเซอร์ไม่โปร่งตามรูปแบบอาคาร
      const shell = kind === 'pit' ? new THREE.BoxGeometry(R * 2.2, H, R * 2.2, 1, 1, 1) : new THREE.CylinderGeometry(R, R, H, 32, 1, true);
      const glass = new THREE.Mesh(shell, new THREE.MeshStandardMaterial({ color: '#d7ebe8', transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }));
      glass.position.y = H / 2;
      const waterGeo = kind === 'pit' ? new THREE.BoxGeometry(R * 2.1, 1, R * 2.1) : new THREE.CylinderGeometry(R * 0.94, R * 0.94, 1, 32);
      waterGeo.translate(0, 0.5, 0); // ฐานน้ำอยู่ที่ y = 0 แล้วขยายขึ้นด้านบน
      const waterMat = new THREE.MeshStandardMaterial({ color: '#2a8fd0', roughness: 0.15, transparent: true, opacity: 0.88, emissive: '#0b3d66', emissiveIntensity: 0.35 });
      const water = new THREE.Mesh(waterGeo, waterMat);
      water.position.y = 0.006;
      water.scale.y = 0.001;
      const edgeGeo = kind === 'pit' ? new THREE.EdgesGeometry(shell) : new THREE.EdgesGeometry(new THREE.CylinderGeometry(R, R, H, 32, 1, true), 40);
      const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: '#9fb6bc' }));
      edges.position.y = H / 2;
      // ผิวน้ำ: แผ่นบาง ๆ บนสุด เอียง/สว่างเบา ๆ เป็นคลื่น (ไม่กระพริบแรง)
      const surfMat = new THREE.MeshBasicMaterial({ color: '#bfe6ff', transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      const surf = new THREE.Mesh(kind === 'pit' ? new THREE.PlaneGeometry(R * 2.08, R * 2.08) : new THREE.CircleGeometry(R * 0.93, 32), surfMat);
      surf.rotation.x = -Math.PI / 2;
      g.add(glass, water, edges, surf);
      g.position.set(p.x + 0.42, SLAB_T, p.z);
      fg.group.add(g);
      this.tanks.set(id, { group: g, water, waterMat, surf, surfMat, H, cur: 0, target: null, last: null, floorId: pt.floorId, metricId: gm.id, phase: Math.random() * 6 });
      this.equipment.push(g);
    }
    this.tank = null;
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
      g.userData.keepOpaque = true;
      this.pump = { group: g, fan, floorId: pumpPoint.floorId };
      this.equipment.push(g);
    } else this.pump = null;
  }

  /** ค่าที่ขับภาพเคลื่อนไหว — ใช้เฉพาะค่าที่ได้รับและยังสดใหม่ */
  /**
   * ค่าที่ขับภาพเคลื่อนไหว — ใช้เฉพาะค่าที่ได้รับและยังสดใหม่
   * @param {{ water?: Record<string, {frac:number|null, severity:string}>, pumpRunning?: boolean|null }} d
   */
  setDynamic({ water = {}, pumpRunning }) {
    this.dynamic = { pumpRunning };
    for (const [id, t] of this.tanks ?? []) {
      const w = water[id];
      t.target = w && typeof w.frac === 'number' ? Math.max(0, Math.min(1, w.frac)) : null;
      if (t.target !== null) t.last = t.target;
      // ข้อมูลเก่า/ไม่มีข้อมูล: คงระดับล่าสุดแต่เป็นสีเทา (ไม่ค้างสีเขียว/น้ำเงิน) — ยังไม่เคยมีค่าเลยจึงซ่อนน้ำ
      const stale = t.target === null;
      t.water.visible = t.surf.visible = t.last !== null;
      t.waterMat.color.set(stale ? '#8a969b' : w?.severity === 'critical' ? '#d0473f' : w?.severity === 'warning' ? '#e0a52a' : '#2a8fd0');
      t.waterMat.emissive.set(stale ? '#1d2326' : '#0b3d66');
      t.stale = stale;
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
        for (const m of [sphere, pin, ring]) this.sceneLayers.assign(m, 'sensors');
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
    if (!det) return Promise.resolve();
    if (fg.detailObj) { this.#touchDetail(det.src); return Promise.resolve(); }
    if (fg.detailPromise) return fg.detailPromise;
    fg.detailState = 'loading';
    this.onDetail(id, 'loading');
    let p = this.detailCache.get(det.src);
    if (!p) {
      // โหลด → เตรียม → คอมไพล์ shader แบบไม่บล็อก แล้วจึงแสดง (ลดอาการค้างตอนเปิดชั้นครั้งแรก)
      p = new Promise((res, rej) => new GLTFLoader().load(det.src, (g) => res(prepareDetail(g.scene)), undefined, rej))
        .then((prep) => this.#compile(prep.group).then(() => prep));
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
      // ซ่อนโมเดลชั้นเดิมก่อนแสดงชั้นใหม่: ชั้นที่ไม่ได้เลือกแล้วจะไม่แสดงโมเดลรายละเอียด (applyMode)
      fg.detailObj = obj;
      fg.group.add(obj);
      this.sceneLayers.assign(obj, 'floor-plan');
      fg.detailState = 'ready';
      this.shadowDirty = true;
      this.#touchDetail(det.src);
      this.#loadRooms(fg);
      this.#applyMode();
      this.#applyStyle();
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
    for (const fg of this.floorGroups.values()) if (fg.group.visible && !(fg.fade && fg.fade.to === 0) && (!this.isolatedId || fg.floor.id === this.isolatedId) && fg.detailObj?.visible && fg.rooms) objs.push(fg.detailObj);
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
    this.roomHlMat ??= new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); // กันกระพริบซ้อนพื้น (z-fighting)
    const mesh = new THREE.Mesh(geo, this.roomHlMat);
    mesh.renderOrder = 6;
    mesh.name = 'room-highlight';
    this.sceneLayers.assign(mesh, 'alerts');
    fg.detailObj.add(mesh);
    this.roomSel = { floorId, room, mesh };
    return room;
  }

  /** ทดสอบ: กดที่ตำแหน่งบนจอ (พิกเซลในพื้นที่แสดงผล) */
  clickAt(px, py) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return this.#handleClick(new THREE.Vector2((px / r.width) * 2 - 1, -(py / r.height) * 2 + 1));
  }

  /** ทดสอบ: ตำแหน่งบนจอของป้ายชื่อชั้น */
  labelScreenPos(floorId) {
    const fg = this.floorGroups.get(floorId);
    if (!fg?.label.visible) return null;
    const c = fg.label.center; const sc = fg.label.scale;
    const w = fg.label.getWorldPosition(new THREE.Vector3());
    // กลางป้าย (center ของ sprite อาจไม่ใช่กึ่งกลาง)
    const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    w.add(camRight.multiplyScalar((0.5 - c.x) * sc.x));
    const v = w.project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (v.x * 0.5 + 0.5) * r.width, y: (-v.y * 0.5 + 0.5) * r.height };
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
    // ป้ายชื่อชั้นในโมเดล (ชั้น G–5, ชั้น 11–32) กดได้ = แสดงเฉพาะชั้นนั้น เหมือนปุ่มเลือกชั้น
    const labels = [...this.floorGroups.values()].filter((g) => g.group.visible && g.label.visible).map((g) => g.label);
    const lh = this.raycaster.intersectObjects(labels, false)[0];
    if (lh) { const id = [...this.floorGroups.values()].find((g) => g.label === lh.object)?.floor.id; if (id) { this.onFloorPick(id); return { floor: id }; } }
    const r = this.#roomAtNdc(ndc);
    if (r) { this.selectRoom(r.floorId, r.room.id); this.onRoom({ floorId: r.floorId, room: r.room, meta: this.floorGroups.get(r.floorId).roomsMeta }); return { room: r.room.id, floorId: r.floorId }; }
    this.selectRoom(null); this.onRoom(null);
    return null;
  }

  /**
   * แคชโมเดลรายละเอียดแบบจำกัด (LRU): เดสก์ท็อปเก็บ 4 ไฟล์ มือถือ 2 ไฟล์ — ไฟล์ที่เกินจะถูกถอดออกจากฉาก
   * และกำจัด geometry/วัสดุ/ภาพ เพื่อไม่ให้หน่วยความจำเพิ่มเรื่อย ๆ เมื่อสลับชั้นหลายครั้ง (ไม่ลบชั้นที่กำลังดู)
   */
  get detailCacheLimit() {
    return typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches ? 2 : 4;
  }

  #touchDetail(src) {
    this.detailLRU ??= [];
    this.detailLRU = this.detailLRU.filter((x) => x !== src);
    this.detailLRU.push(src);
    const keep = this.isolatedId ? this.floorGroups.get(this.isolatedId)?.floor.detail?.src : null;
    while (this.detailLRU.length > this.detailCacheLimit) {
      const victim = this.detailLRU.find((x) => x !== keep && x !== src);
      if (!victim) break;
      this.detailLRU = this.detailLRU.filter((x) => x !== victim);
      this.#evictDetail(victim);
    }
  }

  #evictDetail(src) {
    for (const fg of this.floorGroups.values()) {
      if (fg.floor.detail?.src !== src) continue;
      if (this.roomSel?.floorId === fg.floor.id) { this.selectRoom(null); this.onRoom(null); }
      if (fg.detailObj) { this.sceneLayers.release(fg.detailObj); fg.detailObj.parent?.remove(fg.detailObj); }
      fg.detailObj = null; fg.detailPromise = null; fg.detailState = undefined;
    }
    const p = this.detailCache.get(src);
    this.detailCache.delete(src);
    p?.then((prep) => disposeTree(prep.group), () => {});
    this.evictions = (this.evictions ?? 0) + 1;
  }

  /** ข้อมูลตรวจสอบหน่วยความจำ (ทดสอบเบราว์เซอร์) */
  memoryProbe() {
    const info = this.renderer.info;
    let detailObjs = 0;
    this.scene.traverse((o) => { if (o.name?.startsWith('detail-')) detailObjs++; });
    return { geometries: info.memory.geometries, textures: info.memory.textures, calls: info.render.calls, cached: [...(this.detailLRU ?? [])], detailObjs, evictions: this.evictions ?? 0, layers: this.sceneLayers.list().map((l) => ({ id: l.id, visible: l.visible, objects: l.objects })) };
  }

  setLayerVisible(id, on) { const ok = this.sceneLayers.setVisible(id, on); this.shadowDirty = true; this.#placeMarkers(); return ok; }
  layerList() { return this.sceneLayers.list(); }

  // ---------------------------------------------------------------- รูปแบบอาคาร (ทึบ / โปร่งใส / โครงอาคาร)
  /**
   * เปลี่ยนรูปแบบการแสดงตัวอาคารโดยใช้โมเดลเดิม — วัสดุต้นฉบับเก็บไว้ที่ userData.styleOrig และสลับกลับได้เหมือนเดิมทุกประการ
   * วัสดุโปร่งใสและเส้นขอบสร้างครั้งเดียวต่อวัสดุ/geometry (แคช) · ลิฟต์ หมุด ถังเซนเซอร์ และป้าย ไม่ถูกเปลี่ยน
   * @param {'solid'|'transparent'|'wire'} style
   */
  setBuildingStyle(style, { instant = false } = {}) {
    if (!BUILDING_STYLES[style]) return;
    const cur = this.#styleNow();
    this.buildingStyle = style;
    const to = BUILDING_STYLES[style];
    if (instant || this.disposed) { this.styleAnim = null; this.styleState = { a: to.a, l: to.l }; this.#applyStyle(); return; }
    this.styleAnim = { from: cur, to: { a: to.a, l: to.l }, start: performance.now(), dur: 400 };
    if (to.l > 0) this.#ensureStyleLines();
    this.#applyStyle();
  }

  /** ตรวจสอบ (ทดสอบเบราว์เซอร์): วัสดุที่ใช้อยู่ ณ ตอนนี้ และจำนวนชิ้นที่ยังใช้วัสดุแทน */
  styleProbe() {
    let meshes = 0; let swapped = 0; let lines = 0; const ids = [];
    this.#buildingMeshes((o) => { meshes++; if (o.userData.styleOrig) swapped++; if (o.userData.styleLineObj) lines++; ids.push(Array.isArray(o.material) ? o.material.map((m) => m.uuid).join('+') : o.material.uuid); });
    let h = 0; for (const c of ids.join('|')) h = (h * 31 + c.charCodeAt(0)) | 0;
    return { style: this.buildingStyle ?? 'solid', meshes, swapped, lines, matHash: h, ghostCache: this.styleMatCache?.size ?? 0, edgeCache: this.edgeCache?.size ?? 0, anim: !!this.styleAnim };
  }

  #styleNow() { return { ...(this.styleState ?? { a: 1, l: 0 }) }; }

  #styleFrame(nowMs) {
    const an = this.styleAnim;
    const k = Math.min(1, (nowMs - an.start) / an.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    this.styleState = { a: an.from.a + (an.to.a - an.from.a) * e, l: an.from.l + (an.to.l - an.from.l) * e };
    if (k >= 1) { this.styleAnim = null; this.styleState = { ...an.to }; }
    this.#applyStyle();
  }

  /** ชิ้นส่วนอาคาร (ไม่รวมลิฟต์ หมุด ถังเซนเซอร์ ไฮไลต์ห้อง และเส้นขอบโหมดโครง) */
  #buildingMeshes(fn) {
    const walk = (o) => {
      if (o.userData.keepOpaque || o.userData.styleLine || o.name === 'room-highlight') return;
      if (o.isMesh && o.material) fn(o);
      for (const c of o.children) walk(c);
    };
    for (const fg of this.floorGroups.values()) walk(fg.group);
    if (this.towerDeco) walk(this.towerDeco);
  }

  #ensureStyleLines() {
    this.styleLineMat ??= new THREE.LineBasicMaterial({ color: '#6fd3c4', transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    this.edgeCache ??= new Map(); // geometry.uuid → EdgesGeometry (สร้างครั้งเดียว)
    this.#buildingMeshes((o) => {
      if (o.userData.styleLineObj) return;
      let eg = this.edgeCache.get(o.geometry.uuid);
      if (!eg) { eg = new THREE.EdgesGeometry(o.geometry, 40); this.edgeCache.set(o.geometry.uuid, eg); }
      const line = new THREE.LineSegments(eg, this.styleLineMat);
      line.userData.styleLine = true;
      line.layers.mask = o.layers.mask;
      line.renderOrder = 3;
      line.raycast = () => {};
      o.add(line);
      o.userData.styleLineObj = line;
    });
  }

  /** ใส่วัสดุตามสถานะปัจจุบัน (a = ความทึบของตัวอาคาร, l = ความเข้มเส้นโครง) */
  #applyStyle() {
    this.shadowDirty = true;
    const st = this.styleState ?? { a: 1, l: 0 };
    if (st.l > 0 || (this.styleAnim?.to.l ?? 0) > 0) this.#ensureStyleLines(); // ชิ้นที่เพิ่งโหลดได้เส้นโครงด้วย
    this.styleMatCache ??= new Map(); // วัสดุต้นฉบับ → วัสดุโปร่ง (แคช ไม่สร้างใหม่ทุกเฟรม)
    const solid = st.a >= 0.999 && !this.styleAnim;
    const ghost = (m) => {
      let g = this.styleMatCache.get(m);
      // forceSinglePass: วัสดุสองด้านที่โปร่งใส three.js จะวาด 2 รอบ (ด้านหลังแล้วด้านหน้า) → Draw Calls และ Overdraw เป็นสองเท่า
      // ในโหมดโปร่งใส (ทึบ 22%) วาดรอบเดียวให้ผลเหมือนกันด้วยตา รูปทรงและสีไม่เปลี่ยน
      if (!g) { g = m.clone(); g.transparent = true; g.depthWrite = false; g.forceSinglePass = true; this.styleMatCache.set(m, g); }
      g.opacity = m.opacity * st.a;
      g.visible = st.a > 0.01;
      if (g.clippingPlanes !== m.clippingPlanes) { g.clippingPlanes = m.clippingPlanes; g.needsUpdate = true; }
      return g;
    };
    this.#buildingMeshes((o) => {
      const orig = o.userData.styleOrig ?? o.material;
      if (solid) {
        if (o.userData.styleOrig) { o.material = o.userData.styleOrig; delete o.userData.styleOrig; }
      } else {
        o.userData.styleOrig = orig;
        o.material = Array.isArray(orig) ? orig.map(ghost) : ghost(orig);
      }
    });
    if (this.styleLineMat) {
      this.styleLineMat.opacity = 0.42 * st.l;
      this.styleLineMat.visible = st.l > 0.01;
    }
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
    const all = [...this.floorGroups.values()].filter((g) => g.floor.detail);
    return { ready: all.filter((g) => g.detailObj).length, total: all.length, light: true, building: this.modelLoaded ? 'ready' : 'loading' };
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
    this.isolatedId = id;
    this.floorId = id;
    // เปลี่ยนฉากเป็นโมเดลของชั้นนั้นชั้นเดียวทันที (ไม่ดึงชั้นออกจากอาคาร): วางกลางฉากที่ระดับพื้นปกติ ซ่อนอาคารรวมและชั้นอื่นทั้งหมด
    this.#ensureDetail(id);
    const fg = this.floorGroups.get(id);
    const t = isolatedOffset(fg.floor, ISO_CENTER);
    fg.group.position.set(t.x, t.y, t.z); // วางกลางฉากทันที (ไม่เลื่อนออกจากอาคาร)
    if (fg.fade) this.#endFade(fg, true);
    fg.group.visible = false; // ค่อย ๆ ปรากฏ ขณะชั้นเดิมค่อย ๆ จาง
    this.#applyMode(instant);
    this.autoFit = true; // ปรับกล้องให้พอดีชั้นอีกครั้งเมื่อขนาดพื้นที่แสดงผลเปลี่ยน จนกว่าผู้ใช้จะหมุน/ซูมเอง
    this.preset('fit', { instant });
  }

  /** กลับไปดูทั้งอาคาร: แสดงอาคารรวมครบทุกชั้นที่ตำแหน่งเดิมทันที */
  assemble({ instant = false } = {}) {
    if (!this.isolatedId) return;
    this.isolatedId = null;
    if (this.roomSel) { this.selectRoom(null); this.onRoom(null); } // กลับทั้งอาคาร: ล้างห้อง/ไฮไลต์ที่เลือกจากชั้นก่อนหน้า
    for (const fg of this.floorGroups.values()) {
      const a = assembledOffset(fg.floor, this.mode);
      fg.group.position.set(a.x, a.y, a.z); // ทุกชั้นอยู่ตำแหน่งในอาคารทันที แล้วค่อย ๆ ปรากฏพร้อมกัน
      if (fg.fade) this.#endFade(fg, true);
      fg.group.visible = false;
    }
    this.#applyMode(instant);
    this.preset('all', { instant });
  }

  #applyMode(instant = false) {
    this.shadowDirty = true;
    const sel = this.config?.building.floors.find((f) => f.id === this.floorId);
    const iso = this.isolatedId;
    for (const fg of this.floorGroups.values()) {
      const f = fg.floor;
      const isSel = !!iso && f.id === iso; // เน้นชั้นเฉพาะตอนแยกดูชั้นนั้น
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
      // ซ่อน/แสดงชั้นแบบค่อย ๆ จาง (0.45 วินาที) — ระหว่างจางชั้นนั้นกดเลือกห้องไม่ได้ และไม่แสดงหมุด/ป้าย
      this.#fadeFloor(fg, visible, instant);
      if (iso) {
        fg.shellMat.opacity = 0.1;
      } else {
        fg.shellMat.opacity = this.mode === 'exterior' ? (isSel ? 0.18 : (f.kind === 'tower' ? 0.3 : 0.42)) : (this.mode === 'cutaway' ? (isSel ? 0.05 : 0.14) : 0.08);
      }
      // มีโมเดล Blender: ซ่อนเปลือกแบบโค้ด ใช้ผนังกระจกในมุมมองอาคาร และซ่อนกระจกในมุมมองชั้นเดี่ยว (เห็นผนังตัดแบบผังสามมิติ)
      const hasModel = !!fg.model;
      // มุมมองชั้นเดี่ยว + มีโมเดลรายชั้นของผู้ใช้: แสดงเฉพาะโมเดลนั้น (แผ่นพื้น ผัง และผนังแบบง่ายซ่อน)
      const showDetail = !!fg.detailObj && iso === f.id; // ทั้งอาคารใช้โมเดลแบบเบาเสมอ (ไม่ผสมโมเดลรายละเอียดที่ค้างในแคช)
      if (fg.detailObj) fg.detailObj.visible = !!showDetail;
      fg.slab.visible = fg.plan.visible = !showDetail;
      if (fg.model) fg.model.visible = !showDetail;
      fg.shell.visible = !hasModel && !showDetail;
      fg.edges.visible = !hasModel && !showDetail;
      // มุมมองเปิดปล่อง: ซ่อนกระจก/ผนังแบบง่ายของห้าง (แผ่นพื้นและผังสีร้านคงเดิม)
      const cut = this.liftView && !iso && f.kind !== 'tower';
      if (fg.facade) for (const o of fg.facade) o.visible = !iso && !cut;
      if (fg.walls) for (const o of fg.walls) o.visible = !cut;
      if (cut) fg.shellMat.opacity = Math.min(fg.shellMat.opacity, 0.06);
      // โมเดลห้องของผู้ใช้: ตัดหน้าตัดด้านหน้าปล่องออก (ระนาบตัด) ให้เห็นห้องลิฟต์ — ไม่เปลี่ยนสีหรือรูปทรง
      if (fg.detailObj) this.#setClip(fg.detailObj, cut ? this.#cutPlane() : null);
      if (this.pump && this.pump.floorId === f.id) this.pump.group.visible = !showDetail;
      for (const t of this.tanks?.values() ?? []) if (t.floorId === f.id) t.group.visible = true; // ถังระดับน้ำแสดงบนโมเดลห้องด้วย
      fg.edges.material.color.set(isSel ? '#0f6f69' : '#8fa79f');
      fg.edges.material.opacity = isSel ? 0.95 : (f.kind === 'tower' ? 0.3 : 0.5);
      fg.isoLabel.visible = false; // ไม่แสดงป้ายชื่อชั้นลอยข้างโมเดล (ชื่อชั้นอยู่ที่ "กำลังดู" และปุ่มชั้น)
    }
    if (this.towerDeco) this.towerDeco.visible = !iso;
    this.#applyLabels();
    if (this.lift) { if (!iso) this.lift.rig.group.visible = true; this.#stepLift(); } // ชั้นเดียว: แสดงรถลิฟต์เมื่อมาถึงชั้นนั้น
    if (this.roomSel && (iso ? this.roomSel.floorId !== iso : !this.floorGroups.get(this.roomSel.floorId)?.group.visible)) { this.selectRoom(null); this.onRoom(null); }
    this.#placeMarkers();
  }

  /** ตั้งการแสดงชั้น: instant = ทันที, ไม่เช่นนั้นค่อย ๆ จางออก/เข้า */
  #fadeFloor(fg, visible, instant) {
    const shown = fg.group.visible && (!fg.fade || fg.fade.to === 1);
    if (instant || this.disposed) { if (fg.fade) this.#endFade(fg, true); fg.group.visible = visible; return; }
    if (visible === shown) { if (!visible) fg.group.visible = false; return; }
    if (fg.fade) this.#endFade(fg, true);
    const mats = new Map();
    fg.group.traverse((o) => {
      if (!o.visible || o.isSprite) return;
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        if (!mats.has(m)) mats.set(m, { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite });
      }
    });
    for (const m of mats.keys()) { if (!m.transparent) { m.transparent = true; m.needsUpdate = true; } }
    fg.group.visible = true;
    fg.fade = { from: visible ? 0 : 1, to: visible ? 1 : 0, start: performance.now(), dur: 450, mats };
    for (const [m, o] of mats) m.opacity = o.opacity * fg.fade.from;
  }

  #endFade(fg, abort = false) {
    const fd = fg.fade;
    fg.fade = null;
    this.shadowDirty = true;
    for (const [m, o] of fd.mats) { m.opacity = o.opacity; if (m.transparent !== o.transparent) { m.transparent = o.transparent; m.needsUpdate = true; } }
    if (!abort && fd.to === 0) fg.group.visible = false;
    this.#applyLabels();
    this.#placeMarkers();
  }

  /**
   * ป้ายชื่อชั้นในมุมมองทั้งอาคาร: ทุกชั้นห้างแสดงเสมอ ชั้นที่เลือกเป็นป้ายสีเขียวเด่น ชั้นอื่นจางลง
   * ชั้นสำนักงาน 11–32 แสดงรายชั้นเมื่อกล้องเข้าใกล้ทาวเวอร์พอจะอ่านได้ (ไกลกว่านั้นใช้ป้ายรวม "ชั้นสำนักงาน 11–32")
   */
  #applyLabels() {
    const iso = this.isolatedId;
    for (const fg of this.floorGroups.values()) {
      const f = fg.floor;
      // ทั้งอาคาร: ทุกชั้นเด่นเท่ากัน ไม่มีชั้นที่ถูกเลือก (ไฮไลต์เฉพาะตอนแยกดูชั้น ด้วยป้ายใหญ่ของชั้นนั้น)
      fg.label.visible = false; // ไม่แสดงป้ายชื่อชั้นลอยข้างอาคาร (เลือกชั้นด้วยปุ่มด้านบน)
      fg.hlLabel.visible = false;
    }
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
      o.visible = fg.group.visible && this.layers[p.system] !== false && this.sceneLayers.isVisible('sensors') && (!this.isolatedId || p.floorId === this.isolatedId);
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
    this.autoFit = name === 'fit' || name === 'all'; // มุมมาตรฐานปรับตามขนาดจอ; มุมอื่นหรือผู้ใช้หมุนเองไม่ปรับ
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
          const dist = Math.max(4.5, (H / 2) / Math.tan(vfov / 2) * 1.5); // เห็นปล่องทั้งเส้นทาง G–5 และอาคารรอบ ๆ
          target = new THREE.Vector3(b.x, BASE_Y + (b.y0 + b.y1) / 2, b.z);
          const dir = new THREE.Vector3(0.42, 0.16, 1).normalize();
          pos = target.clone().add(dir.multiplyScalar(dist));
          break;
        }
        default: {
          // ทั้งอาคาร: ให้เห็นทั้งห้าง ทาวเวอร์ และป้ายชื่อชั้นด้านซ้ายพอดีกรอบ (ปรับตามสัดส่วนพื้นที่แสดงผล)
          // มุมต่ำลง (~27°) ให้เห็นการเคลื่อนขึ้น–ลงของลิฟต์ชัดขึ้น และโมเดลใหญ่เต็มกรอบ
          target = new THREE.Vector3(-1.0, 2.6, -1.8);
          const dir = new THREE.Vector3(4, 10, 19).normalize();
          const dist = this.#fitDistance(25, 13, 27) * 0.9;
          pos = target.clone().add(dir.multiplyScalar(dist));
        }
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
    if (this.autoFit && w > 10 && h > 10 && Math.abs(prevAspect - this.camera.aspect) > 1e-3) this.preset(this.isolatedId ? 'fit' : 'all', { instant: !this.tween }); // ขนาดพื้นที่เปลี่ยน → จัดกล้องใหม่จนกว่าผู้ใช้จะหมุน/ซูมเอง
  }

  // ---------------------------------------------------------------- ลูปวาด
  #frame() {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loopFn);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.paused || this.compiling || document.hidden || !this.container.isConnected || this.container.offsetParent === null) return;
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
    for (const fg of this.floorGroups.values()) {
      const fd = fg.fade;
      if (!fd) continue;
      const k = Math.min(1, (nowMs - fd.start) / fd.dur);
      const a = fd.from + (fd.to - fd.from) * k;
      for (const [m, o] of fd.mats) m.opacity = o.opacity * a;
      if (k >= 1) this.#endFade(fg);
    }
    if (moving) this.#placeMarkers();
    this.#stepLift();
    if (this.styleAnim) this.#styleFrame(nowMs);
    // ป้ายในฉาก: ซ่อนเมื่อกล้องไกลมาก (ระดับซูม = ระยะมาตรฐาน 22 / ระยะจริง) ไม่ให้ป้ายบังโมเดล
    this.sceneLayers.updateZoom(22 / Math.max(1, this.camera.position.distanceTo(this.controls.target)));
    if (this.towerCenter && !this.isolatedId) {
      const near = this.camera.position.distanceTo(this.towerCenter) < 10.5;
      if (near !== this.towerNear) { this.towerNear = near; this.#applyLabels(); }
    }
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
    // น้ำในถังค่อย ๆ ขึ้น/ลงสู่ค่าล่าสุด (ไม่กระโดด)
    for (const t of this.tanks?.values() ?? []) {
      const goal = t.target ?? t.last;
      if (goal === null) continue;
      t.cur += (goal - t.cur) * Math.min(1, dt * 2.2); // ค่อย ๆ ขึ้น/ลง (ตามเวลา ไม่ผูกกับจำนวนเฟรม)
      const top = Math.max(0.001, t.cur * (t.H - 0.012));
      t.water.scale.y = top;
      const k = nowMs / 1000 + t.phase;
      t.surf.position.y = 0.006 + top + Math.sin(k * 2.1) * 0.002;
      t.surf.rotation.set(-Math.PI / 2 + Math.sin(k * 1.7) * 0.03, Math.cos(k * 1.3) * 0.03, 0);
      t.surfMat.opacity = t.stale ? 0.12 : 0.28 + Math.sin(k * 2.6) * 0.07;
    }
    this.controls.update();
    this.#flushShadows(moving);
    this.renderer.render(this.scene, this.camera);
    this.#projectMarkers();
    this.frameNo = (this.frameNo ?? 0) + 1;
  }

  /** ให้คำนวณเงาใหม่ในเฟรมถัดไป (เรียกเมื่อสิ่งที่ทอดเงาเปลี่ยน) */
  markShadowsDirty() { this.shadowDirty = true; }
  #flushShadows(moving = false) {
    // ระหว่างชั้นเลื่อน/จาง หรือรูปแบบอาคารกำลังเปลี่ยน: เงาตามทุกเฟรม · จบแล้วคำนวณอีกครั้งเดียว
    const animating = moving || !!this.styleAnim || [...this.floorGroups.values()].some((fg) => fg.fade || fg.anim);
    if (this.shadowDirty || animating) { this.renderer.shadowMap.needsUpdate = true; this.shadowDirty = animating; this.shadowUpdates = (this.shadowUpdates ?? 0) + 1; }
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
