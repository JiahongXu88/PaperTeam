/**
 * Revision Validation（M6.7 §6/§7/§8/§9，确定性、无 LLM）。
 *
 * Revision ≠ Correct Revision：Writer 执行完修订计划（applied）不等于修订正确。
 * 本模块在「修订写入之后、复审之前」对 sourceRevision → revision 的实际差异做
 * 四类复核，并把结果归因到具体 Revision Item（条目级终态）：
 *
 *   1. Fact Preservation（复用 M5.6）：实验事实不得无依据漂移（数字 / 表格 /
 *      公式 / 方向 / 协议 / 占位）→ 违规文件的条目 rejected。
 *   2. Citation Preservation（复用 M5.6）：既有引用不得无依据消失 →
 *      unexpectedRemoved 命中文件的条目 rejected；新增引用记录 evidence-backed
 *      覆盖（提示级，与 requireEvidenceBackedCitations 同源）。
 *   3. Claim Strength（M6.7 新）：弱证据 → 强表述的升级检测 → block 级 rejected /
 *      warning 级 needs_review。
 *   4. Evidence Re-validation（M6.7 新）：条目关联证据在修订后是否仍存在且仍为
 *      formal（verified + 锚点）→ 失效 needs_review。
 *
 * 归因粒度 = 文件级（与 M4.7 section-scoped 派发对齐）：违规只可能来自被改写
 * 的文件，落在同文件条目上是保守归因（宁可重派一轮，不静默放行）。条目执行
 * 与否最终以复审（同 finding 指纹再现）为准，本层不猜测 Writer 意图。
 *
 * blocked（rejected / block finding 存在）→ workflow 进入 hitl.revision_validation
 * （approve / reject / needs_review）；needs_review 不阻断循环但阻断 Final
 * （Quality Gate revision_items_resolved）。
 */

import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { isFormalEvidence } from "../evidence/EvidenceSelectionService.js";
import type { FactPreservationSummary } from "../quality/factPreservation.js";
import type { CitationPreservationSummary } from "../quality/citationPreservation.js";
import type { ClaimStrengthFinding } from "../quality/claimStrength.js";
import { checkClaimStrengthEscalation } from "../quality/claimStrength.js";
import type { RevisionPlan, RevisionPlanItem, RevisionPlanItemKind } from "./revisionPlan.js";
import type { RevisionItemResolutionReason } from "./revisionItemStatus.js";
import { extractCitationKeys } from "./styleInvariants.js";

export type RevisionValidationItemStatus = "validated" | "rejected" | "needs_review";

/**
 * 拒绝归因类别（M9.10 Phase 4：失败可解释）。
 * citation 类别事件名 = citation_removal_detected（任务规格命名；对应 reasonCode
 * 仍是 citation_removal_unauthorized——evaluation runner 按该字符串对账，不改）。
 */
export type RevisionRejectionCategory =
  | "fact_preservation"
  | "citation_removal_detected"
  | "claim_strength"
  | "evidence_stale";

export interface RevisionValidationItemResult {
  id: string;
  kind: RevisionPlanItemKind;
  section: string;
  riskLevel: RevisionPlanItem["riskLevel"];
  status: RevisionValidationItemStatus;
  /** 主归因类别（validated 条目为 null；M9.10 前的旧产物无此字段） */
  category?: RevisionRejectionCategory | null;
  /** 机器可读原因码（写回计划条目 resolution 的前缀；与 reasons 一一对应） */
  reasonCodes: RevisionItemResolutionReason[];
  reasons: string[];
}

/** rejected 条目的结构化报告项（M9.10 Phase 4：id + category + reason + evidence） */
export interface RejectedItemReport {
  id: string;
  category: RevisionRejectionCategory;
  reason: string;
  /** 证据片段（before → after / key / marker；≤ 3 条） */
  evidence: string[];
}

export interface CitationDeltaEntry {
  file: string;
  key: string;
  evidenceBacked: boolean;
}

export interface EvidenceRecheckEntry {
  evidenceId: string;
  stillFormal: boolean;
}

