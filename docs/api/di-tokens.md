# 完整 DI Token 与 Service API 字典

> **适用范围**：`@openlearn/plugin-sdk@3.4.3`（版本号以 `packages/plugin-sdk/package.json` 为准）。
> 本页是插件获取平台内核服务的**唯一权威字典**。所有 Token 定义位于 `packages/core/di/interfaces.ts`，并由 `packages/plugin-sdk/index.ts:103-131, 319-324` 统一导出。
> **重要**：插件 SDK 发布的 `dist/index.d.ts`（由 `openlearn.d.ts` 复制而来）**已过期**，仅含 15 个 Token 且部分类型被擦除为 `Token<unknown>`。请以本页（依据源 `index.ts` / `interfaces.ts`）为准；若你在 `tsc` 下遇到 `TS2305 "has no exported member"`，即为该过期声明所致，需重新生成 SDK 声明文件。

---

## 1. 如何获取服务：两条路径

插件在 `activate(ctx)` 中拿到 `PluginContext`（`ctx`）。平台服务通过两种方式获取：

1. **`ctx.resolve(Token)` —— 通用 DI 路径**。除了下方 7 个核心服务代理之外，任何已注册的 Token 都走这条路：

   ```typescript
   import { IPluginLifecycleManagerToken, IDatabaseToken } from '@openlearn/plugin-sdk';

   const lifecycle = await ctx.resolve(IPluginLifecycleManagerToken); // 类型: PluginLifecycleManager
   const db        = await ctx.resolve(IDatabaseToken);               // 类型: better-sqlite3.Database
   ```

2. **`ctx.services.X` —— 仅 7 个核心服务的便捷代理**（与对应 Token 解析出的实例相同）。

`PluginContext` 完整形态（`packages/core/plugin-host/types.ts:108-149`）：

```typescript
interface PluginContext {
  // (a) 预接线的 7 个核心服务代理
  services: {
    commandBus: ICommandBusService;
    eventBus: IEventBusService;
    actionRegistry: IActionRegistryService;
    capability: ICapabilityService;
    processManager: IProcessService;
    storage: IStorageService;
    ai: IAIService;
  };
  pluginId: string;
  manifest: Manifest;
  // (b) 解析任意已注册的 Token
  resolve<T>(token: Token<T>): Promise<T>;
  // (c) 向容器注入插件自有服务
  provide<T>(token: Token<T>, instance: T): Promise<void>;
  // (d) 其它上下文能力（非 Token）
  db: PluginDatabaseAPI;          // 插件命名空间隔离表
  log: IPluginLogger;             // ctx.log.info(...)
  config: IConfigService;
  contributions: ContributionAccessor;
  require(moduleName: string): unknown; // 仅白名单内的共享模块
}
```

---

## 2. 完整 Token 列表（28 个）

`Token<T>` 本身是一个运行时常量（`packages/core/di/token.ts:32-62`），其 `name` 形如 `@openlearn/core:ICommandBusService`，`T` 仅用于编译期类型携带。

### A. 核心 7 服务 Token（`interfaces.ts:267-318`）

| 导出 Token | 解析类型 | 标识字符串 |
|---|---|---|
| `ICommandBusServiceToken` | `ICommandBusService` | `@openlearn/core:ICommandBusService` |
| `IEventBusServiceToken` | `IEventBusService` | `@openlearn/core:IEventBusService` |
| `IActionRegistryServiceToken` | `IActionRegistryService` | `@openlearn/core:IActionRegistryService` |
| `ICapabilityServiceToken` | `ICapabilityService` | `@openlearn/core:ICapabilityService` |
| `IProcessServiceToken` | `IProcessService` | `@openlearn/core:IProcessService` |
| `IStorageServiceToken` | `IStorageService` | `@openlearn/core:IStorageService` |
| `IAIServiceToken` | `IAIService` | `@openlearn/core:IAIService` |

### B. 内核 / 基础设施 Token

| 导出 Token | 解析类型 | 标识字符串 |
|---|---|---|
| `IDatabaseToken` | `better-sqlite3.Database`（**原始句柄，无包装**） | `@openlearn/core:IDatabase` |
| `IPluginHostToken` | `PluginHost`（**类，非纯接口**） | `@openlearn/core:IPluginHost` |

### C. P7-A2 统一插件平台 Token（`interfaces.ts:348-390`）

