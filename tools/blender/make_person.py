# คนจำลอง Low-poly แบบ Rigged สำหรับ NEXZA Digital Twin (ข้อมูลจำลอง · ไม่ใช่ข้อมูลติดตามบุคคลจริง) → public/models/people/person.glb
# - โครงกระดูก: root, hips, spine, chest, neck, head, upperarm/forearm (L/R), thigh/shin/foot (L/R)
# - ร่างกาย: ศีรษะ (ไม่มีรายละเอียดใบหน้า) ผม ลำตัว แขน มือ ขา รองเท้า กระเป๋า(เลือกแสดง) — ผูกกับกระดูกแบบแข็ง
# - Animation: Idle (3 วิ), Walk (1 วิ/รอบ), Turn (ก้าวหมุนตัวอยู่กับที่ 1 วิ/รอบ)
#   Walk: ขาใช้ IK ให้เท้าที่แตะพื้นเลื่อนถอยหลังด้วยความเร็วคงที่ (= ความเร็วเดินของแอนิเมชัน) แล้ว bake เป็น FK
#   → ในเว็บ ปรับอัตราเล่น = ความเร็วเคลื่อนที่ / WALK_SPEED เท้าจึงไม่ไถล และไม่จมพื้น (เท้าอยู่ที่ z = 0 ช่วงแตะพื้น)
# หน่วยเมตร สูง ~1.70 ม. หน้าตัว = -Y (ส่งออก glTF แล้วหน้าตัว = +Z)
#   python3 tools/blender/make_person.py
import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Matrix, Euler

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models', 'people', 'person.glb')
FPS = 30
WALK_FRAMES = 30            # 1 รอบเดิน = 1.0 วินาที (2 ก้าว)
STRIDE = 0.55               # ระยะที่เท้าเลื่อนช่วงแตะพื้น (เมตร) — เดินเล่นในห้าง ~0.9 ม./วิ
STANCE = 0.6                # สัดส่วนเวลาที่เท้าแตะพื้นต่อรอบ
WALK_SPEED = STRIDE / (STANCE * WALK_FRAMES / FPS)   # ≈ 1.083 ม./วิ
FOOT_Z = 0.08               # ระดับข้อเท้าเมื่อเท้าวางราบ (พื้นรองเท้าที่ z = 0)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene; scene.render.fps = FPS

def srgb(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)
def mat(name, hexc, rough=0.8):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*srgb(hexc), 1); b.inputs['Roughness'].default_value = rough
    return m
MATS = {k: mat(k, c) for k, c in [('Skin', '#c9a58a'), ('Hair', '#2e2a28'), ('Top', '#5c7f86'), ('Bottom', '#3d474c'), ('Shoes', '#2a2d2f'), ('Bag', '#8a7a62'), ('Badge', '#e9ece8'), ('ShopBag', '#d9d1bf')]}

# ---------------- โครงกระดูก
arm_data = bpy.data.armatures.new('PersonRig'); arm = bpy.data.objects.new('person', arm_data)
scene.collection.objects.link(arm); bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
B = {}
def bone(name, head, tail, parent=None, roll=0.0):
    b = arm_data.edit_bones.new(name); b.head = Vector(head); b.tail = Vector(tail); b.roll = roll
    if parent: b.parent = B[parent]; b.use_connect = False
    B[name] = b; return b
bone('root', (0, 0, 0), (0, 0.15, 0))
bone('hips', (0, 0, 0.95), (0, 0, 1.05), 'root')
bone('spine', (0, 0, 1.05), (0, 0, 1.25), 'hips')
bone('chest', (0, 0, 1.25), (0, 0, 1.44), 'spine')
bone('neck', (0, 0, 1.44), (0, 0, 1.53), 'chest')
bone('head', (0, 0, 1.53), (0, 0, 1.73), 'neck')
for s, sx in (('L', 1), ('R', -1)):
    bone(f'upperarm.{s}', (sx * 0.2, 0.0, 1.41), (sx * 0.23, 0.01, 1.13), 'chest')
    bone(f'forearm.{s}', (sx * 0.23, 0.01, 1.13), (sx * 0.25, -0.02, 0.88), f'upperarm.{s}')
    bone(f'thigh.{s}', (sx * 0.095, 0.0, 0.93), (sx * 0.095, -0.015, 0.5), 'hips')
    bone(f'shin.{s}', (sx * 0.095, -0.015, 0.5), (sx * 0.095, 0.0, FOOT_Z), f'thigh.{s}')
    bone(f'foot.{s}', (sx * 0.095, 0.0, FOOT_Z), (sx * 0.095, -0.15, 0.03), f'shin.{s}')
