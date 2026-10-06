import { describe, expect, it } from "vitest";
import type { SourceItem } from "../../src/sources/SourceStore.js";
import { selectReviewerSourceIds } from "../../src/evidence/revisionSourceSelection.js";

function source(sourceId: string, fileName: string): SourceItem {
  return { sourceId, fileName, sourceRole: "reference", origin: "USER_ADDED", status: "available", preferred: false, metadata: {}, bytes: 10, createdAt: "", updatedAt: "" };
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
});
