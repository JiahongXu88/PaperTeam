import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { JournalAssessmentPanel } from "../src/components/project/JournalAssessmentPanel.js";
import { renderWithProviders } from "./helpers.js";
import type { JournalAssessmentView, JournalCriterionView, JournalProfileSummaryView } from "../src/api/journalAssessment.js";

/**
 * M15 TJA：目标期刊评估面板（纯呈现 + 真实交互链路）。
 * - 空态 → 选期刊 / 稿型 → 生成评估（API 入参即用户选择）
 * - 报告：结论 / 分母披露 / 外部效度 / 未评估项 / 官方原句与来源
 * - 只有可改写的不符条目可勾选；转入修订调用后端且逐条提交
 */

vi.mock("../src/api/journalAssessment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/journalAssessment.js")>();
  return {
    ...actual,
    listJournalProfiles: vi.fn(),
    getJournalAssessment: vi.fn(),
    evaluateJournalAssessment: vi.fn(),
    refreshJournalProfile: vi.fn(),
    convertJournalCriteriaToRevision: vi.fn(),
  };
});
const api = await import("../src/api/journalAssessment.js");

const trust = { status: "VERIFIED_SNAPSHOT" as const, verifiedAt: "2026-11-02T00:00:00.000Z", ageDays: 0, trusted: true, note: "使用 2026-11-02 官方页面快照（0 天前；不是即时规则）" };
const profiles: JournalProfileSummaryView[] = [
  { journalId: "cjig", displayName: "中国图象图形学报", nameEn: "Journal of Image and Graphics", issn: ["1006-8961"], language: "zh", rulesVersion: "cjig-r1", ruleCount: 16, articleTypes: [], verification: trust, sourcePages: [] },
  { journalId: "plos-one", displayName: "PLOS ONE", nameEn: "PLOS ONE", issn: ["1932-6203"], language: "en", rulesVersion: "plos-r1", ruleCount: 10, articleTypes: [], verification: trust, sourcePages: [] },
];

function criterion(over: Partial<JournalCriterionView>): JournalCriterionView {
  return {
    criterionId: "rule:x", ruleId: "x", category: "submission_requirement", kind: "hard_deterministic", title: "条目", status: "SATISFIED", blocking: true, evidenceLevel: "verified",
    observed: "观测", expected: "期望", why: "依据", location: "abstract 环境", officialQuote: "官方原句", sourceUrl: "http://www.cjig.cn/zh/info/13448/", sourceStatus: "SNAPSHOT",
    reliability: "high", suggestion: "建议", actionability: "rewrite", convertible: false, requiresAuthorDecision: false, ...over,
  };
}

const assessment: JournalAssessmentView = {
  schemaVersion: "journal-assessment/v1",
  assessmentId: "ja-abc",
  projectId: "p-1",
  generatedAt: "2026-11-02T08:00:00.000Z",
  articleType: "research",
  manuscript: { revision: 2, revisionHash: "h", fidelity: "latex", fileCount: 2 },
  journal: { journalId: "cjig", displayName: "中国图象图形学报", profileHash: "ph", rulesVersion: "cjig-r1", verification: trust, sourcePages: [], indexing: [{ label: "北大《中文核心期刊要目总览》", status: "UNVERIFIED" }], scope: null },
  criteria: [
    criterion({ criterionId: "article-type:research", ruleId: "article-type:research", category: "article_type", kind: "article_type", title: "稿型是否在期刊受理范围" }),
    criterion({ criterionId: "rule:cjig-abstract-no-refs", ruleId: "cjig-abstract-no-refs", title: "摘要不得含文献号", status: "VIOLATED", observed: "摘要含：\\cite{r1}", officialQuote: "不得使用一次文献中列出的章节号、图号、表号、公式号以及参考文献号等。", convertible: true }),
    criterion({ criterionId: "rule:cjig-refs-15", ruleId: "cjig-refs-15", title: "参考文献 15 篇以上", status: "VIOLATED", actionability: "author_input", requiresAuthorDecision: true }),
    criterion({ criterionId: "rule:cjig-figures-dpi-3line", ruleId: "cjig-figures-dpi-3line", kind: "evidence_based", title: "图片 300dpi 以上、三线表", status: "NOT_EVALUATED", evidenceLevel: "author-check", gap: "需要：原始图像文件" }),
  ],
  riskFindings: [{ findingId: "fidelity:figures", source: "fidelity", category: "figures_tables", title: "图表视觉质量未审阅", evidenceLevel: "unassessed", affectsVerdict: false, detail: "未读取图像像素", location: "figure", suggestion: "自检" }],
  subjectiveEstimates: [],
  fitEvidence: [{ fitId: "fit:recent-publications", aspect: "recent_publications", status: "UNASSESSED", evidenceLevel: "unassessed", detail: "尚未建立参照", referenceKind: "POSITIVE_ONLY_REFERENCE" }],
  summary: {
    verdict: "BLOCKED_BY_VERIFIED_ISSUE",
    statement: "稿件违反目标期刊官方明文的必需要求",
    reasons: ["摘要不得含文献号：摘要含：\\cite{r1}"],
    observableRequirements: { satisfied: 8, violated: 2, denominator: 10, notEvaluated: 0, notApplicable: 1, authorCheck: 3, advisory: 1 },
    authorChecks: ["图片 300dpi 以上、三线表：需要：原始图像文件"],
    unknowns: [],
  },
  capabilities: { HISTORICAL_DECISION_PREDICTION: "DISABLED_NO_VALIDATED_DATA" },
  uncertainty: ["不预测录用：没有该刊的投稿记录与已确认拒稿负样本，录用概率预测禁用。"],
  externalValidity: { status: "EXTERNAL_CALIBRATION_NOT_VALIDATED", independentHumanLabels: 0, benchmarkProvenance: "", statement: "不代表达到该刊学术标准，也不预测录用。" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listJournalProfiles).mockResolvedValue(profiles);
});

