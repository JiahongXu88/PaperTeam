# M15.1 — Scientific Review Input & Claim Integrity（工程研究记录）

> 日期：2026-10-22 · 仓库 `D:\Projects\PaperTeam`（`git rev-parse --show-toplevel` = `D:/Projects/PaperTeam`，origin = `https://github.com/JiahongXu88/PaperTeam.git`，分支 `main`）
> 起点 `3400f87`（main == origin/main，工作树干净）· 代码提交 `f2e7804` · 本报告与状态提交见 PROJECT_STATUS
> 实验数据（仓库外，不推送）：`D:\PaperTeamData\M15\M15_1`（scripts / registry / builds / experiments / analysis）；冻结语料与旧 base run：`D:\PaperTeamData\M15\QualityGateCalibration`
> **结论：M15.1 `PARTIAL`**（工程交付与 Shadow 接线完成、真实 DEV 跑通；但 VERIFIED 判定守卫是在同一批 DEV 上发现并修补的，未经独立样本验证；finding 诊断精度不足以驱动降级；新提交的 CI 结果见文末）。生产 Quality Gate 行为边界**未改变**。

## 1. 执行前后基线

| 项 | 执行前（3400f87） | 执行后（f2e7804 工作树） |
|---|---|---|
| backend typecheck | exit 0 | exit 0 |
| backend `vitest run` | 376 文件 / 4066 通过 / 40 skipped / 0 失败 | 382 文件 / 4105 通过 / 40 skipped / 0 失败 |
| frontend typecheck / test | exit 0 / 38 文件 364 通过 | exit 0 / 38 文件 364 通过（前端未改动） |
| `git diff --check` | — | 通过 |

环境：Windows 11，Node 22，模型通道 `glm/claude-opus-5-5`（与 M15 相同，经现有设置路径；未打印、未提交任何凭据）。日志：`D:\PaperTeamData\M15\M15_1\baseline\*.log`。

M15 数据核对（读取原始 JSON，非转述）：`analysis/summary.json` 存在，155 run / 3035 调用 / 1 次失败调用；DEV 82 + HELDOUT 28 = 110 次 base Gate 全 FAIL；三条 required NOT_EVALUATED 在 82/82、28/28 恒出现；`registry/split_lock.json`、`final_freeze.json`（manifest sha256 `731eab9f…`）、`baseline_metrics.json`、`heldout_metrics.json`、`candidate_eval.json`、`scripts/run_job.mjs` 等均存在。**本轮只用 DEV**，harness 显式拒绝 HELDOUT（`run_job_m151.mjs`：split≠DEV → 抛错）。

## 2. 合同审计矩阵（Baseline Matrix，3400f87）

| 场景 | 入口 | 输入 | Fact Claims | Citation 可执行 | 必然 NOT_EVALUATED | 终态策略 |
|---|---|---|---|---|---|---|
| normal research / survey review | `idea_to_paper` / `topic_survey`，`review.run`（作者稿件口径） | 作者 LaTeX + verified Evidence；digest 无损时三路 digest | digest：fact 路 `claims[]`（`FactClaimCheck`，claim 可为复述，无原文定位） | `citation.verify` 在 review 前执行（静态 + 元数据） | 证据库为空时 `no_contradictory_evidence`（不阻断） | gate.passed → Final；否则 bounded 修订 / Draft |
| long-document units | 任一 `review.run`，digest 有损（节 >3600 / 总 >60k / >24 文件） | 单元原文（≤9000 字）+ 章节索引 + 可选依赖快照 | **不产生**：`reviewUnit()` 只解析 issues + 分数 | 取决于所在工作流 | `unsupported_critical_claims_zero`（required → passed=false） | 同所在工作流 |
| `published_paper_assessment` | `idea_to_paper` + `request.reviewPurpose`（POST /workflows、M15 harness） | 第三方论文 LaTeX（作者源稿或 PDF 转写投影） | 单元模式不产生 | **不执行** `citation.verify` | `hallucinated_citations_zero`、`citation_structure_valid`、单元模式下 `unsupported_critical_claims_zero` | review.run → quality.gate → 以 `review` 结束，不修订；结论看只读视图 |
| `existing_paper_review`（PDF Quick Review） | PDF → PaperMap → `citation.extract/metadata/claims` → `review.sections` → `review.aggregate` | Final PDF 解析产物 | 无 claim 账本；章节 finding + 引用语义核验（按 mode） | PDF 路径自己的 references / callouts / 元数据 | 无 Quality Gate | 只读报告，Writer 不被调用（既有测试 `externalInstructionsFlow`） |
| existing paper revision（含外部审稿意见 = revision task） | `existing_paper_improvement` | 导入稿 + 冻结基线 + 授权台账 | digest 有 claims（claimGapAudit 按修订引入口径）；长文档单元模式不产生 | `citation.verify` | 长文档时 claims 规则 required NOT_EVALUATED | Revision Task Complete 与 Publication Ready 分层（`revisionTask` / `publicationReadiness`） |

