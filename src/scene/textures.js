import * as THREE from 'three';

// พื้นผิวสร้างด้วยโค้ดทั้งหมด (procedural) ไม่มีไฟล์ภาพ/โมเดลภายนอก

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** ลายไม้โต๊ะทดลอง */
export function timberTexture() {
  const c = canvas(512, 512);
  const g = c.getContext('2d');
  g.fillStyle = '#9a6a3c';
  g.fillRect(0, 0, 512, 512);
  // แผ่นไม้
  for (let p = 0; p < 4; p++) {
    const y0 = p * 128;
    const tone = [0, 10, -8, 6][p];
    g.fillStyle = `rgb(${154 + tone},${106 + tone},${60 + tone})`;
    g.fillRect(0, y0, 512, 126);
    g.fillStyle = 'rgba(60,35,15,0.55)';
    g.fillRect(0, y0 + 126, 512, 2);
  }
  // เส้นลายไม้
  for (let i = 0; i < 140; i++) {
    const y = (i * 37) % 512 + Math.sin(i) * 3;
    g.strokeStyle = `rgba(${70 + (i % 5) * 6},${40 + (i % 3) * 5},18,${0.08 + (i % 4) * 0.03})`;
    g.lineWidth = 1 + (i % 3) * 0.6;
    g.beginPath();
    for (let x = 0; x <= 512; x += 16) {
      const yy = y + Math.sin(x / (40 + (i % 7) * 9) + i) * (2 + (i % 5));
      if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
    }
    g.stroke();
  }
  // ปุ่มไม้
  for (let k = 0; k < 5; k++) {
    const x = (k * 173) % 512; const y = (k * 97 + 40) % 512;
    const rg = g.createRadialGradient(x, y, 1, x, y, 14);
    rg.addColorStop(0, 'rgba(70,40,18,0.6)');
    rg.addColorStop(1, 'rgba(70,40,18,0)');
    g.fillStyle = rg;
    g.beginPath(); g.ellipse(x, y, 16, 7, 0, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** พื้นห้องทดลองโทนสเลต */
export function slateFloorTexture() {
  const c = canvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#2e383d';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 254, 254);
  for (let i = 0; i < 900; i++) {
    const v = 40 + ((i * 7919) % 30);
    g.fillStyle = `rgba(${v},${v + 8},${v + 12},0.25)`;
    g.fillRect((i * 37) % 256, (i * 101) % 256, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** ป้ายข้อความบนโมเดล (sprite) */
export function textSprite(text, { color = '#e8efe9', bg = 'rgba(30,40,44,0.78)', size = 36, scale = 0.012 } = {}) {
  const c = canvas(10, 10);
  const g = c.getContext('2d');
  const font = `600 ${size}px Thonburi, Tahoma, Arial, sans-serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 28;
  const h = size + 20;
  c.width = w; c.height = h;
  g.font = font;
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(0, 0, w, h, 10); g.fill();
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 14, h / 2 + 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  sp.scale.set(w * scale, h * scale, 1);
  sp.renderOrder = 10;
  return sp;
}
