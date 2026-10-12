# M13.7.7 — Cross-Section Writing：根因、执行链路与重设计

日期：2026-10-12。基线：`main @ fee574b0036cb099620c6f9712e9b71563164ce6`。执行环境：公司 Windows 工作站，仓库 `D:\Projects\PaperTeam`；新加坡 ECS 22 端口从本网络超时（ICMP 可达、GitHub 22 端口可达，判定为服务器安全组只放行家庭 IP），**远程 LIVE BLOCKED**，所有真实模型实验在本机通过既有 PiRuntimeAdapter 完成。M13.7.3 / M13.7.4 的私人原始输出（`D:\PaperTeamData\M13_7_3`、`M13_7_4`）不在本机，本轮未读取它们；两轮失败的归因只依据公开报告、冻结素材、两份 rejected patch 与源码。

**裁决：PARTIAL。** 根因已经定位并有源码与真实模型证据支撑：跨章节无意义重复的首要驱动不是"模型看不到前文"，也不是"模型不知道谁负责哪个概念"，而是**每一节拿到完全相同的证据快照、被要求写出固定长度、又被禁止使用引文之外的事实**——在这个输入组织下，重述同一机制、重复限制声明、补写引文外细节是仅有的三种"填满长度"的方式，两轮失败候选都没有触碰这一层。本轮最小原型（论证单元输入组织）在同一开发样本上把复述字符占比从 31.6% 降到 14.5%，机制与限制清单全部保留，费用反而下降 10.6%；但只有一个已见样本、未做 held-out、三项改动未拆分，**不足以改生产写作路径**。合入 main 的只有确定性跨章节复述探测器及其测试、公开 runner / fixture / 评估脚本与本报告。

## 1. 两轮失败的完整根因

### 1.1 Writer 的真实上下文（源码级，不是 prompt 字段）

调用链：`writingSectionsStage`（`backend/src/workflow/definitions.ts:5093-5173`）逐节调用 `WriterService.writeSection`（`backend/src/writer/WriterService.ts:407-470`）→ `buildSectionPrompt`（`:1977-2021`）→ `PiRuntimeAdapter.runAgent`，contextScope 固定为 `writing/sections`，sessionKey = `agent:{writer}:paperteam-{projectId}--writing/sections`（`backend/src/runtime/sessionKey.ts:27-44`）。同一项目所有章节共用一个 Pi `AgentSession`，自动压缩关闭（`PiRuntimeAdapter.ts:910-911`），Pi 每轮把完整 `context.messages` 发给提供商，PaperTeam 未设置 `transformContext`。

因此写第五章时模型确实看得到：系统提示（角色三句 + `<available_skills>` 名称/描述/路径）、前四章完整 prompt、前四章完整输出、任何工具调用与结果、当前 prompt。**前文不缺席**。缺席的是比例：每节 prompt 固定纪律约 1.8k 字、Evidence 块 2.5k 字（冻结样本），章节独有内容约 75 字（标题、文件名、一条 keyPoint），占 **1.6%**；到第五章，历史里重复的纪律 + 相同 Evidence 与前文正文之比按字符约 12:1 到 30:1。同一份 20 条 Evidence 在上下文中出现 5 次。会话轮转（`PiRuntimeAdapter.ts:1805-1848` 的预检：上下文预算 / 自愈 / 运行计数）之后不做任何摘要迁移（`:106-108`），模型只剩系统提示和当前 prompt。

生产 `idea_to_paper` 路径的证据选择在循环**之前**算一次（`definitions.ts:5112-5113`，`EvidenceSelectionService.selectForWriting`，上限 `FORMAL_EVIDENCE_LIMIT = 20`），同一数组传给每一节（`:5129`）。Survey 路径按 refs 逐节投影（`buildSurveySectionContext`，`backend/src/survey/sectionContext.ts:103-245`），但 `validateSurveyOutline` 不要求 synthesis 独占（`backend/src/survey/outlineValidation.ts:84-107`），comparison synthesis 没有 `detail` 维度时就只剩机制句。两轮冻结样本忠实复刻了生产的这一性质，所以它们测到的是生产问题，不是夹具假象。

### 1.2 信息预算：失败夹具与生产共享的结构

