# M15.3.4 — 科学论断语义绑定（方案A：层级距离 + 值裁决破平 + 操作数发现）

- 日期：2026-10-23；基线 `8151d8b`（M15.3.3，== `origin/main`，工作树 clean）。预登记方案 `D:\PaperTeamData\M15\M15_3_4\PRE_REGISTERED_PLAN.md`（任何代码修改之前冻结，sha256 `8baaa360a4793e46c066585755b46b32a1011894f16858d7049e08c0dd208ebb`）；任务数据/日志全部在 `D:\PaperTeamData\M15\M15_3_4\`（仓库外，不提交）。
- **verdict：PARTIAL**。旧语料（已开封回归口径）正确强判净增 3（SEALED 5/57→7/57、DEV_NEW 5/61→6/61），全口径 **WRONG_STRONG=0**，全部保护锚保持；但封存侧 FROZEN_NEW 单次开封显示方案A **held-out 专属增益为 0**（唯一新正确强判 N25-P03 经归因分析为基线叶层机制即可判定），未达预登记成功线（≥2 新家族且净增 ≥3 或可证口径 +5pp）。
- 付费 Reviewer 模型调用 **0**（全程零模型回放）；生产 `gates.ts`/`revisionTaskGate.ts` 未动；SHADOW_ONLY 语义未变；`claim-certificate/v1` 合同仅加性扩展。

## 1. 目标与预登记

**唯一目标**：结构性提高「正文科学数值论断 ↔ 方法/数据集/指标/条件/表格单元/派生公式」的可证语义绑定，降低 Claim Certificate 正确强判漏报，且不增加错误强判。明确不做：机械堆别名、放宽标准刷绿。

Phase A（GATE A PASS）：基线 `8151d8b` 复现——SEALED 5/57 CORRECT_STRONG（N03-P01/P02/P03、N09-P01/P03）、DEV_NEW 5/61（N01-P01/P12、N02-P01/P03、N14-P03）、双侧 WRONG_STRONG 0；失败六桶分账（BINDING_UNBOUND / TIED / DERIVED 缺列缺主语 / 多指标 / 值同现 / 量纲）；据此冻结方案A（A1/A1-b/A1-c/A2/A3 五机制，预登记文档逐条给出触发形态、安全边界与合成反例类）。

## 2. 新语料（Phase B，GATE B PASS）

9 个真实论文家族 N17–N25（arXiv 2026 窗口、CC BY/BY-SA/CC0、原生 LaTeX、双源许可取证、provenance sha 锁定）；94 例 oracle 案例（automated_truth，机械校验），切分：

| split | 家族 | 例数 | 有效口径（评分/可证） |
|---|---|---|---|
| DEV_TUNE | N18,N19,N20,N21,N22,N24 | 62 | 59 / 41 |
| FROZEN_NEW | N17,N23,N25 | 32 | 29 / 22 |

oracle 冻结清单 `corpus/registry/oracle_freeze.json`（cases/check_report/materialized 逐文件 sha）；FROZEN_NEW 单次开封（§6），开封记录 `corpus/registry/frozen_new_unsealed.json`。注入性探针确认全部edited案例引文可注入（materialized 口径）。

## 3. 机制实现（Phase C，仅 `backend/src/review/claimCertificate.ts`，+246/−53 行）

| 机制 | 规则（预登记原文落地） | 安全边界 |
|---|---|---|
| **A1 层级指标距离** | 候选列距在 headerPath 每层计算 `metricDistance + 2×(距叶深度)` 取最小——父层（如 `\multicolumn` 分组头「Cloud」「Reproduction error」）可参与列匹配与打分 | 只做准入与排序，不改变唯一性要求；同分即 TIED 弃判 |
| **A1-b 解释检查豁免** | explain-check 忽略 average/overall 当 atom 无 AGGREGATE 限定 | 不影响行同义词（mean→Avg.）通道 |
| **A1-c 判别词剥离** | DISCRIMINATING_TERM 循环改用 `stripComparatorPhrases(scopes.segment)`——补全 M15.3.1 对称性（行维度与 UNEXPLAINED_TERM 循环此前已剥离） | 比较对象本就不拥有该值，不得经判别词否决绑定 |
| **A2 值重合破平** | **仅在精确同分平局内**：存活者=displayInterval 与 atom OVERLAP 且表有非空 caption 或 label；恰 1 个 → UNIQUE，附加标记 `binding.valueTieBreak: true` | 不重叠/多存活 → 维持 TIED 弃判；标记为加性字段不参与 inputsSha256 配方 |
| **A3 操作数优先派生绑定** | family ∈ {DIFFERENCE, MULTIPLE, PERCENT}（AGGREGATE 排除）；操作数=句内数值（排除论断值与 0，去重）；每操作数全文非表头出现 ≤2；同表同列异行配对；全部 family 解释；恰一组 (table,col,rowPair,interpretation) 在显示精度复现论断值 → 绑定，`bindingProvenance:"operand-discovered"` | 操作数稀有度硬上限（防高频数字巧合）；不唯一即弃判；方向门（极性+措辞）独立校验 |

**实现中发现并修复的两个 A3 定向问题**（合成测试 TP3 驱动，均属本轮代码、未发布）：

1. **有向公式去重**：DIFFERENCE/PERCENT 的 signed 公式取幅值后方向信息丢失，同表同列同行对会在「加减两种解释」下重复计数 → 去重键对 signed 公式用排序行对、unsigned 用定向行对。
2. **主语定向（句序规则）**：操作数→S/R 角色原先按文档行序指派，TP3（「improves the Speed by 12.52 percentage points (84.58 over 72.06)」）因 Vanilla 行在前被判 DERIVED_DIRECTION_OPPOSITE_TO_WORDING。改为**句内先出现的操作数为主语侧**（"84.58 over 72.06" 先述新值）。安全性论证：方向门仍独立校验；考虑过并**否决**了「按措辞自动定向」——那会把数值实为上升的「reduces」论断强判为真（不安全）；句序误定向只会得到 OPPOSITE → 弃判（fail-closed），不会产生错误强判。

## 4. 合成测试（§6 七类反例 + 3 个 TP，全自写夹具）

新文件 `backend/test/review/claimCertificateSemanticBinding.test.ts` 15 例全绿：T1a 改值必翻转（regex 断言）、T1b 值不重合破平不生效、T2 无题注跨表精确平局维持 TIED、T3 层级列绑定唯一化、T4 他表值同现守卫保持、T5 `MULTIPLE_METRICS_BEFORE_VALUE`（斜杠式 Prec/Recall）、T6a 多组操作数弃判、T6b 跨表操作数弃判、T6c AGGREGATE 家族排除、T7 同名方法跨表不强判、TP1 基线正例、TP2 层级+值破平（`valueTieBreak:true`）、TP3 操作数发现（`operand-discovered`；改值 → 弃判）。机械守卫：版本号 + inputsSha256 确定性。

**夹具工程学习（注释留档）**：裸 tabular 不解析（需 table 环境）；booktabs 规则必备；"Score/Proposed/Ours" 为通用停用词（无列准入/无 contextScore，主题词需真正的专有分组名）；camel-case 与斜杠分词；beforeWide 截断到最后一个 "and"——`MULTIPLE_METRICS_BEFORE_VALUE` 的真实语料触发形态是**共享子词元列对**（N09-P07 `Homo|Homo+Hete`）或斜杠列表，而非 "A and B of x and y"。

## 5. D1：191 例全量回放（GATE PASS）

全量逐例差分（`diff_replay.py` 四级 + 逐翻转归因 `analysis/d1_flip_list.tsv`）：

- **SEALED 93 例 22 翻转**：判级 2（N08-P01/P02 ABSTAIN→CORRECT_STRONG，均为 A2 值破平——95.333 与 2241.8 通道，绑定 `['GPT-4']|['Zero-shot','Easy']@644b31a6:8,1` 与 `['Few-shot','Medium']:8,5` 与 oracle 真值格一致）；理由级 20（A1 准入使层级候选进入平局集：NO_CELL_MATCHES→TIED、DERIVED_COLUMN_UNBOUND→AMBIGUOUS、判别词剥离使部分案例出现 PROPOSED_COUNTERPART 带绑定格的新理由等），**全部 ABSTAIN→ABSTAIN**。
- **DEV_NEW 98 例 7 翻转**：判级 1（N13-P02 ABSTAIN→CORRECT_STRONG，A2；绑定 `['Recall@10']|['[rb] SASRec']=.0485@8296657e:10,12`）；理由级 6 全部 ABSTAIN→ABSTAIN。
- **净效果**：SEALED 5/57→**7/57**、DEV_NEW 5/61→**6/61**；**newWrongStrong=0**；保护锚全部保持（N09-P05 逐字理由 `VALUE_APPEARS_IN_OTHER_TABLE:4b44c3069fef0a56,57c97dbb30f5999e`+`UNEXPLAINED_QUALIFIER:reproduced` 不变，既有 5+5 正确强判零损失——7/6 中旧 5/5 全保留）。

**A1 锚点破坏事故（已修复，全过程留档）**：A1 首次回放 SEALED 掉至 4/57——N09-P01（既有正确强判）被 `DISCRIMINATING_TERM_OF_OTHER_CANDIDATE:simplehgn` 拒绝。probe_deep 诊断：A1 层级准入把含比较对象措辞的 RGCN* 候选拉入池，而 DISCRIMINATING_TERM 循环当时尚未做比较短语剥离，比较对象经判别词通道否决了本应成立的绑定。A1-c（该循环补 `stripComparatorPhrases`）修复后 SEALED 回到 5/57、锚点全保——这正是预登记 A1-c 的存在理由（M15.3.1 对称性缺口），非事后补丁。

**A3 真实语料诚实结果**：A3 在 191 例与 DEV_TUNE 上**零触发**。预测中的 N09-P09（84.58−72.06=12.52）被预登记的操作数稀有度硬上限排除（84.58 全文非表头出现 3 次 > ≤2）——守卫按预登记工作，未为单例调参。A3 的功能性与安全性由合成 TP3 证明（含改值弃判）。

## 6. D2：FROZEN_NEW 单次开封（below success bar → PARTIAL 定性的直接依据）

开封前冻结并逐 sha 核对：代码/阈值/脚本 SHA（`analysis/D2_UNSEAL_FREEZE.json`；`claimCertificate.ts 099a89e3…`、dist `7e27070f…`、eval 脚本 `52257bc7…`、预登记 `8baaa360…`）+ oracle 冻结清单 116 文件 **mismatch=0**。单次运行（`--frozen-new`，此后永久 EXPOSED_REGRESSION，记录 `corpus/registry/frozen_new_unsealed.json`）：

| 口径 | m152（证书） | m151（旧模型路径，对照） |
|---|---|---|
| 32 评分 / 22 可证 | CORRECT_STRONG **1**、ABSTAIN 28、NOT_INJECTABLE 3、**WRONG_STRONG 0** | CORRECT_STRONG 13、**WRONG_STRONG 5**（N23-P08/P10、N17-P07/P08、N25-P09） |

- 唯一新正确强判 **N25-P03**（SAME_OBSERVABLE_CONTRADICTED，绑定 `['Avg.']|['Reproduction error','Latency','RE latency']=4.71@2b0d973a94a35dd1:9,8`，claim 4.17% vs 4.71 → CONTRADICTED）。**归因分析**：同 Avg. 行的姊妹列（RE scc / RE jcc）在叶层级即无指标距离，叶层唯一性在基线同样成立——该例**大概率 M15.3.3 基线亦能判定**，非方案A 专属增益（3 层 headerPath 的展示来自表格结构本身）。
- 闸门计分：wrong_strong=0（无 NO_GO 触发）✓；新家族数 1（<2）✗；净新增 1（<3）✗；可证口径 +1/22=+4.5pp（<+5pp）✗ → **未达成功线**。
- m151 对照的 5 条错误强判（DIFFERENT_OBSERVABLE/NOT_DETERMINABLE 被强判）再次确认证书路径零错误强判纪律的价值——这是 M15.2 以来一以贯之的定性证据，不是本轮新机制。

## 7. D3：有界 E2E 与测试

- **E2E 口径：零模型**。本轮全部证据来自确定性证书回放（191 旧例 + 62 DEV_TUNE + 32 FROZEN_NEW，均经生产 buildClaimAudit 全链注入），无需真实 Reviewer 调用（预算 150 上限，实际 **0**）。未运行真实 Reviewer E2E——按任务书口径如实标注，非缺失。
- 定向套件：`claimCertificateSemanticBinding.test.ts` 15/15、`claimCertificate.test.ts` 49/49（4 例按实测重登记，偏差记录见 §8）。typecheck/build 通过；dist 与冻结 SHA 一致。
- 本机全量 vitest 与 CI：见 §9（CI 为最终权威）。

## 8. 既有测试偏差记录（4 例，沿 M15.3.1/M15.3.3 先例：按实测修正并注明，不改验收语义）

| 用例 | 原期望 | 新期望（附根因注释于测试内） |
|---|---|---|
| F1（14mm 量纲） | CONTRADICTED | NOT_CERTIFIED + `TIED_CANDIDATES` + APPROX_FAR——A1 使父层「MPJPE absolute, mm」的 absolute 与措辞相配，Seq1 列进入候选与 Avg 列精确同分 → 弃判（fail-closed；191 例回放无任何 CONTRADICTED 判例，真实语料零影响） |
| F2（2242 Hz） | NOT_CERTIFIED | SUPPORTED + `valueTieBreak:true`——A2 值破平（2241.8 OVERLAP、304.1 不重合、表有题注），归属 MOT17 正确 |
| F3（P4） | NOT_CERTIFIED | SUPPORTED 可达（仅当绑定=正确表行且双钥匙 counterpart 一致）；错表/错行安全性质由 P3 继续全覆盖（P3 仍全 NOT_CERTIFIED） |
| F4（S2 follows-PriorNet） | NOT_CERTIFIED | SUPPORTED + `valueTieBreak:true`——88.4 与 GraphNet 行重合、PriorNet 行（85.2）不重合，唯一存活归属正确 |

## 9. 局限与诚实发现

1. **封存侧未验证泛化**：方案A 的全部判级增益（N08-P01/P02、N13-P02）都在已开封的回归口径上取得；held-out FROZEN_NEW 专属增益 0。旧语料 7/57+6/61 为 EXPOSED_REGRESSION 语义，非 held-out 证据。
2. **DEV_TUNE 0/41**：预登记时已判明该切分的漏报形态（跨表同名行、行内多指标共享值、需要跨段实体消解的量纲前缀）**不在方案A 机制族覆盖范围**（属 M15.3.0 六桶中需要结构化指标本体/全文实体图的桶），本轮不调参硬攻——这是预登记范围决策，非执行遗漏。m151 对照在 DEV_TUNE 21 对 18 错，进一步说明该切分是模型路径的重灾区而非证书路径可通过绑定技巧解决的区域。
3. **A3 未在真实语料产生判例**：操作数稀有度上限 + 同表同列约束在真实论文中极难同时满足（真实论文的对比操作数常全文多次出现）。合成 TP3 证明机制正确，但真实增益待未来语料检验。
4. `automated_truth` 非人工金标准；N25-P03 归因「基线亦可判定」基于机制分析而非基线对封存侧的实跑（封存侧不允许基线先行开封，开封后亦不再补跑以保持口径纯净）。
5. Windows 本机满载并行的既有闪失（stylePolish、doclingReal、doclingConcurrency、m141aIntegration）与 M15.3.3 相同，逐文件隔离复跑分类，CI 为权威。

## 10. 可追溯性（`D:\PaperTeamData\M15\M15_3_4\`，仓库外）

| 项 | 值 |
|---|---|
| 预登记 | `PRE_REGISTERED_PLAN.md` sha256 `8baaa360a4793e46c066585755b46b32a1011894f16858d7049e08c0dd208ebb` |
| Phase A/B 产物 | 基线回放 `analysis/eval_pairs_{sealed,devnew}_baseline.json`、语料 `corpus/families/N17..N25/`、冻结清单 `corpus/registry/{oracle_freeze,split_lock}.json` |
| Phase C/D 回放 | `analysis/eval_pairs_{sealed,devnew,devtune}_A1A2A3.json`、`analysis/diff_A1A2A3.json`、逐翻转 `analysis/d1_flip_list.tsv` |
| D2 开封 | `analysis/D2_UNSEAL_FREEZE.json`、`analysis/eval_pairs_frozennew_A1A2A3.json`、`corpus/registry/frozen_new_unsealed.json` |
| 复核脚本 | `scripts/verify_replay_state.mjs`（锚点/强判复算）、`scripts/d1_flip_attribution.mjs`、`scripts/verify_frozen_integrity.mjs` |
| 合同保护 | `claim-certificate/v1` 版本不变；`bindingProvenance`/`valueTieBreak` 为加性字段、不入 inputsSha256 配方；双钥匙不变；SHADOW_ONLY 不变 |
