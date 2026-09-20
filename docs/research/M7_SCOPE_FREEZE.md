# M7 Scope Freeze & Implementation Boundary — Research Discovery Activation

> 日期：2026-09-19 · 状态：**frozen（M7 正式开始前的范围与边界冻结）→
> 已执行完毕（2026-09-20 收口：§6 M7.0–M7.2 全部交付，M7.3 按本冻结
> 「方向冻结、细节延后」并入 M8 候选；终报见
> [M7_FINAL_REPORT.md](M7_FINAL_REPORT.md)）**
> 基线：main @ `3078947`（HEAD == origin/main，工作区 clean；Pre-M7 Product
> Readiness 收口完成）· 架构冻结：D-0041（M6）· M7.1 细节设计：
> [M7.1_WEB_SEARCH_DESIGN.md](M7.1_WEB_SEARCH_DESIGN.md)（accepted，M7.0 升版）
> 性质：**只读分析产物，零业务代码改动；本文冻结 M7 做什么 / 不做什么 /
> 分几步做 / 每步验收什么**。M7 实现开始后，变更须走 DECISIONS.md 登记。

---

## 0. Executive Summary

1. **M6 交付的能力组件全部就位**（服务层 / Provider / 候选 / 文献库 /
   Evidence / Researcher 工具，逐项经源码与磁盘验证，见 §2 Capability Map），
   架构无需返工（D-0033/D-0035/D-0041 零重开）。
2. **缺的不是能力，是接线**。四个断点把「检索 → 候选 → 转正 → 证据」的
   闭环切断：P-A（Researcher prompt 不引导检索工具）/ P-B（Agent 无候选
   保存入口）/ P-C（前端零消费）/ P-D（FullTextResolver 未实现）。
   真实项目磁盘实况佐证：4 个真实项目 `sources/` 无 candidates.json、
   chunks/index.json 为空壳（`{"entries": {}}`）、`evidence/` 空——
   discovery→library→evidence 写路径**从未在真实数据上跑过**。
3. **M7 = 把已冻结的分层接成真实闭环**：User Research Question →
   Researcher Agent → Search Tool → CandidateSource → Literature Library →
   Evidence Grounding。核心交付 M7.1（最小接线，三断点修复）+ M7.2
   （FullTextResolution，补第四断点）；M7.0 是轻量决策收口，M7.3 方向
   冻结、细节延后（须以 M7.1 真实使用数据为输入）。
4. **八项红线全部维持冻结**（§5）：零新 Agent、不动 Runtime / Workflow /
   不做 Memory / Planner / 浏览器自动化 / Vector DB / RAG 重构。

---

## 1. Git 状态（2026-09-19 冻结时点）

| 项 | 值 | 判定 |
|---|---|---|
| 分支 | `main` | ✅ |
| HEAD | `3078947c204a97e319c6fe29d841d93fed117d7c` | ✅ |
| origin/main | `3078947c204a97e319c6fe29d841d93fed117d7c` | ✅ 同步 |
| 工作区 | clean（`git status --short` 空） | ✅ |

基线即 Pre-M7 Product Readiness 收口提交（README / docs / screenshots
更新完成）。M7 全部工作自此基线起步。

---

## 2. Current Capability Map（M6 完成后真实能力边界）

### 2.1 组件清单（全部经源码确认）

