# M13.7.11 — Production Writing E2E & Quality Closure（B2 生产写作的同条件 A/B、真实 Review / Revision / Gate / PDF 与状态恢复）

日期：2026-10-12。基线：`main @ 0a382cece8cc97db60d04a06f38940d6da3b2812`（开始时本地 HEAD、origin/main、GitHub main 三者一致，工作区干净；M13.7.10 的 CI 与 Linux Integration 均为 success）。执行环境：公司 Windows 工作站 `D:\Projects\PaperTeam`；新加坡 ECS 保持关机，本轮未通过 SSH 触碰任何远程机器，不使用 AutoDL / GPU / Docker。真实模型验收在本机通过既有 PiRuntimeAdapter（生产等价接线：SkillRegistry 角色 skill + retrieve_library / evidence 工具 + 工作区隔离）调用 PaperTeam 已配置的 `zai-coding-cn/glm-5.3`；Claude Code（Fable 5.1）只做工程、人工核对与报告，没有跑 Fable 写作 / 审稿。

**裁决：PARTIAL（工程状态 PASS；论文质量结论：B2 在真实 Survey 生产路径上"事实完整、引用合法、结构更干净"成立，但"有害重复可信改善"在同条件 A/B 上不成立——Baseline 本身低于区分度下限；完整 Topic → PDF 未执行（预算 + 外部检索依赖），已执行的是 Outline → PDF 的 Stage Replay）。** 本轮用冻结的真实 Planner 大纲做了严格同条件的生产 A/B（14 个 Writer 任务），在生产 Orchestrator 上把 B2 稿件走完 citation.verify → review.run → quality.gate → revision.plan → revision.revise → revision.validate → 复审 → build.draft / build.final（三次 run、28 个 Runtime 任务），用真实 idea_to_paper Planner 验证了逐节证据分配（3 个任务），并用 checkpoint 恢复接口完成了两种真实 Resume。结论：B2 的生产接线、状态恢复、事实与引用保持、双 conclude 规则都通过了真实模型验证；但本轮同条件 A/B 显示，在真实 Planner 的七章综述大纲 + 生产 Survey prompt 下，**关闭 B2 的旧组织本身就没有可分类的有害重复**（指标 B 下界 0.0%），B2 反而多出 1 句引言路线定义句（4.1%），M13.7.9 夹具上 9.8% → 0.0% 的幅度在生产 Survey 路径上不可复现。按任务十一的原则，不以 M13.7.9 的夹具表现给生产 Workflow 判 PASS；B2 维持默认开启（无回归、结构收益真实、可关），M13.7 不在本轮宣布 COMPLETE。

## 1. 起始基线、冻结与真实 Git 状态

| 项 | 值 |
| --- | --- |
| 起始 HEAD = origin/main = GitHub main | `0a382cece8cc97db60d04a06f38940d6da3b2812`（工作区干净） |
| 冻结提交（首次 LIVE 请求前） | `017d1fd`：三个驱动 + 共享库 + 冻结真实大纲 + `protocol.json` + `freeze-sha256.json` |
| 研究输入 | `scripts/acceptance/fixtures/m13-7-9/heldout-qec.json`（12 条摘要级 verified Evidence，含 2 条 partial 负对照）、`concept-markers-qec.json`（17 项必保概念，12 项数值）、`sources-abstracts-qec.json`——与 M13.7.9 / M13.7.10 逐字节相同（sha256 见 `fixtures/m13-7-11/freeze-sha256.json`） |
| 冻结大纲 | `fixtures/m13-7-11/frozen-outline-qec-run2.json` = M13.7.10 run 2 的**真实 GLM-5.3 Planner 输出**（七章：introduction / surface-scaling / breakeven-logical-qubits / route-comparison / limitations / future-directions / conclusion；Planner 角色 framing / develop / develop / compare / compare / conclude / conclude；sha256 `d3f4467b…`） |
| 模型 / 运行参数 | `zai-coding-cn/glm-5.3`；A/B 两臂 maxConcurrentRuns=1（每次一个 Writer，独立项目 → 独立会话）；尾部 run maxConcurrentRuns=3（三路 review 并行，与生产一致）；超时 / 重试沿用生产 config |
| 预算 | 40 个 Runtime 任务上限，单一账本 `D:\PaperTeamData\M13_7_11\model-budget.json`（派发前预留；不自动追加）；实际 **38 任务 / 43 assistant turns** |
| 执行后 | 本轮提交见 §13（代码 / 测试 / 报告直接进 main） |

协议偏离如实记录：`survey-tail-live.mjs` 在 A/B 首个 LIVE 请求之后、尾部 run 首个请求之前追加了三个纯驱动开关（`--interrupt-at any`、`--style-policy apply_once`、`--style-polish apply|skip`；冻结 hash `eb1bfdb1…` → 现 `982b1147…`）。它们只影响 HITL 决策与 run request，不影响 A/B 的输入、评价器、阈值或任何生产 prompt；A/B 驱动 `argument-unit-ab-live.mjs` 与评价库 `lib/m13-7-live.mjs` 在整轮 LIVE 期间逐字节不变，生产 `backend/dist` 在所有 LIVE 请求期间都是冻结的 M13.7.10 构建（本轮生产代码修复在 LIVE 结束后才 build，见 §12）。

## 2. 验收链路审计（代码真实定义）

