import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PublicationTargetCard } from "../src/components/project/PublicationTargetCard.js";
import { draftToInput, EMPTY_PUBLICATION_TARGET, validatePublicationDraft } from "../src/components/project/PublicationTargetFields.js";
import { QualityReportLayers } from "../src/components/project/QualityReportLayers.js";
import { NewProjectPage } from "../src/pages/NewProjectPage.js";
import type { ProjectView, PublicationTargetOptionsView, WorkflowRunView } from "../src/types/api.js";
import type { QualityReportView } from "../src/types/qualityReport.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 发表目标（publication-target/v1）前端验收（T8 UI 部分）：
 * - 创建新论文：可选体系 → 层级（来自后端 options），提交时发送 publicationTarget；不选 = 不发送（旧行为）
 * - 项目详情：未核实层级如实标注；修改提示「只影响下一次运行」；展示最近一次运行冻结的政策
 * - 质量报告：显示后端绑定的审稿政策 + 不预测录用声明；无绑定（旧产物）不显示
 * - 任何界面不出现「100% 达刊」「保证录用」类表述
 */

const OPTIONS: PublicationTargetOptionsView = {
  policyVersion: "publication-review-policy/1",
  schemes: [
    { scheme: "none", label: "未设置发表目标", tiers: [] },
    { scheme: "chinese_index", label: "中文核心类收录", tiers: [{ tier: "PKU_CORE", label: "北大核心" }, { tier: "CSCD", label: "CSCD" }, { tier: "CSSCI", label: "CSSCI" }], note: "北大核心、CSCD、CSSCI 是彼此独立的收录 / 评价体系，不是同一条等级线" },
    { scheme: "cas", label: "中科院分区", tiers: [{ tier: "1", label: "中科院一区" }, { tier: "2", label: "中科院二区" }, { tier: "3", label: "中科院三区" }, { tier: "4", label: "中科院四区" }], note: "中科院分区与 JCR 分区是两套体系" },
    { scheme: "jcr", label: "JCR 分区", tiers: [{ tier: "Q1", label: "JCR Q1" }, { tier: "Q2", label: "JCR Q2" }, { tier: "Q3", label: "JCR Q3" }, { tier: "Q4", label: "JCR Q4" }] },
  ],
  journals: [{ journalId: "cjig", displayName: "中国图象图形学报", language: "zh", rulesVersion: "2026.11.02-1", retrievedAt: "2026-11-02T00:00:00Z", verification: { status: "VERIFIED_SNAPSHOT", trusted: true }, indexing: [] }],
  statement: "发表目标用于决定审稿关注点；不预测录用。",
};

vi.mock("../src/api/projects.js", () => ({
  listProjects: vi.fn(async () => []),
  getProject: vi.fn(),
  createProject: vi.fn(),
  importProjectPaper: vi.fn(),
  getManuscriptOverview: vi.fn(),
  getPublicationTargetOptions: vi.fn(async () => OPTIONS),
  updatePublicationTarget: vi.fn(),
}));
vi.mock("../src/api/runs.js", () => ({
  listProjectRuns: vi.fn(async () => []),
  createWorkflowRun: vi.fn(async () => ({ runId: "w-1", status: "pending" })),
}));
vi.mock("../src/api/runtime.js", () => ({
  getRuntimeStatus: vi.fn(async () => ({ backend: { ok: true }, runtime: { provider: "pi", phase: "healthy" }, model: { phase: "configured", providers: [] }, agents: { roles: [] }, sessions: { activeRuns: 0, managedSessions: 0 } })),
}));

const { createProject, updatePublicationTarget } = await import("../src/api/projects.js");
const { listProjectRuns } = await import("../src/api/runs.js");

const PROJECT: ProjectView = {
  id: "p-pub000000001", title: "目标项目", status: "created", createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z",
  workflowKind: "existing_paper_improvement", documentType: "research_article",
};

beforeEach(() => {
  vi.mocked(createProject).mockReset();
  vi.mocked(updatePublicationTarget).mockReset();
  vi.mocked(listProjectRuns).mockReset().mockResolvedValue([]);
});

describe("发表目标草稿 → API 输入", () => {
  it("未设置 → null；体系需层级；自填期刊名可单独设置；年份校验", () => {
    expect(draftToInput(EMPTY_PUBLICATION_TARGET)).toBeNull();
    expect(validatePublicationDraft({ ...EMPTY_PUBLICATION_TARGET, scheme: "jcr" })).toMatch(/请选择层级/);
    expect(validatePublicationDraft({ ...EMPTY_PUBLICATION_TARGET, scheme: "jcr", tier: "Q2", schemeYear: "25" })).toMatch(/四位数字/);
    expect(draftToInput({ ...EMPTY_PUBLICATION_TARGET, scheme: "cas", tier: "3", schemeYear: "2025" })).toEqual({ scheme: "cas", tier: "3", schemeYear: 2025 });
    expect(draftToInput({ ...EMPTY_PUBLICATION_TARGET, journalMode: "custom", customJournalName: " 某期刊 " })).toEqual({ scheme: "none", customJournalName: "某期刊" });
  });
});

