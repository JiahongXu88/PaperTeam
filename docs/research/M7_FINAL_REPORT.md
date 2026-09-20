# M7 Research Discovery Milestone Final Report

> 日期：2026-09-20 · 状态：**M7 COMPLETE（Finalization 收口产物）**
> 收口基线：main @ `6e01180`（HEAD == origin/main，工作区 clean）
> 范围事实源：[M7_SCOPE_FREEZE.md](M7_SCOPE_FREEZE.md)（frozen，§6 定义
> M7.0 / M7.1 / M7.2 / M7.3 四个里程碑）· 决策链 D-0042（M7 范围冻结 +
> Researcher Agent + Tools）/ D-0043（M7.2 FullTextResolution）
> 性质：**纯收口文档**——零业务代码改动（本报告与各文档状态头更新）；
> 各里程碑的实现与验证证据均引用既有提交与报告，不在本文重复论证。

---

## 1. Goal — M7 为什么存在

M6 收口时的核心事实（SCOPE_FREEZE §2，磁盘佐证）：**能力组件全部就位，
但闭环从未在真实数据上跑过**。4 个真实项目 `sources/` 无 candidates.json、
chunks/index.json 空壳、`evidence/` 为空——检索被定位成「调研后的离线人工
动作」，M6 交付的 Search / Candidate / Library / Evidence 能力零真实使用。

根因是四个接线断点，不是结构缺陷：

| 断点 | 内容 | 修复归属 |
|---|---|---|
| P-A | Researcher prompt 不引导检索工具（「基于你的领域知识」） | M7.1a |
| P-B | Agent 检索结果无保存入口（候选写入率 = 0） | M7.1a |
| P-C | 前端零 discovery 消费（无检索 UI / 无候选管理） | M7.1c |
| P-D | FullTextResolver 未实现（候选转正后 metadata_only，对 verified 证据池贡献恒为零） | M7.2 |

**M7 的目标**：把这四个断点接上，让 PaperTeam 从「检索能力存在但没人用」
变成「用户研究问题驱动的真实检索-证据闭环」——User Research Question →
Researcher Agent → Discovery → Candidate（HITL）→ Literature Library →
FullText → Evidence Grounding。全部增量在 M6 冻结分层（D-0041）的空位内
叠加，零新 Agent、不动 Runtime / Workflow / 既有检索与证据架构。

---

## 2. Completed Milestones

| 里程碑 | 内容 | 提交 | 状态 |
|---|---|---|---|
| M7.0 | Scope Freeze + 细节设计 + 架构审查 + D-0042 登记 | `452b54f` / `31341d4` | ✅ 2026-09-19 |
| M7.1a | Researcher 工具激活（P-A + P-B） | `017ad31` | ✅ 2026-09-19 |
| M7.1b | 真实 Agent Discovery 验证 | `63a214b` | ✅ 2026-09-19 |
| M7.1c | Discovery & 候选管理 UI（P-C） | `fbe004d` | ✅ 2026-09-19 |
| M7.1d | PaperTeam Self Review + M8 Roadmap Proposal | `ff48c78` / `74bcf92` | ✅ 2026-09-19 |
| M7.2 | FullTextResolution（P-D，D-0043） | `aaecbef` | ✅ 2026-09-20 |
| — | Skill 生态调研（Self Review 姊妹篇） | `6e01180` | ✅ 2026-09-20 |
| M7.3 | Research Intelligence | 方向冻结、细节延后（by design） | ➡️ 并入 M8 |

### M7.0 — Scope Freeze（轻量决策收口）

冻结文档（做什么 / 不做什么 / 分几步 / 验收什么）+ M7.1 细节设计
（[M7.1_WEB_SEARCH_DESIGN.md](M7.1_WEB_SEARCH_DESIGN.md)，proposed →
accepted）+ 独立源码复核（[M7.1_ARCHITECTURE_REVIEW.md](M7.1_ARCHITECTURE_REVIEW.md)，
确认「能力齐了但没接线」判断与源码一致）+ D-0042 登记（Researcher Agent +
Tools，不新增 Search / Planner Agent）。零业务代码。

