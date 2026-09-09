# PaperTeam

**AI Multi-Agent Academic Research & Paper Workbench**

从研究 Idea 到论文交付、以及已有论文系统性改造的 AI 多 Agent 学术研究与论文生产工作台。

核心链路：

```text
Idea → Research → Feasibility → Evidence → Writing → Iterative Review / Revision Loop → Quality Gate → LaTeX / PDF
```

> 审稿-修订闭环当前为 **bounded revision baseline**（Review 聚合 → Quality Gate →
> 修订 ≤2 轮 / 超限 HITL，M3.2 已实现）；Reviewer 结构化评价驱动的增强版
> score-driven loop（Review Scorecard、Revision Plan、收敛 / 退化终止）为下一
> 阶段方向（[D-0026](docs/DECISIONS.md)）。

支持三类一级工作流：

1. **Idea-to-Paper（从研究想法开始）**：输入研究 Idea、领域、已有材料与目标论文档次，由 Researcher 先完成领域调研与 Novelty / Feasibility 分析，经用户确认后再进入 Evidence、Outline、Writing、Review、Revision，最终产出 LaTeX / PDF。
2. **Existing Paper — Quick Review（导入已有论文 → 快速 Review）**：上传论文最终 PDF 即建立项目（标题自动取自 PDF，无需手填），只读分析：引用真实性核验 → 论断-引用一致性 → 分章节审阅 → 汇总审阅报告；不修改论文正文。PDF 已是正式输入。
3. **Existing Paper — Improvement（导入已有论文 → 系统性改进）**：PDF 导入后第一阶段先完成 Review 基线，再依据审阅发现进入后续修改与优化；LaTeX 项目导入（main.tex / sections / references.bib / figures）经结构解析、Baseline 编译、论文理解、Citation Audit、Academic Review、Target Level Assessment 与用户确认后逐节系统性改造。

产品原则（详见 [docs/PRD.md](docs/PRD.md)）：

- **Target Feasibility Assessment**：系统基于 Idea、Novelty、Evidence 与实验条件诚实评估目标论文层级是否可被支撑，不承诺无法达到的目标（如"一键生成顶会论文"）。
- **少量专业 Agent + Skill**：M3 Agent Team 为 Researcher / Writer / Reviewer / Citation；流程编排由后端确定性的 TypeScript WorkflowOrchestrator 负责，不使用 LLM Agent 做流程控制。
- **Iterative Quality Loop（有界）**：Writer ↔ Reviewer 迭代审稿-修订是核心外层循环（Reviewer 结构化评价 → 确定性聚合 → Quality Gate → Revision Plan → Writer 修订 → 再审）；循环有界、可观测。评分是信号，Quality Gate 是最终确定性权威（[D-0026](docs/DECISIONS.md)；当前为 bounded baseline，增强见各文档 PLANNED 标注）。
- **Workspace / Evidence / Artifacts 是事实来源**：Runtime Session 只是可重建的执行上下文，业务恢复不依赖 Chat History。
- **Build Gate 与 Quality Gate 分离**：Draft PDF 只要求可构建；标记 Final 必须通过事实、引用与审稿质量门。

普通用户只需通过浏览器使用；Agent 调度、模型调用、LaTeX 编译、PDF 生成、版本管理、日志与系统维护全部由 Linux 服务器完成。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Frontend | React 19 + TypeScript + Vite（React Router 7 + TanStack Query 5 + Zustand 5）；手写 CSS Design Tokens，浅色 / 深色主题 |
| Backend | Node.js + TypeScript（原生 HTTP，无 Web 框架） |
| Agent Runtime | Pi SDK（`@earendil-works/pi-coding-agent`，in-process） |
| Workflow | PaperTeam WorkflowOrchestrator（确定性 TypeScript 编排引擎） |
| PDF 解析 | Python 3 + pymupdf（`backend/tools/parse_paper_pdf.py`，子进程 JSON 协议） |
| E2E | Playwright（`e2e/`，本机 Chrome；可 connectOverCDP） |

## 当前状态

