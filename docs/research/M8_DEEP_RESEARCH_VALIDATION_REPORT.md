# M8 Deep Research Capability Validation Report

- 日期：2026-09-20
- 验收对象：PaperTeam M7 + M8.1 / M8.2 / M8.3.1 / M8.3.2 / M8.3.3 已实现的 Deep Research 能力
- 运行版本：`main @ e93cc31`（feat: add M8.3.3 controlled research loop foundation）
- 运行环境：Windows 11 / Node backend（`node dist/index.js`，端口 3000）/ Pi in-process Runtime / 真实模型 `zai-coding-cn/glm-5.3` / 真实学术检索（OpenAlex + Semantic Scholar + arXiv）
- 验收纪律：**零源码修改、零提交**；全部研究产出经由 PaperTeam Research Pipeline 产生；本报告研究内容部分只转写流水线产物（research.json / coverage / gaps / executionHistory），不以 Claude 自有知识补齐
- 验收项目：`p-dced898cd766`（保留在 `backend/projects/` 作为磁盘证据）

---

## 1. Research Task

- **Goal**（原文经 API 写入项目）：
  > "Analyze current Deep Research Agent and Scientific Agent architectures, identify technology trends and innovation opportunities for PaperTeam."
- **需要回答的六个问题**：
  1. 当前 Deep Research Agent 的主要架构范式是什么？
  2. OpenAI Deep Research、Claude Research、Gemini Deep Research 等系统的核心思想是什么？
  3. 当前 Scientific Agent / AI Scientist 方向有哪些代表论文？
  4. Evidence grounding、Research Planning、Research Memory、Research Gap Discovery 当前发展如何？
  5. PaperTeam 当前架构相比已有方案有哪些差异？
  6. PaperTeam 后续 M9/M10 最值得发展的方向是什么？
- **执行路径**：Research Project 创建 → Researcher 生成 ResearchPlan → approve → execute（真实学术检索）→ Coverage Analysis → ResearchGap HITL（accept / reject / derive）→ 二轮计划执行 → 二轮 Coverage → 本报告。

---

## 2. Pipeline Execution Trace

### 2.1 执行总览（全部经 HTTP API 驱动，无一步绕过 PaperTeam）

| Step | 动作 | API | 结果 |
| --- | --- | --- | --- |
| 1 | 创建项目 | `POST /api/projects` | `p-dced898cd766`（15:33:29Z） |
| 2 | 运行 Research（生成计划） | `POST /api/projects/:id/workflows {kind: idea_to_paper}` | run `w-20a56ee82238`；`research.idea` 429.9s（16 turns，$0.50）→ `evidence.ground`（pending=0 no-op）→ `research.feasibility`（level=LOW，106.7s，$0.049）→ HITL 停靠后 cancel（干净终态） |
| 3 | 计划批准 / 执行 | `POST /research/plan/approve` → `POST /research/plan/execute` | `exec-780cc7e4f9fd`：15 queries，14 executed（各 resultCount=10），1 failed（web 检索未配置）；plan → done |
| 3b | 候选 / 文献链路 | `POST /research/academic-search {saveAsCandidates:[0,1,2]}` → `POST /sources/candidates/:cid/promote` | 保存 C003/C004（1 条 identity 去重合并）；promote C001→S001、C003→S002（metadata_only，DOI 身份） |
| 4 | 覆盖分析 | `POST /research/coverage/analyze` | 一轮：10 问 covered 10 / partial 0 / missing 0，gaps 7 |
| 5 | Gap HITL | `POST /research/gaps/:id/{accept,reject,derive}` | accept ×2（gap-48819e67b36f 商业产品方向、gap-3c51ed9becab RL 浏览 agent 方向）、reject ×1（gap-eb359e854111 CNKI 残差）；derive（含 HITL 改写 queries）→ `rp-e63e8dbce531` iter2 |
| 5b | 二轮执行 | approve → execute | `exec-19551a84bf8f`：3/3 executed（BrowseComp / RL search agent / Kimi-Researcher，共 30 结果）；再 analyze：6 问 covered 5 / missing 1 |
| 6 | Loop Policy 面 | `GET/PUT /research/loop-policy` | 默认值正确；PUT 落盘成功；非法值 400；done 计划重复 execute → 409 |

