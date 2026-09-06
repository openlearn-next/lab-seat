# Roadmap — openlearn-plugin-lab-seat

> **Plugin**: `openlearn-plugin-lab-seat` (机房座位管理)
> **Current version**: 0.5.0
> **Last audit**: 2026-09-06
> **Target SDK**: `@openlearn/plugin-sdk@^3.5.2`

本文档基于 2026-08-29 版本 OpenLearn V2 文档（缓存命中：`references/.cache-meta.json` → `lastUpdated: 2026-08-29`）编写，描述从 0.3.0 起的下一步优化方向。

---

## 0. 当前架构速览

```
┌─────────────────────────────────────────────────────────────┐
│  src/index.ts  (服务端 Worker runtime)                       │
│  ├── manifest: 5 张 plugin 表 + 平台 computer_labs 表       │
│  ├── 11 个 command handlers (lab_seat.*)                    │
│  ├── 4 个 AI actions (assign_seats / check_in / ...)        │
│  ├── 1 个跨插件服务 (ILabSeatService)                        │
│  └── 1 个 EventBus 订阅 (积分联动)                          │
├─────────────────────────────────────────────────────────────┤
│  src/frontend.tsx (React 前端)                               │
│  ├── teacher.tab: TeacherLabPanel (4 个子 Tab)              │
│  ├── teacher.dashboard.widget: DashboardAttendanceWidget    │
│  ├── student.view: StudentSeatView                          │
│  └── classroom.tool: LabSeatToolPanel (浮动面板)            │
├─────────────────────────────────────────────────────────────┤
│  docs/extracted-from-host/PluginCenter.tsx                   │
│  宿主提取的参考代码（不再 build）                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. P0：必须先解决（阻塞性问题）

### 1.1 SDK inline bug 导致服务端 bundle 体积膨胀

**现状**：构建产物 `dist/index.js` 7.6 MB（仅服务端代码），远高于正常 plugin 的 100-300 KB。原因：`@openlearn/plugin-sdk@3.5.2` 的 `cli.mjs` 在 `onResolve` 钩子中把 `@openlearn/plugin-sdk` 解析为本地绝对路径，**优先级高于** `external: ['@openlearn/plugin-sdk']`，esbuild 把整个 SDK 源（含 PluginDistributionManager / ConfigService / Logger / EventBus 内部实现 + pino + uuid + express + jszip + semver）inline 进 plugin bundle。

**影响**：
- 加载慢：plugin zip 从 250 KB 增至 7.6 MB
- 解析慢：Worker runtime 启动 plugin 时 parse + eval 7.6 MB 代码
- 内存大：每个 plugin 副本独占一份 SDK 内存

**短期 workaround**（已在本版本实施）：把 `pino` / `uuid` / `express` / `jszip` / `semver` 列入 `devDependencies`，让 inline 解析不报错。Bundle 大小不变。

**中期根治**：向 SDK 仓库（`aymwoo/OpenLearn-Next-V2`）提 Issue / PR：
- `cli.mjs` 的 `onResolve` 回调应返回 `{ path: sdkDist, external: true }`，让 esbuild 既标记 external 又使用本地路径作为解析入口
- 进一步：SDK 应该把 types + DI tokens（轻量客户端）与 plugin-runtime（重型服务端）拆分为两个入口；plugin 应该只引用客户端入口
- **owner**: SDK 维护方（本 plugin 作者可协助提 PR）

**plugin 侧追踪**：在每个版本 CHANGELOG 的 Known Issues 中保留此条目直至 SDK 修复。

### 1.2 兼容性测试：host worker 模式 ✅ 0.4.0 已交付（worker harness）

**现状**：插件尚未系统化测试三种加载模式。当前 PluginCenter.tsx（宿主导出 UI）支持 `execution_mode === 'esm' | 'legacy' | 'inline'`，三种模式下 plugin runtime 行为可能不一致。

**行动**：
- 在 `package.json` 增加 `"test"` script，调用 SDK CLI 的 e2e harness（若 SDK 提供）
- 若 SDK 不提供，构建最小化集成测试 fixture：把 dist zip 解压到 mock host 目录，启动 mock CommandBus + EventBus，验证每个 command handler 在 worker 模式下不抛错
- 覆盖边界场景：`computer_labs` 表不存在时的 ALTER TABLE 容错、`computer_labs` 表存在但无 `name`/`layout_json` 列时的迁移

### 1.3 CSV 导出在中文 / 数字溢出场景下的健壮性

**现状**：CSV 使用 `\uFEFF` BOM 头保证 Excel 打开不乱码，但未做转义。学生姓名含逗号 / 引号 / 换行时导出文件格式会坏。

**行动**：
- 写一个 `escapeCsvField(field: string): string` 工具：
  - 若字段含 `,`、`"`、`\n`、`\r`，则用双引号包裹并将 `"` 转义为 `""`
- 修复 `lab_seat.export_attendance` handler（`src/index.ts` line 644 附近）使用该工具
- 在测试 fixture 中加入边界用例：姓名为 `张, 三` / `O'Brien` / `Multi\nLine` / `"带引号的"` 的导出断言

