# 宿主共享依赖白名单 (HostSharedDeps)

> **适用范围**：`@openlearn/plugin-sdk@3.4.3`
> 本页说明打包前端插件时**必须 external（不可打进 bundle）** 的宿主全局库，及其精确版本，防止因重复打包导致包体积过大或 "Invalid hook call" 等重复加载错误。

---

## 1. 宿主全局提供的共享库（务必 external）

**恰好 4 个库**由宿主在运行时注入为全局变量，前端插件**必须**标记为 external：

```
react, react-dom, recharts, lucide-react
```

三处定义必须一致（实际一致）：
- **SDK 构建 CLI 硬编码 externals 数组**（`packages/plugin-sdk/cli.mjs:276, 292`）：
  ```js
  ...buildOpts(frontendEntry, join(distDir, 'frontend.js'), ['react', 'react-dom', 'recharts', 'lucide-react'])
  // buildOpts 内部拼接：external: ['@openlearn/plugin-sdk', ...external]  (cli.mjs:231)
  ```
- **运行时 `window.HostSharedDeps`**（`src/main.tsx:14-18`）：
  ```ts
  (window as any).HostSharedDeps = { React, ReactDOM, Recharts, LucideReact };
  ```
- **宿主 import map**（`index.html:7-16`，将裸指定向到上述全局）：`react` / `react-dom` / `recharts` / `lucide-react` 均映射到 `window.HostSharedDeps.*`。

脚手架模板注释亦明示（`scaffold/templates/full-stack/src/frontend.tsx:5-6`）："Host shared dependencies (react, react-dom, recharts, lucide-react) are provided via window.HostSharedDeps — do not bundle them."

> **不在此清单内的一切库均不被宿主提供**。若插件 `import` 了 `react-konva`、`konva`、`socket.io-client`、`motion`、`react-markdown`、`@lucide/lab` 等，它们**不在** `HostSharedDeps` 也不在 import map——插件必须自行打包，否则加载时 import 失败。

---

## 2. 精确版本（共享库）

版本取自 `package.json`（声明范围）与 `node_modules`（实际安装）。

| 库 | 声明范围 | 实际安装 | 宿主共享？ |
|---|---|---|---|
| `react` | `^19.0.1` | `19.2.7` | ✅ 是 |
| `react-dom` | `^19.0.1` | `19.2.7` | ✅ 是 |
| `recharts` | `^3.8.1` | `3.8.1` | ✅ 是 |
| `lucide-react` | `^0.546.0` | `0.546.0` | ✅ 是 |

---

## 3. 必须自行打包的库（非共享）

以下宿主依赖但**不**共享给插件，插件若使用需打进 bundle（版本取自 `package.json`）：

| 库 | 声明范围 | 实际安装 | 宿主共享？ |
|---|---|---|---|
| `react-konva` | `^19.2.4` | `19.2.5` | ❌ 否 |
| `konva` | `^10.3.0` | `10.3.0` | ❌ 否 |
| `socket.io-client` | `^4.8.3` | `4.8.3` | ❌ 否 |
| `motion` | `^12.23.24` | `12.40.0` | ❌ 否 |
| `react-markdown` | `^10.1.0` | `10.1.0` | ❌ 否 |
| `@lucide/lab` | —（未声明） | **未安装** | ❌ 否（宿主根本不依赖） |
| `react-konva-utils` | `^2.0.0` | — | ❌ 否 |
| `reveal.js` | `^6.0.1` | — | ❌ 否 |
| `pptx-preview` | `^0.0.5` | — | ❌ 否 |
| `xlsx` | `^0.18.5` | — | ❌ 否 |
| `jspdf` | `^4.2.1` | — | ❌ 否 |
| `zustand` | `^5.0.14` | — | ❌ 否 |

> ⚠️ **文档口径纠正**：部分旧文档（`docs_plugin_guide.md:708`）提及 `window.HostSharedDeps.socketService` / `uiService`，但运行时 `main.tsx:14` 仅暴露 `React` / `ReactDOM` / `Recharts` / `LucideReact` 四键，**无** `socketService` / `uiService` 键。宿主虽依赖 `socket.io-client`，但当前未将其暴露为全局。以本页四键清单为权威。

---

## 4. 打包规范（工具、配置、出错表现）

- **打包工具：`esbuild`**（插件构建**不**使用 Vite/Rollup）。SDK 自有可发布 bundle 亦为 esbuild（`build.mjs:25`）。
- **配置/入口**：插件无独立 Vite/Rollup 配置文件。构建完全由 SDK CLI `openlearn-plugin-sdk build` 驱动（源码 `packages/plugin-sdk/cli.mjs`；二进制声明于 `packages/plugin-sdk/package.json:19-20`）。
- **如何触发构建**：脚手架插件置 `"build": "openlearn-plugin-sdk build"`（`scaffold/templates/full-stack/package.json`）。
- **externals 如何设置**：由 CLI **自动注入**，插件作者无需在打包器配置中声明。前端 externals 数组 `['react','react-dom','recharts','lucide-react']` 硬编码于 `cli.mjs:276,292`；服务端 bundle 另加 `@openlearn/plugin-sdk`（`cli.mjs:231`）。
- **manifest 层声明**：脚手架模板声明 `peerDependencies: { "react": ">=17", "react-dom": ">=17" }`（`full-stack` 与 `frontend-only` 模板）。这是"插件消费宿主 React"的人类/清单信号，**不参与** externals 计算（externals 为硬编码）。
- **若手动打包忘记 external**：宿主遗留脚本 `scripts/build-plugins.mjs:67` 仅把 `external: ['react','react-dom']`（漏了 `recharts` / `lucide-react`），是复制粘贴隐患。未 externalize `react` / `react-dom` 会导致**第二个 React 实例**，表现为 "Invalid hook call" / Context 断裂。使用标准 `openlearn-plugin-sdk build` CLI 不会遗漏（数组被强制注入）；仅在手写 esbuild/vite 步骤时才会有此风险。

---

## 5. `HostSharedDeps` / 白名单常量

- **SDK 中不存在名为 `HostSharedDeps` 的 TS 常量或导出白名单**：在 `packages/plugin-sdk`（`*.ts`）中 grep `HostSharedDeps` / `sharedDeps` / `external:` 均无功（`index.ts`、`openlearn.d.ts` 未导出此类常量）。
- 该名称仅作为**运行时 `window` 全局**存在（`src/main.tsx:14`），并被文档引用（如教程 "宿主依赖共享网关 (HostSharedDeps)"）。
- **事实白名单 = `cli.mjs:276/292` 的硬编码数组 + `index.html` import map 的四键**。二者为权威来源且当前一致。若要新增共享库，需**同时**修改：`cli.mjs`（externals 数组）、`src/main.tsx`（全局）与 `index.html`（import map）。

> 最后更新：2026-07-26
