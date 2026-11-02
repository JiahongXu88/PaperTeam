# M16 续期收口 · 原始目标 — 当前证据 — 剩余缺口矩阵

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 起点 `8791708`（= origin/main，clean）
- 本文在**任何新模型调用与 Reviewer 改造之前**建立（工作包 A 的零模型修复除外，见 §3 行 C1），之后只追加「本轮结果」列，不改写开工时的判定。
- 原始目标来源：用户本机 `Downloads\PaperTeam_M15_Quality_Gate_Handover.md`（2026-10-21；§2 四问、§3 M15.4 返修闭环、§4 验收矩阵），仓库内只引用条款，不复制。本轮任务书把「Revision Closure」列为第五问，并把「目标期刊适配」并入 Calibration。
- 历史结论保持原样：M15 TJA = TARGET_JOURNAL_ENGINEERING_COMPLETE_EXTERNAL_VALIDITY_LIMITED；M16 首轮 = EVALUATION_BLOCKED；M16 收口 = BENCHMARK_VALIDATED。本轮结论另见 `M16_QUALITY_GATE_CLOSURE_DECISION.md`。

成熟度标记：`IMPLEMENTED`（有代码路径）· `TESTED`（确定性测试覆盖）· `VALIDATED_ON_REAL_INPUT`（真实论文 / 真实模型运行证据）· `EXTERNALLY_SUPPORTED`（独立于本系统模型族的参考支持）· `LIMITED`（有已知适用范围限制）· `NOT_EVALUATED`（没有证据）。

## 1. 五个原始目标

### 1.1 Completeness — 应审内容是否全覆盖，未审是否显式

| 子项 | 调用链（源码） | 开工时状态 | 证据 |
|---|---|---|---|
| 长文档单元覆盖账本 | `workflow/definitions.ts` review.run → `review/coverageLedger.ts` buildReviewCoveragePlan / computeReviewCoverage → `quality/gates.ts` review_coverage_complete | IMPLEMENTED · TESTED · VALIDATED_ON_REAL_INPUT | `test/workflow/longDocumentReview.test.ts`（失败注入 → 覆盖下降 → Gate 拒绝）；M16 收口两次真实运行覆盖率 1、0 失败 |
| 单文件 LaTeX / 摘要前置区 | `review/revisionScope.ts` locateLatexSections + frontMatterSpan | IMPLEMENTED · TESTED | M14.8 回归 |
| **多文件项目根 main.tex 正文** | `definitions.ts:811`（有子文件时 coverage 只取 `files.sections`） | **缺陷**：写在 main.tex 里的摘要 / 引言 / 结论不成为任何单元，覆盖仍报 1（假完整） | 本轮 A1 复现：`D:\PaperTeamData\M16\OriginalQualityGateGoalClosure\A\a1-baseline-8791708-negative.log`（摘要哨兵句进入 0 个单元） |
| digest 模式的根正文 | `buildManuscriptDigest` → `splitSingleFileDigest`（有）；`digestIsLossy` 只看子文件 | LIMITED：根正文被 digest 截断时不触发长文档模式 | 同上（A1 一并修复） |
| PDF 入口公式 | `review/inputFidelity.ts` FORMULA_UNVERIFIED | IMPLEMENTED · TESTED · LIMITED（文本层抽取，公式结构不可验证） | `test/review/inputFidelity.test.ts`；M16 收口 A 报告 |
| Markdown 适配（评测工具，非产品链路） | `scripts/m16-closure/md-to-tex-fidelity.mjs` | TESTED · VALIDATED_ON_REAL_INPUT（数学 402/402、212/212） | `backend/test/scripts/m16MdToTexFidelity.test.ts` 7/7；图片 = 显式占位、HTML 表合并单元格展平（LIMITED） |
| 版本 / 快照时效 | coverage snapshotId + 单元指纹双绑定；review.snapshot 来源审计；评估后改稿 409 | IMPLEMENTED · TESTED | `coverageLedger.test.ts`（stale 不计入）、`reviewSnapshotProvenance.test.ts`、M15 TJA 409 测试 |

### 1.2 Correctness — 具体缺陷是否准确检出、可复核，不把套话算发现

