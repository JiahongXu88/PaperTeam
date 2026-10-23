/**
 * M15.2 Severity / Verification / Impact / Task Scope 四轴裁决（确定性、shadow）。
 *
 * 旧口径把一条 finding 的「是否已核实」「有多严重」「是否阻断」「属于哪次修订的责任」压在 severity + blocking 两个字段里，
 * 且全部由审稿模型自报——「模型写了 critical」就会被当成已核实的阻断错误。本模块对每个根因（rootCause）分别给出四轴：
 *
 *  1. verification：VERIFIED_BY_CERTIFICATE（关联论断有 claim-certificate 证书的矛盾）/ REVIEWER_GROUNDED_SUSPICION（引文在被审原文中定位、
 *     审稿人有依据的怀疑，含派生量复算不一致但解释不唯一）/ AUTHOR_CHECK_REQUIRED / EXTERNAL_DATA_REQUIRED / INPUT_PARSE_UNRELIABLE（转写稿上的
 *     公式 / 字符损坏，无原页可回看）/ DOCUMENT_CONTEXT_CONTRADICTS（定向复核给出逐字依据：别处已给出被断言缺失的内容）/ NOT_EVALUATED；
 *  2. severity：保留模型观察值，另给结构化裁决值与规则码（只有确定性规则能改动；不因「没找到证据」改动。
 *     M15.2.1（N03）：核验等级 ≠ 严重度——缺证书 / 需作者核对 / 需外部数据只记为未核验（verification 轴），
 *     不机械下调观察到的 Critical；严重度只允许确定性上调（证书证实的核心矛盾）与有反证 / 可证转写损坏的下调）；
 *  3. impact：是否触及核心结论（摘要 / 结论 / 核心结果论断），blocking 只在「证书级核实 + 触及核心结论」时为 true；
 *  4. taskScope：只读评估 = NOT_APPLICABLE_READ_ONLY；返修工作流按生产已有的 finding 归层（classifyFindingOrigins）+ 用户意见章节确定。
 *
 * 根因：同一核心数值矛盾的多处 finding（摘要 / 表格 / 结论）经关联论断的 rootCauseId 合并；没有论断关联时，引文区间重叠、类别族相同且
 * 数值 token 不冲突的 finding 合并——不用词面相似度。
 *
 * 全部为 shadow：不改 summary.issues、生产计数、Gate、Revision Task Complete / Publication Readiness。
 */

import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { FindingOriginEntry } from "../quality/revisionTaskGate.js";
import type { SourceVerification } from "./reviewContextSnapshot.js";
import type { ClaimAuditArtifact, ReviewClaimRecord } from "./claimAudit.js";
import type { FindingAuditRecord } from "./findingAudit.js";
import type { FindingRecheckRecord } from "./findingVerification.js";
import { compactText, locateQuote, sha256Text } from "./claimAuditText.js";

export const FINDING_ADJUDICATION_SCHEMA = "paperteam.finding-adjudication/v1";
export const FINDING_ADJUDICATION_RULES = "finding-adjudication-rules/v2";

export type VerificationAxis =
  | "VERIFIED_BY_CERTIFICATE"
  | "REVIEWER_GROUNDED_SUSPICION"
  | "AUTHOR_CHECK_REQUIRED"
  | "EXTERNAL_DATA_REQUIRED"
  | "INPUT_PARSE_UNRELIABLE"
  | "DOCUMENT_CONTEXT_CONTRADICTS"
  | "NOT_EVALUATED"
  | "NOT_APPLICABLE_STYLE";

export type TaskScopeAxis = "REVISION_INTRODUCED" | "BASELINE_EXISTING" | "USER_SPECIFIED_SCOPE" | "OUT_OF_WORKFLOW_DISCOVERY" | "UNDETERMINED" | "NOT_APPLICABLE_READ_ONLY";

export type SeverityRule =
  | "PARSE_UNRELIABLE_CAPPED_AT_MINOR"
  | "DOCUMENT_CONTEXT_CONTRADICTS_WITHDRAWAL_CANDIDATE"
  | "CERTIFIED_CORE_CONTRADICTION_AT_LEAST_MAJOR"
  | "NO_CHANGE";

