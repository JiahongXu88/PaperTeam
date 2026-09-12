# PaperTeam 系统架构

> 依据 [PRD.md](PRD.md) 与 [DECISIONS.md](DECISIONS.md)（D-0001~D-0026）整理。
> **M1 ~ M3.8（Backend：Workflow / Evidence / Review / Pi Runtime）与 M4.0-M4.8
> （React Web Workbench + HITL / Workflow Live View / Evidence / 质量门禁 /
> Draft-Final 产物闭环 / 版本体验）已实现**；Pi SDK 为唯一正式 Agent Runtime
> （in-process），AgentRuntime 契约 v2。实现进度与测试 / 环境验证缺口以
> [PROJECT_STATUS.md](PROJECT_STATUS.md) 为准；M5 范围以
> [M5_PLAN.md](M5_PLAN.md) 为准——M5.3 Skill 受控接入、M5.5 单机 Linux /
> Docker 部署在列；Visual Reviewer 与系统管理后台移出 M5（M5_PLAN §2）。
> **Iterative Writer–Reviewer Outer Review Loop（§13，D-0026）已于 M4.7 实现**
> （score-driven loop / Revision Plan / 收敛判定 / iteration history），
> M4.8 补齐版本体验（历史 / 比较 / 不可变恢复）。

## 1. 总体架构

### 1.1 目标架构

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
PaperTeam Web（frontend/，M4.0-M4.2 已落地基础壳）
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
   ├── File / Version      文件上传与版本管理（当前实现：ManuscriptRevisionStore 不可变修订快照，非 Git）
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

### 1.2 当前实现（2026-09 后）

M3 目标架构（§1.1）已在 backend 落地：HTTP API/SSE → WorkflowOrchestrator（确定性引擎）→
Researcher / Writer / Reviewer / Citation 业务角色（经 AgentRuntime Contract v2 调用
PiRuntimeAdapter —— Pi SDK in-process，见 §6.4）→
Project / Evidence / Artifacts 落盘 → Build Gate / Quality Gate。三类一级工作流
（Idea-to-Paper、Existing-Paper Improvement、**Existing-Paper Review**（2026-09，
PDF 只读快速审阅：PaperMap → Citation Integrity → 分章节 ReviewFinding → 聚合报告，
completion label=`review`，与旧 manuscript review 三路审稿互不复用））；前两者
共享审稿-修订-构建后段。前端 React Web Workbench（M4.0-M4.3，§8）已落地项目
列表 / 新建项目（二选一入口 + PDF File-First 导入）/ 项目工作区（含 Review Tab）/
Skills / Settings（模型设置 + 项目管理）。项目生命周期含 归档 / 恢复 / 永久删除
（`archivedAt` 独立生命周期字段；删除时释放 Runtime 项目会话
`releaseProjectSessions`）；工作流实时视图（M4.4：Stage Timeline / SSE 实时 / 取消 /
分章节进度 / 最近运行，SSE 数据层 `useWorkflowEvents` 页面级订阅）、HITL 决策面板
（M4.5）、Evidence 工作台 + 质量门禁面板（M4.6）、Draft/Final 产物闭环 + Writer–
Reviewer 修订闭环 + bounded LaTeX repair（M4.7）、版本体验（M4.8：版本历史 /
确定性比较 / 不可变恢复，`ManuscriptRevisionStore` 不可变修订链 + VersionService）。
论文版本以不可变修订快照实现（非 Git）；尚未实现：Visual Reviewer（M5 未含）、
Admin 后台（M5 未含）；Skill install/update（M5.3）与单机 Linux / Docker
部署（M5.5）在 M5 范围内（见 M5_PLAN.md）。

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

fan-out / join 的使用点：三类 review skill 并行、多节 Revision 并行、多文献解析并行、
分章节 Review 有界并发（`SectionReviewScheduler` + `util/concurrency.ts` 的
`mapWithConcurrency`：活跃模型调用 ≤ `PAPERTEAM_REVIEW_CONCURRENCY`，每节独立
contextScope/Pi session，单节失败隔离，结果按论文顺序确定性重排，每节完成即写
per-section journal 供 stage 重试/崩溃恢复复用）；并发上限可配置。

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
| timeout | 空闲超时：连续 timeoutMs 无进度汇报（emitProgress）即判超时并 abort 在途 stage；分章节 Review 等长 stage 按节汇报进度，总时长可随论文长度增长 |

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
资源时才拆独立 Agent。LaTeX 修复是确定性工具（M4 已实现）；Visual
Reviewer、Experiment subsystem 均在 backlog（M5 未含，见 M5_PLAN §2）。

### 4.3 Agent 与确定性组件的边界

- WorkflowOrchestrator、LatexCompiler、Quality Gate 判定器、EvidenceStore、
  ProjectStore、版本管理：**确定性代码**，绝不封装为 LLM Agent。
- Agent 只通过 AgentRuntime 被调用；其输出必须落盘并通过 DoD / 结构化校验后才进入
  下一 Stage（Agent 输出不直接成为状态机输入）。

## 5. 数据与文件

- **Workspace（Authoritative State）**：`projects/<id>/` 下 `manuscript/`（main.tex、
  sections/、revisions.json 不可变修订链）、`sources/`（papers / parsed / metadata）、
  `evidence/`、`reviews/`、`workflow/`、`figures/`、`tables/`、`data/`、`build/`
  （compile.log / build-gate.json）、`artifacts/`（manifest.json +
  art-draft/final-rev{n}.pdf，不可变产物）、`project.json`。
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