**M15 三条 required NOT_EVALUATED 的真实成因**（110/110）：

1. `hallucinated_citations_zero`、`citation_structure_valid` —— **机制未执行**：只读路径 `planPublishedAssessment` 只排 review.run → quality.gate。即使执行，A/B 轨（PDF 转写，作者-年份引文、无 `\cite`）在 `StaticCitationChecker` 下 citedCount=0 → `NOT_APPLICABLE「没有任何 \cite」`，会把「有大量作者-年份引用」误读为「没有引用」；C 轨（作者 LaTeX + thebibliography）经 `collectLatexFiles` 的内联 bib 渲染可以执行。即：一半是机制缺失，一半是输入格式不被支持。
2. `unsupported_critical_claims_zero` —— 单元审稿契约里**根本没有** claims 字段（不是解析丢失）；`factVerdicts=null`，规则如实 NOT_EVALUATED。

本轮**没有**把这三条改成 PASS，也没有让只读路径去跑 `citation.verify`：生产规则、80 / 35 阈值、Major 零容忍全部原样，新能力全部走 shadow 产物。

## 3. 设计与文件清单

| 文件 | 作用 |
|---|---|
| `backend/src/review/claimAudit.ts`（新） | Review Claim Ledger：`paperteam.review-claim-audit/v1`；`claimId = cl1-sha256(file \| NFKC 去空白原文 \| 文件内出现序号)[0:16]`；原文 span / 行号 / sha256；`claimType`；`linkedRefs`（复用 `reviewContextSnapshot` 依赖解析）；`verificationStatus`（8 态）与 `basis` / `verifier` / `downgrades` / `contextCompleteness` 分开；M15.2 预留 `assessment`；跨单元查找任务 + 有界复核；`validateClaimAudit`（修订 / 指纹 / 原文切片校验 → STALE） |
| `backend/src/review/claimAuditText.ts`（新） | 逐字定位（空白折叠 + NFKC）、数值解析 / 量纲换算 / 显示精度容差、描述词可比、同量前提（表格行标签）、派生量识别、区分性术语 |
| `backend/src/review/claimAuditMode.ts`（新） | `auto / off / shadow / extended` |
| `backend/src/review/findingAudit.ts`（新） | finding provenance：`CONTEXT_INCOMPLETE` / `PARSE_ARTIFACT_SUSPECTED` / `QUOTE_NOT_LOCATED` / `NO_QUOTE` / `TEXT_LOCATED` |
| `backend/src/citation/readOnlyCitationAudit.ts`（新） | 只读引用审计四层 + PDF Quick Review 同口径四层摘要 |
| `backend/src/quality/qualityDecisionV2.ts`（新） | V2 影子 schema（科学 / 引用 / 学术基线 / Style advisory / 核验完整性 × 三种 Decision Policy） |
| `backend/src/agents/ReviewerService.ts` | 单元 prompt 在 `claimAudit` 时追加 `unit-claims/v1` 契约；claims 缺失 / 非数组 ≤1 次有界修复；`recheckClaimsCrossUnit`（sealed 新会话）；digest fact 路可选扩展字段 |
| `backend/src/agents/outputParsing.ts` | **Bug 修复**：JSON 字符串内原始控制字符 |
| `backend/src/workflow/definitions.ts` | review.run：模式解析、单元契约注入、claims 随 journal 持久化与恢复、`runReviewAudits`（来源核验、账本、复核、finding 诊断、引用审计，失败不影响生产审稿）；quality.gate：`computeShadowDecision`（校验账本 → V2 影子落盘 → 只读视图 `scientificAudit`）；PDF Quick Review 报告 `citationIntegrity.auditLayers` |
| `reviewArtifacts.ts` / `coverageLedger.ts` / `reviewPurpose.ts` / `CitationService.ts` / `StaticCitationChecker.ts` / `config.ts` / `serviceStack.ts` / `index.ts` | 版本化产物读写、`ReviewUnitOutcome.claimExtraction`、只读视图字段、`verifyEntryMetadata`（不写 citation-report）、导出 `\cite` 命令表、配置透传 |
| 测试（新 6 文件 + 3 处补充，共 +39） | `claimAudit` 18、`findingAudit` 4、`readOnlyCitationAudit` 5、`qualityDecisionV2` 2、`m151ReviewerContract` 4、`claimAuditReviewRun`（真实 review.run / quality.gate）4、config 1、outputParsing 1；PDF Quick Review 报告四层摘要在既有 `citationSemanticMode` 测试中补断言 |

