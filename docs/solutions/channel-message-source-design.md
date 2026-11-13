---
title: 渠道消息事件源接入管家设计
summary: 四个 IM 渠道插件（飞书/钉钉/微信/QQ）入装配后，渠道消息如何自动推送到管家——宿监听 session/event 抽取入站消息落消息账本唤醒管家泵，管家轮次自行研判；60s 低频对账兜底；幂等键三路收敛；不接管渠道直聊、不回写渠道
keywords: [渠道, channel, 推送, session/event, 消息账本, 管家, AgentLoop, 飞书, 钉钉, 微信, QQ, prompt injection]
status: draft
date: 2026-11-13
---

# 渠道消息事件源接入管家设计

> 依据：[ADR-011](../decisions/ADR-011-butler-conversation-layer.md)（管家是唯一 AgentLoop、消息账本为唯一用户面）、[resident-design §4 事件源框架](../module-design/resident-design.md)、[ADR-012](../decisions/ADR-012-workspace-watch.md)（事件承担及时性、扫描承担正确性的分层哲学）、**dsh-superagent-prototype 飞书源**（thirdparty/dsh-superagent-prototype/src/sources/feishu-loops.ts，三通道机制权威）。
> 状态：draft（2026-11-13，**v3 推送架构重写**）。v2 的"channel SourceKind + 轮询 + 两级过滤"方案经用户纠正后废弃：**渠道消息必须自动推送给管家，而不是管家轮询去取；管家自身就是完整的 AgentLoop，可接受 follow-up / steering**——消息直进管家轮次，不经 Trigger/FilterPipeline/独立研判层。C1 已按 v3 实施并通过全部单测。

## 1. 背景与定位

2026-11-13 已将四个 dsh 社区渠道插件写入 profile 装配（`profile/hibuddy/package.json` bundles，版本精确钉死，boot 验证全绿）：

| 插件 | 版本 | 连接方式 | 凭据/配置入口 | 初始态 |
|---|---|---|---|---|
| `dsh-lark-channel` | 0.0.7 | 飞书开放平台长连接（无公网回调） | 扫码创建应用或 `LARK_APP_ID`/`LARK_APP_SECRET` env | 缺凭据优雅待配置 |
| `@dingtalk-real-ai/dsh-dingtalk` | 0.10.2 | 钉钉 Stream 连接 | `npx … setup` 引导（写凭据+profile） | 缺凭据 skipped |
| `dsh-channel-wechat` | 0.2.8 | 腾讯 iLink / ClawBot（PC 微信扫码） | GUI 插件页扫码登录 | 待扫码 |
| `dsh-onebot-qq` | 0.10.0 | OneBot 11 / NapCat WebSocket | profile cordis.patch.yml config（mode/host/port/accessToken） | **disabled**（reverse 空 token 拒启，M0 安全） |

**定位必须先说清**：渠道插件是 dsh 生态的**独立 agent 面**——每个聊天各自驱动一个持久 agent 会话，自带审批卡、斜杠命令、权限预设。它们不是管家的组件，管家也不接管渠道直聊。本设计解决的唯一问题是**管家感知**：渠道会话里的入站消息如何**自动推送**进管家的对话，让管家在下一轮次里自行研判（转告用户 / `create_session` 建票 / 忽略）。

与 resident-design §2 裁剪条款的关系：多源订阅扇出、跨身份映射、**渠道回写**仍属裁剪项，本设计不推翻——只做单向感知，管家对用户的回复只走对话界面（微信式账本）。

## 2. 渠道插件机制事实（实测，2026-11-13）

推送的前提是能**识别渠道会话**。各插件会话 id 派生规则实测如下（来源：安装树 lib 源码）：

| 渠道 | 会话 id 派生 | 稳定前缀 | 附加锚点 |
|---|---|---|---|
| wechat | `channel-wechat-<escapedPeerId>[~g<N>]`（`~g` 为会话代次，`/new` 递增；index.js:4588/4666） | `channel-wechat-` | 配置项 `cwd` 在会话创建时写入 header 且不可变 |
| lark | `lark-<key>`（`SESSION_PREFIX = "lark-"`，key 按 chat/topic/workspace scope 派生；index.js:3250/3288） | `lark-` | 群聊 `requireMention` gating（默认 true） |
| onebot | `onebot-<chatId>`（仅保留 `[A-Za-z0-9-]`；chat.js sessionIdForChat） | `onebot-` | `agentPreset`/`workspacePath` 可配；admin/member 分档 |
| dingtalk | `sessionId(randomUUID())` + conversationId→session resume 映射（bridge.js:94-116） | **无稳定前缀** | 订阅须显式提供 session id（工具提示已声明） |

