/**
 * M14.4 真实模型 Smoke（env 门控：PAPERTEAM_M144_SMOKE=1；默认跳过，不进 CI）。
 *
 * 运行：PAPERTEAM_M144_SMOKE=1 npx vitest run test/workflow/m144RealModel.smoke.test.ts
 * 模型：默认 glm/claude-fable-5-1（公司网关；凭据由 Pi SDK 自管，不经本文件）。
 * 预算：硬上限 6 次模型调用（RunBudgetLedgerRuntime 强制——本轮任务纪律
 * 「调用上限必须由实际驱动器执行」的直接验证）。
 *
 * 场景（M14.3 R3 真实形态：thesis 节文件 < 9000 字符，旧路径整文件覆写）：
 *  1. 合成中文 thesis 节文件（≈4KB：多段 + 公式 + 引用 + 确认数值 0.724）；
 *  2. 真实 reviewUnit → 真实 Finding（契约要求 quote 逐字摘录）→
 *     projectFindingTarget 确定性投影 targetQuote；
 *  3. 真实 Writer bounded 修订（logicalSpan 段落窗口 + quote 授权范围）；
 *  4. 候选守卫链（scope / fact / citation / 结构 / 塌缩）确定性裁决；
 *  5. 验证：引文区间外的原文逐字节不变；确认数值未被改动。
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
import { createThesisFromPapersDefinition } from "../../src/workflow/definitions.js";
import { runInTraceScope } from "../../src/observability/trace.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { partitionSpanIntoBlockUnits } from "../../src/review/logicalSpan.js";
import { projectFindingTarget } from "../../src/review/findingProjection.js";
import type { RevisionPlanItem, RevisionPlan } from "../../src/review/revisionPlan.js";
import type { ReviewSummary, ReviewIssue } from "../../src/review/ReviewAggregator.js";

const live = process.env["PAPERTEAM_M144_SMOKE"] === "1";
const MODEL_BUDGET = 6;

/** 合成中文 thesis 节（< 9000 字符——R3 形态；含确认数值 / 公式 / 引用） */
function thesisSectionTex(): string {
  const paragraphs = [
    "本章提出面向非二值前景图的结构化评价指标。真实场景中的显著图往往呈现不同程度的平滑过渡，传统二值化评价无法刻画这种结构差异，因此需要在像素级误差之外引入结构感知的度量维度。该动机贯穿本章方法的全部设计决策，并与后续章节的基准数据集构建相互印证。",
    "具体而言，该指标首先将前景图按连通域划分为若干结构对象，再分别计算局部与全局的感知差异并加权融合，权重由目标的空间分布决定。该设计使评价对边界模糊区域更加敏感，同时保持对整体布局差异的分辨能力。评价指标的形式化定义如下：设前景图为 $F$，结构感知项为 $S_{loc}$ 与 $S_{glo}$，则 $S = \\alpha S_{loc} + (1-\\alpha) S_{glo}$，其中 $\\alpha$ 由目标面积占比自适应确定 \\cite{ref1}。",
    "在五个公开数据集上的实验表明，该方法与人工标注的一致性显著高于传统指标，整体 S-measure 达到 0.724，优于基线方法的 0.667。消融实验进一步验证了结构划分与加权融合两个组件各自的贡献，统计显著性检验采用双边配对 t 检验（$p<0.05$）\\cite{ref2}。",
    "此外，本章还讨论了该指标在极端遮挡与低对比度场景下的失效模式：当目标面积占比低于百分之五时，结构划分的稳定性下降，指标与人工判断的相关性减弱。这一限制在后续章节的鲁棒性分析中将结合具体样本展开讨论，并给出缓解策略的初步思路与实验验证的边界条件说明。",
    "本章小结：结构化评价指标为非二值前景图的评价提供了新的度量维度，其与后续章节提出的基准数据集共同构成完整的评价体系，为视频显著性检测的方法比较提供了更可靠的工具支撑与理论依据，也为不同方法族的系统性对比实验奠定了统一的评测基础。",
  ];
  return paragraphs.join("\n\n") + "\n";
}

