---
title: DeepSeek Harness 桌面端技术方案分析
summary: 剖析 dsh apps/desktop（Electron 壳）与 apps/desktop-host（RunAsNode 后端宿）的分工、进程模型、协议拦截、安全配置与打包分发，作为 HiBuddy Electron 桌面端的参考蓝本
keywords: [deepseek-harness, dsh, Electron, 桌面端, RunAsNode, 自定义协议, 进程模型, 安全配置]
status: accepted
date: 2026-10-31
---

# DeepSeek Harness 桌面端技术方案分析

> 依据：thirdparty/deepseek-harness（sparse 快照，2026-10-31）源码实证。HiBuddy 桌面端规划见 [system-architecture.md](../architecture/system-architecture.md) §2.1/§11 与 ADR-007（待立）；运行时选型见 [ADR-002](../decisions/ADR-002-agent-runtime-selection.md)。

## 1. 双应用分工：壳与宿分离

| 应用 | 包名 | 角色 |
|---|---|---|
| `apps/desktop` | `@deepseek-ai/dsh-desktop` | Electron **主进程/壳**：窗口、托盘、协议、IPC、更新、欢迎页；自身不含业务后端 |
| `apps/desktop-host` | `@deepseek-ai/dsh-desktop-host` | **Node 模式宿进程**：以 `ELECTRON_RUN_AS_NODE=1` 的子进程运行，承载完整 dsh 后端（agent、插件、会话、调度等全部 workspace 包） |

分开的理由：**安全边界**（壳与渲染进程零 Node 权限，后端全能力收敛到受控子进程）+ **架构复用**（Host 就是普通 dsh profile，与 CLI/Web 共用 `runProfile` 启动路径）。

## 2. 技术栈

- **Electron ^44.7.0**（非 Tauri）；electron-builder ^26 + electron-updater ^6。
- TypeScript ^6，纯 ESM；主进程 bundle 用 **tsdown**（非 electron-vite），dev 启动器 `tsx scripts/dev.ts`。
- 渲染层**不是独立桌面前端**：手写静态 HTML（壳自有页）+ 复用 Web UI dist（见 §4）；欢迎页用 React 18。
- koffi（FFI）做 native 集成；依赖打包由 `scripts/desktop-bundle-imports.mjs` 静态校验可解析性。

## 3. 进程模型（对 HiBuddy 最关键）

- **拉起**：`host-process.ts` 以 `spawn(process.execPath, ['--expose-internals', entry, runtimeDir, projectDir, ...], { stdio:[...,'ipc'] })` 启动 Host——即 Electron 二进制以 Node 模式跑 dsh 宿（免带独立 Node 运行时）。
- **端口治理**：Host 经 `runProfile({ profile:'desktop', args:['--no-open','--host','127.0.0.1','--port','0'] })` 启动，**端口 0 由 OS 分配**（避免与 Web 固定 3080 冲突），仅绑 127.0.0.1；就绪后经 Node IPC 回 `{ type:'ready', url, injections }`（authenticatedUrl + index 注入）。
- **生命周期**：壳发 `shutdown` → Host 排空（`quit-inspection` 以 2s deadline 报告活动任务/定时任务）→ `shutdown-complete`；宿与壳同生共死。另有 update-tasks 的 inspect/lock/unlock 支撑更新期互斥。

## 4. 前端复用与协议拦截

- `apps/web`（vite build over `@deepseek-ai/dsh-client-web`）产出的 dist **同时**被 CLI `dsh web` 与桌面使用——一套 UI、两种载体（对应 HiBuddy "同一套接口，桌面只是本地部署形态"）。
- 桌面注册特权协议 **`dsh-app://`**（standard/secure/supportFetchAPI/corsEnabled）：`/`、`/assets/` 静态服务自 web-frontend dist（index.html 注入引导脚本）；其余请求**带认证 cookie 转发 Host**（剔除 set-cookie/逐跳头，插件 bundle 强制 no-store）——渲染进程不持凭据。
- 渲染端经 `DESKTOP_IPC.boot` 获取 `injections + streamBaseUrl`；桌面专有能力由沙箱 preload 暴露 `DshDesktopProductApi`（文件操作、浏览器桥、拖拽、快捷键、目录选择、更新展示），**同一份 client 代码按注入能力分流**。
- 壳自有页走 `dsh-app://shell/`（与业务页同协议不同路径）。

## 5. 桌面能力集成

