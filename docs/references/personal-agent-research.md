---
title: 个人智能体的本质：产品形态、开源实践与设计原理的深度调研
summary: 系统调研 2024–2026 年个人智能体（personal agent）的商业产品、开源项目与设计理论，提炼出"持久身份 + 私有上下文 + 受托代理权 + 常驻主动性"的本质四要素论述，供 HiBuddy 产品设计参考。
keywords: [个人智能体, personal agent, 记忆系统, 主动性, 权限分级, 数据主权, agent harness, 竞品调研]
status: draft
date: 2026-11-12
---

# 个人智能体的本质：产品形态、开源实践与设计原理的深度调研

## 1. 摘要

本报告基于三路独立证据收集（商业产品、开源项目、设计理论，均经 ≥2 来源交叉验证），回答一个问题：**个人智能体是什么？**

核心结论：个人智能体不是"更强的聊天机器人"，而是一个**以单个用户为唯一委托人的、跨时间持续存在的数字受托人**。它的本质由四重关系构成：与用户的关系（受托代理权）、与时间的关系（持久身份与记忆）、与数据的关系（私有上下文的受托访问）、与世界的关系（事件驱动的常驻主动性）。产品与开源生态在 2025–2026 年完成了形态收敛：**常驻 harness + 持久记忆 + 工具/技能生态 + 分级审批**，其中"内核不是模型，而是包裹在模型外的编排与权限层"成为被反复验证的工程事实。

同时报告给出三条清醒的反面约束：可靠性数学（单步 95% 可靠的 20 步任务整体成功率仅 36%）、常驻成本与信任鸿沟（63% 的技术人员仍拒绝让 agent 完全自动驾驶），以及独立硬件/独立浏览器等脱离既有入口的形态普遍失败。这些约束划定了个人智能体产品设计的现实边界。

## 2. 研究范围与方法

- **时间范围**：以 2024–2026 年为主，追溯 2023 年的奠基性工作（Generative Agents、Voyager、AutoGPT、MemGPT）。
- **对象范围**：商业产品（Apple、Google、OpenAI、Anthropic、Amazon、硬件厂商、浏览器、通用 agent 平台、中国厂商）；开源项目（通用框架、记忆系统、个人化 agent、编码 agent、常驻/主动性 agent、协议层、学术开源）；设计理论（定义与自主性分级、记忆理论、主动性理论、权限与安全、失败与批评）。
- **来源分级**：P0（官方发布/论文/仓库）、P1（权威媒体）、P2（社区与聚合站）。关键声明均经多源交叉验证；无法验证处标注 [unverified] 或注明为公司口径。来源清单见文末。
- **检索时间**：2026-11-12。star 数、收入数据等时点数据均为检索时点值。

## 3. 概念谱系：从对话机器到个人受托人

### 3.1 三条定义线索

**工程定义（控制流归属）**。Anthropic《Building Effective Agents》给出了目前被引用最广的工程区分：工作流（workflow）是"LLM 与工具经由预定义代码路径编排"的系统，而 agent 是"模型动态主导自身流程与工具使用"的系统——分界线在于**谁掌握控制流**[cite:1]。这一定义决定了 agent 区别于 copilot 的第一要素：行动序列由模型而非代码决定。

**能力分级（行动权）**。OpenAI 的五级 AGI 分级中，L1 是 Chatbots（纯对话）、L2 是 Reasoners（人类水平解题、无工具）、**L3 才是 Agents（能采取行动的系统）**[cite:2][cite:3]。按此分级，"个人智能体"对应 L3 而非"更强的聊天机器人"——有无行动权是其成立的先决条件。

**自主性光谱（设计决策）**。LangChain 指出自主性是一个光谱，可用三个决策权刻画：谁决定每步输出、谁决定下一步、谁决定可用步骤集合[cite:4]。学术界的《Levels of Autonomy for AI Agents》（arXiv 2506.12469）进一步提出以用户角色命名的五级——operator / collaborator / consultant / approver / observer，并强调**自主性级别是刻意的设计决策，与模型能力大小、运行环境相分离**[cite:5]。这是"审批分级"最直接的理论依据：个人智能体的自主度不取决于它有多聪明，而取决于用户愿意授予多少。

业界从自动驾驶移植的 L1–L5 类比中，普遍结论是 **L3（有条件自主）是当前生产环境的上限**——这与商业产品的实际审批设计（见 §4、§6.4）互相印证[cite:6]。

### 3.2 执行代理与陪伴代理：一个正交维度

Character.AI、Replika 类产品常被混入"个人 AI"讨论，但其记忆服务于情感关系而非任务执行，且不具备工具与系统行动能力。学术研究提出"数字陪伴连续谱"：用户在陪伴与助理两种期待间流动，陪伴式拟人设计降低自我披露门槛，但带来独特的隐私管理问题[cite:7][cite:8]。本报告将个人智能体限定为**执行代理**（以代表用户完成任务为要），把"陪伴人格"视为可叠加的正交维度而非定义要件。

## 4. 商业产品全景（2024–2026）

### 4.1 系统级阵营：Apple 与手机厂商

Apple 于 WWDC26（2026-06-08）发布下一代 Apple Intelligence 与全新 Siri AI：基于"个人上下文理解"跨消息、邮件、照片检索，更大范围的系统级 App 操作，屏幕感知（on-screen awareness），并于 2026-09 正式上线[cite:9][cite:10]。其代表性设计是 **Private Cloud Compute** 三层架构——无状态计算（用户数据仅用于本次请求、不留存、Apple 员工不可见）、可验证透明（第三方可核查服务器运行的代码）、前沿安全[cite:11]。值得注意的是，新系统中的 Notify Me（Safari 监控网页变化并通知）是 Apple 少见的"巡检式"主动能力，说明系统级厂商也在向常驻感知演进。

