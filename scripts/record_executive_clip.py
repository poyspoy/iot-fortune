# คลิป Executive Demo: เปิดเว็บ (ไม่กดอะไร) ลิฟต์วิ่งอัตโนมัติ → ~18 วินาที กด "จำลองทั้งสองเหตุการณ์" → น้ำ เขียว→เหลือง→แดง
# เครื่องไม่มี GPU: ใช้นาฬิกาควบคุมของ Playwright (Date/ตัวจับเวลา/ข้อมูลจำลอง) + นาฬิกาลิฟต์ เดินพร้อมกันทีละ 1/FPS วินาที
# แต่ละเฟรมเป็นภาพหน้าจอจริงของหน้าเว็บทั้งหน้า (โมเดล หมุด แผงลิฟต์ เกจน้ำ ป้ายข้อมูลจำลอง)
import sys, os, time, json, random, shutil
from playwright.sync_api import sync_playwright
BASE=sys.argv[1]; FPS=float(sys.argv[2]); SECS=float(sys.argv[3]); W=int(sys.argv[4]); H=int(sys.argv[5]); TAG=sys.argv[6]
TRIG=float(os.environ.get('TRIG','18')); PR=float(os.environ.get('PR','0.7'))
OUT='/tmp/claude-0/sp/exec'; FR=os.path.join(OUT,f'f-{TAG}'); shutil.rmtree(FR, ignore_errors=True); os.makedirs(FR)
A='window.__iotFortune.app'
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    errs=[]; mobile=W<700
    pg=b.new_page(viewport={'width':W,'height':H}, is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
    pg.on('console', lambda m: m.type=='error' and errs.append(m.text))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    t0=time.time()
    pg.goto(f'{BASE}/?db=x{random.randint(1000,9999)}', timeout=120000)
    pg.wait_for_function(f'() => {{ const sc = window.__iotFortune?.app?.scene; return sc && sc.modelLoaded && !document.querySelector("[data-testid=model-loading]") && !sc.tween; }}', timeout=300000, polling=1000)
    pg.evaluate(f'() => {{ const sc = {A}.scene; sc.setPaused(true); sc.setManualClock(performance.now()); }}')
    if PR != 1: pg.evaluate(f"() => {{ const sc = {A}.scene; sc.renderer.setPixelRatio({PR}); const c=sc.renderer.domElement; sc.renderer.setSize(c.clientWidth, c.clientHeight, false); }}")
    print('ready', round(time.time()-t0,1), flush=True)
    tstart=time.time(); step=1000/FPS; log=[]; fired=False; tfired=False; TSTY=float(os.environ.get('TSTY','12'))
    for i in range(int(FPS*SECS)):
        t=i/FPS
        if not tfired and t>=TSTY:
            tfired=True
            pg.evaluate("() => document.querySelector('[data-testid=bstyle-transparent]').click()")
        if not fired and t>=TRIG:
            fired=True
            pg.evaluate("() => [...document.querySelectorAll('.demo-bar button')].find(b => b.textContent.includes('ทั้งสองเหตุการณ์')).click()")
            per=(time.time()-tstart)/max(1,i)
            spd=max(1, round(60*(1/FPS)/per, 2))
            pg.wait_for_timeout(300)
            pg.evaluate(f"() => window.__iotFortune.app.ctl.setDemoParams({{ speed: {spd} }})")
            print('speed', spd, 'per-frame', round(per,2), flush=True)
        pg.evaluate("() => window.__iotFortune.app.scene.styleProbe()")
        r=pg.evaluate(f"""(step) => {{ const a={A}, sc=a.scene; if (step) sc.debugStepLift(step); sc.renderNow(); const pr=sc.elevatorProbe();
          return {{ t: {t:.2f}, phase: pr.phase, pos: +pr.pos.toFixed(2), tgt: pr.target, w1: a.severityOf('WL-001'), w2: a.severityOf('WL-002'),
            v: [...document.querySelectorAll('.water-panel .wp-value, .water-panel [class*=value]')].map(e=>e.textContent).slice(0,2),
            badge: (() => {{ const e=document.querySelector('.sim-badge'); const r=e?.getBoundingClientRect(); return !!e && !e.hidden && r.width>0 && r.bottom<=innerHeight; }})() }}; }}""", step if i else 0)
        log.append(r)
        pg.screenshot(path=f'{FR}/{i:05d}.jpg', type='jpeg', quality=85, timeout=120000)
        if i%25==0: print(i, round(time.time()-t0,1), json.dumps(r, ensure_ascii=False), flush=True)
    json.dump(log, open(f'{OUT}/log-{TAG}.json','w'), ensure_ascii=False)
    print('errors', errs, 'total', round(time.time()-t0,1))
    b.close()
