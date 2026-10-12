# M13.7.10 — Argument-Unit Writing：生产集成（B2 → 真实 Workflow）

日期：2026-10-12。基线：`main @ 043f87939a9ad858eb35ea5d545a766aaa102603`（开始时本地 HEAD、origin/main、GitHub main 三者一致，工作区干净）。执行环境：公司 Windows 工作站 `D:\Projects\PaperTeam`；新加坡 ECS 保持关机，本轮未通过 SSH 触碰任何远程机器，不使用 AutoDL / GPU / Docker。真实模型验收在本机通过既有 PiRuntimeAdapter 调用 PaperTeam 已配置的 `zai-coding-cn/glm-5.3`；Claude Code（Fable 5.1）只做工程、人工核对与报告，没有跑 Fable Writer。

**裁决：PARTIAL（生产接线完成、默认启用；真实 Planner 与证据分配通过；写作质量方向正确但 held-out 幅度未复现；完整 Topic → PDF E2E 未执行）。** M13.7.9 在人工夹具上验证的 B2 三项机制（逐节分配正式 Evidence、固定篇幅改软上限、明确论证任务与负向范围）已接入两条真实写作路径（`idea_to_paper` 的 `writingSectionsStage` 与 `topic_survey` 的 `surveyWritingSectionsStage`），角色 / 任务 / 负向范围由代码从 Outline、位置、标题与 Survey Synthesis 确定性派生，Planner 只可选输出 `argument` 字段且无效部分安全降级；真实 GLM-5.3 Planner 两次都为全部章节给出了合法角色；两次真实 `writing.sections` 产出的综述稿件 17 项必保事实（含 12 项数值）全部在位、两条 partial 负对照均被显式拒绝、引用全部在白名单内、XeLaTeX 编译通过。但有害重复只从 M13.7.9 同主题 Baseline 的 9.8% 降到 7.0% / 8.6%（M13.7.9 夹具 B2 为 0.0%），其中 run 1 的 framing 节凭记忆写出了摘要中不存在的实验平台（已用「文献身份表」修复并在 run 2 复验归零），run 2 的 3 句 M 全部来自 Planner 把「未来方向」与「结论」拆成两个 conclude 节各复述一遍（已加确定性任务规则，预算用尽未能 live 复验）。因此按任务十的原则：B2 作为默认写作策略启用（`PAPERTEAM_ARGUMENT_UNIT_WRITING=false` 可回到旧组织），但本轮不宣称 PASS。

## 1. 生产写作路径的真实改造

### 1.1 普通论文 `idea_to_paper`（`backend/src/workflow/definitions.ts` `writingSectionsStage`）

旧行为：循环前调用一次 `selectForWriting(projectId)`（上限 20 条），同一数组传给每一节；`buildSectionPrompt` 固定「目标长度：约 N 字」。

新行为（`services.writing.argumentUnits`，缺省开启）：

1. `resolveArgumentUnits({ outline })` 为每节派生论证单元（§2）。
2. `allocateSectionEvidence({ outline, units, evidence: 全部 formal 记录 })`（新模块 `backend/src/evidence/sectionEvidenceAllocation.ts`）逐节投影正式 Evidence：正式性仍由 `isFormalEvidence` 判定（verified + sourceId + chunk 锚点，未核验 / 缺锚不进任何章节）；develop 节按词面相关性（独有标题 token ×3 + keyPoints / 规划者 task token ×1 + `relatedSections` +10，入选门槛 3 分，上限 12）选取；compare 节拿整个 formal 池（上限 20）；framing / conclude 不注入正式 Evidence（规划者显式 pinned 的除外，上限 4）；partial 记录只落到相关 develop 与 compare；覆盖兜底保证池中每条正式记录至少落到一个 develop 节（无 develop 则 compare，再无则如实列入 `unassigned`）；规划者 `evidenceIds` 只认 formal 池里的 canonical ID，命不中逐条拒绝并记原因（`unknown` / `not_formal`）；develop 节正式证据 < 2 条记 `evidence_insufficient` 诊断（短写 / 弱化，不填充）。
3. 每节 `writeSection({ evidence: 本节投影, argument: unit, argumentPartialClaims })`；`buildSectionPrompt` 在「本章节要求」后渲染 B2 任务块（§4），目标长度行改为「不超过 N 字（上限参考，不是配额）」。
4. 写作前落盘 `reviews/writing-plan.json`（§5），每节写完更新消费 ID / 引用 key / usage / 耗时；写作后按修订号落盘 `reviews/academic-redundancy-rev{N}.json`（§6）。

