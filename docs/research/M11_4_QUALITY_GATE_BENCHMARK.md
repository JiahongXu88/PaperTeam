# M11.4 Quality Gate Benchmark Set

> **日期：2026-10-06/07。执行代理：Claude Code。仓库：`D:\Projects\PaperTeam`（main）。**
>
> **目的：为 Option C（calibrated floor + relative non-regression + blocking hard gate）提供实证基准——在修复后的生产 digest（`splitSingleFileDigest` 64 块 + 句界安全截断）下测量 Reviewer 方差、各质量类别分布、可分性与相对 delta。**

## 0. 第一屏

| # | 问题 | 答案 |
|---|---|---|
| 1 | benchmark 覆盖多少 unique paper families？ | **4**（1 真实返修族 + 3 已发表顶会/期刊族） |
| 2 | 真实 human revision pairs？ | **1**（F1：pre-revision ↔ human final，唯一本地真实返修对） |
| 3 | known-good 锚点？ | 3（ByteTrack ECCV22 / OC-SORT CVPR23 / StrongSORT TMM23，arXiv LaTeX 源，公开） |
| 4 | known-bad 锚点？ | 1（synthetic：F1 基线剔除全部表格环境——仅敏感性检查，P5 级） |
| 5 | 每 anchor 采样数？ | 3（独立项目副本 = 独立会话，零历史泄漏） |
| 6 | 模型调用数？ | **64 次 GLM-5.3（63 = 21 样本 × 3 mode + 1 ping），全部 Coding Plan** |
| 7 | 修复后管线的 Reviewer 方差？ | **sd 0.6–3.1**（F1 族 0.6/2.3/3.0/8.6；published 族 1.7/1.7/3.1）——远低于修复前截断 digest 的 5.0–12.3 |
| 8 | known-bad 可分吗？ | **不可靠**：bad = 63/74/80（sd 8.6）与可接受锚点（≥70）大面积重叠；academicScore 对「定量证据被剥离」不敏感（fact guard 才是该缺陷类的确定性防线） |
| 9 | floor 校准状态？ | **PROVISIONAL / 未启用**：唯一真实返修族 N=1，且 known-bad 不可靠分离——任何绝对 floor 都无法声称已校准 |
| 10 | 推荐非回归容差？ | **10 分**（现行管线 sd ≤ 3.1 的 3σ+ 裕量；并覆盖旧截断口径 sd 5–12 的历史证据；与 `ACADEMIC_REGRESSION_DROP=10` 先例一致） |

## 1. Benchmark Inventory（§18 inclusion criteria）

机器可读清单：`D:\PaperTeamData\M11_4_QualityGateBenchmark\benchmark-manifest.json`（含每 case SHA256 / 字符数 / 章节数 / 表格数）。结果：`benchmark-report.json`（21 样本，逐样本 metrics + digest 覆盖率）。

| case | family | 类型 | 语言 | 来源 | 人类产出 | evidence 配对 | 适用 |
|---|---|---|---|---|---|---|---|
| f1-pre | F1-real-revision | pre-revision | zh | 冻结基线（SHA `423CF0E0C666…`，与 M10.3 台账一致） | ✓ | ✓（E001/E002，生产可比） | absolute / relative-delta |
| f1-human-final | F1-real-revision | acceptable-human-revised | zh | 冻结 v1（Attempt 2 freeze 后合法解封语境） | ✓ | ✓ | absolute / relative-delta |
| f1-candidate | F1-real-revision | paperteam-candidate | zh | Attempt 7 clean run `p-d12dc28ad850` rev-3 | ✗（PaperTeam） | ✓ | absolute / relative-delta |
| f1-bad-notables | F1-real-revision | known-bad-synthetic | zh | 确定性变异：剔除全部 `table*` 环境（11→0，-8.3KB） | ✗（mutation） | ✓ | sensitivity only |
| f2-bytetrack | F2-PUBLISHED | known-good-published | en | arXiv 2110.06864（ECCV 2022） | ✓ | ✗（无对应项目，fact 口径不可比） | absolute |
| f3-ocsort | F3-PUBLISHED | known-good-published | en | arXiv 2203.14360（CVPR 2023） | ✓ | ✗ | absolute |
| f4-strongsort | F4-PUBLISHED | known-good-published | en | arXiv 2202.13514（IEEE TMM 2023） | ✓ | ✗ | absolute |

