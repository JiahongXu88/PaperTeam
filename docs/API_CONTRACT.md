# PaperTeam Frontend API Contract（M4.0）

> 冻结日期：2026-09-04（M4.0）；M4.3 增补 PDF / Citations / Skills 端点（2026-09-06）；
> 2026-09-07 增补 Project Entry & Lifecycle（import-pdf / archive / restore / DELETE / scope / paper-review）；
> 2026-09-07 Hardening：错误码 `NOT_FOUND` / `PDF_PARSE_FAILED` / `PDF_PARSER_UNAVAILABLE`、
> `RuntimeStatusView.tools.pdfParser`、`WorkflowRunView.progress`、`ImportProjectPdfResult.document`（见 §0 / §2）。
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
- 状态码语义（2026-09-07 Hardening）：
  - `404`：项目 / run / Skill / Evidence / 文献不存在（`PROJECT_NOT_FOUND` / `WORKFLOW_NOT_FOUND` / `NOT_FOUND`）；
  - `400 INVALID_REQUEST`：请求体 / 查询参数不合法（含枚举字段非法、base64 字符集非法、可选请求体不是合法 JSON）；
  - `422 PDF_PARSE_FAILED`：PDF 内容无法解析（损坏 / 加密 / 无文本层）；原料已落盘，可重试；
  - `503 PDF_PARSER_UNAVAILABLE`：本机缺少 Python / pymupdf，`message` 含安装命令；
  - `405` + `Allow`：已知路径、方法不对（含 citations / paper 子路径）；
  - `500 INTERNAL_ERROR`：`message` 固定为通用文案，**不透传**内部异常消息与路径（原始错误只进 Backend 日志）。
- 上传请求体上限与文件上限联动：论文 PDF 50MB（请求体 ≈ 67MB），文献 20MB（≈ 28MB）。
- 实时通信：SSE（`GET /api/runs/:runId/events`，Domain Event replay + 实时推送，
  心跳 15s）。事件为 **Workflow Domain Event**（非 Pi Runtime event），M4.3 起消费。
- Runtime Status 为 **Pi schema**：
  `runtime{provider:"pi", phase, version}` + `model{phase, model?, providers}` +
  `agents{roles}` + `sessions{activeRuns, managedSessions}`（DECISIONS D-0020）
  + `tools{pdfParser{phase: "ready"|"unavailable"|"unknown", detail, pythonVersion?, pymupdfVersion?}}`
  （PDF 解析工具链探测；前端据此在导入前提示依赖缺失）。

## 1. 端点清单（以源码为准，M4.0 审计结果）