### 1.2 综述 `topic_survey`（`surveyWritingSectionsStage`）

证据契约零改动：每节仍只拿 `buildSurveySectionContext` 按 `synthesisRefs / literatureRefs` 投影的 Evidence、文献与 citation key 白名单，`writeSection` 的白名单后检不变（ghost key 仍 fail-closed，测试覆盖）。新增的只有：`resolveArgumentUnits({ outline, synthesis })` 的角色 / 任务 / 负向范围（comparison synthesis 的 `detail.dimension` 进 compare 任务；绑定 `research_gap` synthesis 的章节成为限制集中陈述的 owner），`buildSurveySectionPrompt` 的任务块与上限长度行，framing / conclude 的「文献身份表」只列白名单内的 key，以及同样的 writing-plan / redundancy 产物。speculative 泄漏、B 组文献不伪装 A 组、framing 节可引用整个 bibliography 等 M11 契约全部沿用。

两条路径共用同一份渲染逻辑（`backend/src/writer/argumentUnit.ts`），证据纪律各自不变。

## 2. role / task / evidenceIds 的产生与校验

Outline 只多一个可选字段 `OutlineSection.argument = { role?, task?, evidenceIds?, doNotExplain?, targetLengthUpperBound? }`（`ManuscriptService.ts`）。`validateOutline` 做形状校验（非法 role / 非字符串数组 / 上限不在 50–5000 → 拒绝保存），`normalizeOutlineRefs` 做去重去空、全空删键；旧 Outline 无该键，落盘不新增键。无数据库迁移，没有第二套权威 Outline。

**角色**（`resolveArgumentUnits`，纯函数）：显式 `argument.role` > 标题（中英文：结论 / 总结 / 展望 / conclusion…→ conclude；比较 / 对照 / 对比 / 讨论 / 局限 / comparison / discussion / limitations → compare，但「对比学习 / 比较基准 / 对比实验设置」一类排除；引言 / 背景 / 概述 / introduction… → framing）> Survey 语境（`classifySurveySection` future → conclude、gap → compare；core 节只绑定 comparison / consensus / disagreement / trend → compare；标题含比较语义但绑定 taxonomy → develop 降级并 warning）> 位置（首节 framing、末节 conclude、其余 develop）。歧义（标题同时含框架与比较语义）降级为 develop 并输出 `ambiguous_fallback` warning，不猜测。

**任务**：按角色的 B2 模板（§4）+ 本节 keyPoints + Survey comparison 维度 + 规划者 `argument.task` 作为「规划补充」追加（不替换模板）。`doNotExplain` 由其他 develop 节自动派生（「「X」所负责的机制、结果与数值细节」）+ 限制 owner 的归属句 + 规划者给出的概念；渲染时**不出现**「见「X」一节」路标（M13.7.8 路标模板句的根因）。长度：显式上限 > Outline `targetLengthWords` > 角色缺省（200 / 400 / 350 / 180）；framing / conclude 受角色封顶（260 / 240）。

**Planner 侧**：两个大纲 prompt（普通 / Survey）只增加一行可选字段说明与一条纪律（Survey 明确不要输出 evidenceIds）。`readOutlineSections` 用 `parseOutlineArgument` 宽容解析：非法 role、非 canonical 的 evidenceIds（必须匹配 `E\d+`）、Survey 中的 evidenceIds 逐项丢弃并写日志，不进入结构化修复循环，不阻断写作（M13.7.4 的教训）。

## 3. 真实 Planner 是否能可靠生成所需信息

两次真实 `survey.outline`（GLM-5.3，各 1 次规划、0 次修复、1 条 warning = abstract_only 占比）都通过了 `validateSurveyOutline`，并为**全部**章节输出了合法 `argument.role`：

| run | 章节（Planner id） | role（Planner） | synthesisRefs | 本轮代码判定 |
| --- | --- | --- | --- | --- |
| 1 | introduction / surface-code-scaling / breakeven-logical-qubits / cross-route-comparison / limitations-and-outlook / conclusion | framing / develop / develop / compare / conclude / conclude | 0 / tax / tax / 4×cmp / gap+fut / 0 | 全部沿用（roleSource=outline） |
| 2 | introduction / surface-scaling / breakeven-logical-qubits / route-comparison / limitations / future-directions / conclusion | framing / develop / develop / compare / compare / conclude / conclude | 0 / tax / tax / 4×cmp / gap / fut / 0 | 全部沿用 |

