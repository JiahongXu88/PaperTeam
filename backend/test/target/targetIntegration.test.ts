/**
 * M12 Batch 2 · A9 集成测试。
 *
 * 覆盖：workflow target 三 stage（未接线 / 未配置 → 显式 no-op；配置 →
 * discover→profile→readiness 全链且 benchmark 幂等不重发现）/ 定义 plan 顺序
 * （target.* 在 feasibility 之前；legacy 状态推进不变）/ Feasibility·Reviewer·
 * Planner prompt 参照块（存在 / 缺席 → 与旧版逐字节一致）/ gates advisory
 * 附加字段（零阻断零规则变化）。
 */

import { afterAll, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../../src/errors.js";

import type { EvidenceStats } from "../../src/evidence/EvidenceStore.js";
import type { ProjectMetadata } from "../../src/project/ProjectStore.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import type { ResearchReport } from "../../src/agents/ResearcherService.js";
import { buildFeasibilityPrompt } from "../../src/agents/FeasibilityService.js";
import { buildReviewPrompt } from "../../src/agents/ReviewerService.js";
import { WriterService } from "../../src/writer/WriterService.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";
import { renderTargetReferenceBlock, renderTargetExpectationsBlock, renderPlannerTargetDigest } from "../../src/target/promptBlocks.js";
import type { TargetServices } from "../../src/target/services.js";
import type { BenchmarkDiscoveryService } from "../../src/search/benchmarkDiscoveryService.js";
import {
  createExistingPaperDefinition,
  createIdeaToPaperDefinition,
  targetStages,
  type WorkflowServices,
} from "../../src/workflow/definitions.js";
import type { StageSpec, WorkflowState } from "../../src/workflow/types.js";
import { EIGHT_PAPERS, papersOf, setupTargetHarness } from "./profileFixtures.js";
import type { CitationReport } from "../../src/citation/CitationService.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { FeasibilityReport } from "../../src/agents/FeasibilityService.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

// ---- 工件 ----

function emptyState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: 1,
    runId: "run-test",
    projectId: "p-test",
    workflowKind: "idea_to_paper",
    status: "running",
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: "2026-10-07T00:00:00Z",
    completedStages: [],
    stageResults: {},
    stageHistory: [],
    inputs: {},
    eventsSeq: 0,
    ...overrides,
  };
}

function stageContext(projectId: string) {
  return {
    runId: "run-test",
    projectId,
    attempt: 1,
    state: emptyState({ projectId }),
    signal: new AbortController().signal,
    emitProgress: async () => {},
    emitDomain: async () => {},
    log: () => {},
  };
}

function minimalServices(
  overrides: { targets?: TargetServices; projects?: unknown } = {},
): WorkflowServices {
  return {
    stageTimeoutMs: 5_000,
    stageMaxAttempts: 2,
    ...overrides,
  } as unknown as WorkflowServices;
}

async function executeStage(stage: StageSpec | undefined, projectId: string): Promise<Record<string, unknown>> {
  if (stage === undefined || !("execute" in stage)) {
    throw new Error("不是可执行的 stage");
  }
  return stage.execute(stageContext(projectId));
}

// ---- workflow stage 集成 ----