bpy.ops.object.mode_set(mode='OBJECT')
REST = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in arm_data.bones}

# ---------------- ร่างกาย (ชิ้นส่วนผูกกระดูกแบบแข็ง)
parts = []
def finish(bm, name, bonename, m, smooth=True):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = smooth
    ob = bpy.data.objects.new(name, me); scene.collection.objects.link(ob)
    ob.data.materials.append(MATS[m])
    vg = ob.vertex_groups.new(name=bonename); vg.add(list(range(len(me.vertices))), 1.0, 'REPLACE')
    parts.append(ob); return ob
def limb(name, bonename, p0, p1, r0, r1, m, seg=10, sx=1.0, sy=1.0):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r0, radius2=r1, depth=(Vector(p1) - Vector(p0)).length)
    for v in bm.verts: v.co.x *= sx; v.co.y *= sy
    d = (Vector(p1) - Vector(p0)); rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation((Vector(p0) + Vector(p1)) / 2) @ rot, verts=bm.verts)
    return finish(bm, name, bonename, m)
def ball(name, bonename, c, r, m, sx=1, sy=1, sz=1, sub=2):
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    for v in bm.verts: v.co.x *= sx; v.co.y *= sy; v.co.z *= sz
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    return finish(bm, name, bonename, m)
def box(name, bonename, c, size, m, bevel=0.02):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) + Vector(c)
    ob = finish(bm, name, bonename, m, smooth=False)
    if bevel:
        md = ob.modifiers.new('b', 'BEVEL'); md.width = bevel; md.segments = 2
        bpy.context.view_layer.objects.active = ob; bpy.ops.object.modifier_apply(modifier='b')
    return ob
# ลำตัว: สะโพก ท้อง อก (เสื้อ/กางเกง)
limb('pelvis', 'hips', (0, 0, 0.88), (0, 0, 1.04), 0.15, 0.145, 'Bottom', seg=12, sy=0.68)
limb('belly', 'spine', (0, 0, 1.03), (0, 0, 1.26), 0.145, 0.16, 'Top', seg=12, sy=0.66)
limb('torso', 'chest', (0, 0, 1.25), (0, 0, 1.45), 0.165, 0.13, 'Top', seg=12, sy=0.62)
ball('shoulders', 'chest', (0, 0, 1.41), 0.1, 'Top', sx=2.05, sy=0.95, sz=0.55)
limb('neckm', 'neck', (0, 0, 1.43), (0, 0, 1.55), 0.045, 0.042, 'Skin', seg=8)
ball('headm', 'head', (0, -0.01, 1.64), 0.1, 'Skin', sx=0.9, sy=1.0, sz=1.12)
ball('hairm', 'head', (0, 0.012, 1.672), 0.104, 'Hair', sx=0.93, sy=1.02, sz=0.95)   # ผมทรงสั้น (ไม่มีรายละเอียดใบหน้า)
for s, sx in (('L', 1), ('R', -1)):
    ball(f'shoulder.{s}', f'upperarm.{s}', (sx * 0.2, 0, 1.40), 0.058, 'Top')
    limb(f'uarm.{s}', f'upperarm.{s}', (sx * 0.2, 0, 1.41), (sx * 0.23, 0.01, 1.13), 0.052, 0.042, 'Top', seg=8)
    ball(f'elbow.{s}', f'forearm.{s}', (sx * 0.23, 0.01, 1.13), 0.041, 'Skin', sub=1)
    limb(f'farm.{s}', f'forearm.{s}', (sx * 0.23, 0.01, 1.13), (sx * 0.25, -0.02, 0.9), 0.04, 0.032, 'Skin', seg=8)
    ball(f'hand.{s}', f'forearm.{s}', (sx * 0.252, -0.022, 0.85), 0.042, 'Skin', sx=0.6, sy=0.85, sz=1.3, sub=1)
    ball(f'hip.{s}', f'thigh.{s}', (sx * 0.095, 0, 0.92), 0.08, 'Bottom', sub=1)
    limb(f'thighm.{s}', f'thigh.{s}', (sx * 0.095, 0, 0.93), (sx * 0.095, -0.015, 0.5), 0.078, 0.058, 'Bottom', seg=10)
    ball(f'knee.{s}', f'shin.{s}', (sx * 0.095, -0.015, 0.5), 0.057, 'Bottom', sub=1)
    limb(f'shinm.{s}', f'shin.{s}', (sx * 0.095, -0.015, 0.5), (sx * 0.095, 0, 0.11), 0.055, 0.042, 'Bottom', seg=10)
    box(f'shoe.{s}', f'foot.{s}', (sx * 0.095, -0.045, 0.04), (0.095, 0.26, 0.08), 'Shoes', bevel=0.025)
