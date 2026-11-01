/**
 * M15.20 P0 —— 编辑契约（授权内核）工作流集成验收（scripted 模型，零真实模型 / 零网络）。
 *
 * 夹具根据 M15.19 E1 真实冻结工件派生（见 test/fixtures/editContract/e1-derived.ts 头注释）：
 * 摘要目标锚 = 「improving the previous best HOTA by 5.402/6.075 points and IDF1 by 11.549/12.789 points, respectively」，
 * 正文另有 3.312 / 9.798 口径；Planner 计划文本点名「旧值 → 新值」并自称作者已批准（expectedFactChanges 为空）。
 *
 * 覆盖：E1-NUM / E1-SENT / E1-PLAN / E1-PATH（摘要载体 + sec01 文件级载体）/ E1-APPROVE（伪造值对、
 * 审计硬禁改下的结构化批准、旧计划哈希）/ E1-STALE / E1-LEGACY / 合法正例（锚内限定、非审计条目的结构化
 * 值对批准）。验收口径：正式稿件字节不变、指令不 handled、复评不 VALIDATED_FIXED、错误码可追溯。
 */

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import { scriptedExternalOutcomes } from "../../src/runtime/scriptedRuntime.js";
import { scriptedIdeaRuntime, startTestStack, pollRunUntilAwaiting, type TestStack } from "../helpers/testStack.js";
import { sha256Hex } from "../../src/util/hash.js";
import { E1_ANCHOR } from "../fixtures/editContract/e1-derived.js";

vi.setConfig({ testTimeout: 120_000 });

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const ABSTRACT =
  "Synthetic tracking methods have improved cross-modal representation learning and multimodal information integration. " +
  "We propose RCA-X, a reliability-consistent appearance framework. " +
  "The individual components are intentionally simple, focusing evaluation on controllable organization rather than learned estimation modules. " +
  `RCA-X sets new SOTA results on BENCH-A and BENCH-B, ${E1_ANCHOR}, while post-hoc analyses further validate reliability as an informative control signal. ` +
  "Code will be released upon acceptance.";
const INTRO_SENTENCE = "Experiments on BENCH-A and BENCH-B show that RCA-X surpasses the previous SOTA by 5.402/6.075 HOTA and 11.549/12.789 IDF1, respectively.";
const EVIDENCE_SENTENCE = "With single-setting detections RCA-X achieves 45.042 HOTA and 57.108 IDF1, exceeding the highest prior values listed by 3.312 and 9.798 points.";
const EXPERIMENT_CLAIM = "Experiments on two public benchmarks validate the gains.";

