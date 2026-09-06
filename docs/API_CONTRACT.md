# PaperTeam Frontend API Contract（M4.0）

> 冻结日期：2026-09-04（M4.0）；M4.3 增补 PDF / Citations / Skills 端点（2026-09-06）。
> 本文档是 **React Web Workbench 与 Backend 之间的唯一契约**：
> 前端只依赖本文列出的端点与 DTO，不 import 任何 Backend 内部类型；Backend 内部对象
> （Pi AgentSession / Pi 原始 event / AgentRunHandle / WorkflowState 全量 / Store 实现）
> **不得**直接 JSON serialize 给前端。

## 0. 通用约定

- Base：dev 下前端同源（Vite Dev Server `:5173` 将 `/api`、`/health` proxy 到
  Backend `:3000`，`PAPERTEAM_PORT` 可覆盖）；可用 `VITE_API_BASE_URL` 改写。
- 请求/响应体均为 `application/json; charset=utf-8`（上传类端点为 base64-in-JSON）。
- 统一错误体（Backend `errors.ts` 稳定错误码 → HTTP 状态映射）：

  ```json
  { "status": "error", "error": { "code": "PROJECT_NOT_FOUND", "message": "论文项目不存在：p-x", "detail": "…" } }
  ```

  前端 `ApiError{status, code, message, detail?}`；网络层失败（Backend 未启动）收敛为
  `status=0, code=NETWORK_ERROR`。
- 实时通信：SSE（`GET /api/runs/:runId/events`，Domain Event replay + 实时推送，
  心跳 15s）。事件为 **Workflow Domain Event**（非 Pi Runtime event），M4.3 起消费。
- Runtime Status 为 **Pi schema**：
  `runtime{provider:"pi", phase, version}` + `model{phase, model?, providers}` +
  `agents{roles}` + `sessions{activeRuns, managedSessions}`（DECISIONS D-0020）。

## 1. 端点清单（以源码为准，M4.0 审计结果）

