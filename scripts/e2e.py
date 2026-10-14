"""
ตรวจแอปที่ build แล้วผ่านเบราว์เซอร์จริง (Playwright + Chromium)

ต้องมี:  pip install playwright && python -m playwright install chromium
รัน:     npm run build
         npm run preview            (พอร์ต 4173)
         npm run fixture            (พอร์ต 8787 — เซิร์ฟเวอร์ทดสอบ ไม่ใช่อุปกรณ์จริง)
         python scripts/e2e.py [http://localhost:4173] [โฟลเดอร์ภาพหน้าจอ]

ใช้ฐานข้อมูลแยกผ่าน ?db=... จึงไม่กระทบข้อมูลใช้งานจริงในเบราว์เซอร์
"""
import json, os, sys, time, random, urllib.request
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else 'e2e-screenshots'
FIXTURE = 'http://127.0.0.1:8787'
os.makedirs(SHOTS, exist_ok=True)
RUN = f"e2e{random.randint(1000, 9999)}"
results = []
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']

SETTLED = "() => { const sc = window.__iotFortune?.app?.scene; return !sc || ([...sc.floorGroups.values()].every(g => !g.anim) && !sc.tween); }"


def settle(page, timeout=10000):
    """รอให้การเคลื่อนย้ายชั้นและกล้องจบ (เครื่องทดสอบที่ไม่มี GPU วาดเฟรมช้า)"""
    page.wait_for_function(SETTLED, timeout=timeout)
    page.wait_for_timeout(150)


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


def fixture(mode):
    urllib.request.urlopen(f'{FIXTURE}/control?mode={mode}').read()


def wait_until(page, js, timeout=20000, arg=None):
    page.wait_for_function(js, arg=arg, timeout=timeout)


def watch(page, sink):
    page.on('console', lambda m: sink.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: sink.append(f'pageerror: {e}'))
    page.on('requestfailed', lambda r: sink.append(f'requestfailed: {r.url}'))
    page.on('response', lambda r: sink.append(f'http {r.status}: {r.url}') if r.status >= 400 else None)


def no_overflow(page):
    return page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')


def kpi(page, key):
    return int(page.locator(f'button[data-focus-key="kpi-{key}"] .kpi-n').inner_text())


