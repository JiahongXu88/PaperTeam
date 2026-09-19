# PaperTeam Self Review — M7.1d

> 日期：2026-09-19 · 阶段：M7.1d（Self Review）
> 基线：main @ `ff48c78`（Phase 0 文档收口后）
> 性质：**纯研究产物，零业务代码改动**（红线全部维持：无架构重构、无新
> Agent、无 Runtime/Workflow/SearchService/EvidenceStore 改动、无 Vector DB）。
> 方法：用 PaperTeam 自身 Research Discovery 能力（`search_papers` /
> `search_web` / `lookup_paper` / `save_candidates`，Agent 会话同款工具面）
> 调研外部 AI Research Agent / Deep Research 系统，对照自身真实代码做
> 架构对比。原始调用记录：[m71d-selfreview-search-results.json](m71d-selfreview-search-results.json)
> （17 次学术检索 170 条结果 / 2 次 Web 检索 / 3 次查证 / 12 条候选落盘）。

---

## 0. 执行摘要

1. **PaperTeam 的差异化不在「检索能力」而在「证据纪律」**。对比的全部
   外部系统中，只有 PaperTeam 把 Retrieved ≠ Verified ≠ Grounded 作为
   类型级不变量、把证据写入收敛到单一机械核验管道（quote 逐字 + metadata
   权威 + 语义 judge），并有五模型族 live 评估证明零捏造泄漏（M6.9）。
   Deep Research 类产品（OpenAI/Gemini/Claude）的报告引用不经过机械
   核验；PaperQA2 有高精度引用但没有「候选-转正-证据」的 HITL 状态机。
2. **最大能力缺口是「检索的纵深」**：单轮检索（Agent 会话内自主多 query，
   但无覆盖度评估驱动的受控多轮循环）、无预执行研究计划（Gemini Deep
   Research 的可编辑 plan 是行业标配交互）、无 Web 检索开箱能力（本机
   实测 `search_web` 两次调用均 `SEARCH_PROVIDER_NOT_CONFIGURED`）。
3. **最大评估缺口是「检索质量本身无度量」**：M6.8/M6.9 评估框架覆盖了
   grounding / revision / workflow 三类问题，但 discovery 环节（query
   质量、候选精度、promote 转化率）没有任何指标——M7.3 / M8 的取舍
   恰恰需要这些数据（M7_SCOPE_FREEZE §6-M7.3 启动前置已预判）。
4. 本次调研本身构成 Research Discovery 的第 5 次真实使用（M7.1b 三场景
   之后）：17 次 `search_papers` 调用中 OpenAlex 17/17 ok、arXiv 17/17 ok、
   Semantic Scholar 17/17 限流（provider 降级如实进 partial，链路不中断）；
   `lookup_paper` 3/3 精确 match（AI Scientist / PaperQA / STORM 原文
   全部经 DOI canonical 核验）；12 条候选经 `save_candidates` 落盘、
   全部 pending_review。

---

## 1. Current PaperTeam Architecture（基于真实代码）

### 1.1 组件清单（逐项经源码验证，行号为 main @ ff48c78）

