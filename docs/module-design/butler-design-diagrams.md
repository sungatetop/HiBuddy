---
title: 管家设计图、运行逻辑与交互逻辑（@hibuddy/resident）
summary: 用分层图、时序图、状态机与交互流程图说明管家会话的静态结构、消息/委派/审批运行链路、微信式界面与 AG-UI 交互语义，以及工作区绑定与失败恢复路径；与现有实现（B1–B10′）逐项对应
keywords: [管家, butler, 设计图, 运行逻辑, 交互逻辑, 时序图, 状态机, resident, 消息账本, 委派, 审批代管, AG-UI, 微信式界面, 工作区绑定]
status: accepted
date: 2026-11-09
---

# 管家设计图、运行逻辑与交互逻辑

> 本文是 [resident-design](resident-design.md) 的图解补充，决策依据见 [ADR-011](../decisions/ADR-011-butler-conversation-layer.md)。图中标识符与 `packages/resident/src/` 实现一一对应；实现状态为 S7-B 的 B1–B10′ 已交付。

## 1. 静态结构（设计图）

### 1.1 分层与依赖

```mermaid
flowchart TB
    subgraph U["用户可见面（唯一用户面）"]
        WX["微信式对话页<br/>sidebar「管家」 + keyed main"]
        DR["任务抽屉<br/>工作项 / 待审批 / 设置"]
        AG["AG-UI 前端<br/>POST /agui（管家层）"]
    end

    subgraph H["宿主 HTTP 面（@hibuddy/resident/api.ts · agui.ts）"]
        API["/resident/api/messages<br/>/resident/api/sessions<br/>/resident/api/settings"]
        AGUI["/agui（管家 agent）<br/>/agui/debug（逐会话调试桥）"]
    end

    subgraph B["管家层（唯一 Agent Loop 用户面）"]
        MSG["MessageService<br/>消息账本唯一写入口"]
        BUT["ButlerRuntime<br/>resident-butler 会话 + 单轮泵"]
        TOOLS["hibbuddy-butler-tools<br/>小工具面（7 件）"]
        APB["ApprovalBroker<br/>审批代管（prepend）"]
    end

    subgraph D["确定性层（无 LLM 决策）"]
        SCH["Scheduler<br/>tickets.next_run_at 轮询"]
        MON["MonitorSource + FilterPipeline<br/>两级过滤 / 观察模式"]
        WK["WorkerOrchestrator<br/>worker 会话编排 + slots"]
        REC["reconcile<br/>启动重对账"]
    end

    subgraph S["dsh 原生运行时"]
        WS["worker 会话<br/>resident-worker-&lt;ticket&gt;<br/>standard preset + coworker"]
        LOG["Session JSONL<br/>审计 / FR-08"]
    end

    DB[("SQLite<br/>orchestrator.sqlite")]

    WX --> API
    DR --> API
    AG --> AGUI
    API --> BUT
    API --> MSG
    AGUI --> BUT
    BUT --> TOOLS
    TOOLS --> MSG
    TOOLS -->|create_session| DB
    BUT -->|send_message_to_user| MSG
    MSG --> DB
    APB --> MSG
    APB --> DB
    SCH --> WK
    MON --> MSG
    WK --> WS
    WK --> MSG
    WK --> DB
    REC --> DB
    SCH --> DB
    WS --> LOG
```

要点：

- **用户只与管家说话**：对话页只渲染账本行（in 用户 / out 管家 / 审批卡），不接触 dsh 会话渲染，因此 assistant 文本、tool call、thinking 不可能泄漏。
- **管家不执行**：`hibbuddy-butler` preset 不含 shell / fs / web / subagent 工具；执行一律 `create_session` 交给普通 dsh 会话。
- **确定性层不做决策**：调度与监控只产生事件信封（入站），是否行动由管家判断。

### 1.2 代码组件映射

