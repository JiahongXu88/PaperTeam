# M12.0 — Fast Architecture & Implementation Audit（Publication Intelligence × Multimodal × Deterministic Figures）

> **日期：2026-10-07。执行代理：Claude Code。仓库：`D:\Projects\PaperTeam`（main，起点 HEAD == origin/main == `26950a4`，clean）。**
>
> **一句话结论：M12 三个方向的基础都比任务书假设的更成熟——Target 概念框架（documentType / targetProfile / targetVenue / sourceRole / D-0011 可行性档位）与 Vision 子系统（M10.2：Docling 抽图 + ImageContent 直调 + capability 降级 + Figure≠Evidence 纪律）已存在且在生产接线；真正的缺口是（A）Search 无 venue 过滤 / citationCount 不持久化 / targetProfile 只是 prompt 里一行字符串、（B）manuscript 侧无结构化 visual inventory、ReviewFinding 无 visual 类目、（C）零图表生成能力（Writer 显式禁 tikz）。本轮冻结：A=benchmark 语料复用 sourceRole="reference" + 新建 `research/target-benchmark.json`/`target-profile.json`/`target-readiness.json` 三 artifact；B=不新建持久 store，统一为 derived `VisualArtifactView` 投影 + manuscript LaTeX 环境 deterministic 解析；C=PlotSpec/DiagramSpec → TypeScript 确定性 codegen → pgfplots/TikZ → xelatex 独立编译 → vector PDF（零新运行时依赖、零 Python、零 image-gen）。下一轮可直接编码。**

---

## 1. Executive Verdict

| 决策项 | 冻结结论 |
|---|---|
| M12.1 Target Publication Intelligence | 复用既有 academic search + SourceStore；benchmark 语料 = `sourceRole: "reference"` 的 SourceItem + 冻结 manifest；Profile 为 project artifact（deterministic 提取为主 + bounded LLM 摘要为辅）；Target Readiness = **分维度四档分类判决 + 结构化 gap**，不造新分数 |
| M12.2 Multimodal | **Docling 主路线维持不变**；PDF 侧直接复用 ParsedFigureBlock / ParsedTableBlock / FigureAnalysis；新增 manuscript LaTeX visual 环境 deterministic 解析器；统一抽象为 **derived 投影 `VisualArtifactView`（不新建持久 store）**；多模态 runtime **已存在**（pi `ImageContent` + `completeSimple` + capability 目录元数据 + 降级码），无需新 Provider |
| M12.3 Figure Generation | **PlotSpec / DiagramSpec（TypeScript 类型 + 确定性校验）→ pgfplots / TikZ codegen → 独立 xelatex 编译 → vector PDF 资产**。不引入 Python 运行时、不引入 matplotlib / Plotly / Mermaid / Graphviz / image-gen |
| Benchmark ≠ Evidence 边界 | 机制已存在（D-0012 `sourceRole`，`isCorpusEligible` 已排除 reference）；M12.1 补一条：benchmark 论文只在 reference role 下入库，evidence 供给链按 role 过滤 |
| Writer 禁 tikz 的处置 | 维持 Writer **不写 tikz 源码**的红线；图表由确定性 codegen 产出 PDF，Writer/修订循环只消费已注册资产（`\includegraphics` 白名单），禁令改为「禁止手写图形宏包环境，允许引用注册资产」 |
| Quality / Readiness 语义 | 三层分离冻结：Correctness（既有确定性守卫）/ Publication Ready（M11.4 两层判定，不动）/ **Target Readiness（新，advisory 分类判决，非阻断）** |
| Jev-like | 不做 speculative abstraction；未来插入点 = Review 决策聚合层的服务 seam（同 FeasibilityService 模式）；不阻塞 M12.1–M12.3 |
| 本轮代码改动 | **零**（audit-only；见 §18.4 说明——所有 prerequisite 都属于本报告冻结的 schema，先冻结后实现） |

---

## 2. Current Git Baseline

```
branch: main
HEAD:         26950a49c61970242eb9484fe5d0eba670293931
origin/main:  26950a49c61970242eb9484fe5d0eba670293931   (HEAD == origin/main)
working tree: clean
```

`26950a4` = M11.5 closure（README 双语重写 + docs 8 篇 + MIT/CONTRIBUTING/SECURITY + UI IA 6 修）。与任务书给定的已知完成态一致。全程未新建分支，直接在 main 工作。

---

## 3. Existing Capability Audit

### 3.1 与 M12 直接相关、**已存在**的能力（含源码证据）

| 能力 | 位置 | 状态 |
|---|---|---|
| Target 三维元数据 `documentType` / `targetProfile` / `targetVenue` | `backend/src/project/ProjectStore.ts:40-48`（DOCUMENT_TYPES 7 值）、`:71-84`（TARGET_PROFILES 12 档）、`:87-115`（ProjectMetadata 字段） | 存在，但是**自由字符串，只被逐字拼进 prompt**（`ReviewerService.ts:614`、`WriterService.ts:773/1672`、`FeasibilityService.ts:344-347`） |
| Target Feasibility Assessment（D-0011） | `backend/src/agents/FeasibilityService.ts:27-58`（HIGH/MEDIUM/LOW/INSUFFICIENT + missingRequirements/requiredExperiments/criterionApplicability），落盘 `research/feasibility.json` | 已实现；**纯 LLM 先验，无任何实证参照系**——M12.1 的接入点 |
| Reference ≠ Evidence 语义（D-0012） | `SourceRole = "evidence" \| "reference" \| "both"`（`sources/SourceStore.ts:44`）；survey corpus 资格判定显式排除 reference（`survey/CorpusSnapshotService.ts:106-108`） | 已实现 |
| Academic search 多 provider | OpenAlex / Semantic Scholar / arXiv / AMiner（`serviceStack.ts:431-455` 注册）+ SearXNG；RRF 融合（`search/fusion.ts:19-27`）+ 分层 identity 去重（`sources/identity.ts:227-248`，doi>arxiv>pmid>title-fingerprint>url） | 已实现（细节缺口见 3.2） |
| OA 全文获取 | `search/fullText.ts`（Unpaywall / OpenAlex-OA / arXiv-PDF 三 resolver 链，SSR 逐跳护栏，%PDF- 魔数校验）+ `tryResolveFullText` 原地补挂（`sources/SourceImportService.ts:561-695`） | 已实现 |
| 候选→转正→冻结流水线先例 | CandidateStore（`selectionReason` 字段，`sources/CandidateStore.ts:62-74`）→ promote → SourceStore；corpus 冻结 revision 模式（`survey/CorpusSnapshotService.ts:220-244` 幂等冻结、`:286-345` refresh=revision+1+指纹），artifact 在 `research/corpus-snapshot.json`（项目级） | 已实现——**M12.1 benchmark 冻结直接照抄此模式** |
| PDF 结构化 ingestion（Docling） | `ingestion/DoclingParser.ts`（python 子进程，`backend/tools/parse_document_docling.py`，`do_table_structure=True` TableFormer、figures 抽取 PNG 落 `sources/figures/<sourceId>/`、bbox/page/caption 保留）；不可用显式降级 `LegacyPdfTextParser`（`degradedFrom` 审计） | 已实现 |
| 块级 provenance 数据模型 | `ingestion/types.ts:50-87` ParsedProvenance（fileName/page/section/row/column/**bbox**/parserBlockId/lineStart/jsonPath/cellIndex…）；7 种块类型 text/table/figure/formula/structured_record/code/output（`:247-255`） | 已实现 |
| 表格结构化 | `ParsedTableBlock`：caption + headers + rows 网格 + rowCount/columnCount（`ingestion/types.ts:105-113`） | 已实现（Docling TableFormer） |
| Vision 多模态分析（M10.2） | `vision/VisionAnalyzer.ts:109-125`：pi `ImageContent`（base64+mimeType）直调 `completeSimple`；结构化输出校验 + 1 次 repair；freshness 四键（imageHash/modelSpec/schemaVersion/contentHash）；落盘 `sources/analysis/<sourceId>.vision.json`；HTTP `POST /:id/sources/:sid/vision/analyze` 等（`httpServer.ts:1306-1359`）；检索投影 `retrieval/figureSections.ts:74-97` | 已实现且生产接线（用户触发式） |
| Vision capability 解析与降级 | `vision/capabilities.ts:16-18`（唯一依据 = Pi 模型目录 `Model.input` 含 `"image"`，unknown 保守判不可用）、`:30-45`（visionModel > defaultModel 两 slot）；不可用原因码 `not_configured/no_vision_model/model_not_in_catalog/auth_missing`（`vision/types.ts:206-210`）；`visionModel` 为一等设置项（`settings/ModelSettingsService.ts:575-578` 保存时校验） | 已实现——**任务书要求的 vision supported/enabled + unsupported/degradation 已原样存在** |
| Figure ≠ Evidence 纪律 | `vision/types.ts:7-14`：FigureAnalysis 是 Derived Context；candidateFacts 进 EvidenceStore 必须用户显式确认（`VisionAnalysisService.confirmFactEvidence`，恒 `verificationLevel=user_confirmed` + `status=unverified`）；`EvidenceLocation` 已含 `figureBlockId/assetName/visionFactRef/bbox`（`evidence/EvidenceStore.ts:56-64`） | 已实现 |
| Pi SDK 多模态消息类型 | `@earendil-works/pi-ai/dist/types.d.ts:275-278` `ImageContent{type,data,mimeType}`；`:369` `UserMessage.content: string \| (TextContent\|ImageContent)[]`；`:906` `BaseModel.input: ("text"\|"image")[]`；`:879-897` `ModelImageInputLimits` | SDK 原生支持 |
| LaTeX 手稿表格/图引用确定性解析（先例） | `review/revisionBaseline.ts:151-179`（table 环境 label/caption/tabular 网格）、`manuscript/LatexFiles.ts:144-147`（`\includegraphics` 路径收集）、`quality/factPreservation.ts` 同款表解析 | 已实现（但只服务于 baseline/守卫，无完整 figure 环境 inventory） |
| LaTeX 工具链 | `latex/LatexCompiler.ts:6-23`：xelatex + bibtex 显式编排（MiKTeX / TeX Live / WSL 一致），整棵 `manuscript/` cp 进 `build/` 编译 | 已实现 |
| Workflow 引擎 + 新 kind 成本 | `WorkflowDefinition = stages + plan + onInput`（`workflow/types.ts:182-193`）；topic_survey 集成（`definitions.ts:7223-7308` + `planSharedTail:3983` 共享尾段 + `index.ts:306-317` 路由）是完整模板 | 新增 stage/kind 全模式化，引擎零改动 |
| 质量分层（M11.4） | `revisionTaskGate.ts`（RevisionTaskVerdict PASS/FAIL/AUTHOR_DECISION_REQUIRED + PublicationVerdict READY/NOT_READY/AUTHOR_DECISION_REQUIRED 两层）；~22 条确定性规则（`quality/gates.ts:367-719`）；floor provisional 不启用 | 已实现——Target Readiness 作为**第三层 advisory** 挂进同一报告结构 |
| 测试基建 | 232 个 test 文件；scriptedRuntime（按 contextScope 脚本化）、scriptedVisionRuntime、fake fetch 注入 ProviderHttpClient、e2e/fixtures/fakebin（fake xelatex/bibtex） | 齐备 |