### 1.1 M4.0-M4.2 已消费 ✅

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/projects` | **M4.0 新增**。项目列表，`updatedAt` 降序 → `{projects: ProjectView[]}` | ProjectsPage |
| `GET /api/projects/:id` | 项目详情 → `{project: ProjectView}`；404=PROJECT_NOT_FOUND | ProjectPage |
| `POST /api/projects` | 创建（title 必填 + 可选研究定位字段）→ 201 `{project}` | NewProjectPage |
| `GET /api/runs?projectId=` | 项目 run 列表（Backend 返回 WorkflowState 全量，前端映射为 RunView 子集） | ProjectPage Overview |
| `GET /api/runtime/status` | Pi Runtime 诊断 → `{status: RuntimeStatusView}` | 顶栏 RuntimeStatusChip / 模型横幅 |
| `GET /health` | 存活探针 | （诊断用） |

### 1.2 已存在、后续里程碑消费

| 端点 | 说明 | 计划 |
|---|---|---|
| `POST /api/projects/:id/workflows` | 创建异步 WorkflowRun → 202 `{runId, status, workflowKind}` | M4.3 |
| `GET /api/runs/:runId` | run 状态 / 当前 stage / awaiting 待办 / 错误 / completion | M4.3 |
| `GET /api/runs/:runId/events` | SSE：Domain Event replay + 实时（事件类型见 §3） | M4.3 |
| `POST /api/runs/:runId/resume` | HITL 输入 `{decision, payload?}` | M4.4 |
| `POST /api/runs/:runId/cancel` | 取消 run（Runtime v2 真实取消） | M4.3 |
| `GET/POST /api/projects/:id/sources`、`GET/PATCH/DELETE …/:sid`、`POST …/:sid/analyze` | 文献库 CRUD + PDF 分析 | M4.5 |
| `GET/POST /api/projects/:id/evidence`、`GET …/:eid`、`POST …/:eid/verify` | Evidence CRUD + 核验 | M4.5 |
| `GET /api/projects/:id/feasibility` | 最近可行性报告（HITL 上下文） | M4.4 |
| `GET/POST /api/projects/:id/review`、`POST /api/projects/:id/quality-gate` | 三路审稿 / Quality Gate | M4.6 |
| `POST /api/projects/:id/build` | Build Gate + Draft PDF | M4.7 |
| `GET/POST /api/projects/:id/import` | Existing-LaTeX 导入（archiveBase64 / files） | M4.5 |
| `GET /api/projects/:id/manuscript`、`GET …/context`、`POST …/citation-check`、`GET …/citation-report` | 手稿 / 派生上下文 / 引用核验 | M4.5-M4.7 |
| `PATCH /api/projects/:id` | 更新研究定位字段 | M4.x（编辑表单） |
| `POST /api/projects/:id/generate` | M2 同步生成（保留兼容；前端不使用） | 不消费 |

### 1.2b M4.3 已消费 ✅（PDF / Citations / Skills）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `POST /api/projects/:id/paper/pdf` | 上传 Final PDF（`{fileName, contentBase64}`，≤50MB，%PDF- 校验；sha256 幂等）→ 201 `{document: PaperDocSummary, unchanged}` | ProjectPage「PDF / Structure」 |
| `GET /api/projects/:id/paper` | `{document: PaperDocSummary\|null, sections?, stages?, note?}`（summary 不含 pages/chunks 全文） | ProjectPage「PDF / Structure」 |
| `POST /api/projects/:id/paper/reparse` | 对已落盘原料重跑解析 | （工具 API） |
| `GET /api/projects/:id/paper/chunks?sectionId=` | chunk 明细（每条含 chunkId/pageStart/pageEnd/sectionId/text） | （M4.3.8 review 视图） |
| `GET/POST /api/projects/:id/paper/map` | PaperMap 读取 / 重建（POST body `{refreshSummaries?: boolean}`） | （M4.3.8） |
| `GET /api/projects/:id/paper/review-context?sectionId=[&skill=]` | section review 受控上下文预览（budget 分项） | （M4.3.8 / 诊断） |
| `POST /api/projects/:id/citations/extract` | 引用提取（确定性）→ `{summary{referenceCount,calloutCount}, reused, references, callouts}` | Citations 面板（重新提取） |
| `GET /api/projects/:id/citations` | `{summary: ExtractionSummary, references: ReferenceView[]}` | Citations 面板 |
| `POST /api/projects/:id/citations/verify-metadata` | 真实性核验（外部学术库；逐条文件持久化 + 指纹跳过）→ `{byStatus, checked, reused, telemetry, records}` | Citations 面板 |
| `GET /api/projects/:id/citations/metadata` | `{records: MetadataRecordView[]}`（逐条 status/canonical/mismatches） | Citations 面板（status 列） |
| `POST /api/projects/:id/citations/verify-claims` | (claim,citation) 语义核验（需模型；`{force?, limit?}`） | Citations 面板 |
| `GET /api/projects/:id/citations/claims` / `GET …/integrity` | 语义核验记录 / 完整性汇总（metadata 五态 + semantic verdict 分布 + gate 输入） | Citations 面板 / M4.6 |
| `GET /api/skills` | `{skills: SkillView[], bindings}`（含 pin revision/license/中文简介状态） | SkillsPage |
| `GET /api/skills/:id` | `{skill: SkillView}`；400=不存在 | （详情视图） |
| `POST /api/skills/:id/summary` | 重新生成中文简介（模型未配置 → 400 结构化错误） | SkillsPage |

> M4.3 语义约定（前端依赖的事实）：**NOT_FOUND**（多源一致查无）≠ **UNRESOLVED**
> （检索暂时失败）≠ probable fabrication（≥3 源全一致零 error 才标记）；
> 语义 verdict 六值固定（SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED /
> CONTRADICTED / INSUFFICIENT_EVIDENCE / SKIPPED）；INSUFFICIENT_EVIDENCE 不进入
> 阻断性 gate（人工复核）。Skill 写操作（install/uninstall/update/绑定编辑）为
> M5 范围，本轮无对应端点、前端也不显示假按钮。

### 1.2c M4.3.7.5 已消费 ✅（Model Settings）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/settings/model` | `{settings: ModelSettingsView}`（生效配置/provider/凭据状态/configurationSource/runtimePhase/modelPhase；**永不返回 key 本体**） | ModelSettingsPage「当前状态」 |
| `PUT /api/settings/model` | `{model: "provider/model-id", apiKey?}`（model-id 段可含 `/`，如 `openrouter/anthropic/claude-sonnet-4`；按首个 `/` 拆 provider）；apiKey **字段省略 = 保持原 Key**，空字符串 = 400；成功 → `{settings}` | ModelSettingsPage（Save） |
| `DELETE /api/settings/model/key` | 清除本地保存的 API Key（agentDir auth.json；env 凭据仍在时模型保持 configured）→ `{settings}` | ModelSettingsPage（Clear Key） |
| `GET /api/settings/model/options` | provider 列表 `{providers: [{id,name,authConfigured,apiKeyLoginSupported,modelCount}]}`（安全 metadata，无 baseUrl/key） | Provider 下拉 |
| `GET /api/settings/model/options?provider=x` | 单 provider 模型目录 `{provider, models: [{modelId,displayName,contextWindow?,reasoning?,input?}]}` | Model 下拉 |
| `POST /api/settings/model/test` | Test Connection `{model, apiKey?}` → 200 `{result: {ok,provider,model,latencyMs? \| code,detail?}}`（失败分类：AUTH_FAILED / MODEL_NOT_FOUND / PROVIDER_UNAVAILABLE / RATE_LIMITED / TIMEOUT / UNKNOWN；detail 截断+脱敏） | ModelSettingsPage（Test Connection） |

