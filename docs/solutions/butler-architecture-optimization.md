---
title: 管家架构优化建议：对齐《个人智能体的本质》设计公理
summary: 将《个人智能体的本质》调研报告提炼的六条设计公理逐条对照 HiBuddy 现行架构（resident/coworker/web-ui + dsh 底座），给出 O1–O9 共九条具体优化建议——最大缺口是长期记忆内核与 grant 持久化审计；其余为审批可逆性维度、出站三模式契约、每日简报、MCP 接入评估、模型路由确定性与可靠性护栏；不含已定决策的推翻项，全部为增量演进。
keywords: [架构优化, 设计公理, 长期记忆, 审批分级, 可逆性, HITL, 每日简报, MCP, 可靠性护栏]
status: draft
date: 2026-11-12
---

# 管家架构优化建议：对齐《个人智能体的本质》设计公理

> 依据：[personal-agent-research.md](../references/personal-agent-research.md) §8 六条设计公理（含 §6 设计原理、§7 本质论述的证据支撑）。对照现状以 [butler-detail-design](../module-design/butler-detail-design.md)、[resident-design](../module-design/resident-design.md)、[ADR-011](../decisions/ADR-011-butler-conversation-layer.md)、[ADR-012](../decisions/ADR-012-workspace-watch.md)、[progress-report](../progress-report.md) 各阶段缺口清单为准。本文为优化建议（方案文档），凡涉及新决策的事项标注「需立 ADR」，不与既有 ADR 冲突。

## 1. 公理与现状对照

| # | 设计公理（报告 §8） | HiBuddy 现状 | 判定 |
|---|---|---|---|
| A1 | 以 harness 为产品本体，模型层可替换 | dsh 底座 + 五 bundle 装配 + BYOK 多 Provider，模型与 harness 解耦已成立 | **达标**（遗留：模型路由优先级未核对，见 O8） |
| A2 | 记忆四问先行（写入权/可见性/可删除性/时间建模） | D14「确定性上下文组装，不靠模型记忆」只解决了**每轮当下**；跨会话用户画像/偏好/事实的长期记忆层**不存在**——`situation.ts` 快照无记忆段，worker 会话记忆随会话丢弃 | **最大缺口**（O1、O2） |
| A3 | 主动性走确定性优先路线 | scheduler/monitor/workspace-watch 四类事件源确定性产出 + 管家决策（P6/D4）+ 观察模式默认 + 免打扰窗，与报告结论同构 | **达标**（缺「周期复盘」形态，见 O6） |
| A4 | 审批分级即信任曲线 | S3 已有 L0/L1/L2 分级、免再询 grant、3 连拒 stop-and-ask；D9 管家代管 | **部分达标**（grant 不持久、审计无语义区分、分级缺可逆性维度，见 O3、O4） |
| A5 | 栖身既有入口 + 标准协议接入工具生态 | 桌面/Web 双端同 profile + `/agui` 桥，入口层达标；工具面 8 件自研，无外部生态接入面 | **部分达标**（O7） |
| A6 | 执行与陪伴正交 | persona 已有；陪伴人格未进任务架构 | **达标**（设计纪律，无需改动） |

报告 §6.6 的可靠性/成本约束（可靠性数学、信任鸿沟、常驻成本）对应 O9。

## 2. 优化建议清单

优先级：P1 = 直接补本质四要素缺口，建议下一阶段纳入；P2 = 增强项，按阶段排入；P3 = 需先行查证再立项。

### O1 长期记忆内核（P1，最高优先级）

**依据**：报告 §7.2——「记忆是个人智能体区别于所有无状态系统的本体论基础」；ClawNet「记忆是 agent 真正认识其主体的基底」。当前 D14 原则仍成立：**记忆作为确定性上下文组装的输入段**，而非模型自由回忆——这是对报告结论的正确工程化，缺的只是记忆本体。

**改动**（`packages/resident/src/`）：

1. **schema v6 新增 `memories` 表**（`store.ts`）：`id`、`scope`（preference / fact / goal / procedural）、`content`、`source`（user-stated / inferred）、`source_ref`（来源 message-id / ticketId）、`confidence`、`created_at`、`learned_at`（**双时态**：写入时间 vs 事发时间，对照 Zep Graphiti）、`status`（active / superseded / removed）、`superseded_by`、`idempotency_key`。
2. **写入路径两条**（`butler-tools.ts` 新增 `save_memory` / 系统侧提炼）：
   - 用户显式陈述：对话中「记住…」→ 管家调 `save_memory`，`source=user-stated`；
   - 系统推断：回执/边沿事件后管家单轮提炼，`source=inferred`、低 confidence，**默认仅入账本不打扰**（与观察模式同纪律）。
   - 写入权默认用户主导——直接回应报告实证「96% 的记忆由系统单方写入」（[Algorithmic Self-Portrait]）。
