/**
 * M10.3.1 单元测试（确定性，无 LLM）：Revision Reliability Closure。
 *
 * G1 — Cumulative Fact Preservation（任务 §10 Cases A–D）：
 *   A：rev1 → rev2 引入未授权数值 → 累计 unresolved ≥ 1
 *   B：rev2 → rev3 不再触碰该段 → pairwise clean 但累计违规仍在 → Final FAIL
 *   C：恢复冻结原值 → 累计 ok + resolvedViolations 记录
 *   D：授权台账（expectedFactChanges / 条目文本）→ 合法变更 → resolved as authorized
 * 另：pairwise 授权的「漂洗」修复——fact_preserve 条目文本含 before → after 片段，
 *   不得授权「保留违规值」；只授权恢复方向（改回 / 加回 / 删除违规新增）。
 *
 * G1 — Deterministic Fact Restore：唯一锚点可恢复；锚点歧义 / 引用丢失守卫不恢复。
 *
 * G2 — Claim Gap Audit：数值全命中冻结基线 → pre-existing；user_confirmed 证据
 *   数值覆盖 → author_data；其余 → revision_introduced；issue 归因排除。
 *
 * G2 — Quality Gate：cumulative_fact_preservation 规则；规则 4/5/6 的修订引入口径。
 * G2 — Feasibility task-aware prompt；buildRevisionPlan 的 inapplicable / factRestore。
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import {
  appendFactAuthorizations,
  computeCumulativeFactPreservation,
  readFactAuthorizations,
  recordImprovementPlanApproval,
  type FactAuthorizationEntry,
} from "../../src/quality/cumulativeFactPreservation.js";
import { evaluateFactPreservation, type FactTexFile } from "../../src/quality/factPreservation.js";
import { applyFactRestore, planFactRestore } from "../../src/quality/factRestore.js";
import { computeClaimGapAudit } from "../../src/review/claimGapAudit.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";
import { buildRevisionPlan, findingFingerprint } from "../../src/review/revisionPlan.js";
import { buildFeasibilityPrompt } from "../../src/agents/FeasibilityService.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function newProjectRoot(): Promise<{ root: string; projects: ProjectStore }> {
  const root = await mkdtemp(join(tmpdir(), "m1031-units-"));
  roots.push(root);
  return { root, projects: new ProjectStore({ root }) };
}

/** λ_smooth 型单文件论文（三段结构：引言 / 超参段 / 表格段） */
const FROZEN_TEX = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "",
  "\\section{引言}",
  "本文在公开数据集上验证所提方法，MOTA 提升 12.4\\%。",
  "",
  "\\section{超参数选择}",
  "λ\\_smooth 较小（0.25 至 0.5）时 MOTA 与 IDF1 影响不大，故取 0.5。",
  "",
  "\\section{主结果}",
  "\\begin{tabular}{ll}",
  "方法 & MOTA \\\\",
  "Ours & 82.4 \\\\",
  "\\end{tabular}",
  "",
  "\\end{document}",
].join("\n");

/** rev-2：超参段被未授权改写（λ_smooth 型漂移——新对比数字 + 结论改写） */
const DRIFT_SENTENCE_FROM = "λ\\_smooth 较小（0.25 至 0.5）时 MOTA 与 IDF1 影响不大，故取 0.5。";
const DRIFT_SENTENCE_TO =
  "λ\\_smooth 从 0.25 至 0.5 的对比（MOTA：67.3 与 67.1；IDF1：71.5 与 71.0）重新确认取值，原判断不再成立。";
const DRIFTED_TEX = FROZEN_TEX.replace(DRIFT_SENTENCE_FROM, DRIFT_SENTENCE_TO);

function texFile(content: string): FactTexFile[] {
  return [{ file: "main.tex", content }];
}

async function commitRevision(
  projects: ProjectStore,
  revisions: ManuscriptRevisionStore,
  projectId: string,
  reason: string,
  content: string,
): Promise<number> {
  await writeFile(join(projects.manuscriptDir(projectId), "main.tex"), content, "utf8");
  return revisions.commit(projectId, reason, "run-test").then((result) => result.revision);
}