### M7.1a — Researcher Tool Activation（P-A + P-B 修复）

- **P-A**：ResearcherService prompt 重写为检索优先——要求先
  search_papers / lookup_paper，禁止凭记忆断言文献；literaturePlan 语义
  调整为「检索后残差」；evidence 规则一字不动；analyzeExistingPaper 同步
  （「可用」而非「必须」——不强制检索）。
- **P-B**：新增 `save_candidates` 工具——服务端检索缓存按下标回放
  （LRU ≤5/query / TTL 10min / ≤25 条/次），Agent 无法按值伪造元数据
  入库；与 HTTP `saveAsCandidates` 汇聚同一保存函数。
- 缓存护栏测试 21 例。零 Runtime / Workflow / SearchService 架构改动
  （工具经既有 roleCustomTools 通道注入）。

### M7.1b — Real Agent Discovery Validation（真实端到端验证）

真实模型 + 真实公网检索三场景验证（详 §4）：38 次工具调用 0 错误、
12 次 save_candidates、21 条候选落盘全部 pending_review。报告
[M7.1_DISCOVERY_VALIDATION.md](M7.1_DISCOVERY_VALIDATION.md)。
零业务代码改动（验证产物 + 一次性脚本）。

### M7.1c — Candidate Management UI（P-C 修复）

前端 Discovery 面板（学术检索表单 + 结果列表 + 勾选保存候选）+ 候选
管理（accept / reject / promote 一键转正）+ API contract 扩展 + e2e
discovery spec。零后端行为改动。

### M7.1d — PaperTeam Self Review（用自身能力做外部对照）

用 PaperTeam 自身 Research Discovery 工具面（17 次学术检索 170 条结果 /
2 次 Web 检索 / 3 次查证 / 12 条候选）调研外部 AI Research Agent /
Deep Research 系统（OpenAI / Claude / Gemini Deep Research、AI Scientist、
PaperQA、STORM、Elicit 等）。核心结论：**PaperTeam 的差异化不在检索能力
而在证据纪律**（Retrieved ≠ Verified ≠ Grounded 类型级不变量 + 机械三段
核验，为全部对照系统所无）；最大缺口是**检索纵深**（单轮 / 无预执行研究
计划 / Web 检索未开箱）。产出
[PAPERTEAM_SELF_REVIEW_M7.md](PAPERTEAM_SELF_REVIEW_M7.md) 与
[M8_ROADMAP_PROPOSAL.md](M8_ROADMAP_PROPOSAL.md)。零业务代码改动。

### M7.2 — FullTextResolution（P-D 修复，D-0043）

Literature → FullText → Evidence 自动闭环（详 §3 架构与 §5 决策）：
FullTextResolver 三实现（Unpaywall(DOI) / OpenAlex oa-url / arXiv PDF，
确定性链序）+ `ProviderHttpClient.fetchBytes` 二进制通道 +
`SourceStore.attachFile` 同条目原地补挂 + `tryResolveFullText` 五结局
数据化编排（有界 ≤3×1，无自动循环）+ promote 尾部后台单次尝试 + 手动
重试端点。license / resolver / attempts provenance 落盘可审计。设计
[M7.2_IMPLEMENTATION_PLAN.md](M7.2_IMPLEMENTATION_PLAN.md)；测试 +70，
全量 1333 后端 + 210 前端零回归。

### Skill 生态调研（Self Review 姊妹篇）

聚焦**可接入的 Skill / MCP 生态**（Self Review 聚焦外部系统，二者互补）：
五类候选（写作 / 综述 / 评审 / 风格归一化 / Research Agent）分级推荐——
P0 全部为「读与借鉴」级（零代码依赖），明确拒绝检测器与绕检测器类。
报告 [PAPERTEAM_SKILL_DISCOVERY.md](PAPERTEAM_SKILL_DISCOVERY.md)。
零代码改动、零 Skill 安装。

### M7.3 — Research Intelligence（按冻结延后）

