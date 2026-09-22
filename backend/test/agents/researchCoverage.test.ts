/**
 * Research Coverage Analyzer 测试（M8.3.2 任务八-1/2/3/4/5）：
 * - Coverage rule：missing（无关联检索）/ missing（有检索无结果）/ partial /
 *   covered（evidence）/ covered（promoted literature）的确定性三态判定；
 * - Gap recommendation：missing / partial 问题与 report.literaturePlan 残差
 *   方向 → 缺口 + 建议检索（只建议，不派生）；
 * - Coverage service：读取 executionHistory（M8.2 记录回补 resultCount）、
 *   EvidenceStore / CandidateStore 只读聚合、404 口径；
 * - Backward compatibility：M8.1 / M8.2 旧 artifact（单一 plan、无 iteration
 *   字段）仍然可分析；
 * - No mutation：分析不写 research.json / evidence / candidates。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import {
  ResearchCoverageService,
  analyzeCoverage,
  assessQuestionCoverage,
  isTextRelated,
  matchTokens,
  mergeQueryFacts,
  type CoverageQueryFacts,
} from "../../src/agents/researchCoverage.js";
import {
  buildResearchGaps,
  deterministicGapId,
  type ResearchGap,
} from "../../src/agents/researchGap.js";
import type { PlanExecutionEntry } from "../../src/agents/researchPlanExecution.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(title: string): Promise<{ store: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-coverage-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create(title, { researchIdea: "Transformer MOT" });
  return { store, projectId: project.id };
}

async function seedArtifact(store: ProjectStore, projectId: string, artifact: Record<string, unknown>) {
  const researchDir = store.researchDir(projectId);
  await import("node:fs/promises").then((fs) => fs.mkdir(researchDir, { recursive: true }));
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

async function readArtifactRaw(store: ProjectStore, projectId: string): Promise<string> {
  return readFile(join(store.researchDir(projectId), "research.json"), "utf8");
}

function reportFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    domainOverview: "调研概述",
    relatedWorkDirections: [],
    researchGaps: ["gap"],
    potentialContributions: ["贡献"],
    researchQuestions: [],
    literaturePlan: [],
    ...overrides,
  };
}

/** 检索事实快捷构造 */
function facts(overrides: Partial<CoverageQueryFacts> & { query: string }): CoverageQueryFacts {
  return {
    queryId: "q-1",
    expectedCoverage: undefined,
    executed: false,
    resultCount: 0,
    ...overrides,
  } as CoverageQueryFacts;
}

function service(store: ProjectStore): ResearchCoverageService {
  return new ResearchCoverageService({
    projects: store,
    evidence: new EvidenceStore(store),
    candidates: new CandidateStore(store),
    log: () => {},
  });
}

// ---- 任务八-1：Coverage rule（纯函数三态） ----

