---
title: @hibuddy/resident 常驻层模块设计（S7-B）
summary: 常驻层设计——worker 会话即普通 dsh 会话，其上加一层常驻编排（事件源→两级过滤→工作项→worker 会话派工→通知），用户仅需关注目标；首批事件源为定时/周期任务与周期监控；SQLite 持久化恢复；审批沿用 coworker 分级，不采纳原型的 danger-full-access；常驻面板 Web 端先行（四 tab）
keywords: [常驻层, resident, worker 会话, 事件源, 定时任务, 周期监控, 工作项, 通知, 审批分级, S7-B, 模块设计]
status: accepted
date: 2026-11-05
---

# @hibuddy/resident 常驻层模块设计（S7-B）

> 依据：[ADR-010](../decisions/ADR-010-resident-proactive-agent.md)（定位修订与混合路线）、[PRD §3.2](../product/requirements.md)、[PRD FR-10](../product/requirements.md)、[S7-A 原型验证结论](../progress-report.md)、dsh-superagent-prototype 机制文档（thirdparty/dsh-superagent-prototype/docs/001-domain、002-authorization、003-execution）、OpenMuse 机制实证（ADR-010 §5.3）。
> 状态：accepted（2026-11-05 评审通过；S7-B 实施任务与验收标准见 [implementation-plan §S7](../implementation-plan.md)）。

## 1. 用户设计要点（原话落档，为最高设计约束）

> "worker 其实就相当于当前的一个会话，我们需要做的就是在这个会话之上加一层，让用户仅需关注目标，后台 worker 会话由常驻智能体自主管理。"（用户，2026-11-05）

三条推论，贯穿全文：

1. **worker 会话不是新形态**——就是现有 dsh 会话（同一 runtime、同一 preset/审批/留痕主干），不另造执行引擎。
2. **常驻层的全部增量在"会话之上的一层"**——事件源、过滤、工作项、派工、通知、持久化；这层是确定性编排代码，不是新的 LLM 角色。
3. **用户界面只有目标**——主会话照旧，worker 会话默认不进入用户视野（经工作项穿透查看），创建/续跑/停止由编排层自主管理。

## 2. 总体架构

### 2.1 分层

```
用户可见面          主会话（现有对话，不动） + 常驻面板（新增，只呈现目标与结果）
─────────────────────────────────────────────────────────────────────
常驻编排层          @hibuddy/resident（后端半 cordis 插件，确定性代码）
  事件源框架         Source registry → scheduler / monitor（首批）
  两级过滤          gate（确定性规则） → assessment（按需 LLM 研判）
  工作项与调度       Ticket 状态机 + worker slots 并发闸
  通知面            Notification 落库 → 触达
  持久化            SQLite（stateDir 必配拒启）+ 启动重对账
─────────────────────────────────────────────────────────────────────
worker 会话         普通 dsh 会话（resident-worker-<ticketId>）
                    standard preset + coworker 审批分级 + 原生留痕（FR-08）
                    由编排层 create/resume/stop，用户不直接面对
```

### 2.2 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **不设常驻 router LLM 会话**（原型 orchestrator 的 route 职责退化为确定性编排 + 面板） | 个人场景的定时任务创建即 explicit mandate，无需逐批 LLM 研判；"智能性"由 worker 会话（完整 agent）与 monitor 命中时的研判承担。省 token、行为可预测；后续若需"主动征询/汇报再加工"再演进（登记开放问题） |
| D2 | **worker 会话走 dsh 原生 session create/resume**，照 web session-controller composeAgent 模式装配三要素（preset mount、agentDefaultModel → agentOptions、meta.agentPreset） | S6-2/S7-A 已验证的装配纪律；缺 preset 或缺模型路由会直接导致工具缺失/变量无值 |
| D3 | **stateDir 部署级硬闸**：未配置持久化目录则拒启（照原型形态） | S7-A 工程发现确认该形态好：常驻组件无持久化即无意义，宁可拒启 |
| D4 | **worker 权限沿用标准沙箱 + coworker 审批分级，不采纳原型的 danger-full-access** | ADR-010 §3 边界约束；原型是研发场景研究原型，其执行器免审批形态不适用于个人常驻 |
| D5 | **包形态 = dsh bundle 插件**（后端半 + client 半），命名 `@hibuddy/resident` | ADR-003 扩展面纪律；与 coworker/web-ui 同构 |

