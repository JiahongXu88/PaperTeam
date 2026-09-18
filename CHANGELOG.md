# Changelog

All notable changes to PaperTeam are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased] — M7.0 Productization Baseline（2026-09-18）

产品化收口：前端对齐 M6 已有能力，不新增 Agent / Runtime / Workflow 能力。

1. **Literature Library UI（M6.2 前端消费）**：新增项目「文献库」标签页
   （SourcesPanel）：五种入库方式（PDF/文件上传、DOI、arXiv、URL、BibTeX）
   全部复用既有 M6.2 端点（`POST …/sources` 与 `…/sources/import/{doi|arxiv|url|bibtex}`）；
   幂等（created=false）与 resolver 解析结论（补全 / 未收录）如实呈现；
   新增 api/sources.ts + types/sources.ts + hooks（useSources /
   useUploadSource / useImportSource）。
2. **Sidebar 响应式布局修复**：矮视口（≲700px 高）下「最近项目」被 flex
   收缩为 0 高、内容溢出绘制且被底部 promo card 遮挡（根因：
   `.sidebar-recent { min-height: 0 }` 取消自动最小尺寸保护）。修复 =
   `flex-shrink: 0` + 既有 overflow-y:auto 滚动兜底，任何窗口高度不遮挡、
   滚动可达（e2e：sidebar-responsive.spec.ts 四档高度回归）。
3. **CI 修复（Typecheck）**：M6.5/M6.6 引入的 backend/test/evidence 类型
   错误（runTool helper 的窄化 execute 签名 vs ToolDefinition 五参数、
   mock LookupOutcome 宽化、未使用 import）导致 CI 自 run #21 起连续失败；
   修复后不降低检查标准，evidence 61 测试全过。

## [Unreleased] — M6 COMPLETE（2026-09-18）

M6.0–M6.9 全部完成（Research Discovery & Evidence-grounded Pipeline；
Documentation Freeze，架构冻结见 D-0041，总览见
[docs/research/M6_FINAL_SUMMARY.md](docs/research/M6_FINAL_SUMMARY.md)）：

1. **Multi-source Research Discovery**（M6.3）：共享 ProviderHttpClient
   （超时/退避/Retry-After/熔断/健康四态）+ OpenAlex / Semantic Scholar /
   arXiv / AMiner 四学术 Provider + SearXNG optional Web Search + 多源
   融合去重 + 显式 Candidate 持久化。
2. **Literature Management**（M6.2）：SourceIdentity 分层身份键、候选 ≠
   正式文献分文件治理、五种入库路径（PDF/DOI/arXiv/URL/BibTeX）、
   metadata 可信分层 merge、Evidence 引用删除保护。
3. **Evidence-grounded Retrieval**（M6.4）：确定性 SourceChunk 管线 +
   进程内 BM25 lexical + optional dense + RRF hybrid + Context Budget
   Packing + retrieve_library 工具（零 Vector DB / 零外部索引引擎）。
4. **Evidence Verification Pipeline**（M6.5/M6.6）：EvidenceCandidate
   候选-转正状态机 + 三段核验（quote 逐字 / metadata / 语义 judge）+
   Evidence 工具面（get_chunk / propose_evidence / evidence_query）+
   Writer/Reviewer 消费侧重构（EvidenceSelectionService 唯一使用策略、
   writer formalOnly 视图、citations_evidence_backed Gate 规则）。
5. **Revision Safety**（M6.7）：Revision Item 生命周期状态机 +
   revision.validate 四类确定性复核 + Claim Strength Gate + Revision
   Gate 两条规则 + hitl.revision_validation。
6. **Agent Reliability Evaluation**（M6.8/M6.9）：scripted 离线确定性
   三实验框架 + live / 五模型族多模型评估（GLM-5.3 / claude-fable-5-1 /
   gpt-5.4 / deepseek-v4-pro / qwen3.7-max：Plain LLM 25/25 提案捏造；
   PaperTeam pipeline 零捏造证据泄漏——evaluated scenarios 内，限制
   如实见 M6.9 条目）。

