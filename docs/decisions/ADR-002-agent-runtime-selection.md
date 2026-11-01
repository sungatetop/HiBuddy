---
title: ADR-002 Agent 运行时选型：P0 deepseek-harness，P1 pi
summary: 对比 deepseek-harness（dsh）与 pi（原 badlogic/pi-mono，现 earendil-works/pi）两个候选运行时后，确认 P0 集成 dsh、P1 接入 pi 的排期，并给出 AgentRuntime SPI 的事件/工具/审批映射依据（已被 ADR-003 取代：dsh 升级为底座而非被适配对象，SPI 取消）
keywords: [ADR, AgentRuntime, deepseek-harness, dsh, pi-agent, pi-mono, 选型, 事件映射]
status: superseded
date: 2026-10-31
---

# ADR-002 Agent 运行时选型：P0 deepseek-harness，P1 pi

> **[superseded]** 本 ADR 的"运行时适配"定位已被 [ADR-003-dsh-based-customization.md](ADR-003-dsh-based-customization.md) 取代：HiBuddy 改为基于 dsh 深度定制（dsh 为底座，不做 SPI 适配），pi 不再作为 P1 运行时（其 pi-ai 已是 dsh 的 LLM 适配层之一）。本文的选型对比、事件映射与 thirdparty 引入方式仍有参考价值，正文保留不再更新。

> 承接 [system-architecture.md](../architecture/system-architecture.md) §5.2 的适配器排期与 §14 编码前 ADR 清单。
> 调研依据：两仓源码/官方文档（thirdparty/ 只读参考）+ dsh 官方文档站 + [ag-ui-research.md](../references/ag-ui-research.md)。

## 1. 背景

HiBuddy 的 Agent 能力由统一 AgentRuntime SPI 之后的可插拔运行时提供（技术方案 §5）。候选运行时两个：

