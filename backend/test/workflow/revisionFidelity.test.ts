import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import { locateLatexSections } from "../../src/review/revisionScope.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { aggregateReviews } from "../../src/review/ReviewAggregator.js";
import { computeFactPreservationForCandidate } from "../../src/quality/factPreservation.js";
import { buildRevisionPlan } from "../../src/review/revisionPlan.js";

const PAPER = String.raw`\documentclass{article}
\begin{document}
\section{Introduction}\label{sec:intro}
We study compact models.\cite{base}
\section{Method}\label{sec:method}
The model use a compact adapter.\cite{base}

The original representation remains frozen.
The adapter weight is 0.25.
\begin{equation}\label{eq:encoding} E = u + v \end{equation}
\section{Results}\label{sec:results}
Accuracy is 82.4\%.
\begin{equation}\label{eq:score} S = a + b \end{equation}
\begin{tabular}{cc} Method & Score \\ Adapter & 82.4 \\ \end{tabular}
\section{Conclusion}\label{sec:end}
The evaluation uses the stated protocol.\cite{base}
\end{document}
`;
const FORMULA = String.raw`\begin{equation}\label{eq:loss} L = L_{task} + \lambda L_{reg} \end{equation}`;
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

async function setup(proposals: string[], action = "Correct only the grammar of the first sentence.", type = "modify", coverageQuote?: string, paper = PAPER) {
  const scripted = scriptedIdeaRuntime();
  let calls = 0;
  const tasks: string[] = [];
  const runtime = { ...scripted.runtime, runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
    tasks.push(input.task);
    const now = new Date().toISOString();
    return { taskId: `fidelity-${++calls}`, agentId: "writer", status: "completed" as const, createdAt: now, updatedAt: now,
      output: proposals[Math.min(calls - 1, proposals.length - 1)] ?? "", events: [] };
  } };
  const stack = await startTestStack(runtime, { registerCleanup: c => cleanups.push(c) });
  const project = await stack.store.create("Frozen revision fidelity fixture", { language: "en" });
  const services = stack.stack.workflowServices;
  await writeFile(join(stack.store.manuscriptDir(project.id), "main.tex"), paper);
  await writeFile(join(stack.store.manuscriptDir(project.id), "references.bib"), "@article{base,title={Frozen source},year={2020}}");
  await services.revisions.commit(project.id, "baseline");
  const plan = { items: [{ id: "improvement:1", section: "main.tex", logicalSection: "sec:method", actionType: type, action, rationale: "Reviewer requests a focused change", priority: "high", ...(coverageQuote ? { coverageQuote } : {}) }] };
  await writeFile(join(stack.store.researchDir(project.id), "improvement-plan.json"), JSON.stringify({ plan }));
  const definition = createExistingPaperDefinition(services);
  const stage = definition.stages.find(s => s.id === "revision.apply")!;
  const ctx = { projectId: project.id, runId: "fidelity", attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
  const execute = async () => { if (!("execute" in stage)) throw new Error("Wrong stage"); return stage.execute(ctx); };
  const validate = async () => {
    await services.reviewArtifacts.saveSummary(project.id, 1, { ...aggregateReviews([], 1), reviewedRevision: 1 });
    const validation = definition.stages.find(s => s.id === "revision.validate")!;
    if (!("execute" in validation)) throw new Error("Wrong stage");
    return validation.execute(ctx);
  };
  const revise = async () => {
    const stage = definition.stages.find(s => s.id === "revision.revise")!;
    if (!("execute" in stage)) throw new Error("Wrong stage");
    return stage.execute(ctx);
  };
  return { stack, project, services, tasks, execute, validate, revise, calls: () => calls,
    source: () => readFile(join(stack.store.manuscriptDir(project.id), "main.tex"), "utf8"),
    artifact: async () => services.reviewArtifacts.loadPatchValidation(project.id, await services.revisions.currentRevision(project.id)) };
}
const method = locateLatexSections("main.tex", PAPER).find(s => s.label === "sec:method")!.content;
const good = method.replace("model use", "model uses");

