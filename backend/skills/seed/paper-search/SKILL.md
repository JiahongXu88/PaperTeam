---
name: paper-search
description: Search, download, and read academic papers from 20+ sources (arXiv, PubMed, Semantic Scholar, CrossRef, etc). Use when the user asks to find papers, search for research, look up academic literature, download a paper PDF, or extract text from a paper.
---

# Paper Search（PaperTeam 兼容版）

搜索与查证学术论文。本版本是 PaperTeam 对上游 `paper-search` skill 的适配：
PaperTeam 的 Agent 不持有 shell/CLI，检索一律通过宿主提供的受控工具完成。
（上游原版基于 `paper-search` CLI，见同目录 UPSTREAM_SKILL.md；frontmatter
description 保持原义。）

## 可用工具（由 PaperTeam 后端提供）

- `search_papers(query, limit?)`：跨 Crossref / OpenAlex 检索，返回 JSON 数组：
  `[{provider, recordId, title, authors, year, venue, doi, arxivId}]`
- `lookup_paper(title?, doi?, arxivId?, year?)`：单篇精确查证，返回
  `{outcome: match|mismatch|ambiguous|not_found|unresolved, canonical, mismatches}`。
  注意 `not_found`（多源一致查无）与 `unresolved`（检索失败）语义不同。

## 工作流

1. 需要文献线索时先用 `search_papers` 检索（关键词或近似标题）；
2. 把候选结果整理为表格呈现：标题、作者、年份、来源、DOI；
3. 需要确认某一篇是否真实存在 / 元数据是否正确时，用 `lookup_paper`，
   优先传 DOI（精确匹配优先级最高），无 DOI 时传完整标题 + 年份 + 第一作者；
4. `lookup_paper` 返回 `unresolved` 时如实报告「暂时无法核验」，
   不得凭记忆判定文献存在与否；
5. 全文/PDF 下载当前不在受控工具面内（如需，交给宿主的后续流程）。

## 纪律

- 检索结果必须来自工具返回值；禁止凭训练记忆「补充」论文信息；
- 查不到就报告查不到，不要用相近论文顶替；
- 上游支持的 20+ 数据源中，PaperTeam v1 接入 Crossref / OpenAlex
  （Semantic Scholar / arXiv 在 resolver 层参与查证）。