### 3.2 真实缺口（同样以源码为据）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G1 | **SearchOptions 无 venue / field / paper-type 过滤**——只有 `limit/yearFrom/yearTo/openAccessOnly/language/signal`（`search/types.ts:16-26`）；OpenAlex provider 只发 `search/per-page/publication_year/is_oa/mailto`（`openalexProvider.ts:70-92`），而 OpenAlex API 本身支持 `primary_location.source.id` / `type` 服务端过滤 | M12.1 需要按 venue 捞 benchmark 论文，今天只能把 venue 拼进关键词 + 客户端后滤 |
| G2 | **venue 是未归一化原始字符串**：OpenAlex `primary_location.source.display_name`（source id 被丢弃，`openalexProvider.ts:154-167`）、S2/AMiner 原样；arXiv provider 无 venue | venue→层级识别无数据地基 |
| G3 | **citationCount 是易失的**：fusion 时 max 合并（`fusion.ts:191-199`）但 CandidateSource / SourceMetadata 均无该字段（`CandidateStore.ts:45-54`、`SourceStore.ts:88-99`），入库即丢；corpus 推荐只按年份倒序（`definitions.ts:6180-6195`） | 无法按影响力挑 benchmark |
| G4 | **targetProfile/targetVenue 无任何实证内容**：Reviewer prompt 只有「结合目标档次标准执行（目标档次：top_journal）」一行（`ReviewerService.ts:614`）——模型并没有可执行的标准 | M12.1 核心命题 |
| G5 | **manuscript 侧无结构化 visual inventory**：ingestion 的 .tex 路径是纯文本（`textAsset.ts:10`「无 TeX AST」）；revisionBaseline 只解 table 环境；figure 环境（`\begin{figure}`/`\caption`/`\label`/`\ref`）无处结构化 | M12.2 需要 |
| G6 | **ReviewFinding 无 visual 类目**：categories = fact/academic/style/citation/consistency（`review/finding.ts:11`），provenance 三元组 sectionId/page/chunkId（`:28`）无 figure 锚 | M12.2 需要 |
| G7 | **零图表生成**：全仓 grep `tikz/pgfplots/matplotlib/plotly/graphviz/mermaid` 仅命中 Writer prompt 三处禁令（`WriterService.ts:1232/1420/1839`「不使用 tikz 等其他宏包」）；修订边界规则明言「图形以文字描述或 table 呈现，否则无法编译」（`:1421`） | M12.3 核心命题 |
| G8 | **抽取图片资产无 HTTP 服务路由**：`sources/figures/` 只被 vision 管线服务端读取（agent 审计确认 httpServer 无 serve 路由） | M12.2 UI 展示图需要 |
| G9 | AgentRuntime agent-loop 为纯文本（`RunAgentInput.task: string`，`runtime/types.ts:84`；`session.prompt(text)`，`PiRuntimeAdapter.ts:2197`）；vision 走旁路 `completeSimple`（无 session/trace/HITL） | M12.2 的视觉评审沿用 VisionAnalyzer 旁路模式即可（有界任务不需要 session），不必改 AgentRuntime |

### 3.3 关联但非本里程碑结论

- Writer 可用宏包白名单 = amsmath/amssymb/natbib（`ManuscriptService.ts:118-121`）；图插入需在模板加 `\usepackage{graphicx}`（所有 TeX 发行版核心包，风险极低；pgfplots 只进独立编译的 figure 文档，不进正文）。
- `ManuscriptOverview` / digest 无 figure 维度（`ManuscriptOverviewService.ts:38-49`；`buildManuscriptDigest` 纯文本切片 `definitions.ts:7585-7612`）。
- e2e fixtures 已有 fake xelatex/bibtex（`e2e/fixtures/fakebin/`）——M12.3 的 FigureCompiler 测试可复用此手法。

---

## 4. Target Publication Intelligence（M12.1 设计）

### 4.1 产品链路（冻结）

```
Project target（documentType + targetProfile + targetVenue? + researchField）
  → Benchmark Discovery（复用 academic search + 新 venue 过滤/引用数排序）
  → HITL 确认（hitl.benchmark_selection，推荐 8–15 篇，可增删/手动上传）
  → 以 sourceRole="reference" 入 SourceStore → 冻结 research/target-benchmark.json
  → TargetProfileService：deterministic 提取 + bounded LLM 摘要 → research/target-profile.json
  → TargetGapService：current manuscript vs profile → research/target-readiness.json（四档判决/gap）
  → 消费：Feasibility prompt / Reviewer academic prompt / Planner gap 输入 / Quality Gate advisory 层 / UI Target 面板
```

### 4.2 对任务书九问的裁决

