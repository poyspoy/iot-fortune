"""
สร้างโมเดลอาคาร IoT ฟอร์จูนด้วย Blender (bpy) แล้วส่งออกเป็น public/models/fortune.glb

ใช้รูปทรงชั้นจากการตั้งค่าเดียวกับแอป (scripts/export-geometry.mjs) จึงตรงกับผังและหมุดเสมอ
แต่ละชั้นเป็นโหนด "floor-<รหัสชั้น>" ในพิกัดของชั้นนั้น (ฐานชั้นที่ y = 0) แอปนำไปติดกับกลุ่มชั้น
ทำให้การแยกดูชั้นเดี่ยว/ประกอบอาคาร และตำแหน่งหมุด ทำงานเหมือนเดิม

สิ่งที่สร้าง (เชิงแผนภาพ ไม่ใช่แบบก่อสร้าง):
  - ผนังกระจกโดยรอบ + เสาเอ็น (mullion) + คานขอบบน ตามแนวรูปทรงที่ลากจากผัง
  - ทาวเวอร์: หน้าต่างแนวยาวต่อเนื่อง และราวกันตกบนดาดฟ้าชั้นบนสุด
  - ลานจอดชั้น 5: เสาและราวกันตกรอบวง
  ไม่มีการเพิ่มอุปกรณ์หรือห้องเครื่องที่ไม่ได้รับข้อมูลยืนยัน

วิธีใช้:
  pip install bpy           (หรือใช้ Blender ที่ติดตั้งไว้: blender -b -P scripts/blender/build_model.py -- ...)
  node scripts/export-geometry.mjs > build/geometry.json
  python scripts/blender/build_model.py build/geometry.json public/models/fortune.glb
"""
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plan_walls import mall_walls, office_walls, downsample, greedy_rects  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
GEOM = argv[0] if len(argv) > 0 else 'build/geometry.json'
OUT = argv[1] if len(argv) > 1 else 'public/models/fortune.glb'
PUBLIC = argv[2] if len(argv) > 2 else 'public'

data = json.load(open(GEOM, encoding='utf-8'))

# ---------------------------------------------------------------- ฉากว่าง
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, rgb, alpha=1.0, rough=0.6, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        if hasattr(m, 'surface_render_method'):
            m.surface_render_method = 'BLENDED'
        if hasattr(m, 'blend_method'):
            m.blend_method = 'BLEND'
    return m


def srgb(hexstr):
    h = hexstr.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


MAT_GLASS = material('Glass', srgb('#9cc9c4'), alpha=0.28, rough=0.05, metal=0.1)
MAT_FRAME = material('Frame', srgb('#5d6b70'), rough=0.45, metal=0.35)
MAT_BAND = material('Spandrel', srgb('#d6ddd5'), rough=0.8)
MAT_RAIL = material('Rail', srgb('#7b8a8f'), rough=0.5, metal=0.4)
MAT_WALL = material('Wall', srgb('#f3f5f1'), rough=0.85)
WALL_H = {'mall': 0.34, 'tower': 0.15}   # ความสูงผนังตัด (สไตล์ผังตัดสามมิติ) เหนือแผ่นพื้น
SLAB_T = {'mall': 0.10, 'tower': 0.05, 'parking': 0.10}
CELL = 2  # ย่อมาสก์ผนัง 2×2 พิกเซลต่อเซลล์


def world_pts(floor):
    """รูปทรงชั้นในพิกัดแอป (x, z) → Blender (X, Y=-z)"""
    m = floor['model']
    pts = [(m['cx'] + (nx - 0.5) * m['width'], -(m['cz'] + (ny - 0.5) * m['depth'])) for nx, ny in floor['footprint']]
    # เรียงทวนเข็มนาฬิกาเพื่อให้ด้านนอกของผนังหันออก
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    return pts if area > 0 else pts[::-1]


def add_box(bm, center, size, rot_z=0.0):
    mat = Matrix.Translation(Vector(center)) @ Matrix.Rotation(rot_z, 4, 'Z') @ Matrix.Diagonal((size[0], size[1], size[2], 1))
    bmesh.ops.create_cube(bm, size=1.0, matrix=mat)


def add_wall_quad(bm, a, b, z0, z1):
    v = [bm.verts.new((a[0], a[1], z0)), bm.verts.new((b[0], b[1], z0)), bm.verts.new((b[0], b[1], z1)), bm.verts.new((a[0], a[1], z1))]
    bm.faces.new(v)


def mesh_from(name, build, mat):
    bm = bmesh.new()
    build(bm)
    if not bm.verts:
        bm.free()
        return None
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    return me


