---
title: HiBuddy 进度与验收报告
summary: 各阶段的验收记录与缺口清单：S0 骨架与冒烟链路（2026-11-01）、S1 基础设施复用与编译打包（2026-11-02）均通过；S2 起按实施计划的验收标准逐阶段登记
keywords: [进度报告, 验收记录, 缺口清单, HiBuddy]
status: accepted
date: 2026-11-02
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

## S3 审批分级与留痕增强（进行中：S3-1/S3-2/S3-3 已提交，留痕验证已登记，验收待 S3-5）

**范围**：@hibuddy/coworker 审批 answerer（L2 代码执行默认关闭、L1 会话免再询授权、连续拒绝 3 次停下询问）、@hibuddy/web-ui 审批卡增强（参数全文/影响范围/免再询按钮）、preset-standard 无条件禁用 bash/pwsh、原生留痕行为验证。复用 dsh 原生工具与审批主干，不自建（ADR-009）。

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