**入站消息辨认**（dsh-session / dsh-llm 已核实）：渠道插件把平台消息经 `createUserMessage` 投进自己的会话，落为 `user/message` 事件，其 data（UserMessage）含 `{ id, content, source: { kind: 'user' } }`；合成注入（文件通知、skill 内容等）的 source.kind 是其他值。**入站判定 = `type === 'user/message'` 且 `source.kind === 'user'`**——管家不会把渠道 agent 的内部合成内容当成"人类说了话"。

装配层注意（已处理，登记备查）：

- **junction × pnpm 相对 symlink**：宿主以 `$DSH_HOME/profiles/hibuddy`（junction）为锚解析裸包名，pnpm 对 registry 依赖建的相对 symlink（`..\..\..`）穿透 junction 后失效——S6-3 已知缺口，`scripts/sync-profile.ps1` 将相对 symlink 绝对化为 junction；**每次 pnpm install 后必须重跑**。
- **peer 副本防错位**：`pnpm-workspace.yaml` 已设 `autoInstallPeers: false`，四插件的 `@deepseek-ai/*` peer 全部链接到宿主已有同版本实例，无 registry 副本（ADR-005 版本配对纪律）。
- **onebot 初始禁用**：profile cordis.patch.yml 顶层同 id 行 `disabled: true` + config 模板；启用时按插件 README 补 accessToken 并去掉 disabled。

## 3. 总体设计：直进管家轮次的推送架构（v3）

消息本质是事件；管家是**唯一面向用户的 AgentLoop**。渠道消息不经过 SourceKind 调度、不经 FilterPipeline 两级过滤、不设独立 assessment 层——**宿把消息抽取出来直接落消息账本，账本的 `onInbound` 唤醒管家泵，管家在下一轮次拿到这条消息自行研判**。与原型飞书源同构的"推送为主、扫描兜底"双通道：

| 通道 | 对应原型 | HiBuddy 实现 | 延迟 | 职责 |
|---|---|---|---|---|
| ① 推送 | watch（`lark-cli event consume` 实时流） | 宿 `ctx.on('session/event', …)` 监听：订阅会话上出现 `user/message` 入站事件 → 立即抽取并 `postInbound` 落账本 | 秒级 | **及时性** |
| ② 对账兜底 | backfillLoop（60s 群历史补收） | 60s 低频对账：读订阅会话 `snapshotEvents(lastSeq, seq)`，补抽监听错过的消息 | ≤60s | **完整性**——停机窗口、监听器异常后的恢复；游标只是效率优化 |

机制要点：

- **事实来源**：抽取永远从会话事件流（`snapshotEvents`）读出——①只在事件到达时读一条，②按游标补读窗口；事件丢失/乱序/重复不影响正确性（ADR-012 分层哲学：事件承担及时性，扫描承担正确性）。
- **幂等键三路收敛**（原型 `feishuTriggerId = key('feishu', messageId)` 的对应物）：账本写入幂等键 `channel:<sessionId>:<messageId>`，推送、对账、重启重叠对同一条消息只落一行——**账本去重是唯一正确性防线，游标丢了也不重放**。
- **首扫基线**：新订阅首扫只记游标不投递（防历史消息轰炸）；订阅之后的消息才会到达管家。
- **无重试状态机**：兜底扫描失败下一轮自然重试；会话不在线（未创建/已回收）直接跳过，等推送或后续对账。

### 3.1 到达管家后的语义

信封以 `kind='event'`、`data.code='channel_message'`、`untrusted: true` 落账本（`refs: {sourceId, sessionId}`），正文为 ≤500 字的 preview + 订阅关注点。管家轮次内看到的是带 untrusted 声明的事件信封——**研判就是管家自己的一次普通推理**：值得转告就 `send_message_to_user`，需要执行就 `create_session` 建票（渠道文本永不直接拼接为 ticket prompt），否则忽略。管家处理中再来新消息由下一轮次消化（单轮次单飞、批量出队），follow-up / steering 天然支持——这正是"管家是完整 AgentLoop"的体现。

## 4. 账本信封与安全口径

