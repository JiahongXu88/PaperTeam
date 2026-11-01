/**
 * M15.19 — 原子子缺口（Actionable Gap → Legitimate Patch → Verified Closure）测试：
 * - G1 审计侧：v2 子缺口解析 + 确定性守卫（稳定 id / 同贡献多子项 / 去重凑数 / 锚回放 / 证据 ≠ 声称 /
 *   先前工作只解析到 pool）；v2 综合调用附带稿件正文；v1 缺省不变（研究复现口径）；
 * - G2 分类：内部证据弱化型 vs 先前工作比较型严格区分；无证据不放行；需实验永不改写；
 * - 计划 / 决策 / 复评：同一贡献「可改写 + 需实验」逐项结算；旧 v1 工件兼容；已决策计划不被新分类覆盖；
 *   需补证据项附缺失来源清单；证据锚不参与派发端「」锚定位。
 */

import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import type { PaperDocument } from "../../src/paper/types.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { ExternalInstructionStore } from "../../src/review/externalInstructions.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { revisionSourceHash } from "../../src/review/revisionScope.js";
import { verifyQuoteInChunk } from "../../src/evidence/quoteVerification.js";
import { sha256Hex } from "../../src/util/hash.js";
import {
  ContributionAuditService,
  CONTRIBUTION_AUDIT_PROMPT_VERSION,
  CONTRIBUTION_AUDIT_PROMPT_VERSION_V2,
  MAX_SUB_GAPS_PER_CONTRIBUTION,
  buildAtomicGapPlan,
  parseSubGapsOutput,
  subGapStableId,
  type ContributionAuditArtifact,
  type ContributionComparison,
  type ContributionUnit,
  type GapPlanItem,
  type PriorWorkPool,
  type RawSubGap,
} from "../../src/target/ContributionAuditService.js";
import {
  TargetAuditRevisionService,
  TARGET_AUDIT_PLAN_CLASSIFIER_VERSION,
  buildEvidenceRequest,
  classifyAuditSubGap,
  rewriteInstructionText,
  authorDecisionInstructionText,
  type AuditPlanAnchorProjection,
} from "../../src/target/TargetAuditRevisionService.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";

// ---- fixtures：一篇英文实证论文（摘要级过度声称 + 实验节反例） ----

const CLAIM = "Our tracker achieves state-of-the-art accuracy on all three benchmarks, outperforming every prior method.";
const EVIDENCE = "On DanceTrack our tracker obtains 61.2 HOTA, below the 63.1 HOTA of the strongest baseline.";
const RELATED = "Prior memory-based trackers reuse temporal features across frames for association.";
const PDF_ONLY = "This sentence exists only in the parsed PDF text and not in any editable TeX file.";

function makeDocument(): PaperDocument {
  const section = (id: string, title: string) => ({ sectionId: id, title, level: 1, pageStart: 1, pageEnd: 2, charCount: 400, source: "toc" as const });
  const chunk = (id: string, sequence: number, sectionId: string, text: string) => ({ chunkId: id, sequence, pageStart: 1, pageEnd: 2, sectionId, text, charCount: text.length });
  return {
    schemaVersion: 1,
    projectId: "p-fixture",
    documentId: "paper-1",
    title: "Memory Tracking",
    abstract: "A tracker.",
    originalFileName: "fixture.pdf",
    bytes: 1,
    sha256: "b".repeat(64),
    parse: { parserId: "test", parsedAt: "2026-11-01T00:00:00.000Z", durationMs: 1, pageCount: 6, extractionQuality: "good" },
    pages: [],
    sections: [section("SEC01", "Introduction"), section("SEC02", "Related Work"), section("SEC03", "Experiments"), section("SEC09", "References")],
    chunks: [
      chunk("C1", 1, "SEC01", `${CLAIM} ${PDF_ONLY} Filler introduction text follows here.`),
      chunk("C2", 2, "SEC02", `${RELATED} We build on this line of work [1].`),
      chunk("C3", 3, "SEC03", `${EVIDENCE} On MOT17 our tracker obtains 64.0 HOTA, the best among compared methods.`),
      chunk("C9", 9, "SEC09", "[1] A. Author. Memory Networks for Tracking. CVPR 2016."),
    ],
    abstractSectionId: undefined,
    referencesSectionId: "SEC09",
    ingestedAt: "2026-11-01T00:00:00.000Z",
  };
}

const SEC01_TEX = `\\section{Introduction}\n\n${CLAIM} Filler introduction text follows here.\n`;
const SEC02_TEX = `\\section{Related Work}\n\n${RELATED} We build on this line of work \\cite{ref1}.\n`;
const SEC03_TEX = `\\section{Experiments}\n\n${EVIDENCE} On MOT17 our tracker obtains 64.0 HOTA, the best among compared methods.\n`;

const POOL: PriorWorkPool = {
  cutoffDate: "2026-11-01",
  queriesUsed: [],
  candidates: [
    {
      candidateId: "P01",
      title: "Memory Networks for Tracking",
      year: 2016,
      abstract: "A tracker with an external memory store that reuses temporal features across frames.",
      citedByManuscript: true,
      contentLevel: "abstract",
      source: "reference-list",
    },
    {
      candidateId: "P02",
      title: "Correlation Filters in Real-Time Tracking",
      year: 2015,
      abstract: "Correlation filter trackers and their variants.",
      citedByManuscript: false,
      contentLevel: "abstract",
      source: "openalex:W1",
    },
  ],
};

const INVENTORY: ContributionUnit[] = [
  { contributionId: "C1", claimQuote: CLAIM, claimType: "performance_advantage", sectionId: "SEC01", supportLocations: [], supportStatus: "missing", anchorVerified: true },
  { contributionId: "C2", claimQuote: RELATED, claimType: "technical_idea", sectionId: "SEC02", supportLocations: [], supportStatus: "missing", anchorVerified: true },
];

