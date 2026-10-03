/**
 * Survey Review Profile 测试（M11.2 §二十二-4）。
 *
 * 覆盖：survey rubric 加载（academic 维度切换 + 综述检查项）、fact 模式的综述
 * 语境行、既有 review 流程兼容（无 profile = 旧 rubric 逐字不变）、
 * surveyDigest 块注入。
 */

import { describe, expect, it } from "vitest";

import { buildReviewPrompt, parseModeReview } from "../../src/agents/ReviewerService.js";

const BASE = {
  projectId: "p1",
  manuscriptDigest: "===== 论文稿件 =====\n[main.tex] 摘要……",
  evidence: [],
};

describe("buildReviewPrompt survey profile", () => {
  it("survey：academic 模式换综述 rubric（覆盖 / 分类 / 均衡 / 比较公正 / listing / 语义漂移）", () => {
    const prompt = buildReviewPrompt({
      ...BASE,
      mode: "academic",
      reviewProfile: "survey",
      targetProfile: "中等档期刊",
    });
    expect(prompt).toContain("Survey Review Profile");
    expect(prompt).toContain("覆盖完整性");
    expect(prompt).toContain("分类体系（taxonomy）质量");
    expect(prompt).toContain("seminal（奠基性）/ representative（代表性）/ recent（近期）");
    expect(prompt).toContain("比较公正性");
    expect(prompt).toContain("literature listing");
    expect(prompt).toContain("语义漂移");
    expect(prompt).toContain("scores: {覆盖完整性: 0-100, 分类与组织: 0-100, 文献均衡性: 0-100, 比较与论证: 0-100, 引用支撑: 0-100, 写作质量: 0-100}");
    expect(prompt).toContain("目标档次：中等档期刊");
    // 原创论文口径不得出现
    expect(prompt).not.toContain("实验充分性: 0-100");
  });

  it("survey：fact 模式追加综述语境行（弱措辞口径 / speculative 升级判 UNSUPPORTED）", () => {
    const prompt = buildReviewPrompt({ ...BASE, mode: "fact", reviewProfile: "survey" });
    expect(prompt).toContain("综述语境");
    expect(prompt).toContain("speculative 内容出现在非展望章节或以确定语气呈现时，报 UNSUPPORTED");
  });

  it("survey：surveyDigest 注入确定性指标块", () => {
    const prompt = buildReviewPrompt({
      ...BASE,
      mode: "academic",
      reviewProfile: "survey",
      surveyDigest: "- 文献覆盖：5/5（100%）",
    });
    expect(prompt).toContain("===== 综述确定性指标（机器可算信号；评审时对照使用）=====");
    expect(prompt).toContain("- 文献覆盖：5/5（100%）");
  });

  it("兼容：无 profile 的 academic prompt 与旧版同口径（原创论文维度）", () => {
    const prompt = buildReviewPrompt({ ...BASE, mode: "academic" });
    expect(prompt).toContain("问题定义、方法合理性、实验充分性、论证逻辑、写作质量");
    expect(prompt).not.toContain("Survey Review Profile");
    expect(prompt).not.toContain("综述确定性指标");
    const factPrompt = buildReviewPrompt({ ...BASE, mode: "fact" });
    expect(factPrompt).not.toContain("综述语境");
  });

  it("parseModeReview：综述维度评分合法解析（academicScore = 均值）", () => {
    const parsed = parseModeReview("academic", {
      summary: "综述整体良好",
      scores: { 覆盖完整性: 85, 分类与组织: 82, 文献均衡性: 78, 比较与论证: 88, 引用支撑: 90, 写作质量: 86 },
      issues: [],
    });
    expect(parsed.scores).toMatchObject({ 覆盖完整性: 85, 引用支撑: 90 });
    expect(parsed.overallScore).toBe(Math.round((85 + 82 + 78 + 88 + 90 + 86) / 6));
  });
});
