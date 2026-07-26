# Changelog — openlearn-plugin-lab-seat (机房座位管理)

All notable changes to the **机房座位管理（Lab Seat Management）Plugin** (`openlearn-plugin-lab-seat`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-07-27

### Changed
- **机房表统一到平台 `computer_labs`**: 移除插件独立的 `rooms` 表。激活时自动给 `computer_labs` 补 `name`、`layout_json`、`updated_at` 列。存量 `room_number` 自动填充到 `name`。所有机房 CRUD 直接读写 `computer_labs`，与平台机房数据互通。
- **`lab_seat.create_room` 入参新增 `room_number`**：新建机房需提供编号（如 `410`），`name` 为可选显示名。
- **布局自动生成**：`computer_labs` 无 `layout_json` 时，自动从 `rows`/`cols` 生成默认字母编号网格。

## [0.1.5] - 2026-07-26

### Fixed
- **Worker 内 commandBus.execute 缺少前缀**: `shuffle_seats` 处理器内部调用 `commandBus.execute({ type: "lab_seat.assign_seats" })` 时 type 未被 Worker 代理层自动添加 manifest.id 前缀，导致主线程 CommandBus 找不到处理器。改为显式使用 `${ctx.manifest.id}.lab_seat.assign_seats`。
## [0.1.4] - 2026-07-26

### Fixed
- **ctx.config 不存在**: Worker runtime 不提供 `ctx.config`（IConfigService），新增 `getConfigValue` helper 从 `ctx.manifest.configuration.properties` 读取默认值。
- **ctx.provide 不存在**: Worker runtime 不提供 `ctx.provide`，添加类型守卫 `if (typeof ctx.provide === "function")` 确保仅在主进程注册服务。
- **迟到判定逻辑修正**: 原代码误读 `points_per_check_in` 计算迟到阈值，改为正确使用 `late_threshold_minutes` 配置项。
## [0.1.3] - 2026-07-26

### Fixed
- **eventBus.on 不存在**: 将 `eventBus.on()` 替换为 `eventBus.subscribe()`。Worker runtime 的 EventBus 代理层暴露的是 `subscribe/unsubscribe`，非 `on/off`。
## [0.1.2] - 2026-07-26

### Fixed
- **Worker 环境数据库迁移崩溃**: 将 `ctx.db.migrate` 回调中的 `sqliteDb.exec()` 替换为 `sqliteDb.prepare().run()`。Worker runtime 的数据库代理层不提供 `exec()` 方法，仅暴露 `prepare/run/get/all`。

## [0.1.1] - 2026-07-26

### Fixed
- **Engines 版本约束过紧**: 将 `engines.openlearn` 从 `^3.4.0` 修正为 `>= 0.1.0`，修复 PluginHost 拒绝加载插件的问题（host 当前版本为 0.1.x）。

## [0.1.0] - 2026-07-26

### Added
- **机房管理（Room CRUD）**: 创建、编辑、查询机房布局，支持自定义行列数与字母数字编号方案（A1, B3…）。在教师管理台的「机房管理」标签页中提供完整 UI。
- **座位分配（Seat Assignment）**: 支持三种分配策略——按学号顺序排列、随机打散、按研究活动小组聚集。教师可通过「座位分配」标签页选择课节与机房后一键分配。
- **拖拽手动调整**: 教师可将已分配学生从座位网格或学生标签列表中拖拽到目标座位，实现手动微调。
- **签到系统（Check-in）**: 教师开启/截止签到会话，学生通过「学生视图」确认到达完成签到。系统自动根据阈值判定迟到状态。
- **考勤看板（Attendance Dashboard）**: 以教室网格热力图 + 汇总统计卡片可视化当前课节的签到状态，实时刷新。
- **历史记录与 CSV 导出**: 按课节查询考勤记录并一键导出为 UTF-8 BOM CSV 文件。
- **Dashboard 卡片组件**: 在教师 Dashboard 中嵌入签到概览卡片，显示到课率与各状态人数。
- **Classroom 浮动工具栏**: 在课堂白板右上角提供快捷面板——随机重排座位、导出签到表、开启/截止签到。
- **座位模板（Seat Templates）**: 支持将当前分配保存为模板，后续课节可直接应用。
- **积分联动**: 学生签到后自动向平台的积分账本服务发放配置化积分（默认 5 分/次），积分服务缺失时静默跳过。
- **跨插件服务接口（ILabSeatService）**: 暴露 `getStudentSeat`、`getAttendanceStatus`、`getLessonAttendanceSummary` 供其他插件消费。
- **AI Action 集成**: 注册 `lab_seat.shuffle_seats`、`lab_seat.assign_seats` 等 Action 供 AI 助教调用。
- **数据库迁移**: 自动创建 `rooms`、`seat_assignments`、`attendance_records`、`check_in_sessions`、`seat_templates` 五张 SQLite 表。
