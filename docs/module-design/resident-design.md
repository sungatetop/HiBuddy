---
title: @hibuddy/resident 常驻层模块设计（S7-B）
summary: 常驻层设计——管家会话（常驻 Agent Loop，小工具面）直接面向用户，经 send_message_to_user 双向对话、经 create_session 指派 worker（普通 dsh 会话）；事件源→事件信封→管家决策→委派→回执；审批由管家分级代管或升级请用户确认；微信式对话界面为唯一用户面，SQLite 持久化恢复；AG-UI 应用于管家层
keywords: [常驻层, resident, 管家会话, butler, worker 会话, 事件源, 定时任务, 周期监控, 工作项, 消息面, 审批代管, S7-B, 模块设计]
status: accepted
date: 2026-11-09
---

# @hibuddy/resident 常驻层模块设计（S7-B）

> 依据：[ADR-010](../decisions/ADR-010-resident-proactive-agent.md)（定位修订与混合路线）、[ADR-011](../decisions/ADR-011-butler-conversation-layer.md)（管家会话形态，取代本文 D1 并修订 §2/§3/§6/§9/§10）、[PRD §3.2](../product/requirements.md)、[PRD FR-10](../product/requirements.md)、[S7-A 原型验证结论](../progress-report.md)、dsh-superagent-prototype 机制文档（thirdparty/dsh-superagent-prototype/docs/001-domain、002-authorization、003-execution）、OpenMuse 机制实证（ADR-010 §5.3）。
> 状态：accepted（2026-11-05 评审通过；2026-11-09 依 ADR-011 修订为管家形态，B1–B5 交付不返工，B6–B10 重排）。S7-B 实施任务与验收标准见 [implementation-plan §S7](../implementation-plan.md)。

> **修订说明（2026-11-09，ADR-011）**：本文原 D1「不设常驻 router LLM 会话」被取代——常驻智能体本身就是一条常驻 Agent Loop（管家会话），用户面由「常驻面板四 tab」改为「微信式对话界面」。下文已按新形态改写；仍保留的确定性组件（事件源、调度、过滤、worker 编排、持久化、对账）继续有效。

## 1. 用户设计要点（原话落档，为最高设计约束）

> "worker 其实就相当于当前的一个会话，我们需要做的就是在这个会话之上加一层，让用户仅需关注目标，后台 worker 会话由常驻智能体自主管理。"（用户，2026-11-05）

> "常驻智能体是直接面向用户的，本质上是类似于管家……通过 send_message_to_user 向用户主动发送消息；设计独立的对话界面仅显示用户发送的消息和来自 send_message_to_user 的消息……可以通过 create_session 发起子任务 worker……会话即 worker（区别于会话内的 worker）。其本身也是一个使用同一 Agent Loop 逻辑，但是工具面小一些。"（用户，2026-11-09，全文见 ADR-011 §1.3）

贯穿全文的约束：

1. **worker 会话不是新形态**——就是现有 dsh 会话（同一 runtime、同一 preset/审批/留痕主干），不另造执行引擎；`create_session` 走 `agents.create`，不用会话内子代理。
2. **管家是唯一的用户面**——一条常驻 Agent Loop 会话，只经 `send_message_to_user` 出站、只经 `create_session` 指派；其推理、工具调用、worker 过程对用户不可见。
3. **常驻层的增量分两类**——确定性部分（事件源、调度、过滤、持久化）与决策部分（管家会话）；前者照旧，后者新增。

## 2. 总体架构

### 2.1 分层

```
用户可见面          微信式对话界面（新增，唯一用户面）
                   只渲染：用户消息（右） + 管家 send_message_to_user 出站消息（左） + 审批卡 + "处理中"状态条
─────────────────────────────────────────────────────────────────────
管家层              @hibuddy/resident：管家会话 resident-butler（常驻 Agent Loop，hibuddy-butler preset 小工具面）
  入站               用户消息 / 事件信封 / worker 结果回执 / 审批事件（单轮串行 + 队列 + 聚合）
  决策               create_session（可指定工作区）/ send_to_session / get_session / list_sessions / list_workspaces
                     / cancel_session / resolve_approval（分级代管）/ send_message_to_user / 记忆
  出站               消息账本（in/out）→ 对话界面 / AG-UI（管家层）
─────────────────────────────────────────────────────────────────────
确定性层            事件源框架（scheduler / monitor）→ 两级过滤 → 事件信封
                    持久化 SQLite + 启动重对账 + 单实例锁
─────────────────────────────────────────────────────────────────────
worker 会话         普通 dsh 会话（create_session 发起；用户不直接面对）
                    standard preset + coworker 审批分级 + 原生留痕（FR-08）
```