function sampleExtraction(): RawPdfExtraction {
  return {
    ok: true,
    parser: { id: "fake", version: "1" },
    pageCount: 5,
    title: "Reliability Consistent Appearance Modeling",
    abstract: ABSTRACT,
    toc: [
      [1, "Introduction", 1],
      [1, "Method", 2],
      [1, "Experiments", 3],
      [1, "Conclusion", 4],
      [1, "References", 5],
    ] as Array<[number, string, number]>,
    blocks: [
      { page: 1, text: `Introduction describing the task. ${INTRO_SENTENCE} ` + "a".repeat(60) },
      { page: 2, text: "The method keeps branch-wise appearance states with a training-free estimator. " + "b".repeat(60) },
      { page: 3, text: `${EVIDENCE_SENTENCE} ${EXPERIMENT_CLAIM} ` + "c".repeat(40) },
      { page: 4, text: "Conclusion summarizing the method and future work. " + "d".repeat(40) },
      { page: 5, text: "[1] Liao M. Real-time scene text detection with differentiable binarization. 2020." },
      { page: 5, text: "[2] Liao M. DBNet v2. 2023." },
    ],
    totalChars: 2400,
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

const PDF_BYTES = Buffer.from("%PDF-1.5\nfake content for M15.20 edit contract workflow test\n");

async function writeAuditArtifact(stack: TestStack, projectId: string, manuscriptRevision: number): Promise<void> {
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
      { contributionId: "C1", claimQuote: E1_ANCHOR, claimType: "performance_advantage", sectionId: "SEC01", supportLocations: [{ sectionId: "SEC03", kind: "experiment", quote: EVIDENCE_SENTENCE, verified: true }], supportStatus: "located", anchorVerified: true },
      { contributionId: "C2", claimQuote: EXPERIMENT_CLAIM, claimType: "performance_advantage", sectionId: "SEC03", supportLocations: [], supportStatus: "missing", anchorVerified: true },
    ],
    comparisons: [
      {
        contributionId: "C1",
        nearestPriorWorks: [{ candidateId: "P01", title: "Real-time scene text detection with differentiable binarization", year: 2020, doi: "10.1609/aaai.v34i07.6812", sourceLevel: "pool_abstract", resolvesToPool: true }],
        commonMechanism: "appearance modeling", substantiveDifference: "reliability control", differenceBasis: "abstract",
        completedVerification: "benchmarks", missingVerification: "single detection setting", status: "EVIDENCE_GAP",
      },
      { contributionId: "C2", nearestPriorWorks: [], commonMechanism: "", substantiveDifference: "", differenceBasis: "none", completedVerification: "", missingVerification: "variance", status: "EVIDENCE_GAP" },
    ],
    gapPlan: [
      { contributionId: "C1", gap: "摘要头条增益混用两种检测口径（与正文证据锚不一致）", actionType: "can_rewrite_from_existing_evidence", status: "proposed" },
      { contributionId: "C2", gap: "增益缺少方差报告", actionType: "requires_real_experiment_or_author_input", experimentPlan: { purpose: "补方差", baselines: "同设置重复", metrics: "HOTA" }, status: "author_decision" },
    ],
    findings: [],
    coverage: { sectionsTotal: 5, sectionsIndexed: 5, sectionsIncludedFullText: 5, manuscriptCharsTotal: 2400, manuscriptCharsIncluded: 2400, truncations: [] },
    guards: { anchorFailures: 0, unresolvedPriorWorkRefs: 0, cutoffViolations: 0, statusRuleViolations: 0, droppedFindings: 0, priorQuoteReplayFailures: 0, fulltextBasisDowngrades: 0 },
    inputFingerprint: { manuscriptSha256, poolFingerprint: "poolfp0000000000", promptVersion: "m1514-caudit-v1", documentType: "journal_article", venueId: "cjig" },
    provenance: { basis: "model_judgment_advisory", disclaimer: "advisory" },
  };
  await writeFile(join(stack.store.researchDir(projectId), "target-contribution-audit.json"), JSON.stringify(artifact, null, 1), "utf8");
}

/** Writer 行为（scripted）：越权（E1 真实形态）/ 只换数 / 锚外删句 / 合法锚内限定 */
type AbstractWriter = "real_violation" | "numbers_only" | "extra_deletions" | "legal_qualify";
/** Planner 行为：audit = E1 真实形态（文本点名旧→新 + 自称已批准 + 摘要条目 + sec01 引言条目） */
type PlannerMode = "audit_e1" | "audit_structured_change" | "plain_value_change";

interface Harness {
  stack: TestStack;
  projectId: string;
  runId: string;
  rewriteId: string;
  manuscriptDir: string;
}

function abstractCandidate(current: string, mode: AbstractWriter): string {
  const flat = current.replace(/\s+/g, " ").trim();
  switch (mode) {
    case "numbers_only":
      return flat.replace("5.402/6.075", "3.312/6.075").replace("11.549/12.789", "9.798/12.789");
    case "extra_deletions":
      return flat
        .replace(" The individual components are intentionally simple, focusing evaluation on controllable organization rather than learned estimation modules.", "")
        .replace(", while post-hoc analyses further validate reliability as an informative control signal", "");
    case "legal_qualify":
      return flat.replace(E1_ANCHOR, "improving the previous best HOTA by 5.402/6.075 points and IDF1 by 11.549/12.789 points under the respective detection settings, respectively");
    case "real_violation":
    default:
      return "Synthetic tracking methods have improved cross-modal representation learning. We propose RCA-X, a reliability-consistent appearance framework. Under a single detection setting, RCA-X exceeds the highest prior values on BENCH-A and BENCH-B by 3.312/6.075 HOTA points and 9.798/12.789 IDF1 points, respectively. Code will be released upon acceptance.";
  }
}

/** 证据句所在的重建章节文件（PDF 重建的文件名由解析决定，测试在导入后确定性查找） */
let experimentsFile = "sections/sec03.tex";
let introFile = "sections/sec01.tex";

