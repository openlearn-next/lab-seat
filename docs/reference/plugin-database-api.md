# 插件数据库 API 与 Migration 规范

> **适用范围**：`@openlearn/plugin-sdk@3.4.3`
> 本页说明插件可用的两条数据库路径、事务支持、以及插件版本升级时的表结构迁移范式。

---

## 1. 两条数据库路径（务必分清）

插件有**两条**数据库访问路径，丰富的方法集（`query` / `select` / `insert` / `update` / `delete` / `transaction` / `exec`）**不在**插件 API 上，而在原始 `better-sqlite3` 实例上。

### 路径 A — `ctx.db`：`PluginDatabaseAPI`（命名空间隔离，推荐）
仅 4 个方法，所有表自动加前缀 `plugin_{pluginId}_`，互不干扰。

```typescript
// packages/core/plugin-host/types.ts:96-106
interface PluginDatabaseAPI {
  ensureTable(tableName: string, schema: string): Promise<void>;
  table(tableName: string): string;
  dropAllTables(): Promise<void>;
  migrate(targetVersion: number, upgradeFn: (db: any) => Promise<void> | void): Promise<void>;
}
```

| 方法 | 签名 | 说明 |
|---|---|---|
| `ensureTable` | `(tableName, schema) => Promise<void>` | `schema` 是**列定义片段**（非完整 `CREATE TABLE`），表名自动加前缀；执行 `CREATE TABLE IF NOT EXISTS` |
| `table` | `(tableName) => string` | **同步**。返回完整表名 `plugin_{pluginId}_{tableName}` |
| `dropAllTables` | `() => Promise<void>` | 删除匹配 `plugin_{pluginId}_%` 的所有表；卸载时由 PluginHost 自动调用 |
| `migrate` | `(targetVersion, upgradeFn) => Promise<void>` | 声明式版本化迁移（见 §3） |

**SQL 方言**：SQLite（better-sqlite3 `^12.11.1`）。**无查询构造器**，插件需手写原生 SQL。

### 路径 B — `ctx.resolve(IDatabaseToken)`：原始 `better-sqlite3.Database`（非命名空间）
```typescript
const db = await ctx.resolve(IDatabaseToken); // 类型: better-sqlite3.Database
```
- 注册于 `packages/core/kernel/index.ts:211`，是**整个平台共享数据库**，可读写任意表（`vfs_nodes`、`students`、`users` 等）。
- **无命名空间隔离**。所有内置插件的数据操作实际走此路径（`vfs.ts:29`、`management.ts:29`、`builtin.ts:54` 等）。
- 这是唯一能执行 `SELECT` / `INSERT` / `UPDATE` / `DELETE` / 事务的路径。
- **类型缺口**：发布的 SDK 将 `IDatabaseToken` 声明为 `Token<unknown>`（`openlearn.d.ts:305`），仅从 `@openlearn/plugin-sdk` 导入时 `resolve` 结果需自行断言为 `better-sqlite3.Database` 后使用 `prepare()` / `exec()`。

---

## 2. 事务支持

- `PluginDatabaseAPI` **没有** `transaction` / `beginTransaction` 方法。
- 事务仅在**路径 B 原始 `better-sqlite3` 实例**上可用，使用 better-sqlite3 的**回调式** `db.transaction(fn)` API（调用返回函数即执行）：
  ```typescript
  const db = await ctx.resolve(IDatabaseToken);
  const deleteTransaction = db.transaction(() => {
    db.prepare('DELETE FROM students WHERE id = ?').run(id);
    db.prepare('DELETE FROM grades WHERE student_id = ?').run(id);
  });
  deleteTransaction(); // 执行
  ```
  真实用例：`packages/plugins/management.ts:235`、`packages/plugins/builtin.ts:679`。
- **Worker（隔离）模式例外**：worker 隔离插件的 `migrate` 回调拿到的是**受限包装**，仅暴露 `prepare().run()` / `prepare().get()` / `prepare().all()`——**无 `exec`、无 `transaction`**（`worker-manager.ts:600-617`）。故 worker 隔离插件实际上无法使用真正的事务。