| 组件 | 载体 | 事实 |
|---|---|---|
| **Runtime** | `runtime/PiRuntimeAdapter.ts`（3125 行） | 唯一正式 Runtime：进程内 Pi（`@earendil-works/pi-coding-agent`，D-0020）。契约 v2：事件缓冲（seq 单调 + `event_gap` 合成事件，慢消费者不静默漏）、AbortSignal 统一消费、queued cancellation（显式 FIFO 队列）、四层超时（init/session/queue/execution）、run 级 usage/cost 采集。per-Agent 模型配置（M5.7）：writer/researcher/academicReviewer… 各自 provider/model，失败结构化不静默回落 |
| **工具注入** | `index.ts:152` `roleCustomTools(role, projectId)` | 工具按角色 + 项目闭包注入，Agent 无法跨项目、无法持 shell / 直连外部 HTTP（D-0033 边界） |
| **Researcher** | `agents/ResearcherService.ts`（528 行） | M7.1a 检索优先 prompt（:386）：研究型问题先 `search_papers`（yearFrom/yearTo 聚焦近年），Web 线索 `search_web`，单篇存疑 `lookup_paper` 核验；**禁止凭记忆断言论文存在性/年份/venue**；空库引导先检索再调研（:216）；外部对比可用检索（:252） |
| **Search** | `search/researchDiscoveryService.ts`（266 行）唯一编排入口 + `academicSearchService`（OpenAlex primary / Semantic Scholar fallback+enrichment / arXiv preprint / AMiner China-secondary）+ `webSearchService`（SearXNG，optional） | 检索编排在确定性服务层：provider 选择 / 并发 fan-out / 降级 / identityKey 分层判重（doi>arxiv>pmid>标题指纹>url）/ 加权 RRF 融合全部是代码，无第二 LLM 决策面。进程内检索缓存（LRU ≤5/query、TTL 10min，不落盘）支撑 save_candidates 按下标回放。共享 `providerHttp.ts`：超时/退避/熔断/四态健康 |
| **CandidateSource** | `sources/CandidateStore.ts`（354 行） | Discovery 状态机 pending_review → accepted/rejected；`save_candidates` 与 HTTP `saveAsCandidates` 汇聚同一保存函数，元数据只能来自 provider 真实返回（Agent 无法按值伪造入库）；rejected 不判重 |
| **Literature Library** | `sources/SourceStore.ts`（739 行）+ `SourceImportService` | 五入库路径（PDF/DOI/arXiv/URL/BibTeX）；`promoteCandidate` 幂等、HITL、origin=AGENT_RETRIEVED、无全文 → metadata_only（M7.2 FullTextResolver 补全文） |
| **Retrieval / RAG** | `retrieval/`（RetrievalService 805 行 / SourceChunker 315 / ChunkStore 232 / hybrid） | section-aware chunking（metadata_only 一律 skipped）；BM25 + 可选 dense + RRF hybrid，进程内 index.json，零外部索引服务（D-0036） |
| **Evidence** | `evidence/EvidenceGroundingService.ts`（519 行）+ `EvidenceStore` + `EvidenceSelectionService` | 三段核验（:227 quote 逐字 `verifyQuoteInChunk` → metadata 权威裁决 → 语义 judge）；写入唯一入口 `appendBatch`；工具层零 EvidenceStore 写路径（`evidence/tools.ts:8`）：`propose_evidence` 只产生 pending 候选，`evidence_query` 只读投影，writer 强制 formalOnly 视图（verified + chunk 锚点） |
| **Writer** | `writer/WriterService.ts` | 证据感知写作循环：授权只认计划点名旧值+新值（或 Evidence 含新值）；外部意见 mandatory 派发 + `%%%PT-OUTCOMES%%%` 执行报告（applied/conflict/not_applicable） |
| **Reviewer** | `agents/ReviewerService.ts` + `review/`（14 文件） | ReviewAggregator / styleInvariants / revisionPlan（确定性）/ revisionValidation / externalInstructions；Revision Safety 状态机 + Revision Gate |
| **Workflow** | `workflow/definitions.ts`（3600 行） | research.idea（:2000）→ evidence.ground（:2040）→ research.feasibility（:2071）+ citation.verify（:210）/ review.run（:230）/ quality.gate（:302）/ revision.plan（:421）/ build.final（:667） |
| **前端** | `frontend/src/components/project/DiscoveryPanel.tsx`（695 行）+ `api/discovery.ts` | M7.1c：学术检索表单 + 结果列表 + 勾选保存候选 + 候选管理（accept/reject/promote 一键转正）+ SearXNG 未配置引导 |

### 1.2 闭环数据流（M7 当前形态）

```text
User Research Question（researchIdea）
  ↓ research.idea（M7.1a 检索优先 prompt）
Researcher Agent（单轮会话内自主多 query：M7.1b 实测 A 场景 9 次检索）
  ↓ search_papers / search_web / lookup_paper
ResearchDiscoveryService（4 学术源 + 融合去重 + partial 降级如实）
  ↓ save_candidates（缓存按下标回放，防伪造）
CandidateStore（pending_review）
  ↓ 用户 promote（HITL，幂等）——前端 M7.1c UI
SourceStore（metadata_only / 全文 PDF）
  ↓ SourceChunker → ChunkStore → hybrid 检索
EvidenceGroundingService（三段核验）→ EvidenceStore（verified）
  ↓ Writer / Reviewer / Quality Gate 消费
```

