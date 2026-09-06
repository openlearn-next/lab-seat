// Plugin integration harness：模拟 host runtime（CommandBus / EventBus / DB），
// 验证 lab_seat plugin 在以下边界场景下不崩溃：
//   1) 全新 install（computer_labs 表不存在）
//   2) 升级 install（computer_labs 已存在但无 name/layout_json/updated_at 列）
//   3) 全部列已存在（幂等迁移）
//   4) 每个 command handler 注册成功
//   5) 关键 commands（list_rooms / create_room / assign_seats / check_in / open_check_in / list_lessons）调用不抛错
//
// 运行：node --test test/plugin.test.mjs
// 依赖：node test/build-test-bundle.mjs 先生成 tmp/plugin-test-bundle.mjs

import assert from 'node:assert/strict';
import { test, before, beforeEach, after } from 'node:test';
import Database from 'better-sqlite3';
import plugin from '../tmp/plugin-test-bundle.mjs';

// ── Test helpers ─────────────────────────────────────────────────────────

function createMockContext(db, extraConfig) {
  const commandHandlers = new Map();
  const actionDescriptors = [];
  const publishedEvents = [];
  const providedServices = new Map();
  const resolvedTokens = new Map();

  // 可选的运行配置覆盖（默认全 0 → 自动判定关闭）
  const config = {
    points_per_check_in: 5,
    late_threshold_minutes: 10,
    auto_mark_leave_after_minutes: 0,
    late_auto_promote_after_minutes: 0,
    auto_scan_interval_seconds: 60,
    ...(extraConfig || {}),
  };

  // Plugin ctx.db namespace —— 给 plugin 的命名空间表
  const ctx_db_table = (suffix) => `plugin_lab_seat_${suffix}`;

  const ctx = {
    pluginId: '@aymwoo/plugin-lab-seat',
    manifest: plugin.manifest,
    config,

    services: {
      commandBus: {
        async registerHandler(type, handler) {
          commandHandlers.set(type, handler);
        },
        async execute(command) {
          const handler = commandHandlers.get(command.type);
          if (!handler) throw new Error(`No handler for ${command.type}`);
          return handler.execute(command);
        },
      },
      eventBus: {
        async publish(event) { publishedEvents.push(event); },
        async subscribe(type, handler) { /* no-op in mock */ },
        async unsubscribe(type, handler) {},
      },
      actionRegistry: {
        async register(desc) { actionDescriptors.push(desc); },
      },
      capability: {},
      processManager: {},
      storage: {},
      // mock AI：默认不可用（generateText 抛错）；传入 extraConfig.aiOutput 时返回固定输出
      ai: (() => {
        const out = extraConfig?.aiOutput;
        return out !== undefined
          ? { async generateText() { return out; } }
          : {};
      })(),
    },

    resolve: async (token) => {
      // IDatabaseToken: 直接返回 better-sqlite3 实例
      if (token?.name === '@openlearn/core:IDatabase') return db;
      // IPointsLedgerServiceToken: 抛出未注册（plugin 应静默处理）
      if (token?.name === '@openlearn/core:IPointsLedgerService') {
        throw new Error('IPointsLedgerService not installed');
      }
      // 跨插件服务：返回 mock 或抛错
      if (providedServices.has(token)) return providedServices.get(token);
      throw new Error(`Unknown token: ${token?.name}`);
    },

    db: {
      table: ctx_db_table,
      migrate: async (version, callback) => {
        // 模拟 ctx.db.migrate：把 better-sqlite3 实例传给 callback
        await callback(db);
      },
    },

    log: {
      info: (...args) => console.log('[plugin info]', ...args),
      warn: (...args) => console.warn('[plugin warn]', ...args),
      error: (...args) => console.error('[plugin error]', ...args),
    },

    provide: async (token, instance) => {
      providedServices.set(token, instance);
    },

    // 测试辅助：暴露内部 mock state
    __test__: {
      commandHandlers,
      actionDescriptors,
      publishedEvents,
      providedServices,
    },
  };

  return ctx;
}

