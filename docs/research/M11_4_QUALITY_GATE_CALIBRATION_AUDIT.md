# M11.4 Quality Gate Root-Cause & Calibration Audit

> **日期：2026-10-06/07。执行代理：Claude Code。仓库：`D:\Projects\PaperTeam`（main，HEAD == origin/main，clean）。**
>
> **结论（一句话）：Attempt 7 的 `academicScore=59 < 80` 不是 GLM-5.3 能力上限——是"评审输入被确定性截断 + 无数字 claim 归层器结构性误判 + 未校准的 80 绝对阈值与无锚点 rubric"三者叠加；盲评 pairwise 中 Candidate 在 4/5 维度不劣于（多数优于）Human Final。**

## 0. 第一屏：30 问速答

| # | 问题 | 答案 |
|---|---|---|
| 1 | `academicScore ≥ 80` 从哪来？ | PRD §9.5"建议默认通过条件"（`docs/PRD.md:1141`）→ M3 实现 `27d23c1 feat(review)`，`backend/src/quality/gates.ts:249` + `config.ts:257`（env `QUALITY_ACADEMIC_PASS_SCORE` 可覆盖） |
| 2 | 80 有 benchmark 支持吗？ | **没有**。PRD 是设计期人工常量，示意记分卡假设 72→81→87→91 的生成式迭代轨迹；从未对真实论文/人工终稿校准。标 `UNVALIDATED_PRODUCT_THRESHOLD` |
| 3 | Reviewer score 校准过吗？ | **没有**。rubric 无 50/60/70/80/90 语义锚点；`overallScore` 为模型自报（缺失时取 5 维均值的 fallback 也只用过一次都没触发）；无归一化、无多样本聚合 |
| 4 | Baseline 分布？ | 本轮盲采 3 样本 **62/71/58**（mean 63.7，sd 6.7）；历史 7 个同族项目 r1 分 58–66；全文可见单样本 74 |
| 5 | Candidate 分布？ | 本轮盲采 3 样本 **58/63/68**（mean 63.0，sd 5.0）；全文可见单样本 69 |
| 6 | Human Final 分布？ | 本轮盲采 3 样本 **58/65/82**（mean 68.3，sd 12.3）；历史（Attempt 1 以人工终稿为基线）62→50→50；全文可见单样本 78（实验充分性 72，unsupported claim **0**） |
| 7 | Candidate vs Human Final 可区分？ | **不可**。现行管线下两组区间（58–68 vs 58–82）大面积重叠，n=3 下均值差 5.3 < 合成方差；全文可见 69 vs 78 同样在单样本噪声带内 |
| 8 | Human Final 稳定达到 80？ | **不稳定**。12 个真实锚点样本中仅 1 个（82）；其余 50–78 |
| 9 | 达不到 80 的原因？ | 评审输入截断（44% 正文，实验章不可见）压低实验充分性（25–55）；rubric 无锚点使 80 语义≈"几乎无可挑剔的完成稿"；同一文本重复评审方差高达 10–24 分 |
| 10 | Reviewer 方差多大？ | 同锚点同条件：baseline sd 6.7 / candidate sd 5.0 / human-final sd 12.3（range 24）；M11.3 综述项目同稿 5 采 sd 3.3（75–84） |
| 11 | Candidate 相比 baseline 真实改善？ | 绝对分无判别力（63.0 vs 63.7，重叠）；改善体现在结构面：16/16 patch 全 pass、Fact/Citation/Scope 零违规、finding 计数 crit 4→3 |
| 12 | Human Final 相比 baseline 改善？ | 68.3 vs 63.7（+4.6，不显著）；全文可见口径 +4（78 vs 74） |
| 13 | 两者改善同量级？ | **是**（都在噪声带内）；pairwise 判定 Candidate 在 intent 回应/事实可靠/证据充分/可投稿准备度 4 维 **优于** Human Final |
| 14 | 绝对分有判别力吗？ | **不足**。sd 5–12 时单样本 ±10 的置信带使 59 vs 80 的差距无法与"评分器噪声+输入截断"区分 |
| 15 | Gate 有 double counting？ | **有（已部分缓解后仍有）**。同一根因计入规则 4（claim）+5（blocking）+6（critical/major）——M11.2.3 rootCauseKey 只对"本轮 unsupported claim"去重，claimGapAudit 误判的 4 条基线 claim 绕过去重；academicScore 又整体重复惩罚同一批问题；`patch_validation_publishable` 是含 `gate.passed` 的 AND 级联（非独立失败源，仅重复呈现） |
| 16 | Gate 有 scope mismatch？ | **有**。Writer 只允许 reviewer-scoped patch；academic gate 评整篇论文（实际只评 44% 截断视图）。被修复的 claimGapAudit 本应豁免基线缺陷，但转述路线失灵 → 构造性矛盾成立 |
| 17 | 4 条 unsupported claims 是 baseline-existing？ | **是（4/4 实质均在基线）**。数值/措辞核验 + 基线原句逐一比对（§7） |
| 18 | 是 PaperTeam 引入的吗？ | 不是。fact-reviewer 从 candidate 文本"转述提取"，转述措辞与基线段落 Jaccard 结构性达不到 0.35 → 被误标 revision-introduced。r1 审**基线自身**就产出 1 条同类假阳性（定义级证明） |
| 19 | 属于 Reviewer 要求 scope 吗？ | 部分相关（Editor 意见涉及贡献边界/摘要），但基线表格与 E001 的矛盾属作者级科学裁决，不是本轮返修可单方解决的 |
| 20 | 应阻塞 Revision Task Success？ | **不应该**。属 `inherited baseline risk`（作者裁决层），应呈现给作者而非阻塞返修任务完成语义 |
| 21 | `MODEL_CAPABILITY_LIMIT` 成立吗？ | **不成立**。它不是系统枚举（系统只有 PASS/IMPROVED/CONVERGED/REGRESSION + QUALITY_NOT_REACHED/NO_PROGRESS/AUTHOR_DECISION_REQUIRED），是上轮报告的叙事性归类；在输入截断+归层误判+阈值未校准三重缺陷下无法归因到模型 |
| 22 | 更准确的 blocker？ | 见 §14 根因排序：REVIEW_INPUT_TRUNCATION（已修）> GATE_CALIBRATION（产品决策）> CLAIM_MISATTRIBUTION（已修）> BASELINE_INHERITED_RISK 语义 |
| 23 | 需要更强模型？ | **无证据支持**。pairwise 中现行 GLM-5.3 产出在事实可靠性与意图回应上优于人工终稿 |
| 24 | 需要调 threshold 吗？ | 不是当前动作。N=1 fixture 无法可靠校准全局阈值（§15）；先修输入与语义，阈值决策留给 Quality Gate Benchmark Set |
| 25 | 需要调 Gate 语义？ | **需要（作者决策）**。建议 Option C 混合式（§15）：绝对 floor（校准后）+ 相对不回归 + blocking findings 硬门 |
| 26 | 需要调 revision loop？ | 次要。轮内消费链正常（r2 计划确实派发了正确项）；主要损耗是追逐截断伪影 finding（已随 digest 修复消除） |
| 27 | 发现确定性工程 bug？ | **2 个，均已修复**：①`splitSingleFileDigest` 18 块上限+裸 slice；②`claimGapAudit` 无数字 claim 的 Jaccard 转述路线 |
| 28 | 修改代码？ | 是（上述 2 个 minimal fix + 5 个回归测试；见 §16）。未动任何阈值/守卫/gate 策略 |
| 29 | 调用次数/成本？ | **37 次 GLM-5.3 调用，全部 Coding Plan**（12 采样 × 3 mode + 1 pairwise）；评审 wall ≈ 8 分钟；无 General API 消耗 |
| 30 | 推荐下一步？ | §15/§17：作者对 Gate 语义做产品决策 →（如授权）用修复后管线重验 → 筹建 Quality Gate Benchmark Set 再定绝对阈值 |