describe("G1 Cumulative Fact Preservation（任务 §10 Cases A–D）", () => {
  async function newStackWithProject(): Promise<{
    projects: ProjectStore;
    revisions: ManuscriptRevisionStore;
    reviewArtifacts: ReviewArtifactStore;
    evidence: EvidenceStore;
    projectId: string;
  }> {
    const { projects } = await newProjectRoot();
    const revisions = new ManuscriptRevisionStore({ projects });
    const reviewArtifacts = new ReviewArtifactStore(projects);
    const evidence = new EvidenceStore(projects);
    const project = await projects.create("M10.3.1 累计守卫", {});
    await mkdir(projects.manuscriptDir(project.id), { recursive: true });
    await commitRevision(projects, revisions, project.id, "baseline", FROZEN_TEX);
    return { projects, revisions, reviewArtifacts, evidence, projectId: project.id };
  }

  it("Case A：rev1 → rev2 引入未授权数值 → 累计 unresolved ≥ 1（ok=false）", async () => {
    const stack = await newStackWithProject();
    await commitRevision(stack.projects, stack.revisions, stack.projectId, "revision.apply", DRIFTED_TEX);
    const cumulative = await computeCumulativeFactPreservation(
      { ...stack },
      stack.projectId,
      2,
    );
    expect(cumulative).not.toBeNull();
    expect(cumulative!.ok).toBe(false);
    expect(cumulative!.baselineRevision).toBe(1);
    expect(cumulative!.unresolvedViolations.length).toBeGreaterThanOrEqual(1);
    // 漂移值进入违规明细（67.3 类无授权新增）
    const allText = cumulative!.unresolvedViolations.map((v) => `${v.before} ${v.after}`).join("\n");
    expect(/67\.[13]/.test(allText)).toBe(true); // 配对按多重集序：67.1 或 67.3 皆证明漂移入明细
  });

  it("Case B：rev2 → rev3 不再触碰该段 → pairwise clean 但累计违规 carry-forward → gate Final FAIL", async () => {
    const stack = await newStackWithProject();
    await commitRevision(stack.projects, stack.revisions, stack.projectId, "revision.apply", DRIFTED_TEX);
    // rev-3：漂移段原样保留（后续轮把 rev-2 当既有稿）
    await commitRevision(stack.projects, stack.revisions, stack.projectId, "revision.revise", DRIFTED_TEX + "\n% 后续润色");
    // pairwise rev2 → rev3：漂移段无变化（previous → current 干净）
    const pairwise = evaluateFactPreservation({
      previous: { revision: 2, files: texFile(DRIFTED_TEX) },
      current: { revision: 3, files: texFile(DRIFTED_TEX + "\n% 后续润色") },
      plan: null,
    });
    expect(pairwise.ok).toBe(true); // previous → current 干净（换行/润色不触发数值违规）
    // 累计 rev1 → rev3：违规仍在
    const cumulative = await computeCumulativeFactPreservation({ ...stack }, stack.projectId, 3);
    expect(cumulative).not.toBeNull();
    expect(cumulative!.ok).toBe(false);
    expect(cumulative!.unresolvedViolations.length).toBeGreaterThanOrEqual(1);
    // Final 判定：quality gate 引用累计结果 → FAIL
    const summary = emptyPassSummary();
    const gate = evaluateQualityGate(
      { review: summary, citation: null, evidence: emptyEvidenceStats(), feasibility: null, cumulativeFactPreservation: cumulative },
    );
    const cumulativeRule = gate.rules.find((rule) => rule.rule === "cumulative_fact_preservation");
    expect(cumulativeRule).toBeDefined();
    expect(cumulativeRule!.passed).toBe(false);
    expect(gate.passed).toBe(false);
  });

  it("Case C：后续恢复冻结原值 → 累计 ok + 历史违规进入 resolvedViolations", async () => {
    const stack = await newStackWithProject();
    await commitRevision(stack.projects, stack.revisions, stack.projectId, "revision.apply", DRIFTED_TEX);
    // 第一轮 gate 落盘（含累计违规——resolved 计算的历史事实源）
    const r2 = await computeCumulativeFactPreservation({ ...stack }, stack.projectId, 2);
    expect(r2!.ok).toBe(false);
    await saveGate(stack, 2, r2!);
    // rev-3：恢复冻结原文
    await commitRevision(stack.projects, stack.revisions, stack.projectId, "revision.restore_facts", FROZEN_TEX);
    const r3 = await computeCumulativeFactPreservation({ ...stack }, stack.projectId, 3);
    expect(r3).not.toBeNull();
    expect(r3!.ok).toBe(true);
    expect(r3!.unresolvedViolations).toHaveLength(0);
    expect(r3!.resolvedViolations.length).toBeGreaterThanOrEqual(1);
  });

  it("Case D：授权台账（expectedFactChanges）→ 合法修改 → 累计 ok（authorizedChanges ≥ 1）", async () => {
    const stack = await newStackWithProject();
    // 已批准改进计划：把 0.5 改为 0.3（携带依据）
    const authorized = FROZEN_TEX.replace("故取 0.5。", "故取 0.3。");
    await commitRevision(stack.projects, stack.revisions, stack.projectId, "revision.apply", authorized);
    const entries: FactAuthorizationEntry[] = [
      {
        recordedAt: new Date().toISOString(),
        source: "improvement_plan_approved",
        itemId: "improvement:1",
        section: "main.tex",
        text: "依据消融结果更新 λ\\_smooth 取值说明\n0.5 → 0.3（依据：表 7 消融）",
        expectedFactChanges: [{ before: "0.5", after: "0.3", basis: "表 7 消融" }],
      },
    ];
    expect(await appendFactAuthorizations(stack.projects, stack.projectId, entries)).toBe(1);
    // 幂等：重复登记不膨胀
    expect(await appendFactAuthorizations(stack.projects, stack.projectId, entries)).toBe(0);
    const cumulative = await computeCumulativeFactPreservation({ ...stack }, stack.projectId, 2);
    expect(cumulative).not.toBeNull();
    expect(cumulative!.ok).toBe(true);
    expect(cumulative!.authorizedChanges).toBeGreaterThanOrEqual(1);
    expect(cumulative!.authorizationSources.ledgerEntries).toBe(1);
  });

  it("台账覆盖 improvement-plan.json 被后续 run 覆盖的场景（授权不丢失）", async () => {
    const { root, projects } = await newProjectRoot();
    const project = await projects.create("台账持久化", {});
    await mkdir(join(root, project.id, "research"), { recursive: true });
    const planPath = join(root, project.id, "research", "improvement-plan.json");
    await writeFile(
      planPath,
      JSON.stringify({
        plan: {
          items: [
            {
              section: "main.tex",
              action: "更新数值说明",
              rationale: "消融依据",
              expectedFactChanges: [{ before: "0.5", after: "0.3", basis: "表 7" }],
              relatedEvidenceIds: ["E1"],
              instructionId: "x-1",
            },
          ],
        },
      }),
      "utf8",
    );
    expect(await recordImprovementPlanApproval(projects, project.id, "run-1")).toBe(1);
    // 后续 run 覆盖计划文件（不含授权）
    await writeFile(planPath, JSON.stringify({ plan: { items: [] } }), "utf8");
    const ledger = await readFactAuthorizations(projects, project.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.expectedFactChanges?.[0]?.after).toBe("0.3");
    expect(ledger[0]?.instructionId).toBe("x-1");
  });

  async function saveGate(
    stack: { projects: ProjectStore; reviewArtifacts: ReviewArtifactStore; projectId: string },
    round: number,
    cumulative: NonNullable<Awaited<ReturnType<typeof computeCumulativeFactPreservation>>>,
  ): Promise<void> {
    const summary = emptyPassSummary();
    summary.round = round;
    const gate = evaluateQualityGate({
      review: summary,
      citation: null,
      evidence: emptyEvidenceStats(),
      feasibility: null,
      cumulativeFactPreservation: cumulative,
    });
    const { saveQualityGateReport } = await import("../../src/quality/gates.js");
    await saveQualityGateReport(stack.projects, stack.projectId, round, gate, summary, {
      cumulativeFactPreservation: cumulative,
    });
  }
});