/** 与审计 / 计划同口径的确定性回放（verifyQuoteInChunk） */
function verifiers(document: PaperDocument) {
  const text = document.chunks.map((chunk) => chunk.text).join("\n\n");
  const bySection = (id: string) => document.chunks.filter((chunk) => chunk.sectionId === id).map((chunk) => chunk.text).join("\n\n");
  return {
    contributionIds: new Set(INVENTORY.map((unit) => unit.contributionId)),
    sectionIds: new Set(document.sections.map((section) => section.sectionId)),
    verifyAnywhere: (quote: string) => verifyQuoteInChunk(quote, text).ok,
    verifyInSection: (quote: string, sectionId: string) => verifyQuoteInChunk(quote, bySection(sectionId)).ok,
    pool: POOL,
  };
}

const RAW_SUB_GAPS: RawSubGap[] = [
  // C1：同一贡献——可按稿内证据弱化的过度声称 + 需真实实验的显著性分析（M15.18 捆绑问题的拆分形态）
  {
    contributionId: "C1",
    gapKind: "INTERNAL_CLAIM_MISMATCH",
    gap: "Claim of state-of-the-art on all three benchmarks contradicts the DanceTrack result below the strongest baseline.",
    targetQuote: "achieves state-of-the-art accuracy on all three benchmarks, outperforming every prior method",
    targetSectionId: "SEC01",
    evidence: [{ sectionId: "SEC03", quote: EVIDENCE }],
    priorWork: [],
    proposedDirection: "Restrict the claim to benchmarks where the tables show the best result.",
  },
  {
    contributionId: "C1",
    gapKind: "EXPERIMENT_OR_AUTHOR_INPUT",
    gap: "No variance or significance analysis over seeds for the HOTA differences.",
    evidence: [],
    priorWork: [],
    experimentPlan: { purpose: "Quantify run-to-run variance", baselines: "same tracker", datasets: "MOT17", metrics: "HOTA std" },
  },
  // C1：换字眼重复（同类型 + 同目标锚）→ 去重
  {
    contributionId: "C1",
    gapKind: "INTERNAL_CLAIM_MISMATCH",
    gap: "Overclaim: 'all three benchmarks' is not supported by Table DanceTrack row.",
    targetQuote: "achieves  state-of-the-art accuracy on ALL three benchmarks, outperforming every prior method",
    targetSectionId: "SEC01",
    evidence: [{ sectionId: "SEC03", quote: EVIDENCE }],
    priorWork: [],
  },
  // C1：证据锚即声称本身（不能自证）
  {
    contributionId: "C1",
    gapKind: "TEXT_OR_STRUCTURE_CORRECTION",
    gap: "Self-referential evidence.",
    targetQuote: "outperforming every prior method",
    targetSectionId: "SEC01",
    evidence: [{ sectionId: "SEC01", quote: CLAIM }],
    priorWork: [],
  },
  // C2：比较型——仅模型记忆（不解析到 pool）
  {
    contributionId: "C2",
    gapKind: "PRIOR_WORK_COMPARISON",
    gap: "Positioning vs a memory-only recalled survey.",
    targetQuote: RELATED,
    targetSectionId: "SEC02",
    evidence: [],
    priorWork: [{ title: "A Survey Recalled From Memory", year: 2019, quote: "memory" }],
  },
  // C2：比较型——pool 可解析 + quote 回放 + 已在参考文献
  {
    contributionId: "C2",
    gapKind: "PRIOR_WORK_COMPARISON",
    gap: "State the shared mechanism with Memory Networks for Tracking explicitly.",
    targetQuote: "Prior memory-based trackers reuse temporal features across frames",
    targetSectionId: "SEC02",
    evidence: [],
    priorWork: [{ candidateId: "P01", title: "", quote: "reuses temporal features across frames" }],
  },
  // C2：比较型——pool 可解析 + quote 回放，但稿件未引用（不得新增引用）
  {
    contributionId: "C2",
    gapKind: "PRIOR_WORK_COMPARISON",
    gap: "Compare with correlation filter trackers.",
    targetQuote: "for association",
    targetSectionId: "SEC02",
    evidence: [],
    priorWork: [{ candidateId: "P02", title: "", quote: "Correlation filter trackers" }],
  },
  // 未知贡献 → 丢弃
  { contributionId: "C9", gapKind: "INTERNAL_CLAIM_MISMATCH", gap: "ghost", evidence: [], priorWork: [] },
];

