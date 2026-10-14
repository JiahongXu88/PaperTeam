# Pre-M14 — academic-figure-skill 独立评估与 A/B/C 基准

> 日期：2026-10-13 → 2026-10-14（夜间长程任务）。执行：Claude Code（主会话；四个只读子代理负责姊妹报告）。基线：`main @ 215de15`（M13 COMPLETE — READY_FOR_M14）。
> **边界**：未安装 academic-figure-skill 到 `~/.claude/skills`；未新增任何 PaperTeam Renderer；未改任何产品代码。原始模型输出、会话日志、渲染图与本地看板保留在仓库外 `D:\PaperTeamData\AcademicFigureSkillEvaluation\`（不进 GitHub）；可复现脚本与协议副本见 [repros/pre-m14-academic-figure-skill/](repros/pre-m14-academic-figure-skill/README.md)。
> 姊妹报告：[PRE_M14_FIGURE_RENDERING_ARCHITECTURE.md](PRE_M14_FIGURE_RENDERING_ARCHITECTURE.md)（静态架构分析，§7 引用本文结果）、总汇总 [PRE_M14_OVERNIGHT_RESEARCH_SUMMARY.md](PRE_M14_OVERNIGHT_RESEARCH_SUMMARY.md)。

---

## 0. 一句话结论

**不值得作为可执行 Skill / Renderer 引入；值得部分借鉴。** 在同一模型（Fable 5.1）、同一任务、同一运行时约束下，注入该 Skill 的会话产出的图在视觉纪律上略优（人工评分 23.3 vs 22.5 / 25），并在 6/10 份交付中附带了「统计与可复现性报告」；代价是**中位成本 7.8 倍（6.07 vs 0.78 USD）、中位时长 4.2 倍（690 vs 163 s）、中位轮数 4.5 倍（50 vs 11）**，11 次会话中 5 次在 6 USD 等预算帽下被截断、1 次**零交付**。Skill 的核心机制「生产脚本 Copy-First」在 10 份交付中**一次也没有发生**（0 native run）：其资产脚本硬编码作者私有数据、依赖缺席的 R、与用户数据结构语义不匹配，模型全部退化为「参数继承」——即 Skill 实际起作用的部分只是**排版/配色/导出规范与 QA 清单文本**，这些可以作为常量与规则消化进 PaperTeam 的 codegen 与 Figure Truthfulness Guard，而不需要引入 Python/R 脚本执行面。PaperTeam 现有 TikZ/pgfplots 后端（臂 C）在数据真实性与确定性上无可替代，但在 8 个任务中只能表达 4 个（第 5 个需改动作者的图），且暴露了图例遮挡、中文刻度重叠、无误差棒/置信带/点标注/对数轴等明确落后项。

---

## 1. 评估对象

| 项 | 事实（本次实测，`gh api` + 本地 clone） |
| --- | --- |
| 仓库 | `TingxiYu/academic-figure-skill`，GitHub ★495 / 26 fork / 3 open issues，Apache-2.0，创建 2026-07-07，**最后推送 2026-07-12**（之后无提交） |
| 评估版本 | commit `1df9940dd01ac939f072b12fe28d6353b79b90f9`（`--depth 1` clone，150 MB 工作树） |
| 结构 | `SKILL.md` 29 KB（8 步工作流 + Copy-First 规则 + 4 遍 QA）；`references/` 16 份（typography / color-palettes / export-specs / journal-specs / checklist 27 KB / directory-map …）；`scripts/` 16 个工具（compose.py 586 行、qa_validator.py、check_* 四个检查器、eval/benchmark runner）；`assets/figures/` 32 目录（29 个有脚本）：**Python 脚本 51、R 脚本 20、数据文件 0**，预览 PNG 108 张 |
| 许可证 | Apache-2.0；README 明示示例图来自作者**私有数据资产**、「私有资产持续更新，关注公众号」 |
| 近似同类（仅元数据） | Azhi-ss/academic-figure-skills（★151，MIT，2026-10-12 活跃）、heyu-233/engineering-figure-agent（★307，MIT，Codex skill，支持中文论文）、sai-tv/academic-figures（★15，MIT）、wbopan/paper-figure（D3+Playwright）、shiran-yu/Academic-Figure-Figma-CC-Skills（Figma MCP）。本轮只深评 TingxiYu 一个（任务书指定），其余仅作生态坐标。 |

Skill 解剖的逐文件证据（硬编码数据、`np.random` 模拟数据、读取不存在的私有文件、QA 只做源码字符串匹配、R 面板栅格化贴图、Arial 基线与中文冲突）见姊妹报告 §3，此处不重复。

---

## 2. 实验设计（预先声明，见 `PROTOCOL.md`）

### 2.1 三臂

| 臂 | 定义 | 模型调用 |
| --- | --- | --- |
| **A 基线** | `claude -p --bare`（Fable 5.1，本机 CLI 默认模型）无头会话，统一任务提示词，不含任何 Skill 内容、不可读 Skill 目录 | 1 会话 / 任务 |
| **B Skill 注入** | 与 A 完全相同的会话与提示词，另在用户消息顶部**逐字注入 `SKILL.md`**（模拟 Claude Code 触发 Skill 的注入方式）+ `--add-dir` 只读挂载 Skill 目录（可读 references / scripts / assets，执行 Copy-First） | 1 会话 / 任务 |
| **C PaperTeam 现状** | 现有 `FigureCompiler`（pgfplots/TikZ → xelatex）由 Node 脚本驱动，同一数据集；**零模型调用**；只对 PlotSpec/DiagramSpec 能表达的任务出图 | 0 |

会话约束（A/B 相同）：`--max-turns 40 --max-budget-usd 6`（复制组按修正案 1 改 12）、`--dangerously-skip-permissions` + 显式禁用清单（pip / uv / conda / npm / git / curl / wget / Rscript / WebFetch / WebSearch / Agent）、隔离运行目录、`MPLBACKEND=Agg`。运行时 = Python 3.11 + matplotlib 3.11.2 + numpy + pandas，**无 seaborn、无 R、无 Graphviz、禁止装包**——刻意对齐 PaperTeam 服务器的「钉死的 Python 栈」。

### 2.2 任务（8 个，合成数据，固定种子，每个数值已知）

| id | 类型 | 语言 | 臂 C 可表达？ |
| --- | --- | --- | --- |
| t1 | 多方法 × 多数据集分组柱状 + 误差棒（benchmark 对比） | en | grouped_bar（无误差棒） |
| t2 | 消融柱状 + 误差棒 | **zh** | bar（ctex 中文；无误差棒） |
| t3 | 训练曲线：3 方法 × 3 种子 → 均值线 + ±1 std 带 | en | line（需操作者预聚合；无带） |
| t4 | 行归一化混淆矩阵热图 + 单元格标注 | en | **不支持** |
| t5 | 分布对比（箱/小提琴 + 全部样本点，40 序列 × 5 方法） | en | **不支持** |
| t6 | 2×2 多面板（标注散点 / 柱 / 曲线 / 热图） | **zh** | **不支持**（单面板） |
| t7 | 方法架构图（8 节点 / 9 边 / 分组容器 / 含反馈边） | en | DiagramSpec pipeline（**反馈边被拒**） |
| t8 | 速度–精度 Pareto 散点（对数轴 + 点标注 + 前沿线） | en | scatter（无标注 / 前沿 / 对数轴） |

设计意图：覆盖「常规统计图 / 实验对比 / 消融 / 热图 / 分布 / 多面板 / 架构图 / 标注散点」八类，中英各有，并让 4 个任务落在臂 C 的能力边界之外。t1 的任务文案含一处**与数据不符的结论声明**（「DanceTrack 差距最大」而数据是 MOT17 最大）——这是数据生成时的疏漏而非设计，但两臂都如实指出并拒绝按文案出图（见 §4.5），因此等价于一次意外的诚实性探针。

### 2.3 指标（`evaluate.py` 确定性计算 + 人工评分）

会话状态 / 成本 / 轮数 / 时长；**操作者重跑**（干净 `verify/` 目录执行 `figure.py`，pandas/numpy 读取与随机数调用全程插桩）；PDF 事实（pymupdf：矢量对象数、位图数、页宽 mm、字体表与嵌入、文本层标签召回、CJK 字体）；数据保真（读入行数 == CSV 行数、`np.random` 用途）；**Skill 自带 QA 检查器**（`check_colors / check_fontsize / check_dimensions / check_export`，作为「Skill 的尺子」报告，不作事实标准）；人工 5 维 × 1–5 评分（清晰 / 标注 / 配色与印刷 / 版式与字体 / 正确性，`visual_rubric.json`）。盲评未能实现（看板按 run id 命名；评分时臂身份可见），如实声明。

### 2.4 预算与协议修正

- 任务书上限 24 个独立生成会话。实际：**22 个有效会话 + 1 个无效试点会话 = 23**。无效试点（`runs/_invalid_pilot/`）：首版 runner 用 `--permission-prompts none` + Bash 允许清单，会话内 heredoc / touch / Edit 全部被自动拒绝 → A 臂零交付；该会话花费 0.63 USD，如实计入，配对的 B 会话未启动。runner 改为 bypass + 显式禁用清单后重跑。
- **修正案 1**（复制组启动前声明）：主实验 16 会话维持等预算 6 USD；3 个复制任务（t2 / t4 / t6 × 两臂）预算帽改为 12 USD（两臂同改），以观察 Skill 臂至少各完成一次。无任何主实验被重掷。
- 总模型成本 **75.21 USD**（A 11 会话 11.54；B 11 会话 63.03；无效试点 0.63）。账本 `runs/ledger.json` 逐会话记录 session_id / tokens / cost。

---

## 3. 结果

### 3.1 会话级（22 个有效会话）

| 臂 | n | 成本合计 USD | 成本中位 | 轮数中位 | 时长中位 s | 触顶（budget cap） | 交付 PDF | 严格重跑通过 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A 基线 | 11 | 11.54 | 0.78 | 11 | 163 | 0 | **11 / 11** | 7 / 11（4 份脚本未自建 `out/`，预建目录后全部通过） |
| B Skill | 11 | 63.03 | 6.07 | 50 | 690 | **5**（均在 6 USD 主实验；12 USD 复制组 3/3 完成于 5.1–6.8 USD） | 10 / 11（t2 r1 **零交付**：预算耗尽时仍在读 references / assets） | **10 / 10** |

Skill 臂的 token 结构解释了成本：单会话 cache_creation 17–20 万、cache_read 57–140 万 token（读 SKILL.md 29 KB + 多份 references + 多个资产脚本 + 预览 PNG），输出 3–4 万 token（含 NOTES 中的 QA 报告与统计报告）；基线臂 cache_creation 约 2 万、输出不到 1 万。

### 3.2 产物级（21 份交付 PDF）

| 指标 | A（11） | B（10） |
| --- | --- | --- |
| 矢量 PDF（有绘图对象、无位图） | 11 / 11 | 10 / 10 |
| 字体全部嵌入 | 11 / 11（Arial / Arial-Bold；zh 任务另嵌 SimHei 或 SimSun） | 10 / 10（同） |
| 页宽 vs 目标（±0.5 mm） | 11 / 11 | 7 / 10（t4 r1 91.5 vs 86；t6 r1/r2 151.9/151.5 vs 150） |
| 文本层标签召回（期望标签全部可抽取） | 11 / 11 = 1.0 | 10 / 10 = 1.0 |
| 中文：缺字形警告 / CJK 字体嵌入 | 0 警告；3/3 嵌入 | 0 警告；3/3 嵌入 |
| 数据保真：全部输入 CSV 全行读入 | 10/10 可测（t7 无 CSV） | 9/9 可测 |
| `np.random` 出现 | 1（t5 抖动点，固定种子） | 3（t5 抖动点固定种子；t4 r1 `seed(0)` 注释「未用随机」；t1 仅注释） |
| 「统计与可复现性报告」（Skill Step 7 强制项） | 0（未要求） | 6 / 10 |
| Skill 自带 QA：字体检查 | **11 / 11 FAIL**（脚本 `font.sans-serif` 列表含 `DejaVu Sans` 作回退 → 字符串匹配判失败，而 PDF 实际嵌入 Arial） | 10 / 10 PASS |
| Skill 自带 QA：尺寸检查 | 19 / 21 份脚本上 `check_dimensions.py` 超过 60 s 未返回（检查器挂起），不可用 | 同左 |

### 3.3 人工评分（/25，评分依据与缺陷备注见 `dashboard/visual_rubric.json`）

| 任务 | A r1 | B r1 | A r2 | B r2 | 备注 |
| --- | ---: | ---: | ---: | ---: | --- |
| t1 分组柱 | 23 | 24 | – | – | 两臂都加了对最强基线的增益标注，都指出任务文案的「DanceTrack 差距最大」不成立 |
| t2 消融（中文） | 23 | **0** | 23 | **25** | B r1 零交付；B r2（12 USD）是全组最佳中文图（y 从 0、基线虚线带值、箭头标 Δ） |
| t3 训练曲线 | 23 | 24 | – | – | B 额外用线型区分（灰度打印安全）；B 触顶但交付完整 |
| t4 混淆热图 | 23 | **19** | 23 | 23 | B r1 **版式缺陷**：总体准确率脚注压住 x 轴标题；宽 91.5 mm 超标 |
| t5 分布 | 23 | 22 | – | – | B 在图上打了未被要求的 `Wilcoxon P = 0.07`（由数据算出，非编造，但属未授权推断） |
| t6 多面板（中文） | 21 | 24 | 22 | 24 | A r1 拉丁字符落入 CJK 字体（混排不佳，r2 已修）；B 加「相对次优提升」行（5 个值逐一核对正确） |
| t7 架构图 | 23 | 24 | – | – | 两臂都完整表达 8 节点 / 9 边 / 分组 / 双向关系；B 有标题与弧形边 |
| t8 Pareto 散点 | 21 | 24 | – | – | A 的前沿线从被支配的 BoT-SORT 起画（严格非支配集应排除它）；B 阶梯线正确 |
| **均值** | **22.5**（n=11） | **23.3**（已交付 n=10；含零交付 21.2） | | | 配对 rep1：B 胜 5 / A 胜 2 / B 零交付 1 |

### 3.4 臂 C：PaperTeam FigureCompiler 现状（零模型调用）

| 任务 | 结果 | 耗时 | 可观察事实 |
| --- | --- | ---: | --- |
| t1 grouped_bar | ✅ | 3.6 s | 83.7 mm；CM/LM 字体嵌入；**图例（默认 north east、白底不透明）遮住 DanceTrack 的 Ours 柱**；无误差棒（PlotSpec 无误差列） |
| t2 bar（zh） | ✅ | 4.6 s | 138 mm；SimSun 子集嵌入（ctex 自动）；**五个中文类目标签首尾相接重叠**；图例「IDF1」冗余；无误差棒 |
| t3 line | ✅ | 3.3 s | 需操作者先按种子聚合（PlotSpec 无 groupby）；无 ±std 带；**图例遮住 epoch 33–60 的全部数据点**（TeX 中 60 点齐全，渲染被白底图例盖住；核对 193 个绘图对象无数据丢失） |
| t4 / t5 / t6 | ❌ 不支持 | – | 无 heatmap / box-violin / 多面板 plotType |
| t7 diagram | ❌ `invalid_spec` | 2 ms | 「edges 构成环：v1 模板只支持 DAG 流水线」——作者的反馈边 `mgmt→mem` 被明确拒绝（fail-closed，正确行为）；去掉该边后 ✅ 3.2 s，但宽 **250.7 mm**（超双栏）、标题与分组标签重叠、`memory bank` 无侧模块角色被排成首列 stage、长边交叉 |
| t8 scatter | ✅ 3.0 s | | 无点标注 / 前沿 / 对数轴 / 尺寸编码；标签召回 0.25（只有轴名） |

正面事实：全部 3–5 s 出图、字节确定（同 spec 同 figId）、数据 hash 绑定、中文经 ctex 与正文同字体、矢量 18–40 KB——这些是 A/B 两臂都没有的性质（LLM 生成脚本的确定性只到「同脚本同图」，脚本本身每次会话都不同）。

---

## 4. 分析

### 4.1 Skill 的哪一部分真的起了作用

10 份 B 交付的脚本首部「Asset Confirmation Table」全部写明 **`param inherit` / `cross-type inherit`，0 个 `native run`**。模型给出的理由与姊妹报告 §3.3 的静态发现一致：资产脚本把数据硬编码在源码里（`BarAblation/plot_bar_ablation.py`）、读取不存在的私有文件、语义不匹配（`ConfusionMatrix` 资产是扇区混淆图；`MarginalDensity` 是 2-D 密度）、或是 R 脚本（本机无 R）。因此 Skill 实际贡献 = `references/typography.md`、`color-palettes.md`、`journal-specs.md`、`export-specs.md` 的常量 + `checklist.md` 的 QA 清单 + Step 7 的统计报告模板。这些全是**文本规范**，可被确定性 codegen 吸收。

### 4.2 Skill 带来的可观测收益

- 视觉纪律更一致：灰度基线 + 单一强调色、图例外置、线型区分、尺寸贴合期刊栏宽（B 的尺寸偏差反而更多，见 §3.2——因为 Skill 让模型用 `bbox_inches="tight"` 后再修正，常超 1–5 mm）。
- 6/10 份附「统计与可复现性报告」（n 定义、中心统计量、离散度、检验、来源列映射）——对论文作者有真实价值，PaperTeam 的 caption↔dataset 真实性守卫目前不产出这种说明。
- 严格重跑 10/10 通过（A 7/11）：Skill 的 CL-x 检查促使模型在脚本内 `os.makedirs("out")`。

### 4.3 Skill 带来的可观测代价与风险

- 成本 7.8×、时长 4.2×、轮数 4.5×；等预算下 5/8 触顶、1/8 零交付。对 PaperTeam 的「单图秒级、确定性、可缓存」要求是数量级错配。
- 未授权推断：t5 B 在图上打了 Wilcoxon p 值；t6 B 加了相对提升行。两者数值都正确，但 PaperTeam 的 Figure Truthfulness Guard 口径是「图只呈现数据集中逐字节存在的数值，派生量须作者确认」——Skill 的「question-directed analysis」原则与此相悖。
- QA 工具质量：字体检查以源码字符串匹配，把合理的字体回退列表判 FAIL；尺寸检查器在 19/21 份脚本上挂起 60 s 以上。把这些脚本接进 CI 会制造噪音而非守卫。
- 维护信号：仓库自 2026-07-12 无提交；私有资产「公众号更新」；R 侧依赖（ComplexHeatmap/linkET/Bioconductor）在 Docker 镜像中代价高（姊妹报告 §4 维度 6）。

### 4.4 PaperTeam 当前明显落后的图型（由臂 C 直接证明）

1. **热图 / 混淆矩阵**（t4）、**分布图（箱/小提琴 + 样本点）**（t5）、**多面板组合**（t6）——完全不可表达。
2. **误差棒 / 置信带**（t1 / t2 / t3）——PlotSpec 无误差列与分组聚合；学术对比图几乎必需。
3. **标注散点 / 对数轴 / 前沿线 / 尺寸编码**（t8）。
4. **含反馈边或侧模块的架构图**（t7）——v1 DAG 模板正确地 fail-closed，但表达力不足；可表达时宽度失控（250 mm）与标签重叠。
5. **图例布局**（t1 / t3 图例遮数据；PlotSpec 的 legend 只有 on/off）与 **中文类目标签换行/旋转**（t2）。

这些都是 pgfplots/TikZ 本身完全能做的事（`error bars/.cd`、`fill between`、`matrix plot`、`boxplot`、`groupplots`、`nodes near coords`、`xmode=log`、`legend pos=outer north east`、`xticklabel style={rotate}`），差距在 PlotSpec/DiagramSpec 的表达面与 codegen，不在后端。

### 4.5 诚实性与可信度观察

- 两臂都在 t1 发现任务文案的结论与数据矛盾，并在 NOTES 与图注中拒绝断言「DanceTrack 差距最大」（A：「I annotated the honest numbers and flagged this」；B：「Data-integrity caveat for the author」）。这是模型自身行为，不是 Skill 带来的。
- 两臂 21 份脚本无一处用随机数生成数据（`np.random` 仅用于固定种子抖动点或空设 seed）；全部输入行数完整读入。本轮没有观察到任何「编数据」行为。
- B 臂会话对 Skill 目录的唯一写入是 `scripts/__pycache__/`（运行其 QA 检查器产生），无源码改动。

---

## 5. 结论与建议

| 问题 | 回答 |
| --- | --- |
| academic-figure-skill 值不值得引入？ | **不作为 Skill / Renderer 引入。** 作为参考资料**部分借鉴**：栏宽与字号下限 → `RenderOptions` 预设与 codegen 常量；受限配色 → pgfplots `cycle list`；QA 清单（AP-x / CL-x / VI-x）中与数据真实性相关的条目 → Figure Truthfulness Guard 的检查项候选；「统计与可复现性报告」→ 图资产的 `methodsNote` 字段（由数据集元数据确定性生成，不由 LLM 自由撰写）。Apache-2.0 允许常量级复用，需保留 NOTICE。 |
| A/B 的实际差异？ | 视觉纪律 +0.8 / 25（已交付样本），统计说明 6/10 vs 0，严格可复现 10/10 vs 7/11；代价 7.8× 成本、4.2× 时长、等预算下 5/8 触顶、1/8 零交付；0 次资产脚本原生执行；2 处未授权推断；1 处版式缺陷。差异不在正确性与数据保真（两臂全部通过）。 |
| 完整 Skill 还是部分借鉴？ | 部分借鉴（上表）。不借鉴：Copy-First 资产机制、R 面板栅格化贴图、`question-directed analysis`（与真实性守卫冲突）、其 QA 脚本。 |
| 多 Renderer 架构？ | 见姊妹报告：**采用 Contract + Renderer 注册表作为架构，但 M14 内 Renderer 集合仍只有 pgfplots-plot / tikz-diagram**。本实验补充的证据：LLM 生成脚本型 Renderer 的「确定性」只到会话内，不满足 figId 身份语义；若未来需要 Python Renderer，必须是**产品自有、版本化的模��脚本 + 数据注入 + 沙箱**，而不是 Skill 的脚本库。 |
| PaperTeam 下一步该补什么？ | 优先级：(1) PlotSpec 误差列 + 置信带 + 图例位置 + 刻度标签旋转（S）；(2) `heatmap` / `boxplot` plotType（M）；(3) `groupplots` 多面板 FigureIntent（M）；(4) scatter 点标注 / 对数轴 / 前沿线（S）；(5) DiagramSpec 侧模块角色 + 反馈边（有界布局，仍 fail-closed 于不可布局）+ 宽度约束（M）。全部在现有 TikZ 后端内完成，不新增运行时。 |

---

## 6. 可复核清单

- 协议与修正案：`D:\PaperTeamData\AcademicFigureSkillEvaluation\PROTOCOL.md`（副本已入库 `repros/pre-m14-academic-figure-skill/PROTOCOL.md`）。
- 账本：`runs/ledger.json`（22 条 + `runs/_invalid_pilot/ledger_pilot.json` 1 条）。每条含 session_id、tokens、cost、subtype。
- 每个会话目录 `runs/<task>__<arm>__r<n>/`：`prompt.txt`（完整提示词，B 含注入的 SKILL.md）、`command.json`（完整 CLI 参数）、`claude_result.json`、`session_std{out,err}.txt`、`figure.py`、`out/`、`NOTES.md`、`verify/`（操作者重跑 + `verify_meta.json` 插桩记录）、`verify2/`（仅预建 `out/` 的二次重跑）、`skill_dir_git_status.txt`（B）。
- 指标：`dashboard/results.json`（事实源）、`dashboard/results.md`、`dashboard/visual_rubric.json`、看板 `dashboard/index.html`（本地打开，含全部 22 + 6 张渲染图并排）。
- 臂 C：`paperteam-arm/run_arm_c.mjs`、`paperteam-arm/out/arm_c_results.json`、`paperteam-arm/out/store/fig-*.{tex,pdf}`、`paperteam-arm/out/*.spec.json`。
- Skill 源：`skill-source/academic-figure-skill`（git clone，`git status` 仅 `scripts/__pycache__/`）。
- 本机探针（姊妹报告 §5）：`scratch-arch/`。
- 脚本副本：`docs/research/repros/pre-m14-academic-figure-skill/`（make_tasks / run_ab / evaluate / dashboard / run_arm_c / PROTOCOL）。

未完成 / 限制：盲评未实现；每任务只有 1–2 次重复（方差未估）；合成数据而非真实论文数据；只评了一个 Skill；Skill 的 R 路径未测（本机无 R，且这是刻意的环境约束）。
