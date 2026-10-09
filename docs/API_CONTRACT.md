# PaperTeam Frontend API Contract（M4.0）

> 冻结日期：2026-09-04（M4.0）；M4.3 增补 PDF / Citations / Skills 端点（2026-09-06）；
> 2026-09-07 增补 Project Entry & Lifecycle（import-pdf / archive / restore / DELETE / scope / paper-review）；
> 2026-09-07 Hardening：错误码 `NOT_FOUND` / `PDF_PARSE_FAILED` / `PDF_PARSER_UNAVAILABLE`、
> `RuntimeStatusView.tools.pdfParser`、`WorkflowRunView.progress`、`ImportProjectPdfResult.document`（见 §0 / §2）；
> 2026-09-09 M4.4：Workflow Live View 正式消费（§1.4 / §3 增补：`POST /cancel`
> 幂等语义、`stage.progress` 载荷的 `started` / `retried`、`WorkflowRunView` 时间线字段）；
> 2026-09-09 M4.5：HITL 决策正式消费（§1.4 / §2 增补：`POST /resume` decision 契约、
> `awaiting.payload`、stale / 重复提交的 409 语义）；
> 2026-09-10 M4.6：Evidence Workbench + Quality Gate UI 正式消费（§1.2d / §2 增补：
> `GET /api/projects/:id/quality-gate?round=`、Evidence 核验字段、gate / evidence DTO）。
> 2026-09-18 M6.7：Revision Safety（§1.4 增补：`hitl.revision_validation`
> decision 契约 approve / reject / needs_review；revision-plan 条目生命周期字段
> 与 Quality Gate 新规则 `revision_items_resolved` / `claim_strength_guard`；
> `reviews/revision-validation-r{n}.json` 产物随 gate 产物
> `revisionValidation` 字段可见）。
> 2026-10-07 M12 Batch 2：Target Publication（§1.2m target 十端点）与 Visual Review
> （§1.2m visual-reviews + 图资产）正式消费（TargetPanel / ReviewPanel）；错误码新增
> TARGET_PROFILE_CORRUPTED / TARGET_READINESS_CORRUPTED。
> 2026-09-18 M7.0：产品化收口——§1.2 文献库（sources CRUD + import/*）
> 与 `POST …/sources` 前端正式消费（SourcesPanel「文献库」标签页：五种入库
> 方式、幂等与 resolver 结论如实展示；DTO 见 §2 sources 块）；无后端变更。
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
| `POST /api/projects/import-paper` | **M7.0.3（2026-09-19）**。统一导入入口：`{format: "pdf"\|"latex"（缺省 pdf）, …}`。`format=pdf` 与旧 import-pdf 同链路（paper ingest：`{fileName, contentBase64, goal}`）；`format=latex` 走 LatexImporter（`{fileName?, archiveBase64}`，只支持 `goal=improvement`，LaTeX 工程落 manuscript/ 工作树）→ 201 `{project, titleSource: "pdf"\|"latex"\|"filename", document?(pdf), report?(latex: LatexImportReport)}`。标题：PDF 内标题 / 入口 .tex 的 `\title` / 文件名兜底；任一步失败回滚删除项目 | NewProjectPage（导入已有论文：PDF / LaTeX 工程） |
| `POST /api/projects/import-pdf` | **2026-09-07（兼容保留）**。等价于 `import-paper` 的 `format=pdf` 缺省路径；旧请求体（无 format 字段）行为不变 | （历史消费方） |
| `GET /api/projects/:id/manuscript` | `{outline, sections}` + **M7.0.3** `overview`：当前稿件聚合视图（只读，不新增实体）——`{title, titleSource, sourceType: "latex"\|"pdf"\|"generated"\|"none"（由 import-report / parsed document / outline 落盘事实推导）, currentRevision, sectionCount, referenceCount, build: {passed, checkedAt, revision, stale}\|null}`；项目不存在 404 | ProjectPage 概览「当前稿件」卡 |
| `GET /api/runs?projectId=` | 项目 run 列表（Backend 返回 WorkflowState 全量，前端映射为 RunView 子集） | ProjectPage Overview / ReviewPanel |
| `GET /api/runtime/status` | Pi Runtime 诊断 → `{status: RuntimeStatusView}` | 顶栏 RuntimeStatusChip / 模型横幅 |
| `GET /health` | 存活探针 | （诊断用） |

### 1.2 已存在、后续里程碑消费

| 端点 | 说明 | 计划 |
|---|---|---|
| `POST /api/projects/:id/workflows` | 创建异步 WorkflowRun → 202 `{runId, status, workflowKind}` | M4.3 |
| `GET /api/runs/:runId` | run 状态 / 当前 stage / awaiting 待办 / 错误 / completion | M4.3 |
| `GET /api/runs/:runId/events` | SSE：Domain Event replay + 实时（事件类型见 §3）；断线重连后服务端全量 replay，前端按 `seq` 去重 | ✅ M4.4（useWorkflowEvents，页面级订阅） |
| `POST /api/runs/:runId/resume` | HITL 决策 `{decision, payload?}`（仅 `awaiting_input` 可调用）。decision 必须在当前 `awaiting.options` 内，payload 按节点契约：`hitl.feasibility_confirm` 的 `adjust` 需 `targetProfile` 或 `targetVenue`（≥一项）；`hitl.outline_confirm` / `hitl.plan_confirm` 的 `revise` 需非空 `feedback`；`hitl.revision_overflow` 为 `accept_draft` / `revise_more`（无 payload）；`hitl.evidence_supply`（M9.7.4，条件出现：待审候选 ≥3）为 `continue` / `cancel`（无 payload；continue = 以当前已核验证据继续写作，绝不自动 promote 候选）；`cancel` 走 decision 通道留档 `inputs`。成功 → 200 `{run}`（decision=cancel 时终态 cancelled）。**409 WORKFLOW_INVALID_STATE**：非法 decision / 缺 payload / 重复提交（含并发）/ 过期请求（已 resume）；重复 cancel 幂等走 `POST /cancel` | ✅ M4.5（HitlPanel 决策面板） |
| `POST /api/runs/:runId/continue` | 显式从最后一个持久化 checkpoint 继续 `cancelled` run；保留已完成 stage 与结果，仅执行 planner 指向的下一未完成 stage。旧执行循环须已收敛且项目无其他活跃 run。非 cancelled 状态或仍有旧执行未收敛 → 409 `WORKFLOW_INVALID_STATE`；成功 → 200 `{run}` | ✅ M11.4 Review lifecycle recovery |
| `POST /api/runs/:runId/cancel` | 取消 run：立即 abort 在途模型调用（AgentRun / 分章节审阅 / 语义核验 / 引用真实性核验逐条循环），停止派发未开始项，循环检查点终结落盘。**已 cancelled 的重复取消幂等 200**（返回当前状态）；completed / failed → 409 | ✅ M4.4（工作流页「取消任务」） |
| `GET/POST /api/projects/:id/sources`、`GET/PATCH/DELETE …/:sid`、`POST …/:sid/analyze` | 文献库 CRUD + PDF 分析。M6.2 起：重复上传同内容 PDF → 200 `{source, created:false}`（新建 201 `{source, created:true}`，contentHash sha256 判重）；PATCH 增可选 `versionType`（preprint/conference/journal/other）；DELETE 被 Evidence 引用时 **409 SOURCE_IN_USE**；metadata 增可选 `arxivId`/`abstract` | ✅ M7.0（SourcesPanel「文献库」：列表 / PDF 上传） |
| `POST /api/projects/:id/sources/import/{doi\|arxiv\|url\|bibtex}` | M6.2 入库路径：`{doi, sourceRole?, enrich?}` / `{arxivId, sourceRole?, enrich?}` / `{url, title?, sourceRole?}` / `{content, sourceRole?}`。身份归一去重（重复导入 → 200 created:false）；DOI/arXiv 默认经 ScholarlyResolver 补全元数据（`enrich:false` 跳过；未命中如实记录不伪造）；URL 只存 canonical 记录不抓正文；BibTeX 逐条导入（解析错误随响应 errors 返回） | ✅ M7.0（SourcesPanel：DOI / arXiv / URL / BibTeX 四种导入 + resolver 结论展示） |
| `GET/POST /api/projects/:id/sources/candidates`、`DELETE …/candidates/:cid`、`POST …/candidates/:cid/{promote\|reject}` | M6.2 Discovery 候选（≠ 正式文献）：GET 支持 `?status=pending_review/accepted/rejected`；POST 需可判等身份（doi/arxivId/url/title+year+authors 任一组合成键）；promote 幂等（library 已有同身份 → merge 返回既有）；reject 幂等；删候选不影响正式 Source。M8.5 起读写可靠性：全部读-改-写经**项目级互斥**串行（并发保存不丢更新 / 不写坏 JSON）；`candidates.json` 损坏（非法 JSON / 缺 items）→ **500 CANDIDATE_STORE_CORRUPTED**（消息含恢复指引；文件不存在仍是 200 空列表——空 ≠ 损坏），损坏期间写入被拒绝且不覆盖现场 | ✅ M7.1c（DiscoveryPanel「候选文献」：列表 / 状态筛选 / Promote / Reject；M8.5 损坏专用文案） |
| `POST /api/projects/:id/sources/:sid/{enrich\|link}` | M6.2：enrich = resolver 元数据补全（resolved 级 merge，低可信只填空缺）；link = `{targetSourceId, versionType?, targetVersionType?}` 建立同一工作多版本关系（workKey + relatedSourceIds，preprint/正式版保持独立） | M6.2 |
| `POST /api/projects/:id/sources/:sid/vision/analyze` | M10.2 figure 视觉分析触发（body `{force?: boolean}` 可选；缺省后台串行执行逐图增量落盘，`?inline=true` 同步完成返回）：capability 前置判定（显式 visionModel 设置 > 默认模型，唯一依据 Pi 目录 `Model.input` 声明 image input，unknown 保守不可用）→ 逐 figure（PDF 抽图 / 上传图片 / Notebook 图片输出同链）freshness 三键（imageHash+modelSpec+schemaVersion）命中复用不重复调用 → `ModelRuntime.completeSimple` 直接调用（ImageContent；仅 PNG·JPEG；单图 ≤8MB）→ 固定 schema + 服务端校验 + 至多 1 次 repair → FigureAnalysis 落 `sources/analysis/<sid>.vision.json`（status=completed/failed/skipped，十类错误码如实分类）→ 分析后 `retrieval.rebuildSource`（图片条目唯一可检索通道）。200 `{vision: 状态摘要, mode: "background"\|"inline"?, actions?: [{figureBlockId, action: analyzed\|reused\|skipped\|failed}]}`；无解析产物 → 400（先 POST /ingest）；Vision 不可用 → 各图 skipped(model_unavailable)（不是异常） | ✅ M10.2（API / 后续 UI 接入） |
| `GET /api/projects/:id/sources/:sid/vision` | M10.2 分析状态 + 各 figure 摘要（`?facts=true` 附候选事实全量）：`{vision: {sourceId, fileName, document, model: {available, modelSpec?, detail}, figures: [{figureBlockId, analysisId?, status: pending\|completed\|failed\|skipped, assetName?, page?, cellIndex?, outputIndex?, figureType?, description?, candidateFactCount?, facts?, error?, skipReason?, analyzedAt?}], counts, updatedAt?}}`（provenance 为 Parser Fact 拷贝；权威值在 ParsedDocument） | ✅ M10.2 |
| `POST /api/projects/:id/sources/:sid/vision/facts/:factId/evidence` | M10.2 候选事实确认（body `{claim}`）：事实须来自新鲜（sourceContentHash 与当前条目一致）且 completed 的分析；fact 带 value 时 claim 必须提到该值（数值等价，**422 EVIDENCE_VALUE_MISMATCH**）→ Evidence `verificationLevel=user_confirmed` + `verificationStatus=unverified`（模型读值 ≠ 机械验证；无 chunk 锚点 → isFormalEvidence=false → **永不 grounded_verified**，三段核验管道仍是唯一入口）；location 携 `figureBlockId/assetName/bbox?/visionFactRef`。201 `{evidence, fact, analysis}`；事实不存在 / 分析过期 → 404；空 claim → 400 | ✅ M10.2 |
| `POST /api/projects/:id/sources/:sid/resolve-fulltext` | M7.2 全文解析手动触发/重试（对 metadata-only 条目；promote 后已有后台单次尝试，本端点是确定性的重试入口）：resolver 链（Unpaywall(DOI) → OpenAlex oa-url → arXiv PDF；email 未配置则 Unpaywall 不注册）→ 下载（SSRF 逐跳护栏 / ≤20MB / %PDF- 魔数校验）→ **同条目原地挂载**（sourceType→pdf，chunk 锚点链闭合）→ builtin 分析（status→available/partial）→ `retrieval.rebuildSource`。单轮有界尝试（≤3 resolve × 每 URL 一次下载，失败落链内下一 resolver）。200 `{source, outcome: resolved\|not_found\|failed\|skipped_has_file, note?}`（结局是数据不是异常，license/url/resolver/attempts 落 `source.fullText` provenance 可审计）；无 DOI/arXiv 身份（如 Web 候选）→ **422 FULLTEXT_NOT_RESOLVABLE**（确定性不可解析，重试无意义） | ✅ M9.3（SourcesPanel「获取全文」按钮） |
| `POST /api/projects/:id/sources/resolve-fulltext` | M9.3 批量全文解析（product 接线，零新解析器）：`{sourceIds: string[]}`（非空，逐条形如 S001，单次 ≤50；服务层去重保序 + 前置存在性校验——不存在的条目整体 **400 INVALID_REQUEST** 不做半批静默）。逐条走既有 tryResolveFullText，`mapWithConcurrency` 有界并发（`PAPERTEAM_FULLTEXT_BATCH_CONCURRENCY`，默认 3，1–8）；partial success——成功项保留、失败项不回滚任何人。200 `{summary: {total, resolved, notFound, failed, notResolvable, skipped}, results: [{sourceId, outcome, source?, note?}]}`（各桶之和 === total；url-only 等不可解析条目计 notResolvable，不 422）。已有全文条目 skipped（幂等，不重复下载）；缺 sourceIds / 空数组 / 非法形态 → 400；非 POST → 405。同步返回（与 plan/execute 同 HTTP 模型） | ✅ M9.3（SourcesPanel 勾选「批量获取全文」+ summary 呈现） |
| `POST /api/projects/:id/sources/:sid/fulltext` | M9.3 手动 PDF 补挂（自动解析失败的人工 fallback；base64-in-JSON `{fileName, contentBase64}`，`MAX_SOURCE_UPLOAD_BODY_BYTES` 上限）：条目已有文件 → 200 `{outcome: "skipped_has_file"}`（幂等不覆盖）；**`%PDF-` 魔数校验**（内容非 PDF → 400，拒绝时不落文件）→ 既有 `attachFile` 原语（PDF-only 文件名白名单 / ≤20MB / 安全文件名拒路径穿越）→ builtin 分析（失败不回滚挂载）→ provenance `resolver: "manual-upload"`（全文来源可审计，覆盖此前 failed/not_found 记录）→ `retrieval.rebuildSource`。200 `{source, outcome: resolved\|skipped_has_file}`。**不创建 Evidence / 不标 Verified**（上传只声明文件归属）；条目不存在 / 跨项目 → 404 | ✅ M9.3（SourcesPanel 行内「上传 PDF」） |
| `POST /api/projects/:id/research/academic-search` | M6.3 学术发现检索（真关键词 discovery，非标题查证）：`{query, limit?(1-50 默认 10), yearFrom?, yearTo?, openAccessOnly?, saveAsCandidates?: number[]}`。多源聚合（OpenAlex primary / S2 fallback / arXiv preprint / AMiner China-secondary）+ SourceIdentity 去重 + 带权重 RRF 融合 → `{status: success\|partial, results: [{identity, record, citationCount?, openAccess?, score, sources:[{provider,rank}]}], diagnostics, saved?}`。**默认不持久化**；`saveAsCandidates`（结果下标数组）显式写入 CandidateStore（origin=academic_search，provenance 带 query）。单源失败 → partial；全源失败 → 502 SEARCH_ALL_PROVIDERS_FAILED（≠ 空结果）；无任何 provider → 503 SEARCH_PROVIDER_NOT_CONFIGURED。检索结果 ≠ Evidence，永不写 EvidenceStore | ✅ M7.1c（DiscoveryPanel「研究检索」：学术模式 + 年份范围 + saveAsCandidates 显式保存） |
| `POST /api/projects/:id/research/web-search` | M6.3 Web 检索（SearXNG，optional）：`{query, limit?, saveAsCandidates?: number[]}` → 同上结构（results 为 WebSearchResult：url canonical 化 / title / snippet / engines / score）。未配置 SearXNG → 503 SEARCH_PROVIDER_NOT_CONFIGURED（其余能力不受影响）；JSON API 未启用（403）→ 502 附 misconfigured 说明 | ✅ M7.1c（DiscoveryPanel「研究检索」Web 模式） |
| `GET /api/research/providers` | M6.3 Provider Health 观测：`{providers: {academic: ProviderHealthSnapshot[], web: ProviderHealthSnapshot[]}}`（state: healthy/degraded/rate_limited/unavailable + circuit + consecutiveFailures；无 header / key 等敏感信息） | M6.3 |
| `GET /api/projects/:id/research/plan` | M8.1 读取调研产出的检索计划（research.json 的 `plan` 一等字段）：`{plan: ResearchPlan \| null}`。无 research.json 或旧 artifact 无 plan → `plan: null`（空态而非错误）。plan 只是检索意图声明（questions + queries[query/kind/rationale/expectedCoverage/status/resultCount?]），不触碰 Candidate/Source/Evidence 链路 | ✅ M8.1（DiscoveryPanel「Research Plan」查看） |
| `PUT /api/projects/:id/research/plan` | M8.1 受限编辑检索计划：`{questions?: string[], queries?: [{queryId?, query, kind: academic\|web, rationale?, expectedCoverage?, status?: planned\|executed\|skipped}]}`（至少其一；整体替换语义）。同 queryId 条目继承既有 status（缺省时）与 **resultCount（执行回填，编辑面不可写）**；planId/plan.status/createdAt 不变，updatedAt 刷新；旧 artifact 无 plan 时编辑即初始化 draft 计划。校验失败 → 400 INVALID_REQUEST；无 research.json → 404 NOT_FOUND（先运行调研）；非 GET/PUT → 405 | ✅ M8.1（DiscoveryPanel「Research Plan」编辑/保存） |
| `POST /api/projects/:id/research/plan/approve` | M8.2 批准计划（draft → approved，显式 HITL 动作；不自动发生）：200 `{plan}`（status=approved，updatedAt 刷新）。非 draft（approved/executing/done）→ **409 PLAN_INVALID_STATE**；无 research.json / 无 plan 字段 → 404 NOT_FOUND；非 POST → 405 | ✅ M8.2（DiscoveryPanel「批准计划」） |
| `POST /api/projects/:id/research/plan/execute` | M8.2 执行 approved 计划：遍历 plan.queries 中 status=planned 的条目，经 ResearchDiscoveryService（academic/web 按 kind 分派）检索，回填 `status: executed + resultCount`（失败条目保持 planned、error 记入 executionHistory，不中断整轮），plan 流转 executing → done，最小执行记录追加 research.json 顶层可选 `executionHistory`（旧 artifact 兼容；M8.3.1 起条目带 `planId` 归属；M8.5 起成功条目带 `providers` / `resultIdentifiers` 审计字段——见 GET /research/execution-history）。200 `{executionId, totalQueries(plan 全部 query 数), executedQueries, failedQueries, plan}`。**执行不写 Candidate/Source/Evidence、不 prime 检索缓存**（Search Result ≠ Candidate ≠ Literature ≠ Verified Evidence 不变量）。状态不允许（draft/executing/done）→ **409 PLAN_INVALID_STATE**（并发重复执行由进程内守卫同样 409）；无 research.json / 无 plan → 404 NOT_FOUND；非 POST → 405。M8.3.1 起执行/批准/编辑均作用于**活动计划**（activePlanId 指向的条目） | ✅ M8.2（DiscoveryPanel「执行计划」+ 执行结果摘要） |
| `GET /api/projects/:id/research/plans` | M8.3.1 列出研究计划迭代链（research.json 顶层 `plans` + `activePlanId`）：`{plans: ResearchPlan[], activePlanId: string\|null}`（plans 按 iterationNumber 升序；plan 增 `iterationId`（派生链线索 id）/ `parentPlanId?`（派生来源）/ `iterationNumber`（首轮 1，派生 +1））。无 research.json / 无计划 → `{plans: [], activePlanId: null}`（空态而非错误）。旧 artifact（M8.1/M8.2 单一 plan 字段）读取时归一化为单轮链（iterationNumber=1、iterationId=planId） | ✅ M8.3.1（DiscoveryPanel「Research Plan」迭代条 + 查看历史计划） |
| `GET /api/projects/:id/research/execution-history` | M8.5 计划执行审计（executionHistory 只读视图）：`{executionHistory: PlanExecutionEntry[]}`——每条 query 的 `timestamp / kind / query / status / resultCount / error`，M8.5 起成功条目另带 `providers`（provider 参与摘要：谁参与、各自带回多少、是否降级）与 `resultIdentifiers`（结果标识符投影 doi:… / arxiv:… / url / title:…，封顶 50）；**M9.1 起成功条目另带 `resultSnapshot`（有界 SearchResult 快照，Top-10 最小 projection：kind/identity(学术完整保留)/provider/title/authors/year/venue/doi/arxivId/url/snippetPreview(≤300 字符)/citationCount/score）——同为审计痕迹，不进 CandidateStore**（快照 → 候选的唯一路径是显式保存，见下方 save-candidates）。无 research.json / 无历史 → `{executionHistory: []}`（空态而非错误）；旧 history 条目无 M8.5 / M9.1 字段照样返回（可选字段）；非 GET → 405 | ✅ M8.5（DiscoveryPanel「执行审计」折叠块）+ M9.1（快照勾选保存） |
| `POST /api/projects/:id/research/execution-results/save-candidates` | M9.1 执行结果快照 → 候选的显式 HITL 保存（Search Result → Candidate 衔接；plan execution 完成后无需重新检索）：`{executionId, queryId, saveAsCandidates: number[]}`（快照下标，从 0 起；非空整数数组）。按 executionId + queryId 定位 executionHistory 条目，把选中快照经 ResearchDiscoveryService → CandidateStore.add **单一写入口径**落 pending 候选（origin=academic_search/web_search、query provenance、identity 用执行时冻结的归一化身份——元数据不能被调用方按值伪造）。200 `{saved: CandidateSource[], mergedExisting: number[]}`（同身份 pending 候选判重合并，幂等不重复建）。条目不存在 → **404 EXECUTION_ENTRY_NOT_FOUND**；条目 failed / 无快照（M8.5 及更早形态）→ **409 EXECUTION_RESULTS_UNAVAILABLE**（引导用 Discovery 检索面板重新检索后保存）；缺字段 / 空数组 / 越界下标 → 400 INVALID_REQUEST；非 POST → 405 | ✅ M9.1（DiscoveryPanel 执行审计 · 快照勾选「保存选中为候选」） |
| `POST /api/projects/:id/research/plan/:planId/derive` | M8.3.1 从**已完成（done）**的计划派生下一轮（知识缺口 → 调整研究方向 → 新计划）：`{questions?: string[], queries?: [{query, kind: academic\|web, rationale?, expectedCoverage?}]}` 全部可选（缺省整拷来源；不接受 queryId / status → 400）。新计划 status=draft、parentPlanId=来源、iterationNumber=链内最大+1、iterationId 继承、检索条目重置 planned（resultCount 不跨轮继承、queryId 重分配），**自动成为活动计划**；来源计划保持 done 原样不动，链中其余迭代与 executionHistory 不受影响。200 `{plan}`。来源非 done → **409 PLAN_INVALID_STATE**；planId 不存在 / 无计划 / 无 research.json → 404 NOT_FOUND；非 POST → 405 | ✅ M8.3.1（DiscoveryPanel「派生新计划」） |
| `POST /api/projects/:id/research/plan/:planId/activate` | M8.3.1 切换当前活动计划（编辑 / 批准 / 执行均作用于活动计划；查看历史的继续入口）：200 `{plan}`（活动计划视图 `plan` 字段与 `activePlanId` 同步切换）。目标已是活动计划 → 幂等 200 不写盘；planId 不存在 / 无计划 / 无 research.json → 404 NOT_FOUND；非 POST → 405 | ✅ M8.3.1（DiscoveryPanel 历史计划「设为当前」） |
| `GET/POST /api/projects/:id/evidence`、`GET …/:eid`、`POST …/:eid/verify` | Evidence CRUD + 核验 | ✅ M4.6（Evidence Workbench；POST body 增可选核验字段，见 §1.2d） |
| `GET /api/projects/:id/feasibility` | 最近可行性报告（HITL 上下文） | M4.4 |
| `GET/POST /api/projects/:id/review`、`POST /api/projects/:id/quality-gate` | 三路审稿（`POST /review` 由后端编排触发，前端不直接调用）/ Quality Gate 评估 | POST /quality-gate ✅ M4.6（stale 重评）；GET /quality-gate 见 §1.2d ✅ M4.6 |
| `POST /api/projects/:id/build` | Build Gate + Draft PDF | ✅ M4.7（见 §1.2e） |
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
> 语义 verdict 固定（SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED /
> CONTRADICTED / INSUFFICIENT_EVIDENCE / SKIPPED，另有 contradiction_only 专属
> NO_CONTRADICTION_DETECTED）；**记录粒度 = atomic claim × citation group**
> （v4：`referenceIds` 组内共同支撑 + `groupRawText` 原始标记 + `claimIndex` /
> `sourceSentence`；无这些字段的旧记录 = 过期缓存，后端不再返回）；
> INSUFFICIENT_EVIDENCE = 自动核验无法判断（≠ 论文问题，severity=info，
> 不进入阻断性 gate）。Skill 写操作（install/uninstall/update/绑定编辑）为
> M5 范围，本轮无对应端点、前端也不显示假按钮。

### 1.2c M4.3.7.5 已消费 ✅（Model Settings）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/settings/model` | `{settings: ModelSettingsView}`（生效配置/provider/凭据状态/configurationSource/runtimePhase/modelPhase/apiChannel?；**永不返回 key 本体**） | ModelSettingsPage「当前状态」 |
| `PUT /api/settings/model` | `{model: "provider/model-id", apiKey?, agents?, visionModel?, apiChannel?}`（model-id 段可含 `/`，按首个 `/` 拆 provider）；apiKey **字段省略 = 保持原 Key**，空字符串 = 400；`visionModel`（M10.2）= `"provider/model-id"` 显式设置（须目录声明 image input，text-only → 400）/ `null` 清除（回落「默认模型 image-capable 时复用」）/ 字段省略 = 保持现有；`apiChannel`（Z.AI 双通道）= `"coding_plan"`（默认，Pi 内置 Coding endpoint）/ `"general_api"`（按量 endpoint，经 Pi provider baseUrl override）；字段省略 = 保持现有；仅 zai / zai-coding-cn 合法（其他 provider → 400）；切换通道 = Runtime 配置变化（在途 run → 409）；成功 → `{settings}`（含 `vision` 解析视图：source=vision_setting\|default_model\|unavailable + 原因） | ModelSettingsPage（Save + VisionModelPanel + API 通道选择器） |
| `DELETE /api/settings/model/key` | 清除本地保存的 API Key（agentDir auth.json；env 凭据仍在时模型保持 configured）→ `{settings}` | ModelSettingsPage（Clear Key） |
| `GET /api/settings/model/options` | provider 列表 `{providers: [{id,name,authConfigured,apiKeyLoginSupported,apiChannelSupported?,modelCount,source}]}`（`source: "builtin" \| "custom"`；`apiChannelSupported=true` 仅 Z.AI 家族；安全 metadata，无 key） | Provider 搜索选择器（分组：已有凭据 / 自定义 / 常用 / 其他折叠） |
| `GET /api/settings/model/options?provider=x` | 单 provider 模型目录 `{provider, models: [{modelId,displayName,contextWindow?,reasoning?,input?}]}` | Model 下拉 |
| `POST /api/settings/model/test` | Test Connection `{model, apiKey?, apiChannel?}` → 200 `{result: {ok,provider,model,latencyMs? \| code,detail?}}`（失败分类：AUTH_FAILED / MODEL_NOT_FOUND / PROVIDER_UNAVAILABLE / RATE_LIMITED / TIMEOUT / BAD_REQUEST / UNKNOWN；detail 截断+脱敏）。reasoning 由模型 metadata 驱动（不支持 thinking=off 的模型如 GLM-5.3 自动用最低档位 low，不发送 thinking.disabled）；apiChannel 与保存后的真实 Runtime 共用同一 endpoint resolver | ModelSettingsPage（Test Connection） |
| `GET /api/settings/model/custom-providers` | 自定义提供商列表 `{providers: CustomProviderView[]}`（配置本体 + `authConfigured`；无 key） | 模型设置「自定义提供商」表 |
| `POST /api/settings/model/custom-providers` | **新建（M13.4）** `{provider: CustomProviderInput, apiKey?}`；`provider.id` **可为空串 → 服务端自动生成**（名称 slug > baseUrl 主机名 > `custom-provider` 兜底；冲突自动 -2/-3 序号，绝不覆盖已有条目；中文名取可转换片段，纯中文落域名）；`provider.models[].metadataVerified?`（bool，目录/用户确认过的数值）与 `provider.modelsPath?`（发现路径覆盖，如 `/openai/v1/models`）可选 → `{provider, settings}`（provider.id 为生成结果） | 自定义提供商表单（保存新提供商） |
| `POST /api/settings/model/custom-providers/discover-models` | **模型目录发现（M13.4）** `{baseUrl, api?, authHeader?, headers?, modelsPath?, apiKey?, providerId?}` → 200 `{result}`。Backend 代发网关目录请求（规避浏览器 CORS）：路径按 baseUrl 是否以 `/v1` 结尾推导（`/v1/models` ↔ `/models`，**不会拼出 /v1/v1**），404/405 时自动尝试备选（有界 2 个候选、0 次重试）；认证头按协议选择（openai-\* 恒 Bearer；anthropic-messages 按 authHeader：Bearer / x-api-key）；**key 只经请求头，绝不进 URL/日志/返回值**；跨主机重定向一律拒绝（不转发认证头），同主机 http→https 升级最多跟一跳；15s 超时、5MB 响应体上限、500 模型上限。凭据优先级：请求体 apiKey > providerId 的已保存凭据（经 ModelRuntime.getAuth，含 env 内存覆盖层）> 免认证尝试（`authSource: request/stored/none`）。失败分类 `code`：AUTH_FAILED（401/403）/ NOT_SUPPORTED（目录接口 404/405——**≠ 网关不可用**，前端引导手动添加）/ RATE_LIMITED / SERVER_ERROR / TIMEOUT / BAD_RESPONSE / REDIRECTED / NETWORK | 自定义提供商表单「获取可用模型」 |
| `POST /api/settings/model/custom-providers/test` | **保存前测试连接（M13.4）** `{provider, modelId, apiKey?}` → 200 `{result}`（同 `/test` 的 ModelTestResult 形状）。实现：以（生成或既有的）id 临时注册进 ModelRuntime 内存扩展层 → 真实 `completeSimple` 最小调用 → finally 恢复原注册；**失败不留半配置**（不动 credential / custom-providers.json）；apiKey 省略且 providerId 已保存时复用其凭据 | 自定义提供商表单「测试连接」 |
| `PUT /api/settings/model/custom-providers/:id` | 整体替换 `{provider: CustomProviderInput, apiKey?}`（路径 id 必须等于 `provider.id`——编辑时 id 保持不变；id 与内置 / models.json 提供商冲突 → 400；在途 run → 409 MODEL_CONFIG_BUSY；`headers` 里不允许 Authorization / x-api-key 等认证头）→ `{provider, settings}`；成功后该 provider 立即出现在 `/options` | 自定义提供商表单（编辑保存） |
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
> - **Z.AI API 通道**（zai / zai-coding-cn）：Coding Plan = Pi 内置 Coding
>   endpoint（默认，旧 settings 无 `apiChannel` 字段即此通道，向后兼容）；
>   General API（按量）= `https://api.z.ai/api/paas/v4` /
>   `https://open.bigmodel.cn/api/paas/v4`（经 Pi 1.0.1 provider baseUrl
>   override，不 fork / 不改 node_modules）。通道存在 model.json（非
>   secret，provider 级绑定）；API Key 仍只走 auth.json，不复制不迁移。
>   Test Connection 与保存后的真实 Agent Runtime 共用同一 endpoint
>   resolver（不会出现「测试走 A 通道、真实调用走 B 通道」）。
> - Test Connection 不创建 AgentSession / 不写 Workspace / 不污染会话历史；
>   携带未保存 Key 时经 `options.apiKey` 覆盖式注入（不落盘）。

### 1.2d M4.6 已消费 ✅（Evidence Workbench / Quality Gate UI）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/projects/:id/quality-gate` | gate 轮次读取（**只读**，不触发评估）。响应 `{rounds: [{round, passed, checkedAt, blockerCount}]（降序）, round: number\|null, gate: QualityGateResultView\|null, reviewSummary: ReviewSummaryView\|null, latestReviewRound: number\|null, stale: boolean}`。无产物 → rounds=[] / round=null / stale=false（如实空态，不虚构 0/0）。`?round=N` 读历史轮（round 隔离：gate 与其评估时的**同轮** reviewSummary 成对返回，产物结构保证）；非正整数 → 400，未知轮 → 404 | QualityGatePanel（结论 / 阻止项 / 规则 / 轮次切换）/ Overview 质量状态卡 |
| `POST /api/projects/:id/quality-gate` | 确定性评估（既有端点；M4.6 起响应含 `round`）。前端仅在 `stale=true`（gate 轮次落后于最新 review 轮次）时提供「按最新审稿重新评估」 | QualityGatePanel（stale 重评） |
| `GET /api/projects/:id/evidence` | Evidence 列表（一次返回全部字段，前端本地筛选 / 搜索 / 截断，无 N+1） | EvidencePanel |
| `GET /api/projects/:id/evidence/:eid` | 单条详情（provenance 全字段） | EvidencePanel 行内展开 |
| `POST /api/projects/:id/evidence/:eid/verify` | 更新核验状态（既有端点；工作台「确认已核验」= `{verificationStatus:"verified", verificationLevel:"user_confirmed", verificationMethod:"user_confirmed"}`） | EvidencePanel |
| `POST /api/projects/:id/evidence` | 手工登记（既有端点；M4.6 起接受可选核验结论字段 `verificationStatus` / `verificationLevel` / `supportStrength`——人工核对来源后登记可携带结论；非法枚举 → 400） | （API 层；表单 UI 后续里程碑） |

> 2026-09-10 M4.6 语义约定：
> - **PASS/FAIL 只来自后端 `QualityGateResult`**：前端不根据 findings 数量 / 分数 /
>   引用计数自行判定；`rules[].ruleId` 是稳定标识（ruleId → 中文与跳转 tab 的注册表
>   在前端维护，**不做 reason 字符串匹配**）。
> - **轮次隔离**：`quality-gate-r{n}.json` 内嵌评估时的同轮 `reviewSummary`，
>   `GET ?round=N` 成对返回——切历史轮不会混入新审稿分数；`stale` = 最新 review
>   轮次 > gate 轮次（最小口径，无指纹机制）。
> - **快速 Review（existing_paper_review）永不产生 gate**：GET 返回如实空态；
>   前端显示「不运行门禁」说明，Overview 不显示质量卡（避免永久「尚未评估」噪音）。
> - **Evidence 状态枚举**（后端 Domain 枚举不变，前端只做中文标签）：
>   `verificationStatus: unverified \| verified \| plausible \| mismatch \| unverifiable \| not_found`；
>   `supportStrength: direct \| partial \| indirect \| contradictory`；
>   `verificationLevel: abstract \| metadata \| fulltext \| user_confirmed`。
>   mismatch / not_found / unverifiable 与 contradictory 计入「需注意」（警示色），
>   不代表论文错误，不用红色错误样式。
> - **接线修复**：`CITATION_METADATA_ENABLED=0` 现在同时作用于 quick review 的
>   `citation.metadata` stage（空 provider 集 → 逐条 UNRESOLVED，不外呼；
>   显式注入的测试 providers 优先）；`CITATION_METADATA_TIMEOUT_MS` /
>   `CITATION_CONTACT_EMAIL` 一并传入该 resolver。

### 1.2e M4.7 已消费 ✅（Draft / Final 产物闭环）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/projects/:id/artifacts` | 产物清单（不可变 manifest）→ `{artifacts: PaperArtifactView[], latestDraft, latestFinal, currentRevision, finalUpToDate}`；`finalUpToDate=false` = 修订后尚未重新 Finalize | PaperPanel（Draft/Final 卡片 + 产物历史） |
| `GET /api/projects/:id/artifacts/:artifactId` | 单条产物元数据 → `{artifact}`；未知 id → 404 | （API 层） |
| `GET /api/projects/:id/artifacts/:artifactId/download` | **只经 manifest 解析（projectId + artifactId → 受控 artifacts/ 路径），不接受任何文件系统路径参数（防 path traversal）**。缺省 `Content-Disposition: inline`（浏览器原生 viewer 新标签页查看，不落盘）；`?disposition=attachment` 才下载 | PaperPanel「查看」（新标签页）/「下载」 |
| `POST /api/projects/:id/finalize` | 标记 Final（**纯确定性，零 LLM**：FinalizeService 双 Gate 校验——quality gate 与 build gate 必须 PASS 且对齐当前修订）。活跃 run 期间 → 409 PROJECT_BUSY；条件不满足 → 422（`QUALITY_GATE_NOT_PASSED` / `BUILD_GATE_NOT_PASSED` / 结论过期等，message 为可行动中文文案）→ `{final, draft, revision, gateRound}` | PaperPanel「标记为 Final」（按钮永远可点，资格由后端判定） |
| `GET /api/projects/:id/build` | Build Gate 记录 + 新鲜度 → `{build: BuildGateRecordView\|null, currentRevision, stale}`（`stale` = 记录修订 ≠ 当前修订） | PaperPanel 构建状态卡 |
| `POST /api/projects/:id/build` | Build Gate + Draft PDF 冻结（**质量语义不参与 Draft 判定**，D-0015）→ `{revision, build, draftArtifactId, compile}` | PaperPanel「重新构建」（API 层） |
| `GET /api/projects/:id/build/log` | 编译日志尾部（上限字符，错误通常在末尾）→ `{log}` | PaperPanel 构建日志折叠区 |
| `GET /api/projects/:id/revisions` | manuscript 修订事实（Authoritative）→ `{current, revisions: [{revision, stage, runId, createdAt, contentHash}]}` | （审计 / 后续版本管理 UI） |
| `GET /api/projects/:id/iterations` | 修订迭代收敛历史（每轮 gate 的 scorecard / outcome / planId）→ `{iterations: RevisionIterationView[]}` | PaperPanel 迭代历史卡 |
| `GET /api/projects/:id/revision-plan?round=N` | 确定性修订计划（缺省最新轮）→ `{round, plan}`；非正整数 round → 400。M6.7 起 plan.items 为生命周期条目：status ∈ planned(≡pending) / skipped / applied / validated / rejected / needs_review / approved，携带 riskLevel / relatedEvidenceIds / appliedRevision / targetChanged / resolution（机器可读原因码） | （审计 / 后续修订计划 UI） |

> 2026-09-10 M4.7 语义约定：
> - **Draft 语义**：Quality Gate FAIL **不阻塞** Draft——Build 通过即冻结
>   `art-draft-rev{n}.pdf`；UI 文案固定「当前版本可以作为 Draft，但尚未满足
>   Final 要求」，绝不出现「因此 PDF 无法生成」类错误语义。
> - **Final 语义**：双 Gate（quality + build）PASS 且对齐当前修订才冻结
>   `art-final-rev{n}.pdf`；任何改稿动作（revise / repair）使既有结论过期，
>   复审后才能 Final。前端不自行推断资格（无 `if (buildOk && qualityOk)`
>   产生 Final 的路径），finalize 422 拒绝如实呈现。
> - **产物不可变**：Draft/Final PDF 以 revision 编号落盘（rev{n}），重构建 /
>   重冻结产生新文件，不改写历史；manifest 只增不改。
> - **修订 HITL 决策**：`hitl.revision_stalled`（CONVERGED / REGRESSION /
>   计划空）与 `hitl.revision_overflow`（预算耗尽）均为
>   `accept_draft / revise_more / cancel`；`accept_draft` 为用户知情接受
>   （buildOk=false 时如实记录无 PDF）。
> - **修订复核 HITL（M6.7）**：`hitl.revision_validation` 在 Revision
>   Validation 发现风险项（事实漂移 / 引用无依据丢失 / 强 claim 弱证据）时
>   出现（先于复审）；decision 为 `approve`（接受本轮修订，条目 → approved，
>   Revision Gate 规则按用户决策放行并记录在案）/ `reject`（恢复修订前快照
>   ——等价 §1.2f restore 语义：新的不可变修订，历史不改写）/
>   `needs_review`（保留修订但 `revision_items_resolved` 阻断 Final；Draft
>   路径不受阻）/ `cancel`。payload 携带条目明细（id / kind / section /
>   status / reasons）、claimStrength findings、失效证据与无依据删除引用
>   清单。回答新鲜度按 validationId（每轮复核唯一）。

### 1.2f M4.8 已消费 ✅（版本体验：历史 / 比较 / 恢复）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/projects/:id/versions` | 版本历史 → `{current, versions: ManuscriptVersionView[]}`（最新在前）。每条携带 revision / createdAt / source / restoredFrom? / isCurrent / isFinal / hasDraft / review / qualityGate / build / artifacts / revisionPlan / iteration——**修订与 review / gate / 产物的关联只由后端组装**（对齐口径与 FinalizeService 一致），前端不拼装猜测 | VersionHistoryCard（版本时间线） |
| `GET /api/projects/:id/versions/compare?from=N&to=M` | 两修订**确定性比较（零 LLM）**：快照逐文件内容对比（modified / unchanged / added / removed）+ 行级增删规模（LCS，超界退化为行数差）+ 两端 review / gate 记分对照 → `{from, to, sections, summary, reviewDelta}`。from/to 必须是修订编号且互异（400）；任一不存在 → 404 | VersionHistoryCard（版本比较） |
| `POST /api/projects/:id/revisions/:revision/restore` | **恢复历史修订 = 创建新的不可变修订**：后端把 rev{n} 快照复制回工作树并以 `source=revision.restore` + `restoredFrom={n}` 提交新修订；历史修订与旧 Final 产物永不改动，旧 review / gate / build 结论因修订前进自然 stale → `{revision, created, restoredFrom, current}`。活跃 run 期间 → 409 PROJECT_BUSY；修订不存在 → 404；内容与当前一致 → `created=false`（幂等事实，不虚增修订） | VersionHistoryCard「恢复此版本」（行内确认） |

> 2026-09-10 M4.8 语义约定：
> - **版本是论文修订，不是 Git**：用户可见词汇为 修订 / 审阅轮次 / Draft /
>   Final / 质量状态；`source` 为稳定业务动作标识（baseline / outline.plan /
>   writing.sections / review.snapshot / revision.revise / revision.apply /
>   revision.repair_latex / revision.restore），中文标签在前端注册表。
> - **恢复永远不覆盖历史**：恢复 rev2 产生新修订 rev{n+1}，revisions.json
>   只追加；恢复后需重新构建 + 重新审稿才能再次 Final（Finalize 以对齐
>   修订校验，拒绝偷用旧结论）。
> - **列表性能**：versions 只读登记表 / 轮次清单等元数据；快照内容只在
>   compare 与 restore 内部读取。
> - **Existing Paper Improvement 的浏览器可达性**（同一里程碑收口）：
>   PDF 导入（goal=improvement）项目在 `import.parse` 无 main.tex 时由
>   `PaperReconstructor` 确定性重建可修订稿件（outline / sections / bib /
>   组装根；文本级，不含原图）；改进计划 prompt 携带真实章节文件清单。

### 1.2g M5.7 已消费 ✅（Per-Agent 模型配置 / 外部修改意见 / 修订计划展示）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `PUT /api/settings/model`（M5.7 扩展） | 请求体新增可选 `agents?: Record<AgentKey, string \| null>`（键：writer / researcher / academicReviewer / factReviewer / styleReviewer / citationReviewer；值 "provider/model-id" 或 null=继承默认）。**字段省略 = 保持现有 override**（旧客户端兼容）；存在时整体替换；未知键 / 非法规格 / 未知模型 → 400；agents 不含任何 API Key（credential 按 provider 复用）。响应 `settings.agents: AgentModelSettingView[]`（override / overrideProvider / overrideModelId / effective / source / authConfigured） | AgentModelPanel（保存 Agent 配置） |
| `GET /api/settings/model`（M5.7 扩展） | `settings.agents`：六个业务 Agent 的配置视图（继承默认时 `source:"default"`、effective=默认模型；无 key 本体） | AgentModelPanel（继承默认显示实际模型） |
| `GET /api/projects/:id/external-instructions` | 外部修改意见列表 + 涉及章节候选 → `{instructions: ExternalInstructionView[], sectionOptions: string[]}`。ExternalInstructionView：instructionId（幂等指纹）/ source（user \| journal_reviewer \| editor \| advisor \| other）/ reviewerLabel? / text（原文逐字）/ section? / status（pending \| handled \| partially_handled \| unresolved \| conflict，**确定性判定**：handled = 报告 applied 且目标文件真实变化 + gate 复核通过）/ statusNote? / conflictBasis? | ExternalInstructionsPanel（意见列表与状态） |
| `POST /api/projects/:id/external-instructions` | 添加意见 `{source, text, reviewerLabel?, section?}` → `{instruction, instructions}`；text 非空且 ≤8000 字符；同内容幂等指纹重复 → 400；非法 source → 400。意见以 mandatory 进入下一轮 RevisionPlan / revision.apply 派发；**不绕过任何确定性 Gate** | ExternalInstructionsPanel（添加到修改计划） |
| `POST /api/projects/:id/external-instructions/parse`（M11.4） | `{markdown}` 确定性预览 reviewer/editor 标题分段与明确标注的“意见要点”；无法识别结构时整段作为一条；返回 `{comments, sourceBlocks, duplicateBlocks, existingDuplicates}`；不写入数据、不调用模型 | ExternalInstructionsPanel（确认前预览） |
| `POST /api/projects/:id/external-instructions/batch`（M11.4） | `{markdown}` 以同一解析器批量导入；保留顺序、source/reviewerLabel、文本；单次原子写入；现有/同批重复以 `duplicateIds` 报告；成功返回 `{created, duplicateIds, instructions, parsedCount, sourceBlocks, parserDuplicates}`；解析/长度错误时整批拒绝 | ExternalInstructionsPanel（确认后导入） |
| `DELETE /api/projects/:id/external-instructions/:iid` | 删除一条意见（不影响已产生的修订）→ `{instructions}`；不存在 → 404 | ExternalInstructionsPanel（删除，行内确认） |
| `GET /api/projects/:id/revision-plan`（M5.7 起消费） | 最新确定性修订计划（`?round=N` 指定轮）→ `{round, plan}`；plan.items 含 `external_instruction` 条目（priority="mandatory"、source="external"、reviewerLabel / sourceText / instructionId），冲突 / 已处理条目 status="skipped" + note 留档 | RevisionPlanPanel（来源 / 优先级 / 状态展示；conflict / handled 按 instructionId 关联意见活数据） |

> 2026-09-16 M5.7 语义约定：
> - **业务优先级 ≠ 安全优先级**：外部意见 mandatory 决定「优先修改什么」；
>   Fact / Citation Preservation 与 Style Invariant 决定「能不能这样修改」，
>   判定口径完全不变。与实验事实冲突的意见 → `status="conflict"` +
>   conflictBasis（依据），不篡改、不静默忽略。
> - **处理状态不采信模型自称**：handled 需要 Writer 报告 applied（`%%%PT-OUTCOMES%%%`
>   协议）且目标文件真实变化（stage 确定性 diff），随后一轮 gate 的 fact
>   preservation 复核通过（失败自动降级 unresolved 重新派发）。
> - Quick Review（existing_paper_review）不含修订 stage，天然不派发外部意见。
> - SSE 新增 domain event `external_instructions.updated`（revision.apply /
>   revise 派发回写后发出；data: {dispatched, unmatched, conflicts, revision}）。

### 1.2h M6.4 Retrieval API（后端已实现；前端暂无消费方——验收靠 backend + benchmark）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `POST /api/projects/:id/retrieval/search` | 项目文献库全文检索 `{query, topK?(1-50 默认 8), mode?("auto"\|"lexical"\|"hybrid"), filter?{sourceIds?, sourceRole?(evidence\|reference\|both), section?, yearFrom?, yearTo?, sourceType?}, budgetTokens?(1000-24000)}` → `{mode, query, results: RetrievedChunk[], diagnostics, packed?{text, usedTokens, budgetTokens, excluded}}`。RetrievedChunk 含 chunk（chunkId 稳定 / section / page / text / ordinal / contentHash）+ source 摘要 + score（fused 与各通道 rank/score）+ channels。**语义边界：retrieved passages ≠ verified evidence，链路零 EvidenceStore 写入**。索引 lazy + 文献库签名自动增量刷新（新上传下一次检索即生效）；`mode=hybrid` 未配置 EmbeddingProvider → 422 EMBEDDING_UNAVAILABLE（生产默认 lexical-only）；非法 filter → 400 INVALID_RETRIEVAL_FILTER；不存在项目 → 404 | （无——M6.4 不做 RAG UI） |
| `POST /api/projects/:id/retrieval/rebuild` | 强制重建索引。body 带 `sourceId` → 单源重建（无全文 source → 422 SOURCE_NOT_INDEXABLE + reason/note）；空 body → 整库重建 → `{projectId, sources: per-source outcome[{sourceId, status, chunkCount, reason?, note?}], chunks, durationMs}`（单源失败不抛，结构化记录）。Derived State：删除 `sources/chunks/` 全部产物后 rebuild 恢复同等检索结果 | （无） |
| `GET /api/projects/:id/retrieval/stats` | `{mode, sources:{total, indexed, skipped, stale}, chunks, vectors?{provider, identity, dimensions, chunks}, builtAt?}`（vectors 仅配置 EmbeddingProvider 时出现） | （无） |

> 2026-09-17 M6.4 语义约定：
> - 删除正式 Source（`DELETE /api/projects/:id/sources/:sid`）连带检索索引失效
>   （磁盘 chunk 产物 + 进程内索引 + manifest；失效失败不回滚删除，下次加载
>   按孤儿对账自愈）——不存在幽灵命中。
> - `retrieve_library` 是 Agent 侧（Pi customTools，researcher/writer/reviewer
>   三角色）消费同一 RetrievalService 的入口；按会话 projectId 闭包构造，
>   Agent 无法跨项目检索。工具输出带 `packedContext`（token 预算打包 + 
>   `[SRC:… CHUNK:… SECTION:… PAGE:…]` 引用标记）。
> - 错误码新增：SOURCE_NOT_INDEXABLE(422) / RETRIEVAL_NOT_READY(503) /
>   EMBEDDING_UNAVAILABLE(422) / INVALID_RETRIEVAL_FILTER(400)。

### 1.2i M6.5 Evidence Grounding API（后端已实现；前端暂无消费方——验收靠 backend 行为测试）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/projects/:id/evidence/candidates` | 候选队列查询。query：`status?(pending\|verified\|rejected\|mismatch\|unverifiable)` / `sourceId` / `chunkId` / `claimContains` → `{candidates: EvidenceCandidate[]}`（candidateId / sourceId / chunkId / claim / quote / status / proposedBy / statusReason / metadataOutcome / judgeVerdict / judgeReason / evidenceId / createdAt / updatedAt） | （无——M6.5 不做候选 UI） |
| `POST /api/projects/:id/evidence/ground` | 触发核验。body 空 → `groundPending` 批次（`limit?` 正整数，默认 100）→ `{summary:{pending, processed, verified, mismatch, rejected, unverifiable, evidenceAppended, results[]}}`；body 带 `candidateId`（可带 `retry:true` 重试 unverifiable）→ `{result:{candidateId, status, reason?, judgeVerdict?, evidenceId?}, candidate}`。幂等：verified 重复 ground 复用 evidenceId | （无） |

> 2026-09-17 M6.5 语义约定：
> - **Retrieved ≠ Verified ≠ Grounded**：检索（retrieval API）与提案都不产生
>   证据；只有三段核验（quote 逐字 → metadata → 语义 judge）全通过才写
>   EvidenceStore。`POST .../evidence`（既有 legacy 手工登记端点）行为不变，
>   与 grounded 写入并存（createdBy=user 区分）。
> - Agent 侧工具面（Pi customTools）：`get_chunk`（researcher/reviewer/citation）
>   / `propose_evidence`（仅 researcher；只入候选队列）/ `evidence_query`
>   （researcher/writer/reviewer/citation；只读）。**不存在 write_evidence 类
>   工具**——evidence_query 拿 EvidenceReadAccess 只读投影（类型层面无写方法）。
> - idea_to_paper workflow stage 序列变更：`research.idea → evidence.ground →
>   research.feasibility → …`（零候选 no-op；幂等；DoD = 候选队列无 pending）。
> - 错误码新增：INVALID_CHUNK_ID(422) / CHUNK_NOT_FOUND(404) / SOURCE_NOT_FOUND(404)。

> 2026-09-17 M6.6 语义约定（Evidence-aware Writing Loop；无新 HTTP 端点，
> 变更在 Agent 工具视图 / workflow stage 结果 / gate 产物三处）：
> - **Evidence 使用策略**（EvidenceSelectionService，唯一事实源）：正式证据 =
>   `verificationStatus=verified` 且 sourceId + chunkId 锚点齐备；
>   unverified（legacy_unverified）/ plausible / mismatch / unverifiable /
>   not_found 一律不进入 Writer / Reviewer 正式上下文。
> - **evidence_query 工具视图分角色**：writer = **formalOnly**（构造边界强制
>   verified + 锚点过滤——运行期显式传其他 status 也不放宽，payload 带
>   note 说明）；researcher / reviewer / citation 保持全量查询（判定口径
>   由 prompt 约束「只有 verified 可作 SUPPORTED 依据」）。工具参数面不变。
> - **workflow stage 结果新增字段**：`review.run` 与 `writing.sections` 的
>   stage result 携带 `evidenceFormal`（进入正式上下文的条数）与
>   `evidenceExcluded: {legacyUnverified, untrusted, verifiedMissingAnchor}`
>   （排除分类计数）。
> - **Quality Gate 新规则** `citations_evidence_backed`（规则 16）：输入为
>   `evidenceCitationCoverage`（cited keys ↔ formal evidence 覆盖；匹配 =
>   DOI 精确 / 归一化 title+年份，与 Writer digest 的 bib key 关联同源）。
>   **默认呈现不阻断**（detail 含未覆盖 key 计数）；threshold
>   `requireEvidenceBackedCitations=true` 时未覆盖引用阻断 Final。覆盖明细
>   （covered / uncovered / byKey）随 `quality-gate-r{n}.json` 落盘
>   （M4.6 起的 gate 读取端点透传可见）。
> - **legacy 兼容**：既有 `POST .../evidence`（手工登记）行为不变；legacy
>   unverified 记录保留在库（evidence list/stats 端点可见），只是不再自动
>   进入写作 / 审稿上下文与 writer 工具视野（收口属 M6.7）。

### 1.2j M11.1.1 Survey Matrix / Candidate 批量入选 API（后端已实现；前端暂无消费方——验收靠 backend 行为测试）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/projects/:id/survey/corpus` | M11.3（Phase C）：读研究语料快照（`research/corpus-snapshot.json`）。200 `{snapshot: CorpusSnapshotArtifact \| null}`——未冻结 = null（首次 survey.fulltext 完成时创建）。artifact：`{schemaVersion:1, revision（0=首次冻结，显式 refresh +1）, createdAt, updatedAt, fingerprint（sources 行内容 sha256 前 16 位，基线变化的确定性信号）, counts:{total, hasFulltext, fulltextBasis, abstractBasis}, sources:[{sourceId, status, hasFulltext（磁盘事实）, basisDepth（研究基线事实=matrix interpretationDepth；null=matrix 未构建）}]}`。文件损坏 / 未来 schemaVersion → **500 CORPUS_SNAPSHOT_CORRUPTED**（不降级解读）。快照在时普通 resume 的 survey.fulltext 是确定性 no-op（不重试全文解析——resume ≠ refresh corpus） | （暂无——主动 Refresh UI 后置，Known Limitations 已登记） |
| `POST /api/projects/:id/survey/corpus/refresh` | M11.3（Phase C）：显式补齐缺失全文（refresh_missing_fulltext）。只处理快照中无全文文件的源（resolveFullTextBatch + 结构化解析），随后失效 matrix 可升级条目（源已有全文而条目仍 abstract_only → 下次 buildMatrix 按 fulltext 重建 → matrix 指纹变化 → Synthesis/Outline 按既有 staleness 链重算），快照 revision+1、指纹重算（语料变而指纹不变是被禁止的）。200 `{outcome:{attempted, resolved, stillMissing, invalidatedMatrixEntries, revision, fingerprint, fingerprintChanged}}`；未冻结 → **400 INVALID_REQUEST**（先完成一次 survey.fulltext 形成基线）；非 POST → 405 | （暂无——同上） |
| `GET /api/projects/:id/survey/matrix` | 读 Survey Matrix artifact（`research/survey.json`；Research 阶段派生产物，≠ Verified Evidence）。200 `{matrix: SurveyMatrixArtifact \| null}`——未构建 = null（空态而非错误）；文件损坏 / 未来 schemaVersion → **500 SURVEY_MATRIX_CORRUPTED**（含恢复指引；损坏期间 build / PUT 被拒绝，不覆盖现场）。artifact：`{schemaVersion:1, updatedAt, taxonomy:{families:[{label, description, subFamilies?}]}, entries: SurveyMatrixEntry[]}`（entries 按 sourceId 升序；entryId=`M-<sourceId>` 确定性派生，dedup 键 = sourceId）。entry 携带 `interpretationDepth(fulltext\|abstract_only)` / `researchProblem / methodFamily / subFamily / mainIdea / keyTechnique / assumption / datasetContext / strength / limitation / comparedMethods / keyFindings / anchors / status(draft\|confirmed) / issues / taskId / updatedAt`；citationKey **不落盘**（使用点经 M9.5 确定性 bibliography 管道按 sourceId 解析） | （无——M11.1.1 不做 Survey UI） |
| `POST /api/projects/:id/survey/matrix/build` | 构建 / 增量构建。body 全可选：`{sourceIds?: string[]（形如 S001；须存在且非 reference / rejected，否则 400 列明）, taxonomy?: {families:[{label, description, subFamilies?}]}（覆盖受控词表；既有条目标签失效 → unclassified + issue，不静默丢弃）, force?: boolean（重算已有条目，缺省跳过）}`。逐篇抽取走既有 researcher 角色（contextScope=`research/survey-matrix`，roleConfig 前缀规则天然映射，零新 Agent）：fulltext（status=available/partial）→ RetrievalService 单篇检索（CHUNK 标记进 prompt）→ 结构化 JSON → 确定性校验 → anchors 经 ChunkAccess fail-closed 核验（chunk 存在 + 属本 source）；abstract_only → 元数据/摘要有限归类（评价性字段剥离、anchors 强制清空）。**partial success**：单篇失败是数据不是异常。200 `{summary:{total, built, skippedExisting, failed, removedOrphans}, results:[{sourceId, outcome: built\|skipped_existing\|failed, entry?, error?}], matrix}`（已有 entry 不重复构建；失败篇目下次 build 自动重试；source 已删的孤儿条目清理；force 重算失败保留旧条目）。taxonomy 非法 / sourceIds 空或非法 → 400；非 POST → 405 | （无） |
| `PUT /api/projects/:id/survey/matrix/:entryId` | HITL 修正单条（entryId 形如 M-S001）。body 全可选（present-but-empty 字符串 = 清空该字段）：`{researchProblem? / methodFamily? / subFamily? / mainIdea? / keyTechnique? / assumption? / datasetContext? / strength? / limitation?（≤300 字符，超长 400 不静默截断）, comparedMethods?: string[]（归一去重）, keyFindings?: string[]（≤3 条，超限 400）, anchors?: [{field: mainIdea\|keyTechnique\|strength\|limitation\|keyFindings\|datasetContext, chunkIds: string[], evidenceIds?: string[]}]（整体替换；chunkId 须存在且属本 source、evidenceId 须存在且指向本 source，任一非法 400）, status?: draft\|confirmed}`。methodFamily 只接受 taxonomy 表内标签或 `unclassified`（非法 400 列出合法集）；subFamily 须在所属 family 的 subFamilies 内；已确认条目被修改内容字段 → 自动回退 draft（重新走确认）。矩阵未构建 → 404；条目不存在 → 404。200 `{entry}` | （无） |
| `POST /api/projects/:id/sources/candidates/promote-batch` | M11.1.1 Candidate 批量入选（Survey corpus）：`{candidateIds: string[]（非空，单次 ≤50，重复 id 去重保序）, sourceRole?, selectionReason?: string（批级入选理由，如 seminal work / opposing approach；落盘到各候选的扁平 provenance 字段）}`。逐条**复用**单条 promoteCandidate 全部逻辑（身份去重 / 幂等 / 全文后台尝试），零逻辑复制；partial success——200 `{summary:{total, promoted, alreadyExists, failed}, results:[{candidateId, outcome: promoted\|already_exists\|failed, source?, candidate?, error?}]}`（promoted=新建入库；already_exists=幂等重入 / 同身份既有条目；failed=该条失败不回滚任何人）。缺字段 / 空数组 / 超 50 / 含非字符串 → 400 INVALID_REQUEST；非 POST → 405。单条 `POST …/candidates/:cid/promote` 同步支持可选 `selectionReason` | （无） |

> 2026-10-02 M11.1.1 语义约定：
> - **Survey Matrix ≠ Verified Evidence**：Matrix 是 per-paper 结构化理解
>   （Research 阶段派生产物），不写 EvidenceStore、不改 EvidenceRecord
>   「单源、单锚点、verified」语义；Matrix anchors 只承载 chunk 引用，
>   `evidenceIds` 仅 HITL 路径可携带并核验存在——LLM 无权自报 grounded，
>   synthesis groundingLevel 判定属 M11.1.2。
> - **abstract_only 诚实降级**：无全文条目（metadata_only / pending /
>   failed）允许 taxonomy 初步归类与描述性字段；strength / limitation /
>   keyFindings 强制剥离（评价性字段需全文依据）、anchors 强制清空
>   （不伪造 chunk / evidence 锚点、不绕过 abstract 不进检索链的限制）。
> - **taxonomy fail-closed**：模型输出的 methodFamily 不在受控词表内 →
>   `unclassified` + issue 记录原始提案（进 HITL 修正队列），绝不静默
>   扩表；缺省最小词表内置于 `matrixTypes.ts`，build 时可提供 / 覆盖。
> - **错误码新增**：SURVEY_MATRIX_CORRUPTED(500)。
> - **尚缺（勿提前宣称）**：Structured Synthesis（M11.1.2）/ Survey
>   Outline 契约 / Survey Writing / Review / Revision / PDF。

### 1.2k M11.1.2 Survey Synthesis API（后端已实现；前端暂无消费方）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/projects/:id/survey/synthesis` | 读 Structured Synthesis artifact（`research/survey-synthesis.json`；与 survey.json 同级的 Research 阶段派生产物）。200 `{synthesis: SurveySynthesisArtifact \| null}`——未构建 = null；文件损坏 / 未来 schemaVersion → **500 SURVEY_SYNTHESIS_CORRUPTED**。artifact：`{schemaVersion:1, updatedAt, matrixFingerprint, items: SurveySynthesisItem[]}`（items 按 synthesisId 升序）。item：`{synthesisId: "SYN-<hash10>"（确定性纯函数，同输入恒同值）, kind: taxonomy\|trend\|comparison\|consensus\|disagreement\|research_gap\|future_direction, claim, groundingLevel: evidence_backed\|literature_cited\|speculative（**只由代码判定**，模型自报字段被结构性丢弃）, evidenceIds, sourceIds（从 derivedFrom.entryIds 派生，模型无权声明）, derivedFrom:{entryIds}, detail?（kind 判别联合）, groundingReason?, taskId?, updatedAt}` | （无——Survey UI 属 M11.1.3+） |
| `POST /api/projects/:id/survey/synthesis/build` | 基于 Matrix 快照**全量重建**。body 全可选：`{kinds?: SurveySynthesisKind[]（非空子集，非法值 400；缺省全部七类）, force?: boolean（Matrix 指纹未变也重建；缺省指纹未变直接复用既有 artifact，零 LLM 调用）}`。前置：Matrix 必须已构建（否则 400 提示先跑 matrix build）。执行链：taxonomy 确定性聚合（零 LLM）→ 其余六类 bounded batch（trend/comparison/consensus/disagreement 按 family 分组、gap/future 全局单批）→ researcher（contextScope=`research/survey-synthesis`，零新 Agent）→ candidate parse（模型自报 grounding 字段丢弃）→ 引用 fail-closed 核验 → evidence proposals 走 EvidenceGroundingService 三段真实核验 → `deriveGroundingLevel` 确定性判定 → 确定性 dedup → 原子落盘。200 `{summary:{matrixEntries, matrixFingerprint, reused, batches, candidates, accepted, rejected, byKind, evidenceProposed, evidenceVerified}, rejections:[{kind, claim, reason}], synthesis}`。kinds 空数组 / 含非法值 → 400；非 POST → 405 | （无） |

> 2026-10-02 M11.1.2 语义约定：
> - **groundingLevel 判定权只在代码**：`groundingRules.deriveGroundingLevel`
>   纯函数；taxonomy / research_gap 恒 literature_cited；future_direction
>   `origin=inferred` 一律 speculative（硬规则，不进核验管道）；通用
>   evidence 阈值 = ≥2 verified evidence 且 ≥2 不同来源；consensus ≥3
>   来源才可 evidence_backed（2 来源 = observed agreement 封顶
>   literature_cited）；disagreement 双侧可靠锚点 + 每侧 ≥1 verified 才
>   evidence_backed（单侧弱锚 → literature_cited，双侧弱锚 → speculative）。
> - **Evidence 语义不变**：synthesis 经 evidenceIds[] 引用多个**独立**
>   verified EvidenceRecord（单源单锚点），不创建 multi-source 记录；
>   chunkId 存在 ≠ verified（必须过 quote 逐字 → metadata → judge 三段）。
> - **引用 fail-closed**：sourceIds 从 entryIds 派生（模型无权声明）；
>   不存在的 entryId 剔除；comparison / disagreement 剔后单侧空 → 整条
>   拒绝；trend/consensus/disagreement 最低来源数不达 → 拒绝；
>   research_gap trigger 白名单（literature_limitation / taxonomy_empty /
>   coverage_missing）外 → parse 期拒绝。拒绝账目随 build 返回。
> - **synthesis 级 HITL 编辑（PUT …/synthesis/:synthesisId）**：本阶段
>   未实现（按范围裁决留给 M11.1.3/1.4）。
> - **错误码新增**：SURVEY_SYNTHESIS_CORRUPTED(500)。
> - **当时尚缺**：Survey Outline 契约（→ M11.1.3 已完成，见下）。

### 1.2l M11.1.3 Survey Outline API（后端已实现；前端暂无消费方）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `POST /api/projects/:id/survey/outline/build` | Structured Synthesis → Survey Outline 并落盘 `manuscript/outline.json`（**复用既有 Manuscript outline artifact**，section 携带可选 `synthesisRefs` / `literatureRefs`；读取走既有 `GET /:id/manuscript` 的 outline 字段，无平行存储）。body：`{feedback?: string（HITL 修订意见，透传 planner）}`。前置 fail-closed：未构建 Matrix → 400（指引 matrix build）；未构建 Synthesis → 400（指引 synthesis build）；synthesis 过期（matrixFingerprint ≠ 当前 Matrix）→ 400（指引先重建 synthesis）；Matrix 为空 → 400。执行链：digest 投影（七类 synthesis + 文献清单 + 覆盖统计；不塞 chunk / EvidenceRecord）→ WriterService.planOutline survey 模式（`writing/outline`，零新 Agent；结构化输出内部有界修复）→ `validateSurveyOutline` 确定性契约校验 → blocking 非空则校验错误作为 feedback 重规划（≤2 次）→ 仍失败 **422 SURVEY_OUTLINE_INVALID（不落盘，不伪造默认结构）** → 通过则 saveOutline（refs trim+去重+升序归一）。200 `{outline（含 refs）, validation:{blocking:[], warnings:[…], summary:{sections:{total,framing,future,gap,core}, synthesisCoverage, literatureCoverage}}, summary:{matrixEntries, synthesisItems, sections, planningAttempts, repair?}}`。非 POST → 405 | （无——Survey UI 属 M11.1.4+） |

> 2026-10-03 M11.1.3 语义约定：
> - **Outline 是组织层**：章节结构只能来自七类 synthesis；planner 不得发明
>   taxonomy / gap / consensus / future、不得新增 literature。每个核心正文
>   section 必须携带 `synthesisRefs`（消费的 synthesisId，逐字复制 digest）
>   与 `literatureRefs`（覆盖的 entryId）；Introduction / Conclusion 等
>   framing 章节可豁免。
> - **grounding 消费规则（validateSurveyOutline 锁死）**：speculative
>   （含 inferred future）**只能被展望语境章节消费**——绑到 taxonomy /
>   trend / comparison / consensus / framing / gap 章节 = blocking；gap
>   章节只能消费 research_gap synthesis；future 章节必须消费
>   future_direction（可叠加 research_gap；混入其它 kind → warning 保持
>   grounding / speculation 区分可见）。literature_cited 进入 Outline 不
>   自动升级。
> - **paper-by-paper 退化判定**（blocking）：文献 ≥5 且 ≥3 个正文节各只挂
>   1 篇文献且 ≥50% 正文节如此；<5 篇不判（小 corpus 逐篇结构可能是真实的）。
> - **悬空引用**（blocking）：synthesisRefs / literatureRefs 必须存在于
>   当前 synthesis artifact / Matrix（模型幻觉 id 一律拒绝）。
> - **warnings（可见不阻断）**：family 失衡 ≥60% / unclassified / 
>   abstract_only ≥50% / literatureRefs 覆盖 <50% / 分类章节未绑 taxonomy
>   synthesis / 展望章节混入非 future/gap synthesis / 单一年份 corpus——
>   平衡类问题不硬性拒绝（「某 family 60%」不自动等于结构失当）。
> - **HITL**：workflow `hitl.outline_confirm` payload sections 现携带
>   synthesisRefs / literatureRefs（普通论文无 refs 时 payload 形状不变）；
>   revise = feedback 重规划后重新校验。
> - **兼容性**：普通论文 outline（无 refs）完全兼容；refs 字段只在 survey
>   构建路径产生与解析（普通路径模型输出中的 refs 被忽略）。
> - **错误码新增**：SURVEY_OUTLINE_INVALID(422)。
> - **尚缺（勿提前宣称）**：Workflow Integration（M11.1.4）/ Survey
>   Writing E2E（M11.2）/ Review / Real Acceptance（M11.3）。

### 1.2m M12 Batch 2 Target Publication / Visual Review API（已实现；TargetPanel / ReviewPanel 正式消费 ✅）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `GET /api/projects/:id/target/benchmark` | M12.1 A5：读冻结的 benchmark 语料（`research/target-benchmark.json`）。200 `{benchmark: TargetBenchmarkArtifact \| null}`——未冻结 = null（非 404）；损坏 → **500 TARGET_BENCHMARK_CORRUPTED**。artifact 见 Batch 1（schemaVersion/revision/fingerprint/target/papers/selection?/confirmedAt?；papers 恒 sourceRole=reference） | TargetPanel |
| `POST /api/projects/:id/target/benchmark/discover` | M12.1 A6 一键发现+冻结：`{targetCount?（1–100 整数，缺省 12）}`；target 由 ProjectMetadata 组装（documentType/targetProfile/targetVenue/researchField）。200 `{revision, papers（有效条目数）, savedSourceIds（数）, venueDegraded, sufficiency, requiresAttention, alreadyFrozen}`。缺 researchField / 非法 targetCount → **400 INVALID_REQUEST**（repo 口径） | TargetPanel「发现 Benchmark」 |
| `POST /api/projects/:id/target/benchmark/refresh` | 显式 refresh：重发现+重选 → 与当前冻结**指纹不同才 revision+1**（相同幂等返回 changed=false，不空转）。200 `{benchmark, changed}`；未冻结 → 400 | TargetPanel「重新发现」 |
| `POST /api/projects/:id/target/benchmark/papers` | 追加单篇：`{sourceId（必填，须已以 role=reference 入库）, citationCount?, venueRaw?, inclusionReason?}` → `benchmark.addPaper`（幂等；revision+1） | TargetPanel |
| `POST /api/projects/:id/target/benchmark/papers/:sid/exclude` | 剔除：`{reason（非空 ≤500 字）}` → 同 revision 剔除标记（指纹重算）；条目不存在 → 404 | TargetPanel |
| `POST /api/projects/:id/target/benchmark/confirm` | HITL 确认审计标记（幂等，首次写 confirmedAt）→ `{benchmark}` | TargetPanel |
| `GET /api/projects/:id/target/profile` | M12.1 A7：`{profile: TargetPublicationProfile \| null, fresh: boolean \| null, staleReason?}`——未生成 = `{profile:null, fresh:null}`；损坏 → **500 TARGET_PROFILE_CORRUPTED**。profile：`{schemaVersion:1, benchmarkRevision, corpusFingerprint, extractorSchemaVersion, n, dimensions:{structure/literature/experiments/visuals/method/writing 各含 availability(available\|unavailable\|insufficient)+coverage+reason? + 维度专属分位带 Distribution{n,min,p25,median,p75,max}…}, provenance:{deterministicFields, modelSummarizedFields, model?, summaryFailure?}, generatedAt, notes}`（freshness 三键任一不符 → fresh:false + staleReason，陈旧不被静默消费） | TargetPanel Profile 区 |
| `POST /api/projects/:id/target/profile/regenerate` | ensureCurrent（缺失/陈旧才重建；含 ≤2 次摘要模型调用）→ `{profile}`；未冻结 benchmark → 404 | TargetPanel「重建」 |
| `GET /api/projects/:id/target/readiness` | M12.1 A8：`{readiness: TargetReadinessArtifact \| null}`；损坏 → **500 TARGET_READINESS_CORRUPTED**。artifact：`{schemaVersion:1, evaluatedAt, benchmarkRevision, manuscriptRevision, dimensions:[{dimension, verdict(MEETS_TARGET\|PARTIALLY_MEETS_TARGET\|BELOW_TARGET\|INSUFFICIENT_EVIDENCE), observed, targetRange, gaps[], confidence, evidenceBasis}], overall:{verdict, summary}, provenance:{basis:"benchmark_observation", disclaimer, profileGeneratedAt}}`——**advisory 语义，无任何数值分数门** | TargetPanel Readiness 区 |
| `POST /api/projects/:id/target/readiness/evaluate` | 评估当前稿（覆写；manuscriptRevision 对齐 RevisionStore）→ `{readiness}`；未冻结 → 404 | TargetPanel「评估」 |
| `GET /api/projects/:id/visual-reviews/latest` | M12.2 B3：最新视觉评审报告。200 `{report: VisualReviewReport \| null}`——从未运行 = null（非 404） | ReviewPanel 视觉区 |
| `POST /api/projects/:id/visual-reviews/run` | 运行视觉评审（同步；确定性六项恒运行 + vision 四项按 capability）→ `{report}`（含 round，落盘 `reviews/visual-review-r<n>.json` 并重建 `research/manuscript-visuals.json`）。report：`{schemaVersion, projectId, runAt, round?, inputs, artifacts, findings:[ReviewFinding（category="visual"；source=deterministic-visual\|vision-assisted；figureEnvRef?/assetRef?/visualConfidence?/verificationStatus=verified_deterministic\|model_observation\|needs_author_review）], checks:[{checkId, kind, status(passed\|finding\|skipped\|failed)}], capability:{visionAvailable, reason?, skippedChecks[], skippedFigures[], visionFiguresCompleted/Failed, usage?}, notes}` | ReviewPanel「运行视觉检查」 |
| `GET /api/projects/:id/sources/:sid/figures/:name` | M12.2 B4（补 G8）：source 抽图资产（png/jpg/jpeg）。安全：扁平名白名单 + 词法/realpath 双重包含 + **ParsedDocument figure 登记先于读盘**（重解析残留 → 404 stale_asset）。错误码：`invalid_project`→404 / `invalid_path`·`unsupported_asset`→400 / `missing_artifact`·`stale_asset`→404 | ReviewPanel 图像预览 |
| `GET /api/projects/:id/figures/generated/:name` | M12.2 B4：生成图资产（`figs/generated/fig-<hex>.pdf`，application/pdf；figureStore manifest 登记校验同上） | ReviewPanel PDF 链接 |

> 2026-10-07 M12 Batch 2 语义约定：
> - **三层 readiness 语义分离**（M12.0 §15）：Revision Task Success /
>   Publication Readiness（M11.4 两层）不变；Target Readiness 是 advisory
>   （不进 Quality Gate 任何规则、不阻断任何终态）；`targetReadiness?`
>   只是 gate 结果的透传字段。
> - **workflow target 三 stage**（target.benchmark→profile→readiness，位于
>   feasibility 前）永不改变主 workflow 终态：未接线 / 已冻结 / 无
>   researchField / discovery 失败（如未配置检索 provider）→ 显式 skipped
>   +reason，主流程继续。
> - **Benchmark ≠ Evidence**：target 语料恒 role=reference；profile 提取只读
>   parser facts；视觉评审 pdf 侧过滤 reference 源。
> - **模型判断 ≠ verified**：vision findings 恒 model_observation /
>   needs_author_review（Figure ≠ Evidence 纪律）；vision 不可用时 capability
>   如实报告 skipped，绝不宣称全部视觉检查通过。
> - **错误码新增**：TARGET_PROFILE_CORRUPTED(500) / TARGET_READINESS_CORRUPTED(500)。

### 1.3 Project Entry & Lifecycle（2026-09-07 已消费 ✅）

| 端点 | 说明 | 前端消费方 |
|---|---|---|
| `POST /api/projects/:id/workflows` | 创建异步 WorkflowRun `{kind: WorkflowKind, citationSemanticMode?}`（kind 含 `existing_paper_review` / `topic_survey`）；`citationSemanticMode` 仅 `existing_paper_review` 消费：`"off" \| "contradiction_only" \| "full"`，**缺省 `off`，非法值 → 400**（随 run `request` 持久化；旧 run 无该字段按 `full` 解释）；**M11.1.4 `topic_survey` 可选范围参数**（随 run `request` 持久化，只是检索/规划意图不是硬过滤）：`{yearFrom?: number(1900-2100), yearTo?: number（≥yearFrom，否则 400）, targetLength?: string, targetJournal?: string}`——topic 本体 = `project.title`、语言 = `project.language`，不重复传；`topic_survey` 携带 `stylePolicy` → 400（综述研究无润色链）；**已归档项目 → 409 PROJECT_BUSY** → 202 `{runId, status, workflowKind}` | ReviewPanel（开始 Review，高级选项）/ NewProjectPage（导入后自动启动 / 综述调研自动启动） |
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
- **M11.1.4 `topic_survey`（Topic → Survey）**：M11.2 起终点从「冻结大纲」
  扩展为「综述论文 PDF」——前段研究链（M11.1.4）不变，大纲确认后接入
  **idea_to_paper 共享后段**（同 id 同语义）：`hitl.outline_confirm`
  （approve/revise/cancel；M11.2 文案改为「确认后进入综述正文写作」）→
  `writing.sections`（survey 模式：逐节 `SurveySectionContext` = refs 契约的
  有界投影[每节 synthesis claim / grounding 措辞纪律 / 绑定 Evidence / 文献
  元数据 / 引用白名单]；Writer 输出做确定性引用后检——\cite key 越界即
  契约违约拒绝）→ `citation.verify` → `review.run`（**Survey Review
  Profile**：academic rubric 切换为综述维度[覆盖完整性 / 分类与组织 /
  文献均衡性 / 比较与论证 / 引用支撑 / 写作质量] + 确定性 metrics digest
  注入；fact/style 不变；附 `reviews/survey-writing-r{round}.json` 评估产物）→
  `quality.gate`（新增 survey 四规则：`survey_outline_contract`[悬空 refs] /
  `survey_citation_keys_valid`[fake key] / `survey_synthesis_traceability`
  [evidence_backed 可回溯]为 blocking，`survey_writing_metrics`[罗列倾向 /
  多源占比 / 覆盖 / speculative 信号]只呈现不阻断）→ revision 尾段
  （bounded；带 refs 章节的修订 prompt 注入「综述结构红线」：不得换
  taxonomy / 造 gap / 升级 speculative 语气 / 越白名单引用）→
  `build.draft` / `build.final` → END（completion label = `final` / `draft`；
  `qualityGatePassed=false` 的 Draft 携带 `qualityOutcome` 字段区分
  「修订轮数耗尽 / 不收敛后接受」与系统失败）。前段 stage graph：
  `research.plan`（survey 语义研究计划 + surveyProfile）→ `hitl.research_plan`
  （approve/revise/cancel）→ `survey.search`（执行计划检索 + 结果快照物化为
  候选）→ `hitl.literature_selection`（approve[+payload.candidateIds 增删，
  M11.2 起同时接受已 promote 的候选——重跑幂等]/cancel；缺省推荐集 =
  学术形态优先、年份降序、上限 25）→ `survey.fulltext`
  （promote + 批量全文解析 + 结构化解析等待；partial success）→
  `survey.matrix`（复用 MatrixService；taxonomy 意图来自 surveyProfile）→
  `hitl.matrix_confirm`（approve / revise[+payload.entryPatches，校验与
  PUT /survey/matrix/:entryId 一致] / cancel）→ `survey.synthesis`（复用
  SynthesisService；Matrix 指纹复用）→ `survey.outline`（复用
  SurveyOutlineService；blocking fail-closed；**M11.2 确定性新鲜度复用**：
  无 feedback 且已落盘 outline 对当前 Matrix/Synthesis 指纹一致且契约校验
  无 blocking 时直接复用，不重烧规划）。HITL 全部走既有
  `POST /api/runs/:runId/resume`；独立 survey build API（matrix / synthesis /
  outline）保留用于 debug / 手动重建，正式用户路径优先 Workflow API。
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

// POST /api/projects/import-paper 请求体（M7.0.3 统一入口；标题不由用户提供）
// —— format=pdf 与旧 import-pdf 请求体兼容（format 可缺省）
interface ImportPaperPdfInput {
  format: "pdf";
  fileName: string;                              // *.pdf ≤50MB
  contentBase64: string;
  goal: "review_only" | "improvement";           // → existing_paper_review / existing_paper_improvement
  researchField?: string; targetVenue?: string;  // 高级选项（全部可缺省）
  targetProfile?: string; language?: string;
}
interface ImportPaperLatexInput {
  format: "latex";
  fileName: string;                              // *.zip ≤50MB（标题兜底用）
  archiveBase64: string;                         // LaTeX 工程 ZIP（入口 .tex 需含 \documentclass）
  // goal 只能 improvement（缺省即 improvement；LaTeX 工程只走系统性改进）
  researchField?: string; targetVenue?: string; targetProfile?: string; language?: string;
}
// 响应：{ project: ProjectView; titleSource: "pdf" | "latex" | "filename";
//         document?: PaperDocSummary（format=pdf，与 GET /paper 同形，前端直接种缓存）;
//         report?: LatexImportReport（format=latex，结构识别 + baseline compile） }

// GET /api/projects/:id/manuscript 响应（M7.0.3 新增 overview 字段；outline/sections 为既有字段）
interface ManuscriptOverview {
  projectId: string;
  title: string;                                 // outline 标题优先，缺省项目标题
  titleSource: "outline" | "project";
  sourceType: "latex" | "pdf" | "generated" | "none"; // 由落盘事实推导（import-report / parsed document / outline）
  currentRevision: number;                       // 0 = 尚无版本事实
  sectionCount: number;                          // outline 章节数 / LaTeX tex 文件数
  referenceCount: number;                        // manuscript bib 条数 / PDF 已提取参考文献数
  build: { passed: boolean; checkedAt: string; revision: number; stale: boolean } | null; // 无构建记录 = null
}

type WorkflowRunStatus =
  | "pending" | "running" | "awaiting_input"
  | "completed" | "failed" | "cancelled";

interface WorkflowRunView {                      // WorkflowState → UI 子集（api/runs.ts 映射）
  runId: string; projectId: string;
  workflowKind: WorkflowKind; status: WorkflowRunStatus;
  currentStage?: string;
  createdAt: string; updatedAt: string;
  startedAt?: string; finishedAt?: string;      // M4.4：耗时 / 时间线展示（pending 无 startedAt）
  awaiting?: {                                    // M4.5：HITL 待办（checkpoint 持久化，刷新 / 重启后仍在）
    stageId: string; prompt: string; options: string[];
    payload?: Record<string, unknown>;            // 节点业务上下文：可行性结论 / 大纲 / 改进计划 / Gate 摘要
  } | null;
  error?: { code: string; message: string; stageId?: string } | null;   // M4.4：stageId 指向失败阶段
  completion?: { label: "final" | "draft" | "review" } | null;
  /** 当前 stage 最近一次 stage.progress 快照（分章节审阅字段见下；2026-09-07） */
  progress?: { stageId: string; data: Record<string, unknown>; updatedAt: string } | null;
  completedStages?: string[];                   // M4.4：已完成 stage id（时间线状态推导）
  stageHistory?: WorkflowStageRecordView[];     // M4.4：全部尝试记录（summary 只保留数字白名单，无 findings 大 payload）
  currentStageStartedAt?: string;               // 前端富化（非后端 DTO）：SSE stage.started 的 ts，用于运行中阶段耗时
}

