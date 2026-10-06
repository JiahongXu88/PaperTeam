/**
 * M11.4 Attempt 8 — 确定性 gate/audit 修复回归。
 *
 * 四个实证缺陷（Attempt 8 clean run p-db07e4273daa / w-e3ff6274abc5，
 * Revision Task FAIL 的全部三个驱动因子）：
 *
 * 1. claimGapAudit 数值路径：审稿人转述里的区间连字符（"1400-200-400"）被
 *    读成负数 token（-200/-400），基线只有正数 → 基线既有数据集统计整条
 *    误判 revision_introduced（c-e965ba5d2331）。
 * 2. claimGapAudit 转述路径：reviewer 对表格内容的压缩标签（"消融与
 *    λ_smooth 扫描数值"）不对应任何单句——句级 containment 结构性失效
 *    （0.38 < 0.4），三张消融表全部是基线既有内容（c-dc50babe7207）。
 * 3. issue 归因（audit attribution + tagIssueRootCauses）：对称 Jaccard 对
 *    「短 claim 转述 vs 长 finding 描述」上限 ≈ |claim|/|描述| ≈ 0.15 < 0.2
 *    ——finding 逐字引用基线句、claim 已正确判 pre-existing 时，归因仍失败，
 *    Revision Task Gate 把 finding 归层 modified_existing 而非
 *    baseline_inherited（MRG-DTM「各项指标均表现最好」，基线 rev-1 L705
 *    与 rev-3 逐字相同）。
 * 4. factPreservation 公式多重集：评审指示的一致符号重命名（w_t^k →
 *    \omega_t^k，修复基线符号冲突）被记为 formula_removed_or_changed /
 *    formula_added 各 2 项 → 累计事实保持 4 项未授权漂移 → Revision Task
 *    必然 FAIL（结构性死锁：评审要求改名，累计守卫禁止改名）。
 */

import { describe, expect, it } from "vitest";

import { computeClaimGapAudit, tagIssueRootCauses } from "../../src/review/claimGapAudit.js";
import { evaluateFactPreservation } from "../../src/quality/factPreservation.js";
import type { ClaimGroundingEntry } from "../../src/review/claimGrounding.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";

// ---------------------------------------------------------------------------
// 修复 1：区间连字符不再产生负数 token
// ---------------------------------------------------------------------------

describe("M11.4 Attempt 8：claim 数值路径的区间连字符", () => {
  const FROZEN = [
    "BDD100K MOT 子集包含 2000 段约 40 秒的视频，标注频率为 5 FPS，官方划分为 1400 段训练视频、200 段验证视频和 400 段测试视频。",
    "UA-DETRAC 分辨率为 $960\\times540$，总帧数超过 14 万帧，遵循官方划分将 60\\% 视频作为训练集。",
  ].join("\n");
  const frozenFiles = [{ file: "main.tex", content: FROZEN }];

  function auditFor(claim: string) {
    return computeClaimGapAudit({
      projectId: "p1",
      round: 3,
      baselineRevision: 1,
      unsupportedClaims: [
        { claimId: "c-x", section: "数据集介绍", claim, verdict: "UNSUPPORTED", evidenceFormal: false, repairCandidates: [] },
      ],
      issues: [],
      frozenFiles,
      authorEvidence: [],
    });
  }

  it("审稿人转述的区间写法（1400-200-400）→ 全部数值命中基线正数 → pre-existing", () => {
    const audit = auditFor("BDD100K MOT 2000 段/5FPS/1400-200-400 划分；UA-DETRAC 960×540、14 万+帧、60/40 划分");
    expect(audit.claims[0]?.applicability).toBe("excluded_pre_existing");
    expect(audit.counts.revisionIntroduced).toBe(0);
  });

  it("真负数语义保留：claim 的 -3.0 与基线正 3.0 不可互相覆盖 → revision_introduced", () => {
    const frozenSigned = [
      { file: "main.tex", content: "消融实验显示本方法 IDF1 变化为 3.0。" },
    ];
    const audit = computeClaimGapAudit({
      projectId: "p1",
      round: 3,
      baselineRevision: 1,
      unsupportedClaims: [
        { claimId: "c-neg", section: "实验", claim: "消融实验显示本方法 IDF1 变化为 -3.0", verdict: "UNSUPPORTED", evidenceFormal: false, repairCandidates: [] },
      ],
      issues: [],
      frozenFiles: frozenSigned,
      authorEvidence: [],
    });
    expect(audit.claims[0]?.applicability).toBe("revision_introduced");
  });

  it("含基线没有的新数值 → 仍 revision_introduced", () => {
    const audit = auditFor("BDD100K MOT 2000 段/5FPS/1400-200-400 划分，另含 3300 段未标注视频");
    expect(audit.claims[0]?.applicability).toBe("revision_introduced");
  });
});

// ---------------------------------------------------------------------------
// 修复 2：全文级 containment 兜底（表格/多句压缩标签）
// ---------------------------------------------------------------------------

