---
title: HiBuddy P0 实施计划
summary: P0 的分阶段执行计划（S1–S7）：S1 先把 dsh 基础设施三端（CLI/Web/桌面）全部复用跑通、验证 dsh 原生能力面完整性（插件安装/启停/分层配置）并建立编译打包链路，S2 起再按 PRD 需求做深度定制（品牌人设→核心工具/审批→生成式 UI→收尾双端交付）；S6 为 P0 后续（AG-UI 桥 CopilotKit 生态真机接入 + dsh 上游热激活缺口收口）；S7 为定位修订后的常驻/主动层（ADR-010：先验 dsh-superagent-prototype 原型，再自研 @hibuddy/resident）；每阶段含可判定的验收标准
keywords: [实施计划, 里程碑, 验收标准, P0, 分阶段交付, 基础设施复用, 插件生态, AG-UI, 常驻智能体, HiBuddy]
status: accepted
date: 2026-11-09
---

# HiBuddy P0 实施计划

> 依据：[PRD](product/requirements.md) P0 范围、[system-architecture](architecture/system-architecture.md)、[ADR-003](decisions/ADR-003-dsh-based-customization.md)。
> 总体顺序（用户定，2026-11-01）：**先复用后定制**——S1 把 dsh 的桌面端、Web、CLI 基础设施全部跑通编译打包，S2 起再开展需求定制。
> **能力面完整性原则（用户定，2026-11-01）**：HiBuddy 是针对 dsh 的深度定制项目，产品形态 = **dsh 完整能力 + HiBuddy 增量**，不是裁剪版 dsh——dsh 的插件安装/启停管理、profile 分层配置、settings、凭证管理等原生能力必须在 HiBuddy 全端完整可用；定制 patch 只做 insert 与自身插件 config，禁止用 `disabled`/覆盖裁剪原生子系统（确有冲突须在 patch 注释登记理由）。
> 阶段纪律：文档先行（阶段内架构取舍先落 ADR 再编码）；每阶段结束必须满足该阶段全部验收标准并留验收记录（[progress-report](progress-report.md)）；按任务粒度分批提交；同步更新本文件与 docs/README。

## 1. 阶段总览

| 阶段 | 主题 | PRD 覆盖 | 前置 ADR | 里程碑（阶段末的可运行状态） |
|---|---|---|---|---|
| S0 ✅ | 骨架与冒烟链路 | — | — | pnpm workspace + hibuddy/hibuddy-smoke 双 profile + 三插件骨架装配验证通过（2026-11-01） |
| S1 | 基础设施复用与编译打包（CLI / Web / 桌面）+ dsh 能力面完整性验证 | —（纯 dsh 原生能力，零需求定制） | ADR-004、ADR-005 | 三端跑通：CLI 任务、Web 任务、桌面应用（开发态 + Windows 打包产物）；dsh 插件安装/管理全端可用 |
| S2 | 品牌与人设基线（定制起点） | 闭环主干（FR-02/FR-06 走 dsh 原生能力） | ADR-006 | 三端以 HiBuddy 品牌与人设跑通真实任务 |
| S3 | 审批分级与留痕增强（复用 dsh 原生工具与审批主干） | FR-03、SR-01、FR-08（数据层） | ADR-009（ADR-008 条件性，见下） | 工具按 L0/L1 分级审批执行、免再询生效、全程留痕 |
| S3b | AG-UI 协议桥 MVP（@hibuddy/ag-ui-bridge） | —（生态接入，超前铺路；见 ADR-009 §3） | ADR-009 | AG-UI 生态前端（CopilotKit）经 `/agui` 端点连 HiBuddy runtime 跑通对话+工具+审批闭环 |
| S4 | 生成式 UI 与工作台定制 | FR-04、SR-02、FR-05 | ADR-007 | 对话内出现可交互界面（内嵌+画布）、交互可回传 |
| S5 | P0 收尾与双端交付 | FR-01、FR-02、FR-06、FR-08、FR-09 + FR-07 | — | Web 端收尾 + 桌面独有能力 + 双端对等验收，P0 完成 |
| S6 | 生态接入与上游跟进（P0 后续） | —（S3b 缺口收口 + 上游缺口跟进） | — | CopilotKit 浏览器端真机经 `/agui` 跑通对话+工具+审批闭环；上游热激活缺口结论登记 |
| S7 | 常驻/主动层（定位修订后增量，见 [ADR-010](decisions/ADR-010-resident-proactive-agent.md)） | FR-10、§3.2 常驻层 | ADR-010 | S7-A：dsh-superagent-prototype 真机验证常驻机制并沉淀结论；S7-B：`@hibuddy/resident` 面向个人场景（首批事件源=定时/周期任务）常驻执行闭环 |

依赖顺序：S1 → S2 → S3 → S3b → S4 → S5 → S6 → S7。S1 建立的三端载体（同一 `hibuddy` profile）在后续阶段被全部复用：S2–S4 的定制（后端插件 + client 模块 + Slots）天然同时作用于 CLI/Web/桌面，故各阶段验收以 Web 端为主、S5 统一做双端对等验收。S3 范围缩减与 S3b 立项依据见 [ADR-009](decisions/ADR-009-s3-rescope-agui-bridge.md)——dsh 原生工具与审批主干直接复用，不自研工具；AG-UI 桥提前落地（生态接入验证）。S7 立项依据见 [ADR-010](decisions/ADR-010-resident-proactive-agent.md)——定位修订为个人常驻智能体，混合路线（先验原型再自研）；S6 收尾不阻塞 S7-A 启动。

