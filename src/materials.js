import './materials.css';
import pkg from '../package.json';

const el = document.getElementById('build-info');
if (el) el.textContent = `รุ่นที่ใช้ build: three ${pkg.dependencies.three} · vite ${pkg.devDependencies.vite} · โหลดหน้าเมื่อ ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`;
