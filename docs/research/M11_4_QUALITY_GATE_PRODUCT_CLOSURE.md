# M11.4 Quality Gate Product Closure

> **日期：2026-10-06/07。执行代理：Claude Code。仓库：`D:\Projects\PaperTeam`（main，起点 HEAD == origin/main == 3fc4bcf，clean）。**
>
> **一句话结论：Option C 落地为分层 gate——Revision Task Success（返修任务语义）与 Publication Ready（投稿就绪语义）正式分离；`academicScore >= 80` 不再作为 Existing Paper Revision 的任务层硬门（降为投稿层判定），任务层改由「意见闭环 + 确定性守卫 + 修订引入违规为零 + 非回归 + calibrated-floor（provisional 未启用）」构成。Benchmark（4 paper families / 21 样本 / 64 次 Coding Plan 调用）实测：现行管线 reviewer sd 0.6–3.1、已发表论文带 77–86、F1 真实返修族 70–78（人工终稿 9 样本 0 个 ≥80）、known-bad 不可靠分离 → floor 保持 provisional 不启用。最终状态：QUALITY_GATE_SEMANTICS_COMPLETE + BENCHMARK_CALIBRATION_PARTIAL。**

## 1. Executive Decision

| 决策项 | 结论 |
|---|---|
| Gate 模式 | **Option C**（calibrated floor + relative non-regression + blocking findings hard gate），分层实现 |
| 80 的处置 | Existing Paper：不再是任务层硬门；投稿层（`gate.passed`）仍消费 `academicPassScore`（默认 80，env 可覆盖）且现在**蕴含**任务成功。idea_to_paper / topic_survey：**完全不变**（同一 `evaluateQualityGate`、同一阈值） |
| 任务层绝对 floor | **provisional，默认不启用**（`academicFloor=null`）；推荐值 65 文档化，作者可用 env 显式开启 |
| 非回归容差 | **10 分**（benchmark 推导，见 §15） |
| Candidate Freeze | 层级登记：`revision_candidate`（任务成功后冻结修订候选）vs `publication_candidate`（缺省，全 gate 通过）；held-out 解锁行为不变 |
| Revised PDF | 任务成功 + 投稿未就绪 → 自动产出 **Draft PDF + REVISION_TASK_COMPLETE 终态**（不再进 overflow 追问）；metadata/UI 明示「投稿就绪性另见报告」 |
| Reviewer prompt | **未修改**（§50：数据证明相对排序与 finding 质量有价值，只调 Gate 解释） |
| Rubric anchors | 未写入 prompt（绝对分语义漂移如实接受；投稿层阈值承担绝对判定） |

## 2. Why 80 failed（对校准审计的 benchmark 复核）

- 80 溯源 PRD §9.5 → `gates.ts` `DEFAULT_QUALITY_THRESHOLDS`（M3 常量），无任何校准（audit 已定案 `UNVALIDATED_PRODUCT_THRESHOLD`）；
- 本轮独立复核：**已发表顶会/期刊论文（ByteTrack/OC-SORT/StrongSORT）在现行管线下 77–86**，而 F1 真实返修族（含人工终稿）70–78、人工终稿 9 新样本 0 个 ≥80（加上旧口径 12 样本共 1 个）——80 在这个 reviewer 尺度上 ≈ 顶会接收线，对中文期刊返修稿是**系统性拒绝作者自己的终稿**；
- 同稿方差修复后 sd 0.6–3.1（截断口径曾 5.0–12.3）：单样本绝对分在旧口径下被噪声支配的问题已随 digest 修复大幅缓解，但绝对分的「语义漂移」（无锚点 rubric）仍在——因此绝对阈值只留在投稿层，任务层用非回归。

## 3. Benchmark Inventory

见 [M11_4_QUALITY_GATE_BENCHMARK.md](M11_4_QUALITY_GATE_BENCHMARK.md)。4 unique families（1 真实返修 + 3 已发表）、21 样本、64 次 GLM-5.3 Coding Plan 调用（含 1 ping）。机器可读：`D:\PaperTeamData\M11_4_QualityGateBenchmark\{benchmark-manifest.json, benchmark-report.json}`。

## 4. Inclusion Criteria（§18）

