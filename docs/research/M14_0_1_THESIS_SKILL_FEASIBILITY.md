# M14.0.1 — Thesis Skill Feasibility（中文学位论文 Skill 可行性裁决）

> 日期：2026-10-14。基线 `main @ 1f983ff`。依据：[映射分析](M14_0_1_THESIS_PAPER_MAPPING_ANALYSIS.md) §2、[工作流决策](M14_0_1_EVIDENCE_BASED_WORKFLOW_DECISIONS.md) §3–4。现有 Skill 机制复核：`backend/skills/seed/` 五个受控 Skill（academic-review / academic-style-zh / academic-writing-zh / paper-search / verify-citations），路由在 `backend/src/skills/routing.ts`（role + contextScope 前缀；`ZH_ONLY_SKILL_IDS`），治理见 D-0025 / D-0030。本轮**未安装、未接入** Skill，也**未开展模型 A/B**。

## 0. 裁决：SELECTIVE

- **GO 的部分**：一个面向 Writer/Planner 的组织与写作方法 Skill，候选名 `thesis-chapter-expansion-zh`。它编码的是本语料中稳定重复出现的学术方法（成果主线重排、章结构槽位、源文本翻译/重排纪律、衔接段、符号统一、Review 清单），这些是「怎样写」的知识，可迁移、可用自然语言表述、与模型无关。
- **NO-GO 的部分**：任何把可靠性寄托于提示词的内容——作者身份、版本选择、事实状态、冲突检测、表格单元格一致性、成果归属、HITL、引用守卫。语料显示这些失败模式（同实验异值、选择性删减、版本合并、翻译残留）在**人类作者**的论文中都真实发生；提示词只能"提醒"，不能"保证"。它们必须由确定性代码（§2 的 Deterministic System 层）承担。
- 不建 `thesis-from-papers-zh` 这种覆盖整条流程的 Skill：流程编排属于 Workflow/Planner 层（D-0008/D-0014），不属于 Skill。
- **不开展大规模 A/B**：Pre-M14 的 academic-figure-skill 实验已证明 Skill 注入带来 7.8× 成本；本 Skill 的收益（结构与衔接质量）应先用 M14.3 真实 run 的确定性指标（§7）小样本验证，预算帽预声明。

## 1. 可迁移的学术方法（来自真实案例）

| 方法 | 语料依据（OBSERVED） | 可否用自然语言稳定表述 |
| --- | --- | --- |
| 成果识别与主线重排：把各论文的贡献列表重排为「问题 → 数据/方法 → 评测」一条线，章序 ≠ 发表序 | 范登平 1.2；白烨图 1.3「三个递进」；来斯惟 词→文档；邓栋 抽取/连接/检索；Li Qimai 图 1.1 | 是 |
| 章结构槽位：绪论（背景/现状 2–3 子线/内容与组织）、相关工作或预备知识（可含符号表）、核心章（引言-方法-实验-本章小结）、总结与展望、成果附录 | 10/10 | 是 |
| 核心章写法 = 源文本翻译/重排 + 术语统一 + 本章小结，而不是语言扩写；篇幅增量放在新章节 | 表格逐位相同；核心 ≈ 论文长度（范登平第 3 章 16 页 ≈ SOC 17 页） | 是 |
| 跨章衔接：后章显式引用前章模块（李谨杰第 5 章 = 第 3 + 第 4 章）、共享评测工具（来斯惟）、统一框架章（Li Qimai 第 3 章） | 4 例 | 是 |
| 符号/术语/数据集名统一与全局重编号 | 张蒙 1.9；Li Qimai 重命名；宋品皓命名不一致（反例） | 是（指导）；检查需代码 |
| 版本处理原则：跟随期刊扩展版、引用会议版为起源、明示差异 | 刘磊、白烨 | 是（原则）；选择需作者 |
| 不删不利基线、不改单元格、不补列；差异一律写成「与发表版不同之处」 | 白烨、来斯惟、范登平、宋品皓的反例 | 是（禁止项）；执行需 Guard |
| Review 清单：同指标跨章异值、模型/数据集命名、图表重复、翻译残留（见附录/supplemental）、参考文献页码矛盾、成果列表与正式版不一致 | 白烨、宋品皓、Li Qimai、邓栋、Sahoo | 是（清单）；检测需代码 |

