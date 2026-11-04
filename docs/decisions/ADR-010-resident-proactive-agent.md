---
title: ADR-010 产品定位修订——个人常驻智能体与主动式执行层
summary: HiBuddy 定位从"对话式工作伙伴"修订为"个人常驻智能体（resident personal agent）"：常驻运行、事件驱动、主动执行、人管目标与验收；实现路线采混合式——S7-A 先安装 dsh-superagent-prototype 真机验证 dsh 常驻机制，S7-B 自研 @hibuddy/resident 面向个人场景（首批事件源=定时/周期任务）；S6 按既定范围收尾不受影响，AG-UI 桥与常驻层正交
keywords: [ADR, 产品定位, 常驻智能体, 主动执行, Super-agent, OpenMuse, dsh-superagent-prototype, Router, Worker, 事件驱动, S7]
status: accepted
date: 2026-11-04
---

# ADR-010 产品定位修订——个人常驻智能体与主动式执行层

> 决策依据：用户定位调整指令（2026-11-04）「目前的主界面对话是常规对话，与大多数对话类智能体定位一样，真正需要的是个人常驻智能体……需要在已有的基础上补上主动式、常驻式智能体这一层，这才是核心价值」；三方调研实证（dsh Super-agent 官方发布与开源原型、OpenMuse、HiBuddy 现状差距），证据索引见 §5。
> 关联：[ADR-003](ADR-003-dsh-based-customization.md)（定制纪律不变：扩展面、不 fork）；[PRD](../product/requirements.md)（定位与对象模型同步修订）；[implementation-plan](../implementation-plan.md) S6/S7。

## 1. 背景与决策点

### 1.1 现状差距

HiBuddy S1–S5 已交付：三端载体（CLI/Web/桌面）、审批分级与留痕、生成式 UI、AG-UI 桥、双端对等验收。但按 [PRD](../product/requirements.md) 现行定位，产品触发方式**仅有"用户在会话中下达一条目标"**——与主流对话类智能体同构。PRD §3.2 预留给 P1 的"多会话并行执行、后台任务队列、定时/周期任务、跨会话记忆"，正是常驻/主动式智能体的构成要素，当前全部未动工；对象模型（Thread/Run/Message/ToolCall）无事件源、无持久工作项、无常驻调度概念。

### 1.2 行业对齐目标

| 参照物 | 定位表述 | 对 HiBuddy 的含义 |
|---|---|---|
| dsh Super-agent（官方，2026-10-31） | 「迈向更自主的 Agent 系统」：人只定目标与验收，会话管理与上下文同步上移到系统层；多任务上限不再取决于人的注意力 | dsh 官方已给出常驻形态的参考架构与开源原型，且原型即 dsh bundle——与 HiBuddy 底座同源 |
| OpenMuse | "a personal agent with a browser, terminal, files, **and work that keeps going**"——工作不随会话结束，服务端持久运转 | 个人常驻场景的完整工程蓝本（任务队列/Monitor/审批/通知/记忆） |

## 2. 决策一：产品定位修订

**HiBuddy = 个人常驻智能体（resident personal agent）**，四要素：

1. **常驻运行**：Agent 生命周期与会话解耦，应用关闭/页面断开后任务继续（PRD FR-09 已有雏形，升级为一等能力）。
2. **事件驱动**：环境事件（时间、消息、文件、网页变化）可触发 Agent 主动行动，两级过滤控噪（确定性规则先行，LLM 研判定夺）。
3. **主动执行**：Agent 可并行推进多个工作项；结果不确定时投机执行（后台先试、有价值再提交）；主动汇报与征询。
4. **人管目标与验收**：人设定目标与偏好、审批高风险动作（复用 S3 审批分级）、验收结果；不做无边界自主。

同步修订：PRD 定位章节与产品契约（触发增加"事件驱动"）、对象模型扩展（常驻层对象：事件源 Trigger、工作项 Ticket、周期监控 Monitor、通知 Notification——细定义随 S7 立项定稿）；PRD §3.2 中"多会话并行执行、后台任务队列、定时/周期任务、跨会话记忆"从 P1 预留提升为常驻层范围。

## 3. 决策二：实现路线——混合式（先验原型，再自研）