| # | 能力 | 载体（backend/src/） | 状态 | 真实使用 |
|---|---|---|---|---|
| 1 | Search Service | `search/researchDiscoveryService.ts`（唯一编排入口）+ `academicSearchService.ts` / `webSearchService.ts` | ✅ 就绪 | ❌ 主链路未用 |
| 2 | Academic Search Provider | OpenAlex（primary）/ Semantic Scholar（fallback+enrichment）/ arXiv（preprint）/ AMiner（China secondary）+ SearXNG（Web，optional）+ 共享 `providerHttp.ts`（超时/退避/熔断/四态健康）+ `fusion.ts`（identityKey 去重 + 加权 RRF） | ✅ 就绪（1545 行测试） | ❌ 仅 HTTP 直调可达 |
| 3 | CandidateSource | `sources/CandidateStore.ts`：pending_review → accepted/rejected 状态机，identityKey 分层判重（doi > arxiv > pmid > 标题指纹 > url），rejected 不判重 | ✅ 就绪 | ❌ 写入率 = 0 |
| 4 | Literature Library | `sources/SourceStore.ts` + `SourceImportService.ts`：PDF / DOI / arXiv / URL / BibTeX 五入库路径 + `promoteCandidate`（幂等，origin=AGENT_RETRIEVED，无全文 → metadata_only） | ✅ 就绪 | ⚠️ 仅 PDF 上传用过 |
| 5 | Evidence Pipeline | `evidence/EvidenceGroundingService.ts`（三段核验：quote 逐字 / metadata 权威 / 语义 judge）+ `EvidenceStore`（grounded 写入唯一入口 appendBatch）+ `EvidenceSelectionService`（正式证据 = verified + sourceId + chunkId） | ✅ 就绪（M6.8/M6.9 评估验证） | ❌ 真实项目 evidence/ 为空 |
| 6 | Researcher Agent tools | `skills/scholarlyTools.ts`：`search_papers` / `search_web` / `lookup_paper`（已注入 researcher + citation 角色，`index.ts:156`）+ `retrieve_library` + `get_chunk` / `propose_evidence` / `evidence_query` | ✅ 工具已注册 | ❌ prompt 零引导（P-A） |
| 7 | Retrieval / RAG | `retrieval/`：SourceChunker（section-aware，metadata_only 一律 skipped）+ ChunkStore + BM25/dense hybrid | ✅ 就绪 | ⚠️ index.json 空壳 |
| 8 | Workflow 编排 | `workflow/definitions.ts`：research.idea（:2000）→ evidence.ground（:2040）→ research.feasibility（:2071） | ✅ 冻结（M6 全程未动） | ✅ 真实跑过 |

### 2.2 闭环断点（为什么「能力齐了但闭环没通」）

| 编号 | 断点 | 验证依据 | 修复归属 |
|---|---|---|---|
| P-A | Researcher 任务 prompt 仍写「基于项目文献库与**你的领域知识**」（`ResearcherService.ts:385`），通篇无 search 工具引导——工具在白名单但主链路事实不用，检索被定位成调研后的离线人工动作（literaturePlan） | 源码逐行确认 | **M7.1a** |
| P-B | Agent 检索结果无法保存为候选：`scholarlyTools.ts` 无保存工具，显式入口只有 HTTP `saveAsCandidates`（用户手动） | 源码 + `researchDiscoveryService.ts` 保存函数唯一性确认 | **M7.1a** |
| P-C | 前端零 discovery 消费：`frontend/src` grep `academic-search / web-search / discovery` 零匹配；e2e 无 discovery spec（9 个 spec 均无） | grep + e2e/tests 清单确认 | **M7.1b** |
| P-D | FullTextResolver 未实现（D-0033 六层唯一缺层）：discovery 候选 promote 后 metadata_only → chunker 跳过 → 检索不到 → 无法锚定 → **对 verified evidence 池贡献恒为零** | `backend/src/search/` 无 resolver；chunker 红线确认 | **M7.2** |

磁盘佐证（`backend/projects/`，4 个真实项目）：`sources/candidates.json`
不存在、`sources/chunks/index.json` 空壳、`evidence/` 目录空、
`research/research.json` 有真实产出——**Agent 跑过、检索链路零使用**。
这不是独立断点，是 P-A+P-B+P-C 叠加的必然结果（M7.1 设计稿 §2.6 同判）。

### 2.3 已验证的安全资产（M7 不得触碰的既有成果）

- 不变量链 `Retrieved ≠ Verified ≠ Grounded`（类型 / 装配 / 测试三重钉死）；
- Evidence 写入单点（appendBatch）；候选转正单点（promoteCandidate，HITL）；
- 三段核验零捏造泄漏（M6.9 五模型族 live 验证：Arm A 25/25 fabricated，
  Arm B 0 泄漏）；
- Revision Safety 状态机 + Revision Gate（M6.7）；
- Scripted + live 双评估框架，评估只读被测系统（M6.8/M6.9）。

---

## 3. M7 目标：Research Discovery Activation

**核心目标**：让 PaperTeam 从「检索能力存在但没人用」变成「用户研究问题
驱动的真实检索-证据闭环」：

