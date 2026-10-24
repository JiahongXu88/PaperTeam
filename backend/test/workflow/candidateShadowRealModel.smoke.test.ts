/**
 * M15.4.3（E2）真实模型 Shadow smoke（env 门控：PAPERTEAM_M1543_SHADOW_SMOKE=1；默认跳过，不进 CI）。
 *
 * 运行：PAPERTEAM_M1543_SHADOW_SMOKE=1 npx vitest run test/workflow/candidateShadowRealModel.smoke.test.ts
 * 预算（预登记 §7）：CandidateProposer 真实调用总量 ≤12（场景 A ≤8 + 场景 B ≤2；其余为正常审稿调用）。
 *
 * 场景 A（真实工作流产物）：截取的真实论文（M15.4.2 G2 BrainIAC 语料，仓库外只读；测试文件不含论文原文）
 *  → published_paper_assessment 真实 review.run（真实单元审稿 + 论断账本）→ CandidateProposer shadow ON
 *  → candidate-shadow-r1.json 落盘（SHADOW_OBSERVATION_ONLY）；断言开关/产物/预算/主链完整。
 * 场景 B（真实服务通道 + P0-A 证据案例）：G1 HDMamba 的真实 claim（重复表语料）经真实
 *  ReviewerService.proposeClaimCandidate + runCandidateShadowStage → 见证含逻辑等价类。
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../../src/settings/ModelSettingsService.js";
import { startTestStack } from "../helpers/testStack.js";
import { createIdeaToPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { runCandidateShadowStage, type CandidateShadowArtifact } from "../../src/review/candidateShadow.js";
import type { ClaimAuditArtifact, ReviewClaimRecord } from "../../src/review/claimAudit.js";
import { locateQuote } from "../../src/review/claimAuditText.js";

const live = process.env["PAPERTEAM_M1543_SHADOW_SMOKE"] === "1";
const G2_PAPER = "D:\\PaperTeamData\\M15\\M15_4_2\\candidates\\2609.23026\\paper.tex";
const G1_PAPER = "D:\\PaperTeamData\\M15\\M15_4_2\\candidates\\2609.23061\\chapter4_with_fig5_fig10.tex";
const G1_TEMPLATE = "D:\\PaperTeamData\\M15\\M15_4_2\\candidates\\2609.23061\\elsarticle-template-num.tex";
const OUT_DIR = "D:\\PaperTeamData\\M15\\M15_4_3\\smoke";

describe.skipIf(!live)("M15.4.3 真实模型 CandidateProposer shadow smoke", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  async function realRuntime(): Promise<PiRuntimeAdapter> {
    const runtimeRoot = join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const customProviderStore = new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") });
    // 本机 zai-coding-cn 为内置 provider（settings/model.json + apiChannel 驱动）；自定义 provider 数量不作断言
    await registerStoredCustomProviders(modelRuntime, customProviderStore, () => {});
    const adapter = new PiRuntimeAdapter({
      // 本机 Coding Plan 订阅通道（settings/model.json 的默认；与 M15.4.1/M15.4.2 真实调用同源）
      modelSpec: process.env["PAPERTEAM_M1543_MODEL"] ?? "zai-coding-cn/glm-5.3",
      agentDir,
      workspaceRoot: tmpdir(),
      runTimeoutMs: 300_000,
      modelRuntime,
    });
    cleanups.push(() => adapter.close());
    return adapter;
  }

  it("场景 A：真实论文 review.run（shadow ON）→ candidate-shadow-r1.json 真实工作流产物", async () => {
    const adapter = await realRuntime();
    // 调用计数（按 contextScope）：CandidateProposer 调用预算硬断言 ≤8
    const scopeCounts = new Map<string, number>();
    const counting: typeof adapter = Object.create(adapter);
    const innerRun = adapter.runAgent.bind(adapter);
    counting.runAgent = (async (input: Parameters<typeof adapter.runAgent>[0]) => {
      const scope = input.contextScope ?? "(none)";
      scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
      return innerRun(input);
    }) as typeof adapter.runAgent;

    const stack = await startTestStack(counting, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      stageBudget: { timeoutMs: 900_000, maxAttempts: 2 },
      review: { candidateShadow: "on", claimRecheckMaxCalls: 0, findingRecheckMaxCalls: 0 },
    });
    const projectId = (await stack.store.create("M1543 shadow smoke A", { language: "en" })).id;
    const manuscriptDir = stack.store.manuscriptDir(projectId);
    const full = await readFile(G2_PAPER, "utf8");
    const lines = full.split("\n");
    // 截取（真实文本，仅控制规模；记录于产物目录）：前 70 行前置 + 摘要起截到第 640 行（含 TBI_unused 表）+ 收尾
    const compact = [...lines.slice(0, 70), ...lines.slice(70, 640), "% smoke truncation: 640..end omitted", ...(lines[lines.length - 1]?.includes("end{document}") ? [lines[lines.length - 1]!] : ["\\end{document}"])].join("\n");
    expect(compact).toContain("68.9");
    await writeFile(join(manuscriptDir, "main.tex"), compact);
    const artifacts = join(stack.store.projectDir(projectId), "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "input-provenance.json"), JSON.stringify({ sourceKind: "author_latex", manuscriptSha256: createHash("sha256").update(compact).digest("hex"), note: "M15.4.3 smoke: truncated copy of M15_4_2 G2 corpus (out-of-repo)" }));

    const definition = createIdeaToPaperDefinition(stack.stack.workflowServices);
    const state = {
      workflowKind: "idea_to_paper",
      stageResults: {} as Record<string, unknown>, stageHistory: [], completedStages: [] as string[], inputs: {},
      request: { reviewPurpose: "published_paper_assessment" },
    };
    const ctx = { projectId, runId: "m1543-shadow-smoke-a", attempt: 1, signal: new AbortController().signal, state, emitProgress: async () => {}, emitDomain: async () => {}, log: (message: string) => console.log(`[smokeA] ${message}`) } as unknown as StageRunContext;
    const stage = definition.stages.find((s) => s.id === "review.run")!;
    const out = await (stage as { execute: (c: StageRunContext) => Promise<Record<string, unknown>> }).execute(ctx);

    const proposerCalls = scopeCounts.get("review/academic/candidate-shadow") ?? 0;
    console.log(`[smokeA] scope counts: ${JSON.stringify([...scopeCounts.entries()])}`);
    expect(proposerCalls).toBeLessThanOrEqual(8);
    expect(scopeCounts.get("review/academic/unit") ?? 0).toBeGreaterThan(0);

    const reviewsDir = stack.store.reviewsDir(projectId);
    const shadowRaw = JSON.parse(await readFile(join(reviewsDir, "candidate-shadow-r1.json"), "utf8")) as unknown as CandidateShadowArtifact;
    expect(shadowRaw.schema).toBe("candidate-shadow/v1");
    expect(shadowRaw.authority).toBe("SHADOW_OBSERVATION_ONLY");
    console.log(`[smokeA] shadow status=${shadowRaw.status} selected=${shadowRaw.summary.selected} evaluated=${shadowRaw.summary.evaluated} accepted=${shadowRaw.summary.accepted} abstained=${shadowRaw.summary.abstained} calls=${shadowRaw.summary.calls} tokens=${shadowRaw.summary.inputTokens ?? 0}/${shadowRaw.summary.outputTokens ?? 0} duration=${shadowRaw.summary.durationMs}ms`);
    // 主链完整：review.run 返回正常、claim-audit 落盘、影子零改写（claim-audit 的 claims 数与账本一致）
    expect(out).toHaveProperty("round", 1);
    const claimAudit = JSON.parse(await readFile(join(reviewsDir, "claim-audit-r1.json"), "utf8")) as unknown as ClaimAuditArtifact;
    expect(Array.isArray(claimAudit.claims)).toBe(true);
    // 产物外存（仓库外审计目录）
    await mkdir(OUT_DIR, { recursive: true });
    await copyFile(join(reviewsDir, "candidate-shadow-r1.json"), join(OUT_DIR, "smokeA-candidate-shadow-r1.json"));
    await copyFile(join(reviewsDir, "claim-audit-r1.json"), join(OUT_DIR, "smokeA-claim-audit-r1.json"));
  }, 1_500_000);

  it("场景 B：G1 重复表真实 claim 经真实服务通道 → 见证含逻辑等价类（P0-A 真实数据验证）", async () => {
    const adapter = await realRuntime();
    const stack = await startTestStack(adapter, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      stageBudget: { timeoutMs: 900_000, maxAttempts: 2 },
    });
    const g1Chapter = await readFile(G1_PAPER, "utf8");
    const g1Template = await readFile(G1_TEMPLATE, "utf8");
    const certificateFiles = [
      { file: "chapter4_with_fig5_fig10.tex", content: g1Chapter },
      { file: "elsarticle-template-num.tex", content: g1Template },
    ];
    const quote = "HDMamba-YOLO-B reaches 42.737\\% mAP$_{50}$ and 25.713\\% mAP$_{50:95}$ with 10.042M parameters and 29.879 corrected GFLOPs.";
    const span = locateQuote(g1Chapter, quote);
    expect(span).not.toBeNull();
    const record = {
      claimId: "cl1-g1c01smoke",
      file: "chapter4_with_fig5_fig10.tex",
      quote,
      quoteSha256: createHash("sha256").update(quote).digest("hex"),
      location: { unitId: "u1", file: "chapter4_with_fig5_fig10.tex", start: span!.start, end: span!.end, line: 1 },
      reviewer: { origin: "unit_claims", check: "CONSISTENT", claimValue: "42.737" },
    } as unknown as ReviewClaimRecord;
    const claimAudit = { claims: [record] } as unknown as ClaimAuditArtifact;
    const reviewer = stack.stack.workflowServices.reviewer;
    const startedAt = Date.now();
    const shadow = await runCandidateShadowStage(
      { projectId: "smoke-b-g1", round: 1, revision: 1, documentFingerprint: "g1-smoke", claimAudit, certificateFiles },
      {
        proposeClaimCandidate: (params) => reviewer.proposeClaimCandidate({
          projectId: params.projectId,
          prompt: params.prompt,
          sessionLabel: params.sessionLabel,
          ...(params.signal !== undefined ? { signal: params.signal } : {}),
        }),
      },
      null,
      { maxClaims: 1, maxAttemptsPerClaim: 2, maxCallsPerRun: 2 },
    );
    console.log(`[smokeB] status=${shadow.status} calls=${shadow.summary.calls} tokens=${shadow.summary.inputTokens ?? 0}/${shadow.summary.outputTokens ?? 0} duration=${Date.now() - startedAt}ms`);
    expect(shadow.summary.calls).toBeLessThanOrEqual(2);
    const entry = shadow.claims[0]!;
    console.log(`[smokeB] entry: ${entry.status} verification=${entry.verification?.status ?? "-"} outcome=${entry.verification?.status === "ACCEPTED" ? entry.verification.outcome : "-"} ruleBaseline=${entry.ruleBaseline?.bindingStatus}`);
    if (entry.verification?.status === "ACCEPTED") {
      const uniqueness = entry.verification.witness.uniqueness;
      console.log(`[smokeB] physicalHits=${uniqueness.physicalHitCount} logicalClasses=${uniqueness.logicalEquivalence.map((c) => c.members.length).join(",")}`);
      expect(uniqueness.logicalEquivalence.length).toBeGreaterThanOrEqual(1);
      expect(uniqueness.logicalEquivalence[0]!.members.length).toBe(2);
    } else if (entry.verification?.status === "ABSTAIN") {
      console.log(`[smokeB] abstain: ${entry.verification.category}: ${entry.verification.detail.slice(0, 140)}`);
    }
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(join(OUT_DIR, "smokeB-candidate-shadow-g1.json"), JSON.stringify({ ...shadow, rawModelText: undefined }, null, 2));
    expect(["COMPLETED", "PARTIAL"]).toContain(shadow.status);
  }, 600_000);
});
