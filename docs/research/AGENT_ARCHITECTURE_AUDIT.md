# PaperTeam Agent 架构审计（M6.4 后 / M6.5 前）

- 日期：2026-09-17
- 性质：**只读审计**，未修改任何代码
- 范围：`backend/src` 全量（18 目录 91 文件）+ `docs/ARCHITECTURE.md`、`docs/DECISIONS.md`、`docs/research/M6.1_SEARCH_RAG_ADR.md` 设计文档交叉核对
- 方法：核心文件精读 + workflow / runtime / service 三路全量扫描；所有结论附 file:line

---

## TL;DR

1. **PaperTeam 实际是「确定性 Pipeline + 有界 Agentic Step」架构，不是 multi-agent 自治系统**——这是 D-0008/D-0009/D-0014 的明确设计意图，且经 M4–M6 验证有效。四角色（Researcher/Writer/Reviewer/Citation）+ Skill 细化的结构**不需要推翻，也不需要增加 Agent**。
2. 91 个 src 文件中只有 **7 个类发起 LLM 调用**（全部经 `AgentRuntime.runAgent`），其余 85 个是确定性计算/IO/类型。LLM 渗透面极小、可控——这是本架构最大的优点。
3. 业务层的「Agent 服务」实质是**角色执行器**（prompt 组装 → 单次 runAgent → 结构化校验 → 落盘），不拥有跨任务的规划循环与长期状态；真正的 reasoning loop 在 Pi session 内部（单任务生命周期的 tool-use 循环）。按严格定义它们是 **Tool Wrapper 形态的 LLM 能力门面**，但这不是缺陷——结构化契约 + 确定性编排正是质量闭环成立的原因。
4. 主要债务三处：**① `definitions.ts`（3135 行）内联了大量领域规则**（digest 拼装、Evidence 选择、修订目标定位、轮次预算）；**② 一个 Agent 的能力面定义分散在三处**（roleConfig 白名单 / routing skill 路由 / index.ts 工具装配）；**③ 角色执行器物理散布在 4 个目录**（agents/、writer/、paper/、citation/）。均为可渐进偿还的组织性债务，无正确性风险。
5. **M6.5 Evidence Grounding 推荐方案 C（Hybrid）**：Evidence 工具面（evidence_query / get_chunk / propose_evidence）+ 确定性核验管道（新 EvidenceGroundingService）+ 复用 **Citation 角色**做语义 judge。不新增 Evidence Agent（D-0009 准则不满足）。

---

## 1. 当前 Agent Role 清单

### 1.1 Runtime 角色（pi/roleConfig.ts）

Pi 无 agent 注册表，"角色"落在 Adapter 内的最小配置映射（D-0018）：同一 Runtime、同一默认模型（可 per-Agent override），靠 `systemPrompt` 最小框架 + 工具白名单 + `contextScope` 会话隔离区分；任务级指令由业务层 prompt 内联（roleConfig.ts:5-17）。

| 角色 | scope 前缀 | systemPrompt 要点 | 内置工具 | 位置 |
|---|---|---|---|---|
| researcher | `research*` | 只读项目材料做调研，不改正文 | read/grep/find/ls | roleConfig.ts:37-45 |
| writer | `writing*` | 读取材料并产出/修改 LaTeX | read/**write/edit**/grep/find/ls（唯一可写角色） | roleConfig.ts:47-54 |
| reviewer | `review*` | 只读稿件与证据，输出结构化审稿结论 | read/grep/find/ls | roleConfig.ts:56-63 |
| citation | `citation*` | 只依据任务提供的真实检索证据判断，禁止凭记忆判定 | read/grep/find/ls | roleConfig.ts:65-72 |
| default | 其余/无 scope | 通用 | read/grep/find/ls | roleConfig.ts:74-77 |

shell 类工具不授予任何角色；LaTeX 编译由 LatexCompiler 执行、不经 Agent（roleConfig.ts:14-17）。

### 1.2 业务角色执行器（全部 runAgent 调用方，7 个类）

