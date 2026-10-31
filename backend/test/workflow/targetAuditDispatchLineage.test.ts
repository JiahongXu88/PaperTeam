/**
 * M15.18 — 已批准审计改写意见的派发 lineage 与 targetChanged 顺序回归（集成，scripted 模型）。
 *
 * 复现 M15.17 真实 E2E 第三阻断与 §5 顺序差：
 * - Planner 把作者已批准的 target_audit REWRITE 拆成 modify + author_decision（转述 targetQuote
 *   不可逐字定位）→ 旧实现：author_decision 子条翻转指令 statusNote → authorOwnedComments
 *   过滤 → 原指令永不派发、modify 子条绑定失败 → 指令停在作者裁决（改写从未执行）。
 * - 文件级候选被内容塌缩守卫拒绝 → 旧实现在守卫之前计算 targetChanged → 指令仍 handled。
 *
 * 稿件 Method 节为接近真实论文长度的多段落长章节（> 编辑单元上限，展开为 logicalSpan 单元），
 * 避免短 fixture 掩盖单元定位问题；Conclusion 节用于文件级（整文件目标）守卫路径。
 */

import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import { scriptedExternalOutcomes } from "../../src/runtime/scriptedRuntime.js";
import { scriptedIdeaRuntime, startTestStack, pollRunUntilAwaiting, type TestStack } from "../helpers/testStack.js";
import { sha256Hex } from "../../src/util/hash.js";

vi.setConfig({ testTimeout: 90_000 });

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const CLAIM = "The fusion module combines hierarchical semantic features across stages and reaches 41.7 F1 on the validation split.";
const CLAIM_QUOTE = "The fusion module combines hierarchical semantic features across stages";
const CONCLUSION_CLAIM = "The conclusion states that the proposed detector generalizes well beyond the evaluated scenes.";
const EXPERIMENT_CLAIM = "Experiments on two public benchmarks validate the gains.";

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november"];
/** 12 段互不重复的长段落（每段 ~900 字符），声明句位于第 7 段 */
function methodParagraphs(): string[] {
  return WORDS.slice(0, 12).map((word, index) => {
    const filler = Array.from({ length: 14 }, (_, k) => `The ${word} stage refines representation ${word}${k} with consistent design choices`).join(". ");
    return index === 6 ? `${CLAIM} ${filler}.` : `${filler}.`;
  });
}

function sampleExtraction(): RawPdfExtraction {
  const conclusionFiller = Array.from({ length: 8 }, (_, k) => `Future work item ${WORDS[k]} remains to be explored carefully`).join(". ");
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
      ...methodParagraphs().map((text) => ({ page: 2, text })),
      { page: 3, text: `${EXPERIMENT_CLAIM} Reported on Total-Text. ` + "c".repeat(30) },
      { page: 4, text: `${CONCLUSION_CLAIM} ${conclusionFiller}.` },
      { page: 5, text: "[1] Liao M. Real-time scene text detection with differentiable binarization. 2020." },
      { page: 5, text: "[2] Liao M. DBNet v2. 2023." },
    ],
    totalChars: 14_000,
    notes: [],
  };
}

function fakeParser(): PdfParser {
  return {
    id: "fake",
    async parseFile() {
      return sampleExtraction();
    },
    async checkAvailability() {
      return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
    },
  };
}

const PDF_BYTES = Buffer.from("%PDF-1.5\nfake content for M15.18 dispatch lineage test\n");

