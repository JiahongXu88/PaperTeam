/**
 * M16 工程收口 A/B：真实 review.run stage + 脚本化 runtime（零模型）。
 *
 * A（输出契约 / 修复风暴）——复现 M16 留出集真实故障：英文稿单元输出漂移成中文，中文正文里夹未转义的 ASCII 引号
 *   → 顶层 JSON 不合法 → 旧解析器回退到内层 issue 碎片 → 单元记 completed 但 0 issue / 无分数 / claims 缺失 → 修复调用。
 *   修后：只加转义修复恢复全部 issue 与 claims（零修复调用），语言漂移只记录不花调用；不可修复输出如实走重试 / 失败；
 *   中文稿 prompt 不变、不报漂移；错误体（401: {...}）不被当成合法输出。
 * B（预算与终态）——单 run 调用上限下，可选的论断修复不得挤占要求执行的跨章 / 整稿调用；
 *   四种终态（全部完成 / 单元部分失败 + 整稿完成 / 单元完成 + 整稿未执行 / 两者都不完整）的 coverage 与 Gate 呈现；
 *   off 开关回到旧的先到先得。
 * 夹具为合成稿件。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";
import { runInTraceScope } from "../../src/observability/trace.js";
import { chapterBody } from "../review/logicalSpan.test.js";
import { loadConfig } from "../../src/config/config.js";

const FILES = {
  "sections/methods.tex": `\\section{Methods}\n\n${chapterBody(4_200, "met")}`,
  "sections/results.tex": `\\section{Results}\n\n${chapterBody(4_200, "res")}`,
  "sections/analysis.tex": `\\section{Analysis}\n\n${chapterBody(4_200, "ana")}`,
};

type UnitMode =
  /** 合法英文输出（含 claims） */
  | "ok_en"
  /** M8OGl34Pmg 形态：中文 summary / description，正文里 "real-world dynamics" 未转义；claims 本身完整 */
  | "zh_stray_quotes"
  /** 合法中文输出（中文稿正常形态） */
  | "ok_zh"
  /** 合法英文输出但缺 claims（触发论断修复） */
  | "missing_claims"
  /** 只加转义也救不回来的结构错误（2IhkyiF3to 形态："summary":TERC… 缺开引号） */
  | "unrecoverable"
  /** 错误体（YiyG1tHDxq 第 6 次调用形态） */
  | "auth_error";

interface Knobs {
  unitMode: (heading: string, attempt: number) => UnitMode;
  failWhole?: boolean;
  failCross?: boolean;
}

interface Call { scope: string; task: string; heading: string; repair: boolean }

const unitQuote = "Paragraph 1: p1";

