// อะแดปเตอร์ HTTP polling (อ่านอย่างเดียว) — ดึงเฉพาะ URL ที่ผู้ใช้ตั้งค่าไว้เท่านั้น
// - ไม่ค้นหาอุปกรณ์ ไม่สแกนเครือข่าย ไม่ส่งคำสั่งควบคุม
// - ไม่ซ้อนรอบ: ถ้ารอบก่อนยังไม่จบ รอบใหม่จะไม่เริ่ม
// - timeout ด้วย AbortController, ล้มเหลวแล้วถอยเวลาแบบ exponential (interval × 2^n สูงสุด maxBackoff)
// - dispose() ยกเลิกคำขอที่ค้างอยู่ และคำตอบที่มาช้าหลัง dispose จะถูกทิ้ง

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/** ตรวจ URL: ต้องเป็น https ยกเว้นเครื่องพัฒนา (localhost) ห้ามมีชื่อผู้ใช้/รหัสผ่านใน URL */
export function validateEndpoint(url) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'URL ไม่ถูกต้อง' }; }
  if (u.username || u.password) return { ok: false, error: 'ห้ามใส่ชื่อผู้ใช้/รหัสผ่านใน URL — การยืนยันตัวตนต้องอยู่หลังบริการฝั่งเซิร์ฟเวอร์' };
  if (u.protocol === 'https:') return { ok: true, url: u.href };
  if (u.protocol === 'http:' && isLocalHost(u.hostname)) return { ok: true, url: u.href, local: true };
  return { ok: false, error: 'ต้องใช้ HTTPS (อนุญาต http เฉพาะ localhost สำหรับพัฒนา)' };
}

export function backoffDelay(intervalMs, failures, maxBackoffMs) {
  if (failures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** failures, maxBackoffMs);
}

export class HttpPoller {
  /**
   * @param {{ url:string, intervalMs?:number, timeoutMs?:number, maxBackoffMs?:number,
   *   fetchImpl?: typeof fetch, scheduler: {setTimeout:Function, clearTimeout:Function}, clock:{now:()=>number},
   *   onPayload:(json:any, meta:{receivedAt:number})=>any, onStatus?:(s:object)=>void }} o
   */
  constructor(o) {
    const v = validateEndpoint(o.url);
    if (!v.ok) throw new Error(v.error);
    this.kind = 'api';
    this.url = v.url;
    this.intervalMs = o.intervalMs ?? 10_000;
    this.timeoutMs = o.timeoutMs ?? 8_000;
    this.maxBackoffMs = o.maxBackoffMs ?? 300_000;
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.scheduler = o.scheduler;
    this.clock = o.clock;
    this.onPayload = o.onPayload;
    this.onStatus = o.onStatus ?? (() => {});
    this.timer = null;
    this.inFlight = null;
    this.disposed = false;
    this.status = { state: 'idle', lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null, failures: 0, nextAt: null, polls: 0, skippedOverlaps: 0 };
  }

  now() { return this.clock.now(); }

  start() {
    if (this.disposed) return;
    this.#set({ state: 'connecting' });
    this.pollNow();
  }

  #set(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus({ ...this.status });
  }

  #schedule(delay) {
    if (this.disposed) return;
    if (this.timer) this.scheduler.clearTimeout(this.timer);
    this.#set({ nextAt: this.clock.now() + delay });
    this.timer = this.scheduler.setTimeout(() => { this.timer = null; this.pollNow(); }, delay);
  }

  /** เริ่ม poll หนึ่งรอบ (ถ้ามีรอบที่ค้างอยู่จะไม่ซ้อน) คืน promise ของรอบนั้น */
  pollNow() {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) { this.#set({ skippedOverlaps: this.status.skippedOverlaps + 1 }); return this.inFlight.promise; }
    const controller = new AbortController();
    let timedOut = false;
    const to = this.scheduler.setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    this.#set({ lastAttemptAt: this.clock.now(), polls: this.status.polls + 1 });
    const run = (async () => {
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'GET', signal: controller.signal, cache: 'no-store', credentials: 'omit',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (this.disposed) return; // คำตอบที่มาช้าหลังเปลี่ยนแหล่งข้อมูล — ทิ้ง
        await this.onPayload(json, { receivedAt: this.clock.now() });
        if (this.disposed) return;
        this.#set({ state: 'ok', lastSuccessAt: this.clock.now(), lastError: null, failures: 0 });
        this.#schedule(this.intervalMs);
      } catch (e) {
        if (this.disposed) return;
        const failures = this.status.failures + 1;
        const msg = timedOut ? `หมดเวลา (${Math.round(this.timeoutMs / 1000)} วินาที)` : (e?.name === 'TypeError' ? `เชื่อมต่อไม่ได้ (เครือข่ายหรือ CORS): ${e.message}` : String(e?.message ?? e));
        this.#set({ state: 'retrying', lastFailureAt: this.clock.now(), lastError: msg, failures });
        this.#schedule(backoffDelay(this.intervalMs, failures, this.maxBackoffMs));
      } finally {
        this.scheduler.clearTimeout(to);
        if (this.inFlight?.controller === controller) this.inFlight = null;
      }
    })();
    this.inFlight = { controller, promise: run };
    return run;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.controller.abort();
    this.inFlight = null;
    this.status = { ...this.status, state: 'stopped', nextAt: null };
  }
}