export interface RevisionValidationResult {
  schemaVersion: 1;
  /** 稳定 id：val-r{reviewRound}-rev{revision} */
  validationId: string;
  planId: string | null;
  projectId: string;
  reviewRound: number;
  /** 修订针对的 manuscript 修订（计划 sourceRevision；修订前快照） */
  sourceRevision: number;
  /** 修订写入后的 manuscript 修订 */
  revision: number;
  validatedAt: string;
  items: RevisionValidationItemResult[];
  /** rejected 条目的结构化报告（M9.10 Phase 4：失败可解释；UI / HITL payload 消费。旧产物无此字段） */
  rejectedItems?: RejectedItemReport[];
  factPreservation: FactPreservationSummary | null;
  citationPreservation: CitationPreservationSummary | null;
  claimStrength: ClaimStrengthFinding[];
  citationDelta: {
    added: CitationDeltaEntry[];
    removed: { file: string; key: string; authorized: boolean }[];
  };
  evidenceRecheck: EvidenceRecheckEntry[];
  /** 新增引用中无 verified evidence 支撑的 key（提示级，不自动拒绝） */
  uncoveredAddedKeys: string[];
  /** 全部条目 validated 且无 block 级 finding（未考虑用户决策） */
  ok: boolean;
  /** 需要人工决策（rejected > 0 或 block 级 claim finding > 0） */
  blocked: boolean;
  /** 用户在 hitl.revision_validation 的决策（approve / reject / needs_review） */
  userDecision?: { decision: "approve" | "reject" | "needs_review"; decidedAt: string };
}

/** 快照文件（与 FactTexFile 同构；只读投影） */
export interface ValidationTexFile {
  file: string;
  content: string;
}

export interface RevisionValidationInput {
  projectId: string;
  reviewRound: number;
  sourceRevision: number;
  revision: number;
  /** 消费的修订计划（apply 流程无 RevisionPlan → null，条目集为空但四类复核照跑） */
  plan: RevisionPlan | null;
  previousFiles: readonly ValidationTexFile[];
  currentFiles: readonly ValidationTexFile[];
  factPreservation: FactPreservationSummary | null;
  citationPreservation: CitationPreservationSummary | null;
  /** 证据库全量（Evidence Re-validation 的事实源） */
  evidenceRecords: readonly EvidenceRecord[];
  /** bib key → formal evidence id（新增引用 evidence-backed 判定；缺省退化为未覆盖） */
  evidenceLinks?: ReadonlyMap<string, string[]>;
  validatedAt?: string;
}

/**
 * 条目 section 引用是否指向该文件（文件级归因；口径与派发侧 sectionMatches 一致：
 * 路径 / 文件名 / stem / 包含；摘要引用归到组装根 main.tex——writeMainTex 会把
 * outline.abstract 组装进 main.tex，摘要改动在快照上体现为 main.tex 差异）。
 */
export function itemTouchesFile(sectionRef: string, file: string): boolean {
  const ref = sectionRef.trim().replaceAll("\\", "/").toLowerCase();
  if (ref === "" || ref === "(global)" || ref === "(unknown)") {
    return false;
  }
  const isAbstractRef = ref.includes("摘要") || ref.includes("abstract");
  const path = file.replaceAll("\\", "/").toLowerCase();
  if (path === "main.tex") {
    // 组装根只接受摘要类引用与显式 main.tex 引用
    return isAbstractRef || ref === "main.tex" || ref.endsWith("/main.tex");
  }
  if (isAbstractRef) {
    return false;
  }
  const fileName = path.split("/").pop() ?? path;
  const stem = fileName.replace(/\.tex$/, "");
  return (
    ref === path ||
    ref === fileName ||
    ref === stem ||
    ref.endsWith(`/${path}`) ||
    path.endsWith(ref) ||
    ref.includes(stem)
  );
}

