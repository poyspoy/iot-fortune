import './style.css';
import { Controller } from './app/controller.js';
import { App } from './ui/app.js';

async function boot() {
  const root = document.getElementById('app');
  // ใช้ฐานข้อมูลแยกได้ด้วย ?db=ชื่อ (สำหรับทดสอบ ไม่ปนกับข้อมูลใช้งาน)
  const dbParam = new URLSearchParams(location.search).get('db');
  const dbName = dbParam && /^[\w-]{1,40}$/.test(dbParam) ? `iot-fortune-${dbParam}` : undefined;
  const ctl = new Controller({ dbName });
  try {
    await ctl.init();
  } catch (e) {
    root.replaceChildren();
    const p = document.createElement('p');
    p.className = 'fatal';
    p.textContent = `เริ่มแอปไม่ได้: ${e.message} — แอปต้องใช้ IndexedDB ของเบราว์เซอร์ (โหมดส่วนตัวบางแบบอาจปิดไว้)`;
    root.appendChild(p);
    return;
  }
  const app = new App(root, ctl);
  try {
    app.sceneModule = await import('./scene/scene3d.js');
  } catch (e) {
    app.sceneError = `โหลดโมดูล 3D ไม่ได้: ${e.message}`;
  }
  if (!app.sceneModule && !app.sceneError) app.sceneError = 'ไม่มีโมดูล 3D';
  if (app.sceneError && app.state.viewMode === '3d') app.state.viewMode = '2d';
  await app.start();
  window.__iotFortune = { ctl, app }; // สำหรับตรวจสอบ/ดีบักในเบราว์เซอร์
}

boot();
