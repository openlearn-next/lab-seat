// CSV 工具函数（RFC 4180）。
// 独立文件以便 test/csv.test.mjs 直接用 esbuild --format=esm 编译后验证。

/**
 * 转义单个 CSV 字段。
 * - null/undefined → 空字段
 * - 含 `,`、`"`、`\r`、`\n` 时用双引号包裹，内部 `"` 转义为 `""`
 * - 其他情况原样返回（强制 toString）
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 将一行字段数组拼接为 CSV 行（含行末 `\n`）。
 * 不会自动加 BOM —— 调用方按目标编码需要自行添加 `\uFEFF`。
 */
export function csvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(',') + '\n';
}