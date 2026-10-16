import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

// คน 3 มิติแบบ Rigged (GLB จาก Blender: โครงกระดูก 16 ชิ้น + Idle / Walk / Turn)
// ผสมแอนิเมชันตามสถานะ: เดิน (อัตราเล่น = ความเร็วจริง / ความเร็วของแอนิเมชัน → เท้าไม่ไถล) · ยืน (Idle) · หมุนตัว (Turn)
export const PERSON_SCALE = 0.118;      // เมตร → หน่วยฉาก (สเกลเดียวกับรถ)
export const WALK_SPEED_M = 0.9166667;  // ม./วิ ของแอนิเมชัน Walk ที่อัตราเล่น 1 (จาก tools/blender/make_person.py)

// รูปลักษณ์ — สีสุภาพ โทนเดียวกับ NEXZA ไม่มีรายละเอียดใบหน้า (ชิ้นเสริม: ผมยาว กระเป๋าสะพาย ป้ายพนักงาน ถุงช้อปปิ้ง)
export const LOOKS = [
  { id: 'man', name: 'ชาย', top: '#8a9aa0', bottom: '#3d474c', hair: '#2e2a28', skin: '#c9a58a', shoes: '#2a2d2f' },
  { id: 'woman', name: 'หญิง', top: '#a4878a', bottom: '#56646b', hair: '#3a2e28', skin: '#d8b89c', shoes: '#33363a', hairLong: true, bag: true },
  { id: 'staff', name: 'พนักงาน', top: '#2f8f83', bottom: '#2f3a3e', hair: '#1f1c1b', skin: '#b98f72', shoes: '#26292b', badge: true },
  { id: 'visitor', name: 'ผู้มาใช้บริการ', top: '#d9d4c7', bottom: '#6d5f50', hair: '#6b5544', skin: '#a77c60', shoes: '#2e2a27', shopbag: true },
  { id: 'visitor2', name: 'ผู้มาใช้บริการ (2)', top: '#5c7f86', bottom: '#b6ad9c', hair: '#2b2624', skin: '#e0c4a8', shoes: '#2f3134', hairLong: true, shopbag: true },
  { id: 'staff2', name: 'พนักงาน (2)', top: '#2f8f83', bottom: '#4f5d63', hair: '#3a302a', skin: '#c49a7a', shoes: '#26292b', badge: true, hairLong: true },
];
const BLEND_S = 0.3; // เวลาผสมท่า Idle ↔ Walk ↔ Turn (วินาที)

export class PersonRig {
  constructor(gltf, look = LOOKS[0], { shadows = false } = {}) {
    this.root = cloneSkinned(gltf.scene);
    this.root.name = 'person';
    this.root.scale.setScalar(PERSON_SCALE);
    this.materials = [];
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = shadows; o.receiveShadow = false; o.frustumCulled = false; // เงาจริงปิดไว้ ใช้เงานุ่มจาง ๆ แทน (ไม่แย่งสายตาจากอาคาร)
      const opt = [['hair_long', 'hairLong'], ['badge', 'badge'], ['shopbag', 'shopbag'], ['bag', 'bag']].find(([n]) => o.name.startsWith(n));
      if (opt) o.visible = !!look[opt[1]];
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const next = mats.map((m) => {
        const c = m.clone(); this.materials.push(c);
        const key = { Top: 'top', Bottom: 'bottom', Hair: 'hair', Skin: 'skin', Shoes: 'shoes' }[m.name];
        if (key) c.color.set(look[key]);
        return c;
      });
      o.material = Array.isArray(o.material) ? next : next[0];
    });
    this.mixer = new THREE.AnimationMixer(this.root);
    const clip = (n) => gltf.animations.find((a) => a.name === n);
    this.actions = Object.fromEntries(['Idle', 'Walk', 'Turn'].map((n) => { const a = this.mixer.clipAction(clip(n)); a.play(); a.setEffectiveWeight(0); return [n, a]; }));
    this.actions.Walk.time = Math.random() * 0.9;
    this.w = { Idle: 1, Walk: 0, Turn: 0 };
    this.walkSpeedScene = WALK_SPEED_M * PERSON_SCALE;
    // เงานุ่มใต้เท้า (จาง)
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    this.shadowTex = new THREE.CanvasTexture(c);
    this.shadowMat = new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.36 / PERSON_SCALE, 0.36 / PERSON_SCALE).rotateX(-Math.PI / 2), this.shadowMat);
    this.shadow.position.y = 0.02; this.shadow.renderOrder = 2;
    this.root.add(this.shadow);
    this.look = look;
  }

  /**
   * @param {{x:number,z:number,h:number,v:number,state:string,turnRate:number}} pose
   * @param {number} dt วินาที
   */
  update(pose, dt) {
    this.root.position.set(pose.x, 0, pose.z);
    this.root.rotation.set(0, pose.h, 0);
    // น้ำหนักเป้าหมาย: เดินตามความเร็ว · หมุนตัวอยู่กับที่ · ยืน
    const walking = Math.min(1, pose.v / (this.walkSpeedScene * 0.35));
    const turning = pose.state === 'turn' ? 1 : 0;
    const target = { Walk: walking * (1 - turning), Turn: turning, Idle: Math.max(0, 1 - walking - turning) };
    // ผสมท่าแบบเส้นตรง: เปลี่ยนท่าครบใน BLEND_S วินาที (ไม่กระตุก) แล้วปรับน้ำหนักรวม = 1
    const stepW = dt / BLEND_S;
    for (const n of Object.keys(target)) this.w[n] += Math.max(-stepW, Math.min(stepW, target[n] - this.w[n]));
    const sum = this.w.Idle + this.w.Walk + this.w.Turn || 1;
    for (const n of Object.keys(target)) this.actions[n].setEffectiveWeight(this.w[n] / sum);
    // อัตราเล่นท่าเดิน = ความเร็วจริง / ความเร็วของแอนิเมชัน → ระยะก้าวตรงกับระยะที่เคลื่อน (เท้าไม่ไถล)
    this.actions.Walk.setEffectiveTimeScale(Math.max(0.05, pose.v / this.walkSpeedScene));
    this.actions.Turn.setEffectiveTimeScale(Math.max(0.6, Math.min(1.4, Math.abs(pose.turnRate) / 1.7)));
    this.mixer.update(dt);
  }

  dispose() {
    this.root.parent?.remove(this.root); this.mixer.stopAllAction();
    for (const m of this.materials) m.dispose();
    this.shadow.geometry.dispose(); this.shadowMat.dispose(); this.shadowTex.dispose();
  }
}
