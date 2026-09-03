# PaperTeam 系统架构

> 依据 [PRD.md](PRD.md) 与 [DECISIONS.md](DECISIONS.md)（D-0001~D-0015）整理。
> M1 / M2 / M2.1 已实现部分如实标注；Workflow / 多 Agent / Evidence 层为 **M3 设计**
> （2026-09-03 设计冻结），尚未实现。实现进度以 [PROJECT_STATUS.md](PROJECT_STATUS.md) 为准。

## 1. 总体架构

### 1.1 目标架构（M3）

```text
                        PaperTeam

                   HTTP API / SSE
                         │
                  WorkflowOrchestrator          ← 确定性 TypeScript 代码，不是 Agent
                         │
          ┌──────────────┼──────────────┐
          │              │              │
     Researcher        Writer        Reviewer        ← 4 个专业 Agent（Skill 细化角色）
          │              │           （fact / academic / style skill，可并行）
          └──────────────┼──────────────┘
                         │
                    Citation
                         │
         Project / Evidence / Artifacts           ← Authoritative State（事实来源）
                         │
                   AgentRuntime                   ← 统一 Runtime 接口
                         │
              OpenClawRuntimeAdapter              ← Runtime 隔离层
                         │
                  OpenClaw Gateway                ← Agent Runtime
```

完整的分层视图：

```text
用户浏览器
   │
   ▼
PaperTeam Web（frontend/，M4+）
   │
   ▼
PaperTeam Backend（backend/）
   │
   ├── ProjectStore        论文项目与文件（project.json / runtimeSessionKey）
   ├── WorkflowOrchestrator 确定性流程编排（M3.0）
   │     ├── NewPaperWorkflow        （Idea-to-Paper）
   │     └── ExistingPaperWorkflow   （Existing-LaTeX Improvement）
   │           └── 共享后段：Evidence → Review → Revision → Build → Quality Gate
   ├── EvidenceStore       证据存取与核验状态（M3.1）
   ├── Runtime             AgentRuntimeAdapter（唯一 Agent 入口）
   ├── LaTeX               XeLaTeX / latexmk 编译 + Build Gate 判定
   ├── PDF                 编译输出与页面渲染
   ├── File / Version      文件上传与 Git 版本管理
   └── Admin               系统管理后台
   │
   ▼
OpenClaw Gateway（Agent Runtime）
   │
   ├── Researcher    领域调研、文献检索、Evidence 生成、可行性分析支持
   ├── Writer        分节写作与 revision
   ├── Reviewer      审稿（fact checking / academic review / style review skill）
   └── Citation      引用核验与 references.bib 治理
   │
   ▼
Linux Server
   ├── Paper Workspace（projects/，Authoritative State 落盘）
   ├── LaTeX Environment（TeX Live / XeLaTeX / latexmk / Biber）
   ├── Git Repository（论文版本）
   ├── PDF Renderer（Poppler 等）
   ├── Model Providers
   └── Logs
```

### 1.2 当前实现（M2.1 后）

当前 Backend 已实现的只有图中最小闭环：HTTP API → GenerationService → WriterService →
AgentRuntime → OpenClawRuntimeAdapter → OpenClaw Gateway（Writer 单 Agent）→
manuscript/main.tex → LatexCompiler → build/paper.pdf。WorkflowOrchestrator、
多 Agent、EvidenceStore、异步 WorkflowRun 均未实现（见 §9 模块划分与
PROJECT_STATUS.md）。

## 2. 核心概念区分（架构红线）

以下四组概念在架构上严格区分，不得混用：

### 2.1 Authoritative State ≠ Derived Context ≠ Runtime Context

| 层 | 内容 | 性质 |
|---|---|---|
| **Authoritative State**（事实来源） | `manuscript/`、`sources/`、`evidence/`、`reviews/`、workflow state（`workflow/`）、build artifacts | 项目唯一真相；所有 Stage 产出必须落盘于此 |
| **Derived Context**（蒸馏产物） | `context.yaml`、outline summary、section status、terminology summary、Reference Style Profile | 可由事实来源随时重新生成；只是 Agent 输入的优化，**不是第二份事实数据库** |
| **Runtime Context**（运行时上下文） | OpenClaw Session（Chat History） | disposable，可重建，**不承担项目真相** |

