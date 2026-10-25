import { defineConfig, type Plugin } from 'vite';
import { cpSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * viewer 以 `new URL("./xxx-worker.js", import.meta.url)` 加载 web worker：
 * - dev：optimizeDeps.exclude 让其按原样从 node_modules 服务（预打包会断相对路径）；
 * - build：作为 external 不打进 bundle，dist 里把 dist/*.js 复制到
 *   /vendor/aholo-viewer/，由 index.html 的 importmap 解析裸导入，worker 相对路径随之成立。
 */
function copyViewerDist(): Plugin {
  return {
    name: 'copy-aholo-viewer-dist',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const src = resolve(__dirname, 'node_modules/@manycore/aholo-viewer/dist');
      const dest = resolve(__dirname, 'dist/vendor/aholo-viewer');
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(src)) {
        if (f.endsWith('.js')) cpSync(resolve(src, f), resolve(dest, f));
      }
      console.log(`[copy-aholo-viewer-dist] -> dist/vendor/aholo-viewer/`);
    },
  };
}

export default defineConfig({
  optimizeDeps: {
    exclude: ['@manycore/aholo-viewer'],
  },
  build: {
    rollupOptions: {
      external: ['@manycore/aholo-viewer'],
    },
  },
  plugins: [copyViewerDist()],
});
