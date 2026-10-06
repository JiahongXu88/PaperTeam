import { describe, expect, it } from "vitest";
import { buildPlannerAliases, plannerEligibleEvidence, resolvePlannerRefs } from "../../src/review/plannerAliases.js";

describe("run-local planner aliases", () => {
  it("resolves comment and evidence aliases to canonical IDs", () => {
    const comments = buildPlannerAliases([{ id: "long-comment-uuid" }], "C", (x) => x.id);
    const evidence = buildPlannerAliases([{ id: "E001" }, { id: "E002" }], "EV", (x) => x.id);
    expect(resolvePlannerRefs(["c1"], comments, "C")).toEqual(["long-comment-uuid"]);
    expect(resolvePlannerRefs(["EV2", "EV1"], evidence, "EV")).toEqual(["E002", "E001"]);
    expect(() => resolvePlannerRefs(["C99"], comments, "C")).toThrow("INVALID_COMMENT_ALIAS");
    expect(() => resolvePlannerRefs(["Reviewer 2"], comments, "C")).toThrow("INVALID_COMMENT_ALIAS");
    expect(() => resolvePlannerRefs(["EV999"], evidence, "EV")).toThrow("INVALID_EVIDENCE_ALIAS");
  });

  it("excludes unverified and superseded records from Planner aliases", () => {
    const records = [
      { id: "current", claim: "current", verificationStatus: "verified", protocolScope: { protocolId: "fair", status: "current" } },
      { id: "historical", claim: "historical", verificationStatus: "verified", protocolScope: { protocolId: "coco", status: "superseded" } },
      { id: "proposal", claim: "proposal", verificationStatus: "unverified" },
    ] as never[];
    expect(plannerEligibleEvidence(records).map((record) => record.id)).toEqual(["current"]);
    expect(plannerEligibleEvidence([])).toEqual([]);
  });
});