手机厂商走得更深：vivo AgentOS 以"听懂、记住、办成事"为纲，6000+ 原子技能，端侧 BlueLM-Nano 个人记忆[cite:12]；OPPO PersonaX 主打多模态"终生记忆"与跨设备 Agent Matrix[cite:13][cite:14]；荣耀 2026-08 发布 Agentic OS 内核与系统级 Agent 架构。中国路线的共性是**记忆做进 OS、行动依赖系统接口**——设备是个人智能体最深的"身体"，但也意味着跨厂商的生态割据。

### 4.2 平台级阵营：OpenAI、Google、Anthropic

**OpenAI** 的演进路径最有信息量：Operator（2025-01，CUA 模型操作 GUI）→ ChatGPT agent（2025-07，合并 Operator 与 Deep Research，赋予虚拟计算机）→ ChatGPT Pulse（2025-09，主动调研、基于聊天与日历提供个性化每日简报）→ ChatGPT Work（2026-07，承接长任务）；而 **Atlas 浏览器于 2026-08-09 停止服务**，浏览器 agent 能力收编进 ChatGPT/Codex 与 Chrome 扩展[cite:15][cite:16][cite:17][cite:18]。记忆侧，官方"Dreaming"文章披露了显式偏好（"我吃素"）与隐式偏好（"住在旧金山"→本地化推荐）的双层记忆系统[cite:19]。这条路径显示：**对话入口 + 常驻简报 + 虚拟计算机**是 OpenAI 认定的个人智能体形态，独立浏览器形态被放弃。

**Google** 的 Project Mariner（2024-12 首发）于 **2026-05-04 作为独立产品关闭**，技术并入 Gemini Agent 与 Chrome auto-browse[cite:20]；取而代之的是 **Gemini Spark**（2026 I/O 发布的"个人 AI agent"）：宣称 7×24 后台运行、设备关机仍可工作、重要操作前先确认[cite:21]。开发者侧的 Gemini API Managed Agents 提供云沙箱、后台异步执行与远程 MCP[cite:22]。Google 同样完成了"实验形态→收编进主入口"的收敛。

**Anthropic** 的 Claude Cowork（2026-01-12，Max 研究预览）定位"Claude Code for the rest of your work"——在**用户指定的本地文件夹**内自治执行多步文档/文件工作流，并配套插件体系与 Agent Skills（渐进披露、约 100 token 元数据先给模型看）[cite:23][cite:24]。Cowork 测试中曾出现"误耗 11GB 文件"的事故（InfoQ 引述），反向证明：**授权目录沙箱 + 审批是产品硬需求，而非可选项**。

### 4.3 语音与家庭入口：Alexa+ 的艰难转型

Amazon Alexa+（2025-02-26 发布）是旧语音入口向个人智能体转型的样本：更对话化、连接 OpenTable/Uber Eats/Spotify、学习偏好与例程、**以声纹+视觉 ID 区分家庭成员**形成家庭画像[cite:25][cite:26]。但铺开缓慢（2026 年才向全美用户开放，加拿大 2026-06、日本 2026-10 才上线）[cite:27]，发布时曾遭遇滞后、错答的反噬。旧范式（Siri/Alexa）的死因被总结为：规则系统"加一个基础功能要数周"，厂商误判用途、投入难回收[cite:28]。

### 4.4 独立硬件的失败样本

- **Humane AI Pin**：$699 + 订阅，约售 1 万台（内部目标 10 万），2025-02 停服，HP 以约 $1.16 亿收购资产[cite:29]。
- **Rabbit r1**：首批 1 万台 24 小时售罄，但"代操作 App"承诺与体验落差巨大，被 Tony Fadell 点名为第一波失败的 AI 硬件；2025–2026 转向 rabbitOS intern（代码级 agent）与 OS3（记忆/上下文）[cite:30][cite:31]。
- **Limitless（原 Rewind）**：2025-12 被 Meta 收购，当日停止 Pendant 销售[cite:32]。

结构性教训是**周期错配**："硬件研发按年计、AI 进步按月计"——固化在硬件里的智能会迅速过时；而幸存者（Plaud 的录音笔记路线）均依附手机与既有入口，放弃"独立入口"幻想[cite:33]。

### 4.5 浏览器形态的兴衰

Perplexity Comet（2025-07 上线，2025-10 全量免费）、The Browser Company 的 Dia（2025-10 被 Atlassian 以 $6.1 亿收购）、OpenAI Atlas（2026-08 停服）[cite:34][cite:35][cite:18]。三个事件共同说明：**agentic browser 难以独立存续**——它要么被收购、要么免费化引流、要么收编回主产品。2025-11 Amazon 起诉 Comet 未授权访问其系统，则暴露了 agent 行动权与网站服务条款之间的法律摩擦[cite:36]。

### 4.6 通用 agent 平台与"收编"现象

Manus（2025-03 上线）8 个月 ARR 达 $1 亿（公司口径），2025-12-29 宣布被 Meta 收购，**2026-04-27 被中国发改委首次依据外商投资安全审查要求回退交易**，2026-09 恢复独立运营并发布 Manus 2.0（Cascade harness、Cloud Computer、Automations、面向个人的 Cue agent）[cite:37][cite:38][cite:39][cite:40]。Genspark Super Agent 45 天 ARR $3600 万（OpenAI 官方案例），2026-06 估值 $26 亿[cite:41][cite:42]。通用平台的商业成功证明了"替用户执行多步任务"的付费意愿，但 Manus 波折也说明个人智能体正在成为地缘与资本层面的战略性资产。

### 4.7 中国路线：系统级 + 设备端