| 导出 Token | 解析类型 | 标识字符串 |
|---|---|---|
| `IPluginLifecycleManagerToken` | `PluginLifecycleManager` | `@openlearn/core:IPluginLifecycleManager` |
| `IPluginDistributionManagerToken` | `PluginDistributionManager` | `@openlearn/core:IPluginDistributionManager` |
| `IPluginRuntimeCompositionToken` | `PluginRuntimeComposition` | `@openlearn/core:IPluginRuntimeComposition` |
| `IUnifiedExtensionRegistryToken` | `UnifiedExtensionRegistry` | `@openlearn/core:IUnifiedExtensionRegistry` |
| `IPluginCapabilityGatewayToken` | `PluginCapabilityGateway` | `@openlearn/core:IPluginCapabilityGateway` |
| `ICapabilityRegistryToken` | `CapabilityRegistry` | `@openlearn/core:ICapabilityRegistry` |

### D. 积分 / 学期 / 领域 Token

| 导出 Token | 解析类型 | 标识字符串 |
|---|---|---|
| `ISemesterGradeServiceToken` | `ISemesterGradeService` | `@openlearn/core:ISemesterGradeService` |
| `IPointsDimensionRegistryToken` | `IPointsDimensionRegistry` | `@openlearn/core:IPointsDimensionRegistry` |
| `IPointsLedgerServiceToken` | `IPointsLedgerService` | `@openlearn/core:IPointsLedgerService` |

### E. 引擎访问 Token（薄封装 `getX(): Promise<unknown>` 门面）

| 导出 Token | 解析类型 | 标识字符串 |
|---|---|---|
| `ILessonEngineServiceToken` | `ILessonEngineService` | `@openlearn/core:ILessonEngineService` |
| `IClassroomRuntimeServiceToken` | `IClassroomRuntimeService` | `@openlearn/core:IClassroomRuntimeService` |
| `IPresenceEngineServiceToken` | `IPresenceEngineService` | `@openlearn/core:IPresenceEngineService` |
| `ITeachingCollaborationServiceToken` | `ITeachingCollaborationService` | `@openlearn/core:ITeachingCollaborationService` |
| `ILearningAnalyticsServiceToken` | `ILearningAnalyticsService` | `@openlearn/core:ILearningAnalyticsService` |
| `IAICapabilityServiceToken` | `IAICapabilityService` | `@openlearn/core:IAICapabilityService` |
| `ICapabilityRuntimeServiceToken` | `ICapabilityRuntimeService` | `@openlearn/core:ICapabilityRuntimeService` |
| `ICapabilityGovernanceServiceToken` | `ICapabilityGovernanceService` | `@openlearn/core:ICapabilityGovernanceService` |
| `IPlatformServiceRegistryToken` | `IPlatformServiceRegistryService` | `@openlearn/core:IPlatformServiceRegistryService` |

### F. 活动生态 Token

| 导出 Token | 解析类型 | 标识字符串 |
|---|---|---|
| `IActivityRegistryToken` | `ActivityRegistry` | （定义于 `packages/activity-ecosystem/index.ts:28`） |

---

## 3. 各 Service 接口全量方法签名

> 行号指向 `packages/core/di/interfaces.ts` 与对应实现文件。

### `ICommandBusService`（`interfaces.ts:43-80`）
```typescript
execute<T extends PlatformCommand>(command: T): Promise<unknown>;
registerHandler(commandType: string, handler: CommandHandler): Promise<void>;
unregisterHandler(commandType: string): Promise<void>;
createCommand<T>(type: string, payload: T, actorId: string, metadata?: CommandMetadata): Promise<PlatformCommand<T>>;
setInterceptor(interceptor: (command: PlatformCommand) => Promise<void>): Promise<void>;
```

### `IEventBusService`（`interfaces.ts:84-102`）
```typescript
publish(event: PlatformEvent): Promise<void>;
subscribe(eventType: string, subscriber: EventSubscriber): Promise<void>;
unsubscribe(eventType: string, subscriber: EventSubscriber): Promise<void>;
```

### `IActionRegistryService`（`interfaces.ts:106-147`）
```typescript
register(descriptor: ActionDescriptor): Promise<void>;
unregister(id: string): Promise<void>;
getAllActions(): Promise<ActionDescriptor[]>;
getAgentTools(): Promise<unknown[]>;
getActionByToolName(toolName: string): Promise<ActionDescriptor | undefined>;
getActionByCommandType(commandType: string): Promise<ActionDescriptor | undefined>;
```

### `ICapabilityService`（`interfaces.ts:151-169`）
```typescript
grant(actorId: string, cap: string): Promise<void>;
revokeAll(actorId: string): Promise<void>;
check(actorId: string, requiredCap: string): Promise<boolean>;
```

### `IProcessService`（`interfaces.ts:173-217`）
```typescript
spawn(name: string, taskType: string, payload: unknown): Promise<string>;
kill(processId: string): Promise<void>;
registerHandler(taskType: string, handler: ProcessHandler): Promise<void>;
unregisterHandler(taskType: string): Promise<void>;
registerInterval(name: string, intervalMs: number, tickFn: (log: (msg: string) => void) => void): Promise<string>;
restore(): Promise<void>;
// ProcessHandler = (processId, payload, state, log, updateState) => Promise<void>
```