describe("G1 pairwise 授权漂洗修复（fact_preserve 不再洗白漂移）", () => {
  const planWithFactPreserve = {
    schemaVersion: 1 as const,
    planId: "plan-r2-rev2",
    projectId: "p",
    sourceRevision: 2,
    reviewRound: 2,
    createdAt: new Date().toISOString(),
    summary: { critical: 1, major: 0, blocking: 0, minorRecorded: 0, planned: 1, skipped: 0 },
    items: [
      {
        id: `fact-preserve:${"a".repeat(16)}`,
        kind: "fact_preserve" as const,
        priority: "high" as const,
        section: "main.tex",
        problem:
          "实验事实被无依据修改：prose_number：0.5 → 67.3（λ 段对比数字）",
        instruction: "恢复上一修订中的实验事实原值",
        expectedOutcome: "fact_preservation 转为通过",
        status: "planned" as const,
        riskLevel: "high" as const,
        factRestore: { removeValues: ["67.3"], restoreValues: [] },
      },
    ],
  };

  it("洗白关闭：fact_preserve 文本点名 0.5 与 67.3，但 0.5 → 67.3 的新变更仍判违规", () => {
    // rev-2 取 0.5；rev-3（fact_preserve 计划派发轮）把该值改成 67.3——
    // 旧实现对含 before/after 双值的计划文本对称授权（洗白）；修复后必须违规
    const current = FROZEN_TEX.replace("故取 0.5。", "故取 67.3。");
    const summary = evaluateFactPreservation({
      previous: { revision: 2, files: texFile(FROZEN_TEX) },
      current: { revision: 3, files: texFile(current) },
      plan: planWithFactPreserve as never,
    });
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts.length).toBeGreaterThanOrEqual(1);
  });

  it("恢复方向（违规新增值删除 + 原值加回）经 factRestore 授权", () => {
    const restored = DRIFTED_TEX.replace(DRIFT_SENTENCE_TO, DRIFT_SENTENCE_FROM);
    const restorePlan = {
      ...planWithFactPreserve,
      items: [
        {
          ...planWithFactPreserve.items[0]!,
          factRestore: { removeValues: ["67.3", "67.1", "71.5", "71.0"], restoreValues: ["0.5"] },
        },
      ],
    };
    const summary = evaluateFactPreservation({
      previous: { revision: 2, files: texFile(DRIFTED_TEX) },
      current: { revision: 3, files: texFile(restored) },
      plan: restorePlan as never,
    });
    // 4 个违规新增值处置：1 个与加回的 0.5 配对为 changed（restoreValues 授权），
    // 3 个为 removal（removeValues 授权）——全部 planned_fact_restore，不计违规
    expect(summary.ok).toBe(true);
    expect(summary.allowedRemovals).toBeGreaterThanOrEqual(3);
    expect(summary.allowedChanges).toBeGreaterThanOrEqual(1);
  });

  it("恢复方向（改回原值 + 漂移值删除）经 factRestore 双清单授权", () => {
    // 与 buildCumulativeFactRegressions 的真实产物一致：changed 违规同时携带
    // restoreValues（改回的原值）与 removeValues（要删除的漂移值）——配对前
    // 分流后两个方向各自走 valueAddition / valueRemoval 授权
    const restorePlan = {
      ...planWithFactPreserve,
      items: [
        {
          ...planWithFactPreserve.items[0]!,
          factRestore: { removeValues: ["67.3"], restoreValues: ["0.5"] },
        },
      ],
    };
    const summary = evaluateFactPreservation({
      previous: { revision: 2, files: texFile(FROZEN_TEX.replace("故取 0.5。", "故取 67.3。")) },
      current: { revision: 3, files: texFile(FROZEN_TEX) },
      plan: restorePlan as never,
    });
    expect(summary.ok).toBe(true);
    expect(summary.allowedChanges).toBeGreaterThanOrEqual(1);
    expect(summary.allowedRemovals).toBeGreaterThanOrEqual(1);
  });

  it("通用计划文本（fact_preserve 之外）仍按 plan_value_correction 授权", () => {
    const changed = FROZEN_TEX.replace("故取 0.5。", "故取 0.4。");
    const valuePlan = {
      ...planWithFactPreserve,
      items: [
        {
          ...planWithFactPreserve.items[0]!,
          kind: "review_finding" as const,
          id: "f-abc",
          problem: "修正超参记录：0.5 → 0.4",
        },
      ],
    };
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(FROZEN_TEX) },
      current: { revision: 2, files: texFile(changed) },
      plan: valuePlan as never,
    });
    expect(summary.ok).toBe(true);
    expect(summary.allowedChanges).toBeGreaterThanOrEqual(1);
  });
});