describe("A9 workflow：target 三 stage", () => {
  it("stage id 与顺序（target.benchmark → target.profile → target.readiness）", () => {
    expect(targetStages(minimalServices()).map((stage) => stage.id)).toEqual([
      "target.benchmark",
      "target.profile",
      "target.readiness",
    ]);
  });

  it("未接线（services.targets 缺省）→ 三 stage 全部显式 no-op（零模型调用）", async () => {
    const services = minimalServices();
    const [benchmark, profile, readiness] = targetStages(services);
    expect(await executeStage(benchmark, "p")).toMatchObject({ skipped: true });
    expect(await executeStage(profile, "p")).toMatchObject({ skipped: true });
    expect(await executeStage(readiness, "p")).toMatchObject({ skipped: true });
  });

  it("已接线但项目未配置 researchField → no-op（诚实 reason）", async () => {
    const harness = await setupTargetHarness(EIGHT_PAPERS, { roots });
    // 删除已冻结 artifact（setupTargetHarness 会冻结）——模拟「未发现」项目
    await rm(join(harness.projects.researchDir(harness.projectId), "target-benchmark.json"), { force: true });
    let discoveryCalls = 0;
    const targets: TargetServices = {
      benchmark: harness.benchmark,
      discovery: {
        discoverAndFreeze: async () => {
          discoveryCalls += 1;
          throw new Error("不应被调用");
        },
      } as unknown as BenchmarkDiscoveryService,
      profile: harness.profile,
      gap: harness.gap,
    };
    const services = minimalServices({ targets, projects: harness.projects });
    const result = await executeStage(targetStages(services)[0]!, harness.projectId);
    expect(result).toMatchObject({ skipped: true });
    expect(String(result["reason"])).toContain("researchField");
    expect(discoveryCalls).toBe(0);
  });

  it("配置齐全 → discover→freeze→profile→readiness 全链；benchmark 幂等不重发现", async () => {
    const harness = await setupTargetHarness(EIGHT_PAPERS, { roots });
    await rm(join(harness.projects.researchDir(harness.projectId), "target-benchmark.json"), { force: true });
    await harness.projects.updateMeta(harness.projectId, { researchField: "multi-object tracking" });
    let discoveryCalls = 0;
    const targets: TargetServices = {
      benchmark: harness.benchmark,
      discovery: {
        discoverAndFreeze: async (projectId: string) => {
          discoveryCalls += 1;
          const artifact = await harness.benchmark.freeze(projectId, {
            target: {
              documentType: "conference_paper",
              targetProfile: "top_conference",
              researchField: "multi-object tracking",
            },
            papers: papersOf(EIGHT_PAPERS),
          });
          return {
            discovery: { projectId, query: "mot", venueResolution: { status: "skipped_no_target_venue", note: "" }, venueDegraded: false, candidates: [], diagnostics: {} },
            selection: { selected: [], selection: { selectedAt: "", targetCount: 12, sufficiency: "sufficient", requiresAttention: [] } },
            savedSourceIds: [],
            upgradedToBoth: [],
            artifact,
            alreadyFrozen: false,
          };
        },
      } as unknown as BenchmarkDiscoveryService,
      profile: harness.profile,
      gap: harness.gap,
    };
    const services = minimalServices({ targets, projects: harness.projects });
    const [benchmarkStage, profileStage, readinessStage] = targetStages(services);

    const first = await executeStage(benchmarkStage, harness.projectId);
    expect(first).toMatchObject({ skipped: false, revision: 0, papers: 8 });
    expect(discoveryCalls).toBe(1);

    // 幂等：已冻结 → 不再发现（alreadyFrozen 路径）
    const second = await executeStage(benchmarkStage, harness.projectId);
    expect(second).toMatchObject({ skipped: false, alreadyFrozen: true, papers: 8 });
    expect(discoveryCalls).toBe(1);

    const profileResult = await executeStage(profileStage, harness.projectId);
    expect(profileResult).toMatchObject({ skipped: false, n: 8 });
    const profileArtifact = JSON.parse(
      await readFile(join(harness.projects.researchDir(harness.projectId), "target-profile.json"), "utf8"),
    ) as { dimensions: Record<string, { availability: string }> };
    expect(profileArtifact.dimensions["structure"]?.availability).toBe("available");

    const readinessResult = await executeStage(readinessStage, harness.projectId);
    expect(readinessResult).toMatchObject({ skipped: false });
    // 无手稿项目：整体 INSUFFICIENT_EVIDENCE（诚实，不 crash 不阻断）
    expect(readinessResult["overall"]).toBe("INSUFFICIENT_EVIDENCE");
    const readinessArtifact = JSON.parse(
      await readFile(join(harness.projects.researchDir(harness.projectId), "target-readiness.json"), "utf8"),
    ) as { dimensions: Array<{ observed: string }> };
    expect(readinessArtifact.dimensions.every((entry) => entry.observed.includes("尚无手稿"))).toBe(true);
  });

  it("discovery 失败（如未配置学术检索 provider）→ benchmark stage 显式 skip 不抛错（advisory 兜底，不阻断主 workflow）", async () => {
    const harness = await setupTargetHarness(EIGHT_PAPERS, { roots });
    await rm(join(harness.projects.researchDir(harness.projectId), "target-benchmark.json"), { force: true });
    await harness.projects.updateMeta(harness.projectId, { researchField: "multi-object tracking" });
    const targets: TargetServices = {
      benchmark: harness.benchmark,
      discovery: {
        discoverAndFreeze: async () => {
          throw new BusinessError("SEARCH_PROVIDER_NOT_CONFIGURED", "未配置任何学术检索 provider（Academic Search 不可用）");
        },
      } as unknown as BenchmarkDiscoveryService,
      profile: harness.profile,
      gap: harness.gap,
    };
    const services = minimalServices({ targets, projects: harness.projects });
    const [benchmarkStage, profileStage, readinessStage] = targetStages(services);
    const result = await executeStage(benchmarkStage, harness.projectId);
    expect(result).toMatchObject({ skipped: true });
    expect(String(result["reason"])).toContain("SEARCH_PROVIDER_NOT_CONFIGURED");
    // 下游以「benchmark 未冻结」显式 no-op（不 crash、不阻断）
    expect(await executeStage(profileStage, harness.projectId)).toMatchObject({ skipped: true });
    expect(await executeStage(readinessStage, harness.projectId)).toMatchObject({ skipped: true });
  });

  it("requiresAttention 四触发只是透传（advisory；不抛错不暂停）", async () => {
    const harness = await setupTargetHarness(EIGHT_PAPERS, { roots });
    await rm(join(harness.projects.researchDir(harness.projectId), "target-benchmark.json"), { force: true });
    await harness.projects.updateMeta(harness.projectId, { researchField: "multi-object tracking" });
    const targets: TargetServices = {
      benchmark: harness.benchmark,
      discovery: {
        discoverAndFreeze: async (projectId: string) => {
          const artifact = await harness.benchmark.freeze(projectId, {
            target: { documentType: "conference_paper", targetProfile: "top_conference", researchField: "mot" },
            papers: papersOf(EIGHT_PAPERS.slice(0, 3)),
            selection: {
              selectedAt: "",
              targetCount: 12,
              sufficiency: "insufficient",
              reason: "候选不足",
              requiresAttention: ["severely_insufficient_corpus: 仅 3 篇（< 5）"],
            },
          });
          return {
            discovery: { projectId, query: "mot", venueResolution: { status: "not_found", note: "" }, venueDegraded: true, candidates: [], diagnostics: {} },
            selection: { selected: [], selection: artifact.selection! },
            savedSourceIds: [],
            upgradedToBoth: [],
            artifact,
            alreadyFrozen: false,
          };
        },
      } as unknown as BenchmarkDiscoveryService,
      profile: harness.profile,
      gap: harness.gap,
    };
    const result = await executeStage(targetStages(minimalServices({ targets, projects: harness.projects }))[0]!, harness.projectId);
    expect(result).toMatchObject({
      skipped: false,
      papers: 3,
      sufficiency: "insufficient",
      venueDegraded: true,
    });
    expect(result["requiresAttention"]).toEqual(["severely_insufficient_corpus: 仅 3 篇（< 5）"]);
    // 照常继续：profile/readiness 仍可执行（INSUFFICIENT 判决在产物里，不在流程上）
    const readiness = await executeStage(targetStages(minimalServices({ targets, projects: harness.projects }))[2]!, harness.projectId);
    expect(readiness).toMatchObject({ skipped: false, overall: "INSUFFICIENT_EVIDENCE" });
  });
});

