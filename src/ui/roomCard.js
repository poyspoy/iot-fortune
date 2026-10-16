import { h } from './dom.js';
import { ROOM_KIND, roomTitle, roomColorGroup, roomNotes, roomContains } from '../domain/rooms.js';
import { detailFrame, planToBlender } from '../domain/geometry.js';

// การ์ดข้อมูลห้อง/พื้นที่ที่กดในโมเดล 3 มิติ
// เลขห้อง/ชื่อร้านที่พิมพ์ในผังยังเป็นภาพ (ไม่ได้ถอดเป็นข้อความ) จึงแสดง "ภาพจากผังต้นฉบับ" ของพื้นที่นั้นแทนการเดา

/**
 * @param {{ floor:object, room:object, meta:object, points:object[], onClose:()=>void, onIsolate?:()=>void, onPoint:(id:string)=>void }} o
 */
export function roomCard(o) {
  const { floor, room, meta, points } = o;
  const color = roomColorGroup(room);
  const inside = points.filter((p) => p.status === 'active' && p.floorId === floor.id && p.plan && (() => {
    const b = planToBlender(floor.detail, p.plan);
    return roomContains(room, b.X, b.Y);
  })());
  const thumb = h('canvas.room-thumb', { width: 300, height: 150, 'aria-label': 'ภาพจากผังต้นฉบับของพื้นที่นี้' });
  drawThumb(thumb, floor, room);
  const notes = roomNotes(room);
  return h('section.room-card', { 'data-testid': 'room-card', 'aria-label': 'ข้อมูลห้อง/พื้นที่', role: 'dialog' },
    h('header.rc-head',
      h('div',
        h('strong.rc-title', { 'data-testid': 'room-title' }, roomTitle(room)),
        h('div.rc-chips', h('span.rc-chip', floor.name), h('span.rc-chip.kind', ROOM_KIND[room.category] ?? room.category),
          color ? h('span.rc-chip', `กลุ่มสีตามผัง: ${color}`) : null)),
      h('button.rc-close', { type: 'button', 'aria-label': 'ปิดข้อมูลห้อง', onclick: o.onClose }, '×')),
    thumb,
    h('dl.rc-dl',
      h('dt', 'ชื่อในโมเดล'), h('dd', h('code', room.id)),
      h('dt', 'พื้นที่โดยประมาณ'), h('dd', `${room.area_m2.toLocaleString('th-TH')} ตร.ม.`, h('small', ' (วัดจากโมเดล สเกลประมาณ)')),
      h('dt', 'จุดตรวจวัด IoT'), h('dd', inside.length
        ? h('span.rc-points', inside.map((p) => h('button.btn.small.ghost', { type: 'button', onclick: () => o.onPoint(p.id) }, `${p.id} ${p.name}`)))
        : 'ยังไม่มีจุดในพื้นที่นี้')),
    notes.length ? h('details.rc-notes', h('summary', `หมายเหตุจากไฟล์โมเดล (${notes.length})`),
      h('ul', notes.map((n) => h('li', h('b', `${n.key}: `), n.value)))) : null,
    h('p.rc-foot', `ที่มา: ${meta?.source ?? floor.plan?.src ?? '-'} · เลขห้อง/ชื่อร้านดูจากภาพผังต้นฉบับด้านบน`),
    o.onIsolate ? h('button.btn.small.primary', { type: 'button', onclick: o.onIsolate }, `แยกดู${floor.name}`) : null);
}

/** ตัดภาพผังต้นฉบับรอบพื้นที่ (ใช้กรอบพิกัดเดียวกับโมเดล) แล้ววาดเส้นขอบพื้นที่ */
function drawThumb(canvas, floor, room) {
  const src = floor.plan?.src;
  const det = floor.detail;
  if (!src || !det) { canvas.hidden = true; return; }
  const f = detailFrame(det);
  const toUV = (X, Y) => ({ u: (X - f.bx) / f.ax, v: (-Y - f.bz) / f.az });
  const [x0, y0, x1, y1] = room.bbox;
  const a = toUV(x0, y1); const b = toUV(x1, y0);
  const img = new Image();
  img.onload = () => {
    const W = img.naturalWidth; const H = img.naturalHeight;
    let sx0 = a.u * W; let sy0 = a.v * H; let sx1 = b.u * W; let sy1 = b.v * H;
    const pad = Math.max(24, 0.35 * Math.max(sx1 - sx0, sy1 - sy0));
    sx0 -= pad; sy0 -= pad; sx1 += pad; sy1 += pad;
    // ให้สัดส่วนตรงกับกรอบภาพ
    const cw = canvas.width; const ch = canvas.height;
    const want = cw / ch; let sw = sx1 - sx0; let sh = sy1 - sy0;
    if (sw / sh < want) { const d = sh * want - sw; sx0 -= d / 2; sw += d; } else { const d = sw / want - sh; sy0 -= d / 2; sh += d; }
    const g = canvas.getContext('2d');
    g.fillStyle = '#f2f5ef'; g.fillRect(0, 0, cw, ch);
    g.drawImage(img, sx0, sy0, sw, sh, 0, 0, cw, ch);
    const k = cw / sw;
    g.strokeStyle = '#e0a800'; g.lineWidth = 2.5; g.fillStyle = 'rgba(255,210,63,0.18)';
    const t = room.tris;
    if (t.length / 6 <= 400) {
      g.beginPath();
      for (let i = 0; i < t.length; i += 6) {
        for (let j = 0; j < 3; j++) {
          const p = toUV(t[i + j * 2], t[i + j * 2 + 1]);
          const x = (p.u * W - sx0) * k; const y = (p.v * H - sy0) * k;
          if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
      }
      g.fill();
    }
    const p0 = toUV(x0, y1); const p1 = toUV(x1, y0);
    g.strokeRect((p0.u * W - sx0) * k, (p0.v * H - sy0) * k, (p1.u - p0.u) * W * k, (p1.v - p0.v) * H * k);
  };
  img.onerror = () => { canvas.hidden = true; };
  img.src = src;
}
