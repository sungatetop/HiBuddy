---
title: ADR-004 桌面端壳+宿进程方案
summary: 自建 Electron 壳（@hibuddy/desktop-shell）+ RunAsNode 宿进程（@hibuddy/desktop-host）复刻 dsh desktop 模式；宿按名启动 $DSH_HOME/profiles/hibuddy（与 CLI/Web 同装配路径，插件安装天然互通）；P0 渲染层直连宿 authenticatedUrl（与 Web 部署同安全模型），hibuddy-app:// 特权协议降为 P1 加固项
keywords: [ADR, Electron, 桌面端, RunAsNode, desktop-host, desktop-shell, profile, hibuddy-app, 端口治理, 打包]
status: accepted
date: 2026-11-01
---

# ADR-004 桌面端壳+宿进程方案

> 依据：[dsh-desktop-analysis.md](../references/dsh-desktop-analysis.md)（dsh 桌面端剖析）、[ADR-003](ADR-003-dsh-based-customization.md) §3（自建壳+宿路线）、[system-architecture.md](../architecture/system-architecture.md) §2.1/§5.3。
> 实证基线：thirdparty/deepseek-harness 快照（2026-10-31）+ 本仓库 node_modules 内 `@deepseek-ai/dsh@0.2.1-rc.5` 的公开类型声明（profile-boot.d.ts、dsh-app-boot index.d.ts/profile.d.ts），证据索引见 §5。

## 1. 背景与决策点

桌面端形态已在 ADR-003 定为"自建 Electron 壳 + 宿进程，复刻 dsh apps/desktop + desktop-host 模式"。本 ADR 落实现细节，需定案：

1. 进程模型（壳/宿如何分工、宿如何以内嵌 dsh runtime 启动）；
2. profile 装配来源（宿进程按名解析 `$DSH_HOME` profile，还是像 dsh desktop 一样携带应用内 profile 目录）；
3. 渲染层加载方式（`hibuddy-app://` 特权协议转发，还是直连宿进程 authenticatedUrl）；
4. 宿↔壳 IPC 协议、`--port 0` 端口治理、退出检查（quit-inspection）；
5. Windows 打包分发方案。

关键实证事实（影响决策）：

| 事实 | 来源 |
|---|---|
| `runProfile(options)` 由 npm 包 `@deepseek-ai/dsh/profile-boot` 公开导出：`{ environment, profile, resolvedProfile?, patchFiles, args, packageManager? } → Promise<{ ctx, shutdown }>`；不传 `resolvedProfile` 时走命名 profile 初始化（从 `$DSH_HOME/profiles/<name>` 解析） | `@deepseek-ai/dsh@0.2.1-rc.5` lib/types/profile-boot.d.ts |
| `loadLayeredEnv(binName, cwd?)`（分层 .env 快照）、`loadProfileDirectory(binName, dir, installAnchor)`、`reportSkippedBundles` 均为公开导出；`@deepseek-ai/dsh-app-boot@0.2.1-rc.5` 已发布 npm（dsh 的固定版本依赖） | 同上 + pnpm store 实测 |
| `@deepseek-ai/dsh-desktop-host` 是 **private workspace 包，未发布 npm** | apps/desktop-host/package.json（`"private": true`） |
| 宿进程以 Electron 二进制 Node 模式运行：`spawn(process.execPath, ['--expose-internals', entry, ...], { stdio: ['ignore','pipe','pipe','ipc'] })`，env 注入 `ELECTRON_RUN_AS_NODE: '1'` | apps/desktop/src/host-process.ts、node-environment.ts |
| 就绪回传：`ctx.connection.authenticatedUrl(protocol + '//127.0.0.1:<port>')` + `ctx.webServer.collectIndexInjections(ctx.connection.browserPeer)`；端口由 `--port 0` 由 OS 分配 | apps/desktop-host/src/index.ts L142-143 |
| quit-inspection：宿侧读 `ctx.get('agents')`/`ctx.get('jobs')` + `workspace/session-activity` waterfall，壳侧 2s deadline | apps/desktop-host/src/quit-inspection.ts、host-process.ts L59 |

## 2. 决策

### D1 进程模型：壳（零 Node 权限）+ RunAsNode 宿子进程