export interface AdjudicatedRootCause {
  rootCauseId: string;
  findings: Array<{ findingId: string; issueIndex: number; section: string; category: string; severityObserved: string; blockingObserved: boolean; quoteLocated: boolean }>;
  claimRootCauseIds: string[];
  linkedClaimIds: string[];
  verification: {
    axis: VerificationAxis;
    basis: string[];
    certificateInputs: string[];
  };
  severity: {
    observed: "critical" | "major" | "minor";
    adjudicated: "critical" | "major" | "minor";
    changed: boolean;
    rules: SeverityRule[];
    rationale: string;
  };
  impact: {
    coreClaimAffected: boolean;
    coreLocations: string[];
    blocking: boolean;
    pauseRecommended: boolean;
    rationale: string;
  };
  taskScope: { axis: TaskScopeAxis; basis: string };
}

export interface FindingAdjudicationArtifact {
  schema: typeof FINDING_ADJUDICATION_SCHEMA;
  rules: typeof FINDING_ADJUDICATION_RULES;
  mode: "SHADOW_ONLY";
  round: number;
  sourceRevision: number | null;
  documentFingerprint: string;
  claimAuditValidation: string;
  policy: "quick_review" | "revision_task" | "autonomous_improvement";
  rootCauses: AdjudicatedRootCause[];
  summary: {
    findings: number;
    rootCauses: number;
    criticalMajorFindingsObserved: number;
    criticalMajorRootCausesObserved: number;
    criticalMajorRootCausesAdjudicated: number;
    byVerification: Record<VerificationAxis, number>;
    byTaskScope: Record<TaskScopeAxis, number>;
    severityChanges: Record<SeverityRule, number>;
    blocking: number;
    pauseRecommended: number;
  };
  notes: string[];
}

const RANK: Record<string, number> = { minor: 1, major: 2, critical: 3 };
const BY_RANK = ["minor", "minor", "major", "critical"] as const;
const CORE_HEADING = /^(?:frontmatter|前置内容|摘要与前置部分|摘\s*要|Abstract|\d*\s*结论|总结|结论与展望|\d*\s*Conclusions?(?: and Future Work)?|Summary)$/i;
const FAMILY: Record<string, string> = { fact: "substantive", academic: "substantive", evidence_gap: "substantive", citation: "citation", style: "style", build: "build" };

function numberTokens(text: string): Set<string> {
  return new Set([...(text.normalize("NFKC").matchAll(/(?<![A-Za-z0-9_.])\d+(?:\.\d+)?(?![A-Za-z0-9_])/g))].map((match) => match[0]));
}

interface LocatedFinding {
  issueIndex: number;
  issue: ReviewIssue;
  record: FindingAuditRecord | undefined;
  span: { file: string; start: number; end: number } | null;
}

function locateFinding(files: ReadonlyArray<{ file: string; content: string }>, issue: ReviewIssue): { file: string; start: number; end: number } | null {
  if (issue.quote === undefined || compactText(issue.quote).length < 12) return null;
  for (const file of files) {
    if (issue.file !== undefined && file.file !== issue.file) continue;
    const span = locateQuote(file.content, issue.quote, 12);
    if (span !== null) return { file: file.file, start: span.start, end: span.end };
  }
  return null;
}

function claimSpans(claim: ReviewClaimRecord): Array<{ file: string; start: number; end: number }> {
  const spans: Array<{ file: string; start: number; end: number }> = [];
  if (claim.location.start !== null && claim.location.end !== null) spans.push({ file: claim.location.file, start: claim.location.start, end: claim.location.end });
  if (claim.counterpart?.location?.start !== undefined && claim.counterpart.location.start !== null && claim.counterpart.location.end !== null) spans.push({ file: claim.counterpart.location.file, start: claim.counterpart.location.start, end: claim.counterpart.location.end });
  for (const atom of [claim.certificate?.claimAtom, claim.certificate?.counterpartAtom]) if (atom !== null && atom !== undefined) spans.push({ file: atom.file, start: atom.start, end: atom.end });
  return spans;
}

const overlaps = (a: { file: string; start: number; end: number }, b: { file: string; start: number; end: number }) => a.file === b.file && a.start < b.end && b.start < a.end;