M5 COMPLETE（2026-09-16，未打 tag）：M5.0–M5.7 全部完成：Runtime 生命周期可靠性与长程治理（M5.1/M5.2）、受控学术
Skill 接入（M5.3）、中文风格修订回路（M5.4）、单机 Linux / Docker 部署（M5.5，
真实 Docker 验收）、真实论文 A/B 验收与 Citation / Fact Preservation 双 Gate
（M5.6）、最终产品化（M5.7：per-Agent provider/model 配置 + 外部专家 / 导师
修改意见驱动修订，supports reviewer-driven revision with conflict detection and
deterministic preservation gates）。完整内容见
[docs/RELEASE_NOTES_M5.md](docs/RELEASE_NOTES_M5.md)；验收记录见
[docs/M5_ACCEPTANCE.md](docs/M5_ACCEPTANCE.md)。**未打 tag**：验收语料上 Final
产物无法达成（发布条件不满足）。

### M6.9 Multi-model Reliability Evaluation（✅ 2026-09-18）

- **Live 评估链路**（M6.8 scripted 框架的 live 化，被测系统零改动——
  红线维持）：`evaluation/liveRuntime.ts`（真实模型经 PiRuntimeAdapter
  最小评估 runtime，无新增调用链）+ `runners/liveExp1.ts`（Exp1 两臂
  live 化）+ `runners/multiModel.ts`（多模型批跑：模型矩阵 × 两臂 × 每臂
  5 提案，serial 执行，单模型失败不终止批次）。
- **M6.9.1 GLM-5.3 live**：frozen 数据集首跑确立测量口径——无库条件下
  拒绝编造引文（refused）是合法结果，不解读为 0% 捏造；提案框架调整后
  实测 plain-llm-live fabricated 100% / paperteam-live fabricated 0%
  （verified 80%）。
- **M6.9.2 Claude live + M6.9.2.1 兼容数据集**：网关 anthropic 通道对
  corpus 防记忆噪声 token 触发 bio 过滤拦死 Arm B；claude-compatible
  派生数据集（noise token → word-form synthetic marker，注入结构与
  frozen 逐字段一致 + SHA-256 快照校验 + 负对照探针）后 Arm B 跑通
  （fabricated 0 / verified 60%）。
- **M6.9.3 五模型族多模型评估**（anthropic-messages + openai-completions
  两协议；claude-compatible 数据集全批统一）：**Arm A（Plain LLM）25/25
  提案全部 fabricated**（五模型逐个 100%——evaluated models 范围内
  citation hallucination 跨模型族普遍）；**Arm B（Evidence Pipeline）零
  捏造泄漏**（fabricatedLeaked=0）+ metadata 陷阱拦截 6 条（Stage 2 权威
  记录裁决）+ 转正 19/25（76%）。Limitations 同行：小样本（每臂 5 提案
  × 单场景，方向性证据）、same-model judge bias、同一网关公共混杂、
  quote 拦截路径本批未触发（有效性证据 = 零泄漏 + metadata 拦截，不是
  fabricated 拦截率）、结论限定 evaluated models。
- **公开名归一化**：评估报告与产物文件统一公开名（GLM-5.3 等）；内部
  路由别名只经 `PAPERTEAM_EVAL_GLM53_GATEWAY_MODEL` 环境变量注入，不入库
  不入报告。报告：`evaluation/reports/`（live-glm53-exp1 / live-claude-
  exp1(-compatible) / multi-model-live-evaluation + multi-model/ 逐模型
  原始 JSON）。

### M6.8 Agent Reliability Evaluation Framework（✅ 2026-09-18）

- **新增评估基建**（evaluation infrastructure，不新增产品功能——红线：
  零新增 Agent、不改 Runtime / Workflow 核心 / Evidence Pipeline /
  Writer / Reviewer）：`backend/src/evaluation/` 新域（types / datasets /
  metrics / runners / cli）+ `npm run evaluation` 统一入口
  （`scripts/evaluation.mjs`；experiment / scenario 选择、--hitl-policy、
  --out、--list）+ 结构化报告 `evaluation/reports/*.json`（schemaVersion=1
  事实源 + Markdown 摘要）+ 人工校准接口
  `evaluation/calibration/records.jsonl`（claim / prediction /
  humanLabel / reason → 自动指标一致率 + Exp3 prefer-<arm> 人工偏好；
  脏行如实计数）。数据集高质量小数据（Exp1 六 / Exp2 七 / Exp3 五场景，
  自造中英学术语料 + ground truth 标注 + 结构校验，脏数据拒绝运行）。
