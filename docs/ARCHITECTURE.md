# PaperTeam 系统架构

> 依据 [PRD.md](PRD.md) 与 [DECISIONS.md](DECISIONS.md)（D-0001~D-0018）整理。
> M1 / M2 / M2.1 / **M3（M3.0 Workflow Foundation / M3.1 Research & Evidence / M3.2 Review & Revision）已实现**，
> **M3.5 Runtime Bootstrap / M3 Closure 已实现（独立 OpenClaw Runtime + `npm run dev` 一键启动）**。
> 实现进度与测试 / 环境验证缺口以 [PROJECT_STATUS.md](PROJECT_STATUS.md) 为准；
> 前端（M4+）、Visual Reviewer、LaTeX repair loop、完整版本管理、Docker 部署为 Planned。

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

### 1.2 当前实现（M3 后）

M3 目标架构（§1.1）已在 backend 落地：HTTP API/SSE → WorkflowOrchestrator（确定性引擎）→
Researcher / Writer / Reviewer / Citation 业务角色（经 AgentRuntime 调用 Agent Runtime——
默认 OpenClaw Gateway，M3.7 起可切换 in-process Pi，见 §6.4）→
Project / Evidence / Artifacts 落盘 → Build Gate / Quality Gate。两条一级工作流
（Idea-to-Paper、Existing-LaTeX Improvement）共享审稿-修订-构建后段。尚未实现：
frontend（M4+）、Visual Reviewer、LaTeX repair loop、Git 版本管理体验、Admin 后台、Docker 部署。

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

## 3. Workflow 层（M3.0 已实现）

### 3.1 WorkflowOrchestrator

- **确定性 TypeScript 代码，不是 Agent，不调用 LLM**（D-0008）。
- 负责：状态、Stage 推进、retry、timeout、checkpoint、resume、branch、loop、hard gate。
- 不负责：内容理解、语义判断、论文分析、审稿（这些是 Agent / Skill 的事）。
- 实现：`backend/src/workflow/WorkflowOrchestrator.ts`（引擎）+ `definitions.ts`
  （两条 workflow 的 stage 注册表与 plan()/onInput() 纯函数规划器）。

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

### 3.5 WorkflowRun（异步运行，M3.0 已实现）

M2 的同步 `POST /api/projects/:id/generate` 保留为 deprecated 兼容端点；论文生产由异步 run 承载：

```text
POST /api/projects/:id/workflows   → 202 {runId, status}
GET  /api/runs/:runId              → { status, currentStage, awaiting?, error?, completion? }
GET  /api/runs/:runId/events       → SSE（Domain Event replay + 实时）
POST /api/runs/:runId/resume       → HITL 输入 {decision, payload?}
POST /api/runs/:runId/cancel
```

状态机（同一项目存在 pending/running/awaiting_input 的 run 时拒绝新建）：

```text
pending → running → awaiting_input → running → … → completed
                │                                    │
                ├──────────────► failed ◄────────────┤
                └──────────────► cancelled ◄─────────┘
```

终态转换遵循「先持久化 checkpoint、后提交内存、再广播事件」，保证对外可见的终态
一定已可恢复；进程重启后 `recoverInterruptedRuns()` 依据 checkpoint 重启中断的 run
（已成功 stage 不重复执行），awaiting_input 的 run 保持等待用户 resume。

### 3.6 Checkpoint / Resume / HITL（M3.0 已实现）

- WorkflowRun 状态与 checkpoint 持久化于项目 `workflow/runs/<runId>/`（Authoritative State）：
  `checkpoint.json`（原子写：tmp → fsync → rename）、`events.jsonl`、`stages/`（每次尝试记录）
- 恢复依据是 Workspace 状态与 checkpoint，不是 Chat History
- HITL：feasibility 确认（approve/adjust 重评估 ≤3 次/cancel）、outline 确认
  （approve/revise ≤3 次/cancel）、改进计划确认、bounded loop 超限介入
  （accept_draft/revise_more ≤3 轮/cancel）

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
  supportStrength / verificationLevel；数值 confidence 仅辅助）。存储采用文件优先：
  项目级 `evidence/evidence.jsonl` 持久化；EvidenceStore 保持接口抽象，项目内查询
  优先使用内存索引 / 文件扫描等轻量实现，M3 不提前引入数据库。
