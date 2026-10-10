/**
 * Round 2 真实 run 回归：作者授权实验观测覆盖的数值 claim 披露口径。
 *
 * 真实 run（w-d678566b94c1）：Writer 按授权 Dev25 观测表写入 IDSW 79→67 等数值，
 * Fact Reviewer 对这些数值无外部文献可核 → UNSUPPORTED；claim grounding 把它们
 * 计为「凭空断言」阻断（r3 27 条 / r4 25 条里含全部 Dev25 数值 claim），claim
 * resolution 还会按 numeric_no_grounding 要求 Writer 删除这些授权数值。
 *
 * 期望语义：
 * - 数值全部由授权观测覆盖的 UNSUPPORTED claim → disclosure=author_experiment_data，
 *   不计入 opaque；仍不是 SUPPORTED / evidence-backed；
 * - CONTRADICTED 不豁免；数值未被覆盖（含部分覆盖）→ 仍 opaque；
 * - 粘连在字母上的数字（Dev25 / IDF1）不当作数值；0.628030 ≡ 0.62803；
 * - claim resolution → author_decision_required（不派发数值删除）。
 */

import { describe, expect, it } from "vitest";

import type { FactClaimCheck } from "../../src/agents/ReviewerService.js";
import {
  authorizedObservationsCovering,
  claimNumberRuns,
  computeClaimGroundingReport,
} from "../../src/review/claimGrounding.js";
import { classifyClaimResolution, resolutionRequiresWriterDispatch } from "../../src/review/claimResolution.js";

const DEV25 = [
  { value: 79, metric: "IDSW", split: "Dev25", groupId: "main" },
  { value: 67, metric: "IDSW", split: "Dev25", groupId: "main" },
  { value: 0.626126, metric: "HOTA_pooled", split: "Dev25", groupId: "main" },
  { value: 0.62803, metric: "HOTA_pooled", split: "Dev25", groupId: "main" },
  { value: 0.758421, metric: "AssA_pooled", split: "Dev25", groupId: "main" },
  { value: 0.762638, metric: "AssA_pooled", split: "Dev25", groupId: "main" },
  { value: 0.755093, metric: "IDF1_pooled", split: "Dev25", groupId: "main" },
  { value: 0.760709, metric: "IDF1_pooled", split: "Dev25", groupId: "main" },
];

describe("claimNumberRuns / authorizedObservationsCovering", () => {
  it("粘连字母的数字不算数值；独立数值按浮点相等匹配（尾零容错）", () => {
    expect(claimNumberRuns("main/Dev25 范围内 IDSW 由 79 降至 67")).toEqual(["79", "67"]);
    expect(claimNumberRuns("HOTA 0.626126→0.628030，AssA 0.758421→0.762638，IDF1 0.755093→0.760709")).toEqual([
      "0.626126",
      "0.628030",
      "0.758421",
      "0.762638",
      "0.755093",
      "0.760709",
    ]);
    expect(authorizedObservationsCovering("HOTA 0.626126→0.628030", DEV25)).toEqual([
      "HOTA_pooled@Dev25=0.626126",
      "HOTA_pooled@Dev25=0.62803",
    ]);
  });

  it("部分覆盖 / 无数值 / 无授权观测 → null", () => {
    expect(authorizedObservationsCovering("IDSW 由 121 降至 87", DEV25)).toBeNull(); // Full38 数值未授权
    expect(authorizedObservationsCovering("IDSW 由 79 降至 67，减少 15.2%", DEV25)).toBeNull(); // 派生百分比不在观测表
    expect(authorizedObservationsCovering("四项指标变化方向一致", DEV25)).toBeNull();
    expect(authorizedObservationsCovering("IDSW 由 79 降至 67", [])).toBeNull();
  });
});

describe("computeClaimGroundingReport × 授权观测", () => {
  const claims: FactClaimCheck[] = [
    { section: "sections/results.tex", claim: "main/Dev25 范围内 IDSW 由 79 降至 67", verdict: "UNSUPPORTED" },
    { section: "sections/results.tex", claim: "HOTA 0.626126→0.628030，AssA 0.758421→0.762638，IDF1 0.755093→0.760709", verdict: "UNSUPPORTED" },
    { section: "sections/discussion.tex", claim: "Full38 上 IDSW 由 121 降至 87", verdict: "UNSUPPORTED" },
    { section: "sections/discussion.tex", claim: "Bootstrap 分析显示 IDSW 下降集中于部分来源组（79→67）", verdict: "CONTRADICTED" },
    { section: "sections/related-work.tex", claim: "ByteTrack 系列关注低置信度检测框的利用", verdict: "UNSUPPORTED" },
  ];

  it("授权覆盖的数值 claim → author_experiment_data，不计入 opaque；CONTRADICTED / 未覆盖仍 opaque", () => {
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 3,
      factClaims: claims,
      formalEvidence: [],
      bibEntries: [],
      authorizedObservations: DEV25,
    });
    expect(report.unsupportedClaims).toBe(4);
    expect(report.contradictedClaims).toBe(1);
    expect(report.authorDataUnsupportedClaims).toBe(2);
    expect(report.opaqueUnsupportedClaims).toBe(3); // Full38 数值 + CONTRADICTED + 文献 claim
    expect(report.transparentUnsupportedClaims).toBe(0);
    expect(report.claims[0]!.disclosure).toBe("author_experiment_data");
    expect(report.claims[0]!.authorizedObservations).toEqual(["IDSW@Dev25=79", "IDSW@Dev25=67"]);
    expect(report.claims[1]!.disclosure).toBe("author_experiment_data");
    expect(report.claims[2]!.disclosure).toBe("opaque_assertion");
    expect(report.claims[3]!.disclosure).toBe("opaque_assertion");
    expect(report.claims[3]!.authorizedObservations).toBeUndefined();
    expect(report.claims[4]!.disclosure).toBe("opaque_assertion");
    // 仍进入 unsupportedClaimIds（规则 5/6 的同根因去重照常；不是 SUPPORTED）
    expect(report.unsupportedClaimIds).toHaveLength(5);
    expect(report.supportedClaims).toBe(0);
  });

  it("未提供授权观测（旧调用方 / 综述）→ 行为不变，全部 opaque", () => {
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 3,
      factClaims: claims,
      formalEvidence: [],
      bibEntries: [],
    });
    expect(report.authorDataUnsupportedClaims).toBe(0);
    expect(report.opaqueUnsupportedClaims).toBe(5);
  });

  it("claim resolution：author_experiment_data → author_decision_required（不派发数值删除）", () => {
    const report = computeClaimGroundingReport({
      projectId: "p1",
      round: 3,
      factClaims: claims,
      formalEvidence: [],
      bibEntries: [],
      authorizedObservations: DEV25,
    });
    const authorized = classifyClaimResolution(report.claims[0]!, { sources: [] });
    expect(authorized.action).toBe("author_decision_required");
    expect(authorized.basis).toBe("author_experiment_data_authorized");
    expect(resolutionRequiresWriterDispatch(authorized.action)).toBe(false);
    // 对照：未授权的 Full38 数值 claim 仍按 numeric_no_grounding 删除
    const opaque = classifyClaimResolution(report.claims[2]!, { sources: [] });
    expect(opaque.action).toBe("remove_unsupported_detail");
  });
});
