# M15.2 — Finding Verification, Derived-Claim Audit & Severity Adjudication（工程研究记录）

> 日期：2026-10-22 · 仓库 `D:\Projects\PaperTeam`（main）· 起点 `4f7139c`（main == origin/main，工作树干净）· 冻结候选 `22f5df7`
> 实验数据（仓库外，不推送）：`D:\PaperTeamData\M15\M15_2`（plan / corpus / scripts / registry / builds / experiments / analysis）；旧基线 `D:\PaperTeamData\M15\QualityGateCalibration`、`D:\PaperTeamData\M15\M15_1`
> **结论：`PARTIAL`。** 预登记强判主指标在 SEALED_FINAL 上未达成：93 个封存成对案例中冻结候选出现 **1 条错误 VERIFIED_CONTRADICTED**（N09-P05，同名列跨表），按预登记（≥1 → PARTIAL、继续 shadow）判定；同一集合上 M15.1 守卫为 22 条。SEALED 真实 run 另暴露一个**候选崩溃缺陷**：N05 的 3 个候选 run 中证书构建抛 TypeError，shadow 审计整体缺失（生产审稿 / Gate 照常，fail-safe 生效）。两者均按协议不在 SEALED 上回改。生产 `gates.ts` / `revisionTaskGate.ts` 未改动（blob 哈希与起点逐字节一致），全部新能力为 shadow。

## 0. 一句话结果

M15.1 的 VERIFIED_* 只比较模型写出的两个数，对应关系完全由模型决定；在新冻结的独立语料上，M15.1 守卫在 DEV_NEW 98 / SEALED 93 个成对案例中分别产生 **17 / 22 条错误强判**（错表、错行、外部数据）。M15.2 把「两个数是不是同一个观察量」改成确定性证书（表格结构解析 + 唯一绑定 + 区间算术 + 受控派生量 AST）：错误强判降到 **0 / 1**，代价是强判召回从 27/61、28/57 降到 **5/61、1/57**——几乎所有真矛盾都停在 REVIEWER_SUSPECTED（不出强判、不阻断）。SEALED 真实 run 上 M15.2 的 VERIFIED_CONTRADICTED 为 0，而同一批输出在 M15.1 守卫下有 8 条落在注入位点、11 条不在（其中 7 条经 model_audited 为原稿真实不一致）。finding 定向复核与四轴裁决几乎不改变严重度（DEV_NEW 7187 个根因中 10 个、SEALED 2332 个中 2 个），没有撤回任何注入缺陷，但 SEALED 上把 1 个注入缺陷从 critical 封顶为 major；306→256 的下降主要是严重度收缩而非检出丢失。

## 1. 基线与审计（只读）

| 项 | 起点 4f7139c | 结束（候选 22f5df7 + 文档提交） |
|---|---|---|
| backend typecheck / build | exit 0 | exit 0 / exit 0 |
| backend vitest | 382 文件 / 4105 通过 | 384 文件 / **4142 通过** / 40 跳过（`--maxWorkers=4`，EXIT 0）；另两次缺省并发全量各有 1 个与本轮无关的计时型用例超时（`stylePolish` 5 s 超时——与 6 个 live run 并行时；`doclingConcurrency` 重叠计数），单独重跑分别 19/19、3×3/3 通过，相关源码自起点未改 |
| frontend typecheck / vitest / build | exit 0 / 364 / exit 0 | exit 0 / 38 文件 364 通过 / exit 0 |
| `git diff --check` | — | 通过 |
| 生产 gates.ts / revisionTaskGate.ts | blob `86e5378…` / `b1fe280…` | 同一 blob（未改动） |

调用链（沿实际 import 审计）：`ReviewerService.reviewUnit`（published 口径 extended 时内联 unit-claims/v1）→ `definitions.ts::runReviewAudits`（buildClaimAudit → selectRecheckItems / recheckClaimsCrossUnit / applyCrossUnitRecheck → auditFindings → readOnlyCitationAudit）→ quality.gate `computeShadowDecision`（validateClaimAudit → QualityDecisionV2 shadow）。生产 `evaluateQualityGate` 不读任何 shadow 产物。M15.1 的 VERIFIED_CONTRADICTED 唯一入口是 `decideClaimStatus` 的「原文内跨处核对」分支：确定性部分只有引文定位、写出数值的比较与词面守卫，没有表格结构、语义键或唯一性检查。