| 里程碑                                            | 状态   | 内容                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 Backend Runtime Skeleton                    | ✅ 完成 | Backend 工程、`AgentRuntime` 抽象、Runtime 健康检查                                                                                                                                                      |
| M2 Agent Invocation + Project + LaTeX          | ✅ 完成 | `runAgent()` 真实调用链、`ProjectStore`、`WriterService`、`GenerationService`、`LatexCompiler`、HTTP API                                                                                                                          |
| M2.1 OpenClaw 2.0 Runtime Upgrade              | ✅ 完成 | 官方 `@openclaw/gateway-client` / `@openclaw/gateway-protocol`（wire protocol v4）、Project 与 Runtime Session 隔离（历史基线）                                                                                             |
| Architecture Research & Product Design Refresh | ✅ 完成 | 竞品调研与产品/架构方向冻结（D-0008\~D-0015）                                                                                                                                                                                          |
| **M3.0 Workflow Foundation**                   | ✅ 完成 | `WorkflowOrchestrator`（确定性引擎）、`StageContract`（DoD）、异步 `WorkflowRun` + checkpoint/resume、Domain Event + SSE、HITL awaiting\_input、协作式取消、Session contextScope                                                              |
| **M3.1 Research & Evidence**                   | ✅ 完成 | Researcher（调研 + Evidence 候选）、Target Feasibility（HIGH/MEDIUM/LOW/INSUFFICIENT + HITL adjust）、`EvidenceStore`（JSONL）、Citation 核验（静态 + CrossRef/OpenAlex/arXiv）、文献库 + PDF 文本层分析（多模态为扩展点）、分节写作、Derived Context              |
| **M3.2 Review & Revision**                     | ✅ 完成 | Reviewer（fact/academic/style 三 skill 并行）、确定性聚合、Quality Gate（9 规则）、bounded revision loop（≤2 轮 + 超限 HITL）、Build Gate、Draft/Final 双 Gate 语义、Existing-LaTeX 导入（防 Zip Slip）与改造 workflow                                      |
| **M3.5 Runtime Bootstrap / M3 Closure**        | ✅ 完成 | **M3 Complete**：PaperTeam 独立 Runtime state、`npm run dev` 一键启动、Agent 映射（方案 A，D-0018）、`GET /api/runtime/status` 诊断、优雅关闭无孤儿                                                                          |
| **M3.6 Runtime Baseline Upgrade**              | ✅ 完成 | OpenClaw baseline 2026.8.2 → **2026.9.1**（历史基线）                                                                                                                                                        |
| **M3.7 Pi Runtime Feasibility**                | ✅ 完成 | Side-by-side `PiRuntimeAdapter`（`@earendil-works/pi-coding-agent` 0.84.4）全项验证（in-process 嵌入 / 三路并发 / abort / 事件 / 隔离 / Windows 零子进程），结论 MIGRATE TO PI（历史可行性验证）                                                                              |
| **M3.8 Pi Runtime Migration & Contract v2**    | ✅ 完成 | **Pi 成为唯一正式 Runtime**（OpenClaw Gateway / Bootstrap / 三依赖全部移除）；`AgentRuntime` Contract v2（`startAgent` → 句柄：运行中事件流 / 取消 / result）；tool execution abort 传导实证；RuntimeStatus 去 Gateway 化；`npm run dev` 直启 Backend                                                  |
| **M4.0-M4.2 React Web Workbench**              | ✅ 完成 | Frontend API Contract（`docs/API_CONTRACT.md` + `GET /api/projects`）；React 19 + TS + Vite + React Router + TanStack Query + Zustand 前端骨架；Project List / Create Project（双模式）/ Project Workspace；`npm run dev` 一键双进程（Backend :3000 + Vite :5173 proxy 同源）                                                          |
| **M4.2.5 Live Model Integration Gate**         | ✅ PASS | 真实 Provider `zai-coding-cn/glm-5.3` 经运行中 Backend 公开 API 完成 L3 全链路验证（单 Agent smoke / live SSE / Workflow 至首个 HITL / 真实 cancel）；凭据仅存 Backend 进程内存，零泄漏 |

**M4.0-M4.2.5 Complete**：Runtime baseline 保持 **Pi SDK in-process**
（`@earendil-works/pi-coding-agent` 0.84.4）。React Web Workbench（React 19.2 /
Vite 7 / react-router-dom 7.18 / @tanstack/react-query 5.102 / zustand 5.0，
npm，`frontend/` 独立包）已落地：项目列表、创建项目（Idea-to-Paper +
Existing-Paper 改进）、项目工作区基础壳；前端只消费
[API\_CONTRACT.md](docs/API_CONTRACT.md) 冻结的 DTO，Runtime Status 适配 Pi
schema。`npm run dev` 同时启动 Backend（:3000）与 Vite
Dev Server（:5173，`/api`、`/health` 同源 proxy），任一退出联动全退。
Backend 234 + Frontend 24 个测试全部通过。M4.2.5 Live Model Integration
Gate ✅ PASS（2026-09-05）：真实 Provider `zai-coding-cn/glm-5.3` 经运行中
Backend 完成 L3 全链路验证（详见 [PROJECT_STATUS.md](docs/PROJECT_STATUS.md)）。

