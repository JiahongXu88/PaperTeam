# PaperTeam Post-M8 Market-Aligned Capability Audit & Roadmap

- 日期：2026-09-22
- 基线：`main @ bbed9cd`（feat: harden M8 research pipeline；M8.1–M8.5 全部合入）
- 性质：只读代码审计 + Roadmap 规划。零业务代码改动；本文档是唯一新增文件。
- 审计方法：docs（PROJECT_STATUS / ARCHITECTURE / DECISIONS / M8 系列报告）+ 全量源码扫描
  （backend 159 个 TS 文件 ≈57.9k 行；frontend 75 个 TS/TSX 文件；backend/test 139 个测试文件
  ≈1511 用例；frontend/test 26 文件 ≈238 用例；e2e 9 个 Playwright spec），
  所有结论附代码坐标；**文档声明一律以源码核实为准**。
- 纪律声明：本报告的出发点不是「把热门关键词补进仓库」。每个候选项必须回答
  「产品是否需要 / 架构是否重复 / 面试能否讲出真实取舍」三问，答案不足者进
  Non-Goals。

---

## 1. Executive Summary

PaperTeam 当前的真实状态可以一句话概括：

> **检索 → 文献 → 全文 → 检索(RAG) → 证据核验 → 写作 → 审稿 → 修订安全 → 质量门禁
> → LaTeX/PDF 的全链路组件已经存在且被厚测试钉死；M8 又在其上叠了
> 「计划 → 批准 → 执行 → 覆盖 → 缺口 → HITL → 派生」的受控研究循环。
> 但这条链从未被接通成一次真实的产品级使用：从浏览器新建 idea 项目开始、
> 经真实调研与全文证据、到一篇结构完整引用可追踪的论文 PDF——这条路今天走不完，
> 缺的不是新组件，而是「接线 + 激活 + 一次诚实的真实验收」。**

审计发现的最重要事实（后文逐一展开）：

1. **参考清单里的 A（Evidence-grounded RAG）大部分 ALREADY COVERED**：chunk
   管线 / BM25 / RRF hybrid / context packing / 三段核验 / claim-evidence 映射 /
   citation grounding 全部真实存在；dense 通道刻意只留确定性测试实现（生产
   lexical-only 是文档化红线，不是烂尾）。真正缺的是把这条链在真实调研流里
   **激活**（M8 验收：12 条 evidence 全部 legacy unverified，`evidence.ground`
   pending=0 空转）。
2. **不需要 Vector DB，不需要 Python 服务**（§5/§6 给出可辩护的工程理由）。
3. **Observability 的缺口比文档给人的印象更实**：AgentTask 的 usage/model/skills
   采集齐全但**只活在内存**（200 条 FIFO 环 + 进程级合计，重启归零）；StageRecord
   无 usage 字段；HTTP 全文 0 次暴露 usage；前端 0 次消费。缺的是
   「持久化 + 关联 + 一个只读视图」，不是第二套事件系统。
4. **一个此前未登记的产品断点**：前端没有任何 idea_to_paper 的发起入口
   （`createWorkflowRun` 的 3 个调用点全部是 existing 系列）——浏览器用户建完
   idea 项目后无按钮可点，E2E 只有 API 驱动。
5. **评估框架的诚实度高于覆盖度**：能测「安全机制对注入故障的拦截率」与
   「五模型族无库自报的捏造率 vs 管线零泄漏」，不能测「一篇论文的质量」
   （live 只支持 Exp1 单环节；人工校准 0 条；same-model judge bias 自知自标注）。

据此给出的推荐路线（§11）：

| Milestone | 一句话 | 排序依据 |
| --- | --- | --- |
| **M9** | Full Paper E2E Activation——接通既有链路，真实跑出第一篇完整论文 | 阻塞产品成立；组件全在，只缺接线 |
| **M10** | Run Observability & Cost Transparency——stage×agent×model×token×cost 关联可审计 | 真实架构缺口（数据在内存蒸发）；M9 长跑即需要 |
| **M11** | E2E Evaluation & Regression——把评估扩到整篇论文 + deep research 效率指标 | M9 产出被评对象后才有意义；大部分指标可确定性计算 |
| M12+（条件） | Research Memory（跨 run 研究状态沉淀） | M8 报告识别的领域空白；但排在 E2E 之后，不做提前量 |

四条「如果只准做 4 个方向」的答案（Q9）：① M9 E2E 激活；② M10 观测与成本；
③ M11 E2E 评估；④ 研究记忆（条件启动）。

---

## 2. Current Repository Capability Audit（20 域）

分级口径：**DONE**=完整实现且有测试防线；**PARTIAL**=机制在但有真实缺口；
**PLACEHOLDER**=接口/类型在、无真实实现；**MISSING**=不存在。

