/**
 * M5.4 Chinese Academic Style Revision Loop 测试：
 * - Style Invariant Checker：citation key / 数字 / 公式 / LaTeX 结构 / 受保护术语 / 哨兵词
 * - stylePolicy：suggest_only 不修改 manuscript；apply_once 才生成 style revision；
 *   minor 不被伪造为 major；默认 minor 仍 skipped；最多一轮 polish
 * - Style finding → deterministic style plan → Writer（writing/style-polish）→ invariant → 新修订
 *   → 旧 review / gate stale → 重新 review / gate / build → Final
 * - invariant violation 阻止写回（原稿保留、结果 failed、不重试）
 * - Quick Review 零写入：定义不含任何修订 / 润色 stage；POST 携带 stylePolicy → 400
 * - Style Reviewer 输出：reason 解析；AI 概率类字段不进入结果
 * - eval corpus deterministic hard checks（styleSignals：C 命中、D 零信号、连接词不误报）
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { parseModeReview, type ReviewIssue } from "../../src/agents/ReviewerService.js";
import { buildRevisionPlan } from "../../src/review/revisionPlan.js";
import {
  buildStylePolishPlan,
  listStyleFindings,
  readStylePolicy,
  styleFindingId,
} from "../../src/review/stylePolicy.js";
import {
  SENTINEL_WORDS,
  checkStyleInvariants,
  extractCitationKeys,
  extractMathSegments,
  extractNumericTokens,
} from "../../src/review/styleInvariants.js";
import { scanStyleSignals } from "../../src/review/styleSignals.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { createExistingPaperReviewDefinition } from "../../src/workflow/definitions.js";
import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "eval", "style-corpus");
const corpus = (name: string): Promise<string> => readFile(join(CORPUS, name), "utf8");

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(reviewSequence: ("pass" | "fail" | "fail2" | "fail3")[] = ["pass"]): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence });
  return startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
}

async function pollRun(stack: TestStack, runId: string, statuses: string[], timeoutMs = 20_000): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}，stage ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** idea_to_paper：可行性 / 大纲两次 approve */
async function approveFront(stack: TestStack, runId: string): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    const run = await pollRun(stack, runId, ["awaiting_input", "completed", "failed"]);
    expect(run.status).toBe("awaiting_input");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  }
}

function completions(run: WorkflowState, stageId: string): number {
  return run.stageHistory.filter((record) => record.stageId === stageId && record.status === "completed").length;
}

const styleIssue = (overrides: Partial<ReviewIssue> = {}): ReviewIssue => ({
  category: "style",
  severity: "minor",
  section: "sections/introduction.tex",
  description: "「本章节论述基于证据的核心观点」是空泛总结",
  reason: "只宣告有观点而不陈述观点",
  suggestedAction: "直接陈述核心观点",
  blocking: false,
  ...overrides,
});

function summaryOf(issues: ReviewIssue[]): ReviewSummary {
  const counts = { critical: 0, major: 0, minor: 0, blocking: 0, byCategory: {} as Record<string, number> };
  for (const issue of issues) {
    counts[issue.severity] += 1;
    if (issue.blocking) counts.blocking += 1;
    counts.byCategory[issue.category] = (counts.byCategory[issue.category] ?? 0) + 1;
  }
  return {
    generatedAt: "2026-09-14T00:00:00.000Z",
    round: 1,
    reviewedRevision: 3,
    issues,
    counts,
    scores: { academicScore: 88, styleRisk: 20, factVerdicts: null },
    openCritical: counts.critical,
    openMajor: counts.major,
    unsupportedCriticalClaims: 0,
    reportPaths: [],
  };
}