规则（D-0013）：业务流程不能依赖 Chat History 才能恢复；恢复依据是 Workspace 状态与
workflow checkpoint。

### 2.2 Project ≠ Session

```text
PaperTeam Project（业务对象，ProjectStore 自持）
  │  project.json: { id, title, status, …, runtimeSessionKey? }   ← Runtime-neutral 引用
  ▼
OpenClaw Session（Agent Runtime 上下文）
     sessionKey = agent:{agentId}:paperteam-{projectId}          ← M2.1 已实现
     M3 扩展：projectId × agentId × contextScope                  ← 见 §6.3
```

Project 是论文业务对象；Session 是 Agent 对话 / 工作上下文，可丢弃重建。

### 2.3 Domain Event ≠ Runtime Event

```text
OpenClaw Runtime Event（SDK 事件：session / agent 运行信号）
   ↓
RuntimeAdapter（转换 / 归一化）
   ↓
WorkflowOrchestrator（消费运行信号，驱动 Stage 状态机）
   ↓
PaperTeam Domain Event（业务事件）
   ↓
SSE（前端进度）
```

Domain Event 示例：`workflow.started`、`stage.started`、`stage.completed`、
`stage.failed`、`workflow.awaiting_input`、`workflow.resumed`、
`quality_gate.failed`、`workflow.completed`。OpenClaw 的事件名、sessionKey 等细节
不允许透传到前端事件协议。

### 2.4 Build Gate ≠ Quality Gate

| | Build Gate | Quality Gate |
|---|---|---|
| 判定 | 文档能否构建（LaTeX 语法 / references.bib / 图片 / packages / 编译结果） | 论文质量能否进入 Final（hallucinated / not_found citation、unsupported critical claim、unresolved review issue、target requirement 未达到、Evidence 不足） |
| 实现 | LatexCompiler + 日志解析（确定性） | 确定性判定器，消费 Reviewer / Citation 结构化结果与 Evidence 状态 |
| 失败后果 | 无 PDF | **仍可产出 Draft PDF**；版本不得标记 Final |

规则（D-0015）：`not_found citation → 禁止编译` 是被禁止的设计。

## 3. Workflow 层（M3.0 设计）

### 3.1 WorkflowOrchestrator

- **确定性 TypeScript 代码，不是 Agent，不调用 LLM**（D-0008）。
- 负责：状态、Stage 推进、retry、timeout、checkpoint、resume、branch、loop、hard gate。
- 不负责：内容理解、语义判断、论文分析、审稿（这些是 Agent / Skill 的事）。

### 3.2 两类 Workflow，共享后段

```text
NewPaperWorkflow（Idea-to-Paper）      ExistingPaperWorkflow（LaTeX Improvement）
  Idea                                    Existing LaTeX 导入
  Researcher 调研                          项目结构解析
  领域现状 / Related Work                  Baseline Compile
  Research Gap / Novelty                  论文理解
  Target Feasibility ──► HITL             Citation / Evidence Audit
  用户确认                                Academic Review
  Evidence / Outline                      Target Level Assessment
  │                                       Improvement Plan ──► HITL
  │                                       用户确认
  └───────────────┬───────────────────────┘
                  ▼
      共享后段：Evidence → Writing（逐节）→ Review →
      Quality Gate →（通过）Final /（失败）Revise → Re-verify（bounded loop）
```

### 3.3 Workflow 结构原则（D-0014）

线性主干 + 有限条件分支 + bounded loop + 少量 fan-out / join；**不引入 DAG / Graph
Engine**。

```text
Research → Evidence → Outline → Human Checkpoint → Draft → Compile → Review
  → Quality Gate → 通过 → Final
                  → 失败 → Revise → Re-verify →（loop ≤ N）→ Human Checkpoint
```

fan-out / join 的使用点：三类 review skill 并行、多节 Revision 并行、多文献解析并行；
并发上限可配置。

### 3.4 StageContract（M3.0 核心抽象）

每个 Stage 声明契约：