| # | 域 | 分级 | 代码事实（证据） |
| --- | --- | --- | --- |
| 1 | Runtime | **DONE** | `runtime/PiRuntimeAdapter.ts` 3125 行，唯一正式 Runtime（Pi 0.84.4 in-process，backend 运行时依赖仅此一个，`backend/package.json`）。四层治理齐备：分层 timeout（init/session/queue/execution）、全局并发 permit + 有界受理（`RUNTIME_QUEUE_FULL`）、context budget preflight + session rotation（generation 换代）、TTL/GC/容量硬帽。契约 v2（`runtime/types.ts:444` 行） |
| 2 | Agent orchestration | **DONE** | `workflow/WorkflowOrchestrator.ts` 确定性引擎 + `definitions.ts`（~3400 行）三条 workflow stage 注册表；checkpoint 原子写（`runStore.ts:55-59`）、events.jsonl、stages/ 逐尝试记录、重启恢复（`WorkflowOrchestrator.ts:302-332`）、HITL resume、协作式取消、bounded loop |
| 3 | Research / Deep Research | **DONE（集成层 PARTIAL）** | M8 全家：`agents/researchPlan.ts`(626)/`researchPlanExecution.ts`(404)/`researchPlanIteration.ts`(157)/`researchCoverage.ts`(442)/`researchGap.ts`(365)/`researchLoopPolicy.ts`(177)/`researchLoop.ts`(968)。计划状态机 draft→approved→executing→done、HITL 三断点、崩溃恢复纯按磁盘事实重算、预算硬顶。**缺口**：loop 在 workflow 之外独立 API 面（`httpServer.ts:1126-1313`），与写作链只经文献库衔接且需多步手工；Coverage 判定是 token 交集（跨语言会误判 missing，`researchCoverage.ts:41-43` 自认）；无跨 run 研究记忆 |
| 4 | Search | **DONE** | `search/` 12 文件 2517 行：providerHttp（633 行，熔断三态/健康四态/Retry-After 双格式/双硬帽，`providerHttp.ts:84-203,265-301`）+ OpenAlex/S2/arXiv/AMiner 四学术 Provider + SearXNG（optional）+ 加权 RRF 融合（`fusion.ts`）。ScholarlyResolver 四源核验（`citation/scholarly.ts:532-538`）。真实公网验证过（M7.1b / M8 验收） |
| 5 | Literature | **DONE** | `sources/` 7 文件 2958 行：分层身份键 DOI>arXiv>PMID>标题指纹>URL（`identity.ts:211-232`）、候选≠正式分文件、五入库路径、metadata 水位线 merge、promotion 幂等、Evidence 引用删除保护、CandidateStore 并发互斥（M8.5 P0 修复，`CandidateStore.ts` 433 行 + 12 用例） |
| 6 | FullText | **DONE（激活 PARTIAL）** | `search/fullText.ts`(406 行)：Unpaywall/OpenAlex oa-url/arXiv 三 resolver + SSRF 逐跳护栏（`:242-315`）+ ≤5 跳 + %PDF- 魔数 + 20MB + 同条目原地补挂（`SourceStore.attachFile:637-680`）+ 五结局数据化（`SourceImportService.ts:408-542`）。**缺口**：真实调研实测 promote 后常停留 metadata_only（M8 验收 §4-3）；无批量动作、无 fullText 状态 UI、无手动上传补挂端点（D-0043「不做」清单遗留） |
| 7 | Retrieval | **DONE（dense=测试实现）** | `retrieval/` 10 文件 2427 行：稳定 chunkId `<sourceId>:<sectionId>:<序号>:<hash10>`（`chunking.ts:118`）、进程内 BM25（k1/b、idf/df 维护完整，`lexicalIndex.ts:146-148`）、中英 bigram tokenizer、RRF hybrid + 签名自动增量刷新（`RetrievalService.ts:433-515`）、metadata filter、context budget packing（`contextPacker.ts:45-98`）。**dense 通道生产零 vendor**——唯一实现是确定性 token-哈希袋（`embedding.ts:36-83`，头注释自认），生产 lexical-only 是 D-0033 红线。benchmark 进 CI（Recall@5≥0.9 / R@10≥0.6 / MRR 阈值，`test/retrieval/benchmark.test.ts:333-353`） |
| 8 | Evidence | **DONE（激活 PARTIAL）** | `evidence/` 8 文件 1883 行：候选-转正状态机（`candidates.ts:209-250` 唯一转换口）、三段核验（quote 逐字 NFKC/软连字符归一 `quoteVerification.ts:33-38` → metadata → 语义 judge）、grounded 写入唯一入口 + 幂等守卫（`EvidenceGroundingService.ts:328-378`）、工具权限矩阵 researcher=3/writer=formalOnly query（`tools.ts:266-291`）、EvidenceSelectionService 单点使用策略。**缺口**：纯检索场景下 Researcher 输出无锚定 → 全走 legacy unverified（M8 验收 §4-3），可信层在真实调研流未激活 |
| 9 | Citation | **DONE** | 三层：静态检查 + metadata 核验（Crossref/OpenAlex/arXiv，`metadataProviders.ts`）+ 语义核验 v5（原子论断×引用组、judge 伪造引文剥离、NOT_FOUND≠捏造≠检索失败纪律，`citation/` 域）；真实论文 E2E 验证过（26 页/25 引文/63 关联） |
| 10 | Writer | **DONE** | `writer/WriterService.ts` 1015 行 7 操作（write/planOutline/writeSection/reviseSection/polishSectionStyle/repairSection/planImprovement）；evidence digest 行内挂 bib key（`:70-85`）+ evidence_query 主动查询指引；修订纪律强（事实冻结/负结果不美化/引用白名单） |
| 11 | Reviewer / Revision | **DONE** | 三 lens（fact/academic/style，`agents/ReviewerService.ts:426-446`）+ RevisionPlanItem 7 态生命周期（`review/revisionItemStatus.ts:21-31`）+ revision.validate 四类确定性复核（`revisionValidation.ts` 397 行）+ claimStrength marker 级启发式（自认边界）+ styleInvariants 6 规则 + 外部意见 5 态确定性状态机（`externalInstructions.ts:291-360`） |
| 12 | Quality Gate | **DONE（口径边界自知）** | `quality/gates.ts`：恒在 9 条 + 条件最多 11 条（满配 20）。factPreservation 1127 行逐单元格/公式/方向哨兵；citationPreservation 389 行；citations_evidence_backed **默认呈现不阻断**（`:475-486`，`requireEvidenceBackedCitations` 缺省关）。已知边界：academic/style 阈值消费的是 Reviewer LLM 自评分——Gate 判定确定性，输入是主观值 |
| 13 | Evaluation | **PARTIAL** | `backend/src/evaluation/` 19 文件 5467 行：三实验 + live + 五模型 multiModel，报告入 Git（`evaluation/reports/` 16 文件）。**缺口**：live CLI 只支持 Exp1（`cli.ts:169-171`）；无整篇论文质量评估；人工校准 0 条（仅 example）；judge 与被测同模型（bias 自标注）；Exp2/3 仅 scripted |
| 14 | Observability | **PARTIAL** | 采集侧齐（AgentTask.usage/model/skills/durations，`runtime/types.ts:132-177,222-233`；21 种 Domain Event；runtimeStats/sessionDiagnostics）。**缺口**：任务记录纯内存 200 条环（`PiRuntimeAdapter.ts:702,182`）重启归零；StageRecord 无 usage/durationMs/agentTaskId（`workflow/types.ts:93-103`）；usage 零 API 暴露、前端零消费；无 trace 模块（eventLog 明确不写 token/tool call，`eventLog.ts:6-7`——分层是有意设计，缺的是 stage 级持久化与关联视图） |
| 15 | Model Provider | **DONE（无自动路由，by design）** | Pi in-process；per-Agent 六键 override（`settings/ModelSettingsStore.ts:23-38`）+ 三协议自定义 provider + 失效结构化失败不静默回落；usage 可归因 Agent×模型（内存内）。无自动 fallback/成本路由（M5.7 明确决策「未来出现需求才抽象」） |
| 16 | Usage / Cost | **PARTIAL** | per-task usage 完整（input/output/cache/context/estimatedCost）+ 进程级 usageTotals（`PiRuntimeAdapter.ts:2565-2600`）+ m5/m57 验收脚本日志。**缺口**：无 run 级汇总、无持久化、无 API、无 UI（见 #14） |
| 17 | Memory | **MISSING（by design so far）** | 跨 run/跨会话长期记忆零实现（全仓 grep 仅 Pi SessionManager.inMemory 与 PDF 解析 note）；唯一持久化是 workspace 8 目录落盘（`ProjectStore.ts:111-120`）——这是 D-0013「Workspace 是事实源」的刻意选择，不是欠账；研究记忆是 M8 报告识别的领域空白 |
| 18 | Frontend / UX | **DONE（两个缺口）** | 8 页面 + 项目工作区 9 tab（概览/论文产出/PDF/Discovery/文献库/证据/引用/Review/工作流，`ProjectPage.tsx:36-50`），HITL 面板、SSE 实时、双主题、26 文件测试。**缺口 A**：无 idea_to_paper 发起入口（`useCreateWorkflowRun` 3 个调用点全 existing 系列：`ProjectAside.tsx:47`/`ReviewPanel.tsx:88`/`NewProjectPage.tsx:280`）；**缺口 B**：无任何 usage/cost/trace 展示（与 #14 同根） |
| 19 | Deployment | **DONE** | 四阶段 Dockerfile + compose 三服务（backend/web/可选 searxng profile research）+ 双 volume 事实源 + readiness/liveness + 优雅停机；2026-09-15 真实 Docker 验收通过；CI 两 job（test 含 benchmark/performance 阈值 + docker-build smoke）。零向量库/队列/数据库/OTel 依赖 |
| 20 | Testing / Regression | **DONE（eval 回归节奏 PARTIAL）** | backend 139 文件 ≈1511 用例（PiRuntimeAdapter 专项 102）+ frontend ≈238 + e2e 9 spec（含视觉基线）；scripted/no-model/无 Docker 多栈；检索 benchmark 与性能冒烟在 CI。评估实验（需花钱）全部手动、无固定节奏 |