- **三实验结果**（scripted 离线确定性，报告与 limitations 同行）：Exp1
  Evidence Grounding 三臂（plain-llm / rag / paperteam）：fabricated
  citation rate 25.0%→7.1%→0%、unsupported claim rate 17.9%→17.9%→0%
  （rag 不核语义、paperteam judge 补位）、evidence coverage 100% 无损。
  Exp2 Revision Safety 两臂：[fact:mutate] / [cite:drop] /
  [strength:escalate] 注入下存活率与零信号放行 100%→0%、干净对照零误拦、
  拦截点前移至 revision.validate。Exp3 Agent Workflow 两臂：claim
  traceability 0→60%（无语料场景按 M6.6 口径诚实计 0）、citation
  correctness 40→100%、completeness 24→100%、human preference 无校准
  记录为 null（不伪造）。scripted 边界如实声明：度量确定性安全机制对
  注入故障的拦截率与管线保障，非真实模型生成质量（live run 属后续）。
- **测试**：后端 +32（scenarios 7 / metrics 12 / faultInjection 7 含
  [cite:drop] 全链路 e2e / report 4 / baseline 2），全量 1203 通过 0
  失败（零回归）；`tsconfig.build.json` 全绿。决策 D-0040；报告
  docs/research/M6.8_EVALUATION_REPORT.md。

### M6.7 Revision Safety & Quality Gate Evolution（✅ 2026-09-18）

- 修订闭环升级为 Revision ≠ Correct Revision（revision safety and
  validation）：**RevisionPlanItem 生命周期化**——新增 `riskLevel` /
  `relatedEvidenceIds` / `appliedAt` / `appliedRevision` / `targetChanged` /
  `resolvedAt` / `resolution` 字段与七态状态机（planned(≡pending) → applied
  → validated / rejected / needs_review；rejected → planned 重派发 / approved
  用户接受；非法流转确定性拒绝，`backend/src/review/revisionItemStatus.ts`）。
  **`revision.validate` stage**（`backend/src/review/revisionValidation.ts`，
  修订写入后、复审前，纯确定性无 LLM）：四类复核——Fact / Citation
  Preservation（复用 M5.6，sourceRevision → revision 窗口）、**Claim
  Strength Gate**（`backend/src/quality/claimStrength.ts`：句级 diff 检测
  「弱证据 → 强表述」升级——「可能改善」→「显著提升」；strong+
  insufficient → block / strong+partial → warning / strong+direct 合法；
  授权 = 计划或 formal evidence 文本含强 marker 或同数字）、**Evidence
  Re-validation**（条目关联证据仍存在且仍 formal；新增引用 evidence-backed
  覆盖记录）；违规按文件级归因到条目并回写终态；产物
  `reviews/revision-validation-r{round}.json`。**Quality Gate 新增
  `revision_items_resolved` / `claim_strength_guard` 两规则**（rejected /
  needs_review / block 阻断 Final；用户 approve 覆盖并记录在案；输入对齐
  被审阅修订才消费）。**HITL `hitl.revision_validation`**（approve /
  reject=ManuscriptRevisionStore.restore 恢复修订前快照 / needs_review=保留
  但阻断 Final；新鲜度按 validationId）。**Reviewer 结构化输出**新增可选
  `evidenceRequirement`（required / optional / none）；**Writer
  reviseSection 直接读取结构化 Revision Item**（id / 风险 / needsEvidence
  约束 / 关联证据「修改前依据」，issues 通道兼容保留）。红线维持：零新增
  Agent、Runtime / Retrieval / Evidence Grounding 不动。新增后端测试 31
  （状态机 5 / claimStrength 8 / validation 纯函数 9 / Gate 规则 5 / e2e 3）。
  决策 D-0039。

### M6.6 Evidence-aware Writing Loop（✅ 2026-09-17）

