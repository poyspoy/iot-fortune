# Regression ของ Data Layer (Commit 4–6) บน Playground ข้อมูลทดลอง
#   python3 scripts/e2e_data_layer.py http://localhost:4195 out-dir
# ต้องใช้ build ที่เปิด Playground (DL_PLAYGROUND=1 หรือ build ของสาขา feature/data-layer บน Cloudflare)
import json, random, sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4195'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'e2e-data-layer'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
import os
os.makedirs(OUT, exist_ok=True)
results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


READY = "() => window.__iotFortune?.app?.scene?.detailProgress().building === 'ready'"
INFO = r"""() => { const { ctl, app } = window.__iotFortune; const sc = app.scene;
  return { playground: ctl.playground, points: app.activePoints().map((p) => p.id),
    markers: sc ? Object.fromEntries([...sc.markerObjs.entries()].map(([id, o]) => [id, { cls: o.btn.className, tag: o.btn.dataset.dl ?? null }])) : null,
    kpi: ctl.engine.kpis(), q: Object.fromEntries(ctl.config.points.map((p) => [p.id, ctl.engine.quality(p.id, p.metrics[0].id)])),
    review: ctl.spatial.service.reviewList().map((x) => `${x.code}:${x.issue}:${x.reasons.join('+')}`),
    inst: Object.fromEntries(ctl.spatial.service.doc.points.map((p) => [p.pointCode, p.installation.status])) } }"""


def wait_until(pg, js, timeout=60000):
    pg.wait_for_function(js, timeout=timeout, polling=250)