describe("M11.4 Attempt 8：无数字 claim 的全文级兜底", () => {
  // 基线分属不同句/表：无任何单句覆盖 ≥0.4（词元散布），且基线不用审稿人的
  // 「扫描」一词（实证形态：句级 0.25 / 全文 0.63）
  const FROZEN = [
    "\\section{实验}",
    "本文完成了消融与权重取值实验。",
    "对不同 $\\lambda_{\\text{smooth}}$ 值进行了测试。",
    "表\\ref{tab:ablation_main} 给出了主要指标的变化情况，表格数值。",
  ].join("\n\n");
  const frozenFiles = [{ file: "main.tex", content: FROZEN }];

  function auditFor(claims: { claimId: string; claim: string }[]) {
    return computeClaimGapAudit({
      projectId: "p1",
      round: 3,
      baselineRevision: 1,
      unsupportedClaims: claims.map((entry) => ({
        claimId: entry.claimId,
        section: "实验",
        claim: entry.claim,
        verdict: "UNSUPPORTED",
        evidenceFormal: false,
        repairCandidates: [],
      })),
      issues: [],
      frozenFiles,
      authorEvidence: [],
    });
  }

  it("表格压缩标签（词元散布全文、审稿人词汇不入基线）→ pre-existing（全文兜底）", () => {
    const audit = auditFor([{ claimId: "c-t", claim: "消融与 λ_smooth 扫描数值" }]);
    expect(audit.claims[0]?.applicability).toBe("excluded_pre_existing");
    expect(audit.claims[0]?.basis).toContain("全文");
  });

  it("新概念词元（基线全文不存在）→ 仍 revision_introduced", () => {
    const audit = auditFor([
      { claimId: "c-new", claim: "本文首次将神经符号推理引入车辆跟踪框架" },
      { claimId: "c-new2", claim: "系统在 TUM 数据集上取得 SOTA 排名" },
    ]);
    expect(audit.claims[0]?.applicability).toBe("revision_introduced");
    expect(audit.claims[1]?.applicability).toBe("revision_introduced");
  });
});

// ---------------------------------------------------------------------------
// 修复 3：issue 归因的非对称 containment（audit attribution + rootCauseKey）
// ---------------------------------------------------------------------------

describe("M11.4 Attempt 8：issue 归因到已排除 claim", () => {
  const FROZEN = [
    "从表可以看出，完整的 MRG-DTM 在各项指标上均表现最好，说明写入阶段的残差门控与读取阶段的运动兼容建模具有明显互补作用。",
  ].join("\n");
  const frozenFiles = [{ file: "main.tex", content: FROZEN }];
  const claims: ClaimGroundingEntry[] = [
    { claimId: "c-mrg", section: "消融实验", claim: "完整 MRG-DTM 各项指标均最好，写入/读取门控具有明显互补作用", verdict: "UNSUPPORTED", evidenceFormal: false, repairCandidates: [] },
  ];
  /** finding 逐字引用基线句 + 大段补充分析（对称 Jaccard ≈ 0.15 < 0.2 的形态） */
  const issues: ReviewIssue[] = [
    {
      category: "fact",
      severity: "major",
      blocking: true,
      section: "消融实验",
      description:
        "“完整的 MRG-DTM 在各项指标上均表现最好，说明写入阶段的残差门控与读取阶段的运动兼容建模具有明显互补作用”仍为无保留断言，且正文分析多处以因果语气解释机制贡献，而已核验证据明确指出拆离混杂因素后机制贡献不复存在。",
    },
  ];

  it("audit.issueAttribution：长描述引用基线句 → excluded=true 且带 claimId", () => {
    const audit = computeClaimGapAudit({
      projectId: "p1",
      round: 3,
      baselineRevision: 1,
      unsupportedClaims: claims,
      issues,
      frozenFiles,
      authorEvidence: [],
    });
    expect(audit.claims[0]?.applicability).toBe("excluded_pre_existing");
    expect(audit.issueAttribution[0]?.excluded).toBe(true);
    expect(audit.issueAttribution[0]?.claimId).toBe("c-mrg");
    expect(audit.counts.issues.excludedBlocking).toBe(1);
  });

  it("tagIssueRootCauses：同一 finding 被 rootCauseKey 关联到 claim", () => {
    const { issues: tagged } = tagIssueRootCauses(issues, claims);
    expect(tagged[0]?.rootCauseKey).toBe("c-mrg");
  });

  it("章节标签噪声（…分析 vs …分析段）不破坏引用级归因", () => {
    // 同一 reviewer 对 claim 与 issue 的节标注不完全一致（Attempt 8 实证形态）；
    // 子串匹配失败（"分析段）" 不含 "分析）"），描述逐字引用基线句
    // （containment ≥ 0.75）时归因不因节标签失败
    const noisyClaims = [
      { ...claims[0]!, section: "消融实验（tab:ablation_mgdtm 分析）" },
    ];
    const noisyIssues: ReviewIssue[] = [
      {
        ...issues[0]!,
        section: "消融实验（tab:ablation_mgdtm 分析段）",
      },
    ];
    const audit = computeClaimGapAudit({
      projectId: "p1",
      round: 3,
      baselineRevision: 1,
      unsupportedClaims: noisyClaims,
      issues: noisyIssues,
      frozenFiles,
      authorEvidence: [],
    });
    expect(audit.issueAttribution[0]?.excluded).toBe(true);
    expect(audit.issueAttribution[0]?.claimId).toBe("c-mrg");
    const { issues: tagged } = tagIssueRootCauses(noisyIssues, noisyClaims);
    expect(tagged[0]?.rootCauseKey).toBe("c-mrg");
  });
});