SCOPE_FREEZE §6 对 M7.3 的定义即「方向冻结、细节延后」，启动前置是
M7.1 + M7.2 的**真实使用数据**（候选量 / promote 率 / 全文覆盖率 /
检索-证据转化率）——该数据依赖 M8.1 观测基建。故 M7.3 不是 M7 的未完成
项，而是设计内的移交：其「Evaluation live 扩展」与「Reference Paper
Intelligence」维度由 [M8_ROADMAP_PROPOSAL.md](M8_ROADMAP_PROPOSAL.md)
吸收具体化（M8.5 / M8.3 引证网络 / M8.6 研究 wiki）。

---

## 3. Final Architecture — Research Discovery 闭环（M7 收口形态）

```text
User Research Question（项目 researchIdea）
  ↓ research.idea stage — ResearcherService prompt（M7.1a：检索优先，
    禁止凭记忆断言文献；不强制检索——分析型任务允许直接分析）
Researcher Agent（唯一新增行为的角色；零新 Agent 角色）
  ↓ search_papers / search_web / lookup_paper（M6.3 既有工具面）
  ↓ save_candidates（M7.1a 新增：服务端缓存按下标回放，不可按值伪造）
ResearchDiscoveryService（M6.3 既有编排，零改动）
  ↓ OpenAlex / Semantic Scholar / arXiv / AMiner（+ SearXNG 可选）
  ↓ identityKey 去重 + 加权 RRF 融合 + 进程内检索缓存（LRU/TTL）
CandidateStore — sources/candidates.json（pending_review）
  ↓ 用户 promote（HITL 单点，幂等；M7.1c 前端一键转正；零自动转正）
Literature Library — SourceStore
  ↓ M7.2 tryResolveFullText（promote 尾部后台单次尝试 + 手动重试端点）
  ↓ FullTextResolver：Unpaywall(DOI) → OpenAlex oa-url → arXiv PDF
  ↓ downloadPdf 护栏：SSRF 逐跳校验 / ≤5 跳 / ≤20MB 流式截断 / %PDF- 魔数
  ↓ attachFile 同条目原地补挂（sourceType→pdf；chunk 锚点链单线闭合）
Retrieval — SourceChunker → ChunkStore（metadata_only 红线：无全文不 chunk）
  ↓ retrieve_library / get_chunk
Evidence Pipeline — EvidenceGroundingService（三段核验，唯一写入口）
  ↓ quote 逐字 / metadata 权威 / 语义 judge
EvidenceStore — verified（sourceId + chunkId 锚点三件套）
  ↓ Writer / Reviewer / Quality Gate（formalOnly 视图，M6.6 既有）
```

**闭环状态**：链路上每一跳均有真实交付与验证（Agent 侧真实模型验证
§4；全文侧离线验收链测试）。尚未在**真实用户项目**上从问题走到 verified
磁盘证据（遗留项 ①，见 §7）。

**红线全部维持**（M7 全程零违反）：零新 Agent；Runtime / Workflow
definitions / research.json schema 零改动；候选必经用户 promote（HITL）；
discovery 工具面零 EvidenceStore 写路径；snippet 永不进 chunk；检索默认
零持久化（显式保存例外）；无 Memory / Planner / 爬虫 / Vector DB / RAG
重构。

---

## 4. Validation Evidence

### 4.1 真实 Agent 验证（M7.1b，2026-09-19）

| 项 | 值 |
|---|---|
| 模型 | `zai-coding-cn/glm-5.3`（产品解析链真实结果：settings/model.json → auth.json，与 `npm run dev` 同源） |
| Provider / Runtime | Pi in-process（`@earendil-works/pi-coding-agent`，唯一正式 Runtime，D-0020）；真实公网调用 OpenAlex（primary）/ Semantic Scholar / arXiv，零 mock |
| 装配 | 驱动脚本与 `backend/src/index.ts` 完全同源（loadConfig / SkillRegistry / roleCustomTools / buildServiceStack），仅 PROJECTS_ROOT 重定向临时目录 |

三场景结果（[报告](M7.1_DISCOVERY_VALIDATION.md) §3-§4）：

