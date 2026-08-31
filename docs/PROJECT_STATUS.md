# PaperTeam 项目状态

> 更新日期：2026-08-31

## 当前阶段

**第一阶段（Runtime 基础）：M1 Backend Runtime Skeleton 已完成（待真实 Gateway 环境验证）**。
Backend 可启动，通过统一 `AgentRuntime` 接口与 OpenClaw Gateway 完成健康检查；`AgentRuntime` 抽象、`OpenClawRuntimeAdapter`、Gateway health check 均已完成，真实 OpenClaw Gateway 连通仍属待环境验证项。

**下一阶段：第二阶段「Agent 基础调用与项目 / LaTeX 基础」，尚未开始。**

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
- M1 遗留验证项：真实 OpenClaw Gateway 环境下的连通验证（本机开发环境无 Gateway 进程；已用按官方契约响应的本地探针服务完成链路验证）

## MVP 阶段划分（摘自 PRD §25）

| # | 阶段 | 范围 | 状态 |
|---|---|---|---|
| 1 | Runtime 基础 | Linux 部署、OpenClaw Gateway、PaperTeam Backend、AgentRuntimeAdapter | M1 Backend Runtime Skeleton 已完成，待真实 Gateway 环境验证 |
| 2 | Agent 基础调用与项目 / LaTeX 基础 | runAgent / getTask / streamEvents 等完整 Runtime 调用、Paper Manager 基础调度、基础项目目录与 project.json、项目列表 / 新建项目、资料上传、LaTeX 编译、PDF 输出、历史版本（Git） | 未开始（当前下一阶段） |
| 3 | Project Literature Library + Evidence Store | 项目文献库、添加参考文献（PDF / BibTeX / DOI / arXiv / URL）、文献解析与项目级检索、Evidence 反向定位原始文献、「文献与证据」页面、资料检索范围控制 | 未开始 |
| 4 | Researcher / Writer / Fact Checker 核心闭环 | 优先项目文献库检索 + 受控网络补充、基于 Evidence 写作、可追溯核验链路、写作流程最小闭环 | 未开始 |
| 5 | 完整多 Agent Workflow | Academic Reviewer、Style Reviewer、Final Editor、全面审稿、修改闭环、审稿报告与 Workflow 进度 | 未开始 |
| 6 | 视觉审稿 | PDF 页面渲染、Visual Reviewer、PDF 问题定位、LaTeX Engineer、自动修复闭环 | 未开始 |
| 7 | 系统管理 | 系统状态、Gateway / Agent / 模型 / Workflow 配置、日志、系统诊断、文件管理、Command Center、Web Terminal | 未开始 |

其中第 3 阶段（Project Literature Library + Evidence Store）必须先于 Researcher / Fact Checker 完整能力落地：二者的检索、Evidence 生成与事实核验都依赖稳定的项目级文献检索和证据来源（见 PRD §25）。