每 case 记录：case ID / SHA256 / family / documentType / language / qualityClass（pre-revision | acceptable-human-revised | paperteam-candidate | known-bad-synthetic | known-good-published）/ origin（human | paperteam | synthetic-mutation）/ hasComments / hasHumanFinal / evidencePaired / sharing（local-private | public-arxiv）/ suitableFor（absolute | relative-delta）。

## 5. Unique paper family count

**4**（诚实口径：真实 human revision pair = 1；known-good published = 3 族；synthetic known-bad = 1 case 属 P5 敏感性检查）。重复采样（3/anchor）只估计 measurement variance。

## 6. Reviewer variance

| 组 | sd | 说明 |
|---|---|---|
| f1-pre / f1-human-final / f1-candidate | 2.3 / 0.6 / 3.0 | 现行生产 digest |
| f2 / f3 / f4（published） | 1.7 / 3.1 / 1.7 | |
| f1-bad-notables | **8.6** | 评审对缺陷稿自身不确定（异方差） |
| （历史参照）旧截断 digest | 5.0–12.3 | 方差主源 = 截断随机性，已随修复消除 |

## 7. Current score distributions（现行管线）

| 组 | n | scores | mean±sd |
|---|---|---|---|
| pre-revision（F1） | 3 | 74/78/78 | 76.7±2.3 |
| human-revised（F1） | 3 | 73/74/74 | 73.7±0.6 |
| PaperTeam candidate（F1） | 3 | 70/73/76 | 73.0±3.0 |
| known-bad synthetic | 3 | 63/74/80 | 72.3±8.6 |
| known-good published | 9 | 77–86 | 78.0/80.3/84.0 ±1.7–3.1 |

## 8. Relative deltas

- Human delta = **−3.0**（human-final − pre）；Candidate delta = **−3.7**。两者同量级同号——绝对分无法度量返修改善（audit 结论的独立复核），非回归语义正确。
- 修复前 VIS 口径 human delta 曾为 +4——单 family 的 delta 本身在 ±4 内波动，进一步支持容差 ≥10。

## 9. Known-good / known-bad separation

**不可靠**。bad（strip-tables）= 63/74/80 与可接受锚点（≥70）重叠：academicScore 对「定量表格被整体剥离」不敏感（3 样本中 1 个仍 80、实验充分性 78）。**该缺陷类的确定性防线是 Fact Preservation（删表 = fact violation → SYSTEM_FAILED），不是分数**——floor 不应伪装能拦截它（§30 的目标重新表述：floor 只防「明显很差的 candidate 靠相对改善混过」，而明显很差的确定性特征已被守卫覆盖）。

## 10. Option A/B/C decision

**C（默认研究方向的确认）**。数据不支持 A（80 无校准；published 带也横跨 80 两侧）；B（纯 advisory）失去整体质量信号且浪费已修复的方差坍缩。C 的三层（floor + 非回归 + blocking 硬门）中：
- blocking findings 硬门 = 任务层 `no_revision_blocking_findings`（归层后 revision_introduced / modified_existing 口径）；
- 非回归 = baseline（同 run r1）− 10 分带；
- floor = provisional 未启用（§14）。

## 11. Revision Task Success contract（已实现）

```
revisionTaskSuccess ⟺ 以下全部成立（deterministic，无 LLM；backend/src/quality/revisionTaskGate.ts）：
  reviewer_requirements_closed   全部外审意见 ∈ {handled, already_satisfied}
                                 （conflict / author-decision → AUTHOR_DECISION_REQUIRED，
                                  pending/unresolved/partially_handled → FAIL）
  deterministic_guards           gate 守卫子集全过（hallucinated citation / citation
                                 structure / contradictory evidence / citation+fact+
                                 cumulative preservation / evidence-backed / revision
                                 items / claim strength）
  patch_substance                patches 全过 + 无未归因违规 + 事实/引用保持 + 无 build error
                                 （无 patch 产物 → 不适用）
  revision_introduced_claims_zero claimGapAudit 修订引入口径 = 0（灰区 [0.4,0.6) → 作者裁决）
  no_revision_blocking_findings  归层为 revision_introduced / modified_existing 的
                                 blocking / critical finding = 0
  academic_non_regression        academicScore ≥ 同 run r1（冻结基线）− 10
                                 （无基线分 → 不适用，如实记录）
  academic_floor                 ≥ floor（未启用时呈现不阻断）
verdict = FAIL（任一硬检查失败）| AUTHOR_DECISION_REQUIRED（仅剩作者裁决项）| PASS
```

