"""
ทดสอบลิฟต์จำลองในเบราว์เซอร์จริง (Playwright + Chromium) และบันทึกคลิป

รัน:  npm run build && npm run preview  (พอร์ต 4173)
      python scripts/e2e_elevator.py [http://localhost:4173] [โฟลเดอร์ผลลัพธ์]

ลำดับ: G → ชั้นบนสุด → G → ชั้นกลาง (+ กดชั้นเดิม, โหมดแยกชั้น, เชื่อมกับการเลือกชั้น)
ทุกเฟรมบันทึก: เฟส ตำแหน่งห้องลิฟต์ ระดับพื้นชั้น ระยะเปิดประตู สถานะปุ่ม และข้อความบนแผง
"""
import json, os, sys, random, glob, shutil
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'e2e-elevator'
os.makedirs(OUT, exist_ok=True)
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
results = []
SETTLED = "() => { const sc = window.__iotFortune.app.scene; return [...sc.floorGroups.values()].every(g => !g.anim) && !sc.tween; }"


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


SNAP = """() => {
  const sc = window.__iotFortune.app.scene;
  const p = sc.elevatorProbe();
  const panel = document.querySelector('[data-testid=lift-panel]');
  const btns = [...panel.querySelectorAll('.lift-btn')];
  return { t: sc.manualNow ?? performance.now(), ...p, panelPhase: panel.dataset.phase,
    headline: panel.querySelector('[data-testid=lift-headline]').textContent,
    doorText: panel.querySelector('[data-testid=lift-door]').textContent, disabled: btns.map(b => b.disabled) };
}"""

# เดินเวลาทีละ 16 ms (≈60 เฟรม/วินาที) ด้วยนาฬิกาของฉาก แล้วอ่านตำแหน่งห้องลิฟต์/ประตูจริงในฉากทุกก้าว
# (เครื่องทดสอบไม่มี GPU วาดภาพได้ไม่ถึง 1 เฟรม/วินาที — จึงตรวจทุกก้าวเวลาแทนการรอเฟรมภาพ)
RUN = """(floor) => {
  const sc = window.__iotFortune.app.scene;
  const snap = %s;
  const log = [snap()];
  document.querySelector(`.lift-btn[data-floor="${floor}"]`).click();
  log.push(snap());
  for (let i = 0; i < 4000; i++) {
    sc.debugStepLift(16);
    const x = snap(); log.push(x);
    if (x.phase === 'open' && x.target === floor) { for (let k = 0; k < 10; k++) { sc.debugStepLift(16); log.push(snap()); } break; }
  }
  return log;
}""" % SNAP