// ---------------------------------------------------------------------------
// 修复 4：公式多重集的一致符号重命名（alpha-rename）配对
// ---------------------------------------------------------------------------

describe("M11.4 Attempt 8：公式符号一致重命名 → formatChanges", () => {
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

  it("评审指示的 w_t^k → \\omega_t^k 一致替换：无公式违规，rename 进 formatChanges", () => {
    const previous = [
      "\\section{损失}",
      "\\begin{equation}",
      "w_t^k = \\frac{1}{s_t^k + \\epsilon},",
      "\\end{equation}",
      "尺度自适应权重 $w_t^k$ 由尺度 $s_t^k$ 构造，训练目标为 $\\mathcal{L} = \\mathcal{L}_{\\text{det}} + \\lambda_{\\text{smooth}} \\mathcal{L}_{\\text{smooth}}$。",
      "\\end{document}",
    ].join("\n");
    const current = [
      "\\section{损失}",
      "\\begin{equation}",
      "\\omega_t^k = \\frac{1}{s_t^k + \\epsilon},",
      "\\end{equation}",
      "尺度自适应权重 $\\omega_t^k$ 由尺度 $s_t^k$ 构造，训练目标为 $\\mathcal{L} = \\mathcal{L}_{\\text{det}} + \\lambda_{\\text{smooth}} \\mathcal{L}_{\\text{smooth}}$。",
      "\\end{document}",
    ].join("\n");
    const summary = evaluate(previous, current);
    expect(summary.formulaChanges).toHaveLength(0);
    expect(summary.addedUnsupportedFacts.filter((f) => f.reason === "formula_added")).toHaveLength(0);
    const renames = summary.formatChanges.filter((f) => f.reason === "formula_notation_rename");
    expect(renames.length).toBeGreaterThan(0);
    expect(renames.every((f) => f.classification?.category === "B")).toBe(true);
    expect(summary.ok).toBe(true);
  });

  it("公式数值变化（ε → 2ε）不因符号相同被豁免 → 仍违规", () => {
    const previous = [
      "\\section{损失}",
      "$w_t^k = \\frac{1}{s_t^k + \\epsilon}$，权重由此构造。",
      "\\end{document}",
    ].join("\n");
    const current = [
      "\\section{损失}",
      "$w_t^k = \\frac{1}{s_t^k + 2\\epsilon}$，权重由此构造。",
      "\\end{document}",
    ].join("\n");
    const summary = evaluate(previous, current);
    const formulaViolations = summary.formulaChanges.length +
      summary.addedUnsupportedFacts.filter((f) => f.reason === "formula_added").length;
    expect(formulaViolations).toBeGreaterThan(0);
  });

  it("多字母词换名（MOTA → IDF1）不是 alpha-rename → 仍违规", () => {
    const previous = [
      "\\section{指标}",
      "$\\text{score} = \\text{MOTA} + \\text{IDS}$。",
      "\\end{document}",
    ].join("\n");
    const current = [
      "\\section{指标}",
      "$\\text{score} = \\text{IDF1} + \\text{IDS}$。",
      "\\end{document}",
    ].join("\n");
    const summary = evaluate(previous, current);
    const formulaViolations = summary.formulaChanges.length +
      summary.addedUnsupportedFacts.filter((f) => f.reason === "formula_added").length;
    expect(formulaViolations).toBeGreaterThan(0);
  });

  it("映射冲突的换名（α→β 一处、α→γ 另一处）→ 不配对，仍违规", () => {
    const previous = [
      "\\section{损失}",
      "$a = \\frac{1}{s + \\epsilon}$，$a + s = t$。",
      "\\end{document}",
    ].join("\n");
    const current = [
      "\\section{损失}",
      "$b = \\frac{1}{s + \\epsilon}$，$c + s = t$。",
      "\\end{document}",
    ].join("\n");
    const summary = evaluate(previous, current);
    // 两个 missing 共享旧 token a，但映射到不同新 token（a→b / a→c）——
    // 跨配对一致性破坏：第一对确立 a→b 后第二对被拒（或整体不配对），
    // 至少一条 formula 违规保留
    expect(summary.formulaChanges.length + summary.addedUnsupportedFacts.length).toBeGreaterThan(0);
  });
});
