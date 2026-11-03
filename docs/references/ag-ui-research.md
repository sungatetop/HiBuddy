---
title: AG-UI 协议与生成式 UI 生态调研
summary: 调研 AG-UI（Agent-User Interaction Protocol）的协议定位、事件模型、SDK 生态与应用它的热点开源项目（CopilotKit、OpenBot、openui 等），并为 HiBuddy 筛选参考项目 clone 至 thirdparty/；后补入运行时选型两仓（deepseek-harness、pi-mono）
keywords: [AG-UI, Generative UI, CopilotKit, Agent, 事件流协议, thirdparty]
status: accepted
date: 2026-11-03
---

# AG-UI 协议与生成式 UI 生态调研

## 1. 调研目的与范围

- 为 HiBuddy 项目的前期技术选型提供参考：摸清 Agent 与前端交互的标准化协议现状（AG-UI），以及生成式 UI（Generative UI）方向的热点开源实现。
- 产出：筛选参考项目浅克隆到 `thirdparty/`（只读参考，不参与构建），本文档记录调研结论与各项目参考价值。2026-11-03 追补克隆 dsh-generative-ui（ui4a harness，S4 生成式 UI 选型直接对照物，见 ADR-007）。

## 2. AG-UI 协议要点

**定位**：AG-UI（Agent-User Interaction Protocol）是一个开放的、轻量的、基于事件流的协议，标准化 AI Agent 与用户侧应用（Web/桌面/移动/终端）之间的通信。由 CopilotKit 于 2025-05 创建，已被 Google、LangChain、AWS、Microsoft 等采用 [CONFIRMED，多源]。

**与相邻协议的分工**（LangChain 文档表述）：AG-UI 连接 Agent 与前端；MCP 连接 Agent 与外部工具；A2A 连接 Agent 与 Agent；ACP 连接 Agent 与 IDE/编辑器。

**事件模型**（SDK 文档，`@ag-ui/core` 枚举约 29 种事件，6 组）：

| 分组 | 事件 | 用途 |
|---|---|---|
| 生命周期 | RUN_STARTED / RUN_FINISHED / RUN_ERROR、STEP_STARTED / STEP_FINISHED | 一次 Agent 运行的起止与节点进度；RUN_FINISHED 可携带 outcome.interrupt（human-in-the-loop 中断恢复）与 TokenUsage |
| 文本消息 | TEXT_MESSAGE_START / CONTENT / END / CHUNK | 助手文本流式输出 |
| 工具调用 | TOOL_CALL_START / ARGS / END / RESULT / CHUNK | 工具执行全生命周期 |
| 状态管理 | STATE_SNAPSHOT、STATE_DELTA（JSON Patch，RFC 6902）、MESSAGES_SNAPSHOT、ACTIVITY_SNAPSHOT / DELTA | 前端与 Agent 共享状态双向同步（如 todo 列表、计划） |
| 推理 | REASONING_* 系列 | 思维链流式展示 |
| 子代理 | SUBAGENT_STARTED / FINISHED / ERROR | 多 Agent 编排可见性 |

- 公共字段 `BaseEvent = { type, timestamp?, rawEvent?, metadata? }`；`RAW` / `CUSTOM` / `META_EVENT` 为扩展口。
- 传输以 SSE（Server-Sent Events）为主（.NET SDK quickstart 即 `ServerSentEvents`），协议本身与传输解耦。

**SDK 生态**：

| SDK | 形态 | 备注 |
|---|---|---|
| TypeScript / Python | 官方第一方（`@ag-ui/core`、`ag-ui-protocol`） | 协议核心 |
| .NET | Microsoft 与 CopilotKit 合作贡献（AGUI.Server / AGUI.Client），2026-09 发布，MIT | Microsoft Agent Framework 基于它接入 |
| Java | 社区 SDK（`sdks/community/java`） | core 模块零第三方运行时依赖 |

**框架集成**（经由适配器）：LangGraph（`@ag-ui/langgraph` / `ag-ui-langgraph[fastapi]`）、CrewAI、AG2、Mastra、LlamaIndex、Agno、PydanticAI、Google ADK、Spring AI、Langroid、Microsoft Agent Framework、Claude SDK、Deep Agents 等 [CONFIRMED，CopilotKit 仓库 showcase + LangChain 文档]。

