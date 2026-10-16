# สร้างรถเก๋ง Low-poly สำหรับ NEXZA Digital Twin (ข้อมูลจำลอง) → public/models/vehicles/sedan.glb
# ชิ้นส่วนแยก: body, glass, headlights, taillights, trim และล้อ 4 ล้อ wheel_FL / wheel_FR / wheel_RL / wheel_RR
# จุดกำเนิดของล้อแต่ละล้อ = กึ่งกลางล้อ แกนเพลา = แกน X → หมุนล้อได้จริงและหักเลี้ยวล้อหน้าได้
# หน่วยเมตร ขนาดจริง: ยาว 4.60 กว้าง 1.80 สูง 1.45 ระยะฐานล้อ 2.70 ล้อรัศมี 0.33
# ทิศหน้ารถ = -Y ใน Blender (ส่งออก glTF แล้วหน้ารถ = +Z) · พื้นถนน z = 0
#   python3 tools/blender/make_sedan.py
import bpy, bmesh, math, os, sys
from mathutils import Vector

OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'models', 'vehicles', 'sedan.glb')
bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name, color, rough=0.5, metal=0.0, emit=None, emit_strength=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = emit_strength
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
    return m

def srgb(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)

M_PAINT = mat('CarPaint', srgb('#e6e9e7'), 0.32, 0.25)
M_GLASS = mat('Glass', srgb('#1f2b30'), 0.08, 0.4)
M_TRIM = mat('Trim', srgb('#2a3236'), 0.7, 0.0)
M_HEAD = mat('Headlight', srgb('#f4f6f2'), 0.15, 0.0, srgb('#fff8e8'), 0.6)
M_TAIL = mat('Taillight', srgb('#7a1d1d'), 0.3, 0.0, srgb('#c8322f'), 0.35)
M_TIRE = mat('Tire', srgb('#1b1e20'), 0.85, 0.0)
M_RIM = mat('Rim', srgb('#b8c0c3'), 0.35, 0.7)

L, W, H = 4.60, 1.80, 1.45
WB, TRACK, R = 2.70, 1.55, 0.33
FRONT_AX = -WB / 2 - 0.05   # หน้า = -Y
REAR_AX = WB / 2 - 0.05

def obj_from_bm(name, bm, material, smooth=False):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    if smooth:
        for p in me.polygons: p.use_smooth = True
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    ob.data.materials.append(material)
    return ob

# ---------------- ตัวถังส่วนล่าง: ภาคตัดตามความยาว (y, z ล่าง, z ไหล่, z ดาดฟ้า, ครึ่งกว้างล่าง, ครึ่งกว้างดาดฟ้า)
S = [
    # y      zlow  zsh   zdeck wlow  wdeck
    (-2.30, 0.32, 0.58, 0.64, 0.80, 0.70),   # หน้ารถ
    (-2.20, 0.24, 0.68, 0.76, 0.86, 0.78),
    (-1.85, 0.22, 0.74, 0.82, 0.89, 0.80),   # ฝากระโปรงหน้า
    (-1.05, 0.22, 0.80, 0.90, 0.90, 0.82),   # โคนกระจกหน้า
    (0.00, 0.22, 0.82, 0.92, 0.90, 0.83),
    (1.55, 0.22, 0.82, 0.92, 0.90, 0.82),    # โคนกระจกหลัง
    (2.05, 0.26, 0.80, 0.90, 0.88, 0.79),    # ฝากระโปรงหลัง
    (2.30, 0.34, 0.70, 0.80, 0.80, 0.70),    # ท้ายรถ
]
def loft(name, rings_pts, material, cap=True):
    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in r] for r in rings_pts]
    n = len(rings[0])
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(n):
            bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    if cap:
        bm.faces.new(list(reversed(rings[0]))); bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bm(name, bm, material)
