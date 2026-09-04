# PaperTeam 系统架构

> 依据 [PRD.md](PRD.md) 与 [DECISIONS.md](DECISIONS.md)（D-0001~D-0019）整理。
> M1 / M2 / M2.1 / **M3（M3.0 Workflow Foundation / M3.1 Research & Evidence / M3.2 Review & Revision）已实现**，
> **M3.8 已完成：Pi SDK 成为唯一正式 Runtime（in-process，零 Gateway），AgentRuntime 契约升级 v2**。
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
                   AgentRuntime                   ← 统一 Runtime 接口（Contract v2）
                         │
                  PiRuntimeAdapter                ← Runtime 隔离层
                         │
              Pi SDK（in-process）                 ← Agent Runtime
                         │
                   LLM / Tools
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
Pi SDK in-process（@earendil-works/pi-coding-agent 0.84.4，无子进程）
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
Researcher / Writer / Reviewer / Citation 业务角色（经 AgentRuntime Contract v2 调用
PiRuntimeAdapter —— Pi SDK in-process，见 §6.4）→
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
| **Runtime Context**（运行时上下文） | Pi AgentSession（进程内会话） | disposable，可重建，**不承担项目真相** |

规则（D-0013）：业务流程不能依赖 Chat History 才能恢复；恢复依据是 Workspace 状态与
workflow checkpoint。

### 2.2 Project ≠ Session

```text
PaperTeam Project（业务对象，ProjectStore 自持）
  │  project.json: { id, title, status, …, runtimeSessionKey? }   ← Runtime-neutral 引用
  ▼
Pi AgentSession（Agent Runtime 上下文，进程内）
     sessionKey = agent:{agentId}:paperteam-{projectId}          ← M2.1 已实现
     M3 扩展：projectId × agentId × contextScope                  ← 见 §6.3
```

Project 是论文业务对象；Session 是 Agent 对话 / 工作上下文，可丢弃重建。

### 2.3 Domain Event ≠ Runtime Event

```text
Pi Runtime Event（SDK 事件：session / agent 运行信号）
   ↓
PiRuntimeAdapter（转换 / 归一化）
   ↓
WorkflowOrchestrator（消费运行信号，驱动 Stage 状态机）
   ↓
PaperTeam Domain Event（业务事件）
   ↓
SSE（前端进度）
```

Domain Event 示例：`workflow.started`、`stage.started`、`stage.completed`、
`stage.failed`、`workflow.awaiting_input`、`workflow.resumed`、
`quality_gate.failed`、`workflow.completed`。Pi 的原始事件对象、sessionKey 等细节
不允许透传到前端事件协议（Runtime Event → AgentEvent → Domain Event 逐层归一化）。

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

### 6.0 Runtime 形态与 dev 启动（M3.8：Pi in-process）

M3.8 起 Pi SDK 是**唯一正式 Runtime**：Backend 进程内嵌入
`@earendil-works/pi-coding-agent`（0.84.4 精确 pin），无 Gateway 子进程 / 端口 /
WebSocket / 握手 / RPC。M3.5~M3.6 时代的 OpenClaw Runtime Bootstrap（独立 state、
runtime.json、Gateway spawn/health/token/supervisor）已随迁移移除，git 历史即回退
机制；用户磁盘上的旧 `~/.paperteam/runtime/openclaw/` state 无害忽略。

开发入口 `npm run dev`（仓库根）：

```text
npm run dev
  │
  └─ scripts/dev.mjs
       ├─ Node 版本检查（根 package.json engines.node 为唯一事实源）
       ├─ backend 依赖缺失时自动 npm install
       ├─ 构建 backend（tsc）
       └─ 直启 backend/dist/index.js（stdio 直通；POSIX 转发信号，
          Windows Ctrl+C 原生送达 Backend 自行优雅收敛）
```

Backend 启动（`backend/src/index.ts`）：加载 .env → 校验配置 → 构造
PiRuntimeAdapter → healthCheck（Runtime 健康 ≠ 模型就绪）→ 装配服务栈与
WorkflowOrchestrator → 恢复中断 run → HTTP 监听。Ctrl+C / SIGTERM：
先停编排器（取消活跃 run、checkpoint 落盘）→ Runtime close（取消/收敛全部
在途 run、dispose 会话）→ 关 HTTP（断开 SSE）。