## 2. 三层职责边界

| 层 | 承担 | 不承担 |
| --- | --- | --- |
| **Skill**（`thesis-chapter-expansion-zh`，注入 writer 与 planner 的 thesis 作用域） | 上表方法；禁止行为的提醒；输出形态规范（章小结、衔接段、差异说明段） | 任何判定、任何事实来源、任何状态变更 |
| **Workflow / Planner** | 节点顺序（决策报告 §3）、章级进度与恢复、HITL 触发、研究缺口生成 | 写作风格 |
| **Deterministic System** | ResearchInput 版本注册；身份核验证据登记；FrozenFact 三态与 conflict；InheritedTable 单元格比对；成果归属与排除；ConsistencyLedger 扫描；Citation/Fact/Scope Guard；Review 覆盖证明；HITL 持久化 | 学术组织判断 |

## 3. Skill 规范草案：`thesis-chapter-expansion-zh`

### 3.1 适用范围
`workflowKind = thesis_from_papers`、语言 zh 的 Writer 任务（`writing/thesis/*`）与大纲规划任务（`planning/thesis/*`）。不用于 Reviewer（Reviewer 侧的清单由确定性 `thesis.consistency_check` 与 academic-review 承担）。

### 3.2 输入契约（由任务 prompt 提供，Skill 不自行获取）
- 本章在 `ChapterSourceMapping` 中的角色（owner / reference）与对应成果条目摘要。
- 源文本投影（所选版本的相关节，已翻译或原文）与**已 author_confirmed 的冻结事实行**。
- ConsistencyLedger 的 canonical 术语/符号/数据集名。
- 前序章节摘要与「本章与前章关系」说明；研究缺口的证据列表与允许的 cite key。
- 本章目标长度与禁区（继承表格区块标记）。

### 3.3 输出契约
- 仅本章（或本节）LaTeX 片段：`\section` 级，不含 `\documentclass`/`\chapter`（由 staging 提升）。
- 结构：引言（含与前章衔接 1 段）→ 方法/实验（源文本重排）→ **「与已发表版本的差异说明」段（若任务给出 conflict/授权变更）** → 本章小结。
- 不产出任何新数值、新基线、新表列；表格位置以占位符 `% INHERITED_TABLE:<assetId>` 交给确定性插入。
- 对源文本中的 "supplemental / see appendix / 见附录" 一律改写为明确缺口注记 `% GAP:<描述>`，不生成交叉引用。

### 3.4 操作步骤
1. 读成果条目 → 用一句话写出本章在主线中的位置（引用前章编号）。
2. 把源文本按「问题-方法-实验-结论」重排，术语替换为 canonical；保留全部公式与数值原样。
3. 对每个冻结事实行核对正文出现的数值是否一致；不一致则不写数值、留 `% GAP`。
4. 写本章小结：只概括本章已写内容，不预告未写实验。
5. 自检禁止项清单（§3.6）。

### 3.5 真实案例支持的启发式规则
- 期刊扩展版优先于会议版作为源文本（刘磊、白烨）；会议版只在「起源」句中引用。
- 核心章长度 ≈ 源论文长度（±30%）；超出部分应来自衔接与小结，不是方法重述。
- 绪论研究现状按 2–3 条子线组织，每条子线末尾落到本文定位（李谨杰 1.2.1–1.2.3）。
- 一篇论文拆两章时，两章各自需要独立引言与小结，共享的背景只在前一章写（刘磊第 4/5 章）。
- 若成果列表中有被排除的论文，正文不提及；只在成果附录由系统列出。

### 3.6 禁止行为
不补实验、不补数字、不补表列、不删基线行、不"统一"冲突值、不把 arXiv 多个版本混写、不写「本章成果已发表于」除非任务给出已确认的归属、不把翻译残留当作交叉引用、不改 cite key、不写任何 `\includegraphics`/tikz（沿用 writerGraphicsGuard）。

