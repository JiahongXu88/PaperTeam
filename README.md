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
| M2.1 OpenClaw 2.0 Runtime Upgrade | ✅ 完成 | 官方 `@openclaw/gateway-client` / `@openclaw/gateway-protocol`（2026.8.1，wire protocol v4）、Project 与 Runtime Session 隔离 |
| Architecture Research & Product Design Refresh | ✅ 完成 | 竞品调研与产品/架构方向冻结（D-0008~D-0015） |
| **M3.0 Workflow Foundation** | ✅ 完成 | `WorkflowOrchestrator`（确定性引擎）、`StageContract`（DoD）、异步 `WorkflowRun` + checkpoint/resume、Domain Event + SSE、HITL awaiting_input、协作式取消、Session contextScope |
| **M3.1 Research & Evidence** | ✅ 完成 | Researcher（调研 + Evidence 候选）、Target Feasibility（HIGH/MEDIUM/LOW/INSUFFICIENT + HITL adjust）、`EvidenceStore`（JSONL）、Citation 核验（静态 + CrossRef/OpenAlex/arXiv）、文献库 + PDF 文本层分析（多模态为扩展点）、分节写作、Derived Context |
| **M3.2 Review & Revision** | ✅ 完成 | Reviewer（fact/academic/style 三 skill 并行）、确定性聚合、Quality Gate（9 规则）、bounded revision loop（≤2 轮 + 超限 HITL）、Build Gate、Draft/Final 双 Gate 语义、Existing-LaTeX 导入（防 Zip Slip）与改造 workflow |

当前后端提供两条完整业务工作流（Idea-to-Paper 与 Existing-LaTeX Improvement，
测试中以脚本化 Agent Runtime 全链路验证；带真实模型凭据的 E2E、TeX Live 真实编译、
多模态 PDF 视觉级分析为非阻塞环境验证缺口，见
[PROJECT_STATUS.md](docs/PROJECT_STATUS.md)）。215 个测试全部通过。

**未实现（M4+ / 独立任务）**：前端工作台、Visual Reviewer、LaTeX repair loop、
完整版本管理体验、系统管理后台、Docker 部署、Runtime Bootstrap（`npm run dev`
自动安装/启动 Gateway，已单列为独立工程任务）。

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

当前提供的 API（Node 原生 HTTP，无 Web 框架；完整清单见
[PROJECT_STATUS.md](docs/PROJECT_STATUS.md)「M3 API 一览」）：

```text
GET    /health                                存活探针（含 Gateway 实时健康）
POST   /api/projects                          创建论文项目（含研究定位字段）
GET    /api/projects/:id                      查询项目元数据
PATCH  /api/projects/:id                      更新研究定位（targetProfile 等）
POST   /api/projects/:id/generate             M2 同步写作+编译（deprecated，保留兼容）
POST   /api/projects/:id/workflows            创建异步 WorkflowRun → {runId}
GET    /api/runs/:runId                       run 状态 / 当前 stage / HITL 待办
GET    /api/runs/:runId/events                SSE 进度（Domain Event replay + 实时）
POST   /api/runs/:runId/resume                提交 HITL 输入（approve/adjust/…）
POST   /api/runs/:runId/cancel                取消 run
POST   /api/projects/:id/import               导入已有 LaTeX 项目（zip，防路径穿越）
POST   /api/projects/:id/sources              上传文献 PDF（sourceRole: evidence/reference/both）
POST   /api/projects/:id/citation-check       引用核验（静态 + 公开元数据）
POST   /api/projects/:id/review               全面审稿（fact/academic/style 并行）
POST   /api/projects/:id/quality-gate         Quality Gate 评估
POST   /api/projects/:id/build                Build Gate + Draft PDF
（另有 sources/evidence/feasibility/citation-report/reviews/manuscript/context 查询端点）
```

`workflows` 的内部链路（Idea-to-Paper）：`WorkflowOrchestrator` 确定性推进
`research.idea → research.feasibility → HITL 确认 → outline → HITL 确认 → 分节写作
→ 引用核验 → 三路审稿 → Quality Gate →（bounded 修订 ≤2 轮 / 超限 HITL）→ Build Gate`；
所有 Agent 产出必须通过 Stage DoD 校验才算完成；进程中断后从 checkpoint 恢复，
已成功 stage 不重复执行。

所有 Agent 调用通过 `AgentRuntime.runAgent()`（经由官方 `@openclaw/gateway-client` SDK
调用 OpenClaw Gateway 的 `agent` / `agent.wait` / `chat.history` RPC）执行。会话维度为
`projectId × agentId × contextScope`：同一项目同一 Agent 的不同 scope（如 Reviewer 的
`review/fact` / `review/academic` / `review/style`）持有独立会话、可并行、互不污染；
Project ≠ Session：Session 是可重建的 Runtime Context，不承担项目事实来源
（恢复依据是 Workspace 状态与 workflow checkpoint）。

其余部分的开发与部署指南待补充。

## 环境变量

参考 [.env.example](.env.example)：复制为 `.env` 后填入真实值。`.env` 已被 Git 忽略，**不要提交任何真实 Key**。
