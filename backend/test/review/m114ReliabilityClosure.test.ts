/**
 * M11.4 Reliability Closure — Attempt 8 失败形态的确定性回归（2026-10-07）。
 *
 * 每个用例对应 Attempt 8 真实 clean run 的一个实证失败形态：
 * - 8c R1/R3：机器 fallback 计划条目缺 actionType → 意见 plain unresolved
 * - 8c R2：AUTHOR_DECISION_REQUIRED 标记被 not_applicable 聚合覆盖
 * - 8b：patch 候选校验不覆盖 removedFacts / placeholderRegressions 的输入形态
 * - 8b：removed 类违规无确定性恢复路径
 * - 8c 2 条 blocking finding：claim↔finding 词面归因结构性失配（元描述 /
 *   数值指纹）与 creator-side claimIndex lineage
 */
import { describe, expect, it } from "vitest";

import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";
import { WriterService, reclassifyAuthorInputActions } from "../../src/writer/WriterService.js";
import { applyDispatchOutcome, applyPatchBackedOutcomeOverrides, type ExternalInstruction, type ExternalOutcomeReport } from "../../src/review/externalInstructions.js";
import { planFactRestore, applyFactRestore } from "../../src/quality/factRestore.js";
import { verifyNoopCoverage } from "../../src/review/revisionScope.js";
import { evaluateFactPreservation } from "../../src/quality/factPreservation.js";
import { computeClaimGapAudit, resolveClaimIndexLinks, tagIssueRootCauses } from "../../src/review/claimGapAudit.js";
import { claimFingerprint } from "../../src/review/claimGrounding.js";
import type { ClaimGroundingEntry } from "../../src/review/claimGrounding.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";

// ---------------------------------------------------------------------------
// F1：未链接意见的机器 fallback 条目必须携带 actionType（8c R1/R3 实证）
// ---------------------------------------------------------------------------

class FakeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: string[] = [];
  constructor(private readonly output: string) {}
  async runAgent(input: { task: string }): Promise<AgentTask> {
    this.calls.push(input.task);
    const now = new Date().toISOString();
    return {
      taskId: "run-w1", agentId: "writer", status: "completed",
      createdAt: now, updatedAt: now, output: this.output, events: [],
    } as unknown as AgentTask;
  }
  healthCheck(): Promise<never> { throw new Error("not needed"); }
  startAgent(): Promise<never> { throw new Error("not needed"); }
  getTask(): Promise<never> { throw new Error("not needed"); }
  close(): Promise<void> { return Promise.resolve(); }
}

describe("M11.4 Reliability Closure：fallback 计划条目 actionType", () => {
  it("模型未链接意见 → 机器兜底条目携带 actionType=author_decision_required（合法闭环前提）", async () => {
    // 模型只链接了 C1（Editor），R1/R2 未覆盖 → 兜底条目（8c 实证形态）
    const runtime = new FakeRuntime(JSON.stringify({ plan: [{
      section: "main.tex", action: "凝练创新性表述", rationale: "Editor", priority: "high",
      commentRefs: ["C1"],
    }] }));
    const writer = new WriterService({ runtime, agentId: "writer" });
    const plan = await writer.planImprovement({
      projectId: "p-8c", issues: [], analysisDigest: "", feasibilityLevel: "MEDIUM", sectionFiles: [],
      validInstructionIds: ["x-editor", "x-r1", "x-r2"], validEvidenceIds: [],
      externalInstructions: [
        { instructionId: "x-editor", text: "凝练创新性" },
        { instructionId: "x-r1", text: "补充近年文献且参考文献总数不少于 20 篇" },
        { instructionId: "x-r2", text: "补充车载边缘设备部署实验" },
      ],
      commentAliases: [
        { ref: "C1", canonicalId: "x-editor", text: "凝练创新性" },
        { ref: "C2", canonicalId: "x-r1", text: "补充近年文献且参考文献总数不少于 20 篇" },
        { ref: "C3", canonicalId: "x-r2", text: "补充车载边缘设备部署实验" },
      ],
      evidenceAliases: [],
    });
    const fallback = plan.items.filter((item) => item.instructionId !== "x-editor");
    expect(fallback).toHaveLength(2);
    for (const item of fallback) {
      expect(item.actionType).toBe("author_decision_required");
    }
  });

  it("模型自有条目缺 actionType 时仍缺省 modify（既有语义不变）", async () => {
    const runtime = new FakeRuntime(JSON.stringify({ plan: [{
      section: "main.tex", action: "修改引言", rationale: "r", priority: "high", commentRefs: ["C1"],
    }] }));
    const writer = new WriterService({ runtime, agentId: "writer" });
    const plan = await writer.planImprovement({
      projectId: "p-x", issues: [], analysisDigest: "", feasibilityLevel: "MEDIUM", sectionFiles: [],
      validInstructionIds: ["c1"], validEvidenceIds: [],
      externalInstructions: [{ instructionId: "c1", text: "改引言" }],
      commentAliases: [{ ref: "C1", canonicalId: "c1", text: "改引言" }],
      evidenceAliases: [],
    });
    expect(plan.items[0]?.actionType).toBe("modify");
  });
});

