# PaperTeam

面向学术论文**写作、审稿、事实核验、文风优化、LaTeX 编译与论文质量评估**的 AI 多 Agent 工作台。

普通用户只需通过浏览器使用；论文写作、Agent 调度、模型调用、LaTeX 编译、PDF 生成、版本管理、日志与系统维护全部由 Linux 服务器完成。

## 文档

| 文档 | 说明 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | 项目当前状态与已确定决策 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构说明 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 技术决策记录（ADR） |

## 目录结构

```text
PaperTeam/
├── frontend/   # Web 前端（论文工作台 + 系统管理后台）
├── backend/    # PaperTeam Backend（API / Workflow / Runtime / LaTeX / 版本管理）
├── agents/     # Agent 定义与配置（AGENTS.md 等）
├── docker/     # Docker 部署配置
└── docs/       # 项目文档
```

## 快速开始

### Backend（M2.1：OpenClaw 2.0 Runtime Upgrade）

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

M2 起提供的 API（Node 原生 HTTP，无 Web 框架）：

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

M2.1 起 Runtime 底座使用 OpenClaw **2026.8.1** 官方 Gateway SDK（wire protocol
v4）：连接挑战、握手、鉴权、请求关联、结构化错误、重连策略全部由 SDK 负责，
PaperTeam 只保留配置装配、生命周期与业务错误映射。每个论文项目（Project）
通过派生的 `sessionKey`（`agent:{agentId}:paperteam-{projectId}`）绑定独立的
OpenClaw 会话，并在 `project.json` 中持久化引用（`runtimeSessionKey`），
保证同一项目上下文连续、不同项目互不污染。

其余部分的开发与部署指南待补充。

## 环境变量

参考 [.env.example](.env.example)：复制为 `.env` 后填入真实值。`.env` 已被 Git 忽略，**不要提交任何真实 Key**。