---

## 3. Market Capability Gap Analysis（参考清单 A–M 去伪存真）

对每个候选项回答任务规定的 A–H 七问后归入五档。判断基准：**产品自然演进 >
架构真实缺口 > 面试价值；「简历关键词」本身不构成立项理由。**

| 项 | 判定 | 依据摘要 |
| --- | --- | --- |
| **A. Evidence-grounded RAG / Evidence Depth** | **ALREADY COVERED**（核心）+ **MUST BUILD（激活，并入 M9）** | 参考链 Search→Candidate→Literature→FullText→Parse→Chunk→Retrieval→Evidence Extraction→Claim-Evidence Mapping→Verification→Writer→Citation **每一环都已存在**（§2 #4-#10）。缺的不是组件：①真实调研流里 evidence 停留 unverified（激活问题）；②跨语言语义检索是 Known Limitation（dense 无 vendor）。Query Rewrite 由 M8 计划链的逐轮 queries 承担；Rerank 见 Non-Goals |
| **B. Full Paper E2E Product Closure** | **MUST BUILD（= M9）** | 唯一阻塞产品成立的方向；最终产物清单（paper/references/evidence report/review report/revision history/gate/trace/cost）大部分已有落盘形态，缺「一次真实跑通 + 前端可达 + 引用可追踪强制化」 |
| **C. Agent Trace / Observability** | **MUST BUILD（= M10，收敛型）** | 审计确认：数据采集在、持久化与关联展示缺（§2 #14）。Run ID/Agent/Model/Token/Cost/Latency/Queue/Retry/Timeout/Cancel/Error 的**原始事实全部已采集**，做的是「落 stage 记录 + 一个聚合视图」，不是新 Runtime Event System（红线见 §7） |
| **D. Evaluation / Regression** | **SHOULD BUILD（= M11）** | 框架在、诚实方法论在；缺 E2E 论文质量与 deep research 效率指标、缺 live 多环节、校准空转。统一进既有 `backend/src/evaluation/`，**不另起系统** |
| **E. Research / Project Memory** | **OPTIONAL（M12+ 条件启动）** | M8 报告 §3.4 识别「记忆与经验累积薄弱」为领域空白，与产品自然相关；但 E2E 未成立前做记忆=积累无人消费的状态。列入第四方向（条件） |
| **F. Model Routing / Fallback / Budget** | **DO NOT BUILD NOW** | per-Agent override 已覆盖真实需求（六键、结构化失败、usage 归因）；自动路由在**没有成本遥测（M10）与多模型真实运维经验**之前引入=新增失败模式。M5.7 已有明确决策记录 |
| **G. Python AI Service** | **DO NOT BUILD** | 见 §6。Embedding 若真需要也是 HTTP API 调用而非本地 Python 服务 |
| **H. RAG parameter experiments** | **DO NOT BUILD NOW** | 无真实 embedding vendor 时调参=对哈希袋调参；benchmark harness 已在 CI，真 vendor 接入后（若触发）再谈 |
| **I. One-click Demo / Deployment** | **OPTIONAL（不立项）** | 部署已 DONE（真实 Docker 验收）；demo 是演示问题不是工程问题 |
| **J. Dashboard** | **DO NOT BUILD（独立项）** | 真实需求已被 M10 的 run trace 视图覆盖；大屏=展示工程 |
| **K. MCP** | **DO NOT BUILD** | D-0033 冻结：内部零 MCP，TS interface + Pi customTools 在单进程产品里严格更优 |
| **L. Figure generation** | **DO NOT BUILD NOW** | research 级难题 + 当前 Writer 明确禁 tikz（`WriterService.ts:577` 宏包契约）；与「第一篇真实论文」无关 |
| **M. More Agents** | **DO NOT BUILD** | D-0009 红线贯穿 M6-M8 全程且被反复验证：少量角色 Agent + 强 Tool + Evidence Layer + Quality Gate 是 PaperTeam 的架构身份 |

