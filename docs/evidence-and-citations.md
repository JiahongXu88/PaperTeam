# 证据与引用（Evidence & Citations）

> PaperTeam 最重要的设计差异：**Source ≠ Evidence**。这篇短文解释从检索到
> 引用的完整数据流，以及为什么 AI 写出的引用在这里是可审计的。

## 1. 数据流

```text
Search Result（检索命中，默认零持久化）
   → Candidate（显式入库才成为候选）
   → Source（文献库正式条目：PDF/DOI/arXiv/URL/BibTeX 五种入库，
            SourceIdentity 分层身份键判重）
   → Chunk（确定性分块，SourceChunk 管线）
   → Evidence Candidate（Agent 只能提案证据，不能定义什么是证据）
   → 三段核验：
        ① 逐字引文（quote 必须逐字出现在 Source 全文）
        ② 权威元数据（与外部学术库记录一致；NOT_FOUND ≠ 捏造 ≠ 检索失败）
        ③ 语义判定（judge 禁止凭记忆，只看给定材料）
   → Verified Evidence（唯一可被写作 / 审阅消费的形态）
   → Citation（正文引用 → references.bib → 编译后参考文献）
```

核心不变量：**Retrieved ≠ Candidate ≠ Literature ≠ Verified Evidence。**
检索命中不等于候选，入库不等于证据，Agent 提案不等于核验通过。

## 2. 为什么消费侧只认 verified

- Writer 的正式上下文走 evidence-only 视图（formalOnly）：没有 verified
  证据支撑的论断会被质量门禁的 `citations_evidence_backed` 规则拦下。
- 审阅侧同样只对 verified 证据做语义判定，避免「评审自己编来源」。
- 三段核验中前两段（逐字引文 / 元数据）是**纯代码**；第三段（语义）的
  输入被限制为已通过前两段的材料。

## 3. 引用双层核验

| 层 | 问题 | 手段 | 失败语义 |
| --- | --- | --- | --- |
| Layer 1 真实性 | 这条参考文献存在吗？ | Crossref / OpenAlex / arXiv 外部核验 | NOT_FOUND ≠ 捏造 ≠ 检索失败，三态分开呈现 |
| Layer 2 语义 | 引用真的支持这个论断吗？ | 原子论断 × 引用组判定（可按 run 关闭） | 不支持的引用剥离，不静默保留 |

## 4. 检索与 RAG

- 多源学术检索：OpenAlex / Semantic Scholar / arXiv / AMiner + 可选 SearXNG
  Web 搜索；共享 ProviderHttpClient（超时 / 退避 / Retry-After / 熔断 / 健康四态）。
- 项目内检索（`retrieve_library` 工具）：确定性 SourceChunk + 进程内 BM25 +
  可选 dense + RRF 混合 + Context Budget Packing；**零 Vector DB**，索引是
  Derived State（可删可重建）。

## 5. 作者实验数据：预先登记的论断复算（M14.9.5.4）

导入实验包只证明「这些文件由作者提供、按哈希绑定、作者确认可用于工作流」，**不等于**论文里的数值已被核验。
要让实验数据真正参与核验，需要登记复算计划（`experiments/claim-checks.json`，`PUT /api/projects/:id/claim-checks`）：

```text
论文语句（逐字 quote + 稿件值）
   → 实验包文件（包内相对路径 + sha256；参数取 JSON/YAML 字段，可多来源互证）
   → 协议核对（来源清单记录的哈希 / 协议字段 / 取值范围）
   → 过滤 + 白名单表达式计算（count / sum / mean / min / max / scalar；不执行任何代码）
   → 复算值 vs 稿件值 → CONSISTENT / CONTRADICTED / NOT_EVALUATED
```

- 三个维度分开记录：授权（作者确认 + 授权进入工作流）、来源真实性（`AUTHOR_SUPPLIED_UNVERIFIED`，哈希绑定）、
  推导正确性（`RECOMPUTED_BY_PAPERTEAM`）。证据等级最高只到 `RECOMPUTED_FROM_AUTHOR_DATA`，**永远不是 verified**。
- 缺列、错协议、文件哈希不符（过期修订）、冲突版本、越界数据、未授权输入、包外路径、稿件锚点失效一律
  `NOT_EVALUATED`，不猜测数值、不换相似实验，也不沿用旧修订的结论。
