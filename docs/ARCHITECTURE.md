# PaperTeam 系统架构

> 依据 [PRD.md](PRD.md)（§3 / §8 / §12 / §20 / §21）整理。项目处于初始化阶段，本文随实现推进持续更新。

## 1. 总体架构

```text
用户浏览器
   │
   ▼
PaperTeam Web（frontend/）
   │
   ▼
PaperTeam Backend（backend/）
   │
   ├── Project      论文项目与文件
   ├── Workflow     写作/审稿/修改闭环调度
   ├── Runtime      AgentRuntimeAdapter（唯一 Agent 入口）
   ├── LaTeX        XeLaTeX / latexmk 编译
   ├── PDF          编译输出与页面渲染
   ├── File         文件与上传管理
   ├── Version      Git 版本管理（前端只见业务版本号）
   └── Admin        系统管理后台
   │
   ▼
OpenClaw Gateway（Agent Runtime）
   │
   ├── Paper Manager        任务调度与汇总
   ├── Researcher           文献检索与 Evidence 生成
   ├── Writer               LaTeX 写作
   ├── Fact Checker         事实核验
   ├── Academic Reviewer    学术审稿
   ├── Style Reviewer       文风审查（AI 文风风险）
   ├── Final Editor         汇总意见并修改
   ├── LaTeX Engineer       编译问题修复
   └── Visual Reviewer      PDF 视觉审稿（视觉模型）
   │
   ▼
Linux Server
   ├── Paper Workspace（projects/）
   ├── LaTeX Environment（TeX Live / XeLaTeX / latexmk / Biber）
   ├── Git Repository（论文版本）
   ├── PDF Renderer（Poppler 等）
   ├── Model Providers
   └── Logs
```

## 2. 关键设计

### 2.1 AgentRuntimeAdapter（Runtime 隔离层）

业务层不直接依赖 OpenClaw，只依赖统一接口：

```ts
interface AgentRuntime {
  runAgent(input: RunAgentInput): Promise<AgentTask>;
  getTask(taskId: string): Promise<AgentTask>;
  cancelTask(taskId: string): Promise<void>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  streamEvents(taskId: string, onEvent: (event: AgentEvent) => void): Promise<void>;
  healthCheck(): Promise<RuntimeHealth>;
  close?(): Promise<void>;   // M2.1：进程 shutdown 时释放连接
}
```

- 第一版由 **OpenClawRuntimeAdapter** 实现，对接 OpenClaw Gateway 的 Agent / Session / Task / Event Stream。
- 任务状态统一为：`queued / running / completed / failed / cancelled`。
- 未来替换或新增 Runtime（新 Agent 框架、本地模型等）不影响业务层。

**M2.1 起的调用链（官方 Gateway SDK）**：

```text
HTTP API
  │
GenerationService
  │
WriterService
  │
AgentRuntime（接口）
  │
OpenClawRuntimeAdapter
  │
OpenClaw Gateway Client SDK（@openclaw/gateway-client 2026.8.1，wire protocol v4）
  │   由 SDK 负责：ws transport、connect.challenge 挑战、connect 握手、鉴权、
  │   protocol v4 协商、request id 关联与超时、结构化错误、重连退避
  │   PaperTeam 保留（src/runtime/openclaw/gatewayClient.ts 薄 wrapper）：
  │   配置装配（url / clientDisplayName / scopes / 超时）、就绪等待预算、幂等 stop
  │
OpenClaw Gateway
  │
Agent Runtime
```

**runAgent 的真实映射（M2.1，按官方 external-apps 指南）**：

```text
AgentRuntime.runAgent(input)
  → SDK connect（operator 角色 + operator.read/write scope + token；
    收到 connect.challenge 挑战后握手，hello-ok 即就绪；单次运行语义：
    首个连接失败立即放弃，不搭乘 SDK 重试循环）
  → RPC "agent"        {message, agentId?, sessionKey?, idempotencyKey}
                        → 验收 {runId, sessionKey, agentId, status:"accepted", acceptedAt}
  → RPC "agent.wait"   {runId, timeoutMs}（分片轮询）
                        → 终态 status:"ok"|"error"，或带 endedAt 的 timeout 终态快照；
                          "pending" / 无 endedAt 的 timeout = 等待窗口耗尽，继续轮询
  → RPC "chat.history" {sessionKey, limit, maxChars}   → 最后一条 assistant 消息全文
                                                       （terminalReply 4096 截断仅兜底）
  → 映射为 AgentTask{taskId=runId, status, output, metadata:{sessionKey}}
```

协议依据：OpenClaw **2026.8.1** 源码（`packages/gateway-client/*`、
`src/gateway/server-methods/agent*.ts`、`src/gateway/agent-turn/*`）与官方
`docs/gateway/protocol.md`、`docs/gateway/external-apps.md`（"For agent runs,
start with the `agent` RPC and pair it with `agent.wait`"）。protocol version
使用官方常量 `PROTOCOL_VERSION`（`@openclaw/gateway-protocol/version`，当前 = 4），
不在 PaperTeam 硬编码。
OpenClaw 特有标识（sessionKey 等）只存在于 Adapter 内部与 AgentTask.metadata 诊断字段。