describe("G1 Deterministic Fact Restore（planFactRestore / applyFactRestore）", () => {
  const violation = (newValue: string, oldValue: string | undefined, kind: "changed" | "added_unsupported" = "changed") => ({
    kind,
    file: "main.tex",
    section: "超参数选择",
    before: "λ\\_smooth 较小（0.25 至 0.5）时…",
    after: "（MOTA：67.3 与 67.1）…",
    reason: kind === "changed" ? "prose_number" : "added_number",
    classification:
      kind === "changed"
        ? { category: "A" as const, type: "number_changed", severity: "high" as const, oldValue, newValue }
        : { category: "A" as const, type: "number_added", severity: "high" as const, newValue },
    violationKey: `k-${newValue}`,
  });

  it("唯一锚点 + 冻结段相似命中 → 可恢复且应用后段落还原", () => {
    const plan = planFactRestore(texFile(FROZEN_TEX), texFile(DRIFTED_TEX), [
      violation("67.3", "0.5"),
    ]);
    expect(plan.restorable).toHaveLength(1);
    expect(plan.restorable[0]!.resolves).toEqual(["k-67.3"]);
    const applied = applyFactRestore(texFile(DRIFTED_TEX), plan);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.content).toContain("λ\\_smooth 较小（0.25 至 0.5）时 MOTA 与 IDF1 影响不大");
    expect(applied[0]!.content).not.toContain("67.3");
  });

  it("锚点歧义（新值出现在多个段落）→ 不恢复", () => {
    const ambiguous = DRIFTED_TEX + "\n\n另一处也提到 67.3 的对照。";
    const plan = planFactRestore(texFile(FROZEN_TEX), texFile(ambiguous), [
      violation("67.3", "0.5"),
    ]);
    expect(plan.restorable).toHaveLength(0);
    expect(plan.skipped.some((entry) => entry.reason === "anchor_ambiguous")).toBe(true);
  });

  it("当前段落含冻结段没有的 \\cite → 不恢复（引用守卫）", () => {
    const withCite = DRIFTED_TEX.replace(
      DRIFT_SENTENCE_TO,
      DRIFT_SENTENCE_TO.replace("重新确认取值", "重新确认取值\\cite{a}"),
    );
    const plan = planFactRestore(texFile(FROZEN_TEX), texFile(withCite), [
      violation("67.3", "0.5"),
    ]);
    expect(plan.restorable).toHaveLength(0);
    expect(plan.skipped.some((entry) => entry.reason === "would_lose_citations")).toBe(true);
  });

  it("changed 类要求冻结段含旧值（恢复方向正确性）", () => {
    const frozenNoOld = FROZEN_TEX.replace("（0.25 至 0.5）", "（0.25 至 0.9）").replace("故取 0.5。", "故取 0.9。");
    const plan = planFactRestore(texFile(frozenNoOld), texFile(DRIFTED_TEX), [
      violation("67.3", "0.5"),
    ]);
    expect(plan.restorable).toHaveLength(0);
  });
});

