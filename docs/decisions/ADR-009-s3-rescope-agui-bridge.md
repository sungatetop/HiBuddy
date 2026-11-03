---
title: ADR-009 S3 范围缩减（复用 dsh 工具与审批主干）与 AG-UI 协议桥立项
summary: S3 原计划自研内置工具与审批分级，实证 dsh 已自带完整工具面与审批机制后缩减为"审批 answerer 增量"（分级/免再询/审批卡增强/留痕验证）；AG-UI 桥从 P1 可选提前为 S3b 专项，采用方案 A（dsh 插件内 ctx.webServer 注册 AG-UI HTTP/SSE 端点），MVP 验收 = AG-UI 生态前端（CopilotKit）接入
keywords: [ADR, S3, 审批, answerer, 免再询, AG-UI, ag-ui-bridge, CopilotKit, dsh, webServer]
status: accepted
date: 2026-11-03
---

# ADR-009 S3 范围缩减（复用 dsh 工具与审批主干）与 AG-UI 协议桥立项

> 决策依据：dsh v0.2.1-rc.5 安装产物 + thirdparty/deepseek-harness 源码对照实证（2026-11-03，证据索引见 §5）；用户指令「dsh 本身已有完整的工具系统和权限审批机制，评估 S3 的工作，重点在于推进 AG-UI 的工作」。
> 关联：[ADR-003](ADR-003-dsh-based-customization.md) §3.4（AG-UI 桥原定 P1 可选，本 ADR 提前为 P0 内 S3b 专项，形态不变）；[implementation-plan](../implementation-plan.md) S3/S3b。

## 1. 背景与决策点

S3 原计划（implementation-plan）：`@hibuddy/coworker` 自研内置工具（L0 文件读取/网页读取、L1 文件写入/整理）+ 自研审批 answerer（L0 放行/L1 挂起/L2 禁用）+ 免再询记忆 + 留痕。

实证 dsh v0.2.1-rc.5：

1. **工具面已完整**：preset-standard（dsh-web-app）挂载 tool-fs（读/写/整理）、tool-fs-search、tool-web（网页读取）、bash/pwsh、tool-jobs、tool-todo、tool-goal、tool-skill、tool-ask-user、plan-mode、delegation（子代理×2）、tool-present 等 14+ 官方工具。S3 原计划的全部自研工具均已存在，自研即重复造轮子。
2. **审批机制已完整**：两层旋钮（沙箱模式 read-only/workspace-write/danger-full-access × 审批策略 ask/never）；执行期升级审批（工作区内自动放行、越界 fail-closed 挂起、拒绝向模型回传明确指引）；`approval/request` 为 cordis waterfall 事件，第三方插件 `ctx.on('approval/request', (req, next) => Promise<ApprovalOutcome>)` 可完全接管（fail-closed：无 answerer/抛错/非法值一律 unavailable）。
3. **留痕已完整**：SessionEvent 含 `approval/asked`/`approval/decided`（log-only 审计）、`tool/call`/`tool/result`、`sandbox/mode`、`approval/policy`，全量持久化于 session JSONL——FR-08 时间线数据基础原生即有。

**与 PRD 的真实缺口**（仅三项）：
| PRD 要求 | dsh 现状 | 缺口 |
|---|---|---|
| L1 写入默认需确认 + 会话内免再询（SR-01） | workspace-write 下工作区内写自动放行；用户选项仅 allowed-once/rejected/cancelled，无 approve-always（官方 README 明列 deferred） | answerer 判级 + 会话级授权记忆 |
| 审批卡展示工具名/参数全文/影响范围 + 批准/拒绝/免再询（FR-03 规则 1） | 默认审批卡不含参数全文，无免再询选项 | web-ui 审批卡增强 |
| L2 代码执行默认关闭（FR-03） | bash/pwsh 默认挂载 | profile patch 禁用 + answerer 兜底 |

## 2. 决策一：S3 缩减为「审批分级与留痕增强」

1. **不自研工具**：删除原任务 1/2（内置工具 L0/L1），直接复用 preset-standard 原生工具面；HiBuddy 不新增工具插件。
2. **coworker 审批 answerer**（原任务 3/4 收敛）：`ctx.on('approval/request')` 实现——L0（读/网页）放行、L1（工作区写）挂起待批 + 「本会话×工具×等级」免再询记忆（返回 allowed-once）、L2（bash/pwsh，默认关闭）拒绝并提示；拒绝连续 3 次计数后建议模型停下询问（FR-03 规则 2）。
3. **审批卡增强**（web-ui client 侧）：参数全文、影响范围说明、批准/拒绝/免再询三选项。
4. **留痕验证**：原生 SessionEvent 即 FR-08 数据基础，仅做行为验证与登记，不自建存储。
5. ADR-008（L1 代码执行沙盒）保持条件性：代码执行默认关闭不变，不阻塞。

## 3. 决策二：AG-UI 桥立项为 S3b 专项（方案 A）

### 3.1 形态选型

