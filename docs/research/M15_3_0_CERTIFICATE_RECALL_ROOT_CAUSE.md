# M15.3.0 — Claim Certificate 低召回根因分析与下一步单点选择

- 日期：2026-10-23；基线 `778f2b7`（== `origin/main`，工作树干净；`backend/dist` 构建于 2026-10-23 11:50，与 M15.2.1 回归重放同源）。
- 性质：**只读调查 + 研究报告**。零付费模型调用、零真实 E2E、零源码/测试/阈值改动；分析脚本与全部中间产物在 `D:\PaperTeamData\M15\M15_3_0\`（仓库外，不入 Git）。翻转判定 = 零模型探针（导入现有 dist 的 `bindTextAtom`/`locateAtom`/`recomputeDerived`）逐例取证 + 管线规则手工推演；**未改动代码重跑**。

## 1. 一句话裁决

**GO_ONE_FIX** — 下一步只做一个点（M15.3.1，本轮不实施）：在 `bindTextAtom` 可解释性检查里，对窗口先做既有的 `stripComparatorPhrases` 再取 `distinctiveTerms`（`backend/src/review/claimCertificate.ts` ~L647，约 3 行），消除"比较对象方法名"造成的 `UNEXPLAINED_TERM` 误拒。

## 2. 数据范围与分母（口径隔离）

| 项 | 值 | 说明 |
|---|---|---|
| 数据集 | M15.2 冻结对偶案例，M15.2.1 EXPOSED_REGRESSION 重放结果 | 注入式 pair-case 模拟（oracle 提案作为单元论断），**非真实 E2E**；SEALED 已开封，不宣称 held-out |
| 真值 | `automated_truth`（oracle `cases.json`，机械校验） | model_audited 不作本轮证据 |
| SEALED | 93 计分 = 57 可证 + 36 非可证 | 可证 57 = 24 SAME_CONSISTENT + 14 SAME_CONTRADICTED + 10 DERIVED_CONSISTENT + 9 DERIVED_CONTRADICTED |
| SEALED 强判 | **1 正确强判**（N03-P02，VS）+ 0 错误强判；56 未强判 | M15.2.1 修复后状态；召回 1/57 = 1.75% |
| 56 未强判 | REVIEWER_CONSISTENT 30 / REVIEWER_SUSPECTED 22 / **NOT_INJECTABLE 4**（N04-P01/P02/P03/P07，claimQuote 跨修订单元边界，注入层失败 ≠ 核验器拒绝） | 核验器层分母 = 53（1 强 / 52 拒） |
| DEV_NEW（对照） | 98 计分 = 61 可证；5 正确强判 + 56 未强判（含 5 NOT_INJECTABLE） | 用于交叉验证修复方向不伤 DEV |

## 3. 56 例归因（SEALED 未强判，可证口径）

### 3.1 主理由码（互斥，取证书理由码第一层）

| 主理由码 | n | 案例 |
|---|---|---|
| BINDING_UNBOUND:NO_CELL_MATCHES_METRIC_AND_ROW | 17 | N03-P01/P03/P07/P11, N05-P02, N07-P01/P03, N08-P01/P02/P08/P10/P11, N12-P02/P03/P11, N16-P01/P03 |
| DERIVED_COLUMN_UNBOUND | 12 | N03-P08, N04-P08, N05-P07/P08/P10/P11, N07-P08, N08-P03/P12, N09-P09, N12-P04, N16-P06 |
| BINDING_AMBIGUOUS:UNEXPLAINED_CONTEXT | 6 | N09-P01/P02/P03/P08, N07-P02/P11 |
| BINDING_AMBIGUOUS:TIED_CANDIDATES | 5 | N07-P10, N08-P04, N16-P02/P04/P10 |
| COUNTERPART_*（值不在对端格/不可解析/表未解析/是派生量） | 7 | N03-P10, N05-P01/P03/P09, N07-P07, N12-P01/P06 |
| NOT_INJECTABLE（注入层，单列） | 4 | N04-P01/P02/P03/P07 |
| DERIVED 其他（COLUMN/SUBJECT_AMBIGUOUS） | 2 | N08-P09, N09-P10 |
| CLAIM_VALUE_NOT_IN_SPAN / PROPOSED_COUNTERPART_NOT_UNIQUE / QUALIFIER_INEQUALITY | 各 1 | N12-P05 / N09-P12 / N07-P09 |

（多标签不互斥：账本理由码可同现，如 N07-P09 = INEQUALITY + BINDING_UNBOUND。上表按每例第一理由码互斥分账，合计 56。）

### 3.2 工程根因桶（互斥主归属 + 逐例探针判定）

| 工程根因桶 | n | 案例 | 判定依据（探针） |
|---|---|---|---|
| **METRIC_ROW_BINDING**（指标列/行绑定语义缺口） | **22** | 缩写词典缺失 4：N03-P01/P03/P07（表叶 `OA` vs 论断 "accuracy"）、N07-P01（`EM` vs "exact match"）；论断不点名指标 12：N08-P01/P02/P03/P08/P10/P11/P12、N05-P02、N07-P03/P09、N03-P11、N12-P11；多级表头非指标叶 2：N12-P02/P03（指标 `success rates` 在顶层，叶 = `n = 1400`/`20`）；**比较对象短语误拒 2：N09-P01/P03**（见 §4）；限定词 subset 误拒 2：N07-P02/P11 | top 绑定或真值单元格已逐例核出 |
| **DERIVED_CALCULATION**（派生路径绑定/复算语义不足） | **15** | N12-P04, N04-P08, N09-P09/P10, N03-P08/P10, N05-P07/P08/P09/P10/P11, N07-P07/P08, N08-P09, N12-P06 | 多为论断不点名派生量指标（"+12.52"、"10x less"、"5.3 points"）或对端本身是均值/份额（N09-P12 类外） |
| **TABLE_STRUCTURE**（表格转写/多级结构缺陷） | **8** | N16-P01/P02/P03/P04/P06/P10（转写表头为数字叶、rowKey 空）、N05-P01/P03（对端表 headerPath=['Dev','36.8',…] 数值叶） | 真值单元格所在表解析即 garbled |
| **GENUINE_AMBIGUITY**（本质歧义/正确弃判） | **5** | N07-P10（2.9 同时匹配 2.86/2.91）、N08-P04（跨两表平分）、N09-P02/P08（值前多指标）、N09-P12（唯一绑定 0.058 ≠ 提案对端，双钥匙防线正确拒绝） | 弃判是设计内正确行为 |
| **PARSER_OR_INPUT_GAP**（注入/定位层） | **6** | N04-P01/P02/P03/P07（NOT_INJECTABLE）、N12-P01（对端 span 内同值两格）、N12-P05（论断值定位失败） | 非核验器语义问题 |
| 合计 | **56** | | |

### 3.3 核心结论

低召回**不是单一 bug**：56 例中真正"可修误拒"约 4 例（比较对象 2 + subset 限定词 2），缩写词典可再救 2–4 例但有平分风险，其余 ~46 例是指标命名习惯（论文行文不重复指标名）、派生量语义、表格转写质量的**长尾**——M15.2.1"宁弃勿错"的设计在这些面上表现为系统性保守。因此下一步选**风险可枚举**的最小修复，而不是追案例数最大的方向。

## 4. 代表案例（证据摘录）

**N09-P01（可修误拒 → 修复后正确 VS）**。论断窗口：`On DBLP, RGCN obtains 94.65 Macro-F1 and 95.00 Micro-F1, outperforming the second-best SimpleHGN`。拒绝码 `UNEXPLAINED_TERM:SimpleHGN`——但 SimpleHGN 位于比较短语内，属行维语义（已被 `stripComparatorPhrases` 处理的同一语义），不应计入列绑定解释检查。top 候选 a38b… `['RGCN']|['DBLP','Macro-F1'] = 94.65`（评分 [99,2,3] 唯一最大）；论断值 = 单元格值 → B2（只拦值不一致出证）不触发；UNIQUE → check=CONSISTENT → 正确 `VERIFIED_SUPPORTED`。

**N09-P03（可修误拒 → 修复后正确 VC）**。窗口 `…again surpassing SimpleHGN, which…`，同样 `UNEXPLAINED_TERM:SimpleHGN`。真值格 a38b… `['RGCN']|['Freebase','Macro-F1'] = 48.20`；46.20 在其余表格**零命中**（探针枚举验证）→ B2 不触发；值不相交 + check=INCONSISTENT → 正确 `VERIFIED_CONTRADICTED`。

**N09-P05（回归锚，不翻）**：论断无比教短语 → 剥离为 no-op；B3 `UNEXPLAINED_QUALIFIER:reproduced`（segmentContext 检查）+ B2 保持原拒绝。

**N09-P12（正确弃判示例）**：`accounting for 58.3% of the total performance improvement` 唯一绑定到 `['Homophily H']|['Total Effect'] = 0.058`（数值巧合）≠ 模型提案对端 → `PROPOSED_COUNTERPART_IS_NOT_THE_UNIQUE_BINDING` 正确拒绝——份额类概念不可单元格出证。

**翻转全集枚举（191 计分行）**：全部 `UNEXPLAINED_CONTEXT` 行 = SEALED 8（N09-P01/P02/P03/P04/P05/P08、N07-P02/P11）+ DEV_NEW 1（N02-P13）。其中唯一拒绝码落在比较短语内的只有 N09-P01/P03；N09-P02/P08/P04 有 MULTIPLE_METRICS / B2 存活，N09-P05/N07-P02/P11/N02-P13 是 QUALIFIER 类（segmentContext）。**预期翻转恰为 2，且均正确；DEV_NEW 0 翻转（其 12 个 BINDING_AMBIGUOUS 全部是 TIED_CANDIDATES）。**

## 5. 候选改进对比

| 候选 | 预期收益 | 风险面 | 结论 |
|---|---|---|---|
| **A. 比较对象短语剥离（UNEXPLAINED_TERM 窗口一致性）** | SEALED +2（N09-P01→VS、N09-P03→VC），召回 1/57→3/57；DEV_NEW ±0 | 翻转全集可枚举（恰 2 例，已逐例手工验证）；复用既有 `stripComparatorPhrases`，不触碰 top 候选选择、UNIQUE、B2、B3、metricDistance、QUALIFIER（segmentContext） | **选它（M15.3.1）** |
| B. 指标缩写词典（oa↔accuracy、em↔exact match、r↔recall、maf1↔macro-f1…） | SEALED +2~4（N03-P01/P03/P07、N07-P01）；DEV_NEW 行侧数据集缩写（CB/BV/SC2）另计 | 候选池全局扩张：需全 191 例 diff；N03-P07 可能转 TIED；**与 A 负交互**——maf1↔macro-f1 会使复现表 `['RGCN']|['SimpleHGN','DBLP','MaF1']` 成为 N09-P01 竞争者，重新平分并摧毁 A 的收益 | 推迟 M15.3.2（A 之后单独回归） |
| C. subset 类限定词解释（'non-ambiguous subset' ↔ 行 `Non-Ambig. Question`） | +1~2（N07-P02→VS；N07-P11 修后 0.916 vs 91.6 → 正确 VC） | 限定词防线属 B3 同族，语义面窄但需新增解释机制 | 暂缓（NO_GO 本轮） |
| D. 表格转写/多级表头（N16/N05/N12 桶，15 例） | 潜在最大 | 解析器工程量大、扰动面广 | 不属微迭代 |

不做的清单（预先承诺）：不放宽 UNIQUE 条件、不绕过 VALUE_APPEARS_IN_OTHER_TABLE、不删限定词防线换召回。

## 6. M15.3.1 假设（仅设计，本轮不实施）

**假设**：`bindTextAtom` 可解释性循环中，`distinctiveTerms(plainLatexText(scopes.window))`（claimCertificate.ts ~L647）改为 `distinctiveTerms(plainLatexText(stripComparatorPhrases(scopes.window)))`，与行维绑定已使用的同一剥离保持一致；其余路径零改动。预期 SEALED 恰翻 2 例（均正确强判）、DEV_NEW 零变化、既有 6 条正确强判零损失。

**预注册停止/验收条件（≤5）**：
1. 零模型 EXPOSED_REGRESSION（同 harness，重建 dist）：191 行翻转全集必须恰为 {N09-P01→VS、N09-P03→VC}（SEALED）∪ ∅（DEV_NEW）；任何额外翻转先停并归因。
2. 任一侧出现错误强判 > 0 → 立即中止回退，不叠加规则硬凑收益。
3. N09-P05 保持 NOT_CERTIFIED 且 B2/B3 理由码不变。
4. 既有正确强判零损失（SEALED N03-P02；DEV_NEW N01-P01/N01-P12/N14-P03/N02-P01/N02-P03）。
5. 若收益为 0 或引入新拒绝模式 → 放弃该方向（不扩词典、不加特判）。

## 7. 局限

- 结果基于已开封 SEALED（EXPOSED_REGRESSION 语义），**不构成泛化声明**；泛化需另行作者隔离的新冻结 held-out。
- 翻转判定为"探针取证 + 规则手工推演"，非改动后实测；§6 条件 1 即为实测闸门。
- 自动真值（automated_truth）非人工金标准；DIFFERENT_OBSERVABLE/NOT_DETERMINABLE 未计入分母（按定义不可证）。
- 本轮不覆盖 journal 分数校准、PDF 多格式解析、M15.3 完整路线图。

## 附录 A：分析产物（仓库外 `D:\PaperTeamData\M15\M15_3_0\`）

`per_case_index.py` + `per_case_index_{sealed,devnew}.json`（逐例索引）、`aggregate_reasons.json`、`sealed_primary_buckets.json`、`probe_case.mjs`/`probe_devnew.mjs`（零模型探针）、`probe_bucket1*.txt`/`probe_bucket2/3/4.txt`/`probe_devnew_unbound.txt`（逐例绑定证据摘录）。