| 字段 | 含义 |
|---|---|
| stage id | 全局唯一标识 |
| required inputs | 进入该 Stage 必需的输入（如 outline、evidence） |
| produced outputs | 产出物（如 `sections/introduction.tex`） |
| definition of done | 完成判据（确定性可检，如文件存在 / 非空 / LaTeX 合法） |
| retry policy | 重试策略（哪些 failure type 可重试） |
| failure type | 失败分类（transient / permanent / runtime-unavailable …） |
| max attempts | 最大尝试次数 |

示例（WriterStage）：requires = outline + evidence；produces =
`sections/<name>.tex`；DoD = 文件存在、非空、LaTeX 语法合法（可编译到 preamble 级）。

StageContract 是 WorkflowOrchestrator 推进、重试与 resume 判定的唯一依据；LLM 产出
必须落到 produced outputs 并通过 DoD 校验才算 Stage 完成。

### 3.5 WorkflowRun（异步运行）

当前 `POST /api/projects/:id/generate` 是同步 API（M2 形态）。M3.0 起改为：

```text
POST /api/projects/:id/workflows   → { runId }
GET  /api/runs/:runId              → { status, currentStage, … }
GET  /api/runs/:runId/events（SSE） → Domain Event 流
POST /api/runs/:runId/resume       → HITL 输入提交
POST /api/runs/:runId/cancel
```

状态机：

```text
pending → running → awaiting_input → running → … → completed
                │                                    │
                ├──────────────► failed ◄────────────┤
                └──────────────► cancelled ◄─────────┘
```

### 3.6 Checkpoint / Resume / HITL

- WorkflowRun 状态与 checkpoint 持久化于项目 `workflow/` 目录（Authoritative State）
- 服务重启后可从最近 checkpoint 恢复；恢复依据是 Workspace 状态，不是 Chat History
- HITL：Feasibility 确认、Improvement Plan 确认、Outline 确认（可选）、bounded loop
  超限介入；对应 `workflow.awaiting_input` / `workflow.resumed` 事件

## 4. Agent 层（M3 设计）

### 4.1 Agent Team

| Agent | 职责 | Skill 细化 |
|---|---|---|
| Researcher | Idea Research、文献检索、Evidence 生成、Feasibility 支持 | — |
| Writer | Section-based 写作、revision | — |
| Reviewer | 审稿 | fact checking / academic review / style review（可并行） |
| Citation | 引用核验、bib 治理 | — |

### 4.2 拆分准则（D-0009）

角色细化优先用 Skill。仅当需要不同模型 / 独立长期上下文 / 不同权限 / 真正独立并行
资源时才拆独立 Agent。LaTeX 修复是确定性工具（M4+）；Visual Reviewer、Experiment
subsystem 均在 M4+ / backlog。

### 4.3 Agent 与确定性组件的边界

- WorkflowOrchestrator、LatexCompiler、Quality Gate 判定器、EvidenceStore、
  ProjectStore、版本管理：**确定性代码**，绝不封装为 LLM Agent。
- Agent 只通过 AgentRuntime 被调用；其输出必须落盘并通过 DoD / 结构化校验后才进入
  下一 Stage（Agent 输出不直接成为状态机输入）。

## 5. 数据与文件

- **Workspace（Authoritative State）**：`projects/<id>/` 下 `manuscript/`（main.tex、
  sections/）、`sources/`（papers / parsed / metadata）、`evidence/`、`reviews/`、
  `workflow/`、`figures/`、`tables/`、`data/`、`build/`、`project.json`。
- **Evidence Store**（M3.1）：字段与状态模型见 PRD §6.9（verificationStatus /
  supportStrength / verificationLevel；数值 confidence 仅辅助）。
- **结构化状态**入数据库（WorkflowRun、ReviewReport、Issue、SystemLog 等）：第一版
  SQLite，后续可切 PostgreSQL；文件内容仍在 Workspace。
- **版本管理**：服务器端 Git；前端只展示业务版本号（V12/V13…，Draft / Final 标记）；
  Existing-Paper 导入产生 baseline 快照版本。

## 6. Runtime 层

### 6.1 AgentRuntimeAdapter（Runtime 隔离层，已实现）

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

- 第一版由 **OpenClawRuntimeAdapter** 实现，对接 OpenClaw Gateway 的 Agent / Session /
  Task / Event Stream。
