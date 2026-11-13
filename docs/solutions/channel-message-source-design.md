---
title: 渠道消息事件源接入管家设计
summary: 四个 IM 渠道插件（飞书/钉钉/微信/QQ）入装配后，渠道消息如何作为 channel SourceKind 进入管家编排层——宿侧确定性扫描订阅会话、指纹去重、untrusted 两级过滤、观察模式默认；不接管渠道直聊、不回写渠道
keywords: [渠道, channel, SourceKind, 事件源, 管家, 感知, 飞书, 钉钉, 微信, QQ, prompt injection]
status: draft
date: 2026-11-13
---

# 渠道消息事件源接入管家设计

> 依据：[resident-design §4 事件源框架](../module-design/resident-design.md)（SourceKind registry、两级过滤、观察模式）、[ADR-012](../decisions/ADR-012-workspace-watch.md)（确定性扫描为事实来源的感知源哲学）、[butler-perception-design](butler-perception-design.md)（L2 感知面扩展，IM 渠道为其列名项）、[ADR-011](../decisions/ADR-011-butler-conversation-layer.md)（消息账本为唯一用户面）。
> 状态：draft（2026-11-13）。渠道插件装配已落地并 boot 验证通过；本设计待评审后进入实施。

## 1. 背景与定位

2026-11-13 已将四个 dsh 社区渠道插件写入 profile 装配（`profile/hibuddy/package.json` bundles，版本精确钉死，boot 验证全绿）：

| 插件 | 版本 | 连接方式 | 凭据/配置入口 | 初始态 |
|---|---|---|---|---|
| `dsh-lark-channel` | 0.0.7 | 飞书开放平台长连接（无公网回调） | 扫码创建应用或 `LARK_APP_ID`/`LARK_APP_SECRET` env | 缺凭据优雅待配置 |
| `@dingtalk-real-ai/dsh-dingtalk` | 0.10.2 | 钉钉 Stream 连接 | `npx … setup` 引导（写凭据+profile） | 缺凭据 skipped |
| `dsh-channel-wechat` | 0.2.8 | 腾讯 iLink / ClawBot（PC 微信扫码） | GUI 插件页扫码登录 | 待扫码 |
| `dsh-onebot-qq` | 0.10.0 | OneBot 11 / NapCat WebSocket | profile cordis.patch.yml config（mode/host/port/accessToken） | **disabled**（reverse 空 token 拒启，M0 安全） |

**定位必须先说清**：渠道插件是 dsh 生态的**独立 agent 面**——每个聊天各自驱动一个持久 agent 会话，自带审批卡、斜杠命令、权限预设。它们不是管家的组件，管家也不接管渠道直聊。本设计解决的唯一问题是**管家感知**：渠道会话里的入站消息如何作为事件源进入编排层（resident-design §4），让管家"看着"渠道并在值得行动时告诉用户。

与 resident-design §2 裁剪条款的关系：多源订阅扇出、跨身份映射、**渠道回写**仍属裁剪项，本设计不推翻——只做单向感知，管家对用户的回复只走对话界面（微信式账本）。

## 2. 渠道插件机制事实（实测，2026-11-13）

宿侧扫描的前提是能**识别渠道会话**。各插件会话 id 派生规则实测如下（来源：安装树 lib 源码）：

| 渠道 | 会话 id 派生 | 稳定前缀 | 附加锚点 |
|---|---|---|---|
| wechat | `channel-wechat-<escapedPeerId>[~g<N>]`（`~g` 为会话代次，`/new` 递增；index.js:4588/4666） | `channel-wechat-` | 配置项 `cwd` 在会话创建时写入 header 且不可变 |
| lark | `lark-<key>`（`SESSION_PREFIX = "lark-"`，key 按 chat/topic/workspace scope 派生；index.js:3250/3288） | `lark-` | 群聊 `requireMention` gating（默认 true） |
| onebot | `onebot-<chatId>`（仅保留 `[A-Za-z0-9-]`；chat.js sessionIdForChat） | `onebot-` | `agentPreset`/`workspacePath` 可配；admin/member 分档 |
| dingtalk | `sessionId(randomUUID())` + conversationId→session resume 映射（bridge.js:94-116） | **无稳定前缀** | cwd = workspaceOverrides(scopeKey) ?? 默认；见 §7 C2 |

装配层注意（已处理，登记备查）：

- **junction × pnpm 相对 symlink**：宿主以 `$DSH_HOME/profiles/hibuddy`（junction）为锚解析裸包名，pnpm 对 registry 依赖建的相对 symlink（`..\..\..`）穿透 junction 后失效——S6-3 已知缺口，`scripts/sync-profile.ps1` 将相对 symlink 绝对化为 junction；**每次 pnpm install 后必须重跑**。
- **peer 副本防错位**：`pnpm-workspace.yaml` 已设 `autoInstallPeers: false`，四插件的 `@deepseek-ai/*` peer 全部链接到宿主已有同版本实例（cordis@4.0.5、dsh-agent/llm/session@0.2.1-rc.5），无 registry 副本（ADR-005 版本配对纪律）。
- **onebot 初始禁用**：profile cordis.patch.yml 顶层同 id 行 `disabled: true` + config 模板；启用时按插件 README 补 accessToken 并去掉 disabled。

## 3. 总体设计：channel SourceKind

按 resident-design §4.1 的承诺，渠道以**一个新 kind** 注册（`channel`），编排层零改动：

