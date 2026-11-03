---
title: ADR-007 生成式 UI 产出格式（组件指令，否决直接生成前端代码）
summary: S4 生成式 UI 的产出格式定案为"组件指令"——模型经自定义 render_ui 工具输出结构化 UI 指令 JSON，前端以预置信任组件注册表渲染（内嵌 toolview 卡片 + 右栏画布 tab），交互经 conversation.send 结构化回传；否决 ui4a harness 式"模型直接写前端代码"（同源渲染无隔离、违反 SR-02 与验收 A5）与 iframe 生成代码路线（P1 演进候选）
keywords: [ADR, 生成式UI, 组件指令, render_ui, toolview, 画布, 沙盒, SR-02, 交互回传, dsh]
status: accepted
date: 2026-11-03
---

# ADR-007 生成式 UI 产出格式（组件指令，否决直接生成前端代码）

> 决策依据：dsh v0.2.1-rc.5 安装产物 API 实证 + thirdparty 参考仓调研（openui / OpenIntelligentUI / genui-sdk / CopilotKit / dsh-generative-ui，证据索引见 §5）。
> 关联：[PRD FR-04/SR-02](../product/requirements.md)、[ADR-003](ADR-003-dsh-based-customization.md)（dsh 扩展面定制路线）、[ADR-009](ADR-009-s3-rescope-agui-bridge.md)（AG-UI 桥）。

## 1. 背景与问题

PRD FR-04 要求 Agent 产出不止文字：对话中呈现可交互界面（图表、表单、对比面板、计算器等），支持**内嵌**（消息流内）与**画布**（侧边面板、跨轮驻留、版本可回看）两形态、流式渲染、交互回传；SR-02 要求界面运行在隔离容器内——无网络请求白名单以外的访问、无本地文件访问、无密钥读取，边界内仅允许：消费会话数据、向 Agent 回传交互、使用内置展示组件。S4 验收 A5 明确：沙盒内发起网络请求、读本地文件、读密钥均被阻断。

核心选型问题：**模型产出界面的格式**——让模型直接写前端代码（dsh 生态的 ui4a harness 路线），还是输出结构化组件指令（CopilotKit 工具渲染 / A2UI / genui-sdk DSL 谱系）？

## 2. dsh 渲染边界实证（选型前提）

以下均以 node_modules 已装 0.2.1-rc.5 的 .d.ts 为准：

1. **dsh 原生无生成式 UI / artifact / canvas 支持**（dist 资产全量搜 ui4a/artifact/generative/sandbox 无命中）。
2. **无 markdown 代码块级 slot**：消息流渲染链 `conversation.chat.flow → conversation.chat.node`（keyed by ChatNodeKind），markdown 代码块是硬编码组件（`md-code-block` 类名），外部模块无渲染拦截点——文本围栏路线必须做 DOM 观察 hack。
3. **工具调用卡片有官方自定义渲染点**：`tool.call.toolview` 为 keyed slot，官方注释明确"Any name is allowed, **including tools registered by your package**"；三阶段 props（preparing/start/result），preparing 阶段 args 可不完整（流式渲染原生支持）。
4. **插件可注册自定义 agent 工具**：`ctx.tools.register(defineTool({...}))`（dsh-tools，dsh-tool-ask-user 等官方工具即此模式）。
5. **右栏画布挂载点**：`ctx.sidebarRight` 控制器（openTab/openResource/close/toggleExpanded，会话域驻留）+ `sidebar.right.pane.tab` slot。
6. **交互回传通道**：`ctx.conversation.send(text)`——prompt 进入当前 scope 会话（queued turn）。

## 3. 备选路线对比与决策