describe("JournalAssessmentPanel", () => {
  it("空态 → 选 PLOS ONE + 系统综述 → 生成评估：API 入参即用户选择；显示来源可信状态", async () => {
    vi.mocked(api.getJournalAssessment).mockResolvedValue(null);
    vi.mocked(api.evaluateJournalAssessment).mockResolvedValue({ assessment: { ...assessment, journal: { ...assessment.journal, journalId: "plos-one", displayName: "PLOS ONE" } } });
    const user = userEvent.setup();
    renderWithProviders(<JournalAssessmentPanel projectId="p-1" />);
    expect(await screen.findByTestId("journal-assessment-empty")).toBeTruthy();
    expect(screen.getByTestId("journal-profile-trust").getAttribute("data-status")).toBe("VERIFIED_SNAPSHOT");
    expect(screen.getByTestId("journal-profile-trust").textContent).toContain("不是即时规则");
    await user.selectOptions(screen.getByTestId("journal-select"), "plos-one");
    await user.selectOptions(screen.getByTestId("journal-article-type"), "systematic_review");
    await user.click(screen.getByTestId("journal-evaluate"));
    await waitFor(() => expect(api.evaluateJournalAssessment).toHaveBeenCalledWith("p-1", { journalId: "plos-one", articleType: "systematic_review", includeModelReview: false }));
    expect(await screen.findByTestId("journal-assessment-report")).toBeTruthy();
  });

  it("报告：结论 / 分母披露 / 外部效度 / 官方原句；收录项未验证如实显示；不出现录用概率或分数", async () => {
    vi.mocked(api.getJournalAssessment).mockResolvedValue(assessment);
    renderWithProviders(<JournalAssessmentPanel projectId="p-1" />);
    const report = await screen.findByTestId("journal-assessment-report");
    expect(report.getAttribute("data-verdict")).toBe("BLOCKED_BY_VERIFIED_ISSUE");
    expect(screen.getByTestId("journal-verdict-chip").textContent).toBe("存在已证实的阻断问题");
    expect(screen.getByTestId("journal-observable-ratio").textContent).toContain("满足 8 / 已判定 10");
    expect(screen.getByTestId("journal-observable-ratio").textContent).toContain("主观与未知不计入分母");
    expect(screen.getByTestId("journal-external-validity").textContent).toContain("独立人类标签 0");
    const row = screen.getByTestId("journal-criterion-rule:cjig-abstract-no-refs");
    expect(row.getAttribute("data-status")).toBe("VIOLATED");
    expect(row.textContent).toContain("参考文献号");
    expect(screen.getByTestId("journal-gap-rule:cjig-figures-dpi-3line").textContent).toContain("原始图像文件");
    expect(screen.getByTestId("journal-indexing").textContent).toContain("未验证");
    expect(screen.getByTestId("journal-subjective").textContent).toContain("未评估");
    expect(report.textContent).not.toMatch(/录用概率\s*\d|\d+\s*分/);
  });

  it("只有可改写的不符条目可勾选；未勾选不能转入；转入调用后端并回显（不授权数值修改）", async () => {
    vi.mocked(api.getJournalAssessment).mockResolvedValue(assessment);
    vi.mocked(api.convertJournalCriteriaToRevision).mockResolvedValue({ created: [{ instructionId: "i-1" }], skipped: [] });
    const user = userEvent.setup();
    renderWithProviders(<JournalAssessmentPanel projectId="p-1" />);
    await screen.findByTestId("journal-assessment-report");
    expect(within(screen.getByTestId("journal-criterion-rule:cjig-refs-15")).queryByRole("checkbox")).toBeNull();
    const convert = screen.getByTestId("journal-convert") as HTMLButtonElement;
    expect(convert.disabled).toBe(true);
    await user.click(screen.getByTestId("journal-select-rule:cjig-abstract-no-refs"));
    expect(convert.disabled).toBe(false);
    await user.click(convert);
    await waitFor(() => expect(api.convertJournalCriteriaToRevision).toHaveBeenCalledWith("p-1", { assessmentId: "ja-abc", criterionIds: ["rule:cjig-abstract-no-refs"] }));
    expect((await screen.findByTestId("journal-message")).textContent).toContain("不授权任何数值修改");
  });
});