## 3. 领域模型（个人场景精简）

对照原型 001-domain：保留"Ticket 自持状态、两级过滤、持久化恢复"三个机制骨架；裁剪研发团队场景专用概念。

| 对象 | 保留/裁剪 | 关键字段 |
|---|---|---|
| TriggerSource（来源） | 保留；kind + instance 二层 | id、kind（scheduler/monitor/…）、配置、启停状态、读位置（恢复不重放） |
| Trigger（触发） | 保留；不可变事件 | id、sourceId、时间、payload、untrusted 标记（内容注入面预留） |
| Ticket（工作项） | 保留；**编排层自持状态，不跟随 worker 会话状态**（原型规则：Ticket 可换手/续跑） | id、目标（prompt）、来源（用户创建 / monitor 命中）、状态、计划、产出摘要、关联会话 id |
| Mandate（授权依据） | 简化为 Ticket 上的两字段：`explicit`（用户创建，默认沙箱内执行） / `inferred`（monitor 命中 + 研判接受，观察模式只记录） | 强度、来源 trigger、研判记录引用 |
| Monitor（周期监控） | 一等对象（OpenMuse 蓝本） | 条件（自然语言）、检查目标（URL/路径）、间隔、下次检查时间、去重指纹、退避计数、模式（观察/行动） |
| WorkerSession（执行会话） | 新增显式建模（用户要点：worker=会话） | ticketId、session id、状态（idle/working/待批/blocked）、最后报告 |
| Notification（通知） | 保留 | id、ticketId、类型（结果/待批/汇报/系统问题）、幂等键、已读、触达状态 |
| **裁剪** | Thread/Subscription/Correlation/Channel/Policy 多人身份体系/bot 名单/PR 流转 | 多源订阅扇出、跨身份映射、渠道回写是研发协作场景概念，个人场景不需要 |

### 3.1 Ticket 状态机

```
pending（待办）→ working（执行中）→ awaiting_approval（待批）⇄ working
                              ↘ completed（完成）
   任意态 → stopped（用户叫停，终态；stopped 不再接收任何触发）
   working → failed（失败；可由用户重试 → pending）
```

- 周期任务：Ticket 持续存在，每次到期产生一次执行轮次（轮次记录在 Ticket 执行历史），不新建 Ticket。
- 一次性任务：执行完即 completed。
- 恢复语义：重启后 working → 重读会话续跑或标记 `interrupted` 待用户确认续跑；pending 的到期补偿见 §8。

## 4. 事件源框架

### 4.1 Source kind 接口（registry 模式）

```ts
interface SourceKind {
  kind: string
  // validate config, start polling/scheduling; emit Trigger via callback
  start(instance: SourceInstance, emit: (t: Trigger) => void): Promise<void>
  stop(instance: SourceInstance): Promise<void>
}
```

- 来源实例持读位置/最后触发时间，重启不重放（原型 Source 规则）。
- 新事件源（邮箱/IM/本地文件/网页）后续以新 kind 注册，编排层零改动。

### 4.2 首批 kind

**scheduler（定时/周期）**
- 一次性 at：到期发 Trigger → 直接建 Ticket（explicit mandate，目标 = 用户预设 prompt）。
- 周期 interval：每次到期对同一 Ticket 触发一轮执行（见 §3.1 周期语义）。
- 触发时间由调度器（§5）驱动，Source 本身无轮询。

**monitor（周期监控，OpenMuse Monitor 蓝本）**
- 检查会话：每个 monitor 一个轻量短会话（复用 resume），按间隔执行"读取目标 → 按条件描述判断 → 输出结构化结果"。
- 去重指纹：上次检查快照 hash，无变化不发 Trigger（幂等）。
- 退避：连续失败按倍增退避，上限封顶；连续 N 次失败标记来源降级并出系统问题通知（PRD FR-10 异常口径）。
- 命中 → 发 Trigger → 走两级过滤（§6）。

