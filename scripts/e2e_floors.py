"""
ตรวจความสอดคล้องของ "ชั้นที่กำลังดู" กับ "จุดที่เลือก" ทุกชั้น ทั้งโมเดล 3D และผัง 2D (Playwright + Chromium)

  npm run build && npm run preview
  python scripts/e2e_floors.py [http://localhost:4173] [โฟลเดอร์ผลลัพธ์]

สร้างไฟล์ floor-check.md (ตารางผลรายชั้น) และ floor-check.json ในโฟลเดอร์ผลลัพธ์
"""
import json, os, re, sys, random
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'e2e-floors'
os.makedirs(OUT, exist_ok=True)
RUN = f'floors{random.randint(1000, 9999)}'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
results = []

SETTLED = "() => { const sc = window.__iotFortune?.app?.scene; return !sc || ([...sc.floorGroups.values()].every(g => !g.anim) && !sc.tween); }"


def settle(page, timeout=10000):
    """รอให้การเคลื่อนย้ายชั้นและกล้องจบ (เครื่องทดสอบที่ไม่มี GPU วาดเฟรมช้า)"""
    page.wait_for_function(SETTLED, timeout=timeout)
    page.wait_for_timeout(150)


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


def obsolete(name, reason):
    """Obsolete/N/A — ผลคาดหวังตามข้อกำหนดเก่า ไม่นับ Pass/Fail"""
    results.append((name, None, reason))
    print(f'OBSOLETE/N/A {name} — {reason}', flush=True)


# อ่านสถานะทุกส่วนของหน้าจอในครั้งเดียว (atomic)
SNAP = r"""() => {
  const a = window.__iotFortune.app, st = a.state, sc = a.scene;
  const idOf = (label) => (label || '').match(/\(([A-Z]+-[^)]+)\)/)?.[1] ?? null;  // รองรับ P-… และ WL-…
  const q = (s) => document.querySelector(s);
  const out = {
    floorId: st.floorId, isolated: st.isolated, viewMode: st.viewMode, viewing: a.viewingFloorId(), selectedId: st.selectedId,
    dropdown: q('select[data-focus-key="floor"]')?.value ?? null,
    banner: q('.floor-banner')?.innerText ?? '',
    sceneIso: sc ? sc.isolated : null,
    markers3d: sc && st.viewMode === '3d' ? [...sc.markerObjs.entries()].filter(([, o]) => o.visible && !o.btn.hidden).map(([id]) => id).sort() : null,
    sel3d: sc && st.viewMode === '3d' ? [...sc.markerObjs.entries()].filter(([, o]) => o.btn.classList.contains('selected') && o.visible).map(([id]) => id) : null,
    ring3d: sc && st.viewMode === '3d' ? [...sc.markerObjs.entries()].filter(([, o]) => o.ring.visible).map(([id]) => id) : null,
    markers2d: st.viewMode === '2d' ? [...document.querySelectorAll('.plan-host .plan-marker')].map((g) => idOf(g.getAttribute('aria-label'))).sort() : null,
    sel2d: st.viewMode === '2d' ? [...document.querySelectorAll('.plan-host .plan-marker.selected')].map((g) => idOf(g.getAttribute('aria-label'))) : null,
    rows: [...document.querySelectorAll('.points-table tbody tr[data-focus-key^="row-"]')].map((r) => r.dataset.focusKey.slice(4)).sort(),
    rowSel: [...document.querySelectorAll('.points-table tbody tr[aria-selected="true"]')].map((r) => r.dataset.focusKey.slice(4)),
    tableFloor: q('[data-testid="table-floor"]')?.textContent ?? null,
    detailsPid: q('.details .details-head .pid')?.textContent ?? null,
    detailsName: q('.details .details-head h2')?.textContent ?? null,
    detailsLoc: [...document.querySelectorAll('.details dl.meta dt')].find((d) => d.textContent === 'ตำแหน่ง')?.nextElementSibling?.textContent ?? null,
    detailsEmpty: q('[data-testid="details-empty"]')?.innerText ?? null,
    trends: q('.trends .card-head h2')?.textContent ?? null,
  };
  if (st.selectedId) {
    const p = a.index.points.get(st.selectedId);
    out.selFloor = p?.floorId;
    out.selName = p?.name;
    out.selFloorName = a.floorName(p?.floorId);
    const m = p?.metrics[0];
    const e = a.engine.entry(p.id, m.id);
    out.selValue = e?.lastValid?.value ?? null;
    out.detailsValue = q('.details .metric-card .metric-value')?.childNodes[0]?.textContent ?? null;
    out.selMetricKind = m.kind;
    out.selStates = m.states ?? null;
  }
  return out;
}"""


