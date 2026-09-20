/**
 * Research Gap HITL 测试（M8.3.3 任务八-1/2/3/4/6）：
 * - Schema：ResearchGap 形状（gapId 确定性 / severity 分级 / status 三态 /
 *   decidedAt）与缺口去重；
 * - Coverage gap 视图：list = 覆盖派生（proposed）+ 决策覆盖（落盘快照）；
 *   休眠决策（覆盖来源消失）不显示；空态（无 artifact / 无计划）；
 * - Accept / reject 状态机：proposed → accepted / rejected 落盘、幂等、
 *   反向 409、未知 gapId 404；
 * - Derive：accepted 缺口 + done 计划 → 新 draft（iterationNumber+1 /
 *   parentPlanId / questions 来自缺口 / queries 来自 suggestedQueries），
 *   旧计划不变；proposed / rejected → 409；用户改写优先；残差缺口整拷问题；
 * - Backward compatibility：M8.1 / M8.2 旧 artifact（无 gaps 字段）可分析、
 *   可确认、可派生；
 * - No evidence mutation：确认 / 派生不写 evidence / candidates。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import { ResearchCoverageService } from "../../src/agents/researchCoverage.js";
import { ResearchPlanIterationService } from "../../src/agents/researchPlanIteration.js";
import {
  ResearchGapService,
  buildResearchGaps,
  deterministicGapId,
  mergeGapDecisions,
  readGapDecisions,
  type ResearchGap,
} from "../../src/agents/researchGap.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(title: string): Promise<{ store: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-gap-"));
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

/**
 * 活动计划 done：问题 1 与 q-1 token 关联（partial → low）；问题 2 无关联检索
 * （missing → high）；literaturePlan 残差 → 1 条 medium 缺口（无关联问题）。
 */
function seededArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: "2026-09-20T08:00:00.000Z",
    taskId: "run-seed",
    plan: {
      planId: "rp-seed00000001",
      status: "done",
      questions: ["Transformer tracking 的发展脉络", "edge device 部署优化"],
      queries: [
        { queryId: "q-1", query: "transformer tracking survey", kind: "academic", status: "executed", resultCount: 5 },
      ],
      createdAt: "2026-09-20T08:00:00.000Z",
      updatedAt: "2026-09-20T08:00:00.000Z",
    },
    report: reportFixture({ literaturePlan: ["低照度场景数据集"] }),
    evidence: [],
    bibliography: [],
    ...overrides,
  };
}

function service(store: ProjectStore): ResearchGapService {
  return new ResearchGapService({
    projects: store,
    coverage: new ResearchCoverageService({
      projects: store,
      evidence: new EvidenceStore(store),
      candidates: new CandidateStore(store),
      log: () => {},
    }),
    planIteration: new ResearchPlanIterationService({ projects: store, log: () => {} }),
    log: () => {},
  });
}

/** seededArtifact 的期望缺口（顺序：两个 partial 问题 + 一个残差） */
function expectedGapIds(): string[] {
  const planId = "rp-seed00000001";
  return [
    deterministicGapId(planId, "Transformer tracking 的发展脉络", "Transformer tracking 的发展脉络"),
    deterministicGapId(planId, "edge device 部署优化", "edge device 部署优化"),
    deterministicGapId(planId, undefined, "低照度场景数据集"),
  ];
}

// ---- 任务八-1：ResearchGap schema ----

