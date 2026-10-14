# M14.0 — 面向学位论文工作流的工程瓶颈审计（工作包 D）

> **日期：2026-10-13。执行：Claude Code（Pre-M14 只读审计子代理）。基线：`main @ 215de15`（M13 COMPLETE — READY_FOR_M14）。只读审计，未改任何产品代码；未运行 vitest / dev 栈 / 模型调用；唯一写操作是本报告。度量只用 `wc` / `du` / `grep -c` / `ls` 对仓库源码与 `D:\PaperTeamData\*\projects\` 下既有验收项目目录（只统计文件数 / 大小 / 形态，不读取论文内容）。**
>
> **一句话判定：不存在阻碍 M14 *开始* 的 P0 技术风险，但存在 2 项 P0——不修则学位论文规模的真实验收必然在「修订」与「全文审稿」两个环节失效——必须作为 M14 的第一批工程任务，而不是等到验收时才发现。** 其余 7 项 P1 中有 4 项与 M13 Final Closure 的 M14 Handoff 已登记的「新能力」重叠（章节结构 / 一致性账本 / 已发表成果继承 / 多来源合并），本报告把它们落到代码坐标与隐藏硬编码常量上；3 项是 Handoff 未提到的隐藏缺口（写作阶段无章节级幂等、图片资产无继承入口、多来源事实冲突零检测）。文件后端 **不触发** M13.0 的 SQLite 复评条件。

每条论断按三类标注：**[已实现]** = 代码中存在的机制；**[缺口]** = 可用代码坐标证明的缺失或硬限制；**[推断]** = 由常量外推的规模估算，未实测。

---

## 0. 摘要

| 级别 | 数量 | 条目 |
| --- | ---: | --- |
| **P0** | 2 | P0-1 多文件章节修订的 12,000 字符截断 + 整文件覆写；P0-2 Review digest 覆盖上限（3,600 字符/节、60,000 字符总量、24 节）使 Quality Gate 对长文只审局部 |
| **P1** | 7 | P1-1 写作阶段无章节级幂等复用（重试 / 恢复重写全部章节）；P1-2 大纲 / 模板结构硬上限（≤12/20 节、单层、≤5,000 词、ctexart）；P1-3 图表资产无「已发表图片」合法入口且单图只能放一处；P1-4 多来源导入零事实冲突检测、项目 = 单稿件；P1-5 零跨章一致性检查（术语 / 符号 / 数值）；P1-6 修订计划 ≤20 条/轮 × 默认 2 轮；P1-7 Writer 共享会话轮转后零记忆迁移（跨章连贯性只靠 B2 组织） |
| **P2** | 5 | 实验观测 100 条截断；Evidence 渲染 / 分配上限；Reviewer 单位置 issue；survey 路径逐节 cite 白名单对跨章复用的约束；大纲只能 feedback 重规划 |
| **P3** | 3 | RevisionStore 全量快照含图表资产；EvidenceStore markUsage 逐条全文件重写；events.jsonl 全量回放 |

P0 的判据严格按任务定义：P0-1 是确定性数据丢失路径（守卫会拦下，但循环因此无法收敛）；P0-2 使 Gate 的 `unsupported_critical_claims_zero` / `academic_score_threshold` 只对全文的一部分成立——学位论文验收要求的「真实可检查的质量结论」在结构上不成立。两者都不是优化建议。

---

## 1. 十问逐项

### Q1 Context Packing 能否处理长篇学位论文（8–10 章、6–10 万字、100+ 文献、几十条冻结事实）

**代码坐标与硬编码常量（全部 [已实现]，按链路分组）**

| 链路 | 常量 / 截断 | 坐标 |
| --- | --- | --- |
| token 估算 | CJK 1.5 token/字符，其他 4 字符/token（保守高估） | `backend/src/runtime/pi/contextBudget.ts:28-29, 49` |
| 输出预留 | reserve = min(maxTokens, ⌈window×25%⌉, 32,768) | `contextBudget.ts:145-149, 160-175` |
| 会话轮转 | usage + 下一 prompt + reserve > window → rotation；usage 不可得时 runCount ≥ 32 → rotation；auto-compaction 关闭 | `backend/src/runtime/PiRuntimeAdapter.ts:1810-1830, 1837-1838, 214, 909-911` |
| 检索打包 | 默认 6,000 token，工具上限 24,000；chunk target 400 / max 600 / overlap 60 | `backend/src/retrieval/contextPacker.ts:43`、`retrieval/tools.ts:24, 119-123`、`retrieval/chunking.ts:31` |
| Writer 证据 digest | 每节渲染 ≤20 条（survey 24）；claim 截 150、quote 截 2,000 字符；src 标题截 60 | `backend/src/writer/WriterService.ts:2075, 2098, 118-121` |
| Writer 证据分配（B2） | FORMAL_EVIDENCE_LIMIT=20（旧路径）；B2 路径取全部 formal 再按节分配：develop 12 / compare 20 / framing·conclude pinned 4 | `backend/src/evidence/EvidenceSelectionService.ts:33, 99, 137`、`evidence/sectionEvidenceAllocation.ts:64-69`、`backend/src/workflow/definitions.ts:5507-5513` |
| Writer 工具视图 | evidence_query 返回 ≤50 条 | `backend/src/evidence/tools.ts:220` |
| 大纲 | prompt 要求 4–12 节；解析硬截 20 节；keyPoints ≤10；targetLengthWords 夹到 [50, 5000] | `WriterService.ts:1877, 1945, 1786, 1805-1806, 1812` |
| Reviewer 稿件 digest | 每节 3,600 字符（句界安全切 + 系统注）；最多 24 个 section 文件；总量 60,000 字符 | `definitions.ts:8632-8643, 8686-8689` |
| Reviewer 证据 digest | ≤20 条，quote 截 2,000 | `backend/src/agents/ReviewerService.ts:611-614` |
| 修订 prompt | 章节当前内容 `slice(0, 12_000)`（仅单文件 main.tex 整文件目标不截断）；摘要 4,000 | `WriterService.ts:1579, 1508, 1340, 1375` |
| 实验观测 | 工作流上下文 ≤100 条，超出标 truncated | `backend/src/experiments/ExperimentPackageService.ts:165, 542, 1241` |
| 其余截断 | WriterService 32 处 `slice(0,`、definitions 94 处 | `grep -c` |

**学位论文规模推算 [推断]**（设 10 章、全文 8 万汉字 ≈ 每章 8,000–12,000 字符 LaTeX、120 篇文献、40 条冻结事实、300–500 条 Evidence）：

1. **写作侧可容纳**：B2 逐节分配后每节 prompt ≈ 固定纪律 1.8k 字 + ≤20 条证据 × ≤2.15k 字符 ≈ ≤45k 字符（≈ 65k 估算 token，真实 0.6–1.1/字 下约 30–45k），200k 窗口模型单节无压力；bibliography key 列表 120 个 key 仅 2–3k 字符。300–500 条 Evidence 经分配不会整体注入。**不在此截断。**
2. **大纲侧截断**：10 章可表达（≤12），但 **章节是单层 `sections[]`**——学位论文的 3.1/3.2 子节无法作为独立写作 / 修订 / 分配单元；`targetLengthWords ≤ 5,000` 把单章正文上限锁在 5,000 词，10 章 ≤ 50,000 词；每章只能由一次 Writer 调用产出（`WriterService.ts:455-470`），输出受 reserve ≤32,768 token 限制（≈ 2 万汉字，够一章）。→ 见 P1-2。
3. **审稿侧截断（P0-2）**：10 章 × 10k 字符 = 100k 字符 → 每节切到 3,600 → digest ≈ 36k 字符，**Reviewer 看到约 36–45% 正文**；若章节文件 > 24 个（含子节文件）则多余文件整体不进 digest（`definitions.ts:8632`）。这是 M11.4 曾实证的同一类缺陷（旧「≤18 块」上限让 reviewer 只见 44% 正文、三轮实验充分性恒 25/35，`definitions.ts:8695-8706` 注释自述）——当时的修法是把单文件路径上限提到 64，但分节路径的 24 × 3,600 / 60k 未动。
4. **修订侧截断（P0-1）**：任一章节文件 > 12,000 字符时，修订 Writer 只看到前 12,000 字符（`WriterService.ts:1579`，`wholeFile` 只在单文件 main.tex 为真：`definitions.ts:2064, 2103`），而 `sections/*.tex` 目标没有 `logicalSpan`（`definitions.ts:9336-9364` 的 `add()` 不设 span；`:9368-9374` 只对单文件 main.tex 切 span），输出 **整文件覆写**（`definitions.ts:2568-2572`）。截断尾部的数字 / 引用 / 公式随即「被删除」→ 候选级 `citation_removed`（`:2275-2277`）与 Fact Preservation `unauthorized_fact_removal` 拒绝 → 条目 rejected → 下一轮再派发同样失败 → `hitl.revision_stalled`。**对 > 12k 字符的章节，修订在结构上不可能成功。** 8–12k 字符是学位论文章节的常态而非极端。
5. **Reviewer prompt 总量**：60k 字符 digest + 20 条证据 ≤43k 字符 ≈ 103k 字符 → 估算 ≈ 150k token（真实约 70–110k）。200k 窗口 + 32k 预留可容纳；128k 窗口模型会在 `checkContextBudget` 受理前被拒或触发 rotation——M14 若用小窗口模型做 Reviewer 需先验证。

**影响范围**：writing.sections（可容纳）、review.run（P0-2）、revision.revise（P0-1）、outline.plan（P1-2）、experiments（P2）。
**复用与修复建议**：Reviewer 改走 D-0024 已有的「每节受控上下文」路径（`backend/src/paper/ReviewContextBuilder.ts:21-27` 预算分项；`paper/SectionReviewScheduler.ts`；`definitions.ts:6815-6880` `review.sections` 已有 ≤40 节、3 并发、3 次重试、journal 落盘）而不是放大 digest；修订目标对 `sections/*.tex` 用 `locateLatexSections` 切 `logicalSpan`（`definitions.ts:9368-9374` 已有对 main.tex 的同款实现）并走 `checkRevisionScope`（`backend/src/review/revisionScope.ts:131`），彻底取消 12k 截断。
**优先级**：P0-1、P0-2、P1-2、P2（观测 / 证据上限）。

---

### Q2 长文档多章节 Writer 是否容易重复或遗失前文

**[已实现] 前文传递方式**：`buildSectionPrompt`（`WriterService.ts:2024-2100`）**不含任何前文正文或摘要**——只有大纲标题列表（`:2066-2068`）、本节要点、B2 任务块（role / task / doNotExplain / 长度上限，`backend/src/writer/argumentUnit.ts:25-44`）与本节分配证据。前文「可见性」完全来自同一项目所有章节共用一个 Pi 会话（sessionKey = `agent:{writer}:paperteam-{projectId}--writing/sections`，`backend/src/runtime/sessionKey.ts`；M13.7.7 §1.1 已证），即历史消息里前几章的完整 prompt 与输出。

**[缺口]**
- 会话轮转（context_budget 或 runCount ≥ 32）后 **不做任何摘要迁移**（`PiRuntimeAdapter.ts:1810-1838`；auto-compaction 关闭 `:909-911`），模型只剩系统提示 + 当前 prompt。10 章 × （prompt ≤45k 字符 + 输出 ≤15k 字符）≈ 60 万字符历史 ≫ 任何窗口，**学位论文写到中段必然轮转**，之后章节对前文零可见。B2 的 doNotExplain 由 owner 节确定性派生（`argumentUnit.ts:16`），不依赖会话记忆——这是对的方向，但它只覆盖「不重复解释概念」，不覆盖「前文已定义的符号 / 术语 / 数据集名称」。
- M13.7.7 的实证结论（§1.6 归因表）：重复的首要驱动是「相同证据 × 固定长度 × 仅引文事实」而非看不见前文；M13.7.11 §3.2 同条件 A/B：生产 Survey 路径有害重复下界 0.0%，B2 收益是组织性的。**即当前没有「遗失前文导致不一致」的实证，也没有「跨章遗失」的检测器**——缺的是观测而非证据。
- 确定性跨节复述探测器 `backend/src/review/crossSectionRedundancy.ts`（308 行）**仍未接入** review.run / Gate / Revision；生产只接了 `academicRedundancyClassifier` 作为 style reviewer 的只读 digest（`definitions.ts:5424, 5620`；`ReviewerService.ts:199, 274`），且 M13.7.11 §5.3 记录其对「重复免责」召回低于人工。

**影响范围**：10 章学位论文的后半章节；特别是符号表 / 数据集 / 基线名称这类「前文定义、后文沿用」的信息。
**复用与修复建议**：把 M14 Handoff (b) 的「一致性账本」做成 Writer 输入的一等字段（与 argument unit 同级：`definedSymbols` / `datasets` / `baselines` 由前序章节确定性抽取——`backend/src/manuscript/latexHeadings.ts`、`review/styleInvariants.ts:207` 的正文抽取可复用），不要靠会话历史；接入 crossSectionRedundancy 作为 reviewer style digest 的第二位置输入（M13.7.7 §6 方案 C 的前置）。
**优先级**：P1-7（轮转零迁移）、P1-5（见 Q3）。

---

### Q3 是否存在可靠的章节间事实一致性检查

**[已实现]（全部节内 / 文件级）**
- `revision.validate` 四类复核「归因粒度 = 文件级」（`backend/src/review/revisionValidation.ts:19-22`）；Fact Preservation 对 **每文件** 数字多重集 / 表格 / 公式 / 方向句比较（`backend/src/quality/factPreservation.ts` 2,486 行；`revisionBaseline.ts:46-53` `numbers: {file, tokens}[]` 按文件分桶）。
- Cumulative Fact Preservation 以导入 rev-1 冻结基线对账全稿（`backend/src/quality/cumulativeFactPreservation.ts:1-30`）——是「全文 vs 基线」而非「章 vs 章」。
- Claim Strength / claimStance / claimGrounding 全部句级、单节归属（`ReviewerService.ts:48, 99` `ReviewIssue.section: string` 单值；`review/finding.ts`）。
- 受保护术语：`manuscript/glossary.json` 可选（`definitions.ts:3495-3506`，≤200 条），只用于 Style Polish 不变量「出现次数不减少」（`styleInvariants.ts:43-44, 330-350`），不是术语一致性。Style reviewer prompt 提到「术语漂移」（`ReviewerService.ts:629, 636`）——LLM 观察，无确定性对账。
- **唯一跨文件机制**：Named Reference Provenance Guard 的允许词表 = 修订前全部稿件文本 + 证据 + 参考文献（`backend/src/review/namedReferenceGuard.ts:12-16`）。

**[缺口]**
- 全库无「章 A 的数值 / 符号 / 术语 vs 章 B」比较：`grep "术语|terminology|notation|符号一致"` 只命中 `factPreservation.ts:1810-1824` 的公式符号重命名配对（同文件内 before/after），无跨文件实现。
- Quality Gate 30 条规则（`backend/src/quality/gates.ts:389-731`）无一条跨章规则。
- Reviewer 在 digest 模式理论上能看到多章（但受 P0-2 截断），而 `ReviewIssue` 只有一个 `section`，无第二位置 / quote 字段——即使 LLM 发现「第 3 章 92.1% 与第 6 章 92.4%」也无法结构化落地到两个修订目标。

**影响范围**：学位论文最典型的失败模式（摘要 / 引言 / 实验 / 结论四处引用同一指标不一致；符号在方法章与实验章不同）。
**复用与修复建议**：用 `revisionBaseline.ts` 的提取器（表格 / 数字 / 公式 / 方向句 / cite key，已按文件分桶）做确定性「跨章对账表」：同一指标名 + 数据集的数值出现在 ≥2 文件且值不同 → Gate 新规则 `cross_section_fact_consistency`（检测级先行，与 D-0038 规则 16 同样的「默认呈现不阻断」接入纪律）；术语 / 符号用 glossary.json 升级为一等账本（M14 Handoff (b)）。
**优先级**：P1-5。

---

### Q4 引用、图表与实验数据能否跨章节合法复用

**引用 [已实现]**
- bibliography 项目级：`buildCanonicalBibliography`（`definitions.ts:3336-3342`，sources + research 候选）；`references.bib` 按实际引用集合同步（`:3364`），existing-paper 项目既有条目不改写、新增 key 只在有 formal evidence 关联时追加（`:3366-3372`）。
- 普通论文路径：每节 prompt 列出 **全项目** key 的 A/B 组（`WriterService.ts:199-217`）；A 组 = 本节分配证据关联的 key，同一 key 在非 owner 章节落入 B 组（只许背景引用）。候选级 `citation_hallucinated`（不在 bib）与 `citation_removed` fail-closed（`definitions.ts:2275-2278`）。
- Survey 路径：每节 `allowedCitationKeys` 来自该节 refs 投影（`backend/src/survey/sectionContext.ts:89, 122-191`），越界即违约。
- **结论**：跨章引用同一文献 **被契约允许**；仅 survey 路径要求该文献出现在两节的 refs 中（设计一致，非缺陷）；普通路径的「非 owner 章只许背景引用」对学位论文「实验章引用方法章已引文献的数值」是一个需要显式授权的约束 → P2。

**图表 [缺口]**
- manifest 记录 `insertedIn?: {file, label, revision}` 单值（`backend/src/figures/figureStore.ts:63-66`）；append 时 `record.insertedIn !== undefined` → `FigureAlreadyInsertedError`（`backend/src/figures/FigureService.ts:589-591`）；replace 只允许同 file+label（`:563-565`）。**一张图只能存在于一个章节**；学位论文「总览图在引言出现、实验章再次引用」只能靠 `\ref{fig:...}`（Writer 允许 `\ref`，`writerGraphicsGuard.ts:47`），不能复用环境——这是合理的；但「同一图在不同章以不同 caption 出现」被阻断。
- 跨章 `\ref` 本身无校验：没有「label 定义在章 A、引用在章 B 是否仍存在」的确定性检查（visualInventory 只盘点环境，`backend/src/manuscript/visualInventory.ts`）。

**实验数据 [已实现]**
- `workflowContext` 项目级，所有章节拿到同一份已授权观测（`definitions.ts:5501, 5572`；`ExperimentPackageService.ts:542`），`workflowUse` 按 组/范围 授权（`backend/src/experiments/experimentPolicy.ts:36-40`），split 不同不算冲突（`ExperimentPackageService.ts:70-82, 423-426`）。跨章复用 **被允许且口径一致**。
- [缺口] 100 条上限（`:165`）对多实验章学位论文（每章 30–50 个指标 × 多数据集）大概率触发 truncated（`:1241`），Writer 只被告知「已截断」，不知道哪些被截 → P2。

**影响范围**：figure 复用（P1-3 的一部分）；实验观测截断（P2）。
**复用与修复建议**：图表允许 `insertedIn: []` 多放置（lineage 已 append-only，改数组即可；恢复 intent `insertionRecovery.ts` 需同步）；实验观测按章节 / role 分配（复用 `sectionEvidenceAllocation` 的分配思想）而不是全局 100 条。
**优先级**：P1-3（图）、P2（引用 A/B 组、观测上限）。

---

### Q5 多阶段 Checkpoint / Resume 是否足够

**[已实现]**
- 粒度 = **stage 级**：`persistThenCommit` 在阶段边界 / 终态先写 `checkpoint.json` 再提交内存再发事件（`backend/src/workflow/WorkflowOrchestrator.ts:943-970`）；`recoverInterruptedRuns` 扫盘重挂 pending/running、awaiting_input 等待 resume（`:375-405`）；plan 基于 `stageResults` 不重执行已完成 stage（`definitions.ts:5718-5719`）。events.jsonl 追加无 fsync、读侧容错（`backend/src/workflow/eventLog.ts:24-30`；M13.0 §7）。
- idea_to_paper 共 28 个 stage 规格（`definitions.ts:5658-5690`），全库 54 个 stage id，8 个 HITL 节点；默认 `stageTimeoutMs=900s`、`stageMaxAttempts=2`（`backend/src/config/config.ts:331-332`）；writing.sections 与 review.sections 超时 ×4 = 60 分钟，review.run ×2 = 30 分钟（`definitions.ts:5492, 6822, 507`）；Writer / Reviewer / Researcher 单次执行超时 30 分钟（`config.ts:320, 441`）。
- 修订轮次：`maxRevisionRounds` 默认 2 + 手动 ≤3（`config.ts:338`；`definitions.ts:424, 4207-4213`）。
- M13.7.11 §7 三种真实 Resume（写作前恢复 / 全部已写后幂等复用 / 进程中断 → 另一进程 → resume）LIVE PASS——**但「幂等复用」是 survey 路径的 `surveyWritingSkippable`**（`definitions.ts:8005-8050`：已有 writing.sections 修订 + 大纲指纹一致 + 全部章节非空 → 跳过）。

**[缺口]**
- **idea_to_paper 的 writing.sections 无章节级幂等**：execute 循环对 `writerOutline.sections` 逐节无条件调用 Writer（`definitions.ts:5560-5590`），`writing-plan.json` 的 `status: "written"` 只是记录（`:5380-5395`）不参与跳过；stage 重试从头写全部章节。测试 `backend/test/workflow/argumentUnitWriting.e2e.test.ts:199-246` 钉死了这一语义：第 3 节瞬时失败 → 第二次尝试重写 5 节（Writer 调用 2 + 5 = 7）。[推断] 10 章 × 每章 3–6 分钟（5,000 词级输出）= 30–60 分钟，贴 60 分钟 stage 上限；第 9 章失败 → 重写 10 章 → 大概率再超时 → run failed；进程重启恢复同样整段重写。survey 的 skippable 也是「全部章节都已写」才跳过，部分已写不复用。
- 修订：`revision.revise` 按目标文件顺序执行，单目标失败走候选级拒绝 / 回写 `fileBefore`（`definitions.ts:2150, 2344, 2503, 2559`），stage 失败重试重做全部目标；`revision.plan` ≤20 条/轮（`WriterService.ts:845, 960`）。
- 恢复成本估算 [推断]（10 章 × 2 轮 review/revision）：Writer 10 次 + Reviewer 3×3 次 + 修订 ≤20 目标 × 2 轮 ≈ 60 次模型调用；任一 stage 中断的最坏重做 = 该 stage 全量（写作 10 次 ≈ 30–60 分钟、修订 ≤20 次）。checkpoint 本身 KB 级（实测 11–28 KB），不是瓶颈。

**影响范围**：写作 / 修订两个最贵 stage。
**复用与修复建议**：把 `surveyWritingSkippable` 推广为 **章节级**：以 `writing-plan.json` 的 per-section `{status, fingerprint(outline 节 + 分配证据 id), taskId}` 为依据，重试 / 恢复只写 `status !== written` 或指纹变化的章节（计划文件已有这些字段：`:5333-5395`）；修订同理按目标 journal。stage 超时按章节数线性放宽（`timeoutMs` 可由 services 计算）。
**优先级**：P1-1。

---

### Q6 单项目文件后端对长篇论文是否存在实际性能瓶颈

**[已实现] 机制**：writeFileAtomic + per-project promise 队列（M13.0 §2）；RevisionStore 每次 commit 对工作树 **全部文件**（排除 `revisions/` 与 `restore-intent.json`）算指纹并 `copyFile` 到 `rev-N/`（`backend/src/manuscript/RevisionStore.ts:5-6, 365-392, 416-430`）；restore / 普通 commit 的孤儿快照 fail-closed（`:231-233, 383-388`；M13 Batch 3）；EvidenceStore 更新 = 行保留的全文件重写（M13.1）；写作阶段 `safeMarkUsage` 逐条调用（`definitions.ts:5600-5602`）。

**真实规模（只读统计 2026-10-13；仓库 `projects/` 为空——默认 `PROJECTS_ROOT=./projects`，`config.ts:329`，验收数据在 `D:\PaperTeamData\*\projects`）**

| 项目 | 文件数 | 总大小 | 修订 | 单快照 | evidence.jsonl | runs / events / checkpoint | reviews | 最大文件 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `M13_Final_Closure/p-47370dc6a0f0`（Topic→PDF，9 节） | 222 | 2,498 KB | 4 | 64 KB | 0 行（此副本） | 2 / 172 行 54 KB、? / 28 KB | 41 文件 798 KB | build/main.pdf 152 KB；run-trace.json 152 KB；research.json 118 KB；quality-gate-r4.json 69 KB |
| `M13_7_11/p-8ddfa9fda825`（Survey，7 节） | 157 | 2,092 KB | 2 | 45 KB | 12 行 | 3 / 18–34 行 / 11–18 KB | 39 文件 848 KB | — |
| 其余 6 个 M13.7.11 项目 | 3–29 | 33–178 KB | 0–1 | — | 12 行 | — | — | — |

稿件本体：9 节 tex 合计约 12 KB，main.tex 1.4 KB，outline.json 8.3 KB，references.bib 5 KB。

**学位论文外推 [推断]**（10 章 × 15 KB tex + 20 张生成图 × 150 KB PDF + bib 30 KB ≈ 3.2 MB 工作树）：
- 修订快照：每次 commit 复制 3.2 MB（含图表 PDF，因为 `figs/generated/` 在工作树内）；30 次修订 ≈ 100 MB。线性、有界、不在热路径——P3。指纹计算每次读全部文件（`:496`），3 MB 毫秒级。
- Evidence：300–500 条 × 1.4 KB ≈ 0.7 MB；写作阶段 300–500 次 markUsage 全文件重写 ≈ 200–350 MB 顺序写 + fsync。Windows + AV 下秒级到十秒级一次性成本，**仍低于 M13.0 的 10k 条 / 10 MB 触发线 1–2 个数量级**——P3。
- reviews：每轮 review+gate ≈ 200 KB（实测 r1–r4 四轮 798 KB），15 轮 ≈ 3 MB。
- events.jsonl：172 事件 54 KB → 10 章长 run ≈ 1,000–2,000 事件 ≈ 0.5 MB；SSE 连接全量回放（M13.0 §7）亚秒级。
- 跨进程零保护、多用户无——M14 仍是单用户本地工具。

**M13.0 触发条件对照**：evidence > 10k 条 / > 10 MB（否）；跨项目检索需求（M14 多篇小论文导入是「多来源进一个项目」，不是跨项目查询——否）；多进程 / 多用户（否）；项目数 > 500（否）。**结论：M14 不触发 SQLite 复评；文件后端不是学位论文的瓶颈。**
**优先级**：P3 ×3。

---

### Q7 多来源小论文导入是否存在事实冲突与 lineage 难题

**[已实现]**
- 导入形态：`importPdf` / `importLatex` 各 **创建一个新项目**（`backend/src/project/ProjectImportService.ts:85-147`，事务式回滚）；LaTeX 导入要求单一入口（含 `\documentclass` 的文件，多个时取 main.tex / 最大者并 warning，`backend/src/import/LatexImporter.ts:157-166`），保留全部相对路径与图片（`:177-179, 196-200`）；PaperMap 每项目一份（`backend/src/paper/PaperStore.ts:321-328`）。工作流 kind 只有 4 种（`backend/src/workflow/kinds.ts:12-17`），`thesis` documentType 映射到 idea_to_paper（`backend/src/project/ProjectStore.ts:56-68`），前端已有「学位论文 / 从已有小论文扩展」入口（`frontend/src/pages/NewProjectPage.tsx:39-56, 162-180`）但后端无对应工作流。
- 文献身份去重：DOI > arXiv > PMID > 标题指纹+年+一作 > URL（`backend/src/sources/identity.ts:223-258`）；arXiv 与 DOI 正式版为不同身份（`:252-256` 注释）。
- Evidence provenance：`source.sourceId` + `location.{page, chunk}` + quote（`backend/src/evidence/EvidenceStore.ts:37-60`），`verificationLevel ∈ {metadata, abstract, fulltext, user_confirmed}`（`:34`）。
- Frozen baseline / cumulative preservation 只对导入项目的 rev-1（`cumulativeFactPreservation.ts:12-16`）；revisionBaseline 提取表格 / 数字 / 公式 / 方向句（`backend/src/review/revisionBaseline.ts`）。
- 实验包冲突：仅同范围 protocol 矛盾与来源失效（`ExperimentPackageService.ts:81-82, 423-459`）。

**[缺口]（两篇论文同一指标不同数值时的系统行为）**
- 两篇小论文作为 Source（role=evidence）入库后，各自 quote 逐字核验通过 → 两条 `verified` Evidence 并存；**没有任何跨来源数值对账**（`grep conflict|冲突` 在 evidence/、sources/metadataMerge.ts、identity.ts 零命中）。`EvidenceStats.contradictory` 统计的是 `supportStrength === "contradictory"`（证据相对 claim，`EvidenceStore.ts:12, 32, 389`），不是来源之间矛盾。Writer 拿到哪条取决于分配相关性评分，无来源优先级（`sectionEvidenceAllocation.ts:77` 只有相关性分）。
- 没有「作者已发表成果」的来源标签：`SourceRole` 只有 evidence / reference / both（`backend/src/sources/SourceStore.ts:10, 44`）；`user_confirmed` 等级目前只由结构化数据 / 图片分析 / 实验包赋予（`EvidenceStore.ts:14, 22`），没有「已发表小论文导入即 user_confirmed + 冻结」的入口。
- 项目 = 单稿件：无「多篇小论文 → 章节映射」的数据结构（M14 Handoff (a)）；若把小论文 LaTeX 导入为 manuscript，只能一篇（第二次 importLatex 是另一个项目）。

**影响范围**：M14 的核心输入形态。
**复用与修复建议**：小论文以 Source 入库（docling 全文 + chunk + Evidence 已通）而非 manuscript；新增 `sourceRole`/`provenanceClass = author_published` 并把其 Evidence 铸为 `user_confirmed` + 不可被 Reviewer 意见改写（复用 namedReferenceGuard / 未知 key fail-closed / Fact Preservation 授权台账 `research/fact-authorizations.json`）；对同指标多值在 `evidence.ground` 后加确定性「来源冲突表」+ HITL 选择（复用 `hitl.evidence_supply` 的决策形态）。
**优先级**：P1-4。

---

### Q8 当前 Quality Gate 是否适用于学位论文

**Gate 规则全清单 [已实现]**（`backend/src/quality/gates.ts`；阈值 `DEFAULT_QUALITY_THRESHOLDS`：academicPassScore 80 / styleRiskMax 35 / requireFeasibility true / requireEvidenceBackedCitations 缺省 false，`:249-253`）

| # | 规则 | 性质 | 学位论文适用性 |
| --- | --- | --- | --- |
| 1 | `hallucinated_citations_zero` (:389) | 阻断 | 直接复用 |
| 2 | `citation_structure_valid` (:399) | 阻断 | 直接复用 |
| 3 | `no_contradictory_evidence` (:406) | 阻断 | 复用；不覆盖跨来源冲突（Q7） |
| 4 | `unsupported_critical_claims_zero` (:424) | 阻断 | 复用，但输入受 P0-2 截断——需按章计算后汇总 |
| 4b/4c | `transparent_unverified_reported` / `author_experiment_data_reported` (:437, 448) | 呈现 | 直接复用 |
| 5 | `blocking_issues_zero` (:470) | 阻断 | 复用 |
| 6 | `open_critical_major_zero` (:492) | 阻断 | 复用 |
| 7 | `academic_score_threshold` ≥80 (:508) | 阻断 | **需重标定**：单一全稿分对 10 章无区分度，应按章评分 + 聚合 |
| 8 | `style_risk_threshold` ≤35 (:525) | 阻断 | 同上 |
| 9 | `target_feasibility` (:546) | 阻断（可关） | 复用（M14 Handoff (f) 实验不足 → AUTHOR_DECISION） |
| 10–15 | `citation_fabrication_zero` / `citation_not_found_obligatory_zero` / `citation_metadata_mismatch_critical_zero` / `citation_semantic_*` (:559-590) | PDF Review 流 | 复用 |
| 16–17 | `citation_keys_preserved` / `citation_preservation_not_applicable` (:601-607) | 阻断 | 复用 |
| 18–21 | `fact_preservation` / `cumulative_fact_preservation`（+ not_applicable）(:619-645) | 阻断 | **「已发表成果零漂移」的直接载体**——但基线只在 existing-paper rev-1；M14 需让多篇小论文的事实进入同一冻结基线 |
| 22 | `citations_evidence_backed` (:659) | 默认呈现 | 复用 |
| 23–24 | `revision_items_resolved` / `claim_strength_guard` (:678, 687) | 阻断 | 复用 |
| 25–28 | `survey_outline_contract` / `survey_citation_keys_valid` / `survey_synthesis_traceability` / `survey_writing_metrics` (:706-731) | survey 专属 | 文献综述章可借用 |
| — | Build Gate（`build.draft`，D-0015，`definitions.ts:3541-3584`）、Revision Task Gate（`quality/revisionTaskGate.ts:213-221` 守卫子集）、Finalize 对齐校验（`backend/src/artifacts/FinalizeService.ts:6-7, 63-73`） | 结构 | 直接复用 |

**[缺口]（学位论文缺的规则）**：章节完整性（大纲各章存在仅由 `verifyDod` 检查文件非空，`definitions.ts:5638-5655`）；目录 / 中英摘要 / 关键词存在性（模板无 `\tableofcontents` 无 keywords，`ManuscriptService.ts:142-166`；M13 §15-9 已记「综述模板无关键词字段」）；跨章一致性（Q3）；已发表成果零漂移（需基线扩展，Q7）；图 / 表 / 公式编号与 `\ref` 悬空（无规则）；篇幅下限（无）。
**优先级**：阈值重标定 P1（并入 P0-2 的修法）；新规则属 M14 范围（Handoff 已列）。

---

### Q9 图表资产是否支持已发表论文中的原始图片继承

**[已实现]**
- manifest record 只有 `kind: "plot" | "diagram"`、`specHash`、`assets: {tex, pdf}`、`dataOrigin`（`figureStore.ts:44-70`）；唯一生成入口 `FigureService.generate(kind, spec)`（`FigureService.ts:262`）→ pgfplots/TikZ → xelatex → PDF；`insert` 的 includegraphics 路径恒为 `figs/generated/<figId>.pdf`（`backend/src/figures/insertion.ts:7, 45`）。
- Writer 禁止新增 / 删除 `\includegraphics`（`writerGraphicsGuard.ts:7, 47, 73, 76`），比较的是 **路径多重集**（`:55-78`）——existing-paper 导入项目里的既有 `\includegraphics{figures/x.png}` 在修订中被保护（集合不变即放行）。
- `vision/figureAssets.ts` 只做安全读取：source 抽图 png/jpg（`sources/figures/<sourceId>/fig-001.png`，`ParsedDocumentStore.ts:6, 31`）与生成图 pdf 的 HTTP 外发（`figureAssets.ts:15-17, 62-65, 160, 239`）——**不是导入或登记入口**；docling 抽图落位 `imageFile → assetName`（`DoclingParser.ts:301-311`），图片分析可铸 `user_confirmed` Evidence（`EvidenceStore.ts:22-24`）但不产生 manuscript 资产。
- LatexImporter 把归档中的 png/jpg/pdf/eps 原样写入 manuscript（`LatexImporter.ts:177-179, 196-200`）——已发表论文的图 **以文件形式存在于导入项目**，但不在 manifest，无 lineage，不能被 `insert`。

**[缺口]**：外部 PNG/PDF 图 **没有任何合法进入 manifest 的入口**；在新写章节里 Writer 不能写 `\includegraphics`，`insert` 只认 manifest figId → 「把小论文的图 3 放进学位论文第 4 章」在当前契约下 **不可能完成**（只能人工编辑 tex，随后修订守卫会把它当作既有图保护，但 lineage / caption truthfulness / visual review 全部缺席）。
**复用与修复建议**：manifest 增加 `kind: "imported"` 记录（`assets.pdf|png` + `dataOrigin: {sourceId, assetName | archivePath, sha256}`），复用 figureStore 原子写 / insertion intent 恢复（`insertionRecovery.ts`）/ `insertedIn` lineage；`insertion.ts:45` 的路径模板按 kind 选扩展名；`figureAssets.ts` 的扁平名白名单可直接复用为导入校验。
**优先级**：P1-3。

---

### Q10 最可能导致 M14 真实验收失败的缺陷 Top 8

| # | 级别 | 缺陷 | 触发场景 | 证据坐标 | 最小修复 | 工作量 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **P0-1** | 多文件章节修订 prompt 截 12,000 字符 + 整文件覆写 | 任一章 > 12k 字符且 reviewer 对该章派发 major/critical（学位论文必然） | `WriterService.ts:1579`；`definitions.ts:2064, 2103, 2568-2572, 9336-9364`；守卫拒绝 `:2275-2278` | `sections/*.tex` 目标按 `locateLatexSections` 切 `logicalSpan`（`:9368-9374` 同款）→ 走 `checkRevisionScope`；或 wholeFile 对所有目标为真并取消 slice | **M** |
| 2 | **P0-2** | Review digest 3,600/节、60k 总量、24 节 | 全文 > 60k 字符或任一章 > 3.6k 字符（学位论文必然） | `definitions.ts:8632-8643`；M11.4 同类实证 `:8695-8706` | review.run 改为「每章一次 reviewer 任务（D-0024 受控上下文 `ReviewContextBuilder.ts:21-27`、`review.sections` 调度 `:6815-6880`）+ 全文汇总」；Gate 7/8 按章聚合 | **M** |
| 3 | P1-1 | writing.sections 无章节级幂等，重试 / 恢复重写全部 | 10 章写作中任一章瞬时失败或进程中断 | `definitions.ts:5560-5590, 5380-5395`；测试 `argumentUnitWriting.e2e.test.ts:199-246`（2+5=7）；超时 `:5492` 60 min | 以 writing-plan per-section status + 指纹跳过已写章节（推广 `surveyWritingSkippable :8005-8050`） | **S** |
| 4 | P1-2 | 大纲 ≤12（prompt）/20（解析）单层节、≤5,000 词/节、ctexart 无 chapter/toc/keywords；大纲 HITL 只能 feedback 重规划 | 任何学位论文大纲 | `WriterService.ts:1786, 1805-1806, 1877, 1945`；`ManuscriptService.ts:142-166`；`definitions.ts:8409-8429` | 大纲引入 `chapters[].sections[]` 两级 + 模板 ctexbook/thesis 类 + 用户直接提交大纲接口 | **L**（M14 Handoff (d) 已列） |
| 5 | P1-3 | 外部 / 已发表图片无 manifest 入口；单图单放置 | 从小论文继承图 | `figureStore.ts:44-70`；`insertion.ts:45`；`FigureService.ts:563-565, 589-591`；`writerGraphicsGuard.ts:47` | manifest `kind: imported` + 导入 API；`insertedIn` 数组化 | **M** |
| 6 | P1-4 | 多来源同指标不同值零检测；无「作者已发表」来源等级；项目=单稿件 | 两篇小论文同一数据集结果不一致 | `EvidenceStore.ts:12, 32, 389`；`SourceStore.ts:44`；`ProjectImportService.ts:85-147`；`PaperStore.ts:321-328` | 来源级 `author_published` + Evidence 铸 user_confirmed 冻结；`evidence.ground` 后确定性冲突表 + HITL | **M** |
| 7 | P1-5 | 零跨章一致性（数值 / 术语 / 符号）；issue 单位置；探测器未接入 | 摘要 / 实验 / 结论数值不一致 | `revisionValidation.ts:19-22`；`revisionBaseline.ts:46-53`；`ReviewerService.ts:48, 99`；`crossSectionRedundancy.ts` 未被 definitions 引用 | 复用 revisionBaseline 提取器做跨文件对账 → Gate 检测级规则；glossary 升一等账本 | **M** |
| 8 | P1-6 / P1-7 | 修订计划 ≤20 条/轮 × 默认 2 轮；Writer 会话轮转零迁移 | 10 章 × 多 finding；长 run 中段 | `WriterService.ts:845, 960`；`config.ts:338`；`PiRuntimeAdapter.ts:1810-1838, 214` | 计划上限按章节数放大 / 按章分批；轮转时注入确定性「已定义符号 / 术语」块 | **S** |

验收口径建议：M14 的第一次真实 run 之前至少完成 #1、#2、#3（合计 S+M+M），否则会在 revision / review 环节重复 M11.4「三轮白烧」的历史。

---

## 2. 优先级总表

| ID | 级别 | 问题 | 模块 | 关键坐标 | 修复量 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | P0 | 章节修订 12k 截断 + 整文件覆写 | writer / workflow | `WriterService.ts:1579`；`definitions.ts:2064, 2568-2572, 9336-9364` | M |
| P0-2 | P0 | Review digest 覆盖上限 → Gate 局部视图 | workflow / review / quality | `definitions.ts:8632-8643`；`gates.ts:424, 508, 525` | M |
| P1-1 | P1 | 写作阶段无章节级幂等 | workflow | `definitions.ts:5560-5590`；测试 `:199-246` | S |
| P1-2 | P1 | 大纲 / 模板结构硬上限 | writer / manuscript | `WriterService.ts:1786, 1805, 1877, 1945`；`ManuscriptService.ts:142-166` | L |
| P1-3 | P1 | 图片无继承入口；单放置 | figures / vision | `figureStore.ts:44-70`；`FigureService.ts:563, 589`；`insertion.ts:45` | M |
| P1-4 | P1 | 多来源冲突零检测；无作者来源等级；单稿件 | evidence / sources / import | `EvidenceStore.ts:32, 389`；`SourceStore.ts:44`；`ProjectImportService.ts:85-147` | M |
| P1-5 | P1 | 零跨章一致性 | review / quality | `revisionValidation.ts:19-22`；`styleInvariants.ts:330-350`；`ReviewerService.ts:48` | M |
| P1-6 | P1 | 修订计划 ≤20 条 × 2 轮 | writer / config | `WriterService.ts:845, 960`；`config.ts:338` | S |
| P1-7 | P1 | 会话轮转零摘要迁移 | runtime | `PiRuntimeAdapter.ts:1810-1838, 214, 909-911` | S |
| P2-1 | P2 | 实验观测 ≤100 条截断 | experiments | `ExperimentPackageService.ts:165, 542, 1241` | S |
| P2-2 | P2 | Evidence 渲染 20/节、quote 2,000、工具 50 条、检索 6k/24k | writer / evidence / retrieval | `WriterService.ts:2075, 121`；`evidence/tools.ts:220`；`contextPacker.ts:43` | S |
| P2-3 | P2 | 非 owner 章只许背景引用（A/B 组） | writer | `WriterService.ts:199-217` | S |
| P2-4 | P2 | survey 逐节 cite 白名单（跨章需双入 refs） | survey | `sectionContext.ts:89, 122-191` | — |
| P2-5 | P2 | 大纲 HITL 无用户直接提交 | workflow | `definitions.ts:8409-8429` | S |
| P3-1 | P3 | RevisionStore 全量快照含图表 PDF | manuscript | `RevisionStore.ts:383-392, 416-430` | — |
| P3-2 | P3 | markUsage 逐条全文件重写 | evidence / workflow | `definitions.ts:5600-5602` | — |
| P3-3 | P3 | events.jsonl 全量回放 | workflow / http | `eventLog.ts:24-30` | — |

---

## 3. 可直接复用能力清单（M14 不必重造）

| 能力 | 坐标 | 用途 |
| --- | --- | --- |
| 每节受控审稿上下文（D-0024）：概览 + 导航摘要 + 本节 chunks，预算分项 | `paper/ReviewContextBuilder.ts:21-27`；`paper/SectionReviewScheduler.ts`；`definitions.ts:6815-6880`（≤40 节、并发 3、重试 3、journal） | P0-2 的替代路径 |
| 句界安全截断 + 系统注 | `definitions.ts:8646-8689` | 任何 digest |
| main.tex 逻辑 span 切分 + 范围守卫 | `definitions.ts:9368-9374`；`review/revisionScope.ts:131` | P0-1 |
| survey 写作幂等跳过 | `definitions.ts:8005-8050` | P1-1 模板 |
| writing-plan per-section 记录 | `definitions.ts:5333-5395`；`reviews/writing-plan.json` | P1-1 |
| 章节论证单元 + 逐节证据分配 | `writer/argumentUnit.ts`；`evidence/sectionEvidenceAllocation.ts` | 按章供给 |
| 冻结基线 + 累计事实保持 + 授权台账 | `quality/cumulativeFactPreservation.ts`；`review/revisionBaseline.ts`；`research/fact-authorizations.json` | 已发表成果零漂移 |
| 具名实体守卫 / 未知 key fail-closed / 引用删除守卫 | `review/namedReferenceGuard.ts`；`definitions.ts:2275-2278` | Reviewer 意见隔离 |
| 实验包 workflowUse / split 范围授权 | `experiments/experimentPolicy.ts`；`ExperimentPackageService.ts:70-82, 423-459` | 实验章 |
| 图表插入 write-ahead intent 与恢复；RevisionStore restore intent | `figures/insertionRecovery.ts`；`RevisionStore.ts:191-360` | 导入图资产 |
| 文献身份分层去重 | `sources/identity.ts:223-258` | 多来源合并 |
| 跨节复述探测器（纯函数，未接入） | `review/crossSectionRedundancy.ts` | 一致性检查输入 |
| glossary 受保护术语 | `definitions.ts:3495-3506`；`styleInvariants.ts:330-350` | 术语账本雏形 |
| LaTeX 标题抽取支持 `\chapter` | `manuscript/latexHeadings.ts:26`；`visualInventory.ts:130` | 学位论文模板 |
| 多文件 LaTeX 导入保留图片 | `import/LatexImporter.ts:157-200` | 小论文入库 |
| 崩溃恢复 / Resume / HITL | `WorkflowOrchestrator.ts:375-405, 943-970` | 全流程 |
| 前端学位论文入口（topic / expand） | `frontend/src/pages/NewProjectPage.tsx:39-56, 162-180`；`constants/projectMeta.ts:33-46` | UI 已有占位 |

---

## 4. 可复核清单

**引用过的文件**（全部相对 `D:\Projects\PaperTeam\`）：
`docs/ARCHITECTURE.md`（§15 L1381-1431、§17 L1513-1583、§20 L1694-1719）；`docs/DECISIONS.md`（D-0014/0024/0027/0036/0038/0039）；`docs/research/M13_0_STORAGE_ARCHITECTURE_ASSESSMENT.md`；`M13_1_CODEX_HANDOFF.md`；`M13_STABILITY_HARDENING_BATCH3.md`；`M13_FINAL_CLOSURE.md`（§15–17、M14 Handoff、M13.8 追加）；`M13_7_7_CROSS_SECTION_ROOT_CAUSE_AND_REDESIGN.md`；`M13_7_11_PRODUCTION_WRITING_E2E_QUALITY_CLOSURE.md`（§3.2、§5、§7、§10）。
`backend/src/writer/WriterService.ts`（2,248 行）；`backend/src/writer/argumentUnit.ts`；`backend/src/workflow/definitions.ts`（9,444 行）；`backend/src/workflow/WorkflowOrchestrator.ts`（1,182 行）；`backend/src/workflow/runStore.ts`；`backend/src/workflow/eventLog.ts`；`backend/src/workflow/kinds.ts`；`backend/src/runtime/PiRuntimeAdapter.ts`；`backend/src/runtime/pi/contextBudget.ts`；`backend/src/retrieval/{contextPacker,tools,chunking}.ts`；`backend/src/evidence/{EvidenceStore,EvidenceSelectionService,sectionEvidenceAllocation,tools}.ts`；`backend/src/review/{revisionValidation,namedReferenceGuard,revisionBaseline,styleInvariants,revisionScope,crossSectionRedundancy,academicRedundancyClassifier}.ts`；`backend/src/agents/ReviewerService.ts`；`backend/src/quality/{gates,revisionTaskGate,cumulativeFactPreservation,factPreservation}.ts`；`backend/src/figures/{figureStore,FigureService,insertion,writerGraphicsGuard}.ts`；`backend/src/vision/figureAssets.ts`；`backend/src/ingestion/{ParsedDocumentStore,imageAsset,DoclingParser}.ts`；`backend/src/import/LatexImporter.ts`；`backend/src/project/{ProjectImportService,ProjectStore}.ts`；`backend/src/paper/{PaperStore,ReviewContextBuilder}.ts`；`backend/src/sources/{identity,SourceStore}.ts`；`backend/src/experiments/{ExperimentPackageService,experimentPolicy}.ts`；`backend/src/manuscript/{ManuscriptService,RevisionStore}.ts`；`backend/src/latex/LatexCompiler.ts`；`backend/src/artifacts/FinalizeService.ts`；`backend/src/config/config.ts`；`backend/src/survey/{sectionContext,outlineValidation}.ts`；`backend/test/workflow/argumentUnitWriting.e2e.test.ts:199-246`；`frontend/src/pages/NewProjectPage.tsx`；`frontend/src/constants/projectMeta.ts`。

**用过的度量命令**（均只读）：
`git log --oneline -1`；`wc -l` 于上述 ts 文件；`grep -n` / `grep -c 'slice(0,'`（WriterService 32、definitions 94）/ `grep -c 'rule: "'`（gates 30）/ `grep -c '^    id: "'`（stage 54）；`find backend/test -name "*.test.ts" | wc -l`（310）；`ls D:\PaperTeamData\*\projects | wc -l`、`du -sh/-sk`、`find -type f | wc -l`、`find -printf "%s %p" | sort -n`、`wc -c manuscript/*.tex`、`wc -l evidence/evidence.jsonl`、`wc -l workflow/runs/*/events.jsonl`、`ls -la workflow/runs/*/`、`du -sk manuscript/revisions/*`、`ls reviews | wc -l`——对 `M13_Final_Closure/projects/p-47370dc6a0f0` 与 `M13_7_11/projects/*`；仓库 `projects/` 目录为空（0 项）。未读取任何论文正文内容。

**未验证项（如实）**：全部规模推算为常量外推，未在学位论文规模的真实项目上实测；P0-1 的「循环无法收敛」是由守卫代码路径推演（`citation_removed` / `unauthorized_fact_removal` → rejected → 重派），未用真实 > 12k 字符章节复现；Reviewer 对 128k 窗口模型的受理拒绝未实测；本轮不涉及 Linux / Docker / 服务器。