def expected_points(cfg, fid):
    return sorted(p['id'] for p in cfg if p['floor'] == fid)


def verify(s, fid, fname, cfg, mode):
    """ตรวจกติกาทั้งหมดของหน้าจอเทียบกับชั้นที่เลือก คืนรายการปัญหา"""
    exp = expected_points(cfg, fid)
    probs = []
    if s['viewing'] != fid: probs.append(f"viewing={s['viewing']}")
    if s['dropdown'] != fid: probs.append(f"dropdown={s['dropdown']}")
    if f'กำลังดู: {fname}' not in s['banner']: probs.append('banner')
    if mode == '3d' and s['sceneIso'] != fid: probs.append(f"scene={s['sceneIso']}")
    markers = s['markers3d'] if mode == '3d' else s['markers2d']
    if markers != exp: probs.append(f'markers {markers}≠{exp}')
    if s['rows'] != exp: probs.append(f"rows {s['rows']}≠{exp}")
    if s['tableFloor'] != fname: probs.append(f"tableFloor={s['tableFloor']}")
    if s['selectedId']:
        if s['selFloor'] != fid: probs.append(f"selected {s['selectedId']} on {s['selFloor']}")
        if s['detailsPid'] is None or s['selectedId'] not in s['detailsPid']: probs.append('details-id')
        if s['detailsLoc'] is None or not s['detailsLoc'].startswith(s['selFloorName']): probs.append(f"details-floor {s['detailsLoc']}")
    else:
        if s['detailsPid']: probs.append(f"stale details {s['detailsPid']}")
        if not exp and (s['detailsEmpty'] is None or 'ยังไม่มีจุดตรวจวัดในชั้นนี้' not in s['detailsEmpty']): probs.append('empty-floor-message')
        if s['trends'] and ':' in s['trends']: probs.append(f"stale trend {s['trends']}")
        hl = (s['sel3d'] or []) + (s['ring3d'] or []) + (s['sel2d'] or []) + s['rowSel']
        if hl: probs.append(f'stale highlight {hl}')
    return probs


def value_matches(s):
    if s.get('selValue') is None:
        return s.get('detailsValue') in (None, 'ยังไม่มีข้อมูล')
    dv = s.get('detailsValue') or ''
    if s['selMetricKind'] == 'discrete':
        label = next((x['label'] for x in s['selStates'] if x['value'] == s['selValue']), s['selValue'])
        return dv.strip() == label
    num = float(re.sub(r'[^\d.\-]', '', dv.split(' ')[0].replace(',', '')) or 'nan')
    return abs(num - float(s['selValue'])) < 0.051 + abs(float(s['selValue'])) * 1e-9


def select_floor(page, fid, wait=1400):
    page.locator('select[data-focus-key="floor"]').select_option(fid)
    page.wait_for_timeout(min(wait, 400))
    settle(page)


