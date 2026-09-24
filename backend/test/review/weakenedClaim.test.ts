/**
 * Weakened Claim Terminal Semantics 测试（M9.8 Phase 4）：
 * - 可接受形态 = 泛指性背景叙述（无数字 / 无比较 / 无性能 / 无具体归因）；
 * - 拒绝形态 = 数字、比较、性能、归因任一命中（放行判定从宽收录 marker）；
 * - M9.7.7 实例回归：MemGPT/CAMEL 泛指句（具体归因）不可作为弱化终态；
 * - 本模块不接 Quality Gate / Reviewer（预注册边界，只有工具与口径）。
 */

import { describe, expect, it } from "vitest";

import { assessWeakenedClaim } from "../../src/review/weakenedClaim.js";

describe("assessWeakenedClaim（M9.8 Phase 4 弱化终态语义）", () => {
  it("可接受：泛指性背景叙述（无数字 / 比较 / 性能 / 归因）", () => {
    const cases = [
      "近年来，基于大语言模型的自主智能体研究快速发展",
      "多智能体协作已成为该领域的重要研究方向",
      "相关研究探索了多种不同类型的框架",
    ];
    for (const claim of cases) {
      const result = assessWeakenedClaim(claim);
      expect(result.acceptable).toBe(true);
      expect(result.category).toBe("general_background");
      expect(result.violatedRules).toEqual([]);
    }
  });

  it("拒绝：数字（数值 / 年份 / 百分比 / 版本号 / 模型名内嵌数字）", () => {
    const cases = [
      "该方法在 2023 年提出", // 年份
      "准确率约为 92%", // 数值 + 百分比
      "GPT-4 展现了工具使用能力", // 模型名内嵌数字（保守拒绝）
      "包含 7 个模块的架构", // 数量
    ];
    for (const claim of cases) {
      const result = assessWeakenedClaim(claim);
      expect(result.acceptable).toBe(false);
      expect(result.violatedRules).toContain("numeric");
    }
  });

  it("拒绝：比较方向 / 程度词（中英）", () => {
    const cases = [
      "该方法优于既有基线",
      "多智能体框架的效率更高",
      "this approach outperforms prior work",
      "the method improves over time",
    ];
    for (const claim of cases) {
      const result = assessWeakenedClaim(claim);
      expect(result.acceptable).toBe(false);
      expect(result.violatedRules).toContain("comparative");
    }
  });

  it("拒绝：性能 / 基准结果语义", () => {
    const cases = [
      "该方法在基准测试中表现稳定",
      "系统的吞吐与延迟指标可查",
      "the framework achieves high accuracy",
    ];
    for (const claim of cases) {
      const result = assessWeakenedClaim(claim);
      expect(result.acceptable).toBe(false);
      expect(result.violatedRules).toContain("performance");
    }
  });

  it("拒绝：对具体系统 / 方法的能力归因（M9.7.7 的 MemGPT/CAMEL 泛指句形态）", () => {
    const cases = [
      "MemGPT 提出了操作系统的记忆管理机制", // M9.7.7 B 臂 r1 实例形态
      "CAMEL 构建了多智能体协作框架",
      "ReAct proposed synergizing reasoning and acting",
    ];
    for (const claim of cases) {
      const result = assessWeakenedClaim(claim);
      expect(result.acceptable).toBe(false);
      expect(result.violatedRules).toContain("attribution");
    }
  });

  it("多规则同时命中时全部列出（numeric + attribution）", () => {
    const result = assessWeakenedClaim("Toolformer 在 2023 年实现了工具使用自学习");
    expect(result.acceptable).toBe(false);
    expect(result.violatedRules).toContain("numeric");
    expect(result.violatedRules).toContain("attribution");
    expect(result.reason).toContain("SUPPORT（补证据）或 REMOVE");
  });
});