**M4.3 已落地（前端能力现状）**：项目工作区含 概览 / PDF 与结构（上传最终
PDF、解析状态、结构树）/ 引用核验（提取、真实性 + 语义两层核验、逐条状态）；
全局 Skills 页（中文简介为主，来源 / 修订版本 / 许可证折叠）；模型设置页
（Provider + 模型搜索选择、API Key、测试连接）；Tab 状态进 URL，中文界面。

**Project Entry & Lifecycle UX（2026-09）已落地**：新建项目二选一入口
（从研究想法开始 / 导入已有论文）；已有论文 **File First** 导入
（`POST /api/projects/import-pdf`：PDF + 目标一次调用建项目，标题自动取自
PDF、失败回滚不留半成品）；`existing_paper_review` 快速 Review 工作流
（PaperMap → Citation Integrity → 分章节 Review → 聚合报告，M4.3 Foundation
复用，不重写论文）；项目生命周期 归档 / 恢复 / 永久删除（`archivedAt` 独立于
执行状态；运行中 409 保护；删除仅限已归档项目并输入标题确认，含 Runtime
会话清理）；Settings 二级导航（模型设置 / 项目管理）；PaperTeam 品牌即
返回论文项目的主页入口。

**Project Hardening & Product Polish（2026-09-07）已落地**：全项目审计与加固
（编排器事件链 / 取消 / 超时、原子写、HTTP 校验与状态码、错误模型不透传内部信息）；
**PDF 导入根因修复**（MuPDF C 层告警污染 stdout 协议；Python / pymupdf 自动探测 +
`npm run doctor`）；章节文本按标题行精确归属（同页多章节不再丢失）；参考文献著录
解析（IEEE / GB/T 7714 / APA）；前端整体重设计 + **深色模式**（跟随系统 / 浅色 /
深色，设置 → 外观）；App 错误边界；Playwright 浏览器级 E2E（`e2e/`）。真实用户论文
（26 页中文论文）已完成导入 → 引用核验 → 分章节 Review 全链路。

**M4.4 Workflow Live View（2026-09-09）已落地**：项目工作区「工作流」标签——
Stage Timeline（六态 + 集中中文标签映射）、分章节进度（17/33 + 运行中 / 等待 /
重试 / 失败）、SSE 实时更新（`useWorkflowEvents`：replay + seq 去重 + 重连恢复 +
刷新恢复）、取消任务（行内确认 + 「正在取消…」过渡态 + 后端幂等）、失败 /
等待确认 / 完成态的可读呈现与真实结果入口；概览「当前任务」摘要卡与 Review
页运行中入口联动。

**M4.5 HITL UI（2026-09-09）已落地**：Workflow 停在 `awaiting_input` 时，
工作流页显示统一决策面板（`HitlPanel`）——为什么暂停（prompt + 业务上下文：
可行性结论 / 大纲 / 改进计划 / 修订耗尽摘要）+ 严格按后端契约的动作：
继续（approve）/ 调整目标（adjust：targetProfile / targetVenue）/ 提出修改意见
（revise：feedback，重做当前产物）/ 接受为草稿 / 再修一轮 / 取消；重复提交与
过期请求（409）如实处理；待办随 checkpoint 持久化，浏览器刷新与 Backend 重启
后均恢复；概览「前往处理」、侧栏「有 1 个任务等待确认」、Review 页提醒联动。
E2E（`e2e/hitl.spec.ts`）经 `PAPERTEAM_TEST_RUNTIME=scripted` 脚本化模型栈
驱动完整真实链路（编排器 / checkpoint / SSE / HTTP / React 全真）。

**未实现（M4.6+）**：Evidence Workbench、Quality Gate UI、Draft / Final /
版本管理、Visual Reviewer、LaTeX repair loop、系统管理后台、Docker 部署。

## 文档

| 文档                                                | 说明                                                |
| ------------------------------------------------- | --- |
| [docs/PRD.md](docs/PRD.md)                        | 产品需求文档                                            |
| [docs/PROJECT\_STATUS.md](docs/PROJECT_STATUS.md) | 项目当前状态与路线（M1 ~ M4）                        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)      | 系统架构说明（§8：前端架构与状态管理边界）                         |
| [docs/API\_CONTRACT.md](docs/API_CONTRACT.md)     | Frontend API Contract（端点 / DTO / SSE，M4.0 冻结）         |
| [docs/DECISIONS.md](docs/DECISIONS.md)            | 技术决策记录（ADR）                                       |