- **载荷**：`{channel, sessionId, messageId, preview(≤500 字), untrusted: true}`——渠道文本是**不可信外部输入**，信封声明 untrusted（B12′ 事件框架既有机制），管家把它当数据不当指令。
- **不进过滤管线**：v2 的 gate/assessment 对 channel 一律**不参与**——没有 LLM 研判会话、没有 observe/auto 双态、没有 would-act 记录；行动与否由管家轮次决定，免打扰窗语义由账本既有机制承担（事件信封本来就不推送、只入队）。
- **触达不对称**：管家→用户只走对话界面；不做渠道回写（P2 裁剪不变）。
- **审批面不迁移**：渠道插件自有会话的审批由其原生卡片在渠道内处理；resident worker 的审批仍走 Web 对话界面。
- **成本可见**：渠道直聊会话与管家感知并存，会产生独立模型消耗——监控区展示各渠道会话活动计数，避免"看不见的账单"。

## 5. 订阅模型与管理

- `source_instances` 行：`{kind: 'channel', enabled, config: {channel, sessionId, name?, condition?}, cursor: {lastSeq?, lastScanAt?}}`。
- **默认零订阅**：不自动监听全部聊天（隐私 + 注入风险面最小化）。
- **管家经 `manage_channel_sources` 工具管理**（v3 新工具，挂 butler 工具集）：`list/add/remove/enable/disable`。add 不带 session_id 时按渠道前缀自动发现渠道插件会话（dingtalk 无前缀必须显式给）；add 可带 `condition`（"何时需要关注"的自然语言提示，随每条消息一起给到管家）。
- 订阅变更即时生效：桥每次投递都从 store 现读订阅行，无缓存失效问题。

## 6. 安全口径

1. **渠道文本 = prompt injection 最高风险面**：信封始终 `untrusted: true`；preview 截断 500 字；合成注入（source.kind ≠ 'user'）永不投递。
2. **订阅白名单**：未订阅会话零投递（推送与对账双路都查订阅）。
3. **首扫基线**：订阅不回放历史。
4. **行动权在管家**：渠道消息永远不会自动建票/自动执行——它只是一个事件信封，建票是管家的显式 `create_session` 调用（mandate='explicit'，origin='butler'）。

## 7. 分期

- **C1（已实施，2026-11-13）**：ChannelBridge（`packages/resident/src/channel.ts`，session/event 推送 + 60s 对账兜底）+ EventData `channel_message` + `manage_channel_sources` 管家工具 + store `deleteSource`。三前缀发现（wechat/lark/onebot）；dingtalk 需显式 session id。
- **C2**：dingtalk 会话识别适配——会话 id 为 randomUUID 无稳定前缀，候选方案：(a) 读插件状态文件的 conversationId→session 映射；(b) 真机核实其会话 header 的 cwd/preset 锚点可用性后按锚点识别。实施前真机定界。
- **C3（可选 P1，需先立 ADR）**：管家经渠道出站 API 代答/代发（推翻渠道回写裁剪，涉及身份与审批语义，本设计不做）。
- **C4（可选）**：面板可视化订阅管理（现仅管家工具管理）；"仅私聊"订阅粒度开关。

## 8. 验收标准

1. 订阅某渠道会话后，向该会话注入一条入站消息 → 推送通道秒级落账本，管家泵被唤醒并在下一轮次收到信封。
2. 同一消息重复投递（推送 × 对账 × 重启重叠）不重放——账本幂等键唯一防线；游标丢失不引发重复。
3. 未订阅的渠道会话零投递；首扫只建基线不回放历史。
4. 合成注入（source.kind ≠ 'user'）与非 `user/message` 事件零投递。
5. 监听不可用（停机/异常）期间的消息由对账兜底补齐（窗口每轮 ≤500 事件，逐轮追平）。
6. `manage_channel_sources` 五个动作可用；停用订阅双路零投递且游标保留；移除订阅连游标一起删除。
7. onebot 保持 disabled 时不产生任何投递活动。

## 9. 开放问题

- 渠道直聊会话的模型路由：渠道会话默认走宿主默认模型，是否为渠道会话单独配路由（省钱/隔离），待真机按各插件 model 配置项核实。
- 群聊噪音：lark requireMention / onebot @gating 已在插件侧收敛，但 @机器人 的群消息仍可能高频——订阅粒度是否需要"仅私聊"开关，C4 面板设计时定。
- 非文本消息（图片/文件）：preview 为空时信封正文占位"该消息不含文本内容"；附件类内容的抽取与展示待 C2 后评估。
