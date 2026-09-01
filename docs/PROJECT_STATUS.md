# PaperTeam 项目状态

> 更新日期：2026-09-01

## 当前阶段

**M2.1「OpenClaw 2.0 Runtime Upgrade」已完成：Runtime 底座接入 OpenClaw 2026.8.1 官方 Gateway SDK（wire protocol v4），并已通过真实 Gateway smoke 验证。**

M2 交付的最小真实闭环不变：`POST /api/projects` 创建论文项目 → `POST /api/projects/:id/generate` 通过 `AgentRuntime.runAgent()` 真实调用 Writer Agent → 校验 LaTeX → 写入 `manuscript/main.tex` → `LatexCompiler` 编译 → `build/paper.pdf`。M2.1 只替换底座：自研 Gateway WebSocket 协议实现退役，改为官方 `@openclaw/gateway-client`，并新增 Project ↔ Runtime Session 的最小映射。

**下一阶段：第三阶段「Project Literature Library + Evidence Store」尚未开始（M2.1 刻意未包含文献库与多 Agent）。**

## M2.1：OpenClaw 2.0 Runtime Upgrade

基线：OpenClaw **2026.8.1**（git tag `v2026.8.1`，commit `ea806575e6`，npm `latest`；`2026.9.1-beta.1` 为 beta 不采用）。
wire protocol **v4**（官方常量 `PROTOCOL_VERSION` / `MIN_CLIENT_PROTOCOL_VERSION`，均 = 4）。
运行时要求 **Node >= 22.19.0**（两个 SDK 包的 engines 约束）。

| 项 | 状态 | 说明 |
|---|---|---|
| 官方 SDK 接入 | ✅ 完成 | `@openclaw/gateway-client@2026.8.1` + `@openclaw/gateway-protocol@2026.8.1`（精确 pin）。transport（ws）、connect.challenge 挑战 → connect 握手 → hello-ok、鉴权、protocol v4 协商、request 关联/超时、结构化错误、重连退避（1s→30s ×2）全部由 SDK 负责 |
| 自研协议退役 | ✅ 完成 | 删除 `src/runtime/openclaw/gatewayWebSocket.ts`（M2 自研帧协议/握手/request map/超时管理）。新增 `src/runtime/openclaw/gatewayClient.ts`：官方 GatewayClient 的薄 wrapper，只保留配置装配（url/身份/scopes/超时）、「等待 hello-ok」就绪预算（首个连接失败立即放弃，不搭乘 SDK 重试循环）与幂等 stop |
| runAgent 生命周期 | ✅ 完成 | 按官方 external-apps 指南：`agent` RPC → 验收 `{runId, sessionKey, agentId, status:"accepted", acceptedAt}`（2026.8.1 真实契约；网关随后同 id 发 final 帧，本方案不依赖）→ `agent.wait` 分片轮询至终态（ok/error，或带 `endedAt` 的 timeout 终态快照；`pending`/等待窗口耗尽继续轮询）→ `chat.history` 取完整文本（`terminalReply` 4096 截断仅兜底） |
| protocol version | ✅ 官方常量 | `import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version"`，不再硬编码；backend 客户端 SDK 默认即 v4-only |
| Project ↔ Session 映射 | ✅ 完成 | `RunAgentInput.sessionKey`（显式复用）+ 按 projectId 派生 `agent:{agentId}:paperteam-{projectId}`（OpenClaw sessionKey 格式，opaque peer）；`ProjectMetadata.runtimeSessionKey`（Runtime-neutral）持久化于 project.json，`GenerationService` 成功后写回、下次原样复用；同 Project 上下文连续、不同 Project 隔离（有测试） |
| 错误模型 | ✅ 完成 | SDK 结构化错误映射：`GatewayClientRequestError`（网关权威拒绝，code/gatewayCode/details/retryable）→ RPC 阶段 `AGENT_RUN_FAILED`、连接阶段 `AGENT_RUNTIME_UNAVAILABLE`；`GatewayClientRequestTimeoutError`（CLIENT_TIMEOUT 本地截止）→ `AGENT_RUNTIME_UNAVAILABLE`；连接/握手失败（含 AUTH_TOKEN_MISMATCH、PROTOCOL_MISMATCH）→ `AGENT_RUNTIME_UNAVAILABLE`；整体超时 → `AGENT_TIMEOUT`。SDK 内部错误不泄露到 HTTP 客户端 |
| 生命周期 | ✅ 完成 | 每次 runAgent 一条连接、finally 幂等 stop；新增 `AgentRuntime.close?()` 与 `OpenClawRuntimeAdapter.close()`（停止全部在途连接），server shutdown（SIGINT/SIGTERM）接入；无 dangling WebSocket / 定时器残留（测试进程干净退出） |
| mock Gateway 升级 | ✅ 完成 | `test/helpers/mockGateway.ts` 对齐 2026.8.1 服务端契约：升级后立即下发 `connect.challenge {nonce, ts}`（官方客户端收到挑战前不发 connect）；mock 仍只实现服务端必需子集，不复制完整协议 |
| 测试 | ✅ 完成 | 79 个测试全部通过（较 M2 +5）：runAgent 13（含 acceptance 契约、pending/窗口耗尽轮询、sessionKey 派生/复用/隔离、close 生命周期）、HTTP 全链路 13（含两轮 generate 会话连续性）、ProjectStore 13（含 runtimeSessionKey 持久化/向后兼容）等 |
| 真实 Gateway smoke | ✅ 完成 | 本机启动 `openclaw@2026.8.1 gateway`（npx，只读使用现有 ~/.openclaw 配置）：`healthCheck` healthy（354ms）；SDK connect → hello-ok `protocol=4, server=2026.8.1`；RPC `status` 成功；PaperTeam `runAgent` 完整链路 → 网关验收 `runId=paperteam-ee38400e…`、`sessionKey=agent:main:paperteam-p-smoke`（派生 key 被真实网关接受）→ `agent.wait` 到达 error 终态（本机 workspace 需 `openclaw doctor --fix` 迁移，且未配置模型凭据；属环境问题而非协议问题，未改动用户全局配置/状态）；进程干净退出 |