- Writer / Reviewer 从「prompt 注入静态 evidence digest」升级为
  「verified evidence 快照 + evidence_query 主动查询」双通道（Agent can use
  Evidence, not Evidence flooding Agent）：**EvidenceSelectionService**
  （`backend/src/evidence/EvidenceSelectionService.ts`，架构审计 P1 落地——
  usableEvidence 业务逻辑从 workflow definitions 下沉）持有使用策略唯一
  事实源：正式证据 = verified + sourceId + chunkId 三件套（`isFormalEvidence`
  纯函数），legacy unverified 派生标识 `legacy_unverified` 不再自动进入
  prompt（旧「trusted<3 时 unverified 兜底」行为废除；存量记录不迁移，
  M6.7 收口）；`matchBibliographyKey`（DOI 精确 / 归一化 title+年份）实现
  EvidenceRecord → bib key 关联。**writer 工具 formalOnly 视图**：
  `evidenceToolsForRole` writer 分支的 evidence_query 构造期强制
  `status=verified` + 锚点过滤——Agent 运行期显式请求 unverified 也不放宽；
  reviewer / citation 保持全量视野（evidence_gap 识别需要线索可见），正式
  判定口径由 prompt 约束。**Writer prompt**（planOutline / writeSection /
  reviseSection 含 abstract）：digest 只含 verified、行内 `（cite: key）`
  关联、evidence_query 查询指引、无 verified 时弱化论断提示。**Reviewer
  prompt**（fact 模式）：逐 claim 先 evidence_query（claimContains/sourceId）
  后判定、get_chunk 回查原文锚点、「只有 verified 可作 SUPPORTED 依据」；
  无 verified 时 UNSUPPORTED 口径 + 查询确认提示。**Quality Gate**：新增
  `computeEvidenceCitationCoverage`（quality/evidenceCitationCoverage.ts，
  cited keys ↔ verified formal evidence 覆盖检测）+ `citations_evidence_backed`
  规则（默认呈现计数不阻断——接入期存量项目覆盖率必然低；
  `requireEvidenceBackedCitations=true` 时未覆盖引用阻断 Final；覆盖明细随
  gate 产物落盘）。review.run / writing.sections stage 结果新增
  evidenceFormal / evidenceExcluded 分类计数。红线维持：不新增 Agent、
  不改 Runtime / Pi adapter、不改 Retrieval、Retrieved ≠ Verified ≠
  Grounded。新增后端测试 26。决策 D-0038。

### M6.5 Evidence Grounding Pipeline（✅ 2026-09-17）

- 「检索到的段落」升级为「可信证据」的核验闭环（Retrieved ≠ Verified ≠
  Grounded）：`backend/src/evidence/` 域新增 6 个文件。**EvidenceCandidate**
  候选-转正分离（`evidence/candidates.jsonl`；pending → verified / mismatch /
  rejected / unverifiable 状态机，unverifiable 可 retry；转换只经
  markResolved 受控口）；**三段核验管道 EvidenceGroundingService**（grounded
  EvidenceStore 写入唯一入口）：Stage 1 quote 逐字校验（确定性；NFKC /
  去零宽与软连字符 / 空白折叠 / 小写归一后子串匹配；失败 → mismatch 终态——
  Agent 虚构引文在此拦截）→ Stage 2 metadata 核验（确定性；与 sourceImport /
  citationIntegrity 共享 ScholarlyResolver；mismatch → 终态；not_found /
  unresolved 如实记录不阻塞——离线部署全链路可用）→ Stage 3 语义 judge
  （唯一 LLM 阶段；**复用 Citation 角色** scope `citation/evidence/<id>`，
  不新增第五 Agent；prompt 只喂 claim+quote+chunk 原文；supported →
  verified+direct / partially_supported → verified+partial / unsupported →
  rejected / insufficient_evidence → unverifiable 不伪造裁决；keyQuote 伪造
  剥离）；**Evidence 工具面**（get_chunk 按 chunkId 精确回取原文 /
  propose_evidence 只入候选队列 / evidence_query 只读查询；权限矩阵：
  researcher=3、writer=evidence_query、reviewer·citation=get_chunk+query；
  write_evidence 不存在——工具零 EvidenceStore 写路径，evidence_query 拿
  EvidenceReadAccess 只读投影）；**workflow**：idea_to_paper 新增
  `evidence.ground` stage（research 后 feasibility 前——evidence stats 消费
  口径先行核验；幂等 + 零候选 no-op）；Researcher 兼容双路径（JSON evidence
  带 chunk 锚定 → 候选管道；无锚定 → legacy unverified 追加，输出契约不变）；
  EvidenceStore +appendBatch（批量转正一次 loadAll）；HTTP `GET
  /api/projects/:id/evidence/candidates` + `POST .../evidence/ground`；错误码
  INVALID_CHUNK_ID / CHUNK_NOT_FOUND / SOURCE_NOT_FOUND。新增后端测试 50
  （quote 归一化 / 候选状态机 / 三段核验全路径 / 工具权限矩阵 / 安全红线
  「全部工具轮询后 evidence.jsonl 零写入」/ stage E2E）。决策 D-0037。