3. **读取路径**（`situation.ts`）：快照增「记忆段」——按 scope 分组、active 且 top-N、含相对时间标注；`renderInbound`/快照契约同步更新（persona 增补一条：记忆与信封/快照冲突时以信封/快照为准，扩展既有信任契约行）。
4. **冲突进化**（对照 A-Mem）：新记忆与旧记忆指纹冲突时 `supersede`（旧条置 superseded、链可查），同指纹幂等。

**验收**：契约测试（写入/冲突/幂等/双时态）；真机——用户陈述偏好 → 新轮次快照记忆段可见；更新偏好 → superseded 链可查。

### O2 记忆治理：可见性、可删除性、敏感边界（P1，与 O1 同批）

**依据**：报告 §6.1「记忆设计必须同时回答记得准吗和记得合法吗」；LUNAR「高个性化模型常落入隐私攻击区域」。

**改动**：

1. **可见性**：`api.ts` 增 `GET /resident/api/memories`；任务抽屉（`client/drawer.tsx`）设置页增记忆列表（scope/来源/时间/状态）。
2. **可删除性**：`POST /resident/api/memories/remove` 置 `status=removed` 保留 tombstone（满足审计）；对话内「忘掉 X」→ `forget_memory` 工具同路径。
3. **敏感边界**：记忆写入入口按内容类别做确定性拦截（健康/财务/凭据类默认拒绝入记忆，或降级为需用户逐条确认）——确定性规则放 `memories` 写入口，不靠模型自觉。
4. **审计导出**：复用 FR-08 口径，memories 表纳入导出范围。

### O3 grant 持久化与语义级审计（P1）

**依据**：报告 §6.4 渐进信任与纵深防御——受托是渐进演进的信任关系，审计是信任的前提；S3 缺口清单已登记此局限。

**现状缺口**（[progress-report S3](../progress-report.md)）：grants 表在 coworker 进程内、会话级、**进程退出即失**；`approval/decided` 无法语义区分「人工批准 / 免再询代答 / 管家代管代答」。

**改动**：

1. grants 迁入 resident store（SQLite）：作用域（会话×工具×等级）+ 过期时间 + 来源标记（user / butler-proxy / auto-grant）+ 留存策略；
2. 代答留痕：answerer（coworker）与管家代管（`approvals.ts`）在决策路径补语义标记——dsh SessionEvent `data` 可扩展则经 meta 注入并登记覆盖行（ADR-005 纪律），不可扩展则经插件独立事件通道补注（**以 node_modules .d.ts 为准核对面能力**）；
3. grant 生命周期与 TicketRun 关联可查（哪次代答放行了哪步操作）。

**验收**：进程重启后 grant 仍生效且可查；真机一次代答在审计链中可区分三种决策来源。

### O4 审批分级增加可逆性 / 影响面维度（P2）

**依据**：Claude Code 四原则之「以可逆性加权评估风险」（报告 §6.4）；Cowork「误耗 11GB 文件」与 Amazon v. Comet 两案证明审批分级是硬需求。当前 `grading.ts` 只按工具类型（L2={bash,pwsh}、L1 写、L0 读），**不可逆动作与可逆写同权**。

**改动**（`coworker/src/grading.ts` + `resident/src/approvals.ts`）：

- 分级函数增两维：**可逆性**（可逆 / 难逆 / 不可逆：删除、外发、支付类）× **影响面**（工作区内 / 工作区外 / 系统级）；
- 矩阵结论钉死为契约测试：`不可逆 ∧ 影响面受控` → 强制 L2 级人工批准；`不可逆 ∧ 工作区外/系统级` → **deny-first，仅人工单次批准，管家不得代管、grant 不可覆盖**；
- D9 代管范围随之收窄表述为「可逆且影响面受控」——与报告「风险联动的自主性」（检测到高风险即交还控制权更利于信任）一致。

### O5 出站交互三模式契约化（P2）

**依据**：LangChain ambient agents 的 HITL 三模式 notify / question / review（报告 §6.2）——「何时、如何与人类交互」是常驻 agent 的核心设计问题。现状 kind 体系语义接近但未显式成契约。

**改动**（`domain.ts` + `messages.ts` + `client/chat-page.tsx` + persona）：

1. 在 Message `data` 增 `interaction` 标记，三种显式语义：
   - **notify**：纯告知，不需回复，UI 可折叠；
   - **question**：阻塞等待用户输入，计入 unanswered（`edge.ts` 未答提醒仅对 question/review 生效）；
   - **review**：高风险决策，必须人工答复，**管家不得代管、UI 锁输入直至决策**（与 O4 矩阵联动）；
2. persona 契约增补：出站必须声明 interaction 模式，未声明按 notify 处理；
3. 免打扰窗规则细化：notify 窗内折叠静默、review **不受免打扰抑制**（高风险决策窗内仍须即时触达）。

### O6 每日简报：周期复盘形态（P2）