## 2. 新独立冻结语料（任务 A）

- 来源：14 篇 arXiv CC BY / CC BY-SA 作者 LaTeX（cs.CV 5、cs.CL 3、cs.LG 2、eess.AS 1、cs.RO 1、cs.IR 1、cs.SE 1）+ 2 篇《中国图象图形学报》CC BY-NC-ND PDF 转写（中文数字表）。独立性过滤：排除 M15 检索见过的 615 个 arXiv id 与旧清单；A01–A18 及旧轮下载过的 CJIG 文章全部排除。获取日志 `corpus\ACQUISITION_LOG.md`、`corpus\registry\families.jsonl`。
- **先冻结、后开发**：`corpus\registry\split_lock.json`（按 sourceKind 分层、`sha256("m152-split-v1|"+nid)` 排序交替分配）→ DEV_NEW 8（N01 N02 N06 N10 N11 N13 N14 N15）/ SEALED_FINAL 8（N03 N04 N05 N07 N08 N09 N12 N16），两侧各含 1 篇中文转写。
- **真值**：每 family `oracle\cases.json`（规格 `corpus\ORACLE_SPEC.md`）——命名原子值（原稿唯一锚点 + 完整数字 token）、编辑、模拟审稿提议（可以是故意错误的对应）、relation + Python 真值式 + originalCheck。`oracle_tools\oracle_check.py` 机械校验（自测：3 正例过、4 个构造错误全部被拒）。SEALED 的 oracle 由两个独立子代理编写，**不看验证器代码、回复只给计数**。
- 规模：成对案例 **191**（DEV_NEW 98 / SEALED 93），10 个类别（C01 正确对应、C02 单处矛盾、C03 单位、C04 百分点 vs 相对、C05 平均 / 求和、C06 同名列跨表、C07 不同行、C08 舍入、C09 转写、C10 外部数据）；E2E 输入 48（每 family 原稿 1 + 注入变体 2；DEV_NEW / SEALED 各 24）。`registry\manifest.jsonl` 与 `registry\oracle_freeze.json` 记录全部 sha256，`freeze_corpus.py verify` 通过。
- 标签分开：**automated_truth**（oracle 案例 + 注入位点 + 算术）；**model_audited**（Claude 子代理复读，非人工）；weak_proxy（本轮无公开审稿意见数据，N/A）。合成 property 夹具只在单元测试中，不计入任何检出率。

## 3. 工程（全部 shadow）

| 模块 | 作用 | 版本 |
|---|---|---|
| `review/latexTable.ts` | tabular 结构解析：行 / 多级表头（midrule / hline 分界）/ multicolumn / multirow / 行组 / 转置表 / 偏移 | — |
| `review/claimCertificate.ts` | 论断原子定位 → 唯一单元格绑定（列维 metric 距离、行维只认主语且剥离比较对象、上下文 dataset、respectively 位置对齐、引用表过滤、覆盖度决胜）→ 显示精度区间比较；拒绝理由码（未解释上下文词、限定词、多指标歧义、未解析表中出现等） | claim-certificate/v1 |
| `review/derivedFormula.ts` | 受控 AST（add / subtract / sum / mean / ratio / multiple / relative_change_percent / percentage_point_difference / unit_convert / round），参数只绑定已定位原子，区间算术，无 eval；解释不唯一或方向不明 → 只记录复算、不出证书 | derived-formula/v1 |
| `review/claimAudit.ts` | 账本 v2（读 v1）：每条论断带证书；**VERIFIED_* 只能来自证书且与模型 check 一致**（双钥），否则降级 CERTIFICATE_NOT_ISSUED；共享原子 → rootCauseId | paperteam.review-claim-audit/v2，claim-audit-verifier/v2 |
| `review/findingVerification.ts` | critical/major CONTEXT_INCOMPLETE 的有界定向复核（批 6、上限 `PAPERTEAM_REVIEW_FINDING_RECHECK_CALLS` 缺省 3、sealed 会话、引文必须落在候选片段、反驳必须含被断言缺失的术语）；PARSE_ARTIFACT 无页面来源 → UNRESOLVABLE、不调模型；**从不删除 finding** | finding-recheck/v1 |
| `review/findingAdjudication.ts` | 每个根因四轴：verification / severity（observed 与 adjudicated 分开、规则可追溯）/ impact-blocking（仅「证书确认 + 触及核心论断」）/ taskScope（生产 `classifyFindingOrigins`）；`validateFindingAdjudication` 一致性契约；`reviews/finding-adjudication-r{n}.json` | paperteam.finding-adjudication/v1 |
| `claimStage` | `PAPERTEAM_REVIEW_CLAIM_STAGE=separate` 可把论断抽取拆成独立调用；缺省 inline（单元 prompt 与 M15.1 逐字节一致） | — |