| 路线 | 产出格式 | 流式 | 隔离（SR-02） | dsh 集成 | 结论 |
|---|---|---|---|---|---|
| **组件指令**（CopilotKit 工具渲染谱系） | 工具调用参数 = UI 指令 JSON | 低（args 增量即渲染，preparing 阶段原生支持） | **天然满足**（预置信任组件，无任意代码执行） | 低（工具注册 + toolview keyed slot 均为官方扩展点） | **✅ 采纳** |
| 直接写前端代码（ui4a harness） | React TSX 代码（围栏/canvas 文件），浏览器内 esm.sh wasm 编译 | 中（围栏文本流式） | **不满足**：同源渲染无 iframe，能力 shim = 会话能力（卡片可 $dsh/fs、$dsh/web） | 高（DOM 观察 hack + wasm 编译器） | ❌ 否决 |
| 生成代码 + iframe 沙盒（OpenIntelligentUI 式） | HTML/CSS/JS 代码，srcDoc 沙箱 | 难（JS 需完整后执行；HTML morph 复杂） | 满足（同源隔离 + postMessage 白名单） | 中高（自建沙盒渲染与回传协议） | P1 演进候选 |
| 文本围栏 DSL（genui-sdk SchemaJson / openui Lang） | markdown 围栏内 JSON/DSL | 中（需半截 JSON 修复） | 满足（白名单组件） | 高（无代码块 slot → 同样 DOM hack；CLI 端退化为裸文本） | ❌ 否决 |

### 3.1 决策：组件指令路线

**模型不写前端代码，改为调用自定义 `render_ui` 工具输出结构化 UI 指令**；前端由 @hibuddy/web-ui 提供预置信任组件注册表，将指令渲染为界面。

三条决定性理由：