---

## 2. External System Analysis

证据来源标注：**[PT]** = PaperTeam 自身检索命中（m71d-selfreview-search-
results.json，附 DOI/arXiv id）；**[Web]** = 补充通道（Claude 内置 WebSearch，
因本机 SearXNG 未配置；见 §3 Research Discovery 行的 Gap 说明）。

### 2.1 OpenAI Deep Research

- **核心能力**：5–30 分钟自主深度调研，产出带引用的研究报告；Humanity's
  Last Exam 26.6%（发布时 SOTA 级）。
- **Workflow**：o3 推理模型为底座，端到端强化学习训练浏览+推理任务
  **[Web]**（openai.com「Introducing deep research」2025-02-02）。自主
  规划 → 迭代搜索/阅读/推理（含代码执行与工具调用）→ 综合。
- **Retrieval**：浏览器级 Web 遍历（非策展学术 API）；检索策略由 RL
  训出的策略承担，非规则编排。
- **Evidence 机制**：报告内嵌引用指向访问过的页面；**无机械逐字核验层**，
  引用正确性依赖模型自身。
- **Agent orchestration**：单 agent 循环（计划-行动-观察），工具面含
  browsing + Python；Deep Research API（2025-06）把该 agent 作为可编排
  组件输出。

### 2.2 Claude Research（Anthropic）

- **核心能力**：会话内 Research 模式：数十到数百次**相互构建的迭代搜索**
  （后续搜索基于前面结果的发现），综合为带引用报告 **[Web]**。
- **Workflow**：agentic——自主决定下一步查什么；支持接入 Google
  Workspace（Gmail/Calendar/Docs/Drive）做私有语料调研。
- **Retrieval**：Web 搜索工具 + Workspace 连接器。
- **Evidence 机制**：引用 + 可追溯；2026-06 发布 Claude Science（科研
  workbench）：强调**可审计产物**（auditable artifacts）+ 本地 Python/R/shell
  执行 **[Web]**——与 PaperTeam「文件优先、可审计」的取向同型。
- **Agent orchestration**：单 agent 多步；「研究即对话」（可追问、可细化）。

### 2.3 Gemini Deep Research（Google）

- **核心能力**：多步深度调研报告；2025-12 起提供 API 化 agent。
- **Workflow**：**先产出显式研究计划（用户可编辑——协作式规划），再自主
  执行多步浏览**，迭代细化 query，最后综合成结构化报告 **[Web]**
  （gemini.google/overview/deep-research；ai.google.dev Deep Research agent
  文档）。训练侧用 multi-step RL for search。
- **Retrieval**：Web 遍历 + 用户 Workspace 内容。
- **Evidence 机制**：引用列表 + 报告内引用；无独立核验层。
- **Agent orchestration**：plan-execute-synthesize 三段；plan 是用户可见、
  可干预的一等产物。

### 2.4 AI Scientist（Sakana，v1/v2/Nature 版）

- **核心能力**：端到端自动科研：想法生成 → 实验编码 → 数据分析 → 论文
  写作 → 自动评审。v2 论文成为首篇通过 ICLR 2025 workshop 盲审的全 AI
  论文；v1 工作以「Towards end-to-end automation of AI research」发表于
  Nature（2026，检索命中 80 引）**[PT]**（doi:10.1038/s41586-026-10265-5）。
- **Workflow**：v1 固定 pipeline（idea → exp → write → review）；
  **v2 用 agentic tree search 取代刚性 workflow**（arXiv 2504.08066，
  124+ 引）**[Web][PT]**——对给定想法探索多条实验/写作路径，自评估择优。
- **Retrieval**：以代码执行与实验为主，文献检索为辅（S2 API 检索种子
  文献）。
- **Evidence 机制**：实验产物即证据；论文文本不设独立核验层（依赖 LLM
  reviewer）。
- **Agent orchestration**：模板化 workflow（v1）→ 自适应树搜索（v2）；
  无 HITL（全自动是其目标）。

### 2.5 Agent Laboratory（AMD/JHU，2025）