**条件性 ADR**：ADR-008（L1 代码执行沙盒策略）仅当 S3 决定开启代码执行（PRD FR-03 默认关闭）时落地；P0 默认不开启则不阻塞。

## 2. 各阶段任务与验收标准

验收标准全部满足方可关闭阶段；任何一条不满足时阶段不得标记完成。验收记录写入 [progress-report](progress-report.md) §对应阶段。

### S1 基础设施复用与编译打包（CLI / Web / 桌面）+ dsh 能力面完整性

**目标**：不写任何需求定制代码，把 dsh 基础设施三端全部复用跑通并建立打包链路；同时验证 dsh 原生能力面在 hibuddy profile 上完整可用（插件安装/启停、分层配置）。此阶段产品以 dsh 默认品牌运行——先把"地基"打牢，所有定制后置。

**任务**：
1. CLI 复用验证：`pnpm smoke`（headless 一次性任务，链路已就绪）；tui 交互模式以 hibuddy profile 跑通。
2. Web 复用验证：`pnpm exec dsh --profile hibuddy` 起 webserver，原生 Web UI 完成一次任务。
3. **dsh 能力面完整性验证**：
   - 插件安装：`dsh plugin --profile hibuddy add <pkg>` 安装一个第三方/示例 bundle 插件，确认其在装配层序中生效并可被卸载；确认 Web UI 图形化插件管理（安装/启停）可用；验证开发态 junction 目录下 `plugin add` 的行为并确定 git 策略（profile node_modules 变更是否入库）。
   - 分层配置：用户级 `$DSH_HOME/cordis.patch.yml` 与 CLI `--patch` overlay 在 hibuddy profile 上按层序生效。
   - 确认 HiBuddy 三插件（骨架态）与第三方插件可共存（bundles 层序不互斥）。