依赖变化：新增运行时依赖 `@openclaw/gateway-client` / `@openclaw/gateway-protocol`（均精确 pin `2026.8.1`；传递依赖 `ws` / `ipaddr.js` / `typebox`）；`engines` 从 `>=22` 收紧为 `>=22.19.0`；tsconfig `lib` 升至 ES2024（`Promise.withResolvers`）。

M2.1 边界：未引入 Swarm / A2A / 多 Agent 编排（M3+）；`onEvent` / `streamEvents` / `getTask` / `cancelTask` 仍为契约占位（SDK 已具备事件能力，Runtime 层未设计死路）；未做连接池（维持每次 runAgent 一条连接的简单语义）。

## M2：Agent Invocation + Project + LaTeX Skeleton

| 项 | 状态 | 说明 |
|---|---|---|
| `runAgent()` 真实实现 | ✅ 完成；已通过 mock Gateway 验证；⏳ 待真实 OpenClaw 验证 | `OpenClawRuntimeAdapter.runAgent()` 映射到 OpenClaw 真实调用序列：WebSocket connect 握手（operator 角色 + 共享 token）→ RPC `agent`（发起运行，ACK 返回 runId/sessionKey）→ RPC `agent.wait`（30s 分片轮询至终态）→ RPC `chat.history`（取完整回复文本；`terminalReply` 有 4096 字符截断，仅作兜底）。协议对照官方 `docs/gateway/protocol.md`、`docs/gateway/external-apps.md`、`src/gateway/server-methods/agent*.ts` 与 `@openclaw/gateway-protocol@2026.8.1` 的 `protocol.schema.json` |
| Gateway WebSocket 客户端（内部） | ✅ 完成 | `src/runtime/openclaw/gatewayWebSocket.ts`：基于 Node 22+ 内置全局 WebSocket，零第三方依赖；帧协议 `{type:"req"/"res"/"event"}`、请求关联、超时、断连清理。OpenClaw 细节不外泄到业务层 |
| `getTask / cancelTask / sendMessage / streamEvents` | ⏸ 保留契约 | 仍抛 `RuntimeCapabilityError`（M2 范围外） |
| 最小 Project 管理 | ✅ 完成 | `ProjectStore`：创建项目（manuscript/sources/evidence/reviews/build 目录 + project.json 元数据 id/title/createdAt/updatedAt/status）、读取、状态更新；projectId 白名单正则 + 路径包含性双保险，防路径穿越；无数据库 |
| Writer 最小角色 | ✅ 完成 | `WriterService`：把用户任务包装成 Writer Prompt（要求完整 ctexart LaTeX、无 Markdown 围栏、不虚构引用），调用 runAgent，校验输出含 `\documentclass`/`\begin{document}`，防御性剥离代码围栏；空结果/非 LaTeX 拒绝落盘 |
| LaTeX 编译 | ✅ 代码与注入式测试通过；⏳ 本机无 LaTeX，真实 PDF 编译未验证 | `LatexCompiler`：自动探测 `latexmk`（优先，`latexmk -xelatex`）→ `xelatex`（回退）；编译到 `build/`、产物统一重命名 `paper.pdf`；完整日志落盘 `build/compile.log`，API 只返回 exitCode/短错误/路径/耗时；工具缺失 / 编译失败 / 超时 / PDF 未生成分别对应独立错误码 |
| HTTP API | ✅ 完成 | `POST /api/projects`（201）、`GET /api/projects/:id`、`POST /api/projects/:id/generate`（Writer + 编译一次完成）；沿用 Node 原生 http，无 Web 框架；JSON 请求体 1MB 上限 |
| 业务错误模型 | ✅ 完成 | `src/errors.ts`：INVALID_REQUEST / INVALID_PROJECT_ID / INVALID_PROJECT_TITLE / PROJECT_NOT_FOUND / AGENT_RUNTIME_UNAVAILABLE / AGENT_RUN_FAILED / AGENT_TIMEOUT / INVALID_LATEX_OUTPUT / LATEX_TOOL_UNAVAILABLE / LATEX_COMPILE_FAILED / LATEX_COMPILE_TIMEOUT → 各自映射 HTTP 状态码；底层细节只进日志 |
| 测试 | ✅ 完成 | 74 个测试（vitest）全部通过：ProjectStore（11）、runAgent 经真实 WebSocket mock Gateway（11）、Writer（7）、LatexCompiler（7）、HTTP API 含全链路（12）、M1 既有（26）。`npm run build` / `npm run typecheck` / `npm test` 全部通过 |