模型总成本：验证项目约 **$0.55**（researcher $0.50 + feasibility $0.049）。

### 2.2 ResearchPlan（Step 2 产物，Researcher 真实生成）

- 首轮计划 `rp-a14a30f8cc71`（iterationId `it-7635fa3fd591`，iterationNumber 1，draft → approved → done）。
- **research questions（5，原文）**：
  1. Deep Research Agent 的主流架构、流水线与代表性系统是什么？
  2. Scientific Agent 有哪些代表性系统，覆盖科研生命周期哪些环节，采用何种架构（多智能体/知识图谱/工具增强）？
  3. 2023–2026 年该领域的关键技术趋势（agentic RAG、测试时计算、自动评审、评测基准）如何演进？
  4. 现有系统在可信性（引用忠实、证据核验）、评测、新颖性与成本上存在哪些空白？
  5. 对 PaperTeam（面向学术论文写作的 agent 平台）有哪些可落地的创新机会？
- **search queries（15 = 14 academic + 1 web，含 rationale / expectedCoverage）**：deep research agent LLM architecture、LLM agent survey、AI scientist autonomous research agent、literature review automation、autonomous research agents survey、Agent Laboratory、agentic RAG survey、ResearchAgent idea generation、hypothesis generation + knowledge graph、benchmark/hallucination/citation faithfulness、STORM outline-driven、automated peer review、search/browsing agent survey、OpenScholar、（web）OpenAI/Gemini Deep Research 对比。
- 同轮 ResearchReport（research.json）：8 条 relatedWorkDirections、7 条 researchGaps、6 条 potentialContributions、12 条 evidence 候选（全部 legacy unverified，见 §4-3）、21 条 bibliography。
- **判定：Researcher 具备完整生成 research questions / search queries / 策略（rationale+expectedCoverage）的能力，且问题域与验收目标精确对齐。**

### 2.3 Execution History（Step 3 产物）

- `exec-780cc7e4f9fd`（plan rp-a14a30f8cc71，54.3s）：15 条 executionHistory 落盘（executed×14 + failed×1，均带 planId / queryId / resultCount / timestamp）。学术检索真实工作：OpenAlex / S2 / arXiv 全部 healthy（S2 出现一次 429，共享 client 冷却 58s 自动恢复，不累计熔断——与 M6.3 设计一致）。
- 失败条目如实记录：`q-15 (web) → failed：Web Search 未配置（需要独立 SearXNG 服务与 PAPERTEAM_SEARXNG_URL）`，该 query 保持 planned（修复后可重试）。
- `exec-19551a84bf8f`（plan rp-e63e8dbce531）：3/3 executed。
- **判定：Academic Search 正常；Web Search 在当前部署未配置（如实失败、不伪造）；执行只回填计数不自动入库（符合 M8.2「Search Result ≠ Candidate」边界）；Candidate/Literature 需用户显式驱动，链路（检索→保存候选→promote 文献）实测可用。**

### 2.4 Coverage Result（Step 4 产物）

一轮（active plan = rp-a14a30f8cc71）：

- 总体：**问题 10（plan 5 + report 5）：covered 10 / partial 0 / missing 0；gaps 7**。
- 逐问统计（relatedQueryCount / executedQueryCount / resultCount / evidenceCount / promotedCount）全部非零且量级合理（如 Q1：11/10/100/8/2）。
- 7 个缺口全部来自 report.literaturePlan 残差方向（severity=medium）：商业产品资料（web 不可用）、RL 浏览 agent 技术报告、2025 专项基准、自动同行评审专门文献、安全合规、中文/低资源生态、**基础设施残差（Researcher 自己报告了 save_candidates 并发损坏：规划 20 条候选仅 2 条落盘）**。
- 二轮（active plan = rp-e63e8dbce531）：问题 6（plan 1 + report 5）：covered 5 / missing 1（missing 为 report 侧「全流程评测基准」问题——与二轮计划 3 条检索无 token 关联，按当前规则正确判 missing）；gaps 8。
- **判定：Coverage Analyzer 能产出已覆盖/未覆盖方向与结构化缺口（gapId 稳定、severity 确定性、suggestedQueries 可执行）；残差方向与本次检索实况高度一致（web 不可用、医学伦理类噪声命中均被如实登记）。**