| # | 类 | 文件 | 方法（角色/scope） | 输入 | 输出（落盘） | reasoning loop | 独立 state |
|---|---|---|---|---|---|---|---|
| 1 | `ResearcherService` | agents/ResearcherService.ts | `research()`（researcher / `research`）；`analyzeExistingPaper()`（`research/existing-analysis`） | 项目元数据 + 文献库 digest（:160-170） | `research/research.json` + EvidenceStore 追加（unverified，:140-145） | 单次 runAgent（:91、:182）；循环在 Pi session 内（可自主调 search_papers/retrieve_library） | 无（盘上 artifact） |
| 2 | `FeasibilityService` | agents/FeasibilityService.ts | `assess()`（researcher skill=feasibility / `research/feasibility`） | research report + evidence stats | `research/feasibility.json` | 单次（:83） | 无 |
| 3 | `ReviewerService` | agents/ReviewerService.ts | `reviewAll/reviewMode`（reviewer / `review/{fact,academic,style}`，Promise.all 三路并行） | manuscript digest + evidence（内联截断 slice(0,20)，:383）+ citation digest | `reviews/review-r{n}-{mode}.json`（:176-186） | 单次 ×3 并行（:154） | 无 |
| 4 | `WriterService` | writer/WriterService.ts | `write` / `planOutline` / `writeSection` / `reviseSection` / `polishSectionStyle` / `repairSection` / `planImprovement`（writer / `writing/*`） | outline / evidence / bibliography / issues / 诊断 | `manuscript/sections/*.tex`（由调用方写盘） | 单次 ×7 个方法（:79/:129/:172/:231/:298/:342/:384） | 无 |
| 5 | `SectionReviewService` | paper/SectionReviewService.ts | `reviewSection()`（reviewer / `review/section/<id>`） | ReviewContextBuilder 受控上下文 | ReviewFinding（无自身落盘） | 单次/节（:172） | 无 |
| 6 | `PaperMapService` | paper/PaperMapService.ts | `summarizeSection()`（reviewer / `review/summary/<id>`） | parsed section 文本 | `paper/paper-map.json` | 单次/节（:217） | 无 |
| 7 | `CitationIntegrityService` | citation/CitationIntegrityService.ts | claim 拆解（`citation/decompose/*`）+ 语义 judge（`citation/semantic/*`） | callouts + bib + 真实证据 | `paper/citation/**`（经 PaperStore） | 单次 ×N 批（:753、:914） | 无（缓存经 PaperStore） |

非 workflow 的 LLM 消费方（2 处，均 default 角色）：

- `AgentMultimodalAnalyzer`（sources/PdfAnalyzer.ts:155、:188）：scope `sources/pdf-analysis`。注意：httpServer 传入 `agentIds.researcher`（httpServer.ts:1007-1010）但该 scope 解析为 **default** 角色（roleConfig.ts:81-98），不会注入 scholarly/retrieve 工具——agentId 与角色语义错位（见附录 A3）。
- `SkillSummaryService`（skills/SkillSummaryService.ts:67）：scope `skills/summary/<id>`，启动期后台任务。
- 另有 `ModelSettingsService` Test Connection 经 Pi `ModelRuntime.completeSimple` 直连（settings/ModelSettingsService.ts:592）——诊断用途，非业务 Agent 链路。

### 1.3 判定：真 Agent / Tool Wrapper / Service

按「Agent = 有目标、有规划、有判断、有上下文」严格判定：

- **没有任何业务类是自主 Agent**。全部 7 个类是同一模式的实例：*prompt 组装 → 单次 `runAgent` → 确定性结构化校验 → 落盘*。类自身不决定"接下来做什么"（那是 WorkflowOrchestrator + `definitions.ts` plan/onInput 确定性规划器的职责，D-0008），不持有跨任务状态（事实源在文件系统，D-0013），输出不过校验不算成功。
- **真正的 Agent 行为只存在于 Pi session 内部**：一次 runAgent 内的 tool-use 循环（PiRuntimeAdapter.ts:1993 `session.prompt()` 一次调用 = 整个 run；模型自主决定调 `search_papers`/`retrieve_library`/`read` 的次数与顺序，多轮迭代在 SDK 内完成）。生命周期被刻意限定在**单任务**内。
- 因此业务层这 7 个类的准确定性是：**角色执行器（Role Executor）——Tool Wrapper 形态的 LLM 能力门面**。对上层（workflow stage）表现为确定性 service 接口；对下层是 agent 任务的提交器与结果校验器。