describe("A9 workflow：定义 plan 顺序与 legacy 兼容", () => {
  it("idea_to_paper：target.* 排在 research.idea / research.feasibility 之前", () => {
    const definition = createIdeaToPaperDefinition(minimalServices());
    let state = emptyState();
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "target.benchmark" });
    state = emptyState({ stageResults: { "target.benchmark": { skipped: true } } });
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "target.profile" });
    state = emptyState({ stageResults: { "target.benchmark": {}, "target.profile": {} } });
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "target.readiness" });
    state = emptyState({
      stageResults: { "target.benchmark": {}, "target.profile": {}, "target.readiness": {} },
    });
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "research.idea" });
  });

  it("legacy 恢复（M12 前的 checkpoint：无 target 结果但有前段结果）→ 先补 no-op target stage，之后回到既有顺序", () => {
    const definition = createIdeaToPaperDefinition(minimalServices());
    const legacyResults: Record<string, Record<string, unknown>> = {
      "research.idea": {},
      "evidence.ground": {},
      "research.feasibility": { level: "HIGH" },
      "hitl.feasibility_confirm": { decision: "approve" },
      "outline.plan": {},
      "hitl.outline_confirm": { decision: "approve" },
      "writing.sections": {},
    };
    // 未配置 target 的项目上 target.benchmark 是显式 no-op；plan 先补齐 target.*：
    const next = definition.plan(emptyState({ stageResults: { ...legacyResults } }));
    expect(next).toEqual({ kind: "stage", stageId: "target.benchmark" });
    // no-op 完成后：前段全部就绪 → 进入 shared tail（citation.verify / review.run /
    // quality.gate 族——与 M12 前的推进语义一致，不因 target 引入新的终态分支）
    const resumed = definition.plan(
      emptyState({
        stageResults: {
          ...legacyResults,
          "target.benchmark": { skipped: true },
          "target.profile": { skipped: true },
          "target.readiness": { skipped: true },
        },
      }),
    );
    expect(resumed.kind).toBe("stage");
    if (resumed.kind === "stage") {
      expect(["citation.verify", "review.run", "quality.gate", "revision.validate"]).toContain(resumed.stageId);
    }
  });

  it("existing_paper_improvement：target.* 排在 citation.verify / assessment.target 之前", () => {
    const definition = createExistingPaperDefinition(minimalServices());
    const importDone = {
      "import.parse": {},
      "import.baseline_build": {},
      "import.inventory": {},
      "import.baseline": {},
      "import.understand": {},
    };
    let state = emptyState({ workflowKind: "existing_paper_improvement", stageResults: { ...importDone } });
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "target.benchmark" });
    state = emptyState({
      workflowKind: "existing_paper_improvement",
      stageResults: { ...importDone, "target.benchmark": {}, "target.profile": {}, "target.readiness": {} },
    });
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "citation.verify" });
    // legacy checkpoint（无 target 结果）→ 先补 no-op stage，不改变后续顺序
    const legacy = definition.plan(emptyState({ workflowKind: "existing_paper_improvement", stageResults: { ...importDone } }));
    expect(legacy).toEqual({ kind: "stage", stageId: "target.benchmark" });
  });
});

