# M14.0 — 学位论文 Workflow（Thesis Workflow）架构设计：只读源码审计

> 日期：2026-10-13。执行：Claude Code（Pre-M14 只读审计子代理）。基线：`main @ 215de15`（M13 COMPLETE — READY_FOR_M14）。
> **只读调研，未改任何产品代码**（backend/ frontend/ e2e/ scripts/ agents/ 零改动；未运行测试 / dev 栈 / 模型调用；未做任何 git 写操作）。本文是唯一产物。
> 每条代码论断给 `文件路径:行号`；三类标记：**【已实现】**（代码可直接复用）、**【缺口·可证明】**（grep / 读码证实不存在或语义不符）、**【推断】**（基于现有设计的合理推测，需实现期验证）。报告脱敏：不含服务器地址、凭据、私人论文内容。

---

## 0. Executive Summary

| 结论 | 要点 |
| --- | --- |
| 总体裁决 | 现有 M6 冻结流水线（Research → Evidence → Writer → Review → Gate → Build）与 M10.3 返修链（导入 → 冻结基线 → Scoped Patch → Fact/Citation Preservation）**可覆盖学位论文 11 步中约 7 步的执行层**；真正缺的是「多篇小论文 → 一个学位论文项目」的**数据模型层**（SourcePaper 多篇、Contribution Ledger、章节映射、一致性账本、事实冻结）与「章节级」的**编排粒度**（checkpoint / 恢复 / 篇幅）。 |
| 最大结构性阻碍 | (1) 项目 ≡ 单稿件：`paper/source/paper.pdf` 单文件、`manuscript/` 单工作树、`RevisionStore` 单修订链（§3.1）；(2) 组装根模板硬编码 `ctexart` + `\section` 级 `\input`，大纲上限 20 节、无 `\chapter` / 封面 / 目录 / 关键词（§3.6）；(3) `writing.sections` 是**单 stage 顺序写全部章节**，无节级断点恢复（§3.7）；(4) `research/` 单例产物文件（`research.json` / `revision-baseline.json` / `feasibility.json`）天然单文档（§3.1）。 |
| 可直接复用的「事实安全」能力 | `user_confirmed` 证据等级、Fact / Citation / Cumulative Preservation、Scoped Patch、Named Reference Guard、`citation_unknown_key` fail-closed、Experiment Package 范围级授权、`AUTHOR_DECISION_REQUIRED` 双层终态、Writer 图形白名单守卫、Workspace Guard（§2 表）。 |
| 需新增的核心模块 | `thesis/`（ThesisProject 扩展、SourcePaperRegistry、ContributionLedger、ChapterMapping、ConsistencyLedger、FrozenFactStore、InheritedFigureAssets、ChapterWritingState）+ 第五类 `WorkflowKind = "thesis_from_papers"` 的 stage 定义 + 学位论文 LaTeX 模板 + 前端 Thesis 创建入口接线（§4–§5）。 |
| 与 D-0014 的兼容 | 新 workflow 仍是线性主干 + 两个 bounded loop（章节写作 loop 以「章」为单位有界重试；跨章修订 loop 复用 `planSharedTail`）+ 一个 fan-out（分章并行写作 / 分章 Review 复用 `mapWithConcurrency`），不引入 DAG（§5.3）。 |

---

## 1. 调研范围与方法

- 定向材料：`CLAUDE.md`、`docs/ARCHITECTURE.md` §1.3 / §3 / §5 / §6.4.1 / §9 / §20、`docs/DECISIONS.md` D-0014 / D-0015 / D-0024 / D-0027 / D-0028 / D-0029 / D-0030 / D-0034 / D-0037 / D-0038 / D-0039、`docs/PROJECT_STATUS.md` 首段、`docs/research/M13_FINAL_CLOSURE.md` 「M14 Thesis Workflow — Handoff」节（L278-290）、`docs/research/M13_8_NETWORK_AND_PRODUCT_CLOSURE.md` §16（L191-203）、`docs/PRD.md` §5.4-5.5（L280-335）、`docs/API_CONTRACT.md` §1.1。
- 源码：`backend/src/{import,paper,ingestion,agents,evidence,retrieval,manuscript,workflow,writer,review,experiments,figures,citation,latex,vision,sources,survey,quality,project,artifacts}`、`frontend/src/{pages/NewProjectPage.tsx,constants/projectMeta.ts,types/api.ts,api/projects.ts,components/common/status.ts,components/project/workflowTimeline.ts,components/project/ProjectAside.tsx}`、`backend/src/httpServer.ts` 项目创建 / 导入路由。
- 方法：`rg` / `grep -n` / `sed -n` 定位 + 逐段读码；未运行任何代码。

---

## 2. 模块审查：核心类型 / 入口 / 持久化 / 状态机坐标

### 2.1 Existing Paper Import（`import/`、`project/ProjectImportService.ts`）

| 项 | 坐标 | 说明 |
| --- | --- | --- |
| 统一导入入口 | `backend/src/httpServer.ts:481-525` | `POST /api/projects/import-paper`，`format=pdf|latex`；latex 只允许 `goal=improvement`（L503-508）。 |
| PDF 导入 → 新项目 | `backend/src/project/ProjectImportService.ts:85-120` | `importPdf`：**每个 PDF 创建一个项目**（`projects.create` L89），ingest 失败回滚删项目。 |
| LaTeX 导入 → 新项目 | `backend/src/project/ProjectImportService.ts:126-160` | `importLatex`：固定 `workflowKind: "existing_paper_improvement"`（L130）。 |
| LaTeX 工程解析 | `backend/src/import/LatexImporter.ts:140-215` | 扩展名白名单 L60-74（含 `.png/.jpg/.pdf/.eps`）；入口 = 含 `\documentclass` 的 `main.tex` 或最大文件 L157-166；原始快照 `workflow/imports/<ts>/` L188-196；**整个归档按相对路径写入 `manuscript/`**（L198-204）——第二篇小论文导入会覆盖同名文件。 |
| PDF → 可修订稿重建 | `backend/src/import/PaperReconstructor.ts:1-20,37-50` | 零 LLM，PaperDocument → `outline.json` + `sections/secNN.tex` + `references.bib`；**文本级，不含原图 / 公式以转义文本呈现**（L14-15；D-0028）。`MAX_OUTLINE_SECTIONS = 20`（L45）。 |
| 资产清单（MANIFEST 角色） | `backend/src/import/assetInventory.ts:18-60` | `research/asset-inventory.json`；角色枚举含 `current_manuscript / historical_manuscript_candidate / current_experiment / historical_board_experiment …`（L18-30）。产出 stage `import.inventory` `backend/src/workflow/definitions.ts:5839-5900`。 |

**【缺口·可证明】** 导入链路的产物目录是项目级单例（`paper/`、`manuscript/`、`research/asset-inventory.json`），没有「第 N 篇小论文」的命名空间。

### 2.2 Paper Ingestion / PaperMap（`paper/`）

| 项 | 坐标 |
| --- | --- |
| 单 PDF 布局 | `backend/src/paper/PaperStore.ts:1-16`：`{project}/paper/source/paper.pdf`、`parsed/document.json`、`paper-map.json`、`stages.json`、`citation/`；`sourcePath` 固定 L55-56。 |
| 幂等 / 替换语义 | `backend/src/paper/PaperIngestService.ts:1-10`：sha256 相同 → 幂等；**不同 → 替换并清空派生产物**（第二篇 PDF 会抹掉第一篇）。 |
| 类型 | `backend/src/paper/types.ts:95-113` `PaperDocument`（`projectId`、`documentId`、sections / chunks）；`PaperMap` L78-92。 |
| PaperMap 纪律 | `backend/src/paper/PaperMapService.ts:1-18`（D-0024：每 section 短生命周期任务，其他章节只给摘要）。 |
| 分章节 Review 并发 + 节级 journal | `backend/src/paper/SectionReviewScheduler.ts:1-25`（per-section 持久化、单节失败隔离、已完成节经 journal 复用）。 |

**【已实现·可复用】** PaperMap + section 任务 + 节级 journal 是「长文档分章处理」的现成范式；**【缺口】** 它只服务 `existing_paper_review`（`paper/` 单文档），未泛化到多文档或 Writer 侧。

### 2.3 Research / Evidence（`agents/research*`、`evidence/`、`retrieval/`）

| 项 | 坐标 |
| --- | --- |
| ResearchPlan 一等产物 | `backend/src/agents/researchPlan.ts:1-25`：落 `research/research.json` 的 `plan / plans / activePlanId`（单文件、单链）。 |
| M10.3 返修研究链 stage | `backend/src/workflow/definitions.ts:5995-6266`（`research.plan → hitl.research_plan → research.execute → hitl.evidence_supply → research.propose → evidence.ground → evidence.supply.review`）。 |
| 有界证据供给 | `backend/src/evidence/ResearchEvidenceSupply.ts:7`：`RESEARCH_SUPPLY_LIMITS = { candidates: 12, sources: 6, claims: 6 }`。 |
| 定向采证 | `backend/src/evidence/TargetedGroundingService.ts:1-20`：unsupported claim × 在库全文 → 三段核验 → verified。 |
| EvidenceStore | `backend/src/evidence/EvidenceStore.ts:1-15`（`evidence/evidence.jsonl`）；`VerificationLevel = metadata/abstract/fulltext/user_confirmed` L34；`EvidenceRecord` L67-86（`protocolScope` L76）。 |
| 正式证据口径 | D-0038（`docs/DECISIONS.md:931-960`）：formal = verified + sourceId + chunk 锚点；**user_confirmed 无 chunk 锚点永不 formal**（`docs/API_CONTRACT.md:90` 同口径）。 |
| 证据 → 章节分配 | `backend/src/evidence/sectionEvidenceAllocation.ts:1-45`（按论证单元 role 分配；framing/conclude 不注入 formal）。 |
| 协议范围 | `backend/src/evidence/protocolScope.ts:7-22`：`inferExperimentProtocolScope` 是**写死的夹具名正则**（`fair_ablation_new_detector` / `old_coco_pretrained_detector`），非通用机制。 |
| 检索上下文预算 | `backend/src/retrieval/contextPacker.ts:14-45`：`DEFAULT_PACK_BUDGET_TOKENS = 6000`、`MAX_SOURCE_SHARE = 0.5`、相邻去重；token 估算 `backend/src/runtime/pi/contextBudget.ts:1-30`（CJK 1.5 token/字）。 |
| 索引 = Derived | `backend/src/retrieval/RetrievalService.ts:1-16`（按 projectId 分桶，可删可重建）。 |

