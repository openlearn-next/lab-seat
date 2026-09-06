// smart-assign 纯函数单元测试（parseSmartConstraint / orderStudentsForSeats / validateConstraintNames）。
// 运行：node --test test/smart-assign.test.mjs
// 与 csv 测试同样用 esbuild 转译 src/smart-assign.ts 后 import。

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
  entryPoints: [`${__dirname}/../src/smart-assign.ts`],
  bundle: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: `${tmpDir}/smart-assign.mjs`,
  logLevel: 'silent',
});

const { buildSmartPrompt, parseSmartConstraint, orderStudentsForSeats, validateConstraintNames } =
  await import(`${tmpDir}/smart-assign.mjs`);

const STUDENTS = [
  { id: 's1', name: '张小明' },
  { id: 's2', name: '李雷' },
  { id: 's3', name: '韩梅梅' },
  { id: 's4', name: '王芳' },
  { id: 's5', name: '赵六' },
];

// ── parseSmartConstraint ───────────────────────────────────────────────

test('解析合法 JSON', () => {
  const c = parseSmartConstraint('{"preferFront":["张小明"],"avoidFront":["李雷"],"spread":false,"strategy":null}');
  assert.deepEqual(c.preferFront, ['张小明']);
  assert.deepEqual(c.avoidFront, ['李雷']);
  assert.equal(c.strategy, null);
  assert.equal(c.spread, false);
});

test('容错：带 markdown 围栏', () => {
  const c = parseSmartConstraint('```json\n{"preferFront":["张小明"]}\n```');
  assert.deepEqual(c.preferFront, ['张小明']);
});

test('容错：前后有解释文字', () => {
  const c = parseSmartConstraint('好的，安排如下：{"preferFront":["张小明"],"avoidFront":[]} 已安排。');
  assert.deepEqual(c.preferFront, ['张小明']);
});

test('容错：非法 JSON 回退空约束', () => {
  const c = parseSmartConstraint('完全不是 JSON');
  assert.deepEqual(c.preferFront, []);
  assert.equal(c.strategy, null);
});

test('容错：空输入回退空约束', () => {
  assert.deepEqual(parseSmartConstraint(''), { preferFront: [], avoidFront: [], pairs: [], spread: false, strategy: null });
});

test('strategy=activity 与 pairs 解析', () => {
  const c = parseSmartConstraint('{"strategy":"activity","pairs":[["张小明","李雷"]]}');
  assert.equal(c.strategy, 'activity');
  assert.deepEqual(c.pairs, [['张小明', '李雷']]);
});

// ── validateConstraintNames ───────────────────────────────────────────

test('识别名单外的姓名', () => {
  const { unknown, ok } = validateConstraintNames({ preferFront: ['不存在的人'], avoidFront: [], pairs: [], spread: false, strategy: null }, STUDENTS);
  assert.equal(ok, false);
  assert.deepEqual(unknown, ['不存在的人']);
});

test('名单内姓名全部通过', () => {
  const { ok, unknown } = validateConstraintNames({ preferFront: ['张小明'], avoidFront: ['李雷'], pairs: [], spread: false, strategy: null }, STUDENTS);
  assert.equal(ok, true);
  assert.deepEqual(unknown, []);
});

// ── orderStudentsForSeats ─────────────────────────────────────────────

test('preferFront 排最前，avoidFront 排最后', () => {
  const ordered = orderStudentsForSeats(STUDENTS, {
    preferFront: ['张小明'], avoidFront: ['李雷'], pairs: [], spread: false, strategy: null,
  });
  assert.equal(ordered[0].name, '张小明', 'preferFront 应第一位');
  assert.equal(ordered[ordered.length - 1].name, '李雷', 'avoidFront 应最后一位');
  // 其余保持名单顺序且不重复
  const rest = ordered.slice(1, -1).map(s => s.name);
  assert.deepEqual(rest, ['韩梅梅', '王芳', '赵六']);
  assert.equal(new Set(ordered.map(s => s.id)).size, STUDENTS.length, '不应丢学生');
});

