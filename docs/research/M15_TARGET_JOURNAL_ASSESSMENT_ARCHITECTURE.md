# M15 Target Journal Assessment — 架构与决策记录

- 代码：`backend/src/target/journal/`（profileTypes / profileRegistry / profileVerification / journalFacts / criteria / assessment / JournalAssessmentService）
- HTTP：`backend/src/httpServer.ts` target 资源下 5 个端点；UI：`frontend/src/components/project/JournalAssessmentPanel.tsx`（项目页「目标投稿」标签顶部）
- 工件 schema：`target-journal-profile/v1`、`journal-profile-verification/v1`、`journal-assessment/v1`

## 1. ADR-TJA-1：基于官方规则 + 已有分层证据的 MVP，而不是录用预测器

| 候选 | 真实数据可用性 | 运行成本 | 关键失败模式 | 结论 |
|---|---|---|---|---|
| A 部署 PaperScorer 类录用预测 | 中文期刊无录用 / 拒稿记录；公开模型仅 ML 会议 | 7B + GPU、MinerU ≥40 GB | 伪精度「录用概率 83%」；领域外推 | 否决（保留 `HISTORICAL_DECISION_PREDICTION` 能力位，恒 DISABLED） |
| B 已发表论文相似度 / 观测带当门槛 | 有（M12 benchmark） | 低 | 幸存者偏差；把「像已发表」当「达标」 | 只作 C 块正向参照，永不进入结论 |
| C 通用 Reviewer 分数改名为期刊分 | 有 | 中 | 未校准分数承担门禁（M15.20 已证明 SD 5–12） | 否决 |
| **D 官方规则 profile（带来源、稿型、复核）+ 只读复用 QualityReport L0–L3 + 既有 rubric 意见 + 五态结论** | 官方页面可公开读取；L0–L3 已在生产 | 结论路径零模型；可选意见 1–2 次调用 | 规则提取错误 / 页面变化（→ 原句回放）；PDF 低保真（→ NOT_EVALUATED） | **采用** |

## 2. 数据流

```
用户：项目（manuscript/ LaTeX 或 PDF 解析）+ 期刊（journalId / 名称 / ISSN）+ 稿型
   │
   ├─ resolveJournalProfile（注册表；同名多匹配 → 409，不擅自挑选）
   ├─ profileTrust（内置快照 TTL 90 天 / 最近在线复核 / 用户提供 = 未验证）
   ├─ observeJournalFacts（GuidelineFacts + 摘要引用 / 脚注 / 章节 / 语言 / 声明信号；零模型）
   ├─ evaluateProfileRules → A 块 criteria（稿型适用 → NOT_APPLICABLE；原句已消失 → NOT_EVALUATED）
   ├─ 最新 quality-gate-r{n}.json → qualityReportOf()（只读）→ B 块 riskFindings（证据等级映射，见 §4）
   ├─ 可选 TargetRubricService.evaluate（includeModelReview；profile → guideline 适配；frozenAt = rulesVersion）
   ├─ TargetBenchmarkService / TargetGapService（venue 与该刊一致时）→ C 块 POSITIVE_ONLY_REFERENCE
   └─ buildJournalAssessment（纯函数）→ D 块五态结论 → research/journal-assessment.json + journal-assessments/<id>.json
                                              │
            用户逐条勾选「不符 + rewrite」条目 ─┴→ POST revision-instructions → reviews/external-instructions.json（source=target_journal）
                                                   → 既有修订计划（priority high，低于真人意见）→ Writer → validateCandidateEdit / guardedRevisionCommit（EditContract 不变）
```

## 3. 信任边界
1. **规则来源**：只收官方页面明文原句（`officialQuote` + `sourceUrl` + 页面 SHA）。无来源 / 用户提供 → `UNVERIFIED` → 结论 `JOURNAL_PROFILE_UNVERIFIED`。来源复核 = 抓取官方页面后逐句回放原句；页面字节变化本身不使规则失效（导航 / 脚本常变），**原句消失**才失效（该条 NOT_EVALUATED，profile `SOURCE_CHANGED`，不可信）。抓取失败 → `UNREACHABLE`，不把旧快照升级为在线验证。超过 TTL 的快照 → `STALE`。
2. **规则分类**：`hard_deterministic`（稿件内可程序检查）/ `evidence_based`（需编译版式、图像、投稿系统字段或作者信息；最多给 author-check）/ `advisory`（主观；只有模型意见，A 块恒 NOT_EVALUATED）/ `unknown`。`blocking` 只来自官方措辞强度（「须 / 不得 / must / do not」），「一般 / 建议 / 左右」为建议级，系统不升级。
3. **写边界**：评估、验真工件在 `research/`（Agent 缺省只可写 `manuscript/`）。转入修订只生成待处理意见，不直接改稿；意见文本声明「不构成任何数值修改授权」，真正的写入授权仍只来自 EditContract + 作者逐项批准。
4. **陈旧**：转入修订要求 assessmentId 是最新评估且稿件内容哈希未变，否则 409 `JOURNAL_ASSESSMENT_STALE`。rubric 意见只在 venue、规则版本、稿件修订号都一致时使用。
5. **HTTP 信任**：与既有产品相同——批准主体是「Agent 之外的本机 HTTP 调用方」，无多用户认证（M15 长程 G3 已知限制，未扩展）。

