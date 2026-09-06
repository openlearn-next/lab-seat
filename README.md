# openlearn-plugin-lab-seat

**机房座位管理** —— OpenLearn V2 插件。教师编排机房布局、分配座位、发起签到并跟踪考勤；学生查看自己座位并一键签到。支持多机房并发课节、图形化布局编辑、AI 智能排座。

> OpenLearn V2 插件文档：<https://openlearn-next-v2.readthedocs.io/zh-cn/latest/>
> 目标 SDK：`@openlearn/plugin-sdk@^3.5.2`

---

## 功能总览

| 能力 | 说明 |
|------|------|
| 🏛️ 机房管理 | 复用平台 `computer_labs` 表；新建/编辑机房，图形化布局编辑器（每格可设 台式机/笔记本/空位 + IP/备注） |
| 🪑 座位分配 | sequential / random / grouped（按研究活动小组）三种策略；拖拽/触屏点选手动微调；座位模板保存与复用 |
| 🧪 多机房并发 | 一个课节关联多个机房（`lesson_room_map`），按容量批量填充，超容量明确报错；各机房独立查看/考勤/导出 |
| 📋 签到 | 教师开启/截止签到会话；学生确认到达；按 `late_threshold_minutes` 自动判迟到 |
| 📈 考勤看板 | 座位热力图 + 状态统计；课节历史表格；近 30 天到课率趋势 |
| 🤖 异常自动判定 | `auto_mark_leave_after_minutes`（超时未签到→请假）、`late_auto_promote_after_minutes`（迟到超时→缺勤），后台定时扫描 |
| ✨ AI 智能排座 | 教师自然语言约束 → LLM 结构化 → 确定性落座（近视坐前/回避后排/按小组） |
| 📤 导出 | UTF-8 BOM CSV（RFC 4180 转义，含机房列），host `uiService` 或浏览器原生下载 |
| 🎁 跨插件 | 暴露 `ILabSeatService`（座位/考勤查询 + 活动座位分布）；签到可联动平台积分 |

---

## 快速开始

```bash
npm install           # 或 pnpm install
npm run build         # npx openlearn-plugin-sdk build → dist/*.zip
```

在 OpenLearn 管理后台 **系统设置 → 插件中心 → 上传插件**，上传 `dist/openlearn-plugin-lab-seat.zip`，激活即可。

### 验证构建产物

```bash
# 服务端 bundle 不应有裸导入（SDK 会 inline 处理运行时依赖）
grep -E '^import .+ from "[^@\./]' dist/index.js   # 期望无输出
```

### 测试

```bash
npm test              # 先 build test-bundle 再跑 CSV(14) + smart-assign(13) + worker harness(21)
npm run test:csv      # CSV 工具函数
npm run test:plugin   # worker mock 集成测试
```

---

## UI 扩展点

| 槽位 | 组件 | 位置 |
|------|------|------|
| `teacher.tab` | TeacherLabPanel | 教师工作台侧边栏（机房管理/座位分配/考勤看板/历史记录） |
| `teacher.dashboard.widget` | DashboardAttendanceWidget | 教师 Dashboard 签到概览卡片 |
| `student.view` | StudentSeatView | 学生端查看座位 + 签到 |
| `classroom.tool` | LabSeatToolPanel | 课堂白板右上的浮动面板（随机重排/导出/开停签到） |

---

## Command / AI Action

### Commands（`lab_seat.*`）

机房 CRUD：`create_room` `update_layout` `list_rooms` `get_room`
座位：`assign_seats`（含 `labIds[]` 多机房） `move_student` `unassign_student` `get_assignments` `save_template` `list_templates`
签到：`open_check_in` `close_check_in` `check_in` `manual_check_in` `get_active_check_in` `auto_mark_absent`
考勤：`get_attendance`（`labId?`） `get_my_seat` `attendance_trend` `get_current_lesson_attendance` `export_attendance`
课节：`list_lessons` `list_lesson_labs` `add_lesson_lab` `remove_lesson_lab`
AI：`smart_assign_seats`

### AI Actions（可被 AI Agent 调用，description 为中文）

- `lab_seat-create-room` → 创建机房布局
- `lab_seat-auto-assign` → 自动/批量分配座位（单/多机房、三种策略、模板）
- `lab_seat-smart-assign` → **按自然语言要求智能排座**
- `lab_seat-check-in` / `get-attendance` / `export-report` / `list-lessons` / `shuffle-seats`

---

## 配置项（manifest `configuration`）

| key | 默认 | 说明 |
|-----|------|------|
| `points_per_check_in` | 5 | 每次签到发放积分数（积分服务缺失自动跳过） |
| `late_threshold_minutes` | 10 | 迟到判定阈值（分钟） |
| `auto_mark_leave_after_minutes` | 0 | 签到开启后超时未签到 → 自动标记请假；0 = 关闭 |
| `late_auto_promote_after_minutes` | 0 | 迟到超时未签到 → 自动升级缺勤；0 = 关闭 |
| `auto_scan_interval_seconds` | 60 | 异常自动判定扫描间隔 |

---

## 安全与权限

- `capabilitiesProposed`：`lab_seat:read/write/check_in/export`（自建）+ `lesson/class/student:read`（只读平台数据）
- `requires`：CommandBus / ActionRegistry / EventBus / IDatabase；`optional`：IPointsLedgerService（积分，缺失静默）
- 数据库：所有 plugin 表带 `plugin_lab_seat_` 前缀（`ctx.db.table()`），不触碰平台表（`computer_labs` 仅 ALTER 加列幂等）

---

## 已知问题 / 发布注记

- **SDK bundle 瘦身**：本插件 build 产物从 ~7.4 MB 降至 **~0.2 MB**（zip ~0.43 MB）。修复已 apply 宿主 SDK（commit `68ee958`，`packages/plugin-sdk` 停止值导出 host-runtime 实现类，`dist` 34KB→7.7KB），详见 [`docs/sdk-pr/proposal.md`](docs/sdk-pr/proposal.md)。
- **本地验证说明**：当前仓库构建依赖的 `@openlearn/plugin-sdk` dist 为已同步的瘦身版；待 SDK 正式发版（含该修复）后 `npm install` 即天然获得同样效果。若安装的是旧版 SDK，bundle 会回到 ~7.4 MB（功能不受影响）。

---

## Roadmap

详见 [`ROADMAP.md`](ROADMAP.md)。已完成：CSV 转义、worker harness、JSX 迁移、课节选择器、事件退避订阅、触屏拖拽、布局编辑器、多机房、异常自动判定、趋势、活动联动、AI 智能排座。