describe("G1 审计侧：原子子缺口解析与确定性守卫", () => {
  const document = makeDocument();
  const built = buildAtomicGapPlan(RAW_SUB_GAPS, verifiers(document));

  it("同一贡献产出证据需求不同的多个子项（可改写 + 需实验），各有稳定 id / 类型 / 父贡献", () => {
    const c1 = built.gapPlan.filter((item) => item.contributionId === "C1");
    expect(c1.map((item) => item.gapKind)).toEqual(["INTERNAL_CLAIM_MISMATCH", "EXPERIMENT_OR_AUTHOR_INPUT", "TEXT_OR_STRUCTURE_CORRECTION"]);
    expect(new Set(c1.map((item) => item.subGapId)).size).toBe(3);
    for (const item of c1) expect(item.parentContributionId).toBe("C1");
    expect(c1[0]!.actionType).toBe("can_rewrite_from_existing_evidence");
    expect(c1[1]!.actionType).toBe("requires_real_experiment_or_author_input");
    expect(c1[1]!.status).toBe("author_decision");
    expect(c1[1]!.experimentPlan?.purpose).toBe("Quantify run-to-run variance");
  });

  it("稳定 id 确定性：同输入同 id；换字眼（大小写 / 空白）不产生新 id → 去重计数", () => {
    const again = buildAtomicGapPlan(RAW_SUB_GAPS, verifiers(document));
    expect(again.gapPlan.map((item) => item.subGapId)).toEqual(built.gapPlan.map((item) => item.subGapId));
    expect(built.guards.duplicatesDropped).toBe(1);
    expect(subGapStableId("C1", "INTERNAL_CLAIM_MISMATCH", "A  b", "x")).toBe(subGapStableId("C1", "INTERNAL_CLAIM_MISMATCH", "a b", "y"));
    expect(subGapStableId("C1", "INTERNAL_CLAIM_MISMATCH", "a b", "x")).not.toBe(subGapStableId("C1", "TEXT_OR_STRUCTURE_CORRECTION", "a b", "x"));
    expect(built.guards.unknownContribution).toBe(1);
  });

  it("目标锚 / 证据锚逐字回放；证据锚即声称本身 → distinctFromTarget=false", () => {
    const internal = built.gapPlan[0]!;
    expect(internal.targetVerified).toBe(true);
    expect(internal.evidenceAnchors).toEqual([{ sectionId: "SEC03", quote: EVIDENCE, verified: true, distinctFromTarget: true }]);
    const selfRef = built.gapPlan.find((item) => item.gapKind === "TEXT_OR_STRUCTURE_CORRECTION")!;
    expect(selfRef.evidenceAnchors?.[0]?.verified).toBe(true);
    expect(selfRef.evidenceAnchors?.[0]?.distinctFromTarget).toBe(false);
  });

  it("先前工作只解析到 pool：模型记忆 → resolvesToPool=false；pool 候选带 citedByManuscript / 内容等级 / quote 回放", () => {
    const c2 = built.gapPlan.filter((item) => item.contributionId === "C2");
    expect(c2[0]!.priorWorkRefs?.[0]).toMatchObject({ title: "A Survey Recalled From Memory", resolvesToPool: false });
    expect(c2[1]!.priorWorkRefs?.[0]).toMatchObject({ candidateId: "P01", resolvesToPool: true, priorQuoteVerified: true, citedByManuscript: true, contentLevel: "abstract" });
    expect(c2[2]!.priorWorkRefs?.[0]).toMatchObject({ candidateId: "P02", citedByManuscript: false, priorQuoteVerified: true });
    expect(built.guards.priorWorkUnresolved).toBe(1);
  });

  it("每贡献子项上限（防凑数）", () => {
    const many: RawSubGap[] = Array.from({ length: MAX_SUB_GAPS_PER_CONTRIBUTION + 2 }, (_, index) => ({
      contributionId: "C1",
      gapKind: "EXPERIMENT_OR_AUTHOR_INPUT" as const,
      gap: `distinct experiment need number ${index}`,
      evidence: [],
      priorWork: [],
    }));
    const result = buildAtomicGapPlan(many, verifiers(document));
    expect(result.gapPlan).toHaveLength(MAX_SUB_GAPS_PER_CONTRIBUTION);
    expect(result.guards.overLimitDropped).toBe(2);
  });

  it("parseSubGapsOutput：未知 gapKind → 证据不足型（不猜为可改写）；需实验才携带 experimentPlan", () => {
    const parsed = parseSubGapsOutput(JSON.stringify({
      gapPlan: [
        { contributionId: "C1", gapKind: "MAKE_IT_BETTER", gap: "vague", targetQuote: CLAIM },
        { contributionId: "C1", gapKind: "INTERNAL_CLAIM_MISMATCH", gap: "g", targetQuote: "t", experimentPlan: { purpose: "x" } },
      ],
    }));
    expect(parsed.subGaps[0]!.gapKind).toBe("UNCERTAIN_OR_MISSING_EVIDENCE");
    expect(parsed.subGaps[1]!.experimentPlan).toBeUndefined();
  });
});

// ---- 审计服务端到端（scripted runtime；只验证契约，不冒充真实模型） ----

class ScriptedRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: Array<{ contextScope: string; task: string }> = [];
  constructor(private readonly outputs: Record<string, string>) {}
  async healthCheck(): Promise<RuntimeHealth> {
    return { ok: true, provider: "pi", status: "healthy", detail: "scripted", latencyMs: 1, checkedAt: new Date().toISOString() };
  }
  async runAgent(input: { agentId: string; contextScope?: string; task: string }): Promise<AgentTask> {
    const scope = input.contextScope ?? "";
    this.calls.push({ contextScope: scope, task: input.task });
    const now = new Date().toISOString();
    return { taskId: `s-${this.calls.length}`, agentId: input.agentId, status: "completed", createdAt: now, updatedAt: now, output: this.outputs[scope] ?? "" };
  }
  async startAgent(input: Parameters<AgentRuntime["startAgent"]>[0]) {
    const task = await this.runAgent(input);
    return { taskId: task.taskId, sessionKey: "s", events: async function* () {}, cancel: async () => {}, result: async () => task };
  }
  async getTask(): Promise<AgentTask> {
    throw new Error("not implemented");
  }
  async close() {}
}

const SCRIPTED_OUTPUTS = {
  "review/contribution/extract": JSON.stringify({ contributions: [{ claimQuote: CLAIM, claimType: "performance_advantage", sectionId: "SEC01", supportLocations: [{ sectionId: "SEC03", kind: "experiment", quote: EVIDENCE }] }] }),
  "review/contribution/compare": JSON.stringify({ comparisons: [{ contributionId: "C1", nearestPriorWorks: [], commonMechanism: "", substantiveDifference: "", differenceBasis: "none", completedVerification: "", missingVerification: "x", status: "INSUFFICIENT_EVIDENCE" }] }),
  "review/contribution/synthesize": JSON.stringify({
    findings: [],
    gapPlan: [
      { contributionId: "C1", gapKind: "INTERNAL_CLAIM_MISMATCH", gap: "overclaim", targetQuote: CLAIM, targetSectionId: "SEC01", evidence: [{ sectionId: "SEC03", quote: EVIDENCE }] },
      { contributionId: "C1", gapKind: "EXPERIMENT_OR_AUTHOR_INPUT", gap: "variance", experimentPlan: { purpose: "variance" } },
    ],
  }),
};

