/**
 * Citation Preservation Gate（M5.6 验收驱动）：修订前后「实际被引用的 key」按 key 语义比较，
 * 无计划依据的丢失 → FAIL；全部删光 → catastrophic；历史回归（更早基线有引用、此后一直 0）→ FAIL。
 *
 * 用例对应 M5 验收清单 C4：
 *   1 10→10 PASS；2 10→0 无计划 FAIL(catastrophic)；3 10→9 无计划 FAIL；4 10→9 计划明确删除 PASS；
 *   5 命令顺序变化 PASS；6 同 key 次数变化按 key 语义 PASS；7 新增引用不因保持规则失败；
 *   8 references.bib 有条目但正文一直没引用 → 历史回归 FAIL（不伪装 PASS）；
 *   9 Style Polish 删引用：Invariant Checker（第一层，见 stylePolish.test）+ Gate（第二层，本文件）；
 *   10 Quick Review（existing_paper_review）不含 quality.gate。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { extractCitationOccurrences } from "../../src/citation/StaticCitationChecker.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import {
  computeCitationPreservation,
  describeCitationPreservation,
  evaluateCitationPreservation,
  type CitationSnapshot,
} from "../../src/quality/citationPreservation.js";
import { DEFAULT_QUALITY_THRESHOLDS, evaluateQualityGate } from "../../src/quality/gates.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { buildRevisionPlan, type RevisionPlan } from "../../src/review/revisionPlan.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import { createExistingPaperReviewDefinition } from "../../src/workflow/definitions.js";
import type { WorkflowServices } from "../../src/workflow/definitions.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

// ---- 工厂 ----

const KEYS = ["k01", "k02", "k03", "k04", "k05", "k06", "k07", "k08", "k09", "k10"];

/** 10 个 key 分布在两个章节（intro 6 个、method 4 个），k01 在 intro 引用两次 */
function tenKeySnapshot(revision: number): CitationSnapshot {
  return {
    revision,
    files: [
      { file: "main.tex", content: "\\documentclass{ctexart}\\begin{document}\\input{sections/intro}\\input{sections/method}\\end{document}" },
      {
        file: "sections/intro.tex",
        content: `\\section{引言}\n观点 A \\cite{k01}，观点 B \\citep{k02,k03}，观点 C \\citet{k04}。\n再次引用 \\cite{k01}；\\cite{k05} 与 \\cite{k06}。`,
      },
      { file: "sections/method.tex", content: `\\section{方法}\n\\cite{k07} \\cite{k08} \\cite{k09} \\cite{k10}` },
    ],
  };
}

function withIntro(snapshot: CitationSnapshot, intro: string): CitationSnapshot {
  return {
    ...snapshot,
    files: snapshot.files.map((file) => (file.file === "sections/intro.tex" ? { ...file, content: intro } : file)),
  };
}

function noCitations(revision: number): CitationSnapshot {
  return {
    revision,
    files: [
      { file: "main.tex", content: "\\documentclass{ctexart}\\begin{document}\\input{sections/intro}\\end{document}" },
      { file: "sections/intro.tex", content: "\\section{引言}\n没有任何引用的论述。" },
    ],
  };
}

const emptySummary: ReviewSummary = {
  generatedAt: "2026-09-15T00:00:00Z",
  round: 1,
  reviewedRevision: 1,
  issues: [],
  counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
  scores: { academicScore: 88, styleRisk: 20, factVerdicts: { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 } },
  openCritical: 0,
  openMajor: 0,
  unsupportedCriticalClaims: 0,
  reportPaths: [],
};

function planWith(input: Partial<Parameters<typeof buildRevisionPlan>[0]>): RevisionPlan {
  return buildRevisionPlan({
    projectId: "p-test",
    sourceRevision: 1,
    reviewRound: 1,
    summary: emptySummary,
    createdAt: "2026-09-15T00:00:00Z",
    ...input,
  });
}