- review.run 只把**论断原文所在单元**的复算结果写进该单元 prompt（无登记 / 无相关结果时 prompt 逐字节不变），
  CONTRADICTED 另落成确定性 fact finding（`rootCauseKey=claim-check:<id>`）；Quality Gate 规则
  `experiment_claims_recomputed`：矛盾 FAIL、登记却无法复算 NOT_EVALUATED（必需）、未登记但有实验包 NOT_EVALUATED（不阻断）、
  第三方已发表论文只读评估 NOT_APPLICABLE。

## 6. 审稿论断账本与只读引用审计（M15.1，shadow）

审稿发现（finding）与「论文中的论断是否被核验」是两件事。M15.1 在 `review.run` 旁路产出版本化审计产物，
**生产 Quality Gate 不读它们**（规则、80 / 35 阈值、NOT_EVALUATED 语义不变；切换决策留待 M15.4 独立测评）：

| 产物 | 内容 |
| --- | --- |
| `reviews/claim-audit-r{n}.json`（`paperteam.review-claim-audit/v1`） | 每条论断：确定性 `claimId`（文件 + 规范化原文 + 文件内出现序号）、文件 span / 行号 / 原文 sha256、`claimType`、`linkedRefs` 解析、`verificationStatus` 与 `basis` / `verifier` 分开、`contextCompleteness`、跨单元查找任务账本、有界复核调用账本；另含 finding provenance 诊断 |
| `reviews/citation-audit-r{n}.json`（`paperteam.readonly-citation-audit/v1`） | `.bib` / `thebibliography` / 文后参考文献列表 × `\cite` / `[n]` / 作者-年份（含中文「等」）四层：attempted → input adequate → reference matched → external metadata verified |
| `reviews/quality-decision-v2-shadow-r{n}.json` | Quality Decision V2 影子结果：科学事实 / 引用 / 学术分（旧版基线，未校准）/ Style（advisory）/ 核验完整性分轴，按 quick_review / revision_task / autonomous_improvement 解读 |

状态口径：

- `VERIFIED_SUPPORTED` / `VERIFIED_CONTRADICTED` 只来自 verified Evidence、预登记复算，或「原文内跨处核对」——两处引文都在被审修订中逐字定位、
  写出的数值可比（同种量、无量纲歧义）且确定性比较一致 / 不一致、来源为作者源稿或有哈希绑定 QA；对应关系仍由审稿模型提出（报告如实标注）。
- 模型判断只能给 `REVIEWER_SUSPECTED` / `REVIEWER_CONSISTENT`；`UNSUPPORTED`（没找到证据）记 `AUTHOR_CHECK_REQUIRED`，**不等于已证伪**。
- 依赖其他章节而材料不可得 → `NOT_EVALUATED` + `CONTEXT_INCOMPLETE`，交给有界跨单元查找（`\ref` / 编号 / 区分性术语）与可选复核
  （`PAPERTEAM_REVIEW_CLAIM_RECHECK_CALLS`，每次 ≤8 条，失败如实 FAILED）；PDF 转写稿上的表格 / 公式 → `PARSE_ARTIFACT_SUSPECTED`。
- 覆盖率由单元账本 + 抽取状态 + 任务账本计算；全文科学论断总数不可测（`NOT_MEASURABLE`），账本为空不代表论断都已核验。
- 引用审计：没有外部权威元数据核验时真实性一律 `NOT_EVALUATED`——「没有发现虚构」不推导引用真实；作者-年份匹配失败记 `needs_review`（解析局限），只有 `\cite` key 对照缺失是确定性结构问题。

模式：`PAPERTEAM_REVIEW_CLAIM_AUDIT=auto`（缺省：只读评估 extended、作者稿件 shadow——shadow 下全部审稿 prompt 逐字节不变）/ `off` / `shadow` / `extended`。
只读评估的输入来源可用 `artifacts/input-provenance.json`（`{sourceKind: "author_latex" | "pdf_transcription", manuscriptSha256}`，须与被审 main.tex 绑定）声明；声明不是独立核验。

## 7. 可靠性证据

- M6.8/M6.9 评估：Plain LLM 25/25 提案捏造引用（五模型族全部 100%）；
  PaperTeam 管线在评估场景内零捏造证据泄漏 + metadata 陷阱拦截。
  见 [research/M6.8_EVALUATION_REPORT.md](research/M6.8_EVALUATION_REPORT.md)。
- M11 综述两 Case：54 cited / 0 hallucinated。
- 架构定义见 [ARCHITECTURE.md](ARCHITECTURE.md) §16。
