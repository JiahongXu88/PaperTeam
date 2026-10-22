/**
 * M15.1 集成：Review Claim Ledger / finding provenance / 只读引用审计 × 真实 review.run 与 quality.gate stage。
 *  - 只读评估（published_paper_assessment，auto → extended）：单元 prompt 追加论断账本契约，账本落盘、可校验，
 *    有界跨单元复核把「摘要 63.7 vs 表格 61.7」确立为 VERIFIED_CONTRADICTED；生产 Gate 的
 *    unsupported_critical_claims_zero 仍是 NOT_EVALUATED（不偷换生产语义），影子决策与只读视图可见；
 *  - 作者稿件工作流（auto → shadow）：单元 prompt 与旧版逐字节一致（不含论断账本契约），账本如实 NOT_REQUESTED；
 *  - stage 重试 / 进程恢复：journal 复用时 claims 随记录恢复；稿件改动后旧账本校验 STALE。
 * 夹具为合成文本（不含任何版权原文）。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition, createIdeaToPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { ClaimAuditArtifact } from "../../src/review/claimAudit.js";
import { validateClaimAudit } from "../../src/review/claimAudit.js";

function filler(tag: string, chars: number): string {
  const words = ["robustness", "latency", "association", "occlusion", "calibration", "ablation", "baseline", "throughput"];
  const out: string[] = [];
  let total = 0;
  for (let i = 0; total < chars; i += 1) {
    const line = `The ${tag} discussion of ${words[i % words.length]} continues with qualitative remarks on design choice ${words[(i + 3) % words.length]} and its trade offs.`;
    out.push(line);
    total += line.length + 1;
  }
  return out.join("\n");
}

const ABSTRACT = "\\begin{abstract}\nThe proposed tracker achieves an HOTA of 63.7\\% on the MOT17 benchmark while running in real time.\n\\end{abstract}\n";
const RESULTS = [
  "\\section{Results}\\label{sec:results}",
  filler("results", 2600),
  "\\begin{table}[t]",
  "\\caption{Tracking results on MOT17.}\\label{tab:main}",
  "\\begin{tabular}{lccc}",
  "Method & HOTA & MOTA & IDF1 \\\\",
  "Baseline & 58.2 & 71.0 & 70.4 \\\\",
  "This work & 61.7 & 74.4 & 78.8 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "Prior trackers \\cite{sort} are slower.",
  "",
].join("\n");
const DISCUSSION = ["\\section{Discussion}", filler("discussion", 2600), "The improvement over the baseline is consistent across all sequences.", ""].join("\n");
const TEX = `\\documentclass{article}\n\\begin{document}\n${ABSTRACT}${RESULTS}${DISCUSSION}\\begin{thebibliography}{1}\n\\bibitem{sort} A. Bewley. Simple online and realtime tracking. ICIP, 2016.\n\\end{thebibliography}\n\\end{document}\n`;

interface Calls { unit: string[]; recheck: string[]; repair: number; findingRecheck: string[]; unitClaims: string[] }

async function setup(kind: "published" | "author", options: { recheckCalls?: number; omitClaimsOnce?: boolean; findingRecheckCalls?: number; claimStage?: "inline" | "separate" } = {}) {
  const scripted = scriptedIdeaRuntime();
  const calls: Calls = { unit: [], recheck: [], repair: 0, findingRecheck: [], unitClaims: [] };
  let omitted = false;
  const claimsFor = (prompt: string) => {
    const isAbstract = /章节：「摘要与前置部分」/.test(prompt);
    const isDiscussion = /章节：「Discussion」/.test(prompt);
    return isAbstract
      ? [{ quote: "achieves an HOTA of 63.7\\% on the MOT17 benchmark", claimType: "own_result", linkedRefs: [], check: "NEEDS_OTHER_SECTION", note: "table not visible" }]
      : isDiscussion
        ? [{ quote: "The improvement over the baseline is consistent across all sequences", claimType: "conclusion", check: "NOT_CHECKED" }]
        : [];
  };
  const runtime = {
    ...scripted.runtime,
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      const scope = input.contextScope ?? "";
      const done = (output: unknown) => ({ taskId: `t-${calls.unit.length + calls.recheck.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, output: JSON.stringify(output), events: [] });
      if (scope === "review/academic/unit-claims") {
        calls.unitClaims.push(input.task);
        return done({ claims: claimsFor(input.task) });
      }
      if (scope === "review/academic/finding-recheck") {
        calls.findingRecheck.push(input.task);
        const ids = [...input.task.matchAll(/findingId=(f1-[0-9a-f]+)/g)].map((match) => match[1]);
        return done({ results: ids.map((findingId) => ({ findingId, verdict: "NOT_DETERMINABLE" })) });
      }
      if (scope === "review/academic/unit") {
        if ((input.metadata as Record<string, unknown> | undefined)?.["repairField"] === "claims") {
          calls.repair += 1;
          return done({ claims: [] });
        }
        calls.unit.push(input.task);
        const prompt = input.task;
        const extended = prompt.includes("论断账本（claims");
        const isDiscussion = /章节：「Discussion」/.test(prompt);
        const claims = !extended ? undefined : claimsFor(prompt);
        if (options.omitClaimsOnce === true && extended && isDiscussion && !omitted) {
          omitted = true;
          return done({ summary: "ok", issues: [], academicScore: 70, riskScore: 20 });
        }
        return done({
          summary: "ok",
          issues: isDiscussion ? [{ category: "fact", severity: "major", section: "Discussion", description: "The paper does not specify the MOT17 HOTA protocol here.", quote: "The improvement over the baseline is consistent across all sequences", blocking: false }] : [],
          academicScore: 70, riskScore: 20,
          ...(claims !== undefined ? { claims } : {}),
        });
      }
      if (scope === "review/academic/claim-recheck") {
        calls.recheck.push(input.task);
        const id = /claimId=(cl1-[0-9a-f]+)/.exec(input.task)?.[1] ?? "";
        return done({ results: [{ claimId: id, check: "INCONSISTENT", counterpartQuote: "This work & 61.7 & 74.4 & 78.8", claimValue: "63.7%", counterpartValue: "61.7", note: "abstract vs table" }] });
      }
      if (scope === "review/academic/consistency") return done({ summary: "none", issues: [] });
      return scripted.runtime.runAgent(input);
    },
  };
  const stack = await startTestStack(runtime, {
    registerCleanup: () => Promise.resolve(),
    review: { claimRecheckMaxCalls: options.recheckCalls ?? 0, findingRecheckMaxCalls: options.findingRecheckCalls ?? 0, ...(options.claimStage !== undefined ? { claimStage: options.claimStage } : {}) },
  });
  const projectId = (await stack.store.create("Claim audit fixture", { language: "en" })).id;
  const services = stack.stack.workflowServices;
  const manuscriptDir = stack.store.manuscriptDir(projectId);
  await writeFile(join(manuscriptDir, "main.tex"), TEX);
  if (kind === "published") {
    const artifacts = join(stack.store.projectDir(projectId), "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "input-provenance.json"), JSON.stringify({ sourceKind: "author_latex", manuscriptSha256: createHash("sha256").update(TEX).digest("hex") }));
  } else {
    await services.revisions.commit(projectId, "baseline");
  }
  const definition = kind === "published" ? createIdeaToPaperDefinition(services) : createExistingPaperDefinition(services);
  const state = {
    workflowKind: kind === "published" ? "idea_to_paper" : "existing_paper_improvement",
    stageResults: {} as Record<string, unknown>, stageHistory: [], completedStages: [] as string[], inputs: {},
    request: kind === "published" ? { reviewPurpose: "published_paper_assessment" } : {},
  };
  const run = async (stageId: string) => {
    const stage = definition.stages.find((s) => s.id === stageId)!;
    const ctx = { projectId, runId: `claim-audit-${kind}`, attempt: 1, signal: new AbortController().signal, state, emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
    const out = await (stage as { execute: (c: StageRunContext) => Promise<Record<string, unknown>> }).execute(ctx);
    state.stageResults[stageId] = out;
    state.completedStages.push(stageId);
    return out;
  };
  const readReview = async (name: string) => JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), name), "utf8"));
  return { stack, projectId, calls, run, readReview, services };
}

describe("M15.1 Review Claim Ledger × review.run / quality.gate", () => {
  it("只读评估（auto→extended）：单元论断账本落盘可校验；有界复核确立已核实矛盾；生产 Gate 规则不变；影子决策与只读视图可见", async () => {
    const h = await setup("published", { recheckCalls: 2 });
    const review = await h.run("review.run");
    expect(h.calls.unit.length).toBeGreaterThanOrEqual(3);
    expect(h.calls.unit.every((prompt) => prompt.includes("论断账本（claims，unit-claims/v1）"))).toBe(true);
    expect(h.calls.recheck).toHaveLength(1);
    expect(h.calls.recheck[0]).toContain("This work & 61.7");
    const audit = (await h.readReview("claim-audit-r1.json")) as ClaimAuditArtifact;
    expect(audit.schema).toBe("paperteam.review-claim-audit/v2");
    expect(audit.verifier).toBe("claim-audit-verifier/v2");
    expect(audit.evaluationPolicy).toMatchObject({ reviewPurpose: "published_paper_assessment", claimAuditMode: "extended", promptContract: "unit-claims/v1", productionGateImpact: "NONE_SHADOW" });
    expect(audit.sourceVerification).toMatchObject({ level: "AUTHOR_SOURCE", basis: "DECLARED_INPUT_PROVENANCE" });
    const hota = audit.claims.find((claim) => claim.quote.includes("63.7"))!;
    expect(hota.verificationStatus).toBe("VERIFIED_CONTRADICTED");
    expect(hota.basis).toBe("IN_TEXT_CROSS_CHECK");
    expect(hota.certificate).toMatchObject({ version: "claim-certificate/v1", outcome: "CONTRADICTED", comparisonType: "SAME_OBSERVABLE" });
    expect(hota.rootCauseId).toMatch(/^rc1-/);
    expect(hota.reviewer.origin).toBe("cross_unit_recheck");
    expect(audit.recheck?.batches).toHaveLength(1);
    // 单元 journal 记录 claims（stage 重试 / 进程恢复时随 outcome 恢复）
    const journalDir = join(h.stack.store.reviewsDir(h.projectId), "review-units", "r1");
    const journal = await Promise.all((await readdir(journalDir)).map(async (name) => JSON.parse(await readFile(join(journalDir, name), "utf8"))));
    expect(journal.some((record) => record.outcome?.claimExtraction?.contract === "unit-claims/v1" && record.outcome.claimExtraction.claims.length > 0)).toBe(true);
    const conclusion = audit.claims.find((claim) => claim.quote.includes("consistent across all sequences"))!;
    expect(conclusion.verificationStatus).toBe("NOT_EVALUATED");
    // finding provenance：缺失型断言 + 术语在别处 → CONTEXT_INCOMPLETE
    expect(audit.findingAudit?.records.find((record) => record.absenceAssertion)?.auditStatus).toBeDefined();
    // 账本与被审修订一致
    const snapshotTex = [{ file: "main.tex", content: TEX }];
    expect(validateClaimAudit(audit, { sourceRevision: review["revision"] as number, documentFingerprint: audit.documentFingerprint, files: snapshotTex }).status).toBe("VALID");
    const citation = await h.readReview("citation-audit-r1.json");
    expect(citation.referenceList).toMatchObject({ source: "thebibliography", entries: 1 });
    expect(citation.verdict.authenticity).toBe("NOT_EVALUATED");
    expect(review["claimAudit"]).toMatchObject({ mode: "extended", verifiedContradicted: 1 });
    // quality.gate：生产规则原样（单元模式 claims 规则仍 NOT_EVALUATED），影子决策落盘
    const gate = await h.run("quality.gate");
    const gateArtifact = await h.readReview("quality-gate-r1.json");
    const claimRule = gateArtifact.gate.rules.find((rule: { rule: string }) => rule.rule === "unsupported_critical_claims_zero");
    expect(claimRule.status).toBe("NOT_EVALUATED");
    expect(gate["qualityDecisionV2Shadow"]).toMatchObject({ policy: "quick_review", scientificIntegrity: "VERIFIED_CONTRADICTION_PRESENT", claimAuditValidation: "VALID" });
    const shadow = await h.readReview("quality-decision-v2-shadow-r1.json");
    expect(shadow).toMatchObject({ mode: "SHADOW_ONLY", styleQuality: { role: "ADVISORY_NOT_A_GATE", provenanceJudgement: "NOT_PRODUCED" } });
    expect(JSON.stringify(shadow)).not.toMatch(/aiProbability|AIGC|humanProbability|detectorScore/);
    const view = await h.readReview("published-assessment-r1.json");
    expect(view.scientificAudit.claimAudit.claims.byStatus.VERIFIED_CONTRADICTED).toBe(1);
    expect(view.productionGate.passed).toBe(gateArtifact.gate.passed);
  });

  it("复核调用上限为 0：跨单元论断如实停在 NOT_EVALUATED（不猜、不调用模型）", async () => {
    const h = await setup("published", { recheckCalls: 0 });
    await h.run("review.run");
    expect(h.calls.recheck).toHaveLength(0);
    const audit = (await h.readReview("claim-audit-r1.json")) as ClaimAuditArtifact;
    expect(audit.claims.find((claim) => claim.quote.includes("63.7"))!.verificationStatus).toBe("NOT_EVALUATED");
    expect(audit.crossUnitTasks[0]!.status).toBe("CANDIDATES_FOUND");
    expect(audit.crossUnitTasks[0]!.recheck?.status).toBe("NOT_REQUESTED");
  });

  it("claims 缺失：只做 1 次有界修复调用；修复后仍为空则如实入账（不伪造）", async () => {
    const h = await setup("published", { omitClaimsOnce: true });
    await h.run("review.run");
    expect(h.calls.repair).toBe(1);
    const audit = (await h.readReview("claim-audit-r1.json")) as ClaimAuditArtifact;
    const discussion = audit.units.find((unit) => unit.heading === "Discussion" && unit.extraction.repairAttempts > 0);
    expect(discussion?.extraction).toMatchObject({ status: "EXTRACTED", repairAttempts: 1, raw: 0 });
  });

  it("作者稿件工作流（auto→shadow）：单元 prompt 不含论断账本契约（与旧版一致）；账本 NOT_REQUESTED；改稿后旧账本 STALE", async () => {
    const h = await setup("author", { findingRecheckCalls: 2 });
    await h.run("review.run");
    expect(h.calls.unit.length).toBeGreaterThanOrEqual(3);
    expect(h.calls.unit.some((prompt) => prompt.includes("论断账本"))).toBe(false);
    // M15.2：作者稿件工作流（shadow）零额外调用——finding 复核只出确定性队列
    expect(h.calls.findingRecheck).toHaveLength(0);
    expect(h.calls.unitClaims).toHaveLength(0);
    const audit = (await h.readReview("claim-audit-r1.json")) as ClaimAuditArtifact;
    expect(audit.evaluationPolicy).toMatchObject({ claimAuditMode: "shadow", promptContract: "legacy-unit-no-claims", reviewPurpose: "author_manuscript" });
    expect(audit.claims).toHaveLength(0);
    expect(audit.units.filter((unit) => unit.reviewStatus === "completed").every((unit) => unit.extraction.status === "NOT_REQUESTED")).toBe(true);
    // 稿件改动 → 旧账本对新原文 STALE（不得把旧原文上的结论当作新原文已评估）
    const edited = TEX.replace("63.7", "62.7");
    expect(validateClaimAudit(audit, { sourceRevision: audit.sourceRevision, documentFingerprint: "different-snapshot", files: [{ file: "main.tex", content: edited }] }).status).toBe("STALE");
  });
});

describe("M15.2 finding 定向复核 / 四轴裁决 / separate 论断抽取 × review.run / quality.gate", () => {
  it("只读评估：CONTEXT_INCOMPLETE 的 major 进入有界复核（sealed 调用），未解决保持原 finding；四轴裁决落盘（shadow），生产 Gate 规则不变", async () => {
    const h = await setup("published", { recheckCalls: 2, findingRecheckCalls: 1 });
    await h.run("review.run");
    expect(h.calls.findingRecheck).toHaveLength(1);
    expect(h.calls.findingRecheck[0]).toContain("does not specify the MOT17 HOTA protocol");
    const audit = (await h.readReview("claim-audit-r1.json")) as ClaimAuditArtifact;
    expect(audit.findingRecheck?.summary.UNRESOLVED).toBe(1);
    expect(audit.findingRecheck?.batches).toHaveLength(1);
    const summary = await h.readReview("review-summary-r1.json");
    const gate = await h.run("quality.gate");
    expect(gate["passed"]).toBe(false);
    const adjudication = await h.readReview("finding-adjudication-r1.json");
    expect(adjudication.schema).toBe("paperteam.finding-adjudication/v1");
    expect(adjudication.mode).toBe("SHADOW_ONLY");
    expect(adjudication.claimAuditValidation).toBe("VALID");
    const cause = adjudication.rootCauses.find((entry: { findings: Array<{ issueIndex: number }> }) => entry.findings.some((finding) => summary.issues[finding.issueIndex].description.includes("MOT17 HOTA protocol")));
    expect(cause.verification.axis).toBe("NOT_EVALUATED");
    expect(cause.severity).toMatchObject({ observed: "major", adjudicated: "major" });
    expect(cause.taskScope.axis).toBe("NOT_APPLICABLE_READ_ONLY");
    // 生产 summary.issues 未被改写
    expect(summary.issues.find((issue: { description: string }) => issue.description.includes("MOT17 HOTA protocol")).severity).toBe("major");
    const v2 = await h.readReview("quality-decision-v2-shadow-r1.json");
    expect(v2.findingAdjudication).toMatchObject({ schema: "paperteam.finding-adjudication/v1", rootCauses: adjudication.summary.rootCauses });
    expect(v2.productionGate.passed).toBe(false);
  });

  it("separate：单元审稿 prompt 不含论断账本契约（与无契约口径一致），每个有正文的单元多一次独立 sealed 抽取调用；账本照常入账", async () => {
    const h = await setup("published", { recheckCalls: 2, claimStage: "separate" });
    await h.run("review.run");
    expect(h.calls.unit.some((prompt) => prompt.includes("论断账本（claims"))).toBe(false);
    expect(h.calls.unitClaims.length).toBe(h.calls.unit.length);
    expect(h.calls.unitClaims.every((prompt) => prompt.includes("论断账本（claims") && prompt.includes("不要重新审稿"))).toBe(true);
    const audit = (await h.readReview("claim-audit-r1.json")) as ClaimAuditArtifact;
    expect(audit.claims.find((claim) => claim.quote.includes("63.7"))!.verificationStatus).toBe("VERIFIED_CONTRADICTED");
    const inline = await setup("published", { recheckCalls: 2 });
    await inline.run("review.run");
    expect(inline.calls.unitClaims).toHaveLength(0);
  });

  it("返修工作流（existing_paper_improvement）：四轴裁决只落 shadow 产物，taskScope 不是只读口径；生产 Gate 规则集合不新增、不读裁决", async () => {
    const h = await setup("author", { findingRecheckCalls: 2 });
    await h.run("review.run");
    const gate = await h.run("quality.gate");
    const adjudication = await h.readReview("finding-adjudication-r1.json");
    expect(adjudication.mode).toBe("SHADOW_ONLY");
    expect(adjudication.policy).not.toBe("quick_review");
    expect(adjudication.rootCauses.every((cause: { taskScope: { axis: string } }) => cause.taskScope.axis !== "NOT_APPLICABLE_READ_ONLY")).toBe(true);
    const report = await h.readReview("quality-gate-r1.json");
    const ruleNames: string[] = report.gate.rules.map((rule: { rule: string }) => rule.rule);
    expect(ruleNames.some((name) => /adjudication|finding_recheck|certificate/i.test(name))).toBe(false);
    expect(typeof gate["passed"]).toBe("boolean");
    expect(h.calls.findingRecheck).toHaveLength(0);
  });
});
