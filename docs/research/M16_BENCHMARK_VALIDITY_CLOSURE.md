# M16 收口 · B — 评测基准区分力

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）
- 冻结协议（仓库外）：`D:\PaperTeamData\M16\ReviewFidelityAndBenchmark_Closure\PROTOCOL.md`（sha256 `41bc8657661569dc0643aa034f1dc702bb13ef304443987d160fe9ad31db5e9a`）、`MANIFEST.json`（冻结时 HEAD `dd95858`、脚本与 16 篇 MD 的 sha256、数据许可）、`DEVIATIONS.md`（5 条，均不改规则）
- 代码：`scripts/m16-closure/{b0-dev-rescore,b-benchmark,specificity,judge-prompt}.mjs`
- 结果：`B/{b0-dev-rescore,score-dev,score-heldout,judge-*,heldout-*}.json`
- 付费调用：DEV 裁判 4 + held-out 生成 16 + held-out 裁判 16 = **36**，0 失败、0 重试

> **BENCHMARK_VALIDITY = PASS**（held-out n = 16，三项预注册对照全部通过）

## 1. 外部参考核查

| 参考 | 核查结果 | 本轮使用 |
|---|---|---|
| ReviewGrounder / ReviewBench（EigenTom/ReviewGrounder；ACL 2026 long 1477，arXiv 2604.14261） | 代码仓库**无 LICENSE**（GitHub API license = null → 不可复制）；未发布数据；rubric 由 GPT-OSS-120B 从**聚合后的人类评审**实例化，同一模型兼任 rubric 作者与裁判；被测系统的 refiner 也读同一套 8 条 meta-rubric（模板泄漏）；**没有通用 / 错配 / 置换负对照**，人类一致性研究只评了自家系统 | 只借鉴方法：论文专属锚点、带符号的「虚假断言」惩罚项、离散档位；不引入代码、多 Agent、GPU、Asta API |
| NLPeer（UKPLab/nlpeer；v1 tudatalib/3618，v2 tudatalib/4459） | 代码 Apache-2.0；数据 `restrictedAccess`（需申请，连 license 包都 401）；整体 CC-BY-NC-4.0，ARR-22 / COLING-20 为 CC-BY-NC-SA；有投稿版 v1 + camera-ready；约 9–13% 段落有行号锚定；对商业 API 使用未明示（UNVERIFIED） | **不使用**：需申请 + 非商业条款与商业 API 的关系未核实 |
| CoCoReviewBench（hexuandeng，tree 2580687） | CC BY 4.0；评审内容来自 OpenReview，仅本地评测、不再分发、不进仓库 | **采用**（300 篇 ICLR 2025；本轮新开 16 篇） |
| SurveyReview | M16 已用于 D3 宽松复测 | 本轮不用 |

## 2. 为什么 M16 的尺子失效（零模型诊断，DEV_OPENED）

先把参考限定为「具体可核对」的意见（确定性规则 `specificity.mjs`：显式 Table / Eq. / Section / Line 等定位，或 ≥ 2 个在论文正文中出现、且在其余 299 篇人类意见中文档频率 ≤ 3% 的词），再用 **M16 原裁判输出** 重算：

| M16 封存 8 篇 | 全部意见 | 只算 SPECIFIC |
|---|---|---|
| G0 通用套话 | 27.9% | **21.5%** |
| Afull 全文单次 | 31.3% | 29.2% |
| Afull − G0 | +3.5 [−8.2, +13.5] | +7.7 [−8.2, +22.1] |

只换参考子集不够：M16 裁判违反自身规则，把「需要更多基线」匹配到「缺少与方法 X 的比较」这类具体意见。因此改两处：(1) 更严格的裁判规则（同一论文对象 **且** 同一关切；只提术语不算；不属于本论文的条目不匹配），裁判看题名 + 开头 1,800 字作为语境；(2) 确定性**术语门**：条目必须与该人类意见共享 ≥ 1 个论文专属词才计。用 M16 原裁判输出预演术语门：G0 21.5% → 0%，Afull 29.2% → 18.6%（保留约 64%）。术语门让 G0 按构造归零，所以另设两个不靠构造的对照：错配论文、关键词填充攻击。

## 3. 协议要点（冻结后只跑一轮）

