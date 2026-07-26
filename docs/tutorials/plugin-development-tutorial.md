# OpenLearnV2 插件开发完全指南

> 📅 **最后更新**：2026-07-27
>
> 本文档描述 Worker Thread 隔离模式与 Inline 模式的 API 差异。若你的插件运行在 Worker 模式下，请务必阅读 [§8.1.1 Worker 与 Inline 模式 API 差异](#811-worker-与-inline-模式-api-差异-⚠️)。



## 1. 系统架构概述

### 1.1 设计理念

OpenLearnV2 采用 **插件驱动的命令-事件总线架构**（Plugin-Driven Command-Event Bus）。灵感来源于操作系统内核设计：一个精简的核心内核提供基础能力，所有业务功能通过插件实现。

```
┌──────────────────────────────────────────────────────────────┐
│                      OpenLearnV2 OS                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   AI Agent (Shell)                    │   │
│  │          Gemini / OpenAI 兼容模型作为智能控制器        │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │ 自然语言 → functionCall             │
│  ┌──────────────────────▼───────────────────────────────┐   │
│  │                  Command Bus (内核管线)               │   │
│  │  interceptor → JSON Schema校验 → CapabilityGuard →  │   │
│  │  高危审批闸门 → beforeCommand → Handler → afterCmd   │   │
│  └──┬──────────┬──────────┬──────────┬──────────┬───────┘   │
│     │          │          │          │          │            │
│  ┌──▼──┐  ┌───▼──┐  ┌───▼──┐  ┌───▼──┐  ┌───▼──────┐      │
│  │内置  │  │ VFS  │  │管理  │  │ AI   │  │第三方插件 │      │
│  │插件  │  │插件  │  │插件  │  │规划器│  │ (Plugin)  │      │
│  └──┬──┘  └──┬──┘  └──┬──┘  └──┬──┘  └────┬──────┘      │
│     │        │        │        │            │              │
│  ┌──▼────────▼────────▼────────▼────────────▼──────┐      │
│  │                   Event Bus                      │      │
│  │        所有事件写入 SQLite 审计日志               │      │
│  └──────────────────────┬───────────────────────────┘      │
│                         │                                   │
│  ┌──────────────────────▼───────────────────────────┐      │
│  │     SQLite Database (30+ 表) + ServiceRegistry    │      │
│  └───────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 核心子系统

| 子系统 | 文件 | 职责 |
|--------|------|------|
| **Kernel** | `packages/core/kernel/index.ts` | 全局单例容器，分层组装所有子系统（Layer 0-3），引导系统插件启动 |
| **CommandBus** | `packages/core/command-bus/index.ts` | 命令执行管线：注册 handler → 拦截器链（JSON Schema校验→CapabilityGuard→高危审批）→ 执行 |
| **EventBus** | `packages/core/event-bus/index.ts` | 发布/订阅事件，支持通配符 `*`，异步并行通知 |
| **ActionRegistry** | `packages/core/registry/index.ts` | 注册 AI Agent 可发现的工具 |
| **CapabilityGuard** | `packages/core/capability-system/index.ts` | 基于字符串的 RBAC 权限控制 |
| **ProcessManager** | `packages/core/process-manager/index.ts` | 后台进程和定时任务管理 |
| **PluginHost** | `packages/core/plugin-host/index.ts` | 插件生命周期：安装/激活/停用/卸载/热重载，中间件管道 |
| **ServiceRegistry** | `packages/core/di/service-registry.ts` | 依赖注入容器，Token 驱动，依赖图验证 |
| **ResourceTracker** | `packages/core/plugin-host/resource-tracker.ts` | 按 pluginId 管理 Disposable 资源，保证精确清理 |
| **WorkerManager** | `packages/core/worker-manager/index.ts` | Worker Thread 隔离模式管理 |
| **FrontendPluginHost** | `src/plugin-host/plugin-host.ts` | 前端插件生命周期管理，支持 inline/worker 模式 |

### 1.3 数据流

```
用户发送消息 → POST /api/agent/chat
  → AI 模型返回 functionCall（如 lesson.create）
  → executeAgentToolCall() 通过 ActionRegistry.getActionByToolName() 查找 action
  → CommandBus.execute() 执行拦截器管线:
    ├─ JSON Schema payload 校验（基于 action.inputSchema）
    ├─ CapabilityGuard 权限检查（非 admin actor）
    └─ 高危操作 → 写入 pending_commands 审批表 + 抛出异常中断
  → beforeCommand 中间件 → Handler 执行业务逻辑 → afterCommand 中间件
  → EventBus.publish() 发布事件（异步并行通知所有订阅者）
  → Socket.IO 推送给在线客户端
  → 返回结果给 AI Agent（继续对话或结束）
```

---

## 2. 开发原理

### 2.1 插件即 ESM 模块

插件是一个导出了 `manifest` 和 `activate` 函数的 JavaScript/TypeScript 模块：

```typescript
// 插件的最小结构
export default {
  manifest: { ... },
  activate: async (ctx: PluginContext) => { ... },
  deactivate: async () => { ... },  // 可选
};
```

### 2.2 双运行时架构

```
┌─ 服务端（Node.js） ─────────────────────┐
│  PluginHost → inline/worker 执行模式     │
│  • inline: 直接在同一进程中运行           │
│  • worker: 独立 Worker Thread 隔离运行    │
└─────────────────────────────────────────┘

┌─ 前端（浏览器） ────────────────────────┐
│  FrontendPluginHost → 双模式执行         │
│  • inline: 直接 import() 动态加载         │
│  • worker: BrowserWorkerManager 隔离     │
│  • 扩展点注册（UI 面板/工具/视图）       │
│  • 浏览器 API 服务注入                   │
└─────────────────────────────────────────┘
```

### 2.3 依赖注入

插件通过 **Token** 声明依赖，由 ServiceRegistry 自动解析注入：

```typescript
import { ICommandBusServiceToken, IDatabaseToken } from '@openlearn/plugin-sdk';

// 在 activate 中解析依赖
const commandBus = await ctx.resolve(ICommandBusServiceToken);
const db = await ctx.resolve(IDatabaseToken);


// 也可以通过 ctx.services 直接访问 7 个内核服务
const eventBus = ctx.services.eventBus;
const ai = ctx.services.ai;
```

**V3.2 新增**：插件可通过 `ctx.provide()` 向 DI 容器注册自定义服务给其他插件消费：

```typescript
// 插件 A：注册自定义服务
// V3.2: use Token instead of string
await ctx.provide(QuestionBankToken, myQuestionBank);

// 插件 B：消费该服务
const qb = await ctx.resolve({ name: '@my-scope/IQuestionBankService' } as any);
```

### 2.4 PluginContext 完整接口

```typescript
interface PluginContext {
  // 7 个内核服务接口（直接访问）
  services: {
    commandBus: ICommandBusService;       // 命令执行、注册
    eventBus: IEventBusService;           // 事件发布/订阅
    actionRegistry: IActionRegistryService; // AI 工具注册
    capability: ICapabilityService;       // 权限管理
    processManager: IProcessService;       // 后台进程
    storage: IStorageService;             // K-V 存储
    ai: IAIService;                       // AI 文本生成
  };
  pluginId: string;           // 插件 ID
  manifest: Manifest;         // 插件 manifest

  // 依赖注入
  resolve<T>(token: Token<T>): Promise<T>;                    // 从 ServiceRegistry 解析服务
  provide<T>(token: Token<T>, instance: T): Promise<void>; // V3.2: 注册自定义服务

  // 插件专用数据库
  db: PluginDatabaseAPI;      // 命名空间隔离的 SQLite 操作（含 migrate() 迁移）

  // V2.5 结构化日志（自动注入 pluginId 和 timestamp）
  log: IPluginLogger;         // 支持 debug/info/warn/error 四级

  // V3.2: 类型安全的配置服务
  config: IConfigService;     // 读取 manifest.configuration 中声明的设置项

  // V3.2: 声明式贡献点只读视图
  contributions: ContributionAccessor; // list(): 内省插件在 manifest 中声明的贡献点

  // V2.5: 主应用共享模块引用（白名单控制）
  require(moduleName: string): any;
}
```

> ⚠️ **Worker 模式限制**：以上接口为 Inline 模式的完整 API。在 Worker Thread 隔离模式下，`ctx.config`、`ctx.provide()` 不可用，`ctx.db.migrate()` 回调仅暴露 `prepare()`，`eventBus` 使用 `subscribe()/unsubscribe()` 而非 `on()/off()`。详见 [8.1.1 Worker 与 Inline 模式 API 差异](#811-worker-与-inline-模式-api-差异-⚠️)。

```

### 2.5 生命周期状态机

```
INSTALLED ──→ ACTIVATING ──→ ACTIVE ──→ DEACTIVATING ──→ INACTIVE
                                  │                           │
                                  └──── ERROR ←───────────────┘
                                                        │
INACTIVE ──→ ACTIVATING（重新激活）                      │
ERROR ──→ ACTIVATING（重试）          UNINSTALLED ←──────┘
```

- **INSTALLED**：源码已持久化，尚未激活
- **ACTIVATING**：正在执行 `activate()`（瞬态，不超过 10 秒）
- **ACTIVE**：正常运行中
- **INACTIVE**：已停用，可通过 toggle 重新激活
- **ERROR**：激活失败，可重试或卸载

### 2.6 版本兼容性速查表

开发插件前，先确认目标 OpenLearn 版本。以下特性按版本分组，选择适合你的目标版本。

**API 特性版本要求：**

| 特性 | 最低版本 | 说明 |
|------|----------|------|
| `ctx.log` | 2.5 | 结构化日志（debug/info/warn/error），自动注入 pluginId 和 timestamp |
| `ctx.config` | 3.0 | 类型安全的配置读取，配合 manifest.configuration 声明 |
| `ctx.provide()` | 3.0 | 向 DI 容器注册自定义服务供其他插件消费 |
| `ctx.require()` | 2.5 | 引用主应用白名单共享模块（recharts、jspdf 等） |
| `ctx.invokeCommand()`（前端） | 2.5 | 前端直接调用后端 CommandBus |
| `teacher.panel` 扩展槽位 | 2.5 | 教师独立全宽管理面板 |
| `student.fullscreen` 扩展槽位 | 2.5 | 学生全屏视图/考试模式 |
| `global.setting` 扩展槽位 | 2.5 | 全局设置页扩展 |

**扩展槽位版本可用性一览：**

| 槽位 | 最低版本 | 适用角色 |
|------|----------|----------|
| `teacher.tab` | 1.0 | 教师 |
| `teacher.dashboard.widget` | 1.0 | 教师 |
| `student.view` | 1.0 | 学生 |
| `student.lesson.tool` | 1.0 | 学生 |
| `classroom.tool` | 1.0 | 课堂教学 |
| `teacher.panel` | 2.5 | 教师 |
| `student.fullscreen` | 2.5 | 学生 |
| `global.setting` | 2.5 | 管理员 |

> **提示**：在 manifest.engines.openlearn 中声明目标版本，如 `"^2.5.0"`。安装时 PluginHost 自动检查兼容性。
>
> ⚠️ **版本号说明**：OpenLearn 存在三个独立的版本号，请勿混淆：
> | 版本 | 当前值 | 用途 |
> |------|--------|------|
> | 平台发行版本 | `0.1.14` | CHANGELOG 与 git tag 的发布版本 |
> | 宿主 API 版本 | `2.5.0` | `engines.openlearn` 兼容性检查所用的版本 |
> | SDK 版本 | `3.4.3` | `@openlearn/plugin-sdk` npm 包版本，仅影响类型定义 |
>
> **`engines.openlearn` 应填写宿主 API 版本（当前为 `2.5.0`）**，而非平台发行版本或 SDK 版本。

### 2.6 导航页面 vs. 白板组件 — 如何区分？

同一个插件可以注册到不同的 slot，**每个 slot 绑定独立的 React 组件**，无需任何 if-else 分支来区分。

**核心规则：**

| Slot | 渲染位置 | 组件收到的 props | 适用场景 |
|------|---------|-----------------|---------|
| `teacher.tab` | 侧边栏导航 → 全屏独立页面 | `{ renderType: 'panel' }` | 管理界面（列表、设置、数据看板） |
| `teacher.dashboard.widget` | 白板内的可拖拽卡片 | `{ elementId, lessonId }` | 课堂交互组件（编辑、答题、展示） |
| `classroom.tool` | 课堂互动工具架按钮 | — | 工具栏入口，点击后通过 `commandType` 触发动作 |
| `student.view` | 学生端全屏视图 | `{ studentId }` | 学生操作界面 |

**`teacher.tab` 和 `teacher.dashboard.widget` 的关键区别：**

1. **容器不同**：`teacher.tab` 是全屏页面（`flex-1 overflow-auto`），适合列表、设置等管理界面；`teacher.dashboard.widget` 是白板内固定尺寸的卡片，适合课堂即时交互。

2. **props 不同**：白板组件额外接收 `elementId`（当前白板元素 ID）和 `lessonId`（当前课节 ID），可用于数据隔离和持久化。

3. **ID 匹配机制**：`teacher.dashboard.widget` 的 `id` 必须与 `manifest.classroomTools[].payload.data.teacherWidgetId` 一致，`PluginCardRenderer` 通过这个 ID 查找对应组件：

```json
// manifest.json — classroomTools 声明
{
  "classroomTools": [{
    "id": "scratch-editor-tool",
    "commandType": "whiteboard.draw",
    "payload": {
      "type": "plugin",
      "data": "{ \"teacherWidgetId\": \"my-widget\", \"width\": 960 }"
    }
  }]
}
```

```js
// frontend.js — 组件注册，id 必须与 payload 中的 teacherWidgetId 一致
ctx.ui.registerExtensionPoint('teacher.dashboard.widget', {
    id: 'my-widget',           // ← 匹配 payload.data.teacherWidgetId
    component: MyWidget,
});
```

**典型模式：导航页 = 管理界面，白板组件 = 交互工具。** 例如作业中心应在 `teacher.tab` 注册作业列表管理页，在 `teacher.dashboard.widget` 注册具体某次作业的提交/批改面板。两者共享 `elementId`/`lessonId` 即可通过后端 API 打通数据。

> **控制 Dashboard 可见性**：插件可在 `manifest.configuration.properties` 中声明 `showInDashboard`（`boolean`，默认 `true`）。用户可在插件中心的每张卡片上切换此开关，系统将自动隐藏/显示该插件的 Dashboard 小部件。详见 [5.11 IConfigService](#511-iconfigservicev32-新增)。

---

### 2.7 使用 AI Skill 快速开发（推荐）

除了手动参考本指南编写代码，推荐使用官方的 **OpenLearn 插件开发 Skill** 来辅助开发。Skill 是运行在 Antigravity / Codex / Claude Code 中的 AI 代理套件，整合了最新 OpenLearn V2（平台 `v2.5.0`、SDK `@openlearn/plugin-sdk@3.4.3` 与测试包 `@openlearn/plugin-test-kit`）的架构规范，能自动化插件开发的大部分流程。

**安装与配置：**

```bash
# 使用 Antigravity CLI 或 npx 快捷添加官方开发 Skill
npx skills add aymwoo/openlearn-skills/openlearn-next-plugin-dev
```

安装后，在 Agent 对话中提及 OpenLearn 插件开发相关需求（例如：“*帮我写一个基于 Node 隔离沙箱的课堂互动抽奖插件*”），Skill 将会自动激活。

**Skill 核心能力（适配 OpenLearn V2 最新架构）：**

| 能力维度 | 最新架构适配说明 |
|---|---|
| 📖 **权威文档与 SDK 契约** | 实时对齐 `@openlearn/plugin-sdk@3.4.3` API，包含强类型 `Token<T>`、`ctx.provide()` 自定义服务共享以及活动生态 `IActivityRegistryToken` 契约。 |
| 💬 **结构化交互设计确认** | 自动引导确认插件模式（`server-only` / `full-stack` / `frontend-only`）、Worker Thread 沙箱权限、UI 扩展槽位（`teacherTab`, `classroomTool` 等）及表结构。 |
| 🏗️ **标准脚手架与代码生成** | 自动生成包含 `package.json`、`tsconfig.json`、`src/index.ts` (后端 Worker 逻辑) 和 `src/frontend.tsx` (React 19 组件) 的标准项目工程。 |
| 🛡️ **安全与规范防错** | 自动校验 CQRS 三件套模式（`ActionRegistry` → `CommandBus` → `EventBus`）、CapabilityGuard 权限申报、SQLite 增量迁移脚本与 ESM 沙箱导出规范。 |
| 🧪 **测试套件集成** | 自动生成基于 `@openlearn/plugin-test-kit@3.3.1` 的 Vitest 单元测试桩（支持 `createMockContext()` 工厂）。 |
| 📦 **一键打包与发布** | 提供 `npx @openlearn/plugin-sdk build` 命令行指导，生成经过 Manifest Schema 验证的插件 `.zip` 分发包。 |

**AI 辅助开发标准化工作流：**

```
用户提出需求：「帮我开发一个随堂互动小测验插件」
  → Skill 自动载入 @openlearn/plugin-sdk@3.4.3 规格与核心 Token
  → 交互式确认：用途、沙箱权限 (vfs/lesson/db)、扩展槽位 (teacherTab/classroomTool)
  → 选择插件模板 (full-stack / server-only / frontend-only)
  → 生成项目结构与代码 (Action/Command/Event + React 19 UI)
  → 自动生成 @openlearn/plugin-test-kit 单元测试
  → 执行 npx @openlearn/plugin-sdk build 编译生成 ZIP 扩展包
  → 提示在 OpenLearn V2 后台管理中上传激活并测试
```

**支持的标准插件模板：**

| 模板类型 | 运行环境 | 生成的核心文件 |
|---|---|---|
| `server-only` | Node.js Worker Thread | `package.json`, `tsconfig.json`, `src/index.ts` |
| `full-stack` | Worker Thread + 前端微前端 | `package.json`, `tsconfig.json`, `src/index.ts`, `src/frontend.tsx` |
| `frontend-only` | 前端 React 19 渲染层 | `package.json`, `tsconfig.json`, `src/index.ts`, `src/frontend.tsx` |

**官方 Skill 资源与存储库**：[github.com/aymwoo/openlearn-skills](https://github.com/aymwoo/openlearn-skills)

> 💡 **提示**：在开发复杂插件时，直接使用 AI Skill 生成的基础代码天然遵循平台的 5 阶段启动流水线、DI Token 依赖注入与沙箱隔离规范，可提升 5~10 倍的开发效率。

## 3. 插件结构详解

### 3.1 Manifest 完整规范

```typescript
interface Manifest {
  id: string;                    // 唯一标识，推荐格式 @scope/name
  name: string;                  // 显示名称
  version: string;               // SemVer 版本号（如 "1.0.0"）
  main?: string;                 // 入口文件名，默认 "index.js"
  description?: string;          // 描述
  author?: string;               // 作者
  engines?: {                    // 引擎版本约束
    openlearn?: string;          // 宿主 API 版本，如 "^2.5.0"
  };
  requires: string[];            // 依赖的服务 Token（格式 @openlearn/core:TokenName@^1.0.0）
  optional?: string[];           // 可选依赖
  capabilitiesProposed: string[]; // 申请的权限（如 "lesson:write", "vfs:read"）
  classroomTools?: ClassroomTool[]; // 前端课堂工具声明
  provides?: string[];           // V3.2: 插件对外提供的自定义服务 Token 名称
  configuration?: {              // V3.2: 声明式配置 schema
    properties: Record<string, ConfigProperty>;
  };
  updateSource?: {               // V3.4.3: 远端更新源声明
    type: 'github-release' | 'gitee-release';
    repo: string;                // 仓库路径，如 "user/repo-name"
  };
}

interface ConfigProperty {
  type: 'string' | 'number' | 'boolean' | 'integer';
  default?: unknown;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

interface ClassroomTool {
  id: string;         // 工具 ID
  name: string;       // 工具名称
  icon: string;       // 图标（使用 lucide-react icon name，如 "BarChart3"）
  commandType: string; // 关联的命令类型
  payload?: any;      // 默认 payload
}
```

#### 3.1.1 远端更新检测（V3.4.3 新增）

在 `manifest.json` 中声明 `updateSource` 字段后，平台插件中心可自动检测远端仓库（GitHub / Gitee）Release 中的新版本，并支持一键热更新。

```json
{
  "updateSource": {
    "type": "github-release",
    "repo": "user/plugin-repo-name"
  }
}
```

**检测机制**：
1. 服务端优先使用 `git ls-remote --tags` 获取所有 semver tag，若不可用则回退到 GitHub/Gitee Releases HTTP API
2. 优先推荐最新稳定版；若无稳定版更新则提示预发布（pre-release）版本
3. Version tag 需遵循 semver 格式（可带 `v` 前缀），如 `v1.2.0`、`2.0.0-beta.1`

**下载与安装**：
- 服务端优先从 Release Assets 中拉取 `.zip` 更新包直接安装
- 若服务端下载超时（15s），自动切换至浏览器直传安装
- 用户可在插件卡片上点击「检查更新」手动触发检测

> 💡 **提示**：`updateSource` 为可选字段。不声明此字段的插件仍可通过 ZIP 拖放或上传方式安装更新。

### 3.2 PluginContext — 插件上下文的完整 API

插件通过 `activate(ctx)` 接收上下文对象。`ctx.services` 直接提供 7 个内核服务，无需 DI 解析：

| 服务 | 访问方式 | 用途 |
|------|---------|------|
| CommandBus | `ctx.services.commandBus` | 注册/执行命令 |
| EventBus | `ctx.services.eventBus` | 发布/订阅事件 |
| ActionRegistry | `ctx.services.actionRegistry` | 注册 AI 工具 |
| Capability | `ctx.services.capability` | 权限管理 |
| Process | `ctx.services.processManager` | 后台进程 |
| Storage | `ctx.services.storage` | K-V 存储 |
| AI | `ctx.services.ai` | 文本生成 |

通过 DI 解析更多服务（`IDatabaseToken`、`IPluginHostToken` 等）：

```typescript
import { IDatabaseToken } from '@openlearn/plugin-sdk';
const db = await ctx.resolve(IDatabaseToken);

```

### 3.3 命令-事件-Action 三件套

这是插件开发的核心模式。每个业务功能需要三样东西：

#### 3.3.1 Action 注册（AI Agent 可调用）

```typescript
await actionRegistry.register({
  id: 'my-plugin-action',          // 唯一 ID
  commandType: 'myplugin.action',   // 对应的命令类型
  description: '用中文描述此工具的功能和参数',
  capabilityRequired: 'myplugin:write',  // 所需权限
  isHighRisk: false,               // 是否高危（需教师审批）
  inputSchema: {                   // JSON Schema（Google GenAI 格式）
    type: 'OBJECT',
    properties: {
      param1: { type: 'STRING', description: '参数说明' },
      param2: { type: 'NUMBER', description: '参数说明' },
    },
    required: ['param1'],
  },
});
```

#### 3.3.2 Command Handler（业务逻辑）

```typescript
await commandBus.registerHandler('myplugin.action', {
  async execute(command) {
    const payload = command.payload as any;
    const { param1, param2 } = payload;

    // 业务逻辑...
    const result = await doSomething(param1, param2);

    // 发布事件通知其他模块
    await eventBus.publish({
      id: crypto.randomUUID(),
      type: 'myplugin.action_done',    // 过去式命名
      source: 'plugin.myplugin',        // 来源标识
      payload: { param1, result },
      timestamp: Date.now(),
      correlationId: command.id,
    });

    return { success: true, result };
  },
});
```

#### 3.3.3 Event 发布

事件命名规则：**过去式**，点号分隔，如 `lesson.created`、`assignment.graded`。

```typescript
await eventBus.publish({
  id: crypto.randomUUID(),
  type: 'myplugin.action_done',
  source: 'plugin.myplugin',
  payload: { /* 业务数据 */ },
  timestamp: Date.now(),
  correlationId: command.id,  // 关联原始命令
});
```

**⚠️ classroomTools 必须注册 Handler：**

`classroomTools[].commandType` 声明了教师点击工具按钮时执行的命令。**必须**在服务端 `activate()` 中用 `commandBus.registerHandler()` 注册对应的处理器，否则系统会报 `No handler registered for command: xxx`。

即使命令不执行实际业务逻辑（仅用于触发前端面板打开），也需注册一个空 handler：

```typescript
await commandBus.registerHandler('myplugin.open_panel', {
  async execute() {
    return { panel: 'teacher' };
  },
});
```

---

## 4. 手把手实例项目

### 4.1 项目：随堂投票插件

我们将创建一个完整的"随堂投票"插件，教师可以在白板上创建投票，学生提交选票，实时显示结果。

#### 4.1.1 创建数据库表

```typescript
// poll-plugin.ts
export default {
  manifest: {
    id: '@openlearn/plugin-poll',
    name: '随堂投票插件',
    version: '1.0.0',
    main: 'index.js',
    description: '在课堂上创建实时投票，收集学生回答',
    author: 'Your Name',
    engines: { openlearn: '^2.5.0' },
    requires: [
      '@openlearn/core:ICommandBusService@^1.0.0',
      '@openlearn/core:IActionRegistryService@^1.0.0',
      '@openlearn/core:IEventBusService@^1.0.0',
      '@openlearn/core:IDatabase@^1.0.0',
      '@openlearn/core:IProcessService@^1.0.0',
    ],
    capabilitiesProposed: ['lesson:write', 'poll:write', 'poll:read'],
    classroomTools: [
      {
        id: 'poll-tool',
        name: '📊 投票',
        icon: 'BarChart3',
        commandType: 'poll.create',
        payload: { type: 'single_choice' },
      },
    ],
  },

  activate: async (ctx) => {
    const commandBus = ctx.services.commandBus;
    const actionRegistry = ctx.services.actionRegistry;
    const eventBus = ctx.services.eventBus;

    // DI 解析数据库访问
    const { IDatabaseToken } = await import('@openlearn/plugin-sdk');
    const db = await ctx.resolve(IDatabaseToken);


    // ── 1. 创建投票表 ──
    await ctx.db.ensureTable('polls', `
      id          TEXT PRIMARY KEY,
      lesson_id   TEXT NOT NULL,
      title       TEXT NOT NULL,
      options     TEXT NOT NULL,   -- JSON: ["选项A", "选项B", ...]
      is_active   INTEGER DEFAULT 1,
      created_at  INTEGER NOT NULL
    `);

    await ctx.db.ensureTable('poll_votes', `
      id          TEXT PRIMARY KEY,
      poll_id     TEXT NOT NULL,
      student_id  TEXT NOT NULL,
      choice      TEXT NOT NULL,
      voted_at    INTEGER NOT NULL,
      UNIQUE(poll_id, student_id)
    `);

    const pollsTable = ctx.db.table('polls');
    const votesTable = ctx.db.table('poll_votes');

    // ── 2. Action: 创建投票 ──
    await actionRegistry.register({
      id: 'poll-create',
      commandType: 'poll.create',
      description: '在课程中创建一个随堂投票，教师可选择单选或多选模式',
      capabilityRequired: 'poll:write',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          lessonId: { type: 'STRING', description: '课程 ID' },
          title: { type: 'STRING', description: '投票标题/问题' },
          options: { type: 'STRING', description: '选项列表 JSON，如 ["同意","不同意","弃权"]' },
          mode: { type: 'STRING', description: '投票模式：single_choice 或 multiple_choice' },
        },
        required: ['lessonId', 'title', 'options'],
      },
    });

    // ── 3. Handler: 创建投票 ──
    await commandBus.registerHandler('poll.create', {
      async execute(command) {
        const payload = command.payload as any;
        const pollId = crypto.randomUUID();
        const options = typeof payload.options === 'string'
          ? payload.options
          : JSON.stringify(payload.options);

        db.prepare(`INSERT INTO ${pollsTable} (id, lesson_id, title, options, created_at)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(pollId, payload.lessonId, payload.title, options, Date.now());

        await eventBus.publish({
          id: crypto.randomUUID(),
          type: 'poll.created',
          source: 'plugin.poll',
          payload: { pollId, lessonId: payload.lessonId, title: payload.title },
          timestamp: Date.now(),
          correlationId: command.id,
        });

        return { pollId, message: '投票「${payload.title}」已创建' };
      },
    });

    // ── 4. Action: 学生投票 ──
    await actionRegistry.register({
      id: 'poll-vote',
      commandType: 'poll.vote',
      description: '学生对投票进行选择',
      capabilityRequired: 'poll:read',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          pollId: { type: 'STRING', description: '投票 ID' },
          choice: { type: 'STRING', description: '选择的选项文本' },
        },
        required: ['pollId', 'choice'],
      },
    });

    await commandBus.registerHandler('poll.vote', {
      async execute(command) {
        const payload = command.payload as any;
        const voteId = crypto.randomUUID();

        db.prepare(`INSERT OR REPLACE INTO ${votesTable}
                    (id, poll_id, student_id, choice, voted_at)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(voteId, payload.pollId, command.actorId, payload.choice, Date.now());

        const stats = db.prepare(`
          SELECT choice, COUNT(*) as count
          FROM ${votesTable}
          WHERE poll_id = ?
          GROUP BY choice
        `).all(payload.pollId);

        await eventBus.publish({
          id: crypto.randomUUID(),
          type: 'poll.vote_cast',
          source: 'plugin.poll',
          payload: { pollId: payload.pollId, stats },
          timestamp: Date.now(),
          correlationId: command.id,
        });

        return { success: true, stats };
      },
    });

    // ── 5. Action: 查询投票结果 ──
    await actionRegistry.register({
      id: 'poll-results',
      commandType: 'poll.get_results',
      description: '查询指定投票的实时统计结果',
      capabilityRequired: 'poll:read',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          pollId: { type: 'STRING', description: '投票 ID' },
        },
        required: ['pollId'],
      },
    });

    await commandBus.registerHandler('poll.get_results', {
      async execute(command) {
        const payload = command.payload as any;

        const poll = db.prepare(`SELECT * FROM ${pollsTable} WHERE id = ?`)
          .get(payload.pollId) as any;
        if (!poll) throw new Error('投票未找到');

        const stats = db.prepare(`
          SELECT choice, COUNT(*) as count
          FROM ${votesTable}
          WHERE poll_id = ?
          GROUP BY choice
        `).all(payload.pollId);

        return {
          pollId: poll.id,
          title: poll.title,
          options: JSON.parse(poll.options),
          results: stats,
          total: stats.reduce((sum: number, s: any) => sum + s.count, 0),
        };
      },
    });

    // ── 6. 使用结构化日志 ──
    ctx.log.info('Poll plugin activated successfully', { pollTable: pollsTable });
  },

  deactivate: async () => {
    // ctx.db.dropAllTables() 由 PluginHost 自动调用
    console.log('[Poll Plugin] Deactivated');
  },
};
```

#### 4.1.2 在系统设置中安装

1. 进入「系统设置」→「插件中心」
2. 将上述代码粘贴到代码编辑器
3. 点击「安装插件」
4. 在插件列表中找到 `@openlearn/plugin-poll`，点击激活

#### 4.1.3 使用 AI Agent 调用

安装后，AI Agent 自动获得以下工具：

```
poll.create   — 创建随堂投票
poll.vote     — 学生投票
poll.get_results — 查询结果
poll.close    — 关闭投票
```

教师可以直接对 AI 说：**"在今天的物理课上创建一个投票，问题是'光速是否为宇宙中最快的速度？'，选项为：是、否、不确定"**

---

## 5. API 及接口文档

### 5.1 命令定义

```typescript
interface PlatformCommand<T = unknown> {
  id: string;           // UUID v7
  type: string;         // 命令类型，点号分隔如 "lesson.create"
  actorId: string;      // 操作者 ID
  payload: T;           // 命令载荷
  timestamp: number;    // Unix 毫秒时间戳
  metadata?: {
    correlationId?: string;     // 关联 ID
    agentDelegated?: boolean;   // 是否由 AI Agent 代理
    undoable?: boolean;         // 是否可撤销
    [key: string]: unknown;
  };
}
```

### 5.2 服务 Token（依赖注入）

| Token 常量 | 标识符 | 返回类型 | 用途 |
|-----------|--------|---------|------|
| `ICommandBusServiceToken` | `@openlearn/core:ICommandBusService` | `ICommandBusService` | 命令执行、注册 |
| `IEventBusServiceToken` | `@openlearn/core:IEventBusService` | `IEventBusService` | 事件发布/订阅 |
| `IActionRegistryServiceToken` | `@openlearn/core:IActionRegistryService` | `IActionRegistryService` | AI 工具注册 |
| `ICapabilityServiceToken` | `@openlearn/core:ICapabilityService` | `ICapabilityService` | 权限管理 |
| `IProcessServiceToken` | `@openlearn/core:IProcessService` | `IProcessService` | 后台进程 |
| `IStorageServiceToken` | `@openlearn/core:IStorageService` | `IStorageService` | K-V 存储 |
| `IAIServiceToken` | `@openlearn/core:IAIService` | `IAIService` | AI 文本生成 |
| `IDatabaseToken` | `@openlearn/core:IDatabase` | `Database` (better-sqlite3) | 直接 SQL 访问 |

> **⚠️ better-sqlite3 版本差异**：`ctx.resolve(IDatabaseToken)` 返回宿主进程的 `better-sqlite3` `Database` 实例。可用 API 取决于宿主安装版本，`exec()` 仅 v9.0+ 可用，建议优先使用 `prepare().run()` / `.get()` / `.all()`。
| `IPluginHostToken` | `@openlearn/core:IPluginHost` | `PluginHost` | 插件主机管理 |
| `ISemesterGradeServiceToken` | `@openlearn/core:ISemesterGradeService` | `ISemesterGradeService` | 学期成绩管理 |

在 `manifest.requires` 中使用格式：`@openlearn/core:TokenName@^1.0.0`

在代码中解析：
```typescript
import { IDatabaseToken } from '@openlearn/plugin-sdk';
const db = await ctx.resolve(IDatabaseToken);

```

### P7-A2 统一插件服务（Unified Plugin Services）

P7-A2 将原本分散在插件宿主内部的能力收敛为一组统一的门面（Facade）服务。插件无需感知内核装配细节，直接经 `ctx.resolve(...)` 即可消费。下列 Token 已在 `@openlearn/plugin-sdk` 中导出，返回类型亦同包提供。

| Token 常量 | 标识字符串 | 返回类型 | 用途 |
|-----------|-----------|---------|------|
| `IPluginLifecycleManagerToken` | `@openlearn/core:IPluginLifecycleManager` | `PluginLifecycleManager` | 插件的安装 / 卸载 / 启用 / 停用等生命周期管理 |
| `IPluginDistributionManagerToken` | `@openlearn/core:IPluginDistributionManager` | `PluginDistributionManager` | 插件分发：ZIP 上传、版本与市场 |
| `IPluginRuntimeCompositionToken` | `@openlearn/core:IPluginRuntimeComposition` | `PluginRuntimeComposition` | 统一运行时组合（内核 + 插件运行时适配） |
| `IUnifiedExtensionRegistryToken` | `@openlearn/core:IUnifiedExtensionRegistry` | `UnifiedExtensionRegistry` | 扩展点统一注册表 |
| `IPluginCapabilityGatewayToken` | `@openlearn/core:IPluginCapabilityGateway` | `PluginCapabilityGateway` | 插件能力网关：列举 / 查询能力 |
| `ICapabilityRegistryToken` | `@openlearn/core:ICapabilityRegistry` | `CapabilityRegistry` | 能力注册表：底层能力元数据 |

在 `manifest.requires` 中声明依赖，格式为 `@openlearn/core:TokenName@^1.0.0`，例如：

```json
{
  "requires": [
    "@openlearn/core:IPluginLifecycleManager@^1.0.0",
    "@openlearn/core:IPluginCapabilityGateway@^1.0.0"
  ]
}
```

在代码中解析：

```typescript
import {
  IPluginLifecycleManagerToken,
  IPluginCapabilityGatewayToken,
} from '@openlearn/plugin-sdk';

const lifecycle = await ctx.resolve(IPluginLifecycleManagerToken); // 类型: PluginLifecycleManager
const gateway = await ctx.resolve(IPluginCapabilityGatewayToken);   // 类型: PluginCapabilityGateway

await lifecycle.uninstallPlugin(pluginId);
gateway.listCapabilities().forEach((c) => console.log(c.id));
```

> 注意：这些统一服务由内核在启动期装配完成，插件侧仅通过 Token 消费，避免在插件代码中直接依赖 `@openlearn/core` 的内部模块。


### 5.3 ICommandBusService

```typescript
interface ICommandBusService {
  execute<T>(command: PlatformCommand<T>): Promise<unknown>;
  registerHandler(commandType: string, handler: { execute(cmd: PlatformCommand): Promise<any> }): Promise<void>;
  unregisterHandler(commandType: string): Promise<void>;
  createCommand<T>(type: string, payload: T, actorId: string, metadata?: CommandMetadata): Promise<PlatformCommand<T>>;
  setInterceptor(interceptor: (command: PlatformCommand) => Promise<void>): Promise<void>;
}
```

### 5.4 IEventBusService

```typescript
interface IEventBusService {
  publish(event: PlatformEvent): Promise<void>;
  subscribe(eventType: string, subscriber: (event: PlatformEvent) => void | Promise<void>): Promise<void>;
  unsubscribe(eventType: string, subscriber: (event: PlatformEvent) => void | Promise<void>): Promise<void>;
}
```

**重要**: `subscribe('*', handler)` 可订阅所有事件。事件订阅器在插件 deactivate 时由 ResourceTracker 自动取消。

### 5.5 IActionRegistryService

```typescript
interface ActionDescriptor {
  id: string;                // 唯一 ID
  commandType: string;        // 对应命令类型
  description: string;        // 对 AI Agent 的功能描述（中文）
  inputSchema: any;           // JSON Schema（Google GenAI 格式）
  capabilityRequired: string; // 所需权限
  isHighRisk?: boolean;       // 高危操作需审批
}

interface IActionRegistryService {
  register(descriptor: ActionDescriptor): Promise<void>;
  unregister(id: string): Promise<void>;
  getAllActions(): Promise<ActionDescriptor[]>;
  getAgentTools(): Promise<unknown[]>;
  getActionByToolName(toolName: string): Promise<ActionDescriptor | undefined>;
  getActionByCommandType(commandType: string): Promise<ActionDescriptor | undefined>;
}
```

### 5.6 inputSchema 格式规范

遵循 Google GenAI `functionDeclarations` 格式：

```typescript
{
  type: 'OBJECT',
  properties: {
    stringParam:  { type: 'STRING',  description: '字符串参数说明' },
    numberParam:  { type: 'NUMBER',  description: '数值参数说明' },
    boolParam:    { type: 'BOOLEAN', description: '布尔参数说明' },
    arrayParam:   { type: 'ARRAY',   description: '数组参数说明',
                    items: { type: 'STRING' } },
  },
  required: ['stringParam'],  // 必填参数
}
```

### 5.7 IAIService

```typescript
interface IAIService {
  generateText(
    prompt: string,
    options?: {
      systemInstruction?: string;   // 系统指令
      temperature?: number;         // 温度 (0-1)
    },
  ): Promise<string>;
}
```

使用示例：
```typescript
const summary = await ctx.services.ai.generateText(
  `请分析以下学生作业并给出评分：\n${homework}`,
  {
    systemInstruction: '你是一位教学助手，请用中文回复。',
    temperature: 0.3,
  }
);
```

### 5.8 IStorageService

```typescript
interface IStorageService {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
```

底层使用 SQLite `plugin_storage` 表，自动按插件 namespace 隔离。

### 5.9 PluginDatabaseAPI

```typescript
interface PluginDatabaseAPI {
  ensureTable(tableName: string, schema: string): Promise<void>;
  table(tableName: string): string;                      // 返回完整表名
  dropAllTables(): Promise<void>;
  migrate(targetVersion: number, upgradeFn: (db: any) => Promise<void> | void): Promise<void>;
}
```

**新增 `migrate()` 方法**：支持声明式数据库版本迁移，参数 `version` 表示目标版本号，若当前版本低于目标版本则执行 `upgradeFn`。

示例：`ctx.db.table('polls')` 返回 `plugin_@openlearn/plugin-poll_polls`。

**从 DI 获取原始 Database 实例的方法限制：**

`ctx.resolve(IDatabaseToken)` 返回宿主编译的 `better-sqlite3` `Database` 实例。由于宿主可能在较老版本的 better-sqlite3 上运行，建议只使用以下兼容方法：

| 方法 | better-sqlite3 版本要求 | 说明 |
|------|------------------------|------|
| `prepare().run()` | 全版本 | 执行单条 SQL |
| `prepare().get()` | 全版本 | 查询单行 |
| `prepare().all()` | 全版本 | 查询多行 |
| `exec()` | >= 9.0.0 | 批量执行多条 SQL（**Worker 模式不可用**） |
| `pragma()` | >= 4.0.0 | PRAGMA 语句 |
| `transaction()` | 全版本 | 事务包装 |

**最佳实践：**

- 使用 `prepare().run()` 逐条执行，代替 `exec()` 批量执行
- 使用 `ctx.db.ensureTable()` + `ctx.db.table()` 管理表名，不要手动拼接
- 数据库操作优先使用 `ctx.db` PluginDatabaseAPI 封装，仅在需要精细控制时直接操作 Database 实例

### 5.10 IPluginLogger（V2.5 新增）

```typescript
interface IPluginLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
```

自动注入 `pluginId` 和 `timestamp`，替代传统 `console.log`。示例：

```typescript
ctx.log.info('Activation completed', { handlerCount: 5 });
ctx.log.error('DB migration failed', { error: err.message });
```

### 5.11 IConfigService（V3.2 新增）

```typescript
interface IConfigService {
  get<T = unknown>(key: string): T;
  getAll(): Record<string, unknown>;
  set(key: string, value: unknown): Promise<void>;
  onChange(callback: (key: string, newValue: unknown, oldValue: unknown) => void): () => void;
}
```

配合 `manifest.configuration` 声明使用，自动应用默认值。示例：

```typescript
// manifest 中声明：
// configuration: {
//   properties: {
//     maxOptions: { type: 'number', default: 10, description: '最大选项数' },
//     enableAnonVoting: { type: 'boolean', default: false },
//   }
// }

const maxOptions = ctx.config.get<number>('maxOptions'); // 10
ctx.config.onChange('maxOptions', (newVal, oldVal) => {
  ctx.log.info('Config changed', { key: 'maxOptions', oldVal, newVal });
});
```

> **系统内置配置键**：`showInDashboard`（`boolean`）是一个被框架识别的特殊键。当插件在 `configuration.properties` 中声明此键后，插件卡片的「总览」开关可用，关闭后将隐藏 `teacher.dashboard.widget` 注册的小部件。此行为由框架在渲染层实现，无需插件自行处理。

### 5.12 共享模块 require（V2.5）

插件可通过 `ctx.require()` 引用白名单中的 npm 包，无需自行打包：

```typescript
const recharts = ctx.require('recharts');
```

### 5.13 ResourceService（V2.5 新增）

插件可通过 Command Bus 直接操作系统资源库（`system_resources` 表），无需自行发起 HTTP 请求。

**命令列表：**

| 命令 | payload | 返回值 | 说明 |
|------|---------|--------|------|
| `resource.list` | `{}` | `{ resources: [...] }` | 列出所有资源（id, name, type, created_at） |
| `resource.get` | `{ id }` | `{ resource: {...} }` | 获取单个资源完整内容（含 content 字段） |
| `resource.create` | `{ name, type, content }` | `{ success, id }` | 创建新资源。type 为 `"html"` 或 `"folder"` |
| `resource.delete` | `{ id }` | `{ success }` | 删除指定资源 |

**调用的能力要求**：`resource.create` 和 `resource.delete` 需要 `file:write` 权限，插件须在 `capabilitiesProposed` 中声明。

**使用示例：**

```typescript
// 查询所有资源
const { resources } = await ctx.services.commandBus.execute('resource.list', {});

// 创建 HTML 课件资源
const { id } = await ctx.services.commandBus.execute('resource.create', {
  name: 'my-courseware-v1',
  type: 'html',
  content: '<html>...</html>',
});

// 读取资源内容
const { resource } = await ctx.services.commandBus.execute('resource.get', { id });
console.log(resource.content);
```

**注意**：当前 ResourceService 未注册为 ActionRegistry 条目，因此不能通过 AI Agent 的 function call 触发，仅供插件代码内直接调用。
const pdf = ctx.require('jspdf');
const markdown = ctx.require('react-markdown');
const xlsx = ctx.require('xlsx');
const icons = ctx.require('lucide-react');
const uuid = ctx.require('uuid');
```

### 5.13 权限字符串规范

```
格式: {resource}:{action}
示例:
  lesson:read        — 读取课程
  lesson:write       — 创建/编辑课程
  lesson:delete      — 删除课程
  whiteboard:read    — 读取白板
  whiteboard:write   — 编辑白板
  vfs:read           — 读取虚拟文件系统
  vfs:write          — 写入虚拟文件系统
  process:write      — 创建后台进程
  assignment:write   — 编辑作业
  management:read    — 读取管理数据
  management:write   — 写入管理数据

通配符: lesson:* 匹配 lesson:read, lesson:write, lesson:delete
```

---

## 6. 前端插件系统

### 6.1 FrontendPluginHost

前端插件运行在浏览器中，通过动态 `import()` 加载 ESM 模块，支持 inline 和 worker 两种执行模式：

```typescript
// 前端插件结构
export default {
  manifest: {
    id: '@scope/frontend-plugin',
    name: '前端插件',
    version: '1.0.0',
    author: 'Author',
    capabilitiesProposed: [],
    classroomTools: [
      {
        id: 'my-tool',
        name: '🔧 我的工具',
        icon: 'Wrench',
        commandType: 'myplugin.tool_action',
        payload: {},
      },
    ],
  },

  activate: async (ctx: FrontendPluginContext) => {
    // ctx.services.frontendApi   — HTTP API 调用
    // ctx.services.socketService  — WebSocket 通信
    // ctx.services.uiService      — Toast/Modal UI
    // ctx.services.storageService  — localStorage

    ctx.ui.registerExtensionPoint('teacher.tab', {
      id: 'my-tab',
      label: '我的面板',
      icon: 'Layout',
      component: () => import('./MyPanel'),
      position: 10,
      pluginId: ctx.pluginId,
    });
  },
};
```

### 6.2 FrontendPluginContext

```typescript
interface FrontendPluginContext {
  services: {
    frontendApi: IFrontendAPI;        // HTTP API 调用
    socketService: ISocketService;    // WebSocket 通信
    uiService: IUIService;            // Toast/Modal/文件下载
    storageService: IStorageService;  // localStorage
  };
  pluginId: string;
  manifest: FrontendPluginManifest;
  ui: {
    registerExtensionPoint(slot: ExtensionSlot, config: ExtensionPointConfig): void;
    unregisterExtensionPoint(slot: ExtensionSlot, id: string): void;
  };
  invokeCommand<T = any>(type: string, payload?: any): Promise<T>; // V2.5: 调用后端 Command Handler
}
```

### 6.3 前端服务接口

```typescript
interface IFrontendAPI {
  get<T>(path: string): Promise<{ success: boolean; result?: T; error?: string }>;
  post<T>(path: string, body?: any): Promise<{ success: boolean; result?: T; error?: string }>;
  del<T>(path: string): Promise<{ success: boolean; result?: T; error?: string }>;
}

interface ISocketService {
  emit(event: string, ...args: any[]): void;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  disconnect(): void;
}

interface IUIService {
  showToast(title: string, message: string, type: 'info' | 'success' | 'warning'): void;
  showModal(title: string, content: React.ReactNode): void;
  closeModal(): void;
  downloadFile(data: Blob | string, filename: string, mimeType?: string): void;
}
```

### 6.4 可用的 UI 扩展槽位

| Slot | 用途 |
|------|------|
| `teacher.tab` | 教师标签页 |
| `teacher.panel` | 教师独立全宽管理面板（v3.2） |
| `teacher.dashboard.widget` | 教师仪表盘小部件 |
| `student.view` | 学生视图 |
| `student.fullscreen` | 学生全屏视图/考试模式（v3.2） |
| `student.lesson.tool` | 学生学习工具 |

**学生端插件获取当前学生 ID**：宿主在渲染学生端扩展点（`student.view`、`student.fullscreen`）时，自动通过 `slotProps` 注入当前登录学生 ID。插件组件通过 props 接收：

```tsx
// 前端插件入口 frontend.tsx
export default function MyStudentPlugin(props: { studentId?: string }) {
  const studentId = props.studentId;
  if (!studentId) return <div>请先登录学生账号</div>;
  
  // 使用 studentId 获取该学生的个人数据
  return <div>当前学生 ID: {studentId}</div>;
}
```
| `classroom.tool` | 课堂工具 |
| `global.setting` | 全局设置页扩展（v3.2） |

### 6.5 invokeCommand（自 V2.5 起可用）

前端插件可以通过 `ctx.invokeCommand()` 调用后端已注册的 Command Handler：

```typescript
// 前端插件中调用后端命令
const result = await ctx.invokeCommand('poll.get_results', { pollId: 'xxx' });
// 命令类型会自动添加插件命名空间前缀
```

### 6.6 宿主依赖共享网关 (HostSharedDeps)

> **⚠️ JSX 运行时限制**：`HostSharedDeps` 仅提供 `React` 和 `ReactDOM` 经典运行时，**不包含 `react/jsx-runtime`**。插件前端代码必须使用经典 JSX 转换（`"jsx": "react-jsx"` 不可用）：
> 
> ```json
> // tsconfig.json — 插件项目
> { "compilerOptions": { "jsx": "react" } }  // 经典模式，不是 "react-jsx"
> ```
> 
> 或 esbuild 配置：
> ```javascript
> esbuild.build({
>   jsxFactory: "React.createElement",
>   jsxFragment: "React.Fragment",
>   external: ["react", "react-dom", "recharts", "lucide-react"],
> });
> ```

为避免每个第三方插件前端重复打包庞大的基础库，OpenLearnV2 提供了 **宿主依赖共享网关 (HostSharedDeps)**。全局 `window.HostSharedDeps` 暴露以下对象：

- `React` (npm: react)
- `ReactDOM` (npm: react-dom)
- `Recharts` (npm: recharts)
- `LucideReact` (npm: lucide-react)

插件前端构建时需将这些库配置为 external：

```javascript
import esbuild from 'esbuild';

esbuild.build({
  entryPoints: ['src/frontend.tsx'],
  bundle: true,
  outfile: 'dist/frontend.js',
  external: ['react', 'react-dom', 'recharts', 'lucide-react'],
  format: 'esm',
});
```

### 6.7 前端 JSX 转换配置（重要）

宿主通过 `window.HostSharedDeps` 提供的基础库：

| 共享对象 | NPM 包 | 提供的内容 |
|----------|--------|-----------|
| `HostSharedDeps.React` | `react` | React 对象（包含 `createElement`） |
| `HostSharedDeps.ReactDOM` | `react-dom` | ReactDOM 对象 |
| `HostSharedDeps.Recharts` | `recharts` | Recharts 组件库 |
| `HostSharedDeps.LucideReact` | `lucide-react` | Lucide 图标库 |

**宿主不提供** `react/jsx-runtime` 子路径。因此构建前端时**必须使用经典 JSX 转换**（`React.createElement`），不能使用自动 JSX 运行时。

**tsconfig.json 配置：**

```json
{
  "compilerOptions": {
    "jsx": "react"
  }
}
```

> `"jsx"` 必须是 `"react"`，不能是 `"react-jsx"`。

**esbuild 构建注意事项：**

esbuild 默认读取项目根目录的 `tsconfig.json`。如果 tsconfig 中 `"jsx"` 设为 `"react-jsx"`，无论 build API 中如何设置 `jsx: 'transform'` 或 `jsxFactory`，都会被 tsconfig 覆盖，最终产物仍会包含 `import ... from "react/jsx-runtime"` 导致运行时错误。

**推荐 esbuild 构建配置：**

```javascript
import esbuild from 'esbuild';

esbuild.build({
  entryPoints: ['src/frontend.tsx'],
  bundle: true,
  outfile: 'dist/frontend.js',
  external: ['react', 'react-dom', 'recharts', 'lucide-react'],
  format: 'esm',
  platform: 'browser',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
});
```

**常见错误排查：**

| 错误信息 | 原因 | 解决方法 |
|----------|------|----------|
| `Failed to resolve module specifier "react/jsx-runtime"` | `tsconfig.json` 中 `jsx` 为 `"react-jsx"` | 改为 `"react"` |
| `React is not defined` | 前端未声明 `react` 为 `peerDependency` 或 `external` | 在构建配置中添加 `external: ['react']` |
| `process is not defined` | 构建 `platform` 未设为 `browser` | 设置 `platform: 'browser'` |

### 6.8 前端组件如何获取通信能力（完整示例）

前端插件的组件通过**模块级变量**拿到 `invokeCommand` 和扩展点注册能力。关键点：

- `registerExtensionPoint` 的 `component` 必须用**普通函数**声明（`function MyPanel() {}`），不要用箭头函数（esbuild 打包后闭包可能出问题）
- 组件通过模块级变量拿 `ctx`，因为扩展点组件不是由你的组件树渲染，props 不可控
- `default export` 是 `{ activate, deactivate }` 对象，不是组件本身

**完整示例：**

```typescript
// src/frontend.tsx

let ctx: any = null;

// ① 组件必须用普通 function 声明（不要用箭头函数）
function MyPanel() {
  const [data, setData] = React.useState([]);

  React.useEffect(() => {
    // 通过模块级变量拿到 invokeCommand
    ctx.invokeCommand('myplugin.list').then(setData);
  }, []);

  return React.createElement('div', null,
    data.map((item: any) =>
      React.createElement('div', { key: item.id }, item.name)
    )
  );
}

function MyWidget() {
  return React.createElement('div', null, '仪表盘卡片');
}

// ② activate 接收 host 传入的 FrontendPluginContext，存到模块变量
async function activate(hostCtx: any) {
  ctx = hostCtx;  // ← 关键：hostCtx 自带 invokeCommand、ui.registerExtensionPoint 等

  hostCtx.ui.registerExtensionPoint('teacher.tab', {
    id: 'my-tab',
    label: '我的面板',
    icon: 'Layout',
    component: MyPanel,     // ← 普通函数引用，不是 () => <MyPanel/>
    position: 10,
  });

  hostCtx.ui.registerExtensionPoint('teacher.dashboard.widget', {
    id: 'my-widget',
    label: '我的卡片',
    icon: 'BarChart3',
    component: MyWidget,
    position: 0,
  });
}

function deactivate() {}

// ③ default export 必须是 { activate, deactivate } 对象
export default { activate, deactivate };
```

**为什么 component 不能用箭头函数？**

esbuild 在打包箭头函数时可能改变其闭包作用域，导致 `React.createElement` 引用丢失。使用 `function` 声明可保证构建后的函数引用稳定。

**为什么通过模块级变量拿 ctx 而不是 props？**

扩展点组件由宿主渲染，props 由宿主控制。宿主向扩展点组件传递的 props 是宿主定义的（如 `studentId`、`lessonId` 等业务数据），不包含 `invokeCommand`。因此 API 调用能力必须通过模块级闭包变量传递。

---

## 7. 安全与权限

### 7.1 高危操作审批

设置 `isHighRisk: true` 的 Action，AI Agent 执行时会进入审批流程：

```typescript
await actionRegistry.register({
  id: 'dangerous-op',
  commandType: 'lesson.delete',
  description: '删除课程。高风险操作。',
  capabilityRequired: 'lesson:delete',
  isHighRisk: true,  // ← 需要教师审批
  inputSchema: { ... },
});
```

执行流程：
1. AI Agent 调用此工具
2. 命令被写入 `pending_commands` 审批表
3. 教师收到审批通知
4. 教师可选择批准、拒绝或修改参数
5. 批准后才实际执行

**注意**：`administrator` 角色执行时自动绕过高危审批。

### 7.2 权限模型

- 插件通过 `capabilitiesProposed` 声明所需权限
- 教师/管理员在安装时可审查权限
- 运行时通过 CapabilityGuard 拦截检查
- 支持通配符匹配（如 `lesson:*` 匹配所有课程操作）

### 7.3 指令隔离与命名空间保护

为防止第三方插件恶意冒充、拦截或篡改内核及其他插件的敏感指令，OpenLearnV2 实施了 **命名空间防欺骗保护**：

**命令解析规则**：
1. **系统和内核插件**（`@openlearn/` 前缀）：继承全局命名空间访问权，直接使用全局指令名称
2. **第三方插件指令**：统一自动添加 `{manifest.id}.` 前缀（如 `courseware.query` -> `@courseware-hub/plugin.courseware.query`），防止跨插件指令冲突与越权劫持
3. **前缀显式声明**：若指令名已包含本插件前缀 `{manifest.id}.`，则保持原样，避免重复加前缀

**防越权劫持**：
- 内核在命令注册阶段自动执行 UUID 强检查
- 第三方插件企图注册以其他非本插件 UUID 格式为前缀的指令时，注册拦截器抛出异常并阻止激活

---

## 8. 高级特性

### 8.1 Worker Thread 隔离模式

在生产环境中，插件可在独立 Worker Thread 中运行：

```typescript
// 数据库设置 execution_mode
db.prepare("UPDATE plugins SET execution_mode = 'worker' WHERE id = ?").run(pluginId);
```

Worker 模式的特点：
- 独立线程隔离，崩溃不影响主进程
- 通过 RPC 代理访问内核服务（MethodProxy + EventBusProxy）
- 10 秒激活超时
- 崩溃后自动清理（dispose 强制回收）

#### 8.1.1 Worker 与 Inline 模式 API 差异 ⚠️

Worker 线程通过 IPC 代理访问宿主服务，**并非所有 `PluginContext` API 都可用**。开发时若目标运行模式为 Worker，必须遵守以下约束：

| API | Inline 模式 | Worker 模式 | 说明 |
|---|---|---|---|
| `ctx.services.commandBus` | 完整 | `registerHandler` / `execute` | `execute` 调用不自动加命名空间前缀，见下方 |
| `ctx.services.eventBus` | `on()` / `off()` | `subscribe()` / `unsubscribe()` | 方法名不同 |
| `ctx.services.actionRegistry` | 完整 | `register()` | — |
| `ctx.db.migrate(fn)` | `sqliteDb.exec()` 可用 | 仅 `prepare().run/get/all` | **无 `exec`、无 `transaction`** |
| `ctx.db.table()` | 返回 manifest ID 前缀 | 返回 UUID 前缀 | 同一次激活内一致，但切换模式会导致表名变化 |
| `ctx.resolve(IDatabaseToken)` | 完整 `better-sqlite3` | 仅 `prepare().run/get/all` | **无 `exec`、无 `transaction`** |
| `ctx.config` | 可用 | ❌ 不可用 | 需通过 `ctx.manifest.configuration.properties` 读取默认值 |
| `ctx.provide()` | 可用 | ❌ 不可用 | 需 `typeof` 守卫跳过 |
| `ctx.log` | 可用 | 可用 | — |
| `ctx.pluginId` | manifest ID | UUID | — |
| `ctx.manifest` | 可用 | 可用 | — |

> **关键规则**：Worker 中 `commandBus.execute()` **不会**自动给 `type` 加 `manifest.id` 前缀（`registerHandler` 会）。从 Worker 内部调用另一个自己的命令时，必须手动拼接完整 type：
> ```typescript
> // ❌ Worker 中此调用会失败——type 缺少前缀
> commandBus.execute({ type: 'myplugin.do_work', payload: {} });
> 
> // ✅ 手动加 manifest.id 前缀
> commandBus.execute({ type: `${ctx.manifest.id}.myplugin.do_work`, payload: {} });
> ```

**结构化错误类**（`packages/core/worker-runtime/errors.ts`）：
- `WorkerActivateError` — 插件在 Worker 内激活失败
- `WorkerTimeoutError` — RPC 调用或激活/停用超时
- `WorkerTransportError` — postMessage 通信层失败
- `WorkerCapabilityError` — 跨边界能力检查拒绝
- `WorkerNotSupportedError` — 运行时不支持的功能

### 8.2 前端 Worker 模式

前端同样支持 Worker 隔离，通过 `BrowserWorkerManager` 将插件运行在 Web Worker 中，与后端一致的隔离保证。插件需在安装时指定 `executionMode: 'worker'`。

### 8.3 热重载（开发模式）

在 `NODE_ENV=development` 时，PluginHost 自动启用文件监听：

1. `HotReloadController` 通过 chokidar 监听 `plugins/` 目录
2. 检测文件变更（debounce 300ms）
3. 自动停用旧版本 → 清除中间件 → 激活新版本
4. 无需重启服务器

### 8.4 生命周期中间件

PluginHost 支持在 6 个生命周期阶段注册中间件（洋葱模型）：

```typescript
pluginHost.registerMiddleware('beforeActivate', async (ctx, next) => {
  console.log(`[Auth] 检查插件 ${ctx.pluginId} 的激活权限`);
  await next();  // 继续执行
});
```

可用阶段：`beforeActivate`、`afterActivate`、`beforeDeactivate`、`afterDeactivate`、`beforeCommand`、`afterCommand`。

### 8.5 异步后台任务

```typescript
// 注册任务处理器
await processManager.registerHandler('my_task_type', async (
  processId, payload, state, log, updateState
) => {
  log('任务开始...');
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    updateState({ progress: i / 10 });
    log(`进度: ${i * 10}%`);
  }
  log('任务完成');
});

// 启动任务
const processId = await processManager.spawn(
  '我的后台任务',
  'my_task_type',
  { input: 'some data' }
);

// 进程事件
eventBus.subscribe('process.completed', (event) => {
  console.log('任务完成:', event.payload.processId);
});
```

### 8.6 声明式数据库迁移

使用 `ctx.db.migrate()` 进行插件数据库版本管理：

```typescript
// 首次激活时调用（idempotent）
// ✅ 使用 prepare().run() 同时兼容 Inline 和 Worker 模式
await ctx.db.migrate(1, async (sqliteDb) => {
  sqliteDb.prepare(`
    CREATE TABLE IF NOT EXISTS my_table (
      id TEXT PRIMARY KEY,
      data TEXT
    )
  `).run();
});

// 后续版本升级
await ctx.db.migrate(2, async (sqliteDb) => {
  sqliteDb.prepare(`ALTER TABLE my_table ADD COLUMN extra TEXT DEFAULT ''`).run();
});
```

> ⚠️ **Worker 兼容提示**：Worker 模式下 `migrate` 回调接收的是受限数据库代理，仅支持 `prepare().run()` / `prepare().get()` / `prepare().all()`。**不要使用 `sqliteDb.exec()`**（仅 Inline 模式可用）。建议始终使用 `prepare().run()` 编写迁移脚本以确保两种模式兼容。

### 8.7 自定义服务注册（V3.2）

插件可以向 DI 容器注册自定义服务，供其他插件消费：

```typescript
// 插件 A：注册服务
await ctx.provide('@my-scope/IQuestionBank', questionBankService);

// 插件 B：manifest.optional 中声明依赖
// optional: ['@my-scope:IQuestionBank@>=1.0.0']

// 插件 B：运行时消费
```

### 8.5 跨插件服务共享（V3.2）

多个插件可以通过类型安全的 DI Token 互相分享服务。

**提供方插件** 将接口定义为 Token + Type 对，放在 `src/contracts/` 目录中：

```typescript
// ext-quiz-engine/src/contracts/index.ts
import { Token } from '@openlearn/plugin-sdk';

export interface IQuizEngineService {
  score(answers: Answer[]): number;
  generateQuestion(topic: string): Question;
}

export const QuizEngineToken = new Token<IQuizEngineService>(
  'ext-quiz-engine:IQuizEngineService',
  '1.0.0'
);
```

在 `manifest.json` 中声明：

```json
{
  "provides": ["ext-quiz-engine:IQuizEngineService"]
}
```

在 `activate` 中提供实例：

```typescript
ctx.provide(QuizEngineToken, new QuizEngine());
```

**消费方插件** 在编译期导入类型，运行时通过 Token 解析：

```typescript
import type { IQuizEngineService } from 'ext-quiz-engine/contracts';
import { QuizEngineToken } from 'ext-quiz-engine/contracts';

const engine = await ctx.resolve(QuizEngineToken);
// engine 类型为 IQuizEngineService，有完整的 IDE 补全
const score = engine.score(answers);
```

在 `manifest.json` 中声明依赖：

```json
{
  "requires": [
    "@openlearn/core:ICommandBusService@^1.0.0",
    "ext-quiz-engine:IQuizEngineService"
  ]
}
```

**校验机制**：
- 安装时：检查提供方 `manifest.provides` 是否声明了 token → warn
- 激活时：检查提供方是否已激活并提供服务 → 阻塞
- 激活顺序：`ext-quiz-engine:IQuizEngineService` 自动推导为对 `ext-quiz-engine` 的依赖，提供方先激活

const qb = await ctx.resolve({ name: '@my-scope:IQuestionBank' } as any);
```

---

## 9. 测试与调试

### 9.1 结构化日志

使用 `ctx.log` 替代 `console.log`，自动注入 `pluginId` 和 `timestamp`：

```typescript
ctx.log.info('Handler registered', { commandType: 'poll.create' });
ctx.log.error('Database connection failed', { error: error.message });
ctx.log.debug('Request processed', { latency: 23, payload: data });
```

### 9.2 查看进程状态

```bash
# 查看插件列表
curl http://localhost:9000/api/plugins

# 查看后台进程
# 在应用 UI：系统设置 → 进程管理
```

### 9.3 事件审计

所有事件自动写入 SQLite `events` 表：

```sql
SELECT * FROM events WHERE type LIKE 'poll.%' ORDER BY timestamp DESC;
```

### 9.4 插件测试

使用 `@openlearn/plugin-test-kit` 进行单元测试：

```bash
npm install --save-dev @openlearn/plugin-test-kit vitest
```

```typescript
// __tests__/index.test.ts
import { describe, it, expect } from 'vitest';
import { createMockContext } from '@openlearn/plugin-test-kit';
import plugin from '../src/index';

describe('my-plugin', () => {
  it('should activate and register handler', async () => {
    const ctx = createMockContext();
    await plugin.activate(ctx);

    const handlers = ctx.services.commandBus._getHandlers();
    expect(handlers).toContain('myplugin.hello');
  });
});
```

---

## 10. 发布前自检清单

在打包插件 ZIP 前，逐项检查以下内容以避免常见问题：

### Manifest 检查

- [ ] `id` 格式为 `@scope/name`，全局唯一
- [ ] `engines.openlearn` 版本号**不高于**目标系统的实际版本
- [ ] `requires` 中所有服务 Token 的版本前缀正确
- [ ] `classroomTools` 中每个 `commandType` 都有对应的 `registerHandler`

### 服务端检查

- [ ] 每个 Action（`actionRegistry.register`）都有对应的 Command Handler（`commandBus.registerHandler`）
- [ ] `ctx.db.ensureTable` 创建的每个表都有注释说明用途
- [ ] 数据库操作只使用 `prepare().run()` / `.get()` / `.all()`，避免 `exec()`、`pragma()` 等新版本方法
- [ ] 跨插件调用（如 VFS）在 `capabilitiesProposed` 中声明了对应权限
- [ ] `activate()` 中所有可能出现异常的操作包裹了 `try/catch`

### Worker 兼容性检查 ⚠️（目标运行模式为 Worker 时必查）

- [ ] `ctx.db.migrate()` 回调中**未使用 `sqliteDb.exec()`**，全部改为 `sqliteDb.prepare().run()`
- [ ] `ctx.resolve(IDatabaseToken)` 返回的实例上**未调用 `.exec()` 或 `.transaction()`**
- [ ] 未直接访问 `ctx.config`——改用 `ctx.manifest.configuration.properties` 读取默认值
- [ ] `ctx.provide()` 调用包裹了 `typeof (ctx as any).provide === 'function'` 守卫
- [ ] `eventBus` 使用 `subscribe()/unsubscribe()`，而非 `on()/off()`
- [ ] Worker 内部 `commandBus.execute()` 的 `type` **手动拼接了 `ctx.manifest.id` 前缀**

### 前端检查

- [ ] `tsconfig.json` 中 `jsx` 为 `"react"`（非 `"react-jsx"`）
- [ ] `react` / `react-dom` / `recharts` / `lucide-react` 标记为 `external`（由 HostSharedDeps 提供）
- [ ] 不直接 import React hooks 之外的 React 子路径（如 `react/jsx-runtime`）
- [ ] 使用的扩展点槽位在目标系统版本中存在（参考 [2.6 版本兼容性速查表](#26-版本兼容性速查表)）
- [ ] 前端调用的命令在服务端有对应的 handler

### 构建检查

- [ ] `npx @openlearn/plugin-sdk build` 无报错
- [ ] ZIP 产物包含 `manifest.json` + `index.js` +（可选）`frontend.js`
- [ ] 解压 ZIP 后检查 `index.js` 不包含禁用的裸导入（参考 [11.4 常见打包错误与排查](#114-常见打包错误与排查)）
- [ ] 解压 ZIP 后检查 `frontend.js` 不包含 `import ... from "react/jsx-runtime"`

---

## 11. 发布与分发

### 11.1 使用 CLI 脚手架

OpenLearnV2 提供 `@openlearn/plugin-sdk` CLI 工具快速创建项目：

```bash
# 脚手架创建
npx @openlearn/plugin-sdk init --name my-plugin

# 安装依赖
cd my-plugin && npm install

# 构建 ZIP
npx @openlearn/plugin-sdk build

# 产物位于 my-plugin.zip，上传到插件中心即可安装
```

支持三种模板：`server-only`、`full-stack`、`frontend-only`。

### 11.2 手动打包为 ZIP

```bash
# 插件目录结构
my-plugin/
  index.js          # 入口（export default { manifest, activate }）
  package.json      # 可选
  README.md         # 文档

# 打包
zip -r my-plugin.zip my-plugin/
```

### 11.3 安装 ZIP 插件

在「系统设置」→「插件中心」上传 ZIP 文件，系统自动：
1. 解压 ZIP
2. 提取 index.js 作为入口
3. 解析 manifest
4. **使用 esbuild 的 `openlearn-token-enforcer` 插件进行二次扫描**（见 11.4）
5. 验证依赖（SemVer 兼容性检查）
6. 存入数据库
7. 可选：立即激活

### 11.4 常见打包错误与排查

#### 错误：`Import of "<module>" is not allowed`

**错误信息示例：**
```
Build failed with 1 error:
<stdin>:6:27: ERROR: [plugin: openlearn-token-enforcer]
Import of "crypto" is not allowed.
Plugins may only use relative imports or @openlearn/* Token services.
```

**原因：** OpenLearn 在接收到上传的 ZIP 后，会使用内置的 esbuild `openlearn-token-enforcer` 插件对入口文件（`index.js`）进行安全扫描。该扫描器**只允许两类导入**：

| 允许 | 示例 |
|------|------|
| 相对路径导入 | `import foo from './utils'` |
| `@openlearn/*` Token 服务 | `import { IDatabaseToken } from '@openlearn/plugin-sdk'` |

所有其他**裸 specifier 导入**（包括 Node.js 内置模块）都会被拒绝：

```typescript
// ❌ 禁止 — 会触发 token-enforcer 报错
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import _ from 'lodash';
```

**解决方案：**

**① 替换 `crypto.randomUUID()`（最常见）**

```typescript
// ❌ 错误写法
import { randomUUID } from 'crypto';
const id = randomUUID();

// ✅ 正确写法 — 使用全局 Web Crypto API，Node.js 20+ 和现代浏览器均可用，无需 import
const id = globalThis.crypto.randomUUID();
// 或更简短（全局 crypto 在 Node.js 20+ 中与 globalThis.crypto 等价）
const id = crypto.randomUUID();
```

**② 替换时间戳 ID（更简单）**

```typescript
// 对于不需要密码学安全性的 ID，可以用时间戳 + 随机数组合
const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
```

**③ 替换 `fs`（文件操作）**

插件不应直接使用 `fs` 模块，应通过 VFS 服务（需在 manifest 中声明 `vfs:read`/`vfs:write` 权限）：

```typescript
// ❌ 错误写法
import { readFileSync } from 'fs';

// ✅ 正确写法 — 通过 VFS 服务
const { IStorageServiceToken } = await import('@openlearn/plugin-sdk');
const storage = await ctx.resolve(IStorageServiceToken);
await ctx.services.commandBus.execute(
  ctx.services.commandBus.createCommand('vfs.read_file', { path: '/my/file.txt' }, ctx.pluginId)
);
```

**④ 替换 `path`（路径操作）**

```typescript
// ❌ 错误写法
import path from 'path';

// ✅ 正确写法 — 使用原生字符串操作
const filename = filePath.split('/').pop() ?? '';
const ext = filename.split('.').pop()?.toLowerCase() ?? '';
```

**⑤ 替换第三方 npm 包**

部分常用包已通过 `ctx.require()` 白名单共享（无需 import）：

| 包名 | 使用方式 |
|------|----------|
| `uuid` | `const { v4: uuidv4 } = ctx.require('uuid')` |
| `xlsx` | `const XLSX = ctx.require('xlsx')` |
| `recharts` | `const { LineChart } = ctx.require('recharts')` |
| `jspdf` | `const { jsPDF } = ctx.require('jspdf')` |
| `lucide-react` | `const { BookOpen } = ctx.require('lucide-react')` |

对于其他第三方包，需在构建阶段将其完整代码内联到 `index.js` 中（esbuild bundle），避免在产物中残留裸 specifier 导入语句。

**自检方法（上传前验证）：**

```bash
# 检查产物 index.js 中是否有不在白名单内的裸导入
grep -E '^import .+ from "[^@\./]' dist/index.js
# 有输出 = 有问题；无输出 = 通过
```

### 11.5 版本兼容性

插件依赖声明支持 SemVer 范围：
- `^1.0.0` — 兼容 1.x.x
- `~1.2.0` — 兼容 1.2.x
- `>=1.0.0 <2.0.0` — 显式范围

安装时 PluginHost 自动检查兼容性，不兼容则拒绝安装。

---

## 附录 A：完整插件模板

```typescript
// 复制此模板开始开发你的插件
import type { PluginContext } from '@openlearn/plugin-sdk';
import {
  ICommandBusServiceToken,
  IActionRegistryServiceToken,
  IEventBusServiceToken,
  IDatabaseToken,
  IProcessServiceToken,
  IStorageServiceToken,
  IAIServiceToken,
} from '@openlearn/plugin-sdk';

export default {
  manifest: {
    id: '@you/plugin-name',
    name: '我的插件',
    version: '1.0.0',
    main: 'index.js',
    description: '插件描述',
    author: '作者名',
    engines: { openlearn: '^2.5.0' },
    requires: [
      '@openlearn/core:ICommandBusService@^1.0.0',
      '@openlearn/core:IActionRegistryService@^1.0.0',
      '@openlearn/core:IEventBusService@^1.0.0',
      '@openlearn/core:IDatabase@^1.0.0',
    ],
    capabilitiesProposed: ['lesson:read'],
  },

  activate: async (ctx: PluginContext) => {
    const commandBus = ctx.services.commandBus;
    const actionRegistry = ctx.services.actionRegistry;
    const eventBus = ctx.services.eventBus;
    const db = await ctx.resolve(IDatabaseToken);


    // TODO: 注册 Actions 和 Handlers

    ctx.log.info('Plugin activated');
  },

  deactivate: async () => {
    console.log('插件已停用');
  },
};
```

## 附录 B：现有内置插件参考

| 插件 | 文件 | 命令示例 |
|------|------|----------|
| 课堂核心 | `packages/plugins/builtin.ts` | `lesson.create`, `whiteboard.draw`, `whiteboard.query` |
| 虚拟文件系统 | `packages/plugins/vfs.ts` | `vfs.write_file`, `vfs.read_file`, `vfs.list_dir` |
| 管理插件 | `packages/plugins/management.ts` | `class.create`, `student.enroll`, `assignment.create` |
| AI 规划器 | `packages/plugins/ai-planner.ts` | `ai.start_generation`, `ai.apply_recommendation` |
| 作业评估 | `packages/plugins/assignment-eval.ts` | `assignment.evaluate`, `peer_review.create` |
| 进程管理 | `packages/plugins/process.ts` | `process.spawn`, `process.kill`, `process.list` |

---

> 本文档基于 OpenLearnV2 最新代码库（`main` 分支），通过 Codegraph 知识图谱分析生成。
> 最后更新：2026-07-14