with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS)
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True, timezone_id='Asia/Bangkok')
    page = ctx.new_page()
    logs = []
    watch(page, logs)
    page.goto(f'{BASE}/?db={RUN}')
    page.wait_for_selector('.points-table tbody tr')
    page.wait_for_selector('.marker-layer .marker')
    page.wait_for_timeout(1500)
    page.screenshot(path=f'{SHOTS}/01-desktop-overview.png')

    # 1) เลือกจุดจากหมุด 3D และจากตาราง / สลับชั้นและ 2D/3D แล้วการเลือกยังอยู่
    page.locator('.marker-layer .marker[aria-label^="1. "]').click()
    page.wait_for_timeout(300)
    check('1a เลือกจากหมุด 3D แล้วแผงรายละเอียดแสดงจุดนั้น', 'P-001' in page.locator('.details .pid').first.inner_text())
    check('1b แถวในตารางถูกเลือกตาม', page.locator('tr[data-focus-key="row-P-001"]').get_attribute('aria-selected') == 'true')
    page.locator('tr[data-focus-key="row-P-005"]').click()
    page.wait_for_timeout(300)
    check('1c เลือกจากตาราง แล้วหมุดเดียวกันถูกเน้น', 'selected' in (page.locator('.marker-layer .marker[aria-label^="5. "]').get_attribute('class') or ''))
    check('1d ชั้นเปลี่ยนตามจุดที่เลือก (ชั้น 3)', page.evaluate('() => window.__iotFortune.app.state.floorId') == '3')
    page.locator('button[data-focus-key="vm-2d"]').click()
    page.wait_for_selector('.plan-svg')
    check('1e สลับเป็นผัง 2D แล้วยังเลือก P-005', 'P-005' in page.locator('.details .pid').first.inner_text()
          and page.locator('.plan-marker.selected').count() == 1)
    page.screenshot(path=f'{SHOTS}/02-desktop-2d-plan.png')
    page.locator('select[data-focus-key="floor"]').select_option('G')
    page.wait_for_timeout(300)
    page.locator('.plan-marker[aria-label^="1. "]').focus()
    page.keyboard.press('Enter')
    page.wait_for_timeout(300)
    check('1f ผัง 2D: เลือกหมุดด้วยแป้นพิมพ์ (Tab/Enter)', 'P-001' in page.locator('.details .pid').first.inner_text())
    page.locator('button[data-focus-key="vm-3d"]').click()
    page.wait_for_selector('.marker-layer .marker')
    page.wait_for_timeout(500)
    check('1g กลับเป็น 3D แล้วยังเลือก P-001', 'selected' in (page.locator('.marker-layer .marker[aria-label^="1. "]').get_attribute('class') or ''))
    # คลิก vs ลาก
    box = page.locator('canvas.scene-canvas').bounding_box()
    cx, cy = box['x'] + 60, box['y'] + box['height'] - 60
    page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 120, cy - 40, steps=8); page.mouse.up()
    page.wait_for_timeout(400)
    check('1h ลากหมุนกล้องไม่เปลี่ยนจุดที่เลือก', 'P-001' in page.locator('.details .pid').first.inner_text())

    # 9) มุมมองชั้นเดี่ยว: สลับทุกชั้น (G–5 และสำนักงาน 11–31 รายชั้น)
    page.locator('select[data-focus-key="floor"]').select_option('')
    page.wait_for_timeout(1500)
    SCENE_STATE = """() => { const a = window.__iotFortune.app, sc = a.scene, out = { iso: sc.isolated, groups: 0, markers: {}, rel: {}, fit: true };
      for (const fg of sc.floorGroups.values()) if (fg.group.visible) out.groups++;
      for (const [id, o] of sc.markerObjs) {
        const fg = sc.floorGroups.get(o.item.point.floorId);
        out.markers[id] = { shown: !o.btn.hidden && o.visible, floor: o.item.point.floorId };
        out.rel[id] = [o.sphere.position.x - fg.group.position.x, o.sphere.position.y - fg.group.position.y, o.sphere.position.z - fg.group.position.z].map(v => +v.toFixed(5));
      }
      if (sc.isolated) {
        const fg = sc.floorGroups.get(sc.isolated); const V = fg.slab.position.constructor;
        fg.slab.geometry.computeBoundingBox(); const b = fg.slab.geometry.boundingBox; fg.slab.updateMatrixWorld(true);
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const v = new V(x, y, z).applyMatrix4(fg.slab.matrixWorld).project(sc.camera);
          if (Math.abs(v.x) > 1.02 || Math.abs(v.y) > 1.02) out.fit = false;
          out.minx = Math.min(out.minx ?? 9, v.x); out.maxx = Math.max(out.maxx ?? -9, v.x); out.miny = Math.min(out.miny ?? 9, v.y); out.maxy = Math.max(out.maxy ?? -9, v.y);
        }
        out.span = +Math.max(out.maxx - out.minx, out.maxy - out.miny).toFixed(2);
        out.center = [fg.group.position.x + fg.floor.model.cx, fg.group.position.z + fg.floor.model.cz].map(v => +v.toFixed(3));
      }
      return out; }"""
    building = page.evaluate(SCENE_STATE)
    floors = page.evaluate('() => window.__iotFortune.ctl.config.building.floors.map(f => ({ id: f.id, name: f.name, shared: !!f.plan.shared }))')
    pts = page.evaluate('() => window.__iotFortune.ctl.config.points.filter(p => p.status === "active").map(p => ({ id: p.id, floor: p.floorId }))')
    check('9a มุมมองทั้งอาคารแสดงทุกชั้น', building['iso'] is None and building['groups'] == len(floors), f"groups={building['groups']}/{len(floors)}")
    check('9b ตัวเลือกชั้นสำนักงานแยก 11 … 31 รายชั้น', [f['id'] for f in floors if f['shared']] == [str(n) for n in range(11, 32)])
    bad = []
    for f in floors:
        page.locator('select[data-focus-key="floor"]').select_option(f['id'])
        page.wait_for_timeout(300)
        settle(page)
        st = page.evaluate(SCENE_STATE)
        banner = page.locator('.floor-banner').inner_text()
        on = [p['id'] for p in pts if p['floor'] == f['id']]
        shown = sorted(k for k, v in st['markers'].items() if v['shown'])
        problems = []
        if st['iso'] != f['id']: problems.append(f"iso={st['iso']}")
        if st['groups'] != 1: problems.append(f"groups={st['groups']}")
        if f'กำลังดู: {f["name"]}' not in banner: problems.append('banner')
        if f['shared'] and 'ผังอ้างอิงร่วม' not in banner: problems.append('shared-label')
        if not on and 'ยังไม่มีจุดตรวจวัด' not in banner: problems.append('empty-note')
        if shown != sorted(on): problems.append(f'markers {shown} != {sorted(on)}')
        if not st['fit']: problems.append('camera-fit')
        if st.get('span', 0) < 1.0: problems.append(f"too-far span={st.get('span')}")
        if st['center'] != [-0.3, -2.1]: problems.append(f"center {st['center']}")
        for pid in on:
            if st['rel'][pid] != building['rel'][pid]: problems.append(f'{pid} moved relative to plan')
        if problems: bad.append(f"{f['id']}: {', '.join(problems)}")
        if f['id'] in ('1', '5', '11', '31'):
            page.screenshot(path=f"{SHOTS}/12-isolated-floor-{f['id']}.png")
        for pid in on:  # คลิกหมุดได้
            n = page.evaluate(f'() => window.__iotFortune.app.numberOf("{pid}")')
            page.locator(f'.marker-layer .marker[aria-label^="{n}. "]').click()
            page.wait_for_timeout(250)
            if pid not in page.locator('.details .pid').first.inner_text(): bad.append(f"{f['id']}: click {pid}")
    check(f'9c แยกดูชั้นเดี่ยวครบ {len(floors)} ชั้น: ซ่อนชั้นอื่น อยู่กลางฐาน กล้องเห็นทั้งชั้น ป้ายกำลังดู หมุดตำแหน่งเดิมและคลิกได้', not bad, '; '.join(bad[:6]))
    # ยังหมุน/ซูมได้ในมุมมองเดี่ยว
    page.locator('select[data-focus-key="floor"]').select_option('1')
    page.wait_for_timeout(1800)
    CAM = '() => { const sc = window.__iotFortune.app.scene; return { p: sc.camera.position.toArray(), d: sc.camera.position.distanceTo(sc.controls.target) } }'
    cam0 = page.evaluate(CAM)
    box = page.locator('canvas.scene-canvas').bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2 + 100
    page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 250, cy, steps=12); page.mouse.up()
    page.wait_for_timeout(600)
    cam1 = page.evaluate(CAM)
    page.mouse.move(cx, cy); page.mouse.wheel(0, -500)
    page.wait_for_timeout(800)
    cam2 = page.evaluate(CAM)
    rotated = abs(cam1['p'][0] - cam0['p'][0]) > 1
    zoomed = cam2['d'] < cam1['d'] - 0.3
    check('9d หมุนและซูมได้ในมุมมองชั้นเดี่ยว', rotated and zoomed, f"x {cam0['p'][0]:.2f}→{cam1['p'][0]:.2f}, ระยะ {cam1['d']:.2f}→{cam2['d']:.2f}")
    page.locator('button[data-focus-key="back-building"]').click()
    page.wait_for_timeout(300)
    settle(page)
    back = page.evaluate(SCENE_STATE)
    check('9e "กลับไปดูทั้งอาคาร" ประกอบทุกชั้นกลับตำแหน่งเดิม', back['iso'] is None and back['groups'] == len(floors)
          and 'ทั้งอาคาร' in page.locator('.floor-banner').inner_text()
          and page.evaluate('() => [...window.__iotFortune.app.scene.floorGroups.values()].every(g => g.group.position.distanceTo(g.target) < 1e-3 && Math.abs(g.group.position.x) < 1e-6)'))
    page.screenshot(path=f'{SHOTS}/13-building-reassembled.png')
    page.locator('select[data-focus-key="floor"]').select_option('G')
    page.wait_for_timeout(800)

    # 2) แจ้งเตือนจากเดโมแบบกำหนดได้ → แนวโน้ม → รับทราบพร้อมบันทึก → กลับสู่ปกติแยกกัน
    page.locator('select[data-focus-key="scenario"]').select_option('leak')
    page.locator('button[data-focus-key="speed-60"]').click()
    wait_until(page, '() => Number(document.querySelector(\'button[data-focus-key="kpi-critical"] .kpi-n\')?.textContent) >= 1')
    check('2a สถานการณ์น้ำรั่วทำให้เกิดจุดวิกฤต', kpi(page, 'critical') >= 1)
    page.locator('select[data-focus-key="floor"]').select_option('')  # ทั้งอาคาร → รายการแสดงทุกชั้น
    page.wait_for_timeout(600)
    page.locator('tr[data-focus-key="row-P-008"]').click()
    page.wait_for_selector('.trends .chart-svg', timeout=10000)
    check('2b มีกราฟสถานะของจุดที่เลือก', page.locator('.trends .chart-svg').count() >= 1)
    page.screenshot(path=f'{SHOTS}/03-desktop-leak-alarm.png')
    page.locator('button[data-focus-key="nav-alerts"]').click()
    page.wait_for_selector('.episode.active form.ack-form')
    ep = page.locator('.episode.active', has_text='P-008').first
    ep.locator('input[type=text]').fill('ช่างทดสอบ')
    ep.locator('textarea').fill('ส่งช่างตรวจหน้างานแล้ว')
    ep.locator('button[type=submit]').click()
    page.wait_for_timeout(800)
    ep = page.locator('.episode', has_text='P-008').first
    txt = ep.inner_text()
    check('2c รับทราบแล้วแต่ยังเกิดอยู่ (ไม่ใช่การกลับสู่ปกติ)', 'รับทราบแล้ว' in txt and 'ยังเกิดอยู่' in txt and 'ส่งช่างตรวจหน้างานแล้ว' in txt, txt[:120])
    page.locator('select[data-focus-key="scenario"]').select_option('normal')
    page.locator('button[data-focus-key="af-all"]').click()
    wait_until(page, '() => [...document.querySelectorAll(".episode")].some(e => e.textContent.includes("P-008") && e.textContent.includes("กลับสู่ปกติแล้ว"))')
    txt = page.locator('.episode', has_text='P-008').first.inner_text()
    check('2d กลับสู่ปกติด้วยค่าใหม่ และประวัติการรับทราบยังอยู่', 'กลับสู่ปกติแล้ว' in txt and 'ช่างทดสอบ' in txt)
    page.screenshot(path=f'{SHOTS}/04-desktop-alerts.png')
    # คลิกแจ้งเตือนแล้วเปิดโมเดลเดี่ยวของชั้นที่เกิดเหตุ (P-008 อยู่ชั้น 2)
    page.locator('button[data-focus-key="nav-overview"]').click()
    page.locator('select[data-focus-key="floor"]').select_option('')
    page.wait_for_timeout(1000)
    page.locator('button[data-focus-key="nav-alerts"]').click()
    page.wait_for_selector('.episode .open-floor')
    page.locator('.episode', has_text='P-008').first.locator('.open-floor').click()
    page.wait_for_selector('.floor-banner')
    page.wait_for_timeout(1800)
    st = page.evaluate('''() => { const a = window.__iotFortune.app, sc = a.scene, fg = sc.floorGroups.get('2'), V = fg.slab.position.constructor;
      fg.slab.geometry.computeBoundingBox(); const b = fg.slab.geometry.boundingBox; fg.slab.updateMatrixWorld(true);
      let fit = true, minx = 9, maxx = -9;
      for (const x of [b.min.x, b.max.x]) for (const z of [b.min.z, b.max.z]) { const v = new V(x, b.max.y, z).applyMatrix4(fg.slab.matrixWorld).project(sc.camera); if (Math.abs(v.x) > 1.02 || Math.abs(v.y) > 1.02) fit = false; minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x); }
      return { view: a.state.view, iso: sc.isolated, sel: a.state.selectedId, shown: !document.querySelector(".marker-layer .marker.selected")?.hidden,
               fit, span: +(maxx - minx).toFixed(2), zoomT: +sc.controls.target.distanceTo(sc.root.localToWorld(sc.markerObjs.get('P-008').sphere.position.clone())).toFixed(3), presets: [...document.querySelectorAll('[data-focus-key^="preset-"]')].map(b => b.dataset.focusKey) } }''')
    check('2e คลิกแจ้งเตือนแล้วเปิดโมเดลเดี่ยวชั้นที่เกิดเหตุทันที และซูมที่จุด', st['view'] == 'overview' and st['iso'] == '2' and st['sel'] == 'P-008' and st['shown']
          and st['zoomT'] < 0.05 and st['presets'] == ['preset-fit', 'preset-top']
          and 'กำลังดู: ชั้น 2' in page.locator('.floor-banner').inner_text(), json.dumps(st))
    page.screenshot(path=f'{SHOTS}/14-alert-opens-floor-2.png')

    # 3) อุปกรณ์หยุดส่ง: ข้อมูลเก่าแสดงชัด ไม่กลับสู่ปกติเอง
    page.locator('select[data-focus-key="scenario"]').select_option('room-hot')
    wait_until(page, '() => (window.__iotFortune.ctl.engine?.episodes() ?? []).some(e => e.pointId === "P-007" && !e.recoveredAt && e.severity === "critical")', timeout=40000)
    # เปลี่ยนเป็น "อุปกรณ์ขาดการติดต่อ" พร้อมเลือก P-007 ในครั้งเดียว (ไม่ให้มีค่าปกติแทรกระหว่างสองขั้น)
    page.evaluate('() => window.__iotFortune.ctl.setDemoParams({ scenario: "device-loss", lossPointId: "P-007" })')
    check('3 ตัวเลือกอุปกรณ์ที่ขาดการติดต่อแสดงบนแถบเดโม', page.locator('select[data-focus-key="loss"]').input_value() == 'P-007')
    wait_until(page, '() => window.__iotFortune.ctl.engine?.quality("P-007","temp") === "stale"', timeout=20000)
    page.wait_for_timeout(3000)
    state = page.evaluate('() => { const e = window.__iotFortune.ctl.engine; const ep = e.episodes().find(x => x.pointId==="P-007" && !x.endedAt && !x.recoveredAt); return { q: e.quality("P-007","temp"), active: !!ep, sev: ep?.severity } }')
    check('3a P-007 ขาดการติดต่อ → ข้อมูลเก่า และการแจ้งเตือนยังเกิดอยู่', state['q'] == 'stale' and state['active'], json.dumps(state))
    page.locator('button[data-focus-key="nav-points"]').click()
    page.wait_for_selector('tr[data-focus-key="row-P-007"]')
    row = page.locator('tr[data-focus-key="row-P-007"]').inner_text()
    check('3b ตารางแสดงระดับวิกฤตคู่กับ "ข้อมูลเก่า"', 'ข้อมูลเก่า' in row and 'วิกฤต' in row, row.replace('\n', ' ')[:100])
    page.locator('tr[data-focus-key="row-P-007"]').click()
    page.screenshot(path=f'{SHOTS}/05-desktop-stale-device.png')
    page.locator('select[data-focus-key="scenario"]').select_option('normal')
    page.locator('button[data-focus-key="speed-1"]').click()

    # 5) รีโหลดแล้วข้อมูลยังอยู่ (การตั้งค่า ประวัติ การรับทราบ)
    page.evaluate('''async () => { const c = window.__iotFortune.ctl; const cfg = structuredClone(c.config);
      cfg.points.find(p => p.id === "P-001").name = "บ่อสูบน้ำ (ตัวอย่าง-แก้ไข)"; return c.saveConfig(cfg); }''')
    before = page.evaluate('() => window.__iotFortune.ctl.repo.countSamples()')
    page.reload()
    page.wait_for_selector('.points-table tbody tr, .table-card')
    page.wait_for_timeout(1500)
    after = page.evaluate('''async () => { const c = window.__iotFortune.ctl; const eps = await c.repo.getEpisodes("demo");
      return { name: c.config.points.find(p => p.id==="P-001").name, count: await c.repo.countSamples(),
               ack: eps.some(e => e.pointId==="P-008" && e.acks.some(a => a.note.includes("ส่งช่าง"))) } }''')
    check('5 รีโหลดแล้วการตั้งค่า ประวัติ และการรับทราบยังอยู่', after['name'].endswith('แก้ไข)') and after['count'] >= before and after['ack'], json.dumps(after, ensure_ascii=False))

    # 6) ส่งออกสำรอง แล้วกู้คืนในฐานข้อมูลแยก เวลาเดิมคงเดิม
    page.locator('button[data-focus-key="nav-settings"]').click()
    page.wait_for_selector('text=ส่งออกสำรอง (JSON)')
    with page.expect_download() as dl:
        page.get_by_role('button', name='ส่งออกสำรอง (JSON)').click()
    path = f'{SHOTS}/backup.json'
    dl.value.save_as(path)
    backup = json.load(open(path, encoding='utf-8'))
    obs = sorted(s['observedAt'] for s in backup['samples'])
    p2 = ctx.new_page()
    logs2 = []
    watch(p2, logs2)
    p2.goto(f'{BASE}/?db={RUN}-restore')
    p2.wait_for_selector('.kpis .kpi')
    p2.locator('button[data-focus-key="nav-settings"]').click()
    bad = f'{SHOTS}/bad.json'
    json.dump({'format': 'iot-fortune-backup', 'schemaVersion': 1, 'config': backup['config'], 'samples': [{'id': 'x'}], 'episodes': []}, open(bad, 'w'))
    cnt0 = p2.evaluate('() => window.__iotFortune.ctl.repo.countSamples()')
    p2.locator('input[type=file]').set_input_files(bad)
    p2.wait_for_selector('.import-preview .notice.error')
    cnt1 = p2.evaluate('() => window.__iotFortune.ctl.repo.countSamples()')
    check('6a ไฟล์เสียถูกปฏิเสธก่อนเขียน ข้อมูลเดิมไม่เปลี่ยน', cnt1 >= cnt0 and 'ไม่ผ่านการตรวจ' in p2.locator('.import-preview').inner_text())
    p2.locator('input[type=file]').set_input_files(path)
    p2.wait_for_selector('.import-preview .notice.warn')
    p2.screenshot(path=f'{SHOTS}/06-import-preview.png')
    p2.get_by_role('button', name='ยืนยัน: แทนที่ข้อมูลทั้งหมดในอุปกรณ์นี้').click()
    p2.wait_for_selector('.notices .notice.ok:has-text("นำเข้าแล้ว")', timeout=30000)
    restored = p2.evaluate('''async () => { const d = await window.__iotFortune.ctl.repo.exportAll();
      const o = d.samples.map(s => s.observedAt).sort((a,b)=>a-b); return { n: d.samples.length, min: o[0], max: o[o.length-1], eps: d.episodes.length } }''')
    check('6b กู้คืนครบและเวลาสังเกตเดิมไม่เปลี่ยน', restored['n'] == len(obs) and restored['min'] == obs[0] and restored['max'] == obs[-1] and restored['eps'] == len(backup['episodes']), json.dumps(restored))
    p2.close()

    # 4) API adapter กับ fixture ในเครื่อง — แยกเวลาสังเกตกับเวลา poll สำเร็จ
    fixture('normal')
    page.locator('input[name=srcmode][value=api]').check()
    page.locator('input[type=url]').fill(f'{FIXTURE}/telemetry')
    page.locator('.api-fields input[type=number]').nth(0).fill('5')
    page.locator('.api-fields input[type=number]').nth(1).fill('3')
    page.get_by_role('button', name='บันทึกและเริ่มใช้').click()
    wait_until(page, '() => window.__iotFortune.ctl.mode === "api" && window.__iotFortune.ctl.engine?.quality("P-001","level") === "fresh"', timeout=20000)
    page.wait_for_timeout(600)
    htxt = page.locator('.app-header').inner_text()
    check('4a โหมด API รับค่าจาก fixture และป้ายแหล่งข้อมูลเป็น "ข้อมูลจาก API"', 'ข้อมูลจาก API' in htxt, htxt.replace('\n', ' '))
    nodemo = page.evaluate('() => window.__iotFortune.ctl.engine?.quality("P-003","run")')
    check('4b จุดที่ API ไม่ได้ส่งมาเป็น "ยังไม่มีข้อมูล" (ไม่ใช้ค่าจำลองแทน)', nodemo == 'nodata', nodemo)
    page.evaluate('''async () => { const c = window.__iotFortune.ctl; const cfg = structuredClone(c.config);
      cfg.points.find(p => p.id === "P-001").metrics[0].staleAfterSec = 8; return c.saveConfig(cfg); }''')
    fixture('stuck')
    page.wait_for_timeout(12000)
    st = page.evaluate('''() => { const c = window.__iotFortune.ctl; const e = c.engine.entry("P-001","level");
      return { q: c.engine.quality("P-001","level"), conn: c.connection.state, lastSuccess: c.connection.lastSuccessAt, observedAt: e.lastValid.observedAt } }''')
    check('4c poll สำเร็จแต่ค่าค้าง → ยังเป็นข้อมูลเก่า (เวลาสังเกต ≠ เวลา poll)', st['q'] == 'stale' and st['conn'] == 'ok' and st['lastSuccess'] - st['observedAt'] > 8000, json.dumps(st))
    page.locator('button[data-focus-key="nav-overview"]').click()
    page.wait_for_selector('select[data-focus-key="floor"]')
    if page.evaluate('() => window.__iotFortune.app.state.viewMode') == '3d':
        page.locator('select[data-focus-key="floor"]').select_option('')
    else:
        page.locator('select[data-focus-key="floor"]').select_option('G')
    page.wait_for_timeout(600)
    page.locator('tr[data-focus-key="row-P-001"]').click()
    page.wait_for_timeout(500)
    page.screenshot(path=f'{SHOTS}/07-desktop-api-stale.png')
    fixture('fail')
    wait_until(page, '() => window.__iotFortune.ctl.connection?.state === "retrying"', timeout=20000)
    st2 = page.evaluate('() => { const c = window.__iotFortune.ctl; return { mode: c.mode, q: c.engine.quality("P-001","level"), v: c.engine.entry("P-001","level").lastValid.value, err: c.connection.lastError } }')
    check('4d API ล้มเหลว → แสดงการเชื่อมต่อล้มเหลว ค่าเดิมคงอยู่ ไม่สลับเป็นค่าจำลอง', st2['mode'] == 'api' and st2['q'] == 'stale' and 'HTTP 503' in (st2['err'] or ''), json.dumps(st2, ensure_ascii=False))
    page.wait_for_timeout(1500)
    mtxt = page.locator('.modebar').inner_text()
    check('4e แถบสถานะแสดงข้อความการเชื่อมต่อล้มเหลว', 'เชื่อมต่อไม่ได้' in mtxt, mtxt.replace('\n', ' ')[:200])
    fixture('normal')

    # 7) คีย์บอร์ด/โฟกัส, ไม่ล้นแนวนอน, ไม่มี error
    page.locator('button[data-focus-key="nav-points"]').focus()
    page.keyboard.press('Enter')
    page.wait_for_selector('tr[data-focus-key="row-P-002"]')
    page.locator('tr[data-focus-key="row-P-002"]').focus()
    page.keyboard.press('Enter')
    page.wait_for_timeout(300)
    check('7a เลือกจุดจากตารางด้วยแป้นพิมพ์', 'P-002' in page.locator('.details .pid').first.inner_text())
    fv = page.evaluate('() => ({ fv: document.activeElement.matches(":focus-visible"), shadow: getComputedStyle(document.activeElement).boxShadow })')
    check('7b องค์ประกอบที่โฟกัสด้วยแป้นพิมพ์มีกรอบโฟกัส (:focus-visible)', fv['fv'] and '247, 201, 72' in fv['shadow'], json.dumps(fv))
    check('7c เดสก์ท็อป 1440 ไม่ล้นแนวนอน', no_overflow(page))
    unexpected = [l for l in logs if '8787' not in l and 'Failed to load resource' not in l]
    check('7d ไม่มี console error / request ล้มเหลว (ยกเว้น 503 ที่ตั้งใจจาก fixture)', not unexpected, '; '.join(unexpected[:5]))

    # กลับเป็นโหมดเดโมเพื่อภาพมือถือ
    page.evaluate('() => window.__iotFortune.ctl.switchMode("demo")')
    page.wait_for_timeout(1000)

    # มือถือ 390×844 และ 360
    for w, h in [(390, 844), (360, 740)]:
        m = browser.new_context(viewport={'width': w, 'height': h}, is_mobile=True, has_touch=True, timezone_id='Asia/Bangkok')
        mp = m.new_page()
        mlogs = []
        watch(mp, mlogs)
        mp.goto(f'{BASE}/?db={RUN}-m{w}')
        mp.wait_for_selector('.points-table tbody tr')
        mp.wait_for_timeout(1500)
        check(f'7e มือถือ {w}px ไม่ล้นแนวนอน', no_overflow(mp))
        mp.screenshot(path=f'{SHOTS}/08-mobile-{w}.png', full_page=False)
        mp.locator('tr[data-focus-key="row-P-001"]').click()
        mp.wait_for_selector('.details.open')
        check(f'7f มือถือ {w}px แตะรายการแล้วเปิดลิ้นชักรายละเอียด', mp.locator('.details.open').is_visible())
        mp.screenshot(path=f'{SHOTS}/09-mobile-{w}-drawer.png')
        check(f'7g มือถือ {w}px ไม่มี console error', not mlogs, '; '.join(mlogs[:3]))
        m.close()

    # ไม่มี WebGL → ใช้ 2D และรายการได้ครบ
    nog = browser.new_context(viewport={'width': 1280, 'height': 800})
    nog.add_init_script("""(() => { const o = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/i.test(t) ? null : o.call(this, t, ...a); }; })()""")
    np_ = nog.new_page()
    nlogs = []
    watch(np_, nlogs)
    np_.goto(f'{BASE}/?db={RUN}-nogl')
    np_.wait_for_selector('.plan-svg')
    np_.locator('select[data-focus-key="floor"]').select_option('3')
    np_.wait_for_timeout(400)
    np_.locator('tr[data-focus-key="row-P-005"]').click()
    np_.wait_for_timeout(300)
    check('7h ไม่มี WebGL → แสดงผัง 2D พร้อมคำอธิบาย และเลือกจุดได้', 'WebGL' in np_.locator('.viewport').inner_text() and 'P-005' in np_.locator('.details .pid').first.inner_text())
    np_.screenshot(path=f'{SHOTS}/10-no-webgl.png')
    check('7i ไม่มี WebGL → ไม่มี error', not nlogs, '; '.join(nlogs[:3]))
    nog.close()

    # 8) materials.html จาก production build
    mpg = ctx.new_page()
    mlogs = []
    watch(mpg, mlogs)
    mpg.goto(f'{BASE}/materials.html')
    mpg.wait_for_selector('#build-info:not(:empty)')
    bg = mpg.evaluate('getComputedStyle(document.body).backgroundColor')
    lic = mpg.request.get(f'{BASE}/THIRD_PARTY_LICENSES.txt')
    check('8 materials.html โหลด CSS/JS ถูกต้อง และไฟล์สัญญาอนุญาตเข้าถึงได้', bg == 'rgb(242, 245, 239)' and lic.ok and not mlogs, f'{bg} {lic.status} {mlogs[:2]}')
    mpg.screenshot(path=f'{SHOTS}/11-materials.png')
    browser.close()

passed = sum(1 for r in results if r[1])
print(f'\nสรุป: ผ่าน {passed}/{len(results)}')
sys.exit(0 if passed == len(results) else 1)