# ชิ้นเสริมสำหรับรูปลักษณ์ต่าง ๆ (ซ่อน/แสดงในเว็บ): ผมยาว, ป้ายพนักงาน, ถุงช้อปปิ้ง
extra = []
hl = ball('hair_long', 'head', (0, 0.03, 1.6), 0.106, 'Hair', sx=0.95, sy=0.9, sz=1.25)
pt = limb('pony', 'head', (0, 0.1, 1.64), (0, 0.13, 1.47), 0.04, 0.025, 'Hair', seg=8)
badge = box('badge', 'chest', (0.075, -0.103, 1.33), (0.05, 0.012, 0.065), 'Badge', bevel=0.004)
lan = limb('lanyard', 'chest', (0.075, -0.1, 1.37), (0.0, -0.085, 1.46), 0.006, 0.006, 'Badge', seg=6)
sb = box('shopbag', 'forearm.R', (-0.29, -0.02, 0.72), (0.05, 0.2, 0.22), 'ShopBag', bevel=0.01)
sbh = limb('shopbag_h', 'forearm.R', (-0.27, -0.05, 0.84), (-0.27, 0.05, 0.84), 0.007, 0.007, 'ShopBag', seg=6)
extra_groups = {'hair_long': [hl, pt], 'badge': [badge, lan], 'shopbag': [sb, sbh]}
# กระเป๋าสะพาย (แสดงบางแบบ) — ชิ้นแยก ชื่อ bag
bag = box('bag', 'chest', (-0.2, 0.06, 1.0), (0.06, 0.24, 0.2), 'Bag', bevel=0.02)
strap = limb('strap', 'chest', (0.17, -0.02, 1.43), (-0.19, 0.05, 1.09), 0.012, 0.012, 'Bag', seg=6, sy=0.5)
_extra = [o for g in extra_groups.values() for o in g]
body_names = [o.name for o in parts if o not in (bag, strap) and o not in _extra]
bpy.ops.object.select_all(action='DESELECT')
for o in [bag, strap]: o.select_set(True)
bpy.context.view_layer.objects.active = bag; bpy.ops.object.join(); bag.name = 'bag'
body_parts = [bpy.data.objects[n] for n in body_names]
bpy.ops.object.select_all(action='DESELECT')
for o in body_parts: o.select_set(True)
bpy.context.view_layer.objects.active = body_parts[0]; bpy.ops.object.join(); body = body_parts[0]; body.name = 'body'
joined = []
for name, objs in extra_groups.items():
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join(); objs[0].name = name; joined.append(objs[0])
for ob in (body, bag, *joined):
    ob.parent = arm
    md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = arm

# ---------------- ตัวช่วย IK (เฉพาะตอนสร้าง Walk/Turn แล้ว bake เป็น FK)
def empty(name, loc):
    e = bpy.data.objects.new(name, None); scene.collection.objects.link(e); e.location = loc; return e
IKT = {}; POLE = {}
for s, sx in (('L', 1), ('R', -1)):
    t = empty(f'ik.{s}', (sx * 0.095, 0, FOOT_Z))
    # วางแนวเป้าให้ตรงกับแนวกระดูกเท้าตอนพัก (เท้าราบ)
    h, tl = REST[f'foot.{s}']; t.matrix_world = arm.matrix_world @ arm_data.bones[f'foot.{s}'].matrix_local
    IKT[s] = t; POLE[s] = empty(f'pole.{s}', (sx * 0.095, -0.8, 0.55))
bpy.context.view_layer.objects.active = arm; bpy.ops.object.mode_set(mode='POSE')
for pb in arm.pose.bones: pb.rotation_mode = 'QUATERNION'
def add_ik(pole_angle):
    for s in 'LR':
        pb = arm.pose.bones[f'shin.{s}']
        for c in list(pb.constraints): pb.constraints.remove(c)
        c = pb.constraints.new('IK'); c.target = IKT[s]; c.pole_target = POLE[s]; c.pole_angle = math.radians(pole_angle); c.chain_count = 2
        fb = arm.pose.bones[f'foot.{s}']
        for c2 in list(fb.constraints): fb.constraints.remove(c2)
        cr = fb.constraints.new('COPY_ROTATION'); cr.target = IKT[s]
