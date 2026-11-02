# M16 续期收口 · 实现说明（覆盖修复与评测 / 产品适配）

- 日期：2026-11-02 · 起点 `8791708` · 本轮提交见 `M16_QUALITY_GATE_CLOSURE_DECISION.md` §交付
- 只记录本轮新增 / 修改；M15 / M16 既有代码、报告与冻结工件未改动。

## 1. A1 多文件 LaTeX 根 main.tex 正文覆盖（生产改动，零模型验证）

### 1.1 根因（实测）

`workflow/definitions.ts` review.run 构建覆盖计划：

```ts
const coverageSourceFiles = latexForAttribution.sections.length > 0
  ? latexForAttribution.sections            // ← 只有 \input 子文件
  : latexForAttribution.mainTex !== null ? [latexForAttribution.mainTex] : [];
```

`collectLatexFiles` 把 main.tex 放在 `mainTex`、子文件放在 `sections`。只要项目有任一 `\input` 子文件，main.tex 就不进入覆盖计划：

- 长文档单元模式：写在 main.tex 里的摘要 / 引言 / 结论不成为任何 Review Unit，`review-coverage` 仍报 `ratio = 1, complete = true`（计划里本来就没有它们）——**假完整**；
- digest 模式：`buildManuscriptDigest` 其实会把 main.tex 按节切块放进 digest（每块 2,600 字），但 `digestIsLossy` 只看子文件，根正文被截断时不会切到长文档模式。

基线复现（`8791708` 源码 + 新测试）：摘要 / 引言 / 结论哨兵句出现在 0 个单元 prompt 中；日志 `D:\PaperTeamData\M16\OriginalQualityGateGoalClosure\A\a1-baseline-8791708-negative.log`。

### 1.2 修复（提交 `d5f0052`）

| 文件 | 改动 |
|---|---|
| `backend/src/review/logicalSpan.ts` | `rootBodySpans(file, source)`：有标题 → 共享定位器的标题 span（其前置区 span 本来就从 `\begin{document}` / `\maketitle` 之后开始）；无标题 → `\begin{document}` 到 `\end{document}`（或 `thebibliography`）之间的一个 `frontmatter` span；**导言区永不进入**。`hasSubstantiveProse`：去掉注释、`\input` / `\include` / `\bibliography*` / `\label`、标题命令与其余命令后不足 40 字 → 不产生单元（纯组装 `\section{X}\input{x}` 不浪费调用，子文件内容只在子文件单元里审一次） |
| `backend/src/review/coverageLedger.ts` | `ReviewSourceFile { file, content, root? }` 与 `reviewSourceSpans(entry)`：**计划构建、单元原文、论断审计定位三处共用的唯一 span 选择**（三处不同口径会让单元 id 与原文对不上）；`files[].root` 标记；`coverageSourceManifest(plan)` → 覆盖摘要新增 `sources`（源文件哈希 + 每单元 contentHash，= journal `unitFingerprint`），覆盖账本、单元输入与源文件可逐项核对 |
| `backend/src/workflow/definitions.ts` | 有子文件且根 main.tex 有实质正文时，根文件以 `root: true` 置于计划首位；纯组装根不产生条目（计划与 snapshotId 逐字节不变，增量复用不失效）；`longDocumentMode = digestIsLossy(子文件) ‖ rootDigestIsLossy(根正文的 digest 视图)`（有大纲 = outline.abstract 2,000 字；否则同 `splitSingleFileDigest` 的节块 2,600 字 / ≤ 64 块；为此把切块抽成 `singleFileDigestChunks`，`splitSingleFileDigest` 输出逐字不变） |

不做的事：没有把整个 main.tex 塞进每个单元；没有改 `locateFileSpans`（单文件 main.tex、修订目标、finding 投影的口径不变）；有大纲项目的组装根若只有 `\maketitle` 与 `\input`，同样不产生单元。

### 1.3 验证

- `backend/test/workflow/m16RootBodyCoverage.test.ts`（真实 review.run stage，scripted runtime，零模型）4 例：
  1. 长文档模式：根 main.tex 摘要 / 引言 / 结论各进入**恰好一个**单元；导言区宏与 `\documentclass` 进入 0 个；两个子文件尾句各 1 次；计划含 main.tex 3 个单元；调度单元数 = 计划单元数；覆盖 complete；
  2. 纯组装根：main.tex 0 个单元，调度数 = 计划数；
  3. 无标题根正文：1 个 `frontmatter` 单元，导言区不进入；
  4. 短文档 digest 模式：digest 含根正文，计划如实列出根的 3 个单元。
- 基线 `8791708` 上同一测试 4 例全部 FAIL（日志见上）；修复后 4/4 通过。
- 回归：`test/review` + `test/workflow` 129 个文件、1,319 例通过（4 跳过）。

### 1.4 兼容影响

- 根 main.tex 有实质正文的多文件项目：snapshotId 改变 → 升级后首轮复审不复用旧单元缓存（重审一次，正确行为）；纯组装根项目不受影响。
- 有大纲（系统生成）项目：组装根若含 `\begin{abstract}`，长文档模式下摘要现在作为 `摘要与前置部分` 单元审查。该单元 finding 的修订路由沿用既有 `sectionMatches`：section 引用含「摘要 / abstract」才路由到摘要目标（`outline.abstract`），组装根本身从不是修订目标（`listRevisionTargets`）。**本轮未为大纲项目单独写端到端测试**（现有 workflow 测试全部通过，但其中没有「大纲项目 + 长文档模式 + 摘要 finding 修订」的组合），列为残余风险。

## 2. 评测工具（`scripts/m16-goal-closure/`，不进产品）

| 文件 | 作用 |
|---|---|
| `lib.mjs` | 本轮账本（`D:\PaperTeamData\M16\OriginalQualityGateGoalClosure\budget\calls.jsonl`）与 260 次硬上限 |
| `screen.mjs` | 零模型单元数筛查：用 backend/dist 的生产同一函数计算长文档模式实际调度单元数（DEVIATIONS #2；对 M16 收口两次真实运行逐个吻合） |
| `select.mjs` | 冻结新留出集（只输出计数） |
| `production.mjs` | 真实生产链路臂（复制自 m16-closure，单次运行硬上限 22，只用保真适配器） |
| `bc.mjs` | S 臂生成、judge1（B 五臂）、judge2（C）、确定性可定位性、盲化核验池与确定性核验 |
| `run-production.sh` | 按冻结顺序逐篇运行生产臂 |

冻结只读复用：`m16-closure/judge-prompt.mjs`、`specificity.mjs`、`md-to-tex-fidelity.mjs`、`m16-review-validity/lib.mjs`。新增对照 PSEUDO（伪具体意见）见协议 §3。

## 3. 保留与排除决策

- **A2 输入来源语义**：不改代码。Markdown 适配器是评测工具（产品无 MD → LaTeX 路径）；公式 / 数字 / 引用逐字保真、图片显式占位、HTML 表合并单元格展平已有回归（`m16MdToTexFidelity.test.ts` 7/7）；PDF 文本层公式损失由 `FORMULA_UNVERIFIED` 显式标注（`inputFidelity.test.ts`），本轮对照不使用 PDF 输入。
- **作者稿 Claim 级核验 shadow**：不升格。没有新的独立证据证明其抽取 / 判定足以进入阻断层；保持 L2 呈现。
- 其余（检出逻辑、目标期刊、修订链路）见 DECISION。
