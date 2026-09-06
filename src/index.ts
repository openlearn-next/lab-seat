import type { PluginContext } from '@openlearn/plugin-sdk';
import {
  ICommandBusServiceToken,
  IActionRegistryServiceToken,
  IEventBusServiceToken,
  IDatabaseToken,
  IPointsLedgerServiceToken,
  IActivityRegistryToken,
  Token,
} from '@openlearn/plugin-sdk';
import { escapeCsvField, csvRow } from './csv.js';

// ── Types ──────────────────────────────────────────────
interface LabRoom {
  id: string;
  name: string;
  rows: number;
  cols: number;
  layout_json: string;
  created_at: number;
  updated_at: number;
}

interface SeatCell {
  row: number;
  col: number;
  label: string;
  type: 'desktop' | 'notebook' | 'none';
  ip: string;
  note: string;
}

interface LabLayout {
  rows: number;
  cols: number;
  numbering: { scheme: string; direction: string };
  cells: SeatCell[];
}

type CheckInStatus = 'checked_in' | 'late' | 'leave' | 'absent';
type SessionStatus = 'closed' | 'open' | 'ended';
type AssignStrategy = 'sequential' | 'random' | 'grouped';

// 跨插件服务 Token：供其他插件消费 ILabSeatService。
// 用 SDK 的 Token<T> 强类型，标识符使用插件全限定命名空间。
const ILabSeatServiceToken = new Token<ILabSeatService>('@aymwoo/plugin-lab-seat:ILabSeatService');

interface ILabSeatService {
  getStudentSeat(lessonId: string, studentId: string): Promise<unknown>;
  getAttendanceStatus(lessonId: string, studentId: string): Promise<unknown>;
  getLessonAttendanceSummary(lessonId: string): Promise<Record<string, number>>;
  /** §3.4 研究活动 → 座位分布 map：{ studentId: {labId,rowIdx,colIdx} } */
  getActivitySeatMap(activityId: string): Promise<Record<string, { labId: string; rowIdx: number; colIdx: number }>>;
}

// CSV 字段转义：RFC 4180。实现见 src/csv.ts；通过顶层 import 引入。
// 同时供 test/csv.test.mjs 独立验证。

// §3.2 后台自动扫描 timer（模块级，供 deactivate 清理）
let autoScanTimer: ReturnType<typeof setInterval> | null = null;