- `topic_survey`（`createTopicSurveyDefinition`）：前段十个 stage（research.plan → hitl.research_plan → survey.search → hitl.literature_selection → survey.fulltext → survey.matrix → hitl.matrix_confirm → survey.synthesis → survey.outline → hitl.outline_confirm）→ `writing.sections`（大纲指纹与已写修订一致时幂等跳过）→ `planSharedTail`：citation.verify → review.run（fact / academic / style 三路并行）→ quality.gate → 未过则 revision.plan →（有可派发条目或用户 revise_more）evidence.ground_claims / revision.restore_facts / revision.revise → revision.validate →（blocked 则 hitl.revision_validation）→ 尾部重走；planned=0 → hitl.revision_stalled；预算耗尽 → hitl.revision_overflow；gate 通过且 request.stylePolicy=apply_once 且有 style minor → hitl.style_polish → revision.style_polish（all-or-nothing invariant 守卫）→ build.draft → build.final。
- Resume 接口：`WorkflowOrchestrator.recoverInterruptedRuns()`（磁盘 checkpoint：running / pending → 重启执行循环；awaiting_input → 注册句柄等待 resume）与 `POST /api/runs/:id/resume`。
- 真实前段依赖：survey.search 走 `ResearchPlanExecutionService` → Discovery provider；本机 SearXNG 未运行（`PAPERTEAM_SEARXNG_URL` 未配置，127.0.0.1:8080 不通）；OpenAlex / arXiv / Crossref 本机可达（HTTP 200，6.2 s / 0.9 s / 1.5 s），Semantic Scholar 429。survey.fulltext 需要 docling（本机 2.130.0 可用）。即：从 Topic 启动的真实 Research 在本机**不是硬阻塞**，是预算决策（见 §5）。

## 3. 第二阶段：同条件生产 A/B（冻结方案与结果）

### 3.1 可比性（与 M13.7.10 的"夹具 vs 真实 Planner"不同，本轮严格同条件）

| 维度 | A（旧组织） | B（B2） |
| --- | --- | --- |
| 大纲 | 同一份冻结真实 Planner 大纲（7 节，sha256 相同） | 同 |
| 证据 / Synthesis / 文献库 | 同一 seeding 代码（`seedSurveyFixtureProject`，与 M13.7.10 逐字相同的 Matrix / Synthesis 构造）；dry-run 校验大纲 refs 零悬空，逐节绑定正式证据 0 / 7 / 3 / 12（2 partial）/ 0 / 0 / 0——与 M13.7.10 run 2 的投影一致 | 同 |
| 模型 / 适配器 | glm-5.3，生产等价 adapter | 同 |
| Stage 对象 | `createTopicSurveyDefinition(stack.workflowServices).writing.sections` | 同 |
| 开关落点 | `buildServiceStack({ writing: { argumentUnits: false } })`——与 `PAPERTEAM_ARGUMENT_UNIT_WRITING=false` 在 `index.ts` 的落点相同；**两臂各自实例化 ServiceStack / 进程 / 项目**，不是在已启动服务里改环境变量 | `argumentUnits: true` |
| 臂行为校验（从记录的 7 个 prompt） | 0 个任务块、7 个「目标长度：约 N 字」、无 writing-plan / 无 redundancy 产物 → consistent=true | 7 个任务块、7 个「不超过 N 字（上限参考）」、3 个文献身份表（framing + 两个 conclude）、0 路标模板、writing-plan + academic-redundancy-rev1 → consistent=true |
| 采样 | 各 1 次，A 先 B 后，无重采样、无样本挑选；首个 LIVE 请求后评价器 / 阈值 / 夹具 / prompt 零改动 | 同 |

角色映射对两臂使用同一份 `resolveArgumentUnits(冻结大纲 + synthesis)`（角色是大纲属性，不是臂属性；B 的 writing-plan 角色与之相同）。

### 3.2 结果

| 指标 | A（旧组织） | B（B2） | M13.7.10 run 2（同大纲来源，非同条件） | M13.7.9 夹具 A / B2 |
| --- | ---: | ---: | ---: | ---: |
| 汉字 / cite 命令 / 句数 | 3273 / 48 / 64 | 2914 / 38 / 57 | 2997 / 35 / — | 2694 / 32 ；1812 / 29 |
| 指标 A 词面复述占比 | 27.5% | 16.9% | 21.6% | 27.0% / 17.4% |
| **指标 B 有害占比 下界 / 上界** | **0.0% / 3.3%**（0 有害句，2 uncertain） | **4.1% / 6.4%**（1 有害句 P，1 uncertain） | 8.6% / 8.6% | 9.8% / 0.0% |
| 类别计数 M / L / P / S / X / E / F / uncertain | 0/0/0/0/8/5/4/2 | 0/0/1/0/6/2/0/1 | P1 + M3 | — |
| 路标句（非引言）/ 比较节逐字搬运 | 0 / 0 | 0 / 0 | 0 / 0 | — |
| 必保概念 17 项（数学模式感知） | 17 / 17（5 项仅数学模式） | 17 / 17（6 项仅数学模式） | 17 / 17 | 17 / 17 |
| 引用越界 key | 0 | 0 | 0 | 0 |
| 负对照升级（自动） | 0 | 0（E11 提及 1 次，已否定：「只能支持…有条件的表述，而非既成结论」；E12 显式拒绝） | 0 | 0 |
| 引文外数字 | 3 句（全部是「码距增加 2」，引文内） | 1 句（同上） | — | — |
| 限制句数 | 8 | 8 | — | — |
| Writer 非缓存 input / output tokens | 22707 / 3193 | 23504 / 2659 | 23542 / 2677 | — |
| SDK estimatedCost / 秒 | 0.0655 / 78.5 | 0.0672 / 76.7 | 0.0665 / 98.5 | — |
| 任务 / turns | 7 / 7 | 7 / 7 | 7 / 7 | — |

逐节汉字 / cite（A | B）：introduction 403/2 | 301/4；surface-scaling 632/11 | 673/9；breakeven 581/11 | 562/7；route-comparison 848/13 | 680/12；limitations 359/4 | 311/1；future-directions 172/3 | 138/1；conclusion 278/4 | 249/4。