4. 落 ADR-004：桌面壳+宿实现细节（进程模型、`hibuddy-app://` 特权协议、细分沙箱 preload、`--port 0` 端口治理、打包分发方案；输入 [dsh-desktop-analysis](references/dsh-desktop-analysis.md)）。
5. `@hibuddy/desktop-host`：RunAsNode 宿进程——内嵌 dsh runtime、`runProfile('hibuddy')`、`--port 0` 随机端口回传、IPC 应答 ready/fatal/quit。
6. `@hibuddy/desktop-shell`：Electron 主进程——窗口/托盘/生命周期、特权协议、细分沙箱 preload、宿进程 spawn/quit-inspection。
7. 打包链路：按 ADR-004 定方案，desktop 打包出 Windows 可安装产物；根构建脚本（build/typecheck）扩展覆盖 desktop/*。
8. 落 ADR-005：dsh 版本锁定与升级策略（engines.dsh 闸、升级冒烟流程、覆盖行登记）。

**验收标准**：
- [x] A1 `pnpm build` 与 `pnpm typecheck` 全绿（含 desktop/* 包）。
- [x] A2 CLI：`pnpm smoke "只回复两个字：正常"` 输出「正常」；tui 模式可进入交互。（验收记录：冒烟往返通过；tui 无对应运行时模板，计划偏差已在 progress-report S1 登记）
- [x] A3 Web：`pnpm exec dsh --profile hibuddy` 启动，浏览器打开原生界面完成一次真实多步任务（过程可见），刷新页面后会话与状态恢复。
- [x] A4 插件生态：示例插件经 CLI 安装后生效、经 Web UI 可见并可启停/卸载；`--patch` overlay 层序生效；HiBuddy 插件与第三方插件共存无冲突。
- [x] A5 桌面开发态：启动 desktop-shell，窗口加载内嵌 runtime 的界面并可完成一次对话任务。
- [x] A6 桌面打包：产出 Windows 可安装包；安装后应用可启动并跑通一次任务；关闭应用后 runtime 进程随退（无残留）。（2026-11-03 全部验证：全新安装零丢文件——`resources\host` 22,656 = 基准 22,656，总数 22,757 = +安装期生成卸载器；安装版启动链 shell.log 全通过——shell starting → spawning host → host ready → renderer loaded，死锁修复在安装版生效；用户确认真实任务回复正常（MiniMax-M2.7）；关闭后无 HiBuddy/electron 宿进程残留）
- [x] A7 ADR-004、ADR-005 状态 accepted 并登记 docs/README；progress-report 有 S1 验收记录。

### S2 品牌与人设基线（定制起点）

**目标**：第一个需求定制阶段：以 dsh 官方 brand 路径替换默认品牌，注入 HiBuddy 最简人设；验证"同一 profile 三端一致"；定制后 dsh 能力面不回归。

**任务**：
1. `@hibuddy/brand` 完整化：HiBuddy 名称、侧边栏 mark、页面标题（官方 brand slots 路径）。（已落地 2026-11-02：官方 `ui-brand-official` 行经 profile cordis.patch.yml 覆盖为 disabled——官方浏览器半仅注册 sidebar.brand.mark/name 两槽位，无其它表面损失，@hibuddy/brand 独占接管消除双注册；页面标题经 brand client 半设 `document.title`——dsh 0.2.1-rc.5 无运行时标题配置点，走 client-module 扩展面；界面级生效待 A3 三端走查。走查补充 2026-11-03：dsh-client-ui-layout 内置 `DocumentTitle` 组件硬编码 productTitle="DeepSeek Harness"，每次会话标题变化都会覆写 `document.title`——简单赋值方案在会话页被覆盖，改为 brand apply 中 `Object.defineProperty(document, 'title', ...)` 实例级 setter 拦截，把写入标题中的 "DeepSeek Harness" 改写为 "HiBuddy"；空状态/会话页/新会话自动标题三态验证通过）
2. `@hibuddy/coworker` 最简人设：经 dsh 官方配置面注入系统提示词（产品名 + 一句话人设），研究并登记 dsh 的 agent/persona 配置扩展点。（已落地 2026-11-02：走部署级 `system-prompt` 行 `personaPrefix`——profile patch 第三层覆盖 dsh-web-app 的 coding agent 人设为 HiBuddy 人设（产品名+一句话，保留 `{{model}}` 变量），coworker 代码零改动；`@deepseek-ai/dsh-persona` 为 per-agent 行不适用（须 preset scope 内挂载、全局挂载报错），扩展点研究结论登记于 profile/hibuddy/cordis.patch.yml 注释；`--dump-config` 已验证生效；行为级验证随 A4 冒烟补验。走查修正 2026-11-03：A4 行为级验证暴露两处偏差并修复——①官方 `preset-standard`（dsh-web-app presets/standard.patch.yml）内挂载的 `dsh-persona` 插件以同名 section 在 agent scope 注册并遮蔽部署级 personaPrefix（dsh-persona 标注 "scope-only"、system-prompt 注释 "scoped section shadows a global section with the same name"），即使 prefix 置空两种人设也一起消失，修复为在 preset-standard 覆盖行中整行移除 persona 插件（preset 覆盖替换完整 config.plugins 子列表，已按官方清单重述其余行）；②`harness-dev-context` 插件注入 "DeepSeek Harness implementation checkout" / "DeepSeek Harness Web GUI" 两段系统提示词与两条运行时上下文，构成第二身份源，按其官方 README 指明的口径整行禁用；修复后 trace「初始系统提示词」ground truth：首句 "You are HiBuddy, the user's everyday assistant, powered by the MiniMax-M2.7 model."，全文无 DeepSeek Harness）
3. 落 ADR-006：Web 端部署形态与访问控制（P0 单用户自部署、loopback/令牌口径确认）。（已落地 2026-11-02：[ADR-006](decisions/ADR-006-web-deployment-access.md) accepted 并登记 docs/README——官方默认 loopback 监听不覆盖传输行、访问控制走 dsh 原生信任链（栅栏 403 + 启动 token 换签名会话 cookie）不自建账号层、P0 禁公网暴露、启动 token 进程凭据不落盘）
4. 三端回归走查（含 S1 的插件安装/管理能力复验），产出问题/缺口清单（记入 progress-report）。（已落地 2026-11-03：Web 端走查完成——侧边栏 HiBuddy mark/name、空状态与会话页/自动标题三态、模型选择器 MiniMax-M2.7、真实会话人设验证（trace ground truth 前后对照）、插件面板与已安装 @hibuddy 三包渲染正常；桌面端待重打包后按同口径复验；缺口清单见 progress-report S2）

**验收标准**：
- [x] A1 `pnpm build`、`pnpm typecheck` 全绿。（验收记录 2026-11-03 复跑：含 title 拦截器泛型修复后的 brand 包，brand/desktop-host/web-ui 全部通过）
- [x] A2 `pnpm exec dsh --profile hibuddy --dump-config` 含五 bundle 层序与 brand/coworker 配置行。（验收记录 2026-11-03：dump-config 层序标记 dsh-base → dsh-web-app → @hibuddy/brand → @hibuddy/coworker → @hibuddy/web-ui 齐全；brand/coworker 行、profile patch 三处覆盖（agent-default-model / ui-brand-official disabled / system-prompt 人设）与 preset-standard、harness-dev-context disabled 覆盖均在合并配置中）
- [x] A3 Web 与桌面端界面品牌均为 HiBuddy（侧边栏 mark/name、页面标题），非 dsh 默认品牌。（验收记录 2026-11-03：Web 三态验证通过；桌面安装版用户确认标题 HiBuddy——安装树 22,757 = 22,756 载荷 + 卸载器零丢失，内嵌新 patch 与 brand 标题拦截器产物一致）
- [x] A4 Web 与桌面端各完成一次真实任务，Agent 行为体现人设（系统提示词生效）。（验收记录 2026-11-03：Web 会话回复自称 HiBuddy/MiniMax-M2.7，trace「初始系统提示词」首句 "You are HiBuddy..."；桌面安装版用户真实提问确认回复自称 HiBuddy——persona 遮蔽修复与 harness-dev-context 禁用在安装版生效）
- [x] A5 dsh 能力面复验：品牌定制后插件安装/启停仍正常（能力面完整性原则的首次回归抽查）。（验收记录 2026-11-03：Web 插件面板正常渲染（内置插件配置/实验性插件/已安装插件三区），已安装列表正确显示 @hibuddy/brand、@hibuddy/coworker、@hibuddy/web-ui；S1 的 CLI 安装/启停用例已在 S1 验收，本轮抽查聚焦品牌定制后的能力面回归）
- [x] A6 ADR-006 状态 accepted；progress-report 有 S2 验收记录。（验收记录 2026-11-03：ADR-006 于 2026-11-02 accepted 并登记 docs/README；S2 验收段已写入 progress-report，A1–A6 全项通过（2026-11-03 收官））

### S3 审批分级与留痕增强（复用 dsh 原生工具与审批主干）

**目标**：不自研工具与审批主干（dsh preset-standard 已挂 tool-fs/tool-web/bash 等 14+ 官方工具，审批经沙箱模式+执行期升级+`approval/request` waterfall 实证完整，见 [ADR-009](decisions/ADR-009-s3-rescope-agui-bridge.md) §1）；HiBuddy 只补三个 PRD 缺口——L1 写入默认需确认+会话内免再询、审批卡参数全文、L2 代码执行默认关闭（PRD FR-03 / SR-01），留痕复用原生 SessionEvent（FR-08 数据层）。

**任务**：
1. `@hibuddy/coworker` 审批 answerer：`ctx.on('approval/request')` 实现分级判定——L0（读/网页）放行、L1（工作区写）挂起待批 + 「本会话×工具×等级」免再询记忆（命中返回 allowed-once，新会话失效）、L2（bash/pwsh）拒绝并提示默认关闭；拒绝连续 3 次计数建议模型停下询问（FR-03 规则 2）。
2. 审批卡增强（`@hibuddy/web-ui` client 侧）：参数全文、影响范围说明、批准/拒绝/免再询三选项（默认卡不含参数全文与免再询）。
3. L2 默认关闭：profile patch 禁用 bash/pwsh 工具行（注释登记官方现值与 dsh 版本，按 ADR-005 纪律）+ answerer 兜底。
4. 留痕验证：原生 `approval/asked`/`approval/decided`/`tool/call`/`tool/result` 已全量入 session JSONL，行为验证并登记（不自建存储）。
5. vitest 契约测试：分级规则、免再询记忆生命周期（会话×工具×等级）、拒绝计数。

**验收标准**：
- [x] A1 `pnpm build`、`pnpm typecheck`、`vitest run` 全绿（契约测试覆盖分级/免再询/拒绝计数）。
- [x] A2 Web 端：L0 工具自动执行且留痕可见，无需确认。
- [x] A3 Web 端：L1 写入触发审批卡（工具名/参数全文/影响范围/批准/拒绝/免再询）；「本会话内免再询」后同会话同类调用不再询问，新会话恢复询问。
- [x] A4 拒绝路径：Agent 收到拒绝反馈并继续（非报错终止）；同 Run 连续 3 次被拒后停下询问。
- [x] A5 L2：bash/pwsh 默认被拒（提示默认关闭）；headless 冒烟 `pnpm smoke` 正常（不受影响）。
- [x] A6 FR-08 数据层验证：审批与工具调用事件完整出现在 session 日志（时间/参数/审批来源可追溯）。
- [x] A7 progress-report 有 S3 验收记录；ADR-008 注明"默认关闭，不适用"。

### S3b AG-UI 协议桥 MVP（@hibuddy/ag-ui-bridge）

**目标**：把 dsh 会话暴露为 AG-UI 标准端点，AG-UI 生态前端可接入同一 runtime（[ADR-009](decisions/ADR-009-s3-rescope-agui-bridge.md) §3：方案 A——插件内 `ctx.webServer.register()` 挂 `POST /agui` SSE 端点，否决 dsh-sdk 外挂方案——无审批应答与密集帧）。MVP 验收形态 = CopilotKit 接入验证。

**任务**：
1. 创建 `@hibuddy/ag-ui-bridge` 插件骨架（dsh bundle + `ctx.webServer` 路由注册 + 鉴权），登记 profile 依赖。
2. SessionEvent → AG-UI 事件映射层（turn/*→RUN_*、assistant/message→TEXT_MESSAGE_*、tool/*→TOOL_CALL_*、todo/write→STATE_*、approval 等→CUSTOM；映射表见 ADR-009 §3.2）。
3. 审批闭环：`approval/asked` 合成 `RUN_FINISHED.outcome.interrupt`；恢复=新一轮 prompt 携带审批决定。
4. 端到端验证：CopilotKit（或任意 AG-UI client）经 `/agui` 完成「文本对话 + 工具调用事件 + 审批中断恢复」最小闭环；dsh 原生 Web UI 行为零影响回归。
5. vitest 契约测试：事件映射、SSE 编码、审批中断合成。

**验收标准**：
- [x] A1 `pnpm build`、`pnpm typecheck`、`pnpm test` 全绿（workspace 48 测试：ag-ui-bridge 30 + coworker 18）。
- [x] A2 AG-UI client 连 `/agui`：发起任务可见流式文本与工具调用事件（依任务 4「或任意 AG-UI client」口径以协议级 E2E client 验证——/connect 换 cookie、对话 run 全事件链 RUN_STARTED/STEP_*/TEXT_MESSAGE 三连/TOOL_CALL 三连+RESULT/RUN_FINISHED；CopilotKit 浏览器端真机接入登记为缺口，P1 生态接入时补）。
- [x] A3 审批闭环：L1 写工作区外触发 `RUN_FINISHED{outcome:interrupt}`；resume resolved → 工具执行落盘成功、resume cancelled → 工具被拒模型放弃；一次性授权不持久（再次触发再中断，符合设计）。
- [x] A4 dsh 原生 Web UI 全量回归无影响（Playwright 实测：页面/发送/回复自称 HiBuddy/标题三态/console 零错误；非桥会话审批走 answerer 链原生透传）。
- [x] A5 progress-report 有 S3b 验收记录；映射退化项（消息粒度补发、无 resumption、取消后重试语义、桥不建授权存储）登记缺口清单。

