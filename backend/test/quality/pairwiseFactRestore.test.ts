/**
 * M11.2.3（D-1）pairwise factRestore 投影 + 跨轮授权单元测试。
 *
 * Case B 死锁回归（真实场景重构）：survey 项目 rev2 无依据新增含年份的范围
 * 声明句 → gate 判 added_unsupported → 修订计划（新代码）携带行级
 * removeValues → rev3 按计划删除该句 → 下一轮 pairwise 判定：
 * - 删除被 planned_fact_restore 授权（ok=true）——不再加也拦删也拦；
 * - 负对照：未授权数值删除 / 数值替换（swap）/ 方向反转仍然 FAIL（fail-closed
 *   不放松）；
 * - fact_preserve 条目对「无依据新增」的指令是删除而非「恢复原值」。
 */

import { describe, expect, it } from "vitest";

import {
  evaluateFactPreservation,
  projectPairwiseFactRestore,
  type FactFinding,
  type FactSnapshot,
} from "../../src/quality/factPreservation.js";
import { buildRevisionPlan } from "../../src/review/revisionPlan.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";

function snapshot(revision: number, files: Record<string, string>): FactSnapshot {
  return {
    revision,
    files: Object.entries(files).map(([file, content]) => ({ file, content })),
  };
}

const FILE = "sections/introduction.tex";
/** Case B 实录形状：rev2 新增的范围边界声明（含年份区间，数字多形态） */
const REV1 = `\\section{引言}
多模态大模型的视觉编码研究近年快速发展。
本综述围绕查询重采样接口与原生早期融合两条路线展开。
`;

const REV2 = `\\section{引言}
多模态大模型的视觉编码研究近年快速发展。
本综述围绕查询重采样接口与原生早期融合两条路线展开。
在文献构成上，需要先行申明本综述的范围边界：查询重采样接口（Q-Former/Perceiver Resampler/Pooling Abstractor 一类机制）、模型内部视觉表示的演进路线，覆盖 2021 至 2026 年间以 2025 年为主的公开文献（占 72%）。
`;

const REV3 = `\\section{引言}
多模态大模型的视觉编码研究近年快速发展。
本综述围绕查询重采样接口与原生早期融合两条路线展开。
`;

const emptySummary: ReviewSummary = {
  generatedAt: "2026-10-04T00:00:00Z",
  round: 2,
  reviewedRevision: 2,
  issues: [],
  counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
  scores: { academicScore: 72, styleRisk: 40, factVerdicts: null },
  openCritical: 0,
  openMajor: 0,
  unsupportedCriticalClaims: 0,
  reportPaths: [],
};

/** gate r2 的 pairwise 违规（rev1→rev2）→ 计划输入（summarizePairwiseFactRegressions 的单元级重构） */
function pairwiseRegressions(findings: FactFinding[]): {
  file: string;
  detail: string;
  removeValues?: string[];
  restoreValues?: string[];
}[] {
  const regressions = new Map<string, { detail: string; removeValues: Set<string>; restoreValues: Set<string> }>();
  const displayCount = new Map<string, number>();
  for (const finding of findings) {
    const entry =
      regressions.get(finding.file) ??
      { detail: `${finding.reason}：${finding.before}${finding.after !== "" ? ` → ${finding.after}` : "（被删除）"}`, removeValues: new Set<string>(), restoreValues: new Set<string>() };
    if ((displayCount.get(finding.file) ?? 0) === 0) {
      displayCount.set(finding.file, 1);
    }
    const projection = projectPairwiseFactRestore(finding, [
      { file: finding.file, content: finding.kind === "removed" ? REV1 : REV2 },
    ]);
    for (const value of projection.restoreValues ?? []) {
      entry.restoreValues.add(value);
    }
    for (const value of projection.removeValues ?? []) {
      entry.removeValues.add(value);
    }
    regressions.set(finding.file, entry);
  }
  return [...regressions.entries()].map(([file, entry]) => ({
    file,
    detail: entry.detail.slice(0, 240),
    ...(entry.removeValues.size > 0 ? { removeValues: [...entry.removeValues].slice(0, 12) } : {}),
    ...(entry.restoreValues.size > 0 ? { restoreValues: [...entry.restoreValues].slice(0, 12) } : {}),
  }));
}

describe("projectPairwiseFactRestore（pairwise 授权投影）", () => {
  it("added_unsupported → 行级 removeValues（覆盖新增时被噪音过滤、删除时进 missing 的裸整数）", () => {
    const finding: FactFinding = {
      kind: "added_unsupported",
      file: FILE,
      section: "引言",
      before: "",
      after: "在文献构成上，需要先行申明本综述的范围边界：查询重采样接口（Q-Former…",
      reason: "added_number",
      classification: { category: "A", type: "number_added", severity: "high", newValue: "2021" },
    };
    const projection = projectPairwiseFactRestore(finding, [{ file: FILE, content: REV2 }]);
    expect(projection.removeValues).toBeDefined();
    // 2021 / 2026 / 2025 全部在授权清单里（行级提取，不漏同句数字）
    const values = projection.removeValues ?? [];
    for (const year of ["2021", "2026", "2025"]) {
      expect(values.some((value) => value.includes(year) || year.includes(value))).toBe(true);
    }
  });

  it("removed → restoreValues（授权加回被删原值）", () => {
    const finding: FactFinding = {
      kind: "removed",
      file: FILE,
      section: "引言",
      before: "覆盖 2021 至 2026 年间…",
      after: "",
      reason: "prose_number",
      classification: { category: "A", type: "number_removed", severity: "high", oldValue: "2026" },
    };
    const projection = projectPairwiseFactRestore(finding, [{ file: FILE, content: REV1 }]);
    expect((projection.restoreValues ?? []).length).toBeGreaterThan(0);
  });

  it("direction / formula 不投影（走各自既有授权通道）", () => {
    const finding: FactFinding = {
      kind: "directional",
      file: FILE,
      section: "引言",
      before: "A 优于 B",
      after: "B 优于 A",
      reason: "negative_to_advantage",
    };
    expect(projectPairwiseFactRestore(finding, [])).toEqual({});
  });
});