角色全部合理；没有 evidenceIds（Survey 不需要）；未触发任何降级。Planner 自主拆出「局限 / 未来方向」独立章节，并给了比 B2 原型大得多的目标长度（run 1：700 / 700 / 800；run 2：500 / 500 / 600）——上限口径接受了这些值（M13.7.9 已证明上限不被严格遵守，这里不包装为硬保证；run 1 compare 节 830 字超过 800 上限）。普通论文路径的 Planner 契约（`argument.evidenceIds`）本轮只有确定性测试（合法 / 非法 / 丢弃诊断），没有真实模型样本。

## 4. 真实 Writer 的 B2 任务块（进入生产 prompt）

`renderArgumentUnitLines` 输出：`===== 本节论证任务（组织约定，不是事实证据）=====` / `角色：…`（M13.7.9 冻结的四个角色标签）/ `任务：…` / （compare）`目前证据还不能判断（partial 证据的待核验命题，不得写成事实）：- …` / `本节不重新解释的内容（由其他章节完整展开；如论述需要，以半句点到为止）：- …` / `跨章节约定：…`（B2 `crossSectionPolicy` 原句）/ `长度口径：…`（B2 `lengthPolicy` 原句）。develop 节正式证据 < 2 条追加短写提示。framing / conclude 追加「文献身份」表（key → 标题 / 年份，声明不是内容依据），这是 run 1 之后加的（§8）。

角色任务模板（摘要）：framing 界定问题 / 范围 / 路线与代表工作，不解释机制、不转述数值、不预告各节，代表工作只按文献身份点名；develop 是「全文唯一完整解释「X」」的位置，保留 Evidence 支持的数值与限定词，涉及其他路线半句点出；compare 五问（关键差异 / 维度 / 证据支持什么 / 不可直接横向比较什么 / 还不能判断什么），机制数值只半句提醒；conclude 回答全文问题、一句承接限制、不逐一复述、不写结构性回指；非末节的 conclude（Planner 独立拆出的「未来方向」）只陈述未来方向与开放问题、不总结各路线（run 2 之后加，未 live 复验）。

## 5. Evidence 是否真正按章节分配；必要事实与数值有无遗漏

**分配**（run 2 的 `writing-plan.json`）：introduction 0 / surface-scaling 7（E001–E007，即两篇表面码摘要的全部 direct 记录）/ breakeven-logical-qubits 3（E008–E010）/ route-comparison 12（含两条 partial E011、E012）/ limitations 0（research_gap synthesis 无绑定证据，4 个 key 以 B 组背景引用）/ future-directions 0 / conclusion 0。partial 只出现在 compare 节；每节 `consumed === allocated`；`unassignedEvidence = []`。普通论文路径的分配在确定性 Workflow 测试中验证：5 节 5 条正式记录（含 1 条 partial），引言 / 结论为空，三个 develop 节拿到互不相同的子集，孤立记录由覆盖兜底补入且带诊断，开关关闭时五节拿到同一快照。

**必保事实**（M13.7.9 冻结的 17 个概念标记，含 12 项数值 + 两条负对照）：

| 项 | run 1 | run 2 | 所在节 |
| --- | --- | --- | --- |
| 扩展前提；2.914% / 3.028%；1.7×10⁻⁶（1.6×10⁻⁷）；Λ=2.14；101 比特 0.143%；2.4 倍；63 µs；1.1 µs；每小时 / 3×10⁹ 关联错误 | 全部在位 | 全部在位 | develop（表面码） |
| G=2.27；无模型强化学习；微波腔光子数态 + 辅助比特；频率梳；16% | 全部在位 | 全部在位 | develop（盈亏平衡） |
| 本文无实验 / 仅摘要；不能据此排序 | 在位 | 在位 | compare / limitations |
| E11「已达到大规模容错所需错误率」升级 | 0（显式拒绝） | 0（显式拒绝：「取决于…推论，而非已验证的结论」） | compare |
| E12「G=2.27 与 2.4 倍可直接比较」升级 | 0（显式拒绝） | 0（显式拒绝） | compare |

