/**
 * M14.6：MissingMaterialLedger / Service 确定性测试（无模型）。
 *
 * 覆盖：A 类派生（实验章缺数据）、B 类建议（单篇窄范围永不自动确认）、材料充足零差距、
 * 模型不得发明章节 / 推进状态、作者补材料 → 事实到位收口、输入版本变化 stale 语义、
 * 重复扫描幂等、决定跨重开持久化、blockingGaps 口径。
 */

import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentRuntime, RunAgentInput } from "../../src/runtime/types.js";
import {
  MissingMaterialLedger,
  chaptersWithUsableFacts,
  deriveChapterMaterialGaps,
  deriveScopeGapProposals,
  missingMaterialGapId,
} from "../../src/thesis/MissingMaterialLedger.js";
import { MissingMaterialService, buildScopeGapProposalPrompt, parseScopeGapProposals } from "../../src/thesis/MissingMaterialService.js";
import type { MissingMaterialGapProposal, MissingMaterialLedgerFile } from "../../src/thesis/missingMaterialTypes.js";
import type { FactView, ResearchFactContext, ResearchInputSummary } from "../../src/thesis/researchInputTypes.js";
import type { ChapterMappingFile, ThesisChapterPlan, ThesisContribution, ThesisStoryline } from "../../src/thesis/thesisWorkflowTypes.js";
import { cleanupThesisFixtures, newThesisFixture } from "./fixtures.js";

afterAll(cleanupThesisFixtures);

// ---------- 夹具 ----------

const INPUT_A: ResearchInputSummary = {
  inputId: "ri-paperA",
  inputType: "published_paper",
  title: "Paper A",
  workId: "ri-paperA",
  contentHash: "hashA-v1",
  scope: "included",
  parseStatus: "full_text",
};

function contribution(id: string, kind: ThesisContribution["kind"], statement: string, linkedFactIds: string[] = []): ThesisContribution {
  return {
    id,
    researchInputId: INPUT_A.inputId,
    contentHash: INPUT_A.contentHash,
    kind,
    statement,
    anchorStatus: "verbatim",
    linkedFactIds,
    status: "confirmed",
    extraction: { method: "model_proposal", extractedAt: "2026-10-16T00:00:00.000Z" },
  };
}

function chapter(overrides: Partial<ThesisChapterPlan> & Pick<ThesisChapterPlan, "chapterId" | "titleZh" | "responsibility">): ThesisChapterPlan {
  return {
    goal: `${overrides.titleZh}的目标`,
    sectionFiles: [`${overrides.chapterId}.tex`],
    ownsContributionIds: [],
    referencesContributionIds: [],
    sourceInputIds: [INPUT_A.inputId],
    factIds: [],
    ...overrides,
  };
}

function mapping(projectId: string, chapters: ThesisChapterPlan[], outlineFingerprint = "outline-fp-1"): ChapterMappingFile {
  return { schemaVersion: 1, projectId, chapters, outlineFingerprint, status: "confirmed", updatedAt: "2026-10-16T00:00:00.000Z" };
}

function fact(factId: string, raw: string, verification: FactView["verification"] = "author_confirmed"): FactView {
  return {
    factId,
    researchInputId: INPUT_A.inputId,
    kind: "numeric_result",
    key: { metric: "error" },
    surface: `误差降低 ${raw}`,
    value: { raw },
    verification,
    sourceCheck: "verified",
    conflictStatus: "none",
    location: "p.8",
  };
}

function factContext(options: { confirmed?: FactView[]; verified?: FactView[]; inputs?: ResearchInputSummary[] } = {}): Pick<ResearchFactContext, "facts" | "inputs"> {
  return {
    inputs: { included: options.inputs ?? [INPUT_A], excluded: [], proposed: [], superseded: [], preferredVersionByWork: {} },
    facts: { authorConfirmed: options.confirmed ?? [], sourceVerifiedUnconfirmed: options.verified ?? [], extractedOnly: [], conflicted: [] },
  };
}

const EXPERIMENT_CONTRIBUTION = contribution("c-exp000001", "experiment_result", "所提方法使轨迹误差降低 75.37%");
const METHOD_CONTRIBUTION = contribution("c-met000001", "method", "提出基于时序一致性的复活抑制策略");

