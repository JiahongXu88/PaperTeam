/**
 * M14.9.1 B4：Review Neutrality Harness 的确定性部分（零模型）。
 * - 影子比较器 prompt = 生产 buildReviewPrompt(academic)，无臂标签 / 无 80 分门槛；
 * - 调用计划：固定种子可复现、INVALID_INPUT 臂不进计划、tier 1 先于 tier 2/3；
 * - 比较：合并组内 SD、成对差值与「超出采样噪声」判定；身份 / 格式 finding 初筛不误报普通英文词。
 */
import { describe, expect, it } from "vitest";

import { buildReviewPrompt } from "../../src/agents/ReviewerService.js";
import { buildShadowPrompt, classifyNeutralityIssue, compareNeutrality, planNeutralityCalls, type NeutralityArmInput, type NeutralityCallResult } from "../../src/evaluation/reviewNeutrality.js";

const input = (familyId: string, arm: NeutralityArmInput["arm"], tier: 1 | 2 | 3, equivalence: "VALID" | "INVALID_INPUT" = "VALID"): NeutralityArmInput => ({
  familyId, arm, language: "zh", text: `# ${familyId} ${arm}\n正文 700 → 497`, equivalence, conversionLoss: false, tier,
});

describe("影子比较器 prompt", () => {
  it("与生产 academic prompt 逐字节相同；不含臂标签、门槛或历史分数", () => {
    const arm = input("mot", "structured_blind_md", 1);
    const prompt = buildShadowPrompt(arm, "core_journal");
    expect(prompt).toBe(buildReviewPrompt({ projectId: "shadow", mode: "academic", manuscriptDigest: arm.text.replace("structured_blind_md", "structured_blind_md"), evidence: [], targetProfile: "core_journal", language: "zh" }));
    const header = prompt.slice(0, prompt.indexOf("===== 论文稿件"));
    expect(header).not.toMatch(/80\s*分|门槛|74|naive|structured|raw|arm/i);
  });
});

describe("调用计划", () => {
  const inputs = [input("a", "raw", 1), input("a", "structured_blind_md", 1), input("a", "naive_text", 1, "INVALID_INPUT"), input("a", "format_only_md", 2), input("b", "identity_swap", 3)];
  it("固定种子可复现；INVALID_INPUT 臂不进入计划；tier 1 的全部重复先于 tier 2 / 3", () => {
    const options = { reps: 2, seed: 7, targetProfile: "core_journal", outputReserveTokens: 1000 };
    const plan = planNeutralityCalls(inputs, options);
    expect(planNeutralityCalls(inputs, options)).toEqual(plan);
    expect(plan.some((call) => call.arm === "naive_text")).toBe(false);
    expect(plan.map((call) => call.tier)).toEqual([1, 1, 1, 1, 2, 2, 3, 3]);
    expect(new Set(plan.filter((call) => call.tier === 1).map((call) => call.callId)).size).toBe(4);
    expect(plan.every((call) => call.reservedTokens === call.estimatedPromptTokens + 1000)).toBe(true);
  });
});

describe("比较与 finding 初筛", () => {
  const result = (familyId: string, arm: NeutralityCallResult["arm"], rep: number, overallScore: number, majors = 0): NeutralityCallResult => ({
    callId: `${familyId}.${arm}.r${rep}`, familyId, arm, rep, status: "completed", overallScore, scores: { 问题定义: overallScore },
    issues: Array.from({ length: majors }, () => ({ category: "academic", severity: "major", section: "s", description: "d", blocking: false })),
  });
  it("合并组内 SD 与成对差值；|Δ| ≤ 2·SE 不判为超出噪声", () => {
    const comparison = compareNeutrality([
      result("a", "raw", 1, 64, 2), result("a", "raw", 2, 67, 2), result("a", "structured_blind_md", 1, 66), result("a", "structured_blind_md", 2, 73),
      result("a", "refused" as never, 1, 0),
    ].filter((row) => row.arm !== ("refused" as never)));
    expect(comparison.pooledWithinCellSd).toBeCloseTo(Math.sqrt((4.5 + 24.5) / 2), 1);
    const delta = comparison.pairedDeltas.find((entry) => entry.contrast === "structured_blind_md − raw")!;
    expect(delta.overallDelta).toBe(4);
    expect(delta.majorDelta).toBe(-2);
    expect(delta.exceedsNoise).toBe(false);
  });
  it("身份 / 格式初筛：命中作者信息红字占位；不把 'the words' / 'acknowledged' 当成 Word 模板 / 致谢", () => {
    const issue = (description: string) => ({ category: "build" as const, severity: "major" as const, section: "题头", description, blocking: false });
    expect(classifyNeutralityIssue(issue("题头保留了红色「待作者确认」说明，署名单位与通信邮箱域名不一致"))).toMatchObject({ identity: true });
    expect(classifyNeutralityIssue(issue("The text uses these words loosely, as acknowledged in BDD100K results"))).toMatchObject({ identity: false, format: false });
    expect(classifyNeutralityIssue(issue("稿件采用 LaTeX 单栏，未使用 Word 模板"))).toMatchObject({ format: true });
  });
});
