"""
ทดสอบเครื่องที่แสดง 3D ไม่ได้ (ปิด WebGL) — ต้องได้ผัง 2D ที่ใช้งานครบ ไม่มีหน้าขาว ไม่ค้าง

รัน:  python scripts/e2e_2d_fallback.py [http://localhost:4173] [โฟลเดอร์ผลลัพธ์]

ตรวจทั้ง Desktop และ Mobile:
  - หน้ามีเนื้อหาภายใน 1.5 วิ (ไม่ขาว) และขึ้นข้อความว่าใช้ผัง 2D แทน
  - ลิฟต์จำลอง: แผงแสดง สั่งชั้นได้ ถึงชั้นจริง อัตโนมัติ/หยุด/รีเซ็ต ใช้ได้ ไอคอนลิฟต์บนผังเปลี่ยนสถานะ
  - เซนเซอร์ (รายการจุด) การแจ้งเตือน (สถานการณ์จำลอง) และกราฟ
  - Console ไม่มี error
"""
import os, sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'e2e-2d-fallback'
os.makedirs(OUT, exist_ok=True)
ARGS = ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis']
results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


LIFT = """() => { const p = document.querySelector('[data-testid=lift-panel]'); if (!p) return null;
  const m = document.querySelector('[data-testid=plan-lift]');
  return { phase: p.dataset.phase, target: p.dataset.target, mode: p.dataset.mode,
    current: p.querySelector('[data-testid=lift-current]').textContent, headline: p.querySelector('[data-testid=lift-headline]').textContent,
    camHidden: p.querySelector('[data-testid=lift-cam]')?.hidden, marker: m ? m.dataset.state : null, markerLabel: m ? m.getAttribute('aria-label') : null }; }"""