### 2.5 ResearchGap 与 HITL（Step 5 产物）

- 决策落盘（research.json `gaps` 字段只存 accepted/rejected 快照）：accept gap-48819e67b36f（商业 DR 产品方向=目标问题 2）、accept gap-3c51ed9becab（RL 浏览 agent，学术可执行）、reject gap-eb359e854111（CNKI 残差）。
- **derive 验证（全部通过）**：
  - 新计划 `rp-e63e8dbce531`：iterationNumber **2**（=链内最大+1）、parentPlanId **= rp-a14a30f8cc71**、iterationId 继承 `it-7635fa3fd591`、draft 且自动激活；
  - **原计划不变**：rp-a14a30f8cc71 保持 done、15 queries、updatedAt 未变（15:45:41.104Z）；
  - 用户改写优先：derive 请求体的 3 条英文 queries + 1 条 question 完整生效（缺口默认值被覆盖）；
  - 门槛语义：derive 只对 accepted 缺口开放（设计如此，本次未触发 409 路径；409/404 语义由 M8.3.3 测试套件覆盖）。
- 无自动循环：二轮的 approve / execute 均为本次验收的显式单次动作；loopPolicy 已 PUT 落盘（maxIterations=3）但无任何代码路径消费它（M8.3.3 设计：只存不执行）。

---

## 3. 最终研究报告（内容全部转写自流水线产物）

> 来源：`p-dced898cd766/research/research.json`（Researcher 报告 / 21 条 bibliography / 12 条 evidence）、两轮 coverage 报告、缺口清单。凡流水线未覆盖处明确标注「未覆盖」，不用外部知识补齐。

### 3.1 Deep Research Agent Landscape

（来自 report.domainOverview + relatedWorkDirections[1,2] + evidence E1）

- 主流流水线四阶段：**planning → question developing → web exploration → report generation**（Zhang 等 2025《Deep Research: A Survey of Autonomous Research Agents》综述；evidence 逐字锚定该来源）。
- 底层检索范式是 **Agentic RAG**：agentic 化的迭代「检索-重写」循环（Singh 2025 综述），区别于静态 RAG。
- 长报告合成代表：**STORM**（多视角提问驱动检索构建大纲的预写作阶段，NAACL 2024）；**OpenScholar**（基于 4500 万篇 OA 论文生成带引用回答 + ScholarQABench 基准，Nature 2026）。
- 证据级可信性（引用忠实、原文核验）与统一评测是新近关注点；**面向学术写作场景的专用 deep research 架构在调研覆盖内仍属空白**。

### 3.2 Scientific Agent Landscape

（来自 relatedWorkDirections[3,4,5] + bibliography + evidence E2–E6）

代表系统分层（流水线覆盖到）：

- **端到端科研自动化**：The AI Scientist v1（Nature 2026：自主选题→实验→写作→自评审；其稿件已通过顶级 ML 研讨会首轮评审）；AI Scientist-v2（agentic 树搜索，产出首篇完全 AI 生成并通过评审的研讨会论文）；Agent Laboratory（人类给 idea，文献综述—实验—报告三阶段 human-in-the-loop）；Co-Scientist（Gemini 多智能体「生成—批判—精炼」循环 + 测试时计算扩展，假设经体外实验验证，Nature 2026）。
- **研究构思/假设生成**：ResearchAgent（NAACL 2025，迭代 idea 生成）、Chain of Ideas（EMNLP 2025）、Nova（规划+搜索提升新颖性）、SciAgents（本体知识图谱 + 多智能体，Advanced Materials）。
- **领域专用与实验室自动化**：Coscientist / ChemCrow（化学）、Biomni / SpatialAgent（生物医学）、机器人 AI 化学家（ChemAgents，JACS 2025）。
- **全生命周期综述**：Zhou 2025（From Hypothesis to Publication）、Eger 2026（ACM CSUR：检索/构思实验/内容生成/多模态产物/评审五环节）、Zhang 2025（npj AI）。

### 3.3 Current Technology Trends

（来自 domainOverview + questions 3 关联检索 + 二轮补充检索）

