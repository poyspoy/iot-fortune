// รันทุกไฟล์ tests/*.test.js ด้วย Node test runner (ใช้ได้ทั้ง Node 20 และ 22+ บนทุกระบบปฏิบัติการ)
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const files = readdirSync('tests').filter((f) => f.endsWith('.test.js')).sort().map((f) => join('tests', f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
