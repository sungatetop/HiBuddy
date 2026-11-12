---
title: ADR-011 常驻智能体形态修订——管家会话、双向消息面与委派式 worker
summary: 常驻智能体改为直接面向用户的"管家"Agent Loop——自身是一条常驻 dsh 会话，只通过 send_message_to_user 出站、通过 create_session 指派 worker（会话即 worker，非会话内子代理）；用户面由常驻面板改为微信式独立对话界面，仅渲染用户消息与管家出站消息，思考与工具执行不可见；管家替用户指挥与监控任务，审批可代管或升级请用户确认；事件源仍为确定性实现，产物以事件信封投递给管家决策；Ticket 退化为委派账本；AG-UI 桥改为应用于管家层
keywords: [ADR, 常驻智能体, 管家会话, butler, send_message_to_user, create_session, 委派, 双向消息, 思考不可见, Agent Loop, 工具面, 审批代管, AG-UI, 微信式对话, resident]
status: accepted
date: 2026-11-12
---

# ADR-011 常驻智能体形态修订——管家会话、双向消息面与委派式 worker

> 决策依据：用户形态指令（2026-11-09，原话见 §1.3）；关联 [ADR-010](ADR-010-resident-proactive-agent.md)（产品定位不变，本 ADR 修订其 S7-B 实现形态）、[resident-design](../module-design/resident-design.md)（D1 被本 ADR 取代）、[PRD FR-10](../product/requirements.md)、[implementation-plan §S7](../implementation-plan.md)。
> 状态：accepted（2026-11-09 评审通过，含补充约束：微信式对话界面、审批代管与升级确认、AG-UI 应用于管家层；resident-design、implementation-plan 与 `docs/README.md` 同步修订。修订记录见 §7：R1（2026-11-12）D2/D6 增补——生成式 UI 进入管家层）。

## 1. 背景

### 1.1 现状（S7-B 已交付 B1–B5，B6 在办）

当前 `@hibuddy/resident` 是**纯确定性编排层**，按 [resident-design §2.1](../module-design/resident-design.md) 分层：

```
事件源（scheduler / monitor）→ 两级过滤（gate + assessment）→ Ticket 状态机
→ WorkerOrchestrator.dispatch → 普通 dsh worker 会话 → Notification 落库 → 面板展示
```

四个事实决定了它与目标形态的距离：

1. **没有"管家"本体**：整条链路上没有任何 LLM 决策者；[resident-design D1](../module-design/resident-design.md) 明文"不设常驻 router LLM 会话"。
2. **用户面是看板不是对话**：[notifications.ts](../../packages/resident/src/notifications.ts) 是单向通知表（result / report / system / awaiting_approval），用户只能去面板点按钮，无法用一句话追问、改主意或叫停。
3. **委派是代码行为不是模型行为**：[scheduler.ts](../../packages/resident/src/scheduler.ts) 到期直接调 [WorkerOrchestrator.dispatch](../../packages/resident/src/worker.ts)，goal 取自 Ticket；worker 会话对模型不可见，不可追加指令、改目标、取消。
4. **过程默认可见**：dsh 原生会话界面呈现 assistant 文本与工具调用，与"思考不可见"的产品要求冲突。

### 1.2 问题陈述

现有形态能"按时干活"，但答不了"用户随口一句话该干什么"：是否行动由确定性规则决定，monitor 命中只落 would-act 记录、无人向用户解释；用户与系统之间是一问一答之外的**指令面板**关系，而不是**对话**关系。产品要的是后者。

### 1.3 用户设计要点（原话落档，最高设计约束）

> "常驻智能体是直接面向用户的，本质上是类似于管家，与用户对话但是实际也是 Agent Loop，通过 send_message_to_user 向用户主动发送消息；设计独立的对话界面仅显示用户发送的消息和来自 send_message_to_user 的消息；Agent Loop 是智能体思考执行属于大脑思考，就像在微信聊天一样，对话的双方思考是不可见，仅可感知输入、响应、回复结果的状态，双方皆是通过 send_message 的方式发送消息，至于对方如何思考、如何执行是看不到的；常驻智能体可以通过 create_session 发起子任务 worker 进行任务处理，属于指派，会话即 worker（区别于会话内的 worker）。其本身也是一个使用同一 Agent Loop 逻辑，但是工具面小一些。"（用户，2026-11-09）

