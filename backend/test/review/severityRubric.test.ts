/**
 * M14.9.5 P0：severity / verification / blocking 三轴口径（零模型）。
 *
 * - 作者稿件口径（thesis / MOT / existing-paper）：digest、单元、跨章 prompt 与基线 310afff 逐字节一致
 *   （哈希取自 D:\PaperTeamData\M14_9_5_QualityGateReliability\prompt-lock.json——基线源码 git archive 后构建）；
 * - 已发表论文只读口径：prompt 写明 severity / verification / blocking 的书面定义，blocking 不再只出现在禁止语境；
 * - verification 字段宽松解析（大小写 / 分隔符），非法值视为未声明；rubric 一致性提示只读、不改模型判定。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildReviewPrompt, ReviewerService, parseModeReview, type ReviewIssue } from "../../src/agents/ReviewerService.js";
import { renderPublishedAssessmentPolicyLines } from "../../src/review/reviewPurpose.js";
import { normalizeFindingVerification, rubricFlags } from "../../src/review/severityRubric.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const policy = ["", "===== Experiment Policy（实验数据使用口径；全体角色一致）=====", "本项目当前没有已导入的实验数据：不得把未来实验写为已完成结果。"];
const unit = { unitId: "main.tex::section:2", file: "main.tex", heading: "2 结果", unitIndex: 1, unitCount: 1, text: "共纳入 1 200 名研究对象，其中男性 600 名（50.0%）。" };
const chapters = [{ heading: "1 方法", file: "main.tex", digest: "方法摘要" }, { heading: "2 结果", file: "main.tex", digest: "结果摘要" }];

/** 基线 310afff 的作者稿件口径 prompt 哈希（prompt_lock.mjs 生成） */
const BASELINE_AUTHOR = {
  "digest.fact": "51cc4b02fad6bec9dfe5ad83df58410f784395b3e7b01e1f719314287c4af98d",
  "digest.academic": "abef1e891ff2f6af4c486945dcada0b1fc1025ff1ddfefdf321695762d3e8cf3",
  "digest.style": "fe26828122e624c9ad8b92211d17b33738c9e8964d776a15a211c6df65da51ef",
  unit: "f5dfefa551fc44c553de914d0570cee0620f6c7bc328a1bdeab072b84efa40f5",
  cross: "a90a8582831dac65d9493d4259a797f417eb08af083a7c45858c73793b5f617b",
};

function capturingReviewer() {
  const prompts: string[] = [];
  const runtime = {
    runAgent: async (input: { task: string }) => {
      prompts.push(input.task);
      return { taskId: "t", status: "completed", output: JSON.stringify({ summary: "s", issues: [], academicScore: 70, riskScore: 10 }) };
    },
  };
  return { prompts, reviewer: new ReviewerService({ runtime: runtime as never, agentId: "reviewer", projects: {} as never }) };
}

describe("作者稿件口径 prompt 与基线 310afff 逐字节一致（回归锁）", () => {
  it("digest 三路", () => {
    for (const mode of ["fact", "academic", "style"] as const) {
      const prompt = buildReviewPrompt({ projectId: "p", mode, manuscriptDigest: "稿件摘要", evidence: [], language: "zh", experimentPolicyLines: policy });
      expect(sha(prompt), mode).toBe(BASELINE_AUTHOR[`digest.${mode}`]);
      expect(prompt).not.toContain("VERIFIED_IN_TEXT");
    }
  });

  it("单元与跨章", async () => {
    const { prompts, reviewer } = capturingReviewer();
    await reviewer.reviewUnit({ projectId: "p", unit, chapterIndex: ["1 方法（main.tex）", "2 结果（main.tex）"], experimentPolicyLines: policy, language: "zh" });
    await reviewer.reviewCrossChapter({ projectId: "p", chapters, experimentPolicyLines: policy, language: "zh" });
    expect(sha(prompts[0]!)).toBe(BASELINE_AUTHOR.unit);
    expect(sha(prompts[1]!)).toBe(BASELINE_AUTHOR.cross);
  });
});

