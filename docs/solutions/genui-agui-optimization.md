---
title: 生成式 UI 与 AG-UI 优化方案（借鉴 OpenMuse，不引入 JEV）
summary: 在 ADR-007「组件指令」路线内做增量优化——借鉴 OpenMuse 的 AG-UI 用法（REST 快照 + 事件流双通道、线程恢复序、按需拉取）与 JEV 的契约细节（revision 防过期交互、来源溯源、严格 schema），不引入 JEV 领域模型、不更换产出格式：G1 指令 schema 增 revision/严格校验/来源声明、G2 交互回传统一文本契约 + 宿主过期校验、G3 render_ui 指令持久化并按 id+revision 拉取、G4 生成式 UI 进入管家层（指令引用经附件机制入账本 + AG-UI Markdown 下发）、G5 生态前端接入序文档化；分三阶段落地，含影响文件与验收标准
keywords: [生成式 UI, 组件指令, render_ui, AG-UI, 管家层, revision, 交互回传, 按需拉取, 附件引用, OpenMuse, 方案, solutions]
status: draft
date: 2026-11-12
---

# 生成式 UI 与 AG-UI 优化方案（借鉴 OpenMuse，不引入 JEV）

> 依据：[OpenMuse 调研](../references/openmuse-research.md)（AG-UI 用法与可借鉴机制）、[ADR-007](../decisions/ADR-007-generative-ui-format.md)（组件指令路线，本文在其 §3.2/§3.4 基础上做增量）、[ADR-011](../decisions/ADR-011-butler-conversation-layer.md)（管家层收敛）、[butler-detail-design §11.3](../module-design/butler-detail-design.md)（AG-UI 管家层现状）。
> 状态：draft（待评审；通过后登记 `docs/README.md` 正表并排入实施计划）。

## 1. 目标与非目标

**目标**（两条线）：

1. **AG-UI 用法对齐 OpenMuse**：把"对话事件流 + 业务快照 REST"的双通道分工、生态前端接入序（快照 → run → 重连重放）正式化为 HiBuddy 的接入契约。
2. **生成式 UI 契约细化**：把 JEV 验证过的三个契约细节（revision 防过期交互、来源溯源、严格 schema）吸收进 ADR-007 组件指令格式，并打通"生成式 UI 在管家形态下的出口"。

**非目标**：

- **不引入 JEV**：不搬 its 选择面板领域模型、`present_choices` 工具与 TypeSafe 判定链——只借鉴契约思想，落到既有 `render_ui` schema。
- 不更换 ADR-007 产出格式（不搞 iframe 代码沙盒、不搞自由组件树）。
- 不替换 HiBuddy 自家前端的账本自绘（继续走 `/resident/api/*`）。
- 不引入 CopilotKit runtime 到产品内（生态消费仍走纯 AG-UI 端点）。

## 2. 现状与缺口

| 现状 | 缺口 |
|---|---|
| `render_ui` 工具执行体为 no-op（指令仅回显），指令只活在会话事件流与 session JSONL 中 | 无按需拉取面：AG-UI 生态前端与账本 UI 都拿不到"指令 JSON"的独立引用 |
| 画布有"同 id 更新版本 +1"（client 半内存）；**内嵌组件无版本概念** | 旧指令的交互按钮始终可点（无防过期机制），回传载荷只含"约定包裹文本"，宿主无法校验是否过期 |
| 交互回传 = 自由包裹格式文本经 `conversation.send` | 格式未契约化、无宿主校验点；生态前端（无法调 conversation.send）没有等价回传路径 |
| 指令 schema 校验为客户端容错解析（部分 JSON 渐进渲染） | strict 边界（枚举/数量上限）未显式契约化、无独立测试锚点 |
| 管家 preset 工具面 8 件**不含 `render_ui`** | 管家形态下用户主对话没有生成式 UI 出口（S4 的 render_ui 只挂在普通会话） |
| `/agui` 只透出 `TEXT_MESSAGE_*`；`/agui/debug` 全量 `TOOL_CALL_*` | 生态前端既看不到生成式 UI，也没有"断线重连后恢复现场"的文档化路径 |

## 3. 借鉴映射（OpenMuse → 本方案）