/** 全部违规事实/引用 finding 涉及的文件集合（附机器可读原因码 + 归因类别 + 证据片段） */
function violationFiles(
  fact: FactPreservationSummary | null,
  citation: CitationPreservationSummary | null,
): { file: string; reason: string; code: RevisionItemResolutionReason; category: RevisionRejectionCategory; evidence: string }[] {
  const hits: {
    file: string;
    reason: string;
    code: RevisionItemResolutionReason;
    category: RevisionRejectionCategory;
    evidence: string;
  }[] = [];
  if (fact !== null && !fact.ok) {
    const findings = [
      ...fact.changedFacts,
      ...fact.removedFacts,
      ...fact.addedUnsupportedFacts,
      ...fact.directionalChanges,
      ...fact.formulaChanges,
      ...fact.placeholderRegressions,
    ];
    for (const finding of findings) {
      const evidence = `${finding.before}${finding.after !== "" ? ` → ${finding.after}` : "（被删除）"}`;
      hits.push({
        file: finding.file,
        reason: `${finding.reason}：${evidence}`,
        code: "fact_preservation_violation",
        category: "fact_preservation",
        evidence: `${finding.classification !== undefined ? `[${finding.classification.category}/${finding.classification.type}] ` : ""}${evidence}`,
      });
    }
  }
  if (citation !== null && !citation.ok) {
    for (const entry of citation.unexpectedRemoved) {
      for (const file of entry.files.length > 0 ? entry.files : ["(unknown)"]) {
        hits.push({
          file,
          reason: `引用 \cite{${entry.key}} 被无依据删除`,
          code: "citation_removal_unauthorized",
          category: "citation_removal_detected",
          evidence: `key ${entry.key}（previous 出现于 ${entry.files.join("、") || "?"}，current 已消失）`,
        });
      }
    }
  }
  return hits;
}

