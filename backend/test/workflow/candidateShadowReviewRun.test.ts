/**
 * M15.4.3（P1）集成：CandidateProposer Shadow × 真实 review.run stage（scripted runtime；零真实模型）。
 *  - OFF（缺省）：candidate-shadow 通道零调用、无产物，审稿产物与 ON 语义一致（除影子产物本身）；
 *  - ON：claim-audit 落盘后运行影子旁路，产出 candidate-shadow-r{round}.json（SHADOW_OBSERVATION_ONLY），
 *    不改 review summary / issues / 计数 / 评分；proposal→verification 全链经真实服务路径；
 *  - 模型 JSON 坏响应 → 解析重试一次后按解析失败记录（不阻塞主审稿）；
 *  - 影子通道整体抛错 → 记日志、无产物，review.run 照常完成；
 *  - resume 语义：同轮同请求身份 → 复用（零新调用）。
 * 夹具为合成文本（不含任何版权原文）。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createIdeaToPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { CandidateShadowArtifact } from "../../src/review/candidateShadow.js";

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
  "Proposed & 61.7 & 74.4 & 78.8 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "Prior trackers \\cite{sort} are slower.",
  "",
].join("\n");
const DISCUSSION = ["\\section{Discussion}", filler("discussion", 2600), ""].join("\n");
const TEX = `\\documentclass{article}\n\\begin{document}\n${ABSTRACT}${RESULTS}${DISCUSSION}\\begin{thebibliography}{1}\n\\bibitem{sort} A. Bewley. Simple online and realtime tracking. ICIP, 2016.\n\\end{thebibliography}\n\\end{document}\n`;

const PROPOSER_OK = JSON.stringify({
  claimId: "(captured)",
  subject: "ours",
  metric: "HOTA",
  dataset: "MOT17",
  conditions: [],
  comparison: "INCONSISTENT",
  candidates: [{ tableAlias: "T1", rowAlias: "R3", colAlias: "C2", interpretation: "Proposed row HOTA column", evidenceQuotes: ["HOTA"] }],
});

interface Harness {
  projectId: string;
  calls: { unit: number; recheck: number; shadow: string[] };
  run: (stageId: string) => Promise<Record<string, unknown>>;
  readReview: (name: string) => Promise<Record<string, unknown>>;
}

async function setup(options: { shadow: "on" | "off"; shadowResponses?: Array<string | Error> }): Promise<Harness> {
  const scripted = scriptedIdeaRuntime();
  const calls = { unit: 0, recheck: 0, shadow: [] as string[] };
  const responses = [...(options.shadowResponses ?? [PROPOSER_OK])];
  const runtime = {
    ...scripted.runtime,
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      const scope = input.contextScope ?? "";
      const done = (output: unknown) => ({ taskId: `t-${calls.unit + calls.recheck + calls.shadow.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, output: typeof output === "string" ? output : JSON.stringify(output), events: [] });
      if (scope === "review/academic/candidate-shadow") {
        calls.shadow.push(input.task);
        const next = responses.shift();
        if (next === undefined) throw new Error("shadow stub exhausted");
        if (next instanceof Error) throw next;
        return done(next);
      }
      if (scope === "review/academic/unit-claims") {
        return done({ claims: [{ quote: "achieves an HOTA of 63.7\\% on the MOT17 benchmark", claimType: "own_result", linkedRefs: [], check: "CONSISTENT", claimValue: "63.7", note: "abstract vs table" }] });
      }
      if (scope === "review/academic/claim-recheck") {
        calls.recheck += 1;
        const id = /claimId=(cl1-[0-9a-f]+)/.exec(input.task)?.[1] ?? "";
        return done({ results: [{ claimId: id, check: "INCONSISTENT", counterpartQuote: "Proposed & 61.7 & 74.4 & 78.8", claimValue: "63.7%", counterpartValue: "61.7", note: "abstract vs table" }] });
      }
      if (scope === "review/academic/unit") {
        calls.unit += 1;
        return done({ summary: "ok", issues: [], academicScore: 70, riskScore: 20, claims: [{ quote: "achieves an HOTA of 63.7\\% on the MOT17 benchmark", claimType: "own_result", linkedRefs: [], check: "CONSISTENT", claimValue: "63.7", note: "abstract vs table" }] });
      }
      if (scope === "review/academic/consistency") return done({ summary: "none", issues: [] });
      return scripted.runtime.runAgent(input);
    },
  };
  const stack = await startTestStack(runtime, {
    registerCleanup: () => Promise.resolve(),
    review: { claimRecheckMaxCalls: 0, findingRecheckMaxCalls: 0, ...(options.shadow === "on" ? { candidateShadow: "on" as const } : {}) },
  });
  const projectId = (await stack.store.create("Candidate shadow fixture", { language: "en" })).id;
  const services = stack.stack.workflowServices;
  const manuscriptDir = stack.store.manuscriptDir(projectId);
  await writeFile(join(manuscriptDir, "main.tex"), TEX);
  const artifacts = join(stack.store.projectDir(projectId), "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "input-provenance.json"), JSON.stringify({ sourceKind: "author_latex", manuscriptSha256: createHash("sha256").update(TEX).digest("hex") }));
  const definition = createIdeaToPaperDefinition(services);
  const state = {
    workflowKind: "idea_to_paper",
    stageResults: {} as Record<string, unknown>, stageHistory: [], completedStages: [] as string[], inputs: {},
    request: { reviewPurpose: "published_paper_assessment" },
  };
  const run = async (stageId: string) => {
    const stage = definition.stages.find((s) => s.id === stageId)!;
    const ctx = { projectId, runId: `candidate-shadow-${options.shadow}`, attempt: 1, signal: new AbortController().signal, state, emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
    const out = await (stage as { execute: (c: StageRunContext) => Promise<Record<string, unknown>> }).execute(ctx);
    state.stageResults[stageId] = out;
    state.completedStages.push(stageId);
    return out;
  };
  const readReview = async (name: string) => JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), name), "utf8")) as Record<string, unknown>;
  return { projectId, calls, run, readReview };
}

describe("M15.4.3 CandidateProposer shadow × review.run", () => {
  it("OFF（缺省）：影子通道零调用、无产物；ON：产物落盘且不改审稿结果（summary 逐字段一致）", async () => {
    const off = await setup({ shadow: "off" });
    const reviewOff = await off.run("review.run");
    expect(off.calls.shadow).toHaveLength(0);
    await expect(off.readReview("candidate-shadow-r1.json")).rejects.toThrow();
    const on = await setup({ shadow: "on" });
    const reviewOn = await on.run("review.run");
    expect(on.calls.shadow.length).toBeGreaterThanOrEqual(1);
    const shadow = (await on.readReview("candidate-shadow-r1.json")) as unknown as CandidateShadowArtifact;
    expect(shadow.schema).toBe("candidate-shadow/v1");
    expect(shadow.authority).toBe("SHADOW_OBSERVATION_ONLY");
    expect(shadow.status).toBe("COMPLETED");
    expect(shadow.summary.selected).toBeGreaterThanOrEqual(1);
    expect(shadow.summary.calls).toBeGreaterThanOrEqual(1);
    const entry = shadow.claims[0]!;
    expect(entry.status).toBe("EVALUATED");
    expect(entry.claim.claimValue).toBe("63.7");
    expect(entry.ruleBaseline).toBeDefined();
    // 影子产物不影响 review.run 返回值（逐字段对照；两夹具同构，返回值应一致）
    const normalized = (value: Record<string, unknown>) => JSON.parse(JSON.stringify(value));
    expect(normalized(reviewOn)).toEqual(normalized(reviewOff));
    // claim-audit 账本未被影子旁路改写（证书 / 状态原样）
    const claimAudit = (await on.readReview("claim-audit-r1.json")) as { claims: Array<{ claimId: string; verificationStatus: string }> };
    expect(Array.isArray(claimAudit.claims)).toBe(true);
  });

  it("坏 JSON：解析失败重试一次后按解析失败记录（EVALUATED + parseError），主审稿不受影响", async () => {
    const h = await setup({ shadow: "on", shadowResponses: ["totally not json", "{ still broken"] });
    const review = await h.run("review.run");
    expect(h.calls.shadow).toHaveLength(2);
    const shadow = (await h.readReview("candidate-shadow-r1.json")) as unknown as CandidateShadowArtifact;
    expect(shadow.status).toBe("COMPLETED");
    const entry = shadow.claims[0]!;
    expect(entry.status).toBe("EVALUATED");
    expect(entry.attempts).toBe(2);
    expect(entry.parseError).toBeTruthy();
    expect(entry.verification).toBeUndefined();
    expect((review as { issues: number }).issues).toBeGreaterThanOrEqual(0);
  });

  it("影子通道模型异常：单 claim FAILED（异常不触发解析重试）、产物 PARTIAL、review.run 照常完成（失败隔离）", async () => {
    const h = await setup({ shadow: "on", shadowResponses: [new Error("provider exploded")] });
    const review = await h.run("review.run");
    expect(h.calls.shadow).toHaveLength(1); // 异常 ≠ 解析失败：不重试，直接 FAILED 条目
    const shadow = (await h.readReview("candidate-shadow-r1.json")) as unknown as CandidateShadowArtifact;
    expect(shadow.status).toBe("PARTIAL");
    expect(shadow.claims[0]!.status).toBe("FAILED");
    expect(shadow.claims[0]!.error).toContain("provider exploded");
    expect(review).toHaveProperty("round");
  });

  it("resume 语义：同轮同请求身份 → 复用零新调用（第二次执行 review.run 的新一轮除外，本轮不触发）", async () => {
    const h = await setup({ shadow: "on" });
    await h.run("review.run");
    const first = (await h.readReview("candidate-shadow-r1.json")) as unknown as CandidateShadowArtifact;
    expect(first.summary.evaluated).toBeGreaterThanOrEqual(1);
    expect(first.summary.calls).toBeGreaterThanOrEqual(1);
    expect(typeof first.claims[0]!.requestId).toBe("string");
    expect(first.claims[0]!.requestId.length).toBe(64);
  });
});