with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS)
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Bangkok')
    page = ctx.new_page()
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.goto(f'{BASE}/?db={RUN}')
    page.wait_for_selector('.marker-layer .marker')
    page.wait_for_timeout(1200)
    floors = page.evaluate('() => window.__iotFortune.ctl.config.building.floors.map(f => ({ id: f.id, name: f.name, shared: !!f.plan.shared }))')
    cfg = page.evaluate('() => window.__iotFortune.ctl.config.points.filter(p => p.status === "active").map(p => ({ id: p.id, floor: p.floorId, name: p.name }))')
    cfg_before = page.evaluate('() => JSON.stringify(window.__iotFortune.ctl.config.points)')
    num = lambda pid: page.evaluate(f'() => window.__iotFortune.app.numberOf("{pid}")')

    # เริ่มจากเคสที่รายงาน: เลือก P-007 (ชั้น 12) ในมุมมองทั้งอาคาร แล้วเลือกชั้น 31
    page.locator('tr[data-focus-key="row-P-007"]').click()
    page.wait_for_timeout(600)
    select_floor(page, '31')
    s = page.evaluate(SNAP)
    probs = verify(s, '31', 'ชั้น 31 (สำนักงาน)', cfg, '3d')
    check('เคสที่รายงาน: เลือก P-007 แล้วเปลี่ยนเป็นชั้น 31 → ล้างการเลือก แสดง "ยังไม่มีจุดตรวจวัดในชั้นนี้"', not probs and s['selectedId'] is None, '; '.join(probs))
    page.screenshot(path=f'{OUT}/a-floor31-empty.png')

    report = []
    detail_rep = []
    for mode in ('3d', '2d'):
        page.locator(f'button[data-focus-key="vm-{mode}"]').click()
        page.wait_for_timeout(1200)
        for f in floors:
            fid, fname = f['id'], f['name']
            select_floor(page, fid, 1500 if mode == '3d' else 600)
            s = page.evaluate(SNAP)
            probs = verify(s, fid, fname, cfg, mode)
            if mode == '3d':  # โมเดลรายละเอียดของชั้นที่เลือก (Lazy Loading) — ตรวจครบทุกชั้น
                try:
                    page.wait_for_function(f"() => ['ready', 'none', 'error'].includes(window.__iotFortune.app.scene.detailState('{fid}'))", timeout=240000, polling=500)
                except Exception:
                    pass
                d = page.evaluate(f"""() => {{ const sc = window.__iotFortune.app.scene; const g = sc.floorGroups.get('{fid}');
                  return {{ state: sc.detailState('{fid}'), hasFile: !!g.floor.detail, model: !!g.detailObj, rooms: Array.isArray(g.rooms) ? g.rooms.length : null }}; }}""")
                detail_rep.append({'floor': fid, **d})
                if d['hasFile'] and not (d['state'] == 'ready' and d['model'] and (d['rooms'] or 0) > 0): probs.append(f"detail {d}")
                if not d['hasFile'] and d['state'] != 'none': probs.append(f"detail {d}")
            exp = expected_points(cfg, fid)
            clicked = []
            for pid in exp:  # คลิกหมุดทุกจุดของชั้น แล้วตรวจรหัส ชั้น ชื่อ ค่า
                n = num(pid)
                if mode == '3d':
                    page.locator(f'.marker-layer .marker[aria-label^="{n}. "]').click()
                else:
                    page.locator(f'.plan-host .plan-marker[aria-label^="{n}. "]').click()
                page.wait_for_timeout(350)
                s2 = page.evaluate(SNAP)
                pr = verify(s2, fid, fname, cfg, mode)
                if s2['selectedId'] != pid: pr.append(f"clicked {pid} got {s2['selectedId']}")
                if s2['detailsName'] != s2.get('selName'): pr.append('details-name')
                if not value_matches(s2): pr.append(f"value {s2.get('detailsValue')} vs {s2.get('selValue')}")
                hl = (s2['sel3d'] if mode == '3d' else s2['sel2d']) or []
                if hl != [pid] or s2['rowSel'] != [pid]: pr.append(f"highlight {hl}/{s2['rowSel']}")
                clicked.append(pid)
                probs += [f'{pid}: {x}' for x in pr]
            report.append({'mode': mode, 'floor': fid, 'name': fname, 'shared': f['shared'], 'expected': exp,
                           'markers': s['markers3d'] if mode == '3d' else s['markers2d'], 'rows': s['rows'],
                           'clicked': clicked, 'problems': probs})
            if probs: print('   ', mode, fid, probs)
            if mode == '3d' and fid in ('12', '31', '5'):
                page.screenshot(path=f'{OUT}/b-{mode}-floor-{fid}.png')
            if mode == '2d' and fid in ('G', '12'):
                page.screenshot(path=f'{OUT}/b-{mode}-floor-{fid}.png')
        if mode == '3d':
            withf = [d for d in detail_rep if d['hasFile']]
            okd = [d for d in withf if d['state'] == 'ready' and d['model'] and (d['rooms'] or 0) > 0]
            check(f'3D: เลือกชั้นแล้วโหลดโมเดลรายละเอียด + ห้อง ครบ {len(withf)} ชั้นที่มีไฟล์ (ชั้นไม่มีไฟล์ใช้โมเดลแบบง่าย: {[d["floor"] for d in detail_rep if not d["hasFile"]]})',
                  len(okd) == len(withf) == 27, f"{len(okd)}/{len(withf)} · ห้องรวม {sum(d['rooms'] or 0 for d in okd)}")
        bad = [r for r in report if r['mode'] == mode and r['problems']]
        check(f'{mode.upper()}: ทุก {len(floors)} ชั้น dropdown/ป้าย/โมเดล/หมุด/รายการ/รายละเอียดตรงกัน และคลิกหมุดได้ข้อมูลจริง', not bad,
              '; '.join(f"{r['floor']}: {r['problems'][:2]}" for r in bad[:4]))

        # มีจุด → ไม่มีจุด → กลับชั้นเดิม
        seq_probs = []
        for has, empty in (('G', '6' if any(f['id'] == '6' for f in floors) else '31'), ('12', '31'), ('2', '20')):
            select_floor(page, has, 1200 if mode == '3d' else 500)
            pid = expected_points(cfg, has)[0]
            n = num(pid)
            (page.locator(f'.marker-layer .marker[aria-label^="{n}. "]') if mode == '3d' else page.locator(f'.plan-host .plan-marker[aria-label^="{n}. "]')).click()
            page.wait_for_timeout(300)
            a = page.evaluate(SNAP)
            if a['selectedId'] != pid: seq_probs.append(f'{has}: select {pid}')
            select_floor(page, empty, 1200 if mode == '3d' else 500)
            b = page.evaluate(SNAP)
            seq_probs += [f'{empty}: {x}' for x in verify(b, empty, next(f['name'] for f in floors if f['id'] == empty), cfg, mode)]
            if b['selectedId'] is not None: seq_probs.append(f'{empty}: selection kept {b["selectedId"]}')
            select_floor(page, has, 1200 if mode == '3d' else 500)
            c = page.evaluate(SNAP)
            seq_probs += [f'{has}(back): {x}' for x in verify(c, has, next(f['name'] for f in floors if f['id'] == has), cfg, mode)]
        check(f'{mode.upper()}: ชั้นมีจุด → ไม่มีจุด → กลับชั้นเดิม ล้างการเลือก/กราฟ/ไฮไลต์ถูกต้อง', not seq_probs, '; '.join(seq_probs[:4]))

    # คลิกแจ้งเตือนข้ามชั้น (ดูชั้น 31 อยู่ → เหตุที่ชั้น 2)
    page.locator('button[data-focus-key="vm-3d"]').click()
    page.wait_for_timeout(800)
    select_floor(page, '31')
    page.locator('select[data-focus-key="scenario"]').select_option('leak')
    page.locator('button[data-focus-key="speed-60"]').click()
    page.wait_for_function('() => window.__iotFortune.ctl.engine.episodes().some(e => e.pointId === "P-008" && !e.recoveredAt)', timeout=30000)
    s = page.evaluate(SNAP)
    check('ระหว่างข้อมูลจำลองอัปเดต ยังดูชั้น 31 อยู่ ไม่มีการเลือกจุดชั้นอื่นแทรก', not verify(s, '31', 'ชั้น 31 (สำนักงาน)', cfg, '3d'))
    page.locator('button[data-focus-key="nav-alerts"]').click()
    page.wait_for_selector('.episode .open-floor')
    page.locator('.episode', has_text='P-008').first.locator('.open-floor').click()
    page.wait_for_timeout(1800)
    s = page.evaluate(SNAP)
    zoom = page.evaluate('''() => { const sc = window.__iotFortune.app.scene, o = sc.markerObjs.get("P-008"); const w = sc.root.localToWorld(o.sphere.position.clone());
      return { d: +sc.camera.position.distanceTo(w).toFixed(2), t: +sc.controls.target.distanceTo(w).toFixed(3) } }''')
    probs = verify(s, '2', 'ชั้น 2', cfg, '3d')
    check('คลิกแจ้งเตือนข้ามชั้น → ไปชั้นจริงของจุด (ชั้น 2) เลือก P-008 และซูมที่จุด',
          not probs and s['selectedId'] == 'P-008' and zoom['t'] < 0.05 and zoom['d'] < 9, f'{probs} {zoom}')
    page.screenshot(path=f'{OUT}/c-alert-cross-floor.png')

    # toast "เปิดชั้นที่เกิดเหตุ" ข้ามชั้น (ดูชั้น G → เหตุที่ชั้น 12)
    page.locator('select[data-focus-key="scenario"]').select_option('normal')
    select_floor(page, 'G')
    page.locator('select[data-focus-key="scenario"]').select_option('room-hot')
    page.wait_for_selector('.toast:has-text("ELEC")', timeout=60000)
    page.locator('.toast:has-text("ELEC")').first.get_by_role('button', name='เปิดชั้นที่เกิดเหตุ').click()
    page.wait_for_timeout(1800)
    s = page.evaluate(SNAP)
    probs = verify(s, '12', 'ชั้น 12 (สำนักงาน)', cfg, '3d')
    check('กด "เปิดชั้นที่เกิดเหตุ" จาก toast → ชั้น 12 เลือก P-007', not probs and s['selectedId'] == 'P-007', '; '.join(probs))
    page.locator('select[data-focus-key="scenario"]').select_option('normal')

    # สลับชั้นเร็ว ๆ ขณะข้อมูลจำลองอัปเดต 60×
    seq = ['G', '12', '31', '2', '11', '5', '3', '20', '1', '12']
    for fid in seq:
        page.locator('select[data-focus-key="floor"]').select_option(fid)
        page.wait_for_timeout(250)
    page.wait_for_timeout(1600)
    s = page.evaluate(SNAP)
    probs = verify(s, '12', 'ชั้น 12 (สำนักงาน)', cfg, '3d')
    check('สลับชั้นต่อเนื่องเร็ว ๆ ระหว่างข้อมูลอัปเดต → สถานะสุดท้ายตรงกันทั้งหมด', not probs, '; '.join(probs))

    # รีเฟรชหน้า — ข้อกำหนด Performance (v1.8.1 Lazy Loading): เปิดที่มุมทั้งอาคารเสมอ ไม่คืนชั้นเดี่ยวที่ดูค้างไว้
    obsolete('รีเฟรชหน้า → กลับมาที่ชั้น 12 พร้อม P-007', 'ข้อกำหนดเก่า — ปัจจุบันรีเฟรชแล้วเปิดมุมทั้งอาคารเสมอ (ตรวจแทนด้วยข้อถัดไป)')
    obsolete('รีเฟรชด้วยค่าที่บันทึกไม่สอดคล้อง (ชั้น 31 + P-007) → แสดงชั้น 31 และล้างการเลือก', 'ข้อกำหนดเก่า — ปัจจุบันไม่คืนชั้นที่บันทึกไว้ (ตรวจแทนด้วยข้อถัดไป)')
    all_pts = sorted(p['id'] for p in cfg)

    def building_probs(s):
        pr = []
        if s['viewing'] is not None: pr.append(f"viewing={s['viewing']}")
        if s['sceneIso'] is not None: pr.append(f"scene={s['sceneIso']}")
        if s['dropdown'] not in ('', None): pr.append(f"dropdown={s['dropdown']}")
        if 'ทั้งอาคาร' not in s['banner']: pr.append('banner')
        if s['markers3d'] != all_pts: pr.append(f"markers {s['markers3d']}≠{all_pts}")
        if s['rows'] != all_pts: pr.append(f"rows {s['rows']}≠{all_pts}")
        if s['selectedId'] and s['selectedId'] not in all_pts: pr.append(f"selected {s['selectedId']} ไม่มีอยู่")
        return pr
    n = num('P-007')
    page.locator(f'.marker-layer .marker[aria-label^="{n}. "]').click()
    page.wait_for_timeout(400)
    page.reload()
    page.wait_for_selector('.floor-banner')
    page.wait_for_timeout(2000)
    s = page.evaluate(SNAP)
    probs = building_probs(s)
    check('รีเฟรชหน้า → เปิดมุมทั้งอาคาร หมุด/รายการครบทุกจุด ไม่ค้างชั้นเดิม (ข้อกำหนดปัจจุบัน)', not probs, '; '.join(probs))
    # ค่าที่บันทึกไว้ไม่สอดคล้อง (เช่นจากรุ่นก่อน): ชั้น 31 + P-007 → ต้องไม่ค้าง/ไม่ error และเปิดมุมทั้งอาคาร
    page.evaluate('''async () => { const c = window.__iotFortune.ctl; await c.repo.putKV("ui", { ...c.ui, floorId: "31", isolated: true, viewMode: "3d", selectedId: "P-007", view: "overview" }); }''')
    page.reload()
    page.wait_for_selector('.floor-banner')
    page.wait_for_timeout(2000)
    s = page.evaluate(SNAP)
    probs = building_probs(s)
    check('รีเฟรชด้วยค่าที่บันทึกไม่สอดคล้อง (ชั้น 31 + P-007) → เปิดมุมทั้งอาคารได้ปกติ ไม่ค้างค่าเก่า (ข้อกำหนดปัจจุบัน)', not probs, '; '.join(probs))
    page.screenshot(path=f'{OUT}/d-reload-inconsistent-fixed.png')

    cfg_after = page.evaluate('() => JSON.stringify(window.__iotFortune.ctl.config.points)')
    check('ข้อมูลจุดไม่ถูกย้าย/คัดลอกระหว่างการทดสอบ (การตั้งค่าเหมือนเดิมทุกไบต์)', cfg_before == cfg_after)
    check('ไม่มี console error', not logs, '; '.join(logs[:3]))
    browser.close()

