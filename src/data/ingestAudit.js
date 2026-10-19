// บันทึกข้อมูลเข้าที่ถูกปฏิเสธ — ไม่ทิ้งเงียบ (DATA-LAYER-PLAN ข้อ 2.4)
// รูปแบบรายการเดียวกับตาราง Audit ของ Backend ในอนาคต · จำกัดจำนวนและอายุเพื่อไม่ให้โตไม่สิ้นสุด
// persist (ไม่บังคับ): ฟังก์ชันบันทึกลงที่เก็บถาวร เช่น IndexedDB store 'rejected_ingestion' (Commit 3)

export const AUDITED_REASONS = Object.freeze(['not-installed', 'point-retired', 'asset-retired', 'archived-point', 'unknown-point', 'unknown-metric']);

export class IngestAudit {
  /** @param {{ maxEntries?: number, maxAgeMs?: number, persist?: (entries: object[]) => Promise<void>|void, now?: () => number }} o */
  constructor({ maxEntries = 5000, maxAgeMs = 30 * 24 * 3600_000, persist = null, now = () => Date.now() } = {}) {
    this.maxEntries = maxEntries;
    this.maxAgeMs = maxAgeMs;
    this.persist = persist;
    this.now = now;
    this.entries = [];
    this.counts = {};
  }

  /**
   * @param {{ organizationId, projectId, buildingId, pointId?, pointCode?, sourceKey, metricKey, observedAt?, receivedAt?, reason, source? }} e
   * @returns {object} รายการที่บันทึก
   */
  record(e) {
    if (!e?.reason) throw new TypeError('ต้องระบุเหตุผลที่ปฏิเสธ');
    const entry = Object.freeze({
      organizationId: e.organizationId ?? null, projectId: e.projectId ?? null, buildingId: e.buildingId ?? null,
      pointId: e.pointId ?? null, pointCode: e.pointCode ?? null,
      sourceKey: e.sourceKey ?? null, metricKey: e.metricKey ?? null,
      observedAt: e.observedAt ?? null, receivedAt: e.receivedAt ?? this.now(),
      reason: e.reason, source: e.source ?? null,
    });
    this.entries.push(entry);
    this.counts[entry.reason] = (this.counts[entry.reason] ?? 0) + 1;
    this.#trim();
    this.persist?.([entry]);
    return entry;
  }

  #trim() {
    const cutoff = this.now() - this.maxAgeMs;
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop].receivedAt < cutoff) drop++;
    if (this.entries.length - drop > this.maxEntries) drop = this.entries.length - this.maxEntries;
    if (drop) this.entries.splice(0, drop);
  }

  list({ projectId = null, reason = null } = {}) {
    return this.entries.filter((e) => (!projectId || e.projectId === projectId) && (!reason || e.reason === reason));
  }
}
