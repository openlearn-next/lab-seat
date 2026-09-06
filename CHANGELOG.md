# Changelog — openlearn-plugin-lab-seat (机房座位管理)

All notable changes to the **机房座位管理（Lab Seat Management）Plugin** (`openlearn-plugin-lab-seat`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.0] - 2026-09-06

### Added
- **签到异常流程自动化（§3.2）**：新增配置 `auto_mark_leave_after_minutes`（签到开启 N 分钟未签到自动标记请假）、`late_auto_promote_after_minutes`（迟到 N 分钟未签到自动升级缺勤）、`auto_scan_interval_seconds`（扫描间隔，默认 60s）。后台 `setInterval` 周期扫描 open 会话；判定逻辑抽成可 AI/手动触发的 `lab_seat.auto_mark_absent` command（interval 仅做周期调度）。deactivate 时清理 timer。
- **历史到课率趋势（§3.3）**：新 handler `lab_seat.attendance_trend`，按课节聚合（opened_at 锚点 / total = 该课节被分配人数 / checked/late/leave/absent / 到课率%），返回时间倒序序列。前端「历史记录」tab 新增「近 30 天到课趋势」按钮 → 纯 CSS 条形图（不引入 recharts，避免 bundle 膨胀）。
- **活动插件联动重构（§3.4）**：分组读取抽成 `getResearchGroups(activityId)` —— 先探测 `IActivityRegistryToken` 活动生态，不存在则回退直查 `plugin_research_groups` 表，**表缺失不崩溃**（返回空分组，成员落到队列末尾仍全分配）。`ILabSeatService` 新增 `getActivitySeatMap(activityId)` 返回 学生→{labId,rowIdx,colIdx} 供活动插件展示组内座位。
- **移除单个学生座位（§2.5 配套）**：新 command `lab_seat.unassign_student`（删除单条分配，返回 removed 布尔）。
- **3 项新配置** 在 manifest `configuration` 中声明，插件中心「设置」页自动生成表单。

### Changed
- **事件订阅升级（§2.3）**：`subscribeToEvents` 现在带可见性感知（标签页隐藏暂停轮询省电）、in-flight 保护（handler 执行中跳过下次调度）、空闲指数退避（3s→30s 封顶）、收到真实 socket 事件立即回到快速档；保留 socketService 订阅 + 低频心跳兜底。
- **触屏拖拽降级（§2.5）**：SeatAssignment 检测 `ontouchstart` / `maxTouchPoints` → 触屏设备自动启用「点学生 chip → 点目标座位」两步落座，不再依赖无效的 HTML5 drag；桌面仍为拖拽，且座位格/学生 chip 增加占用提示（目标被占时明确报错不覆盖）。
- **配置读取扩展**：worker runtime 无 `ctx.config` 时已能回退 manifest default；现同时支持 mock host 注入 config 覆盖（便于测试）。

### Security
- 自动判定仅把「未签到」升级为请假、把「迟到」升级为缺勤，**不删除**已有签到记录（幂等 INSERT OR REPLACE / UPDATE，绝不触碰已 checked_in 记录）。

## [0.4.0] - 2026-09-06

### Added
- **多机房并发课节（§3.1）**：新增 `lesson_room_map` 关联表，一个课节可关联多个机房。新 handlers：`lab_seat.list_lesson_labs`（含每机房已分配人数）、`lab_seat.add_lesson_lab`、`lab_seat.remove_lesson_lab`（连带清空该机房分配）。`assign_seats` 扩展支持 `labIds[]` 按容量顺序批量填充；学生数超出总座位时抛出明确错误（提示添加更多机房）。容量不足时单机房报错提示同样明确。
- **多机房查询过滤**：`get_assignments` / `get_attendance` 支持 `labId` 可选参数，按机房返回；`export_attendance` 支持 labId 且 CSV 新增「机房」列（修复原 handler 引用了未 SELECT 的 `lab_id` 的既存 bug）。
- **图形化座位布局编辑器（§2.4）**：机房列表新增「编辑布局」入口 → `LayoutEditor` 组件，单击格子在 desktop/notebook/none 间循环、双击打开详情编辑 IP/备注、实时统计各类型数量、保存调 `update_layout`。
- **前端 teacher.tab JSX 化（§2.1）**：整个 `frontend.tsx` 由 `React.createElement` 迁移到 JSX（经典模式 `jsx:react`），可读性/类型推导/可维护性显著提升；React 仍正确 external，未打入 bundle。
- **worker 兼容性测试 harness（§1.2）**：`test/plugin.test.mjs` 用真实 better-sqlite3 + mock CommandBus/EventBus/ActionRegistry/DI 模拟 host Worker runtime，覆盖全新安装 / 升级安装 / 幂等迁移 / 全部命令注册 / 关键业务链路（create_room→list_rooms、assign→open_check_in→check_in、积分服务缺失降级、ILabSeatService provide、特殊字符 CSV 导出、update_layout、多机房批量分配与容量不足、list_lessons 容错）。
- **测试脚本体系**：`pnpm test`（构建 test-bundle + csv + plugin 两套测试，27 断言全绿）、`pnpm test:csv`、`pnpm test:plugin`、`pnpm build:test-bundle`；`test/build-test-bundle.mjs` 用 esbuild stub SDK inline 的 pino/express/jszip/semver/uuid 等 runtime 依赖使 bundle 可在 Node 直接 import。

