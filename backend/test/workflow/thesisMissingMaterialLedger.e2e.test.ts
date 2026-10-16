/**
 * M14.6 — MissingMaterialLedger（research/missing-material-ledger.json）E2E。
 *
 *   1. 缺材料路径（复刻 thesis.e2e 路径 C：表事实存在但不做 fact_confirmation）：
 *      thesis.evidence_supply 同步台账 → hitl.author_decision 载荷携带 materialGaps（A 类 proposed）
 *      → GET /thesis/missing-materials 同一视图 → resume 带 gapId 的 write_as_limitation →
 *      author-decisions.jsonl 有 missing_material_decision + 镜像 writing_pause → 台账
 *      confirmed_missing / limitation → 该章以限制口径写出 → run 完成。
 *   2. HTTP 决定端点（B 类 proposed_scope_gap 直接种子）：reject → 200 / rejected；重复提交状态不变；
 *      非法决定 → 4xx。
 *   3. 幂等：evidence_supply 结果 materialGaps.total ≥ 1；同提案再 upsert → created=0；GET 两次长度不变。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ParsedBlock, ParsedDocument } from "../../src/ingestion/types.js";
import { createScriptedRuntime, THESIS_CONTRIBUTION_QUOTE } from "../../src/runtime/scriptedRuntime.js";
import { missingMaterialFingerprint, missingMaterialGapId } from "../../src/thesis/MissingMaterialLedger.js";
import type { MissingMaterialGap, MissingMaterialGapProposal } from "../../src/thesis/missingMaterialTypes.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { tableBlock, textBlock } from "../thesis/fixtures.js";

type RunView = {
  status: string;
  projectId?: string;
  awaiting?: { stageId: string; payload?: Record<string, unknown> };
  error?: { message: string };
  completedStages?: string[];
  stageResults?: Record<string, Record<string, unknown>>;
};

type MaterialGapView = {
  gapId: string;
  gapType: string;
  status: string;
  chapterId?: string;
  requiresExperiment: boolean;
  canWriteWithoutMaterial: boolean;
};

/** 无冲突正文（含 scripted 贡献锚点句 + 消融表）——与 thesis.e2e paperBlocks(true) 同形 */
function paperBlocks(): ParsedBlock[] {
  return [
    textBlock("B0001", 1, `研究背景与动机。${THESIS_CONTRIBUTION_QUOTE}`),
    textBlock("B0002", 2, "方法细节与实验设置。我们在 DAVSOD 与 UBFC 数据集上训练。"),
    tableBlock("B0003", 3, ["Method", "S ↑", "MAE ↓"], [["Ours", "0.724", "0.092"], ["Base", "0.667", "0.132"]], "表1 消融实验"),
  ];
}

async function seedResearchInput(stack: TestStack, projectId: string, fileName: string, title: string): Promise<string> {
  const { source } = await stack.stack.sources.add(projectId, {
    fileName,
    content: Buffer.from(`%PDF-1.5\n${fileName}-content`, "utf8"),
  });
  const blocks = paperBlocks();
  const document: ParsedDocument = {
    schemaVersion: 1,
    sourceId: source.sourceId,
    fileName,
    storedFileName: fileName,
    kind: "pdf",
    mimeType: "application/pdf",
    parser: { id: "test-fixture", version: "1" },
    parseMode: "structured",
    status: "ok",
    pageCount: 3,
    blocks,
    counts: { text: blocks.filter((block) => block.type === "text").length } as ParsedDocument["counts"],
    notes: [],
    contentHash: source.contentHash!,
    parsedAt: new Date().toISOString(),
  };
  await stack.stack.parsedDocuments.save(projectId, document);
  const result = await stack.stack.researchInputs.register(projectId, { sourceId: source.sourceId, inputType: "published_paper", title }, { ensureParsed: false });
  await stack.stack.researchInputs.registry.refreshParse(projectId, result.input.inputId);
  return result.input.inputId;
}

