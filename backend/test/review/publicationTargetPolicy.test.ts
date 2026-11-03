/**
 * 发表目标 + 审稿政策（publication-target/v1 · review-policy/v1）验收测试（零模型）。
 * 对应 docs/research/PUBLICATION_TARGET_REVIEW_POLICY_PRODUCT_CLOSURE.md 的 T0–T6 门。
 */
import { describe, expect, it } from "vitest";

import { ReviewerService, buildReviewPrompt, buildWholePaperPrompt } from "../../src/agents/ReviewerService.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import {
  BASELINE_DIMENSIONS,

  normalizePublicationTarget,
  PublicationTargetValidationError,
  readReviewPolicySnapshot,
  renderDigestPolicyLines,
  renderUnitPolicyLines,
  renderWholePaperPolicy,
  reviewPolicySummary,
  tierFactOf,
  type PublicationTarget,
} from "../../src/review/publicationPolicy.js";
import { buildRevisionGoalSummaryLines } from "../../src/review/revisionGoalSummary.js";
import { buildRevisionPlan } from "../../src/review/revisionPlan.js";
import { freezeReviewPolicy } from "../../src/review/reviewPolicySnapshot.js";
import { buildQualityReport } from "../../src/quality/qualityReport.js";
import { listBuiltinJournalProfiles, resolveJournalProfile } from "../../src/target/journal/profileRegistry.js";
import type { AgentRuntime } from "../../src/runtime/types.js";

const NOW = new Date("2026-11-03T00:00:00.000Z");
const KNOWN = new Set(listBuiltinJournalProfiles().map((profile) => profile.journalId));
const CJIG = listBuiltinJournalProfiles().find((profile) => profile.identity.nameZh?.includes("图象图形")) ?? listBuiltinJournalProfiles()[0]!;

function target(raw: Record<string, unknown>): PublicationTarget {
  const value = normalizePublicationTarget(raw, { now: NOW, knownJournalIds: KNOWN });
  if (value === null) throw new Error("expected target");
  return value;
}

function snapshot(workflowKind: string, documentType: string | undefined, raw: Record<string, unknown> | null) {
  return freezeReviewPolicy(
    { ...(documentType !== undefined ? { documentType } : {}), ...(raw !== null ? { publicationTarget: target(raw) } : {}) },
    workflowKind,
    NOW,
  );
}

function fakeRuntime(outputs: string[]): { runtime: AgentRuntime; prompts: string[] } {
  const prompts: string[] = [];
  const runtime = {
    runAgent: async (input: { task: string }) => {
      prompts.push(input.task);
      const now = new Date().toISOString();
      return { taskId: `t${prompts.length}`, agentId: "reviewer", status: "completed", createdAt: now, updatedAt: now, output: outputs.shift() ?? "{}", events: [] };
    },
  } as unknown as AgentRuntime;
  return { runtime, prompts };
}

const UNIT = { unitId: "main.tex::section:A", file: "main.tex", heading: "实验", unitIndex: 1, unitCount: 2, text: "表 2 显示本文方法在 MOT17 上达到 61.7 HOTA，优于所有基线方法。" };
const UNIT_OK = JSON.stringify({ summary: "ok", issues: [], academicScore: 70, riskScore: 20 });

