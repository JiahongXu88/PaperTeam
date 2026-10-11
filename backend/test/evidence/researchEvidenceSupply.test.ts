import { afterAll, describe, expect, it, vi } from "vitest";
import { startTestStack, scriptedIdeaRuntime, RESEARCH_JSON, type TestStack } from "../helpers/testStack.js";
import { supplyResearchEvidence } from "../../src/evidence/ResearchEvidenceSupply.js";
import { selectQuoteWindow } from "../../src/evidence/TargetedGroundingService.js";
import type { ResearchArtifact } from "../../src/agents/ResearcherService.js";
import { createIdeaToPaperDefinition } from "../../src/workflow/definitions.js";
import { minimalPdf } from "../retrieval/fixtures.js";
import { fakeScholarlyProvider, canonicalRecord } from "./fixtures.js";

vi.setConfig({ testTimeout: 30000 });
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
const claim = "Retrieval augmented generation reduces hallucination in question answering.";
const text = claim + " Retrieval supplies relevant external documents to the generator. The experiment compares factual responses under identical conditions and records every source passage for reproducibility.";
const artifact: ResearchArtifact = {
  generatedAt: "2026-10-11", taskId: "public-fixture",
  report: { domainOverview: claim, relatedWorkDirections: ["Retrieval augmented generation hallucination"],
    researchGaps: ["Further evaluation required"], potentialContributions: [], researchQuestions: [], literaturePlan: [] },
  evidence: [], bibliography: [],
};
async function setup(judge?: string) {
  const scripted = scriptedIdeaRuntime(judge ? { evidenceJudgeOutput: judge } : {});
  const originalRun = scripted.runtime.runAgent.bind(scripted.runtime);
  scripted.runtime.runAgent = async (input) => {
    const result = await originalRun(input);
    return input.contextScope === "research" ? { ...result, output: JSON.stringify({ ...JSON.parse(RESEARCH_JSON), domainOverview: claim, evidence: [] }) } : result;
  };
  const stack = await startTestStack(scripted.runtime, { registerCleanup: (c) => cleanups.push(c),
    citation: { metadataEnabled: false, scholarly: { providers: [fakeScholarlyProvider(() => ({
      kind: "match", record: canonicalRecord({ title: "Retrieval augmented generation hallucination", doi: "10.1000/supply", authors: ["Doe, Jane"], year: 2023 }),
    }))] } },
  });
  const project = await stack.store.create("Retrieval augmented generation hallucination", { researchIdea: "Retrieval evaluation" });
  await stack.stack.candidates.add(project.id, { origin: "academic_search", provider: "public-fixture",
    title: "Retrieval augmented generation hallucination", authors: ["Doe, Jane"], year: 2023, doi: "10.1000/supply" });
  return { stack, project, scripted };
}
function accessibleText(stack: TestStack) {
  return vi.spyOn(stack.stack.sourceImport, "tryResolveFullText").mockImplementation(async (projectId, sourceId) => {
    const attached = await stack.stack.sources.attachFile(projectId, sourceId, { fileName: "public-synthetic.pdf", content: minimalPdf(text) });
    return { outcome: attached.attached ? "resolved" : "skipped_has_file", source: attached.source };
  });
}
describe("research supply with real stores, lexical retrieval and grounding; controlled downloader/judge", () => {
  it("Candidate → Source → Chunk → Verified → Writer formal view; rerun keeps IDs", async () => {
    const { stack, project } = await setup();
    accessibleText(stack);
    const first = await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    expect(first).toMatchObject({ reviewed: 1, selected: 1, promoted: 1, fulltext: 1, chunkedSources: 1, proposed: 1, verified: 1, formalEvidence: 1 });
    const formal = (await stack.stack.workflowServices.evidenceSelection.selectForWriting(project.id)).formal;
    expect(formal).toHaveLength(1);
    expect(formal[0]!.verificationMethod).toContain("metadata=match");
    console.log("SUPPLY_FIXTURE_COUNTS", JSON.stringify(first));
    expect(text.includes(formal[0]!.quote!)).toBe(true);
    expect(first.mappings[0]!.chunkId).toBe(formal[0]!.location!.chunk);
    const second = await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    expect(second).toMatchObject({ promoted: 0, alreadyExists: 1, proposed: 0, formalEvidence: 1 });
    expect(second.mappings).toEqual(first.mappings);
    expect(await stack.stack.sources.list(project.id)).toHaveLength(1);
    expect((await stack.stack.workflowServices.evidenceSelection.selectForWriting(project.id)).formal[0]!.id).toBe(formal[0]!.id);
    const other = await stack.store.create("Unrelated isolated project");
    expect((await stack.stack.workflowServices.evidenceSelection.selectForWriting(other.id)).formal).toHaveLength(0);
  });
  it("metadata-only cannot produce evidence", async () => {
    const { stack, project } = await setup();
    const r = await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    expect(r.promoted).toBe(1); expect(r.fulltext).toBe(0); expect(r.proposed).toBe(0); expect(r.formalEvidence).toBe(0);
  });
  it("opposing/unsupported claim is rejected and stays rejected on retry", async () => {
    const { stack, project } = await setup(JSON.stringify({ verdict: "unsupported", reason: "The passage contradicts the claim" }));
    accessibleText(stack);
    const opposing = { ...artifact, report: { ...artifact.report, domainOverview: "Retrieval augmented generation increases hallucination in question answering." } };
    const first = await supplyResearchEvidence(stack.stack.workflowServices, project.id, opposing);
    expect(first.rejected).toBeGreaterThan(0); expect(first.formalEvidence).toBe(0);
    const second = await supplyResearchEvidence(stack.stack.workflowServices, project.id, opposing);
    expect(second.proposed).toBe(0); expect(second.formalEvidence).toBe(0);
  });
  it("nonexistent quote fails deterministic verification", async () => {
    const { stack, project } = await setup(); accessibleText(stack);
    await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    const source = (await stack.stack.sources.list(project.id))[0]!;
    const chunk = (await stack.stack.retrieval.search(project.id, "retrieval hallucination")).results[0]!.chunk;
    const proposal = await stack.stack.evidenceGrounding.propose(project.id, { sourceId: source.sourceId, chunkId: chunk.chunkId,
      claim, quote: "This sentence does not exist anywhere in the source document.", proposedBy: "fixture" });
    expect((await stack.stack.evidenceGrounding.ground(project.id, proposal.candidate.candidateId)).status).toBe("mismatch");
  });
  it("cancellation after ingestion resumes without duplicate Source or Evidence", async () => {
    const { stack, project } = await setup();
    const controller = new AbortController();
    const resolver = accessibleText(stack);
    const impl = resolver.getMockImplementation()!;
    resolver.mockImplementationOnce(async (...args) => { const r = await impl(...args); controller.abort(); return r; });
    await expect(supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact, { signal: controller.signal })).rejects.toThrow();
    expect((await stack.stack.workflowServices.evidenceSelection.selectForWriting(project.id)).formal).toHaveLength(0);
    const resumed = await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    expect(resumed).toMatchObject({ promoted: 0, alreadyExists: 1, formalEvidence: 1 });
    expect(await stack.stack.sources.list(project.id)).toHaveLength(1);
  });
  it("unavailable judge stops further attempts without fabricating support", async () => {
    const { stack, project, scripted } = await setup("invalid judge output"); accessibleText(stack);
    const r = await supplyResearchEvidence(stack.stack.workflowServices, project.id, { ...artifact, report: { ...artifact.report, domainOverview: claim + " Another retrieval claim about hallucination in question answering." } });
    expect(r.formalEvidence).toBe(0); expect(r.unverifiable).toBeGreaterThan(0);
    expect(scripted.calls.filter((call) => call.contextScope?.startsWith("citation/evidence/")).length).toBe(1);
    const previousRun = scripted.runtime.runAgent.bind(scripted.runtime);
    scripted.runtime.runAgent = async (input) => {
      const result = await previousRun(input);
      return input.contextScope?.startsWith("citation/evidence/")
        ? { ...result, output: JSON.stringify({ verdict: "supported", reason: "Controlled recovery judge" }) } : result;
    };
    const recovered = await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    expect(recovered).toMatchObject({ proposed: 0, formalEvidence: 1 });
  });
  it("manual/rejected/unrelated candidates are not promoted; review and source budgets apply", async () => {
    const { stack, project } = await setup();
    for (let i = 0; i < 20; i++) await stack.stack.candidates.add(project.id, { origin: "academic_search", provider: "fixture",
      title: `Retrieval augmented generation hallucination ${i}`, authors: ["Doe, Jane"], year: 2023, doi: `10.1000/bound${i}` });
    await stack.stack.candidates.add(project.id, { title: "Manual retrieval generation", doi: "10.1000/manual" });
    const r = await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    expect(r.reviewed).toBe(12); expect(r.selected).toBe(6); expect(r.promoted).toBe(6); expect(r.formalEvidence).toBe(0);
  });
  it("workflow runs auto supply before feasibility/writing and records diagnostics", async () => {
    const { stack, project, scripted } = await setup(); accessibleText(stack);
    const started = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = started.body["runId"] as string;
    let run: Record<string, any> = {};
    for (let i = 0; i < 500; i++) {
      run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, any>;
      if (["awaiting_input", "failed"].includes(run["status"])) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(run["status"], JSON.stringify(run["error"])).toBe("awaiting_input");
    expect(run["stageResults"]["evidence.ground"]["researchSupply"]["promoted"]).toBe(1);
    expect(run["stageResults"]["evidence.ground"]["researchSupply"]["formalEvidence"]).toBe(1);
    expect(createIdeaToPaperDefinition(stack.stack.workflowServices).kind).toBe("idea_to_paper");
    for (let i = 0; i < 500; i++) {
      run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, any>;
      if (scripted.tasks.some((task) => task.contextScope?.startsWith("writing/sections"))) break;
      if (run["status"] === "awaiting_input") await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
      if (["failed", "completed"].includes(run["status"])) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const writerTasks = scripted.tasks.filter((task) => task.contextScope?.startsWith("writing/sections"));
    expect(writerTasks.length).toBeGreaterThan(0);
    expect(writerTasks.some((task) => task.task.includes(claim))).toBe(true);
    expect(run["stageResults"]["hitl.evidence_supply"]).toBeUndefined();
    await stack.request("POST", `/api/runs/${runId}/cancel`, {});
  });
  it("concurrent proposals and grounding reuse one candidate and evidence record", async () => {
    const { stack, project } = await setup(); accessibleText(stack);
    await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    const chunk = (await stack.stack.retrieval.search(project.id, "retrieval hallucination")).results[0]!.chunk;
    const input = { sourceId: chunk.sourceId, chunkId: chunk.chunkId, claim: "Relevant external documents support retrieval augmented generation.", quote: chunk.text, proposedBy: "fixture" };
    const proposals = await Promise.all(Array.from({ length: 4 }, () => stack.stack.evidenceGrounding.propose(project.id, input)));
    expect(new Set(proposals.map((p) => p.candidate.candidateId)).size).toBe(1);
    const results = await Promise.all(proposals.map((p) => stack.stack.evidenceGrounding.ground(project.id, p.candidate.candidateId)));
    expect(new Set(results.map((r) => r.evidenceId)).size).toBe(1);
    expect((await stack.stack.evidenceGrounding.candidateStats(project.id)).total).toBe(2);
    expect((await stack.stack.workflowServices.evidenceSelection.selectForWriting(project.id)).formal).toHaveLength(2);
  });
  it("rejected, manual and unrelated candidates remain outside automatic promotion", async () => {
    const { stack, project } = await setup();
    const candidate = (await stack.stack.candidates.list(project.id))[0]!;
    await stack.stack.candidates.markRejected(project.id, candidate.candidateId);
    await stack.stack.candidates.add(project.id, { origin: "manual", title: "Retrieval generation hallucination", authors: ["Doe, Jane"], year: 2023, doi: "10.1000/manual" });
    await stack.stack.candidates.add(project.id, { origin: "academic_search", provider: "fixture", title: "Marine plankton ecology", authors: ["Doe, Jane"], year: 2023, doi: "10.1000/unrelated" });
    const r = await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    expect(r).toMatchObject({ reviewed: 1, selected: 0, promoted: 0, formalEvidence: 0 });
    expect(r.failures["topic_mismatch"]).toBe(1);
    expect(await stack.stack.sources.list(project.id)).toHaveLength(0);
  });
  it("429 stops remaining fulltext work without evidence", async () => {
    const { stack, project } = await setup();
    await stack.stack.candidates.add(project.id, { origin: "academic_search", provider: "fixture", title: "Retrieval generation hallucination second", authors: ["Doe, Jane"], year: 2023, doi: "10.1000/second" });
    const resolve = vi.spyOn(stack.stack.sourceImport, "tryResolveFullText").mockImplementation(async (id, sourceId) => ({
      outcome: "failed", note: "429 rate_limited", source: await stack.stack.sources.getRequired(id, sourceId),
    }));
    const r = await supplyResearchEvidence(stack.stack.workflowServices, project.id, artifact);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(r.failures["rate_limited_stop"]).toBe(1);
    expect(r.formalEvidence).toBe(0);
  });
  it("quote windows preserve linebreaks and repeated whitespace exactly", () => {
    const input = "First sentence without keywords.\n\n  " + claim + "  Another sentence.";
    expect(input.includes(selectQuoteWindow(claim, input)!)).toBe(true);
  });
});