标记层面：5 个数值项只在数学模式 `$…$` 内出现，M13.7.9 的 `plain()` 口径看不见（盲区③），本轮验收脚本改用保留数学内容的 `plainWithMath` 计数并同时报告 `mathModeOnly`；run 1 的 `no_ranking` 标记漏检是模式问题（原文「不据此对两条路线的纠错性能给出任何排序」），人工计数在位。两次 run 没有引文外数字（唯一命中「2」是「码距每增加 2」，来自引文）。

## 6. Survey 证据与 citation 白名单是否保持正确

是。`buildSurveySectionContext` 与白名单后检零改动；两次 run 全部 `\cite` key ∈ 各节 `allowedCitationKeys`（run 1 评估脚本最初报「unknown key」是把生产 canonical key（`acharya2022suppressing` 等）与夹具 key（`acharya2022surface`）比较的评估错误，已改为按 writing-plan 的 allowed 集合与 `references.bib` 判定）。framing 节 A 组为空、B 组列出全部 4 个 key（背景引用能力保留），引言与结论都只做背景引用。`test/workflow/topicSurveyWriting.e2e.test.ts` 的 ghost key fail-closed 用例与修订轮用例在新代码下通过。

## 7. 旧 Outline / Checkpoint / Resume 是否兼容

- 旧 Outline（无 `argument`）：保存 / 重载逐字节不变，角色全部由位置 / 标题派生（单测 + ManuscriptService 往返测试）。
- 旧 Checkpoint：`writing.sections` 的 stage 结果只**新增**键（`argumentUnits` 摘要、`redundancy` 摘要），不读取任何新键；`review.run` 只在最新重复报告的修订号 === 本轮审阅修订号时才注入 style digest，否则与旧版 prompt 逐字节一致。
- 计划指纹：`writing-plan.json` 的 `fingerprint` = 大纲结构字段 + 正式证据集合（id / 状态 / 锚点 / support）+（Survey）matrix 指纹。同一项目再次写作：指纹相同 → `attempt` 递增、分配一致（测试：第二次 run 的 `allocated` 与第一次逐节相等）；正式证据集合变化 → 记录 `previousFingerprint` 与 warning，按当前有效证据重新分配（测试：新增一条 verified 记录后它进入对应 develop 节）。Evidence 失效 / 来源删除后不在 formal 池即不进入分配，旧绑定不会被当成 Verified。
- 失败：某节写作抛错时计划该节记 `failed` 后原样抛出，Stage 重试走既有 `retryable` 语义；取消语义不变（`ctx.signal.aborted` 检查位置不变）。
- 模型 / 工具调用次数：每节仍恰好 1 次 Writer 调用，无新增模型调用；两次真实 run 每任务 1 个 assistant turn（Planner 1 + Writer N）。

## 8. 真实 Writer 是否减少有害重复；与 Baseline 的差异

两次真实 run（同一主题、同一 12 条 abstract 级 Evidence、同一 4 篇文献；Planner 自主规划）与 M13.7.9 同主题冻结臂的对照。**注意不是严格 A/B**：M13.7.9 的 A / B2 是人工 5 节大纲、350 字配额、`buildSectionPrompt`（普通论文 prompt）；本轮是真实 Planner 的 6 / 7 节大纲、500–800 字上限、`buildSurveySectionPrompt`（含 synthesis 块与白名单）。

| 指标 | M13.7.9 A（夹具 Baseline） | M13.7.9 B2（夹具） | 本轮 run 1（生产） | 本轮 run 2（生产，三处修复后） |
| --- | ---: | ---: | ---: | ---: |
| 章节数 / 汉字 / cite | 5 / 2694 / 32 | 5 / 1812 / 29 | 6 / 2644 / 35 | 7 / 2997 / 35 |
| 指标 A 词面复述占比 | 27.0% | 17.4% | 20.7% | 21.6% |
| **指标 B 有害占比 下界 / 上界** | **9.8%** / 9.8% | **0.0%** / 2.3% | **7.0%** / 7.0% | **8.6%** / 8.6% |
| 有害句类别 | P4 | 0 | P1 + L1 | P1 + M3 |
| 路标句 / 比较节逐字 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| 必保 17 项 / 负对照升级 | 全保 / 0 | 全保 / 0 | 全保 / 0 | 全保 / 0 |
| 引文外推断（人工） | 1 红旗 + ~3 轻 | ~3 轻 | **1 红旗**（intro「基于里德堡原子阵列」）+「Google 量子 AI」+ 1 处项目名泄漏 | ~2 轻（「玻色子式自由度」「数十至上百个」） |
| Writer 任务 / turns | 5 / 5 | 5 / 5 | 6 / 6 | 7 / 7 |
| Writer 非缓存 input / output | 19449 / 2381 | 15061 / 1785 | 20586 / 2421 | 23542 / 2677 |
| Writer SDK estimatedCost / 秒 | 0.04920 / 62.7 | 0.03794 / 36.1 | 0.05523 / 82.5 | 0.06647 / 98.5 |
| 每节 Writer 费用 | 0.0098 | 0.0076 | 0.0092 | 0.0095 |
| Planner 费用 / 秒 | — | — | 0.00927 / 16.4 | 0.00968 / 15.1 |