| 子项 | 调用链 | 开工时状态 | 证据 |
|---|---|---|---|
| 确定性 L1：跨节数值一致性 / 作者数据复算 / 引用元数据 / 已核验证据矛盾 | `review/crossSectionConsistency.ts`、`claimCertificate.ts`、experimentPackages.evaluateClaimChecks、CitationService | IMPLEMENTED · TESTED · VALIDATED_ON_REAL_INPUT（作者稿 / MOT） | M14.9.5.4、M15 长程报告 |
| 作者稿 Claim 级核验 | `review/claimAuditMode.ts` resolveClaimAuditMode：作者稿 = **shadow** | LIMITED：shadow 账本只在 L2 呈现，不进生产阻断 | M15 架构审计结论 2；本轮不改（无新增证据支持升格） |
| 模型 Reviewer 的学术发现（finding 是否真、是否比单次全文多） | ReviewerService unit / digest → ReviewAggregator | IMPLEMENTED · **NOT_EVALUATED**（n = 2 只描述：M16 收口 C） | M16_CLOSURE_DECISION §3 |
| 评测尺子对「不读论文 / 错配 / 关键词填充」的区分力 | `scripts/m16-closure/b-benchmark.mjs` | TESTED（held-out 16 篇 PASS；已开封） | M16_BENCHMARK_VALIDITY_CLOSURE |
| 参考不完备时的「独立核验新发现」 | 无 | NOT_EVALUATED（M16 收口仅 1 条执行者人工核对，不计指标） | M16 收口 DEVIATIONS #5 |

### 1.3 Severity — critical/major/minor、已证实 vs 待核验 AI 意见 vs 作者裁决不混淆

| 子项 | 调用链 | 开工时状态 | 证据 |
|---|---|---|---|
| 分层质量报告 L0–L4、证据等级 | `quality/qualityReport.ts`（evidenceGrade；L2 不出现 FAIL，模型阻断 → NEEDS_VERIFICATION） | IMPLEMENTED · TESTED | `M15_QUALITY_REPORT_CONTRACT.md`；`m15-quality-report.spec.ts` |
| 目标期刊五态（已证实问题阻断 / 证据不足 / 作者裁决…） | `target/journal/assessment.ts`（L1 FAIL + 模型 STRONG 仍 BLOCKED；正向 rubric 加不确定性说明） | IMPLEMENTED · TESTED | M15 TJA G3；M16 首轮 POSITIVE_RUBRIC_CAVEAT |
| 模型严重度本身的校准 | — | NOT_EVALUATED（参考无严重度） | M16 收口 §6 |

### 1.4 Calibration / Journal Fit — 合规与学术质量分开，判定有来源、范围、误差边界

| 子项 | 状态 | 证据 |
|---|---|---|
| 官方规则 profile（CJIG 16 条、PLOS ONE 10 条，原句回放验真） | IMPLEMENTED · TESTED · VALIDATED_ON_REAL_INPUT | M15 TJA G1（CJIG 25/25 在线复核） |
| 学术分 80 | LIMITED：advisory、UNCALIBRATED_SCORE_REGRESSION 为作者裁决项 | M15 长程 / QualityReport 契约 §3 |
| 期刊级学术水平判别 | NOT_EVALUATED：中文期刊独立质量标签 = 0；L4 恒 UNVALIDATED | M15 TJA G4 PARTIAL；M16 首轮 SurveyReview 宽松复现 |

### 1.5 Revision Closure — Writer 不越权、改稿真解决、无新增科学事实问题

| 子项 | 状态 | 证据 |
|---|---|---|
| EditContract 统一写入守卫 + 提交边界 | IMPLEMENTED · TESTED | M15.20 P0 COMPLETE；`test/workflow/editContractWorkflow.test.ts`（E1-NUM / SENT / PLAN / ADVICE / APPROVE / STALE / LEGACY） |
| 合法修复 → VALIDATED_FIXED；越权改数 → 拒绝；需补实验 → 不派发 | IMPLEMENTED · TESTED | `editContractWorkflow.test.ts:371`（合法正例）、`:351/:361`（拒绝）、`targetAuditRevisionWorkflow.test.ts:168`（需实验项不派发） |
| 复评绑定新版本、防旧结论重放 | IMPLEMENTED · TESTED | 409 陈旧拒绝、复评回放 diff |
| 真实作者批准下的闭环 | LIMITED：只有 scripted actor 与 M15.19 的真实运行（该次暴露越权，已由 P0 修复） | M15.19 PARTIAL、M15.20 |