---

## 3. Migration / 版本升级范式

插件自有表拥有**正式的 `migrate()` API**（v5.1，`context-builder.ts:529-557`）：

```typescript
async migrate(targetVersion: number, upgradeFn: (db: any) => Promise<void> | void) {
  db.exec(`CREATE TABLE IF NOT EXISTS plugin_migrations (plugin_id TEXT PRIMARY KEY, version INTEGER NOT NULL)`);
  const row = db.prepare(`SELECT version FROM plugin_migrations WHERE plugin_id = ?`).get(pluginId);
  const currentVersion = row ? row.version : 0;
  if (currentVersion < targetVersion) {
    await upgradeFn(db);
    db.prepare(`INSERT OR REPLACE INTO plugin_migrations (plugin_id, version) VALUES (?, ?)`).run(pluginId, targetVersion);
  }
}
```

**行为**：在 `plugin_migrations` 表记录版本（`plugin_id` 主键）。`migrate(target, fn)` 读取当前版本（默认 0）；若 `current < target` 则执行 `upgradeFn(db)`（进程内原始 `better-sqlite3` 实例，可 `exec` / `prepare().run()` / `transaction()`），再写入 `target`。**幂等**。

**标准范式**（官方教程示例，`tutorials/plugin-development-tutorial.md:1460-1477`）：
```typescript
export async function activate(ctx: PluginContext) {
  // v1：建表
  await ctx.db.migrate(1, async (sqliteDb) => {
    sqliteDb.exec(`CREATE TABLE IF NOT EXISTS my_table (id TEXT PRIMARY KEY, data TEXT)`);
  });
  // v2：加列
  await ctx.db.migrate(2, async (sqliteDb) => {
    sqliteDb.exec(`ALTER TABLE my_table ADD COLUMN extra TEXT DEFAULT ''`);
  });
  // v3：再加索引等
  await ctx.db.migrate(3, async (sqliteDb) => {
    sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_my_table_extra ON my_table(extra)`);
  });
}
```
> 每次版本升级只需新增一个更高 `targetVersion` 的 `migrate` 调用；旧版本已应用过则自动跳过。

**注意**：
- 插件表**没有 down-migration / 回滚**机制，只有 `dropAllTables()`（卸载时自动调用）。
- `migrate` 的 `upgradeFn` 在**进程内**拿到完整 `better-sqlite3` 实例（可用 `exec`）；worker 隔离模式下为受限包装（见 §2）。
- `migrations/` 目录 + `server/utils/migrate.ts` 的 `runMigrations` 是**核心平台 schema** 迁移系统，**不是**插件迁移系统；核心 `packages/core/db/index.ts` 当前仍用遗留的 `try/catch ALTER` 引导模式。插件请只用 §3 的 `ctx.db.migrate`。

---

## 4. 命名空间与获取方式

| 项目 | 路径 A `ctx.db` | 路径 B `ctx.resolve(IDatabaseToken)` |
|---|---|---|
| 命名空间 | 自动前缀 `plugin_{pluginId}_`（`pluginId` = `manifest.id`，非内核 UUID） | 无，整个平台库 |
| 暴露位置 | `types.ts:131` / `context-builder.ts:629` | `kernel/index.ts:211` |
| 适用 | 插件私有表 | 跨表查询 / 读写平台表 / 事务 |

**KV 存储（非 SQL）**：`ctx.services.storage`（`IStorageService` 的 `get` / `set` / `delete`）后端为 `plugin_storage` 表，**按 `plugin_id` 自动命名空间隔离**（`context-builder.ts:475`），适合简单键值，无需建表。

---

## 5. 最佳实践

- 优先用 `ctx.db.ensureTable()` + `ctx.db.table()` 管理插件私有表；精细控制（联表、事务、读写平台表）再落到 `ctx.resolve(IDatabaseToken)` 的原始实例。
- 升级表结构一律走 `ctx.db.migrate(targetVersion, fn)`，保证幂等与版本可追溯。
- Worker 隔离模式插件避免依赖事务与 `exec`。

> 最后更新：2026-07-26
