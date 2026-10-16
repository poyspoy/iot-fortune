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
    page.wait_for_function("() => { const p = window.__iotFortune.app.scene.detailProgress(); return p.ready === p.total; }", timeout=600000, polling=1000)
    page.wait_for_function("() => [...window.__iotFortune.app.scene.floorGroups.values()].filter(g => g.floor.detail).every(g => Array.isArray(g.rooms))", timeout=120000, polling=500)
    info = page.evaluate("""() => { const sc = window.__iotFortune.app.scene; const gs = [...sc.floorGroups.values()].filter(g => g.floor.detail);
      return { total: gs.length, models: gs.filter(g => g.detailObj).length, rooms: gs.reduce((n, g) => n + g.rooms.length, 0),
               floors: gs.map(g => g.floor.id), noModel: [...sc.floorGroups.values()].filter(g => !g.floor.detail).map(g => g.floor.id) }; }""")
    check('โมเดลห้องจาก Blender โหลดครบทุกชั้นที่มีไฟล์', info['models'] == info['total'] == 27, f"{info['models']}/{info['total']} ชั้น · ห้อง/พื้นที่ {info['rooms']} รายการ · ไม่มีไฟล์โมเดล: {info['noModel']}")
    settle(page)
    page.locator('.viewport').scroll_into_view_if_needed()
    shot(page, '01-desktop-building.png')
    # กดห้องในมุมมองทั้งอาคาร (ชั้น 4 อยู่บนสุดของห้าง)
    rid, title = click_room(page, '4', "rs => [...rs].filter(x => x.category === 'shop').sort((a, b) => b.area_m2 - a.area_m2)[0]")
    check('กดห้องในมุมมองทั้งอาคารแล้วแสดงข้อมูลห้องนั้น', title is not None, f'{rid} → {title}')
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
        log = page.evaluate("""(floor) => { const sc = window.__iotFortune.app.scene; sc.setManualClock(performance.now());
          document.querySelector(`.lift-btn[data-floor="${floor}"]`).click(); const log = [];
          for (let i = 0; i < 4000; i++) { sc.debugStepLift(16); const p = sc.elevatorProbe(); log.push(p); if (p.phase === 'open' && p.target === floor) break; }
          sc.setManualClock(null); return log; }""", target)
        last = log[-1]
        bad = [x for x in log if x['doorGap'] > 1e-4 and abs(x['carY'] - x['modelFloor'][x['target']]) > 1e-6 and x['phase'] != 'closing']
        check(f'ลิฟต์ไปชั้น {target}: หยุดตรงพื้นโมเดลชั้นนั้น แล้วประตูจึงเปิด', last['phase'] == 'open' and abs(last['carY'] - last['modelFloor'][target]) < 1e-6 and last['door'] == 1 and not bad,
              f"carY={last['carY']:.4f} พื้นโมเดล={last['modelFloor'][target]:.4f} · เฟรมเปิดประตูผิดตำแหน่ง {len(bad)}")
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
print(f'\nสรุป: ผ่าน {ok}/{len(results)}')
json.dump([{'check': n, 'pass': c, 'detail': d} for n, c, d in results], open(os.path.join(OUT, 'results.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
sys.exit(0 if ok == len(results) else 1)