describe("T1 配置校验与来源：体系不混、层级不虚假核实", () => {
  it("CAS 与 JCR 是两套体系：层级不可互换；SCI / EI / Scopus 含糊输入被拒并给出引导", () => {
    expect(target({ scheme: "cas", tier: "1" }).tier).toBe("1");
    expect(target({ scheme: "jcr", tier: "q1" }).tier).toBe("Q1");
    expect(() => target({ scheme: "cas", tier: "Q1" })).toThrow(PublicationTargetValidationError);
    expect(() => target({ scheme: "jcr", tier: "1" })).toThrow(/JCR 分区 的层级只能是/);
    expect(() => target({ scheme: "sci", tier: "1" })).toThrow(/中科院分区（cas）与 JCR 分区（jcr）/);
    expect(() => target({ scheme: "EI" })).toThrow(/不是 SCI 分区/);
    expect(() => target({ scheme: "cscd" })).toThrow(/chinese_index/);
  });

  it("中文核心类三个体系独立校验；不存在跨体系等级", () => {
    for (const tier of ["PKU_CORE", "CSCD", "CSSCI"]) expect(target({ scheme: "chinese_index", tier }).tier).toBe(tier);
    expect(() => target({ scheme: "chinese_index", tier: "Q1" })).toThrow(PublicationTargetValidationError);
    expect(() => target({ scheme: "chinese_index" })).toThrow(/需要选择层级/);
  });

  it("年份 / 期刊 / 自填名称 / 非法字段 / none 组合", () => {
    expect(target({ scheme: "jcr", tier: "Q3", schemeYear: 2025 }).schemeYear).toBe(2025);
    expect(() => target({ scheme: "jcr", tier: "Q3", schemeYear: 1800 })).toThrow(/schemeYear/);
    expect(() => target({ scheme: "jcr", tier: "Q3", schemeYear: 2030 })).toThrow(/schemeYear/);
    expect(() => target({ scheme: "none", tier: "Q1" })).toThrow(/scheme=none/);
    expect(() => target({ scheme: "none", targetJournalId: "not-a-journal" })).toThrow(/不在已核验期刊资料库/);
    expect(() => target({ scheme: "none", targetJournalId: CJIG.journalId, customJournalName: "X" })).toThrow(/二选一/);
    expect(() => target({ scheme: "jcr", tier: "Q2", passThreshold: 90 })).toThrow(/不支持字段 passThreshold/);
    expect(normalizePublicationTarget({ scheme: "none" }, { now: NOW, knownJournalIds: KNOWN })).toBeNull();
    expect(normalizePublicationTarget(null, { now: NOW, knownJournalIds: KNOWN })).toBeNull();
    expect(target({ scheme: "none", customJournalName: "某自填期刊" }).customJournalName).toBe("某自填期刊");
  });

  it("层级事实：CAS / JCR 恒为未核实；中文收录只认已核验 profile 的官方自述；自述缺失（北大核心 UNVERIFIED）不升级", () => {
    expect(tierFactOf(target({ scheme: "cas", tier: "2", schemeYear: 2025 }), null).status).toBe("USER_TARGET_UNVERIFIED");
    expect(tierFactOf(target({ scheme: "jcr", tier: "Q1" }), CJIG).status).toBe("USER_TARGET_UNVERIFIED");
    const cscd = tierFactOf(target({ scheme: "chinese_index", tier: "CSCD", targetJournalId: CJIG.journalId }), CJIG);
    expect(cscd.status).toBe("JOURNAL_SELF_DECLARED");
    expect(cscd.sourceUrl).toMatch(/^https?:\/\//);
    expect(cscd.note).toContain("不代表本系统核实了最新名单");
    expect(tierFactOf(target({ scheme: "chinese_index", tier: "PKU_CORE", targetJournalId: CJIG.journalId }), CJIG).status).toBe("USER_TARGET_UNVERIFIED");
    // 自填期刊名：即使名称与已核验期刊相同，也不借用其 profile 自述
    const custom = snapshot("idea_to_paper", "research_article", { scheme: "chinese_index", tier: "CSCD", customJournalName: CJIG.identity.nameZh });
    expect(custom.targetJournal).toBeNull();
    expect(custom.tierFact.status).toBe("USER_TARGET_UNVERIFIED");
  });
});

describe("T0 向后兼容：未设置目标 / 旧 run", () => {
  it("研究论文 + 无目标：快照 inactive，单元 / 整稿 / digest prompt 与无政策时逐字节一致", async () => {
    const generic = snapshot("idea_to_paper", "research_article", null);
    expect(generic.active).toBe(false);
    expect(renderUnitPolicyLines(generic)).toEqual([]);
    expect(renderWholePaperPolicy(generic)).toBeNull();
    expect(renderDigestPolicyLines(generic)).toBeNull();
    for (const language of ["zh", "en"] as const) {
      expect(buildWholePaperPrompt({ text: "正文", inputMode: "FULL_TEXT", language, reviewPolicy: generic }))
        .toBe(buildWholePaperPrompt({ text: "正文", inputMode: "FULL_TEXT", language }));
    }
    const base = { projectId: "p", mode: "academic" as const, manuscriptDigest: "d", evidence: [], targetProfile: "core_journal" };
    expect(buildReviewPrompt({ ...base, reviewPolicy: generic })).toBe(buildReviewPrompt(base));
    expect(buildReviewPrompt(base)).toContain("结合目标档次标准执行（目标档次：core_journal）");

    const a = fakeRuntime([UNIT_OK]);
    await new ReviewerService({ runtime: a.runtime, agentId: "r", projects: {} as never }).reviewUnit({ projectId: "p", unit: UNIT, chapterIndex: ["实验"] });
    const b = fakeRuntime([UNIT_OK]);
    await new ReviewerService({ runtime: b.runtime, agentId: "r", projects: {} as never }).reviewUnit({ projectId: "p", unit: UNIT, chapterIndex: ["实验"], reviewPolicy: generic });
    expect(b.prompts[0]).toBe(a.prompts[0]);
  });

  it("旧 run checkpoint 无 reviewPolicy / 字段损坏 → null（= 旧行为）", () => {
    expect(readReviewPolicySnapshot(undefined)).toBeNull();
    expect(readReviewPolicySnapshot({ schemaVersion: "review-policy/v1", policyVersion: "publication-review-policy/0" })).toBeNull();
    expect(readReviewPolicySnapshot({ ...snapshot("idea_to_paper", undefined, null), articleType: "novel" })).toBeNull();
    expect(readReviewPolicySnapshot(JSON.parse(JSON.stringify(snapshot("idea_to_paper", undefined, { scheme: "jcr", tier: "Q2" }))))).not.toBeNull();
  });
});

describe("T2 Rubric 真正生效：同一论文不同目标 → 关注点可检查地不同，底线不变", () => {
  it("CAS 二区（elevated）与 JCR Q4（standard）与北大核心（domestic）的关注点排序不同；底线维度逐字相同", () => {
    const high = snapshot("idea_to_paper", "research_article", { scheme: "cas", tier: "2" });
    const low = snapshot("idea_to_paper", "research_article", { scheme: "jcr", tier: "Q4" });
    const pku = snapshot("idea_to_paper", "research_article", { scheme: "chinese_index", tier: "PKU_CORE" });
    expect(high.emphasis).toBe("elevated");
    expect(low.emphasis).toBe("standard");
    expect(pku.emphasis).toBe("domestic_index");
    expect(high.focus.slice(0, 2)).toEqual(["contribution_boundary", "strong_baselines"]);
    expect(low.focus[0]).toBe("claim_result_match");
    expect(high.focus).not.toEqual(low.focus);
    expect(high.baseline).toEqual(low.baseline);
    expect(high.baseline).toEqual(BASELINE_DIMENSIONS.map((dim) => dim.id));
    expect(high.policyHash).not.toBe(low.policyHash);
  });

  it("整稿与单元的实际 prompt 带冻结目标与纪律；不出现分数线 / 录用预测；整稿要求 policyDimension", async () => {
    const high = snapshot("existing_paper_improvement", "research_article", { scheme: "cas", tier: "2", schemeYear: 2025 });
    const whole = buildWholePaperPrompt({ text: "正文", inputMode: "FULL_TEXT", language: "zh", reviewPolicy: high });
    expect(whole).toContain("中科院二区（2025 年名单）——用户设定目标，未核实");
    expect(whole).toContain("[contribution_boundary]");
    expect(whole).toContain("policyDimension");
    expect(whole).toContain("不得编造论文名、年份、DOI");
    expect(whole).toContain("不是该层级的官方标准");
    const wholeEn = buildWholePaperPrompt({ text: "body", inputMode: "FULL_TEXT", language: "en", reviewPolicy: high });
    expect(wholeEn).toContain("user-stated target, not verified");
    const rt = fakeRuntime([UNIT_OK]);
    await new ReviewerService({ runtime: rt.runtime, agentId: "r", projects: {} as never }).reviewUnit({ projectId: "p", unit: UNIT, chapterIndex: ["实验"], reviewPolicy: high, language: "zh" });
    const unitPrompt = rt.prompts[0]!;
    expect(unitPrompt).toContain("===== 审稿政策（publication-review-policy/1；本次运行冻结）=====");
    expect(unitPrompt).toContain("整稿层面的贡献 / 实验充分性 / 跨章问题由整稿与跨章审查负责");
    // 单元只看可定位细节：整稿作用域维度（如强基线 / 消融）不进入单元关注点
    expect(unitPrompt).not.toContain("最近 / 最强相关基线");
    expect(unitPrompt).toContain("对比公平性");
    for (const prompt of [whole, wholeEn, unitPrompt, renderDigestPolicyLines(high)!.join("\n")]) {
      expect(prompt).not.toMatch(/(?:Q1|一区|二区)[^。\n]{0,12}(?:≥|>=|>)\s*\d{2}\s*分/);
      expect(prompt).not.toMatch(/录用概率|acceptance probability|保证录用|100%/);
    }
  });

  it("digest 路：设置目标时替代旧「目标档次」行（只改 academic）；fact / style prompt 不变", () => {
    const pol = snapshot("idea_to_paper", "research_article", { scheme: "jcr", tier: "Q1" });
    const base = { projectId: "p", manuscriptDigest: "d", evidence: [], targetProfile: "top_journal" };
    const academic = buildReviewPrompt({ ...base, mode: "academic", reviewPolicy: pol });
    expect(academic).not.toContain("结合目标档次标准执行");
    expect(academic).toContain("scores 是未经校准的审稿参考分");
    expect(buildReviewPrompt({ ...base, mode: "fact", reviewPolicy: pol })).toBe(buildReviewPrompt({ ...base, mode: "fact" }));
    expect(buildReviewPrompt({ ...base, mode: "style", reviewPolicy: pol })).toBe(buildReviewPrompt({ ...base, mode: "style" }));
  });

  it("模型返回的 policyDimension：registry 内的 id 保留；伪造 id 丢弃；severity / blocking 语义不变", async () => {
    const pol = snapshot("idea_to_paper", "research_article", { scheme: "jcr", tier: "Q2" });
    const rt = fakeRuntime([JSON.stringify({ summary: "s", issues: [
      { category: "academic", severity: "major", section: "全文", description: "缺少与强基线的比较", policyDimension: "strong_baselines", blocking: true },
      { category: "academic", severity: "minor", section: "全文", description: "贡献表述略夸大", policyDimension: "q1_threshold_90" },
    ] })]);
    const out = await new ReviewerService({ runtime: rt.runtime, agentId: "r", projects: {} as never }).reviewWholePaper({ projectId: "p", text: "正文", inputMode: "FULL_TEXT", reviewPolicy: pol });
    expect(out.issues[0]).toMatchObject({ policyDimension: "strong_baselines", blocking: false, verification: "AUTHOR_CHECK_REQUIRED", origin: "whole_paper_synthesis" });
    expect(out.issues[1]!.policyDimension).toBeUndefined();
  });
});

describe("T3 稿件类型区分", () => {
  it("documentType / workflowKind → research / survey / thesis（与路由映射同源）", () => {
    expect(snapshot("idea_to_paper", "research_article", null).articleType).toBe("research");
    expect(snapshot("topic_survey", "survey", null).articleType).toBe("survey");
    expect(snapshot("existing_paper_improvement", "综述论文", null).articleType).toBe("survey");
    expect(snapshot("thesis_from_papers", "master_thesis", null).articleType).toBe("thesis");
    expect(snapshot("existing_paper_improvement", "doctoral_thesis", null).articleType).toBe("thesis");
  });

  it("综述：整稿审查不再套用基线 / 消融口径，并明确「无原创实验不是缺陷」；无目标也生效", () => {
    const survey = snapshot("topic_survey", "survey", null);
    expect(survey.active).toBe(true);
    const prompt = buildWholePaperPrompt({ text: "正文", inputMode: "FULL_TEXT", language: "zh", reviewPolicy: survey });
    expect(prompt).not.toContain("缺少与具体的强基线 / 最新方法的比较");
    expect(prompt.split("\n").filter((line) => line.startsWith("- ")).some((line) => /消融|基线/.test(line))).toBe(false);
    expect(prompt).toContain("[search_inclusion_criteria]");
    expect(prompt).toContain("不得因「缺少实验 / 消融 / 与基线对比」判为缺陷");
    expect(prompt).toContain("发表目标：未设置（通用学术审稿）");
  });

  it("学位论文：章节组织 / 各章一致性，不套用期刊投稿规则", () => {
    const thesis = snapshot("thesis_from_papers", "master_thesis", null);
    const prompt = buildWholePaperPrompt({ text: "正文", inputMode: "FULL_TEXT", language: "zh", reviewPolicy: thesis });
    expect(prompt).toContain("[cross_chapter_consistency]");
    expect(prompt).toContain("不得套用单篇期刊论文的实验条数");
    expect(prompt).not.toContain("[strong_baselines]");
  });
});

describe("T4 审稿与合规分离 / QualityReport 不宣称达标", () => {
  it("QualityReport：绑定政策只做展示；L4 恒 UNVALIDATED；overall 与无政策时完全相同", () => {
    const gate = { passed: true, reasons: [], rules: [{ rule: "open_critical_major_zero", passed: true, status: "PASS", detail: "critical=0 major=0" }] } as never;
    const pol = snapshot("existing_paper_improvement", "research_article", { scheme: "jcr", tier: "Q1", targetJournalId: CJIG.journalId });
    const withPolicy = buildQualityReport(gate, { reviewPolicy: reviewPolicySummary(pol), generatedAt: NOW.toISOString() });
    const without = buildQualityReport(gate, { generatedAt: NOW.toISOString() });
    expect(withPolicy.overall).toEqual(without.overall);
    expect(withPolicy.layers.L4.status).toBe("UNVALIDATED");
    expect(withPolicy.binding.reviewPolicy).toMatchObject({ policyVersion: "publication-review-policy/1", targetLabel: expect.stringContaining("JCR Q1"), tierFactStatus: "USER_TARGET_UNVERIFIED" });
    expect(withPolicy.layers.L4.items[0]!.detail).toContain("只用于决定审稿关注点，不是本层的通过标准");
    expect(withPolicy.externalValidity.targetJournalValidated).toBe(false);
    expect(without.binding.reviewPolicy).toBeUndefined();
  });
});

function issue(partial: Partial<ReviewIssue>): ReviewIssue {
  return { category: "academic", severity: "major", section: "全文", description: "d", blocking: false, ...partial } as ReviewIssue;
}

function summaryOf(issues: ReviewIssue[]): ReviewSummary {
  const major = issues.filter((entry) => entry.severity === "major").length;
  return {
    generatedAt: NOW.toISOString(), round: 2, reviewedRevision: 3, issues,
    counts: { critical: 0, major, minor: issues.length - major, byCategory: {}, blocking: 0 },
    scores: { academicScore: 70, styleRisk: 20, factVerdicts: null },
    openCritical: 0, openMajor: major, unsupportedCriticalClaims: 0, reportPaths: [],
  } as ReviewSummary;
}

describe("T5 修订终止：AI 整稿建议不自动成为本轮必修项", () => {
  const issues = [
    issue({ origin: "whole_paper_synthesis", description: "缺少与最新强基线的比较", policyDimension: "strong_baselines" }),
    issue({ category: "fact", description: "第 3 节数值与表 2 不一致", section: "sec3.tex" }),
  ];
  it("冻结政策的 run：整稿 AI 建议 skipped（下一轮可选改进），已定位的事实问题照常 planned", () => {
    const plan = buildRevisionPlan({ projectId: "p", sourceRevision: 3, reviewRound: 2, summary: summaryOf(issues), deferWholePaperAdvisory: true });
    const whole = plan.items.find((item) => item.problem.includes("最新强基线"))!;
    const fact = plan.items.find((item) => item.problem.includes("数值与表 2"))!;
    expect(whole.status).toBe("skipped");
    expect(whole.note).toContain("下一轮可选改进清单");
    expect(fact.status).toBe("planned");
  });
  it("旧 run（无快照）：计划与升级前完全一致（整稿 major 仍 planned）", () => {
    const legacy = buildRevisionPlan({ projectId: "p", sourceRevision: 3, reviewRound: 2, summary: summaryOf(issues) });
    expect(legacy.items.find((item) => item.problem.includes("最新强基线"))!.status).toBe("planned");
  });
});

describe("T6 作者决策 + 报告五问", () => {
  it("报告：区分已证实 / 外部意见 / AI 建议 / 需作者数据 / 未核实期刊；REVISION_TASK_COMPLETE ≠ 投稿就绪；不预测录用", () => {
    const pol = snapshot("existing_paper_improvement", "research_article", { scheme: "jcr", tier: "Q3", customJournalName: "Some Unverified Journal" });
    const lines = buildRevisionGoalSummaryLines({
      instructions: [
        { instructionId: "EI-1", source: "reviewer", text: "请补充与 ByteTrack 的对比实验", status: "conflict", statusNote: "需要新实验数据", createdAt: "", updatedAt: "" } as never,
        { instructionId: "EI-2", source: "reviewer", text: "摘要过长", status: "handled", createdAt: "", updatedAt: "" } as never,
      ],
      review: { round: 2, issues: [issue({ origin: "whole_paper_synthesis", description: "建议补充消融实验", suggestedAction: "补充新实验验证模块贡献", policyDimension: "ablation" })], reviewPolicy: reviewPolicySummary(pol)! },
      gate: { revisionTask: { verdict: "PASS", reasons: [] }, publicationReadiness: { verdict: "NOT_READY" }, l1Failures: [] },
      journalAssessment: {
        generatedAt: NOW.toISOString(),
        manuscript: { revision: 3, revisionHash: "h", fidelity: "latex" as never, fileCount: 1 },
        journal: { journalId: null, displayName: "Some Unverified Journal", query: { name: "Some Unverified Journal" }, profileHash: null, rulesVersion: null, verification: { status: "UNVERIFIED", verifiedAt: null, ageDays: null, trusted: false, note: "" }, sourcePages: [], indexing: [], scope: null },
        criteria: [],
      },
      currentRevision: 3,
    });
    const text = lines.join("\n");
    expect(text).toContain("外部意见已闭环（系统派发并逐条核实 / 导入登记已落实）：1/2");
    expect(text).toContain("REVISION_TASK_COMPLETE（本轮修订任务完成）");
    expect(text).toContain("投稿就绪层独立判定：NOT_READY");
    expect(text).toContain("意见 EI-1（conflict）");
    expect(text).toContain("需作者数据 / 新实验（系统不会虚构结果）");
    expect(text).toContain("期刊资料未核实（UNVERIFIED）——不生成投稿规范条目");
    expect(text).toContain("[AI 建议 · 消融与组件贡献]");
    expect(text).toContain("不预测录用");
    expect(text).not.toMatch(/录用概率\s*[:：]|达到.{0,6}(分区|期刊)(水平|要求)(?!。$)/);
  });
});

describe("期刊身份解析", () => {
  it("已核验 profile 的期刊进入快照；与 Journal Assessment 同一 registry", () => {
    const pol = snapshot("existing_paper_improvement", "research_article", { scheme: "none", targetJournalId: CJIG.journalId });
    expect(pol.targetJournal).toMatchObject({ journalId: CJIG.journalId, rulesVersion: CJIG.rulesVersion });
    expect(resolveJournalProfile({ journalId: CJIG.journalId }).profile?.journalId).toBe(CJIG.journalId);
    expect(pol.active).toBe(true);
    expect(pol.emphasis).toBe("generic");
  });
});