describe("G1 ContributionAuditService：v2 契约（产品路径）与 v1 缺省（研究复现）", () => {
  let root: string;
  let projects: ProjectStore;
  let papers: PaperStore;
  let projectId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-m1519-audit-"));
    projects = new ProjectStore({ root });
    papers = new PaperStore(projects);
    projectId = (await projects.create("m1519 audit", { documentType: "research_article" })).id;
    await papers.saveIngest(projectId, { ...makeDocument(), projectId });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("v2：综合调用附带稿件正文；gapPlan 为原子子缺口；工件 / 指纹记录 v2 版本", async () => {
    const runtime = new ScriptedRuntime(SCRIPTED_OUTPUTS);
    const service = new ContributionAuditService({ store: papers, runtime, reviewerAgentId: "main", researchDir: (id) => projects.researchDir(id), promptVersion: CONTRIBUTION_AUDIT_PROMPT_VERSION_V2 });
    const outcome = await service.audit({ projectId, runId: "r1", pool: POOL, documentType: "research_article" });
    expect(outcome.telemetry.calls).toBe(3);
    const synth = runtime.calls.find((call) => call.contextScope === "review/contribution/synthesize")!;
    expect(synth.task).toContain("Manuscript sections");
    expect(synth.task).toContain(EVIDENCE);
    expect(synth.task).toContain("ATOMIC");
    expect(outcome.artifact.promptVersion).toBe(CONTRIBUTION_AUDIT_PROMPT_VERSION_V2);
    expect(outcome.artifact.inputFingerprint.promptVersion).toBe(CONTRIBUTION_AUDIT_PROMPT_VERSION_V2);
    expect(outcome.artifact.gapPlan.map((item) => item.gapKind)).toEqual(["INTERNAL_CLAIM_MISMATCH", "EXPERIMENT_OR_AUTHOR_INPUT"]);
    expect(outcome.artifact.gapPlan[0]!.evidenceAnchors?.[0]?.verified).toBe(true);
    expect(outcome.artifact.guards.subGaps).toBeDefined();
  });

  it("v1 缺省：综合调用不含稿件正文；gapPlan 无子缺口字段（M15.14/15 复现口径不变）", async () => {
    const runtime = new ScriptedRuntime({
      ...SCRIPTED_OUTPUTS,
      "review/contribution/synthesize": JSON.stringify({ findings: [], gapPlan: [{ contributionId: "C1", gap: "bundled", actionType: "requires_real_experiment_or_author_input" }] }),
    });
    const service = new ContributionAuditService({ store: papers, runtime, reviewerAgentId: "main", researchDir: (id) => projects.researchDir(id) });
    const outcome = await service.audit({ projectId, runId: "r2", pool: POOL, documentType: "research_article" });
    const synth = runtime.calls.find((call) => call.contextScope === "review/contribution/synthesize")!;
    expect(synth.task).not.toContain("Manuscript sections");
    expect(outcome.artifact.promptVersion).toBe(CONTRIBUTION_AUDIT_PROMPT_VERSION);
    expect(outcome.artifact.gapPlan[0]!.subGapId).toBeUndefined();
    expect(outcome.artifact.guards.subGaps).toBeUndefined();
  });
});

// ---- G2 分类门禁 ----

describe("G2 classifyAuditSubGap：内部证据弱化型 vs 先前工作比较型", () => {
  const document = makeDocument();
  const plan = buildAtomicGapPlan(RAW_SUB_GAPS, verifiers(document)).gapPlan;
  const resolved: AuditPlanAnchorProjection = { status: "resolved", file: "sections/sec01.tex", basis: "quote-replay", ambiguous: false };
  const classify = (gap: GapPlanItem, overrides: Partial<{ projection: AuditPlanAnchorProjection; targetReplayed: boolean; evidenceReplayed: boolean[] }> = {}) =>
    classifyAuditSubGap({
      gap,
      projection: overrides.projection ?? resolved,
      targetReplayed: overrides.targetReplayed ?? true,
      evidenceReplayed: overrides.evidenceReplayed ?? (gap.evidenceAnchors ?? []).map(() => true),
    });

  it("内部不一致 + 稿内证据锚回放 → REWRITE_ELIGIBLE(internal_evidence)，与先前工作四态无关", () => {
    const result = classify(plan[0]!);
    expect(result.classification).toBe("REWRITE_ELIGIBLE");
    expect(result.rewriteBasis).toBe("internal_evidence");
  });

  it("需实验永不改写；证据不足型 → 需补证据", () => {
    expect(classify(plan[1]!).classification).toBe("NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT");
    const uncertain: GapPlanItem = { ...plan[0]!, gapKind: "UNCERTAIN_OR_MISSING_EVIDENCE", missingEvidence: "full text of X" };
    expect(classify(uncertain).classification).toBe("NEEDS_TARGETED_EVIDENCE");
  });

  it("fail-closed：证据锚计划期不可回放 / 证据即声称 / 无证据锚 / 目标锚不可回放 / 不可投影", () => {
    expect(classify(plan[0]!, { evidenceReplayed: [false] }).classification).toBe("EVIDENCE_INSUFFICIENT");
    expect(classify(plan[2]!).classification).toBe("EVIDENCE_INSUFFICIENT"); // 自证
    expect(classify({ ...plan[0]!, evidenceAnchors: [] }).classification).toBe("EVIDENCE_INSUFFICIENT");
    expect(classify({ ...plan[0]!, evidenceAnchors: [{ ...plan[0]!.evidenceAnchors![0]!, verified: false }] }).classification).toBe("EVIDENCE_INSUFFICIENT");
    expect(classify(plan[0]!, { targetReplayed: false }).classification).toBe("EVIDENCE_INSUFFICIENT");
    expect(classify({ ...plan[0]!, targetVerified: false }).classification).toBe("EVIDENCE_INSUFFICIENT");
    expect(classify(plan[0]!, { projection: { status: "unresolved", reason: "no-editable-manuscript" } }).classification).toBe("UNMAPPABLE_TARGET");
    expect(classify(plan[0]!, { projection: { status: "unresolved", reason: "quote-ambiguous" } }).classification).toBe("UNMAPPABLE_TARGET");
  });

  it("比较型：仅模型记忆 / 未引用 / quote 未回放 / 时间因果违规 → 需补证据；全部满足 → REWRITE_ELIGIBLE(prior_work_verified)", () => {
    const c2 = plan.filter((item) => item.contributionId === "C2");
    expect(classify(c2[0]!).classification).toBe("NEEDS_TARGETED_EVIDENCE");
    const verified = classify(c2[1]!);
    expect(verified.classification).toBe("REWRITE_ELIGIBLE");
    expect(verified.rewriteBasis).toBe("prior_work_verified");
    expect(classify(c2[2]!).classification).toBe("NEEDS_TARGETED_EVIDENCE"); // 未被稿件引用
    const notReplayed = { ...c2[1]!, priorWorkRefs: [{ ...c2[1]!.priorWorkRefs![0]!, priorQuoteVerified: false }] };
    expect(classify(notReplayed).classification).toBe("NEEDS_TARGETED_EVIDENCE");
    const late = { ...c2[1]!, priorWorkRefs: [{ ...c2[1]!.priorWorkRefs![0]!, timeCausalityViolation: true }] };
    expect(classify(late).classification).toBe("NEEDS_TARGETED_EVIDENCE");
  });

  it("buildEvidenceRequest：逐来源标注缺失原因 + 覆盖诊断 + 导入指引（不检索、不升格）", () => {
    const c2 = plan.filter((item) => item.contributionId === "C2");
    const request = buildEvidenceRequest(c2[0]!, undefined, [
      { contributionId: "C2", title: "A Survey Recalled From Memory", resolvesToPool: false, inManuscriptReferences: false, referenceNotSelected: false, retrievedButCut: false, inLibrary: false, diagnosis: "model_memory_not_in_references" },
    ]);
    expect(request.missingSources).toEqual([{ title: "A Survey Recalled From Memory", year: 2019, status: "unresolved", coverage: "model_memory_not_in_references" }]);
    expect(request.guidance.length).toBeGreaterThanOrEqual(2);
    expect(buildEvidenceRequest(c2[2]!, undefined).missingSources[0]?.status).toBe("not_cited_by_manuscript");
    // 旧 v1 工件：来源取比较记录的最近先前工作（M15.18 S2 形态：模型记忆）
    const legacyComparison: ContributionComparison = {
      contributionId: "C2",
      nearestPriorWorks: [{ title: "Luo 2014 survey", year: 2014, sourceLevel: "model_memory", resolvesToPool: false }],
      commonMechanism: "", substantiveDifference: "", differenceBasis: "none", completedVerification: "", missingVerification: "", status: "INSUFFICIENT_EVIDENCE",
    };
    const legacy = buildEvidenceRequest({ contributionId: "C2", gap: "g", actionType: "can_rewrite_from_existing_evidence", status: "proposed" }, legacyComparison);
    expect(legacy.missingSources[0]).toMatchObject({ title: "Luo 2014 survey", status: "model_memory_only" });
  });
});