| 样本 | 唯一 quote 字符 | 不同 quote 数 | 每节证据 | 要求总长度 |
| --- | ---: | ---: | --- | ---: |
| m13-7-3 dev（Transformer） | 900 | 1 | 全部相同 | 5 × 350 |
| m13-7-3 frozen（DPR/RAG） | 773 | 2 | 全部相同 | 5 × 350 |
| m13-7-4 dev（LoRA/QLoRA） | 538 | 3 | 全部相同 | 5 × 350（prompt 默认 400） |
| m13-7-4 heldout（FedAvg/SCAFFOLD） | 655 | 4 | 3/5 节全部相同 | 5 × 350 |

每节 prompt 同时要求：`每写一个这类论断，先在上方 Evidence 中找到能支撑它的 claim`（`WriterService.ts:127`）、`完全没有证据时删除该具体论断，只保留无争议的背景性叙述；禁止凭模型记忆`（`:130`）、`不得借背景段落补写具体机制`（`:207`）、`目标长度：约 N 字`（`:2012`）。在 2–4 条机制引文、1750 字总量的约束下，可合规产出的事实句只有那几条机制句；填满长度只剩三条路：重述机制（跨节重复）、重复限制（重复免责）、推断细节（证据越界）。三者正是两轮报告逐项记录的全部症状。

### 1.3 Prompt 经济学：约束为何无效

- 每节 prompt 约 50 条命令式规则（审计清单见 §2），其中反重复只有一句：`各节承担不同论述任务，避免重复同一观点；摘要与结论必要呼应可以保留。`（`WriterService.ts:136`），位于 `4. 引用纪律` 与 `5. 保持术语一致` 之间的无编号段落末尾，紧跟一个由模型自行判断的例外。
- 限制声明被四处要求、一处劝阻：`科学限制必须保留…不能隐藏这一限制`（`:135`）、空实验上下文块 `在局限性中准确说明缺少的评测`（`:1949-1956`，对方法章节同样渲染）、夹具 `instructions` 的 `保留必要学术内容及限制`、3/5 节 keyPoints 自带限制语；劝阻只有 `不在引言、方法、讨论机械重复免责`。
- `renderEvidenceLines`（`:93-117`）把 direct 记录的 claim 与 quote 各打印一次，partial 负例再打印同一 quote；冻结样本里 DPR 机制句在一份 prompt 中出现 4 次。
- M13.7.3 patch 的 `renderCrossSectionContext` 在 `===== 论文大纲 =====` 标题下插入其他节 keyPoints 与至多约 5.2k 字前文摘录，规则句 `仅作必要承接，不重新完整介绍` 后紧接 `必要定义提醒…应保留`；没有一句"以下句子不要复述"，首节完全不受约束。M13.7.4 patch 的职责块约 600 字，`当前章必须回答` 与 keyPoint 逐字相同，`reminder: brief|reference` 只渲染成括号 `（其他章简短回顾）`，`reference` 从未被夹具使用，唯一量化的 `至多用一句短提示承接` 后面同样跟着 `允许为理解当前论点简短回顾定义`。
- 两份 patch 都没有改变：每节相同的证据、固定长度、四处限制要求。它们改的是"在哪里展开"，没改"除了重述还能写什么"。

### 1.4 技能从未被读取

Writer 的 `academic-writing-zh` 只以 `<skill><name/><description/><location/></skill>` 进入系统提示（Pi `skills.js:275-297`；PaperTeam `noSkills: true` + `additionalSkillPaths`，`PiRuntimeAdapter.ts:2609-2616`）。`accessed` 只有当模型对技能目录发起 `read` 时才记录（`:3399-3427`）。系统提示同时写着 `你的任务指令会在每条用户消息中完整给出`（`backend/src/runtime/pi/roleConfig.ts:36`）。两轮 `accessed=[]` 的含义是：技能正文（含 `academic-style-zh` 中唯一具体的重复判据 `保留一处最完整的表述，其余删除或改为引用前文`）零字节到达模型。本轮 GLM-5.3 三臂 15 节全部 `accessed=none`；Fable 在第一节主动 `read` 了 `academic-writing-zh`（2 turns），之后四节不再读。

