# Pre-M14 夜间长程研究汇总（Overnight Research Summary）

> 日期：2026-10-13 → 2026-10-14。执行：Claude Code（主会话 + 四个只读子代理）。基线：`main @ 215de15`（M13 COMPLETE — READY_FOR_M14）。
> 性质：**Pre-M14 技术预研**。未安装 academic-figure-skill；未新增生产 Renderer；未修改学位论文 Workflow / 数据库 / M13 已通过的 Guard 与 Gate；未改任何产品代码；未建分支。本轮唯一代码产物是入库的实验脚本副本（`repros/`）。
> 原始模型输出、实验图、批量日志与本地看板保留在 `D:\PaperTeamData\AcademicFigureSkillEvaluation\`（不进 GitHub）。

## 交付物

| 工作包 | 报告 | 规模 |
| --- | --- | --- |
| P0 Academic Figure Skill A/B 评估 | [PRE_M14_ACADEMIC_FIGURE_SKILL_EVALUATION.md](PRE_M14_ACADEMIC_FIGURE_SKILL_EVALUATION.md) + [repros/pre-m14-academic-figure-skill/](repros/pre-m14-academic-figure-skill/README.md) | 22 有效会话 + 1 无效试点（≤ 24 帽）、75.21 USD、3 臂 × 8 任务 |
| A 图表生成技术路线 | [PRE_M14_FIGURE_RENDERING_ARCHITECTURE.md](PRE_M14_FIGURE_RENDERING_ARCHITECTURE.md) | 静态分析 + 本机探针 + §7 A/B 实证 |
| B M14 学位论文 Workflow 架构 | [M14_0_THESIS_WORKFLOW_ARCHITECTURE.md](M14_0_THESIS_WORKFLOW_ARCHITECTURE.md) | 12 模块坐标审查、10 个数据模型草案、stage 状态机 |
| C 中文学位论文模板调研 | [M14_0_THESIS_TEMPLATE_RESEARCH.md](M14_0_THESIS_TEMPLATE_RESEARCH.md) | 10 模板 × 12 维度（`gh api` 实读）+ 2 个编译探针 + Document Model / Adapter 草案 |
| D M14 工程瓶颈审计 | [M14_0_ENGINEERING_READINESS_AUDIT.md](M14_0_ENGINEERING_READINESS_AUDIT.md) | 十问逐项、2 P0 / 7 P1 / 5 P2 / 3 P3、17 项可复用能力 |

## 十四问

**1. academic-figure-skill 值不值得引入？** 不作为可执行 Skill / Renderer 引入；值得**部分借鉴**。它的真实贡献是文本规范（栏宽 / 字号下限 / 受限配色 / 导出规范 / QA 清单 / 统计报告模板），而其核心机制「生产脚本 Copy-First」在 10 份交付中 0 次发生（资产硬编码私有数据、依赖缺席的 R、与用户数据语义不匹配）。仓库自 2026-07-12 无提交，示例图依赖「公众号更新」的私有资产。

**2. A/B 实验显示了什么实际差异？** 同模型（Fable 5.1）、同提示词、同运行时：Skill 臂人工评分 23.3 vs 22.5 / 25（已交付样本），6/10 份附统计与可复现性报告，严格重跑 10/10 vs 7/11；代价是成本中位 **7.8×**（6.07 vs 0.78 USD）、时长 **4.2×**（690 vs 163 s）、等预算 6 USD 下 **5/8 触顶、1/8 零交付**；2 处未授权派生量（Wilcoxon p 值、相对提升行；数值正确）、1 处版式缺陷。正确性与数据保真两臂全部通过（21 份脚本全行读入、无随机造数）。两臂都主动指出任务文案中与数据矛盾的结论。

**3. 哪些图表类型 PaperTeam 当前明显落后？** 臂 C（现有 FigureCompiler）8 任务只能表达 4 个：热图 / 混淆矩阵、分布图（箱 / 小提琴 + 样本点）、多面板组合完全不可表达；误差棒 / 置信带、散点标注 / 对数轴 / 前沿线、含反馈边或侧模块的架构图不可表达；可表达的图有图例遮数据（t1 / t3）、中文类目标签重叠（t2）、diagram 宽 250 mm 与标签重叠。全部是 pgfplots/TikZ 本身能做、PlotSpec/DiagramSpec 没暴露的能力。

**4. 完整 Skill 还是部分借鉴？** 部分借鉴：常量（尺寸 / 字号 / 配色，Apache-2.0 保留 NOTICE）→ codegen；QA 清单中与数据真实性相关条目 → Figure Truthfulness Guard 候选；统计报告 → 图资产的确定性 `methodsNote`。不借鉴：Copy-First 资产库、R 面板栅格化贴图、question-directed analysis（与真实性守卫相悖）、其 `check_*.py`（字符串匹配误判 + 检查器挂起）。

**5. 是否值得建立多 Renderer Figure Architecture？** **采用「统一 Figure Contract + Renderer 注册表」作为架构，但 M14 内 Renderer 集合 = {pgfplots-plot@1, tikz-diagram@1}**，不引入 Python / R 运行时。现有 7 条不变量中 6 条与后端无关（specHash/figId 身份、datasetHash 自洽、`assertOriginFaithful`、caption 三桶、append-only lineage、受控插入 + Writer 守卫），只有 `FigureCompiler.ts` / 两个 codegen / `latexEscape.ts` 绑定 TeX；需要泛化的字段只有 `assets: {tex, pdf}` 与 `compiler.diagnostics`。最小接口草案（FigureIntent / DatasetProvenance / RendererCapability / RenderArtifacts + EnvironmentFingerprint / Truthfulness hooks / Diagnostics / Lineage V2 / Insertion）见 A 报告 §6；未来若需脚本型 Renderer，必须是产品自有版本化模板 + 数据注入 + 沙箱，`renderKey = sha256(specHash ‖ rendererId ‖ scriptHash ‖ env)`，PDF 字体表回读检测 LastResort。A 报告还发现现有 `FigureCompiler.ts:344-379` 仅在非零退出时读 .log，exit 0 的 `Missing character` 静默——需补 backstop。

**6. M14 小论文扩展学位论文的推荐架构是什么？** 第五类 `WorkflowKind = "thesis_from_papers"`：线性主干 `thesis.import_papers → extract_contributions → freeze_facts → hitl.contribution_confirm → outline_plan → hitl.outline_confirm → map_sources → hitl.mapping_confirm → ledger_propose → hitl.ledger_confirm → research.*（既有，输入改为章节 gaps）→ [hitl.author_decision]* → write_chapters（章间有界并发，章级跳过）→ insert_inherited_figures → consistency_check → citation.verify → review.run(thesis) → quality.gate(thesis) → planSharedTail 修订 loop（原样）→ build.draft / final`。与 D-0014 兼容（线性 + 两个 bounded loop + 一个 fan-out，不引入 DAG）；小论文以 `origin=AUTHOR_PAPER` 进 Literature Library（唯一天然多文档的层），`manuscript/` 只放学位论文稿。11 步中约 7 步执行层可复用 M6 冻结流水线与 M10.3 返修链。

**7. M14 是否需要新的数据模型？** 需要。10 个草案（B 报告 §4）：扩展 `ProjectMetadata` 的 ThesisProject、SourcePaper（扩展 SourceItem + 新 store）、ResearchContributionLedger、两级 ThesisOutline（扩展同一 `outline.json`）、ChapterSourceMapping、ConsistencyLedger（术语 / 符号 / 指标 / 数据集 / 基线，同名指标不同协议不合并）、FrozenFact（新 store + 镜像为 `user_confirmed` Evidence）、InheritedFigureAsset（`figs/inherited/` manifest）、ChapterWritingState（扩展 writing-plan）、ThesisTemplate（资源非 store）。不重构数据库：全部是文件后端的新 store 或既有 JSON 的 additive 扩展；D 报告实测项目 2.5 MB / 222 文件外推学位论文约 100 MB 快照、0.7 MB evidence，远低于 M13.0 的 SQLite 触发线。

**8. 如何保护已发表论文的科研成果与实验事实？** 导入即提取 FrozenFact（数值 / 表格 / 公式 / 引用，确定性 `buildRevisionBaseline` + 表格块抽取）并镜像为 `user_confirmed` 等级 Evidence；写作期以「已发表事实行」注入 Writer prompt（不靠会话记忆）；修订期复用 Fact / Citation / Cumulative Preservation、Scoped Patch、Named Reference Guard（允许词表须含全部小论文文本）、`citation_unknown_key` fail-closed；Gate 新增 `published_facts_zero_drift` 与 `thesis_terminology_consistent`。实验章缺授权数据时 `hitl.author_decision` 只给 `defer_chapter / write_as_limitation / attach_experiment_package / cancel`，**刻意不含 approve 绕过**（区别于 `hitl.feasibility_confirm`）。注意：PDF 源的公式类事实基本不可冻结，只有 LaTeX 源支持——须如实标注。

**9. 中文学位论文模板采用什么技术路线？** 「通用 Thesis Document Model + 学校模板适配层」。实读 10 个模板：9/10 基于 `ctexbook`、全部 XeLaTeX（现有编排引擎不换）；参考文献后端是最大分叉（NJUThesis / hustthesis 类内 biblatex；zjuthesis / SJTUThesis / pkuthss 默认 biber）→ 需新增 biber 编排；本机 MiKTeX 已装 7/10 类 + gb7714 bbx/bst + biber。默认 `generic-ctexbook` 适配器（bibtex + gbt7714-numerical），学校适配器全部可选、**不把任何高校格式设为 PaperTeam 标准**；首批候选 thuthesis、ustcthesis/sysuthesis、NJUThesis；不推荐 zjuthesis（ctexrep + 固定目录宏 + release 停 2023）、ucasthesis（GPL-3、2021 后无提交）、任何 fork 改 .cls。两个发现需先修：`UNDEFINED_CITATION_PATTERN`（`LatexCompiler.ts:95`）匹配反引号写法，biblatex 的直引号警告会静默漏判；thuthesis 冷启动编译 133 s 超过默认 120 s 超时。Writer 继续只产 `\section` 片段，由 staging 层确定性提升为 `\chapter`（逐行 1:1，不破坏 diagnostics 归属）。

**10. M14 的前三个最优先工程阶段分别是什么？**
- **M14.1 事实与结构基础**：SourcePaper 多篇导入 + FrozenFact / ContributionLedger / ConsistencyLedger store + ThesisDocumentModel + `generic-ctexbook` 适配器 + 标题提升 + biber 编排与 `UNDEFINED_CITATION_PATTERN` 修正 + thesis 编译冷启动预算；同时清除 D 报告两项 P0（修订 12k 截断 / 整文件覆写 → `logicalSpan` 切片；Review digest 24 节 / 60k → D-0024 每节受控上下文）。
- **M14.2 章节工作流**：`thesis_from_papers` stage 定义 + 章级 `ChapterWritingState` 幂等恢复（P1-1）+ 两级大纲（P1-2）+ `hitl.author_decision` + 一致性检查 stage + 两条新 Gate 规则 + 前端 Thesis 入口接线（`NewProjectPage.tsx` 已有 UI 占位、零 API）。
- **M14.3 图表与资产继承 + 真实验收**：InheritedFigureAsset（`figs/inherited/` 白名单扩展，不动 writerGraphicsGuard 语义；P1-3）+ PlotSpec 误差棒 / 图例位置 / 刻度旋转 + heatmap / boxplot / groupplots 的 TikZ 表达面扩展 + 第一次「两篇小论文 → 学位论文 Draft PDF」真实 run。

**11. 哪些能力可直接复用，哪些必须新开发？** 直接复用（D 报告 17 项 + B 报告 §2 表）：Literature Library / SourceIdentity、Docling 摄取、Retrieval + Context Budget Packing、M10.3 研究链（plan / execute / evidence supply / propose / ground）、Evidence 等级与 claim grounding、Writer 契约 + B2 argument unit + workerGraphicsGuard + Workspace Guard、Reviewer 三路 + Named Reference Guard、Quality Gate 双层判定、Revision Fidelity 全链、Experiment Package 范围授权、FigureService / FigureStore / insertion lineage、LatexCompiler 与 Build Gate、ArtifactStore、HITL 机制、`mapWithConcurrency`。必须新开发：`thesis/` 域全部 store 与 stage、ThesisTemplate / TemplateAdapter / biber 编排、跨章一致性检查器、FrozenFact 提取与镜像、InheritedFigureAsset 入口、两级大纲及其对 `sectionMatches` / digest / revisionValidation 消费者的回归、前端 Thesis 创建与多文件导入 API。

**12. 是否存在阻碍 M14 开始的 P0 技术风险？** **无阻碍「开始」的 P0**；但有 2 项 P0 必须作为 M14 首批工程任务，否则学位论文规模的真实验收必然在修订与审稿环节失效：P0-1 多文件章节修订 prompt 截 12,000 字符且 `sections/*.tex` 无 `logicalSpan` 整文件覆写（`WriterService.ts:1579`；`definitions.ts:2568-2572, 9336-9364`）→ 尾部数字 / 引用被「删除」→ 守卫拒绝 → 对 >12k 字符章节修订结构上不可收敛；P0-2 Review digest 3,600 字符 / 节、60k 总量、24 节（`definitions.ts:8632-8643`）→ 10 章论文 Reviewer 只见约 36–45% 正文，Gate 规则对局部成立（M11.4 同类缺陷重现）。此外 7 项 P1（章节级幂等、大纲 / 模板硬上限、图片零继承入口、多来源冲突零检测、零跨章一致性、修订计划 ≤20 × 2 轮、会话轮转零迁移）决定验收质量。文件后端不触发 SQLite 复评。

**13. 所有实验 / 报告是否可复核？** 是。A/B/C：`PROTOCOL.md`（含修正案 1）、`runs/ledger.json`（22 条，逐会话 session_id / tokens / cost）+ 无效试点账本、每会话完整提示词 / CLI 参数 / 原始 JSON / 脚本 / 产物 / 操作者重跑插桩、`dashboard/results.json` + `visual_rubric.json` + `index.html`；臂 C spec / tex / pdf；脚本副本已入库。B / D 报告每条论断带 `文件:行`；C 报告事实全部来自本次 `gh api` 实读与本机编译日志，13 项未核实项单列（代理在收尾阶段断开）。已知限制：盲评未实现、每任务 1–2 次重复、合成数据、只评一个 Skill、R 路径未测。

**14. Git 是否已提交推送并同步？** 本轮六份公开报告 + repros 脚本副本 + 索引更新以单个提交推送到 GitHub `main`（提交信息前缀 `research(pre-m14)`；哈希见最终汇报与 `git log`）。未修改产品代码，故未重跑全量 Vitest；只做文档链接检查（`scripts/check-docs-links.mjs`）、`git diff` 审阅与 GitHub CI。原始数据未入库。

## 本轮暴露的流程坑（供后续夜间任务复用）

1. 无头 `claude -p` 用 `--permission-prompts none` + Bash 允许清单时，heredoc / touch / Edit 的文件创建全部被静默拒绝（试点 A 臂零交付、0.63 USD 浪费）；正确做法是隔离目录 + `--dangerously-skip-permissions` + 显式 `--disallowedTools` 禁用清单，并对只读挂载目录事后 `git status` 核验。
2. 注入 29 KB SKILL.md 并允许读 references / assets 的会话，等预算 6 USD 下 5/8 触顶；预算帽必须在协议里预声明，修正只能作用于尚未启动的复制组并记录。
3. Skill 自带 `check_dimensions.py` 在 19/21 脚本上挂起 >60 s，把评估器拖到十余分钟——外部 QA 脚本进评估流水线前先单测其终止性。
4. 子代理的报告在父会话重启时会丢失未写出的进度；本轮四个子代理全部通过 `SendMessage` 恢复并一次写出，耗时约 6–15 分钟。
5. bash heredoc 吃 `\n` 转义再次应验（runner 补丁被写坏一次）；对 .py 的编辑一律用 Edit。
