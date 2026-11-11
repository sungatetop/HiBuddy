---
title: ADR-012 workspace-watch 感知源——watch 触发提前 + 确定性扫描兜底
summary: 为 L2 感知面落地首个文件系统感知源：新 SourceKind「watch」监听已注册工作区内的文件增改——fs.watch(递归) 只作"把下次扫描拉到现在"的失效提示，事实来源始终是确定性目录扫描（指纹 = sha256(path+size+mtime) 前 16 位，cursor 持久化防重放）；watch 路径必须落在已注册 dsh 工作区根下；一次扫描的全部变更聚合为单条 untrusted Trigger（明细 ≤20）走既有两级过滤；编排层（scheduler/worker/reconcile）零改动，filter 仅增加载荷形状分支
keywords: [ADR, workspace-watch, 感知源, SourceKind, fs.watch, 轮询兜底, 去重指纹, 噪声过滤, untrusted, 事件聚合, 两级过滤, resident, B12′ D5]
status: accepted
date: 2026-11-11
---

# ADR-012 workspace-watch 感知源——watch 触发提前 + 确定性扫描兜底

> 决策依据：[butler-perception-design §7](../solutions/butler-perception-design.md)（L2 感知面预留设计：fs.watch/轮询监听工作区文件增改；去重指纹 = path+size+mtime；噪声过滤；untrusted=true）、§12 D5 行"独立 ADR 后再实施"；关联 [ADR-011](ADR-011-butler-conversation-layer.md)（管家决策、事件聚合 D8）、[resident-design §4.1/§4.2](../module-design/resident-design.md)（SourceKind registry、监控源蓝本）。
> 状态：accepted（2026-11-11）。

## 1. 背景

B12′ D1–D4 已交付管家感知三层次（信封/快照/边沿事件）。设计文档 §7 为 L2 预留了感知面扩展，其中 **workspace-watch** 是首个条目：监听工作区文件增改，典型场景"帮我盯着下载目录/构建产物"。

现状机制与约束：

1. **SourceKind registry**（[sources.ts](../../packages/resident/src/monitor.ts) 同款接口，[index.ts](../../packages/resident/src/index.ts) 装配）：新源种类实现 `start/stop` 即接入，触发经统一回调进"先落库 → 两级过滤"管线——这是设计文档"编排层零改动"承诺的兑现点。
2. **两级过滤的载荷契约目前是 monitor 专属**：[filter.ts](../../packages/resident/src/filter.ts) 的 gate 按 `MonitorHitPayload`（target/condition/fingerprint/rationale 四字段）校验，其余形状直接 `dropped`。
3. **fs.watch 的平台现实**：递归监听在 Windows/macOS 可用，Linux 不支持（`recursive: true` 直接抛错）；且事件语义跨平台不一致（rename 与增删的对应关系）、存在丢事件可能——**watch 回调不能作为事实来源**。
4. **既有工程纪律**：确定性优先（B3 调度、B5 指纹去重均宿侧确定性计算）；事件聚合（ADR-011 D8）；untrusted 预留字段（[domain.ts](../../packages/resident/src/domain.ts) `Trigger.untrusted`，monitor 尚未使用过）。