function createHostSchema(db) {
  // 模拟宿主 OpenLearn 的核心表（lab-seat plugin 依赖它们做 JOIN）
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student'
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      name TEXT,
      title TEXT,
      status TEXT,
      timeline TEXT,
      teacher_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE IF NOT EXISTS class_students (
      class_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      PRIMARY KEY (class_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS computer_labs (
      id TEXT PRIMARY KEY,
      room_number TEXT NOT NULL,
      name TEXT DEFAULT '',
      rows INTEGER NOT NULL DEFAULT 5,
      cols INTEGER NOT NULL DEFAULT 8,
      layout_json TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS plugin_research_groups (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL,
      member_ids TEXT NOT NULL
    );
  `);
}

// ── Test fixtures ─────────────────────────────────────────────────────────

let db;
let ctx;
let mock;

before(async () => {
  // 共享 db，但每个 test 各自创建/清空表
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
});

beforeEach(async () => {
  // 清空所有表
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all();
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS ${t.name}`);
});

after(() => db.close());

// ── Tests ─────────────────────────────────────────────────────────────────

test('全新 install：computer_labs 表不存在时迁移不崩', async () => {
  // 模拟全新安装：computer_labs 表不存在
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT);
  `);
  // 不创建 computer_labs

  ctx = createMockContext(db);
  mock = ctx.__test__;

  await assert.doesNotReject(
    () => plugin.activate(ctx),
    'activate 在 computer_labs 不存在时不应抛出',
  );

  // ALTER TABLE 应该让 computer_labs 表出现
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='computer_labs'"
  ).all();
  assert.equal(tables.length, 1, 'computer_labs 表应该被创建');
  // 检查新增的列
  const cols = db.prepare('PRAGMA table_info(computer_labs)').all();
  const colNames = cols.map(c => c.name);
  assert.ok(colNames.includes('name'), '应有 name 列');
  assert.ok(colNames.includes('layout_json'), '应有 layout_json 列');
  assert.ok(colNames.includes('updated_at'), '应有 updated_at 列');
});

test('升级 install：computer_labs 已存在但缺 name 列', async () => {
  // 模拟已有 schema
  db.exec(`
    CREATE TABLE computer_labs (
      id TEXT PRIMARY KEY,
      room_number TEXT NOT NULL,
      rows INTEGER DEFAULT 5,
      cols INTEGER DEFAULT 8,
      created_at INTEGER DEFAULT (unixepoch())
    );
    INSERT INTO computer_labs (id, room_number) VALUES ('lab-old', 'A101');
  `);

  ctx = createMockContext(db);
  mock = ctx.__test__;

  await assert.doesNotReject(() => plugin.activate(ctx));

  // 验证列被添加
  const cols = db.prepare('PRAGMA table_info(computer_labs)').all();
  const colNames = cols.map(c => c.name);
  assert.ok(colNames.includes('name'), 'name 列应被 ALTER TABLE 添加');
  assert.ok(colNames.includes('layout_json'), 'layout_json 列应被添加');

  // 验证 room_number 被回填到 name
  const row = db.prepare('SELECT * FROM computer_labs WHERE id = ?').get('lab-old');
  assert.equal(row.name, 'A101', '存量数据的 room_number 应自动填充到 name');
});

test('幂等迁移：所有列已存在时 activate 不重复添加', async () => {
  db.exec(`
    CREATE TABLE computer_labs (
      id TEXT PRIMARY KEY,
      room_number TEXT NOT NULL,
      name TEXT DEFAULT '',
      rows INTEGER DEFAULT 5,
      cols INTEGER DEFAULT 8,
      layout_json TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT 0
    );
  `);

  ctx = createMockContext(db);
  await assert.doesNotReject(() => plugin.activate(ctx));

  // 不应该有任何 duplicate column 错误
  const cols = db.prepare('PRAGMA table_info(computer_labs)').all();
  const nameCount = cols.filter(c => c.name === 'name').length;
  assert.equal(nameCount, 1, 'name 列应该恰好出现 1 次（幂等）');
});

test('activate 注册所有 commands / actions', async () => {
  createHostSchema(db);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  // 期望的 commands（来自 src/index.ts）
  const expectedCommands = [
    'lab_seat.create_room',
    'lab_seat.update_layout',
    'lab_seat.list_rooms',
    'lab_seat.get_room',
    'lab_seat.assign_seats',
    'lab_seat.move_student',
    'lab_seat.unassign_student',
    'lab_seat.get_assignments',
    'lab_seat.open_check_in',
    'lab_seat.close_check_in',
    'lab_seat.check_in',
    'lab_seat.manual_check_in',
    'lab_seat.get_active_check_in',
    'lab_seat.get_attendance',
    'lab_seat.get_my_seat',
    'lab_seat.export_attendance',
    'lab_seat.attendance_trend',
    'lab_seat.shuffle_seats',
    'lab_seat.smart_assign_seats',
    'lab_seat.save_template',
    'lab_seat.list_templates',
    'lab_seat.get_current_lesson_attendance',
    'lab_seat.list_lessons',
    'lab_seat.auto_mark_absent',
    'lab_seat.list_lesson_labs',
    'lab_seat.add_lesson_lab',
    'lab_seat.remove_lesson_lab',
  ];
  for (const type of expectedCommands) {
    assert.ok(
      mock.commandHandlers.has(type),
      `Command handler "${type}" 未注册`,
    );
  }
  assert.equal(mock.commandHandlers.size, expectedCommands.length,
    `命令注册数量不匹配：期望 ${expectedCommands.length}，实际 ${mock.commandHandlers.size}`);

  // 期望的 actions
  const expectedActions = [
    'lab_seat-create-room',
    'lab_seat-auto-assign',
    'lab_seat-check-in',
    'lab_seat-get-attendance',
    'lab_seat-export-report',
    'lab_seat-shuffle-seats',
    'lab_seat-list-lessons',
    'lab_seat-smart-assign',
  ];
  const actionIds = mock.actionDescriptors.map(a => a.id);
  for (const id of expectedActions) {
    assert.ok(actionIds.includes(id), `Action "${id}" 未注册`);
  }
});

test('create_room → list_rooms 链路', async () => {
  createHostSchema(db);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const createHandler = mock.commandHandlers.get('lab_seat.create_room');
  const listHandler = mock.commandHandlers.get('lab_seat.list_rooms');

  const cmd = {
    id: 'cmd-1', type: 'lab_seat.create_room', actorId: 'teacher-1',
    payload: { room_number: '410', name: 'A410', rows: 5, cols: 8 },
  };
  const result = await createHandler.execute(cmd);
  assert.ok(result.roomId, 'create_room 应返回 roomId');

  const rooms = await listHandler.execute({ type: 'lab_seat.list_rooms', actorId: 'teacher-1' });
  assert.equal(rooms.length, 1, '应列出 1 个机房');
  assert.equal(rooms[0].room_number, '410');
  assert.equal(rooms[0].name, 'A410');
  assert.equal(rooms[0].rows, 5);
  assert.equal(rooms[0].display_name, 'A410', 'display_name 应 fallback 到 name');
});

test('list_lessons 返回课节并按 status 排序', async () => {
  createHostSchema(db);
  // 插入混合状态课节
  db.exec(`
    INSERT INTO lessons (id, name, status, started_at) VALUES
      ('l-old', '历史课', 'ended', 1000),
      ('l-live', '今日课', 'live', 9999),
      ('l-future', '明日课', 'scheduled', 5000);
  `);

  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const handler = mock.commandHandlers.get('lab_seat.list_lessons');
  const lessons = await handler.execute({
    type: 'lab_seat.list_lessons', actorId: 't-1', payload: { limit: 10 },
  });

  assert.equal(lessons.length, 3);
  // 'live' 应该排第一
  assert.equal(lessons[0].id, 'l-live', 'live 状态课节应优先');
});

test('list_lessons 在 lessons 表不存在时安全返回空数组', async () => {
  // 不创建 lessons 表
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);`);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await assert.doesNotReject(() => plugin.activate(ctx));

  const handler = mock.commandHandlers.get('lab_seat.list_lessons');
  const lessons = await handler.execute({
    type: 'lab_seat.list_lessons', actorId: 't-1', payload: { limit: 10 },
  });
  assert.deepEqual(lessons, [], 'lessons 表不存在应返回空数组，不抛错');
});

