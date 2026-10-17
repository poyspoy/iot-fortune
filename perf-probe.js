/* NEXZA perf probe — ใช้เฉพาะสำเนาทดสอบ (ไม่ใช่โค้ดของแอป) · วัดเวลาโหลด, FPS, เวลาเฟรม CPU/GPU, Draw calls, Triangles, หน่วยความจำ, Console error */
(() => {
  if (window.__perf) return;
  const P = window.__perf = { lt: [], errors: [], frames: [], ready: null, hiddenAt: [], label: document.currentScript?.dataset.label || 'live-site', embed: !!document.currentScript?.dataset.embed };
  document.addEventListener('visibilitychange', () => P.hiddenAt.push([Math.round(performance.now()), document.visibilityState]));
  const t0 = performance.now();
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  const oe = console.error.bind(console); console.error = (...a) => { P.errors.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  addEventListener('error', (e) => P.errors.push('error: ' + (e.message || e.target?.src || '').slice(0, 200)), true);
  addEventListener('unhandledrejection', (e) => P.errors.push('reject: ' + String(e.reason).slice(0, 200)));
  // บันทึกช่วงห่างระหว่างเฟรมตลอดเวลา (ใช้แยก "ช่วงโหลด" กับ "หลังโหลดเสร็จ")
  let last = null; const tick = (now) => { if (last != null) P.frames.push([Math.round(now), +(now - last).toFixed(1)]); last = now; if (P.frames.length > 40000) P.frames.splice(0, 10000); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  const mem = () => { const sc = window.__iotFortune?.app?.scene; return { heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null, geo: sc?.renderer.info.memory.geometries, tex: sc?.renderer.info.memory.textures, programs: sc?.renderer.info.programs?.length }; };
  P.mem = mem;
  const st = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  const fpsOf = (fr) => { const tot = fr.reduce((a, b) => a + b, 0); const secs = []; let acc = 0, n = 0; for (const d of fr) { acc += d; n++; if (acc >= 1000) { secs.push(n * 1000 / acc); acc = 0; n = 0; } } return { avg: tot ? +(fr.length * 1000 / tot).toFixed(1) : null, minPerSec: secs.length ? +Math.min(...secs).toFixed(1) : null, jank50: fr.filter((d) => d > 50).length, jank100: fr.filter((d) => d > 100).length, worstMs: fr.length ? Math.round(Math.max(...fr)) : null }; };
  const ltIn = (a, b) => { const x = P.lt.filter(([s]) => s >= a && s < b); return { n: x.length, totalMs: x.reduce((s, y) => s + y[1], 0), maxMs: Math.max(0, ...x.map((y) => y[1])) }; };
  // ต่อเข้ากับ renderer ของแอปเมื่อพร้อม: จับเวลา CPU ของ render() และเวลา GPU (EXT_disjoint_timer_query_webgl2)
  const hook = () => {
    const sc = window.__iotFortune?.app?.scene; if (!sc) return false; if (P.hooked) return true; P.hooked = true;
    const r = sc.renderer; const gl = r.getContext(); const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    P.env = { gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), gpuTimer: !!ext, dpr: devicePixelRatio, ua: navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 140), cores: navigator.hardwareConcurrency, devMemGB: navigator.deviceMemory ?? null };
    const orig = r.render.bind(r); P.cpu = []; P.gpu = []; P.info = []; P.rec = false; let busy = false; let pend = [];
    r.render = (s, c) => {
      let q = null; if (ext && P.rec && !busy) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); busy = true; }
      const t = performance.now(); orig(s, c); const d = performance.now() - t;
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); busy = false; pend.push(q); }
      if (P.rec) { P.cpu.push(d); P.info.push([r.info.render.calls, r.info.render.triangles]); }
      if (ext && pend.length) pend = pend.filter((qq) => { if (gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) { if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && P.rec) P.gpu.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(qq); return false; } return true; });
    };
    return true;
  };
  const isReady = () => { const sc = window.__iotFortune?.app?.scene; return !!(sc && sc.modelLoaded && !document.querySelector('[data-testid=model-loading]:not(.done)') && sc.renderer.info.render.frame > 2); };
  const poll = () => { hook(); if (!P.ready && isReady()) { P.ready = Math.round(performance.now()); P.memReady = mem(); return; } setTimeout(poll, 50); }; poll();
  P.loadReport = () => {
    const n = performance.getEntriesByType('navigation')[0] ?? {}; const res = performance.getEntriesByType('resource');
    const big = res.filter((r) => /\.glb|rooms-|manifest|floor-G\.json|scene3d|main-/.test(r.name)).map((r) => [r.name.split('/').pop().slice(0, 28), Math.round(r.startTime), Math.round(r.responseEnd), Math.round((r.encodedBodySize || r.transferSize || 0) / 1024)]);
    const rd = P.ready ?? Math.round(performance.now());
    return { label: P.label, ttfbMs: Math.round(n.responseStart ?? -1), fcpMs: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1), domReadyMs: Math.round(n.domContentLoadedEventEnd ?? -1), loadEventMs: Math.round(n.loadEventEnd ?? -1),
      modelReadyMs: P.ready, downloadKB: Math.round(res.reduce((a, r) => a + (r.encodedBodySize || r.transferSize || 0), 0) / 1024), files: big,
      loadPhase: { frames: fpsOf(P.frames.filter(([t]) => t <= rd).map((x) => x[1])), longTasks: ltIn(0, rd) }, memAtReady: P.memReady };
  };
  // หมุน + ซูมกล้องต่อเนื่อง (แทนการลากเมาส์/บีบนิ้ว) แล้ววัดผล
  P.toBuilding = async () => { const a = window.__iotFortune.app; if (a.state.isolated) a.showBuilding(); await new Promise((r) => setTimeout(r, 300)); a.scene.preset('all', { instant: true }); await new Promise((r) => setTimeout(r, 1500)); };
  P.run = (ms = 10000) => new Promise((res) => {
    const sc = window.__iotFortune.app.scene; hook(); sc.tween = null; sc.autoFit = false; sc.simFollow = null;
    const tgt = sc.controls.target.clone(); const off = sc.camera.position.clone().sub(tgt); const R = Math.hypot(off.x, off.z); const a0 = Math.atan2(off.x, off.z);
    P.cpu = []; P.gpu = []; P.info = []; const m0 = mem(); const s0 = performance.now(); P.rec = true;
    const step = (now) => { const k = (now - s0) / ms; const a = a0 + k * Math.PI * 1.2; const z = 1 + 0.35 * Math.sin(k * Math.PI * 4);
      sc.camera.position.set(tgt.x + Math.sin(a) * R * z, tgt.y + off.y * z, tgt.z + Math.cos(a) * R * z); sc.camera.lookAt(tgt);
      if (now - s0 < ms) requestAnimationFrame(step); else { P.rec = false; const fr = P.frames.filter(([t]) => t > s0 + 100).map((x) => x[1]);
        const a = window.__iotFortune.app; res({ hiddenDuring: P.hiddenAt.some(([t]) => t >= s0 && t <= s0 + ms), view: { isolated: a.state.isolated ? a.state.floorId : 'ทั้งอาคาร', style: a.state.buildingStyle, canvas: [sc.renderer.domElement.width, sc.renderer.domElement.height] }, fps: fpsOf(fr), frameMs: st(fr), cpuRenderMs: st(P.cpu), gpuMs: st(P.gpu), drawCalls: st(P.info.map((x) => x[0])), triangles: st(P.info.map((x) => x[1])), longTasks: ltIn(s0, s0 + ms), memBefore: m0, memAfter: mem() }); } };
    requestAnimationFrame(step);
  });
  // อยู่นิ่ง (ลิฟต์/เซนเซอร์ยังทำงาน) แล้ววัด FPS และหน่วยความจำเป็นช่วง ๆ
  P.idle = (ms = 300000, every = 30000) => new Promise((res) => {
    const s0 = performance.now(); const samples = []; hook();
    const f = () => { const now = performance.now(); const fr = P.frames.filter(([t]) => t > now - every).map((x) => x[1]); samples.push({ t: Math.round((now - s0) / 1000), fps: fpsOf(fr).avg, minPerSec: fpsOf(fr).minPerSec, ...mem() }); if (now - s0 >= ms) res(samples); else setTimeout(f, every); };
    samples.push({ t: 0, ...mem() }); setTimeout(f, every);
  });
  // ตั้งค่ากรณีทดสอบ 3: เปิดคน รถ ลิฟต์ เซนเซอร์ กราฟ และโหมดโปร่งใสพร้อมกัน
  P.case3 = async () => {
    const a = window.__iotFortune.app; const sc = a.scene;
    if (a.setSim) { await a.setSim('people', true); await a.setSim('cars', true); }
    a.setBuildingStyle?.('transparent');
    for (const id of ['elevator', 'sensors', 'markers']) try { sc.setLayerVisible(id, true); } catch (e) {}
    document.querySelector('.wp-card')?.click(); // เลือกเซนเซอร์น้ำ → แสดงกราฟแนวโน้ม
    await new Promise((r) => setTimeout(r, 1500));
    await P.toBuilding(); // กลับมุมทั้งอาคาร (เทียบกับกรณีปิดได้ตรงกัน)
    await new Promise((r) => setTimeout(r, 1500));
    return { sim: sc.simLayers ? sc.simLayers.counts() : 'ไม่มีในเวอร์ชันนี้', style: a.state.buildingStyle, trendCharts: document.querySelectorAll('.trends canvas, .trends svg').length, lift: sc.elevatorProbe?.()?.phase };
  };
  P.heavy = async () => {
    const a = window.__iotFortune.app; const sc = a.scene;
    a.setBuildingStyle?.('transparent');
    for (const id of ['elevator', 'sensors', 'markers']) try { sc.setLayerVisible(id, true); } catch (e) {}
    document.querySelector('.wp-card')?.click(); // เลือกเซนเซอร์น้ำ → กราฟแนวโน้ม
    await new Promise((r) => setTimeout(r, 1500));
    await P.toBuilding(); await new Promise((r) => setTimeout(r, 2500));
    return { style: a.state.buildingStyle, trendCharts: document.querySelectorAll('.trends svg, .trends canvas').length, selected: a.state.selectedId, lift: sc.elevatorProbe?.()?.phase };
  };
  // ---------------- แผงควบคุมขนาดเล็ก (สำหรับผู้ทดสอบบนมือถือ/เดสก์ท็อป ไม่ต้องติดตั้งอะไร)
  const ui = () => {
    if (!document.body) return setTimeout(ui, 100);
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#0f2022;color:#e8f1ec;font:12px/1.4 system-ui,sans-serif;border-radius:10px;padding:8px;max-width:min(92vw,420px);box-shadow:0 4px 16px rgba(0,0,0,.4)';
    box.innerHTML = '<b>⏱ วัดประสิทธิภาพ</b> <span id="pp-st"></span><div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px"><button data-a="run">1) หมุน–ซูม 10 วิ</button><button data-a="c3">2) เปิดทุกอย่าง + หมุน–ซูม</button><button data-a="idle">3) ทิ้งไว้ 5 นาที</button><button data-a="copy">คัดลอกผล</button><button data-a="hide">ย่อ</button></div><pre id="pp-out" style="white-space:pre-wrap;max-height:40vh;overflow:auto;margin:6px 0 0;font-size:11px"></pre>';
    for (const b of box.querySelectorAll('button')) b.style.cssText = 'font:12px system-ui;padding:4px 8px;border-radius:6px;border:0;background:#2f8f83;color:#fff';
    document.body.appendChild(box);
    const out = box.querySelector('#pp-out'); const stEl = box.querySelector('#pp-st');
    P.results = {}; const show = () => { out.textContent = JSON.stringify(P.results, null, 1); };
    const status = () => { stEl.textContent = P.ready ? `· พร้อมใช้ ${(P.ready / 1000).toFixed(1)} วิ` : '· กำลังโหลด…'; if (!P.ready) setTimeout(status, 300); else { P.results.load = P.loadReport(); P.results.env = P.env; show(); } }; status();
    box.addEventListener('click', async (e) => {
      const act = e.target.dataset?.a; if (!act) return;
      if (act === 'hide') { out.style.display = out.style.display === 'none' ? '' : 'none'; return; }
      if (act === 'copy') { const t = JSON.stringify(P.results); try { await navigator.clipboard.writeText(t); stEl.textContent = '· คัดลอกแล้ว'; } catch (er) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); stEl.textContent = '· คัดลอกแล้ว'; } return; }
      if (!P.ready) { stEl.textContent = '· รอโมเดลโหลดเสร็จก่อน'; return; }
      stEl.textContent = '· กำลังวัด… อย่าแตะหน้าจอ';
      if (act === 'run') { await P.toBuilding(); P.results.case_off = await P.run(10000); }
      if (act === 'c3') { P.results.case3_setup = await P.case3(); P.results.case3 = await P.run(10000); }
      if (act === 'idle') { P.results.idle5min = await P.idle(300000, 30000); }
      P.results.errors = P.errors.slice(0, 20); P.results.env = P.env; show(); stEl.textContent = '· เสร็จ';
    });
  };
  if (!P.embed) ui();
})();
