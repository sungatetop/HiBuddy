---
title: ADR-003 基于 deepseek-harness 深度定制的总体路线
summary: 放弃"自建轻量 Agent Server + AgentRuntime SPI 适配器"路线，改为以 dsh（@deepseek-ai/dsh，MIT）为底座进行深度定制：HiBuddy = dsh 运行时 + 自研插件集（品牌/工具/UI/协议桥）+ dsh profile 装配 + 自建 Electron 壳；fork 仅作最后手段
keywords: [ADR, deepseek-harness, dsh, Cordis, 插件, bundle, profile, 深度定制, HiBuddy]
status: accepted
date: 2026-10-31
---

# ADR-003 基于 deepseek-harness 深度定制的总体路线

> 取代 [ADR-002](ADR-002-agent-runtime-selection.md) 的"运行时适配"定位；修订 [system-architecture.md](../architecture/system-architecture.md) 的总体架构与仓库结构。
> 决策依据：dsh 扩展机制源码/文档实证（thirdparty/deepseek-harness，2026-10-31），证据索引见 §4。

## 1. 背景与决策点

原方案（ADR-002）：自建 `@hibuddy/server`，在自造的 AgentRuntime SPI 后挂 dsh/pi 适配器，自建 AG-UI 端点与 React 前端。该方案保留了"协议统一、运行时可替换"的抽象，但代价是：会话/审批/子代理/交付物/工作区/Web UI 全部自研——而 dsh 对这些子系统均有成熟实现（MIT）。重复造轮子范围过大。

用户决策：**直接在 deepseek-harness 基础上深度定制化开发**。需要验证的是：dsh 的官方扩展面能否承载"深度定制"而不必 fork。

## 2. dsh 扩展能力实证（调研结论）