test('积分集成：积分服务缺失时签到仍成功', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES ('s-1', '张三', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id, name) VALUES ('c-1', 'CS101');
    INSERT INTO class_students (class_id, student_id) VALUES ('c-1', 's-1');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-1', 'A101', 5, 8);
  `);

  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  // 分配座位
  const assignHandler = mock.commandHandlers.get('lab_seat.assign_seats');
  await assignHandler.execute({
    type: 'lab_seat.assign_seats', actorId: 't-1',
    payload: { lessonId: 'l-1', labId: 'lab-1', strategy: 'sequential' },
  });

  // 开启签到
  const openHandler = mock.commandHandlers.get('lab_seat.open_check_in');
  await openHandler.execute({
    type: 'lab_seat.open_check_in', actorId: 't-1',
    payload: { lessonId: 'l-1', labId: 'lab-1' },
  });

  // 学生签到（积分服务缺失 → 应静默跳过）
  const checkInHandler = mock.commandHandlers.get('lab_seat.check_in');
  let result;
  await assert.doesNotReject(
    async () => {
      result = await checkInHandler.execute({
        type: 'lab_seat.check_in', actorId: 's-1',
        payload: { lessonId: 'l-1' },
      });
    },
    '签到不应因积分服务缺失而抛出',
  );
  assert.ok(result && (result.status === 'checked_in' || result.status === 'late'),
    `签到应返回 status，实际：${JSON.stringify(result)}`);
});

test('跨插件服务 ILabSeatService 提供（仅主进程有效）', async () => {
  createHostSchema(db);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  // 由于 activate 内部会调用 ctx.provide（如果存在），应该看到 providedServices 中有 1 个
  assert.ok(mock.providedServices.size >= 1, '应该至少注册了 1 个跨插件服务');
});

test('§2.4 update_layout 接收 LayoutEditor 提交的完整布局', async () => {
  createHostSchema(db);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  // 创建机房
  await mock.commandHandlers.get('lab_seat.create_room').execute({
    type: 'lab_seat.create_room', actorId: 't-1',
    payload: { room_number: '410', name: 'A410', rows: 3, cols: 3 },
  });

  const room = db.prepare('SELECT * FROM computer_labs WHERE room_number = ?').get('410');
  assert.ok(room, '机房应该被创建');

  // 调用 update_layout 提交 LayoutEditor 形式的数据
  const newLayout = {
    rows: 3, cols: 3,
    numbering: { scheme: 'alphanumeric', direction: 'row-first' },
    cells: [
      { row: 0, col: 0, label: 'A1', type: 'notebook', ip: '192.168.1.10', note: '靠近投影仪' },
      { row: 0, col: 1, label: 'A2', type: 'desktop',  ip: '', note: '' },
      { row: 0, col: 2, label: 'A3', type: 'none',     ip: '', note: '损坏' },
    ],
  };
  await mock.commandHandlers.get('lab_seat.update_layout').execute({
    type: 'lab_seat.update_layout', actorId: 't-1',
    payload: { roomId: room.id, layout: newLayout },
  });

  // 重新读取看 layout 是否被持久化
  const updated = db.prepare('SELECT layout_json, updated_at FROM computer_labs WHERE id = ?').get(room.id);
  const parsed = JSON.parse(updated.layout_json);
  assert.equal(parsed.cells[0].type, 'notebook', 'cell.type 应该被更新');
  assert.equal(parsed.cells[0].ip, '192.168.1.10', 'cell.ip 应该被持久化');
  assert.equal(parsed.cells[2].note, '损坏', 'cell.note 应该被持久化');
  assert.ok(updated.updated_at > 0, 'updated_at 戳应被更新');
});

test('§3.1 多机房批量分配 + lesson_lab_map 登记', async () => {
  createHostSchema(db);
  // 两个机房（各 2×2 = 4 个座位），4 个学生
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('s1', '张三', 'student'), ('s2', '李四', 'student'),
      ('s3', '王五', 'student'), ('s4', '赵六', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES
      ('c-1', 's1'), ('c-1', 's2'), ('c-1', 's3'), ('c-1', 's4');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES
      ('lab-A', 'A101', 2, 2), ('lab-B', 'A102', 2, 2);
  `);

  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  // 单机房 batch 1：4 个学生 先填 lab-A（容量 4）
  const assign = mock.commandHandlers.get('lab_seat.assign_seats');
  const r1 = await assign.execute({
    type: 'lab_seat.assign_seats', actorId: 't-1',
    payload: { lessonId: 'l-1', labIds: ['lab-A', 'lab-B'], strategy: 'sequential' },
  });
  assert.ok(r1.message.includes('4'), '应分配全部 4 名学生');

  // map 应登记两个 lab
  const mapRows = db.prepare(`SELECT * FROM plugin_lab_seat_lesson_room_map WHERE lesson_id = 'l-1'`).all();
  assert.equal(mapRows.length, 2, 'lesson_room_map 应登记 2 个机房');

  // 每个学生有且仅有一条分配
  const cnt = db.prepare(`SELECT COUNT(*) as c FROM plugin_lab_seat_seat_assignments WHERE lesson_id = 'l-1'`).get();
  assert.equal(cnt.c, 4);

  // list_lesson_labs 返回 2 个，人数合计 4
  const listLabs = mock.commandHandlers.get('lab_seat.list_lesson_labs');
  const labs = await listLabs.execute({ type: 'lab_seat.list_lesson_labs', actorId: 't-1', payload: { lessonId: 'l-1' } });
  assert.equal(labs.length, 2);
  assert.equal(labs.reduce((s, x) => s + x.assigned_count, 0), 4);

  // 重新分配为单个 lab-A：只会落在 lab-A，map 保持
  await assign.execute({
    type: 'lab_seat.assign_seats', actorId: 't-1',
    payload: { lessonId: 'l-1', labId: 'lab-A', strategy: 'random' },
  });
  const inB = db.prepare(`SELECT COUNT(*) as c FROM plugin_lab_seat_seat_assignments WHERE lesson_id = 'l-1' AND lab_id = 'lab-B'`).get();
  assert.equal(inB.c, 0, '仅分配 lab-A 时不应有学生落在 lab-B');
});