这不是缺陷。该模式的收益已被项目证实：输出契约漂移（A7 verdict 别名、A10 summary 省略）都能在校验层兜住而不污染状态机；审稿-修订闭环的收敛判定全部确定性可测。**审计结论：形态正确，维持。**

### 1.4 四角色划分的符合度

| D-0009 拆分准则 | 当前满足情况 |
|---|---|
| 需要不同模型才拆 | ✅ per-Agent 模型 override 已有（M5.7），四角色各自可配 |
| 独立长期上下文 | ✅ contextScope 会话隔离（D-0016）；session 可丢弃重建 |
| 不同权限 | ✅ writer 独占 write/edit；researcher/citation 独占 scholarly 工具 |
| 真正独立并行资源 | ✅ reviewer 三 lens 并行、分章节并行（C=3） |

Feasibility 是 researcher 的 skill（`role=researcher, skill=feasibility`）而非第五角色——符合"角色细化优先用 Skill"的准则。**无需调整。**

---

## 2. 当前 Tool 系统

### 2.1 registry：不存在集中注册表，能力面由三处拼装

| 位置 | 控制什么 | 形态 |
|---|---|---|
| runtime/pi/roleConfig.ts:36-78 | 内置工具白名单（per-role） | 代码常量 |
| skills/routing.ts:29-110 | Skill（提示层知识）按 role+scopePrefix 路由 | 代码常量表 |
| index.ts:152-173 | customTools 装配（`roleCustomTools` 回调：researcher+citation → scholarlyTools；researcher/writer/reviewer → retrieve_library（projectId 闭包）） | 组合根内联回调 |

三处共同决定一个会话的最终能力面（PiRuntimeAdapter.ts:2356-2357、:2370-2387 合并注入）。功能正确，但**"一个角色能做什么"没有单一事实源**——新增工具要改三处认知。

### 2.2 execution：Pi SDK 内闭环

`defineTool` 的 `execute(toolCallId, params, signal)` 由 SDK 在 session 内调用（协作式 AbortSignal，cancel 可传导）；结果回灌 transcript 供下一轮模型调用；Adapter 只观测（tool_execution_* 事件）不做业务解析。工具实现是**薄壳**：重试/熔断/限速全在服务层（D-0033），工具不写任何状态、失败返回结构化 payload 而非抛错。

### 2.3 custom tools（4 个）+ skills（5 个 seed）

| 工具 | 定义 | 授予角色 | 底层服务 |
|---|---|---|---|
| `search_papers` | skills/scholarlyTools.ts:33 | researcher、citation | ResearchDiscoveryService（多源聚合+融合） |
| `search_web` | scholarlyTools.ts:101 | researcher、citation | WebSearchService（SearXNG，optional） |
| `lookup_paper` | scholarlyTools.ts:150 | researcher、citation | ScholarlyResolver（核验语义 ≠ 检索） |
| `retrieve_library` | retrieval/tools.ts:36 | researcher、writer、reviewer | RetrievalService（hybrid 检索 + Context Packing） |

Skills = 提示层学术知识（academic-review / academic-style-zh / academic-writing-zh / paper-search / verify-citations），SkillRegistry 管理受控安装/不可变版本快照/防篡改自愈/SHA pin（D-0025/D-0030），progressive disclosure 注入。**Skill 不是可执行能力**，与 Tool 是两个正交维度——当前没有混淆。

### 2.4 六大能力域逐一检查