### 2.1.2 Project ≠ OpenClaw Session（M2.1 最小映射）

```text
PaperTeam Project（业务对象，ProjectStore 自持）
  │  project.json: { id, title, status, …, runtimeSessionKey? }   ← Runtime-neutral 引用
  ▼
OpenClaw Session（Agent Runtime 上下文）
     sessionKey = agent:{agentId}:paperteam-{projectId}
```

- **两个概念不合并**：Project 是论文业务对象；OpenClaw Session 是 Agent 的对话/工作上下文。ProjectStore 只保存一个不透明引用 `runtimeSessionKey`，不理解其格式。
- **派生规则**：首次生成未存引用时，由 Adapter 按 `projectId` 派生稳定 key（同一 Project 复用、不同 Project 隔离，避免跨论文上下文污染）；网关按 key 自动创建会话。成功后 `GenerationService` 把实际使用的 key 写回 project.json，下次原样透传（`RunAgentInput.sessionKey`）。
- 无 `projectId` 的调用不指定 sessionKey，由网关解析默认会话。

### 2.1.3 M2 Backend 模块划分（M2.1 后）

```text
backend/src/
├── config/        配置加载与校验（gateway / projects / latex / writerAgentId）
├── errors.ts      业务错误模型（稳定错误码 → HTTP 状态码映射）
├── runtime/       AgentRuntime 契约 + OpenClawRuntimeAdapter
│   └── openclaw/  gatewayClient（官方 GatewayClient 的薄 wrapper：配置/就绪/生命周期）
├── project/       ProjectStore（项目目录 / project.json / runtimeSessionKey / 路径安全）
├── writer/        WriterService（Writer Prompt 组装 + LaTeX 输出校验 + sessionKey 透传）
├── generation/    GenerationService（Writer → main.tex → LatexCompiler 编排 + 会话写回）
├── latex/         LatexCompiler（latexmk -xelatex / xelatex 探测与编译）
└── httpServer.ts  Node 原生 HTTP：/health、/api/projects、/api/projects/:id/generate
```

### 2.2 核心论文工作流

**写作流程**（串行链）：

```text
用户任务 → Paper Manager → Researcher（更新 Evidence）→ Writer（LaTeX 草稿）
→ Fact Checker → Academic Reviewer → Style Reviewer → Final Editor → 重新验证
```

**全面审稿**（并行）：

```text
当前版本 → [Fact Checker ∥ Academic Reviewer ∥ Style Reviewer] → Review Aggregator → 综合审稿报告
```

**视觉检查闭环**：

```text
LaTeX 编译 → PDF 页面渲染（150~200 DPI，分批）→ Visual Reviewer（页码级问题）
→ LaTeX Engineer 修复 → 重新编译
```

**修改闭环默认通过条件**：critical 事实错误 = 0、unsupported 重要声明 = 0、Academic Score ≥ 80、Style Risk ≤ 35。

### 2.3 数据与文件

- **结构化状态**入数据库：Project / Document / Chapter / Evidence / Source / Review / Issue / AgentTask / PaperVersion / SystemLog。第一版 SQLite，后续可切 PostgreSQL。
- **论文文件**存放于服务器项目 Workspace（`projects/<id>/`：main.tex、chapters/、figures/、tables/、sources/、evidence/、reviews/、data/、build/、project.json）。
- **Evidence Store**：统一证据库（claim + source + location + confidence），供 Writer / Fact Checker / Academic Reviewer 共享。
- **版本管理**：服务器端 Git；前端只展示 V12/V13… 业务版本及评分。

### 2.4 前端双模式

- **论文工作台**（普通用户）：首页看板、我的论文、论文写作、论文审稿、文献与证据、PDF 查看、历史版本、项目设置。隐藏 session/agentId/Gateway 等技术细节，只展示业务阶段。
- **系统管理**（管理员）：系统状态、OpenClaw、Agent 管理、模型管理、Workflow 配置、日志、文件管理、系统诊断、Command Center、Web Terminal。

### 2.5 实时通信

WebSocket / SSE 推送：Agent Task 状态、Workflow 进度、LaTeX 编译状态、日志、审稿结果、Web Terminal（xterm.js + node-pty）。

## 3. 部署形态

长期运行于 Linux 服务器（推荐 Ubuntu）：

- 服务：PaperTeam Backend、OpenClaw Gateway、Web Frontend、Database
- 依赖：Node.js、Git、Python、TeX Live（XeLaTeX/latexmk/Biber）、Poppler
- **后续使用 Docker 容器化部署**（配置位于 `docker/`）
- 用户只访问一个 HTTPS 域名；OpenClaw Gateway 作为内部服务，不对外暴露

## 4. 仓库目录结构

```text
PaperTeam/
├── frontend/   # Web 前端（论文工作台 + 系统管理后台）
├── backend/    # PaperTeam Backend
├── agents/     # Agent 定义与配置（AGENTS.md 等）
├── docker/     # Docker 部署配置
└── docs/       # PRD、状态、架构、决策记录
```
