/**
 * M14.6 Smoke B — MissingMaterial 范围缺口的有界模型提案（env 门控：PAPERTEAM_M146_MM_SMOKE=1；默认跳过，不进 CI）。
 *
 * 用案例 B（M14.5 run2）的真实产物：research-inputs / 贡献 / 主线（含 scopeConcerns）/ 章节映射 /
 * 已确认事实 → MissingMaterialService.proposeScopeGaps（1 次模型调用）→ 解析校验 → 以 proposed
 * 并入临时账本。断言纪律：
 *   - 全部提案 status=proposed（模型不能确认缺口）；relatedChapterId ∈ 映射章 或 null；
 *   - 不把 held-out 学位论文独有的研究（分布式编队 NMPC / 六自由度仿真平台 / ROS 实物系统章 /
 *     参数辨识实验过程）当作「既定事实」——提案描述中若出现这些主题，必须以建议 / 待确认口径出现，
 *     不得以「作者已完成 / 已有 / 本文已」等完成时态陈述；
 *   - 提案数 ≤ 6；每条带 requiredMaterials（含 author_confirmation）。
 * 确定性 A/B 类提案（deriveChapterMaterialGaps / deriveScopeGapProposals）同时落账并写入产物对照。
 *
 * 运行：PAPERTEAM_M146_MM_SMOKE=1 PAPERTEAM_M146_MODEL=zai-coding-cn/glm-5.3 npx vitest run test/thesis/m146MissingMaterial.smoke.test.ts
 * 产物：D:\PaperTeamData\M14_6\smoke\mm-proposal-<ts>.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../../src/settings/ModelSettingsService.js";
import { ModelSettingsStore, resolveStartupModelSpec } from "../../src/settings/ModelSettingsStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { MissingMaterialLedger, deriveScopeGapProposals, deriveChapterMaterialGaps } from "../../src/thesis/MissingMaterialLedger.js";
import { MissingMaterialService } from "../../src/thesis/MissingMaterialService.js";
import type { ChapterMappingFile, ThesisContributionFile, ThesisStorylineFile } from "../../src/thesis/thesisWorkflowTypes.js";
import type { FactView, ResearchInputSummary, ScientificFact } from "../../src/thesis/researchInputTypes.js";
import { describeFactLocation } from "../../src/thesis/tableAlignment.js";
import { GlobalBudgetLedger } from "../helpers/globalBudgetLedger.js";

const live = process.env["PAPERTEAM_M146_MM_SMOKE"] === "1";
const caseBProject = process.env["PAPERTEAM_M146_CASEB_PROJECT"] ?? "D:\\PaperTeamData\\M14_5\\projects-caseB\\p-7fb5ffbec963";
const outDir = process.env["PAPERTEAM_M146_OUT"] ?? "D:\\PaperTeamData\\M14_6\\smoke";
const ledgerPath = process.env["PAPERTEAM_M146_GLOBAL_LEDGER"] ?? "D:\\PaperTeamData\\M14_6\\m146-global-budget.json";

/** held-out 学位论文独有主题（生成端不知道；提案不得以完成时态陈述） */
const HELDOUT_ONLY_TOPICS = ["分布式编队", "六自由度", "ROS", "参数辨识", "Minimum Snap", "微分平坦", "悬停油门", "多机仿真"];
const DONE_TENSE = /(作者|本文|论文)?(已|已经)(完成|开展|实现|给出|建立|搭建|进行|具备|包含)/;

function toFactView(fact: ScientificFact): FactView {
  return {
    factId: fact.factId,
    researchInputId: fact.researchInputId,
    kind: fact.kind,
    key: fact.key,
    surface: fact.surface,
    value: fact.value,
    verification: fact.verification.status,
    sourceCheck: fact.verification.sourceCheck,
    conflictStatus: fact.conflict.status,
    location: describeFactLocation(fact),
  };
}