**依据**：ChatGPT Pulse / Gemini Daily Brief 是 2025–2026 主动性产品化的标准形态（报告 §4.2）；Generative Agents 的 reflection（观察→反思→计划）循环（报告 §5.7）。HiBuddy 已有事件驱动主动性，缺「周期性综合复盘」。

**改动**：

- 新增 SourceKind `daily-review`（`sources.ts`）：每日一次确定性触发，复用 scheduler cron 基建，产出 Trigger 走既有两级过滤——编排层零改动（ADR-012 同款纪律）；
- assessment 会话指令 = 汇总昨日 TicketRun / 回执 / 边沿事件 / 记忆变更（O1 落地后）→ 生成简报经 **notify** 出站；单轮、只读或无工具，成本可控（对应报告「确定性触发 + 大模型单轮介入」）；
- 免打扰窗顺延到窗后首时点。

**验收**：真机每日触发一条简报；无事项时输出「今日无事」而非沉默（可见性即信任）。

### O7 工具生态接入评估：MCP（P3，先查证再立项）

**依据**：报告 §5.6/§7.3——MCP 已 Linux-Foundation 化成为「连工具」事实标准；个人智能体应以标准协议接入工具生态而非自建私有接口。

**改动**：

1. 查证 dsh 0.2.1-rc.5 是否内置 MCP client（以 node_modules `.d.ts` 为准，thirdparty 对照）；仅作机制对照不作依据；
2. 若内置：profile patch 声明 MCP servers **白名单**（Goose 式治理，报告 §5.4），管家/worker 共享，工具面增量不进 8 件核心面；
3. 若未内置：评估自写 MCP client 插件成本 vs 等待 dsh 官方支持，**需立 ADR**（涉及依赖面与升级纪律）。

### O8 模型路由确定性（P1，小改动）

**依据**：A1「模型可替换」必须同时「可预测」；报告 §6.6 成本约束。

**现状缺口**（B5/B12′ 真机登记）：monitor/worker 会话 `agentDefaultModel.currentSelection()` 在用户环境存在 `DEEPSEEK_API_KEY` 时解析到 deepseek-official/deepseek-flash，与 profile `agent-default-model → minimax-cn` patch 的优先级关系未核对——**后台任务的模型与成本实际不可预测**。

**改动**：真机核对优先级；在 butler/worker/monitor 会话装配处显式钉住模型选择（meta 记录 `agentPreset` 之外的 resolved model）；结论登记入 ADR-005 升级核对清单。

### O9 可靠性与成本护栏（P2）

**依据**：报告 §6.6——可靠性数学（20 步 × 95% ≈ 36%）、Project Vend「仍会犯灾难性错误」、63% 用户拒绝完全自动驾驶；§6.2「ambient agent 未必完全自主」。

**改动**：

1. **预算护栏**：TicketRun 增轮次上限与工具调用上限，超限 → `stopped(需人工接管)` 状态迁移 + notify 出站——防止周期票失控循环（状态机仍只由既有驱动方扩展，遵守 D5）；
2. **review 硬编码**：O4 矩阵中的不可逆动作不走任何免再询 / 代管路径（deny-first）；
3. **容量基线登记**：monitor/assessment 会话同会话串行排队、单轮 30–60s——在登记处注明并发上限与扩容条件（评估会话池或按来源分会话），避免无基线扩容。

## 3. 与既有决策的关系

| 决策 | 关系 |
|---|---|
| ADR-011（D14 确定性感知） | **不推翻**：O1 将记忆作为快照的确定性输入段，强化而非违背「不靠模型记忆」 |
| ADR-012（编排层零改动） | **遵守**：O6 复用 SourceKind 框架，编排层零改动 |
| ADR-005（升级纪律） | **扩展**：O3 的 meta 注入、O8 的模型路由结论均入覆盖行/核对清单登记 |
| D9（审批代管） | **收窄**：O4/O5 将代管范围明确为「可逆且影响面受控」，是修订而非新增 |

## 4. 需新立 ADR 的事项

1. **ADR-013（建议）：长期记忆层**——记忆 scope 分类、写入权默认策略（用户主导）、双时态建模、敏感类别拦截规则；
2. **ADR-014（待查证后决定）：MCP 接入**——dsh 内置则仅 profile patch 白名单（不立 ADR，走 patch 登记）；未内置再评估自建插件。

## 5. 建议排期与依赖

```
P1（下一阶段）  O8（模型路由，半天级） → O3（grant 持久化） → O1+O2（记忆内核+治理，schema v6）
P2（随后阶段）  O4（可逆性矩阵） → O5（三模式契约） → O6（每日简报，依赖 O1） → O9（护栏）
P3（查证后）    O7（MCP 评估）
```

依赖说明：O6 依赖 O1（简报需记忆变更段）；O5 的 review 模式依赖 O4 的矩阵定义；O3 与 O1 同为 schema 变更，建议合并一次 v6 迁移。
