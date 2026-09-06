// 用 esbuild 把 dist/index.js 重新打包成测试 bundle，
// alias pino / pino-pretty 到 mock，避免在测试环境触发 file transport。
//
// 运行：node test/build-test-bundle.mjs
// 产物：tmp/plugin-test-bundle.mjs

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = resolve(__dirname, '../tmp');
mkdirSync(tmpDir, { recursive: true });

await build({
  entryPoints: [resolve(__dirname, '../src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: resolve(tmpDir, 'plugin-test-bundle.mjs'),
  plugins: [
    {
      name: 'mock-runtime-deps',
      setup(build) {
        const mockUrl = resolve(__dirname, '_mock-pino.mjs');
        const stubTargets = /pino(-pretty)?|express|body-parser|jszip|semver|uuid|esbuild|debug|cookie|qs|raw-body|http-errors|send|forwarded|on-finished|finalhandler|negotiator|mime(-types)?|media-typer|content-type|type-is|range-parser|accepts|bytes|statuses/;
        build.onResolve({ filter: stubTargets }, (args) => {
          return { path: mockUrl };
        });
        // 在 CommonJS require 内部被使用时，esbuild 还会产生 additional resolve。
        // 补充拦截以处理 pino/.../node_modules/pino 等路径。
        build.onResolve({ filter: /.*node_modules.*(pino|express|body-parser|jszip|semver|uuid|esbuild|debug)/ }, (args) => {
          return { path: mockUrl };
        });
      },
    },
  ],
  logLevel: 'silent',
});

console.log('✓ Built tmp/plugin-test-bundle.mjs');