**兼容性**：旧产物没有这些文件 → `computeShadowDecision` 返回 null、只读视图 `scientificAudit: null`；旧单元 journal 没有 `claimExtraction` → 账本该单元 `NOT_REQUESTED`；extended 契约进入 prompt → 请求指纹变化 → 旧记录不会被当作新契约输出复用。作者稿件工作流在 `auto` 下为 shadow：**所有审稿 prompt 逐字节不变**（`m151ReviewerContract` 与 `claimAuditReviewRun` 断言）。

**为什么没有绕过验证**：生产 `evaluateQualityGate` 不读任何新产物；新产物只在 `evaluationPolicy.productionGateImpact = NONE_SHADOW` 下落盘；`NOT_EVALUATED` 在 V2 影子里进入 `verificationCompleteness.missing`，不进入任何通过计数；shadow 审计异常被捕获并记日志，不会使 review.run / quality.gate 失败或改变其结果。

### 3.1 状态口径（核心）

- `VERIFIED_SUPPORTED / VERIFIED_CONTRADICTED`：只来自 ① 正式 verified Evidence（`evidenceIds` 仅在命中正式证据时填写），② 预登记复算（作者实验包），③ **原文内跨处核对**：两处引文都在被审修订中逐字定位；模型写出的两个值都能在各自引文中找到；描述词可比；不是两个不同表格行；不是派生量；无量纲歧义；来源为 `AUTHOR_SOURCE` / `SOURCE_ATTESTED`；上下文完整。③ 的对应关系仍由审稿模型提出——产物里 `verifier = model+deterministic`、`statusReason` 如实写明。
- 模型判断只能给 `REVIEWER_SUSPECTED / REVIEWER_CONSISTENT`；digest `UNSUPPORTED` → `AUTHOR_CHECK_REQUIRED`（「无已核验证据」≠ 证伪）。
- 依赖缺口 / `NEEDS_OTHER_SECTION` → `NOT_EVALUATED + CONTEXT_INCOMPLETE`，生成确定性查找任务（`\ref` / 编号 / 区分性术语，片段整段附上、预算 6000 字）；extended 模式下最多 `PAPERTEAM_REVIEW_CLAIM_RECHECK_CALLS`（缺省 2）次复核调用、每次 ≤8 条、每批 1 次重试，超出记 `SKIPPED_BUDGET`；复核返回的引文必须逐字落在候选片段中。
- 转写稿（`SOURCE_UNVERIFIED / SOURCE_UNKNOWN`）上的表格 / 公式 / 替换字形 → `PARSE_ARTIFACT_SUSPECTED`，最高 `REVIEWER_*`。
- 覆盖：正文覆盖（单元字符）、抽取完成率、任务账本分别报告；`scientificClaimCoverage = NOT_MEASURABLE`。