| 能力域 | 现状 | 应属 Tool？ | 评估 |
|---|---|---|---|
| **Search** | ✅ 已是工具（search_papers/search_web），服务层持有全部治理 | 是 | 正确。红线齐备：candidate ≠ verified、零持久化默认、not_configured 如实返回 |
| **Retrieval** | ✅ 已是工具（retrieve_library），projectId 闭包隔离 | 是 | 正确。Retrieved ≠ Verified 红线明确（tools.ts:4-10） |
| **Citation** | 混合且**分层正确**：lookup_paper 工具（核验）；静态检查/引用保持是 Gate（服务）；语义 judge 是 LLM 任务（CitationIntegrityService） | 部分是 | 正确。静态检查不应 tool 化（Gate 消费者不是 Agent）；judge 不应 tool 化（需要结构化裁决契约） |
| **Latex** | 编译=LatexCompiler 服务（无 shell 红线）；修复=Writer 收诊断 prompt 后重写；组装=ManuscriptService 确定性 | **否** | 正确且是亮点。Agent 永远不直接碰编译器 |
| **Evidence** | ❌ **无工具面**。Agent 只能被动接收 prompt 内联 digest（ReviewerService.ts:383 slice(0,20)/140 字符；WriterService.ts:886-893）；写入仅 Researcher JSON 输出 → unverified 追加 | **应是（读侧 + 候选侧）** | **M6.5 主要接口缺口**（见 §6） |
| **Reference management** | references.bib 由 ManuscriptService 确定性生成（:153）；Agent 侧靠 prompt key 白名单 + citationPreservation Gate 约束 | 否 | 正确。bib 治理是状态管理，不是 Agent 能力 |

### 2.5 缺口汇总

1. Evidence 读/写候选无工具面（§6 展开）。
2. `get_chunk(chunkId)` 类精确取原文工具缺失——M6.4 的引用标记（`[SRC:… CHUNK:…]`）已经是回溯锚点（ARCHITECTURE.md §15.2），但 Agent 无法按 chunkId 精确回取原文做 quote 校验。
3. 工具装配分散三处（§2.1）。

---

## 3. 当前 Service 层

### 3.1 事实分层（91 文件实测）

```
HTTP API / SSE（httpServer.ts，2850 行）
        │
WorkflowOrchestrator（983 行，纯引擎，只 import ProjectStore 类型）
  + definitions.ts（3135 行，3 个 workflow × plan/onInput 确定性规划器）
        │
┌─ 角色执行器（7 类，LLM 门面）──────── agents/ 3 + writer/ 1 + paper/ 2 + citation/ 1
├─ 领域服务（确定性）────────────────── search 11、retrieval 10、quality 3、latex 2、
│                                        import 3、generation 1（legacy，仅 httpServer.ts:500
│                                        deprecated 端点消费）、version 1
├─ Store（状态唯一写者）──────────────── project 2、sources 4、evidence 1、manuscript 3、
│                                        paper 2、review 2、artifacts 1、settings 2
└─ Runtime 基础设施 ──────────────────── runtime/（PiRuntimeAdapter 3125 + scripted 828）
```

所有业务状态单点落在 `ProjectStore` 管辖的 `{projectsRoot}/{projectId}/` 文件树；唯一例外是 settings 三件套（用户级 `<runtimeRoot>/settings/`）。Derived State（chunks/索引/向量旁车/context.yaml）可删可重建——纪律执行良好。

### 3.2 哪些逻辑应下沉到 Service（现挂在 definitions.ts 内联）

definitions.ts 是全仓库最大的架构债务点。它没有内联 LLM prompt（全部委托角色执行器，正确），但内联了大量**领域规则**（纯函数、可测试、目前无正确性风险，但规划器不应拥有领域知识）：