拆成五条贯穿全文的推论：

1. **管家 = 一条常驻 Agent Loop 会话**，不是编排代码，也不是"编排层外加一个人设"。
2. **用户面 = 双向消息**：只显示用户发出的消息与管家经 `send_message_to_user` 发出的消息。
3. **思考不可见**：推理、工具调用、worker 过程都不进入用户视野，用户只感知"输入 / 处理中 / 回复"三种状态。
4. **委派 = `create_session`**：被指派的是**一条独立会话**（会话即 worker），区别于会话内的子代理。
5. **同一 Agent Loop、更小工具面**：管家与 worker 共用运行机理，差异只在工具集与权限。

补充指令（2026-11-09，评审确认）：

> "管家与用户的对话界面像微信聊天界面一样，委派 worker 即是发起一个 dsh 原生的会话，管家替用户指挥、监控任务、需要审批时由管家代管，或向用户请求确认，AG-UI 应当应用于管家层面。"

由此追加三条约束：

6. **对话界面照微信**：单列气泡流、左右分向、时间分组、输入框在底部、"对方正在输入/处理中"状态条；不呈现任何推理与工具细节。
7. **审批可代管**：管家可代为应答低危审批（留痕可审计），高危或超出代管范围时向用户发 `question` 消息请求确认；用户确认后由管家执行。
8. **AG-UI 上移到管家层**：AG-UI 端点暴露的是"管家会话"这一个 agent（输入 = 用户消息，输出 = 管家出站消息），worker 会话不再直接对外；原"逐会话桥"降为内部调试面。

## 2. 决策

### 2.1 分层（修订后）

```
对话面   管家会话 resident-butler（常驻、单轮串行 + 入站队列、hibuddy-butler preset 小工具面）
         in : 用户消息 / 事件信封 / worker 结果回执
         out: send_message_to_user → 消息账本 → 对话 UI（只渲染 in(user) 与 out(butler)）
──────────────────────────────────────────────────────────────────────────
委派面   create_session(goal) → 普通 dsh 会话 resident-worker-<id>（agents.create）
         send_to_session / get_session / cancel_session；Ticket 退化为委派账本
──────────────────────────────────────────────────────────────────────────
事件面   scheduler / monitor 保持确定性（读取目标、指纹、退避、去抖），
         产物由"直接建票派工"改为"事件信封投递给管家"
```

### 2.2 决策清单