def remove_constraints():
    for pb in arm.pose.bones:
        for c in list(pb.constraints): pb.constraints.remove(c)
def bone_world(name, tail=False):
    pb = arm.pose.bones[name]; return arm.matrix_world @ (pb.tail if tail else pb.head)

# เลือกมุม pole ให้เข่างอไปด้านหน้า (-Y) และเท้าถึงเป้า
best = None
for ang in (-90, 90, 0, 180):
    add_ik(ang)
    for s in 'LR': IKT[s].location.z = FOOT_Z + 0.25; IKT[s].location.y = -0.1
    bpy.context.view_layer.update()
    knee = bone_world('shin.L'); hip = bone_world('thigh.L'); ank = bone_world('shin.L', tail=True)
    err = (ank - IKT['L'].location).length
    if knee.y < (hip.y + ank.y) / 2 - 0.03 and err < 0.02: best = ang; break
assert best is not None, 'pole angle'
add_ik(best)

# ---------------- สร้างท่าทางทีละเฟรม แล้ว bake เป็น keyframe ของกระดูก (FK)
def smooth01(t): return t * t * (3 - 2 * t)
# จุดสัมผัสพื้นของรองเท้า เทียบกับข้อเท้า (หน้าตัว = -Y): ส้นเท้า และปลายเท้า(ฝ่าเท้าส่วนหน้า)
HEEL = Vector((0, 0.085, -FOOT_Z)); BALL = Vector((0, -0.13, -FOOT_Z))
STRIKE = 0.14; HEELOFF = 0.62      # สัดส่วนในช่วงแตะพื้น: ส้นแตะ→เท้าราบ, ยกส้น→ปลายเท้าดันพื้น
PITCH_STRIKE = -0.28; PITCH_TOEOFF = 0.55   # ลบ = ปลายเท้ายก (ส้นแตะก่อน) · บวก = ส้นยก (ดันด้วยปลายเท้า)
def ankle_from_pivot(pivot_y, offset, pitch):
    """ข้อเท้าเมื่อจุดหมุน (ส้น/ปลายเท้า) แตะพื้นที่ (pivot_y, 0) และเท้าเอียง pitch"""
    o = Matrix.Rotation(pitch, 3, 'X') @ offset
    return (pivot_y - o.y, -o.z)
def foot_walk(phase):
    """ข้อเท้า (y, z) และมุมเท้า ตามเฟส 0–1 แบบส้น–ปลายเท้า (heel-to-toe)
    ช่วงแตะพื้น: จุดที่แตะพื้น (ส้น → ทั้งเท้า → ปลายเท้า) เลื่อนถอยหลังด้วยความเร็วคงที่ = ความเร็วเดิน → ไม่ไถล ไม่ลอย ไม่จม"""
    if phase < STANCE:
        u = phase / STANCE
        flat_y = -STRIDE / 2 + STRIDE * u            # ตำแหน่งข้อเท้าถ้าเท้าราบ (เคลื่อนที่คงที่)
        if u < STRIKE:                               # ส้นแตะพื้น แล้วค่อย ๆ วางฝ่าเท้า (หมุนรอบส้น)
            e = smooth01(u / STRIKE); pitch = PITCH_STRIKE * (1 - e)
            y, z = ankle_from_pivot(flat_y + HEEL.y, HEEL, pitch)
        elif u > HEELOFF:                            # ยกส้น ดันด้วยปลายเท้า (หมุนรอบฝ่าเท้าส่วนหน้า)
            e = smooth01((u - HEELOFF) / (1 - HEELOFF)); pitch = PITCH_TOEOFF * e
            y, z = ankle_from_pivot(flat_y + BALL.y, BALL, pitch)
        else:
            y, z, pitch = flat_y, FOOT_Z, 0.0
        return (y, z, pitch)
    # ช่วงก้าว: จากท่าปลายเท้าดัน → แกว่งไปข้างหน้า → ส้นพร้อมแตะ
    u = (phase - STANCE) / (1 - STANCE)
    y0, z0, p0 = foot_walk(STANCE - 1e-6); y1, z1, p1 = foot_walk(0.0)
    y1 += 0.0
    e = smooth01(u)
    y = y0 + ((y1 - STRIDE * 0) - y0) * e
    z = z0 + (z1 - z0) * e + 0.085 * math.sin(math.pi * u)
    pitch = p0 + (p1 - p0) * smooth01(min(1, u * 1.3))
    return (y, z, pitch)
