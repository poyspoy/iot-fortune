import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpPoller, validateEndpoint, backoffDelay } from '../src/adapters/httpPoller.js';
import { FakeScheduler, FakeFetch, flush } from './fakes.js';

const body = { schemaVersion: 1, samples: [] };

function make(fetch, o = {}) {
  const sch = new FakeScheduler(1_000_000);
  const got = [];
  const statuses = [];
  const p = new HttpPoller({
    url: 'https://iot.example.test/telemetry', intervalMs: 10_000, timeoutMs: 3_000, maxBackoffMs: 60_000,
    fetchImpl: fetch.fn, scheduler: sch, clock: sch, onPayload: (j, m) => got.push({ j, m }), onStatus: (s) => statuses.push(s), ...o,
  });
  return { sch, p, got, statuses };
}

test('ตรวจ URL: บังคับ HTTPS ยกเว้น localhost และห้ามใส่รหัสผ่านใน URL', () => {
  assert.equal(validateEndpoint('https://a.b/x').ok, true);
  assert.equal(validateEndpoint('http://localhost:8787/t').ok, true);
  assert.equal(validateEndpoint('http://127.0.0.1/t').ok, true);
  assert.equal(validateEndpoint('http://10.0.0.5/t').ok, false);
  assert.equal(validateEndpoint('https://u:p@a.b/x').ok, false);
  assert.equal(validateEndpoint('ftp://a.b').ok, false);
  assert.equal(validateEndpoint('not a url').ok, false);
});

test('backoff แบบ exponential มีเพดาน', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((f) => backoffDelay(10_000, f, 60_000)), [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
});

test('poll สำเร็จแล้วรอ interval ตามค่าตั้ง และส่งเวลา receivedAt', async () => {
  const f = new FakeFetch().queue({ json: body }).queue({ json: body });
  const { sch, p, got } = make(f);
  p.start();
  await flush(); await flush();
  assert.equal(got.length, 1);
  assert.equal(got[0].m.receivedAt, 1_000_000);
  assert.equal(p.status.state, 'ok');
  assert.equal(f.calls[0].opts.credentials, 'omit');
  await sch.advance(9_999);
  assert.equal(f.calls.length, 1);
  await sch.advance(1);
  assert.equal(f.calls.length, 2);
  p.dispose();
});

test('timeout ยกเลิกคำขอด้วย AbortController แล้วถอยเวลา', async () => {
  const f = new FakeFetch().queue({ hang: true }).queue({ hang: true }).queue({ json: body });
  const { sch, p } = make(f);
  p.start();
  await sch.advance(3_000);
  assert.equal(f.calls[0].opts.signal.aborted, true);
  assert.equal(p.status.state, 'retrying');
  assert.equal(p.status.failures, 1);
  assert.match(p.status.lastError, /หมดเวลา/);
  // รอบสอง: backoff 20s
  await sch.advance(19_999);
  assert.equal(f.calls.length, 1);
  await sch.advance(1);
  assert.equal(f.calls.length, 2);
  await sch.advance(3_000); // timeout อีกครั้ง → failures 2 → backoff 40s
  assert.equal(p.status.failures, 2);
  await sch.advance(40_000);
  assert.equal(f.calls.length, 3);
  await flush();
  assert.equal(p.status.state, 'ok');
  assert.equal(p.status.failures, 0);
  p.dispose();
});

test('HTTP error และ network/CORS error นับเป็นความล้มเหลว แยกจากความสดของข้อมูล', async () => {
  const f = new FakeFetch().queue({ status: 503 }).queue({ error: 'Failed to fetch' });
  const { sch, p, got } = make(f);
  p.start();
  await flush(); await flush();
  assert.equal(p.status.lastError, 'HTTP 503');
  await sch.advance(20_000);
  await flush();
  assert.match(p.status.lastError, /CORS/);
  assert.equal(got.length, 0);
  p.dispose();
});

test('ไม่ poll ซ้อน: เรียก pollNow ระหว่างรอบที่ค้างไม่เกิดคำขอใหม่', async () => {
  const f = new FakeFetch().queue({ deferred: true });
  const { p } = make(f);
  p.start();
  p.pollNow(); p.pollNow();
  assert.equal(f.calls.length, 1);
  assert.equal(p.status.skippedOverlaps, 2);
  f.calls[0].resolve(body);
  await flush(); await flush();
  assert.equal(p.status.state, 'ok');
  p.dispose();
});

test('dispose ยกเลิกคำขอที่ค้าง ล้างตัวตั้งเวลา และทิ้งคำตอบที่มาช้า', async () => {
  const f = new FakeFetch().queue({ deferred: true, ignoreAbort: true });
  const { sch, p, got } = make(f);
  p.start();
  const call = f.calls[0];
  p.dispose();
  assert.equal(call.opts.signal.aborted, true);
  call.resolve(body); // คำตอบมาช้า (fetch ที่ไม่สนใจ abort)
  await flush(); await flush();
  assert.equal(got.length, 0, 'คำตอบหลัง dispose ต้องไม่ถูกส่งต่อ');
  await sch.advance(120_000);
  assert.equal(f.calls.length, 1, 'ไม่มีการ poll หลัง dispose');
  assert.equal(p.status.state, 'stopped');
});

test('สลับ endpoint: poller เก่าถูก dispose คำตอบเก่าไม่ปนกับ poller ใหม่', async () => {
  const oldF = new FakeFetch().queue({ deferred: true, ignoreAbort: true });
  const newF = new FakeFetch().queue({ json: { schemaVersion: 1, samples: [{ tag: 'new' }] } });
  const sink = [];
  const sch = new FakeScheduler(0);
  const mk = (fetch, url) => new HttpPoller({ url, fetchImpl: fetch.fn, scheduler: sch, clock: sch, onPayload: (j) => sink.push(j) });
  const a = mk(oldF, 'https://old.example.test/t');
  a.start();
  a.dispose();
  const b = mk(newF, 'https://new.example.test/t');
  b.start();
  oldF.calls[0].resolve({ schemaVersion: 1, samples: [{ tag: 'old' }] });
  await flush(); await flush();
  assert.deepEqual(sink.map((j) => j.samples[0].tag), ['new']);
  b.dispose();
});