- **核心能力**：LLM agents 作为研究助理，分阶段协human-in-the-loop：
  literature review → formulation → 实验 → 写作，人类可在各阶段介入。
- **Workflow**：phased co-authoring（arXiv 2501.04227，29 引）**[PT]**。
- **Retrieval**：arXiv 检索（嵌入检索为主）。
- **Evidence 机制**：无独立核验；产出物（代码/论文）由人类审。
- **Agent orchestration**：多 agent 分工（PhD/Postdoc 角色化）+ 阶段门控。

### 2.6 PaperQA / PaperQA2（FutureHouse）

- **核心能力**：高精度科学文献 RAG 问答与综述；PaperQA2 在 LitQA2 上
  超人类专家准确率；「语言 agent 实现超人的科学知识综合」。
- **Workflow**：**把 RAG 分解为工具**——LLM 自主控制检索参数、生成并
  检查候选答案后再给最终答案（arXiv 2312.07559，52 引，本文经
  `lookup_paper` canonical 核验 doi:10.48550/arxiv.2312.07559）**[PT]**；
  PaperQA2 进一步把综合过程组织为**迭代更新的 wiki 式知识库** **[Web]**
  （futurehouse.org 2024-09）。
- **Retrieval**：自建文献语料 + 工具化检索（LLM 改写 query、多轮）。
- **Evidence 机制**：引用必须锚定到论文原文片段（chunk 级）——**与
  PaperTeam 的 chunk 锚点同型**；但无「候选-转正」HITL 状态机，正确性
  由评测基准背书。
- **Agent orchestration**：工具化 agent 循环（agent 决定何时搜、搜什么、
  答案何时够好）。

### 2.7 STORM / Co-STORM（Stanford, OSDI/OVAL）

- **核心能力**：从零写出 Wikipedia 级长文；NAACL 2024（经 `lookup_paper`
  核验 doi:10.18653/v1/2024.naacl-long.347）**[PT]**。
- **Workflow**：**perspective-guided question asking**——先派生多视角
  问题集，检索外部资料模拟「与持不同视角的专家对话」，再 outline-driven
  写作；Co-STORM 增加人机协作话语（人类可接管、引导话题）。
- **Retrieval**：Web 检索引擎（多源）+ 视角驱动的 query 生成。
- **Evidence 机制**：引用对齐检索到的原文；_outline → 全文_ 每段挂引用。
- **Agent orchestration**：确定性的「视角-问题-检索-写作」骨架 + LLM
  填充（与 PaperTeam「编排在确定性服务层」取向同型）。

### 2.8 Elicit / SciSpace（产品）

- **核心能力**：面向系统综述的量产工具：语义检索（亿级论文库）+
  **结构化字段抽取表格**（population/intervention/outcome 跨论文对齐）+
  筛选辅助（预测 desk rejection 的 PRI 分）+ Deep Review（分钟级系统
  综述）**[Web]**。
- **Workflow**：检索 → 筛选（include/exclude，每步可审计）→ 抽取 →
  综合——**把系统综述方法论（PRISMA）产品化**。
- **Retrieval**：自建语义索引（非通用 Web）。
- **Evidence 机制**：抽取值锚定原文 + 人工核查列；2026 学术评测指出
  该类工具引用可靠性仍显著低于人工（检索命中「AI Legal Research Tools
  可靠性评估」145 引同型证据）**[PT]**。
- **Agent orchestration**：以流水线 + 表格交互为主，弱 agent 自主性。

### 2.9 Google AI Co-Scientist（Nature 2026）

- **核心能力**：研究目标 → 假说生成与进化；Nature 2026（检索命中 94 引，
  doi:10.1038/s41586-026-10644-y）**[PT]**。
- **Workflow**：多 agent **generate-reflect-rank 进化循环** + 锦标赛
  择优 + Elo 排序；人类以对话形式注入研究目标与反馈。
- **Evidence 机制**：假说关联文献与实验验证（湿实验闭环案例：用药假说
  实验证实）。
- **Agent orchestration**：竞争性多 agent 辩论（与 PaperTeam 单
  Researcher + 工具的拓扑相反）。

### 2.10 综述与基准（横向参照系）

