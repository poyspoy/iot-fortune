import * as THREE from 'three';

// รถยนต์ 3 มิติ (GLB จาก Blender: body / glass / roof / headlights / taillights / trim + wheel_FL/FR/RL/RR)
// ล้อหมุนรอบแกนเพลา (X ของล้อ) ตามระยะทาง · ล้อหน้าหักเลี้ยวรอบแกนตั้ง (Y) · ไฟท้ายสว่างขึ้นเมื่อเบรก/จอด
export const CAR_SCALE = 0.118; // เมตร → หน่วยฉาก (ผังชั้น G ≈ 8.5 ม./หน่วย)

export class VehicleRig {
  constructor(gltfScene, { shadows = false } = {}) {
    this.root = gltfScene.clone(true);
    this.root.name = 'vehicle';
    this.root.scale.setScalar(CAR_SCALE);
    this.wheels = {};
    this.materials = [];
    this.root.traverse((o) => {
      if (/^wheel_(FL|FR|RL|RR)$/.test(o.name)) { o.rotation.order = 'YXZ'; this.wheels[o.name.slice(6)] = o; }
      if (o.isMesh) {
        o.castShadow = shadows; o.receiveShadow = false;
        o.material = o.material.clone(); // วัสดุต่อคัน (ไฟเบรกไม่กระทบคันอื่น)
        this.materials.push(o.material);
        if (o.material.name === 'Taillight') this.tail = o.material;
      }
    });
    this.tailBase = this.tail?.emissiveIntensity ?? 1;
    // เงานุ่มจาง ๆ ใต้รถ (แทนเงาจริงที่เข้มเกินไป)
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 4, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.3)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    this.shadowTex = new THREE.CanvasTexture(c);
    this.shadowMat = new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 5.2).rotateX(-Math.PI / 2), this.shadowMat);
    this.shadow.position.y = 0.01; this.shadow.renderOrder = 2; this.root.add(this.shadow);
    const ud = gltfScene.userData ?? {};
    this.wheelRadius = (ud.wheelRadius ?? 0.33) * CAR_SCALE;
    this.wheelbase = (ud.wheelbase ?? 2.7) * CAR_SCALE;
  }

  /** @param {{x:number,z:number,h:number,spin:number,steer:number}} pose  @param {boolean} brake  @param {boolean} visible */
  update(pose, brake, visible = true) {
    this.root.visible = visible;
    this.root.position.set(pose.x, 0.001, pose.z);
    this.root.rotation.set(0, pose.h, 0);
    for (const [k, w] of Object.entries(this.wheels)) {
      w.rotation.x = pose.spin;
      w.rotation.y = k[0] === 'F' ? pose.steer : 0;
    }
    if (this.tail) { this.tail.emissiveIntensity = brake ? this.tailBase * 5 : this.tailBase; }
  }

  dispose() {
    this.root.parent?.remove(this.root);
    for (const m of this.materials) m.dispose();
    this.shadow.geometry.dispose(); this.shadowMat.dispose(); this.shadowTex.dispose();
  }
}