describe("G2 Claim Gap Audit（task-aware 归层 + issue 归因）", () => {
  const frozenFiles = [{ file: "main.tex", content: FROZEN_TEX }];

  function authorEvidence(claim: string): EvidenceRecord {
    return {
      id: "E9",
      claim,
      verificationStatus: "unverified",
      verificationLevel: "user_confirmed",
      createdAt: new Date().toISOString(),
    } as unknown as EvidenceRecord;
  }

  it("数值全命中冻结基线 → pre-existing；作者证据覆盖 → author_data；其余 revision_introduced", () => {
    const audit = computeClaimGapAudit({
      projectId: "p1",
      round: 3,
      baselineRevision: 1,
      unsupportedClaims: [
        {
          claimId: "c-1",
          section: "abstract",
          claim: "MOTA 提升 12.4 的对比结果",
          verdict: "UNSUPPORTED",
          evidenceFormal: false,
          repairCandidates: [],
        },
        {
          claimId: "c-2",
          section: "实验",
          claim: "HARM 变体 IDSW 由 116 增至 125",
          verdict: "UNSUPPORTED",
          evidenceFormal: false,
          repairCandidates: [],
        },
        {
          claimId: "c-3",
          section: "方法",
          claim: "rgate 带来 33.6 的增益",
          verdict: "UNSUPPORTED",
          evidenceFormal: false,
          repairCandidates: [],
        },
      ],
      issues: [],
      frozenFiles,
      authorEvidence: [authorEvidence("Phase4.3 负结果：arm0 IDSW 116，R 加权后 125")],
    });
    const byId = new Map(audit.claims.map((claim) => [claim.claimId, claim]));
    expect(byId.get("c-1")?.applicability).toBe("excluded_pre_existing"); // 12.4 在冻结稿
    expect(byId.get("c-2")?.applicability).toBe("excluded_author_data"); // 116/125 由作者证据覆盖
    expect(byId.get("c-3")?.applicability).toBe("revision_introduced"); // 33.6 无任何覆盖
    expect(audit.counts.revisionIntroduced).toBe(1);
  });

  it("issue 归因：引用 pre-existing claim 的 fact critical 被排除（gate 规则 4/5/6 消费）", () => {
    const factIssue: ReviewIssue = {
      category: "fact",
      severity: "critical",
      section: "abstract",
      description: "摘要仍声明'MOTA 提升 12.4 的对比结果'，证据库无任何对比实验记录",
      suggestedAction: "修正",
      blocking: true,
    };
    const academicIssue: ReviewIssue = {
      category: "academic",
      severity: "major",
      section: "方法",
      description: "方法训练机制未定义，贡献表述过强",
      suggestedAction: "补全",
      blocking: false,
    };
    const audit = computeClaimGapAudit({
      projectId: "p1",
      round: 3,
      baselineRevision: 1,
      unsupportedClaims: [
        {
          claimId: "c-1",
          section: "abstract",
          claim: "MOTA 提升 12.4 的对比结果",
          verdict: "UNSUPPORTED",
          evidenceFormal: false,
          repairCandidates: [],
        },
      ],
      issues: [factIssue, academicIssue],
      frozenFiles,
      authorEvidence: [],
    });
    const attributed = audit.issueAttribution.find(
      (entry) => entry.fingerprint === findingFingerprint(factIssue),
    );
    expect(attributed?.excluded).toBe(true);
    expect(audit.counts.issues.excludedCritical).toBe(1);
    expect(audit.counts.issues.excludedMajor).toBe(0);

    // gate：规则 4/5/6 只对修订引入口径计数（原稿既有 critical 不阻断）
    const summary = emptyPassSummary();
    summary.unsupportedCriticalClaims = 1;
    summary.counts = { critical: 1, major: 1, minor: 0, byCategory: { fact: 1, academic: 1 }, blocking: 1 };
    summary.openCritical = 1;
    summary.openMajor = 1;
    summary.issues = [factIssue, academicIssue];
    const gate = evaluateQualityGate({
      review: summary,
      citation: null,
      evidence: emptyEvidenceStats(),
      feasibility: null,
      claimGapAudit: audit,
    });
    const rule4 = gate.rules.find((rule) => rule.rule === "unsupported_critical_claims_zero");
    expect(rule4!.passed).toBe(true);
    expect(rule4!.detail).toContain("原稿既有 1");
    const rule5 = gate.rules.find((rule) => rule.rule === "blocking_issues_zero");
    expect(rule5!.passed).toBe(true);
    const rule6 = gate.rules.find((rule) => rule.rule === "open_critical_major_zero");
    expect(rule6!.passed).toBe(false); // academic major 仍在（作者级，如实阻断）
  });
});

