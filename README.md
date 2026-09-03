# PaperTeam

**AI Multi-Agent Academic Research & Paper Workbench**

从研究 Idea 到论文交付、以及已有论文系统性改造的 AI 多 Agent 学术研究与论文生产工作台。

核心链路：

```text
Idea → Research → Feasibility → Evidence → Writing → Review → Revision → LaTeX / PDF
```

支持两类一级工作流：

1. **Idea-to-Paper**：输入研究 Idea、领域、已有材料与目标论文档次，由 Researcher 先完成领域调研与 Novelty / Feasibility 分析，经用户确认后再进入 Evidence、Outline、Writing、Review、Revision，最终产出 LaTeX / PDF。
2. **Existing LaTeX Improvement**：导入已有 LaTeX 项目（main.tex / sections / references.bib / figures），经结构解析、Baseline 编译、论文理解、Citation Audit、Academic Review、Target Level Assessment 与用户确认后，逐节系统性改造。

产品原则（详见 [docs/PRD.md](docs/PRD.md)）：

- **Target Feasibility Assessment**：系统基于 Idea、Novelty、Evidence 与实验条件诚实评估目标论文层级是否可被支撑，不承诺无法达到的目标（如"一键生成顶会论文"）。
- **少量专业 Agent + Skill**：M3 Agent Team 为 Researcher / Writer / Reviewer / Citation；流程编排由后端确定性的 TypeScript WorkflowOrchestrator 负责，不使用 LLM Agent 做流程控制。
- **Workspace / Evidence / Artifacts 是事实来源**：OpenClaw Session 只是可重建的 Runtime Context，业务恢复不依赖 Chat History。
- **Build Gate 与 Quality Gate 分离**：Draft PDF 只要求可构建；标记 Final 必须通过事实、引用与审稿质量门。

普通用户只需通过浏览器使用；Agent 调度、模型调用、LaTeX 编译、PDF 生成、版本管理、日志与系统维护全部由 Linux 服务器完成。

## 当前状态

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M1 Backend Runtime Skeleton | ✅ 完成 | Backend 工程、`AgentRuntime` 抽象、`OpenClawRuntimeAdapter`、Gateway 健康检查 |
| M2 Agent Invocation + Project + LaTeX | ✅ 完成 | `runAgent()` 真实调用链、`ProjectStore`、`WriterService`、`GenerationService`、`LatexCompiler`、HTTP API |
| M2.1 OpenClaw 2.0 Runtime Upgrade | ✅ 完成 | 官方 `@openclaw/gateway-client` / `@openclaw/gateway-protocol`（2026.8.1，wire protocol v4）、Project 与 Runtime Session 隔离、`runtimeSessionKey` 持久化；79 个测试全部通过，真实 Gateway smoke 通过 |
| Architecture Research & Product Design Refresh | ✅ 完成 | 竞品调研（vs PaperKit / Open Academic Paper Machine / AutoResearchClaw）与产品/架构方向冻结（见 [docs/DECISIONS.md](docs/DECISIONS.md) D-0008~D-0015） |
| M3.0 Workflow Foundation | 🔜 下一阶段 | WorkflowOrchestrator、StageContract、异步 WorkflowRun、事件 / SSE、HITL checkpoint |

当前后端提供最小真实闭环：创建论文项目 → `generate` 调用 Writer Agent 生成 LaTeX → 编译 PDF。多 Agent Workflow、文献库与 Evidence Store 属于 M3 范围，尚未实现。

## 文档

| 文档 | 说明 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | 项目当前状态与路线（M3.0 / M3.1 / M3.2 / M4+） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构说明 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 技术决策记录（ADR） |

## 目录结构

```text
PaperTeam/
├── frontend/   # Web 前端（论文工作台 + 系统管理后台，M4+）
├── backend/    # PaperTeam Backend（API / Workflow / Runtime / LaTeX / 版本管理）
├── agents/     # Agent 定义与配置（AGENTS.md 等）
├── docker/     # Docker 部署配置
└── docs/       # 项目文档
```

## 快速开始（Backend）

```bash
cd backend
npm install
npm run build
npm test
# 复制并填写环境变量（至少需要 OPENCLAW_GATEWAY_URL）
cp ../.env.example ../.env
npm start
```

> 运行时要求 **Node.js >= 22.19.0**（官方 `@openclaw/gateway-client` /
> `@openclaw/gateway-protocol` 的 engines 约束）。

启动后 Backend 会加载配置、初始化 `OpenClawRuntimeAdapter` 并对 OpenClaw Gateway
执行一次健康检查（真实接口：`GET {OPENCLAW_GATEWAY_URL}/health`）。

当前提供的 API（Node 原生 HTTP，无 Web 框架）：

```text
GET  /health                      存活探针（含 Gateway 实时健康）
POST /api/projects                创建论文项目 {title}
GET  /api/projects/:id            查询项目元数据
POST /api/projects/:id/generate   Writer 写作 + LaTeX 编译 {prompt}
```

`generate` 的内部链路：创建/定位项目 → `AgentRuntime.runAgent()`（经由官方
`@openclaw/gateway-client` SDK 调用 OpenClaw Gateway 的 `agent` / `agent.wait` /
`chat.history` RPC）→ Writer 返回完整 LaTeX → 校验后写入 `manuscript/main.tex`
→ `LatexCompiler` 编译 → `build/paper.pdf`。

> `generate` 目前是同步阻塞 API；M3.0 将引入异步 `WorkflowRun`
> （`POST /api/projects/:id/workflows` → `runId` + 轮询 / SSE 进度）。

每个论文项目（Project）通过派生的 `sessionKey`（`agent:{agentId}:paperteam-{projectId}`）
绑定独立的 OpenClaw 会话，并在 `project.json` 中持久化引用（`runtimeSessionKey`），
保证同一项目上下文连续、不同项目互不污染。Project ≠ Session：Session 是可重建的
Runtime Context，不承担项目事实来源。

其余部分的开发与部署指南待补充。

## 环境变量

参考 [.env.example](.env.example)：复制为 `.env` 后填入真实值。`.env` 已被 Git 忽略，**不要提交任何真实 Key**。
