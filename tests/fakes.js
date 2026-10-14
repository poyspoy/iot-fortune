// นาฬิกาและตัวตั้งเวลาปลอม สำหรับทดสอบ polling/timeout/backoff แบบควบคุมได้

export const flush = () => new Promise((r) => setImmediate(r));

export class FakeScheduler {
  constructor(start = 0) {
    this.t = start;
    this.timers = new Map();
    this.seq = 0;
  }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn, every: null }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  setInterval(fn, ms) { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn, every: ms }); return id; }
  clearInterval(id) { this.timers.delete(id); }
  pending() { return [...this.timers.values()].map((x) => x.at - this.t).sort((a, b) => a - b); }
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let nextId = null; let next = null;
      for (const [id, tm] of this.timers) if (tm.at <= end && (!next || tm.at < next.at)) { next = tm; nextId = id; }
      if (!next) break;
      this.t = next.at;
      if (next.every) next.at += next.every; else this.timers.delete(nextId);
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

/** fetch ปลอมที่ควบคุมคำตอบแต่ละครั้งได้ และรองรับ AbortSignal */
export class FakeFetch {
  constructor() { this.calls = []; this.handlers = []; }
  /** เพิ่มคำตอบถัดไป: { json } | { status } | { error } | { hang: true } | { deferred: true } */
  queue(h) { this.handlers.push(h); return this; }
  fn = (url, opts) => {
    const h = this.handlers.shift() ?? { hang: true };
    const call = { url, opts, resolve: null };
    this.calls.push(call);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (!h.ignoreAbort) opts?.signal?.addEventListener('abort', onAbort);
      const respond = (body) => resolve({ ok: true, status: 200, json: async () => body });
      if (h.error) reject(new TypeError(h.error));
      else if (h.status) resolve({ ok: false, status: h.status, json: async () => ({}) });
      else if (h.json !== undefined) respond(h.json);
      else if (h.deferred) call.resolve = respond; // ตอบภายหลังด้วย call.resolve(body)
      // hang: ไม่ตอบจนกว่าจะถูก abort
    });
  };
}