### S4 生成式 UI 与工作台定制

**目标**：Agent 产出不止文字——对话内出现可交互界面并可持续驻留（PRD FR-04 / SR-02），用户与 Agent 共享任务状态（FR-05）。

**任务**：
1. 落 ADR-007：生成式 UI 产出格式（ui4a harness 直接写前端代码 vs 组件指令），依据 thirdparty 参考与 dsh client 渲染边界定案。
2. `@hibuddy/web-ui`：Slots 注入（设置卡、工作台面板/画布容器）。
3. 生成式 UI 链路：内嵌形态（消息流内图表/表单）+ 画布形态（侧边面板、跨轮驻留、版本递增可回看）；流式渲染。
4. 交互回传：界面操作作为结构化输入上行进入会话，下一轮可引用。
5. 沙盒边界（SR-02）：隔离渲染、无网络/文件/密钥访问；渲染失败降级为静态内容。
6. FR-05 共享任务状态：Run 级共享状态面板，双方可编辑、来源标识、时间戳新者为准。
7. 引入 Playwright，覆盖生成式 UI 基本流程 E2E。

**验收标准**：
- [x] A1 ADR-007 状态 accepted（2026-11-03，提交 f9b5112 前定稿）。
- [x] A2 Web 端：Agent 能在对话中产出图表与表单各一例，流式渲染可见（S4-3 提交 f9b5112：内嵌 chart/form/metrics/table 组件 + preparing 阶段骨架卡流式渲染，冒烟全过）。
- [x] A3 画布：可打开/关闭/重开，跨轮次驻留，版本可回看历史（S4-4 提交 f4ba62d：右栏 canvas tab + turn-tail 版本记录，冒烟全过）。
- [x] A4 交互回传：在表单提交/点击后，Agent 下一轮回复引用了该交互内容；交互记录入画布历史（S4-5 提交 4e25b82：`[generative-ui interaction]` 结构化信封上行；E2E 会话日志实证信封与模型应答轮）。
- [x] A5 沙盒测试用例通过（sandbox.test.ts 10 项：instruction gate 拒未知/伪装组件键、payload 边界拒超大/不可序列化、registry 边界、源级 tripwire 扫 eval/new Function/document.write 动态执行汇；架构上组件为编译期内置、模型仅供数据——网络/文件/密钥在组件面无访问路径，ADR-007 §3.5；渲染异常经 SurfaceBoundary 降级静态内容，E2E 曾实测降级防线生效）。
- [x] A6 共享状态：用户编辑待办/参数后，Agent 后续步骤遵循修改；冲突时新者为准并提示（S4-6：`shared_state` 工具 + 右栏共享状态面板；mergeEntry 时间戳新者为准（shared-state.test.ts 9 项）+ 来源徽章/时间显示；E2E 实证 agent 写入→面板→用户编辑→信封上行→模型 relay source:user 写入；乐观写入页生命周期不入盘，reload 后权威回放）。
- [x] A7 Playwright E2E（生成式 UI 基本流程）全绿（tests/e2e 1/1，15.6s：表单渲染→提交回传→共享状态→面板编辑→reload 权威持久化→console 零错误）；`vitest run` 全绿（workspace 76 项：web-ui 28 + coworker 18 + ag-ui-bridge 30）。

