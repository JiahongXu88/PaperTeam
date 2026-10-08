import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExperimentPackagesPanel } from "../src/components/project/ExperimentPackagesPanel.js";
import { renderWithProviders } from "./helpers.js";
import type { ExperimentPackageView } from "../src/api/experimentPackages.js";

vi.mock("../src/api/experimentPackages.js", () => ({
  listExperimentPackages: vi.fn(), getExperimentPackage: vi.fn(), uploadExperimentPackage: vi.fn(),
  editExperimentFile: vi.fn(), confirmExperimentGroups: vi.fn(), confirmExperimentMetricEvidence: vi.fn(),
}));
const api = await import("../src/api/experimentPackages.js");

const packageView: ExperimentPackageView = {
  schemaVersion: 1, packageId: `ep-${"a".repeat(32)}`, packageHash: "a".repeat(64), originalName: "synthetic-normal.zip", importedAt: "2026-10-08T00:00:00Z", status: "ready",
  files: [{ path: "main/results.csv", hash: "b".repeat(64), bytes: 80, kind: "csv", parseStatus: "ok", sourceId: "S001", role: "main_result", roleBasis: "结果路径", roleConfidence: "high", groupId: "main" }],
  groups: [{ id: "main", role: "main", filePaths: ["main/results.csv"], basis: "路径候选", status: "candidate", conflicts: [] }],
  observations: [{ sourceId: "S001", path: "main/results.csv", blockId: "B0001", row: 2, column: "D", method: "Ours", dataset: "MOT17", seed: "42", metric: "HOTA", value: 63.4, unit: "unknown", direction: "unknown", groupId: "main" }],
  relationCandidates: [], warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listExperimentPackages).mockResolvedValue([packageView]);
  vi.mocked(api.getExperimentPackage).mockResolvedValue(packageView);
  vi.mocked(api.uploadExperimentPackage).mockResolvedValue(packageView);
  vi.mocked(api.confirmExperimentGroups).mockResolvedValue({ ...packageView, groups: [{ ...packageView.groups[0]!, status: "confirmed" }] });
  vi.mocked(api.editExperimentFile).mockResolvedValue(packageView);
});

describe("ExperimentPackagesPanel", () => {
  it("shows parsed source values and confirms candidate groups through API", async () => {
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    expect(await screen.findByText("main/results.csv")).toBeTruthy();
    expect(screen.getByText("63.4")).toBeTruthy();
    await userEvent.click(screen.getByText("确认此组"));
    await waitFor(() => expect(api.confirmExperimentGroups).toHaveBeenCalledWith("p-test", packageView.packageId, ["main"]));
  });
  it("uploads a real File object through the API client and shows processing feedback", async () => {
    renderWithProviders(<ExperimentPackagesPanel projectId="p-test" />);
    const file = new File(["PK\x03\x04"], "synthetic.zip", { type: "application/zip" });
    await userEvent.upload(screen.getByLabelText("选择实验 ZIP"), file);
    await userEvent.click(screen.getByText("上传实验包"));
    await waitFor(() => expect(api.uploadExperimentPackage).toHaveBeenCalledWith("p-test", file));
    expect(await screen.findByText(/已读取实验包/)).toBeTruthy();
  });
});