- **Deep Research: A Survey of Autonomous Research Agents**（arXiv
  2508.12752）**[PT]**：把 DR agent 统一为四阶段——**Planning /
  Question developing / Web exploration / Report generation**，并单列
  evaluation 与 trustworthiness 为独立维度。
- **DEER**（2025，专家级报告生成基准）**[PT]**：评估 deep research
  agent 的报告质量。
- **Agentic AI 综述**（2025，139 引 doi:10.1007/s10462-025-11422-4）
  **[PT]**；**AI Agents vs. Agentic AI**（205 引）**[PT]**。
- **Adaptive-RAG**（2024，216 引）**[PT]**：按问题复杂度自适应检索深度。
- **MiniCheck**（2024，42 引）**[PT]**：grounding 文档上的高效事实核查
  ——外部世界也在把「核验」做成独立可评测组件。
- **LLM 系统综述自动化**（2025，doi:10.1101/2025.06.13.25329541）
  **[PT]**：Elicit/SciSpace 类工具在系统综述流程中的定位评估。

---

## 3. Capability Comparison

| Capability | PaperTeam（M7 后） | External Systems | Gap |
|---|---|---|---|
| **Research Discovery** | ✅ 4 学术源 + S2 降级 + 融合去重（D-0035）；Agent 会话内自主多 query（M7.1b 实测 9 次）；候选显式保存防伪造 | DR 三家：Web 级浏览（覆盖面远大）；Elicit/SciSpace：亿级策展语义索引；AI Scientist：检索为辅 | **Web 检索非开箱能力**（本机 2 次调用均 not_configured）；学术源限流应对依赖 provider 降级（本次 S2 17/17 限流）；无全文自动获取（M7.2 待做） |
| **Query refinement** | ⚠️ prompt 引导 Agent 生成 query（yearFrom/yearTo 聚焦）；无结构化 query 计划/改写组件 | DR 综述把 question developing 列为独立阶段；Adaptive-RAG 按复杂度自适应；STORM 视角驱动问题生成 | query 质量完全内生于 Agent 会话，**不可观测、不可干预、不可复用** |
| **Multi-round retrieval** | ⚠️ 单轮会话内自主多 query；跨轮（literaturePlan → 补检索）是人工动作（M7 冻结决策，开放项 #3） | OpenAI/Claude/Gemini：5–30 分钟自主迭代循环（数十~数百次搜索）；PaperQA2：候选答案驱动再检索 | 无覆盖度评估驱动的受控多轮；**这是与 DR 产品最大的体感差距**，但 M7 冻结明确「真实使用数据未到前不做」 |
| **Evidence grounding** | ✅✅ **最强项**：三段机械核验（quote 逐字/metadata 权威/语义 judge）+ 单一写入口 + 工具层零写路径；M6.9 五模型族 live：对照臂 25/25 全捏造 vs PaperTeam 臂 0 泄漏、76% 转正 | DR 三家：引用即证据，无机械核验层；PaperQA2：chunk 锚定（最接近）但无 HITL 状态机；MiniCheck：核验作为独立组件趋势 | 外部普遍更弱；PaperTeam 无需追赶，应**对外显性化这一差异化**（评估报告可引用） |
| **Citation** | ✅ citation.verify 独立 stage（:210）+ scholarlyResolver + lookup_paper 核验语义（match/mismatch/not_found/unresolved 四态，error ≠ not_found ≠ 空集） | Elicit 结构化抽取引用；AI Scientist LLM reviewer；DR 内联引用 | 相当或领先；差距在**引用网络/元数据富化**（无引证图、无相关论文推荐） |
| **Memory** | ⚠️ 文件优先三层状态（D-0013）：项目即磁盘，跨会话续跑；检索缓存进程内即失（D-0035 有意为之）；**无跨会话知识综合**（verified evidence 累积在 evidence.jsonl 但无「研究 wiki」式再组织） | PaperQA2：迭代 wiki 知识库；Claude：Workspace 长期记忆 + projects；Co-Scientist：Elo 排序持续进化；STORM：mind map | 设计上零持久化检索是纪律不是缺陷，但 **verified 证据的累积价值未被挖掘**（只有逐条消费，无综合视图） |
| **Evaluation** | ✅✅ 次强项：M6.8/M6.9 scripted+live 框架、多模型、calibration 记录、结构化报告——**生产系统内置此评估深度的罕见** | DEER/GAIA/BrowseComp/LitQA2 是**外部**基准；各 DR 产品无公开的内部评估框架 | **discovery 环节零指标**：query 质量、候选精度、promote 转化率、provider 健康对结果的影响全部无度量；评估框架未覆盖检索环节 |
| **Human feedback** | ✅ HITL 深植：候选必经用户 promote、Revision Gate、外部意见 mandatory 派发、Quick Review 只读 | Gemini：**执行前**可编辑研究计划；Claude：对话式追问引导；Elicit：筛选流程逐步反馈；Co-Scientist：人类注入目标 | PaperTeam 的反馈**全部后置**（检索完成才有人工介入点）；无预执行计划审批——外部已把它做成标准交互 |

