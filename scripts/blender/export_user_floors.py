"""
แปลงโมเดลรายชั้นของผู้ใช้ (Fortune_3D_Output/color_symbol_v2/models/Fortune_<ชั้น>_v2.blend) เป็น GLB สำหรับแอป
ไม่แก้ไขรูปทรง สี วัสดุ หรือป้าย/สัญลักษณ์ใด ๆ — ส่งออกเฉพาะวัตถุที่แสดงผล
ไม่รวมคอลเลกชัน Reference (ภาพอ้างอิงที่ซ่อนไว้) และ Presentation (กล้อง/แสงสำหรับเรนเดอร์)

พิกัด: ใช้ระบบของสคริปต์ต้นฉบับ (build_floors.py / build_office.py)
  ห้าง:      X = (sx·2000/5966 − 1000)·0.1,  Y = (336.5 − sy·673/2009)·0.1   (sx, sy = พิกเซลภาพต้นฉบับ)
  สำนักงาน:  X = (sx − 770)·0.05,           Y = (460 − sy)·0.05
GLB ส่งออกแบบ Y-up: three.x = X, three.y = Z, three.z = −Y

  python scripts/blender/export_user_floors.py <โฟลเดอร์ models> <โฟลเดอร์ปลายทาง>
"""
import hashlib
import json
import os
import sys

import bpy

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
SRC, DST = argv[0], argv[1]
os.makedirs(DST, exist_ok=True)
SKIP = ('_Reference', '_Presentation')

manifest = {}
files = sorted(f for f in os.listdir(SRC) if f.endswith('_v2.blend'))
for fn in files:
    key = fn[len('Fortune_'):-len('_v2.blend')]
    bpy.ops.wm.open_mainfile(filepath=os.path.join(SRC, fn))
    sc = bpy.data.scenes.get(f'Floor_{key}') or bpy.context.scene
    bpy.context.window.scene = sc
    keep = []
    for o in sc.objects:
        cols = [c.name for c in o.users_collection]
        if any(c.endswith(SKIP) for c in cols):
            continue
        if o.type not in ('MESH', 'CURVE', 'FONT'):
            continue
        if o.hide_render:
            continue
        keep.append(o)
    for o in sc.objects:
        o.select_set(False)
    for o in keep:
        o.hide_set(False)
        o.select_set(True)
    out = os.path.join(DST, f'floor-{key}.glb')
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=True, export_yup=True,
        export_apply=True, export_materials='EXPORT', export_image_format='AUTO',
        export_extras=False, export_cameras=False, export_lights=False,
    )
    # ลายเซ็นรูปทรง (ใช้ตรวจว่าโมเดลสำนักงานแต่ละชั้นเหมือนกันหรือไม่)
    h = hashlib.sha256()
    for o in sorted(keep, key=lambda x: x.name):
        if o.type == 'MESH':
            m = o.matrix_world
            for v in o.data.vertices:
                w = m @ v.co
                h.update(f'{w.x:.3f},{w.y:.3f},{w.z:.3f};'.encode())
            h.update(','.join(s.material.name.split('.')[0].split('_', 1)[-1] if s.material else '' for s in o.material_slots).encode())
    xs = [];ys = [];zs = []
    from mathutils import Vector
    for o in keep:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    manifest[key] = {
        'file': f'floor-{key}.glb', 'source_blend': fn, 'objects': len(keep),
        'bytes': os.path.getsize(out), 'geometry_hash': h.hexdigest()[:16],
        'bbox': [round(min(xs), 3), round(max(xs), 3), round(min(ys), 3), round(max(ys), 3), round(min(zs), 3), round(max(zs), 3)],
        'source': sc.get('source'),
    }
    print('EXPORTED', key, manifest[key])

json.dump(manifest, open(os.path.join(DST, 'manifest.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
