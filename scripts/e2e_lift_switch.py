"""
เกณฑ์ปิดงานย้ายลิฟต์ออกจากฉาก 3D (ElevatorService)

รัน:  python scripts/e2e_lift_switch.py [http://localhost:4173] [โฟลเดอร์ผลลัพธ์] [--visual-only]

  1) สลับ 2D ↔ 3D 20 รอบ: บริการลิฟต์มีชุดเดียว ตัวจับเวลา/ผู้ฟังไม่เพิ่ม
  2) สลับขณะลิฟต์วิ่ง: ตำแหน่งต่อเนื่อง ไม่เริ่มใหม่ ไม่กระโดด
  3) ชั้น ทิศทาง เป้าหมาย ประตู คิว ตรงกันทั้งแผง ฉาก 3D และไอคอนบนผัง 2D
  4) หน่วยความจำไม่เพิ่มต่อเนื่อง และ Console ไม่มี error
  5) ภาพลิฟต์ 3D ณ เวลาเดียวกัน (นาฬิกาตั้งเอง) — บันทึกภาพไว้เทียบกับ build อ้างอิง
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'e2e-lift-switch'
VISUAL_ONLY = '--visual-only' in sys.argv
os.makedirs(OUT, exist_ok=True)
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info', '--js-flags=--expose-gc']
results = []

# นับตัวจับเวลา setInterval ที่ยังทำงานอยู่ทั้งหน้า (ติดตั้งก่อนสคริปต์ของแอป)
INIT = """(() => { const live = new Set(); const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (...a) { const id = si.apply(this, a); live.add(id); return id; };
  window.clearInterval = function (id) { live.delete(id); return ci.call(this, id); };
  window.__liveIntervals = () => live.size; })();"""

STATE = """() => { const a = window.__iotFortune.app; const base = !a.elevator; // ddc56f0: ตัวจำลองอยู่ในฉาก 3D
  const sv = a.elevator ?? { status: () => a.scene.elevatorStatus(), listeners: { size: null }, running: null };
  const st = sv.status();
  const p = document.querySelector('[data-testid=lift-panel]');
  const m = document.querySelector('[data-testid=plan-lift]');
  const sc = a.scene; const pr = sc && a.state.viewMode === '3d' ? sc.elevatorProbe() : null;
  return { mode: a.state.viewMode, pos: st.position, phase: st.phase, target: st.target, nearest: st.nearest, direction: st.direction, doors: st.doors, queue: st.queue.join(','), atFloor: st.atFloor,
    panel: p ? { phase: p.dataset.phase, target: p.dataset.target, direction: p.dataset.direction, current: p.querySelector('[data-testid=lift-current]').textContent, door: p.querySelector('[data-testid=lift-door-state]').textContent } : null,
    doorText: st.doorText,
    scene: pr ? { phase: pr.phase, pos: pr.pos, target: pr.target, door: pr.door, ownSvc: base ? false : sc.ownElevator, sameSvc: base ? true : sc.elevator === sv } : null, base,
    marker: m ? { state: m.dataset.state, floor: a.state.floorId } : null,
    listeners: sv.listeners.size, running: sv.running, intervals: window.__liveIntervals(),
    heap: performance.memory ? performance.memory.usedJSHeapSize : null, t: performance.now(), simT: (a.elevator ? a.elevator.sim : a.scene.lift.sim).t }; }"""


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


def consistent(s):
    """สถานะเดียวกันทุกที่ที่แสดงผล (อ่านพร้อมกันในเฟรมเดียว)"""
    bad = []
    pn = s['panel']
    if not pn: return ['ไม่มีแผงลิฟต์']
    if pn['phase'] != s['phase']: bad.append(f"panel.phase {pn['phase']}≠{s['phase']}")
    if pn['target'] != s['target']: bad.append(f"panel.target {pn['target']}≠{s['target']}")
    if (pn['direction'] or None) != s['direction']: bad.append(f"panel.dir {pn['direction']}≠{s['direction']}")
    if pn['current'] != f"ชั้น {s['nearest']}": bad.append(f"panel.current {pn['current']}≠{s['nearest']}")
    if pn['door'] != s['doorText']: bad.append(f"panel.door {pn['door']}≠{s['doorText']}")
    if s['scene']:
        sc = s['scene']
        if sc['phase'] != s['phase'] or sc['target'] != s['target'] or abs(sc['pos'] - s['pos']) > 1e-9: bad.append(f"3D {sc['phase']}/{sc['target']}/{sc['pos']:.3f}")
        if not sc['sameSvc'] or sc['ownSvc']: bad.append('ฉาก 3D ใช้บริการลิฟต์คนละชุด')
    if s['marker']:
        f = s['marker']['floor']
        want = 'here' if s['atFloor'] == f else ('passing' if s['phase'] == 'moving' and s['nearest'] == f else 'away')
        if s['marker']['state'] != want: bad.append(f"2D marker {s['marker']['state']}≠{want}")
    return bad


def gc(page, cdp):
    cdp.send('HeapProfiler.collectGarbage'); page.wait_for_timeout(300)
    return page.evaluate('() => performance.memory.usedJSHeapSize')


with sync_playwright() as pw:
    b = pw.chromium.launch(args=ARGS)
    page = b.new_page(viewport={'width': 1366, 'height': 800})
    errs = []
    page.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.add_init_script(INIT)
    page.goto(f'{BASE}/?db=liftswitch')
    page.wait_for_function('() => window.__iotFortune?.app?.scene?.elevatorProbe?.()', timeout=120000)
    page.wait_for_timeout(3000)

    # ---------------------------------------------------------------- 5) ภาพลิฟต์ 3D ณ เวลาที่กำหนด (ใช้เทียบกับ build อ้างอิง)
    page.evaluate("""() => { const a = window.__iotFortune.app; const sc = a.scene;
      sc.setManualClock(0); sc.resetLift();  // reset() เปิดโหมดอัตโนมัติกลับ (ทั้งสอง build) — จึงปิดอัตโนมัติหลังกลับถึง G
      for (let i = 0; i < 4000; i++) { sc.debugStepLift(16); const p = sc.elevatorProbe(); if (p.phase === 'open' && p.target === 'G' && p.mode !== 'reset') break; }
      sc.setLiftAuto(false);
      // จุดเริ่มเดียวกันทั้งสอง build: สั่งกลับ G เอง (ไม่พึ่งเส้นทางอัตโนมัติแบบสุ่ม) แล้วรอจนจอด G ประตูปิดสนิท จึงกดชั้น 3
      if (sc.elevatorProbe().target !== 'G' || sc.elevatorProbe().phase === 'moving') sc.requestElevator('G');
      for (let i = 0; i < 8000; i++) { const p = sc.elevatorProbe(); if (p.phase === 'closed' && p.target === 'G') break; sc.debugStepLift(16); }
      a.focusLift(); }""")
    page.wait_for_timeout(2500)
    page.evaluate("() => { const sc = window.__iotFortune.app.scene; sc.setPaused(true); }")
    frames = []
    page.evaluate("() => document.querySelector('.lift-btn[data-floor=\"3\"]').click()")
    for k, ms in enumerate([0, 1500, 3000, 4500, 6000, 8000]):
        page.evaluate(f"() => {{ const sc = window.__iotFortune.app.scene; sc.debugStepLift({ms if k == 0 else ms - [0, 1500, 3000, 4500, 6000, 8000][k - 1]}); sc.renderNow(); }}")
        pr = page.evaluate('() => window.__iotFortune.app.scene.elevatorProbe()')
        frames.append({'ms': ms, 'phase': pr['phase'], 'pos': round(pr['pos'], 4), 'door': round(pr['door'], 3), 'carY': round(pr['carY'], 4), 'doorGap': round(pr['doorGap'], 4)})
        page.locator('canvas').first.screenshot(path=f'{OUT}/lift-{ms:05d}.png')
    json.dump(frames, open(f'{OUT}/lift-frames.json', 'w'), indent=1)
    print('frames', json.dumps(frames), flush=True)
    page.evaluate("() => { const sc = window.__iotFortune.app.scene; sc.setPaused(false); }")
    if VISUAL_ONLY:
        b.close(); sys.exit(0)

    # กลับเวลาจริง (หน้าใหม่) สำหรับการสลับโหมด
    page.goto(f'{BASE}/?db=liftswitch2')
    page.wait_for_function('() => window.__iotFortune?.app?.scene?.elevatorProbe?.()', timeout=120000)
    page.wait_for_timeout(3000)
    cdp = page.context.new_cdp_session(page)

    s0 = page.evaluate(STATE)
    if not s0['base']:
        check('เริ่มต้น: ฉาก 3D ใช้บริการลิฟต์ชุดเดียวกับแอป', s0['scene'] and s0['scene']['sameSvc'] and not s0['scene']['ownSvc'])
    base_listeners, base_intervals = s0['listeners'], s0['intervals']
    heap0 = gc(page, cdp)

    # ---------------------------------------------------------------- 1–3) สลับ 20 รอบ ระหว่างลิฟต์วิ่ง
    page.evaluate("() => { const a = window.__iotFortune.app; if (a.elevator) a.elevator.setAuto(false); else a.scene.setLiftAuto(false); }")
    route = ['5', 'G', '4', '1', '3']
    jumps, incons, counts, heaps, restarts = [], [], [], [], 0
    base_diff = 0
    prev = page.evaluate(STATE)
    trips = 0
    for i in range(20):
        if prev['phase'] == 'open' and prev['atFloor'] is not None:
            nxt = route[trips % len(route)]; trips += 1
            if nxt == prev['atFloor']: nxt = route[trips % len(route)]; trips += 1
            page.evaluate(f"() => {{ window.__iotFortune.app.liftTo('{nxt}'); }}")  # ไม่รอให้ถึง (ลิฟต์ ddc56f0 ไม่เดินในโหมด 2D)
        mode = '2d' if i % 2 == 0 else '3d'
        before = page.evaluate(STATE)
        page.evaluate(f"() => window.__iotFortune.app.setViewMode('{mode}')")
        after = page.evaluate(STATE)
        # ต่อเนื่อง: ตำแหน่งหลังสลับ ห่างจากก่อนสลับไม่เกินระยะที่วิ่งได้ในเวลาที่ผ่านไป (0.85 ชั้น/วิ)
        # เวลาของตัวจำลองเอง (sim.t) — สถานะที่อ่านอาจตามหลังเวลาจริงได้ถึงหนึ่งรอบอัปเดต จึงห้ามใช้เวลานาฬิกาผนัง
        dt = max(0.0, (after['simT'] - before['simT']) / 1000)
        if abs(after['pos'] - before['pos']) > 0.85 * dt + 0.02: jumps.append((i, before['pos'], after['pos'], dt))
        if before['phase'] == 'moving' and after['phase'] == 'open' and after['atFloor'] == 'G' and before['target'] != 'G': restarts += 1
        for k in range(6):  # อ่านสถานะซ้ำระหว่างโหมดนี้
            page.wait_for_timeout(250)
            s = page.evaluate(STATE)
            if s['base'] and mode == '2d' and not s['panel']:
                base_diff += 1  # ddc56f0 ไม่มีแผงลิฟต์ในผัง 2D — Expected baseline difference
                continue
            bad = consistent(s)
            if bad: incons.append((i, mode, bad))
        counts.append((s['listeners'], s['intervals'], s['running']))
        if i in (0, 9, 19): heaps.append(gc(page, cdp))
        prev = s
    BASE_BUILD = s0['base']
    if BASE_BUILD:
        results.append(('บริการลิฟต์แยก (listeners/timer ของ ElevatorService)', None, 'N/A — ddc56f0 ไม่มี ElevatorService'))
    if not BASE_BUILD:
        check('สลับ 2D↔3D 20 รอบ: ผู้ฟังสถานะลิฟต์ไม่เพิ่ม', all(c[0] == base_listeners for c in counts), f'{base_listeners} → {sorted(set(c[0] for c in counts))}')
    check('สลับ 20 รอบ: จำนวนตัวจับเวลา (setInterval) ไม่เพิ่ม', all(c[1] == base_intervals for c in counts), f'{base_intervals} → {sorted(set(c[1] for c in counts))}')
    if not BASE_BUILD:
        check('สลับ 20 รอบ: ตัวจับเวลาของบริการลิฟต์ทำงานตลอด', all(c[2] for c in counts))
    check('สลับขณะลิฟต์วิ่ง: ตำแหน่งต่อเนื่อง ไม่กระโดด', not jumps, str(jumps[:3]))
    check('สลับขณะลิฟต์วิ่ง: ไม่เริ่มใหม่ที่ชั้น G', restarts == 0, str(restarts))
    check(f'ชั้น/ทิศ/เป้าหมาย/ประตู ตรงกันทั้งแผง 3D และผัง 2D ({20 * 6} ครั้ง)', not incons, str(incons[:3]))
    if base_diff:
        results.append(('แผงลิฟต์ในโหมด 2D', None, f'Expected baseline difference — ddc56f0 ไม่มีแผงลิฟต์ใน 2D ({base_diff} ครั้งที่อ่าน)'))
        print(f'BASELINE-DIFF แผงลิฟต์ในโหมด 2D — ddc56f0 ไม่มี ({base_diff} ครั้ง)', flush=True)
    sc_final = page.evaluate("() => { const a = window.__iotFortune.app; return { scenes: document.querySelectorAll('canvas').length, own: a.scene?.ownElevator }; }")
    check('ไม่มีฉาก 3D / canvas ซ้ำ', sc_final['scenes'] <= 1 and (BASE_BUILD or sc_final['own'] is False), json.dumps(sc_final))

    # ---------------------------------------------------------------- 4) หน่วยความจำ
    grow = [round((h - heap0) / 1e6, 2) for h in heaps]
    check('หน่วยความจำไม่เพิ่มต่อเนื่อง (หลัง GC รอบ 1/10/20 เทียบตอนเริ่ม)', not (grow[0] < grow[1] < grow[2] and grow[2] - grow[0] > 3), f'{round(heap0 / 1e6, 1)} MB, เพิ่ม {grow} MB')
    check('Console ไม่มี error', not errs, '; '.join(errs[:3]))
    page.screenshot(path=f'{OUT}/after-20.png')
    b.close()

bad = [r for r in results if r[1] is False]
json.dump([{'name': n, 'ok': o, 'detail': d} for n, o, d in results], open(f'{OUT}/results.json', 'w'), ensure_ascii=False, indent=1)
scored = [r for r in results if r[1] is not None]
print(f'\nสรุป: ผ่าน {len(scored) - len(bad)}/{len(scored)} · N/A {len(results) - len(scored)}')
sys.exit(1 if bad else 0)