### 3.1 Q1–Q3 直答

- **Q1（已有不需再做）**：A 的几乎全部组件（chunk/检索/混合/核验/映射/门禁）、
  C 的采集侧、D 的安全机制评估与多模型评估、F 的 per-Agent 配置、I 的部署、
  M 对应的「Agent 角色」本身。
- **Q2（确实缺且必须补）**：B 的真实接通（前端入口/一键候选衔接/全文激活/
  锚定证据调研流/bibliography 确定性化/一次真实验收）；C 的 stage 级 usage
  持久化与 run trace 视图；D 的 E2E 论文评估与校准填数。
- **Q3（做了即过度工程）**：Vector DB、Python 服务、MCP、自动 model routing、
  reranker、Knowledge Graph、独立 Dashboard、无人值守自主循环。

### 3.2 能力矩阵

| Capability | Current Status | Evidence in Code | Product Necessity | Market Value | Interview Value | Cost | Recommendation | Target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chunk/Retrieval/BM25/RRF | DONE | retrieval/ 2427 行 + CI benchmark | 高（已在用） | 中 | 高（取舍可讲） | — | KEEP AS IS | — |
| Dense embedding (real vendor) | PLACEHOLDER(测试实现) | embedding.ts:36-83 | 低（未命中真实痛点） | 高（关键词） | 中 | 低 | BUILD LATER（条件） | M12+ |
| Vector DB | MISSING | 零依赖（grep 证实） | 无 | 高（关键词） | 低（讲不出理） | 高 | DO NOT BUILD | — |
| Reranker | MISSING | D-0033 拒绝项 | 无 | 中 | 低 | 中 | DO NOT BUILD | — |
| Evidence grounding pipeline | DONE（未激活） | evidence/ 1883 行 | 高 | 高 | 高 | — | KEEP AS IS + M9 激活 | M9 |
| FullTextResolver | DONE（未激活） | fullText.ts 406 行 | 高 | 中 | 中 | — | M9 补激活动作 | M9 |
| Search→Candidate 衔接 | PARTIAL | executionHistory 仅 identifiers | 高 | 中 | 中 | 低-中 | BUILD NOW | M9 |
| 前端 idea 发起入口 | MISSING | 3 调用点全 existing | 高（阻塞 E2E） | 低 | 低 | 极低 | BUILD NOW | M9 |
| bibliography 确定性生成 | PARTIAL | ManuscriptService 一律 @article | 高（引用可追踪） | 低 | 中 | 中 | BUILD NOW | M9 |
| Run trace / cost | PARTIAL | 内存环+零 API | 高 | 高 | 高 | 中 | BUILD NOW | M10 |
| E2E paper evaluation | MISSING | cli.ts:169-171 live 仅 Exp1 | 高 | 高 | 高 | 中 | BUILD NOW | M11 |
| 人工校准 | PLACEHOLDER | records.jsonl 不存在 | 中 | 低 | 中 | 低 | BUILD NOW（M11 填数） | M11 |
| Research memory | MISSING | grep 零命中 | 中（E2E 后升高） | 高 | 高 | 中-高 | BUILD LATER | M12+ |
| Model auto-routing | MISSING（by design） | M5.7 决策 | 低 | 中 | 低 | 高 | DO NOT BUILD | — |
| Python AI service | MISSING | 仅 pymupdf 子进程 | 无 | 高（关键词） | 低 | 高 | DO NOT BUILD | — |
| MCP | MISSING | D-0033 | 无 | 高（关键词） | 低 | 中 | DO NOT BUILD | — |
| 受控研究循环（M8） | DONE | researchLoop.ts 968 行 | 高（已在用） | 高 | 高 | — | KEEP AS IS | — |
| Runtime 治理 | DONE | PiRuntimeAdapter 3125 行 | 高 | 高 | 极高 | — | KEEP AS IS | — |

---

## 4. Overengineering Risks（本路线明确规避）

1. **Vector DB**：项目级语料是数十~数百篇文献（4290 chunks lazy 索引 619ms、
   查询 p95 2.6ms 的实测规模），内存暴力余弦 + json 向量旁车绰绰有余；引入外部
   索引引擎违反 Derived State 纪律并增加部署面。触发条件写死：单项目语料
   >10⁴ chunk 且查询延迟成瓶颈才重评。