// ── Plugin ──────────────────────────────────────────────
export default {
  manifest: {
    id: '@aymwoo/plugin-lab-seat',
    name: '机房座位管理',
    version: '0.5.0',
    description: '统一机房座位管理 - 教师编排布局分配座位，学生查看座位并签到',
    author: 'aymwoo',
    main: 'index.js',
    engines: { openlearn: '>= 0.1.0' },
    requires: [
      '@openlearn/core:ICommandBusService@^1.0.0',
      '@openlearn/core:IActionRegistryService@^1.0.0',
      '@openlearn/core:IEventBusService@^1.0.0',
      '@openlearn/core:IDatabase@^1.0.0',
    ],
    optional: [
      '@openlearn/core:IPointsLedgerService@^1.0.0', // 积分服务可选，缺失则静默跳过
    ],
    provides: [
      '@aymwoo/plugin-lab-seat:ILabSeatService',
    ],
    capabilitiesProposed: [
      'lab_seat:read',
      'lab_seat:write',
      'lab_seat:check_in',
      'lab_seat:export',
      'lesson:read',
      'class:read',
      'student:read',
    ],
    updateSource: {
      type: 'github-release',
      repo: 'aymwoo/OpenLearn-Next-V2',
    },
    configuration: {
      properties: {
        points_per_check_in: {
          type: 'integer',
          default: 5,
          description: '每次签到发放的积分数',
          minimum: 0,
        },
        late_threshold_minutes: {
          type: 'integer',
          default: 10,
          description: '迟到判定阈值（分钟）',
          minimum: 0,
        },
        auto_mark_leave_after_minutes: {
          type: 'integer',
          default: 0,
          description: '签到开启后超过 N 分钟仍未签到的学生自动标记为请假；0 表示关闭',
          minimum: 0,
        },
        late_auto_promote_after_minutes: {
          type: 'integer',
          default: 0,
          description: '已标记迟到但超过 N 分钟仍未签到的自动升级为缺勤；0 表示关闭',
          minimum: 0,
        },
        auto_scan_interval_seconds: {
          type: 'integer',
          default: 60,
          description: '异常自动判定扫描间隔（秒）',
          minimum: 10,
          maximum: 3600,
        },
      },
    },
  },

  async activate(ctx: PluginContext) {
    const commandBus = ctx.services.commandBus;
    const actionRegistry = ctx.services.actionRegistry;
    const eventBus = ctx.services.eventBus;
    const pluginId = ctx.pluginId;

    // 解析 raw better-sqlite3 实例用于 JOIN 平台表
    const rawDb: any = await ctx.resolve(IDatabaseToken);

   // ── 1. 数据库迁移 ─────────────────────────────────
   // 机房数据复用平台 computer_labs 表。若表本身不存在则创建（fresh install），
   // 若存在则补缺失列（幂等 ALTER TABLE）。
   rawDb.exec(`
     CREATE TABLE IF NOT EXISTS computer_labs (
       id TEXT PRIMARY KEY,
       room_number TEXT NOT NULL,
       name TEXT DEFAULT '',
       rows INTEGER DEFAULT 5,
       cols INTEGER DEFAULT 8,
       layout_json TEXT DEFAULT '{}',
       created_at INTEGER DEFAULT 0,
       updated_at INTEGER DEFAULT 0
     );
   `);
   try { rawDb.prepare("ALTER TABLE computer_labs ADD COLUMN name TEXT DEFAULT ''").run(); } catch {}
   try { rawDb.prepare("ALTER TABLE computer_labs ADD COLUMN layout_json TEXT DEFAULT '{}'").run(); } catch {}
   try { rawDb.prepare('ALTER TABLE computer_labs ADD COLUMN updated_at INTEGER DEFAULT 0').run(); } catch {}
   // 存量数据：将 room_number 填充到 name（fresh install 时表刚创建，无数据，静默跳过）
   try { rawDb.prepare("UPDATE computer_labs SET name = room_number WHERE name IS NULL OR name = ''").run(); } catch {}

   await ctx.db.migrate(1, async (sqliteDb: any) => {
     // 座位分配
     sqliteDb.prepare(`
       CREATE TABLE IF NOT EXISTS ${ctx.db.table('seat_assignments')} (
         id TEXT PRIMARY KEY,
         lesson_id TEXT NOT NULL,
         student_id TEXT NOT NULL,
         lab_id TEXT NOT NULL,
         row_idx INTEGER NOT NULL,
         col_idx INTEGER NOT NULL,
         group_id TEXT DEFAULT '',
         assigned_strategy TEXT DEFAULT 'manual',
         assigned_at INTEGER NOT NULL,
         UNIQUE(lesson_id, student_id)
       )
     `).run();
     // 签到记录
     sqliteDb.prepare(`
       CREATE TABLE IF NOT EXISTS ${ctx.db.table('attendance_records')} (
         id TEXT PRIMARY KEY,
         lesson_id TEXT NOT NULL,
         student_id TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'absent',
         checked_in_at INTEGER,
         note TEXT DEFAULT '',
         UNIQUE(lesson_id, student_id)
       )
     `).run();
     // 签到会话
     sqliteDb.prepare(`
       CREATE TABLE IF NOT EXISTS ${ctx.db.table('check_in_sessions')} (
         id TEXT PRIMARY KEY,
         lesson_id TEXT NOT NULL,
         lab_id TEXT,
         status TEXT NOT NULL DEFAULT 'closed',
         opened_at INTEGER,
         closed_at INTEGER
       )
     `).run();
     // 课节模板
     sqliteDb.prepare(`
       CREATE TABLE IF NOT EXISTS ${ctx.db.table('seat_templates')} (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         lab_id TEXT NOT NULL,
         assignments_json TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )
     `).run();
     // 课节-机房关联表（v0.4.0 §3.1 多机房）：一个课节可关联多个机房，
     // 每个机房独立分配/查看/考勤。兼容旧数据（未登记的在 list_lesson_labs 时自动补全）。
     sqliteDb.prepare(`
       CREATE TABLE IF NOT EXISTS ${ctx.db.table('lesson_room_map')} (
         lesson_id TEXT NOT NULL,
         lab_id TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         PRIMARY KEY (lesson_id, lab_id)
       )
     `).run();
   });

    // ── 表名引用 ──────────────────────────────────────
    // Worker runtime 不提供 ctx.config，fallback 到 manifest 默认值
    const getConfigValue = (key: string): any => {
      const cfg = (ctx as any).config;
      if (cfg && typeof cfg[key] !== 'undefined') return cfg[key];
      return (ctx.manifest as any)?.configuration?.properties?.[key]?.default;
    };

    const T_ROOMS = 'computer_labs'; // 复用平台机房表
    const T_ASSIGN = ctx.db.table('seat_assignments');
    const T_ATTEND = ctx.db.table('attendance_records');
    const T_SESSIONS = ctx.db.table('check_in_sessions');
    const T_TEMPLATES = ctx.db.table('seat_templates');
    const T_LESSON_ROOMS = ctx.db.table('lesson_room_map'); // §3.1 多机房

    // ── 辅助函数 ──────────────────────────────────────
    function uid(): string {
      return globalThis.crypto.randomUUID();
    }

    // 注：escapeCsvField / csvRow 已在模块顶层 export，供 test/csv.test.mjs 独立验证。

    // §3.4 读取研究活动分组。优先通过宿主注册的活动 provider 服务解析（IActivityRegistryToken），
    // 不可用/不含分组语义时回退直查活动插件的 plugin_research_groups 表（表不存在不崩溃，返回空）。
    // 返回: [{ id, member_ids: string[] }]  —— 兼容 assign_seats 的 grouped 消费。
    async function getResearchGroups(activityId: string): Promise<Array<{ id: string; member_ids: string[] }>> {
      const groups: Array<{ id: string; member_ids: string[] }> = [];
      // 1) 尝试活动生态 Token（若宿主与活动插件启用了 provider 注册）
      try {
        const registry = await ctx.resolve(IActivityRegistryToken as any);
        if (registry && typeof registry.listDescriptors === 'function') {
          // 探测 research/collaboration provider；不抛出即视为可用标记（见下方 catch 兜底）
        }
      } catch { /* registry 不存在 → 走 SQL fallback */ }

      // 2) SQL 直查（跨插件表：研究活动插件建表）——容错处理表可能不存在
      try {
        const rows = rawDb.prepare(`SELECT * FROM plugin_research_groups WHERE activity_id = ?`).all(activityId) as any[];
        for (const r of rows) {
          let memberIds: string[] = [];
          try { memberIds = JSON.parse(r.member_ids || '[]'); } catch { memberIds = []; }
          groups.push({ id: r.id, member_ids: memberIds });
        }
      } catch { /* 表不存在或权限不足 → 无分组数据 */ }
      return groups;
    }

    // 学生到分组 map：id → groupId（供 grouped 分配快速索引）
    async function buildStudentGroupMap(
      students: Array<{ id: string }>,
      activityId: string,
    ): Promise<Map<string, string>> {
      const map = new Map<string, string>();
      const groups = await getResearchGroups(activityId);
      for (const g of groups) {
        for (const mid of g.member_ids) {
          if (students.some((s: any) => s.id === mid)) map.set(mid, g.id);
        }
      }
      return map;
    }


    function getStudentsByLesson(lessonId: string): { id: string; name: string; student_id?: string }[] {
      const rows = rawDb.prepare(`
        SELECT u.id, u.name
        FROM lessons l
        JOIN classes c ON c.id IN (
          SELECT value FROM json_each(
            (SELECT value FROM json_each(l.timeline) WHERE key='class_ids')
          )
        )
        JOIN class_students cs ON cs.class_id = c.id
        JOIN users u ON u.id = cs.student_id
        WHERE l.id = ?
      `).all(lessonId);
      // fallback: lessions 无 timeline 则尝试通过 classes.lab_id 关联
      if (!rows || rows.length === 0) {
        return rawDb.prepare(`
          SELECT u.id, u.name
          FROM lessons l
          JOIN classes c ON 1=1
          JOIN class_students cs ON cs.class_id = c.id
          JOIN users u ON u.id = cs.student_id
          WHERE l.id = ? AND u.role = 'student'
          GROUP BY u.id
        `).all(lessonId);
      }
      return rows;
    }

    function getLabLayout(labId: string): LabLayout | null {
      const row = rawDb.prepare(`SELECT rows, cols, layout_json FROM ${T_ROOMS} WHERE id = ?`).get(labId) as any;
      if (!row) return null;
      // layout_json 存在则解析；否则从 rows/cols 自动生成基本网格
      if (row.layout_json && row.layout_json !== '{}') {
        try { return JSON.parse(row.layout_json); } catch {}
      }
      const cells: SeatCell[] = [];
      for (let r = 0; r < row.rows; r++) {
        for (let c = 0; c < row.cols; c++) {
          const label = `${String.fromCharCode(65 + r)}${c + 1}`;
          cells.push({ row: r, col: c, label, type: 'desktop', ip: '', note: '' });
        }
      }
      return { rows: row.rows, cols: row.cols, numbering: { scheme: 'alphanumeric', direction: 'row-first' }, cells };
    }

    function getStudentSeatForLesson(lessonId: string, studentId: string) {
      return rawDb.prepare(
        `SELECT sa.*, COALESCE(cr.name, cr.room_number) as lab_name, cr.rows, cr.cols
         FROM ${T_ASSIGN} sa
         JOIN ${T_ROOMS} cr ON cr.id = sa.lab_id
         WHERE sa.lesson_id = ? AND sa.student_id = ?`
      ).get(lessonId, studentId);
    }


    // ── 3. 机房 CRUD ──────────────────────────────────

    // 创建机房
    await actionRegistry.register({
      id: 'lab_seat-create-room',
      commandType: 'lab_seat.create_room',
      description: '创建新的机房布局，设置名称、行列数，生成网格座位',
      capabilityRequired: 'lab_seat:write',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          room_number: { type: 'STRING', description: '机房编号，如 410' },
          name: { type: 'STRING', description: '机房名称，如 A101' },
          rows: { type: 'NUMBER', description: '行数' },
          cols: { type: 'NUMBER', description: '列数' },
          numberingScheme: { type: 'STRING', description: '编号规则：alphanumeric 或 numeric' },
        },
        required: ['room_number', 'rows', 'cols'],
      },
    });

    await commandBus.registerHandler('lab_seat.create_room', {
      async execute(command) {
        const p = command.payload as any;
        const id = uid();
        const scheme = p.numberingScheme || 'alphanumeric';
        const cells: SeatCell[] = [];
        for (let r = 0; r < p.rows; r++) {
          for (let c = 0; c < p.cols; c++) {
            const label = scheme === 'alphanumeric'
              ? `${String.fromCharCode(65 + r)}${c + 1}`
              : `${r + 1}-${c + 1}`;
            cells.push({ row: r, col: c, label, type: 'desktop', ip: '', note: '' });
          }
        }
        const layout: LabLayout = { rows: p.rows, cols: p.cols, numbering: { scheme, direction: 'row-first' }, cells };
        const now = Date.now();
        rawDb.prepare(`INSERT INTO ${T_ROOMS} (id, room_number, name, rows, cols, layout_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, p.room_number, p.name || p.room_number, p.rows, p.cols, JSON.stringify(layout), now, now);

        await eventBus.publish({
          id: uid(), type: 'lab_seat.room_created', source: `plugin.${pluginId}`,
          payload: { roomId: id, name: p.name }, timestamp: now, correlationId: command.id,
        });
        return { roomId: id, name: p.name };
      },
    });

    // 更新机房布局
    await commandBus.registerHandler('lab_seat.update_layout', {
      async execute(command) {
        const p = command.payload as any;
        const now = Date.now();
        rawDb.prepare(`UPDATE ${T_ROOMS} SET layout_json = ?, name = COALESCE(?, name), updated_at = ?
          WHERE id = ?`).run(JSON.stringify(p.layout), p.name || null, now, p.roomId);
        return { roomId: p.roomId, updated: true };
      },
    });

    // 查询所有机房
    await commandBus.registerHandler('lab_seat.list_rooms', {
      async execute() {
        // 兜底：name 缺失或为空时回退到 room_number，使前端用 display_name 永远拿到非空
        return rawDb.prepare(`
          SELECT id, room_number, name, rows, cols, layout_json, created_at, updated_at,
                 COALESCE(NULLIF(name, ''), room_number) AS display_name
          FROM ${T_ROOMS}
          ORDER BY created_at DESC
        `).all();
      },
    });

    // 查询单个机房详情
    await commandBus.registerHandler('lab_seat.get_room', {
      async execute(command) {
        const p = command.payload as any;
        return rawDb.prepare(`SELECT * FROM ${T_ROOMS} WHERE id = ?`).get(p.roomId);
      },
    });

    // ── 4. 座位分配 ───────────────────────────────────

    await actionRegistry.register({
      id: 'lab_seat-auto-assign',
      commandType: 'lab_seat.assign_seats',
      description: '为学生分配座位。可指定多个机房，按容量顺序填充。按学号顺序、随机打散或按小组聚集。如"把这节课的学生随机分配到 A101 和 A102 机房"',
      capabilityRequired: 'lab_seat:write',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          lessonId: { type: 'STRING', description: '课节 ID' },
          labIds: { type: 'ARRAY', description: '机房 ID 列表（多机房，按容量顺序填充；与 labId 二选一）' },
          labId: { type: 'STRING', description: '单个机房 ID（与 labIds 二选一，向后兼容）' },
          strategy: { type: 'STRING', description: '分配策略：sequential/random/grouped' },
          activityId: { type: 'STRING', description: '分组策略时的研究活动 ID' },
          templateId: { type: 'STRING', description: '应用模板 ID（覆盖自动策略，仅限单机房模板）' },
        },
        required: ['lessonId'],
      },
    });

    await commandBus.registerHandler('lab_seat.assign_seats', {
      async execute(command) {
        const p = command.payload as any;
        const students = getStudentsByLesson(p.lessonId);
        if (!students || students.length === 0) {
          throw new Error('未找到该课节的学生');
        }

        // 模板只能应用在单个机房（模板绑定 lab_id）
        if (p.templateId) {
          const tmpl = rawDb.prepare(`SELECT * FROM ${T_TEMPLATES} WHERE id = ?`).get(p.templateId);
          if (!tmpl) throw new Error('模板不存在');
          const labId = tmpl.lab_id;
          if (!getLabLayout(labId)) throw new Error('模板机房不存在');
          const assignments = JSON.parse(tmpl.assignments_json);
          const delStmt = rawDb.prepare(`DELETE FROM ${T_ASSIGN} WHERE lesson_id = ? AND lab_id = ?`);
          const insStmt = rawDb.prepare(`INSERT OR REPLACE INTO ${T_ASSIGN}
            (id, lesson_id, student_id, lab_id, row_idx, col_idx, group_id, assigned_strategy, assigned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const now = Date.now();
          delStmt.run(p.lessonId, labId);
          for (const a of assignments) {
            insStmt.run(uid(), p.lessonId, a.student_id, labId, a.row_idx, a.col_idx, a.group_id || '', 'template', now);
          }
          upsertLessonRoom(p.lessonId, labId);
          const count = rawDb.prepare(`SELECT COUNT(*) as cnt FROM ${T_ASSIGN} WHERE lesson_id = ? AND lab_id = ?`)
            .get(p.lessonId, labId) as any;
          await eventBus.publish({
            id: uid(), type: 'lab_seat.seats_assigned', source: `plugin.${pluginId}`,
            payload: { lessonId: p.lessonId, labId, count: count.cnt },
            timestamp: Date.now(), correlationId: command.id,
          });
          return { message: `已为 ${count.cnt} 名学生分配座位` };
        }

        // 解析目标机房集合：优先 labIds[]（多机房批量），回退单 labId
        const labIds: string[] = Array.isArray(p.labIds) && p.labIds.length > 0
          ? p.labIds
          : (p.labId ? [p.labId] : []);
        if (labIds.length === 0) throw new Error('未指定机房');
        const layouts = labIds.map(id => {
          const layout = getLabLayout(id);
          if (!layout) throw new Error(`机房不存在: ${id}`);
          return layout;
        });
        const totalSeats = layouts.reduce((sum, l) => sum + l.cells.filter(c => c.type !== 'none').length, 0);
        if (students.length > totalSeats) {
          throw new Error(`可用座位不足：需要 ${students.length}，仅 ${totalSeats} 个（可添加更多机房）`);
        }

        // 策略排序（仅对多机房有意义；单机房保持原行为）
        const strategy: AssignStrategy = p.strategy || 'random';
        let ordered: typeof students = [...students];
        if (strategy === 'random') {
          for (let i = ordered.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
          }
        } else if (strategy === 'grouped' && p.activityId) {
          // §3.4 走统一 helper：先试活动生态，回退 SQL；表缺失不崩
          const groupMap = await buildStudentGroupMap(ordered, p.activityId);
          const grouped: typeof students = [];
          // 按活动分组顺序聚集
          const activityGroupIds = (await getResearchGroups(p.activityId)).map(g => g.id);
          for (const gid of activityGroupIds) {
            for (const s of ordered) {
              if (groupMap.get(s.id) === gid && !grouped.includes(s)) {
                (s as any).group_id = gid;
                grouped.push(s);
              }
            }
          }
          // 未分组的学生（可能该学生不在任何活动组）追加到末尾
          for (const s of ordered) if (!grouped.includes(s)) grouped.push(s);
          ordered = grouped;
        }
        // sequential 保持原序

        // 多机房：清除这些机房旧的分配（避免 UNIQUE(lesson_id,student_id) 冲突），再顺序填充
        const now = Date.now();
        const delStmt = rawDb.prepare(`DELETE FROM ${T_ASSIGN} WHERE lesson_id = ? AND lab_id = ?`);
        const insStmt = rawDb.prepare(`INSERT OR REPLACE INTO ${T_ASSIGN}
          (id, lesson_id, student_id, lab_id, row_idx, col_idx, group_id, assigned_strategy, assigned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const lid of labIds) delStmt.run(p.lessonId, lid);

        let cursor = 0;
        for (let li = 0; li < labIds.length && cursor < ordered.length; li++) {
          const lid = labIds[li];
          const seats = layouts[li].cells.filter(c => c.type !== 'none');
          for (const seat of seats) {
            if (cursor >= ordered.length) break;
            const s: any = ordered[cursor++];
            insStmt.run(uid(), p.lessonId, s.id, lid, seat.row, seat.col, s.group_id || '', strategy, now);
          }
        }
        // 预登记全部目标机房到 lesson_room_map（即使未实际落座，也让教师可在列表中切换查看）
        for (const lid of labIds) upsertLessonRoom(p.lessonId, lid);

        const count = rawDb.prepare(
          `SELECT COUNT(*) as cnt FROM ${T_ASSIGN} WHERE lesson_id = ? AND lab_id IN (${labIds.map(() => '?').join(',')})`
        ).get(p.lessonId, ...labIds) as any;

        await eventBus.publish({
          id: uid(), type: 'lab_seat.seats_assigned', source: `plugin.${pluginId}`,
          payload: { lessonId: p.lessonId, labId: labIds.length === 1 ? labIds[0] : null, labIds, count: count.cnt },
          timestamp: Date.now(), correlationId: command.id,
        });
        return { message: `已为 ${count.cnt} 名学生分配座位（${labIds.length} 个机房）` };
      },
    });

    // §3.1 辅助：登记课节-机房关联（幂等 upsert）
    function upsertLessonRoom(lessonId: string, labId: string): void {
      rawDb.prepare(
        `INSERT OR IGNORE INTO ${T_LESSON_ROOMS} (lesson_id, lab_id, created_at) VALUES (?, ?, ?)`
      ).run(lessonId, labId, Date.now());
    }

    // §3.1 查询课节已关联 / 已分配机房列表（含已分配人数）
    await commandBus.registerHandler('lab_seat.list_lesson_labs', {
      async execute(command) {
        const p = command.payload as any;
        // 从 map + assignments 两处合并，兼容旧数据（只有 assignment 没有 map 行）
        const rows = rawDb.prepare(`
          SELECT cl.id, cl.room_number, cl.name, cl.rows, cl.cols, cl.layout_json,
            COALESCE(NULLIF(cl.name, ''), cl.room_number) AS display_name,
            (SELECT COUNT(*) FROM ${T_ASSIGN} sa WHERE sa.lesson_id = ? AND sa.lab_id = cl.id) AS assigned_count
          FROM ${T_ROOMS} cl
          WHERE cl.id IN (
            SELECT lab_id FROM ${T_LESSON_ROOMS} WHERE lesson_id = ?
            UNION
            SELECT lab_id FROM ${T_ASSIGN} WHERE lesson_id = ?
          )
          ORDER BY assigned_count DESC
        `).all(p.lessonId, p.lessonId, p.lessonId);
        return rows;
      },
    });

    // §3.1 手动把一个机房关联到课节
    await commandBus.registerHandler('lab_seat.add_lesson_lab', {
      async execute(command) {
        const p = command.payload as any;
        upsertLessonRoom(p.lessonId, p.labId);
        return { ok: true };
      },
    });

    // §3.1 解除课节-机房关联（同时清除该机房内该课节的分配）
    await commandBus.registerHandler('lab_seat.remove_lesson_lab', {
      async execute(command) {
        const p = command.payload as any;
        rawDb.prepare(`DELETE FROM ${T_LESSON_ROOMS} WHERE lesson_id = ? AND lab_id = ?`).run(p.lessonId, p.labId);
        rawDb.prepare(`DELETE FROM ${T_ASSIGN} WHERE lesson_id = ? AND lab_id = ?`).run(p.lessonId, p.labId);
        return { ok: true };
      },
    });

    // 手动调整单个学生座位
    await commandBus.registerHandler('lab_seat.move_student', {
      async execute(command) {
        const p = command.payload as any;
        rawDb.prepare(`UPDATE ${T_ASSIGN} SET row_idx = ?, col_idx = ?, assigned_strategy = 'manual'
          WHERE lesson_id = ? AND student_id = ?`)
          .run(p.rowIdx, p.colIdx, p.lessonId, p.studentId);
        return { updated: true };
      },
    });

    // §2.5 移除单个学生的座位分配（回到未分配）
    await commandBus.registerHandler('lab_seat.unassign_student', {
      async execute(command) {
        const p = command.payload as any;
        const res = rawDb.prepare(`DELETE FROM ${T_ASSIGN} WHERE lesson_id = ? AND student_id = ?`)
          .run(p.lessonId, p.studentId);
        return { removed: res.changes > 0 };
      },
    });

    // 查询某课节的座位分配
    await commandBus.registerHandler('lab_seat.get_assignments', {
      async execute(command) {
        const p = command.payload as any;
        // labId 可选：多机房课节按机房过滤，单机房课节传空则返回全部
        const labFilter = p.labId ? `AND sa.lab_id = ?` : '';
        const params = p.labId ? [p.lessonId, p.labId] : [p.lessonId];
        return rawDb.prepare(`
          SELECT sa.*, u.name as student_name
          FROM ${T_ASSIGN} sa
          JOIN users u ON u.id = sa.student_id
          WHERE sa.lesson_id = ? ${labFilter}
          ORDER BY sa.lab_id, sa.row_idx, sa.col_idx
        `).all(...params);
      },
    });

    // ── 5. 签到 ───────────────────────────────────────

    // 教师开启签到
    await commandBus.registerHandler('lab_seat.open_check_in', {
      async execute(command) {
        const p = command.payload as any;
        const id = uid();
        const now = Date.now();
        // 关闭已有 session
        rawDb.prepare(`UPDATE ${T_SESSIONS} SET status = 'ended', closed_at = ? WHERE lesson_id = ? AND status = 'open'`)
          .run(now, p.lessonId);
        // 创建新 session
        rawDb.prepare(`INSERT INTO ${T_SESSIONS} (id, lesson_id, lab_id, status, opened_at)
          VALUES (?, ?, ?, 'open', ?)`).run(id, p.lessonId, p.labId || null, now);

        await eventBus.publish({
          id: uid(), type: 'lab_seat.check_in_opened', source: `plugin.${pluginId}`,
          payload: { lessonId: p.lessonId, labId: p.labId, sessionId: id },
          timestamp: now, correlationId: command.id,
        });
        return { sessionId: id };
      },
    });

    // 教师截止签到
    await commandBus.registerHandler('lab_seat.close_check_in', {
      async execute(command) {
        const p = command.payload as any;
        const now = Date.now();
        rawDb.prepare(`UPDATE ${T_SESSIONS} SET status = 'ended', closed_at = ? WHERE lesson_id = ? AND status = 'open'`)
          .run(now, p.lessonId);

        await eventBus.publish({
          id: uid(), type: 'lab_seat.attendance_closed', source: `plugin.${pluginId}`,
          payload: { lessonId: p.lessonId }, timestamp: now, correlationId: command.id,
        });
        return { closed: true };
      },
    });

    // 学生签到
    await actionRegistry.register({
      id: 'lab_seat-check-in',
      commandType: 'lab_seat.check_in',
      description: '学生在机房确认到达完成签到，记录签到时间',
      capabilityRequired: 'lab_seat:check_in',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          lessonId: { type: 'STRING', description: '课节 ID' },
        },
        required: ['lessonId'],
      },
    });

    await commandBus.registerHandler('lab_seat.check_in', {
      async execute(command) {
        const p = command.payload as any;
        const studentId = command.actorId;
        const lessonId = p.lessonId;
        const now = Date.now();

        // 检查签到会话是否开放
        const session = rawDb.prepare(
          `SELECT * FROM ${T_SESSIONS} WHERE lesson_id = ? AND status = 'open'`
        ).get(lessonId);
        if (!session) throw new Error('签到尚未开启');

        // 幂等检查
        const existing = rawDb.prepare(
          `SELECT * FROM ${T_ATTEND} WHERE lesson_id = ? AND student_id = ?`
        ).get(lessonId, studentId);
        if (existing) {
          return { message: '已签到', status: (existing as any).status, checkedInAt: (existing as any).checked_in_at };
        }

        // 判断是否迟到
        const lateThresholdMs = (getConfigValue('late_threshold_minutes') ?? 10) * 60 * 1000;
        const openedAt = (session as any).opened_at;
        const status: CheckInStatus = (openedAt && (now - openedAt) > lateThresholdMs) ? 'late' : 'checked_in';

        rawDb.prepare(`INSERT OR REPLACE INTO ${T_ATTEND}
          (id, lesson_id, student_id, status, checked_in_at, note)
          VALUES (?, ?, ?, ?, ?, '')`)
          .run(uid(), lessonId, studentId, status, now);

        await eventBus.publish({
          id: uid(), type: 'lab_seat.student_checked_in', source: `plugin.${pluginId}`,
          payload: { lessonId, studentId, status, checkedInAt: now },
          timestamp: now, correlationId: command.id,
        });
        return { status, checkedInAt: now };
      },
    });

    // 教师手动补签/标记请假
    await commandBus.registerHandler('lab_seat.manual_check_in', {
      async execute(command) {
        const p = command.payload as any;
        const now = Date.now();
        rawDb.prepare(`INSERT OR REPLACE INTO ${T_ATTEND}
          (id, lesson_id, student_id, status, checked_in_at, note)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(uid(), p.lessonId, p.studentId, p.status || 'checked_in', p.status === 'leave' ? null : now, p.note || '');
        return { updated: true };
      },
    });

    // 查询活跃签到会话
    await commandBus.registerHandler('lab_seat.get_active_check_in', {
      async execute(command) {
        const p = command.payload as any;
        if (p.lessonId) {
          return rawDb.prepare(`SELECT * FROM ${T_SESSIONS} WHERE lesson_id = ? AND status = 'open'`).get(p.lessonId);
        }
        // 查学生当前活跃签到
        const studentId = p.studentId || command.actorId;
        const rows = rawDb.prepare(`
          SELECT s.* FROM ${T_SESSIONS} s
          JOIN ${T_ASSIGN} sa ON sa.lesson_id = s.lesson_id
          WHERE sa.student_id = ? AND s.status = 'open'
        `).all(studentId);
        return rows.length > 0 ? rows[0] : null;
      },
    });

    // ── 6. 考勤查询 ───────────────────────────────────

    await actionRegistry.register({
      id: 'lab_seat-get-attendance',
      commandType: 'lab_seat.get_attendance',
      description: '查询课节考勤状态。如"这节课来了多少人？谁没到？"',
      capabilityRequired: 'lab_seat:read',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          lessonId: { type: 'STRING', description: '课节 ID' },
        },
        required: ['lessonId'],
      },
    });

    await commandBus.registerHandler('lab_seat.get_attendance', {
      async execute(command) {
        const p = command.payload as any;
        const labFilter = p.labId ? `AND sa.lab_id = ?` : '';
        const params = p.labId ? [p.lessonId, p.labId] : [p.lessonId];
        const records = rawDb.prepare(`
          SELECT a.*, u.name as student_name, sa.row_idx, sa.col_idx, sa.lab_id
          FROM ${T_ASSIGN} sa
          LEFT JOIN ${T_ATTEND} a ON a.lesson_id = sa.lesson_id AND a.student_id = sa.student_id
          JOIN users u ON u.id = sa.student_id
          WHERE sa.lesson_id = ? ${labFilter}
          ORDER BY sa.lab_id, sa.row_idx, sa.col_idx
        `).all(...params);

        const summary = { checked_in: 0, late: 0, leave: 0, absent: 0, total: (records as any[]).length };
        for (const r of records as any[]) {
          const s = r.status || 'absent';
          if (s === 'checked_in') summary.checked_in++;
          else if (s === 'late') summary.late++;
          else if (s === 'leave') summary.leave++;
          else summary.absent++;
        }
        return { records, summary };
      },
    });

    // 学生查自己座位
    await commandBus.registerHandler('lab_seat.get_my_seat', {
      async execute(command) {
        const p = command.payload as any;
        const studentId = p.studentId || command.actorId;
        const seat = getStudentSeatForLesson(p.lessonId, studentId);
        // 同时查签到记录
        const attendance = rawDb.prepare(
          `SELECT * FROM ${T_ATTEND} WHERE lesson_id = ? AND student_id = ?`
        ).get(p.lessonId, studentId);
        return { seat, attendance };
      },
    });

    // 动态探测 lessons 表字段：不同 host 版本可能有 name/title、status、started_at 等。
    // 只 SELECT 实际存在的列，避免 host schema 演进后插件崩溃。
    function getLessonColumnNames(): string[] {
      try {
        const cols = rawDb.prepare(`PRAGMA table_info(lessons)`).all() as Array<{ name: string }>;
        return cols.map(c => c.name);
      } catch {
        return [];
      }
    }

    // 查询教师当前活跃 / 最近的 lessons，供前端选择器使用。
    // 优先级：status IN ('live','active') > 最近 started_at > 最近 created_at
    function listLessons(limit: number): any[] {
      const cols = getLessonColumnNames();
      if (cols.length === 0 || !cols.includes('id')) return [];
      const wanted = ['id', 'name', 'title', 'status', 'started_at', 'ended_at', 'created_at', 'updated_at', 'teacher_id']
        .filter(c => cols.includes(c));
      const selectClause = wanted.join(', ');
      const orderClauses: string[] = [];
      if (cols.includes('status')) orderClauses.push(`CASE WHEN status IN ('live','active') THEN 0 ELSE 1 END`);
      if (cols.includes('started_at')) orderClauses.push(`started_at DESC`);
      if (cols.includes('created_at')) orderClauses.push(`created_at DESC`);
      const orderBy = orderClauses.length > 0 ? `ORDER BY ${orderClauses.join(', ')}` : '';
      try {
        return rawDb.prepare(`SELECT ${selectClause} FROM lessons ${orderBy} LIMIT ?`).all(limit);
      } catch {
        return [];
      }
    }

    // ── 6.5 课节元数据查询 ─────────────────────────────────

    await actionRegistry.register({
      id: 'lab_seat-list-lessons',
      commandType: 'lab_seat.list_lessons',
      description: '列出教师当前活跃或最近的课节，供座位分配 / 考勤看板 选择课节 ID 使用',
      capabilityRequired: 'lesson:read',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          limit: { type: 'NUMBER', description: '返回数量上限，默认 50' },
        },
      },
    });

    await commandBus.registerHandler('lab_seat.list_lessons', {
      async execute(command) {
        const p = command.payload as any;
        const limit = Math.min(Math.max(p.limit || 50, 1), 200);
        return listLessons(limit);
      },
    });

    // ── 7. 导出 ───────────────────────────────────────

    await actionRegistry.register({
      id: 'lab_seat-export-report',
      commandType: 'lab_seat.export_attendance',
      description: '导出课节签到表为 CSV',
      capabilityRequired: 'lab_seat:export',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          lessonId: { type: 'STRING', description: '课节 ID' },
          dateRange: { type: 'STRING', description: '多课节日志范围（可选）' },
        },
        required: ['lessonId'],
      },
    });

    await commandBus.registerHandler('lab_seat.export_attendance', {
      async execute(command) {
        const p = command.payload as any;
        const labFilter = p.labId ? `AND sa.lab_id = ?` : '';
        const params = p.labId ? [p.lessonId, p.labId] : [p.lessonId];
        const records = rawDb.prepare(`
          SELECT sa.lab_id, sa.row_idx, sa.col_idx, u.name as student_name, u.id as student_id,
            COALESCE(a.status, 'absent') as status,
            a.checked_in_at, a.note
          FROM ${T_ASSIGN} sa
          JOIN users u ON u.id = sa.student_id
          LEFT JOIN ${T_ATTEND} a ON a.lesson_id = sa.lesson_id AND a.student_id = sa.student_id
          WHERE sa.lesson_id = ? ${labFilter}
          ORDER BY sa.lab_id, sa.row_idx, sa.col_idx
        `).all(...params);

        // 表头同样过 escapeCsvField（当前都是英文+中文，不含特殊字符，但保持代码一致性）
        let csv = '\uFEFF' + csvRow(['机房', '座位编号', '学生姓名', '学号', '签到状态', '签到时间', '备注']);
        const statusMap: Record<string, string> = { checked_in: '已签到', late: '迟到', leave: '请假', absent: '未签到' };
        for (const r of records as any[]) {
          const layout = getLabLayout(r.lab_id);
          const label = layout?.cells?.find((c: SeatCell) => c.row === r.row_idx && c.col === r.col_idx)?.label || `${r.row_idx}-${r.col_idx}`;
          const labName = rawDb.prepare(`SELECT COALESCE(NULLIF(name, ''), room_number) AS n FROM ${T_ROOMS} WHERE id = ?`).get(r.lab_id) as any;
          const time = r.checked_in_at ? new Date(r.checked_in_at).toISOString() : '';
          csv += csvRow([
            labName?.n || r.lab_id,
            label,
            r.student_name,
            r.student_id,
            statusMap[r.status] || r.status,
            time,
            r.note || '',
          ]);
        }
        const labSuffix = p.labId ? `_${p.labId}` : '';
        return { csv, filename: `attendance_${p.lessonId}${labSuffix}.csv` };
      },
    });

    // ── 7.5 历史趋势聚合（§3.3） ──
    // 按课节聚合考勤统计，返回时间序列供前端趋势图。
    // 每课节取 check_in_sessions.opened_at 作为时间锚点，total = 该课节被分配的学生数。
    await commandBus.registerHandler('lab_seat.attendance_trend', {
      async execute(command) {
        const p = command.payload as any;
        const sinceDays = Math.min(Math.max(Number(p.sinceDays) || 30, 1), 365);
        const sinceTs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
        const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);

        // 有 session 的课节（精确时间锚点）
        const rows = rawDb.prepare(`
          SELECT
            s.lesson_id,
            s.lab_id,
            MIN(s.opened_at) AS opened_at,
            COUNT(DISTINCT sa.student_id) AS total
          FROM ${T_SESSIONS} s
          JOIN ${T_ASSIGN} sa ON sa.lesson_id = s.lesson_id
          WHERE s.opened_at >= ?
          GROUP BY s.lesson_id, s.lab_id
          ORDER BY opened_at DESC
          LIMIT ?
        `).all(sinceTs, limit);

        // 逐课节查询考勤统计
        const series: any[] = [];
        for (const row of rows as any[]) {
          const records = rawDb.prepare(
            `SELECT status, COUNT(*) as c FROM ${T_ATTEND} WHERE lesson_id = ? GROUP BY status`
          ).all(row.lesson_id) as any[];
          const summary: Record<string, number> = { checked_in: 0, late: 0, leave: 0, absent: 0 };
          for (const r of records) summary[r.status] = r.c;
          const total = (row as any).total || 0;
          const present = summary.checked_in + summary.late;
          series.push({
            lessonId: row.lesson_id,
            labId: row.lab_id,
            openedAt: row.opened_at,
            total,
            checked_in: summary.checked_in,
            late: summary.late,
            leave: summary.leave,
            absent: total - present,
            present,
            attendanceRate: total > 0 ? Math.round((present / total) * 100) : 0,
          });
        }
        return { series };
      },
    });

    // ── 8. AI Action: shuffle_seats ─────────────────────

    await actionRegistry.register({
      id: 'lab_seat-shuffle-seats',
      commandType: 'lab_seat.shuffle_seats',
      description: '把已分配的座位重新随机打乱一次',
      capabilityRequired: 'lab_seat:write',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          lessonId: { type: 'STRING', description: '课节 ID' },
        },
        required: ['lessonId'],
      },
    });

    await commandBus.registerHandler('lab_seat.shuffle_seats', {
      async execute(command) {
        const p = command.payload as any;
        // 获取当前课节的机房
        const assign = rawDb.prepare(
          `SELECT lab_id FROM ${T_ASSIGN} WHERE lesson_id = ? LIMIT 1`
        ).get(p.lessonId);
        if (!assign) throw new Error('该课节未分配座位');
        // 重走随机分配
        // 使用 manifest.id 前缀确保 Worker 环境下类型匹配
        return commandBus.execute({
          type: `${ctx.manifest.id}.lab_seat.assign_seats`,
          payload: { lessonId: p.lessonId, labId: (assign as any).lab_id, strategy: 'random' },
          actorId: command.actorId,
        } as any);
      },
    });

    // ── 9. 课节模板 ───────────────────────────────────

    await commandBus.registerHandler('lab_seat.save_template', {
      async execute(command) {
        const p = command.payload as any;
        const assignments = rawDb.prepare(
          `SELECT student_id, row_idx, col_idx, group_id FROM ${T_ASSIGN} WHERE lesson_id = ? AND lab_id = ?`
        ).all(p.lessonId, p.labId);
        const id = uid();
        rawDb.prepare(`INSERT INTO ${T_TEMPLATES} (id, name, lab_id, assignments_json, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(id, p.name, p.labId, JSON.stringify(assignments), Date.now());
        return { templateId: id };
      },
    });

    await commandBus.registerHandler('lab_seat.list_templates', {
      async execute(command) {
        const p = command.payload as any;
        return rawDb.prepare(`SELECT * FROM ${T_TEMPLATES} WHERE lab_id = ? ORDER BY created_at DESC`).all(p.labId);
      },
    });

    // ── 10. 当前活跃课节考勤汇总（供 dashboard widget） ──

    await commandBus.registerHandler('lab_seat.get_current_lesson_attendance', {
      async execute() {
        // 查找最近活跃的签到会话
        const session = rawDb.prepare(
          `SELECT * FROM ${T_SESSIONS} WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1`
        ).get();
        if (!session) return null;
        const lessonId = (session as any).lesson_id;
        const records = rawDb.prepare(
          `SELECT status, COUNT(*) as cnt FROM ${T_ATTEND} WHERE lesson_id = ? GROUP BY status`
        ).all(lessonId);
        const total = rawDb.prepare(
          `SELECT COUNT(*) as cnt FROM ${T_ASSIGN} WHERE lesson_id = ?`
        ).get(lessonId);
        const summary: Record<string, number> = { checked_in: 0, late: 0, leave: 0, absent: 0, total: (total as any)?.cnt || 0 };
        for (const r of records as any[]) {
          summary[r.status] = r.cnt;
        }
        summary.absent = summary.total - summary.checked_in - summary.late - summary.leave;
        return summary;
      },
    });

    // ── 11. 积分集成（EventBus 订阅） ──

    eventBus.subscribe('lab_seat.student_checked_in', async (event: any) => {
      try {
        const points = getConfigValue('points_per_check_in') ?? 5;
        if (points <= 0) return;
        // 尝试调用积分服务
        // 使用 SDK 导出的强类型 Token；服务缺失时 ctx.resolve 抛 DI 错误，静默跳过。
        try {
          const pointsService = await ctx.resolve(IPointsLedgerServiceToken);
          if (pointsService && typeof (pointsService as any).addPoints === 'function') {
            await (pointsService as any).addPoints(event.payload.studentId, points, '机房签到');
          }
        } catch {
          // 积分服务未安装，静默跳过
        }
      } catch {
        // 静默处理
      }
    });

    // ── 12. 注册 ILabSeatService 供其他插件消费 ──

    // Worker runtime 不支持 provide，仅主进程生效
    if (typeof (ctx as any).provide === 'function') {
      await (ctx as any).provide(
        ILabSeatServiceToken as any,
        {
          async getStudentSeat(lessonId: string, studentId: string) {
          return getStudentSeatForLesson(lessonId, studentId);
        },
        async getAttendanceStatus(lessonId: string, studentId: string) {
          return rawDb.prepare(
            `SELECT * FROM ${T_ATTEND} WHERE lesson_id = ? AND student_id = ?`
          ).get(lessonId, studentId) || null;
        },
        async getLessonAttendanceSummary(lessonId: string) {
          const records = rawDb.prepare(
            `SELECT status, COUNT(*) as cnt FROM ${T_ATTEND} WHERE lesson_id = ? GROUP BY status`
          ).all(lessonId);
          const total = rawDb.prepare(
            `SELECT COUNT(*) as cnt FROM ${T_ASSIGN} WHERE lesson_id = ?`
          ).get(lessonId);
          const s: Record<string, number> = { checked_in: 0, late: 0, leave: 0, absent: 0, total: (total as any)?.cnt || 0 };
          for (const r of records as any[]) s[r.status] = r.cnt;
          s.absent = s.total - s.checked_in - s.late - s.leave;
          return s;
        },
        // §3.4 研究活动 → 座位分布（用于活动插件展示组内学生坐哪）
        async getActivitySeatMap(activityId: string) {
          const groups = await getResearchGroups(activityId);
          const memberIds = [...new Set(groups.flatMap(g => g.member_ids))];
          if (memberIds.length === 0) return {};
          const placeholders = memberIds.map(() => '?').join(',');
          const rows = rawDb.prepare(`
            SELECT sa.student_id, sa.lab_id, sa.row_idx, sa.col_idx
            FROM ${T_ASSIGN} sa
            WHERE sa.student_id IN (${placeholders})
          `).all(...memberIds) as any[];
          const map: Record<string, { labId: string; rowIdx: number; colIdx: number }> = {};
          for (const r of rows) {
            map[r.student_id] = { labId: r.lab_id, rowIdx: r.row_idx, colIdx: r.col_idx };
          }
          return map;
        },
      },
      );
    }

    // ── 13. 签到异常自动判定（§3.2） ──
    // 定时扫描所有 open 的签到会话，按配置自动：
    //  - 开启后超时未签到 → leave（请假）
    //  - 已 late 且超时未签到 → absent（缺勤）
    // 抽成 command 便于手动触发 / 单测 / AI 调用；interval 只做周期触发。
    const autoMarkLeaveAfter = Number(getConfigValue('auto_mark_leave_after_minutes')) || 0;
    const latePromoteAfter = Number(getConfigValue('late_auto_promote_after_minutes')) || 0;
    const scanIntervalSec = Number(getConfigValue('auto_scan_interval_seconds')) || 60;
    const autoEnabled = autoMarkLeaveAfter > 0 || latePromoteAfter > 0;

    const runAutoScan = async () => {
      const now = Date.now();
      const openSessions = rawDb.prepare(
        `SELECT * FROM ${T_SESSIONS} WHERE status = 'open'`
      ).all() as any[];
      for (const session of openSessions) {
        const openedAt = session.opened_at || 0;
        if (autoMarkLeaveAfter > 0) {
          // 超时未签到 → leave
          const missings = rawDb.prepare(
            `SELECT sa.student_id FROM ${T_ASSIGN} sa
             LEFT JOIN ${T_ATTEND} a ON a.lesson_id = sa.lesson_id AND a.student_id = sa.student_id
             WHERE sa.lesson_id = ? AND a.id IS NULL`
          ).all(session.lesson_id) as any[];
          for (const row of missings) {
            if ((now - openedAt) > autoMarkLeaveAfter * 60 * 1000) {
              rawDb.prepare(`INSERT OR REPLACE INTO ${T_ATTEND}
                (id, lesson_id, student_id, status, checked_in_at, note)
                VALUES (?, ?, ?, 'leave', NULL, '自动标记：超时未签到')`)
                .run(uid(), session.lesson_id, row.student_id);
              ctx.log.info(`[auto] ${row.student_id} 在课节 ${session.lesson_id} 自动标记为请假`);
            }
          }
        }
        if (latePromoteAfter > 0) {
          // 已迟到且开启时间超阈值 → absent
          const lates = rawDb.prepare(
            `SELECT * FROM ${T_ATTEND} WHERE lesson_id = ? AND status = 'late'`
          ).all(session.lesson_id) as any[];
          const lateThresholdMs = (Number(getConfigValue('late_threshold_minutes')) || 10) * 60 * 1000;
          for (const late of lates) {
            if ((now - openedAt) > (latePromoteAfter * 60 * 1000) + lateThresholdMs) {
              rawDb.prepare(`UPDATE ${T_ATTEND} SET status = 'absent', note = '自动升级：迟到超时'
                WHERE lesson_id = ? AND student_id = ?`)
                .run(session.lesson_id, late.student_id);
              ctx.log.info(`[auto] ${late.student_id} 迟到超时升级为缺勤`);
            }
          }
        }
      }
    };

    await commandBus.registerHandler('lab_seat.auto_mark_absent', {
      async execute() {
        await runAutoScan();
        return { ok: true };
      },
    });

    if (autoEnabled) {
      runAutoScan();
      autoScanTimer = setInterval(runAutoScan, Math.max(scanIntervalSec, 10) * 1000);
      ctx.log.info(`[auto-scan] 签到异常自动判定已启用 (间隔 ${scanIntervalSec}s)`);
    } else {
      ctx.log.info('[auto-scan] 签到异常自动判定关闭（未配置阈值）');
    }

    ctx.log.info('Plugin activated');
  },

  async deactivate() {
    // §3.2 清理自动扫描 timer
    if (autoScanTimer) {
      clearInterval(autoScanTimer);
      autoScanTimer = null;
    }
    // ctx.db.dropAllTables() 由 PluginHost 自动调用
  },
};