// M4.4 stage.progress 载荷（review.sections）——前端据此展示 17/33 + 运行中 / 等待 / 重试：
//   { section, completed, total, findings, failed, reused, started, retried }
//   active = started - completed - failed；queued = total - started（快照口径）
//   started / retried 为 2026-09-09 新增；旧 run 的 payload 无这两个字段时前端只显示 completed / total

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
// ---- M7.0（2026-09-18）：Literature Library（frontend/src/types/sources.ts） ----

type SourceRole = "evidence" | "reference" | "both";          // 缺省 both（后端 SourceStore.add）
type SourceOrigin = "USER_ADDED" | "DOI_IMPORT" | "ARXIV_IMPORT" | "URL_IMPORT" | "BIBTEX_IMPORT" | "AGENT_RETRIEVED";
type SourceStatus = "pending" | "metadata_only" | "available" | "partial" | "failed" | "rejected";
type SourceType = "pdf" | "bibtex" | "text" | "markdown" | "image" | "doi" | "arxiv" | "url" | "metadata";

interface SourceItemView {                                    // GET /sources 单条（列表与详情同形）
  sourceId: string;                                           // S001 形
  fileName?: string;                                          // metadata-only 条目（DOI/arXiv/URL 导入）为空
  sourceType?: SourceType; sourceRole: SourceRole; origin: SourceOrigin;
  status: SourceStatus; preferred: boolean;
  metadata: { title?: string; authors?: string[]; year?: number; doi?: string; arxivId?: string; url?: string; venue?: string; abstract?: string };
  metadataProvenance?: "user" | "resolved" | "inferred";      // user > resolved > inferred；缺省视为 inferred
  contentHash?: string; workKey?: string;
  versionType?: "preprint" | "conference" | "journal" | "other";
  relatedSourceIds?: string[]; bytes: number; createdAt: string; updatedAt: string;
}
interface SourceImportResult {                                // DOI/arXiv/URL 导入响应（bibtex 见下）
  source: SourceItemView; created: boolean;                   // created=false = 同身份条目已存在（幂等）
  resolve?: { outcome: "match"|"mismatch"|"ambiguous"|"not_found"|"unresolved"; provider?: string; note?: string };
}
interface BibTexImportResultView {                            // BibTeX 批量（恒 200）
  results: Array<{ source: SourceItemView; created: boolean; entryKey: string }>;
  errors: Array<{ line: number; message: string }>;           // 逐条解析错误，不影响已成功条目
}