def trip(page, floor, label):
    page.evaluate('window.__iotFortune.app.scene.setManualClock(performance.now())')
    log = page.evaluate(RUN, floor)
    start = log[0]
    lv = log[-1]['levels']
    tgt_y = lv[floor]
    from_y = start['carY']
    # ประตูเปิด (มีช่อง) เฉพาะตอนพื้นห้องลิฟต์ตรงพื้นชั้นเท่านั้น
    bad_open = [x for x in log if x['doorGap'] > 1e-4 and min(abs(x['carY'] - v) for v in x['levels'].values()) > 1e-6]
    check(f'{label}: ประตูเปิดเฉพาะเมื่อพื้นห้องลิฟต์ตรงพื้นชั้น', not bad_open, f'{len(bad_open)} เฟรมผิด / {len(log)} เฟรม')
    opening = [x for x in log if x['phase'] == 'opening' or (x['phase'] == 'open' and x['target'] == floor and x is not start)]
    first_open = next((x for x in log if x['phase'] == 'opening'), None)
    mf = log[-1].get('modelFloor', {}).get(floor)
    check(f'{label}: พื้นห้องลิฟต์ตรงพื้นโมเดลห้องจาก Blender ของชั้น {floor}', mf is not None and abs(log[-1]['carY'] - mf) < 1e-6 and (first_open is None or abs(first_open['carY'] - mf) < 1e-6),
          f"carY={round(log[-1]['carY'], 5)} พื้นโมเดล={mf if mf is None else round(mf, 5)}")
    check(f'{label}: เริ่มเปิดประตูหลังหยุดตรงชั้น {floor}', first_open is not None and abs(first_open['carY'] - tgt_y) < 1e-6,
          f"carY={first_open and round(first_open['carY'], 5)} พื้นชั้น={round(tgt_y, 5)}")
    moving = [x for x in log if x['phase'] == 'moving']
    check(f'{label}: ประตูปิดสนิทตลอดการเคลื่อนที่', moving and all(x['door'] == 0 and x['doorGap'] <= 1e-6 for x in moving), f'{len(moving)} เฟรมเคลื่อนที่')
    closing = [x for x in log if x['phase'] == 'closing']
    check(f'{label}: ไม่ออกตัวก่อนประตูปิด', closing and all(abs(x['carY'] - from_y) < 1e-6 for x in closing))
    # ไม่กระโดด: ความเร็วสูงสุดต่อเฟรมสมเหตุสมผล และช่วงต้น/ท้ายช้ากว่ากลาง
    vs = []
    for a, b in zip(moving, moving[1:]):
        dt = (b['t'] - a['t']) / 1000
        if dt > 0: vs.append(abs(b['carY'] - a['carY']) / dt)
    max_step = max((abs(b['pos'] - a['pos']) for a, b in zip(log, log[1:])), default=0)  # หน่วย: ชั้น
    vmax = max(vs) if vs else 0
    check(f'{label}: เคลื่อนที่ต่อเนื่อง ไม่กระโดด', vs and max_step < 0.03, f'ความเร็วสูงสุด {vmax:.2f} หน่วย/วินาที · ขยับสูงสุด {max_step:.4f} ชั้น ต่อ 16 ms · {len(moving)} ก้าว')
    if len(vs) >= 6:  # มีหลายก้าวเสมอเมื่อเดินเวลาทีละ 16 ms
        n = max(1, len(vs) // 8)
        check(f'{label}: ค่อย ๆ ออกตัวและชะลอก่อนหยุด', max(vs[:n]) < vmax * 0.6 and max(vs[-n:]) < vmax * 0.6,
              f'ต้น {max(vs[:n]):.2f} · กลาง {vmax:.2f} · ท้าย {max(vs[-n:]):.2f}')
    busy = [x for x in log if x['phase'] in ('closing', 'moving', 'opening')]
    check(f'{label}: ปิดปุ่มเลือกชั้นระหว่างเดินทาง เปิดอีกครั้งเมื่อถึง', busy and all(all(x['disabled']) for x in busy) and not any(log[-1]['disabled']))
    arrows = {x['headline'] for x in moving}
    up = lv[floor] > from_y
    check(f'{label}: แสดงปลายทางและลูกศร{"ขึ้น" if up else "ลง"}', any(h.startswith('▲' if up else '▼') and h.endswith(f'ชั้น {floor}') for h in arrows), ' | '.join(sorted(arrows))[:120])
    # สถานะบนแผงตรงกับตำแหน่งที่เห็น (ยอมให้ช้ากว่าภาพได้ ≤ 1 เฟรมตอนเปลี่ยนเฟส)
    mism = [i for i, x in enumerate(log) if x['panelPhase'] != x['phase']]
    runs = 0; worst = 0
    for i, j in zip(mism, mism[1:] + [None]):
        runs += 1
        if j != i + 1: worst = max(worst, runs); runs = 0
    check(f'{label}: สถานะบนแผงตรงกับห้องลิฟต์ในภาพ', worst <= 1, f'เฟรมไม่ตรงติดกันสูงสุด {worst}')
    last = log[-1]
    check(f'{label}: แสดง "ถึงชั้น {floor}" และ "ประตูเปิด"', last['headline'] == f'ถึงชั้น {floor}' and last['doorText'] == 'ประตูเปิด', f"{last['headline']} · {last['doorText']}")
    return log


with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS)
    ctx = browser.new_context(viewport={'width': 1100, 'height': 680})
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    page.goto(f'{BASE}/?db=lift{random.randint(1000, 9999)}')
    page.wait_for_selector('[data-testid=lift-panel]', timeout=30000)
    page.wait_for_function("() => window.__iotFortune.app.scene.elevatorProbe()?.visible", timeout=20000)
    page.wait_for_function("() => { const p = window.__iotFortune.app.scene.detailProgress(); return p.ready === p.total; }", timeout=400000)
    check('โหลดโมเดลห้องจาก Blender ครบทุกชั้นในมุมมองทั้งอาคาร', True, page.locator('[data-testid=model-state]').inner_text())
    floors = page.evaluate('window.__iotFortune.app.scene.elevatorFloors()')
    cfg_floors = page.evaluate("window.__iotFortune.app.config.building.floors.map(f => f.id)")
    check('ปุ่มเลือกชั้นตรงกับชั้นจริงที่ลิฟต์จอด', page.locator('.lift-btn').all_inner_texts() == floors and all(f in cfg_floors for f in floors), ' '.join(floors))
    st0 = page.evaluate('window.__iotFortune.app.scene.elevatorProbe()')
    check('เริ่มต้นจอดชั้นล่างสุด ประตูเปิด พื้นห้องลิฟต์ตรงพื้นชั้น', st0['target'] == floors[0] and st0['door'] == 1 and abs(st0['carY'] - st0['levels'][floors[0]]) < 1e-6)
    page.click('[data-testid=lift-cut]')
    page.wait_for_timeout(1200)
    page.screenshot(path=os.path.join(OUT, '01-lift-view.png'), timeout=180000)
    top, mid = floors[-1], floors[len(floors) // 2]
    trip(page, top, f'ขึ้น {floors[0]}→{top}')
    page.screenshot(path=os.path.join(OUT, '02-at-top.png'), timeout=180000)
    st = page.evaluate('window.__iotFortune.app.state')
    check('ลิฟต์ไม่เปลี่ยนมุมมอง: ยังดูทั้งอาคาร และไม่ตั้งชั้นที่เลือกค้างไว้', not st['isolated'])
    trip(page, floors[0], f'ลง {top}→{floors[0]}')
    trip(page, mid, f'หยุดชั้นกลาง {floors[0]}→{mid}')
    page.screenshot(path=os.path.join(OUT, '03-at-middle.png'), timeout=180000)
    # กดชั้นเดิม: ไม่เดินทาง
    log = page.evaluate("""(floor) => { const sc = window.__iotFortune.app.scene; const snap = %s; const log = [snap()];
      document.querySelector(`.lift-btn[data-floor="${floor}"]`).click();
      for (let i = 0; i < 120; i++) { sc.debugStepLift(16); log.push(snap()); } return log; }""" % SNAP, mid)
    check('กดชั้นเดิมไม่เดินทางใหม่', all(x['phase'] == 'open' for x in log) and max(x['carY'] for x in log) - min(x['carY'] for x in log) < 1e-9)
    # ระหว่างเดินทาง กดชั้นอื่นไม่ได้ (ปุ่ม disabled)
    # ทดสอบด้วยเวลาจริง (ไม่ใช้นาฬิกาทดสอบ) — ลิฟต์ต้องถึงปลายทางเองตามปกติ
    page.evaluate('window.__iotFortune.app.scene.setManualClock(null)')
    real_to = floors[1] if mid != floors[1] else floors[0]
    page.click(f'.lift-btn[data-floor="{real_to}"]')
    page.wait_for_function("() => window.__iotFortune.app.scene.elevatorProbe().phase === 'moving'", timeout=60000)
    dis = page.evaluate("[...document.querySelectorAll('.lift-btn')].every(b => b.disabled)")
    tgt_before = page.evaluate("window.__iotFortune.app.scene.elevatorProbe().target")
    page.locator(f'.lift-btn[data-floor="{top}"]').click(force=True)
    tgt_after = page.evaluate("window.__iotFortune.app.scene.elevatorProbe().target")
    check('ระหว่างเดินทางปุ่มถูกปิด และการกดซ้ำไม่เปลี่ยนปลายทาง', dis and tgt_before == tgt_after, f'ปลายทาง {tgt_after}')
    page.wait_for_function("() => window.__iotFortune.app.scene.elevatorProbe().phase === 'open'", timeout=120000)
    pr = page.evaluate('window.__iotFortune.app.scene.elevatorProbe()')
    check('เวลาจริง: ถึงชั้นปลายทางเอง พื้นห้องลิฟต์ตรงพื้นชั้น ประตูเปิด', pr['target'] == real_to and abs(pr['carY'] - pr['levels'][real_to]) < 1e-6 and pr['door'] == 1)
    # โหมดแยกชั้น: ระดับพื้นเปลี่ยน ลิฟต์ยังจอดตรงชั้น
    page.select_option('select[data-focus-key=scenemode]', 'exploded')
    page.wait_for_function(SETTLED, timeout=60000)
    pr = page.evaluate('window.__iotFortune.app.scene.elevatorProbe()')
    check('โหมดแยกชั้น: ห้องลิฟต์ยังตรงพื้นชั้นที่จอด', abs(pr['carY'] - pr['levels'][pr['target']]) < 1e-6)
    trip(page, top, f'แยกชั้น {pr["target"]}→{top}')
    page.select_option('select[data-focus-key=scenemode]', 'exterior')
    page.wait_for_function(SETTLED, timeout=60000)
    trip(page, floors[0], f'กลับชั้นล่าง {top}→{floors[0]}')
    # แยกดูชั้นที่ลิฟต์ถึง → มุมมองชั้นเดี่ยวเดิม แล้วกลับมาดูลิฟต์
    page.click('[data-testid=lift-open-floor]')
    page.wait_for_function("() => window.__iotFortune.app.state.isolated", timeout=10000)
    page.wait_for_function(SETTLED, timeout=60000)
    banner = page.locator('[data-testid=viewing]').inner_text()
    vis = page.evaluate('window.__iotFortune.app.scene.elevatorProbe().visible')
    check('ปุ่ม "แยกดูชั้น" เปิดมุมมองชั้นเดี่ยวของระบบเดิม และซ่อนลิฟต์', banner.startswith('กำลังดู: ') and floors[0] in banner and not vis, banner)
    page.screenshot(path=os.path.join(OUT, '04-isolated.png'), timeout=180000)
    page.click('.lift-iso button')
    page.wait_for_function("() => !window.__iotFortune.app.state.isolated", timeout=10000)
    page.wait_for_function(SETTLED, timeout=60000)
    check('กลับมาดูทั้งอาคารแล้วลิฟต์แสดงอีกครั้ง', page.evaluate('window.__iotFortune.app.scene.elevatorProbe().visible'))
    check('ไม่มีข้อผิดพลาดในคอนโซล', not errs, '; '.join(errs)[:200])
    page.screenshot(path=os.path.join(OUT, '05-back.png'), timeout=180000)
    ctx.close(); browser.close()

ok = sum(1 for r in results if r[1])
print(f'\n{ok}/{len(results)} ผ่าน')
json.dump([{'check': n, 'pass': c, 'detail': d} for n, c, d in results], open(os.path.join(OUT, 'results.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
sys.exit(0 if ok == len(results) else 1)