| 层 | 文件 | 职责 |
|---|---|---|
| client | `src/client/index.tsx` | 注册 `sidebar.panellist`「管家」入口 + keyed `main` 对话页 |
| client | `src/client/chat-page.tsx` | 气泡流、时间分组、处理中状态条、输入框、审批卡样式、附件预览与图片灯箱 |
| client | `src/client/markdown.tsx` | 管家消息 Markdown 渲染（GFM、表格、代码块、外链新窗口；不启用原始 HTML） |
| client | `src/client/drawer.tsx` | 任务抽屉：工作项、待审批、设置（显式保存/放弃） |
| client | `src/client/api.ts` | 三条数据面请求封装（2s / 3s 轮询）+ 附件预览地址 |
| host | `src/messages.ts` | 账本唯一写路径：先落库、幂等键、免打扰、补投、入站唤醒、出站订阅 |
| host | `src/attachments.ts` | 附件解析：工作区白名单校验、类型/MIME/大小推断、远程 URL 校验 |
| host | `src/butler.ts` | 管家会话、入站队列、单轮串行泵、工具服务面、工作区解析 |
| host | `src/butler-tools.ts` | 8 件工具：`send_message_to_user`（含 Markdown 正文与附件）/ `list_workspaces` / `create_session` / `send_to_session` / `get_session` / `list_sessions` / `cancel_session` / `resolve_approval` |
| host | `src/approvals.ts` | `approval/request` 前置 answerer；审批卡 + 入站审批事件；分级代管与超时 fail-closed |
| host | `src/api.ts` | 对话/工作项/设置/附件读取 HTTP 路由（同一信任栅栏；附件支持 Range） |
| host | `src/agui.ts` | `/agui` 管家层 AG-UI：入站文本 → 管家；出站消息 → `TEXT_MESSAGE_*` |
| host | `src/scheduler.ts` | 1s tick 轮询 `tickets.next_run_at`，迟到阈值 30s |
| host | `src/worker.ts` | worker 会话 create/resume、回合驱动、结果对账、回执入站 |
| host | `src/monitor.ts` / `filter.ts` | 监控检查会话、去重指纹、退避、gate + assessment |
| host | `src/reconcile.ts` | 重启对账：working 续跑/interrupted、待批重投、漏触发补偿 |
| host | `src/store.ts` | SQLite（WAL）schema v3：sources/triggers/tickets(workspace)/runs/worker_sessions/messages/butler_state/settings |

### 1.3 数据模型

```mermaid
erDiagram
    TICKETS ||--o{ TICKET_RUNS : "每次执行一轮"
    TICKETS ||--o| WORKER_SESSIONS : "当前 worker 会话"
    TICKETS ||--o{ MESSAGES : "回执/审批卡引用"
    MESSAGES ||--o{ ATTACHMENTS : "图片/视频/音频/文件"
    SOURCE_INSTANCES ||--o{ TRIGGERS : "产生"

    TICKETS {
        text id PK
        text goal
        text mandate "explicit 或 inferred"
        text origin "user 或 butler 或 monitor:id"
        text state "pending/working/awaiting_approval/completed/failed/stopped"
        text period "null 或 intervalMs"
        text next_run_at
        text workspace "委派工作区 canonical path"
        text session_id
        int interrupted
    }
    MESSAGES {
        text id PK
        text direction "in 或 out"
        text kind "text/question/report/system/event/receipt/approval"
        text text "Markdown 正文"
        text idempotency_key UK
        int read
        int delivered
        text consumed_at "入站队列游标"
    }
    ATTACHMENTS {
        text id PK
        text message_id FK
        text kind "image/video/audio/file"
        text name
        text path "工作区内本地文件"
        text url "远程地址"
        text mime
        int size
    }
    WORKER_SESSIONS {
        text ticket_id PK
        text session_id
        text state "working/idle/awaiting_approval/blocked"
        text last_report
    }
```

## 2. 运行逻辑

### 2.1 启动装配与恢复

```mermaid
flowchart TD
    A["apply: resident.stateDir 硬闸"] -->|未配置| X["拒启 StateDirError"]
    A -->|通过| B["proper-lockfile 单实例锁"]
    B --> C["Store.open + schema 迁移到 v3"]
    C --> D["MessageService 账本服务"]
    D --> E["WorkerOrchestrator 绑定 dispatcher"]
    E --> F["reconcile 启动重对账"]
    F --> F1["working → resume 续跑 或 interrupted"]
    F --> F2["awaiting_approval → 保留待批 + 审批卡补投"]
    F --> F3["漏掉的 at 一次性票补触发"]
    F --> G["MessageService.deliverPending 补投未送达"]
    G --> H["Scheduler.start 1s tick"]
    H --> I["SourceRegistry.startAll 装配 monitor"]
    I --> J["ApprovalBroker.install prepend"]
    J --> K["ButlerRuntime.start<br/>工作区绑定 + create/resume resident-butler"]
    K --> L["注册 /resident/api/* 与 /agui"]
```