智谱 AutoGLM（2024-10 首发手机操作 agent，2025-08 全量开放，**2025-12 开源**，适配 50+ 中文高频应用）[cite:43][cite:44]；字节将 TRAE/Coze 并入豆包、上线"豆包工作"，资源向单一入口收敛[cite:45]；月之暗面 Kimi 的 OK Computer（2025-09）与 K3 的 Agent Swarm[cite:46]；MiniMax Mavis 的 Agent Teams 多 agent 并行与**三层跨会话记忆**（用户/Agent/项目）[cite:47]。中国阵营的特点与手机厂商一致：以系统级、设备端为主战场，记忆入 OS、行动靠接口谈判。

### 4.8 产品层的横向结论

| 维度 | 已收敛的主流做法 | 反例/教训 |
|---|---|---|
| 记忆/个性化 | 对话记忆 + 隐式偏好（OpenAI）、三层记忆（MiniMax）、OS 级记忆（手机厂商）、个人上下文索引（Apple） | 静态 RAG 式记忆不足；GDPR 类个人信息被系统单方写入的风险[cite:48] |
| 主动性 | 定时简报（Pulse）、7×24 后台（Spark）、网页巡检（Notify Me）、自动化（Manus Automations） | "为每台 Alexa 持续在线一周"的云成本不可承受[cite:49] |
| 系统级控制 | App Intents（Apple）、系统接口（手机厂商）、虚拟计算机（ChatGPT agent/Manus） | 独立硬件（Humane/Rabbit）、独立浏览器（Atlas/Mariner）均失败或被收编 |
| 权限与安全 | 重要操作前确认（Spark/Atlas）、文件夹沙箱（Cowork）、PCC 可审计无状态（Apple） | Cowork 误耗文件、Amazon v. Comet：审批分级与法律摩擦是硬约束 |

**收编规律**：2025–2026 年所有"实验性独立形态"（Mariner、Atlas、browser agent、AI 硬件）均被关闭或并入主入口。个人智能体的规模化载体只能依附用户已有的最高频入口（聊天应用、操作系统、浏览器插件）。

## 5. 开源实践全景

### 5.1 框架谱系的收敛

第一代"放手让它跑"的框架（AutoGPT ~188k stars、BabyAGI、SuperAGI）已转型或休眠：AutoGPT 转向低代码平台化编排[cite:50]，BabyAGI 原版归档，SuperAGI 最后 release 停在 2024-01[cite:51]。新一代收敛于四个构件：**事件流架构 + 沙箱运行时 + 可插拔 harness + 明确权限**——OpenHands 的事件流架构（决策/沙箱/事件日志三者分离）及其 SDK 论文（Workspace 抽象可替换）是范本[cite:52][cite:53]；smolagents 用"代码即动作"替代 JSON 工具调用（HF 自测减少约 30% 模型调用）[cite:54]；Microsoft 将 AutoGen 与 Semantic Kernel 合并为 Agent Framework（2026-04 GA）[cite:55]；LangChain 的 deepagents 把 Claude Code 式模式标准化为"规划工具 + 文件系统 + 子代理"三件套[cite:56]。**纯对话编排框架正在被吸收整合**。

### 5.2 记忆系统：三条路线

2023 年 MemGPT 提出的 OS 化记忆（主上下文如 RAM、外部存储如磁盘、LLM 自行"换页"）已分化为三条成熟路线[cite:57]：

1. **agent 自编辑记忆（Letta）**：memory blocks（human/persona/knowledge）作为个人化核心载体，agent 用工具读写自己的记忆[cite:58]。
2. **时态知识图谱（Zep/Graphiti）**：双时态建模（事件发生时间 + 学习时间），公开宣言"停止用 RAG 做 agent 记忆"，在 DMR 基准上击败 MemGPT 基线[cite:59][cite:60]。
3. **OS 化记忆调度（MemOS）**：把记忆当作可调度的系统资源，用 MemCube 统一明文/激活/参数级记忆[cite:61]；A-Mem（NeurIPS 2025）受 Zettelkasten 启发，记忆条目自动互链、旧记忆被新记忆"进化"[cite:62]；mem0 以 Add/Search/Update 三操作实现冲突感知的智能更新（~41k stars，$24M A 轮）[cite:63]。

综述《Memory in the Age of AI Agents》给出统一分类学 **Forms–Functions–Dynamics**（形态–功能–动态）[cite:64]。三条路线的共同前提：**静态 RAG 不够，记忆需要时间建模与 agent 自主管理**。"memory blocks + 自主管理"是个人化的公约数。

### 5.3 个人化 agent：第二大脑与数字分身

Khoj（自托管第二大脑，索引个人文档，支持自定义 agent 与**定时任务自动化**，~36k stars）证明"个人知识库 + 主动巡检"的开源需求真实存在[cite:65]；Jan.ai 提供 100% 离线的本地底座[cite:66]；Second-Me（Apache 2.0，15k+ stars）走"mind mirror"路线——分层记忆建模（HMM）+ Me-Alignment 对齐 + 本地训练，把用户建模为可本地部署的"数字分身"[cite:67][cite:68]。

### 5.4 编码 agent：harness 设计的先行形态

个人智能体尚未有统一的成熟形态，但编码 agent 已先行验证了整套 harness 工程：

- **Codex CLI**：approval modes（Suggest/Auto Edit/Full Auto）+ 沙箱双层——沙箱定义技术边界（可写路径/网络），审批策略决定何时越界请示[cite:69]。
- **Claude Code**：Anthropic 工程博客将 agent 虚拟化为 **session（append-only 日志）/ harness（调用循环 + 工具路由）/ sandbox** 三组件可独立替换[cite:70]；其权限体系被学术逆向归纳为四原则：**deny-first + 人类升级、渐进信任谱系、纵深防御、以可逆性加权评估风险**[cite:71]。
- **Aider**：repo map（tree-sitter 抽符号 + PageRank 排序，按 token 预算渲染上下文）——大上下文的确定性组装范式[cite:72]。
- **Goose**（Block）：local-first + MCP 扩展机制 + "白名单 MCP server"做企业级权限控制，数千员工日常使用[cite:73]。

