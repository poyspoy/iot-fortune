// เซิร์ฟเวอร์ทดสอบ (fixture) สำหรับลองโหมด "ข้อมูลจาก API" บนเครื่องตัวเอง
// ไม่ใช่การเชื่อมต่ออุปกรณ์จริงของฟอร์จูน — ส่งค่าทดสอบตามสัญญา JSON ของแอป
//
//   node scripts/fixture-server.mjs [port]        (ค่าเริ่มต้น 8787)
//   GET /telemetry                 → ข้อมูลตามสัญญา schemaVersion 1
//   GET /control?mode=normal       → ค่าปกติ เวลา observedAt = ปัจจุบัน
//   GET /control?mode=stuck        → ตอบสำเร็จแต่ค่าค้าง (observedAt เดิม) — ทดสอบว่า poll สำเร็จไม่ทำให้ข้อมูลสด
//   GET /control?mode=fail         → ตอบ HTTP 503
//   GET /control?mode=invalid      → ส่งค่าผิดรูปแบบ
//   GET /control?mode=high         → ระดับบ่อสูบน้ำสูง (ทดสอบการแจ้งเตือน)
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
let mode = 'normal';
let seq = 0;
let stuckAt = null;
let stuckSeq = 0;

function samples(now) {
  const at = new Date(now).toISOString();
  const lvl = mode === 'high' ? 160 : 58 + Math.round(Math.sin(now / 60000) * 30) / 10;
  return [
    { pointId: 'P-001', metricId: 'level', value: lvl, unit: 'cm', observedAt: at, quality: 'good', sequence: seq },
    { pointId: 'P-005', metricId: 'temp', value: 24.6, unit: '°C', observedAt: at, quality: 'good', sequence: seq },
    { pointId: 'P-005', metricId: 'rh', value: 57, unit: '%RH', observedAt: at, quality: 'good', sequence: seq },
    { pointId: 'P-008', metricId: 'leak', value: 'dry', unit: '', observedAt: at, quality: 'good', sequence: seq },
  ];
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  // CORS: อนุญาตให้หน้าเว็บจาก origin อื่นอ่านได้ (เฉพาะ GET อ่านอย่างเดียว)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/control') {
    mode = url.searchParams.get('mode') ?? 'normal';
    if (mode === 'stuck') { stuckAt = Date.now(); stuckSeq = seq; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mode }));
  }
  if (url.pathname === '/telemetry') {
    if (mode === 'fail') { res.writeHead(503, { 'Content-Type': 'text/plain' }); return res.end('unavailable'); }
    let body;
    if (mode === 'stuck') {
      seq = stuckSeq;
      body = { schemaVersion: 1, samples: samples(stuckAt) };
    } else if (mode === 'invalid') {
      seq++;
      body = { schemaVersion: 1, samples: [{ pointId: 'P-001', metricId: 'level', value: 'NaN', unit: 'cm', observedAt: new Date().toISOString(), quality: 'good', sequence: seq }] };
    } else {
      seq++;
      body = { schemaVersion: 1, samples: samples(Date.now()) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(body));
  }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1', () => console.log(`fixture: http://127.0.0.1:${port}/telemetry (โหมด ${mode})`));