| # | 决策 | 理由 |
|---|---|---|
| D1 | **管家会话成为常驻层唯一面向用户的 Agent Loop**；取代 [resident-design D1](../module-design/resident-design.md)"不设常驻 LLM 会话" | 用户要点 1；没有决策者就没有"管家"；原 D1 的省 token 目标改由事件聚合与工具面收敛实现（D8） |
| D2 | **双向消息账本是用户面的唯一数据源**：`direction: in/out` + `kind`；`send_message_to_user` 是管家唯一出站通道；B6 通知面降级为消息面的投影 | 用户要点 2/3；UI 只读账本，天然做到"思考不可见"，且重启后对话可完整回放 |
| D3 | **`create_session` 走 `agents.create` 建普通会话**，显式不使用 `ctx.subagents`；配套 `send_to_session` / `get_session` / `cancel_session` | 用户要点 4；子代理生命周期绑定父会话、不可独立恢复与审批，不满足"会话即 worker" |
| D4 | **事件源保持确定性，决策权在管家**：scheduler/monitor 只负责"到点/命中→信封"，是否行动、如何行动由管家判断；用户显式创建的周期任务保留"免唤醒直派"快捷路径 | 纯确定性丢失智能性，全 LLM 化丢失可预测性与成本控制；混合式两端兼得 |
| D5 | **Ticket 退化为委派账本**：仅由 `create_session` / `cancel_session` 驱动状态机，管家不直接改状态；保留持久化、去重、重启对账 | 避免"管家记忆 vs 状态机"双重记账（resident-design §3 的 Ticket 自持状态原则保留） |
| D6 | **管家 preset `hibuddy-butler` 小工具面**（见 §2.3）；worker 沿用 `standard` + coworker 审批分级，不采纳 danger-full-access（延续 ADR-010 §3 边界） | 用户要点 5；管家权力来自"指派"，不来自"亲手执行"，攻击面与误操作面同时收窄 |
| D7 | **对话 UI 自绘消息账本**，不复用 dsh 原生会话渲染；"思考不可见"是结构性保证而非渲染开关 | 过滤 session 事件流依赖"哪条 assistant 文本是发给用户的"这一不可靠标注 |
| D8 | **单轮串行 + 入站队列 + 事件聚合**：同一时刻管家只跑一轮；入站消息排队；事件类入站（monitor 命中、worker 回执）在窗口内合并为一条信封 | 成本治理；避免每条事件一轮 LLM，也避免并发轮次互相踩上下文 |
| D9 | **审批代管分级**：管家可代为应答 L0/L1 低危审批与既有免再询 grant 命中的审批（代答写入消息账本与 `approval/decided` 审计）；L2、越权写入、危险动作一律升级为 `question` 消息请用户确认。代管可在设置中关闭（关闭后全部升级） | 用户要点 7；保留 S6-2 的实质约束——"无操作来源的自动 resume 不放行"，但允许有轮次、有留痕、有理由的 agent 决策 |
| D10 | **AG-UI 应用于管家层**：`/agui` 端点承载管家这一个 agent——`RunAgentInput.messages` 的末条用户消息作为入站，管家出站消息映射为 `TEXT_MESSAGE_*`；worker 会话不暴露 | 用户要点 8；生态前端只面对一个稳定的对话对象，worker 拓扑随实现演进不变 |
| D11 | **对话界面为微信式单列聊天**：气泡流（用户右、管家左）、时间分组、底部输入框、`pending` 状态条（"正在处理/正在执行任务"）、审批卡内嵌气泡；不渲染 assistant 文本、tool call、thinking | 用户要点 6；"思考不可见"是产品语义，不是可开关的显示偏好 |

### 2.3 管家工具面（首批）

| 工具 | 语义 | 备注 |
|---|---|---|
| `send_message_to_user` | 向用户发出站消息（`text`（Markdown）+ `kind: text\|question\|report\|system` + `reply_to` + 可选 `session_id` / `attachments`） | 非阻塞：返回即"已入账本/已进 UI"；`question` 表达需要回复，不挂起轮次；`session_id` 让气泡可一键打开被汇报的 worker 会话；附件为工作区内本地文件（`path`）或 http(s) URL（`url`），按 image/video/audio/file 预览，本地路径受工作区白名单约束 |
| `create_session` | 指派一条 worker 会话（`goal`、可选 `title`、`workspace` = 工作区 id/标题/路径；缺省用管家绑定工作区）→ 返回 `sessionId` + `ticketId` + `workspace` | 内部即 `agents.create` + 委派账本落行（ticket.workspace 持久化）；worker 在 `<workspace>/resident-work/<ticket-short>` 内执行；目标文本随信封继承 `untrusted` 标记 |
| `list_workspaces` | 列出已注册的 dsh 工作区（id/标题/路径） | 管家在用户点名项目/工作区时先查询，再把结果传给 `create_session` |
| `send_to_session` | 向指定 worker 会话追加指令（followup） | 用于改目标、补充约束、回答 worker 的提问 |
| `get_session` | 读取会话状态 / 最近摘要 | 只返回状态与摘要，不回灌完整日志（上下文治理） |
| `list_sessions` | 列出委派中的 worker（状态、目标、最近摘要） | 管家"监控任务"的查询面；不含其他用户的会话 |
| `cancel_session` | 停止 worker 并结束委派账本 | 对应 Ticket → stopped |
| `resolve_approval` | 代为应答指定审批（`approved` / `rejected` + 理由） | 仅限 D9 代管范围内的 L0/L1；L2 与越权写入必须升级请用户确认；每次调用写入消息账本与审计 |
| 记忆读写 | 显式偏好/事实的读写（具体命名实施时定） | 沿用既有显式记忆纪律，防注入 |

**不入管家工具面的东西**：文件写入、命令执行、网络抓取、直接 SQLite 访问。这些属于 worker；管家只"说话、指派、代批（受限）、查询"。

### 2.4 消息与事件语义

