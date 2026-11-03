---
title: ADR-008 L1 代码执行沙盒策略——P0 默认关闭，不适用
summary: 条件性 ADR：仅当 HiBuddy 开启代码执行（L2）时才需要落沙盒策略；S3 已按 PRD FR-03 将代码执行默认关闭（preset-standard 禁用 bash/pwsh + coworker 双闸兜底），本 ADR 记录该决策并声明沙盒策略暂不适用，附未来开启时的重立条件
keywords: [ADR, L1, L2, 代码执行, 沙盒, 默认关闭, FR-03, 条件性]
status: accepted
date: 2026-11-03
---

# ADR-008 L1 代码执行沙盒策略——P0 默认关闭，不适用

> 关联：[implementation-plan](../implementation-plan.md) §条件性 ADR（"仅当 S3 决定开启代码执行时落地"）；[ADR-009](ADR-009-s3-rescope-agui-bridge.md) §2（S3 复用 dsh 审批主干）；[ADR-003](ADR-003-dsh-based-customization.md)。

## 1. 决策

**P0 阶段不开启代码执行，L1 代码执行沙盒策略不适用。**

PRD FR-03 规定代码执行（L2 风险等级：bash/pwsh）默认关闭。S3 已落地双重闸门（见 progress-report S3）：

1. **装配级**：preset-standard 覆盖行无条件禁用 `tool-bash`/`tool-pwsh`（[cordis.patch.yml](../../profile/hibuddy/cordis.patch.yml)，override 注释登记官方现值与 dsh 0.2.1-rc.5）；
2. **运行时**：`@hibuddy/coworker` 的 `tools/pre-execute` 对 L2 工具前置 deny（`l2DisabledReason`）+ `approval/request` answerer 对漏网升权请求兜底拒绝；grants API 拒绝为 L2 记录免再询。

因此 dsh 的沙箱分级能力（read-only / workspace-write / danger-full-access）在 P0 仅作用于 L1 文件面，无需为代码执行另立沙盒策略。

## 2. 重立条件（何时本 ADR 需要实际落地）

出现以下任一情况时，须先修订本 ADR（沙盒策略定案）再开启代码执行：

1. 产品决策开放 L2 工具（settings 开关或 preset 分级开放）；
2. 需要给受信用户提供「工作区内 shell」能力；
3. dsh 沙箱能力面变化（如新增沙箱档位）影响 L1/L2 边界。

届时需定：允许的沙箱档位与审批策略组合、L2 工具的免再询授权边界（当前 grants API 已按 SR-01 硬拒 L2）、PTC/子代理等 preset 的 L2 传播策略。

## 3. 影响

- 无新增实现；本 ADR 仅作登记，满足 implementation-plan S3 A7。
- S3 验收记录见 [progress-report.md](../progress-report.md) S3 节。