function experimentChapter(): ThesisChapterPlan {
  return chapter({ chapterId: "ch05", titleZh: "实验与分析", responsibility: "experiment", ownsContributionIds: [EXPERIMENT_CONTRIBUTION.id] });
}

function fakeRuntime(output: string): { runtime: AgentRuntime; calls: RunAgentInput[] } {
  const calls: RunAgentInput[] = [];
  const runtime = {
    runAgent: async (input: RunAgentInput) => {
      calls.push(input);
      return { status: "completed", output, taskId: `t-${calls.length}` };
    },
  } as unknown as AgentRuntime;
  return { runtime, calls };
}

// ---------- 测试 ----------

describe("M14.6 MissingMaterialLedger：确定性派生", () => {
  it("1. 已规划的实验章无数据 → 一条 A 类差距（requiresExperiment、不可无材料写作、experiment_data 需求）", async () => {
    const fx = await newThesisFixture();
    const ch = experimentChapter();
    const gaps = deriveChapterMaterialGaps({
      projectId: fx.projectId,
      mapping: mapping(fx.projectId, [ch]),
      missingChapters: [ch],
      contributions: [EXPERIMENT_CONTRIBUTION, METHOD_CONTRIBUTION],
      factContext: factContext(),
    });
    expect(gaps).toHaveLength(1);
    const gap = gaps[0]!;
    expect(gap.gapType).toBe("planned_chapter_material");
    expect(gap.origin).toBe("deterministic");
    expect(gap.chapterId).toBe("ch05");
    expect(gap.title).toBe("「实验与分析」缺少可支撑写作的研究材料");
    expect(gap.requiresExperiment).toBe(true);
    expect(gap.canWriteWithoutMaterial).toBe(false);
    expect(gap.requiredMaterials.map((item) => item.kind)).toEqual(["experiment_data"]);
    expect(gap.contributionIds).toEqual([EXPERIMENT_CONTRIBUTION.id]);
    expect(gap.supportingEvidence).toEqual(["chapter:ch05", `contribution:${EXPERIMENT_CONTRIBUTION.id}`]);
    expect(gap.description).toContain("75.37%");
    expect(gap.whyInsufficient).toContain("作者确认事实：0 条");
    expect(gap.whyInsufficient).toContain("含具体数值");
    expect(gap.gapId).toBe(missingMaterialGapId("planned_chapter_material", "ch05", gap.title));

    // 方法章缺材料：可以按设计 / 理论口径写（canWriteWithoutMaterial=true），需求为 research_record
    const methodCh = chapter({ chapterId: "ch03", titleZh: "方法设计", responsibility: "method", ownsContributionIds: [METHOD_CONTRIBUTION.id] });
    const methodGaps = deriveChapterMaterialGaps({
      projectId: fx.projectId,
      mapping: mapping(fx.projectId, [methodCh]),
      missingChapters: [methodCh],
      contributions: [METHOD_CONTRIBUTION],
      factContext: factContext({ verified: [fact("F-v1", "0.5", "source_verified")] }),
    });
    expect(methodGaps[0]!.canWriteWithoutMaterial).toBe(true);
    expect(methodGaps[0]!.requiresExperiment).toBe(false);
    expect(methodGaps[0]!.requiredMaterials.map((item) => item.kind)).toEqual(["research_record"]);
  });

  it("2. 单篇论文窄范围：scopeConcerns → B 类 proposed_scope_gap，入账后仍为 proposed，永不自动确认", async () => {
    const fx = await newThesisFixture();
    const storyline: ThesisStoryline = {
      narrative: "单篇论文支撑一个贡献。",
      structure: "fragmented",
      relations: [],
      scopeConcerns: ["仅一篇已发表论文支撑一个方法贡献，难以构成学位论文所需的研究主线"],
      contributionsOrder: [METHOD_CONTRIBUTION.id],
    };
    const proposals = deriveScopeGapProposals({ projectId: fx.projectId, storyline, mapping: mapping(fx.projectId, []), factContext: factContext() });
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.gapType).toBe("proposed_scope_gap");
    expect(proposal.origin).toBe("storyline_scope_concern");
    expect(proposal.title.startsWith("研究范围建议 1：")).toBe(true);
    expect(proposal.chapterId).toBeUndefined();
    expect(proposal.requiresExperiment).toBe(false);
    expect(proposal.canWriteWithoutMaterial).toBe(true);
    expect(proposal.requiredMaterials).toEqual([{ kind: "author_confirmation", description: "作者确认是否扩展研究范围；确认后再生成具体材料需求" }]);
    expect(proposal.supportingEvidence).toEqual(["storyline.scopeConcerns[0]"]);

    const ledger = new MissingMaterialLedger(fx.projects);
    await ledger.upsertProposals(fx.projectId, proposals);
    const stored = await ledger.list(fx.projectId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe("proposed");
    expect(stored[0]!.decision).toBeUndefined();
    // B 类不阻断写作
    expect(await ledger.blockingGaps(fx.projectId)).toEqual([]);
    // 无 scopeConcerns → 空
    expect(deriveScopeGapProposals({ projectId: fx.projectId, storyline: { ...storyline, scopeConcerns: [] }, mapping: null, factContext: factContext() })).toEqual([]);
    expect(deriveScopeGapProposals({ projectId: fx.projectId, storyline: null, mapping: null, factContext: factContext() })).toEqual([]);
  });

  it("3. 材料充足：Planner 无缺材料章且无范围问题 → 零差距（无误报）", async () => {
    const fx = await newThesisFixture();
    const backed = contribution("c-exp000002", "experiment_result", "误差降低 75.37%", ["F-1"]);
    const ch = chapter({ chapterId: "ch05", titleZh: "实验与分析", responsibility: "experiment", ownsContributionIds: [backed.id], factIds: ["F-1"] });
    const context = factContext({ confirmed: [fact("F-1", "75.37%")] });
    const gaps = deriveChapterMaterialGaps({ projectId: fx.projectId, mapping: mapping(fx.projectId, [ch]), missingChapters: [], contributions: [backed], factContext: context });
    expect(gaps).toEqual([]);
    const storyline: ThesisStoryline = { narrative: "递进主线。", structure: "progressive", relations: [], contributionsOrder: [backed.id] };
    expect(deriveScopeGapProposals({ projectId: fx.projectId, storyline, mapping: mapping(fx.projectId, [ch]), factContext: context })).toEqual([]);
    expect(chaptersWithUsableFacts({ mapping: { chapters: [ch] }, contributions: [backed], facts: context.facts })).toEqual(new Set(["ch05"]));
    const ledger = new MissingMaterialLedger(fx.projects);
    expect(await ledger.upsertProposals(fx.projectId, [])).toEqual({ created: 0, unchanged: 0, refreshed: 0, staleMarked: 0 });
    expect(await ledger.list(fx.projectId)).toEqual([]);
  });
});

