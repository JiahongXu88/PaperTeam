# M14.0.1 — Evidence-Based Workflow Decisions（基于证据的 M14 架构裁决）

> 日期：2026-10-14。基线 `main @ 1f983ff`。证据来源：[语料报告](M14_0_1_REAL_THESIS_PAPER_CORPUS.md)、[映射分析](M14_0_1_THESIS_PAPER_MAPPING_ANALYSIS.md)。被审查对象：[M14_0_THESIS_WORKFLOW_ARCHITECTURE.md](M14_0_THESIS_WORKFLOW_ARCHITECTURE.md)（§4 数据模型、§5 状态机）与 [M14_0_ENGINEERING_READINESS_AUDIT.md](M14_0_ENGINEERING_READINESS_AUDIT.md)（P0-1/P0-2）。
> 代码坐标在 `main @ 1f983ff` 上复核：`backend/src/workflow/kinds.ts:12-17` 仍为四类 kind；`grep thesis_from_papers|FrozenFact|ContributionLedger|ConsistencyLedger|InheritedFigure backend/src` 为空（**全部 M14.0 模型均未实现**）；`WriterService.ts:1340/1375/1579` 仍 `slice(0, 12_000)`；`definitions.ts:8632-8643` 仍 `slice(0, 24)` / `60_000` / `SECTION_DIGEST_BUDGET = 3600`；`ManuscriptService.ts:142` 仍 `ctexart`；前端 `NewProjectPage.tsx:191-194` 仍为占位。本文不修改代码。

## 0. 裁决摘要与置信度

- `thesis_from_papers` **仍然合理，但命名与输入契约需要修正**：真实学位论文的核心章确实是作者小论文的再现（10/10），但 6/10 还依赖未发表材料，1 组完全没有论文。建议第五类 kind 保留，输入改为「研究成果输入集」（已发表论文为主，兼容在投稿件/预印本/实验报告），禁止把"只接受已发表论文"写进产品边界。
- 10 个数据模型：**SUPPORTED 3、ADJUST 6、REJECT 0、INSUFFICIENT_EVIDENCE 1**（§2）。
- 工作流 11 步主干保留，但新增/改名三个节点：`scope_decision`（成果入选/排除）、`version_select`（跟随哪个版本）、`conflict_resolution`（同实验异值），并把「Fact Verification」改为「source_verified（相对所选版本）」（§3）。
- P0-1 / P0-2 的需求细化见 §5，仍是 M14.1 的首批工程任务。
- 置信度：**中等**。样本 9+1 组、CS 偏向、作者自存档偏差；但结论 0 中的七条核心观察在 ≥3 个独立案例中重复出现，且与 M14.0 设计的冲突点都是定性的（存在/不存在），不依赖比例精度。硕士样本不足使「最小可行硕士工作流」（§6）的置信度低于博士部分。

## 1. 对 M14.0 架构假设的证据审查