诚实声明（§19–§21）：**unique paper family = 4，但真实 human revision pair = 1**。重复采样只估计 measurement variance，不增加论文样本量。known-good 为英文已发表论文（生产 digest 可见率 44–56%，低于 F1 族的 92–93%——2600 字符/块预算对长文的真实生产行为，解读时计入）。风格语料 fixture（`backend/test/fixtures/eval/style-corpus`）为段落级样本，不适合全文评分锚点，未纳入。

## 2. Digest 覆盖率（§25：REVIEW_INPUT_TRUNCATION 修复验证）

| case | digest chars | blocks（源节数） | 可见率 | 截断 |
|---|---|---|---|---|
| f1-pre | 39,967 | 36（35） | 0.93 | 2 块超预算（句界安全 + 系统注） |
| f1-human-final | 42,372 | 36（35） | 0.92 | 3 块 |
| f1-candidate | 42,682 | 36（35） | 0.92 | 4 块 |
| f1-bad-notables | 32,434 | 36（35） | 0.93 | 2 块 |
| f2-bytetrack | 30,140 | 17（17） | 0.56 | 8 块（per-block 预算） |
| f3-ocsort | 53,625 | 27（26） | 0.44 | 14 块（per-block 预算，总量 60k 兜底） |
| f4-strongsort | 35,769 | 20（22） | 0.55 | 9 块（per-block 预算） |

**结论：修复生效**——F1 返修稿全 36 块可见（44% → 92–93%），实验章整体不可见的问题不复存在。英文长文（>50k chars）受 per-block 预算约束可见率 44–56%，这是当前生产 digest 的真实边界（所有截断均句界安全 + 显式系统注，reviewer 不会误报为稿件缺陷）。

## 3. 分数分布（现行生产 digest，3 采样/anchor）

| group | scores | mean | median | sd | range | 实验充分性 | critical/blocking/major | U/C |
|---|---|---|---|---|---|---|---|---|
| f1-pre | 74/78/78 | 76.7 | 78 | 2.3 | 4 | 70–75 | 2.3/3.0/6.0 | 4.0/1.7 |
| f1-human-final | 73/74/74 | 73.7 | 74 | **0.6** | 1 | 65–68 | 2.0/2.7/6.7 | 4.0/1.7 |
| f1-candidate | 70/73/76 | 73.0 | 73 | 3.0 | 6 | 62–76 | 2.0/2.7/6.7 | 5.0/0.7 |
| f1-bad-notables | 63/74/80 | 72.3 | 74 | **8.6** | 17 | 55–78 | 2.3/3.3/6.7 | 3.7/3.0 |
| f2-bytetrack | 83/83/86 | 84.0 | 83 | 1.7 | 3 | 85–86 | 2.0/3.3/7.0 | 15.0/0.3* |
| f3-ocsort | 77/81/83 | 80.3 | 81 | 3.1 | 6 | 72–86 | 1.7/2.0/7.0 | 11.3/0.0* |
| f4-strongsort | 77/77/80 | 78.0 | 77 | 1.7 | 3 | 75–80 | 1.3/2.0/8.0 | 12.3/0.0* |

\* published 锚点无 evidence 配对，fact 口径 U 计数不可比（评审独立判断整篇论文，其 U 主要来自「审稿人不知内部实验细节」），只解读 academicScore。

### 3.1 关键判定

1. **方差坍缩（修复的直接收益）**：同一文本重复评审 sd 从截断口径的 5.0–12.3 降到 **0.6–3.1**。截断的随机性（哪些块进视图）是旧方差的主源。synthetic-bad anchor 例外（sd 8.6）——评审对「缺定量证据的论文」本身不确定。
2. **已发表论文带 = 77–86**（三族 mean 78.0–84.0，即使可见率仅 44–56%）。80 ≈ 顶会接收线在这个 reviewer 尺度上的位置。
3. **F1 真实返修族 = 70–78**：pre-revision（76.7）≥ human-final（73.7）≈ candidate（73.0）。人工终稿 9 样本中 **0 个 ≥ 80**（加上旧 CAL/VIS 口径 12 样本仅 1 个 82）。**80 作为 existing-paper 返修的绝对硬门 = 拒绝作者自己的终稿**（对 audit 结论的独立复核）。
4. **相对 delta**：human delta = **−3.0**、candidate delta = **−3.7**（vs 修复前 VIS 口径 human +4）。同量级、同方向——绝对分不能度量返修改善，非回归（不是绝对差）是正确的任务层语义。
5. **known-bad 不可靠分离**：strip-tables 变异（确定性删除全部定量表格）后仍有 1/3 样本得 80、实验充分性 78——**academicScore 对该缺陷类不敏感**；该缺陷类的确定性防线是 fact preservation（删除表格数值 = fact violation → SYSTEM_FAILED），不是分数。floor 不应伪装能拦截它。