export interface AdjudicationInput {
  round: number;
  sourceRevision: number | null;
  documentFingerprint: string;
  policy: FindingAdjudicationArtifact["policy"];
  issues: readonly ReviewIssue[];
  files: ReadonlyArray<{ file: string; content: string }>;
  claimAudit: ClaimAuditArtifact | null;
  claimAuditValidation: "VALID" | "STALE" | "MALFORMED" | "ABSENT";
  findingRecheck: readonly FindingRecheckRecord[];
  sourceVerification: SourceVerification;
  /** 返修工作流：生产已有的 heavy finding 归层（classifyFindingOrigins）；只读评估缺省 */
  findingOrigins?: readonly FindingOriginEntry[];
  /** 用户外审意见限定的章节（manuscript 内相对路径 / 章节名） */
  instructionSections?: readonly string[];
  findingFingerprint?: (issue: ReviewIssue) => string;
}

export function adjudicateFindings(input: AdjudicationInput): FindingAdjudicationArtifact {
  const claimsValid = input.claimAudit !== null && input.claimAuditValidation === "VALID";
  const claims = claimsValid ? input.claimAudit!.claims : [];
  const auditRecords = claimsValid ? input.claimAudit!.findingAudit?.records ?? [] : [];
  const recheckByIndex = new Map(input.findingRecheck.map((record) => [record.issueIndex, record]));
  const located: LocatedFinding[] = input.issues.map((issue, issueIndex) => ({
    issueIndex, issue, record: auditRecords.find((record) => record.issueIndex === issueIndex), span: locateFinding(input.files, issue),
  }));
  // 根因：finding ↔ 论断（引文区间与论断 / 证书原子区间重叠）；论断根因相同 → 同一根因
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let node = key;
    while ((parent.get(node) ?? node) !== node) node = parent.get(node)!;
    return node;
  };
  const union = (a: string, b: string) => {
    for (const key of [a, b]) if (!parent.has(key)) parent.set(key, key);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const linkedClaims = new Map<number, ReviewClaimRecord[]>();
  for (const finding of located) {
    const key = `f:${finding.issueIndex}`;
    parent.set(key, parent.get(key) ?? key);
    if (finding.span === null) continue;
    const family = FAMILY[finding.issue.category] ?? "other";
    if (family !== "substantive" && family !== "citation") continue;
    for (const claim of claims) {
      if (claim.verificationStatus !== "VERIFIED_CONTRADICTED" && claim.verificationStatus !== "REVIEWER_SUSPECTED") continue;
      if (claimSpans(claim).some((span) => overlaps(span, finding.span!))) {
        linkedClaims.set(finding.issueIndex, [...(linkedClaims.get(finding.issueIndex) ?? []), claim]);
        union(key, `c:${claim.rootCauseId ?? claim.claimId}`);
      }
    }
  }
  // 无论断关联：引文区间重叠 + 类别族相同 + 数值 token 不冲突
  for (let a = 0; a < located.length; a += 1) {
    for (let b = a + 1; b < located.length; b += 1) {
      const x = located[a]!;
      const y = located[b]!;
      if (x.span === null || y.span === null || !overlaps(x.span, y.span)) continue;
      if ((FAMILY[x.issue.category] ?? "other") !== (FAMILY[y.issue.category] ?? "other")) continue;
      const nx = numberTokens(x.issue.description);
      const ny = numberTokens(y.issue.description);
      if (nx.size > 0 && ny.size > 0 && ![...nx].some((token) => ny.has(token))) continue;
      union(`f:${x.issueIndex}`, `f:${y.issueIndex}`);
    }
  }
  const groups = new Map<string, LocatedFinding[]>();
  for (const finding of located) {
    const root = find(`f:${finding.issueIndex}`);
    groups.set(root, [...(groups.get(root) ?? []), finding]);
  }
  const fingerprint = input.findingFingerprint;
  const origins = new Map((input.findingOrigins ?? []).map((entry) => [entry.fingerprint, entry]));
  const instructionSections = (input.instructionSections ?? []).map((section) => section.replace(/\s+/g, "").toLowerCase()).filter((section) => section !== "");
  const transcription = input.sourceVerification !== "AUTHOR_SOURCE" && input.sourceVerification !== "SOURCE_ATTESTED";
  const rootCauses: AdjudicatedRootCause[] = [];
  for (const members of groups.values()) {
    const groupClaims = [...new Map(members.flatMap((member) => linkedClaims.get(member.issueIndex) ?? []).map((claim) => [claim.claimId, claim])).values()];
    const observedRank = Math.max(...members.map((member) => RANK[member.issue.severity] ?? 1));
    const observed = BY_RANK[observedRank]!;
    const family = FAMILY[members[0]!.issue.category] ?? "other";
    const rechecks = members.map((member) => recheckByIndex.get(member.issueIndex)).filter((record): record is FindingRecheckRecord => record !== undefined);
    const declared = members.map((member) => member.issue.verification).filter((value): value is NonNullable<ReviewIssue["verification"]> => value !== undefined);
    const auditStatuses = members.map((member) => member.record?.auditStatus).filter((value): value is NonNullable<typeof value> => value !== undefined);
    const basis: string[] = [];
    let axis: VerificationAxis;
    const certified = groupClaims.filter((claim) => claim.verificationStatus === "VERIFIED_CONTRADICTED");
    if (family === "style") {
      axis = "NOT_APPLICABLE_STYLE";
      basis.push("写作 / 风格类：独立质量维度，不做科学事实核验");
    } else if (certified.length > 0) {
      axis = "VERIFIED_BY_CERTIFICATE";
      basis.push(`关联论断 ${certified.map((claim) => claim.claimId).join(", ")} 有 ${certified[0]!.certificate?.version ?? "certificate"} 证书的矛盾`);
    } else if (rechecks.length > 0 && rechecks.every((record) => record.outcome === "REFUTED_BY_DOCUMENT_CONTEXT")) {
      // M15.2.1（P1）：撤回候选要求根因内每条被复核的 finding 都是整条 REFUTED——部分反驳 / 未定 / 失败的成员在 → 不整组撤回
      axis = "DOCUMENT_CONTEXT_CONTRADICTS";
      basis.push("定向复核：其他章节的逐字依据给出了被断言缺失的内容（模型提出、引文与术语确定性校验；复合意见须逐子断言全覆盖）");
    } else if (transcription && (auditStatuses.includes("PARSE_ARTIFACT_SUSPECTED") || rechecks.some((record) => record.outcome === "UNRESOLVABLE_NO_PAGE_PROVENANCE"))) {
      axis = "INPUT_PARSE_UNRELIABLE";
      basis.push("转写稿上的公式 / 字符 / 表格损坏类：没有页面级原件可回看，不能确认为作者原稿错误");
    } else if (auditStatuses.length > 0 && auditStatuses.every((status) => status === "QUOTE_NOT_LOCATED" || status === "NO_QUOTE")) {
      axis = "NOT_EVALUATED";
      basis.push("finding 引文无法在被审修订中逐字定位：无法落地核对");
    } else if (auditStatuses.includes("CONTEXT_INCOMPLETE") && !rechecks.some((record) => record.outcome === "CONFIRMED_WITH_DOCUMENT_CONTEXT" || record.outcome === "PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT")) {
      axis = "NOT_EVALUATED";
      basis.push(`单元视角的缺失 / 跨章断言未被全文材料确认（复核：${rechecks.map((record) => record.outcome).join(", ") || "未复核"}）——保持原 finding，不降级`);
    } else if (declared.length > 0 && declared.every((value) => value === "EXTERNAL_DATA_REQUIRED")) {
      axis = "EXTERNAL_DATA_REQUIRED";
      basis.push("审稿人声明需外部数据");
    } else if (declared.length > 0 && declared.every((value) => value !== "VERIFIED_IN_TEXT")) {
      axis = "AUTHOR_CHECK_REQUIRED";
      basis.push("审稿人声明需作者核对 / 说明");
    } else if (members.some((member) => member.span !== null)) {
      axis = "REVIEWER_GROUNDED_SUSPICION";
      basis.push("引文在被审原文中逐字定位；判断来自审稿模型，没有确定性证书");
      if (rechecks.some((record) => record.outcome === "PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT")) basis.push("定向复核：意见的一部分已在其他章节给出（逐字依据），其余部分仍成立——保留原严重度");
      if (rechecks.some((record) => record.outcome === "CONFIRMED_WITH_DOCUMENT_CONTEXT")) basis.push("定向复核：其他章节的逐字依据支持该意见（模型判断）");
      const discrepancy = groupClaims.find((claim) => claim.certificate?.derived?.allInterpretationsDisagree === true);
      if (discrepancy !== undefined) basis.push(`派生量复算：所有可接受解释都与论断值不相容（解释不唯一，未出证书；论断 ${discrepancy.claimId}）`);
    } else {
      axis = "NOT_EVALUATED";
      basis.push("没有可定位依据");
    }
    // severity 规则
    const rules: SeverityRule[] = [];
    let adjudicatedRank = observedRank;
    const coreLocations = [...new Set([
      ...members.filter((member) => member.record?.unitId !== undefined && member.record.unitId !== null && (/::frontmatter/.test(member.record.unitId) || CORE_HEADING.test(member.issue.section))).map((member) => member.issue.section),
      ...groupClaims.filter((claim) => /::frontmatter/.test(claim.unitId) || CORE_HEADING.test(claim.heading)).map((claim) => claim.heading),
    ])];
    const coreClaimAffected = coreLocations.length > 0 || groupClaims.some((claim) => claim.claimType === "conclusion");
    if (axis === "DOCUMENT_CONTEXT_CONTRADICTS") {
      adjudicatedRank = 1;
      rules.push("DOCUMENT_CONTEXT_CONTRADICTS_WITHDRAWAL_CANDIDATE");
    } else if (axis === "INPUT_PARSE_UNRELIABLE") {
      if (adjudicatedRank > 1) rules.push("PARSE_UNRELIABLE_CAPPED_AT_MINOR");
      adjudicatedRank = 1;
    } else {
      // M15.2.1（N03）：核验等级 ≠ 严重度。缺证书 / 需作者核对 / 需外部数据只是「未核验」（记录在 verification 轴），
      // 不是反证：不得机械下调观察到的 Critical（N03-V01 曾被 CRITICAL_REQUIRES_VERIFICATION 压成 major，掩盖真实缺陷）。
      // 严重度只允许两类确定性改动：证书证实的核心矛盾上调（≥ major），反证 / 可证转写损坏下调（见上面两个分支）。
      if (axis === "VERIFIED_BY_CERTIFICATE" && coreClaimAffected && adjudicatedRank < 2) {
        adjudicatedRank = 2;
        rules.push("CERTIFIED_CORE_CONTRADICTION_AT_LEAST_MAJOR");
      }
    }
    if (rules.length === 0) rules.push("NO_CHANGE");
    const adjudicated = BY_RANK[adjudicatedRank]!;
    const blocking = axis === "VERIFIED_BY_CERTIFICATE" && coreClaimAffected;
    const pauseRecommended = !blocking && adjudicatedRank >= 2 && coreClaimAffected && (axis === "REVIEWER_GROUNDED_SUSPICION" || axis === "AUTHOR_CHECK_REQUIRED");
    // taskScope
    let scope: AdjudicatedRootCause["taskScope"];
    if (input.policy === "quick_review") {
      scope = { axis: "NOT_APPLICABLE_READ_ONLY", basis: "只读评估：没有修订任务" };
    } else {
      const memberOrigins = fingerprint === undefined ? [] : members.map((member) => origins.get(fingerprint(member.issue))).filter((entry): entry is FindingOriginEntry => entry !== undefined);
      const inInstruction = members.some((member) => {
        const section = `${member.issue.file ?? ""}${member.issue.section}`.replace(/\s+/g, "").toLowerCase();
        return instructionSections.some((target) => section.includes(target) || target.includes(member.issue.section.replace(/\s+/g, "").toLowerCase()));
      });
      if (memberOrigins.some((entry) => entry.origin === "revision_introduced")) scope = { axis: "REVISION_INTRODUCED", basis: "生产 finding 归层：revision_introduced（修订引入，照旧由生产守卫阻断）" };
      else if (inInstruction) scope = { axis: "USER_SPECIFIED_SCOPE", basis: "finding 位于用户外审意见指定的章节" };
      else if (memberOrigins.length > 0 && memberOrigins.every((entry) => entry.origin === "baseline_inherited")) scope = { axis: "BASELINE_EXISTING", basis: "生产 finding 归层：baseline_inherited（原稿既有：投稿准备度提示，不扩充本轮返修计划）" };
      else if (memberOrigins.some((entry) => entry.origin === "modified_existing")) scope = { axis: "UNDETERMINED", basis: "finding 位于本轮修改区间，但不能确定是修订引入还是原稿既有" };
      else if (memberOrigins.length === 0 && input.policy === "autonomous_improvement") scope = { axis: "OUT_OF_WORKFLOW_DISCOVERY", basis: "自主改进轮的新发现（未归层）" };
      else scope = { axis: "UNDETERMINED", basis: memberOrigins.length === 0 ? "没有生产 finding 归层（轻量 finding 不归层 / 非返修工作流）" : "归层为 unknown_origin" };
    }
    const memberIds = members.map((member) => member.record?.findingId ?? `i${member.issueIndex}`);
    rootCauses.push({
      rootCauseId: `rf1-${sha256Text([...memberIds].sort().join("|")).slice(0, 12)}`,
      findings: members.map((member) => ({
        findingId: member.record?.findingId ?? `i${member.issueIndex}`, issueIndex: member.issueIndex, section: member.issue.section, category: member.issue.category,
        severityObserved: member.issue.severity, blockingObserved: member.issue.blocking, quoteLocated: member.span !== null,
      })),
      claimRootCauseIds: [...new Set(groupClaims.map((claim) => claim.rootCauseId).filter((value): value is string => value !== undefined))],
      linkedClaimIds: groupClaims.map((claim) => claim.claimId),
      verification: { axis, basis, certificateInputs: certified.map((claim) => claim.certificate?.inputsSha256).filter((value): value is string => value !== undefined) },
      severity: {
        observed, adjudicated, changed: adjudicated !== observed, rules,
        rationale: rules[0] === "NO_CHANGE" ? "确定性规则未触发：保留审稿模型的严重度" : rules.join(" / "),
      },
      impact: {
        coreClaimAffected, coreLocations, blocking, pauseRecommended,
        rationale: blocking
          ? "证书级核实的矛盾触及摘要 / 结论 / 核心结果：澄清前不应依赖该结论"
          : pauseRecommended
            ? "有依据的怀疑触及核心结论但未经确定性核实：建议作者核对后再依赖"
            : coreClaimAffected ? "触及核心结论位置，但核验等级不足以阻断" : "不触及摘要 / 结论 / 核心结果论断",
      },
      taskScope: scope,
    });
  }
  rootCauses.sort((a, b) => Math.min(...a.findings.map((f) => f.issueIndex)) - Math.min(...b.findings.map((f) => f.issueIndex)));
  const emptyAxis = (): Record<VerificationAxis, number> => ({ VERIFIED_BY_CERTIFICATE: 0, REVIEWER_GROUNDED_SUSPICION: 0, AUTHOR_CHECK_REQUIRED: 0, EXTERNAL_DATA_REQUIRED: 0, INPUT_PARSE_UNRELIABLE: 0, DOCUMENT_CONTEXT_CONTRADICTS: 0, NOT_EVALUATED: 0, NOT_APPLICABLE_STYLE: 0 });
  const byVerification = emptyAxis();
  const byTaskScope: Record<TaskScopeAxis, number> = { REVISION_INTRODUCED: 0, BASELINE_EXISTING: 0, USER_SPECIFIED_SCOPE: 0, OUT_OF_WORKFLOW_DISCOVERY: 0, UNDETERMINED: 0, NOT_APPLICABLE_READ_ONLY: 0 };
  const severityChanges: Record<SeverityRule, number> = { PARSE_UNRELIABLE_CAPPED_AT_MINOR: 0, DOCUMENT_CONTEXT_CONTRADICTS_WITHDRAWAL_CANDIDATE: 0, CERTIFIED_CORE_CONTRADICTION_AT_LEAST_MAJOR: 0, NO_CHANGE: 0 };
  for (const cause of rootCauses) {
    byVerification[cause.verification.axis] += 1;
    byTaskScope[cause.taskScope.axis] += 1;
    for (const rule of cause.severity.rules) severityChanges[rule] += 1;
  }
  const notes: string[] = [
    "shadow：不改 summary.issues、生产计数、Gate、Revision Task Complete / Publication Readiness",
    "severity.adjudicated 只由确定性规则改动；DOCUMENT_CONTEXT_CONTRADICTS 是撤回候选（模型提出 + 引文校验），不是已删除",
    "M15.2.1（N03）：核验等级与严重度解耦——未核验（无证书 / 需作者核对 / 需外部数据）不下调观察严重度，核验状态见 verification 轴",
  ];
  if (!claimsValid) notes.push(`论断账本 ${input.claimAuditValidation}：不使用论断证书（全部按无证书裁决）`);
  return {
    schema: FINDING_ADJUDICATION_SCHEMA,
    rules: FINDING_ADJUDICATION_RULES,
    mode: "SHADOW_ONLY",
    round: input.round,
    sourceRevision: input.sourceRevision,
    documentFingerprint: input.documentFingerprint,
    claimAuditValidation: input.claimAuditValidation,
    policy: input.policy,
    rootCauses,
    summary: {
      findings: input.issues.length,
      rootCauses: rootCauses.length,
      criticalMajorFindingsObserved: input.issues.filter((issue) => issue.severity === "critical" || issue.severity === "major").length,
      criticalMajorRootCausesObserved: rootCauses.filter((cause) => RANK[cause.severity.observed]! >= 2).length,
      criticalMajorRootCausesAdjudicated: rootCauses.filter((cause) => RANK[cause.severity.adjudicated]! >= 2).length,
      byVerification, byTaskScope, severityChanges,
      blocking: rootCauses.filter((cause) => cause.impact.blocking).length,
      pauseRecommended: rootCauses.filter((cause) => cause.impact.pauseRecommended).length,
    },
    notes,
  };
}