async function writeAuditArtifact(stack: TestStack, projectId: string, manuscriptRevision: number, claimQuote: string, sectionId: string): Promise<void> {
  const document = await stack.stack.paperStore.loadDocument(projectId);
  const manuscriptSha256 = sha256Hex(document!.chunks.map((chunk) => chunk.text).join("\n\n")).slice(0, 16);
  const artifact = {
    schemaVersion: 1,
    venueId: "cjig",
    documentType: "journal_article",
    promptVersion: "m1514-caudit-v1",
    evaluatedAt: "2026-11-01T08:00:00.000Z",
    manuscriptRevision,
    priorWork: { cutoffDate: "2026-11-01", poolFingerprint: "poolfp0000000000", poolSize: 1, queriesUsed: [], candidates: [] },
    inventory: [
      { contributionId: "C1", claimQuote, claimType: "technical_idea", sectionId, supportLocations: [{ sectionId: "SEC03", kind: "experiment", quote: EXPERIMENT_CLAIM, verified: true }], supportStatus: "located", anchorVerified: true },
      { contributionId: "C2", claimQuote: EXPERIMENT_CLAIM, claimType: "performance_advantage", sectionId: "SEC03", supportLocations: [], supportStatus: "missing", anchorVerified: true },
    ],
    comparisons: [
      {
        contributionId: "C1",
        nearestPriorWorks: [{ candidateId: "P01", title: "Real-time scene text detection with differentiable binarization", year: 2020, doi: "10.1609/aaai.v34i07.6812", sourceLevel: "pool_abstract", resolvesToPool: true }],
        commonMechanism: "learnable post-processing", substantiveDifference: "hierarchical fusion across stages", differenceBasis: "abstract",
        completedVerification: "comparison on benchmarks", missingVerification: "ablation of the fusion", status: "EVIDENCE_GAP",
      },
      { contributionId: "C2", nearestPriorWorks: [], commonMechanism: "", substantiveDifference: "", differenceBasis: "none", completedVerification: "", missingVerification: "variance and ablation missing", status: "EVIDENCE_GAP" },
    ],
    gapPlan: [
      { contributionId: "C1", gap: "过强表述：融合模块的跨阶段机制表述强于稿件现有证据", actionType: "can_rewrite_from_existing_evidence", status: "proposed" },
      { contributionId: "C2", gap: "性能增益缺少消融与方差报告", actionType: "requires_real_experiment_or_author_input", experimentPlan: { purpose: "补消融验证融合贡献", baselines: "去融合变体", metrics: "F1" }, status: "author_decision" },
    ],
    findings: [],
    coverage: { sectionsTotal: 5, sectionsIndexed: 5, sectionsIncludedFullText: 5, manuscriptCharsTotal: 14000, manuscriptCharsIncluded: 14000, truncations: [] },
    guards: { anchorFailures: 0, unresolvedPriorWorkRefs: 0, cutoffViolations: 0, statusRuleViolations: 0, droppedFindings: 0, priorQuoteReplayFailures: 0, fulltextBasisDowngrades: 0 },
    inputFingerprint: { manuscriptSha256, poolFingerprint: "poolfp0000000000", promptVersion: "m1514-caudit-v1", documentType: "journal_article", venueId: "cjig" },
    provenance: { basis: "model_judgment_advisory", disclaimer: "advisory" },
  };
  await writeFile(join(stack.store.researchDir(projectId), "target-contribution-audit.json"), JSON.stringify(artifact, null, 1), "utf8");
}

type PlannerMode = "split_paraphrase" | "author_only" | "modify_verbatim";
type WriterMode = "weaken" | "noop_claim" | "collapse" | "fact_mutate";

interface Harness {
  stack: TestStack;
  projectId: string;
  runId: string;
  rewriteId: string;
  experimentId: string;
  targetFile: string;
  prompts: { planner: string[]; writer: string[] };
}

function currentContent(task: string): string | undefined {
  const marker = "===== 本章节当前内容 =====\n";
  const start = task.indexOf(marker);
  if (start < 0) return undefined;
  const end = task.indexOf("\n\n===== 针对本章节的问题", start);
  return task.slice(start + marker.length, end < 0 ? undefined : end);
}

