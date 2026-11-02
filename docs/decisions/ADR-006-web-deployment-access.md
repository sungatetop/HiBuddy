---
title: ADR-006 Web 端部署形态与访问控制
summary: P0 单用户自部署口径：Web GUI 采用 dsh 官方默认 loopback 监听（127.0.0.1:3080，webserver 行拒绝 wildcard bind），访问控制直接采用 dsh 原生信任链（连接栅栏 403 + 启动 token 换签名会话 cookie），不自建账号/登录层；P0 不支持公网暴露，远程访问（P1+）走官方反向代理路径（--public-url + --trusted-host + TLS）并须修订本 ADR
keywords: [ADR, Web 部署, 访问控制, loopback, 信任栅栏, 启动 token, 会话 cookie, dsh 原生能力]
status: accepted
date: 2026-11-02
---

# ADR-006 Web 端部署形态与访问控制

> 依据：[ADR-003](ADR-003-dsh-based-customization.md)（dsh 底座路线：定制走官方扩展面）、PRD（FR-01 单用户自部署）、dsh 0.2.1-rc.5 Web 安全面实测与官方文档（见 §4 证据索引）。

## 1. 背景与决策点

HiBuddy Web 端复用 dsh 的浏览器表面（`dsh --profile hibuddy` = hibuddy profile 的 web surface）。dsh 0.2.1-rc.5 已内置一套完整的 Web 信任链，全部为官方默认行为：

1. **监听**：webserver 行默认绑定 `127.0.0.1:3080`（`ctx.webStartup.host ?? '127.0.0.1'`），且该行**拒绝 wildcard bind**——进程层面就不可能意外监听 `0.0.0.0`。
2. **信任栅栏**：connection 行的 `trustedHosts` 策略覆盖每个 API 请求与 WebSocket upgrade——仅接受 loopback、监听器自身绑定地址与 `--trusted-host` 点名的 authority，其余一律 403。
3. **认证**：启动时打印的 URL 携带启动 token，浏览器以 token 换取签名会话 cookie；token 与 cookie 才完成认证，栅栏只负责放行请求。
4. **TLS**：可选 `--tls-cert`/`--tls-key`（文件只读一次，缺失即启动失败，不回退 HTTP）。

HiBuddy 现有 profile（`profile/hibuddy/cordis.patch.yml`）未覆盖任何传输行（webserver/web-runtime/connection），即当前装配已是纯官方默认。

需定案：P0 部署形态口径、是否自建认证、远程访问支持边界、启动 token 的运维口径。

## 2. 决策

### D1 部署形态：单用户自部署，官方默认监听，不覆盖传输行

- Web GUI 以 `dsh --profile hibuddy` 启动，监听官方默认 `127.0.0.1:3080`；**profile 不覆盖 webserver/web-runtime/connection 行**，保持 dsh 默认安全基线。
- 桌面端为 Electron 壳内嵌宿（[ADR-004](ADR-004-desktop-shell-host.md)），宿监听同为 loopback 本地会话，与 Web 端同构。
- 端口冲突时以命令行/启动参数改端口，不改 profile（监听值来自 webStartup provider 的调用面，部署回退值属官方行）。

### D2 访问控制：采用 dsh 原生信任链，不自建账号层

- 认证完全依赖 dsh 原生链路：**连接栅栏（403）+ 启动 token → 签名会话 cookie**。P0 不自建账号、登录页或会话管理——它们会引入 dsh 信任链之外的第二套会话状态，破坏「三端一致」与能力面完整性原则。
- 「打开浏览器即用」由 dsh 原生承担（`printUrl` + token 自动入 cookie）；手动复制 URL 到其它本机浏览器同样可用（token 在 URL 中）。

### D3 远程访问：P0 明确不支持，P1+ 走官方反向代理路径

- P0 不得将 HiBuddy Web 端暴露到 loopback 之外；需要跨机访问属于 P1+ 需求，届时走 dsh 官方部署路径（`--public-url` 公告 + `--trusted-host` 接纳 + 反向代理/TLS，官方文档 public-deployments 已覆盖代理转发、cookie 改写、升级请求全清单），并**修订本 ADR**（新增 P1 决策行），不临时改绑定。
- 移动端（S5 Flutter）经 dsh 协议接入，属客户端形态，不受本条约束，但其宿侧接入点同样先落在 loopback/受信网络。

### D4 启动 token 运维口径：进程凭据，不落盘不入库

- 打印 URL 中的启动 token 是进程凭据，仅对启动该进程的 OS 用户可见；不得写入任何文件、日志或版本库。
- 桌面端宿 stdout 已收敛进内存诊断缓冲（e64f970），token 不经外发通道；Web 开发态终端属本机用户会话，可接受。
- `MINIMAX_CN_API_KEY` 等 LLM 凭据走用户级环境变量（已有纪律），与 Web 访问凭据互不相干。

### D5 P0 风险边界（明示接受）

- 同机其它进程/同 OS 用户可访问 `127.0.0.1:3080`——单用户自部署口径下**明示接受**；多用户共享主机场景 P1 重新评估。
- 监听端口本身不受栅栏保护（官方明示），因此「端口只在本机」是整个模型的前提，也是 D1 禁止改绑定的原因。

## 3. 备选与取舍

| 备选 | 结论 |
|---|---|
| 自建账号/登录层（JWT、用户表） | 拒绝——与 dsh 信任链并行引入第二套会话状态，破坏三端一致与能力面完整性；P0 单用户无账号需求 |
| 覆盖 webserver 行绑定 `0.0.0.0` + 自实现 IP 白名单 | 拒绝——官方行显式拒绝 wildcard bind；绕过它等于放弃 dsh 的整个信任模型 |
| P0 即支持公网暴露（反向代理） | 拒绝——单用户自部署无此需求；官方路径已文档化，P1+ 有需求时按 D3 修订本 ADR 后启用 |
| 关闭认证（若存在开关）以便局域网直接访问 | 拒绝——无此官方开关即不寻径；令牌与 cookie 是认证的组成部分，移除即裸奔 |

## 4. 证据索引（dsh 0.2.1-rc.5）

| 事实 | 来源 |
|---|---|
| 默认绑定 `127.0.0.1:3080`、拒绝 wildcard bind、`tls` 配置项 | `@deepseek-ai/dsh-web-app` cordis.patch.yml L179-187（webserver 行） |
| 栅栏覆盖每个 API 请求与 upgrade；loopback/bind/trustedHosts 三口径 | 同上 L230-241（connection 行）；`docs/user/guide/public-deployments.zh.md` |
| 启动 token → 签名会话 cookie；栅栏只放行不认证；TLS 细节 | `docs/user/guide/public-deployments.zh.md`（信任与保护章节） |
| HiBuddy profile 未覆盖传输行（纯官方默认装配） | `profile/hibuddy/cordis.patch.yml`（仅 4 个覆盖行，无 web 传输行） |
| 反向代理部署官方清单（代理转发/cookie 改写/升级请求） | `docs/user/guide/public-deployments.zh.md`（代理章节） |
