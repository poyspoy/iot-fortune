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


def na(name, reason):
    """Obsolete/N/A — ผลคาดหวังตามข้อกำหนดเก่า หรือไม่เกี่ยวกับมุมทั้งอาคาร — ไม่นับ Pass/Fail"""
    results.append((name, None, reason))
    print(f'OBSOLETE/N/A {name} — {reason}', flush=True)


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


# เงื่อนไขควบคุม (อนุมัติ 17 ต.ค. 2569): ปิดโหมดอัตโนมัติ · นาฬิกาตั้งเองเริ่มที่เวลาของตัวจำลอง (ไม่มีการไล่เวลา)
# · พาลิฟต์ไปจอดชั้นเริ่มต้น ประตูเปิด ก่อนเริ่มเที่ยว — ใช้ได้ทั้ง build ใหม่ (ElevatorService) และ ddc56f0 (ตัวจำลองในฉาก)
PREP = """(f) => { const a = window.__iotFortune.app, sc = a.scene; const sim = a.elevator ? a.elevator.sim : sc.lift.sim;
  if (sc.manualNow == null) sc.setManualClock(sim.t);
  sc.setLiftAuto(false);
  const p = sc.elevatorProbe();
  if (!(p.target === f && (p.phase === 'open' || p.phase === 'opening' || p.phase === 'closed'))) sc.requestElevator(f);
  else if (p.phase === 'closed') sc.requestElevator(f);
  for (let i = 0; i < 8000; i++) { const q = sc.elevatorProbe(); if (q.target === f && q.phase === 'open' && q.door === 1) return q; sc.debugStepLift(16); }
  return sc.elevatorProbe(); }"""


def prep(page, floor):
    return page.evaluate(PREP, floor)


