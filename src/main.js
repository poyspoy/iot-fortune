import './style.css';
import { Controller } from './app/controller.js';
import { App } from './ui/app.js';
import { playgroundEnabled, PLAYGROUND_DB } from './data/playground.js';

/* global __DL_PLAYGROUND__ */
const DL_PLAYGROUND_BUILD = typeof __DL_PLAYGROUND__ !== 'undefined' && __DL_PLAYGROUND__ === true;

async function boot() {
  const root = document.getElementById('app');
  // ใช้ฐานข้อมูลแยกได้ด้วย ?db=ชื่อ (สำหรับทดสอบ ไม่ปนกับข้อมูลใช้งาน)
  // build ของ Preview Data Layer: ไม่ระบุ ?db= = เปิด Playground ข้อมูลทดลอง (ไม่ใช้ฐานข้อมูลปกติ)
  const dbParam = new URLSearchParams(location.search).get('db') ?? (DL_PLAYGROUND_BUILD ? PLAYGROUND_DB : null);
  const dbName = dbParam && /^[\w-]{1,40}$/.test(dbParam) ? `iot-fortune-${dbParam}` : undefined;
  const playground = playgroundEnabled({ buildFlag: DL_PLAYGROUND_BUILD, dbParam, hostname: location.hostname });
  let ctl = new Controller({ dbName, playground });
  try {
    try {
      await ctl.init();
    } catch (e) {
      // เบราว์เซอร์/กรอบที่ปิด IndexedDB (เช่นโหมดส่วนตัวบางแบบ) → ใช้ฐานข้อมูลในหน่วยความจำ ข้อมูลหายเมื่อปิดหน้า
      const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
      ctl = new Controller({ dbName, playground, idb: { indexedDB: new IDBFactory(), IDBKeyRange } });
      await ctl.init();
      ctl.configWarning = `บันทึกลงเครื่องไม่ได้ในหน้านี้ (${e.message}) — ใช้หน่วยความจำชั่วคราว ข้อมูลและการตั้งค่าจะหายเมื่อปิดหรือรีเฟรชหน้า`;
    }
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