### 2.2 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **设常驻管家会话**（`resident-butler`，hibuddy-butler preset）：它是唯一面向用户的 Agent Loop，负责理解、决策、指派、汇报、代管审批 | 取代原 D1；"管家"必须有决策者（ADR-011 D1） |
| D2 | **worker 会话走 dsh 原生 session create/resume**，照 web session-controller composeAgent 模式装配三要素（preset mount、agentDefaultModel → agentOptions、meta.agentPreset）；由管家经 `create_session` 发起（`agents.create`，非 `ctx.subagents`） | S6-2/S7-A 已验证的装配纪律；"会话即 worker"（ADR-011 D3） |
| D3 | **stateDir 部署级硬闸**：未配置持久化目录则拒启（照原型形态） | S7-A 工程发现确认该形态好：常驻组件无持久化即无意义，宁可拒启 |
| D4 | **worker 权限沿用标准沙箱 + coworker 审批分级，不采纳原型的 danger-full-access**；管家本身不持执行类工具 | ADR-010 §3 边界约束 + ADR-011 D6 |
| D5 | **包形态 = dsh bundle 插件**（后端半 + client 半），命名 `@hibuddy/resident` | ADR-003 扩展面纪律；与 coworker/web-ui 同构 |
| D6 | **消息账本是用户面唯一数据源**（`direction: in/out` + `kind`）：通知面并入消息面；出站仅 `send_message_to_user` 写入，审批卡由系统写入 | ADR-011 D2/D11；UI 只读账本 → 思考不可见是结构性保证 |
| D7 | **事件源保持确定性，决策权在管家**：scheduler/monitor 产出事件信封，是否行动由管家判断 | ADR-011 D4；成本与可预测性 |
| D8 | **Ticket 退化为委派账本**：仅由 `create_session`/`cancel_session` 驱动状态机，管家不直接改状态 | 避免双重记账（ADR-011 D5） |
| D9 | **审批分级代管**：管家可代答 L0/L1 与免再询 grant 命中；L2/越权写入升级请用户确认；代答留痕 | ADR-011 D9；保留 S6-2 实质约束 |
| D10 | **AG-UI 应用于管家层**：对外只暴露管家一个 agent，worker 不暴露 | ADR-011 D10 |
| D11 | **委派可指定工作区**：`create_session` 接受工作区 id/标题/路径并写入 `tickets.workspace`；worker 在 `<workspace>/resident-work/<ticket-short>` 执行；缺省用管家绑定工作区（首个注册工作区，可由 `resident.workspace` 配置覆盖）；管家自身会话的 cwd 也绑定该工作区根（dsh 按 header cwd 校验工作区成员） | 用户指令（2026-11-09）；dsh 工作区成员关系由 canonical cwd 决定，cwd 绑定是最小且可靠的实现 |

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
| **Message（消息）** | 新增一等对象（ADR-011 D2/D11）：用户面唯一数据源 | id、direction（in/out）、kind（text/question/report/system/event/receipt/approval）、text、引用（ticketId/sessionId/sourceId/replyTo）、幂等键、已读、触达、创建时间 |
| **ButlerSession（管家会话）** | 新增一等对象（ADR-011 D1） | session id（`resident-butler`）、状态（idle/working）、最近活跃时间、入站队列游标 |
| Notification（通知） | **并入 Message**：原类型（result/report/system/awaiting_approval）映射为 out 消息的 kind；先落库再触达/幂等/免打扰语义保留 | 不再单独建模 |
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
| assessment（LLM 研判） | 仅 inferred 候选：检查会话研判"是否值得行动" | 研判结果作为**事件信封**投递给管家；**观察模式（observe）默认**：信封只带"建议"，管家在对话中向用户汇报而不指派（对应原 would-act 记录）；用户在对话中确认后转行动模式（auto），管家可直接 `create_session` |

**S6-2 观察项复核约束**（设计层面落实）：CopilotKit v2 客户端曾出现无人工点击的自动 resume POST（status:resolved→allowed-once）。常驻审批面必须保证：①待批动作只经**管家轮次内的 `resolve_approval`（代管范围）**或**用户明示确认**放行；②对话界面不接受无操作来源的自动续跑；③实施时以"模拟无头客户端发 resolved 状态"为负向验收用例。

## 7. 执行：worker 会话编排