def trip(page, floor, label):
    page.evaluate("() => { const a = window.__iotFortune.app, sc = a.scene; if (sc.manualNow == null) sc.setManualClock((a.elevator ? a.elevator.sim : sc.lift.sim).t); sc.setLiftAuto(false); }")
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
    if mf is None:  # Lazy Loading (v1.8.1): มุมทั้งอาคารไม่มีโมเดลรายละเอียด — ตรวจแทนใน e2e_site (เลือกชั้นก่อน)
        na(f'{label}: พื้นห้องลิฟต์ตรงพื้นโมเดลห้องจาก Blender ของชั้น {floor}', 'N/A — มุมทั้งอาคารใช้โมเดลแบบเบา ไม่มีโมเดลรายละเอียดของชั้นนี้ในหน่วยความจำ (ตรวจใน e2e_site)')
    else:
        check(f'{label}: พื้นห้องลิฟต์ตรงพื้นโมเดลห้องจาก Blender ของชั้น {floor}', abs(log[-1]['carY'] - mf) < 1e-6 and (first_open is None or abs(first_open['carY'] - mf) < 1e-6),
              f"carY={round(log[-1]['carY'], 5)} พื้นโมเดล={round(mf, 5)}")
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
    # เกณฑ์ (อนุมัติ 18 ต.ค. 2569): ช่วง 0.3 วิ แรกและสุดท้ายของการเคลื่อนที่ วัดด้วยเวลาของตัวจำลอง (นาฬิกาที่ควบคุมได้ ไม่ใช่เวลาจริง)
    # แต่ละช่วงต้องมีตัวอย่าง ≥ 3 ค่า · ความเร็วช่วงต้น/ท้ายต้องต่ำกว่า 60% ของความเร็วสูงสุดช่วงกลาง (tolerance เดียวกันทุก build ไม่มีค่าเฉพาะ build)
    # เกณฑ์เดิม "1/8 ของเที่ยว" ใช้กับค่าลิฟต์รุ่นก่อน — 1/8 ของเที่ยวยาวนานกว่าช่วงเร่ง จึงจัดเป็น Obsolete
    WIN = 0.3
    sv = []  # (เวลาตัวจำลอง วินาทีนับจากเริ่มเคลื่อนที่, ความเร็ว)
    if moving:
        t0m = moving[0]['t']
        for a, b in zip(moving, moving[1:]):
            dt = (b['t'] - a['t']) / 1000
            if dt > 0: sv.append(((b['t'] - t0m) / 1000, abs(b['carY'] - a['carY']) / dt))
    if sv:
        tend = sv[-1][0]
        head = [v for t, v in sv if t <= WIN]
        tail = [v for t, v in sv if t >= tend - WIN]
        mid = [v for t, v in sv if WIN < t < tend - WIN]
        vmid = max(mid) if mid else 0
        enough = len(head) >= 3 and len(tail) >= 3 and len(mid) >= 3
        check(f'{label}: ค่อย ๆ ออกตัวและชะลอก่อนหยุด (0.3 วิ แรก/สุดท้ายตามเวลาตัวจำลอง < 60% ความเร็วช่วงกลาง)',
              enough and max(head) < vmid * 0.6 and max(tail) < vmid * 0.6,
              f'ต้น {max(head) if head else 0:.2f} ({len(head)} ค่า) · กลาง {vmid:.2f} ({len(mid)} ค่า) · ท้าย {max(tail) if tail else 0:.2f} ({len(tail)} ค่า) · ระยะเวลาเคลื่อนที่ {tend:.2f} วิ')
        na(f'{label}: ค่อย ๆ ออกตัวและชะลอก่อนหยุด (เกณฑ์เดิม 1/8 ของเที่ยว)', 'Obsolete — เกณฑ์ของค่าลิฟต์รุ่นก่อน แทนด้วยเกณฑ์ 0.3 วิ ตามเวลาตัวจำลอง')
    busy = [x for x in log if x['phase'] in ('closing', 'moving', 'opening')]
    na(f'{label}: ปิดปุ่มเลือกชั้นระหว่างเดินทาง', 'Obsolete — ข้อกำหนดปัจจุบัน: ปุ่มกดได้ตลอด คำสั่งผู้ใช้มีสิทธิ์ก่อน')
    check(f'{label}: ปุ่มเลือกชั้นกดได้ตลอดการเดินทาง (ข้อกำหนดปัจจุบัน)', busy and not any(any(x['disabled']) for x in busy) and not any(log[-1]['disabled']))
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
    # ข้อความบนแผงปัจจุบันหลังจอด: "จอดชั้น X" (ข้อความเก่า "ถึงชั้น X")
    check(f'{label}: แสดง "จอดชั้น {floor}" และ "ประตูเปิด"', last['headline'] == f'จอดชั้น {floor}' and last['doorText'] == 'ประตูเปิด', f"{last['headline']} · {last['doorText']}")
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
    # Lazy Loading: มุมทั้งอาคารใช้โมเดลแบบเบา — เริ่มทดสอบลิฟต์ได้เมื่อโมเดลแบบเบาพร้อม (ไม่ต้องโหลดรายละเอียด 27 ชั้น)
    page.wait_for_function("() => window.__iotFortune.app.scene.detailProgress().building === 'ready'", timeout=400000)
    check('มุมทั้งอาคาร: โมเดลแบบเบาพร้อม เริ่มทดสอบลิฟต์ได้', True, page.locator('[data-testid=model-state]').inner_text())
    floors = page.evaluate('window.__iotFortune.app.scene.elevatorFloors()')
    cfg_floors = page.evaluate("window.__iotFortune.app.config.building.floors.map(f => f.id)")
    check('ปุ่มเลือกชั้นตรงกับชั้นจริงที่ลิฟต์จอด', page.locator('.lift-btn').all_inner_texts() == floors and all(f in cfg_floors for f in floors), ' '.join(floors))
    st0 = prep(page, floors[0])  # พาลิฟต์กลับชั้นล่างสุดด้วยนาฬิกาที่ควบคุมได้
    check('เริ่มต้นจอดชั้นล่างสุด ประตูเปิด พื้นห้องลิฟต์ตรงพื้นชั้น', st0['target'] == floors[0] and st0['door'] == 1 and abs(st0['carY'] - st0['levels'][floors[0]]) < 1e-6)
    page.click('[data-testid=lift-cut]')
    page.wait_for_timeout(1200)
    page.screenshot(path=os.path.join(OUT, '01-lift-view.png'), timeout=180000)
    top, mid = floors[-1], floors[len(floors) // 2]
    prep(page, floors[0])
    trip(page, top, f'ขึ้น {floors[0]}→{top}')
    page.screenshot(path=os.path.join(OUT, '02-at-top.png'), timeout=180000)
    st = page.evaluate('window.__iotFortune.app.state')
    check('ลิฟต์ไม่เปลี่ยนมุมมอง: ยังดูทั้งอาคาร และไม่ตั้งชั้นที่เลือกค้างไว้', not st['isolated'])
    prep(page, top)
    trip(page, floors[0], f'ลง {top}→{floors[0]}')
    prep(page, floors[0])
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
    dis = page.evaluate("[...document.querySelectorAll('.lift-btn')].some(b => b.disabled)")
    tgt_before = page.evaluate("window.__iotFortune.app.scene.elevatorProbe().target")
    page.locator(f'.lift-btn[data-floor="{top}"]').click(force=True)
    tgt_after = page.evaluate("window.__iotFortune.app.scene.elevatorProbe().target")
    na('ระหว่างเดินทางปุ่มถูกปิด', 'Obsolete — ข้อกำหนดปัจจุบัน: ปุ่มกดได้ตลอด')
    check('ระหว่างเดินทางปุ่มกดได้ และการกดชั้นอื่นไม่ตัดเที่ยวที่กำลังวิ่ง (ข้อกำหนดปัจจุบัน)', not dis and tgt_before == tgt_after == real_to, f'ปลายทาง {tgt_before}→{tgt_after}')
    page.wait_for_function("() => window.__iotFortune.app.scene.elevatorProbe().phase === 'open'", timeout=120000)
    pr = page.evaluate('window.__iotFortune.app.scene.elevatorProbe()')
    check('เวลาจริง: ถึงชั้นปลายทางเอง พื้นห้องลิฟต์ตรงพื้นชั้น ประตูเปิด', pr['target'] == real_to and abs(pr['carY'] - pr['levels'][real_to]) < 1e-6 and pr['door'] == 1)
    # โหมดแยกชั้น: ระดับพื้นเปลี่ยน ลิฟต์ยังจอดตรงชั้น
    # โหมด "แยกชั้น" (exploded) ถูกถอดจากเมนูการแสดงผลแล้ว (ตัวเลือกปัจจุบัน: ภายนอก / ตัดชั้นบน) → Obsolete
    # ตรวจแทนด้วยโหมด "ตัดชั้นบน" (cutaway) ซึ่งเป็นตัวเลือกปัจจุบันที่เปลี่ยนการแสดงชั้น
    na('โหมดแยกชั้น (exploded): ห้องลิฟต์ยังตรงพื้นชั้นที่จอด', 'Obsolete — เมนูการแสดงผลปัจจุบันไม่มีโหมดแยกชั้น (มีเฉพาะ ภายนอก / ตัดชั้นบน)')
    page.evaluate("() => { const a = window.__iotFortune.app, sc = a.scene; if (sc.manualNow == null) sc.setManualClock((a.elevator ? a.elevator.sim : sc.lift.sim).t); sc.setLiftAuto(false); }")
    prep(page, real_to)
    page.select_option('select[data-focus-key=scenemode]', 'cutaway')
    page.wait_for_function(SETTLED, timeout=60000)
    pr = page.evaluate('window.__iotFortune.app.scene.elevatorProbe()')
    check('โหมดตัดชั้นบน: ห้องลิฟต์ยังตรงพื้นชั้นที่จอด', abs(pr['carY'] - pr['levels'][pr['target']]) < 1e-6, f"carY={pr['carY']:.4f} พื้นชั้น={pr['levels'][pr['target']]:.4f}")
    trip(page, top, f'ตัดชั้นบน {pr["target"]}→{top}')
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

scored = [r for r in results if r[1] is not None]
ok = sum(1 for r in scored if r[1])
print(f'\n{ok}/{len(scored)} ผ่าน · Obsolete/N/A {len(results) - len(scored)}')
json.dump([{'check': n, 'pass': c, 'detail': d} for n, c, d in results], open(os.path.join(OUT, 'results.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
sys.exit(0 if ok == len(scored) else 1)
