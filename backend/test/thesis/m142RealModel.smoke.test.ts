/**
 * M14.2 真实模型 Smoke（env 门控：PAPERTEAM_M142_SMOKE=1；默认跳过，不进 CI）。
 *
 * 运行（服务器，凭据在隔离 runtime root）：
 *   PAPERTEAM_M142_SMOKE=1 \
 *   PAPERTEAM_M142_RUNTIME_ROOT=/data/paperteam-m14-2/runtime \
 *   npx vitest run test/thesis/m142RealModel.smoke.test.ts
 *
 * 验证真实模型能经 thesis_from_papers 的受控通路工作（预算 ≤4 次调用）：
 *  1. thesis/contributions：真实模型从合成研究材料提取贡献（quote 逐字锚定由
 *     确定性代码核验——锚定失败如实 not_found，不猜）；
 *  2. thesis/outline：真实模型基于已确认贡献规划主线 + 两级大纲 + 章节映射，
 *     通过全部确定性校验（贡献恰被一章拥有 / experiment 章拥有贡献 /
 *     contributionsOrder 全覆盖 / 单节章标题一致）并落盘四工件；
 *  3. writing/sections（thesis 上下文注入）：真实 Writer 携带【学位论文章节】
 *     【科研事实纪律】纪律块写一节中文正文。
 *
 * 语料：合成内容（自造，无版权约束；数值为编造的示例值，仅验证链路）。
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../../src/settings/ModelSettingsService.js";
import { ModelSettingsStore, resolveStartupModelSpec } from "../../src/settings/ModelSettingsStore.js";
import { ManuscriptService } from "../../src/manuscript/ManuscriptService.js";
import { LatexCompiler } from "../../src/latex/LatexCompiler.js";
import { ThesisDocumentService } from "../../src/thesis/ThesisDocumentService.js";
import { ThesisPlannerService } from "../../src/thesis/ThesisPlannerService.js";
import { WriterService } from "../../src/writer/WriterService.js";
import { buildThesisSectionContext } from "../../src/thesis/thesisWritingContext.js";
import { buildResearchFactContext } from "../../src/thesis/plannerContext.js";
import type { ThesisChapterPlan } from "../../src/thesis/thesisWorkflowTypes.js";
import { newThesisFixture, textBlock, type ThesisFixture } from "./fixtures.js";

const live = process.env["PAPERTEAM_M142_SMOKE"] === "1";
const tempRoots: string[] = [];

describe.skipIf(!live)("M14.2 真实模型 smoke（贡献提取 / 主线大纲 / 章节写作）", () => {
  let adapter: PiRuntimeAdapter;
  let fx: ThesisFixture;
  let planner: ThesisPlannerService;
  let writer: WriterService;
  let contributionsAnchored = 0;

  afterAll(async () => {
    await adapter?.close().catch(() => undefined);
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("1+2：真实贡献提取（quote 锚定）→ 确认 → 真实主线/大纲/映射规划（确定性校验全过）", async () => {
    const runtimeRoot =
      process.env["PAPERTEAM_M142_RUNTIME_ROOT"] ?? join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    // provider 可能来自 auth.json（zai 网关）或 custom-providers.json——两者都注册，计数不设断言
    const customProviderStore = new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") });
    const registered = await registerStoredCustomProviders(modelRuntime, customProviderStore, () => {});
    console.log(`[m142-model] 自定义 provider 注册=${registered}（0 = provider 由 auth.json 提供）`);
    const startupSpec = await resolveStartupModelSpec(
      process.env["PAPERTEAM_M142_MODEL"],
      new ModelSettingsStore({ settingsDir: join(runtimeRoot, "settings") }),
    );
    expect(startupSpec).toBeDefined();
    adapter = new PiRuntimeAdapter({
      modelSpec: startupSpec!,
      agentDir,
      workspaceRoot: tmpdir(),
      runTimeoutMs: 300_000,
      modelRuntime,
    });

    fx = await newThesisFixture();
    tempRoots.push(fx.root);
    const thesisDocuments = new ThesisDocumentService(fx.projects, new LatexCompiler({ timeoutMs: 1_000 }));
    planner = new ThesisPlannerService({
      runtime: adapter,
      agentId: "writer",
      projects: fx.projects,
      manuscript: new ManuscriptService(fx.projects),
      researchInputs: fx.service,
      thesisDocuments,
      documents: fx.documents,
    });
    writer = new WriterService({ runtime: adapter, agentId: "writer" });

    // 合成研究材料（编造的示例内容，验证链路）
    const abstract =
      "针对移动端视频显著性检测的实时性问题，本文提出轻量时空选择网络 LTSN。" +
      "LTSN 通过时空门控模块显式建模运动线索，并在三个公开数据集上取得一致的精度-速度权衡。" +
      "实验表明，LTSN 在 DAVSOD 上 S 度量达到 0.741，同时保持每秒 42 帧的推理速度，" +
      "相对基线方法在精度不损失的前提下推理时延降低 37%。";
    const input = await fx.importPdf(
      { fileName: "ltsn.pdf", blocks: [textBlock("B0001", 1, abstract), textBlock("B0002", 2, "方法与实验细节见后文。")] },
      "published_paper",
      { title: "LTSN: 轻量时空选择网络" },
    );
    await fx.service.submitDecision(fx.projectId, {
      actor: { kind: "test_fixture" },
      payload: { type: "scope_decision", inputId: input.inputId, scope: "included" },
    });

    // ---- 调用 1：真实贡献提取 ----
    const extraction = await planner.extractContributions(fx.projectId, { language: "zh" });
    expect(extraction.inputsProcessed).toBe(1);
    expect(extraction.proposals).toBeGreaterThan(0);
    const items = (await planner.loadContributions(fx.projectId))?.items ?? [];
    contributionsAnchored = items.filter((item) => item.anchorStatus === "verbatim").length;
    console.log(`[m142-model] 贡献提取：proposals=${extraction.proposals} anchored=${contributionsAnchored}`);
    const methodItems = items.filter((item) => item.kind === "method" || item.kind === "research_question");
    expect(methodItems.length).toBeGreaterThan(0);

    // 确认全部提案（test_fixture actor——生产中由作者在 HITL 确认）
    await planner.confirmContributions(fx.projectId, {
      contributionIds: items.map((item) => item.id),
      outcome: "confirmed",
      actorKind: "test_fixture",
    });

    // ---- 调用 2：真实主线 + 大纲 + 映射（±≤2 repair）----
    const plan = await planner.planStoryline(fx.projectId, { language: "zh" });
    console.log(
      `[m142-model] 大纲规划：structure=${plan.storyline.structure} chapters=${plan.chapters.length} sections=${plan.outline.sections.length} repair=${plan.repairAttempts}`,
    );
    expect(plan.chapters.length).toBeGreaterThanOrEqual(3);
    expect(plan.outline.sections.length).toBeGreaterThanOrEqual(3);
    const mapping = await planner.loadMapping(fx.projectId);
    expect(mapping?.status).toBe("proposed");
    const model = await thesisDocuments.loadModel(fx.projectId);
    expect(model).not.toBeNull();
    const methodChapter = plan.chapters.find((chapter) => chapter.responsibility === "method");
    expect(methodChapter).toBeDefined();
    expect((methodChapter as ThesisChapterPlan).ownsContributionIds.length).toBeGreaterThan(0);
  }, 600_000);

  it("3：真实 Writer 携带 thesis 纪律块写核心方法节（事实纪律注入链路）", async () => {
    const mapping = await planner.loadMapping(fx.projectId);
    const outline = await new ManuscriptService(fx.projects).loadOutline(fx.projectId);
    expect(mapping).not.toBeNull();
    expect(outline).not.toBeNull();
    const chapter = mapping!.chapters.find((entry) => entry.responsibility === "method")!;
    const sectionFile = chapter.sectionFiles[0]!;
    const section = outline!.sections.find((entry) => entry.file === sectionFile)!;

    const registryFile = await fx.service.list(fx.projectId);
    const factsFile = await fx.service.facts.load(fx.projectId);
    const context = buildResearchFactContext({
      projectId: fx.projectId,
      inputs: registryFile.inputs,
      workGroups: registryFile.workGroups,
      facts: factsFile.facts,
      conflicts: factsFile.conflicts,
      now: new Date().toISOString(),
    });
    const contributions = await planner.loadContributions(fx.projectId);
    const statements = new Map(
      (contributions?.items ?? []).map((item) => [item.id, { statement: item.statement, kind: item.kind }]),
    );
    const writingContext = buildThesisSectionContext({
      chapter: { ...chapter, factIds: [...chapter.factIds] },
      sectionFile,
      sectionTitle: section.title,
      sectionIndex: 0,
      sectionCount: chapter.sectionFiles.length,
      factContext: context,
      contributionStatements: statements,
      sourceProjection: null,
      limitationMode: false,
    });

    const result = await writer.writeSection({
      projectId: fx.projectId,
      section,
      outline: outline!,
      evidence: [],
      bibliography: [],
      language: "zh",
      extraInstructions: writingContext.extraInstructions,
    });
    console.log(
      `[m142-model] 章节写作：chars=${result.latex.length} taskId=${result.taskId} usage=${JSON.stringify(result.usage ?? null)}`,
    );
    expect(result.latex.trim()).not.toBe("");
    expect(result.latex).not.toContain("\\documentclass");
    // 纪律块确实进入 prompt（确定性拼接，另由 E2E 断言；此处记录上下文规模）
    expect(writingContext.extraInstructions).toContain("【科研事实纪律】");
    expect(writingContext.summary.authorConfirmedFacts).toBe(0); // 未做 fact_confirmation
  }, 600_000);

  it("（不新增调用）usage 记录：提取 / 规划 / 写作的真实调用各 1 次", async () => {
    const tasks = (adapter as unknown as { listTasks?: () => unknown[] }).listTasks?.() ?? [];
    console.log(`[m142-model] adapter 任务数=${tasks.length}（预算 ≤4 次模型调用）`);
    expect(tasks.length).toBeLessThanOrEqual(6); // 提取1 + 规划1..3(repair) + 写作1
    void contributionsAnchored;
  });
});
