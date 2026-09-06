// 独立测试 fixture：escapeCsvField + csvRow 的 RFC 4180 转义行为。
//
// 运行方式：
//   node test/csv.test.mjs
//
// 实现：先用 esbuild 把 src/csv.ts 单文件打包成 tmp/csv.mjs（ESM），
// 再从 tmp/csv.mjs import。这样不依赖 dist/index.js（pino 等 SDK inline
// 会在 import 时立即执行，触发 node:os dynamic require 失败）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = `${__dirname}/../tmp`;
mkdirSync(tmpDir, { recursive: true });

await esbuild.build({
  entryPoints: [`${__dirname}/../src/csv.ts`],
  bundle: false, // 不打包依赖，仅 TS → ESM 转换
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: `${tmpDir}/csv.mjs`,
  logLevel: 'silent',
});

const { escapeCsvField, csvRow } = await import(`${tmpDir}/csv.mjs`);

// ── escapeCsvField ────────────────────────────────────────────────────

test('普通字符串原样返回', () => {
  assert.equal(escapeCsvField('hello'), 'hello');
  assert.equal(escapeCsvField('张三'), '张三');
  assert.equal(escapeCsvField('A101'), 'A101');
});

test('空字符串返回空', () => {
  assert.equal(escapeCsvField(''), '');
});

test('null 和 undefined 返回空字段', () => {
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField(undefined), '');
});

test('数字 / 布尔 / 对象被 toString', () => {
  assert.equal(escapeCsvField(42), '42');
  assert.equal(escapeCsvField(0), '0');
  assert.equal(escapeCsvField(true), 'true');
  assert.equal(escapeCsvField(false), 'false');
  assert.equal(
    escapeCsvField(new Date('2026-09-06T03:00:00Z')),
    String(new Date('2026-09-06T03:00:00Z')),
  );
});

test('含逗号自动加引号', () => {
  assert.equal(escapeCsvField('张, 三'), '"张, 三"');
  assert.equal(escapeCsvField('a,b,c'), '"a,b,c"');
});

test('含双引号转义为两个并加引号包裹', () => {
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField('"quoted"'), '"""quoted"""');
});

test('含换行符自动加引号', () => {
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvField('a\r\nb'), '"a\r\nb"');
  // 仅 \r 视为需要转义，避免不同 OS 下解析差异
  assert.equal(escapeCsvField('a\rb'), '"a\rb"');
});

test('同时含逗号和双引号', () => {
  assert.equal(escapeCsvField('a"b,c'), '"a""b,c"');
});

// ── csvRow ────────────────────────────────────────────────────────────

test('csvRow 拼接并加换行', () => {
  assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c\n');
});

test('csvRow 数字 + 字符串混用', () => {
  assert.equal(csvRow(['座位编号', 1, '已签到']), '座位编号,1,已签到\n');
});

test('csvRow 空数组返回仅换行', () => {
  assert.equal(csvRow([]), '\n');
});

test('csvRow 字段需要转义时正确处理', () => {
  assert.equal(
    csvRow(['A1', '张, 三', 'note"x"\nline']),
    'A1,"张, 三","note""x""\nline"\n',
  );
});

test('csvRow 含 null 字段输出空', () => {
  assert.equal(csvRow(['A1', null, '已签到', undefined]), 'A1,,已签到,\n');
});

// ── 端到端：模拟 export_attendance 写整张 CSV ──────────────────────────

test('整张 CSV 端到端（覆盖边界场景）', () => {
  const records = [
    { label: 'A1', student_name: '张三', student_id: 'S001', status: '已签到', time: '2026-09-06T03:00:00.000Z', note: '' },
    { label: 'A2', student_name: '李, 四', student_id: 'S002', status: '迟到', time: '2026-09-06T03:15:00.000Z', note: '路上堵车' },
    { label: 'A3', student_name: "O'Brien", student_id: 'S003', status: '请假', time: '', note: '' },
    { label: 'A4', student_name: 'note"x"\nmulti', student_id: 'S004', status: '未签到', time: '', note: '' },
  ];

  const BOM = '\uFEFF';
  let csv = BOM + csvRow(['座位编号', '学生姓名', '学号', '签到状态', '签到时间', '备注']);
  for (const r of records) {
    csv += csvRow([r.label, r.student_name, r.student_id, r.status, r.time, r.note]);
  }

  // 关键断言
  assert.match(csv, /"李, 四"/, '逗号字段应被引号包裹');
  assert.match(csv, /"note""x""\nmulti"/, '引号+换行应被引号包裹且内部引号转义');
  assert.match(csv, /^A\d,张三,/m, '普通字段不应有引号');
  assert.equal(csv.charCodeAt(0), 0xFEFF, '文件应以 BOM 开头');

  console.log('\n--- 生成的 CSV（样例）---');
  console.log(csv);
  console.log('--- 结束 ---\n');
});