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
- **Workspace / Evidence / Artifacts 是事实来源**：Runtime Session 只是可重建的执行上下文，业务恢复不依赖 Chat History。
- **Build Gate 与 Quality Gate 分离**：Draft PDF 只要求可构建；标记 Final 必须通过事实、引用与审稿质量门。

普通用户只需通过浏览器使用；Agent 调度、模型调用、LaTeX 编译、PDF 生成、版本管理、日志与系统维护全部由 Linux 服务器完成。

## 当前状态

| 里程碑                                            | 状态   | 内容                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 Backend Runtime Skeleton                    | ✅ 完成 | Backend 工程、`AgentRuntime` 抽象、Runtime 健康检查（历史 OpenClaw Gateway 基线）                                                                                                                                                      |
| M2 Agent Invocation + Project + LaTeX          | ✅ 完成 | `runAgent()` 真实调用链、`ProjectStore`、`WriterService`、`GenerationService`、`LatexCompiler`、HTTP API                                                                                                                          |
| M2.1 OpenClaw 2.0 Runtime Upgrade              | ✅ 完成 | 官方 `@openclaw/gateway-client` / `@openclaw/gateway-protocol`（wire protocol v4）、Project 与 Runtime Session 隔离（历史基线，M3.8 已随迁移移除）                                                                                             |
| Architecture Research & Product Design Refresh | ✅ 完成 | 竞品调研与产品/架构方向冻结（D-0008\~D-0015）                                                                                                                                                                                          |
| **M3.0 Workflow Foundation**                   | ✅ 完成 | `WorkflowOrchestrator`（确定性引擎）、`StageContract`（DoD）、异步 `WorkflowRun` + checkpoint/resume、Domain Event + SSE、HITL awaiting\_input、协作式取消、Session contextScope                                                              |
| **M3.1 Research & Evidence**                   | ✅ 完成 | Researcher（调研 + Evidence 候选）、Target Feasibility（HIGH/MEDIUM/LOW/INSUFFICIENT + HITL adjust）、`EvidenceStore`（JSONL）、Citation 核验（静态 + CrossRef/OpenAlex/arXiv）、文献库 + PDF 文本层分析（多模态为扩展点）、分节写作、Derived Context              |
| **M3.2 Review & Revision**                     | ✅ 完成 | Reviewer（fact/academic/style 三 skill 并行）、确定性聚合、Quality Gate（9 规则）、bounded revision loop（≤2 轮 + 超限 HITL）、Build Gate、Draft/Final 双 Gate 语义、Existing-LaTeX 导入（防 Zip Slip）与改造 workflow                                      |
| **M3.5 Runtime Bootstrap / M3 Closure**        | ✅ 完成 | **M3 Complete**：PaperTeam 独立 Runtime state、`npm run dev` 一键启动、Agent 映射（方案 A，D-0018）、`GET /api/runtime/status` 诊断、优雅关闭无孤儿（历史 OpenClaw Gateway 形态，M3.8 已简化）                                                                          |
| **M3.6 Runtime Baseline Upgrade**              | ✅ 完成 | OpenClaw baseline 2026.8.2 → **2026.9.1**（历史基线；M3.8 起 OpenClaw 不再参与运行）                                                                                                                                                        |
| **M3.7 Pi Runtime Feasibility**                | ✅ 完成 | Side-by-side `PiRuntimeAdapter`（`@earendil-works/pi-coding-agent` 0.84.4）全项验证（in-process 嵌入 / 三路并发 / abort / 事件 / 隔离 / Windows 零 Gateway 子进程），结论 MIGRATE TO PI（历史可行性验证）                                                                              |
| **M3.8 Pi Runtime Migration & Contract v2**    | ✅ 完成 | **Pi 成为唯一正式 Runtime**（OpenClaw Gateway / Bootstrap / 三依赖全部移除）；`AgentRuntime` Contract v2（`startAgent` → 句柄：运行中事件流 / 取消 / result）；tool execution abort 传导实证；RuntimeStatus 去 Gateway 化；`npm run dev` 直启 Backend（零 Gateway 子进程）                                                  |

**M3.8 Complete**：Runtime baseline 为 **Pi SDK in-process**（`@earendil-works/pi-coding-agent`
0.84.4 精确 pin，Node.js + npm）。`npm run dev` 启动链为
`dev.mjs → backend/dist/index.js`（Node 检查 → 依赖检查 → 构建 → 直启 Backend；
无 Gateway 子进程 / 端口 / 握手 / state 准备）。OpenClaw 2026.9.1 是 M3.6 的历史
baseline（M3.7 完成可行性验证，M3.8 正式迁移到 Pi）。230 个测试全部通过。