// ---- prompt 参照块（存在 / 缺席 byte-identical）----

const projectMeta: ProjectMetadata = {
  schemaVersion: 1,
  id: "p1",
  title: "测试项目",
  createdAt: "2026-10-07T00:00:00Z",
  updatedAt: "2026-10-07T00:00:00Z",
  status: "created",
  documentType: "conference_paper",
  targetProfile: "top_conference",
  researchField: "multi-object tracking",
};

const research: ResearchReport = {
  domainOverview: "领域概述。",
  relatedWorkDirections: ["A"],
  researchGaps: ["G1"],
  potentialContributions: ["C1"],
  researchQuestions: ["Q1"],
  literaturePlan: ["L1"],
};

const evidenceStats: EvidenceStats = {
  total: 2,
  byStatus: { unverified: 0, verified: 2, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 },
  contradictory: 0,
  skippedLines: 0,
};

const PROFILE = {
  schemaVersion: 1 as const,
  benchmarkRevision: 0,
  corpusFingerprint: "abc",
  extractorSchemaVersion: 1,
  n: 10,
  dimensions: {
    structure: {
      availability: "available" as const,
      coverage: 10,
      sectionPattern: { method: { present: 10, medianLengthWords: 1500 } },
      totalLengthWords: { n: 10, min: 4000, p25: 4875, median: 5750, p75: 6625, max: 7500 },
      abstractLengthWords: { n: 10, min: 150, p25: 167.5, median: 185, p75: 202.5, max: 220 },
    },
    literature: {
      availability: "available" as const,
      coverage: 10,
      citationCount: { n: 10, min: 20, p25: 23.5, median: 27, p75: 30.5, max: 34 },
      coverageNote: "口径",
    },
    experiments: {
      availability: "available" as const,
      coverage: 10,
      tableCount: { n: 10, min: 4, p25: 4.75, median: 5.5, p75: 6.25, max: 7 },
      ablationPresent: 0.9,
      robustnessPresent: 0.4,
    },
    visuals: {
      availability: "available" as const,
      coverage: 10,
      figureCount: { n: 10, min: 6, p25: 6.75, median: 7.5, p75: 8.25, max: 9 },
      methodDiagramPresent: 0.8,
      note: "v1 未启用",
    },
    method: {
      availability: "available" as const,
      coverage: 10,
      depthNote: "方法深度模式摘要。",
      noveltyFramingNote: "新颖性框定摘要。",
    },
    writing: {
      availability: "available" as const,
      coverage: 10,
      claimStrengthNote: "论断强度摘要。",
      limitationsPresent: 0.7,
      discussionDepthNote: "讨论深度摘要。",
    },
  },
  provenance: { deterministicFields: [], modelSummarizedFields: [] },
  generatedAt: "2026-10-07T00:00:00Z",
  notes: [],
};

