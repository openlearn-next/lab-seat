import React, { useState, useEffect, useCallback, useRef } from 'react';

// 模块级 FrontendPluginContext
let ctx: any = null;
let ReactDOM: any = null;

// ── 工具函数 ──────────────────────────────────────────
function usePluginCtx() {
  const host = (window as any).HostSharedDeps;
  if (host?.ReactDOM) ReactDOM = host.ReactDOM;
  const [ready, setReady] = useState(!!ctx);
  useEffect(() => {
    if (ctx) setReady(true);
  }, []);
  return ready ? ctx : null;
}

async function invoke<T = any>(type: string, payload?: any): Promise<T> {
  if (!ctx) throw new Error('Plugin not activated');
  return ctx.invokeCommand(type, payload);
}

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

// ── 子组件：机房布局编辑器 ───────────────────────────
function RoomEditor({ onCreated }: { onCreated: () => void }) {
  const [rooms, setRooms] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [rows, setRows] = useState(5);
  const [cols, setCols] = useState(8);

  const load = useCallback(async () => {
    const r = await invoke<any[]>('lab_seat.list_rooms');
    setRooms(r || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!name) return;
    await invoke('lab_seat.create_room', { name, rows, cols });
    setName(''); setShowForm(false);
    load(); onCreated();
  };

  return React.createElement('div', { style: { padding: 16 } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 16 } },
      React.createElement('h3', { style: { margin: 0 } }, '机房列表'),
      React.createElement('button', {
        onClick: () => setShowForm(!showForm),
        style: { padding: '6px 16px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer' },
      }, showForm ? '取消' : '+ 新建机房'),
    ),
    showForm ? React.createElement('div', {
      style: { background: '#f9fafb', padding: 16, borderRadius: 8, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
    },
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: { fontSize: 13, color: '#6b7280' } }, '名称'),
        React.createElement('input', { value: name, onChange: (e: any) => setName(e.target.value), placeholder: '如 A101', style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 100 } }),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: { fontSize: 13, color: '#6b7280' } }, '行数'),
        React.createElement('input', { type: 'number', value: rows, min: 1, max: 20, onChange: (e: any) => setRows(Number(e.target.value)), style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 60 } }),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: { fontSize: 13, color: '#6b7280' } }, '列数'),
        React.createElement('input', { type: 'number', value: cols, min: 1, max: 20, onChange: (e: any) => setCols(Number(e.target.value)), style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 60 } }),
      ),
      React.createElement('button', {
        onClick: handleCreate,
        style: { padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' },
      }, '创建'),
    ) : null,
    React.createElement('div', { style: { display: 'grid', gap: 8 } },
      rooms.map((r: any) => React.createElement('div', {
        key: r.id, style: { padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
      },
        React.createElement('span', null, r.name, ' ', React.createElement('span', { style: { color: '#9ca3af', fontSize: 13 } }, `${r.rows}×${r.cols}`)),
        React.createElement('span', { style: { fontSize: 12, color: '#9ca3af' } }, new Date(r.created_at).toLocaleDateString()),
      )),
      rooms.length === 0 ? React.createElement('p', { style: { color: '#9ca3af' } }, '暂无机房') : null,
    ),
  );
}

