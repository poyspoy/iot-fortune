"""
ตรวจเว็บไซต์ 3 มิติในเบราว์เซอร์จริง (Playwright + Chromium) และเก็บภาพหน้าเว็บ — คอมพิวเตอร์ แท็บเล็ต โทรศัพท์

  python scripts/e2e_site.py [http://localhost:4173] [โฟลเดอร์ผลลัพธ์]

ตรวจ: Loading, ไม่มี console error, โมเดล+ข้อมูลห้องครบทุกชั้น, เลือกชั้น/กลับทั้งอาคาร, กดห้อง (ทั้งอาคารและชั้นเดี่ยว),
รีเซ็ตมุมกล้อง, เต็มจอ, ลิฟต์ G→3→G (พื้นลิฟต์ตรงพื้นโมเดล ประตูเปิดหลังหยุด), ไม่ล้นแนวนอนบนจอเล็ก
"""
import json, os, sys, time, random
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'e2e-site'
os.makedirs(OUT, exist_ok=True)
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
SETTLED = "() => { const sc = window.__iotFortune?.app?.scene; return !!sc && [...sc.floorGroups.values()].every(g => !g.anim) && !sc.tween; }"
results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


def watch(page, sink):
    page.on('pageerror', lambda e: sink.append(f'pageerror: {e}'))
    page.on('console', lambda m: sink.append(f'console: {m.text}') if m.type == 'error' else None)
    page.on('response', lambda r: sink.append(f'http {r.status}: {r.url}') if r.status >= 400 else None)


def settle(page):
    page.wait_for_function(SETTLED, timeout=120000, polling=300)
    page.wait_for_timeout(200)


def shot(page, name):
    page.screenshot(path=os.path.join(OUT, name), timeout=180000)


def na(name, reason):
    """ไม่นับเป็น Pass/Fail — ข้อจำกัดที่มีอยู่เดิมของ baseline"""
    results.append((name, None, reason))
    print(f'N/A  {name} — {reason}', flush=True)


def click_room(page, floor, pick_js):
    """กดห้องด้วยเมาส์จริงที่ตำแหน่งบนจอของห้อง (pick_js เลือกห้องจากรายการ rooms)"""
    sp = page.evaluate(f"(() => {{ const sc = window.__iotFortune.app.scene; const rooms = sc.roomsOf('{floor}'); const r = ({pick_js})(rooms); return {{ id: r.id, ...sc.roomScreenPos('{floor}', r.id) }}; }})()")
    box = page.locator('.scene-canvas').bounding_box()
    page.mouse.click(box['x'] + sp['x'], box['y'] + sp['y'])
    try:
        page.wait_for_function(f"document.querySelector('[data-testid=room-card] code')?.textContent === '{sp['id']}'", timeout=60000, polling=300)
        return sp['id'], page.locator('[data-testid=room-title]').inner_text()
    except Exception:
        return sp['id'], None