## 目录结构

```text
PaperTeam/
├── package.json         # 根开发入口（dev / doctor / build / typecheck / test / test:e2e）
├── scripts/dev.mjs      # dev 启动器（Node/依赖检查 → 构建 → 同时启动 Backend + Vite）
├── scripts/doctor.mjs   # 环境自检（Node / 依赖 / Python + pymupdf）
├── frontend/            # React Web Workbench（React 19 + Vite）
├── backend/             # PaperTeam Backend（API / Workflow / Pi Runtime / LaTeX）
│   └── tools/parse_paper_pdf.py   # PDF 解析工具（pymupdf 子进程，stdout JSON 协议）
├── e2e/                 # Playwright 浏览器级 E2E（仅测试工具，不进产品代码）
├── agents/              # Agent 定义与配置（预留，当前角色配置在 backend/src/runtime/pi/）
├── docker/              # Docker 部署配置（预留）
└── docs/                # 项目文档（含 API_CONTRACT.md）
```

## 快速开始（Quick Start）

```bash
git clone https://github.com/JiahongXu88/PaperTeam.git
cd PaperTeam
npm run install:all   # 安装依赖（backend：Pi SDK 0.84.4 精确 pin；frontend：React 19 + Vite；e2e：Playwright）
npm run doctor        # 环境自检：Node / 依赖 / PDF 解析工具链（Python 3 + pymupdf）
npm run dev           # 一键启动：Backend + React Workbench
```

**PDF 解析依赖**：导入已有论文需要本机 Python 3.10+ 与 `pymupdf`
（`python -m pip install pymupdf`）。Backend 启动时按 `python` / `python3` / `py -3`
自动探测（也可用 `PAPERTEAM_PDF_PYTHON` 指定解释器路径）；缺失时启动日志、
`GET /api/runtime/status`（`tools.pdfParser`）与前端顶部横幅都会明确提示，
导入请求返回 `503 PDF_PARSER_UNAVAILABLE` 并附安装命令，而不是一个 `spawn ENOENT`。

`npm run dev` 会自动完成：

1. Node 版本检查（复用根 package.json 的 `engines.node`：`>=22.22.3 <23` / `>=24.15.0 <25` / `>=25.9.0`，Node 26+ 可用）
2. backend / frontend 依赖安装与 backend 构建（缺失时自动 `npm install` + `tsc`）
3. 同时启动两个进程（日志带 `[backend]` / `[vite]` 前缀）：
   - **PaperTeam Backend**：`http://localhost:3000`（Pi SDK in-process）
   - **React Workbench（Vite Dev Server）**：`http://localhost:5173`（`/api`、`/health` 同源 proxy 到 Backend，无 CORS）
4. 浏览器打开 **http://localhost:5173** —— 项目列表 / 新建项目 / 项目工作台
5. `Ctrl+C` 同时退出两个进程（任一子进程退出也会联动全退；端口 3000/5173 释放）

### 配置模型（可选但 Agent 调用必需）

Runtime 不搬运任何其他项目的凭据。两种配置方式（推荐本地用户用方式 1）：

**方式 1：Settings UI（推荐本地用户）** —— `npm run dev` 后打开
http://localhost:5173/settings/model ：选择 Provider / Model、粘贴 API Key、
Save 即生效（新的 Agent Run 立即使用新配置，无需重启）；Test Connection
可先验证凭据；配置持久化在 PaperTeam 用户数据目录（默认 `~/.paperteam`，
不进仓库），重启后自动恢复。Key 只经同源 Backend 保存，任何页面/接口
都不回显 Key 本体。

**方式 2：环境变量（CI / dev override）** —— 优先级**高于** Settings UI
保存的本地配置：

```bash
# .env（见 .env.example；.env 已被 .gitignore 忽略，严禁提交真实 Key）
echo PAPERTEAM_PI_MODEL=anthropic/claude-opus-4-5 >> .env
echo PAPERTEAM_PI_API_KEY=sk-ant-... >> .env

# 也可用 Pi 官方凭据文件（PaperTeam 专属目录，与 ~/.pi 隔离）
#   Windows:   %USERPROFILE%\.paperteam\runtime\pi\agent\auth.json
#   Linux/macOS: ~/.paperteam/runtime/pi/agent/auth.json
# 或标准环境变量（ANTHROPIC_API_KEY / ZAI_CODING_CN_API_KEY / ...）
```