body = loft('body', [[(-wl, y, zl), (-wl, y, zs), (-wd, y, zd), (wd, y, zd), (wl, y, zs), (wl, y, zl)] for (y, zl, zs, zd, wl, wd) in S], M_PAINT)
bev = body.modifiers.new('bevel', 'BEVEL'); bev.width = 0.04; bev.segments = 2; bev.limit_method = 'ANGLE'; bev.angle_limit = math.radians(25)
for ax in (FRONT_AX, REAR_AX):
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=R + 0.06, depth=W + 0.4, location=(0, ax, R), rotation=(0, math.radians(90), 0))
    cut = bpy.context.active_object; cut.name = 'arch_cut'
    bo = body.modifiers.new('arch', 'BOOLEAN'); bo.object = cut; bo.operation = 'DIFFERENCE'
bpy.context.view_layer.objects.active = body
for md in list(body.modifiers): bpy.ops.object.modifier_apply(modifier=md.name)
for ob in [o for o in bpy.data.objects if o.name.startswith('arch_cut')]: bpy.data.objects.remove(ob)

# ---------------- ห้องโดยสาร: กระจกรอบคัน (กระจกหน้า ข้าง หลัง) + หลังคาสีตัวถังวางทับ
GH = [  # y      zbase zroof wbase wroof
    (-1.02, 0.89, 0.91, 0.80, 0.78),
    (-0.45, 0.91, 1.37, 0.81, 0.68),
    (0.45, 0.91, 1.42, 0.81, 0.69),
    (1.05, 0.91, 1.30, 0.81, 0.67),
    (1.58, 0.90, 0.92, 0.80, 0.78),
]
glass = loft('glass', [[(-wb, y, zb), (-wr, y, zr), (wr, y, zr), (wb, y, zb)] for (y, zb, zr, wb, wr) in GH], M_GLASS, cap=False)
roof = loft('roof', [[(-(wr + 0.012), y, zr - 0.035), (-(wr + 0.012), y, zr + 0.012), ((wr + 0.012), y, zr + 0.012), ((wr + 0.012), y, zr - 0.035)]
                     for (y, zb, zr, wb, wr) in [(-0.40, 0, 1.375, 0, 0.678), (0.45, 0, 1.42, 0, 0.69), (1.00, 0, 1.31, 0, 0.672)]], M_PAINT)
rb = roof.modifiers.new('b', 'BEVEL'); rb.width = 0.02; rb.segments = 2
bpy.context.view_layer.objects.active = roof; bpy.ops.object.modifier_apply(modifier='b')
# เสา B สีเข้ม แบ่งหน้าต่างหน้า/หลัง
for sx in (-1, 1):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(sx * 0.745, 0.28, 1.15))
    pil = bpy.context.active_object; pil.scale = (0.03, 0.07, 0.48); pil.rotation_euler = (0, math.radians(sx * 9), 0); pil.name = 'pillar'
    pil.data.materials.append(M_TRIM)

# ---------------- ไฟหน้า / ไฟท้าย (แยกชิ้น: เปลี่ยนความสว่างไฟเบรกได้)
def lamp(name, x, y, z, sx, sy, sz, m):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, z))
    o = bpy.context.active_object; o.scale = (sx, sy, sz); o.name = name
    b = o.modifiers.new('b', 'BEVEL'); b.width = 0.02; b.segments = 2
    bpy.context.view_layer.objects.active = o; bpy.ops.object.modifier_apply(modifier='b')
    o.data.materials.append(m); return o
heads = [lamp('headlight_R', -0.58, -2.30, 0.55, 0.30, 0.06, 0.09, M_HEAD), lamp('headlight_L', 0.58, -2.30, 0.55, 0.30, 0.06, 0.09, M_HEAD)]
tails = [lamp('taillight_R', -0.58, 2.31, 0.66, 0.34, 0.05, 0.09, M_TAIL), lamp('taillight_L', 0.58, 2.31, 0.66, 0.34, 0.05, 0.09, M_TAIL)]
# กันชน/ขอบล่าง/กระจังสีเข้ม
trim = [lamp('grille', 0, -2.31, 0.44, 0.62, 0.04, 0.1, M_TRIM), lamp('rear_trim', 0, 2.33, 0.42, 0.9, 0.04, 0.07, M_TRIM),
        lamp('sill_L', -0.905, 0.15, 0.27, 0.025, 1.45, 0.05, M_TRIM), lamp('sill_R', 0.905, 0.15, 0.27, 0.025, 1.45, 0.05, M_TRIM)]