// ---- M4.6（2026-09-10）：Evidence Workbench / Quality Gate ----

type EvidenceVerificationStatus =
  | "unverified" | "verified" | "plausible" | "mismatch" | "unverifiable" | "not_found";
type EvidenceSupportStrength = "direct" | "partial" | "indirect" | "contradictory";
type EvidenceVerificationLevel = "metadata" | "abstract" | "fulltext" | "user_confirmed";

// GET /api/projects/:id/evidence 单条（列表与详情同形；一次请求返回列表所需全部字段）
interface EvidenceRecordView {
  id: string; claim: string;
  summary?: string; quote?: string;
  source?: { sourceId?: string; title?: string; authors?: string[]; year?: number; doi?: string; url?: string };
  location?: { page?: number; section?: string; chunk?: string };
  verificationStatus: EvidenceVerificationStatus;
  verificationMethod?: string;
  supportStrength?: EvidenceSupportStrength;
  verificationLevel?: EvidenceVerificationLevel;
  confidence?: number;                         // 辅助参考（0-1），不参与 gate 判定
  relatedSections?: string[];
  usedBy?: string[];                           // 使用记录（run / 手工 markUsage）
  createdBy: string; createdAt: string; updatedAt?: string;
}

// 确定性判定结果——frontend 只展示，绝不重算 PASS/FAIL
interface QualityGateRuleView { rule: string; passed: boolean; detail: string }
interface QualityGateResultView {
  passed: boolean; reasons: string[];          // reasons = 阻止项（blocker）
  rules: QualityGateRuleView[];
  thresholds: { academicPassScore: number; styleRiskMax: number; requireFeasibility: boolean };
  checkedAt: string;
}
interface QualityGateRoundView { round: number; passed: boolean; checkedAt: string; blockerCount: number }
interface ReviewSummaryView {                   // gate 评估时消费的同轮审稿汇总（round 配对由产物结构保证）
  generatedAt: string; round: number;
  counts: { critical: number; major: number; minor: number; blocking: number };
  scores: { academicScore: number | null; styleRisk: number | null };
  openCritical: number; openMajor: number; unsupportedCriticalClaims: number;
}
interface QualityGateResponseView {             // GET /quality-gate[?round=N]；无产物时 round/gate/reviewSummary 为 null
  rounds: QualityGateRoundView[];
  round: number | null;
  gate: QualityGateResultView | null;
  reviewSummary: ReviewSummaryView | null;
  latestReviewRound: number | null;            // > 当前 gate 轮次 → stale
  stale: boolean;
}
```

### 2.1 后续里程碑预留（M4.0 只定义边界，不实现）

- `WorkflowRunDetailView / WorkflowStageView / WorkflowEventView`：M4.3（Live View + SSE）；
  Domain Event 类型见 §3，不透传 Pi 事件。✅（M4.4 消费）
- `CheckpointView`：M4.4（HITL 配置化：`awaiting{stageId, prompt, options, payload}`）。✅（M4.5 消费）
- `EvidenceView / SourceView`：M4.5-M4.6；`ReviewView / QualityGateView`：M4.6。✅（M4.6 消费，见 §2 M4.6 块；SourceView 文献库 UI 后续里程碑）
  `ArtifactView`（Draft/Final PDF）：M4.7。

## 3. Workflow Domain Event（SSE 载荷，M4.3 消费）

`GET /api/runs/:runId/events` 逐条推送（`id: seq`，`event: type`，`data: 全量 JSON`）：

```ts
type WorkflowDomainEventType =
  | "workflow.started" | "stage.started" | "stage.progress" | "stage.completed"
  | "stage.failed" | "workflow.awaiting_input" | "workflow.resumed"
  | "workflow.recovered" | "workflow.cancelled" | "workflow.completed"
  | "workflow.failed" | "quality_gate.passed" | "quality_gate.failed"
  | "build_gate.passed" | "build_gate.failed" | "final.created";

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

