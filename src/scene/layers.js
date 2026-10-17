// LayerManager — แบ่งวัตถุในฉาก 3 มิติเป็นเลเยอร์ (ใช้ THREE.Layers: ซ่อน/แสดงทั้งเลเยอร์โดยไม่ยุ่งกับการซ่อนรายชิ้น)
// แต่ละเลเยอร์มีข้อมูลกำกับ (metadata) สำหรับต่อ Backend API ในอนาคต: dataSource บอกว่าข้อมูลมาจากไหน
//   floorScope: 'all' (ทุกมุมมอง) | 'building' (เฉพาะทั้งอาคาร) | 'floor' (เฉพาะชั้นเดียว)
//   minZoom:    ระดับซูมขั้นต่ำที่แสดง (1 = ระยะกล้องมาตรฐาน; มากกว่า 1 = ต้องซูมเข้าใกล้กว่า) — null = แสดงทุกระดับ

export const LAYER_DEFS = Object.freeze([
  { id: 'base', name: 'ฐานอาคารและกริด', channel: 1, renderOrder: 0, floorScope: 'all', minZoom: null, dataSource: 'static-scene' },
  { id: 'building', name: 'อาคารรวม (แบบเบา)', channel: 2, renderOrder: 1, floorScope: 'building', minZoom: null, dataSource: 'static-model:fortune.glb + plans' },
  { id: 'floor-plan', name: 'โมเดลรายละเอียดชั้น', channel: 3, renderOrder: 1, floorScope: 'floor', minZoom: null, dataSource: 'static-model:floors/*.glb (Blender)' },
  { id: 'engineering', name: 'ระบบวิศวกรรม', channel: 4, renderOrder: 2, floorScope: 'all', minZoom: null, dataSource: 'future-api:/engineering', future: true },
  { id: 'assets', name: 'อุปกรณ์และเครื่องจักร', channel: 5, renderOrder: 3, floorScope: 'all', minZoom: null, dataSource: 'config:points (equipment)' },
  { id: 'sensors', name: 'หมุดและเกจเซนเซอร์', channel: 6, renderOrder: 6, floorScope: 'all', minZoom: null, dataSource: 'demo-adapter → future-api:/telemetry' },
  { id: 'elevator', name: 'ลิฟต์ (ปล่อง รถ ประตู ตำแหน่งชั้น)', channel: 7, renderOrder: 4, floorScope: 'all', minZoom: null, dataSource: 'elevator-sim → future-api:/elevators' },
  { id: 'alerts', name: 'สีเตือนและไฮไลต์', channel: 8, renderOrder: 7, floorScope: 'all', minZoom: null, dataSource: 'alarm-engine → future-api:/alarms' },
  { id: 'heatmap', name: 'สีอุณหภูมิ (Heatmap)', channel: 9, renderOrder: 5, floorScope: 'floor', minZoom: null, dataSource: 'future-api:/heatmap', future: true },
  { id: 'people', name: 'คนและยานพาหนะ (จำลอง)', channel: 10, renderOrder: 5, floorScope: 'all', minZoom: null, dataSource: 'mobility/floor-G.json + mobility-sim → future-api:/people-counting' },
  { id: 'labels', name: 'ป้ายชื่อในฉาก', channel: 11, renderOrder: 10, floorScope: 'all', minZoom: 0.8, dataSource: 'config + elevator-sim' },
]);

export class LayerManager {
  /** @param {import('three').Camera} camera  @param {import('three').Raycaster} raycaster */
  constructor(camera, raycaster) {
    this.camera = camera;
    this.raycaster = raycaster;
    this.layers = new Map(LAYER_DEFS.map((d) => [d.id, { ...d, visible: !d.future, opacity: 1, zoomOk: true, roots: new Set() }]));
    camera.layers.enable(0); // ไฟและวัตถุทั่วไป
    this.#apply();
  }

  get(id) { return this.layers.get(id); }
  list() { return [...this.layers.values()].map(({ roots, zoomOk, ...rest }) => ({ ...rest, objects: roots.size })); }
  isVisible(id) { const l = this.layers.get(id); return !!l && l.visible && l.zoomOk; }

  /** ผูกวัตถุ (และลูกทั้งหมด) เข้าเลเยอร์ — เรียกซ้ำได้หลังเพิ่มลูกใหม่ */
  assign(obj, id) {
    const l = this.layers.get(id);
    if (!l || !obj) return obj;
    obj.traverse((o) => { o.layers.set(l.channel); if (o.isMesh || o.isLine || o.isSprite || o.isPoints) o.renderOrder = Math.max(o.renderOrder, l.renderOrder); });
    obj.userData.layerId = id;
    l.roots.add(obj);
    return obj;
  }

  release(obj) { for (const l of this.layers.values()) l.roots.delete(obj); }

  setVisible(id, on) {
    const l = this.layers.get(id);
    if (!l || l.future) return false;
    l.visible = !!on;
    this.#apply();
    return true;
  }

  /** ความโปร่งของทั้งเลเยอร์ (คูณกับค่าเดิมของวัสดุ) */
  setOpacity(id, value) {
    const l = this.layers.get(id);
    if (!l) return;
    l.opacity = Math.max(0, Math.min(1, value));
    for (const root of l.roots) root.traverse((o) => {
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        m.userData.baseOpacity ??= m.opacity;
        m.userData.baseTransparent ??= m.transparent;
        m.opacity = m.userData.baseOpacity * l.opacity;
        m.transparent = m.userData.baseTransparent || l.opacity < 1;
        m.needsUpdate = true;
      }
    });
  }

  /** อัปเดตตามระดับซูม (เรียกทุกเฟรมได้ — เปลี่ยนเฉพาะเมื่อข้ามเกณฑ์) */
  updateZoom(zoom) {
    let changed = false;
    for (const l of this.layers.values()) {
      const ok = l.minZoom == null || zoom >= l.minZoom;
      if (ok !== l.zoomOk) { l.zoomOk = ok; changed = true; }
    }
    if (changed) this.#apply();
  }

  #apply() {
    for (const l of this.layers.values()) {
      if (l.visible && l.zoomOk) { this.camera.layers.enable(l.channel); this.raycaster?.layers.enable(l.channel); }
      else { this.camera.layers.disable(l.channel); this.raycaster?.layers.disable(l.channel); }
    }
    this.onChange?.();
  }
}
