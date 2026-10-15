# M14.2 — Thesis-from-Papers Agent Workflow（收口报告）

- 日期：2026-10-15
- 基线：`origin/main @ 6e032d3d615cfedaee220450e3af4829e6475f45`（M14.1c COMPLETE）
- 状态：**COMPLETE**（真实学术材料与质量验收归 M14.3，见 §16–§17）
- 开发与验收位置：Windows `D:\Projects\PaperTeam`（编辑 / Git）+ 新加坡 ECS `47.84.30.153` `~/paperteam-dev`（全量测试 / 真实 LaTeX 编译 / 真实模型 Smoke；生产容器与宿主机隔离未动）

---

## 1. 最终状态

**M14.2 COMPLETE。** `thesis_from_papers` 作为第五类 WorkflowKind 正式接入 Workflow Router，从 ResearchInput 登记到 ctexbook Draft PDF 的完整 Agent 工作流可运行、可恢复、受科研真实性约束。确定性 E2E 五路径全过；真实 LaTeX 工作流编译与真实模型 Smoke（3 次调用）在服务器完成；全量自动化测试 / typecheck / build 双端全绿，既有四类工作流零回归。

| 完成标准（任务 §16） | 结论 | 证据 |
| --- | --- | --- |
| thesis_from_papers 正式接入 Router | ✅ | §3；kinds.ts + 三处 definitionFactory + documentType 路由 |
| 多 ResearchInput 进入同一工作流 | ✅ | E2E 路径 A/B（2 输入）/ 路径 B（版本链 + 未发表政策） |
| Contributions / Outline / Chapter Mapping 可持久化 | ✅ | research/thesis-contributions.json、thesis-storyline.json、chapter-mapping.json、manuscript/outline.json、manuscript/thesis.json |
| HITL 决策可暂停与恢复 | ✅ | E2E 路径 B（冲突暂停→裁决→恢复完成）；checkpoint 持久化复用既有引擎 |
| 分章 Writer 真实接线 | ✅ | §6；writing.sections thesis 变体 + 事实纪律注入 + journal 恢复 |
| Review / Revision / Gate 真实接线 | ✅ | 共享后段同 id 复用；gate 四新规则 |
| Draft PDF 经 Artifact 系统交付 | ✅ | art-draft-rev{n} 注册；真实 LaTeX smoke PDF 魔数验证 |
| 未裁决冲突不得被静默忽略 | ✅ | writingBlockers fail-closed + gate thesis_conflicts_resolved + plan 条件节点 |
| Writer 不得自动创造科研结果 | ✅ | authorConfirmed 白名单纪律块 + 缺材料限制口径 + drift 邻域比对 |
| 被排除成果不得回到正式贡献 | ✅ | plannerContext 只取 included+preferred；映射 gate 复验 sourceInputIds |
| Citation / Evidence 规则不回归 | ✅ | 3588+ 全量回归 0 失败；thesis 写作沿用同一 bibliography/citation 链 |
| Review 覆盖率有证据 | ✅ | M14.1a coverage 机制经共享 review.run 自动生效 |
| Checkpoint 可恢复 / 已完成章节不重复生成 | ✅ | E2E 路径 D（中段失败→journal 复用 2 节，模型调用数 = 新写+1） |
| 取消 / 失败终态正确 | ✅ | E2E 路径 E（大纲不可修复→failed，无 Draft 冒充）；引擎既有 cancel 链路 |
| 创建入口 / HITL / Timeline / Draft 可见 | ✅ | §10（最小前端闭环） |
| 服务器全量测试 / E2E / 真实模型 / 推送 | ✅ | §12–§13、§18 |

## 2. 初始架构审计（Phase A）

四组并行只读审计（workflow 引擎 / thesis 模块 / Writer-Review-Gate / 测试模式与文档）+ 主会话复核，全部对照 `6e032d3d` 源码。

