/**
 * M11.4 Quality Gate Product Closure — 分层 gate 确定性测试（§62 清单）。
 *
 * 覆盖语义：
 * 1. Revision Task PASS + Publication NOT_READY（两层分离的核心场景）
 * 2. 任务 FAIL：外审意见未闭环（reviewer-required 阻塞）
 * 3. 任务 FAIL：修订引入 fact violation（确定性守卫）
 * 4. 基线继承且与意见无关的风险：不阻塞任务层，进投稿风险清单
 * 5. 意见要求的继承风险未解决：阻塞任务层（意见不闭环）
 * 6. 学术非回归容差（小跌过、大跌 FAIL）
 * 7. floor（启用时 FAIL；未启用时呈现不阻断）
 * 8. 灰区 claim → AUTHOR_DECISION_REQUIRED（不 FAIL 不 PASS）
 * 9. 旧 run 兼容（无新字段 → legacy 单层语义）
 * 10. 归层（classifyFindingOrigins）与 claimGapAudit 灰区带
 * 11. 可解释性（reasons[] 携带 check 明细）
 */

import { describe, expect, it } from "vitest";

import {
  classifyFindingOrigins,
  evaluateRevisionTaskGate,
  DEFAULT_REVISION_TASK_POLICY,
  type ExternalInstructionSnapshot,
  type FindingOriginEntry,
} from "../../src/quality/revisionTaskGate.js";
import { computeClaimGapAudit, type ClaimGapAudit } from "../../src/review/claimGapAudit.js";
import { classifyTerminalStatus } from "../../src/review/revisionOutcome.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import type { ClaimGroundingEntry } from "../../src/review/claimGrounding.js";

// ---- fixtures ----

const PASSING_GUARD_RULES = [
  { rule: "hallucinated_citations_zero", passed: true, detail: "0 条" },
  { rule: "citation_structure_valid", passed: true, detail: "ok" },
  { rule: "no_contradictory_evidence", passed: true, detail: "0 条" },
  { rule: "citation_keys_preserved", passed: true, detail: "ok" },
  { rule: "fact_preservation", passed: true, detail: "ok" },
  { rule: "cumulative_fact_preservation", passed: true, detail: "ok" },
];

const CLOSED_INSTRUCTIONS: ExternalInstructionSnapshot[] = [
  { instructionId: "x-1", status: "handled", authorDecision: false },
  { instructionId: "x-2", status: "already_satisfied", authorDecision: false },
];

const noFindings: FindingOriginEntry[] = [];

const noClaimsAudit: ClaimGapAudit = {
  schemaVersion: 1,
  reportId: "cga-r2",
  projectId: "p-test",
  round: 2,
  generatedAt: "2026-10-07T00:00:00.000Z",
  taskKind: "existing_paper_improvement",
  baselineRevision: 1,
  claims: [],
  issueAttribution: [],
  counts: {
    unsupportedTotal: 0,
    excludedPreExisting: 0,
    excludedAuthorData: 0,
    greyZone: 0,
    revisionIntroduced: 0,
    issues: { critical: 0, major: 0, blocking: 0, excludedCritical: 0, excludedMajor: 0, excludedBlocking: 0 },
  },
};

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    gateRules: PASSING_GUARD_RULES,
    externalInstructions: CLOSED_INSTRUCTIONS,
    claimGapAudit: noClaimsAudit,
    findingOrigins: noFindings,
    patchSubstanceOk: true,
    academicScore: 59,
    baselineAcademicScore: 62,
    policy: { ...DEFAULT_REVISION_TASK_POLICY },
    ...overrides,
  };
}

