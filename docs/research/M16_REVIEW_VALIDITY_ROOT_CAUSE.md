# M16 — 学术审稿有效性根因审计（工作包 A）

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 起点 `75374c8`（HEAD = origin/main = ls-remote，clean）
- 只读输入：`D:\PaperTeamData\M15\TargetJournalAssessment\{D2,D3,external}`、`D:\PaperTeamData\M15\QualityGateCalibration\experiments\runs`（159 次历史生产运行）
- 复算产物：`D:\PaperTeamData\M16\AcademicReviewValidity\A\a-replay.json`
- 最小复算命令（零模型）：`node scripts/m16-review-validity/a-replay-d2-d3.mjs`

状态标注：**SOURCE_CONFIRMED**（读源码确认）、**REPLAY_CONFIRMED**（原始产物零模型复算确认）、**PLAUSIBLE**（有支持证据但未单独检验）、**NOT_DETERMINED**。

## 1. 结论摘要

| # | 观察 | 根因类别 | 状态 | 能否零模型修复 |
|---|---|---|---|---|
| R1 | D2「证据约束结构化评审 65% vs 单次 71%」并**不是**在比较 PaperTeam 生产 Reviewer 与单次 LLM：两臂都是 `scripts/m15-tja/d2-cocoreview-recall.mjs` 里的单次 Prompt（`SYSTEM_A` / `SYSTEM_B`），只差一段证据纪律说明 | EVAL_DATA_LIMITATION（实验设计口径） | SOURCE_CONFIRMED | 是（报告口径修正） |
| R2 | D2 / D3 输入在 40,000 字符处截断（`d2-cocoreview-recall.mjs:21,85`、`d3-surveyreview-alignment.mjs:21,67`）；D2 12/12 篇均被截断，平均截掉 28.4%（8.5%–45.7%），被截部分主要是实验后半与附录 | INPUT_FIDELITY（评测 harness，非生产） | REPLAY_CONFIRMED | 是（封存集 Afull 臂即为修复） |
| R3 | D2 指标是 23 类 taxonomy 的**类别级**召回（`d2-cocoreview-recall.mjs:126`）。一个**不读论文**、恒输出全集最常见 8 类的平凡基线召回 **83.2%** [74.8, 91.0]，top-10 为 **92.7%**，都高于两臂（71.1% / 65.1%） | FINDING_MATCHING（指标无区分力） | REPLAY_CONFIRMED | 是（改用原子意见匹配，见 M16_BENCHMARK_AND_PROTOCOL） |
| R4 | D2 的 −6pp 主要来自 B 臂输出的**去重类别更少**（平均 7.3 vs 8.3 类，10 条上限内重复类别更多），而不是检出更少问题；漏检集中在 ORIG-ANL / ORIG-MTH / CLAR-WRT，两臂相同 | FINDING_MATCHING | REPLAY_CONFIRMED | — |
| R5 | D2 原始数值可逐字复算：A 71.1% [63.6, 78.6]、B 65.1% [54.6, 76.2]、B−A −6.0pp [−13.4, +2.5]（与 M15 metrics.json 完全一致；同 seed bootstrap） | — | REPLAY_CONFIRMED | — |
| R6 | D3 量表映射无误：rubric −2 最差 … +2 最好（`eval-prompt.json`）；参考分 0 = 审稿报告未涉及该维度，M15 已排除（`d3-surveyreview-alignment.mjs:99`）；没有极性翻转、没有把未评估当正分 | RUBRIC_OR_LABEL_MAPPING（排除） | SOURCE_CONFIRMED | — |
| R7 | D3 抽样参考 21/25 = **84% 为负**（测试集整体 72%；SurveyReview 论文表 6：−1 占 66%）。常数 −1 的符号一致率 84%、MAE 0.48，**优于**两臂（24% / 28%，MAE 1.84 / 1.88）；两臂 balanced accuracy 54.8% / 57.1%，接近随机（negRecall 9.5% / 14.3%，posRecall 100%） | EVAL_DATA_LIMITATION + MODEL_JUDGMENT | REPLAY_CONFIRMED | 指标部分是（改报 balanced accuracy / 常数基线） |
| R8 | D3 参考分来自**审稿报告的情感标注**（SurveyReview §4.3：标注者把自由文本评审转成维度分），不是独立的绝对质量量表；审稿报告天然偏批评。原论文同样报告零样本前沿模型（GPT-5.2 / Claude Opus 4.5 / GLM-4.7 等）对齐差（例如 GPT-5.2 Structure MSE 2.98），需监督微调才降到 1.29 | EVAL_DATA_LIMITATION | SOURCE_CONFIRMED（论文 arXiv 2608.07641 §4.3、§6.2、表 6） | 否 |
| R9 | 模型在 D3 上**确实**几乎不给负分（25 维中 A 臂预测均值 +1.00，参考 −0.84）。在 84% 负向样本上这既可能是模型宽松，也可能是参考口径；是否在正负平衡的新样本上复现见封存复测（M16_REVIEW_VALIDITY_FINAL §4） | MODEL_JUDGMENT（SEVERITY_CALIBRATION 方向） | 方向 REPLAY_CONFIRMED；成因 NOT_DETERMINED（待封存复测） | 否 |
| R10 | D3 输入截断对 Comprehensiveness（参考文献完整性）影响有限：8 篇中 7 篇参考文献标题落在 40k 窗口内（仅 openreview-377 在 94,064 字符处被截掉） | INPUT_FIDELITY（小） | REPLAY_CONFIRMED | 是 |
| R11 | 文献样本版本：SurveyReview 正文由论文 PDF（Marker）解析，CoCoReviewBench 6/8 篇封存 MD 为 arXiv 版；都可能不是审稿时的投稿版本，人类批评可能已在正文中修复 | EVAL_DATA_LIMITATION | PLAUSIBLE | 否 |