describe("Coverage rule（assessQuestionCoverage）", () => {
  const base = { evidenceTexts: [] as string[], literatureTexts: [] as string[] };

  it("问题与文本的确定性关联：拉丁词（≥3 字符）与 CJK 二元组交集；空文本/无 token 不关联", () => {
    expect(isTextRelated("Transformer MOT 的发展", "transformer mot survey")).toBe(true);
    expect(isTextRelated("Transformer MOT 的发展", "occlusion tracking benchmark")).toBe(false);
    // CJK bigram：遮挡场景 vs 场景遮挡共享 {遮挡,场景} 二元组
    expect(isTextRelated("遮挡场景的身份保持", "遮挡场景下的跟踪方法")).toBe(true);
    expect(isTextRelated("遮挡场景的身份保持", "低照度环境检测")).toBe(false);
    // 纯中文问题 vs 纯英文检索词：确定性局限，判不关联（落入 missing，不伪造关联）
    expect(isTextRelated("遮挡场景的身份保持", "occlusion identity preservation")).toBe(false);
    expect(isTextRelated("any question", "")).toBe(false);
    expect(matchTokens("a of to 42")).toEqual(new Set()); // 短拉丁词（<3 字符）与纯数字为噪声
  });

  it("missing：计划中没有任何与该问题相关的检索", () => {
    const result = assessQuestionCoverage({
      ...base,
      question: "边缘设备部署优化",
      origin: "plan",
      queries: [facts({ query: "transformer mot survey", executed: true, resultCount: 10 })],
    });
    expect(result.coverage).toBe("missing");
    expect(result.relatedQueryCount).toBe(0);
    expect(result.executedQueryCount).toBe(0);
    expect(result.gap).toContain("没有任何与该问题相关的检索");
  });

  it("missing：有相关检索但均未执行带回结果（resultCount=0 / 未执行）", () => {
    const result = assessQuestionCoverage({
      ...base,
      question: "Transformer MOT 的发展",
      origin: "plan",
      queries: [
        facts({ queryId: "q-1", query: "transformer mot survey", executed: false, resultCount: 0 }),
        facts({ queryId: "q-2", query: "transformer mot history", executed: true, resultCount: 0 }),
      ],
    });
    expect(result.coverage).toBe("missing");
    expect(result.relatedQueryCount).toBe(2);
    expect(result.executedQueryCount).toBe(0);
    expect(result.gap).toContain("均未执行带回结果");
  });

  it("partial：有带回结果的检索，但无证据 / 入库文献支撑", () => {
    const result = assessQuestionCoverage({
      ...base,
      question: "Transformer MOT 实时部署",
      origin: "plan",
      queries: [facts({ query: "real-time transformer mot deployment", executed: true, resultCount: 25 })],
    });
    expect(result.coverage).toBe("partial");
    expect(result.executedQueryCount).toBe(1);
    expect(result.resultCount).toBe(25);
    expect(result.gap).toContain("尚无相关证据或已入库文献支撑");
  });

  it("covered：关联 EvidenceStore 证据条目（claim / 来源标题 token 命中）", () => {
    const result = assessQuestionCoverage({
      ...base,
      question: "Transformer MOT 实时部署",
      origin: "plan",
      queries: [facts({ query: "real-time transformer mot deployment", executed: true, resultCount: 25 })],
      evidenceTexts: ["Transformer 架构在 MOT 实时部署中的延迟分析"],
    });
    expect(result.coverage).toBe("covered");
    expect(result.evidenceCount).toBe(1);
    expect(result.gap).toBeUndefined();
  });

  it("M9.4 收紧：未核验（legacy unverified）证据只支撑 partial，不构成 covered", () => {
    const result = assessQuestionCoverage({
      ...base,
      question: "Transformer MOT 实时部署",
      origin: "plan",
      queries: [facts({ query: "real-time transformer mot deployment", executed: true, resultCount: 25 })],
      evidenceTexts: [],
      unverifiedEvidenceTexts: ["Transformer 架构在 MOT 实时部署中的延迟分析"],
    });
    expect(result.coverage).toBe("partial");
    expect(result.evidenceCount).toBe(0);
    expect(result.gap).toContain("尚无已核验（verified）证据或已入库文献支撑");
    // 未核验 + 已核验同时存在：verified 命中仍是 covered
    const mixed = assessQuestionCoverage({
      ...base,
      question: "Transformer MOT 实时部署",
      origin: "plan",
      queries: [facts({ query: "real-time transformer mot deployment", executed: true, resultCount: 25 })],
      evidenceTexts: ["Transformer MOT 实时部署的延迟分析"],
      unverifiedEvidenceTexts: ["Transformer 架构在 MOT 实时部署中的早期结论"],
    });
    expect(mixed.coverage).toBe("covered");
  });

  it("covered：关联已入库文献（候选检索词 / 标题命中）", () => {
    const result = assessQuestionCoverage({
      ...base,
      question: "Transformer MOT 实时部署",
      origin: "plan",
      queries: [facts({ query: "real-time transformer mot deployment", executed: true, resultCount: 25 })],
      literatureTexts: ["efficient transformer mot edge deployment EdgeMOT: Efficient MOT on Edge Devices"],
    });
    expect(result.coverage).toBe("covered");
    expect(result.promotedCount).toBe(1);
    expect(result.evidenceCount).toBe(0);
  });

  it("expectedCoverage 也参与关联（检索词未命中但期望覆盖声明命中）", () => {
    const result = assessQuestionCoverage({
      ...base,
      question: "遮挡场景的身份保持",
      origin: "plan",
      queries: [
        facts({ query: "occlusion identity preservation", expectedCoverage: "遮挡场景身份保持", executed: true, resultCount: 8 }),
      ],
    });
    expect(result.relatedQueryCount).toBe(1);
    expect(result.coverage).toBe("partial");
  });
});

// ---- 任务八-3：Gap recommendation（M8.3.3 起：buildResearchGaps → ResearchGap[]）----