M2 边界：未实现 Researcher / Fact Checker / 各 Reviewer、多 Agent Workflow、文献库、Evidence Store、上传、数据库、前端、用户系统（见 PRD §25）。

依赖变化：无新增运行时依赖（仍为零）；`engines` 从 `>=20` 调整为 `>=22`（runAgent 依赖 Node 22+ 内置 WebSocket，避免引入 `ws` 等第三方库）。
`package-lock.json` 因本机 npm 无法从原 lockfile 的 npmmirror 源安装而按官方 registry 重新生成（devDependencies 未变）。

## M2 验证状态汇总

| 验证项 | 状态 |
|---|---|
| 单元/集成测试（mock Gateway + 注入式 LaTeX runner） | ✅ 通过（74/74） |
| 真实 OpenClaw Gateway Agent 调用 | ❌ 未验证（本机无 Gateway 进程、无 .env；不伪造假验证） |
| 真实 LaTeX 编译产出 paper.pdf | ❌ 未验证（本机未安装 latexmk / xelatex） |
| 缺失环境时的错误路径 | ✅ 已验证（LatexToolUnavailable / AgentRuntimeUnavailable 等有明确错误码与短摘要） |

## M1：Backend Runtime Skeleton

## M1：Backend Runtime Skeleton

| 项 | 状态 | 说明 |
|---|---|---|
| Backend 基础工程（`backend/`） | ✅ 完成 | Node.js 20+ / TypeScript strict / ESM；零运行时依赖，dev 依赖仅 typescript + @types/node + vitest |
| 配置加载与校验 | ✅ 完成 | `loadConfig()`：必填 `OPENCLAW_GATEWAY_URL`（http/https 校验、归一化）、可选 `OPENCLAW_GATEWAY_API_KEY`；新增可选 `OPENCLAW_GATEWAY_HEALTH_TIMEOUT_MS`（默认 5000ms）。支持从仓库根 `.env` 补缺（不覆盖真实环境变量） |
| `AgentRuntime` 抽象 | ✅ 完成 | `src/runtime/types.ts` 定义统一契约（runAgent / getTask / cancelTask / sendMessage / streamEvents / healthCheck）与任务状态；M1 仅实现 `healthCheck()`，其余方法抛 `RuntimeCapabilityError`（无假实现） |
| `OpenClawRuntimeAdapter` | ✅ 完成 | 封装与 Gateway 的全部通信细节，业务层不感知 OpenClaw |
| Gateway Health Check | ✅ 代码与 mock 测试通过；⏳ 待真实 Gateway 环境验证 | 使用真实接口 `GET {gateway}/health`（无鉴权 liveness 探针，健康时返回 `200 {"ok":true,"status":"live"}`），已对照 OpenClaw 源码（`src/gateway/server-http.ts`）与官方文档（docs.openclaw.ai/gateway/health）确认 |
| Backend 启动入口 + `GET /health` | ✅ 完成 | 启动时输出 Gateway 健康结果；提供轻量 HTTP `GET /health`（Node 原生 http），返回 Backend 存活状态与实时 runtime 探测结果 |
| 测试 | ✅ 完成 | 30 个测试（vitest）：配置加载（合法/缺失/URL 非法等 11 项）、.env 解析（7 项）、Adapter 四态（healthy / unreachable / timeout / unhealthy 共 8 项，使用本地真实 HTTP 服务模拟）、HTTP 端点（4 项）；`npm run build` / `npm run typecheck` / `npm test` 全部通过 |