环境变量覆盖时 Settings 页面会明确提示「当前模型配置由环境变量提供」，
仍可保存本地配置（在环境变量不存在时生效）。

**Anthropic / OpenAI 兼容网关、私有部署（自定义提供商）**：在「设置 → 模型设置 →
自定义提供商」里填写 id、Base URL、接口协议（Anthropic Messages / OpenAI Chat
Completions / OpenAI Responses）、是否用 `Authorization: Bearer`、额外请求头与模型列表
（Model ID / 上下文窗口 / 最大输出 / 是否支持推理与图片）。配置本体存
`~/.paperteam/settings/custom-providers.json`（非敏感），API Key 与内置提供商一样只进
`runtime/pi/agent/auth.json`；重启后自动重新注入 Pi Runtime。仍可按 Pi 官方格式手工编辑
`runtime/pi/agent/models.json`（`apiKey` 可写成 `"$SOME_ENV_VAR"`），两者并存。
「模型提供商」选择器支持输入首字母筛选，小众提供商折叠在「其他」里。配置后用诊断确认：

```bash
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

### 开发调试（单独运行 / 测试）

```bash
# 根目录一键（前后端一起）：
npm run build          # backend tsc + frontend tsc --noEmit + vite build
npm run typecheck      # backend + frontend
npm test               # backend 382 + frontend 77 个 vitest 用例（不需要模型 / 外网）

# 浏览器级 E2E（需要 npm run dev 已在运行；用本机 Chrome，不下载浏览器）：
npm run test:e2e:smoke          # 用户完整路径：创建 → 导入 PDF → Review → 引用 → Skills → 设置 → 主题 → 归档 / 恢复 / 删除确认
npm run test:e2e:visual         # 主要页面 × 4 视口 × 浅色/深色 截图 + 无溢出断言（输出 e2e/shots/）
#   PAPERTEAM_E2E_PDF=D:\path\paper.pdf   用真实论文跑导入路径（默认用仓库内 arXiv fixture）
#   PAPERTEAM_E2E_CDP_URL=http://127.0.0.1:9222   复用已开 remote-debugging 的浏览器（connectOverCDP）

# backend 单独：
cd backend && npm start          # Pi SDK in-process

# frontend 单独（需要 backend 在 :3000 运行，或用 proxy 目标）：
cd frontend && npm run dev       # Vite Dev Server :5173
```

当前提供的 API（Node 原生 HTTP，无 Web 框架；完整清单见
[API\_CONTRACT.md](docs/API_CONTRACT.md)）：

```text
GET    /health                                存活探针（含 Pi Runtime 实时健康）
GET    /api/runtime/status                    Runtime 诊断（runtime/agents/model/sessions）

── 主入口：Workflow API ──
GET    /api/projects                          项目列表（M4.0，updatedAt 降序）
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
见上文「配置模型」。端口：`PAPERTEAM_PORT`（默认 3000）同时作用于 Backend 监听与
Vite proxy 目标；前端 API Base 可用 `VITE_API_BASE_URL` 改写（缺省同源相对路径）。

## Runtime 说明

- **Pi in-process**：`@earendil-works/pi-coding-agent` **0.84.4** 精确 pin（backend
  `package.json`）；`npm run dev` 直启 Backend。
- **业务角色映射**：Researcher / Writer / Reviewer / Citation 无 agent 注册表概念，
  角色（systemPrompt + 工具白名单）由 `PiRuntimeAdapter` 按 contextScope 前缀解析
  （research\* → researcher、writing\* → writer、review\* → reviewer；方案 A，
  [D-0018](docs/DECISIONS.md)）；会话标识可用
  `PAPERTEAM_{WRITER|RESEARCHER|REVIEWER|CITATION}_AGENT_ID` 覆盖（默认 main，
  仅作 sessionKey 组成段与诊断标签）。
- **独立配置目录**：`~/.paperteam/runtime/pi/agent/`（`PAPERTEAM_RUNTIME_ROOT` 可覆盖；
  auth.json / models.json 放这里），与用户全局 `~/.pi` 隔离。
- **历史**：OpenClaw 2026.9.1 为 M3.5/M3.6 的历史 Runtime baseline；M3.7 完成 Pi
  可行性验证；M3.8 正式迁移到 Pi 并移除 OpenClaw 全部运行时依赖（git 历史即回退机制）。