### 2.4 Manuscript / Revision Store（`manuscript/`）

| 项 | 坐标 |
| --- | --- |
| Outline 类型 | `backend/src/manuscript/ManuscriptService.ts:27-56`：`OutlineSection{id,file,title,targetLengthWords,keyPoints,synthesisRefs,literatureRefs,argument}`、`Outline{title,abstract,sections}`——**无层级（无 chapter/section 树）、无来源映射字段**。 |
| 大纲校验 | `ManuscriptService.ts:283-300`：sections 3–20；`SECTION_FILE_PATTERN` 扁平 `sections/<slug>.tex`（L60、L92-101）。 |
| 组装根模板 | `ManuscriptService.ts:142-170`：`\documentclass[UTF8]{ctexart}`、`\maketitle`、`abstract`、`\input{sections/*}`、`natbib numbers + unsrt`——**无 `\chapter`、无封面 / 目录 / 中英摘要 / 关键词 / 附录**（与 Handoff (d) 一致）。 |
| 修订链 | `backend/src/manuscript/RevisionStore.ts:1-15`：`manuscript/revisions.json` + `revisions/rev-{n}/` 全量快照；`RevisionRecord.reason` L49-60；`ensureBaseline`（reason=`"baseline"`）L160-178，**仅 `httpServer.ts:3563` 调用，workflow 内无调用**（`grep ensureBaseline definitions.ts` 为空）。 |
| 工作流内的 commit 点 | `definitions.ts:513`（`review.snapshot`）、`5103`（`outline.plan`）、`5617/8208`（`writing.sections`）、`2596`（revise/apply）、`1601`（repair）、`3287`（style_polish）、`4101`（restore_facts）。 |
| 冻结基线查找 | `backend/src/quality/cumulativeFactPreservation.ts:295-304`：existing-paper → 取**第一条修订**（不看 reason）；非 existing → 找 `reason === "baseline"`。 |
| 事实基线投影 | `backend/src/review/revisionBaseline.ts:30-60`：`research/revision-baseline.json`（表格 / 数字 / 公式 / 方向句 / cite keys / 图 / 硬件 / 占位），单文件。 |
| LaTeX 文件收集 | `backend/src/manuscript/LatexFiles.ts:31-60`：从 `main.tex` 沿 `\input/\include` 递归（**支持嵌套目录**，可承载 `chapters/ch1/*.tex`）。 |
| 标题提取 | `backend/src/manuscript/latexHeadings.ts:11,27`：已含 `\chapter`。 |

### 2.5 Workflow Orchestrator（`workflow/`）

| 项 | 坐标 |
| --- | --- |
| Kind 常量 | `backend/src/workflow/kinds.ts:12-17`：四类（`idea_to_paper / existing_paper_improvement / existing_paper_review / topic_survey`）。 |
| StageContract | `backend/src/workflow/types.ts:51-68`（`requiredInputs / producedOutputs / maxAttempts / timeoutMs(空闲) / retryable / execute / verifyDod`）；HITL `71-84`；`WorkflowState` 134-168（`stageResults` 按 stage id 单槽、`counters`）；`WorkflowDefinition.plan` 必须是 state 纯函数 182-193。 |
| 失败分类 | `backend/src/errors.ts:418-423`：`transient / timeout / runtime_unavailable / contract_violation / permanent`。 |
| 完成标签 | `types.ts:127-130`：`final / draft / review / survey`（新增 thesis 需扩枚举或复用 draft/final）。 |
| 持久化 | `backend/src/workflow/runStore.ts:1-11`：`workflow/runs/<runId>/{checkpoint.json,events.jsonl,stages/}`。 |
| 恢复粒度 | `backend/src/workflow/WorkflowOrchestrator.ts:375-404` `recoverInterruptedRuns`：running/pending 的 run 重启执行循环，**已完成 stage 不重跑、未完成 stage 从头重跑**（stage 级）。 |
| 单活跃 run | `WorkflowOrchestrator.ts:120-150`（同项目已有 pending/running/awaiting → 拒绝）。 |
| 共享后段 bounded loop | `definitions.ts:4234-4420` `planSharedTail`：新鲜度规则（改稿 → citation/review/gate/build 重走）、`revisionBudget = maxRevisionRounds + counters["revision.manual_rounds"]`（L4212-4214）、STALLED/REGRESSED → HITL、`revisionTaskSuccess` 分层终态。 |
| 现有 HITL 节点 | `hitl.feasibility_confirm`(5035) / `hitl.outline_confirm`(5162) / `hitl.evidence_supply`(5194) / `hitl.research_plan`(6050) / `hitl.plan_confirm`(6522) / `hitl.revision_validation`(2950) / `hitl.revision_overflow`(3511) / `hitl.revision_stalled`(1615) / `hitl.style_polish`(3098) / `hitl.literature_selection`(7278) / `hitl.matrix_confirm`(7633)。 |
| 四条 definition 工厂 | `definitions.ts:5658`（idea）、`6550`（existing）、`6986`（review）、`8251`（survey）；`WorkflowServices` 装配面 `286-410`。 |

### 2.6 Outline / Writer（`writer/`、`generation/`）

| 项 | 坐标 |
| --- | --- |
| planOutline | `backend/src/writer/WriterService.ts:302-325`：输入 researchDigest **或** surveyDigest + evidence + bibliography + experimentContext；prompt `1845-1900`：**「sections 至少 4 节至多 12 节」**（L1875），单层。 |
| writeSection | `WriterService.ts:426-470`：输入 `section / outline / evidence / bibliography / experimentContext / argument`，`contextScope: "writing/sections"`；禁 `\documentclass`（L419-485）。 |
| 论证单元 | `backend/src/writer/argumentUnit.ts:26-45`：`ArgumentRole = framing/develop/compare/conclude`，`OutlineArgumentUnit{role,task,evidenceIds,doNotExplain,targetLengthUpperBound}`。 |
| writing.sections stage | `definitions.ts:5487-5660`：**单 stage 顺序 for 循环写全部章节**（L5553-5600），`timeoutMs ×4`，写作计划 journal `updateWritingPlanSection`（L5586）仅记录状态，**循环不读 journal 跳过已写节**；stage 末尾一次 commit（L5617）；`verifyDod` 要求所有节文件存在非空（L5640-5656）。 |
| 返修 Scoped Patch | `backend/src/review/revisionScope.ts:23-45` `checkGlobalRevisionScope`；在 `definitions.ts:2182-2184, 2456-2501` 消费。 |
| GenerationService | `backend/src/generation/GenerationService.ts`（M2 同步整篇生成，deprecated 路径；不建议复用）。 |

### 2.7 Academic Reviewer（`agents/ReviewerService.ts`、`review/`）

| 项 | 坐标 |
| --- | --- |
| 三模式 | `backend/src/agents/ReviewerService.ts:29-35`（fact/academic/style）；`reviewAll` 入参 `173-200`：**整篇 `manuscriptDigest` 字符串**。 |
| 全稿 digest 预算 | `definitions.ts:8613-8640`：`sections.slice(0, 24)`、每节 `SECTION_DIGEST_BUDGET = 3600`、总 `60_000` 字符句界截断。消费点 `definitions.ts:510`（review.run）、`5965`（import.understand）。 |
| 跨章节工具 | `backend/src/review/crossSectionRedundancy.ts:1-20`：仅**复述探测**（词面），不进 Gate；**无术语 / 符号 / 指标一致性检查**（`grep glossary|nomenclature|术语表|符号表` 仅命中注释性用词，无独立模块——【缺口·可证明】）。 |
| Named Reference Guard | `backend/src/review/namedReferenceGuard.ts:1-25`：允许词表 = 修订前全稿 + 证据文本 + bib；审稿意见 / 计划文本**不在**允许词表。 |
| Revision Validation | `backend/src/review/revisionValidation.ts:1-60`：四类复核 + 类别 `fact_preservation / citation_removal_detected / named_reference / citation_unknown_key / claim_strength / evidence_stale`（L48-54）。 |
| 事实基线 / 作者数据 | `backend/src/review/claimGrounding.ts:186`：`isOwnResultClaim` 的数值 claim 必须由 `user_confirmed` 支撑；`backend/src/citation/citationIntent.ts:5-7` 判定词「本文 / 本研究 / 我们的 / our / we」。 |
| 外部意见 | `backend/src/review/externalInstructions.ts:1-25`（来源 `advisor` 已在枚举 L33-40——导师意见可直接接入）。 |

### 2.8 Experiment Packages（`experiments/`）

| 项 | 坐标 |
| --- | --- |
| 类型 | `backend/src/experiments/ExperimentPackageService.ts:25-132`：`PackageFile.role`、`MetricObservation{metric,value,unit,direction,dataset,protocol,split}`、`ExperimentGroup.splitScopes`、`ExperimentSplitScope.workflowUse: allowed/excluded/undecided`（L84-100）。 |
| 工作流上下文 | `134-160` `ConfirmedExperimentWorkflowContext.status = "author_confirmed_not_externally_verified"`；`workflowContext()` L1200-1230（范围级门禁）；`experimentPolicy()` L970-1000。 |
| 持久化 | `experiments/<packageId>/manifest.json` + `original.zip`（L586-588, 666）。 |
| 口径渲染 | `backend/src/experiments/experimentPolicy.ts:21-55`：零授权 → 「不得写任何具体实验指标数值」。 |
| Workspace Guard | `docs/ARCHITECTURE.md:614-643`：Writer 文件工具看不到 `experiments/`、`workflow/`、实验包来源的 `sources/*`。 |