逐句核对（原句在私人目录 `live/*/result.json#evaluation.harmfulSentences`）：

- run 1：P = 引言一句「…本文围绕 M13.7.10 production acceptance 所界定的…一是表面码逻辑量子比特的规模扩展，即通过增大码距检验纠错性能随规模的变化…」——路线级定义带半句机制，且含我种子脚本泄漏的项目名前缀（project.title 被当作 Planner 主题；已改为夹具标题原文）；L = 结论第二句限制（两个 conclude 节 + compare 节各写一遍限制：当时限制 owner 规则选了 compare，而 Planner 把 research_gap synthesis 绑在「局限与未来方向」节）。
- run 2：P = 引言「其二是突破盈亏平衡的逻辑量子比特实验，即在有限规模的编码系统中使逻辑性能超过未编码的物理基线，代表工作包括…」——路线级定义 + 按标题点名，与 develop 节收束句词面重合，人工判为必要的路线界定而非预展开（但按冻结规则计有害，不改判）；M×3 = 「未来方向与展望」首句与「结论」两句各自总结两条路线——Planner 把 future_direction 与结论拆成两个 conclude 节，模板让两节都「回答全文问题」。
- 两次 run 都没有路标句、没有比较节逐字搬运、没有免责扩散（限制句分别落在 compare / limitations 与一句承接）。

**run 1 → run 2 的三处修复**（都有确定性测试）：① framing / conclude 的「文献身份表」（key → 标题 / 年份，声明不是内容依据）+ 任务句「代表工作只按文献身份点名，不补写平台 / 装置 / 方法 / 机制 / 结果」——run 2 引言按标题点名，平台幻觉归零；② 限制 owner 优先给绑定 `research_gap` synthesis 的章节——run 2 限制集中在 limitations 节，compare 只写「不可直接横向比较」的对照结论；③ 种子脚本用夹具标题原文作 project.title。run 2 之后又加了第四处：非末节 conclude 只写未来方向不总结各路线（针对 M×3），预算用尽（15 / 18 任务）未能 live 复验。

结论：有害重复相对同主题 Baseline 下降（9.8% → 7.0% / 8.6%），P / L / M 三类都没有归零，远未达到 M13.7.9 夹具 B2 的 0.0%；差距来源可定位（真实 Planner 的多 conclude 结构、路线级定义与机制句的边界），不是 B2 机制失效。单次采样，不外推具体数字。

## 9. 评价器：哪些进入 Reviewer，哪些只读

- `writing.sections` 结束后生成 `reviews/academic-redundancy-rev{N}.json`（角色 / 指标 A 与 B / 有害与 uncertain 句 / 路标句 / ≤ 60 个 pair / 已知局限），只读，不进 Gate，不删句，不触发重写。
- `review.run` 的 **style** 模式注入有界 digest（修订号一致时；≤ 8 条有害句 + 计数 + 使用口径「uncertain 不得直接判为问题」），fact / academic 逐字节不变（测试锁定）。Gate 规则集不变（测试断言无重复率规则）。
- 盲区修复：盲区①（「不能**据此**给出…排序」被漏判为非限制句，导致 M13.7.9 对齐主题 B2 的唯一「有害」句）——`crossSectionRedundancy.ts` 限制哨兵允许否定词与谓语之间 ≤ 12 字插入成分，回归测试 4 正 2 负；盲区③（数学模式数字）——只在验收评估层改为保留数学内容计数并报告 `mathModeOnly`，探测器本身未改（改会影响历史可比性）；盲区②（改写后的引言预展开召回不足）未改，报告如实标注 P 类数字是下界。Fact / Citation Preservation 阈值未动。

