import { h } from './dom.js';

// โหมดนำเสนอผู้บริหาร (อัตโนมัติ ~60–90 วินาที) — ใช้ข้อมูลจำลองทั้งหมด ไม่มีคำสั่งถึงลิฟต์หรืออุปกรณ์จริง
// หยุดได้ตลอดเวลาด้วยปุ่มบนแถบคำบรรยาย หรือปุ่มในแถบสาธิต

class Stopped extends Error {}

export class Presenter {
  constructor(app) {
    this.app = app;
    this.running = false;
    this.text = h('span.pb-text', '');
    this.stepEl = h('span.pb-step', '');
    this.bar = h('i');
    this.el = h('div.present-bar', { 'data-testid': 'present-bar', role: 'status', 'aria-live': 'polite' },
      this.stepEl, this.text,
      h('button.btn.small', { type: 'button', 'data-testid': 'present-stop', onclick: () => this.stop() }, '⏹ หยุดการนำเสนอ'),
      h('div.pb-progress', this.bar));
  }

  get steps() {
    const a = this.app;
    return [
      ['ภาพรวมอาคาร 3 มิติ — ห้างชั้น G–5 และอาคารสำนักงาน 11–32 (ข้อมูลจำลอง)', async () => {
        a.changeView({ view: 'overview', viewMode: '3d' });
        a.showBuilding();
        a.scene?.setLiftView(false);
        a.scene?.preset('all');
        await this.sleep(6000);
        a.focusLift();
      }],
      ['ลิฟต์โดยสาร L1 วิ่งจากชั้น G ไปชั้น 3 — ประตูปิด → เคลื่อนที่ → หยุดตรงชั้น → ประตูเปิด', async () => {
        if (a.scene?.elevatorStatus()?.atFloor !== 'G') await this.wait(a.liftTo('G'));
        await this.wait(a.liftTo('3'));
        await this.sleep(1500);
      }],
      ['เซนเซอร์ระดับน้ำ WL-001 บ่อสูบน้ำ ชั้น G — ตอนนี้สถานะปกติ (เขียว)', async () => {
        a.openFloorFor('WL-001');
        await this.sleep(5000);
      }],
      ['จำลองระดับน้ำบ่อสูงขึ้น — ค่าค่อย ๆ เพิ่มขึ้น', async () => {
        await this.wait(a.setDemoScenario('sump-rising'));
        await this.until(() => a.severityOf('WL-001') !== 'normal', 40000);
        this.say('ระดับน้ำถึงเกณฑ์เฝ้าระวัง 120 cm — สถานะเปลี่ยนเป็นสีเหลือง');
        await this.until(() => a.severityOf('WL-001') === 'critical', 40000);
        this.say('ระดับน้ำถึงเกณฑ์วิกฤต 150 cm — หมุดเป็นสีแดง และระบบสร้างรายการแจ้งเตือน');
        await this.sleep(4000);
      }],
      ['รายการแจ้งเตือน — เวลาเกิด ระดับความรุนแรง และการรับทราบ (รับทราบ ≠ กลับสู่ปกติ)', async () => {
        a.changeView({ view: 'alerts' });
        await this.sleep(7000);
        a.changeView({ view: 'overview', viewMode: '3d' });
        await this.sleep(500);
      }],
      ['ลิฟต์วิ่งลงจากชั้น 3 กลับชั้น G', async () => {
        a.focusLift();
        await this.wait(a.liftTo('G'));
        await this.sleep(1500);
      }],
      ['รีเซ็ตกลับสู่สถานะปกติ — จบการสาธิต', async () => {
        await this.wait(a.resetDemoAll());
        a.showBuilding();
        a.scene?.setLiftView(false);
        a.scene?.preset('all');
        await this.sleep(3000);
      }],
    ];
  }

  say(text) { this.text.textContent = text; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.token = {};
    const token = this.token;
    this.app.setState?.({ detailsOpen: false }); // เริ่มสาธิต: ย่อแผงรายละเอียดจุด ให้โมเดลใหญ่ที่สุด
    document.body.appendChild(this.el);
    document.body.classList.add('presenting');
    this.app.refreshDemoBar?.();
    const steps = this.steps;
    try {
      for (let i = 0; i < steps.length; i++) {
        if (this.token !== token) throw new Stopped();
        this.stepEl.textContent = `ขั้น ${i + 1}/${steps.length}`;
        this.say(steps[i][0]);
        this.bar.style.width = `${Math.round((i / steps.length) * 100)}%`;
        await steps[i][1]();
      }
      this.bar.style.width = '100%';
    } catch (e) {
      if (!(e instanceof Stopped)) console.warn('presentation step failed', e);
    } finally {
      if (this.token === token) this.#finish();
    }
  }

  stop() {
    if (!this.running) return;
    this.token = null;
    this.#finish();
  }

  #finish() {
    this.running = false;
    this.app.restoreBuildingStyle?.(); // จบการสาธิต: คืนรูปแบบอาคารที่ผู้ใช้เลือกไว้
    this.el.remove();
    document.body.classList.remove('presenting');
    this.app.refreshDemoBar?.();
  }

  sleep(ms) {
    const token = this.token;
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const tick = () => {
        if (this.token !== token) return rej(new Stopped());
        if (Date.now() - t0 >= ms) return res();
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  async wait(promise) {
    const token = this.token;
    const stop = new Promise((_, rej) => { const iv = setInterval(() => { if (this.token !== token) { clearInterval(iv); rej(new Stopped()); } }, 100); promise.finally?.(() => clearInterval(iv)); });
    return Promise.race([promise, stop]);
  }

  async until(cond, timeoutMs) {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) return false;
      await this.sleep(200);
    }
    return true;
  }
}