---

## 4. Improvement Opportunities

> 纪律：本节只形成建议，不实施（M7 红线维持）。P0/P1/P2 与 M8 候选
> 路线的关系见 [M8_ROADMAP_PROPOSAL.md](M8_ROADMAP_PROPOSAL.md)。

### P0 — 短期必须（补齐闭环与可观测性，全部在既有冻结空位内）

**P0-1 Web 检索开箱可用性**

- **Current**：SearXNG optional（D-0033/35），未配置时 `search_web` 结构化
  返回 not_configured——本次调研 2 次调用均如此；Researcher prompt 却
  引导「需要 Web 线索时用 search_web」，引导与能力存在日常性错位；
  M7.1c 前端为此专门做了未配置引导。
- **External evidence**：三个 DR 产品的核心检索面都是 Web；本报告 §2
  全部 Web 证据被迫走补充通道获取。
- **Gap**：默认安装的 PaperTeam 没有 Web 检索；非技术用户不会部署
  SearXNG（需独立服务 + 环境变量）。
- **Recommendation**：部署侧而非架构侧——compose 默认带 SearXNG 服务 +
  `doctor.mjs` 增加 searxng 可达性检查 + 文档置顶（检索栈 D-0036 零
  改动；若引入非 SearXNG 的 Web provider 才需走 DECISIONS 登记）。

**P0-2 M7.1 验收后半段闭环（既有计划重申，非新增）**

- **Current**：M7.1 验收底线 1 后半段（真实项目 promote → 全文 →
  verified evidence 磁盘全链证据）未完成；M7.2 FullTextResolver 未做，
  promote 后 metadata_only → chunker 跳过 → 对 verified 池贡献为零
  （P-D 断点仍在）。
- **External evidence**：PaperQA2 的价值证明全靠「全文在场」；AI Scientist
  的证据=实验产物。没有全文就没有 grounding。
- **Gap**：闭环最后一公里。
- **Recommendation**：按 M7_SCOPE_FREEZE §6-M7.2 原计划执行（挂接点已
  冻结于 D-0042：SourceImportService.tryResolveFullText + Unpaywall/
  arXiv/OA-URL 三实现）。**此项是 M8 一切检索增强的前置。**

**P0-3 Discovery 环节基础度量（只读埋点，不改行为）**

- **Current**：discovery 零指标——candidates.json 有 origin/provider/query
  provenance（本次 12 条落盘验证），但没有任何统计出口；promote 率、
  候选精度、query 多样性、provider 健康与结果质量关系全部不可见。
- **External evidence**：DR 综述（2508.12752）把 evaluation 列为独立
  维度；DEER 基准专测报告质量；M7.3 启动前置明确要「真实使用数据」。
- **Gap**：M7.3/M8 的每个取舍（多轮检索？query 改写？）都会退化为拍脑袋，
  因为没有数据。
- **Recommendation**：评估框架内新增只读统计（复用 M6.8 评估目录纪律，
  被测系统零改动）：per-project 候选量/promote 率/拒绝原因分布/
  provider resultCount 中位数。这是「用数据决定 M8」的地基。

### P1 — 增强能力（M8 候选主体）

**P1-1 研究计划一等产物（plan → 用户可编辑 → 执行）**

- **Current**：literaturePlan 是检索**后**的「残差清单」（M7.1a 语义），
  出现在 research.json 里，用户无干预入口；Agent 的检索 query 序列完全
  内生。