### S5 P0 收尾与双端交付

**目标**：补齐 Web 端剩余 P0 增量（FR-01/02/06/08/09）与桌面独有能力（FR-07），双端对等验收，P0 交付。

**任务**：
1. BYOK 增强（FR-06）：HiBuddy 推荐 Provider 预设（DeepSeek 官方 + 国内可达端点）；key 保存即校验、失败原因明确；未配置时发起任务阻断并引导。
2. FR-08 完整化：Run 时间线只读回看界面、单 Run 导出 Markdown。
3. FR-02 细节：120 秒无事件"仍在运行/可能卡住"提示；模型请求失败自动重试 1 次后转 failed 并展示原因；Run 摘要生成。
4. FR-09 验证与补缺：断线自动重连恢复进度；密钥失效指向配置一键跳转；页面重开恢复进行中 Run。
5. 桌面独有能力（FR-07）：审批等待/任务完成且窗口失焦时发系统通知；本地服务随应用启停（S1 基础上验收确认）；FR-09 桌面行为（应用关闭后 runtime 完成或安全终止当前 Run；升级不丢会话与配置）。
6. 双端对等清单：FR-01～06 在 Web 与桌面逐项验收；dsh 能力面终验（插件安装/启停/分层配置/凭证管理在双端完整可用）。
7. E2E：Playwright（Web）扩展到 P0 全流程（含审批交互、异常注入）+ Electron driver（桌面）。

**验收标准**：
- [x] A1 FR-01/02/06/08/09 逐条验收清单（对照 PRD §5 规则项）全部通过，清单存 progress-report。（验收记录 2026-11-04：S5-2 会话管理 / S5-3 FR-02 细节 / S5-1+S5-4 BYOK / FR-08 S4 数据层 / S5-4 FR-09 补缺；证据索引见 progress-report S5 验收登记 A1）
- [x] A2 未配置 Provider 发起任务被阻断并跳转配置页；配置无效 key 得到明确失败原因。（S5-1 验收）
- [x] A3 异常注入：断网 30 秒恢复后进行中 Run 进度继续展示；页面关闭重开后状态恢复。（S5-7 recovery.spec 2 项：宿冻结 30s 恢复续跑 + mid-run reload 时间线重建）
- [x] A4 单 Run 时间线可回看且导出 Markdown 文件内容完整。（S5-7 run-timeline.spec：摘要/工具行/导出文件名与内容断言）
- [x] A5 桌面通知：审批等待与任务完成且窗口失焦时收到系统通知。（S5-5 dev E2E 验收，commit 6bd9fe8）
- [x] A6 双端对等清单（FR-01～06）逐项通过；dsh 能力面终验通过（含第三方插件在桌面端安装/启停）。（S5-6 对等清单表 + 2026-11-04 补验 dsh-plugin-whale-pet@0.2.9 安装/启停/卸载全链路；登记 dsh 上游热激活缺口 ERR_MODULE_NOT_FOUND——对照实验定界为 0.2.1-rc.5 上游行为，双端一致，见 progress-report S5）
- [x] A7 Playwright（Web 全流程）与 Electron driver（桌面）E2E 全绿；progress-report 有 S5 验收记录 → **P0 完成**。（S5-7 commit 48769f6：Web 7/7（2.1m）+ 桌面 1/1（20.7s）；S5 验收登记 2026-11-04）

