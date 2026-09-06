/**
 * openlearn-plugin-lab-seat — 前端 UI（React JSX）
 *
 * 入口由 host 通过 `import('./frontend.tsx')` 加载，调用 default export.activate(ctx)。
 *
 * 槽位（按 SDK 文档约定）：
 *   - teacher.tab                  → TeacherLabPanel
 *   - teacher.dashboard.widget     → DashboardAttendanceWidget
 *   - student.view                 → StudentSeatView
 *   - classroom.tool               → LabSeatToolPanel（浮动面板）
 */

import React, { useState, useEffect, useCallback } from 'react';

// 模块级 FrontendPluginContext，由 activate() 注入
let ctx: any = null;
let ReactDOM: any = null;

// ── 工具函数 ──────────────────────────────────────────

async function invoke<T = any>(type: string, payload?: any): Promise<T> {
  if (!ctx) throw new Error('Plugin not activated');
  return ctx.invokeCommand(type, payload);
}

// FrontendPluginContext.services 在不同 host 版本下差异较大：
// 老版本可能没有 socketService；新版本可能有。统一封装。
//
// 特性：
//  - 有 socketService → 事件驱动订阅；额外保留低频心跳轮询作为事件丢失兑底。
//  - 无 socketService → 自适应轮询：页面可见时快，隐藏时暂停；连续无变化时
//    间隔指数退避（5s→10s→20s→30s 封顶），数据变化后回到快速档。
//  - in-flight 保护：handler 异步执行期间跳过下一次调度，避免竞态叠加。
function subscribeToEvents(
  events: string[],
  handler: (event?: any) => void | Promise<void>,
  opts?: { fastMs?: number; maxMs?: number },
): () => void {
  const sock = ctx?.services?.socketService;
  const fastMs = opts?.fastMs ?? 3000;
  const maxMs = opts?.maxMs ?? 30000;
  let disposed = false;
  let timer: any = null;
  let inFlight = false;

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  // 心跳 / 轮询执行体（带 in-flight 保护）
  const tick = async () => {
    if (disposed || inFlight) return;
    inFlight = true;
    try { await handler(); } catch { /* 静默：数据源瞬时错误由下次轮询重试 */ } finally { inFlight = false; }
  };

  let currentMs = fastMs;
  const scheduleNext = (resetToFast: boolean) => {
    if (disposed) return;
    if (resetToFast) currentMs = fastMs;
    clearTimer();
    timer = setTimeout(() => {
      tick().then(() => {
        // 退避：每次空闲后拉长，收到真实变化事件则重置（见下方 onEvent）
        currentMs = Math.min(currentMs * 2, maxMs);
        scheduleNext(false);
      });
    }, currentMs);
  };

  // 事件驱动（socket 存在时）
  let stopSocket: (() => void) | null = null;
  if (sock && typeof sock.on === 'function' && typeof sock.off === 'function') {
    const onEvent = (event: any) => {
      currentMs = fastMs; // 收到真实事件 → 回到快速档
      tick();
    };
    for (const ev of events) {
      try { sock.on(ev, onEvent); } catch { /* 静默 */ }
    }
    stopSocket = () => {
      for (const ev of events) {
        try { sock.off(ev, onEvent); } catch { /* 静默 */ }
      }
    };
  }

  // 可见性感知：标签页隐藏时暂停后台轮询省电，恢复后立即补一次
  const onVisibility = () => {
    if (document.hidden) { clearTimer(); return; }
    currentMs = fastMs;
    scheduleNext(true);
  };
  document.addEventListener('visibilitychange', onVisibility);

  // 启动（初始立即执行一次）
  tick();
  scheduleNext(true);

  return () => {
    disposed = true;
    clearTimer();
    document.removeEventListener('visibilitychange', onVisibility);
    stopSocket?.();
  };
}