- 任务状态统一为：`queued / running / completed / failed / cancelled`。
- 未来替换或新增 Runtime（新 Agent 框架、本地模型等）不影响业务层。
- `getTask / cancelTask / sendMessage / streamEvents` 目前仍为契约占位
  （`RuntimeCapabilityError`），M3 做 Progress / Event 时接入。

### 6.2 M2.1 起的调用链（官方 Gateway SDK，已实现）

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

### 6.3 Session Scope（M2.1 已实现最小映射；M3 设计约束）

M2.1 已实现 **Project ≠ Session**：ProjectStore 持久化 Runtime-neutral 引用
`runtimeSessionKey`；首次生成未存引用时由 Adapter 按 `projectId` 派生稳定 key
（`agent:{agentId}:paperteam-{projectId}`，同一 Project 复用、不同 Project 隔离），
成功后由 `GenerationService` 写回 project.json，下次原样透传。

**M3 设计约束**：并行 Reviewer 等场景将会话维度从

```text
projectId × agentId
```

扩展为：

```text
projectId × agentId × contextScope
```

即共享同一个 Reviewer Agent Definition 的 fact review / academic review / style review
可各持有独立 context scope（独立上下文、可独立并行、互不污染）。contextScope 的取值
与 sessionKey 派生规则在 M3.0 实现时冻结；ProjectStore 仍只保存不透明引用。

## 7. 质量与构建

- **Build Gate**：由 LatexCompiler 与日志解析实现（确定性）。判定维度：LaTeX 语法、
  references.bib 可用、图片资源、依赖 packages、编译结果。
- **Quality Gate**：确定性判定器，消费 Reviewer（fact / academic / style）与 Citation
  的结构化结果 + Evidence Store 状态（verificationStatus / supportStrength），对照
  targetProfile / targetVenue 要求输出通过 / 阻止项清单。数值 confidence 不是核心
  判定依据。
- 版本标记：Draft（Build Gate 通过即可）/ Final（双 Gate 通过）。

## 8. 前端双模式

- **论文工作台**（普通用户）：首页看板、我的论文（两类项目）、新建项目（两类入口）、
  论文写作、论文审稿、文献与证据（含 sourceRole / Style Profile）、PDF 查看
  （Draft / Final）、历史版本、项目设置。隐藏 session / agentId / runId / Gateway
  技术细节，只展示业务阶段与 awaiting_input 待办。
- **系统管理**（管理员）：系统状态、OpenClaw、Agent 管理、模型管理、Workflow 配置、
  WorkflowRun / Session、日志、文件管理、系统诊断、Command Center、Web Terminal。

实时通信：SSE（WorkflowRun 进度 / Domain Event）优先；Web Terminal 使用 WebSocket
（xterm.js + node-pty）。

## 9. Backend 模块划分

当前（M2.1 已实现）：

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

M3 规划新增（设计冻结，未实现）：

```text
backend/src/
├── workflow/      WorkflowOrchestrator、WorkflowRun、Stage 状态机、StageContract、
│                  checkpoint / resume、Domain Event 发布
├── runs/          WorkflowRun API（/api/runs/*）与 SSE
├── evidence/      EvidenceStore（存取、核验状态、反向定位）
├── sources/       项目文献库（sourceRole、解析、项目级检索）
├── citation/      Citation Agent 服务侧（引用核验结果、bib 治理）
└── quality/       Build Gate / Quality Gate 判定器
```

## 10. 部署形态

长期运行于 Linux 服务器（推荐 Ubuntu）：

- 服务：PaperTeam Backend、OpenClaw Gateway、Web Frontend、Database
- 依赖：Node.js（>= 22.19.0）、Git、Python、TeX Live（XeLaTeX/latexmk/Biber）、Poppler
- **后续使用 Docker 容器化部署**（配置位于 `docker/`）
- 用户只访问一个 HTTPS 域名；OpenClaw Gateway 作为内部服务，不对外暴露

## 11. 仓库目录结构

```text
PaperTeam/
├── frontend/   # Web 前端（论文工作台 + 系统管理后台，M4+）
├── backend/    # PaperTeam Backend
├── agents/     # Agent 定义与配置（AGENTS.md 等）
├── docker/     # Docker 部署配置
└── docs/       # PRD、状态、架构、决策记录
```