| 内联逻辑 | 位置 | 应归属 |
|---|---|---|
| `buildManuscriptDigest`（审稿 digest 拼装/截断规则） | definitions.ts:2741-2765 | manuscript 域（与 ReviewContextBuilder 合流——后者已是分节审阅的同职责实现，paper/ReviewContextBuilder.ts） |
| `usableEvidence`（Evidence 选择策略：trusted<3 补 unverified、按 supportStrength 排序、限量 20） | definitions.ts:2711-2725 | EvidenceStore.query 扩展或新 EvidenceSelectionService——**选择策略是业务规则，M6.5 必然还要改这里** |
| `sectionMatches` / `listRevisionTargets`（issue→修订目标 8 条模糊匹配 + 目标集合推导） | definitions.ts:3015-3098 | manuscript 域 |
| `readImportReport` / `collectRevisionDirectives` 内联 JSON.parse | definitions.ts:2691-2708、:2885-2891 | 对应域服务读方法 |
| 修订预算/轮次统计（`revisionRoundsUsed`/`countCompletions`/`lastCompletionIndex`） | definitions.ts:1316-1323、:3121-3135 | ReviewArtifactStore / iteration 域 |
| hitl.plan_confirm payload 内联解析 improvement-plan.json | definitions.ts:2107-2113 | 同上 |
| 直接文件 I/O（写 sections/*.tex、读 main.tex 做 DoD） | definitions.ts:755-759、:537、:1020-1024、:1763-1771 | ManuscriptService |

**规划器应只保留**：stage 编排顺序、新鲜度规则（gate 须新于 review 等）、HITL 决策应用、bounded loop 预算判定。

### 3.3 其他应下沉/上移项

- **roleConfig 上移**：业务角色的 systemPrompt、输出纪律、工具策略位于 `runtime/pi/` 下——runtime 层持有业务知识。应移至 agents/（或 roles/）作为 adapter 的构造输入。
- **工具装配下沉**：index.ts:152-173 的 `roleCustomTools` 回调应进 serviceStack 或独立 tools/ 模块（index.ts 只剩启动顺序）。
- **statusService 角色单源化**：agentIds/role 清单硬编码于 runtime/statusService.ts:107、:225-232，与 roleConfig 无单一事实源。

---

## 4. Agent 边界评估（逐模块分类）

原则：**Agent** = 有目标、有规划、有判断、有上下文；**Tool** = 提供能力、确定性执行、无长期决策；**Service** = 业务逻辑、状态管理。

| 模块 | 分类 | 判定依据与评价 |
|---|---|---|
| WorkflowOrchestrator | **基础设施（非三者）** | 确定性引擎，不认识任何业务 stage（只 import ProjectStore 类型）。正确，红线守住（D-0008） |
| definitions.ts plan/onInput | **Service 性质的流程策略**（留在 workflow 层合理） | 领域规则内联过多是唯一问题（§3.2） |
| PiRuntimeAdapter + scriptedRuntime | **基础设施** | 隔离层职责干净（不做 output 解析、不业务重试）；少量业务渗漏（附录 R1-R7） |
| roleConfig | **业务配置，错位在 runtime 层** | 附录 R1 |
| ResearcherService / WriterService / ReviewerService / FeasibilityService | **角色执行器**（名义 Agent、实质 LLM 能力门面） | §1.3。形态正确 |
| SectionReviewService / PaperMapService / CitationIntegrityService | **角色执行器**（同上，但物理位置在域目录） | 模式与 agents/ 完全一致；目录语义 ≠ 角色语义（附录 A1） |
| scholarlyTools / retrieve_library | **Tool** ✅ | 薄壳、无状态、失败结构化返回 |
| search/（11 文件） | **Service（确定性）** ✅ | 治理全在服务层；零 LLM |
| retrieval/（10 文件） | **Service（确定性）** ✅ | Index=Derived State 纪律钉死 |
| CitationService / StaticCitationChecker / scholarly / softwareResolver | **Service（确定性）** ✅ | metadata truth ≠ semantic support 分层正确（D-0023） |
| LatexCompiler / diagnostics | **Service（确定性 subprocess）** ✅ | |
| quality/（gates + 双 preservation） | **Service（确定性规则）** ✅ | "Prompt 不是 Gate"红线守住 |
| ManuscriptService / RevisionStore / ArtifactStore / FinalizeService | **Service（状态 + 确定性决策）** ✅ | main.tex 组装/references.bib 生成零 LLM |
| EvidenceStore / SourceStore / CandidateStore / PaperStore / ProjectStore / ReviewArtifactStore / ExternalInstructionStore | **Service（状态唯一写者）** ✅ | |
| GenerationService | **legacy 编排** | 仅 deprecated M2 端点消费（httpServer.ts:500）；建议标记 legacy 而非扩展 |
| ResearchDiscoveryService / SourceImportService | **Service（业务编排）** ✅ | 候选→转正状态机、幂等 promotion |

**违规检出汇总**（按用户三原则）：

- ❌ "该是 Tool 却做成 Agent"：**无**
- ❌ "该是 Agent 却做成 Tool"：**无**
- ⚠️ "Service 里藏 LLM 编排"：CitationIntegrityService / PaperMapService / SectionReviewService 三处——**模式与 agents/ 一致，可接受**，问题是物理位置造成"Agent 层"认知割裂（附录 A1）
- ⚠️ "编排层内联领域规则"：definitions.ts（§3.2）——**主要债务**
- ⚠️ "runtime 层内嵌业务知识"：roleConfig / 错误文案 / sessionKey 反向解析（附录 R1-R4）——**次要债务**

---

## 5. 推荐最终架构

**约束：不增加 Agent 数量。** 当前四角色在 D-0009 四准则上各自满足拆分依据、且无职责重叠，维持。

### 5.1 Core Agents（4 个，不变）

```
Researcher（research*）—— 调研 / 论文理解 / 文献发现 / evidence 候选提案
  skill: paper-search、feasibility（继续作为 skill 而非角色）
Writer（writing*）—— 唯一可写角色：大纲 / 分节写作 / 修订 / style 润色 / LaTeX 修复 / 改进计划
Reviewer（review*）—— fact / academic / style / section 四 lens（并行 fan-out）
Citation（citation*）—— 引用真实性 + 语义核验；M6.5 起 + evidence 语义 judge（复用，见 §6）
```

### 5.2 Tools（收敛为显式工具面 + M6.5 增补）

```
保留：search_papers | search_web | lookup_paper | retrieve_library
M6.5 新增：
  evidence_query     —— 只读查 EvidenceStore（status/sourceId/section/claimContains 过滤）
  get_chunk          —— 按 chunkId 精确取原文（quote 逐字校验锚点；M6.4 引用标记的直接消费）
  propose_evidence   —— 提交 evidence 候选（claim+quote+chunk 引用）到核验队列；不直写 evidence.jsonl
不做：compile_latex（维持无 shell 红线）| write_evidence（状态机由核验管道独占）
```

组织方式：新建 `backend/src/tools/` 作为唯一工具目录（scholarlyTools.ts、retrieval/tools.ts 迁入 + 新工具），配一张 role→tools 声明表——把 roleConfig 白名单 / routing / index.ts 装配收敛为"role 声明 + 工具定义"两处。**工具纪律不变**：薄壳、无状态、服务层治理、失败结构化返回。

### 5.3 Services（四类显式化）

```
① Store（状态唯一写者）       —— 现有 12 个 Store，不变
② 领域服务（确定性）          —— 现有；吸收 definitions.ts 下沉的 digest/选择/定位/预算逻辑
③ 角色执行器（LLM 门面）      —— 7 个类；统一约定并物理收拢到 agents/（writer/WriterService、
                               paper 两件、citation 的 judge 部分迁入；或在 ARCHITECTURE.md
                               §9 标注角色→文件的映射表作为最低成本方案）
④ 编排                       —— WorkflowOrchestrator + definitions（只留流程规则）
新增（M6.5）：EvidenceGroundingService（§6）
```

### 5.4 迁移优先级

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0（随 M6.5） | evidence 工具面 + EvidenceGroundingService；`usableEvidence` 下沉并改造 | M6.5 直接依赖；趁势偿还 |
| P1 | roleConfig 上移出 runtime/；工具装配收敛 tools/ | 降低认知成本；M6.5 新工具自然落位 |
| P2 | definitions.ts 其余领域函数下沉；statusService 角色单源化；GenerationService 标 legacy | 纯组织性，可搭车日常迭代 |

---

## 6. 对 M6.5 Evidence Grounding 的影响

### 6.1 三选项分析（基于当前代码）

**A. Evidence Tool（纯工具）**：核验全部确定性化或留给现有 Reviewer fact lens。
- 不成立的理由：Evidence 的核心价值是 `verificationStatus`（六态）+ `supportStrength` 四档的状态机（EvidenceStore.ts:24-34），这是**业务逻辑 + 状态管理**，不是无状态能力；quote 逐字校验、metadata 复核、语义裁决是三段不同性质的步骤，塞进单个 tool 违反"Tool = 确定性执行、无长期决策"。M6.1 ADR §11 也已把 M6.5 定义为"核验管道 + workflow 接线"而非工具。

**B. Evidence Agent（新角色）**：专职 evidence 收集/核验/维护的第五角色。
- 不成立的理由（D-0009 四准则逐一检验）：① 不需要不同模型（judge 与 citation 语义核验同构）；② 不需要独立长期上下文（每条 evidence 的核验是短生命周期任务，与 D-0024 分章节审阅的"短命 section task"同型）；③ 不需要新权限（核验要读 chunk + 调 lookup，citation 角色已具备全部工具面）；④ 不需要独立并行资源（可在现有并发框架内跑）。而成本确定：第 5 个角色的会话面、模型路由、skill 路由、roleConfig、statusService、前端展示全部要扩。**"找证据"的 agentic 部分已经存在**——Researcher 在 session 内自主迭代 search_papers/retrieve_library 就是证据发现行为；缺的只是"候选 → 核验 → 转正"的后半段管道。

**C. Hybrid（推荐）**：工具面（能力）+ 确定性核验管道（Service）+ 复用 Citation 角色（判断）。

### 6.2 推荐形态（C）与代码锚点

```
Researcher（session 内 agentic 迭代：search_papers / retrieve_library / get_chunk）
   │ propose_evidence 工具 或 research JSON 的 evidence 字段（现状，ResearcherService.ts:140-145）
   ▼
Evidence 候选队列（新：evidence/candidates 或复用 Candidate 模式；**不直写 evidence.jsonl**）
   ▼
EvidenceGroundingService（新 Service，核验管道——对齐 CitationIntegrityService 流水线形态）：
   阶段 1  quote 逐字校验（确定性）——get_chunk 取 chunk 原文 → 归一化匹配
           【复用：semanticVerifier.buildGroupEvidence 的证据构建经验 +
             factPreservation 的数值守卫 + pymupdf 块边界断词的 U+00AD 教训】
   阶段 2  metadata 通道（确定性）——ScholarlyResolver（与 sourceImport/citationIntegrity
           共享同一实例的既有模式，serviceStack.ts:279-289）
   阶段 3  语义 judge（LLM，单任务）——复用 **Citation 角色**，新 scope `citation/evidence/<id>`；
           prompt 只喂 chunk 原文 + claim（不见摘要——v4/v5 的教训）
           【citation 角色现有 systemPrompt 与此语义完全一致：
             "只依据任务中提供的真实检索证据判断……禁止凭记忆判定"，roleConfig.ts:66-69】
   ▼
EvidenceStore 状态机写回（verified/partial/mismatch/not_found…；
  updateVerification 是唯一合法转换口，EvidenceStore.ts:236-283）
   ▼
消费方：Reviewer fact lens（claims 核验改为引用 grounding 链而非裸判）、
  Quality Gate（口径已有：status+supportStrength，confidence 不进硬判定）、Feasibility stats
```

workflow 接线（M6.1 ADR §11 既定入口）：`research.idea` 扩展或新增 `evidence.ground` stage，位于 research 与 feasibility 之间/之后；HITL 语义沿用候选确认模式（M6.2 的 accept/reject 先例）。

### 6.3 该设计对现有红线的延续

- D-0033 "Search ≠ RAG ≠ Evidence / 检索层零 EvidenceStore 写路径" → 核验管道是**唯一**写路径，工具仍然零写。
- D-0023 "metadata truth ≠ semantic support / NOT_FOUND ≠ 检索失败" → 阶段 2 与阶段 3 的分离完全对齐。
- D-0013 "Runtime session 不承担项目真相" → judge 输出落盘后才算数，session 可弃。

### 6.4 风险与守卫

| 风险 | 守卫 |
|---|---|
| judge 拿到被蒸馏/摘要污染的"证据" | 只喂 chunk 原文（get_chunk 锚点）；semanticVerifier v4/v5 既有纪律 |
| Agent 虚构 quote | 阶段 1 逐字校验失败 → 直接 unverified/mismatch，不进 judge |
| 候选洪泛 | propose_evidence 限额 + 候选队列确认语义（复用 M6.2 模式） |
| Quality Gate 口径漂移 | confidence 仍不进硬判定（EvidenceStore 头注释红线） |
| EvidenceStore 批量写性能 | append 为 O(n) loadAll（EvidenceStore.ts:141-189），批量核验需加 batch 接口 |

---

## 7. 附录：边界问题清单（file:line，按严重度排序）

**架构组织类**

- A1 角色执行器物理散布：agents/（3）+ writer/（1）+ paper/（2）+ citation/（1），"Agent 层"无一致物理位置；模式相同但目录语义割裂。
- W1 definitions.ts（3135 行）内联领域规则：buildManuscriptDigest :2741-2765、usableEvidence :2711-2725、sectionMatches/listRevisionTargets :3015-3098、readImportReport :2691-2708、修订预算 :1316-1323/:3121-3135、内联文件 I/O :755-759/:537/:1020-1024/:1763-1771。
- W2 Agent 能力面三处分散：roleConfig.ts:36-78（内置白名单）+ routing.ts:29-110（skill 路由）+ index.ts:152-173（customTools 装配）。
- A2 Evidence 上下文供给靠 prompt 内联截断（ReviewerService.ts:383 slice(0,20)；WriterService.ts:886-893），与 M6.4 拉取式检索（retrieve_library）并存——推 vs 拉两套机制未统一，M6.5 应顺势收敛。
- A3 agentId 与角色错位：AgentMultimodalAnalyzer 传 agentIds.researcher（httpServer.ts:1007-1010）但 scope `sources/pdf-analysis` 解析为 default 角色（roleConfig.ts:81-98）——该会话拿不到 scholarly/retrieve 工具；意图存疑（若想用 researcher 工具面，scope 应落在 research/ 下）。

**runtime 层业务渗漏类**（低严重度，隔离良好）

- R1 业务角色 prompt/工具策略在 runtime 层：roleConfig.ts:31-78（中文 systemPrompt、输出纪律、白名单都是业务知识）。
- R2 sessionKey 业务结构被 adapter 反向解析：PiRuntimeAdapter.ts:2768-2771（`paperteam-{projectId}` 前缀匹配）。
- R3 runtime 错误信息内嵌产品文案与运维指引：PiRuntimeAdapter.ts:1177、:1744、:1208、:2227。
- R4 statusService 硬编码角色清单：runtime/statusService.ts:107、:225-232，与 roleConfig 无单源。
- R5 scriptedRuntime 镜像业务 prompt 格式契约（"===== 本章节当前内容 =====" :153、`%%%PT-OUTCOMES%%%` :225 等）——prompt 格式变更需同步两处，无共享常量。
- R6 容量/预算常量是业务调参但已纯函数隔离：contextBudget.ts:28、:145-149；adapter :194-214。记录即可。
- R7 workspace 防越界规则双实现：PiRuntimeAdapter.ts:2392-2401 与 ProjectStore 同规则未共享。

**性能类**

- E1 EvidenceStore.append 每次 loadAll 全量读（EvidenceStore.ts:141-189），批量追加 O(n²) 读盘——M6.5 批量核验前需补 batch 接口。

---

## 结语

本次审计的总体判断：**PaperTeam 的 Agent/Tool/Service 边界在语义上是清晰的，且被 ARCHITECTURE.md 的红线体系（Authoritative State / Retrieved≠Verified / Gate 确定性 / 无 shell）持续强制执行**。存在的债务全部是组织性的（文件放哪、规则放哪、能力面在哪声明），没有一处需要推翻性重构。M6.5 是一次低风险的增量：复用 Citation 角色做 judge、复用 ScholarlyResolver 做 metadata、复用 chunk 引用标记做 quote 锚点、复用候选-转正模式做状态机——每一段都有已验证的代码先例。