| OpenMuse 机制 | 本方案落点（不引入 JEV） |
|---|---|
| JEV strict schema + 上限 + 来源必须出自本轮读取（`packages/domain/src/jev.ts`） | G1：`render_ui` schema 增 strict 校验、数量上限、`provenance` 来源声明字段 |
| CAS revision 保证仅最新面板可点（`jev/service.ts`） | G1/G2：指令增 `revision` 字段；回传载荷带 `uiId+revision`，宿主校验过期即拒 |
| 选择回传 = 一条用户消息由 server 改写续跑（`engine/conversation.ts`） | G2：交互回传统一为**文本回传**——自家前端走 `conversation.send`，生态前端走 `POST /agui`（同一宿主校验点） |
| 工具卡消息只存 ID、详情按需拉取（`thread-artifacts.tsx`） | G3/G4：指令持久化（`ui_instructions` 表），消息/AG-UI 只带引用，前端按 `id` 拉取渲染 |
| REST 快照 + AG-UI 事件流双通道、`connectAgent` 重放 + `RUN_ERROR` 降噪 | G4/G5：账本快照（已有 `/resident/api/messages`）作为生态前端恢复现场的数据面；接入序写入文档 |
| CopilotKit `AbstractAgent`/`HttpAgent` 双后端 | 不采纳（HiBuddy 无第二 agent 后端需求）；登记为生态阶段候选 |

## 4. 优化项设计

### G1 指令 schema 增量（ADR-007 §3.2 扩展，向后兼容）

```jsonc
{
  "id": "ui-<shortid>",
  "revision": 3,                  // 新增：同 id 每次更新 +1（画布与内嵌统一）；缺省视为 1（旧指令兼容）
  "target": "inline" | { "canvas": {...} },
  "component": "chart" | "form" | "table" | "metrics",
  "props": { },
  "data": { },
  "provenance": "来源：本轮读取的 sales.csv（工具 get_file）",  // 新增可选：一句话来源声明
  "summary": "人类可读一句话"
}
```

- **strict 校验契约化**：指令解析增加显式 schema 校验（组件枚举、数量上限——form 字段 ≤20、table 行 ≤100、chart 系列 ≤8，实施时可调）；校验失败照既有降级路径渲染 `summary` + 数据表格化。校验器独立成模块并配单测锚点（借鉴 JEV "strict、1-12 选项"的纪律）。
- **provenance 语义**：软约束（persona 指令要求"data 须来自本轮工具结果"，声明写入 provenance）；降级渲染与画布历史回看时展示——不做强校验（避免宿主读不懂数据语义），与 JEV"引用必须来自本轮原文"的思想对齐但实现成本可控。

### G2 交互回传契约（统一文本 + 宿主过期校验）

- 回传统一为结构化文本（保持 `conversation.send` 单一通道，不新增协议）：

```text
@[ui:<id>:<revision>] {"component":"form","event":"submit","payload":{...}}
```

- **宿主校验点**：`render_ui` 执行体记录 `id → 最新 revision`（内存 + 持久化见 G3）；会话收到 `@[ui:…]` 开头的 queued turn 时，宿主比对 revision——**过期则不投递给模型**，改为对用户可见的轻提示（"该界面已更新，操作未生效"），防旧面板点击产生错误指令（JEV CAS 思想，实现在指令层而非领域层）。
- 生态前端等价回传：同一文本格式经 `POST /agui` 发送，进入管家会话下一轮——**自家前端与生态前端共用同一契约与同一校验点**。

### G3 指令持久化与按需拉取（借鉴"只存 ID、按需拉取"）

- `render_ui` 执行体（host 半）将指令写入 `ui_instructions` 表（resident SQLite，schema v6）：`id、revision、component、props/data JSON、provenance、summary、session_id、created_at`；同 id 更新保留历史 revision（画布"可回看历史快照"从内存落到持久层）。
- 新只读端点：`GET /resident/api/ui-instruction?id=<uiId>&revision=<n>`（缺省最新；同一信任栅栏）；**消息与 AG-UI 只带引用，不内联大 JSON**。

### G4 生成式 UI 进入管家层（形态出口）

- **`render_ui` 加入 `hibuddy-butler` 工具面**（第 9 件）：执行体 no-op 性质不变（无文件/网络/代码执行），ADR-007 §3.5 沙盒论证不变；这是对 ADR-011 D2（"send_message_to_user 是唯一出站通道"）与 D6（工具面清单）的**增补**，实施前需在 ADR-011 追加修订记录（或以本方案验收代替，评审时定）。
- **账本透出**：`render_ui` 落库后自动写一条出站消息引用——复用**附件机制**：attachment 行 `kind: 'ui'`、`name = summary`，读取路由即 G3 端点。零新消息 kind、零新路由模式；对话页气泡内按 kind='ui' 渲染注册表组件（client 复用 @hibuddy/web-ui 的信任组件注册表，依赖方向 `resident/client → web-ui/client 组件模块`，登记到依赖清单）。
- **AG-UI 透出**：出站消息带 `kind='ui'` 附件 → 沿用既有"附件随文本下发为 Markdown"机制：`[summary](/resident/api/ui-instruction?id=…)`。生态前端可拉 JSON 自行渲染（AG-UI 事件面零新增）；交互回传走 G2 文本契约。
- worker 会话保留既有 `render_ui`（其自身会话视图不受影响）；**worker 产出的指令是否也引用进管家账本**（任务结果面板化）列为开放问题 #3，首批不做。