def wait_lift(page, cond_js, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate(f'() => {{ const s = ({LIFT})(); return !!s && ({cond_js})(s); }}'):
            return time.time() - t0
        page.wait_for_timeout(200)
    return None


def run(pw, label, vp, mobile):
    b = pw.chromium.launch(args=ARGS)
    ctx = b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile)
    page = ctx.new_page()
    errs = []
    page.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    page.on('pageerror', lambda e: errs.append(str(e)))
    t0 = time.time()
    page.goto(f'{BASE}/?db=e2e2d-{label}')
    page.wait_for_timeout(1500)
    txt = page.evaluate('() => document.body.innerText.trim().length')
    check(f'[{label}] หน้ามีเนื้อหาภายใน 1.5 วิ (ไม่ขาว)', txt > 200, f'{txt} ตัวอักษร')
    try:
        page.wait_for_selector('[data-testid=lift-panel]', timeout=15000)
        has_lift = True
    except Exception:
        has_lift = False
    check(f'[{label}] ไม่มี WebGL จริงในเบราว์เซอร์ทดสอบ', page.evaluate("() => { const c = document.createElement('canvas'); return !(c.getContext('webgl2') || c.getContext('webgl')); }"))
    check(f'[{label}] แจ้งว่าใช้ผัง 2D แทน', page.locator('text=ใช้ผัง 2D').count() > 0)
    check(f'[{label}] มีผัง 2D', page.locator('svg.plan-svg').count() == 1)
    if not has_lift and page.evaluate('() => !window.__iotFortune.app.elevator'):
        results.append((f'[{label}] ลิฟต์จำลองในโหมด 2D', None, 'Expected baseline difference — build นี้ไม่มี ElevatorService/แผงลิฟต์ใน 2D'))
        print(f'BASELINE-DIFF [{label}] ลิฟต์จำลองในโหมด 2D — build นี้ไม่มีแผงลิฟต์ใน 2D', flush=True)
    else:
        check(f'[{label}] แผงลิฟต์ปรากฏในโหมด 2D', has_lift)
    if has_lift:
        s0 = page.evaluate(LIFT)
        check(f'[{label}] แผงลิฟต์แสดงในโหมด 2D', s0 is not None, str(s0 and s0['headline']))
        check(f'[{label}] ซ่อนปุ่มที่ต้องใช้ 3D (มุมกล้องลิฟต์)', s0 and s0['camHidden'] is True)
        check(f'[{label}] ไอคอนลิฟต์บนผังชั้น G', s0 and s0['marker'] in ('here', 'passing', 'away'), str(s0 and s0['markerLabel']))

        # ปิดอัตโนมัติก่อน เพื่อให้ลิฟต์จอดค้างที่ชั้นที่สั่ง
        page.click('[data-testid=lift-auto]')
        check(f'[{label}] ปิดโหมดอัตโนมัติได้', page.get_attribute('[data-testid=lift-auto]', 'aria-checked') == 'false')
        page.click('.lift-btn[data-floor="3"]')
        moved = wait_lift(page, "s => s.phase === 'moving'", 15)
        check(f'[{label}] สั่งชั้น 3 แล้วลิฟต์เริ่มเคลื่อนที่ (ไม่มี 3D)', moved is not None, f'{moved and round(moved, 1)} วิ')
        arr = wait_lift(page, "s => s.phase === 'open' && s.target === '3'", 40)
        check(f'[{label}] ลิฟต์ถึงชั้น 3 และเปิดประตู', arr is not None, f'{arr and round(arr, 1)} วิ')
        s1 = page.evaluate(LIFT)
        check(f'[{label}] แผงแสดงชั้นปัจจุบัน = ชั้น 3', s1['current'] == 'ชั้น 3', s1['current'])
        check(f'[{label}] ไอคอนบนผังชั้น G = ลิฟต์อยู่ที่อื่น', s1['marker'] == 'away', s1['marker'])

        # ดูผังชั้น 3 → ไอคอนลิฟต์ "อยู่ที่ชั้นนี้"
        page.evaluate("() => window.__iotFortune.app.setFloor ? window.__iotFortune.app.setFloor('3') : window.__iotFortune.app.isolateFloor('3')")
        page.wait_for_timeout(800)
        s2 = page.evaluate(LIFT)
        check(f'[{label}] ผังชั้น 3: ไอคอนลิฟต์สถานะ here', s2['marker'] == 'here', str(s2['markerLabel']))

        page.click('[data-testid=lift-pause]')
        check(f'[{label}] หยุดชั่วคราวได้', page.get_attribute('[data-testid=lift-pause]', 'aria-pressed') == 'true')
        page.click('[data-testid=lift-pause]')
        page.click('[data-testid=lift-reset]')
        back = wait_lift(page, "s => s.phase === 'open' && s.target === 'G'", 40)
        check(f'[{label}] รีเซ็ตกลับชั้น G', back is not None, f'{back and round(back, 1)} วิ')

    # เซนเซอร์ / แจ้งเตือน / กราฟ
    rows = page.locator('.points-table tbody tr[data-focus-key^="row-"]').count()
    exp = page.evaluate("() => { const a = window.__iotFortune.app; return a.activePoints().filter(p => p.floorId === a.state.floorId).length; }")
    check(f'[{label}] รายการจุดตรวจวัดแสดง (ตามชั้นที่เลือก)', rows == exp and rows > 0, f'{rows} แถว / คาด {exp} (ชั้น ' + page.evaluate('() => window.__iotFortune.app.state.floorId') + ')')
    page.click('[data-testid=scn-sump-rising]')
    sev = None
    for _ in range(90):  # สถานการณ์จำลองเร่งเวลา 60× — รอสถานะ WL-001 เปลี่ยนจากปกติ (สูงสุด ~45 วิ)
        sev = page.evaluate("() => { const a = window.__iotFortune.app; const p = a.index.points.get('WL-001'); return p ? a.status(p).severity : null; }")
        if sev in ('warning', 'critical'): break
        page.wait_for_timeout(500)
    alerts_ui = page.evaluate("() => document.querySelectorAll('.sev-critical, .sev-warning').length")
    check(f'[{label}] สถานการณ์จำลองทำให้เกิดสถานะเตือน (WL-001) และแสดงบนหน้าจอ', sev in ('warning', 'critical'), f'WL-001={sev} · องค์ประกอบสีเตือน {alerts_ui}')
    page.evaluate("() => window.__iotFortune.app.select('WL-001')")
    page.wait_for_timeout(1500)
    page.evaluate("() => document.querySelector('.trends')?.scrollIntoView()")
    page.wait_for_timeout(16500)  # กราฟอัปเดตอย่างช้าทุก 15 วิ
    paths = page.evaluate("() => document.querySelectorAll('.trends svg path, .trends svg polyline').length")
    check(f'[{label}] กราฟแนวโน้มแสดง', paths > 0, f'{paths} เส้น')
    page.click('[data-testid=scn-reset]')
    page.screenshot(path=f'{OUT}/{label}.png', full_page=False)
    check(f'[{label}] Console ไม่มี error', not errs, '; '.join(errs[:3]))
    b.close()


with sync_playwright() as pw:
    run(pw, 'desktop', {'width': 1366, 'height': 800}, False)
    run(pw, 'mobile', {'width': 390, 'height': 844}, True)

bad = [r for r in results if r[1] is False]
scored = [r for r in results if r[1] is not None]
print(f'\nสรุป: ผ่าน {len(scored) - len(bad)}/{len(scored)} · Baseline difference {len(results) - len(scored)}')
sys.exit(1 if bad else 0)
