---
title: HiBuddy P0 实施计划
summary: P0 的分阶段执行计划（S1–S5）：S1 先把 dsh 基础设施三端（CLI/Web/桌面）全部复用跑通、验证 dsh 原生能力面完整性（插件安装/启停/分层配置）并建立编译打包链路，S2 起再按 PRD 需求做深度定制（品牌人设→核心工具/审批→生成式 UI→收尾双端交付）；每阶段含可判定的验收标准
keywords: [实施计划, 里程碑, 验收标准, P0, 分阶段交付, 基础设施复用, 插件生态, HiBuddy]
status: accepted
date: 2026-11-02
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
| S3 | 核心插件：内置工具 + 审批分级 | FR-03、SR-01、FR-08（数据层） | —（ADR-008 条件性，见下） | 工具按 L0/L1 分级审批执行、免再询生效、全程留痕 |
| S4 | 生成式 UI 与工作台定制 | FR-04、SR-02、FR-05 | ADR-007 | 对话内出现可交互界面（内嵌+画布）、交互可回传 |
| S5 | P0 收尾与双端交付 | FR-01、FR-02、FR-06、FR-08、FR-09 + FR-07 | — | Web 端收尾 + 桌面独有能力 + 双端对等验收，P0 完成 |

依赖顺序：S1 → S2 → S3 → S4 → S5。S1 建立的三端载体（同一 `hibuddy` profile）在后续阶段被全部复用：S2–S4 的定制（后端插件 + client 模块 + Slots）天然同时作用于 CLI/Web/桌面，故各阶段验收以 Web 端为主、S5 统一做双端对等验收。

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
- [ ] A6 桌面打包：产出 Windows 可安装包；安装后应用可启动并跑通一次任务；关闭应用后 runtime 进程随退（无残留）。（安装包已产出；win-unpacked 同产物启动/任务/随退已验；安装树比对完成 2026-11-03——`resources\host` 22,656 = 基准 22,656 零丢失，总数 22,757 = 22,756 + 安装期生成的卸载器 Uninstall HiBuddy.exe，注册表卸载项正常写入；剩安装后启动/任务/随退验证）
- [x] A7 ADR-004、ADR-005 状态 accepted 并登记 docs/README；progress-report 有 S1 验收记录。

### S2 品牌与人设基线（定制起点）

**目标**：第一个需求定制阶段：以 dsh 官方 brand 路径替换默认品牌，注入 HiBuddy 最简人设；验证"同一 profile 三端一致"；定制后 dsh 能力面不回归。

**任务**：
1. `@hibuddy/brand` 完整化：HiBuddy 名称、侧边栏 mark、页面标题（官方 brand slots 路径）。（已落地 2026-11-02：官方 `ui-brand-official` 行经 profile cordis.patch.yml 覆盖为 disabled——官方浏览器半仅注册 sidebar.brand.mark/name 两槽位，无其它表面损失，@hibuddy/brand 独占接管消除双注册；页面标题经 brand client 半设 `document.title`——dsh 0.2.1-rc.5 无运行时标题配置点，走 client-module 扩展面；界面级生效待 A3 三端走查）
2. `@hibuddy/coworker` 最简人设：经 dsh 官方配置面注入系统提示词（产品名 + 一句话人设），研究并登记 dsh 的 agent/persona 配置扩展点。（已落地 2026-11-02：走部署级 `system-prompt` 行 `personaPrefix`——profile patch 第三层覆盖 dsh-web-app 的 coding agent 人设为 HiBuddy 人设（产品名+一句话，保留 `{{model}}` 变量），coworker 代码零改动；`@deepseek-ai/dsh-persona` 为 per-agent 行不适用（须 preset scope 内挂载、全局挂载报错），扩展点研究结论登记于 profile/hibuddy/cordis.patch.yml 注释；`--dump-config` 已验证生效；行为级验证随 A4 冒烟补验）
3. 落 ADR-006：Web 端部署形态与访问控制（P0 单用户自部署、loopback/令牌口径确认）。（已落地 2026-11-02：[ADR-006](decisions/ADR-006-web-deployment-access.md) accepted 并登记 docs/README——官方默认 loopback 监听不覆盖传输行、访问控制走 dsh 原生信任链（栅栏 403 + 启动 token 换签名会话 cookie）不自建账号层、P0 禁公网暴露、启动 token 进程凭据不落盘）
4. 三端回归走查（含 S1 的插件安装/管理能力复验），产出问题/缺口清单（记入 progress-report）。