## 4. 真实实例

### 4.1 单元论断账本 + 跨章节核验（C03 注入 HEADLINE_CROSS：摘要 HOTA 61.7→63.7，确定性真值）

`m151b__KF35A0E8__r1`（`D:\PaperTeamData\M15\M15_1\experiments\runs\…\artifacts\claim-audit-r1.json`）：

- 摘要单元（shared_session，审稿时看不到结果表）自报 `check=NEEDS_OTHER_SECTION`，账本初态 `NOT_EVALUATED + CONTEXT_INCOMPLETE`；查找任务按术语 HOTA / MOT17 取出「Benchmark Results」主表与「Conclusion」句；复核调用返回 `INCONSISTENT`，引文 `In evaluations using the MOT17 dataset, SFSORT achieved an HOTA of $61.7$\%` 逐字落在片段中，`63.7% vs 61.7%` → **VERIFIED_CONTRADICTED（IN_TEXT_CROSS_CHECK，origin=cross_unit_recheck）**。
- 结果表行 `This work (SFSORT) & 61.7 & 74.4 & 78.8 & 2241.8`（main.tex 行号在 location 字段）与结论句同样以摘要为对照 → VERIFIED_CONTRADICTED ×2。
- 同摘要的 MOT20 `60.9% / 304 Hz` vs 表格 `60.9 / 304.1` → VERIFIED_SUPPORTED（显示精度容差内）。
- 旧版（base r1）也检出该注入（2 条 finding，最高 critical）；新版 5 条 finding（最高 critical）+ 3 条已核实矛盾论断。

### 4.2 量纲（C11 注入：14 cm → 14 mm）

`m151b__K34B54A9__r1`：结果单元论断 `with an average absolute joint position error of about 14\,mm` 对照表格行 `\textbf{198.1} & \textbf{140.9} & \textbf{142.7}`，模型写 `about 14 mm vs 142.7 mm`（两侧单位都写明，同量纲换算后不等）→ VERIFIED_CONTRADICTED。若模型只写裸数 `142.7`，`compareValues` 给 `SCALE_AMBIGUOUS`（14×10≈142.7）→ 只能 REVIEWER_SUSPECTED（单测覆盖）。

### 4.3 原稿自身不一致（C12，M15 子代理确定性登记）

`m151b__K4C3F05B__r1` 两条 VERIFIED_CONTRADICTED 恰好对应登记的 `C12-O01`（正文 CFP-FP 97.27% vs 表 99.27）与 `C12-O02`（正文 AdaFace 58.3% vs 表 58.24，应舍入为 58.2）。旧版这两处只有 minor finding、无论断级核验。

### 4.4 C06「5.46%」（派生量）

`C06-O01/O02` 是「三个 RODNet 平均值的提升」——派生算术。新版 finding 检出（K70715C8 旧 4 / 新 7 条）；论断账本中摘要 / 结论两处 `NOT_EVALUATED + CONTEXT_INCOMPLETE`，结果节一条 `REVIEWER_SUSPECTED + VALUE_NOT_COMPARABLE`——**没有**因为「两个写出的数不同」而确认矛盾。确定性复算派生量留给 M15.2。

### 4.5 跨单元假缺失（K4C3F05B）与 PDF 伪影（KEADC367）