test('§3.1 容量不足时抛出明确错误', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('s1', '张三', 'student'), ('s2', '李四', 'student'), ('s3', '王五', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES
      ('c-1', 's1'), ('c-1', 's2'), ('c-1', 's3');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 1, 1);
  `);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const assign = mock.commandHandlers.get('lab_seat.assign_seats');
  await assert.rejects(
    () => assign.execute({
      type: 'lab_seat.assign_seats', actorId: 't-1',
      payload: { lessonId: 'l-1', labId: 'lab-A', strategy: 'sequential' },
    }),
    /座位不足/,
    '容量不足时抛出明确错误',
  );
});

test('§3.2 自动判定：超时未签到标记请假 + 迟到升级缺勤', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('s1', '张三', 'student'), ('s2', '李四', 'student'), ('s3', '王五', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES
      ('c-1', 's1'), ('c-1', 's2'), ('c-1', 's3');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 2, 2);
  `);
  // 启用自动判定：1 分钟超时未签到 → leave；迟到 1 分钟 → absent
  ctx = createMockContext(db, {
    auto_mark_leave_after_minutes: 1,
    late_auto_promote_after_minutes: 1,
  });
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const assign = mock.commandHandlers.get('lab_seat.assign_seats');
  await assign.execute({ type: 'lab_seat.assign_seats', actorId: 't-1', payload: { lessonId: 'l-1', labId: 'lab-A', strategy: 'sequential' } });

  // 开启签到，并把 opened_at 拨到 13 分钟前：
  //  - s2 现在签到 → late（>10min 阈值），且超出 promote 阈值（1min）→ 升级 absent
  //  - s3 不签到 → 超 leave 阈值（1min）→ 标记请假
  await mock.commandHandlers.get('lab_seat.open_check_in').execute({
    type: 'lab_seat.open_check_in', actorId: 't-1', payload: { lessonId: 'l-1', labId: 'lab-A' },
  });
  const past = Date.now() - 13 * 60 * 1000;
  db.prepare(`UPDATE plugin_lab_seat_check_in_sessions SET opened_at = ? WHERE lesson_id = 'l-1'`).run(past);

  // s2 迟到签到，s3 干脆不签到
  await mock.commandHandlers.get('lab_seat.check_in').execute({
    type: 'lab_seat.check_in', actorId: 's2', payload: { lessonId: 'l-1' },
  });

  // 手动触发一次自动扫描（不等待 interval）
  await mock.commandHandlers.get('lab_seat.auto_mark_absent').execute({
    type: 'lab_seat.auto_mark_absent', actorId: 't-1', payload: {},
  });

  const att = (sid) => db.prepare(
    `SELECT status FROM plugin_lab_seat_attendance_records WHERE lesson_id = 'l-1' AND student_id = ?`).get(sid);
  // s2 签到被判 late，随后自动升级为 absent
  const s2 = att('s2');
  assert.equal(s2?.status, 'absent', `s2 迟到超时应升级缺勤，实际 ${s2?.status}`);
  // s3 完全未签 → 自动标记 leave
  const s3 = att('s3');
  assert.equal(s3?.status, 'leave', `s3 应自动标记请假，实际 ${s3?.status}`);

  // 清理后台 interval
  await plugin.deactivate();
});

