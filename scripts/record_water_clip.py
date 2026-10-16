"""
บันทึกภาพเคลื่อนไหวเซนเซอร์ระดับน้ำจำลอง (WL-001 บ่อสูบน้ำ ชั้น G, WL-002 ถังเก็บน้ำ ชั้น 4)
สถานการณ์ "จำลองทั้งสองเหตุการณ์": ค่าค่อย ๆ เปลี่ยน เขียว → เหลือง → แดง แล้ว "ปกติ" ค่อย ๆ กลับ

  python scripts/record_water_clip.py [http://localhost:4173] [โฟลเดอร์ผลลัพธ์]
"""
import os, sys, shutil, subprocess, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'water-clip'
FR = os.path.join(OUT, 'frames'); shutil.rmtree(FR, ignore_errors=True); os.makedirs(FR, exist_ok=True)
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
SET = "() => { const sc = window.__iotFortune.app.scene; return [...sc.floorGroups.values()].every(g => !g.anim && !g.fade) && !sc.tween; }"
n = 0
with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    pg.goto(f'{BASE}/?db=water{int(time.time())}')
    pg.wait_for_selector('[data-testid=water-panel]', timeout=120000)
    pg.wait_for_selector('[data-testid=model-loading]', state='detached', timeout=600000)
    pg.wait_for_function(SET, timeout=300000, polling=500)
    pg.evaluate("window.__iotFortune.app.openFloorFor('WL-001')")
    pg.wait_for_function("() => window.__iotFortune.app.scene.detailState('G') === 'ready'", timeout=120000, polling=500)
    pg.wait_for_function(SET, timeout=300000, polling=500)
    pg.evaluate("document.querySelector('.stage').scrollIntoView()")

    def shot():
        global n
        pg.evaluate("() => { const sc = window.__iotFortune.app.scene; sc.setPaused(true); sc.renderNow(); }")
        box = pg.locator('.stage').bounding_box()
        pg.screenshot(path=os.path.join(FR, f'{n:04d}.png'), clip={'x': box['x'], 'y': max(0, box['y']), 'width': box['width'], 'height': min(820, box['height'])}, timeout=120000)
        pg.evaluate("window.__iotFortune.app.scene.setPaused(false)")
        n += 1

    for _ in range(3): shot(); time.sleep(0.5)
    # บันทึกที่ความเร็ว 10× (ช้ากว่าปุ่มสาธิต 60×) เพื่อให้เห็นช่วงสีเหลืองชัดในคลิป
    pg.evaluate("window.__iotFortune.ctl.setDemoParams({ scenario: 'both', speed: 10 })")
    t0 = time.time()
    while time.time() - t0 < 240:
        shot()
        s = pg.evaluate("[document.querySelector('[data-testid=water-WL-001]').dataset.severity, document.querySelector('[data-testid=water-WL-002]').dataset.severity]")
        if s == ['critical', 'critical']:
            for _ in range(4): shot(); time.sleep(0.4)
            break
        time.sleep(0.3)
    pg.evaluate("window.__iotFortune.ctl.setDemoParams({ scenario: 'normal', speed: 10 })")
    t0 = time.time()
    while time.time() - t0 < 240:
        shot()
        s = pg.evaluate("[document.querySelector('[data-testid=water-WL-001]').dataset.severity, document.querySelector('[data-testid=water-WL-002]').dataset.severity]")
        if s == ['normal', 'normal']:
            for _ in range(3): shot(); time.sleep(0.4)
            break
        time.sleep(0.3)
    # กราฟแนวโน้มของจุดที่เลือก (WL-001)
    pg.evaluate("window.__iotFortune.app.scene.setPaused(true)")
    pg.evaluate("document.querySelector('.trends').scrollIntoView({block: 'center'})")
    pg.wait_for_timeout(800)
    pg.locator('.trends').screenshot(path=os.path.join(OUT, 'trend-WL-001.png'), timeout=120000)
    b.close()
gif = os.path.join(OUT, 'water-sensors.gif')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '2', '-i', os.path.join(FR, '%04d.png'), '-vf',
                'scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer', gif], check=True)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '2', '-i', os.path.join(FR, '%04d.png'), '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', os.path.join(OUT, 'water-sensors.mp4')], check=True)
print('frames', n, '→', gif)