### 1.1 M4.0-M4.2 已消费 ✅

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/projects` | 项目列表（未归档，`updatedAt` 降序）→ `{projects: ProjectView[], scope:"active"}`；`?scope=archived\|all` 切换范围（2026-09-07） | ProjectsPage / Sidebar 最近项目 |
| `GET /api/projects/:id` | 项目详情 → `{project: ProjectView}`；404=PROJECT_NOT_FOUND | ProjectPage |
| `POST /api/projects` | 创建（title 必填 + 可选研究定位字段）→ 201 `{project}` | NewProjectPage（从研究想法开始） |
| `POST /api/projects/import-pdf` | **2026-09-07**。已有论文 File-First 导入：`{fileName, contentBase64, goal: "review_only"\|"improvement", …研究定位可选字段}` → 201 `{project, document: PaperDocSummary, titleSource: "pdf"\|"filename"}`。Backend 一次完成 建项目→解析→标题（PDF 内标题优先、不可用则文件名兜底）；任一步失败回滚删除项目，不留半成品 | NewProjectPage（导入已有论文） |
| `GET /api/runs?projectId=` | 项目 run 列表（Backend 返回 WorkflowState 全量，前端映射为 RunView 子集） | ProjectPage Overview / ReviewPanel |
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
| `POST /api/projects/:id/paper/reparse` | 对已落盘原料重跑解析（解析器升级后无需重新上传；清空引用 / Review 派生产物）→ `{document}` | ProjectPage「PDF 与结构」（重新解析） |
| `GET /api/projects/:id/paper/chunks?sectionId=` | chunk 明细（每条含 chunkId/pageStart/pageEnd/sectionId/text） | （M4.3.8 review 视图） |
| `GET/POST /api/projects/:id/paper/map` | PaperMap 读取 / 重建（POST body `{refreshSummaries?: boolean}`） | （M4.3.8） |
| `GET /api/projects/:id/paper/review-context?sectionId=[&skill=]` | section review 受控上下文预览（budget 分项） | （M4.3.8 / 诊断） |
| `POST /api/projects/:id/citations/extract` | 引用提取（确定性）→ `{summary{referenceCount,calloutCount}, reused, references, callouts}` | Citations 面板（重新提取） |
| `GET /api/projects/:id/citations` | `{summary: ExtractionSummary, references: ReferenceView[]}` | Citations 面板 |
| `POST /api/projects/:id/citations/verify-metadata` | 真实性核验（外部权威源：学术库 + software 官方仓库；逐条文件持久化 + 指纹跳过）→ `{byStatus, checked, reused, telemetry, profile, records}` | Citations 面板 |
| `GET /api/projects/:id/citations/metadata` | `{records: MetadataRecordView[]}`（逐条 status/kind/canonical/mismatches/attempts/checkedAt/algorithmVersion） | Citations 面板（status 列 + 折叠「核验详情」） |
| `POST /api/projects/:id/citations/verify-claims` | (claim,citation) 语义核验（需模型；`{force?, limit?}`——limit 只约束模型调用，确定性短路不占额度） | Citations 面板 |
| `GET /api/projects/:id/citations/claims` / `GET …/integrity` | 语义核验记录（含 reasonCode 结构化原因）/ 完整性汇总（metadata 六态 + semantic verdict 分布 + gate 输入） | Citations 面板（语义核验明细）/ M4.6 |
| `GET /api/skills` | `{skills: SkillView[], bindings}`（含 pin revision/license/中文简介状态） | SkillsPage |
| `GET /api/skills/:id` | `{skill: SkillView}`；404=NOT_FOUND | （详情视图） |
| `POST /api/skills/:id/summary` | 重新生成中文简介（模型未配置 / 生成失败 → 502 AGENT_RUN_FAILED；摘要服务未装配 → 503） | SkillsPage |

> 2026-09-07 引用核验 v2：PDF 行尾断词编码为软连字符 U+00AD（前端展示时去掉）；
> 检索按 query plan（DOI → 标题 variants）+ 确定性候选打分（DOI / strong / medium tier）；
> metadata 记录带 `algorithmVersion`，版本不一致或 status=UNRESOLVED 的记录下次核验自动重查。
>
> 2026-09-07 引用核验 v3（Review Usability）：条目带 `kind`（scholarly_paper / software /
> dataset / documentation / web_resource / unknown；github/gitlab 链接 → software，经官方
> repository / 文档核验——学术库未收录软件 ≠ 未找到）；查询失败（timeout/429/5xx）终态为
> **PROVIDER_ERROR**（核验暂未完成，不参与 not-found vote，下次自动重试；旧 UNRESOLVED
> 同义）。语义核验记录带结构化 `reasonCode`（NO_EVIDENCE / ABSTRACT_ONLY /
> PROVIDER_ERROR / REFERENCE_UNVERIFIED / …），证据等级新增 repository / official_docs。
>
> M4.3 语义约定（前端依赖的事实）：**NOT_FOUND**（多源一致查无）≠ **PROVIDER_ERROR**
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
| `GET /api/settings/model/options` | provider 列表 `{providers: [{id,name,authConfigured,apiKeyLoginSupported,modelCount,source}]}`（`source: "builtin" \| "custom"`；安全 metadata，无 key） | Provider 搜索选择器（分组：已有凭据 / 自定义 / 常用 / 其他折叠） |
| `GET /api/settings/model/options?provider=x` | 单 provider 模型目录 `{provider, models: [{modelId,displayName,contextWindow?,reasoning?,input?}]}` | Model 下拉 |
| `POST /api/settings/model/test` | Test Connection `{model, apiKey?}` → 200 `{result: {ok,provider,model,latencyMs? \| code,detail?}}`（失败分类：AUTH_FAILED / MODEL_NOT_FOUND / PROVIDER_UNAVAILABLE / RATE_LIMITED / TIMEOUT / UNKNOWN；detail 截断+脱敏） | ModelSettingsPage（Test Connection） |
| `GET /api/settings/model/custom-providers` | 自定义提供商列表 `{providers: CustomProviderView[]}`（配置本体 + `authConfigured`；无 key） | 模型设置「自定义提供商」表 |
| `PUT /api/settings/model/custom-providers/:id` | 新建 / 整体替换 `{provider: CustomProviderInput, apiKey?}`（路径 id 必须等于 `provider.id`；id 与内置 / models.json 提供商冲突 → 400；在途 run → 409 MODEL_CONFIG_BUSY；`headers` 里不允许 Authorization / x-api-key 等认证头）→ `{provider, settings}`；成功后该 provider 立即出现在 `/options` | 自定义提供商表单 |
| `DELETE /api/settings/model/custom-providers/:id` | 删除：从 Runtime 注销 + 删除其 auth.json 凭据 + 若模型偏好指向它则一并清除 → `{settings}`；未知 id → 404 NOT_FOUND | 自定义提供商表（行内确认） |

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

### 1.3 Project Entry & Lifecycle（2026-09-07 已消费 ✅）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `POST /api/projects/:id/workflows` | 创建异步 WorkflowRun `{kind: WorkflowKind, citationSemanticMode?}`（kind 含 `existing_paper_review`）；`citationSemanticMode` 仅 `existing_paper_review` 消费：`"off" \| "contradiction_only" \| "full"`，**缺省 `off`，非法值 → 400**（随 run `request` 持久化；旧 run 无该字段按 `full` 解释）；**已归档项目 → 409 PROJECT_BUSY** → 202 `{runId, status, workflowKind}` | ReviewPanel（开始 Review，高级选项）/ NewProjectPage（导入后自动启动） |
| `POST /api/projects/:id/archive` | 归档项目（幂等）：设 `archivedAt`（独立于 status 的生命周期字段）。**存在 pending/running/awaiting_input run → 409 PROJECT_BUSY**（不静默归档、不自动取消）→ `{project}` | ProjectRow / ProjectPage Header（··· 菜单） |
| `POST /api/projects/:id/restore` | 恢复归档（幂等）：清除 `archivedAt`，项目回到默认列表与最近项目 → `{project}` | Settings → 项目管理 |
| `DELETE /api/projects/:id` | **永久删除整个工作区**（PDF/parsed/citations/reviews/workflow checkpoints/manuscript/build/元数据；并释放 Runtime 内该项目的 idle Agent Session）。前置校验：**必须已归档（否则 409 PROJECT_NOT_ARCHIVED）**、无进行中任务（否则 409 PROJECT_BUSY）→ `{status:"deleted"}` | Settings → 项目管理（输入完整标题确认后） |
| `PATCH /api/projects/:id` | 更新研究定位字段；**title 字段 = 重命名**（PDF metadata 可能识别错误）→ `{project}` | ProjectRow / ProjectPage（编辑标题） |
| `GET /api/projects/:id/paper-review` | 最新快速 Review 聚合报告（`reviews/existing-review-r*.json`，round 最大）→ `{report: ExistingReviewReportView \| null}` | ReviewPanel（审阅报告） |
| `GET /api/projects/:id/paper-review/export.md` | **完整 Review Markdown 报告下载**（与 Web UI 同源结构化数据；不受前端筛选影响）。`Content-Type: text/markdown; charset=utf-8`；`Content-Disposition: attachment`（RFC 5987 UTF-8 filename*，中文标题合法）；无报告 → 404 NOT_FOUND（不导出空文件） | ReviewPanel「导出报告」 |

> 2026-09-07 语义约定：
> - `archivedAt` 是**生命周期**状态，与 `status`（created/generated/failed 业务执行
>   状态）正交；归档项目不出现在默认列表（`GET /api/projects`）与侧栏「最近项目」。
> - `existing_paper_review` 是独立 WorkflowKind（completion label = `review`），
>   走 M4.3 PDF Review Foundation 链路（PaperMap → Citation Integrity →
>   ReviewContextBuilder 分章节 → ReviewFinding → 聚合报告），与旧
>   `POST /api/projects/:id/review`（manuscriptDigest 三路审稿）互不复用。
> - 快速 Review 只读，不修改论文正文；系统性改进（existing_paper_improvement）
>   第一阶段同样是先建立 Review 基线。
>
> 2026-09-08 引用语义核验分层（CitationSemanticMode）：
> - 两层核验中 **Layer 1（引用真实性 / metadata 核验）始终执行，不可关闭**；
>   Layer 2（Claim-Citation 语义核验）按 `citationSemanticMode` 配置：
>   `off`（新 Review 缺省）＝ 不进入 `citation.claims` stage（真实跳过，
>   语义模型调用 0）；`contradiction_only` ＝ 仅检查明显矛盾（judge 只回答
>   `CONTRADICTED / NO_CONTRADICTION_DETECTED`，无证据 → `SKIPPED` 而非
>   `INSUFFICIENT_EVIDENCE`）；`full` ＝ 完整逐条核验（旧行为）。
> - 模式随 run `request` 持久化并写入聚合报告 `citationSemanticMode` 字段；
>   `off` 轮报告不携带 `citationIntegrity.semantic`（历史轮语义记录不污染本轮），
>   Markdown 导出同理（off → 「本轮未开启引用语义核验」）。
> - 兼容默认值分两个方向：**新 run 缺省 `off`**；**旧持久化 run（request 无该
>   字段）解释为 `full`**（旧版本实际始终执行完整语义核验）。
> - Quality Gate：`off` 时语义类规则（`citation_unsupported_critical_zero` 等）
>   不参与判定——不能因「本轮没有 semantic records」FAIL；Layer 1 规则
>   （捏造 / NOT_FOUND / mismatch）不受模式影响。

### 1.4 已知缺口

- **WorkflowRun 跨项目列表 / 分页**：当前无分页参数，项目数大时需要后端扩展。
- **静态资源托管**：Backend 尚未 serve `frontend/dist`（生产部署形态 M4.8 决策）。

## 2. Frontend DTO（frontend/src/types/api.ts）

前端类型与 Backend JSON 逐一对齐；可选字段保持可选，UI 不虚构数据。

```ts
type WorkflowKind   = "idea_to_paper" | "existing_paper_improvement" | "existing_paper_review";
type ProjectStatus  = "created" | "generated" | "failed";