### 3.7 错误恢复策略
- 源文本投影缺失 → 只写引言与小结框架并标 `% GAP:source_missing`。
- 冻结事实与源文本矛盾 → 不写该数值，标 `% GAP:fact_conflict:<factId>`，由 Workflow 触发 `hitl.fact_conflicts`。
- 账本缺少某术语 → 使用源文本原词并标 `% TERM_UNRESOLVED:<词>`。
- 任何时候不得用「约」「大约 15%」填充。

### 3.8 示例（缩略）
输入：成果 C003「SOC 数据集」(owner=第 3 章)，源文本 = ECCV18 §3 的中文投影，冻结事实 = 表 3.2 的 14 个值（author_confirmed），账本：`显著性物体检测`、`属性`。
输出：`\section{引言}`（1 段背景 + 1 段「第二章已指出现有数据集偏差；本章构建 SOC…」）→ `\section{SOC 数据集}`（重排 §3.2.1–3.2.7）→ `% INHERITED_TABLE:tbl-soc-stats` → `\section{讨论和结论}`（小结，无新数值）。若任务附 conflict（如表 4.3 行），输出加一段「与发表版本 [cite] 相比，本文表 X 的 Y 行采用了作者于 Z 更新的实验结果」——只有在作者已选择 `author_updated_experiment` 时才允许。

### 3.9 与既有能力的关系
- 与 `academic-writing-zh` 并存：后者管证据绑定写作纪律，本 Skill 管学位论文的组织与继承纪律；两者同时注入 writer 的 thesis 作用域。
- 复用 D-0030 的接入方式：seed 目录 + `skill.json` + PROVENANCE（本 Skill 为 PaperTeam 原创，无上游）；路由新增 `(writer, writing/thesis)` 与 `(writer, planning/thesis)`；`ZH_ONLY_SKILL_IDS` 加入。
- 不替代任何 Guard：Scoped Patch、Fact/Citation Preservation、Named Reference Guard、`citation_unknown_key` fail-closed 照常生效。

### 3.10 未来 A/B 验收标准（小样本、预算帽预声明）
- 语料：范登平或白烨的开放论文集（无版权问题）→ 生成 Draft。
- 两臂：有/无 Skill，同模型、同 prompt、同输入；每臂 ≤ 6 次 run，总预算帽 ≤ 15 USD 或等价 token 上限，先于实验写入协议。
- 确定性指标：禁止项违规数（新增数值、删行、改值）、`% GAP` 正确率（与人工标注缺口对照）、章结构槽位完整度、术语 canonical 命中率、衔接段存在率；人工评分只做辅助。
- 通过线：禁止项违规两臂均为 0（这是 Guard 的职责，不是 Skill 的）；Skill 臂在结构/衔接/术语三项上不劣于基线且成本 ≤ 1.5×。否则 NO-GO 并保留方法文本作为 Writer prompt 的固定纪律段。

## 4. 成本与可靠性分析

- 成本：Skill 文本预计 6–9 KB（远小于 academic-figure-skill 的 29 KB + references），不带脚本与资产；按 Pre-M14 经验，注入成本增量应在 1.2× 以内，但必须实测。
- 可靠性：Skill 不承担任何可靠性义务；本语料的七类真实缺陷中，可由确定性检查覆盖的有五类（异值、命名不一致、图表重复、翻译残留、参考文献矛盾），两类（选择性删减、版本混合）需要作者在 HITL 中决定。Skill 的作用是减少 Writer 制造这些缺陷的概率，不是消除。
- 风险：Skill 若写进「本章成果发表于…」模板，会在成果状态未确认时产生虚假归属——因此 §3.6 把它列为禁止项，归属声明由系统从 `ResearchInput` 生成。

## 5. 不做的事（本轮）
不安装 Skill、不改路由、不接 Runtime、不跑 A/B、不写 `thesis_from_papers` 代码。下一步在 M14.2 完成 HITL 与 Guard 后，再按 §3.10 启动小样本验证。
