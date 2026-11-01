---
title: dsh Web 与 CLI 技术方案剖析（apps/web、apps/cli）
summary: 剖析 deepseek-harness 的 apps/web（纯构建产物包、双注入通道）与 apps/cli（单 bin 四模式、profile 分层配置、启动编排）技术方案，产出对 HiBuddy 的 12 条机制级借鉴清单；HiBuddy server 单进程 serve dist + /api + SSE 的直接输入
keywords: [deepseek-harness, web, cli, profile, 单进程部署, 启动编排, boot manifest, HiBuddy]
status: accepted
date: 2026-10-31
---

# dsh Web 与 CLI 技术方案剖析（apps/web、apps/cli）

> 本文是 HiBuddy 技术方案（[system-architecture.md](../architecture/system-architecture.md)）Web 部署形态、启动编排与配置机制的直接输入。分析基于 thirdparty/deepseek-harness sparse 克隆（2026-10-31）。

## 1. apps/web：纯构建产物包（@deepseek-ai/dsh-web-frontend）

**定位：不是可独立运行的应用，只是 dist 构建产物包。** `apps/web/package.json` 自述 "vite build over the @deepseek-ai/dsh-client-web shell library; dist/ served by apps/cli's dsh web"；exports 仅 `./dist/*`，`files` 只含 dist（排除 sourcemap/preview）。**前端业务 UI 不在此打包**——shell 库的 `AppWebEntry` 之外，业务 UI 由 host 端 client-modules 扫描 cordis 配置树生成 boot manifest（`window.__DSH_BOOT__`），在运行时注入。

### 1.1 构建要点（vite.config.ts）

| 机制 | 实现 | 动机 |
|---|---|---|
| 相对资源路径 | `base: './'` | dist 可挂任意反代前缀、可由任意路径 serve |
| 拒绝裸 serve | `rejectStandaloneServe()` 插件让裸 `vite dev/serve` 直接报错 | 把"必须由 host 注入启动数据"编码进构建配置，杜绝绕过 host 的错误使用方式 |
| preview 产物 | `emitPreviewPage()` 额外产出 `preview.html` + `preview/`（静态 Worker 部署面） | 组件预览独立部署面 |
| 分包 | manualChunks：vendor（katex/shiki/micromark）、`assets/langs`（懒语法）、`assets/fonts` | 控制首屏体积 |

### 1.2 双环境注入通道（src/main.ts）

入口探测 `globalThis.dshDesktopBoot` 分流：

- **桌面模式**：等 `desktop.ready()` 返回 injections + streamBaseUrl，写 `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`，用 `__DSH_BOOT_READY__`（PromiseWithResolvers）门闩同步时序——同一 bundle 无需重构建即可跑在 Electron IPC 桥上。
- **Web 模式**：直接 `entry.run()`；环境数据由 server 渲染 index.html 时按 Peer 注入（webserver 的 `collectIndexInjections/renderIndex`）。

### 1.3 部署形态

- dist 由 `dsh web` 进程经 webserver fallback 座位 serve（见 §3）；**单端口单进程承载静态 dist + `/api` RPC + WS/SSE 流 + HMR 事件流 + `/plugins/<id>/client.js` 插件 bundle**。
- Electron 桌面走 `file://` + IPC 桥，不经此服务器（docs/subsystems/web-server.md 明言）。
- 公开部署靠反向代理：docs/user/guide/public-deployments.md 规定代理须保留 Host、剥离挂载前缀、转发 Upgrade、重写 cookie Path/Secure；**`--public-url` 只是广告（生成给用户看的 URL），`--trusted-host` 才是信任边界**。

## 2. apps/cli：命令体系与 profile 机制（@deepseek-ai/dsh）

### 2.1 命令体系（src/bin.ts + src/args.ts）

单一 bin `dsh`，四种模式：

