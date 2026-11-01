# HiBuddy 项目文件组织规则

> 本文件是 HiBuddy 的强制文件组织规则。新建任何目录、文档或模块前必须先阅读本文件。
> 项目尚未开始编码，本文件先定**目录骨架与文档组织方式**；架构定型后参照 RoadKernel
> project.md 的结构逐步补充分层职责、模块归属等开发规则。

---

## 0. 总则

1. **文档集中存放**：所有决策文档、方案文档、技术文档、设计文档一律保存到 `docs/`，按文档类别建子文件夹，禁止散落在源码目录或项目根目录。
2. **先登记后使用**：新增文档类别（子目录）必须先在本文件 §2.1 表格中登记，再创建目录与文档；新增专题目录同理。
3. **规则单一入口**：本文件（`.trae/rules/project.md`）是唯一的强制规则文件；其余说明性内容一律进 `docs/`，不得另立第二份规则文件。
4. **根目录保持干净**：根目录禁止出现临时脚本、临时文档、临时数据文件。一次性脚本放 `scripts/` 或系统临时目录，用完即删；版本与备份由 git 管理，禁止 `最终版/v2/备份` 类命名。

---

## 1. 根目录骨架

| 目录 | 用途 | 状态 |
|---|---|---|
| `.trae/rules/` | 强制开发规则（本文件） | 现行 |
| `docs/` | 全部文档（见 §2） | 现行 |
| `thirdparty/` | 外部开源参考项目（只读浅克隆，不参与本项目的构建与发布；其中 deepseek-harness 兼作底座源码对照——底座本体经 npm 依赖引入；清单见 [docs/references/ag-ui-research.md](../../docs/references/ag-ui-research.md)） | 现行 |
| `profile/` | dsh profile `hibuddy`：产品装配清单（依赖清单 + cordis.patch.yml），dsh 加载的最小单元，非 npm 包；经 `scripts/sync-profile.ps1` junction 到 `$DSH_HOME/profiles/hibuddy` | 现行（骨架） |
| `packages/` | HiBuddy 自研 dsh 插件与包（命名 `@hibuddy/*`，均为 dsh bundle/库形态）：brand（品牌）、coworker（核心插件：工具/人设/审批分级）、web-ui（Web UI 定制）已建骨架；AG-UI 桥（可选）待 P1 | 现行（骨架） |
| `desktop/` | Electron 桌面端：自建壳 `@hibuddy/desktop-shell` + 宿进程 `@hibuddy/desktop-host`（内嵌 dsh runtime，runProfile('hibuddy')） | 预留 |
| `mobile/` | Flutter 移动端（经 dsh SDK/协议接入同一运行时） | 预留 |
| `scripts/` | 构建、部署、数据导入导出等工具脚本；现有 `sync-profile.ps1` | 现行 |
| `tests/` | 跨端集成测试；各端单测跟随所属端目录放置 | 预留 |

约束：

- 标注"预留"的目录**不在项目启动前预建空目录**，在对应阶段首次开发时创建。
- **pnpm workspace monorepo**：根 `pnpm-workspace.yaml` 已建（声明 `profile/hibuddy`、`packages/*`；`desktop/*`、`tests/` 随对应阶段加入）；根 `package.json` 锁定 `@deepseek-ai/dsh` 精确版本并经 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 批准 dsh 运行时所需原生构建（koffi/node-pty 等）；npm 包名统一 `@hibuddy/<name>`（profile 非 npm 包）。依赖方向：`profile/hibuddy → @deepseek-ai/*（bundle 基座）+ @hibuddy/*（插件）`；`packages/* → dsh 插件 API（@deepseek-ai/*）`；`desktop/host → dsh runtime + profile`；`desktop/shell → desktop/host`；禁止反向依赖；**任何包禁止 import `thirdparty/` 源码**；`thirdparty/` 与 `docs/` 不纳入 workspace。
- `thirdparty/` 为只读参考区：禁止修改第三方仓库内容、禁止将其纳入本项目构建/发布；更新用 `git pull --depth 1`；新增/移除仓库须同步更新调研文档并登记。
- 各端目录内部结构（分层、模块划分）在该端开工前于 `docs/architecture/` 定稿，并在本文件登记索引。
- 骨架本身可演进：调整根目录结构属于架构级变更，须先立 ADR 再改。

---

## 2. 文档管理规范（强制）

### 2.1 类别与目录

| 类别 | 目录 | 内容 |
|---|---|---|
| 架构文档 | `docs/architecture/` | 系统总体架构、分层、依赖、数据流 |
| 产品文档 | `docs/product/` | 产品需求文档（PRD）、产品规划等产品侧文档 |
| 决策文档 | `docs/decisions/` | 技术选型、方案取舍（ADR，编号 `ADR-001-xxx.md` 起步递增） |
| 方案文档 | `docs/solutions/` | 实施方案 / 专项设计方案 |
| 模块设计 | `docs/module-design/` | 各模块详细设计（每模块一篇，索引在 `docs/README.md`） |
| 专题技术 | `docs/<topic>/` | 单领域技术专题（新增专题目录须先登记于本表） |
| 参考资料 | `docs/references/` | 外部规范、文献摘录、竞品调研 |
| 计划与报告 | `docs/`（根） | ImplementationPlan / ProgressReport 等全局文件 |
| 草稿暂存 | `docs/drafts/` | 未成形草稿，不纳入索引，定稿后迁出并删除草稿 |

### 2.2 frontmatter（强制）

每个文档头部必须有 YAML frontmatter，包含信息摘要、关键词、状态、日期：

```markdown
---
title: 文档标题
summary: 一句话说明本文档解决什么问题、当前结论是什么
keywords: [关键词1, 关键词2, 关键词3]
status: draft | accepted | superseded | deprecated
date: 2026-10-31
---
```

- `status` 语义：`draft` 草稿 / `accepted` 现行有效 / `superseded` 已被新文档取代（正文顶部须注明取代者链接）/ `deprecated` 废弃。
- 正文实质变更时必须同步更新 `date`；状态变化必须同步更新 `status`。

### 2.3 索引与维护

- `docs/README.md` 是全库文档索引：按类别列出 `accepted` 文档的标题与一句话摘要；新文档定稿（`accepted`）时必须同步登记。
- 删除文档用 `deprecated`/`superseded` 标记过渡，git 历史保留原文；不留空文件或 `// removed` 占位。

---

## 3. 文件命名约定

- **文档**：小写中划线（kebab-case），如 `hibuddy-architecture.md`；ADR 用 `ADR-NNN-短名.md`。
- **代码文件**（预留约定）：React 组件 PascalCase，TS 工具/模块 kebab-case 或 camelCase——各端开工前在架构文档中定稿。
- 文件名禁止空格与版本词；中文只出现在文档标题与正文，不进文件名。

---

## 4. 演进纪律

1. **文档先行**：项目启动阶段先产出 `docs/architecture/` 总体架构与首批 ADR，再开始编码；架构级取舍**先立 ADR 再改代码**。
2. **规则随架构演进**：架构定型后，参照 RoadKernel project.md 的结构在本文件补充：定位与 ADR 索引、职责分层与依赖方向、模块归属硬性约束、JSON/接口契约管理、最佳实践清单。
3. **每阶段同步**：按阶段推进开发，每阶段结束更新 ProgressReport 与 `docs/README.md` 索引。