---

## 2. P1：用户体验与代码质量（1-3 个月）

### 2.1 前端代码迁移到 JSX ✅ 0.4.0 已交付

**现状**：`src/frontend.tsx` 738 行全部使用 `React.createElement(...)`，可读性差、维护成本高。tsconfig 已配置 `"jsx": "react"`，但当前写的是 `.tsx` 后缀的 JS-in-createElement 形式。

**行动**：
- 把 `RoomEditor` / `SeatAssignment` / `AttendanceDashboard` / `AttendanceHistory` / `DashboardAttendanceWidget` / `StudentSeatView` / `LabSeatToolPanel` 重写为 JSX 语法
- 保留 `function` 声明（非箭头函数）以符合 SDK 模板约定
- 保留 `useState` / `useEffect` / `useCallback` hooks
- 一次性 write 操作风险高，可分两个 PR：先抽 `<SeatGrid>` 子组件（最重），再逐步迁移其他
- **预期收益**：行数减少 30-40%、TypeScript 类型推导提升、可读性显著改善

### 2.2 教师 Tab 内增加课节选择器（替代手填 lessonId）

**现状**：4 个教师 Tab 都要求教师手动输入 `lessonId` UUID，体验差。教师通常不知道自己当前正在上的课的 lessonId。

**行动**：
- 增加 `lab_seat.list_lessons` command handler：返回教师当前活跃的 lessons（join `lessons` + `classes` + `users`）
- 前端 `TeacherLabPanel` 顶部加 lesson picker（select 控件），自动填充所有 tab 的 lessonId 输入框
- 优先 lesson：`status === 'live'` 的 lesson，其次按 `started_at` 最近 30 天内的 lesson

### 2.3 实时签到通知 ✅ 0.5.0 已交付（事件退避轮询 + 可见性感知）

**现状**：dashboard widget 依赖 `socketService` 事件推送降级到 5s 轮询；事件密集时延迟感明显。

**行动**：
- 评估当前 host 是否提供原生的 `ISocketService`（文档说 FrontendPluginContext.services.socketService 是有的）
- 评估服务端是否应该改用 SSE 或 webhook：每次签到事件发生时主动推送给学生端（StudentSeatView 当前要等到下次轮询才显示签到结果）
- 短期：在订阅失败 fallback 上加指数退避，避免 5s 轮询在低活跃时段浪费带宽

### 2.4 座位布局编辑器（图形化） ✅ 0.4.0 已交付

**现状**：当前布局只能在创建机房时固定 rows × cols，无法后期修改，也无法标记 `cell.type = 'none'`（空位 / 损坏）。

**行动**：
- 新增 `lab_seat.update_layout` 已在 command handler 中实现，但前端 UI 没有可视化编辑器
- 在 `RoomEditor` 组件加交互式网格：点击格子切换 `desktop`/`notebook`/`none`，拖拽设置 IP
- 持久化到 `computer_labs.layout_json`
- **前置**：先实现 §1.3 的迁移到 JSX，避免在 createElement 上叠加新功能

### 2.5 拖拽 UX（触屏 fallback） ✅ 0.5.0 已交付

**现状**：拖拽学生到目标座位（`SeatAssignment` 组件 line 159 附近）使用 HTML5 Drag & Drop API，在触屏设备上完全不工作。

**行动**：
- 检测 touch device 时降级到 click-based picker：点击学生 → 弹出座位选择器 → 点击目标座位
- 或集成 `@dnd-kit/core` 替代原生 drag API（需要评估是否加入 HostSharedDeps 白名单）

---

## 3. P2：能力扩展（3-6 个月）

### 3.1 多机房并发课节 ✅ 0.4.0 已交付

**现状**：每个 lesson 只支持一个机房（`lesson_id` ↔ `lab_id` 1:1）。

**行动**：
- 设计 `lab_seat.lesson_room_map` 关联表：`{ lesson_id, lab_id, role: 'primary'|'overflow' }`
- 拆分 `seat_assignments` 加 `lesson_room_id` 字段
- 前端 `SeatAssignment` UI 支持多机房切换

### 3.2 签到异常流程自动化 ✅ 0.5.0 已交付（auto_mark_absent）

**现状**：当前只支持 `checked_in` / `late` / `leave` / `absent` 四种状态，无自动化规则。

**行动**：
- 配置项新增 `auto_mark_leave_after_minutes: number`：超过该时长未签到自动判 `leave`
- 配置项新增 `late_auto_promote_after_minutes: number`：迟到超过该时长自动判 `absent`
- 在 EventBus 订阅里加 cron-like 任务（用 `setInterval` 扫描）

