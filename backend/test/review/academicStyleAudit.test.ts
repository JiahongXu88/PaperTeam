/**
 * M17.1 学术风格 / 过度防御性表达：确定性内核的 fixture 测试。
 *
 * 全部中文句子为**人工构造**（说明用途，数字不是任何真实实验结果）。每类正例都配一条保护原句的负例——
 * 测试的目标不是「删得越多越好」，而是：纯措辞问题可改，必要限定 / 负结果 / 事实永远不被风格修订改动。
 */

import { describe, expect, it } from "vitest";

import {
  STYLE_AUDIT_DISCLAIMER,
  buildUnitStyleAuditPrompt,
  checkStyleRewrite,
  classifyStyleFinding,
  isChineseText,
  locateStyleQuote,
  parseStyleRewriteCheckOutput,
  parseUnitStyleAuditOutput,
  scanStyleCandidates,
  styleFindingId,
  summarizeStyleAuditCoverage,
  type RawStyleFinding,
  type StyleAuditUnitRecord,
} from "../../src/review/academicStyleAudit.js";
import { checkStyleInvariants } from "../../src/review/styleInvariants.js";

const ctx = (unitText: string) => ({
  unitId: "sections/intro.tex::s1", file: "sections/intro.tex", logicalSection: "s1", heading: "引言",
  unitText, round: 1, unitFingerprint: "fp",
});
const raw = (partial: Partial<RawStyleFinding> & Pick<RawStyleFinding, "quote" | "styleCategory">): RawStyleFinding => ({
  reason: "构造", necessity: "UNNECESSARY", constraints: [], action: "MINIMAL_REWRITE", ...partial,
});