function plannerOutput(task: string, mode: PlannerMode, targetFile: string, verbatim: string): string {
  const ref = [...task.matchAll(/^(C\d+) \[[^\]\r\n]*\] (.+)$/gm)].find((match) => match[2]!.includes("条目 ta-gap-1"))?.[1];
  const refs = ref !== undefined ? { commentRefs: [ref] } : {};
  const modify = (targetQuote: string) => ({ section: targetFile, actionType: "modify", targetQuote, action: "把融合模块的机制表述弱化为稿件现有证据可支撑的强度（不改数值与引用）", rationale: "审计：过强表述", priority: "high", ...refs });
  const authorDecision = { section: targetFile, actionType: "author_decision_required", action: "区分融合模块与先前工作的具体定位需作者确认", rationale: "定位差异需作者判断", priority: "medium", ...refs };
  const plan = mode === "split_paraphrase"
    // 真实形态：Planner 转述了引文（大小写 / 措辞近似，逐字不可定位）
    ? [modify("the fusion module merges hierarchical semantics across all stages"), authorDecision]
    : mode === "author_only"
      ? [authorDecision]
      : [modify(verbatim)];
  // 其它意见（真人 Reviewer）各自一条 modify（同一原句）
  const otherRefs = [...task.matchAll(/^(C\d+) \[[^\]\r\n]*\] (.+)$/gm)].filter((match) => !match[2]!.includes("ta-gap")).map((match) => match[1]!);
  for (const other of otherRefs) {
    plan.push({ ...modify(verbatim), action: "在该句补充适用范围限定（不新增实验结果）", rationale: "Reviewer 意见", commentRefs: [other] });
  }
  return JSON.stringify({ plan });
}

function writerOutput(task: string, mode: WriterMode): string | undefined {
  const content = currentContent(task);
  if (content === undefined || task.includes("修订论文摘要")) return undefined;
  const outcomes = scriptedExternalOutcomes(task);
  const withOutcomes = (body: string): string => (outcomes !== null ? `${body}\n${outcomes}` : body);
  if (mode === "noop_claim") return withOutcomes(content);
  if (mode === "collapse") return content.includes(CONCLUSION_CLAIM) ? withOutcomes(content.slice(0, 80)) : withOutcomes(content);
  if (mode === "fact_mutate") return withOutcomes(content.replace("41.7 F1", "47.1 F1").replace(CLAIM_QUOTE, "The fusion module is designed to combine hierarchical semantic features across stages"));
  return withOutcomes(content.replace(CLAIM_QUOTE, "The fusion module is designed to combine hierarchical semantic features across stages")
    .replace(CONCLUSION_CLAIM, "The conclusion states that the proposed detector may generalize beyond the evaluated scenes."));
}