### 1.5 生成后没有协调机制

- Reviewer digest 每节 3600 字、最多 24 节、总 60000 字（`definitions.ts:7985-8015`）；`ReviewIssue`（`backend/src/agents/ReviewerService.ts:45-93`）只有单个 `section` 字符串，没有 quote / 第二位置；style 提示里的跨节概念只有"跨章节重复免责"（`:618`）。
- 全库没有确定性跨节相似度检测（grep `repeat|重复|duplicate|similarity|jaccard|shingle`：`quality/factRestore.ts:59` 的 `jaccard` 用于冻结稿段落对齐，`styleSignals.ts` 逐段正则，`writingInvariants.ts` 只看引用 key）。
- Review 驱动的修订条目永远是整节（`findingItem`，`backend/src/review/revisionPlan.ts:535-555` 不设 `targetQuote`）；minor → `skipped`（`:336-341`）；`sections/*.tex` 目标不走 `checkRevisionScope`（只有单文件 `logicalSpan` 走，`definitions.ts:2064-2080`），整文件覆写（`:2277, :2361`）。
- 合法的"把重复段压成一句回指"会被 `attachMustPreserveConstraints`（`:3714-3733`，目标文件全部数字与 cite 冻结）与 Fact Preservation `prose_number`（`backend/src/quality/factPreservation.ts:1684-1694`，除非计划文本逐个点名数值并带删除动词）拒绝；Style Polish 的 `checkStyleInvariants`（数字 / 哨兵词 / 受保护术语多重集，`backend/src/review/styleInvariants.ts:291-400`）结构上禁止任何压缩。

### 1.6 归因结论

| 症状 | 首要原因 | 层次 |
| --- | --- | --- |
| 同一机制多节完整重述 | 相同证据快照 × 固定长度 × 仅引文事实；首节无约束先行展开 | Workflow / 输入组织 |
| 重复免责 | 四处要求一处劝阻；空实验块渲染进方法章；partial 负例每节各"拆弹"一次 | Prompt 设计 + 输入组织 |
| 引文外机制细节 | 长度压力下的第三条出口；quote 覆盖核对缺句级工具 | Workflow + 模型 |
| 前文上下文无效 | 不缺前文，缺"不要复述以下内容"的可执行负向范围；历史被 6–30 倍纪律/证据稀释 | Harness |
| 职责契约无效 | 契约不改证据与长度；owner 只覆盖命名术语不覆盖机制句；例外句抵消 | Prompt 设计 |
| 技能无效 | 渐进披露 + "指令已完整" 系统提示 → GLM 从不读 | Harness |

## 2. 现有代码的真实执行链路（摘要）

Research → `EvidenceSelectionService.selectForWriting`（一次）→ `writingSectionsStage` 逐节 `buildSectionPrompt`（共享会话）→ `ManuscriptService.writeSection` 落盘 → `citation.verify` → `review.run`（digest → fact/academic/style 三路 → `aggregateReviews` 精确去重）→ `quality.gate`（无重复相关规则）→ `revision.plan`（critical/major 整节派发，minor skipped）→ `revision.revise`（整节重写，多文件无 scope guard）→ `revision.validate`（Fact / Citation / Claim Strength，文件级归因）→ 可选 `style_polish`（apply_once，不变量全保）→ build。Survey 路径在 outline 由 synthesis refs 分配，但不互斥；写作时只投影本节 refs，Writer 不知道别的节也拿到了同一条 synthesis。

## 3. 模型能力还是 Harness：同一 Harness 下的 GLM-5.3 / Fable 对照

本机 PaperTeam Runtime 已配置两条可用模型：Pi 内置 `zai-coding-cn/glm-5.3`，以及 Settings UI 保存的自定义提供商（Anthropic Messages 协议）上的 `claude-fable-5-1`。runner 用与 `backend/src/index.ts:110-121` 相同的 `registerStoredCustomProviders` 注册，两模型走同一 PiRuntimeAdapter、同一 `buildSectionPrompt`、同一夹具、同一共享会话策略；没有改 Runtime，没有导出或复制任何密钥。公开报告不记录网关地址。