**B 的唯一有害句**（P，引言）：「本综述聚焦超导平台上的量子纠错实验进展，围绕两条相互交织的技术路线展开：一是表面码逻辑量子比特的规模扩展，即通过增大码距来考察逻辑错误率随编码规模的变化，代表工作包括…」——与 M13.7.10 run 2 的 P 同形（路线级定义带半句机制，containment 0.684 对 surface-scaling 首段）。A 的引言也有同义句（「其一是基于表面码的编码规模扩展，通过增大码距检验逻辑错误率随码距的压制行为」）但词面 containment 未达阈值；两臂的差别是 1 句、在阈值边缘，不构成方向性证据。

**人工逐句核对（对照 `protocol.json#factAuditRedFlags.qec`）**：
- A：引言把 Ni 等 / Sivak 等并称为「辅助量子比特读取与玻色编码等体系」——「玻色编码」不在任何引文中（协议红旗「calling the Sivak et al. encoding GKP / bosonic / cat」命中 1 处）；比较节「后者以极小的硬件开销换取了高保真的症状提取」为引文外推断（轻）；引言含整段结构预告（六个 `\ref` 路标）与「超导量子电路凭借其可扩展的芯片制备工艺与高保真的门操作」背景句（引文外，轻）。
- B：无协议红旗；轻度外推 3 处：「前者以多比特平面网格为载体」（平面网格不在引文）、「数十至上百个物理比特」（引文只有 101）、「从 2022 年的跨盈亏平衡前夜」（修辞超出证据，后被真实 academic reviewer 以 minor 指出）；引言按文献身份点名代表工作，未补写平台 / 方法（M13.7.10 run 1 的里德堡幻觉修复在本轮再次成立）。
- 两臂的 E11 / E12 partial 命题都没有写成事实；B 在 compare 节逐条显式处理（E11 作有条件表述、E12「并非同一指标」）。

**结论（按冻结裁决规则）**：A 的有害句数 0 < 3 且下界 0.0% < 5%，**低于区分度下限**——本样本不具备去重区分度，百分比不作为通过判据；B 没有新增 A 没有的引文外机制红旗（反而少 1 处），必保事实全保，引用合法。B2 在生产 Survey 路径上的真实收益是**组织性的**（引言 −25% 字、无 `\ref` 路标段落、framing / conclude 不凭 key 补写文献内容、compare 节逐条处理 partial 命题、三个 conclude/compare 节更短），不是可计量的有害重复下降。M13.7.9 的 9.8% Baseline 来自普通论文 `buildSectionPrompt` + 人工五章大纲；生产 Survey prompt 本身含 synthesis 组织纪律与「各节承担不同论述任务，避免重复同一观点」，再加上真实 Planner 独立拆出的 limitations 节，使旧组织已经没有 M / L / P 可分类的重复——这是本轮最重要的实证修正。

## 4. 第三阶段：双 conclude 问题真实复验（LIVE PASS，单样本）

Arm B 使用的正是 M13.7.10 run 2 的「未来方向与展望」+「结论」双 conclude 结构；非末节 conclude 的任务块按 M13.7.10 末尾新增的规则渲染（「本节只陈述未来方向与开放问题…不总结各路线…总结由全文最后一节承担」，prompt 原文在私人目录 `ab-arm-B/writing-sections-6.prompt.txt`）。

| 检查项 | 结果 |
| --- | --- |
| future-directions 内容 | 138 汉字、1 个四 key 背景引用：统一任务 / 指标 / 平台下复现比较两类实验（speculative 措辞「值得探索的方向」）+ 一句「属于推断性展望，目前尚无实验验证」；无路线机制总结、无数值 |
| conclusion 内容 | 249 汉字：两条路线各建立了什么（按文献身份点名 4 个 key）、互补关系、一句限制承接、「比较基准尚未建立，其构建仍有待未来工作」 |
| 两节重复 | 分类器 M = 0（M13.7.10 run 2 为 M×3）、E = 2（结论对前文的必要概括，非有害）；真实 style reviewer 三轮都把「重复免责」指向 route-comparison / limitations / conclusion（与 future-directions 无关） |
| 展望写成已证实结果 | 否 |
| 必要科研限制遗漏 | 否（limitations 节 4 句 + 结论 1 句承接 + future-directions 1 句） |
| citation 白名单 | 两节全部 ∈ 各自 allowed 集（4 个 B 组 key） |

LIVE PASS 仅基于 1 个真实样本；后续两轮复审（§5）对同一稿件的 11 条 style/academic minor 中没有任何一条指向 future-directions 与 conclusion 的互相重复。

## 5. 第四阶段：综述 Workflow 的真实生产后半程（Stage Replay → PDF）

### 5.1 执行类别（如实分级）

本轮执行的是**「Outline → PDF 的 Stage Replay」**，不是 Topic → PDF：Arm B 项目在种子阶段已拥有合法来源（4 篇 arXiv 元数据 + 公开摘要）、12 条摘要级 verified Evidence、Survey Matrix（abstract_only / confirmed）、Structured Synthesis、冻结语料快照与 4 个 accepted 候选；`survey-tail-live.mjs --replay-front` 写入一个把前段十个 stage 标记为 `replayed`（带 note）的 checkpoint，交给生产 `recoverInterruptedRuns()`，之后全部由生产 planner 决定。Evidence 核验等级保持 abstract 级（不冒充全文 Verified）。Topic → PDF 未执行：按冻结协议需 ≥ 24 个剩余任务（前段 research.plan 1 + matrix ≈ 4 + synthesis ≈ 6 + outline 1 + 写作 7 + review 3 + 修订 ≥ 3），优先级 1–4 完成后仅剩 2 个；外部依赖方面 SearXNG 未运行、Semantic Scholar 429，但 OpenAlex / arXiv 可达——所以 Topic → PDF 的阻塞是**预算**而非唯一外部依赖，产品工作流部分标 **PARTIAL / BLOCKED (budget)**，不判 PASS。