### G5 生态前端接入序（文档化契约，借鉴双通道 + 重放降噪）

`docs/references/ag-ui-research.md` 增补"HiBuddy 接入序"一节：

1. `GET /resident/api/messages` 取最近 200 条快照（含 out/text 与 ui 引用）恢复现场；
2. `POST /agui` 发起 run（并发 409 → 稍后重试）；
3. 断线重连：重新拉快照 + 以新 runId 继续；快照中的历史出站行**只渲染不重复计数**（对应 OpenMuse `RUN_ERROR` 降噪）；
4. 交互回传：`@[ui:…]` 文本经 `POST /agui`（G2 契约）。

## 5. 影响文件

| 文件 | 变更 | 阶段 |
|---|---|---|
| `packages/web-ui/src/render-ui-tool.ts` | schema strict 校验器 + revision/provenance 字段 + 宿主 revision 登记与回传校验 | P1 |
| `packages/web-ui/src/client/*`（toolview/画布） | revision 判定交互有效性、provenance 展示 | P1 |
| `packages/resident/src/store.ts` | schema v6 `ui_instructions` 表 | P2 |
| `packages/resident/src/butler-tools.ts` + `butler.ts` | render_ui 工具（第 9 件）+ 指令落库 + 自动写 `kind='ui'` 附件出站 | P2 |
| `packages/resident/src/api.ts` | `GET /resident/api/ui-instruction` | P2 |
| `packages/resident/src/client/chat-page.tsx` + 复用 web-ui 组件注册表 | 气泡内 `kind='ui'` 渲染 | P2 |
| `packages/resident/src/butler.ts`（泵） | `@[ui:…]` 回传文本的 revision 校验 | P1 |
| `docs/references/ag-ui-research.md` | G5 接入序一节 | P3 |
| `cordis.patch.yml` | persona 增补 render_ui 使用与 provenance 纪律 | P2 |

## 6. 阶段划分与验收

| 阶段 | 内容 | 验收（可判定） |
|---|---|---|
| P1 契约强化 | G1 strict 校验 + revision/provenance；G2 回传契约 + 宿主过期校验 | 校验器单测（畸形指令降级 summary）；旧 revision 回传被拒且用户可见提示；新格式 E2E（提交表单 → 下一轮模型可引用 payload） |
| P2 管家层出口 | G3 持久化 + 端点；G4 render_ui 入管家面 + 账本引用 + 气泡内渲染 | 对话中让管家产图表 → 气泡内渲染可交互；`ui_instructions` 历史版本可回看；重启后引用仍可拉取；A5 三条阻断用例回归通过 |
| P3 生态对齐 | G5 接入序文档 + AG-UI Markdown 下发验证 | CopilotKit/HttpAgent 客户端按接入序完成"快照 → run → 重连 → 交互回传"闭环真机验证 |

每阶段按既有纪律：契约测试全绿 → 真机证据入 progress-report → 按任务粒度提交。

## 7. 安全与边界复核

- `render_ui` 仍是 no-op 数据工具：指令为纯 JSON 数据，信任组件渲染，A5 阻断用例面不变；strict 校验进一步收窄畸形输入面。
- `ui-instruction` 端点只读、同一信任栅栏；指令引用经附件 id 访问，无路径参数。
- 回传校验点在宿主：过期/伪造 revision 的回传不进模型上下文——防"旧面板/注入文本伪装交互"的越权引导。
- AG-UI 面收敛不破坏：仍只透出管家一个 agent，`TOOL_CALL_*` 不出网（指令以引用/Markdown 透出）。

## 8. 开放问题

1. ADR-011 D2/D6 增补形式：ADR 修订记录 vs 本方案验收即视为生效（评审定）。
2. `revision` 校验的持久性：宿主内存态重启丢失后，旧回传是否放行（建议：以 `ui_instructions` 最新 revision 为准，持久化后天然解决）。
3. worker 产出的 UI 指令是否引用进管家账本（任务结果面板化）——涉及"worker 过程可见性"边界，首批不做。
4. 组件注册表跨包复用方式：`resident/client` 直接 import `web-ui` 组件模块 vs 抽独立 `@hibuddy/ui-registry` 包（P2 实施时定，倾向前者，避免新包）。
5. 生态前端交互体验：CUSTOM 事件透出指令（替代 Markdown 链接）是否值得——P3 真机后再评估。