> M4.3.7.5 安全与语义约定：
> - **Key 只进不出**：apiKey 只经 PUT/test 请求体进入（同源），任何 GET 响应
>   无 key 字段（无 maskedApiKey/last4）；日志不打印请求体。
> - **优先级**：`PAPERTEAM_PI_MODEL` / `PAPERTEAM_PI_API_KEY`（env，含 .env）
>   > Settings UI 保存的本地配置（`<runtimeRoot>/settings/model.json` +
>   `<agentDir>/auth.json`）。env 覆盖时 `configurationSource=environment`、
>   `savedModel` 如实展示本地保存值（保存被允许，env 不存在时生效）。
> - **生效边界**：保存/清除只影响**新的 Agent Run**；在途 run > 0 时返回
>   409 `MODEL_CONFIG_BUSY`（不中断活跃任务），且不落盘（前置空闲检查）。
> - **持久化**：本地配置写在 PaperTeam 用户数据目录（默认 `~/.paperteam`），
>   不进仓库；重启后由启动装配恢复（env 缺省时 stored 生效）。
> - Test Connection 不创建 AgentSession / 不写 Workspace / 不污染会话历史；
>   携带未保存 Key 时经 `options.apiKey` 覆盖式注入（不落盘）。

### 1.3 已知缺口

- **项目删除 / 归档**：Backend 无对应端点（前端不提供该入口，不伪造）。
- **WorkflowRun 跨项目列表 / 分页**：当前无分页参数，项目数大时需要后端扩展。
- **静态资源托管**：Backend 尚未 serve `frontend/dist`（生产部署形态 M4.8 决策）。

## 2. Frontend DTO（frontend/src/types/api.ts）

前端类型与 Backend JSON 逐一对齐；可选字段保持可选，UI 不虚构数据。