### 3.3 历史数据聚合与可视化 ✅ 0.5.0 已交付（attendance_trend）

**现状**：考勤看板只展示当前 lesson。历史记录仅表格 + CSV 导出。

**行动**：
- 新增 `lab_seat.attendance_trend` handler：按周/月聚合到课率、迟到率
- 前端 `AttendanceDashboard` 加趋势图（需要确认 recharts 是否已在白名单——文档说是的）
- 配合 §2.1 的 JSX 重构，使用 recharts 的 `<LineChart>` 直接渲染

### 3.4 与研究活动插件联动 ✅ 0.5.0 已交付（getResearchGroups + getActivitySeatMap）

**现状**：已通过 `plugin_research_groups` 表读取活动分组（`assign_seats` line 333 附近），但耦合在 SQL 硬编码中。

**行动**：
- 通过 SDK 的 `IActivityRegistryToken`（3.3.0 引入）正规化获取活动数据，而非硬编码表名
- 监听 `activity.member_assigned` 事件自动重新分组（如果活动成员变化）
- 暴露 `getActivitySeatMap(activityId)` API 供活动插件消费

---

## 4. P3：长期演进（6-12 个月）

### 4.1 离线缓存策略

**目标**：教师在弱网机房也能查看当前座位布局和未上传的签到记录。

**行动**：
- Service Worker 缓存 plugin dist
- IndexedDB 暂存未同步的签到事件，恢复网络后批量上传
- 冲突解决：教师在多个设备上同时签到，最后写入获胜（last-write-wins）

### 4.2 AI 智能排座

**现状**：仅支持 sequential / random / grouped 三种基础策略。

**行动**：
- 集成 SDK `IAIService`（`@openlearn/plugin-sdk` 7 个核心服务之一），调用 Gemini 生成"避免前排扎堆、照顾近视学生坐前排"的策略
- AI Action `lab_seat.smart_assign_seats`：教师描述约束 → AI 生成分配 → 教师确认 → 执行

### 4.3 与硬件联动

**目标**：与机房实际硬件（门禁 / 摄像头）联动，签到数据自动从硬件来。

**行动**：
- 监听门禁系统的 WebSocket / MQTT 推送，自动签到
- 与校园卡读卡器联动：通过 `IActivityRegistryService` 注册硬件事件

---

## 5. 文档与生态贡献

### 5.1 SDK Bug 报告与 PR

向 `aymwoo/OpenLearn-Next-V2` 仓库：

- **Bug Report**: SDK 3.5.2 cli.mjs `onResolve` 回调覆盖 `external` 配置，导致整个 SDK runtime 被 inline
- **PR Draft**: 在 `cli.mjs` 的 `onResolve` 中返回 `{ path: sdkDist, external: true }`；同时建议拆分 `dist/index.js` 为 `dist/types.js`（轻量）+ `dist/runtime.js`（重型）
- **测试用例**: 加 e2e 测试：构建 lab-seat plugin 并断言 `dist/index.js < < 500 KB`

### 5.2 文档同步

- 把 lab-seat 作为 SDK 文档中的参考插件（贡献到 `docs/tutorials/plugin-development-tutorial.md` 的"完整示例"章节）
- 撰写一篇博客文章：`从 0.1.0 到 0.3.0：构建一个生产级 OpenLearn 插件踩过的坑`

### 5.3 测试覆盖

当前状态（v0.5.0）：
- ✅ CSV 转义单元测试 14 例（0.3.0）——普通/空/null/数字/逗号/引号/换行/端到端
- ✅ Worker harness 集成测试 18 例（0.4.0–0.5.0）——mock better-sqlite3 + CommandBus，覆盖 schema 迁移、20+ 命令注册、create→assign→check_in 链路、多机房、update_layout、趋势、自动判定、活动分组、特殊字符导出
- ✅ `pnpm test` 一键运行（先构建 test-bundle 再跑两套）

仍待补：
- 端到端测试：用 Playwright 打开 host 渲染的 `teacher.tab` 面板并交互

---

## 6. 行动优先级（按本季度排期）

```
Week 1-2  : §1.3 CSV 转义 + escapeCsvField 单元测试
Week 2-3  : §2.2 课节选择器（服务端 list_lessons + 前端 picker）
Week 3-5  : §2.1 前端代码迁移到 JSX（分 2-3 个 PR）
Week 5-6  : §1.2 三种 execution_mode 兼容性测试
Week 7-8  : §2.4 座位布局编辑器 + §2.5 触屏拖拽 fallback
Week 9-12 : §3.1 多机房并发 + §3.4 活动插件联动重构
持续      : §5.1 SDK Bug 报告跟进 + §5.2 文档贡献
```

每个 PR 必须：
1. 通过 `npx openlearn-plugin-sdk build` 无 warning
2. 在 changelog 中保留条目
3. 在 §1.1 修复前不强行优化 bundle 体积（避免做无效工作）