## 4. Option C 参数推导

### 4.1 非回归容差 = 10（启用）

- 现行管线 F1 族 sd ≤ 3.0 → 10 ≈ 3.3σ 单样本噪声带；
- 覆盖旧口径（部分项目仍可能遇到高方差）的历史证据 sd ≤ 12 的下沿；
- 与 `revisionOutcome.ts` 既有 `ACADEMIC_REGRESSION_DROP = 10` 先例一致（同一数量级的「实质回退」判定）；
- 实证：human −3.0 / candidate −3.7 都在带内（真实返修的分数波动不被误判为回退）；跌破 10 分（如 76.7 → 66 以下）才判实质回退。

### 4.2 Academic floor：PROVISIONAL（默认不启用）

数据边界：
- 可接受真实锚点（F1 三态）min = 70（9 样本全部 ≥ 70）；
- known-bad median 74、max 80——**没有可用的分离缺口**；
- 唯一真实返修族 N=1，无法估计 false-reject 率的族间方差。

结论：**任何绝对 floor 都不能声称已校准**（§31）。默认 `academicFloor = null`（不阻断，`floorStatus = unavailable`）；文档化推荐值 **65**（= 全部 9 个可接受样本 min 70 之下留 5 分裕量；只拦截灾难性塌陷，例如 baseline 本身极差时非回归规则失效的场景），供作者显式开启：

```
PAPERTEAM_REVISION_TASK_ACADEMIC_FLOOR=65
PAPERTEAM_REVISION_TASK_FLOOR_STATUS=provisional
```

### 4.3 任务层 finding 语义（数据支持）

- blocking/critical 且归层为 revision_introduced / modified_existing → 任务 FAIL（真防线）；
- blocking/critical 且归层为 baseline_inherited（未被修订触碰的章节）→ 投稿风险清单，不阻塞任务（Attempt 7 的 VIS 5 条 critical 中 3 条属此类）；
- 灰区 claim（转述覆盖 0.4–0.6，实证 c-7b1a = 0.48）与 unknown-origin blocking → AUTHOR_DECISION_REQUIRED（不二值判罚）。

## 5. 与历史校准数据的关系（§60：不重复已有调用）

`D:\PaperTeamData\M11_4_QualityGateCalibration\`（37 次调用，12 样本 + 1 pairwise）全部在**旧截断 digest** 或 **VIS 全文 override** 口径下测量，已入库不复跑。本轮 64 次调用全部为**现行生产 digest** 的新锚点（新增 3 个 published family + synthetic bad + F1 三态重采样）——两套数据不可直接混用（digest 可见率不同），结论引用时注明口径。

## 6. Harness

`scripts/m114-quality-gate-benchmark.mjs`（新增；resume-by-key；`--dry` 只构建副本与 digest 覆盖率；`--ping` 连通性预检；`--only <case>` 单 case）。隔离纪律与 calibration 轮一致：源项目只读、副本写独立工作区、human final 仅评估语境、不跑 Writer/Planner/工作流、不进入正式 Acceptance。

## 7. Limitations

1. 真实 human revision pair = 1（F1）——所有「可接受」分布估计都来自单一论文族，族间泛化未知；
2. known-good 锚点为英文论文且 digest 可见率 44–56%，其分布对中文返修稿的参照性有限（记录为生产行为，不做跨语言断言）；
3. synthetic known-bad 只测了「表格剥离」一种缺陷类，且证明不可靠分离——**这不是 harness 失败，是 academicScore 对该缺陷类不敏感的实证**；
4. pairwise 未重跑（banked 1 次，candidate 4/5 维优于 human final——N=1 指示性，不进生产 gate，符合 §47）；
5. 方差估计基于 3 采样/anchor（21 样本），sd 的置信区间较宽（χ² 下界约为点估计的 0.5）。

## 8. 最终判定

**BENCHMARK_CALIBRATION_PARTIAL**：harness 可复现 ✓、family 数明确（4）✓、方差有测量（sd 0.6–8.6）✓、非回归容差有数据推导（10）✓；但 floor 不可校准（N=1 真实族 + known-bad 不可分离）——按 §52 保持 provisional/未启用，不伪装 COMPLETE。