REST_FOOT = {s: IKT[s].matrix_world.copy() for s in 'LR'}
def set_foot(s, y, z, pitch=0.0, yaw=0.0, x=None):
    sx = 1 if s == 'L' else -1
    M = Matrix.Translation((sx * 0.095 if x is None else x, y, z)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(pitch, 4, 'X') @ REST_FOOT[s].to_3x3().to_4x4()
    IKT[s].matrix_world = M
    POLE[s].location = (sx * 0.095 + math.sin(yaw) * 0.8, -0.8 * math.cos(yaw), 0.55)
def rot(pb, x=0.0, y=0.0, z=0.0):
    arm.pose.bones[pb].rotation_quaternion = Euler((x, y, z), 'XYZ').to_quaternion()
def loc(pb, x=0.0, y=0.0, z=0.0):
    arm.pose.bones[pb].location = (x, y, z)
def reset_pose():
    for pb in arm.pose.bones: pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0)

DEFORM = [b.name for b in arm_data.bones]
def capture(frames, poser):
    """เรียก poser(f) แล้วเก็บเมทริกซ์ท้องถิ่นของทุกกระดูก (รวมผล IK)"""
    out = []
    for f in range(frames + 1):
        reset_pose(); poser(f); bpy.context.view_layer.update()
        row = {}
        for n in DEFORM:
            pb = arm.pose.bones[n]
            row[n] = arm.convert_space(pose_bone=pb, matrix=pb.matrix, from_space='POSE', to_space='LOCAL').copy()
        out.append(row)
    return out

def walk_pose(f):
    t = (f % WALK_FRAMES) / WALK_FRAMES
    for sd, off in (('L', 0.0), ('R', 0.5)):
        y, z, p = foot_walk((t + off) % 1.0); set_foot(sd, y, z, p)
    c1 = math.cos(2 * math.pi * t); c2 = math.cos(4 * math.pi * t)
    loc('hips', 0, 0.012 * -c2 - 0.045, 0)              # เข่างอเล็กน้อยตลอดการเดิน + สะโพกขึ้น–ลง 2 ครั้งต่อรอบ (แกน Y ของกระดูก = แนวตั้ง)
    # ท่าตั้งตรง: สะโพกและอกเอนไปด้านหน้าเล็กน้อย (บวก = เอนไปข้างหน้า) · สะโพกบิดตามขาข้างที่ก้าวหน้า
    rot('hips', 0.04, -0.08 * c1, 0.03 * math.sin(2 * math.pi * t))
    rot('spine', 0.03, 0.03 * c1, 0)
    rot('chest', 0.04, 0.1 * c1, 0)                     # อกบิดสวนสะโพก
    rot('neck', -0.03, 0, 0); rot('head', -0.04, -0.04 * c1, 0)
    # แขนแกว่งสวนขา: t=0 เท้าซ้ายอยู่หน้าสุด → แขนขวาอยู่หน้าสุด แขนซ้ายอยู่หลังสุด (บวก = แขนไปด้านหลัง)
    A = 0.38
    rot('upperarm.L', A * c1, 0, 0.05); rot('upperarm.R', -A * c1, 0, -0.05)
    rot('forearm.L', -0.22 - 0.2 * max(0, -c1), 0, 0); rot('forearm.R', -0.22 - 0.2 * max(0, c1), 0, 0)
def idle_pose(f):
    t = f / 90
    for s in 'LR': set_foot(s, 0.0 if s == 'L' else 0.03, FOOT_Z, 0.0, yaw=0.08 if s == 'L' else -0.08, x=(0.11 if s == 'L' else -0.11))
    loc('hips', 0.012 * math.sin(2 * math.pi * t), -0.022, 0)
    rot('chest', 0.025 * math.sin(4 * math.pi * t), 0, 0)    # หายใจ
    rot('head', -0.02, 0.06 * math.sin(2 * math.pi * t), 0)
    rot('upperarm.L', 0.04 * math.sin(2 * math.pi * t + 1), 0, 0.06); rot('upperarm.R', 0.04 * math.sin(2 * math.pi * t), 0, -0.06)
    rot('forearm.L', -0.15, 0, 0); rot('forearm.R', -0.15, 0, 0)
