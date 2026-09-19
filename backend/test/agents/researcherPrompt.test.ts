/**
 * Researcher 调研 prompt 接线测试（M7.1a P-A）：
 * - 检索优先：要求 1 引导 search_papers / search_web / lookup_paper，
 *   简单问题可直接回答（不强制检索），禁止凭记忆断言文献；
 * - save_candidates 指引（≤20 条、按相关性遴选、pending_review 语义）；
 * - literaturePlan 语义 = 检索后残差；
 * - Evidence 红线原句一字不动（要求 3 的 retrieve_library/get_chunk/quote 规则）；
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

  it("Evidence 红线原句一字不动（retrieve_library / get_chunk / quote 规则）", () => {
    expect(prompt).toContain(
      "优先用 retrieve_library 检索项目文献库、get_chunk 核对原文；来自文献库的证据请在 evidence 条目中附上 sourceId、chunkId 与从原文逐字复制的 quote（不要改写）——这类证据会进入核验管道成为已核验证据。已通过 propose_evidence 工具提交过的证据不要在 evidence 字段里重复。无法锚定到文献库 chunk 的证据保持原格式（只记为未核验线索）。",
    );
    expect(prompt).toContain(
      "evidence 只包含你能给出明确来源（文献库条目或确凿的公开文献）的事实；来源不充分的不要写入 evidence。",
    );
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