describe("ResearchGap schema（buildResearchGaps / mergeGapDecisions）", () => {
  it("缺口条目形状完整：gapId/planId/question/description/severity/suggestedQueries/status/createdAt", () => {
    const [first] = expectedGapIds();
    expect(first).toMatch(/^gap-[a-f0-9]{12}$/);
    // 形状经 ResearchGapService.list 断言（下方），这里校验纯函数面：
    const gaps = mergeGapDecisions(
      [
        {
          gapId: first!,
          planId: "rp-seed00000001",
          question: "Transformer tracking 的发展脉络",
          description: "…",
          severity: "low",
          suggestedQueries: ["Transformer tracking 的发展脉络"],
          status: "proposed",
          createdAt: "2026-09-20T08:00:00.000Z",
        },
      ],
      [],
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.status).toBe("proposed");
    expect(gaps[0]!.decidedAt).toBeUndefined();
  });

  it("分析器只能产生 proposed（结构保证）；决策覆盖按 gapId 挂回、未决策保持派生视图", () => {
    const derived: ResearchGap[] = [
      {
        gapId: "gap-aaaaaaaaaaaa",
        planId: "rp-1",
        description: "缺口一",
        severity: "high",
        suggestedQueries: ["a"],
        status: "proposed",
        createdAt: "2026-09-20T08:00:00.000Z",
      },
      {
        gapId: "gap-bbbbbbbbbbbb",
        planId: "rp-1",
        description: "缺口二",
        severity: "low",
        suggestedQueries: ["b"],
        status: "proposed",
        createdAt: "2026-09-20T08:00:00.000Z",
      },
    ];
    const merged = mergeGapDecisions(derived, [
      { ...derived[0]!, status: "accepted", decidedAt: "2026-09-20T09:00:00.000Z" },
    ]);
    expect(merged[0]).toMatchObject({ status: "accepted", decidedAt: "2026-09-20T09:00:00.000Z" });
    expect(merged[1]!.status).toBe("proposed");
  });

  it("readGapDecisions：宽容读取（非法条目 / proposed 条目过滤；非数组 → 空）", () => {
    expect(readGapDecisions({} as never)).toEqual([]);
    expect(
      readGapDecisions({
        gaps: [
          "not-an-object",
          { gapId: "", status: "accepted" },
          { gapId: "gap-cccccccccccc", status: "proposed" }, // proposed 不允许落盘
          { gapId: "gap-dddddddddddd", status: "accepted", description: "ok" },
        ],
      } as never),
    ).toEqual([{ gapId: "gap-dddddddddddd", status: "accepted", description: "ok" }]);
  });
});

// ---- 任务八-2 / 3 / 6：Service（list / accept / reject / 兼容 / No mutation） ----