describe("extractCitationOccurrences：与 StaticCitationChecker 共用 \\cite 族命令表", () => {
  it("多重集（保留重复）、多 key、natbib / biblatex 变体、可选参数、非法 key 丢弃", () => {
    const tex = "\\cite{a} \\citep[p.~3]{b,c} \\citet*{a} \\parencite{d} \\autocite[see][]{e} \\cite{bad key} \\nocite{f}";
    expect(extractCitationOccurrences(tex)).toEqual(["a", "b", "c", "a", "d", "e", "f"]);
  });
});

describe("evaluateCitationPreservation：纯函数判定", () => {
  it("1. 10 个 key 原样保留 → PASS（key 与次数一致）", () => {
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current: tenKeySnapshot(2), plan: null });
    expect(summary.ok).toBe(true);
    expect(summary.previousKeys).toEqual(KEYS);
    expect(summary.currentKeys).toEqual(KEYS);
    expect(summary.previousCount).toBe(11); // k01 两次
    expect(summary.currentCount).toBe(11);
    expect(summary.removedKeys).toEqual([]);
    expect(summary.unexpectedRemovedKeys).toEqual([]);
    expect(summary.catastrophic).toBe(false);
    expect(describeCitationPreservation(summary)).toContain("无 key 丢失");
  });

  it("2. 10 → 0 且无计划 → catastrophic hard FAIL，列出全部无依据删除的 key 与位置", () => {
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current: noCitations(2), plan: null });
    expect(summary.ok).toBe(false);
    expect(summary.catastrophic).toBe(true);
    expect(summary.currentCount).toBe(0);
    expect(summary.unexpectedRemovedKeys).toEqual(KEYS);
    expect(summary.unexpectedRemoved.find((entry) => entry.key === "k07")?.files).toEqual(["sections/method.tex"]);
    expect(summary.unexpectedRemoved.find((entry) => entry.key === "k01")?.files).toEqual(["sections/intro.tex"]);
    const detail = describeCitationPreservation(summary);
    expect(detail).toContain("全部引用被删除且无计划依据");
    expect(detail).toContain("k01,k02,k03,k04,k05,k06,k07,k08,…"); // 最多 8 个 key，不输出整篇
  });

  it("3. 10 → 9：删除 k05 但计划里没有任何依据 → FAIL（非 catastrophic）", () => {
    const current = withIntro(tenKeySnapshot(2), `\\section{引言}\n观点 A \\cite{k01}，观点 B \\citep{k02,k03}，观点 C \\citet{k04}。\n再次引用 \\cite{k01}；\\cite{k06}。`);
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current, plan: planWith({}) });
    expect(summary.ok).toBe(false);
    expect(summary.catastrophic).toBe(false);
    expect(summary.removedKeys).toEqual(["k05"]);
    expect(summary.unexpectedRemovedKeys).toEqual(["k05"]);
    expect(summary.allowedRemovedKeys).toEqual([]);
    expect(summary.planId).toBe("plan-r1-rev1");
    expect(describeCitationPreservation(summary)).toContain("无依据删除 1 个 key（k05）");
  });

  it("4. 10 → 9：计划 citation_missing 明确要求删除 k05 → PASS，并记录依据（条目 id / 章节）", () => {
    const current = withIntro(tenKeySnapshot(2), `\\section{引言}\n观点 A \\cite{k01}，观点 B \\citep{k02,k03}，观点 C \\citet{k04}。\n再次引用 \\cite{k01}；\\cite{k06}。`);
    const plan = planWith({ citationMissing: [{ key: "k05", files: ["sections/intro.tex"] }] });
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current, plan });
    expect(summary.ok).toBe(true);
    expect(summary.removedKeys).toEqual(["k05"]);
    expect(summary.allowedRemovedKeys).toEqual([
      { key: "k05", basis: "planned_citation_missing", planItemId: "citation-missing:k05:sections/intro.tex", section: "sections/intro.tex" },
    ]);
    expect(describeCitationPreservation(summary)).toContain("有计划删除 1 个");
  });

  it("4b. 审稿 finding 显式点名 \\cite{k05}（planned）→ 允许；skipped（minor）条目不算依据", () => {
    const current = withIntro(tenKeySnapshot(2), `\\section{引言}\n观点 A \\cite{k01}，观点 B \\citep{k02,k03}，观点 C \\citet{k04}。\n再次引用 \\cite{k01}；\\cite{k06}。`);
    const explicit = planWith({
      summary: {
        ...emptySummary,
        issues: [
          {
            category: "citation",
            severity: "major",
            section: "sections/intro.tex",
            description: "引用 \\cite{k05} 与论断无关",
            suggestedAction: "删除该引用",
            blocking: false,
          },
        ],
      },
    });
    expect(evaluateCitationPreservation({ previous: tenKeySnapshot(1), current, plan: explicit }).ok).toBe(true);
    const minorOnly = planWith({
      summary: {
        ...emptySummary,
        issues: [
          { category: "citation", severity: "minor", section: "sections/intro.tex", description: "引用 \\cite{k05} 可删", blocking: false },
        ],
      },
    });
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current, plan: minorOnly });
    expect(summary.ok).toBe(false);
    expect(summary.unexpectedRemovedKeys).toEqual(["k05"]);
  });

  it("4c. 证据不足条目（needsEvidence，允许弱化 / 删除论述）命中章节：该章节内全部出现的 key 可随论述删除；跨章节 key 不放行", () => {
    // 删掉整个 method 章节的引用（k07-k10 只出现在 method），同时 intro 里的 k06 也被删
    const current: CitationSnapshot = {
      ...tenKeySnapshot(2),
      files: tenKeySnapshot(2).files.map((file) =>
        file.file === "sections/method.tex"
          ? { ...file, content: "\\section{方法}\n证据不足的论述已删除。" }
          : file.file === "sections/intro.tex"
            ? { ...file, content: `\\section{引言}\n观点 A \\cite{k01}，观点 B \\citep{k02,k03}，观点 C \\citet{k04}。\n再次引用 \\cite{k01}；\\cite{k05}。` }
            : file,
      ),
    };
    const plan = planWith({
      summary: {
        ...emptySummary,
        issues: [
          { category: "evidence_gap", severity: "critical", section: "sections/method.tex", description: "方法有效性无实验支撑", blocking: true },
        ],
      },
    });
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current, plan });
    expect(summary.removedKeys).toEqual(["k06", "k07", "k08", "k09", "k10"]);
    expect(summary.allowedRemovedKeys.map((entry) => entry.key)).toEqual(["k07", "k08", "k09", "k10"]);
    expect(summary.allowedRemovedKeys[0]?.basis).toBe("planned_evidence_removal");
    expect(summary.unexpectedRemovedKeys).toEqual(["k06"]);
    expect(summary.ok).toBe(false);
  });

  it("4d. 全部删光时，章节级证据不足条目不构成「全量引用移除」的明确依据 → 仍 catastrophic；显式点名的 key 才放行", () => {
    const evidenceEverywhere = planWith({
      summary: {
        ...emptySummary,
        issues: [
          { category: "fact", severity: "critical", section: "sections/intro.tex", description: "引言论断无支撑", blocking: true },
          { category: "evidence_gap", severity: "critical", section: "sections/method.tex", description: "方法有效性无实验支撑", blocking: true },
        ],
      },
    });
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current: noCitations(2), plan: evidenceEverywhere });
    expect(summary.catastrophic).toBe(true);
    expect(summary.ok).toBe(false);
    expect(summary.unexpectedRemovedKeys).toEqual(KEYS);
    expect(summary.allowedRemovedKeys).toEqual([]);
    // 同样删光，但每个 key 都被计划显式点名（missing key）→ 有计划的全量移除，不是 catastrophic
    const allExplicit = planWith({ citationMissing: KEYS.map((key) => ({ key, files: ["sections/intro.tex"] })) });
    const planned = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current: noCitations(2), plan: allExplicit });
    expect(planned.catastrophic).toBe(false);
    expect(planned.ok).toBe(true);
    expect(planned.allowedRemovedKeys).toHaveLength(10);
  });

  it("5. 引用命令顺序 / 命令变体变化（\\cite ↔ \\citep，位置调换）→ PASS", () => {
    const current = withIntro(
      tenKeySnapshot(2),
      `\\section{引言}\n\\citep{k06} 与 \\cite{k05}；观点 C \\cite{k04}，观点 B \\citet{k03,k02}，观点 A \\citep{k01}。\n再次引用 \\cite{k01}。`,
    );
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current, plan: null });
    expect(summary.ok).toBe(true);
    expect(summary.removedKeys).toEqual([]);
    expect(summary.addedKeys).toEqual([]);
  });

  it("6. 同一 key 引用次数变化（k01 两次 → 一次；k02 一次 → 三次）按 key 语义不算删除 → PASS，但次数如实报告", () => {
    const current = withIntro(
      tenKeySnapshot(2),
      `\\section{引言}\n观点 A \\cite{k01}，观点 B \\citep{k02,k03}，\\cite{k02} 再谈 \\cite{k02}，观点 C \\citet{k04}。\n\\cite{k05} 与 \\cite{k06}。`,
    );
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current, plan: null });
    expect(summary.ok).toBe(true);
    expect(summary.previousCount).toBe(11);
    expect(summary.currentCount).toBe(12);
    expect(summary.previousKeys).toEqual(summary.currentKeys);
  });

  it("7. 新增引用（k11、k12）不因保持规则失败；新增 key 单列，真实性由 Citation Verification 判断", () => {
    const current = withIntro(
      tenKeySnapshot(2),
      `\\section{引言}\n观点 A \\cite{k01}，观点 B \\citep{k02,k03}，观点 C \\citet{k04}。\n再次引用 \\cite{k01}；\\cite{k05} 与 \\cite{k06}；新增 \\cite{k11,k12}。`,
    );
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current, plan: null });
    expect(summary.ok).toBe(true);
    expect(summary.addedKeys).toEqual(["k11", "k12"]);
    expect(describeCitationPreservation(summary)).toContain("新增 2 个（真实性由引用核验判定）");
  });

  it("8. previous 与 current 都没有引用、但基线修订有 → 历史回归 FAIL（references.bib 有条目也不能伪装 PASS）", () => {
    const summary = evaluateCitationPreservation({
      previous: noCitations(2),
      current: noCitations(3),
      baseline: tenKeySnapshot(1),
      plan: null,
    });
    expect(summary.ok).toBe(false);
    expect(summary.catastrophic).toBe(false);
    expect(summary.historicalRegression).toEqual({ baselineRevision: 1, baselineCount: 11 });
    expect(describeCitationPreservation(summary)).toContain("历史回归——基线 rev-1 有 11 处引用，当前 0 处且未恢复");
    // 基线也没有引用：确实无可保持 → PASS（不是回归）
    const clean = evaluateCitationPreservation({ previous: noCitations(1), current: noCitations(2), baseline: noCitations(1), plan: null });
    expect(clean.ok).toBe(true);
    expect(clean.historicalRegression).toBeNull();
  });

  it("9. Style Polish 产生的修订删掉一处引用：style 计划不承认任何删除依据 → Gate 第二层 FAIL", () => {
    const current = withIntro(
      tenKeySnapshot(3),
      `\\section{引言}\n观点 A \\cite{k01}，观点 B \\citep{k02,k03}，观点 C \\citet{k04}。\n再次引用 \\cite{k01}；\\cite{k05}。`,
    );
    // style 计划由 buildStylePolishPlan 派生，落在另一文件；computeCitationPreservation 会忽略 revisionReason=style_polish
    const summary = evaluateCitationPreservation({ previous: tenKeySnapshot(2), current, plan: null });
    expect(summary.ok).toBe(false);
    expect(summary.unexpectedRemovedKeys).toEqual(["k06"]);
  });

  it("Existing-Paper 改进计划：只承认 action / rationale 显式点名 \\cite{key} 的删除", () => {
    const current = withIntro(tenKeySnapshot(2), `\\section{引言}\n观点 A \\cite{k01}，观点 B \\citep{k02,k03}，观点 C \\citet{k04}。\n再次引用 \\cite{k01}；\\cite{k06}。`);
    const allowed = evaluateCitationPreservation({
      previous: tenKeySnapshot(1),
      current,
      plan: null,
      improvementPlanItems: [{ section: "sections/intro.tex", action: "删除与主题无关的 \\cite{k05}", rationale: "偏题" }],
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.allowedRemovedKeys[0]?.basis).toBe("improvement_plan_explicit_mention");
    const vague = evaluateCitationPreservation({
      previous: tenKeySnapshot(1),
      current,
      plan: null,
      improvementPlanItems: [{ section: "sections/intro.tex", action: "精简引言" }],
    });
    expect(vague.ok).toBe(false);
  });
});