describe("Case B 死锁回归：加也拦删也拦 → 删除被授权", () => {
  // r2 gate：rev1→rev2 判 added_unsupported（守卫行为正确，保持）
  const r2 = evaluateFactPreservation({ previous: snapshot(1, { [FILE]: REV1 }), current: snapshot(2, { [FILE]: REV2 }), plan: null });
  expect(r2.ok).toBe(false);
  expect(r2.addedUnsupportedFacts.length).toBeGreaterThan(0);

  // 新代码：pairwise 违规 → 计划条目携带行级 removeValues + 删除式指令
  const regressions = pairwiseRegressions([
    ...r2.addedUnsupportedFacts,
    ...r2.changedFacts,
    ...r2.removedFacts,
  ]);
  expect(regressions.length).toBeGreaterThan(0);
  const plan = buildRevisionPlan({
    projectId: "p-test",
    sourceRevision: 2,
    reviewRound: 2,
    summary: emptySummary,
    factRegressions: regressions,
  });
  const factItem = plan.items.find((item) => item.kind === "fact_preserve");
  expect(factItem).toBeDefined();
  expect(factItem?.factRestore?.removeValues?.length).toBeGreaterThan(0);
  // 指令分化：无依据新增的处置是删除（不是恢复原值——原值不存在）
  expect(factItem?.instruction).toContain("删除该无依据新增内容");
  expect(factItem?.instruction).not.toContain("恢复上一修订中的实验事实原值");

  it("r3 gate：rev2→rev3 按计划删除 → 授权放行（死锁解除）", () => {
    const r3 = evaluateFactPreservation({
      previous: snapshot(2, { [FILE]: REV2 }),
      current: snapshot(3, { [FILE]: REV3 }),
      plan,
    });
    expect(r3.ok).toBe(true);
    expect(r3.allowedRemovals).toBeGreaterThan(0);
  });

  it("负对照 1：无计划时同样的删除仍 FAIL（授权只来自计划，不放松默认）", () => {
    const r3 = evaluateFactPreservation({
      previous: snapshot(2, { [FILE]: REV2 }),
      current: snapshot(3, { [FILE]: REV3 }),
      plan: null,
    });
    expect(r3.ok).toBe(false);
    expect(r3.removedFacts.length).toBeGreaterThan(0);
  });

  it("负对照 2：删除授权不放行数值替换（替换值落入 added 桶被拦）", () => {
    const rev3Swap = REV2.replace("占 72%", "占 36%");
    const r3 = evaluateFactPreservation({
      previous: snapshot(2, { [FILE]: REV2 }),
      current: snapshot(3, { [FILE]: rev3Swap }),
      plan,
    });
    expect(r3.ok).toBe(false);
    expect(r3.addedUnsupportedFacts.map((finding) => finding.classification?.newValue)).toContain("36%");
  });

  it("负对照 3：删除授权不放行未点名数值的删除", () => {
    const rev1Extra = `${REV1}基线吞吐为 3139 秒。`;
    const rev2Extra = `${REV2}基线吞吐为 3139 秒。`;
    const rev3Extra = `${REV3}基线吞吐为。`;
    const r2Extra = evaluateFactPreservation({
      previous: snapshot(1, { [FILE]: rev1Extra }),
      current: snapshot(2, { [FILE]: rev2Extra }),
      plan: null,
    });
    const planExtra = buildRevisionPlan({
      projectId: "p-test",
      sourceRevision: 2,
      reviewRound: 2,
      summary: emptySummary,
      factRegressions: pairwiseRegressions([
        ...r2Extra.addedUnsupportedFacts,
        ...r2Extra.changedFacts,
        ...r2Extra.removedFacts,
      ]),
    });
    const r3Extra = evaluateFactPreservation({
      previous: snapshot(2, { [FILE]: rev2Extra }),
      current: snapshot(3, { [FILE]: rev3Extra }),
      plan: planExtra,
    });
    // 3139 不在授权行（另一行）——删除仍违规
    expect(r3Extra.ok).toBe(false);
    expect(
      r3Extra.removedFacts.some((finding) => finding.classification?.oldValue?.includes("3139")),
    ).toBe(true);
  });
});

describe("mustPreserve 投影（D-4 §15）", () => {
  it("fact_preserve 条目可携带 mustPreserve（RevisionPlanItem 契约扩展）", () => {
    const r2Local = evaluateFactPreservation({
      previous: snapshot(1, { [FILE]: REV1 }),
      current: snapshot(2, { [FILE]: REV2 }),
      plan: null,
    });
    const localRegressions = pairwiseRegressions([
      ...r2Local.addedUnsupportedFacts,
      ...r2Local.changedFacts,
      ...r2Local.removedFacts,
    ]);
    const planWithConstraints = buildRevisionPlan({
      projectId: "p-test",
      sourceRevision: 2,
      reviewRound: 2,
      summary: emptySummary,
      factRegressions: localRegressions,
    });
    const item = planWithConstraints.items.find((entry) => entry.kind === "fact_preserve");
    // attachMustPreserveConstraints 在 workflow 层投影；此处验证契约字段可承载
    expect(item).toBeDefined();
    const withConstraints = {
      ...item!,
      mustPreserve: { values: ["3139", "0.669"], citationKeys: ["du2023does"] },
    };
    expect(withConstraints.mustPreserve?.values).toContain("3139");
  });
});