1. **SR-02 是硬约束，直接淘汰代码路线**。ui4a harness 的设计哲学是"卡片能做的 = 会话能做的"（fs/exec/web 能力 shim 复用会话沙箱策略），与 PRD"隔离容器、无本地文件访问、无密钥读取"正面冲突，S4 验收 A5 的三条阻断用例在该路线下无法成立。组件指令路线中界面对象 = 我们编写的信任组件，模型输入只有**数据与参数**（JSON），不存在代码执行面，A5 天然通过——隔离语义由"信任组件 + 数据投影"实现，这正是 PRD 边界内允许项"使用内置展示组件"的原文口径。
2. **dsh 渲染边界与工具路线天然契合**：toolview keyed slot 是官方为"自有包工具"预留的渲染扩展点（含 preparing 流式阶段），零 hack；代码/围栏路线都要依赖 DOM 观察 hack（脆弱，随 dsh 版本升级易碎，违反 ADR-005 升级纪律）。
3. **工程与生态成熟度**：CopilotKit（38k star）的 useCopilotAction render（组件参数 + args 流式渲染）是该领域验证最充分的路线；S3b 的 AG-UI 桥已把 tool/* 事件映射为 TOOL_CALL_*，AG-UI 生态前端未来可直接消费 render_ui 调用。CLI/headless 端工具调用与参数留痕复用 dsh 原生 trace（FR-08），围栏路线则无此一致性。

### 3.2 产出格式（UI 指令 schema）

`render_ui` 工具参数即指令文档，P0 结构：

```jsonc
{
  "id": "ui-<shortid>",          // 界面实例 id；同 id 重复调用 = 更新（画布版本+1）
  "target": "inline"             // inline=消息流内嵌 | { "canvas": { "id": "...", "title": "..." } }
                                 // canvas=侧栏画布（跨轮驻留，随更新递增版本）
  "component": "chart",          // 组件注册表 key：P0 首批 chart | form | table | metrics
  "props": { },                  // 组件特定参数（图表类型/系列、表单字段/校验、行列、指标卡…）
  "data": { },                   // 界面消费的数据（内联；须来自当前任务上下文，SR-02）
  "summary": "人类可读一句话"      // 审批卡/时间线/降级场景的静态摘要
}
```

- 工具执行体为 no-op（返回 ok + 指令回显）；渲染副作用完全在 client 半。
- 组件注册表可扩展（新增组件 = client 半注册 + 指令 schema 增 key），表达力上限登记 §6。

### 3.3 两形态与流式

- **内嵌**：`tool.call.toolview` keyed slot（key=`render_ui`）渲染指令对应组件；args 流式期间以增量 JSON 解析渐进渲染（preparing/start 阶段 props）。
- **画布**：同一渲染引擎复用；client 半经 `ctx.sidebarRight` 注册画布 tab 类型并渲染 `sidebar.right.pane.tab`；画布内容跨轮驻留，指令更新（同 canvas id 重复调用）版本 +1，保留历史快照可回看；`toggleExpanded`/`close` 支持开关重开。
- **流式渲染**（FR-04 规则 1）：toolview preparing 阶段对不完整 args 做部分 JSON 容错解析，已到达的 props 先渲染。

### 3.4 交互回传（FR-04 规则 3）

组件事件回调 → 组装结构化文本（约定包裹格式，含界面 id、组件、交互类型与载荷 JSON）→ `ctx.conversation.send(text)` 作为 queued turn 进入会话，下一轮模型可引用；交互记录随画布实例留存（交互历史）。

### 3.5 沙盒边界论证（SR-02 / 验收 A5）

- 组件为 @hibuddy/web-ui 编译期固化的信任代码：不提供网络请求 API、不接触文件系统与密钥存储、不 eval/动态 import 任何模型提供字符串。
- 数据仅经工具参数注入（模型侧）；界面与宿主的交互面 = 组件事件 → conversation.send 单一通道。
- 降级路径（FR-04 异常）：指令解析失败或组件渲染异常 → 降级渲染 `summary` + 数据表格化静态内容。

## 4. 后果

**正面**：SR-02/A5 天然满足；零 DOM hack、官方扩展点全适配；流式/回传/留痕（工具调用原生入 session JSONL，FR-08）全链一致；CLI 与 Web 行为同构（工具调用三端可见）。

**负面/代价**：表达力上限 = 组件注册表边界，任意定制界面（3D、地图、自由布局）需逐组件扩展；指令 schema 需随组件演进做版本管理。这些代价换取的是安全边界可证明（A5 用例可自动化）。

**能力面完整性声明**：本决策只做增量（新工具 + 新 client 模块 + 新 slot 注册），不 disable/覆盖 dsh 任何原生子系统，符合横切纪律 1。

## 5. 证据索引

- `tool.call.toolview` slot 定义（keyed、任意工具名、三阶段 props）：`node_modules/.pnpm/@deepseek-ai+dsh-web-app@0.*/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/types/client/contract/slots.d.ts`（L19-23, L73-84）
- 工具注册 API：`@deepseek-ai/dsh-tool-ask-user/lib/index.js` L66（`ctx.tools.register(defineTool(...))`，dsh-tools 出品）
- chat 流 slot 与 keyed node：`dsh-client-ui-chat/lib/types/client/contract/slots.d.ts`（L324-418；无代码块级 slot 佐证）
- sidebarRight 控制器与 pane tab slot：`dsh-client-ui-sidebar-right/lib/types/client/service.d.ts`（ISidebarRight 全量方法）
- conversation.send：`dsh-client-ui-conversation/lib/types/client/service.d.ts` L39（queued turn 语义）
- ui4a harness 机制（否决依据）：`thirdparty/dsh-generative-ui`（README、src/index.ts、src/client/index.ts、src/runtime/inline-fence.ts L12-14 "There is no slot for a markdown code block" 自认）
- 生态路线对照：`thirdparty/CopilotKit`（工具渲染 generative-ui）、`thirdparty/OpenIntelligentUI`（生成代码 + Websandbox）、`thirdparty/genui-sdk`（SchemaJson DSL）、`thirdparty/openui`（文本 DSL，本地仓 2026-11-03 重新克隆）

## 6. 缺口与 P1 演进

1. **iframe 代码沙盒路线**（OpenIntelligentUI 式 srcDoc + postMessage 白名单）作为表达力扩展候选，P1 按需立项（需先有组件指令覆盖不了的真实场景）。
2. 组件集扩充（对比面板/计算器等）按验收 A2 最小集起步，按需追加。
3. AG-UI 侧透传：render_ui 调用经 ag-ui-bridge 已映射 TOOL_CALL_*，生态前端渲染为 P1 生态接入项（与 ADR-009 缺口清单合并跟踪）。
4. 指令 schema 版本化：组件演进破坏兼容时引入 `v` 字段，P0 单版本不设。
