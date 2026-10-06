import { mkdir, mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pollRunUntilAwaiting, scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";
import type { AgentRuntime, RunAgentInput } from "../../src/runtime/types.js";
import type { WorkflowState } from "../../src/workflow/types.js";
import { vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

function zip(entries: Array<{ name: string; data: string }>): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const data = Buffer.from(entry.data); const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20, 4); item.writeUInt16LE(20, 6); item.writeUInt16LE(8, 10); item.writeUInt32LE(compressed.length, 20); item.writeUInt32LE(data.length, 24); item.writeUInt16LE(name.length, 28); item.writeUInt32LE(offset, 42); central.push(item, name); offset += header.length + name.length + compressed.length;
  }
  const dir = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, dir, end]);
}

const main = String.raw`\documentclass{article}
\begin{document}
\begin{abstract}Abstract baseline.\end{abstract}
\section{Introduction}
Intro baseline.
\section{Datasets}
Datasets baseline.
\section{Method}
Method baseline.
\section{Conclusion}
Conclusion baseline.
\end{document}`;

async function until(stack: TestStack, runId: string, statuses: string[]): Promise<WorkflowState> {
  for (let i = 0; i < 1500; i++) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`); const run = body.run as WorkflowState;
    if (statuses.includes(run.status)) return run;
    if (run.status === "awaiting_input") {
      const stage = run.awaiting?.stageId ?? "";
      const decision = stage === "hitl.revision_stalled" || stage === "hitl.revision_overflow" ? "accept_draft"
        : stage === "hitl.evidence_supply" ? "continue" : "approve";
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision }); continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run poll timeout");
}

describe("Existing Paper workflow direct mutation boundary", () => {
  it.each([
    { mutatedSection: "Conclusion", recoveryFails: false },
    { mutatedSection: "Datasets", recoveryFails: false },
    { mutatedSection: "Conclusion", recoveryFails: true },
    { mutatedSection: null, recoveryFails: false },
  ])("detects direct write and handles recovery for $mutatedSection (recoveryFails=$recoveryFails)", async ({ mutatedSection, recoveryFails }) => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-direct-write-"));
    const scripted = scriptedIdeaRuntime(); let writerCalls = 0; let snapshot = "";
    const runtime: AgentRuntime = {
      ...scripted.runtime,
      async runAgent(input: RunAgentInput) {
        if (input.contextScope === "writing/revision-proposal" && input.projectId) {
          writerCalls++;
          const path = join(root, input.projectId, "manuscript", "main.tex"); snapshot = await readFile(path, "utf8");
          if (mutatedSection === null) {
            // Clean proposal path; no workspace write.
          } else if (recoveryFails) {
            await unlink(path);
            await mkdir(path);
          } else {
            const polluted = snapshot.replace(`${mutatedSection} baseline.`, `${mutatedSection} poisoned.`);
            await (await import("node:fs/promises")).writeFile(path, polluted, "utf8");
          }
        }
        return scripted.runtime.runAgent(input);
      },
    };
    const stack = await startTestStack(runtime, { root, registerCleanup: (fn) => cleanups.push(fn) });
    const project = await stack.store.create(`synthetic direct mutation ${mutatedSection}`);
    const archive = zip([{ name: "main.tex", data: main }, { name: "references.bib", data: "" }]);
    expect((await stack.request("POST", `/api/projects/${project.id}/import`, { archiveBase64: archive.toString("base64") })).status).toBe(200);
    expect((await stack.request("POST", `/api/projects/${project.id}/external-instructions`, { source: "advisor", text: "Clarify dataset coverage.", section: "Datasets" })).status).toBe(200);
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "existing_paper_improvement" });
    const runId = created.body.runId as string;
    const waiting = await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm", { timeoutMs: 30_000 });
    expect(waiting.awaiting?.stageId).toBe("hitl.plan_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const failed = await until(stack, runId, ["failed", "completed"]);
    if (mutatedSection === null) {
      expect(failed.status).toBe("completed");
      const artifact = JSON.parse(await readFile(join(root, project.id, "reviews", "patch-validation-rev-2.json"), "utf8")) as { records: Array<Record<string, unknown>>; summary: Record<string, unknown> };
      expect(artifact.records[0]).toMatchObject({ overall: "pass", scope: { ok: true }, workspaceIntegrity: { ok: true, directMutationDetected: false }, apply: { ok: true, status: "applied" } });
      expect(artifact.records[0]).toMatchObject({ fact: { ok: true }, citation: { ok: true, findingIds: [], violations: [] }, evidence: { ok: true } });
      // M11.4 边界换行修复后结构保持完整：第二轮还能再派发并应用一个 scoped patch
      expect(artifact.summary).toMatchObject({ totalPatches: 2, passedPatches: 2, failedPatches: 0 });
      const gate = JSON.parse(await readFile(join(root, project.id, "reviews", "quality-gate-r2.json"), "utf8")) as { gate: { rules: Array<{ rule: string; passed: boolean }> } };
      expect(gate.gate.rules).toContainEqual(expect.objectContaining({ rule: "patch_validation_publishable", passed: true }));
      return;
    }
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toContain(recoveryFails ? "REVISION_WORKSPACE_RECOVERY_FAILED" : "DIRECT_WORKSPACE_MUTATION");
    const path = join(root, project.id, "manuscript", "main.tex");
    if (recoveryFails) await expect(readFile(path, "utf8")).rejects.toThrow();
    else expect(await readFile(path, "utf8")).toBe(snapshot);
    expect(writerCalls, `stage=${failed.error?.stageId}; scripted=${JSON.stringify(scripted.calls)}`).toBe(1);
    const revisions = await stack.stack.revisions.load(project.id);
    expect(revisions.current).toBe(1);
    const artifact = JSON.parse(await readFile(join(root, project.id, "reviews", "patch-validation-rev-2.json"), "utf8")) as {
      records: Array<Record<string, any>>;
      summary: { failedPatches: number; publishable: boolean };
    };
    expect(artifact.records).toHaveLength(1);
    expect(artifact.records[0]).toMatchObject({
      revisionId: "rev-2",
      file: "main.tex",
      logicalTarget: expect.any(String),
      planItemIds: expect.any(Array),
      commentIds: expect.any(Array),
      beforeFileHash: createHash("sha256").update(snapshot).digest("hex"),
      ...(recoveryFails ? {} : { afterFileHash: createHash("sha256").update(snapshot).digest("hex") }),
      workspaceIntegrity: { ok: false, directMutationDetected: true, recoveryAttempted: true, recoverySucceeded: !recoveryFails },
      scope: { ok: false, violations: ["DIRECT_WORKSPACE_MUTATION"] },
      apply: { ok: false, status: "rejected" },
      overall: "fail",
    });
    expect(artifact.summary).toMatchObject({ failedPatches: 1, publishable: false });
    const instructions = JSON.parse(await readFile(join(root, project.id, "reviews", "external-instructions.json"), "utf8")) as Array<{ status: string }>;
    expect(instructions[0]?.status).not.toBe("handled");
    await expect(readFile(join(root, project.id, "acceptance", "PAPERTEAM_CANDIDATE_FREEZE.json"))).rejects.toThrow();
  });

  it("attributes a missing citation to only its same-file patch and keeps the sibling comment isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-citation-patch-"));
    const scripted = scriptedIdeaRuntime();
    let injected = 0;
    let citationRepairs = 0;
    const runtime: AgentRuntime = {
      ...scripted.runtime,
      async runAgent(input: RunAgentInput) {
        const result = await scripted.runtime.runAgent(input);
        if (input.contextScope === "writing/revision-proposal" && input.task.includes("Patch-local validation repair") && result.output) {
          citationRepairs += 1;
          result.output = result.output.replace(/\\cite\{missing_fake_key\}/g, "");
        }
        if (input.contextScope === "writing/revision-proposal" && input.task.includes("Datasets") &&
          !input.task.includes("Patch-local validation repair") && result.output) {
          injected++;
          result.output = `${String.raw`\cite{missing_fake_key}`}\n${result.output}`;
        }
        return result;
      },
    };
    const stack = await startTestStack(runtime, { root, registerCleanup: (fn) => cleanups.push(fn) });
    const project = await stack.store.create("synthetic same-file citation attribution");
    const archive = zip([{ name: "main.tex", data: main }, { name: "references.bib", data: "@article{known2024, title={Known}, year={2024}}" }]);
    expect((await stack.request("POST", `/api/projects/${project.id}/import`, { archiveBase64: archive.toString("base64") })).status).toBe(200);
    expect((await stack.request("POST", `/api/projects/${project.id}/external-instructions`, { source: "journal_reviewer", text: "Clarify the conclusion.", section: "Conclusion" })).status).toBe(200);
    expect((await stack.request("POST", `/api/projects/${project.id}/external-instructions`, { source: "journal_reviewer", text: "Clarify the datasets.", section: "Datasets" })).status).toBe(200);
    expect((await stack.stack.externalInstructions.load(project.id))).toHaveLength(2);
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "existing_paper_improvement" });
    const runId = created.body.runId as string;
    await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm", { timeoutMs: 30_000 });
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const finalRun = await until(stack, runId, ["failed", "completed"]);
    expect(finalRun.status, JSON.stringify(finalRun.error)).toBe("completed");
    expect(injected).toBe(1);
    expect(citationRepairs).toBeGreaterThan(0);
    expect(await readFile(join(root, project.id, "manuscript", "main.tex"), "utf8")).not.toContain("missing_fake_key");
    expect(scripted.calls.filter((call) => call.contextScope === "writing/revision-proposal")).toHaveLength(4);
    const revisions = await stack.stack.revisions.load(project.id);
    const artifact = JSON.parse(await readFile(join(root, project.id, "reviews", `patch-validation-rev-${revisions.current}.json`), "utf8")) as {
      records: Array<{ logicalTarget: string; commentIds: string[]; attempt?: number; overall: string; citation: { ok: boolean; findingIds: string[]; addedKeys: string[]; violations: string[] } }>;
      attemptHistory?: Array<{ logicalTarget: string; attempt?: number; overall: string; citation: { ok: boolean } }>;
      summary: { publishable: boolean; unattributedViolations: string[]; logicalPatchCount: number; repairSuccessCount: number };
    };
    const attempts = [...artifact.records, ...(artifact.attemptHistory ?? [])];
    expect(attempts.find((record) => record.attempt === 0)).toMatchObject({ overall: "fail", citation: { ok: false, addedKeys: ["missing_fake_key"], violations: ["citation key missing_fake_key is not in verified bibliography"] } });
    expect(attempts.find((record) => record.attempt === 1)).toMatchObject({ overall: "pass", citation: { ok: true } });
    expect(artifact.summary).toMatchObject({ publishable: true, logicalPatchCount: 3, repairSuccessCount: 1 });
    const gateDebug = await readFile(join(root, project.id, "reviews", "quality-gate-r2.json"), "utf8");
    expect(gateDebug).toContain("patch_validation_publishable");
    expect(artifact.summary.unattributedViolations).toEqual([]);
    const instructionFile = await stack.stack.externalInstructions.load(project.id);
    expect(instructionFile.find((entry) => entry.text.includes("datasets"))?.status).toBe("handled");
    expect(instructionFile.find((entry) => entry.text.includes("conclusion"))?.status).toBe("handled");
  });

  it("bounds repeated direction-flip repair and keeps the rejected candidate out of the manuscript", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-direction-repair-"));
    const scripted = scriptedIdeaRuntime();
    let primaryCalls = 0;
    let repairCalls = 0;
    const runtime: AgentRuntime = {
      ...scripted.runtime,
      async runAgent(input: RunAgentInput) {
        if (input.contextScope === "writing/revision-proposal") {
          const instructionId = /--- 意见 (x-[a-z0-9]+)（/.exec(input.task)?.[1] ?? "x-missing";
          const outcome = `\n%%%PT-OUTCOMES%%% [{"instructionId":"${instructionId}","outcome":"applied","basis":"preserved the measured decline"}]`;
          if (input.task.includes("Revise only the patch identified below.")) {
            repairCalls += 1;
            const base = await scripted.runtime.runAgent(input);
            return { ...base, status: "completed", output: `\\section{Conclusion}\nMOTA 提升 from 45 to 28.${outcome}`, taskId: `repair-${repairCalls}` };
          }
          primaryCalls += 1;
          const base = await scripted.runtime.runAgent(input);
          return { ...base, status: "completed", output: `\\section{Conclusion}\nMOTA 提升 from 45 to 28.${outcome}`, taskId: `primary-${primaryCalls}` };
        }
        return scripted.runtime.runAgent(input);
      },
    };
    const stack = await startTestStack(runtime, { root, registerCleanup: (fn) => cleanups.push(fn) });
    const project = await stack.store.create("synthetic direction repair");
    const manuscript = String.raw`\documentclass{article}
\begin{document}
\section{Conclusion}
MOTA 下降 from 45 to 28.
\end{document}`;
    const archive = zip([{ name: "main.tex", data: manuscript }, { name: "references.bib", data: "" }]);
    expect((await stack.request("POST", `/api/projects/${project.id}/import`, { archiveBase64: archive.toString("base64") })).status).toBe(200);
    expect((await stack.request("POST", `/api/projects/${project.id}/external-instructions`, { source: "journal_reviewer", text: "Clarify the MOTA outcome without changing the measured direction.", section: "Conclusion" })).status).toBe(200);
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "existing_paper_improvement" });
    const runId = created.body.runId as string;
    await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm", { timeoutMs: 30_000 });
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const terminal = await until(stack, runId, ["failed", "completed"]);
    expect(terminal.status, JSON.stringify(terminal.stageHistory.slice(-4))).toBe("completed");
    expect(primaryCalls).toBe(2);
    expect(repairCalls).toBe(2);
    const revisions = await stack.stack.revisions.load(project.id);
    const artifact = JSON.parse(await readFile(join(root, project.id, "reviews", `patch-validation-rev-${revisions.current}.json`), "utf8")) as {
      records: Array<{ originalPatchId?: string; attempt?: number; overall: string; logicalTarget: string; rootViolationIds?: string[] }>;
      attemptHistory?: Array<{ originalPatchId?: string; attempt?: number; rootViolationIds?: string[]; overall: string }>;
      summary: { publishable: boolean; failedPatches: number; attemptCount: number; repairExhaustedCount: number };
    };
    const all = [...artifact.records, ...(artifact.attemptHistory ?? [])];
    expect(all.filter((record) => record.overall === "fail" && record.rootViolationIds?.includes("metric_direction_flip"))).toHaveLength(2);
    expect(artifact.summary).toMatchObject({ publishable: false, failedPatches: 1, attemptCount: 2, repairExhaustedCount: 1 });
    expect(await readFile(join(root, project.id, "manuscript", "main.tex"), "utf8")).toContain("MOTA 下降 from 45 to 28");
  });

  it("promotes a repaired metric direction as a new validated attempt and addresses its comment", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-direction-repair-pass-"));
    const scripted = scriptedIdeaRuntime();
    let primaryCalls = 0;
    let repairCalls = 0;
    let linkedInstructionId = "";
    const runtime: AgentRuntime = {
      ...scripted.runtime,
      async runAgent(input: RunAgentInput) {
        if (input.contextScope === "writing/revision-proposal") {
          const instructionId = /--- 意见 (x-[a-z0-9]+)（/.exec(input.task)?.[1] ?? (linkedInstructionId || "x-missing");
          linkedInstructionId = instructionId;
          const outcome = `\n%%%PT-OUTCOMES%%% [{"instructionId":"${instructionId}","outcome":"applied","basis":"restored the verified metric direction"}]`;
          if (input.task.includes("Revise only the patch identified below.")) {
            repairCalls += 1;
            const base = await scripted.runtime.runAgent(input);
            return { ...base, status: "completed", output: `\\section{Conclusion}\nThe measured result remains MOTA 下降 from 45 to 28.${outcome}`, taskId: `repair-pass-${repairCalls}` };
          }
          primaryCalls += 1;
          const base = await scripted.runtime.runAgent(input);
          return { ...base, status: "completed", output: `\\section{Conclusion}\nMOTA 提升 from 45 to 28. The dataset used 999 samples.${outcome}`, taskId: `primary-pass-${primaryCalls}` };
        }
        return scripted.runtime.runAgent(input);
      },
    };
    const stack = await startTestStack(runtime, { root, registerCleanup: (fn) => cleanups.push(fn) });
    const project = await stack.store.create("synthetic direction repair pass");
    const manuscript = String.raw`\documentclass{article}
\begin{document}
\section{Conclusion}
MOTA 下降 from 45 to 28.
\end{document}`;
    const archive = zip([{ name: "main.tex", data: manuscript }, { name: "references.bib", data: "" }]);
    expect((await stack.request("POST", `/api/projects/${project.id}/import`, { archiveBase64: archive.toString("base64") })).status).toBe(200);
    expect((await stack.request("POST", `/api/projects/${project.id}/external-instructions`, { source: "journal_reviewer", text: "Clarify the MOTA outcome without changing the measured direction.", section: "Conclusion" })).status).toBe(200);
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "existing_paper_improvement" });
    const runId = created.body.runId as string;
    await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm", { timeoutMs: 30_000 });
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const terminal = await until(stack, runId, ["failed", "completed"]);
    expect(terminal.status, JSON.stringify(terminal.error)).toBe("completed");
    expect(primaryCalls).toBeGreaterThanOrEqual(1);
    expect(repairCalls).toBeGreaterThanOrEqual(1);
    const artifact = JSON.parse(await readFile(join(root, project.id, "reviews", "patch-validation-rev-2.json"), "utf8")) as {
      records: Array<{ patchId: string; originalPatchId?: string; attempt?: number; parentAttempt?: number; overall: string; fact: { ok: boolean } }>;
      attemptHistory?: Array<{ patchId: string; attempt?: number; overall: string; rootViolationIds?: string[] }>;
      summary: { publishable: boolean; logicalPatchCount: number; attemptCount: number; acceptedPatchCount: number; repairSuccessCount: number };
    };
    const all = [...artifact.records, ...(artifact.attemptHistory ?? [])];
    expect(all.find((record) => record.attempt === 0)).toMatchObject({ patchId: expect.stringMatching(/\.a0$/), overall: "fail", rootViolationIds: expect.arrayContaining(["metric_direction_flip", "unsupported_claim"]) });
    expect(all.find((record) => record.attempt === 1)).toMatchObject({ patchId: expect.stringMatching(/\.a1$/), originalPatchId: expect.any(String), parentAttempt: 0, overall: "pass", fact: { ok: true } });
    expect(artifact.summary).toMatchObject({ publishable: true, logicalPatchCount: 1, attemptCount: 2, acceptedPatchCount: 1, repairSuccessCount: 1 });
    const instructions = await stack.stack.externalInstructions.load(project.id);
    expect(instructions[0]?.status).toBe("handled");
    expect(await readFile(join(root, project.id, "manuscript", "main.tex"), "utf8")).toContain("The measured result remains MOTA 下降 from 45 to 28");

    const brokenProject = await stack.store.create("synthetic repair promotion failure");
    expect((await stack.request("POST", `/api/projects/${brokenProject.id}/import`, { archiveBase64: archive.toString("base64") })).status).toBe(200);
    expect((await stack.request("POST", `/api/projects/${brokenProject.id}/external-instructions`, { source: "journal_reviewer", text: "Clarify the MOTA outcome without changing the measured direction.", section: "Conclusion" })).status).toBe(200);
    const savePatchValidation = stack.stack.reviewArtifacts.savePatchValidation.bind(stack.stack.reviewArtifacts);
    vi.spyOn(stack.stack.reviewArtifacts, "savePatchValidation").mockImplementation(async (projectId, validationArtifact) => {
      if (projectId === brokenProject.id && validationArtifact.records.some((record) => (record.attempt ?? 0) > 0 && record.overall === "pass")) {
        throw new Error("injected artifact promotion failure");
      }
      return savePatchValidation(projectId, validationArtifact);
    });
    const brokenRunResult = await stack.request("POST", `/api/projects/${brokenProject.id}/workflows`, { kind: "existing_paper_improvement" });
    const brokenRunId = brokenRunResult.body.runId as string;
    await pollRunUntilAwaiting(stack, brokenRunId, "hitl.plan_confirm", { timeoutMs: 30_000 });
    await stack.request("POST", `/api/runs/${brokenRunId}/resume`, { decision: "approve" });
    const brokenTerminal = await until(stack, brokenRunId, ["failed", "completed"]);
    expect(brokenTerminal.status).toBe("failed");
    expect(brokenTerminal.error?.code ?? brokenTerminal.error?.["code"]).toBe("REPAIR_PIPELINE_ERROR");
    expect(await readFile(join(root, brokenProject.id, "manuscript", "main.tex"), "utf8")).toBe(manuscript);
  });

});