夹具为 m13-7-4 的 LoRA/QLoRA 开发样本（已见样本，用作已知回归，不是 held-out）。每臂 5 节串行共享会话；基线臂的输入与 M13.7.4 Baseline 逐字节相同（dist 由 HEAD 重新构建）。

| 指标（基线输入） | GLM-5.3 | Fable 5.1 |
| --- | ---: | ---: |
| 汉字 / cite 命令 | 2052 / 13 | 2299 / 17 |
| 句数 / 跨节复述对 | 41 / 23 | 51 / 25 |
| 复述句数 / 复述字符占比 | 12 / **31.6%** | 15 / **32.2%** |
| 含复述的节 | 4/5 | 4/5 |
| LoRA 机制完整出现的节 | 5/5 | 3/5（引言、低秩、结论） |
| QLoRA 机制完整出现的节 | 4/5 | 4/5 |
| QLoRA 结果陈述出现的节 | 4/5 | 3/5 |
| "本文无实验" 出现的节 | 4/5 | 3/5 |
| E9 partial 相关免责句所在节 | 2 | **4**（引言、低秩、比较、结论） |
| 技能读取 | 0/5 | 1/5（首节） |
| 底层请求 / 任务秒数 | 5 / 63.2 | 6 / 77.2 |

人工阅读（原文在 `D:\PaperTeamData\M13_7_7\live\{glm,fable}-baseline\baseline-manuscript.tex`）：

- 两者的引言都完整解释了两种机制；结论都再次完整解释；比较节都重述 QLoRA 结果陈述。复述占比相同。
- Fable 的证据纪律表达更明确（低秩节 `关于秩分解矩阵的具体注入位置、秩的取值…本文所依据的证据未作进一步展开，此处不作推断`），但量化节仍写了引文没有的推断：`量化带来的表示误差不会因训练而累积至基座本身…要求训练过程在低精度基座与适配器参数之间建立可微的梯度通路`；引言写 `进一步降低基座模型的存储与显存占用`，quote 未覆盖。GLM 的越界句：`仍以原始精度存储`、`进一步降低存储压力`、`将"适配"与"预训练知识"分离`。
- Fable 把 partial 负例 E9 的"不保证任意任务与全量微调一致"在四节各否定一次——更强的模型更勤于"拆弹"，结果是更多重复免责。
- Fable 读了一次技能，之后行为与未读无明显差异（第二到五节仍重述）。

结论：**在相同的信息预算下，更强的模型没有减少跨章节重复**；它改善的是事实边界的表达方式，不是结构。重复是输入组织问题。证据越界在两种模型上都存在，是独立于重复的事实风险（§8）。费用：GLM 五节 SDK 估算 0.0296；Fable 经自定义提供商无单价，`estimatedCost=0`，只记录 token（cacheRead 65782 / cacheWrite 24449 / out 3199），不能与 GLM 直接比价。

## 4. 不同于前两轮的假设与最小原型

假设 H1（论证单元输入组织）：把"这一节用什么证据、承担什么论证功能、不解释什么、最多写多长"作为输入一起组织，而不是把全部证据和固定长度给每一节再附加规则。实现方式只用 `buildSectionPrompt` 已有参数：`evidence` 传本节分配的子集（引言 / 结论传空集，A 组为空、两篇文献落入 B 组背景引用）、`section.targetLengthWords` 传分配长度（180 / 350 / 350 / 300 / 160）、`extraInstructions` 追加一个约 400 字的"本节论证任务"块（角色、任务、不重新解释 X（见「Y」一节）、长度是上限不是配额）。**没有回灌前文原文，没有 concept→owner 枚举协议，生产代码零改动**。夹具与协议在首次请求前冻结（`scripts/acceptance/fixtures/m13-7-7/`，SHA256 见 `freeze-sha256.json`）。

假设 H2（生成后确定性定位 + 定向压缩）：新模块 `backend/src/review/crossSectionRedundancy.ts` 对不同章节的句子做 CJK 字符 bigram / 拉丁 token 的包含度与 Jaccard（默认 shared≥6、containment≥0.5、jaccard≥0.2），按大纲顺序报告"后节句 ≈ 前节句"的两处原句；然后用生产 `buildRevisePrompt` + `revisionItems[].targetQuote` 对后节段落发起一次受限压缩，再用 `checkRevisionScope`、cite key 多重集、数字 token 多重集和探测器复跑做确定性判定。