### 2.9 FigureService / 视觉资产（`figures/`、`vision/`）

| 项 | 坐标 |
| --- | --- |
| 生成图资产 | `backend/src/figures/figureStore.ts:1-30`：`manuscript/figs/generated/{manifest.json,<figId>.spec.json,.tex,.pdf}`，`figId = fig-<specHash12>`。 |
| 插入 | `backend/src/figures/insertion.ts:1-45`：`\includegraphics` 路径**恒为** `figs/generated/<figId>.pdf`（L39），label `fig:` 白名单。 |
| Writer 图形守卫 | `backend/src/figures/writerGraphicsGuard.ts:1-60`：恒禁 tikz/pgfplots；**全新章节不允许任何 `\includegraphics`**（L52-56）；修订时基线路径必须原样保留（增 / 删 / 换路径均违规）。 |
| 源抽图资产 | `backend/src/ingestion/ParsedDocumentStore.ts:1-10, 30-32`：`sources/figures/<sourceId>/fig-001.png…`；安全解析 `backend/src/vision/figureAssets.ts:1-60`（扁平名白名单、`stale_asset`、MIME：源图 png/jpg、生成图 pdf）。 |
| 三源视图 | `backend/src/review/visualArtifactView.ts:1-25`（pdf_parsed / latex_env / generated，只读投影）；手稿 inventory `backend/src/manuscript/visualInventory.ts:1-30` → `research/manuscript-visuals.json`。 |
| 编译 | `backend/src/latex/LatexCompiler.ts:13-16, 323`：`cp(manuscriptDir → buildDir)` 整目录 staging，**manuscript/ 内任何图片路径都可编译**（继承图只要落在 manuscript/ 下即可）。 |

### 2.10 Citation Integrity（`citation/`）

| 项 | 坐标 |
| --- | --- |
| 编排 | `backend/src/citation/CitationIntegrityService.ts:1-10`（extract / metadata / semantic 三 stage，指纹跳过）。 |
| 确定性 bib | `backend/src/citation/bibliography.ts:140`（`assignCitationKeys`）、`198`（`buildBibliographyFromSources`）、`263`（`mergeArtifactBibliography`，LLM 回忆条目上限 `MAX_ARTIFACT_BIBLIOGRAPHY_ENTRIES = 40` L248——**库内条目不受限**，L244-246）。 |
| 静态检查 | `backend/src/citation/StaticCitationChecker.ts:48,90,126,142`。 |
| Gate 规则集 | `backend/src/quality/gates.ts:389-731`（`hallucinated_citations_zero … citations_evidence_backed / revision_items_resolved / claim_strength_guard / survey_*`）；**无任何 thesis / 跨章一致性规则**。 |

### 2.11 LaTeX Compiler 与模板（`latex/`）

- `backend/src/latex/LatexCompiler.ts:1-30`：xelatex → bibtex → xelatex×2（+≤2 rerun），bib 0 entries / 未解析引用 → 失败（fail-closed）。
- 模板唯一来源 = `ManuscriptService.writeMainTex`（§2.4）；`grep ctexbook` 全仓为空【缺口·可证明】。

### 2.12 Frontend Project Creation

| 项 | 坐标 |
| --- | --- |
| 论文类型卡 | `frontend/src/pages/NewProjectPage.tsx:37-55`：`PaperType = research_article | survey | thesis`，`thesis` 卡已存在。 |
| Thesis 分支 | `NewProjectPage.tsx:143-145` → `ThesisSelection`（L156-199）：**纯 UI 占位**——「学位论文创建尚未接入当前工作流…不会创建项目或上传材料」（L191），按钮 `disabled`（L194）；已画出「从研究主题开始 / 基于已有小论文扩展」两种来源 + PDF/ZIP 选择器（L163-187）。 |
| 创建 API | `frontend/src/api/projects.ts:43-49`（`createProject` / `importProjectPaper`）；`frontend/src/types/api.ts:52-62` `CreateProjectInput`（无 sourcePapers 字段）。 |
| 类型 → kind 映射 | `backend/src/project/ProjectStore.ts:65-69` `workflowKindForDocumentType`：**`master_thesis` 落 `idea_to_paper`**（只识别 survey 系）。`DOCUMENT_TYPES` L40-48 与 `TARGET_PROFILES` L71-84 已含 `master_thesis / doctoral_thesis`；`frontend/src/constants/projectMeta.ts:30-38` 同。 |
| Kind 标签 / 时间线 | `projectMeta.ts:11-27`（四 kind 标签）；`frontend/src/components/common/status.ts:313`（`STAGE_LABELS`）、`470-556`（`WORKFLOW_STAGE_SEQUENCES` 四 kind）、`558`（`stageSequenceFor`）；`frontend/src/components/project/workflowTimeline.ts:92-94`；`ProjectAside.tsx:37, 66-68`（按 kind 决定启动 kind）。 |
| 后端创建路由 | `backend/src/httpServer.ts:439-463`（`POST /api/projects` title + researchMeta）。 |

---

## 3. 难点专项分析

### 3.1 一个学位论文项目引用多篇小论文——当前 project / source / manuscript 是否天然单文档？

**结论：是，三层都是单文档。**

1. **Project 层**：`ProjectMetadata`（`ProjectStore.ts:87-115`）只有 `workflowKind?: ProjectWorkflowKind` 单值与研究定位字段，无「输入稿件集合」；`PROJECT_DIRECTORIES`（L134-143）的 `manuscript / research / workflow` 均为单例目录。
2. **Paper 层**：`PaperStore.sourcePath` 固定 `paper/source/paper.pdf`（`PaperStore.ts:55-56`）；`PaperIngestService` 内容不同即**替换并清空派生产物**（`PaperIngestService.ts:1-10`）。`PaperDocument.documentId` 存在（`types.ts:99`）但目录不按它分桶。
3. **Manuscript 层**：`LatexImporter` 把归档直接铺进 `manuscript/`（`LatexImporter.ts:198-204`）；`RevisionStore` 一条链、一个 `revisions.json`（`RevisionStore.ts:1-15`）；`revisionBaseline` / `asset-inventory` / `research.json` / `feasibility.json` 都是 `research/` 下单文件（`definitions.ts:5909-5955`, `5839-5900`；`researchPlan.ts:8-10`）。
4. **唯一天然多文档的层是 Literature Library**：`SourceStore`（`SourceStore.ts:1-28`）按 `sourceId` 分桶（`sources/papers/<sourceId>-*`、`parsed/<sourceId>.document.json`、`figures/<sourceId>/`），有 `sourceRole`（L44）、`workKey / versionType / relatedSourceIds`（L128-136，D-0034 的 preprint/正式版关系）、`origin`（L50-57，含 `EXPERIMENT_PACKAGE`）。Ingestion 支持 `latex` 资产（`parserRegistry.ts:20,80-81`）。

**设计含义**：小论文**不应**走 `paper/` 或 `manuscript/`，而应以 **Source（新增 `origin = "AUTHOR_PAPER"`、`sourceRole = "author_work"` 或等价标记）** 入库，复用 ParsedDocument / chunks / figures / RAG；`manuscript/` 只承载学位论文稿件。LaTeX 版小论文的工程文件可作为一个 Source 的附属快照目录（新增 `sources/author-papers/<sourceId>/latex/`），不写入 `manuscript/`。

### 3.2 不同小论文术语 / 符号冲突；同一指标定义 / 协议不同

**现状**：
- 术语 / 符号：无任何账本或检查（§2.7【缺口·可证明】）。Survey 链有「taxonomy family」归一（`backend/src/survey/matrixTypes.ts:88-123`）与 `normalizeComparedMethods`（L278），可借鉴但面向文献分类，不是符号系统。
- 指标 / 协议：`MetricObservation` 已带 `metric / dataset / protocol / split / direction / unit`（`ExperimentPackageService.ts:40-58`）；`ExperimentSplitScope.conflicts` 只报**同范围内 protocol 互相矛盾**（L95-99、L453）；`protocolScope.ts:7-22` 的协议识别是夹具名正则，不可泛化。`revisionBaseline` 提取 `hardware` 与数字 token（`revisionBaseline.ts:46-55`）但按文件独立、不跨源对账。
- 事实对账的「同值不同格式」能力已有：`factPreservation` 的 B 类格式等价分类（`factPreservation.ts:71-85`）、`normalizeNumericToken`（`factRestore.ts:17`）可复用于指标值归一。

**方案**：新增 `ConsistencyLedger`（§4.6）：
1. 术语 / 符号条目由「每篇小论文确定性抽取（公式片段、首字母缩写、`\newcommand` 定义、表头指标名）+ LLM 归并提案 + **作者确认**」三步形成，归并结果是 `canonical → aliases[]` 映射，状态机 `proposed → confirmed | rejected`（与 Experiment 组确认同形）。
2. 指标条目带 `(metric, dataset, protocol, direction, unit)` 五元组；**同名指标不同协议不合并，而是登记为两条并标 `comparable: false`**；Writer prompt 注入「不得跨协议直接比较」口径（复用 `renderExperimentPolicyLines` 的「口径行」模式）。
3. 一致性检查 stage（§5 `thesis.consistency_check`）是确定性词面检查：各章正文出现的 alias 是否映射到 canonical；跨章同一指标出现不同数值且无 FrozenFact 授权 → finding；输出进 Reviewer digest 与 Gate 新规则 `thesis_terminology_consistent`（默认 warning，可配 blocking）。

### 3.3 同一研究成果被多章节复用（去重 / 引用式复用）