- **事实来源 = 宿侧确定性扫描**（ADR-012 workspace-watch 同款哲学）：不依赖各插件的内部回调/事件总线——四个社区插件没有统一的出站事件契约，宿侧耦合其内部 API 脆弱且随版本漂移。改为按间隔（默认 30s，对齐 B12′ EdgeDetector 轮询）扫描**已订阅**渠道会话的事件流（session JSONL 尾读或 `snapshotEvents`），抽取新的**入站用户消息**事件。
- **扫描游标**存 `source_instances`（重启不重放，原型 Source 规则）；**首扫基线**：新订阅会话首扫只记游标不产 Trigger（D5 同款，防历史消息轰炸）。
- **去重指纹**：`sha256(channel|chatId|messageId)` 前 16 位，宿侧确定性计算（B5 教训：指纹禁用模型自由文本）。

### 3.1 渠道适配器（channel adapter）

`channel` kind 内部按渠道注册小适配器，只做两件事：**会话识别**（前缀/锚点匹配）与**消息抽取**（从事件流辨认入站用户消息 + messageId + sender）。首批实现 wechat/lark/onebot 三个前缀识别；dingtalk 见 §7 C2。

## 4. Trigger 载荷与两级过滤

- **载荷**：`{channel, chatId, sessionId, sender, preview(≤500 字), receivedAt, untrusted: true}`——渠道文本是**不可信外部输入**，`untrusted` 透传至研判 prompt（D5 AssessmentInput 已有该字段）。
- **gate（确定性层）**：来源启停 + 去重指纹 + 免打扰窗 + **订阅白名单**（只有显式订阅的会话产 Trigger）。各插件自身的 sender allowlist / requireMention 是第一道准入，宿侧不重复实现。
- **assessment（研判层）**：channel Trigger 一律 `inferred`（外部输入绝非 explicit mandate）→ 检查会话单轮研判（B5 monitor 模式：只读 + 条件研判 + 结构化输出，无需工具），研判 prompt 必须声明载荷来自外部 IM、含不可信内容。
- **结果投递**：
  - **observe（默认）**：would-act 通知落账本（幂等键 `channel:<instanceId>:would-act:<指纹>`，B5 monitor 同款），管家在对话中向用户汇报"渠道有消息，建议……"而不行动；
  - **auto**：事件信封（in/event）入账本唤醒管家，由管家在轮次内决定转述或经 `create_session` 建票——渠道文本永不直接拼接为 ticket prompt。

## 5. 订阅模型与设置

- `source_instances` 行：`{kind: 'channel', channel, 订阅键(chatId/peerId), enabled, cursor}`。
- **默认零订阅**：不自动监听全部聊天（隐私 + 注入风险面最小化）；用户在任务抽屉「定时与监控」区显式添加订阅（选择渠道 + 会话）。
- 实例启停走 SourceKind registry 既有语义：运行中注入的新实例不 armed、宿重启后 startAll 装配（B5 已定界），管理面板变更提示重启宿生效。

## 6. 安全口径

1. **渠道文本 = prompt injection 最高风险面**：未经研判不进模型上下文（preview 只进研判会话且带 untrusted 声明）；研判结果只是信封，行动权永远在管家轮次内、且 observe 默认。
2. **触达不对称**：管家→用户只走对话界面；不做渠道回写（P2 裁剪不变）。
3. **审批面不迁移**：渠道插件自有会话的审批由其原生卡片在渠道内处理（其自有能力）；resident worker 的审批仍走 Web 对话界面，免打扰窗内落库不推送（待批不挂起）。
4. **成本可见**：渠道直聊会话与管家感知并存，会产生独立模型消耗——监控区展示各渠道会话活动计数，避免"看不见的账单"。

## 7. 分期

- **C1（本设计 P0）**：`channel` SourceKind + wechat/lark/onebot 三前缀适配器 + 扫描/游标/指纹去重 + 两级过滤（observe 默认）+ 订阅管理面板项。
- **C2**：dingtalk 会话识别适配——会话 id 为 randomUUID 无稳定前缀，候选方案：(a) 读插件状态文件的 conversationId→session 映射；(b) 真机核实其会话 header 的 cwd/preset 锚点可用性后按锚点识别。实施前真机定界。
- **C3（可选 P1，需先立 ADR）**：auto 模式 + 管家经渠道出站 API 代答/代发（推翻渠道回写裁剪，涉及身份与审批语义，本设计不做）。

## 8. 验收标准

1. 订阅某渠道会话后，向该会话注入一条入站消息 → 一个扫描周期内 Trigger 落库（指纹唯一），observe 模式产出 would-act 信封并出现在管家对话。
2. 同一消息重复扫描/宿重启后不重放（游标 + 指纹双重幂等）。
3. 未订阅的渠道会话零 Trigger；首扫只建基线。
4. 免打扰窗内仅落库不触达。
5. onebot 保持 disabled 时不产生任何扫描活动；启用后行为同上。

## 9. 开放问题

- 渠道直聊会话的模型路由：渠道会话默认走宿主默认模型，是否为渠道会话单独配路由（省钱/隔离），待 C1 实施时按各插件 model 配置项核实。
- 群聊噪音：lark requireMention / onebot @gating 已在插件侧收敛，但 @机器人 的群消息仍可能高频——订阅粒度是否需要"仅私聊"开关，C1 面板设计时定。