def turn_pose(f):
    t = (f % 30) / 30   # ก้าวสลับเท้าอยู่กับที่ (ตัวหมุนจากโค้ดในเว็บ) — เท้าแต่ละข้างยก 1 ครั้งต่อรอบ
    for s, off in (('L', 0.0), ('R', 0.5)):
        u = (t + off) % 1.0
        lift = 0.06 * math.sin(math.pi * min(1, u / 0.45)) if u < 0.45 else 0.0
        set_foot(s, 0.0, FOOT_Z + lift, -0.15 * (lift > 0.01), x=(0.105 if s == 'L' else -0.105))
    loc('hips', 0.01 * math.sin(2 * math.pi * t), -0.035, 0)
    rot('chest', 0.02, 0.05 * math.sin(2 * math.pi * t), 0)
    rot('upperarm.L', 0.1 * math.sin(2 * math.pi * t), 0, 0.05); rot('upperarm.R', -0.1 * math.sin(2 * math.pi * t), 0, -0.05)
    rot('forearm.L', -0.25, 0, 0); rot('forearm.R', -0.25, 0, 0)

clips = {'Walk': capture(WALK_FRAMES, walk_pose), 'Idle': capture(90, idle_pose), 'Turn': capture(30, turn_pose)}
# ตรวจ: เท้าที่แตะพื้นเลื่อนด้วยความเร็วคงที่ และอยู่ระดับพื้น
remove_constraints()
for o in list(IKT.values()) + list(POLE.values()): bpy.data.objects.remove(o)
reset_pose()

ad = arm.animation_data_create()
for name, frames in clips.items():
    act = bpy.data.actions.new(name); ad.action = act
    for f, row in enumerate(frames):
        for n, M in row.items():
            pb = arm.pose.bones[n]; pb.matrix_basis = M
            pb.keyframe_insert('location', frame=f + 1); pb.keyframe_insert('rotation_quaternion', frame=f + 1)
    tr = ad.nla_tracks.new(); tr.name = name
    tr.strips.new(name, 1, act); ad.action = None
bpy.ops.object.mode_set(mode='OBJECT')

# ตรวจการไถลของเท้า: ประเมินตำแหน่งข้อเท้าซ้ายช่วงแตะพื้นจากแอนิเมชันที่ bake แล้ว
ad.action = bpy.data.actions['Walk']
contact = []  # จุดต่ำสุดของรองเท้าซ้ายทุกเฟรมช่วงแตะพื้น (ควรเป็น 0) และความเร็วจุดสัมผัส
dg = bpy.context.evaluated_depsgraph_get()
for f in range(1, int(WALK_FRAMES * STANCE) + 1):
    scene.frame_set(f); dg = bpy.context.evaluated_depsgraph_get()
    pb = arm.pose.bones['foot.L']; M = arm.matrix_world @ pb.matrix
    pts = [M @ (pb.bone.matrix_local.inverted() @ (arm_data.bones['foot.L'].head_local + Vector((0.095 * 0, dy, -FOOT_Z + 0.0)))) for dy in (0.085, -0.13)]
    low = min(pts, key=lambda q: q.z); contact.append((round(low.y, 4), round(low.z, 4)))
print('CONTACT', contact)
ys = []; zs = []
for f in range(1, int(WALK_FRAMES * STANCE) + 1):
    scene.frame_set(f); p = arm.matrix_world @ arm.pose.bones['foot.L'].head; ys.append(p.y); zs.append(p.z)
vel = [(ys[i + 1] - ys[i]) * FPS for i in range(len(ys) - 1)]
ad.action = None
check = {'walkSpeed': WALK_SPEED, 'contactZmin': min(c[1] for c in contact), 'contactZmax': max(c[1] for c in contact), 'pole': best}
arm['walkSpeed'] = WALK_SPEED; arm['note'] = 'NEXZA simulated person — not real tracking data'

tris = sum(len(o.data.polygons) for o in (body, bag, *joined))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.object.select_all(action='DESELECT')
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_animation_mode='NLA_TRACKS', export_extras=True, export_yup=True,
                          export_def_bones=False, export_skins=True, export_morph=False)
print('RESULT', json.dumps({'out': OUT, 'faces': tris, 'bones': len(arm_data.bones), **check}))