describe("evaluateRevisionTaskGate（分层判定）", () => {
  it("1. 守卫全过 + 意见闭环 + 无修订引入违规 + 无实质回退 → 任务 PASS（即使学术分远低于 80）", () => {
    const result = evaluateRevisionTaskGate(baseInput());
    expect(result.verdict).toBe("PASS");
    expect(result.success).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("2. 外审意见未闭环（pending / unresolved）→ 任务 FAIL（reviewer requirement 阻塞）", () => {
    const result = evaluateRevisionTaskGate(
      baseInput({
        externalInstructions: [
          ...CLOSED_INSTRUCTIONS,
          { instructionId: "x-3", status: "unresolved", authorDecision: false },
        ],
      }),
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.join(" ")).toContain("reviewer_requirements_closed");
  });

  it("3. 修订引入 fact violation（守卫规则失败）→ 任务 FAIL", () => {
    const result = evaluateRevisionTaskGate(
      baseInput({
        gateRules: [
          ...PASSING_GUARD_RULES.filter((rule) => rule.rule !== "fact_preservation"),
          { rule: "fact_preservation", passed: false, detail: "changedFacts=2" },
        ],
      }),
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.join(" ")).toContain("deterministic_guards");
    expect(result.reasons.join(" ")).toContain("fact_preservation");
  });

  it("4. 基线继承且与意见无关的 blocking finding：不阻塞任务层，进投稿风险清单", () => {
    const inheritedFinding: FindingOriginEntry = {
      fingerprint: "f-inherited0001",
      section: "实验与结果",
      severity: "critical",
      blocking: true,
      origin: "baseline_inherited",
      basis: "finding 章节未被本轮修订修改",
      description: "主对比表数值与公平消融数据存在矛盾（作者级裁决）",
    };
    const result = evaluateRevisionTaskGate(baseInput({ findingOrigins: [inheritedFinding] }));
    expect(result.verdict).toBe("PASS");
    expect(result.publication.risks.some((risk) => risk.description.includes("公平消融"))).toBe(true);
  });

  it("5. 意见要求的继承风险未解决（意见 unresolved）→ 任务 FAIL（reviewer-required 继承风险阻塞）", () => {
    // 语义由意见闭环承担：Reviewer 要求解决而未解决 → 意见不会是 handled
    const result = evaluateRevisionTaskGate(
      baseInput({
        externalInstructions: [{ instructionId: "x-1", status: "partially_handled", authorDecision: false }],
      }),
    );
    expect(result.verdict).toBe("FAIL");
  });

  it("6a. 非回归容差：基线 62、当前 55、容差 10 → 回退 7 分在带内 → PASS", () => {
    const result = evaluateRevisionTaskGate(baseInput({ academicScore: 55 }));
    expect(result.checks.find((check) => check.check === "academic_non_regression")?.passed).toBe(true);
    expect(result.verdict).toBe("PASS");
  });

  it("6b. 非回归容差：基线 62、当前 51 → 回退 11 分超带 → FAIL", () => {
    const result = evaluateRevisionTaskGate(baseInput({ academicScore: 51 }));
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.join(" ")).toContain("academic_non_regression");
  });

  it("6c. 无基线分可比 → 非回归检查不适用（不判失败，如实记录）", () => {
    const result = evaluateRevisionTaskGate(baseInput({ baselineAcademicScore: null }));
    expect(result.verdict).toBe("PASS");
    expect(result.checks.find((check) => check.check === "academic_non_regression")?.detail).toContain("不适用");
  });

  it("7a. floor 启用且低于 → FAIL；floor 明细携带状态", () => {
    const result = evaluateRevisionTaskGate(
      baseInput({
        policy: { ...DEFAULT_REVISION_TASK_POLICY, academicFloor: 60, academicFloorStatus: "provisional" },
      }),
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.join(" ")).toContain("academic_floor");
    expect(result.checks.find((check) => check.check === "academic_floor")?.detail).toContain("provisional");
  });

  it("7b. floor 未校准（null）→ 呈现不阻断（不伪装已校准）", () => {
    const result = evaluateRevisionTaskGate(baseInput());
    const floorCheck = result.checks.find((check) => check.check === "academic_floor");
    expect(floorCheck?.passed).toBe(true);
    expect(floorCheck?.detail).toContain("未启用");
  });

  it("8. 灰区 claim → AUTHOR_DECISION_REQUIRED（不 FAIL 不 PASS）", () => {
    const greyAudit: ClaimGapAudit = {
      ...noClaimsAudit,
      counts: { ...noClaimsAudit.counts, greyZone: 1, unsupportedTotal: 1 },
    };
    const result = evaluateRevisionTaskGate(baseInput({ claimGapAudit: greyAudit }));
    expect(result.verdict).toBe("AUTHOR_DECISION_REQUIRED");
    expect(result.authorDecisions.greyZoneClaims).toBe(1);
    expect(result.publication.verdict).toBe("AUTHOR_DECISION_REQUIRED");
  });

  it("8b. unknown-origin blocking finding → AUTHOR_DECISION_REQUIRED（系统不能自动裁决的转作者）", () => {
    const unknownFinding: FindingOriginEntry = {
      fingerprint: "f-unknown00001",
      section: "",
      severity: "critical",
      blocking: true,
      origin: "unknown_origin",
      basis: "finding 无章节归属",
      description: "全稿级表述问题",
    };
    const result = evaluateRevisionTaskGate(baseInput({ findingOrigins: [unknownFinding] }));
    expect(result.verdict).toBe("AUTHOR_DECISION_REQUIRED");
    expect(result.authorDecisions.unknownOriginFindings).toBe(1);
  });

  it("8c. 修改区间的 blocking finding → 任务 FAIL（修改区间的问题由修订负责）", () => {
    const modifiedFinding: FindingOriginEntry = {
      fingerprint: "f-modified0001",
      section: "摘要",
      severity: "critical",
      blocking: true,
      origin: "modified_existing",
      basis: "finding 位于本轮修订修改区间",
      description: "修改后段落引入的新矛盾",
    };
    const result = evaluateRevisionTaskGate(baseInput({ findingOrigins: [modifiedFinding] }));
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.join(" ")).toContain("no_revision_blocking_findings");
  });

  it("9. patch 实质失败 → 任务 FAIL；无 patch 产物 → 不适用（不判失败）", () => {
    expect(evaluateRevisionTaskGate(baseInput({ patchSubstanceOk: false })).verdict).toBe("FAIL");
    const na = evaluateRevisionTaskGate(baseInput({ patchSubstanceOk: null }));
    expect(na.verdict).toBe("PASS");
    expect(na.checks.find((check) => check.check === "patch_substance")?.detail).toContain("不适用");
  });

  it("10. 可解释性：每个失败 check 的 id + detail 都进 reasons", () => {
    const result = evaluateRevisionTaskGate(
      baseInput({
        externalInstructions: [{ instructionId: "x-9", status: "pending", authorDecision: false }],
        academicScore: 30,
      }),
    );
    expect(result.reasons.some((reason) => reason.startsWith("reviewer_requirements_closed:"))).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith("academic_non_regression:"))).toBe(true);
  });

  it("11. legacy 模式：分层关闭（显式回滚档）", () => {
    const result = evaluateRevisionTaskGate(
      baseInput({ policy: { ...DEFAULT_REVISION_TASK_POLICY, mode: "legacy" } }),
    );
    expect(result.success).toBe(false);
    expect(result.checks[0]?.check).toBe("policy_mode");
  });
});