describe("M14.6 MissingMaterialService：有界模型提案", () => {
  const fingerprintBase = { outlineFingerprint: "outline-fp-1", sourceInputs: [{ inputId: INPUT_A.inputId, contentHash: INPUT_A.contentHash }] };

  it("4. 不断言未规划实验：relatedChapterId 不在映射中的提案被丢弃；模型输出无法把状态推到 proposed 之外", async () => {
    const fx = await newThesisFixture();
    const raw = JSON.stringify({
      proposals: [
        {
          title: "建议作者确认是否补充跨数据集泛化评估",
          description: "现有贡献只在单一数据集上报告结果。",
          whyInsufficient: "单数据集结果可能不足以支撑结论章的泛化性声明。",
          relatedChapterId: "ch05",
          requiredMaterials: [{ kind: "experiment_data", description: "若已有其他数据集实验，请提供评测记录" }],
          requiresExperiment: true,
          canWriteWithoutMaterial: true,
          status: "confirmed_missing",
          decision: "confirm_missing",
        },
        {
          title: "缺少消融实验章",
          description: "硕士论文通常需要消融实验。",
          relatedChapterId: "ch09-ablation",
          requiredMaterials: [],
        },
        { title: "", description: "无标题" },
        { title: "重复标题", description: "a" },
        { title: "重复标题", description: "b" },
      ],
    });
    const parsed = parseScopeGapProposals(raw, { chapterIds: new Set(["ch05"]), chapterTitles: new Map([["ch05", "实验与分析"]]), projectId: fx.projectId, fingerprintBase });
    expect(parsed.proposals).toHaveLength(2);
    expect(parsed.rejected).toHaveLength(3);
    expect(parsed.rejected.some((reason) => reason.includes("ch09-ablation"))).toBe(true);
    const first = parsed.proposals[0]!;
    expect(first.origin).toBe("model_proposal");
    expect(first.chapterId).toBe("ch05");
    expect(first.chapterTitleZh).toBe("实验与分析");
    expect(first.requiredMaterials.map((item) => item.kind)).toEqual(["experiment_data", "author_confirmation"]);
    expect((first as Record<string, unknown>)["status"]).toBeUndefined();
    expect((first as Record<string, unknown>)["decision"]).toBeUndefined();

    // 超过 6 条 → 截断并记录
    const many = JSON.stringify({ proposals: Array.from({ length: 8 }, (_, index) => ({ title: `建议 ${index}`, description: "d" })) });
    const capped = parseScopeGapProposals(many, { chapterIds: new Set(), projectId: fx.projectId, fingerprintBase });
    expect(capped.proposals).toHaveLength(6);
    expect(capped.rejected).toHaveLength(2);
    // 标题 ≤ 80
    const long = parseScopeGapProposals(JSON.stringify({ proposals: [{ title: "长".repeat(120), description: "d" }] }), { chapterIds: new Set(), projectId: fx.projectId, fingerprintBase });
    expect(long.proposals[0]!.title.length).toBeLessThanOrEqual(80);

    // 端到端：模型输出（带围栏与夹带状态）经 Service 并入账本后状态恒为 proposed
    const ledger = new MissingMaterialLedger(fx.projects);
    const { runtime, calls } = fakeRuntime(`\`\`\`json\n${raw}\n\`\`\``);
    const service = new MissingMaterialService({ runtime, agentId: "researcher", ledger, projects: fx.projects });
    const ch = experimentChapter();
    const result = await service.proposeScopeGaps(fx.projectId, {
      documentType: "硕士学位论文",
      storyline: null,
      chapters: [ch],
      contributions: [EXPERIMENT_CONTRIBUTION],
      inputs: [INPUT_A],
      language: "zh",
      outlineFingerprint: "outline-fp-1",
    });
    expect(result.taskId).toBe("t-1");
    expect(result.accepted.created).toBe(2);
    expect(result.rejected).toHaveLength(3);
    expect(calls[0]!.contextScope).toBe("thesis/missing-material");
    const stored = await ledger.list(fx.projectId);
    expect(stored.every((gap) => gap.status === "proposed" && gap.decision === undefined && gap.gapType === "proposed_scope_gap")).toBe(true);
    expect(await ledger.blockingGaps(fx.projectId)).toEqual([]);

    // prompt 纪律：含章 id 白名单与"不断言缺实验"约束
    const prompt = buildScopeGapProposalPrompt({ documentType: "硕士学位论文", storyline: null, chapters: [ch], contributions: [EXPERIMENT_CONTRIBUTION], inputs: [INPUT_A], language: "zh" });
    expect(prompt).toContain("ch05");
    expect(prompt).toContain("relatedChapterId 只能是");
    expect(prompt).toContain("不得把「作者缺少某个具体实验」当作事实断言");
    expect(prompt).toContain("不要假设固定的学位论文章节模板");

    // 非 JSON 输出 → 结构化错误（不静默吞掉）
    expect(() => parseScopeGapProposals("模型没有给 JSON", { chapterIds: new Set(), projectId: fx.projectId, fingerprintBase })).toThrow(/JSON/);
  });
});