const READINESS = {
  schemaVersion: 1 as const,
  evaluatedAt: "2026-10-07T00:00:00Z",
  benchmarkRevision: 0,
  manuscriptRevision: 2,
  dimensions: [
    {
      dimension: "structure" as const,
      verdict: "PARTIALLY_MEETS_TARGET" as const,
      observed: "正文 3200 词",
      targetRange: "正文词数 p25–p75 = 4875–6625（min–max 4000–7500，n=10）",
      gaps: ["[structure/totalLengthWords] 当前稿 3200 词；低于目标带下限——目标带 p25–p75 = 4875–6625（min–max 4000–7500，n=10）（与 benchmark 观测带的距离陈述，不构成稿件事实错误；目标带非官方投稿要求）"],
      confidence: "high" as const,
      evidenceBasis: "manuscript .tex 确定性提取",
    },
  ],
  overall: { verdict: "PARTIALLY_MEETS_TARGET" as const, summary: "总判决摘要" },
  provenance: { basis: "benchmark_observation" as const, disclaimer: "目标带来自 benchmark 观测", profileGeneratedAt: "" },
};

describe("A9 prompt 参照块", () => {
  it("Feasibility：无 targetReference → prompt 与旧版逐字节一致；有 → 追加参照块", () => {
    const baseline = buildFeasibilityPrompt(projectMeta, research, evidenceStats, "idea");
    const omitted = buildFeasibilityPrompt(projectMeta, research, evidenceStats, "idea", undefined);
    expect(omitted).toBe(baseline); // 显式 undefined = 缺席
    const block = renderTargetReferenceBlock(PROFILE, READINESS)!;
    expect(block).toContain("benchmark 语料 10 篇");
    expect(block).toContain("非官方投稿要求");
    const withBlock = buildFeasibilityPrompt(projectMeta, research, evidenceStats, "existing_paper", block);
    expect(withBlock).toContain("===== 目标实证参照系");
    expect(withBlock.endsWith(block)).toBe(true);
    expect(withBlock.length).toBe(
      buildFeasibilityPrompt(projectMeta, research, evidenceStats, "existing_paper").length + block.length + 2,
    );
    // profile 缺席 → renderTargetReferenceBlock null（不注入）
    expect(renderTargetReferenceBlock(null, READINESS)).toBeNull();
  });

  it("Reviewer：academic 模式注入目标带期望；fact/style 模式 prompt 不变（byte-identical）", () => {
    const base = {
      projectId: "p1",
      manuscriptDigest: "digest",
      evidence: [],
      targetProfile: "top_conference",
    };
    const block = renderTargetExpectationsBlock(PROFILE)!;
    expect(block).toContain("正文 4875–6625 词");
    expect(block).toContain("6.75–8.25 图");
    expect(renderTargetExpectationsBlock(null)).toBeNull();

    const academicWith = buildReviewPrompt({ ...base, mode: "academic", targetExpectations: block });
    expect(academicWith).toContain("===== 目标带数值期望");
    const academicWithout = buildReviewPrompt({ ...base, mode: "academic" });
    expect(academicWithout).not.toContain("目标带数值期望");
    // fact / style 模式：注入参数也不影响（targetExpectations 仅 academic 消费）
    const factBase = buildReviewPrompt({ ...base, mode: "fact" });
    expect(buildReviewPrompt({ ...base, mode: "fact", targetExpectations: block })).toBe(factBase);
    const styleBase = buildReviewPrompt({ ...base, mode: "style" });
    expect(buildReviewPrompt({ ...base, mode: "style", targetExpectations: block })).toBe(styleBase);
  });

  it("Planner（planImprovement）：readiness digest 注入 advisory 块；缺席 → prompt 不变", async () => {
    const prompts: string[] = [];
    const runtime: AgentRuntime = {
      runAgent: async (input: { task: string }) => {
        prompts.push(input.task);
        return {
          taskId: `t${prompts.length}`,
          status: "completed",
          output: JSON.stringify({
            plan: [
              {
                section: "main.tex",
                actionType: "modify",
                action: "弱化无证据结论",
                rationale: "审稿指出",
                priority: "high",
              },
            ],
          }),
        };
      },
    } as unknown as AgentRuntime;
    const writer = new WriterService({ runtime, agentId: "writer", log: () => {} });
    const base = {
      projectId: "p1",
      issues: [],
      analysisDigest: "分析摘要",
      feasibilityLevel: "MEDIUM",
      sectionFiles: ["main.tex"],
    };
    const digest = renderPlannerTargetDigest(READINESS)!;
    expect(digest).toContain("不自动立项");
    expect(digest).toContain("[structure/totalLengthWords]");
    expect(renderPlannerTargetDigest(null)).toBeUndefined();

    await writer.planImprovement(base);
    const withoutPrompt = prompts[0]!;
    await writer.planImprovement({ ...base, targetReadinessDigest: digest });
    const withPrompt = prompts[1]!;
    expect(withPrompt).toContain("===== 目标带差距（advisory——作者可选上下文，不自动立项）=====");
    expect(withPrompt).toContain(digest);
    // 缺席 prompt 不含块；「审稿问题」之后的尾段两版完全一致
    expect(withoutPrompt).not.toContain("目标带差距");
    const marker = "===== 审稿问题 =====";
    expect(withPrompt.split(marker)[1]).toBe(withoutPrompt.split(marker)[1]);
    // 逐行移除注入的三行（标题 + digest + 纪律说明）后，内容行与缺席版完全一致
    const blockLines = [
      "===== 目标带差距（advisory——作者可选上下文，不自动立项）=====",
      ...digest.split("\n"),
      "以上差距是当前稿与 benchmark 观测带的距离陈述（非官方投稿要求，也不是稿件事实错误）。只有当作者明确要求追赶目标带时才据此规划；否则修订范围仍以审稿问题与作者目标为准。",
    ];
    const remaining: string[] = [];
    let cursor = 0;
    for (const line of withPrompt.split("\n")) {
      if (cursor < blockLines.length && line === blockLines[cursor]) {
        cursor += 1;
        continue;
      }
      remaining.push(line);
    }
    expect(cursor).toBe(blockLines.length); // 三行注入全部命中
    expect(remaining.filter((line) => line !== "")).toEqual(
      withoutPrompt.split("\n").filter((line) => line !== ""),
    );
  });
});