function unitOutput(mode: UnitMode, heading: string): string {
  const claims = [{ quote: unitQuote + " and more text", claimType: "method", linkedRefs: [], check: "NOT_CHECKED", note: mode === "zh_stray_quotes" ? "需与其他章节核对。" : "Needs other section." }];
  switch (mode) {
    case "ok_en":
      return JSON.stringify({ summary: `Unit ${heading} is clear.`, issues: [{ category: "academic", severity: "minor", section: heading, description: `[${heading}] The claim lacks a baseline.`, quote: unitQuote, blocking: false }], claims, academicScore: 72, riskScore: 20 });
    case "ok_zh":
      return JSON.stringify({ summary: `单元 ${heading} 结构清楚。`, issues: [{ category: "academic", severity: "minor", section: heading, description: `[${heading}] 该论断缺少强基线对比。`, quote: unitQuote, blocking: false }], claims, academicScore: 72, riskScore: 20 });
    case "missing_claims":
      return JSON.stringify({ summary: `Unit ${heading} is clear.`, issues: [{ category: "academic", severity: "minor", section: heading, description: `[${heading}] The claim lacks a baseline.`, quote: unitQuote, blocking: false }], academicScore: 72, riskScore: 20 });
    case "zh_stray_quotes": {
      // 与真实输出同构：JSON.stringify 之后把描述里转义过的 \" 还原成裸引号（模型实际产出的样子）
      const body = JSON.stringify({
        summary: `Introduction 贡献清晰，但"real-world dynamics"表述超出仿真基准范围。`,
        issues: [
          { category: "academic", severity: "major", section: heading, description: `[${heading}] 正文称 SDA "shown in Fig. 2"，但图注已呈现两阶段框架。`, quote: unitQuote, suggestedAction: `改为 "Fig. 1"。`, blocking: false },
          { category: "style", severity: "minor", section: heading, description: `[${heading}] 术语 "Habitat 3.0" 首次出现未加引用。`, quote: unitQuote, blocking: false },
        ],
        claims, academicScore: 70, riskScore: 12,
      });
      return body.replace(/\\"/g, '"');
    }
    case "unrecoverable":
      return `{"summary":TERC 与 MI 排序描述基本清楚,"issues":[{"category":"academic","severity":"minor","section":"${heading}","description":"x","quote":"${unitQuote}"}],"academicScore":60,"riskScore":10}`;
    case "auth_error":
      return `401: {"code":"1000","message":"身份验证失败。"}`;
  }
}

async function setup(options: {
  language: "en" | "zh";
  knobs: Knobs;
  wholePaper?: "on" | "off";
  maxCalls?: number;
  stageCallReserve?: "on" | "off";
}) {
  const scripted = scriptedIdeaRuntime();
  const calls: Call[] = [];
  const attemptsByHeading = new Map<string, number>();
  const runtime = {
    ...scripted.runtime,
    describeAgentContext: async () => ({ model: "glm/test", skills: ["academic-review@abc123"] }),
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      const scope = input.contextScope ?? "";
      const repair = input.metadata?.["repairField"] === "claims";
      const heading = /章节「(.+?)」/.exec(input.task)?.[1] ?? /章节：「(.+?)」/.exec(input.task)?.[1] ?? "?";
      calls.push({ scope, task: input.task, heading, repair });
      const done = (output: string) => ({ taskId: `t${calls.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [], metadata: { model: "glm/test" }, output, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0, assistantTurns: 1 } });
      const failed = (error: string) => ({ taskId: `f${calls.length}`, agentId: "reviewer", status: "failed" as const, createdAt: now, updatedAt: now, events: [], error });
      if (scope === "review/academic/unit") {
        if (repair) return done(JSON.stringify({ claims: [{ quote: unitQuote + " and more text", claimType: "method", linkedRefs: [], check: "NOT_CHECKED" }] }));
        const attempt = (attemptsByHeading.get(heading) ?? 0) + 1;
        attemptsByHeading.set(heading, attempt);
        return done(unitOutput(options.knobs.unitMode(heading, attempt), heading));
      }
      if (scope === "review/academic/consistency") return options.knobs.failCross === true ? failed("provider 503 injected") : done(JSON.stringify({ summary: "ok", issues: [] }));
      if (scope === "review/academic/whole-paper") {
        if (options.knobs.failWhole === true) return failed("provider 503 injected");
        return done(JSON.stringify({ summary: "whole", issues: [{ category: "academic", severity: "major", section: "Whole paper", description: "No comparison with the strongest recent baseline.", quote: "", blocking: true }] }));
      }
      throw new Error(`unexpected scope ${scope}`);
    },
  };
  const stack = await startTestStack(runtime, {
    registerCleanup: () => Promise.resolve(),
    review: {
      reviewConcurrency: 1, claimAudit: "extended", wholePaperSynthesis: options.wholePaper ?? "on",
      ...(options.stageCallReserve !== undefined ? { stageCallReserve: options.stageCallReserve } : {}),
    },
    ...(options.maxCalls !== undefined ? { runBudget: { maxModelCallsPerRun: options.maxCalls, maxRunTokensPerRun: 0 } } : {}),
  });
  const services = stack.stack.workflowServices;
  const projectId = (await stack.store.create("Reliability fixture", { language: options.language })).id;
  const dir = stack.store.manuscriptDir(projectId);
  await mkdir(join(dir, "sections"), { recursive: true });
  for (const [file, content] of Object.entries(FILES)) await writeFile(join(dir, file), content);
  await writeFile(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/methods}\n\\input{sections/results}\n\\input{sections/analysis}\n\\end{document}\n");
  await services.revisions.commit(projectId, "baseline");
  const definition = createExistingPaperDefinition(services);
  const stage = definition.stages.find((entry) => entry.id === "review.run")! as { execute: (c: StageRunContext) => Promise<unknown> };
  const runId = "rel-1";
  const ctx = { projectId, runId, attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
  // 预算按 trace scope（projectId × runId）归因，与 WorkflowOrchestrator 执行 stage 时一致
  await runInTraceScope({ projectId, runId, stageId: "review.run", attempt: 1, stageSpanId: null }, () => stage.execute(ctx));
  const summary = JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "review-summary-r1.json"), "utf8")) as ReviewSummary;
  const gate = evaluateQualityGate({ review: summary, citation: null, evidence: { contradictory: 0 }, feasibility: null } as unknown as Parameters<typeof evaluateQualityGate>[0]);
  const unitRecords = await services.reviewArtifacts.loadReviewUnitRecords(projectId, 1);
  return { calls, summary, gate, unitRecords };
}

const unitCalls = (calls: Call[]) => calls.filter((call) => call.scope === "review/academic/unit" && !call.repair);
const repairCalls = (calls: Call[]) => calls.filter((call) => call.repair);
const ruleOf = (gate: ReturnType<typeof evaluateQualityGate>, rule: string) => gate.rules.find((entry) => entry.rule === rule);

describe("M16 工程收口 A：英文稿中文漂移 + 未转义引号不再静默清零单元、不再触发修复风暴", () => {
  it("M8OGl34Pmg 形态：全部单元 issue 与 claims 恢复、零论断修复调用；漂移与修复如实记录（不翻译、不删 finding）", async () => {
    const h = await setup({ language: "en", knobs: { unitMode: () => "zh_stray_quotes" } });
    expect(repairCalls(h.calls)).toHaveLength(0);
    expect(unitCalls(h.calls)).toHaveLength(h.summary.coverage!.targetUnits);
    for (const record of h.unitRecords) {
      expect(record.status).toBe("completed");
      expect(record.outcome!.issues).toHaveLength(2);
      expect(record.outcome!.academicScore).toBe(70);
      expect(record.outcome!.claimExtraction?.status).toBe("EXTRACTED");
      expect(record.outcome!.outputContract?.jsonRepairs).toEqual(["stray_quote"]);
      expect(record.outcome!.outputContract?.languageDrift).toEqual(["summary", "issues", "claims"]);
      // 引号字面量保留（内容逐字，不被改写）
      expect(String(record.outcome!.issues[0]!["description"])).toContain('"shown in Fig. 2"');
    }
    const ids = h.unitRecords.map((record) => record.unitId).sort();
    expect([...h.summary.coverage!.outputContract!.jsonRepairedUnitIds].sort()).toEqual(ids);
    expect([...h.summary.coverage!.outputContract!.languageDriftUnitIds].sort()).toEqual(ids);
    expect(h.summary.coverage!.complete).toBe(true);
    const rule = ruleOf(h.gate, "review_output_contract_reported");
    expect(rule?.status).toBe("NOT_EVALUATED");
    expect(rule?.detail).toContain(`英文稿件中以中文书写的单元 ${ids.length} 个`);
  });

  it("英文稿 unit prompt 点名 summary 与 claims note 的输出语言；中文稿 prompt 不含英文语言指令、合法中文输出不报漂移", async () => {
    const en = await setup({ language: "en", knobs: { unitMode: () => "ok_en" } });
    expect(unitCalls(en.calls)[0]!.task).toContain('Write the "summary", every issue\'s free-text fields');
    expect(en.summary.coverage!.outputContract!.languageDriftUnitIds).toEqual([]);
    expect(en.summary.coverage!.outputContract!.jsonRepairedUnitIds).toEqual([]);
    expect(ruleOf(en.gate, "review_output_contract_reported")?.status).toBe("INFO");
    const zh = await setup({ language: "zh", knobs: { unitMode: () => "ok_zh" } });
    expect(unitCalls(zh.calls)[0]!.task).not.toContain("Manuscript language");
    expect(zh.summary.coverage!.outputContract!.languageDriftUnitIds).toEqual([]);
    expect(zh.unitRecords.every((record) => record.outcome?.outputContract === undefined)).toBe(true);
  });

  it("只加转义也救不回来的输出：不再记成 0 issue 的 completed，而是走既有重试；重试恢复则完成，始终不行则单元 failed、覆盖如实不完整", async () => {
    const recovered = await setup({ language: "en", knobs: { unitMode: (heading, attempt) => (heading === "Results" && attempt === 1 ? "unrecoverable" : "ok_en") } });
    const results = recovered.unitRecords.find((record) => record.unitId.includes("Results"))!;
    expect(results.status).toBe("completed");
    expect(results.attempts).toBe(2);
    expect(results.outcome!.issues).toHaveLength(1);
    expect(recovered.summary.coverage!.callAccounting).toMatchObject({ unitRetryCalls: 1 });

    const broken = await setup({ language: "en", knobs: { unitMode: (heading) => (heading === "Results" ? "unrecoverable" : "ok_en") } });
    const failed = broken.unitRecords.find((record) => record.unitId.includes("Results"))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("顶层 JSON 对象不合法");
    expect(broken.summary.coverage!.complete).toBe(false);
    expect(ruleOf(broken.gate, "review_coverage_complete")?.passed).toBe(false);
  });

  it("错误体（401: {\"code\":…}）不被当成合法审稿输出", async () => {
    const h = await setup({ language: "en", knobs: { unitMode: (heading, attempt) => (heading === "Methods" && attempt === 1 ? "auth_error" : "ok_en") } });
    const methods = h.unitRecords.find((record) => record.unitId.includes("Methods"))!;
    expect(methods.attempts).toBe(2);
    expect(methods.outcome!.issues).toHaveLength(1);
  });
});

describe("M16 工程收口 B：调用上限下整稿阶段不被可选修复挤占；四种终态如实呈现", () => {
  // 3 单元 × 缺 claims：首审 3 + 修复 ≤3 + 跨章 1 + 整稿 1 = 最多 8 次；上限 7
  it("预留 on（缺省）：最后一个单元的论断修复为跨章 / 整稿让路，整稿完成；被跳过的修复如实记录，账本保持 ABSENT", async () => {
    const h = await setup({ language: "en", maxCalls: 7, knobs: { unitMode: () => "missing_claims" } });
    expect(h.calls.length).toBeLessThanOrEqual(7);
    expect(h.summary.coverage!.wholePaper).toMatchObject({ status: "completed", required: true, executed: true, callsUsed: 1 });
    expect(h.summary.coverage!.crossChapter?.status).toBe("completed");
    expect(h.summary.coverage!.callAccounting).toMatchObject({ policy: "on", unitPrimaryCalls: 3, claimRepairCalls: 2, claimRepairsSkipped: 1, crossChapterCalls: 1, wholePaperCalls: 1, limitedBy: "run_or_task_budget" });
    const skipped = h.unitRecords.filter((record) => record.outcome?.claimExtraction?.repairSkippedReason === "BUDGET_RESERVED_FOR_REQUIRED_STAGES");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.outcome!.claimExtraction!.status).toBe("ABSENT");
    expect(ruleOf(h.gate, "review_whole_paper_reported")?.status).toBe("INFO");
    expect(ruleOf(h.gate, "review_output_contract_reported")?.detail).toContain("论断修复 1");
  });

  it("预留 off（旧行为）：修复先到先得 → 整稿被预算拒绝 → skipped BUDGET_EXHAUSTED，Gate 明示本轮不是 hybrid", async () => {
    const h = await setup({ language: "en", maxCalls: 7, stageCallReserve: "off", knobs: { unitMode: () => "missing_claims" } });
    expect(h.summary.coverage!.callAccounting).toMatchObject({ policy: "off", claimRepairCalls: 3, claimRepairsSkipped: 0 });
    expect(h.summary.coverage!.wholePaper).toMatchObject({ status: "skipped", required: true, executed: false, skippedReason: "BUDGET_EXHAUSTED", callsUsed: 0 });
    expect(h.summary.issues.some((issue) => issue.origin === "whole_paper_synthesis")).toBe(false);
    const rule = ruleOf(h.gate, "review_whole_paper_reported");
    expect(rule?.status).toBe("NOT_EVALUATED");
    expect(rule?.detail).toContain("不是 hybrid");
    expect(rule?.passed).toBe(true); // informational：不改变判定
  });

  it("单元重试只为未开始的单元首审让路，不为整稿牺牲正文覆盖", async () => {
    // 上限 6：首审 3 + 1 次重试 + 跨章 1 + 整稿 1；Results 首审不可解析
    const h = await setup({ language: "en", maxCalls: 6, knobs: { unitMode: (heading, attempt) => (heading === "Results" && attempt === 1 ? "unrecoverable" : "ok_en") } });
    expect(h.summary.coverage!.complete).toBe(true);
    expect(h.summary.coverage!.callAccounting).toMatchObject({ unitRetryCalls: 1, unitRetriesSkipped: 0 });
    expect(h.summary.coverage!.wholePaper?.status).toBe("completed");
  });

  const terminal = async (unitMode: Knobs["unitMode"], failWhole: boolean) => {
    const h = await setup({ language: "en", knobs: { unitMode, failWhole } });
    return {
      coverageComplete: h.summary.coverage!.complete,
      whole: h.summary.coverage!.wholePaper!,
      coverageRule: ruleOf(h.gate, "review_coverage_complete")!,
      wholeRule: ruleOf(h.gate, "review_whole_paper_reported")!,
    };
  };

  it("四种终态：executed / required / skipped / calls / coverage 各自独立呈现，整稿不进正文覆盖分母", async () => {
    const allOk = await terminal(() => "ok_en", false);
    expect(allOk.coverageComplete).toBe(true);
    expect(allOk.whole).toMatchObject({ status: "completed", required: true, executed: true, callsUsed: 1 });
    expect(allOk.wholeRule.status).toBe("INFO");

    const unitPartial = await terminal((heading) => (heading === "Results" ? "unrecoverable" : "ok_en"), false);
    expect(unitPartial.coverageComplete).toBe(false);
    expect(unitPartial.coverageRule.passed).toBe(false);
    expect(unitPartial.whole).toMatchObject({ status: "completed", executed: true });

    const wholeMissing = await terminal(() => "ok_en", true);
    expect(wholeMissing.coverageComplete).toBe(true);
    expect(wholeMissing.coverageRule.passed).toBe(true);
    expect(wholeMissing.whole).toMatchObject({ status: "failed", required: true, executed: false, callsUsed: 1 });
    expect(wholeMissing.wholeRule.status).toBe("NOT_EVALUATED");

    const both = await terminal((heading) => (heading === "Results" ? "unrecoverable" : "ok_en"), true);
    expect(both.coverageComplete).toBe(false);
    expect(both.whole.status).toBe("failed");
    expect(both.wholeRule.status).toBe("NOT_EVALUATED");
  });

  it("whole-paper=off：无整稿调用、无 wholePaper 字段，Gate 写明本轮为纯单元审查（NOT_APPLICABLE）", async () => {
    const h = await setup({ language: "en", wholePaper: "off", knobs: { unitMode: () => "ok_en" } });
    expect(h.calls.some((call) => call.scope === "review/academic/whole-paper")).toBe(false);
    expect(h.summary.coverage!.wholePaper).toBeUndefined();
    expect(ruleOf(h.gate, "review_whole_paper_reported")?.status).toBe("NOT_APPLICABLE");
  });

  it("配置：PAPERTEAM_REVIEW_STAGE_CALL_RESERVE 缺省 on，off 可回滚", () => {
    expect(loadConfig({}).review.stageCallReserve).toBe("on");
    expect(loadConfig({ PAPERTEAM_REVIEW_STAGE_CALL_RESERVE: " OFF " }).review.stageCallReserve).toBe("off");
  });
});
