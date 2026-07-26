# Changelog — openlearn-plugin-lab-seat (机房座位管理)

All notable changes to the **机房座位管理（Lab Seat Management）Plugin** (`openlearn-plugin-lab-seat`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