### 5.2 三次真实 run（同一 B2 项目 `p-8ddfa9fda825`，生产 Orchestrator + HTTP API）

| run | 路径 | 任务 | 结果 |
| --- | --- | --- | --- |
| 1 `w-replaymv52la1q` | replay → writing.sections（**幂等复用 rev-1**，`reusedFromRevision: 1`，writing-plan 指纹 `72d4d4ba…` 不变）→ citation.verify（cited 4 / missing 0 / hallucinated 0 / mismatched 0）→ review.run r1 → quality.gate r1 → build.draft → build.final | 3（fact 2 turns、style、academic） | **gate PASS**（17 条规则全过；academic 85、styleRisk 30、critical/major/blocking 0、minor 11 = style 9 + academic 2；fact claims 18/18 SUPPORTED）→ `art-draft-rev1.pdf` + `art-final-rev1.pdf`（6 页、138 KB，正文 / 参考文献 / 数值在 PDF 文本中可见）→ completion `label=final, qualityStatus=PASS, revisionRounds=0` |
| 2 `w-replaymv52yfna`（request.stylePolicy=apply_once） | replay → 复用 → citation → review r2 → gate r2 **FAIL** → revision.plan（12 条全 minor → planned 0）→ hitl.revision_stalled（NO_PROGRESS）→ accept_draft → hitl.style_polish（**进程在此退出**）→ 第二进程 `recoverInterruptedRuns` → awaiting_input → resume(apply) → revision.style_polish（4 个 Writer 任务：abstract / introduction / breakeven / route-comparison）→ invariant 守卫 **2/4 失败 → all-or-nothing 原稿保留** → build.draft rev1 | 3 + 4 | completion `label=draft, QUALITY_NOT_REACHED`（唯一失败规则 `unsupported_critical_claims_zero`：1 条，见 §5.4） |
| 3 `w-replaymv535ub4` | replay → 复用 → citation → review r3（style 两次结构化修复，见 §12）→ gate r3 FAIL（major 2 + academic 79 + unsupported 1）→ revision.plan（17 条，planned 2）→ **revision.revise**（3 个 Writer 任务：abstract / breakeven / route-comparison，含 claimRepairs 1）→ **rev-2** → revision.validate（2/2 validated，0 rejected，fact preservation ok，citation preservation 51→51 key 不变，未 blocked）→ citation → review r4 → gate r4（resolved 2 规则，remaining 1，outcome IMPROVED，convergence PROGRESS）→ 预算耗尽（max 1）→ hitl.revision_overflow → accept_draft → build.draft rev2 | 5 + 3 + 3 | completion `label=draft, QUALITY_NOT_REACHED, qualityOutcome=IMPROVED, revisionRounds=1`；`art-draft-rev2.pdf`（6 页、137 KB；修订后的盈亏平衡定义「相匹敌的临界点」在 PDF 文本中可见，摘要中的英文残词 constituents 已消失） |

Draft / Final / Revision Complete / Publication Ready 的区分在产物上可见：rev-1 同时有 draft 与 final 工件（gate PASS 同轮冻结），rev-2 只有 draft（gate 未过，`qualityOutcome=IMPROVED`），artifacts `manifest.json` 记录每个工件对应的 revision、buildGate / qualityGate 轮次与 sourceRunId；最终 PDF 的修订号与 completion summary 一致（rev1 final / rev2 draft）。

### 5.3 Review 读取本轮正文、digest 消费与 Reviewer 契约

- 三轮 review 的 fact / academic / style prompt 都以 `buildManuscriptDigest` 的当前修订正文为输入（r1–r3 审 rev-1，r4 审 rev-2；`reviewedRevision` 随 review summary 落盘并与 gate 对齐）。
- style digest：**只**出现在 style prompt（r1 的 fact / academic prompt 中 0 次，style 1 次；注入内容 = rev-1 报告：词面 16.9%，有害下界 4.1%（1 句 P）/ 上界 6.4%，附原句）；r4 审 rev-2 时最新报告仍是 rev-1 → 修订号不一致 → 不注入（按设计）。Gate 规则集 17 条，无重复率规则。
- Findings 章节归属全部是本稿真实文件（`sections/route-comparison.tex` 等）；fact reviewer 的 claims 全部绑定到本项目 E001–E012。
- Style reviewer 确实消费了 digest：r1 / r2 / r3 都给出「跨章节重复免责」（route-comparison / limitations / conclusion 三处近逐字）与「引言预展开 owner 节机制」两类 finding——后者与分类器的 P 句相同。注意：分类器把三处限制句分别算作 limitation owner / uncertain / E（非有害），而真实 reviewer 判为重复免责——评价器对「重复免责」的召回低于人工（已知盲区②的另一面）。

### 5.4 真实 Reviewer Findings、修订与前后对比

| 轮 | rev | critical / major / minor | academic / styleRisk | 失败规则 | 关键 finding |
| --- | --- | --- | --- | --- | --- |
| r1 | 1 | 0 / 0 / 11 | 85 / 30 | 无（PASS） | 术语 syndrome/syndrom 混排、摘要 constituents、重复免责、四段同构开头、覆盖面窄 |
| r2 | 1 | 0 / 0 / 11 | 88 / 24 | unsupported_critical_claims_zero | 同上 + fact minor：「各不完美组件的相干性」作为制约来源无证据 |
| r3 | 1 | 0 / **2** / 12 | **79** / 18 | 上述 + open_critical_major_zero + academic_score_threshold | **major fact：盈亏平衡定义颠倒**（稿件写成「寿命仍然短于…这一临界点」）；major academic：综述覆盖面过窄且未声明选取标准 |
| r4 | **2** | 0 / 0 / 11 | 82 / 18 | unsupported_critical_claims_zero | 两条 major 已解决；新 fact minor：修订后的摘要「未覆盖阈值实验」与正文（acharya2024 是阈值以下实验）自相矛盾 |