// ---- gates advisory ----

const passingReview: ReviewSummary = {
  generatedAt: "2026-10-07T00:00:00Z",
  round: 1,
  issues: [],
  counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
  scores: { academicScore: 88, styleRisk: 20, factVerdicts: { SUPPORTED: 3, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 } },
  openCritical: 0,
  openMajor: 0,
  unsupportedCriticalClaims: 0,
  reportPaths: [],
};

const cleanEvidence: EvidenceStats = {
  total: 3,
  byStatus: { unverified: 0, verified: 3, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 },
  contradictory: 0,
  skippedLines: 0,
};

const cleanCitation: CitationReport = {
  generatedAt: "2026-10-07T00:00:00Z",
  static: { citedKeys: ["a"], missingKeys: [], unusedKeys: [], duplicateKeys: [], badCitations: [], bibEntries: [] },
  metadata: {
    enabled: true, providers: [], checked: 1, skipped: 0, results: [],
    byStatus: { verified: 1, mismatch: 0, not_found: 0, unverifiable: 0 },
  },
  summary: { citedCount: 1, missingKeys: 0, unusedKeys: 0, duplicateKeys: 0, badCitations: 0, hallucinated: 0, mismatched: 0, unverifiable: 0 },
};

const highFeasibility: FeasibilityReport = {
  level: "HIGH", reasons: [], missingRequirements: [], researchGaps: [], requiredExperiments: [], evidenceGaps: [], recommendations: [],
};