**结论（M4.0 审计；2026-09-09 M4.4 实证）**：现有 SSE contract（replay + 实时 + 心跳 + seq 去重 +
`workflow.awaiting_input` 携带待办）已足以支撑 Workflow Live View（M4.4 已消费：
`useWorkflowEvents` 页面级订阅 → seq 去重 → TanStack Query 缓存增量更新，
断线重连 / 刷新恢复 / 终态失效均有浏览器级 E2E 覆盖）与 M4.5 HITL，无需重写事件系统。

## 4. 变更纪律

- 破坏性变更（删字段 / 改语义）必须先改本文档并标注里程碑；
- 新增可选字段向后兼容，可在小版本直接追加；
- Backend `errors.ts` 的错误码是稳定契约，前端按 `code` 分支（如
  `PROJECT_NOT_FOUND` → 「项目不存在」态）。

## 5. M13.2 Experiment Packages

Base path: `/api/projects/:id/experiment-packages`. All responses are JSON; errors retain the common `{status:"error",error:{code,message}}` shape.

| Method/path | Input | Response |
| --- | --- | --- |
| `POST /` | Raw `application/zip` stream, optional URL-encoded `X-Package-Name` | `201 {package,created:true}`; same archive `200 {package,created:false}` |
| `GET /` | — | `{packages: ExperimentPackage[]}` |
| `GET /workflow-context` | — | `{schemaVersion,status,truncated,observations}`; only current author-confirmed result groups, capped at 100 observations |
| `GET /:packageId` | — | `{package}` including current Source-drift conflicts |
| `PATCH /:packageId` | `{path,role,groupId}` | `{package}`; invalidates prior group confirmations |
| `POST /:packageId/confirm` | `{groupIds:string[]}` | `{package}`; author confirmation only |
| `POST /:packageId/understand` | — (M13.3) | `{package}` with `semanticSuggestions`; model unavailable `SEMANTIC_MODEL_UNAVAILABLE` (503), call/output failure `SEMANTIC_MODEL_FAILED` (502) |