同一 rev-1 稿件的三次独立 review：PASS / FAIL(1 unsupported) / FAIL(2 major + 79 分)——M11.3 量化过的 Reviewer 方差（academicScore 75–84、PASS/FAIL 抛硬币）在 B2 稿件上原样复现，不是 B2 引入的。

**修订（rev-1 → rev-2，revision.revise 真实 3 任务）**：
- breakeven：「盈亏平衡指编码后的逻辑量子比特寿命仍然短于…这一临界点」→「…与系统中最佳可用物理量子比特相匹敌的临界点」；「普遍停留在盈亏平衡点以下」→「寿命普遍短于…即处于盈亏平衡点以下」——major fact 正确修复，数值 / 引用未动。
- abstract：「物理 constituents」→「物理组成部件」；新增「本文是一篇基于四篇代表性实验文献摘要的受限综述，未覆盖阈值实验、早期重复码演示等奠基性工作」——响应 major academic，但「阈值实验、早期重复码演示」来自 reviewer 的模型记忆（finding 原文点名「2021 Krinner 等阈值实验」），不在任何证据中；r4 fact reviewer 立刻指出它与正文自相矛盾（minor）。这是 **Reviewer 记忆经修订进入正文**的一个真实样本（限制句而非事实断言，未触发事实守卫）。
- route-comparison（claimRepair：E012 refutation 句）：「…并非同一指标」→「…分属不同实验的指标设定」，**数值 G=2.27 / 2.4 倍未删除**（resolution 要求「数值只许删除」；Writer 保留了正确的拒绝比较句）。
- 修订后：17/17 概念在位（载体节逐项相同）、cite 命令 38 → 38、key 集合不变、无新引文外数字、负对照仍为否定形态、分类器指标与 rev-1 持平（16.7% / 4.1%）；fact / citation preservation 均 ok；validate 2/2 validated。

**残余阻断（三轮一致）**：`unsupported_critical_claims_zero` 的那 1 条 claim 是「相干增益 G=2.27 与表面码 2.4 倍寿命超越并非同一指标，不可据此判定优劣」——正是 compare 节对 partial 负对照 E012 的**正确拒绝**。r1 的 reviewer 把它绑到 E006（direct，2.4 倍）→ SUPPORTED；r2–r4 绑到 E012（partial，内容是「二者是同一指标」）→ `computeClaimGroundingReport` 用 `meetsEvidenceSupportQuality`（含数字的 claim 要求 direct 证据）把 reviewer 的 SUPPORTED 改判 UNSUPPORTED / opaque → `claimResolution` 走 `numeric_no_grounding → remove_unsupported_detail`。即确定性规则把「否定一条 partial 命题的句子」当成「凭 partial 证据断言数值」。这属于此前识别的独立科研事实风险（句级绑定 / 多 key 归因稀释），本轮只记录坐标（`backend/src/review/claimGrounding.ts` `meetsEvidenceSupportQuality` / `claimRequiresDirectSupport`；`claimResolution.ts` 5–7 阶梯），**未改 Gate 阈值或规则**；需要独立排期（§15）。

### 5.5 Style Polish（M5.4 路径）在 B2 稿件上的真实行为

run 2 的 4 个润色任务：abstract（constituents → 物理组成）与 breakeven（syndrome 统一）通过 invariant；introduction 被拒（删去「摘要」来源范围词：「来源范围或科研限制变化：减少 [摘要]」）；route-comparison 被拒（新增数字「6」——Writer 按 style reviewer 的建议写了「相关局限见第6节」；减少「不同」「不支持」、增加「局限」）。all-or-nothing → 原稿保留、`changed=false`。守卫行为正确：digest 诱导出的「压缩重复免责」建议在 reviewer 手里变成了**路标句 + 删科研限制**（M13.7.8 路标句根因经 Reviewer 回流），被确定性 invariant 拦下；代价是两处合法润色一并丢弃。对应修复见 §12（digest 使用口径补充，未 live 复验）。

## 6. 第五阶段：idea_to_paper 真实 Planner 与证据分配（真实模型证据，停在 Author Decision 边界）

`idea-planner-live.mjs`：种子 4 篇来源 + 12 条正式 Evidence（无 Survey 产物）→ 生产 `idea_to_paper` run：research.idea（1 任务，3 turns）→ evidence.ground（researcher 未提出新候选，formal 12）→ research.feasibility（1 任务）→ hitl.feasibility_confirm(approve) → outline.plan（1 任务）→ hitl.outline_confirm 时记录大纲并 **cancel**（不写作：无作者实验数据的研究论文不得为验收伪造结果）。idea：「面向超导量子纠错实验的统一指标比较框架：在同一口径下比较表面码规模扩展与突破盈亏平衡两条路线」。