- 离线（零模型）对 M15 旧 base 产物重放 `findingAudit`：K4C3F05B #0「摘要只列 4 个数据集、其余三个未说明」→ `CONTEXT_INCOMPLETE`，命中「Person Re-identification / Adaptive Weighting」等单元中同句共现的 IJB-S、TinyFace、DeepChange、MSMT17；KEADC367 #36「TH、TL 在本节没有给出」→ 命中「3.3 实现细节」同句（0.8 / 0.5）；KEADC367 #19「式(2) LaTeX 源码损坏」（引文 `\[ si iou(M,bi) < NM s∗i= (2) … \]`，无任何 LaTeX 命令、编号写进公式）在转写稿上 → `PARSE_ARTIFACT_SUSPECTED`，`originalCheck=NOT_AVAILABLE`（项目没有页面级 provenance，如实声明无法回看原件）。
- 新 run（m151b）中 KEADC367 同类公式 finding（#19、#31、#38）同样被标 `PARSE_ARTIFACT_SUSPECTED`。

### 4.6 只读引用审计

12 个新 run 全部 `inputAdequacy=ADEQUATE`，正文引用 → 文后条目匹配 1129/1158；外部元数据层 `NOT_EVALUATED`（harness 关闭 provider，不访问网络），真实性一律 `NOT_EVALUATED`。离线扫 56 个 DEV 输入：A 轨作者-年份 444/519（86%，未匹配多为中文作者名 ↔ 拼音条目，记 `needs_review`）、B 轨 818/1028（80%，主要因 PDF 转写把条目续行截断导致无年份）、C 轨 `\cite` 2280/2571；C 轨 3 个输入没有参考文献列表 → `INSUFFICIENT_EVIDENCE / NOT_EVALUATED`（不逐条报「无对应条目」）。

## 5. 指标与失败样本（工程可用性 ≠ 学术质量准确性）

### 5.1 真实 DEV 对照（12 run，同一模型、同一冻结输入；old = M15 base r1，new = m151b）

| 指标 | old | new |
|---|---|---|
| 生产 Gate passed | 0/12 | 0/12（未改语义） |
| required NOT_EVALUATED | 三条恒在 | 三条恒在（未改语义） |
| 单元论断抽取完成 | —（不存在） | 240/240 单元，1382 条论断入账，拒收 2 |
| 论断状态（最终代码重放） | — | VERIFIED_CONTRADICTED 6 / VERIFIED_SUPPORTED 18 / REVIEWER_SUSPECTED 157 / REVIEWER_CONSISTENT 371 / AUTHOR_CHECK_REQUIRED 88 / EXTERNAL_DATA_REQUIRED 266 / NOT_EVALUATED 476 |
| 跨单元任务 / 复核完成 | — | 394 任务，133 有候选片段，123 复核完成，0 失败，10 超预算跳过 |
| 引用审计 attempted / adequate / matched / external | 未执行 | 12 / 12 / 1129 of 1158 / 0（未启用） |
| 注入缺陷 finding 检出（确定性真值） | 5/5 | 5/5 |
| 注入缺陷进入 VERIFIED_CONTRADICTED | — | 2/5（HEADLINE_CROSS、UNIT_ERROR）；其余 3 条为派生倍数 / 公式定义 / 相对提升，停在 REVIEWER_SUSPECTED |
| 单元「0 issue + 分数 null」（JSON 控制字符误解析症状） | 5 个单元 | 0 |
| critical+major finding 总数 | 306 | 256（见 5.3 风险） |

**VERIFIED_CONTRADICTED 的真假**（6 条，最终代码）：3 条 C03 注入、1 条 C11 注入（确定性真值）、2 条 C12 原稿登记不一致（子代理确定性登记）——6/6 为真。**但**：冻结构建 m151b 在同一批 run 上曾给出 11 条，其中 5 条为误判（「Default」行 vs「Fixed Hyperparameter」行、「38800+5300+18700 vs 54K」、「35000 vs 80%×54K」）；smoke 构建 m151 还出现「7-fold vs 4 videos」。这些守卫（描述词可比、同量前提、派生量、千位后缀）是**在同一 DEV 上发现后补的**，重放证明修补后同一批模型输出 0 误判、其余论断状态逐条不变（`analysis/replay_m151b.json`：12/12 论断集合一致，变化只有这 5 条），但这不是独立验证——存在对 DEV 过拟合的风险。