1. **Profile 是 run-local 还是 project artifact？** Project artifact。理由：D-0013（Authoritative State 落盘为项目事实）+ corpus-snapshot 先例（`research/` 项目级）。同一 target 下多次 run 复用；target 变更（`hitl.feasibility_confirm` 已支持调整 targetProfile/targetVenue，`definitions.ts:7314`）触发 re-profile（revision+1）。
2. **是否持久化？** 是。三个 JSON：`target-benchmark.json`（冻结语料）、`target-profile.json`（derived 但落盘，含 freshness 键：corpusFingerprint + extractorSchemaVersion）、`target-readiness.json`（每次评估覆写，带 evaluatedAt + manuscriptRevision）。
3. **Benchmark corpus 是否冻结？** 是。照抄 `CorpusSnapshotService` 的 revision 模式：冻结后普通 resume no-op，显式 refresh 才 revision+1。冻结 = 稳定参照系，防止 profile 漂移。
4. **benchmark paper 与普通 Literature/Evidence 如何区分？** 唯一键 = `sourceRole`。benchmark 论文入库时恒置 `"reference"`。现有代码已经排除 reference 参与 survey corpus（`CorpusSnapshotService.ts:106-108`）；M12.1 增补：evidence 供给与 grounding 的 source 选择同样按 role 过滤（`evidence/revisionSourceSelection.ts` / `EvidenceSelectionService` 消费 `role != "reference"` 的源；纯 reference 源不进 evidence candidate 链）。
5. **如何避免污染 EvidenceStore？** 三重：(a) role 过滤（上条）；(b) Profile 提取直接读 ParsedDocument（parser facts），不经过 evidence pipeline；(c) vision candidateFacts 确认入口对 reference 源禁用（UI 不提供该动作；服务端 `confirmFactEvidence` 校验 role）。语义红线沿用 `vision/types.ts:11-14`：benchmark 论文回答「这类论文通常怎么写」，不回答「claim 是否被支撑」。
6. **venue target 与抽象 level target 如何统一？** 统一为 `TargetSpec`：`{documentType, targetProfile(12 档枚举), targetVenue?: string}`。resolution 规则：显式 venue → venue→OpenAlex source-id 解析（新 `search/venueResolution.ts`：优先内置种子表，miss 时调 OpenAlex `/sources?search=` 一次并缓存）；无 venue → 按 targetProfile 档位映射到 venue 集合启发式（如 top_conference → 种子表内该领域顶会并集；种子表是可扩展的 curated JSON，承认覆盖有限、缺失时如实降级到关键词+引用数排序）。**不承诺通用 venue 分级**——这正是 M11.4 校准审计「不造未校准断言」纪律的延续。
7. **Profile 如何进入 Writer/Reviewer/Gate？** 见 §4.4。原则：**rubric/context，不是 Writer 直接控制器**。
8. **Profile 直接控制 Writer？** 否。Writer 只得到数值/结构期望（如「目标带内论文正文 8–12 页、5–9 个图 + 表、方法节含 1 个 overview 图、实验节含 ≥1 ablation 表」），**永远得不到 benchmark 论文正文**（防 style cloning / plagiarism 的结构性保证——语料文本根本不进写作上下文；与 D-0012「Style Profile 是 Derived 产物、禁止复制参考论文内容」一致）。
9. **目标期刊样本不足？** 诚实降级：n < 5 → 该维度 verdict = INSUFFICIENT_EVIDENCE + confidence low + 明示缺口；允许用户手动上传该期刊 PDF（import 为 reference role）补充。绝不静默放宽。

### 4.3 TargetPublicationProfile schema（冻结，schemaVersion 1）

```ts
// backend/src/target/types.ts（新模块）
interface TargetBenchmarkArtifact {           // research/target-benchmark.json（冻结）
  schemaVersion: 1;
  revision: number;                           // CorpusSnapshot 同款
  createdAt / updatedAt: string;
  fingerprint: string;                        // 参与语料行的 sha256（含 citationCount/venue）
  target: { documentType: string; targetProfile: string; targetVenue?: string;
            researchField?: string; timeWindow?: { from?: number; to?: number } };
  papers: Array<{
    sourceId: string;                         // SourceStore 主键（sourceRole="reference"）
    identityKey: string;                      // 冻结时身份快照
    provenance: { provider: string; retrievedAt: string; queryUsed: string };
    inclusionReason: string;                  // 复用/借形 CandidateStore.selectionReason 语义
    citationCount?: number;                   // 发现时快照（补 G3）
    venueRaw: string;                         // 未归一化 venue 原文（诚实）
    hasFullText: boolean;
    excluded?: { reason: string; at: string }; // 冻结后显式剔除（revision+1）
  }>;
}

interface TargetPublicationProfile {          // research/target-profile.json（derived，落盘）
  schemaVersion: 1;
  benchmarkRevision: number;                  // 溯源到冻结语料
  corpusFingerprint: string;                  // freshness 键
  extractorSchemaVersion: number;             // 提取器演进即失效
  n: number;                                  // 有效样本数
  dimensions: {
    structure:   { sectionPattern: Record<string, { present: number; medianLengthWords: number }>;
                   totalLengthWords: Distribution; abstractLengthWords: Distribution };
    literature:  { citationCount: Distribution; citationDensity: Distribution /* per-100-words */;
                   recency: { medianAgeYears: number }; coverageNote: string };
    experiments: { tableCount: Distribution; datasetBreadth: Distribution /* distinct datasets per paper */;
                   ablationPresent: number /* 0-1 比例 */; robustnessPresent: number; note: string };
    visuals:     { figureCount: Distribution; figureTypeMix: Record<FigureType, number>;
                   methodDiagramPresent: number; tableStyle: string /* booktabs/plain 比例 */ };
    method:      { depthNote: string; noveltyFramingNote: string };   // LLM 摘要（标 provenance="model_summary"）
    writing:     { claimStrengthNote: string; limitationsPresent: number; discussionDepthNote: string };
  };
  // Distribution = { n, min, p25, median, p75, max }（确定性分位数，无模型参与）
  provenance: { deterministicFields: string[]; modelSummarizedFields: string[]; model?: string };
}

type TargetVerdict = "MEETS_TARGET" | "PARTIALLY_MEETS_TARGET" | "BELOW_TARGET" | "INSUFFICIENT_EVIDENCE";

interface TargetReadinessArtifact {           // research/target-readiness.json
  schemaVersion: 1;
  evaluatedAt: string;
  benchmarkRevision: number;
  manuscriptRevision: number;                 // 对齐 revision snapshot
  dimensions: Array<{
    dimension: "structure" | "literature" | "experiments" | "visuals" | "method" | "writing";
    verdict: TargetVerdict;
    observed: string;                         // 当前稿实测（确定性优先）
    targetRange: string;                      // 来自 profile 分位带
    gaps: string[];                           // 结构化差距（可被 Planner 消费）
    confidence: "high" | "medium" | "low";    // n 与确定性来源决定
    evidenceBasis: string;                    // 哪些 parser facts 支撑
  }>;
  overall: { verdict: TargetVerdict; summary: string };
}
```

设计要点：
- **确定性字段与模型字段显式分离**（`provenance.deterministicFields` vs `modelSummarizedFields`）。结构/文献/实验/视觉四维的分位数全部来自 ParsedDocument + bib 计数（确定性）；method/writing 两维允许 bounded LLM 摘要（明确标注）。
- `Distribution` 用分位数而非均值±方差——小样本（8–15 篇）下分位带更诚实。
- 表格枚举复用 `FigureType`（`vision/types.ts:20`）。
- 反抄袭：profile 里没有任何 benchmark 论文原文。

### 4.4 消费点（全部是既有 seam 的最小扩展）

| 消费者 | 接入方式 | 改动面 |
|---|---|---|
| FeasibilityService | `buildFeasibilityPrompt`（`FeasibilityService.ts:294`）追加「===== 目标实证参照系 =====」块（profile 摘要 + readiness gaps）——把今天的 LLM 先验变成有参照系的判断 | prompt 拼接 + 入参 |
| ReviewerService（academic 模式） | `buildReviewPrompt` 的 targetProfile 一行（`ReviewerService.ts:614`）替换为 profile 数值期望摘要；rubric 获得「目标带」锚点 | prompt 拼接 |
| Planner（existing_paper_improvement） | readiness gaps（结构化字符串数组）注入 improvement plan 上下文（作为作者可选输入，**不自动立项**——修订范围仍由外审意见与作者裁决主导） | prompt 拼接 |
| Quality Gate | `QualityGateResult` 增 advisory 字段 `targetReadiness?`（不进 ~22 条规则、不影响 revisionTaskSuccess/publicationReadiness 判定） | gates.ts 输出结构 additive |
| Writer | 仅数值/结构期望（见 4.2-8） | prompt 拼接 |
| UI | ProjectPage 新 TargetPanel（语料表 / 分位带 / 判决徽章） | 前端新组件 |

### 4.5 Search 复用裁决（对任务书 4.2 的直接回答）

**能复用，且是主干；需要三个有界扩展。**

可直接复用：4-provider fan-out（`academicSearchService.ts`）、RRF+identity 去重、OA 全文链、saveAsCandidates→promote→SourceStore 链路、corpus 冻结 revision 模式。

有界扩展（全部 additive）：
1. `SearchOptions` 增可选 `venueSourceIds?: string[]`（OpenAlex source id）与 `venueNames?: string[]`（客户端匹配其它 provider）；`openalexProvider` 映射为 `filter=...,primary_location.source.id:S1|S2`（OpenAlex 原生支持，provider 今天没发而已）。其余 provider 客户端后滤 venueRaw。
2. `SourceMetadata` 增可选 `citationCount?: number`（发现时快照；`normalizeMetadata` 防御式补键已向后安全——M11.5 确认 additive optional 是安全演化）。
3. 新 `search/venueResolution.ts`（venue 名 → OpenAlex source id；种子表 + 一次 API 查询缓存）。

