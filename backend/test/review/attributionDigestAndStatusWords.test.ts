/**
 * M13 Final Closure（A4 接线 + F2）：
 * - attributionDigest 只注入 fact 模式；academic / style 与未传时逐字节一致；
 * - 综述 Writer 规则 9：文献库组织状态词不得写进正文；
 * - buildTaxonomyItems 的未归类 synthesis 条目不再携带「等待人工修正 taxonomy 标签」这类工作流指令。
 */

import { describe, expect, it } from "vitest";

import { buildReviewPrompt } from "../../src/agents/ReviewerService.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import { buildTaxonomyItems } from "../../src/survey/SynthesisService.js";
import type { SurveyMatrixArtifact } from "../../src/survey/matrixTypes.js";
import { buildSurveySectionPrompt } from "../../src/writer/WriterService.js";
import { buildSurveySectionContext } from "../../src/survey/sectionContext.js";

const EVIDENCE: EvidenceRecord = {
  id: "E001",
  claim: "c",
  verificationStatus: "verified",
  supportStrength: "direct",
  verificationLevel: "abstract",
  source: { sourceId: "S001", title: "T", year: 2024 },
  location: { chunk: "S001:ABS:0001:a1b2c3d4e5" },
  createdBy: "test",
  createdAt: "2026-10-13T00:00:00Z",
} as EvidenceRecord;

describe("buildReviewPrompt × attributionDigest（A4）", () => {
  const base = { projectId: "p", manuscriptDigest: "d", evidence: [EVIDENCE] };
  const digest = "多 key 引用归因观察：- [sections/x.tex] 「…」引用 {a, b}，但句中具体内容只命中 a 的证据";

  it("只注入 fact 模式；academic / style 逐字节不变；未传时 fact 也不变", () => {
    expect(buildReviewPrompt({ ...base, mode: "fact", attributionDigest: digest })).toContain("多 key 引用归因观察");
    expect(buildReviewPrompt({ ...base, mode: "fact", attributionDigest: digest })).toContain("不得据此否定该句的事实本身");
    expect(buildReviewPrompt({ ...base, mode: "fact", attributionDigest: digest })).not.toBe(buildReviewPrompt({ ...base, mode: "fact" }));
    for (const mode of ["academic", "style"] as const) {
      expect(buildReviewPrompt({ ...base, mode, attributionDigest: digest })).toBe(buildReviewPrompt({ ...base, mode }));
    }
    expect(buildReviewPrompt({ ...base, mode: "fact" })).not.toContain("多 key 引用归因观察");
  });
});

describe("综述 Writer × 文献库组织状态词（F2）", () => {
  it("buildSurveySectionPrompt 含规则 9（状态词不得写进正文）", () => {
    const matrix: SurveyMatrixArtifact = {
      schemaVersion: 1,
      taxonomy: { families: [] },
      entries: [],
      updatedAt: "2026-10-13T00:00:00Z",
    } as unknown as SurveyMatrixArtifact;
    const context = buildSurveySectionContext({
      section: { id: "intro", file: "intro.tex", title: "引言", synthesisRefs: [], literatureRefs: [] },
      matrix,
      synthesis: { schemaVersion: 1, items: [], updatedAt: "2026-10-13T00:00:00Z" } as never,
      bibliography: [],
      evidence: [],
    } as never);
    const prompt = buildSurveySectionPrompt({
      section: { id: "intro", file: "intro.tex", title: "引言" },
      outline: { title: "t", sections: [] } as never,
      evidence: [],
      bibliography: [],
      survey: context,
    } as never);
    expect(prompt).toContain("9. 文献库组织状态不是论文内容");
    expect(prompt).toContain("unclassified / 未归类 / 待人工修正");
  });

  it("buildTaxonomyItems：未归类条目的 synthesis 文本不含工作流指令「等待人工修正」", () => {
    const matrix = {
      schemaVersion: 1,
      taxonomy: { families: [{ label: "track_query_based", subFamilies: [] }] },
      entries: [
        { entryId: "M-S001", sourceId: "S001", methodFamily: "track_query_based", status: "draft", interpretationDepth: "abstract_only" },
        { entryId: "M-S002", sourceId: "S002", status: "draft", interpretationDepth: "abstract_only" },
        { entryId: "M-S003", sourceId: "S003", methodFamily: "unclassified", status: "draft", interpretationDepth: "abstract_only" },
      ],
      updatedAt: "2026-10-13T00:00:00Z",
    } as unknown as SurveyMatrixArtifact;
    const items = buildTaxonomyItems(matrix, "2026-10-13T00:00:00Z");
    const unclassified = items.find((item) => item.claim.includes("未落入预设方法家族"));
    expect(unclassified).toBeDefined();
    expect(unclassified?.claim).toContain("2 篇");
    expect(items.some((item) => item.claim.includes("等待人工修正"))).toBe(false);
  });
});