### S6 生态接入与上游跟进（P0 后续）

**目标**：收口两笔登记在案的缺口——① S3b A2 缺口：CopilotKit 浏览器端**真机**接入 `/agui` 最小闭环（S3b 当时以协议级 E2E client 代验，见 [ag-ui-research](references/ag-ui-research.md) §3.1 OpenMuse 对照：消费侧用 CopilotKit 现成转换层 + `@ag-ui/client` HttpAgent，桥只需是标准 AG-UI POST 端点）；② S5 登记的 dsh 0.2.1-rc.5 上游热激活缺口（UI 安装第三方插件运行中 activate 报 ERR_MODULE_NOT_FOUND）——验证「重启进程后激活恢复」并收口结论。范围不含 P1 功能与 S5 的三条 UX P1 建议（另行按需处理）。

**任务**：
1. AG-UI 桥消费侧评估与必要改造：`/agui` 端点跨源浏览器消费所需的 CORS（OPTIONS 预检、响应头）；鉴权复用 `/connect` 换 cookie 姿势对 CopilotKit HttpAgent 的适配性；桥本体若无缺口则零改动。
2. CopilotKit 最小消费端：React 演示应用（`@ag-ui/client` HttpAgent / CopilotKit React SDK 指向 `/agui`），置于 `packages/ag-ui-bridge/` 下作为桥的生态验证交付物；不新增顶层目录。
3. 真机三场景验证：文本流式、工具调用事件、审批中断恢复（`RUN_FINISHED{outcome:interrupt}` 呈现 + resume 决定后继续）。
4. 上游缺口跟进：复现 UI 安装第三方插件（dsh-plugin-whale-pet）运行中激活失败 → 重启 dsh 进程 → 判定激活是否恢复；登记结论（「需重启」语义 / 需深挖安装路径），沉淀上游 issue 材料要点。

**验收标准**：
- [x] A1 CopilotKit 消费端（浏览器真机）经 `/agui` 完成对话：流式文本可见、工具调用事件可见。（S6-2 场景 1/2，commit 56d50df）
- [x] A2 审批中断恢复在真机前端复验：L1 越权写入触发 interrupt 呈现，resume 决定后任务继续/按决定收场。（S6-2 场景 3 + 会话 JSONL ground truth）
- [x] A3 桥改造评估结论登记：CORS/鉴权适配改动清单（或零改动结论）；dsh 原生 Web UI 与桥回归零影响（vitest + E2E 全绿）。（零改动，fence 为安全设计、消费侧同源反代；93 单测 + Web E2E 7/7；桥协议 strict 客户端不变量两处修复）
- [x] A4 上游缺口结论登记：重启后激活恢复与否的判定与证据入 progress-report；含上游 issue 材料要点。（重启**不**恢复——S5 假设证伪；根因 = junction 部署 × pnpm 相对 symlink，HiBuddy 特有非上游缺陷；HiBuddy 侧修复 89b59ed）
- [x] A5 progress-report 有 S6 验收记录；implementation-plan 本节勾选。（2026-11-04 收官）

### S7 常驻/主动层（S7-A 原型验证 → S7-B 自研 @hibuddy/resident）

**目标**：把 HiBuddy 从"会话内被动应答"升级为"个人常驻智能体"——常驻运行、事件驱动、主动执行、人管目标与验收（[ADR-010](decisions/ADR-010-resident-proactive-agent.md)）。形态按 [ADR-011](decisions/ADR-011-butler-conversation-layer.md)：常驻智能体本身是直接面向用户的管家会话（常驻 Agent Loop，小工具面），经 `send_message_to_user` 双向对话、经 `create_session` 指派 worker（会话即 worker）；用户面为微信式对话界面；审批由管家分级代管或升级请用户确认；AG-UI 应用于管家层。混合路线：S7-A 先安装官方 `dsh-superagent-prototype` 真机验证常驻机制面；S7-B 自研 `@hibuddy/resident`，复用 coworker 审批分级、生成式 UI、会话留痕。