## 5. 真实 A/B 结果

预算：上限 20 次底层请求（assistant turns），实际 **18 任务 / 19 请求**，共享 ledger 先预留后派发，所有输出保留。模型设置、runner、fixture 在首次请求后未改；评估用的概念标记在看到输出后把 QLoRA 模式扩成同时接受 "4 比特 / 四位"（只影响计数，不影响 prompt、阈值与输出，三臂用最终标记统一重算，见 fixture README）。

### 5.1 H1：GLM-5.3 论证单元臂 vs GLM-5.3 基线臂

| 指标 | 基线 | 论证单元 | 变化 |
| --- | ---: | ---: | ---: |
| 汉字 / cite 命令 | 2052 / 13 | 1516 / 15 | -26.1% / +2 |
| 句数 / 跨节复述对 | 41 / 23 | 34 / 9 | -61% 复述对 |
| 复述句数 / 复述字符占比 | 12 / 31.6% | 6 / **14.5%** | -54% |
| LoRA 机制完整出现的节 | 5 | 2（低秩节 + 比较节一句） | |
| QLoRA 机制完整出现的节 | 4 | 2（量化节 + 比较节一句） | |
| QLoRA 结果陈述出现的节 | 4 | 2（量化节 + 比较节限制清单） | |
| "本文无实验" 出现的节 | 4 | 2（引言界定 + 比较节集中） | |
| 不能排序 / 不作断言出现的节 | 3 | 1（比较节） | |
| E9 升级 / E9 免责句 | 0 / 2 节 | 0 / 0 | |
| 非缓存 input / output tokens | 11172 / 1633 | 10088 / 1330 | -9.7% / -18.6% |
| cache read | 26176 | 25088 | -4.2% |
| SDK estimatedCost | 0.02963 | 0.02650 | **-10.6%** |
| 任务秒数之和 | 63.2 | 60.5 | -4.3% |

人工核对（`live/glm-argument-unit/argument-unit-manuscript.tex`）：

- 引言只点名两条路线并指向展开位置，零机制细节；结论只写继承/扩展关系与一句 `「综合比较与局限性」一节已集中陈述相关限制`，未来评测明确为计划。
- 必要内容清单全部保留且各在其位：LoRA 冻结权重、注入秩分解矩阵（低秩节）；QLoRA 四位量化冻结主干、梯度反传到适配器（量化节）；小型高质量数据集结果按引文范围转述（量化节）；本文无实验、仅两篇摘要、不能排序（比较节集中）。引用 15 次未减少；结论节 0 次引用（基线 3 次），属风格差异不是信息丢失。
- 残留问题：比较节仍各用一句重述两种机制（探测器 containment 0.842 / 0.692），虽然已声明 `在不重复展开机制细节的前提下` 并附回指；三处 `将在「…」一节完整展开` 式路标句形成新的轻度模板化（探测器也命中了它们）；低秩节 `该方法的适配开销主要来自秩分解矩阵` 与比较节 `LoRA 冻结的是未经量化的预训练权重` 仍是引文外推断，但越界句少于基线。
- 篇幅缩短 26% 来自引言 / 结论按分配长度收缩与限制集中，不是删除事实；按协议，缩短本身不计为改善，改善以复述下降 + 清单全保 + 无新越界为准。

这是**单一已见样本、单次采样、三项改动捆绑**（证据分配、论证角色/负向范围、长度释放）的开发证据，不是 held-out 泛化证据，也不能分辨三项改动各自的贡献。

### 5.2 H2：对 GLM 基线草稿的 3 次定向压缩

| 目标 | 探测器判定的"前节" | 范围守卫 | cite / 数字守卫 | 复述对 | 判定 |
| --- | --- | --- | --- | ---: | --- |
| 量化节结果段 | 引言 | 通过 | 通过 | 2 → 2 | 拒绝（未减少） |
| 结论首段 | 引言 | 通过 | 通过 | 10 → 9 | 接受 |
| 比较节主段 | 低秩节 | 通过 | 通过 | 9 → 5 | 接受 |