test('空约束 = 保持原顺序（恒等）', () => {
  const ordered = orderStudentsForSeats(STUDENTS, { preferFront: [], avoidFront: [], pairs: [], spread: false, strategy: null });
  assert.deepEqual(ordered.map(s => s.id), STUDENTS.map(s => s.id));
});

test('strategy=activity 时分组在前', () => {
  const withGroup = STUDENTS.map(s => ({ ...s, group_id: s.id === 's1' || s.id === 's3' ? 'g1' : 'g2' }));
  const ordered = orderStudentsForSeats(withGroup, { preferFront: [], avoidFront: ['赵六'], pairs: [], spread: false, strategy: 'activity' });
  // g1, g2 组员都在 avoidFront(赵六) 之前；赵六最后
  assert.equal(ordered[ordered.length - 1].name, '赵六');
  const firstHalf = ordered.slice(0, -1);
  assert.ok(firstHalf.every(s => s.group_id === 'g1' || s.group_id === 'g2'));
});

test('姓名重复名单时按首次出现匹配（byName 去重）', () => {
  const dup = [
    { id: 'a1', name: '张三' },
    { id: 'a2', name: '张三' },
    { id: 'a3', name: '李四' },
  ];
  const ordered = orderStudentsForSeats(dup, { preferFront: ['张三'], avoidFront: [], pairs: [], spread: false, strategy: null });
  assert.equal(ordered[0].id, 'a1', '张三去重后优先命中首个 a1');
});

// ── buildSmartPrompt ──────────────────────────────────────────────────

test('prompt 包含名单与要求', () => {
  const { prompt, systemInstruction } = buildSmartPrompt(STUDENTS, '近视坐前面');
  assert.ok(prompt.includes('张小明'));
  assert.ok(prompt.includes('近视坐前面'));
  assert.ok(systemInstruction.includes('JSON'));
});

test('pairs 邻座：配对学生在结果中相邻', () => {
  const c = { preferFront: [], avoidFront: [], pairs: [['张小明', '韩梅梅']], spread: false, strategy: null };
  const ordered = orderStudentsForSeats(STUDENTS, c);
  const names = ordered.map(s => s.name);
  const iZhang = names.indexOf('张小明');
  const iHan = names.indexOf('韩梅梅');
  assert.equal(Math.abs(iZhang - iHan), 1, `张小明与韩梅梅应相邻：${names.join('>')}`);
});

test('pairs 链式：A-B 与 B-C 聚成 3 连坐', () => {
  const c = { preferFront: [], avoidFront: [], pairs: [['张小明', '李雷'], ['李雷', '王芳']], spread: false, strategy: null };
  const ordered = orderStudentsForSeats(STUDENTS, c);
  const names = ordered.map(s => s.name);
  // 张小明、李雷、王芳三者连续（任一顺序）
  const sub = ['张小明', '李雷', '王芳'].map(n => names.indexOf(n)).sort((a, b) => a - b);
  assert.equal(sub[2] - sub[0], 2, `三人应连续：${names.join('>')}`);
});

test('pairs 与 preferFront 并存：优先组前排且组内相邻', () => {
  const c = { preferFront: ['张小明'], avoidFront: [], pairs: [['张小明', '韩梅梅']], spread: false, strategy: null };
  const ordered = orderStudentsForSeats(STUDENTS, c);
  const names = ordered.map(s => s.name);
  // 张小明是组代表，组放最前；张小明-韩梅梅相邻
  assert.equal(names[0], '张小明', 'preferFront 组应在最前');
  assert.equal(names[1], '韩梅梅', '配对组成员紧随其后');
});

test('pairs 引用不存在学生时忽略且不崩溃', () => {
  const c = { preferFront: [], avoidFront: [], pairs: [['不存在', '张小明']], spread: false, strategy: null };
  const ordered = orderStudentsForSeats(STUDENTS, c);
  assert.equal(new Set(ordered.map(s => s.id)).size, STUDENTS.length, '不丢学生');
});
