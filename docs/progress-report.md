---
title: HiBuddy 进度与验收报告
summary: 各阶段的验收记录与缺口清单：S0 骨架与冒烟链路（2026-11-01）、S1 基础设施复用与编译打包（2026-11-02）、S2 品牌与人设基线（2026-11-03）、S3 审批分级与留痕（2026-11-03）、S3b AG-UI 桥 MVP（2026-11-03）、S4 生成式 UI 与工作台定制（2026-11-04）、S5 P0 收尾与双端交付（2026-11-04）、S6 生态接入与上游跟进（2026-11-04）均通过——P0 交付；S7-A 原型真机验证（2026-11-05：三机制两过一缺口）；每阶段含缺口清单
keywords: [进度报告, 验收记录, 缺口清单, HiBuddy]
status: accepted
date: 2026-11-09
---

# HiBuddy 进度与验收报告

> 本报告是 [implementation-plan](implementation-plan.md) 各阶段验收标准的记录载体：每阶段验收时逐条登记结果；阶段内发现的新需求/缺口记入对应阶段的"缺口清单"。

## S0 骨架与冒烟链路（验收日期 2026-11-01：通过）

**范围**：根 pnpm workspace、profile/hibuddy + profile/hibuddy-smoke 双 profile、@hibuddy/brand、@hibuddy/coworker、@hibuddy/web-ui 三插件骨架、profile junction 同步、MiniMax 冒烟 LLM 路由（agent-default-model patch 覆盖 + .env）。

**验收结果**：
- pnpm install（601 包）成功；原生构建经 pnpm-workspace.yaml allowBuilds 批准。
- `pnpm build`、`pnpm typecheck` 全绿（修复 tsdown 0.23 fixedExtension 输出扩展名、brand slots ambient 类型两处问题）。
- `dsh --profile hibuddy --dump-config` 五 bundle 层序装配正确（base → web-app → brand → coworker → web-ui）；`dsh --profile hibuddy-smoke --dump-config` 确认 headless 层 + minimax 覆盖生效。
- 真实 LLM 冒烟（`pnpm smoke "..."`，含 MiniMax key 的网络请求）由用户执行。

**缺口清单**（转入后续阶段）：
- MiniMax 真实冒烟结果待登记（S1 验收项 A2）。
- brand 包为占位内容，待 S2 完整化。
- dsh 原生能力面完整性（插件安装/启停、分层配置）待 S1 验证（能力面完整性原则，见实施计划 §3.1）。

## S1 基础设施复用与编译打包（验收日期 2026-11-02：通过，含计划偏差）

**范围**：desktop/host（RunAsNode 宿）、desktop/shell（Electron 壳）、Windows 打包链路（pnpm deploy 双树 + electron-builder NSIS）、dsh 能力面完整性验证（CLI 插件安装/卸载、Web UI 插件管理、--patch overlay、多插件共存）、ADR-004/005。

