"""
วินิจฉัยเที่ยวแรก G→5 ของ e2e_elevator (เงื่อนไขเดียวกับสคริปต์นั้น) — บันทึก Timeline เท่านั้น ไม่ตัดสินผ่าน/ไม่ผ่าน
รัน: python scripts/diag_lift_first_trip.py <URL> <ไฟล์ผล.json>
"""
import json, sys, random, time
from playwright.sync_api import sync_playwright

BASE, OUT = sys.argv[1], sys.argv[2]
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
SIM = "(() => { const a = window.__iotFortune.app; return a.elevator ? a.elevator.sim : a.scene.lift.sim; })()"
STAT = """() => { const a = window.__iotFortune.app; const sc = a.scene; const sim = %s; const p = sc.elevatorProbe();
  return { wall: performance.now(), manual: sc.manualNow ?? null, simT: sim.t, phase: p.phase, pos: p.pos, vel: p.vel, door: p.door, target: p.target, mode: p.mode,
           auto: sim.auto, carY: p.carY, svc: !!a.elevator }; }""" % SIM
RUN = """(floor) => { const a = window.__iotFortune.app; const sc = a.scene; const sim = %s; const log = [];
  const snap = (ev) => { const p = sc.elevatorProbe(); log.push({ ev, manual: sc.manualNow, simT: sim.t, phase: p.phase, pos: +p.pos.toFixed(4), vel: +p.vel.toFixed(3), door: +p.door.toFixed(3), target: p.target, mode: p.mode }); };
  snap('before-click');
  document.querySelector(`.lift-btn[data-floor="${floor}"]`).click(); snap('after-click');
  for (let i = 0; i < 4000; i++) { sc.debugStepLift(16); snap('step'); const x = log[log.length - 1]; if (x.phase === 'open' && x.target === floor) break; }
  return log; }""" % SIM

with sync_playwright() as pw:
    b = pw.chromium.launch(args=ARGS)
    page = b.new_context(viewport={'width': 1100, 'height': 680}).new_page()
    t0 = time.time()
    page.goto(f'{BASE}/?db=diag{random.randint(1000, 9999)}')
    page.wait_for_selector('[data-testid=lift-panel]', timeout=30000)
    timeline = [{'at': 'lift-panel', 'sec': round(time.time() - t0, 1), **page.evaluate(STAT)}]
    page.wait_for_function("() => window.__iotFortune.app.scene.elevatorProbe()?.visible", timeout=20000)
    timeline.append({'at': 'probe-visible', 'sec': round(time.time() - t0, 1), **page.evaluate(STAT)})
    page.wait_for_function("() => window.__iotFortune.app.scene.detailProgress().building === 'ready'", timeout=400000)
    timeline.append({'at': 'building-ready (จุดตรวจ "เริ่มต้นจอดชั้นล่างสุด")', 'sec': round(time.time() - t0, 1), **page.evaluate(STAT)})
    page.click('[data-testid=lift-cut]')
    page.wait_for_timeout(1200)
    timeline.append({'at': 'after lift-cut + 1.2s', 'sec': round(time.time() - t0, 1), **page.evaluate(STAT)})
    page.evaluate('window.__iotFortune.app.scene.setManualClock(performance.now())')
    timeline.append({'at': 'manual clock set', 'sec': round(time.time() - t0, 1), **page.evaluate(STAT)})
    log = page.evaluate(RUN, '5')
    b.close()

# สรุปเหตุการณ์สำคัญของเที่ยว
events, prev = [], None
for i, x in enumerate(log):
    if prev is None or x['phase'] != prev['phase'] or x['target'] != prev['target']:
        events.append({'i': i, **x})
    prev = x
moving = [x for x in log if x['phase'] == 'moving']
dpos = [(log[i]['pos'] - log[i - 1]['pos'], log[i]['manual'] - log[i - 1]['manual'], i) for i in range(1, len(log))]
jumps = [{'i': i, 'dpos': round(d, 4), 'dt_ms': dt} for d, dt, i in dpos if dt and abs(d) / (dt / 1000) > 0.86]
first_move = next((i for i, x in enumerate(log) if x['phase'] == 'moving'), None)
res = {'url': BASE, 'timeline': timeline, 'tripEvents': events, 'firstMoveIndex': first_move,
       'doorAtFirstMove': log[first_move]['door'] if first_move is not None else None,
       'maxSpeed': max((abs(d) / (dt / 1000) for d, dt, _ in dpos if dt), default=0), 'jumps': jumps[:10], 'steps': len(log),
       'manualMinusSimAtStart': (log[0]['manual'] or 0) - log[0]['simT']}
json.dump(res, open(OUT, 'w'), ensure_ascii=False, indent=1)
print(json.dumps({k: res[k] for k in ('timeline', 'tripEvents', 'firstMoveIndex', 'doorAtFirstMove', 'maxSpeed', 'jumps', 'manualMinusSimAtStart')}, ensure_ascii=False, indent=1))
