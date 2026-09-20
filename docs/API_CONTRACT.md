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
| `POST /api/runs/:runId/resume` | HITL 决策 `{decision, payload?}`（仅 `awaiting_input` 可调用）。decision 必须在当前 `awaiting.options` 内，payload 按节点契约：`hitl.feasibility_confirm` 的 `adjust` 需 `targetProfile` 或 `targetVenue`（≥一项）；`hitl.outline_confirm` / `hitl.plan_confirm` 的 `revise` 需非空 `feedback`；`hitl.revision_overflow` 为 `accept_draft` / `revise_more`（无 payload）；`cancel` 走 decision 通道留档 `inputs`。成功 → 200 `{run}`（decision=cancel 时终态 cancelled）。**409 WORKFLOW_INVALID_STATE**：非法 decision / 缺 payload / 重复提交（含并发）/ 过期请求（已 resume）；重复 cancel 幂等走 `POST /cancel` | ✅ M4.5（HitlPanel 决策面板） |
| `POST /api/runs/:runId/cancel` | 取消 run：立即 abort 在途模型调用（AgentRun / 分章节审阅 / 语义核验 / 引用真实性核验逐条循环），停止派发未开始项，循环检查点终结落盘。**已 cancelled 的重复取消幂等 200**（返回当前状态）；completed / failed → 409 | ✅ M4.4（工作流页「取消任务」） |
| `GET/POST /api/projects/:id/sources`、`GET/PATCH/DELETE …/:sid`、`POST …/:sid/analyze` | 文献库 CRUD + PDF 分析。M6.2 起：重复上传同内容 PDF → 200 `{source, created:false}`（新建 201 `{source, created:true}`，contentHash sha256 判重）；PATCH 增可选 `versionType`（preprint/conference/journal/other）；DELETE 被 Evidence 引用时 **409 SOURCE_IN_USE**；metadata 增可选 `arxivId`/`abstract` | ✅ M7.0（SourcesPanel「文献库」：列表 / PDF 上传） |
| `POST /api/projects/:id/sources/import/{doi\|arxiv\|url\|bibtex}` | M6.2 入库路径：`{doi, sourceRole?, enrich?}` / `{arxivId, sourceRole?, enrich?}` / `{url, title?, sourceRole?}` / `{content, sourceRole?}`。身份归一去重（重复导入 → 200 created:false）；DOI/arXiv 默认经 ScholarlyResolver 补全元数据（`enrich:false` 跳过；未命中如实记录不伪造）；URL 只存 canonical 记录不抓正文；BibTeX 逐条导入（解析错误随响应 errors 返回） | ✅ M7.0（SourcesPanel：DOI / arXiv / URL / BibTeX 四种导入 + resolver 结论展示） |
| `GET/POST /api/projects/:id/sources/candidates`、`DELETE …/candidates/:cid`、`POST …/candidates/:cid/{promote\|reject}` | M6.2 Discovery 候选（≠ 正式文献）：GET 支持 `?status=pending_review/accepted/rejected`；POST 需可判等身份（doi/arxivId/url/title+year+authors 任一组合成键）；promote 幂等（library 已有同身份 → merge 返回既有）；reject 幂等；删候选不影响正式 Source | ✅ M7.1c（DiscoveryPanel「候选文献」：列表 / 状态筛选 / Promote / Reject） |
| `POST /api/projects/:id/sources/:sid/{enrich\|link}` | M6.2：enrich = resolver 元数据补全（resolved 级 merge，低可信只填空缺）；link = `{targetSourceId, versionType?, targetVersionType?}` 建立同一工作多版本关系（workKey + relatedSourceIds，preprint/正式版保持独立） | M6.2 |
| `POST /api/projects/:id/sources/:sid/resolve-fulltext` | M7.2 全文解析手动触发/重试（对 metadata-only 条目；promote 后已有后台单次尝试，本端点是确定性的重试入口）：resolver 链（Unpaywall(DOI) → OpenAlex oa-url → arXiv PDF；email 未配置则 Unpaywall 不注册）→ 下载（SSRF 逐跳护栏 / ≤20MB / %PDF- 魔数校验）→ **同条目原地挂载**（sourceType→pdf，chunk 锚点链闭合）→ builtin 分析（status→available/partial）→ `retrieval.rebuildSource`。单轮有界尝试（≤3 resolve × 每 URL 一次下载，失败落链内下一 resolver）。200 `{source, outcome: resolved\|not_found\|failed\|skipped_has_file, note?}`（结局是数据不是异常，license/url/resolver/attempts 落 `source.fullText` provenance 可审计）；无 DOI/arXiv 身份（如 Web 候选）→ **422 FULLTEXT_NOT_RESOLVABLE**（确定性不可解析，重试无意义） | M7.2（后端；前端 UI 后续按需） |
| `POST /api/projects/:id/research/academic-search` | M6.3 学术发现检索（真关键词 discovery，非标题查证）：`{query, limit?(1-50 默认 10), yearFrom?, yearTo?, openAccessOnly?, saveAsCandidates?: number[]}`。多源聚合（OpenAlex primary / S2 fallback / arXiv preprint / AMiner China-secondary）+ SourceIdentity 去重 + 带权重 RRF 融合 → `{status: success\|partial, results: [{identity, record, citationCount?, openAccess?, score, sources:[{provider,rank}]}], diagnostics, saved?}`。**默认不持久化**；`saveAsCandidates`（结果下标数组）显式写入 CandidateStore（origin=academic_search，provenance 带 query）。单源失败 → partial；全源失败 → 502 SEARCH_ALL_PROVIDERS_FAILED（≠ 空结果）；无任何 provider → 503 SEARCH_PROVIDER_NOT_CONFIGURED。检索结果 ≠ Evidence，永不写 EvidenceStore | ✅ M7.1c（DiscoveryPanel「研究检索」：学术模式 + 年份范围 + saveAsCandidates 显式保存） |
| `POST /api/projects/:id/research/web-search` | M6.3 Web 检索（SearXNG，optional）：`{query, limit?, saveAsCandidates?: number[]}` → 同上结构（results 为 WebSearchResult：url canonical 化 / title / snippet / engines / score）。未配置 SearXNG → 503 SEARCH_PROVIDER_NOT_CONFIGURED（其余能力不受影响）；JSON API 未启用（403）→ 502 附 misconfigured 说明 | ✅ M7.1c（DiscoveryPanel「研究检索」Web 模式） |
| `GET /api/research/providers` | M6.3 Provider Health 观测：`{providers: {academic: ProviderHealthSnapshot[], web: ProviderHealthSnapshot[]}}`（state: healthy/degraded/rate_limited/unavailable + circuit + consecutiveFailures；无 header / key 等敏感信息） | M6.3 |
| `GET /api/projects/:id/research/plan` | M8.1 读取调研产出的检索计划（research.json 的 `plan` 一等字段）：`{plan: ResearchPlan \| null}`。无 research.json 或旧 artifact 无 plan → `plan: null`（空态而非错误）。plan 只是检索意图声明（questions + queries[query/kind/rationale/expectedCoverage/status/resultCount?]），不触碰 Candidate/Source/Evidence 链路 | ✅ M8.1（DiscoveryPanel「Research Plan」查看） |
| `PUT /api/projects/:id/research/plan` | M8.1 受限编辑检索计划：`{questions?: string[], queries?: [{queryId?, query, kind: academic\|web, rationale?, expectedCoverage?, status?: planned\|executed\|skipped}]}`（至少其一；整体替换语义）。同 queryId 条目继承既有 status（缺省时）与 **resultCount（执行回填，编辑面不可写）**；planId/plan.status/createdAt 不变，updatedAt 刷新；旧 artifact 无 plan 时编辑即初始化 draft 计划。校验失败 → 400 INVALID_REQUEST；无 research.json → 404 NOT_FOUND（先运行调研）；非 GET/PUT → 405 | ✅ M8.1（DiscoveryPanel「Research Plan」编辑/保存） |
| `POST /api/projects/:id/research/plan/approve` | M8.2 批准计划（draft → approved，显式 HITL 动作；不自动发生）：200 `{plan}`（status=approved，updatedAt 刷新）。非 draft（approved/executing/done）→ **409 PLAN_INVALID_STATE**；无 research.json / 无 plan 字段 → 404 NOT_FOUND；非 POST → 405 | ✅ M8.2（DiscoveryPanel「批准计划」） |
| `POST /api/projects/:id/research/plan/execute` | M8.2 执行 approved 计划：遍历 plan.queries 中 status=planned 的条目，经 ResearchDiscoveryService（academic/web 按 kind 分派）检索，回填 `status: executed + resultCount`（失败条目保持 planned、error 记入 executionHistory，不中断整轮），plan 流转 executing → done，最小执行记录追加 research.json 顶层可选 `executionHistory`（旧 artifact 兼容）。200 `{executionId, totalQueries(plan 全部 query 数), executedQueries, failedQueries, plan}`。**执行不写 Candidate/Source/Evidence、不 prime 检索缓存**（Search Result ≠ Candidate ≠ Literature ≠ Verified Evidence 不变量）。状态不允许（draft/executing/done）→ **409 PLAN_INVALID_STATE**（并发重复执行由进程内守卫同样 409）；无 research.json / 无 plan → 404 NOT_FOUND；非 POST → 405 | ✅ M8.2（DiscoveryPanel「执行计划」+ 执行结果摘要） |
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