QualityDecisionV2 shadow 只多带 `findingAdjudication` 摘要；作者工作流（existing_paper_improvement / thesis）不触发 finding 复核（测试断言 0 次额外调用）。

## 4. 强判（VERIFIED_*）：automated_truth 成对案例

零模型：模拟审稿提议直接喂给验证器（M15.2 冻结构建 `builds\m152-final` vs M15.1 `f2e7804`）。「可证明」= 真值为同一观察量（矛盾或一致）的案例。

| split | 案例 | M15.2 正确强判 | M15.2 **错误强判** | M15.2 弃判 | 不可注入 | M15.2 强判召回（可证明） | M15.1 正确 / **错误** 强判 | M15.1 召回 |
|---|---|---|---|---|---|---|---|---|
| DEV_NEW（开发用） | 98 | 5（VC 2 / VS 3） | **0**（95% 上界 3.7%） | 88 | 5 | 5/61 | 27 / **17** | 27/61 |
| SEALED_FINAL（单次） | 93 | 1（VS 1） | **1**（95% 上界 5.9%） | 83 | 8 | 1/57 | 28 / **22** | 28/57 |

- 强判精度：DEV_NEW 5/5，SEALED 1/2；M15.1 为 27/44、28/50。
- TP / FP / FN / 弃判（强判口径，automated_truth）：成对案例 DEV_NEW 5 / 0 / 56 / 88，SEALED 1 / 1 / 56 / 83（FN = 可证明但未强判；弃判含不可证明案例的正确弃判）；真实 run 注入缺陷 DEV_NEW 3 / 0 / 45 / —，SEALED 0 / 0 / 14 / —（N05 两个变体无账本，不计入分母）。
- M15.1 的错误强判按类别：DEV_NEW C06 5/11、C07 7/10、C10 3/6、C04 1、C08 1；SEALED C06 9/12、C07 10/15、C04 2、C10 1。
- SEALED 弃判主因：`BINDING_UNBOUND:NO_CELL_MATCHES_METRIC_AND_ROW` 29、`DERIVED_COLUMN_UNBOUND` 14、`TIED_CANDIDATES` 9、`UNEXPLAINED_CONTEXT` 7、`COUNTERPART_VALUE_IN_UNPARSED_TABLE` 7——召回瓶颈是表格结构理解，不是比较逻辑。
- **DEV_NEW 上做过的根因修正**（全部在 SEALED 打开前、只用 DEV_NEW 与旧 DEV）：复数归一、前导点数字 `.0485`、respectively 位置对齐、列表感知的 metric 距离、转置表、`\ref` 引用表过滤、覆盖度决胜、区分性词只认 distinctive、对齐行名计入已解释、midrule 可选参数、列表续句不切分、表内派生列 → 原子比较。召回 1/61 → 5/61，错误强判始终为 0。M15.1 的 KA90F129 类误报（「relative improvements of 6.22% … over RODNet-CDC」被绑到比较对象行）在旧 DEV 重放中发现并修正。

### 4.1 SEALED 唯一错误强判（N09-P05）——只诊断，未修

