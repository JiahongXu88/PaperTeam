# M16 续期收口 · 验证报告（预注册协议、数据、结果、Gate）

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 起点 `8791708`
- 证据（仓库外，不上 Git）：`D:\PaperTeamData\M16\OriginalQualityGateGoalClosure\`（`PROTOCOL.md` + `PROTOCOL.sha256` = `d309c76f…`、`MANIFEST.json`、`DEVIATIONS.md`（6 条）、`budget/calls.jsonl`、`A/`、`B/`、`C/`、`D/`、`E/`）
- 代码：`scripts/m16-goal-closure/`（评测工具，不进产品）

## 1. 协议与偏差

协议在任何模型调用与选篇之前冻结（§0–§7 见 `PROTOCOL.md`）。冻结后的偏差全部追加记录、均发生在相关结果产生之前或不影响结果：

| # | 偏差 | 影响 |
|---|---|---|
| 1 | 某层不足 6 篇时的补足规则（补登） | 最终未触发 |
| 2 | **单元数测量 bug**：scripted dry-run 因解析失败重试 ×3 且受 22 次截断，72 个候选中 68 个报 22；改用生产同一函数的零模型计数（对上一轮两次真实运行预测 17 / 13 = 实际 17 / 13）。阈值 ≤ 16 不变 | 选篇改用正确测量；未读任何人类意见 / 输出 |
| 3 | aJUuere4fM 三个单元被服务商内容安全过滤拒绝（code 1301） | 真实产品行为，按协议不重跑 |
| 4–5 | 主机内存回收后台 shell 包装；批处理进程实际未中断，无重跑；为第 10 篇补记的 6 行账本为重复计数 | **真实调用 = 账本行数 − 6** |
| 6 | 核验工具：`quotes_contradict` 支持非数值字面量；新增 `not_evaluated` 规格 | 盲池阶段（臂未合并）决定，两臂同等适用 |

## 2. 数据（新留出集，零模型冻结）

CoCoReviewBench ICLR 2025（CC BY 4.0）。排除此前任何轮次开封 / 抽样框论文（38 篇）及同 arXiv 编号 / 题名；MD 15k–60k 字节、弱点意见 ≥ 5、SPECIFIC ≥ 3、长文档实际单元数 ≤ 16；sha256 顺序每层 6 篇：

| 层 | 论文（单元数 / SPECIFIC 意见） |
|---|---|
| accept | aJUuere4fM（9 / 8）、pISLZG7ktL（13 / 12）、4AuyYxt7A2（14 / 7）、uAFHCZRmXk（14 / 9）、J9VogDTa1W（14 / 9）、UiEjzBRYeI（16 / 9） |
| reject | ijwYWoChN9（15 / 9）、x9gCQC3rVA（14 / 27）、bBUhlynfRX（14 / 12）、6Ire5JaobL（15 / 6）、orr5uPZY28（14 / 4）、epbXCD1Ifk（12 / 18） |

选择偏差：≤ 16 单元的条件只保留较短、章节较少的论文（195 个候选中 100 个合格）；结论只适用于 15k–60k 字节的英文 ML 会议论文。被测两臂从不接触人类意见；人类意见只在两臂输出冻结后进入裁判。

## 3. B：新样本上的尺子复验（PASS）

judge1：每篇 1 次，五臂混合匿名（S 单次全文 / MISMATCHED 错配 / G0 通用套话 / ATTACK 关键词填充 / PSEUDO 伪具体）。论文级 bootstrap 95% CI，n = 12，0 次裁判失败。

| 臂 | hybridSpec@10 | judgeSpec@10 | judgeAll@10 | matchedItemRate |
|---|---|---|---|---|
| S | 17.4 [10.8, 24.0] | 37.0 [25.0, 50.0] | 32.6 [26.5, 38.8] | 41.9 [35.0, 49.4] |
| MISMATCHED | 0.0 | 0.5 [0.0, 1.4] | 0.4 | 0.8 |
| G0 | 0.0 | 13.4 [4.9, 23.1] | 17.5 | 25.8 |
| ATTACK | 3.0 [0.0, 7.2] | 13.5 [4.8, 23.5] | 15.9 | 22.5 |
| PSEUDO | 0.0 | 0.5 [0.0, 1.4] | 0.4 | 0.8 |

| 预注册门（MID = 10pp） | 差值 | 结论 |
|---|---|---|
| G1 S − MISMATCHED（hybrid） | +17.4 [10.8, 24.0] | PASS |
| G2 S − ATTACK（hybrid） | +14.4 [6.8, 21.9] | PASS |
| G3 S − G0（judgeSpec） | +23.6 [7.4, 39.4] | PASS |
| G4 S − PSEUDO（hybrid，新增） | +17.4 [10.8, 24.0] | PASS |

**BENCHMARK_VALIDITY = PASS**（复现了上一轮 held-out 的三项，并新增伪具体攻击）。限定：
- 单靠裁判仍会给通用套话 13.4% 的 SPECIFIC 命中（宽松残余），主指标靠术语门压到 0；
- PSEUDO 的替换常常落在不显眼的罕见词上（119 条中多数只在句末补了本篇两个词），属中等强度攻击，不是最强攻击；
- 尺子只衡量与人类意见的对齐，人类参考不完备：未对齐 ≠ 错误。所以另设 §5 的独立核验。

## 4. C：单次全文（S）vs 生产链路（P）

P = 当前 main 的 LaTeX `review.run → quality.gate`（published_paper_assessment，产品 Settings 模型 glm-5.3，保真适配器输入，英文输出）。12 / 12 篇完成；188 次调用，其中 10 次失败（全部是 aJUuere4fM 的内容过滤）。judge2：每篇 1 次，S + P 全部 findings 混合匿名。

### 4.1 与人类专家意见的对齐（n = 12）

| 指标 | S@10 | P@10（严重度前 10） | P@all |
|---|---|---|---|
| 条目数 / 篇 | 9.9 | 10.0 | 38.7 |
| hybridSpec | 16.9 [9.3, 25.0] | 3.3 [0.6, 6.7] | 9.4 [4.9, 13.9] |
| judgeSpec | 33.9 [22.7, 46.1] | 6.8 [2.9, 11.3] | 14.8 [9.6, 19.4] |
| matchedItemRate | 41.1 [31.7, 51.1] | 12.5 [5.0, 23.3] | 13.2 [5.2, 23.0] |

| 配对差值 | 均值 [95% CI] |
|---|---|
| **主指标 hybridSpec P@all − S@10** | **−7.6 [−16.4, +1.0]** |
| hybridSpec P@10 − S@10 | −13.6 [−21.4, −5.7] |
| judgeSpec P@all − S@10 | −19.2 [−30.4, −8.3] |
| matchedItemRate P@all − S@10 | −27.9 [−40.4, −13.9] |
| 裁判重测：同一 S 条目 judge1 vs judge2 的 \|ΔhybridSpec\| | 5.3 [2.0, 9.0]（≤ 10，稳定） |

漏检结构：S 命中、P 漏掉的人类意见 53 条，其中 **36 条（68%）为整稿层面**（实验充分性 / 比较基线 / 统计 / 创新性 / 影响）；P 命中、S 漏掉的 14 条中整稿只有 1 条。P 的 57 条 major 里与人类意见对齐的 2 条，407 条 minor 里 14 条。

### 4.2 可追溯性（确定性，全部条目）

| | LOCATED | DANGLING（引用了原文不存在的编号 / 引文） | UNANCHORED |
|---|---|---|---|
| S | 18.6% | 0.0% | 81.4% |
| P | 89.6% | 6.8%（约 34 条） | 3.6% |

P − S：LOCATED +70.9 [64.0, 77.8]；DANGLING +6.8 [4.2, 9.5]（未超过协议 10pp 门）。

### 4.3 成本

| | 调用 | 输入 token | 输出 token | 缓存读 | 墙钟合计 |
|---|---|---|---|---|---|
| S（12 篇） | 12 | 172k | 8.3k | — | 2.6 min |
| P（12 篇） | 188 | 888k | 274k | 5.24M | 67.2 min |

约 15.7 倍调用、26 倍墙钟。

### 4.4 C 判定（预注册）

主指标 −7.6 [−16.4, +1.0]：均值未达 ±10pp，CI 跨 0 → **G3 = INCONCLUSIVE**。不扩样本、不改门槛。次要指标（P@10、judgeSpec、matchedItemRate）的 CI 都在 0 以下：**在「与人类专家关注点对齐」这一维度，生产链路明确不优于、且有证据显著弱于单次全文**，主要差在整稿问题。

## 5. 问题级证据：人类没有写、但可在原文确定性复核的发现

盲化核验池：judge2 之后，每篇每臂按名次（P 按严重度）取前 3 条「未与任何 SPECIFIC 意见对齐、且 LOCATED」的条目，共 56 条（S 20 / P 36），去掉臂 / 名次 / 严重度。执行者对每条写确定性检查规格（`C/verify-specs.json`），由 `bc.mjs verify-score` 对原文计算后再与密钥合并。

| 结果 | S | P |
|---|---|---|
| INDEPENDENTLY_VERIFIED | 0 | **8（7 个根因，分布在 6 篇论文）** |
| REFUTED | 0 | 1 |
| NOT_EVALUATED | 0 | 1 |
| UNVERIFIED | 20 | 26 |

成立的 7 个根因（全部是 P 的 major，人类参考中都没有）：

| 论文 | 发现 | 确定性检查 |
|---|---|---|
| orr5uPZY28 | 摘要 / 结论的「9.4× 延迟降低」不能从 Table 3 任一行推出（最大 10.42×，最近距离 1.02） | 各行 Baseline / Ours 比值 |
| orr5uPZY28 | 「consistently … higher number of accepted tokens」与 Table 1 矛盾（OWT/0 3.79 < 3.81；CNN/0 3.97 < 4.04） | 表内比较 |
| J9VogDTa1W | 「k ≠ 4 时准确率高于 80%」与 Table 1 矛盾：k = 3、d = 0.0 为 22/32 = 68.75% | 表内复算 |
| UiEjzBRYeI | 正文 COCO→Cityscapes PQ 40.6 / mIoU 47.5，Table 1 同列 41.0 / 47.9 | 两处数值 |
| 6Ire5JaobL | 正文称 RIVER 用 Table 1 的 OT-VF（a_t = 0, b_t = t），Table 1 该行为 a_t = t, b_t = 0 | 两处字面量 |
| x9gCQC3rVA | 正文「Direct Policy Optimization (DPO) (Rafailov et al., 2024)」，论文自己的参考文献标题为「Direct preference optimization」 | 两处字面量 |
| uAFHCZRmXk | Table 1 题注称 dataset size 相关性强于 modality gap；中等规模 MS COCO \|−0.129\| < \|0.167\| | 表内比较（普遍性论断的反例） |

被反证 1 条：J9VogDTa1W「0.036% 无法复现」——按原文假设 4!·(1/4)^8 = 0.0366%，论文值正确，finding 是误报（major）。NOT_EVALUATED 1 条：UiEjzBRYeI「Table 8 缺失」——输入 MD 确无题注，但可能是 PDF→MD 转换伪影。

局限：核验是每篇每臂 ≤ 3 条的有界下限；S 的条目是一两句概括、不带引文，能进池的多为 UNANCHORED，结构上难以写确定性检查——这本身是两种输出形态的真实差别，但也意味着「S 独立核验 0 条」不能读成「S 没有真问题」。检查规格由执行者撰写（同属模型族），但每条结论由脚本对原文计算，前提引文必须逐字存在。

「可信发现」（对齐条目 + 去重后的独立核验根因）每篇差值 P − S：+0.58 [−0.33, +1.50]（描述性，非预注册主指标）。

## 6. Completeness / Severity 真实输入证据

- aJUuere4fM：3/13 单元被服务商拒绝 → 覆盖 60.5%，`complete = false`，失败单元与跨章失败如实列出，Gate 整体 FAIL（L0 `review_coverage_complete`），没有假 PASS。
- 同一运行暴露 L2 语义缺陷：`open_critical_major_zero` 在 40% 正文未审时仍为 PASS「critical=0 major=0」。已修复（提交 `b38cb62`）：部分覆盖下模型计数类规则的「0 条」→ 必需 NOT_EVALUATED 并写明覆盖比例；已发现问题照常 FAIL；完整覆盖逐字不变。
- 其余 11 篇真实 QualityReport：L4 恒 UNVALIDATED；无引用元数据核验（离线评测栈）时 overall = NOT_EVALUATED，不出现 PASS。

## 7. 工程与回归

见 `M16_QUALITY_GATE_CLOSURE_DECISION.md` §交付（测试 / typecheck / build / E2E / Git / CI 实测）。

## 8. 预算

`budget/calls.jsonl` 230 行；真实调用 **224 / 260**（6 行为 DEVIATIONS #5 的重复记录）：S 生成 12、judge1 12、生产 188、judge2 12；重试 0；新增人工标注 0。
