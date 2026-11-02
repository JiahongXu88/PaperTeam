# M16 收口 · A — 审稿输入保真

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 起点 `bdedfa3`（HEAD = origin/main = ls-remote，clean）
- 代码：`scripts/m16-closure/md-to-tex-fidelity.mjs`（适配器 + 比较器）、`a-fidelity-replay.mjs`（零模型回放）、`production.mjs`（`--mode dry` = scripted runtime 走真实 `review.run`）
- 测试：`backend/test/scripts/m16MdToTexFidelity.test.ts`（7 例，含旧版失败复刻与原稿错误负例）
- 证据（仓库外）：`D:\PaperTeamData\M16\ReviewFidelityAndBenchmark_Closure\A\a-fidelity-replay.json`、`A\production\<case>__dry__{legacy,fidelity}\calls\*.prompt.txt`
- 付费模型调用：0

## 1. 公式损坏发生在哪里

**结论：不在产品里，在 benchmark 适配器里。** 产品没有 Markdown → LaTeX 路径（`frontend/src/pages/NewProjectPage.tsx:781` 只收 `.pdf` / `.zip`；后端无 markdown→latex 实现）。M16 生产臂的输入链路是：

```
CoCoReviewBench MD（MinerU 转写）
 → D:\PaperTeamData\M15\QualityGateCalibration\scripts\md_to_tex.mjs（md5 7b167b58…，仓库外实验脚本）
     markdownToLatex() → 每个正文块 bold() → esc()：把 \ { } $ & # % _ ^ ~ 全部转义
 → main.tex → review.run（workflow/definitions.ts:742）→ coverage plan（review/coverageLedger.ts:258）
 → logicalSpan.partitionSpanIntoUnits（review/logicalSpan.ts:131，原文切片、不改写）
 → ReviewerService.buildUnitReviewPrompt（agents/ReviewerService.ts，「单元原文…完整无截断」原样拼接）→ findings
```

`esc()` 不识别数学：行内 `$\mu_k^n$` 变成 `\$\textbackslash{}mu\_k\^{}n\$`，`$$…$$` 内部同样被转义，MinerU 的 HTML `<table>` 成为转义后的标签串，`# 1.1` 小节一律升为 `\section`。后面的产品链路对 LaTeX **逐字直通**（SOURCE_CONFIRMED，见 §3），所以 Reviewer 读到的就是这些字面串。

## 2. 修复与对照

新适配器只转义非数学正文：`$…$`、`\(…\)`、`$$…$$`、`\[…\]`、顶层 `equation / align / gather / multline` 原样直通；`\$` 当字面美元；疑似货币的 `$…$`（无数学记号、含多个英文词）按文本处理并记 `CURRENCY_DOLLAR_AS_TEXT`；按编号深度映射标题层级（编号文本保留，便于「Section 3.2」类引用对应）；HTML 表格 → tabular（单元格内数学同样直通，rowspan / colspan 展平并记 `TABLE_LAYOUT_SIMPLIFIED`）；图片 → 显式占位 `[Figure image not available as text]` 并记 `FIGURE_NOT_READABLE`。

**原稿错误不替作者修正**：花括号 / `\left\right` / `\begin\end` 不配对、未闭合 `$` 照样保留，记 `SOURCE_MATH_*` / `SOURCE_UNPAIRED_DOLLAR`；转写稿把 LaTeX 命令写在数学之外（如 `Score(\cdot)`）按字面转义并记 `SOURCE_LATEX_COMMAND_OUTSIDE_MATH`。单测负例断言：坏公式、未配对 `$`、错别字、可疑数值均原样保留。

### 2.1 适配器层（本地全部 20 篇 CoCoReview MD，零模型）

比较器 `compareFidelity(md, downstream)`：源中每个数学段（去空白）是否作为子串出现在下游；转义残留（`\textbackslash{}<命令>` 等）；正文数字与 `[n]` 引用标记多重集；标题保留。

| | 旧 md_to_tex.mjs | 新适配器 |
|---|---|---|
| 数学段逐字保留 | 4/23 – 80/456（每篇 13–64%；保留的多是 `$n$` 这类无特殊字符的单符号） | **20/20 篇 100%** |
| 转义残留 | 20 – 2,436 处 / 篇 | 0（3 篇各 1–2 处，均为源稿把命令写在数学外，已归因） |
| 正文数字 / `[n]` 标记 | 100% | 100% |
| 子小节层级 | 0（全部升为 section） | 2 – 14 个 subsection / 篇 |