**现状可复用**：
- `argumentUnit.ts:26-45` 的 `doNotExplain` + `role` 已是「谁拥有概念、谁只引用」的契约；`sectionEvidenceAllocation.ts:1-45` 把证据按节分配且允许「真正相关的证据多节共享」。
- `crossSectionRedundancy.ts:1-20` 可定位复述候选（只读）。
- 返修期的「新增具名实体」守卫（`namedReferenceGuard`）保证不凭空造成果。

**缺口**：没有「成果条目」这一级实体——现有 Evidence 是「claim × quote × source」，成果（contribution）是作者自己的方法 / 结论 / 实验，需要 `ContributionItem`（§4.3）承载，并在 `ChapterSourceMapping` 中声明 `ownerChapterId`（完整展开）与 `referencingChapterIds`（只允许一句话引用 + `\ref{chap:…}`）。写作时：owner 章节注入成果全文投影；引用章节只注入 `summary` 与交叉引用 label（类似 Survey 的 `sectionContext` 有界投影，`sectionContext.ts:1-20`）。写后用 `crossSectionRedundancy` 对 owner↔referencing 对做包含度检查，超阈值进定向修订（复用 `revision.plan` 的 `review_finding` 条目）。

### 3.4 已发表成果的数值 / 表格 / 引用需要事实冻结

**现有实现盘点**：

| 能力 | 坐标 | 对学位论文的适用性 |
| --- | --- | --- |
| 不可变修订快照 + 冻结基线 | `RevisionStore.ts:1-15`；`cumulativeFactPreservation.ts:295-304` | 冻结基线按 **manuscript 修订链**定义（existing-paper 取首修订；否则 `reason==="baseline"`）。学位论文稿是**新写的**，首修订是 `outline.plan` / `writing.sections`，不是小论文——**现有冻结语义不能直接表达「冻结的是输入小论文」**【缺口·可证明】。 |
| Fact Preservation（pairwise） | `factPreservation.ts:1-30` | 事实源是 `rev-{n-1} → rev-{n}` 的 .tex 差异；可直接复用于「学位论文稿修订轮之间的不漂移」。 |
| Cumulative Fact Preservation + 授权台账 | `cumulativeFactPreservation.ts:1-30, 86` | `research/fact-authorizations.json` append-only 授权台账模式可直接复用为 FrozenFact 的授权记录。 |
| Revision Baseline 结构化投影 | `revisionBaseline.ts:30-60` | 提取器（表格行 / 数字 / 公式 / 方向句 / cite key / 图 / 硬件）可对**每篇小论文的 LaTeX 或重建稿**各跑一次 → 作为 FrozenFact 的确定性来源。PDF 来源需先经 `PaperReconstructor`（文本级）。 |
| `user_confirmed` 等级 | `EvidenceStore.ts:34`；`IngestionService.ts:1-30`（status 保持 `unverified`）；`claimGrounding.ts:186`；`revisionScope.ts:210` | 「作者自己的数值无需外部重证」已贯通 Reviewer / Gate（`gates.ts:448 author_experiment_data_reported`，informational）。但 D-0038 口径下它**永不 formal**（无 chunk 锚点），Writer 的 digest 不会注入它——需要 FrozenFact 作为**独立注入通道**（与 `experimentContext` 同形）。 |
| 具名实体守卫 / 未知 cite key fail-closed | `namedReferenceGuard.ts:1-25`；`revisionValidation.ts:48-54`（`citation_unknown_key`） | 直接复用；允许词表应**扩展为「全部已冻结小论文文本 + 其 bib」**，否则小论文中出现、学位论文首稿尚未写到的具名方法会在扩写时被误拦【推断】。 |
| Scoped Patch | `revisionScope.ts:23-45` | 直接复用于章节修订。 |
| `isOwnResultClaim` | `citationIntent.ts:5-7` | 词面规则（本文 / 我们的 / our / we）在学位论文「本章 / 第 X 章 / 文献 [N]（作者自己的小论文）」语境下会**漏判**自有成果 claim【推断，需用例验证】。 |

**方案**：`FrozenFact`（§4.7）由 `thesis.freeze_facts` stage 从每篇小论文确定性提取（`buildRevisionBaseline` 同款提取器 + `extractDatasetsFromDocument`（`figures/datasets.ts:197`）的表格数据），作者确认后写入 `evidence/evidence.jsonl` 为 `verificationLevel = "user_confirmed"`、`verificationMethod = "published_paper_frozen"`、`source.sourceId = <小论文 sourceId>`、`location.chunk` 若能锚定到小论文 chunk 则填——这样它既进 Gate 的作者数据口径，又能在有 chunk 锚点时成为 formal（经三段核验 judge 可选）。Gate 新规则 `published_facts_zero_drift`：学位论文稿中引用的冻结数值 ↔ FrozenFact 值机械比对（复用 `mentionsValue` / 数值归一），不一致且无授权 → FAIL。

### 3.5 原有小论文的图表与 PDF 图片合法继承

**现状语义**（白名单，不是禁令）：
- Writer **不能**写 `\includegraphics`（新章节恒禁，`writerGraphicsGuard.ts:52-56`）；插图只能由 `FigureService.insert` 受控完成，且路径恒为 `figs/generated/<figId>.pdf`（`insertion.ts:39`）——即当前**只有「生成图」一种合法资产形态**；`figureAssets.ts:58-64` 的两类 MIME（源图 png/jpg、生成图 pdf）也不含「继承图」。
- 源抽图资产已存在：`sources/figures/<sourceId>/fig-NNN.png`（Docling 抽图，`ParsedDocumentStore.ts:30-32`）；LaTeX 导入允许 `.png/.jpg/.pdf/.eps`（`LatexImporter.ts:65-69`）且 `collectLatexFiles.figures` 记录引用（`LatexFiles.ts:26`）。
- 编译对 manuscript/ 内任意路径的图都可用（`LatexCompiler.ts:323`）。
- caption 真实性守卫 `truthfulness.ts:225` 只针对 generated plot 的 dataset。

**方案**：新增资产形态 `InheritedFigureAsset`（§4.8），落 `manuscript/figs/inherited/<sourceId>/<assetName>` + `manifest.json`，来源只能是 (a) 小论文 LaTeX 工程中被 `\includegraphics` 引用的文件（经 `LatexImportReport.structure.figures`），或 (b) `sources/figures/<sourceId>/` 的抽图（经 `figureAssets` 白名单解析）。`insertion.renderFigureEnvironment` 扩展一个 `assetPath` 枚举（`generated | inherited`），**路径仍由 manifest 派生、不接受自由字符串**；`writerGraphicsGuard` 的「基线路径必须原样保留」语义自然覆盖继承图；caption 继承原 caption（转义）或作者改写，标记 `captionOrigin`。PDF 小论文的位图继承要在 UI 标注「来源于 PDF 抽图，分辨率受限」（与 D-0028 文本级重建同一诚实边界）。

### 3.6 篇幅远大于单篇：上下文预算 / 分章恢复 / 一致性

| 维度 | 现状坐标 | 阻碍 | 对策 |
| --- | --- | --- | --- |
| Writer 输入 | `WriterService.writeSection` 每节一次 Agent 任务；Evidence 按节分配（`sectionEvidenceAllocation`）；outline 全量进 prompt | 学位论文 Outline（6–8 章 × 3–6 节 ≈ 30–40 节）超过 `validateOutline` 20 节上限与 prompt 4–12 节约束 | Outline 升级为两级（Chapter → Section），每次写作任务只带「本章 + 其他章摘要」（PaperMap 范式，D-0024） |
| Reviewer 输入 | `buildManuscriptDigest` 24 节 × 3600 字 / 60k 总预算（`definitions.ts:8613-8640`） | 学位论文 10 万字以上，全稿 digest 必然截断；Reviewer 只见前 24 节 | Review 改为**分章** Review（复用 `SectionReviewScheduler` 的并发 + journal），再做一次「跨章一致性 Review」只喂 ConsistencyLedger + 各章摘要 |
| 检索 | `contextPacker` 6000 token 预算、单源 ≤50% | 可用；需对「作者自己的小论文」sourceIds 显式 `sourceScoped` 以绕过多样性约束 | 配置项，不改代码语义 |
| 恢复粒度 | stage 级（`recoverInterruptedRuns`）；`writing.sections` 单 stage 全节顺序写（§2.6），journal 不驱动跳过 | 第 25 节崩溃 → 重跑 25 节 | 章节写作拆成**每章一个 stage 实例**（`thesis.write_chapter:<chapterId>`，动态 stage id 需 `plan()` 支持模板 id），或在 stage 内按 journal 跳过已写节（journal 已存在：`reviews/writing-plan.json` L5490） |
| 时间预算 | `timeoutMs` 是空闲超时（`types.ts:60`），按节 `emitProgress`（L5603）可无限延长 | 不阻碍 | — |
| 一致性 | 无跨章检查（§3.2） | 需新增 | §5 `thesis.consistency_check` |

---

## 4. 数据模型方案（TypeScript 草案）

> 命名空间：`backend/src/thesis/`。落盘原则沿用 M13.0 NO-GO（文件优先，原子写 `util/atomic.ts`，不引入数据库）。「扩展 vs 新 store」逐一标注。

### 4.1 ThesisProject（扩展 `ProjectMetadata`，不新建 store）

