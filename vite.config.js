import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base: './' ทำให้ไฟล์ใน dist อ้างอิงแบบสัมพัทธ์ เปิดจากโฟลเดอร์ย่อยหรือเซิร์ฟเวอร์ใดก็ได้
// Playground ข้อมูลทดลองของ Data Layer: เปิดเฉพาะ build ของสาขา feature/data-layer บน Cloudflare (CF_PAGES_BRANCH)
// หรือสั่งเองในเครื่องด้วย DL_PLAYGROUND=1 — build ของสาขาอื่น (รวม Demo) ไม่มี Playground
const DL_PLAYGROUND = process.env.CF_PAGES_BRANCH === 'feature/data-layer' || process.env.DL_PLAYGROUND === '1';

export default defineConfig({
  base: './',
  define: { __DL_PLAYGROUND__: JSON.stringify(DL_PLAYGROUND) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        materials: resolve(import.meta.dirname, 'materials.html'),
      },
    },
  },
  server: { port: 5173 },
});