- **结构化状态**（WorkflowRun、ReviewReport、Issue、SystemLog 等）：与 EvidenceStore
  同口径——M3 文件优先、不提前引入数据库；SQLite 是否引入（后续可切 PostgreSQL）
  及具体索引方式，待真实数据规模 / 查询性能 / 并发 / 跨项目检索需求出现后再评估。
  文件内容仍在 Workspace。
- **版本管理**：服务器端 Git；前端只展示业务版本号（V12/V13…，Draft / Final 标记）；
  Existing-Paper 导入产生 baseline 快照版本。

## 6. Runtime 层

### 6.0 Runtime Bootstrap 与独立 OpenClaw 实例（M3.5 已实现）

PaperTeam 不依赖用户机器上的全局 OpenClaw 安装或全局 `~/.openclaw` state（D-0018）。
开发入口 `npm run dev`（仓库根）执行完整 Bootstrap：

```text
npm run dev
  │
  ├─ scripts/dev.mjs（入口薄壳）
  │    ├─ Node 版本检查（对齐锁定 openclaw 版本的支持范围）
  │    ├─ 根依赖（openclaw runtime 本体）/ backend 依赖缺失时自动 npm install
  │    └─ 构建 backend（tsc）→ 启动 backend/dist/dev/cli.js
  │
  └─ backend/src/dev/cli.ts（Runtime Bootstrap 编排）
       ├─ 解析 PaperTeam 用户级 Runtime 路径（默认 %USERPROFILE%\.paperteam；
       │    PAPERTEAM_RUNTIME_ROOT 可覆盖；与 ~/.openclaw 相等/嵌套 → 拒绝启动）
       ├─ 读取/生成 runtime/runtime.json（OpenClaw 精确版本、Gateway 端口、随机 token）
       ├─ 校验项目本地 openclaw 安装版本与锁定一致（漂移 → 拒绝启动）
       ├─ 准备独立 state：OPENCLAW_STATE_DIR + OPENCLAW_CONFIG_PATH
       │    （最小 config：{"gateway":{"mode":"local"}}，已存在不覆盖）
       ├─ 启动 Gateway（node openclaw.mjs gateway --port 18790，
       │    注入 OPENCLAW_STATE_DIR/CONFIG_PATH/GATEWAY_TOKEN，剔除 OPENCLAW_PROFILE）
       ├─ 等待 GET /health 就绪（默认 60s 预算；进程提前退出 → 报错不空等）
       ├─ 启动 Backend（注入 OPENCLAW_GATEWAY_URL/API_KEY/PAPERTEAM_PORT）
       └─ Ctrl+C / SIGTERM → 先停 Backend（checkpoint 落盘）再停 Gateway
            （优雅期 + Windows taskkill /T、POSIX SIGKILL 兜底；无孤儿进程）
```

布局与隔离：

```text
%USERPROFILE%\.paperteam\            （用户级，不入 Git；PAPERTEAM_RUNTIME_ROOT 可覆盖）
└── runtime\
    ├── runtime.json                 # Bootstrap 配置（端口 / 随机 token / OpenClaw 版本）
    └── openclaw\                    # OPENCLAW_STATE_DIR（会话/凭据/缓存/workspace）
        ├── openclaw.json            # OPENCLAW_CONFIG_PATH（Gateway 配置）
        └── .env                     # 模型 provider API Key（OpenClaw 官方凭据位置）
```

版本锚点：openclaw（runtime 本体，根 package.json devDependency）与
`@openclaw/gateway-client` / `@openclaw/gateway-protocol`（backend 依赖）全部精确
pin 到同一版本（当前 **2026.9.1**，wire protocol v4）；测试
（`backend/test/dev/versionPins.test.ts`）断言三处一致且不允许 `^`/`~`/`latest`。

### 6.0.1 Business Agent → Runtime Agent 映射（方案 A，D-0018）

```text
PaperTeam 业务角色              Runtime 映射（config 层，env 可覆盖）
Researcher / Writer /     →    OpenClaw agent "main"（默认；全新安装即存在）
Reviewer / Citation             会话隔离靠 contextScope（§6.3）：
                                  research / research/feasibility / writing/outline /
                                  writing/sections / review/fact / review/academic /
                                  review/style / …（同一 agent 内互不污染）
```

