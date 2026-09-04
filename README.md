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
| M2.1 OpenClaw 2.0 Runtime Upgrade | ✅ 完成 | 官方 `@openclaw/gateway-client` / `@openclaw/gateway-protocol`（wire protocol v4）、Project 与 Runtime Session 隔离 |
| Architecture Research & Product Design Refresh | ✅ 完成 | 竞品调研与产品/架构方向冻结（D-0008~D-0015） |
| **M3.0 Workflow Foundation** | ✅ 完成 | `WorkflowOrchestrator`（确定性引擎）、`StageContract`（DoD）、异步 `WorkflowRun` + checkpoint/resume、Domain Event + SSE、HITL awaiting_input、协作式取消、Session contextScope |
| **M3.1 Research & Evidence** | ✅ 完成 | Researcher（调研 + Evidence 候选）、Target Feasibility（HIGH/MEDIUM/LOW/INSUFFICIENT + HITL adjust）、`EvidenceStore`（JSONL）、Citation 核验（静态 + CrossRef/OpenAlex/arXiv）、文献库 + PDF 文本层分析（多模态为扩展点）、分节写作、Derived Context |
| **M3.2 Review & Revision** | ✅ 完成 | Reviewer（fact/academic/style 三 skill 并行）、确定性聚合、Quality Gate（9 规则）、bounded revision loop（≤2 轮 + 超限 HITL）、Build Gate、Draft/Final 双 Gate 语义、Existing-LaTeX 导入（防 Zip Slip）与改造 workflow |
| **M3.5 Runtime Bootstrap / M3 Closure** | ✅ 完成 | **M3 Complete**：PaperTeam 独立 OpenClaw Runtime（隔离 state、精确版本 pin）、`npm run dev` 一键启动、Agent 映射（方案 A，D-0018）、`GET /api/runtime/status` 诊断、优雅关闭无孤儿 |
| **M3.6 Runtime Baseline Upgrade** | ✅ 完成 | OpenClaw baseline 2026.8.2 → **2026.9.1**（openclaw / gateway-client / gateway-protocol 三处统一精确 pin，protocol v4 不变）；Node 兼容检查改为复用根 package.json engines（Node 26+ 可用）；runtime.json 旧版本自动迁移；全量回归 255 测试 + 真实 Gateway E2E 通过 |

**M3.6 Complete**：后端「完整 M3 可运行基线」的 Runtime baseline 已固化在
OpenClaw 2026.9.1（Node.js + npm 为当前 Runtime / Package Manager baseline，
M4 前端 React 19 + TypeScript + Vite 将基于该版本继续开发）。`npm run dev`
在全新机器上真实验证过：自动初始化独立 state → Gateway 2026.9.1 healthy →
Backend healthy → workflow 真实推进到 Researcher 的 Gateway RPC 调用层
（无模型凭据时如实进入 `model_not_configured` / 结构化失败，不伪造）；
存量安装（runtime.json 仍记录旧版本）升级时自动迁移、不误报漂移。带真实
模型凭据的完整全链路 E2E、TeX Live 真实编译、多模态 PDF 视觉级分析为
非阻塞环境验证缺口，见 [PROJECT_STATUS.md](docs/PROJECT_STATUS.md)。
255 个测试全部通过。

**未实现（M4+）**：前端工作台、Visual Reviewer、LaTeX repair loop、
完整版本管理体验、系统管理后台、Docker 部署。

## 文档

| 文档 | 说明 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | 项目当前状态与路线（M3.0 / M3.1 / M3.2 / M3.5 / M3.6 / M4+） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构说明 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 技术决策记录（ADR） |

## 目录结构

```text
PaperTeam/
├── package.json      # 根开发入口（openclaw runtime 精确 pin + npm run dev）
├── scripts/dev.mjs   # dev 启动器（依赖/构建检查 → Runtime Bootstrap）
├── frontend/         # Web 前端（论文工作台 + 系统管理后台，M4+）
├── backend/          # PaperTeam Backend（API / Workflow / Runtime / LaTeX / 版本管理）
├── agents/           # Agent 定义与配置（AGENTS.md 等）
├── docker/           # Docker 部署配置
└── docs/             # 项目文档
```

## 快速开始（Quick Start）

```bash
git clone https://github.com/JiahongXu88/PaperTeam.git
cd PaperTeam
npm install            # 安装根依赖（含 openclaw runtime 本体，精确 pin 2026.9.1）
npm run dev            # 一键启动：独立 OpenClaw Gateway + PaperTeam Backend
```

`npm run dev` 会自动完成：