- 多智能体角色分工（Co-Scientist 锦标赛进化循环为代表）；
- 工具与知识图谱增强（SciAgents / Coscientist）；
- **测试时计算扩展**（Co-Scientist evidence：「多智能体生成-批判-精炼循环 + 测试时计算扩展是当前顶级科研 agent 的代表性架构」）；
- agentic RAG 取代静态 RAG 成为 deep research 底座；
- 评测基准兴起：ScholarQABench、IdeaBench/LigBench、SciVer、Mohammadi 2025（KDD）agent 评测综述；2025 出现 deep research 专项基准（DeepResearch Bench / ResearchQA / xBench-DeepSearch——**本次学术索引未命中，登记为残差**）；
- RL 训练的搜索/浏览 agent（o3-deep-research、Kimi-Researcher、BrowseComp）——二轮计划已执行 3 条检索命中 30 结果，**原始资料消化未做**（无 research() 重跑），确认为残差。

### 3.4 Evidence Grounding / Research Planning / Research Memory / Research Gap Discovery 现状

（来自 researchGaps + coverage 缺口，这是流水线最直接回答问题 4 的部分）

- **Evidence grounding**：researchGaps[0]——「deep research agent 以产出报告为主，缺少逐字引用校验、原文 chunk 锚定与文献元数据核验的闭环，agentic RAG 的忠实性评测刚起步」。即：学界普遍**没有** PaperTeam 式三段核验管道。
- **Research planning**：调研覆盖内未见「计划先行、显式批准、可执行可回填」的检索计划一等产物形态（Zhang 2025 综述将 planning 描述为流水线第一阶段，但无 plan-as-artifact / approve-execute 状态机的对照系统）——注意：这是**覆盖内的空白结论**，非穷尽式断言。
- **Research memory**：researchGaps[4]——「跨任务研究记忆、个人化文献库持续积累与复用研究不足（ExpeL 类经验学习未进入 deep research 主线）」。
- **Research gap discovery**：覆盖内的系统以一次性报告输出为主，「覆盖分析→结构化缺口→人工确认→派生下一轮」的受控循环形态未见对照（商业产品闭源不可比，登记为残差）。

### 3.5 PaperTeam Position Analysis

（来自 researchGaps / potentialContributions / coverage，对照 PaperTeam 实际能力即本验收 trace）

流水线识别的领域空白与 PaperTeam 现有能力的对应：

| 领域空白（pipeline 产出） | PaperTeam 现状（本次验收实测） |
| --- | --- |
| 证据级可信性闭环缺失 | 三段核验管道存在；但本次 12 条 evidence 全部 legacy unverified（检索结果无全文 → 无 chunk 锚定 → 无法进入核验），**可信层在纯检索场景实际未激活** |
| 无 plan-as-artifact | ResearchPlan 状态机（draft→approved→executing→done）+ executionHistory 完整可用 |
| 记忆与经验累积薄弱 | 无跨 run 研究记忆（本次每轮计划只看到自身 queries 与 report） |
| 一次性输出、缺 HITL 迭代接口 | Gap HITL + derive + 二轮执行实测跑通（本报告 §2.5） |
| 学术文献库特化不足 | 文献库/promote/元数据在位；但候选→文献→全文→verified evidence 全链在真实调研中只推进到 metadata_only |

结论（pipeline 视角）：PaperTeam 的差异化在**「可控研究循环 + 证据纪律」的工程完整性**，弱项在**检索产物的消化深度（全文/证据转化）与研究记忆**。

### 3.6 Recommended M9/M10 Roadmap

（优先级 = pipeline 缺口的 severity/重复度 × 本验收暴露的工程缺陷）

**M9（研究链路深化——把「检索到的」变成「可用的」）**
1. **候选并发写入修复**（P0，见 §4-1）：save_candidates 并发损坏候选库，直接阻断文献积累。
2. **Web Search 落地**（P0）：SearXNG 部署 + 配置；商业 Deep Research 系统（OpenAI/Claude/Gemini/Perplexity）技术资料是当前唯一零覆盖的一级问题域（gap-48819e67b36f 已 accept）。
3. **计划执行结果→候选的半自动衔接**（P1）：执行只回填计数符合 M8.2 边界，但「执行后每 query top-N 一键入候选」的显式动作可消除手工重查（本次为验证候选链路不得不手工重跑同一 query）。
4. **全文解析→verified evidence 实战化**（P1）：promote 后自动 tryResolveFullText + chunk 化 + 让下一轮 evidence 走 anchored 提案；否则可信层在调研场景形同虚设（§4-3）。
5. **覆盖判定收紧与残差闭环**（P2）：covered 从「任意 evidence」收紧为 verified/promoted（M8.3.3 报告 §7.3 已登记）；residual gap 只能被 research() 重跑清除——需要「缺口已补」的显式标记。