业务 Service 只持有注入的 agentId（`serviceStack` 装配），不感知 OpenClaw 注册表。
`GET /api/runtime/status` 通过 `agents.list` RPC 实时校验每个映射 registered/missing，
未来某角色需要独立模型/权限时改环境变量即可。

### 6.0.2 Runtime 诊断（GET /api/runtime/status，M3.5）

一次只读诊断（operator.read 权限，不泄露 token/密钥）回答四个问题：

| 维度 | 状态 |
|---|---|
| gateway | `healthy` / `starting` / `unavailable` / `auth_error` / `protocol_mismatch`（/health 探针 + connect 握手 + RPC） |
| runtime | `ready` / `model_not_configured` / `auth_error` / `protocol_mismatch` / `gateway_unavailable` |
| agents | 每个业务角色 → agentId 的映射 `configured` / `missing`（对照 agents.list） |
| model | `configured`（provider 名单）/ `not_configured` / `unknown`（models.authStatus） |

模型未配置不阻塞启动：Gateway 无凭据也能健康运行，诊断如实上报。

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
  Task / Event Stream；**M3.7 起新增并列实现 PiRuntimeAdapter**（§6.4，in-process
  Pi SDK，默认仍为 openclaw）。
- 任务状态统一为：`queued / running / completed / failed / cancelled`。
- 未来替换或新增 Runtime（新 Agent 框架、本地模型等）不影响业务层。
- `getTask / cancelTask / sendMessage / streamEvents` 在 OpenClaw 实现中仍为契约占位
  （`RuntimeCapabilityError`）；PiRuntimeAdapter 已实现 getTask（有限回溯）/
  cancelTask（真实 abort）/ streamEvents（事件回放），sendMessage 两端均为占位
  （HITL 走 Workflow resume，不经 Runtime sendMessage）。受 Contract v1 的
  runAgent 同步终态语义限制（taskId 在返回后才可知），运行中取消/订阅对上层
  仍不可达（`listActiveTasks()` 诊断口是其最小形态）；正式暴露属 Contract v2。

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
OpenClaw Gateway Client SDK（@openclaw/gateway-client 2026.9.1，wire protocol v4）
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

协议依据：OpenClaw **2026.9.1** 官方 npm 包（`@openclaw/gateway-client`、
`@openclaw/gateway-protocol` 及 `openclaw` 发行包内 docs）——"For agent runs,
start with the `agent` RPC and pair it with `agent.wait`"（docs/gateway/external-apps.md）。
protocol version 使用官方常量 `PROTOCOL_VERSION`（`@openclaw/gateway-protocol/version`，
当前 = 4），不在 PaperTeam 硬编码。
OpenClaw 特有标识（sessionKey 等）只存在于 Adapter 内部与 AgentTask.metadata 诊断字段。

### 6.3 Session Scope（M2.1 已实现最小映射；M3 设计约束）

M2.1 已实现 **Project ≠ Session**：ProjectStore 持久化 Runtime-neutral 引用
`runtimeSessionKey`；首次生成未存引用时由 Adapter 按 `projectId` 派生稳定 key，成功后写回。

**M3.0 已实现 contextScope（D-0016）**：会话维度为

```text
projectId × agentId × contextScope
```

派生规则（已冻结并在 Adapter 实现 + 测试）：

```text
无 scope：agent:{agentId}:paperteam-{projectId}          （M2.1 行为保持）
有 scope：agent:{agentId}:paperteam-{projectId}--{scope} （scope 安全归一化：
          小写、允许 [a-z0-9/_-]、非法字符折叠为 "-"、无 ":" 注入、长度 ≤48）
```

实际使用的 scope：research、research/feasibility、research/existing-analysis、
writing/outline、writing/sections、writing/revision、writing/improvement-plan、
review/fact、review/academic、review/style、sources/pdf-analysis。
显式 sessionKey 仍然优先；scope 取值由 PaperTeam 代码内控（不接受用户自由输入）。
派生实现自 M3.7 起共享于 `backend/src/runtime/sessionKey.ts`——两个 Adapter
（OpenClaw / Pi）产生完全一致的 sessionKey，provider 切换不改变上层会话语义。

### 6.4 PiRuntimeAdapter（M3.7 side-by-side 候选实现，默认不启用）