**未实现（M4+）**：前端工作台（React）、Visual Reviewer、LaTeX repair loop、
完整版本管理体验、系统管理后台、Docker 部署。

## 文档

| 文档                                                | 说明                                                |
| ------------------------------------------------- | --- |
| [docs/PRD.md](docs/PRD.md)                        | 产品需求文档                                            |
| [docs/PROJECT\_STATUS.md](docs/PROJECT_STATUS.md) | 项目当前状态与路线（M3.0 ~ M3.8 / M4+）                        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)      | 系统架构说明                                            |
| [docs/DECISIONS.md](docs/DECISIONS.md)            | 技术决策记录（ADR）                                       |

## 目录结构

```text
PaperTeam/
├── package.json      # 根开发入口（npm run dev / build / test 转发）
├── scripts/dev.mjs   # dev 启动器（Node/依赖检查 → 构建 → 直启 Backend）
├── frontend/         # Web 前端（论文工作台 + 系统管理后台，M4+）
├── backend/          # PaperTeam Backend（API / Workflow / Pi Runtime / LaTeX / 版本管理）
├── agents/           # Agent 定义与配置（AGENTS.md 等）
├── docker/           # Docker 部署配置
└── docs/             # 项目文档
```

## 快速开始（Quick Start）

```bash
git clone https://github.com/JiahongXu88/PaperTeam.git
cd PaperTeam
npm install            # 安装依赖（backend：Pi SDK 0.84.4 精确 pin）
npm run dev            # 一键启动：PaperTeam Backend（Pi Runtime in-process）
```

`npm run dev` 会自动完成：

1. Node 版本检查（复用根 package.json 的 `engines.node`：`>=22.22.3 <23` / `>=24.15.0 <25` / `>=25.9.0`，Node 26+ 可用）
2. backend 依赖安装与构建（缺失时自动 `npm install` + `tsc`）
3. 启动 PaperTeam Backend（`http://localhost:3000`，Pi SDK 以 in-process 方式嵌入，无 Gateway 子进程）
4. `Ctrl+C` 优雅关闭（Backend 取消活跃 run、收敛 Runtime、落盘 checkpoint 后退出）

### 配置模型（可选但 Agent 调用必需）

Runtime 不搬运任何其他项目的凭据。为 PaperTeam 配置模型（三选一，优先级从高到低）：

```bash
# 方式 A：环境变量（.env，见 .env.example）
echo PAPERTEAM_PI_MODEL=anthropic/claude-opus-4-5 >> .env
echo PAPERTEAM_PI_API_KEY=sk-ant-... >> .env

# 方式 B：Pi 官方凭据文件（PaperTeam 专属目录，与 ~/.pi 隔离）
#   Windows:   %USERPROFILE%\.paperteam\runtime\pi\agent\auth.json
#   Linux/macOS: ~/.paperteam/runtime/pi/agent/auth.json
# 方式 C：标准环境变量（ANTHROPIC_API_KEY / OPENAI_API_KEY / ...）

# 重启 npm run dev 后，用诊断确认：
curl http://localhost:3000/api/runtime/status
#   runtime.phase: healthy + model.phase: configured
```

不配置模型时 `npm run dev` 仍正常启动（Runtime healthy、Backend healthy、API 可用），
`GET /api/runtime/status` 如实上报 `model.phase: not_configured`（Runtime 健康 ≠ 模型
就绪），Agent 调用会返回结构化失败，不伪造成功。

### 常用诊断

```bash
curl http://localhost:3000/health                # 存活探针（含 Pi Runtime 实时健康）
curl http://localhost:3000/api/runtime/status    # runtime/agents/model/sessions 全景诊断
```

### 开发调试（backend 单独运行 / 测试）

```bash
cd backend
npm install
npm test              # 230 个测试
npm run typecheck && npm run build
# 单独启动 backend（Pi Runtime in-process，无需任何外部 Runtime）：
npm start
```

当前提供的 API（Node 原生 HTTP，无 Web 框架；完整清单见
[PROJECT\_STATUS.md](docs/PROJECT_STATUS.md)「M3 API 一览」）：