2. **Python 服务拆分**：把单进程单用户产品拆成双服务，换来的只是简历上
  一门语言名。当前唯一 Python 是 pymupdf 子进程（协议化、无 shell、
   `parse_paper_pdf.py` 只做提取不做领域逻辑）——这是自然的进程边界，不是
   「Python AI 服务」。
3. **MCP 内部化**：进程内 TS interface + customTools 的类型安全与测试性
   严格优于跨进程协议层（D-0033 六源码调研的结论，至今成立）。
4. **自动 model routing**：无成本遥测支撑的路由是盲路由；M5.7 的「用户显式
   配置 + 结构化失败」在真实使用中未表现出瓶颈。
5. **提前做研究记忆**：E2E 不成立时，记忆层积累的状态没有任何消费方；
   先让一条论文真实跑完，再让记忆服务它。
6. **无人值守自主循环**：M8 的三处 HITL 断点是产品身份（受控研究），
   「自主化」不是演进方向而是定位漂移。

---

## 5. RAG Decision

**当前架构事实**：Search（四学术源+SearXNG）→ Candidate（显式）→ Literature
（promotion 幂等）→ FullText（三 resolver+护栏）→ Chunk（稳定 ID）→
Retrieval（BM25 + optional dense + RRF hybrid + budget packing）→
Evidence（三段核验候选-转正）→ Writer/Reviewer（formalOnly 消费）→
Citations_evidence_backed（Gate 规则 16）。**即参考清单 A 的链条已全部存在**，
其中 BM25-like、metadata filtering、citation grounding、ChunkStore、
Retriever、EvidenceQuery、FullTextResolver 全部真实实现。

**真正缺的不是「RAG」，是「Retrieval Quality 的一个已知边界 + Evidence
Pipeline Integration 的激活」**：

1. **Embedding**：当前生产 lexical-only。是否需要真实 vendor？——**条件性需要**。
   已知真实缺口只有一个：跨语言语义查询（中文问题查英文文献无词重叠时不命中，
   benchmark 与 M6.4 Known Limitation 如实记录）。学术场景这是真实痛点但不是
   当前主瓶颈（查询通常可与文献同语言）。**决定**：不立项；当 M9 真实论文项目
   命中该失败时，按既有 `EmbeddingProvider` 抽象接一个 HTTP embedding vendor
   （估 ~200 行 + 配置），dense 通道与旁车缓存机制全部现成。**仍然不需要
   Vector DB**（规模论证见 §4.1）。
2. **Vector DB**：**不做**。理由同 §4.1，且 Index=Derived State 可删可重建的
   设计（签名增量刷新、损坏自愈）在进程内形态下已被测试钉死。
3. **Hybrid Retrieval**：**已有**（RRF k=60 等权，两处同思想实现），mock dense
   验证过融合机制；真实 vendor 接入后无需改动编排。
4. **Rerank**：**不做**。语料规模与 RRF 融合的实测效果（lexical R@5=0.90）不
   支持「加一个模型调用换排序」的成本模型；D-0033 拒绝项维持。

一句话结论：**PaperTeam 不缺 RAG，缺的是让 RAG 产物在真实调研里变成 verified
evidence 的那一段接线（= M9），以及（条件触发时）一个真实 embedding vendor。**

---

## 6. Python Service Decision

**不做。**逐项核对 Node 生态限制假设：

| 候选理由 | 核实结果 |
| --- | --- |
| Document Parsing 依赖 Python AI 生态 | PDF 解析已用 pymupdf 子进程（自然边界、协议化、测试覆盖）；GROBID 已评估并 defer（部署成本 > 收益，M4.3 决策） |
| Embedding 依赖 Python | 若触发，是调外部 HTTP API（Node 原生 fetch 即可），不是本地跑模型 |
| Retrieval/Rerank 计算型 workload | 进程内 BM25 + 内存余弦在实测规模下 p95 2.6ms；无 GPU workload |
| Evaluation 依赖 Python 工具链 | 评估框架是 TS，scripted 确定性 + live 复用生产 adapter，无 numpy/pandas 需求 |
| 资源隔离需求 | 单进程单用户产品；唯一子进程（pymupdf）已隔离 |

唯一成立的 Python 存在形态就是现状：**一个协议化提取脚本**。把它扩张成
「Python AI Service」在架构上是倒退（拆服务边界、双运行时、双依赖链），
在简历上是装饰（面试官追问「为什么拆」时答案站不住）。

---

## 7. Observability Decision

**现有数据盘点**（审计确认）：Runtime 事件（AgentEvent 11 类）、Domain Event
（21 种，events.jsonl 落盘 + SSE replay）、run/checkpoint/stages 落盘、
AgentTask.usage/model/skills/durations/errorCode（内存）、进程级
usageTotals、各服务零散 lastTelemetry、GET /api/runs/:id（完整 checkpoint）。

**真正的缺口排序**：

- A. Trace data model —— 半缺：AgentTask 齐、StageRecord 缺 usage/durationMs/
  agentTaskId（`workflow/types.ts:93-103`）；
- B. Trace persistence —— **缺**：usage 只在内存 200 条环，重启归零（
  `PiRuntimeAdapter.ts:702,182`）；stage 记录落盘但无 usage 列；
- C. Trace correlation —— **断**：stage summary 仅 2 处带 taskId，业务层不透传
  usage，taskId 反查在环淘汰/重启后失效；
- D. Trace replay —— 部分：Domain Event 可 replay（业务语义），但无 token/cost
  维度可回放；
- E. Dashboard —— 缺（且只做 run 详情内的视图，不做大屏）。

**决定（= M10）**：做 B+C+A（stage 级持久化 + 关联），配一个只读聚合视图（E 的
最小形态）。**明确不做第二套 Runtime Event System**：Domain Event 流保持
业务事件（eventLog 分层设计是有意的——事件流回答「发生了什么」，checkpoint/
trace 回答「花了什么代价」）；不引入 OTel/外部 APM；不换日志框架。这是
「把已有数据接上」的收敛型工程，量级可控。