describe("evaluateQualityGate：citation_keys_preserved / citation_preservation_not_applicable", () => {
  const base = {
    review: emptySummary,
    citation: null,
    evidence: { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 }, contradictory: 0, skippedLines: 0 },
    feasibility: null,
  };

  it("未提供 citationPreservation → 规则不出现（兼容纯单元输入）", () => {
    const gate = evaluateQualityGate(base, DEFAULT_QUALITY_THRESHOLDS);
    expect(gate.rules.map((rule) => rule.rule)).not.toContain("citation_keys_preserved");
    expect(gate.rules.map((rule) => rule.rule)).not.toContain("citation_preservation_not_applicable");
  });

  it("null（无前序修订）→ 中性规则 passed，detail 说明不参与判定，不伪造 PASS 语义", () => {
    const gate = evaluateQualityGate({ ...base, citationPreservation: null }, DEFAULT_QUALITY_THRESHOLDS);
    const rule = gate.rules.find((entry) => entry.rule === "citation_preservation_not_applicable");
    expect(rule?.passed).toBe(true);
    expect(rule?.detail).toContain("不参与判定");
    expect(gate.rules.map((entry) => entry.rule)).not.toContain("citation_keys_preserved");
  });

  it("10 → 0 无计划 → citation_keys_preserved FAIL 进入 reasons（阻止 Final）；10 → 10 → PASS", () => {
    const dropped = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current: noCitations(2), plan: null });
    const failed = evaluateQualityGate({ ...base, citationPreservation: dropped }, DEFAULT_QUALITY_THRESHOLDS);
    expect(failed.passed).toBe(false);
    expect(failed.reasons.join("\n")).toContain("citation_keys_preserved: rev-1→rev-2 引用 11→0 处");
    const kept = evaluateCitationPreservation({ previous: tenKeySnapshot(1), current: tenKeySnapshot(2), plan: null });
    const passed = evaluateQualityGate({ ...base, citationPreservation: kept }, DEFAULT_QUALITY_THRESHOLDS);
    expect(passed.passed).toBe(true);
    expect(passed.rules.find((rule) => rule.rule === "citation_keys_preserved")?.passed).toBe(true);
  });
});