论断「on ACM the reproduced PHGT achieves only 84.78 Macro F1」；模拟提议把它配给 HGB 公平比较表的 PHGT 行（ACM / Macro-F1 = 92.20）。真值：84.78 在**复现表**里——该表把模型名放在体内重复的组头行（`\multicolumn{4}{c}{PHGT}`），每组再跟一对体内 `Source` / `Metric` 行，行标签只有 `model` / `RGCN`。解析器只把首个表头块当表头，体内重复的组头被当成数据行，于是复现表里不存在「PHGT × ACM × MaF1」这个竞争单元格，唯一性检查**在缺少竞争者的情况下通过**；论断里的区分词 reproduced 也没有与表的 caption 建立关系。两个未实现的防线：(a) 论断值在文档其它表格单元中逐字出现时应弃判；(b) 体内重复表头块应被识别为分组。按预登记，此结果不在 SEALED 上回改，作为 M15.3 第一项。

## 5. 真实 E2E run（base vs 候选，各 24 输入）

DEV_NEW：base ×3、m152w3 ×3（144 run，0 失败）；候选确定性层以冻结构建 `m152-final` 在同一批 m152w3 输出上零调用重放（`replay_m152f_devnew.json`，与工作树结果逐项一致）。SEALED：base ×1、冻结候选 m152f ×1（48 run），构建与 run 同源，无重放。

| 指标 | DEV_NEW base | DEV_NEW m152 | SEALED base | SEALED m152f |
|---|---|---|---|---|
| run（完成 / 失败） | 72 / 0 | 72 / 0 | 24 / 0（+3 harness 失败，见 §10） | 24 / 0（+3 harness 失败）；其中 3 run 无 shadow 账本（N05 崩溃，§5.1） |
| critical+major / run（sd） | 22.01（12.58） | 20.01（13.82） | 25.12（12.06） | 21.71（11.55） |
| 注入缺陷 finding 检出（任何 / C+M） | 46/48 · 43/48 | 48/48 · 42/48 | 16/16 · 10/16 | 16/16 · 11/16 |
| VERIFIED_CONTRADICTED（位点上 / 非位点） | — | 3 / 0 | — | **0 / 0**（21 个有账本的 run） |
| VERIFIED_SUPPORTED（核对正确） | — | 12（12 正确） | — | 2（2 正确） |
| 注入缺陷 claim 层：强判 / 疑似 | — | 3/48 · 36/48 | — | 0/14 · 11/14（N05 两个变体无账本） |
| blocking 根因 | — | 0 | — | 0 |
| 调用 | 1953 | 2181 | 651 | 712 |

- DEV_NEW 的 3 条 VC 都是 N01-V01 注入（ELGCA 83.83 vs 81.83）；12 条 VS 逐条核对正确（DiverseVul 3.3%、转置表 NeST OWA 0.860、BIT respectively 列表、TransUNetCD 94.50 等）。
- **M15.1 视图（同一批 m152 输出零调用重放 M15.1 verifier，非独立采样）**：DEV_NEW VC 105 条，位点上 31、非位点 74。非位点 74 条去重 46 对，由独立 Claude 子代理只读 DEV_NEW 输入复核（model_audited）：FALSE_PAIRING 28（其中 9 对两处其实一致）、TRUE_INCONSISTENCY 15、NOT_DETERMINABLE 3；按 run 加权 74 条中 31 条为原稿真实不一致（如 N14 CodeBERT BigVul 准确率表 95.57 vs 正文 96.86、N01 SNUNet F1 88.16 vs 88.18、N13 四数据集提升均值 19.4% vs 正文「平均 26%」、N02 ReXTime 增益均值 4.9 vs 「4.6%」）。这 15 对 M15.2 一条都没出强判（多为均值 / 派生或跨表），即 M15.2 的保守代价不只在注入集上，也在原稿真问题上；它们留在 REVIEWER_SUSPECTED，由 finding 层呈现。
- SEALED 的 2 条 VS：N03 检索 mAP 99.33（表行 `(ours)` × Retrieval mAP）与 N09「On ACM, RGCN achieves 94.11 Macro-F1 … SimpleHGN ranks second with 93.42」（绑定到句子 `\ref` 的 `tab:hgb_fair_comparison`，RGCN 94.11±0.30 / SimpleHGN 93.42±0.44）——开发方逐格核对正确。
- **SEALED 的 M15.1 视图**（同一批 m152f 输出零调用重放，21 run）：VC 19，位点上 8（N12-V01 67.5 vs 72.5、N03-V01 99.52 vs 98.52、N08-V01、N08-V02、N07-V01），非位点 11（去重 9 对）由独立子代理复核（model_audited）：TRUE_INCONSISTENCY 5 对 / 7 条（N03「低级扰动下 OA 除 impulse 外均 ≥94%」与表中 Upsampling 91.90 矛盾 ×3；N07 主表 GPT-4o 与 GPT-4o-mini 两行疑似互换 ×2 对），FALSE_PAIRING 4 对 / 4 条。即 SEALED 真实 run 上，M15.2 放弃了 M15.1 能抓到的全部 8 条注入强判，换来 0 条非位点强判。
- SEALED 每臂只 1 次采样，位置根因簇的「稳定簇」定义（≥2 run）不适用，不报簇级丢失 / 收缩。