test('§2.5 unassign_student 移除单个学生座位', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES ('s1', '张三', 'student'), ('s2', '李四', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES ('c-1', 's1'), ('c-1', 's2');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 2, 2);
  `);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const assign = mock.commandHandlers.get('lab_seat.assign_seats');
  await assign.execute({ type: 'lab_seat.assign_seats', actorId: 't-1', payload: { lessonId: 'l-1', labId: 'lab-A', strategy: 'sequential' } });

  const before = db.prepare(`SELECT COUNT(*) as c FROM plugin_lab_seat_seat_assignments WHERE lesson_id = 'l-1'`).get();
  assert.equal(before.c, 2);

  const move = mock.commandHandlers.get('lab_seat.move_student');
  await move.execute({ type: 'lab_seat.move_student', actorId: 't-1', payload: { lessonId: 'l-1', studentId: 's1', rowIdx: 1, colIdx: 1 } });
  const s1 = db.prepare(`SELECT row_idx, col_idx FROM plugin_lab_seat_seat_assignments WHERE lesson_id = 'l-1' AND student_id = 's1'`).get();
  assert.deepEqual({ r: s1.row_idx, c: s1.col_idx }, { r: 1, c: 1 });

  const unassign = mock.commandHandlers.get('lab_seat.unassign_student');
  const removed = await unassign.execute({ type: 'lab_seat.unassign_student', actorId: 't-1', payload: { lessonId: 'l-1', studentId: 's2' } });
  assert.equal(removed.removed, true);
  const after = db.prepare(`SELECT COUNT(*) as c FROM plugin_lab_seat_seat_assignments WHERE lesson_id = 'l-1'`).get();
  assert.equal(after.c, 1);

  const again = await unassign.execute({ type: 'lab_seat.unassign_student', actorId: 't-1', payload: { lessonId: 'l-1', studentId: 's2' } });
  assert.equal(again.removed, false);
});

test('P1 错误 code：无分配学生签到被拒 / 非本课节学生防刷', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('s1', '张小明', 'student'), ('s-x', '外部学生', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES ('c-1', 's1');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 2, 2);
  `);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  // 只有 s1 被分配到课节
  await mock.commandHandlers.get('lab_seat.assign_seats').execute({
    type: 'lab_seat.assign_seats', actorId: 't-1', payload: { lessonId: 'l-1', labId: 'lab-A', strategy: 'sequential' },
  });
  await mock.commandHandlers.get('lab_seat.open_check_in').execute({
    type: 'lab_seat.open_check_in', actorId: 't-1', payload: { lessonId: 'l-1', labId: 'lab-A' },
  });

  const checkIn = mock.commandHandlers.get('lab_seat.check_in');

  // s-x（未分配学生）签到 → NO_ASSIGNMENT，且消息带 [lab_seat:] 前缀
  await assert.rejects(
    () => checkIn.execute({ type: 'lab_seat.check_in', actorId: 's-x', payload: { lessonId: 'l-1' } }),
    (e) => { assert.ok(e.code === 'NO_ASSIGNMENT', `code 应为 NO_ASSIGNMENT，实际 ${e.code}`); return true; },
  );

  // 已分配学生 s1 签到成功，重复签到返回幂等已签到（不抛）
  const r1 = await checkIn.execute({ type: 'lab_seat.check_in', actorId: 's1', payload: { lessonId: 'l-1' } });
  assert.ok(r1.status === 'checked_in' || r1.status === 'late');
  const r2 = await checkIn.execute({ type: 'lab_seat.check_in', actorId: 's1', payload: { lessonId: 'l-1' } });
  assert.equal(r2.message, '已签到', '重复签到返回幂等提示');
});