### 5.5 常驻主动性：OpenClaw 现象

**OpenClaw**（原 Clawdbot→Moltbot，Peter Steinberger，MIT）是 2026 年最重要的个人常驻 agent 开源项目：2026-10 约 393k stars，超越 React 成为 GitHub star 数最高的软件仓库[cite:74]。其设计极有代表性：单一常驻 Gateway 接 22+ 消息渠道（WhatsApp/Telegram/iMessage/Discord…）、持久记忆、`soul.md` 人格文件、16000+ 社区技能；安全哲学明示 **"trusted gateway, untrusted execution, policy enforced by code"**（网关可信、执行不可信、策略由代码强制），由基金会托管、无商业托管版[cite:75][cite:76]。同时，initrunner（cron/file_watch 触发守护进程）、open-strix（**agent 可自建定时任务**）等一批项目均采用"cron 触发 → 独立会话 → 持久状态"模式[cite:77][cite:78]。**常驻 + 多渠道 + 定时巡检已被开源社区用脚投票为个人智能体的事实形态**。

### 5.6 协议层

MCP（Anthropic 2024-11 开源）于 2025 年获 OpenAI/Google 采纳，2025-12 捐 Linux Foundation，2026-07 第五版全面无状态化[cite:79]；A2A（Google 2025-04）同年捐 Linux Foundation，150+ 组织共建[cite:80]；AG-UI 处理 agent↔前端事件流。三者分工清晰：**MCP 连工具、A2A 连 agent、AG-UI 连人**[cite:81]。协议基础设施的 Linux-Foundation 化意味着个人智能体应以标准协议三面接入，而非自建私有接口。

### 5.7 学术开源的思想遗产

- **Generative Agents / Smallville**（Stanford，2023）：25 个常驻 agent 的记忆流 + **相关性×新近性×重要性**检索打分 + reflection（反思生成高层推断）+ planning——"观察→反思→计划"循环是个人智能体主动性的直系祖先[cite:82][cite:83]。
- **Voyager**（2023，Minecraft）：自动课程（自设目标）+ **技能库（可执行代码的终身技能积累）**——不训练权重、靠代码技能库实现终身学习，直接启发了 smolagents 与 OpenClaw 的技能系统[cite:84]。

## 6. 设计原理：六个维度

### 6.1 记忆：个性化与隐私的张力

LoCoMo 基准（平均 300 轮对话）证实 LLM 在长程记忆上有明显困难[cite:85]；Locomo-Plus 进一步指出仅考事实回忆会高估能力，需考察"约束一致性"（对用户状态/目标/价值观的推断）[cite:86]。隐私侧的证据更尖锐：LUNAR 基准发现**个性化分数越低的模型隐私保护越好，高个性化模型常落入攻击区域**[cite:87]；对 ChatGPT 记忆的实证研究显示 **96% 的记忆由系统单方写入而非用户发起，28% 含 GDPR 定义的个人信息**[cite:48]。结论：个人智能体的记忆设计必须同时回答"记得准吗"和"记得合法吗"两个问题——记忆的写入权、可见性、可删除性是产品级设计而非实现细节。

### 6.2 主动性：从应答者到受托人

Stanford Generative Agents 证明了常驻 agent"醒来、观察、反思、规划"的可能性[cite:82]；2025–2026 的主动性研究（ContextAgent 用可穿戴多模态感知预测服务需求、ProAgent 分层感知、AppAgent-Pro 预判深层需求）与产品化（Gemini Daily Brief、ChatGPT Pulse、Notify Me）共同确立了模式：**主动性 = 事件流监听 + 分层感知 + 时机判断**[cite:88]。LangChain 的 ambient agents 定义将其一锤定音："ambient agent 监听事件流并据其行动"，且"ambient agents 未必完全自主，关键是想清楚何时、如何与人类交互"[cite:89]。

### 6.3 身体性与行动面

GUI agent 的基准分数两年间从 OSWorld ~12%（2025-03）涨到 66.3%（2026-03）[cite:90]，但存在**能力悬崖**：Windows Agent Arena 上 agent 19.5% vs 人类 74.5%——多步、多应用的真实工作流会击穿基准分数[cite:91]。行动面的选择也随之分化：系统级接入（App Intents、Accessibility）最深但生态封闭，GUI 操作通用但不可靠，虚拟计算机（云端沙箱）折中。硬件形态教训见 §4.4。

### 6.4 权限与审批：人格边界的工程化

收敛后的共识是三层设计：**沙箱边界（技术可行性）→ 分级审批（何时请示人）→ 白名单/插件治理（扩展面管控）**，Codex CLI、Claude Code、Goose 三者一致[cite:69][cite:71][cite:73]。LangChain 的 HITL 三模式（notify 告知不行动 / question 缺信息就问 / review 危险动作硬编码审查）把"什么时候该问人"落成了可操作的清单[cite:89]。学术证据表明，**风险联动的自主性**（检测到隐私/高风险即交还控制权）比"给用户最大控制权"更能建立信任[cite:92]。

### 6.5 隐私与数据主权