```text
User Research Question（项目 researchIdea）
  ↓ research.idea stage（prompt 已接线，P-A 修复）
Researcher Agent
  ↓ search_papers / search_web / lookup_paper
Search Tool（既有 scholarlyTools）
  ↓ ResearchDiscoveryService（既有编排：4 学术源 + optional SearXNG + 融合）
  ↓ save_candidates（P-B 修复：Agent 会话内显式保存，服务端缓存按下标，
    与 HTTP 入口汇聚同一保存函数）
CandidateSource（既有 CandidateStore：pending_review，HITL 待审）
  ↓ 用户 promote（既有幂等链路，前端补 UI = P-C 修复）
Literature Library（既有 SourceStore）
  ↓ M7.2 FullTextResolver（P-D 修复：Unpaywall/arXiv/OA-URL → PDF 管线）
  ↓ 用户上传全文（既有路径，M7.1 阶段即闭环依赖）
Evidence Grounding（既有三段核验 → verified）
  ↓ Writer / Reviewer / Quality Gate 消费（既有）
```

**成功判据（M7 整体）**：任一真实项目，用户只输入研究问题，最终在
`evidence/evidence.jsonl` 出现 ≥1 条 verified 证据，且其 source 可逐级
追溯：verified ← chunk ← library ← promote ← candidate ← discovery 检索。
修复 §2.2 的「零真实使用」事实。

---

## 4. M7 做什么（最小改动集）

M7.1 的全部增量（细节以 [M7.1 设计稿](M7.1_WEB_SEARCH_DESIGN.md)为准，
本文只冻结范围）：

| 项 | 改动 | 触点 | 规模 |
|---|---|---|---|
| 1 | **Researcher prompt 接线**：要求 1 重写为检索优先 + 禁止凭记忆断言文献；新增 save_candidates 指引；literaturePlan 语义调为「检索后残差」；evidence 规则（要求 3）一字不动；analyzeExistingPaper 同步 | `ResearcherService.ts`（纯字符串） | 小 |
| 2 | **save_candidates 工具**：方案 B（服务端检索缓存 + 下标），复用既有 saveAcademic/WebCandidates，LRU ≤5/query、TTL 10min、≤25 条/次、miss 结构化报错 | `scholarlyTools.ts`、`researchDiscoveryService.ts` | 中 |
| 3 | **候选缓存护栏测试**：LRU / TTL / miss / 越界 / 量上限 | `backend/test/search/` | 小 |
| 4 | **前端 Discovery & 候选管理 UI**：检索表单 + 结果列表 + 勾选保存 + 候选清单（accept/reject/promote）+ SearXNG 未配置引导；e2e 补 discovery.spec.ts | `frontend/src`（零后端改动） | 中 |

**边界内不扩**：不改 workflow definitions（保存发生在 Agent 会话内，
无新 stage）；不改输出契约（research.json schema 零变化）；不加自动
promote（转正永远 HITL）；单轮调研（不做自动补检索循环，见 §7 开放项）。

---

## 5. M7 不做什么（冻结红线，逐项理由）

| # | 禁止项 | 原因 |
|---|---|---|
| 1 | **新 Agent 角色** | D-0009（角色最小化）+ D-0041（M6 冻结重申）双重决策；检索编排在确定性服务层（provider 选择/融合/去重/降级全是代码），query 生成是 Researcher 既有职责（ADR §10），无独立 LLM 决策面；M7.1 设计稿 §6 五条论证维持 |
| 2 | **Runtime 重构** | 工具经既有 roleCustomTools 回调注入（`index.ts:156` 模式已验证），save_candidates 同通道；Runtime 零改动即可满足全部 M7.1 需求 |
| 3 | **Workflow 大改** | research.idea → evidence.ground → research.feasibility 序列（definitions.ts:2000/2040/2071）位置正确；候选落盘与 stage 产物本就分离关注点，保存动作无需新 stage；M6 全程不动 workflow 的纪律延续 |
| 4 | **Memory 系统** | M7.1 检索缓存是进程内 derived（LRU/TTL，不落盘，重启即失），D-0013 文件优先三层状态不变；把它做成持久记忆系统 = 范围失控 + 与「检索默认零持久化」红线冲突 |
| 5 | **Planner 系统** | 检索策略（何时搜、搜什么）由 Researcher prompt 承担；引入独立 Planner 是为 M7.1 尚不存在的「多轮自主调研」过度设计（真实使用数据未到，见 §7 开放项） |
| 6 | **Browser automation / 爬虫兜底** | D-0033 §9 拒绝项维持：脆弱、重、维护成本高（agent-search WebFallback 教训）；Web 候选定位是**线索**（用户人工获取全文），不做抓取 |
| 7 | **Vector DB** | D-0036 冻结：进程内 BM25 + 可选 dense + RRF hybrid，零外部索引服务；M7.2 的全文入库走既有 chunker，不改检索架构 |
| 8 | **RAG 重构** | M6.4 分层（RetrievalService / ChunkStore / hybrid）经 M6.8/M6.9 评估验证有效；FullTextResolver 只是给 chunker **喂更多全文**，不动 chunk 化与检索本身 |