**Python/FastAPI 接入路径**（与本项目后端栈直接相关）：CopilotKit 仓库 `examples/integrations/langgraph-fastapi` 示例 = FastAPI + uvicorn 承载 LangGraph Agent，经 `ag-ui-langgraph[fastapi]` 暴露 AG-UI 端点，前端 Next.js + CopilotKit React SDK 消费。

## 3. 已选参考项目（thirdparty/）

选型判据：应用 AG-UI 或生成式 UI 方向的热点项目；覆盖"协议本体 / 前端框架 / 个人 Agent / 交互复现 / 标准与 SDK"五个层次；全部 MIT 许可。以下均为 `--depth 1` 浅克隆，clone 时间 2026-10-31，star 数为当日 GitHub 数据。

| 仓库 | Star | 定位 | 对 HiBuddy 的参考价值 |
|---|---|---|---|
| [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) → `thirdparty/ag-ui` | 16.9k | AG-UI 协议本体：TS/Python/.NET SDK + 社区 Java SDK + 文档 | 协议事件模型第一手实现；如本项目自建事件流协议可直接对标 |
| [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit) → `thirdparty/CopilotKit` | 38.4k | AG-UI 协议创建者；Agent/生成式 UI 前端全栈（React/Angular），含十余个框架集成 showcase | 生成式 UI 组件注册/渲染、共享状态同步、前端工具、human-in-the-loop 完整参考实现 |
| [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) → `thirdparty/OpenBot` | 9.1k | "个人 Agent"参考：开源 AI coworkers，每个 Agent 独享一台电脑（浏览器/文件/工具），动作先决策后执行、全程留痕；接受任意 AG-UI agent | 个人 Agent 产品形态 + 治理（决策前确认、审计）+ AG-UI 驱动的桌面级应用 |
| [CopilotKit/OpenIntelligentUI](https://github.com/CopilotKit/OpenIntelligentUI) → `thirdparty/OpenIntelligentUI` | 4.1k | ChatGPT Intelligent UI 的开源复现：Agent 流式产出图表/表单/地图等可交互组件，在沙盒中用自有 React 组件渲染 | "对话中长出交互界面"的端到端样例（CopilotKit + LangGraph） |
| [thesysdev/openui](https://github.com/thesysdev/openui) → `thirdparty/openui` | 14.5k | "生成式 UI 开放标准"：LLM 流式输出 UI 的消息/组件协议（React） | 与 AG-UI 互补的另一条协议路线（面向 UI 内容本身），可对比选型 |
| [opentiny/genui-sdk](https://github.com/opentiny/genui-sdk) → `thirdparty/genui-sdk` | 182 | 华为 OpenTiny 出品：面向 Vue / Angular / React 的生成式 UI SDK | 跨框架生成式 UI 抽象思路（含 React 侧实现） |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) → `thirdparty/deepseek-harness` | — | **HiBuddy 底座**（总体路线见 [ADR-003](../decisions/ADR-003-dsh-based-customization.md)；底座本体经 npm 依赖引入，此仓作源码对照）：Cordis 插件容器 + SessionEvent 日志 + approval/sandbox/subagent 子系统 + React Web Client；sparse 克隆（packages/apps/docs） | dsh 扩展面（插件/patch/brand slots/client 模块）实证、Web UI 分层与重连语义、Workspace/审批参考 |
| [earendil-works/pi](https://github.com/earendil-works/pi) → `thirdparty/pi-mono` | 110k+ | 极简 agent 内核（`@earendil-works/pi-agent-core`，AgentEvent 11 种）+ pi-ai 统一多 Provider API；sparse 克隆（packages） | 不再作为独立运行时接入（ADR-003）——其 pi-ai 已被 dsh 吸收为 LLM 适配层（packages/llm/llm-pi-ai）；保留作自写 LLM 适配器时的对照 |
| [MindLab-Research/dsh-generative-ui](https://github.com/MindLab-Research/dsh-generative-ui) → `thirdparty/dsh-generative-ui` | — | **dsh 的 ui4a 生成式 UI 插件**（2026-11-03 补克隆，服务 ADR-007）：模型直接写 React TSX（`````ui4a/tsx```` 围栏 / canvas 文件），浏览器内 esm.sh wasm 编译，同源渲染（无 iframe，卡片能力=会话能力 shim） | "harness 直接写前端代码"路线的第一手机制对照（双层教学 prompt+skill、内嵌围栏认领 DOM 观察、sidebarRight 画布、$dsh 能力闭集导入）；其无渲染隔离的设计与 HiBuddy SR-02 冲突，ADR-007 否决该路线时引用 |

## 4. 备选未 clone 项目

供后续按需补充（star 数为调研时社区数据，未逐一核验）：

- `tambo-ai/tambo`：React 生成式 UI SDK（HN 2026-02 发布 1.0）。
- `langchain-ai/deepagents`：Deep Agents 框架，官方文档含 AG-UI adapter 接入（Python/TS）。
- `miurla/morphic`：生成式 UI 的 AI 搜索引擎。
- `vercel/ai`：Vercel AI SDK，RSC 生成式 UI 路线。

## 5. 对 HiBuddy 的启示（初步，待需求文档后修正）

1. **协议层值得复用而非重造**：AG-UI 事件模型（生命周期/文本/工具/状态/推理/子代理）已成为事实标准，HiBuddy 若做 Agent↔前端通道，直接对标其事件枚举与 SSE 传输可减少兼容成本。
2. **状态同步是生成式 UI 的核心机制**：STATE_SNAPSHOT 基线 + STATE_DELTA（JSON Patch）增量同步贯穿所有实现。
3. **沙盒渲染 + 前端工具 + human-in-the-loop** 是三类必备能力：模型产出可交互 UI 需要安全渲染边界；Agent 需要能调用前端能力；长任务需要中断/恢复语义。
4. **React 侧实现最全**：主流生成式 UI 实现集中在 React（CopilotKit/tambo/openui），与本项目 React + TypeScript 决策一致，参考路径直接；Vue 侧仅 opentiny/genui-sdk 等（跨框架抽象思路可借鉴）。

## 6. thirdparty/ 使用约定

- 只读参考：禁止修改第三方仓库内容；本项目不对其编译/打包/发布。
- 浅克隆维护：需要更新时 `git pull --depth 1`；不引用其 git 历史。深仓可 sparse+blob:none 引入（deepseek-harness、pi-mono 即此方式）。
- 各仓库 LICENSE（均 MIT）随仓库保留，引用其代码片段时注意许可证义务。
- 克隆状态（2026-11-03）：9 个参考仓全部就位（ag-ui、CopilotKit、OpenBot、OpenIntelligentUI、openui、genui-sdk、deepseek-harness、pi-mono、dsh-generative-ui）。openui 首次克隆损坏（.git 仅剩中断的临时 pack、0 对象），2026-11-03 删除重克隆修复；dsh-generative-ui 为 ADR-007 选型追补。

## 7. 主要来源

- AG-UI 官方文档：事件枚举（docs.ag-ui.com/sdk/js/core/events）、Python SDK（docs.ag-ui.com/sdk/python/core/overview）
- LangChain 官方文档：Deep Agents 暴露 AG-UI（docs.langchain.com/oss/python/deepagents/ag-ui）
- Microsoft .NET Blog：AG-UI .NET SDK 发布（devblogs.microsoft.com/dotnet/ag-ui-dotnet-sdk/，2026-09）
- CopilotKit 仓库结构（showcase/integrations、examples/integrations/langgraph-fastapi）与 GitHub API 元数据
- 社区综述：腾讯云开发者社区《研究 Agent Gen UI，发现几个值得学习的宝藏开源项目》（2026-10-19）、LibHunt generative-ui 榜单、GitCode 博客（Java SDK 解析、langgraph-fastapi 示例、OpenIntelligentUI 教程）
- npm：dsh-generative-ui 包页（ui4a harness 说明）