| 定制需求 | dsh 官方路径 | 证据 |
|---|---|---|
| 安装形态 | 官方发布 npm scoped 包 `@deepseek-ai/*`（CLI `@deepseek-ai/dsh` v0.2.2-alpha.2，`engines.node>=24.9`）；第三方插件 = bundle npm 包（manifest 声明 `dsh.bundle.patch` + JS 入口）→ `dsh plugin --profile <name> add <pkg>` 装进 profile node_modules 并自动登记 bundles | apps/cli/package.json、docs/user/develop/basic/publish.md、packages/boot/plugin-manager |
| 工具/审批/子代理 | `ctx.tools.register` 注册工具；审批 `approval/request` waterfall answerer 挂接点（fail-closed、审计入 session log）；子代理后端 registry 多实现（dsh-sdk/codex/claude-code/acp） | docs/user/develop/basic/tool.md、packages/interaction/user-approval/README.md、docs/capability-seams.md |
| 模型 Provider | **非 DeepSeek 专用**：内置目录含 anthropic/openai/moonshotai/zai 等；"Custom model API" 支持任意 base URL + OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 三协议，profile patch 热生效；自写适配器有指南（pi-ai 即其 LLM 层之一：packages/llm/llm-pi-ai） | docs/user/guide/providers.md、docs/cookbook/adding-an-llm-adapter.md |
| 组件替换 | cordis.patch.yml 裸行按 `id` 覆盖既有行（改 `name`/`inject`/`config`，config 整体替换）、`disabled: true` 关行、`!!js` 动态求值；层序后者胜；**无删除行**（官方刻意用 disabled 替代） | docs/user/develop/basic/publish.md、packages/bundle/web-app/cordis.patch.yml |
| Web UI 定制 | client-modules：插件 package.json 声明 `dsh.client:{platform:'web'}` + `./client` export → host 扫描生成 `window.__DSH_BOOT__` 启动图 → `/plugins/<pkg>/client.js` 服务浏览器 bundle（懒加载+HMR+启停同步）；Slots（single/list/keyed/chain）第三方 `ctx.slots.inject()` 注入组件；**品牌本身是可替换包**（`sidebar.brand.mark/name`、hero slot，"deployments with another identity should provide a replacement brand package"） | packages/client/modules/README.md、packages/client/ui-brand-official/README.md、docs/cookbook/adding-a-settings-card.md、apps/web/tests/fixtures/plugins/* |
| 数据与配置 | 会话 per-session JSONL（默认 Zstd 压缩）+ SQLite 检索索引；`$DSH_HOME/profiles/<name>/`（依赖+bundles+patch）→ home 级 patch → CLI `--patch` 分层；凭证 `$DSH_HOME/.credentials.yaml` | packages/session/session-persistence-jsonl/README.md、packages/util/home-paths/README.md |
| 许可 | 全部 `@deepseek-ai/*` 包与 apps 为 **MIT**（native/system 包 BSD-3-Clause） | 各 package.json license 字段 |
| 进程外集成 | `packages/sdk/*` 提供 stdio JSON-RPC 的 out-of-process SDK，可做进程隔离与第三方宿主接入 | packages/sdk/* |

## 3. 决策

采用 **"dsh 底座 + HiBuddy 插件集 + profile 装配 + 自建 Electron 壳"** 路线：

1. **dsh 以 npm 依赖引入**（`@deepseek-ai/*`），不做 fork、不基于 sparse 源码构建；`thirdparty/deepseek-harness` 降级为只读的 API/实现对照参考。
2. **HiBuddy 自研物收敛为四类**：
   - **profile 装配**：`hibuddy` profile（依赖清单 + cordis.patch.yml），定义产品 = dsh 基础 bundle + web-app + HiBuddy 插件；
   - **插件集**（`@hibuddy/*`，均为 dsh bundle 形态）：品牌包（brand slots）、个人工作伙伴核心（工具集/人设/工作台）、Web UI 定制（client 模块 + Slots 注入）、（可选）AG-UI 协议桥；
   - **Electron 桌面端**：自建壳 + 宿进程（复刻 dsh apps/desktop + desktop-host 的"壳+宿分离、RunAsNode、runProfile"模式，profile 名用 `hibuddy`）；
   - **移动端**（远期）：Flutter，经 dsh SDK/协议连接同一运行时。
3. **定制优先级纪律**：能用插件/Slots/patch 官方路径解决的，不改 dsh 源码；patch 尽量只做 `insert` 与自己的插件的 config，覆盖官方行（同 id 改 name）须记录升级影响；**fork 仅当定制点落在 Cordis/Loader 内核、client-modules 引导 shell、Electron 品牌链路等私有装配层时才评估**（目前无此需求）。
4. **协议**：P0 前端直接复用 dsh client 体系与原生事件流（SessionEvent/RPC/SSE），**不建 AG-UI 统一端点**；AG-UI 兼容桥降级为 P1 可选插件（保持接入 AG-UI 生态的口子）。

### 3.1 对既有决策的影响

| 既有决策 | 处置 |
|---|---|
| ADR-001（AG-UI 作为统一协议，未落） | **不再落地**：dsh 原生协议即统一协议；AG-UI 桥为可选插件（P1 再评估） |
| ADR-002（P0 dsh 适配、P1 pi） | **superseded**：dsh 从"被适配的运行时"升级为"底座"；pi 不再是 P1 运行时——其 pi-ai 已是 dsh 的 LLM 适配层之一（llm-pi-ai），选型对比与事件映射内容仍有参考价值 |
| AgentRuntime SPI（技术方案 §5） | **取消**：dsh 的 Cordis 插件面即扩展点，不再自造抽象 |
| `@hibuddy/server`（自建轻量服务端） | **取消**：服务端 = dsh runtime + HiBuddy 插件；`dsh-desktop-analysis.md` 中"HiBuddy 自建轻量服务端、不复用 runProfile"的差异点说明作废 |

## 4. 定制边界清单

| 类别 | 内容 |
|---|---|
| 官方路径直接支持 | 工具、审批 answerer、子代理后端、多 Provider（内置目录+自定义 base URL）、品牌包、client 模块 UI、Slots 注入、profile 分层配置、插件安装/启停（含 Web UI 图形化） |
| 需变通 | patch 无删除行（用 `disabled`）；覆盖官方行的 config 为整段替换（升级时需对照复述）；前端"完全替换"需自建 surface bundle（仿 web-app 装配，自担整层）——P0 不做 |
| 触发 fork 才能做 | 改 Cordis/Loader 内核、client-modules 引导 shell、Electron 主进程品牌/自动更新链路（自建壳可规避后者） |
| 已知缺口 | dsh 无移动端（自建）；desktop-host 硬编码 profile 名 `'dsh'`（自建宿用 `hibuddy`）；dsh 尚为 alpha（v0.2.2-alpha.2），API 可能变动 |

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| dsh alpha 期 API/协议变动 | `engines.dsh` SemVer 兼容闸对齐；版本锁定 + 升级冒烟测试；升级前 diff 官方 changelog |
| 覆盖官方行在升级时易碎 | 纪律：优先 insert 自己的行与插件 config；必须覆盖时在 patch 注释记录被覆盖行的官方现值与 dsh 版本 |
| 前端体验受 dsh client 演进牵引 | 品牌与增量 UI 走官方 Slots/client-modules（升级安全）；深度改造评估自建 surface bundle 的成本后再决策 |
| 上游单点依赖（DeepSeek 官方仓库） | MIT 允许必要时 fork 兜底；thirdparty 快照保留对照能力 |

## 6. 新仓库结构（详见 system-architecture §10）

```
HiBuddy/
  profile/hibuddy/        # dsh profile：产品装配（依赖 + cordis.patch.yml）
  packages/               # HiBuddy 插件与包（@hibuddy/*，均为 dsh bundle/库形态）
  desktop/                # Electron 壳 + 宿进程（自建，复刻 dsh desktop 模式）
  mobile/                 # Flutter（远期）
  thirdparty/ docs/ scripts/ tests/
```
