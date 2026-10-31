/**
 * M15.17 — 审计差距 → 修订闭环的工作流集成测试（scripted 模型，零真实网络）：
 *
 * 产品路径：PDF 导入（goal=improvement）→ run 推进到 hitl.research_plan 暂停
 *（import.parse 已确定性重建可编辑稿；review.run 已提交 baseline 修订）
 * → 写入证据审计工件 → POST revision-plan（确定性分类 + quote 投影到重建章节）
 * → POST decide（可改写项 → pending 派发指令；需实验项 → AUTHOR_DECISION 永不派发）
 * → 恢复 run（plan.improvement → hitl.plan_confirm → revision.apply 真实派发）
 * → 完成后：可改写指令 handled（Writer applied + 目标真实变化）；需实验指令
 *   未被派发（authorOwnedComments 过滤，statusNote 保留）；修订号前进；
 * → POST reassess：逐项闭环（VALIDATED_FIXED / NEEDS_AUTHOR_DECISION）。
 *
 * 守卫回归：target_audit 指令的执行同样经过 patch / 事实 / 引用守卫
 *（scripted Writer 镜像真实纪律：保留 \cite 与数学环境）。
 */

import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import { scriptedIdeaRuntime, startTestStack, pollRunUntilAwaiting, type TestStack } from "../helpers/testStack.js";
import { sha256Hex } from "../../src/util/hash.js";

vi.setConfig({ testTimeout: 60_000 });

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

/** ≥3 个正文节（重建门槛）+ References；quote 锚 = Method 首句 */
const CLAIM_QUOTE = "The fusion module combines hierarchical semantic features across stages.";
const EXPERIMENT_CLAIM = "Experiments on two public benchmarks validate the gains.";

function sampleExtraction(): RawPdfExtraction {
  return {
    ok: true,
    parser: { id: "fake", version: "1" },
    pageCount: 5,
    title: "Hierarchical Semantic Fusion for Detection",
    abstract: "We propose a hierarchical fusion detector.",
    toc: [
      [1, "Introduction", 1],
      [1, "Method", 2],
      [1, "Experiments", 3],
      [1, "Conclusion", 4],
      [1, "References", 5],
    ] as Array<[number, string, number]>,
    blocks: [
      { page: 1, text: "Introduction describing the task and contributions. " + "a".repeat(90) },
      { page: 2, text: `${CLAIM_QUOTE} The design keeps cost low. ` + "b".repeat(30) },
      { page: 3, text: `${EXPERIMENT_CLAIM} Reported on Total-Text. ` + "c".repeat(30) },
      { page: 4, text: "Conclusion summarizing the method and future work. " + "d".repeat(30) },
      { page: 5, text: "[1] Liao M. Real-time scene text detection with differentiable binarization. 2020." },
      { page: 5, text: "[2] Liao M. DBNet v2. 2023." },
    ],
    totalChars: 900,
    notes: [],
  };
}

function fakeParser(extraction: () => RawPdfExtraction): PdfParser {
  return {
    id: "fake",
    async parseFile() {
      return extraction();
    },
    async checkAvailability() {
      return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
    },
  };
}

const PDF_BYTES = Buffer.from("%PDF-1.5\nfake content for audit revision workflow test\n");