### `IStorageService`（`interfaces.ts:228-237`，实现 `packages/core/di/storage-service.ts:23-51`）
```typescript
get(key: string): Promise<unknown>;
set(key: string, value: unknown): Promise<void>;
delete(key: string): Promise<void>;
```
> 后端为 SQLite `plugin_storage` 表，按 `plugin_id` 自动命名空间隔离。

### `IAIService`（`interfaces.ts:247-259`，实现 `packages/core/di/ai-service.ts:32-65`）
```typescript
generateText(prompt: string, options?: { systemInstruction?: string; temperature?: number }): Promise<string>;
```
> 两级回退：数据库配置的 OpenAI 兼容 Provider → Gemini。

### `IDatabaseToken` → 原始 `better-sqlite3.Database`
无接口包装，插件直接拿到原始 `Database` 对象。查询/插入/更新/删除/事务请使用 better-sqlite3 原生 API（详见 [插件数据库 API 与 Migration 规范](../reference/plugin-database-api)）。

### `IPluginHostToken` → `PluginHost` 类（`packages/core/plugin-host/index.ts:105`）
```typescript
setExpressApp(app: any): void;
setSocketIO(io: any): void;
listPlugins(): PluginInfo[];
getPluginState(pluginId: string): PluginState | undefined;
installPlugin(sourceCode: string): Promise<Manifest>;
activatePlugin(pluginId: string, options?: { mode?: 'inline' | 'worker' }): Promise<void>;
deactivatePlugin(pluginId: string): Promise<void>;
uninstallPlugin(pluginId: string): Promise<void>;
reloadPlugin(pluginId: string, newSourceCode: string): Promise<void>;
```

### `IPluginLifecycleManagerToken` → `PluginLifecycleManager`（`plugin-lifecycle-manager.ts:14-24`）
```typescript
readonly pluginHost: PluginHost;
getPluginState(pluginId: string): PluginState | undefined;
listPlugins(): ReadonlyArray<PluginInfo>;
activatePlugin(pluginId: string): Promise<void>;
deactivatePlugin(pluginId: string): Promise<void>;
reloadPlugin(pluginId: string, newCode?: string): Promise<void>;
uninstallPlugin(pluginId: string): Promise<void>;
health(): IntegrationHealthStatus;
metadata(): IntegrationDescriptor;
```

### `IPluginDistributionManagerToken` → `PluginDistributionManager`（`plugin-distribution-manager.ts:63-74`）
```typescript
readonly pluginHost: PluginHost;
registerRepository(repo: IPluginRepositoryAdapter): void;
listRepositories(): ReadonlyArray<IPluginRepositoryAdapter>;
listAvailablePackages(): Promise<ReadonlyArray<PluginPackageMetadata>>;
installFromZip(zipBuffer: Buffer): Promise<{ pluginId: string; manifest: Manifest }>;
installFromRepository(repoId: string, pluginId: string): Promise<{ pluginId: string; manifest: Manifest }>;
updatePlugin(pluginId: string, zipBuffer?: Buffer): Promise<void>;
uninstallPlugin(pluginId: string): Promise<void>;
health(): IntegrationHealthStatus;
metadata(): IntegrationDescriptor;
```

### `IPluginRuntimeCompositionToken` → `PluginRuntimeComposition`（`plugin-runtime-composition.ts:20-87`）
```typescript
readonly id: string;
readonly name: string;
readonly version: string;
readonly pluginHost: PluginHost;
readonly workerManager?: WorkerManager;
readonly isStarted: boolean;
start(context?: IntegrationContext): Promise<void>;
stop(): Promise<void>;
health(): IntegrationHealthStatus;
metadata(): IntegrationDescriptor;
```

### `IUnifiedExtensionRegistryToken` → `UnifiedExtensionRegistry`（`unified-extension-registry.ts:22-35`）
```typescript
registerExtension(category: string, id: string, impl: unknown, meta?: Partial<ExtensionItemMetadata>): void;
hasExtension(category: string, id: string): boolean;
getExtension<T = unknown>(category: string, id: string): T | undefined;
listExtensions(category?: string): ReadonlyArray<ExtensionItemMetadata>;
listCategories(): ReadonlyArray<string>;
health(): IntegrationHealthStatus;
metadata(): IntegrationDescriptor;
```

### `IPluginCapabilityGatewayToken` → `PluginCapabilityGateway`（`plugin-capability-gateway.ts:24-36`）
```typescript
readonly capabilityRegistry: CapabilityRegistry;
listCapabilities(): ReadonlyArray<CapabilityMetadata>;
hasCapability(capabilityId: string): boolean;
resolveCapability<T extends IAICapability = IAICapability>(capabilityId: string): T;
executeCapability<T = unknown>(capabilityId: string, methodName: string, ...args: unknown[]): Promise<T>;
health(): IntegrationHealthStatus;
metadata(): IntegrationDescriptor;
```