## 10. 是否出现新的无依据科研机制或引用错误

- run 1：**有**。引言「代表工作包括基于里德堡原子阵列的实验\cite{ni2022beating}」——Ni 等是微波腔实验，摘要中无里德堡；「Google 量子 AI」来自模型记忆（摘要不含机构）。根因：framing 节不注入 Evidence，模型只看到 cite key 就为其补写身份。已修复（§8 ①），run 2 归零。
- run 2：无新的机制错误；轻度措辞外推 2 处（「玻色子式自由度」概括光子数态、「数十至上百个物理量子比特」）；引用 0 越界、0 未知 key。
- 两次 run 的 partial 命题都在 compare 节被显式拒绝，没有写成事实。
- M13.7.7 §8 的「机制句级 quote 覆盖核对」仍是独立问题。

## 11. 工程验证

| 项 | 结果 |
| --- | --- |
| 新增测试 | `test/writer/argumentUnit.test.ts`（22）、`test/writer/argumentUnitWriter.test.ts`（7）、`test/evidence/sectionEvidenceAllocation.test.ts`（8）、`test/workflow/argumentUnitWriting.e2e.test.ts`（2，真实 Orchestrator + scripted runtime：两次 run 指纹语义、开关关闭回退）、`crossSectionRedundancy.test.ts` +1、`reviewerEvidencePrompt.test.ts` +1 |
| 定向回归 | writer / survey / review / evidence / manuscript / agents / quality / 相关 workflow 文件：全部通过（仅 `stylePolish` 两例在 2 workers 并发下 5s 超时，单独复跑 18/18 通过） |
| 既有测试修复 | ① `scriptedRuntime.ts` 的章节定位（`targetsIntroduction / targetsExperiments`）原按正文含「引言」「实验」判断，任务块点名其他章节标题后误判 → 改为只认 prompt 任务头（`论文章节「X」` / `章节：X（`）；`citationPreservationGate` 用例由此恢复。② `researchEvidenceSupply.test.ts`「auto supply 的证据到达 Writer」原只看第一节（引言）的 prompt——引言现在不注入正式 Evidence，改为等 `writing.sections` 完成后断言证据出现在正文章节 prompt、且不在引言 prompt（这是 B2 的预期行为，不是回归） |
| backend typecheck / build | 通过 / 通过 |
| frontend typecheck / vitest | 通过（前端无 Outline 类型引用该字段，未改 UI） |
| `git diff --check` | 通过（仅 CRLF 提示） |
| 全量 backend vitest（2 workers） | 第一次 1 失败（B2 预期行为导致的旧断言，已改）；第二次 288 文件 / 3198 测试全部通过（§13） |
| LaTeX smoke | run 2 稿件以生产 `main.tex` + `references.bib` 经 MiKTeX `latexmk -xelatex` 编译通过，140 KB PDF，无错误（只有 LaTeX 版本提示类 warning） |

验收分项：Outline / Planning Contract **PASS**（两次真实 Planner 全部角色合法）；Evidence Allocation **PASS**（Survey 投影 + 普通论文确定性分配，必保事实全保）；Writer Stage **PASS**（真实 `writing.sections` 两次完成，每节 1 turn）；Citation / Fact Integrity **PARTIAL**（run 2 引用 / 数值 / 负对照全部正确，但 run 1 暴露的 framing 平台幻觉只在 1 次复验中归零）；Redundancy Quality **PARTIAL**（方向正确，幅度 −12% / −29% 相对不等价 Baseline，未复现夹具 −100%）；Workflow Resume **PASS（确定性测试）**（指纹 / attempt / previousFingerprint / 开关回退，无真实模型的 Resume 实跑）；Full E2E **N/A**（未跑 Review / Gate / Revision / Topic → PDF）。

## 12. 对任务十三问的直接回答