## 5. 调度器

- 单进程内 timer 轮询 + `next-run-at` 索引（个人场景无分布式需求，不建租约队列）。
- **worker slots 并发闸**（默认 2，可配置）：每票执行占一个 slot；用户交互唤醒（审批/查看）不占常驻 slot，保证用户永远叫得动自己的任务（原型规则采纳）。
- 到期补偿：重启后错过的一次性 at 补触发一次并标注"延迟触发"；周期任务跳过错过的轮次、按下次时间继续（防雪崩）。

## 6. 两级过滤与观察模式

| 层 | 内容 | 个人场景默认 |
|---|---|---|
| gate（确定性） | 免打扰窗、去重指纹、来源启停、准入判定 | 用户创建 = explicit 放行；monitor 命中 = inferred 候选 |
| assessment（LLM） | 仅 inferred 候选：研判是否值得行动（输入 = 条件、检查结果、相关 Ticket 上下文） | **观察模式（observe）默认**：只记录 would-act 判定不执行，用户在面板复核后可切行动模式（auto）——原型 accept mode 口径 |

**S6-2 观察项复核约束**（设计层面落实）：CopilotKit v2 客户端曾出现无人工点击的自动 resume POST（status:resolved→allowed-once）。常驻审批面必须保证：①待批动作只经**显式人工批准**或**既有会话免再询 grant 命中**放行；②面板审批端点不接受无操作来源的自动续跑；③实施时以"模拟无头客户端发 resolved 状态"为负向验收用例。

## 7. 执行：worker 会话编排

- 每票一个 worker 会话 `resident-worker-<ticketId>`，走 dsh 原生 create/resume；装配三要素照 D2。
- 工作目录：`<工作区>/resident-work/<ticket-short>/`（在 dsh 沙箱 workspace-write 根内，L1 审批语义不变）。
- 长命令转后台 job、30 分钟上限、handoff 释放 slot——直接沿用 dsh/原型已验证机制，不自研。
- **与 coworker 咬合**：coworker 的 `tools/pre-execute` 与 `approval/request` 挂载在根 ctx（覆盖 composition 内全部会话），worker 会话天然受 L0/L1/L2 分级与 L2 禁用约束——resident 不自建审批。增量只有一处：**待批状态提升**——编排层监听 `approval/asked`，把对应 Ticket 置为 `awaiting_approval` 并出通知；`approval/decided` 后回到 working。实施时需真机验证 worker 会话确实命中 answerer 链（验收项）。
- 免打扰窗对待批的影响：免打扰窗内通知仅落库不推送，**待批不挂起**（等待审批会阻塞 worker；个人场景默认仍即时可批，仅推送静默）。紧急策略演进登记开放问题。
- 重启恢复：working 的 Assignment 以 recovery note 续跑（"检查目录与历史再重复任何外部动作"，原型口径）；输入未被会话消化的幂等重投。

## 8. 持久化与恢复

- **SQLite（WAL）**，路径 = `resident.stateDir`（必配拒启，D3）；建议默认 `$DSH_HOME/state/resident/orchestrator.sqlite`。
- 表：`schema_version`、`source_instances`、`triggers`（读位置与最近触发）、`tickets`、`ticket_runs`（执行轮次）、`worker_sessions`、`notifications`、`settings`（免打扰窗/并发/观察模式）。
- 留痕不进 SQLite：审批与工具调用走 dsh 原生 session JSONL（FR-08 复用，S3 已验证），SQLite 只存编排状态。
- 启动重对账（恢复语义，S7-A 强证据项的对应实现）：
  1. 读 source_instances 恢复读位置与调度（missed at 补一次、周期跳过）；
  2. working Ticket → resume worker 会话或标记 interrupted；
  3. awaiting_approval 保持待批（通知重新触达）；
  4. 面板状态全量由 SQLite 重读（S7-A 行为一致）。
- 锁：proper-lockfile（S7-A 验证 stale 检测有效），防双实例。