### 5.1 SEALED 暴露的候选崩溃（N05，3/24 候选 run）——只诊断，未修

N05 三个候选 run（原稿 + 两个变体）都没有 `claim-audit` / `citation-audit` / `finding-adjudication` / V2 shadow 产物。诊断脚本 `scripts\diag_sealed_audit_failure.mjs`（replay 的拷贝，强制 extended）在冻结构建上复现：`recomputeDerived` 为派生复算记录参照行名时执行 `cells.find((cell) => cell.rowKey.length > 0).rowKey`，当参照行所有单元格都没有行标签时 `find` 返回 undefined → TypeError，`buildClaimAudit` 整体中断；`definitions.ts` 的 shadow 审计 catch 吞掉错误（日志未落盘），生产审稿与 Gate 正常完成。这是一处诊断字符串里的空值解引用，但后果是**整篇论文的 shadow 账本缺失**——DEV_NEW 8 个 family 都没触发。修复是一行空值保护，但修后 N05 会产出新的证书判定，属于在 SEALED 结果出来后改变候选输出，按协议留给 M15.3（与 §4.1 一起用新的 held-out 验证）。

## 6. Finding 定向复核：撤回与误降级

| 数据 | 复核结果 | 对真问题的误降级 |
|---|---|---|
| 旧 M15 已标注样本（m152w2 构建离线复核，27 次调用；model_audited 标签） | 完全反驳 0、部分反驳 9；FALSE_CROSS_UNIT 2 部分 + 1 未解决；CONVERSION_ARTIFACT 2 → UNRESOLVABLE | TRUE 标签 finding 降级 **0** |
| DEV_NEW live（72 m152 run） | REFUTED 1、PARTIALLY_REFUTED 24、CONFIRMED 80、UNRESOLVED 263、UNRESOLVABLE 5、无候选 2、超预算跳过 1 | 注入缺陷降级 0；唯一 REFUTED 见下 |
| SEALED live（21 个有账本的 m152f run） | REFUTED 0、PARTIALLY_REFUTED 4、CONFIRMED 17、UNRESOLVED 64、UNRESOLVABLE 1 | 完全撤回 0；注入缺陷降级见 §7（1 条 critical→major，仍为 C+M） |

- 唯一完全撤回（N1648BF8 r2 #47「选择性报告 mAcc」，复核以基线表 mAcc 为「-」为由 REFUTED）可疑：意见的一半（基线缺值）成立、另一半（作者自己是否报告）未回答，更合理的结果是 PARTIALLY_REFUTED。影响：shadow 中 major → minor 一条，生产不受影响。计为 **1 条可疑撤回 / 368 条复核**。
- UNRESOLVED 占多数是设计结果：复核只在模型给出可校验引文且引文含被断言缺失的术语时才改判，否则维持原状——**未解决 ≠ 降级**。
- 词面自动降级：无。所有 severity 变化都来自四轴规则，原 finding 保留。

## 7. 四轴裁决与严重度