| # | M14.0 假设（出处） | 证据 | 结论 |
| --- | --- | --- | --- |
| H1 | 小论文以 `origin=AUTHOR_PAPER` 入 Literature Library，`manuscript/` 只放学位论文稿（§3.1） | 学位论文确实是新稿，不是任何一篇论文的修订；论文间无公共工作树 | **SUPPORTED** |
| H2 | 每篇论文有 `publicationStatus ∈ {published, accepted, under_review, preprint}`（§4.2） | 李谨杰 Submitted；宋品皓 2 篇预印本在答辩后才上传且未列入成果；张蒙第 6 章论文答辩后投稿；吴建军无论文 | **ADJUST**：加 `unpublished_manuscript` / `experiment_report` / `none`；状态带时间戳（答辩时 vs 现在） |
| H3 | 成果条目 `ContributionItem` 可由 LLM 从论文抽取并锚定 chunk（§4.3） | 论文 intro 的贡献列表与学位论文 1.2 的贡献重排是一对一可追溯的（范登平、白烨、Li Qimai 图 1.1） | **SUPPORTED** |
| H4 | 每个 confirmed contribution 恰有一个 owner 章（§5.1 步骤 5） | 一篇拆两章、多篇并一章；成果层面仍可唯一归属（ISCA 的"规则挖掘"归第 4 章、"HVR 实现"归第 5 章） | **SUPPORTED（成果级）/ REJECT（论文级）** |
| H5 | FrozenFact 从小论文确定性抽取后镜像为 `user_confirmed` 证据（§3.4） | 同实验异值 5 例；版本并存 4 例 → 抽取值可能不是作者想写的值 | **ADJUST**：三态 `extracted → source_verified(version) → author_confirmed`，加 `conflict` |
| H6 | 继承图资产 `InheritedFigureAsset` 以 PDF 抽图/LaTeX 图文件为单位（§4.8） | 表格是最主要继承单元，且常加列/删行；图用相同数据重绘 | **ADJUST**：新增表格级资产（单元格数据），图继承保留 |
| H7 | Reviewer/Gate 新增 `published_facts_zero_drift`（§3.4） | 零漂移对 95% 单元格成立，但真实作者会有意改值（更新实验）与无意改值（笔误 6.57/16.37） | **ADJUST**：规则输出三类——相同 / 已授权变更 / 未授权差异（阻断 Final） |
| H8 | `hitl.author_decision` 不含 approve 绕过（§5.4） | 真实论文中「写成局限/未开展」确有先例（Sahoo 第 4 章无结果；郑家麒 p107 承认无现场验证） | **SUPPORTED**，并增选项 `declare_unpublished_material`（作者提供材料） |
| H9 | 文献综述章用 `research.*` 补证即可（§6 问题 11） | 第 1–2 章占 16–31%，是真实的新写综述且结构固定（研究现状分 2–3 条线） | **SUPPORTED（M14 第一版）**，综述章应作为独立 gap 集合进入 `research.plan` |
| H10 | 术语/符号账本（§3.2） | 张蒙 1.9 全文符号表；Li Qimai 全局重命名；白烨 LASO-big 不一致；宋品皓数据集命名不一致 | **SUPPORTED**，并把「数据集/模型名」纳入账本 |
| H11 | 章节映射由系统提案 → 作者确认（§5.1 步骤 5） | 真实论文不含章级归属声明；映射只有作者知道 | **SUPPORTED**，但提案必须展示内容匹配证据（表格/公式对应），默认状态 proposed |

## 2. 数据模型逐项裁决

| 模型 | 裁决 | 真实案例依据 | 修改建议 | 必要性 |
| --- | --- | --- | --- | --- |
| `ThesisProject`（扩展 ProjectMetadata） | **ADJUST** | 输入不只论文（H2） | `sourcePaperIds` → `researchInputIds`；加 `defenseDate`（用于判断成果状态"答辩时/当前"） | 必要 |
| `SourcePaper` | **ADJUST** | 版本链（刘磊 PACT→TACO、白烨、Li Qimai v1/v3）、作者副本 "Revised 2016"、未发表稿 | 改名 `ResearchInput`，`kind ∈ {published_paper, accepted, submitted_manuscript, preprint, unpublished_manuscript, experiment_report}`；`versionId`（arXiv vN / DOI / 文件哈希）与 `supersedes[]`；`authorshipPosition`；`inThesisScope: proposed/included/excluded`（F 类排除是常态） | 必要 |
| `ResearchContributionLedger` | **SUPPORTED** | 1.2 贡献重排可追溯（范登平、白烨） | 加 `storylineOrder`（作者决定的章序）与 `relations.type += split_from / merged_with` | 建议 |
| `ThesisOutline`（两级） | **SUPPORTED** | 10/10 为章→节两级，6–8 章，每章「引言/…/本章小结」 | 加固定槽位：绪论的 1.x 研究现状子线、符号表（可选）、「在学期间成果」附录由 `ResearchInput` 自动生成 | 必要 |
| `ChapterSourceMapping` | **ADJUST** | 多对多（A2/A3）；映射无文本依据 | 条目以 `contributionId` 为键，论文级字段退为派生；加 `inheritedTableIds`；加 `versionRef`（跟随哪个版本）；`status` 默认 proposed，确认需作者 | 必要 |
| `ConsistencyLedger` | **SUPPORTED** | 符号表、重命名、命名不一致、图表重复印刷 | `kind += dataset_name, model_name, figure_table_numbering`；检查项加「翻译残留/悬空引用」（白烨「见附录」） | 建议 |
| `FrozenFact` | **ADJUST** | 同实验异值、版本并存、作者有意更新 | 状态机 `extracted → source_verified → author_confirmed`，并列 `conflict{values[], sources[]}`；每值带 `versionRef`；授权记录 `basis += author_updated_experiment`；**表格单元格为一等事实类型** | 必要 |
| `InheritedFigureAsset` | **ADJUST** | 表格为主；图重绘；新增列来自作者数据 | 拆为 `InheritedTableAsset`（cells + 来源 + 允许的增删列记录）与 `InheritedFigureAsset`（图像或 PlotSpec 重绘）；`captionOrigin += translated` | 必要 |
| `ChapterWritingState` | **INSUFFICIENT_EVIDENCE（语料）/ SUPPORTED（工程 P1-1）** | 语料不涉及运行时恢复 | 保留 | — |
| `ThesisTemplate` | **SUPPORTED** | 结构高度一致：声明/授权页、中英摘要、目录、绪论…总结、参考文献、成果、致谢、简历 | 模板声明「成果附录」与「原创性声明」槽位；不把任何高校格式设为标准 | 建议 |