```ts
// project/ProjectStore.ts 扩展（additive，旧项目零迁移）
export interface ProjectMetadata {
  // ...既有字段 (ProjectStore.ts:87-115)
  /** M14：学位论文配置；仅 workflowKind === "thesis_from_papers" 时存在 */
  thesis?: ThesisConfig;
}
export interface ThesisConfig {
  schemaVersion: 1;
  degree: "master" | "doctoral";
  /** 学位论文模板 id（决定 documentclass / 封面 / 目录 / 摘要页；§4.10） */
  templateId: string;
  language: "zh" | "en";
  /** 输入小论文的 sourceId 列表（SourceStore 条目，origin=AUTHOR_PAPER） */
  sourcePaperIds: string[];
  /** 作者授权实验包（既有 experiments/ 机制；此处只是引用） */
  experimentPackageIds: string[];
}
```
- 落盘：`project.json`（既有）。`workflowKind` 新增字面量 `"thesis_from_papers"`（`kinds.ts:12-17` 扩枚举；`workflowKindForDocumentType` L65-69 对 `master_thesis / doctoral_thesis` **保持 idea_to_paper**，thesis 由前端显式传 `workflowKind`——避免破坏既有「学位论文从主题开始」的 idea 路径）。

### 4.2 SourcePaper（扩展 `SourceItem` + 新 store）

```ts
// sources/SourceStore.ts 扩展
export type SourceOrigin = /* 既有 */ | "AUTHOR_PAPER";
export type SourceRole = "evidence" | "reference" | "both" | "author_work";

// thesis/SourcePaperRegistry.ts（新 store）：sources/author-papers/<sourceId>/paper.json
export interface SourcePaper {
  schemaVersion: 1;
  sourceId: string;                     // SourceStore 条目（PDF 或 LaTeX ZIP 的主文件）
  format: "pdf" | "latex";
  title: string; venue?: string; year?: number; doi?: string;
  publicationStatus: "published" | "accepted" | "under_review" | "preprint";
  /** LaTeX 工程原始快照目录（相对项目根；format=latex 时） */
  latexSnapshotDir?: string;            // sources/author-papers/<sourceId>/latex/
  /** 确定性重建 / 解析产物引用 */
  parsedDocumentRef: { sourceId: string; contentHash: string };   // sources/parsed/<id>.document.json
  /** 事实基线（revisionBaseline 提取器复用）：sources/author-papers/<sourceId>/baseline.json */
  baselineRef: { path: string; contentHash: string };
  /** 冻结状态：frozen 后 FrozenFact 不可再变更（只能作废 + 重提） */
  freezeStatus: "ingested" | "extracted" | "frozen";
  frozenAt?: string;
  bibKey?: string;                      // 学位论文 references.bib 中引用本篇时的 key
}
```
- 与现有 store 关系：原始文件 / ParsedDocument / chunks / figures 全部复用 `SourceStore` + `ParsedDocumentStore` + `ChunkStore`；`SourcePaperRegistry` 只存「作者论文」附加事实。`PaperStore`（`paper/`）**不用**。

### 4.3 ResearchContributionLedger / ContributionItem（新 store）

```ts
// thesis/ContributionLedger.ts：research/contributions.json（append-only 条目 + 状态）
export type ContributionKind = "research_question" | "novelty" | "method" | "experiment_result" | "conclusion" | "limitation";
export interface ContributionItem {
  id: string;                           // C001…（确定性：sha(sourceId|kind|normalizedText)[0:8]）
  sourcePaperId: string;
  kind: ContributionKind;
  text: string;                         // LLM 提取 + 作者可编辑
  /** 锚点：chunkId / page / section（EvidenceLocation 同形，EvidenceStore.ts:45-66） */
  anchors: Array<{ chunk?: string; page?: number; section?: string; quote?: string }>;
  /** 关联冻结事实（数值 / 表格） */
  frozenFactIds: string[];
  status: "proposed" | "confirmed" | "rejected";
  confirmedAt?: string;
  /** 与其他小论文成果的关系（去重 / 演进），作者确认后生效 */
  relations?: Array<{ targetId: string; type: "same_as" | "extends" | "supersedes" | "conflicts" }>;
}
export interface ResearchContributionLedger {
  schemaVersion: 1; generatedAt: string;
  items: ContributionItem[];
  /** 提取用的模型 / prompt 版本（可审计；与 survey.json 的 matrix 口径同） */
  extraction: { algorithmVersion: string; perPaper: Record<string, { taskId?: string; status: "ok" | "failed" }> };
}
```
- 提取服务参考 `survey/MatrixService.ts`（逐篇结构化 + chunk anchor fail-closed，`matrixTypes.ts:144-178` 的 `SurveyMatrixEntry` 形态）；anchors 不可锚定时**如实空**，不伪造。

### 4.4 ThesisOutline（扩展 `Outline`，同一 `manuscript/outline.json`）

```ts
// manuscript/ManuscriptService.ts 扩展（additive）
export interface Outline {
  title: string; abstract?: string;
  sections: OutlineSection[];           // 既有：扁平节列表（thesis 模式下 = 全部叶子节，file 允许子目录）
  /** M14：章级结构；存在 = thesis 模式 */
  thesis?: {
    abstractEn?: string; keywords?: string[]; keywordsEn?: string[];
    chapters: ThesisChapter[];
    appendices?: ThesisChapter[];
  };
}
export interface ThesisChapter {
  id: string;                           // chap-intro / chap-method-a …
  title: string;
  responsibility: "background" | "literature_review" | "method" | "experiment" | "discussion" | "conclusion" | "appendix";
  sectionIds: string[];                 // 指向 Outline.sections[].id
  /** 本章拥有（完整展开）的成果与仅引用的成果 */
  ownsContributionIds: string[];
  referencesContributionIds: string[];
  /** 本章需要文献补证的缺口（步骤 6 的输入） */
  gaps: Array<{ id: string; description: string; claimType: EvidenceClaimType /* researchPlan.ts:33-40 */; status: "open" | "supplied" | "author_decision" }>;
}
```
- `validateOutline`（`ManuscriptService.ts:283-300`）在 thesis 模式下放宽节数上限（建议 ≤ 60）并校验 `file` 允许 `chapters/<chapId>/<slug>.tex`；`SECTION_FILE_PATTERN` 需扩展。`writeMainTex` 分派到模板引擎（§4.10）。

### 4.5 ChapterSourceMapping（新 store）

```ts
// thesis/ChapterMappingStore.ts：research/chapter-mapping.json
export interface ChapterSourceMapping {
  schemaVersion: 1;
  outlineFingerprint: string;           // 与 outline 结构字段指纹绑定（writingPlanFingerprint 同手法，definitions.ts:5274）
  entries: Array<{
    chapterId: string;
    sourcePaperId: string;
    contributionIds: string[];
    mode: "owner" | "reference";        // 完整展开 vs 引用式
    /** 继承到本章的图表 / 表格 */
    inheritedFigureIds: string[];
    frozenFactIds: string[];
    /** 本章来自该小论文的原文节（chunkId 范围），作为 Writer 的「可改写源文本」 */
    sourceSections: Array<{ sectionId: string; chunkIds: string[] }>;
  }>;
  status: "proposed" | "confirmed";
}
```

### 4.6 ConsistencyLedger（新 store）

```ts
// thesis/ConsistencyLedger.ts：research/consistency-ledger.json
export type LedgerEntryKind = "term" | "symbol" | "metric" | "dataset" | "baseline";
export interface LedgerEntry {
  id: string; kind: LedgerEntryKind;
  canonical: string;                    // 学位论文采用的统一写法（符号用 LaTeX 源）
  aliases: Array<{ text: string; sourcePaperId: string; anchors: string[] }>;
  definition?: string;
  /** metric 专用：协议五元组；不同协议不合并 */
  metricProtocol?: { dataset?: string; protocol?: string; split?: string; direction?: "higher" | "lower" | "unknown"; unit?: string };
  comparableWith?: string[];            // 作者确认可直接比较的其他 metric 条目
  status: "proposed" | "confirmed" | "rejected";
}
export interface ConsistencyLedger { schemaVersion: 1; entries: LedgerEntry[]; checks?: ConsistencyCheckReport[]; }
export interface ConsistencyCheckReport {
  revision: number; checkedAt: string;
  findings: Array<{ kind: LedgerEntryKind; chapterId: string; file: string; line?: number; surface: string; expected: string; severity: "blocking" | "warning" }>;
}
```

### 4.7 FrozenFact（新 store + 镜像进 EvidenceStore）

```ts
// thesis/FrozenFactStore.ts：research/frozen-facts.json（append-only；条目不可改，只可 supersede）
export type FrozenFactKind = "table_cell" | "prose_number" | "formula" | "directional_claim" | "citation_key" | "hardware";
export interface FrozenFact {
  id: string;                           // F001…
  sourcePaperId: string; kind: FrozenFactKind;
  value: string;                        // 归一化值（normalizeNumericToken 同口径）
  surface: string;                      // 原文片段（≤90 字符，与 FactFinding.before 同口径）
  context: { section?: string; tableLabel?: string; row?: number; column?: string; page?: number; chunk?: string };
  /** 镜像到 evidence.jsonl 的记录 id（verificationLevel=user_confirmed, verificationMethod=published_paper_frozen） */
  evidenceId?: string;
  status: "extracted" | "confirmed" | "superseded";
  supersededBy?: string;
  /** 授权改动记录（学位论文允许「更新为更好结果」的唯一路径） */
  authorizations: Array<{ at: string; newValue: string; basis: "author_decision" | "experiment_package"; ref: string }>;
}
```
- 与现有 store 关系：确定性提取复用 `buildRevisionBaseline`（`revisionBaseline.ts`）与 `extractDatasetsFromDocument`（`figures/datasets.ts:197`）；授权台账形态复用 `research/fact-authorizations.json`（`cumulativeFactPreservation.ts:86`）的 append-only 模式。Gate 新规则 `published_facts_zero_drift` 消费本 store。

### 4.8 InheritedFigureAsset（新 manifest，同 figureStore 纪律）