| 项 | 结果 |
| --- | --- |
| Feasibility | **LOW**：缺全文、缺检索服务、无实验数据、框架换算有效性未验证；requiredExperiments 3 项、missingRequirements 4 项——正确停在 Experiment Requirement 边界 |
| Planner 大纲 | 6 节：introduction(framing) / background(framing) / framework(develop) / comparison(compare) / discussion(compare) / conclusion(conclude)；**6/6 节输出合法 `argument.role`，6/6 节输出 `evidenceIds`，28 个 ID 全部是 prompt 中出现的 canonical ID（0 个丢弃）**；无 task / doNotExplain |
| 分配（`allocateSectionEvidence`，冻结代码） | introduction pinned 4；background Planner 给 7 → 截到 4 并记诊断；framework（唯一 develop）pinned 4 + 相关性 4 + 覆盖兜底 4（E001/E004/E007/E009）= 全池 12；comparison pinned 8 + 相关性 4 = 12；discussion pinned 3 + 9 = 12；conclusion pinned 2（E004 + **E011 partial**）；unassigned 0；excludedNonFormal 0；partial 只出现在 develop / compare 与——**conclusion**（见下） |
| 缺陷 | ① Planner 把 partial 负对照 E011（「表面码已达到容错所需错误率」）钉到结论节，冻结代码照收（framing / conclude 的 pinned 不检查 supportStrength）——与「partial 只进 develop / compare」的设计相悖；**已修复**（§12）。② Planner keyPoints 把 E012（partial，「G 与寿命倍数可直接比较」）写成比较维度「寿命增益维度的直接可比性（G 与寿命倍数）」，并把 Sivak 编码写成「binomial 编码」（引文无此词）——Planner 层的 partial 升级与记忆补写风险；写作期 compare 任务块会把 E012 列为「还不能判断」，但未在本轮写作验证（按科研边界停止） |
| 诊断准确性 | framing 超限诊断正确；单 develop 节时覆盖兜底把 4 条相关性为 0 的记录全部补入 framework（设计行为，记 coverageAdded）；evidence_insufficient 未触发（develop 12 条） |

## 7. 第六阶段：Checkpoint / Resume

| 项 | 证据 | 判定 |
| --- | --- | --- |
| 写作前保存 → 恢复 | 三次 run 的 replay checkpoint（status=running、前段 replayed）经 `recoverInterruptedRuns()` → `outcome=restarted`，执行循环从 writing.sections 继续 | LIVE PASS |
| 已写完全部章节后的合法 Resume | 三次 run 的 writing.sections 都幂等复用 rev-1（大纲指纹 = 写作修订快照指纹），writing-plan 的 fingerprint / attempt / runId 不变，未重烧 7 个 Writer 任务 | LIVE PASS |
| 进程中断 → 另一进程恢复 → resume | run 2：hitl.style_polish 处进程退出（checkpoint `awaiting_input`），第二进程 `recoverInterruptedRuns` → `awaiting_input` → `POST /resume {apply}` → revision.style_polish 继续，stageHistory 连续 | LIVE PASS |
| 部分章节已写后的 stage 重试 | 新增确定性测试：第 3 节抛瞬时错误 → stage 失败 / 重试，同一 run 内 plan.attempt=2、指纹不变、无 previousFingerprint、前 2 节在两次尝试中证据 ID 逐节一致、5 节全部写完（`argumentUnitWriting.e2e.test.ts`） | 确定性 PASS（LIVE N/A） |
| 证据集合变化后不沿用失效 Evidence | M13.7.10 既有测试（新增 verified 记录 → previousFingerprint + 警告 + 重新分配）；失效记录不在 formal 池即不进分配 | 确定性 PASS |
| 旧 Outline / 旧 Checkpoint | M13.7.10 既有测试（无 `argument` 的大纲逐字节往返；stage 结果只增键）；本轮 replay checkpoint 没有任何 M13.7.10 新键也能被 planner 正常推进 | 确定性 PASS + LIVE 旁证 |
| 关闭 B2 恢复旧行为 | Arm A（LIVE，§3）+ 既有开关测试 | LIVE PASS |

## 8. 必保事实与引用保持（全程）

| 稿件 | 17 概念 | 12 数值 | 负对照升级 | 引用越界 / 幻觉 / missing | 引文外数字 |
| --- | --- | --- | --- | --- | --- |
| Arm A rev-1 | 17/17 | 12/12 | 0 | 0 / 0 / 0 | 0（「2」在引文内） |
| Arm B rev-1 | 17/17 | 12/12 | 0 | 0 / 0 / 0 | 0 |
| Arm B rev-2（修订后） | 17/17（载体节逐项相同） | 12/12 | 0 | 0 / 0 / 0；citation preservation 51→51 | 0 |

未被 Evidence quote 支持的技术细节（人工）：A 1 红旗（玻色编码）+ 3 轻；B 0 红旗 + 3 轻；rev-2 新增 1 处限制句级的 reviewer 记忆泄漏（「阈值实验、早期重复码演示」）。

## 9. 模型任务、turns、Tokens、费用与耗时（全部真实计量，SDK estimatedCost 不是账单）

| 实验 | Runtime 任务 | assistant turns | 非缓存 input / output | cacheRead | estimatedCost | 秒 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A/B Arm A | 7 | 7 | 22707 / 3193 | 75712 | 0.0655 | 78.5 |
| A/B Arm B | 7 | 7 | 23504 / 2659 | 86720 | 0.0672 | 76.7 |
| 尾部 run 1（review ×3） | 3 | 4 | 24433 / 4302 | 8320 | 0.0553 | 72.8 |
| 尾部 run 2 start（review ×3） | 3 | 4 | 23346 / 5618 | 8320 | 0.0596 | 94.2 |
| 尾部 run 2 recover（polish ×4） | 4 | 4 | 7572 / 1704 | 12544 | 0.0214 | 41.8 |
| 尾部 run 3（review 3+2 修复、revise ×3、review ×3） | 11 | 12 | 66436 / 14070 | 74432 | 0.1743 | 209.6 |
| idea_to_paper Planner | 3 | 5 | 11495 / 4272 | 13120 | 0.0383 | 80.2 |
| **合计** | **38 / 40** | **43** | 179493 / 35818 | 279168 | **0.4815** | 653.8（模型侧） |

