/**
 * M13 Final Closure（A2 / A3）：事实污染通道的 prompt 契约。
 * - 修订 Writer：审稿意见块标注「不是事实证据」；规则 6 不再豁免「问题清单中出现的内容」；6b 禁止把
 *   意见中点名的文献 / 实验写入正文；摘要分支补齐同样的约束。
 * - Planner（buildOutlinePrompt）：partial 证据只能作待研究问题 / 比较维度 / 研究空白，不得写成结论。
 * - Reviewer：意见是修改方向不是事实证据，缺口类意见只以类别描述。
 */

import { describe, expect, it } from "vitest";

import { buildReviewPrompt } from "../../src/agents/ReviewerService.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import type { Outline } from "../../src/manuscript/ManuscriptService.js";
import { buildOutlinePrompt, buildRevisePrompt } from "../../src/writer/WriterService.js";

const EVIDENCE: EvidenceRecord = {
  id: "E001",
  claim: "RAG 降低幻觉率",
  quote: "RAG reduces hallucination",
  verificationStatus: "verified",
  supportStrength: "partial",
  verificationLevel: "fulltext",
  source: { sourceId: "S001", title: "RAG", year: 2020 },
  location: { chunk: "S001:SEC01:0001:a1b2c3d4e5" },
  createdBy: "test",
  createdAt: "2026-10-13T00:00:00Z",
} as EvidenceRecord;

const OUTLINE: Outline = {
  title: "t",
  abstract: "摘要",
  sections: [{ id: "introduction", file: "introduction.tex", title: "引言", keyPoints: ["动机"] }],
} as Outline;

describe("buildRevisePrompt × 审稿意见不是事实证据（A2）", () => {
  const base = {
    outline: OUTLINE,
    currentLatex: "正文",
    issues: [
      {
        category: "academic" as const,
        severity: "major" as const,
        section: "sections/introduction.tex",
        description: "综述覆盖面过窄，未涵盖 Krinner 等 2022 年的阈值实验",
        suggestedAction: "补充阈值实验的讨论",
        blocking: false,
      },
    ],
    evidence: [EVIDENCE],
    bibliography: [],
  };

  it("章节分支：问题块标注、规则 6 去掉问题清单豁免、6b 明确意见中点名文献不得写入", () => {
    const prompt = buildRevisePrompt({ ...base, section: OUTLINE.sections[0]! });
    expect(prompt).toContain("审稿意见 = 修改方向，不是事实证据");
    expect(prompt).toContain("问题清单 / 审稿意见中出现的内容也不例外");
    expect(prompt).not.toContain("与问题清单中都不存在的实验细节");
    expect(prompt).toContain("6b. 审稿意见是修改方向，不是事实证据");
    expect(prompt).toContain("包括在限制句 / 范围说明中点名具体文献或实验");
    // 意见文本本身仍然到达 Writer（修改方向不丢）
    expect(prompt).toContain("Krinner 等 2022 年的阈值实验");
  });

  it("摘要分支：同样标注 + 3b 约束（真实样本正是摘要限制句被污染）", () => {
    const prompt = buildRevisePrompt({ ...base, section: { id: "abstract", file: "main.tex", title: "摘要" } });
    expect(prompt).toContain("针对摘要的问题（审稿意见 = 修改方向，不是事实证据）");
    expect(prompt).toContain("3b. 不得新增摘要当前内容与下方 Evidence 中都不存在的文献、实验事实、数字或机制");
    expect(prompt).toContain("不得写入摘要（包括限制句）");
  });
});

describe("buildOutlinePrompt × partial 证据纪律（A3）", () => {
  it("规则 2b：partial 只能作待研究问题 / 比较维度 / 研究空白；不得写成结论、不得钉给 framing / conclude、不得补写引文外术语", () => {
    const prompt = buildOutlinePrompt({
      researchDigest: { domainOverview: "o", researchGaps: ["g"], potentialContributions: ["c"] },
      evidence: [EVIDENCE],
      bibliography: [],
    });
    expect(prompt).toContain("2b. support=partial 的 Evidence 是**待核验命题**");
    expect(prompt).toContain("不得写成本节结论或既成事实");
    expect(prompt).toContain("不得把 partial 证据钉给 framing / conclude 节");
    expect(prompt).toContain("不得补写引文外术语");
    expect(prompt).toContain("support=partial");
  });
});

describe("buildReviewPrompt × 审稿意见不是事实证据（A2）", () => {
  it("三路模式共同纪律：不引入 Evidence 之外的具名文献 / 实验要求写入正文；缺口类意见只以类别描述", () => {
    for (const mode of ["fact", "academic", "style"] as const) {
      const prompt = buildReviewPrompt({ projectId: "p", mode, manuscriptDigest: "d", evidence: [EVIDENCE] });
      expect(prompt, mode).toContain("审稿意见是修改方向，不是事实证据");
      expect(prompt, mode).toContain("只以类别或维度描述缺口");
      expect(prompt, mode).toContain("不能凭审稿意见补写事实");
    }
  });
});