```ts
// figures/inheritedFigureStore.ts：manuscript/figs/inherited/manifest.json + <sourceId>/<assetName>
export interface InheritedFigureAsset {
  figId: string;                        // inh-<sha256(sourceId|assetName|bytesHash)[0:12]>
  sourcePaperId: string;
  origin: { kind: "latex_asset"; relativePath: string } | { kind: "pdf_extracted"; figureBlockId: string; assetName: string };
  bytesHash: string; mimeType: "image/png" | "image/jpeg" | "application/pdf";
  /** 相对 manuscript/：figs/inherited/<sourceId>/<assetName>（由 manifest 派生，不接受自由路径） */
  path: string;
  originalCaption?: string; caption: string; captionOrigin: "inherited" | "author_edited";
  originalLabel?: string; labelBody: string;    // 插入时 fig:<labelBody>
  /** 对应原表格数据（若为表格图 / 有 ParsedTableBlock） */
  tableBlockId?: string;
  insertedIn?: Array<{ file: string; revision: number }>;
}
```
- `insertion.renderFigureEnvironment` 增加受控路径来源；`writerGraphicsGuard` 不变；`figureAssets.ts` 增加 `inherited` 资产类型解析（白名单 + realpath 包含校验照抄）。

### 4.9 ChapterWritingState（扩展 `reviews/writing-plan.json`，不新建 store）

```ts
// 复用 beginWritingPlan / updateWritingPlanSection（definitions.ts:5533-5600）的 writing-plan 产物，增加章级聚合
export interface ChapterWritingState {
  chapterId: string;
  status: "pending" | "writing" | "written" | "failed" | "needs_author_decision";
  sections: Array<{ sectionId: string; status: "pending" | "written" | "failed"; revision?: number; taskId?: string; usage?: unknown; latencyMs?: number }>;
  /** 本章写作上下文指纹（mapping + ledger + frozenFacts + evidence 分配）；变更 → 重写 */
  contextFingerprint: string;
  /** 实验数据不足停机点 */
  authorDecision?: { reason: "missing_experiment" | "frozen_fact_conflict" | "unmapped_gap"; detail: string; decidedAt?: string; decision?: string };
}
```
- 恢复：`thesis.write_chapters` stage 执行前读本状态，`status === "written"` 且 `contextFingerprint` 一致的章**跳过**（这是对 §2.6「journal 不驱动跳过」缺口的最小修补）。

### 4.10 ThesisTemplate（新资源，非 store）

- `backend/resources/thesis-templates/<templateId>/{preamble.tex, cover.tex, frontmatter.tex, backmatter.tex, template.json}`；`template.json` 声明 `documentclass`（如 `ctexbook` / 学校 cls）、必需宏包、是否支持 `\chapter`、摘要 / 关键词环境名。`ManuscriptService.writeMainTex` 在 `outline.thesis` 存在时改走 `renderThesisMainTex(outline, template)`。学校专用 `.cls` 允许随 LaTeX 导入（`.cls/.sty/.bst` 已在白名单 `LatexImporter.ts:62-64`）。

---

## 5. 工作流状态机方案

### 5.1 11 步 → stage 映射与复用 / 新增 / 阻碍三分表

| # | 步骤 | Stage id（新） | 复用（坐标 / 契约） | 新增 | 阻碍（证据） |
| --- | --- | --- | --- | --- | --- |
| 1 | 导入已有小论文（PDF / LaTeX，可多篇） | `thesis.import_papers` | `SourceStore.addSource/attachFile`（`SourceStore.ts:310+`）、`IngestionService`（PDF→Docling，LaTeX→TextAssetParser，`IngestionService.ts:1-30`）、`zipReader` 防 Zip Slip、`LatexImporter` 的结构识别逻辑 L140-186（需抽成纯函数以复用而不写 manuscript/）、`RetrievalService.rebuildSource` | `SourcePaperRegistry`（§4.2）、`AUTHOR_PAPER` origin、LaTeX 快照目录 | `importPdf/importLatex` 一 PDF 一项目（`ProjectImportService.ts:85-130`）；`LatexImporter` 直写 `manuscript/`（L198-204）；`PaperStore` 单文件（`PaperStore.ts:55`）；`PaperReconstructor` 写 `manuscript/outline.json`（`PaperReconstructor.ts:7-11`）——四处都不能原样用于「多篇输入」 |
| 2 | 提取研究问题 / 创新点 / 方法 / 实验结论 | `thesis.extract_contributions` | `ResearcherService.analyzeExistingPaper`（`definitions.ts:5957-5993` 的 `import.understand` 形态：输出 contributions / weaknesses）、`MatrixService` 逐篇结构化 + anchor fail-closed 范式（`survey/MatrixService.ts`、`matrixTypes.ts:144-178`）、`outputParsing` | 面向 `ContributionKind` 的 prompt + 解析校验；逐篇 bounded 并发（`mapWithConcurrency`） | `analyzeExistingPaper` 消费整篇 `buildManuscriptDigest`（60k 截断）且结果落单例 `research/research.json`（`5970-5990`） |
| 3 | 建立 Research Contribution Ledger | `hitl.contribution_confirm`（HITL） | HITL 机制（`types.ts:71-84`）；确认语义参考 `hitl.matrix_confirm`（`definitions.ts:7633`）与实验组确认（`ExperimentPackageService.ts:1010+`） | `ContributionLedger` store；同时产出 `FrozenFact` 提取（`thesis.freeze_facts`，确定性：`buildRevisionBaseline` + `extractDatasetsFromDocument`）与 `ConsistencyLedger` 提案 | 冻结基线语义绑定 manuscript 修订链（`cumulativeFactPreservation.ts:295-304`）——需独立 FrozenFact |
| 4 | 自动规划章节 | `thesis.outline_plan` → `hitl.outline_confirm` | `WriterService.planOutline` 的 repair 循环（`WriterService.ts:302-330`, `OUTLINE_REPAIR_MAX_ATTEMPTS=2` L223）、`hitl.outline_confirm`（approve / revise ≤3 / cancel，`definitions.ts:5162`）、`argumentUnit.resolveArgumentUnits`、`TargetProfile`（`target/`，master_thesis 已在 `TARGET_PROFILES`） | thesis 大纲 prompt（章 → 节两级 + responsibility + owns/references）、`validateThesisOutline` | `buildOutlinePrompt` 「4–12 节」（`WriterService.ts:1875`）、`validateOutline` ≤20 节 + 扁平文件名（`ManuscriptService.ts:283-300, 60`）、`writeMainTex` ctexart/\section（L142-170） |
| 5 | 小论文成果映射到章节 | `thesis.map_sources` → `hitl.mapping_confirm` | `sectionEvidenceAllocation` 的确定性分配思想（§2.3）；Survey `OutlineSection.synthesisRefs/literatureRefs` 的「refs 契约 + 悬空 fail-closed」（`writingInvariants.ts:1-25`） | `ChapterSourceMapping` store；LLM 提案 + 确定性校验（每个 confirmed contribution 恰有一个 owner 章） | 无 |
| 6 | 章节缺口 Literature Research / Evidence Supply | 复用 `research.plan → hitl.research_plan → research.execute → hitl.evidence_supply → research.propose → evidence.ground`（`definitions.ts:5995-6266`）按章循环或一次性以 gaps 为输入 | 整条 M10.3 研究链 + `ResearchEvidenceSupply`（limits 12/6/6）+ `TargetedGroundingService` + `hitl.literature_selection` 推荐集（`7278`）+ 文献综述章可挂 `topic_survey` 的 `survey.matrix/synthesis` 服务（`WorkflowServices.survey/synthesis`） | 以 `ThesisChapter.gaps` 生成 ResearchPlan 的桥接；`gaps.status` 回写 | `research.json` 单 plan 链（`researchPlan.ts:8-10`）→ 多章缺口要么合并为一个 plan（queries 带 chapterId 标签），要么扩展为 per-chapter plan 文件 |
| 7 | 分章写作与扩展 | `thesis.write_chapters`（每章可独立 stage 实例或 stage 内按 ChapterWritingState 跳过） | `WriterService.writeSection` 契约（§2.6）、`experimentContext` 注入（`renderExperimentContextLines` L1989）、`evidenceSelection.selectForWriting`、`writerGraphicsGuard`、Workspace Guard（`ARCHITECTURE.md:614-643`）、`revisions.commit`、`sectionContext` 有界投影范式 | 章级 prompt：本章 mapping 的源文本投影 + FrozenFact 行 + Ledger canonical 口径 + 跨章 doNotExplain；按章 commit | `writing.sections` 单 stage 顺序全写、无跳过（`5553-5600`）；`verifyDod` 全节齐（5640）；Writer 新章不能 `\includegraphics` → 继承图需走 `FigureService.insert` 式受控插入（步骤 7 之后的确定性子步 `thesis.insert_inherited_figures`） |
| 8 | 跨章一致性检查 | `thesis.consistency_check`（确定性） | `crossSectionRedundancy`（复述）、`extractNumericTokens / extractMathSegments`（`review/styleInvariants.ts`）、`extractLatexHeadings`（含 `\chapter`）、`visualInventory`（`\ref` 未解析） | Ledger alias 扫描、跨章同指标异值对账、Gate 规则 `thesis_terminology_consistent / published_facts_zero_drift` | 现无任何术语 / 符号 / 指标检查（§3.2） |
| 9 | 缺真实实验数据 → Author Decision，不伪造 | `hitl.author_decision`（HITL，可多次） | `FeasibilityReport.requiredExperiments / missingRequirements`（`FeasibilityService.ts:36-45`）、`experimentPolicy` 零授权口径（`experimentPolicy.ts:21-55`）、`AUTHOR_DECISION_REQUIRED` 终态（`gates.ts:356,368`；`revisionTaskGate.ts:303,339`）、`RevisionActionType.author_decision_required`（`revisionPlan.ts:73`） | 触发条件（§5.4）与决策选项 | `hitl.feasibility_confirm` 允许 LOW/INSUFFICIENT 直接 approve（`definitions.ts:8342-8350`）——学位论文实验章必须**不允许** approve 绕过（新 HITL 的 options 不含 approve-with-missing） |
| 10 | 跨章 Review / Revision | 复用 `citation.verify → review.run → quality.gate → revision.plan → … → revision.validate → hitl.revision_validation`（`planSharedTail` 4234-4420） | 全部 M4.7–M6.7 修订安全链 + M11.4 分层判定 + `SectionReviewScheduler` 分章并发（`paper/SectionReviewScheduler.ts`） | review.run 的 thesis 分支：分章 digest + 一致性报告 digest；Gate 新规则 | `buildManuscriptDigest` 24 节 / 60k（`8613-8640`）；`reviewAll` 单字符串入参（`ReviewerService.ts:173-176`）；`isOwnResultClaim` 词面（`citationIntent.ts:5-7`） |
| 11 | 编译正式学位论文 PDF | 复用 `build.draft / build.final`（`definitions.ts:3541, 1721`）、`FinalizeService` 双 Gate 对齐（`artifacts/FinalizeService.ts:1-15`）、`ArtifactStore`（`art-draft/final-rev{n}`） | 编译器零改动（`LatexCompiler.ts` 整目录 staging） | ThesisTemplate 渲染（§4.10）；`WorkflowCompletion.label` 可沿用 `draft/final` | 模板缺 `\chapter` / 封面 / 目录 / 关键词（`ManuscriptService.ts:142-170`；Handoff (d)） |