## 12. Publication Ready contract（已实现）

```
gate.passed（existing-paper 语境的投稿层语义）
  = 全稿 gate 规则（academicScore ≥ academicPassScore[80]、styleRisk ≤ 35、
    open critical/major、feasibility、…）
  ∧ patch 级联（substance ∧ verdict ≠ FAIL）
publicationReadiness.verdict = READY（gate.passed ∧ 任务 PASS）
                             | NOT_READY（任务 FAIL 或全稿规则未过）
                             | AUTHOR_DECISION_REQUIRED（仅剩作者裁决项；不阻断
                               已全过的规则层——M5.7 conflict 语义保留）
baselineInheritedRisks[]：归层 baseline_inherited / unknown-origin 的 heavy finding
                          + 灰区 claim + 待裁决意见（reviewerRequired 标记）
```

**Publication 可以 FAIL 而 Task PASS——这不是矛盾**（§12）：任务语义是「正确完成本轮返修」，投稿语义是「整篇可作最终投稿候选」；原稿自带的作者级缺陷（论文表格 vs 公平消融数据矛盾）不因返修任务被单方解决。

## 13. Baseline inherited risk semantics（§14 落地）

- 归层（`classifyFindingOrigins`，确定性）：rootCauseKey→claimGapAudit 适用性优先；其次 claimGapAudit issue 归因排除；其次**章节是否在本轮修订修改区间**（logicalTarget + heading + 文件路径三命名空间）；无章节 → unknown_origin；
- 无关风险（意见未要求、修订未触碰、未强化）→ 不阻塞任务层，进 `publicationReadiness.baselineInheritedRisks`；
- **Reviewer 要求过的风险**：由意见闭环承担（被要求而未解决 → 意见不会是 handled → 任务 FAIL）——不存在独立启发式；
- 作者裁决通道：`AUTHOR_DECISION_REQUIRED` verdict（灰区 claim / unknown-origin blocking / conflict 意见），不自动改论文也不自动忽略。

## 14. Academic floor derivation

**不可校准（provisional / 未启用）**。依据：可接受真实锚点 min=70（9/9 ≥70）；known-bad 无分离缺口（max 80）；真实返修族 N=1 无法估计 false-reject 族间方差（§19/§31：不允许单 fixture 拟合）。**推荐值 65**（= min-5 裕量，只拦灾难性塌陷，对 benchmark 0 false-reject），作者显式开启：

```
PAPERTEAM_REVISION_TASK_ACADEMIC_FLOOR=65
PAPERTEAM_REVISION_TASK_FLOOR_STATUS=provisional
```

## 15. Non-regression rule derivation

容差 **10**：现行管线 F1 族 sd ≤ 3.0 → 10 ≈ 3.3σ 单样本噪声带；覆盖旧口径 sd≤12 的下沿；与 `ACADEMIC_REGRESSION_DROP=10` 既有先例同量级。实证：human −3.0 / candidate −3.7 均在带内（真实返修波动不误判）；跌破 10 分才判实质回退。基线 = 同 run 最早 review 汇总（r1 审阅冻结基线 rev-1）——同 reviewer、同管线、同项目，是唯一无跨语境污染的对照。

## 16. Blocking finding semantics（§32–34 审计）

- `blocking` 是独立 boolean 字段（非 critical 派生）；critical ≠ 总 blocking；
- 同一问题多重计入的现状：规则 4（claim）/5（blocking）/6（critical+major）之间已有 rootCauseKey + claimGapAudit 双重去重；`patch_validation_publishable` 的 AND 级联已重构为分层语义（任务档：`substance ∧ verdict≠FAIL`——不再机械重复 `gate.passed` 的失败）；academicScore 作为第三次惩罚的问题由分层解决（任务层不消费绝对分阈值，只消费非回归）；
- **硬门由明确可解释 finding 驱动**：任务层 6 项 check 全部携带 id + detail 进 `reasons[]`。

