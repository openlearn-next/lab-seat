# 插件原地更新与分发 (Plugin In-Place Update & Distribution)

> **适用范围**：`@openlearn/plugin-sdk@3.4.3`；宿主内核 `packages/core/plugin-host`、`packages/core/worker-runtime`、`server/routes/plugins.ts`、前端 `src/components/PluginInstallWizard.tsx`。
> 本页说明插件 **原地更新（in-place update）** 能力：上传新 ZIP 后**保留插件 UUID、配置与业务数据**，仅替换代码与静态资源；并说明 Worker 激活超时的可调环境变量。

---

## 1. 能力概览

- 上传的新 ZIP 若 `manifest.id` 与已安装插件一致，宿主执行**原地更新**而非新建。
- 版本比对（semver）：升级正常；降级需显式 `allowDowngrade`。
- 系统核心插件（`@openlearn/*`）禁止通过插件中心更新。
- 运行中且声明了课堂/教学扩展点的插件，热更新会提示课中 UI 短暂异常确认。

---

## 2. 后端 Service API

### `PluginHost`（`packages/core/plugin-host/index.ts`）
```typescript
async updatePluginFromZip(
  zipBuffer: Buffer,
  options?: PluginUpdateOptions,
): Promise<PluginUpdateResult>;

findByManifestId(manifestId: string): {
  pluginId: string; name: string; version: string; status: string;
  state: string; manifest: Manifest; isSystem: boolean;
} | undefined;
```

### `PluginDistributionManager`（`packages/core/plugin-host/plugin-distribution-manager.ts`）
```typescript
interface PluginUpdateOptions {
  targetPluginId?: string;          // 锁定目标插件（DB UUID 或 manifest.id）
  executionMode?: 'worker' | 'inline';
  allowDowngrade?: boolean;         // 是否允许版本降级
}

interface PluginUpdateResult {
  pluginId: string;
  manifest: Manifest;
  oldVersion: string;
  newVersion: string;
  previousStatus: string;
  wasActive: boolean;               // 更新前是否处于 active 状态（更新后恢复原状）
}

// 新方法
updateFromZip(zipBuffer: Buffer, options?: PluginUpdateOptions): Promise<PluginUpdateResult>;

// 既有方法扩展：现支持指定执行模式
installFromZip(zipBuffer: Buffer, executionMode?: 'worker' | 'inline'): Promise<{ pluginId: string; manifest: Manifest }>;
```

### 命令总线入口（builtin 插件）
| 命令类型 | 权限 | 高危 | 入参 |
|---|---|---|---|
| `plugin.update_zip` | `plugin:write` | ✅ 是 | `{ base64Data: string, targetPluginId?: string, executionMode?: 'worker'\|'inline', allowDowngrade?: boolean }` |

该命令将 Base64 ZIP 交给 `distributionManager.updateFromZip`。

### 插件内调用示例
```typescript
import { IPluginDistributionManagerToken } from '@openlearn/plugin-sdk';

const dm = await ctx.resolve(IPluginDistributionManagerToken);
const res = await dm.updateFromZip(zipBuffer, { allowDowngrade: false });
// res.newVersion, res.wasActive ...
```

---

## 3. 服务端 HTTP 接口（`server/routes/plugins.ts`）

### 按 manifest.id 查询已安装插件（升级检测）
```
GET /api/plugins/by-manifest/:manifestId(*)
→ { success: true, installed: boolean,
    pluginId?, name?, version?, status?, state?, manifest?, isSystem? }
```
> 须在 `/api/plugins/:id(*)/...` 之前注册（路由命中顺序）。

### 安装 / 更新（同一入口，靠请求头区分）
```
POST /api/plugins/install            # body: application/octet-stream (zip)
Header: x-install-mode: update        # 缺省为 install
Header: x-execution-mode: worker|inline
Header: x-target-plugin-id: <pluginId>
Header: x-allow-downgrade: true|false
→ 更新模式返回 { success:true, updated:true, pluginId, manifest,
    oldVersion, newVersion, wasActive, filename }
```

### 显式更新端点（卡片「更新」按钮）
```
POST /api/plugins/:id(*)/update-zip-raw   # body: application/octet-stream (zip)
Header: x-execution-mode: worker|inline
Header: x-allow-downgrade: true|false
→ { success:true, updated:true, pluginId, manifest, oldVersion, newVersion, wasActive }
```

---

## 4. 前端安装向导更新模式（`PluginInstallWizard.tsx`）

`PluginInstallWizard` 现接受更新相关 props，并在解析 ZIP 后自动检测同 `manifest.id` 的已安装插件：

```typescript
type ZipInstallOptions = {
  mode: 'install' | 'update';
  targetPluginId?: string;
  allowDowngrade?: boolean;
};

interface PluginInstallWizardProps {
  isOpen: boolean;
  onClose: () => void;
  lang: 'zh' | 'en';
  file: File | null;
  lockedTargetPluginId?: string | null;     // 卡片「更新」锁定到具体插件行
  installedPlugins?: InstalledPluginSummary[];
  onConfirmInstall: (
    file: File,
    executionMode: 'worker' | 'inline',
    opts?: ZipInstallOptions,
  ) => Promise<void>;
}
```

检测优先级：卡片锁定 `lockedTargetPluginId` → 已安装列表 `installedPlugins` → 回退调用 `GET /api/plugins/by-manifest/:id`。检测到后向导切换为「更新」文案，并展示：
- **升级**：正常可继续。
- **降级**：需勾选「确认强制降级」（`allowDowngrade`）。
- **使用中**：插件为 active 且声明课堂/教学扩展点时，需勾选「已知晓课中热更新风险」。

`PluginCenter` / `App` / `PluginView` 负责传入 `installedPlugins` 与 `lockedTargetPluginId`；`PluginType` 新增 `version?` 与 `has_frontend?` 字段。

---

## 5. Worker 激活超时（可调环境变量）

全栈插件在 Worker 内需动态 `import`、IPC 解析多个 Token、执行 `schema migrate/建表`；主线程繁忙时 RPC 会排队，固定短超时易误杀。默认行为已调整为：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `OPENLEARN_WORKER_ACTIVATE_TIMEOUT_MS` | `60000` | 初始激活等待窗口（最小 5000） |
| `OPENLEARN_WORKER_ACTIVATE_TIMEOUT_PROGRESS_SLIDE_MS` | `min(30000, 初始窗口)` | 每次收到 `activate-progress` 心跳后重置的滑动窗口（最小 3000） |

**滑动超时机制**：Worker 在激活过程中可周期性向主线程发送 `activate-progress` 心跳消息（`packages/core/worker-runtime/types.ts` 的 `ActivateProgressMessage`），主线程收到后重置剩余超时，避免长迁移/IPC 被误杀，同时防止无限挂起。

```typescript
// 心跳消息类型
interface ActivateProgressMessage {
  readonly type: 'activate-progress';
  readonly stage?: string;
  readonly message?: string;
}
```

> 全栈插件若仍频繁超时，调大 `OPENLEARN_WORKER_ACTIVATE_TIMEOUT_MS` 与 `OPENLEARN_WORKER_ACTIVATE_TIMEOUT_PROGRESS_SLIDE_MS` 即可，无需改代码。

> 最后更新：2026-07-26
