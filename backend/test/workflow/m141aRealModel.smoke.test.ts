/**
 * M14.1a 真实模型 Smoke（env 门控：PAPERTEAM_M141A_SMOKE=1；默认跳过，不进 CI）。
 *
 * 运行：PAPERTEAM_M141A_SMOKE=1 npx vitest run test/workflow/m141aRealModel.smoke.test.ts
 * 模型：默认 settings 默认模型（当前 glm/claude-fable-5-1，公司网关；凭据由
 * Pi SDK 自管，不经本文件）。预算上限：≤6 次模型调用。
 *
 * 场景（合成内容，自造无版权约束）：
 *  1. 12.5k 字符章节 + 指向章节后段某句的 targetQuote → 真实 Writer 生成
 *     logicalSpan 编辑单元替换 → 验证 applied、单元外逐字节不变；
 *  2. 修订后的编辑单元执行一次真实 reviewUnit → 验证结构化输出 + journal。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../../src/settings/ModelSettingsService.js";
import { startTestStack } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { locateFileSpans, partitionSpanIntoUnits } from "../../src/review/logicalSpan.js";

const live = process.env["PAPERTEAM_M141A_SMOKE"] === "1";
describe.skipIf(!live)("M14.1a 真实模型局部修订 smoke", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  it(">12k 章节：真实 Writer 单元级局部修订 + 真实 reviewUnit", async () => {
    // 合成章节：段落含唯一序号 token；末段附近选锚点句
    const paragraphs: string[] = [];
    for (let index = 1; paragraphs.join("\n\n").length < 12_400; index += 1) {
      paragraphs.push(
        `Observation ${index} (run ${index}): the proposed retrieval stack was evaluated on the synthetic corpus with citation \\cite{ref${(index % 5) + 1}}. The recorded recall stays ${(index % 90) + 5}.${index % 10}\\% under the fixed protocol of section three.`,
      );
    }
    const chapterTex = `\\section{Method}\n` + paragraphs.join("\n\n") + "\n";
    const spans = locateFileSpans("sections/method.tex", chapterTex);
    const units = partitionSpanIntoUnits(spans[0]!, 9_000).units;
    expect(units.length).toBeGreaterThanOrEqual(2);
    const lastUnit = units[units.length - 1]!;
    // 锚点 = 最后单元中含唯一 token 的一句
    const anchorParagraph = paragraphs[paragraphs.length - 2]!;
    expect(lastUnit.content).toContain(anchorParagraph);

    // 与生产装配同构：ModelRuntime 共享实例 + settings 目录的自定义 provider 注册
    const runtimeRoot = join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const customProviderStore = new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") });
    const registered = await registerStoredCustomProviders(modelRuntime, customProviderStore, () => {});
    expect(registered).toBeGreaterThan(0); // 本机需已配置真实 provider（公司网关）
    const adapter = new PiRuntimeAdapter({
      modelSpec: process.env["PAPERTEAM_M141A_MODEL"] ?? "glm/claude-fable-5-1",
      agentDir,
      workspaceRoot: tmpdir(),
      runTimeoutMs: 240_000,
      modelRuntime,
    });
    cleanups.push(() => adapter.close());
    const stack = await startTestStack(adapter, { registerCleanup: (cleanup: () => Promise<void>) => cleanups.push(cleanup) });
    const projectId = (await stack.store.create("M14.1a real model smoke", { language: "en" })).id;
    const services = stack.stack.workflowServices;
    const dir = stack.store.manuscriptDir(projectId);
    await mkdir(join(dir, "sections"), { recursive: true });
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\end{document}\n");
    await writeFile(join(dir, "sections", "method.tex"), chapterTex);
    await writeFile(join(dir, "references.bib"), Array.from({ length: 5 }, (_, index) => `@article{ref${index + 1},title={Reference ${index + 1}},year={2023}}`).join("\n"));
    await services.revisions.commit(projectId, "baseline");
    await writeFile(join(stack.store.researchDir(projectId), "improvement-plan.json"), JSON.stringify({ plan: { items: [
      { id: "improvement:1", section: "sections/method.tex", actionType: "modify", priority: "high",
        action: "Rewrite the quoted sentence so the reported recall value and its protocol reference are stated precisely. Keep every other sentence byte-identical.",
        rationale: "Real model smoke: verify bounded logicalSpan edit on a >12k chapter",
        targetQuote: anchorParagraph },
    ] } }));
    const definition = createExistingPaperDefinition(services);
    const applyStage = definition.stages.find((s) => s.id === "revision.apply")!;
    const ctx = {
      projectId, runId: "m141a-real-smoke", attempt: 1, signal: new AbortController().signal,
      state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
      emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
    } as unknown as StageRunContext;
    const result = await (applyStage as { execute: (c: StageRunContext) => Promise<Record<string, unknown>> }).execute(ctx);
    const after = await readFile(join(dir, "sections", "method.tex"), "utf8");
    // 断言 1：修订发生且落在目标单元（单元前内容逐字节不变 = 未授权区域保持）
    expect(result.changed).toBe(true);
    const prefixBefore = chapterTex.slice(0, lastUnit.start);
    expect(after.startsWith(prefixBefore)).toBe(true);
    // 断言 2：变更幅度有界（只动了一个单元；非整章重写）
    expect(Math.abs(after.length - chapterTex.length)).toBeLessThan(2_000);
    // 断言 3：patch lineage 指向编辑单元且 applied
    const artifact = await services.reviewArtifacts.loadPatchValidation(projectId, await services.revisions.currentRevision(projectId));
    const record = artifact?.records.find((entry) => entry.apply.status === "applied");
    expect(record?.logicalTarget).toBe(lastUnit.logicalSection);
    expect(record?.overall).toBe("pass");

    // 真实 reviewUnit：对修订后的目标单元做一次结构化审查
    const afterUnits = partitionSpanIntoUnits(locateFileSpans("sections/method.tex", after)[0]!, 9_000).units;
    const reviewedUnit = afterUnits.find((unit) => after.slice(unit.start, unit.end).length === unit.content.length && unit.content.length > 0 && after.slice(unit.start, unit.end) === unit.content)!
      ?? afterUnits[afterUnits.length - 1]!;
    const review = await services.reviewer.reviewUnit({
      projectId,
      unit: { unitId: `${reviewedUnit.file}::${reviewedUnit.logicalSection}`, file: reviewedUnit.file, heading: "Method", unitIndex: 1, unitCount: afterUnits.length, text: reviewedUnit.content },
      chapterIndex: ["Method（sections/method.tex）"],
      signal: new AbortController().signal,
    });
    expect(review.academicScore).not.toBeNull();
    expect(Array.isArray(review.issues)).toBe(true);
    expect(review.taskId).not.toBe("(unchanged)");
  }, 600_000);
});