/** 与 ContributionAuditService 同构的最小审计工件（两项 gap：可改写 + 需实验） */
async function writeAuditArtifact(
  stack: TestStack,
  projectId: string,
  manuscriptRevision: number,
): Promise<void> {
  const document = await stack.stack.paperStore.loadDocument(projectId);
  expect(document).not.toBeNull();
  const manuscriptSha256 = sha256Hex(document!.chunks.map((chunk) => chunk.text).join("\n\n")).slice(0, 16);
  const artifact = {
    schemaVersion: 1,
    venueId: "cjig",
    documentType: "journal_article",
    promptVersion: "m1514-caudit-v1",
    evaluatedAt: "2026-10-31T08:00:00.000Z",
    manuscriptRevision,
    priorWork: { cutoffDate: "2026-10-31", poolFingerprint: "poolfp0000000000", poolSize: 1, queriesUsed: [], candidates: [] },
    inventory: [
      {
        contributionId: "C1",
        claimQuote: CLAIM_QUOTE,
        claimType: "technical_idea",
        sectionId: "SEC02",
        supportLocations: [{ sectionId: "SEC03", kind: "experiment", quote: EXPERIMENT_CLAIM, verified: true }],
        supportStatus: "located",
        anchorVerified: true,
      },
      {
        contributionId: "C2",
        claimQuote: EXPERIMENT_CLAIM,
        claimType: "performance_advantage",
        sectionId: "SEC03",
        supportLocations: [],
        supportStatus: "missing",
        anchorVerified: true,
      },
    ],
    comparisons: [
      {
        contributionId: "C1",
        nearestPriorWorks: [
          { candidateId: "P01", title: "Real-time scene text detection with differentiable binarization", year: 2020, doi: "10.1609/aaai.v34i07.6812", sourceLevel: "pool_abstract", resolvesToPool: true },
        ],
        commonMechanism: "learnable post-processing",
        substantiveDifference: "hierarchical fusion across stages",
        differenceBasis: "abstract",
        completedVerification: "comparison on benchmarks",
        missingVerification: "ablation of the fusion",
        status: "EVIDENCE_GAP",
      },
      {
        contributionId: "C2",
        nearestPriorWorks: [],
        commonMechanism: "",
        substantiveDifference: "",
        differenceBasis: "none",
        completedVerification: "",
        missingVerification: "variance and ablation missing",
        status: "EVIDENCE_GAP",
      },
    ],
    gapPlan: [
      {
        contributionId: "C1",
        gap: "前后不一致：引言声称层级融合低开销但方法节未收敛表述",
        actionType: "can_rewrite_from_existing_evidence",
        status: "proposed",
      },
      {
        contributionId: "C2",
        gap: "性能增益缺少消融与方差报告",
        actionType: "requires_real_experiment_or_author_input",
        experimentPlan: { purpose: "补消融验证融合贡献", baselines: "去融合变体", metrics: "F1" },
        status: "author_decision",
      },
    ],
    findings: [],
    coverage: { sectionsTotal: 5, sectionsIndexed: 5, sectionsIncludedFullText: 5, manuscriptCharsTotal: 900, manuscriptCharsIncluded: 900, truncations: [] },
    guards: { anchorFailures: 0, unresolvedPriorWorkRefs: 0, cutoffViolations: 0, statusRuleViolations: 0, droppedFindings: 0, priorQuoteReplayFailures: 0, fulltextBasisDowngrades: 0 },
    inputFingerprint: { manuscriptSha256, poolFingerprint: "poolfp0000000000", promptVersion: "m1514-caudit-v1", documentType: "journal_article", venueId: "cjig" },
    provenance: { basis: "model_judgment_advisory", disclaimer: "advisory" },
  };
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = stack.store.researchDir(projectId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "target-contribution-audit.json"), JSON.stringify(artifact, null, 1), "utf8");
}