Pi 配置目录布局（用户级，不入 Git；`PAPERTEAM_RUNTIME_ROOT` 可覆盖）：

```text
%USERPROFILE%\.paperteam└── runtime\pigent    ├── auth.json    # Pi 官方凭据（可选；也可用 PAPERTEAM_PI_API_KEY / 标准环境变量）
    └── models.json  # 自定义模型注册（可选）
```

### 6.0.1 Business Agent → Runtime 会话映射（方案 A，D-0018）

```text
PaperTeam 业务角色              Runtime 映射（config 层，env 可覆盖）
Researcher / Writer /     →    会话标识 "main"（默认；仅作 sessionKey 组成段与
Reviewer / Citation             诊断标签——Pi 无 agent 注册表，角色由
                                PiRuntimeAdapter 按 contextScope 前缀解析为
                                systemPrompt + 工具白名单）
                                会话隔离靠 contextScope（§6.3）：
                                  research / research/feasibility / writing/outline /
                                  writing/sections / review/fact / review/academic /
                                  review/style / …（互不污染）
```

业务 Service 只持有注入的 agentId（`serviceStack` 装配）。`PAPERTEAM_{ROLE}_AGENT_ID`
可覆盖会话标识（主要影响 sessionKey 派生段）。

### 6.0.2 Runtime 诊断（GET /api/runtime/status，M3.8 形状）

一次只读诊断（不泄露 token/密钥）回答四个问题：

| 维度 | 状态 |
|---|---|
| runtime | `provider: "pi"`、`phase: healthy / unhealthy`、`version`（Pi SDK 精确版本）、detail、latencyMs（healthCheck：SDK 可加载 + Adapter 未关闭 + ModelRuntime 初始化正常） |
| model | `phase: configured / not_configured / unknown`、`model?`（解析后的 provider/model-id）、`providers`（有凭据名单） |
| agents | 每个业务角色 → 会话标识映射（Pi 无注册表，恒 `configured`） |
| sessions | `activeRuns`（在途 run 数）/ `managedSessions`（受管 AgentSession 数） |

模型未配置不阻塞启动：Runtime healthy + model `not_configured` 分区如实上报
（Runtime 健康 ≠ 模型就绪）。M4 Frontend 不需要感知历史上的 Gateway 概念
（gateway / protocol / clientSdk 字段已随 M3.8 删除）。

### 6.1 AgentRuntime 契约（Contract v2，M3.8）

业务层不直接依赖 Pi SDK，只依赖统一接口（`backend/src/runtime/types.ts`）：

```ts
interface AgentRuntime {
  readonly provider: RuntimeProvider;                       // "pi"
  startAgent(input: RunAgentInput): Promise<AgentRunHandle>; // v2 主入口
  runAgent(input: RunAgentInput): Promise<AgentTask>;        // convenience = start + await result
  getTask(taskId: string): Promise<AgentTask>;               // 已完结任务回溯
  healthCheck(): Promise<RuntimeHealth>;                     // Runtime 健康（≠ 模型就绪）
  close(): Promise<void>;                                    // 收敛全部 run / dispose 会话
}

interface AgentRunHandle {
  readonly taskId: string;      // startAgent 返回时即已生成（不等排队/执行）
  readonly sessionKey: string;
  events(): AsyncIterable<AgentEvent>; // replay + live；settle 后自然结束；多订阅独立
  cancel(): Promise<void>;             // 幂等；queued 短路 / running 真实 abort
  result(): Promise<AgentTask>;        // 终态（Promise 缓存，可重复 await；超时/Runtime 异常 reject）
}
```

- 唯一实现：**PiRuntimeAdapter**（§6.4）。
- 任务状态统一为：`queued / running / completed / failed / cancelled`。
- 未来替换或新增 Runtime 不影响业务层（v1 → v2 的动机与迁移记录见 D-0019：
  v1 的 runAgent 同步终态语义使 taskId 在结束后才可知，运行中取消/订阅对上层
  不可达；v2 以句柄为核心修复）。
