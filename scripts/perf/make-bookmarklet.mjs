// สร้าง Bookmarklet จาก mobile-probe.js (ตัดคอมเมนต์และช่องว่าง) — node scripts/perf/make-bookmarklet.mjs > /tmp/bookmarklet.txt
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

const src = readFileSync(new URL('./mobile-probe.js', import.meta.url), 'utf8');
const { code } = await transform(src, { minify: true, target: 'es2020', charset: 'utf8' });
process.stdout.write('javascript:' + encodeURIComponent(code.trim()) + '\n');