describe("classifyFindingOrigins（finding 来源归层）", () => {
  const issue = (overrides: Partial<ReviewIssue>): ReviewIssue =>
    ({
      mode: "fact",
      section: "实验与结果",
      category: "fact",
      severity: "critical",
      blocking: true,
      description: "表格数值矛盾",
      ...overrides,
    }) as ReviewIssue;

  it("rootCauseKey → revision_introduced claim → revision_introduced", () => {
    const audit: ClaimGapAudit = {
      ...noClaimsAudit,
      claims: [
        {
          claimId: "c-1",
          section: "摘要",
          claim: "新引入的 claim",
          verdict: "UNSUPPORTED",
          applicability: "revision_introduced",
          basis: "不覆盖",
        },
      ],
    };
    const origins = classifyFindingOrigins(
      [issue({ rootCauseKey: "c-1", section: "摘要", description: "无支撑论断" })],
      audit,
      [],
    );
    expect(origins[0]?.origin).toBe("revision_introduced");
  });

  it("rootCauseKey → 灰区 claim → unknown_origin；excluded claim → baseline_inherited", () => {
    const audit: ClaimGapAudit = {
      ...noClaimsAudit,
      claims: [
        {
          claimId: "c-grey",
          section: "引言",
          claim: "灰区转述",
          verdict: "UNSUPPORTED",
          applicability: "grey_zone_author_decision",
          basis: "0.48",
        },
        {
          claimId: "c-pre",
          section: "摘要",
          claim: "基线既有",
          verdict: "UNSUPPORTED",
          applicability: "excluded_pre_existing",
          basis: "0.9",
        },
      ],
    };
    const origins = classifyFindingOrigins(
      [
        issue({ rootCauseKey: "c-grey", section: "引言", description: "灰区" }),
        issue({ rootCauseKey: "c-pre", section: "摘要", description: "既有" }),
      ],
      audit,
      [],
    );
    expect(origins[0]?.origin).toBe("unknown_origin");
    expect(origins[1]?.origin).toBe("baseline_inherited");
  });

  it("无 claim 归层：章节未修改 → baseline_inherited；章节已修改 → modified_existing；无章节 → unknown_origin", () => {
    const origins = classifyFindingOrigins(
      [
        issue({ section: "实验与结果", description: "未改区域的问题" }),
        issue({ section: "摘要", description: "修改区域的问题" }),
        issue({ section: "", description: "全局问题" }),
      ],
      null,
      ["摘要"],
    );
    expect(origins.map((entry) => entry.origin)).toEqual([
      "baseline_inherited",
      "modified_existing",
      "unknown_origin",
    ]);
  });

  it("minor finding 不参与归层（任务层只关心 heavy finding）", () => {
    const origins = classifyFindingOrigins(
      [issue({ severity: "minor", blocking: false, description: "小问题" })],
      null,
      [],
    );
    expect(origins).toHaveLength(0);
  });
});