---

## 8. Evaluation Decision

**已有雏形（比「雏形」强得多）**：三实验三/两臂 + fault injection + 结构校验
数据集 + scripted 确定性指标 + live Exp1 + 五模型 multiModel + 报告入 Git +
人工校准接口（空转）。它的诚实纪律（limitations 全显式、零伪造、
「有效性证据=零泄漏而非拦截率」）本身就是资产。

**决定（= M11）：统一扩展，不另起系统。**

- **Golden Dataset 应该是什么**：3–5 个研究主题（覆盖中/英、综述型优先），
  每主题带 ①期望引用池（SourceIdentity 键，允许超集）；②结构 rubric
  （必备章节/摘要/引用数下限）；③预算上限。**不追求大规模**——PaperTeam 的
  价值在确定性可算指标，不在样本量。
- **评测对象**：M9 产出的完整论文 run（live）+ scripted 全链路（CI 回归）。
- **Deterministic 指标**（零 LLM）：citation fabrication rate（复用静态+
  metadata 核验）、citations_evidence_backed 覆盖率、research residual gap
  rate（coverage 产物直读）、stage/section completeness、cost & latency per
  paper（依赖 M10 的 trace）。
- **LLM Judge 指标**（学术质量）：**judge 与生成模型异族**（multiModel 基建
  现成，GLM 生成→Claude/GPT 评，反之亦然）、固定 rubric、judge 只见论文不见
  过程、verdict 需引用论文原文锚点。**防自嗨三件套**：异族 judge +
  确定性指标优先呈现 + judge 结论只作信号不作 Gate。
- **避免 Judge 自嗨的既有教训延续**：same-model bias 显式标注（M6.9 已做）、
  机械核验优先（quote 逐字判定不依赖模型）、无校准记录时 preference=null
  不伪造。

---

## 9. Full Paper E2E Critical Path

**目标口径**：「尽快完成第一篇完整、结构正确、引用可追踪、质量普通但真实的
论文」。综述型（survey）主题是正确选择——它不需要真实实验（避免
target_feasibility 对实验的硬要求挡死 Final），且价值恰恰在引用密度与证据
覆盖，正好压测 PaperTeam 的差异化能力。

**现状卡点**（从 New Project 走到 Final 的断点，按链序）：

```text
新建 idea 项目(UI ✓) ──✗── [无发起按钮] ──▶ run 启动(API-only)
research.idea(真实) ──▶ evidence.ground(no-op：无锚定候选) ──▶ …写作…
侧线：Discovery 检索(✓) ──✗── 候选要手工重查保存 ──✗── promote 后全文
常停 metadata_only ──✗── 无状态可见/批量补挂 ──▶ evidence 永远 unverified
bibliography = LLM 字符串(@article 一律) ──✗── 引用可追踪打折
```

**Critical Path（最小阻塞集合，即 M9 主体）**：

- **Step 1（极小）**：idea 项目页「开始生成论文」入口（hook 与 API 已支持任意
  kind，纯前端按钮 + 引导文案）。
- **Step 2（小-中）**：计划执行结果持久化 top-N 归一化条目（有界：每 query
  ≤10 条、含 identity 键与最小 metadata）+ Discovery 面板 per-query 一键
  勾选入候选（复用 saveAsCandidates→CandidateStore 单一写入口；检索层
  「默认零持久化」红线不变——持久化的是**用户显式要求的执行审计产物**，
  存 research 域不进检索缓存）。
- **Step 3（中）**：全文激活——文献库批量「补全全文」动作（逐条走既有
  tryResolveFullText，有界并发）+ fullText 状态列（resolved/not_found/failed/
  not_resolvable 五态呈现）+ 手动上传补挂端点（attachFile 原语已就位）。
- **Step 4（中）**：锚定证据调研流——Researcher 在文献库有全文时优先
  retrieve_library → get_chunk → propose_evidence 锚定路径（工具面与核验管道
  零新增，prompt/流程接线 + 真实验证 evidence.ground 非 no-op）。可选收紧：
  coverage 的 covered 判定从「任意 evidence」收紧为 promoted/verified。
- **Step 5（中）**：bibliography 确定性化——references.bib 优先由 promoted
  source 的 resolver 元数据渲染（含 @inproceedings/@article 等条目类型），
  Researcher 的 LLM bibliography 降为补充/兜底；引用 key 与
  matchBibliographyKey 的关联规则对齐。
- **Step 6（验收本身）**：`scripts/m9-acceptance.mjs`（仿 m5-acceptance 模式）
  ——真实模型 + 真实检索 + 真实全文下载，从 UI 路径启动，产出完整论文；
  对该项目开启 `requireEvidenceBackedCitations=true`；报告如实记录
  Draft/Final、覆盖率、成本、时长、每一次人工介入。
- **并行 Step 0（部署项，非代码）**：SearXNG 容器真实部署验证
  （compose profile research 已有模板；需有 Docker 的环境）。

**不是本路径前置条件（明确后做）**：研究记忆、embedding vendor、M10 trace
（验收脚本用现有 usageTotals + 任务日志即可记账）、M11 评估、图表能力、
rerank。Step 1–5 全部不触碰分层红线（Retrieved≠Candidate≠Literature≠Verified
不变；Loop 不自动 promote 不变）。

---

## 10. Resume / Interview Value Analysis

### 10.1 简历五亮点（全部真实存在、可深入追问）

1. **Agent Runtime 治理**（PiRuntimeAdapter 3125 行）：分层超时、全局并发
   permit + 有界受理、context budget preflight + 会话 rotation（generation
   换代不破坏 FIFO）、TTL/GC/容量硬帽——102 个专项用例含 160-run soak。