```ts
type WorkflowKind   = "idea_to_paper" | "existing_paper_improvement";
type ProjectStatus  = "created" | "generated" | "failed";

// 列表与详情同形（Backend project.json 全量返回）
interface ProjectView {
  id: string; title: string; status: ProjectStatus;
  createdAt: string; updatedAt: string;          // ISO 8601
  workflowKind?: WorkflowKind;                   // 缺省视为 idea_to_paper
  researchIdea?: string; researchField?: string;
  documentType?: string; targetProfile?: string;
  targetVenue?: string; language?: string;
}

interface CreateProjectInput {                   // POST /api/projects 请求体
  title: string;                                 // 必填 ≤200，trim
  workflowKind?: WorkflowKind;
  researchIdea?: string;                         // ≤8000
  researchField?: string;                        // ≤200
  documentType?: string; targetProfile?: string; // 建议值集合（constants/projectMeta.ts）
  targetVenue?: string;                          // ≤300
  language?: string;                             // ≤50
}

type WorkflowRunStatus =
  | "pending" | "running" | "awaiting_input"
  | "completed" | "failed" | "cancelled";

interface WorkflowRunView {                      // WorkflowState → UI 子集（api/runs.ts 映射）
  runId: string; projectId: string;
  workflowKind: WorkflowKind; status: WorkflowRunStatus;
  currentStage?: string;
  createdAt: string; updatedAt: string;
  awaiting?: { stageId: string; prompt: string; options: string[] } | null;
  error?: { code: string; message: string } | null;
  completion?: { label: "final" | "draft" } | null;
}

interface RuntimeStatusView {                    // Pi schema（M3.8 冻结）
  backend: { ok: true };
  runtime: { provider: "pi"; phase: "healthy" | "unhealthy"; version: string; detail: string; latencyMs: number | null };
  model: { phase: "configured" | "not_configured" | "unknown"; model?: string; providers: string[]; detail: string };
  agents: { roles: Array<{ role: string; agentId: string; status: "configured" | "missing" }> };
  sessions: { activeRuns: number; managedSessions: number };
}

// M4.3.7.5 Model Settings（GET 永不返回 key 本体）
type ModelConfigurationSource = "environment" | "stored" | "not_configured";
interface ModelSettingsView {
  provider?: string;                          // 生效模型 provider 段
  modelId?: string;                           // 生效模型 model-id 段（provider 之后整体；可含 "/"，如 openrouter 的 "anthropic/claude-sonnet-4"）
  model?: string;                             // 生效 "provider/model-id"
  savedModel?: string;                        // Settings UI 保存值（env 覆盖时与 model 不同）
  apiKeyConfigured: boolean;                  // provider 有可用凭据（任何来源）
  apiKeySource: "environment" | "stored" | "none";
  configurationSource: ModelConfigurationSource;
  envOverride: boolean;                       // PAPERTEAM_PI_MODEL/API_KEY 任一存在
  runtimePhase: "healthy" | "unhealthy";
  runtimeVersion: string;                     // Pi SDK 精确版本
  modelPhase: "configured" | "not_configured" | "unknown";
  modelDetail: string; detail: string;        // 人读说明（env 覆盖提示）
}
type ModelOptionsView =
  | { providers: Array<{ id: string; name: string; authConfigured: boolean; apiKeyLoginSupported: boolean; modelCount: number }> }
  | { provider: {/* 同上 */}; models: Array<{ modelId: string; displayName: string; contextWindow?: number; reasoning?: boolean; input?: string[] }> };
interface ModelTestResultView {
  ok: boolean; provider: string; model: string;
  latencyMs?: number;                         // ok=true
  code?: "AUTH_FAILED" | "MODEL_NOT_FOUND" | "PROVIDER_UNAVAILABLE" | "RATE_LIMITED" | "TIMEOUT" | "UNKNOWN";  // ok=false
  detail?: string;                            // 截断 + 脱敏（不含 key）
}
```

### 2.1 后续里程碑预留（M4.0 只定义边界，不实现）

- `WorkflowRunDetailView / WorkflowStageView / WorkflowEventView`：M4.3（Live View + SSE）；
  Domain Event 类型见 §3，不透传 Pi 事件。
- `CheckpointView`：M4.4（HITL 配置化：`awaiting{stageId, prompt, options, payload}`）。
- `EvidenceView / SourceView`：M4.5；`ReviewView / QualityGateView`：M4.6；
  `ArtifactView`（Draft/Final PDF）：M4.7。

## 3. Workflow Domain Event（SSE 载荷，M4.3 消费）

`GET /api/runs/:runId/events` 逐条推送（`id: seq`，`event: type`，`data: 全量 JSON`）：

```ts
type WorkflowDomainEventType =
  | "workflow.started" | "stage.started" | "stage.progress" | "stage.completed"
  | "stage.failed" | "workflow.awaiting_input" | "workflow.resumed"
  | "workflow.recovered" | "workflow.cancelled" | "workflow.completed"
  | "workflow.failed" | "quality_gate.passed" | "quality_gate.failed"
  | "build_gate.passed" | "build_gate.failed";

interface WorkflowDomainEvent {
  seq: number;                       // 单调递增，重连去重依据
  type: WorkflowDomainEventType | (string & {});
  runId: string; projectId: string;
  stageId?: string; attempt?: number;
  message?: string;                  // 业务语言（无 sessionKey / token / 本机路径）
  data?: Record<string, unknown>;
  ts: string;
}
```

**结论（M4.0 审计）**：现有 SSE contract（replay + 实时 + 心跳 + seq 去重 +
`workflow.awaiting_input` 携带待办）已足以支撑 M4.3 Workflow Live View 与 M4.4
HITL，无需提前重写事件系统。

## 4. 变更纪律

- 破坏性变更（删字段 / 改语义）必须先改本文档并标注里程碑；
- 新增可选字段向后兼容，可在小版本直接追加；
- Backend `errors.ts` 的错误码是稳定契约，前端按 `code` 分支（如
  `PROJECT_NOT_FOUND` → 「项目不存在」态）。