describe("G2 feasibility task-aware prompt + revision plan 接线", () => {
  it("existing_paper prompt 携带适用性纪律与 criterionApplicability schema；idea 流程不含", () => {
    const project = {
      title: "t",
      documentType: "journal_article",
      targetProfile: "core_journal",
      targetVenue: "CEA",
      researchIdea: "idea",
    } as never;
    const research = { domainOverview: "d", researchGaps: [], potentialContributions: [] } as never;
    const stats = emptyEvidenceStats();
    const existing = buildFeasibilityPrompt(project, research, stats, "existing_paper");
    expect(existing).toContain("task-aware applicability");
    expect(existing).toContain("criterionApplicability");
    expect(existing).toContain("永远 required");
    const idea = buildFeasibilityPrompt(project, research, stats, "idea");
    expect(idea).not.toContain("task-aware applicability");
    expect(idea).not.toContain("criterionApplicability");
  });

  it("buildRevisionPlan：inapplicable finding 记录为 skipped；fact_preserve 携带 factRestore", () => {
    const factIssue: ReviewIssue = {
      category: "fact",
      severity: "critical",
      section: "abstract",
      description: "摘要仍声明 RDK X3 部署结果",
      suggestedAction: "修正",
      blocking: true,
    };
    const summary = emptyPassSummary();
    summary.issues = [factIssue];
    summary.counts = { critical: 1, major: 0, minor: 0, byCategory: { fact: 1 }, blocking: 1 };
    const plan = buildRevisionPlan({
      projectId: "p",
      sourceRevision: 2,
      reviewRound: 2,
      summary,
      inapplicableFindings: [{ fingerprint: findingFingerprint(factIssue) }],
      factRegressions: [
        {
          file: "main.tex",
          detail: "prose_number：0.5 → 0.3",
          violationKey: "a".repeat(16),
          restoreValues: ["0.5"],
          removeValues: [],
          restorable: true,
        },
      ],
    });
    const skippedFinding = plan.items.find((item) => item.id === findingFingerprint(factIssue));
    expect(skippedFinding?.status).toBe("skipped");
    expect(skippedFinding?.note).toContain("返修语境不适用");
    const factItem = plan.items.find((item) => item.kind === "fact_preserve");
    expect(factItem?.id).toBe(`fact-preserve:${"a".repeat(16)}`);
    expect(factItem?.status).toBe("planned");
    expect(factItem?.factRestore?.restoreValues).toEqual(["0.5"]);
    expect(factItem?.note).toContain("revision.restore_facts");
  });
});

// ---- fixtures ----

function emptyPassSummary(): ReviewSummary {
  return {
    generatedAt: new Date().toISOString(),
    round: 1,
    issues: [],
    counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
    scores: { academicScore: 88, styleRisk: 10, factVerdicts: null },
    openCritical: 0,
    openMajor: 0,
    unsupportedCriticalClaims: 0,
    reportPaths: [],
  };
}

function emptyEvidenceStats() {
  return {
    total: 0,
    byStatus: { verified: 0, unverified: 0, rejected: 0, superseded: 0 },
    byVerificationLevel: { grounded_verified: 0, user_confirmed: 0, unverified: 0 },
    contradictory: 0,
    formal: 0,
    excluded: 0,
  } as never;
}