**M10（受控多轮循环执行器 + 研究记忆）**
1. **M8.4 受控循环执行器**：按已落盘的 loopPolicy 有界执行「execute→analyze→accepted gaps→derive→（approve 断点留给用户）」，三个停止条件接入。
2. **Gap 决策跨轮继承**（§4-5）：gapId 含 planId 导致派生后全部残差缺口换 id 重置 proposed，同一方向反复要用户确认。
3. **跨 run 研究记忆**：以 literaturePlan 残差 + gaps 决策 + coverage 历史为起点累积「项目研究状态」，对标领域空白「记忆与经验累积薄弱」。
4. **学术 deep research 评测基准**（potentialContributions[3] 直接给出的方向）：引用忠实率 / 证据覆盖率 / 调研残差率 / 单位报告成本——PaperTeam 的确定性产物结构天然可度量。

---

## 4. 发现的问题（验收实测，均未修复、未绕过）

1. **[P0·数据损坏] save_candidates 并发写入损坏候选库**：research 阶段 Researcher 在同一毫秒（15:37:17.098Z）发起 ≥4 次 save_candidates，`sources/candidates.json` 落盘为「完整文档 + 3 个残尾」的非法 JSON（4995 字节）。此后：GET candidates 静默返回空列表（宽容读取掩盖损坏），POST 保存候选 500「候选文献索引损坏」，**候选链路对该项目阻断**。根因：`writeFileAtomic` 的 tmp 名 `.${pid}-${Date.now()}.tmp` 毫秒粒度可碰撞 + CandidateStore 无 per-project 串行化（ProjectStore 有 `mutate()` 互斥，CandidateStore 没有）。佐证：Researcher 自己在 literaturePlan 里如实登记了「规划 20 条候选仅 2 条成功落盘」。本次验收对该文件做了**恢复性截断**（保留第一个完整文档 C001/C002，原文件备份为 `candidates.json.corrupted-backup`）——数据操作仅限本验收自建项目，不涉及源码。
2. **[P1·能力缺口] Web Search 未配置即整类查询失败**：q-15 唯一一条 web query 失败（错误信息可行动），导致验收目标问题 2（商业系统）整域零覆盖。属部署配置问题而非缺陷，但「无 SearXNG 的默认部署」天然缺一条腿，M7 时代已知、验收如实暴露其研究后果。
3. **[P1·链路断层] 纯检索场景 evidence 永远 unverified**：Researcher 输出的 12 条 evidence 候选无 chunk 锚定（文献不在库、无全文），全部走 legacy unverified 追加；evidence.ground 阶段 pending=0 空转。「检索→全文→锚定→核验」的自动链路（M7.2 已实现）在真实调研流中未被接通——promote 时有后台单次 resolve-fulltext 尝试，但本轮实测 promote 后仍停留 metadata_only。
4. **[P2·观测断层] plan 执行的 140 条检索结果不留任何可检索痕迹**：M8.2 设计为「只回填计数、不持久化」，符合边界；但事后无法审计「q-1 那 10 条到底是什么」，候选补存必须手工重跑同一 query（且受检索缓存 TTL 10min 限制，本验收实际是重新检索）。
5. **[P2·语义] Gap 决策不跨迭代继承**：gapId=hash(planId+方向)，derive 换活动计划后全部残差缺口换新 id 重置 proposed——用户对同一方向已做的 accept/reject 决策休眠失效（本轮实测：二轮 gaps 全部回到 proposed）。与 M8.3.3「方向再次出现时自动恢复显示」的预期不完全一致。
6. **[P3·副作用] backend 启动自动恢复遗留 run**：启动即恢复 `p-14b91574046f` 两天前中断的 existing_paper_improvement run 并消耗约 $0.13 真实模型调用（feasibility + improvement-plan）后停靠 HITL。行为符合恢复设计，但验收环境无意触发了其他项目的研究推进（该 run 现处 awaiting_input，未再干预）。
7. **[P3·可观测] GET /sources/candidates 对损坏索引静默返回空**：与保存路径的「显式报错」口径不一致，损坏被读取路径掩盖（§4-1 的发现因此延迟暴露）。