describe("Gap recommendation（buildResearchGaps / analyzeCoverage）", () => {
  it("missing / partial 生成缺口（gapId 稳定 + severity 分级 + status=proposed）；covered 不生成", () => {
    const missing = assessQuestionCoverage({
      question: "边缘部署优化",
      origin: "plan",
      queries: [],
      evidenceTexts: [],
      literatureTexts: [],
    });
    const covered = assessQuestionCoverage({
      question: "Transformer MOT 的发展",
      origin: "plan",
      queries: [facts({ query: "transformer mot survey", executed: true, resultCount: 5 })],
      evidenceTexts: ["Transformer MOT 综述结论"],
      literatureTexts: [],
    });
    const gaps = buildResearchGaps({
      planId: "rp-100000000001",
      createdAt: "2026-09-20T08:00:00.000Z",
      questions: [missing, covered],
      literaturePlan: [],
    });
    expect(gaps).toEqual([
      {
        gapId: deterministicGapId("rp-100000000001", "边缘部署优化", "边缘部署优化"),
        planId: "rp-100000000001",
        question: "边缘部署优化",
        description: missing.gap ?? "该研究问题未被覆盖",
        severity: "high", // missing 且无关联检索
        suggestedQueries: ["边缘部署优化"],
        status: "proposed",
        createdAt: "2026-09-20T08:00:00.000Z",
      },
    ] satisfies ResearchGap[]);
  });

  it("severity 分级：missing 有关联检索无结果 = medium；partial = low", () => {
    const noResults = assessQuestionCoverage({
      question: "Transformer MOT 的发展",
      origin: "plan",
      queries: [facts({ query: "transformer mot survey", executed: true, resultCount: 0 })],
      evidenceTexts: [],
      literatureTexts: [],
    });
    const partial = assessQuestionCoverage({
      question: "Transformer MOT 实时部署",
      origin: "plan",
      queries: [facts({ query: "real-time transformer mot deployment", executed: true, resultCount: 25 })],
      evidenceTexts: [],
      literatureTexts: [],
    });
    const gaps = buildResearchGaps({
      planId: "rp-100000000003",
      createdAt: "2026-09-20T08:00:00.000Z",
      questions: [noResults, partial],
      literaturePlan: [],
    });
    expect(gaps.map((gap) => gap.severity)).toEqual(["medium", "low"]);
  });

  it("gapId 确定性：同计划同问题多次构造同 id；不同计划不同 id", () => {
    const first = buildResearchGaps({
      planId: "rp-100000000001",
      createdAt: "2026-09-20T08:00:00.000Z",
      questions: [
        assessQuestionCoverage({ question: "边缘部署优化", origin: "plan", queries: [], evidenceTexts: [], literatureTexts: [] }),
      ],
      literaturePlan: [],
    });
    const second = buildResearchGaps({
      planId: "rp-100000000001",
      createdAt: "2026-09-20T09:00:00.000Z", // 时间变化不改变 id
      questions: [
        assessQuestionCoverage({ question: "边缘部署优化", origin: "plan", queries: [], evidenceTexts: [], literatureTexts: [] }),
      ],
      literaturePlan: [],
    });
    const otherPlan = buildResearchGaps({
      planId: "rp-100000000002",
      createdAt: "2026-09-20T08:00:00.000Z",
      questions: [
        assessQuestionCoverage({ question: "边缘部署优化", origin: "plan", queries: [], evidenceTexts: [], literatureTexts: [] }),
      ],
      literaturePlan: [],
    });
    expect(first[0]!.gapId).toBe(second[0]!.gapId);
    expect(first[0]!.gapId).not.toBe(otherPlan[0]!.gapId);
    expect(first[0]!.gapId).toMatch(/^gap-[a-f0-9]{12}$/);
  });

  it("report.literaturePlan 残差方向直通缺口（无关联问题，severity=medium）；建议检索 = 方向原文", () => {
    const gaps = buildResearchGaps({
      planId: "rp-100000000001",
      createdAt: "2026-09-20T08:00:00.000Z",
      questions: [],
      literaturePlan: ["边缘设备上的高效推理", " "],
    });
    expect(gaps).toEqual([
      {
        gapId: deterministicGapId("rp-100000000001", undefined, "边缘设备上的高效推理"),
        planId: "rp-100000000001",
        description: "调研报告登记的残差文献方向：边缘设备上的高效推理",
        severity: "medium",
        suggestedQueries: ["边缘设备上的高效推理"],
        status: "proposed",
        createdAt: "2026-09-20T08:00:00.000Z",
      },
    ] satisfies ResearchGap[]);
  });

  it("analyzeCoverage：plan.questions 优先 + report.researchQuestions 去重补充（origin 标注）+ overall 汇总", () => {
    const coverage = analyzeCoverage({
      planId: "rp-100000000001",
      planStatus: "done",
      iterationNumber: 2,
      analyzedAt: "2026-09-20T08:00:00.000Z",
      planQuestions: ["Transformer MOT 的发展", "边缘部署优化"],
      reportQuestions: ["Transformer MOT 的发展", "遮挡场景身份保持"],
      queries: [
        facts({ queryId: "q-1", query: "transformer mot survey", executed: true, resultCount: 5 }),
      ],
      evidenceTexts: ["Transformer MOT 综述结论"],
      literatureTexts: [],
      literaturePlan: ["低照度场景数据集"],
    });
    expect(coverage.planId).toBe("rp-100000000001");
    expect(coverage.planStatus).toBe("done");
    expect(coverage.iterationNumber).toBe(2);
    expect(coverage.questions).toHaveLength(3); // 去重后 plan 2 + report 1
    expect(coverage.questions.map((entry) => [entry.origin, entry.coverage])).toEqual([
      ["plan", "covered"],
      ["plan", "missing"],
      ["report", "missing"],
    ]);
    expect(coverage.overall).toMatchObject({ questionCount: 3, covered: 1, partial: 0, missing: 2 });
    expect(coverage.overall.summary).toContain("covered 1 · partial 0 · missing 2");
    // 缺口 = 2 个未覆盖问题 + 1 个 literaturePlan 残差
    expect(coverage.gaps).toHaveLength(3);
    expect(coverage.gaps[2]).toMatchObject({
      description: "调研报告登记的残差文献方向：低照度场景数据集",
      suggestedQueries: ["低照度场景数据集"],
    });
  });

  it("无研究问题：空 questions + 引导 summary，不报错", () => {
    const coverage = analyzeCoverage({
      planId: "rp-100000000002",
      planStatus: "draft",
      analyzedAt: "2026-09-20T08:00:00.000Z",
      planQuestions: [],
      reportQuestions: [],
      queries: [],
      evidenceTexts: [],
      literatureTexts: [],
      literaturePlan: [],
    });
    expect(coverage.questions).toEqual([]);
    expect(coverage.overall.summary).toContain("没有研究问题");
    expect(coverage.gaps).toEqual([]);
  });
});