// 浏览器原生 CSV 下载，不依赖 host 的 uiService。
function downloadCsv(filename: string, csv: string): void {
  const ui = ctx?.services?.uiService;
  if (ui && typeof ui.downloadFile === 'function') {
    try { ui.downloadFile(csv, filename, 'text/csv'); return; } catch { /* fallback */ }
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 剥离 [lab_seat:CODE] 前缀，只把可读中文展示给用户
function humanizeErr(e: any): string {
  if (!e?.message) return '操作失败';
  return String(e.message).replace(/^\[lab_seat:[A-Z_]+\]\s*/, '');
}

// ── 常量 ──────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  checked_in: '#22c55e',
  late: '#eab308',
  leave: '#3b82f6',
  absent: '#9ca3af',
};

const STATUS_LABELS: Record<string, string> = {
  checked_in: '已签到',
  late: '迟到',
  leave: '请假',
  absent: '未签到',
};

// ── 子组件：课节选择器 ────────────────────────────────

function LessonPicker({
  value, onChange, placeholder, style,
}: {
  value: string;
  onChange: (lessonId: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const [lessons, setLessons] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setErr('');
      try {
        const r = await invoke<any[]>('lab_seat.list_lessons', { limit: 100 });
        if (!cancelled) setLessons(r || []);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || '加载课节失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const baseStyle: React.CSSProperties = {
    padding: '6px 8px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    background: '#fff',
    ...style,
  };

  if (err) {
    return <span style={{ ...baseStyle, color: '#ef4444', fontSize: 12 }}>课节加载失败：{err}</span>;
  }
  if (loading && lessons.length === 0) {
    return <span style={{ ...baseStyle, color: '#9ca3af', fontSize: 12 }}>加载课节…</span>;
  }
  if (lessons.length === 0) {
    return <span style={{ ...baseStyle, color: '#9ca3af', fontSize: 12 }}>{placeholder || '暂无课节'}</span>;
  }

  return (
    <select
      value={value || ''}
      onChange={(e: any) => onChange(e.target.value)}
      style={baseStyle}
      title={`${lessons.length} 个可选课节`}
    >
      <option value="">{placeholder || '-- 选择课节 --'}</option>
      {lessons.map((l: any) => {
        const status = l.status === 'live' || l.status === 'active' ? '🟢 ' : '·  ';
        const title = l.name || l.title || `lesson ${String(l.id).slice(0, 8)}`;
        const time = l.started_at ? new Date(l.started_at).toLocaleDateString() : '';
        return (
          <option key={l.id} value={l.id}>
            {status}{title}{time ? ` (${time})` : ''}
          </option>
        );
      })}
    </select>
  );
}

// ── 子组件：机房布局编辑器 ───────────────────────────

// 单元格类型常量
const CELL_TYPE_META: Record<string, { label: string; bg: string; short: string }> = {
  desktop:  { label: '台式机', bg: '#dbeafe', short: '💻' },
  notebook: { label: '笔记本', bg: '#fef3c7', short: '📓' },
  none:     { label: '空位',   bg: '#f3f4f6', short: '·' },
};

// 交互式座位网格编辑器：选中机房后可视化编辑每个 cell 的类型/IP/备注。
function LayoutEditor({ room, onClose, onSaved }: {
  room: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [layout, setLayout] = useState<any>(null);
  const [selectedCell, setSelectedCell] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!room) return;
    try {
      const parsed = room.layout_json && room.layout_json !== '{}'
        ? JSON.parse(room.layout_json)
        : {
            rows: room.rows,
            cols: room.cols,
            numbering: { scheme: 'alphanumeric', direction: 'row-first' },
            cells: Array.from({ length: room.rows * room.cols }, (_, i) => ({
              row: Math.floor(i / room.cols),
              col: i % room.cols,
              label: `${String.fromCharCode(65 + Math.floor(i / room.cols))}${(i % room.cols) + 1}`,
              type: 'desktop', ip: '', note: '',
            })),
          };
      setLayout(parsed);
    } catch {
      setLayout(null);
    }
  }, [room]);

  const updateCell = (row: number, col: number, patch: any) => {
    setLayout((prev: any) => ({
      ...prev,
      cells: prev.cells.map((c: any) =>
        c.row === row && c.col === col ? { ...c, ...patch } : c),
    }));
    setSelectedCell((prev: any) =>
      prev && prev.row === row && prev.col === col ? { ...prev, ...patch } : prev);
  };

  const cycleCellType = (row: number, col: number) => {
    const order = ['desktop', 'notebook', 'none'];
    const current = layout.cells.find((c: any) => c.row === row && c.col === col);
    const idx = order.indexOf(current?.type);
    const next = order[(idx + 1) % order.length];
    updateCell(row, col, { type: next });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await invoke('lab_seat.update_layout', {
        roomId: room.id,
        layout: { rows: layout.rows, cols: layout.cols, numbering: layout.numbering, cells: layout.cells },
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (!layout) return <div style={{ padding: 16, color: '#9ca3af' }}>加载中…</div>;

  const stats = {
    desktop: layout.cells.filter((c: any) => c.type === 'desktop').length,
    notebook: layout.cells.filter((c: any) => c.type === 'notebook').length,
    none: layout.cells.filter((c: any) => c.type === 'none').length,
  };

  return (
    <div style={{ padding: 16, borderTop: '2px solid #e5e7eb', marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h4 style={{ margin: 0 }}>布局编辑器 · {room.display_name || room.room_number}</h4>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onClose}
            style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer', fontSize: 12 }}
          >
            关闭
          </button>
          <button
            onClick={handleSave} disabled={saving}
            style={{ padding: '4px 12px', background: saving ? '#9ca3af' : '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 12 }}
          >
            {saving ? '保存中…' : '保存布局'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 12, color: '#6b7280' }}>
        <span>💻 台式 {stats.desktop}</span>
        <span>📓 笔记本 {stats.notebook}</span>
        <span>· 空位 {stats.none}</span>
        <span style={{ color: '#9ca3af' }}>· 单击格子在 desktop / notebook / none 间循环 · 双击打开详情</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${layout.cols}, 48px)`, gap: 3, marginBottom: 12 }}>
        {layout.cells.map((cell: any) => {
          const meta = CELL_TYPE_META[cell.type] || CELL_TYPE_META.desktop;
          const isSelected = selectedCell && selectedCell.row === cell.row && selectedCell.col === cell.col;
          return (
            <div key={`${cell.row},${cell.col}`}
              title={`${cell.label}${cell.ip ? ` · ${cell.ip}` : ''}${cell.note ? ` · ${cell.note}` : ''}`}
              onClick={() => cycleCellType(cell.row, cell.col)}
              onDoubleClick={() => setSelectedCell(cell)}
              style={{
                width: 44, height: 36, borderRadius: 4, background: meta.bg,
                border: isSelected ? '2px solid #2563eb' : '1px solid #e5e7eb',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, cursor: 'pointer',
              }}
            >
              <span>{meta.short}</span>
              <span style={{ fontSize: 8, color: '#6b7280' }}>{cell.label}</span>
            </div>
          );
        })}
      </div>

      {selectedCell && (
        <div style={{ background: '#f9fafb', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontWeight: 600 }}>单元格 {selectedCell.label}</span>
            <button onClick={() => setSelectedCell(null)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}>✕</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>类型</span>
              <select value={selectedCell.type} onChange={(e: any) => updateCell(selectedCell.row, selectedCell.col, { type: e.target.value })}
                style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}>
                <option value="desktop">💻 台式机</option>
                <option value="notebook">📓 笔记本</option>
                <option value="none">· 空位</option>
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>IP / 资产编号</span>
              <input value={selectedCell.ip || ''} onChange={(e: any) => updateCell(selectedCell.row, selectedCell.col, { ip: e.target.value })}
                placeholder="192.168.1.10 或资产号"
                style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }} />
            </label>
            <label style={{ gridColumn: '1 / 3', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>备注</span>
              <input value={selectedCell.note || ''} onChange={(e: any) => updateCell(selectedCell.row, selectedCell.col, { note: e.target.value })}
                placeholder="如：靠近投影仪 / 损坏"
                style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function RoomEditor({ onCreated }: { onCreated: () => void }) {
  const [rooms, setRooms] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [roomNumber, setRoomNumber] = useState('');
  const [name, setName] = useState('');
  const [rows, setRows] = useState(5);
  const [cols, setCols] = useState(8);
  const [editingRoom, setEditingRoom] = useState<any>(null);

  const load = useCallback(async () => {
    const r = await invoke<any[]>('lab_seat.list_rooms');
    setRooms(r || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!roomNumber) return;
    await invoke('lab_seat.create_room', {
      room_number: roomNumber, name: name || roomNumber, rows, cols,
    });
    setRoomNumber(''); setName(''); setShowForm(false);
    await load();
    onCreated();
  };

  const refreshEditing = useCallback(async () => {
    if (!editingRoom) return;
    const r = await invoke<any>('lab_seat.get_room', { roomId: editingRoom.id });
    if (r) setEditingRoom(r);
  }, [editingRoom]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>机房列表</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          style={{ padding: '6px 16px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer' }}
        >
          {showForm ? '取消' : '+ 新建机房'}
        </button>
      </div>

      {showForm && (
        <div style={{ background: '#f9fafb', padding: 16, borderRadius: 8, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>编号</span>
            <input value={roomNumber} onChange={(e: any) => setRoomNumber(e.target.value)}
              placeholder="如 410" style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 100 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>名称</span>
            <input value={name} onChange={(e: any) => setName(e.target.value)}
              placeholder="如 A101（可选）" style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 100 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>行数</span>
            <input type="number" value={rows} min={1} max={20}
              onChange={(e: any) => setRows(Number(e.target.value))}
              style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 60 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>列数</span>
            <input type="number" value={cols} min={1} max={20}
              onChange={(e: any) => setCols(Number(e.target.value))}
              style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 60 }} />
          </label>
          <button
            onClick={handleCreate}
            style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
          >
            创建
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {rooms.map((r: any) => (
          <div key={r.id} style={{ padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>
              {r.display_name || r.room_number}{' '}
              <span style={{ color: '#9ca3af', fontSize: 13 }}>{r.rows}×{r.cols}</span>
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>{new Date(r.created_at).toLocaleDateString()}</span>
              <button
                onClick={() => setEditingRoom(r)}
                style={{
                  padding: '4px 10px', border: '1px solid #2563eb', borderRadius: 4,
                  background: editingRoom?.id === r.id ? '#2563eb' : '#fff',
                  color: editingRoom?.id === r.id ? '#fff' : '#2563eb',
                  cursor: 'pointer', fontSize: 12,
                }}
              >
                {editingRoom?.id === r.id ? '编辑中' : '编辑布局'}
              </button>
            </div>
          </div>
        ))}
        {rooms.length === 0 && <p style={{ color: '#9ca3af' }}>暂无机房</p>}
      </div>

      {editingRoom && (
        <LayoutEditor
          room={editingRoom}
          onClose={() => setEditingRoom(null)}
          onSaved={refreshEditing}
        />
      )}
    </div>
  );
}

// ── 子组件：座位分配 ─────────────────────────────────

function SeatAssignment({ lessonId: externalLessonId }: { lessonId?: string } = {}) {
  const [rooms, setRooms] = useState<any[]>([]);
  const [linkedLabs, setLinkedLabs] = useState<any[]>([]);   // 课节已关联机房（list_lesson_labs）
  const [viewLabId, setViewLabId] = useState('');            // 当前展示 / 操作机房
  const [strategy, setStrategy] = useState('random');
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [assignments, setAssignments] = useState<any[]>([]);
  const [layout, setLayout] = useState<any>(null);
  const [dragMsg, setDragMsg] = useState('');
  const [attendance, setAttendance] = useState<any>(null);

  // §2.5 触屏友好：HTML5 Drag & Drop 在触屏上不工作。
  // isTouch = true 时降级为「点学生 → 点目标座位」两步 picker。
  const [isTouch] = useState(() =>
    typeof window !== 'undefined'
      && (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)));
  const [pendingMove, setPendingMove] = useState<any>(null); // 待落座的学生 chip（触屏 picker）

  // 父组件传入的 lessonId 是受控值；没有时退化为手填输入框
  const [internalLessonId, setInternalLessonId] = useState('');
  const lessonId = externalLessonId || internalLessonId;

  // 可用但未关联的机房（供“添加到课节”）
  const unlinkedRooms = rooms.filter(r => !linkedLabs.some(l => l.id === r.id));

  useEffect(() => {
    invoke<any[]>('lab_seat.list_rooms').then(r => setRooms(r || []));
  }, []);

  const loadLinkedLabs = useCallback(async () => {
    if (!lessonId) return;
    const r = await invoke<any[]>('lab_seat.list_lesson_labs', { lessonId });
    const list = r || [];
    setLinkedLabs(list);
    // 切换课节后：默认查看第一个有分配/第一个关联机房
    setViewLabId(prev => {
      if (list.some(l => l.id === prev)) return prev;
      return list.find((l: any) => l.assigned_count > 0)?.id || list[0]?.id || '';
    });
  }, [lessonId]);

  // 加载当前查看机房的分配 / 布局 / 考勤
  const loadAssignments = useCallback(async () => {
    if (!lessonId || !viewLabId) return;
    const [asgn, room, att] = await Promise.all([
      invoke<any[]>('lab_seat.get_assignments', { lessonId, labId: viewLabId }),
      invoke<any>('lab_seat.get_room', { roomId: viewLabId }),
      invoke<any>('lab_seat.get_attendance', { lessonId, labId: viewLabId }),
    ]);
    setAssignments(asgn || []);
    if (room) setLayout(JSON.parse(room.layout_json));
    setAttendance(att);
  }, [lessonId, viewLabId]);

  // lessonId 或当前机房变化时：刷新关联 + 分配
  useEffect(() => {
    if (lessonId) {
      loadLinkedLabs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId]);
  useEffect(() => {
    if (lessonId && viewLabId) loadAssignments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId, viewLabId]);

  // 模板仅与当前查看机房绑定
  useEffect(() => {
    if (viewLabId) {
      invoke<any[]>('lab_seat.list_templates', { labId: viewLabId }).then(t => setTemplates(t || []));
    }
  }, [viewLabId]);

  // 分配：若关联了多个机房 → 批量（labIds）；否则单机房
  const handleAssign = async (targetLabIds?: string[]) => {
    const labIds = targetLabIds && targetLabIds.length > 0
      ? targetLabIds
      : (linkedLabs.length > 0 ? linkedLabs.map((l: any) => l.id) : [viewLabId]);
    if (!lessonId || labIds.length === 0) return;
    setDragMsg('分配中…');
    try {
      await invoke('lab_seat.assign_seats', {
        lessonId,
        labIds: labIds.length > 1 ? labIds : undefined,
        labId: labIds.length === 1 ? labIds[0] : undefined,
        strategy: selectedTemplate ? undefined : strategy,
        templateId: selectedTemplate || undefined,
      });
      await loadLinkedLabs();
      if (viewLabId) await loadAssignments();
      setDragMsg('');
    } catch (e: any) {
      setDragMsg(humanizeErr(e));
    }
  };

  const handleAddLab = async (labId: string) => {
    await invoke('lab_seat.add_lesson_lab', { lessonId, labId });
    await loadLinkedLabs();
  };

  const handleRemoveLab = async (labId: string) => {
    await invoke('lab_seat.remove_lesson_lab', { lessonId, labId });
    await loadLinkedLabs();
    if (viewLabId === labId) setViewLabId('');
  };

  const handleDragStart = (e: any, studentId: string) => {
    e.dataTransfer.setData('text/plain', studentId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = async (e: any, row: number, col: number) => {
    e.preventDefault();
    const studentId = e.dataTransfer.getData('text/plain');
    await moveStudent(studentId, row, col);
  };

  // 统一移动逻辑：桌面拖拽 + 触屏 picker 都走这里。row/col 为 -1 时表示移除座位
  const moveStudent = async (studentId: string, row: number, col: number) => {
    if (!studentId || studentId === '') return;
    if (row < 0 || col < 0) {
      await invoke('lab_seat.unassign_student', { lessonId, studentId });
      await loadAssignments();
      setPendingMove(null);
      return;
    }
    // 目标座位已被其他学生占时提示，不覆盖
    const occupied = occupyMap.get(`${row},${col}`);
    if (occupied && occupied !== studentId) {
      setDragMsg(`座位已被 ${occupied} 占用，先移除该学生`);
      setPendingMove(null);
      return;
    }
    await invoke('lab_seat.move_student', { lessonId, studentId, rowIdx: row, colIdx: col });
    await loadAssignments();
    setPendingMove(null);
  };

  // 触屏 picker：点击学生 chip 选中待落座对象
  const handleChipTap = (a: any) => {
    if (!isTouch) return; // 桌面仍用拖拽
    if (pendingMove?.student_id === a.student_id) {
      setPendingMove(null);
      setDragMsg('');
    } else {
      setPendingMove(a);
      setDragMsg(`已选中 ${a.student_name}，点击下方目标座位落座`);
    }
  };

  // 触屏 picker：点击座位格落座（仅 when pendingMove active）
  const handleCellTap = (cell: any) => {
    if (!isTouch) return;
    if (pendingMove) {
      moveStudent(pendingMove.student_id, cell.row, cell.col);
    }
  };

  const occupyMap = new Map<string, string>();
  assignments.forEach((a: any) => occupyMap.set(`${a.row_idx},${a.col_idx}`, a.student_name));

  return (
    <div style={{ padding: 16 }}>
      <h3>座位分配</h3>
      <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {!externalLessonId && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>课节 ID</span>
            <input value={internalLessonId} onChange={(e: any) => setInternalLessonId(e.target.value)}
              placeholder="输入 lesson id" style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 220 }} />
          </label>
        )}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, color: '#6b7280' }}>策略</span>
          <select value={strategy} onChange={(e: any) => setStrategy(e.target.value)}
            style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}>
            <option value="random">随机打散</option>
            <option value="sequential">按学号顺序</option>
            <option value="grouped">按小组聚集</option>
          </select>
        </label>
        {templates.length > 0 && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>模板（当前机房）</span>
            <select value={selectedTemplate} onChange={(e: any) => setSelectedTemplate(e.target.value)}
              style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}>
              <option value="">自动分配</option>
              {templates.map((t: any) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        )}
        <button
          onClick={() => handleAssign()} disabled={!lessonId || linkedLabs.length === 0}
          title={linkedLabs.length > 1 ? `批量分配到 ${linkedLabs.length} 个机房` : '分配到当前机房'}
          style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', opacity: (!lessonId || linkedLabs.length === 0) ? 0.5 : 1 }}
        >
          {linkedLabs.length > 1 ? `批量分配 (${linkedLabs.length} 机房)` : '分配座位'}
        </button>
      </div>

      {/* 关联机房 chips：多机房切换 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16, padding: '8px 0' }}>
        <span style={{ fontSize: 12, color: '#6b7280' }}>课节机房：</span>
        {linkedLabs.map((l: any) => (
          <span key={l.id}
            style={{
              padding: '4px 10px', borderRadius: 12, fontSize: 12, cursor: 'pointer',
              background: viewLabId === l.id ? '#2563eb' : '#eef2ff',
              color: viewLabId === l.id ? '#fff' : '#4338ca',
              border: viewLabId === l.id ? '1px solid #2563eb' : '1px solid #c7d2fe',
            }}
            onClick={() => setViewLabId(l.id)}
            title={`${l.display_name} · 已分配 ${l.assigned_count || 0} 人 · 点击切换 · 右键移除`}
            onContextMenu={(e: any) => {
              e.preventDefault();
              if (confirm(`移除机房 ${l.display_name}？该机房内分配会被清空`)) handleRemoveLab(l.id);
            }}
          >
            {l.display_name}{l.assigned_count > 0 ? ` (${l.assigned_count})` : ''}
          </span>
        ))}
        {unlinkedRooms.length > 0 && (
          <select
            value=""
            onChange={(e: any) => { if (e.target.value) handleAddLab(e.target.value); }}
            style={{ padding: '3px 8px', border: '1px dashed #c7d2fe', borderRadius: 12, fontSize: 12, background: '#fff', cursor: 'pointer' }}
          >
            <option value="">+ 添加机房</option>
            {unlinkedRooms.map((r: any) => (
              <option key={r.id} value={r.id}>{r.display_name || r.name || r.room_number}</option>
            ))}
          </select>
        )}
        <span style={{ fontSize: 11, color: '#9ca3af' }}>· 右键机房可移除</span>
      </div>

      {dragMsg && <p style={{ color: '#6b7280', fontSize: 13 }}>{dragMsg}</p>}

      {viewLabId && layout && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
            座位网格{isTouch ? '（先点学生，再点目标座位落座）' : '（拖拽学生到目标座位）'} · 当前机房：{linkedLabs.find((l: any) => l.id === viewLabId)?.display_name || viewLabId}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${layout.cols}, 64px)`, gap: 4, marginBottom: 8 }}>
            {layout.cells.map((cell: any) => {
              const key = `${cell.row},${cell.col}`;
              const student = occupyMap.get(key);
              const attStatus = attendance?.records?.find((r: any) => r.row_idx === cell.row && r.col_idx === cell.col)?.status;
              const bg = student ? (attStatus ? STATUS_COLORS[attStatus] : '#dbeafe') : '#f3f4f6';
              // 触屏 picker 高亮可落座目标
              const tappable = isTouch && pendingMove;
              return (
                <div key={key}
                  data-row={cell.row} data-col={cell.col}
                  onDragOver={(e: any) => e.preventDefault()}
                  onDrop={(e: any) => handleDrop(e, cell.row, cell.col)}
                  onClick={() => handleCellTap(cell)}
                  style={{
                    width: 60, height: 48, border: tappable && !student ? '2px solid #2563eb' : '1px solid #d1d5db', borderRadius: 4, background: bg,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, cursor: tappable ? 'crosshair' : 'pointer', overflow: 'hidden',
                    transition: 'border-color .1s',
                  }}>
                  <span style={{ fontWeight: 600 }}>{cell.label}</span>
                  {student && (
                    <span style={{ fontSize: 10, color: '#374151', maxWidth: 56, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {student}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#6b7280' }}>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#22c55e', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />已签到</span>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#eab308', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />迟到</span>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#3b82f6', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />请假</span>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#9ca3af', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />未签到</span>
          </div>
        </div>
      )}

      {assignments.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button
              onClick={async () => {
                if (!viewLabId) return;
                const tplName = prompt('模板名称：');
                if (tplName) {
                  await invoke('lab_seat.save_template', { lessonId, labId: viewLabId, name: tplName });
                  invoke<any[]>('lab_seat.list_templates', { labId: viewLabId }).then(t => setTemplates(t || []));
                }
              }}
              style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer', fontSize: 12 }}
            >
              保存为模板
            </button>
            <button
              onClick={async () => { await invoke('lab_seat.open_check_in', { lessonId, labId: viewLabId }); }}
              style={{ padding: '4px 12px', border: '1px solid #22c55e', borderRadius: 4, background: '#f0fdf4', cursor: 'pointer', fontSize: 12 }}
            >
              开启签到
            </button>
            <button
              onClick={async () => { await invoke('lab_seat.close_check_in', { lessonId }); }}
              style={{ padding: '4px 12px', border: '1px solid #ef4444', borderRadius: 4, background: '#fef2f2', cursor: 'pointer', fontSize: 12 }}
            >
              截止签到
            </button>
          </div>
          <p style={{ fontSize: 12, color: '#6b7280' }}>已分配 {assignments.length} 名学生</p>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {assignments.map((a: any) => {
              const isPending = pendingMove?.student_id === a.student_id;
              return (
                <span key={a.student_id}
                  draggable
                  onDragStart={(e: any) => handleDragStart(e, a.student_id)}
                  onClick={() => handleChipTap(a)}
                  title={isTouch ? '点击选中，再点座位落座；再次点击取消' : '拖拽到座位；点击可移除座位'}
                  style={{
                    padding: '4px 8px', background: isPending ? '#2563eb' : '#f3f4f6',
                    borderRadius: 4, fontSize: 12,
                    cursor: isTouch ? 'pointer' : 'grab',
                    border: isPending ? '1px solid #2563eb' : '1px solid #e5e7eb',
                    color: isPending ? '#fff' : 'inherit',
                  }}
                >
                  {a.student_name}
                  {!isTouch && (
                    <span
                      onClick={(e: any) => { e.stopPropagation(); moveStudent(a.student_id, -1, -1); }}
                      title="移除座位（回到未分配区）"
                      style={{ marginLeft: 6, cursor: 'pointer', opacity: 0.5, fontSize: 11 }}
                    >✕</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 子组件：考勤看板 ─────────────────────────────────

function StatBadge({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 12, color: '#6b7280' }}>{label}</span>
      <span style={{ fontWeight: 700, fontSize: 16 }}>{count}</span>
    </div>
  );
}

function AttendanceDashboard({ lessonId: externalLessonId }: { lessonId?: string } = {}) {
  const [internalLessonId, setInternalLessonId] = useState('');
  const lessonId = externalLessonId || internalLessonId;
  const [data, setData] = useState<any>(null);
  const [labs, setLabs] = useState<any[]>([]); // 课节机房（含 layout_json 解析）

  const load = async () => {
    if (!lessonId) return;
    const [result, linked] = await Promise.all([
      invoke<any>('lab_seat.get_attendance', { lessonId }),
      invoke<any[]>('lab_seat.list_lesson_labs', { lessonId }),
    ]);
    setData(result);
    const list = linked || [];
    // 每个机房解析 layout_json 便于渲染网格
    const withLayouts = await Promise.all(list.map(async (l: any) => {
      let layout = null;
      try {
        const parsed = l.layout_json && l.layout_json !== '{}' ? JSON.parse(l.layout_json) : null;
        if (!parsed) {
          const room = await invoke<any>('lab_seat.get_room', { roomId: l.id });
          layout = room ? JSON.parse(room.layout_json) : null;
        } else layout = parsed;
      } catch { layout = null; }
      return { ...l, layout };
    }));
    setLabs(withLayouts);
  };

  useEffect(() => { if (lessonId) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lessonId]);

  const records = data?.records || [];
  const summary = data?.summary || { checked_in: 0, late: 0, leave: 0, absent: 0, total: 0 };
  // 无关联机房时，从 records 推断 lab 集合（旧数据兼容）
  const inferredLabs = [...new Set(records.map((r: any) => r.lab_id).filter(Boolean))];
  const labList = labs.length > 0 ? labs : [];

  return (
    <div style={{ padding: 16 }}>
      <h3>考勤看板</h3>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        {!externalLessonId && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>课节 ID</span>
            <input value={internalLessonId} onChange={(e: any) => setInternalLessonId(e.target.value)}
              placeholder="输入 lesson id" style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 220 }} />
          </label>
        )}
        <button
          onClick={load} disabled={!lessonId}
          style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
        >
          查询
        </button>
      </div>

      {summary.total > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          <StatBadge color="#22c55e" label="已签到" count={summary.checked_in} />
          <StatBadge color="#eab308" label="迟到" count={summary.late} />
          <StatBadge color="#3b82f6" label="请假" count={summary.leave} />
          <StatBadge color="#9ca3af" label="未签到" count={summary.absent} />
          <StatBadge color="#6b7280" label="总计" count={summary.total} />
        </div>
      )}

      {labList.length > 0 && labList.some((l: any) => l.layout) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginBottom: 16 }}>
          {labList.filter((l: any) => l.layout).map((lab: any) => {
            const labRecords = records.filter((r: any) => r.lab_id === lab.id);
            const labLayout = lab.layout;
            return (
              <div key={lab.id}>
                <p style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                  {lab.display_name || lab.name || lab.room_number} · {labRecords.length} 人
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${labLayout.cols}, 56px)`, gap: 3 }}>
                  {labLayout.cells.map((cell: any) => {
                    const rec = labRecords.find((r: any) => r.row_idx === cell.row && r.col_idx === cell.col);
                    const status = rec?.status || (labRecords.length > 0 && cell.type !== 'none' ? 'absent' : '');
                    // 无学生/空位类型格子不做着色
                    const emptyCell = !rec && (cell.type === 'none' || labRecords.length === 0);
                    return (
                      <div key={`${cell.row},${cell.col}`}
                        title={`${cell.label}${rec ? ': ' + rec.student_name + ' - ' + STATUS_LABELS[status] : ''}`}
                        style={{
                          width: 52, height: 40,
                          background: emptyCell ? '#f9fafb' : (STATUS_COLORS[status] || '#f3f4f6'),
                          border: '1px solid #e5e7eb', borderRadius: 4, display: 'flex',
                          alignItems: 'center', justifyContent: 'center', fontSize: 10,
                          color: emptyCell ? '#d1d5db' : (status === 'absent' ? '#6b7280' : '#fff'),
                        }}
                      >
                        {cell.label}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {records.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 }}>
          <thead>
            <tr>
              {['机房', '座位', '学生', '状态', '时间'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280', fontWeight: 500 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((r: any, i: number) => {
              const lab = labList.find((l: any) => l.id === r.lab_id);
              return (
                <tr key={i}>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12 }}>{lab?.display_name || lab?.name || r.lab_id?.slice(0, 8) || '-'}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>{r.row_idx},{r.col_idx}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>{r.student_name}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>
                    <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: STATUS_COLORS[r.status || 'absent'], color: '#fff' }}>
                      {STATUS_LABELS[r.status || 'absent']}
                    </span>
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, color: '#9ca3af' }}>
                    {r.checked_in_at ? new Date(r.checked_in_at).toLocaleTimeString() : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── 子组件：历史记录 ─────────────────────────────────

function AttendanceHistory({ lessonId: externalLessonId }: { lessonId?: string } = {}) {
  const [internalLessonId, setInternalLessonId] = useState('');
  const lessonId = externalLessonId || internalLessonId;
  const [data, setData] = useState<any>(null);
  const [trend, setTrend] = useState<any[]>([]);
  const [trendOpen, setTrendOpen] = useState(false);
  const [trendLoading, setTrendLoading] = useState(false);

  useEffect(() => {
    if (lessonId) invoke<any>('lab_seat.get_attendance', { lessonId }).then(setData);
  }, [lessonId]);

  const loadTrend = async () => {
    setTrendOpen(true);
    setTrendLoading(true);
    try {
      const r = await invoke<any>('lab_seat.attendance_trend', { sinceDays: 30 });
      setTrend(r?.series || []);
    } finally {
      setTrendLoading(false);
    }
  };

  const records = data?.records || [];

  return (
    <div style={{ padding: 16 }}>
      <h3>历史记录</h3>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
        {!externalLessonId && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>课节 ID</span>
            <input value={internalLessonId} onChange={(e: any) => setInternalLessonId(e.target.value)}
              placeholder="输入 lesson id" style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 220 }} />
          </label>
        )}
        <button
          onClick={async () => {
            const r = await invoke<any>('lab_seat.export_attendance', { lessonId });
            if (r?.csv) downloadCsv(r.filename, r.csv);
          }}
          disabled={!lessonId}
          style={{ padding: '6px 16px', border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer' }}
        >
          导出 CSV
        </button>
        <button
          onClick={loadTrend}
          style={{ padding: '6px 16px', border: '1px solid #d1d5db', borderRadius: 4, background: trendOpen ? '#eef2ff' : '#fff', cursor: 'pointer' }}
        >
          近 30 天到课趋势
        </button>
      </div>

      {trendOpen && (
        <div style={{ marginBottom: 20, padding: 12, background: '#f9fafb', borderRadius: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📈 到课率趋势（按课节）</p>
          {trendLoading ? <p style={{ color: '#9ca3af', fontSize: 12 }}>加载中…</p> : trend.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: 12 }}>近 30 天暂无签到课节</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {trend.slice(0, 15).map((t: any, i: number) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ width: 52, color: '#6b7280', fontSize: 11, whiteSpace: 'nowrap' }}>
                    {new Date(t.openedAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}
                  </span>
                  <div style={{ flex: 1, background: '#e5e7eb', borderRadius: 3, height: 16, overflow: 'hidden', position: 'relative' }}>
                    <div style={{
                      width: `${Math.max(t.attendanceRate, 2)}%`, height: '100%',
                      background: t.attendanceRate >= 80 ? '#22c55e' : t.attendanceRate >= 50 ? '#eab308' : '#ef4444',
                    }} />
                  </div>
                  <span style={{ width: 90, color: '#374151', fontSize: 11 }} title={`到 ${t.present}/${t.total}，迟到 ${t.late}，请假 ${t.leave}`}>
                    {t.attendanceRate}% · {t.present}/{t.total}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {records.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {['学生', '状态', '签到时间', '备注'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280', fontWeight: 500 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((r: any, i: number) => (
              <tr key={i}>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>{r.student_name}</td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6' }}>
                  <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: STATUS_COLORS[r.status || 'absent'], color: '#fff' }}>
                    {STATUS_LABELS[r.status || 'absent']}
                  </span>
                </td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, color: '#9ca3af' }}>
                  {r.checked_in_at ? new Date(r.checked_in_at).toLocaleString() : '-'}
                </td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, color: '#9ca3af' }}>{r.note || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ color: '#9ca3af' }}>{lessonId ? '暂无数据' : '输入课节 ID 查询'}</p>
      )}
    </div>
  );
}

// ── 主组件：teacher.tab ───────────────────────────────

function TeacherLabPanel() {
  const [tab, setTab] = useState('rooms');
  const [currentLessonId, setCurrentLessonId] = useState('');
  const tabs = [
    { id: 'rooms', label: '机房管理' },
    { id: 'assignments', label: '座位分配' },
    { id: 'attendance', label: '考勤看板' },
    { id: 'history', label: '历史记录' },
  ];
  const showLessonPicker = tab !== 'rooms'; // 机房管理不依赖 lessonId

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 16px' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer',
              borderBottom: tab === t.id ? '2px solid #2563eb' : '2px solid transparent',
              color: tab === t.id ? '#2563eb' : '#6b7280', fontWeight: tab === t.id ? 600 : 400, fontSize: 14,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {showLessonPicker && (
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: '#6b7280' }}>课节：</span>
          <LessonPicker
            value={currentLessonId}
            onChange={setCurrentLessonId}
            placeholder="-- 选择课节 --"
            style={{ minWidth: 280 }}
          />
          {currentLessonId && (
            <span title="当前选中的课节 ID" style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>
              ID: {currentLessonId.slice(0, 8)}…
            </span>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* key={currentLessonId} 使 lessonId 变化时子组件重挂载清空 state */}
        {tab === 'rooms' && <RoomEditor key="rooms" onCreated={() => {}} />}
        {tab === 'assignments' && <SeatAssignment key={`assign-${currentLessonId}`} lessonId={currentLessonId} />}
        {tab === 'attendance' && <AttendanceDashboard key={`att-${currentLessonId}`} lessonId={currentLessonId} />}
        {tab === 'history' && <AttendanceHistory key={`hist-${currentLessonId}`} lessonId={currentLessonId} />}
      </div>
    </div>
  );
}

// ── dashboard.widget 卡片 ─────────────────────────────

function DashboardAttendanceWidget() {
  const [summary, setSummary] = useState<any>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const s = await invoke<any>('lab_seat.get_current_lesson_attendance');
        setSummary(s);
      } catch { /* no active session */ }
    };
    load();
    return subscribeToEvents(
      ['lab_seat.student_checked_in', 'lab_seat.check_in_opened', 'lab_seat.attendance_closed'],
      load,
    );
  }, []);

  if (!summary || summary.total === 0) {
    return <div style={{ padding: 12, fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>暂无活跃签到</div>;
  }

  const rate = summary.total > 0 ? Math.round((summary.checked_in + summary.late) / summary.total * 100) : 0;

  return (
    <div style={{ padding: 12, cursor: 'pointer' }} onClick={() => setExpanded(!expanded)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>📊 签到概览</span>
        <span style={{ fontSize: 18, fontWeight: 700, color: rate >= 80 ? '#22c55e' : '#eab308' }}>{rate}%</span>
      </div>
      <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
        <span>✅ {summary.checked_in}</span>
        <span>⚠️ {summary.late}</span>
        <span>🏠 {summary.leave}</span>
        <span>❌ {summary.absent}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
          <p>已到: {summary.checked_in + summary.late} / {summary.total}</p>
          <p>迟到: {summary.late}  请假: {summary.leave}  未到: {summary.absent}</p>
        </div>
      )}
    </div>
  );
}

// ── 学生端座位视图 ────────────────────────────────────

function StudentSeatView(props: { studentId?: string }) {
  const studentId = props.studentId || '';
  const [session, setSession] = useState<any>(null);
  const [seat, setSeat] = useState<any>(null);
  const [attendance, setAttendance] = useState<any>(null);
  const [layout, setLayout] = useState<any>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    if (!studentId) return;
    const s = await invoke<any>('lab_seat.get_active_check_in', { studentId });
    setSession(s);
    if (s) {
      const result = await invoke<any>('lab_seat.get_my_seat', { lessonId: s.lesson_id, studentId });
      setSeat(result?.seat);
      setAttendance(result?.attendance);
      if (result?.seat?.lab_id) {
        const room = await invoke<any>('lab_seat.get_room', { roomId: result.seat.lab_id });
        if (room) setLayout(JSON.parse(room.layout_json));
      }
    }
  }, [studentId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    return subscribeToEvents(
      ['lab_seat.check_in_opened', 'lab_seat.attendance_closed', 'lab_seat.seats_assigned'],
      (event: any) => {
        if (event?.payload?.lessonId && session && event.payload.lessonId === session.lesson_id) load();
      },
    );
  }, [session, load]);

  const handleCheckIn = async () => {
    if (!session) return;
    setMsg('签到中…');
    try {
      const r = await invoke<any>('lab_seat.check_in', { lessonId: session.lesson_id });
      setMsg(`签到成功！(${STATUS_LABELS[r.status]})`);
      setAttendance(r);
    } catch (e: any) { setMsg(humanizeErr(e)); }
  };

  if (!studentId) return <div style={{ padding: 24, color: '#9ca3af' }}>请先登录学生账号</div>;
  if (!session) return <div style={{ padding: 24, color: '#9ca3af' }}>当前无签到活动</div>;

  const isCheckedIn = attendance?.status === 'checked_in' || attendance?.status === 'late';

  return (
    <div style={{ padding: 16, maxWidth: 640, margin: '0 auto' }}>
      <h3 style={{ marginBottom: 16 }}>机房座位</h3>
      {seat ? (
        <div style={{ marginBottom: 16, padding: 12, background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0' }}>
          <p style={{ margin: 0 }}>你的座位：<strong>{seat.lab_name}</strong> — 第 {seat.row_idx + 1} 排第 {seat.col_idx + 1} 座</p>
        </div>
      ) : (
        <p style={{ color: '#f59e0b' }}>你尚未被分配座位</p>
      )}

      {layout && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${layout.cols}, 44px)`, gap: 3, marginBottom: 16 }}>
          {layout.cells.map((cell: any) => {
            const isMine = seat && seat.row_idx === cell.row && seat.col_idx === cell.col;
            return (
              <div key={`${cell.row},${cell.col}`}
                style={{
                  width: 40, height: 34, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: isMine ? 700 : 400,
                  background: isMine ? '#2563eb' : '#f3f4f6',
                  color: isMine ? '#fff' : '#6b7280',
                  border: isMine ? '2px solid #1d4ed8' : '1px solid #e5e7eb',
                }}
              >
                {cell.label}
              </div>
            );
          })}
        </div>
      )}

      {session.status === 'open' && !isCheckedIn && (
        <button
          onClick={handleCheckIn}
          disabled={!!msg}
          style={{ width: '100%', padding: '12px', background: '#22c55e', color: '#fff', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: 'pointer' }}
        >
          确认到达
        </button>
      )}

      {isCheckedIn && (
        <p style={{ textAlign: 'center', color: '#22c55e', fontWeight: 600, marginTop: 12 }}>
          ✅ 已签到 {attendance?.checked_in_at ? new Date(attendance.checked_in_at).toLocaleTimeString() : ''}
        </p>
      )}

      {msg && <p style={{ textAlign: 'center', color: '#6b7280', marginTop: 8 }}>{msg}</p>}
      {session.status === 'ended' && <p style={{ textAlign: 'center', color: '#9ca3af', marginTop: 8 }}>签到已截止</p>}
    </div>
  );
}

// ── classroom.tool 浮动面板 ────────────────────────────

function LabSeatToolPanel() {
  const [visible, setVisible] = useState(false);
  const [summary, setSummary] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [rooms, setRooms] = useState<any[]>([]);
  const [selectedLabId, setSelectedLabId] = useState('');

  const load = async () => {
    const s = await invoke<any>('lab_seat.get_current_lesson_attendance');
    setSummary(s);
    const active = await invoke<any>('lab_seat.get_active_check_in', {});
    setSession(active);
    const r = await invoke<any[]>('lab_seat.list_rooms');
    const roomList = r || [];
    setRooms(roomList);
    setSelectedLabId(prev => {
      if (active?.lab_id && roomList.some(rm => rm.id === active.lab_id)) return active.lab_id;
      if (prev && roomList.some(rm => rm.id === prev)) return prev;
      return roomList[0]?.id || '';
    });
  };

  useEffect(() => {
    if (visible) load();
  }, [visible]);

  useEffect(() => {
    return subscribeToEvents(
      ['lab_seat.student_checked_in', 'lab_seat.check_in_opened'],
      () => { if (visible) load(); },
    );
  }, [visible, load]);

  const toggle = () => { setVisible(!visible); if (!visible) load(); };

  const panel = visible ? (
    <div style={{
      position: 'fixed', top: 80, right: 20, width: 280, background: '#fff', borderRadius: 12,
      boxShadow: '0 4px 24px rgba(0,0,0,0.12)', zIndex: 9999, padding: 16, fontSize: 13,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <strong>机房管理</strong>
        <button onClick={toggle} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: '#6b7280' }}>机房</span>
        {rooms.length > 0 ? (
          <select value={selectedLabId} onChange={(e: any) => setSelectedLabId(e.target.value)}
            style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
          >
            {rooms.map((r: any) => (
              <option key={r.id} value={r.id}>{r.display_name || r.name || r.room_number || r.id}</option>
            ))}
          </select>
        ) : (
          <p style={{ color: '#ef4444', fontSize: 12, margin: 0 }}>尚无机房，请先在“机房管理”创建</p>
        )}
      </label>

      {session
        ? <p style={{ color: '#22c55e', marginBottom: 8 }}>签到进行中</p>
        : <p style={{ color: '#9ca3af', marginBottom: 8 }}>签到未开启</p>
      }

      {summary && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#dcfce7', color: '#16a34a' }}>✅ {summary.checked_in}</span>
          <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#fef9c3', color: '#ca8a04' }}>⚠️ {summary.late}</span>
          <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#dbeafe', color: '#2563eb' }}>🏠 {summary.leave}</span>
          <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#f3f4f6', color: '#6b7280' }}>❌ {summary.absent}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={async () => { await invoke('lab_seat.shuffle_seats', { lessonId: session?.lesson_id }); alert('已重新随机打乱'); }}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer' }}
        >
          🔀 随机重排
        </button>
        <button
          onClick={async () => {
            const r = await invoke<any>('lab_seat.export_attendance', { lessonId: session?.lesson_id });
            if (r?.csv) downloadCsv(r.filename, r.csv);
          }}
          style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer' }}
        >
          📥 导出签到表
        </button>
        <button
          onClick={async () => {
            if (!selectedLabId) { alert('请先选择机房'); return; }
            await invoke('lab_seat.open_check_in', { lessonId: session?.lesson_id, labId: selectedLabId });
            load();
          }}
          disabled={!selectedLabId}
          style={{ padding: '8px', border: '1px solid #22c55e', borderRadius: 6, background: '#f0fdf4', cursor: !selectedLabId ? 'not-allowed' : 'pointer', opacity: !selectedLabId ? 0.5 : 1 }}
        >
          ▶️ 开始签到
        </button>
        <button
          onClick={async () => { await invoke('lab_seat.close_check_in', { lessonId: session?.lesson_id }); load(); }}
          style={{ padding: '8px', border: '1px solid #ef4444', borderRadius: 6, background: '#fef2f2', cursor: 'pointer' }}
        >
          ⏹️ 截止签到
        </button>
      </div>
    </div>
  ) : null;

  if (!ReactDOM) return null;

  const btn = (
    <button
      onClick={toggle} title="机房管理"
      style={{ width: 36, height: 36, border: '1px solid #e5e7eb', borderRadius: 8, background: visible ? '#eff6ff' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}
    >
      🖥
    </button>
  );

  return (
    <>
      {btn}
      {visible && ReactDOM.createPortal(panel, document.body)}
    </>
  );
}

// ── activate / deactivate ──────────────────────────────

async function activate(hostCtx: any) {
  ctx = hostCtx;
  if ((window as any).HostSharedDeps?.ReactDOM) {
    ReactDOM = (window as any).HostSharedDeps.ReactDOM;
  }

  hostCtx.ui.registerExtensionPoint('teacher.tab', {
    id: 'lab-seat-tab',
    label: '机房座位',
    icon: 'Monitor',
    component: TeacherLabPanel,
    position: 50,
    group: 'management',
  });

  hostCtx.ui.registerExtensionPoint('teacher.dashboard.widget', {
    id: 'lab-seat-attendance-card',
    label: '签到概览',
    icon: 'Monitor',
    component: DashboardAttendanceWidget,
    position: 50,
    group: 'teaching',
  });

  hostCtx.ui.registerExtensionPoint('student.view', {
    id: 'lab-seat-student-view',
    label: '机房座位',
    icon: 'Monitor',
    component: StudentSeatView,
    position: 50,
    group: 'teaching',
  });

  hostCtx.ui.registerExtensionPoint('classroom.tool', {
    id: 'lab-seat-tool-panel',
    label: '机房管理',
    icon: 'Monitor',
    component: LabSeatToolPanel,
    position: 50,
    group: 'teaching',
  });
}

function deactivate() {}

export default { activate, deactivate };