- **入站**：用户消息（`direction=in, kind=text`）；事件信封（`kind=event`，携带 source、时间、untrusted、摘要，不含原始大文本）；worker 结果回执（`kind=receipt`，携带 sessionId、状态、摘要）。
- **出站**：`send_message_to_user` 写入（`direction=out`）。
- **审批卡**：`kind=approval` 的出站消息由系统在 `approval/asked` 时写入，保证"必须被看见"；管家可经 `resolve_approval` 代答（D9），也可发 `question` 消息请用户确认。用户的确认回复以入站消息进入管家下一轮，由管家执行代答——**UI 不接受无操作来源的自动 resume**（S6-2 约束保留）。
- 通知面原有能力（先落库再触达、幂等键、免打扰窗）平移到消息账本：免打扰只影响推送，不影响入账本与轮次执行（resident-design §7"待批不挂起"口径不变）。
- **处理中状态**：管家轮次进行中，对话界面显示 `pending` 状态条；轮次结束即消失。该状态来自宿主事件，不由模型输出。

## 3. 被否决的替代方案

| # | 方案 | 否决理由 | 保留价值 |
|---|---|---|---|
| A1 | 维持现状（D1 纯确定性编排 + 四 tab 面板） | 无决策者：用户随口一句话无法转化为行动；monitor 命中只能记录不能对话；与"管家"定位不符 | 其执行层（store / scheduler / monitor / worker 编排 / reconcile）全部保留复用 |
| A2 | 全 LLM 编排：每个事件、每次到期都唤醒管家决策 | token 成本与延迟不可控；定时任务本已 explicit mandate，逐次研判属浪费；行为可预测性下降 | 事件信封 + 聚合窗口（D8）保留了"事件进管家视野"的可演进性 |
| A3 | 用 session JSONL 过滤出消息充当对话视图 | 依赖"这条 assistant 文本是发给用户的"这一不可靠标注；用户消息与出站消息无法建立 reply 关系；会话压缩/重启后视图脆弱 | 会话日志继续作为审计与排障的 ground truth（FR-08 不变） |
| A4 | 用 `ctx.subagents`（会话内 worker）承担委派 | 子代理生命周期绑定父会话，不可独立恢复、不可长时运行、审批与留痕归属父会话，与"会话即 worker"直接矛盾 | 会话内子代理仍可用于 worker 自身的再拆分（不自研） |
| A5 | `send_message_to_user` 之外再加阻塞型 `ask_user` | 两套阻塞语义（一问一答挂起 vs 非阻塞播报），轮次状态机与 UI 状态复杂化 | 若 `question` 实测不足以表达澄清场景，再以独立 ADR 引入 |
| A6 | 复用 dsh 原生 chat 渲染 + "干净模式"隐藏思考/工具调用 | 渲染层过滤需信任每条内容都有可靠标记；组件升级即可能泄漏过程；无法保证"只显示两类消息"的产品语义 | 作为 UI 落地备选：若 client 无法注册独立主视图，退回该方案并接受其风险 |
| A7 | 审批全自动：所有审批都由管家直接代答 | 越权写入与危险动作失去人类确认环节，违背"人管目标与验收"（ADR-010 §2 要素 4） | 分级代管（D9）保留自动化收益，同时把不可逆动作留给用户 |
| A8 | AG-UI 继续按会话暴露（每个 worker 会话一个 agent） | 生态前端需感知 worker 拓扑、会话生命周期与内部 id；与"用户只面对管家"矛盾 | 逐会话桥保留为内部调试与自动化测试入口 |

## 4. 影响分析

### 4.1 对现有文档

- [resident-design](../module-design/resident-design.md)：D1 失效（由本 ADR 取代）；§2.1 分层、§3 对象（Ticket/Notification/WorkerSession 语义）、§6 观察模式（would-act 改为管家汇报）、§9 通知面、§10 面板全部需修订；§1 用户设计要点并入本 ADR §1.3。
- [implementation-plan §S7](../implementation-plan.md)：B6 改造、B7 审批消息化、B8 由"四 tab 面板"改为"对话 + 任务抽屉"、B9 增补验收场景。
- [PRD](../product/requirements.md)：§3.2 常驻层、§4.2 对象模型、FR-10 的"常驻任务面板"措辞需与对话面一致。
- ADR-010 定位不变，不标记 superseded；本 ADR 是其 S7-B 实现形态的细化修订。