Pi SDK 是**唯一正式 Runtime**：Backend 进程内嵌入
`@earendil-works/pi-coding-agent`（0.84.4 精确 pin），全部 Agent 执行发生在
Backend 进程内。（历史：M3.5/M3.6 曾使用 OpenClaw Gateway，M3.8 迁移到 Pi 并移除
全部相关基础设施，演进见 DECISIONS.md D-0019/D-0020；用户磁盘上的旧
`~/.paperteam/runtime/openclaw/` state 无害，可忽略。）

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
%USERPROFILE%\.paperteam\
├── settings\
│   ├── model.json             # M4.3.7.5 Settings UI 保存的模型偏好（非敏感；原子写）
│   └── custom-providers.json  # Settings UI 添加的自定义提供商（baseUrl / 协议 / 模型目录 / 请求头；无 key；启动时 registerProvider 重放）
└── runtime\pi\agent
    ├── auth.json    # Pi 官方凭据（Settings UI 保存的 API Key 也在此，自定义提供商同样；也可用 PAPERTEAM_PI_API_KEY / 标准环境变量）
    └── models.json  # Pi 官方格式的手工模型注册（可选，与 custom-providers.json 并存）
```

**模型配置两级来源（M4.3.7.5）**：优先级 `PAPERTEAM_PI_MODEL` /
`PAPERTEAM_PI_API_KEY`（env，含 .env 补缺）> Settings UI 保存的本地配置
（`settings/model.json` 偏好 + `runtime/pi/agent/auth.json` 凭据）。
本地保存完全复用 Pi 官方公开 API（不 deep import、不自建第二套 credential）：
保存 Key = `ModelRuntime.login(provider,"api_key",interaction)`（经
CredentialStore.modify 原子写 auth.json 并同步 provider 快照）；清除 =
`ModelRuntime.logout`。API Key 属文件型本地存储（明文 JSON，权限边界为
用户目录），不引入 DPAPI / Credential Manager（后续可单独增强，如实记录
安全边界）；Key 永不进日志 / Git / 任何 GET 响应。

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
（Runtime 健康 ≠ 模型就绪）。前端只消费本节 schema（DECISIONS D-0020）。

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

Pi（`@earendil-works/pi-coding-agent` **0.84.4** 精确 pin）是**唯一正式
Runtime**（演进历史见 DECISIONS.md D-0019/D-0020）。所有 Pi 细节封装在
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
  M4.3.7.5 起 Settings UI 可在运行中变更配置（`reconfigure()`）：只影响新的
  Agent Run；在途 run > 0 时拒绝（`MODEL_CONFIG_BUSY` 409，前置检查先于落盘）；
  空闲会话直接释放重建（Workspace/checkpoint 是事实源，Runtime session 本就可
  丢弃）；启动装配按 env > stored 解析生效模型（`resolveStartupModelSpec`），
  重启后本地配置自动恢复。
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
- **进程模型**：Backend 进程内完成一切（无子进程、无额外端口；Windows 实测）。
  `npm run dev` 直启 Backend（§6.0）。
- **诊断**：`GET /api/runtime/status` 为 Pi 形状（§6.0.2）。

### 6.5 长程运行治理（M5.1/M5.2 已实现）

`PiRuntimeAdapter` 在 AgentRuntime 契约 v2 之上叠加的四层治理（全部进程内
实现，无 Redis / BullMQ / 外部 scheduler / 数据库）：

- **分层 timeout（M5.1）**：init / session / queue / execution 四个真实生命
  周期阶段独立计时，超时统一 `AgentTimeoutError(phase)` + `timed_out` 结构化
  终态（`*_TIMEOUT` errorCode + timeoutPhase 可经 getTask 回溯）；queue 阶段
  deadline 跨 FIFO → 全局 permit 等待不重置。
- **全局并发与有界受理（M5.2 第一批）**：进程级 execution permit
  （≤ `maxConcurrentRuns`，FIFO 派发，任务到达 session 队头后才申请）+
  admission 上限（已受理未执行 ≤ `maxQueuedRuns`，占满即
  `failed(RUNTIME_QUEUE_FULL)`）。记账在 settle 收口（first-wins），全路径
  无槽位泄漏。
- **Context Budget（M5.2 收口）**：`contextWindow` / `maxTokens` 只取
  resolved Pi Model（不维护模型表）。当前占用三态：measured（上一 run
  provider 实测 `usage.totalTokens`）> estimated（CJK 感知消息估算，
  `runtime/pi/contextBudget.ts`）> unknown（如实为 null，绝不伪装 0）。
  输出预留 `min(maxTokens, ⌈window×25%⌉, 32768)`（可配置）。会话队头
  preflight：`占用 + 输入估算 + 预留 > 窗口` → rotation；单次输入即使
  全新会话也装不下 → 受理前 `failed(CONTEXT_BUDGET_EXCEEDED)`（不调
  provider、不静默截断 Evidence / 稿件 / Review）。auto-compaction 保持
  关闭——治理策略是「受控上下文 + 必要时新建 Session」，不是自动摘要压缩。
- **Session Rotation（M5.2 收口）**：ManagedSession 为稳定调度容器
  （sessionKey / FIFO / activeTaskId 不变），内部 Pi AgentSession 按
  generation 换代；rotation 只在安全边界（队头独占 + permit 已持有 +
  未 prompt）。触发：context 压力（measured/estimated）/ runCount 兜底
  （仅 context 不可知时）/ needsRotation 自愈标记。不做摘要迁移——
  Workspace/checkpoint + 本轮业务 prompt 是新会话完整事实源（§2.1 红线）。
- **TTL / GC / 容量（M5.2 收口）**：idle（无 active / 无排队 / 无到达中
  任务）超过 TTL → GC 回收；`maxSessions` 硬上限（先 TTL 后 LRU 淘汰
  idle，全忙 → `failed(RUNTIME_SESSION_CAPACITY)`）。active / queued /
  到达中的会话绝不被回收；reconfigure / release / close 与 GC / rotation
  竞态由容器级幂等 dispose 保证不双重释放。
- **观测与自愈（M5.2 收口）**：`runtimeStats()` 全局计数（含 rotation /
  GC / 预算拒绝）+ `sessionDiagnostics()` 逐会话生命周期与上下文占用
  （不含 prompt / 密钥），经 `GET /api/runtime/status` 透传。自愈仅限
  确定性场景（execution timeout / prompt 异常 → 下一安全边界重建底层
  会话），**不自动重试业务任务**。进程 crash 边界如实：内存中会话与
  在-flight 调用不迁移；Workspace/checkpoint 保留已完成 stage，未完成
  调用由 Workflow 层处理；Runtime 重启从空会话池开始，无脏恢复。

## 7. 质量与构建（M3.2 已实现）

- **Build Gate**（`quality/gates.ts`）：由 LatexCompiler 编译 + 结构检查（include 文件存在、
  bib 可用）实现（确定性）。判定维度不含任何质量语义；编译失败/结构缺失给出 reasons。
- **Quality Gate**：确定性判定器，9 条规则消费 Reviewer 聚合结果 + Citation 报告 +
  Evidence 状态（supportStrength / verificationStatus）+ Feasibility 结论，阈值可配置
  （academic ≥ 80、style ≤ 35、自动修订 ≤ 2 轮）。数值 confidence 不是核心判定依据。
- **bounded revision loop**：Quality Gate 失败 → `revision.plan`（确定性派发，
  一等落盘 artifact）→ `revision.revise`（Writer 按计划逐节修订）→ 强制复审 →
  收敛判定（PASS / IMPROVED / CONVERGED / REGRESSION）→ 不收敛 / 超限 HITL
  （accept_draft / revise_more ≤3 / cancel）→ 循环 ≤ N 轮（默认 2）。
- **LaTeX 修复环**：Build 失败（质量问题不阻塞构建）→ 结构化诊断（文件 /
  行号 / 错误 / 附近行）→ `revision.repair_latex`（Writer 最小上下文修复，
  每项目自动 ≤2 次，可取消）→ 耗尽 → 带错误上下文修订或 HITL。
- **产物域（M4.7）**：`artifacts/` 不可变 manifest——Build 通过即冻结
  `art-draft-rev{n}.pdf`（Draft 不受 Quality Gate 约束）；FinalizeService
  纯确定性双 Gate 对齐校验后冻结 `art-final-rev{n}.pdf`；下载只经 manifest
  解析（projectId + artifactId），不接受文件系统路径参数。

> 以上为 **已实现基线（M3.2 起，M4.7 完成 §13 规划的全部 outer loop 语义**：
> Revision Plan 一等 artifact、CONVERGED / REGRESSION 终止、迭代历史、
> Draft/Final 产物闭环）。两层 loop（Pi inner vs PaperTeam outer）的边界见
> §13.1；完整语义见 §13。

## 8. 前端（M4.0-M4.2 已落地 React Web Workbench）

### 8.1 技术栈与目录（M4.1）

冻结技术栈：**React 19 + TypeScript（strict）+ Vite + React Router 7 +
TanStack Query 5 + Zustand 5**（npm；无 Next.js / Redux / GraphQL / SSR /
大型设计系统——样式为单文件手写 CSS）。

```text
frontend/src/
├── api/            # 统一 API 层：client（ApiError/NETWORK_ERROR 收敛）+
│   │                # projects / runs / runtime / paper / skills / settings（唯一 fetch 出口；
│   │                # runs.ts 逐字段校验 WorkflowState → WorkflowRunView）
├── types/          # Frontend DTO（api.ts / paper.ts；契约见 docs/API_CONTRACT.md）
├── hooks/queries.ts# TanStack Query hooks；key 分 ["projects","list",scope] 与 ["project",id,…]
│                    # 两族，列表失效不重取项目子查询；run 列表只在有活跃 run 时轮询
├── stores/         # Zustand（纯 UI 状态：模型未配置横幅 dismiss）
├── theme/          # 主题偏好（system / light / dark）：ThemeProvider + localStorage；
│                    # index.html 内联脚本在 React 挂载前写 <html data-theme> 防闪白
├── router/         # / →/projects；/projects(/new/:id)；/skills；/settings/(model|appearance|projects)；* →404
├── pages/          # Projects / NewProject / Project / Skills / ModelSettings / AppearanceSettings /
│                    # ProjectManagementSettings / NotFound
├── components/     # common（StateViews / ErrorBoundary / RowMenu+InlineConfirm / ThemeControls /
│   │                # ModelCombobox / status 注册表）、layout（AppLayout / SettingsLayout）、
│   │                # project（Badges / ProjectRow / PdfPanel / CitationsPanel / ReviewPanel）
├── constants/      # documentType / targetProfile 建议值（与 Backend 同步）
├── utils/          # errors（错误码 → 中文文案 / 技术细节）、file（PDF 校验 + base64）、format
└── styles/         # tokens（唯一颜色/尺寸来源，含 [data-theme="dark"]）→ base → components → views
```

**状态管理边界**：Server State（projects / project / runs / runtime status）一律
TanStack Query；Zustand 只放跨页面纯 UI 状态，禁止复制 API 数据、禁止巨型 global store。
主题偏好是纯 UI 偏好，允许 localStorage（不是 server state，也不含敏感信息）。

**视觉语言（2026-09-07 重设计）**：档案白纸面 + 墨水靛蓝唯一强调色，状态取铜绿 /
赭石 / 朱砂三种批注色；衬线只用于页面级标题；参考文献编号、页码、序号统一落在左侧
栏位（`.gutter-row`）对齐；不用卡片堆叠、大面积阴影与渐变。深色主题是同一套
语义 token 的完整覆盖（表面 / 线 / 文字 / 状态 / 输入 / 菜单），不是 filter 反色。

**健壮性**：`AppErrorBoundary` 包住路由出口（渲染异常 → 中文提示 + 重新加载 /
返回，开发环境折叠显示详情）；所有主要视图都有 loading / empty / error 三态，
错误码经 `utils/errors.ts` 转成用户文案，技术细节折叠。

### 8.2 前后端边界（M4.0 红线）

- 前端只消费 [API_CONTRACT.md](API_CONTRACT.md) 的 DTO；Pi AgentSession / Pi
  原始 event / AgentRunHandle / WorkflowState 全量不进前端（`api/runs.ts` 显式
  映射为 UI 子集）。
- Runtime Status 消费 Pi schema（runtime/model/agents/sessions，DECISIONS D-0020）；
  顶栏徽标 30s 轮询，
  模型未配置时显示可关闭横幅（Runtime 健康 ≠ 模型就绪）。
- Dev 下 Vite Dev Server（:5173）将 `/api`、`/health` proxy 到 Backend（:3000），
  前端全部同源相对路径（无 CORS）；生产部署形态（Backend 静态托管 dist）M4.8 决策。

### 8.2b 浏览器级验收（e2e/，仅测试工具）

`e2e/` 是独立 npm 包（Playwright），用本机 Chrome（`channel: "chrome"`，不下载浏览器），
也可经 `PAPERTEAM_E2E_CDP_URL` 用 `connectOverCDP` 复用已开 remote-debugging 的浏览器；
端口不硬编码，结束只断开不关用户浏览器。`smoke.spec.ts` 走完整用户路径并自清理，
`visual.spec.ts` 做 4 视口 × 双主题截图与无溢出 / 深色生效断言。CDP 只是开发 / 测试
工具，不进入 Backend 产品代码。

### 8.3 双模式目标（PRD；系统管理后台为 backlog，M5 未含）

- **论文工作台**（普通用户）：My Papers（两类项目）、New Project（两类入口）、
  Workflow 实时视图（M4.4 已实现）、HITL 待办（M4.5）、文献与证据（M4.6
  已实现：证据工作台 tab）、审稿 / Quality Gate（M4.6 已实现门禁面板，
  Draft/Final 标记流 M4.7）、PDF 查看（M4.8）。隐藏 session / agentId /
  runId / Runtime 技术细节，只展示业务阶段与 awaiting_input 待办。
- **系统管理**（管理员）：系统状态、Runtime/模型管理、Workflow 配置、日志、
  系统诊断（backlog，M5 未含，见 M5_PLAN §2）。

实时通信：SSE（WorkflowRun 进度 / Domain Event）；M4.3 起订阅
`GET /api/runs/:runId/events`（replay + 实时 + 心跳 + seq 去重，契约已审计足够）。

## 9. Backend 模块划分

实际结构（2026-09-07）：

```text
backend/src/
├── config/        配置加载与校验（pi / agents / projects / latex / workflow / citation / review / pdf）
├── errors.ts      业务错误模型（稳定错误码 → HTTP 状态码映射）
├── runtime/       AgentRuntime 契约 v2 + PiRuntimeAdapter（sessionKey 派生、角色映射
│   │              pi/roleConfig、版本 pin pi/version）+ statusService（诊断，Pi 形状）
├── project/       ProjectStore（研究定位字段 / 路径安全 / 原子写 + 每项目写队列 /
│                  生命周期）、ProjectImportService（PDF File-First 导入）
├── paper/         PdfParser + pdfToolchain（Python / pymupdf 探测与 stdout JSON 协议）、
│                  sectionChunking（TOC/标题 → sections，标题行锚定的 block 归属 → chunks）、
│                  PaperStore、PaperIngestService、PaperMapService、ReviewContextBuilder、
│                  ReferenceExtractor（IEEE / GB/T 7714 / APA 著录解析）、SectionReviewService
├── workflow/      WorkflowOrchestrator（引擎）、definitions（三条 workflow 的
│                  stage 注册表 + plan/onInput 确定性规划器）、kinds（WorkflowKind 常量）、
│                  runStore（checkpoint 持久化）、eventLog（Domain Event JSONL）、types
├── agents/        ResearcherService、FeasibilityService、ReviewerService（业务角色，
│                  Prompt + 结构化输出校验）、outputParsing（防御性 JSON 提取）
├── writer/        WriterService（M2 完整文档 + M3 大纲 / 分节 / 修订 / 改进计划）
├── evidence/      EvidenceStore（project-scoped JSONL）
├── sources/       SourceStore（文献库）+ PdfAnalyzer（builtin 文本层 + multimodal 扩展点）
├── manuscript/    ManuscriptService（outline / main.tex 组装 / context.yaml）、
│                  LatexFiles（\input 递归收集）
├── citation/      StaticCitationChecker（Layer 1）、metadataProviders（Layer 2：
│                  CrossRef/OpenAlex/arXiv）、CitationService（编排 + 报告）
├── review/        ReviewAggregator（确定性聚合）、finding（ReviewFinding + 枚举常量）、
│                  reviewArtifacts（reviews/ 目录 round 编号与读写，HTTP 与 workflow 共用）
├── settings/      ModelSettingsService / Store / CustomProviderStore（模型偏好、自定义提供商注入 Pi 扩展层、Pi 凭据写路径，Key 不回显）
├── skills/        SkillRegistry / SkillSummaryService / scholarlyTools
├── quality/       gates（Build Gate / Quality Gate 判定器）
├── import/        zipReader（零依赖 ZIP + 防 Zip Slip）、LatexImporter（导入 MVP）
├── serviceStack.ts 服务栈装配（生产与测试共用）
└── httpServer.ts  Node 原生 HTTP：全部 API + SSE
```

## 10. 部署形态

长期运行于 Linux 服务器（推荐 Ubuntu）：

- 服务：PaperTeam Backend（内嵌 Pi Runtime）、Web Frontend、Database
- 依赖：Node.js（根 package.json `engines.node`：`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`）、Git、Python、TeX Live（XeLaTeX/latexmk/Biber）、Poppler
- **后续使用 Docker 容器化部署**（配置位于 `docker/`）
- 用户只访问一个 HTTPS 域名；模型 Provider 凭据经环境变量 / auth.json 配置

## 11. 仓库目录结构

```text
PaperTeam/
├── package.json      # 根开发入口（dev / build / typecheck / test 均覆盖前后端）
├── scripts/dev.mjs   # dev 启动器（Node/依赖检查 → 构建 → 同时启动 Backend + Vite）
├── frontend/         # React Web Workbench（React 19 + Vite，M4；见 §8）
├── backend/          # PaperTeam Backend（API / Workflow / Pi Runtime）
├── agents/           # Agent 定义与配置（预留）
├── docker/           # Docker 部署配置（预留）
└── docs/             # PRD、状态、架构、决策记录、API Contract
```

运行时数据均在仓库外：论文项目 workspace 在 `PROJECTS_ROOT`（默认 backend/projects/），
Pi 配置目录在用户级 `~/.paperteam/runtime/pi/agent/`（见 §6.0），二者均被 .gitignore 排除。


## 12. PDF Review + Citation Integrity + Skill Registry（M4.3 已实现）

### 12.1 数据流（与「长 Session 审稿」的反模式对照）

```text
Final PDF（只读输入）
  → parse_paper_pdf.py（pymupdf 子进程，stdout JSON）
  → 组装（TypeScript 确定性）：pages / sections(TOC>正则>整档) / chunks(页 provenance)
  → 持久化 paper/{source, parsed/*, stages.json}（事实源）
  → PaperMap（导航图 + 单 section 摘要，指纹缓存）
  → ReviewContextBuilder（受控 section context：概览+他节摘要+本节 chunks+引用）
  → 短生命周期 review task（scope review/section/<id>，Session 可丢弃）
  → 引用提取（numeric 展开 / 不猜；citation group 原始标记 rawText 保留）→ metadata 核验（外部学术库，确定性）
  → 句子 → 原子论断拆解（claimDecomposition：结构化模型批量 / 确定性兜底，版本化缓存）
  → (atomic claim, citation group) 语义核验（judge 只见组内合并真实证据；
     组共同支撑、不要求单篇覆盖；CONTRADICTED 需逐字引文；确定性 severity）
  → Citation Integrity 规则并入 QualityGate
```

关键不变量：**其他章节全文绝不进入当前章节上下文**；**Runtime Session 删除后
context 从磁盘确定性重建**；**逐条记录文件持久化 + 指纹跳过**（第 37 条失败
不重做前 36 条）。

### 12.2 失败语义（引用核验）

| 状态 | 含义 | 决定方 |
|---|---|---|
| VERIFIED / METADATA_MISMATCH / AMBIGUOUS | 找到文献 / 字段不符 / 多版本无法唯一 | 确定性代码 + 外部库 |
| NOT_FOUND | ≥2 权威来源检索成功但均无 | 确定性代码（**非模型**） |
| UNRESOLVED | 检索暂时失败（网络/限流/超时） | 确定性代码 |
| probable fabrication | ≥3 全一致 not_found + 零 error + 有可查字段 | 确定性代码（强证据才标） |
| 语义 verdict | SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED / INSUFFICIENT_EVIDENCE / SKIPPED（NO_CONTRADICTION_DETECTED 仅 contradiction_only） | LLM judge（仅凭真实证据；引文逐字校验；UNSUPPORTED 需证据相关且具体；CONTRADICTED 需逐字反向引文；INSUFFICIENT=无法判断≠论文问题，info 不进 Finding） |

### 12.3 Skill Registry

仓库内审计 seed（pin revision + LICENSE + PROVENANCE）→ 启动幂等安装到
`<runtimeRoot>/skills/installed/`（contentHash，变化标 stale）→ 按角色绑定注入
Pi Session（`noSkills + additionalSkillPaths`；progressive disclosure 保持）。
`search_papers`/`lookup_paper` 为 PaperTeam 受控 customTools（researcher/citation
角色），共享 ScholarlyResolver（缓存/重试/telemetry）。写操作（install 等）M5。

## 13. Outer Review Loop：Writer–Reviewer 迭代质量闭环（D-0026）

本章定义 PaperTeam 的核心 Outer Agent Loop——Reviewer 结构化评价驱动的
Iterative Writer–Reviewer Quality Loop。**CURRENT 与 PLANNED 边界（M4.7
更新）**：§13.3-§13.7 描绘的目标架构已于 **M4.7（2026-09-10）全部实现**——
Revision Plan 一等落盘 artifact（`reviews/revision-plan-r{round}.json`）、
CONVERGED / REGRESSION 确定性终止（`hitl.revision_stalled`）、迭代历史
（`reviews/iteration-history.json` + `GET /api/projects/:id/iterations`）、
Draft/Final 产物闭环（§7）。仍未实现的部分（产品 UI 的分数走势图、agent
trace 按轮聚合等）如实标注 PLANNED，不冒充现状。

### 13.1 两层 loop 的边界（架构红线）

PaperTeam 中存在两层性质完全不同的循环，不得混用或互相越权：

```text
Pi Agent Loop（inner，Pi SDK 职责）
  LLM → tool call → tool execution → tool result → LLM → …（直到 settle）
  回答的问题：单个 Agent 如何完成一次任务

PaperTeam Outer Research / Review Loop（outer，WorkflowOrchestrator 职责）
  Writer → Reviewer → Quality Gate → Writer → Reviewer → …（有界）
  回答的问题：多个专业 Agent 如何协作、Workflow 状态如何推进
```

- **PaperTeam 不重新实现 Pi 的 tool-calling agent loop**。单个 Agent 内部的
  推理、工具调用与结果消费完全由 Pi SDK（经 §6.4 Adapter）承担。
- **WorkflowOrchestrator 只负责 outer loop 层面的确定性职责**：角色调用
  （何时调用 Writer / Reviewer / Citation）、状态机与 stage 推进、循环与
  分支、checkpoint / resume、cancel、backpressure、Quality Gate 判定入口、
  artifact 与 version 的关联。它不做内容理解与语义判断（D-0008）。
- Agent 的输出必须落盘为结构化 artifact 并通过 DoD / 结构化校验后才进入
  outer loop 的状态转移（§4.3 红线不变）。

### 13.2 已实现基线（CURRENT：M3.2 bounded revision loop）

共享后段（§3.2）中已实现的审稿-修订闭环：

```text
review.run（fact / academic / style 三路并行，独立 contextScope 会话）
  → ReviewAggregator 确定性聚合 → ReviewSummary（round 编号 + reviewedRevision）
  → quality.gate 确定性判定（9 基础规则 + Citation Integrity 规则）
      + 收敛判定 judgeOutcome（与上一轮 scorecard 对比 → iteration-history）
  → 失败 → revision.plan（确定性派发：critical/major 派发，minor 只记录）
  → revision.revise（Writer 按计划逐节修订，仅动计划指向的章节）
  → 回到 citation.verify → review.run → quality.gate（强制复审，循环）
  → 循环 ≤ maxRevisionRounds（默认 2）+ HITL revise_more（≤3）
  → CONVERGED / REGRESSION / 计划空 → hitl.revision_stalled（两轮记分卡对比）
  → 超限 → hitl.revision_overflow（accept_draft / revise_more / cancel）
  → gate 通过 → build.draft（Build Gate + Draft 冻结；失败 → repair_latex ≤2）
  → build.final（FinalizeService 双 Gate 对齐校验，纯确定性）
```

已按轮落盘的 artifact（round 从 1 递增，「最新」= 编号最大）：

```text
reviews/review-r{round}-{mode}.json     单 lens 结构化结果
reviews/review-summary-r{round}.json    确定性聚合（ReviewSummary）
reviews/quality-gate-r{round}.json      Quality Gate 结果（含 thresholds / rules）
reviews/revision-plan-r{round}.json     确定性修订计划（M4.7，一等 artifact）
reviews/iteration-history.json          每轮 scorecard / outcome / planId（M4.7）
reviews/existing-review-r{round}.json   已有论文只读 Review 聚合（M4.3）
manuscript/revisions.json               不可变修订链（内容哈希幂等，M4.7）
build/build-gate.json                   Build Gate 记录（对齐修订 + 诊断，M4.7）
artifacts/manifest.json + art-*-rev{n}.pdf   Draft / Final 产物（M4.7）
```

循环推进由 `definitions.ts` 的 plan() 纯函数表达，可从 checkpoint 重放；
Quality Gate 的全部规则（9 条基础规则 + Citation Integrity 硬规则）均为确定性
判定，评分只是其中两条——blocking issue、unsupported critical claim、
捏造 / not_found 引用等硬规则不因总分高而豁免。

### 13.3 目标架构（M4.7 已实现）：Iterative Writer–Reviewer Quality Loop

在 13.2 基线之上，把「Quality Gate 失败后的有限 revision」升级为「Reviewer
结构化评价驱动的迭代质量闭环」：

```text
Manuscript vN
  ↓
Review Fan-out（inner stage，有界并发；见 13.9）
  ├─ fact / evidence
  ├─ academic / methodology
  ├─ citation
  └─ style
  ↓
Deterministic Review Aggregation（确定性聚合，无 LLM）
  ↓
Review Scorecard + Findings（13.4）
  ↓
Quality Gate（确定性最终权威，13.4）
  ├─ PASS → Finalization
  │
  └─ FAIL
        ↓
Revision Plan（确定性业务 artifact，13.5）
  ↓
Writer Revision（仅动 Revision Plan 指向的章节）
  ↓
Manuscript vN+1
  ↓
Re-review（必须重新 Review，不自评通过）
  └────────────→ loop（终止条件见 13.6）
```

升级的本质：review 轮次从「修订的附带步骤」变为驱动循环的一等输入——每轮
聚合产物（scorecard + findings）既决定下一轮 Revision Plan 的内容，也参与
终止判定（收敛 / 退化检测），并全部按轮落盘可回放。

### 13.4 Review Scorecard（结构化评价；score 是信号，不是最终权威）

概念上，每轮 Review 产出一张 **Review Scorecard**：多维评价 + 分级问题清单，
而不是一个模糊的 82/100。第一版沿用既有领域模型（`ReviewSummary` /
`ReviewIssue` / fact claims），不新造类型：

| Scorecard 概念 | 既有字段（源码为准） | 状态 |
|---|---|---|
| academic quality | `scores.academicScore` + academic 模式五维分（问题定义 / 方法合理性 / 实验充分性 / 论证逻辑 / 写作质量） | CURRENT |
| fact / evidence reliability | `scores.factVerdicts`（SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED 计数）+ `unsupportedCriticalClaims` | CURRENT |
| citation integrity | CitationReport summary + Citation Integrity 记录（NOT_FOUND ≠ 捏造 ≠ 检索失败） | CURRENT |
| style risk | `scores.styleRisk`（0-100） | CURRENT |
| critical / major / minor findings | `counts.critical / major / minor`、`issues[]`（含 `suggestedAction`） | CURRENT |
| blocking issues | `counts.blocking`、`issue.blocking` | CURRENT |
| affected sections | `issue.section` | CURRENT |
| actionable recommendations | `issue.suggestedAction` | CURRENT |
| 跨轮维度变化（本轮 vs 上轮：哪些问题修复 / 仍存在 / 新增 / 哪些维度退化） | — | PLANNED |

**判定权威**：Quality Gate 仍然是最终确定性权威。score 达标 ≠ PASS——存在
critical factual error、unsupported critical claim、hallucinated / invalid
citation、unresolved blocking issue、target requirement 未满足时，即使总分高
也必须 FAIL（§2.4 / §7，D-0015）。分数与维度评价用于驱动 Revision Plan、
收敛 / 退化检测与用户呈现，不用于豁免硬规则。

### 13.5 Revision Plan（确定性业务 artifact，不新增 Agent）

Revision Plan 是 WorkflowOrchestrator 在 Quality Gate 失败后，根据结构化
Review Findings、Citation 问题与 Quality Gate blockers **确定性生成**的业务
artifact / task contract，交给 Writer 执行：

- 内容：本轮必须处理的问题清单（按章节归属，映射到 Writer 修订目标）、
  对应的 Quality Gate 阻止项、以及「不允许新造文献」等修订纪律。
- **不新增 RevisionPlanner Agent**（D-0009 / D-0026）：Agent Team 保持
  Researcher / Writer / Reviewer / Citation 四角色；planning 是确定性代码的
  职责。未来若确需 LLM 做复杂 revision planning（例如跨章节重构策略），
  再单独做设计决策。
- **CURRENT（M4.7 已一等化）**：`revision.plan` stage 在每轮 gate 失败后
  确定性生成 `reviews/revision-plan-r{round}.json`（planId =
  `plan-r{round}-rev{revision}`，与该轮 scorecard / gate 结果 / 下一轮
  review 关联；iteration 记录回填 planId）；`revision.revise` 以落盘计划为
  准执行（计划文件缺失时回退执行期派生，语义等价）。`GET /api/projects/:id/
  revision-plan?round=N` 可查。

### 13.6 终止语义（有界循环，四态）

Outer loop 不无限循环。终止语义：

| 终止态 | 含义 | 去向 | 状态 |
|---|---|---|---|
| PASS | Quality Gate 通过 | Finalization（双 Gate 通过标记 Final） | CURRENT |
| MAX_ITERATIONS | 达到配置的最大自动迭代轮数 | Human Checkpoint（现有形态：超限 HITL accept_draft / revise_more / cancel） | CURRENT（默认自动修订 ≤2 轮 + revise_more ≤3） |
| CONVERGED | 连续若干轮改善低于合理阈值，继续消耗模型成本价值很低 | Human Checkpoint（呈报收敛证据） | CURRENT（M4.7：失败规则集与上轮完全相同且 critical+major 未下降 → `hitl.revision_stalled`，两轮记分卡对比 payload） |
| REGRESSION | Revision 修复部分问题但导致重要质量维度明显退化 | 停止盲目继续修改；保留 / 恢复较优版本供人工决策 | CURRENT（M4.7：新增 critical / blocking 增加 / blocking 持平但 academicScore 下滑 >10 分 → `hitl.revision_stalled`；判定在 `review/revisionOutcome.ts`，纯确定性） |

CONVERGED / REGRESSION 是在 MAX_ITERATIONS 之前的「更聪明的停止」：前者
省成本，后者防止越修越差。其判定基于跨轮 scorecard / findings 的确定性比较，
具体阈值（连续几轮、改善幅度、哪些维度算「重要」）为 planned / configurable，
在实现前不在文档中伪造具体数值。

### 13.7 版本与可观测性（每轮关联与迭代历史）

每一轮的结果**不覆盖**上一轮，概念上形成交替序列：

```text
Revision 0 → Review 0 →（FAIL）Revision Plan 0 → Revision 1 → Review 1 → …
```

每轮至少可关联（CURRENT 部分已由 round 编号产物 + run stageHistory 天然满足，
PLANNED 部分为一等化查询视图）：

| 关联对象 | 现状 |
|---|---|
| manuscript revision（本轮修订了哪些章节） | CURRENT（stageResults 记录 revised sections + `manuscript/revisions.json` 不可变修订链，M4.7） |
| review result（三 lens 原始结果） | CURRENT（`review-r{round}-{mode}.json`） |
| scorecard（聚合评价） | CURRENT（`review-summary-r{round}.json`） |
| findings（问题清单） | CURRENT（ReviewSummary.issues） |
| revision plan | CURRENT（M4.7：`revision-plan-r{round}.json` 一等 artifact，见 13.5） |
| quality gate result | CURRENT（`quality-gate-r{round}.json`） |
| workflow iteration（第几轮、终止原因） | CURRENT（M4.7：`reviews/iteration-history.json` 一等记录 + `GET /api/projects/:id/iterations`） |
| agent / model execution trace | CURRENT（AgentTask / telemetry）；PLANNED（按轮聚合呈现） |

CURRENT（M4.7 产品 UI，PaperPanel「论文产出」tab）：迭代历史卡逐轮呈现
outcome（首轮 / 有实质改善 / 已通过 / 不再收敛 / 出现退化）与轮次 / 修订对齐；
Draft / Final 卡呈现冻结修订与通过轮次；构建状态卡呈现工具 / 耗时 / 诊断 /
编译日志。PLANNED（后续增强）：轮次分数走势图、跨轮问题修复 / 新增 / 仍存在
明细、每轮 Revision Plan 的 UI 视图。

### 13.8 Session 隔离与恢复（reviewer 上下文纪律）

- Writer 与 Reviewer 是不同专业角色，沿用 `projectId × agentId × contextScope`
  隔离（§6.3，D-0016）；**不在一个 Agent Session 里切换 system prompt 模拟
  多角色**。
- Workspace / manuscript / evidence / review artifacts / workflow checkpoint
  是事实来源（§2.1，D-0013）：Review Loop 必须能在 Runtime Session 丢失后从
  磁盘事实状态恢复（分章节 Review 的「Session 全弃后从磁盘确定性重建」已实证，
  §12.1）。
- **Reviewer 每轮以当前 manuscript + 当前 evidence + 当前 rubric 为评价依据**，
  不依赖「上一轮聊天记忆」才能成立——避免 reviewer anchoring 与不可复现。
  已有论文分章节 Review（D-0024）即按此纪律实现（短生命周期 section task、
  受控上下文、从磁盘重建）。Idea-to-Paper 三路审稿当前按固定 scope
  （`review/fact|academic|style`）复用会话；**是否引入 round-scoped
  sessionKey 属于实现细节，本轮不冻结**（D-0026），冻结前不声称已存在。

### 13.9 Review 并发与 outer loop 的关系（bounded fan-in / out）

并发只发生在 inner review stage，不发生在 outer iteration：

```text
outer loop（串行，按版本顺序）：
  vN review → revision → vN+1 review → …
  下一轮 review 必须以上一轮 revision 的产物为输入，天然不可并行

inner review stage（有界并发 fan-out）：
  不同 section / review lens 并行，bounded concurrency，不是无界 Promise.all
```

CURRENT（已实现）：

- 三路 manuscript review：fact / academic / style 三个固定 lens，各持独立
  contextScope 会话并行（lens 数固定为 3，天然有界）。
- 分章节 Review（existing_paper_review）：`SectionReviewScheduler` +
  `mapWithConcurrency` 有界并发（`PAPERTEAM_REVIEW_CONCURRENCY`，默认 3，
  范围 1-8）；固定 runner 池（任务开始受 limit 约束，具备 backpressure 语义）；
  每节独立 contextScope / Pi session；单节失败隔离（failedSections 继续）；
  节内退避重试；取消信号停止派发并中断在途模型调用；结果按论文顺序确定性
  重排；每节完成即写 per-section journal 供 stage 重试 / 崩溃恢复复用。
  真实 benchmark：review.sections 2.81×、run 总时长 2.61×（默认 C=3，
  见 `docs/REVIEW_PERFORMANCE_PROFILE.md`）。PaperMap 章节摘要同为有界并发
  （`PAPERTEAM_SUMMARY_CONCURRENCY`）。
- Stage 空闲超时（连续无进度才判超时）+ `run.progress` 分节进度快照。

PLANNED（增强方向）：provider / model capacity 感知的动态并发上限、跨 stage
统一的 backpressure 策略、partial progress 的产品化呈现、按轮 review telemetry
聚合（13.7）。