**已实现、直接复用（零重复开发）**：M14.1b 的 ResearchInputRegistry / ScientificFactStore / AuthorDecisionStore / `authorDecisionFromResumeInput`（该映射器在 M14.1b 就为 M14.2 的 HITL resume 预建）；M14.1c 的 ThesisDocumentService / thesisAssembler / genericCtexbookAdapter / 双通道编译器；M14.1a 的 writing-plan journal（节级断点恢复）、Review Unit 模式与 Coverage Ledger；planSharedTail 共享后段（citation→review→gate→revision→build 全链新鲜度/budget/HITL）；Experiment 上下文注入范式（`renderExperimentContextLines` 是事实纪律块的模板）；scriptedRuntime 的 scope 派生范式（survey fixtures）。

**真正缺失（本轮新增）**：第五类 kind 与路由；thesis 全部前段 stage；规划层三工件（贡献/主线/映射）与 ThesisPlannerService；thesis 写作上下文（事实纪律 + 源文本投影）；`published_facts_zero_drift` 等四条 gate 规则；build.draft thesis 分支；前端入口/面板/payload 渲染；testStack 的 thesis 服务束与 test_fixture actor 开关。

**关键引擎约束（设计决定）**：`plan(state)` 是纯同步函数——条件节点（冲突未决 / 缺材料）不能在 plan 里读服务层状态，改为「onInput（异步）应用决策后重估条件并写/删 stageResults 标记，plan 按标记决定重入或前进」；上界由 counters 保护（scope 24 / conflict 16 / author_decision 12 轮，超限 `fail(AUTHOR_DECISION_REQUIRED)`，不无限停留）。

## 3. Workflow Stage 实现

```
thesis.ingest            确定性：登记核验（≥1 输入，否则永久失败）+ parse 就绪 +
                         幂等 extractFacts/verifyFacts + detectConflicts
thesis.contributions     模型：逐输入贡献提案（thesis/contributions scope；
                         quote 逐字锚定确定性核验，未命中如实 not_found）
hitl.scope_and_version   HITL：include/exclude/select_version/allow_unpublished/
                         deny_unpublished/confirm_facts/confirm_contribution/
                         reject_contribution/approve/cancel；推进条件=范围类
                         pendingDecisions 清零 ∧ ≥1 入选 ∧ ≥1 已确认贡献
hitl.fact_conflicts      HITL（条件）：blocking 未裁决冲突 >0 时进入；
                         adopt_fact/keep_both/request_material/defer（defer 不解除阻断）
thesis.storyline         模型：一次提案 = 主线（narrative/structure/relations/order）
                         + 两级大纲（章→节）+ 章节映射；≤2 次 error-feedback repair
hitl.outline_confirm     HITL：approve（冻结映射 confirmed）/revise≤3/cancel
thesis.evidence_supply   服务层：outline literatureRefs 主题 → academicSearch →
                         saveCandidates → 复用 supplyResearchEvidence 有界管线
                         （候选→提升→全文→chunk→定向 grounding，12/6/6）
hitl.author_decision     HITL（条件）：缺材料章（method/experiment 有 owner 贡献
                         但无可用事实且无 writing_pause 决定覆盖）；选项
                         write_as_limitation/defer_chapter/attach_experiment_package/
                         pause/approve/cancel——不存在「编造数值继续写」
writing.sections         thesis 变体（同 id 复用共享后段新鲜度语义）：见 §6
（共享后段）             citation.verify → review.run（长文档自动 Unit 模式）→
                         quality.gate（+四规则）→ bounded revision loop →
                         build.draft（thesis 分支）→ build.final
```