| 场景 | 形态 | 工具调用 | 候选落盘 | 关键结论 |
|---|---|---|---|---|
| A 新领域调研（2024-2026 Transformer MOT） | research.idea 主链路 | 24 次 / 0 错误（含 9 次自主多角度 search_papers + 11 次 save_candidates） | 15 条，全部 pending_review | literaturePlan 呈纯残差语义（「本轮仅间接命中 MOTRv2，需人工补充」） |
| B 事实验证（ByteTrack 年份） | research.idea | 6 次 / 0 错误（检索 + 3 次 lookup 核验） | 6 条 | **检索优先成立**：未凭记忆作答，引 DOI 区分预印本（2021 arXiv）与正式版（2022 ECCV），「经元数据核验确认为 2022」；双身份分别保存（D-0034 设计验证） |
| C 已有论文分析 | analyzeExistingPaper | 8 次 / 0 错误（按需查证 5 次） | **0 条** | **不强制检索成立**：分析主体锚定项目上下文，未为检索而检索，零候选污染 |

- **可靠性**：38 次工具调用 0 错误；SearXNG 未配置时 `search_web` 返回
  not_configured（产品如实形态），Agent 未误用。
- **候选流**：12 次 save_candidates / 21 条候选全部 pending_review +
  origin/provider/query provenance 完整；零自动转正。
- **成本**：三场景合计 $0.320（63k input / 24k output / 479k cacheRead）。
- **复现**：`node scripts/m71-discovery-smoke.mjs`（约 8 分钟，不进 CI）。

### 4.2 全文链离线验收（M7.2，2026-09-20）

测试钉死完整验收链（`aaecbef`，+70 测试）：promote → 后台 resolve →
`status=available` + chunks 落盘 → `retrieve_library` 检索命中 →
`get_chunk` 回取；五结局（resolved / not_found / failed / skipped_has_file /
not_resolvable）各自如实落盘不阻塞；SSRF / 重定向 / 20MB 截断 / PDF 魔数
护栏矩阵；license provenance 审计字段。

### 4.3 回归基线

| 时点 | 后端 | 前端 |
|---|---|---|
| M7.1a 收口 | 1263 passed / 0 failed（11 skipped live smoke） | — |
| M7.1b 收口（零代码改动复验） | 1263 passed / 0 failed | — |
| **M7.2 收口（M7 最终基线）** | **1333 passed / 0 failed** | **210 passed / 0 failed** |
| **M7 Finalization（本报告，docs-only，HEAD `6e01180` 复跑）** | **1333 passed / 0 failed**（11 skipped live smoke；首轮并行执行出现 4 例 workflow 修订环 flaky，同 HEAD 立即复跑全绿，非回归） | **210 passed / 0 failed** |

### 4.4 遗留（如实声明，非 blocker）

M7.1 验收底线 1 的后半段——**真实项目**磁盘上出现可逐级追溯的 verified
证据（verified ← chunk ← library ← promote ← candidate ← discovery）——
尚待真实项目走通。Agent 侧（M7.1b）与全文自动获取（M7.2）均已分别验证，
链路具备自动形态；此项同时是 M8.1 Discovery Observability 的数据前置，
作为 M8 输入记录（§7）。

---

## 5. Major Design Decisions