每节 Writer 费用：A 0.0094，B 0.0096（持平；B 的 prompt 多出任务块与文献身份表，输出少 17%）。多轮请求的任务：fact review（2 turns，evidence_query 工具）与 research.idea（3 turns）。Claude Code 本会话的工程 token 不计入。

## 10. 新增缺陷、根因与处理

| # | 现象（真实 run） | 根因 / 坐标 | 处理 |
| --- | --- | --- | --- |
| 1 | 真实 idea_to_paper Planner 把 partial 负对照 E011 钉到结论节，分配照收 | `sectionEvidenceAllocation.ts` pinned 只校验 canonical / formal，不看 role × supportStrength | **修复**：framing / conclude 的 pinned partial 逐条拒绝，reason `partial_not_allowed_in_role`，进 diagnostics；单测 +1（LIVE 之后 build，未 live 复验） |
| 2 | style reviewer 把 digest 的「压缩为一句承接」写成「相关局限见第6节」并建议删「仅摘要」限定；润色 Writer 照做 → invariant 拒绝（数字 +6、限制词减少），4 任务全部作废 | `ReviewerService.ts` digest 使用口径未排除路标与科研限制删除 | **修复**：使用口径追加「承接不得写成见第 N 节…不得建议删除仅摘要 / 无本文实验 / 不可直接比较 / 不支持排序等科研限制」；测试 +2 断言（未 live 复验） |
| 3 | 对 partial 负对照的正确拒绝句被确定性 grounding 改判 UNSUPPORTED，三轮一致阻断 gate，resolution 要求删数值 | `claimGrounding.ts` `meetsEvidenceSupportQuality`（含数字 claim 要求 direct）对 reviewer 绑到 partial 证据的否定句无区分；绑定本身随 reviewer 采样变化（r1 绑 E006 则 SUPPORTED） | **记录，不改**（Gate 规则 / 阈值不动；属独立科研事实核验风险，§15） |
| 4 | style review 输出含 `\cite{…}` 未转义 → 严格 JSON 解析失败 → 宽容解析丢 riskScore → 结构化修复 prompt 只报「缺 riskScore」→ 模型两次原样重出（含 riskScore）仍失败，第三次才过；每轮最多 +2 任务 | `ReviewerService.ts` 结构化校验把解析失败折叠成字段缺失；私人目录 `tail-arm-B-revise/review-style-{1,4,5}.output.txt`（position 2216 `\c`） | **记录，不改**（超出本轮修复范围；建议修复 prompt 回显真实解析错误 / 允许无效转义） |
| 5 | 修订把 reviewer 记忆中的「阈值实验、早期重复码演示」写进摘要限制句，下一轮被判自相矛盾 | Reviewer finding 文本不受 Evidence 约束，修订 prompt 允许按 finding 改写限制句 | 记录（限制句不是事实断言，守卫按设计未拦；属 Reviewer 契约议题） |
| 6 | 同一 rev-1 三次 review：PASS / FAIL / FAIL(2 major) | M11.3 已量化的 Reviewer 方差 | 记录（不是 B2 引入；本轮的 gate 结论因此按「三轮联合」而非单轮解读） |

此外确认：planned=0（仅 minor + 1 条 opaque unsupported）时生产走 NO_PROGRESS → stalled 问人而不自动派发，是 M11.3 设计语义；本轮 revision.revise 的真实执行发生在 r3 产生 major 之后（自动派发），`--stalled revise_more` 未被触发。

## 11. 对任务十五问的直接回答

1. **起始基线 / Git**：§1。
2. **A/B 冻结与可比性**：§3.1（同大纲 / 同证据 / 同模型 / 同 stage 对象 / 开关在 ServiceStack 构造期 / 独立进程与项目）。
3. **执行路径**：§5（Stage Replay → 生产 Orchestrator 全尾部）、§6（idea_to_paper 真实前段到 outline confirm）。
4. **双 conclude LIVE**：PASS（单样本，§4）。
5. **有害重复比较**：A 0.0% / B 4.1%（下界），Baseline 低于区分度下限；词面 27.5% → 16.9%；结论是组织收益而非可计量去重（§3.2）。
6. **事实与引用**：三份稿件 17/17、引用 0 越界 / 0 幻觉、负对照 0 升级（§8）。
7. **Reviewer Findings 与修订**：§5.4（r1–r4 表、rev-2 三处修订）。
8. **修订前后**：major 2 → 0、academic 79 → 82、事实 / 引用保持 ok、残余 1 条确定性 unsupported（§5.4）。
9. **idea_to_paper Planner**：6/6 合法角色、28/28 canonical evidenceIds、分配可用、feasibility LOW 停在实验边界；1 个分配缺陷已修、2 个 Planner 层风险记录（§6）。
10. **Checkpoint / Resume**：三种真实恢复 + 新增确定性重试测试（§7）。
11. **任务 / turns / tokens / 费用 / 耗时**：38 / 43 / 179k+36k / 0.4815 / 654 s（§9）。
12. **缺陷与修复**：§10（2 修 4 记）。
13. **是否继续默认开启 B2**：**是**。理由：真实生产路径上无回归（事实、引用、Gate、编译、Resume 全部通过），framing / conclude 的文献身份表与 compare 的 partial 显式处理是可观察的科研事实收益（A 有 1 处 B 没有的引文外编码红旗），费用持平；但不再以「有害重复下降」作为其收益主张。
14. **M13.7 是否可以正式收口**：**否（PARTIAL）**。未满足的 PASS 条件：(1) 同条件 A/B 没有可信的有害重复改善（Baseline 无区分度，且单样本）；(5) Topic → PDF 未执行（预算阻塞，非唯一外部依赖）；(4) Survey 尾部虽有真实 Revision 证据，但三轮 gate 结论受 Reviewer 方差与确定性 grounding 误判支配。
15. **需独立排期的科研事实风险**：§15。