## 1. Executive Conclusion

Attempt 7 最终判定 `MODEL_CAPABILITY_LIMIT` 的直接证据链是：academic gate 59 < 80、blocking 1、critical 1 / major 6、4 条"revision-introduced" unsupported claims。本轮审计证明这四个数字全部由**可确定性复现的评审输入缺陷与归层器缺陷**加上**未校准的阈值**产生，不能作为模型能力上限的证据：

1. **Reviewer 只看到论文的 44%。** 单文件导入路径的 digest 切块器 `splitSingleFileDigest` 有 18 块上限，而返修前基线有 36 个 `\section/\subsection/\subsubsection` 块——实验章后半（主对比、消融、极端场景、边缘部署、讨论、结论）**整体未进入审稿上下文**。三轮 academic 评分中"实验充分性"恒 25（r2/r3）/35（r1），reviewer 摘要原文明确说"实验部分仅写到数据集介绍……主对比、消融、极端场景与边缘部署实验……全部缺失"——这是对其截断视图的诚实描述。修订循环还把该伪影当作真实 critical 问题派发给 Writer（`f-2f11c1829e89`："补充……完整定量对比表、消融表"），要求补充论文里**本来就存在**的实验。
2. **4 条"修订引入"的 unsupported claims 全部是基线既有内容的转述。** claimGapAudit 的无数字 claim 路线用 reviewer 转述短语（~10–15 token）与基线整段（上百 token）的 Jaccard ≥ 0.35 判 pre-existing——数学上限 ≈ |claim|/|段落| ≈ 0.05–0.15，**结构性不可达**。定义级证明：r1 审阅对象就是冻结基线自身（SHA 一致），仍产出 1 条 `revision_introduced`。
3. **80 阈值从未校准。** 它是 PRD §9.5 的设计期建议值（M3，`27d23c1`），rubric 没有任何分值锚点定义，`overallScore` 是单次模型自报；同一文本在完全相同条件下重复评审的方差为 sd 5–12.3（range 最大 24）。**人工终稿的 12 个真实样本里只有 1 个达到 80。**
4. **盲评 pairwise（同 prompt 同模型）判定 Candidate（甲）在 intent 回应、事实可靠性、证据充分性、可投稿准备度 4 个维度优于 Human Final（乙）**，学术表达相当——直接反驳"GLM-5.3 达到能力上限"的叙事。