Apple PCC（无状态、可审计、员工不可见）与 local-first 开源路线（Jan、Goose、Second-Me）代表两端：前者用密码学证明"云端计算不留存"，后者用物理隔离证明"数据不出设备"[cite:11][cite:66][cite:73]。SoDA 架构（arXiv 2512.22135）将此表述为工程原则：以"数据解耦"的代理完全代表用户意图，通过 **Intent-Permission Handshake（意向-权限握手）**自主协商权限，实现认知卸载[cite:93]。

### 6.6 可靠性与成本：现实约束

- **可靠性数学**："即使每步 95% 可靠，20 步工作流成功率仅 36%"[cite:94]；Andon Labs 的 Project Vend 实验显示 agent 能完成多步商业任务但"仍会犯经济上灾难性的错误"[cite:95]。
- **信任鸿沟**：Stack Overflow 2026 调查——agent 使用率从 31% 升至 59%，但 **63% 的技术人员仍很少或从不让 agent 完全自动驾驶**[cite:96]。
- **常驻成本**：云 LLM"为每台 Alexa 持续在线一周就会让 Amazon 破产"，旧范式只能休眠等触发、错过真正重要的上下文[cite:49]。这解释了为什么主动性必须走"事件驱动 + 低成本确定性层"路线（见 §7.3），而非"全天候大模型在线"。

## 7. 论述：个人智能体的本质

### 7.1 定义

综合三路证据，个人智能体可定义为：

> **个人智能体是一个以单个用户为唯一委托人的持久数字实体，它通过持续沉淀的记忆代表用户的目标、价值观与约束，在用户授予的权限边界内、以事件驱动的常驻方式，跨情境、跨时间为用户执行与决策。**

这一定义与目前最完整的学术表述一致：Avatar Intelligence（arXiv 2611.03092，2026-11）将个人智能体描述为"a paradigm of persistent personal agents that represent users' goals, values, and constraints through sustained decision delegation across contexts and time"（跨情境、跨时间以持续决策委托来代表用户目标、价值观与约束的持久个人智能体），其衡量标准是"放大人类能动性：更少日常监督地追求目标，同时保留对重大决策的控制"[cite:97]。

### 7.2 四重关系：本质的四个维度

个人智能体的本质不在于模型能力，而在于它同时确立了四重关系——缺任何一重，产品就退化为别的形态：

```text
            （与时间）持久身份
              没有记忆 → 无状态聊天机器人
                        │
（与世界）常驻主动性 ── 个人智能体 ──（与用户）受托代理权
  没有主动性 → 被动 copilot            没有权限 → 建议生成器
                        │
            （与数据）私有上下文受托访问
              没有个人数据 → 通用 agent
```

1. **与时间的关系：持久身份与记忆**。聊天机器人的上下文随会话消失；copilot 记住工作目录；个人智能体的身份必须在时间中连续——MemGPT 的 OS 化记忆、Letta 的 memory blocks、Zep 的双时态图谱、MemOS 的记忆调度，都是"身份连续性"的工程化[cite:57][cite:58][cite:60][cite:61]。ClawNet（arXiv 2604.19211）的表述最直接："记忆不只是任务优化工具，而是 agent 真正认识其主体的基底；身份绑定是渐进的，不是配置出来的"[cite:98]。**记忆是个人智能体区别于所有无状态系统的本体论基础**。
2. **与用户的关系：受托代理权**。个人智能体拥有"代表用户"的行动权——这正是 OpenAI 分级中 L3 的门槛[cite:3]，也是审批分级存在的理由：权限边界就是受托关系的人格边界。自主性五级（operator→observer）说明受托程度是设计变量[cite:5]；Claude Code 四原则（deny-first、渐进信任、纵深防御、按可逆性加权）说明受托是渐进演进的信任关系[cite:71]。**没有代理权，它只是顾问；没有审批，它只是失控的程序**。
3. **与数据的关系：私有上下文的受托访问**。个人智能体区别于通用 agent（如 Devin）的根本在于：它的上下文是**属于某一个人的私有世界**——消息、邮件、日程、文件、偏好。这不是 RAG 数据集，而是需要受托访问的隐私对象。Apple PCC 与 local-first 路线之争的本质是"受托计算发生在谁的信任域内"[cite:11][cite:66]。96% 记忆由系统单方写入的实证[cite:48]则揭示了第三条边界：**记忆写入权本身就是数据主权问题**。
4. **与世界的关系：常驻主动性**。被动应答的系统是工具；个人智能体必须在事件流中持续存在——监听、巡检、反思、在恰当时机行动或提醒[cite:82][cite:88][cite:89]。Generative Agents 的"观察→反思→计划"循环、OpenClaw 的常驻 Gateway、Gemini Spark 的 7×24 后台，共同证明**主动性是个人智能体的存在方式而非附加功能**。

四重关系也给出了一个严格的判别式：**chatbot 缺 1、3、4；copilot 缺 2、4；通用 agent 缺 1、3 的"个人"归属；陪伴型 AI 缺 2**。

### 7.3 形态收敛：被修正的 OS 类比

Karpathy 的 LLM OS（LLM 即 CPU、上下文窗口即 RAM、工具即外设）是流行类比[cite:99]。但工程实践给出了一个关键修正——**内核从来不是模型本身，而是包裹在模型外面的编排与权限层**[cite:100]。OpenHands 的事件流架构、Claude Code 的 session/harness/sandbox 三分解、OpenClaw 的"trusted gateway, untrusted execution"都指向同一个收敛形态[cite:52][cite:70][cite:75]：

| OS 概念 | 个人智能体对应物 | 证据 |
|---|---|---|
| 内核/调度器 | harness（调用循环 + 事件流监听 + 定时触发） | OpenClaw Gateway、initrunner、deepagents |
| 内存管理 | 记忆系统（主上下文 + 外部存储 + 自主换页） | MemGPT、Letta、MemOS |
| 进程/权限模型 | 沙箱 + 分级审批 + 白名单扩展 | Codex CLI、Claude Code、Goose |
| 驱动/外设 | 工具生态（MCP 连工具、A2A 连 agent、AG-UI 连人） | 三大协议 |
| 用户账户系统 | 委托人身份与数据主权 | PCC、Second-Me、SoDA |