async function getRun(stack: TestStack, runId: string): Promise<RunView> {
  const response = await stack.request("GET", `/api/runs/${runId}`);
  expect(response.status).toBe(200);
  return response.body["run"] as RunView;
}

async function createThesisProject(stack: TestStack, title: string): Promise<string> {
  const response = await stack.request("POST", "/api/projects", { title, documentType: "master_thesis" });
  expect(response.status).toBe(201);
  return (response.body["project"] as { id: string }).id;
}

/** scope_and_version 标准序列（不确认事实）：include → allow_unpublished → confirm_contribution → approve */
function scopeDecision(payload: Record<string, unknown> | undefined): { decision: string; payload: Record<string, unknown> } {
  const proposed = (payload?.["inputs"] as { proposed?: Array<{ inputId: string }> } | undefined)?.proposed ?? [];
  if (proposed.length > 0) return { decision: "include", payload: { inputId: proposed[0]!.inputId, actorKind: "test_fixture" } };
  const pending = (payload?.["pendingDecisions"] as Array<{ type: string; subject: string }> | undefined) ?? [];
  const unpublished = pending.find((item) => item.type === "unpublished_material_policy");
  if (unpublished !== undefined) return { decision: "allow_unpublished", payload: { inputId: unpublished.subject, actorKind: "test_fixture" } };
  const contributions = (payload?.["contributions"] as Array<{ id: string; status: string }> | undefined) ?? [];
  const unconfirmed = contributions.filter((item) => item.status === "proposed").map((item) => item.id);
  if (unconfirmed.length > 0) return { decision: "confirm_contribution", payload: { contributionIds: unconfirmed, actorKind: "test_fixture" } };
  return { decision: "approve", payload: { actorKind: "test_fixture" } };
}

/** 轮询到指定 HITL（途中 scope / outline 自动决策） */
async function pollUntilAuthorDecision(stack: TestStack, runId: string, timeoutMs: number): Promise<RunView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(stack, runId);
    if (run.status === "awaiting_input" && run.awaiting !== undefined) {
      const { stageId, payload } = run.awaiting;
      if (stageId === "hitl.author_decision") return run;
      let outcome: { decision: string; payload: Record<string, unknown> };
      if (stageId === "hitl.scope_and_version") outcome = scopeDecision(payload);
      else if (stageId === "hitl.outline_confirm") outcome = { decision: "approve", payload: { actorKind: "test_fixture" } };
      else throw new Error(`到达 hitl.author_decision 前遇到未脚本化 HITL：${stageId}`);
      const resume = await stack.request("POST", `/api/runs/${runId}/resume`, outcome);
      if (resume.status >= 300) throw new Error(`resume 失败（${stageId}/${outcome.decision}）：${JSON.stringify(resume.body).slice(0, 300)}`);
      continue;
    }
    if (run.status !== "running") throw new Error(`run 未到 hitl.author_decision 即终止：${run.status} ${run.error?.message ?? ""}`);
    if (Date.now() > deadline) throw new Error("等待 hitl.author_decision 超时");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 驱动到终态：后续 author_decision 优先用 gapId（A 类 proposed）→ 退回 subject；溢出 accept_draft；润色 skip */