// ---- 计划 / 决策 / 复评（服务编排） ----

function makeArtifact(gapPlan: GapPlanItem[], document: PaperDocument, overrides: Partial<ContributionAuditArtifact> = {}): ContributionAuditArtifact {
  return {
    schemaVersion: 1,
    documentType: "research_article",
    promptVersion: CONTRIBUTION_AUDIT_PROMPT_VERSION_V2,
    evaluatedAt: "2026-11-01T01:00:00.000Z",
    manuscriptRevision: 0,
    priorWork: { cutoffDate: POOL.cutoffDate, poolFingerprint: "pfp", poolSize: POOL.candidates.length, queriesUsed: [], candidates: POOL.candidates },
    inventory: INVENTORY,
    comparisons: [],
    gapPlan,
    findings: [],
    coverage: { sectionsTotal: 4, sectionsIndexed: 4, sectionsIncludedFullText: 4, manuscriptCharsTotal: 1000, manuscriptCharsIncluded: 1000, truncations: [] },
    guards: { anchorFailures: 0, unresolvedPriorWorkRefs: 0, cutoffViolations: 0, statusRuleViolations: 0, droppedFindings: 0, priorQuoteReplayFailures: 0, fulltextBasisDowngrades: 0 },
    inputFingerprint: {
      manuscriptSha256: sha256Hex(document.chunks.map((chunk) => chunk.text).join("\n\n")).slice(0, 16),
      poolFingerprint: "pfp",
      promptVersion: CONTRIBUTION_AUDIT_PROMPT_VERSION_V2,
      documentType: "research_article",
    },
    provenance: { basis: "model_judgment_advisory", disclaimer: "advisory" },
    ...overrides,
  };
}