DEV_NEW m152（72 run，7187 根因）：verification 轴 REVIEWER_GROUNDED_SUSPICION 1982、AUTHOR_CHECK_REQUIRED 1726、NOT_EVALUATED 1619、NOT_APPLICABLE_STYLE 1337、EXTERNAL_DATA_REQUIRED 486、INPUT_PARSE_UNRELIABLE 37、VERIFIED_BY_CERTIFICATE 3、DOCUMENT_CONTEXT_CONTRADICTS 1。严重度变化 10 个根因（0.14%）：critical→major 4（CRITICAL_REQUIRES_VERIFICATION；N13 原稿与 N13-V01 变体里「结论称超越 SOTA / 结果节自述 SOTA 仍更优」的原稿矛盾）、major→minor 6（N15 中文转写里的公式乱码 PARSE_UNRELIABLE_CAPPED_AT_MINOR 5 + §6 的可疑撤回 1）；其余 NO_CHANGE。blocking 0（没有任何「证书确认 + 触及核心论断」的根因）。taskScope 在只读评估中全部 NOT_APPLICABLE_READ_ONLY。

SEALED m152f（21 run，2332 根因）：AUTHOR_CHECK_REQUIRED 685、REVIEWER_GROUNDED_SUSPICION 605、NOT_APPLICABLE_STYLE 468、NOT_EVALUATED 417、EXTERNAL_DATA_REQUIRED 145、INPUT_PARSE_UNRELIABLE 12、VERIFIED_BY_CERTIFICATE 0。严重度变化 2：N16 中文转写公式残缺 major→minor 1；**N03-V01 注入缺陷（摘要 98.52 vs 正文 99.52）critical→major 1**——缺陷是真的，M15.1 视图对它出了强判，M15.2 因无证书按 CRITICAL_REQUIRES_VERIFICATION 封顶；仍是 major（C+M 检出不变），但这是一次**对已知真问题的严重度下调**，计入误降级（严重度轴）1 / 0 撤回。blocking 0。

结论：四轴裁决是**可追溯的标注层**，不是降噪器。它没有把 critical+major 数量拉下来，也不应该——在 certificate 召回这么低时，能被确定性证实的只有极少数。

## 8. G5：306→256 的性质（旧 DEV 12 案，重复采样）

base（3400f87）36 run vs M15.1 extended（f2e7804）38 run，同输入独立会话：

- critical+major / run：base 24.89（sd 7.27）vs m151 21.13（sd 8.14），差 3.8 远小于 run 间 sd。
- 已知缺陷（注入 + 原稿登记）检出：base 任何 32/33、C+M 27/33；m151 任何 34/34、C+M 28/34——**无检出丢失证据**。
- 位置根因簇（引文逐字定位、区间重叠 + 类别族），稳定簇（≥2/3 run 中为 C+M）由 Claude 子代理盲审（model_audited）：base 稳定但 m151 完全消失 15 簇（14 真 / 1 部分，合适严重度 major 10）；m151 稳定但 base 无 13 簇（10 真 / 3 部分，major 10）——两边对称。base C+M、m151 只给 minor 的 45 簇：盲审认为合适严重度 minor 32 / major 11 / none 2；反向 9 簇中 major 5。
- 结论：下降主要是**严重度收缩**（多数被收缩的项盲审也认为是 minor），检出集合在两边对称漂移，没有净召回损失证据。DEV_NEW 同口径：base 22.01 vs m152 20.01，丢失 30 / 新增 30 簇、收缩 58 / 反向 40。因此 claimStage 保持 inline，不切 separate（separate 已实现、未做 live A/B）。

## 9. 输入保真

- 中文转写 family（N15 DEV / N16 SEALED）：解析器对 CJIG 转写表能解析，但 DEV_NEW N15 成对案例 0 强判（C09 1 条弃判）；PARSE_ARTIFACT 无页面来源的 finding 直接 UNRESOLVABLE、不送模型（DEV 5 / SEALED 1）；INPUT_PARSE_UNRELIABLE 根因（DEV 37 / SEALED 12）中严重度封顶 minor 实际生效 DEV 5 / SEALED 1，全部是转写稿公式乱码类 finding——封顶合理（问题在输入保真，不在论文科学），原 finding 保留。
- 作者 LaTeX 中未解析的表格（`COUNTERPART_VALUE_IN_UNPARSED_TABLE` SEALED 7 条）走弃判，不猜。

