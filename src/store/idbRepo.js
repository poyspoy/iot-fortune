// คลังข้อมูลในเบราว์เซอร์ (IndexedDB) — เก็บเฉพาะในอุปกรณ์/เบราว์เซอร์/โปรไฟล์นี้เท่านั้น
// ไม่ซิงก์ระหว่างเครื่องหรือระหว่างผู้ปฏิบัติงาน

export const DB_NAME = 'iot-fortune';
export const DB_VERSION = 1;

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
});

export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
    this.quota = cause?.name === 'QuotaExceededError';
  }
}

export class IdbRepo {
  /** @param {{ indexedDB?: IDBFactory, IDBKeyRange?: typeof IDBKeyRange, name?: string }} o */
  constructor(o = {}) {
    this.idb = o.indexedDB ?? globalThis.indexedDB;
    this.KR = o.IDBKeyRange ?? globalThis.IDBKeyRange;
    this.name = o.name ?? DB_NAME;
    this.db = null;
  }

  async open() {
    if (!this.idb) throw new StorageError('เบราว์เซอร์นี้ไม่รองรับ IndexedDB');
    const r = this.idb.open(this.name, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('samples')) {
        const s = db.createObjectStore('samples', { keyPath: 'id' });
        s.createIndex('bySeries', ['source', 'pointId', 'metricId', 'observedAt']);
        s.createIndex('byObserved', 'observedAt');
        s.createIndex('bySource', 'source');
      }
      if (!db.objectStoreNames.contains('episodes')) {
        const e = db.createObjectStore('episodes', { keyPath: 'id' });
        e.createIndex('bySource', 'source');
      }
    };
    this.db = await req(r);
    this.db.onversionchange = () => this.db.close();
    return this;
  }

  close() { this.db?.close(); this.db = null; }

  async #write(stores, fn, label) {
    try {
      const tx = this.db.transaction(stores, 'readwrite');
      const p = done(tx);
      try {
        fn(tx);
      } catch (e) {
        p.catch(() => {});
        try { tx.abort(); } catch { /* ถูกยกเลิกแล้ว */ }
        throw e;
      }
      await p;
    } catch (e) {
      const q = e?.name === 'QuotaExceededError';
      throw new StorageError(q ? 'พื้นที่จัดเก็บในเบราว์เซอร์เต็ม — ข้อมูลไม่ได้ถูกบันทึก' : `${label}ไม่สำเร็จ: ${e?.message ?? e}`, e);
    }
  }

  // ---- key/value ----
  async getKV(key) {
    const tx = this.db.transaction('kv');
    const row = await req(tx.objectStore('kv').get(key));
    return row ? row.value : undefined;
  }
  putKV(key, value) {
    return this.#write(['kv'], (tx) => tx.objectStore('kv').put({ key, value }), 'บันทึก');
  }

  // ---- samples ----
  addSamples(samples) {
    if (!samples.length) return Promise.resolve();
    return this.#write(['samples'], (tx) => {
      const st = tx.objectStore('samples');
      for (const s of samples) st.put(s);
    }, 'บันทึกค่าวัด');
  }

  async latestSample(source, pointId, metricId) {
    const tx = this.db.transaction('samples');
    const range = this.KR.bound([source, pointId, metricId, -Infinity], [source, pointId, metricId, Infinity]);
    const cur = await req(tx.objectStore('samples').index('bySeries').openCursor(range, 'prev'));
    return cur ? cur.value : null;
  }

  async getSeries(source, pointId, metricId, from = -Infinity, to = Infinity) {
    const tx = this.db.transaction('samples');
    const range = this.KR.bound([source, pointId, metricId, from], [source, pointId, metricId, to]);
    return req(tx.objectStore('samples').index('bySeries').getAll(range));
  }

  async getSamplesBySource(source, from = -Infinity, to = Infinity) {
    const tx = this.db.transaction('samples');
    const all = await req(tx.objectStore('samples').index('byObserved').getAll(this.KR.bound(from, to)));
    return all.filter((s) => s.source === source);
  }

  async countSamples() {
    const tx = this.db.transaction('samples');
    return req(tx.objectStore('samples').count());
  }

  /**
   * นโยบายเก็บข้อมูล: ลบค่าที่ observedAt เก่ากว่า maxDays ก่อน
   * จากนั้นถ้ายังเกิน maxSamples ให้ลบค่าที่ observedAt เก่าที่สุดจนเหลือ maxSamples (ทุกแหล่งรวมกัน)
   */
  async enforceRetention(now, { maxDays, maxSamples }) {
    let deleted = 0;
    const cutoff = now - maxDays * 86_400_000;
    await this.#write(['samples'], (tx) => {
      const idx = tx.objectStore('samples').index('byObserved');
      const r = idx.openCursor(this.KR.upperBound(cutoff, true));
      r.onsuccess = () => { const c = r.result; if (c) { c.delete(); deleted++; c.continue(); } };
    }, 'ลบข้อมูลเก่า');
    const count = await this.countSamples();
    if (count > maxSamples) {
      let toDelete = count - maxSamples;
      await this.#write(['samples'], (tx) => {
        const r = tx.objectStore('samples').index('byObserved').openCursor();
        r.onsuccess = () => { const c = r.result; if (c && toDelete > 0) { c.delete(); deleted++; toDelete--; c.continue(); } };
      }, 'ลบข้อมูลส่วนเกิน');
    }
    return deleted;
  }

  // ---- episodes ----
  async getEpisodes(source) {
    const tx = this.db.transaction('episodes');
    return req(tx.objectStore('episodes').index('bySource').getAll(source));
  }
  putEpisodes(list) {
    if (!list.length) return Promise.resolve();
    return this.#write(['episodes'], (tx) => { const st = tx.objectStore('episodes'); for (const e of list) st.put(e); }, 'บันทึกการแจ้งเตือน');
  }

  /** ล้างข้อมูลเฉพาะแหล่ง (ใช้กับปุ่มรีเซ็ตเดโม — ไม่แตะข้อมูลจาก API) */
  clearSource(source) {
    return this.#write(['samples', 'episodes', 'kv'], (tx) => {
      for (const name of ['samples', 'episodes']) {
        const r = tx.objectStore(name).index('bySource').openCursor(this.KR.only(source));
        r.onsuccess = () => { const c = r.result; if (c) { c.delete(); c.continue(); } };
      }
      tx.objectStore('kv').delete(`${source}State`);
    }, 'ล้างข้อมูล');
  }

  async exportAll() {
    const tx = this.db.transaction(['kv', 'samples', 'episodes']);
    const [config, settings, samples, episodes] = await Promise.all([
      req(tx.objectStore('kv').get('config')), req(tx.objectStore('kv').get('settings')),
      req(tx.objectStore('samples').getAll()), req(tx.objectStore('episodes').getAll()),
    ]);
    return { config: config?.value, settings: settings?.value, samples, episodes };
  }

  /** แทนที่ข้อมูลทั้งหมดใน transaction เดียว — ถ้ามีข้อผิดพลาดใด ๆ ข้อมูลเดิมยังอยู่ครบ */
  replaceAll({ config, settings, samples, episodes }) {
    return this.#write(['kv', 'samples', 'episodes'], (tx) => {
      const kv = tx.objectStore('kv');
      const ss = tx.objectStore('samples');
      const es = tx.objectStore('episodes');
      kv.clear(); ss.clear(); es.clear();
      kv.put({ key: 'config', value: config });
      if (settings) kv.put({ key: 'settings', value: settings });
      for (const s of samples) ss.put(s);
      for (const e of episodes) es.put(e);
    }, 'นำเข้าข้อมูล');
  }
}

export async function storageEstimate() {
  try {
    const e = await globalThis.navigator?.storage?.estimate?.();
    return e ? { usage: e.usage, quota: e.quota } : null;
  } catch { return null; }
}