function plannerOutput(task: string, mode: PlannerMode): string {
  const ref = [...task.matchAll(/^(C\d+) \[[^\]\r\n]*\] (.+)$/gm)].find((match) => match[2]!.includes("条目 ta-gap-1"))?.[1];
  const refs = ref !== undefined ? { commentRefs: [ref] } : {};
  if (mode === "plain_value_change") {
    return JSON.stringify({
      plan: [{
        section: experimentsFile,
        actionType: "modify",
        action: "把 45.042 HOTA 更正为 45.04 HOTA（统一三位有效数字）",
        rationale: "作者已批准：按表格精度统一",
        priority: "high",
        expectedFactChanges: [{ before: "45.042", after: "45.04", basis: "表格精度" }],
        evidenceRefs: ["EV1"],
      }],
    });
  }
  const abstractItem = {
    section: "sections/sec01.tex",
    logicalSection: "abstract",
    targetQuote: E1_ANCHOR,
    actionType: "modify",
    action: '将摘要头条数字统一到一个口径：把旧值 "5.402/6.075" 改为 "3.312/6.075"，把旧值 "11.549/12.789" 改为 "9.798/12.789"。',
    rationale: "C1【作者已批准：按既有证据改写】仅修改该句，targetQuote 之外内容逐字保留。",
    priority: "high",
    ...refs,
    ...(mode === "audit_structured_change" ? { expectedFactChanges: [{ before: "5.402", after: "3.312", basis: "SEC03" }] } : { expectedFactChanges: [] }),
  };
  // E1-PATH：Planner 把同一审计意见拆到引言同句（sec01 文件级目标）——审计契约只授权摘要锚，越出即拒
  const introItem = {
    section: introFile,
    targetQuote: INTRO_SENTENCE,
    actionType: "modify",
    action: '与摘要同步：把 "5.402/6.075" 改为 "3.312/6.075"，"11.549/12.789" 改为 "9.798/12.789"。',
    rationale: "C1【作者已批准：按既有证据改写】",
    priority: "high",
    ...refs,
    expectedFactChanges: [],
  };
  return JSON.stringify({ plan: mode === "audit_e1" ? [abstractItem, introItem] : [abstractItem] });
}

function writerOutput(task: string, mode: AbstractWriter, currentAbstract: () => string): string | undefined {
  const outcomes = scriptedExternalOutcomes(task);
  const withOutcomes = (body: string): string => (outcomes !== null ? `${body}\n${outcomes}` : body);
  if (task.includes("修订论文摘要")) return withOutcomes(abstractCandidate(currentAbstract(), mode));
  // 其它章节：越权换数（E1-PATH 引言 / 普通条目的值变更）
  const marker = "===== 本章节当前内容 =====\n";
  const start = task.indexOf(marker);
  if (start < 0) return undefined;
  const end = task.indexOf("\n\n===== 针对本章节的问题", start);
  const content = task.slice(start + marker.length, end < 0 ? undefined : end);
  return withOutcomes(content.replace("5.402/6.075", "3.312/6.075").replace("11.549/12.789", "9.798/12.789").replace("45.042", "45.04"));
}