管家启动时的**工作区绑定**：

```mermaid
flowchart LR
    A["resident.workspace 配置?"] -->|有| B["按 id/标题/路径解析"]
    A -->|无| C["取首个注册工作区"]
    B --> D{"解析成功?"}
    D -->|否| C
    C --> E["workspaceRegistry 最多等待 5s<br/>web 层插件异步 init"]
    E -->|无工作区/无服务| F["回退 fs.resolve('.')"]
    E -->|有| G["会话 cwd = workspace.path"]
    G --> H["dsh 按 header cwd 认定工作区成员<br/>管家出现在该工作区下"]
```

### 2.2 用户消息 → 管家回复（对话主链路）

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant UI as 微信式对话页
    participant API as POST /resident/api/messages
    participant MS as MessageService
    participant B as ButlerRuntime（单轮泵）
    participant A as resident-butler (Agent Loop)

    U->>UI: 输入并发送
    UI->>UI: 乐观气泡（右侧绿色）
    UI->>API: { text }
    API->>MS: postInbound(kind=text)
    MS->>MS: 先落库（幂等键/未读）
    MS-->>B: onInbound → wake()
    B->>B: pumping=true（同一时刻仅一轮）
    B->>MS: pendingInbound(20) 取一批
    B->>A: followup(renderInbound(batch))
    Note over A: 模型思考/工具调用不可见
    A->>MS: send_message_to_user → postOutbound
    MS-->>UI: 下一轮 2s 轮询读到 out 行
    UI->>UI: 左侧白色气泡 + 处理中条消失
    A->>A: whenIdle + subagent drain + session flush
    B->>MS: consume(batch ids) 推进游标
    B->>B: pumping=false（队列空则停）
```

批次与失败语义：

- 每轮最多消费 20 条入站（用户消息 / 事件信封 / 回执 / 审批事件混排），一次周转内最多循环 50 批。
- 轮次失败：**不消费该批**（用户输入不丢），15s 后重试；`butler_state` 保持/恢复 `idle`。
- 事件类入站不直接显示；模型自行判断是否需要用 `send_message_to_user` 告诉用户。

### 2.3 委派：create_session → worker → 回执 → 汇报

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant B as 管家
    participant T as create_session 工具
    participant DB as SQLite(tickets)
    participant S as Scheduler(1s)
    participant W as WorkerOrchestrator
    participant WS as worker 会话（原生 dsh）
    participant MS as 消息账本

    U->>B: "在 ProjectB 工作区做 X"
    B->>B: list_workspaces（可选）
    B->>T: create_session(goal, workspace="ProjectB")
    T->>T: 解析工作区（id/标题/路径）
    T->>DB: ticket {state: pending, next_run_at: 立即, workspace}
    T-->>B: {ticketId, sessionId, workspace}
    Note over B: 立即回复“已指派”，不必等执行完
    S->>DB: tick 读到到期票
    S->>W: dispatch(ticket)
    W->>WS: agents.create/resume（composeAgent 三要素）
    Note over WS: cwd = workspace/resident-work/ticket-short
    W->>WS: followup(goal + 工作目录说明)
    WS-->>W: turn/end completed
    W->>DB: ticket completed + run ok + worker idle
    W->>MS: postInbound(kind=receipt, 摘要)
    MS-->>B: wake → 下一轮
    B->>B: 判断是否汇报/是否继续跟进
    B->>MS: send_message_to_user(kind=report)
    MS-->>U: 左侧气泡（任务完成 + 路径/结果）
```

关键约束：