不复用的：不建新 provider、不动 fusion 权重、不做「venue 质量分级」承诺（G2 的诚实答案是没有可靠的通用 venue 分级数据源；种子表覆盖 top 场景，其余如实 INSUFFICIENT）。

---

## 5. Benchmark Corpus vs Evidence Boundary（冻结）

四道隔离（前两道已存在，后两道 M12.1 实现）：

1. **角色隔离（已存在）**：`sourceRole="reference"` 不进 survey corpus（`CorpusSnapshotService.ts:106-108`）；M12.1 把同一谓词用于 evidence source 选择。
2. **管线隔离（已存在）**：Evidence 三段核验（quote 逐字/metadata/semantic judge，`EvidenceGroundingService.ts:4-23`）只消费 evidence/both 源的 chunk；benchmark 论文的 ParsedDocument 不进该链。
3. **UI/服务端隔离（新）**：reference 源的 vision candidateFacts 不提供「确认进 Evidence」动作；`confirmFactEvidence` 服务端校验 role。
4. **语义文档隔离（已存在，写进 M12 报告重申）**：D-0012——「这类论文通常怎么写」≠「这篇论文说了什么」。Profile 提取只读 parser facts + bib 元数据，不产生 EvidenceRecord。

Benchmark Paper 与 Search Candidate / Source / Evidence 的关系一句话：**benchmark paper 是 SourceStore 里 role=reference 的普通 SourceItem**（享受同一去重/全文/解析设施），**额外被一个冻结 manifest 引用**；它永远不会成为 EvidenceRecord 的 source。

---

## 6. TargetPublicationProfile Design

见 §4.3 schema 与 §4.2 九问。补充三点最终裁决：

- **为什么不是 run-local**：Profile 的价值是跨 run 稳定参照 + 可审计（M11.4 的教训：不可复现的评分不可信）；run-local 会让每次评审换参照系。
- **为什么 profile 落盘但可重建**：D-0013 三层模型——它是 Derived Context（可由冻结语料 + 提取器重建），落盘是为了确定性（同语料同 profile）与 UI 即读。freshness 键 `corpusFingerprint + extractorSchemaVersion` 保证不会用到陈旧 profile。
- **为什么 readiness 独立成 artifact 而不是 profile 的一部分**：readiness 每次评审/修订都会变（绑定 manuscriptRevision），profile 只随语料变。分离后 revision lineage 清晰。

---

## 7. Current PDF / LaTeX Visual Capability（现状清单，全部源码为据）

### 7.1 PDF（Docling 路径，`sources/` 库）——**已有**

| 数据 | 有无 | 位置 |
|---|---|---|
| text（含 textKind: paragraph/title/section_header/list_item/caption） | ✅ | `ingestion/types.ts:98-102` |
| page（1-based） | ✅（Docling 提供；pymupdf 降级路径有页码；builtin 兜底无页码不伪造） | `ParsedProvenance.page` |
| heading 层级 | ⚠️ 扁平（section_header 无 level 嵌套；层级在 paper 域另一模型） | `textAsset.ts:229-236` 注释 |
| caption（figure 与 table 各自持有） | ✅ | `types.ts:108,118` |
| bbox（0-100 归一化，Docling 版面） | ✅ | `types.ts:38-44,73` |
| 表格结构（headers/rows 网格） | ✅ TableFormer | `types.ts:105-113` |
| 图片资产落盘（PNG，`sources/figures/<sourceId>/fig-001.png`） | ✅（上限 200 张；超限记 `visualOutputPresent` 不丢事实） | `types.ts:116-130`、`ParsedDocumentStore.figuresDir` |
| 图片宽高 | ⚠️ 仅上传图/Notebook 输出可读 header；PDF 抽取图无宽高 | `types.ts:121-124` |
| figure 类型（chart/diagram/...） | ⚠️ 仅 VisionAnalyzer 模型分类（可选、可能 skipped） | `vision/types.ts:20` |
| 公式 LaTeX | ⚠️ Docling formula enrichment 存在但生产未开（`--formulas` 未传） | agent 审计 + `IngestionService.ts:193-195` |
| LaTeX label / \ref 引用 | ❌ | — |
| 跨页表格合并 | ❌（块级切割） | — |
| raster/vector 区分 | ❌ | — |
| nearby text（图前后文） | ⚠️ 不存储；vision 分析时按 2400 字符预算现取 | `vision/types.ts:165-166` |
| 图片字节 HTTP 服务 | ❌（G8） | — |

### 7.2 手稿侧（LaTeX，`manuscript/`）——**几乎没有**

| 数据 | 有无 | 位置 |
|---|---|---|
| 全 .tex 收集（\input/\include 递归 + bib 定位） | ✅ | `LatexFiles.ts:23-110` |
| `\includegraphics` 路径列表 | ✅（仅路径字符串） | `LatexFiles.ts:144-147` |
| table 环境（label/caption/tabular 网格） | ✅（仅 baseline 投影，非 inventory） | `revisionBaseline.ts:151-179` |
| figure 环境结构化（caption/label/位置/引用它的正文 \ref） | ❌ | — |
| figure 资产渲染预览 | ❌ | — |

### 7.3 手稿 digest / Overview | 均无 figure 维度（纯文本切片） | `definitions.ts:7585-7612` |

**结论**：PDF 侧「视觉事实层」完备（parser facts）+「视觉理解层」可用（vision，依赖模型配置）；手稿侧是 M12.2 的主要新建面，且工程上是低风险确定性解析（revisionBaseline 已有同款正则先例）。

---

## 8. PaperVisualArtifact Design（冻结）

### 8.1 裁决：**不新建持久 artifact 物种；新建统一只读投影 `VisualArtifactView`**

理由：
- D-0013 纪律——视觉事实已有三个权威源（PDF: `sources/parsed/<id>.document.json` 块；LaTeX: manuscript .tex 本身；生成图: M12.3 的 figure store）。再造一个持久 store = 第二事实源，必然漂移。
- 真正缺的是**消费视角的统一形状**（reviewer 要同时看三方）。

```ts
// backend/src/review/visualArtifactView.ts（新，纯投影函数，无 IO）
type VisualArtifactView = {
  id: string;                       // 稳定视图 id："pdf:<sourceId>:<blockId>" | "tex:<file>:<envIndex>" | "gen:<figId>"
  kind: "figure" | "table";
  sourceKind: "pdf_parsed" | "latex_env" | "generated";
  caption?: string;
  label?: string;                   // LaTeX \label（latex_env/generated）
  assetRef?: string;                // 图片资产（pdf: figures/<sourceId>/<assetName>；gen: figs/generated/<figId>.pdf）
  page?: number; bbox?: BBox;       // pdf_parsed 专有（parser fact 拷贝）
  tableGrid?: { headers: string[]; rows: string[][] };   // table 专有（两源同形）
  referencedBy: string[];           // 正文 \ref 位置（latex_env/generated；pdf 侧缺省）
  analysis?: FigureAnalysis;        // pdf_parsed 且已完成 vision 分析时附带
  provenanceNote: string;           // 人读溯源（权威源在哪）
};
```

对任务书 8 节九问：
1. **PDF 与 LaTeX 共用模型？** 共用**视图**（`VisualArtifactView`），不共用持久模型——权威源不同（ParsedDocument vs .tex 文件）。
2. **Table 是 subtype？** 是：`kind: "table"` 同一视图形状（`tableGrid`）；持久层本就分立（ParsedTableBlock / LaTeX table 环境）。
3. **figure/chart/diagram 区分？** 视图层不强制——`figureType` 细分类继续由可选 vision 分析提供（`vision/types.ts:20`）；确定性层只保证 figure/table 二分。不为此增加解析负担。
4. **caption 确定性绑定？** PDF：Docling 块级 caption 已绑定（块自带）；LaTeX：环境内 `\caption{}` 正则捕获（同 revisionBaseline 手法），跨环境找不到 caption 的 figure 如实 `caption: undefined` + review finding。
5. **跨页 table？** v1 不合并——每个 Docling 块独立成 view，`provenanceNote` 标注页码；跨页合并留给后续（低频且有歧义风险）。
6. **raster/vector？** 不区分（G 表已列 ❌）；PDF 抽取资产一律按 PNG 处理，vector 源图的语义分析走 vision 模型渲染路径。
7. **LaTeX 原始 source asset？** `.tex` 文件本身即权威源；generated 图另存 `.tex` 源（M12.3 store）。
8. **view ID 由谁生成？** 投影函数按权威源坐标确定性生成（无随机、无 UUID）——同输入同 id。
9. **machine-owned invariants？** (a) view 无 IO、可随时重建；(b) view 字段是权威源拷贝，禁止反向写回；(c) pdf 视图的 `analysis` 仅在 freshness 四键全同时附带（`vision/types.ts:102-110`）。

