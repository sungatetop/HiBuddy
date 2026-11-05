# HiBuddy 文档索引

> 全库文档索引：按类别列出 `accepted` 状态文档；`draft` 文档单列（评审通过后移入正表）。新文档定稿时必须在本表登记（规则见 [.trae/rules/project.md](../.trae/rules/project.md) §2.3）。

## 评审中（draft）

| 类别 | 文档 | 摘要 |
|---|---|---|
| 产品文档 | [product/requirements.md](product/requirements.md) | PRD：HiBuddy（个人常驻智能体）的 P0 范围、常驻层增量范围（§3.2，FR-10）、对象模型（含常驻层对象草案）、功能需求（会话/任务/工具审批/生成式界面/共享状态/BYOK/双端一致）与共享规则；定位修订依据 ADR-010 |
| 架构文档 | [architecture/system-architecture.md](architecture/system-architecture.md) | 技术方案：基于 deepseek-harness（dsh，npm 依赖，MIT）深度定制——hibuddy profile 装配 + @hibuddy/* 插件集（品牌/核心工具/Web UI 定制/AG-UI 桥）+ 自建 Electron 壳+宿；不 fork、不建 SPI（路线见 ADR-003） |
| 计划与报告 | [implementation-plan.md](implementation-plan.md) | P0 实施计划：先复用后定制——S1 跑通 dsh 三端基础设施与能力面完整性（插件安装/启停）并打包，S2 起定制（品牌人设→核心工具/审批→AG-UI 桥 MVP→生成式 UI→收尾双端交付）；S6 生态接入与上游跟进，S7 常驻/主动层（ADR-010）；每阶段任务、前置 ADR 与可判定验收标准 |
| 计划与报告 | [progress-report.md](progress-report.md) | 各阶段验收记录与缺口清单：S0–S6 已通过（P0 交付 + S6 生态接入 2026-11-04 收官：CopilotKit 真机三场景、上游热激活缺口定界为 junction 部署 × pnpm 相对 symlink 并修复）；S7-A 原型真机验证（2026-11-05：三机制两过一缺口，profile 已还原） |

## 决策文档（docs/decisions/）

| ADR | 摘要 |
|---|---|
| [ADR-010-resident-proactive-agent.md](decisions/ADR-010-resident-proactive-agent.md) | 产品定位修订——个人常驻智能体：常驻运行/事件驱动/主动执行/人管目标与验收（对标 dsh Super-agent 与 OpenMuse）；实现路线混合式——S7-A 先装 dsh-superagent-prototype 真机验证 dsh 常驻机制，S7-B 自研 @hibuddy/resident 面向个人场景（首批事件源=定时/周期任务）；S6 收尾不受影响，AG-UI 桥与常驻层正交 |
| [ADR-007-generative-ui-format.md](decisions/ADR-007-generative-ui-format.md) | 生成式 UI 产出格式定案「组件指令」：模型经自定义 render_ui 工具输出 UI 指令 JSON，@hibuddy/web-ui 预置信任组件注册表渲染（内嵌=tool.call.toolview keyed slot、画布=sidebarRight tab 跨轮驻留版本递增），交互经 conversation.send 结构化回传；否决 ui4a harness 直接写前端代码路线（同源渲染无隔离，违反 SR-02 与验收 A5），iframe 生成代码列为 P1 演进候选 |
| [ADR-009-s3-rescope-agui-bridge.md](decisions/ADR-009-s3-rescope-agui-bridge.md) | S3 范围缩减与 AG-UI 桥立项：实证 dsh 已自带完整工具面（preset-standard 14+ 官方工具）与审批机制（沙箱模式×执行期升级+approval/request waterfall）后，S3 不再自研工具与审批主干，缩减为「审批 answerer 增量」（L1 免再询记忆/审批卡参数全文/L2 默认关闭）；AG-UI 桥提前为 S3b 专项——插件内 ctx.webServer 注册 /agui SSE 端点（方案 A，dsh-sdk 外挂方案因缺审批应答否决），MVP 验收=CopilotKit 接入闭环 |
| [ADR-008-l1-code-exec-sandbox-policy.md](decisions/ADR-008-l1-code-exec-sandbox-policy.md) | L1 代码执行沙盒策略：P0 默认关闭（L2 preset 禁用 + coworker 双闸兜底）故不适用，仅登记重立条件（未来开放代码执行时须先定沙箱档位/审批组合/免再询边界） |
| [ADR-006-web-deployment-access.md](decisions/ADR-006-web-deployment-access.md) | Web 端部署形态与访问控制：P0 单用户自部署，官方默认 loopback 监听（127.0.0.1:3080，拒绝 wildcard bind），访问控制采用 dsh 原生信任链（连接栅栏 403 + 启动 token 换签名会话 cookie），不自建账号层；P0 禁止公网暴露，P1+ 远程访问走官方反向代理路径并须修订本 ADR；启动 token 为进程凭据不落盘 |
| [ADR-005-dsh-version-pinning.md](decisions/ADR-005-dsh-version-pinning.md) | dsh 版本锁定与升级策略：@deepseek-ai/* 全家精确钉版维持整组发版配对；Electron 精确钉在 dsh 宿原生白名单指纹（禁 ^ 浮动）；engines.dsh 运行时闸；七步强制升级流程（changelog→覆盖行 diff→白名单→client 契约→build→冒烟→登记）；deploy 必须 hoisted 布局（isolated+dereference 丢相对 symlink 实测）；插件安装状态经 profile package.json+lock 入库复现 |
| [ADR-004-desktop-shell-host.md](decisions/ADR-004-desktop-shell-host.md) | 桌面端壳+宿方案：自建 Electron 壳 + RunAsNode 宿进程复刻 dsh 模式；宿按名启动 $DSH_HOME/profiles/hibuddy（三端插件安装/分层配置同源互通）；P0 渲染层直连宿 authenticatedUrl，hibuddy-app:// 特权协议降为 P1 加固；IPC 消息集、--port 0 端口治理、quit-inspection、Windows 打包概要 |
| [ADR-003-dsh-based-customization.md](decisions/ADR-003-dsh-based-customization.md) | 总体路线：放弃"自建 server + AgentRuntime SPI 适配器"，以 dsh 为底座深度定制（插件/patch/brand slots/client 模块官方路径实证）；定制优先级纪律与 fork 触发条件；取代 ADR-002 的适配器定位、取消 ADR-001（AG-UI 统一协议降级为 P1 可选桥） |
| ~~[ADR-002-agent-runtime-selection.md](decisions/ADR-002-agent-runtime-selection.md)~~ | （superseded）Agent 运行时选型对比与事件映射——dsh/pi 对比数据、AG-UI 事件映射表与 thirdparty sparse 引入方式仍有参考价值 |

## 参考资料（docs/references/）

| 文档 | 摘要 |
|---|---|
| [ag-ui-research.md](references/ag-ui-research.md) | AG-UI 协议与生成式 UI 生态调研；thirdparty/ 参考仓清单（ag-ui、CopilotKit、OpenBot、OpenIntelligentUI、openui、genui-sdk + 运行时两仓 deepseek-harness、pi-mono）与克隆状态 |
| [dsh-desktop-analysis.md](references/dsh-desktop-analysis.md) | dsh 桌面端技术方案剖析：Electron 壳 + RunAsNode 宿进程分离、dsh-app:// 协议拦截与认证转发、--port 0 端口治理、细分沙箱 preload、打包分发；HiBuddy ADR-007 的直接输入 |
| [dsh-web-cli-analysis.md](references/dsh-web-cli-analysis.md) | dsh Web 与 CLI 技术方案剖析：apps/web 纯 dist 产物包与双注入通道、apps/cli 单 bin 四模式与 profile 分层配置、单端口单进程 serve + appReady 启动编排；产出 12 条机制级借鉴清单，技术方案 §2.2 与 ADR-006 的直接输入 |