- `@hibuddy/desktop-shell`（`desktop/shell/`）：Electron 主进程，只做窗口/托盘/生命周期/宿进程管理；全部窗口 `nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true`。壳自身不 import 任何 `@deepseek-ai/*`。
- `@hibuddy/desktop-host`（`desktop/host/`）：普通 Node ESM 包，依赖 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-launch-environment`、`@deepseek-ai/dsh-home-paths`（均钉 0.2.1-rc.5）。由壳以 RunAsNode 子进程拉起：

```ts
spawn(process.execPath, ['--expose-internals', hostEntry], {
  cwd: projectDir,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
```

- 与 dsh 的差异：dsh 宿入口在打包 runtimeDir 的 node_modules 内；HiBuddy 宿入口即 `desktop/host/lib/index.js`（开发态 = workspace 产物，打包态 = 随 asarUnpack 资源），路径由壳按运行形态解析。

### D2 profile 装配：宿按名启动 `$DSH_HOME/profiles/hibuddy`（不携带应用内 profile）

宿进程调用 `runProfile({ environment: loadLayeredEnv('hibuddy', projectDir), profile: 'hibuddy', patchFiles: [], args: [...] })`，**不传 `resolvedProfile`**——与 CLI/Web 完全同一条命名 profile 解析路径。

- **能力面完整性理由（最高优先）**：`dsh plugin --profile hibuddy add/remove` 修改的就是 `$DSH_HOME/profiles/hibuddy`，Web UI 图形化插件管理同样写该目录。宿按名启动后，CLI/Web/桌面三端的插件安装/启停/patch 分层操作作用于同一 profile 目录，天然互通——零适配。
- 对比 dsh desktop 的 `loadProfileDirectory(projectDir)` 方案（应用内携带 profile 副本）：会把 profile 装进只读安装目录或与 `$DSH_HOME` 分叉，插件安装语义两端不一致，故**不采纳**。
- 打包态 profile 引导：首次启动时若 `$DSH_HOME/profiles/hibuddy` 不存在，壳把随应用分发的 profile 模板复制过去（幂等，不覆盖已存在目录）；之后与开发态无差别。
- `packageManager` 参数：开发态省略（插件包操作走环境 PATH 内的 pnpm）；打包态插件安装所需的 pnpm 内嵌方案在 S1-D 定案并验证（S5 桌面端插件安装终验前必须闭环）。
- `ELECTRON_RUN_AS_NODE=1` 下 `loadLayeredEnv` 的 projectDir：开发态 = 仓库根（复用根 `.env`，如 MINIMAX_CN_API_KEY）；打包态 = Electron `userData` 目录。

### D3 端口治理：`--port 0` + IPC 回传 authenticatedUrl

宿 `args: ['--no-open', '--host', '127.0.0.1', '--port', '0']`（OS 随机端口，仅绑 loopback）；`application` settle 后取 `ctx.webServer.port` 构造 `ctx.connection.authenticatedUrl(...)` 经 IPC `ready { url }` 回传壳。壳不感知端口号，无从固定端口冲突。

### D4 渲染层：P0 直连 authenticatedUrl，`hibuddy-app://` 降为 P1 加固

- **决策**：BrowserWindow 直接 `loadURL(host 的 authenticatedUrl)`。安全模型与 Web 自部署形态等价：launch token 换 dsh 签名 cookie、WS origin 校验、dsh client 重连语义全部是 dsh 原生实现，桌面复用零成本；LLM 密钥始终只在宿进程内（渲染器 token 仅授予本地会话访问，与浏览器持 cookie 同级）。
- 壳侧导出闸兜底：`will-navigate` 仅允许宿 URL 同源；`setWindowOpenHandler` 一律转系统浏览器打开外链。
- **`hibuddy-app://` 特权协议（静态资源本地服务 + 剥凭证转发 + 细分沙箱 preload）降为 P1**：dsh 引入该协议的动因是其多窗口/嵌入平台页/壳自有静态页体系；HiBuddy P0 单窗口直连无此需求，复刻成本与收益不成比例。若 P1 出现"渲染器不持任何凭据"的硬需求（如多用户、远端宿），再按 dsh 方案补建。
- 与实施计划任务 4 表述的差异（"hibuddy-app:// 特权协议、细分沙箱 preload"）：本 ADR 将其从 S1 交付物调整为 P1 演进项，实施计划 S1 验收标准（A5/A6）不受影响——验收只要求窗口加载内嵌 runtime 界面并跑通任务。

### D5 宿↔壳 IPC 协议（采纳 dsh 消息集的 P0 子集）

宿 → 壳（Node IPC，`process.send`）：

| 消息 | 载荷 | 时机 |
|---|---|---|
| `starting` | `{ runId }` | 宿入口即发（后续诊断关联） |
| `ready` | `{ url }` | `runProfile` settle、webserver 就绪 |
| `fatal` | `{ message, diagnostic }` | 启动失败（diagnostic 为完整 inspect 后的错误）；随后退出码 1 |
| `shutdown-complete` | — | 收到 `shutdown` 并完成排空后 |
| `quit-inspection` | `{ requestId, activeTasks, scheduledTasks }` | 应答壳的检查请求 |

壳 → 宿：`shutdown`（请求排空退出）、`quit-inspection { requestId }`。

P0 不实现 dsh 的 `file-drag-resource`/`update-tasks`/`platform-session`/`plugin-operation`（对应能力为 P1/P1+）。

### D6 退出检查（FR-09"应用关闭则 runtime 退出"的实现）

宿注册 quit-inspector（复刻 dsh 语义）：`ctx.get('agents')` 列出活动代理，结合 `ctx.get('jobs')` 判定 `activeTasks`；`workspace/session-activity` waterfall 判定 `scheduledTasks`。壳关闭窗口前以 2s deadline 发起检查：有活动任务 → 弹确认框（退出将中断任务）；无 → 发 `shutdown` 并等待 `shutdown-complete`（宽限 10s，超时 SIGTERM→SIGKILL 升级），宿退出后壳才退出——无残留进程。

### D7 壳的窗口与生命周期（P0 范围）

单实例锁（第二实例聚焦已有窗口）；主窗口关闭即走 D6 退出流程（不做"关闭最小化到托盘"）；托盘提供 Open/Quit 两项（Windows 常驻托盘行为与 dsh 一致）；无 deep link、无自动更新（P0 不做，S5 仅评估）。

### D8 打包（S1-D 实施定稿）

产物链路：`pnpm deploy --prod` 双树（宿 + profile 模板）→ `materialize-deploy.mjs` 物化 → electron-builder（NSIS）→ `HiBuddy-Setup-<version>.exe`。

- **壳（asar 内）**：`lib/main.js` + `assets/**` + `package.json`，`asar: true`；壳无原生依赖，`npmRebuild: false` 跳过 @electron/rebuild 联网下载。
- **宿与 profile（asar 外，普通资源）**：宿 bundle 及完整依赖树（含 koffi 等预编译原生模块）放 `resources/host/`，profile 模板放 `resources/profile/`。**经 afterPack 钩子 cpSync 拷入**，不用 extraResources——其排除源目录根 node_modules（dsh 源码注释证实）且重叠目标条目不合并，均与本树结构冲突。afterPack 先于 NSIS 打包执行，拷入内容进入安装载荷。
- **物化（materialize-deploy.mjs）**：pnpm deploy 产物含 junction/symlink，Windows NSIS 链路无法携带，须替换为实体文件并剪除运行时不会读取的 `.map/.d.ts/.tsbuildinfo`（`.md` 保留——dsh skills 运行时可能加载）。**剪除必须递归进入解引用产生的新子树**：首版只在原树遍历，漏掉 41,408 个链接内部 dev 文件。
- **Electron 精确钉版**：dsh 宿对 Electron 版本指纹有编译期白名单（0.2.1-rc.5 支持 43.0.0/44.0.0/44.7.0/45.0.0-alpha.6），`^44.7.0` 会浮动到未受支持版本使宿启动即 fatal；devDep 必须 `"electron": "44.7.0"`，升级 dsh 时同步核对白名单（纳入 ADR-005 升级清单）。
- **electron-builder 26 配置**：`.config.mjs` 不被自动发现，须显式 `--config electron-builder.config.mjs`（dsh 同款做法）；`electronFuses: { runAsNode: true }` 打包态必须显式开启（RunAsNode 是宿启动前提）；`electronDist` 指向本地 dist。
- **NSIS 安装行为（实测）**：安装 = 内嵌 7z 载荷解压到 `%TEMP%` 的 `$PLUGINSDIR\7z-out`，再 `CopyFiles`（SHFileOperation）到 `$INSTDIR`。CopyFiles 失败**静默跳过**，仅有 retry 循环兜底：实测 C 盘空间不足时 68k 文件静默丢失、卸载器写成 0 字节、注册表项未写，安装器仍报成功。**安装期峰值磁盘 ≈ 2× 树体积**（解压临时 + 安装目标同盘时）；分发与验证安装时须保证 `%TEMP%` 与安装盘空间充足，必要时以 `TEMP=<盘>` 启动安装器把解压临时转移。后续每次发版验收必须做"安装后文件计数 = win-unpacked 计数"比对。另实测：assisted 安装器（oneClick=false）在 `/S` 静默模式下 UAC 提权握手会 wedge（内层提权实例空转、外层退出码 2、零文件落盘，本机 2026-11-01），自动化验收不走 `/S`，以交互向导或后续评估 perMachine/oneClick 组合为准。
- **首启引导（D2 的打包态实现）**：壳 `ensureDshProfile()` 在 `app.isPackaged` 时把 `resources/profile` 模板复制到 `$DSH_HOME/profiles/hibuddy`（已存在则跳过，幂等）；`projectDir` 打包态 = `app.getPath('userData')`。

## 3. 备选方案对比（关键决策点）

| 决策点 | 采纳 | 备选 | 否决理由 |
|---|---|---|---|
| profile 装配 | 按名解析 `$DSH_HOME/profiles/hibuddy`（D2） | dsh desktop 式应用内携带 profile 目录（`loadProfileDirectory`） | 插件安装/分层配置写入点分叉，能力面完整性受损 |
| 渲染层 | 直连 authenticatedUrl（D4） | `hibuddy-app://` 协议 + 剥凭证转发 | P0 单窗口场景收益低、复刻成本高；安全等价于已被接受的 Web 部署模型 |
| 宿启动 | RunAsNode 子进程（D1） | 独立 Node 子进程 / 只做壳内嵌 webview 指向外部 `dsh web` | 前者要求用户装 Node，后者违背"应用关闭则 runtime 退出"（FR-09）与离线形态 |
| 退出 | quit-inspection + 排空（D6） | 直接 kill / 无提示退出 | 违背 FR-09 安全终止语义；杀掉运行中任务 |

## 4. 影响

- `desktop/host`、`desktop/shell` 两包按本 ADR 实施（S1-B/S1-C）；加入 workspace 的 `desktop/*` glob（已在 pnpm-workspace.yaml）。
- `system-architecture.md` §3 技术栈表"桌面壳"行的 [ADR-pending] 解除；§5.3 与本文一致（直连 authenticatedUrl 为 P0 形态）。
- S1-D 打包按 D8 概要实施；S5 桌面通知/更新评估不回改本 ADR 的进程模型。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| RunAsNode 在未来 Electron 版本被收紧（上游已有讨论） | Electron 版本锁定（D8 打包时钉住并写入 ADR-005 升级清单）；升级前验证 RunAsNode 启动路径 |
| 打包态插件安装缺 pnpm/Node 启动器 | S1-D 明确验证项；不通过则按 dsh extraResources 方案内嵌 pnpm 入口 + `packageManager` 参数 |
| dsh 升级改动 profile-boot/runProfile 签名 | 耦合点已显式登记（本 ADR §1 表）；ADR-005 升级流程 diff 这些声明文件 |
| 渲染器直连 URL 的 token 暴露面 | token 仅授予 loopback 会话（与 Web 形态同级）；导航闸（D4）防外泄；P1 协议化可收敛 |

## 6. 关键源码索引

| 路径（thirdparty/deepseek-harness） | 参考 |
|---|---|
| `apps/desktop-host/src/index.ts` | 宿入口：runProfile 调用、IPC 应答、authenticatedUrl 构造 |
| `apps/desktop/src/host-process.ts` | 壳侧 spawn、消息校验、stop 升级终止 |
| `apps/desktop/src/node-environment.ts` | ELECTRON_RUN_AS_NODE 环境构造 |
| `apps/desktop-host/src/quit-inspection.ts` | 退出检查实现 |
| `@deepseek-ai/dsh@0.2.1-rc.5 lib/types/profile-boot.d.ts` | runProfile 公开契约（node_modules 内） |
| `@deepseek-ai/dsh-app-boot@0.2.1-rc.5 lib/types/` | loadLayeredEnv/loadProfileDirectory 公开契约 |