| 模式 | 触发 | 行为 |
|---|---|---|
| profile（默认） | `dsh <name>` ≡ `--profile <name>` | 组合配置并启动 harness |
| plugin | `dsh plugin ...` | 转发 pnpm 管理 profile 依赖 |
| dump-config | `--dump-config` | 不启动，打印组合后的配置树 |
| dump-config-schema | `--dump-config-schema` | 打印 JSON Schema |

**launcher/app 参数边界协议**：launcher 只解析自己的 flags（`--profile/--from-default-profile/--patch/--dump-*`），**第一个不认识的 token 起全是 app 参数**——原样放入 `ctx.cmdlineArgs` 不可变快照，供任意插件自行解析。`desktop` 名保留给 Electron，CLI 拒绝启动。

### 2.2 profile 分层配置（src/profile-boot.ts `runProfile`）

patch 组合顺序（后层覆盖前层）：

```
bundle 层（manifest dsh.profile.bundles 顺序）
  → profile cordis.patch.yml
  → home 层 $DSH_HOME/cordis.patch.yml
  → --patch overlays
  → telemetry
```

配套机制：

- 空根 `cordis.yml` 每次重写（防 Loader 写回重复）。
- `createRuntimeResolution`：在任何插件 import 前**冻结不可变模块解析**（安装目录优先、profile node_modules 次之）。
- 启动前从快照安装代理；SIGTERM→exit 0 / SIGINT→130；5 秒有界 shutdown；fail-loud + 启动诊断日志。
- 模板 bundle 在 packages/util/official-bundles/src/bundles.ts（web = base + web-app）。

### 2.3 flag 落地方式：flag → service → 行配置

`packages/bundle/web-app/src/startup.ts` 的 `web-startup` 普通 plugin 注入 `cmdlineArgs`，解析 `--host/--port/--public-url/--trusted-host/--tls-*/--no-open` 并 provide `webStartup` service；各行以 `inject: [webStartup]` + `!!js ctx.webStartup.port ?? 3080` 读取。效果：**flag 天然优先于 patch 字面量，HMR 也不会重置已服务端口**。

### 2.4 与 desktop-host 的复用关系

`package.json` 导出 `./profile-boot`；apps/cli/README.md 明言 Desktop host 复用 `runProfile`（用 `resolvedProfile` 注入自己的 profile + installAnchor，经 `runCli({ packageManager, manageDesktopProfile })` 解锁 desktop profile 的插件管理；apps/cli/tests/desktop-host.e2e.ts 有验收）。**即：桌面壳与 CLI 共享同一套 boot 生命周期库。**

## 3. 启动编排链路（`dsh web` 命令行 → Web UI 可访问）

```
dsh web
 → parseDshArgs
 → runProfile(loadLayeredEnv('dsh'))          # 组合 patch 栈
 → boot() 挂 cordis 树                        # 提供 profileContext、launch snapshot、cmdlineArgs
 → web-startup 解析 flags
 → webserver 行监听                            # 默认 127.0.0.1:3080，拒绝 wildcard bind，可选 TLS，gzip
 → connection 行注册 RPC 网关到 /api           # launch token 换 signed cookie、Host/Origin fence、upgrade 经 admitConnection
 → web-runtime 行 require.resolve('@deepseek-ai/dsh-web-frontend/package.json') 定位 dist
 → frontend-static 占 fallback 座位            # SPA 资源 + index 认证 + 注入 __DSH_BOOT__
 → 全树 settle + 必需启动审计通过
 → appReady.commit()                          # readiness 门闩
 → 打印 tokenized URL 并开浏览器
```

安全默认：loopback 默认监听、拒绝 wildcard bind、明文 HTTP 警告、launch token + 签名 cookie。

## 4. 对 HiBuddy 的借鉴清单（机制级）

### apps/web 侧