## 10. 成本与失败恢复（ESTIMATED：in $5 / out $25 / cache read $0.5 / cache write $6.25 每 M token）

| 批次 | run | 调用（失败） | 估算 $ |
|---|---|---|---|
| 旧 DEV G5：base / m151 / m152w1 | 20 / 24 / 2 | 431 / 547 / 53 | 66.08 / 98.39 / 7.68 |
| DEV_NEW：base / m152w3 | 72 / 72 | 1953 / 2181 | 328.68 / 387.99 |
| SEALED：base / m152f | 27 / 27（各含 3 个 0 调用 harness 失败） | 651（3）/ 712（2） | 124.02 / 140.89 |
| 离线 finding 复核（m152w1 / m152w2） | — | 27 / 27 | 1.87 / 1.92 |
| **合计** | 284 | **6582**（5 次单元调用返回网关 502，如实记为失败调用） | **≈ $1157.5** |

token：output 17.0M、cache read 430M、cache write 83M，合计 529.6M；预登记上限 9000 调用 / 700M token，用量 73% / 76%。子代理审计（G5 盲审、off-site 复核、oracle 编写）不经网关、不计入上表。

失败恢复：编排器每 run 一进程；失败不自动重试、重试须显式排队并计入分母。SEALED 首轮 N12 的 6 个作业（两臂各 3）在**任何模型调用之前**失败：harness 从多行 `\title{\LARGE \bf ⏎ …}` 抽取项目标题时保留了换行，`ProjectStore.create` 拒绝。修复只在 harness（`run_job_m152.mjs` 标题空白折叠，sha256 `0714b74e…` → `ea7cd28d…`，记录 `registry\sealed_harness_deviation.json`），候选代码 / 构建 / 配置不变，6 个作业以 rep 2 显式重排、r1 失败记录保留。这是对冻结评测工具的一处偏离，已如实登记。

## 11. Shadow 与生产隔离

- `gates.ts`（blob 86e537812484df548fdd264736fb32b47fd19031）、`revisionTaskGate.ts`（b1fe280cd9c2a53eaed28411c3de8e3608334273）在 4f7139c 与 HEAD 完全相同；80/35 阈值、Major 零容忍、NOT_EVALUATED 语义不变。
- 新产物只写 `reviews/claim-audit-r{n}.json`（v2）、`reviews/finding-adjudication-r{n}.json`、QualityDecisionV2 shadow 摘要；生产 `evaluateQualityGate` 不读取它们（测试断言）。
- 回归覆盖：Revision Task Complete / Publication Ready 双结论（`test/quality/revisionTaskGate.test.ts`、`qualityDecisionV2.test.ts`）、existing_paper_improvement（作者工作流 0 次额外复核调用、shadow 产物不影响 Gate）、Fact / Citation Preservation、HITL、Style suggest_only（`stylePolish.test.ts`）、PDF Quick Review 只读——全量套件通过。
- SEALED 隔离证据：`registry\sealed_isolation_pre.json`（打开前：无 SEALED run 目录；analysis / scripts / drafts / backend src+test 中无 SEALED caseId；SEALED 文件哈希；SEALED 成对案例 id 只出现在 corpus\families\<SEALED>\oracle 与 registry\oracle_freeze.json 中）。打开顺序：冻结 20:00:17 → 93 个成对案例零模型判定 → 48 个真实 run（+6 个 harness 重排）。披露：开发方在获取阶段见过 SEALED 论文标题 / arXiv id / 许可（元数据）；未读 SEALED 正文、oracle、物化稿；SEALED 不曾进入任何模型 prompt 之外的调参上下文（真实 run 的 prompt 是被评审的论文本身，这是评测而非调参）；DEV 调试脚本拒绝 SEALED。SEALED 打开后只做诊断（§4.1、§5.1）与 model_audited 复核，未改候选代码。

## 12. 冻结记录