### 2.2 Reviewer 输入层（真实 `review.run`，scripted runtime，零模型）

对 M16 两篇生产臂论文，把 Reviewer 实际收到的单元 prompt 中「单元原文」拼接后与源 MD 比较：

| 篇 | 运行 | 数学逐字 | 残留 | 正文数字（不含参考文献） | `[n]`（不含参考文献） | 单元覆盖 |
|---|---|---|---|---|---|---|
| X7eAhXcps1 | M16 live（历史） | 67/402 | 1,042 | 158/158 | 22/22 | 24/24，ratio 1 |
| | dry · 旧适配器 | 67/402 | 1,042 | 158/158 | 22/22 | 24/24 |
| | dry · 新适配器 | **402/402** | **0** | 158/158 | 22/22 | 24/24 |
| w5h443GIGo | M16 live（历史） | 61/212 | 666 | 50/50 | — | 17/17 |
| | dry · 新适配器 | **212/212** | **0** | 50/50 | — | 17/17 |

dry · 旧适配器与 M16 历史 live 的 prompt 指标逐项相同，说明回放复现了原失败。仍未出现在单元 prompt 中的只有：参考文献节（生产按设计从末节剥离 `thebibliography`，`review/revisionScope.ts:132`），以及只有标题、无正文的父级章节（如「2 Background」后直接是「2.1 Notations」）——无正文丢失。

修复后的实际效果见 C（`M16_CLOSURE_DECISION.md` §3）：同一生产 Reviewer 在新输入上报出了源稿 Eq. (1) 的 z 分数分母问题（γ√((1−γ)T) vs √(γ(1−γ)T)，源 MD 逐字如此）——这类意见在旧适配器下读到的是 `\gamma \textbackslash{}sqrt …`。

## 3. 三条入口的支持级别

| 入口 | 结论 | 依据 |
|---|---|---|
| Markdown（只存在于 benchmark 适配） | **PASS**（正文 / 数学 / 数字 / 引用 / 章节）；图片内容 INPUT_FIDELITY_LIMITED（显式占位）；表格合并单元格展平 | §2 |
| 原生 LaTeX（`review.run`） | **PASS**：单元原文是源文件精确切片，数学、`\ref` / `\eqref` / `\cite` / `\label`、`%` 注释逐字保留；切分只在环境 / 显示公式之外的空行（`review/logicalSpan.ts:83-118`）；引文定位按原文字面匹配（`review/findingProjection.ts:113`） | SOURCE_CONFIRMED |
| PDF（`existing_paper_review` / PDF 重建） | **PARTIAL（INPUT_FIDELITY_LIMITED）**：PyMuPDF 文本层（`backend/tools/parse_paper_pdf.py`）→ 公式线性化、上下标结构与图像公式丢失；`import/PaperReconstructor.ts:60` 对抽取文本转义是正确的（PDF 文本不是 LaTeX）；`review/inputFidelity.ts` 已对未核验公式标 `FORMULA_UNVERIFIED`。**不得用于学术审稿能力对照** | SOURCE_CONFIRMED |

原生 LaTeX 的已知限制（本轮不修，已披露）：多文件工程在 unit 模式下覆盖文件只取 `sections`，`main.tex` 中的正文（如写在 main.tex 里的摘要）不审（`workflow/definitions.ts:811`）；`LatexFiles.ts:170` 会跟随被注释掉的 `\input`。二者都不影响本轮评测（单文件 main.tex），修复会改变多文件工程的单元构成与增量复用，需单独验证。

## 4. 验收

- 旧版本失败证据：单测内逐字复刻旧 `esc` 规则并断言残留；回放中旧适配器 dry 与 M16 历史 live 指标一致。
- 新版本：7/7 单测通过；20/20 篇数学 100% 逐字；两篇真实 Reviewer 输入数学 100%、残留 0、正文数字 / 引用 100%、覆盖率 1。
- 负例：原稿坏公式 / 未配对 `$` / 错误数值原样保留并归因原稿。
- **INPUT_FIDELITY：Markdown（benchmark）PASS · 原生 LaTeX PASS · PDF PARTIAL。**
