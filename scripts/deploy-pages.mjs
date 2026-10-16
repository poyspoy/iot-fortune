// อัปโหลด dist/ ขึ้นสาขา gh-pages (GitHub Pages) — ใช้ได้ทั้ง Windows/macOS/Linux ต้องมี git และสิทธิ์ push
//   npm run build && npm run deploy
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve('dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('ไม่พบ dist/index.html — รัน npm run build ก่อน');
  process.exit(1);
}
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const remote = git(['remote', 'get-url', 'origin'], '.');
const rev = git(['rev-parse', '--short', 'HEAD'], '.');
const dir = mkdtempSync(join(tmpdir(), 'gh-pages-'));
try {
  git(['init', '-q', '-b', 'gh-pages'], dir);
  for (const f of readdirSync(dist)) cpSync(join(dist, f), join(dir, f), { recursive: true });
  writeFileSync(join(dir, '.nojekyll'), ''); // ให้ GitHub Pages ส่งไฟล์ตามที่ build ไว้ทุกไฟล์
  git(['add', '-A'], dir);
  const name = git(['config', 'user.name'], '.') || 'deploy';
  const email = git(['config', 'user.email'], '.') || 'deploy@localhost';
  git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `Deploy ${rev}`], dir);
  execFileSync('git', ['push', '-f', remote, 'gh-pages'], { cwd: dir, stdio: 'inherit' });
  const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(remote);
  console.log(`\nอัปโหลดแล้ว (${rev}) → ${m ? `https://${m[1].toLowerCase()}.github.io/${m[2]}/` : 'GitHub Pages'}`);
  console.log('ครั้งแรก: GitHub → Settings → Pages → Source = Deploy from a branch, Branch = gh-pages / (root)');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