| 项 | 值 |
|---|---|
| 候选提交 | `22f5df708e46800f7dcc6daf9aec17ca96e0e6c1`（工作树 diff sha256 = 空串哈希） |
| 构建 | `builds\m152-final`，distSha256 `91e86ea307a50f67f48d73ef65a5275b3516da416197e4ebbd7eede7d29a2964` |
| base 臂 | `3400f87121e4a2fd026a47ac8665a1615211b24e`（QualityGateCalibration\builds\base-3400f87） |
| 模型 / 配置 | glm/claude-opus-5-5；claimAudit auto（published → extended）、claimRecheck ≤2、findingRecheck ≤3、claimStage inline、shared_session |
| 冻结文件 | `registry\candidate_freeze.json`（sha256 `2bda99e86c793d3a06b6ca7aa14a327cfbf0a163e65d6f4b00f9f392ed65b91e`，frozenAt 2026-10-22T20:00:17+08:00；含 6 个评测脚本 sha256） |
| oracle_freeze / split_lock / manifest | `6075afa4bc9a6a0e…` / `fa8dd3385f4bcc13…` / `256e1770914fcdf7…` |
| SEALED 打开前隔离记录 | `registry\sealed_isolation_pre.json`（sha256 `d5bbee4df6c1dc9e…`） |

## 13. 局限

- 强判召回极低（DEV 5/61、SEALED 1/57），且 SEALED 仍有 1 条错误强判、1 处整篇账本崩溃：claim-certificate/v1 **不能**进入任何阻断路径。
- SEALED E2E 每臂只 1 次采样；finding 层差异不足以下结论，只用于检查错误强判与降级。
- M15.1 视图是同输出零调用消融，不等价于 M15.1 独立采样。
- model_audited 标签来自 Claude 子代理，未经人工复核；本轮按约束不引入人工标注。
- 未做 PDF 输入的 E2E（中文转写以 LaTeX 化文本进入）、未做 DOCX、未做期刊校准。

## 14. M15.3 建议

1. **P0 修 SEALED 暴露的两个缺陷**：(a) `recomputeDerived` 参照行无行标签时的空值解引用，并把「单条论断证书异常」隔离为该论断 NOT_CERTIFIED（理由码 CERTIFIER_ERROR），不能让一条论断拖垮整篇账本；(b) 唯一性漏洞——论断值在其它表格单元逐字出现 → 弃判；体内重复表头块（组头 + Source / Metric 行）识别为分组；论断区分词（reproduced / fair / original）与 caption 绑定。用新的 held-out 验证，不再用本 SEALED。
2. 召回：多数弃判是 `NO_CELL_MATCHES_METRIC_AND_ROW` / `DERIVED_COLUMN_UNBOUND`——优先补表头缩写词典（MaF1 ↔ Macro-F1 等）与派生列模板，而不是放宽唯一性。
3. 原稿真问题（本轮 model_audited 15 对）多为均值 / 派生：在 derived-formula 上增加「列表均值」受控解释，仍要求唯一解释。
4. finding 复核：多部分意见拆分后逐部分判，REFUTED 需覆盖全部子断言（修 N1648BF8 类撤回）；CRITICAL_REQUIRES_VERIFICATION 在证书召回这么低时会压低真缺陷（SEALED N03-V01），M15.3 应让「模型 check + 原文双处逐字引文」也能保留 critical，或干脆不做 critical 封顶。
5. 期刊校准（M15.3 原计划）仍需人工或公开审稿意见标签；在此之前四轴继续 shadow。

## 15. 路径

- 报告：`D:\Projects\PaperTeam\docs\research\M15_2_FINDING_VERIFICATION_AND_SEVERITY.md`；状态：`D:\Projects\PaperTeam\docs\PROJECT_STATUS.md`
- 数据根：`D:\PaperTeamData\M15\M15_2`——`plan\`（执行计划 / 预登记补充）、`corpus\`（families / inputs / registry / oracle_tools）、`registry\`（arms.json、candidate_freeze.json、sealed_isolation_pre.json）、`builds\m152-final`、`experiments\runs`、`analysis\`（eval_pairs_devnew_frozen.json、eval_pairs_sealed.json、e2e_devnew_frozen.json、e2e_sealed.json、replay_m152f_devnew.json、m151view_offsite_audit_verdicts.json、g5_*.json、cost_ledger.json）