describe("checkStyleRewrite：允许的纯措辞修订（不因限定词数量变化被一刀切拦截）", () => {
  it("#1 无意义自谦整句删除（人工构造）", () => {
    const before = "本文仅是一次粗浅的尝试，难免存在诸多不足，敬请批评指正。";
    expect(checkStyleRewrite(before, "", "repeated_modesty_apology").ok).toBe(true);
    // 对照：既有 style_polish 守卫在结构上禁止这类修订（「仅」「不足」计数变化即阻断）——M17.1 不放宽它
    expect(checkStyleInvariants(`${before}其余正文。`, "其余正文。").ok).toBe(false);
  });

  it("#2 对冲堆叠只删冗余、保留一个与证据对应的限定（#9：限定词数量减少本身不是拦截理由）", () => {
    const before = "实验结果或许在一定程度上可能表明，引入时序模块有助于降低 ID 切换。";
    const after = "实验结果表明，引入时序模块可能有助于降低 ID 切换。";
    const check = checkStyleRewrite(before, after, "uninformative_hedge");
    expect(check.violations).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("#2 负例：把对冲删光 = 把不确定结论改成确定 → 拦截", () => {
    const before = "实验结果或许在一定程度上可能表明，引入时序模块有助于降低 ID 切换。";
    const check = checkStyleRewrite(before, "实验结果表明，引入时序模块有助于降低 ID 切换。", "uninformative_hedge");
    expect(check.ok).toBe(false);
    expect(check.violations.map((v) => v.rule)).toContain("hedge_removed");
  });

  it("情绪化修饰可去、负结果事实保留（人工构造）", () => {
    const before = "遗憾的是，本文方法在 C 数据集上的 MOTA 低于基线 0.8。";
    expect(checkStyleRewrite(before, "本文方法在 C 数据集上的 MOTA 低于基线 0.8。", "repeated_modesty_apology").ok).toBe(true);
  });

  it("预先免责样板可删：「需要指出的是…当然这并不影响」（人工构造）", () => {
    const before = "需要指出的是，本文的方法也存在一定的局限性，当然这并不影响其整体有效性。";
    // 「局限」是实质限定词：删除整句会丢失它 → 拦截（系统不得自造或删去局限内容，交作者）
    expect(checkStyleRewrite(before, "", "repeated_modesty_apology").ok).toBe(false);
  });
});

describe("checkStyleRewrite：必须拦截的越权（负例）", () => {
  it("#3 「我们不研究 X」改为正向范围时不得丢失边界（否定减少 → 拦截）", () => {
    const before = "我们不研究夜间场景下的跟踪性能。";
    const check = checkStyleRewrite(before, "我们研究白天场景下的跟踪性能。", "unnatural_wording");
    expect(check.ok).toBe(false);
  });

  it("#4 小样本 / 单数据集 / 特定协议是必要限制：删除 → limitation_removed", () => {
    for (const [before, after] of [
      ["该结论仅在单一数据集上得到验证，样本量较小。", "该结论得到了验证。"],
      ["由于仅在 MOT17 测试协议下评估，结论能否推广尚不确定。", "结论具有推广性。"],
    ] as const) {
      const check = checkStyleRewrite(before, after, "uninformative_hedge");
      expect(check.ok, before).toBe(false);
    }
  });

  it("#5 未做统计检验时不得添加「统计显著」", () => {
    const before = "本文方法的 HOTA 提升了 1.2（单次运行，未做显著性检验）。";
    const check = checkStyleRewrite(before, "本文方法的 HOTA 显著提升了 1.2。", "unnatural_wording");
    expect(check.ok).toBe(false);
    expect(check.violations.map((v) => v.rule)).toEqual(expect.arrayContaining(["strong_claim_added", "limitation_removed"]));
  });

  it("#6 负实验结果、失败案例、资源成本不可删", () => {
    expect(checkStyleRewrite("在 C 数据集上，本文方法的 MOTA 低于基线 0.8。", "", "empty_summary_transition").ok).toBe(false);
    expect(checkStyleRewrite("该方法在密集遮挡场景中失败，且推理开销增加约一倍。", "该方法表现稳定。", "unnatural_wording").ok).toBe(false);
  });

  it("#7 无证据的「首次 / SOTA / 普遍适用 / 全面领先」不得新增", () => {
    for (const after of ["本文首次将遮挡推理引入车辆跟踪。", "本文方法达到 SOTA 水平。", "该方法普遍适用于各种场景。", "该方法全面领先现有方法。"]) {
      expect(checkStyleRewrite("本文将遮挡推理引入车辆跟踪。", after, "unnatural_wording").ok, after).toBe(false);
    }
  });

  it("#8 相关变因果、部分结果变全体结论 → 拦截", () => {
    const corr = "观察到车流密度与跟踪误差呈正相关，这或许说明密度可能与误差上升有关。";
    expect(checkStyleRewrite(corr, "车流密度导致跟踪误差上升。", "uninformative_hedge").ok).toBe(false);
    const part = "在两个子集上，本文方法的 IDF1 有所提升。";
    expect(checkStyleRewrite(part, "在所有子集上，本文方法的 IDF1 有所提升。", "unnatural_wording").ok).toBe(false);
  });

  it("#10 数字 / 引用 / LaTeX 命令 / 比较方向任一变化都拦截（中英混合文本）", () => {
    const before = "如表~\\ref{tab:main} 所示，本文方法在 MOT17 上的 HOTA 为 63.1，高于 ByteTrack~\\cite{zhang2022bytetrack} 约 0.9。";
    expect(checkStyleRewrite(before, before.replace("63.1", "64.1"), "unnatural_wording").violations.map((v) => v.rule)).toContain("numbers");
    expect(checkStyleRewrite(before, before.replace("~\\cite{zhang2022bytetrack}", ""), "unnatural_wording").violations.map((v) => v.rule)).toContain("citations");
    expect(checkStyleRewrite(before, before.replace("~\\ref{tab:main}", "表中"), "unnatural_wording").violations.map((v) => v.rule)).toContain("latex_structure");
    expect(checkStyleRewrite(before, before.replace("高于", "低于"), "unnatural_wording").violations.map((v) => v.rule)).toContain("direction_changed");
  });

  it("改写不得扩写论证 / 新增句子", () => {
    const before = "综上所述，本文方法有效。";
    const check = checkStyleRewrite(before, "本文方法有效。该方法还显著降低了误检率，并具有良好的工程价值。", "empty_summary_transition");
    expect(check.ok).toBe(false);
  });

  it("只有样板类允许整段删除；对冲 / 措辞类删除整句 → deletion_not_allowed", () => {
    expect(checkStyleRewrite("这一结果可能在一定程度上说明模块有效。", "", "uninformative_hedge").violations.map((v) => v.rule)).toContain("deletion_not_allowed");
  });
});

describe("classifyStyleFinding：机器分级（模型建议只是输入）", () => {
  const unit = "本文仅是一次粗浅的尝试，难免存在诸多不足，敬请批评指正。由于未在夜间场景数据上验证，结论能否推广到低照度条件尚不确定。";

  it("必要限定 / 负结果恒 KEEP，即使模型给 MINIMAL_REWRITE + UNNECESSARY", () => {
    const finding = classifyStyleFinding(raw({ quote: "由于未在夜间场景数据上验证，结论能否推广到低照度条件尚不确定。", styleCategory: "required_limitation", rewrite: "结论可以推广。" }), ctx(unit));
    expect(finding.disposition).toBe("KEEP");
    expect(finding.revisionStatus).toBe("KEPT");
  });

  it("贡献弱化 / overclaim 风险恒交作者（系统不自行加强或弱化）", () => {
    expect(classifyStyleFinding(raw({ quote: "本文仅是一次粗浅的尝试，难免存在诸多不足", styleCategory: "understated_contribution", rewrite: "" }), ctx(unit)).disposition).toBe("AUTHOR_DECISION");
    expect(classifyStyleFinding(raw({ quote: "本文仅是一次粗浅的尝试，难免存在诸多不足", styleCategory: "overclaim_risk" }), ctx(unit)).disposition).toBe("AUTHOR_DECISION");
  });

  it("necessity=UNCERTAIN 或无改写文本 → AUTHOR_DECISION；预检失败 → AUTHOR_DECISION（附违规规则）", () => {
    const q = "本文仅是一次粗浅的尝试，难免存在诸多不足，敬请批评指正。";
    expect(classifyStyleFinding(raw({ quote: q, styleCategory: "repeated_modesty_apology", necessity: "UNCERTAIN", rewrite: "" }), ctx(unit)).disposition).toBe("AUTHOR_DECISION");
    expect(classifyStyleFinding(raw({ quote: q, styleCategory: "repeated_modesty_apology" }), ctx(unit)).disposition).toBe("AUTHOR_DECISION");
    const bad = classifyStyleFinding(raw({ quote: q, styleCategory: "repeated_modesty_apology", rewrite: "本文首次提出了该方法。" }), ctx(unit));
    expect(bad.disposition).toBe("AUTHOR_DECISION");
    expect(bad.dispositionReason).toMatch(/strong_claim_added/);
  });

  it("纯样板 + 合规改写 → AUTO_REWRITE_ELIGIBLE；id 稳定（同 file+原句+类别）", () => {
    const q = "本文仅是一次粗浅的尝试，难免存在诸多不足，敬请批评指正。";
    const finding = classifyStyleFinding(raw({ quote: q, styleCategory: "repeated_modesty_apology", rewrite: "" }), ctx(unit));
    expect(finding.disposition).toBe("AUTO_REWRITE_ELIGIBLE");
    expect(finding.id).toBe(styleFindingId("sections/intro.tex", ` ${q} `, "repeated_modesty_apology"));
  });

  it("#10 同一原句在单元中出现多次 → 锚点不唯一，不自动改写", () => {
    const q = "综上所述，本文方法有效。";
    const finding = classifyStyleFinding(raw({ quote: q, styleCategory: "empty_summary_transition", rewrite: "本文方法有效。" }), ctx(`${q}其他内容。${q}`));
    expect(finding.disposition).toBe("AUTHOR_DECISION");
    expect(finding.dispositionReason).toMatch(/锚点不唯一/);
  });
});

describe("parseUnitStyleAuditOutput：已审无问题 ≠ 未审查（#11）", () => {
  const unit = "本文仅是一次粗浅的尝试，难免存在诸多不足，敬请批评指正。实验在两个公开数据集上进行。";

  it("空数组 = 已审查、无问题", () => {
    expect(parseUnitStyleAuditOutput({ styleFindings: [] }, unit, "u").findings).toEqual([]);
  });

  it("缺 styleFindings / 非数组 = 结构违约（抛出，由调用方重试后记 FAILED）", () => {
    expect(() => parseUnitStyleAuditOutput({ summary: "ok" }, unit, "u")).toThrow(/styleFindings/);
    expect(() => parseUnitStyleAuditOutput({ styleFindings: "none" }, unit, "u")).toThrow(/不是数组/);
  });

  it("引文不在单元原文 / 枚举非法 / 过短 → fail-closed 丢弃并记录原因，不整单元作废", () => {
    const parsed = parseUnitStyleAuditOutput({
      styleFindings: [
        { quote: "这句话并不在原文中出现过", styleCategory: "mechanical_template", necessity: "UNNECESSARY", action: "KEEP" },
        { quote: "本文仅是一次粗浅的尝试", styleCategory: "ai_trace", necessity: "UNNECESSARY", action: "KEEP" },
        { quote: "本文", styleCategory: "mechanical_template", necessity: "UNNECESSARY", action: "KEEP" },
        { quote: "本文仅是一次粗浅的尝试，难免存在诸多不足", styleCategory: "repeated_modesty_apology", necessity: "UNNECESSARY", action: "MINIMAL_REWRITE", rewrite: "" },
      ],
    }, unit, "u");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.unanchored.map((entry) => entry.reason.split("（")[0])).toEqual(["QUOTE_NOT_IN_UNIT", "INVALID_ENUM", "QUOTE_TOO_SHORT"]);
  });

  it("#10 跨行引文（LaTeX 源文句中换行）仍可定位", () => {
    const text = "本文仅是一次粗浅的\n尝试，难免存在诸多不足。";
    expect(locateStyleQuote(text, "本文仅是一次粗浅的尝试，难免存在诸多不足。").count).toBe(1);
  });
});

describe("覆盖状态（#11 / #14）", () => {
  const unit = (status: StyleAuditUnitRecord["status"], chars = 100): StyleAuditUnitRecord => ({
    unitId: `u-${Math.random()}`, file: "f.tex", heading: "h", chars, unitFingerprint: "x", status, attempts: 1, findings: 0, candidates: 0,
  });
  it("全部完成 = COMPLETE；部分失败 / 预算跳过 = PARTIAL；全部失败 = FAILED；只有不适用 = NOT_APPLICABLE；开关关闭 = DISABLED", () => {
    expect(summarizeStyleAuditCoverage([unit("COMPLETE"), unit("REUSED"), unit("NOT_APPLICABLE")]).state).toBe("COMPLETE");
    expect(summarizeStyleAuditCoverage([unit("COMPLETE"), unit("FAILED")]).state).toBe("PARTIAL");
    expect(summarizeStyleAuditCoverage([unit("COMPLETE"), unit("SKIPPED_BUDGET")]).state).toBe("PARTIAL");
    expect(summarizeStyleAuditCoverage([unit("FAILED"), unit("FAILED")]).state).toBe("FAILED");
    expect(summarizeStyleAuditCoverage([unit("NOT_APPLICABLE")]).state).toBe("NOT_APPLICABLE");
    expect(summarizeStyleAuditCoverage([unit("SKIPPED_BUDGET")], "off").state).toBe("DISABLED");
    const partial = summarizeStyleAuditCoverage([unit("COMPLETE", 300), unit("FAILED", 100)]);
    expect([partial.eligibleChars, partial.reviewedChars]).toEqual([400, 300]);
  });
});

describe("候选扫描与 prompt（只是提示，不是判定）", () => {
  it("扫描命中样板 / 对冲堆叠 / 套话；命中必要限定时标 limitationSignal", () => {
    const candidates = scanStyleCandidates("本文仅是一次粗浅的尝试，敬请批评指正。实验结果或许在一定程度上可能表明模块有效。该结论仅在单一数据集上验证，或许可能不具普遍性。具有重要的理论意义和现实价值。");
    const signals = candidates.map((c) => c.signals);
    expect(signals[0]).toContain("boilerplate");
    expect(signals[1]).toContain("hedge_stacking×3");
    expect(signals.flat()).toContain("template");
    expect(candidates.find((c) => c.sentence.includes("单一数据集"))?.limitationSignal).toBe(true);
  });

  it("没有命中词表的单元仍要求全文审查（prompt 明示不只看候选），且不要求 AI 率", () => {
    const prompt = buildUnitStyleAuditPrompt({ unit: { file: "a.tex", heading: "结论", unitIndex: 1, unitCount: 1, text: "正文。" }, candidates: [] });
    expect(prompt).toContain("**全文**");
    expect(prompt).toContain("不要输出任何「AI 率 / AI 概率」");
    expect(prompt).toContain("styleFindings: []");
    expect(STYLE_AUDIT_DISCLAIMER).toMatch(/不是对作者身份或 AI 生成来源的鉴定/);
  });

  it("中文判定：英文 / 纯命令单元不适用", () => {
    expect(isChineseText("本文提出一种车辆跟踪方法。")).toBe(true);
    expect(isChineseText("We propose a tracker for vehicles in traffic scenes.")).toBe(false);
    expect(isChineseText("\\section{引}\\label{sec:a}")).toBe(false);
  });

  it("语义复核解析：只接受已知 id 与合法 verdict", () => {
    const verdicts = parseStyleRewriteCheckOutput({ checks: [{ id: "a", verdict: "EQUIVALENT" }, { id: "b", verdict: "MAYBE" }, { id: "z", verdict: "CHANGED" }] }, new Set(["a", "b"]));
    expect([...verdicts.keys()]).toEqual(["a"]);
    expect(() => parseStyleRewriteCheckOutput({}, new Set())).toThrow(/checks/);
  });
});