describe.skipIf(!live)("M14.6 Smoke B — 研究材料缺口模型提案（案例 B 真实材料）", () => {
  let adapter: PiRuntimeAdapter | undefined;
  afterAll(async () => {
    await adapter?.close().catch(() => undefined);
  });

  it("proposeScopeGaps：1 次调用；全部 proposed；held-out 独有研究不被当作既定事实", { timeout: 600_000 }, async () => {
    const runtimeRoot = process.env["PAPERTEAM_M146_RUNTIME_ROOT"] ?? join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    await registerStoredCustomProviders(modelRuntime, new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") }), () => {});
    const startupSpec = await resolveStartupModelSpec(process.env["PAPERTEAM_M146_MODEL"], new ModelSettingsStore({ settingsDir: join(runtimeRoot, "settings") }));
    expect(startupSpec).toBeDefined();
    adapter = new PiRuntimeAdapter({ modelSpec: startupSpec!, agentDir, workspaceRoot: tmpdir(), runTimeoutMs: 300_000, modelRuntime });
    const ledger = new GlobalBudgetLedger(ledgerPath, "m146-missing-material", { maxCalls: 10, maxTokens: 600_000 });
    const calls: Array<{ prompt: string; output: string; usage?: Record<string, number>; durationMs: number }> = [];
    const target = adapter;
    const counting = new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj);
        if (prop === "runAgent" && typeof value === "function") {
          return async (input: { task: string }) => {
            ledger.chargeCall();
            const startedAt = Date.now();
            const task = (await (value as (...a: unknown[]) => Promise<unknown>).apply(obj, [input])) as { output?: string; usage?: Record<string, number> };
            ledger.chargeUsage(task.usage);
            calls.push({ prompt: input.task, output: task.output ?? "", ...(task.usage !== undefined ? { usage: task.usage } : {}), durationMs: Date.now() - startedAt });
            return task;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
      },
    }) as unknown as AgentRuntime;

    // ---- 案例 B 真实产物 → 临时项目账本 ----
    const root = join(tmpdir(), `m146-mm-${Date.now()}`);
    const projects = new ProjectStore({ root });
    const project = await projects.create("M14.6 Smoke B 案例 B 缺口提案");
    const projectId = project.id;
    const read = async <T,>(rel: string): Promise<T> => JSON.parse(await readFile(join(caseBProject, rel), "utf8")) as T;
    const mapping = await read<ChapterMappingFile>("research/chapter-mapping.json");
    const contributions = (await read<ThesisContributionFile>("research/thesis-contributions.json")).items;
    const storyline = (await read<ThesisStorylineFile>("research/thesis-storyline.json")).storyline;
    const inputsFile = await read<{ inputs: Array<{ inputId: string; inputType: string; title: string; workId: string; version: { contentHash: string }; versionLabel?: string; scope: { status: string }; parse: { status: string } }> }>("research/research-inputs.json");
    const inputs: ResearchInputSummary[] = inputsFile.inputs.map((input) => ({
      inputId: input.inputId,
      inputType: input.inputType as ResearchInputSummary["inputType"],
      title: input.title,
      workId: input.workId,
      contentHash: input.version.contentHash,
      ...(input.versionLabel !== undefined ? { versionLabel: input.versionLabel } : {}),
      scope: input.scope.status as ResearchInputSummary["scope"],
      parseStatus: input.parse.status as ResearchInputSummary["parseStatus"],
    }));
    const facts = (await read<{ facts: ScientificFact[] }>("research/scientific-facts.json")).facts.map(toFactView);
    const factContext = {
      facts: {
        authorConfirmed: facts.filter((f) => f.verification === "author_confirmed"),
        sourceVerifiedUnconfirmed: facts.filter((f) => f.verification === "source_verified"),
        extractedOnly: facts.filter((f) => f.verification === "extracted"),
        conflicted: facts.filter((f) => f.conflictStatus !== "none"),
      },
      inputs: { included: inputs, excluded: [], proposed: [], superseded: [], preferredVersionByWork: {} },
    };
    expect(storyline.scopeConcerns?.length ?? 0).toBeGreaterThan(0);

    const store = new MissingMaterialLedger(projects);
    // 确定性提案（A 类：案例 B 无缺材料章 → 0；B 类：scopeConcerns 逐条）
    const deterministic = [
      ...deriveChapterMaterialGaps({ projectId, mapping, missingChapters: [], contributions, factContext }),
      ...deriveScopeGapProposals({ projectId, storyline, mapping, factContext }),
    ];
    const deterministicUpsert = await store.upsertProposals(projectId, deterministic);

    // ---- 真实模型提案（1 次调用）----
    const service = new MissingMaterialService({ runtime: counting, agentId: "writer", ledger: store, projects });
    const result = await service.proposeScopeGaps(projectId, {
      documentType: "master_thesis",
      storyline,
      chapters: mapping.chapters,
      contributions: contributions.filter((item) => item.status === "confirmed"),
      inputs,
      language: "zh",
      outlineFingerprint: mapping.outlineFingerprint,
    });
    const gaps = await store.list(projectId);
    const modelGaps = gaps.filter((gap) => gap.origin === "model_proposal");
    console.log(`[m146-mm] 模型提案 accepted=${result.proposals.length} rejected=${result.rejected.length} ledger=${gaps.length}（deterministic ${deterministic.length}）`);
    for (const gap of modelGaps) {
      console.log(`  [gap] ${gap.gapType} ch=${gap.chapterId ?? "-"} | ${gap.title} | requiresExperiment=${gap.requiresExperiment} canWrite=${gap.canWriteWithoutMaterial} | ${gap.whyInsufficient.slice(0, 120)}`);
    }
    const heldoutClaims = modelGaps.flatMap((gap) => {
      const text = `${gap.title}\n${gap.description}\n${gap.whyInsufficient}`;
      return HELDOUT_ONLY_TOPICS.filter((topic) => text.includes(topic)).map((topic) => ({ gapId: gap.gapId, topic, doneTense: DONE_TENSE.test(text) }));
    });

    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const outPath = join(outDir, `mm-proposal-${stamp}.json`);
    await writeFile(
      outPath,
      JSON.stringify({ model: startupSpec, caseBProject, deterministic: { proposals: deterministic, upsert: deterministicUpsert }, modelResult: { proposals: result.proposals, rejected: result.rejected, accepted: result.accepted, taskId: result.taskId }, ledger: gaps, heldoutClaims, calls: calls.map((call) => ({ ...call, promptChars: call.prompt.length })), budget: ledger.snapshot(), finishedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    console.log(`[m146-mm] 产物：${outPath}；账本 calls=${ledger.snapshot().totals.calls}`);

    // ---- 纪律断言 ----
    expect(calls.length).toBe(1);
    expect(gaps.every((gap) => gap.status === "proposed")).toBe(true);
    expect(modelGaps.length).toBeLessThanOrEqual(6);
    const chapterIds = new Set(mapping.chapters.map((chapter) => chapter.chapterId));
    for (const gap of modelGaps) {
      expect(gap.chapterId === undefined || chapterIds.has(gap.chapterId)).toBe(true);
      expect(gap.requiredMaterials.some((material) => material.kind === "author_confirmation")).toBe(true);
    }
    // held-out 独有主题若出现，只能是建议口径（不得完成时态）
    for (const claim of heldoutClaims) {
      expect(claim.doneTense, `提案 ${claim.gapId} 把 held-out 主题「${claim.topic}」写成已完成事实`).toBe(false);
    }
    // 确定性 B 类提案存在（Planner scopeConcerns）
    expect(gaps.some((gap) => gap.origin === "storyline_scope_concern")).toBe(true);
  });
});