M1 边界：未实现任何业务 Agent、Workflow、数据库、前端等（见 PRD §25 阶段划分）。
`OPENCLAW_GATEWAY_API_KEY` 已预留但健康探针无需鉴权，留给后续 RPC 调用。

## 已确定的项目决策

| # | 决策 | 状态 |
|---|---|---|
| 1 | **Web 前端 + Linux Server 架构**：用户通过浏览器操作，论文写作、Agent 调度、LaTeX 编译、版本管理与系统维护全部在服务器端完成 | ✅ 已确定 |
| 2 | **Agent Runtime 使用 OpenClaw**：通过 OpenClaw Gateway 承载 Agent Team | ✅ 已确定 |
| 3 | **使用 AgentRuntimeAdapter 隔离 Runtime**：Backend 业务层只依赖统一的 `AgentRuntime` 接口，为未来替换或扩展 Runtime 保留边界 | ✅ 已确定 |
| 4 | **LaTeX 作为论文主格式**：XeLaTeX + latexmk 编译，输出 PDF；版本用 Git 管理，前端只暴露业务版本号 | ✅ 已确定 |
| 5 | **双模式前端**：普通用户的论文工作台 + 管理员的系统管理后台 | ✅ 已确定 |
| 6 | **多 Agent 覆盖完整论文流程**：多 Agent 写作（Researcher / Writer / Final Editor / LaTeX Engineer）、事实核验（Fact Checker）、学术审稿（Academic Reviewer）、文风审查（Style Reviewer）、视觉审稿（Visual Reviewer），由 Paper Manager 统一调度 | ✅ 已确定 |
| 7 | **服务器端后续使用 Docker 部署** | ✅ 已确定 |

各决策的背景与影响见 [DECISIONS.md](DECISIONS.md)。

## 待确定事项