/** 核心复核（纯函数）：四类检查 + 条目归因 → 验证结果 */
export function evaluateRevisionValidation(input: RevisionValidationInput): RevisionValidationResult {
  const validatedAt = input.validatedAt ?? new Date().toISOString();
  const contentByFile = new Map<string, { before: string; after: string }>();
  for (const file of input.previousFiles) {
    contentByFile.set(file.file, { before: file.content, after: "" });
  }
  for (const file of input.currentFiles) {
    const existing = contentByFile.get(file.file);
    if (existing !== undefined) {
      existing.after = file.content;
    } else {
      contentByFile.set(file.file, { before: "", after: file.content });
    }
  }
  const changedFiles = [...contentByFile.entries()]
    .filter(([, contents]) => contents.before !== contents.after)
    .map(([file]) => file);

  const evidenceById = new Map(input.evidenceRecords.map((record) => [record.id, record]));
  const appliedItems = (input.plan?.items ?? []).filter((item) => item.status === "applied");

  // ---- 3. Claim Strength（逐改动文件；授权文本 = 触达该文件条目的指令） ----
  const claimStrength: ClaimStrengthFinding[] = [];
  for (const file of changedFiles) {
    const contents = contentByFile.get(file);
    if (contents === undefined) {
      continue;
    }
    const touchingItems = appliedItems.filter((item) => itemTouchesFile(item.section, file));
    const relatedEvidence = touchingItems.flatMap((item) =>
      (item.relatedEvidenceIds ?? []).flatMap((id) => {
        const record = evidenceById.get(id);
        return record !== undefined ? [record] : [];
      }),
    );
    claimStrength.push(
      ...checkClaimStrengthEscalation({
        file,
        before: contents.before,
        after: contents.after,
        relatedEvidence,
        authorizationTexts: touchingItems.flatMap((item) => [item.instruction, item.problem]),
      }),
    );
  }

  // ---- 2b. Citation delta（新增引用 evidence-backed；既有引用消失由 M5.6 归因） ----
  const added: CitationDeltaEntry[] = [];
  for (const file of changedFiles) {
    const contents = contentByFile.get(file);
    if (contents === undefined) {
      continue;
    }
    const beforeKeys = new Set(extractCitationKeys(contents.before));
    for (const key of extractCitationKeys(contents.after)) {
      if (!beforeKeys.has(key)) {
        added.push({
          file,
          key,
          evidenceBacked: (input.evidenceLinks?.get(key)?.length ?? 0) > 0,
        });
      }
    }
  }
  const removedByFile: { file: string; key: string; authorized: boolean }[] = [];
  const citationViolations = (input.citationPreservation?.unexpectedRemoved ?? []).flatMap((entry) =>
    entry.files.map((file) => ({ file, key: entry.key, authorized: false })),
  );
  removedByFile.push(...citationViolations);
  for (const file of changedFiles) {
    const contents = contentByFile.get(file);
    if (contents === undefined) {
      continue;
    }
    const afterKeys = new Set(extractCitationKeys(contents.after));
    for (const key of extractCitationKeys(contents.before)) {
      if (!afterKeys.has(key)) {
        // 是否已有 M5.6 归因（authorized=true 表示 citationPreservation 认可的删除）
        const alreadyRecorded = removedByFile.some((entry) => entry.file === file && entry.key === key);
        if (!alreadyRecorded) {
          removedByFile.push({ file, key, authorized: true });
        }
      }
    }
  }
  const uncoveredAddedKeys = [...new Set(added.filter((entry) => !entry.evidenceBacked).map((entry) => entry.key))];

  // ---- 4. Evidence Re-validation（applied 条目关联证据仍 formal？） ----
  const evidenceRecheck: EvidenceRecheckEntry[] = [];
  for (const id of new Set(appliedItems.flatMap((item) => item.relatedEvidenceIds ?? []))) {
    const record = evidenceById.get(id);
    evidenceRecheck.push({ evidenceId: id, stillFormal: record !== undefined && isFormalEvidence(record) });
  }

  // ---- 1/2/3 → 条目归因 ----
  const violations = violationFiles(input.factPreservation, input.citationPreservation);
  const blockFindings = claimStrength.filter((finding) => finding.action === "block");
  const warningFiles = new Set(claimStrength.filter((finding) => finding.action === "warning").map((finding) => finding.file));
  const staleEvidenceByItem = new Map<string, string[]>();
  for (const item of appliedItems) {
    const stale = (item.relatedEvidenceIds ?? []).filter((id) => {
      const entry = evidenceRecheck.find((candidate) => candidate.evidenceId === id);
      return entry === undefined || !entry.stillFormal;
    });
    if (stale.length > 0) {
      staleEvidenceByItem.set(item.id, stale);
    }
  }

  const items: RevisionValidationItemResult[] = appliedItems.map((item) => {
    const reasons: string[] = [];
    const reasonCodes: RevisionItemResolutionReason[] = [];
    const evidence: string[] = [];
    const categories: RevisionRejectionCategory[] = [];
    let status: RevisionValidationItemStatus = "validated";
    const settle = (
      next: RevisionValidationItemStatus,
      reason: string,
      code: RevisionItemResolutionReason,
      category: RevisionRejectionCategory,
      itemEvidence?: string,
    ) => {
      reasons.push(reason);
      reasonCodes.push(code);
      categories.push(category);
      if (itemEvidence !== undefined && evidence.length < 3) {
        evidence.push(itemEvidence);
      }
      // rejected > needs_review > validated
      if (next === "rejected" || (next === "needs_review" && status === "validated")) {
        status = next;
      }
    };
    // 修改前记录（§6）：条目触达文件的违规事实 / 引用
    for (const violation of violations) {
      if (itemTouchesFile(item.section, violation.file)) {
        settle("rejected", `${violation.file}：${violation.reason}`, violation.code, violation.category, violation.evidence);
      }
    }
    for (const finding of blockFindings) {
      if (itemTouchesFile(item.section, finding.file)) {
        settle(
          "rejected",
          `${finding.file}：claim 强度升级为强表述但证据不足（${finding.markers.join("/")}）`,
          "claim_strength_escalation",
          "claim_strength",
          `markers：${finding.markers.join("/")}（${finding.file}）`,
        );
      }
    }
    for (const file of warningFiles) {
      if (itemTouchesFile(item.section, file)) {
        settle(
          "needs_review",
          `${file}：claim 强度升级仅有部分证据支撑，需人工确认`,
          "claim_strength_escalation",
          "claim_strength",
        );
      }
    }
    const stale = staleEvidenceByItem.get(item.id);
    if (stale !== undefined) {
      settle(
        "needs_review",
        `关联证据 ${stale.join("、")} 已不存在或不再是正式证据（verified + 锚点）`,
        "evidence_stale",
        "evidence_stale",
        `失效证据：${stale.join("、")}`,
      );
    }
    // 说明：targetChanged=false（Writer 输出与原文逐字相同）不构成拒绝——
    // 「修改要求是否真正落实」由下一轮复审仲裁（同 finding 指纹再现 → 新计划
    // 重新派发，收敛判定照常生效）；本层只裁事实 / 引用 / 强度 / 证据四类
    // 确定性违规，不猜测 Writer 意图。targetChanged 原样留在条目上供审计。
    // 主归因类别（M9.10）：fact > citation > claim > evidence（拒绝力强的优先）
    const primaryCategory: RevisionRejectionCategory | null =
      categories.includes("fact_preservation")
        ? "fact_preservation"
        : categories.includes("citation_removal_detected")
          ? "citation_removal_detected"
          : categories.includes("claim_strength")
            ? "claim_strength"
            : categories.length > 0
              ? (categories[0] as RevisionRejectionCategory)
              : null;
    return {
      id: item.id,
      kind: item.kind,
      section: item.section,
      riskLevel: item.riskLevel,
      status,
      category: primaryCategory,
      reasonCodes,
      reasons,
    };
  });

  // M9.10 Phase 4：rejected 条目的结构化报告（id + category + reason + evidence）
  const evidenceById2 = new Map<string, string[]>();
  for (const violation of violations) {
    for (const applied of appliedItems) {
      if (itemTouchesFile(applied.section, violation.file)) {
        const list = evidenceById2.get(applied.id) ?? [];
        if (list.length < 3) {
          list.push(violation.evidence);
        }
        evidenceById2.set(applied.id, list);
      }
    }
  }
  for (const finding of blockFindings) {
    for (const applied of appliedItems) {
      if (itemTouchesFile(applied.section, finding.file)) {
        const list = evidenceById2.get(applied.id) ?? [];
        if (list.length < 3) {
          list.push(`markers：${finding.markers.join("/")}（${finding.file}）`);
        }
        evidenceById2.set(applied.id, list);
      }
    }
  }
  for (const [id, stale] of staleEvidenceByItem) {
    const list = evidenceById2.get(id) ?? [];
    if (list.length < 3) {
      list.push(`失效证据：${stale.join("、")}`);
    }
    evidenceById2.set(id, list);
  }
  const rejectedItems: RejectedItemReport[] = items
    .filter((item) => item.status === "rejected")
    .map((item) => ({
      id: item.id,
      category: item.category ?? "fact_preservation",
      reason: item.reasons.join("；").slice(0, 400),
      evidence: (evidenceById2.get(item.id) ?? []).slice(0, 3),
    }));

  const rejected = items.filter((item) => item.status === "rejected").length;
  const needsReview = items.filter((item) => item.status === "needs_review").length;
  const blocked = rejected > 0 || blockFindings.length > 0;
  return {
    schemaVersion: 1,
    validationId: `val-r${input.reviewRound}-rev${input.revision}`,
    planId: input.plan?.planId ?? null,
    projectId: input.projectId,
    reviewRound: input.reviewRound,
    sourceRevision: input.sourceRevision,
    revision: input.revision,
    validatedAt,
    items,
    rejectedItems,
    factPreservation: input.factPreservation,
    citationPreservation: input.citationPreservation,
    claimStrength,
    citationDelta: { added, removed: removedByFile },
    evidenceRecheck,
    uncoveredAddedKeys,
    ok: !blocked && needsReview === 0,
    blocked,
  };
}