describe("M14.6 MissingMaterialLedger：状态机与持久化", () => {
  async function seedExperimentGap(fx: Awaited<ReturnType<typeof newThesisFixture>>, ledger: MissingMaterialLedger, context = factContext()): Promise<MissingMaterialGapProposal> {
    const ch = experimentChapter();
    const gaps = deriveChapterMaterialGaps({ projectId: fx.projectId, mapping: mapping(fx.projectId, [ch]), missingChapters: [ch], contributions: [EXPERIMENT_CONTRIBUTION], factContext: context });
    await ledger.upsertProposals(fx.projectId, gaps);
    return gaps[0]!;
  }

  it("5. 作者补材料 → supplied（章仍缺材料时保持）；事实到位后 reevaluate → resolved/facts_available", async () => {
    const fx = await newThesisFixture();
    const ledger = new MissingMaterialLedger(fx.projects);
    const gap = await seedExperimentGap(fx, ledger);
    expect(await ledger.blockingGaps(fx.projectId)).toHaveLength(1);

    const supplied = await ledger.applyDecision(fx.projectId, { gapId: gap.gapId, decision: "supply_experiment_data", decisionId: "D-supply-1", rationale: "已上传实验记录" });
    expect(supplied.status).toBe("supplied");
    expect(supplied.decision).toBe("supply_experiment_data");
    expect(supplied.decisionRationale).toBe("已上传实验记录");
    expect(supplied.resolution).toBeUndefined();
    expect(supplied.requiredMaterials).toEqual(gap.requiredMaterials);
    expect(await ledger.blockingGaps(fx.projectId)).toEqual([]);

    // 同 decisionId 幂等
    const replay = await ledger.applyDecision(fx.projectId, { gapId: gap.gapId, decision: "reject", decisionId: "D-supply-1" });
    expect(replay.status).toBe("supplied");

    // 材料已补但事实尚未确认：章仍缺材料 → 保持 supplied
    const still = await ledger.reevaluate(fx.projectId, { chaptersWithUsableFacts: new Set(), currentMissingChapterIds: new Set(["ch05"]) });
    expect(still).toEqual({ resolved: 0, unchanged: 1 });
    expect((await ledger.get(fx.projectId, gap.gapId))!.status).toBe("supplied");

    // 事实确认后 Planner 不再判缺 → resolved
    const done = await ledger.reevaluate(fx.projectId, { chaptersWithUsableFacts: new Set(["ch05"]), currentMissingChapterIds: new Set() });
    expect(done).toEqual({ resolved: 1, unchanged: 0 });
    const resolved = (await ledger.get(fx.projectId, gap.gapId))!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("facts_available");
    expect(resolved.decisionId).toBe("D-supply-1");

    // 未知 gapId / 非法决定 → INVALID_REQUEST
    await expect(ledger.applyDecision(fx.projectId, { gapId: "g-nope", decision: "reject", decisionId: "D-x" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(ledger.applyDecision(fx.projectId, { gapId: gap.gapId, decision: "approve" as never, decisionId: "D-y" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("6. 输入版本变化（contentHash 不同）→ 已决定的差距标 stale；仅 proposed 的直接刷新", async () => {
    const fx = await newThesisFixture();
    const ledger = new MissingMaterialLedger(fx.projects);
    const ch = experimentChapter();
    const methodCh = chapter({ chapterId: "ch03", titleZh: "方法设计", responsibility: "method", ownsContributionIds: [METHOD_CONTRIBUTION.id] });
    const derive = (context: ReturnType<typeof factContext>): MissingMaterialGapProposal[] =>
      deriveChapterMaterialGaps({ projectId: fx.projectId, mapping: mapping(fx.projectId, [ch, methodCh]), missingChapters: [ch, methodCh], contributions: [EXPERIMENT_CONTRIBUTION, METHOD_CONTRIBUTION], factContext: context });
    const v1 = derive(factContext());
    expect(await ledger.upsertProposals(fx.projectId, v1)).toEqual({ created: 2, unchanged: 0, refreshed: 0, staleMarked: 0 });
    const experimentGap = v1.find((gap) => gap.chapterId === "ch05")!;
    await ledger.applyDecision(fx.projectId, { gapId: experimentGap.gapId, decision: "confirm_missing", decisionId: "D-confirm-1" });

    const v2 = derive(factContext({ inputs: [{ ...INPUT_A, contentHash: "hashA-v2" }] }));
    expect(v2.map((gap) => gap.gapId)).toEqual(v1.map((gap) => gap.gapId));
    expect(v2[0]!.sourceFingerprint).not.toBe(v1[0]!.sourceFingerprint);
    expect(await ledger.upsertProposals(fx.projectId, v2)).toEqual({ created: 0, unchanged: 0, refreshed: 1, staleMarked: 1 });

    const stored = await ledger.list(fx.projectId);
    const decided = stored.find((gap) => gap.chapterId === "ch05")!;
    expect(decided.status).toBe("confirmed_missing");
    expect(decided.decisionId).toBe("D-confirm-1");
    expect(decided.stale).toBeDefined();
    expect(decided.stale!.reason).toContain("重新评估");
    const refreshed = stored.find((gap) => gap.chapterId === "ch03")!;
    expect(refreshed.status).toBe("proposed");
    expect(refreshed.stale).toBeUndefined();
    expect(refreshed.sourceFingerprint).toBe(v2.find((gap) => gap.chapterId === "ch03")!.sourceFingerprint);

    // 再扫一次同版本：stale 不重复标记（since 保留）
    const since = decided.stale!.since;
    expect(await ledger.upsertProposals(fx.projectId, v2)).toEqual({ created: 0, unchanged: 2, refreshed: 0, staleMarked: 0 });
    expect((await ledger.get(fx.projectId, experimentGap.gapId))!.stale).toEqual({ since, reason: decided.stale!.reason });
    // 新决定清除 stale
    const redecided = await ledger.applyDecision(fx.projectId, { gapId: experimentGap.gapId, decision: "write_as_limitation", decisionId: "D-confirm-2" });
    expect(redecided.stale).toBeUndefined();
    expect(redecided.status).toBe("confirmed_missing");
    expect(redecided.resolution).toBe("limitation");
  });

  it("7. 重复扫描幂等：gapId 稳定，第二次 created=0，文件内容除 updatedAt/lastEvaluatedAt 外不变", async () => {
    let tick = 0;
    const fx = await newThesisFixture();
    const ledger = new MissingMaterialLedger(fx.projects, { now: () => new Date(Date.UTC(2026, 9, 16, 0, 0, tick++)) });
    const first = await seedExperimentGap(fx, ledger);
    const before = JSON.parse(await readFile(ledger.filePath(fx.projectId), "utf8")) as MissingMaterialLedgerFile;
    const ch = experimentChapter();
    const second = deriveChapterMaterialGaps({ projectId: fx.projectId, mapping: mapping(fx.projectId, [ch]), missingChapters: [ch], contributions: [EXPERIMENT_CONTRIBUTION], factContext: factContext() });
    expect(second[0]!.gapId).toBe(first.gapId);
    expect(second[0]!.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(await ledger.upsertProposals(fx.projectId, second)).toEqual({ created: 0, unchanged: 1, refreshed: 0, staleMarked: 0 });
    const after = JSON.parse(await readFile(ledger.filePath(fx.projectId), "utf8")) as MissingMaterialLedgerFile;
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect({ ...after, updatedAt: undefined, lastEvaluatedAt: undefined }).toEqual({ ...before, updatedAt: undefined, lastEvaluatedAt: undefined });
  });

  it("8. 决定跨重开持久化：新账本实例（同 root）读到同一状态；损坏文件拒绝读写", async () => {
    const fx = await newThesisFixture();
    const ledger = new MissingMaterialLedger(fx.projects);
    const gap = await seedExperimentGap(fx, ledger);
    await ledger.applyDecision(fx.projectId, { gapId: gap.gapId, decision: "defer_chapter", decisionId: "D-defer-1", rationale: "下学期补实验" });
    const reopened = new MissingMaterialLedger(fx.reopen().projects);
    const stored = (await reopened.get(fx.projectId, gap.gapId))!;
    expect(stored.status).toBe("deferred");
    expect(stored.resolution).toBe("chapter_deferred");
    expect(stored.decisionId).toBe("D-defer-1");
    expect(stored.decisionRationale).toBe("下学期补实验");
    expect(await reopened.blockingGaps(fx.projectId)).toEqual([]);
    // 不存在的文件 → 空账本；损坏 → STAGE_CONTRACT_VIOLATION
    const { writeFile } = await import("node:fs/promises");
    await writeFile(reopened.filePath(fx.projectId), "{not json", "utf8");
    await expect(reopened.list(fx.projectId)).rejects.toMatchObject({ code: "STAGE_CONTRACT_VIOLATION" });
  });

  it("9. blockingGaps 排除 resolved / deferred / rejected / 有 resolution 的与 canWriteWithoutMaterial 的差距", async () => {
    const fx = await newThesisFixture();
    const ledger = new MissingMaterialLedger(fx.projects);
    const chapters = [
      chapter({ chapterId: "ch04", titleZh: "实验一", responsibility: "experiment", ownsContributionIds: [EXPERIMENT_CONTRIBUTION.id] }),
      chapter({ chapterId: "ch05", titleZh: "实验二", responsibility: "experiment", ownsContributionIds: [EXPERIMENT_CONTRIBUTION.id] }),
      chapter({ chapterId: "ch06", titleZh: "实验三", responsibility: "experiment", ownsContributionIds: [EXPERIMENT_CONTRIBUTION.id] }),
      chapter({ chapterId: "ch07", titleZh: "实验四", responsibility: "experiment", ownsContributionIds: [EXPERIMENT_CONTRIBUTION.id] }),
      chapter({ chapterId: "ch08", titleZh: "实验五", responsibility: "experiment", ownsContributionIds: [EXPERIMENT_CONTRIBUTION.id] }),
      chapter({ chapterId: "ch03", titleZh: "方法设计", responsibility: "method", ownsContributionIds: [METHOD_CONTRIBUTION.id] }),
    ];
    const gaps = deriveChapterMaterialGaps({ projectId: fx.projectId, mapping: mapping(fx.projectId, chapters), missingChapters: chapters, contributions: [EXPERIMENT_CONTRIBUTION, METHOD_CONTRIBUTION], factContext: factContext() });
    const storyline: ThesisStoryline = { narrative: "n", structure: "fragmented", relations: [], scopeConcerns: ["范围偏窄"], contributionsOrder: [] };
    const scope = deriveScopeGapProposals({ projectId: fx.projectId, storyline, mapping: mapping(fx.projectId, chapters), factContext: factContext() });
    await ledger.upsertProposals(fx.projectId, [...gaps, ...scope]);
    const byChapter = (chapterId: string): string => gaps.find((gap) => gap.chapterId === chapterId)!.gapId;
    // ch04 proposed（阻断）；ch05 confirm_missing（阻断）；ch06 write_as_limitation（不阻断）；
    // ch07 defer（不阻断）；ch08 reject（不阻断）；ch03 方法章 canWriteWithoutMaterial（不阻断）；B 类不阻断
    await ledger.applyDecision(fx.projectId, { gapId: byChapter("ch05"), decision: "confirm_missing", decisionId: "D1" });
    await ledger.applyDecision(fx.projectId, { gapId: byChapter("ch06"), decision: "write_as_limitation", decisionId: "D2" });
    await ledger.applyDecision(fx.projectId, { gapId: byChapter("ch07"), decision: "defer_chapter", decisionId: "D3" });
    await ledger.applyDecision(fx.projectId, { gapId: byChapter("ch08"), decision: "reject", decisionId: "D4" });
    const blocking = await ledger.blockingGaps(fx.projectId);
    expect(blocking.map((gap) => gap.chapterId).sort()).toEqual(["ch04", "ch05"]);
    // ch04 事实到位 → resolved → 不再阻断
    await ledger.reevaluate(fx.projectId, { chaptersWithUsableFacts: new Set(["ch04"]), currentMissingChapterIds: new Set(["ch05"]) });
    expect((await ledger.blockingGaps(fx.projectId)).map((gap) => gap.chapterId)).toEqual(["ch05"]);
    expect((await ledger.list(fx.projectId)).filter((gap) => gap.status === "rejected").map((gap) => gap.resolution)).toEqual(["scope_rejected"]);
  });
});