Limits: 16 MiB raw ZIP, 200 files, 20 MiB per file, 64 MiB inflated total, depth 8, ratio 100:1, 120-second upload idle timeout. Archive structural hazards return `EXPERIMENT_ARCHIVE_UNSAFE` (422), size limit `EXPERIMENT_ARCHIVE_LIMIT` (413), corrupted manifest `EXPERIMENT_MANIFEST_CORRUPTED` (500, fail-closed), stale/conflicting confirmation `EXPERIMENT_CONFIRM_CONFLICT` (409). Per-file parser failure is a visible `parseStatus=failed` inside a `partial` package.

The package record carries exact ZIP-relative paths, file hashes, canonical Source IDs, role/group candidates and rationale, individual metric observations with block/row/column or JSON path, and config-result relation candidates. These candidate relations are not scientific facts. ZIP files are never executed. Package Sources are excluded from generic literature digests and raw retrieval prompts. The Research Workflow receives a bounded structured context only for currently valid, author-confirmed result groups; config/log/notebook text is excluded, and string fields are reduced to inert labels. The context explicitly remains author-confirmed, not externally verified Evidence. Confirmed result Sources become available through existing `/figures/datasets` and Figure APIs; author-selected cells use existing `/sources/:sid/records/evidence` and remain `user_confirmed` / `unverified`.

