/**
 * Claim Strength Check 测试（M6.7 §8）：
 * - 分级：weak / moderate / strong marker 识别
 * - 证据档位：direct / partial / insufficient（只认 formal evidence）
 * - 升级检测：弱表述 → 强表述（block）、新增强句（block）、部分证据（warning）
 * - 授权：计划文本 / evidence 文本包含强 marker 或同数字 → 不报
 * - 强度平移不报；数学环境 / 引用命令不参与
 */

import { describe, expect, it } from "vitest";

import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import {
  checkClaimStrengthEscalation,
  classifyClaimStrength,
  evidenceSupportOf,
} from "../../src/quality/claimStrength.js";

function evidence(partial: Partial<EvidenceRecord>): EvidenceRecord {
  return {
    id: "E001",
    claim: "RAG 可能改善开放域问答的事实准确性",
    verificationStatus: "verified",
    supportStrength: "partial",
    source: { sourceId: "src-1", title: "A Survey" },
    location: { chunk: "c1" },
    createdBy: "test",
    createdAt: "2026-09-18T00:00:00.000Z",
    ...partial,
  };
}

describe("classifyClaimStrength", () => {
  it("strong / weak / moderate marker 识别", () => {
    expect(classifyClaimStrength("该方法的效果显著提升。")).toBe("strong");
    expect(classifyClaimStrength("结果表明该方法显著优于基线。")).toBe("strong");
    expect(classifyClaimStrength("该方法可能改善效果。")).toBe("weak");
    expect(classifyClaimStrength("该方法在一定程度上有潜力。")).toBe("weak");
    expect(classifyClaimStrength("该方法在两个数据集上进行了评估。")).toBe("moderate");
  });
});

describe("evidenceSupportOf", () => {
  it("只认 formal evidence：direct 优先，其次 partial，其余 insufficient", () => {
    expect(evidenceSupportOf([evidence({ supportStrength: "direct" })])).toBe("direct");
    expect(evidenceSupportOf([evidence({ supportStrength: "partial" })])).toBe("partial");
    expect(
      evidenceSupportOf([evidence({ supportStrength: "direct" }), evidence({ id: "E002", supportStrength: "partial" })]),
    ).toBe("direct");
    // 缺锚点（非 formal）/ unverified / contradictory → 不构成支撑
    expect(evidenceSupportOf([evidence({ location: {} })])).toBe("insufficient");
    expect(evidenceSupportOf([evidence({ verificationStatus: "unverified" })])).toBe("insufficient");
    expect(evidenceSupportOf([evidence({ supportStrength: "contradictory" })])).toBe("insufficient");
    expect(evidenceSupportOf([])).toBe("insufficient");
  });
});

describe("checkClaimStrengthEscalation", () => {
  const before = [
    "\\section{实验}",
    "该方法可能改善检索质量与幻觉率。",
    "我们在两个数据集上进行了评估 \\cite{gao2023survey}。",
  ].join("\n");

  it("弱表述 → 强表述且无证据：block", () => {
    const after = before.replace("该方法可能改善检索质量与幻觉率。", "该方法显著改善检索质量与幻觉率。");
    const findings = checkClaimStrengthEscalation({ file: "sections/experiments.tex", before, after, relatedEvidence: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "sections/experiments.tex",
      claimStrength: "strong",
      evidenceSupport: "insufficient",
      action: "block",
    });
    expect(findings[0]?.markers).toContain("显著改善");
  });

  it("部分证据支撑的强升级：warning（不 block）", () => {
    const after = before.replace("该方法可能改善检索质量与幻觉率。", "该方法显著改善检索质量与幻觉率。");
    const findings = checkClaimStrengthEscalation({
      file: "sections/experiments.tex",
      before,
      after,
      relatedEvidence: [evidence({ supportStrength: "partial" })],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.action).toBe("warning");
    expect(findings[0]?.evidenceSupport).toBe("partial");
  });

  it("direct 证据支撑：升级合法，不产生 finding", () => {
    const after = before.replace("该方法可能改善检索质量与幻觉率。", "该方法显著改善检索质量与幻觉率。");
    const findings = checkClaimStrengthEscalation({
      file: "sections/experiments.tex",
      before,
      after,
      relatedEvidence: [evidence({ supportStrength: "direct" })],
    });
    expect(findings).toHaveLength(0);
  });

  it("新增强句（无对应原文）：block", () => {
    const after = `${before}\n综上所述，本方法显著优于所有现有方法。`;
    const findings = checkClaimStrengthEscalation({ file: "sections/experiments.tex", before, after, relatedEvidence: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.before).toContain("新增句");
    expect(findings[0]?.action).toBe("block");
  });

  it("授权：计划 / evidence 文本包含强 marker 或同数字 → 不报", () => {
    const escalated = before.replace("该方法可能改善检索质量与幻觉率。", "该方法显著改善检索质量与幻觉率。");
    expect(
      checkClaimStrengthEscalation({
        file: "f.tex",
        before,
        after: escalated,
        relatedEvidence: [],
        authorizationTexts: ["依据 Evidence 修正表述：显著改善"],
      }),
    ).toHaveLength(0);
    // 数字授权：升级句引用 12.4%，evidence 文本包含同数字
    const numeric = before.replace(
      "该方法可能改善检索质量与幻觉率。",
      "该方法将准确率大幅提高至 12.4\\%。",
    );
    expect(
      checkClaimStrengthEscalation({
        file: "f.tex",
        before,
        after: numeric,
        relatedEvidence: [evidence({ claim: "实验测得准确率为 12.4%" })],
      }),
    ).toHaveLength(0);
  });

  it("强度平移（before 已是 strong）与无升级改动不报；数学环境 / \\cite 不参与", () => {
    const strong = "该方法显著改善检索质量。\n\\begin{equation}\n  q = \\alpha r\n\\end{equation}";
    const strongMoved = "该方法显著改善检索质量（复测一致）。\n\\begin{equation}\n  q = \\alpha r\n\\end{equation}";
    expect(
      checkClaimStrengthEscalation({ file: "f.tex", before: strong, after: strongMoved, relatedEvidence: [] }),
    ).toHaveLength(0);
    // 公式内改 \alpha → \beta 不是 claim 强度问题（由 Fact Preservation 管）
    const formulaChanged = "该方法显著改善检索质量。\n\\begin{equation}\n  q = \\beta r\n\\end{equation}";
    expect(
      checkClaimStrengthEscalation({ file: "f.tex", before: strong, after: formulaChanged, relatedEvidence: [] }),
    ).toHaveLength(0);
  });
});