// 列表与详情同形（Backend project.json 全量返回）
interface ProjectView {
  id: string; title: string; status: ProjectStatus;
  createdAt: string; updatedAt: string;          // ISO 8601
  workflowKind?: WorkflowKind;                   // 缺省视为 idea_to_paper
  archivedAt?: string;                           // 生命周期：存在 = 已归档（2026-09-07）
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

// POST /api/projects/import-pdf 请求体（2026-09-07；标题不由用户提供）
// 响应：{ project: ProjectView, document: PaperDocSummary, titleSource: "pdf" | "filename" }
// —— document 与 GET /paper 的 document 同形，前端直接种缓存
interface ImportProjectPdfInput {
  fileName: string;                              // *.pdf ≤50MB
  contentBase64: string;
  goal: "review_only" | "improvement";           // → existing_paper_review / existing_paper_improvement
  researchField?: string; targetVenue?: string;  // 高级选项（全部可缺省）
  targetProfile?: string; language?: string;
}
// 响应：{ project: ProjectView; document: PaperDocSummary; titleSource: "pdf" | "filename" }

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
  completion?: { label: "final" | "draft" | "review" } | null;
  /** 当前 stage 最近一次 stage.progress 快照（如分章节审阅 {section,index,total,findings}；2026-09-07） */
  progress?: { stageId: string; data: Record<string, unknown>; updatedAt: string } | null;
}

