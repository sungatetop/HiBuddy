---
title: OpenMuse 调研——AG-UI 用法与可借鉴机制
summary: 对 thirdparty/OpenMuse（OpenBot 系个人智能体，RN+Web 双端）的机制调研——确认其使用 AG-UI 协议 + CopilotKit runtime（AbstractAgent/HttpAgent 双后端可切换、SSE 传输、业务数据走 REST 快照轮询而非 AG-UI）；JEV 生成式 UI 为严格 JSON 选择面板契约（非自由 HTML）；durable worker 租约模型、monitor 退避、审批 hash+30min 过期、工具卡只存 ID 等六条可借鉴机制与 HiBuddy 现状的对照；结论为 OpenMuse 无主动推送，HiBuddy 管家出站链路更完整
keywords: [OpenMuse, OpenBot, AG-UI, CopilotKit, AbstractAgent, HttpAgent, JEV, 生成式 UI, 线程恢复, 工具卡, 租约, 审批, 调研, references]
status: accepted
date: 2026-11-12
---

# OpenMuse 调研——AG-UI 用法与可借鉴机制

> 调研对象：`thirdparty/OpenMuse`（只读参考区，OpenBot 系个人智能体，React Native + Web 双端 + Node server）。
> 调研方式：全仓 grep（ag-ui / agui / copilotkit / HttpAgent，60 处命中）+ 逐文件核对（结论附源码路径）。
> 关联：[ag-ui-research](ag-ui-research.md)（AG-UI 协议与生态调研）、[ADR-007](../decisions/ADR-007-generative-ui-format.md)（生成式 UI 产出格式）、[ADR-011](../decisions/ADR-011-butler-conversation-layer.md)（管家形态与 AG-UI 管家层）、[butler-detail-design §11.3](../module-design/butler-detail-design.md)。

## 1. OpenMuse 的 AG-UI 用法

**结论：OpenMuse 确实在用 AG-UI 协议 + CopilotKit，且与 HiBuddy"AG-UI 作生态接入面"的定位同构。**

| 环节 | 做法 | 源码 |
|---|---|---|
| 协议栈 | `@ag-ui/client` / `@ag-ui/core` 0.0.59 + `@copilotkit/runtime` 1.70.1 | 根 `package.json` |
| 后端 agent | 自实现 `AbstractAgent`（本地对话引擎）；`AGENT_BACKEND=agui` 时切换 `HttpAgent`（任意 AG-UI 兼容后端）——**自研引擎与生态后端可互换** | `apps/server/src/agent.ts:37-57`（`engine/conversation.ts:29`） |
| 传输 | CopilotKit runtime 挂 `runtimeUrl=/api/copilotkit`，SSE 事件流；前端经 CopilotKit headless 客户端发 `RunAgentInput`，**不直连 SSE** | `apps/server/src/app.ts:341-357`、`apps/mobile/App.tsx:93` |
| 双端消费 | `@copilotkit/react-native` 与 Web 共用 headless hook，`.native/.web` 平台后缀文件只换渲染层 | `apps/mobile/src/*.native.tsx` |

**关键分工：业务数据不走 AG-UI。** 线程快照、对话历史、任务状态走 REST（`/api/main-thread`、`/api/conversation`、`/api/agent` 快照 + 3 秒轮询，`agent-workspace.tsx:44-73`）；主线程 ID 服务端持久化并 `getOrCreateThread` 预置（`app.ts:217-238`），前端 `connectAgent` 重放历史、重放期 `RUN_ERROR` 降噪（`conversation-run.ts:29-38`），队列一次一个 run、可暂停、失败回队（`conversation-queue.ts`、`chat.tsx` threadLocked 分支）。

这与 HiBuddy 的分工一致：**对话页自绘消息账本（确定性事实），AG-UI 只承载对话事件流**（但ler-detail-design §11.3）。OpenMuse 的差异点是它把 CopilotKit 用在了自家产品前端（HiBuddy 自家前端走 `/resident/api/*` 轮询，AG-UI 纯面向外部生态）。

## 2. 可借鉴机制（按对 HiBuddy 的价值排序）

