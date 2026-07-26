import type { PluginContext } from '@openlearn/plugin-sdk';
import {
  ICommandBusServiceToken,
  IActionRegistryServiceToken,
  IEventBusServiceToken,
  IDatabaseToken,
} from '@openlearn/plugin-sdk';

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

// ── Plugin ──────────────────────────────────────────────
export default {
  manifest: {
    id: '@aymwoo/plugin-lab-seat',
    name: '机房座位管理',
    version: '0.1.4',
    description: '统一机房座位管理 - 教师编排布局分配座位，学生查看座位并签到',
    author: 'aymwoo',
    engines: { openlearn: '>= 0.1.0' },
    requires: [
      '@openlearn/core:ICommandBusService@^1.0.0',
      '@openlearn/core:IActionRegistryService@^1.0.0',
      '@openlearn/core:IEventBusService@^1.0.0',
      '@openlearn/core:IDatabase@^1.0.0',
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
   await ctx.db.migrate(1, async (sqliteDb: any) => {
     // 机房元信息
     sqliteDb.prepare(`
       CREATE TABLE IF NOT EXISTS ${ctx.db.table('rooms')} (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         rows INTEGER NOT NULL,
         cols INTEGER NOT NULL,
         layout_json TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )
     `).run();
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
   });

    // ── 表名引用 ──────────────────────────────────────
    // Worker runtime 不提供 ctx.config，fallback 到 manifest 默认值
    const getConfigValue = (key: string): any => {
      const cfg = (ctx as any).config;
      if (cfg && typeof cfg[key] !== 'undefined') return cfg[key];
      return (ctx.manifest as any)?.configuration?.properties?.[key]?.default;
    };

    const T_ROOMS = ctx.db.table('rooms');
    const T_ASSIGN = ctx.db.table('seat_assignments');
    const T_ATTEND = ctx.db.table('attendance_records');
    const T_SESSIONS = ctx.db.table('check_in_sessions');
    const T_TEMPLATES = ctx.db.table('seat_templates');

    // ── 辅助函数 ──────────────────────────────────────
    function uid(): string {
      return globalThis.crypto.randomUUID();
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
      const row = rawDb.prepare(`SELECT layout_json FROM ${T_ROOMS} WHERE id = ?`).get(labId);
      if (!row) return null;
      try { return JSON.parse(row.layout_json); } catch { return null; }
    }

    function getStudentSeatForLesson(lessonId: string, studentId: string) {
      return rawDb.prepare(
        `SELECT sa.*, cr.name as lab_name, cr.rows, cr.cols
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
          name: { type: 'STRING', description: '机房名称，如 A101' },
          rows: { type: 'NUMBER', description: '行数' },
          cols: { type: 'NUMBER', description: '列数' },
          numberingScheme: { type: 'STRING', description: '编号规则：alphanumeric 或 numeric' },
        },
        required: ['name', 'rows', 'cols'],
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
        rawDb.prepare(`INSERT INTO ${T_ROOMS} (id, name, rows, cols, layout_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, p.name, p.rows, p.cols, JSON.stringify(layout), now, now);

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
        return rawDb.prepare(`SELECT * FROM ${T_ROOMS} ORDER BY created_at DESC`).all();
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
      description: '为学生分配座位。按学号顺序、随机打散或按小组聚集。如"帮我把这节课的学生随机分配到 A101 机房"',
      capabilityRequired: 'lab_seat:write',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          lessonId: { type: 'STRING', description: '课节 ID' },
          labId: { type: 'STRING', description: '机房 ID' },
          strategy: { type: 'STRING', description: '分配策略：sequential/random/grouped' },
          activityId: { type: 'STRING', description: '分组策略时的研究活动 ID' },
          templateId: { type: 'STRING', description: '应用模板 ID（覆盖自动策略）' },
        },
        required: ['lessonId', 'labId'],
      },
    });

    await commandBus.registerHandler('lab_seat.assign_seats', {
      async execute(command) {
        const p = command.payload as any;
        const layout = getLabLayout(p.labId);
        if (!layout) throw new Error('机房不存在');

        let students = getStudentsByLesson(p.lessonId);
        if (!students || students.length === 0) {
          throw new Error('未找到该课节的学生');
        }

        // 如果指定了模板，直接用模板分配
        if (p.templateId) {
          const tmpl = rawDb.prepare(`SELECT * FROM ${T_TEMPLATES} WHERE id = ?`).get(p.templateId);
          if (!tmpl) throw new Error('模板不存在');
          const assignments = JSON.parse(tmpl.assignments_json);
          const delStmt = rawDb.prepare(`DELETE FROM ${T_ASSIGN} WHERE lesson_id = ? AND lab_id = ?`).run();
          const insStmt = rawDb.prepare(`INSERT OR REPLACE INTO ${T_ASSIGN}
            (id, lesson_id, student_id, lab_id, row_idx, col_idx, group_id, assigned_strategy, assigned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run();
          const now = Date.now();
          delStmt.run(p.lessonId, p.labId);
          for (const a of assignments) {
            insStmt.run(uid(), p.lessonId, a.student_id, p.labId, a.row_idx, a.col_idx, a.group_id || '', 'template', now);
          }
        } else {
          const strategy: AssignStrategy = p.strategy || 'random';
          const seats = layout.cells.filter(c => c.type !== 'none');
          const shuffled = [...seats];

          if (strategy === 'random') {
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            students = [...students];
            for (let i = students.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [students[i], students[j]] = [students[j], students[i]];
            }
          } else if (strategy === 'grouped' && p.activityId) {
            const groups = rawDb.prepare(
              `SELECT * FROM plugin_research_groups WHERE activity_id = ?`
            ).all(p.activityId);
            const grouped: typeof students = [];
            for (const g of groups) {
              const memberIds: string[] = JSON.parse(g.member_ids);
              for (const mid of memberIds) {
                const s = students.find((s: any) => s.id === mid);
                if (s) {
                  (s as any).group_id = g.id;
                  grouped.push(s);
                }
              }
            }
            // 未分组的学生追加到末尾
            for (const s of students) {
              if (!grouped.find((g: any) => g.id === s.id)) grouped.push(s);
            }
            students = grouped;
          }
          // sequential 保持原序

          // 写入分配
          const delStmt = rawDb.prepare(`DELETE FROM ${T_ASSIGN} WHERE lesson_id = ? AND lab_id = ?`).run();
          const insStmt = rawDb.prepare(`INSERT OR REPLACE INTO ${T_ASSIGN}
            (id, lesson_id, student_id, lab_id, row_idx, col_idx, group_id, assigned_strategy, assigned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run();
          const now = Date.now();
          delStmt.run(p.lessonId, p.labId);
          for (let i = 0; i < students.length && i < shuffled.length; i++) {
            const s: any = students[i];
            insStmt.run(uid(), p.lessonId, s.id, p.labId, shuffled[i].row, shuffled[i].col,
              s.group_id || '', strategy, now);
          }
        }

        const count = rawDb.prepare(
          `SELECT COUNT(*) as cnt FROM ${T_ASSIGN} WHERE lesson_id = ? AND lab_id = ?`
        ).get(p.lessonId, p.labId);

        await eventBus.publish({
          id: uid(), type: 'lab_seat.seats_assigned', source: `plugin.${pluginId}`,
          payload: { lessonId: p.lessonId, labId: p.labId, count: (count as any).cnt },
          timestamp: Date.now(), correlationId: command.id,
        });
        return { message: `已为 ${(count as any).cnt} 名学生分配座位` };
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

    // 查询某课节的座位分配
    await commandBus.registerHandler('lab_seat.get_assignments', {
      async execute(command) {
        const p = command.payload as any;
        return rawDb.prepare(`
          SELECT sa.*, u.name as student_name
          FROM ${T_ASSIGN} sa
          JOIN users u ON u.id = sa.student_id
          WHERE sa.lesson_id = ?
          ORDER BY sa.row_idx, sa.col_idx
        `).all(p.lessonId);
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
        const records = rawDb.prepare(`
          SELECT a.*, u.name as student_name, sa.row_idx, sa.col_idx
          FROM ${T_ASSIGN} sa
          LEFT JOIN ${T_ATTEND} a ON a.lesson_id = sa.lesson_id AND a.student_id = sa.student_id
          JOIN users u ON u.id = sa.student_id
          WHERE sa.lesson_id = ?
          ORDER BY sa.row_idx, sa.col_idx
        `).all(p.lessonId);

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
        const records = rawDb.prepare(`
          SELECT sa.row_idx, sa.col_idx, u.name as student_name, u.id as student_id,
            COALESCE(a.status, 'absent') as status,
            a.checked_in_at, a.note
          FROM ${T_ASSIGN} sa
          JOIN users u ON u.id = sa.student_id
          LEFT JOIN ${T_ATTEND} a ON a.lesson_id = sa.lesson_id AND a.student_id = sa.student_id
          WHERE sa.lesson_id = ?
          ORDER BY sa.row_idx, sa.col_idx
        `).all(p.lessonId);

        const lab = rawDb.prepare(`
          SELECT cr.name FROM ${T_ASSIGN} sa
          JOIN ${T_ROOMS} cr ON cr.id = sa.lab_id
          WHERE sa.lesson_id = ? LIMIT 1
        `).get(p.lessonId);

        let csv = '\uFEFF座位编号,学生姓名,学号,签到状态,签到时间,备注\n';
        for (const r of records as any[]) {
          const layout = getLabLayout(r.lab_id);
          const label = layout?.cells?.find((c: SeatCell) => c.row === r.row_idx && c.col === r.col_idx)?.label || `${r.row_idx}-${r.col_idx}`;
          const time = r.checked_in_at ? new Date(r.checked_in_at).toISOString() : '';
          const statusMap: Record<string, string> = { checked_in: '已签到', late: '迟到', leave: '请假', absent: '未签到' };
          csv += `${label},${r.student_name},${r.student_id},${statusMap[r.status] || r.status},${time},${r.note || ''}\n`;
        }
        return { csv, filename: `attendance_${p.lessonId}.csv` };
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
        return commandBus.execute({
          type: 'lab_seat.assign_seats',
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
        const pointsToken = { name: '@openlearn/core:IPointsLedgerService' };
        try {
          const pointsService: any = await ctx.resolve(pointsToken as any);
          if (pointsService && pointsService.addPoints) {
            await pointsService.addPoints(event.payload.studentId, points, '机房签到');
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
      { name: '@aymwoo/plugin-lab-seat:ILabSeatService' } as any,
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
      },
      );
    }

    ctx.log.info('Plugin activated');
  },

  async deactivate() {
    // ctx.db.dropAllTables() 由 PluginHost 自动调用
  },
};
