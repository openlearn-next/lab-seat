# SDK PR Proposal — plugin bundle bloat (7.7 MB → target <150 KB)

> **Plugin**: openlearn-plugin-lab-seat
> **Date**: 2026-09-06
> **Target repo**: `aymwoo/OpenLearn-Next-V2`
> **Component**: `packages/plugin-sdk`
> **Related**: ROADMAP §1.1

---

## 1. 症状

构建任意插件时服务端 bundle 巨大：

```
dist/index.js   ~7.4 MB   （正常插件期望 100–300 KB）
dist/frontend.js ~0.15 MB （React 已 external，正常）
```

## 2. 根因链（本地核实，含证据）

### 2.1 SDK 的 dist/index.js 自身顶层 import 7 个第三方

`packages/plugin-sdk/dist/index.js`（34 KB）开头的 ESM import：

```js
import pino from "pino";              // L7
import { v7 as uuidv72 } from "uuid"; // L180
import JSZip2 from "jszip";           // L181
import express from "express";        // L182
import { z } from "zod";              // L185
import JSZip from "jszip";            // L275
import semver from "semver";          // L430
```

这些 import 是 **SDK dist 打包时未消除的宿主核心实现**（`PluginDistributionManager`、`manifest-schema`、logger）引用。

### 2.2 CLI 把 SDK inline 进 plugin，且未 external 这些第三方

`packages/plugin-sdk/cli.mjs:218–242`：

```js
const sdkDist = join(__dirname, 'dist', 'index.js');
const buildOpts = (entry, outfile, external = []) => ({
  ...
  external: ['@openlearn/plugin-sdk', ...external],
  plugins: [{
    name: 'resolve-plugin-sdk',
    setup(build) {
      build.onResolve({ filter: /^@openlearn\/plugin-sdk$/ }, () => ({
        path: sdkDist,              // ← 解析为本地 dist 路径
      }));
    },
  }],
});
```

`onResolve` 返回本地路径 → esbuild 把 `sdkDist` 当普通模块 **inline**；因 SDK dist 内部仍顶层 `import express/pino/...`，esbuild 顺带把整棵 express 生态树打包进 plugin（实测 `require_body_parser`、`require_semver`、`require_GenericWorker` 等 23 个 utils 模块）。

### 2.3 worker 无法 external（为什么"直接 external SDK"不可行）

`packages/core/worker-runtime/worker-manager.ts:575–589` 用两种方式加载插件：

```js
// 方式 1: pluginDir 落盘
var fileUrl = urlModule.pathToFileURL(workerData.pluginDir + '/index.js').href;
mod = await import(fileUrl);
// 方式 2: data URL（插件未落盘 / 回退）
mod = await import('data:text/javascript;base64,' + encoded);
```

两种加载都无 `@openlearn/plugin-sdk` 的模块解析（无 node_modules import map）。
→ **插件 bundle 必须自包含**，SDK 被 inline 是设计使然，不能简单 external。

## 3. 修复方向（三选一）

### 方案 A（推荐）：SDK 公共 dist 瘦身 —— 移除值导出的宿主实现类

`packages/plugin-sdk/index.ts` 目前值导出 7 个宿主实现类（L44–52）：

```ts
export {
  PluginRuntimeAdapter, PluginRuntimeComposition, PluginContextAdapter,
  PluginLifecycleManager, PluginCapabilityGateway, UnifiedExtensionRegistry,
  PluginDistributionManager,       // ← 引入 express/jszip
} from '../core/plugin-host/index.js';
```

这些类只应被**宿主进程**（server/composition）使用，插件在 worker 里通过 DI
`ctx.resolve(IPluginDistributionManagerToken)` 消费宿主注入的**实例**，从不 import 实现类。

**改动**：
- `packages/plugin-sdk/index.ts`：删掉 7 个**值导出**（或改为仅保留 `type` 导出）。
- 保留 `IPluginDistributionManagerToken`、`IPluginDistributionManager`（type-only）等 Token 常量 —— 插件 DI 消费不受影响。
- 宿主内部引用这些类处，改从 `../core/plugin-host/index.js` 直接 import（不经过 SDK 包）。
- `packages/plugin-sdk/dist/index.js` 重新 build → 顶层第三方 import 消失，只剩 `Token` 常量 + zod manifest schema。

