/**
 * M17.2 前端：浏览器端确定性打包 + 实验事实快照区（SYNTHETIC 数据）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { crc32 as nodeCrc32 } from "node:zlib";

import { buildStoreZipBytes, bundleExperimentFiles, crc32 } from "../src/api/storeZip.js";
import type { ActiveSnapshotView, SnapshotPreviewView } from "../src/api/experimentPackages.js";
import { renderWithProviders } from "./helpers.js";

vi.mock("../src/api/experimentPackages.js", () => ({
  getSnapshotPreview: vi.fn(), freezeExperimentSnapshot: vi.fn(), listExperimentSnapshots: vi.fn(),
  getActiveExperimentSnapshot: vi.fn(), decideExperimentFacts: vi.fn(),
}));
const api = await import("../src/api/experimentPackages.js");
const { ExperimentSnapshotSection } = await import("../src/components/project/ExperimentSnapshotSection.js");

describe("storeZip（浏览器端确定性打包）", () => {
  it("CRC32 与 zlib 一致；同一组文件（任意顺序）→ 同一 ZIP 字节", () => {
    const data = new TextEncoder().encode("method,HOTA (%)\nours,49.830\n");
    expect(crc32(data)).toBe(nodeCrc32(data) >>> 0);
    const a = buildStoreZipBytes([{ path: "b.csv", data }, { path: "a.json", data }]);
    const b = buildStoreZipBytes([{ path: "a.json", data }, { path: "b.csv", data }]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it("只接受实验结果类扩展名；重名路径拒绝；单文件命名保留原名", async () => {
    await expect(bundleExperimentFiles([new File(["x"], "run.py")])).rejects.toThrow(/不支持的文件类型/);
    await expect(bundleExperimentFiles([new File(["a"], "r.csv"), new File(["b"], "r.csv")])).rejects.toThrow(/重复/);
    const bundled = await bundleExperimentFiles([new File(["seq,HOTA\nCOMBINED,0.47\n"], "pedestrian_detailed.csv")]);
    expect(bundled.name).toBe("pedestrian_detailed.csv.zip");
    expect(bundled.type).toBe("application/zip");
  });
});

const preview: SnapshotPreviewView = {
  facts: [
    { factId: "f-aaaaaaaaaaaaaaaa", sourceLocator: "sha256:1111 · main/summary.csv · row=2 · col=HOTA (%)", path: "main/summary.csv", metric: "HOTA", metricKey: "HOTA", value: 49.830, rawText: "49.830", unit: "percentage", method: "ours", groupRole: "main" },
    { factId: "f-bbbbbbbbbbbbbbbb", sourceLocator: "sha256:2222 · baseline/summary.csv · row=2 · col=HOTA (%)", path: "baseline/summary.csv", metric: "HOTA", metricKey: "HOTA", value: 47.250, rawText: "47.250", unit: "percentage", method: "base", groupRole: "baseline" },
  ],
  factCount: 2,
  comparisons: [{
    comparisonId: "cmp-1", context: { dataset: "DS-A", split: "", protocol: "TrackEval-v1", subset: "", metricKey: "HOTA" },
    subject: { factId: "f-aaaaaaaaaaaaaaaa", method: "ours", role: "main", value: 49.830 }, reference: { factId: "f-bbbbbbbbbbbbbbbb", method: "base", role: "baseline", value: 47.250 },
    kind: "vs_baseline", canonicalUnit: "percentage",
    absoluteDifference: { value: 2.58, formulaText: "percentage_point_difference([f-a], [f-b])", unitLabel: "pp", displayDecimals: 3, rounding: "" },
    relativeChange: { value: 5.4603, formulaText: "", unitLabel: "percent_relative", displayDecimals: 2, rounding: "" },
    outcome: "subject_better", operandRefs: ["f-aaaaaaaaaaaaaaaa", "f-bbbbbbbbbbbbbbbb"], limitations: [],
  }],
  comparisonCount: 1,
  excluded: [],
  conflicts: [{
    conflictId: "fc-1", code: "SAME_KEY_DIFFERENT_VALUE", key: "k", factIds: ["f-bbbbbbbbbbbbbbbb", "f-cccccccccccccccc"], detail: "同一实验量出现不同取值：需作者裁决",
    sides: [
      { factId: "f-bbbbbbbbbbbbbbbb", sourceLocator: "sha256:2222 · baseline/summary.csv", rawText: "47.250", value: 47.250, unit: "percentage", packageId: "ep-1" },
      { factId: "f-cccccccccccccccc", sourceLocator: "sha256:3333 · baseline/summary_rerun.csv", rawText: "48.250", value: 48.250, unit: "percentage", packageId: "ep-2" },
    ],
  }],
  notComparable: [{ code: "PROTOCOL_NOT_COMPARABLE", metricKey: "HOTA", factIds: ["f-a", "f-b"], detail: "dataset：DS-B ≠ DS-A——不可直接比较" }],
  seedAggregates: [], limitations: ["来源未提供统计检验：快照不支持任何显著性 / p 值表述"],
  freezable: false, blockingReasons: ["SAME_KEY_DIFFERENT_VALUE：同一实验量出现不同取值：需作者裁决"],
};
const stale: ActiveSnapshotView = {
  status: "stale", staleReasons: ["源文件 baseline/summary.csv（sha256 2222）已删除或内容变化"],
  snapshot: { ...preview, snapshotId: "efs-0001", version: 1, createdAt: "2026-11-05T00:00:00Z", contentHash: "c".repeat(64) },
};

describe("ExperimentSnapshotSection（M17.2）", () => {
  beforeEach(() => {
    vi.mocked(api.getSnapshotPreview).mockResolvedValue(preview);
    vi.mocked(api.getActiveExperimentSnapshot).mockResolvedValue(stale);
    vi.mocked(api.listExperimentSnapshots).mockResolvedValue([{ snapshotId: "efs-0001", version: 1, createdAt: "2026-11-05T00:00:00Z", contentHash: "c".repeat(64), factCount: 2, comparisonCount: 1, active: true }]);
    vi.mocked(api.decideExperimentFacts).mockResolvedValue({ excludedCount: 1 });
  });

  it("冲突并排展示双方来源；冲突未裁决冻结按钮不可用；排除一方提交作者决定", async () => {
    renderWithProviders(<ExperimentSnapshotSection projectId="p-test" />);
    const conflicts = await screen.findByTestId("snapshot-conflicts");
    expect(within(conflicts).getByText("48.250")).toBeTruthy();
    expect(within(conflicts).getByText(/baseline\/summary_rerun\.csv/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "冻结为新版本快照" })).toBeDisabled();
    expect(screen.getByTestId("snapshot-blocking")).toHaveTextContent("SAME_KEY_DIFFERENT_VALUE");
    await userEvent.click(within(conflicts).getAllByRole("button", { name: "排除此值" })[1]!);
    await waitFor(() => expect(api.decideExperimentFacts).toHaveBeenCalledWith("p-test", expect.objectContaining({ exclude: ["f-cccccccccccccccc"] })));
  });

  it("确定性对比区分百分点与相对 %，可溯源到源文件定位；失效快照显式告警", async () => {
    renderWithProviders(<ExperimentSnapshotSection projectId="p-test" />);
    const table = await screen.findByTestId("snapshot-comparisons");
    expect(within(table).getByText("+2.580 个百分点")).toBeTruthy();
    expect(within(table).getByText("+5.46%（相对）")).toBeTruthy();
    expect(within(table).getByText(/baseline\/summary\.csv · row=2/)).toBeTruthy();
    const active = await screen.findByTestId("snapshot-active");
    expect(active).toHaveTextContent("已失效");
    expect(active).toHaveTextContent("已删除或内容变化");
    expect(screen.queryByText(/置信/)).toBeNull();
  });
});