describe("A9 gates：targetReadiness advisory（零阻断）", () => {
  it("提供 advisory → 结果透传；passed / reasons / rules 与不提供时完全一致", () => {
    const baseInput = {
      review: passingReview,
      citation: cleanCitation,
      evidence: cleanEvidence,
      feasibility: highFeasibility,
    };
    const withoutAdvisory = evaluateQualityGate(baseInput);
    const advisory = {
      verdict: "PARTIALLY_MEETS_TARGET" as const,
      benchmarkRevision: 0,
      evaluatedAt: "2026-10-07T00:00:00Z",
      summary: "摘要",
      dimensions: [{ dimension: "structure", verdict: "PARTIALLY_MEETS_TARGET" as const, confidence: "high", gaps: 1 }],
    };
    const withAdvisory = evaluateQualityGate({ ...baseInput, targetReadiness: advisory });
    expect(withAdvisory.targetReadiness).toEqual(advisory);
    expect(withoutAdvisory.targetReadiness).toBeUndefined();
    // 判定零变化
    expect(withAdvisory.passed).toBe(withoutAdvisory.passed);
    expect(withAdvisory.reasons).toEqual(withoutAdvisory.reasons);
    expect(withAdvisory.rules).toEqual(withoutAdvisory.rules);
    expect(withAdvisory.rules.length).toBe(withoutAdvisory.rules.length);
  });

  it("advisory 不产生任何 rule（即使 verdict=BELOW_TARGET 也不阻断）", () => {
    const gate = evaluateQualityGate(
      {
        review: passingReview,
        citation: cleanCitation,
        evidence: cleanEvidence,
        feasibility: highFeasibility,
        targetReadiness: {
          verdict: "BELOW_TARGET",
          benchmarkRevision: 0,
          evaluatedAt: "2026-10-07T00:00:00Z",
          summary: "低于目标带",
          dimensions: [],
        },
      },
    );
    expect(gate.passed).toBe(true);
    // 不新增任何 readiness 相关 rule（既有 target_feasibility 是 M3.2 规则，非本轮）
    expect(gate.rules.every((rule) => !/readiness/i.test(rule.rule))).toBe(true);
    expect(gate.rules.map((rule) => rule.rule)).toEqual(
      evaluateQualityGate({
        review: passingReview,
        citation: cleanCitation,
        evidence: cleanEvidence,
        feasibility: highFeasibility,
      }).rules.map((rule) => rule.rule),
    );
  });
});
