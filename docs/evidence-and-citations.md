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

## 5. 可靠性证据

- M6.8/M6.9 评估：Plain LLM 25/25 提案捏造引用（五模型族全部 100%）；
  PaperTeam 管线在评估场景内零捏造证据泄漏 + metadata 陷阱拦截。
  见 [research/M6.8_EVALUATION_REPORT.md](research/M6.8_EVALUATION_REPORT.md)。
- M11 综述两 Case：54 cited / 0 hallucinated。
- 架构定义见 [ARCHITECTURE.md](ARCHITECTURE.md) §16。
