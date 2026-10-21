/**
 * M14.9.5.4 端到端（零模型）：预先登记的实验论断复算 → review.run（prompt / 确定性 finding / 账本）→ quality.gate；
 * 以及 workflow stage 与手动 POST /quality-gate 的双入口一致性。
 *
 *   - 未登记计划：单元 prompt 逐字节不变（第 2 轮未变单元全部命中跨轮缓存，零调用）；
 *   - 登记后：只有论断原文所在单元的 prompt 多出复算块（被重新审查），矛盾论断落成 rootCauseKey=claim-check:<id> 的
 *     确定性 finding，Gate 的 experiment_claims_recomputed FAIL、critical/major 口径同根因去重；
 *   - 双入口：同一项目同一轮次，stage 与 POST 的规则列表 / 状态 / passed / 输入指纹完全一致；
 *   - 失效缓存：审稿后修改计划 → Gate 现场重算并在 evaluation.contextGaps 里如实说明 prompt 未包含新结果。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { buildStoreZip } from "../helpers/storeZip.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { QualityGateResult } from "../../src/quality/gates.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

const CLAIM_SENTENCE = "在 3 起可判定吞并中，有 3 起去掉运动项后改判给合法轨迹，即 3 起由运动项决定。";
const FILES = {
  "sections/method.tex": `\\section{Method}\n\n${chapterBody(4_200, "met")}`,
  "sections/diagnosis.tex": `\\section{Diagnosis}\n\n${CLAIM_SENTENCE}\n\n${chapterBody(4_200, "dia")}`,
  "sections/results.tex": `\\section{Results}\n\n${chapterBody(4_200, "res")}`,
};
const EVENTS = "kind,in_pool,nt,wt,nv,wv,split\nTAKEOVER,True,0.40,0.70,0.30,0.90,dev\nTAKEOVER,True,0.50,0.60,0.20,0.95,dev\nTAKEOVER,True,0.45,0.80,0.35,0.50,dev\nTAKEOVER,False,0.50,0.50,0.10,0.10,dev\n";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const SOURCES = JSON.stringify({ files: { "events.csv": { sha256: sha(EVENTS) } } });
const ZIP = buildStoreZip([
  { path: "results/events.csv", data: EVENTS },
  { path: "results/SOURCES.json", data: SOURCES },
]);

const protocol = { id: "base-forensics", assertions: [{ kind: "source_manifest_sha256", manifest: { path: "results/SOURCES.json", sha256: sha(SOURCES), jsonPath: "$.files.events\\.csv.sha256" } }] };
function planFor(manifestJsonPath: string, include: { contradicted: boolean } = { contradicted: true }) {
  const proto = { ...protocol, assertions: [{ ...protocol.assertions[0]!, manifest: { ...protocol.assertions[0]!.manifest, jsonPath: manifestJsonPath } }] };
  const source = { path: "results/events.csv", sha256: sha(EVENTS) };
  const filters = [{ column: "kind", equals: "TAKEOVER" }, { column: "in_pool", equals: "True" }];
  return {
    schema: "paperteam.claim-checks/v1",
    registeredBy: "test",
    checks: [
      { id: "L1", title: "去掉运动项后改判", materiality: "core", claim: { quote: "有 3 起去掉运动项后改判给合法轨迹", value: 3 }, source, protocol: proto, filters, calculation: { aggregate: "count", where: "nv < nt", description: "去掉运动项后合法轨迹更便宜" } },
      ...(include.contradicted
        ? [{ id: "MOT", title: "由运动项决定", materiality: "core", claim: { quote: "即 3 起由运动项决定", value: 3 }, source, protocol: proto, filters, calculation: { aggregate: "count", where: "nv < nt && wt <= wv", description: "加上运动项后吞并者不更贵" }, conditions: "成对反事实" }]
        : []),
      { id: "GAP", title: "缺列", materiality: "supporting", claim: { quote: "在 3 起可判定吞并中", value: 3 }, source, protocol: proto, filters, calculation: { aggregate: "count", where: "decidable == 1", description: "x" } },
    ],
  };
}

interface Call { task: string; scope: string; heading: string }

async function setup() {
  const scripted = scriptedIdeaRuntime();
  const calls: Call[] = [];
  const runtime = {
    ...scripted.runtime,
    describeAgentContext: async () => ({ model: "glm/claude-opus-5-5", skills: ["academic-review@abc123"] }),
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      const scope = input.contextScope ?? "";
      const heading = /章节：「(.+?)」/.exec(input.task)?.[1] ?? "(cross)";
      calls.push({ task: input.task, scope, heading });
      if (scope === "review/academic/unit") {
        return {
          taskId: `u${calls.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [],
          metadata: { model: "glm/claude-opus-5-5" },
          output: JSON.stringify({ summary: `unit ${heading}`, issues: [], academicScore: 85, riskScore: 20 }),
        };
      }
      if (scope === "review/academic/consistency") {
        return { taskId: `x${calls.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [], output: JSON.stringify({ summary: "ok", issues: [] }) };
      }
      throw new Error(`unexpected scope ${scope}`);
    },
  };
  const stack = await startTestStack(runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup), review: { reviewConcurrency: 1 } });
  const services = stack.stack.workflowServices;
  const projectId = (await stack.store.create("Claim check e2e", { language: "zh", workflowKind: "existing_paper_improvement" })).id;
  const dir = stack.store.manuscriptDir(projectId);
  await mkdir(join(dir, "sections"), { recursive: true });
  for (const [file, content] of Object.entries(FILES)) await writeFile(join(dir, file), content);
  await writeFile(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\input{sections/diagnosis}\n\\input{sections/results}\n\\end{document}\n");
  await writeFile(join(dir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
  await services.revisions.commit(projectId, "baseline");
  // 实验包：真实 ZIP 导入 + 作者确认
  const uploaded = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages`, {
    method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": "forensics.zip" }, body: ZIP,
  });
  expect(uploaded.status).toBe(201);
  const packageId = ((await uploaded.json()) as { package: { packageId: string } }).package.packageId;
  expect((await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/confirm`, { groupIds: ["main"] })).status).toBe(200);
  const definition = createExistingPaperDefinition(services);
  const stageOf = (id: string) => definition.stages.find((entry) => entry.id === id)! as { execute: (c: StageRunContext) => Promise<Record<string, unknown>> };
  const ctx = () => ({
    projectId, runId: `cc-${calls.length}`, attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
  }) as unknown as StageRunContext;
  const reviews = stack.store.reviewsDir(projectId);
  const readJson = async <T>(file: string) => JSON.parse(await readFile(join(reviews, file), "utf8")) as T;
  return { stack, services, projectId, calls, stageOf, ctx, readJson };
}

describe("M14.9.5.4 实验论断复算 × review.run × quality.gate（零模型）", () => {
  it("claim → 原始输入 / 哈希 → 复算 → prompt / 确定性 finding / Gate；双入口一致；计划变更如实标注", async () => {
    const h = await setup();
    const unitCalls = () => h.calls.filter((call) => call.scope === "review/academic/unit");

    // 第 1 轮：未登记计划 → prompt 不含复算块
    await h.stageOf("review.run").execute(h.ctx());
    const round1Calls = unitCalls();
    expect(round1Calls.length).toBeGreaterThanOrEqual(3);
    expect(round1Calls.every((call) => !call.task.includes("实验论断复算"))).toBe(true);

    // JSON 路径记法与解析器一致：先探测解析器给出的 header（不猜）
    const probe = await h.stack.request("PUT", `/api/projects/${h.projectId}/claim-checks`, planFor("$.files[\"events.csv\"].sha256"));
    expect(probe.status).toBe(200);
    const ledger0 = probe.body["ledger"] as { results: Array<{ id: string; verdict: string; gaps: Array<{ code: string }> }> };
    expect(ledger0.results.map((result) => [result.id, result.verdict])).toEqual([["L1", "CONSISTENT"], ["MOT", "CONTRADICTED"], ["GAP", "NOT_EVALUATED"]]);
    expect(ledger0.results.find((result) => result.id === "GAP")!.gaps.map((gap) => gap.code)).toContain("COLUMN_MISSING");

    // 第 2 轮：只有论断所在单元被重新审查（prompt 多出复算块）；其余单元 prompt 逐字节不变 → 跨轮缓存命中
    const before = unitCalls().length;
    await h.stageOf("review.run").execute(h.ctx());
    const round2Calls = unitCalls().slice(before);
    expect(round2Calls.length).toBe(1);
    expect(round2Calls[0]!.task).toContain(CLAIM_SENTENCE);
    expect(round2Calls[0]!.task).toContain("[CC-MOT]");
    expect(round2Calls[0]!.task).toContain("与稿件不一致（CONTRADICTED）");
    expect(round2Calls[0]!.task).toContain("[CC-GAP]");
    expect(round2Calls[0]!.task).toContain("不得据此认定论文有误");
    const summary = await h.readJson<ReviewSummary>("review-summary-r2.json");
    const deterministic = summary.issues.filter((issue) => issue.rootCauseKey === "claim-check:MOT");
    expect(deterministic).toHaveLength(1);
    expect(deterministic[0]).toMatchObject({ category: "fact", severity: "major", section: "Diagnosis", file: "sections/diagnosis.tex" });
    expect(deterministic[0]!.claimCheck).toMatchObject({ manuscriptValue: 3, derivedValue: 2, dataSha256: sha(EVENTS) });
    const ledger = await h.readJson<{ round: number; ledgerHash: string; manuscriptRevision: number; results: unknown[] }>("claim-checks-r2.json");
    expect(ledger.round).toBe(2);
    expect(ledger.results).toHaveLength(3);
    expect(deterministic[0]!.claimCheck?.ledgerHash).toBe(ledger.ledgerHash);

    // workflow 入口
    await h.stageOf("quality.gate").execute(h.ctx());
    const workflowGate = (await h.readJson<{ gate: QualityGateResult }>("quality-gate-r2.json")).gate;
    const rule = (gate: QualityGateResult, id: string) => gate.rules.find((entry) => entry.rule === id);
    expect(rule(workflowGate, "experiment_claims_recomputed")).toMatchObject({ status: "FAIL", required: true, passed: false });
    expect(rule(workflowGate, "experiment_claims_recomputed")!.detail).toContain("MOT（稿件 3 ≠ 复算 2）");
    expect(rule(workflowGate, "open_critical_major_zero")!.detail).toContain("实验复算矛盾同根因");
    expect(rule(workflowGate, "unsupported_critical_claims_zero")).toMatchObject({ status: "NOT_EVALUATED", required: true });
    expect(workflowGate.evaluation).toMatchObject({ entry: "workflow", reviewRound: 2, contextGaps: [] });
    expect(workflowGate.publicationReadiness?.verdict).not.toBe("READY");

    // 手动入口：同一项目同一轮次 → 同一规则集合 / 状态 / 判定 / 输入指纹
    const manual = await h.stack.request("POST", `/api/projects/${h.projectId}/quality-gate`);
    expect(manual.status).toBe(200);
    const manualGate = manual.body["gate"] as QualityGateResult;
    const shape = (gate: QualityGateResult) => gate.rules.map((entry) => ({ rule: entry.rule, status: entry.status, passed: entry.passed, required: entry.required, detail: entry.detail }));
    expect(shape(manualGate)).toEqual(shape(workflowGate));
    expect(manualGate.passed).toBe(workflowGate.passed);
    expect(manualGate.reasons).toEqual(workflowGate.reasons);
    expect(manualGate.evaluation?.inputFingerprint).toBe(workflowGate.evaluation?.inputFingerprint);
    expect(manualGate.evaluation?.entry).toBe("manual");
    expect(manualGate.publicationReadiness?.verdict).toBe(workflowGate.publicationReadiness?.verdict);
    expect(manualGate.revisionTask?.verdict).toBe(workflowGate.revisionTask?.verdict);

    // 失效缓存：审稿后修改计划（删掉矛盾项）→ Gate 现场重算，并说明审稿 prompt 只含旧计划结果
    expect((await h.stack.request("PUT", `/api/projects/${h.projectId}/claim-checks`, planFor("$.files[\"events.csv\"].sha256", { contradicted: false }))).status).toBe(200);
    const restale = (await h.stack.request("POST", `/api/projects/${h.projectId}/quality-gate`)).body["gate"] as QualityGateResult;
    expect(rule(restale, "experiment_claims_recomputed")).toMatchObject({ status: "NOT_EVALUATED", required: true, passed: false });
    expect(restale.evaluation?.contextGaps.join("\n")).toContain("复算计划在第 2 轮审稿之后变更");
    expect(restale.evaluation?.inputFingerprint).not.toBe(workflowGate.evaluation?.inputFingerprint);
  });
});