describe("target_audit 指令 × existing_paper_improvement 工作流（集成）", () => {
  it("审计计划决策 → run 恢复 → 可改写项派发执行 / 需实验项不派发 → 复评闭环", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack = await startTestStack(scripted.runtime, {
      paperParser: fakeParser(sampleExtraction),
      targetEvidenceAuditEnabled: true,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });

    // 1) PDF 导入（goal=improvement）
    const imported = await stack.request("POST", "/api/projects/import-paper", {
      fileName: "fusion-detector.pdf",
      contentBase64: PDF_BYTES.toString("base64"),
      format: "pdf",
      goal: "improvement",
      documentType: "journal_article",
    });
    expect(imported.status).toBe(201);
    const projectId = (imported.body["project"] as { id: string }).id;

    // 2) 计划入口在无审计工件时 fail-closed
    const noAudit = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
    expect(noAudit.status).toBe(409);

    // 3) 启动 run → 推进到 hitl.research_plan（import.parse 重建 + review.run 提交 baseline）
    const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {});
    expect(created.status).toBe(202);
    const runId = created.body["runId"] as string;
    const researchPlanPause = await pollRunUntilAwaiting(stack, runId, "hitl.research_plan");
    expect(researchPlanPause.status).toBe("awaiting_input");
    const revisionAtPause = await stack.stack.revisions.currentRevision(projectId);
    expect(revisionAtPause).toBeGreaterThanOrEqual(1);

    // 4) 写审计工件（指纹 = 已解析稿件；修订号 = 暂停时修订号）→ 生成计划
    await writeAuditArtifact(stack, projectId, revisionAtPause);
    const planResponse = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
    expect(planResponse.status).toBe(200);
    const plan = (planResponse.body["plan"] as { plan: { items: Array<{ itemId: string; classification: string; anchor: { projection: { status: string; file?: string }; dispatchSection?: string } }> } }).plan;
    const byId = new Map(plan.items.map((item) => [item.itemId, item]));
    expect(byId.get("ta-gap-1")?.classification).toBe("REWRITE_ELIGIBLE");
    expect(byId.get("ta-gap-1")?.anchor.projection.status).toBe("resolved");
    expect(byId.get("ta-gap-2")?.classification).toBe("NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT");

    // 5) 作者决策：两项均批准 → 可改写项转 pending 派发指令；需实验项转 AUTHOR_DECISION
    const decide = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/decide`, {
      decisions: [
        { itemId: "ta-gap-1", decision: "approve" },
        { itemId: "ta-gap-2", decision: "approve" },
      ],
    });
    expect(decide.status).toBe(200);
    const decidedPlan = (decide.body["plan"] as { plan: { status: string; items: Array<{ itemId: string; instructionId?: string }> } }).plan;
    expect(decidedPlan.status).toBe("decided");
    const gap1Instruction = decidedPlan.items.find((item) => item.itemId === "ta-gap-1")?.instructionId;
    const gap2Instruction = decidedPlan.items.find((item) => item.itemId === "ta-gap-2")?.instructionId;
    expect(gap1Instruction).toBeDefined();
    expect(gap2Instruction).toBeDefined();
    const instructionsBefore = (await stack.request("GET", `/api/projects/${projectId}/external-instructions`)).body[
      "instructions"
    ] as Array<{ instructionId: string; status: string; statusNote?: string; section?: string; source: string }>;
    const gap1Before = instructionsBefore.find((entry) => entry.instructionId === gap1Instruction);
    const gap2Before = instructionsBefore.find((entry) => entry.instructionId === gap2Instruction);
    expect(gap1Before?.source).toBe("target_audit");
    expect(gap1Before?.status).toBe("pending");
    expect(gap1Before?.section).toMatch(/sections\/sec\d+\.tex/);
    expect(gap2Before?.status).toBe("pending");
    expect(gap2Before?.statusNote).toMatch(/^AUTHOR_DECISION_REQUIRED: /);

    // 6) 恢复 run → plan.improvement（消费指令）→ plan_confirm → revision.apply 派发
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const finished = await pollRunCompleted(stack, runId);
    expect(finished.status).toBe("completed");
    expect(finished.completedStages).toContain("revision.apply");

    // 7) 可改写指令：handled（applied + 真实变化）；需实验指令：未被派发（AUTHOR_DECISION 保留）
    const instructionsAfter = (await stack.request("GET", `/api/projects/${projectId}/external-instructions`)).body[
      "instructions"
    ] as Array<{ instructionId: string; status: string; statusNote?: string; resolutionTrace?: { patchIds: string[]; verification: Record<string, boolean> } }>;
    const gap1After = instructionsAfter.find((entry) => entry.instructionId === gap1Instruction);
    const gap2After = instructionsAfter.find((entry) => entry.instructionId === gap2Instruction);
    expect(gap1After?.status).toBe("handled");
    expect(gap2After?.status).not.toBe("handled");
    expect(gap2After?.statusNote ?? "").toMatch(/AUTHOR_DECISION_REQUIRED|未派发|不适用/);

    // 8) 修订号前进（真实文本变化已提交为不可变修订）
    const revisionAfter = await stack.stack.revisions.currentRevision(projectId);
    expect(revisionAfter).toBeGreaterThan(revisionAtPause);

    // 9) 复评：逐项闭环
    const reassess = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/reassess`);
    expect(reassess.status).toBe(200);
    const report = reassess.body["report"] as {
      items: Array<{ itemId: string; closure: string }>;
      summary: Record<string, number>;
    };
    const closureById = new Map(report.items.map((item) => [item.itemId, item.closure]));
    expect(closureById.get("ta-gap-1")).toBe("VALIDATED_FIXED");
    expect(closureById.get("ta-gap-2")).toBe("NEEDS_AUTHOR_DECISION");
    expect(report.summary.VALIDATED_FIXED).toBe(1);
    expect(report.summary.NEEDS_AUTHOR_DECISION).toBe(1);
  });
});

async function pollRunCompleted(stack: TestStack, runId: string): Promise<{ status: string; completedStages: string[] }> {
  const deadline = Date.now() + 50_000;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as { status: string; completedStages: string[]; error?: { code: string; message: string } };
    if (run.status === "completed" || run.status === "failed") {
      if (run.status === "failed") {
        throw new Error(`run 失败：${run.error?.code} ${run.error?.message}`);
      }
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待完成超时（当前 ${run.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