/** 用户决策落定（纯函数：只补 userDecision；条目终态由调用方经状态机写回计划） */
export function withUserDecision(
  result: RevisionValidationResult,
  decision: "approve" | "reject" | "needs_review",
  decidedAt: string,
): RevisionValidationResult {
  return { ...result, userDecision: { decision, decidedAt } };
}

export function describeRevisionValidation(result: RevisionValidationResult): string {
  const counts = countItemStatuses(result);
  const rejectedByCategory = new Map<RevisionRejectionCategory, number>();
  for (const report of result.rejectedItems ?? []) {
    rejectedByCategory.set(report.category, (rejectedByCategory.get(report.category) ?? 0) + 1);
  }
  const breakdown =
    rejectedByCategory.size > 0
      ? `（${[...rejectedByCategory].map(([category, count]) => `${category}=${count}`).join("/")}）`
      : "";
  const parts = [
    `条目 validated=${counts.validated} rejected=${counts.rejected}${breakdown} needs_review=${counts.needsReview}`,
    `claim 强度 finding ${result.claimStrength.length} 处`,
    `新增引用 ${result.citationDelta.added.length}（无证据支撑 ${result.uncoveredAddedKeys.length}）`,
  ];
  if (result.userDecision !== undefined) {
    parts.push(`用户决策 ${result.userDecision.decision}`);
  }
  return parts.join("；");
}

export function countItemStatuses(result: RevisionValidationResult): {
  validated: number;
  rejected: number;
  needsReview: number;
} {
  return {
    validated: result.items.filter((item) => item.status === "validated").length,
    rejected: result.items.filter((item) => item.status === "rejected").length,
    needsReview: result.items.filter((item) => item.status === "needs_review").length,
  };
}