### M6.4 Project RAG & Hybrid Retrieval（✅ 2026-09-17）

- 「资料已入库且有全文后，Agent 如何稳定、准确、可追溯地找到当前需要的
  内容」：`backend/src/retrieval/` 域 10 个新文件。**确定性 SourceChunk 管线**
  （section→paragraph→sentence→word 四级切分；target 400 / max 600 /
  overlap 60 token（`estimateTextTokens` 同口径贯穿切分/嵌入/打包）；稳定
  chunkId `<sourceId>:<sectionId>:<节内序号>:<内容hash10>`——内容不变 rebuild
  逐字节不变；page/section provenance 来自 pymupdf blocks；PDF 走 paper 域
  PyMuPdfParser 优先、builtin 文本层回退；metadata-only/bibtex/image 结构化
  skip——abstract 永不冒充全文）；**进程内 BM25 lexical**（中英兼容 tokenizer：
  英文小写词 + 连字符标识符双索引、中文 bigram + 尾单字；章节标题并入索引
  token 流；零 Elasticsearch）+ **optional dense**（EmbeddingProvider 抽象 +
  identity 缓存失效；pi-ai 无 embedding API → 生产默认 lexical-only 健康运行；
  确定性测试 provider 验证机制）+ **RRF k=60 hybrid**（量纲无关融合 + 邻近
  chunk 去重）+ **metadata filter**（sourceIds/sourceRole/section/year/
  sourceType）+ **Context Budget Packing**（token 预算 / 邻近冗余 / 来源多样性
  + `[SRC:… CHUNK:… SECTION:… PAGE:…]` 引用标记）；**文献库签名自动增量
  刷新**（新增补建 / stale 重生成 / 孤儿清理 / 损坏自愈；删除全部产物 rebuild
  恢复同等结果）；`retrieve_library` Agent 工具（researcher/writer/reviewer；
  按会话 projectId 闭包构造——项目隔离由构造边界保证；retrieved ≠ verified，
  零 EvidenceStore 写路径）；HTTP `POST /api/projects/:id/retrieval/{search,
  rebuild}` + `GET .../stats`；错误码 SOURCE_NOT_INDEXABLE / RETRIEVAL_NOT_READY /
  EMBEDDING_UNAVAILABLE / INVALID_RETRIEVAL_FILTER。**固定 benchmark**
  （22 queries 五类）：lexical R@1=0.86 R@5=0.90 R@10=0.90 MRR=0.87；
  hybrid(mock) R@5=0.95 R@10=1.00；性能 4290 chunks 索引 619ms / p95=2.6ms。
  新增后端测试 108（全离线确定性；真实 pymupdf 仅 1 fixture 测试）。决策 D-0036。

### M6.3 Research Discovery & Academic/Web Search（✅ 2026-09-17）