describe("M5.4 Style Invariant Checker（确定性守卫）", () => {
  it("纯表达改写通过：数字 / 引用 / 公式 / 结构 / 哨兵词全部保持", async () => {
    const before = await corpus("E-sensitive-invariants.tex");
    const after = before
      .replace("这一差异在", "该差异在")
      .replace("因此，本文只在中高负载条件下推荐使用改进策略。", "因此，本文仅在中高负载条件下推荐采用改进策略。");
    const report = checkStyleInvariants(before, after, { protectedTerms: ["改进策略", "基线组", "尾延迟"] });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.citation_keys.before).toBe(2);
    expect(report.checks.numeric_literals.before).toBeGreaterThanOrEqual(8);
    expect(report.checks.math_segments.before).toBeGreaterThanOrEqual(3);
  });

  it("citation key 被删 / 被换 → 阻断", async () => {
    const before = await corpus("E-sensitive-invariants.tex");
    expect(extractCitationKeys(before)).toEqual(["lee2021eval", "smith2020bench"]);
    const dropped = checkStyleInvariants(before, before.replace("smith2020bench, lee2021eval", "smith2020bench"));
    expect(dropped.ok).toBe(false);
    expect(dropped.violations.map((v) => v.rule)).toContain("citation_keys");
    expect(dropped.violations[0]!.missing).toEqual(["lee2021eval"]);
    const swapped = checkStyleInvariants(before, before.replace("lee2021eval", "lee2022eval"));
    expect(swapped.violations.map((v) => v.rule)).toContain("citation_keys");
  });

  it("数字 / 单位 / 百分比变化 → 阻断；数字保持但换位置不阻断", async () => {
    const before = await corpus("E-sensitive-invariants.tex");
    expect(extractNumericTokens(before)).toContain("12.4ms");
    expect(extractNumericTokens(before)).toContain("33.5%");
    expect(checkStyleInvariants(before, before.replace("12.4 ms", "12.5 ms")).violations.map((v) => v.rule)).toContain("numeric_literals");
    expect(checkStyleInvariants(before, before.replace("2.1 GB", "2.1 MB")).violations.map((v) => v.rule)).toContain("numeric_literals");
    expect(checkStyleInvariants(before, before.replace("33.5\\%", "33.5 \\%")).violations.map((v) => v.rule)).not.toContain("numeric_literals");
  });

  it("公式 / \\label / \\eqref / 环境变化 → 阻断", async () => {
    const before = await corpus("E-sensitive-invariants.tex");
    expect(extractMathSegments(before).length).toBe(3);
    const formula = checkStyleInvariants(before, before.replace("T_{\\text{base}}", "T_{\\text{new}}"));
    expect(formula.violations.map((v) => v.rule)).toContain("math_segments");
    const label = checkStyleInvariants(before, before.replace("\\label{eq:speedup}", ""));
    expect(label.violations.map((v) => v.rule)).toContain("latex_structure");
    const env = checkStyleInvariants(before, before.replace("\\begin{equation}", "\\begin{align}").replace("\\end{equation}", "\\end{align}"));
    expect(env.violations.map((v) => v.rule)).toContain("latex_structure");
  });

  it("受保护术语减少 → 阻断；否定 / 比较方向哨兵词变化 → 阻断（保守哨兵）", async () => {
    const before = await corpus("E-sensitive-invariants.tex");
    const term = checkStyleInvariants(before, before.replace("改进策略优于基线", "新方案优于基线"), { protectedTerms: ["改进策略"] });
    expect(term.violations.map((v) => v.rule)).toContain("protected_terms");
    expect(SENTINEL_WORDS).toContain("低于");
    const direction = checkStyleInvariants(before, before.replace("低于基线组的 18.7 ms", "高于基线组的 18.7 ms"));
    expect(direction.violations.map((v) => v.rule)).toContain("sentinel_words");
    const negation = checkStyleInvariants(before, before.replace("改进策略并未降低尾延迟", "改进策略降低了尾延迟"));
    expect(negation.ok).toBe(false);
    const strength = checkStyleInvariants(before, before.replace("两者差异不显著", "两者差异显著"));
    expect(strength.violations.map((v) => v.rule)).toContain("sentinel_words");
  });
});

