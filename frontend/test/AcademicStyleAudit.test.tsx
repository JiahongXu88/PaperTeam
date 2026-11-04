import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { AcademicStyleAuditCardView } from "../src/components/project/AcademicStyleAuditPanel.js";
import type { AcademicStyleAuditView, AcademicStyleFindingView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M17.1 默认学术风格审查卡：覆盖状态如实（部分审查 / 未审查不显示为通过）、已修订 before/after、
 * 「需要证据或作者决定」显示为未修改、无 AI 率字段。句子均为人工构造。
 */

const finding = (partial: Partial<AcademicStyleFindingView>): AcademicStyleFindingView => ({
  id: "sty-1", file: "sections/d.tex", heading: "讨论", originalQuote: "本文仅是一次粗浅的尝试，敬请批评指正。",
  styleCategory: "repeated_modesty_apology", candidateReason: "无信息自谦", necessityJudgment: "UNNECESSARY", evidenceConstraints: [],
  suggestedAction: "MINIMAL_REWRITE", proposedRewrite: "", disposition: "AUTO_REWRITE_ELIGIBLE", dispositionReason: "纯措辞", revisionStatus: "NOT_DISPATCHED",
  ...partial,
});

function view(state: "COMPLETE" | "PARTIAL"): AcademicStyleAuditView {
  return {
    reviewedRevision: 3,
    report: {
      round: 2, reviewedRevision: 3, generatedAt: "2026-11-04T00:00:00.000Z",
      coverage: { state, eligibleUnits: 3, completedUnits: state === "COMPLETE" ? 3 : 2, reusedUnits: 0, failedUnits: state === "COMPLETE" ? 0 : 1, skippedUnits: 0, notApplicableUnits: 1, reasons: [] },
      units: [
        { unitId: "u1", file: "sections/d.tex", heading: "讨论", status: "COMPLETE", findings: 2 },
        ...(state === "PARTIAL" ? [{ unitId: "u2", file: "sections/e.tex", heading: "实验", status: "FAILED" as const, error: "timeout", findings: 0 }] : []),
      ],
      findings: [
        finding({}),
        finding({ id: "sty-2", originalQuote: "该方法在一定程度上可以缓解遮挡问题。", styleCategory: "understated_contribution", disposition: "AUTHOR_DECISION", dispositionReason: "贡献表述是否可加强取决于证据", revisionStatus: "AUTHOR_DECISION" }),
        finding({ id: "sty-3", originalQuote: "由于未在夜间场景数据上验证，结论能否推广尚不确定。", styleCategory: "required_limitation", disposition: "KEEP", dispositionReason: "科学必要限定", revisionStatus: "KEPT", evidenceConstraints: ["未在夜间场景验证"] }),
      ],
      counts: { findings: 3, byCategory: { repeated_modesty_apology: 1, understated_contribution: 1, required_limitation: 1 }, byDisposition: { AUTO_REWRITE_ELIGIBLE: 1, KEEP: 1, AUTHOR_DECISION: 1 }, unanchored: 0 },
      disclaimer: "「AI 写作风格风险」不是对作者身份或 AI 生成来源的鉴定。",
    },
    revision: {
      reviewRound: 2, sourceRevision: 3, revision: 4, status: "applied",
      items: [{ findingId: "sty-1", file: "sections/d.tex", heading: "讨论", styleCategory: "repeated_modesty_apology", before: "本文仅是一次粗浅的尝试，敬请批评指正。", after: "", status: "AUTO_FIXED", detail: "ok" }],
    },
  };
}

describe("AcademicStyleAuditCardView", () => {
  it("已审查：覆盖 / 计数 / 修订号 / before-after；待作者决定显示为未修改；无 AI 率", () => {
    renderWithProviders(<AcademicStyleAuditCardView view={view("COMPLETE")} />);
    expect(screen.getByTestId("academic-style-coverage").textContent).toBe("已审查");
    expect(screen.getByTestId("academic-style-counts").textContent).toContain("本轮 3 条（可自动修订 1 · 保留 1 · 待作者决定 1）");
    expect(screen.getByTestId("academic-style-revision").textContent).toContain("rev 3 → rev 4");
    expect(screen.getByTestId("academic-style-fixed").textContent).toContain("（整句删除）");
    expect(screen.getByTestId("academic-style-unresolved").textContent).toContain("未修改：需要证据或作者决定");
    expect(screen.getByTestId("academic-style-kept").textContent).toContain("未在夜间场景验证");
    expect(screen.getByTestId("academic-style-audit-card").textContent).not.toMatch(/AI ?率|AI 概率\s*\d/);
  });

  it("部分审查：显式警示未完成单元，不显示为已审查", () => {
    renderWithProviders(<AcademicStyleAuditCardView view={view("PARTIAL")} />);
    expect(screen.getByTestId("academic-style-coverage").textContent).toBe("部分审查");
    expect(screen.getByTestId("academic-style-incomplete").textContent).toContain("实验（失败）");
    expect(screen.getByTestId("academic-style-incomplete").textContent).toContain("不代表没有问题");
  });
});