- `create_session` 只写委派账本并返回，**派工在 ≤1 个调度 tick（1s）内发生**；不阻塞管家轮次。
- worker 是普通 dsh 会话（`resident-worker-<shortId>`），沿用 standard preset 的工具面与 coworker 审批分级。
- worker 失败不自动重试：ticket → `failed`，并以入站事件交给管家决定如何向用户交代。
- 工作区目录在派工时消失 → 该轮失败（不静默换目录重建）。

### 2.4 审批：代管 / 升级用户确认

```mermaid
sequenceDiagram
    autonumber
    participant WS as worker 会话
    participant CO as coworker（L1/L2 分级）
    participant AB as ApprovalBroker（prepend）
    participant DB as SQLite
    participant MS as 消息账本
    participant B as 管家
    actor U as 用户

    WS->>CO: approval/request（越权写入等）
    CO->>AB: next() → 到达 resident 前置 answerer
    AB->>AB: 仅接管 resident-worker-*；其他会话 next()
    AB->>DB: ticket → awaiting_approval
    AB->>MS: postOutbound(approval) 审批卡
    AB->>MS: postInbound(approval) 审批事件
    MS-->>B: wake → 管家轮次
    alt 代管范围（低危 / 免再询 grant）
        B->>B: resolve_approval(id, approved)
        AB->>WS: allowed-once / rejected
        AB->>DB: ticket → working
        AB->>MS: 代答留痕（会话审计）
    else 高危（danger-full-access / sandbox 升级）或代管关闭
        B->>MS: send_message_to_user(kind=question)
        MS-->>U: 审批卡 + 提问气泡
        U->>MS: 回复确认（in/text，晚于卡片）
        MS-->>B: 下一轮读到用户回复
        B->>B: resolve_approval(id, approved)
        AB->>WS: 放行本次调用
    end
    Note over AB: 30 分钟未决 → fail-closed rejected
```

安全口径：

- 代管只能来自**管家轮次内的 `resolve_approval`**，或**用户明示文本回复**（必须晚于审批卡创建时间）；对话界面/AG-UI 不接受无操作来源的自动 resume。
- 设置 `approvalDelegation=false` 时全部审批升级用户确认。
- 每次决定都写入消息账本 + dsh 原生 `approval/decided` 审计（FR-08）。

### 2.5 Ticket 状态机

```mermaid
stateDiagram-v2
    [*] --> pending: create_session / 到期票
    pending --> working: scheduler dispatch（占用 slot）
    working --> awaiting_approval: approval/request
    awaiting_approval --> working: 审批通过/拒绝后继续
    working --> completed: 一次性票 turn completed
    working --> pending: 周期票本轮完成（next_run_at 预置）
    working --> failed: 打开失败 / turn 失败（不自动重试）
    pending --> stopped: cancel_session / 用户叫停
    working --> stopped: cancel_session
    awaiting_approval --> stopped: cancel_session
    failed --> pending: 用户显式重试（后续）
    completed --> [*]
    stopped --> [*]
```

### 2.6 事件源与观察模式

```mermaid
flowchart LR
    SRC["SourceInstance"] -->|"到期/命中"| TRG["Trigger 落库"]
    TRG --> GATE{"gate 确定性"}
    GATE -->|"来源停用/重复/同源开放票"| DROP["丢弃"]
    GATE -->|"通过"| AS{"assessment 研判"}
    AS -->|"观察模式 observe 默认"| ENV1["事件信封：建议"]
    AS -->|"行动模式 auto"| ENV2["事件信封：已建 inferred 票"]
    ENV1 --> B[管家轮次]
    ENV2 --> B
    B -->|用户确认后| CS[create_session]
```

- monitor 每次检查在独立轻量会话中完成；去重指纹由宿主侧读原文 sha256 计算，避免模型措辞不同导致重复触发。
- 连续失败按 `interval × 2^(n-1)` 退避，封顶 30 分钟；3 连败标记 degraded 并以系统事件告知管家。
- 观察模式下命中只投递“建议”信封，管家在对话里汇报，不直接建票。

## 3. 交互逻辑

### 3.1 微信式对话页信息架构