---

## 5. PaperTeam Deep Research 能力评价

**结论：核心 Deep Research Pipeline（Plan → Approve → Execute → Coverage → Gap → HITL derive → 二轮）完整跑通，工程纪律好，但「研究消化层」（检索结果→候选→全文→verified evidence）在真实调研流中是半成品。**

- **能做且做得好**：ResearchPlan 生成质量高（15 条 queries 与目标精确对齐、rationale/expectedCoverage 完整）；执行状态机严谨（draft→approved→done、done 重复执行 409、失败 query 保持 planned）；provider 层鲁棒（S2 429 冷却自动恢复、partial success 如实上报）；Coverage/Gap 结构化、确定性、可审计（gapId 稳定、决策快照落盘、原计划不可变）；HITL 边界真实存在（无任何自动循环，loopPolicy 只存不执行）。
- **做到但打折**：候选/文献链路要用户手工重查重存（§4-4）；evidence 可信层在纯检索场景不激活（§4-3）。
- **当前不能**：web 检索域（未部署 SearXNG）；跨轮研究记忆；残差缺口的状态在计划演化后不延续（§4-5）。
- **诚实性评价（重要）**：流水线全程零伪造——检索失败如实 failed、evidence 如实 unverified、覆盖缺口如实登记（连自身基础设施损坏都被 Researcher 登记为残差）。这与 PaperTeam「Retrieved ≠ Candidate ≠ Literature ≠ Verified Evidence」的顶层纪律一致，是相比覆盖内对照系统（report 的说法：主流 deep research agent 缺证据核验闭环）的真实差异化。

**是否完整跑通：是。** 六个验收步骤全部经 PaperTeam API 完成，无一步绕过；两处数据操作（候选库恢复性截断、二轮计划 question 的 draft 编辑）均为流水线内显式动作且已如实记录。

---

## 6. 建议下一阶段优化方向

（= §3.6 的执行视角摘要，供 M8.4 / M9 规划取用）

1. **P0** 修复 save_candidates 并发写入（CandidateStore 引入与 ProjectStore 同款 per-project 串行 mutate；tmp 名加单调序号）；GET candidates 对损坏索引改为与写路径一致的显式报错。
2. **P0** 部署 SearXNG（compose 已有 `--profile research` 模板）并在验收环境配置 `PAPERTEAM_SEARXNG_URL`——商业 Deep Research 系统调研是当前唯一零覆盖的一级问题域。
3. **P1** 「执行结果入候选」显式动作（execution → per-query top-N 一键 saveAsCandidates），消除手工重查。
4. **P1** promote→全文→chunk→anchored evidence 的调研流自动衔接（M7.2 链路在 idea_to_paper 场景的实战化）。
5. **P2** M8.4 受控循环执行器（消费 loopPolicy，断点保留在 approve）；Gap 决策按「方向指纹」跨迭代继承。
6. **P2** 覆盖判定收紧（verified/promoted 才算 covered）+ 残差缺口的显式关闭路径。
7. **P3** 研究记忆（跨 run 累积 coverage/gaps/决策历史）；学术 deep research 评测基准（引用忠实率/证据覆盖率/调研残差率/单位成本）作为 PaperTeam 的可量化贡献点。

---

## 附：验收产物清单

- 验收项目：`backend/projects/p-dced898cd766/`（research/research.json：plan 链 2 轮 + executionHistory 18 条 + gaps 决策 3 条 + loopPolicy；sources/candidates.json（恢复后 4 条候选）+ candidates.json.corrupted-backup；evidence/evidence.jsonl 12 条；workflow/runs/w-20a56ee82238/）
- 后端日志：`/tmp/paperteam-m8-validation.log`
- 本报告：`docs/research/M8_DEEP_RESEARCH_VALIDATION_REPORT.md`