## 17. Candidate Freeze / PDF semantics

- **Freeze（§43）**：`heldOutAccess.freezeCandidate` 接受 `layer` 登记（`revision_candidate` | `publication_candidate`，缺省后者兼容既有调用）——解锁 held-out 的行为不变，层级是验收协议语义。**建议验收协议**：Attempt 8 以 `revisionTaskSuccess` 为 Revision Candidate Freeze 判据；blind evaluation（held-out 读取）在 revision_candidate 层级即可解锁；
- **PDF（§44/§45）**：任务成功 + 投稿未就绪 → `planSharedTail` 直接 `draftPath()`（不再进 stalled/overflow 追问——「轮数用完」的框架对已完成的任务是误导）→ Draft PDF + `REVISION_TASK_COMPLETE` 终态 + completion summary 携带 `revisionTaskVerdict` / `publicationReadiness`。Final（`art-final`）仍要求投稿层全过（FinalizeService 重校验 `gate.passed`）——**Draft 与 Publication-Ready Candidate 的区分不变且更明确**。

## 18. API / UI impact（§42 最小改动）

- **API**：`GET /api/projects/:id/quality-gate` 原样透传 gate 产物（新增 `revisionTask` / `publicationReadiness` 字段自动可见）；run completion summary 新增 `revisionTaskVerdict` / `revisionTaskSuccess` / `publicationReadiness`。`POST /quality-gate`（手动重评）维持旧的缩减口径（本就缺 claimGapAudit 等）——已知限制，见 §21；
- **UI**：`TERMINAL_STATUS_STYLES/HINTS` 注册 `REVISION_TASK_COMPLETE`（成功色调）；WorkflowPanel 完成横幅按成功渲染该终态；types/api.ts + runs.ts 解析新增可选字段（旧 run 无字段 → legacy 语义，不 crash）。

## 19. Code changes

| 文件 | 变更 |
|---|---|
| `backend/src/quality/revisionTaskGate.ts` | **新增**：分层判定纯函数（~430 行含注释）：`evaluateRevisionTaskGate` / `classifyFindingOrigins` / `RevisionTaskPolicy` / verdict 语义 |
| `backend/src/review/claimGapAudit.ts` | 灰区带 [0.4, 0.6) → `grey_zone_author_decision`（counts.greyZone；issue 归因同排除口径但进作者裁决呈现） |
| `backend/src/review/revisionOutcome.ts` | `TerminalStatusKind` + `REVISION_TASK_COMPLETE`；`classifyTerminalStatus` 消费 `revisionTaskSuccess`（守卫失败仍优先 SYSTEM_FAILED） |
| `backend/src/quality/gates.ts` | `QualityGateResult` 增可选 `revisionTask` / `publicationReadiness`（旧产物缺省 = legacy） |
| `backend/src/workflow/definitions.ts` | gate stage：taskScoped（existing_paper ∧ mode）计算任务层 + 分层 patch 级联 + 投稿层合成 + gate 产物嵌入；planSharedTail：任务成功分支 → draftPath；completion summary 携带分层字段；修改区间三命名空间（logicalTarget/heading/file） |
| `backend/src/config/config.ts` | `ReviewConfig.revisionTask`（typed 集中配置：mode / academicFloor / academicFloorStatus / regressionTolerance + 4 个 env 覆盖） |
| `backend/src/serviceStack.ts` / `backend/src/index.ts` | 策略装配（缺省 task_scoped / floor null / 容差 10） |
| `backend/src/evaluation/heldOutAccess.ts` | `freezeCandidate` 增 `layer` 登记（行为不变） |
| `frontend/src/types/api.ts` / `api/runs.ts` / `components/common/status.ts` / `components/project/WorkflowPanel.tsx` | 新字段解析 + 终态注册 + 成功渲染（最小面） |
| `scripts/m114-quality-gate-benchmark.mjs` | **新增**：benchmark harness（manifest / 多 family / 3 采样 / digest 覆盖率观测 / resume-by-key / --dry / --ping） |

**未改动**（不变量 §10）：Fact / Citation / Evidence / Scope Guard 全部规则与阈值、held-out isolation、canonical alias mapping、patch lineage、`DEFAULT_QUALITY_THRESHOLDS`（80 仍为投稿层与其它 workflow 阈值）、`MAX_REVISION_ROUNDS`、Reviewer prompt / rubric、idea_to_paper 与 topic_survey 的任何 gate 行为。