### `ICapabilityRegistryToken` → `CapabilityRegistry`
AI 能力注册表（与 `resource:action` 权限字符串无关，见 [能力权限矩阵](../reference/plugin-capability-matrix)）。

### `ISemesterGradeServiceToken` → `ISemesterGradeService`（`interfaces.ts:396-403`）
```typescript
saveSemesterGrade(lessonId: string, studentId: string, grade: number): Promise<void>;
```

### `IPointsDimensionRegistryToken` → `IPointsDimensionRegistry`（`interfaces.ts:429-433`）
```typescript
registerDimension(spec: PointsDimensionSpec): void;
getDimension(id: string): PointsDimensionSpec | undefined;
listDimensions(): PointsDimensionSpec[];
```

### `IPointsLedgerServiceToken` → `IPointsLedgerService`（`interfaces.ts:456-468`，实现 `points-ledger-service.ts:5-104`）
```typescript
addPoints(studentId: string, classId: string, dimensionId: string, deltaPoints: number, reason: string, pluginId?: string): Promise<PointLogItem>;
getLogs(studentId: string, classId?: string): Promise<PointLogItem[]>;
getStudentTotalByDimension(studentId: string, classId: string, dimensionId: string): Promise<number>;
getStudentDimensionSummary(studentId: string, classId: string): Promise<Record<string, number>>;
```

### 引擎门面接口（均为单方法，`interfaces.ts`）
```typescript
ILessonEngineService          { getRuntime(): Promise<unknown>; }
IClassroomRuntimeService      { getRuntimeKernel(): Promise<unknown>; }
IPresenceEngineService        { getPresenceEngine(): Promise<unknown>; }
ITeachingCollaborationService { getCollaborationEngine(): Promise<unknown>; }
ILearningAnalyticsService     { getAnalyticsEngine(): Promise<unknown>; }
IAICapabilityService          { getCapabilityKernel(): Promise<unknown>; }
ICapabilityRuntimeService     { getRuntimeKernel(): Promise<unknown>; }
ICapabilityGovernanceService  { getGovernanceKernel(): Promise<unknown>; }
IPlatformServiceRegistryService { getServiceRegistryKernel(): Promise<unknown>; }
```

### `IActivityRegistryToken` → `ActivityRegistry`（`activity-ecosystem/registry.ts:27-128`）
```typescript
registerProvider(provider: ActivityProvider): void;
unregisterProvider(id: string): boolean;
getProvider(id: string): ActivityProvider | undefined;
listProviders(): ReadonlyArray<ActivityProvider>;
listDescriptors(): ActivityProviderDescriptor[];
listByRole(role: ActivityRole): ActivityProvider[];
listByCategory(category: ActivityCategory): ActivityProvider[];
startActivity(id: string, context: ActivityContext, payload?: Record<string, unknown>, actorId?: string): Promise<StartActivityResult>;
clear(): void;
```

### 日志（`ctx.log`，无 Token）
```typescript
interface IPluginLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
```

---

## 4. ⚠️ 不存在的 Token（切勿捏造）

经全仓检索（`packages/`），以下常被误以为存在的 Token **并不存在**，若 `ctx.resolve` 会失败或类型缺失：

- **`IWhiteboardToken`** —— 不存在。白板能力经由 `ICommandBusService` / `IEventBusService`（事件如 `whiteboard.element_drawn`）或类型辅助 `IWhiteboardServiceContract`（仅类型、`plugin-sdk/index.ts:181`，非 Token）间接获取。
- **`IAuthToken` / `IUserToken` / `IAuthServiceToken` / `IUserContextToken`** —— 不存在。鉴权由服务端中间件处理，不作为 DI Token 暴露给插件。
- **`ILoggerToken`** —— 不存在。日志经 `ctx.log: IPluginLogger` 提供，不可 `resolve`。
- **`IPluginRuntimeToken` / `IUnifiedPluginContextToken`** —— 不存在。`IPluginRuntime` / `IUnifiedPluginContext` 是导出**类型**（适配器），但未定义对应 `Token<T>`，无法传给 `ctx.resolve`。

---

## 5. 组合根（Composition Root）

所有 Token 在 `packages/core/kernel/index.ts:204-231` 绑定到具体实例（`kernelContainer.serviceRegistry.register(...)`）。`server.ts` 仅补充 `IActivityRegistryToken`（`server.ts:537`）。插件无需关心绑定细节，直接 `ctx.resolve(Token)` 即可。

> 最后更新：2026-07-26