| # | 机制 | HiBuddy 采纳点 |
|---|---|---|
| ① | 前端做成纯 dist 产物包，server 用 require.resolve 定位 | `@hibuddy/server` 直接依赖 `@hibuddy/web` 构建产物，单进程 serve——Web 端无需独立静态托管 |
| ② | "必须由 host 注入启动数据"编码进 vite 配置（拒绝裸 serve） | HiBuddy 前端同理拒绝裸 `vite dev/serve`，杜绝绕过 server 的使用方式 |
| ③ | index.html 由 server 动态渲染 + 结构化注入（boot manifest/主题/权限） | server 渲染 index.html，按部署形态注入启动数据；同一 bundle 适配 Web/桌面两种注入通道 |
| ④ | 桌面桥探测 + `__BOOT_READY__` 门闩时序 | 桌面端注入通道的就绪同步机制（配合 dsh-desktop-analysis 的 IPC 桥） |
| ⑤ | 广告 URL（public-url）与信任（trusted-host）分离；`base: './'` 支持反代前缀 | ADR-006 直接输入：Web 部署的反代语义与信任边界 |

### apps/cli 侧

| # | 机制 | HiBuddy 采纳点 |
|---|---|---|
| ⑥ | launcher/app 参数边界协议（launcher flags 之外原样透传，app 插件自解析） | `hibuddy` CLI 保留同样边界，server 子命令的扩展参数透传给内部模块 |
| ⑦ | flag→service→行配置注入，flag 优先且 HMR 安全 | CLI flags 不直改配置文件，经 service 层注入 |
| ⑧ | 分层 patch（bundle→profile→home→overlay）+ dump-config 可观测性 | HiBuddy 配置分层（内置默认→用户配置→CLI overlay）+ `--dump-config` 自省 |
| ⑨ | appReady 门闩 + tokenized URL 的 readiness 编排 | 桌面端/Web 端统一"全部就绪才可访问"的启动语义 |
| ⑩ | 单端口单进程路由注册表（exact/prefix/fallback 单座位） | server 路由设计：`/api` 网关 + 前端 dist fallback 座位 |
| ⑪ | 安全默认：loopback 默认、拒绝 wildcard、明文 HTTP 警告、token+签名 cookie | Web 端访问控制基线（SR 与 ADR-006 直接输入） |
| ⑫ | `runProfile` 作为库导出供桌面壳复用 | HiBuddy Electron 壳复用 server 同一 boot 生命周期（与 dsh-desktop-analysis §8 呼应） |

## 5. 关键源码索引（thirdparty/deepseek-harness）

| 主题 | 文件 |
|---|---|
| web 构建配置 | apps/web/vite.config.ts |
| 双环境注入入口 | apps/web/src/main.ts |
| CLI 参数解析 | apps/cli/src/bin.ts、apps/cli/src/args.ts |
| profile 启动 | apps/cli/src/profile-boot.ts |
| web bundle 模板与 flag 解析 | packages/bundle/web-app/cordis.patch.yml、packages/bundle/web-app/src/startup.ts、packages/bundle/web-app/src/index.ts |
| webserver / 前端静态服务 | packages/host/webserver/src/index.ts、packages/host/frontend-static/src/index.ts |
| bundle 模板清单 | packages/util/official-bundles/src/bundles.ts |
| 部署文档 | docs/subsystems/web-server.md、docs/user/guide/public-deployments.md |
| CLI 说明 | apps/cli/README.md、apps/cli/reference/README.md、apps/cli/tests/desktop-host.e2e.ts |

> 注：浅克隆缺少根 scripts/client-build-environment.ts（作用为注入客户端构建环境 define），其余机制均已在源内证实。

## 6. 相关文档

- [dsh-desktop-analysis.md](dsh-desktop-analysis.md)：桌面端壳+宿分离、dsh-app:// 协议、端口治理——本文 §1.2/§2.4 的桌面侧配套。
- [ADR-002-agent-runtime-selection.md](../decisions/ADR-002-agent-runtime-selection.md)：运行时选型（已 superseded，对比数据仍可参考）。
- [ADR-003-dsh-based-customization.md](../decisions/ADR-003-dsh-based-customization.md)：总体路线——HiBuddy 基于 dsh 深度定制，本文是其 Web/CLI 侧机制证据。
- [system-architecture.md](../architecture/system-architecture.md)：HiBuddy 技术方案（已吸收本文借鉴点）。