describe("G1 真实 E2E 噪声类回归（M10.3.1 rerun 实测驱动的四处修复）", () => {
  it("词内数字伪 token：BDD100K / YOLOv11 重排不产生假 changed（lookbehind 含 \\d）", () => {
    const previous = [
      "\\section{实验}",
      "在 BDD100K 与 YOLOv11 上验证，MOTA 提升 12.4\\%。",
    ].join("\\n");
    const current = [
      "\\section{实验}",
      "在 YOLOv11 与 BDD100K 上验证（顺序重排），另提 BDD100K 一次，MOTA 提升 12.4\\%。",
    ].join("\\n");
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(current) },
      plan: null,
    });
    expect(summary.ok).toBe(true); // 无 00K / 1 伪 token 配对
  });

  it("交叉引用编号：新增「式(12) / 式(17)--(19) / 表 7」不算数值新增", () => {
    const previous = "\\section{方法}\\n如式(12) 所示，增益为 0.5。\\n";
    const current = "\\section{方法}\\n如式(12) 与式(17)--(19) 及表 7 所示，增益为 0.5。\\n";
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(current) },
      plan: null,
    });
    expect(summary.ok).toBe(true);
  });

  it("prose → 内联数学赋值迁移：「模板数超过 20」→「$N_{\\max}=20$」不是删除", () => {
    const previous = "\\section{参数}\\n实验中当模板数超过 20 后收益趋于饱和。\\n";
    const current = "\\section{参数}\\n实验中取 $N_{\\max}=20$。\\n";
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(current) },
      plan: null,
    });
    expect(summary.ok).toBe(true);
  });

  it("bib-keyed 方法论行：引用既有 key 且剥离 key 后无数字 → 授权新增；夹带数值不放行", () => {
    const table = (row: string): string =>
      [
        "\\section{对比}",
        "\\begin{table}[h]",
        "\\caption{方法定位}",
        "\\label{tab:method_position}",
        "\\begin{tabular}{ll}",
        "方法 & 关联方式 \\\\",
        row,
        "\\end{tabular}",
        "\\end{table}",
      ].join("\\n");
    const previous = table("ByteTrack \\\\");
    const base = table("Deep OC-SORT Maggiolino2023DeepOCSORT & 检测驱动 \\\\");
    const bibKeys = ["Maggiolino2023DeepOCSORT", "bytetrack2022"];
    const legit = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(base) },
      plan: null,
      bibliographyKeys: bibKeys,
    });
    expect(legit.ok).toBe(true);
    expect(legit.allowedChanges).toBeGreaterThanOrEqual(1);
    const smuggled = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(base.replace("检测驱动", "检测驱动 82.4")) },
      plan: null,
      bibliographyKeys: bibKeys,
    });
    expect(smuggled.ok).toBe(false); // 行内实验数值仍须 Evidence/计划授权
  });

  it("公式事实只认含关系/运算符的数学段：表头箭头与符号引用不是公式", () => {
    const previous = "\\section{主结果}\\nFPS$\\uparrow$ 与 $\\text{mAP}_{50}\\uparrow$ 列于表 1。\\n损失为 $L = a + b$。\\n";
    const current = "\\section{主结果}\\n（表头指示重排为文字）mAP50 与 FPS 列于表 1。\\n损失为 $L = a + b$。\\n";
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(current) },
      plan: null,
    });
    expect(summary.ok).toBe(true); // 箭头指示消失不算公式漂移；含 = 的 $L=a+b$ 未动
  });
});