```text
GET    /health                                存活探针（含 Pi Runtime 实时健康）
GET    /api/runtime/status                    Runtime 诊断（runtime/agents/model/sessions）

── 主入口：Workflow API ──
POST   /api/projects                          创建论文项目（含研究定位字段）
POST   /api/projects/:id/workflows            创建异步 WorkflowRun → {runId}
GET    /api/runs/:runId                       run 状态 / 当前 stage / HITL 待办
GET    /api/runs/:runId/events                SSE 进度（Domain Event replay + 实时）
POST   /api/runs/:runId/resume                提交 HITL 输入（approve/adjust/…）
POST   /api/runs/:runId/cancel                取消 run
GET    /api/projects/:id                      查询项目元数据
PATCH  /api/projects/:id                      更新研究定位（targetProfile 等）

── 调试 / 手动操作 / 工具 API（编排由后端 WorkflowOrchestrator 完成，
── 前端无需也不应自行串联这些端点）──
POST   /api/projects/:id/import               导入已有 LaTeX 项目（zip，防路径穿越）
POST   /api/projects/:id/sources              上传文献 PDF（sourceRole: evidence/reference/both）
POST   /api/projects/:id/citation-check       引用核验（静态 + 公开元数据）
POST   /api/projects/:id/review               全面审稿（fact/academic/style 并行）
POST   /api/projects/:id/quality-gate         Quality Gate 评估
POST   /api/projects/:id/build                Build Gate + Draft PDF
POST   /api/projects/:id/generate             M2 同步写作+编译（deprecated，保留兼容）
（另有 sources/evidence/feasibility/citation-report/reviews/manuscript/context 查询端点）
```

`workflows` 的内部链路（Idea-to-Paper）：`WorkflowOrchestrator` 确定性推进
`research.idea → research.feasibility → HITL 确认 → outline → HITL 确认 → 分节写作
→ 引用核验 → 三路审稿 → Quality Gate →（bounded 修订 ≤2 轮 / 超限 HITL）→ Build Gate`；
所有 Agent 产出必须通过 Stage DoD 校验才算完成；进程中断后从 checkpoint 恢复，
已成功 stage 不重复执行。

所有 Agent 调用通过 `AgentRuntime` 契约（v2：`startAgent()` 返回句柄 ——
运行中可消费事件流、可取消、`result()` 单独 await；`runAgent()` 为同步终态
convenience）执行，当前实现为 `PiRuntimeAdapter`（`@earendil-works/pi-coding-agent`
SDK in-process；业务层不 import Pi SDK）。会话维度为
`projectId × agentId × contextScope`：同一项目同一 Agent 的不同 scope（如 Reviewer 的
`review/fact` / `review/academic` / `review/style`）持有独立会话、可并行、互不污染；
Project ≠ Session：Session 是可重建的 Runtime Context，不承担项目事实来源
（恢复依据是 Workspace 状态与 workflow checkpoint）。

其余部分的开发与部署指南待补充。

## 环境变量

参考 [.env.example](.env.example)：复制为 `.env` 后填入真实值。`.env` 已被 Git 忽略，
**不要提交任何真实 Key**。模型配置（`PAPERTEAM_PI_MODEL` / `PAPERTEAM_PI_API_KEY`）
见上文「配置模型」。

## Runtime 说明（M3.8）

- **Pi in-process**：`@earendil-works/pi-coding-agent` **0.84.4** 精确 pin（backend
  `package.json`），无 Gateway 子进程 / WebSocket / RPC；`npm run dev` 直启 Backend。
- **业务角色映射**：Researcher / Writer / Reviewer / Citation 无 agent 注册表概念，
  角色（systemPrompt + 工具白名单）由 `PiRuntimeAdapter` 按 contextScope 前缀解析
  （research\* → researcher、writing\* → writer、review\* → reviewer；方案 A，
  [D-0018](docs/DECISIONS.md)）；会话标识可用
  `PAPERTEAM_{WRITER|RESEARCHER|REVIEWER|CITATION}_AGENT_ID` 覆盖（默认 main，
  仅作 sessionKey 组成段与诊断标签）。
- **独立配置目录**：`~/.paperteam/runtime/pi/agent/`（`PAPERTEAM_RUNTIME_ROOT` 可覆盖；
  auth.json / models.json 放这里），与用户全局 `~/.pi` 隔离。
- **历史**：OpenClaw 2026.9.1 为 M3.5/M3.6 的历史 Runtime baseline；M3.7 完成Pi
  可行性验证；M3.8 正式迁移到 Pi 并移除 OpenClaw 全部运行时依赖（git 历史即回退机制）。
