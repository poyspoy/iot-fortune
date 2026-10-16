"""
วางหมุดจุดตรวจวัดบน "สำเนา" ภาพเรนเดอร์ของผู้ใช้ — มุมบน (top) และมุมเฉียง (oblique) ของชั้นเดียวกัน
หมายเลข/รหัสจุดเดียวกันทั้งสองมุม เพื่อให้เห็นว่าเป็นตำแหน่งเดียวกัน ภาพต้นฉบับไม่ถูกแก้ไข

ตำแหน่ง:
  - จุดในโมเดล (X, Y) มาจากพิกัดผังของแอปด้วยสูตรเดียวกับที่สร้างโมเดล (scripts/export-points.mjs)
  - มุมเฉียง: ฉายด้วยกล้องที่บันทึกในไฟล์ .blend ของชั้นนั้น (ortho, ความละเอียดเดียวกับภาพ)
  - มุมบน: ภาพครอบคลุมกรอบ crop ใน progress.json ที่ความละเอียดภาพต้นฉบับ → แปลงพิกัดตรง

  python scripts/blender/mark_renders.py <points.json> <progress.json> <models dir> <renders dir> <out dir>
"""
import json
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector
from PIL import Image, ImageDraw, ImageFont

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
POINTS, PROGRESS, MODELS, RENDERS, OUT = argv[:5]
os.makedirs(OUT, exist_ok=True)

FONT_DIR = '/usr/share/fonts/opentype/tlwg'
F_BOLD = os.path.join(FONT_DIR, 'Loma-Bold.otf')
F_REG = os.path.join(FONT_DIR, 'Loma.otf')

pts = json.load(open(POINTS, encoding='utf-8'))['points']
crops = {r['floor']: r for r in json.load(open(PROGRESS, encoding='utf-8'))}
by_floor = {}
for p in pts:
    if p['blender']:
        by_floor.setdefault(p['floorId'], []).append(p)

PIN = (15, 111, 105)       # teal ของแอป
RING = (255, 255, 255)
HALO = (247, 201, 72)


def top_px(floor, X, Y, size):
    r = crops[floor]
    c0, r0, c1, r1 = r['crop']
    W, H = size
    if r.get('office'):
        sx, sy = X / 0.05 + 770, 460 - Y / 0.05
    else:
        sx, sy = X / 0.1 + 1000, 336.5 - Y / 0.1
    return (sx - c0) * W / (c1 - c0), (sy - r0) * H / (r1 - r0)


def oblique_px(scene, X, Y, Z, size):
    v = world_to_camera_view(scene, scene.camera, Vector((X, Y, Z)))
    W, H = size
    return v.x * W, (1 - v.y) * H


