import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync } from 'node:fs';
import type { Plugin } from 'vite';

/** 构建结束后把 pdfjs 的标准字体复制到 dist（阅读器渲染 PDF 必需）。 */
function copyPdfjsAssets(): Plugin {
  return {
    name: 'copy-pdfjs-assets',
    apply: 'build',
    closeBundle() {
      const pairs: Array<[string, string]> = [
        ['node_modules/pdfjs-dist/standard_fonts', 'dist/standard_fonts'],
        ['node_modules/pdfjs-dist/cmaps', 'dist/cmaps'],
      ];
      for (const [src, dst] of pairs) {
        if (existsSync(src)) cpSync(src, dst, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyPdfjsAssets()],
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