OpenClaw 2026.9.1 仍是 **production/default baseline**；Pi
（`@earendil-works/pi-coding-agent` 0.84.4 精确 pin）是 M3.7 的 feasibility
候选 runtime，经 `PAPERTEAM_AGENT_RUNTIME=pi` 启用（默认 `openclaw`）。两条路径
side-by-side，业务层零感知（仍只依赖 AgentRuntime 接口；所有 Pi 细节封装在
`backend/src/runtime/PiRuntimeAdapter.ts` 与 `pi/` 内部，业务代码不 import
`@earendil-works/*`）。

```text
业务层（Workflow / Researcher / Writer / Reviewer）
  │
AgentRuntime（接口，不变）
  │
PiRuntimeAdapter                       ←── 对照 OpenClawRuntimeAdapter
  │
@earendil-works/pi-coding-agent SDK（in-process，无子进程）
  │   createAgentSession()（官方 embedding API）：
  │     SessionManager.inMemory(cwd)   —— Runtime session 可丢弃（§2.1 红线）
  │     DefaultResourceLoader({ systemPromptOverride }) —— 角色 → 系统提示词
  │     tools: [...]                   —— 角色 → 工具白名单（最小必要，无 shell）
  │     ModelRuntime（agentDir 隔离： <runtimeRoot>/runtime/pi/agent/）
  │     SettingsManager.inMemory（关闭 auto-compaction）
  │
模型 Provider（anthropic / openai / zai / …内置目录，或注册的自定义 provider）
```

关键语义（与 OpenClaw 路径对齐或有意区分的点）：

- **会话**：一个逻辑 sessionKey ↔ 一个进程内 AgentSession；sessionKey 派生与
  OpenClaw 完全一致（§6.3，共享实现）。同一会话内串行（Pi 的 Agent 单会话
  一次一个 run），跨会话完全并发（Reviewer 三路 = 三个独立 AgentSession）。
  会话创建 in-flight 去重（并发同 key 只建一次）。
- **模型 / 凭据**：`PAPERTEAM_PI_MODEL`（provider/model-id）+ 可选
  `PAPERTEAM_PI_API_KEY`（`setRuntimeApiKey`，仅内存不落盘）；缺省按 Pi 官方
  优先级：agentDir auth.json > 标准环境变量。模型未配置 = Runtime 健康、
  模型未就绪（`modelStatusSnapshot()` 分区报告），runAgent 结构化失败，不伪造。
- **runAgent**：`session.prompt()` 同步终态语义（settle 即返回）；失败 / 中断
  不 reject，而是落在 transcript 的 assistant 消息 `stopReason`
  （`"error"` → failed 任务；`"aborted"` + 超时 → `AgentTimeoutError`；
  `"aborted"` + cancelTask → cancelled 任务）——与 OpenClaw 的
  agent.wait 终态口径一一对应。
- **timeout**：Pi SDK 无内建 run 超时；Adapter 定时器 + `session.abort()`
  实现与 OpenClaw 一致的 `runTimeoutMs`。
- **事件**：会话创建即 `session.subscribe()`，映射为 PaperTeam AgentEvent
  （agent_start / message_update / tool_execution_* / agent_end / agent_settled），
  按任务有界缓存；`streamEvents(taskId)` 为回放语义（v1 限制见 §6.1）。
- **abort**：`cancelTask(taskId)` 真实 `session.abort()`（LLM 流中断、工具执行
  收 abort signal），abort 后同一会话可继续使用（L2 测试实证）；对
  compaction 的 abort 边界未验证（PaperTeam 不触发 manual compaction，
  auto-compaction 已关闭）。
- **health**：无 HTTP 探针（in-process）；healthy = SDK 加载 + Adapter 未关闭 +
  ModelRuntime 初始化成功。「无 API Key」不是 Runtime 不健康（与 §6.0.2 的
  model_not_configured 分区语义一致）。
- **进程模型**：Backend 进程内完成一切——无 Gateway 子进程 / 端口 / WebSocket /
  握手 / RPC 轮询（Windows 实测零子进程；对照 OpenClaw 路径的 §6.0 Bootstrap
  全套设施）。`npm run dev` 在 pi 模式下只启动并监督 Backend。
- **诊断**：`GET /api/runtime/status` 按 provider 分流——pi 返回
  `gateway.phase="not_applicable"` + runtime/model 相位；RuntimeStatus 的形状
  仍为 Gateway 时代的结构，这是当前诊断服务与 OpenClaw 的架构耦合点
  （记录在案，未重写）。