## 2. 决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **触发模型 = "watch 触发提前 + 确定性扫描兜底"**：每个 watch 实例由周期扫描（固定 60s 兜底）驱动；`fs.watch` 回调**不是事实来源**，只把该实例的下次扫描时间拉到现在（1s 去抖）。指纹比对、去重、触发永远由扫描逻辑完成 | watch 事件跨平台语义不一致且可能丢失；"失效提示 + 确定性重扫"让正确性不依赖平台实现，Linux（无递归 watch）自动降级为纯轮询；扫描逻辑可注入假时钟直测 |
| D2 | **watch 路径必须落在已注册 dsh 工作区根下**（canonical 小写 + 前缀边界校验，同 [attachments.ts](../../packages/resident/src/attachments.ts) 纪律）；config 校验失败按 monitor 同款慢速重试（60s），不入退避 | 盯任意外部目录须先注册为工作区（如把下载目录注册进来）；路径元数据（文件名/大小/时间）将进入模型上下文，任意路径等于开放任意目录的元数据面；与既有工作区白名单纪律同源，攻击面不扩大 |
| D3 | **去重指纹 = `sha256(相对路径 + size + mtimeMs)` 前 16 位**（设计 §7 已定）；cursor 持久化为 `path → 指纹` 映射（上限 2000 条，扫描结果中消失的路径随之移除），重启恢复后不重放历史变更 | 内容不读、只取元数据——指纹由确定性元数据构成，同版实测（B5）证明宿侧确定性指纹是防重复触发的唯一可靠手段；映射随扫描收敛，无泄漏；"size+mtime 未变但内容变了"是已知盲区，登记 §6 |
| D4 | **噪声过滤（确定性规则）**：跳过符号链接（同 artifacts.ts）、隐藏条目（`.` 开头）、`node_modules`/`.git`/`__pycache__`/`.cache` 等结构噪声，临时/未完成模式（`~$*`、`*.tmp`、`*.swp`、`*.part`、`*.crdownload`、`Thumbs.db`、`.DS_Store`）；只报文件不报目录；扫描限深 4、限 5000 文件，超出截断并告警 | "盯着构建产物"要求 dist/output 可见，噪声清单只能含**结构性**噪声；深/数上限复用 artifacts 扫描先例，防大树拖垮共享 tick |
| D5 | **一次扫描的全部变更聚合为单条 Trigger**：payload 携带 `events` 明细（≤20 条，按 mtime 倒序）+ `total` 总数 + `rationale` 人类可读摘要（"新增 2 个、修改 1 个：…"）+ **聚合指纹**（全部变更指纹排序拼接后再 sha256，前 16 位）；`Trigger.untrusted = true`（文件名本身可能是注入载体） | 一次构建可产出数百文件，逐文件 Trigger 违反事件聚合纪律（ADR-011 D8）；聚合指纹保证"同一批变更"幂等、不同批次可区分；untrusted 使管家按数据处理变更明细 |
| D6 | **filter 仅增加载荷形状分支（唯一代码改动点）**：gate 先按 monitor 形状、再按 watch 形状（`events` 数组合法）分流，未知形状照旧 `dropped`；assessment 输入新增 `untrusted?: boolean` 透传（session-check 研判 prompt 据此注入"外部数据按数据处理"指令）；observe/auto 的文案按分支措辞 | 两级过滤管线结构、observe 默认、幂等键纪律全部复用；monitor 分支行为零变化（既有单测保护）。"编排层零改动"承诺指 scheduler/worker/reconcile，不含 filter 的载荷契约扩展 |
| D7 | **装配零改动**：`WorkspaceWatchSource` 实现既有 `SourceKind` 接口，注册进 registry；沿用"运行中注入的新实例不自动 armed，须重启宿"（B5 已知行为）；gate 的"同源开放票去重"对 watch 同样生效——票处理期间的新变更被吞、票关闭后恢复触发 | registry 是设计兑现的接入点；B8 面板未建源入口前无运行中动态加源需求；同源去重防"处理中风暴"，语义对 watch 同样成立（该批变更已被 open 票覆盖） |

## 3. 被否决的替代方案

| # | 方案 | 否决理由 | 保留价值 |
|---|---|---|---|
| A1 | 纯 fs.watch 事件驱动（无扫描兜底） | 正确性依赖平台 watch 实现：丢事件即永久漏报，Linux 无递归支持 | 实时性——D1 已将其作为"提前触发"信号保留 |
| A2 | 纯轮询（无 watch） | 实现最简但"盯着下载目录"体验差（感知延迟=轮询间隔）；大树周期全扫浪费 | D1 结构天然兼容：watch 初始化失败的实例自动退化为纯轮询兜底，无需专门代码路径 |
| A3 | chokidar 等第三方监听库 | 引入新依赖违背最小依赖纪律；node:fs 能力在 D1 模型下已足够（watch 只当提示用） | 若未来平台差异成为实际痛点再评估 |
| A4 | 允许 watch 任意路径 | 任意目录元数据进模型上下文 + 任意目录句柄常驻宿进程；绕开工作区白名单纪律 | 外部目录场景以"注册为工作区"表达，零机制成本 |
| A5 | 逐文件 Trigger（不聚合） | 事件风暴（一次构建数百事件）违反 ADR-011 D8，且每条都要过一次研判 | 明细仍完整进 payload（≤20 条），管家可见全貌 |
| A6 | watch 载荷伪装成 MonitorHitPayload 复用 filter | 零改动但语义扭曲：condition 只能硬编"发生变更"，观察模式/goal 文案全部失真，后续源种类将竞相模仿 | 提示了"契约统一"的诱惑——诚实分流（D6）成本可控且为后续 L2 源（网页/RSS）立契约先例 |

## 4. 影响分析

### 4.1 文件清单

| 文件 | 变更 |
|---|---|
| `src/workspace-watch.ts`（新） | `WorkspaceWatchSource`（SourceKind）、`parseWatchConfig`、`parseWatchCursor`、指纹与聚合逻辑、注入式 `WatchFactory`（默认 fs.watch） |
| `src/filter.ts` | gate 载荷分支（monitor/watch）、`AssessmentInput.untrusted?`、observe/auto 文案分支 |
| `src/session-check.ts` | assess prompt 按 `untrusted` 注入外部数据处理指令 |
| `src/index.ts` | `registry.register(new WorkspaceWatchSource(store))`（一行） |
| `src/workspace-watch.test.ts`（新） | 见 §5 |