async function setup(options: { planner: PlannerMode; writer: WriterMode; claimQuote?: string; sectionId?: string; humanInstruction?: boolean }): Promise<Harness> {
  const prompts = { planner: [] as string[], writer: [] as string[] };
  let targetFileForPlanner = "";
  let verbatimForPlanner = "";
  const scripted = scriptedIdeaRuntime({
    reviewSequence: ["pass"],
    scopeOutputOverride: (scope, task) => {
      if (scope === "writing/improvement-plan") {
        prompts.planner.push(task);
        return plannerOutput(task, options.planner, targetFileForPlanner, verbatimForPlanner);
      }
      if (scope === "writing/revision" || scope === "writing/revision-proposal") {
        prompts.writer.push(task);
        return writerOutput(task, options.writer);
      }
      return undefined;
    },
  });
  const stack = await startTestStack(scripted.runtime, {
    paperParser: fakeParser(),
    targetEvidenceAuditEnabled: true,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
  const imported = await stack.request("POST", "/api/projects/import-paper", {
    fileName: "fusion-detector.pdf", contentBase64: PDF_BYTES.toString("base64"), format: "pdf", goal: "improvement", documentType: "journal_article",
  });
  expect(imported.status).toBe(201);
  const projectId = (imported.body["project"] as { id: string }).id;
  const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {});
  const runId = created.body["runId"] as string;
  await pollRunUntilAwaiting(stack, runId, "hitl.research_plan");
  const revision = await stack.stack.revisions.currentRevision(projectId);
  await writeAuditArtifact(stack, projectId, revision, options.claimQuote ?? CLAIM_QUOTE, options.sectionId ?? "SEC02");
  const planResponse = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
  expect(planResponse.status).toBe(200);
  const plan = (planResponse.body["plan"] as { plan: { items: Array<{ itemId: string; classification: string; anchor: { texAnchor?: string; projection: { file?: string } } }> } }).plan;
  const rewrite = plan.items.find((item) => item.itemId === "ta-gap-1")!;
  expect(rewrite.classification).toBe("REWRITE_ELIGIBLE");
  targetFileForPlanner = rewrite.anchor.projection.file!;
  const targetText = await readFile(join(stack.store.manuscriptDir(projectId), targetFileForPlanner), "utf8");
  // 逐字 targetQuote：取声明句在 TeX 中的逐字形态（含转义）
  verbatimForPlanner = targetText.split(/\r?\n/).find((line) => line.includes("41.7"))?.match(/The fusion module[^.]*\./)?.[0] ?? CLAIM_QUOTE;
  const decide = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/decide`, {
    decisions: [{ itemId: "ta-gap-1", decision: "approve" }, { itemId: "ta-gap-2", decision: "approve" }],
  });
  expect(decide.status).toBe(200);
  const items = (decide.body["plan"] as { plan: { items: Array<{ itemId: string; instructionId?: string }> } }).plan.items;
  if (options.humanInstruction === true) {
    const human = await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
      source: "journal_reviewer", reviewerLabel: "Reviewer 1", text: "请针对「The fusion module combines hierarchical semantic features」一句明确说明融合模块的适用范围限定（不得新增实验结果）。", section: targetFileForPlanner,
    });
    expect(human.status).toBeLessThan(300);
  }
  return {
    stack, projectId, runId, prompts,
    rewriteId: items.find((item) => item.itemId === "ta-gap-1")!.instructionId!,
    experimentId: items.find((item) => item.itemId === "ta-gap-2")!.instructionId!,
    targetFile: targetFileForPlanner,
  };
}

async function runToEnd(h: Harness): Promise<void> {
  await h.stack.request("POST", `/api/runs/${h.runId}/resume`, { decision: "approve" });
  await pollRunUntilAwaiting(h.stack, h.runId, "hitl.plan_confirm");
  await h.stack.request("POST", `/api/runs/${h.runId}/resume`, { decision: "approve" });
  const deadline = Date.now() + 80_000;
  for (;;) {
    const { body } = await h.stack.request("GET", `/api/runs/${h.runId}`);
    const run = body["run"] as { status: string; awaiting?: { stageId: string }; error?: { code: string; message: string } };
    if (run.status === "completed") return;
    if (run.status === "failed") throw new Error(`run 失败：${run.error?.code} ${run.error?.message}`);
    // 未解决意见可能使修订循环停滞——合法 HITL 终点（本测试只关心派发 lineage）
    if (run.status === "awaiting_input" && (run.awaiting?.stageId === "hitl.revision_stalled" || run.awaiting?.stageId === "hitl.revision_overflow")) return;
    if (run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.revision_validation") {
      await h.stack.request("POST", `/api/runs/${h.runId}/resume`, { decision: "approve" });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`等待完成超时（${run.status} ${run.awaiting?.stageId ?? ""}）`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface InstructionView {
  instructionId: string; source: string; status: string; statusNote?: string;
  origin?: { kind: string; texAnchor?: string; targetFile?: string; planId: string; itemId: string };
  planItemOutcomes?: Array<{ planItemId: string; outcome: string; file?: string; beforeSha256?: string; afterSha256?: string; revision?: number }>;
}

async function instructions(h: Harness): Promise<InstructionView[]> {
  return (await h.stack.request("GET", `/api/projects/${h.projectId}/external-instructions`)).body["instructions"] as InstructionView[];
}

async function reassess(h: Harness): Promise<Map<string, { closure: string; basis: string; checks?: Record<string, boolean>; openSubItems?: unknown[]; lineage?: unknown[] }>> {
  const response = await h.stack.request("POST", `/api/projects/${h.projectId}/target/evidence-audit/revision-plan/reassess`);
  expect(response.status).toBe(200);
  const report = response.body["report"] as { items: Array<{ itemId: string; closure: string; basis: string; checks?: Record<string, boolean>; openSubItems?: unknown[]; lineage?: unknown[] }> };
  return new Map(report.items.map((item) => [item.itemId, item]));
}

describe("M15.18 已批准审计改写：Planner 拆条不再吞掉派发（真实故障形态）", () => {
  it("拆成 modify(转述引文) + author_decision：原指令仍以 TeX 逐字锚派发并落盘；子条各自留痕；复评 PARTIALLY_ADDRESSED（不夸大）", async () => {
    const h = await setup({ planner: "split_paraphrase", writer: "weaken" });
    expect(h.prompts.planner.length).toBe(0);
    await runToEnd(h);
    // Planner 输入携带批准状态与规则（不再只给原文）
    expect(h.prompts.planner.some((prompt) => prompt.includes("【作者已批准：按既有证据改写】") && prompt.includes("TeX 逐字锚"))).toBe(true);
    const all = await instructions(h);
    const rewrite = all.find((entry) => entry.instructionId === h.rewriteId)!;
    expect(rewrite.origin?.kind).toBe("target_audit_rewrite");
    // 旧实现：statusNote 被翻转为 AUTHOR_DECISION_REQUIRED，status 停 unresolved，从未派发
    expect(rewrite.statusNote ?? "").not.toMatch(/^AUTHOR_DECISION_REQUIRED/);
    expect(rewrite.status).toBe("handled");
    // Writer prompt 真实收到了原指令（外部意见通道）
    expect(h.prompts.writer.some((prompt) => prompt.includes(`--- 意见 ${h.rewriteId}`))).toBe(true);
    const outcomes = rewrite.planItemOutcomes ?? [];
    expect(outcomes.some((entry) => entry.outcome === "author_decision" && entry.planItemId === "improvement:2")).toBe(true);
    const applied = outcomes.filter((entry) => entry.outcome === "applied" && entry.file === h.targetFile);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]!.beforeSha256).not.toBe(applied[0]!.afterSha256);
    // 真实改写落盘；数值保持
    const after = await readFile(join(h.stack.store.manuscriptDir(h.projectId), h.targetFile), "utf8");
    expect(after).toContain("is designed to combine hierarchical semantic features");
    expect(after).toContain("41.7 F1");
    // 需实验项：仍作者裁决，零派发
    const experiment = all.find((entry) => entry.instructionId === h.experimentId)!;
    expect(experiment.statusNote).toMatch(/^AUTHOR_DECISION_REQUIRED/);
    expect(h.prompts.writer.some((prompt) => prompt.includes(`--- 意见 ${h.experimentId}`))).toBe(false);
    const report = await reassess(h);
    expect(report.get("ta-gap-1")?.closure).toBe("PARTIALLY_ADDRESSED");
    expect(report.get("ta-gap-1")?.openSubItems?.length).toBe(1);
    expect(report.get("ta-gap-2")?.closure).toBe("NEEDS_AUTHOR_DECISION");
  });

  it("Planner 只给 author_decision（含兜底）：原批准指令仍派发执行，author 子条独立保持；复评 PARTIALLY_ADDRESSED", async () => {
    const h = await setup({ planner: "author_only", writer: "weaken" });
    await runToEnd(h);
    const rewrite = (await instructions(h)).find((entry) => entry.instructionId === h.rewriteId)!;
    expect(rewrite.status).toBe("handled");
    expect((rewrite.planItemOutcomes ?? []).some((entry) => entry.outcome === "author_decision")).toBe(true);
    const report = await reassess(h);
    expect(report.get("ta-gap-1")?.closure).toBe("PARTIALLY_ADDRESSED");
  });

  it("只有 modify（逐字 targetQuote）+ 真人意见同节：真人意见先序、均派发；复评 VALIDATED_FIXED（lineage/绑定/变化/守卫全核）", async () => {
    const h = await setup({ planner: "modify_verbatim", writer: "weaken", humanInstruction: true });
    await runToEnd(h);
    const all = await instructions(h);
    const rewrite = all.find((entry) => entry.instructionId === h.rewriteId)!;
    const human = all.find((entry) => entry.source === "journal_reviewer")!;
    expect(rewrite.status).toBe("handled");
    expect(human.status).toBe("handled");
    const prompt = h.prompts.writer.find((entry) => entry.includes(`--- 意见 ${h.rewriteId}`))!;
    expect(prompt.indexOf(`--- 意见 ${human.instructionId}`)).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(`--- 意见 ${human.instructionId}`)).toBeLessThan(prompt.indexOf(`--- 意见 ${h.rewriteId}`));
    const report = await reassess(h);
    const item = report.get("ta-gap-1")!;
    expect(item.closure).toBe("VALIDATED_FIXED");
    expect(item.checks).toEqual({ lineage: true, targetBinding: true, contentChanged: true, notReverted: true, guards: true });

    // 幂等 / 重跑：新 run 不重复执行已 handled 的指令，不伪造新的 lineage
    const appliedBefore = (rewrite.planItemOutcomes ?? []).filter((entry) => entry.outcome === "applied").length;
    const firstRun = (await h.stack.request("GET", `/api/runs/${h.runId}`)).body["run"] as { status: string };
    if (firstRun.status !== "completed") {
      expect((await h.stack.request("POST", `/api/runs/${h.runId}/cancel`)).status).toBeLessThan(300);
    }
    const second = await h.stack.request("POST", `/api/projects/${h.projectId}/workflows`, {});
    expect(second.status).toBe(202);
    const runId2 = second.body["runId"] as string;
    const writerCallsBefore = h.prompts.writer.filter((entry) => entry.includes(`--- 意见 ${h.rewriteId}`)).length;
    await runToEnd({ ...h, runId: runId2 });
    const rewriteAfter = (await instructions(h)).find((entry) => entry.instructionId === h.rewriteId)!;
    expect(rewriteAfter.status).toBe("handled");
    expect((rewriteAfter.planItemOutcomes ?? []).filter((entry) => entry.outcome === "applied").length).toBe(appliedBefore);
    expect(h.prompts.writer.filter((entry) => entry.includes(`--- 意见 ${h.rewriteId}`)).length).toBe(writerCallsBefore);

    // 回退：目标文件恢复为修订前内容 → 不得仍判 VALIDATED_FIXED
    const beforeSha = (rewriteAfter.planItemOutcomes ?? []).find((entry) => entry.outcome === "applied")?.beforeSha256;
    expect(beforeSha).toBeDefined();
    const current = await readFile(join(h.stack.store.manuscriptDir(h.projectId), h.targetFile), "utf8");
    await writeFile(join(h.stack.store.manuscriptDir(h.projectId), h.targetFile), current.replace("is designed to combine hierarchical semantic features", "combines hierarchical semantic features"), "utf8");
    const reverted = await reassess(h);
    expect(reverted.get("ta-gap-1")?.closure).not.toBe("VALIDATED_FIXED");
  });
});

describe("M15.18 targetChanged 以落盘为准（候选被拒 / 无改动 不得 handled）", () => {
  it("Writer 自称 applied 但内容未改：指令不 handled；复评 STILL_OPEN", async () => {
    const h = await setup({ planner: "modify_verbatim", writer: "noop_claim" });
    await runToEnd(h);
    const rewrite = (await instructions(h)).find((entry) => entry.instructionId === h.rewriteId)!;
    expect(rewrite.status).not.toBe("handled");
    expect((rewrite.planItemOutcomes ?? []).some((entry) => entry.outcome === "applied")).toBe(false);
    expect((await reassess(h)).get("ta-gap-1")?.closure).toBe("STILL_OPEN");
  });

  it("span 候选篡改既有数值（41.7→47.1）被事实守卫拒绝：未落盘、指令记 candidate_rejected、复评 STILL_OPEN", async () => {
    const h = await setup({ planner: "modify_verbatim", writer: "fact_mutate" });
    await runToEnd(h);
    const after = await readFile(join(h.stack.store.manuscriptDir(h.projectId), h.targetFile), "utf8");
    expect(after).toContain("41.7 F1");
    expect(after).not.toContain("47.1");
    const rewrite = (await instructions(h)).find((entry) => entry.instructionId === h.rewriteId)!;
    expect(rewrite.status).not.toBe("handled");
    expect((rewrite.planItemOutcomes ?? []).some((entry) => entry.outcome === "candidate_rejected")).toBe(true);
    expect(rewrite.statusNote ?? "").not.toMatch(/指定章节未匹配/);
    expect((await reassess(h)).get("ta-gap-1")?.closure).toBe("STILL_OPEN");
  });

  it("文件级候选被内容塌缩守卫拒绝（M15.17 §5 顺序差真实复现）：旧实现记 handled，现记 rejected 且不 handled", async () => {
    const h = await setup({ planner: "modify_verbatim", writer: "collapse", claimQuote: CONCLUSION_CLAIM, sectionId: "SEC04" });
    const beforeText = await readFile(join(h.stack.store.manuscriptDir(h.projectId), h.targetFile), "utf8");
    await runToEnd(h);
    const after = await readFile(join(h.stack.store.manuscriptDir(h.projectId), h.targetFile), "utf8");
    expect(after.trim()).toBe(beforeText.trim());
    const rewrite = (await instructions(h)).find((entry) => entry.instructionId === h.rewriteId)!;
    expect(rewrite.status).not.toBe("handled");
    expect((rewrite.planItemOutcomes ?? []).some((entry) => entry.outcome === "candidate_rejected")).toBe(true);
    expect(rewrite.statusNote ?? "").toMatch(/守卫拒绝/);
    expect((await reassess(h)).get("ta-gap-1")?.closure).toBe("STILL_OPEN");
  });

  it("锚失效（批准后目标文件中 TeX 逐字锚已不存在）：fail-closed 不派发（不套用到变化后的正文）", async () => {
    const h = await setup({ planner: "modify_verbatim", writer: "weaken", claimQuote: CONCLUSION_CLAIM, sectionId: "SEC04" });
    const file = join(h.stack.store.manuscriptDir(h.projectId), h.targetFile);
    const original = await readFile(file, "utf8");
    // 模拟稿件在审计/批准之后被另一修改改写（句子已不在）
    await writeFile(file, original.replace("generalizes well beyond", "is evaluated only on"), "utf8");
    await runToEnd(h);
    const rewrite = (await instructions(h)).find((entry) => entry.instructionId === h.rewriteId)!;
    expect(rewrite.status).toBe("unresolved");
    expect(rewrite.statusNote ?? "").toMatch(/^TARGET_AUDIT_ANCHOR_STALE/);
    expect(h.prompts.writer.some((prompt) => prompt.includes(`--- 意见 ${h.rewriteId}`))).toBe(false);
    expect((await readFile(file, "utf8"))).toContain("is evaluated only on");
    expect((await reassess(h)).get("ta-gap-1")?.closure).toBe("STILL_OPEN");
  });
});