describe("M13.7.5 production revision.apply fidelity", () => {
  it("local grammar change keeps every other span, formula, number and citation byte-identical", async () => {
    const run = await setup([good]);
    await run.execute();
    expect(await run.source()).toBe(PAPER.replace("model use", "model uses"));
    expect(run.calls()).toBe(1);
    const revision = await run.services.revisions.currentRevision(run.project.id);
    await run.services.revisions.commit(run.project.id, "idempotent-check");
    expect(await run.services.revisions.currentRevision(run.project.id)).toBe(revision);
    expect((await run.services.revisions.load(run.project.id)).current).toBe(revision);
  });
  it.each([
    ["citation_removed", good.replace(String.raw`\cite{base}`, "")],
    ["unauthorized_fact_change", good.replace("0.25", "0.75")],
    ["unsupported_claim", good + "\nThe measured latency is 9.7 ms.\n"],
    ["unsupported_claim", good + "\n" + FORMULA + "\n"],
  ])("repairs only the failed target: %s", async (code, bad) => {
    const run = await setup([bad, good]);
    await run.execute();
    expect(await run.source()).toBe(PAPER.replace("model use", "model uses"));
    expect(run.calls()).toBe(2);
    expect(run.tasks[1]).toContain(code);
    expect(run.tasks[1]).toContain("Revise only the patch identified below");
    const artifact = await run.artifact();
    expect(artifact?.summary.patchFirstPassPassRate).toBe(0);
    expect(artifact?.summary.patchRepairSuccessRate).toBe(1);
    await run.validate();
    const reloaded = await run.artifact();
    expect(reloaded?.records).toHaveLength(1);
    expect(reloaded?.attemptHistory).toHaveLength(1);
    expect(reloaded?.summary.patchFirstPassPassRate).toBe(0);
    expect(reloaded?.summary.patchRepairSuccessRate).toBe(1);
  });
  it("identical invalid proposal stops at no-progress without applying scientific invention", async () => {
    const run = await setup([good + "\n" + FORMULA]);
    await run.execute();
    expect(await run.source()).toBe(PAPER);
    expect(run.calls()).toBe(2);
    expect((await run.artifact())?.records.at(-1)?.finalStatus).toBe("no_progress");
  });
  it.each([FORMULA, String.raw`L = L_{task} + \lambda L_{reg}`])("author source permits the exact new formula while preserving existing equations: %s", async quote => {
    const run = await setup([good + "\n" + FORMULA], "增加作者提供的损失函数公式，保留原公式。");
    await run.services.evidence.append(run.project.id, { claim: "Author-provided loss definition", quote,
      verificationStatus: "verified", verificationLevel: "user_confirmed", supportStrength: "direct" }, "user");
    await run.execute();
    expect(await run.source()).toContain(FORMULA);
    expect(await run.source()).toContain(String.raw`\label{eq:encoding} E = u + v`);
    expect(run.calls()).toBe(1);
    const fact = await computeFactPreservationForCandidate(run.services, run.project.id, 1,
      [{ file: "main.tex", content: await run.source() }]);
    expect(fact?.formulaAuthorizations?.[0]?.sourceId).toMatch(/^E/);
  });
  it.each([true, false])("apply without RevisionPlan rechecks Patch evidence (formal=%s)", async formal => {
    const run = await setup([method + "\n" + FORMULA], "增加作者提供的损失函数公式，保留原公式。");
    const evidence = await run.services.evidence.append(run.project.id, { claim: "Author-confirmed loss definition", quote: FORMULA,
      verificationStatus: "verified", verificationLevel: "user_confirmed", supportStrength: "direct",
      ...(formal ? { source: { sourceId: "author-loss-material" }, location: { chunk: "author-loss-material:1" } } : {}) }, "user");
    const path = join(run.stack.store.researchDir(run.project.id), "improvement-plan.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.plan.items[0].relatedEvidenceIds = [evidence.id];
    await writeFile(path, JSON.stringify(data));
    await run.execute();
    expect((await run.artifact())?.records[0]?.finalStatus).toBe("accepted");
    await run.validate();
    const artifact = await run.artifact();
    expect(artifact?.records[0]?.evidence.ok).toBe(formal);
    expect(artifact?.summary.publishable).toBe(formal);
    const validation = await run.services.reviewArtifacts.loadValidation(run.project.id, 1);
    expect(validation?.planId).toBeNull();
    expect(validation?.evidenceRecheck).toEqual([{ evidenceId: evidence.id, stillFormal: formal }]);
    expect(validation?.ok).toBe(formal);
  });

  it("accepts an authorized formula insertion beside an exact quote with immutable trailing newline", async () => {
    const run = await setup([method + "\n" + FORMULA], "增加作者提供的损失函数公式，保留原公式。");
    const evidence = await run.services.evidence.append(run.project.id, { claim: "Author-confirmed loss definition", quote: FORMULA,
      verificationStatus: "verified", verificationLevel: "user_confirmed", supportStrength: "direct",
      source: { sourceId: "author-loss-material" }, location: { chunk: "author-loss-material:1" } }, "user");
    const path = join(run.stack.store.researchDir(run.project.id), "improvement-plan.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.plan.items[0].relatedEvidenceIds = [evidence.id];
    data.plan.items[0].targetQuote = String.raw`\begin{equation}\label{eq:encoding} E = u + v \end{equation}`;
    await writeFile(path, JSON.stringify(data));
    await run.execute();
    expect(run.calls()).toBe(1);
    expect(await run.source()).toContain(FORMULA);
    expect((await run.artifact())?.records[0]?.scope.ok).toBe(true);
    await run.validate();
    expect((await run.artifact())?.summary.publishable).toBe(true);
  });

  it("an accepted sibling is not regenerated when another patch needs repair", async () => {
    const results = locateLatexSections("main.tex", PAPER).find(s => s.label === "sec:results")!.content;
    const fixed = results.replace("Accuracy is", "The accuracy is");
    const run = await setup([good, fixed.replaceAll("82.4", "92.4"), fixed]);
    const path = join(run.stack.store.researchDir(run.project.id), "improvement-plan.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.plan.items.push({ ...data.plan.items[0], id: "improvement:2", logicalSection: "sec:results", action: "Improve only the grammar of the accuracy sentence." });
    await writeFile(path, JSON.stringify(data));
    await run.execute();
    expect(run.calls()).toBe(3);
    expect(await run.source()).toBe(PAPER.replace("model use", "model uses").replace("Accuracy is", "The accuracy is"));
    expect((await run.artifact())?.summary.patchFirstPassPassRate).toBe(0.5);
  });
  it("format-only numeric restatement is accepted without a spurious repair", async () => {
    const run = await setup([good.replace("0.25", "0.250")]);
    await run.execute();
    expect(run.calls()).toBe(1);
    expect(await run.source()).toContain("0.250");
  });
  it.each([false, true])("exact targetQuote constrains section edits (unrelated=%s)", async unrelated => {
    const proposal = unrelated ? good.replace("The original representation remains frozen.", "We retain the frozen original representation.") : good;
    const run = await setup([proposal]);
    const path = join(run.stack.store.researchDir(run.project.id), "improvement-plan.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.plan.items[0].targetQuote = "The model use a compact adapter.";
    await writeFile(path, JSON.stringify(data));
    await run.execute();
    expect(await run.source()).toBe(unrelated ? PAPER : PAPER.replace("model use", "model uses"));
    expect(run.calls()).toBe(1);
    expect(run.tasks[0]).toContain("唯一允许修改的原文");
    if (unrelated) expect((await run.artifact())?.records[0]?.scope.violations).toContain("REVISION_TARGET_QUOTE_SCOPE_VIOLATION");
  });
  it.each(["This quote does not occur in the frozen source.", "The"])("stale or ambiguous targetQuote is fail-closed: %s", async quote => {
    const run = await setup([good]);
    const path = join(run.stack.store.researchDir(run.project.id), "improvement-plan.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.plan.items[0].targetQuote = quote;
    await writeFile(path, JSON.stringify(data));
    await run.execute();
    expect(await run.source()).toBe(PAPER);
    expect((await run.artifact())?.records[0]?.scope.violations).toContain("REVISION_TARGET_QUOTE_UNRESOLVED");
  });
  it("sentence scope preserves containing-section boundary whitespace without a false rejection", async () => {
    const paper = PAPER.replace("\\section{Method}", "\n\n\\section{Method}").replace("\\section{Results}", "\n\n\\section{Results}");
    const proposal = locateLatexSections("main.tex", paper).find(s => s.label === "sec:method")!.content.replace("model use", "model uses").trim();
    const run = await setup([proposal], undefined, undefined, undefined, paper);
    const path = join(run.stack.store.researchDir(run.project.id), "improvement-plan.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.plan.items[0].targetQuote = "The model use a compact adapter.";
    await writeFile(path, JSON.stringify(data));
    await run.execute();
    expect(await run.source()).toBe(paper.replace("model use", "model uses"));
    expect(run.calls()).toBe(1);
  });
  // Audit probes deliberately pin observed limitations; these are NOT safety PASS criteria.
  it("audit: section scope alone currently permits unrelated prose edits inside that section", async () => {
    const run = await setup([good.replace("The original representation remains frozen.", "We retain the frozen original representation.")]);
    await run.execute();
    expect(await run.source()).toContain("We retain the frozen original representation.");
    expect(run.calls()).toBe(1);
  });
  it("audit: numeric/formula guard alone currently accepts unsupported mechanism prose", async () => {
    const run = await setup([good + "\nFrozen parameters need no optimizer states; optimization occurs in a low-rank subspace.\n"]);
    await run.execute();
    expect(await run.source()).toContain("need no optimizer states");
    expect(run.calls()).toBe(1);
  });
  it.each([
    FORMULA.replace("+", "-"), FORMULA.replace(String.raw`\lambda`, String.raw`\beta`),
    FORMULA.replace("L_{reg}", "2 L_{reg}"),
  ])("a source formula does not authorize changed operators, variables or coefficients", async proposal => {
    const run = await setup([good + "\n" + proposal], "增加损失函数公式。");
    await run.services.evidence.append(run.project.id, { claim: "Author source", quote: FORMULA,
      verificationStatus: "verified", verificationLevel: "user_confirmed", supportStrength: "direct" }, "user");
    await run.execute();
    expect(await run.source()).toBe(PAPER);
  });
  it("Planner workspace path alias and section-addressed author decision do not reopen Writer dispatch", async () => {
    const response = JSON.stringify({ plan: [{ section: "manuscript/main.tex", logicalSection: "sec:method", actionType: "author_decision_required",
      action: "Provide the loss definition", rationale: "Missing loss terms, symbol definitions, weight values and calculation procedure", priority: "high", commentRefs: ["C1"], evidenceRefs: [] }] });
    const run = await setup([response]);
    const instruction = await run.services.externalInstructions.add(run.project.id, { source: "journal_reviewer", text: "补充损失函数的数学表达式，并说明各项权重", section: "sec:method" });
    const instructionId = instruction!.instructionId;
    const plan = await run.stack.stack.writer.planImprovement({ projectId: run.project.id, issues: [], analysisDigest: PAPER,
      feasibilityLevel: "MEDIUM", sectionFiles: ["main.tex"], validEvidenceIds: [], validInstructionIds: [instructionId],
      externalInstructions: [{ instructionId, text: "补充损失函数的数学表达式，并说明各项权重" }],
      commentAliases: [{ ref: "C1", canonicalId: instructionId, text: "补充损失函数的数学表达式，并说明各项权重" }], evidenceAliases: [],
      logicalTargets: [{ file: "main.tex", logicalSection: "sec:method", heading: "Method" }] });
    expect(plan.items[0]?.actionType).toBe("author_decision_required");
    expect(plan.items[0]?.instructionId).toBe(instructionId);
    expect(plan.items[0]?.section).toBe("main.tex");
    await writeFile(join(run.stack.store.researchDir(run.project.id), "improvement-plan.json"), JSON.stringify({ plan }));
    await run.execute();
    expect(run.calls()).toBe(1); // Planner only.
    expect(await run.source()).toBe(PAPER);
    expect((await run.services.externalInstructions.load(run.project.id))[0]?.statusNote).toContain("AUTHOR_DECISION_REQUIRED");
    // Reload and advance into the subsequent deterministic Revision Planner / Writer
    // stage; a sticky author decision must not become a new modify item.
    const summary = { ...aggregateReviews([], 1), reviewedRevision: 1 };
    const followup = buildRevisionPlan({ projectId: run.project.id, sourceRevision: 1, reviewRound: 1, summary,
      externalInstructions: await run.services.externalInstructions.load(run.project.id) });
    expect(followup.items[0]).toMatchObject({ actionType: "author_decision_required", status: "skipped" });
    await run.services.reviewArtifacts.saveSummary(run.project.id, 1, summary);
    await run.services.reviewArtifacts.savePlan(run.project.id, followup);
    await run.revise();
    expect(run.calls()).toBe(1);
    expect(await run.source()).toBe(PAPER);
  });
  it.each([false, true])("misplaced Planner coverageQuote reaches production scope guard (unrelated=%s)", async unrelated => {
    const response = JSON.stringify({ plan: [{ section: "manuscript/main.tex", logicalSection: "sec:method", actionType: "modify",
      action: "Correct only the grammar of the first sentence.", rationale: "Focused grammar correction", priority: "high",
      coverageQuote: "The model use a compact adapter." }] });
    const proposal = unrelated ? good.replace("The original representation remains frozen.", "We retain the frozen original representation.") : good;
    const run = await setup([response, proposal]);
    const plan = await run.stack.stack.writer.planImprovement({ projectId: run.project.id, issues: [], analysisDigest: PAPER,
      feasibilityLevel: "MEDIUM", sectionFiles: ["main.tex"],
      logicalTargets: [{ file: "main.tex", logicalSection: "sec:method", heading: "Method", content: method }] });
    expect(plan.items[0]?.targetQuote).toBe("The model use a compact adapter.");
    await writeFile(join(run.stack.store.researchDir(run.project.id), "improvement-plan.json"), JSON.stringify({ plan }));
    await run.execute();
    expect(run.calls()).toBe(2);
    expect(await run.source()).toBe(unrelated ? PAPER : PAPER.replace("model use", "model uses"));
    const artifact = await run.artifact();
    expect(artifact?.records[0]?.scope.ok).toBe(!unrelated);
    if (unrelated) expect(artifact?.records[0]?.scope.violations).toContain("REVISION_TARGET_QUOTE_SCOPE_VIOLATION");
  });

  it("Reviewer request to add a formula cannot authorize an invented expression", async () => {
    const run = await setup([good + "\n" + FORMULA], "补充损失函数的数学表达式，并说明各项权重；增加公式。");
    await run.execute();
    expect(await run.source()).toBe(PAPER);
  });
  it.each(["noop", "author_decision_required"])("%s dispatches no Writer", async type => {
    const run = await setup([], "Already covered, or needs original loss terms and weights from the author", type, "The original representation remains frozen.");
    await run.execute();
    expect(run.calls()).toBe(0);
    expect(await run.source()).toBe(PAPER);
  });
});
