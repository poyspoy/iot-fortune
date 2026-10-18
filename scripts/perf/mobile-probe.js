/*
 * IoT ฟอร์จูน — ตัววัด Performance บนมือถือจริง (เครื่องมือทดสอบ ไม่ใช่ส่วนหนึ่งของแอป)
 *
 * ไม่ถูก build เข้า dist และไม่แก้โค้ดแอป ใช้ได้ 2 แบบ:
 *   1) Bookmarklet: `node scripts/perf/make-bookmarklet.mjs` → ได้ข้อความ javascript:... ไปตั้งเป็น Bookmark บนมือถือ
 *   2) Remote debugging (Android: chrome://inspect · iPhone: Safari Web Inspector บน Mac) → วางไฟล์นี้ใน Console
 *
 * ลำดับวัด (warm-up 2 วิ แล้ววัด 10 วิ ต่อกรณี):
 *   ทึบ · ทั้งอาคาร → โปร่งใส + ลิฟต์ → หนักสุด (โปร่งใส + คน + รถ + ลิฟต์ + สถานการณ์ทั้งสองเหตุการณ์) → ปิดทุก Layer (รอ 30 วิ)
 * ผลแสดงบนหน้าจอเป็นตาราง + ข้อความ JSON สำหรับคัดลอกส่งกลับ
 * ห้ามสลับแอป/ล็อกจอระหว่างวัด — ถ้าหน้าถูกซ่อนหรือเสียโฟกัส จะติดธง "ไม่ใช้ FPS" ให้อัตโนมัติ
 */