- ~~后端语言/框架选型~~ → 已随 M1 落地为 Node.js + TypeScript（零运行时依赖起步，Web 框架待首个业务 API 里程碑再评估）
- 前端技术栈选型
- 数据库第一版使用 SQLite（PRD 建议方案，待最终确认）
- Docker 部署细节（镜像划分、compose 结构、TeX Live 镜像体积控制）
- M1/M2 遗留验证项：
  - ~~真实 OpenClaw Gateway 环境下的健康检查与 Agent 调用~~ → M2.1 已用本机 `openclaw@2026.8.1 gateway` 完成真实 smoke（健康检查、SDK connect/hello、RPC `status`、`agent` 验收 → `agent.wait` 终态）；带模型凭据的完整文本生成仍待有凭据的环境
  - 真实 LaTeX 编译（本机未安装 latexmk / xelatex；编译器代码与错误路径已通过注入式测试覆盖）

## M2 遗留项（进入后续里程碑前建议处理）

1. **真实环境验证**：带模型凭据环境下执行一次真实 Writer 调用到文本返回（M2.1 smoke 已验证协议链路至终态；本机 ~/.openclaw 需 `openclaw doctor --fix` 且未配模型，因 AutoClaw 共用该状态而未改动）；在装有 TeX Live 的环境跑一次真实编译（当前机器两者均缺）。
2. **runAgent 连接复用**：每次 runAgent 新建一条 GatewayClient 连接（M2.1 有意保持的简单语义；单次连接失败即放弃，不搭乘 SDK 重试循环）；后续并发多 Agent 时再评估长连接/池化。
3. **getTask / cancelTask / streamEvents / sendMessage**：仍为 `RuntimeCapabilityError`，属后续里程碑（Paper Manager 调度、任务状态查询需要它们）。SDK 已具备事件订阅能力（onEvent / sessions.*），M3 做 Progress/Event 时接入。
4. **generate 为同步阻塞 API**：写作 + 编译在一次 HTTP 请求内完成（可能长耗时）；后续里程碑引入任务模型（POST 返回 taskId + 轮询/SSE）。
5. **LaTeX fallback 只跑单轮 xelatex**：交叉引用可能需要两轮；latexmk 路径无此问题。真实环境首推 latexmk。
6. **项目列表 / 删除 / 上传 / Git 版本管理**：第二阶段范围内，M2 未做。

## MVP 阶段划分（摘自 PRD §25）

| # | 阶段 | 范围 | 状态 |
|---|---|---|---|
| 1 | Runtime 基础 | Linux 部署、OpenClaw Gateway、PaperTeam Backend、AgentRuntimeAdapter | M1 Backend Runtime Skeleton 已完成，待真实 Gateway 环境验证 |
| 2 | Agent 基础调用与项目 / LaTeX 基础 | runAgent / getTask / streamEvents 等完整 Runtime 调用、Paper Manager 基础调度、基础项目目录与 project.json、项目列表 / 新建项目、资料上传、LaTeX 编译、PDF 输出、历史版本（Git） | M2 已交付其中的 runAgent、项目目录 / project.json、新建项目 API、LaTeX 编译、PDF 输出（mock 验证）；getTask / streamEvents、Paper Manager 调度、上传、Git 版本为 M2 遗留项 |
| 3 | Project Literature Library + Evidence Store | 项目文献库、添加参考文献（PDF / BibTeX / DOI / arXiv / URL）、文献解析与项目级检索、Evidence 反向定位原始文献、「文献与证据」页面、资料检索范围控制 | 未开始 |
| 4 | Researcher / Writer / Fact Checker 核心闭环 | 优先项目文献库检索 + 受控网络补充、基于 Evidence 写作、可追溯核验链路、写作流程最小闭环 | 未开始 |
| 5 | 完整多 Agent Workflow | Academic Reviewer、Style Reviewer、Final Editor、全面审稿、修改闭环、审稿报告与 Workflow 进度 | 未开始 |
| 6 | 视觉审稿 | PDF 页面渲染、Visual Reviewer、PDF 问题定位、LaTeX Engineer、自动修复闭环 | 未开始 |
| 7 | 系统管理 | 系统状态、Gateway / Agent / 模型 / Workflow 配置、日志、系统诊断、文件管理、Command Center、Web Terminal | 未开始 |

其中第 3 阶段（Project Literature Library + Evidence Store）必须先于 Researcher / Fact Checker 完整能力落地：二者的检索、Evidence 生成与事实核验都依赖稳定的项目级文献检索和证据来源（见 PRD §25）。