### 5.2 Stage 列表（线性主干）

```text
thesis.import_papers            →  thesis.extract_contributions  →  thesis.freeze_facts (确定性)
→ hitl.contribution_confirm     →  thesis.outline_plan           →  hitl.outline_confirm (approve/revise≤3/cancel)
→ thesis.map_sources            →  hitl.mapping_confirm          →  thesis.ledger_propose (术语/符号/指标)
→ hitl.ledger_confirm           →  research.plan → hitl.research_plan → research.execute → hitl.evidence_supply
→ research.propose → evidence.ground                            (全部既有 stage，输入改为 gaps)
→ [hitl.author_decision]*       (条件：实验章缺授权数据 / FrozenFact 冲突 / 缺口未供给)
→ thesis.write_chapters         (fan-out：章间有界并发；章内顺序；按 ChapterWritingState 跳过)
→ thesis.insert_inherited_figures (确定性)
→ thesis.consistency_check      (确定性；blocking → revision.plan 条目，不进 HITL)
→ citation.verify → review.run(thesis) → quality.gate(thesis)
→ { revision.plan → evidence.ground_claims → revision.restore_facts → revision.revise → revision.validate
     → [hitl.revision_validation] → (repair / overflow / stalled HITL) }  (bounded loop，planSharedTail 原样)
→ [hitl.style_polish → revision.style_polish]
→ build.draft → build.final
```

每个 stage 的输入 / 输出 / HITL / 失败终态 / 恢复粒度：

| Stage | requiredInputs | producedOutputs | HITL | 失败分类 → 终态 | 恢复粒度 |
| --- | --- | --- | --- | --- | --- |
| `thesis.import_papers` | 项目 `thesis.sourcePaperIds` 非空 | `sources/author-papers/*/paper.json`、ParsedDocument、chunks | 否 | `permanent`（非 PDF / 非法 ZIP）→ run failed；`transient` 重试 | 按 sourceId 幂等（contentHash） |
| `thesis.extract_contributions` | import_papers | `research/contributions.json`（proposed） | 否 | `contract_violation`（JSON 不合法）重试 ≤ maxAttempts | 按 paper journal（已成功的 paper 不重跑） |
| `thesis.freeze_facts` | import_papers | `research/frozen-facts.json`（extracted）+ `evidence.jsonl` 镜像 | 否 | `contract_violation` → failed（确定性，不应失败） | 幂等重算 |
| `hitl.contribution_confirm` | 上两项 | 决策 payload（confirm / edit items / reject） | **是**（options：`approve` / `revise`≤3 / `cancel`） | — | awaiting_input 持久 |
| `thesis.outline_plan` | contribution_confirm | `manuscript/outline.json`（thesis 结构） | 否 | repair ≤2 次后 `contract_violation` | stage 级 |
| `hitl.outline_confirm` | outline_plan | 决策 | **是** | — | — |
| `thesis.map_sources` | outline_confirm | `research/chapter-mapping.json`（proposed） | 否 | `contract_violation`（owner 不唯一 / 悬空 id）→ repair → failed | stage 级 |
| `hitl.mapping_confirm` | map_sources | 决策 | **是** | — | — |
| `thesis.ledger_propose` / `hitl.ledger_confirm` | mapping_confirm | `research/consistency-ledger.json` | **是** | — | — |
| `research.*`（既有） | ledger_confirm | 既有产物 | 既有 HITL | 既有 | 既有 |
| `hitl.author_decision` | 条件触发（§5.4） | `stageResults["hitl.author_decision"] = { items[], decisions[] }` | **是**（options：`defer_chapter` / `write_as_limitation` / `attach_experiment_package` / `cancel`） | — | 持久 |
| `thesis.write_chapters` | mapping_confirm + evidence.ground（或 author_decision） | `manuscript/chapters/**/*.tex` + 按章 commit + `reviews/writing-plan.json`（章级） | 否 | 单章 `transient/timeout` 节内重试；全部章失败 → stage failed | **章级**（ChapterWritingState 跳过已写章） |
| `thesis.insert_inherited_figures` | write_chapters | `figs/inherited/manifest.json`、章节文件 append | 否 | `FigureLabelConflict` 等既有错误 → failed | 幂等（insertedIn 记录） |
| `thesis.consistency_check` | write_chapters | `consistency-ledger.json.checks[]`、`reviews/consistency-r{n}.json` | 否 | 不失败（findings 进 Reviewer / Gate） | 幂等 |
| 共享后段 | — | 既有 | 既有 | 既有 | 既有 |

### 5.3 与 D-0014 / 现有 Orchestrator 的兼容

- **线性主干**：上表全部可用 `plan(state)` 的「front 列表 + planSharedTail」模式表达（与 `createTopicSurveyDefinition` `definitions.ts:8251-8300` 同构）。
- **bounded loop**：(a) 修订 loop 原样复用 `planSharedTail`（`revisionBudget` 含 `counters["revision.manual_rounds"]`）；(b) 章节写作的「重试」是 stage 内按章有界重试，不是 workflow 级 loop；(c) `hitl.author_decision` 最多出现 N 次（`counters["thesis.author_decisions"]` 上限，超限 → `cancel` 或 `write_as_limitation`）。
- **fan-out / join**：章间并发用 `mapWithConcurrency`（`util/concurrency.ts`，`SectionReviewScheduler` 同款），join 在 stage 末尾 `writeMainTex + commit`。
- **stage id 动态性**：`WorkflowState.stageResults` 以 stage id 为键（`types.ts:156`），每章一个 stage 实例需要 `plan()` 产生 `thesis.write_chapter:<chapId>` 并由 definition 的 `stages` 在构造期按 outline 展开——但 `stages` 是构造期常量（`types.ts:185`），outline 在运行期才确定。**建议**：保持单 `thesis.write_chapters` stage，章级恢复由 `ChapterWritingState` 承担（不改引擎）；若后续需要 UI 章级时间线，再用 `stage.progress` 事件（`types.ts:152`）呈现。
- **HITL 回答新鲜度**：沿用「marker 中带 round / fingerprint」的既有手法（`planSharedTail` 的 `validationId` / `gateRound` 比对，`definitions.ts:4258-4270, 4310-4318`）。
- **恢复**：`recoverInterruptedRuns` 行为不变；`thesis.write_chapters` 重跑时读 `ChapterWritingState` 跳过 `written` 且 `contextFingerprint` 一致的章。
- **完成标签**：沿用 `draft / final`；`classifyTerminalStatus` 的 `AUTHOR_DECISION_REQUIRED` 语义不变。
- **前端**：`WORKFLOW_KINDS` / `WORKFLOW_KIND_LABELS` / `WORKFLOW_STAGE_SEQUENCES` / `STAGE_LABELS` 需同步新增（`kinds.ts:12-17`、`projectMeta.ts:11-27`、`status.ts:313, 470-556`）；`ThesisSelection` 接线到 `POST /api/projects`（显式 `workflowKind: "thesis_from_papers"`）+ 多文件 `import` 端点（新：`POST /api/projects/:id/thesis/papers`）。

### 5.4 `AUTHOR_DECISION_REQUIRED` 的触发条件（学位论文专用）

进入 `hitl.author_decision`（run → `awaiting_input`），而非让 Writer 继续，当且仅当以下任一成立（全部确定性判定）：

1. **实验章缺授权数据**：某 `responsibility === "experiment"` 章的 mapping 中 `frozenFactIds` 为空 **且** `experimentPackages.workflowContext()` 对该章声明的 dataset/metric 无 `allowed` 观测（`ExperimentPackageService.ts:1200-1230`）**且** `FeasibilityReport.requiredExperiments` 非空（`FeasibilityService.ts:41`）。
2. **冻结事实冲突**：同一 (metric, dataset, protocol) 在两篇小论文的 FrozenFact 值不同，且 Ledger 未标 `comparable: false` / 未授权 supersede。
3. **缺口未供给**：`ThesisChapter.gaps` 中 `claimType ∈ {benchmark, comparison}` 的条目在 `evidence.ground` 后仍 `open`（无 formal evidence），且该章 `responsibility ∈ {experiment, discussion}`。
4. **修订期触发**（沿用既有）：`claimResolution.action === "author_decision_required"`（`review/claimResolution.ts:43`）、`revisionTaskGate` 的 `AUTHOR_DECISION_REQUIRED`（`revisionTaskGate.ts:303`）。