describe("创建新论文：发表目标（可选）", () => {
  it("选择 CAS 三区 + 已核验期刊 → createProject 携带 publicationTarget；层级选项来自后端", async () => {
    vi.mocked(createProject).mockResolvedValue({ ...PROJECT, workflowKind: "idea_to_paper" });
    const user = userEvent.setup();
    renderWithProviders(<NewProjectPage />, { route: "/projects/new" });
    const form = await screen.findByTestId("research-article-form");
    await user.type(within(form).getByLabelText(/论文标题/), "目标测试");
    await waitFor(() => expect(within(form).getByLabelText("目标发表体系（可选）")).not.toBeDisabled());
    await user.selectOptions(within(form).getByLabelText("目标发表体系（可选）"), "cas");
    await user.selectOptions(within(form).getByLabelText("层级"), "3");
    await user.selectOptions(within(form).getByLabelText("目标期刊（可选）"), "verified");
    await user.selectOptions(within(form).getByLabelText("已核验期刊"), "cjig");
    expect(within(form).getByTestId("publication-target-help").textContent).toContain("不预测录用");
    await user.click(within(form).getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createProject).mock.calls[0]![0]).toMatchObject({ documentType: "research_article", publicationTarget: { scheme: "cas", tier: "3", targetJournalId: "cjig" } });
  });

  it("不设置发表目标 → 请求不含 publicationTarget（旧行为）", async () => {
    vi.mocked(createProject).mockResolvedValue({ ...PROJECT, workflowKind: "idea_to_paper" });
    const user = userEvent.setup();
    renderWithProviders(<NewProjectPage />, { route: "/projects/new" });
    const form = await screen.findByTestId("research-article-form");
    await user.type(within(form).getByLabelText(/论文标题/), "无目标");
    await user.click(within(form).getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createProject).mock.calls[0]![0]).not.toHaveProperty("publicationTarget");
  });
});

describe("项目详情：发表目标卡", () => {
  it("显示未核实提示与最近一次运行冻结的政策；修改提示只影响下一次运行；保存发送 PATCH", async () => {
    const project: ProjectView = { ...PROJECT, publicationTarget: { schemaVersion: "publication-target/v1", scheme: "jcr", tier: "Q2", schemeYear: 2025, updatedAt: "2026-11-03T00:00:00Z" } };
    vi.mocked(listProjectRuns).mockResolvedValue([{
      runId: "w-1", projectId: project.id, workflowKind: "existing_paper_improvement", status: "completed", createdAt: "", updatedAt: "",
      reviewPolicy: { schemaVersion: "review-policy/v1", policyVersion: "publication-review-policy/1", policyHash: "abc", frozenAt: "2026-11-02T00:00:00Z", articleType: "research", target: { schemaVersion: "publication-target/v1", scheme: "cas", tier: "2", updatedAt: "" }, targetJournal: null, tierFact: { status: "USER_TARGET_UNVERIFIED", note: "" }, emphasis: "elevated", focus: [], active: true },
    } as WorkflowRunView]);
    vi.mocked(updatePublicationTarget).mockResolvedValue({ ...project, publicationTarget: undefined });
    const user = userEvent.setup();
    renderWithProviders(<PublicationTargetCard project={project} />);
    expect(screen.getByTestId("publication-target-current").textContent).toBe("JCR Q2（2025 年名单）");
    expect(screen.getByTestId("publication-target-unverified").textContent).toContain("系统未核实任何期刊的分区 / 收录事实");
    expect((await screen.findByTestId("publication-target-frozen")).textContent).toContain("中科院二区");
    await user.click(screen.getByTestId("publication-target-edit"));
    expect(screen.getByText(/新设置只影响下一次审稿 \/ 修订运行/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("目标发表体系（可选）")).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText("目标发表体系（可选）"), "none");
    await user.click(screen.getByTestId("publication-target-save"));
    await waitFor(() => expect(updatePublicationTarget).toHaveBeenCalledWith(project.id, null));
  });
});

function report(binding: Partial<QualityReportView["binding"]>): QualityReportView {
  const layer = (id: "L0" | "L1" | "L2" | "L3" | "L4") => ({ layer: id, title: id, status: (id === "L4" ? "UNVALIDATED" : "PASS") as never, items: [], blocking: [], unknowns: [] });
  return {
    schemaVersion: "quality-report/v1", generatedAt: "",
    binding: { reviewedRevision: 3, reviewRound: 2, inputFingerprint: "f", runId: "w-1", entry: "workflow", workflowKind: "existing_paper_improvement", reviewPurpose: null, ...binding },
    layers: { L0: layer("L0"), L1: layer("L1"), L2: layer("L2"), L3: layer("L3"), L4: layer("L4") },
    overall: { status: "PASS", finalizable: true, reasons: [], unknowns: [], statement: "ok" },
    compat: { legacyPassedDerived: true, rulePassedBeforeReport: true, difference: null, meaning: "" },
    externalValidity: { independentHumanLabels: 0, scoreCalibrated: false, targetJournalValidated: false, statement: "未校准" },
  };
}

describe("质量报告：审稿政策来源", () => {
  it("有绑定 → 显示目标与未核实状态 + 不预测录用；旧产物无绑定 → 不显示；无达标徽章", () => {
    const { unmount } = renderWithProviders(<QualityReportLayers report={report({ reviewPolicy: { policyVersion: "publication-review-policy/1", policyHash: "h", articleType: "survey", targetLabel: "CSSCI", tierFactStatus: "USER_TARGET_UNVERIFIED", journal: null } })} />);
    const line = screen.getByTestId("quality-report-review-policy").textContent ?? "";
    expect(line).toContain("综述论文");
    expect(line).toContain("发表目标「CSSCI」（用户设定目标，未核实）");
    expect(line).toContain("不预测录用");
    expect(document.body.textContent).not.toMatch(/100%|保证录用|达到.{0,4}(一区|Q1)/);
    unmount();
    renderWithProviders(<QualityReportLayers report={report({})} />);
    expect(screen.queryByTestId("quality-report-review-policy")).toBeNull();
  });
});
