# M15.13 — Focused Review Efficiency & Independent Replication（聚焦审稿效率与独立复现）

- 日期：2026-10-29 · 任务书：M15.13（属 M15；**M15_OVERALL=INCOMPLETE 维持**）
- 基线：`917ad26`（== origin/main，clean）→ 本轮提交见 §8
- 数据根（仓库外）：`D:\PaperTeamData\M15\M15_13\`（605 文件 SHA256 MANIFEST；PDF/评审原文仅内部）
- 数据源：**PeerRead ICLR 2017**（合法备选源）。主源 ICLR 2025 OpenReview 被 Turnstile 阻断（匿名/留存 cookie 直连 403、留存 profile clearance 过期、真人验证窗口未完成——如实记录，未绕过）。
- 预算：600 保护上限；实际 **282 次真实物理模型调用**（DEV 16 + 四臂 199 + typing 24〔含 deviation v2 重跑 12〕+ 对齐 judge 47），估算成本 **$5.34**（0.58M in / 0.15M out / 0.28M cache）
- 指标性质：代理匹配测量（外部标签 = 公开人类评审真实内容；问题分段/typing/匹配为模型辅助 + investigator 复核；不构成录用判据）

## 0. 第一屏裁决（预注册 §3 门）

**本轮裁决 = `PARTIAL_SIGNAL`（不转正）**——整稿 pass 的独立消融效应在全新样本上**强复现且放大**（G1b），成本门以大裕度达标（G3），但**主增益门 G1a 与子集门 G2 未过**：优化链 C2 相对最强基线 C0 仅 +2.1pp（CI 含零），未复现 M15.12 的 +9.0pp 级优势：

| 预注册门 | 阈值 | 实测 | 判定 |
|---|---|---|---|
| G1a 主增益（双基线） | C2−C0>0 ∧ C2−C0+>0 ∧ C2−max≥+5pp ∧ 对最强基线 CI 下界>0 | C2−C0 **+2.1pp [−2.8,+6.6]**；C2−C0+ +3.5pp [+0.5,+6.6]；最强基线=C0 → +2.1pp<5pp 且 CI 含零 | **FAIL** |
| G1b 整稿 pass 消融 | C2−C1opt ≥+3pp 且 CI 下界>0 | **+9.8pp [+6.4,+13.1]**（M15.12 为 +4.6 [+2.3,+6.9]——复现且放大） | **PASS** |
| G2 SERIOUS/META 不退化 | 对最强基线 point Δ≥0 | serious +0.5pp（过）；**meta −1.1pp**（未过，ns） | **FAIL** |
| G3 成本 | C2 ≤20 调用/族（硬）；墙钟 ≤4×C0（目标） | **13.3 调用/族**（p90=16，max=19；M15.12 为 21.7）；墙钟 **5.7×**（>4× → **LATENCY_RISK** 标注） | **PASS**（附标注） |
| G4 top-K 诚实分母 | 可用性审计（非独立阻断） | top-10 retention **58.8%**（对同臂全量匹配）；serious 占比 87.5%；近重复率 0%；一对一口径上限 76.9% | 审计可信 |
| G5 守卫 | gates.ts/N1/N2/H 零改动 + 回归全绿 | `git diff 917ad26..HEAD` gates/qualityPolicy **0 文件**；定向回归 32/32；全量见 §8 | **PASS** |

**结论一句话**：在 12 个全新未开封 PeerRead ICLR 2017 被拒论文族（41 条实质评审 → 499 可判读问题族）上，"批量摘要 + 小节合并批 + 全文级 Goal–Method–Claim–Evidence pass" 链的整稿 pass 净增量**独立复现且增大**（+9.8pp，CI 不含零），每族调用压到 **13.3**（较 M15.12 的 21.7 再降 39%，远低于 20 门）；但 C2 对最强基线（one-shot C0）的主指标优势只有 +2.1pp（CI 含零）——**M15.12 的 +9pp 级主优势未能在不同 venue/年代的独立样本上复现**，且分节链本体（C1opt 23.4%）在本样本显著弱于 C0（31.1%）。配置维持实验开关，不转正。M15 期刊级判别仍 NOT_EVALUATED。

## 1. 唯一研究问题与回答

**问**：优化调用分配后，M15.12 的「有界分节 + 证据锚定 + 整稿 pass」形态能否在全新独立 held-out 上复现对强基线的实质覆盖增益，同时把每族调用压到 ≤20？

**答**：**部分复现**。(a) 整稿 pass 自身的净增量复现且放大（+9.8pp vs M15.12 +4.6pp，两轮 CI 均不含零——该组件是稳健的）；(b) 成本目标大胜（13.3 vs ≤20）；(c) **但**主指标对强基线未复现：C2−C0 仅 +2.1pp，且本轮 C1opt 分节链塌陷至 23.4%（vs C0 31.1%）——分节链的相对价值跨样本不稳定（M15.11 +3.5ns → M15.12 持平 → 本轮 −7.7pp），而 one-shot 基线三轮都稳健（33.5%/44.8%/31.1%）。诚实推论：**PaperTeam 链相对廉价基线的净优势主要由整稿 pass 贡献；分节+锚定机制的证据/定位价值（grounded ~99%）未转化为稳定覆盖优势**。

## 2. Phase A 产品改动（已入 main @ 185b72e）

1. **A1 fullpaper 解析有界重试**：extract/critique 解析失败（含空输出）→ 同输入 + 最小格式提醒重试 1 次；两次失败才置 parseFailed；extractRetried/critiqueRetried 如实登记；重试为物理调用。回归 12 例（成功/双失败/取消传播/telemetry 不污染）。**本轮生产运行 13/13 workflow 零解析失败——重试机制就位未触发**（26 fullpaper 调用 = 12×2+DEV 2）。
2. **A2 sectionReviewMode=batched-small**（缺省 per-section=旧行为，可回滚）：<2000 字符相邻章节合并批（≤4 节/≤6000 字符，纯确定性）；批式 finding 必填 sectionId + 锚校验；journal batch- 前缀复用。**References 节保留独立审阅**（M15.12 零模型归因：13/612 问题仅由 References 锚 finding 独家匹配——豁免损失 ~1.5–2.1pp 不值得 1 调用/族）。回归 5 例 + 既有并发/模式测试全绿。
3. **A3 priorityView 诚实分母字段**（poolSize/seriousPoolCount/metaPoolCount）。
4. **接线修正**：runner 显式传 reviewConcurrency（serviceStack 硬缺省 3 的缺口）；本轮用 5（M15.12 为 3，纯并行度）。
- gates.ts / qualityPolicyV2 / M15.8.6 N1/N2/H **零触碰**（git diff 0 文件可证）。

## 3. 样本与盲态（Phase B/C）

- 备选源资格框：PeerRead iclr_2017 被拒 255 篇 → 实质评审（非 meta、≥600 字符）∈[3,5] 且与 M15.11/12 已消费 34 族零重叠 → 212 族；seed=1513 shuffle → DEV 1 + PRIMARY 12 + RESERVE 4；**选样只输入元数据**（标题/计数/长度），评审原文下载即隔离 sequester/。
- PDF 资格（pymupdf 离线）：**12/12 通过、零替补**（pages 9–17、chars 26k–58k）；全部带 "Under review as a conference paper at ICLR 2017" 页眉（投稿版证据；被拒无 camera-ready；无法对证 OpenReview 修订史=已披露局限）。
- 冻结链：PROTOCOL_FROZEN.md（sha256 a1516642…）先于任何真实调用 → sample-manifest（PDF SHA256）→ 四臂预测 12/12 SHA256 冻结（missing=[]）后才解封 → typing 冻结后才对齐 judge。
- DEV smoke（pr-01，16 调用）：全链通；暴露并修复 concurrency 接线缺口（§2.4）。

## 4. 四臂与执行（Phase D）

C0（M15.11/12 prompt 逐字）/ C0+（M15.12 两步逐字）/ C1opt（batched 摘要 + batched-small 分节，无 fullpaper，共享 run 快照）/ C2（+ fullpaper + priorityView）。模型 zai-coding-cn/glm-5.3（同 M15.11/12）。12/12 族四臂完整；pr-03/c0+ 解析失败 → 按预注册 NOT_EVALUATED 剔出该臂配对（n=11）。

## 5. 结果（Phase E；499 问题族，typing 270 serious / 64 meta，investigator 抽查 26 条 0 纠错）

| 指标 | C0 | C0+ | C1opt | **C2** |
|---|---|---|---|---|
| HRI-Coverage（族均，主口径） | **31.1%** | 28.9% | 23.4% | 33.1% |
| HRI（严格一对一） | 14.9% | 16.1% | 14.2% | **21.0%** |
| SERIOUS-Coverage（n=270） | 27.2% | 25.8% | 16.8% | 27.7% |
| META-Coverage（n=64） | **23.9%** | 27.9% | 9.0% | 22.8% |
| findings（12 族） | 164 | 148 | 483 | 574 |
| 物理调用/族 | 1.0 | 2.0 | 11.3 | **13.3**（p90 16 / max 19） |
| 估算成本 | $0.29 | $0.59 | $1.00 | $1.42 |
| Grounded Ratio | 99.4% | 100% | 99.6% | 99.3% |
| 调用/百匹配问题族 | 8 | 20 | 124 | 98 |
| UNVERIFIED_AI_ONLY（不称 FP） | 98 | 85 | 419 | 479 |

- 配对差全表：C2−C0 +2.1 [−2.8,+6.6]；C2−C0+ +3.5 [+0.5,+6.6]；**C2−C1opt +9.8 [+6.4,+13.1]**；C1opt−C0 −7.7（分节链塌陷）。
- **严格一对一口径下结论反转**：C2−C0 strict **+6.1pp [+3.4,+9.0]**（C2−C0+ strict +5.4 [+2.4,+8.2]）。fan-in 量化：C0 每条被用 finding 平均吸收 **2.23** 个问题、C2 1.72；抽查实证（pr-02 C0 一条"实验协议根本性弱"宽泛 finding 吸收 5 个不同问题，含可区分的"作弊质疑"与"精度退化未报告"）。**预注册门按宽松口径判 FAIL（不事后换口径），strict 结果作为 judge fan-in 偏差的敏感性证据并列披露**——宽松口径系统性利好宽泛 one-shot 输出，这是 LLM_JUDGE_PROXY 的结构性局限。
- C1opt 塌陷归因：非锚丢失（batched dropped=0；12 族 parseFailures 3）——483 条 finding 仅 22.6% 被用于匹配（C0 89.6%）：分节细粒度 finding 与 2017 风格自由文本评审问题的对齐率低。分节链相对价值三轮摇摆（+3.5ns → 持平 → −7.7pp），**不稳定性本身是本轮的发现**。
- C0+ 连续第三轮弱于 C0（41.3<44.8；28.9<31.1）：两步抽取伤害通用 Reviewer 在两个 venue 样本上方向一致。
- top-K：retention 58.8%（top-10 承载同臂全量匹配的近六成）；serious 占比 87.5%；近重复 0%；一对一上限 76.9%（数学上限并列展示，不再用 60% 硬门）。

## 6. 局限（诚实清单）

1. L1 judge/typing = 同模型盲态代理（LLM_JUDGE_PROXY）：宽松口径 fan-in 偏差实测利好 C0（2.23 vs 1.72）——主口径的 +2.1pp 应与 strict +6.1pp 区间一并解读；两口径分叉本身说明绝对值噪声大。
2. L2 备选源 venue/年代漂移：ICLR 2017 vs 2025；模型预训练见过概率更高（四臂对称）；**与 M15.11/12 数值不可跨轮直接比较**；主源复现仍待 Turnstile 窗口（未完成）。
3. L3 12 族小样本：G1b 的 CI 不含零较稳健；G1a 的阴性也可能是功效不足（+5pp 门在 n=12 下的检验力有限）。
4. L4 PeerRead 自由文本评审的提取口径与 M15.11/12 结构化字段不完全等价（deviation v2 剥离 Summary 节 + 中性概述句过滤，arm-blind 阶段修正并登记；v1 统计留档）。
5. L5 墙钟 5.7×（>4× 目标）：分节墙钟仅 ~51s/族，大头在 fullpaper 串行 2 调用与阶段编排——LATENCY_RISK 如实标注。
6. L6 录用/拒绝不是质量真值；本轮只测"与真实专家指出问题的一致性"。
7. L7 墙钟并发 5 vs M15.12 的 3（不改语义但影响时延可比性，已披露）。

## 7. 裁决与产品含义

- **PARTIAL_SIGNAL，不 GO**：G1a/G2 未过。`paperMapSummaryMode=batched` / `sectionReviewMode=batched-small` / `globalReviewMode=on` / `priorityView` **全部维持缺省关闭的实验开关**。
- 整稿 pass（B2）组件：两轮独立样本 CI 均不含零（+4.6 → +9.8pp）——作为组件的证据强度上升；若未来转正评估，应**以整稿 pass 为核心**而非"分节越多越好"。
- 分节链：三轮相对价值不稳定 + 本轮显著为负 → 维持可选档位；下一方向（任务书 §5）：带对照证据的逐创新点 Novelty/Contribution vs Prior Work 比较，而非继续加分节层。
- **M15_TARGET_JOURNAL_QUALITY_GOAL 始终 INCOMPLETE**；本实验是跨域 proxy，不能替代 CJIG/CEA 期刊级人工判断，也不能暗示预测录用率。

## 8. Git/CI 收口

- 本轮提交：① Phase A 产品改动+测试（`185b72e`）；② scripts/m1513/（选样/采集/运行/评估链）；③ 本报告 + PROJECT_STATUS（见 git log 终态）。
- 验证：backend typecheck/build ✓；定向回归 32/32（sectionBatchReview 5/fullPaperReview 12/priorityView 7/existingPaperReviewModes 4/sectionReviewConcurrency 并发回归）；全量 vitest 两轮：4467–4477 passed / 1–10 failed——失败全部为 `test/experiments/*`（M14.9 ZIP I/O 重负载）的 5000ms 并行超时闪失，**该模块本轮零改动**；两失败文件合跑隔离复测 10/10 全绿（仓库既有 flaky 模式，CI 为准）。前端零文件改动（无 typecheck 面）。
- 预算账：`phase-d/model-calls.jsonl` 282 条全账（GlobalBudgetLedger 异步结算 174 为滞后值，以 jsonl 为准）；$5.34。
- 数据侧完整账：`D:\PaperTeamData\M15\M15_13\MANIFEST.json`（605 文件 SHA256）；冻结链 phase-b/PROTOCOL_FROZEN → phase-c/sample-manifest → phase-e/predictions-frozen → phase-e/issue-typing-frozen；deviations（v2 提取修正）与 LEAKAGE_AUDIT 在 phase-b/。