- 「PaperTeam 如何可靠地发现资料」：`backend/src/search/` 域 11 个新文件。
  共享 **ProviderHttpClient**（超时 / 重试（429+5xx+网络+超时）/ 指数退避+抖动 /
  Retry-After 双格式双硬帽（请求内 ≤5s、冷却 ≤60s）/ 按尝试计数熔断
  （open→half-open→close）/ Provider Health 四态、限流≠宕机、HTTP-200 信封
  业务错误穿透）；**真发现型学术检索**（≠ 标题查证）：OpenAlex primary（年份/
  OA filter + mailto 礼貌池）+ Semantic Scholar enrichment/fallback（匿名可调、
  可选 key）+ arXiv preprint（Atom 轻量解析）+ AMiner China-secondary（仅免费
  端点，付费一律不接）；**SearXNG Web Search**（optional：未配置/离线/JSON API
  未启用均不影响启动与学术链路；compose `--profile research` + settings 模板
  json format + cn.bing/baidu 白名单）；**多源融合**（SourceIdentity 分层键去重
  复用 M6.2 + 带权重倒数排名 + 字段互补合并 + preprint/正式版不 collapse）；
  **显式候选持久化**（默认零持久化，`saveAsCandidates` 显式写 CandidateStore，
  provenance 含 query；检索链路零 EvidenceStore 写路径）；HTTP
  `POST /api/projects/:id/research/{academic,web}-search` +
  `GET /api/research/providers`；Researcher 工具 search_papers v2（真检索）+
  search_web。错误码 SEARCH_ALL_PROVIDERS_FAILED / SEARCH_PROVIDER_NOT_CONFIGURED。
  新增后端测试 72（全离线）+ 4 个默认跳过的 live smoke。决策 D-0035。

### M6.2 Project Literature Library（✅ 2026-09-16）

- 文献入库的领域与持久化基础（检索/RAG 属 M6.3+，本轮零实现，见 D-0033/D-0034）：
  `SourceIdentity` 分层身份键（DOI > arXiv > PMID > 标题指纹+年份+一作 > URL，
  精确判等，preprint 与正式版互不覆盖，版本关系 workKey/versionType/
  relatedSourceIds）；CandidateSource Discovery 状态（candidates.json，
  pending_review → accepted/rejected，promotion 幂等）；五种入库路径（PDF
  contentHash 判重 / DOI / arXiv / URL / BibTeX 最小解析器）；metadata 可信
  水位线 merge（user > resolved > inferred）；解析产物绑定 analysisHash 防失效；
  Evidence 引用阻止删除（409 SOURCE_IN_USE）。全部新字段 optional，M1–M5
  项目零迁移。HTTP：`/sources/import/*`、`/sources/candidates*`、
  `/sources/:sid/{enrich,link}`。新增后端测试 74。

### M5.1 / M5.2 Runtime 生命周期与长程治理（✅ 2026-09-11/12）

- AbortSignal 统一、事件 seq + event_gap、queued cancel、timeout 分层、结构化终态、
  原生 usage；全局并发 / 有界受理 / context budget / session rotation / TTL·GC·容量 /
  观测面 / 安全自愈；160-run soak（详见 docs/PROJECT_STATUS.md）。

### M5.3 Controlled Academic Skill Integration（✅ 2026-09-14）

- 新增三个审计 Skill（MIT，固定上游 commit）：`academic-writing-zh`、
  `academic-review`（K-Dense-AI/scientific-agent-skills @ `0b2afe6`）、
  `academic-style-zh`（op7418/Humanizer-zh @ `91f3d39`），均为 PaperTeam 学术
  适配版（不建立第二套事实系统、不是 AI detector、Reviewer 保持只读）。
- Skill Store 受控化：完整 SHA / LICENSE / PROVENANCE 校验、不可变版本快照、
  篡改检测与自愈、update 预览 / 应用、approved catalog 安装；无任意 URL 安装。
- role + contextScope 路由：fact / academic / style Reviewer 得到不同 Skill 集，
  Writer 普通写作 vs style-polish 不同；旧 role-only 调用兼容。
- 会话级 Skill 版本固定（更新只影响新会话 / 新 generation）；任务终态携带
  `skills.assigned` 与真实观测的 `skills.accessed`（无事件时如实 unknown）。
- Skills 设置页：用途 / 来源 / 固定 revision / hash / 绑定 / 更新状态；
  安装 / 预览更新 / 应用更新 / 查看 provenance。
- 配置：`PAPERTEAM_DISABLED_SKILLS`。

### M5.4 Chinese Academic Style Revision Loop（✅ 2026-09-14）