### 8.2 新建：`research/manuscript-visuals.json`（手稿侧唯一新落盘物）

LaTeX figure/table 环境 inventory（derived、可重建、服务 review 与 readiness 的 visuals 维度）：

```ts
interface ManuscriptVisualInventory {
  schemaVersion: 1;
  manuscriptRevision: number;            // 对齐 RevisionStore
  files: Array<{
    file: string;                        // 相对 manuscript/ 路径
    figures: Array<{ envIndex: number; label?: string; caption?: string;
                     includegraphicsPath?: string; placement?: string; lineStart: number }>;
    tables:  Array<{ envIndex: number; label?: string; caption?: string;
                     rowCount: number; columnCount: number; lineStart: number }>;
  }>;
  unresolvedRefs: string[];              // \ref{fig:...}/\ref{tab:...} 指向不存在 label（确定性 finding 源）
  captionMissing: string[];              // 无 caption 的环境 id
  generatedFiguresUsed: string[];        // 引用 M12.3 figs/generated/ 的 includegraphics
}
```

实现 = 新 `manuscript/visualInventory.ts`：确定性正则（revisionBaseline 同款纪律），跟随每次修订后重建（挂在现有 revision validate 之后，作为 derived 投影）。

---

## 9. Multimodal Runtime Capability（冻结：零新建）

对任务书 7 节逐条：

- **message/input 支持 image？** Pi SDK 原生支持：`ImageContent{type:"image",data,mimeType}`（types.d.ts:275-278）、`UserMessage.content` 接受部件数组（:369）、`ToolResultMessage.content` 同（:421）。
- **Pi Runtime 支持 multimodal message？** 支持——经 `ModelRuntime.completeSimple` 直接调用（旁路 agent session）。**不支持**经 `session.prompt` 的 agent-loop 图片输入（`RunAgentInput.task: string`，`runtime/types.ts:84`）。
- **provider abstraction 允许 image？** 是（上述 SDK 层面）；PaperTeam 侧 seam = `VisionModelCaller`（`vision/types.ts:184-203`）。
- **model catalog 识别 vision？** 是：`BaseModel.input: ("text"|"image")[]` 即能力元数据；`capabilities.ts:16-18` 只认目录声明，unknown 保守判不可用——这正是任务书要的能力识别，**已存在**。
- **API 层可传 image？** 是（VisionAnalyzer 生产在用，base64）。
- **Writer/Reviewer runtime 能消费 multimodal？** agent-loop 不能（文本）；但这不是缺口——M12.2 视觉评审是**有界单图/单表任务**，VisionAnalyzer 的 completeSimple 模式（带结构化输出校验 + 1 次 repair + usage 记录）就是正确形状，不需要 session/tools/trace。
- **需要新建 MultimodalReviewProvider？** **不需要。** 新 `VisualReviewService` 注入现有 `VisionModelRuntime` seam（生产传 ModelRuntime 实例、测试传 `scriptedVisionRuntime`），完全复用 M10.2 模式。
- **扩展 Model Runtime capability metadata？** **不需要。** Pi 目录 `input` 元数据已是唯一事实源（D 纪律：PaperTeam 不自维护模型表，`runtime/pi/contextBudget.ts:8-9` 同源原则）。

**降级路径（已存在，M12.2 只需遵守）**：`resolveVisionModel` 返回 `{available:false, reason, detail}` → 视觉评审任务整体 skipped + 结构化原因进报告（`VisionUnavailableReason` 四码）；确定性子检查（caption 缺失、\ref 解析、表格结构、数字一致性）**不依赖 vision 模型**，永远执行。GLM-5.3 主模型按目录是文本模型——vision 依赖项在当前部署默认就是降级态，系统仍全功能可用，这符合任务书「不能因为没有视觉模型 API 就让整个 PaperTeam 不可用」。

---

## 10. Multimodal Review Architecture（M12.2 设计）

### 10.1 概念链裁决：**采纳任务书的链条，但落成两段**

```
Visual Artifact（权威源 + VisualArtifactView 投影）
  → Visual Observation（确定性检查结果 或 vision 模型结构化观察）
  → Review Finding（进入既有 ReviewFinding 模型，新增 "visual" 类目 + figure 锚）
  → （仅当用户确认后才可能成为 Evidence——沿用 candidateFacts 确认语义，M12.2 不新增该通道）
```

Figure ≠ Evidence 维持原纪律；visual finding 是 review 事实，不是 evidence。

### 10.2 检查项（v1 范围）

| 检查 | 方式 | 依赖 vision？ |
|---|---|---|
| caption 存在性 / 编号连续 / \ref 全解析 | deterministic（visualInventory） | 否 |
| 图表引用密度 vs 目标带 | deterministic（inventory × target profile） | 否 |
| 表格数字 ↔ 正文数字一致性（表内值是否在正文出现/或反之） | deterministic（revisionBaseline 数字多重集 × ParsedTableBlock/latex table 网格） | 否 |
| figure 内容 ↔ caption 相符性 | vision 模型（FigureAnalysis 已有 description/observations/warnings 直接可复用） | 是 |
| figure ↔ 邻近正文 claim 一致性 | vision 模型 + nearby text（新 bounded prompt，复用 VisionAnalyzer 骨架） | 是 |
| 目标视觉期望 gap（如「缺 method overview 图」） | deterministic（inventory × TargetProfile.visuals）+ LLM 措辞 | 否 |

### 10.3 集成

- `ReviewFinding`：categories 增 `"visual"`（finding.ts:11 additive）；provenance 三元组之外增可选 figure 锚 `{figureEnvRef?: string; assetRef?: string}`（或最小化：塞进现有 `page`/`sectionId` + `details`——**裁决：增显式可选字段**，与 `EvidenceLocation` 先例一致）。
- `ReviewAggregator`：visual 计数进 summary；`academicScore` 不变（visual findings 单列，不稀释既有口径）。
- Quality Gate：不新增阻断规则（v1）；visual findings 以 blocking 标志进入既有 no_revision_blocking_findings 口径（若 reviewer 标 blocking）。
- 降级报告：vision unavailable 时 visual 维度输出 `capability_gap` 说明（复用 D-0017 语义）。
- UI：ReviewPanel 增 visual 类目渲染；新增图资产 serve 路由 `GET /sources/:sid/figures/:name`（path 校验 + MIME 白名单，补 G8）；generated 图走 artifacts 下载既有模式。

---

## 11. Deterministic Figure Generation（M12.3 设计）

### 11.1 Renderer 终选：**TypeScript codegen → pgfplots → 独立 xelatex → vector PDF**

链路（任务书 8.1 的形状，renderer 换成 LaTeX 路线）：

```
CSV / JSON / ParsedTableBlock / structured_record（实验数据，全部带来源锚）
  → validated PlotSpec（TypeScript 类型 + 确定性校验：数值列类型/缺失/量纲一致性）
  → pgfplots .tex 确定性 codegen（standalone class，compat 钉死，文本全部转义）
  → FigureCompiler：xelatex 单遍编译（独立 build 目录）
  → manuscript/figs/generated/<figId>.pdf（vector）
  → caption（模型可起草，数值必须来自 dataset）+ LaTeX 插入（确定性 env emitter）
```

**选型论证（对任务书 8.1 的完整回答）**：

| 候选 | 裁决 | 关键理由 |
|---|---|---|
| **pgfplots（LaTeX codegen）** | ✅ 终选 | (1) **零新依赖**：pgfplots/tikz 是 TeX 发行版标配（MiKTeX 自动安装、TeX Live 自带），项目已有 xelatex 工具链与 LatexCompiler 运维经验；(2) **排版一致性**：与手稿同引擎同字体族，学术外观原生（这是 matplotlib/SVG 无法给的 typography 统一）；(3) **可编辑性**：产出物包含人可读 .tex 源，作者可改；(4) **确定性**：同 spec → 同 .tex 字节 → 同渲染；(5) Node-only 部署不受影响（不进正文编译——独立编译成 PDF 资产，正文只 `\includegraphics`，规避 pgfplots 拖慢主文编译的已知问题；externalize 问题的根治版）；(6) Windows 开发 = 同一 xelatex |
| matplotlib（Python sidecar） | ❌ | 引入运行时 Python + numpy/matplotlib 栈（~百 MB），破坏当前「Python 仅 Dev 侧 fixtures/Docling 可选」的部署面；Docker 镜像/Windows/服务器三端都要装；字体与手稿不一致；收益（生态）对 7 种基础图型无意义 |
| Plotly | ❌ | 服务端导出依赖 headless 浏览器（更大更脆）；npm 依赖重；SVG/PDF 导出排版不受控 |
| 直接 SVG 生成（自写 renderer） | ❌ | 自研排版（轴/刻度/图例/数学文本）工作量巨大且质量不稳；xelatex 不能直接 include SVG（需 rsvg/inkscape 外部转换器） |
| pdf-lib 直写 PDF | ❌ | 同上自研排版问题 + 与 UI 预览双实现漂移 |