- **External evidence**：Gemini Deep Research 的显式可编辑研究计划是
  其标志性交互 **[Web]**；DR 综述把 Planning 列为四阶段之首 **[PT]**；
  STORM 的 perspective 问题集本质是可检查的检索计划。
- **Gap**：无预执行干预点；反馈全部后置（§3 Human feedback 行）。
- **Recommendation**：不新增 Agent、不改 workflow——在 research.idea
  产物上增加「下一轮检索计划」结构（query × 理由 × 期望覆盖），前端
  M7.1c 面板加「执行此计划」按钮（复用既有检索 HTTP 面）。等价于把
  literaturePlan 从文档字段升级为可操作产物。

**P1-2 受控多轮检索循环（有界、可停）**

- **Current**：单轮会话内 Agent 自主多 query（M7.1b 场景 A 9 次），
  但循环止于会话结束；无「检索结果覆盖度不足 → 自动补检索」；M7 冻结
  明确单轮（开放项 #3：真实数据未到）。
- **External evidence**：OpenAI/Claude/Gemini 5–30 分钟自主循环、
  Claude「数百次相互构建的搜索」**[Web]**；PaperQA2 候选答案驱动再
  检索 **[Web]**。
- **Gap**：调研纵深。但注意 PaperTeam 的 HITL 定位不同——目标是「研究者
  的证据工作台」不是「自动报告机」。
- **Recommendation**：方向=「计划驱动的受控多轮」（P1-1 的计划逐项执行 +
  新结果率低于阈值自动停 + 每轮结果仍只进 pending 候选），而不是无人值守
  长循环。红线不变（无新 Agent；循环编排在服务层）。**前置**：P0-3 数据
  证明单轮确实不够。

**P1-3 候选/证据的排序与富化**

- **Current**：候选融合排序=加权 RRF（既有）；EvidenceSelectionService
  按 verified+锚点选取；检索结果已带 citationCount/openAccess 但仅展示。
- **External evidence**：Elicit 的 PRI 筛选分把「该读哪篇」做成产品功能
  **[Web]**；综述类系统普遍做 venue 权威度信号。
- **Gap**：候选列表对用户是平的——12 条候选与 120 条结果哪个更值得先看，
  无引导。
- **Recommendation**：纯前端/服务层排序信号（citationCount 分位 +
  venue 权威表 + openAccess 加权），不引入新检索架构。

**P1-4 Discovery 评估场景（评估框架扩展）**

- **Current**：M6.8 三实验（grounding/revision/workflow）不含 discovery；
  M6.9 live 化只覆盖 Exp1。
- **External evidence**：DEER（报告质量）、LitQA2（文献问答）证明检索
  环节可基准化 **[PT]**。
- **Gap**：无法回答「PaperTeam 的检索质量比 Elicit/直接用 OpenAlex 好
  还是差」。
- **Recommendation**：评估框架内新增 Exp4（种子文献集 → discovery 命中
  率/排序质量），scripted 起步（与 M6.8 同纪律：评估只读被测系统）。

### P2 — 长期方向

**P2-1 Verified 证据的项目级综合视图（「研究 wiki」）**

- **Current**：verified evidence 逐条存 evidence.jsonl，消费方式是
  Writer/Reviewer 按需检索；无跨条综合、无主题组织、无演进视图。
- **External evidence**：PaperQA2 的迭代 wiki **[Web]**；Co-Scientist 的
  Elo 进化 **[PT]**；Claude Science 的 auditable artifacts **[Web]**。
- **Gap**：证据累积的价值只被线性挖掘；长项目的知识不复利。
- **Recommendation**：长期候选——verified 证据上的结构化综合（主题/
  冲突/演进），文件优先落盘（D-0013 纪律内），不动 EvidenceStore 写
  路径。需独立设计冻结（M7.3 Reference Paper Intelligence 同域）。

**P2-2 检索-写作的引用网络利用**

- **Current**：无引证图（candidate 的 references 字段未采集）；「找相关
  论文」只有关键词检索一条路。
- **External evidence**：OpenAlex 引证数据免费可得（既有 provider！）；
  Connected Papers 类产品以此为核。