describe("G1 公式新增授权扩展（rgate 展开式实例）", () => {
  it("计划给出『更新式 + 符号』→ 以该符号定义的展开式公式授权新增", () => {
    const previous = "\\section{方法}\n模板记忆按固定率更新。\n";
    const current = [
      "\\section{方法}",
      "\\begin{equation}",
      "R_t = Q_t \\cdot C_t,",
      "\\eta_t = 0.05 + 0.20\\, R_t,",
      "\\mathbf{e}_t^k = (1 - \\eta_t)\\, \\mathbf{e}_{t-1}^k + \\eta_t\\, f_t^i.",
      "\\end{equation}",
      "模板记忆按门控率更新。",
    ].join("\n");
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(current) },
      plan: null,
      improvementPlanItems: [
        {
          section: "main.tex",
          action: "新增门控小节：给出 R_t=Q_t·C_t 与 η_t=0.05+0.20·R_t 的零参数门控 EMA 更新式",
        },
      ],
    });
    expect(summary.ok).toBe(true);
    // equation 环境整体为 1 个公式段；骨架/符号授权至少放行 1 项
    expect(summary.allowedChanges).toBeGreaterThanOrEqual(1);
  });

  it("无计划支撑的公式新增仍判违规（授权不放宽到任意公式）", () => {
    const previous = "\\section{方法}\n模板记忆按固定率更新。\n";
    const current = "\\section{方法}\n\\begin{equation}\nx = a + b.\n\\end{equation}\n";
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(current) },
      plan: null,
      improvementPlanItems: [
        { section: "main.tex", action: "措辞统一条目：将『本文方法』统一为『所提方法』" },
      ],
    });
    expect(summary.ok).toBe(false);
    expect(summary.addedUnsupportedFacts.length).toBeGreaterThanOrEqual(1);
  });
});
describe("G1 恢复 rerun 实录回归（配对前分流 + 三类提取噪声）", () => {
  it("配对前分流：已授权新增值不被无关删除值 launder 成假 changed（板端值恢复实例）", () => {
    // rev2 丢板端值 0.9986（作者块同时消失一个 "4"）；rev3 恢复 0.9986——
    // 0.9986 应走 factRestore.restoreValues 新增授权，"4" 走删除通道，
    // 二者不得被任意配对一个假 changed
    const previous = [
      "\\section{部署}",
      "\\author{徐，冯$^{*}$\\[4pt]",
      "板端检测质量 Q 为 0.9986 与 0.9995。",
    ].join("\n");
    const drifted = previous.replace("板端检测质量 Q 为 0.9986 与 0.9995。", "板端部署完成。");
    const restored = [
      "\\section{部署}",
      "板端检测质量 Q 为 0.9986 与 0.9995。",
    ].join("\n");
    const plan = {
      schemaVersion: 1 as const,
      planId: "p", projectId: "p", sourceRevision: 2, reviewRound: 2,
      createdAt: new Date().toISOString(),
      summary: { critical: 0, major: 0, blocking: 0, minorRecorded: 0, planned: 1, skipped: 0 },
      items: [
        {
          id: "fact-preserve:aaa", kind: "fact_preserve" as const, priority: "high" as const,
          section: "main.tex", problem: "板端值被删", instruction: "恢复", expectedOutcome: "ok",
          status: "planned" as const, riskLevel: "high" as const,
          factRestore: { restoreValues: ["0.9986", "0.9995"], removeValues: [] },
        },
      ],
    };
    const s1 = evaluateFactPreservation({
      previous: { revision: 2, files: texFile(drifted) },
      current: { revision: 3, files: texFile(restored) },
      plan: plan as never,
    });
    expect(s1.ok).toBe(true);
    expect(s1.changedFacts).toHaveLength(0);
    expect(s1.allowedChanges).toBeGreaterThanOrEqual(2);
  });

  it("计划点名的替换（0.5 → 0.4）：新值新增授权 + 旧值替换删除授权（配对前分流不破坏合法更正）", () => {
    const plan = {
      schemaVersion: 1 as const,
      planId: "p", projectId: "p", sourceRevision: 1, reviewRound: 1,
      createdAt: new Date().toISOString(),
      summary: { critical: 0, major: 0, blocking: 0, minorRecorded: 0, planned: 1, skipped: 0 },
      items: [
        {
          id: "f-fix", kind: "review_finding" as const, priority: "high" as const,
          section: "main.tex", problem: "修正超参记录：0.5 → 0.4", instruction: "更正",
          expectedOutcome: "ok", status: "planned" as const,
        },
      ],
    };
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(FROZEN_TEX) },
      current: { revision: 2, files: texFile(FROZEN_TEX.replace("故取 0.5。", "故取 0.4。")) },
      plan: plan as never,
    });
    expect(summary.ok).toBe(true);
    expect(summary.allowedChanges).toBeGreaterThanOrEqual(1);
    expect(summary.allowedRemovals).toBeGreaterThanOrEqual(1);
  });

  it("两侧都未授权的配对仍判 changed（分流不放宽）", () => {
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(FROZEN_TEX) },
      current: { revision: 2, files: texFile(FROZEN_TEX.replace("故取 0.5。", "故取 9.9。")) },
      plan: null,
    });
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts.length).toBeGreaterThanOrEqual(1);
  });

  it("LaTeX 细空格千分位（61\\,047）不再产出 047 伪 token", () => {
    const previous = "\\section{标定}\n标定锚点取自 38 个片段共 61\\,047 个匹配观测。\n";
    const current = "\\section{标定}\n标定锚点取自 61\\,047 个匹配观测（38 个片段）。\n";
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(current) },
      plan: null,
    });
    expect(summary.ok).toBe(true);
  });

  it("千分位逗号断行（61,\\n047）连接后不再产出 047 伪 token", () => {
    const previous = "\\section{标定}\n共 61,\n047 个匹配观测。\n";
    const current = "\\section{标定}\n共 61,047 个匹配观测。\n";
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(previous) },
      current: { revision: 2, files: texFile(current) },
      plan: null,
    });
    expect(summary.ok).toBe(true);
  });

  it("作者块/标题间距宏（\\[4pt] / \\[8pt]）不产出数字 token、不吞显示数学", () => {
    const docA = ["\\section{题注}", "\\title{方法\\[4pt]", "{\\normalsize Subtitle}", "增益为 0.5。", ""].join("\n");
    const docB = ["\\section{题注}", "\\title{方法\\[8pt]", "{\\normalsize Subtitle}", "增益为 0.5。", ""].join("\n");
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: texFile(docA) },
      current: { revision: 2, files: texFile(docB) },
      plan: null,
    });
    expect(summary.ok).toBe(true);
  });
});