| 阶段 | 内容 | 理由 |
|---|---|---|
| **S7-A 验证** | 直接安装 `dsh-superagent-prototype`（dsh bundle，engines `^0.2.1-alpha.2` 与已装 0.2.1-rc.5 兼容），真机跑通 Router/Worker 常驻、事件触发、持久化与崩溃恢复；沉淀机制结论 | 原型与 HiBuddy 底座同源（同为 dsh bundle + Cordis），安装即验证官方机制面；避免在未验证的机制上直接自研 |
| **S7-B 自研** | `@hibuddy/resident` 插件：面向个人场景的常驻编排层——首批事件源 = **定时/周期任务**（最可控的基础形态，OpenMuse Monitor 蓝本：条件+间隔+去重+退避）；复用 coworker 审批分级、生成式 UI、会话留痕；事件源框架按 superagent 的 Source 模式（registry/poll/host）演进后续渠道（邮箱/IM/本地文件/网页监控） | 个人场景事件源与原型（GitHub/Feishu 研发场景）不对口；自研层贴合定位且受控；原型作为机制对照持续参考 |

边界约束：

1. 遵守 ADR-003：一切走 dsh 官方扩展面（bundle 插件、ctx 服务注入、cordis.patch.yml）；不 fork、不改 dsh 内核。
2. 原型官方声明为 research prototype（大量代码由 coding agent 写成、watchdog/异步 ReAct/长期记忆未实现）——S7-B 自研时不照搬其实现，仅对标机制与数据模型（Ticket/Subscription/两级过滤/SQLite 持久化/恢复语义）。
3. 安全边界沿用既有基线：ADR-006 信任链、SR-01 审批分级；常驻 Worker 的权限授予与批准口径在 S7 立项时单独细化（原型对 Worker 会话直接给 danger-full-access，HiBuddy 不采纳）。

## 4. 决策三：阶段规划

1. **S6 按既定范围收尾**（AG-UI 桥 CopilotKit 接入 + 上游热激活缺口跟进），不做范围改动——其产物（AG-UI 端点、生态验证）是常驻层的监督/接入面之一。
2. **新增 S7 常驻层阶段**：S7-A 原型真机验证 → 结论登记 → S7-B `@hibuddy/resident` 设计与实施。S7 详细任务与验收标准在 S6 收官后、S7-A 完成时登记（先验证后定验收，避免拍脑袋）。
3. **AG-UI 桥与常驻层正交**：桥暴露的是"同一 runtime 的会话"端点；常驻 Router/Worker 会话未来同样可经桥接入生态前端，无需返工。

## 5. 证据索引

1. dsh 官方技术文章《Super-agent 设计探索：迈向更自主的 Agent系统》（2026-10-31 公众号，媒体报道多源交叉：央视财经 2026-11-02、钱江晚报、Pandaily、DEV）；开源原型 `deepseek-ai/dsh-superagent-prototype`（MIT，≈97.5% TypeScript，单 commit 研究原型），已克隆 `thirdparty/dsh-superagent-prototype`。
2. 原型机制实证（2026-11-04 源码调研，对照 d:\GenUI\node_modules\@deepseek-ai 0.2.1-rc.5 安装树）：Router 主会话常驻（`src/app/runtime.ts` ensure masterId + `dsh-superagent-router` preset）；Ticket/Mandate/Subscription 领域模型（`src/core/model.ts`、docs/001-domain.md）；两级过滤（`src/policy.ts` 准入矩阵 + `src/app/assessment.ts` LLM 研判）；SQLite 持久化与崩溃恢复（`src/app/store.ts`、`executor.resume()`）；事件源仅 GitHub 轮询/Feishu（`src/sources/`）；监督面板经 dsh client slots（`src/client/`）；watchdog/异步 ReAct/长期记忆未实现。
3. OpenMuse 实证（`thirdparty/OpenMuse`）：AgentTask 状态机与 DB 租约队列（packages/domain/src/agent.ts、apps/server/src/engine/worker.ts）；Monitor 一等实体与退避去重（agent.ts、service.ts）；审批 proposal 30 分钟过期、outcome_unknown 不自动重试（actions.ts、db.ts）；通知持久化+幂等（service.ts notify/publishOutcome）；显式记忆防注入（remember_fact、memory 注入声明非权威）。
4. HiBuddy 现状：PRD §1/§2/§3.2；implementation-plan S1–S6。

## 6. 风险与开放问题（随 S7 推进回答）

1. 常驻任务的权限面：Worker 长时运行的审批策略与"免打扰"边界（原型的 danger-full-access 不采纳，具体口径 S7-B 定）。
2. 资源占用：常驻 Router + 并行 Worker 的 token 成本与本地资源约束（官方实验数据仅为方向参考）。
3. 事件注入风险：外部内容（邮件/网页/IM）进入事件流的 prompt-injection 面——两级过滤之外需要内容消毒策略。
4. 移动端常驻形态（Flutter 接入常驻通知面）不在 S7 首批。