for sx in (-1, 1):  # กระจกมองข้าง
    trim.append(lamp(f'mirror_{"R" if sx < 0 else "L"}', sx * 0.93, -0.85, 0.97, 0.12, 0.06, 0.055, M_PAINT))

def join(name, objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join(); objs[0].name = name; return objs[0]
join('headlights', heads); join('taillights', tails)
join('trim', trim + [o for o in bpy.data.objects if o.name.startswith('pillar')])

# ---------------- ล้อ: ยาง + ล้อแม็ก 5 ก้าน (เห็นการหมุนชัด) แยกเป็น 4 วัตถุ จุดกำเนิดที่กึ่งกลางล้อ
def wheel(name, x, y, side):
    parts = []
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=R, depth=0.22, location=(0, 0, 0), rotation=(0, math.radians(90), 0))
    tire = bpy.context.active_object; tire.data.materials.append(M_TIRE)
    b = tire.modifiers.new('b', 'BEVEL'); b.width = 0.04; b.segments = 2; bpy.context.view_layer.objects.active = tire; bpy.ops.object.modifier_apply(modifier='b')
    parts.append(tire)
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=R * 0.62, depth=0.03, location=(side * 0.105, 0, 0), rotation=(0, math.radians(90), 0))
    rim = bpy.context.active_object; rim.data.materials.append(M_RIM); parts.append(rim)
    for k in range(5):  # ก้านล้อ (ทาสีเข้ม/สว่างสลับให้เห็นการหมุน)
        a = k * 2 * math.pi / 5
        bpy.ops.mesh.primitive_cube_add(size=1, location=(side * 0.118, math.cos(a) * R * 0.33, math.sin(a) * R * 0.33))
        sp = bpy.context.active_object; sp.scale = (0.012, 0.045, R * 0.6); sp.rotation_euler = (-a + math.pi / 2, 0, 0)
        sp.data.materials.append(M_TRIM); parts.append(sp)
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.045, depth=0.04, location=(side * 0.12, 0, 0), rotation=(0, math.radians(90), 0))
    hub = bpy.context.active_object; hub.data.materials.append(M_RIM); parts.append(hub)
    w = join(name, parts)
    bpy.context.view_layer.objects.active = w
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    w.location = (x, y, R)  # จุดกำเนิด = กึ่งกลางล้อ
    return w
# หน้ารถ = -Y และหลังคา = +Z → ด้านซ้ายของคนขับ = +X
wheels = [wheel('wheel_FL', TRACK / 2, FRONT_AX, 1), wheel('wheel_FR', -TRACK / 2, FRONT_AX, -1),
          wheel('wheel_RL', TRACK / 2, REAR_AX, 1), wheel('wheel_RR', -TRACK / 2, REAR_AX, -1)]

# ---------------- รวมเป็นรถ: วัตถุแม่ 'sedan' ที่พื้น (z=0) กึ่งกลางรถ
root = bpy.data.objects.new('sedan', None); bpy.context.collection.objects.link(root)
for o in list(bpy.data.objects):
    if o is not root and o.type == 'MESH': o.parent = root
root['wheelRadius'] = R; root['wheelbase'] = WB; root['length'] = L; root['note'] = 'NEXZA demo vehicle (simulated) — not real tracking data'

tris = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == 'MESH')
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_apply=True, export_extras=True, export_yup=True)
print('exported', OUT, 'faces', tris, [o.name for o in bpy.data.objects])