describe("已发表论文只读口径：三轴 rubric 进入全部 prompt 路径", () => {
  it("单元 / 跨章 / digest prompt 都写明 severity、verification、blocking 的定义", async () => {
    const lines = renderPublishedAssessmentPolicyLines();
    const { prompts, reviewer } = capturingReviewer();
    await reviewer.reviewUnit({ projectId: "p", unit, chapterIndex: ["2 结果（main.tex）"], publishedAssessmentLines: lines, language: "zh" });
    await reviewer.reviewCrossChapter({ projectId: "p", chapters, publishedAssessmentLines: lines, language: "zh" });
    const digest = buildReviewPrompt({ projectId: "p", mode: "academic", manuscriptDigest: "稿件摘要", evidence: [], publishedAssessmentLines: lines });
    for (const prompt of [...prompts, digest]) {
      expect(prompt).toContain("VERIFIED_IN_TEXT");
      expect(prompt).toContain("AUTHOR_CHECK_REQUIRED");
      expect(prompt).toContain("EXTERNAL_DATA_REQUIRED");
      expect(prompt).toContain("blocking 在本场景的含义");
      expect(prompt).toContain("critical 必须是 VERIFIED_IN_TEXT");
      // blocking 不再只出现在禁止语境：有正向定义，也保留「不得因缺少原始数据而设」
      expect(prompt).toContain("不得因论文已发表而不设，也不得因缺少原始数据而设");
      expect(prompt).toContain("同一根因");
      // JSON 模板显式列出 verification 字段（跨章 finding 不再把判定写进 description）
      expect(prompt).toContain('"verification": "VERIFIED_IN_TEXT|AUTHOR_CHECK_REQUIRED|EXTERNAL_DATA_REQUIRED"');
    }
  });

  it("rubric 不含任何论文 ID / 刊名等定制内容", () => {
    const text = renderPublishedAssessmentPolicyLines().join("\n");
    expect(text).not.toMatch(/P0\d\d|白族|民族|失能|血脂|OR=|中华|Chin J/);
  });
});

describe("verification 解析与 rubric 一致性提示", () => {
  it("宽松解析大小写 / 分隔符，非法值视为未声明（不整条拒绝）", () => {
    expect(normalizeFindingVerification("verified-in-text")).toBe("VERIFIED_IN_TEXT");
    expect(normalizeFindingVerification(" author check required ")).toBe("AUTHOR_CHECK_REQUIRED");
    expect(normalizeFindingVerification("EXTERNAL_DATA_REQUIRED")).toBe("EXTERNAL_DATA_REQUIRED");
    expect(normalizeFindingVerification("UNVERIFIED")).toBeUndefined();
    expect(normalizeFindingVerification(3)).toBeUndefined();
    const parsed = parseModeReview("academic", {
      summary: "s", scores: { 论证逻辑: 60 },
      issues: [
        { category: "academic", severity: "major", section: "2", description: "a", blocking: false, verification: "author_check_required" },
        { category: "academic", severity: "minor", section: "2", description: "b", blocking: false, verification: "maybe" },
        { category: "academic", severity: "minor", section: "2", description: "c", blocking: false },
      ],
    });
    expect(parsed.issues.map((issue) => issue.verification)).toEqual(["AUTHOR_CHECK_REQUIRED", undefined, undefined]);
  });

  it("blocking / critical 未声明 VERIFIED_IN_TEXT 只给提示，不改 severity / blocking", () => {
    const issue: Pick<ReviewIssue, "severity" | "blocking" | "verification"> = { severity: "critical", blocking: true, verification: "AUTHOR_CHECK_REQUIRED" };
    expect(rubricFlags(issue)).toEqual(["BLOCKING_WITHOUT_TEXT_VERIFICATION", "CRITICAL_NOT_TEXT_VERIFIED"]);
    expect(issue).toEqual({ severity: "critical", blocking: true, verification: "AUTHOR_CHECK_REQUIRED" });
    expect(rubricFlags({ severity: "critical", blocking: true, verification: "VERIFIED_IN_TEXT" })).toEqual([]);
    expect(rubricFlags({ severity: "major", blocking: false })).toEqual(["VERIFICATION_UNSPECIFIED"]);
  });
});