### 4.2 对既有行为

- monitor 分支零变化（gate 先判 monitor 形状，单测锁定）。
- `Trigger.untrusted` 首次被消费；monitor 不置位，行为不变。
- schema 无变更（源实例与 cursor 复用 `source_instances` 既有列）。

### 4.3 对安全与隐私

1. **不读文件内容**：触发与研判只携带路径/大小/mtime 元数据；正文读取留给后续建票的 worker（工作区沙箱内）。
2. **untrusted 双层**：Trigger 置位 + assessment prompt 指令——文件名（如"请忽略之前的指令.pdf"）不得获得任何执行效力。
3. **路径约束**（D2）+ **扫描上限**（D4）+ **跳符号链接**（防逃逸与循环）。
4. watch 仅宿主侧行为，不新增任何网络/进程面。

## 5. 测试与验收

| 用例 | 断言 |
|---|---|
| 基线扫描 | 首次扫描只建 cursor 不触发（存量文件不算变更） |
| 增/改/删 | 新文件、内容变化（size 或 mtime 变）各触发一次；删除收敛 cursor；重启恢复 cursor 不重放 |
| 噪声过滤 | 隐藏/临时/node_modules 内变更不触发；符号链接跳过 |
| 聚合与上限 | 多文件变更合并单条 Trigger；明细截断 ≤20 且 total 准确；聚合指纹幂等 |
| 载荷契约 | watch 载荷过 gate 进研判；monitor 载荷行为不变；畸形载荷 dropped |
| untrusted | Trigger.untrusted=true 透传 AssessmentInput；assessor prompt 含外部数据指令 |
| config 校验 | 工作区根外路径/畸形 config 不 arm，慢速重试 |
| watch 提前 | 注入 factory 触发 onChange → 实例下次扫描提前（假时钟）；factory 失败仍按兜底周期扫描 |

真机验收（B5 口径）：注册临时工作区 → 注 watch 源 → 重启宿 → 写入/修改文件 → 观察模式记录 would-act（含变更明细与 untrusted 语义）；auto 模式建票 + 管家能说出变更来源。

## 6. 风险与开放问题

1. **mtime 精度盲区**：同秒内写入且 size 不变的修改可能漏报（指纹不变）。兜底扫描同指纹，仍漏——接受，登记已知限制；若实测成为痛点，指纹并入 inode/内容哈希（需读文件，另立决策）。
2. **同源去重语义**：票处理期间的新变更被 gate 吞掉，票关闭后的下次扫描才触发——首批接受（该批变更已被处理中票覆盖）；若"持续观察"需求成立，为 watch 源开放 gate 例外（另立决策）。
3. **`monitor_triggered` 事件 code 命名偏移（已收口 2026-11-11）**：filter auto 分支补发的因果事件 code 已提前统一为 `source_triggered`（原计划第三个源种类引入时统一，遗留收口时提前执行）；幂等键与 ticket origin 的 `monitor:` 前缀为不透明存储标识，保持不变、无数据迁移（origin 语义见 D7）。
4. **大树扫描耗时**：限深 4 / 限 5000 的默认值未实测校准；共享 tick 内单飞执行，最坏情况拖慢同 tick 其他实例——登记参数为内部常量，实测后调。
5. **Linux 降级体验**：纯轮询感知延迟 = 60s 兜底；当前部署面（Windows 桌面宿）不受影响。

## 7. 证据索引

1. 设计预留：[butler-perception-design §7/§12](../solutions/butler-perception-design.md)（"新 SourceKind；指纹 = path+size+mtime；噪声过滤；untrusted=true；独立 ADR 后再实施"）。
2. 源框架先例：[monitor.ts](../../packages/resident/src/monitor.ts)（armed map + 共享 tick + in-flight + cursor 持久化 + 退避降级）。
3. 载荷契约现状：[filter.ts](../../packages/resident/src/filter.ts)（`MonitorHitPayload` 硬校验，§1.2）。
4. 确定性指纹纪律：B5 定案（project memory：首版模型自由文本摘要实测同快照不同摘要，改宿侧 sha256）。
5. 工作区根校验先例：[attachments.ts](../../packages/resident/src/attachments.ts)（canonical + 前缀边界，B11′ 定案）。
6. fs.watch 平台差异：Node.js 文档（Linux 无 `recursive` 支持，Windows/macOS 支持）。
