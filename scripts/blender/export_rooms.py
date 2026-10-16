"""
ส่งออก "ข้อมูลห้อง/พื้นที่" จากโมเดลรายชั้นของผู้ใช้ (Fortune_<ชั้น>_v2.blend) เพื่อให้กดห้องในหน้าเว็บแล้วแสดงข้อมูลได้
ไม่แก้ไขไฟล์ .blend — อ่านอย่างเดียว

ต่อห้อง/พื้นที่ เก็บ:
  - ชื่อวัตถุ หมวด (คอลเลกชัน) สีวัสดุ ค่าที่บันทึกในวัตถุ (หลักฐาน/หมายเหตุ)
  - รูปทรงพื้นที่บนผัง = สามเหลี่ยมของผิวด้านบน (พิกัด X, Y ใน Blender หน่วยเมตร) ใช้ตรวจว่าจุดที่กดอยู่ในห้องไหน และวาดไฮไลต์
  - พื้นที่โดยประมาณ (ตร.ม.) จากผิวด้านบน — สเกลของโมเดลเป็นค่าประมาณตามที่ระบุในไฟล์
  python scripts/blender/export_rooms.py <โฟลเดอร์ models> <โฟลเดอร์ปลายทาง>
"""
import json
import os
import sys

import bpy
import bmesh

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
SRC, DST = argv[0], argv[1]
os.makedirs(DST, exist_ok=True)

# หมวดที่กดได้ (ผนัง/ป้าย/ขั้นบันไดย่อย ไม่ใช่ "ห้อง")
PICK = {
    'Shops': 'shop', 'Walkways': 'walkway', 'Elevators': 'elevator', 'Escalators': 'escalator',
    'Toilets': 'toilet', 'Exits': 'exit', 'FireStairs': 'stair', 'Floor': 'floor', 'Doors': 'door',
}
SKIP_NAME = ('Tread', 'LiftDivider')

summary = {}
for fn in sorted(f for f in os.listdir(SRC) if f.endswith('_v2.blend')):
    key = fn[len('Fortune_'):-len('_v2.blend')]
    bpy.ops.wm.open_mainfile(filepath=os.path.join(SRC, fn))
    sc = bpy.data.scenes.get(f'Floor_{key}') or bpy.context.scene
    deps = bpy.context.evaluated_depsgraph_get()
    rooms = []
    for o in sc.objects:
        if o.type != 'MESH' or o.hide_render:
            continue
        col = o.users_collection[0].name if o.users_collection else ''
        cat = col.split('_', 1)[1] if '_' in col else col
        if cat not in PICK or any(s in o.name for s in SKIP_NAME):
            continue
        ev = o.evaluated_get(deps)
        me = ev.to_mesh()
        bm = bmesh.new(); bm.from_mesh(me); bm.transform(o.matrix_world)
        bm.normal_update()
        top = max((v.co.z for v in bm.verts), default=0)
        faces = [f for f in bm.faces if abs(f.normal.z) > 0.9 and abs(f.calc_center_median().z - top) < 0.02]
        tris = []; area = 0.0
        for f in faces:
            area += f.calc_area()
            vs = [v.co for v in f.verts]
            for i in range(1, len(vs) - 1):
                for v in (vs[0], vs[i], vs[i + 1]):
                    tris += [round(v.x, 3), round(v.y, 3)]
        bm.free(); ev.to_mesh_clear()
        if not tris:
            continue
        mat = o.active_material
        color = None
        if mat and mat.use_nodes:
            bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if bsdf:
                c = bsdf.inputs['Base Color'].default_value
                color = '#%02x%02x%02x' % tuple(int(max(0, min(1, x)) ** (1 / 2.2) * 255 + 0.5) for x in c[:3])
        props = {k: str(v) for k, v in o.items() if not k.startswith('_') and isinstance(v, (str, int, float, bool))}
        xs = tris[0::2]; ys = tris[1::2]
        rooms.append({
            'id': o.name, 'category': PICK[cat], 'collection': col, 'color': color,
            'area_m2': round(area, 1), 'top_z': round(top, 3),
            'bbox': [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)],
            'props': props, 'tris': tris,
        })
    out = {'floor': key, 'source_blend': fn, 'scene': sc.name, 'source': sc.get('source'),
           'scale_status': sc.get('scale_status'), 'alignment': sc.get('alignment'), 'rooms': rooms}
    with open(os.path.join(DST, f'rooms-{key}.json'), 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    cnt = {}
    for r in rooms:
        cnt[r['category']] = cnt.get(r['category'], 0) + 1
    summary[key] = cnt
    print('ROOMS', key, cnt, flush=True)

json.dump(summary, open(os.path.join(DST, 'rooms-summary.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