**通用原则**：M6 冻结分层（D-0041）不再改动，M7 一律在其空位内叠加。
任何超出本表的改动须先在 DECISIONS.md 登记并说明为什么冻结决策不再成立。

---

## 6. M7 Milestones

### M7.0 — Scope Freeze 收口（轻量，不写功能代码）

- **目标**：本冻结文档生效；M7.1 设计稿升版 accepted；决策链登记。
- **修改范围**：`DECISIONS.md`（登记 D-0042：M7 范围冻结 + M7.1 接入
  收口决策）；M7.1 设计稿状态头 proposed → accepted；`PROJECT_STATUS.md`
  M7 段更新。
- **不修改范围**：全部业务代码 / 测试 / 前端。
- **验收标准**：① D-0042 登记内容与本文一致；② 全量测试绿（基线验证，
  零改动故应零变化）；③ 本文档与 M7.1 设计稿无相互矛盾。

### M7.1 — Research Discovery Activation（核心交付，M7 的主体）

- **目标**：修复 P-A / P-B / P-C，打通 §3 闭环（全文依赖用户手动上传，
  即既有路径）。
- **修改范围**：§4 四项——ResearcherService prompt（字符串）、
  scholarlyTools + researchDiscoveryService（save_candidates + 缓存）、
  backend/test/search（护栏）、frontend discovery UI + e2e。
- **不修改范围**：Runtime / Workflow definitions / Evidence Pipeline /
  Retrieval / CandidateStore 状态机 / promote 链路 / research.json schema
  / 既有 1545 行 search 测试语义。
- **验收标准**（= M7.1 设计稿 §7.4 全局底线，任何一条不过即未完成）：
  1. **真实项目端到端**：某真实项目从 research.idea 起，磁盘真实出现
     candidates.json → index.json（≥1 条 AGENT_RETRIEVED）→ chunks/
     *.jsonl（手动上传全文）→ evidence/candidates.jsonl → evidence.jsonl
     （≥1 条 verified，source 追溯到 discovery 候选）；
  2. 红线回归全绿：discovery 链路无 EvidenceStore 写路径；snippet 永不
     进 chunk；候选必经用户 promote；
  3. 全量后端测试 + 前端 e2e 零回归。
- **内部切分**：M7.1a（后端接线，P0）→ M7.1b（前端 UI，P1），见设计稿 §7。

### M7.2 — FullText Resolution（补 P-D，独立验收）

- **目标**：discovery 候选转正后自动获取合法开放获取全文，把「手动上传」
  变「自动解析」，discovery 结果获得通往 verified evidence 的完整路径。
- **修改范围**：`backend/src/search/` 新增 FullTextResolver 三实现
  （Unpaywall(DOI) / ArxivPdf(arxivId) / OaUrl(OpenAlex oa_url)，接口形状
  即 ADR §12 冻结稿）；`SourceImportService.tryResolveFullText`（promote
  后台尝试 + 手动重试端点）；下载 PDF 走既有 importPdf 管线（contentHash
  判重 + chunk 签名自动刷新）；license/来源落 provenance；ADR §3 Crossref
  节点勘误（文档）。
- **不修改范围**：ProviderHttpClient 之外不引入新 HTTP 基建（resolver 复用
  之）；chunker / 检索 / Evidence 核验零改动；不做爬虫兜底（Web 候选
  identity 无 DOI/arXiv → 永远 metadata_only，这是定位不是缺陷）。