// ---- mergeQueryFacts：executionHistory 回补（任务八-2 的纯函数面） ----

describe("mergeQueryFacts（plan.queries × executionHistory 合并）", () => {
  const history: PlanExecutionEntry[] = [
    {
      executionId: "exec-000000000001",
      queryId: "q-1",
      query: "transformer mot survey",
      kind: "academic",
      timestamp: "2026-09-19T09:00:00.000Z",
      status: "executed",
      resultCount: 5,
    },
    {
      executionId: "exec-000000000002",
      queryId: "q-2",
      query: "mot occlusion",
      kind: "web",
      timestamp: "2026-09-19T09:00:01.000Z",
      status: "failed",
      error: "provider 全部失败",
    },
  ];

  it("plan 回填优先（resultCount / executed 以 plan 为准）", () => {
    expect(
      mergeQueryFacts({ queryId: "q-1", query: "transformer mot survey", status: "executed", resultCount: 12 }, history),
    ).toEqual({ queryId: "q-1", query: "transformer mot survey", executed: true, resultCount: 12 });
  });

  it("plan 无 resultCount 时从执行历史累加（旧 artifact 兼容）；failed 记录不计", () => {
    expect(
      mergeQueryFacts({ queryId: "q-1", query: "transformer mot survey", status: "executed" }, history),
    ).toEqual({ queryId: "q-1", query: "transformer mot survey", executed: true, resultCount: 5 });
    expect(
      mergeQueryFacts({ queryId: "q-2", query: "mot occlusion", status: "planned" }, history),
    ).toEqual({ queryId: "q-2", query: "mot occlusion", executed: false, resultCount: 0 });
  });
});

// ---- 任务八-2 / 4 / 5：Service（读取 executionHistory / 兼容 / No mutation） ----