- v1 的 `cancelTask / streamEvents / sendMessage` 已从契约移除：取消走
  `handle.cancel()`，事件走 `handle.events()`，HITL 走 Workflow resume。
- 业务层既有 `await runtime.runAgent(...)` 调用点（Researcher / Writer /
  Reviewer / Citation / PdfAnalyzer）经 convenience helper 零改动保持原语义。

### 6.2 调用链（Pi in-process，M3.8 已实现）

```text
HTTP API
  │
GenerationService / ResearcherService / ReviewerService / …
  │
AgentRuntime（Contract v2 接口）
  │
PiRuntimeAdapter
  │
@earendil-works/pi-coding-agent SDK（in-process，无子进程）
  │   createAgentSession()（官方 embedding API）：SessionManager.inMemory(cwd)、
  │   DefaultResourceLoader({ systemPromptOverride })、tools 白名单、
  │   ModelRuntime（agentDir 隔离）、SettingsManager.inMemory（关闭 auto-compaction）
  │
模型 Provider（anthropic / openai / …内置目录，或注册的自定义 provider）+ Tools
```

**startAgent 的真实映射**：

```text
AgentRuntime.startAgent(input)
  → 校验（空任务 / closed / init error → 结构化异常）
  → 解析 sessionKey（显式透传 > projectId×agentId×contextScope 派生，§6.3）
  → 生成 taskId，立即返回 AgentRunHandle（不等排队/执行）
  → 后台链：getOrCreateSession（in-flight 去重）→ per-session 串行队列
    （Pi 单会话一次一个 run；跨会话完全并发）→ session.prompt()
    （同步终态语义：settle 才 resolve；失败/中断不 reject，落在 transcript
    assistant 消息 stopReason）→ 终态归因为 AgentTask
  → handle.result()：completed / failed（stopReason=error）/ cancelled
    （cancelRequested + aborted|error）/ 超时 reject AgentTimeoutError
```

事件：会话创建即 `session.subscribe()`，Pi 事件映射为 PaperTeam AgentEvent
（原始事件对象不透传）；`handle.events()` replay + live 消费。
取消：`handle.cancel()` → `session.abort()`（协作式：LLM 流中断、工具执行收到
AbortSignal——tool execution abort 已由真实 SDK 专项测试实证）；排队中任务
置标记、获得会话后直接短路为 cancelled（不误伤同会话前序 run）。
Pi 特有标识（sessionKey 等）只存在于 Adapter 内部与 AgentTask.metadata 诊断字段。

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
派生实现共享于 `backend/src/runtime/sessionKey.ts`（纯函数，与 Runtime 实现
解耦）——sessionKey 是 PaperTeam 的业务事实，Runtime 实现变化不改变上层会话语义。

### 6.4 PiRuntimeAdapter（M3.8 正式 baseline）

Pi（`@earendil-works/pi-coding-agent` **0.84.4** 精确 pin）是 M3.8 起的**唯一正式
Runtime**（M3.7 为 side-by-side 可行性验证，OpenClaw 2026.9.1 为 M3.5/M3.6 历史
baseline，全部 OpenClaw 运行时依赖已移除）。所有 Pi 细节封装在
`backend/src/runtime/PiRuntimeAdapter.ts` 与 `pi/` 内部，业务代码不 import
`@earendil-works/*`。