describe("buildRevisionPlan：citation_removed 条目（Gate 失败 → Writer 恢复引用的可派发计划）", () => {
  it("按上一修订中的出现文件派发 planned/high 条目；id 稳定；映射到 citation 类别", () => {
    const plan = planWith({ citationRemoved: [{ key: "k07", files: ["sections/method.tex"] }, { key: "k01", files: [] }] });
    const removed = plan.items.filter((item) => item.kind === "citation_removed");
    expect(removed.map((item) => item.id)).toEqual(["citation-removed:k01:(unknown)", "citation-removed:k07:sections/method.tex"]);
    expect(removed.every((item) => item.status === "planned" && item.priority === "high")).toBe(true);
    expect(removed[1]?.section).toBe("sections/method.tex");
    expect(removed[1]?.instruction).toContain("恢复该引用");
    expect(plan.summary.planned).toBe(2);
  });
});

describe("computeCitationPreservation：以修订快照为事实源", () => {
  async function projectWithRevisions(
    revisions: { intro: string; reason: string }[],
  ): Promise<{ projects: ProjectStore; revisions: ManuscriptRevisionStore; reviewArtifacts: ReviewArtifactStore; projectId: string }> {
    const root = await mkdtemp(join(tmpdir(), "paperteam-citepres-"));
    tempRoots.push(root);
    const projects = new ProjectStore({ root });
    const project = await projects.create("引用保持");
    const store = new ManuscriptRevisionStore({ projects });
    const manuscriptDir = projects.manuscriptDir(project.id);
    await mkdir(join(manuscriptDir, "sections"), { recursive: true });
    await writeFile(join(manuscriptDir, "main.tex"), "\\documentclass{ctexart}\n\\begin{document}\n\\input{sections/intro}\n\\bibliography{references}\n\\end{document}\n", "utf8");
    await writeFile(join(manuscriptDir, "references.bib"), "@article{k01, title={A}}\n@article{k02, title={B}}\n", "utf8");
    for (const entry of revisions) {
      await writeFile(join(manuscriptDir, "sections", "intro.tex"), entry.intro, "utf8");
      await store.commit(project.id, entry.reason);
    }
    return { projects, revisions: store, reviewArtifacts: new ReviewArtifactStore(projects), projectId: project.id };
  }

  it("单一修订 → null（不可比较）；两次修订删光引用 → catastrophic；用户恢复历史修订 → null", async () => {
    const single = await projectWithRevisions([{ intro: "\\section{引言}\n\\cite{k01} \\cite{k02}", reason: "writing.sections" }]);
    expect(await computeCitationPreservation(single, single.projectId, 1)).toBeNull();

    const dropped = await projectWithRevisions([
      { intro: "\\section{引言}\n\\cite{k01} \\cite{k02}", reason: "writing.sections" },
      { intro: "\\section{引言}\n修订后没有引用。", reason: "revision.revise" },
    ]);
    const summary = await computeCitationPreservation(dropped, dropped.projectId, 2);
    expect(summary?.previousRevision).toBe(1);
    expect(summary?.currentRevision).toBe(2);
    expect(summary?.catastrophic).toBe(true);
    expect(summary?.unexpectedRemoved).toEqual([
      { key: "k01", files: ["sections/intro.tex"] },
      { key: "k02", files: ["sections/intro.tex"] },
    ]);

    const restored = await projectWithRevisions([
      { intro: "\\section{引言}\n\\cite{k01} \\cite{k02}", reason: "writing.sections" },
      { intro: "\\section{引言}\n\\cite{k01}", reason: "revision.revise" },
    ]);
    await restored.revisions.restore(restored.projectId, 1);
    const state = await restored.revisions.load(restored.projectId);
    expect(state.revisions.at(-1)?.reason).toBe("revision.restore");
    expect(await computeCitationPreservation(restored, restored.projectId, state.current)).toBeNull();
  });

  it("承认 sourceRevision == previous 的 quality 计划（citation_missing）；历史回归跨越多个修订也能对上基线", async () => {
    const planned = await projectWithRevisions([
      { intro: "\\section{引言}\n\\cite{k01} \\cite{ghost}", reason: "writing.sections" },
      { intro: "\\section{引言}\n\\cite{k01}", reason: "revision.revise" },
    ]);
    await planned.reviewArtifacts.savePlan(
      planned.projectId,
      planWith({ projectId: planned.projectId, sourceRevision: 1, reviewRound: 1, citationMissing: [{ key: "ghost", files: ["sections/intro.tex"] }] }),
    );
    const summary = await computeCitationPreservation(planned, planned.projectId, 2);
    expect(summary?.ok).toBe(true);
    expect(summary?.allowedRemovedKeys[0]?.basis).toBe("planned_citation_missing");
    expect(summary?.planId).toBe("plan-r1-rev1");

    const regression = await projectWithRevisions([
      { intro: "\\section{引言}\n\\cite{k01} \\cite{k02}", reason: "writing.sections" },
      { intro: "\\section{引言}\n第二版没有引用。", reason: "revision.revise" },
      { intro: "\\section{引言}\n第三版仍没有引用。", reason: "revision.revise" },
    ]);
    const third = await computeCitationPreservation(regression, regression.projectId, 3);
    expect(third?.ok).toBe(false);
    expect(third?.historicalRegression).toEqual({ baselineRevision: 1, baselineCount: 2 });
  });
});

describe("10. Quick Review（existing_paper_review）不受影响", () => {
  it("定义里没有 quality.gate / revision.* stage：引用保持规则不可能进入只读 Review", () => {
    const definition = createExistingPaperReviewDefinition({} as unknown as WorkflowServices);
    const ids = definition.stages.map((stage) => stage.id);
    expect(ids).not.toContain("quality.gate");
    expect(ids.some((id) => id.startsWith("revision."))).toBe(false);
    void ({} as AgentRuntime);
  });
});