不新增状态对象：以上调整都是字段级或改名级；唯一新增实体是 `InheritedTableAsset`（可作为 `InheritedFigureAsset` 的 variant 实现）。

## 3. 推荐的 `thesis_from_papers` Workflow（修订版）

原主干：`Import Papers → Contribution Extraction → Fact Verification → Author Confirmation → Thesis Planning → Chapter Mapping → Literature Supply → Chapter Writing → Consistency Review → Revision → PDF`。

修订版（变化加粗）：

```text
thesis.import_inputs（论文/手稿/实验报告，多篇；版本注册）
→ thesis.extract_contributions（逐篇；锚点 fail-closed）
→ thesis.freeze_facts（确定性：表格单元格/数值/公式/数据集/指标/基线；跨输入对账 → conflict）
→ **hitl.scope_and_version**（哪些输入入选/排除；版本链中跟随哪个；成果状态"答辩时/当前"）
→ hitl.contribution_confirm（成果确认 + storyline 排序）
→ **hitl.fact_conflicts**（仅当 conflict 非空：并存声明 / 取某值 / 作者更新 / 标记未发表）
→ thesis.outline_plan → hitl.outline_confirm（两级；绪论子线；符号表可选）
→ thesis.map_sources（以成果为键、带内容匹配证据）→ hitl.mapping_confirm
→ thesis.ledger_propose → hitl.ledger_confirm（术语/符号/数据集/模型名）
→ research.*（既有；gaps = 绪论/综述章 + 各章「本章与前章关系」缺口）
→ [hitl.author_decision]*（缺实验/缺材料；选项含 declare_unpublished_material）
→ thesis.write_chapters（章级；owner 章注入源文本投影 + 冻结事实 + 账本口径；禁止新增数值）
→ thesis.insert_inherited_assets（表格 + 图；确定性）
→ thesis.consistency_check（跨章符号/术语/数值/编号/翻译残留）
→ citation.verify → review.run(thesis, 分章) → quality.gate(thesis)
→ 修订 loop（planSharedTail）→ build.draft / build.final
```

- 「Fact Verification」语义改为 **source_verified**：抽取值与所选版本一致；不代表"真"。只有 `author_confirmed` 才能进入 Writer prompt 的「已发表事实行」。
- `hitl.scope_and_version` 与 `hitl.fact_conflicts` 是新 HITL。证据：F 类排除 6/10；版本链 4/10；冲突 5/10。两者都不能由系统决定。
- Writer 契约补充（依据 §2.5 映射分析）：核心章 = 「翻译/重排源文本 + 衔接段 + 本章小结」；绪论/综述章 = 证据驱动新写；**不得为表格补列、不得改基线值、不得删行**；凡源文本中的 "supplemental / see appendix" 一律转为缺口而非交叉引用。