**验收标准**：
- [ ] A1 `pnpm build`、`pnpm typecheck` 全绿。
- [ ] A2 `pnpm exec dsh --profile hibuddy --dump-config` 含五 bundle 层序与 brand/coworker 配置行。
- [ ] A3 Web 与桌面端界面品牌均为 HiBuddy（侧边栏 mark/name、页面标题），非 dsh 默认品牌。
- [ ] A4 Web 与桌面端各完成一次真实任务，Agent 行为体现人设（系统提示词生效）。
- [ ] A5 dsh 能力面复验：品牌定制后插件安装/启停仍正常（能力面完整性原则的首次回归抽查）。
- [ ] A6 ADR-006 状态 accepted；progress-report 有 S2 验收记录。

### S3 核心插件：内置工具 + 审批风险分级

**目标**：`@hibuddy/coworker` 具备真实操作能力，高风险动作处于用户控制之下（PRD FR-03 / SR-01），执行留痕满足 FR-08 的数据基础。

**任务**：
1. 内置工具（L0）：文件读取（限工作区）、网页读取——`ctx.tools.register` 注册，随工具声明风险等级。
2. 内置工具（L1）：文件写入、文件整理。
3. 审批 answerer 插件：L0 自动放行 / L1 挂起待批 / L2 默认禁用（代码执行开关关闭）；拒绝语义验证（拒绝→Agent 收到反馈继续调整，同一 Run 连续 3 次被拒则停下询问）。
4. 免再询授权记忆：会话 × 工具 × 等级，存 dsh settings 命名空间；新会话失效。
5. 审批事件与工具调用全量入会话日志（FR-08 时间线数据）。
6. vitest 契约测试：工具注册、分级规则、answerer waterfall、授权记忆生命周期。

**验收标准**：
- [ ] A1 `pnpm build`、`pnpm typecheck`、`vitest run` 全绿（新增契约测试覆盖上述 6 项）。
- [ ] A2 Web 端：L0 工具自动执行且界面可见留痕，无需确认。
- [ ] A3 Web 端：L1 工具触发审批卡（工具名/参数全文/影响范围/批准/拒绝/免再询）；批准后执行；「本会话内免再询」后同会话同类调用不再询问，新会话恢复询问。
- [ ] A4 拒绝路径：Agent 收到拒绝反馈并继续（非报错终止）。
- [ ] A5 headless 冒烟：`pnpm smoke` 下 L0 工具自动执行成功（L1 审批行为以 dsh headless 审批语义观测并记录）。
- [ ] A6 progress-report 有 S3 验收记录；若决定开启代码执行则 ADR-008 已落，否则注明"默认关闭，不适用"。

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
- [ ] A1 ADR-007 状态 accepted。
- [ ] A2 Web 端：Agent 能在对话中产出图表与表单各一例，流式渲染可见。
- [ ] A3 画布：可打开/关闭/重开，跨轮次驻留，版本可回看历史。
- [ ] A4 交互回传：在表单提交/点击后，Agent 下一轮回复引用了该交互内容；交互记录入画布历史。
- [ ] A5 沙盒测试用例通过：沙盒内发起网络请求、读本地文件、读密钥均被阻断。
- [ ] A6 共享状态：用户编辑待办/参数后，Agent 后续步骤遵循修改；冲突时新者为准并提示。
- [ ] A7 Playwright E2E（生成式 UI 基本流程）全绿；`vitest run` 全绿。

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
- [ ] A1 FR-01/02/06/08/09 逐条验收清单（对照 PRD §5 规则项）全部通过，清单存 progress-report。
- [ ] A2 未配置 Provider 发起任务被阻断并跳转配置页；配置无效 key 得到明确失败原因。
- [ ] A3 异常注入：断网 30 秒恢复后进行中 Run 进度继续展示；页面关闭重开后状态恢复。
- [ ] A4 单 Run 时间线可回看且导出 Markdown 文件内容完整。
- [ ] A5 桌面通知：审批等待与任务完成且窗口失焦时收到系统通知。
- [ ] A6 双端对等清单（FR-01～06）逐项通过；dsh 能力面终验通过（含第三方插件在桌面端安装/启停）。
- [ ] A7 Playwright（Web 全流程）与 Electron driver（桌面）E2E 全绿；progress-report 有 S5 验收记录 → **P0 完成**。

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
| S1–S5 | — | 未开始 | — |