- **Gap**：检索收敛后无扩展手段（滚雪球式 snowballing 是系统综述方法论的
  标配动作）。
- **Recommendation**：候选详情暴露 references/cited-by（OpenAlex 字段
  已在 provider 返回中，未透传）——小改动大收益，但属 M7.3 域，需与
  P0-3 数据一起排期。

**P2-3 多模型 judge 用于 discovery 质量评估**

- **Current**：M6.9 已有多模型评估基建；语义 judge 目前用于证据核验。
- **External evidence**：LLM-as-a-judge 综述（103 引）**[PT]** 指出
  same-model bias——M6.9 已知限制同款。
- **Gap**：无（基建已在）；缺的是把它指向 discovery（与 P1-4 合并考虑）。

---

## 5. 结论

1. **不追赶的方向**：无人值守长循环全自动报告生成（AI Scientist 路线）
   与竞争性多 agent 辩论（Co-Scientist 路线）——与 PaperTeam「研究者的
   证据工作台 + HITL 纪律」定位相反，且 D-0009/D-0041/D-0042 三重冻结
   均排除。这个「不做」有外部证据支持：DR 产品的引用无核验层，恰是
   PaperTeam 已被 M6.9 证明的强项。
2. **要追赶的方向**（按序）：P0 闭环与可观测 → M8 候选见
   [M8_ROADMAP_PROPOSAL.md](M8_ROADMAP_PROPOSAL.md)。
3. **本次调研对 M7 红线的回归确认**：零业务代码改动；新增物仅本报告、
   M8 提案、一次性脚本 `scripts/m71d-selfreview-research.mjs`（不进 CI）
   与检索记录 JSON；测试未动（Phase 4 全量回归验证）。

---

## 附：Research Discovery 调用记录（本次调研）

| # | 工具 | query（tag） | 结果 |
|---|---|---|---|
| 1-17 | `search_papers` | deep-research-systems / ai-scientist / paperqa / storm / literature-review-automation / agentic-rag / iterative-retrieval / multi-agent-science / citation-verification / evidence-grounding / research-benchmarks / human-ai-research / ai-scientist-paper / agent-laboratory / deep-research-survey / co-storm / elicit-review | 17/17 成功（status=partial，S2 限流降级）：170 条结果，OpenAlex 17/17 ok、arXiv 17/17 ok（含 2 次超时重试后成功） |
| 18-19 | `search_web` | openai-deep-research / gemini-deep-research | 2/2 结构化 `SEARCH_PROVIDER_NOT_CONFIGURED`（产品如实形态；本机未配置 SearXNG） |
| 20-22 | `lookup_paper` | The AI Scientist（2024）/ PaperQA（2023）/ STORM（2024） | 3/3 outcome=match，canonical DOI 核验（2408.06292 / 2312.07559 / 10.18653/v1/2024.naacl-long.347） |
| 23-26 | `save_candidates` | deep-research-systems / ai-scientist / paperqa / storm 各 top3 | 4 次保存 12 条候选，全部 pending_review，provenance（origin=academic_search / provider / query）完整 |

关键命中（详见 JSON）：The AI Scientist（doi:10.48550/arxiv.2408.06292）/
Agent Laboratory（doi:10.48550/arxiv.2501.04227）/ Deep Research 综述
（doi:10.48550/arxiv.2508.12752）/ Co-Scientist（doi:10.1038/s41586-026-10644-y）/
Towards end-to-end automation of AI research（doi:10.1038/s41586-026-10265-5）/
PaperQA（doi:10.48550/arxiv.2312.07559）/ STORM（doi:10.18653/v1/2024.naacl-long.347）/
MiniCheck / Adaptive-RAG / DEER / SciAgents / Agentic AI 综述（139 引）。

补充通道（Claude 内置 WebSearch，非 PaperTeam 能力面，因本机 SearXNG 未
配置）：OpenAI Deep Research 官方发布与架构分析 / Claude Research 与
Claude Science / Gemini Deep Research 官方文档与 API / PaperQA2 wiki 综合
机制 / AI Scientist-v2（arXiv 2504.08066）/ Elicit vs SciSpace 对比 /
Deep Research 综述四阶段分类（arxiv.org/abs/2508.12752 摘要）。
