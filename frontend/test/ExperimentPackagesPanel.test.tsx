import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExperimentPackagesPanel } from "../src/components/project/ExperimentPackagesPanel.js";
import { renderWithProviders } from "./helpers.js";
import type { ExperimentPackageSummaryView, ExperimentPackageView, ObservationQueryResult } from "../src/api/experimentPackages.js";

vi.mock("../src/api/experimentPackages.js", () => ({
  listExperimentPackages: vi.fn(), getExperimentPackage: vi.fn(), uploadExperimentPackage: vi.fn(),
  editExperimentFile: vi.fn(), confirmExperimentGroups: vi.fn(), confirmExperimentMetricEvidence: vi.fn(),
  requestExperimentUnderstanding: vi.fn(), setExperimentScopeWorkflowUse: vi.fn(), queryExperimentObservations: vi.fn(),
}));
const api = await import("../src/api/experimentPackages.js");

const packageView: ExperimentPackageView = {
  schemaVersion: 2, packageId: `ep-${"a".repeat(32)}`, packageHash: "a".repeat(64), originalName: "synthetic-normal.zip", importedAt: "2026-10-08T00:00:00Z", status: "ready",
  files: [{ path: "main/results.csv", hash: "b".repeat(64), bytes: 80, kind: "csv", parseStatus: "ok", sourceId: "S001", role: "main_result", roleBasis: "结果路径", roleConfidence: "high", groupId: "main" }],
  groups: [{
    id: "main", role: "main", filePaths: ["main/results.csv"], basis: "路径候选", status: "candidate", conflicts: [],
    splitScopes: [{ id: "main@Dev25", split: "Dev25", status: "candidate", conflicts: [], workflowUse: "undecided", observationCount: 1, metricCount: 1, filePaths: ["main/results.csv"], protocols: [] }],
  }],
  observations: [{ sourceId: "S001", path: "main/results.csv", blockId: "B0001", row: 2, column: "D", method: "Ours", dataset: "MOT17", seed: "42", split: "Dev25", metric: "HOTA", value: 63.4, unit: "unknown", direction: "unknown", groupId: "main" }],
  relationCandidates: [], warnings: [],
};
const packageSummary: ExperimentPackageSummaryView = {
  packageId: packageView.packageId, packageHash: packageView.packageHash, originalName: packageView.originalName,
  importedAt: packageView.importedAt, status: "ready", fileCount: 1, groupCount: 1, observationCount: 1, warningCount: 0,
};
const observationQuery: ObservationQueryResult = {
  total: 1, page: 1, pageSize: 50,
  observations: packageView.observations,
  facets: { splits: ["Dev25"], groupIds: ["main"], methods: ["Ours"], metrics: ["HOTA"], paths: ["main/results.csv"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listExperimentPackages).mockResolvedValue([packageSummary]);
  vi.mocked(api.getExperimentPackage).mockResolvedValue(packageView);
  vi.mocked(api.uploadExperimentPackage).mockResolvedValue(packageView);
  vi.mocked(api.queryExperimentObservations).mockResolvedValue(observationQuery);
  vi.mocked(api.confirmExperimentGroups).mockResolvedValue({ ...packageView, groups: [{ ...packageView.groups[0]!, status: "confirmed", splitScopes: [{ ...packageView.groups[0]!.splitScopes![0]!, status: "confirmed", workflowUse: "undecided" }] }] });
  vi.mocked(api.editExperimentFile).mockResolvedValue(packageView);
  vi.mocked(api.setExperimentScopeWorkflowUse).mockResolvedValue({ ...packageView, groups: [{ ...packageView.groups[0]!, status: "confirmed", splitScopes: [{ ...packageView.groups[0]!.splitScopes![0]!, status: "confirmed", workflowUse: "allowed" }] }] });
});

describe("ExperimentPackagesPanel（M13.5 工作台）", () => {
  it("展示摘要卡、评测范围表与指标（经查询 API），按范围确认走 scopeIds", async () => {
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    // 摘要卡
    expect(await screen.findByText("指标观测")).toBeTruthy();
    // 范围表：split 值 + 确认按钮
    expect(await screen.findByText("Dev25")).toBeTruthy();
    // 指标浏览（服务端查询）：真实值可见
    expect(await screen.findByText("63.4")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "确认此范围" }));
    await waitFor(() => expect(api.confirmExperimentGroups).toHaveBeenCalledWith("p-test", packageView.packageId, [], ["main@Dev25"]));
  });

  it("确认后可授权进入工作流（与确认独立的隔离决策）", async () => {
    const confirmedView: ExperimentPackageView = {
      ...packageView,
      groups: [{ ...packageView.groups[0]!, status: "confirmed", splitScopes: [{ ...packageView.groups[0]!.splitScopes![0]!, status: "confirmed" }] }],
    };
    // 确认调用后，详情刷新返回已确认视图（getExperimentPackage 是刷新事实源）
    vi.mocked(api.getExperimentPackage).mockResolvedValue(packageView);
    vi.mocked(api.confirmExperimentGroups).mockImplementation(async () => {
      vi.mocked(api.getExperimentPackage).mockResolvedValue(confirmedView);
      return confirmedView;
    });
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    await userEvent.click(await screen.findByRole("button", { name: "确认此范围" }));
    await waitFor(() => expect(api.confirmExperimentGroups).toHaveBeenCalled());
    // 确认后刷新的数据里 scope 已确认 → 出现授权按钮
    await userEvent.click(await screen.findByRole("button", { name: "允许进入工作流" }));
    await waitFor(() => expect(api.setExperimentScopeWorkflowUse).toHaveBeenCalledWith("p-test", packageView.packageId, "main@Dev25", "allowed"));
  });

  it("上传真实 File 对象并显示处理反馈", async () => {
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    const file = new File(["PK\x03\x04"], "synthetic.zip", { type: "application/zip" });
    await userEvent.upload(screen.getByLabelText("选择实验 ZIP"), file);
    await userEvent.click(screen.getByText("上传实验包"));
    await waitFor(() => expect(api.uploadExperimentPackage).toHaveBeenCalledWith("p-test", file));
    expect(await screen.findByText(/实验包已读取/)).toBeTruthy();
  });
});