```mermaid
flowchart TB
    subgraph PAGE["管家面板（main keyed: hibuddy-chat）"]
        HEAD["顶栏：管家 / 副标题 / 「任务」按钮"]
        LIST["气泡流（只读消息账本）"]
        PEND["处理中条：管家正在处理…"]
        INPUT["底部输入：textarea + 发送（Enter 发送 / Shift+Enter 换行）"]
    end
    subgraph BUBBLES["气泡规则"]
        R["用户消息：右对齐 · 微信绿 #95ec69"]
        L["管家消息：左对齐 · 白色"]
        AP["审批卡：黄底 + 标题（需要审批：工具名）"]
        AT["附件：图片缩略图（灯箱）/ 视频音频内联 / 文件卡片（打开/下载）"]
        TS["时间分组：首条 / 跨天 / 间隔 > 5 分钟"]
    end
    subgraph DRAWER["任务抽屉（右侧浮层）"]
        T1["工作项：目标 / 状态 / 会话 / 工作区 / 最近简报"]
        T2["待审批：工具 / 理由 / 审批编号"]
        T3["设置：免打扰时段 / 并行上限 / 观察模式 / 审批代管"]
        T4["保存 / 放弃修改（显式提交）"]
    end
    LIST --> R
    LIST --> L
    LIST --> AP
    LIST --> AT
    LIST --> TS
    HEAD -->|点击任务| DRAWER
```

交互语义：

| 交互 | 行为 | 数据来源 |
|---|---|---|
| 打开面板 | 侧边栏「管家」入口 → keyed `main` 全屏页 | `sidebar.panellist` / `main` slot |
| 发送消息 | 乐观追加右侧气泡 → `POST /resident/api/messages` → 轮询换取权威行 | 消息账本 |
| Markdown | 管家气泡按 GFM 渲染（标题/列表/表格/代码/链接），用户气泡保留原样换行 | 账本 `text` 字段 |
| 图片预览 | 缩略图点击 → 全屏灯箱，点击任意处关闭 | `/resident/api/attachment?id=` |
| 视频/音频 | 内联播放器（controls），宿主 Range 206 支持拖动进度 | 同上 |
| 文件卡片 | 扩展名角标 + 大小 + 「打开 / 下载」；下载追加 `download=1` | 同上 |
| 会话跳转 | 气泡（`refs.sessionId`）与抽屉工作项均显示「打开会话」，调用 `uiWorkspace.openSession(sessionId)` 切到该 worker 原生会话 | `/resident/api/sessions` / 账本 `refs` |
| 处理中 | `status.state === 'working'` 时显示状态条，轮次结束消失 | `butler_state` / 泵状态 |
| 审批卡 | `kind=approval` 黄底气泡，展示工具与审批编号 | 账本 out 行（ApprovalBroker 写入） |
| 任务抽屉 | 每 3s 刷新工作项/待审批；设置仅本地草稿，点「保存」才提交 | `/resident/api/sessions`、`/settings` |
| 思考不可见 | 页面无 assistant 文本 / tool call / worker 日志 | 结构性保证：只读账本 |

界面线框（示意）：

```text
┌────────────────────────────────────────────────────────────┐
│ 管家                                              [ 任务 ] │
│ 替你指挥任务、监控进度、汇报结果                            │
├────────────────────────────────────────────────────────────┤
│                        11/9 14:20                          │
│                                      ┌───────────────────┐ │
│                                      │ 在 ProjectB 整理…  │ │ ← 用户（右/绿）
│                                      └───────────────────┘ │
│  ┌───────────────────────────────────┐                     │
│  │ 收到，已指派 worker…              │                     │ ← 管家（左/白）
│  └───────────────────────────────────┘                     │
│  ┌───────────────────────────────────┐                     │
│  │ 需要审批：write                   │                     │ ← 审批卡（黄）
│  │ 写入工作区外路径…  审批编号 apr_… │                     │
│  └───────────────────────────────────┘                     │
│  ┌───────────────────────────────────┐                     │
│  │ 任务完成：…（路径 + 摘要）        │                     │
│  └───────────────────────────────────┘                     │
│  ● 管家正在处理…                                            │
├────────────────────────────────────────────────────────────┤
│ [ 给管家发消息…                                    ] (发送) │
└────────────────────────────────────────────────────────────┘
      点击「任务」→ 右侧抽屉：工作项 | 待审批 | 设置（显式保存）
```