```text
业务层（Workflow / Researcher / Writer / Reviewer）
  │
AgentRuntime（Contract v2 接口，§6.1）
  │
PiRuntimeAdapter
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

关键语义：

- **会话**：一个逻辑 sessionKey ↔ 一个进程内 AgentSession；sessionKey 派生（§6.3）
  稳定。同一会话内串行（Pi 的 Agent 单会话一次一个 run；排队发生在句柄返回之后，
  taskId 的立即可得性不依赖队列位置），跨会话完全并发（Reviewer 三路 = 三个独立
  AgentSession）。会话创建 in-flight 去重（并发同 key 只建一次）。
- **模型 / 凭据**：`PAPERTEAM_PI_MODEL`（provider/model-id）+ 可选
  `PAPERTEAM_PI_API_KEY`（`setRuntimeApiKey`，仅内存不落盘、不进日志）；缺省按
  Pi 官方优先级：agentDir auth.json > 标准环境变量。模型未配置 = Runtime 健康、
  模型未就绪（`modelStatusSnapshot()` 分区报告），startAgent 结构化失败，不伪造。
- **终态归因**：`session.prompt()` 同步终态语义；transcript assistant 消息
  `stopReason`：`"error"` → failed；`"aborted"`（或工具执行中 abort 的
  `"error" + "This operation was aborted"`，以 cancelRequested 意图归因）→
  cancelled；超时 → `AgentTimeoutError`（handle.result() reject）。
- **timeout**：Pi SDK 无内建 run 超时；Adapter 定时器 + `session.abort()`。
- **事件**：会话创建即 `session.subscribe()`，映射为 PaperTeam AgentEvent
  （agent_start / message_start / message_update / message_end /
  tool_execution_start / update / end / agent_end / agent_settled / turn_start /
  turn_end）；`handle.events()` 为 replay + live，settle 后迭代自然结束。
- **abort**：`handle.cancel()` 真实 `session.abort()`（幂等；LLM 流中断、工具执行
  收 AbortSignal——真实 SDK 专项测试实证），abort 后同一会话可继续使用；
  对 compaction 的 abort 边界未验证（PaperTeam 不触发 manual compaction，
  auto-compaction 已关闭；上游边界，见 PROJECT_STATUS 遗留 4）。
- **health**：无 HTTP 探针（in-process）；healthy = SDK 加载 + Adapter 未关闭 +
  ModelRuntime 初始化成功。「无 API Key」不是 Runtime 不健康（与 §6.0.2 的
  model not_configured 分区语义一致）。
- **进程模型**：Backend 进程内完成一切——无 Gateway 子进程 / 端口 / WebSocket /
  握手 / RPC 轮询（Windows 实测零子进程）。`npm run dev` 直启 Backend（§6.0）。
- **诊断**：`GET /api/runtime/status` 为 Pi 形状（§6.0.2），无 Gateway 概念。

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
  （Draft / Final）、历史版本、项目设置。隐藏 session / agentId / runId / Runtime
  技术细节，只展示业务阶段与 awaiting_input 待办。
- **系统管理**（管理员）：系统状态、Runtime/模型管理、Workflow 配置、
  WorkflowRun / Session、日志、文件管理、系统诊断、Command Center、Web Terminal。

实时通信：SSE（WorkflowRun 进度 / Domain Event）优先；Web Terminal 使用 WebSocket
（xterm.js + node-pty）。

## 9. Backend 模块划分

M3 实际结构：

```text
backend/src/
├── config/        配置加载与校验（pi / agents / projects / latex / workflow / citation / review）
├── errors.ts      业务错误模型（稳定错误码 → HTTP 状态码映射）
├── runtime/       AgentRuntime 契约 v2 + PiRuntimeAdapter（sessionKey 派生、角色映射
│   │              pi/roleConfig、版本 pin pi/version）+ statusService（诊断，Pi 形状）
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

- 服务：PaperTeam Backend（内嵌 Pi Runtime）、Web Frontend、Database
- 依赖：Node.js（>= 22.19.0）、Git、Python、TeX Live（XeLaTeX/latexmk/Biber）、Poppler
- **后续使用 Docker 容器化部署**（配置位于 `docker/`）
- 用户只访问一个 HTTPS 域名；模型 Provider 凭据经环境变量 / auth.json 配置

## 11. 仓库目录结构

```text
PaperTeam/
├── package.json      # 根开发入口（npm run dev / build / test 转发）
├── scripts/dev.mjs   # dev 启动器（Node/依赖检查 → 构建 → 直启 Backend）
├── frontend/         # Web 前端（论文工作台 + 系统管理后台，M4+）
├── backend/          # PaperTeam Backend（API / Workflow / Pi Runtime）
├── agents/           # Agent 定义与配置（AGENTS.md 等）
├── docker/           # Docker 部署配置
└── docs/             # PRD、状态、架构、决策记录
```

运行时数据均在仓库外：论文项目 workspace 在 `PROJECTS_ROOT`（默认 backend/projects/），
Pi 配置目录在用户级 `~/.paperteam/runtime/pi/agent/`（见 §6.0），二者均被 .gitignore 排除。