1. Node 版本检查（复用根 package.json 的 `engines.node`，与 openclaw 2026.9.1 支持范围一致：`>=22.22.3 <23` / `>=24.15.0 <25` / `>=25.9.0`，Node 26+ 可用且为官方推荐线）
2. backend 依赖安装与构建（缺失时自动 `npm install` + `tsc`）
3. 初始化 **PaperTeam 独立 OpenClaw Runtime**（用户级 `~/.paperteam/runtime/openclaw/`，与全局 `~/.openclaw` 完全隔离；首次生成随机 Gateway token）
4. 启动 OpenClaw Gateway（`http://127.0.0.1:18790`）并等待健康
5. 启动 PaperTeam Backend（`http://localhost:3000`）
6. `Ctrl+C` 优雅关闭全部进程（先 Backend 后 Gateway，无孤儿进程）

**PaperTeam 自动管理自己的 OpenClaw Runtime**：不要求全局安装 OpenClaw，不读写
`~/.openclaw`，不依赖任何 OpenClaw 源码 checkout（`D:\Projects\openclaw` 只是可选的
源码参考，**不是运行依赖**）。版本由根 `package.json` 精确 pin，lockfile 可复现。

### 配置模型（可选但 Agent 调用必需）

Bootstrap 不搬运任何其他项目的凭据。为 PaperTeam 的独立 Gateway 配置模型：

```bash
# 把 provider API Key 写入 PaperTeam 独立 state 的 .env（OpenClaw 官方凭据位置）
#   Windows: %USERPROFILE%\.paperteam\runtime\openclaw\.env
#   Linux/macOS: ~/.paperteam/runtime/openclaw/.env
echo ANTHROPIC_API_KEY=sk-ant-... >> ~/.paperteam/runtime/openclaw/.env
# 重启 npm run dev 后，用诊断确认：
curl http://localhost:3000/api/runtime/status
#   runtime.phase: ready（model_not_configured 表示还没有任何凭据）
```

不配置模型时 `npm run dev` 仍正常启动（Gateway healthy、Backend healthy、API 可用），
`GET /api/runtime/status` 如实上报 `model_not_configured`，Agent 调用会返回结构化失败。

### 常用诊断

```bash
curl http://localhost:3000/health                # 存活探针（含 Gateway 实时健康）
curl http://localhost:3000/api/runtime/status    # gateway/runtime/agents/model 全景诊断
```

### 开发调试（backend 单独运行 / 测试）

```bash
cd backend
npm install
npm test              # 254 个测试
npm run typecheck && npm run build
# 单独启动 backend（需自备 Gateway，例如 npm run dev 已在跑时）：
cp ../.env.example ../.env   # 填 OPENCLAW_GATEWAY_URL / API_KEY
npm start
```

当前提供的 API（Node 原生 HTTP，无 Web 框架；完整清单见
[PROJECT_STATUS.md](docs/PROJECT_STATUS.md)「M3 API 一览」）：

```text
GET    /health                                存活探针（含 Gateway 实时健康）
GET    /api/runtime/status                    Runtime 诊断（gateway/runtime/agents/model）

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

所有 Agent 调用通过 `AgentRuntime.runAgent()`（经由官方 `@openclaw/gateway-client` SDK
调用 OpenClaw Gateway 的 `agent` / `agent.wait` / `chat.history` RPC）执行。会话维度为
`projectId × agentId × contextScope`：同一项目同一 Agent 的不同 scope（如 Reviewer 的
`review/fact` / `review/academic` / `review/style`）持有独立会话、可并行、互不污染；
Project ≠ Session：Session 是可重建的 Runtime Context，不承担项目事实来源
（恢复依据是 Workspace 状态与 workflow checkpoint）。

其余部分的开发与部署指南待补充。

## 环境变量

参考 [.env.example](.env.example)：复制为 `.env` 后填入真实值。`.env` 已被 Git 忽略，
**不要提交任何真实 Key**。使用 `npm run dev` 时无需手动配置 Gateway 相关变量
（Bootstrap 自动注入）；模型 provider API Key 写入 PaperTeam 独立 state 的 `.env`
（见上文「配置模型」），不放仓库 `.env`。

## Runtime 说明（M3.5）

- **业务角色 → OpenClaw agent 映射**：Researcher / Writer / Reviewer / Citation
  默认全部映射 OpenClaw 默认 agent `main`，会话隔离靠 contextScope（方案 A，
  [D-0018](docs/DECISIONS.md)）；需要独立模型/权限时用
  `OPENCLAW_{WRITER|RESEARCHER|REVIEWER|CITATION}_AGENT_ID` 覆盖。
- **版本锚点**：openclaw runtime（根 package.json）、`@openclaw/gateway-client`、
  `@openclaw/gateway-protocol` 全部精确 pin **2026.9.1**（wire protocol v4 不变）；
  安装版本漂移会在启动时被拒绝；存量 runtime.json 记录的旧版本会在启动时
  自动迁移到当前 pin（端口 / token 保留）。
- **独立 state**：`~/.paperteam/runtime/openclaw/`（`PAPERTEAM_RUNTIME_ROOT` 可覆盖）；
  与全局 `~/.openclaw` 相等或嵌套的路径会被直接拒绝。