所有 stage 满足任务 §4.3 十约束：输入/输出声明、产物持久化（research/*.json、manuscript-thesis/、checkpoint）、取消/失败收敛（引擎既有）、恢复（journal+checkpoint）、幂等（extractContributions/extractFacts 幂等、writing plan 指纹+outputHash 双核验）、输入版本变化失效（mapping 指纹 + gate 复验 + writing 前置 blocker 检查）、不静默假成功（E2E 路径 E）、stage 级诊断（stageResults/stageHistory/事件）、不绕过并发限制（全部走既有 Runtime/队列）、零第二套引擎。

## 4. ResearchInput → Contribution → Outline → Mapping

- **Contribution（`research/thesis-contributions.json`）**：模型提案（kind ∈ research_question/method/experiment_result/dataset/conclusion/limitation），`id = c-sha256(inputId|kind|归一陈述)[0:10]` 幂等；quote ≤400 字逐字锚定（空白不敏感，与 M14.1b 同口径）→ `verbatim / not_found / not_provided` 如实标注；`linkedFactIds` 确定性链接（陈述/引文包含事实 surface/raw 值）；确认只能由作者（HITL `confirm_contribution`，actor 记录 user/test_fixture）。真实模型 smoke：4/4 提案逐字锚定。
- **Storyline（`research/thesis-storyline.json`）**：narrative + structure ∈ progressive/parallel/framework/**fragmented**（缺共同主线必须给 scopeConcerns，不硬编统一创新点）+ 贡献关系 + contributionsOrder。
- **Outline**：扁平 sections（M14.1c 装配约束：每节恰属一章、单节章标题一致）；thesis 模式节数上限放宽至 60（`validateOutline` 参数化，缺省 20 不变）；`hitl.outline_confirm` approve 即映射冻结。
- **ChapterMapping（`research/chapter-mapping.json`）**：每章 responsibility/goal/sectionFiles/ownsContributionIds/referencesContributionIds/sourceInputIds/factIds + outlineFingerprint。**确定性校验全在代码**：贡献恰被一章拥有（ownership 唯一）、每个已确认贡献恰有一个 owner 章、method/experiment 章必须拥有贡献、sourceInputIds ⊆ included、factIds ⊆ 非冲突事实、contributionsOrder 覆盖全部已确认贡献、节文件跨章唯一。校验失败 ≤2 次 repair 后拒绝（不落盘半成品）。
- 一个贡献可被多章**引用**（referencesContributionIds，只许一句话提及）；一章可整合多输入（sourceInputIds 多值）。

## 5. HITL 决策

七类决定（任务 §6.1）全部落地：成果入选/排除（scope_decision）、版本选择（version_selection，workGroup preferredInputId）、未发表材料范围（unpublished_material_policy）、冲突裁决（conflict_resolution 四选项）、贡献与章节映射确认（confirm_contribution + outline approve 冻结 mapping）、大纲确认（approve/revise≤3/cancel）、缺实验材料处理（writing_pause 四选项 + approve 收口）。

**边界**：模型永远只产生提案；`hitl.scope_and_version` 的 payload 如实呈现 proposed/included/contributions（含锚定状态）/pendingDecisions/冲突计数，前端渲染「模型提案，需你确认归属」。缺作者决定 → awaiting_input（持久，checkpoint 落盘）；E2E 路径 B 证明暂停→裁决→恢复。缺实验章没有第四条路（任务 §8 与 M14.0.1 §4 一致）。

**测试与生产分离**：resume payload 可携带 `actorKind: "test_fixture"`，仅当 `services.thesis.allowTestFixtureActor === true`（testStack 显式构造参数，**非环境变量**）时接受；生产栈不设该字段 → 409 INVALID_REQUEST。E2E/Smoke 的全部作者决定显式 `test_fixture`，决定台账 actorKind 可审计。

## 6. 章节写作与恢复

- **逐章逐节**：outline 全序遍历，节→章映射（chapterByFile）；每节一次 Writer 任务（既有 `writeSection` 契约零改动，经 `extraInstructions` 注入 thesis 纪律块）。分章推进进度经 `emitProgress({chapter, section, index, total})` 进 Timeline。
- **事实纪律块（`thesisWritingContext.ts`，确定性）**：【学位论文章节】定位 + 【科研事实纪律】——authorConfirmed 事实表 = 唯一可写数值来源（≤30 行防 prompt 爆炸）；无已确认数值 → 「正文不得出现任何具体实验指标数值」；sourceVerifiedUnconfirmed 只许定性提及并标注待确认；conflicted 禁止择值；「禁止虚构实验结果」。+ 源文本投影（核心章：ParsedDocument 文本按节轮转分窗 ≤4500 字/节，任务=翻译/重排/衔接，supplemental/见附录一律转文字不转交叉引用）+ owns/references 贡献边界 + literatureRefs 文献主题 + 【作者决定：研究限制口径】（write_as_limitation/defer 章）。
- **不同章策略**：核心章消费源输入投影+事实白名单；绪论/综述走 evidence_supply 的正式证据 + bibliography 白名单（既有 A/B 组引用纪律自动生效）；总结章 references-only 引用既有贡献。
- **恢复**：复用 M14.1a `beginWritingPlan`/`resumableWrittenSection`（同 run + 同指纹 + 磁盘 outputHash 三重核验）；E2E 路径 D：第 3 节失败→stage 重试→前 2 节零模型调用复用（模型调用数 = 新写节 + 1）。写作尾部 syncReferencesBib → revisions.commit → thesisDocuments.assemble（确定性装配 manuscript-thesis/，源目录只读）。
- **不重复 / 不失效错**：章节恢复零重复（路径 D）；上游选择版本变化 → mapping 指纹失配 + writing 前置 writingBlockers 检查（版本重选后 preferred 变化 → plannerContext 分区变化 → 重写相关章，指纹级联）。

## 7. Evidence / Fact / Citation Guard

- **Evidence Supply**：写作前集中补证（literatureRefs 主题 ≤4 × 检索 6 条 → saveCandidates ≤5/主题 → `supplyResearchEvidence` 12/6/6 有界管线）；检索通道失败如实降级（degraded 标记，不阻断，质量由 review/gate 判定）；未经核验搜索结果不进 EvidenceStore（既有候选→提升→grounding 链）。
- **published_facts_zero_drift（gate，确定性）**：对象 = authorConfirmed ∩（章节 factIds ∪ owner 贡献 linkedFactIds）；对映射章正文机械比对：surface 命中=一致；数值 token 经 `compareFactValues`（M14.1b 等价类：equal / rounding_difference / equal_after_unit_normalization）→ 一致 / 受控等价 / **未授权变更（阻断）**；未提及=absent（不强制出现）。**防误报剥离**（确定性）：数学环境、`\cite/\eqref/\ref/\label` 等命令参数、表/图/式/章/步结构编号先剥离再比对（E2E 路径 A 首跑实锤 `eq:1` 与方程系数误报，修复后通过；±10× 数量级邻域只对同量级数值视为改写）。无法核验 ≠ 成功。
- **Citation**：thesis 写作沿用 buildCanonicalBibliography / syncReferencesBib / citation.verify / hallucinated_citations_zero 全链（E2E 证据：gate 全规则过）。
- **Review 覆盖**：M14.1a 机制经共享 review.run 自动生效（短文档 digest / 长文档 Unit 模式按 digestIsLossy 自动切换）；跨章一致性走 reviewCrossChapter（摘要输入、finding 双位置、不阻断）。

## 8. Review / Revision

review.run / revision.plan / revision.revise / revision.validate / 三 HITL（validation/stalled/overflow）/ style_polish 全部同 id 复用 planSharedTail（预算、新鲜度、收敛判定零改动）；M14.1b Finding→targetQuote 投影与 M14.1a logicalSpan 单元编辑在修订期照常工作。Revision 定向改章：修订目标仍按节文件/span 派发（scoped patch，不整篇重写）。

## 9. Quality Gate

四条新规则（thesis 项目必现，其余 kind 零变化）：

| 规则 | 阻断语义 |
| --- | --- |
| `published_facts_zero_drift` | unauthorized >0 → FAIL（明细含 factId/surface/observedValue） |
| `thesis_mapping_confirmed` | 映射缺失 / 未确认 / 指纹与 outline 不一致 / sourceInputIds·factIds 失效 → FAIL |
| `thesis_structure_complete` | ThesisDocumentModel 装配校验违规（未映射/重复映射/单节章标题不一致）→ FAIL |
| `thesis_conflicts_resolved` | 未裁决冲突 >0 → FAIL（写作前置检查之外的第二道防线） |

状态语义不混淆：Workflow completed（执行成功）≠ Draft 已生成 ≠ gate PASS ≠ Publication Ready（既有分层判定沿用，thesis 无 task-scoped 特例）。PDF 编译成功不改变 gate 语义；编译失败 buildOk=false 不注册产物（E2E 路径 E + 真实 smoke 各自证明）。

## 10. 前端接线（最小闭环）

- **创建入口**：学位论文卡真实接线——「基于已有小论文扩展」（缺省）→ `{documentType: master_thesis}`（后端路由 thesis_from_papers）→ 跳转项目页研究材料面板；「从研究主题开始」→ 显式 `workflowKind: idea_to_paper`（显式 kind 优先，documentType 路由不影响该路径）。占位「尚未接入」文案删除。
- **研究材料面板**（thesis 项目专属 tab）：类型选择 + 上传 PDF → SourceStore → 登记 ResearchInput（幂等）；输入清单（scope/parse/类型徽章 + 版本 + 发表状态）；快捷决定（入选/排除/允许未发表）；未裁决冲突清单（双方数值+定位，采纳任一方/并存声明）；启动工作流按钮。
- **HITL**：HitlPanel 新增四个 thesis payload 渲染（范围/贡献/事实计数、冲突双方、主线+章节结构+缺材料提示、缺材料章口径）；决策入口=研究材料面板（带 payload 的决定）+ 面板 approve/revise/cancel 通用按钮。
- **Timeline**：WORKFLOW_STAGE_SEQUENCES["thesis_from_papers"] 全序列 + 七条 stage 标签；写作进度 per-section 事件既有渲染复用。
- 前端测试：NewProjectPage 旧占位断言替换为两条真实创建路径断言（expand/topic）。**未做**：浏览器级 Playwright thesis e2e（HITL/resume API 交互已由后端 E2E 全覆盖；UI 走查留 M14.3，见 §16）。

## 11. Draft PDF

`build.draft` thesis 分支：装配复核（assemble 幂等）→ `runBuildGateForRevision`（参数化 manuscriptDir=manuscript-thesis + thesis 编译器 600s 预算）→ Build Gate（引用未解析 fail-closed 沿用）→ 事实保持硬阻断沿用 → `artifacts.ensureDraft`（art-draft-rev{n}，与 Artifact 系统完全一致：manifest、下载、Finalize 双 gate 对齐、build.final 复用）。**真实编译证据**：服务器 `PAPERTEAM_M142_REAL_LATEX=1` smoke——完整工作流（scripted 模型 + 真实 xelatex/bibtex/gbt7714）→ 45 页级 ctexbook PDF、`%PDF-` 魔数、draft 产物注册、门禁与编译全链通过；顺带修复 M14.1c 模板 bug（作者/学位信息全空时 titlepage 孤行 `\\` → "There's no line here to end"，此前 fixture 恰好带作者信息未暴露）。缺材料章按限制口径如实呈现（正文含「材料未齐/数据待补」表述，不编数值）。

## 12. 确定性 E2E（服务器 + 本地全过）

`backend/test/workflow/thesis.e2e.test.ts`（真实 WorkflowOrchestrator + HTTP + scripted runtime + 合成研究成果 fixture，两份关联 ResearchInput + 消融表事实 + 版本冲突表 + 9 节大纲 + fake OpenAlex 全文链）：

| 路径 | 结果 | 关键断言 |
| --- | --- | --- |
| A 正常 | ✅ | include+事实确认+贡献确认→大纲 approve→9 节写作（方法章 prompt 含「作者已确认的研究成果事实」与 0.724 白名单）→gate 四规则过→装配 main.tex=ctexbook→draft+final 产物、completed(final) |
| B 冲突 | ✅ | 3 条 blocking value_mismatch → 停等 hitl.fact_conflicts（payload 双方数值）→ 逐条 adopt_fact（等 awaiting 防竞态）→ 恢复完成；unresolved 最终 0 |
| C 缺材料 | ✅ | 无事实确认 → 停等 hitl.author_decision → write_as_limitation → 写作 prompt 含【作者决定：研究限制口径】与禁数值措辞；chaptersWithLimitationMode 记录 |
| D 恢复 | ✅ | 第 3 节注入非法 latex → stage 重试 journal 复用前 2 节（sectionsReused=2，模型调用=新写+1，零重复生成） |
| E 失败 | ✅ | 大纲输出持续非法 → repair 耗尽 → run failed；无任何 art-draft 产物冒充成功 |

新增确定性测试合计 **29 个**（thesisDefinition 9 / publishedFactsDrift 9 / thesisPlanner 6 / thesis.e2e 5）+ 前端 2 条创建路径；含确定性的 drift 分类（一致/舍入等价/单位等价/未授权/未引用 + 数学环境与结构编号剥离守卫）。

## 13. 真实模型 Smoke（服务器，预算 ≤24 次 / ≤$20）

`PAPERTEAM_M142_SMOKE=1 npx vitest run test/thesis/m142RealModel.smoke.test.ts`（凭据隔离在 `/data/paperteam-m14-2/runtime`，非仓库；模型 = settings 默认 zai-coding-cn/glm-5.3）：

| 调用 | 内容 | 结果 |
| --- | --- | --- |
| 1 | thesis/contributions：合成中文摘要（LTSN 方法+数值）贡献提取 | **4 提案 / 4 逐字锚定 verbatim**（含 method/research_question） |
| 2 | thesis/outline：确认 4 贡献后主线+大纲+映射 | **structure=progressive、5 章、15 节、repair=0**——真实模型首次输出即通过全部确定性校验并落盘四工件；method 章拥有贡献 |
| 3 | writing/sections：方法章首节（thesis 纪律块注入） | 2077 字中文 LaTeX（无 \documentclass，纪律块进入 prompt 确定性验证） |

调用数 3（含 repair 余量未用）；usage：写作调用 input 2534 / output 1263 / estimatedCost $0.0091（网关渠道按量计价为 list-price 估算；订阅渠道 per-call cost=0，如实记录 usage 而非编造支出）。墙钟 61.4s。**结论：真实模型确实能经 thesis_from_papers 受控通路完成贡献识别、章节规划与分章写作。**

## 14. 服务器性能

- 全量 backend：3588 passed / 29 skipped（env 门控）/ 104s（4 workers，15G 内存无压力）。
- thesis E2E 五路径：5.1s（scripted，栈启动占大头）；真实 LaTeX smoke 1.9s（TeX 温态，45 页级 ctexbook）+ 冷启动预算 600s（M14.1c 实测高校模板 133s+ 依据）。
- 真实模型：§13（3 调用 61s；规划 31s 内含 4 贡献→5 章结构）。
- 恢复收益：路径 D 实测重试只补失败节（调用数=新写+1）。
- ResearchInput 不重复解析：thesis.ingest 幂等（parse 已就绪即跳过；extractFacts 重放 created=0）。
- 内存：无新增长驻留结构；单事实文件沿用 M14.1c 判决（1832 facts 最重路径 <50ms）。

## 15. 测试与回归

| 项 | 本地（Windows） | 服务器（ECS） |
| --- | --- | --- |
| backend `npm test` | 3590 passed / 0 failed | 3588 passed / 29 skipped / 0 failed |
| frontend `npm test` | 343 passed / 0 failed | 343 passed / 0 failed |
| typecheck（前后端） | ✅ | ✅ |
| build（前后端） | ✅（backend） | ✅（backend + frontend） |
| `git diff --check` | ✅ | ✅（CRLF 归一后；Windows→服务器同步脚本已内置 LF 归一） |
| M14.1c 编译验收 | — | 10/10 PASS（模板修复后复跑） |

既有四类工作流（idea/existing improvement/existing review/survey）测试全部原样通过（3590 = 基线 3559 + 新增 31）。`workflowKindForDocumentType` 行为变化（master/doctoral thesis → thesis_from_papers）经全量回归确认无既有断言破坏；显式 workflowKind 优先语义保持。

## 16. 剩余限制（如实）

1. **Playwright 浏览器级 thesis e2e 未写**：HITL/resume/时间线 API 交互由后端 E2E 与前端组件测试覆盖；浏览器走查（研究材料面板上传真 PDF→工作流→Draft 下载）留 M14.3（与 M12 遗留 Browser E2E 一并补）。
2. **真实学术语料回归待补**：M14.0.1 语料在公司电脑，服务器无合法副本；本轮以合成 fixture + 真实模型合成语料 smoke 覆盖工程路径（M14.1b 的 env 门控真实材料 smoke 保留）。
3. **继承表格/图的受控插入**（InheritedTableAsset/InheritedFigureAsset）按任务 §15 不做，归 M14.3。
4. **跨章一致性**为 MVP（reviewCrossChapter 模型审查 + drift 数值机械比对 + structure 校验）；完整 ConsistencyLedger（术语/符号归并 HITL）按任务不做。
5. thesis.evidence_supply 的检索在无 provider 配置时如实降级（degraded），绪论外部文献质量依赖配置；综述章未挂 topic_survey 全链（按 M14.0 裁决 SELECTIVE）。
6. 修订期 thesis 纪律块未随修订 prompt 注入（修订走既有 scoped patch + 事实/引用守卫；drift gate 兜底数值纪律）。
7. 高校专用模板（thuthesis 等）未实现（generic-ctexbook 唯一模板；适配器接口已预留）。
8. `hitl.author_decision` 的 attach_experiment_package 路径目前=记录决定+等待（实验包上传与事实确认在既有实验面板/研究材料面板完成后再 resume）；无自动包解析。

## 17. M14.3 准备程度

就绪：工作流引擎、事实层、装配编译层、HITL 面板、E2E/Smoke 基建（全部可直接复用）。建议 M14.3 优先级：① 真实学术语料回归（范登平/白烨开放语料端到端 Draft + 与真实学位论文章节结构盲比）；② 继承表格/图受控插入（表格资产=单元格级 FrozenFact 已就绪，插入走 FigureService 式受控通道）；③ 浏览器级 thesis e2e + 截图；④ ConsistencyLedger 确定性部分（数据集/模型/符号名抽取+归并 HITL）；⑤ 修订期 thesis 纪律块注入；⑥ 高校模板第二适配器。PDF→Word 待办**保留登记不变**（本轮只确认存在，未实现未选型）。

## 18. Git 与 CI 状态

- 交付 commit：`f254105`（feat：代码 + 测试，33 文件）与 `b619521`（docs：收口报告 + 文档六件）；Windows 提交推送（服务器无 GitHub 凭据），`origin/main` 与本地一致。
- 不提交：私有 PDF、服务器凭据（`/data/paperteam-m14-2/runtime` 隔离目录 600 权限）、API Key、未授权研究数据。
- CI：push 后 GitHub Actions `test`（build/typecheck/test）+ `docker-build` 随流水线触发；Linux Integration（docling）按既有配置。状态以 Actions 页为准，未完成不宣称替代（本地/服务器等效命令已全绿）。

---

### 附：可复现命令

```bash
# 服务器（~/paperteam-dev/backend）
npm test                                                     # 全量 3588+ passed
npx vitest run test/workflow/thesis.e2e.test.ts              # 五路径 E2E
npx vitest run test/workflow/thesisDefinition.test.ts test/thesis/ # 结构/规划/漂移单元
node ../scripts/acceptance/thesis-compile-check.mjs          # M14.1c 10/10
PAPERTEAM_M142_REAL_LATEX=1 npx vitest run test/thesis/m142RealLatex.smoke.test.ts   # 真实编译工作流
PAPERTEAM_M142_SMOKE=1 PAPERTEAM_M142_RUNTIME_ROOT=/data/paperteam-m14-2/runtime \
  npx vitest run test/thesis/m142RealModel.smoke.test.ts     # 真实模型 3 调用
```

产物路径示例（E2E 项目根）：`research/{research-inputs,scientific-facts,thesis-contributions,thesis-storyline,chapter-mapping}.json`、`manuscript/{outline.json,thesis.json,sections/*.tex}`、`manuscript-thesis/main.tex`、`build/paper.pdf`、`artifacts/art-draft-rev{n}.pdf`。