describe("计划 / 决策 / 复评：同一贡献可改写子项与需实验子项逐项结算", () => {
  let root: string;
  let projects: ProjectStore;
  let papers: PaperStore;
  let revisions: ManuscriptRevisionStore;
  let externalInstructions: ExternalInstructionStore;
  let reviewArtifacts: ReviewArtifactStore;
  let service: TargetAuditRevisionService;
  let projectId: string;
  const document = makeDocument();
  const gapPlan = buildAtomicGapPlan(RAW_SUB_GAPS, verifiers(document)).gapPlan;
  // 额外：只在 PDF 解析文本中、不在任何可编辑 TeX 中的目标锚 → UNMAPPABLE（零伪改动）
  const pdfOnly = buildAtomicGapPlan(
    [{ contributionId: "C1", gapKind: "INTERNAL_CLAIM_MISMATCH", gap: "pdf-only target", targetQuote: PDF_ONLY, targetSectionId: "SEC01", evidence: [{ sectionId: "SEC03", quote: EVIDENCE }], priorWork: [] }],
    verifiers(document),
  ).gapPlan;
  const allGaps = [...gapPlan, ...pdfOnly];
  const sec01 = () => join(projects.manuscriptDir(projectId), "sections", "sec01.tex");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-m1519-plan-"));
    projects = new ProjectStore({ root });
    papers = new PaperStore(projects);
    revisions = new ManuscriptRevisionStore({ projects });
    externalInstructions = new ExternalInstructionStore(projects);
    reviewArtifacts = new ReviewArtifactStore(projects);
    service = new TargetAuditRevisionService({ projects, papers, revisions, externalInstructions, reviewArtifacts });
    projectId = (await projects.create("m1519 plan", { documentType: "research_article" })).id;
    await papers.saveIngest(projectId, { ...document, projectId });
    const dir = join(projects.manuscriptDir(projectId), "sections");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "sec01.tex"), SEC01_TEX, "utf8");
    await writeFile(join(dir, "sec02.tex"), SEC02_TEX, "utf8");
    await writeFile(join(dir, "sec03.tex"), SEC03_TEX, "utf8");
    await writeFile(join(projects.manuscriptDir(projectId), "references.bib"), "@misc{ref1,\n  title={Memory Networks for Tracking}\n}\n", "utf8");
    await mkdir(projects.researchDir(projectId), { recursive: true });
    await writeFile(join(projects.researchDir(projectId), "target-contribution-audit.json"), JSON.stringify(makeArtifact(allGaps, document)), "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("generatePlan：子项逐条分类；稳定 itemId=ta-<subGapId>；混合需求统计；需补证据项附来源清单", async () => {
    const view = await service.generatePlan(projectId);
    const plan = view.plan;
    expect(plan.source.classifierVersion).toBe(TARGET_AUDIT_PLAN_CLASSIFIER_VERSION);
    const byId = new Map(plan.items.map((item) => [item.itemId, item]));
    const internal = byId.get(`ta-${gapPlan[0]!.subGapId}`)!;
    expect(internal.classification).toBe("REWRITE_ELIGIBLE");
    expect(internal.rewriteBasis).toBe("internal_evidence");
    expect(internal.anchor.projection).toMatchObject({ status: "resolved", file: "sections/sec01.tex" });
    expect(internal.anchor.texAnchor).toBe("achieves state-of-the-art accuracy on all three benchmarks, outperforming every prior method");
    expect(internal.priorWork).toEqual([]); // 内部证据型不携带先前工作
    expect(internal.subGap?.evidenceAnchors[0]).toMatchObject({ verified: true, replayed: true, distinctFromTarget: true });
    expect(internal.subGap?.contributionClaimQuote).toBe(CLAIM);
    expect(byId.get(`ta-${gapPlan[1]!.subGapId}`)!.classification).toBe("NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT");
    expect(byId.get(`ta-${gapPlan[2]!.subGapId}`)!.classification).toBe("EVIDENCE_INSUFFICIENT");
    const memoryOnly = byId.get(`ta-${gapPlan[3]!.subGapId}`)!;
    expect(memoryOnly.classification).toBe("NEEDS_TARGETED_EVIDENCE");
    expect(memoryOnly.evidenceRequest?.missingSources[0]?.title).toBe("A Survey Recalled From Memory");
    expect(byId.get(`ta-${gapPlan[4]!.subGapId}`)!.rewriteBasis).toBe("prior_work_verified");
    expect(byId.get(`ta-${pdfOnly[0]!.subGapId}`)!.classification).toBe("UNMAPPABLE_TARGET");
    expect(plan.summary.atomic).toMatchObject({ subGaps: allGaps.length, contributions: 2, contributionsWithMixedNeeds: 2 });
    expect(plan.summary.rewriteEligible).toBe(2);
    // 幂等：稳定 id
    const again = await service.generatePlan(projectId);
    expect(again.plan.items.map((item) => item.itemId)).toEqual(plan.items.map((item) => item.itemId));
  });

  it("指令文案：证据锚以〔〕只读呈现，不被派发端「」锚提取；内部证据型禁止新增比较结论", async () => {
    const plan = (await service.getPlan(projectId))!.plan;
    const internal = plan.items.find((item) => item.rewriteBasis === "internal_evidence")!;
    const text = rewriteInstructionText(internal, plan);
    expect(text).toContain(`〔${EVIDENCE}〕`);
    expect(text).toContain("本差距无已核验先前工作身份");
    const quoted = [...text.matchAll(/[「“"『]([^」”"』]{12,})[」”"』]/g)].map((match) => match[1]!);
    expect(quoted[0]).toBe(internal.anchor.texAnchor);
    expect(quoted.some((quote) => quote.includes("DanceTrack"))).toBe(false);
    const memoryOnly = plan.items.find((item) => item.classification === "NEEDS_TARGETED_EVIDENCE")!;
    const request = authorDecisionInstructionText(memoryOnly, plan);
    expect(request).toContain("A Survey Recalled From Memory");
    expect(request).not.toContain("【所需真实实验");
  });

  it("decide 部分决策：只批准可改写子项 → pending 改写指令；计划保持 generated；随后批准需实验子项 → 作者裁决、不派发", async () => {
    const plan = (await service.getPlan(projectId))!.plan;
    const internal = plan.items.find((item) => item.rewriteBasis === "internal_evidence")!;
    const experiment = plan.items.find((item) => item.classification === "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT")!;
    const first = await service.decide(projectId, { decisions: [{ itemId: internal.itemId, decision: "approve" }] });
    expect(first.plan.status).toBe("generated");
    const rewrite = first.instructions.find((entry) => entry.origin?.itemId === internal.itemId)!;
    expect(rewrite.status).toBe("pending");
    expect(rewrite.origin).toMatchObject({ kind: "target_audit_rewrite", targetFile: "sections/sec01.tex", texAnchor: internal.anchor.texAnchor });
    expect(rewrite.statusNote).toBeUndefined();
    const second = await service.decide(projectId, {
      decisions: [
        { itemId: experiment.itemId, decision: "approve" },
        ...plan.items.filter((item) => item.itemId !== internal.itemId && item.itemId !== experiment.itemId).map((item) => ({ itemId: item.itemId, decision: "reject" as const })),
      ],
    });
    expect(second.plan.status).toBe("decided");
    const authorItem = second.instructions.find((entry) => entry.origin?.itemId === experiment.itemId)!;
    expect(authorItem.statusNote).toMatch(/^AUTHOR_DECISION_REQUIRED: 需真实实验/);
    // 已批准的改写指令不被后续决策翻转
    expect(second.instructions.find((entry) => entry.instructionId === rewrite.instructionId)?.status).toBe("pending");
  });

  it("已决策计划不被新分类实现覆盖（作者决策优先于实现升级）", async () => {
    const planFile = join(projects.researchDir(projectId), "target-audit-revision-plan.json");
    const stored = JSON.parse(await readFile(planFile, "utf8")) as { source: Record<string, unknown> };
    stored.source["classifierVersion"] = "m1518-nfkc-mapped";
    await writeFile(planFile, JSON.stringify(stored), "utf8");
    const view = await service.generatePlan(projectId);
    expect(view.plan.source.classifierVersion).toBe("m1518-nfkc-mapped");
    expect(view.plan.status).toBe("decided");
  });

  it("reassess：可改写子项真实落盘 + gate 守卫 PASS → VALIDATED_FIXED；同贡献需实验子项仍 NEEDS_AUTHOR_DECISION；回退 / 跨文件 → 非 FIXED", async () => {
    const plan = (await service.getPlan(projectId))!.plan;
    const internal = plan.items.find((item) => item.rewriteBasis === "internal_evidence")!;
    const experiment = plan.items.find((item) => item.classification === "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT")!;
    // M15.20：真实修订链（基线修订 → 修订后修订），复评对快照做编辑契约确定性回放
    await revisions.commit(projectId, "baseline", "run-m1519");
    const revised = SEC01_TEX.replace("on all three benchmarks, outperforming every prior method", "on MOT17, while remaining below the strongest baseline on DanceTrack");
    await writeFile(sec01(), revised, "utf8");
    const applied = await revisions.commit(projectId, "revision.apply", "run-m1519");
    const setOutcome = async (file: string) =>
      externalInstructions.update(projectId, (current) =>
        current.map((entry) =>
          entry.origin?.itemId === internal.itemId
            ? {
                ...entry,
                status: "handled" as const,
                planItemOutcomes: [{ planItemId: "improvement:1", outcome: "applied" as const, summary: "applied", revision: applied.revision, file, beforeSha256: revisionSourceHash(SEC01_TEX), afterSha256: revisionSourceHash(revised), at: "2026-11-01T02:00:00.000Z" }],
                resolutionTrace: { commentId: entry.instructionId, planItemIds: ["improvement:1"], actionType: "modify" as const, evidenceIds: [], patchIds: [], verification: { fact: true, citation: true, scope: true }, status: "handled" as const, resolutionSummary: "weakened" },
              }
            : entry,
        ),
      );
    await setOutcome("sections/sec01.tex");
    const report = await service.reassess(projectId);
    const internalItem = report.items.find((item) => item.itemId === internal.itemId)!;
    expect(internalItem.closure).toBe("VALIDATED_FIXED");
    expect(internalItem.editContract).toMatchObject({ status: "SATISFIED", contractSource: "contract" });
    expect(internalItem).toMatchObject({ gapKind: "INTERNAL_CLAIM_MISMATCH", rewriteBasis: "internal_evidence", parentContributionId: "C1" });
    const experimentItem = report.items.find((item) => item.itemId === experiment.itemId)!;
    expect(experimentItem.closure).toBe("NEEDS_AUTHOR_DECISION");
    expect(experimentItem.parentContributionId).toBe("C1");
    expect(report.summary.VALIDATED_FIXED).toBe(1);

    // 跨文件误归因：lineage 落在 sec03 → 目标绑定不成立
    await setOutcome("sections/sec03.tex");
    expect((await service.reassess(projectId)).items.find((item) => item.itemId === internal.itemId)?.closure).toBe("STILL_OPEN");
    // 回退：目标文件回到修订前内容 → 非 FIXED
    await setOutcome("sections/sec01.tex");
    await writeFile(sec01(), SEC01_TEX, "utf8");
    expect((await service.reassess(projectId)).items.find((item) => item.itemId === internal.itemId)?.closure).toBe("STILL_OPEN");
  });
});

