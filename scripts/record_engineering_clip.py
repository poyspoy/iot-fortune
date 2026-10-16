# คลิปเปิด–ปิดเลเยอร์แบบวิศวกรรม (3D → 2D) — ภาพหน้าจอจริงทุกเฟรม; ลิฟต์เดินด้วยนาฬิกาจำลองต่อเนื่อง
import os, random, shutil, time, json
from playwright.sync_api import sync_playwright
A='window.__iotFortune.app'; OUT='/tmp/claude-0/sp/eng'; FR=f'{OUT}/frames'; FPS=4
shutil.rmtree(FR, ignore_errors=True); os.makedirs(FR)
def click(pg, sel): pg.evaluate(f"() => document.querySelector('{sel}').click()")
STEPS = {  # วินาที → การกระทำ
  0.0: ('eng', None), 2.5: ('uncheck', 'structure'), 5.0: ('uncheck', 'electrical'), 7.5: ('all', None),
  9.5: ('solo', 'electrical'), 12.0: ('solo', 'plumbing'), 14.5: ('all', None), 16.0: ('pick3d', 'PLB-GV-01'),
  18.5: ('view', '2d'), 20.5: ('solo', 'structure'), 22.5: ('solo', 'electrical'), 24.5: ('zoom', 2), 26.5: ('all', None), 28.0: ('pick2d', 'PLB-CV-01'),
}
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    errs=[]
    pg=b.new_page(viewport={'width':1440,'height':960})
    pg.on('console', lambda m: m.type=='error' and errs.append(m.text))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://localhost:4173/?db=c{random.randint(1000,9999)}', timeout=120000)
    pg.wait_for_function('() => window.__iotFortune?.app?.scene?.modelLoaded', timeout=300000, polling=1000)
    click(pg, '[data-testid=eng-toggle]')
    pg.wait_for_function(f"() => {A}.scene.engProbe() && {A}.scene.detailState('G')==='ready' && !{A}.scene.tween", timeout=180000, polling=500)
    pg.wait_for_timeout(1500)
    pg.evaluate(f'() => {{ const sc={A}.scene; sc.setPaused(true); sc.setManualClock(performance.now()); sc.renderer.setPixelRatio(0.8); const c=sc.renderer.domElement; sc.renderer.setSize(c.clientWidth, c.clientHeight, false); }}')
    pend=sorted(STEPS.items()); log=[]
    for i in range(int(FPS*31)):
        t=i/FPS
        while pend and pend[0][0] <= t:
            _, (act, arg) = pend.pop(0)
            if act=='uncheck': click(pg, f'[data-testid=eng-layer-{arg}]')
            elif act=='solo': click(pg, f'[data-testid=eng-solo-{arg}]')
            elif act=='all': click(pg, '[data-testid=eng-all]')
            elif act=='view': click(pg, f'[data-testid=eng-view-{arg}]')
            elif act=='zoom': click(pg, f'[data-testid=eng-zoom-{arg}]')
            elif act=='pick3d':
                pt=pg.evaluate(f"() => {{ {A}.scene.renderNow(); return {A}.scene.engScreenPoint('{arg}'); }}"); pg.mouse.click(pt['x'], pt['y'])
            elif act=='pick2d': pg.evaluate(f"() => document.querySelector('.eng-2d [data-id=\"{arg}\"]').dispatchEvent(new MouseEvent('click', {{bubbles:true}}))")
            log.append((t, act, arg, pg.evaluate(f'() => {A}.scene.engProbe().vis')))
        pg.evaluate(f'() => {{ const sc={A}.scene; sc.debugStepLift({1000/FPS}); sc.renderNow(); }}')
        pg.screenshot(path=f'{FR}/{i:05d}.jpg', type='jpeg', quality=85, timeout=120000)
    print(json.dumps(log, ensure_ascii=False)); print('lift', pg.evaluate(f'() => {A}.scene.elevatorStatus().mode')); print('errors', errs)
    b.close()