// ---------------------------------------------------------------------------
// F2：AUTHOR_DECISION_REQUIRED 标记 sticky（8c R2 实证）
// ---------------------------------------------------------------------------

describe("M11.4 Reliability Closure：派发结果聚合保留作者裁决标记", () => {
  const base: ExternalInstruction = {
    instructionId: "x-r2",
    source: "journal_reviewer",
    text: "论文缺少在真实车载边缘设备上的部署与性能验证实验。",
    status: "unresolved",
    statusNote: "AUTHOR_DECISION_REQUIRED: This plan item requires an author decision.",
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  };

  it("not_applicable 回报不得抹除 AUTHOR_DECISION_REQUIRED 标记（gate 按前缀识别合法终态）", () => {
    const { instructions } = applyDispatchOutcome(
      [structuredClone(base)],
      {
        round: 1,
        revision: 3,
        outcomes: [{
          instructionId: "x-r2",
          outcome: "not_applicable",
          basis: "target not related",
          targetChanged: false,
          target: "main.tex#metrics",
        }],
        unmatched: [],
      },
      "2026-10-06T01:00:00.000Z",
    );
    expect(instructions[0]?.status).toBe("unresolved");
    expect(instructions[0]?.statusNote?.startsWith("AUTHOR_DECISION_REQUIRED")).toBe(true);
  });

  it("applied-无实据回报同样保留标记", () => {
    const { instructions } = applyDispatchOutcome(
      [structuredClone(base)],
      {
        round: 1,
        revision: 3,
        outcomes: [{
          instructionId: "x-r2",
          outcome: "applied",
          basis: "claimed",
          targetChanged: false,
          target: "main.tex#metrics",
        }],
        unmatched: [],
      },
      "2026-10-06T01:00:00.000Z",
    );
    expect(instructions[0]?.statusNote?.startsWith("AUTHOR_DECISION_REQUIRED")).toBe(true);
  });

  it("无标记的普通 not_applicable 意见保持既有口径（plain unresolved 说明）", () => {
    const { instructions } = applyDispatchOutcome(
      [{ ...structuredClone(base), statusNote: undefined }],
      {
        round: 1,
        revision: 3,
        outcomes: [{
          instructionId: "x-r2",
          outcome: "not_applicable",
          basis: "n/a",
          targetChanged: false,
        }],
        unmatched: [],
      },
      "2026-10-06T01:00:00.000Z",
    );
    expect(instructions[0]?.statusNote).toBe("派发的章节均报告不适用或未报告执行结果");
  });

  it("verified applied（真实文件变化）仍是更强终态，可正常关闭意见", () => {
    const { instructions } = applyDispatchOutcome(
      [structuredClone(base)],
      {
        round: 1,
        revision: 3,
        outcomes: [{
          instructionId: "x-r2",
          outcome: "applied",
          basis: "added deployment summary",
          targetChanged: true,
          target: "main.tex#edge_deploy",
        }],
        unmatched: [],
      },
      "2026-10-06T01:00:00.000Z",
    );
    expect(instructions[0]?.status).toBe("handled");
  });
});