describe("computeClaimGapAudit 灰区带（M11.4）", () => {
  function auditForClaim(claim: string, baselineSentence: string) {
    const entry: ClaimGroundingEntry = {
      claimId: "c-t",
      section: "摘要",
      claim,
      verdict: "UNSUPPORTED",
      evidenceFormal: false,
      repairCandidates: [],
    };
    return computeClaimGapAudit({
      projectId: "p-test",
      round: 2,
      baselineRevision: 1,
      unsupportedClaims: [entry],
      issues: [],
      frozenFiles: [{ file: "main.tex", content: baselineSentence }],
      authorEvidence: [],
      generatedAt: "2026-10-07T00:00:00.000Z",
    });
  }

  it("转述覆盖 ≥0.6 → excluded_pre_existing（回归）", () => {
    const audit = auditForClaim(
      "运动残差门控写入降低了遮挡恢复过程中的身份切换次数",
      "MRG-DTM 机制显著降低了遮挡恢复过程中的身份切换次数，运动残差门控写入是关键组件。",
    );
    expect(audit.claims[0]?.applicability).toBe("excluded_pre_existing");
  });

  it("转述覆盖 0.4–0.6 → grey_zone_author_decision（Attempt 7 c-7b1a 语义）", () => {
    const audit = auditForClaim(
      "现有记忆式方法的模板读写缺乏与运动一致性的显式耦合，形成研究空白",
      "外观模板或记忆的写入与读取大多仍由表观相似度单独驱动，缺乏与运动一致性的显式耦合。",
    );
    expect(audit.claims[0]?.applicability).toBe("grey_zone_author_decision");
    expect(audit.counts.greyZone).toBe(1);
    expect(audit.counts.revisionIntroduced).toBe(0);
  });

  it("全新概念 claim（低覆盖）→ revision_introduced（回归）", () => {
    const audit = auditForClaim(
      "本方法在 KITTI 行人跟踪榜单排名第一",
      "本文方法在 BDD100K 与 VisDrone 数据集上进行了评估。",
    );
    expect(audit.claims[0]?.applicability).toBe("revision_introduced");
  });
});

describe("旧 run 兼容 + 终态语义", () => {
  it("classifyTerminalStatus 无 revisionTaskSuccess 字段 → 旧五态语义不变", () => {
    expect(
      classifyTerminalStatus({ gatePassed: false, gateReasons: ["academic_score_threshold: 59 < 80"], convergence: null }).status,
    ).toBe("QUALITY_NOT_REACHED");
    expect(
      classifyTerminalStatus({ gatePassed: false, gateReasons: ["fact_preservation: fail"], convergence: null }).status,
    ).toBe("SYSTEM_FAILED");
  });

  it("任务成功 + gate 未过 → REVISION_TASK_COMPLETE（不是 QUALITY_NOT_REACHED）", () => {
    const result = classifyTerminalStatus({
      gatePassed: false,
      gateReasons: ["academic_score_threshold: 59 < 80"],
      convergence: null,
      revisionTaskSuccess: true,
    });
    expect(result.status).toBe("REVISION_TASK_COMPLETE");
    expect(result.message).toContain("返修任务完成");
    expect(result.message).toContain("投稿就绪");
  });

  it("守卫失败优先于任务成功语义（防御性：任务层本就包含守卫）", () => {
    const result = classifyTerminalStatus({
      gatePassed: false,
      gateReasons: ["fact_preservation: fail"],
      convergence: null,
      revisionTaskSuccess: true,
    });
    expect(result.status).toBe("SYSTEM_FAILED");
  });

  it("QualityGateResult 新字段可缺省（旧产物 JSON 兼容）", async () => {
    const legacyGateJson = JSON.parse(
      JSON.stringify({ passed: false, reasons: ["academic_score_threshold: 59 < 80"], rules: [], thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true }, checkedAt: "2026-10-01T00:00:00.000Z" }),
    );
    expect(legacyGateJson.revisionTask).toBeUndefined();
    expect(legacyGateJson.publicationReadiness).toBeUndefined();
  });
});