因此形态结论是：**个人智能体 = 在持久 harness（编排 + 权限内核）之上、以个人记忆为存储、以标准协议为外设接口、以事件流为电源信号的模型**。模型是可替换的 CPU，harness 才是产品本体——这解释了为什么模型迭代反而加速了入口收编（§4.8）：能沉淀持久资产（记忆、权限、技能、渠道）的位置才有护城河。

### 7.4 边界与反例

- **它不是"更聪明的 Siri"**：旧语音助手死于规则工程与成本[cite:28][cite:49]；新范式的分界是 LLM 驱动的开放工具调用与事件驱动主动性。
- **它不是自主机器人**：63% 的技术人员拒绝完全自动驾驶[cite:96]，L3 有条件自主是生产上限[cite:6]——个人智能体的正确默认态是"事件驱动的半自主 + 高后果动作人审"。
- **它不是通用 agent**：Devin 类产品的主体是"任务"，个人智能体的主体是"人"。两者的记忆、权限、人格设计完全不同源。
- **它难以独立成载体**：硬件（Humane/Rabbit）、独立浏览器（Atlas/Mariner）的失败说明个人智能体必然栖身于既有最高频入口[cite:29][cite:30][cite:18][cite:20]。

### 7.5 三个未解难题

1. **可靠性**：多步任务的成功率数学尚未跨越生产阈值[cite:94]，GUI 能力悬崖依旧[cite:91]——主动性越强，暴露面越大。
2. **记忆的合法性与对齐**：个性化与隐私的负相关（LUNAR）[cite:87]、系统单方写入记忆的比例（96%）[cite:48]说明"记什么、谁有权写、用户如何审计"没有行业共识。
3. **监督成本**：Avatar Intelligence 提出的 AOI 指数（交付价值 vs 运行成本 vs 人类监督负担）尚未有公认解法[cite:97]；ambient agent 的核心问题"何时、如何与人类交互"仍是开放问题[cite:89]。

## 8. 对个人智能体产品设计的设计启示

将上述证据转译为设计公理（对 HiBuddy 类"AI 管家"产品直接适用）：

1. **以 harness 为产品本体**：把工程投入放在编排、记忆、权限、事件流四层内核上，模型层保持可替换。
2. **记忆四问先行**：写入权（谁授权写入）、可见性（用户可审计）、可删除性（GDPR 式权利）、时间建模（何时学到的 vs 何时发生的）。
3. **主动性走确定性优先路线**：事件流监听 + 低成本规则层做触发与巡检，大模型只在触发后单轮介入——避免"全天候在线"成本[cite:49]，对应 LangChain"ambient agent 未必完全自主"的判断[cite:89]。
4. **审批分级即信任曲线**：按可逆性/影响面分级（deny-first、渐进信任、风险联动交还控制权）[cite:71][cite:92]，把"何时问人"设计为显式产品能力而非事后补丁。
5. **栖身既有入口**：以聊天/桌面/移动系统为宿主，用标准协议（MCP/A2A/AG-UI）接入工具生态，不自建孤立入口[cite:79][cite:80][cite:81]。
6. **执行与陪伴正交**：管家人格是可叠加维度，不作为任务执行架构的前提。

## 9. 结论

个人智能体的本质是一次**受托关系的工程化**：把"某个人在数字世界中的目标、价值观与约束"持久化为记忆，把"这个人对另一方的信任"分级化为权限，把"这个人不在场的时段"事件流化为主动性，最终形成常驻的数字受托人。2024–2026 年的产品与开源证据高度一致地收敛于同一形态——持久 harness + 记忆内核 + 协议化工具生态 + 分级审批——并在反面教训（硬件失败、浏览器收编、可靠性数学、信任鸿沟）中划清了边界。**个人智能体竞争的胜负手不在模型，而在谁能把四重关系工程化得更深、更可信。**

## Sources