# ตารางผลรายชั้น
lines = ['| มุมมอง | ชั้น | ผัง | จุดที่ควรมี | หมุดที่แสดง | รายการ | คลิกตรวจ | ผล |', '|---|---|---|---|---|---|---|---|']
for r in report:
    lines.append(f"| {r['mode'].upper()} | {r['name']} | {'ผังอ้างอิงร่วม' if r['shared'] else 'ผังชั้นนี้'} | {', '.join(r['expected']) or '—'} | "
                 f"{', '.join(str(x) for x in (r['markers'] or [])) or '—'} | {', '.join(r['rows']) or '—'} | {', '.join(r['clicked']) or '—'} | {'ผ่าน' if not r['problems'] else 'ไม่ผ่าน: ' + '; '.join(r['problems'][:2])} |")
summary = [f"| {'Obsolete/N/A' if ok is None else ('ผ่าน' if ok else 'ไม่ผ่าน')} | {name} | {detail} |" for name, ok, detail in results]
md = '# ผลตรวจรายชั้น\n\n' + '\n'.join(lines) + '\n\n## เส้นทางอื่น\n\n| ผล | รายการ | หมายเหตุ |\n|---|---|---|\n' + '\n'.join(summary) + '\n'
open(f'{OUT}/floor-check.md', 'w', encoding='utf-8').write(md)
json.dump({'floors': report, 'checks': results}, open(f'{OUT}/floor-check.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
scored = [r for r in results if r[1] is not None]
passed = sum(1 for r in scored if r[1])
print(f'\nสรุป: ผ่าน {passed}/{len(scored)} · Obsolete/N/A {len(results) - len(scored)}  · ชั้นผ่าน {sum(1 for r in report if not r["problems"])}/{len(report)}')
sys.exit(0 if passed == len(scored) else 1)
