// Pino mock：返回 noop logger，避免在测试环境触发 file/transport 初始化。
const noop = () => {};
function child() { return logger; }
const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const logger = { child };
for (const lvl of levels) logger[lvl] = noop;
logger.info = noop;
logger.fatal = noop;
logger.error = noop;
logger.debug = noop;
logger.trace = noop;
logger.warn = noop;
// SDK 内部调用 logger.transport() / 设置 transport；mock 为可调用但 noop
logger.transport = noop;
logger.flush = noop;

function pino(opts) {
  // SDK 也会传 options 进来
  return logger;
}
pino.transport = noop;
pino.multistream = noop;
pino.stdSerializers = { err: (e) => e };
pino.destination = noop;
pino.symbols = {};

// ── Express / body-parser / jszip mocks ──
// SDK 内部 inline 了这些但 plugin 运行时并不调用它们。
// 提供空 stub 防止模块加载时触发 CommonJS dynamic require 失败。

export const express = function express() { return {}; };
express.json = () => (_req, _res, next) => next();
express.urlencoded = () => (_req, _res, next) => next();
express.Router = () => ({});
express.static = () => (_req, _res, next) => next();

export const bodyParser = {
  json: () => (_req, _res, next) => next(),
  urlencoded: () => (_req, _res, next) => next(),
  text: () => (_req, _res, next) => next(),
  raw: () => (_req, _res, next) => next(),
};

export const JSZip = class JSZip {
  constructor() { this.files = {}; }
  file(name, content) { this.files[name] = content; return this; }
  folder() { return this; }
  async generateAsync() { return new Uint8Array(); }
};
JSZip.loadAsync = async () => new JSZip();
JSZip.support = { nodebuffer: true };

export const semver = {
  compare: () => 0,
  gt: () => false,
  gte: () => true,
  lt: () => false,
  lte: () => true,
  eq: () => true,
  valid: (v) => v,
  coerce: (v) => v,
};

// uuid v7 — SDK 用 v7 生成 UUID
export const v7 = () => '00000000-0000-7000-8000-000000000000';
export function v4() { return '00000000-0000-4000-8000-000000000000'; }

export function pinoPretty() { return null; }
export { pino };
export default pino;