### Fixed
- **fresh install 崩溃**：原代码在 `computer_labs` 表不存在时直接 `UPDATE computer_labs SET name = room_number` 会抛 `no such table`。改为先 `CREATE TABLE IF NOT EXISTS computer_labs` 再用 try/catch 包 UPDATE（§1.2 测试暴露）。
- **create_room 丢失 room_number**：原 INSERT 把 `p.name` 同时写入 `room_number` 和 `name` 两列，导致 `room_number` 永远等于 name。修正为 `p.room_number` 写入编号列、`name` 缺省回退编号。
- **assign_seats 的 prepare().run() 误用**：`rawDb.prepare(sql).run()` 返回 RunResult 而非 Statement，随后的 `delStmt.run(...)`/`insStmt.run(...)` 永远抛错（“Too few parameter values”）。重构为 `.prepare()` 存 Statement 再 `.run()`。
- **export_attendance 引用未 SELECT 列**：原 SELECT 未包含 `lab_id` 却用 `r.lab_id` 查机房布局（永远 undefined → 座位号回退成 “row-col”）。已补列并额外输出机房名。
- **测试 fixture 修复**：`assert.doesNotReject` 不改写返回值导致的误断言等。

### Security
- **`test/_mock-pino.mjs` 仅用于测试环境**；生产 bundle 仍由 SDK inline，无变化。

## [0.3.0] - 2026-09-06

### Changed
- **SDK 升级到 `@openlearn/plugin-sdk@^3.5.2`**：对齐最新文档（`@openlearn/plugin-sdk@3.5.0` 适用范围）。补充 SDK 运行时依赖（pino / uuid / express / semver / jszip）到 `devDependencies`，使构建产物解析完整。
- **manifest 新增 `main`、`optional`、`provides`、`updateSource` 字段**：`main: 'index.js'` 满足 Manifest 接口要求；`optional: [IPointsLedgerService]` 声明积分服务为可选依赖；`provides: [ILabSeatService]` 让其他插件显式订阅本插件服务；`updateSource.type: 'github-release'` 启用插件中心远端版本检测。
- **前端事件订阅重构成 `subscribeToEvents` helper**：前端 bundle 不再依赖 `ctx.services.socketService` 是否存在；host 旧版本（无 socketService）自动降级到 5s 轮询，避免在某些 host 版本下事件不触发。
- **CSV 下载重构成 `downloadCsv` helper**：优先使用 `ctx.services.uiService.downloadFile` 走 host 原生 toast / 进度；不可用时降级为浏览器原生 `<a download>` Blob 下载，不再因 `uiService` 缺失导致导出按钮静默失效。
- **新增 `lab_seat.list_lessons` command + AI action**（§2.2）：教师 Tab 顶部加 `LessonPicker` 控件。教师不再手动输 lessonId  UUID，可从下拉菜单选当前活跃 / 最近课节。动态探测 host `lessons` 表 schema 演进后列名变化（用 `PRAGMA table_info`）保证兼容性。AI Agent 可调用同一个 command 查询课节列表。
- **CSV 导出按 RFC 4180 转义**（§1.3）：学生姓名含逗号 / 双引号 / 换行时导出文件不再被 Excel 解析为多行 / 多列。新增 `escapeCsvField` / `csvRow` 工具函数（独立 `src/csv.ts`），附 14 个单元测试覆盖中英文逗号 / 引号嵌套 / `\r\n` / `null` / 数字等边界场景。

### Added
- **`pnpm test` / `pnpm test:watch` 脚本**：运行 `node --test test/csv.test.mjs`，不依赖 SDK 构建产物。14/14 测试通过。
- **新文件 `src/csv.ts`**：独立的 CSV 工具模块，便于复用与测试。

### Fixed
- **`@openlearn/core:IPointsLedgerService` 字面量 token 替换为 `IPointsLedgerServiceToken`**：之前用 `{ name: '@openlearn/core:IPointsLedgerService' } as any` 绕过类型系统；现在改用 SDK 导出的强类型 Token 实例，类型推断更准确、与 SDK 其它 28 个 Token 风格统一。
- **`@aymwoo/plugin-lab-seat:ILabSeatService` 字面量 token 替换为 `Token<T>` 强类型实例**：在文件顶部 `const ILabSeatServiceToken = new Token<ILabSeatService>(...)`，并新增 `ILabSeatService` 接口定义，供其他插件 `ctx.resolve(ILabSeatServiceToken)` 时类型推断。
- **`/home/wuxf/Develop/openlearn-plugins/lab-seat/src/components/PluginCenter.tsx` 移出插件源码**：该 1783 行文件是从宿主 `App.tsx` 提取出来的插件管理 UI（注释明确说明），引用了 `./LegacyPluginBadge`、`./PluginSettingsModal`、`./PluginInstallWizard`、`../plugin-host/plugin-host-store`、`../i18n` 等宿主应用私有路径。如果未来任何文件误 `import` 它，将导致 SDK 构建因模块缺失失败。现已移至 `docs/extracted-from-host/PluginCenter.tsx` 作为参考保留。
- **包体积污染修复**：之前 `package.json` 把 `express` / `jszip` / `pino` / `semver` / `uuid` 错误归类为 `devDependencies`，而 SDK 设计上需要这些库作为 inline 的 runtime 依赖。新版本明确这些是 SDK 必需的 transitive 依赖，构建时 SDK 会自动 inline 它们。

### Known Issues
- **服务端 bundle 体积（7.6 MB）偏大**：SDK 3.5.2 仍把 `@openlearn/plugin-sdk` dist（包含整个 plugin-runtime + PluginDistributionManager / ConfigService / Logger / EventBus 内部）inline 进 plugin bundle，连带拉入 `express` / `jszip` / `pino` / `uuid` / `semver`。这是 SDK 客户端设计问题（`external: ['@openlearn/plugin-sdk']` 被 `onResolve` 返回本地路径覆盖），需要 SDK 官方修复 `cli.mjs:222-242` 的 onResolve 回调（应同时返回 `external: true`）。详见 `ROADMAP.md` §1.1。

## [0.2.0] - 2026-07-27

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