2. **证据接地管道**：Retrieved ≠ Verified ≠ Grounded 不变量 + 候选-转正
   状态机 + 三段核验（前两段零 LLM）+ 五模型族对照验证（Plain LLM 25/25
   捏造 vs 管线零泄漏）。
3. **修订安全**：RevisionPlanItem 生命周期 + revision.validate 四类确定性
   复核 + Fact/Citation Preservation + Claim Strength Gate——「LLM 改稿后由
   确定性代码裁决改得对不对」。
4. **受控研究循环（M8）**：Plan→Approve→Execute→Coverage→Gap→HITL→Derive
   状态机 + 崩溃恢复纯按磁盘事实重算 + 预算硬顶 + 三处不自动跨过的断点。
5. **（M9-M10 落地后）全链 E2E 与成本可审计**：「系统真实写出了一篇每条
   引用可回溯到 chunk 的论文，且每个 stage 的 token/费用/时延事后可查」——
   目前市场叙事里最稀缺的一句。

### 10.2 面试可深挖的三个工程问题

1. **「为什么不用 Vector DB / reranker？」**——规模实测数字、RRF 融合、
   Derived State 索引、benchmark 阈值进 CI、以及「什么条件下我会改答案」
   （>10⁴ chunk 或跨语言失败成为主瓶颈）。这是取舍题不是立场题。
2. **「Agent 任务的取消/超时/并发怎么治理？」**——queued cancel 不等前序
   run、deadline 跨 FIFO→permit 不重置、permit 只在 session 队头后申请、
   abortInitiator 唯一归因、settle 收口记账无槽位泄漏。
3. **「怎么评估一个 multi-agent 系统不出假东西？」**——三臂实验设计、
   机械核验优先于模型判定、judge 同模 bias 的显式处理、refused 是合法测量
   结果、有效性证据=零泄漏而非拦截率。

### 10.3 价值-真实性纪律

以上每一项都以「仓库测试与真实验收报告可举证」为前提；本路线不为增加
关键词新增任何不可辩护的模块——这正是 §3 把 MCP/Vector DB/Python/Routing
全部判 DO NOT BUILD 的原因：它们在 PaperTeam 语境下**经不起追问**。

---

## 11. M9–M11 Recommended Roadmap

### M9 — Full Paper E2E Activation（第一篇完整论文）

- **Goal**：从浏览器新建 idea 项目开始，经真实调研（含全文获取与证据核验），
  产出一篇结构完整、引用可追溯（chunk 级）、质量普通但真实的论文 PDF
  （Draft 起步、争取 Final），全程产品内完成并诚实留档。
- **Why now**：①阻塞产品成立（第一排序权重）；②组件 100% 已存在，缺的只是
  接线（M8 验收 §4-3/§4-4 + M8.5 §9 遗留清单就是需求文档）；③M10/M11 都以
  「真实 E2E 存在」为前提。
- **Dependency**：无新架构、无新 Agent、无 Runtime/Workflow 核心改动；全部
  在既有 Service/Store/UI 层；分层红线全部维持。
- **子任务**：§9 的 Step 1–6（+ 并行 Step 0 部署项）。
- **Acceptance Criteria**：
  1. 真实项目从 UI 发起 run 至 Draft PDF（理想路径 Final），章节/摘要/参考文献
     结构完整；
  2. `evidence.ground` 非 no-op（verified ≥ 1 起步，目标量级 ≥ 10）；
  3. `citations_evidence_backed` 覆盖率随 gate 产物落盘，且该项目开启
     `requireEvidenceBackedCitations` 后 Final 被其真实约束；
  4. 从论文 PDF 任一 `\cite` 可经 bib key → EvidenceRecord → chunkId → 原文
     追溯（手工抽查 ≥ 10 条全通过）；
  5. 验收报告含：每步人工介入次数、成本/时长（现有 usageTotals + 任务日志）、
     失败与降级如实记录；
  6. 全量测试零回归；Evidence 分层边界测试（M8.5 researchArtifactAudit）保持绿。
- **Demo value**：产品核心故事的完整演示（一句话可讲）。
- **Interview value**：E2E 闭环 + 诚实验收方法论 + 「为什么最终能/不能 Final」
  的门禁叙事。
- **明确不做**：研究记忆、embedding vendor、novelty discovery、自动循环、
  图表、模型路由。

### M10 — Run Observability & Cost Transparency

- **Goal**：任一 run 的执行史可事后审计——stage × agent × model × tokens ×
  cost × latency × retries 关联成链，跨重启可查，前端可见。
- **Why now**：审计确认 usage 数据在内存蒸发（200 条环 + 进程合计）、
  StageRecord 无 usage、零 API 零 UI——M9 的真实长跑（数小时、数十 stage、
  多 Agent）没有它就是黑盒对账；这是「已有数据 + 缺持久化与展示」的收敛工程。
- **Dependency**：M9（有真实长跑可观测、可对账）；不引入新依赖。
- **子任务**：
  1. StageRecord 增可选字段 `agentRuns?`（taskId/model/usage/durations/
     errorCode 摘要）——stage settle 时从 AgentTask 注入（趁环未淘汰），
     随 checkpoint 自然持久化；
  2. run 完成时在 WorkflowState/完成产物写 run 级 usage 汇总；
  3. `GET /api/runs/:runId/trace`（或扩展 GET run 载荷）——只读聚合，回答
     「这次生成花了多少、花在哪」；
  4. 前端：run 详情的 stage 时间线挂 model/token/cost/耗时；项目页累计
     成本卡；
  5. 红线：Domain Event 流不塞 token/cost（eventLog 分层保留）；不上 OTel。
- **Acceptance**：M9 验收项目在 backend 重启后 trace 仍完整可查；trace 汇总与
  同窗口 runtimeStats 对账一致；前端能直接回答单次论文生成的总成本与
  top-3 昂贵 stage。