## 20. Tests

- **新增** `backend/test/quality/revisionTaskGate.test.ts`：27 用例——任务 PASS / 意见阻塞 FAIL / 修订引入 fact violation FAIL / 无关继承风险不阻塞（进风险清单）/ 意见要求的继承风险阻塞 / 非回归容差 3 边界（带内过、超带 FAIL、无基线不适用）/ floor（启用 FAIL + 状态标注、未启用呈现不阻断）/ 灰区 claim 与 unknown-origin → AUTHOR_DECISION / 修改区间 finding → FAIL / patch 实质（失败 FAIL、无产物不适用）/ 可解释性（reasons 携带 check id+detail）/ legacy 模式 / 归层四路单测 / claimGapAudit 灰区带 3 例 / 旧 run 兼容（无字段的五态语义 + JSON 缺省）；
- **新增集成** `existingPaper.test.ts`（M11.4 分层 gate 用例）：existing_paper + fail→fail2 序列 → r2 任务层成功（73<80）→ completed(draft) + `REVISION_TASK_COMPLETE` + gate 产物分层字段 + publicationReadiness=NOT_READY；
- **适配** `externalInstructionsFlow.test.ts` 1 用例改 legacy 模式驱动（其验证对象是 revision.plan 的 handled 留档行为；fixture 基线含 12.4% 使任务层在新语义下 r2 即完成——新行为由上述集成用例覆盖）；
- **回归**：`m114AuditRegressions` 5/5、`m1031Units` 33、`Gates` 15、`GateApi` 3、`existingPaper*` 全部通过。

## 21. Limitations

1. floor 不可校准（§14）；非回归容差基于单 family 方差估计；
2. `POST /quality-gate` 手动重评为既有缩减口径（无 claimGapAudit / 任务层），会以缩减结果覆盖 gate 产物——工作流下一轮 gate 会重算全量；后续可把任务层提取为共享函数接入（本轮按最小改动原则未做）；
3. benchmark 的 known-good 为英文论文且 digest 可见率 44–56%（2600 字符/块 + 60k 总预算对长文的生产行为）——其绝对分参照需计入；
4. pairwise 未新增（banked 1 次，N=1 指示性；按 §47 不进生产 gate）；
5. REVIEW_INPUT_TRUNCATION 的根治是「可见率 92–93%」而非 100%——per-block 预算与总量预算仍是真实边界（如实记录于每样本 coverage）。

## 22. Next acceptance plan（不自动执行）

**READY_FOR_M11_4_REVALIDATION**（见第一屏）。Attempt 8 预期形态（不承诺分数）：
- digest 全量可见（评分基础与 Attempt 7 不同）；claimGapAudit 归层修正 + 灰区作者裁决；
- **Attempt 7 r3 真实数据回放（已执行，`scripts/m114-replay-attempt7-r3.mjs`，只读无模型调用）**：任务层 7 项检查全过（守卫 9/9、patch 实质、修订引入 claim 0[新口径：5 pre-existing + 1 灰区]、非回归 59 vs 62 带内、floor 未启用），verdict = **AUTHOR_DECISION_REQUIRED**（R1 文献 / R2 部署两条意见 + c-7b1a 灰区 claim）——非 MODEL_CAPABILITY_LIMIT、也非机械 PASS；截断伪影 critical 正确归层 baseline_inherited。若作者先裁决两条意见再跑，任务层可 PASS → REVISION_TASK_COMPLETE + Draft；
- 验收判据建议：以 `revisionTaskVerdict` 为 Revision Candidate Freeze 判据（layer=revision_candidate），held-out 读取合法解锁后做 blind 对照。

## 附：Model usage / 成本

- benchmark：**64 次 GLM-5.3 调用，全部 Coding Plan**（21 样本 × 3 mode + 1 ping），wall ≈ 11 分钟，resume-by-key 断点可续；
- 零 General API；无 Writer / Planner / workflow 调用；正式 Acceptance 未进入；源项目 `p-d12dc28ad850` 只读未触碰；human final 仅评估语境读取。