with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    db = f'data-layer-playground-e2e{random.randint(1000, 9999)}'
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Bangkok')
    pg = ctx.new_page()
    logs = []; net = []; NAV = {'on': False}  # NAV: ช่วงรีโหลดหลังกดรีเซ็ต — request ที่เบราว์เซอร์ยกเลิกเพราะเปลี่ยนหน้า (ERR_ABORTED) ไม่ใช่ข้อผิดพลาด
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    pg.on('requestfailed', lambda r: net.append(f"{'[รีโหลด] ' if NAV['on'] else ''}failed {r.url} {r.failure}"))
    pg.on('response', lambda r: net.append(f'{r.status} {r.url}') if r.status >= 400 else None)
    pg.goto(f'{BASE}/?db={db}')
    pg.wait_for_function(READY, timeout=300000, polling=500)
    pg.wait_for_timeout(2500)
    s = pg.evaluate(INFO)
    check('1 Playground เปิด · มีแถบ Playground และปุ่มรีเซ็ต', s['playground'] and pg.locator('[data-testid=pg-bar]').is_visible() and pg.locator('[data-testid=pg-reset]').is_visible())
    check('2 จุดทดลอง 4 จุดแสดงบนโมเดล (รวม 12 จุด)', len(s['points']) == 12 and all(x in s['points'] for x in ['PG-101', 'PG-102', 'PG-103', 'PG-104']), str(s['points']))

    # Installed / Commissioned: มีข้อมูล กราฟ KPI
    fresh = [k for k in ['WL-001', 'WL-002', 'P-003', 'P-004', 'P-005', 'P-006', 'P-007', 'P-008'] if s['q'][k] == 'fresh']
    check('3 จุดติดตั้งแล้ว/ส่งมอบแล้วมีข้อมูลสดใหม่ครบ 8 จุด · KPI นับ 8', len(fresh) == 8 and s['kpi']['activePoints'] == 8, f"{fresh} kpi={s['kpi']['activePoints']} inst P-006={s['inst']['P-006']}")
    pg.locator('tr[data-focus-key="row-P-006"]').click()
    pg.wait_for_timeout(1500)
    paths = pg.evaluate("() => document.querySelectorAll('.trends svg path, .trends svg polyline').length")
    status_txt = pg.locator('.details').inner_text()
    check('4 จุดส่งมอบแล้ว (P-006) มีกราฟและแสดงสถานะ "ส่งมอบใช้งานแล้ว"', paths > 0 and 'ส่งมอบใช้งานแล้ว' in status_txt, f'paths={paths}')

    # Proposed / Pending / Approved
    pre = {k: s['markers'][k] for k in ['PG-101', 'PG-102', 'PG-103']}
    ok_pre = all('q-not-installed' in v['cls'] and 'dl-pre' in v['cls'] and v['tag'] for v in pre.values()) and [pre[k]['tag'] for k in ['PG-101', 'PG-102', 'PG-103']] == ['เสนอ', 'รออนุมัติ', 'อนุมัติแล้ว']
    check('5 จุดเสนอ/รออนุมัติ/อนุมัติแล้ว: หมุดเส้นประ + ป้ายข้อความ · ไม่มีข้อมูล Sensor', ok_pre and all(s['q'][k] == 'not-installed' for k in pre), json.dumps(pre, ensure_ascii=False))
    pg.locator('tr[data-focus-key="row-PG-102"]').click()
    pg.wait_for_timeout(800)
    note = pg.locator('[data-testid=dl-install-note]')
    check('6 แผงรายละเอียดของจุดยังไม่ติดตั้ง: "ยังไม่ติดตั้ง — ไม่มีข้อมูล Sensor" และไม่นับ KPI', note.is_visible() and 'ไม่มีข้อมูล Sensor' in note.inner_text())
    fixed = ['P-003', 'P-004', 'P-006', 'P-007', 'P-008', 'WL-001', 'WL-002']
    check('7 หมุดของจุดติดตั้งแล้วไม่มีคลาส Data Layer (หน้าตาเดิม)', all(s['markers'][k]['cls'].startswith('marker sev-normal q-fresh') and ' dl-' not in s['markers'][k]['cls'] and s['markers'][k]['tag'] is None for k in fixed), json.dumps({k: s['markers'][k]['cls'] for k in fixed}, ensure_ascii=False))

    # Needs Remapping
    check('8 Needs Remapping: P-005 มีสัญลักษณ์ ! และอยู่ในรายการตรวจสอบ (ผังชั้นเปลี่ยน) · ปั๊มอยู่ในรายการ (manual)',
          'dl-remap' in s['markers']['P-005']['cls'] and 'P-005:needs-remapping:plan-changed' in s['review'] and 'FRT-DEMO-PUMP-001:needs-remapping:manual' in s['review'] and s['q']['P-005'] == 'fresh', str(s['review']))
    check('9 สถานะไม่ตรงกัน: AHU "เสนอ" แต่ P-004 ติดตั้งแล้ว → รายการตรวจสอบ 1 รายการ (P-004 ยังรับข้อมูล)', s['review'].count('P-004:status-mismatch:status-mismatch') == 1 and s['q']['P-004'] == 'fresh')

    # Alarm ของจุดติดตั้งแล้ว
    pg.locator('[data-testid="scn-sump-rising"]').click()
    pg.get_by_role('button', name='60×').click()
    try:
        wait_until(pg, "() => window.__iotFortune.ctl.engine.episodes().some((e) => e.pointId === 'WL-001')", 90000)
        alarm = True
    except Exception:
        alarm = False
    kpi_alert = pg.evaluate("() => window.__iotFortune.ctl.engine.kpis().unresolvedAlerts")
    check('10 แจ้งเตือนของจุดติดตั้งแล้วทำงาน (WL-001 ระดับน้ำบ่อสูง) · KPI แจ้งเตือน ≥ 1', alarm and kpi_alert >= 1, f'kpi={kpi_alert}')
    pg.locator('[data-testid="scn-normal"]').click()
    pg.get_by_role('button', name='1×').click()

    # 2D: หมุดเส้นประ / ! และอุปกรณ์ที่ตำแหน่งเดียวกับ 3D
    pg.evaluate("() => { const a = window.__iotFortune.app; a.changeView({ viewMode: '2d', floorId: 'G', isolated: true, selectedId: null }, { full: true }); }")
    pg.wait_for_selector('.plan-host .plan-svg')
    pg.wait_for_timeout(800)
    g2d = pg.evaluate("""() => ({ pre: [...document.querySelectorAll('.plan-marker.dl-pre')].map((g) => g.getAttribute('aria-label')),
      assets: [...document.querySelectorAll('.plan-asset')].map((g) => g.dataset.asset) })""")
    check('11 ผัง 2D ชั้น G: จุดเสนอติดตั้ง (PG-101) เส้นประ · แสดงบ่อ/ปั๊มจาก Data Layer', any('PG-101' in x for x in g2d['pre']) and set(g2d['assets']) == {'FRT-DEMO-PIT-001', 'FRT-DEMO-PUMP-001'}, json.dumps(g2d, ensure_ascii=False))
    pg.screenshot(path=f'{OUT}/2d-G.png')
    pg.evaluate("() => { const a = window.__iotFortune.app; a.changeView({ viewMode: '2d', floorId: '3', isolated: true, selectedId: null }, { full: true }); }")
    pg.wait_for_timeout(800)
    check('12 ผัง 2D ชั้น 3: P-005 มีสัญลักษณ์ ! (ต้องตรวจตำแหน่ง)', pg.locator('.plan-marker.dl-remap .dl-remap-badge').count() == 1)
    pg.screenshot(path=f'{OUT}/2d-3.png')
    match = pg.evaluate("""() => { const a = window.__iotFortune.app; const sp = a.ctl.spatial; const sc = a.scene; const svc = sp.service;
      const drawn = new Map(sc.equipmentPositions().map((x) => [x.assetId, x])); const out = [];
      for (const fl of ['G', '4']) for (const x of a.planAssets(fl)) {
        const asset = svc.assetByCode(svc.project.id, x.code); const f = svc.floor(asset.floorId); const d = drawn.get(asset.id);
        const [A, B, C, D, E, F] = f.frame.transform; const bx = A * x.u + B * x.v + C, bz = D * x.u + E * x.v + F;
        out.push([x.code, d ? Math.max(Math.abs(d.local.x - bx), Math.abs(d.local.z - bz)) : null]); }
      return out; }""")
    check('13 ถัง/บ่อ/ปั๊ม: ตำแหน่งบนผัง 2D = ตำแหน่งภาพ 3D (ต่างไม่เกิน 1e-4 จากการปัดเศษ 5 ตำแหน่ง)', len(match) == 4 and all(d is not None and d < 1e-4 for _, d in match), str(match))

    # หน้าตั้งค่า: Point/Asset/Binding + เปลี่ยนสถานะ
    pg.evaluate("() => window.__iotFortune.app.changeView({ viewMode: '3d', isolated: false, floorId: 'G' }, { full: true })")
    pg.wait_for_timeout(1500)
    pg.locator('[data-testid=pg-open]').click()
    pg.wait_for_selector('[data-testid=dl-view]')
    rows = pg.evaluate("() => ({ p: document.querySelectorAll('[data-testid^=dl-point-]').length, a: document.querySelectorAll('[data-testid^=dl-asset-]:not([data-testid*=match])').length })")
    matches = pg.evaluate("() => Object.fromEntries([...document.querySelectorAll('[data-testid^=dl-asset-match-]')].map((e) => [e.dataset.testid.slice(15), e.textContent]))")
    check('14 หน้าข้อมูลเชิงพื้นที่: Point 12 · Asset 5 · ถัง/บ่อ/ปั๊มทุกตัว "2D/3D ตรงกัน"', rows['p'] == 12 and rows['a'] == 5 and all('ตรงกัน' in matches.get(k, '') and '✓' in matches.get(k, '') for k in ['FRT-DEMO-PIT-001', 'FRT-DEMO-TANK-001', 'FRT-DEMO-TANK-002', 'FRT-DEMO-PUMP-001']), f'{rows} {matches}')
    pg.screenshot(path=f'{OUT}/settings-spatial.png', full_page=True)
    pg.locator('[data-testid=dl-inject]').click()
    pg.wait_for_timeout(800)
    aud = pg.evaluate("() => ({ c: window.__iotFortune.ctl.audit.counts, rows: window.__iotFortune.ctl.audit.list().map((e) => e.pointCode + ':' + e.reason), pts: window.__iotFortune.ctl.engine.entry('PG-101', 'leak') })")
    check('14b ส่งค่าเข้าจุดยังไม่ติดตั้ง → ถูกปฏิเสธ not-installed ครบ 4 จุด ขึ้นใน Audit · ไม่ถูกบันทึกเป็นข้อมูลจุด',
          aud['c'].get('not-installed') == 4 and sorted(aud['rows']) == sorted(f'{c}:not-installed' for c in ['PG-101', 'PG-102', 'PG-103', 'PG-104']) and not aud['pts'] and pg.locator('[data-testid=dl-audit-counts]').inner_text().find('4') >= 0, json.dumps(aud, ensure_ascii=False))
    pg.locator('[data-testid="inst-WL-001"]').select_option('proposed')
    wait_until(pg, "() => window.__iotFortune.ctl.decisionOf('WL-001').accept === false", 10000)
    s2 = pg.evaluate(INFO)
    check('15 เปลี่ยน WL-001 เป็น "เสนอ" → หยุดรับข้อมูล · KPI เหลือ 7 · คุณภาพ "ยังไม่ติดตั้ง"', s2['kpi']['activePoints'] == 7 and s2['q']['WL-001'] == 'not-installed', f"kpi={s2['kpi']['activePoints']} q={s2['q']['WL-001']}")
    pg.locator('[data-testid="inst-WL-001"]').select_option('installed')
    wait_until(pg, "() => window.__iotFortune.ctl.decisionOf('WL-001').accept === true", 10000)
    try:
        wait_until(pg, "() => window.__iotFortune.ctl.engine.quality('WL-001', 'level') === 'fresh'", 60000); back = True
    except Exception:
        back = False
    check('16 เปลี่ยนกลับเป็น "ติดตั้งแล้ว" → รับข้อมูลต่อและสดใหม่อีกครั้ง', back and pg.evaluate("() => window.__iotFortune.ctl.engine.kpis().activePoints") == 8)
    pg.locator('[data-testid="inst-FRT-DEMO-PUMP-001"]').select_option('decommissioned')
    wait_until(pg, "() => window.__iotFortune.ctl.decisionOf('P-003').reason === 'asset-retired'", 10000)
    pumps = pg.evaluate("() => window.__iotFortune.app.scene.pumps.length")
    check('17 ปั๊มปลดระวาง → จุด P-003 ถูกยับยั้ง (asset-retired) และภาพปั๊มหายจากโมเดล', pumps == 0)

    # ตำแหน่งที่ต้องตรวจสอบ: ยืนยันแล้วหาย
    pg.locator('[data-testid=settings-tab-review]').click()
    pg.wait_for_selector('[data-testid=dl-review]')
    n0 = pg.locator('[data-testid^=review-P-005]').count()
    btn = pg.locator('[data-testid=review-confirm-P-005]')
    btn.click(); btn.click()
    wait_until(pg, "() => !window.__iotFortune.ctl.spatial.service.reviewList().some((x) => x.code === 'P-005')", 10000)
    check('18 แท็บตำแหน่งที่ต้องตรวจสอบ: มี P-005 → กดยืนยันตำแหน่งแล้วหายจากรายการ (จุดไม่ถูกลบ)', n0 == 1 and 'P-005' in pg.evaluate(INFO)['points'])
    pg.screenshot(path=f'{OUT}/settings-review.png', full_page=True)
    pg.locator('[data-testid=settings-tab-review]').click()
    pg.locator('[data-testid=review-3d-FRT-DEMO-PUMP-001]').click() if pg.locator('[data-testid=review-3d-FRT-DEMO-PUMP-001]').count() else None
    pg.wait_for_timeout(1500)
    st = pg.evaluate("() => { const a = window.__iotFortune.app; return [a.state.view, a.state.viewMode, a.viewingFloorId()]; }")
    check('19 ปุ่ม "เปิดดูใน 3D" จากรายการตรวจสอบ → ไปชั้นของรายการนั้น', st == ['overview', '3d', 'G'], str(st))

    # รีเซ็ต Playground
    r = pg.locator('[data-testid=pg-reset]')
    r.click()
    NAV['on'] = True
    with pg.expect_navigation(timeout=60000):
        r.click()
    pg.wait_for_function(READY, timeout=300000, polling=500)
    NAV['on'] = False
    pg.wait_for_timeout(2500)
    s3 = pg.evaluate(INFO)
    check('20 รีเซ็ต Playground → กลับค่าเริ่มต้น (สถานะ/ตำแหน่ง/ปั๊ม/รายการตรวจสอบ)',
          s3['inst'] == s['inst'] and sorted(s3['review']) == sorted(s['review']) and pg.evaluate("() => window.__iotFortune.app.scene.pumps.length") == 1 and s3['kpi']['activePoints'] == 8,
          f"{s3['inst']} {s3['review']}")
    pg.screenshot(path=f'{OUT}/desktop-reset.png')
    check('21 Desktop: ไม่มี console error', not logs, '; '.join(logs[:3]))
    aborted = [x for x in net if x.startswith('[รีโหลด] ') and x.endswith('net::ERR_ABORTED')]
    real = [x for x in net if x not in aborted]
    print('   ยกเว้น (ยกเลิกเพราะรีโหลดหลังรีเซ็ต):', aborted, flush=True)
    check('22 Desktop: ไม่มี network error (ยกเว้นเฉพาะ request ที่ถูกยกเลิกเพราะรีโหลดหลังกดรีเซ็ต)', not real, '; '.join(real[:3]))
    ctx.close()

    # มือถือ
    mctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, timezone_id='Asia/Bangkok')
    m = mctx.new_page(); mlogs = []; mnet = []
    m.on('console', lambda x: mlogs.append(x.text) if x.type == 'error' else None)
    m.on('pageerror', lambda e: mlogs.append(f'pageerror: {e}'))
    m.on('response', lambda r: mnet.append(f'{r.status} {r.url}') if r.status >= 400 else None)
    m.goto(f'{BASE}/?db={db}m')
    m.wait_for_function(READY, timeout=300000, polling=500)
    m.wait_for_timeout(2000)
    m.evaluate('scrollTo(0, 0)')
    over = m.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    ms = m.evaluate(INFO)
    check('23 มือถือ 390: แถบ Playground แสดง · ไม่ล้นแนวนอน · หมุดยังไม่ติดตั้งมีป้าย', m.locator('[data-testid=pg-bar]').is_visible() and over and ms['markers']['PG-101']['tag'] == 'เสนอ')
    m.screenshot(path=f'{OUT}/mobile-top.png')
    m.locator('[data-testid=pg-open]').tap()
    m.wait_for_selector('[data-testid=dl-view]')
    m.wait_for_timeout(500)
    over2 = m.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    m.screenshot(path=f'{OUT}/mobile-settings.png', full_page=True)
    m.locator('[data-testid="inst-PG-101"]').select_option('installed')
    m.wait_for_function("() => window.__iotFortune.ctl.decisionOf('PG-101').accept === true", timeout=10000)
    check('24 มือถือ: หน้าข้อมูลเชิงพื้นที่ใช้งานได้ (ตารางเลื่อนในกรอบ ไม่ล้นหน้า) · เปลี่ยนสถานะได้', over2 and m.evaluate("() => window.__iotFortune.ctl.engine.quality('PG-101', 'leak')") == 'nodata')
    check('25 มือถือ: ไม่มี console error / network error', not mlogs and not mnet, '; '.join((mlogs + mnet)[:3]))
    mctx.close()

    # build เดียวกัน แต่ฐานข้อมูลปกติ → ไม่ใช่ Playground
    nctx = b.new_context(viewport={'width': 1440, 'height': 900})
    n = nctx.new_page(); nlogs = []
    n.on('console', lambda x: nlogs.append(x.text) if x.type == 'error' else None)
    n.goto(f'{BASE}/?db=dl-normal{random.randint(1000, 9999)}')
    n.wait_for_function(READY, timeout=300000, polling=500)
    n.wait_for_timeout(1500)
    ns = n.evaluate(INFO)
    n.evaluate("() => window.__iotFortune.app.setState({ view: 'settings', settingsTab: 'spatial' })")
    n.wait_for_selector('[data-testid=dl-view]')
    check('26 ฐานข้อมูลปกติบน build เดียวกัน: ไม่มี Playground/จุดทดลอง · หมุดเดิม · ดูข้อมูลเชิงพื้นที่ได้แต่แก้ไม่ได้',
          not ns['playground'] and n.locator('[data-testid=pg-bar]').count() == 0 and len(ns['points']) == 8 and ns['review'] == []
          and all(' dl-' not in v['cls'] for v in ns['markers'].values()) and n.locator('[data-testid^=inst-]').count() == 0, f"{ns['points']} {ns['review']}")
    check('27 ฐานข้อมูลปกติ: ไม่มี console error', not nlogs, '; '.join(nlogs[:3]))
    nctx.close()
    b.close()

passed = sum(1 for r in results if r[1])
json.dump(results, open(f'{OUT}/results.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'\nสรุป: ผ่าน {passed}/{len(results)}')
sys.exit(0 if passed == len(results) else 1)