**编译耗时风险**：pgfplots+xelatex 单图 ~1–3 s；独立编译 + **specHash 缓存**（同 spec 不重编）后，工作流成本可忽略。MiKTeX 首次装包需在线——doctor 增加 `pgfplots` 可用性预检（M12.3 交付物之一）。

### 11.2 PlotSpec v1 范围

图型：line / bar / grouped bar / scatter / benchmark comparison（=分组条形或点图模板）/ ablation（=grouped bar 或 slope 图模板）/ dual-metric（=双轴 line+bar，限定两轴）。每型一个模板化 pgfplots codegen 函数 + golden file 测试。**不做** 任意 Vega-Lite 式通用语法——7 个模板覆盖任务书列举，其余留给后续。

数据源（truthfulness 入口）：(a) 项目 sources 中的 CSV/XLSX/JSON（`csvTabular`/`xlsxTabular`/`jsonStructured` 已把数据结构化为 ParsedRecordBlock/ParsedTableBlock，含 cell 级 provenance——**图表数据的确定性来源已经存在**）；(b) 用户上传的数据文件（import 为 source，同链路）；(c) 手动 JSON 输入（UI 表单，标记 `origin=manual`，置信标注如实）。**禁止**：LLM 生成数值进入 dataset（校验层拒绝无来源锚的数据）。

---

## 12. Diagram Generation（M12.3）

**终选：TikZ codegen（block/pipeline 模板）**，同 11.1 全部理由。

对任务书 8.2 的比较裁决：

| 候选 | academic appearance | deterministic | editable | layout 质量 | 文本正确性 | 集成 | 输出 | 依赖 |
|---|---|---|---|---|---|---|---|---|
| **TikZ codegen** | ✅ 学术原生 | ✅ | ✅ .tex 源 | ✅（positioning 库分层布局，模板内可控） | ✅（LaTeX 排版） | ✅ 同一 FigureCompiler | vector PDF | TeX 自带 |
| Mermaid | ❌ 风格工程化 | ✅ | ⚠️ | ❌（自动布局常乱） | ⚠️（CJK/数学弱） | ❌（mmdc 需 headless Chrome） | SVG→需转 PDF | 重 |
| Graphviz | ❌ | ✅ | ✅ dot 源 | ⚠️ 层次图尚可、流程图一般 | ⚠️ | ❌ 需 `dot` 二进制（Windows dev 需另装） | PDF/SVG 可 | 中 |
| 直接 SVG | ❌ | ✅ | ⚠️ | ❌ 自研 | ❌ | ✅ | SVG（需转换） | 无 |
| TikZ 手写（LLM 直接写） | ✅ | ❌ | ✅ | ⚠️ | ⚠️ | — | — | — |

**DiagramSpec v1**：两个模板——(1) pipeline/architecture 块图（stages 列表 + 侧向注释，纵向/横向两布局）；(2) 双列对比图。输入是结构化 JSON（阶段名/连接/短标签），LLM 只负责从方法描述**起草 DiagramSpec 草案**（结构化输出校验同 Feasibility 模式），布局与渲染全部确定性。**不承诺任意自由形式图**——那是绘图软件的事。

---

## 13. Truthfulness / Provenance（M12.3 冻结）

**MVP 必需**（v1 就做）：

```ts
// manuscript/figs/generated/manifest.json（figureStore.ts 维护）
interface GeneratedFigureRecord {
  figId: string;                    // fig-<12hex>
  kind: "plot" | "diagram";
  specHash: string;                 // PlotSpec/DiagramSpec 规范化 sha256（缓存键 + 一致性锚）
  datasetHash?: string;             // 数据集内容 sha256（plot 必填；diagram 无）
  dataOrigin: { sourceId: string; blockId?: string } | { origin: "manual"; note: string };
  assets: { tex: string; pdf: string };   // 相对 manuscript/ 路径
  caption: string;                  // 与 LaTeX env 内 caption 一致（插入时快照）
  insertedIn?: { file: string; label: string; revision: number };
  createdAt: string;
}
```

- **数据→图**：datasetHash + dataOrigin（sourceId+blockId 锚到 ParsedDocument 块——cell 级 provenance 已存在）。渲染前校验 dataset 当前 hash 与 record 一致（数据变了必须显式重生成）。
- **spec→资产**：specHash 缓存；PlotSpec JSON 持久化于 `figs/generated/<figId>.spec.json`。
- **资产→手稿**：insertedIn 记录 file/label/revision；revisionBaseline/factPreservation 的表与数字守卫自然覆盖表格路径，figure 路径新增一条确定性检查：**caption 中出现的数值必须存在于 dataset**（确定性字符串匹配，M12.3 的防「LLM 编曲线」守卫）。
- **修订 lineage**：图删除/替换 = manifest 记录 supersededBy（append-only），手稿修订快照已含 .tex 与 figs/（LatexCompiler 整树 cp 已保证）。

**v1 不做**（诚实降级）：SOURCE_DATE_EPOCH 级 PDF 字节级可复现（LaTeX 时间戳）；图表数据与外部实验 run 管线的自动对接（当前实验数据以文件/表形式人工入库）；SVG 预览（浏览器 `<embed>` 直接渲染 PDF，前端已展示手稿 PDF 同款能力）。

---

## 14. Target × Multimodal Integration（冻结）

- **Visual expectation 进 TargetPublicationProfile？** 是——`dimensions.visuals`（figureCount 分位带、figureTypeMix、methodDiagramPresent 比例、tableCount），数据源 = benchmark 论文的 ParsedDocument 块计数（确定性）+ 可选 vision figureType（有则更细，无则 unknown 归并，如实）。
- **Multimodal Reviewer 消费 Target Profile？** 是——visual 检查项表（§10.2 最后一行）：inventory × profile 期望的确定性 gap（「目标带 75% 论文有 method overview 图，当前稿 0」），作为 visual finding 的一类。
- **Reviewer Finding 与 Target Gap 是同一种对象？** **不是。** ReviewFinding 是「稿件缺陷」（可 blocking、进修订循环）；TargetGap 是「与目标层的距离」（advisory、进 readiness 报告与规划上下文）。重叠处（如 caption 缺失既是缺陷也拉低 readiness）允许同一底层事实投影到两个对象，但对象与消费链路分开——**Correctness / Publication Readiness / Target Readiness 三层不合并**（见 §15）。
- **集成顺序裁决**：M12.2 的 visual 检查在 Target Profile 缺席时照常运行（只做稿件内部一致性）；Profile 就绪后追加目标带对比——两者解耦，Profile 不是 M12.2 的硬前置。

---

## 15. Quality / Target Readiness Semantics（冻结）

三层语义，互不侵蚀：

| 层 | 问题 | 判定者 | 阻断性 |
|---|---|---|---|
| Correctness | 修订是否引入事实/引用/证据违规？ | 确定性守卫（fact/citation/evidence/claimGap…，M11.4 全保留） | 阻断（既有） |
| Publication Ready | 这轮修订任务是否正确完成 / 全稿可投稿？ | M11.4 两层判定（revisionTaskSuccess + publicationReady，academicPassScore 投稿层） | Draft/Final 分级（既有，**零改动**） |
| **Target Readiness（新）** | 当前稿与**目标实证参照系**的距离？ | TargetGapService：确定性对比为主，输出四档 verdict + gaps + confidence | **advisory（不阻断任何 gate）** |

关键裁决：
- **不造 `targetScore >= 80` 式新分数。** M11.4 校准审计已证明未锚定绝对分的语义漂移；Target 层只有**相对参照系**（benchmark 分位带）+ 四档分类 + 结构化 gap + confidence（由 n 与确定性来源决定）。允许未来在 benchmark 语料充分时给出校准的相对位置（如「位于目标带 p25–p50」），这是描述统计不是评分。
- verdict 语义对齐 D-0011 纪律（离散档位、禁虚假精确）与 FeasibilityLevel 风格；INSUFFICIENT_EVIDENCE 是一等结果（样本不足/提取失败时如实出现）。
- UI 徽章三层并列（Correctness 守卫状态 / REVISION_TASK_COMPLETE+publicationReadiness 既有徽章 / 新 TargetReadiness 徽章），复用 M11.5 已落地的分层徽章组件模式。

---

## 16. Jev-like Future Integration Boundary（audit-only）