**预期收益**：dist/index.js 由 34 KB 缩到 ~10 KB；插件 bundle 由 ~7.4 MB 降到 ~100–200 KB（剩 zod + 插件自身代码）。

**兼容性影响**：SDK 3.4.0 CHANGELOG "Unified Plugin Facades: Export PluginDistributionManager..." 曾有意公开这些类。移除前需在 SDK 包内 grep 确认外部插件没有直接 import（当前仅宿主 composition 用）。

### 方案 B：SDK 拆双入口

`package.json` exports 增加 `./runtime` 子路径：

```json
"exports": {
  ".":        { "types": "./dist/index.d.ts",        "import": "./dist/index.js" },
  "./runtime": { "types": "./dist/runtime.d.ts",      "import": "./dist/runtime.js" }
}
```

`runtime.js` 只含 Token/Token 常量/type —— 零第三方。
`cli.mjs` 的 `onResolve` 把插件里 `@openlearn/plugin-sdk` 的重定向到 `./runtime`。

**优点**：完全向后兼容（`.` 保持不变）。**缺点**：SDK 要维护两个入口与双份声明文件。

### 方案 C：cli.mjs 在 inline SDK 时对 SDK 内裸第三方二次 external + 宿主 provide

cli 层把 `express/pino/jszip/...` 加入 external 数组，同时宿主 worker bootstrap
用 `module.register`/注入 provide 这些模块 —— 改动面最大且违反"worker 自包含"约束，**不推荐**。

## 4. 推荐做法

方案 A + B 可叠加，推荐先做 A（一次改动全局受益），B 作为后续增强。

## 5. 验收标准（附 e2e 断言建议）

1. `npm run build`（本插件）后 `dist/index.js < 500 KB`
2. `node --test test/plugin.test.mjs` 全部通过（worker mock harness）
3. 宿主 `activatePlugin(mode='worker')` 真实 worker 加载成功
4. 其余 OpenLearn 插件（builtin.ts 等）build 不受影响

## 6. 附：复现

```bash
cd openlearn-plugin-lab-seat
rm -rf dist && npx openlearn-plugin-sdk build
ls -la dist/index.js   # 观察 ~7.4 MB
# 定位
grep -oE "require_[a-zA-Z0-9_]+" dist/index.js | sort | uniq -c | sort -rn | head
#   → require_utils / require_semver / require_GenericWorker / require_body_parser ...
```

---

## 7. 应用结果（2026-09-06 已落地宿主仓库）

补丁已实际 apply 到 `/home/wuxf/Develop/openlearnv2`（commit `68ee958`，
branch `fix/sdk-stop-exporting-host-runtime-classes`），含两处修改：

1. `packages/plugin-sdk/index.ts`：删除 7 个实现类的**值导出**，保留 type-only 导出。
2. `packages/core/plugin-host/__tests__/sdk-compatibility.test.ts`：实现类改从
   core 规范路径 import（Token/DI 常量仍从 SDK 取），使测试契约与新设计一致。

### 实测数据

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| SDK `dist/index.js` | 34 KB（顶层 import express/jszip/pino/semver/uuid） | **7.7 KB**（仅 uuid 顶层 import） |
| 插件 `dist/index.js` | 7.4 MB | **0.20 MB**（-97%） |
| 插件 zip | 7.8 MB | **0.42 MB** |
| SDK/core 测试 | — | **155/155 green** |
| lab-seat 单测/集成 | 48 | **48/48 green** |
| lab-seat E2E | — | **通过** |

### 复现步骤（未来迭代）

```bash
cd /home/wuxf/Develop/openlearnv2/packages/plugin-sdk
node build.mjs                       # dist → 7.7 KB
# 插件侧若用 workspace/本地 SDK，重新 npx openlearn-plugin-sdk build 即可拿到瘦身
```

### 注意（升级发布提醒）

- 这是**破坏性 API 变更**（对依赖 `import { PluginDistributionManager } from '@openlearn/plugin-sdk'` 的外部插件）；
  若担心兼容，可先发布为 minor + CHANGELOG 说明，或叠加方案 B（`/runtime` 子路径双入口）平滑过渡。
- 已发布插件重装需用新 SDK 重新 build（旧 7.4 MB bundle 仍可用，只是偏大）。