| 方案 | 描述 | 结论 |
|---|---|---|
| **A（采纳）** | dsh 插件内经 `ctx.webServer.register()` 注册 `POST /agui` 端点（AG-UI HTTP+SSE transport），进程内订阅 `session/event` 馈送并映射为 AG-UI 事件流 | 官方明文扩展面（"web-transport plugins register their own routes"）；同进程可挂 `approval/request` waterfall 补审批闭环；官方 dsh-acp 适配器为同形态先例 |
| B（否决） | 独立桥进程经 dsh-sdk（stdio JSON-RPC）外挂 | SDK 的 7 个 RPC 方法**无审批应答**，`session.event` 通知无密集 token 帧——丢失流式文本与 human-in-the-loop 闭环，仅适合只读监控 |
| C（否决） | dsh 内置 AG-UI 支持 | 全仓 grep `ag-ui|agui` 零命中，不存在 |

### 3.2 MVP 范围与验收形态

- **MVP 验收 = AG-UI 生态前端接入验证**：CopilotKit（或 OpenBot 等任意 AG-UI client）连 HiBuddy runtime 的 `/agui` 端点，跑通「文本对话 + 工具调用事件 + 审批中断恢复」最小闭环。
- 事件映射（SessionEvent → AG-UI）：`turn/start|end`→RUN_STARTED/FINISHED；`assistant/message`（含 compact provider stream）→TEXT_MESSAGE_*；`tool/call`/`tool/result`→TOOL_CALL_*；`todo/write`→STATE_SNAPSHOT/DELTA；`approval/asked|decided` 等无对应源的事件经 CUSTOM 事件承载；审批挂起合成 `RUN_FINISHED.outcome.interrupt`。
- 明确的 MVP 边界（首版接受退化）：逐 token 密集帧为 process-local（AssistantStreamFrame 无公开订阅 API），首版可按消息粒度补发（TEXT_MESSAGE 整段）；桥侧自建 SSE 扇出，无断线 resumption。

### 3.3 风险登记

| 风险 | 缓解 |
|---|---|
| dsh alpha 期 gateway/webServer 契约变动 | 桥仅依赖 `ctx.webServer.register`、`session/event` 馈送、`approval/request` 三个稳定 seam；engines.dsh 闸 + S3b 验收含升级冒烟 |
| 鉴权与 CORS | P0 复用 ADR-006 信任链口径：桥端点仅 loopback、复用启动 token 换签名 cookie 或独立 token；CopilotKit 跨源场景先以同源代理验证 |
| 审批 interrupt 语义差异 | AG-UI 的 resume 不映射 dsh 原生恢复；恢复=新一轮 `session/prompt` 携带审批决定，桥内合成 |
| 桥与 dsh 原生 Web client 并存 | 桥为新增路由不触碰原生 mux/journal 通道；原生 Web UI 行为零影响（验收项） |

## 4. 对既有决策的影响

| 既有决策 | 处置 |
|---|---|
| ADR-003 §3.4「AG-UI 桥降级为 P1 可选插件」 | **修订**：桥提前至 P0 内 S3b 专项执行；插件形态（@hibuddy/ag-ui-bridge）与「不建统一端点、原生协议为主通道」的定位不变 |
| implementation-plan S3 | **修订**：按 §2 缩减，新增 S3b（AG-UI 桥 MVP）；S4/S5 编号不变、执行顺序顺延 |
| ADR-008 | 维持条件性：代码执行默认关闭，不落地 |

## 5. 证据索引

1. `node_modules/.pnpm/@deepseek-ai+dsh-web-app@0.*/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml` L10-127 — preset-standard 工具清单
2. `thirdparty/deepseek-harness/packages/interaction/user-approval/src/types.ts` L32/L63-91 — ApprovalOutcome 枚举、ApprovalRequestEvent、`approval/request` waterfall 签名
3. `thirdparty/deepseek-harness/packages/interaction/user-approval/README.md` L154 — 无 approve-always/授权存储（deferred）
4. `thirdparty/deepseek-harness/packages/core/tools/src/contracts.ts` L26-102 — ToolDefinition 无风险等级字段（风险控制走沙箱模式+执行期升级）
5. `thirdparty/deepseek-harness/packages/sandbox/sandbox/src/escalation.ts` L172-205 — 越界审批 fail-closed
6. `thirdparty/deepseek-harness/docs/capability-seams.md` L752 — `ctx.webServer` 路由注册扩展面
7. `thirdparty/deepseek-harness/docs/user/develop/framework/events.md` L102-106 — `session/event` 馈送订阅
8. `node_modules/.pnpm/@deepseek-ai+dsh-sdk-protocol@*/README.md` — 方案 B 否决证据（7 RPC 方法无审批应答）
9. `thirdparty/ag-ui/docs/spec/1.0/basic/transports/http-sse.mdx` — AG-UI HTTP+SSE 端点契约
10. `thirdparty/deepseek-harness` 全仓 grep `ag-ui|agui` 零命中 — 方案 C 否决证据