def facade_meshes(floor, kind):
    pts = world_pts(floor)
    h = floor['model']['height']
    slab = 0.05 if kind == 'tower' else 0.10
    band = 0.06 if kind == 'tower' else 0.10
    spacing = 0.36 if kind == 'tower' else 0.6
    mull = 0.022 if kind == 'tower' else 0.03
    top = h - band

    def glass(bm):
        for i in range(len(pts)):
            add_wall_quad(bm, pts[i], pts[(i + 1) % len(pts)], slab, top)

    def frame(bm):
        for i in range(len(pts)):
            a, b = Vector(pts[i]), Vector(pts[(i + 1) % len(pts)])
            d = b - a
            L = d.length
            if L < 1e-4:
                continue
            ang = math.atan2(d.y, d.x)
            mid = (a + b) / 2
            # คานขอบบน (spandrel) ต่อเนื่องตลอดแนว
            add_box(bm, (mid.x, mid.y, top + band / 2), (L + 0.02, 0.035, band), ang)
            # เสาเอ็นแบ่งช่องกระจก
            n = max(1, round(L / spacing))
            for k in range(n + 1):
                p = a + d * (k / n)
                add_box(bm, (p.x, p.y, (slab + top) / 2), (mull, mull, top - slab), ang)

    return mesh_from(f"glass-{floor['id'] if kind != 'tower' else 'tower'}", glass, MAT_GLASS), \
        mesh_from(f"frame-{floor['id'] if kind != 'tower' else 'tower'}", frame, MAT_FRAME)


def railing_mesh(floor, z0, height, name):
    pts = world_pts(floor)

    def build(bm):
        for i in range(len(pts)):
            a, b = Vector(pts[i]), Vector(pts[(i + 1) % len(pts)])
            d = b - a
            L = d.length
            if L < 1e-4:
                continue
            ang = math.atan2(d.y, d.x)
            mid = (a + b) / 2
            add_box(bm, (mid.x, mid.y, z0 + height), (L + 0.02, 0.025, 0.025), ang)
            n = max(1, round(L / 0.35))
            for k in range(n):
                p = a + d * (k / n)
                add_box(bm, (p.x, p.y, z0 + height / 2), (0.02, 0.02, height), ang)

    return mesh_from(name, build, MAT_RAIL)


def interior_walls(floor, kind, name):
    """ยกผนังจากเส้นในภาพผัง + ผนังรอบนอกที่ความสูงตัดเดียวกัน"""
    m = floor['model']
    plan = floor['plan']
    path = os.path.join(PUBLIC, plan['src'])
    mask = mall_walls(path) if kind == 'mall' else office_walls(path)
    H_img, W_img = mask.shape
    cells = downsample(mask, CELL)
    rects = greedy_rects(cells)
    z0 = SLAB_T[kind]
    h = WALL_H[kind]

    def to_xy(px, py):
        u, v = px / W_img, py / H_img
        return m['cx'] + (u - 0.5) * m['width'], -(m['cz'] + (v - 0.5) * m['depth'])

    pts = world_pts(floor)

    def build(bm):
        for x0, y0, x1, y1 in rects:
            ax, ay = to_xy(x0 * CELL, y0 * CELL)
            bx, by = to_xy(x1 * CELL, y1 * CELL)
            add_box(bm, ((ax + bx) / 2, (ay + by) / 2, z0 + h / 2), (abs(bx - ax), abs(by - ay), h))
        for i in range(len(pts)):  # ผนังรอบนอก
            a, b = Vector(pts[i]), Vector(pts[(i + 1) % len(pts)])
            d = b - a
            if d.length < 1e-4:
                continue
            mid = (a + b) / 2
            add_box(bm, (mid.x, mid.y, z0 + h / 2), (d.length + 0.04, 0.04, h), math.atan2(d.y, d.x))

    me = mesh_from(name, build, MAT_WALL)
    print(f"  walls {floor['id']}: {len(rects)} rects")
    return me


def link(obj, parent):
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent


floors = data['floors']
tower_shared = None  # ทุกชั้นสำนักงานใช้รูปทรงเดียวกัน → ใช้ mesh ร่วม (instancing) ไฟล์จึงเล็ก
tower_walls = None
towers = [f for f in floors if f['kind'] == 'tower']
top_tower = max(towers, key=lambda f: f['order'])['id'] if towers else None
top_podium = max((f for f in floors if f['kind'] == 'mall'), key=lambda f: f['order'])['id']

for f in floors:
    root = bpy.data.objects.new(f"floor-{f['id']}", None)
    bpy.context.scene.collection.objects.link(root)
    kind = f['kind']
    parts = []
    if kind == 'parking':
        parts.append(railing_mesh(f, 0.1, 0.18, f"rail-{f['id']}"))
    elif kind == 'tower':
        if tower_shared is None:
            tower_shared = facade_meshes(f, 'tower')
            tower_walls = interior_walls(f, 'tower', 'walls-tower')  # ผังอ้างอิงร่วม → ผนังชุดเดียวใช้ทุกชั้น
        parts.extend(tower_shared)
        parts.append(tower_walls)
        if f['id'] == top_tower:
            parts.append(railing_mesh(f, f['model']['height'], 0.12, 'tower-roof-rail'))
    else:
        parts.extend(facade_meshes(f, kind))
        parts.append(interior_walls(f, kind, f"walls-{f['id']}"))
        if f['id'] == top_podium:
            parts.append(railing_mesh(f, f['model']['height'], 0.12, 'podium-roof-rail'))
    for me in parts:
        if me is None:
            continue
        ob = bpy.data.objects.new(f"{me.name}@{f['id']}", me)
        link(ob, root)

os.makedirs(os.path.dirname(OUT) or '.', exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', export_yup=True, use_selection=False,
    export_apply=False, export_materials='EXPORT', export_extras=False,
)
print('wrote', OUT, os.path.getsize(OUT), 'bytes,', len(floors), 'floors')