describe("ResearchCoverageService", () => {
  /** M8.1 / M8.2 旧形态 plan（无 iteration 字段；q-2 手工 executed 无 resultCount） */
  function legacyArtifact(): Record<string, unknown> {
    return {
      generatedAt: "2026-09-18T08:00:00.000Z",
      taskId: "run-seed",
      plan: {
        planId: "rp-legacy000001",
        status: "done",
        questions: ["Transformer tracking 的发展脉络", "edge device 部署优化"],
        queries: [
          { queryId: "q-1", query: "transformer tracking survey", kind: "academic", status: "executed", resultCount: 5 },
          { queryId: "q-2", query: "edge device deployment", kind: "web", status: "executed" },
        ],
        createdAt: "2026-09-18T08:00:00.000Z",
        updatedAt: "2026-09-18T08:00:00.000Z",
      },
      executionHistory: [
        {
          executionId: "exec-seed0000001",
          queryId: "q-2",
          query: "edge device deployment",
          kind: "web",
          timestamp: "2026-09-18T09:00:00.000Z",
          status: "executed",
          resultCount: 3,
        },
      ],
      report: reportFixture({ researchQuestions: ["遮挡场景身份保持"] }),
      evidence: [],
      bibliography: [],
    };
  }

  it("读取 executionHistory：q-2 无 resultCount 从历史回补（missing→partial 判定可见）", async () => {
    const { store, projectId } = await newProject("svc-history");
    await seedArtifact(store, projectId, legacyArtifact());

    const coverage = await service(store).analyze(projectId);
    expect(coverage.planId).toBe("rp-legacy000001");
    const edge = coverage.questions.find((entry) => entry.question.includes("部署优化"))!;
    // 历史回补 resultCount=3 → 有关联且有结果，但无 evidence / 文献 → partial
    expect(edge).toMatchObject({ coverage: "partial", relatedQueryCount: 1, executedQueryCount: 1, resultCount: 3 });
  });

  it("读取 EvidenceStore / CandidateStore（只读聚合）：已核验证据与已入库候选驱动 covered", async () => {
    const { store, projectId } = await newProject("svc-stores");
    await seedArtifact(store, projectId, legacyArtifact());
    const evidence = new EvidenceStore(store);
    await evidence.append(
      projectId,
      {
        claim: "Transformer tracking 综述梳理了发展脉络",
        source: { title: "A Survey of Transformer Tracking" },
        // M9.4：covered 只认 verified（grounding 管道 / user_confirmed 的产物形态）
        verificationStatus: "verified",
      },
      "researcher",
    );
    const candidates = new CandidateStore(store);
    const added = await candidates.add(projectId, {
      doi: "10.1000/edgemot",
      title: "EdgeMOT: Efficient MOT on Edge Devices",
      query: "edge device deployment",
      origin: "academic_search",
      provider: "openalex",
    });
    await candidates.markAccepted(projectId, added.candidate.candidateId, "S001");

    const coverage = await service(store).analyze(projectId);
    expect(coverage.questions.find((entry) => entry.origin === "report")!).toMatchObject({
      coverage: "missing", // 遮挡场景身份保持：无关联检索
    });
    expect(coverage.questions[0]).toMatchObject({ coverage: "covered", evidenceCount: 1 });
    expect(coverage.questions[1]).toMatchObject({ coverage: "covered", promotedCount: 1 });
    expect(coverage.overall).toMatchObject({ covered: 2, partial: 0, missing: 1 });
    // report.researchQuestions 的未覆盖问题进入缺口建议
    expect(coverage.gaps.map((gap) => gap.question)).toContain("遮挡场景身份保持");
  });

  it("M9.4 收紧：Service 聚合把未核验证据归入 unverifiedEvidenceTexts（最多 partial）", async () => {
    const { store, projectId } = await newProject("svc-unverified");
    await seedArtifact(store, projectId, legacyArtifact());
    const evidence = new EvidenceStore(store);
    // 缺省 verificationStatus=unverified（legacy 追加路径的真实形态）
    await evidence.append(
      projectId,
      { claim: "Transformer tracking 综述梳理了发展脉络", source: { title: "A Survey of Transformer Tracking" } },
      "researcher",
    );

    const coverage = await service(store).analyze(projectId);
    const question = coverage.questions[0]!;
    expect(question.coverage).toBe("partial");
    expect(question.evidenceCount).toBe(0);
    expect(question.gap).toContain("尚无已核验（verified）证据或已入库文献支撑");
  });

  it("backward compatibility：M8.1 artifact（无 executionHistory / 无 iteration 字段）仍可分析", async () => {
    const { store, projectId } = await newProject("svc-legacy-m81");
    const artifact = legacyArtifact();
    delete artifact["executionHistory"];
    await seedArtifact(store, projectId, artifact);

    const coverage = await service(store).analyze(projectId);
    expect(coverage.overall.questionCount).toBe(3);
    expect(coverage.questions[0]).toMatchObject({ origin: "plan", coverage: "partial" });
    // 旧计划归一化 iterationNumber=1（readPlanChain 语义）
    expect(coverage.iterationNumber).toBe(1);
    expect(coverage.planStatus).toBe("done");
  });

  it("M8.3.1 多轮计划链：分析 activePlanId 指向的活动计划（非最新一轮亦可）", async () => {
    const { store, projectId } = await newProject("svc-chain");
    const v1 = {
      planId: "rp-a00000000001",
      iterationId: "it-aaa000000001",
      iterationNumber: 1,
      status: "done",
      questions: ["第一轮问题 transformer mot"],
      queries: [
        { queryId: "q-1", query: "transformer mot survey", kind: "academic", status: "executed", resultCount: 5 },
      ],
      createdAt: "2026-09-18T08:00:00.000Z",
      updatedAt: "2026-09-18T08:00:00.000Z",
    };
    const v2 = {
      ...v1,
      planId: "rp-b00000000002",
      iterationNumber: 2,
      parentPlanId: v1.planId,
      status: "draft",
      questions: ["第二轮问题 edge deployment"],
      queries: [{ queryId: "q-1", query: "edge mot deployment", kind: "web", status: "planned" }],
    };
    await seedArtifact(store, projectId, {
      ...legacyArtifact(),
      plan: v1,
      plans: [v1, v2],
      activePlanId: v1.planId, // 活动计划指向历史轮（activate 过）
    });

    const coverage = await service(store).analyze(projectId);
    expect(coverage.planId).toBe("rp-a00000000001");
    expect(coverage.iterationNumber).toBe(1);
    // 活动计划 v1 的问题 + report 的结论问题（去重补充）
    expect(coverage.questions.map((entry) => entry.question)).toEqual([
      "第一轮问题 transformer mot",
      "遮挡场景身份保持",
    ]);
  });

  it("404 口径：无 artifact / 无计划（analyze）→ NOT_FOUND；get → null 空态", async () => {
    const noArtifact = await newProject("svc-404-artifact");
    await expect(service(noArtifact.store).analyze(noArtifact.projectId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    expect(await service(noArtifact.store).get(noArtifact.projectId)).toBeNull();

    const noPlan = await newProject("svc-404-plan");
    await seedArtifact(noPlan.store, noPlan.projectId, { ...legacyArtifact(), plan: undefined });
    await expect(service(noPlan.store).analyze(noPlan.projectId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    expect(await service(noPlan.store).get(noPlan.projectId)).toBeNull();
  });

  it("No mutation：分析后 research.json / evidence / candidates 字节级不变", async () => {
    const { store, projectId } = await newProject("svc-no-mutation");
    await seedArtifact(store, projectId, legacyArtifact());
    const evidence = new EvidenceStore(store);
    await evidence.append(projectId, { claim: "Transformer MOT 综述结论" }, "researcher");
    const candidates = new CandidateStore(store);
    await candidates.add(projectId, { doi: "10.1000/x1", title: "Some Paper" });
    const sources = new SourceStore(store);

    const before = {
      research: await readArtifactRaw(store, projectId),
      evidence: await readFile(join(store.evidenceDir(projectId), "evidence.jsonl"), "utf8"),
      candidatesJson: await readFile(join(store.sourcesDir(projectId), "candidates.json"), "utf8"),
      sourcesIndex: JSON.stringify(await sources.list(projectId)),
    };
    await service(store).analyze(projectId);
    await service(store).get(projectId);
    expect(await readArtifactRaw(store, projectId)).toBe(before.research);
    expect(await readFile(join(store.evidenceDir(projectId), "evidence.jsonl"), "utf8")).toBe(before.evidence);
    expect(await readFile(join(store.sourcesDir(projectId), "candidates.json"), "utf8")).toBe(
      before.candidatesJson,
    );
    expect(JSON.stringify(await sources.list(projectId))).toBe(before.sourcesIndex);
  });
});