- **Demo value**：成本/时延透明是 agent 产品信任感的直接来源。
- **Interview value**：agent observability 高频题 + 真实取舍（内存环 vs 落盘、
  事件流分层、为什么不上 OTel）。
- **明确不做**：OTel/APM、日志框架、token 级明细、大屏 dashboard。

### M11 — E2E Evaluation & Regression

- **Goal**：评估能力从「安全机制拦截率」扩展到「整篇论文质量 + deep research
  效率」，形成可重复的回归基线。
- **Why now**：被评对象（真实 E2E）M9 才产出；确定性指标大部分可从既有产物
  直接计算；judge 异族化的基建（multiModel）现成。
- **Dependency**：M9（对象）、M10（cost 指标来源）；复用 `backend/src/evaluation/`。
- **子任务**：§8 决定的全部内容——E2E runner（scripted 进 CI / live 手动）、
  3–5 主题 golden dataset（期望引用池 + 结构 rubric + 预算帽）、确定性指标
  四族、异族 LLM judge + 防自嗨三件套、人工校准首批真实填数、
  `npm run evaluation` 输出 E2E 指标段。
- **Acceptance**：同主题两次 scripted run 指标逐位一致；live 报告含全部指标
  与 limitations；records.jsonl 首批 ≥ 20 条校准记录并产出一致率；
  确定性指标段进 CI（scripted）。
- **Demo value**：「这个系统被怎么验证」的完整答案。
- **Interview value**：评估方法论（judge bias 防控、deterministic-first）是
  高级岗位核心考题。
- **明确不做**：大规模数据集、自动人工评测、对外 benchmark 排名宣称、
  重构评估框架。

### M12+（条件，不预排期）

- **Research Memory**：跨 run 沉淀 coverage 历史 / gap 决策 / literaturePlan
  残差为「项目研究状态」，下一轮计划生成时注入。启动条件：M9–M11 完成且
  第二个真实研究项目开始。设计约束延续：记忆是 Derived Context 不是第二
  事实源（D-0013）。
- **Real Embedding Vendor**：触发条件=M9/M11 真实项目命中跨语言检索失败；
  实现按既有 EmbeddingProvider 抽象接 HTTP vendor；仍无 Vector DB。

---

## 12. Explicit Non-Goals（本路线明确拒绝，含理由索引）

| 项 | 理由 |
| --- | --- |
| Vector DB / 外部索引引擎 | §4.1 规模论证；D-0033 维持 |
| Python AI Service | §6 全项核对无一项成立 |
| MCP（内部） | §4.3；D-0033 |
| 自动 Model Routing / Fallback / 成本路由 | §3-F；M5.7 决策；先有 M10 遥测再谈 |
| Reranker | §5.4；规模与实测不支持成本模型 |
| Knowledge Graph / 图谱增强 | 与 SourceIdentity 精确判等 + 检索链路职责重叠；D-0034 已拒绝自动关系识别 |
| 新增 Agent 角色（含 Planner/Evidence/Loop Agent） | D-0009 红线，M6–M8 三次验证未破例必要 |
| 无人值守自主研究循环 | 产品身份是「受控」；M8 三断点是特性不是缺陷 |
| 图表/figure 生成 | research 级难题、与第一篇论文无关；Writer 宏包契约明确排除 |
| OTel / 外部 APM / 日志框架 | §7 收敛型方案已覆盖需求；引入=运维面扩大无收益 |
| 大屏 Dashboard / One-click 云端 Demo | 部署已 DONE；演示问题不按工程立项 |
| 大规模评估数据集 | 小数据 + 确定性指标是 PaperTeam 评估的差异化，不拼样本量 |
| Novelty Discovery | M8.5 §9 列为 M9 候选但本审计判定：依赖研究记忆与更深的消化层，排 M12+ 之后 |

---

## 附录：Q4–Q10 直答（Q1–Q3 见 §3.1）

- **Q4 是否需要 Vector DB？** 不需要。项目级语料规模（数百文献 / ~4k chunk /
  p95 2.6ms）下进程内 BM25+RRF 已达标且 benchmark 进 CI；引入外部引擎违反
  Derived State 纪律。重评触发条件：单项目 >10⁴ chunk 或查询延迟成真实瓶颈。
- **Q5 是否需要 Python AI Service？** 不需要（§6 逐项核对）。唯一 Python 保持
  pymupdf 提取子进程。
- **Q6 Observability 当前最缺什么？** stage 级 usage 的**持久化与关联**——
  采集已齐（AgentTask.usage/model）、但活在内存 200 条环、StageRecord 无
  usage 列、零 API 零 UI。做 M10（收敛型），不做第二套事件系统、不上 OTel。
- **Q7 Evaluation 当前最缺什么？** ①整篇论文的 E2E 评估（live 仅 Exp1 单
  环节）；②人工校准真实填数（现 0 条）；③judge 异族化（现 same-model 自知
  自标注）。全部在既有框架内扩展（M11）。
- **Q8 距离第一次 Full Paper E2E 还缺哪些最小能力？** §9 的 Step 1–6：
  前端发起入口、执行结果→候选一键衔接、全文批量激活+状态可见、锚定证据
  调研流、bibliography 确定性化、一次真实验收。其中没有任何一项需要新
  架构或新 Agent。
- **Q9 只允许再做 4 个重点方向？** ①M9 Full Paper E2E 激活；②M10 Run
  Observability & Cost；③M11 E2E Evaluation & Regression；④Research Memory
  （M12+ 条件启动）。
- **Q10 哪些能力最适合进简历且经得起追问？** §10.1 五项——前四项已存在
  （Runtime 治理 / 证据接地 / 修订安全 / 受控研究循环），第五项（E2E+成本
  可审计）由 M9+M10 兑现。共同特征：全部有测试与真实验收报告可举证，
  且每一项都附带一个可深挖的取舍题（§10.2）。