- 每票一个 worker 会话 `resident-worker-<ticketId>`，走 dsh 原生 create/resume；装配三要素照 D2。
- 工作目录：`<工作区>/resident-work/<ticket-short>/`（在 dsh 沙箱 workspace-write 根内，L1 审批语义不变）。工作区由 `create_session` 的 `workspace`（id/标题/路径）指定，缺省为管家绑定工作区；工作区目录消失时该轮失败，不在别处静默重建。
- 长命令转后台 job、30 分钟上限、handoff 释放 slot——直接沿用 dsh/原型已验证机制，不自研。
- **与 coworker 咬合**：coworker 的 `tools/pre-execute` 与 `approval/request` 挂载在根 ctx（覆盖 composition 内全部会话），worker 会话天然受 L0/L1/L2 分级与 L2 禁用约束——resident 不自建审批。增量两处：**①待批状态提升**——编排层监听 `approval/asked`，把对应 Ticket 置为 `awaiting_approval` 并写入审批卡消息；**②分级代管（ADR-011 D9）**——审批事件作为入站信封进入管家轮次，管家在代管范围内调用 `resolve_approval` 代答（留痕），超出范围则发 `question` 消息请用户确认，用户确认后由管家执行。实施时需真机验证 worker 会话确实命中 answerer 链（验收项）。
- 免打扰窗对待批的影响：免打扰窗内通知仅落库不推送，**待批不挂起**（等待审批会阻塞 worker；个人场景默认仍即时可批，仅推送静默）。紧急策略演进登记开放问题。
- 重启恢复：working 的 Assignment 以 recovery note 续跑（"检查目录与历史再重复任何外部动作"，原型口径）；输入未被会话消化的幂等重投。

## 8. 持久化与恢复

- **SQLite（WAL）**，路径 = `resident.stateDir`（必配拒启，D3）；建议默认 `$DSH_HOME/state/resident/orchestrator.sqlite`。
- 表：`schema_version`、`source_instances`、`triggers`、`tickets`（含 `workspace` 委派工作区列）、`ticket_runs`、`worker_sessions`、`messages`（替代 notifications：in/out + kind + 幂等键 + 已读/触达）、`butler_session`（管家会话与入站游标）、`settings`（免打扰窗/并发/观察模式/代管开关）。
- 留痕不进 SQLite：审批与工具调用走 dsh 原生 session JSONL（FR-08 复用，S3 已验证），SQLite 只存编排状态。
- 启动重对账（恢复语义，S7-A 强证据项的对应实现）：
  1. 读 source_instances 恢复读位置与调度（missed at 补一次、周期跳过）；
  2. working Ticket → resume worker 会话或标记 interrupted；
  3. awaiting_approval 保持待批（审批卡消息重新触达）；
  4. **管家会话与消息账本**：resume `resident-butler`；未消化的入站消息与未送达的出站消息重投/重触达；离线期间完成的 worker 回执补入事件队列；
  5. 面板/对话状态全量由 SQLite 重读（S7-A 行为一致）。
- 锁：proper-lockfile（S7-A 验证 stale 检测有效），防双实例。

## 9. 消息面（原通知面）

- **双向消息账本**是用户面唯一数据源（ADR-011 D2）：`direction`（in/out）+ `kind`（text/question/report/system/event/receipt/approval）+ 引用字段（ticketId/sessionId/sourceId/replyTo）。
- **入站**：用户消息（in/text）；事件信封（in/event，含来源、时间、untrusted、摘要）；worker 回执（in/receipt，含 sessionId、状态、摘要）；审批事件（in/event，附审批卡）。
- **出站**：仅管家 `send_message_to_user`（out）；审批卡（out/approval）由系统在 `approval/asked` 时写入，保证必须被看见。
- **先落库再触达，幂等去重**（幂等键 = 来源 + 类型 + 内容指纹）；PRD FR-10 规则 3 语义保留。
- 触达渠道首批：对话界面（未读计数 + 气泡流）；AG-UI（管家层，见 §10）；桌面系统通知为 P1。
- 系统问题（来源降级、派工失败）也以入站事件进入管家，由管家决定是否转述用户——不允许编排层绕过管家直接对用户说话。
- 免打扰窗：设置项（时段 + 按 ticket 例外）；窗内仅落库不推送，轮次与待批不受影响。

## 10. 对话界面信息架构（Web 端先行）

- **主界面 = 微信式单列聊天**（ADR-011 D11）：
  - 气泡流：用户消息靠右、管家消息靠左；按时间分组（今天/昨天/更早 + 时间戳）；
  - 状态条：管家轮次进行中显示"正在处理…"（宿主事件驱动，不由模型输出）；
  - 底部输入框：Enter 发送、Shift+Enter 换行；发送即入账本（in 消息）；
  - 审批卡内嵌在气泡流中（out/approval），仅提供"批准/拒绝"与"去回复"两个显式操作；
  - **不渲染**：assistant 文本、tool call、thinking、worker 执行细节。