### 3.2 AG-UI（管家层）

```mermaid
sequenceDiagram
    autonumber
    participant C as AG-UI 前端
    participant API as POST /agui
    participant B as 管家

    C->>API: RunAgentInput {threadId, runId, messages}
    API->>API: 信任栅栏 + 结构校验
    API->>API: 取末条 user 文本；并发 run → 409
    API-->>C: SSE RUN_STARTED
    API->>B: postUserMessage(text)
    B-->>API: 出站订阅（send_message_to_user / 审批卡）
    API-->>C: TEXT_MESSAGE_START / CONTENT / END（每条出站）
    B-->>API: whenIdle（队列空 + 泵停）
    API-->>C: RUN_FINISHED
    Note over API: 10 分钟硬超时；resume 不消费（审批在对话内完成）
```

对外语义收敛：

- `threadId` 只是客户端标识；所有请求都进入同一条管家会话（单用户单线程）。
- 输出只有管家的出站消息气泡；worker 拓扑、会话 id、工具调用**不出网**。
- 附件随文本下发为 Markdown（图片 `![name](…)`，其余 `[name](…)`）；本地文件地址为同源 `/resident/api/attachment?id=`，远程 URL 原样使用。
- 审批不在 AG-UI 层解决：前端只会看到 `kind=approval` 的出站气泡；决定在管家对话内完成。
- 逐会话调试桥保留在 `/agui/debug`（profile patch 配置），产品端点为 `/agui`。

### 3.3 失败、边界与恢复

| 场景 | 行为 | 恢复 |
|---|---|---|
| 管家轮次失败 | 批不消费、日志记录、15s 后重试 | 入站保留 → 下轮重放 |
| 管家会话日志缺失/损坏 | `start()` 捕获 resume 失败 → 新建 `resident-butler` | 账本（用户可见对话）不受影响 |
| 宿主重启 | 单实例锁 + reconcile：working 续跑/标记 interrupted；待批重发审批卡；漏触发补一次 | 重启后自动 |
| worker 会话打开失败 | ticket → failed + 入站事件 | 管家可 `create_session` 重派 |
| 工作区目录消失 | 该轮失败，不重建目录 | 用户确认工作区后重派 |
| 附件路径越界 / 不存在 | 工具调用失败并提示可用工作区，消息不落库 | 管家改用工作区内路径或 URL 重发 |
| 附件文件事后被删 | 读取路由返回 410；气泡正文与文件名仍在 | 让 worker 重新产出后重发 |
| 审批 30 分钟未决 | fail-closed → rejected | 管家/用户重新发起 |
| 免打扰窗 | 出站行照常入账本（对话可见），仅 `delivered` 推送标记延后 | 窗结束补投 |
| AG-UI 客户端断开 | 关闭 SSE、释放 run 槽；服务端轮次继续 | 客户端重连新 run |

## 4. 关键参数

| 参数 | 值 | 位置 |
|---|---|---|
| 调度 tick | 1000 ms | `scheduler.ts` |
| 迟到判定阈值 | 30 s | `scheduler.ts` |
| 管家单轮入站批次 | 20 条 / 最多 50 批 | `butler.ts` |
| 管家轮次失败重试 | 15 s | `butler.ts` |
| worker 并行上限 | 默认 2（设置 0–8） | `worker.ts` / 设置 |
| 审批超时 | 30 min → rejected | `approvals.ts` |
| 监控退避 | `interval × 2^(n-1)`，封顶 30 min，3 连败降级 | `monitor.ts` |
| 对话页轮询 | 2 s | `chat-page.tsx` |
| 抽屉轮询 | 3 s | `drawer.tsx` |
| AG-UI 单 run 上限 | 10 min | `agui.ts` |
| 工作区 registry 等待 | 5 s（异步 init） | `butler.ts` |

## 5. 与其他文档的关系

- 决策与边界：[ADR-011](../decisions/ADR-011-butler-conversation-layer.md)（D1–D11）。
- 模块规格与任务清单：[resident-design](resident-design.md) §2–§13。
- 实施与验收：[implementation-plan](../implementation-plan.md) §S7；证据记录：[progress-report](../progress-report.md) S7-B 段。