- **现状**：无 DecisionProvider 抽象；决策分布在 (a) 确定性 gate（gates.ts/revisionTaskGate.ts）、(b) LLM 服务（FeasibilityService 等，经 AgentRuntime.runAgent）、(c) HITL stage。这**不是缺口**——按 D-0033/能力纪律，PaperTeam 不做模型路由/多模型编排。
- **最自然插入点**（未来）：决策聚合层的服务 seam——Jev-like model 若为远端 LLM：新增一个 Service 类（FeasibilityService 同款：runAgent + 结构化输出校验），或替换 ReviewAggregator 的某个确定性归并函数；若为本地模型工件：DoclingToolchain 式受控子进程 seam（`ingestion/DoclingToolchain.ts` 是完整先例：解释器探测、版本上报、失败缓存、显式降级）。
- **现在要不要抽象接口？不要。** (a) 现有两个 seam（AgentRuntime / 受控子进程）已覆盖可预见的两种形态；(b) Jev-like 尚在训练中，接口形态未知；(c) 任务书明令禁止 speculative abstraction。**结论：M12.1–M12.3 零依赖、零等待。**

---

## 17. Rejected Alternatives（汇总）

| 被拒方案 | 拒因（一句话） |
|---|---|
| matplotlib / Python 运行时 sidecar | 破坏 Node-only 运行时与部署面；排版不一致；对 7 个基础图型收益为零 |
| Plotly / chart.js / vega 服务端渲染 | headless 浏览器或重 npm 依赖；SVG→PDF 转换不受控 |
| 自研 SVG/PDF renderer | 排版自研成本与质量风险；双实现漂移 |
| Mermaid / Graphviz | 外部二进制 / headless Chrome 依赖；学术外观与 CJK/数学文本弱 |
| image-generation API 画实验图 | 任务书红线（且永远拒绝：数据图必须来自真实数据） |
| LLM 直接手写 tikz 源码 | 非确定性 + 编译脆弱；codegen 模板化才是可控路径 |
| 新建持久 PaperVisualArtifact store | 第二事实源违反 D-0013；权威源已存在，缺的是统一视图 |
| 新建 MultimodalReviewProvider / 扩展 Model Runtime capability 层 | 能力元数据（Pi 目录 input）与调用 seam（completeSimple）已存在 |
| 通用 venue 分级服务 | 无可靠开放数据源；种子表 + 如实 INSUFFICIENT 才诚实 |
| targetScore 数值门 | 未校准绝对分的教训（M11.4）；四档分类 + 分位带取代 |
| benchmark 语料直接喂 Writer | style cloning / plagiarism 结构性风险；只喂聚合分布 |
| MinerU / Marker 替换 Docling | Docling 已深度集成（TableFormer/bbox/caption 链路 + 降级路径 + 测试），替换收益不明确、迁移成本高；Docling 维持主路线（MinerU/Marker 值得借鉴的只有公式 enrichment 思路——已在 Docling `--formulas` 选项内，M12 可择机开启） |
| Benchmark corpus 作为独立 store | SourceStore + sourceRole + 冻结 manifest 即可，复用全部去重/全文/解析设施 |

---

## 18. Implementation Plan

### 18.1 M12.1 — Target Publication Intelligence（约 6–8 个工作单元）

| # | 任务 | 新建/改动文件 | 依赖 | LLM？ |
|---|---|---|---|---|
| A1 | SearchOptions venue 过滤 + OpenAlex provider 映射 | `search/types.ts`（additive）、`openalexProvider.ts` | — | 否 |
| A2 | venue 解析 + 种子表 | 新 `search/venueResolution.ts` + `backend/resources/venue-seeds.json` | — | 否 |
| A3 | citationCount 持久化 | `sources/SourceStore.ts`（SourceMetadata additive）、`SourceImportService.ts` 快照透传 | — | 否 |
| A4 | Benchmark 发现服务 | 新 `search/benchmarkDiscoveryService.ts`（组装 A1–A3 + fusion） | A1–A3 | 否 |
| A5 | 语料冻结 | 新 `target/TargetBenchmarkService.ts` + `target/types.ts`（照抄 CorpusSnapshot revision 模式）；promote 时置 role=reference | A4 | 否 |
| A6 | HITL stage | `definitions.ts` 增 `hitl.benchmark_selection`（literature_selection 同款）+ 推荐逻辑（引用数排序） | A5 | 否 |
| A7 | Profile 提取 | 新 `target/TargetProfileService.ts`：确定性提取（sections/引用计数/块统计）+ bounded LLM 摘要（method/writing 两维，结构化输出校验） | A5 | 部分（标注） |
| A8 | Readiness 对比 | 新 `target/TargetGapService.ts`：manuscript digest + revisionBaseline + visualInventory(可缺省) × profile → 四档判决 | A7 | 部分（措辞） |
| A9 | 消费接线 | FeasibilityService/ReviewerService/Planner prompt 增块；gates.ts `targetReadiness?` advisory 字段；workflow：existing_paper_improvement 与 idea_to_paper 在 feasibility 前插 `target.*` 三 stage（可跳过——target 未配置时 no-op） | A5–A8 | 否 |
| A10 | UI TargetPanel + HTTP | `httpServer.ts` 路由组、前端 `TargetPanel.tsx` | A5–A8 | 否 |

### 18.2 M12.2 — Multimodal Paper Review（约 5 个工作单元）

| # | 任务 | 文件 | 依赖 | LLM？ |
|---|---|---|---|---|
| B1 | LaTeX visual 环境 inventory | 新 `manuscript/visualInventory.ts` + `research/manuscript-visuals.json`（revisionBaseline 同款正则纪律） | — | 否 |
| B2 | VisualArtifactView 投影 | 新 `review/visualArtifactView.ts`（纯函数） | B1 | 否 |
| B3 | VisualReviewService | 新 `vision/VisualReviewService.ts`（确定性检查全量 + vision 检查按 capability）+ `finding.ts` 增 `"visual"` 类目与 figure 锚 | B2 | 部分（降级完备） |
| B4 | 图资产 HTTP 路由 | `httpServer.ts` `GET /sources/:sid/figures/:name`（补 G8） | — | 否 |
| B5 | 集成 + UI | ReviewAggregator visual 维度、ReviewPanel visual 类目渲染、capability_gap 提示 | B3 | 否 |

### 18.3 M12.3 — Deterministic Figure Generation（约 6 个工作单元）

| # | 任务 | 文件 | 依赖 | LLM？ |
|---|---|---|---|---|
| C1 | PlotSpec/DiagramSpec 类型 + 校验 | 新 `figures/spec.ts`（typebox） | — | 否 |
| C2 | pgfplots/TikZ codegen | 新 `figures/pgfplotsCodeGen.ts`、`figures/tikzCodeGen.ts`（转义 + golden 测试） | C1 | 否 |
| C3 | FigureCompiler + figureStore | 新 `figures/FigureCompiler.ts`（xelatex 单遍 + specHash 缓存 + fakebin 可测）、`figures/figureStore.ts`（manifest lineage） | C2 | 否 |
| C4 | HTTP + UI | `POST /:id/figures/generate`、`GET /:id/figures`、前端 FiguresPanel（PDF embed 预览 + spec 表） | C3 | 否 |
| C5 | 手稿插入 | 确定性 env emitter + 模板加 graphicx + Writer prompt 禁令改写（允许引用注册资产）+ 修订计划新增 insert_figure 条目类型 | C3 | 否 |
| C6 | 守卫 + doctor | caption 数值 ↔ dataset 一致性检查（挂 revisionValidation）；doctor 预检 pgfplots | C5 | 否 |

### 18.4 顺序 / 并行 / 串行裁决

- **推荐顺序：M12.1 → M12.2 → M12.3**（产品优先级：Target Intelligence 是第一卖点且最快出可展示闭环；M12.2 次之；M12.3 独立性强、最后做不影响前两者）。
- **若下一轮想压时间**：A1–A6（LLM-free 全链）+ B1–B2 + C1–C3 这三组互相零依赖、全部确定性、各有现成测试手法（fake fetch / fixtures / fakebin），**可一轮并行完成**；随后 A7–A10 与 B3–B5、C4–C6 各自串行收口。
- **必须串行**：A7→A8→A9（profile→readiness→消费）；B3 依赖 B1/B2；C5 依赖 C3 且触碰修订安全边界（必须独占审慎实现）。
- **本轮（M12.0）代码改动 = 零**：审计未发现阻塞性 bug；所有 prerequisite 代码都属于上文冻结的新 schema/新模块——按任务书 §14「新核心 artifact schema 先冻结方案再实现」执行，docs-only 是正确形态。

---

## 19. M12.1 Acceptance Criteria

