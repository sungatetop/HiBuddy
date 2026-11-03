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
- **A6** 桌面打包：`HiBuddy-Setup-0.1.0.exe`（NSIS）产出；打包版宿 4.3s ready，界面加载、真实任务发送、会话持久化、刷新恢复、关闭随退全验证。**安装树比对（2026-11-03 补登，全新安装于 C 盘）**：`resources\host` 22,656 = win-unpacked 基准 22,656 零丢失；安装树总数 22,757 = 22,756 + 安装期生成的 `Uninstall HiBuddy.exe`（0.2MB 非空，与此前 C 盘空间不足时 0 字节卸载器形成对照）；逐文件 diff 安装树 vs win-unpacked 无缺失；注册表卸载项、快捷方式正常写入。安装后启动/任务/随退验证见 A6 剩余项。
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