| # | 机制 | OpenMuse 实现 | 对 HiBuddy 的启示 |
|---|---|---|---|
| 1 | **事件与业务分离** | 对话用 AG-UI 事件流，业务对象用独立 zod 域模型（`packages/domain/src/agent.ts:26-57` durable 任务状态机） | 印证 HiBuddy 消息账本（`MessageData` 联合类型）的分层；业务状态不进对话事件流 |
| 2 | **线程恢复三件套** | 主线程 ID 服务端固化 + `connectAgent` 重放 + 重放期 `RUN_ERROR` 降噪 | 管家重启恢复后的对话回放（账本重放已实现）与 AG-UI 前端重连的衔接可参考其降噪口径 |
| 3 | **生成式 UI 严格契约（JEV）** | 选择面板 JSON：strict、1–12 选项、comparison 必须带来源且 ≤3 项、来源必须出自本轮实际读取的邮件/网页原文（`packages/domain/src/jev.ts:23-35`、`apps/server/src/jev/tools.ts:52-80`）；`present_choices` 工具产出 tool result（`jev/tools.ts:29-92`）；**CAS revision 保证仅最新面板可点**（`jev/service.ts:104-139,291-336`）；选择回传为一条用户消息 `[OpenMuse choice]{json}`，server 拦截改写成 continuation 递归跑（`engine/conversation.ts:53-81`）；前端按 transcript 判定可用性（`jev-actions.ts:38-79`） | 与 ADR-007「组件指令」路线互相印证（工具产出 + 严格 schema + 可重放，天然跨端）；**revision 防过期点击**与"引用溯源到本轮读取"两个细节值得并入 render_ui 交互回传设计 |
| 4 | **工具卡只存 ID** | 消息只存工具结果 ID，卡片按 ID 二次拉取（`apps/mobile/src/thread-artifacts.tsx:62-90`、`browser-tool-card.tsx:58-81`）；工具卡按 tool name 注册 `useRenderTool`（`chat.tsx:61-146`） | 比 HiBuddy 附件表更轻；`send_message_to_user` 若未来承载结构化结果卡（非文件），可沿用"账本存引用、详情按需拉取" |
| 5 | **durable worker 租约模型** | 租约 + 心跳 + 3 并发 + 抢占恢复（`apps/server/src/engine/worker.ts:23-256`）；monitor 定时抓页 + 指数退避（`engine/service.ts:829-860`）；通知收件箱幂等键 `notify/publishOutcome`（`service.ts:726-736,908-965`） | HiBuddy slots + SQLite 已覆盖单机场景；monitor 退避与通知幂等键两处实现口径与 resident 高度一致（互为验证）；**租约/心跳仅在多进程部署时需要** |
| 6 | **审批与执行解耦** | `ActionProposal` 带 hash 绑定、30 分钟过期、账号绑定、状态 CAS、不确定结果不重试（`apps/server/src/actions.ts:39-101,102-207`） | 与 ApprovalBroker fail-closed 30min 同构（互为验证）；**CAS 思路可用于防重复 resolve**（HiBuddy 当前以内存 Map settle 判重，重启后依赖对账） |
| 7 | **双端同源消费** | 一套 headless hook + `.native/.web` 平台后缀文件，Web 只换渲染层 | HiBuddy 移动端阶段（ADR-010 §6.4）若走 RN 可参考；对桌面三端同源无增益 |

## 3. 对照结论

- OpenMuse **没有真正的主动推送**：APNs 未做（`docs/FEATURES.md:17`），通知只进收件箱。HiBuddy 管家的 `send_message_to_user` + 消息账本 + 桌面系统通知（P1）链路更完整。
- OpenMuse 的 AG-UI 面向自家产品前端 + 生态双消费；HiBuddy 当前 AG-UI 仅生态消费——若未来 HiBuddy 前端切换为 CopilotKit 消费（P1 生态阶段），OpenMuse 的"REST 快照 + AG-UI 事件流"双通道分工是现成蓝本。
- JEV 与 ADR-007 同路线不同深度：JEV 的 revision、来源溯源、transcript 判定可用性三点是 ADR-007 尚未覆盖的细节，演进 `render_ui` 交互回传时值得吸收。

## 4. 证据索引

1. 全仓 grep：ag-ui / agui / copilotkit / HttpAgent（60 处命中，根 `package.json`、`apps/mobile/package.json`、`apps/server/src/agent.ts` 等）。
2. 逐文件核对清单：`apps/server/src/{app,agent,actions,engine/*}.ts`、`packages/domain/src/{agent,jev}.ts`、`apps/server/src/jev/*`、`apps/mobile/src/{App,chat,conversation-queue,conversation-run,agent-workspace,thread-artifacts,jev-actions,jev-tool-card}.tsx`、`docs/{FEATURES,OPENBOT-INTEGRATION,RICH-THREADS}.md`、`docs/demos/jev-generative-ui.md`。