最终分类：**E. MIXED**，主因 `QUALITY_GATE_CALIBRATION_PROBLEM` + 两个已修复的确定性缺陷；`TRUE_MODEL_CAPABILITY_LIMIT` 无证据支持。

## 2. Attempt 7 Blocker Reconstruction

数据源：`backend/projects/p-d12dc28ad850/`（clean run `w-80ffbbbf69a5`）。

### 2.1 三轮评分轨迹

| Round | 审阅对象 | academicScore | 五维（问题定义/方法/实验充分性/论证/写作） | critical/major/blocking | unsupported |
|---|---|---|---|---|---|
| r1 | rev-1（=冻结基线） | **62** | 82 / 72 / **25** / 70 / 80 | 4/11/5 | 8（7 pre-existing + **1 误判**） |
| r2 | rev-2 | **58** | 82 / 68 / **25** / 55 / 65 | 3/9/4 | 5（2 + **3 误判**） |
| r3 | rev-3（candidate） | **59** | 82 / 74 / **25** / 60 / 65 | 3/8/4 | 6（2 + **4 误判**） |

注意：**修订后分数低于修订前**（62→58→59），且"实验充分性"三轮纹丝不动。reviewer 会话键 `agent:{agentId}:peer-{projectId}:review/academic` **跨轮复用**——r1 的"实验缺失"结论进入 r2/r3 的会话上下文，形成自我锚定。

### 2.2 r3 Gate 失败规则

```
unsupported_critical_claims_zero : 修订引入 claim 4 条（基线原有 2 / 作者数据 0）
blocking_issues_zero             : blocking 1（另有归因排除 1 + 同根因 2）
open_critical_major_zero         : critical=1 major=6（另有排除 critical 2 / major 2）
academic_score_threshold         : academicScore=59（要求 ≥ 80）
patch_validation_publishable     : patches=5/5; unattributed=0  ← AND 级联，非独立失败源
```

`patch_validation_publishable = summary.publishable && factPreservation.ok && citationPreservation.ok && gate.passed && 无 build error`（`definitions.ts:782-784`）——它在 gate 已失败后被强制置 false，是**呈现级重复**而非独立判据。

### 2.3 循环终止

`DEFAULT_MAX_REVISION_ROUNDS = 2`（`config.ts:255`）→ 第二轮后 `hitl.revision_overflow` → 驱动选择 `accept_draft` → 终态 completed(draft)。系统的确定性分类族（`revisionOutcome.ts:58-59`）是 QUALITY_NOT_REACHED / NO_PROGRESS / AUTHOR_DECISION_REQUIRED；**`MODEL_CAPABILITY_LIMIT` 不存在于任何系统枚举**，是上轮执行报告的叙事归类——在三重缺陷未识别时作出的归因，本轮不成立。

## 3. academicScore 架构

```
ReviewerService.reviewMode(mode="academic")      // 单 Agent 单会话，contextScope review/academic
  prompt = buildReviewPrompt()                    // 见 §4-5
  → 单次 GLM-5.3 调用，输出 JSON {scores{5 维}, overallScore, issues, summary}
  → parseModeReview: overallScore = 模型自报（0-100，Math.round）；
                     缺失时 fallback = 5 维算术平均（ReviewerService.ts:414-417）
ReviewAggregator.aggregateReviews()
  academicScore = academic?.overallScore ?? null  // 直接透传，无归一化/无聚合/无多样本
QualityGate rule 7: academicScore ≥ 80 (hard)
```

关键属性：**单模型、单次采样、自报总分、无锚点、无跨轮校准基线**。reviewer 可用工具（evidence_query/get_chunk/retrieve_library）在 academic 模式下也可用，但评分主要依据 digest。

## 4. threshold=80 溯源

| 层 | 位置 | 内容 |
|---|---|---|
| PRD | `docs/PRD.md:1135-1147`（§9.5 Quality Gate 默认规则） | "建议默认通过条件（阈值可按 targetProfile 配置）：… Academic score ≥ 80 …"；同节示意记分卡 Round1 72 → Round2 81 → Round3 87 → Round4 91 PASS |
| 实现 | `backend/src/quality/gates.ts:248-252` `DEFAULT_QUALITY_THRESHOLDS.academicPassScore = 80` | M3 引入：`27d23c1 feat(review): complete M3 review and revision workflow` |
| 配置 | `backend/src/config/config.ts:257,461` `QUALITY_ACADEMIC_PASS_SCORE`（默认 80） | 未在本机设置过环境覆盖 |
| 共享 | 同一 `evaluateQualityGate` 服务 idea_to_paper / existing_paper_improvement / topic_survey 三种 workflow | survey 有独立 rubric（`reviewProfile="survey"`）但**共用 80**；无 documentType/taskType 差异化 |

