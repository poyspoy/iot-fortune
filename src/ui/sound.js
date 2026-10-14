// เสียงแจ้งเตือนในแอป — ปิดเป็นค่าเริ่มต้น ต้องเปิดเองด้วยการคลิก (ข้อกำหนดเบราว์เซอร์)
// ทำงานเฉพาะขณะหน้าเว็บเปิดอยู่ ไม่ใช่การแจ้งเตือนเบื้องหลัง และการปิดเสียงไม่ซ่อนการแจ้งเตือนใด ๆ

export class Sound {
  constructor() {
    this.enabled = false;
    this.ctx = null;
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) {
      try {
        this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
        this.ctx.resume?.();
        this.play('test');
      } catch {
        this.enabled = false;
      }
    }
  }

  play(kind) {
    if (!this.enabled || !this.ctx) return;
    const tones = kind === 'critical' ? [880, 660, 880] : kind === 'warning' ? [660, 520] : [600];
    const t0 = this.ctx.currentTime;
    tones.forEach((f, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.22);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.22 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.22 + 0.18);
      o.connect(g).connect(this.ctx.destination);
      o.start(t0 + i * 0.22);
      o.stop(t0 + i * 0.22 + 0.2);
    });
  }
}