// ---------------------------------------------------------------------------
// F3：patch 候选校验消费的两类检测输入形态（8b 实证：56.8% 被删除）
// ---------------------------------------------------------------------------

describe("M11.4 Reliability Closure：span 内数值删除 / 占位替换的检测形态", () => {
  function evaluate(previous: string, current: string) {
    return evaluateFactPreservation({
      previous: { revision: 1, files: [{ file: "main.tex", content: previous }] },
      current: { revision: 2, files: [{ file: "main.tex", content: current }] },
      plan: null,
      improvementPlanItems: [],
      evidenceTexts: [],
      weakeningAuthorizations: [],
    });
  }

  const FROZEN_INTRO = [
    "\\section{引言}",
    "近年来，基于深度卷积神经网络的目标检测器取得了显著进展，例如 YOLOv7 在 COCO 数据集上实现了 56.8\\% 的 AP 且具备较高的实时性\\cite{Wang2023YOLOv7}。",
    "",
    "本文研究车载多目标跟踪。",
    "\\end{document}",
  ].join("\n");

  it("重写段落删除既有数值事实（56.8% AP）→ removedFacts 非空（候选校验据此拦截）", () => {
    const current = FROZEN_INTRO.replace(
      "例如 YOLOv7 在 COCO 数据集上实现了 56.8\\% 的 AP 且具备较高的实时性\\cite{Wang2023YOLOv7}",
      "检测器持续演进",
    );
    const summary = evaluate(FROZEN_INTRO, current);
    expect(summary.removedFacts.length).toBeGreaterThan(0);
    expect(summary.ok).toBe(false);
  });

  it("数值被占位文本替换（含删除）→ removedFacts/placeholder 至少一类非空", () => {
    const current = FROZEN_INTRO.replace(
      "实现了 56.8\\% 的 AP",
      "实现了待回填的 AP",
    );
    const summary = evaluate(FROZEN_INTRO, current);
    expect(summary.removedFacts.length + summary.placeholderRegressions.length).toBeGreaterThan(0);
  });

  it("未触碰数值的合法润色 → 两类检测均为空（无误伤）", () => {
    const current = FROZEN_INTRO.replace("本文研究车载多目标跟踪。", "本文聚焦车载场景的多目标跟踪问题。");
    const summary = evaluate(FROZEN_INTRO, current);
    expect(summary.removedFacts).toHaveLength(0);
    expect(summary.placeholderRegressions).toHaveLength(0);
  });

  it("表格 cell 文本被追加事实性澄清（Run B 实证形态）→ changedFacts 非空", () => {
    const previous = [
      "\\section{实验}",
      "\\begin{table}",
      "\\caption{对比方法来源}",
      "\\begin{tabular}{ll}",
      "方法 & 来源 \\\\",
      "YOLOv11+DeepSORT & DeepSORT 的外观关联思想 \\\\",
      "\\end{tabular}",
      "\\end{table}",
      "\\end{document}",
    ].join("\n");
    const current = previous.replace(
      "DeepSORT 的外观关联思想",
      "DeepSORT 的外观关联思想（自实现，ReID 特征统一为 128 维，非官方实现）",
    );
    const summary = evaluate(previous, current);
    expect(summary.changedFacts.length).toBeGreaterThan(0);
    expect(summary.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F4：removed 类违规的确定性恢复（8b 实证：56.8% 删除无恢复路径 → permanent FAIL）
// ---------------------------------------------------------------------------

describe("M11.4 Reliability Closure：removed 类违规的确定性段落恢复", () => {
  const frozen = [
    "\\section{引言}",
    "近年来，YOLOv7 在 COCO 数据集上实现了 56.8\\% 的 AP 且具备较高的实时性\\cite{Wang2023YOLOv7}，YOLOv11 进一步强化了轻量化能力。",
    "\\end{document}",
  ].join("\n");
  const current = [
    "\\section{引言}",
    "近年来，YOLO 系列（含 YOLOv7 与 YOLOv11）在 COCO 数据集上持续演进，且具备较高的实时性\\cite{Wang2023YOLOv7}。",
    "\\end{document}",
  ].join("\n");

  it("删除 56.8% 的重写段 → 冻结段锚点定位成功，恢复计划可执行", () => {
    const violations = [{
      kind: "removed" as const,
      file: "main.tex",
      section: "引言",
      before: "56.8\\% 的 AP…",
      after: "",
      reason: "prose_number_removed",
      classification: { category: "A" as const, type: "number_removed", severity: "high" as const, oldValue: "56.8%" },
      violationKey: "abc123def4567890",
    }];
    const plan = planFactRestore([{ file: "main.tex", content: frozen }], [{ file: "main.tex", content: current }], violations);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.restorable).toHaveLength(1);
    expect(plan.restorable[0]?.resolves).toEqual(["abc123def4567890"]);
    const applied = applyFactRestore([{ file: "main.tex", content: current }], plan);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.content).toContain("56.8");
  });

  it("冻结稿多个段落含同值 → 定位歧义 → skipped（宁可 needs_user_confirmation）", () => {
    // 真正的第二段落（空行分隔），而非同段内二次出现
    const frozenAmbiguous = `${frozen}\n\n对照实验段：另一次测量同样得到 56.8\\% 的 AP 结果。\n\\end{document}`;
    const violations = [{
      kind: "removed" as const,
      file: "main.tex", section: "引言", before: "56.8\\%", after: "", reason: "prose_number_removed",
      classification: { category: "A" as const, type: "number_removed", severity: "high" as const, oldValue: "56.8%" },
      violationKey: "abc123def4567890",
    }];
    const plan = planFactRestore([{ file: "main.tex", content: frozenAmbiguous }], [{ file: "main.tex", content: current }], violations);
    expect(plan.restorable).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("frozen_anchor_ambiguous");
  });

  it("changed 类违规的恢复行为不变（回归保护）", () => {
    const violations = [{
      kind: "changed" as const,
      file: "main.tex", section: "实验", before: "MOTA 71.2", after: "MOTA 73.5", reason: "value_changed",
      classification: { category: "A" as const, type: "number_changed", severity: "high" as const, oldValue: "71.2", newValue: "73.5" },
      violationKey: "fedcba0987654321",
    }];
    const frozenChanged = "\\section{实验}\n本方法 MOTA 71.2，IDF1 74.3。\n\\end{document}";
    const currentChanged = "\\section{实验}\n本方法 MOTA 73.5，IDF1 74.3。\n\\end{document}";
    const plan = planFactRestore([{ file: "main.tex", content: frozenChanged }], [{ file: "main.tex", content: currentChanged }], violations);
    expect(plan.restorable).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F16：evidence-free noop（Run E 实证：基线覆盖的证明是稿件引文本身）
// ---------------------------------------------------------------------------

describe("M11.4 Reliability Closure：noop 的 coverageQuote 即已满足证明", () => {
  const span = {
    file: "main.tex", start: 0, end: 100, logicalSection: "subsec:edge_deploy",
    heading: "车载边缘设备部署实验", content: "本节给出真实道路视频在车载级边缘平台上的完整链路部署实验，E2E 延迟为 1495.63 ms。",
    originalHash: "h",
  };

  it("无 Evidence 绑定 + 引文逐字命中 → verified（合法基线覆盖 noop）", () => {
    const result = verifyNoopCoverage(
      { logicalSection: "subsec:edge_deploy", coverageQuote: "完整链路部署实验，E2E 延迟为 1495.63 ms", evidenceIds: [] },
      [span],
      new Map(),
    );
    expect(result.verified).toBe(true);
  });

  it("引文不在目标 span → 仍拒绝（引文核验不放松）", () => {
    const result = verifyNoopCoverage(
      { logicalSection: "subsec:edge_deploy", coverageQuote: "这句话不在基线中", evidenceIds: [] },
      [span],
      new Map(),
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("NOOP_COVERAGE_QUOTE_MISSING");
  });

  it("绑定了未核验 Evidence → 拒绝（绑定即校验）", () => {
    const result = verifyNoopCoverage(
      { logicalSection: "subsec:edge_deploy", coverageQuote: "完整链路部署实验", evidenceIds: ["E9"] },
      [span],
      new Map(),
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("NOOP_EVIDENCE_UNVERIFIED");
  });
});

// ---------------------------------------------------------------------------
// Run 1 新失败形态：patch-backed closure / author-input 重分类 / 待作者确认占位
// ---------------------------------------------------------------------------

describe("M11.4 Reliability Closure：patch-backed outcome 覆盖（Run 1 R2 实证）", () => {
  const reports: ExternalOutcomeReport[] = [
    { instructionId: "x-r2", outcome: "not_applicable", basis: "target not related", targetChanged: false, target: "main.tex#metrics" },
    { instructionId: "x-r4", outcome: "conflict", basis: "数字冲突", targetChanged: false },
    { instructionId: "x-editor", outcome: "applied", basis: "done", targetChanged: true },
  ];

  it("机器 patch lineage（accepted+target 对应+真实变更）覆盖 not_applicable 自报", () => {
    const next = applyPatchBackedOutcomeOverrides(reports, {
      instructionIds: ["x-r2"],
      target: "main.tex#车载边缘设备部署实验",
      planItemIds: ["improvement:5"],
      patchIds: ["patch:9f1e9bedb73e"],
    });
    const r2 = next.find((r) => r.instructionId === "x-r2");
    expect(r2?.outcome).toBe("applied");
    expect(r2?.targetChanged).toBe(true);
    expect(r2?.basis).toContain("deterministic patch attribution");
    expect(r2?.patchIds).toEqual(["patch:9f1e9bedb73e"]);
    // 其余意见不受影响
    expect(next.find((r) => r.instructionId === "x-r4")?.outcome).toBe("conflict");
    expect(next.find((r) => r.instructionId === "x-editor")?.outcome).toBe("applied");
  });

  it("conflict 与 applied 自报不被覆盖；无匹配意见时原样返回", () => {
    const untouched = applyPatchBackedOutcomeOverrides(reports, {
      instructionIds: ["x-r4", "x-editor", "x-none"],
      target: "t",
      planItemIds: ["p"],
      patchIds: ["patch:x"],
    });
    expect(untouched.find((r) => r.instructionId === "x-r4")?.outcome).toBe("conflict");
    expect(untouched.find((r) => r.instructionId === "x-editor")?.basis).toBe("done");
    const same = applyPatchBackedOutcomeOverrides(reports, { instructionIds: [], target: "t", planItemIds: [], patchIds: [] });
    expect(same).toBe(reports);
  });
});

describe("M11.4 Reliability Closure：author-input modify 条目确定性重分类（Run 1 实证）", () => {
  it("modify 且 action 依赖作者确认 → author_decision_required", () => {
    const items = reclassifyAuthorInputActions([
      { action: "由作者确认模板存储时刻速度 vs 当前卡尔曼速度，二选一写明", actionType: "modify" },
      { action: "待作者确认 L_mem 的梯度路径是否 detach 后统一表述", actionType: "modify" },
      { action: "需作者确认 λ_smooth 最终取值（0.25 / 0.50）后改表", actionType: "modify" },
    ]);
    expect(items.every((item) => item.actionType === "author_decision_required")).toBe(true);
  });

  it("普通 modify / noop 不受影响", () => {
    const items = reclassifyAuthorInputActions([
      { action: "删除『均优于』强断言，改为中性概括", actionType: "modify" },
      { action: "基线已包含部署实验", actionType: "noop" },
      { action: "由作者确认（原文已含此短语但非 modify）", actionType: "author_decision_required" },
    ]);
    expect(items[0]?.actionType).toBe("modify");
    expect(items[1]?.actionType).toBe("noop");
    expect(items[2]?.actionType).toBe("author_decision_required");
  });
});

describe("M11.4 Reliability Closure：【待作者确认】正文占位检测（Run 1 实证）", () => {
  function evaluate(previous: string, current: string) {
    return evaluateFactPreservation({
      previous: { revision: 1, files: [{ file: "main.tex", content: previous }] },
      current: { revision: 2, files: [{ file: "main.tex", content: current }] },
      plan: null,
      improvementPlanItems: [],
      evidenceTexts: [],
      weakeningAuthorizations: [],
    });
  }

  it("新增【待作者确认】未决标记（数值保留）→ placeholder 回归触发", () => {
    const previous = "\\section{方法}\n本方法使用 3 级模板存储，检索维度为 128。\n\\end{document}";
    const current = "\\section{方法}\n本方法使用 3 级模板存储，检索维度为 128。外推速度来源【待作者确认：模板存储时刻速度 / 当前卡尔曼速度】。\n\\end{document}";
    const summary = evaluate(previous, current);
    expect(summary.placeholderRegressions.length).toBeGreaterThan(0);
    expect(summary.ok).toBe(false);
  });

  it("「尚待验证」对冲语仍不触发（04e4655 语义保持）", () => {
    const previous = "\\section{实验}\n本表数值的实验记录尚未完成核验，趋势为初步解读。\n\\end{document}";
    const current = "\\section{实验}\n本表数值的实验记录尚未完成核验，趋势为初步解读，机制贡献能否保持尚待验证。\n\\end{document}";
    const summary = evaluate(previous, current);
    expect(summary.placeholderRegressions).toHaveLength(0);
  });
});

describe("M11.4 Reliability Closure：同参数等值重述不算新增超参数（Run A 实证）", () => {
  function evaluate(previous: string, current: string) {
    return evaluateFactPreservation({
      previous: { revision: 1, files: [{ file: "main.tex", content: previous }] },
      current: { revision: 2, files: [{ file: "main.tex", content: current }] },
      plan: null,
      improvementPlanItems: [],
      evidenceTexts: [],
      weakeningAuthorizations: [],
    });
  }

  it("基线 λ_smooth＝0.50（全角等号），修订写 λ_smooth=0.5 → 同参数等值重述（不计违规）", () => {
    const previous = "\\section{训练}\n本文最终设置取 λ_smooth＝0.50，权重扫描见表。\n\\end{document}";
    const current = "\\section{训练}\n本文最终设置取 λ_smooth=0.5，权重扫描见表。\n\\end{document}";
    const summary = evaluate(previous, current);
    expect(summary.addedUnsupportedFacts.filter((f) => f.reason === "hyperparameter_assignment")).toHaveLength(0);
    expect(summary.formatChanges.filter((f) => f.reason === "assignment_format_restatement").length).toBeGreaterThan(0);
    expect(summary.ok).toBe(true);
  });

  it("基线没有的参数赋值（新增 λ_gate=0.7）仍判 unauthorized", () => {
    const previous = "\\section{方法}\n模板容量 r=16，检索维度 128。\n\\end{document}";
    const current = "\\section{方法}\n模板容量 r=16，检索维度 128，门控阈值 λ_gate=0.7。\n\\end{document}";
    const summary = evaluate(previous, current);
    expect(summary.addedUnsupportedFacts.filter((f) => f.reason === "hyperparameter_assignment").length).toBeGreaterThan(0);
    expect(summary.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F5：claim↔finding 归因（数值指纹档 + claimIndex lineage + 直接 id join）
// ---------------------------------------------------------------------------

describe("M11.4 Reliability Closure：归因数值指纹档与 claimIndex lineage", () => {
  // 8c 实证形态：主表 claim（4 数值）被基线覆盖 → excluded；finding 是
  // 「问题」元描述（引用 3/4 数值，章节标签噪声）
  const FROZEN = [
    "本文方法在 BDD100K 验证集上 MOTA 71.2 / IDF1 74.0 / IDS 8200 / J_trk 0.96，优于全部基线。",
  ].join("\n");
  const frozenFiles = [{ file: "main.tex", content: FROZEN }];
  const mainTableClaim: ClaimGroundingEntry = {
    claimId: "c-d508d2b1eb60",
    section: "subsec:main_results",
    claim: "BDD100K 验证集上本文方法 MOTA 71.2 / IDF1 74.0 / IDS 8200 / J_trk 0.96 优于全部基线",
    verdict: "UNSUPPORTED",
    evidenceFormal: false,
    repairCandidates: [],
  };

  function issue(over: Partial<ReviewIssue>): ReviewIssue {
    return {
      category: "fact", severity: "critical", section: "实验与结果/消融实验",
      description: "主对比表报告本文方法 MOTA 71.2 / IDF1 74.0 / IDS 8200，而消融表同一配置为 68.1 / 72.5 / 10800；两处不一致未解释，且消融完整配置低于次优基线 69.0。",
      blocking: true, ...over,
    };
  }

  it("元描述引用 claim 过半数值（3/4）且章节不兼容 → 数值指纹档归因成功", () => {
    const audit = computeClaimGapAudit({
      projectId: "p-8c", round: 3, baselineRevision: 1,
      unsupportedClaims: [mainTableClaim],
      issues: [issue({})],
      frozenFiles,
      authorEvidence: [],
    });
    expect(audit.claims[0]?.applicability).toBe("excluded_pre_existing");
    expect(audit.issueAttribution[0]?.excluded).toBe(true);
    expect(audit.issueAttribution[0]?.claimId).toBe("c-d508d2b1eb60");
  });

  it("描述不引用 claim 数值且章节不兼容 → 数值指纹档不误伤（仍 open）", () => {
    const audit = computeClaimGapAudit({
      projectId: "p-8c", round: 3, baselineRevision: 1,
      unsupportedClaims: [mainTableClaim],
      issues: [issue({ description: "摘要未限定优势成立条件，极端场景下全面劣于纯 IoU 基线。" })],
      frozenFiles,
      authorEvidence: [],
    });
    expect(audit.issueAttribution[0]?.excluded).toBe(false);
  });

  it("claimIndex lineage：合法下标 + 章节兼容 → rootCauseKey 回填且被 audit 直接 join", () => {
    const abstractClaim = {
      section: "abstract",
      claim: "本文方法相比 Kalman、DeepSORT、ByteTrack、OC-SORT 基线在 MOTA、IDF1、IDS 和轨迹抖动指标上均取得改善",
    };
    const metaFinding = issue({
      section: "abstract / subsec:main_results",
      description: "摘要及主对比章节仍声称本文方法在 MOTA、IDF1、IDS、J_trk 上均优于各基线，无任何 verified 证据支撑。",
      claimIndex: 0,
    });
    const linked = resolveClaimIndexLinks([metaFinding], [abstractClaim]);
    expect(linked[0]?.rootCauseKey).toBe(claimFingerprint(abstractClaim.section, abstractClaim.claim));

    const abstractClaimEntry: ClaimGroundingEntry = {
      ...mainTableClaim, claimId: claimFingerprint(abstractClaim.section, abstractClaim.claim),
      section: "abstract", claim: abstractClaim.claim,
    };
    const audit = computeClaimGapAudit({
      projectId: "p-8c", round: 3, baselineRevision: 1,
      unsupportedClaims: [abstractClaimEntry],
      issues: linked,
      frozenFiles: [{ file: "main.tex", content: "本文方法在 MOTA、IDF1、IDS 和轨迹抖动指标上均取得改善，相比 Kalman、DeepSORT、ByteTrack、OC-SORT 基线。" }],
      authorEvidence: [],
    });
    expect(audit.claims[0]?.applicability).toBe("excluded_pre_existing");
    expect(audit.issueAttribution[0]?.excluded).toBe(true);
    // tagIssueRootCauses 保留机器 lineage（不重跑词面匹配）
    const { issues: tagged } = tagIssueRootCauses(linked, [abstractClaimEntry]);
    expect(tagged[0]?.rootCauseKey).toBe(claimFingerprint(abstractClaim.section, abstractClaim.claim));
  });

  it("claimIndex 越界 / 无佐证 → 不采信（回到词面兜底）", () => {
    const claim = { section: "subsec:ablation", claim: "完整 MRG-DTM 在消融各项指标上均表现最好" };
    const outOfRange = issue({ claimIndex: 7, description: "消融表数值待核验" });
    const noCorroboration = issue({
      claimIndex: 0,
      section: "结论",
      description: "结论过度声称实时性达到帧率量级",
    });
    const linked = resolveClaimIndexLinks([outOfRange, noCorroboration], [claim]);
    expect(linked[0]?.rootCauseKey).toBeUndefined();
    expect(linked[1]?.rootCauseKey).toBeUndefined();
  });

  it("academic 类 finding 引用 claim 过半数值（Run C 实证）→ 数值指纹档跨 category 归因", () => {
    const audit = computeClaimGapAudit({
      projectId: "p-c", round: 3, baselineRevision: 1,
      unsupportedClaims: [mainTableClaim],
      issues: [issue({
        category: "academic",
        section: "实验与结果/消融实验",
        description: "主表（表4/表5）中本文方法在 BDD100K 验证集上 MOTA=71.2、IDF1=74.0、IDS=8200，而消融表（表7）为 68.1、72.5、10800，两处数值明显矛盾。",
      })],
      frozenFiles,
      authorEvidence: [],
    });
    expect(audit.claims[0]?.applicability).toBe("excluded_pre_existing");
    expect(audit.issueAttribution[0]?.excluded).toBe(true);
    expect(audit.issueAttribution[0]?.claimId).toBe("c-d508d2b1eb60");
  });

  it("academic 类 finding 无数值引用且词面重叠低 → 弱证据档不越 category（不误伤）", () => {
    const audit = computeClaimGapAudit({
      projectId: "p-c", round: 3, baselineRevision: 1,
      unsupportedClaims: [mainTableClaim],
      issues: [issue({
        category: "academic",
        section: "结论",
        description: "结论新增对冲表述与摘要正面声明自相矛盾，核心贡献有效性被否定。",
      })],
      frozenFiles,
      authorEvidence: [],
    });
    expect(audit.issueAttribution[0]?.excluded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F14：候选级与 cumulative 同授权标准（revision-plan 文本不得自我授权新增）
// ---------------------------------------------------------------------------

describe("M11.4 Reliability Closure：strict 候选授权口径（Run C 实证）", () => {
  const PREVIOUS = [
    "\\section{方法}",
    "特征融合采用「替代或融合」的可变表述，取决于写入门控状态。",
    "\\end{document}",
  ].join("\n");
  const CURRENT = [
    "\\section{方法}",
    "特征融合统一为：",
    "\\begin{equation}",
    "\\mathbf{g}_t^k = \\beta\\, \\bar{\\mathbf{f}}_t^k + (1-\\beta)\\, f_{t^{\\prime}}^k,",
    "\\end{equation}",
    "其中 $\\beta$ 为固定融合权重。",
    "\\end{document}",
  ].join("\n");
  // round-2 修订计划的 finding 条目 instruction 点名该公式（机器生成文本）
  const planNamingFormula = {
    schemaVersion: 1,
    planId: "plan-r2-rev2",
    projectId: "p-c",
    sourceRevision: 2,
    reviewRound: 2,
    createdAt: new Date().toISOString(),
    summary: { critical: 0, major: 1, blocking: 0, minorRecorded: 0, planned: 1, skipped: 0 },
    items: [{
      id: "f-abc123def456",
      kind: "review_finding",
      priority: "medium",
      section: "main.tex",
      problem: "表述不统一",
      instruction: "统一为 \\mathbf{g}_t^k = \\beta\\, \\bar{\\mathbf{f}}_t^k + (1-\\beta)\\, f_{t^{\\prime}}^k",
      expectedOutcome: "统一表述",
      status: "planned",
    }],
  } as never;

  function evaluate(strict: boolean) {
    return evaluateFactPreservation({
      previous: { revision: 2, files: [{ file: "main.tex", content: PREVIOUS }] },
      current: { revision: 3, files: [{ file: "main.tex", content: CURRENT }] },
      plan: planNamingFormula,
      improvementPlanItems: [],
      evidenceTexts: [],
      weakeningAuthorizations: [],
      ...(strict ? { strictPlanTextAuthorization: true } : {}),
    });
  }

  it("宽松口径（gate pairwise 旧行为）：计划文本点名 → 公式新增被授权", () => {
    const summary = evaluate(false);
    expect(summary.addedUnsupportedFacts.filter((f) => f.reason === "formula_added")).toHaveLength(0);
  });

  it("严格口径（patch 候选 / cumulative 同标准）：计划文本不授权 → 公式新增被拦", () => {
    const summary = evaluate(true);
    expect(summary.addedUnsupportedFacts.filter((f) => f.reason === "formula_added")).toHaveLength(1);
    expect(summary.ok).toBe(false);
  });
});
