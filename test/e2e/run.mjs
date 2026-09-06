/**
 * Playwright E2E runner（不依赖 @playwright/test，直接使用 playwright 库）。
 *
 * 前置：node test/e2e/build.mjs 生成 tmp/e2e/host-entry.js
 * 运行：node test/e2e/run.mjs
 *
 * 场景：
 *   1) host.html 加载 → TeacherLabPanel 渲染（含 tabs）
 *   2) 默认显示"机房列表"，出现 mock 机房 A410
 *   3) 切到"座位分配"出现课节选择器（LessonPicker 显示 今日机房课）
 *   4) 切回"机房管理"
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// playwright 由宿主 openlearnv2 提供（本插件非 e2e 不装）；找不到则提示
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try {
  const pw = require('/home/wuxf/Develop/openlearnv2/node_modules/playwright');
  ({ chromium } = pw);
} catch {
  try {
    const pw = require('playwright');
    ({ chromium } = pw);
  } catch {
    console.error('✖ 未找到 playwright。运行: cd /home/wuxf/Develop/openlearnv2 && npx playwright install chromium');
    process.exit(1);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../');
const outDir = path.join(rootDir, 'tmp', 'e2e');

// 极简静态服务器：根 = tmp/e2e（host-entry.js），/ 提供 host.html
function serve() {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  return http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/host.html';
    const file = path.join(p === '/host.html' ? __dirname : outDir, p === '/host.html' ? 'host.html' : p.replace(/^\//, ''));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found ' + p); return; }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✔ ${name}`); }
  else { failures++; console.error(`  ✖ ${name} ${extra}`); }
}

async function main() {
  const server = serve();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('h3', { timeout: 10000 });

    // 1) tabs 渲染
    const h3 = await page.textContent('h3');
    console.log('\n[1] TeacherLabPanel 渲染');
    check('出现标题 (机房列表)', (h3 || '').includes('机房'), `实际: ${h3}`);

    // 2) 机房列表含 mock 数据
    console.log('\n[2] 机房列表显示 mock 机房');
    const body1 = await page.textContent('body');
    check('列表包含 A410', (body1 || '').includes('A410'));
    check('列表包含尺寸 2×3', (body1 || '').includes('2×3'));

    // 3) 座位分配 tab → LessonPicker 出现课节
    console.log('\n[3] 座位分配 tab + 课节选择器');
    await page.click('text=座位分配');
    await page.waitForTimeout(300);
    const body2 = await page.textContent('body');
    check('出现课节下拉提示', (body2 || '').includes('课节'));
    check('含 mock 课节 今日机房课', (body2 || '').includes('今日机房课'), `实际 body 前 300: ${(body2||'').slice(0,300)}`);

    // 4) 考勤看板 tab（mock 空数据不崩）
    console.log('\n[4] 考勤看板（空 mock）');
    await page.click('text=考勤看板');
    await page.waitForTimeout(200);
    const body3 = await page.textContent('body');
    check('看板标题出现', (body3 || '').includes('考勤看板'));

    // 5) 历史记录 tab + 趋势按钮存在
    console.log('\n[5] 历史记录 tab');
    await page.click('text=历史记录');
    await page.waitForTimeout(200);
    const body4 = await page.textContent('body');
    check('导出 CSV 按钮', (body4 || '').includes('导出 CSV'));
    check('趋势按钮', (body4 || '').includes('近 30 天到课趋势'));

    console.log('\n[6] 页面错误检查');
    check('无未捕获页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  if (failures > 0) {
    console.error(`\nE2E 失败: ${failures} 项`);
    process.exit(1);
  }
  console.log('\nE2E 全部通过 ✔');
}

main().catch(e => { console.error('E2E 崩溃:', e); process.exit(1); });