M13.3 additions (all backward-compatible optional fields):

- Ingestion: `.jsonl` / `.ndjson` parse as row streams (one `structured_record` per line, physical line provenance); row streams never contribute metric observations even under a result role — their primary consumer is figure datasets. Plain `.txt` whose entire content is a whitespace-aligned table (uniform column count, ≥80% numeric data cells) parses as a `table` block with column structure; result-role table cells produce observations with row/column anchors.
- Deterministic understanding: sibling directories holding identically-named files become candidate parallel-arm groups (`arm-<dir>`); `verdict` / `decision` / `conclusion` string fields are recorded verbatim as `reportedVerdicts` (Source-Reported Verdict — quoted, never re-derived); standard MOT metric names carry a `direction` (`higher` / `lower`, e.g. HOTA↑, IDSW↓; unknown names stay `unknown`); same-group decimal-vs-percentage scale mixing (ratio 30–300) raises an explicit warning instead of silently coexisting.
- `POST /:packageId/understand` runs one bounded call of the effective default model over a bounded context (inventory, ≤40 observations per file with values, ≤2 documentation excerpts, verdicts; untrusted-data framing against prompt injection). Every returned suggestion passes a deterministic validator: anchors must be real package paths; findings citing decimal or large numbers must match anchored observations value-for-value (small structural integers are exempt); failures are dropped with visible notes. Stored suggestions always carry `needs_author_confirmation`, model attribution, latency and token usage, and never mutate files, groups or observations on their own. The model is resolved per call from the currently saved Settings preference (not the startup snapshot).
- Bounded payloads (remote-access usability): `GET /` returns summaries only (`fileCount` / `groupCount` / `observationCount` / `warningCount`); detail and mutation responses carry the first 200 observations plus `observationCount` (total). On-disk manifests and the server-side workflow-context remain full.