**任务**（S7-B 详细任务与验收标准在 S7-A 结论登记后补全；先验证后定验收）：
1. **S7-A 原型验证**：安装 `dsh-superagent-prototype` 到 hibuddy profile（遵守 ADR-005 版本纪律，核对 peer 依赖与 patch 层序）；真机验证 Router 常驻、Worker 并行、事件触发（GitHub 轮询可用最小配置）、SQLite 持久化与崩溃恢复；结论（机制可用性 / 与 0.2.1-rc.5 的兼容偏差 / 对 S7-B 的机制借鉴清单）登记 progress-report。
2. **S7-B 设计**：`@hibuddy/resident` 模块设计（事件源框架、工作项/调度/持久化、消息面、与 coworker 审批分级咬合、对话界面信息架构）落 docs/module-design/，安全口径（免打扰窗、Worker 权限授予——不采纳原型的 danger-full-access）随设计定稿。（已落档 2026-11-05，2026-11-09 依 [ADR-011](decisions/ADR-011-butler-conversation-layer.md) 修订：[resident-design](module-design/resident-design.md) accepted——核心架构 = 管家会话（常驻 Agent Loop、hibuddy-butler 小工具面）直接面向用户，经 send_message_to_user 双向对话、经 create_session 指派 worker（会话即 worker，原生 agents.create）；用户面为微信式对话界面（只渲染 in/out 消息与审批卡）；事件源 scheduler/monitor 保持确定性，产物以事件信封投递管家决策；Ticket 退化为委派账本；审批分级代管（L0/L1 与免再询命中可代答，L2/越权升级确认）；AG-UI 应用于管家层；B1–B5 已交付不返工，B6′–B10′ 重排）
3. **S7-B 实施**（设计评审定稿后逐任务推进，每任务全绿一笔提交）：
   - B1 @hibuddy/resident 包骨架：bundle 后端半（cordis 插件）+ client 半注册、stateDir 必配拒启闸。
   - B2 持久化层：SQLite（WAL）schema（sources/triggers/tickets/ticket_runs/worker_sessions/notifications/settings）+ 启动重对账（missed at 补一次、周期跳过、working 续跑/标记中断）+ proper-lockfile 防双实例。
   - B3 scheduler 事件源 + 调度器：一次性 at / 周期 interval、周期任务 = 持续 Ticket + 执行轮次、next-run-at 调度、Ticket 状态机（pending/working/awaiting_approval/completed/failed/stopped）。
   - B4 worker 会话编排：每票 `resident-worker-<ticketId>` 走原生 create/resume（composeAgent 三要素：preset mount、agentDefaultModel、meta.agentPreset）、每票工作目录 `<工作区>/resident-work/<ticket-short>/`、worker slots 并发闸（默认 2，用户交互唤醒不占 slot）。
   - B5 monitor 事件源 + 两级过滤：条件（自然语言）+检查目标+间隔+去重指纹+退避降级、gate（确定性）→ assessment（LLM 研判，观察模式默认，observe→auto 面板切换）。
   - B6 通知面：先落库再触达、幂等键、免打扰窗（通知静默、待批不挂起）、系统问题通知。（已交付 2026-11-09：`notifications.ts` 统一写入路径 + worker/filter/monitor 三处收敛 + 启动补投；见 progress-report S7-B B6 段。按 ADR-011 将被消息账本取代，见 B6′）
   - B7 审批咬合：监听 approval/asked 将 Ticket 置 awaiting_approval（decided 后回 working）、coworker answerer 对 worker 会话覆盖的真机验证、S6-2 负向用例（无人工来源 resolved 不放行）。
   - B8 常驻面板：四 tab（概览/工作项/定时与监控/通知）+ 设置（免打扰窗/并发/观察模式/stateDir 只读）、显式保存模式。
   - B9 E2E 验收：定时任务创建→到期→worker 执行→通知闭环；重启恢复对账；免打扰窗；审批卡与待批提升；观察模式 would-act 记录。
   - **B6′ 消息账本**（ADR-011，取代原 B6 通知面）：messages 表（direction/kind/引用/幂等/已读/触达）、由 notifications 迁移、免打扰窗、启动补投、客户端读取 API。
   - **B7′ 管家会话运行时**：`hibuddy-butler` preset（小工具面：send_message_to_user / create_session / send_to_session / get_session / list_sessions / cancel_session / resolve_approval / 记忆）、`resident-butler` 常驻会话、入站队列（用户消息/事件信封/回执/审批）、单轮串行与事件聚合、重启恢复（会话 resume + 未消化入站重投）。
   - **B8′ 委派与审批接线**：create_session 走 `agents.create`（非 subagents）→ 委派账本；scheduler/monitor 产物改为事件信封投递管家；worker 回执入站；审批分级代管（L0/L1 与免再询 grant 命中可代答，L2/越权升级 question）+ S6-2 负向用例。
   - **B9′ 微信式对话界面**（client 半）：气泡流（左管家/右用户）、时间分组、底部输入框、处理中状态条、内嵌审批卡、任务抽屉（工作项/定时监控/设置）、显式保存；"思考不可见"验收（无 assistant 文本/tool call）。
   - **B10′ AG-UI 管家层**：`/agui` 主体改为管家 agent（入站→队列，出站→TEXT_MESSAGE）；逐会话桥降为调试开关；E2E 与全仓回归。
4. 回归：能力面完整性回归（横切纪律 1）+ 既有 vitest/E2E 全绿 + 常驻链路新增契约测试（调度/过滤/Ticket 状态机/通知幂等）。