- run 选项 `stylePolicy`：`suggest_only`（默认，style minor 只是建议）/
  `apply_once`（Gate 通过后 HITL 勾选 style 建议 → style-only 修订，最多一轮）。
- Style Invariant Checker：citation key / 数字单位 / 公式 / LaTeX 结构 / 受保护
  术语 / 否定·比较·强度哨兵；失败不覆盖当前修订、不自动重试。
- Style Reviewer finding 含 reason / proposedAction；AI 概率类字段一律丢弃。
- Quick Review 保持 100% 只读：携带 stylePolicy → 400。
- UI：Improvement 启动的「语言风格建议」选项、HITL 勾选面板、「语言润色」状态卡。
- M5 eval corpus（A–E 自建样本）+ `styleSignals` 确定性扫描 + 人工评价模板。

### M5.5 Linux / Docker Deployment（✅ 2026-09-15 真实 Docker 验收通过）

- `Dockerfile`（多阶段：frontend-build / backend-build / `backend` / `web`）、
  `compose.yml`（web 唯一对外端口、backend 内部、双 named volume、stop_grace_period）、
  `docker/nginx.conf`（同源反代，SSE 不缓冲）、`docker/backend-entrypoint.sh`
  （volume 属主修正 + setpriv 降权）、`.dockerignore`。
- `GET /ready` readiness（Runtime + 数据根可写 + TeX / Python 状态，degraded 如实）；
  `/health` 保持 liveness。
- 优雅停机：`PAPERTEAM_SHUTDOWN_TIMEOUT_MS`（默认 30s）替代固定 5s 硬退出；
  先停止受理，再取消 / 收敛 / 释放会话。
- CI：`.github/workflows/ci.yml`（ubuntu build / typecheck / test + docker build smoke）。
- 真实 `docker compose` 验收已通过（2026-09-15，WSL2 + Docker Engine：build / up /
  health / 持久化 / 容器内 XeLaTeX 中文 PDF 与 PyMuPDF / SIGTERM 优雅停机，见
  docs/DEPLOYMENT.md §7）。

### M5.6 Real Paper Acceptance & Release（✅ 2026-09-16）

- 真实 26 页中文工科论文 A/B（glm-5.3）：多轮真实执行——首轮两臂均 Draft PASS /
  Final blocked（Gate 如实 FAIL）；Quick Review 零写入；材料不足提案不编造；详见
  docs/M5_ACCEPTANCE.md。
- 修复：Writer 修订不再删光 Existing-Paper 重建稿的引用（可引用 key 以
  references.bib 为事实源 + prompt 保留引用）；Style Polish 在 Draft 路径也提供一次；
  `runtimeStats.usageTotals` + per-task usage 日志（含 assigned / accessed skills）；
  compose 默认执行超时 900s；`scripts/m5-acceptance.mjs` 验收执行器。
- 09-15/16 收口：**Citation Preservation Gate**（无计划依据的引用丢失 → FAIL）与
  **Fact Preservation Gate**（表格数值 / 正文数字 / 公式 / 方向结论等确定性保护，
  篡改稿拒绝冻结 Draft）；长论文执行超时分层；CI 首次全绿；修复后 A/B（A8/B6）
  两臂引用丢失 0；最终 fact-gate 轮两臂事实改写均被 FAIL 拦截。
- 最终判定：engineering goals achieved；Skill 质量增益未获稳定证据（两轮独立盲评
  均判开启臂危害更小 2/2，样本量不足以宣称）；pairwise 口径为 Independent Model
  Pairwise Evaluation（human optional）。**未打 tag**：验收语料上 Final 产物无法
  达成（发布条件不满足）。

### M5.7 Final Productization & Revision UX（✅ 2026-09-16）

- per-Agent provider/model 配置（contextScope 确定性路由、credential 与 override
  解耦、失效结构化失败不静默回落）+ 外部专家 / 导师 / 用户修改意见驱动的修订
  （原文逐字保存、mandatory 最高业务优先级、确定性 handled / conflict 状态机、
  安全 Gate 口径不变）。详见 docs/RELEASE_NOTES_M5.md。

## [0.1.0-mvp] — 2026-09-10 — M4 MVP（Alpha）