## 7. 质量与构建（M3.2 已实现）

- **Build Gate**（`quality/gates.ts`）：由 LatexCompiler 编译 + 结构检查（include 文件存在、
  bib 可用）实现（确定性）。判定维度不含任何质量语义；编译失败/结构缺失给出 reasons。
- **Quality Gate**：确定性判定器，9 条规则消费 Reviewer 聚合结果 + Citation 报告 +
  Evidence 状态（supportStrength / verificationStatus）+ Feasibility 结论，阈值可配置
  （academic ≥ 80、style ≤ 35、自动修订 ≤ 2 轮）。数值 confidence 不是核心判定依据。
- **bounded revision loop**：Quality Gate 失败 → revision（review issues + 引用核验问题
  进入修订指令）→ 复核 → 循环 ≤ N 轮（默认 2）→ 超限 HITL（accept_draft / revise_more ≤3 / cancel）。
- 版本标记：Draft（Build Gate 通过即可）/ Final（双 Gate 通过）；completion.label 记录于
  run 结果（完整版本管理体验属 M4+）。

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

M3 实际结构：

```text
backend/src/
├── config/        配置加载与校验（gateway / agents / projects / latex / workflow / citation / review）
├── errors.ts      业务错误模型（稳定错误码 → HTTP 状态码映射）
├── runtime/       AgentRuntime 契约 + OpenClawRuntimeAdapter（contextScope 派生）
│   │              + statusService（GET /api/runtime/status 诊断）
│   └── openclaw/  gatewayClient（官方 GatewayClient 的薄 wrapper）
├── dev/           Runtime Bootstrap（M3.5）：runtimePaths（独立 state 路径与隔离校验）、
│                  runtimeConfig（runtime.json：版本/端口/token）、openclawState（state
│                  准备 + 安装校验 + 子进程环境）、gatewayHealth（/health 轮询等待）、
│                  supervisor（Gateway+Backend 双进程生命周期）、cli（编排入口）
├── project/       ProjectStore（研究定位字段 / 路径安全 / list / updateMeta）
├── workflow/      WorkflowOrchestrator（引擎）、definitions（两条 workflow 的
│                  stage 注册表 + plan/onInput 确定性规划器）、runStore（checkpoint
│                  持久化）、eventLog（Domain Event JSONL）、types（StageContract 等）
├── agents/        ResearcherService、FeasibilityService、ReviewerService（业务角色，
│                  Prompt + 结构化输出校验）、outputParsing（防御性 JSON 提取）
├── writer/        WriterService（M2 完整文档 + M3 大纲 / 分节 / 修订 / 改进计划）
├── evidence/      EvidenceStore（project-scoped JSONL）
├── sources/       SourceStore（文献库）+ PdfAnalyzer（builtin 文本层 + multimodal 扩展点）
├── manuscript/    ManuscriptService（outline / main.tex 组装 / context.yaml）、
│                  LatexFiles（\input 递归收集）
├── citation/      StaticCitationChecker（Layer 1）、metadataProviders（Layer 2：
│                  CrossRef/OpenAlex/arXiv）、CitationService（编排 + 报告）
├── review/        ReviewAggregator（确定性聚合）
├── quality/       gates（Build Gate / Quality Gate 判定器）
├── import/        zipReader（零依赖 ZIP + 防 Zip Slip）、LatexImporter（导入 MVP）
├── serviceStack.ts 服务栈装配（生产与测试共用）
└── httpServer.ts  Node 原生 HTTP：全部 API + SSE
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
├── package.json      # 根开发入口（openclaw runtime 精确 pin + npm run dev）
├── scripts/dev.mjs   # dev 启动器薄壳（依赖/构建检查 → 启动 Runtime Bootstrap）
├── frontend/         # Web 前端（论文工作台 + 系统管理后台，M4+）
├── backend/          # PaperTeam Backend（含 src/dev Runtime Bootstrap）
├── agents/           # Agent 定义与配置（AGENTS.md 等）
├── docker/           # Docker 部署配置
└── docs/             # PRD、状态、架构、决策记录
```

运行时数据均在仓库外：论文项目 workspace 在 `PROJECTS_ROOT`（默认 backend/projects/），
OpenClaw 独立 state 在用户级 `~/.paperteam/`（见 §6.0），二者均被 .gitignore 排除。