// ── 子组件：座位分配 ──────────────────────────────────
function SeatAssignment() {
  const [rooms, setRooms] = useState<any[]>([]);
  const [selectedLab, setSelectedLab] = useState('');
  const [lessonId, setLessonId] = useState('');
  const [strategy, setStrategy] = useState('random');
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [assignments, setAssignments] = useState<any[]>([]);
  const [layout, setLayout] = useState<any>(null);
  const [dragMsg, setDragMsg] = useState('');
  const [attendance, setAttendance] = useState<any>(null);

  useEffect(() => {
    invoke<any[]>('lab_seat.list_rooms').then(r => setRooms(r || []));
  }, []);

  useEffect(() => {
    if (selectedLab) {
      invoke<any[]>('lab_seat.list_templates', { labId: selectedLab }).then(t => setTemplates(t || []));
    }
  }, [selectedLab]);

  const handleAssign = async () => {
    if (!lessonId || !selectedLab) return;
    setDragMsg('分配中…');
    await invoke('lab_seat.assign_seats', {
      lessonId, labId: selectedLab,
      strategy: selectedTemplate ? undefined : strategy,
      templateId: selectedTemplate || undefined,
    });
    await loadAssignments();
    setDragMsg('');
  };

  const loadAssignments = async () => {
    if (!lessonId) return;
    const [asgn, room] = await Promise.all([
      invoke<any[]>('lab_seat.get_assignments', { lessonId }),
      selectedLab ? invoke<any>('lab_seat.get_room', { roomId: selectedLab }) : Promise.resolve(null),
    ]);
    setAssignments(asgn || []);
    if (room) setLayout(JSON.parse(room.layout_json));
    // 同时拉考勤
    if (lessonId) {
      invoke<any>('lab_seat.get_attendance', { lessonId }).then(a => setAttendance(a));
    }
  };

  useEffect(() => {
    if (lessonId) loadAssignments();
  }, [lessonId]);

  const handleDragStart = (e: any, studentId: string) => {
    e.dataTransfer.setData('text/plain', studentId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = async (e: any, row: number, col: number) => {
    e.preventDefault();
    const studentId = e.dataTransfer.getData('text/plain');
    await invoke('lab_seat.move_student', { lessonId, studentId, rowIdx: row, colIdx: col });
    loadAssignments();
  };

  const occupyMap = new Map<string, string>();
  assignments.forEach((a: any) => occupyMap.set(`${a.row_idx},${a.col_idx}`, a.student_name));

  return React.createElement('div', { style: { padding: 16 } },
    React.createElement('h3', null, '座位分配'),
    React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' } },
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: { fontSize: 13, color: '#6b7280' } }, '课节 ID'),
        React.createElement('input', { value: lessonId, onChange: (e: any) => setLessonId(e.target.value), placeholder: '输入 lesson id', style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 220 } }),
      ),
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: { fontSize: 13, color: '#6b7280' } }, '机房'),
        React.createElement('select', { value: selectedLab, onChange: (e: any) => setSelectedLab(e.target.value), style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 } },
          React.createElement('option', { value: '' }, '-- 选择 --'),
          rooms.map((r: any) => React.createElement('option', { key: r.id, value: r.id }, r.name)),
        ),
      ),
      templates.length > 0 ? React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: { fontSize: 13, color: '#6b7280' } }, '模板（可选）'),
        React.createElement('select', { value: selectedTemplate, onChange: (e: any) => setSelectedTemplate(e.target.value), style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 } },
          React.createElement('option', { value: '' }, '自动分配'),
          templates.map((t: any) => React.createElement('option', { key: t.id, value: t.id }, t.name)),
        ),
      ) : null,
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: { fontSize: 13, color: '#6b7280' } }, '策略'),
        React.createElement('select', { value: strategy, onChange: (e: any) => setStrategy(e.target.value), style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 } },
          React.createElement('option', { value: 'random' }, '随机打散'),
          React.createElement('option', { value: 'sequential' }, '按学号顺序'),
          React.createElement('option', { value: 'grouped' }, '按小组聚集'),
        ),
      ),
      React.createElement('button', {
        onClick: handleAssign, disabled: !lessonId || !selectedLab,
        style: { padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', opacity: (!lessonId || !selectedLab) ? 0.5 : 1 },
      }, '分配座位'),
    ),
    dragMsg ? React.createElement('p', { style: { color: '#6b7280', fontSize: 13 } }, dragMsg) : null,

    layout ? React.createElement('div', { style: { marginTop: 16 } },
      React.createElement('p', { style: { fontSize: 13, color: '#6b7280', marginBottom: 8 } }, '座位网格（拖拽学生到目标座位）'),
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: `repeat(${layout.cols}, 64px)`, gap: 4, marginBottom: 8 },
      },
        layout.cells.map((cell: any) => {
          const key = `${cell.row},${cell.col}`;
          const student = occupyMap.get(key);
          const attStatus = attendance?.records?.find((r: any) => r.row_idx === cell.row && r.col_idx === cell.col)?.status;
          const bg = student ? (attStatus ? STATUS_COLORS[attStatus] : '#dbeafe') : '#f3f4f6';
          return React.createElement('div', {
            key, 'data-row': cell.row, 'data-col': cell.col,
            onDragOver: (e: any) => e.preventDefault(),
            onDrop: (e: any) => handleDrop(e, cell.row, cell.col),
            style: {
              width: 60, height: 48, border: '1px solid #d1d5db', borderRadius: 4, background: bg,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, cursor: 'pointer', overflow: 'hidden',
            },
          },
            React.createElement('span', { style: { fontWeight: 600 } }, cell.label),
            student ? React.createElement('span', { style: { fontSize: 10, color: '#374151', maxWidth: 56, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, student) : null,
          );
        }),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 16, fontSize: 12, color: '#6b7280' } },
        React.createElement('span', null, React.createElement('span', { style: { display: 'inline-block', width: 12, height: 12, background: '#22c55e', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' } }), '已签到'),
        React.createElement('span', null, React.createElement('span', { style: { display: 'inline-block', width: 12, height: 12, background: '#eab308', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' } }), '迟到'),
        React.createElement('span', null, React.createElement('span', { style: { display: 'inline-block', width: 12, height: 12, background: '#3b82f6', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' } }), '请假'),
        React.createElement('span', null, React.createElement('span', { style: { display: 'inline-block', width: 12, height: 12, background: '#9ca3af', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' } }), '未签到'),
      ),
    ) : null,

    assignments.length > 0 ? React.createElement('div', { style: { marginTop: 16 } },
      React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
        React.createElement('button', {
          onClick: async () => {
            if (!selectedLab) return;
            const name = prompt('模板名称：');
            if (name) {
              await invoke('lab_seat.save_template', { lessonId, labId: selectedLab, name });
              invoke<any[]>('lab_seat.list_templates', { labId: selectedLab }).then(t => setTemplates(t || []));
            }
          },
          style: { padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer', fontSize: 12 },
        }, '保存为模板'),
        React.createElement('button', {
          onClick: async () => { await invoke('lab_seat.open_check_in', { lessonId, labId: selectedLab }); },
          style: { padding: '4px 12px', border: '1px solid #22c55e', borderRadius: 4, background: '#f0fdf4', cursor: 'pointer', fontSize: 12 },
        }, '开启签到'),
        React.createElement('button', {
          onClick: async () => { await invoke('lab_seat.close_check_in', { lessonId }); },
          style: { padding: '4px 12px', border: '1px solid #ef4444', borderRadius: 4, background: '#fef2f2', cursor: 'pointer', fontSize: 12 },
        }, '截止签到'),
      ),
      React.createElement('p', { style: { fontSize: 12, color: '#6b7280' } }, `已分配 ${assignments.length} 名学生`),
      React.createElement('div', { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
        assignments.map((a: any) => React.createElement('div', {
          key: a.student_id, draggable: true,
          onDragStart: (e: any) => handleDragStart(e, a.student_id),
          style: { padding: '4px 8px', background: '#f3f4f6', borderRadius: 4, fontSize: 12, cursor: 'grab', border: '1px solid #e5e7eb' },
        }, a.student_name)),
      ),
    ) : null,
  );
}

// ── 子组件：考勤看板 ──────────────────────────────────
function AttendanceDashboard() {
  const [lessonId, setLessonId] = useState('');
  const [data, setData] = useState<any>(null);
  const [layout, setLayout] = useState<any>(null);

  const load = async () => {
    if (!lessonId) return;
    const result = await invoke<any>('lab_seat.get_attendance', { lessonId });
    setData(result);
    // 尝试获取机房布局
    const asgns = await invoke<any[]>('lab_seat.get_assignments', { lessonId });
    if (asgns && asgns.length > 0) {
      const room = await invoke<any>('lab_seat.get_room', { roomId: asgns[0].lab_id });
      if (room) setLayout(JSON.parse(room.layout_json));
    }
  };

  useEffect(() => { if (lessonId) load(); }, [lessonId]);

  const records = data?.records || [];
  const summary = data?.summary || { checked_in: 0, late: 0, leave: 0, absent: 0, total: 0 };

  return React.createElement('div', { style: { padding: 16 } },
    React.createElement('h3', null, '考勤看板'),
    React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 16, alignItems: 'flex-end' } },
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: { fontSize: 13, color: '#6b7280' } }, '课节 ID'),
        React.createElement('input', { value: lessonId, onChange: (e: any) => setLessonId(e.target.value), placeholder: '输入 lesson id', style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 220 } }),
      ),
      React.createElement('button', {
        onClick: load, disabled: !lessonId,
        style: { padding: '6px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' },
      }, '查询'),
    ),
    summary.total > 0 ? React.createElement('div', { style: { display: 'flex', gap: 16, marginBottom: 16 } },
      React.createElement(StatBadge, { color: '#22c55e', label: '已签到', count: summary.checked_in }),
      React.createElement(StatBadge, { color: '#eab308', label: '迟到', count: summary.late }),
      React.createElement(StatBadge, { color: '#3b82f6', label: '请假', count: summary.leave }),
      React.createElement(StatBadge, { color: '#9ca3af', label: '未签到', count: summary.absent }),
      React.createElement(StatBadge, { color: '#6b7280', label: '总计', count: summary.total }),
    ) : null,
    layout ? React.createElement('div', {
      style: { display: 'grid', gridTemplateColumns: `repeat(${layout.cols}, 56px)`, gap: 3 },
    },
      layout.cells.map((cell: any) => {
        const rec = records.find((r: any) => r.row_idx === cell.row && r.col_idx === cell.col);
        const status = rec?.status || 'absent';
        return React.createElement('div', {
          key: `${cell.row},${cell.col}`,
          title: `${cell.label}${rec ? ': ' + rec.student_name + ' - ' + STATUS_LABELS[status] : ''}`,
          style: {
            width: 52, height: 40, background: STATUS_COLORS[status] || '#f3f4f6',
            border: '1px solid #e5e7eb', borderRadius: 4, display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 10, color: status === 'absent' ? '#6b7280' : '#fff',
          },
        }, cell.label);
      }),
    ) : null,
    records.length > 0 ? React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 } },
      React.createElement('thead', null,
        React.createElement('tr', null,
          ['座位', '学生', '状态', '时间'].map(h => React.createElement('th', { key: h, style: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280', fontWeight: 500 } }, h)),
        ),
      ),
      React.createElement('tbody', null,
        records.map((r: any, i: number) => React.createElement('tr', { key: i },
          React.createElement('td', { style: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6' } }, `${r.row_idx},${r.col_idx}`),
          React.createElement('td', { style: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6' } }, r.student_name),
          React.createElement('td', { style: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6' } },
            React.createElement('span', { style: { padding: '2px 6px', borderRadius: 4, fontSize: 11, background: STATUS_COLORS[r.status || 'absent'], color: '#fff' } }, STATUS_LABELS[r.status || 'absent']),
          ),
          React.createElement('td', { style: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, color: '#9ca3af' } },
            r.checked_in_at ? new Date(r.checked_in_at).toLocaleTimeString() : '-',
          ),
        )),
      ),
    ) : null,
  );
}

function StatBadge({ color, label, count }: { color: string; label: string; count: number }) {
  return React.createElement('div', {
    style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' },
  },
    React.createElement('div', { style: { width: 10, height: 10, borderRadius: '50%', background: color } }),
    React.createElement('span', { style: { fontSize: 12, color: '#6b7280' } }, label),
    React.createElement('span', { style: { fontWeight: 700, fontSize: 16 } }, String(count)),
  );
}

// ── 子组件：历史记录 ──────────────────────────────────
function AttendanceHistory() {
  const [lessonId, setLessonId] = useState('');
  const [data, setData] = useState<any>(null);

  useEffect(() => { if (lessonId) invoke<any>('lab_seat.get_attendance', { lessonId }).then(setData); }, [lessonId]);
  const records = data?.records || [];

  return React.createElement('div', { style: { padding: 16 } },
    React.createElement('h3', null, '历史记录'),
    React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 16, alignItems: 'flex-end' } },
      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: { fontSize: 13, color: '#6b7280' } }, '课节 ID'),
        React.createElement('input', { value: lessonId, onChange: (e: any) => setLessonId(e.target.value), placeholder: '输入 lesson id', style: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, width: 220 } }),
      ),
      React.createElement('button', {
        onClick: async () => { const r = await invoke<any>('lab_seat.export_attendance', { lessonId }); if (r?.csv && ctx?.services?.uiService) { ctx.services.uiService.downloadFile(r.csv, r.filename, 'text/csv'); } },
        disabled: !lessonId,
        style: { padding: '6px 16px', border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer' },
      }, '导出 CSV'),
    ),
    records.length > 0 ? React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
      React.createElement('thead', null,
        React.createElement('tr', null,
          ['学生', '状态', '签到时间', '备注'].map(h => React.createElement('th', { key: h, style: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280', fontWeight: 500 } }, h)),
        ),
      ),
      React.createElement('tbody', null,
        records.map((r: any, i: number) => React.createElement('tr', { key: i },
          React.createElement('td', { style: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6' } }, r.student_name),
          React.createElement('td', { style: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6' } },
            React.createElement('span', { style: { padding: '2px 6px', borderRadius: 4, fontSize: 11, background: STATUS_COLORS[r.status || 'absent'], color: '#fff' } }, STATUS_LABELS[r.status || 'absent']),
          ),
          React.createElement('td', { style: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, color: '#9ca3af' } },
            r.checked_in_at ? new Date(r.checked_in_at).toLocaleString() : '-',
          ),
          React.createElement('td', { style: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, color: '#9ca3af' } }, r.note || '-'),
        )),
      ),
    ) : React.createElement('p', { style: { color: '#9ca3af' } }, lessonId ? '暂无数据' : '输入课节 ID 查询'),
  );
}

// ── 主组件：teacher.tab ───────────────────────────────
function TeacherLabPanel() {
  const [tab, setTab] = useState('rooms');
  const tabs = [
    { id: 'rooms', label: '机房管理' },
    { id: 'assignments', label: '座位分配' },
    { id: 'attendance', label: '考勤看板' },
    { id: 'history', label: '历史记录' },
  ];

  return React.createElement('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
    React.createElement('div', { style: { display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 16px' } },
      tabs.map(t => React.createElement('button', {
        key: t.id,
        onClick: () => setTab(t.id),
        style: {
          padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer',
          borderBottom: tab === t.id ? '2px solid #2563eb' : '2px solid transparent',
          color: tab === t.id ? '#2563eb' : '#6b7280', fontWeight: tab === t.id ? 600 : 400, fontSize: 14,
        },
      }, t.label)),
    ),
    React.createElement('div', { style: { flex: 1, overflow: 'auto' } },
      tab === 'rooms' ? React.createElement(RoomEditor, { onCreated: () => {} }) :
      tab === 'assignments' ? React.createElement(SeatAssignment) :
      tab === 'attendance' ? React.createElement(AttendanceDashboard) :
      React.createElement(AttendanceHistory),
    ),
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
    if (ctx?.services?.socketService) {
      const handler = () => load();
      ctx.services.socketService.on('lab_seat.student_checked_in', handler);
      ctx.services.socketService.on('lab_seat.check_in_opened', handler);
      ctx.services.socketService.on('lab_seat.attendance_closed', handler);
      return () => {
        ctx.services.socketService.off('lab_seat.student_checked_in', handler);
        ctx.services.socketService.off('lab_seat.check_in_opened', handler);
        ctx.services.socketService.off('lab_seat.attendance_closed', handler);
      };
    }
  }, []);

  if (!summary || summary.total === 0) {
    return React.createElement('div', { style: { padding: 12, fontSize: 12, color: '#9ca3af', textAlign: 'center' } }, '暂无活跃签到');
  }

  const rate = summary.total > 0 ? Math.round((summary.checked_in + summary.late) / summary.total * 100) : 0;

  return React.createElement('div', { style: { padding: 12, cursor: 'pointer' }, onClick: () => setExpanded(!expanded) },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
      React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, '📊 签到概览'),
      React.createElement('span', { style: { fontSize: 18, fontWeight: 700, color: rate >= 80 ? '#22c55e' : '#eab308' } }, `${rate}%`),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 8, fontSize: 11 } },
      React.createElement('span', null, '✅', summary.checked_in),
      React.createElement('span', null, '⚠️', summary.late),
      React.createElement('span', null, '🏠', summary.leave),
      React.createElement('span', null, '❌', summary.absent),
    ),
    expanded ? React.createElement('div', { style: { marginTop: 8, fontSize: 11, color: '#6b7280' } },
      React.createElement('p', null, `已到: ${summary.checked_in + summary.late} / ${summary.total}`),
      React.createElement('p', null, `迟到: ${summary.late}  请假: ${summary.leave}  未到: ${summary.absent}`),
    ) : null,
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

  // 监听签到事件
  useEffect(() => {
    if (!ctx?.services?.socketService) return;
    const handler = (event: any) => {
      if (event?.payload?.lessonId && session && event.payload.lessonId === session.lesson_id) load();
    };
    ctx.services.socketService.on('lab_seat.check_in_opened', handler);
    ctx.services.socketService.on('lab_seat.attendance_closed', handler);
    ctx.services.socketService.on('lab_seat.seats_assigned', handler);
    return () => {
      ctx.services.socketService.off('lab_seat.check_in_opened', handler);
      ctx.services.socketService.off('lab_seat.attendance_closed', handler);
      ctx.services.socketService.off('lab_seat.seats_assigned', handler);
    };
  }, [session]);

  const handleCheckIn = async () => {
    if (!session) return;
    setMsg('签到中…');
    try {
      const r = await invoke<any>('lab_seat.check_in', { lessonId: session.lesson_id });
      setMsg(`签到成功！(${STATUS_LABELS[r.status]})`);
      setAttendance(r);
    } catch (e: any) { setMsg(e.message || '签到失败'); }
  };

  if (!studentId) return React.createElement('div', { style: { padding: 24, color: '#9ca3af' } }, '请先登录学生账号');
  if (!session) return React.createElement('div', { style: { padding: 24, color: '#9ca3af' } }, '当前无签到活动');

  const isCheckedIn = attendance?.status === 'checked_in' || attendance?.status === 'late';

  return React.createElement('div', { style: { padding: 16, maxWidth: 640, margin: '0 auto' } },
    React.createElement('h3', { style: { marginBottom: 16 } }, '机房座位'),
    seat ? React.createElement('div', { style: { marginBottom: 16, padding: 12, background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0' } },
      React.createElement('p', { style: { margin: 0 } }, '你的座位：', React.createElement('strong', null, seat.lab_name), ' — 第 ', seat.row_idx + 1, ' 排第 ', seat.col_idx + 1, ' 座'),
    ) : React.createElement('p', { style: { color: '#f59e0b' } }, '你尚未被分配座位'),
    layout ? React.createElement('div', {
      style: { display: 'grid', gridTemplateColumns: `repeat(${layout.cols}, 44px)`, gap: 3, marginBottom: 16 },
    },
      layout.cells.map((cell: any) => {
        const isMine = seat && seat.row_idx === cell.row && seat.col_idx === cell.col;
        return React.createElement('div', {
          key: `${cell.row},${cell.col}`,
          style: {
            width: 40, height: 34, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: isMine ? 700 : 400,
            background: isMine ? '#2563eb' : '#f3f4f6',
            color: isMine ? '#fff' : '#6b7280',
            border: isMine ? '2px solid #1d4ed8' : '1px solid #e5e7eb',
          },
        }, cell.label);
      }),
    ) : null,
    session.status === 'open' && !isCheckedIn ? React.createElement('button', {
      onClick: handleCheckIn,
      disabled: !!msg,
      style: { width: '100%', padding: '12px', background: '#22c55e', color: '#fff', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: 'pointer' },
    }, '确认到达') : null,
    isCheckedIn ? React.createElement('p', { style: { textAlign: 'center', color: '#22c55e', fontWeight: 600, marginTop: 12 } }, '✅ 已签到 ', attendance?.checked_in_at ? new Date(attendance.checked_in_at).toLocaleTimeString() : '') : null,
    msg ? React.createElement('p', { style: { textAlign: 'center', color: '#6b7280', marginTop: 8 } }, msg) : null,
    session.status === 'ended' ? React.createElement('p', { style: { textAlign: 'center', color: '#9ca3af', marginTop: 8 } }, '签到已截止') : null,
  );
}

// ── classroom.tool 浮动面板 ────────────────────────────
function LabSeatToolPanel() {
  const [visible, setVisible] = useState(false);
  const [summary, setSummary] = useState<any>(null);
  const [session, setSession] = useState<any>(null);

  const load = async () => {
    const s = await invoke<any>('lab_seat.get_current_lesson_attendance');
    setSummary(s);
    const active = await invoke<any>('lab_seat.get_active_check_in', {});
    setSession(active);
  };

  useEffect(() => {
    if (visible) load();
  }, [visible]);

  useEffect(() => {
    if (!ctx?.services?.socketService) return;
    const handler = () => { if (visible) load(); };
    ctx.services.socketService.on('lab_seat.student_checked_in', handler);
    ctx.services.socketService.on('lab_seat.check_in_opened', handler);
    return () => {
      ctx.services.socketService.off('lab_seat.student_checked_in', handler);
      ctx.services.socketService.off('lab_seat.check_in_opened', handler);
    };
  }, [visible]);

  const toggle = () => { setVisible(!visible); if (!visible) load(); };

  const panel = visible ? React.createElement('div', {
    style: {
      position: 'fixed', top: 80, right: 20, width: 280, background: '#fff', borderRadius: 12,
      boxShadow: '0 4px 24px rgba(0,0,0,0.12)', zIndex: 9999, padding: 16, fontSize: 13,
    },
  },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
      React.createElement('strong', null, '机房管理'),
      React.createElement('button', { onClick: toggle, style: { border: 'none', background: 'none', cursor: 'pointer', fontSize: 16 } }, '✕'),
    ),
    session ? React.createElement('p', { style: { color: '#22c55e', marginBottom: 8 } }, '签到进行中') :
      React.createElement('p', { style: { color: '#9ca3af', marginBottom: 8 } }, '签到未开启'),
    summary ? React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' } },
      React.createElement('span', { style: { padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#dcfce7', color: '#16a34a' } }, `✅ ${summary.checked_in}`),
      React.createElement('span', { style: { padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#fef9c3', color: '#ca8a04' } }, `⚠️ ${summary.late}`),
      React.createElement('span', { style: { padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#dbeafe', color: '#2563eb' } }, `🏠 ${summary.leave}`),
      React.createElement('span', { style: { padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#f3f4f6', color: '#6b7280' } }, `❌ ${summary.absent}`),
    ) : null,
    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      React.createElement('button', {
        onClick: async () => { await invoke('lab_seat.shuffle_seats', { lessonId: session?.lesson_id }); alert('已重新随机打乱'); },
        style: { padding: '8px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer' },
      }, '🔀 随机重排'),
      React.createElement('button', {
        onClick: async () => { const r = await invoke<any>('lab_seat.export_attendance', { lessonId: session?.lesson_id }); if (r?.csv && ctx?.services?.uiService) { ctx.services.uiService.downloadFile(r.csv, r.filename, 'text/csv'); } },
        style: { padding: '8px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer' },
      }, '📥 导出签到表'),
      React.createElement('button', {
        onClick: async () => { await invoke('lab_seat.open_check_in', { lessonId: session?.lesson_id }); load(); },
        style: { padding: '8px', border: '1px solid #22c55e', borderRadius: 6, background: '#f0fdf4', cursor: 'pointer' },
      }, '▶️ 开始签到'),
      React.createElement('button', {
        onClick: async () => { await invoke('lab_seat.close_check_in', { lessonId: session?.lesson_id }); load(); },
        style: { padding: '8px', border: '1px solid #ef4444', borderRadius: 6, background: '#fef2f2', cursor: 'pointer' },
      }, '⏹️ 截止签到'),
    ),
  ) : null;

  if (!ReactDOM) return null;

  const btn = React.createElement('button', {
    onClick: toggle,
    title: '机房管理',
    style: { width: 36, height: 36, border: '1px solid #e5e7eb', borderRadius: 8, background: visible ? '#eff6ff' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 },
  }, '🖥');

  return React.createElement('div', null,
    btn,
    visible ? ReactDOM.createPortal(panel, document.body) : null,
  );
}

// ── activate ──────────────────────────────────────────
async function activate(hostCtx: any) {
  ctx = hostCtx;
  if ((window as any).HostSharedDeps?.ReactDOM) {
    ReactDOM = (window as any).HostSharedDeps.ReactDOM;
  }

  // teacher.tab
  hostCtx.ui.registerExtensionPoint('teacher.tab', {
    id: 'lab-seat-tab',
    label: '机房座位',
    icon: 'Monitor',
    component: TeacherLabPanel,
    position: 50,
    group: 'management',
  });

  // teacher.dashboard.widget
  hostCtx.ui.registerExtensionPoint('teacher.dashboard.widget', {
    id: 'lab-seat-attendance-card',
    label: '签到概览',
    icon: 'Monitor',
    component: DashboardAttendanceWidget,
    position: 50,
    group: 'teaching',
  });

  // student.view
  hostCtx.ui.registerExtensionPoint('student.view', {
    id: 'lab-seat-student-view',
    label: '机房座位',
    icon: 'Monitor',
    component: StudentSeatView,
    position: 50,
    group: 'teaching',
  });

  // classroom.tool — 仅挂载浮动面板触发器
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
