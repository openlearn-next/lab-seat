/**
 * E2E 构建脚本：把 test/e2e/host-entry.tsx（含 react + 插件 frontend）打包为浏览器 ESM，
 * 输出到 tmp/e2e/。
 * 运行：node test/e2e/build.mjs
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../../tmp/e2e');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(__dirname, 'host-entry.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: resolve(outDir, 'host-entry.js'),
  // react/react-dom 已在入口 import；外部只留 @openlearn/plugin-sdk 不需要（frontend 未 import SDK）
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"development"' },
});

console.log('✓ E2E bundle → tmp/e2e/host-entry.js');