### 4.2 对代码

**保留（不返工）**：`store.ts`、`lock.ts`、`reconcile.ts`、`scheduler.ts`、`state-machine.ts`、`state-dir.ts`、`monitor.ts`、`filter.ts`、`session-check.ts`、`worker.ts` 的轮次驱动与恢复逻辑。

**新增**：管家会话生命周期（常驻、入站队列、单轮串行、事件聚合）、消息表与消息服务、`hibuddy-butler` preset（照 [dsh-superagent-router 的 patch 声明方式](file:///d:/GenUI/thirdparty/dsh-superagent-prototype/cordis.patch.yml)）、工具实现（§2.3 清单）、微信式对话视图（client 半）。

**改造**：`notifications.ts`（→ 消息服务；幂等/免打扰/先落库保留）、`filter.ts`（observe/auto 的落点从"建票/通知"改为"信封投递 + 建议"）、`index.ts`（装配管家会话与工具）、`client/index.tsx`（B1 空壳 → 对话界面）、`packages/ag-ui-bridge`（端点主体由"会话桥"改为"管家桥"，逐会话模式降为调试开关）。

### 4.3 对安全与审批

1. **管家工具面小 ≠ 零风险**：`create_session` 的 `goal` 会成为 worker 的 prompt，构成注入面。事件信封必须携带 `untrusted` 标记并在 `create_session` 时原样传递；worker 侧沿用既有沙箱与审批分级。
2. **审批代管有界**：管家可代答 L0/L1 与既有免再询 grant 命中的审批（D9），每次代答必须带理由并写入消息账本与 `approval/decided` 审计；L2、越权写入、危险动作只能升级为 `question` 消息由用户确认。UI 仍不接受无操作来源的自动 resume（S6-2 负向用例保留），代答只能来自管家轮次内的 `resolve_approval` 调用。
3. **叫停权在用户**：用户可经对话直接叫停；`cancel_session` 只能由管家在用户意图下调用，且对话账本留痕。
4. **出站消息不承载权限**：`send_message_to_user` 不产生任何授权效果，避免"管家说已批准"式越权。
5. **AG-UI 面收敛**：对外只暴露管家 agent，worker 会话 id 与拓扑不出网；逐会话桥默认关闭，仅调试开关可开启。

### 4.4 对成本与上下文

- 每条用户消息一轮 LLM；事件类入站按窗口聚合（参数待实测，见 §5）。
- 入站信封与 worker 回执只带摘要，不注入完整会话日志；worker 详情经 `get_session` 按需拉取。
- 管家会话上下文随对话增长，需要压缩/摘要策略（沿用 dsh 原生压缩能力，不自研）。

### 4.5 AG-UI 层位变更

| 项 | 变更前 | 变更后 |
|---|---|---|
| 端点语义 | `/agui` 承载"某一 dsh 会话" | `/agui` 承载"管家"这一个 agent |
| `threadId` | dsh 会话 id | 固定管家会话（单用户单线程） |
| 输入 | 会话内消息 | 用户消息入站（`RunAgentInput.messages` 末条） |
| 输出 | 会话事件映射（含工具调用） | 仅管家 `send_message_to_user` 产生的 `TEXT_MESSAGE_*` 与 `RUN_FINISHED`；工具调用不上行 |
| 审批 | 经 AG-UI 前端回传 resolved | 审批在管家对话内呈现（审批卡消息 + 用户确认回复），AG-UI 前端只看到 `kind=approval` 的出站气泡 |
| worker | 可逐会话暴露 | 不暴露；调试开关保留逐会话桥 |

### 4.6 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| dsh client 是否支持注册独立主视图 seat **未验证**（现有 web-ui 仅用过 `sidebar.right.pane.tab` 等 seat） | UI 方案可能退回 A6 | 实施前先做一次 seat 能力 spike，结论决定对话视图的实现路径 |
| 管家误判（该派不派、不该派乱派） | 用户目标落空或成本浪费 | 观察模式默认仅建议；派工结果以回执入账本，用户可即时纠正；委派账本可审计 |
| 双重记账（管家记忆 vs Ticket 状态机） | 状态不一致 | D5：状态只由工具驱动，管家读到的永远是账本事实 |
| 上下文膨胀 | 延迟与成本上升 | 信封摘要化 + 按需拉取 + 原生压缩 |
| 重启恢复 | 对话与委派丢失 | 消息账本与委派账本同时持久化；启动对账重投未送达出站消息、补处理离线期间的 worker 回执 |

## 5. 开放问题

1. **UI seat 可行性**：独立主视图 seat 是否可由 `@hibuddy/resident` 的 client 半注册；不支持时的退化路径（A6）与风险接受口径。
2. **事件聚合参数**：窗口时长、同类事件合并规则、紧急事件（失败/待批）是否绕过聚合。
3. **周期任务快捷路径**：用户显式创建的周期任务是否默认"免唤醒直派"，以及切换开关放在对话还是设置页。
4. **管家记忆载体**：显式偏好条目 vs 对话摘要；与 worker 汇报的边界。
5. **`kind=question` 的回复关联**：`reply_to` 的 UI 呈现与超时未回复时的降级行为。
6. **代管阈值**：哪些审批类别算 L0/L1 可代管（沙箱内写入？免再询 grant 命中？）、代管开关默认值与"代管后向用户播报"的频率。
7. **微信式界面细节**：多条出站消息是否合并、worker 进度是否以"正在执行 N 项任务"的轻提示出现（不展示细节）。
8. **移动端**：对话形态的移动端接入（沿用 ADR-010 §6.4 推迟）。

## 6. 证据索引

1. 用户形态指令原话（2026-11-09，§1.3）。
2. 现状代码：`packages/resident/src/index.ts`（无可决策会话）、`worker.ts`（dispatch 由调度器驱动）、`notifications.ts`（单向通知）、`client/index.tsx`（B1 空壳）。
3. 设计现状：`docs/module-design/resident-design.md` D1、§2.1、§3、§6、§9、§10。
4. 上游先例：`thirdparty/dsh-superagent-prototype` 的 bundle patch 声明 `dsh-superagent-router` / `dsh-superagent-worker` 两个 preset（`cordis.patch.yml` `@deepseek-ai/dsh-agent-preset` 行），证明插件包可自定义会话 preset 与工具面。
5. 平台能力：`@deepseek-ai/dsh-tools` 的 `defineTool` / `ctx.tools.register`（`packages/web-ui/src/render-ui-tool.ts` 已实证）；`ctx.agents.create/resume`（`worker.ts` 已实证）；client slots 仅实证过侧栏席位（`packages/web-ui/src/client/*`）。
6. 补充指令原话（2026-11-09，§1.3）：微信式界面、审批代管/升级确认、AG-UI 应用于管家层。
7. AG-UI 现状：`packages/ag-ui-bridge` 以"会话"为单位暴露（S6 交付），本 ADR 将其主体上移到管家层。

## 7. 修订记录

### R1（2026-11-12）D2/D6 增补：生成式 UI 进入管家层

依据：[genui-agui-optimization.md](../solutions/genui-agui-optimization.md)（借鉴 OpenMuse 的 AG-UI 用法与 JEV 契约细节，不引入 JEV）G3/G4，P2 实施完成。修订内容：

- **D6（工具面清单）**：`hibuddy-butler` 工具面由 8 件增至 9 件，新增 `render_ui`（no-op 数据工具：纯 JSON 指令，无文件/网络/代码执行面；§2.3 "不入管家工具面"的执行类边界不变）。指令由宿主持久化（`ui_instructions` 表，schema v6）并自动以 `kind='ui'` 附件引用出站（`name=summary`，读取路由 `GET /resident/api/ui-instruction?id=&revision=`）。
- **D2（唯一出站通道）**：增补语义——`render_ui` 落库后的账本出站引用是宿主自动写入的**派生行**（幂等键 `ui:<id>:<revision>`），不新增消息 kind；`send_message_to_user` 仍是模型唯一的主动出站通道。生态前端沿既有"附件随文本下发为 Markdown"机制拿到 `[summary](/resident/api/ui-instruction?id=…)` 引用；交互回传走 `@[ui:<id>:<revision>]` 文本契约，由管家泵统一做 revision 过期校验（过期回传不进模型上下文，用户收到可见提示）。
- 工具面清单表与 persona 增补见 `packages/resident/cordis.patch.yml`（`hibbuddy-butler-preset` persona 段）。