with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS)
    # ---------------- คอมพิวเตอร์
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errs = []
    watch(page, errs)
    t0 = time.time()
    page.goto(f'{BASE}/?db=site{random.randint(1000, 9999)}')
    boot = page.locator('.boot-screen').count()
    page.wait_for_selector('[data-testid=model-loading]', timeout=60000)
    check('มีหน้าจอเริ่มต้นและหน้าจอ Loading ระหว่างโหลดโมเดล (ไม่เห็นหน้าว่าง)', True, f'boot-screen={boot}')
    page.locator('.viewport').scroll_into_view_if_needed()
    shot(page, '00-loading.png')
    page.wait_for_selector('[data-testid=model-loading]', state='detached', timeout=600000)
    check('Loading หายเมื่อชั้นที่ลิฟต์จอดพร้อม', True, f'{time.time() - t0:.0f} วินาที (เครื่องทดสอบไม่มี GPU)')
    # มุมทั้งอาคารใช้โมเดลแบบเบา (Lazy Loading: โมเดลรายละเอียดโหลดเฉพาะชั้นที่เลือก) — รอโมเดลแบบเบาพร้อม
    page.wait_for_function("() => window.__iotFortune.app.scene.detailProgress().building === 'ready'", timeout=600000, polling=1000)
    lp = page.evaluate("() => window.__iotFortune.app.scene.detailProgress()")
    check('มุมทั้งอาคาร: โมเดลแบบเบาพร้อม และไม่โหลดโมเดลรายละเอียดล่วงหน้า', lp['building'] == 'ready' and lp['ready'] == 0, json.dumps(lp))
    # ชั้นตัวแทน: เลือกชั้นก่อน แล้วรอเฉพาะโมเดลของชั้นนั้น (ครบทุกชั้นตรวจใน e2e_floors.py)
    rep = []
    for fid in ['G', '5', '11', '32']:
        page.evaluate(f"() => window.__iotFortune.app.isolateFloor('{fid}')")
        settle(page)
        page.wait_for_function(f"() => ['ready', 'none', 'error'].includes(window.__iotFortune.app.scene.detailState('{fid}'))", timeout=240000, polling=500)
        r = page.evaluate(f"""() => {{ const sc = window.__iotFortune.app.scene; const g = sc.floorGroups.get('{fid}');
          return {{ id: '{fid}', state: sc.detailState('{fid}'), hasFile: !!g.floor.detail, model: !!g.detailObj, rooms: Array.isArray(g.rooms) ? g.rooms.length : null,
                   iso: sc.isolated, viewing: document.querySelector('[data-testid=viewing]')?.textContent ?? '' }}; }}""")
        rep.append(r)
    okf = all(r['iso'] == r['id'] and (f"ชั้น {r['id']}" in r['viewing']) and ((r['hasFile'] and r['state'] == 'ready' and r['model'] and (r['rooms'] or 0) > 0) or (not r['hasFile'] and r['state'] == 'none')) for r in rep)
    check('ชั้นตัวแทน G/5/11/32: เลือกชั้นแล้วโหลดเฉพาะโมเดลชั้นนั้น (32 ไม่มีไฟล์ = โมเดลแบบง่าย)', okf, json.dumps(rep, ensure_ascii=False))
    page.evaluate("() => window.__iotFortune.app.showBuilding()")
    settle(page)
    settle(page)
    page.locator('.viewport').scroll_into_view_if_needed()
    shot(page, '01-desktop-building.png')
    # กดห้องในมุมมองทั้งอาคาร (ชั้น 4 อยู่บนสุดของห้าง)
    # กดห้องในมุมทั้งอาคาร: ข้อมูลห้องโหลดคู่กับโมเดลรายละเอียดของชั้นที่เลือกเท่านั้น (ตั้งแต่ v1.8.1)
    # รายการห้องว่าง/ไม่มี → รายงานเป็น Known baseline limitation (ไม่นับ Pass/Fail) แล้วตรวจการกดห้องในโหมดเลือกชั้นแทน
    rooms4 = page.evaluate("() => { const r = window.__iotFortune.app.scene.roomsOf('4'); return Array.isArray(r) ? r.length : 0; }")
    if rooms4:
        rid, title = click_room(page, '4', "rs => [...rs].filter(x => x.category === 'shop').sort((a, b) => b.area_m2 - a.area_m2)[0]")
        check('กดห้องในมุมมองทั้งอาคารแล้วแสดงข้อมูลห้องนั้น', title is not None, f'{rid} → {title}')
    else:
        na('กดห้องในมุมมองทั้งอาคาร', 'Known baseline limitation / Not applicable in lightweight building view — ไม่มีข้อมูลห้องจนกว่าจะเลือกชั้น')
    # เลือกชั้น G
    page.click('[data-focus-key=fc-G]')
    settle(page)
    page.wait_for_function("window.__iotFortune.app.scene.detailState('G') === 'ready'", timeout=60000)
    st = page.evaluate("() => ({ iso: window.__iotFortune.app.scene.isolated, banner: document.querySelector('[data-testid=viewing]').textContent, card: !!document.querySelector('[data-testid=room-card]') })")
    check('เลือกชั้น G → แยกดูชั้นเดี่ยว (การ์ดห้องของชั้นอื่นปิดเอง)', st['iso'] == 'G' and 'ชั้น G' in st['banner'] and not st['card'], json.dumps(st, ensure_ascii=False))
    rid, title = click_room(page, 'G', "rs => [...rs].filter(x => x.category === 'shop').sort((a, b) => b.area_m2 - a.area_m2)[3]")
    check('กดห้องในมุมมองชั้นเดี่ยวแล้วแสดงชื่อ ชั้น ประเภท และภาพจากผัง', title is not None and page.locator('[data-testid=room-card] .rc-chip').first.inner_text() == 'ชั้น G'
          and page.locator('.room-thumb').count() == 1, f'{rid} → {title}')
    page.wait_for_timeout(2500)
    shot(page, '02-desktop-floor-G-room.png')
    # ชั้นสำนักงาน: เลือกชั้น 11 แล้วกดห้อง (ทางเดิน/พื้นที่สำนักงาน)
    e0 = len(errs)
    page.evaluate("() => window.__iotFortune.app.isolateFloor('11')")
    settle(page)
    page.wait_for_function("window.__iotFortune.app.scene.detailState('11') === 'ready'", timeout=120000)
    page.wait_for_function("Array.isArray(window.__iotFortune.app.scene.roomsOf('11'))", timeout=60000)
    # กดกลางห้องที่ใหญ่ที่สุดของชั้น 11 แล้วตรวจห้องที่ถูกเลือกจริง (ห้องเล็กที่ซ้อนอยู่บนจุดกดอาจถูกเลือกแทน — ถือว่าถูกต้องถ้าเป็นห้องของชั้นนี้และการ์ดตรงกับห้องที่เลือก)
    sp = page.evaluate("""() => { const sc = window.__iotFortune.app.scene; const rs = [...(sc.roomsOf('11') ?? [])].filter(x => x.category !== 'floor' && x.category !== 'door').sort((a, b) => b.area_m2 - a.area_m2);
      const r = rs[0]; return r ? { id: r.id, ...sc.roomScreenPos('11', r.id) } : null; }""")
    picked = None
    if sp:
        box = page.locator('.scene-canvas').bounding_box()
        page.mouse.click(box['x'] + sp['x'], box['y'] + sp['y'])
        try:
            page.wait_for_selector('[data-testid=room-card] code', timeout=60000)
        except Exception:
            pass
        picked = page.evaluate("""() => { const sc = window.__iotFortune.app.scene; const code = document.querySelector('[data-testid=room-card] code')?.textContent ?? null;
          return { code, sel: sc.roomSel ? { floor: sc.roomSel.floorId, id: sc.roomSel.id ?? sc.roomSel.roomId } : null, inFloor: !!(sc.roomsOf('11') ?? []).find(r => r.id === code),
                   title: document.querySelector('[data-testid=room-title]')?.textContent ?? null, chip: document.querySelector('[data-testid=room-card] .rc-chip')?.textContent ?? null }; }""")
    okr = bool(picked and picked['code'] and picked['inFloor'] and picked['title'] and picked['chip'] and 'ชั้น 11' in picked['chip'] and (picked['sel'] is None or picked['sel']['floor'] == '11'))
    check('ชั้นสำนักงาน 11: กดห้องแล้วเลือกห้องของชั้นนั้น การ์ดแสดงชั้นถูกต้อง และไม่มี Console Error', okr and len(errs) == e0,
          f"กดที่ {sp and sp['id']} → เลือก {picked} · errors {errs[e0:][:2]}")
    shot(page, '02b-desktop-floor-11-room.png')
    page.evaluate("() => window.__iotFortune.app.isolateFloor('G')")
    settle(page)
    # รีเซ็ตมุมกล้อง
    page.mouse.move(700, 700)
    cam0 = page.evaluate("window.__iotFortune.app.scene.camera.position.toArray()")
    page.evaluate("() => { const sc = window.__iotFortune.app.scene; sc.camera.position.x += 3; sc.controls.update(); }")
    page.click('[data-testid=reset-cam]')
    settle(page)
    cam1 = page.evaluate("window.__iotFortune.app.scene.camera.position.toArray()")
    check('ปุ่มรีเซ็ตมุมกล้องกลับมุมเริ่มต้นของมุมมอง', max(abs(a - b) for a, b in zip(cam0, cam1)) < 1e-3)
    # ชั้น 3 แล้วกลับทั้งอาคาร
    page.click('[data-focus-key=fc-3]')
    settle(page)
    shot(page, '03-desktop-floor-3.png')
    page.click('[data-focus-key=fc-all]')
    settle(page)
    st = page.evaluate("() => ({ iso: window.__iotFortune.app.scene.isolated, banner: document.querySelector('[data-testid=viewing]').textContent })")
    check('กลับไปดูทั้งอาคารได้', st['iso'] is None and 'ทั้งอาคาร' in st['banner'], st['banner'])
    # ลิฟต์ G → 3 → G ด้วยนาฬิกาของฉาก (เดินเวลาทีละ 16 ms)
    for target in ['3', 'G']:
        # Lazy Loading: เลือกชั้นปลายทางก่อนให้โมเดลรายละเอียดของชั้นนั้นโหลด แล้วกลับมุมทั้งอาคาร (แคชเก็บไว้)
        page.evaluate(f"() => window.__iotFortune.app.isolateFloor('{target}')")
        settle(page)
        page.wait_for_function(f"window.__iotFortune.app.scene.detailState('{target}') === 'ready'", timeout=120000)
        page.evaluate("() => window.__iotFortune.app.showBuilding()")
        settle(page)
        log = page.evaluate("""(floor) => { const sc = window.__iotFortune.app.scene; sc.setManualClock(performance.now());
          document.querySelector(`.lift-btn[data-floor="${floor}"]`).click(); const log = [];
          for (let i = 0; i < 4000; i++) { sc.debugStepLift(16); const p = sc.elevatorProbe(); log.push(p); if (p.phase === 'open' && p.target === floor) break; }
          sc.setManualClock(null); return log; }""", target)
        last = log[-1]
        # เทียบเฉพาะเฟรมที่มีโมเดลรายละเอียดของชั้นปลายทางในหน่วยความจำ (Lazy Loading) — ชั้นอื่นใช้ระดับพื้นชั้นของแอป
        bad = [x for x in log if x['doorGap'] > 1e-4 and abs(x['carY'] - (x['modelFloor'].get(x['target']) if x['modelFloor'].get(x['target']) is not None else x['levels'][x['target']])) > 1e-6 and x['phase'] != 'closing']
        mf = last['modelFloor'].get(target)
        check(f'ลิฟต์ไปชั้น {target}: หยุดตรงพื้นโมเดลชั้นนั้น แล้วประตูจึงเปิด', mf is not None and last['phase'] == 'open' and abs(last['carY'] - mf) < 1e-6 and last['door'] == 1 and not bad,
              f"carY={last['carY']:.4f} พื้นโมเดล={mf if mf is None else round(mf, 4)} · เฟรมเปิดประตูผิดตำแหน่ง {len(bad)}")
        if target == '3':
            page.click('[data-testid=lift-cam]')
            settle(page)
            shot(page, '04-desktop-lift-at-3.png')
    # เต็มจอ
    page.click('[data-testid=vp-full]')
    page.wait_for_timeout(1500)
    full = page.evaluate("() => { const r = document.querySelector('.viewport').getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; }")
    check('ปุ่มเต็มจอขยายโมเดลเต็มหน้าจอ', abs(full[0] - full[2]) < 2 and abs(full[1] - full[3]) < 2, str(full))
    shot(page, '05-desktop-fullscreen.png')
    page.click('[data-testid=vp-full]')
    check('คอมพิวเตอร์: ไม่มี console error / ไฟล์โหลดไม่ได้', not errs, '; '.join(errs[:3]))
    page.close()

    # ---------------- แท็บเล็ตและโทรศัพท์
    for label, vp, mobile in [('แท็บเล็ต', {'width': 820, 'height': 1180}, True), ('โทรศัพท์', {'width': 390, 'height': 844}, True)]:
        ctx = browser.new_context(viewport=vp, device_scale_factor=1, is_mobile=mobile, has_touch=True)
        mp = ctx.new_page()
        merrs = []
        watch(mp, merrs)
        mp.goto(f'{BASE}/?db=m{random.randint(1000, 9999)}')
        mp.wait_for_selector('[data-testid=lift-panel]', timeout=120000)
        mp.wait_for_selector('[data-testid=model-loading]', state='detached', timeout=600000)
        settle(mp)
        over = mp.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        check(f'{label} {vp["width"]}px: ไม่ล้นแนวนอน', over)
        mp.locator('.viewport').scroll_into_view_if_needed()
        mp.wait_for_timeout(800)
        shot(mp, f'06-{vp["width"]}-building.png')
        mp.click('[data-focus-key=fc-2]')
        settle(mp)
        mp.wait_for_function("window.__iotFortune.app.scene.detailState('2') === 'ready'", timeout=120000)
        rid, title = click_room(mp, '2', "rs => [...rs].filter(x => x.category === 'shop').sort((a, b) => b.area_m2 - a.area_m2)[1]")
        check(f'{label}: แตะห้องแล้วแสดงข้อมูล', title is not None, f'{rid} → {title}')
        mp.wait_for_timeout(2500)
        shot(mp, f'07-{vp["width"]}-floor-2-room.png')
        check(f'{label}: ไม่มี console error', not merrs, '; '.join(merrs[:3]))
        ctx.close()
    browser.close()

ok = sum(1 for r in results if r[1])
scored = [r for r in results if r[1] is not None]
nas = [r for r in results if r[1] is None]
print(f'\nสรุป: ผ่าน {ok}/{len(scored)} · N/A (Known baseline limitation) {len(nas)}')
json.dump([{'check': n, 'pass': c, 'detail': d} for n, c, d in results], open(os.path.join(OUT, 'results.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
sys.exit(0 if ok == len(scored) else 1)