1. 配置 target 的项目可经 discovery 拿到带 venue 过滤与 citationCount 的候选列表（fake-fetch 单测 + 一次真实 OpenAlex smoke）。
2. `hitl.benchmark_selection` 确认后语料冻结：`research/target-benchmark.json` 落盘、revision 语义与 corpus-snapshot 一致、全部条目 role=reference、evidence 链路检索不到这些源的 chunk 作为 evidence 候选（回归用例）。
3. `target-profile.json` 生成：确定性字段可由同语料重算复现（golden 测试）；LLM 字段带 provenance 标注；n<5 维度 INSUFFICIENT_EVIDENCE。
4. `target-readiness.json` 生成：六维四档 + gaps + confidence；无任何新数值分数门。
5. Feasibility/Reviewer prompt 含参照系块（prompt 构造单测断言）；gates 输出含 advisory targetReadiness 且 existing_paper 两层判定回归全绿（不改变任何既有判定结果——用 M11.4 已有集成测试验证）。
6. UI TargetPanel 展示语料/分位带/判决徽章。
7. Backend/frontend typecheck + 定向测试全绿；新增不少于：venue 过滤 3、discovery 2、冻结 3、profile 4、readiness 3、HITL e2e 1。

## 20. M12.2 Acceptance Criteria

1. `manuscript-visuals.json` 对含 figure/table 环境的 .tex 夹具产出正确 inventory（label/caption/行号/unresolvedRefs；golden 测试）；修订后自动重建。
2. VisualArtifactView 投影单测覆盖三 sourceKind；无 IO；freshness 键约束生效。
3. 确定性检查（caption 缺失 / \ref 未解析 / 表-文数字一致性 / 目标带对比）在无 vision 模型时全部可运行（scripted 全套测试）。
4. vision 模型可用时 figure↔caption/正文一致性检查产出结构化 visual findings（scriptedVisionRuntime 测试）；不可用时该子集 skipped + capability_gap 报告（降级测试）。
5. ReviewFinding `"visual"` 类目 + figure 锚持久化与聚合正确；GET /sources/:sid/figures/:name 服务图片（含路径校验测试）。
6. ReviewPanel 渲染 visual findings；typecheck/定向测试全绿。

## 21. M12.3 Acceptance Criteria

1. 7 类 PlotSpec + 2 类 DiagramSpec 校验与 codegen golden 测试全绿；所有数据文本经转义（注入测试用例）。
2. FigureCompiler：fake xelatex 单测 + 一次真实编译 smoke（有 TeX 环境）；specHash 缓存命中不重编译（测试）。
3. manifest lineage 完整：datasetHash/dataOrigin/specHash/insertedIn 可追溯；dataset 变更后重渲染被强制提示（测试）。
4. 手稿插入：模板含 graphicx、编译通过（fakebin + 真实 smoke）、`\ref` 可解析；Writer prompt 禁令更新为资产白名单语义。
5. caption 数值 ↔ dataset 确定性检查：编造数值的 caption 被 revisionValidation 拦截（测试用例）。
6. doctor 增 pgfplots 预检；UI FiguresPanel 可生成并预览；typecheck/定向测试全绿。

---

## 22. Risks / Open Decisions

| 风险 | 等级 | 缓解 |
|---|---|---|
| 当前主模型 GLM-5.3 非 vision——vision 依赖项默认降级 | 中（预期内） | 降级路径已是产品行为；用户可配 visionModel（GLM-4.xV 或任一 image-capable provider）；确定性检查不受影响 |
| OpenAlex venue 过滤的真实召回（source id 归属错配/期刊更名） | 中 | 种子表人工核对 + 每篇带 provenance + INSUFFICIENT_EVIDENCE 诚实出口 |
| MiKTeX 首次编译 pgfplots 需在线装包（Windows dev） | 低 | doctor 预检 + 文档说明；TeX Live/WSL 不受影响 |
| profile LLM 摘要两维（method/writing）主观性 | 低 | 显式 provenance 标注 + confidence low 呈现 + 四维确定性主轴不受影响 |
| 手稿 .tex 形态多样（自定义宏/非标准环境）导致 inventory 漏解 | 中 | 正则纪律同 revisionBaseline（已在 3 个真实返修项目验证）；漏解不伪造（字段缺省）+ unresolvedRefs 如实报告 |
| figure 插入触碰修订安全边界（修订计划新条目类型） | 中 | C5 单独串行实现；fact/scope 守卫全保留；insert_figure 只允许已注册资产 |
| **作者决策项（非阻塞，默认已选）** | — | (1) benchmark 推荐规模默认 8–15 篇（HITL 可改）；(2) Target stage 对未配 target 的项目为 no-op 可跳过（默认开）；(3) M12.2/M12.3 若与 M12.1 并行推进需作者排期裁决（默认串行） |

---

## 23. Final Recommendation（23 问冻结答案）

**Target Publication**
1. Benchmark Corpus 存哪里？——**SourceStore（role=reference）+ 冻结 manifest `research/target-benchmark.json`**；不建独立 store。
2. TargetPublicationProfile 存哪里？——**`research/target-profile.json`（project artifact、derived 落盘、freshness 双键）**。
3. Search 如何获取 benchmark paper？——**复用 4-provider 栈 + 三个 additive 扩展**（SearchOptions venue 过滤映射到 OpenAlex `primary_location.source.id`；venueResolution 种子表；citationCount 持久化），RRF/identity/全文链原样复用。
4. 如何与 Evidence 隔离？——**role 过滤（corpus 资格谓词扩展到 evidence source 选择）+ 提取直读 ParsedDocument + reference 源禁 candidateFacts 确认**（§5 四道隔离）。
5. Profile 如何进入四端？——**Planner：gaps 注入（作者可选）；Writer：仅数值期望；Reviewer：rubric 参照块；Gate：advisory `targetReadiness` 字段（零阻断）**。
6. M12.1 最小范围？——§18.1 A1–A10（discovery→HITL→冻结→profile→readiness→接线→UI）。

**Multimodal**
7. visual extraction 首选技术路线？——**Docling 维持（已有），手稿侧新增确定性 LaTeX 环境解析（revisionBaseline 同款）**。
8. 是否继续以 Docling 为主？——**是**（MinerU/Marker 仅思路借鉴，不替换）。
9. PaperVisualArtifact 最终结构？——**derived 只读投影 `VisualArtifactView`（id/kind/sourceKind/caption/label/assetRef/page/bbox/tableGrid/referencedBy/analysis/provenanceNote），不新建持久 store**。
10. PDF 与 LaTeX 如何统一？——**统一在视图层**（sourceKind 三值：pdf_parsed/latex_env/generated），权威源分立。
11. Multimodal runtime 怎么接？——**不新建**：复用 `VisionModelRuntime`（completeSimple + ImageContent）seam 与 `resolveVisionModel` 能力解析。
12. vision 不可用时怎么降级？——**既有机制**：结构化 unavailable 原因码 → vision 子集 skipped + capability_gap 报告；确定性子检查永远运行。
13. M12.2 最小范围？——§18.2 B1–B5（inventory→投影→VisualReviewService→资产路由→集成 UI）。

**Figure Generation**
14. 数据图 renderer？——**TypeScript codegen → pgfplots → 独立 xelatex → vector PDF**（specHash 缓存）。
15. 是否引入 Python？——**不**（运行时零新增 Python；Docling 既有可选子进程不扩大）。
16. 方法图 renderer？——**TikZ codegen（pipeline/对比两模板）**，LLM 仅起草 DiagramSpec。
17. artifact/provenance 如何保存？——**`manuscript/figs/generated/`：spec.json + .tex + .pdf + manifest.json（specHash/datasetHash/dataOrigin/insertedBy lineage）**。
18. LaTeX insertion 怎么做？——**确定性 env emitter 插入 section 文件（label/位置由计划指定）+ 模板加 graphicx + Writer 资产白名单语义**。
19. M12.3 最小范围？——§18.3 C1–C6（spec→codegen→编译/存储→HTTP/UI→插入→守卫+doctor）。

**总体**
20. M12.1→M12.2→M12.3 顺序最佳？——**是**（产品优先级排序；三者耦合度低，M12.3 与 M12.2 甚至可互换）。
21. 下轮可并行一次完成？——**是：A1–A6 + B1–B2 + C1–C3**（全确定性、零相互依赖、各有现成测试手法）。
22. 必须串行？——**A7→A8→A9；B3→B5；C5→C6**（schema 消费链与修订安全边界）。
23. 当前必须作者裁决的架构分歧？——**无**。全部分歧已按工程判断冻结（§17）；仅三个非阻塞默认值待作者事后认可（§22 末行）。

**READY_FOR_M12_1 = true。**