托盘（Windows 全程、菜单 Open/Quit）、通知（仅强制更新就绪）、原生目录选择/文件拖拽（path/sha256/size 由 Host 读取）、deep link（`setAsDefaultProtocolClient('dsh')` + `dsh://open` 唤起）、单实例锁、自动更新（electron-updater 封装 + 强制更新流 + 安装前停 Host）、多窗口（主窗/欢迎窗/更新 overlay + WebContentsView 嵌平台页 + 内嵌浏览器）、全局快捷键、麦克风权限。

## 6. 安全配置（与 HiBuddy 安全基线逐条对齐）

- 全部窗口统一 `nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true`。
- **10+ 个细分沙箱 preload**（app/browser/menu/platform/theme/update-dialog/mandatory/welcome）——能力面按窗口最小化。
- 壳静态页自带严格 meta CSP（`default-src 'none'`）。
- IPC 全面 sender 校验：限定主窗口 mainFrame 且 url 前缀 `dsh-app://app/`。
- Host 凭据换**一次性 cookie** 由壳持有、不下发页面；WS 过滤器校验 origin；`setWindowOpenHandler` 外链转系统浏览器。

## 7. 打包与分发

electron-builder：asar + asarUnpack（dsh 树）、extraResources 内嵌**独立 Python/Node/pnpm 发行版**（离线可用）。目标：Windows NSIS（自研 .nsh 安装器）、macOS dmg+zip（@electron/notarize 公证）、Linux AppImage；三平台产物脚本 + 腾讯云 COS 发布、Windows EV 硬件签名。壳与 dsh 核心同版本发布。

## 8. 对 HiBuddy 的映射建议

| dsh 实践 | HiBuddy 采纳点（对应技术方案） |
|---|---|
| 壳（零 Node）+ RunAsNode Host 子进程 | ADR-004 进程模型首选形态；`@hibuddy/desktop-shell` 主进程只做窗口/托盘/协议，`@hibuddy/desktop-host` 以子进程运行并内嵌 dsh runtime |
| `--port 0` + IPC 回传 authenticatedUrl | 桌面端本地 server 端口治理直接采纳（替代固定端口+端口冲突处理） |
| `dsh-app://` 协议拦截 + 认证转发 | HiBuddy `hibuddy-app://`（或复用同思路）：静态资源本地服务、API 带一次性凭证转发 127.0.0.1 |
| 一套 web dist 两种载体 | dsh web 前端 + `@hibuddy/web-ui` client 插件桌面/Web 共用；桌面能力经 preload 注入 + 能力分流 |
| 细分沙箱 preload + IPC sender 校验 + 严格 CSP | §11 安全基线细化项（渲染进程不持密钥的具体机制） |
| quit-inspection 排空报告 | PRD FR-09"应用关闭则 server 退出"的活动任务检查实现参考 |
| extraResources 内嵌运行时 | 离线可用性的兜底手段（P1 酌情） |

> 与 dsh 的差异点（依 [ADR-003](../decisions/ADR-003-dsh-based-customization.md) 更新）：HiBuddy 同样采用壳+宿分离，宿进程同样内嵌 dsh runtime 并复用 `runProfile`——仅 profile 名改为 `hibuddy`（dsh desktop-host 硬编码 `'dsh'`，故宿进程自建）；Electron 壳自建以获得品牌与打包自主权；渲染层直接复用 dsh web 前端（React）+ HiBuddy client 插件，无需手写静态页。

## 9. 关键源码索引（thirdparty/deepseek-harness）

| 路径 | 职责 |
|---|---|
| `apps/desktop/src/main.ts` | 主进程入口：窗口/协议/IPC/启动编排 |
| `apps/desktop/src/host-process.ts` | RunAsNode Host 子进程 spawn 与消息协议 |
| `apps/desktop-host/src/index.ts` | Host 入口：runProfile + IPC 应答（ready/fatal/quit） |
| `apps/desktop/src/web-document.ts` | dsh-app 静态服务 + 认证转发 |
| `apps/desktop/src/ipc.ts` / `preload-app.ts` | IPC 通道定义与沙箱 preload API |
| `apps/desktop/src/tray.ts` / `single-instance.ts` / `update-coordinator.ts` | 托盘/单例/更新 |
| `apps/desktop/src/welcome-window.ts` / `platform-view.ts` / `browser-guests.ts` | 多窗口体系 |
| `apps/desktop/scripts/electron-builder-config.mjs`、`installer/` | 打包与 NSIS 安装器 |