**验收结果**（对应 implementation-plan S1 A1–A7）：
- **A1** `pnpm build`、`pnpm typecheck` 全绿（含 desktop/* 包）。
- **A2** CLI：`pnpm smoke "只回复两个字：正常"` 输出「正常」（MiniMax-M3.1-Flash 真实往返，需进程环境含 MINIMAX_CN_API_KEY）。**计划偏差**：dsh 0.2.1-rc.5 无 tui 应用/模板（PROFILE_TEMPLATES 仅 acp/web/headless/sdk/sdk-minimal），`dsh tui` 报 profile 不存在——tui 交互模式按当前运行时不可满足，不阻塞本阶段。
- **A3** Web：原生界面完成真实任务与刷新恢复（修复两缺陷：web-ui client 面 CJS 工厂注册契约；minimax-cn 路由需在 llm-pi-ai providers 显式声明 apiKeyEnv 否则 NO_ADAPTER）。
- **A4** 插件生态：CLI 安装/卸载/重装 @deepseek-ai/dsh-subagent-codex（dist-tag next，版本闸拒绝不兼容的 0.0.1-rc.1）全通过；Web UI 插件页可见、可启停、安装入口可用；--patch overlay（CLI --patch 会话层）层序验证通过后清理；HiBuddy 三插件与第三方插件共存装配正确（dsh-base → web-app → brand → coworker → web-ui → codex）。测试插件验后已卸载，profile 恢复产品构成。
- **A5** 桌面开发态：窗口加载内嵌 runtime 界面、对话任务、退出流全验证（提交 630d1c1 / af6c087）。
- **A6** 桌面打包：`HiBuddy-Setup-0.1.0.exe`（NSIS）产出；打包版宿 4.3s ready，界面加载、真实任务发送、会话持久化、刷新恢复、关闭随退全验证。**安装版终验（2026-11-03 收官，C 盘全新安装）**：①安装树零丢文件——`resources\host` 22,656 = win-unpacked 基准 22,656，总数 22,757 = 22,756 + 安装期生成的 `Uninstall HiBuddy.exe`（0.2MB 非空，与此前空间不足时 0 字节卸载器形成对照），逐文件 diff 无缺失；②安装版启动链 shell.log 全通过（shell starting → spawning host → host ready → renderer loaded），**死锁修复在安装版生效**（宿首条日志不再阻塞，ready 正常打印）；③用户完成真实任务且回复正常（模型 MiniMax-M2.7）；④关闭应用后无 HiBuddy/electron 宿进程残留，随退干净。A6 全项通过，S1 收官。
- **A7** ADR-004（D8 打包定稿）、ADR-005（版本锁定与升级策略）accepted 并登记 docs/README；本记录即 S1 验收登记。

**阶段内修复的关键缺陷**：
1. **打包版宿启动死锁**（e64f970）：GUI 子系统 shell 的 process.stdout 不可写，`child.stdout.pipe(process.stdout)` 背压阻塞宿首条 console.log；改为收集至诊断缓冲。asar 热改法验证。
2. **pnpm deploy 链接丢失**（98edb4c）：materialize dereference 静默丢弃相对 symlink（2894 个），宿 ERR_MODULE_NOT_FOUND；deploy 统一 `--node-linker hoisted`。
3. **web-ui client 加载失败**（98edb4c）：client 面须按 dsh 官方 clientBundle 契约输出 CJS 工厂（`window.__ModuleLoader__.load` 包装）。
4. **NO_ADAPTER**（98edb4c）：minimax-cn 需在 cordis.patch.yml 的 llm-pi-ai providers 显式声明（apiKeyEnv），仅覆盖 agent-default-model 不够。

**缺口清单**（转入后续阶段）：
- **S2**：brand slot 重复注册（`sidebar.brand.mark` priority 0 冲突，@hibuddy/brand 与官方 brand 并存）——已处理（2026-11-02，S2 任务 1）：官方 `ui-brand-official` 行经 profile cordis.patch.yml 覆盖为 disabled（官方浏览器半仅注册该两槽位，无其它表面损失），@hibuddy/brand 独占接管并同步接管页面标题（client 半 `document.title`，dsh 无运行时标题配置点）；`--dump-config` 已验证覆盖生效、五 bundle 层序不变；界面级验证随 S2-A3 三端走查登记。
- **运维**：dsh 不自动加载 cwd/.env，凭据依赖进程环境（用户级 setx）或 dsh credentials service；junction 下 `dsh plugin add/remove` 后必须重跑 `pnpm profile:sync`（相对 symlink 跨 junction 失效）。
- **观察项**：Web 启动初期 /plugins/events SSE 重试（自愈）；NSIS /S 静默模式限制（ADR-004 D8 登记）。
- C 盘空间：AppData\Local\uv 缓存 264GB（环境问题，非项目缺陷），建议 `uv cache clean`。

## S2 品牌与人设基线（验收日期 2026-11-03：Web 与桌面端全项通过，S2 收官）

**范围**：@hibuddy/brand 完整化（侧边栏 mark/name、页面标题）、产品级人设注入（部署级 personaPrefix）、ADR-006（Web 部署形态与访问控制）、三端回归走查与 dsh 能力面复验。

**验收结果**（对应 implementation-plan S2 A1–A6）：
- **A1** `pnpm build`、`pnpm typecheck` 全绿（2026-11-03 复跑，含 title 拦截器泛型修复后的 brand 包）。
- **A2** `--dump-config` 五 bundle 层序（dsh-base → dsh-web-app → @hibuddy/brand → @hibuddy/coworker → @hibuddy/web-ui）与 brand/coworker 配置行齐全；profile patch 覆盖（agent-default-model / ui-brand-official disabled / system-prompt 人设 / preset-standard / harness-dev-context disabled）全部在合并配置中。
- **A3** Web 与桌面端通过（2026-11-03）：Web——侧边栏 HiBuddy mark/name（fiber 确认 @hibuddy/brand 组件）、页面标题三态验证（空状态 "HiBuddy"、会话页 "<会话名> — HiBuddy"、新会话自动标题同步）；桌面——新包安装级复验通过（用户确认标题 HiBuddy）：安装树 22,757 = 22,756 载荷 + 卸载器零丢失，内嵌 profile patch（harness-dev-context disabled + preset-standard 覆盖无 persona 行）与 brand 标题拦截器产物与 Web 行为级验证一致。
- **A4** Web 与桌面端通过（2026-11-03）：Web——真实会话身份提问回复「我是 HiBuddy……由 MiniMax-M2.7 模型驱动」，trace「初始系统提示词」ground truth 首句 "You are HiBuddy, the user's everyday assistant, powered by the MiniMax-M2.7 model."，全文无 DeepSeek Harness / Web GUI 字样；桌面——用户真实提问确认回复自称 HiBuddy，persona 遮蔽修复与 harness-dev-context 禁用在安装版生效。
- **A5** Web 插件面板正常（内置插件配置/实验性插件/已安装插件三区渲染，@hibuddy 三包正确列出）；S1 CLI 安装/启停用例已在 S1 验收，本轮聚焦品牌定制后能力面回归。
- **A6** ADR-006 accepted（2026-11-02）；本记录即 S2 验收登记。

**阶段内修复的关键缺陷**：
1. **页面标题被官方组件覆盖**：dsh-client-ui-layout 内置 `DocumentTitle` 组件硬编码 `productTitle = "DeepSeek Harness"`，会话标题变化/unmount 时覆写 `document.title`——S2-1 的简单赋值方案在会话页失效。修复：brand client apply 中 `Object.defineProperty(document, 'title', ...)` 实例级 setter 拦截，将写入标题中的 "DeepSeek Harness" 改写为 "HiBuddy"（触碰全部写入者；纯显示层，存储数据不受影响）。
2. **preset persona 遮蔽部署级人设**：web 会话 agent 按 preset-standard 组装，其 `dsh-persona` 插件行以同名 section 在 agent scope 注册并遮蔽部署级 personaPrefix（dsh-persona "scope-only"，system-prompt "scoped section shadows a global section with the same name"）；prefix 置空时两种人设一起消失（空 section 渲染时丢弃）。修复：preset-standard 覆盖行中整行移除 persona 插件（preset 覆盖按行 id 替换完整 config.plugins 子列表、无深合并，其余行按官方清单重述并登记 ADR-005 升级 diff 纪律），部署级 personaPrefix 成为 web/headless 唯一人设源。
3. **harness-dev-context 第二身份源**：dsh-web-app 捆绑的 `@deepseek-ai/dsh-harness-dev-context` 注入 "The runtime context names the DeepSeek Harness implementation checkout" / "You are interacting with the user through the DeepSeek Harness Web GUI" 两段系统提示词与两条运行时上下文（DSH checkout 路径 + GUI URL），模型据此自称 DeepSeek Harness。修复：按其官方 README 口径（"Disable that row in a profile patch when the agent should not learn the harness checkout or GUI URL"）整行禁用；该插件无配置项，禁用零功能损失。

**缺口清单**（转入后续阶段）：
- **PTC preset 人设**：preset-ptc / preset-minimal / preset-cordis 仍带官方 persona（coding / helpful engineer / coding）；标准模式不受影响，PTC 模式人设接管待后续阶段（preset 覆盖需整列表重述，改动成本高，按需处理）。
- **Web 会话 hero**：会话空状态英雄区「探索未至之境」+ 鲸鱼图标仍为 dsh 默认素材（dsh-web-app hero 未接管）；P0 验收项不含 hero，登记待品牌深化阶段处理。
- **DeepSeek 字样残留（低优先级）**：内置插件配置卡「设置 DeepSeek 的搜索提供方」等官方 UI 文案；默认工作区路径 `Documents\deepseek-harness\default-workspace`（dsh 默认命名）；运行时上下文 "Current DSH file policy" 等中性缩写。均为官方文案/路径层，非系统提示词身份段。
- **桌面端**：已收官（2026-11-03）——新包 13:19 安装级复验通过：安装树 22,757 文件零丢失，内嵌新 patch 与 brand client，用户确认标题与身份人设均为 HiBuddy。

## S3 审批分级与留痕增强（验收日期 2026-11-03：通过）

**范围**：@hibuddy/coworker 审批 answerer（L2 代码执行默认关闭、L1 会话免再询授权、连续拒绝 3 次停下询问）、@hibuddy/web-ui 审批卡增强（参数全文/影响范围/免再询按钮）、preset-standard 无条件禁用 bash/pwsh、vitest 契约测试、原生留痕行为验证。复用 dsh 原生工具与审批主干，不自建（ADR-009）。

**验收结果**（对应 implementation-plan S3 A1–A7，2026-11-03）：
- **A1** `pnpm build`、`pnpm typecheck`、`pnpm test` 全绿；契约测试 18 项（vitest 5，@hibuddy/coworker）：分级规则 4 + 免再询记忆生命周期 6 + 拒绝计数 6 + 阈值常量 2，覆盖 grading 表钉死（L2={bash,pwsh}）、grant 会话×工具隔离、strike 独立计数/允许清零/turn 重置/会话销毁。
- **A2** Web 端通过（S3-2/S3-5 走查）：工作区内 L0 读写自动执行无需确认，`tool/call`/`tool/result` 全量入 session JSONL（S3-4 留痕验证）。
- **A3** Web 端通过（S3-2 + S3-5 走查）：越权写入触发增强审批卡（工具名/参数全文 JSON/影响范围/拒绝/批准/本会话免再询）；「本会话免再询」后同会话同类调用不再询问（grant 命中，answerer 1ms 代答）；**新会话恢复询问**实测通过（session-394922b1 持 write grant，新会话 session-875bf89e 同类请求再次出全卡，grant 未跨会话）。
- **A4** Web 端通过（S3-5 走查，session-875bf89e 同轮）：拒绝后模型收到拒绝原因并继续（给出后续选项，非报错终止）；指令化连试场景下连续拒绝 3 次后，第 4 次尝试命中 stop-and-ask 闸（pre-execute deny `stopAndAskReason`，无第 4 次 `approval/asked` 入痕——闸在审批管线之前），模型停止重试、向用户说明「沙箱策略 + 授权拒绝双重阻断」并请求决策。
- **A5** L2 通过：bash/pwsh 装配级禁用（--dump-config 证实 standard preset 两行 `disabled: true`，S3-3）；运行时 coworker 双闸兜底（pre-execute deny + answerer 拒绝，契约测试钉死）；headless 冒烟 `pnpm smoke` 正常（MiniMax-M3.1-Flash 应答，身份正确，无工具依赖）。
- **A6** FR-08 数据层通过（S3-4 留痕验证）：`approval/policy`/`approval/asked`/`approval/decided`/`tool/call`/`tool/result` 全量入 session JSONL（拼接 zstd 帧容器），事件链经 callId 可关联；人工决策（44.1s 时延）、免再询代答（1ms）、连续拒绝（3×rejected）均实测在案。P0 局限已登记（免再询授权在原生审计不可语义区分）。
- **A7** 本记录即 S3 验收登记；[ADR-008](decisions/ADR-008-l1-code-exec-sandbox-policy.md) 已立（accepted）注明「默认关闭，不适用」及未来开启代码执行时的重立条件。

### 留痕行为验证（S3-4，2026-11-03）

**结论**：审批与工具执行全程经原生 SessionEvent 落入 session JSONL，不自建存储（PRD FR-08 数据层复用成立）。存储形态：`~/.dsh/sessions/<workspace-hash>/session-<id>/session.v4.jsonl.zstd`，拼接 zstd 帧容器（每帧一批事件，bsdtar/libzstd 或 node:zlib 可解）。

以 S3-2 验收会话（session-b0897514，dsh 0.2.1-rc.5，46 帧）为 ground truth，事件链经 callId 全程可关联：

| 环节 | 事件 | 关键字段 |
|---|---|---|
| 会话策略 | `approval/policy` | `data.policy` |
| 升权请求 | `approval/asked` | `data.{id, toolName, callId, reason}`（reason 为模型升级理由全文） |
| 审批决策 | `approval/decided` | `data.{id, outcome}`（allowed-once / denied 等） |
| 工具调用 | `tool/call` | `data.{callId, name, arguments}`（arguments 完整参数 JSON 串） |
| 工具结果 | `tool/result` | `data.message.toolCallId` + `content` + `isError` + `meta`（操作/路径） |

两条越权写入（用户主目录，danger-full-access 升级）实测链：
1. **人工审批**：`tool/call`(seq 61) → `approval/asked`(62) → `approval/decided`(63，人工决策时延 44.1s，outcome=allowed-once) → `tool/result`(64，isError=false)。
2. **免再询自动应答**：`tool/call`(82) → `approval/asked`(83) → `approval/decided`(84，answerer 自动应答时延 1ms，outcome=allowed-once) → `tool/result`(85)。grant 命中不跳过原生审批管线——asked 照常入痕，由 answerer 在 waterfall 中代答。

**P0 局限（登记）**：免再询授权在原生审计不可区分。grant 命中时代答与人工单次批准的 `approval/decided.outcome` 完全同值（无语义标记），仅 asked→decided 时延（1ms vs 秒级）可作旁证；grant 记录仅存于 @hibuddy/coworker 进程内 grants 表（会话级，`GET /hibuddy/approvals/grants` 可查，进程退出即失，不持久化）。如需语义级审计区分「人工批准」与「免再询自动批准」，须后续以独立事件通道补注——P0 不做，登记为已知局限。

**缺口清单（S3 新增）**：
- **ptc/minimal/cordis preset 仍带 shell 工具行**（S3-3）：preset 覆盖需整列表重述、维护成本高，与 S2 的 PTC 人设缺口同性质；运行时第二道闸（coworker tools/pre-execute L2 前置 deny + approval answerer 兜底，`l2DisabledReason`）不依赖 preset 装配，覆盖全部 preset。registry 默认 preset 为 standard（已禁用）。

## S3b AG-UI 协议桥 MVP（验收日期 2026-11-03：通过）

**范围**：`@hibuddy/ag-ui-bridge` 插件（dsh bundle，[ADR-009](decisions/ADR-009-s3-rescope-agui-bridge.md) 方案 A）——`POST /agui` HTTP+SSE 端点（复用 dsh 连接栅栏鉴权：/connect 换 cookie + requestRejection）、SessionEvent→AG-UI 1.0 事件映射层、审批中断合成与 resume 回传闭环、vitest 契约测试 30 项。S3b-4 端到端验证暴露并修复四处装配/语义缺陷（inject 捕获纪律、preset 装配对齐 web composeAgent、默认模型路由、resume 优先）。

**验收结果**（对应 implementation-plan S3b A1–A5）：
- **A1** `pnpm typecheck`、`pnpm build`、`pnpm test` workspace 全绿；契约测试 48 项（ag-ui-bridge 30：事件映射 13 / SSE 编码 5 / 审批中断 9 / resume 优先 3 / terminalOf 等；coworker 18）。
- **A2** 依任务 4「CopilotKit（或任意 AG-UI client）」口径以协议级 E2E client 验证（AG-UI 1.0 wire 契约，类型对照 thirdparty/ag-ui generated/types.ts）：认证交换（/connect?token → 302+Set-Cookie）、栅栏（未认证 POST → 401、GET → 405）、对话 run 全事件链（RUN_STARTED → STEP_STARTED/FINISHED → TEXT_MESSAGE 三连 → TOOL_CALL 三连+TOOL_CALL_RESULT → RUN_FINISHED）。**CopilotKit 浏览器端真机接入登记为缺口**（P1 生态阶段补）。
- **A3** 审批闭环 E2E（写工作区外目录触发 L1 升权）：`approval/asked` → `RUN_FINISHED{outcome:interrupt, interrupts:[{reason:'tool-approval', toolCallId}]}`；resume `resolved` → allowed-once → 文件落盘成功；resume `cancelled` → cancelled → 工具被拒、模型放弃写入。一次性授权不持久（同会话再次同类请求再次中断，run3/run4 实测，符合设计）。
- **A4** 原生 Web UI 全量回归（Playwright 对 3095 实例）：页面加载、发送「你是谁」、回复自称 HiBuddy（MiniMax-M2.7）、标题三态（`HiBuddy` → 会话页 `会话名 — HiBuddy`）、console 零错误（清空历史后重载验证；更早的 3080 报错为浏览器残留会话日志）；非桥会话的审批请求经 coworker answerer 原生透传，桥不劫持（代码路径 + S3 走查双证）。
- **A5** 本记录即 S3b 验收登记；映射退化项与缺口见下。

**S3b-4 修复记录**（提交 7629b3f，E2E 暴露→逐一修复→复测通过）：
1. **inject 捕获纪律**：请求回调运行在插件注入作用域之外，懒读 `ctx.agents` 抛 "cannot get property without inject"——模块级 `export const inject` + apply() 期捕获三服务（照 ACP 桥同款注释先例）。
2. **preset 装配**：setup 内 `presets.mount`（对齐 web session-controller `composeAgent`）+ `meta.agentPreset` 记录——缺失时会话仅 working_directory 一个工具（实测 69+ 步空转的根因）。
3. **默认模型路由**：`agentDefaultModel.currentSelection()` → agentOptions 传入 create/resume——缺失时 persona 变量 `{{model}}` 无值（RUN_ERROR: prompt variable has no value）。
4. **resume 优先**：已应答的 resume 不再把末条用户文本重放为新 followup（防回传全历史的客户端造成重复回合）；抽纯函数 `planRun`（判别联合）+ 契约测试钉死。

**缺口清单（S3b 新增）**：
- **token 级流缺失（MVP 退化）**：assistant 文本以整消息单 delta 补发（TEXT_MESSAGE_CONTENT 一帧全文）；dsh 进程内 token 流无公开订阅 API（映射层注释同口径），待公开面出现后升级为逐 token 补发。
- **无 resumption（MVP 退化）**：SSE 断开后 turn 在服务端继续执行至终态，客户端重连不能重新附着同一 run（得到新 run；会话历史经 dsh resume 保留，不丢上下文）。
- **取消后重试语义待定**：resume cancelled 后模型可能重试同一工具并再次触发中断（E2E run4 终态为 interrupt 而非 success）——「取消后是否阻止同轮重试」属产品语义决策，P1 定。
- **桥不建授权存储（设计决策）**：桥侧审批应答一律一次性（allowed-once/cancelled），不推断持久 grant；原生 UI 的会话级免再询 grant 经 coworker answerer 链生效、不达桥。
- **CopilotKit 浏览器端真机接入**：A2 以协议级 E2E client 验证；CopilotKit provider/runtime 端到端接入待 P1 生态阶段（ADR-009 MVP 验收形态的完整闭环）。
- **审批审计 AG-UI 侧仅 CUSTOM 载体**：approval/asked/decided 以 CUSTOM 事件透出（AG-UI 1.0 无标准审批事件类型）；「人工批准 vs 免再询代答」语义区分同 S3 P0 局限。

## S4 生成式 UI 与工作台定制（验收日期 2026-11-04：通过）

**范围**：ADR-007 定案（组件指令而非前端代码）+ `@hibuddy/web-ui` 插件——Slots 注入、`render_ui` 工具（chart/form/table/metrics 内置组件，内嵌+画布双形态，流式渲染）、`[generative-ui interaction]` 交互回传信封、SR-02 沙盒边界（编译期内置组件 + payload 闸 + SurfaceBoundary 降级）、FR-05 共享任务状态（`shared_state` 工具 + 右栏面板，来源标识/时间戳新者为准）、Playwright E2E 套件（tests/e2e）。分 3 笔提交：S4-3 f9b5112（内置组件+内嵌流式）、S4-4 f4ba62d（画布形态）、S4-5 4e25b82（交互回传），S4-6（沙盒测试+共享状态+E2E）一笔收官。

**验收结果**（对应 implementation-plan S4 A1–A7）：
- **A1** [ADR-007](decisions/ADR-007-generative-ui-format.md) accepted（2026-11-03）。
- **A2/A3** 内嵌 chart/form/metrics/table 四组件 + preparing 阶段骨架卡流式渲染；画布开/关/重开、跨轮驻留、turn-tail 版本递增可回看（S4-3/S4-4 冒烟全过）。
- **A4** 表单提交 → `[generative-ui interaction]` 结构化信封上行 → 模型下一轮引用；E2E 会话 JSONL 实证信封与应答轮。
- **A5** sandbox.test.ts 10 项：instruction gate（拒未知/伪装组件键）、payload 边界（拒超大 256KB/不可序列化）、registry 边界、源级 tripwire（扫 eval/new Function/document.write）；架构上模型仅供数据、组件编译期内置——网络/文件/密钥在组件面无访问路径（ADR-007 §3.5）；SurfaceBoundary 渲染异常降级静态内容（E2E 排障期实测降级防线生效）。
- **A6** `shared_state` 工具（get/set，source 标识）+ 右栏共享状态面板（首个 agent 写入自动显现）；mergeEntry 时间戳新者为准（shared-state.test.ts 9 项）；用户面板编辑乐观更新（user 徽章）→ `[shared-state update]` 信封上行 → 模型 relay 写入（source:user）；乐观写入页生命周期不入盘，reload 后权威回放。
- **A7** Playwright E2E 1/1（15.6s，tests/e2e，真实 MiniMax 模型：canvas 表单渲染→填写提交→回传→共享状态 agent 写入→面板编辑→relay→reload 权威持久化→console 零错误）；vitest workspace 76 项全绿（web-ui 28 + coworker 18 + ag-ui-bridge 30）；typecheck/build 全绿。

**S4-6 过程修复记录**（E2E 走查暴露，逐一修复后复测通过）：
1. **closed() 闸**：turn-tail 消费 `PartialArguments` 时对流中视图跳过（`closed()` 未达不落库）——流式中间态曾被 canvas store 按 call id 去重后永久驻留（坏快照粘滞）；shared-state effect 同闸（value 未闭合不记）。
2. **text/value 双读**：`PartialArguments.value(key)` 只读非字符串完成值（字符串返回 undefined），共享状态 value 读取改为 `text('value') ?? value('value')`。
3. **共享状态 tab 显现 seam**：tab 类型注册 ≠ 自动出现；镜像 canvas-open 模式（`revealSharedState` 每会话每页生命周期一次）+ index.tsx 安装 opener。
4. **宿侧形状闸（assertPlainArrays）**：`render_ui` execute 按 component 校验关键数组字段为纯 JSON 数组（form.fields/chart.series+data.items/table.columns+data.rows/metrics.items），坏形状 throw → 管道落 isError 结果（`Error: <message>` 模型可读）→ 模型同轮自愈重试；正常指令仍 no-op（ADR-007 §3.2 不变）。
5. **E2E 防假绿加固**：turn 完成同步锚定原生「已完成，用时 N 秒」尾标按钮（`getByRole` 精确计数，文本匹配歧义弃用）；关键断言只认工具调用落定后的 DOM（表单元素/面板行），乐观或信封文本不可伪造；reload 权威持久化断言收尾。

**缺口清单（S4 新增）**：
- **MiniMax M2.x `{item:[...]}` 数组包装缺陷**（模型输出缺陷，非本项目代码缺陷）：该模型对 JSON 数组参数会系统性输出 proto 风格 `{item:[...]}` 包装（会话 JSONL tool/call 事件实证 5/5 复现；工具 description 强调无效；JSON 字面量照抄 prompt 下 1 次通过——稳定性随措辞/采样波动）。SR-02 降级防线按设计兜底（坏形状→静态降级不崩溃）；已加宿侧 assertPlainArrays 闸（isError + 教学文案）让模型同轮自愈；E2E 当轮模型直出纯数组未触发闸。若后续换模型（DeepSeek 官方源等）该缺陷预计自然消失，闸门保留为通用防线。
- **turn-tail 版本记录依赖客户端在线**：画布版本历史由 turn-tail 前端记录，页面未打开的历史轮不计入（dsh 会话持久化保完整工具调用，可回放渲染，但版本轴是客户端视角）。
- **共享状态 Run 级作用域为会话内存**：面板数据源 = 会话内工具调用回放 + 页面生命周期乐观写入，无独立持久化 store（会话删除即随之消失；跨会话共享属 P1 语义，未纳入）。
- **E2E 覆盖面**：单条串行 happy path（ADR-007 基本流程）；降级路径（坏形状→静态回退）由 vitest 与本轮手工走查覆盖，未入 E2E 断言（需稳定诱导模型产出坏形状，不可靠）；S5 按计划扩展 P0 全流程 E2E。

## S5 P0 收尾与双端交付（验收日期 2026-11-04：通过，P0 交付）

**范围**：BYOK 增强（FR-06）、FR-08/09 验证补缺、FR-02 细节（120s 提示/重试/Run 摘要）、FR-07 桌面独有能力（通知+服务随启停，S5-5 commit 6bd9fe8）、双端对等清单（S5-6）、全流程 E2E + Electron driver（S5-7 commit 48769f6）。

### 双端对等清单（S5-6，2026-11-04；对应 implementation-plan A6）

桌面渲染层 = 同一 dsh web bundle 直连桌面宿（ADR-004 D4）+ 同一 profile（junction 同步），功能对等 by construction；差异面仅在宿层（Electron 壳 + spawn 宿进程 + 桌面通知）。下表「走查」均指 2026-11-04 桌面 dev 宿（`@hibuddy/desktop-shell` start → Playwright 直连宿 URL）实证：

| 需求项 | Web 端证据 | 桌面端证据 |
|---|---|---|
| FR-01 会话管理 | S5-2 归档/删除/置顶/分组实测 | 走查：新会话按钮、列表按最近更新排序（相对时间摘要）、行内操作（`归档会话`/`置顶会话`/操作菜单 aria）+ 删除按钮 |
| FR-02 任务执行与生命周期 | S5-3 打断/120s 提示/重试/Run 摘要实测 | 同一 bundle 对等 + 走查任务流 UI 全要素可见（步骤、工具调用、用量、`已完成，用时 N 秒` 尾标） |
| FR-03 工具执行与审批 | S3 分级审批卡/免再询/留痕实测 | S5-5 桌面 E2E：审批卡 + 批准 + 免再询按钮可见，批准后 turn 闭环；叠加桌面通知（approval 等待） |
| FR-04 生成式界面呈现 | S4 内嵌+画布双形态、流式渲染、E2E | 走查：`render_ui` FORM 卡片（姓名输入/满意度下拉/提交按钮）桌面渲染正常 |
| FR-05 共享状态与接管 | S4 面板编辑→信封→relay、E2E | 走查：表单提交 → `[generative-ui interaction]` 信封上行（surface/component/interaction/payload 全字段）→ 模型回复引用表单值（姓名/满意度表格），relay 闭环 |
| FR-06 模型配置（BYOK） | S5-1/S5-4 | 走查：设置→模型页（DeepSeek 卡片「连接正常 (deepseek-flash)」+ 重新测试 + 添加模型提供商 + HiBuddy 推荐配置文案 + 密钥仅存本地 dsh 凭证库） |
| dsh 能力面终验 | S1/S4 `--dump-config` 五 bundle 层序 | 走查：插件页（内置插件 4 项 + 实验性插件开关 + 添加插件入口）+ 已安装四 `@hibuddy/*` 包带启停开关；实验性插件 enable→disable 实测（`pluginManager/setBundleEnabled` 桌面链路可用，操作后还原） |

**走查附加发现**：宿进程退出后客户端操作得到明确错误反馈（toast「启用失败：client api: pluginManager/setBundleEnabled failed: Failed to fetch」+ 左下角「重新连接中…」状态）——FR-09 断线反馈在桌面端正向佐证。

### 全流程 E2E 与 Electron driver（S5-7，2026-11-04，commit 48769f6；对应 implementation-plan A7）

**Web 套件（Playwright，workers=1，真实模型，7/7 通过 2.1m）**——`tests/e2e/spec/`：

| spec | 验证内容 |
|---|---|
| approval.spec.ts（3 项） | 工作区外写入触发 danger-full-access 升级审批卡：批准 → 文件落盘 + Run 时间线「已批准」行；拒绝 → 循环拒三轮后模型放弃、文件不落盘；会话免再询 → 同会话同类调用不再出卡（grant 随会话销亡） |
| genui.spec.ts（1 项） | S4 流程回归：render_ui 表单 → 提交 → `[generative-ui interaction]` 信封上行 → 模型 relay → shared_state 面板 → reload 权威持久化 |
| recovery.spec.ts（2 项） | NtSuspendProcess 冻结 dsh 宿 30s 恢复后 in-flight run 续跑完成、文件落盘；mid-run reload 页面后 run 完成 + Run 时间线从持久历史重建 |
| run-timeline.spec.ts（1 项） | Run 摘要（目标/工具调用统计/耗时）+ 工具行「完成」+ Markdown 导出（`hibuddy-run-{turn}-{ts}.md`，内容含摘要/时间线/工具调用） |

**桌面套件（Electron driver，1/1 通过 20.7s）**——desktop.spec.ts：beforeAll spawn `@hibuddy/desktop-shell` → shell.log 增量解析 host ready URL（token 字符类含 `-_`）→ 同链路走 render_ui 表单 + 审批批准落盘 + console 零错误；afterAll WM_CLOSE 优雅退出 + taskkill 兜底 + scratch 清理。桌面 spec 由独立 playwright.desktop.config.ts 承载（主配置 testIgnore 排除）。

**测试基建关键口径**（helpers.ts，供后续 spec 复用）：Lexical composer 唯一可靠输入 = Playwright `fill()`（execCommand 会被编辑器回滚）；turn 完成同步锚 = 原生「已完成，用时 N 秒」tail 按钮计数（信封/乐观写入会提前出现，不能用）；dsh 默认会话工作区（`~/Documents/deepseek-harness/default-workspace`）才是 sandbox workspace-write 根——工作区外绝对路径写入 + `ESCALATE_NOW` 指令（直接升级重试、不先征求意见）才能稳定触发审批卡，否则模型会先解释再询问（首轮 reject 测试 4 分钟超时的根因）。

### A6 残项补验：第三方插件安装全流程（2026-11-04，桌面 dev 宿 + Web 对照）

桌面 dev 宿走查 `dsh-plugin-whale-pet@0.2.9` 全链路：添加插件对话框（npm 包名 / 镜像选择 / 来源警示）→ 安装成功（对勾 + 版本 + 查看安装任务 + 立即启用）→ 已安装列表与 `@hibuddy/*` 4 包共存 → 详情页（组件 whale-pet / 来源 `dsh-plugin-whale-pet@^0.2.9` / 版本）→ 组件级开关停用（「已关闭 / 1 已停用」）→ 恢复启用 → 卸载确认 → 卸载还原（无残留）。失败路径同验：`@deepseek-ai/dsh-subagent-codex` 被版本闸拒绝且原因明确（`declares no dsh.bundle`）。

**登记缺口（dsh 上游，非 HiBuddy 缺陷）**：运行中进程热激活新装第三方插件失败——宿侧报 `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-plugin-whale-pet' imported from C:\Users\chenb\.dsh\profiles\hibuddy\lib/index.js`。对照实验定界：CLI 启动的 dsh web（冒烟 3080）复现完全相同错误 → dsh 0.2.1-rc.5 上游行为（模块解析根不含运行期新装包；重启进程预期恢复），双端一致、HiBuddy 扩展面无可修点。S6/dsh 升级时跟进验证「重启后激活」。

### S5 验收登记（对应 implementation-plan A1–A7，2026-11-04 收官）

- **A1** FR-01/02/06/08/09 逐条验收通过——FR-01 会话管理（S5-2）、FR-02 细节（S5-3）、FR-06 BYOK（S5-1/S5-4）、FR-08 留痕（S4 数据层 + 会话 JSONL 核验）、FR-09 断线恢复/密钥跳转/重开恢复（S5-4 补缺）；双端对等证据见上方 S5-6 清单表。
- **A2** 未配置 Provider 阻断并跳转配置页、无效 key 明确失败原因（S5-1 验收）。
- **A3** 异常注入：宿冻结 30s 恢复后 Run 续跑、页面重开状态恢复（S5-7 recovery.spec 2 项）。
- **A4** Run 时间线回看 + Markdown 导出完整（S5-7 run-timeline.spec）。
- **A5** 桌面通知：审批等待/任务完成且窗口失焦提醒（S5-5 dev E2E 验收）。
- **A6** 双端对等清单 FR-01～06 逐项通过（S5-6 表）；dsh 能力面终验：第三方插件安装/启停/卸载全链路走查通过（本轮补验，上游热激活缺口已登记）。
- **A7** Playwright（Web 7/7）与 Electron driver（桌面 1/1）E2E 全绿；本记录即 S5 验收登记 → **P0 完成**。

### S5 UX 评审（双端交互走查汇总，2026-11-04）

**P0 交互验证结论**：双端关键路径交互闭环——会话管理（归档/删除/置顶 aria 完整）、任务生命周期（打断/120s 停顿提示/重试/Run 摘要）、审批卡（工具名/参数全文/影响范围/批准/拒绝/免再询）、生成式 UI（preparing 骨架 → 流式渲染 → 画布驻留/版本回看）、断线反馈（toast + 「重新连接中…」）、桌面通知（失焦审批等待/完成提醒，含通知抑制）；E2E 全程 console/page 零错误。

**UX 观察与 P1 建议**（均为体验优化，不阻塞 P0）：
1. **插件热激活失败的开关语义**：组件 activate 失败（dsh 上游缺口，见上节）后行内开关仍为开启态、状态文本「未运行」——失败后开关回弹或显示错误态会更直观（dsh 上游组件，P1 随升级跟进）。
2. **添加插件对话框按钮可及性**：主按钮「安装」与镜像下拉「安装源」仅一字之差，屏幕阅读器/自动化选择器场景有歧义（视觉无碍）。
3. **Run 时间线入口发现性**：入口在右栏 start-door 引导胶囊，会话进行中打开需先点「打开右侧边栏」——P1 可考虑在 turn tail 上加时间线直达入口。

## S6 生态接入与上游跟进（验收日期 2026-11-04：通过）

### 消费侧评估：CORS 与鉴权（S6-1，桥零改动）

结论：**桥本体零改动**。dsh 的 fence 栅栏（Origin/Host 须与 authority 同源 + `/connect` 换 cookie）是有意安全设计，不做跨源放开；消费侧以**同源反向代理**接入（demo 的 vite proxy：`/connect` 与 `/agui` → dsh 3080，`changeOrigin` + 覆写 `origin` 头同 authority），SSE 无压缩流式透传即通。连通性实测：无效 token 401、未过栅栏 403、过栅栏探针 GET `/agui` 405；AG-UI 桥在 answerer 层捕获审批、不依赖 mux 转发，不受 dsh API 默认 `interactions=none` 的 cookie 配置影响。

### CopilotKit 最小消费端真机三场景（S6-2，commit 56d50df）

交付 `packages/ag-ui-bridge/examples/copilotkit-demo/`（独立 workspace，不入根构建）：React 19 + `@copilotkit/react-core` v2 + `@ag-ui/client` HttpAgent（钉 1.0.2）。关键接线（CopilotKit v2 API 实证）：`CopilotKitProvider` 必须传 `agentId`（否则 `useInterrupt` 解析不到默认 agent 渲染崩溃）+ `agents__unsafe_dev_only` 注入实例 + `credentials:"include"` 携带栅栏 cookie；`useInterrupt` 渲染审批中断卡（批准 = resolve / 拒绝 = cancel）；`useDefaultRenderTool()` 提供内置工具卡。

三场景真机联调通过（dsh web 3080 + MiniMax-M3.1-Flash）：
1. **流式文本**：两轮对话回复流式落屏。
2. **工具调用**：glob/working_directory/read 全链路 + 工具渲染器警告消失（协议层证据）+ 答复正确渲染。
3. **审批中断 → resume**：L1 越权写入触发 interrupt 卡 → 批准 → resume POST（`RunAgentInput.resume`，`status:'resolved'`）→ 同 turn 续跑 → 文件落盘内容正确；dsh 会话 JSONL ground truth：`approval/asked` → `approval/decided allowed-once` → 同 turn 后续 step → `turn/end completed`。

**桥协议修复（strict 客户端不变量）**：`@ag-ui/client` 1.0 严格状态机拒绝「steps 未关闭时 RUN_FINISHED」与「孤立 STEP_FINISHED」——桥在审批捕获与 turn 终局两条路径先补 `STEP_FINISHED`（`MappingState.openStep` 跟踪），resume 后新 run 收到中断前 step 的 `step/end` 为孤立事件、条件映射丢弃。补 4 项契约测试。

**回归**：桥 35 + coworker 18 + web-ui 40 = 93 单测全绿；Web E2E 7/7 全过。其中 recovery ×2 + run-timeline 首轮超时失败，session JSONL ground truth 定界为**测试环境问题**：dsh web 实际工作区为 `D:\HibuddyWorkspace`（用户改过默认工作区路径），与测试默认 `~/Documents/deepseek-harness/default-workspace` 错位——「工作区内写入」预期全部落到沙箱外被拒，模型行为分叉（自行升级审批 / ask_user_question）导致 turn 挂死；以 `HIBUDDY_E2E_WORKSPACE` 对齐后 53s 全过（approval/genui 不受错位影响故首轮通过）。

**观察项（CopilotKit v2 客户端行为，未定论）**：process C 轮审批捕获后 7.4s 出现**无人工点击的**自动 resume POST（`status:resolved` → `allowed-once`）。performance 时序见三笔 POST（其一无 turn 对应）；对照 CopilotKit `run-handler.ts` follow-up 机制（非 `tool_call` reason 中断应返回 waiting 不续跑）机制未完全定论。桥契约本身无违规（resume POST 合法触发 answerPendings），但「无人工批准即 allowed-once」具安全含义——登记为 CopilotKit v2 客户端行为观察项，S7-B 常驻层设计审批面时复核。

### 上游缺口定界：热激活 ERR_MODULE_NOT_FOUND（S6-3，commit 89b59ed）

S5 登记的「重启进程预期恢复」假设**证伪**——真机复验：UI 装 `dsh-plugin-whale-pet@0.2.9`（安装成功、package.json 登记 dependencies + `dsh.profile.plugins`、包落 profile node_modules）→ 运行中启用无报错（懒加载，activate 不在运行时触发 import）→ **重启后装配期失败**：`dsh: warning: 1 entry did not activate` + `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-plugin-whale-pet' imported from C:\Users\chenb\.dsh\profiles\hibuddy\`（提示 `Did you mean to import ".../lib/index.js"?` 为 exports 误报，实际 exports 有 `.` 主入口）。

**根因（HiBuddy 特有，非 dsh 上游缺陷）**：plugin-manager 经 pnpm 安装生成**相对 symlink**（`..\..\..\node_modules\.pnpm\<pkg>@ver\...`，基准 = node_modules 目录）；原生部署下相对目标可解析，而 HiBuddy profile 经 junction 映射进 `$DSH_HOME/profiles/hibuddy`——dsh 从 junction 路径启动时相对基准落到 `C:\Users\chenb\.dsh\`，断链。对照实验：同一 symlink 从真实路径 `D:\GenUI\profile\hibuddy` import 成功、从 junction 路径失败；`@hibuddy/*` workspace 链接为**绝对** symlink（pnpm workspace link 行为）故不受影响。S2 的 absolutize 修复只覆盖 `@scope/` 下 workspace 链接、漏顶层 registry 包。

**修复（HiBuddy 侧可修，commit 89b59ed）**：`sync-profile.ps1` absolutize 逻辑扩展到 node_modules 顶层（registry 包 symlink），以 **Junction** 重写（无需管理员提权，沙盒受限环境可用）。验证：absolutize 后 junction 视图 import OK；dsh 重启装配无激活警告；client 宠物组件正常渲染（完整链路此前已走通）。**用户口径：UI 装/卸第三方插件后跑一次 `pnpm profile:sync` 即修复链接。**

**上游 issue 材料要点**（如需反馈 dsh 上游）：① plugin-manager 的 pnpm add 建议产出绝对链接或 Junction（Windows）；② 激活失败的行内开关仍为开启态、状态文本「未运行」（S5 UX P1 同源）；③ exports 误报提示（`Did you mean to import .../lib/index.js?` 与实际 exports 不符）。

### S6 验收登记（对应 implementation-plan A1–A5，2026-11-04 收官）

- **A1** CopilotKit 消费端浏览器真机经 `/agui` 完成对话：流式文本 + 工具调用事件均可见（S6-2 场景 1/2）。
- **A2** 审批中断恢复真机复验：L1 越权写入触发 interrupt 卡，批准后 resume 续跑、文件落盘正确（S6-2 场景 3 + JSONL ground truth）。
- **A3** 桥改造评估结论：零改动（CORS/鉴权为 dsh fence 安全设计，消费侧同源反代接入）；回归 93 单测 + Web E2E 7/7 全绿；桥协议 strict 客户端不变量两处修复 + 4 项契约测试。
- **A4** 上游缺口结论：重启**不**恢复（S5 假设证伪）；根因 = junction 部署 × pnpm 相对 symlink（HiBuddy 特有，非上游缺陷）；HiBuddy 侧修复落地（89b59ed）+ 用户口径 + issue 材料要点。
- **A5** 本记录即 S6 验收登记；implementation-plan S6 节已勾选。

## S7 常驻层与生态收尾（进行中）

### 原型真机验证：dsh-superagent-prototype 装配 hibuddy profile（S7-A，2026-11-05）

**目的与方法**：常驻层设计（S7-B）前，把 dsh 上游 super-agent 原型真机装入 hibuddy profile，验证「Router 常驻 / 事件触发分派 / SQLite 持久化恢复」三机制的可装配性与行为。原型 npm 包 `dsh-superagent@0.1.0` 未发布 npm：robocopy 复制 thirdparty 仓库到临时构建目录（排除 .git/node_modules，thirdparty 只读不动）→ pnpm install + build（lib/ 产出）→ npm pack 产出 tgz → profile 以 `file:` 依赖装入（dependencies + bundles 数组插行 + profile 层 cordis.patch.yml 配 `stateDir`，插件拒绝无 stateDir 启动）。

**Windows 适配（本地构建调整，非上游变更）**：原型两处路径校验为 POSIX-only（`/^\//`，deployment.ts 的 absolute() helper 与 policy.ts 的 executor.directory），拒绝 Windows 盘符路径——临时构建副本放宽为 `(?:[A-Za-z]:[\\/]|\/)` 后重建重装。S7-B 设计若采纳此形态，需在上游反馈或正式 fork 中处理。

**激活成功**：dsh web 启动无激活警告；侧边栏出现 Superagent 入口，面板六 tab（概览/来源/触发/评估/执行/设置）全部工作。部署自检报告 2 条系统问题（符合预期——无 GitHub 配置）：「部署检查未通过，dsh-superagent 暂不接单（GitHub 来源没有设置监听的仓库）」「没有人能发送工单（各来源上的名单都为空）」；执行器等待部署检查。

**三机制行为证据**：
1. **Router 常驻 ✓**：面板激活 + 自检轮询运转 + github-watch 组件激活 + orchestrator.sqlite WAL 持续活动（140KB 帧活动）。
2. **SQLite 持久化恢复 ✓（强证据）**：设置 tab 将「接收仓库里的新 Issue」开关 OFF→ON → 显式保存 → SQLite 主文件 4096→118784 字节（WAL checkpoint 归零，写入确实落盘）→ **强杀进程全重启 + 新 token** → 开关仍为 ON。该配置默认 OFF 且启动过程无重算来源，恢复只能来自 orchestrator.sqlite；重启后面板「系统问题 2 条」亦一致恢复。
3. **事件触发分派 ✗（缺口登记）**：端到端分派需 GitHub 来源配置 = 监听仓库 + 智能体的 gh CLI 认证 + push 权限（`gh auth login` 操作员凭据步骤），本机无 gh CLI，无法真机触发 Issue/@提及 → 评估 → 工单分派链路。旁证：触发管线 UI 就绪（触发 tab 线程过滤器/状态芯片、概览页 到达/被过滤/已评估 计数器）。**缺口**：gh 操作员配置后补验；S7-B 常驻层若沿用 Source 形态，事件分派验收同此口径。

**工程发现（S7-B 设计输入）**：
- 部署配置闸：stateDir 必配，缺失拒启——常驻组件的持久化目录是部署级硬约束，好形态。
- 面板设置为显式「保存 / 放弃修改」模式（按 block 保存，SettingsSave），非自动保存。
- proper-lockfile 强杀进程后无残留锁文件（stale 检测有效），干净重启无「Lock file is already being held」。
- 面板状态重启后由 SQLite 重读（含系统问题、来源实例状态），自检数据在 WAL 活动。
- dsh CLI 无 `web` 子命令——默认启动即 web 服务（`http://127.0.0.1:3080/?token=...`）。

**S7-A-A2 还原（profile 回归原状）**：profile package.json（dependencies + bundles 两处）与 cordis.patch.yml S7-A 配置块移除；pnpm-lock.yaml git 还原；`pnpm install --no-frozen-lockfile` 剪除 73 包、`profile/hibuddy/node_modules/dsh-superagent` 链接移除；删除临时构建目录与 `C:\Users\chenb\.dsh\state\superagent` 状态目录。工作树唯一残留 diff 为用户有意改动（cordis.patch.yml reasoningEffort: low），不入提交。

### S7-B 验收登记：B1–B4 持久化/调度/worker 编排（对应 implementation-plan A4，2026-11-05）

**交付**（各任务一笔提交）：B1 包骨架 + stateDir 拒启闸（4dec2bd）；B2 SQLite(WAL) 编排存储 + proper-lockfile 单实例锁 + 启动重对账（b36391d）；B3 调度器 + Ticket 状态机（940023d）；B4 worker 会话编排（本提交）。包内 vitest 67 例全绿（B1 lock 3 + B2 store 24 + B3 调度/状态机 24 + B4 worker 16）；全仓 typecheck/build 绿；`dsh --profile hibuddy --dump-config` 层序含 `@hibuddy/resident`（config stateDir 必配）。

**B4 实现要点**：
- worker = 普通 dsh 会话：每票确定性 id `resident-worker-<ticketId>`（brandString），经 `ctx.agents.create/resume` 原生 create/resume；composeAgent 三要素照 web session-controller 模式（`presets.mount(agentCtx, id)` setup 内 + `agentDefaultModel.currentSelection()` 展开进 agentOptions + `meta.agentPreset`），与 @hibuddy/ag-ui-bridge 已真机验证的 openHandle 同构。
- 工作目录 `<工作区>/resident-work/<ticket-short>/`（dsh 沙箱 workspace-write 根内，派工时 mkdir）；worker slots 默认 2（settings `workerSlots` 可调），canDispatch 先于任何状态变更，拒绝的票留 pending 下个 tick 重试。
- 轮次生命周期：startRun → open（registry 活实例复用 → resume → create）→ followup(目标+轮次注记) → whenIdle+子代理排空 → sessions.flush → summarizeRound（headless 口径：末条 turn/end reason=completed 且无 agent/error）→ finalize（一次性→completed、周期→pending 保留预置 next_run_at、blocked 留 working 置 awaiting_approval 由 B7 接管、其余→failed 不自动重试 §13.1）。派工失败（open 抛错）→ ticket failed + run outcome failed。
- 恢复钩子：reconcile `resumeWorker` 落地——先关被中断的开放 run（interrupted）再续跑，recovery note 注入提示（先检查工作目录与既有进度避免重复外部动作）；成功后票回 pending/completed，周期票 next_run_at 过期时经 nextOccurrence 重算。
- 轮次结束**不 dispose** 会话句柄（dispose 会把 session 从 store 移除）；空闲实例留 registry 由 `agents.get` 复用。

**端到端真机证据（A4 口径，MiniMax-M3.1-Flash）**：
1. **一次性补偿触发**：注入过期票 tkt-e2e-oneshot（next_run_at 早于 now 数小时）→ 宿启动首 tick 触发，Trigger 落库 `late:true` → pending→working → worker 会话 `resident-worker-tkt-e2e-oneshot` 创建并真实执行 → 工作目录落盘 `D:\GenUI\resident-work\tkt-e2e-oneshot\hello-resident.txt`（内容与目标一致）→ run outcome `ok`（detail 前缀 "late compensation"）→ 票 completed，summary 为模型最终回复全文；会话 JSONL 持久化于 `~/.dsh/sessions/--D-GenUI-resident-work-tkt-e2e-oneshot--/`。
2. **周期 on-time 闭环**：tkt-e2e-loop（interval 10min）到期准点触发（`late:false, periodic:true`）→ 完成后回 pending，next_run_at = 预置下一轮（准点 +10min，非重算），summary/run/worker_sessions 三表同步。
3. **重启恢复对账**：下一轮 working 后 2.9s 强杀宿 → 重启 → 对账：旧 run（id 3）关闭 outcome `interrupted`，票恢复续跑（run 4 started 于宿 ready 后 1s 内）→ detail 前缀 "recovery resume after host restart"，模型明确报告「检查了工作目录与上一轮产物、避免重复外部动作」后增量完成 → 回 pending。
4. **会话真续用**：恢复轮模型引用了上一轮写入的文件内容与时间戳（同会话上下文），证实 resume 复用了持久化会话而非新会话。

**真机暴露并修复的缺口**：原 reconcile 在 resume 钩子成功路径上跳过开放 run 的关闭，遗留孤儿 run（finished_at 永空）。修复：working 票对账时**先**无条件关闭开放 run（interrupted）**再**调钩子；补回归测试 1 例（resumed 路径旧 run 必须关闭）。修复后包内 67 例全绿。

**验收后清理**：E2E 测试票置 stopped、宿进程停毕无残留；`resident-work/` 入 .gitignore（运行期产物）。

**缺口与后续**：①B4 阶段 worker 轮次结束保持会话句柄存活（不 dispose），长周期多票下内存占用待观察（个人场景可接受）；②`turn/end blocked`（审批挂起）的恢复与 awaiting_approval 提升是 B7 审批咬合的范围；③E2E 用直接 SQLite 注票（面板建票入口在 B8）——与 B3 真机口径一致。

### S7-B 验收登记：B5 monitor 事件源 + 两级过滤与观察模式（对应 implementation-plan A5 收口，2026-11-06）

**交付**（本提交）：`sources.ts`（SourceKind registry，后续事件源零改动接入）+ `monitor.ts`（monitor 事件源：条件/间隔/指纹/退避降级）+ `session-check.ts`（检查/研判会话，composeAgent 三要素）+ `filter.ts`（gate→assessment→observe/auto）+ index.ts 接线。包内 vitest 90 例全绿（新增 monitor 16 + filter 8）；全仓 typecheck/build 绿；dump-config 装配回归正常。

**B5 实现要点**：
- monitor 实例配置 = `{target, condition, intervalMs, name?, goal?}`（`source_instances.config`）；游标 = 指纹/lastCheckAt/failureCount（`source_instances.cursor`）；轮询 `next_run_at` 索引与 scheduler 同纪律，检查在途不重入，面板可动态启停。
- **指纹宿侧确定性计算**（真机教训，见下）：检查目标（本地路径 fs 读 / http(s) fetch）由宿读取原文并 sha256 前 16 位作指纹；检查会话只做条件研判（内容节选入 prompt，无需工具）。快照不变不发 Trigger（幂等）。
- 退避：连续失败按 interval×2^(n−1) 倍增、封顶 30min；连续 3 次失败标记 `degraded` 并出一次性 system 通知记录（FR-10 规则 3；触达面属 B6）；成功即清零自恢复，面板只展示状态。
- 两级过滤（设计 §6）：gate（确定性）= 来源启停 + 同源开放票去重（pending/working/awaiting_approval 存在即 skip）+ payload 校验；assessment（LLM）仅 inferred 候选（monitor 命中），输入 = 条件 + 检查依据 + 相关票上下文（近 5 条同源票）；研判 act=false 则 skip（不记录）。**观察模式默认**：act=true 仅落 would-act 通知（幂等键 `monitor:<id>:would-act:<指纹>`，同指纹去重）不执行；`settings.observeMode=false`（B8 面板切换）后命中建票 mandate=inferred、origin=`monitor:<id>`、next_run_at=立即到期（照走 scheduler slots 闸）。研判/检查复用同一常驻短会话 `resident-monitor-<sourceId>`（确定性 id 跨重启 resume）。

**端到端真机证据（A5 剩余口径）**：
1. **观察模式**：注入 monitor 实例（目标 = 工作区文件，间隔 20s）→ 写入告警内容 → 命中 Trigger 落库（指纹 = 内容哈希）→ **仅落 would-act 通知**（type=report，幂等键含新指纹）→ monitor 相关票数 0（未执行）。
2. **切 auto 后行动**：SQLite 置 `observeMode=false` + 换新告警内容 → 命中建票 tkt_1b6e936f（origin=`monitor:mon-e2e-1`）→ scheduler 派工 → worker 会话真实执行 → completed + 简报入 summary + worker_sessions 落行；模型研判还正确区分了「先前命中已记录」与「新告警需处理」（会话上下文复用生效）。
3. **slots 并发闸（第 3 票排队）**：并发注入 3 张多步票 → 每 2s 采样 SQLite：连续 6 个采样 **working=2 / pending=1**，maxWorking=2——第 3 票排队后执行。

**真机暴露并修复的设计缺口**：第一版指纹取自模型自由文本摘要（fingerprintInput），两次检查对同一快照给出不同摘要 → 指纹不同 → **重复触发**。修复：指纹改为宿侧对目标原文的确定性哈希（session-check `readTarget`：路径 fs 读、URL fetch 10s 超时），模型只输出 `{conditionMet, rationale}`；同内容永不重复触发（实测验证）。附带收益：检查会话不再需要读文件，单轮纯研判更快更省。

**验收后清理**：monitor 实例置 disabled、测试文件与临时脚本删除、宿进程停毕无残留。

**观察与后续**：①monitor/worker 会话的模型路由取 `agentDefaultModel.currentSelection()`，本机实测解析到 deepseek-official/deepseek-flash（DEEPSEEK_API_KEY 在用户环境时），与 profile `agent-default-model→minimax-cn` 的 patch 优先级关系待与 B7/B8 一并核对（不影响功能，路由有效）；②同指纹重复命中的去重靠通知幂等键与研判会话记忆双保险，B8 面板展示 would-act 记录列表时再评估是否需要专门的观察记录视图；③URL 目标已支持（fetch），网页类目标的大文本节选截断策略（6000 字符）留观察。

### S7-B 验收登记：B6 通知面（对应 implementation-plan A6 前置收口，2026-11-09）

**交付**（本提交）：`notifications.ts`（唯一通知写入路径）+ store 补 `listNotifications(undeliveredOnly)` / `countUnreadNotifications` / `markNotificationDelivered` + domain 补 `quietExceptions`；`filter.ts` / `monitor.ts` / `worker.ts` 三处直接落库全部收敛到通知服务，index.ts 构造单实例注入并在启动时执行一次补投。包内 vitest 105 例全绿（新增 notifications 13）；全仓 typecheck/build 绿；dump-config 装配回归正常。

**B6 实现要点**（设计 §9）：
- **先落库再触达**：`notify()` 一律先 `store.addNotification`，写成功且非静默才 `markNotificationDelivered` 置 delivered；写库失败直接兜底返回 `{recorded:false}`，绝不因触达异常影响编排主流程。
- **幂等键**：调用方可显式传（monitor 降级 `monitor:<id>:degraded`、would-act `monitor:<id>:would-act:<指纹>`），默认则由 `contentKey(type, ticketId, title, body)` 生成 `<ticketId|global>:<type>:<sha256 前 16 位>`；唯一约束命中即视为重复，返回 `{recorded:false}`，不重复触达。
- **通知类型四处接线**：worker 完成 → `result`（正文取轮次摘要）；worker 启动失败 / 轮次失败 → `system`；监控降级 → `system`；观察模式 would-act → `report`。blocked/awaiting_approval 的通知仍留 B7（与审批咬合一并落地）。
- **免打扰窗**：`settings.quietHours = {start, end}`（`HH:MM` 本地时间，`end < start` 跨午夜，`start === end` 视为空窗，畸形值忽略不阻塞投递）；窗内一律只落库、`delivered=0`，**窗内暂停的是 PUSH 而非 ticket 状态**（审批待批不挂起）。`settings.quietExceptions = ticketId[]` 例外清单，例外票据的通知在窗内照常触达。
- **补投**：`deliverPending()` 扫「未投递 + 未读 + 当前非静默」补触达并返回条数；宿启动在对账之后调用一次——对账已把 awaiting_approval 通知重新置为待投递，此步即完成重启后的补偿。
- **读侧接口**：`unreadCount()` / `list({unreadOnly})` / `markRead()` / `markAllRead()` 供 B8 面板未读计数与通知 tab 直接消费。

**端到端真机证据（A6 通知侧口径）**：
1. **窗内仅落库**：`settings.quietHours` 置为覆盖当前时刻的窗口 → 注入一次性票 tkt-b6-notify（目标：工作目录写文件并简报）→ worker 真实执行至 completed → 通知行落库 `type=result`、`delivered=0`，幂等键 = `tkt-b6-notify:result:21a006e62dd22a95`（内容指纹）。
2. **重启补投**：停宿 → 关窗（空窗）→ 重启宿 → 启动补投把该行置 `delivered=1`，B5 遗留的两条 would-act `report` 同批补投（共 3 条 → 全部 delivered=1），通知内容与未读状态跨重启完整保留。
3. **幂等去重**：同一幂等键重复写入返回 `{recorded:false}` 且不新增行（单测覆盖显式键与内容指纹两路）。

**验收后清理**：tkt-b6-notify 置 stopped、宿进程停毕无残留、临时查询/注票脚本删除（均在系统临时目录，未入库）。

**观察与后续**：①触达渠道首批只有常驻面板（未读计数 + 通知 tab），桌面通知/IM 属后续渠道扩展，`delivered` 语义已按「已触达任一渠道」预留；②免打扰窗与例外的面板编辑入口在 B8；③`result` 通知默认用内容指纹去重——周期任务连续两轮产出完全相同的简报时只留一条，若面板需要逐轮留痕，B8 再评估改为带轮次号的显式键。