(() => {
  const A = window.__iotFortune && window.__iotFortune.app;
  if (!A || !A.scene || !A.scene.renderer) { alert('ยังไม่พร้อม: เปิดหน้า IoT ฟอร์จูนในโหมด 3D แล้วรอโมเดลโหลดเสร็จก่อน'); return; }
  if (window.__mp && !window.__mp.done) { alert('กำลังวัดอยู่'); return; }
  const r = A.scene.renderer, gl = r.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const P = { renders: 0, cpu: [], gpu: [], q: [], lt: [] };
  if (!r.__mpWrapped) {
    const orig = r.render.bind(r);
    r.render = function (s, c) {
      P.renders++;
      let q = null;
      if (ext && !P.active) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); P.active = true; }
      const t = performance.now(); orig(s, c); P.cpu.push(performance.now() - t);
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); P.active = false; P.q.push(q); }
      P.q = P.q.filter((x) => {
        if (!gl.getQueryParameter(x, gl.QUERY_RESULT_AVAILABLE)) return true;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) P.gpu.push(gl.getQueryParameter(x, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(x); return false;
      });
    };
    r.__mpWrapped = true;
  }
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => P.lt.push(e.duration))).observe({ type: 'longtask' }); } catch (e) { /* Safari ไม่มี longtask */ }
  const sorted = (x) => [...x].sort((a, b) => a - b);
  const med = (x) => (x.length ? +sorted(x)[x.length >> 1].toFixed(2) : null);
  const pct = (x, p) => (x.length ? +sorted(x)[Math.min(x.length - 1, Math.floor(x.length * p))].toFixed(1) : null);
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:auto 8px 8px 8px;z-index:99999;background:#111c;color:#fff;font:12px/1.4 system-ui;padding:8px;border-radius:8px;max-height:60vh;overflow:auto';
  box.textContent = 'กำลังเตรียมวัด… ห้ามสลับแอปหรือล็อกจอ';
  document.body.appendChild(box);

  async function measure(label, warm = 2000, dur = 10000) {
    box.textContent = `กำลังวัด: ${label} (ประมาณ ${Math.round((warm + dur) / 1000)} วิ) — ห้ามสลับแอป`;
    await wait(warm);
    const d = []; let last = performance.now(), lostFocus = 0, hidden = 0;
    P.renders = 0; P.cpu = []; P.gpu = []; P.lt = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const f = (now) => {
        d.push(now - last); last = now;
        if (!document.hasFocus()) lostFocus++;
        if (document.hidden) hidden++;
        if (now - t0 < dur) requestAnimationFrame(f); else res();
      };
      requestAnimationFrame(f);
    });
    const secs = (performance.now() - t0) / 1000, info = r.info, m = performance.memory;
    return {
      label,
      fps: +(d.length / secs).toFixed(1), renderFps: +(P.renders / secs).toFixed(1),
      medFrameMs: med(d), p95FrameMs: pct(d, 0.95),
      over50: d.filter((x) => x > 50).length, over100: d.filter((x) => x > 100).length,
      longTasks: P.lt.length, ltMax: P.lt.length ? Math.round(Math.max(...P.lt)) : 0,
      gpuMed: med(P.gpu), cpuMed: med(P.cpu),
      calls: info.render.calls, tris: info.render.triangles,
      geo: info.memory.geometries, tex: info.memory.textures, progs: info.programs ? info.programs.length : null,
      heapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null,
      usable: lostFocus === 0 && hidden === 0, framesLostFocus: lostFocus, framesHidden: hidden,
    };
  }

  const errs = [];
  const onErr = (e) => errs.push(e.target && e.target !== window ? 'resource ' + (e.target.src || e.target.href) : String(e.message));
  addEventListener('error', onErr, true);
  addEventListener('unhandledrejection', (e) => errs.push('rejection ' + e.reason));
  const scn = (id) => document.querySelector(`[data-testid=scn-${id}]`)?.click();

  window.__mp = { done: false };
  (async () => {
    const res = [];
    try {
      if (A.state.view !== 'overview' && A.changeView) A.changeView('overview');
      A.setViewMode && A.setViewMode('3d');
      A.showBuilding && A.showBuilding();
      A.setBuildingStyle('solid'); await A.setSim('people', false); await A.setSim('cars', false);
      res.push(await measure('ทึบ · ทั้งอาคาร'));
      A.setBuildingStyle('transparent'); A.liftTo('5');
      res.push(await measure('โปร่งใส + ลิฟต์'));
      await A.setSim('people', true); await A.setSim('cars', true); scn('both'); A.liftTo('G');
      res.push(await measure('หนักสุด: โปร่งใส + คน + รถ + ลิฟต์ + สถานการณ์', 4000));
      scn('reset'); await A.setSim('people', false); await A.setSim('cars', false); A.setBuildingStyle('solid');
      res.push(await measure('หลังจบ: ปิดทุก Layer · ทึบ (รอ 30 วิ)', 30000, 5000));
    } catch (e) { errs.push('probe ' + e); }
    removeEventListener('error', onErr, true);
    const device = {
      ua: navigator.userAgent, screen: `${screen.width}x${screen.height}`, viewport: `${innerWidth}x${innerHeight}`,
      dpr: devicePixelRatio, rendererPixelRatio: r.getPixelRatio(), canvas: `${r.domElement.width}x${r.domElement.height}`,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      cores: navigator.hardwareConcurrency || null, memGB: navigator.deviceMemory || null,
      url: location.href, at: new Date().toISOString(), gpuTimer: !!ext,
    };
    const out = { device, results: res, pageErrors: errs };
    window.__mp = { done: true, out };
    const row = (x) => `<tr><td>${x.label}</td><td>${x.fps}</td><td>${x.p95FrameMs}</td><td>${x.over50}</td><td>${x.gpuMed ?? '–'}</td><td>${x.heapMB ?? '–'}</td><td>${x.usable ? '✓' : '✗ ไม่ใช้'}</td></tr>`;
    box.innerHTML = `<b>ผลวัด (${device.gpu})</b><table style="width:100%;border-collapse:collapse"><tr><th align=left>กรณี</th><th>FPS</th><th>p95 ms</th><th>&gt;50ms</th><th>GPU ms</th><th>Heap</th><th>ใช้ได้</th></tr>${res.map(row).join('')}</table>`
      + `<div>Page error: ${errs.length}</div><textarea readonly style="width:100%;height:90px;font:10px monospace"></textarea>`
      + '<button>คัดลอกผล</button> <button>ปิด</button>';
    const ta = box.querySelector('textarea'); ta.value = JSON.stringify(out);
    const [copy, close] = box.querySelectorAll('button');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(ta.value); copy.textContent = 'คัดลอกแล้ว'; } catch (e) { ta.select(); document.execCommand('copy'); copy.textContent = 'คัดลอกแล้ว'; } };
    close.onclick = () => box.remove();
  })();
})();
