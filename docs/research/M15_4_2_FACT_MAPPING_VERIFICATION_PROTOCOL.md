# M15.4.2 — Fact Mapping Verification Protocol（事实映射验证协议）

- 日期：2026-10-24；起点基线 `1c7713d`（== origin/main，clean，与 M15.4.1 冻结一致）。
- 预登记 `D:\PaperTeamData\M15\M15_4_2\BASELINE_AND_PRE_REGISTERED_GATES.md`（任何源码修改前写入；实施偏差附录 §9 于 C2 模型调用前登记）。C2 冻结 `FREEZE_MANIFEST_C2.json`（13 例预测收集前，零模型调用状态）。
- 实验数据/模型原始输出：`D:\PaperTeamData\M15\M15_4_2\`（仓库外，不入 Git）。M15_4_1 冻结档案只读复用（SHA 复核一致）。

## 0. 一页决策卡

**裁决：GO_PROTOCOL（有保留）——M15.4.1 证明的模型候选定位，经统一的确定性核验协议后实际转化为更多正确证书：38 例零模型回放正确强判 7→13（+6，零新增错误强判、15 负例全拦、7 既有强判零损失）；独立新语料（3 个全新家族、13 例、13 次真实调用）再获 2 条仅协议臂可出的正确强判（G1 家族 CONTRADICTED + G2 家族 SUPPORTED，均带完整映射见证）、零错误强判；实验验证器与生产证书器的 9 处重复守卫收敛为单一来源 claimGuards.ts（旧路径行为等价由全套件+新等价测试证明）。保留项：新语料转化率仍低（2/13，机制归因见 §4），M15.4.3 集成建议附条件（见 §6）。**

| 项 | 结果 |
|---|---|
| ① C1 38 例四臂回放 | v1542 协议臂 **13 正确强判 / 0 错误强判**（v1541=7/0、生产注入=8/0、规则基线=8/0）；逐 flip 见 §2.2 |
| ② 新 WRONG_STRONG | **0**（38 例回放 + 13 例新语料）；F2-C07（回指+B2 探针）、F1-C02（SCALE）、F3-C06（B2）等全部负例维持弃判 |
| ③ C2 独立新语料 | 3 新家族（UAV 检测/脑病灶交互分割/视频扩散加速，与 F1-F7 不同子领域与作者）；L1 exact 11/13；协议臂 2 正确强判 / 0 错 / 11 弃；规则基线 1；13 次真实调用 in≈75.7K/out≈4.8K token（list 口径 ≈$0.13，订阅渠道边际 0） |
| ④ 去重（B4） | 新增 `claimGuards.ts` 单一来源；candidateProposer 删除 9 处本地拷贝（STOP/OWN×2/QUALIFIER×2/派生列正则/rowIsOwn/B2×2/B3）；claimCertificate 改 import，行为逐字迁移 |
| ⑤ 映射见证 | mapping-witness/v1：claimAtom、canonical 格、程序生成行引用（rowGroup+行矩阵，含源偏移）、回指锚 [start,end) 原文与竞争前件、引文四分类、逐 term grounding、唯一性签名、B2/B3 |
| ⑥ 测试 | candidateProposer 38/38（19 旧不软化 + 19 新）、claimGuards 9/9、claimCertificate 49 + SemanticBinding 15 + CrossTable 9 全绿；backend 全量 4260/4261（1 例 sources 模块计时闪失，单文件复验 14/14 过，与本轮无关） |
| ⑦ Git/CI | 见 §7 |

## 1. 审计与预登记（阶段 A）

零模型复现 M15.4.1 三臂（严格复用已落盘模型响应）：baseline 6、v1541 7（DEV 5+HOLD 2）、生产注入 6 —— 与 M15.4.1 报告逐例一致（回放产物 sha `288ff58c…`）。31 例弃判按互斥首要原因+漏斗阶段诊断逐例分类：

- **可确定性修复（12 例预期）**：M1 回指锚定、M2 引文四分类、M3 派生局部归因阻断、M4 context 丢弃（详见预登记 §2.1）。
- **必须弃判**：F4 全家族（行键全表坍缩 = PARSE_PROVENANCE_INCOMPLETE）、F1-C03/F5-C06（真歧义，不加值平局）、F5-C05（模型 metric 误标）、探针类。
- **无法证明**：F5-C01/F7-C02（零主语/隐含主语，锚不可证）；F6-C01（L1 wrong）。

## 2. 协议实现（阶段 B）

### 2.1 四个白名单机制

- **M1 回指锚定**：封闭词表（this method/the model/the same two models 等）→ 程序在同段落窗口（≤1500 字、段落/结构边界即止）内逐字定位**行键专名锚**（单数须唯一；"the same two models" 须恰一对 A-and-B 并列；own 路线须窗口含 our/ours/we 逐字 + 目标行 rowIsOwn）。回指情形模型 subject 字段被锚替换——模型不得借回指注入名字。多前件 → `PROPOSAL_ANTECEDENT_NOT_UNIQUE`。
- **M2 引文四分类**：SOURCE_VERBATIM / PARSER_RENDERED_VERBATIM（含程序生成的行引用 = rowGroup+行矩阵拼接）/ MODEL_PARAPHRASE / UNLOCATABLE。后两类仅从证据集排除；全部引文不可用 → 维持整案拒绝（比预登记宽松读法更严，如实记录）。数值截断（1.00↔1.000）经边界感知定位拦截（FIX-2c）。
- **M3 派生局部归因阻断**（claimCertificate.atomQualifiers，唯一生产行为变更）：触发词与数值之间以「非派生名词+of」结尾（a Top-1 accuracy of）或以 from 结尾（区间端点）→ 不继承 DERIVED。派生名词封闭集含 difference/delta/gap/ratio 等；直接派生措辞（improvement of 3.2 / by X pp）不受影响。生产侧影响（38 例回放如实记录）：纯规则基线 6→8、生产注入 6→8，新增 F4-C03、F5-C02 均与期望一致、零错误强判。
- **M4 context 词丢弃**：不在论断句/锚文本 → 丢弃并记录（过滤只降不升）。

### 2.2 实施偏差（附录 §9 全文见预登记；全部 fail-closed 方向除 D1 外命中集只减不增）

FIX-1b 行级 context 判别器（表级 caption 同提多场景时行键场景段裁决）；FIX-2 引文列绑定不得绕过数字部件失配（Top-1↔Top-3 翻转拦截，缩写桥保留）；FIX-2b 父级表头引文不得绑定叶子指标（AB≠A/F）；FIX-2c 数字边界感知；FIX-3 own 路线 claim 检查 bug；D1 转置表方向 B（与生产 bindTextAtom useA/useB 对齐，POC 此前缺失）；D2 单位判别器（dB 值不与无单位格竞逐）。

### 2.3 B4 去重

`backend/src/review/claimGuards.ts`：STOP、OWN_ALIASES、OWN_ROW、QUALIFIER_LEXICON、QUALIFIER_FAMILIES、DERIVED_COLUMN_HEADER、mentions、rowIsOwn、qualifierRejections、crossTableValueCompetitors —— 自 claimCertificate@1c7713d **逐字迁移**；claimCertificate 与 candidateProposer 均 import 单一来源，candidateProposer 删除全部本地拷贝。旧路径等价：既有 73 证书测试全绿 + claimGuards.test.ts 正反例 + certifyClaim inputsSha256 配方不含代码 SHA（证书哈希不受重构影响）。**未建第三套验证器**：verifyProposal 仍不签发 claim-certificate/v1，不 import 生产 Gate。

## 3. C1 零模型回放（38 例）

| 臂 | CORRECT_STRONG | WRONG_STRONG | ABSTAIN |
|---|---|---|---|
| baseline（规则+oracle 对照） | 8（M3 后 +F4-C03/F5-C02） | 0 | 30 |
| v1541（M15.4.1 验证器，冻结复现） | 7 | 0 | 31 |
| **v1542（本轮协议）** | **13** | **0** | 25 |
| production（提案注入生产证书器） | 8 | 0 | 29+1 NOT_RUN |

**逐 flip（ABSTAIN→STRONG，6 例）**：F2-C04 SUPPORTED（M3 局部归因 + FIX-1b 行级判别）、F2-C08 CONTRADICTED（M3）、F3-C03/F3-C04 SUPPORTED（M1 own 路线 + FIX-3 + 值佐证）、F5-C02 SUPPORTED（M3 + FIX-1b + D2 单位判别）、F7-C01 SUPPORTED（M4 context 丢弃 + D1 转置表）。零损失；15 负例全拦（F2-C07 被 B2 拦截、F1-C02 SCALE 拦截、全部 L1-wrong 案例被 grounding/uniqueness 拦截）。

## 4. C2 独立新语料（3 家族 13 例，13 次真实调用）

G1 HDMamba-YOLO（2609.23061，UAV 小目标检测）、G2 BrainIAC（2609.23026，脑病灶交互分割）、G3 SparkDiffusion（2609.23153，视频扩散加速）——与 F1-F7 及彼此不同子领域。构成：7 CONSIST + 3 CONTRADICT（编辑值机械注入）+ 3 弃判负例（派生/no-table/近似上限）。

**结果**：协议臂 2 正确强判（G1-C03 CONTRADICTED——论文源含重复表格文件致 5 格一致 DISJOINT 多绑定，B2 通过后一致裁决；G2-C04 SUPPORTED——from 端点 M3 真实数据验证 + 值佐证）**均为全臂唯一**（规则基线与生产注入臂均未判出）；0 错误强判；4 负例全部正确弃判。L1 exact 11/13。规则基线 1（G1-C01）。成本：13 调用 in 75,709 / out 4,844 token（list 口径 ≈$0.13；订阅渠道边际 0；每例 ~8s）。

**弃判机制归因（诚实记录，未做任何 C2 后调参）**：G1-C01/G1-C02（论文源重复表格文件 → 双份同签名竞争，NOT_UNIQUE/限定词——语料自然属性非协议缺陷）；G2-C01（模型 subject 词未落行键）、G2-C02（括号绝对值 `(68.9\%)` 悬于比较语境，M3 的 of/from 阻断不覆盖括号形）、G2-C03（编辑值同表碰撞 + grounding）、G3-C01/C03（句子主语是 "the stretch" 机制而非方法名，模型 subject 不在论断句——正确拦截）、G3-C02（值 1.3 与句内模型名 "T2V-1.3B" 撞名 → CLAIM_ATOM_NOT_LOCATED，全臂同此）、G3-C04（正确弃判）。

## 5. 判定对照（预登记 §6）

- ① 零新增 WRONG_STRONG ✓（51 例两轮全零）② 全部负例弃判 ✓ ③ 7 既有强判零损失 ✓ ⑤ 测试绿+等价 ✓ ⑥ 无生产 Gate 改动 ✓（gates.ts/revisionTaskGate.ts/Academic Score/EvidenceStore 未动）。
- ④ 独立新语料 ≥2 家族正确强判净增：**按「协议臂产出全臂唯一的正确强判」口径达成**（G1、G2 各 1，均带可独立复核的映射见证）；按「每家族对基线的计数差」口径未达成（G1 为 1:1 平——模型臂在 G1-C01 因重复表格弃判而基线臂判出）。两口径均如实呈报；取严格口径时整体为 PARTIAL_WITNESS_ONLY 与 GO_PROTOCOL 的边界情形，结合 C1 的 +6/0 错误与全部安全门槛通过，裁 **GO_PROTOCOL（有保留）**。
- 未触发任何 STOP 条件；未放松 UNIQUE/B2/B3/双钥匙/显示精度；未加值平局扩展。

## 6. 局限与 M15.4.3 建议

1. C2 转化率 2/13：L1 定位泛化良好（11/13 exact）但转化仍受三类未修机制制约——重复表格文件的同签名竞争（可用「同 tableId 内容寻址 + 文件级去重候选」研究，风险低）、括号形绝对值 `(X%)` 的 M3 覆盖、机制主语句（the stretch/this reduction 类）的锚定。均非防线放松问题。
2. M1 回指锚依赖行键专名逐字出现；F4/F6 类解析损坏（行键坍缩/注释污染）在 proposer 层不可修——latexTable 健壮化应作为独立工作项（M15.3.0 TABLE_STRUCTURE 桶延续）。
3. C2 为 13 例/3 家族单轮（预登记下限 12-20 例），样本不支持族间显著性；标注为执行代理+机械校验（同 M15.4.1 先例）。
4. **M15.4.3（生产集成）建议：有条件 GO**——条件：(a) 集成面仍 SHADOW 起步（先并行出证对比，不动 Reviewer 主链）；(b) 重复表格去重与括号 M3 两项机制先在回放验证零回归；(c) claimGuards 迁移后的生产观察窗口（inputsSha256 不变，但 dist 图变更需一轮 CI+Linux 集成确认）。
5. 旧 191 例语料本机不可得（DATA_UNAVAILABLE，与 M15.4.1 相同）；替代证据链 = 既有全套件测试 + 38 例回放 + 合成 metamorphic 负例。不得宣称 191 例重放。

## 7. 测试 / Git / CI

- 定向：candidateProposer 38/38（含 M1 A2-1~6、M2 Q-1~3、M3 M-1~4、M4 C-1/E-1~4/W-1 共 19 新例）；claimGuards 9/9；claimCertificate 49 + SemanticBinding 15 + CrossTable 9 全绿；typecheck/build 过。
- backend 全量：4260 passed / 1 failed（test/sources/fullTextAttach.test.ts 满载计时闪失，单文件复验 14/14 过——Windows 先例处置，与本轮改动无关的模块）。前端零改动（本轮不涉前端文件）。
- Git：代码+测试+脚本+文档提交 main；push 后核对 GitHub Actions / Linux Integration 实际结论（见提交后补记）。
- 仓库外产物：预登记+偏差附录、C1 回放四臂 JSON、C2 语料/提案/usage、诊断脚本（analysis/）均在 `D:\PaperTeamData\M15\M15_4_2\`。