describe("旧 v1 审计工件兼容（无子缺口字段 → 旧口径分类，itemId=ta-gap-N）", () => {
  it("v1 gapPlan 生成计划：无 subGap / rewriteBasis 旧口径 / 需补证据附来源清单", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-m1519-v1-"));
    try {
      const projects = new ProjectStore({ root });
      const papers = new PaperStore(projects);
      const service = new TargetAuditRevisionService({
        projects,
        papers,
        revisions: new ManuscriptRevisionStore({ projects }),
        externalInstructions: new ExternalInstructionStore(projects),
        reviewArtifacts: new ReviewArtifactStore(projects),
      });
      const projectId = (await projects.create("v1", { documentType: "research_article" })).id;
      const document = makeDocument();
      await papers.saveIngest(projectId, { ...document, projectId });
      const dir = join(projects.manuscriptDir(projectId), "sections");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sec01.tex"), SEC01_TEX, "utf8");
      await writeFile(join(dir, "sec02.tex"), SEC02_TEX, "utf8");
      await mkdir(projects.researchDir(projectId), { recursive: true });
      const legacyComparisons: ContributionComparison[] = [
        { contributionId: "C1", nearestPriorWorks: [{ title: "Luo 2014 survey", year: 2014, sourceLevel: "model_memory", resolvesToPool: false }], commonMechanism: "", substantiveDifference: "", differenceBasis: "none", completedVerification: "", missingVerification: "", status: "INSUFFICIENT_EVIDENCE" },
      ];
      const artifact = makeArtifact(
        [{ contributionId: "C1", gap: "bundled rewrite", actionType: "can_rewrite_from_existing_evidence", status: "proposed" }],
        document,
        { promptVersion: CONTRIBUTION_AUDIT_PROMPT_VERSION, comparisons: legacyComparisons },
      );
      await writeFile(join(projects.researchDir(projectId), "target-contribution-audit.json"), JSON.stringify(artifact), "utf8");
      const plan = (await service.generatePlan(projectId)).plan;
      expect(plan.items[0]!.itemId).toBe("ta-gap-1");
      expect(plan.items[0]!.subGap).toBeUndefined();
      // M15.18 S2 形态：旧口径 B2 仍判 NEEDS_TARGETED_EVIDENCE（语义未被静默改变），且现在附缺失来源清单
      expect(plan.items[0]!.classification).toBe("NEEDS_TARGETED_EVIDENCE");
      expect(plan.items[0]!.evidenceRequest?.missingSources[0]).toMatchObject({ title: "Luo 2014 survey", status: "model_memory_only" });
      expect(plan.summary.atomic).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M15.19 Deviation D1（真实 E1 暴露）：摘要载体投影 + 摘要目标复评", () => {
  const ABSTRACT = `${CLAIM} The individual components are intentionally simple.`;
  const SEC01_WITH_FRONT_MATTER = `\\section{I Introduction}\n\nTitle Line\n\nAbstract—${CLAIM}\n\nIntroduction body text follows here.\n`;

  it("D1a：同一引文同时在摘要载体与正文重复副本中 → 投影到摘要载体（main.tex 渲染的摘要），重复位置如实列出", async () => {
    const { projectQuoteToManuscript } = await import("../../src/target/TargetAuditRevisionService.js");
    const projection = projectQuoteToManuscript(CLAIM, [
      { relativePath: "sections/sec01.tex", content: SEC01_WITH_FRONT_MATTER },
      { relativePath: "abstract", content: ABSTRACT },
    ], "sections/sec01.tex");
    expect(projection).toEqual({ status: "resolved", file: "abstract", basis: "abstract-carrier+quote-replay", ambiguous: true, alsoFoundIn: ["sections/sec01.tex"] });
    // 只在正文 → 仍按正文投影（不误用摘要）
    expect(projectQuoteToManuscript("Introduction body text follows here.", [
      { relativePath: "sections/sec01.tex", content: SEC01_WITH_FRONT_MATTER },
      { relativePath: "abstract", content: ABSTRACT },
    ])).toMatchObject({ status: "resolved", file: "sections/sec01.tex", basis: "quote-replay" });
  });

  it("D1b：摘要目标的复评按 outline.abstract 同口径取哈希——真实落盘 + 守卫 → VALIDATED_FIXED；回退 → STILL_OPEN", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-m1519-abs-"));
    try {
      const projects = new ProjectStore({ root });
      const papers = new PaperStore(projects);
      const revisions = new ManuscriptRevisionStore({ projects });
      const externalInstructions = new ExternalInstructionStore(projects);
      const service = new TargetAuditRevisionService({ projects, papers, revisions, externalInstructions, reviewArtifacts: new ReviewArtifactStore(projects) });
      const projectId = (await projects.create("m1519 abstract", { documentType: "research_article" })).id;
      const document = makeDocument();
      await papers.saveIngest(projectId, { ...document, projectId });
      const manuscriptDir = projects.manuscriptDir(projectId);
      await mkdir(join(manuscriptDir, "sections"), { recursive: true });
      await writeFile(join(manuscriptDir, "sections", "sec01.tex"), SEC01_WITH_FRONT_MATTER, "utf8");
      await writeFile(join(manuscriptDir, "sections", "sec03.tex"), SEC03_TEX, "utf8");
      const outlinePath = join(manuscriptDir, "outline.json");
      await writeFile(outlinePath, JSON.stringify({ title: "Memory Tracking", abstract: ABSTRACT, sections: [] }), "utf8");
      const gaps = buildAtomicGapPlan(
        [{ contributionId: "C1", gapKind: "INTERNAL_CLAIM_MISMATCH", gap: "abstract overclaim", targetQuote: "achieves state-of-the-art accuracy on all three benchmarks, outperforming every prior method", targetSectionId: "SEC01", evidence: [{ sectionId: "SEC03", quote: EVIDENCE }], priorWork: [] }],
        verifiers(document),
      ).gapPlan;
      await mkdir(projects.researchDir(projectId), { recursive: true });
      await writeFile(join(projects.researchDir(projectId), "target-contribution-audit.json"), JSON.stringify(makeArtifact(gaps, document)), "utf8");
      const plan = (await service.generatePlan(projectId)).plan;
      const item = plan.items[0]!;
      expect(item.classification).toBe("REWRITE_ELIGIBLE");
      expect(item.anchor.projection).toMatchObject({ file: "abstract", alsoFoundIn: ["sections/sec01.tex"] });
      expect(item.anchor.dispatchSection).toBe("abstract");
      await service.decide(projectId, { decisions: [{ itemId: item.itemId, decision: "approve" }] });
      await revisions.commit(projectId, "baseline", "run-abs");
      // revision 端摘要 lineage 口径：revisionSourceHash(abstract.trim())
      const revisedAbstract = ABSTRACT.replace("on all three benchmarks, outperforming every prior method", "on MOT17, while remaining below the strongest baseline on DanceTrack");
      await writeFile(outlinePath, JSON.stringify({ title: "Memory Tracking", abstract: revisedAbstract, sections: [] }), "utf8");
      const applied = await revisions.commit(projectId, "revision.apply", "run-abs");
      await externalInstructions.update(projectId, (current) =>
        current.map((entry) =>
          entry.origin?.itemId === item.itemId
            ? {
                ...entry,
                status: "handled" as const,
                planItemOutcomes: [{ planItemId: "improvement:1", outcome: "applied" as const, summary: "applied", revision: applied.revision, file: "abstract", beforeSha256: revisionSourceHash(ABSTRACT.trim()), afterSha256: revisionSourceHash(revisedAbstract.trim()), at: "2026-11-01T02:00:00.000Z" }],
                resolutionTrace: { commentId: entry.instructionId, planItemIds: ["improvement:1"], actionType: "modify" as const, evidenceIds: [], patchIds: [], verification: { fact: true, citation: true }, status: "handled" as const, resolutionSummary: "weakened" },
              }
            : entry,
        ),
      );
      const report = await service.reassess(projectId);
      expect(report.items[0]?.closure).toBe("VALIDATED_FIXED");
      expect(report.items[0]?.checks).toMatchObject({ lineage: true, targetBinding: true, contentChanged: true, notReverted: true, guards: true, editContract: true });
      // 摘要被恢复为修订前内容 → 非 FIXED
      await writeFile(outlinePath, JSON.stringify({ title: "Memory Tracking", abstract: ABSTRACT, sections: [] }), "utf8");
      expect((await service.reassess(projectId)).items[0]?.closure).toBe("STILL_OPEN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