describe.skipIf(!live)("M14.4 真实模型 bounded 修订 smoke（thesis 节 < 9000 字符）", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  it("真实 reviewUnit → Finding 投影 → 真实 Writer bounded 修订 → 守卫 → 逐字节保持", async () => {
    const sectionTex = thesisSectionTex();
    expect(sectionTex.length).toBeLessThan(9_000); // R3 形态：< 单元上限的小节文件

    const runtimeRoot = join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const customProviderStore = new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") });
    const registered = await registerStoredCustomProviders(modelRuntime, customProviderStore, () => {});
    expect(registered).toBeGreaterThan(0);
    const adapter = new PiRuntimeAdapter({
      modelSpec: process.env["PAPERTEAM_M144_MODEL"] ?? "glm/claude-fable-5-1",
      agentDir,
      workspaceRoot: tmpdir(),
      runTimeoutMs: 240_000,
      modelRuntime,
    });
    cleanups.push(() => adapter.close());
    // 预算由驱动器强制（任务纪律：不只是写在说明里）
    const stack = await startTestStack(adapter, {
      registerCleanup: (cleanup: () => Promise<void>) => cleanups.push(cleanup),
      stageBudget: { timeoutMs: 240_000, maxAttempts: 2 },
      runBudget: { maxModelCallsPerRun: MODEL_BUDGET, maxRunTokensPerRun: 0 },
    });
    const projectId = (await stack.store.create("M14.4 real model smoke", { language: "zh", documentType: "doctoral_thesis" })).id;
    const services = stack.stack.workflowServices;
    const dir = stack.store.manuscriptDir(projectId);
    await mkdir(join(dir, "sections"), { recursive: true });
    await writeFile(join(dir, "main.tex"), "\\documentclass{ctexbook}\n\\begin{document}\n\\input{sections/ch3-method}\n\\end{document}\n");
    await writeFile(join(dir, "sections", "ch3-method.tex"), sectionTex);
    await writeFile(join(dir, "references.bib"), "@article{ref1,title={S-measure},year={2017}}\n@article{ref2,title={E-measure},year={2018}}\n");
    const baseline = await services.revisions.commit(projectId, "baseline");

    // ---- 1. 真实 reviewUnit（一次调用；契约要求 quote 逐字摘录）----
    const blocks = partitionSpanIntoBlockUnits({
      file: "sections/ch3-method.tex", logicalSection: "file:sections/ch3-method.tex",
      heading: "第三章 核心方法", start: 0, end: sectionTex.length, originalHash: "", content: sectionTex,
    });
    const unit = blocks.units[0]!;
    // 模拟 stage 执行上下文（ALS trace scope）：直调服务也按 run 归因计费，
    // 预算硬约束对本次 smoke 真实生效（任务纪律：上限由驱动器执行）。
    const stageScope = { projectId, runId: "m144-smoke-run", stageId: "review.run", attempt: 1, stageSpanId: null };
    // 真实模型输出偶发带围栏 / 不完整 JSON：一次有界重试（总调用数仍在预算内）
    let unitReview: Awaited<ReturnType<typeof services.reviewer.reviewUnit>> | undefined;
    let reviewError: unknown;
    for (let attempt = 0; attempt < 2 && unitReview === undefined; attempt += 1) {
      try {
        unitReview = await runInTraceScope(stageScope, () => services.reviewer.reviewUnit({
          projectId,
          unit: { unitId: "ch3-method#u1", file: "sections/ch3-method.tex", heading: "第三章 核心方法", unitIndex: 1, unitCount: blocks.units.length, text: unit.content },
          chapterIndex: ["第三章 核心方法"],
          language: "zh",
        }));
      } catch (error) {
        reviewError = error;
        console.log(`[m144-smoke] reviewUnit 第 ${attempt + 1} 次尝试失败（${error instanceof Error ? error.message.slice(0, 120) : String(error)}），${attempt === 0 ? "重试一次" : "放弃"}`);
      }
    }
    if (unitReview === undefined) throw reviewError;
    expect(unitReview.issues.length).toBeGreaterThan(0);

    // ---- 2. Finding → targetQuote 确定性投影（M14.1b；不猜位置）----
    const snapshot = [{ file: "sections/ch3-method.tex", content: sectionTex }];
    const projected = unitReview.issues
      .map((issue: ReviewIssue) => ({ issue, projection: projectFindingTarget(issue, snapshot) }))
      .filter((entry) => entry.projection.status === "resolved");
    expect(projected.length).toBeGreaterThan(0);
    const target = projected[0]!;
    const quote = (target.projection as { targetQuote: string }).targetQuote;
    // 确认数值所在句不在授权范围内（守卫应保持 0.724 逐字节不变）
    console.log(`[m144-smoke] 投影命中：quote=${quote.slice(0, 60)}…（basis=${(target.projection as { basis: string }).basis}）`);

    // ---- 3. 真实 Writer bounded 修订（revision.revise stage；workflowKind=thesis）----
    const item: RevisionPlanItem = {
      id: target.issue.category === "academic" ? "f-smoke-academic" : "f-smoke-other",
      kind: "review_finding",
      priority: "high",
      section: "sections/ch3-method.tex",
      problem: target.issue.description,
      instruction: `${target.issue.description}（按建议：${target.issue.suggestedAction ?? "改善该处表述"}；只修改引文定位的句子，其余逐字保留）`,
      expectedOutcome: "目标句表述改善，其余内容不变",
      status: "planned",
      actionType: "modify",
      targetQuote: quote,
    };
    const summary: ReviewSummary = {
      generatedAt: new Date().toISOString(), round: 1, reviewedRevision: baseline.revision,
      issues: [target.issue],
      counts: { critical: 0, major: 1, minor: 0, byCategory: {}, blocking: 0 },
      scores: { academicScore: unitReview.academicScore, styleRisk: unitReview.riskScore, factVerdicts: null },
      openCritical: 0, openMajor: 1, unsupportedCriticalClaims: 0,
    } as unknown as ReviewSummary;
    await services.reviewArtifacts.saveSummary(projectId, 1, summary);
    const plan: RevisionPlan = {
      schemaVersion: 1, planId: "plan-m144-smoke", projectId, sourceRevision: baseline.revision, reviewRound: 1,
      createdAt: new Date().toISOString(),
      summary: { critical: 0, major: 1, blocking: 0, minorRecorded: 0, planned: 1, skipped: 0 },
      items: [item],
    };
    await services.reviewArtifacts.savePlan(projectId, plan);
    const definition = createThesisFromPapersDefinition(services);
    const stage = definition.stages.find((s) => s.id === "revision.revise")!;
    const events: string[] = [];
    const ctx = {
      projectId, runId: "m144-smoke-run", attempt: 1, signal: new AbortController().signal,
      state: { workflowKind: "thesis_from_papers", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
      emitProgress: async () => {},
      emitDomain: async (type: string) => { events.push(type); },
      log: (message: string) => console.log(`[m144-smoke] ${message.slice(0, 160)}`),
    } as unknown as StageRunContext;
    const result = await runInTraceScope({ ...stageScope, stageId: "revision.revise" }, () =>
      (stage as { execute(context: StageRunContext): Promise<Record<string, unknown>> }).execute(ctx));

    // ---- 4. 验证：bounded 语义 + 事实保持 + 逐字节断言 ----
    const after = await readFile(join(dir, "sections", "ch3-method.tex"), "utf8");
    if (result["changed"] === true) {
      // patch lineage 指向 logicalSpan 单元（不是整文件裸覆写）
      const artifact = await services.reviewArtifacts.loadPatchValidation(projectId, await services.revisions.currentRevision(projectId));
      const applied = artifact?.records.find((entry) => entry.apply?.status === "applied");
      expect(applied).toBeDefined();
      expect(String(applied?.logicalTarget)).toContain("#");
      expect(applied?.scope.ok).toBe(true);
      // 修改前后文件的公共前后缀必须覆盖引文区间之外的全部正文：
      // 找到 first/last diff，diff 区间必须落在引文所在段落块内
      const unitOfQuote = blocks.units.find((candidate) => candidate.content.includes(quote))!;
      const prefix = commonPrefix(sectionTex, after);
      const suffix = commonSuffix(sectionTex.slice(prefix), after.slice(prefix));
      const changedStart = prefix;
      const changedEnd = sectionTex.length - suffix;
      expect(changedStart).toBeGreaterThanOrEqual(unitOfQuote.start);
      expect(changedEnd).toBeLessThanOrEqual(unitOfQuote.end);
      console.log(`[m144-smoke] 变更区间 [${changedStart}, ${changedEnd}) 落在引文段落块 [${unitOfQuote.start}, ${unitOfQuote.end}) 内；长度变化 ${after.length - sectionTex.length}`);
    } else {
      // 候选被守卫拒绝（合法结果——真实模型输出不配合时 fail-closed）：原稿逐字节保留
      expect(after).toBe(sectionTex);
      console.log(`[m144-smoke] 候选被守卫拒绝（events: ${events.join(",")}）——原稿保留，fail-closed 生效`);
    }
    // 确认数值与引用 key 无论接受与否都必须逐字保留（guard + 事实纪律）
    expect(after).toContain("0.724");
    expect(after).toContain("0.667");
    expect(after).toContain("\\cite{ref1}");
    expect(after).toContain("\\cite{ref2}");
    // 预算账本：真实调用计数 ≤ 预算硬上限
    const ledger = JSON.parse(await readFile(join(stack.store.researchDir(projectId), "model-ledger.json"), "utf8")) as { entries: Record<string, { calls: number }> };
    const entry = ledger.entries["m144-smoke-run"]!;
    expect(entry.calls).toBeLessThanOrEqual(MODEL_BUDGET);
    console.log(`[m144-smoke] 预算账本：${entry.calls}/${MODEL_BUDGET} 次调用`);
  });
});

function commonPrefix(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffix(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[a.length - 1 - index] === b[b.length - 1 - index]) index += 1;
  return index;
}