- **任务抽屉（二级）**：工作项列表（状态芯片）+ 详情（目标/执行历史/产出摘要/穿透 worker 会话只读）；定时与监控（scheduler/monitor 来源管理、观察↔行动切换）；设置（免打扰窗/并发/观察模式/审批代管开关/stateDir 只读）。
- **设置显式保存/放弃**（S7-A 工程发现采纳）。
- **AG-UI（管家层）**：`/agui` 以管家为唯一 agent：入站用户消息 → 入站队列；出站消息映射 `TEXT_MESSAGE_*`；工具调用与 worker 拓扑不上行。
- 桌面端复用同一 client 半（S1 三端同源），移动端不在首批（ADR-010 §6.4）。

## 11. 安全口径汇总

1. **权限**：worker = standard preset 沙箱（workspace-write）+ coworker 分级（L1 需批、L2 禁用）+ 每票子目录；**不采纳 danger-full-access**（D4）。
2. **免打扰窗**：通知静默窗（待批不挂起，见 §7）。
3. **观察模式默认**：inferred 行动先研判不执行，用户复核后开 auto（§6）。
4. **审批面安全**：管家代管仅限 L0/L1 与免再询 grant 命中（D9），代答必须带理由并留痕；L2/越权写入升级请用户确认；对话界面不接受无操作来源的自动 resume（S6-2，§6）。
5. **事件注入面**：首批 scheduler/monitor 无外部第三方内容，风险低；Trigger 保留 untrusted 标记与内容消毒字段，外部源接入时启用（ADR-010 §6.3）。

## 12. S7-B 实施拆分（详细任务与验收标准登记于 implementation-plan §S7）

采用 ADR-011 后的任务序列（B1–B5 已交付，B6 起重排）：

| 任务 | 内容 |
|---|---|
| B1 | @hibuddy/resident 包骨架（bundle 后端半 + client 半注册、stateDir 部署闸）——已交付 |
| B2 | SQLite 持久化层 + 启动重对账 + proper-lockfile——已交付 |
| B3 | scheduler 事件源 + 调度器 + Ticket 状态机——已交付 |
| B4 | worker 会话编排 + worker slots 并发——已交付 |
| B5 | monitor 事件源 + 两级过滤与观察模式——已交付 |
| **B6** | **消息账本与消息服务**：messages 表（in/out + kind + 幂等 + 已读/触达 + 引用）、由 notifications 迁移、免打扰窗、启动补投、客户端读取 API |
| **B7** | **管家会话运行时**：`hibuddy-butler` preset（小工具面）、`resident-butler` 常驻会话、入站队列（用户消息/事件信封/回执/审批）、单轮串行与聚合、重启恢复 |
| **B8** | **管家工具集**：send_message_to_user、create_session、send_to_session、get_session、list_sessions、cancel_session、resolve_approval（分级代管）、记忆读写；与 scheduler/monitor/worker 回执接线 |
| **B9** | **微信式对话界面**（client 半）：气泡流、时间分组、输入框、处理中状态条、审批卡、任务抽屉（工作项/定时监控/设置） |
| **B10** | **AG-UI 管家层**：`/agui` 改为管家 agent（入站用户消息→队列；出站消息→TEXT_MESSAGE），逐会话桥降为调试开关；E2E 与回归 |

## 13. 开放问题

1. 周期任务 Ticket 语义：持续 Ticket + 执行轮次已定，但"轮次失败自动重试策略"未定（默认不自动重试，登记后观察）。
2. monitor 检查成本：轻量会话的模型档位是否单独配置（默认与主模型一致，成本过高再引入轻量档）。
3. worker 会话在会话列表的呈现：默认隐藏，任务抽屉可只读穿透（ADR-011 D7 口径已定，列表隐藏方式随 B9 实施确定）。
4. 管家工具面演进：`list_sessions` 之外是否需要 `list_tickets`/定时任务管理工具（避免管家只能靠对话让用户去抽屉操作）。
5. 审批代管阈值与默认开关（ADR-011 §5.6）：沙箱内写入是否默认代管、代管后是否逐条播报。
6. 事件聚合窗口与紧急事件绕过（ADR-011 §5.2）。
7. 事件触发分派端到端验收口径沿用 S7-A 缺口登记——resident 首批事件源不依赖 gh 操作员凭据，B10 可独立端到端。