三次 patch 全部严格限于 `targetQuote` 段（段外字节相同），保留全部 cite key，数字无增删；GLM-5.3 在显式 `唯一允许修改的原文` 契约下没有发生 M13.7.6 那类范围越界。每次约 3.4k 非缓存 input、~0.0064 费用、7–8.5 秒。全稿复述字符占比 31.6% → 29.5%。

但结果暴露了 H2 的设计前提：探测器以大纲顺序把"先出现"当作"主展开"，而基线的引言先于低秩节解释了全部机制，于是压缩指令让结论回指「引言」、让本应持有结果陈述的量化节回指引言——**方向反了**。确定性探测器能可靠定位两处原句，但不知道谁是 owner；owner 必须来自规划（H1 的论证单元）。H2 只能作为 H1 之后的安全网，不能单独成立。

## 6. 方案比较与排序

| 方案 | 两轮失败的教训 | 本轮证据 | 复杂度 / 成本 | 排序 |
| --- | --- | --- | --- | --- |
| B. 按证据与论证单元组织 Writer 输入 | 两轮都没改输入组织 | 开发样本复述 -54%、费用 -10.6%、清单全保 | 低：`writingSectionsStage` 逐节选证据 + Outline 字段（role / task / evidenceIds / doNotExplain / targetLength）+ 长度上限语义；无新协议枚举 | **1** |
| C. 生成后确定性定位 + owner 感知的定向压缩 | 无人尝试 | 守卫 3/3 通过、两处定位准确，但 owner 方向需规划提供 | 中：探测器已合入；需 Fact Preservation 对 targetQuote 内且 owner 节仍存的数值豁免（`factPreservation.ts:602-648`）、多文件目标补 `checkRevisionScope`、issue 增加第二位置 | 2（依赖 B） |
| D. 更强模型做规划 / 全篇审查 | 两轮只用 GLM | Fable 不减少重复，但证据边界表述更好、会读技能 | 低：仅角色模型路由 | 3（配合 B/C，用于 outline 与 review，不用于每节） |
| A. 继续加 Prompt / Outline 规则 | 两轮失败、成本 +34.7% / +25.1% | 本轮只做"去掉强制项"（长度=上限、空实验块不进方法章）才有意义 | 极低 | 4（仅作为 B 的组成） |
| E. 大纲期信息预算校验 | 无 | 夹具/生产共性：唯一 quote 字符 ≪ 要求总长 | 极低：Outline 校验加一条确定性 warning，自动把 targetLength 收到预算内 | 并入 B |

不推荐：新 Agent Runtime、数据库、长期记忆、把前文原文回灌（M13.7.3 已证成本上升无收益）。

## 7. 本轮工程改动与未改动

合入 main：

- `backend/src/review/crossSectionRedundancy.ts` + `backend/test/review/crossSectionRedundancy.test.ts`（7 项）：确定性跨章节复述探测器，纯函数，**未接入** `review.run` / Gate / Revision；是评估仪器与后续 Reviewer 定位的候选输入。
- `scripts/acceptance/argument-unit-writing-live.mjs`、`scripts/acceptance/m13-7-7-evaluate.mjs`、`scripts/acceptance/fixtures/m13-7-7/`（dev.json / protocol.json / concept-markers.json / freeze-sha256.json / README）。
- 本报告与研究索引。

未改动：Writer / Outline / Reviewer / Revision 生产代码、Checkpoint、existing-paper-revision、任何 Gate 阈值。理由：H1 只有单一已见样本，按本轮纪律不得据此改生产；H2 的 owner 方向问题说明它必须跟随 B 一起设计。

## 8. 需要独立排期的科研事实风险

与重复不同的一类问题在三臂、两种模型上都存在：引文没有覆盖的机制推断（`仍以原始精度存储`、`不参与梯度更新`、`表示误差不会…累积至基座`、`降低存储与显存占用`）。它们大多"可能为真"，但不满足 Evidence 范围。M13.7.2 的 partial 边界、M13.7.5/7.6 的公式与数值守卫都不覆盖"无数字的机制句"。建议独立任务：对机制类句子做句级 quote 覆盖核对（可复用 claim decomposition + 本轮探测器的分句/分词），把"合理阐释"从 Fact Reviewer 的放行理由中移除；不与去重合并处理。