**一句话**：M15 D2 / D3 的两个「报警」主要是**测量口径**问题（实验没测生产链路、输入截断、类别级指标无区分力、极不平衡的参考分），不是 PaperTeam 生产 Reviewer 丢失信息的证据。模型在维度打分上偏正向这一方向是真实的，但成因与是否在平衡样本复现需要实测。

## 2. 「复杂 Harness 是否损害召回」——生产链路逐项核对

生产存在两条审稿链路（必须分开谈）：

- **LaTeX 链路** `review.run`（ReviewUnit，喂 quality-report/v1 与目标期刊评估）。
- **PDF 链路** `existing_paper_review`（`review.sections` → `review.fullpaper` → `review.aggregate`；`globalReviewMode` / `sectionReviewMode` / `paperMapSummaryMode` 只属于这里）。

| 假设的信息丢失路径 | 源码事实 | 历史回放 | 结论 |
|---|---|---|---|
| 输入截断 | LaTeX 单元按标题切分，> 9,000 字在段落边界再切，**不截断**（`review/logicalSpan.ts:34,131`；Prompt「完整无截断」`agents/ReviewerService.ts:1471`）；PDF 链路按 1,800 字分块但整节全送（`paper/ReviewContextBuilder.ts:148`）；附录不排除，`thebibliography` 从末节剥离 | 159 次 M15 校准运行：3,229 单元全部完成，`reviewedChars / targetChars` 恒为 1 | 无截断 — SOURCE + REPLAY_CONFIRMED |
| 单条非法枚举拖垮整个单元 | `readRequiredEnum` 抛错（`agents/outputParsing.ts:237`）→ `parseIssues` 整个单元失败（`ReviewerService.ts:504`），无修复回合，阶段级重试 3 次（`workflow/definitions.ts:926`），仍失败则该单元 findings 全丢、覆盖率下降并被门禁看到 | 159 次运行 **0** 个失败单元 | 路径真实存在，但历史上**未发生** — SOURCE_CONFIRMED / 影响 REPLAY_CONFIRMED 为 0 |
| 引文未定位即删 finding | 生产不删：引文 < 12 字只丢引文、保留 finding（`ReviewerService.ts:996`）；未定位只是不设 `targetQuote`；定位核验只在 shadow 模块（`review/findingAudit.ts` 等，头注释明确不改 issues / 计数 / 门禁） | — | 不存在 — SOURCE_CONFIRMED |
| 严重度被自动下调 | 生产无代码下调；只有 shadow `review/findingAdjudication.ts` | — | 不存在 — SOURCE_CONFIRMED |
| 数量截断 / 去重过度 | 每单元 ≤ 100 条（`ReviewerService.ts:959`）；去重为 `category|section|description` 精确匹配（`review/ReviewAggregator.ts:150`） | 无单元触顶记录 | 不构成召回损失 — SOURCE_CONFIRMED |
| L2 意见被当成 L1 / L4 被隐藏 | L2 门禁规则 FAIL 投影为 `NEEDS_VERIFICATION` 并注明模型意见（`quality/qualityReport.ts:171,187,366`）；L4 恒 `UNVALIDATED`（`:221,325-339`）；目标期刊评估 `externalValidity.status = EXTERNAL_CALIBRATION_NOT_VALIDATED`、模型 rubric 永不影响结论（`target/journal/assessment.ts:176-196,289-300`），UI 标注「模型意见（未校准）」 | — | 无误表述 — SOURCE_CONFIRMED |
| PDF 链路整节解析失败静默为 0 条 | `paper/SectionReviewScheduler.ts:283-294`：整节输出不可解析 → 0 条、不重试、仍计已审，仅 `parseFailures` 记录 | 未在本轮复测（PDF 链路不在 M16 封存臂） | 真实存在的静默丢失路径 — SOURCE_CONFIRMED；频率 NOT_DETERMINED |

既有证据（DEV_OPENED，非本轮测量）：M15.12 / M15.13 两轮 held-out 中，PDF 链路缺省（逐节）相对强单次 Prompt 并不占优（M15.13：C1opt 23.4% vs 单次 C0 31.1%），全文 pass（`globalReviewMode=on`，缺省 off）相对缺省 +4.6pp / +9.8pp，但相对强单次 Prompt 只有 +5.5pp [−0.5, +11.9] / +2.1pp [−2.8, +6.6]。

## 3. 优先级

1. **零模型可修**：报告口径（R1、R3、R7 → 改用原子意见匹配 + balanced accuracy + 常数 / 平凡基线）；评测输入保真（R2、R10 → 全文）。在 M16 评测框架中完成，不涉及生产代码。
2. **需模型实验**：输入保真与证据纪律对原子级覆盖的影响（H1 / H2）；LaTeX 生产链路与单次 LLM 在相同论文上的覆盖差异与丢失路径；D3 宽松在平衡样本是否复现。见 `M16_BENCHMARK_AND_PROTOCOL.md` 与 `M16_REVIEW_VALIDITY_FINAL.md`。
3. **参考标签造成的伪差距**：R7、R8、R11 无法在不新增人工标注的前提下消除，只能在报告中如实限定。