def _overlap(a, b):
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def draw_pin(img, x, y, num, label, r, base=None, font=None, small=None, taken=None):
    d = ImageDraw.Draw(img)
    if base:  # ก้านหมุดจากพื้นถึงหัวหมุด (มุมเฉียง)
        d.line([base, (x, y)], fill=(20, 30, 34), width=max(2, r // 6))
        d.ellipse([base[0] - r * 0.28, base[1] - r * 0.28, base[0] + r * 0.28, base[1] + r * 0.28], fill=HALO, outline=(20, 30, 34), width=2)
    d.ellipse([x - r * 1.35, y - r * 1.35, x + r * 1.35, y + r * 1.35], outline=HALO, width=max(3, r // 5))
    d.ellipse([x - r, y - r, x + r, y + r], fill=PIN, outline=RING, width=max(3, r // 6))
    tw = d.textlength(str(num), font=font)
    d.text((x - tw / 2, y - r * 0.62), str(num), font=font, fill=(255, 255, 255))
    tx, ty = x + r * 1.6, y - r * 0.9
    tb = d.textbbox((tx, ty), label, font=small)
    if tb[2] > img.size[0] - 10:  # ชิดขอบขวา → วางป้ายทางซ้ายของหมุด
        tx = x - r * 1.6 - (tb[2] - tb[0]); tb = d.textbbox((tx, ty), label, font=small)
    if taken is not None:  # ป้ายไม่ทับกัน: เลื่อนลงทีละแถว
        step = (tb[3] - tb[1]) + 16
        while any(_overlap((tb[0] - 8, tb[1] - 5, tb[2] + 8, tb[3] + 5), t) for t in taken + [(x - r * 1.4, y - r * 1.4, x + r * 1.4, y + r * 1.4)]):
            ty += step; tb = d.textbbox((tx, ty), label, font=small)
        taken.append((tb[0] - 8, tb[1] - 5, tb[2] + 8, tb[3] + 5))
    lx = tb[0] - 8 if tb[0] > x else tb[2] + 8
    if abs(ty - (y - r * 0.9)) > 1:  # ป้ายถูกเลื่อน → เส้นโยงกลับไปที่หมุด
        d.line([(x, y), (lx, (tb[1] + tb[3]) / 2)], fill=PIN, width=max(2, r // 7))
    d.rounded_rectangle([tb[0] - 8, tb[1] - 5, tb[2] + 8, tb[3] + 5], radius=8, fill=(255, 255, 255), outline=PIN, width=3)
    d.text((tx, ty), label, font=small, fill=(20, 30, 34))


report = []
for floor, plist in sorted(by_floor.items(), key=lambda kv: kv[0]):
    blend = os.path.join(MODELS, f'Fortune_{floor}_v2.blend')
    top_path = os.path.join(RENDERS, f'{floor}_top.png')
    obl_path = os.path.join(RENDERS, f'{floor}_oblique.png')
    if not (os.path.exists(blend) and os.path.exists(top_path) and os.path.exists(obl_path)):
        report.append({'floor': floor, 'skipped': 'missing model or renders'})
        continue
    bpy.ops.wm.open_mainfile(filepath=blend)
    sc = [s for s in bpy.data.scenes if s.name.startswith('Floor_')][0]
    top = Image.open(top_path).convert('RGBA')
    obl = Image.open(obl_path).convert('RGBA')
    rt = max(16, int(top.size[1] * 0.028))
    ro = max(16, int(obl.size[1] * 0.026))
    ft, st = ImageFont.truetype(F_BOLD, int(rt * 1.25)), ImageFont.truetype(F_BOLD, int(rt * 0.95))
    fo, so = ImageFont.truetype(F_BOLD, int(ro * 1.25)), ImageFont.truetype(F_BOLD, int(ro * 0.95))
    rows = []
    taken_t, taken_o = [], []
    for p in plist:
        X, Y = p['blender']['X'], p['blender']['Y']
        label = f"{p['id']} {p['name']}"
        tx, ty = top_px(floor, X, Y, top.size)
        draw_pin(top, tx, ty, p['number'], label, rt, font=ft, small=st, taken=taken_t)
        bx, by = oblique_px(sc, X, Y, 0.05, obl.size)          # ตำแหน่งบนพื้น
        hx, hy = oblique_px(sc, X, Y, 6.0, obl.size)           # หัวหมุดเหนือผนัง (สูง 3.12)
        draw_pin(obl, hx, hy, p['number'], label, ro, base=(bx, by), font=fo, small=so, taken=taken_o)
        inside = 0 <= tx <= top.size[0] and 0 <= ty <= top.size[1] and 0 <= bx <= obl.size[0] and 0 <= by <= obl.size[1]
        rows.append({'number': p['number'], 'id': p['id'], 'top_px': [round(tx, 1), round(ty, 1)], 'oblique_floor_px': [round(bx, 1), round(by, 1)], 'inside_both': inside})
    top.convert('RGB').save(os.path.join(OUT, f'{floor}_top_IoT.png'), optimize=True)
    obl.convert('RGB').save(os.path.join(OUT, f'{floor}_oblique_IoT.png'), optimize=True)
    # แผ่นเทียบ: มุมบนกับมุมเฉียงของชั้นเดียวกัน หมายเลขเดียวกัน = จุดเดียวกัน
    W = 2000
    t2 = top.resize((W, int(top.size[1] * W / top.size[0])))
    o2 = obl.resize((W, int(obl.size[1] * W / obl.size[0])))
    head = 110
    sheet = Image.new('RGB', (W, head + t2.size[1] + o2.size[1] + 40), (246, 248, 243))
    d = ImageDraw.Draw(sheet)
    d.text((24, 18), f'ชั้น {floor} — มุมบนและมุมเฉียงของสถานที่เดียวกัน', font=ImageFont.truetype(F_BOLD, 40), fill=(20, 30, 34))
    d.text((24, 66), 'หมายเลขเดียวกัน = จุดเดียวกัน · ภาพจากโมเดล Blender ของผู้ใช้ (ไม่แก้ไข) · จุดเป็นตัวอย่าง รอยืนยันตำแหน่งจริง', font=ImageFont.truetype(F_REG, 26), fill=(86, 102, 108))
    sheet.paste(t2.convert('RGB'), (0, head))
    sheet.paste(o2.convert('RGB'), (0, head + t2.size[1] + 40))
    d.text((24, head + t2.size[1] + 4), 'มุมเฉียง (oblique)', font=ImageFont.truetype(F_BOLD, 28), fill=(20, 30, 34))
    sheet.save(os.path.join(OUT, f'{floor}_compare_IoT.png'), optimize=True)
    report.append({'floor': floor, 'points': rows})
    print('MARKED', floor, rows)

json.dump({'note': 'สำเนาภาพพร้อมหมุดจุดตรวจวัด ภาพต้นฉบับใน renders/ ไม่ถูกแก้ไข', 'floors': report},
          open(os.path.join(OUT, 'points_on_renders.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