1. **两条路径如何改造**：§1——普通论文逐节分配 formal 证据 + 任务块 + 上限长度 + 计划 / 重复产物；综述沿用 refs 投影与白名单，只加任务块 / 上限 / 文献身份表 / 产物。
2. **role / task / evidenceIds 的产生与校验**：§2——代码确定性派生为主，Planner 可选字段宽容解析，形状校验进 `validateOutline`，evidenceIds 只认 formal 池 canonical ID。
3. **真实 Planner 可靠性**：两次 Survey Planner 都为全部章节给出合法角色，0 次降级；普通论文 Planner 的 evidenceIds 只有确定性测试。
4. **Evidence 是否按章节分配**：是（§5）：引言 / 结论 0，两个 develop 节互不相同，compare 全池，partial 只进 compare。
5. **必要事实与数值**：17 / 17 在位（两次）；5 项只在数学模式内，评估层已改为可见。
6. **Survey 证据与白名单**：契约零改动，0 越界。
7. **兼容性**：旧 Outline / Checkpoint 兼容（测试），指纹语义使 Resume 不静默换计划；真实模型下的 Resume 未实跑。
8. **是否减少有害重复**：有（9.8% → 7.0% / 8.6%），但未归零；残余可定位到多 conclude 结构与路线定义句。
9. **质量与成本**：事实全保、引用合法；每节 Writer 费用与 Baseline 持平（0.0092–0.0095 vs 0.0098），低于夹具 B2（0.0076）——真实 Planner 的 500–800 字上限与 survey prompt 更长。
10. **评价器**：只读报告 + style digest；Gate 不变；盲区①修复、③评估层修复、②未改。
11. **新的无依据机制 / 引用错误**：run 1 有 1 处平台幻觉（已修复）；run 2 无；引用 0 错误。
12. **是否默认启用**：**启用**（Planner 与分配通过、事实与引用完整、无回归），保留 `PAPERTEAM_ARGUMENT_UNIT_WRITING=false` 回退；但不宣称 PASS。
13. **是否需要完整 E2E**：需要——Review（style digest 的真实消费）/ Gate / Revision 对新稿件的行为、Resume 实跑、普通论文路径的真实 Planner + 分配，以及非末节 conclude 规则的 live 复验，都应在下一轮完整 Topic → PDF 中验证。

## 13. 命令、预算与产物

主要命令：`git status/rev-parse/log`、`rg` / `sed`、`npm run typecheck`、`npm run build`、`npx vitest run --maxWorkers=2`（分批）与全量、`npx vitest run --maxWorkers=1`（复跑 flake）、`node scripts/acceptance/argument-unit-production-live.mjs`（1 次 dry-run + 2 次 LIVE）、`latexmk -xelatex`、前端 `npm run typecheck` / `npx vitest run`、`git add/commit/push`。未新建分支，未安装依赖。

预算：上限 18 个 Runtime 任务（≤ 25 assistant turns 目标），实际 **15 任务 / 15 assistant turns**（run 1：1 Planner + 6 Writer；run 2：1 Planner + 7 Writer），每任务 1 个底层请求，GLM 全程 `accessed=none`；没有重试，没有追加预算。SDK estimatedCost 合计 0.1406（不是账单）；不含本会话工程 Token。

全量 backend vitest（2 workers）：第一次 **287 文件通过 / 1 失败 / 7 跳过，3197 通过 / 1 失败 / 20 跳过，264.9 秒**——唯一失败是 `test/evidence/researchEvidenceSupply.test.ts`「auto supply 的证据到达 Writer」：它只检查第一个 `writing/sections` prompt（引言），而 B2 下引言不注入正式 Evidence（真实行为变化，不是 flake）；按 §11 ② 改为等写作阶段完成后断言正文章节 prompt 含该证据且引言不含，单文件 10/10 通过；第二次全量 **288 文件通过 / 7 跳过，3198 通过 / 20 跳过，267.3 秒**，无失败（既有 SSE 计时 flake 本轮两次全量均未出现；`stylePolish` 两例只在定向批次 2 workers 下超时过一次，单独复跑 18/18）。日志：私人目录 `scratch/full-vitest-1.log` / `full-vitest-2.log`。

私人产物：`D:\PaperTeamData\M13_7_10`（两次 LIVE 的 Planner / 逐节 prompt 与输出、`outline.json`、`writing-plan.json`、`academic-redundancy.json`、`classified-pairs.json`、`result.json`（含评估）、run 1 的 `reevaluation.json`、run 2 的 LaTeX 编译目录与 PDF、budget ledger、种子项目工作区、全量测试日志），不进 Git；运行时授权只在 `~/.paperteam` 原位使用，未复制；公开报告不记录网关地址。