export interface AdjudicationValidation {
  status: "VALID" | "STALE" | "MALFORMED";
  reasons: string[];
}

/** 读取方校验 + 内部一致性契约（blocking ⇒ 证书；上调 ⇒ 证书证实核心矛盾；下调 ⇒ 反证或可证转写损坏；撤回候选 ⇒ minor） */
export function validateFindingAdjudication(artifact: unknown, expected: { sourceRevision: number | null; documentFingerprint: string }): AdjudicationValidation {
  if (typeof artifact !== "object" || artifact === null) return { status: "MALFORMED", reasons: ["不是对象"] };
  const record = artifact as Partial<FindingAdjudicationArtifact>;
  if (record.schema !== FINDING_ADJUDICATION_SCHEMA || !Array.isArray(record.rootCauses)) return { status: "MALFORMED", reasons: ["schema 不符或缺 rootCauses"] };
  const reasons: string[] = [];
  for (const cause of record.rootCauses) {
    if (cause.impact.blocking && cause.verification.axis !== "VERIFIED_BY_CERTIFICATE") reasons.push(`${cause.rootCauseId}: blocking 但未经证书核实`);
    const observedRank = RANK[cause.severity.observed] ?? -1;
    const adjudicatedRank = RANK[cause.severity.adjudicated] ?? -1;
    // M15.2.1（N03）：未核验不是降级理由——critical 裁决允许出现在任何核验轴（保留观察严重度）；
    // 上调只许经证书，下调只许有反证（文档语境）或可证转写损坏
    if (observedRank < 0 || adjudicatedRank < 0) reasons.push(`${cause.rootCauseId}: severity 值不合法`);
    else if (adjudicatedRank > observedRank && !(cause.severity.rules ?? []).includes("CERTIFIED_CORE_CONTRADICTION_AT_LEAST_MAJOR")) reasons.push(`${cause.rootCauseId}: 严重度上调须经证书证实的核心矛盾`);
    else if (adjudicatedRank < observedRank && !(cause.severity.rules ?? []).some((rule) => rule === "DOCUMENT_CONTEXT_CONTRADICTS_WITHDRAWAL_CANDIDATE" || rule === "PARSE_UNRELIABLE_CAPPED_AT_MINOR")) reasons.push(`${cause.rootCauseId}: 严重度下调须有反证或可证转写损坏`);
    if (cause.verification.axis === "DOCUMENT_CONTEXT_CONTRADICTS" && cause.severity.adjudicated !== "minor") reasons.push(`${cause.rootCauseId}: 撤回候选未降为 minor`);
    if (cause.findings.length === 0) reasons.push(`${cause.rootCauseId}: 空根因`);
  }
  if (reasons.length > 0) return { status: "MALFORMED", reasons };
  if (record.sourceRevision !== expected.sourceRevision) reasons.push(`裁决修订 ${String(record.sourceRevision)} ≠ 被审修订 ${String(expected.sourceRevision)}`);
  if (record.documentFingerprint !== expected.documentFingerprint) reasons.push("裁决文档指纹与本轮覆盖快照不一致");
  return { status: reasons.length === 0 ? "VALID" : "STALE", reasons };
}