决策选项与后果：`defer_chapter`（该章标 `needs_author_decision`，Writer 跳过，Gate 阻断 Final 但允许 Draft——D-0015 语义）；`write_as_limitation`（Writer 只写「未开展 / 待补」口径，注入 `experimentPolicy` 零授权行，`gates.ts:448` 口径不计阻断）；`attach_experiment_package`（引导走既有 `experiment-packages` 上传 + 范围授权，回到 `research.*` 前重新评估）；`cancel`。**不存在**「approve 继续写数值」选项——这是与 `hitl.feasibility_confirm`（`definitions.ts:8346-8349` 的 approve）的刻意差异。

---

## 6. 风险与未决问题

1. **Outline 两级化对既有消费者的冲击**：`sectionMatches`（`definitions.ts:9289`）、`buildManuscriptDigest`、`revisionValidation` 文件级归因、`visualInventory.linkedSection` 均假设扁平 `sections/`；允许 `chapters/<id>/*.tex` 后需逐一回归（`backend/test/manuscript/m1044DispatchMatch.test.ts`、`backend/test/workflow/revisionValidationFlow.test.ts` 是现成回归锚点）。【推断】
2. **`isOwnResultClaim` 词面漏判**：学位论文中「第三章方法」「文献 [12]（作者自己）」语境不含「本文 / 我们」时，自有数值 claim 会被当作外部事实要求 verified evidence → Gate 误阻断。需在 thesis 模式下把 FrozenFact 值表作为 `AuthorizedObservationValue` 注入（`claimGrounding.ts:78-83` 已有该结构）。【推断，需用例】
3. **Named Reference Guard 允许词表**：首稿写作（非修订）不经该守卫；修订时允许词表需包含全部小论文文本，否则作者自己在小论文中命名的方法会被拦。【推断】
4. **PDF 小论文的事实提取精度**：`PaperReconstructor` 文本级（公式转义文本），表格数值经 Docling `ParsedTableBlock` 可得，但公式类 FrozenFact 对 PDF 源基本不可用——报告中须如实标「仅 LaTeX 源支持公式冻结」。
5. **`research.json` 单链**：步骤 6 多章缺口若合并进一个 ResearchPlan，`hitl.research_plan` 一次批准覆盖全部章；若拆分则 `research/` 下需 per-chapter 文件并修改 `requireResearchArtifact` 等读取点（`definitions.ts` 多处）。待决策。
6. **模板合规性**：各高校学位论文模板差异大（cls 私有宏）；`writeMainTex` 的确定性组装与「用户上传 cls」之间的边界（哪些由系统生成、哪些原样透传）需产品决策；Build Gate 对缺字体 / 缺宏包的诊断（`latex/diagnostics.ts`）需覆盖 ctexbook 场景。
7. **预算与时长**：30–40 节写作 + 分章 Review + 修订 loop，单 run 模型调用量约为 Topic→PDF 的 3–5 倍（M13.8 报告 118 任务 / $1.73 为参照）；需要章级 `usage` 聚合（`ChapterWritingState.sections[].usage` 已预留）与预算帽 HITL。
8. **同一研究工作的多版本小论文**（会议版 / 期刊扩展版）：D-0034 的 `workKey / relatedSourceIds` 可表达，但 ContributionItem 去重（`same_as / supersedes`）需作者确认；自动判定不做。
9. **`AUTHOR_PAPER` Source 与 Workspace Guard**：Writer 文件工具目前可见 `sources/{papers,parsed,chunks}` 非实验包条目（`ARCHITECTURE.md:628-631`）——小论文全文对 Writer 可见是**期望行为**（改写源文本），但实验包来源仍不可见；需确认 guard 对 `sources/author-papers/` 的可见性策略。
10. **前端 Thesis 入口已有 UI 占位但零 API**（`NewProjectPage.tsx:156-199`）：接线时「从研究主题开始」分支应映射到既有 `idea_to_paper`（`documentType=master_thesis` 当前即如此），只有「基于已有小论文扩展」走新 kind——需 e2e 覆盖两条路径。
11. **未决**：学位论文是否需要「文献综述章」完整走 `topic_survey` 链（Matrix / Synthesis）还是只用 `research.*` 补证？前者质量高但预算大；建议 M14 第一版用 `research.*` + 可选挂载 `survey.matrix`。

---

## 7. 可复核清单（本报告引用过的全部文件）

文档：
- `CLAUDE.md`
- `docs/ARCHITECTURE.md`（§1.3 L130-162；§3 L219-320；§5 L344-368；§6.4.1 L614-643；§9 L889-960；§20 L1694-1719）
- `docs/DECISIONS.md`（D-0014 L179-190；D-0015 L192-205；D-0024 L409-420；D-0027 L497-515；D-0028 L517-537；D-0029 L538-556；D-0030 L557-580；D-0034 L678-720；D-0037 L848-880；D-0038 L931-960；D-0039 L1014-1050）
- `docs/PROJECT_STATUS.md`（首段）
- `docs/PRD.md`（L280-335）
- `docs/API_CONTRACT.md`（L60-104, L881）
- `docs/existing-paper-revision.md`（标题结构）
- `docs/research/M13_FINAL_CLOSURE.md`（L278-305）
- `docs/research/M13_8_NETWORK_AND_PRODUCT_CLOSURE.md`（L1-12, L191-203）

后端：
- `backend/src/project/ProjectStore.ts`、`backend/src/project/ProjectImportService.ts`
- `backend/src/import/LatexImporter.ts`、`backend/src/import/PaperReconstructor.ts`、`backend/src/import/assetInventory.ts`
- `backend/src/paper/PaperStore.ts`、`backend/src/paper/PaperIngestService.ts`、`backend/src/paper/PaperMapService.ts`、`backend/src/paper/SectionReviewScheduler.ts`、`backend/src/paper/types.ts`、`backend/src/paper/PdfParser.ts`
- `backend/src/ingestion/IngestionService.ts`、`backend/src/ingestion/ParsedDocumentStore.ts`、`backend/src/ingestion/types.ts`、`backend/src/ingestion/DoclingParser.ts`、`backend/src/ingestion/parserRegistry.ts`
- `backend/src/sources/SourceStore.ts`
- `backend/src/agents/researchPlan.ts`、`backend/src/agents/FeasibilityService.ts`、`backend/src/agents/ReviewerService.ts`
- `backend/src/evidence/EvidenceStore.ts`、`backend/src/evidence/ResearchEvidenceSupply.ts`、`backend/src/evidence/TargetedGroundingService.ts`、`backend/src/evidence/sectionEvidenceAllocation.ts`、`backend/src/evidence/protocolScope.ts`
- `backend/src/retrieval/contextPacker.ts`、`backend/src/retrieval/RetrievalService.ts`、`backend/src/retrieval/types.ts`、`backend/src/runtime/pi/contextBudget.ts`
- `backend/src/manuscript/ManuscriptService.ts`、`backend/src/manuscript/RevisionStore.ts`、`backend/src/manuscript/LatexFiles.ts`、`backend/src/manuscript/latexHeadings.ts`、`backend/src/manuscript/visualInventory.ts`
- `backend/src/workflow/kinds.ts`、`backend/src/workflow/types.ts`、`backend/src/workflow/runStore.ts`、`backend/src/workflow/WorkflowOrchestrator.ts`、`backend/src/workflow/definitions.ts`
- `backend/src/writer/WriterService.ts`、`backend/src/writer/argumentUnit.ts`
- `backend/src/review/revisionBaseline.ts`、`backend/src/review/namedReferenceGuard.ts`、`backend/src/review/revisionValidation.ts`、`backend/src/review/revisionPlan.ts`、`backend/src/review/revisionScope.ts`、`backend/src/review/claimGrounding.ts`、`backend/src/review/claimResolution.ts`、`backend/src/review/crossSectionRedundancy.ts`、`backend/src/review/externalInstructions.ts`、`backend/src/review/visualArtifactView.ts`
- `backend/src/quality/gates.ts`、`backend/src/quality/factPreservation.ts`、`backend/src/quality/citationPreservation.ts`、`backend/src/quality/cumulativeFactPreservation.ts`、`backend/src/quality/factRestore.ts`、`backend/src/quality/revisionTaskGate.ts`
- `backend/src/experiments/ExperimentPackageService.ts`、`backend/src/experiments/experimentPolicy.ts`
- `backend/src/figures/figureStore.ts`、`backend/src/figures/insertion.ts`、`backend/src/figures/writerGraphicsGuard.ts`、`backend/src/figures/FigureService.ts`、`backend/src/figures/spec.ts`、`backend/src/figures/datasets.ts`、`backend/src/figures/truthfulness.ts`
- `backend/src/vision/figureAssets.ts`
- `backend/src/citation/CitationIntegrityService.ts`、`backend/src/citation/bibliography.ts`、`backend/src/citation/StaticCitationChecker.ts`、`backend/src/citation/citationIntent.ts`
- `backend/src/latex/LatexCompiler.ts`
- `backend/src/survey/matrixTypes.ts`、`backend/src/survey/synthesisTypes.ts`、`backend/src/survey/sectionContext.ts`、`backend/src/survey/writingInvariants.ts`、`backend/src/survey/OutlineService.ts`、`backend/src/survey/outlineValidation.ts`、`backend/src/survey/CorpusSnapshotService.ts`
- `backend/src/artifacts/ArtifactStore.ts`、`backend/src/artifacts/FinalizeService.ts`
- `backend/src/errors.ts`、`backend/src/httpServer.ts`
- 测试目录（仅列目录以供回归锚点）：`backend/test/workflow/`、`backend/test/manuscript/`、`backend/test/import/`、`backend/test/quality/`

前端：
- `frontend/src/pages/NewProjectPage.tsx`、`frontend/src/constants/projectMeta.ts`、`frontend/src/types/api.ts`、`frontend/src/api/projects.ts`、`frontend/src/components/common/status.ts`、`frontend/src/components/project/workflowTimeline.ts`、`frontend/src/components/project/ProjectAside.tsx`、`frontend/src/pages/ProjectPage.tsx`