## 2. 产品的根本验收问题对照

「用户输入论文与目标期刊之后，能否知道：已证实的问题是什么 / 原文与依据在哪里 / 还有什么不能确定 / 需要怎样补实验、文献或修改 / 修改后哪些问题确实关闭？」

| 问题 | 开工时能否回答 | 依据 |
|---|---|---|
| 已证实的问题 | 能（L1 + 期刊官方规则违规），范围 = 数值 / 引用 / 作者数据 / 格式合规 | QualityReport L1、journal-assessment A 块 |
| 原文与依据 | 部分：L1 有位置与复算；模型 finding 有 quote 与 VERIFIED_IN_TEXT 字段，但「引文存在」≠「问题成立」 | ReviewIssue.quote / verification |
| 不能确定的 | 能：NOT_EVALUATED / NEEDS_VERIFICATION / UNVALIDATED 显式 | QualityReport unknowns |
| 怎样补 | 部分：evidenceRequirement、Author Decision、目标期刊「需补实验」类 | targetAudit 五类分类 |
| 哪些问题确实关闭 | 能（受 EditContract 约束的 VALIDATED_FIXED） | M15.20 |
| **模型提出的学术问题有多可信、比一次全文审稿多多少** | **不能**——这是本轮工作包 B / C 要回答的 | — |

## 3. 本轮结果（追加；开工时判定见上）

| 行 | 本轮变化 | 证据 |
|---|---|---|
| C1 多文件根 main.tex 正文 | **FIXED · TESTED**（提交 `d5f0052`）：根 main.tex 的实质正文 span 进入覆盖计划（导言区永不进入；纯 `\input` 组装行不产生单元；子文件不重复；digest 视图被截断时切长文档模式）；覆盖摘要新增源文件 / 单元哈希清单 | `backend/test/workflow/m16RootBodyCoverage.test.ts` 4 例（基线 4 例全 FAIL，日志见 A/）；`test/review` + `test/workflow` 129 文件 1,319 例通过 |
| 1.1 部分覆盖下的计数规则 | **FIXED · TESTED · VALIDATED_ON_REAL_INPUT**（`b38cb62`）：真实运行 3/13 单元被内容过滤拒绝、覆盖 60.5% 时，L2「critical=0 major=0」原为 PASS，现为必需 NOT_EVALUATED 并写明覆盖比例 | `backend/test/quality/m16PartialCoverageCounts.test.ts`（基线 FAIL 日志见 D/） |
| 1.2 模型 Reviewer 学术发现 | 由 NOT_EVALUATED → **VALIDATED_ON_REAL_INPUT · LIMITED**：12 篇新留出集，7 个人类参考没有、经确定性复算成立的 major 根因（6 篇）；1 条反证；DANGLING 6.8% | VALIDATION §5 |
| 1.2 生产 vs 单次全文 | **INCONCLUSIVE**（主指标 −7.6 [−16.4, +1.0]）；对齐人类关注点的次要指标生产显著更弱，整稿问题是主要差距 | VALIDATION §4 |
| 1.2 评测尺子 | 新留出集复验 **PASS**（含新增伪具体攻击） | VALIDATION §3 |
| 1.3 模型严重度 | **LIMITED**：57 条 major 中 2 条与人类对齐、1 条被反证、7 条经复算成立——严重度仍是未校准的 AI 风险意见 | VALIDATION §4–5 |
| 1.4 期刊级学术水平 | 不变：**NOT_EVALUATED / L4 UNVALIDATED** | — |
| 1.5 修订闭环 | 不变（未改代码）；当前 HEAD 重跑 44 文件 603 例通过 | `D:\PaperTeamData\M16\OriginalQualityGateGoalClosure\D\d2-revision-regression.log` |