describe("M5.4 stylePolicy / style plan（不破坏 D-0026 minor 语义）", () => {
  it("readStylePolicy：缺省 / 非法 → suggest_only；apply_once 显式", () => {
    expect(readStylePolicy(undefined)).toBe("suggest_only");
    expect(readStylePolicy({})).toBe("suggest_only");
    expect(readStylePolicy({ stylePolicy: "always" })).toBe("suggest_only");
    expect(readStylePolicy({ stylePolicy: "apply_once" })).toBe("apply_once");
  });

  it("buildRevisionPlan 默认规则不变：style minor 仍 skipped（即使 run 是 apply_once）", () => {
    const summary = summaryOf([styleIssue(), styleIssue({ severity: "major", description: "比较对象不明导致歧义" })]);
    const plan = buildRevisionPlan({ projectId: "p", sourceRevision: 3, reviewRound: 1, summary });
    const minor = plan.items.find((item) => item.id === styleFindingId(styleIssue()))!;
    expect(minor.status).toBe("skipped");
    expect(minor.priority).toBe("low");
    expect(minor.revisionReason).toBeUndefined();
    expect(plan.summary.minorRecorded).toBe(1);
    expect(plan.items.filter((item) => item.status === "planned")).toHaveLength(1); // 只有 major
  });

  it("buildStylePolishPlan：只含被选中的 style minor；severity 不被抬高；revisionReason=style_polish", () => {
    const a = styleIssue();
    const b = styleIssue({ description: "同段第三次重复「有效」", section: "sections/method.tex" });
    const summary = summaryOf([
      a,
      b,
      styleIssue({ severity: "major", description: "歧义" }),
      styleIssue({ category: "academic", description: "缺少对比实验" }),
      styleIssue({ section: "(unknown)", description: "没有位置的泛评" }),
    ]);
    const all = buildStylePolishPlan({ projectId: "p", sourceRevision: 3, reviewRound: 1, summary });
    expect(all.revisionReason).toBe("style_polish");
    expect(all.stylePolicy).toBe("apply_once");
    expect(all.items.map((item) => item.id).sort()).toEqual([styleFindingId(a), styleFindingId(b)].sort());
    expect(all.items.every((item) => item.status === "planned" && item.priority === "low" && item.revisionReason === "style_polish")).toBe(true);
    expect(all.items.every((item) => item.needsEvidence === undefined)).toBe(true);
    expect(all.summary).toMatchObject({ critical: 0, major: 0, blocking: 0, minorRecorded: 2, planned: 2, skipped: 0 });

    const selected = buildStylePolishPlan({ projectId: "p", sourceRevision: 3, reviewRound: 1, summary, selectedFindingIds: [styleFindingId(b)] });
    expect(selected.items.map((item) => item.id)).toEqual([styleFindingId(b)]);
    expect(selected.summary.skipped).toBe(1);
    expect(listStyleFindings(summary).map((f) => f.id).sort()).toEqual([styleFindingId(a), styleFindingId(b)].sort());
    expect(listStyleFindings(summary)[0]).toMatchObject({ reason: expect.any(String), proposedAction: expect.any(String), severity: "minor" });
  });

  it("Style Reviewer 输出：reason / proposedAction 解析；AI 概率类字段不进入结果", () => {
    const result = parseModeReview("style", {
      summary: "表达基本规范。",
      riskScore: 22,
      aiProbability: 0.87,
      humanProbability: 0.13,
      detectorScore: 91,
      issues: [
        {
          category: "style",
          severity: "minor",
          section: "sections/introduction.tex",
          description: "「具有重要意义」空泛",
          reason: "无具体内容支撑",
          proposedAction: "删除或改为具体结论",
          aiProbability: 0.9,
        },
      ],
    });
    expect(result.riskScore).toBe(22);
    expect(result.issues[0]).toMatchObject({ reason: "无具体内容支撑", suggestedAction: "删除或改为具体结论" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/aiProbability|humanProbability|detectorScore/);
  });
});

describe("M5.4 eval corpus deterministic hard checks（styleSignals：eval 工具，非 gate）", () => {
  it("C（机械 / 空泛 / 夸大）命中多类信号；D（正常段落，含此外 / 然而 / 因此）零信号；A 零信号", async () => {
    const c = scanStyleSignals(await corpus("C-mechanical-hollow.tex"));
    expect(c.byKind.template_opening).toBeGreaterThan(0);
    expect(c.byKind.vague_attribution).toBeGreaterThan(0);
    expect(c.byKind.promotional_adjective).toBeGreaterThan(0);
    expect(c.byKind.hollow_summary).toBeGreaterThan(0);
    expect(c.byKind.mechanical_enumeration).toBe(1);
    expect(c.byKind.overclaim).toBeGreaterThan(0);
    expect(c.total).toBeGreaterThanOrEqual(8);
    const d = scanStyleSignals(await corpus("D-normal-academic.tex"));
    expect(d.total).toBe(0);
    const a = scanStyleSignals(await corpus("A-complete-facts.tex"));
    expect(a.total).toBe(0);
    const b = scanStyleSignals(await corpus("B-insufficient-proposal.tex"));
    expect(b.total).toBe(0);
  });

  it("「此外 / 然而 / 因此」不因出现而报错；只有 ≥ 3 句连续机械开头才计为信号", () => {
    const normal = "此外，实验在两个数据集上进行。方法 A 的准确率为 91.2%。然而，其训练时间更长。因此，本文在附录报告了完整耗时。";
    expect(scanStyleSignals(normal).byKind.mechanical_transitions).toBe(0);
    const mechanical = "此外，方法有效。然而，方法有限。因此，方法必要。同时，方法简单。";
    expect(scanStyleSignals(mechanical).byKind.mechanical_transitions).toBe(1);
  });
});

describe("M5.4 Style Revision Loop（scripted workflow e2e）", () => {
  it("suggest_only（默认）：有 style finding 也不修改 manuscript，无 hitl.style_polish", async () => {
    const stack = await newStack(["pass"]);
    const project = await stack.store.create("风格建议-仅展示", { researchIdea: "[style:findings] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveFront(stack, runId);
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    expect(finished.request?.["stylePolicy"]).toBe("suggest_only");
    expect(finished.stageHistory.some((record) => record.stageId === "hitl.style_polish")).toBe(false);
    expect(completions(finished, "revision.style_polish")).toBe(0);
    expect(completions(finished, "review.run")).toBe(1);
    // finding 存在且是 minor（未被伪造为 major），只显示为建议
    const summary = (await stack.request("GET", `/api/projects/${project.id}/reviews`)).body;
    void summary;
    const plan = (await stack.request("GET", `/api/projects/${project.id}/revision-plan`)).body["plan"] as Record<string, unknown> | null;
    if (plan !== null) {
      const items = plan["items"] as Array<Record<string, unknown>>;
      expect(items.filter((item) => item["status"] === "planned")).toHaveLength(0);
    }
    const polish = (await stack.request("GET", `/api/projects/${project.id}/style-polish`)).body;
    expect(polish["result"]).toBeNull();
    const intro = await readFile(join(stack.store.manuscriptDir(project.id), "sections", "introduction.tex"), "utf8");
    expect(intro).toContain("本章节论述基于证据的核心观点");
  });

  it("apply_once：HITL 选择 → style plan → Writer → invariant 通过 → 新修订 → 重新 review/gate/build → Final；最多一轮", async () => {
    const stack = await newStack(["pass"]);
    const project = await stack.store.create("风格润色-应用一次", { researchIdea: "[style:findings] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { stylePolicy: "apply_once" });
    const runId = created.body["runId"] as string;
    await approveFront(stack, runId);
    const waiting = await pollRun(stack, runId, ["awaiting_input", "completed", "failed"]);
    expect(waiting.status).toBe("awaiting_input");
    expect(waiting.awaiting?.stageId).toBe("hitl.style_polish");
    expect(waiting.awaiting?.options).toEqual(["apply", "skip", "cancel"]);
    const payload = waiting.awaiting?.payload as Record<string, unknown>;
    const findings = payload["findings"] as Array<Record<string, unknown>>;
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]).toMatchObject({ section: "sections/introduction.tex", severity: "minor", reason: expect.any(String), proposedAction: expect.any(String) });
    expect(JSON.stringify(payload)).not.toMatch(/aiProbability|probability/i);
    const revisionBefore = (await stack.request("GET", `/api/projects/${project.id}/revisions`)).body["current"] as number;

    // 非法 payload：不是 finding id 数组 → 409；空数组 → 409
    const bad = await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "apply", payload: { selectedFindingIds: ["nope"] } });
    expect(bad.status).toBe(409);
    const empty = await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "apply", payload: { selectedFindingIds: [] } });
    expect(empty.status).toBe(409);

    const selectedIds = findings.map((finding) => finding["id"] as string);
    const resumed = await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "apply", payload: { selectedFindingIds: selectedIds } });
    expect(resumed.status).toBe(200);
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    expect(completions(finished, "hitl.style_polish")).toBe(0); // HITL 不产生 completion 记录
    expect(completions(finished, "revision.style_polish")).toBe(1); // 最多一轮
    expect(completions(finished, "review.run")).toBe(2); // 润色后重新审稿
    expect(completions(finished, "quality.gate")).toBe(2);
    expect(completions(finished, "citation.verify")).toBe(2);
    const polishResult = finished.stageResults["revision.style_polish"]!;
    expect(polishResult["status"]).toBe("applied");
    expect(polishResult["changed"]).toBe(true);
    expect(polishResult["violations"]).toBe(0);

    // 新修订 + 内容只改了表达，citation 保持
    const revisionsBody = (await stack.request("GET", `/api/projects/${project.id}/revisions`)).body;
    expect(revisionsBody["current"] as number).toBeGreaterThan(revisionBefore);
    const revisions = revisionsBody["revisions"] as Array<Record<string, unknown>>;
    expect(revisions.some((revision) => revision["reason"] === "revision.style_polish")).toBe(true);
    const intro = await readFile(join(stack.store.manuscriptDir(project.id), "sections", "introduction.tex"), "utf8");
    expect(intro).toContain("本节围绕已核验证据阐述核心观点");
    expect(intro).toContain("\\cite{gao2023survey}");
    expect(intro).not.toContain("本章节论述基于证据的核心观点");

    // style-polish 只读视图：计划 / 结果 / 已复审
    const view = (await stack.request("GET", `/api/projects/${project.id}/style-polish`)).body;
    const plan = view["plan"] as Record<string, unknown>;
    expect(plan["revisionReason"]).toBe("style_polish");
    expect((plan["items"] as unknown[]).length).toBe(selectedIds.length);
    const result = view["result"] as Record<string, unknown>;
    expect(result["status"]).toBe("applied");
    expect(result["selectedFindingIds"]).toEqual(selectedIds);
    expect(view["reReviewed"]).toBe(true);
    // Final 对齐润色后的修订（旧 gate / build 未被沿用）
    const gate = finished.stageResults["quality.gate"]!;
    expect(gate["revision"]).toBe(result["revision"]);
  });

  it("apply_once + invariant violation（Writer 删掉 \\cite）：不覆盖当前修订、结果 failed、不重试、仍可 Final", async () => {
    const stack = await newStack(["pass"]);
    const project = await stack.store.create("风格润色-违反不变量", { researchIdea: "[style:violate] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { stylePolicy: "apply_once" });
    const runId = created.body["runId"] as string;
    await approveFront(stack, runId);
    const waiting = await pollRun(stack, runId, ["awaiting_input", "completed", "failed"]);
    expect(waiting.awaiting?.stageId).toBe("hitl.style_polish");
    const revisionBefore = (await stack.request("GET", `/api/projects/${project.id}/revisions`)).body["current"] as number;
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "apply" }); // 缺省全选
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    expect(completions(finished, "revision.style_polish")).toBe(1);
    expect(finished.stageHistory.filter((record) => record.stageId === "revision.style_polish")).toHaveLength(1); // 无自动重试
    const polishResult = finished.stageResults["revision.style_polish"]!;
    expect(polishResult["status"]).toBe("failed");
    expect(polishResult["changed"]).toBe(false);
    expect(polishResult["violations"] as number).toBeGreaterThan(0);
    // 原稿保留、修订号不变、不触发重新 review
    expect((await stack.request("GET", `/api/projects/${project.id}/revisions`)).body["current"]).toBe(revisionBefore);
    expect(completions(finished, "review.run")).toBe(1);
    const intro = await readFile(join(stack.store.manuscriptDir(project.id), "sections", "introduction.tex"), "utf8");
    expect(intro).toContain("\\cite{gao2023survey}");
    expect(intro).toContain("本章节论述基于证据的核心观点");
    const view = (await stack.request("GET", `/api/projects/${project.id}/style-polish`)).body;
    const result = view["result"] as Record<string, unknown>;
    expect(result["status"]).toBe("failed");
    const sections = result["sections"] as Array<Record<string, unknown>>;
    expect(sections[0]!["invariantOk"]).toBe(false);
    expect((sections[0]!["violations"] as Array<Record<string, unknown>>).map((v) => v["rule"])).toContain("citation_keys");
    expect(view["reReviewed"]).toBeNull();
  });

  it("apply_once + skip：只保留建议，不修改稿件，直接完成", async () => {
    const stack = await newStack(["pass"]);
    const project = await stack.store.create("风格润色-跳过", { researchIdea: "[style:findings] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { stylePolicy: "apply_once" });
    const runId = created.body["runId"] as string;
    await approveFront(stack, runId);
    const waiting = await pollRun(stack, runId, ["awaiting_input", "completed", "failed"]);
    expect(waiting.awaiting?.stageId).toBe("hitl.style_polish");
    const wrong = await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    expect(wrong.status).toBe(409);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "skip" });
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);
    expect(finished.status).toBe("completed");
    expect(completions(finished, "revision.style_polish")).toBe(0);
    expect(completions(finished, "review.run")).toBe(1);
  });

  it("apply_once 但没有 style finding：不询问、不润色", async () => {
    const stack = await newStack(["pass"]);
    const project = await stack.store.create("风格润色-无发现", { researchIdea: "检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { stylePolicy: "apply_once" });
    const runId = created.body["runId"] as string;
    await approveFront(stack, runId);
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);
    expect(finished.status).toBe("completed");
    expect(finished.stageHistory.some((record) => record.stageId === "hitl.style_polish")).toBe(false);
    expect(completions(finished, "revision.style_polish")).toBe(0);
  });

  it("apply_once + Quality Gate 持续失败 → overflow accept_draft → Draft 构建前仍提供一次 style polish（M5.6 验收驱动）", async () => {
    const stack = await newStack(["fail", "fail", "fail"]);
    const project = await stack.store.create("风格润色-门禁失败仍润色", { researchIdea: "[style:findings] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { stylePolicy: "apply_once" });
    const runId = created.body["runId"] as string;
    await approveFront(stack, runId);
    // fail → fail：CONVERGED → stalled HITL → accept_draft → draftPath → style HITL
    let waiting = await pollRun(stack, runId, ["awaiting_input", "completed", "failed"]);
    const seen: string[] = [];
    while (waiting.status === "awaiting_input" && waiting.awaiting?.stageId !== "hitl.style_polish") {
      seen.push(waiting.awaiting!.stageId);
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
      waiting = await pollRun(stack, runId, ["awaiting_input", "completed", "failed"]);
    }
    expect(waiting.status).toBe("awaiting_input");
    expect(waiting.awaiting?.stageId).toBe("hitl.style_polish");
    expect(seen.some((id) => id === "hitl.revision_stalled" || id === "hitl.revision_overflow")).toBe(true);
    const reviewsBefore = completions(waiting, "review.run");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "apply" });
    let finished = await pollRun(stack, runId, ["awaiting_input", "completed", "failed"]);
    while (finished.status === "awaiting_input") {
      // 润色后复审仍失败：既有 HITL 照旧（本轮 gate 新一轮），继续 accept_draft
      expect(finished.awaiting?.stageId).not.toBe("hitl.style_polish"); // 最多一轮
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
      finished = await pollRun(stack, runId, ["awaiting_input", "completed", "failed"]);
    }
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("draft");
    expect(completions(finished, "revision.style_polish")).toBe(1);
    expect(finished.stageResults["revision.style_polish"]!["status"]).toBe("applied");
    expect(completions(finished, "review.run")).toBe(reviewsBefore + 1); // 润色后强制复审
    const intro = await readFile(join(stack.store.manuscriptDir(project.id), "sections", "introduction.tex"), "utf8");
    expect(intro).toContain("修订后的表述"); // 只改表达（scripted：「论述」→「表述」）
  });

  it("Quick Review 红线：定义不含任何修订 / 润色 stage；POST 携带 stylePolicy → 400；非法值 → 400", async () => {
    const stack = await newStack(["pass"]);
    const definition = createExistingPaperReviewDefinition(stack.stack.workflowServices);
    const ids = definition.stages.map((stage) => stage.id);
    expect(ids).toEqual(["paper.ensure", "citation.extract", "citation.metadata", "citation.claims", "review.sections", "review.aggregate"]);
    expect(ids.some((id) => id.startsWith("revision.") || id.startsWith("writing.") || id === "hitl.style_polish")).toBe(false);
    const project = await stack.store.create("快速 Review", { researchIdea: "x" });
    for (const stylePolicy of ["apply_once", "suggest_only"]) {
      const rejected = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "existing_paper_review", stylePolicy });
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.body)).toMatch(/只读|stylePolicy/);
    }
    const invalid = await stack.request("POST", `/api/projects/${project.id}/workflows`, { stylePolicy: "always" });
    expect(invalid.status).toBe(400);
  });
});
