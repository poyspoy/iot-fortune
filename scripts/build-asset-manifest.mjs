// สร้าง public/asset-manifest.json — SHA-256 ของเนื้อหาไฟล์ผังและโมเดล (ใช้เป็น floorPlanVersion / modelVersion)
// ไฟล์ที่ชื่อและขนาดเท่าเดิมแต่เนื้อหาต่าง → แฮชต่าง → จุดที่วางไว้เข้ารายการ "ต้องตรวจตำแหน่ง"
//
//   node scripts/build-asset-manifest.mjs           สร้าง/อัปเดต
//   node scripts/build-asset-manifest.mjs --check   ตรวจว่า manifest ตรงกับไฟล์จริง (ไม่ตรง = exit 1)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = 'public';
const DIRS = ['plans', 'models'];
const OUT = join(ROOT, 'asset-manifest.json');
const EXT = /\.(webp|png|jpg|glb|json)$/i;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

export function buildManifest(root = ROOT) {
  const files = {};
  for (const d of DIRS) {
    const base = join(root, d);
    if (!existsSync(base)) continue;
    for (const p of walk(base)) {
      const key = relative(root, p).split(sep).join('/');
      files[key] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  }
  return { manifestVersion: 1, algorithm: 'sha256', files };
}

if (process.argv[1]?.endsWith('build-asset-manifest.mjs')) {
  const m = buildManifest();
  const text = JSON.stringify(m, null, 1) + '\n';
  if (process.argv.includes('--check')) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (cur !== text) { console.error(`asset-manifest.json ไม่ตรงกับไฟล์จริง — รัน node scripts/build-asset-manifest.mjs`); process.exit(1); }
    console.log(`asset-manifest.json ตรงกับไฟล์จริง (${Object.keys(m.files).length} ไฟล์)`);
  } else {
    writeFileSync(OUT, text);
    console.log(`เขียน ${OUT} (${Object.keys(m.files).length} ไฟล์)`);
  }
}
