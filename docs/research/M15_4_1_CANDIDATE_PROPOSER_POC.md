# M15.4.1 — CandidateProposer 小规模真实模型 POC（模型结构化证据候选 × 确定性核验）

- 日期：2026-10-24；基线 `03c48fc`（== origin/main，工作树 clean）。仓库交付：`backend/src/review/candidateProposer.ts`（新文件，生产路径零改动）、`backend/test/review/candidateProposer.test.ts`（19 例合成契约测试）、`scripts/m1541-{corpus,eval}.mjs`（轻量可复现 harness）、本报告。
- 全部实验原始数据/模型响应/评分产物在 `D:\PaperTeamData\M15\M15_4_1\`（仓库外，不入 Git）。预登记 `PRE_REGISTERED_PLAN.md`（sha256 `c8ddfaa1…`）在任何代码与模型调用前冻结；冻结/偏差/开封记录 `FREEZE_MANIFEST.json`。
- 模型通道：`zai-coding-cn/glm-5.3`（本机 Coding Plan 订阅，`evaluation/liveRuntime` 同源构造），prompt `candidate-proposer/v2`（v1→v2 修订一次，见 manifest）。真实调用 **46 次**（DEV 27 + held-out 19，含 2 次结构化重试），计费 token in ≈123K / out ≈12K（逐调用落盘；订阅渠道边际按量费用 0，list-price 口径合计 < $0.5）。

## 0. 一页决策卡

**裁决：PARTIAL_INTERFACING（偏正）——模型语义绑定质量在全部 4 个 held-out 家族显著胜过纯规则绑定（L1 exact 32/38 vs 8/38，约 4×），负例全过、两臂零错误强判；但提案→证书的转化是瓶颈（实验验证器 held-out 强判 2/18 < 规则基线 5/18；模型提案注入现有生产证书器 = 6/38，与 oracle 对照基线持平），瓶颈形态与预登记 PARTIAL_INTERFACING 分支完全一致（回指主语跨句、引文形式归一、空主语、派生措辞边界）。M15.4.2 应立项「事实映射验证协议」（段落域回指锚定 + 引文归一接口），不是集成，更不是放松 UNIQUE/B2/B3。**

| 项 | 结果 |
|---|---|
| ① 真实独立论文结果 | 4 个 held-out 家族（CC BY×2 + 默认许可×2，均冻结后标注）：模型 L1 exact 16/18，规则基线 7/18；模型臂 CORRECT_STRONG 2、基线 5、生产注入臂 5；WRONG_STRONG 全 0 |
| ② 新 WRONG_STRONG | **0**（两臂 × 两 split × 38 例；含错误行同值、B2 跨表、空主语、多绑定混合四类反例全被拦截） |
| ③ 模型候选 vs 证书转化漏斗 | L1 exact 32/38（84%）→ 证书 7/38（18%）；弃判主因：GROUNDING(8)、NOT_UNIQUE(7)、TERM_NOT_IN_CLAIM(6)、DERIVED 出界(5)、QUOTE(4)、其他(3) |
| ④ 成本 | 46 次调用 / in≈123K + out≈12K token / 平均 5s每例 / 订阅渠道边际 0（list < $0.5） |
| ⑤ 变更文件 | 新增 `candidateProposer.ts`(+~700 行)、`candidateProposer.test.ts`、`scripts/m1541-*.mjs`、本报告、PROJECT_STATUS；**既有源码零改动**（dist 361 文件字节级不变，仅新增 candidateProposer.js） |
| ⑥ CI | 见 §8（推送后核对） |
| ⑦ Git | 见 §8 |
| ⑧ 下一步 | **M15.4.2 = 事实映射验证协议研究**（唯一优先方向）：① 段落域回指主语的确定性锚定（前文专名引文锚 + 指代消解证据约束）② 引文形式归一（渲染文本 vs 源文 的双向定位契约）③ 派生措辞边界（"lower accuracy"类比较语境不触发 DERIVED）的词法修订。全部保持 UNIQUE/B2/B3/双钥匙不变。 |

## 1. 设计（对 M15.4.0 §8 两处修正的落地）

### 1.1 架构（全部新建文件；SHADOW_ONLY；生产 Gate/certifyClaim 不 import 本模块）

```
论断句（materialized 文档中的逐字 span + 目标值）
  → CandidateProposer prompt（句 ± 一段上下文 + 全表 allowlist 渲染：别名 T/R/C、题注、多级表头、行键、数值矩阵）
  → GLM-5.3 结构化 JSON：{subject, metric, dataset, conditions[], comparison, candidates[{tableAlias,rowAlias,colAlias,interpretation,evidenceQuotes}], abstain?, confidence?}
  → 确定性 resolve（别名→canonical (file,tableId,row,col)；值由解析器读，模型输出不含任何数值字段）
  → verifyProposal（全部确定性）：
     引文逐字定位（源文件 ∪ 模型可见渲染文本）→ term 源自论断（claim 侧）→ subject/row、metric/列、条件/表语境 grounding
     → 签名枚举唯一性（修正 A：全文档独立枚举，模型指向不删竞争者）→ 值佐证列选择（A2 化推广，仅 metric 未识别+SUPPORTED）
     → B3 限定词 → B2 跨表 → compareAtoms（修正 B：先对应后比较）→ 双钥匙
  → ProposalVerification（ACCEPTED/ABSTAIN+category；不签发 claim-certificate/v1）