async function setup(options: { planner: PlannerMode; writer: AbstractWriter }): Promise<Harness> {
  let manuscriptDir = "";
  const currentAbstract = (): string => (JSON.parse(readFileSync(join(manuscriptDir, "outline.json"), "utf8")) as { abstract?: string }).abstract ?? "";
  const scripted = scriptedIdeaRuntime({
    reviewSequence: ["pass"],
    scopeOutputOverride: (scope, task) => {
      if (scope === "writing/improvement-plan") return plannerOutput(task, options.planner);
      if (scope === "writing/revision" || scope === "writing/revision-proposal") return writerOutput(task, options.writer, currentAbstract);
      return undefined;
    },
  });
  const stack = await startTestStack(scripted.runtime, {
    paperParser: fakeParser(),
    targetEvidenceAuditEnabled: true,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
  const imported = await stack.request("POST", "/api/projects/import-paper", {
    fileName: "rca.pdf", contentBase64: PDF_BYTES.toString("base64"), format: "pdf", goal: "improvement", documentType: "journal_article",
  });
  expect(imported.status).toBe(201);
  const projectId = (imported.body["project"] as { id: string }).id;
  manuscriptDir = stack.store.manuscriptDir(projectId);
  const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {});
  const runId = created.body["runId"] as string;
  await pollRunUntilAwaiting(stack, runId, "hitl.research_plan");
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(join(manuscriptDir, "sections"))) {
    const text = await readFile(join(manuscriptDir, "sections", name), "utf8");
    if (text.includes("45.042")) experimentsFile = `sections/${name}`;
    if (text.includes("surpasses the previous SOTA")) introFile = `sections/${name}`;
  }
  let rewriteId = "";
  if (options.planner === "plain_value_change") {
    // 作者确认的证据（Planner 事实变更条目须绑定 verified Evidence——既有规则；授权仍只来自逐项勾选）
    await stack.stack.workflowServices.evidence.append(projectId, {
      claim: "Author-confirmed table precision: 45.04 HOTA", quote: "45.04 HOTA", verificationStatus: "verified", verificationLevel: "user_confirmed", supportStrength: "direct",
      source: { sourceId: "author-table" }, location: { chunk: "author-table:1" },
    }, "user");
  }
  if (options.planner !== "plain_value_change") {
    await writeAuditArtifact(stack, projectId, await stack.stack.revisions.currentRevision(projectId));
    const planResponse = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
    expect(planResponse.status).toBe(200);
    const plan = (planResponse.body["plan"] as { plan: { items: Array<{ itemId: string; classification: string; anchor: { projection: { file?: string } } }> } }).plan;
    const rewrite = plan.items.find((item) => item.itemId === "ta-gap-1")!;
    expect(rewrite.classification).toBe("REWRITE_ELIGIBLE");
    expect(rewrite.anchor.projection.file).toBe("abstract");
    const decide = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/decide`, {
      decisions: [{ itemId: "ta-gap-1", decision: "approve" }, { itemId: "ta-gap-2", decision: "approve" }],
    });
    expect(decide.status).toBe(200);
    rewriteId = (decide.body["plan"] as { plan: { items: Array<{ itemId: string; instructionId?: string }> } }).plan.items.find((item) => item.itemId === "ta-gap-1")!.instructionId!;
  }
  return { stack, projectId, runId, rewriteId, manuscriptDir };
}

async function toPlanConfirm(h: Harness): Promise<Record<string, unknown>> {
  await h.stack.request("POST", `/api/runs/${h.runId}/resume`, { decision: "approve" });
  const paused = await pollRunUntilAwaiting(h.stack, h.runId, "hitl.plan_confirm");
  return ((paused as { awaiting?: { payload?: Record<string, unknown> } }).awaiting?.payload) ?? {};
}

async function runToEnd(h: Harness, approvePayload?: Record<string, unknown>): Promise<void> {
  const approve = await h.stack.request("POST", `/api/runs/${h.runId}/resume`, { decision: "approve", ...(approvePayload !== undefined ? { payload: approvePayload } : {}) });
  expect(approve.status).toBe(200);
  const deadline = Date.now() + 100_000;
  for (;;) {
    const { body } = await h.stack.request("GET", `/api/runs/${h.runId}`);
    const run = body["run"] as { status: string; awaiting?: { stageId: string }; error?: { code: string; message: string } };
    if (run.status === "completed") return;
    if (run.status === "failed") throw new Error(`run 失败：${run.error?.code} ${run.error?.message}`);
    if (run.status === "awaiting_input" && (run.awaiting?.stageId === "hitl.revision_stalled" || run.awaiting?.stageId === "hitl.revision_overflow")) return;
    if (run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.revision_validation") {
      await h.stack.request("POST", `/api/runs/${h.runId}/resume`, { decision: "approve" });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`等待完成超时（${run.status} ${run.awaiting?.stageId ?? ""}）`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function outlineAbstract(h: Harness): Promise<string> {
  return (JSON.parse(await readFile(join(h.manuscriptDir, "outline.json"), "utf8")) as { abstract?: string }).abstract ?? "";
}

async function instruction(h: Harness, id: string): Promise<{ status: string; statusNote?: string; origin?: { contractId?: string } }> {
  const list = (await h.stack.request("GET", `/api/projects/${h.projectId}/external-instructions`)).body["instructions"] as Array<{ instructionId: string; status: string; statusNote?: string; origin?: { contractId?: string } }>;
  return list.find((entry) => entry.instructionId === id)!;
}

async function closure(h: Harness): Promise<{ closure: string; basis: string; editContract?: { status: string } }> {
  const response = await h.stack.request("POST", `/api/projects/${h.projectId}/target/evidence-audit/revision-plan/reassess`);
  expect(response.status).toBe(200);
  return (response.body["report"] as { items: Array<{ itemId: string; closure: string; basis: string; editContract?: { status: string } }> }).items.find((item) => item.itemId === "ta-gap-1")!;
}

async function contractStore(h: Harness): Promise<{ contracts: Array<{ contractId: string; source: { kind: string }; constraints: { hardNumericFreeze: boolean }; conflicts: Array<{ kind: string }> }>; events: Array<{ kind: string; codes: string[]; target?: string }> }> {
  return JSON.parse(await readFile(join(h.stack.store.researchDir(h.projectId), "edit-contracts.json"), "utf8"));
}

async function sec01(h: Harness): Promise<string> {
  return readFile(join(h.manuscriptDir, introFile), "utf8");
}

describe("M15.20 E1 —— 审计摘要改写越权（真实形态派生）在工作流中被阻断", () => {
  it("E1-NUM + E1-SENT + E1-PLAN + E1-ADVICE：Planner 文本自称已批准并点名旧→新；Writer 换数删句 → 摘要字节不变、不 handled、复评非 VALIDATED_FIXED", async () => {
    const h = await setup({ planner: "audit_e1", writer: "real_violation" });
    const before = await outlineAbstract(h);
    const sec01Before = await sec01(h);
    const store0 = await contractStore(h);
    const audit = store0.contracts.find((contract) => contract.source.kind === "target_audit_rewrite")!;
    expect(audit.constraints.hardNumericFreeze).toBe(true);
    expect((await instruction(h, h.rewriteId)).origin?.contractId).toBe(audit.contractId);
    const payload = await toPlanConfirm(h);
    // UI / API 如实展示：可写范围、受保护数值、关联审计硬禁改、计划文本改数告警
    const previews = payload["editContracts"] as Array<{ target: string; linkedAuditContract?: { hardNumericFreeze: boolean }; unstructuredValueChangeWarning?: string; protectedValueCount: number }>;
    const abstractPreview = previews.find((preview) => preview.target === "abstract")!;
    expect(abstractPreview.linkedAuditContract?.hardNumericFreeze).toBe(true);
    expect(abstractPreview.unstructuredValueChangeWarning).toMatch(/不构成改数授权/);
    expect(abstractPreview.protectedValueCount).toBeGreaterThanOrEqual(4);
    expect(typeof payload["planHash"]).toBe("string");
    await runToEnd(h);
    // 正式稿：摘要逐字不变；sec01 未被换数
    expect(await outlineAbstract(h)).toBe(before);
    expect(await sec01(h)).toBe(sec01Before);
    const main = await readFile(join(h.manuscriptDir, "main.tex"), "utf8");
    expect(main).toContain("5.402/6.075");
    expect(main).not.toContain("3.312/6.075");
    // 指令不 handled；复评不是 VALIDATED_FIXED
    expect((await instruction(h, h.rewriteId)).status).not.toBe("handled");
    expect((await closure(h)).closure).not.toBe("VALIDATED_FIXED");
    // lineage：拒绝事件带结构化错误码
    const store = await contractStore(h);
    const rejected = store.events.filter((event) => event.kind === "candidate_rejected" && event.target === "abstract");
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]!.codes).toEqual(expect.arrayContaining(["EDIT_CONTRACT_OUT_OF_SCOPE", "EDIT_CONTRACT_PROTECTED_VALUE_CHANGED"]));
    expect(store.events.some((event) => event.kind === "candidate_accepted" && event.target === "abstract")).toBe(false);
    // E1-PATH：同一越权经引言（文件级载体）进入 → 同样拒绝（审计契约目标不符 + 受保护数值变化）
    expect((await sec01(h))).toContain("5.402/6.075");
    const introRejected = store.events.filter((event) => event.kind === "candidate_rejected" && event.target === introFile);
    expect(introRejected.length).toBeGreaterThan(0);
    expect(introRejected[0]!.codes).toEqual(expect.arrayContaining(["EDIT_CONTRACT_TARGET_MISMATCH"]));
  });

  it("E1-NUM（隔离）：仅换数、其余逐字 → 拒绝（PROTECTED_VALUE_CHANGED / NEW_VALUE）", async () => {
    const h = await setup({ planner: "audit_e1", writer: "numbers_only" });
    const before = await outlineAbstract(h);
    await toPlanConfirm(h);
    await runToEnd(h);
    expect(await outlineAbstract(h)).toBe(before);
    const rejected = (await contractStore(h)).events.filter((event) => event.kind === "candidate_rejected" && event.target === "abstract");
    expect(rejected[0]?.codes).toEqual(expect.arrayContaining(["EDIT_CONTRACT_PROTECTED_VALUE_CHANGED", "EDIT_CONTRACT_NEW_VALUE"]));
  });

  it("E1-SENT（隔离）：数字保留但删掉两句无关句 → 拒绝（OUT_OF_SCOPE）", async () => {
    const h = await setup({ planner: "audit_e1", writer: "extra_deletions" });
    const before = await outlineAbstract(h);
    await toPlanConfirm(h);
    await runToEnd(h);
    expect(await outlineAbstract(h)).toBe(before);
    const rejected = (await contractStore(h)).events.filter((event) => event.kind === "candidate_rejected" && event.target === "abstract");
    expect(rejected[0]?.codes).toEqual(["EDIT_CONTRACT_OUT_OF_SCOPE"]);
  });

  it("合法正例：数值全部保留，仅在授权锚内加限定语 → 落盘、handled、复评 VALIDATED_FIXED（契约 SATISFIED）", async () => {
    const h = await setup({ planner: "audit_e1", writer: "legal_qualify" });
    await toPlanConfirm(h);
    await runToEnd(h);
    const after = await outlineAbstract(h);
    expect(after).toContain("under the respective detection settings");
    expect(after).toContain("5.402/6.075");
    expect(after).toContain("11.549/12.789");
    expect((await instruction(h, h.rewriteId)).status).toBe("handled");
    const item = await closure(h);
    expect(item.closure).toBe("VALIDATED_FIXED");
    expect(item.editContract?.status).toBe("SATISFIED");
  });

  it("E1-APPROVE：plan_confirm 携带结构化值对试图解除审计硬禁改 → 409；伪造计划外值对 → 409；旧计划哈希 → 409", async () => {
    const h = await setup({ planner: "audit_structured_change", writer: "numbers_only" });
    const payload = await toPlanConfirm(h);
    const planHash = payload["planHash"] as string;
    const approvalToken = payload["approvalToken"] as string;
    const blocked = await h.stack.request("POST", `/api/runs/${h.runId}/resume`, { decision: "approve", payload: { planHash, approvalToken, approvedFactChanges: [{ itemId: "improvement:1", before: "5.402", after: "3.312" }] } });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toMatch(/硬禁改|EDIT_CONTRACT_VIOLATION/);
    const forged = await h.stack.request("POST", `/api/runs/${h.runId}/resume`, { decision: "approve", payload: { planHash, approvalToken, approvedFactChanges: [{ itemId: "improvement:1", before: "11.549", after: "9.798" }] } });
    expect(forged.status).toBe(409);
    const stale = await h.stack.request("POST", `/api/runs/${h.runId}/resume`, { decision: "approve", payload: { planHash: "0".repeat(64), approvalToken } });
    expect(stale.status).toBe(409);
    // 普通批准（不解除禁改）→ 禁改仍生效
    const before = await outlineAbstract(h);
    await runToEnd(h, { planHash, approvalToken });
    expect(await outlineAbstract(h)).toBe(before);
    expect((await instruction(h, h.rewriteId)).status).not.toBe("handled");
  });

  it("E1-LEGACY（重新批准）：旧审批无契约 → 在审计计划中再次 approve 即补冻结契约（同一指令，不重复派发）", async () => {
    const h = await setup({ planner: "audit_e1", writer: "legal_qualify" });
    const path = join(h.stack.store.reviewsDir(h.projectId), "external-instructions.json");
    const stored = JSON.parse(await readFile(path, "utf8")) as { instructions: Array<{ instructionId: string; origin?: Record<string, unknown> }> };
    for (const entry of stored.instructions) if (entry.instructionId === h.rewriteId) delete entry.origin!["contractId"];
    await writeFile(path, JSON.stringify(stored), "utf8");
    expect((await instruction(h, h.rewriteId)).origin?.contractId).toBeUndefined();
    const again = await h.stack.request("POST", `/api/projects/${h.projectId}/target/evidence-audit/revision-plan/decide`, { decisions: [{ itemId: "ta-gap-1", decision: "approve" }] });
    expect(again.status).toBe(200);
    const reapproved = await instruction(h, h.rewriteId);
    expect(reapproved.origin?.contractId).toMatch(/^ec-/);
    const store = await contractStore(h);
    expect(store.contracts.some((contract) => contract.contractId === reapproved.origin?.contractId && contract.source.kind === "target_audit_rewrite")).toBe(true);
    const list = (await h.stack.request("GET", `/api/projects/${h.projectId}/external-instructions`)).body["instructions"] as Array<{ source: string }>;
    expect(list.filter((entry) => entry.source === "target_audit").length).toBe(2); // 改写 + 作者裁决各一条，不重复新增
  });

  it("E1-LEGACY：旧审批（指令无冻结契约）→ 不派发、REAPPROVAL_REQUIRED；摘要不变；复评不判已修复", async () => {
    const h = await setup({ planner: "audit_e1", writer: "real_violation" });
    // 模拟 M15.19 之前的旧审批：指令 origin 无 contractId
    const path = join(h.stack.store.reviewsDir(h.projectId), "external-instructions.json");
    const stored = JSON.parse(await readFile(path, "utf8")) as { instructions: Array<{ instructionId: string; origin?: Record<string, unknown> }> };
    for (const entry of stored.instructions) if (entry.instructionId === h.rewriteId) delete entry.origin!["contractId"];
    await writeFile(path, JSON.stringify(stored), "utf8");
    const before = await outlineAbstract(h);
    await toPlanConfirm(h);
    await runToEnd(h);
    expect(await outlineAbstract(h)).toBe(before);
    const legacy = await instruction(h, h.rewriteId);
    expect(legacy.status).toBe("unresolved");
    expect(legacy.statusNote).toMatch(/^EDIT_CONTRACT_REAPPROVAL_REQUIRED/);
    expect((await closure(h)).closure).not.toBe("VALIDATED_FIXED");
  });

  it("E1-STALE：批准后摘要被改动 → 契约陈旧、不派发；复用旧批准不可能", async () => {
    const h = await setup({ planner: "audit_e1", writer: "real_violation" });
    const outlinePath = join(h.manuscriptDir, "outline.json");
    const outline = JSON.parse(await readFile(outlinePath, "utf8")) as { abstract: string };
    outline.abstract = `${outline.abstract} Additional author sentence.`;
    await writeFile(outlinePath, JSON.stringify(outline), "utf8");
    const changed = await outlineAbstract(h);
    await toPlanConfirm(h);
    await runToEnd(h);
    expect(await outlineAbstract(h)).toBe(changed);
    const stale = await instruction(h, h.rewriteId);
    expect(stale.statusNote).toMatch(/^EDIT_CONTRACT_STALE/);
  });
});

describe("M15.20 —— 普通改进计划：值变更只来自结构化逐项批准", () => {
  it("计划文本自称已批准并给出 expectedFactChanges，但作者只做普通批准 → 值变更被拒（数值不变）", async () => {
    const h = await setup({ planner: "plain_value_change", writer: "legal_qualify" });
    const payload = await toPlanConfirm(h);
    const previews = payload["editContracts"] as Array<{ target: string; proposedValueChanges: Array<{ before: string; after: string }> }>;
    expect(previews.find((preview) => preview.target === experimentsFile)?.proposedValueChanges).toEqual([{ before: "45.042", after: "45.04", basis: "表格精度", blockedByHardFreeze: false }]);
    await runToEnd(h, { planHash: payload["planHash"], approvalToken: payload["approvalToken"] });
    expect(await readFile(join(h.manuscriptDir, experimentsFile), "utf8")).toContain("45.042");
  });

  it("合法正例：作者在 plan_confirm 逐项勾选结构化值对 → 精确放行（其它数值仍受保护）", async () => {
    const h = await setup({ planner: "plain_value_change", writer: "legal_qualify" });
    const payload = await toPlanConfirm(h);
    await runToEnd(h, { planHash: payload["planHash"], approvalToken: payload["approvalToken"], approvedFactChanges: [{ itemId: "improvement:1", before: "45.042", after: "45.04" }] });
    const sec03 = await readFile(join(h.manuscriptDir, experimentsFile), "utf8");
    expect(sec03).toContain("45.04 HOTA");
    expect(sec03).not.toContain("45.042");
    expect(sec03).toContain("57.108");
    const store = await contractStore(h);
    expect(store.contracts.some((contract) => contract.source.kind === "improvement_plan_item")).toBe(true);
  });
});
