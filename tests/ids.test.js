import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUuid, uuidv4, uuidv5, legacyEntityId } from '../src/data/ids.js';
import { makeScope, inScope, assertInScope, ScopeError, scopeFields } from '../src/data/scope.js';

const NS_A = '1b671a64-40d5-491e-99b0-da01ff1f3341';
const NS_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const PROJ = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const PROJ2 = '0f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

test('UUID v5 ตรงกับค่าอ้างอิงมาตรฐาน RFC 4122 (ตรวจกับ Python)', () => {
  // ค่าอ้างอิงตรวจด้วย Python uuid.uuid5 (NAMESPACE_DNS / NAMESPACE_URL / namespace เอง + ข้อความภาษาไทย)
  assert.equal(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  assert.equal(uuidv5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'python.org'), '7af94e2b-4dd9-50f0-9c9a-8a48519bdef0');
  assert.equal(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  assert.equal(uuidv5('1b671a64-40d5-491e-99b0-da01ff1f3341', 'ชั้น G'), '01c53822-84a1-561b-8a47-9f9e8f5dac82');
});

test('UUID v5 ซ้ำได้ (deterministic) และรองรับข้อความภาษาไทย', () => {
  assert.equal(uuidv5(NS_A, 'ชั้น G'), uuidv5(NS_A, 'ชั้น G'));
  assert.notEqual(uuidv5(NS_A, 'ชั้น G'), uuidv5(NS_A, 'ชั้น 1'));
  assert.ok(isUuid(uuidv5(NS_A, 'ชั้น G')));
  assert.equal(uuidv5(NS_A, 'x')[14], '5');
});

test('UUID v4 รูปแบบถูกต้อง และไม่ซ้ำกันใน 2,000 ครั้ง', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const u = uuidv4(); assert.ok(isUuid(u), u); assert.equal(u[14], '4'); seen.add(u); }
  assert.equal(seen.size, 2000);
});

test('isUuid ปฏิเสธรูปแบบที่ไม่ถูกต้อง', () => {
  for (const bad of [null, '', 'P-003', 'FRT-DEMO-PUMP-001', '1B671A64-40D5-491E-99B0-DA01FF1F3341', '1b671a64-40d5-091e-99b0-da01ff1f3341', '1b671a64-40d5-491e-c9b0-da01ff1f3341']) {
    assert.equal(isUuid(bad), false, String(bad));
  }
});

test('legacyEntityId: คนละองค์กร (namespace) รหัสเดิมเหมือนกัน → UUID ไม่ชนกัน', () => {
  const a = legacyEntityId(NS_A, PROJ, 'point', 'P-003');
  const b = legacyEntityId(NS_B, PROJ, 'point', 'P-003');
  assert.notEqual(a, b);
});

test('legacyEntityId: คนละโครงการ / คนละชนิด / คนละรหัส → UUID ต่างกัน และใช้ Project UUID ไม่ใช่ projectCode', () => {
  const base = legacyEntityId(NS_A, PROJ, 'point', 'P-003');
  assert.notEqual(base, legacyEntityId(NS_A, PROJ2, 'point', 'P-003'));
  assert.notEqual(base, legacyEntityId(NS_A, PROJ, 'asset', 'P-003'));
  assert.notEqual(base, legacyEntityId(NS_A, PROJ, 'point', 'P-004'));
  assert.equal(base, uuidv5(NS_A, `${PROJ}:point:P-003`));
  assert.throws(() => legacyEntityId(NS_A, 'FRT', 'point', 'P-003'), /projectId ต้องเป็น UUID/);
  assert.throws(() => legacyEntityId(NS_A, PROJ, 'sensor', 'P-003'), /ชนิด Entity/);
  assert.throws(() => legacyEntityId('not-a-uuid', PROJ, 'point', 'P-003'), /namespace/);
  assert.throws(() => legacyEntityId(NS_A, PROJ, 'point', ''), /รหัสเดิม/);
});

test('Scope: ต้องเป็น UUID ทั้ง 3 ระดับ แก้ไขไม่ได้ และตรวจครบทุกระดับ', () => {
  const s = makeScope({ organizationId: NS_A, projectId: PROJ, buildingId: PROJ2 });
  assert.ok(Object.isFrozen(s));
  assert.throws(() => makeScope({ organizationId: NS_A, projectId: 'FRT', buildingId: PROJ2 }), ScopeError);
  const e = { id: 'x', ...scopeFields(s) };
  assert.equal(inScope(e, s), true);
  for (const k of ['organizationId', 'projectId', 'buildingId']) {
    const bad = { ...e, [k]: NS_B };
    assert.equal(inScope(bad, s), false, k);
    assert.throws(() => assertInScope(bad, s), (err) => err instanceof ScopeError && err.detail.got[k] === NS_B);
  }
  assert.equal(inScope(null, s), false);
  assert.equal(assertInScope(e, s), e);
});