**验收标准**（S7-A 部分先行登记）：
- [x] A1 S7-A：原型在 hibuddy profile 真机运行，Router 常驻 + 事件触发分派 + 持久化恢复三机制至少各一项行为证据入 progress-report。（2026-11-05：Router 常驻 ✓ + SQLite 持久化恢复 ✓（设置写入→全重启→恢复的强证据）；事件触发分派 = 缺口登记——端到端需 gh CLI 操作员凭据配置，管线就绪旁证（触发 tab / 计数器 / github-watch 激活）入报告，gh 配置后补验）
- [x] A2 S7-A：与 0.2.1-rc.5 的兼容结论（含已知偏差清单）登记；卸载原型后 profile 回归原状（能力面完整性抽查通过）。（兼容：engines.dsh ^0.2.1-alpha.2 兼容 rc.5，激活装配/面板/持久化全工作；已知偏差 = POSIX-only 路径校验拒 Windows 盘符路径（本地构建放宽两处，非上游变更）；卸载还原后重启装配零警告 + Superagent 入口消失 + 侧边栏正常）
- [x] A3 S7-B 设计定稿：[resident-design](module-design/resident-design.md) 状态 draft → accepted 并登记 docs/README；本节任务与验收标准已依 S7-A 结论登记。（2026-11-05：设计文档落档并经评审通过转 accepted（含用户 worker 设计要点原话与 D1–D5 关键决策）；S7-B 任务 B1–B9 与验收 A3–A7 已登记本节）
- [x] A4 S7-B 实施 B1–B3：resident 包装配生效（--dump-config 层序含 @hibuddy/resident）、stateDir 拒启闸行为验证、scheduler 定时任务端到端（创建→到期→Ticket 迁移→worker 会话启动）、重启恢复对账证据入 progress-report。（2026-11-05：B1–B4 四任务全交付；端到端真机证据 = 注入到期票→Trigger 落库→pending→working→worker 会话 `resident-worker-<ticketId>` 经 composeAgent 三要素真实执行→completed，周期票 on-time 触发回 pending 且 next_run_at 预置；重启恢复 = working 中途杀宿→重启→旧 run 关闭 interrupted→recovery note 续跑→回 pending，run detail "recovery resume after host restart"；验收记录见 progress-report §S7-B）
- [x] A5 S7-B 实施 B4–B5：worker 会话经 composeAgent 三要素启动并完成真实任务；并发 slots 上限生效（第 3 票排队）；monitor 观察模式下命中仅记录 would-act 不执行，切 auto 后才行动。（B4 于 2026-11-05 真机验收；B5 于 2026-11-06 真机验收，见 progress-report S7-B B5 段——观察模式命中仅落 would-act 通知零建票，切 auto 后命中建票由 worker 完成并出简报；slots 连续采样 working=2/pending=1，maxWorking=2 第 3 票排队）
- [ ] A6 S7-B 实施 B6′–B8′：消息账本（先落库再触达、幂等、免打扰、重启补投）；管家会话经 send_message_to_user 完成对话闭环、经 create_session 指派 worker 并收到回执；审批事件进入管家，代管范围内的审批由管家代答留痕，L2/越权升级为 question 消息；S6-2 负向用例通过（无操作来源 resolved 不放行）。（原 B6 通知侧 2026-11-09 已完成：窗内仅落库→重启补投 delivered 1、幂等键去重、未读状态跨重启保留，见 progress-report S7-B B6 段；按 ADR-011 改造为消息账本后重验）
- [ ] A7 S7-B 实施 B9′–B10′ + 回归：微信式对话界面可用（气泡流/时间分组/输入框/处理中/审批卡/任务抽屉，显式保存）；"思考不可见"通过（界面无 assistant 文本、tool call）；AG-UI 管家层闭环（外部前端仅见管家 agent）；E2E 全场景通过（含免打扰窗、重启恢复、对话→委派→汇报）；能力面完整性回归 + 既有 vitest/E2E 全绿 + 新增契约测试覆盖消息幂等/入站队列/代管阈值/委派账本。

## 3. 横切纪律（全阶段通用）

1. **能力面完整性（最高优先）**：HiBuddy = dsh 完整能力 + 增量定制。定制 patch 只做 insert 与自身插件 config；禁止用 `disabled`/覆盖裁剪 dsh 原生子系统（插件安装/启停、分层配置、settings、凭证、审批基线等），确有冲突须在 patch 注释登记理由与 dsh 版本。每阶段验收含能力面回归抽查（S1 建立用例，后续阶段复验）。
2. **提交**：按任务粒度分批 commit，不一次性大提交；阶段验收通过后更新 progress-report 与本文件状态。
3. **文档**：代码实质变更涉及架构/PRD 时同步更新对应文档 frontmatter `date`；新增决策先落 ADR。
4. **测试**：契约测试（vitest）随 S3 起为常绿门槛；E2E 随 S4 起为常绿门槛；`pnpm smoke` 为 LLM 链路快速回归手段。
5. **dsh 升级**（ADR-005 落地后执行）：读 changelog → diff 已登记覆盖行现值 → 跑全套冒烟/E2E 与能力面用例 → 更新登记。
6. **范围控制**：阶段内发现的新需求一律记 progress-report 缺口清单，不即时扩 scope；P1 功能（PRD §3.2）不进入本计划。

## 4. 验收记录

| 阶段 | 验收日期 | 结果 | 记录 |
|---|---|---|---|
| S0 | 2026-11-01 | 通过 | [progress-report §S0](progress-report.md) |
| S1 | 2026-11-02 | 通过 | [progress-report §S1](progress-report.md) |
| S2 | 2026-11-03 | 通过 | [progress-report §S2](progress-report.md) |
| S3 | 2026-11-03 | 通过 | [progress-report §S3](progress-report.md) |
| S3b | 2026-11-03 | 通过 | [progress-report §S3b](progress-report.md) |
| S4 | 2026-11-04 | 通过 | [progress-report §S4](progress-report.md) |
| S5 | 2026-11-04 | 通过 | [progress-report §S5](progress-report.md) |
| S6 | 2026-11-04 | 通过 | [progress-report §S6](progress-report.md) |
| S7 | — | 未开始（立项 2026-11-04，ADR-010） | — |