| # | 决策 | 内容与理由 | 登记 |
|---|---|---|---|
| 1 | **不新增 Research / Search / Planner Agent** | 检索编排在确定性服务层（provider 选择 / 融合 / 去重 / 降级全是代码），query 生成是 Researcher 既有职责；D-0009（角色最小化）+ D-0041 + D-0042 三重冻结，M7.1 设计稿五条论证维持 | D-0042 |
| 2 | **Candidate 作为人工审核边界** | 检索结果只进 `pending_review` 候选（Discovery State），转正唯一入口是用户 promote（幂等，HITL）；save_candidates 经服务端缓存按下标回放——Agent 提案无法伪造元数据直接入库；M7 全程零自动转正 | D-0034 / D-0035 / D-0042 |
| 3 | **Search 结果不直接进入 Evidence** | snippet 最多 plausible，verified 只经三段核验管道（quote 逐字 + metadata 权威 + 语义 judge）；discovery 工具面零 EvidenceStore 写路径（测试钉死）；检索默认零持久化，显式保存是唯一例外 | D-0033 / D-0035 / D-0037 |
| 4 | **Evidence-first 原则保持** | Retrieved ≠ Verified ≠ Grounded 类型级不变量全程未动；正式证据 = verified + sourceId + chunkId 三件套；M7.1b 观察到的 abstract 级 legacy unverified 条目因无 chunk 锚点永不进 formal 池（兼容期路径，风险受控） | D-0037 / D-0038 |
| 5 | **全文挂 Literature 条目生命周期层（attach-to-existing）** | FullTextResolver 挂 SourceStore/SourceImportService（条目生命周期层），不挂 Retrieval / Evidence（下游派生与消费层）；同条目原地补挂使 chunk 锚点链单线闭合（N-1 锚点断裂在自动路径根除）；下载护栏（SSRF 逐跳 / ≤5 跳 / ≤20MB / PDF 魔数）+ 有界重试 ≤3×1 无自动循环；无 OA 身份的 Web 候选永远 metadata_only——定位不是缺陷 | D-0043 |

---

## 6. Lessons Learned

1. **「能力就绪 ≠ 能力使用」，接线是独立交付物**。M6 交付了八项能力组件，
   真实使用率为零；M7 的工作量几乎全在 prompt 措辞、一个保存工具、一个
   前端面板和一个 resolver——每项都不「难」，但缺任何一项闭环就不存在。
   冻结文档的「四断点」分析法（能力清单 × 磁盘实况对照）值得复用。
2. **Web Search 能力边界**：学术三源（OpenAlex / S2 / arXiv）零配置开箱
   可用，是 M7 验证能跑通的地基；SearXNG 未配置时结构化 not_configured、
   不阻塞不伪造——「optional 能力如实降级」经受住了真实 Agent 使用
   （模型在 A/B 场景自动避开 search_web）。开箱化（compose 默认含
   SearXNG）是部署面小事，留 M8.2。
3. **真实 Agent 验证的价值**：架构审查标记的最大风险「prompt 引导 ≠
   模型必然调用工具」只有真跑才能证伪——GLM-5.3 三场景行为与 prompt
   约束高度一致，且「不强制检索」同样成立（C 场景零候选污染）。38 次
   调用 0 错误的可靠性、$0.32 的单轮成本，为 M8 多轮检索的预算设计提供
   了实测锚点。
4. **Skill 生态调研发现**：科研类 Skill 生态的真实可用形态是「方法论
   文本」（K-Dense 证据化写作 / WenyuChiou 扩展大纲 / Anti-Autoresearch
   审计词表），不是即插即用的能力包；接入三原则——Evidence-first 不变、
   HITL 不变、确定性编排不变——Skill 只增强能力面，不能定义什么是证据、
   不能跳过人工决策点、不能替代 Gate。模型族敏感（多为 Claude/Codex
   写就）与「未经证实的声明」（须先进 evaluation A/B）是两条硬边界。
5. **Research Agent 下一阶段方向**：对照全部外部系统后，PaperTeam 不追
   「无人值守长循环自动报告」（AI Scientist 路线）与「竞争性多 agent
   辩论」（Co-Scientist 路线）——与「研究者的证据工作台 + HITL」定位
   相反；DR 产品的引用无核验层，恰是 PaperTeam 已被 M6.9 五模型族评估
   证明的强项。要追赶的是**纵深与可度量**：研究计划、受控多轮、发现
   可观测（M8 候选，每个都带数据门槛的进入/不进入条件）。

---

## 7. M8 Input

下一阶段主题（提案）：**M8 — Research Intelligence**——把 PaperTeam 从
「单轮检索 + 人工驱动」升级为「计划驱动、可度量、证据复利」的研究调研
工作台（不改变 HITL 定位、不新增 Agent、不追无人值守长循环）。完整提案：
[M8_ROADMAP_PROPOSAL.md](M8_ROADMAP_PROPOSAL.md)（proposed，M8.0 须照
M7 流程先做 Scope Freeze + DECISIONS 登记）。