**判定：`UNVALIDATED_PRODUCT_THRESHOLD`。** 没有任何 benchmark、校准实验或真实分布支撑；PRD 的示意轨迹（4 轮内 72→91）属于生成式写作闭环的设想，不适用于"作者已投稿、被拒后返修"的 existing-paper 场景——该场景的输入论文质量是**给定的**，产品无法通过返修把它推到生成式闭环设想的高分。**本轮未修改该值。**

## 5. Scoring Rubric Audit（§6 逐项）

academic 模式的完整 rubric（`ReviewerService.ts:604-608`）：

```
你使用 academic review skill：从问题定义、方法合理性、实验充分性、论证逻辑、写作质量评审。
结合目标档次标准执行（目标档次：{targetProfile ?? "未指定"}）。
输出额外字段 scores: {问题定义: 0-100, …} 与 overallScore。
```

| 检查项 | 结论 | 证据 |
|---|---|---|
| A. 极度苛刻 | 部分 | prompt 无"苛刻"指令，但"结合目标档次标准"+无锚点使模型自行采用严格审稿人姿态 |
| B. 找问题导向压分 | **成立** | 三路共用 issue 契约"确属阻断级才 blocking"，但 fact 契约强制"无 verified Evidence 支撑的关键论断必须 UNSUPPORTED 并生成 critical/major issue"（`ReviewerService.ts:623`）——EvidenceStore 只有 2 条 verified 时，摘要强论断必然成 critical |
| C. critic+gatekeeper+scorer 三合一 | **成立** | 同一输出既产 issues（驱动修订）又产 gate 分数；分数与 finding 严重度未解耦（§6 double counting） |
| D. 80 语义≈"几乎无问题" | **成立** | 无锚点时模型默认把 80+ 留给"接近无可挑剔"；实测：人工终稿 12 样本仅 1 个 ≥80 |
| E. 强制产 findings | 部分 | issues 可空（`parseIssues` 允许缺失），但 fact 路契约见 B |
| F. score 与 findings 严重度不一致 | 成立 | VIS human-final 样本：78 分同时只有 1 critical/1 blocking/0 unsupported——分数与 findings 可以脱钩 |
| G. 无 previous findings 上下文 | **部分不成立** | 会话键含 projectId+scope → 同项目跨轮复用，reviewer 能看到自己上轮输出；但 prompt 未定义跨轮比较语义，锚定效应非受控（r1"实验缺失"结论被自我延续） |
| H. 随机性 | **成立且重大** | 同锚点同条件 3 采样：sd 5.0–12.3；单样本 gate 决策被噪声支配 |

**判定：`SCORE_SCALE_UNCALIBRATED`（锚点缺失 + 方差未建模 + 单样本决策）。**

## 6. Candidate Gate 交互 / Double Counting

同一根因（如"摘要 claim 与 E001 矛盾"）的计数路径：

```
fact reviewer → UNSUPPORTED claim ──→ 规则 4（claim 口径）
            └→ critical/blocking issue ──→ 规则 5（blocking 口径）
                                    └────→ 规则 6（critical/major 口径）
（rootCauseKey 去重只覆盖"计入阻断口径"的本轮 claim；被 claimGapAudit
  误判为 pre-existing 豁免的 claim 的 finding 不带 rootCauseKey，
  规则 5/6 仍按 issue 口径排除——豁免与去重两套机制各修一半）
academic reviewer → 实验充分性/论证逻辑 维度分 ──→ 规则 7（同一问题的第三次惩罚）
patch_validation_publishable ← AND(gate.passed) ──→ 呈现级第四次重复
```

规则 4/5/6 之间 M11.2.3 已做 rootCauseKey 去重（Attempt 7 r3：blocking 4 − 排除 1 − 同根因 2 = 1），但 academicScore 作为**独立绝对硬门**对同一批问题做无去重的整体再惩罚。**如果所有真正危险问题已由 Fact/Citation/Evidence/Scope/Build/blocking findings 硬门覆盖，academicScore 的独立硬门角色需要校准证据支持——当前不存在该证据。**（产品建议见 §15；本轮未改。）

## 7. Baseline-Existing Unsupported Claims 分析（4 条逐条）

r3 claimGapAudit 全部 6 条 unsupported（`claim-gap-audit-r3.json`）：