## 4. 自动化与 HITL 边界

| 自动（确定性或可核验） | 只能建议 | 必须 HITL |
| --- | --- | --- |
| 版本注册与差异；单元格/公式/数值抽取；跨输入对账；章级源文本投影；成果附录生成；符号/术语/编号一致性扫描；翻译残留检测；分章 Review 与全文覆盖证明 | 成果排序与主线；章节映射（带证据）；术语归并；哪些综述子线需要补证 | 入选/排除；版本选择；冲突裁决；基线删减；未发表材料的使用范围；新增实验；符号重命名方案；答辩后成果状态更新 |

真实实验边界（§7.3 任务要求）：李谨杰 2.4 参数辨识、范登平表 2.3 新增列、宋品皓表 2.9、张蒙第 5 章——全部是**无法从任何论文推导的作者数据**；系统只能 (a) 走既有 Experiment Package 授权，(b) `write_as_limitation`，(c) `defer_chapter`。不存在第四条路。

## 5. 长文档工程能力（P0-1 / P0-2 需求细化）

### P0-1 长章节截断与整文件覆写（`WriterService.ts:1579`；`definitions.ts:2058-2060, 9336-9374`）

真实规模：核心章 12–26 页（范登平第 4 章 26 页、刘磊第 3 章 26 页、Li Qimai 第 5 章 40+ 页）≈ 15k–40k 字符 LaTeX，**全部超过 12,000 字符**。需求：
1. 修订目标必须是 `logicalSpan`（`\section`/`\subsection` 级）而非文件；章文件只允许局部补丁（现有 `locateLatexSections` 对 main.tex 的做法推广到 `chapters/**`）。
2. 事实保持与 lineage 以「冻结事实 ↔ 章节位置」为键：补丁后重跑 `published_facts_zero_drift` 只对受影响 span。
3. 继承表格区块标记为**不可修订区**（只能经 `InheritedTableAsset` 授权变更），Writer 补丁命中即拒绝。
4. 验收：对 ≥30k 字符章进行 3 轮修订，零 `unauthorized_fact_removal`、零整文件覆写事件。

### P0-2 长学位论文 Review 覆盖不足（`definitions.ts:8632-8643`）

真实规模：正文 100–200 页、6–8 章、每章 3–7 节 → 30–45 个节文件；24 节 × 3,600 字符的 digest 只覆盖约三分之一。需求：
1. 章级 Review：复用 `SectionReviewScheduler`/`ReviewContextBuilder`（D-0024），每章独立任务 + journal。
2. **全文覆盖证明**：Review 产物必须记录每个节文件的 `coveredChars/totalChars`，Gate 规则 `review_coverage_complete` 要求 100% 节被独立审过，否则 `academic_score_threshold` 不得判 PASS。
3. 跨章一致性 Review 单独一轮：输入 = ConsistencyLedger + 各章摘要 + `thesis.consistency_check` 的 findings（符号/数值/编号/翻译残留——本语料每类都有真实实例）。
4. `ReviewIssue` 增加第二位置（章 A vs 章 B），否则跨章 finding 无法落到两个修订目标。
5. 验收：对 ≥120 页论文，Reviewer digest 字符覆盖 100%、跨章一致性 finding 能复现本语料的四类人工发现（白烨 25.6M/27.6M；宋品皓命名不一致；Li Qimai 图重复；邓栋参考文献页码矛盾）。

## 6. 最小可行硕士学位论文工作流（置信度低于博士部分）

依据：李谨杰（1 篇在投论文 + 大量工程章）、宋品皓（3 章各对应 1 篇，其中 2 篇答辩时未发表）、郑烨（方法论文 + 工具论文，推断）、Sanyal（3 篇并列）。

MVP：输入 1–3 篇研究输入（允许在投/预印本）；成果确认与排序；两级大纲（绪论 / 相关知识 / 2–3 核心章 / 总结）；核心章由源文本投影 + 冻结事实写作；绪论用 `research.*` 补证；缺材料章走 `hitl.author_decision`；分章 Review + 一致性检查；Draft PDF。**不做**：多版本合并、继承位图、学校模板适配（用 generic-ctexbook）。

