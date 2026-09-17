import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync } from 'node:fs';
import type { Plugin } from 'vite';

/** 构建结束后把 pdfjs 的标准字体复制到 web（阅读器渲染 PDF 必需）。 */
function copyPdfjsAssets(): Plugin {
  return {
    name: 'copy-pdfjs-assets',
    apply: 'build',
    closeBundle() {
      const pairs: Array<[string, string]> = [
        ['node_modules/pdfjs-dist/standard_fonts', 'web/standard_fonts'],
        ['node_modules/pdfjs-dist/cmaps', 'web/cmaps'],
      ];
      for (const [src, dst] of pairs) {
        if (existsSync(src)) cpSync(src, dst, { recursive: true });
      }
    },
  };
}

// 开发模式：vite dev server（5173，HMR）把 /rpc、/events、/files、/upload 代理到
// Web(Host) 服务端（npm run dev:server，默认 127.0.0.1:18080），浏览器里跑同一套前端。
const HOST_SERVER = 'http://127.0.0.1:18080';

export default defineConfig({
  plugins: [react(), copyPdfjsAssets()],
  root: '.',
  base: './',
  build: {
    outDir: 'web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/rpc': HOST_SERVER,
      '/events': HOST_SERVER,
      '/files': HOST_SERVER,
      '/upload': HOST_SERVER,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