test('§3.3 attendance_trend 按课节返回到课率时间序列', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('s1', '张三', 'student'), ('s2', '李四', 'student'), ('s3', '王五', 'student');
    INSERT INTO lessons (id, name, status) VALUES
      ('l-old', '上周课', 'ended'), ('l-new', '今日课', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES
      ('c-1', 's1'), ('c-1', 's2'), ('c-1', 's3');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 2, 2);
  `);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const assign = mock.commandHandlers.get('lab_seat.assign_seats');
  await assign.execute({ type: 'lab_seat.assign_seats', actorId: 't-1', payload: { lessonId: 'l-old', labId: 'lab-A', strategy: 'sequential' } });
  await assign.execute({ type: 'lab_seat.assign_seats', actorId: 't-1', payload: { lessonId: 'l-new', labId: 'lab-A', strategy: 'sequential' } });

  const now = Date.now();
  // 两个课节各有 3 人；开 l-new 签到，s1 签到；l-old 全部缺席
  const insSession = db.prepare(`INSERT INTO plugin_lab_seat_check_in_sessions (id, lesson_id, lab_id, status, opened_at, closed_at) VALUES (?, ?, ?, 'ended', ?, ?)`);
  insSession.run('sess-old', 'l-old', 'lab-A', now - 7 * 24 * 3600 * 1000, now - 7 * 24 * 3600 * 1000 + 3600 * 1000);
  insSession.run('sess-new', 'l-new', 'lab-A', now, null);
  const insAtt = db.prepare(`INSERT INTO plugin_lab_seat_attendance_records (id, lesson_id, student_id, status, checked_in_at, note) VALUES (?, 'l-new', 's1', 'checked_in', ?, '')`);
  insAtt.run('att-1', now);

  const trend = mock.commandHandlers.get('lab_seat.attendance_trend');
  const res = await trend.execute({ type: 'lab_seat.attendance_trend', actorId: 't-1', payload: { sinceDays: 30 } });

  assert.ok(res.series.length >= 2, `应至少返回 2 个课节，实际 ${res.series.length}`);
  const newer = res.series.find((x) => x.lessonId === 'l-new');
  const older = res.series.find((x) => x.lessonId === 'l-old');
  assert.equal(newer.total, 3);
  assert.equal(newer.checked_in, 1);
  assert.equal(newer.present, 1);
  assert.equal(older.present, 0);
  assert.equal(older.absent, 3);
  // 时间顺序：新在前
  assert.ok(res.series[0].openedAt >= res.series[res.series.length - 1].openedAt, 'series 应按时间倒序');
});

test('§3.4 grouped 分配经 getResearchGroups + 活动座位 map', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('s1', '张三', 'student'), ('s2', '李四', 'student'),
      ('s3', '王五', 'student'), ('s4', '赵六', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES
      ('c-1', 's1'), ('c-1', 's2'), ('c-1', 's3'), ('c-1', 's4');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 2, 2);
    -- 研究活动：组 g1={s1,s2}, g2={s3,s4}
    CREATE TABLE IF NOT EXISTS plugin_research_groups (
      id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, member_ids TEXT NOT NULL
    );
    INSERT INTO plugin_research_groups (id, activity_id, member_ids) VALUES
      ('g1', 'act-1', '["s1","s2"]'),
      ('g2', 'act-1', '["s3","s4"]');
  `);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const assign = mock.commandHandlers.get('lab_seat.assign_seats');
  const res = await assign.execute({
    type: 'lab_seat.assign_seats', actorId: 't-1',
    payload: { lessonId: 'l-1', labId: 'lab-A', strategy: 'grouped', activityId: 'act-1' },
  });
  assert.ok(res.message.includes('4'), '应分配全部 4 名学生');

  // group_id 已写入
  const gRows = db.prepare(`SELECT student_id, group_id FROM plugin_lab_seat_seat_assignments WHERE lesson_id = 'l-1'`).all();
  const gmap = {};
  gRows.forEach((r) => { gmap[r.student_id] = r.group_id; });
  assert.equal(gmap['s1'], 'g1');
  assert.equal(gmap['s3'], 'g2');

  // ILabSeatService.getActivitySeatMap 返回学生 → 座位
  const provided = [...mock.providedServices.values()].find(v => v && typeof v.getActivitySeatMap === 'function');
  assert.ok(provided, 'ILabSeatService 应被 provide');
  const seatMap = await provided.getActivitySeatMap('act-1');
  assert.equal(Object.keys(seatMap).length, 4, '活动内 4 名学生都有座位');
  assert.ok(seatMap['s1'].labId === 'lab-A');
  assert.equal(typeof seatMap['s1'].rowIdx, 'number');
});