## 12. 工程回归

| 项 | 结果 |
| --- | --- |
| 生产代码修改 | `backend/src/evidence/sectionEvidenceAllocation.ts`（pinned partial × framing/conclude 拒绝）、`backend/src/agents/ReviewerService.ts`（digest 使用口径两句）——均在全部 LIVE 请求之后修改并 build |
| 测试 | `sectionEvidenceAllocation.test.ts` +1、`reviewerEvidencePrompt.test.ts` +2 断言、`argumentUnitWriting.e2e.test.ts` +1（部分章节已写后的 stage 重试 / Resume） |
| 定向回归 | writer / sectionEvidenceAllocation / academicRedundancyClassifier / crossSectionRedundancy / argumentUnitWriting.e2e / topicSurveyWriting.e2e：9 文件 116 测试通过（修改前基线）；修改后相关文件 3 + 9 + 4 + 3 全部通过 |
| backend typecheck / build | 通过 / 通过 |
| frontend typecheck | 未运行：本轮没有接口 / 类型改动（Outline schema、HTTP、stage 结果形状均未变） |
| `git diff --check` | 通过（仅 CRLF 提示） |
| 全量 backend vitest（2 workers） | 见 §13（日志 `D:\PaperTeamData\M13_7_11\scratch\full-vitest-1.log`） |
| LaTeX / PDF | 生产 `build.draft` / `build.final`（MiKTeX xelatex+bibtex）rev-1 与 rev-2 各编译通过，diagnostics 0；PDF 文本含全部章节标题、参考文献与数值 |

## 13. 命令、产物与提交

主要命令：`git status/rev-parse/log/fetch`、`gh run list`、`curl`（GitHub API / 学术 API 探测）、`npm run typecheck` / `npm run build`、`npx vitest run --maxWorkers=2`、`node scripts/acceptance/argument-unit-ab-live.mjs`（dry-run ×3 + LIVE ×2）、`node scripts/acceptance/survey-tail-live.mjs`（dry-run ×1 + LIVE start ×3 + recover ×1）、`node scripts/acceptance/idea-planner-live.mjs`（dry-run ×1 + LIVE ×1）、PyMuPDF 读 PDF 文本、`git add/commit/push`。未新建分支，未安装依赖。

私人产物（不进 Git）：`D:\PaperTeamData\M13_7_11\live\{ab-arm-A, ab-arm-B, tail-arm-B, tail-arm-B-polish, tail-arm-B-revise, idea-planner}`（逐任务 prompt / output、result*.json、writing-plan、academic-redundancy、classified pairs、reviews-* 全部 review / gate / plan / validation / style-plan / style-polish 产物、build-* 编译目录与 PDF、artifacts-* 工件与 manifest）、`model-budget.json`（38 条预留，逐任务 turns）、`projects\`（7 个验收项目含 workflow checkpoint 与 events）、`scratch\full-vitest-1.log`。运行时授权只在 `~/.paperteam` 原位使用；公开报告不记录网关地址。

提交：冻结 `017d1fd`；验收 + 修复 + 报告提交见本报告 README 条目对应的 main 提交（§14 执行后以 `git rev-parse HEAD` / GitHub API / CI 状态为准）。

## 14. 全量测试与 CI 状态

全量 backend vitest（2 workers）：日志 `scratch/full-vitest-1.log`。

全量结果（修改后一次通过）：**288 文件通过 / 7 跳过，3200 测试通过 / 20 跳过，265.1 秒，0 失败**（含本轮新增 4 个用例；无 flake 重跑）。

GitHub：push 后 CI 与 Linux Integration 的状态由 `gh run list` 核对，报告仅记录已完成的结论（见提交信息）；新加坡 ECS 本轮保持关机，Linux Integration 通过不等于 ECS 被启动。

## 15. 后续需要独立排期的科研事实核验风险（不在本轮扩大）

1. **否定 partial 命题的句子被确定性 grounding 当作数值断言**（§5.4 / §10-3）：需要在 `computeClaimGroundingReport` 层区分「引用 partial 证据断言其内容」与「拒绝 partial 证据的命题」（可用 reviewer 原 verdict + 否定哨兵 + partial 记录绑定三者联合判定），并给 resolution 增加「refutation_of_partial → 不删数值」分支；改动触及 Gate 规则 5/6 的计数口径，必须带 M11.3 式校准。
2. **Reviewer → 修订的记忆泄漏**（§10-5）：finding 文本点名证据外文献 / 事实时，修订 prompt 应要求只改写为无具名的限制句或要求 evidence_query；需要 Reviewer 契约与 Revision Fidelity（M13.7.5）联合设计。
3. **Reviewer 方差对单轮 gate 的支配**（§10-6）：M11.3 §12 的 gate 策略提案（稳定维度 / 多采样）仍未落地。
4. **句级机制 quote 覆盖与多 key 归因稀释**（M13.7.7 §8）：本轮两臂各有 3 处轻度引文外措辞，均未被 fact reviewer 标出。
5. **Planner 层的 partial 升级与记忆补写**（§6）：Planner keyPoints 可把 partial 命题写成比较维度、把编码名写成引文外术语；写作期任务块只覆盖 compare 节，framing / develop 的 keyPoints 仍可能携带。
6. **评价器对「重复免责」的召回**（§5.3）：真实 style reviewer 三轮稳定指出的三处限制句重复，分类器只给 uncertain / E；若要把 L 类做成可计量指标，规则需按 owner 节之外的限制句密度重新校准（不在本轮改，保持历史可比）。
7. **Topic → PDF 真实全链路**：需要 ≥ 24 任务预算与本机 SearXNG（或只用 OpenAlex / arXiv provider）的一次完整执行，才能把产品工作流部分从 PARTIAL 升为 PASS。
