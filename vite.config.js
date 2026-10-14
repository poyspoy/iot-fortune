import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base: './' ทำให้ไฟล์ใน dist อ้างอิงแบบสัมพัทธ์ เปิดจากโฟลเดอร์ย่อยหรือเซิร์ฟเวอร์ใดก็ได้
export default defineConfig({
  base: './',
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