```

- **修正 A（不假唯一）**：签名枚举对全文档所有数值格用与提案完全相同的 grounding 规则独立执行；>1 且值关系不一致 → `PROPOSAL_NOT_UNIQUE` 弃判。并列主语（"A and B"）拆 alternatives，多命中须**一致**（全 OVERLAP 或全 DISJOINT）才出证，混合=真歧义弃判。空主语（纯停用词）直接弃判——值碰巧相等不可证明对应。
- **修正 B（先对应后比较）**：不预要求 OVERLAP。正确格值≠正文值 + 模型 INCONSISTENT → CONTRADICTED（DEV F2-C06 实测）；错误格值=正文值在 subject grounding 处被拒（合成 N1 + DEV F2-C08 零错误强判）。
- **grounding 双通道**：token canonical 匹配（含复合词部件桥：非数字部件落 token 集、数字部件落结构原文子串——"Llama-3.3"↔行键"Llama 3.3"通，"top-1"↔"Top-3 Acc."不通）或 evidenceQuote 逐字落在该列表头/该行行键/该表题注（缩写桥 macro-F1↔MaF1 只能以表头原文形式被采纳）。条件词三分法：复合形须全部落位（Bench-R 不得借裸词 bench 落 Bench-W 表）、简单词任一落位、全域无落位的修辞词（fastest）丢弃并记录。
- **两处守卫本地复现**（B2/B3/限定词族/OWN 判别自 claimCertificate@03c48fc 复制并注明）：保证既有 dist 逐字节不变（见 §6）。

### 1.2 基线臂（历史 replay 语义）

`certifyClaim(document, {claim, counterpart=oracle 金格, check=oracleRelation 映射})`——与 M15.2–M15.3.4 完全同口径（规则绑定器独立复现 + B2/B3 + 双钥匙），可与历史 7/57、6/61 语义对照。另设第三对照（零模型后验）：同一模型 top 提案注入生产证书器（counterpart=模型格）。

## 2. 语料与冻结纪律

| 切分 | 家族（arXiv / license / 领域） | 例数 | 机械校验 |
|---|---|---|---|
| EXPOSED_DEV | F1 sleepeff 2609.22148 / default / 睡眠分期；F2 faultloc 2608.11277 / **CC BY** / 故障定位；F3 npudenoise 2605.03680 / default / 端侧去噪 | 20 | ALL PASS |
| FROZEN_HELDOUT | F4 msleep 2606.13694 / **CC BY** / 移动睡眠；F5 continuir 2608.23799 / **CC BY** / 持续学习复原；F6 vulndet 2604.19031 / default / 漏洞检测；F7 lqrs 2510.10580 / default / Spark SQL | 18 | ALL PASS |

- 家族独立性：7 家族 6 个子领域、不同第一作者；held-out 4 家族在冻结前**零模型调用、零 claim 标注**（冻结 manifest budget 记录 27 次调用全在 DEV）；标注在冻结后、预测收集前一次性完成；预测全部落盘后才 score（unseal 记录）。
- 标注协议：单人（执行代理）+ 双人规则核对由机械校验替代——CONSIST 须值+精度与金格逐字一致；CONTRADICT 须编辑值逐字注入且≠金格；每案例独立 materialized 视图（同文件多编辑互不污染）；编辑不触碰表格环境（tableId 序列零漂移）。
- 案例构成：ATOMIC-CONSIST 21、ATOMIC-CONTRADICT 9（含 B2 探针 2、错误行同值探针 1）、SCALE-PROBE 1、DERIVED-TAB 2、NO-TABLE/STRUCTURE-GAP 弃判探针 5。难点覆盖：多级表头（F5/F6）、跨表同值（F2-C02/F3-C04/F4-C03/F5-C06）、同行同值双列（F2-C04/F5-C04）、回指主语（F2-C03/F6-C03/C04/F7-C02）、指标不点名（F3-C03）、行键解析损坏（F4 全部）、巨型表 913 格（F6）。
- 偏差（FREEZE_MANIFEST 逐条）：F1 原计划 2608.04501 解包后发现是综述型（分类表+阈值句，无实验论断）→ 冻结后/零标注前替换为 2609.22148；AMBIG 自然句配额无法满足（实验论文普遍点名主语与指标）→ 由三类不可证探针+合成 N2/V2 承担；四项预冻结核验器精化（A/B/E/F，均 fail-closed 方向，逐条安全论证在代码注释）；冻结后 m1541-eval.mjs 增加零模型后验子命令（主指标已先落盘）。

## 3. 结果

### 3.1 L1——语义候选定位（提案格 vs oracle 金格；规则臂取 bindTextAtom 顶级绑定）

| 切分 | 模型臂 exact | 规则臂 exact | 规则臂 wrong |
|---|---|---|---|
| DEV（20） | **16**（另 1 parse-fail abstain、2 no-gold、1 wrong） | 1 | 0 |
| HELD-OUT（18） | **16**（2 wrong：F6-C01 提错格、F7-C03 无金格案例仍提案） | 7 | 0 |
| 合计 | **32/38 = 84%** | 8/38 = 21% | 0 |

- 规则臂从不指错（宁弃勿错），但 79% 的案例连顶级候选都给不出；模型臂在全部 4 个 held-out 家族全面胜出（F4 4:2、F5 6:4、F6 4:0、F7 2:1），包括多级表头、跨表同值、913 格巨型表。
- 模型臂 5 例 wrong 中 3 例为无金格/派生案例的「仍提案」（不产生强判），真正指错格 2 例（F6-C01、DEV F1-C04），均被验证器拦截。

### 3.2 L2——认证漏斗（38 例全口径）

| 臂 | CORRECT_STRONG | 其中 CONTRADICTED | WRONG_STRONG | ABSTAIN |
|---|---|---|---|---|
| 模型 + 实验验证器 | **7**（DEV 5 + HOLD 2） | 1（F2-C06，修正 B 路径实测） | **0** | 30（+1 parse-fail） |
| 模型提案注入生产证书器（零模型后验） | 6（DEV 1 + HOLD 5） | 0 | **0** | 31 |
| 规则基线（oracle 对照，历史口径） | 6（DEV 1 + HOLD 5） | 0 | **0** | 32 |

- 模型臂验证器弃判分类（30 例）：GROUNDING_FAILED 8（空主语 2、回指主语句外 3、行键损坏 3）、PROPOSAL_NOT_UNIQUE 7（多绑定混合/签名多命中）、TERM_NOT_IN_CLAIM 6、DERIVED_RECOMPUTE_OUT_OF_SCOPE 5、QUOTE_NOT_FOUND 4（模型重构矩阵行/截断数值）。
- 三臂互不包含：实验验证器多判了 F1-C01（值佐证跨行 A2 化）与 F5-C04（多绑定一致，生产 TIED 拒）；生产注入臂多判了 F5-C01/F5-C06/F7-C01（实验验证器 TERM_NOT_IN_CLAIM/NOT_UNIQUE 更严）；基线在 held-out 的 5 例强判与生产注入臂完全同集（这些案例模型提案==oracle）。
- 负例全过：B2 探针（F2-C07/F3-C06）正确弃判；错误行同值（F2-C08、合成 N1）零 SUPPORTED；空主语（F3-C03/F3-C04）按修正 A 弃判（值巧合不可证明对应）；SCALE-PROBE（F1-C02）按设计 SCALE_AMBIGUOUS 弃判；NO-TABLE（F3-C07/F7-C03）模型臂 1 例正确 PROPOSER_ABSTAIN + 1 例 TERM_NOT_IN_CLAIM 拦截，零强判。

### 3.3 成本

46 次真实调用（≤预登记 80 上限；每有效 claim 1 次 + 仅解析失败 1 次重试，实际重试 2 次；并发 1 ≤ 2）；input ≈122,991 + output ≈12,001 token 逐调用落盘（billing 可见）；每例平均 ~5s。订阅渠道边际按量费用 0；list-price 口径 < $0.5。每净增 1 条正确强判的调用成本 = 46/7 ≈ 6.6 次（当前验证器转化率下；若按 L1 命中算 46/32 ≈ 1.4 次）。

## 4. 机制归因（为什么证书转化是瓶颈）

1. **回指主语跨句**（TERM_NOT_IN_CLAIM 6 例的主因）：论断句写 "the same two models / this method / the model / this approach"，真主语名在前句或段落上下文。模型看得见 contextBefore 且提案正确（L1 exact），但 grounding 要求 term 出现在**句内**（防止模型发明论断里没有的概念——修正 A 的防线）。这是接口问题不是防线问题：需要「前文专名的确定性引文锚 + 指代证据约束」的验证协议，而不是放开句内检查。
2. **引文形式**（4 例）：模型引用 allowlist 渲染行时自行重构（补齐场景列、截断 1.000→1.00）。已放宽为「可对模型可见的确定性渲染文本定位」（渲染文本由解析器从源生成，模型未见过别处），剩余失败均为模型改写——fail-closed 正确。
3. **派生措辞边界**（5 例）："achieves lower accuracy…with a Top-1 accuracy of 0.800" 中比较词 lower 触发 DERIVED 继承（与生产证书器同语义），POC 的原子臂拒收。规则臂同样弃判（共享边界）。
4. **结构缺口**（F4 全家族 + F3-C08）：latexTable 对 `\_` 转义行名/数字首列的解析缺陷使行键全部坍缩——一致性可走值佐证救回（F4-C01 模型臂验证器未过但生产注入臂过），矛盾在修正 A 下不可证。属 M15.3.0 TABLE_STRUCTURE 桶（8 例）的同族问题，候选器无法弥补解析层。
5. **验证器互操作性**：模型提案注入生产证书器=6/38 与 oracle 对照基线持平且零错——说明提案质量已达到「可直接替换 oracle 对照」的可用度，收益被双份严格性（生产 B2/B3/UNIQUE + 我的实验验证器）双重折减。

## 5. 裁决对照预登记停止/成功规则

- STOP/ROLLBACK：未触发（无新增 WRONG_STRONG；无提案被当作已验证事实；生产路径字节不变；防线未削弱；held-out 未复用）。
- GO_TO_M15_4_2 四条件：≥2 heldout 家族 L1 明确增益 ✓（4/4）；负例全过 ✓；WRONG_STRONG=0 ✓；成本合理 ✓；**净增强判 ✗**（实验验证器 held-out 2<5；生产注入 6=6）。"明显提高的候选覆盖"字面成立（32 vs 8），但可证强判未增——按预登记 PARTIAL_INTERFACING 分支的原始定义（"模型显著找对候选但证书器仍弃判占主导、且没有可以独立证实的语义等价关系；后续应研究事实映射验证协议，不要靠取消 UNIQUE/B2/B3 等防线刷绿"）裁决为 **PARTIAL_INTERFACING（偏正）**。
- 之所以不是 GO：把 L1 覆盖直接当 GO 会把「提案≠证书」的缺口带进集成；之所以不是 NO_GO：模型候选质量在独立家族上 4× 增益且零错误强判，方向明确成立。

## 6. 回归与不变性（替代不可得的 191 例回放）

旧 SEALED/DEV_NEW/FROZEN_NEW 语料在公司电脑、本机不可得（如实记录）。替代证据链：①本轮**既有源码零改动**——`claimCertificate.ts`/`latexTable.ts`/`claimAudit.ts` 源码 sha256 与 M15.3.4 记录一致（`099a89e3…`/`de5529db…`/`94209b5c…`），重建 dist 后 361 个既有 .js/.d.ts **逐字节不变**（仅新增 candidateProposer.js）；②既有证书套件全绿（claimCertificate 49 + SemanticBinding 15 + CrossTable 等，含 N09-P05 B2/B3 与 N09-P12 双钥匙锚的合成等价物）；③candidateProposer 19/19 合成契约测试（解析/别名/引文/术语/唯一性/B2/B3/单位/双钥匙/值佐证/多绑定/派生/重试全通道）。SHADOW_ONLY 不变：gates.ts/revisionTaskGate.ts/Academic Score 未动。

## 7. 局限

1. 单人标注（执行代理）+ 机械校验替代双人核对；`automated_truth` 口径非人工金标准（沿 M15.2 先例如实标注）。
2. 38 例规模按任务书下限设计；held-out 18 例中 F6/F7 家族材料偏薄（F6 巨型表难例集中、F7 可用原子句仅 2）；样本量不支持族间显著性检验，只支持逐例可复核证据。
3. 实验验证器与生产证书器是两套严格性，L2 三臂对比反映的是「接口+验证器」组合效应；生产注入臂部分消解但未完全分离。
4. COST：订阅渠道实际边际 0，list-price 为估算口径；`billingVisible=yes`（usage 逐调用可查）。
5. Windows 本机全量测试的既有满载计时闪失风险见 §8（逐文件复验）。

## 8. 测试 / Git / CI

- 定向：candidateProposer 19/19；claimCertificate 49/49；claimCertificateSemanticBinding 15/15；claimCertificateCrossTable 全过；backend typecheck/build 通过；dist 字节不变性见 §6。
- 本机全量：见提交信息与 CI（最终权威）；满负载计时类闪失按先例逐文件复验。
- Git：提交于 main（新增文件 + docs；既有文件零改动）；push origin main 后核对 CI / Linux Integration 实际结论（若网络波动/未完成如实补记）。

## 9. 仓库外审计产物（manifest + sha 见 FREEZE_MANIFEST.json）

`PRE_REGISTERED_PLAN.md`（c8ddfaa1…）、`FREEZE_MANIFEST.json`、`candidates/`（7 家族源码+sha）、`corpus/`（7×cases+provenance）、`materialized/`（编辑案例逐案例副本）、`runs/propose/`（38 份 RawProposal+ResolvedProposal+verification+usage+rawTexts）、`runs/baseline/`、`runs/model-via-production/`、`runs/score-*.json`、`probe_suitability.mjs`、`find_pairs.py`、`dbg1-6.mjs`（调试脚本留档）。敏感原文与模型原始输出仅存此处，不入 Git。
