import { describe, expect, it } from "vitest";

import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import { findingAnchors, projectFindingTarget } from "../../src/review/findingProjection.js";

const METHOD_A = [
  "\\section{Method}",
  "We introduce a saliency-shift-aware convLSTM that models attention transitions.",
  "The proposed module reduces the mean absolute error on DAVSOD",
  "from 0.103 to 0.092 under the explicit training strategy.",
  "Shared sentence: results are averaged over three runs.",
].join("\n");
const METHOD_B = [
  "\\section{Method}",
  "A second chapter that reuses the heading name but describes a different estimator.",
  "Shared sentence: results are averaged over three runs.",
].join("\n");
const FILES = [
  { file: "sections/ch2.tex", content: METHOD_A },
  { file: "sections/ch4.tex", content: METHOD_B },
];

function issue(overrides: Partial<ReviewIssue>): ReviewIssue {
  return { category: "academic", severity: "major", section: "Method", description: "问题", blocking: false, ...overrides };
}

describe("M14.1b P1 Finding → targetQuote 投影", () => {
  it("issue.quote 在文档中唯一 → 投影为文档原文切片（空白不敏感，返回文档形态）", () => {
    const result = projectFindingTarget(issue({ quote: "reduces the mean absolute   error on DAVSOD" }), FILES);
    expect(result).toMatchObject({ status: "resolved", file: "sections/ch2.tex", logicalSection: "section:Method", basis: "issue_quote", scope: "document" });
    expect(result.status === "resolved" && result.targetQuote).toBe("reduces the mean absolute error on DAVSOD");
  });

  it("无 quote 时回退到描述 / 建议中的引号片段（≥12 字）", () => {
    const result = projectFindingTarget(issue({ description: "句子「from 0.103 to 0.092 under the explicit」缺少显著性检验", suggestedAction: "补充检验" }), FILES);
    expect(result).toMatchObject({ status: "resolved", basis: "description_fragment", targetQuote: "from 0.103 to 0.092 under the explicit" });
    expect(findingAnchors(issue({ description: "短「abc」片段", quote: "too short" }))).toEqual([]);
  });

  it("重复文本（同名章节共享句）在全文档范围歧义 → unresolved；给定 file / logicalSection 后唯一", () => {
    const ambiguous = projectFindingTarget(issue({ quote: "Shared sentence: results are averaged over three runs." }), FILES);
    expect(ambiguous).toMatchObject({ status: "unresolved", reason: "ANCHOR_AMBIGUOUS" });
    const scopedByFile = projectFindingTarget(issue({ quote: "Shared sentence: results are averaged over three runs.", file: "sections/ch4.tex" }), FILES);
    expect(scopedByFile).toMatchObject({ status: "resolved", file: "sections/ch4.tex", scope: "file" });
    const scopedBySection = projectFindingTarget(issue({ quote: "Shared sentence: results are averaged", file: "sections/ch2.tex", logicalSection: "section:Method" }), FILES);
    expect(scopedBySection).toMatchObject({ status: "resolved", file: "sections/ch2.tex", scope: "section", targetQuote: "Shared sentence: results are averaged" });
  });

  it("目标位置变化后旧 quote 不能误用：快照中不存在 → ANCHOR_NOT_FOUND，不猜替代位置", () => {
    const changed = [{ file: "sections/ch2.tex", content: METHOD_A.replace("from 0.103 to 0.092", "from 0.103 to 0.090") }];
    const result = projectFindingTarget(issue({ quote: "from 0.103 to 0.092 under the explicit" }), changed);
    expect(result).toMatchObject({ status: "unresolved", reason: "ANCHOR_NOT_FOUND" });
  });

  it("证据不足（无锚点 / 范围不存在）→ unresolved，不产生任何 targetQuote", () => {
    expect(projectFindingTarget(issue({ description: "整体行文需要加强" }), FILES)).toMatchObject({ status: "unresolved", reason: "NO_ANCHOR" });
    expect(projectFindingTarget(issue({ quote: "reduces the mean absolute error on DAVSOD", file: "sections/missing.tex" }), FILES)).toMatchObject({ status: "unresolved", reason: "SCOPE_NOT_FOUND" });
    expect(projectFindingTarget(issue({ quote: "reduces the mean absolute error on DAVSOD", file: "sections/ch2.tex", logicalSection: "section:Nope" }), FILES)).toMatchObject({ status: "unresolved", reason: "SCOPE_NOT_FOUND" });
  });

  it("多个候选锚点按优先级尝试：quote 歧义时描述片段若唯一则采用（basis 如实为 description_fragment）", () => {
    const result = projectFindingTarget(issue({ quote: "Shared sentence: results are averaged over three runs.", description: "见「models attention transitions.」" }), FILES);
    expect(result).toMatchObject({ status: "resolved", basis: "description_fragment", targetQuote: "models attention transitions." });
  });
});