- **评分单元**：paper_id × 人类原子意见（CoCoReviewBench 正确性过滤后的弱点意见）；SPECIFIC 用于严格评分，GENERIC 只作诊断。
- **臂**（每篇 ≤ 10 条，裁判只看条目文字）：CORRECT（M16 SYSTEM_A 逐字 + 本篇全文）；MISMATCHED（另一篇的 CORRECT，循环错位）；G0（M16 冻结通用套话）；ATTACK（零模型：G0 同构模板 + 本篇正文高频、且在其他论文人类意见中罕见的 6 个词——正好是术语门检查的词表，是最强的廉价刷分攻击）。
- **盲化**：四臂 40 条混合、确定性乱序、匿名 I1..I40；裁判不知道臂、模型、预期结果，也不知道哪些参考被判为 SPECIFIC。
- **防泄漏**：生成输入只有 SYSTEM_A + taxonomy + 论文全文（`heldout-generations.json` 记录输入 sha256），人类意见只进裁判侧；没有任何 prompt 在看过 held-out 输出后修改。
- **主指标** `hybridSpec@10` = 被（裁判判匹配 ∧ 共享论文专属词）覆盖的 SPECIFIC 意见 / SPECIFIC 意见数；论文级配对 bootstrap 95% CI。
- **B 门**（MID = 10pp，看任何输出前固定）：G1 CORRECT − MISMATCHED（hybrid）、G2 CORRECT − ATTACK（hybrid）、G3 CORRECT − G0（**只看裁判**，不经术语门）；每项 mean ≥ 10pp 且 CI 下界 > 0。
- **样本**：DEV = M16 已开封封存集前 4 篇（复用 M16 Afull 输出，只用于发现实现 bug——未发现，未修改）；HELD-OUT = 新抽 16 篇（Accept / Reject 各 8；排除全部 DEV_OPENED；MD 15–60 kB；SPECIFIC ≥ 3；sha256 排序；git blob sha1 校验）。

## 4. 结果

DEV（n = 4）：CORRECT 27.5% vs MISMATCHED 0 / ATTACK 1.6% / G0 0；三项对照均通过；id 映射与解析逐项核对无误。

**HELD-OUT（n = 16，一次运行）**：

| 臂 | hybridSpec@10 | judgeSpec@10 | judgeAll@10（M16 口径） | 被匹配条目率 |
|---|---|---|---|---|
| CORRECT | **17.3 [10.8, 24.5]** | 27.2 [19.8, 34.3] | 33.9 [27.8, 39.7] | 40.9% |
| MISMATCHED | 0.0 [0.0, 0.0] | 0.5 [0.0, 1.6] | 1.3 | 1.9% |
| G0 通用套话 | 0.0（按构造） | 9.0 [3.1, 15.9] | 15.8 | 21.9% |
| ATTACK 关键词填充 | 5.7 [1.3, 11.4] | 9.9 [4.5, 16.4] | 15.2 | 20.6% |

| 预注册对照 | 差值（pp） | 判定 |
|---|---|---|
| G1 CORRECT − MISMATCHED（hybrid） | **+17.3 [10.8, 24.5]** | PASS |
| G2 CORRECT − ATTACK（hybrid） | **+11.7 [3.8, 18.8]** | PASS（均值刚过 MID） |
| G3 CORRECT − G0（只看裁判） | **+18.1 [9.2, 26.4]** | PASS |
| 诊断：只看裁判 CORRECT − MISMATCHED / − ATTACK | +26.6 [19.4, 33.8] / +17.2 [9.0, 24.6] | — |
| 诊断：M16 口径（全部意见）CORRECT − G0 | +18.2 [9.8, 26.0]（M16：+3.5 [−8.2, +13.5]） | — |

**结论**：新尺子能区分「读了这篇论文的具体批评」与「不读论文的套话」「别的论文的审稿」「塞了本篇术语的套话」。改进主要来自裁判规则（同一参考口径下 CORRECT − G0 从 +3.5 升到 +18.2），术语门再把攻击臂从 9.9% 压到 5.7%。

## 5. 参考意见的质量与风险（问题 3）

- held-out 235 条人类弱点意见中 **146 条（62.1%）判为 SPECIFIC**，其中 47 条带显式定位；89 条（37.9%）为 GENERIC（「novelty limited」「需要更多实验」类），只作诊断。
- **gold 噪声已观察到**：jbfDg4DgAk 的 H5–H8 是一位审稿人的参考文献列表被数据集拆成的「意见」，被规则判为 SPECIFIC；该篇 ATTACK（38%）与 G0 高于 CORRECT（13%）主要源于此。按协议不剔除（方向不利于过门）。
- **参考不完备**：生产 Reviewer 在 jbfDg4DgAk 上报出源稿 Eq. (1) 的 z 分数分母问题（源文逐字可核），人类参考没有，该篇得分 0。匹配率只能衡量「与人类关注点一致」，不能衡量「问题是否真实」→ 对主观问题只能标 REFERENCE_ALIGNED_ONLY。
- **版本**：MD 多为 arXiv 版，可能不是审稿时的投稿版；部分人类批评可能已在正文中修复。
- **裁判同族**：生成与裁判都是 GLM-5.3。用确定性术语门 + 错配 / 攻击负对照约束，但「同族偏好」不能完全排除；本轮没有把模型互评当真值。
- **适用范围**：英文 ML 会议（ICLR 2025），不外推到中文期刊或其他学科；n = 16 只能检出 ≥ 10pp 量级的差异。
- **ATTACK 仍有 5.7% 残余**：刷分攻击未被完全消除，G2 刚过 MID。任何 < 10pp 的系统间差异都不能用这把尺子下结论。
