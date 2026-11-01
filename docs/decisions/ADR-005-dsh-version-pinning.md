---
title: ADR-005 dsh 版本锁定与升级策略
summary: dsh 运行时与全部 @deepseek-ai/* 依赖精确钉版（禁 SemVer 浮动）以维持全家版本配对；Electron 精确钉在 dsh 宿原生白名单指纹上（禁 ^ 浮动）；engines.dsh 运行时闸阻断不兼容组合；七步强制升级流程（changelog → 覆盖行 diff → 白名单 → client 契约 → build → 冒烟 → 登记）；插件安装状态经 profile package.json+lock 入库复现
keywords: [ADR, 版本锁定, dsh, 升级, engines.dsh, Electron 白名单, 覆盖行登记, 插件配对, hoisted deploy]
status: accepted
date: 2026-11-01
---

# ADR-005 dsh 版本锁定与升级策略

> 依据：[ADR-003](ADR-003-dsh-based-customization.md)（dsh 底座路线）、[ADR-004](ADR-004-desktop-shell-host.md)（桌面端打包）、S0–S1 阶段实测记录（见 §4 证据索引）。

## 1. 背景与决策点

dsh 是 HiBuddy 的底座依赖（npm 包 `@deepseek-ai/*`，MIT），处于 0.2.x rc 快速迭代期。版本漂移有四层真实风险，全部已在 S0–S1 实测中撞到：

1. **全家版本配对**：`@deepseek-ai/dsh@0.2.1-rc.5` 内部依赖 `dsh-web-app@0.2.1-rc.5` 及全套 `dsh-client-ui-*@0.2.1-rc.5`——dsh 各包之间不是独立 SemVer 演进，而是整组发版配对。
2. **Electron 原生白名单**：dsh 宿对 Electron 二进制版本指纹有编译期固化白名单（node-addon-native-custom-loader）；0.2.1-rc.5 只接受 43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6。
3. **覆盖行现值漂移**：cordis.patch.yml 覆盖官方行时须重述全部键并登记现值（ADR-003 §3 纪律）——dsh 升级后官方行变化会使 patch 静默失配。
4. **打包面耦合**：pnpm deploy 产物布局（isolated/hoisted）与宿模块解析直接相关（isolated 树经 cpSync dereference 会丢相对 symlink，见 D6）。

需定案：锁定粒度、配对矩阵、升级流程、覆盖行登记制度、插件版本配对。

## 2. 决策

### D1 dsh 运行时与全部 @deepseek-ai/* 依赖：精确钉版

- 根 package.json：`"@deepseek-ai/dsh": "0.2.1-rc.5"`（**精确版本，禁 `^`/`~`**）。
- `@hibuddy/desktop-host` 的全部 `@deepseek-ai/*` dependencies：精确钉同一版本。
- 自研 client 插件（brand/web-ui 等）的 devDependencies（slots/client 类型面）：钉同一版本——client 契约类型必须与运行时配对。

理由：SemVer 范围会让 pnpm 对 dsh 全家各自独立解析，破坏整组发版配对；rc 阶段 patch 号内也有破坏性变更，浮动无意义。

### D2 engines.dsh 运行时闸

- `@hibuddy/desktop-host` package.json：`"engines": { "dsh": ">=0.2.1-rc.0 <0.4.0-0" }`——宿启动校验 runtime 版本，阻断不兼容组合。
- 该闸同时约束 dsh 自身的插件安装路径（实测：`@deepseek-ai/dsh-subagent-codex` 的 `latest` dist-tag 指向不兼容旧线 0.0.1-rc.1，被版本闸拒绝）。
- 升级 dsh 时按新版本的破坏面同步放宽/收紧此范围，并记录变更理由。

### D3 Electron：精确钉在白名单指纹上

- dsh 0.2.1-rc.5 宿的 Electron 白名单：43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6。
- `@hibuddy/desktop-shell` devDependencies：`"electron": "44.7.0"`（**精确，禁 `^`**）——实测 `^44.7.0` 会浮到 44.10.0，宿启动即拒。
- **升级 dsh 时必须核对**新版本的白名单（对照其 node-addon-native-custom-loader 支持列表），白名单变化须同步 electron 钉版并在 progress-report 登记。

### D4 插件版本配对与安装状态可复现性

- first-party 插件（dsh-subagent-codex 等）安装时使用与运行时**精确配对**的版本线：rc 运行时配 `@next` dist-tag（0.2.1-rc.5），不用 `latest`。
- plugin-manager 的 reconcile 只在安装**成功**时把新 bundle 追加进 profile 的 `dsh.profile.bundles`；版本闸拒绝等失败安装会留下 package.json 依赖而 bundles 不变——恢复手段是 `remove` 后重新 `add`（实测）。
- **profile 依赖安装状态 = `profile/hibuddy/package.json` + 根 `pnpm-lock.yaml`，两者入库**，保证任何环境可复现装配。测试插件验完即卸载，产品构成只保留必要插件。
- **junction 开发态运维规则**：每次 `dsh plugin --profile hibuddy add/remove` 之后必须重跑 `pnpm profile:sync`——pnpm 生成的相对 symlink 跨 junction 解析失效（实测）。

### D5 打包面：deploy 必须 hoisted 布局

- `desktop/shell` 的 `deploy:host`/`deploy:profile` 统一加 `--node-linker hoisted`。
- 禁用 isolated deploy 产物：其顶层包是实体拷贝而依赖链接在 .pnpm 侧，materialize 的 cpSync dereference 会**静默丢弃**目录内相对 SymbolicLink（实测：顶层 `@deepseek-ai/dsh/node_modules` 只剩 `.bin`，安装版宿启动即 `ERR_MODULE_NOT_FOUND: 'js-yaml'`）；hoisted 平铺实体后 Node 按物理路径解析，无此问题。
- materialize-deploy.mjs 只承担 dev 文件剪除（.map/.d.ts/.tsbuildinfo）。
- 打包前验证手段（进入 dist 脚本前的手动关卡，S3 起固化为脚本）：
  1. 宿入口 import 冒烟：`node -e "import('file:///<build/host>/lib/index.js').then(...)"`（node ≥24.9）；
  2. 全树依赖解析核对：遍历 `build/host/node_modules` 每包 dependencies 逐条 `require.resolve`（optional 平台包与纯类型包的失败可豁免）。

### D6 升级流程（强制顺序）

1. **读 changelog / release notes**，列出破坏面（配置行、client 契约、白名单、App API）。
2. **diff 覆盖行现值**：逐一复核 cordis.patch.yml 的每个覆盖行（agent-default-model、ui-settings-general、llm-pi-ai 等）注释里登记的「官方行现值 + dsh 版本」——官方行变更则 patch 同步重述；官方行删除则 patch 行删除；**更新登记注释里的现值与新 dsh 版本号**。
3. **核对 Electron 白名单**（D3）。
4. **核对 client 面契约**：tsdown client 预设的工厂包装格式（banner/intro/footer 的 `__ModuleLoader__.load` 契约）、PLATFORM_MODULES 基线（react、react/jsx-runtime 等 externals 清单）——以 thirdparty/deepseek-harness 快照对照，快照用 `git pull --depth 1` 更新。
5. **更新钉版 → 安装 → 构建**：根与 desktop/* 同步改版，`pnpm install`（遇 `ERR_PNPM_IGNORED_BUILDS` 用 `pnpm approve-builds --all`），`pnpm build && pnpm typecheck` 全绿。
6. **冒烟套件**：`pnpm smoke`（LLM 往返）+ A2（CLI）/A3（Web 任务+刷新恢复）/A5（桌面开发态）用例 + 能力面回归抽查（A4：插件 CLI 装/卸、Web UI 可见可启停、--patch overlay 层序）。
7. **登记**：progress-report 记录升级（版本、破坏面、覆盖行变更、白名单变更）；docs/README 索引不受影响。

## 3. 备选与取舍

| 备选 | 结论 |
|---|---|
| SemVer 范围钉版（`^0.2.1-rc.5`） | 拒绝——破坏 D1 全家配对；rc 阶段 patch 号内亦有破坏 |
| 仅靠 lockfile 锁定（package.json 用范围） | 拒绝——pnpm deploy / 新环境安装不可复现，插件 reconcile 与 engines 校验都读不到真实意图 |
| 自动化升级 bot / Dependabot | P1 之后再议——升级流程含人工 diff 覆盖行与白名单核对，自动化收益低风险高 |
| Electron 用 ^ 自动吃 patch 更新 | 拒绝——实测 44.10.0 不在 dsh 白名单，宿启动即拒 |

## 4. 证据索引（S0–S1 实测）

| 事实 | 来源 |
|---|---|
| dsh-web-app / dsh-client-ui-* 与运行时 0.2.1-rc.5 整组配对 | pnpm store 实测（S0/S1） |
| `^44.7.0` 浮动到 44.10.0 被宿白名单拒绝；44.7.0 通过 | S1-C 桌面开发态实测 |
| codex 插件 `latest`（0.0.1-rc.1）被版本闸拒绝，`@next`（0.2.1-rc.5）通过 | S1-F 插件生态验证实测 |
| 失败安装残留 package.json 依赖而 bundles 不变；remove+add 恢复 | S1-F plugin-manager reconcile 行为实测 |
| 相对 symlink 跨 junction 失效，profile:sync 绝对化修复 | S1-B（commit 630d1c1） |
| isolated deploy + cpSync dereference 丢相对 SymbolicLink → 安装版宿 `ERR_MODULE_NOT_FOUND: 'js-yaml'`；hoisted 修复后宿 import 链通过 | S1-D 打包实测（2026-11-01，重打包验证） |
