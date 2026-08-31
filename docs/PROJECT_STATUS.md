# PaperTeam 项目状态

> 更新日期：2026-08-31

## 当前阶段

**第二阶段（Agent 基础调用与项目 / LaTeX 基础）：M2「Agent Invocation + Project + LaTeX Skeleton」已完成代码与 mock 验证，待真实 OpenClaw / 真实 LaTeX 环境验证。**

M2 交付的最小真实闭环：`POST /api/projects` 创建论文项目 → `POST /api/projects/:id/generate` 通过 `AgentRuntime.runAgent()` 真实调用 Writer Agent → 校验 LaTeX → 写入 `manuscript/main.tex` → `LatexCompiler` 编译 → `build/paper.pdf`。

**下一阶段：第三阶段「Project Literature Library + Evidence Store」尚未开始（M2 刻意未包含文献库与多 Agent）。**

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
  - 真实 OpenClaw Gateway 环境下的健康检查与 Agent 调用（本机开发环境无 Gateway 进程与 .env；M2 已用按官方协议实现的本地 WebSocket mock 完成全链路验证）
  - 真实 LaTeX 编译（本机未安装 latexmk / xelatex；编译器代码与错误路径已通过注入式测试覆盖）

## M2 遗留项（进入后续里程碑前建议处理）

1. **真实环境验证**：在有 OpenClaw Gateway 的环境配置 `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_API_KEY` / `OPENCLAW_WRITER_AGENT_ID` 后执行一次真实 Writer 调用；在装有 TeX Live 的环境跑一次真实编译（当前机器两者均缺）。
2. **runAgent 连接复用**：当前每次 runAgent 新建一条 WebSocket 连接（M2 简化）；后续需要并发多 Agent 时应引入连接池 / 长连接管理。
3. **getTask / cancelTask / streamEvents / sendMessage**：仍为 `RuntimeCapabilityError`，属第二阶段剩余工作（Paper Manager 调度、任务状态查询需要它们）。
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