describe("ResearchGapService（list / accept / reject）", () => {
  it("list：旧 artifact（无 gaps 字段）→ 全部 proposed，含确定性 gapId 与 severity", async () => {
    const { store, projectId } = await newProject("gap-list-legacy");
    await seedArtifact(store, projectId, seededArtifact());

    const result = await service(store).list(projectId);
    expect(result.planId).toBe("rp-seed00000001");
    const [g1, g2, g3] = expectedGapIds();
    expect(result.gaps.map((gap) => gap.gapId)).toEqual([g1, g2, g3]);
    expect(result.gaps.map((gap) => gap.severity)).toEqual(["low", "high", "medium"]);
    expect(result.gaps.every((gap) => gap.status === "proposed")).toBe(true);
    expect(result.gaps[2]!.question).toBeUndefined(); // 残差缺口无关联问题
    expect(result.gaps[2]!.suggestedQueries).toEqual(["低照度场景数据集"]);
  });

  it("list：空态——无 artifact / 无计划 → { planId: null, gaps: [] }（不报错）", async () => {
    const noArtifact = await newProject("gap-empty-artifact");
    expect(await service(noArtifact.store).list(noArtifact.projectId)).toEqual({
      planId: null,
      gaps: [],
    });

    const noPlan = await newProject("gap-empty-plan");
    await seedArtifact(noPlan.store, noPlan.projectId, {
      generatedAt: "2026-09-20T08:00:00.000Z",
      taskId: "run-seed",
      report: reportFixture(),
      evidence: [],
      bibliography: [],
    });
    expect(await service(noPlan.store).list(noPlan.projectId)).toEqual({ planId: null, gaps: [] });
  });

  it("accept：proposed → accepted 落盘（decidedAt + gaps 字段），幂等重试不写盘", async () => {
    const { store, projectId } = await newProject("gap-accept");
    await seedArtifact(store, projectId, seededArtifact());
    const gapId = expectedGapIds()[0]!;

    const accepted = await service(store).accept(projectId, gapId);
    expect(accepted).toMatchObject({ gapId, status: "accepted" });
    expect(accepted.decidedAt).toBeDefined();

    // 落盘校验：research.json 顶层 gaps 只含该决策快照；plan 链原样
    const stored = JSON.parse(await readArtifactRaw(store, projectId)) as Record<string, unknown>;
    const gaps = stored["gaps"] as ResearchGap[];
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ gapId, status: "accepted" });
    expect(stored["plan"]).toMatchObject({ planId: "rp-seed00000001", status: "done" });

    // 幂等：再次 accept 返回同一决策，文件字节级不变
    const before = await readArtifactRaw(store, projectId);
    const again = await service(store).accept(projectId, gapId);
    expect(again.status).toBe("accepted");
    expect(await readArtifactRaw(store, projectId)).toBe(before);
  });

  it("reject：proposed → rejected；accept 后 reject → 409 GAP_INVALID_STATE（决策不翻转）", async () => {
    const { store, projectId } = await newProject("gap-reject");
    await seedArtifact(store, projectId, seededArtifact());
    const [g1, g2] = expectedGapIds();

    const rejected = await service(store).reject(projectId, g2!);
    expect(rejected).toMatchObject({ gapId: g2, status: "rejected" });

    // 已接受的缺口反向 reject → 409（决策不翻转）
    await service(store).accept(projectId, g1!);
    await expect(service(store).reject(projectId, g1!)).rejects.toMatchObject({
      code: "GAP_INVALID_STATE",
      httpStatus: 409,
    });
    // reject 后反向 accept 同样 409
    await expect(service(store).accept(projectId, g2!)).rejects.toMatchObject({
      code: "GAP_INVALID_STATE",
    });
    // 决策覆盖：list 反映 accepted / rejected
    const result = await service(store).list(projectId);
    expect(result.gaps.find((gap) => gap.gapId === g1)).toMatchObject({ status: "accepted" });
    expect(result.gaps.find((gap) => gap.gapId === g2)).toMatchObject({ status: "rejected" });
    expect(result.gaps.find((gap) => gap.gapId === expectedGapIds()[2])).toMatchObject({
      status: "proposed",
    });
  });

  it("未知 gapId → 404；无 artifact → 404（与 coverage analyze 同口径）", async () => {
    const { store, projectId } = await newProject("gap-404");
    await seedArtifact(store, projectId, seededArtifact());
    await expect(service(store).accept(projectId, "gap-000000000000")).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });

    const empty = await newProject("gap-404-empty");
    await expect(service(empty.store).accept(empty.projectId, "gap-000000000000")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("休眠决策：缺口来源消失（问题转 covered）→ list 不显示，决策保留在盘上", async () => {
    const { store, projectId } = await newProject("gap-dormant");
    await seedArtifact(store, projectId, seededArtifact());
    const g1 = expectedGapIds()[0]!;
    await service(store).accept(projectId, g1);

    // 补充证据使问题 1 转 covered → 缺口 1 从派生视图消失
    const evidence = new EvidenceStore(store);
    await evidence.append(
      projectId,
      { claim: "Transformer tracking 综述梳理了发展脉络", source: { title: "A Survey of Transformer Tracking" } },
      "researcher",
    );
    const result = await service(store).list(projectId);
    expect(result.gaps.some((gap) => gap.gapId === g1)).toBe(false);
    const stored = JSON.parse(await readArtifactRaw(store, projectId)) as Record<string, unknown>;
    expect((stored["gaps"] as ResearchGap[]).some((gap) => gap.gapId === g1)).toBe(true);
    // 休眠缺口不可再操作（不在当前派生清单 → 404）
    await expect(service(store).accept(projectId, g1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("No evidence mutation：accept / reject / list 不写 evidence / candidates", async () => {
    const { store, projectId } = await newProject("gap-no-mutation");
    await seedArtifact(store, projectId, seededArtifact());
    const candidates = new CandidateStore(store);
    await candidates.add(projectId, { doi: "10.1000/x1", title: "Some Paper" });
    const evidence = new EvidenceStore(store);
    await evidence.append(projectId, { claim: "既有证据" }, "researcher");
    const before = {
      evidenceFile: await readFile(join(store.evidenceDir(projectId), "evidence.jsonl"), "utf8"),
      candidatesFile: await readFile(join(store.sourcesDir(projectId), "candidates.json"), "utf8"),
    };

    const gapService = service(store);
    await gapService.list(projectId);
    await gapService.accept(projectId, expectedGapIds()[0]!);
    await gapService.reject(projectId, expectedGapIds()[1]!);

    expect(await readFile(join(store.evidenceDir(projectId), "evidence.jsonl"), "utf8")).toBe(
      before.evidenceFile,
    );
    expect(await readFile(join(store.sourcesDir(projectId), "candidates.json"), "utf8")).toBe(
      before.candidatesFile,
    );
  });
});

// ---- 任务八-4：Gap derive（复用 M8.3.1 单一派生逻辑） ----

describe("ResearchGapService（derive）", () => {
  it("accepted 缺口 + done 计划 → 新 draft：iterationNumber+1 / parentPlanId / questions 来自缺口 / queries 来自 suggestedQueries；旧计划不变", async () => {
    const { store, projectId } = await newProject("gap-derive");
    await seedArtifact(store, projectId, seededArtifact());
    const g2 = expectedGapIds()[1]!; // edge device 部署优化（partial → low）
    await service(store).accept(projectId, g2);

    const plan = await service(store).derive(projectId, g2, {});
    expect(plan).toMatchObject({
      status: "draft",
      parentPlanId: "rp-seed00000001",
      iterationNumber: 2,
      questions: ["edge device 部署优化"],
    });
    expect(plan.queries).toHaveLength(1);
    expect(plan.queries[0]).toMatchObject({
      query: "edge device 部署优化",
      kind: "academic",
      status: "planned",
    });
    expect(plan.queries[0]!.rationale).toContain("来自研究缺口");
    expect(plan.queries[0]!.resultCount).toBeUndefined();

    // 旧计划保持不变；新计划成为活动计划（plans 链两轮）
    const stored = JSON.parse(await readArtifactRaw(store, projectId)) as Record<string, unknown>;
    const plans = stored["plans"] as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ planId: "rp-seed00000001", status: "done", iterationNumber: 1 });
    expect(plans[0]!["questions"]).toEqual(["Transformer tracking 的发展脉络", "edge device 部署优化"]);
    expect(stored["activePlanId"]).toBe(plan.planId);
    // 缺口决策不因派生被清掉
    expect((stored["gaps"] as ResearchGap[]).some((gap) => gap.gapId === g2)).toBe(true);
  });

  it("用户改写优先：body queries 覆盖 suggestedQueries；body questions 覆盖缺口问题", async () => {
    const { store, projectId } = await newProject("gap-derive-modify");
    await seedArtifact(store, projectId, seededArtifact());
    const g2 = expectedGapIds()[1]!;
    await service(store).accept(projectId, g2);

    const plan = await service(store).derive(projectId, g2, {
      questions: ["改写后的部署问题"],
      queries: [{ query: "edge mot deployment", kind: "web" }],
    });
    expect(plan.questions).toEqual(["改写后的部署问题"]);
    expect(plan.queries).toEqual([
      { queryId: "q-1", query: "edge mot deployment", kind: "web", status: "planned" },
    ]);
  });

  it("残差缺口（无关联问题）→ questions 整拷来源计划（M8.3.1 derive 缺省语义）", async () => {
    const { store, projectId } = await newProject("gap-derive-residual");
    await seedArtifact(store, projectId, seededArtifact());
    const g3 = expectedGapIds()[2]!; // 低照度场景数据集（残差）
    await service(store).accept(projectId, g3);

    const plan = await service(store).derive(projectId, g3, {});
    expect(plan.questions).toEqual(["Transformer tracking 的发展脉络", "edge device 部署优化"]);
    expect(plan.queries[0]).toMatchObject({ query: "低照度场景数据集", kind: "academic", status: "planned" });
  });

  it("proposed / rejected 缺口 → 409 GAP_INVALID_STATE（Human Approval 是派生门槛）", async () => {
    const { store, projectId } = await newProject("gap-derive-gate");
    await seedArtifact(store, projectId, seededArtifact());
    const [g1, g2] = expectedGapIds();

    await expect(service(store).derive(projectId, g1!, {})).rejects.toMatchObject({
      code: "GAP_INVALID_STATE",
      httpStatus: 409,
    });
    await service(store).reject(projectId, g2!);
    await expect(service(store).derive(projectId, g2!, {})).rejects.toMatchObject({
      code: "GAP_INVALID_STATE",
    });
  });

  it("来源计划非 done（draft）→ 409 PLAN_INVALID_STATE（透传 M8.3.1 派生口径）", async () => {
    const { store, projectId } = await newProject("gap-derive-not-done");
    await seedArtifact(store, projectId, seededArtifact({ plan: { ...(seededArtifact()["plan"] as Record<string, unknown>), status: "draft" } }));
    const g1 = expectedGapIds()[0]!;
    await service(store).accept(projectId, g1);

    await expect(service(store).derive(projectId, g1, {})).rejects.toMatchObject({
      code: "PLAN_INVALID_STATE",
      httpStatus: 409,
    });
  });

  it("非法请求体（queries 带 queryId / status）→ 400（透传 derive 校验）", async () => {
    const { store, projectId } = await newProject("gap-derive-400");
    await seedArtifact(store, projectId, seededArtifact());
    const g1 = expectedGapIds()[0]!;
    await service(store).accept(projectId, g1);

    await expect(
      service(store).derive(projectId, g1, { queries: [{ queryId: "q-9", query: "x", kind: "web" }] }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", httpStatus: 400 });
    await expect(service(store).derive(projectId, g1, { queries: [{ query: "x", kind: "web", status: "executed" }] })).rejects.toMatchObject(
      { code: "INVALID_REQUEST" },
    );
  });

  it("未知 gapId / 无 artifact → 404；不产生任何派生副作用", async () => {
    const { store, projectId } = await newProject("gap-derive-404");
    await seedArtifact(store, projectId, seededArtifact());
    const before = await readArtifactRaw(store, projectId);
    await expect(service(store).derive(projectId, "gap-000000000000", {})).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await readArtifactRaw(store, projectId)).toBe(before);
  });
});

// ---- buildResearchGaps 上限（防膨胀） ----

describe("buildResearchGaps（上限与去重）", () => {
  it("同问题重复出现只保留一条；超过 30 条截断", () => {
    const question = { question: "同一问题", origin: "plan" as const, coverage: "missing" as const, relatedQueryCount: 0, executedQueryCount: 0, resultCount: 0, evidenceCount: 0, promotedCount: 0, gap: "g" };
    const deduped = buildResearchGaps({
      planId: "rp-x",
      createdAt: "2026-09-20T08:00:00.000Z",
      questions: [question, question],
      literaturePlan: [],
    });
    expect(deduped).toHaveLength(1);

    const many = Array.from({ length: 35 }, (_, index) => ({
      ...question,
      question: `问题 ${index}`,
    }));
    const capped = buildResearchGaps({
      planId: "rp-x",
      createdAt: "2026-09-20T08:00:00.000Z",
      questions: many,
      literaturePlan: [],
    });
    expect(capped).toHaveLength(30);
  });
});