首个公开里程碑：M1–M4 全部完成，三条产品路径闭环。详见
[docs/RELEASE_NOTES_M4.md](docs/RELEASE_NOTES_M4.md)。

### 三条产品路径

- **Idea-to-Paper**：调研 → 可行性（HITL）→ 大纲（HITL）→ 分节写作 → 引用核验 →
  三路审稿 → 修订闭环 → 质量门禁 → LaTeX 编译 → Draft / Final。
- **Existing Paper — Quick Review**：PDF 导入 → PaperMap → 引用真实性 + 语义核验 →
  分章节审阅 → 聚合报告（Markdown 导出）；全程只读。
- **Existing Paper — Improvement**：PDF 导入 → 确定性重建可修订稿件 → 审稿基线 →
  改进计划（HITL）→ Writer 逐节修订 → 质量门禁 → Draft / Final（M4.8 起浏览器全链路可达）。

### Runtime 与编排

- Pi SDK in-process 为唯一 Agent Runtime（`@earendil-works/pi-coding-agent` 0.84.4，
  精确 pin）；`AgentRuntime` 契约 v2（startAgent → 句柄：事件流 / 取消 / result）。
- 确定性 TypeScript WorkflowOrchestrator：Stage DoD、checkpoint / 断点恢复、
  HITL、协作式取消、bounded loop、SSE Domain Event。
- 会话维度 `projectId × agentId × contextScope`；Reviewer 三路审稿独立会话并行。

### 引用完整性

- Layer 1 真实性核验：Crossref / OpenAlex / Semantic Scholar / arXiv；失败语义
  严格（网络故障 ≠ not_found ≠ 捏造）。
- Layer 2 语义核验：原子论断 × 引用组（v5）、judge 禁止凭记忆判定、伪造引文
  剥离、确定性 severity；按 run 配置（off / contradiction_only / full，缺省 off）。

### 审阅与修订

- Reviewer 三 skill（fact / academic / style）并行 + 确定性聚合。
- 分章节审阅有界并发（`PAPERTEAM_REVIEW_CONCURRENCY`，真实 benchmark 2.61× 总提速）
  + per-section journal 崩溃恢复。
- 确定性 Revision Plan → Writer 逐节修订 → 强制复审 → 收敛判定
  （PASS / IMPROVED / CONVERGED / REGRESSION，零 LLM）。
- Quality Gate：13+ 条确定性规则、轮次隔离、修订后过期如实提示、可解释阻止项。

### 产物与版本（M4.7 / M4.8）

- Build Gate 与 Quality Gate 分离（Draft 只要求可构建，D-0015）。
- Draft / Final 不可变产物（manifest 只增不改；下载只经 manifest 解析防路径穿越）。
- LaTeX 编译失败自动修复 ≤2 次（最小上下文：受影响文件 + 结构化诊断）。
- **版本体验（M4.8）**：不可变修订链上的版本历史（ManuscriptVersionDTO）、
  两修订确定性比较（章节级差异 + 记分对照，零 LLM）、恢复历史版本
  （= 创建新修订，历史与旧 Final 永不删除；旧 Gate 自然 stale）。
- 摘要（abstract）为一等修订目标（载体 outline.abstract；禁止路由到组装根 main.tex）。

### 工作台（React 19）

- 项目列表 / 创建（双模式 + PDF File-First 导入）/ 项目生命周期（归档 / 恢复 /
  永久删除）。
- 工作流实时视图（Stage Timeline / SSE / 取消 / 分章节进度）、HITL 决策面板、
  Evidence 工作台、质量门禁面板、论文产出（Draft / Final / 构建 / 迭代 / 版本历史）。
- 浅色 / 深色 / 跟随系统主题；模型设置（Provider / 模型搜索 / 自定义网关 /
  Test Connection，Key 不回显）。

### 已知限制

Visual Reviewer、Skill install/update、Docker 部署、系统管理后台未实现
（M5+）；后端进程崩溃时进行中的模型调用经 checkpoint 重试而非迁移；
Windows 下 LaTeX 编译超时只终止 shell 进程；单机单用户形态。
完整清单见 [README](README.md#known-limitations真实清单)。