## 7. 建议的 M14.1 / M14.2 / M14.3 顺序（相对 Pre-M14 汇总 §10 的修正）

- **M14.1 事实与结构基础（修正）**：`ResearchInput` 注册（多篇、多版本、状态）+ FrozenFact 三态与冲突 + `InheritedTableAsset` + ContributionLedger + 两级大纲 + generic-ctexbook 组装（含成果附录槽位）+ **P0-1/P0-2**。相比原计划：把「版本/冲突/表格资产」提前，把「ConsistencyLedger 完整版」后移到 M14.2（先只做数据集/模型/符号名的确定性抽取）。
- **M14.2 章节工作流**：stage 定义 + `hitl.scope_and_version` + `hitl.fact_conflicts` + `hitl.author_decision` + 章级状态/恢复 + 一致性检查 + 两条 Gate 规则（`published_facts_zero_drift` 三态输出、`review_coverage_complete`）+ 前端入口。
- **M14.3 资产继承与真实验收**：图继承（PDF 抽图/LaTeX 图）+ PlotSpec 重绘 + 第一次真实 run。**验收语料建议直接用本研究的开放案例**：输入范登平的 4 篇 arXiv/CVF 论文（或白烨的 4 篇 arXiv 稿）生成 Draft，并与真实学位论文的章节结构、表格继承、成果附录做盲比；对李谨杰案例验证「在投稿件 + 缺材料章」路径。

## 8. 验收标准与主要风险

验收（M14 整体）：
1. 输入含 ≥1 篇未发表手稿时工作流不拒绝且不伪造发表信息。
2. 任何同实验异值在 `hitl.fact_conflicts` 前不得进入写作；Final 构建前 conflict 必须为空或已授权。
3. 继承表格单元格与所选版本 100% 一致（机械比对）；新增列/行只能来自 Experiment Package 授权。
4. 排除的论文不出现在正文（成果附录仍列出，状态为"未纳入"）。
5. Review 覆盖 100% 节文件；跨章一致性 finding 可定位两处。
6. 真实 run 产出的大纲与真实论文结构在章数、绪论子线、成果附录上一致（人工评分）。

风险：
- 作者自存档偏差使我们没有观察到"普通"论文；某些高校规范（如要求逐章注明发表情况）可能存在而未被采样（UNKNOWN）。
- 中文论文对英文论文是翻译关系：Writer 在翻译时的术语一致性（现有 academic-writing-zh 只针对证据写作）需要新的检查器；本语料中翻译残留与单位/舍入差异（0.049 vs 0.05）都会触发零漂移规则 → 需要「等价变换」白名单（复用 `factPreservation` B 类格式等价）。
- 开放获取论文对脚本不可得：产品必须以作者上传为主路径，`FullTextResolver` 只是辅助。
- 硕士样本不足：§6 MVP 的章数与材料假设需在 M14.3 真实 run 前用 2–3 份用户提供的硕士论文复核。

## 9. 预算与执行账本

| 项 | 上限 | 实际 |
| --- | --- | --- |
| 候选学位论文 | 30 | 30 篇全文 + 2 条元数据示例（32 记录） |
| 核验候选 | 15 | 15 |
| 正式配对 | 6–10 | 9（内地）+ 1 控制 |
| 全文深度研究 | 2–3 | 3（范登平、白烨、李谨杰）+ 7 中等 |
| 模型调用 | ≤100 | 10 个子代理会话（9 新建 + 1 恢复），约 2.04M 子代理 token（逐会话：250.5k / 198.8k / 162.6k / 147.7k / 302.6k / 219.4k / 195.7k / 187.8k / 171.2k / 199.0k）；主会话 token 不可精确读取；订阅环境 **USD 不可观测，未估算** |
| 墙钟 | 6 h | 04:57 → 约 07:35 UTC（≈2 h 40 min，含报告写作） |
| 外部 API | — | arXiv API、Crossref、Unpaywall、OpenAlex、Zenodo API、GitHub code search；无 CNKI/万方访问；无付费墙绕过 |