// GET /api/projects/:id/paper-review（2026-09-07；2026-09-08 增 citationSemanticMode）
type CitationSemanticMode = "off" | "contradiction_only" | "full";  // 新 run 缺省 off；旧报告缺省视为 full
interface ExistingReviewReportView {
  schemaVersion: number; kind: "existing_paper_review"; round: number; generatedAt: string;
  citationSemanticMode?: CitationSemanticMode;   // 本轮语义核验模式（off 轮不携带 semantic 统计）
  paper: { title: string; pageCount?: number; sections?: number };
  review: {
    sectionsReviewed: number; sectionsTotal: number; skippedSections?: number;
    findingsTotal: number; parseFailures?: number; dropped?: number;
    bySeverity: Record<string, number>; byCategory: Record<string, number>;
  };
  citationIntegrity: { metadataByStatus?: Record<string, number>; semantic?: Record<string, unknown>; probableFabrications?: string[] };
  findings: ReviewFindingView[];                 // 每条含 findingId/category/severity/sectionId?/page?/message/suggestion?/status/source
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
  | { providers: Array<{ id: string; name: string; authConfigured: boolean; apiKeyLoginSupported: boolean; modelCount: number; source: "builtin" | "custom" }> }
  | { provider: {/* 同上 */}; models: Array<{ modelId: string; displayName: string; contextWindow?: number; reasoning?: boolean; input?: string[] }> };
interface CustomProviderInput {                 // PUT /custom-providers/:id 的 provider 字段
  id: string;                                   // ^[a-z0-9][a-z0-9-]{0,39}$
  name: string; baseUrl: string;                // http(s)，无查询串
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  authHeader: boolean;                          // anthropic-messages 下用 Authorization: Bearer 代替 x-api-key
  headers: Record<string, string>;              // 额外请求头（禁止认证头）
  models: Array<{ id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number; input: ("text" | "image")[] }>;
}
type CustomProviderView = CustomProviderInput & { updatedAt: string; authConfigured: boolean };
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