1. Building Effective Agents — Anthropic. https://www.anthropic.com/engineering/building-effective-agents
2. OpenAI 五级分级（转引）. https://arxiv.org/pdf/2606.02458v1.pdf
3. OpenAI 5-Tier System — AI News. https://www.ainews.com/p/openai-introduces-5-tier-system-to-rank-ai-progress-toward-agi
4. What is an AI agent? — LangChain. https://www.langchain.com/blog/what-is-an-agent
5. Levels of Autonomy for AI Agents — arXiv 2506.12469. https://arxiv.org/pdf/2506.12469v1
6. Levels of Autonomy L1–L5 — ASDLC. https://asdlc.io/concepts/levels-of-autonomy/
7. Companion-Assistant Dynamics — arXiv 2510.15905. https://arxiv.org/html/2510.15905v3
8. Privacy Management with AI Companions — ACM. https://dl.acm.org/doi/pdf/10.1145/3772363.3798964
9. Apple Newsroom: WWDC26 下一代 Apple Intelligence 与 Siri AI，2026-06-08（P0）. https://www.apple.com/newsroom/2026/06/apple-unveils-next-generation-of-apple-intelligence-siri-ai-and-more/
10. Apple Newsroom: Siri AI is here，2026-09（P0）. https://www.apple.com/sg/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/
11. Apple Security Research: Private Cloud Compute（P0）. https://security.apple.com/blog/private-cloud-compute/
12. InfoQ 中文：vivo AgentOS（P1）. https://www.infoq.cn/article/hbZAEa6iQbq5rcUWbUi4
13. OPPO Newsroom: AI 战略（P0）. https://www.oppo.com/cn/newsroom/press/539/
14. 36氪：手机巨头 AI 底牌（OPPO PersonaX 等）（P2）. https://m.36kr.com/p/3863704272534408
15. OpenAI: Introducing Operator / CUA（P0）. https://openai.com/index/computer-using-agent/
16. OpenAI: Introducing ChatGPT Pulse，2025-09-25（P0）. https://openai.com/index/introducing-chatgpt-pulse/
17. OpenAI Help Center: ChatGPT Release Notes（Atlas 退役等）（P0）. https://help.openai.com/en/articles/6825453-chatgpt-release-notes
18. OpenAI Help Center: ChatGPT Atlas Release Notes（P0）. https://help.openai.com/zh-hans-cn/articles/12591856-chatgpt-atlas-release-notes
19. OpenAI: Dreaming — Better memory（P0）. https://openai.com/index/chatgpt-memory-dreaming/
20. AI Wiki: Project Mariner 关停（P2）. https://aiwiki.ai/wiki/project_mariner
21. Google Blog: Gemini 3.7 Flash / Spark（P0）. https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-3-7-flash/
22. Google Blog: Managed Agents in Gemini API，2026-05-19（P0）. https://blog.google/innovation-and-ai/technology/developers-tools/managed-agents-gemini-api/
23. Anthropic: Introducing Cowork，2026-01-12（P0）. https://claude.com/blog/cowork-research-preview
24. Anthropic: Agent Skills / Skills for organizations，2025-12-18（P0）. https://claude.com/blog/skills
25. Amazon: Introducing Alexa+，2025-02（P0）. https://www.aboutamazon.com/news/devices/new-alexa-generative-artificial-intelligence
26. Amazon: Alexa+ 加拿大/日本上线（P0）. https://www.aboutamazon.com/news/devices/alexa-plus-canada-launch
27. Amazon: Alexa+ 面向全美用户（P0）. https://www.aboutamazon.com/news/devices/alexa-plus-available-free-prime-members-us
28. How Siri, Google Assistant and Alexa lost the AI race — Seattle Times 转存（P1）. https://publicservicesalliance.org/wp-content/uploads/2023/03/httpsreplica.seattletimes.compopoversdynamic_article_popover.pdf
29. AI Wiki: Humane AI Pin（P2）. https://aiwiki.ai/wiki/humane_ai_pin
30. rabbit.tech: updates & changelog（P0）. https://www.rabbit.tech/updates
31. HTT News: Fadell on failed AI gadgets，2026-10-07（P2）. https://httnews.com/2026/10/07/what-we-know-about-why-first-ai-gadgets-failed-per-fadell/
32. Limitless 官网停售公告（P0）. https://www.limitless.ai/
33. Layer3Labs: Humane AI Pin Alternatives（P2）. https://www.layer3labs.io/comparisons/humane-ai-pin-alternatives
34. TechVernia: Perplexity Comet Review 2026（P2）. https://techvernia.com/pages/reviews/browsers/perplexity-comet.html
35. Atlassian IR: Completes Acquisition of The Browser Company，2025-10-21（P0）. https://investors.atlassian.com/news/news-details/2025/Atlassian-Completes-Acquisition-of-The-Browser-Company-of-New-York/default.aspx
36. 植德人工智能月刊：Amazon v. Perplexity，2025-11-04（P2）. https://www.meritsandtree.com/UpLoadFile/Files/2025/11/20/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%E6%9C%88%E5%88%8A2025%E5%B9%B410%E6%9C%88%E5%88%8A.pdf
37. Fortune: Meta buys Manus，2025-12-30（P1）. https://fortune.com/2025/12/30/meta-buys-manus-mark-zuckerberg-ai-spending-spree-china-startup/
38. Phronews: Manus un-merging from Meta（NDRC 回退）（P2）. https://phronews.com/manus-is-un-merging-from-meta/
39. AIBase: Manus 恢复独立运营（P2）. https://www.aibase.com/news/30268
40. explainx.ai: Manus 2.0 / independent，2026-09-28（P2）. https://explainx.ai/blog/manus-independent-operations-resumed-september-2026
41. OpenAI 案例研究：Genspark（P0）. https://openai.com/index/genspark/
42. AI Magazine: Genspark $2.6bn valuation（P1）. https://aimagazine.com/news/genspark-how-the-ai-workspace-hit-at-us-2-6bn
43. 智谱：AutoGLM 开源，2025-12-09（P0）. https://www.zhipuai.cn/zh/research/145
44. 中国日报网：智谱 AutoGLM 2.0 开放，2025-08-20（P1）. http://cn.chinadaily.com.cn/a/202508/20/WS68a5c096a3104ba1353fde9e.html
45. 36氪：赛马终结者豆包（豆包工作）（P2）. https://36kr.com/p/3954430437997697
46. Kimi Help Center: Agent Overview（P0）. https://www.kimi.com/help/agent/agent-overview
47. MiniMax Agent 更新日志（Mavis）（P0）. https://agent.minimaxi.com/docs/changelog
48. The Algorithmic Self-Portrait（ChatGPT 记忆实证）— arXiv 2602.01450. https://arxiv.org/html/2602.01450v1
49. Why LLMs Alone Won't Bring True Voice AI — The AI Innovator. https://theaiinnovator.com/why-llms-alone-wont-bring-true-voice-ai/
50. AutoGPT Review 2026 — agentstant. https://agentstant.com/tools/autogpt/
51. SuperAGI 休眠状态 — trustvector. https://trustvector.dev/agents/superagi
52. OpenHands 官网. https://openhands.dev
53. OpenHands SDK 论文 — arXiv 2511.03690. https://arxiv.org/pdf/2511.03690
54. smolagents 横评（P2）. https://m.toutiao.com/group/7659674380821987849/
55. 2026 开源 agent 框架指南 — The Agent Report. https://the-agent-report.com/2026/05/ultimate-guide-open-source-ai-agent-frameworks/
56. deepagents（LangChain）. https://aiwiki.ai/wiki/deep_agents
57. MemGPT 两级记忆（转引/综述）. https://leoniemonigatti.com/blog/memgpt.html
58. Letta: Memory Blocks（P0）. https://letta.com/blog/memory-blocks
59. Zep/Graphiti 文档（P0）. https://help.getzep.com/graphiti/graphiti/overview
60. Zep 论文 — arXiv 2501.13956. https://arxiv.org/pdf/2501.13956
61. MemOS 论文 — arXiv 2507.03724. https://arxiv.org/html/2507.03724
62. A-Mem 论文（NeurIPS 2025）— arXiv 2502.12110. https://arxiv.org/html/2502.12110v9
63. Mem0: Introducing mem0 / Series A（P0）. https://mem0.ai/blog/introducing-mem0
64. Memory in the Age of AI Agents: A Survey. https://qiyanjun.github.io/2026sp-GenAI-Agents-Overview-Course/Lectures/2026-SP-W5-agent-memory3papers.pdf
65. Khoj — PyPI（2026-11 检索）. https://pypi.org/project/khoj/1.42.5/
66. Jan GitHub（P0）. https://github.com/janhq/jan
67. Second-Me 论文（AI-native Memory 2.0）— arXiv 2503.08102. https://arxiv.org/pdf/2503.08102v2.pdf
68. Me.bot / Second-Me（P0）. https://beta.me.bot
69. OpenAI: Running Codex safely（P0）. https://openai.com/index/running-codex-safely/
70. Anthropic Engineering: Claude Code sandboxing（P0）. https://www.anthropic.com/engineering/claude-code-sandboxing
71. Dive into Claude Code — arXiv 2604.14228. https://arxiv.org/pdf/2604.14228
72. Aider: repo map 文档（P0）. https://aider.chat/docs/ctags.html
73. Goose（Block）— 官方文档与公告（P0）. https://block.github.io/goose/llms.txt
74. OpenClaw GitHub（P0）. https://github.com/openclaw/openclaw
75. OpenClaw star 里程碑与设计哲学（P2）. https://openclawai.io/blog/openclaw-surpasses-react-github-most-starred-project
76. OpenClaw 蓝皮书（P2）. https://www.cdut.edu.cn
77. initrunner — PyPI. https://pypi.org/project/initrunner/
78. open-strix — PyPI. https://pypi.org/project/open-strix/
79. MCP 捐赠/规范演进 — arXiv 2609.10871 与 MCP 官方博客. https://blog.modelcontextprotocol.io
80. Linux Foundation: A2A 项目与一年里程碑（P0）. https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations
81. AG-UI — CopilotKit 文档. https://docs.copilotkit.ai/agentic-protocols/ag-ui
82. Generative Agents — Park et al., UIST 2023 / arXiv 2304.03442. https://arxiv.org/pdf/2304.03442
83. Stanford HAI: Computational Agents Exhibit Believable Behavior. https://hai.stanford.edu/news/computational-agents-exhibit-believable-humanlike-behavior
84. Voyager — arXiv 2305.16291 / 官网. https://voyager.minedojo.org
85. LoCoMo 基准 — arXiv 2402.17753. https://arxiv.org/pdf/2402.17753
86. Locomo-Plus — arXiv 2602.10715. https://arxiv.org/pdf/2602.10715v1
87. LUNAR 基准 — arXiv 2608.05246. https://arxiv.org/html/2608.05246v1
88. ContextAgent — arXiv 2505.14668. https://arxiv.org/pdf/2505.14668v1
89. Introducing ambient agents — LangChain，2025-01-14（P0）. https://www.langchain.com/blog/introducing-ambient-agents
90. OSWorld 12%→66.3%（AI Index 2026 转述）（P2）. http://agentmarketcap.ai/blog/2026/05/03/osworld-computer-use-agent-benchmark-66-percent
91. 能力悬崖分析（Windows Agent Arena）— Agentropic. https://agentropic.ai/blog/computer-use-agents-osworld-reality/
92. Autonomy Reshapes Privacy/Trust — arXiv 2510.04465. https://arxiv.org/html/2510.04465
93. SoDA / Agentic Web 主权架构 — arXiv 2512.22135. https://arxiv.org/html/2512.22135
94. The Year of the Agent Became the Year of Math — Maxism. https://www.maxism.ai/why-maxism
95. Project Vend — Andon Labs. https://intuitionlabs.ai/pdfs/andon-labs-project-vend-testing-autonomous-ai-agents.pdf
96. Agents on a leash — Stack Overflow，2026-05-27. https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work/
97. Avatar Intelligence: Persistent Personal Agents — arXiv 2611.03092（2026-11-02）. https://arxiv.org/abs/2611.03092
98. ClawNet（身份绑定与记忆）— arXiv 2604.19211. https://arxiv.org/html/2604.19211
99. Karpathy LLM OS / Software 3.0（转引）. https://cobusgreyling.github.io/karpathy-lessons/
100. How AI as an Operating System — HatchWorks（内核即编排与权限层）. https://hatchworks.com/blog/gen-ai/ai-driven-operating-systems/

---

**可信度注记**：Manus ARR/估值、GitHub star 数为公司口径或聚合站数据 [unverified]；OpenAI Operator 专项安全设计未获原始文档，本报告仅以 ChatGPT agent（关键动作确认）旁证；Google/Apple 部分产品细节以官方新闻稿（P0）为准。