- **验收标准**：① 真实项目：一篇有 OA 全文的文献，promote 后无人工干预
  到达 `status=available` + chunks 落盘 + `retrieve_library` 可检索到；
  ② 无 OA 文献保持 metadata_only，如实记录，不报错不阻塞；③ license
  provenance 落盘可审计；④ 下载失败重试语义确定（不无限重试）；
  ⑤ 全量测试零回归。
- **启动前置**：M7.1 验收通过（挂接点设计已冻结，实现不依赖 M7.1 代码
  细节，但验收场景依赖真实候选存在）。

### M7.3 — Research Intelligence（方向冻结，细节延后）

- **目标**（方向级）：已入库文献的深度利用——Reference Paper
  Intelligence（M6+ backlog 既有项：文献对比 / gap 结构化 / 引证网络
  摘要等形态待细化）+ Evaluation live 扩展（多场景 / 异模型 judge /
  Exp2-Exp3 live 化，M6 FINAL_SUMMARY §4 方向 1）。
- **修改范围**：**待细化**——M7.3 进入前必须先出独立设计文档并冻结
  （复用本流程），本文只冻结「它是 M7 的下一站候选，不是现在做」。
- **不修改范围**：同 §5 八项红线（在 M7.3 设计时重申）。
- **验收标准**：M7.3 验收标准在其入口设计冻结时定义（本阶段不预设）。
- **启动前置**：M7.1 + M7.2 产生真实使用数据（候选量、promote 率、
  全文覆盖率、检索-证据转化率）——M7.3 的取舍必须以这些数据为输入，
  防止无数据支撑的过度设计。

---

## 7. 风险与开放问题（继承 M7.1 设计稿 §8，M7 层面增补）

| # | 项 | 处置 |
|---|---|---|
| 1 | save_candidates 滥存 / 缓存 miss 重试循环 / research.idea 时延上升 | M7.1 设计稿 §8-1/2/3 缓解措施照建（硬帽 + 结构化指引 + 时延提示） |
| 2 | M7.2 新增网络下载面（二进制 PDF、license 合规、大文件） | 独立里程碑的核心理由；限额 / 超时 / 失败如实，不重试风暴 |
| 3 | 开放：多轮自主调研（literaturePlan → 自动补检索） | M7.1 保持单轮；M7.3 入口设计时以真实数据评估 |
| 4 | 开放：候选长期膨胀（candidates.json 无上限） | M7.1 不处理；若真实使用后膨胀，加 rejected 自动归档（可安全压缩） |
| 5 | 开放：AMiner 付费端点 | 维持免费层（D-0033 纪律），付费接入另议 |

---

## 8. 与既有决策的关系

- **零重开**：D-0033（Search/RAG 六层）/ D-0034（候选-正式分离）/
  D-0035（discovery 零持久化 + 显式保存）/ D-0036（检索栈）/
  D-0037~D-0040（Evidence / Writing / Revision / Evaluation）/
  D-0041（M6 架构冻结）——本文全部增量都在冻结分层的既有空位内。
- **M7.0 待登记**：D-0042（预计）= M7 范围冻结 + M7.1 接入收口
  （Agent 侧显式候选保存 + Researcher prompt 接线 + FullTextResolver
  挂接点冻结 + Crossref 勘误声明）。
- **红线延续**：零新增 Agent（D-0009）、文件优先三层状态（D-0013）、
  error ≠ not_found ≠ 空集（D-0023）、检索默认零持久化（D-0035）。

---

## 9. 进入 M7 实现的判定

**结论：可以进入（GO）。**

| 前提 | 状态 |
|---|---|
| 基线干净：main @ 3078947 == origin/main，工作区 clean | ✅ |
| 能力组件就位：§2.1 八项全部存在且有测试 | ✅ |
| 架构无需返工：四断点均为接线问题，非结构问题（M7.1 设计稿 §0-1 + 本文独立验证） | ✅ |
| 改动路径明确且最小：§4 四项，触点收敛于 4 个文件 + 前端 | ✅ |
| 边界清晰：§5 八项红线与全部既有冻结决策一致，无重开 | ✅ |
| 验收可判：M7.1 全局底线三条均为磁盘可验证的客观标准 | ✅ |
| 风险已识别并有缓解：§7 | ✅ |

**第一步动作**：M7.0（决策登记 D-0042 + 设计稿升版），随后 M7.1a 开工。
