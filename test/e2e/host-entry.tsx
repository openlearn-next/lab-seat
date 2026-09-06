/**
 * E2E mock-host 入口：把插件 frontend + React 打包成浏览器可执行 ESM。
 * 构造一个最小 hostCtx（ui.registerExtensionPoint 收集、invokeCommand 返回内存假数据），
 * activate 插件后从收集到的槽位渲染 TeacherLabPanel 到 #root。
 *
 * 本文件只在 E2E 时由 esbuild 打包；不参与生产构建（src/ 下不会被 src/index.ts 引用）。
 */

import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import plugin from '../../src/frontend';

// 注入 HostSharedDeps（插件 activate 时可能读取 ReactDOM 做 portal）
const dep = {
  React,
  ReactDOM: { createRoot: ReactDOM.createRoot, createPortal: (el: any, box: any) => (box ? el : null) },
};
(window as any).HostSharedDeps = dep;

// ── mock host ctx ───────────────────────────────────────────────
const slots: Array<{ slot: string; config: any }> = [];
let mockDb: any = {
  rooms: [{ id: 'lab-1', room_number: '410', name: 'A410', display_name: 'A410', rows: 2, cols: 3, created_at: Date.now(), updated_at: Date.now() }],
  lessons: [
    { id: 'lesson-live', name: '今日机房课', status: 'live', started_at: Date.now() },
    { id: 'lesson-old', name: '上周课', status: 'ended', started_at: Date.now() - 86400000 },
  ],
};

const hostCtx: any = {
  pluginId: '@aymwoo/plugin-lab-seat',
  invokeCommand: async (type: string, payload?: any) => {
    console.log('[mock invokeCommand]', type, payload);
    switch (type) {
      case 'lab_seat.list_rooms': return mockDb.rooms;
      case 'lab_seat.list_lessons': return mockDb.lessons;
      case 'lab_seat.list_lesson_labs': return mockDb.rooms.map(r => ({ ...r, assigned_count: 0 }));
      case 'lab_seat.get_room': return mockDb.rooms.find(r => r.id === payload?.roomId) || null;
      case 'lab_seat.get_assignments': return [];
      case 'lab_seat.get_attendance': return { records: [], summary: { checked_in: 0, late: 0, leave: 0, absent: 0, total: 0 } };
      case 'lab_seat.attendance_trend': return { series: [] };
      case 'lab_seat.get_current_lesson_attendance': return null;
      case 'lab_seat.get_active_check_in': return null;
      case 'lab_seat.list_templates': return [];
      default: return null;
    }
  },
  ui: {
    registerExtensionPoint: (slot: string, config: any) => { slots.push({ slot, config }); },
    unregisterExtensionPoint: () => {},
  },
  services: {},
};

// ── activate + render ────────────────────────────────────────────
async function boot() {
  await plugin.activate(hostCtx);
  const tabSlot = slots.find(s => s.slot === 'teacher.tab');
  if (!tabSlot) { document.body.innerHTML = '<div id="err">teacher.tab 未注册</div>'; return; }
  const root = document.getElementById('root')!;
  const Comp = tabSlot.config.component;
  ReactDOM.createRoot(root).render(React.createElement(Comp));
}

(window as any).__labSeatBoot = boot;
boot();