| claimId | claim（reviewer 转述） | section | audit 判定 | 本轮核验 | 基线原句证据 |
|---|---|---|---|---|---|
| c-eb3e94630d33 | MRG-DTM 降低遮挡恢复过程中的身份切换 | abstract | revision_introduced | **实质在基线** | "MRG-DTM 机制显著降低了遮挡恢复过程中的身份切换次数" |
| c-025da1b5642e | 消融实验验证门控写入、兼容读取、稳定性约束三组件有效性 | abstract | revision_introduced | **实质在基线** | "消融实验验证了运动残差门控写入、运动兼容读取和轨迹稳定性约束的有效性" |
| c-05eb828b1e7b | RDK X3 完成完整链路部署验证 | abstract | excluded_pre_existing | 数值路线（"3"命中） | 基线原文存在 |
| c-0b1d203ebee6 | 统一 YOLOv11 下相比 Kalman/DeepSORT/ByteTrack/OC-SORT 均改善 | abstract | excluded_pre_existing | 数值路线（"11、1"命中） | 基线原文存在 |
| c-5ff00c41276f | 轨迹稳定性损失从端到端优化角度抑制轨迹抖动 | 方法 | revision_introduced | **实质在基线** | "缺少在训练阶段显式建模轨迹平滑性的显式约束"及 L_smooth 节论述 |
| c-7b1ad41927f7 | 现有记忆式方法模板读写缺乏与运动一致性显式耦合（研究空白） | 引言 | revision_introduced | **实质在基线**（措辞最接近的转述，containment 0.48） | "外观模板或记忆的写入与读取大多仍由表观相似度单独驱动，缺乏与运动一致性的显式耦合" |

归层机制的两条路线（`claimGapAudit.ts`）：
- **数值路线**：claim 内全部数字在基线全文存在 → pre-existing。反向缺陷：含"3""11、1"等常见数字即自动豁免（c-05eb/c-0b1d 实质与另 4 条同类却因数字豁免）。
- **无数字路线（本轮修复对象）**：转述 vs 基线整段 Jaccard ≥ 0.35。**短转述对长段落的 Jaccard 数学上限 ≈ |claim|/(|claim|+|段落|−|交|) ≈ 0.05–0.15**——结构不可达。

**定义级假阳性证明**：r1 审阅对象就是冻结基线（rev-1，SHA `423CF0E0…` 一致），仍产出 1 条 `revision_introduced`（"消融实验验证了运动残差门控写入、运动兼容读取和轨迹稳定性约束的有效性。"——该句**逐字来自基线摘要**，由 fact-reviewer 从基线 digest 转述后与基线全文比对，判定"冻结基线与作者证据均不覆盖"）。

**8 问回答**（任务 §8）：①全部 pre-existed；②Writer 改写过摘要/引言相关 span（编辑意见 scope 内），claim 实质未变；③Editor 意见要求贡献边界（相关）；④部分在 scope；⑤非本轮引入（转述归层错误）；⑥未变强；⑦Human Final 保留同类 claim（VIS 全文样本 fact 口径 U0/C0 详见 §9——其摘要措辞与表格更一致）；⑧Gate 阻止它们是因为归层器把"作者裁决层风险"计入"修订引入回归"口径；⑨定性为 **inherited baseline risk**（非 revision regression、非本轮可控的 global publication risk）。

## 8. Revision Task Success vs Publication-Ready Success

现有语义混同的证据链：
- Writer 边界：proposal-only、scope guard、16 个 patch 全部限定在 reviewer-comment 派发的 logical span——**任务语义 A（正确完成指定返修且不引入新问题）已被 Attempt 7 满足**（16/16 首轮 pass、Fact/Citation/Evidence/Scope/Build 全 PASS、direct mutation 0、outside-scope diff 0）。
- Gate 语义：academicScore 评**整篇论文**（实际评 44% 截断视图）+ 4 条基线 claim 误判为修订引入 → **语义 B（全稿无可挑剔）拦截了语义 A 的完成**。
- 后果：只要原稿有作者级缺陷（几乎所有真实返修稿都有），语义 A 永远不能 PASS——除非 Writer 越权修改作者未授权的内容（这正是 M11.4.1-M11.4.4 系列修复所禁止的）。

**判定：构成构造性矛盾（SCOPE_GATE_MISMATCH 成立），但注意它是两个确定性缺陷（§1.1/§1.2）+ 阈值未校准的合成结果，而不是一个独立的"设计选择"。修复归层器后，r3 的规则 4 从 4 条降到 1 条边界 case（0.48 containment，见 §16）；academicScore 的整稿评价角色是剩余的产品设计问题。**

## 9. Score Calibration Experiment

### 9.1 设计

- 锚点：A=pre-revision baseline（`paper_before_revision.tex`）/ B=Attempt 7 candidate（rev-3 main.tex）/ C=Human Final（`manuscript/source/paper.tex`；Attempt 2 candidate freeze `2026-10-04T23:13:35Z` 后已解除 hold，仅在独立评估语境读取，不回灌任何生成链——Attempt 7 run 已终态）。
- 完全相同：Reviewer prompt、模型（zai-coding-cn/glm-5.3，Coding Plan）、rubric、pipeline（`ReviewerService.reviewAll` 三路 fan-out）、Evidence（E001/E002）、citation digest。Reviewer 不知道锚点身份（prompt 无任何来源信息）。
- 每样本独立项目副本（`sessionKey` 按 projectId 派生 → 全新会话，零历史泄漏）。
- 臂：CAL（现行 digest 原样，含缺陷）3×3；VIS（全文 digest，无截断）各 1；PAIRWISE 1。
- 脚本：`scripts/m114-quality-gate-calibration.mjs`；产物：`D:\PaperTeamData\M11_4_QualityGateCalibration\calibration-report.json`。