### 5.2 finding provenance 诊断的精度（离线，56 个 DEV 旧 run，4714 条 finding）

对照 M15 精确度抽样 96 条（**Claude 子代理模型辅助核对，不是人类金标准**）：被标 FALSE_CROSS_UNIT / CONVERSION_ARTIFACT 的 6 条中 5 条被诊断（4 条跨单元中 3 条、2 条转写伪影 2 条）；但 76 条被标为真的 finding 中也有 15 条（20%）被标 `CONTEXT_INCOMPLETE`。全体 critical/major 中 216/1091 标 CONTEXT_INCOMPLETE、14 标 PARSE_ARTIFACT_SUSPECTED。**结论：可作为「需定向复核」的候选清单，不能据此自动降级严重度**——这正是 M15.2 的输入。

### 5.3 确凿 Bug（已修）与残留风险

- **outputParsing 控制字符 Bug**（生产影响）：模型逐字摘录 LaTeX 表格行时把原始 Tab 写进 JSON 字符串 → `JSON.parse` 失败 → `extractJsonObject` 回退到内层碎片 → 整个单元的 issues 与分数被静默丢弃。M15 base 2170 次输出中 5 次（全在 C03 家族，含「Benchmark Results」这个注入所在单元），M15 报告的 C03 单元分 / finding 数受此影响。修复后只在原文解析失败时转义字符串内控制字符重试一次，结构不合法仍拒绝。新 run 0 次。
- **critical+major 数下降**（306→256，9/12 run 下降、3/12 上升）：单样本，M15 已测得 major 数 CV 0.2–0.6；可能是 claims 契约分散了输出注意力。已知缺陷（注入 5/5、登记原稿不一致）检出未下降，但这不能排除对未知真问题的召回下降——须在 M15.2 用重复采样判定，**extended 契约目前只在只读评估口径启用**，作者返修工作流 prompt 未变。
- 论断账本覆盖不可测：模型列出的论断 ≠ 全文论断；476 条仍 NOT_EVALUATED（多为不需外部数据却未核对的方法性陈述）。
- 来源声明（`input-provenance.json`）是声明不是核验；harness 按 manifest 写入（C 轨作者 LaTeX / A、B 轨 PDF 转写）。

## 6. Existing Paper Revision 回归与决策语义

- 作者稿件工作流 `auto → shadow`：单元 / digest prompt 逐字节不变；existing-paper 的 claimGapAudit、Fact / Citation Guard、revisionTask / publicationReadiness、作者 HITL、外部意见作用域逻辑**未改动**；全量 4105 测试（含 M11.4 revisionTaskGate、externalInstructionsFlow、revisionLoop、m1044DispatchE2E 等）通过。
- 唯一影响所有工作流的行为变化是 outputParsing 修复（以前被静默丢弃的单元 finding 现在会被保留 → 可能使 Gate 多看到真实 finding）。这是 Bug 修复，不是阈值调整。
- Style：`suggest_only` 缺省、`apply_once` 显式（既有 `stylePolish.test`）；Style 输出仍丢弃 `aiProbability` 等字段（新 `m151ReviewerContract` 断言）；V2 影子把 Style 定为 `ADVISORY_NOT_A_GATE`、`provenanceJudgement=NOT_PRODUCED`，生产 `styleRisk≤35` 不变；Quick Review 不调用 Writer（既有测试）。

## 7. 成本、模型与输入覆盖

| 批次 | run | 调用 | 失败 | input / output / cacheRead / cacheWrite | 估算 USD |
|---|---|---|---|---|---|
| smoke（m151，构建 1） | 1 | 28 | 0 | 112 / 69,507 / 2,035,050 / 198,534 | ≈4.00 |
| DEV 对照（m151b，构建 2） | 12 | 270 | 0 | 1,204 / 837,417 / 18,223,707 / 2,615,274 | ≈46.41 |
| 确认复跑（m151c = 提交 f2e7804 的冻结构建） | 2 | 49 | 0 | 228 / 130,162 / 3,697,589 / 633,986 | ≈9.06 |