**M7 移交 M8 的事项**（均非 M7 blocker）：

| # | 事项 | 来源 | M8 去向 |
|---|---|---|---|
| 1 | 真实项目磁盘证据全链走通（promote → 全文 → verified，验收底线 1 后半段） | M7.1 验收 | M8.0 数据输入 + M8.1 前置 |
| 2 | Discovery Observability（候选量 / promote 率 / provider 健康 / query 多样性统计） | Self Review P0-3 | **M8.1（建议第一步，地基）** |
| 3 | Web Search 开箱可用（SearXNG compose 默认 + doctor） | Self Review P0-1 | M8.2（可并行） |
| 4 | Research Plan 一等产物 + 引证网络透传 | Self Review P1-1/P2-2 | M8.3（M8.1 数据 gate） |
| 5 | 受控多轮检索循环（计划驱动、有界、结果仍只进 pending 候选） | Self Review P1-2 | M8.4（依赖 M8.3） |
| 6 | Discovery 评估场景 Exp4（命中率 / 排序质量） | Self Review P1-4 | M8.5 |
| 7 | Verified 证据综合视图「研究 wiki」 | Self Review P2-1 | M8.6（长期，独立设计冻结） |
| 8 | M7.3 Research Intelligence（Reference Paper Intelligence + Evaluation live 扩展） | SCOPE_FREEZE §6 方向冻结 | 被 M8.5 / M8.3 / M8.6 吸收 |
| 9 | Skill P0「读与借鉴」动作（K-Dense 精读、扩展大纲、审计词表映射）与 M7.2 延伸（arXiv LaTeX 源 quote 精度通道） | Skill Discovery §6-§7 | 按 M8 提案流程登记后排期 |
| 10 | 小项：fullText 状态前端展示 / 一键重试（M7.2 R-6）、手动上传补挂端点（R-5） | M7.2 开放项 | backlog，按需排期 |

**M8 入口建议**：先在真实项目上走通一次 §4.4 遗留链路（产生第一批
真实 promote / 全文 / 证据数据），随后 M8.0 Scope Freeze（裁剪
M8_ROADMAP_PROPOSAL 至冻结版）+ DECISIONS 登记，M8.1 Observability
作为第一步落地。

---

## 附：M7 文档地图（收口后状态）

| 文档 | 状态 |
|---|---|
| [M7_SCOPE_FREEZE.md](M7_SCOPE_FREEZE.md) | frozen → 已执行完毕（M7.0–M7.2 交付，M7.3 并入 M8） |
| [M7.1_WEB_SEARCH_DESIGN.md](M7.1_WEB_SEARCH_DESIGN.md) | accepted；§7 改动集全部落地（M7.1a/b/c） |
| [M7.1_ARCHITECTURE_REVIEW.md](M7.1_ARCHITECTURE_REVIEW.md) | accepted；§6 方案已实施并验证 |
| [M7.1_DISCOVERY_VALIDATION.md](M7.1_DISCOVERY_VALIDATION.md) | ✅ 完成（全链路端到端成立） |
| [PAPERTEAM_SELF_REVIEW_M7.md](PAPERTEAM_SELF_REVIEW_M7.md) | ✅ 完成（M7.1d 研究产物，时点快照） |
| [PAPERTEAM_SKILL_DISCOVERY.md](PAPERTEAM_SKILL_DISCOVERY.md) | ✅ 完成（调研产物，时点快照） |
| [M7.2_IMPLEMENTATION_PLAN.md](M7.2_IMPLEMENTATION_PLAN.md) | implemented（`aaecbef` 全量落地） |
| [M8_ROADMAP_PROPOSAL.md](M8_ROADMAP_PROPOSAL.md) | proposed（硬前置 M7.2 已满足，待 M8.0 freeze） |
| 本文 | M7 Finalization 收口产物 |