async function driveToTerminal(stack: TestStack, runId: string, timeoutMs: number): Promise<RunView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(stack, runId);
    if (run.status === "awaiting_input" && run.awaiting !== undefined) {
      const { stageId, payload } = run.awaiting;
      let outcome: { decision: string; payload: Record<string, unknown> } = { decision: "approve", payload: { actorKind: "test_fixture" } };
      if (stageId === "hitl.scope_and_version") outcome = scopeDecision(payload);
      else if (stageId === "hitl.author_decision") {
        const missing = (payload?.["missingChapters"] as Array<{ chapterId: string }> | undefined) ?? [];
        const gaps = (payload?.["materialGaps"] as MaterialGapView[] | undefined) ?? [];
        const openGap = gaps.find((gap) => gap.gapType === "planned_chapter_material" && gap.status === "proposed" && missing.some((chapter) => chapter.chapterId === gap.chapterId));
        if (openGap !== undefined) outcome = { decision: "write_as_limitation", payload: { gapId: openGap.gapId, actorKind: "test_fixture" } };
        else if (missing.length > 0) outcome = { decision: "write_as_limitation", payload: { subject: missing[0]!.chapterId, actorKind: "test_fixture" } };
      } else if (stageId === "hitl.revision_overflow" || stageId === "hitl.revision_stalled") outcome = { decision: "accept_draft", payload: { actorKind: "test_fixture" } };
      else if (stageId === "hitl.style_polish") outcome = { decision: "skip", payload: { actorKind: "test_fixture" } };
      const resume = await stack.request("POST", `/api/runs/${runId}/resume`, outcome);
      if (resume.status >= 300) throw new Error(`resume 失败（${stageId}/${outcome.decision}）：${JSON.stringify(resume.body).slice(0, 300)}`);
      continue;
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
    if (Date.now() > deadline) throw new Error(`驱动终态超时（${run.status}）`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function readDecisions(stack: TestStack, projectId: string): Promise<Array<{ payload: Record<string, unknown> }>> {
  const raw = await readFile(join(stack.store.projectDir(projectId), "research", "author-decisions.jsonl"), "utf8");
  return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as { payload: Record<string, unknown> });
}

describe("M14.6 MissingMaterialLedger E2E", () => {
  let stack: TestStack;
  // 场景 1 的上下文供场景 3 复用（幂等断言）
  let completedProjectId = "";
  let completedRun: RunView | null = null;

  beforeAll(async () => {
    const scripted = createScriptedRuntime({ reviewSequence: ["pass"] });
    stack = await startTestStack(scripted.runtime, {
      search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2_000 },
    });
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it("缺材料路径：materialGaps 提案 → GET 同视图 → gapId write_as_limitation → 镜像 writing_pause → 限制口径写出", { timeout: 240_000 }, async () => {
    const projectId = await createThesisProject(stack, "缺材料台账学位论文");
    await seedResearchInput(stack, projectId, "ledger-sparse.pdf", "方法论文（无事实确认）");
    const start = await stack.request("POST", `/api/projects/${projectId}/workflows`, {});
    expect(start.status).toBe(202);
    const runId = start.body["runId"] as string;

    // 到达 hitl.author_decision：载荷携带 missingChapters + materialGaps
    const awaiting = await pollUntilAuthorDecision(stack, runId, 120_000);
    const payload = awaiting.awaiting!.payload ?? {};
    const missing = (payload["missingChapters"] as Array<{ chapterId: string; responsibility: string }> | undefined) ?? [];
    expect(missing.length).toBeGreaterThan(0);
    const gaps = (payload["materialGaps"] as MaterialGapView[] | undefined) ?? [];
    const experimentChapter = missing.find((chapter) => chapter.responsibility === "experiment");
    expect(experimentChapter, "scripted 大纲（≥2 贡献）应产出 ch04 实验章且其无可用事实").toBeDefined();
    const gap = gaps.find((item) => item.gapType === "planned_chapter_material" && item.chapterId === experimentChapter!.chapterId);
    expect(gap, "实验章应有 A 类 planned_chapter_material 缺口").toBeDefined();
    expect(gap!.status).toBe("proposed");
    expect(gap!.requiresExperiment).toBe(true);
    expect(gap!.canWriteWithoutMaterial).toBe(false);
    // 每个缺材料章都有 proposed 的 A 类缺口
    for (const chapter of missing) {
      expect(gaps.some((item) => item.gapType === "planned_chapter_material" && item.chapterId === chapter.chapterId && item.status === "proposed")).toBe(true);
    }

    // HTTP 视图与台账文件
    const listed = await stack.request("GET", `/api/projects/${projectId}/thesis/missing-materials`);
    expect(listed.status).toBe(200);
    const ledgerGaps = (listed.body["ledger"] as { gaps: MissingMaterialGap[] }).gaps;
    const listedGap = ledgerGaps.find((item) => item.gapId === gap!.gapId);
    expect(listedGap).toBeDefined();
    expect(listedGap!.status).toBe("proposed");
    expect(listedGap!.chapterId).toBe(experimentChapter!.chapterId);
    const ledgerFile = JSON.parse(await readFile(join(stack.store.projectDir(projectId), "research", "missing-material-ledger.json"), "utf8")) as { schemaVersion: number; gaps: MissingMaterialGap[] };
    expect(ledgerFile.schemaVersion).toBe(1);
    expect(ledgerFile.gaps.some((item) => item.gapId === gap!.gapId)).toBe(true);

    // 带 gapId 的 write_as_limitation → missing_material_decision + 镜像 writing_pause
    const resume = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "write_as_limitation",
      payload: { gapId: gap!.gapId, actorKind: "test_fixture" },
    });
    expect(resume.status).toBeLessThan(300);

    const run = await driveToTerminal(stack, runId, 200_000);
    expect(run.status, run.error?.message ?? "").toBe("completed");
    expect(run.completedStages).toContain("hitl.author_decision");

    const decisions = await readDecisions(stack, projectId);
    const gapDecision = decisions.find((item) => item.payload["type"] === "missing_material_decision" && item.payload["gapId"] === gap!.gapId);
    expect(gapDecision).toBeDefined();
    expect(gapDecision!.payload["decision"]).toBe("write_as_limitation");
    const mirrored = decisions.find((item) => item.payload["type"] === "writing_pause" && item.payload["subject"] === experimentChapter!.chapterId);
    expect(mirrored, "带 gapId 的决定必须镜像为同章 writing_pause").toBeDefined();
    expect(mirrored!.payload["decision"]).toBe("write_as_limitation");

    // 台账：confirmed_missing / limitation
    const finalGap = await stack.stack.missingMaterials.get(projectId, gap!.gapId);
    expect(finalGap).toBeDefined();
    expect(finalGap!.status).toBe("confirmed_missing");
    expect(finalGap!.resolution).toBe("limitation");
    expect(finalGap!.decision).toBe("write_as_limitation");

    // 写作：该章以限制口径写出
    const limitationChapters = run.stageResults?.["writing.sections"]?.["chaptersWithLimitationMode"] as string[] | undefined;
    expect(limitationChapters).toContain(experimentChapter!.chapterId);

    // evidence_supply 结果已带台账计数
    const supply = run.stageResults?.["thesis.evidence_supply"]?.["materialGaps"] as { total: number; created: number } | undefined;
    expect(supply).toBeDefined();
    expect(supply!.total).toBeGreaterThanOrEqual(1);

    completedProjectId = projectId;
    completedRun = run;
  });

  it("HTTP 决定端点：B 类 proposed_scope_gap reject → rejected；重复提交状态不变；非法决定 4xx", { timeout: 60_000 }, async () => {
    const projectId = await createThesisProject(stack, "缺材料台账（HTTP 决定）");
    const title = "研究范围建议 1：单篇论文仅支撑一个贡献";
    const proposal: MissingMaterialGapProposal = {
      gapId: missingMaterialGapId("proposed_scope_gap", undefined, title),
      gapType: "proposed_scope_gap",
      origin: "storyline_scope_concern",
      contributionIds: [],
      sourceInputIds: [],
      title,
      description: "单篇论文仅支撑一个贡献，研究范围可能偏窄。",
      whyInsufficient: "Planner 在主线规划时自述研究范围偏窄；这是建议，不是已确认缺失。",
      supportingEvidence: ["storyline.scopeConcerns[0]"],
      requiredMaterials: [{ kind: "author_confirmation", description: "作者确认是否扩展研究范围" }],
      canWriteWithoutMaterial: true,
      requiresExperiment: false,
      sourceFingerprint: missingMaterialFingerprint({ gapType: "proposed_scope_gap", contributionIds: [], sourceInputs: [], outlineFingerprint: "", content: title }),
    };
    const upsert = await stack.stack.missingMaterials.upsertProposals(projectId, [proposal]);
    expect(upsert.created).toBe(1);

    const first = await stack.request("POST", `/api/projects/${projectId}/thesis/missing-materials/${proposal.gapId}/decision`, {
      decision: "reject",
      actor: { kind: "test_fixture" },
    });
    expect(first.status).toBe(200);
    expect((first.body["gap"] as MissingMaterialGap).status).toBe("rejected");
    expect((first.body["gap"] as MissingMaterialGap).resolution).toBe("scope_rejected");
    expect(first.body["duplicate"]).toBe(false);
    expect(typeof first.body["decisionId"]).toBe("string");

    const second = await stack.request("POST", `/api/projects/${projectId}/thesis/missing-materials/${proposal.gapId}/decision`, {
      decision: "reject",
      actor: { kind: "test_fixture" },
    });
    expect(second.status).toBe(200);
    expect((second.body["gap"] as MissingMaterialGap).status).toBe("rejected");

    const invalid = await stack.request("POST", `/api/projects/${projectId}/thesis/missing-materials/${proposal.gapId}/decision`, {
      decision: "fabricate_numbers",
      actor: { kind: "test_fixture" },
    });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(invalid.status).toBeLessThan(500);

    const listed = await stack.request("GET", `/api/projects/${projectId}/thesis/missing-materials`);
    expect(listed.status).toBe(200);
    const gaps = (listed.body["ledger"] as { gaps: MissingMaterialGap[] }).gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.status).toBe("rejected");
  });

  it("幂等：同提案再 upsert created=0；GET 两次长度不变", { timeout: 60_000 }, async () => {
    expect(completedProjectId, "依赖场景 1 完成").not.toBe("");
    const before = await stack.stack.missingMaterials.list(completedProjectId);
    expect(before.length).toBeGreaterThanOrEqual(1);
    const proposals: MissingMaterialGapProposal[] = before.map((gap) => ({
      gapId: gap.gapId,
      gapType: gap.gapType,
      origin: gap.origin,
      ...(gap.chapterId !== undefined ? { chapterId: gap.chapterId } : {}),
      ...(gap.chapterTitleZh !== undefined ? { chapterTitleZh: gap.chapterTitleZh } : {}),
      contributionIds: gap.contributionIds,
      sourceInputIds: gap.sourceInputIds,
      title: gap.title,
      description: gap.description,
      whyInsufficient: gap.whyInsufficient,
      supportingEvidence: gap.supportingEvidence,
      requiredMaterials: gap.requiredMaterials,
      canWriteWithoutMaterial: gap.canWriteWithoutMaterial,
      requiresExperiment: gap.requiresExperiment,
      sourceFingerprint: gap.sourceFingerprint,
    }));
    const again = await stack.stack.missingMaterials.upsertProposals(completedProjectId, proposals);
    expect(again.created).toBe(0);
    expect(again.unchanged).toBe(before.length);
    expect(again.staleMarked).toBe(0);

    const first = await stack.request("GET", `/api/projects/${completedProjectId}/thesis/missing-materials`);
    const second = await stack.request("GET", `/api/projects/${completedProjectId}/thesis/missing-materials`);
    const firstGaps = (first.body["ledger"] as { gaps: MissingMaterialGap[] }).gaps;
    const secondGaps = (second.body["ledger"] as { gaps: MissingMaterialGap[] }).gaps;
    expect(secondGaps.length).toBe(firstGaps.length);
    expect(secondGaps.map((gap) => `${gap.gapId}:${gap.status}`).sort()).toEqual(firstGaps.map((gap) => `${gap.gapId}:${gap.status}`).sort());
    // 已决定的缺口状态不被重扫覆盖
    for (const gap of before) {
      const after = secondGaps.find((item) => item.gapId === gap.gapId);
      expect(after?.status).toBe(gap.status);
    }
    expect((completedRun?.stageResults?.["thesis.evidence_supply"]?.["materialGaps"] as { total: number } | undefined)?.total).toBeGreaterThanOrEqual(1);
  });
});