合计 15 run / 347 调用 / 0 失败 / ≈$59.5。确认复跑（新会话、新采样）：C03 注入变体 VERIFIED_CONTRADICTED 2 条（摘要 63.7 vs 表 61.7、表行 vs 摘要），v2 影子 `VERIFIED_CONTRADICTION_PRESENT`、账本校验 VALID；C03 原稿 0 条 VERIFIED_CONTRADICTED（无误判）；两者生产 Gate 仍 FAIL、三条 required NOT_EVALUATED 原样。DEV 批次中跨单元复核 18 次调用（output 21,276、cacheWrite 185,368 token，≈$1.7）。旧 base 同 12 篇：252 调用、≈$45.54——新契约 output token +29%。单价无可核实账单，沿用 M15 的 Opus 档公开价位 **ESTIMATED** 口径；模型 `glm/claude-opus-5-5`，每 run 一进程、独立预算账本（`experiments/budget-ledger.json`，上限 700 调用 / 60M token），live run 上限 20（实际 15）。输入覆盖：C 轨 10（4 家族，含 5 个注入变体）、A 轨 2、B 轨 1，全部 DEV。

## 8. 判定与 M15.2 待办

**M15.1 = PARTIAL。** 对照 DoD：

1. 论断账本接入真实 review.run 读写 + journal 持久化 + quality.gate 读取校验 ✅
2. VERIFIED / 待核验 / 不可核验分开，缺上下文不确认 ✅（但 VERIFIED 守卫未经独立样本验证 ⚠️）
3. 只读引用审计与覆盖报告，不能验证的 NOT_EVALUATED ✅
4. 跨单元假缺失与 PDF 伪影可复现的降级测试 ✅（诊断精度不足以自动降级 ⚠️）
5. Style 不丢、不产生 AIGC 率、不越权、生产门槛未换 ✅
6. Existing Paper Revision 语义回归通过 ✅
7. 真实 DEV + 确定性缺陷跑通，报告指标与残留错误 ✅
8. Git / CI：见文末

M15.2 建议（依据本轮证据）：

- **定向复核取代词面诊断**：对 `CONTEXT_INCOMPLETE` 的 critical/major finding 与 `NOT_EVALUATED` 论断，用账本里已有的候选片段做有界模型复核（本轮复核 123 次 0 失败、单次 ≤8 条，成本可控），复核结果仍走同一确定性判定。
- **独立冻结样本验证 VERIFIED 守卫**：本轮守卫在 DEV 上发现、DEV 上修补；需另冻结一批（含新注入：表行错位、派生量、量纲、跨表同名列）测 VERIFIED_CONTRADICTED 的精确率，目标是零误判，否则收紧为 REVIEWER。
- **派生量确定性复算**：倍数、相对提升、平均值（C06 5.46%、C03「seven times」）需要「表达式 + 引用单元格」级复算，而不是让模型自报算式。
- **severity / verification / blocking / task_scope 四维**：`assessment` 字段已预留；major 数在 extended 契约下的变化需重复采样定性。
- 外部元数据层：只读评估启用 provider 后测四层中 external 的可用率与限流成本。

## 9. Git / CI

- 本地：`D:/Projects/PaperTeam`，`main`；代码提交 `f2e7804`（feat(m15.1)），随后本报告 + PROJECT_STATUS 提交；不建额外分支、不 force push。
- 推送前全量：backend 4105 通过 / 0 失败，frontend 364 通过，typecheck / build / `git diff --check` 通过。
- 远程 CI / Linux Integration：本文提交时尚未产生结果（PENDING）；以推送后 GitHub Actions 对**新 HEAD** 的实际结论为准，不以旧提交的绿色结果代替。

---

*本文档不含原始论文、模型原始输出或任何凭据；全部原始材料在 `D:\PaperTeamData\M15\M15_1` 与 `D:\PaperTeamData\M15\QualityGateCalibration`（仓库外）。*