- **deepseek-harness（dsh）**：DeepSeek 官方 Agent harness，npm 包 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app`，源码 `github.com/deepseek-ai/deepseek-harness`（monorepo，MIT，约 337MB，60+ 包）。
- **pi**：Mario Zechner 的极简 agent 工具链，2026-04 由 Earendil 收购后仓库迁至 `github.com/earendil-works/pi`（原 `badlogic/pi-mono`），npm scope 迁至 `@earendil-works/*`，MIT，约 93MB。

两仓均已引入 `thirdparty/` 作为只读参考（因网络状况以 sparse 浅克隆/快照引入，见 §6）。

## 2. 对比结论总表

| 维度 | deepseek-harness (dsh) | pi (earendil-works/pi) |
|---|---|---|
| 定位 | 全功能个人 Agent harness（会话、工具、审批、子代理、web UI、技能） | 极简编码 agent 内核 + 可组合工具链（"零件化"，README 即文档） |
| 内核架构 | Cordis 插件容器：Fiber 生命周期（PENDING→LOADING→ACTIVE→UNLOADING→DISPOSED）、依赖注入（`inject`）、自动清理、HMR 热替换 | 极简 agent loop：`@earendil-works/pi-agent-core`（v1.4.0，transport 抽象 + 状态管理 + 附件），扩展以 TypeScript extension / skills 机制自建 |
| 会话数据模型 | **仅追加 SessionEvent 日志（唯一真源）**：13 种核心事件变体（turn/start、turn/end、step/start、step/end、user/message、system/message、assistant/message、assistant/attempt、tool/call、tool/result、request/header、request/context、session/end-seed），单调 seq，JSONL 持久化 + flush 检查点 + 崩溃恢复 | 会话为 JSONL 树结构；事件粒度围绕 agent loop（消息/工具调用），持久化与恢复语义较简 |
| 流式协议 | `AssistantStreamFrame`（start/chunk/end，含 attemptId、revision、turn、step、index、StreamChunk） | StreamChunk 风格流式；SDK/RPC 双形态（SDK 直接 import；RPC 走 stdio JSONL） |
| 中途交互 | `followup()`（排队下一轮）、`steer()`（步骤边界中途引导）、`inject()`（注入上下文不唤醒）、`cancel(cause)`（user/parent/hook/disposed）、inbox 持久投影 | run/中断可编程；无内置排队/引导语义，需扩展自建 |
| 审批与治理 | **approval seam**（ApprovalRequest/Outcome、逐会话策略、审计事件）、permission-presets、user-questions seam、sandbox（文件效果模式/执行策略/ConfinedArgv）、settings 分层 | **刻意无权限门**（作者立场：容器内运行）；审批/确认需扩展自建 |
| 子代理 | AgentFactory + `ctx.agents` 注册表、parentAgent/委派深度、subagent seam、agent-team（Lead/teammate/共享任务 DAG） | 无内置（作者立场：tmux 起多实例或扩展自建） |
| 工具系统 | `defineTool` DSL：parameters schema + execute + **output.render（工具展示 UI 类型）**；注册表经 `ctx.tools.register`，受保护执行流水线 | TypeBox JSON Schema + AJV 运行时校验，默认 4 工具（read/write/edit/bash）；工具注册为扩展 API |
| LLM Provider | `ctx.llm.registerAdapter(names, adapter)` 适配器注册 + credentials seam（CredentialRef 引用，绝不含值） | `pi-ai` 统一多 Provider API（20+ providers），BYOK 友好，API 稳定 |
| Web UI | **React 客户端全家桶**：Client model（React 无关状态镜像）→ UI adapter → Slots（类型化组合）→ Conversation（事件→视图）；Typert Remote 生成类型化 API；Workspace model（baseline+increment、归档/置顶）；重连按 seq 闭区间校验 + opening snapshot 原子替换 + page() 修 gap | 无内置 web UI（早期资料中的 pi-web-ui 已不在当前包列表；TUI 为主） |
| 工作区概念 | **Workspace 子系统**：Workspace/WorkspaceId 注册表，与会话 cwd 绑定，Web UI 先选工作区再开会话 | 会话即 cwd；无独立 workspace 抽象 |
| 交付物/状态 | deliverables（PresentedFile + WorkspaceChangesSummary）、todo/plan/goal 子系统（STATE_* 事件映射源） | 无内置（计划写文件、无 todos，作者立场） |
| 生态与文档 | 官方文档站完整（子系统逐页类型声明 + verify-type-equiv 防漂移）；本团队已具备 dsh-plugin-dev 技能 | GitHub 110k+ stars 社区活跃；文档=README+类型；fork 生态（oh-my-pi 等） |
| 成熟度风险 | 版本早期（dsh-base 0.0.1-rc、dsh-web-app 0.2.2-alpha），演化快 | v0.99.x 快速迭代；被商业公司收购后核心承诺 MIT 不变（RFC 0015） |

## 3. 决策

1. **P0 集成 dsh**，理由（按权重）：
   - PRD 核心对象与 dsh 子系统**一一对应**：审批（approval seam ↔ FR 审批流/Run waiting_approval）、留痕（SessionEvent 日志 ↔ 时间线回看）、恢复（seq 闭区间 + snapshot 基线 ↔ FR-09 重开恢复）、交付物（deliverables ↔ Artifact）、子代理（subagent/agent-team ↔ P1 预留）、工具 UI 渲染（output.render ↔ 生成式 UI 链路）。
   - dsh Web Client 分层（Host 权威状态 → 传输/Client model → UI adapter → Conversation → Slots → React）与 HiBuddy `frontend/shared`（AgUiClient + 事件归约器）+ `server/gateway` 架构**同构**，其重连语义直接作为 AG-UI `Last-Event-ID` 回放设计的参考实现。
   - Workspace 子系统与会话绑定模型直接采纳为 HiBuddy 会话组织方式（PRD Thread ↔ dsh Workspace/Session 关系）。
   - 团队已有 dsh-plugin-dev 技能与 cordis 使用经验，适配层学习成本最低。
2. **P1 接入 pi**，作为 SPI 最小性的检验器：其极简内核（run/事件/工具三件套）若能低成本适配，即证明 SPI 未过度设计。同时 `pi-ai` 的统一多 Provider API 作为 HiBuddy Provider 层（BYOK）的接口设计参考。
3. **工具/审批不交给运行时**：维持技术方案 §6 的平台侧工具注册与风险分级设计；dsh 的 approval seam 仅作为映射目标（适配器把平台审批请求翻译为其 ApprovalRequest 词汇），pi 的无权限门立场与 HiBuddy 审批需求相悖，进一步支持"审批在平台层"的决策。

## 4. AG-UI 事件映射依据（SPI 冻结前 spike 清单）

pi 侧已用源码验证（`packages/agent/src/types.ts`）：`AgentEvent` 共 11 种——agent_start / agent_end、turn_start / turn_end、message_start / message_update / message_end（message_update 内嵌 pi-ai 的 AssistantMessageEvent 流式增量）、tool_execution_start / update / end；另提供 `beforeToolCall`（可 block+reason）/ `afterToolCall` 钩子与 QueueMode（排队消息注入点）。

| AG-UI 事件 | dsh 来源 | pi 来源 |
|---|---|---|
| RUN_STARTED / RUN_FINISHED / RUN_ERROR | turn/start、turn/end（TurnEndReason）、agent/request-error | agent_start / agent_end（stopReason error/aborted 编码于消息） |
| TEXT_MESSAGE_* | assistant/message、assistant/attempt（AssistantStreamFrame chunk） | message_start / message_update / message_end |
| TOOL_CALL_START/ARGS/END/RESULT | tool/call、tool/result | tool_execution_start / update / end |
| STEP_STARTED / STEP_FINISHED | step/start、step/end（原生粒度，无需合成） | turn_start / turn_end（一轮=一次助手响应+工具批） |
| STATE_SNAPSHOT / DELTA | todo/plan/goal 子系统事件 | 无，适配层合成 |
| 审批挂起（interrupt/resume） | approval seam（ApprovalRequest/Outcome） | beforeToolCall 返回 { block, reason } 挂起（平台审批注入点） |
| SUBAGENT_* | subagent seam、agent/created、AgentFactory | 无（P0 不下发） |
| 回放 | SessionEvent seq + JSONL 持久化（天然支撑 Last-Event-ID） | 会话 JSONL（seq 语义需 spike 验证） |

> 该表为编码前 spike（技术方案 §4.2）的输入，冻结 SPI 前须以两仓源码逐项验证并产出《运行时事件映射表》（docs/solutions/）。

## 5. 引入 pnpm workspace 的相关决策

- 仓库采用 **pnpm workspace monorepo**（技术方案 §10）：根 `pnpm-workspace.yaml` 声明 `server/`、`frontend/{desktop,web,shared}`、`tests/` 为 workspace 包，包名 `@hibuddy/*`；依赖方向 `desktop/web → shared → 协议类型`，禁止反向。
- 拆包边界参考 dsh Web Client 的包纪律（web-client.md"包边界"节）：功能包间仅 `import type` 共享、跨包行为走注入服务、跨包 UI 走 Slot 组合、presentation 组件不感知传输对象——HiBuddy 对应约束为：共享层不含 Electron/Node API，UI 组件不感知 AgUiClient 传输实现。
- dsh Web Client 的 Client model（React 无关、observable snapshot、竞态处理）对应 HiBuddy `@hibuddy/shared` 的协议归约器；dsh Slots 对应 HiBuddy 生成式 UI 沙盒与画布的组合方式（ADR-004 再细化）。

## 6. thirdparty 引入方式说明

| 仓库 | 引入 | 说明 |
|---|---|---|
| `thirdparty/deepseek-harness` | sparse 浅克隆（blob:none，sparse=packages/apps/docs，约 130MB） | 全仓 337MB，快照/文档站资源不参考；dsh 官方文档在线可读；结构已验证（packages/core 会话事件、packages/client React 包族含 ui-approval、packages/bundle/web-app） |
| `thirdparty/pi-mono` | sparse 浅克隆（blob:none，sparse=packages，约 63MB） | 仓库本体 93MB；目录名保留历史名 pi-mono，注明现址 earendil-works/pi；包清单已验证（agent/ai/coding-agent/tui/mcp/codemode/durable 等 11 包，`@earendil-works/pi-agent-core` v1.4.0） |

> 因当日网络代理（gh-proxy 系）TLS 持续抖动、github 直连大传输被限速，sparse+blob:none 方案以最小传输量引入参考源码。更新时执行 `git pull --depth 1`（规则 §1 纪律不变）。两仓检出状态已验证（2026-10-31）；pi 的事件模型已到源码级确认（§4）。

## 7. 影响

- `system-architecture.md` §5.2 由排期表升级为决策引用本文档；§15 参考映射补充 dsh web client / workspace / approval 子系统条目。
- 编码前 spike 顺序：运行时事件映射表 → SPI 冻结（ADR-001、ADR-003 仍待立）。
- 风险跟踪：dsh 处于 alpha/rc，适配器须锁定上游版本并在 ProgressReport 中记录版本漂移。
