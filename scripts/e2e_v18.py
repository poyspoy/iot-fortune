# ชุดทดสอบเบราว์เซอร์ v1.8-demo (ตามข้อกำหนดเอกสารแนบ ข้อ 8) — ใช้ build เดียวกับที่ Deploy
import sys, json, random, time
from playwright.sync_api import sync_playwright
BASE=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:4173/'
A='window.__iotFortune.app'
res=[]
def ok(name, cond, detail=''):
    res.append((name, bool(cond), detail)); print(('PASS ' if cond else 'FAIL ')+name, detail, flush=True)
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    for dev, vp, mob in [('desktop',{'width':1280,'height':800},False),('mobile',{'width':390,'height':844},True)]:
        ctx=b.new_context(viewport=vp, is_mobile=mob, has_touch=mob)
        pg=ctx.new_page(); errs=[]
        pg.on('console', lambda m, e=errs: m.type=='error' and e.append(m.text))
        pg.on('pageerror', lambda x, e=errs: e.append(str(x)))
        pg.goto(BASE+f'?db=t{random.randint(1000,9999)}', timeout=180000)
        pg.wait_for_function('() => window.__iotFortune?.app?.scene?.modelLoaded', timeout=300000, polling=1000)
        pg.evaluate(f'() => {{ const sc={A}.scene; sc.setPaused(true); sc.setManualClock(performance.now()); }}')
        # 1) สลับทั้งอาคาร ↔ ชั้น 20 รอบ
        floors=['G','1','2','3','4','5']
        m0=pg.evaluate(f'() => {A}.scene.memoryProbe()')
        worst=0; dup=0; mixed=0
        for i in range(20):
            f=floors[i%6]
            pg.evaluate(f"() => {A}.isolateFloor('{f}')")
            pg.wait_for_function(f"() => ['ready','error','none'].includes({A}.scene.detailState('{f}'))", timeout=180000, polling=300)
            r=pg.evaluate(f"""() => {{ const sc={A}.scene; sc.renderNow(); const m=sc.memoryProbe();
               const vis=[...sc.floorGroups.values()].filter(g=>g.detailObj&&g.detailObj.visible).map(g=>g.floor.id);
               const per={{}}; sc.scene.traverse(o=>{{ if(o.name?.startsWith('detail-')) per[o.name]=(per[o.name]||0)+1; }});
               return {{ geos:m.geometries, objs:m.detailObjs, vis, maxPer: Math.max(0,...Object.values(per)) }}; }}""")
            worst=max(worst,r['geos']); dup=max(dup,r['maxPer'])
            if r['vis']!=[f]: mixed+=1
            pg.evaluate(f"() => {A}.showBuilding()")
            r2=pg.evaluate(f"() => {{ const sc={A}.scene; sc.renderNow(); return [...sc.floorGroups.values()].filter(g=>g.detailObj&&g.detailObj.visible).length; }}")
            if r2: mixed+=1
        m1=pg.evaluate(f'() => {A}.scene.memoryProbe()')
        ok(f'{dev}: สลับชั้น↔ทั้งอาคาร 20 รอบ ไม่มีโมเดลซ้ำ', dup<=1 and mixed==0, f'ซ้ำสูงสุด {dup}, แสดงผิดชั้น {mixed}')
        ok(f'{dev}: หน่วยความจำไม่เพิ่มต่อเนื่อง', m1['detailObjs']<= (2 if mob else 4) and worst < m0['geometries']+400, f"geometry เริ่ม {m0['geometries']} สูงสุด {worst} จบ {m1['geometries']} · แคช {m1['detailObjs']} ชั้น · ถอดออก {m1['evictions']}")
        # 2) เปิด–ปิดแต่ละเลเยอร์
        lay=pg.evaluate(f"""() => {{ const sc={A}.scene, out=[];
          for (const l of sc.layerList()) {{ if (l.future) {{ out.push([l.id, sc.setLayerVisible(l.id,true)===false]); continue; }}
            const ch=sc.sceneLayers.get(l.id).channel; sc.setLayerVisible(l.id,false); const off=!sc.camera.layers.isEnabled(ch);
            sc.setLayerVisible(l.id,true); const on=sc.camera.layers.isEnabled(ch) || l.id==='labels'; sc.renderNow(); out.push([l.id, off&&on]); }}
          return out; }}""")
        ok(f'{dev}: เปิด–ปิดเลเยอร์ทั้ง 11 (อนาคต 3 ปุ่มกดไม่ได้)', all(x[1] for x in lay), ', '.join(f"{a}{'✓' if b_ else '✗'}" for a,b_ in lay))
        # 3) ลิฟต์ตามคำสั่ง G→3→1→5→G (เดินนาฬิกาจำลอง) + ตรวจลำดับ ปิดประตู→วิ่ง→เปิดที่ชั้น
        lift=pg.evaluate(f"""() => {{ const sc={A}.scene, s=sc.lift.sim; sc.setLiftAuto(true);
          const go=(f)=>{{ sc.requestElevator(f); let n=0; while(!(s.phase==='open' && s.floors[s.target]===f && s.door>0.99) && n<6000){{ sc.debugStepLift(50); n++; }}
            return {{ f, ok: s.phase==='open' && s.floors[s.target]===f, t: n*50, carOff: Math.abs(sc.elevatorProbe().carY - sc.elevatorProbe().levels[f]) }}; }};
          const out=[]; out.push(go('G')); for (const f of ['3','1','5','G']) out.push(go(f)); return out; }}""")
        ok(f'{dev}: ลิฟต์ G→3→1→5→G จอดตรงระดับพื้นทุกชั้น', all(x['ok'] and x['carOff']<0.01 for x in lift), ' · '.join(f"{x['f']} {x['t']/1000:.1f}s" for x in lift))
        rt=pg.evaluate(f"""() => {{ const sc={A}.scene, s=sc.lift.sim; const step=(c)=>{{ let n=0; while(!c() && n<6000){{ sc.debugStepLift(50); n++; }} }};
          sc.setLiftAuto(false); step(()=>s.phase==='open'||s.phase==='closed'); sc.requestElevator('G'); step(()=>s.phase==='open' && s.floors[s.target]==='G' && s.door>0.99);
          s.log.length=0; sc.requestElevator('5'); step(()=>s.phase==='moving' && s.pos>1.2);
          const at=s.pos, vAt=s.vel; const r1=s.request('4', sc.manualNow); const r2=s.request('G', sc.manualNow);
          let minV=9; let n=0; while(!(s.phase==='open' && s.door>0.99) && n<6000){{ sc.debugStepLift(50); n++; if (s.phase==='moving' && s.pos<3.5) minV=Math.min(minV, s.vel); }}
          const first=s.floors[s.target]; const stops=s.log.filter(e=>e.type==='arrived').map(e=>e.floor);
          step(()=>s.phase==='open' && s.floors[s.target]==='G' && s.door>0.99); const stops2=s.log.filter(e=>e.type==='arrived').map(e=>e.floor);
          sc.setLiftAuto(true);
          return {{ at:+at.toFixed(2), vAt:+vAt.toFixed(2), r1, r2, first, minV:+minV.toFixed(2), stops2 }}; }}""")
        ok(f'{dev}: เปลี่ยนเป้าหมายระหว่างวิ่ง (5→4) ต่อจากตำแหน่งเดิม', rt['first']=='4' and rt['r1']=='retargeted' and rt['r2']=='queued' and rt['minV']>0.3 and rt['stops2']==['4','G'], json.dumps(rt, ensure_ascii=False))
        # 4) ระดับน้ำ ปกติ → เฝ้าระวัง → วิกฤต และสีเดียวกันทุกที่
        pg.evaluate(f"() => {A}.setDemoScenario('both')")
        seq=[]; t0=time.time()
        while time.time()-t0<120:
            s=pg.evaluate(f"""() => {{ const a={A}; const card=document.querySelector('.water-panel [data-severity]');
              const t=a.scene.tanks.get('WL-001'); const mk=a.scene.markerObjs.get('WL-001'); const ms=(mk.btn.className.match(/sev-(\\w+)/)||[])[1];
              return [card?.dataset.severity, ms, '#'+t.waterMat.color.getHexString(), a.severityOf('WL-001')]; }}""")
            if not seq or seq[-1][:3]!=s[:3]: seq.append(s)
            if s[0]=='critical' and s[1]=='critical' and s[2]=='#d0473f': break
            pg.wait_for_timeout(700)
        order=[x[0] for x in seq]
        ok(f'{dev}: ระดับน้ำ ปกติ→เฝ้าระวัง→วิกฤต (ค่า เกจ สีถัง ใช้สถานะเดียวกัน: การ์ด/หมุด/สีน้ำ)', order[0]=='normal' and 'warning' in order and order[-1]=='critical' and all((x[0]==x[1]) and x[2]=={'normal':'#2a8fd0','warning':'#e0a52a','critical':'#d0473f'}[x[0]] for x in seq), ' → '.join(f'{x[0]}/{x[1]}/{x[2]}' for x in seq))
        # 5) รูปแบบอาคาร 10 รอบ
        st=pg.evaluate(f"""() => {{ const sc={A}.scene; const base=sc.styleProbe();
          for (let i=0;i<10;i++) for (const k of ['transparent','wire','solid']) {{ sc.setBuildingStyle(k, {{instant:true}}); sc.renderNow(); }}
          const end=sc.styleProbe(); return {{ same: end.matHash===base.matHash && end.swapped===0, ghost: end.ghostCache, edges: end.edgeCache }}; }}""")
        ok(f'{dev}: รูปแบบอาคาร ทึบ→โปร่งใส→โครง→ทึบ 10 รอบ วัสดุคืนครบ', st['same'], json.dumps(st))
        ok(f'{dev}: ไม่มี Console Error', not errs, '; '.join(errs[:3]))
        ctx.close()
    b.close()
print('\nสรุป', sum(r[1] for r in res), '/', len(res))