## 4. 与 QualityReport 的唯一关系（契约）
- JournalAssessment **只读** QualityReport，**不产生任何 `passed` 布尔**，不写 gate，不改 Finalize；`gate.passed ≡ overall.finalizable` 与 L4 恒 `UNVALIDATED` 原样保留（HTTP 测试断言评估响应不含 `"passed"`）。
- 证据等级映射：L0 / L1 / L3 的 FAIL（deterministic / author_data_recomputed / metadata_lookup / verified_evidence / edit_contract / unclassified）→ `verified`；`NEEDS_AUTHOR_DECISION` → `author-check`；L2 `NEEDS_VERIFICATION` / llm_judgment / uncalibrated_score → `model-opinion`；`NOT_EVALUATED` → `unassessed`。
- 结论优先级（`decideVerdict`）：
  1. 新鲜 QualityReport 中 L0 / L1 / L3 有已证实 FAIL → `BLOCKED_BY_VERIFIED_ISSUE`（与期刊无关，模型意见不可抵消）；
  2. 无 profile 或 profile 不可信 → `JOURNAL_PROFILE_UNVERIFIED`；
  3. 已证实的阻断性官方要求不符（含稿型不受理、语言不符）→ `BLOCKED_BY_VERIFIED_ISSUE`；
  4. 无稿件 / 无质量门禁 / 门禁对应旧修订 / 门禁必需未评估 / 阻断性 hard 规则未能评估 / 稿型受理未写明 → `INSUFFICIENT_EVIDENCE`；
  5. 任何不符（含建议级）或门禁 `NEEDS_VERIFICATION` → `CHANGES_REQUIRED`；
  6. 否则 `READY_FOR_AUTHOR_SUBMISSION_REVIEW`（可检查必需项全满足；evidence_based 项列入作者确认清单；**不是录用判断**）。
- 模型意见（rubric、L2）**永不进入结论计算**：既不能抵消已证实缺陷，也不能把结论降为 CHANGES_REQUIRED 之外的状态或升为 READY。
- 外部效度：`externalValidity.status = EXTERNAL_CALIBRATION_NOT_VALIDATED`、`independentHumanLabels = 0`（与 QualityReport 同源口径）；能力位 `SUBMISSION_REQUIREMENTS_CHECKED` / `EVIDENCE_GROUNDED_QUALITY_RISKS` / `SUBJECTIVE_QUALITY_ESTIMATE`（仅 MODEL_OPINION_UNCALIBRATED）/ `HISTORICAL_DECISION_PREDICTION`（恒 DISABLED_NO_VALIDATED_DATA）。
- 「达标比率」只在已判定的 hard_deterministic + 稿型条目上计算，分母显式给出；未知、作者确认、主观项单列，不进分母。

## 5. API

| 方法 | 路径（`/api/projects/:id/target/…`） | 说明 |
|---|---|---|
| GET | `journal-profiles` | 内置 profile 摘要 + 本项目来源可信状态 |
| POST | `journal-profiles/:journalId/refresh` | 在线原句回放（只 GET 公开页面，页面间隔 31 s；未配置网络 → 503） |
| GET | `journal-assessment` | 最新评估（无 → `null`） |
| POST | `journal-assessment` | body：`journalId \| name \| issn`、`articleType`（research / survey / systematic_review / dataset / code / protocol）、`includeModelReview?` |
| POST | `journal-assessment/revision-instructions` | body：`assessmentId`、`criterionIds[]`（逐条，空数组 400；不可改写条目进 `skipped`） |

错误码：`JOURNAL_AMBIGUOUS` 409、`JOURNAL_ASSESSMENT_STALE` 409、`JOURNAL_ASSESSMENT_CORRUPTED` 500、`JOURNAL_PROFILE_FETCH_UNAVAILABLE` 503、`JOURNAL_REVISION_UNAVAILABLE` 503。

## 6. UI 决策
- 一个面板、四块（A 投稿要求 / B 质量与风险 / C 期刊匹配 / D 不确定性与未评估项）；每条可展开：稿件观测与位置、官方原句与链接、来源状态（在线复核 / 快照 / 原句消失）、判定依据、缺口、建议。
- 证据等级与状态分两个标签显示（「不符」×「已证实」vs「未评估」×「需作者确认」）；模型意见单独一行，写明「未校准、不影响结论」。
- 只有「不符 + 可改写」条目出现勾选框；无「全部转入」。
- 不显示分数、档位或录用概率；收录信息区分「编辑部自述」与「未验证」。

## 7. 扩展点（Next Steps，不在本轮实现）
- 更多期刊 profile：按同一 schema 人工逐句摘录 + 回放脚本（`scripts/m15-tja/replay-profile-quotes.mjs`）入注册表；用户自带 profile 的导入 UI（schema 已支持 `user_provided`，API 未开放写入）。
- 编译后版式 / 图像检查器（dpi、三线表、图题双语）可把相应 evidence_based 规则升级为可判定。
- 若未来取得某刊合规的投稿 / 拒稿记录与独立人类标签，再按 PaperScorer 式基率校准接入预测器——在此之前能力位保持 DISABLED。
