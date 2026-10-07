import { describe, expect, it } from "vitest";
import type { SourceItem } from "../../src/sources/SourceStore.js";
import { selectReviewerSourceIds } from "../../src/evidence/revisionSourceSelection.js";

function source(sourceId: string, fileName: string): SourceItem {
  // 自有实验报告是 evidence 源（M12.1 起 role 过滤参与 targeted grounding 选择；
  // reference 源被排除——见下方专测）
  return { sourceId, fileName, sourceRole: "evidence", origin: "USER_ADDED", status: "available", preferred: false, metadata: {}, bytes: 10, createdAt: "", updatedAt: "" };
}

describe("Existing Paper targeted source selection", () => {
  const sources = [source("rdk", "rdk_x3_full_pipeline_report.md"), source("old", "extreme_scene_experiment_report.md"), source("fair", "fair_ablation_new_detector.md"), source("board", "board_c0_20260904_metrics.csv")];

  it("deployment comments target RDK report and board data", () => {
    expect(selectReviewerSourceIds("Report RDK X3 deployment performance", sources)).toEqual(["rdk", "board"]);
  });

  it("current ablation/extreme-scene comments exclude historical COCO report", () => {
    expect(selectReviewerSourceIds("Please report fair ablation on extreme scenes", sources)).toEqual(["fair"]);
    expect(selectReviewerSourceIds("请补充低照度和高密度消融", sources)).toEqual(["fair"]);
  });

  it("M12.1：reference 源（benchmark 范文）不进 targeted grounding 目标集", () => {
    const mixed = [
      ...sources,
      { ...source("bench", "cvpr_benchmark_paper.pdf"), sourceRole: "reference" as const },
    ];
    const selected = selectReviewerSourceIds("Report RDK X3 deployment performance", mixed);
    expect(selected).toEqual(["rdk", "board"]);
    expect(selectReviewerSourceIds("泛化审稿意见", mixed).sort()).toEqual(["board", "fair", "old", "rdk"]);
  });
});
