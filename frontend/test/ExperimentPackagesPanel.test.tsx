import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExperimentPackagesPanel } from "../src/components/project/ExperimentPackagesPanel.js";
import { renderWithProviders } from "./helpers.js";
import type { ExperimentPackageSummaryView, ExperimentPackageView, ObservationQueryResult } from "../src/api/experimentPackages.js";
import { EXPERIMENT_ARCHIVE_MAX_BYTES } from "../src/api/experimentPackages.js";

vi.mock("../src/api/experimentPackages.js", () => ({
  EXPERIMENT_ARCHIVE_MAX_BYTES: 16 * 1024 * 1024,
  experimentArchiveLimitMessage: (file: File) => `ZIP 文件过大：当前文件 ${(file.size / (1024 * 1024)).toFixed(2)} MiB，最大允许 16 MiB。请精简实验包后重试。文件：${file.name}`,
  listExperimentPackages: vi.fn(), getExperimentPackage: vi.fn(), uploadExperimentPackage: vi.fn(),
  editExperimentFile: vi.fn(), confirmExperimentGroups: vi.fn(), confirmExperimentMetricEvidence: vi.fn(),
  requestExperimentUnderstanding: vi.fn(), setExperimentScopeWorkflowUse: vi.fn(), queryExperimentObservations: vi.fn(),
  rebuildExperimentPackage: vi.fn(), ensureExperimentPackagesUpgraded: vi.fn(), applyExperimentWorkflowUse: vi.fn(),
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
  vi.mocked(api.ensureExperimentPackagesUpgraded).mockResolvedValue({ upgraded: [], preservedConfirmations: [], resetConfirmations: [] });
  vi.mocked(api.applyExperimentWorkflowUse).mockResolvedValue({ ...packageView, groups: [{ ...packageView.groups[0]!, status: "confirmed", splitScopes: [{ ...packageView.groups[0]!.splitScopes![0]!, status: "confirmed", workflowUse: "allowed" }] }] });
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

  it("v1 旧包显示「重新整理分组」入口；二次确认后调用 rebuild 并刷新为范围级视图", async () => {
    const legacyView: ExperimentPackageView = {
      ...packageView,
      schemaVersion: 1,
      groups: [{ id: "main", role: "main", filePaths: ["main/results.csv"], basis: "路径候选", status: "conflict", conflicts: ["split 不一致：Dev25 / Confirmation13 / Full38"] }],
    };
    vi.mocked(api.getExperimentPackage).mockResolvedValue(legacyView);
    vi.mocked(api.rebuildExperimentPackage).mockImplementation(async () => {
      vi.mocked(api.getExperimentPackage).mockResolvedValue(packageView);
      return packageView;
    });
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    expect(await screen.findByTestId("legacy-package-notice")).toBeInTheDocument();
    // 一次点击只进入二次确认，不调用 API
    await userEvent.click(screen.getByTestId("rebuild-package"));
    expect(api.rebuildExperimentPackage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("rebuild-package-confirm"));
    await waitFor(() => expect(api.rebuildExperimentPackage).toHaveBeenCalledWith("p-test", packageView.packageId));
    // 刷新后是 v2 范围级视图：通知消失，出现范围确认按钮
    await waitFor(() => expect(screen.queryByTestId("legacy-package-notice")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "确认此范围" })).toBeInTheDocument();
  });

  it("上传真实 File 对象并显示处理反馈", async () => {
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    const file = new File(["PK\x03\x04"], "synthetic.zip", { type: "application/zip" });
    await userEvent.upload(screen.getByLabelText("选择实验 ZIP"), file);
    await userEvent.click(screen.getByText("上传实验包"));
    await waitFor(() => expect(api.uploadExperimentPackage).toHaveBeenCalledWith("p-test", file));
    expect(await screen.findByText(/实验包已读取/)).toBeTruthy();
  });

  it("超限文件在上传前显示含文件名的中文错误，且可选择新文件重试", async () => {
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    const input = screen.getByLabelText("选择实验 ZIP");
    const large = new File(["x"], "results-20MiB.zip", { type: "application/zip" });
    Object.defineProperty(large, "size", { value: 20 * 1024 * 1024 });
    await userEvent.upload(input, large);
    await userEvent.click(screen.getByRole("button", { name: "上传实验包" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ZIP 文件过大：当前文件 20.00 MiB，最大允许 16 MiB。");
    expect(screen.getByRole("alert")).toHaveTextContent("results-20MiB.zip");
    expect(api.uploadExperimentPackage).not.toHaveBeenCalled();

    const valid = new File(["PK\x03\x04"], "retry.zip", { type: "application/zip" });
    Object.defineProperty(valid, "size", { value: EXPERIMENT_ARCHIVE_MAX_BYTES });
    await userEvent.upload(input, valid);
    await userEvent.click(screen.getByRole("button", { name: "上传实验包" }));
    await waitFor(() => expect(api.uploadExperimentPackage).toHaveBeenCalledWith("p-test", valid));
  });

  it("M13.6：列表含 v1 旧包时自动调用 ensure-upgraded 并刷新", async () => {
    vi.mocked(api.listExperimentPackages).mockResolvedValue([{ ...packageSummary, schemaVersion: 1 }]);
    vi.mocked(api.ensureExperimentPackagesUpgraded).mockResolvedValue({
      upgraded: [packageView.packageId],
      preservedConfirmations: [],
      resetConfirmations: [{ packageId: packageView.packageId, groupId: "main", reason: "升级后划分为 3 个评测范围" }],
    });
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    await waitFor(() => expect(api.ensureExperimentPackagesUpgraded).toHaveBeenCalledWith("p-test"));
    expect(await screen.findByText(/已自动升级 1 个旧版实验包/)).toBeTruthy();
    await waitFor(() => expect(api.listExperimentPackages).toHaveBeenCalledTimes(2));
  });

  it("M13.6：单范围包默认勾选，一次「用于本文写作」提交 groupIds（确认 + 授权合一）", async () => {
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    expect(await screen.findByTestId("use-for-paper-check-main@Dev25")).toBeTruthy();
    expect(screen.getByTestId("use-for-paper-check-main@Dev25")).toBeChecked();
    await userEvent.click(screen.getByTestId("use-for-paper-submit"));
    await waitFor(() => expect(api.applyExperimentWorkflowUse).toHaveBeenCalledWith("p-test", packageView.packageId, { groupIds: ["main"] }));
  });

  it("M13.6：多范围包按范围勾选一次提交（未勾选的已授权范围被显式排除）", async () => {
    const multiScopeView: ExperimentPackageView = {
      ...packageView,
      groups: [{
        id: "main", role: "main", filePaths: ["main/results.csv"], basis: "路径候选", status: "candidate", conflicts: [],
        splitScopes: [
          { id: "main@Confirmation13", split: "Confirmation13", status: "confirmed", conflicts: [], workflowUse: "allowed", observationCount: 8, metricCount: 2, filePaths: ["main/results.csv"], protocols: [] },
          { id: "main@Dev25", split: "Dev25", status: "candidate", conflicts: [], workflowUse: "undecided", observationCount: 8, metricCount: 2, filePaths: ["main/results.csv"], protocols: [] },
          { id: "main@Full38", split: "Full38", status: "candidate", conflicts: [], workflowUse: "undecided", observationCount: 20, metricCount: 2, filePaths: ["main/results.csv"], protocols: [] },
        ],
      }],
    };
    vi.mocked(api.getExperimentPackage).mockResolvedValue(multiScopeView);
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    const devCheck = await screen.findByTestId("use-for-paper-check-main@Dev25");
    expect(screen.getByTestId("use-for-paper-check-main@Confirmation13")).toBeChecked();
    expect(devCheck).not.toBeChecked();
    expect(screen.getByTestId("use-for-paper-check-main@Full38")).not.toBeChecked();
    await userEvent.click(devCheck);
    await userEvent.click(screen.getByTestId("use-for-paper-check-main@Confirmation13"));
    await userEvent.click(screen.getByTestId("use-for-paper-submit"));
    await waitFor(() =>
      expect(api.applyExperimentWorkflowUse).toHaveBeenCalledWith("p-test", packageView.packageId, {
        scopeIds: ["main@Dev25"],
        excludeScopeIds: ["main@Confirmation13"],
      }),
    );
  });

  it("M13.6：有冲突的范围不可勾选并说明原因（不偷偷放行）", async () => {
    const conflictView: ExperimentPackageView = {
      ...packageView,
      groups: [{
        id: "main", role: "main", filePaths: ["main/results.csv"], basis: "路径候选", status: "conflict", conflicts: ["来源已删除"],
        splitScopes: [{ id: "main@Dev25", split: "Dev25", status: "candidate", conflicts: [], workflowUse: "undecided", observationCount: 1, metricCount: 1, filePaths: ["main/results.csv"], protocols: [] }],
      }],
    };
    vi.mocked(api.getExperimentPackage).mockResolvedValue(conflictView);
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    const check = await screen.findByTestId("use-for-paper-check-main@Dev25");
    expect(check).toBeDisabled();
    expect(screen.getByText("所在实验组有未解决冲突")).toBeTruthy();
  });
});