test('§3.4 plugin_research_groups 表缺失时 grouped 分配不崩且成员落到末尾', async () => {
  createHostSchema(db);
  // 故意不建 plugin_research_groups 表
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('s1', '张三', 'student'), ('s2', '李四', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES ('c-1', 's1'), ('c-1', 's2');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 2, 2);
  `);
  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const assign = mock.commandHandlers.get('lab_seat.assign_seats');
  await assert.doesNotReject(() => assign.execute({
    type: 'lab_seat.assign_seats', actorId: 't-1',
    payload: { lessonId: 'l-1', labId: 'lab-A', strategy: 'grouped', activityId: 'act-x' },
  }), 'research_groups 表缺失时 grouped 分配不应崩溃');

  const cnt = db.prepare(`SELECT COUNT(*) as c FROM plugin_lab_seat_seat_assignments WHERE lesson_id = 'l-1'`).get();
  assert.equal(cnt.c, 2, '2 名学生仍应被分配');
});

test('exports 提供且可解析（带 & 等特殊字符的姓名）', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('s-comma', '张, 三', 'student'),
      ('s-quote', '李"四', 'student'),
      ('s-newline', '王\n五', 'student'),
      ('s-normal', '赵六', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES
      ('c-1', 's-comma'), ('c-1', 's-quote'), ('c-1', 's-newline'), ('c-1', 's-normal');
    INSERT INTO computer_labs (id, room_number, rows, cols, layout_json) VALUES
      ('lab-1', 'A101', 5, 8, '{"rows":5,"cols":8,"numbering":{"scheme":"alphanumeric","direction":"row-first"},"cells":[{"row":0,"col":0,"label":"A1","type":"desktop","ip":"","note":""},{"row":0,"col":1,"label":"A2","type":"desktop","ip":"","note":""},{"row":0,"col":2,"label":"A3","type":"desktop","ip":"","note":""},{"row":0,"col":3,"label":"A4","type":"desktop","ip":"","note":""}]}');
  `);

  ctx = createMockContext(db);
  mock = ctx.__test__;
  await plugin.activate(ctx);

  // 分配座位
  await mock.commandHandlers.get('lab_seat.assign_seats').execute({
    type: 'lab_seat.assign_seats', actorId: 't-1',
    payload: { lessonId: 'l-1', labId: 'lab-1', strategy: 'sequential' },
  });

  // 导出 CSV
  const exportHandler = mock.commandHandlers.get('lab_seat.export_attendance');
  const result = await exportHandler.execute({
    type: 'lab_seat.export_attendance', actorId: 't-1',
    payload: { lessonId: 'l-1' },
  });

  assert.ok(result.csv, '应返回 csv 字符串');
  assert.equal(result.csv.charCodeAt(0), 0xFEFF, '应以 UTF-8 BOM 开头');
  // 含逗号的姓名应被引号包裹
  assert.match(result.csv, /"张, 三"/, '含逗号字段应被引号包裹');
  // 含双引号的姓名应正确转义
  assert.match(result.csv, /"李""四"/, '含双引号字段应正确转义');
  // 含换行符的姓名应被引号包裹
  assert.match(result.csv, /"王\n五"/, '含换行字段应被引号包裹');
});
test('§4.2 smart_assign_seats：AI 约束落座', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('s1', '张小明', 'student'), ('s2', '李雷', 'student'),
      ('s3', '韩梅梅', 'student'), ('s4', '王芳', 'student'), ('s5', '赵六', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES
      ('c-1', 's1'), ('c-1', 's2'), ('c-1', 's3'), ('c-1', 's4'), ('c-1', 's5');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 2, 4);
  `);
  // mock AI 返回：张小明靠前、李雷靠后
  ctx = createMockContext(db, {
    aiOutput: '{"preferFront":["张小明"],"avoidFront":["李雷"],"spread":false,"strategy":null}',
  });
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const smart = mock.commandHandlers.get('lab_seat.smart_assign_seats');
  const res = await smart.execute({
    type: 'lab_seat.smart_assign_seats', actorId: 't-1',
    payload: { lessonId: 'l-1', labId: 'lab-A', instruction: '张小明近视坐前面，李雷别坐第一排' },
  });
  assert.ok(res.message.includes('5'), '5 名学生应被分配');

  // 张小明应坐 (0,0)（第一个座位），李雷应在靠后位置
  const seatOf = (sid) => db.prepare(
    `SELECT row_idx, col_idx FROM plugin_lab_seat_seat_assignments WHERE lesson_id = 'l-1' AND student_id = ?`).get(sid);
  const zhang = seatOf('s1');
  const lilei = seatOf('s2');
  assert.deepEqual({ r: zhang.row_idx, c: zhang.col_idx }, { r: 0, c: 0 }, 'preferFront 学生坐第一座');
  assert.ok(lilei.row_idx >= 1, 'avoidFront 学生应在后排');
});

test('§4.2 smart_assign_seats：AI 服务不可用时报明确错误', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES ('s1', '张小明', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES ('c-1', 's1');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 1, 1);
  `);
  ctx = createMockContext(db); // 无 aiOutput → ai 不可用
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const smart = mock.commandHandlers.get('lab_seat.smart_assign_seats');
  await assert.rejects(
    () => smart.execute({
      type: 'lab_seat.smart_assign_seats', actorId: 't-1',
      payload: { lessonId: 'l-1', labId: 'lab-A', instruction: '随便排' },
    }),
    /AI 服务不可用/,
  );
});

test('§4.2 smart_assign_seats：非法 AI 输出回退空约束仍能分配', async () => {
  createHostSchema(db);
  db.exec(`
    INSERT INTO users (id, name, role) VALUES ('s1', '张小明', 'student'), ('s2', '李雷', 'student');
    INSERT INTO lessons (id, name, status) VALUES ('l-1', 'Test', 'live');
    INSERT INTO classes (id) VALUES ('c-1');
    INSERT INTO class_students (class_id, student_id) VALUES ('c-1', 's1'), ('c-1', 's2');
    INSERT INTO computer_labs (id, room_number, rows, cols) VALUES ('lab-A', 'A101', 1, 2);
  `);
  ctx = createMockContext(db, { aiOutput: '这根本不是JSON，随便说说' });
  mock = ctx.__test__;
  await plugin.activate(ctx);

  const smart = mock.commandHandlers.get('lab_seat.smart_assign_seats');
  const res = await smart.execute({
    type: 'lab_seat.smart_assign_seats', actorId: 't-1',
    payload: { lessonId: 'l-1', labId: 'lab-A', instruction: '随便排' },
  });
  assert.ok(res.message.includes('2'), '非法输出仍应分配全部学生');
});