另一个独立风险：partial 负例（E9）在基线上成为每节"拆弹"的吸引子，Fable 四节各否定一次。证据供给层应把 partial 记录只交给 owner 节，而不是全部章节。

## 9. 是否值得继续投入

值得，但方向要换：不要再在"给前文 / 给职责"上加 Token。下一轮应当：

1. 冻结一个未见主题（非 Transformer / DPR / LoRA / FedAvg），用同一 runner 跑 B 的三项拆分（只分证据 / 只改长度口径 / 只加论证任务）各一臂与捆绑一臂，确认哪一项是主效应；预算 ≤ 20 请求。
2. 若 held-out 复现 ≥ 30% 复述下降且清单全保，把 B 落到 `writingSectionsStage`：逐节证据选择 + Outline 可选字段 + 大纲期信息预算 warning；Planner 侧避免 M13.7.4 式枚举字段，`role` 四值足够，`doNotExplain` 由 owner 自动派生。
3. 然后再接 C：Reviewer style 提示注入探测器的两处原句（有界），issue 增加 `relatedSection` / `quote`，Fact Preservation 加 owner 存在性豁免，多文件目标补 scope guard。
4. D 只用于 outline 与全篇 review 的模型路由，不用于每节写作。

## 10. 判定

**PARTIAL。** 根因：Workflow / 输入组织为主（相同证据 × 固定长度 × 仅引文事实），Prompt 设计为辅（反重复一句、限制四处要求、技能不被读），模型能力不是主因（Fable 同输入同占比）。最小原型在开发样本上有真实改善且更便宜，但未经 held-out，未拆分，未进生产。证据越界是独立问题，需单独排期。

### 命令、Token 与产物

主要命令：`git status/rev-parse/fetch/log`、`gh api/run list`、`ssh`（超时）、`rg`/`sed`、`npm run build`（43 s / 38 s）、`npx vitest run`、`node scripts/acceptance/argument-unit-writing-live.mjs`（四臂 + 两次 dry-run）、`node scripts/acceptance/m13-7-7-evaluate.mjs`、`git add/commit/push`。未新建分支，未安装依赖。

本机回归：后端 `npm run typecheck` 通过；全量 Vitest（4 workers）**3144 通过 / 1 失败 / 20 跳过，282 文件通过 / 1 失败 / 7 跳过，176.9 秒**。唯一失败是 `test/workflow/sseCancelSemantics.test.ts` 的重连计时用例（等待 `awaiting_input` 超时并连带 afterAll hook 超时），与本轮改动无关（本轮只新增纯函数模块与其测试）；单独复跑该文件 3/3 通过（330 ms），新探测器测试 7/7 通过。不把全量写成全绿；GitHub CI / Linux Integration 以本提交 SHA 的实际状态为准。

| 臂 | 任务 / 请求 | 非缓存 input | output | cache read | cache write | SDK estimatedCost | 秒数之和 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GLM 基线 | 5 / 5 | 11172 | 1633 | 26176 | 0 | 0.02963 | 63.2 |
| Fable 基线 | 5 / 6 | 22 | 3199 | 65782 | 24449 | 无单价 | 77.2 |
| GLM 论证单元 | 5 / 5 | 10088 | 1330 | 25088 | 0 | 0.02650 | 60.5 |
| GLM 定向压缩 | 3 / 3 | 10202 | 894 | 3968 | 0 | 0.01925 | 23.7 |
| 合计 | **18 / 19** | 31484 | 7056 | 121014 | 24449 | 0.07538（不含 Fable） | 224.6 |

Fable 经自定义提供商的 token 口径由网关返回（几乎全部计入 cache write/read），不与 GLM 的 input 直接相加比较。SDK estimatedCost 不是账单；不含本会话的工程 Token。

私人产物：`D:\PaperTeamData\M13_7_7`（freeze-manifest、dry-run prompt、四臂 prompt / 输出 / usage / 探测器报告 / 评估 JSON / 日志、budget ledger、空项目工作区），不进 Git；运行时授权只在 `~/.paperteam` 原位使用，未复制。