### 9.2 结果

| 组 | n | academicScore | 实验充分性 | unsupported/contradicted | critical/blocking |
|---|---|---|---|---|---|
| baseline（现行 digest 44%） | 3 | 62 / 71 / 58（mean 63.7 sd 6.7） | 35/55/25 | 4+2 / 5+1 / 2+2 | 4-2/5-3 |
| candidate（现行 digest 44%） | 3 | 58 / 63 / 68（mean 63.0 sd 5.0） | 30/45/55 | 5+1 / 5+3 / 5+2 | 2-3/3-5 |
| human-final（现行 digest 43%） | 3 | 58 / 65 / **82**（mean 68.3 sd 12.3） | 30/35/**80** | 5+2 / 2+3 / 6+2 | 3-3/3-4 |
| **VIS baseline（全文）** | 1 | **74** | 65 | 6+1 | 3/3 |
| **VIS candidate（全文）** | 1 | **69** | 66 | 4+2 | 5/5 |
| **VIS human-final（全文）** | 1 | **78** | 72 | **0+0** | 1/1 |

（历史同族数据：pre-revision 基线 r1 分 58–66 共 7 项目；Human Final 作为基线的 Attempt 1 项目 62→50→50；M11.3 综述同稿 5 采 75/80/80/84/84。）

### 9.3 关键判定

- **判定 1（Score Discrimination）**：Candidate 与 Human Final 区间大面积重叠（58–68 vs 58–82），n=3 均值差 5.3 < 合成噪声；全文可见口径 69 vs 78 亦在单样本噪声带。**绝对分在现行配置下无判别力。80 hard gate 高度可疑（人工终稿 12 真实样本仅 1 个 ≥80）。→ `SCORE_SCALE_CALIBRATION_PROBLEM` 确认。**
- **截断 artifact 定量**：全文可见使三锚点分值 +6~+16、实验充分性 25–55 → 65–72、human-final 的 unsupported claims 6+2 → **0+0**（fact reviewer 看得到实验表格后，摘要 claims 不再"无支撑"）。**评审输入截断同时压分并制造假 unsupported claims。**
- **判定 2（Pairwise，§15 任务）**： blinded 甲/乙（甲=candidate，乙=human final，两稿全文内嵌，同 reviewer agent）——**overall=甲更优**；intentResponse=甲、factReliability=甲、evidenceSufficiency=甲、academicExpression=相当、publicationReadiness=甲。理由摘录："甲…对 L_smooth 训练数据来源给出限定说明…如实标注'待作者确认'…明确声明未与 StrongSORT/Deep OC-SORT 数值对比的局限，避免过度声明。乙…保留了'一块或两块 GPU'等含糊表述"。单样本、指示性；仅用于校准研究，未接入任何 gate。
- **判定 3（Revision Delta）**：Candidate 的结构性改善真实（16/16 patch、守卫零违规、crit 4→3），但绝对分 delta 被截断 artifact 与方差淹没。Human Final 的 delta 同量级（+4.6/+4）。**"绝对 59"不能作为能力判定输入。**

### 9.4 方差与真伪缺陷的边界

VIS candidate 的 5 条 critical/blocking finding 中，3 条指向**真实的基线继承科学风险**（主对比表/消融表数值与 E001 公平协议数据矛盾——这与作者自己的 fair-ablation 历史结论一致："MRG-DTM 与 ReID 机制均无可测增益"），1 条端到端表述问题，1 条表间数值不一致。**这些是作者级科学裁决**（如何处理论文表格与公平消融数据的矛盾），不是返修执行器可单方解决的，也不是模型能力问题。

## 10. Revision-Loop Forensic（§17 任务）

r2 gate 失败 → `revision.plan`（37 项：5 external + 5 gate + 27 finding）→ 6 planned：
- 2 external（R1 文献、R2 部署——均转为 author_decision）
- 4 finding：f-2f11c1829e89（**截断伪影**："补充完整定量对比表/消融表"）、f-4ec7/f-ad88/f-3c24/f-ce0e（摘要 claim 弱化族——正确派发）
→ Writer 5 patch 全 pass → r3 review：分数 58→59，伪影 finding 复现（digest 依旧截断），摘要弱化族 finding 部分消解（crit 2→1）。

**58→59 只涨 1 分的解释（A-F 逐项）**：A 否（Writer 确实执行了派发项）；B 否（新 finding 增 26 vs 27 持平）；**C 是（loop 消费 finding 级指令，academicScore 评整稿/截断视图——修复伪影 finding 不改变"实验缺失"的评分主导项）**；D 是（Planner scope=审稿 finding，Reviewer 评分 scope=全文质量，二者被截断伪影强行绑定）；E 部分（±5 方差下 +1 无意义）；F 部分（16 patch 技术安全但学术保守——但保守正是 scope guard 的要求）。**主导因素是 C+D（由 BUG-1 驱动）。**

## 11. 4 个产品级决策点关联判定（§19 任务）

| 决策点 | 与本轮 blocker 关系 | 处置 |
|---|---|---|
| assessment 冻结时序（evidence supply 前冻结 level） | 无关（Attempt 7 得 MEDIUM，`target_feasibility` PASS） | 不扩展 |
| refutation ≠ coverage（R2 部署意见闭环语义） | 造成 R2 comment unresolved，不影响 academic score | 保留为独立后续项 |
| fallback write path 无 candidate 验证 | 未被 Attempt 7 触达（全程 scoped patch） | 保留为独立后续项 |
| **academic gate calibration** | **本轮 blocker 主因** | 本轮主体 |

## 12. MODEL_CAPABILITY_LIMIT 判定标准审计（§20 任务）

系统内不存在该分类（grep 全库无果）。系统分类族：outcome = PASS/IMPROVED/CONVERGED/REGRESSION（`revisionOutcome.ts:31`）；stop 理由 = QUALITY_NOT_REACHED / NO_PROGRESS / AUTHOR_DECISION_REQUIRED（`:58-59`）。上轮报告的 `MODEL_CAPABILITY_LIMIT` 是在"bounded rounds 耗尽 + score<80 + 机械链路无缺陷"表象下的叙事归因——**其前提"机械链路无缺陷"被本轮推翻**（两个确定性缺陷均在链路内）。若引入新枚举，建议区分：MODEL_CAPABILITY_LIMIT / QUALITY_GATE_CALIBRATION_UNCERTAIN / REVISION_SCOPE_LIMIT / BASELINE_INHERITED_RISK / QUALITY_LOOP_NO_PROGRESS——**本轮未改枚举**（分析性建议）。

## 13. 不变量核对

本轮零改动：Fact Guard、Citation Guard、Evidence Guard、Scope Guard、held-out isolation（human final 仅在 Attempt 2 freeze 后合法语境读取，未接触任何生成链）、canonical alias resolution、patch lineage、candidate build integrity、`DEFAULT_QUALITY_THRESHOLDS`、`MAX_REVISION_ROUNDS`、所有 gate 规则语义。无 fabricated science。

## 14. Root Cause Ranking（按证据）

| # | 根因 | 置信 | 证据 | 处置 |
|---|---|---|---|---|
| 1 | **REVIEW_INPUT_TRUNCATION**（单文件 digest 18 块上限 + 裸 slice，实验章对三路 reviewer 全部不可见） | HIGH（确定性复现：36 块 → 18 块、44% 可见；reviewer 摘要自述；VIS 对照 +6~+16 分、U/C 6+2→0+0） | §1.1/§9 | **本轮已修**（§16.1） |
| 2 | **QUALITY_GATE_CALIBRATION_PROBLEM**（80 无 benchmark、rubric 无锚点、单样本方差 sd 5–12、人工终稿 12 样本仅 1 个 ≥80） | HIGH | §4/§5/§9 | 产品决策（§15） |
| 3 | **BASELINE_CLAIM_MISATTRIBUTION**（claimGapAudit 转述路线结构不可达 → 基线 claim 计入修订引入） | HIGH（r1 自比对假阳性 = 定义级证明） | §7 | **本轮已修**（§16.2） |
| 4 | **BASELINE_INHERITED_RISK 语义缺位**（论文表格 vs 公平消融数据的科学矛盾无"作者裁决"通道进入 gate 语义） | MEDIUM | §9.4 | 产品决策（§15） |
| 5 | MODEL_CAPABILITY_LIMIT | **LOW**（pairwise 相反证据；VIS 分差在噪声内） | §9.3 | 不采信 |
| 6 | REVISION_LOOP 低效（追逐伪影 finding） | LOW（BUG-1 的下游症状，随修复消除） | §10 | 随 #1 消解 |

**最终分类（任务 §31）：E. MIXED —— 以 QUALITY_GATE_CALIBRATION_PROBLEM（B）为主、叠加两个已修复的确定性缺陷（其效应与 C 同形）；TRUE_MODEL_CAPABILITY_LIMIT（A）不成立；D（loop 不消费 findings）不成立。**

## 15. Recommended Product Policy（供作者裁决，未实施）

- **Option A**（保持绝对硬门）：要求 80 有校准证据。现状不支持；且需先解决方差（多样本中位数）否则是噪声门。
- **Option B**（advisory 化）：academicScore 只作排序/呈现，硬门 = 确定性守卫 + blocking findings。风险：失去整体质量信号。
- **Option C（推荐方向）**：混合——`score ≥ 校准后 floor` AND `无 blocking critical（归层修正后口径）` AND `相对 baseline 无学术分回归（同可见性、多样本中位数）`；existing-paper 语境把 gate 目标显式定义为 **Revision Task Success**（任务语义 A：scoped 完成意图 + 零回归 + comment outcomes 闭环），publication-readiness 作为**作者面 advisory** 呈现（语义 B 分离）。
- **阈值校准前置条件（任务 §24）**：N=1 fixture 不可靠校准全局阈值。建议后续建 **Quality Gate Benchmark Set**（多组 pre-revision / human revised / known-good / known-bad 论文 + 每锚点 ≥3 采样），用 human-final 的分布（而非单点）定 floor，并明示 false-accept / false-reject / human-final-acceptance 三元 tradeoff。**本轮明确不设 58/60 之类的拟合值。**
- 附带工程建议（非本轮）：academic 评审 digest 与 fact 评审同源修复后，可考虑 review 多样本中位数以压方差（成本 ×n，需产品权衡）；转述归层的 0.4–0.6 灰区应进 author-decision HITL 而非二值判定。

## 16. 本轮确定性修复（minimal fix + regression + push）

### 16.1 `splitSingleFileDigest`（`backend/src/workflow/definitions.ts`）

- 块上限 18 → **64**（总量仍由 60k 总预算兜底）；每块 `slice(0,2600)` 裸切 → **`sliceForDigest`**（M11.3 Phase D 同款句界安全 + 截断系统注——该修复此前漏改单文件路径）；`buildManuscriptDigest` 总预算截断同样改句界安全切。修复后本 fixture digest 44% → ~93%（全 36 块可见，仅 2 个超预算块带注截断）。
- 效果（VIS 臂实测）：三锚点 +6~+16 分、实验充分性 25–55→65–72、human-final unsupported 6+2→0+0。

### 16.2 `computeClaimGapAudit` 无数字 claim 路线（`backend/src/review/claimGapAudit.ts`）

- 转述 vs 整段 Jaccard ≥ 0.35（结构不可达）→ **claim 词元在基线句/段落中的最佳覆盖率（containment）≥ 0.6**；数值路线不变。
- 真实数据重放（r3 grounding + 冻结基线，只读）：`revision_introduced 4 → 1`（c-eb3e 1.00 / c-025d 0.72 / c-5ff0 0.95 转为 pre-existing；c-7b1a 0.48 留在引入口径——灰区案例，见 §7 表）。
- 边界如实声明：containment 检测"实质是否基线既有"，不检测强度变化（强化措辞的既有 claim 可能被豁免——claim-strength guard 与 author 裁决仍在链上）。

### 16.3 验证

- 新增 `backend/test/quality/m114AuditRegressions.test.ts`：5 用例（>18 块尾节可见性 / 超预算块系统注 / 3 个真实转述样本判 pre-existing / 新概念 claim 仍判引入 / 数值路线回归不变）——**5/5 PASS**。
- 关联套件：`m1031Units` + `rootCauseDedup` 40/40 PASS；`existingPaper*`/`reviewer*` 21/21 PASS。
- Backend 全量（官方 4 workers）：**226 files passed / 3 skipped；2454 passed / 15 skipped；0 failed**（含 Docling real smoke）。Frontend typecheck PASS（前端零改动，未重跑其套件）。Backend build PASS。`git diff --check` PASS（收尾时执行）。

## 17. Recommended Next Step

1. **作者裁决 Gate 语义**（§15 Option A/B/C + benchmark set 立项与否）——这是唯一阻塞性决策。
2. 若裁决为 C：以修复后管线重验（"Attempt 8"语义），预期表现——digest 全量可见（评分基础改变）、claimGapAudit 归层修正（规则 4 预计 0–1 条）、academic 分布上移但仍在方差带内（是否达 80 不预测，n=1 无法预测）。
3. 转 auth 层后续项：R2 refutation≠coverage 的 author-decision 通道；fallback write path 验证（未被触达）。
4. 不做：模型 A/B、阈值拟合、guard 降级、自动 Attempt 8。

## 18. Model Usage / Cost

- **37 次 GLM-5.3 调用（zai-coding-cn，Coding Plan 订阅）**：12 校准采样 × 3 mode（fact/academic/style）+ 1 pairwise。零 General API 调用（启动即校验 `apiChannel`：`zai` 的 general_api 绑定在 `zai-coding-cn` 模型下不生效，缺省 = Coding Plan）。
- 评审 wall 合计 ≈ 477 s + pairwise 18 s ≈ **8.3 分钟**。逐 taskId 记录于 `calibration-report.json`（本 harness 不逐任务落 usage token；Coding Plan 口径下 list-price 估算无意义，不伪造）。
- 无 Writer / Planner / workflow 调用；正式 Acceptance 未进入；Attempt 7 run 未被触碰。

## 19. Git / 产物

- 开始：`main`，`HEAD == origin/main == 218e889`，clean。
- 本轮改动：`backend/src/workflow/definitions.ts`、`backend/src/review/claimGapAudit.ts`、`backend/test/quality/m114AuditRegressions.test.ts`（新增）、`scripts/m114-quality-gate-calibration.mjs`（新增，校准 harness）、本报告、`docs/PROJECT_STATUS.md`。
- 校准产物（不入库）：`D:\PaperTeamData\M11_4_QualityGateCalibration\`（calibration-report.json + 12 项目副本 + driver-log）。
- 收尾：commit + push `origin/main`；`git status` clean；`HEAD == origin/main`（收尾时验证）。