## 9. 通知面

- **先落库再触达，幂等去重**（幂等键 = ticketId + 类型 + 内容指纹）；PRD FR-10 规则 3。
- 首批渠道：常驻面板（未读计数 + 通知页）；主会话内通知卡、桌面系统通知（FR-07 口径）为 P1。
- 系统问题（来源降级、连续派工失败）同走通知面（原型 overview system problems 口径）。
- 免打扰窗：设置项（时段 + 按 ticket 例外）；窗内仅落库。

## 10. 常驻面板信息架构（Web 端先行）

- 入口：侧边栏 slot（对照原型 Superagent 入口位置），client 半经 dsh client-modules 注册。
- 四 tab（原型六 tab 按个人场景精简）：

| Tab | 内容 |
|---|---|
| 概览 | 运行状态、待办/执行中/待批计数、通知未读、系统问题、观察模式提示 |
| 工作项 | 列表（状态芯片）+ 详情（目标/计划/执行历史/产出摘要/穿透 worker 会话）、创建（自然语言目标）、叫停/重试 |
| 定时与监控 | scheduler 与 monitor 来源管理：创建/编辑/启停/删除，monitor 的模式切换（观察↔行动） |
| 通知 | 列表 + 已读/全部已读 |

- 设置（并入各 tab 或小节）：免打扰窗、并发 slots、观察模式总开关、stateDir 只读展示。
- 面板设置显式"保存/放弃"模式（S7-A 工程发现采纳）。
- 桌面端复用同一 client 半（S1 三端同源），移动端不在首批（ADR-010 §6.4）。

## 11. 安全口径汇总

1. **权限**：worker = standard preset 沙箱（workspace-write）+ coworker 分级（L1 需批、L2 禁用）+ 每票子目录；**不采纳 danger-full-access**（D4）。
2. **免打扰窗**：通知静默窗（待批不挂起，见 §7）。
3. **观察模式默认**：inferred 行动先研判不执行，用户复核后开 auto（§6）。
4. **审批面板安全**：显式人工操作约束 + 负向验收用例（S6-2，§6）。
5. **事件注入面**：首批 scheduler/monitor 无外部第三方内容，风险低；Trigger 保留 untrusted 标记与内容消毒字段，外部源接入时启用（ADR-010 §6.3）。

## 12. S7-B 实施拆分（详细任务与验收标准登记于 implementation-plan §S7）

| 任务 | 内容 |
|---|---|
| B1 | @hibuddy/resident 包骨架（bundle 后端半 + client 半注册、stateDir 部署闸） |
| B2 | SQLite 持久化层 + 启动重对账 + proper-lockfile |
| B3 | scheduler 事件源 + 调度器（一次性/周期、missed 补偿）+ Ticket 状态机 |
| B4 | worker 会话编排（composeAgent 三要素）+ worker slots 并发 |
| B5 | monitor 事件源（条件/间隔/指纹/退避）+ 两级过滤与观察模式 |
| B6 | 通知面（落库/幂等/面板触达） |
| B7 | 审批咬合（待批状态提升 + coworker 覆盖真机验证 + S6-2 负向用例） |
| B8 | 常驻面板四 tab UI |
| B9 | E2E 验收（定时任务闭环、重启恢复、免打扰窗、审批卡、观察模式） |

## 13. 开放问题

1. 周期任务 Ticket 语义：持续 Ticket + 执行轮次已定，但"轮次失败自动重试策略"未定（默认不自动重试，登记后观察）。
2. monitor 检查成本：轻量会话的模型档位是否单独配置（默认与主模型一致，成本过高再引入轻量档）。
3. worker 会话在主会话列表的呈现：默认隐藏还是折叠分区（面板穿透查看已定，列表呈现待面板实施时定）。
4. 常驻 router LLM 会话（D1 的演进触发条件）：出现"跨工作项征询/汇总汇报"需求时重评。
5. 事件触发分派端到端验收口径沿用 S7-A 缺口登记——resident 首批事件源不依赖 gh 操作员凭据，B9 可独立端到端。
