/**
 * Researcher 调研 prompt 接线测试（M7.1a P-A）：
 * - 检索优先：要求 1 引导 search_papers / search_web / lookup_paper，
 *   简单问题可直接回答（不强制检索），禁止凭记忆断言文献；
 * - save_candidates 指引（≤20 条、按相关性遴选、pending_review 语义）；
 * - literaturePlan 语义 = 检索后残差；
 * - Evidence 锚定路径原句一字不动（M9.4 要求 4：retrieve_library / get_chunk /
 *   propose_evidence / quote 纪律 + 失败纪律 + 无机械数量指标）；
 * - partial / 时延提示，避免模型因部分源失败反复重试。
 */

import { describe, expect, it } from "vitest";

import { buildResearchPrompt } from "../../src/agents/ResearcherService.js";
import type { ProjectMetadata } from "../../src/project/ProjectStore.js";

const PROJECT = {
  title: "多目标跟踪中的遮挡恢复",
  researchIdea: "分析最近三年的多目标跟踪方法，找出遮挡场景下的身份保持缺口",
  researchField: "计算机视觉",
} as ProjectMetadata;

const DIGEST = ["项目文献库（1 项）：", "- [S001] ByteTrack；年份：2022"].join("\n");

describe("buildResearchPrompt M7.1a：Researcher 检索工具接线", () => {
  const prompt = buildResearchPrompt(PROJECT, DIGEST);

  it("要求 1 检索优先：引导三个检索/核验工具 + 简单问题不强制检索 + 禁止凭记忆断言", () => {
    expect(prompt).toContain("search_papers");
    expect(prompt).toContain("search_web");
    expect(prompt).toContain("lookup_paper");
    expect(prompt).toContain("简单问题");
    expect(prompt).toContain("可直接回答");
    expect(prompt).toContain("禁止凭记忆断言论文的存在性、年份或 venue");
  });

  it("包含 partial / 时延提示（部分检索源失败是常态，不重试）", () => {
    expect(prompt).toContain("partial");
    expect(prompt).toContain("不要因 partial 重试");
  });

  it("包含 save_candidates 指引：≤20 条、按相关性遴选、pending_review 语义", () => {
    expect(prompt).toContain("save_candidates");
    expect(prompt).toContain("不超过 20 条");
    expect(prompt).toContain("pending_review");
    expect(prompt).toContain("用户审核转正");
  });

  it("literaturePlan 语义 = 检索后残差（不再承担「调研前的检索计划」）", () => {
    expect(prompt).toContain("残差");
    expect(prompt).toContain("已检索覆盖的方向不要写进 literaturePlan");
  });

  it("Evidence 锚定路径原句一字不动（M9.4：retrieve_library / get_chunk / propose_evidence / quote 纪律）", () => {
    expect(prompt).toContain(
      "4. 锚定证据路径：文献库摘要中标注「全文：已入库」的条目，用 retrieve_library 按主题检索原文段落（结果带 CHUNK 标识），用 get_chunk 回取逐字原文。对调研结论中需要文献支撑的关键论断，当文献库有可检索全文时，优先提出锚定证据：调用 propose_evidence（claim + sourceId + chunkId + 从 chunk 原文逐字复制的 quote），或在最终 evidence 条目中附上 sourceId、chunkId 与逐字 quote（quote 不要改写、不要凭记忆生成）——这类证据会进入核验管道成为已核验证据。已通过 propose_evidence 工具提交过的证据不要在 evidence 字段里重复。是否提出证据由你的研究判断决定，不设数量指标；但项目已有可检索全文时，关键论断应优先尝试锚定，而不是只依赖摘要或检索元数据。检索后仍找不到足够支撑材料时，如实记为证据不足（写入 researchGaps / literaturePlan），绝不编造 quote 或锚定到不相关的段落。无法锚定到文献库 chunk 的证据保持原格式（只记为未核验线索）。",
    );
    expect(prompt).toContain(
      "evidence 只包含你能给出明确来源（文献库条目或确凿的公开文献）的事实；来源不充分的不要写入 evidence。",
    );
  });

  it("M9.4 锚定纪律要点：失败纪律（证据不足如实记录）+ 无机械数量指标", () => {
    expect(prompt).toContain("如实记为证据不足（写入 researchGaps / literaturePlan）");
    expect(prompt).toContain("绝不编造 quote 或锚定到不相关的段落");
    expect(prompt).toContain("不设数量指标");
    expect(prompt).toContain("propose_evidence");
    expect(prompt).toContain("不要凭记忆生成");
  });

  it("输出契约零变化：JSON 字段清单完整（schema 不因接线改动）", () => {
    for (const field of [
      '"domainOverview"',
      '"relatedWorkDirections"',
      '"researchGaps"',
      '"potentialContributions"',
      '"researchQuestions"',
      '"literaturePlan"',
      '"evidence"',
      '"bibliography"',
    ]) {
      expect(prompt).toContain(field);
    }
  });

  it("用户补充说明仍然拼接在末尾（HITL 反馈通道不变）", () => {
    const withExtra = buildResearchPrompt(PROJECT, DIGEST, "重点看相机移动场景");
    expect(withExtra).toContain("===== 用户补充说明 =====");
    expect(withExtra).toContain("重点看相机移动场景");
  });
});

describe("buildResearchPrompt M8.1：ResearchPlan 一等产物接线", () => {
  const prompt = buildResearchPrompt(PROJECT, DIGEST);

  it("输出 schema 含 plan 字段：questions + queries（query/kind/rationale/expectedCoverage）", () => {
    expect(prompt).toContain('"plan"');
    expect(prompt).toContain('"questions"');
    expect(prompt).toContain('"queries"');
    expect(prompt).toContain('"rationale"');
    expect(prompt).toContain('"expectedCoverage"');
    expect(prompt).toContain('"kind"');
  });

  it("明确区分两个概念：plan 用于指导检索（先制定），report 用于总结研究结果（检索后）", () => {
    expect(prompt).toContain("plan 是检索计划（ResearchPlan）");
    expect(prompt).toContain("调研报告（ResearchReport）");
    expect(prompt).toContain("在检索前制定");
    expect(prompt).toContain("在检索完成后综合研究结果得出");
    expect(prompt).toContain("两者不要混淆");
  });

  it("plan.queries 语义锚定：写打算执行的检索及其理由，不是调研结论", () => {
    expect(prompt).toContain("plan.queries 写的是你实际打算（或已经）执行的检索及其理由，不是调研结论");
  });

  it("plan.questions 与 report.researchQuestions 职责不同（指导检索 vs 调研后结论）", () => {
    expect(prompt).toContain("前者指导检索，后者是调研后的结论问题");
  });
});
