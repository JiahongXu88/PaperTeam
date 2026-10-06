/**
 * Claim Gap Audit（M10.3.1 G2 §12-§14：unsupported claims 的 task-aware
 * 适用性审计，确定性、无 LLM）。
 *
 * M10.3 最终 gate 的 9 条 UNSUPPORTED claim 中 8 条是冻结原稿的既有声明
 * （摘要的 BDD100K / RDK X3 / 基线对比 / RTX 4090 环境等）——existing
 * paper revision 不引入也不改写它们，不应作为「新 claim」阻断 Final；
 * 1 条（HARM IDSW 116→125）是修订新增，但其数值有 user_confirmed 作者
 * 实验证据（jsonPath 溯源）——作者自己的实验结果不需要外部文献重证。
 *
 * 分类口径（任务 §12，机器可读）：
 * - excluded_pre_existing（E）：claim 的数值 / 措辞与冻结基线逐项重合 →
 *   原论文既有内容；返修语境不重证，交作者裁决（修订引入的改写除外）；
 * - excluded_author_data（A）：claim 数值由 user_confirmed 作者实验证据
 *   覆盖（数值 ⊆ 证据文本）→ 已有 Evidence 只是未关联（作者数据层）；
 * - revision_introduced：其余 → 修订引入的无支撑 claim，仍按原规则阻断。
 *
 * 同时给出 issue 归因：fact / evidence_gap 类 critical / major / blocking
 * issue 若可归因到被排除的 claim（章节匹配 + 描述词面重合），则不计入
 * Final 阻断口径（Quality Gate 规则 4/5/6 消费）——否则修订循环会反复
 * 派发这些作者级问题直到 stalled。
 *
 * 诚实边界：这是适用性归层，不是判 claim 为真——被排除的 claim 在审计
 * 产物中逐条留档（含依据），最终裁决属于作者。
 */

import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { findingFingerprint } from "./revisionPlan.js";
import { isUnsupportedVerdict, type ClaimGroundingEntry } from "./claimGrounding.js";
import { normalizeNumericToken } from "../quality/factPreservation.js";
import { tokenizeText } from "../retrieval/tokenize.js";

export type ClaimApplicability = "excluded_pre_existing" | "excluded_author_data" | "revision_introduced";

export interface ClaimGapClassification {
  claimId: string;
  section: string;
  claim: string;
  verdict: string;
  applicability: ClaimApplicability;
  /** 机器可读依据（数值全命中冻结基线 / 词面重合 / 证据 id 清单） */
  basis: string;
  /** excluded_author_data 命中的作者证据 id */
  evidenceIds?: string[];
}

export interface IssueAttribution {
  /** findingFingerprint（与修订计划条目 id 同源） */
  fingerprint: string;
  category: string;
  severity: string;
  blocking: boolean;
  excluded: boolean;
  /** 归因到的 claimId（excluded 时） */
  claimId?: string;
}

export interface ClaimGapAudit {
  schemaVersion: 1;
  reportId: string;
  projectId: string;
  round: number;
  generatedAt: string;
  taskKind: "existing_paper_improvement";
  /** 冻结基线修订号（claims 的 pre-existing 判定事实源） */
  baselineRevision: number;
  claims: ClaimGapClassification[];
  issueAttribution: IssueAttribution[];
  counts: {
    unsupportedTotal: number;
    excludedPreExisting: number;
    excludedAuthorData: number;
    revisionIntroduced: number;
    /** 归因排除后的 issue 口径（规则 4/5/6 消费） */
    issues: {
      critical: number;
      major: number;
      blocking: number;
      excludedCritical: number;
      excludedMajor: number;
      excludedBlocking: number;
    };
  };
}

export interface ClaimGapAuditInput {
  projectId: string;
  round: number;
  baselineRevision: number;
  /** 本轮 claim grounding 的 unsupported / contradicted 条目 */
  unsupportedClaims: readonly ClaimGroundingEntry[];
  /** 本轮审稿汇总 issues（归因对象） */
  issues: readonly ReviewIssue[];
  /** 冻结基线快照文本 */
  frozenFiles: readonly { file: string; content: string }[];
  /** 作者实验证据（user_confirmed；claim 数值覆盖通道） */
  authorEvidence: readonly EvidenceRecord[];
  generatedAt?: string;
}

/** 数值 run（归一化；与 factPreservation 授权匹配同源思想） */
function numberRuns(text: string): string[] {
  return [...text.matchAll(/[-−]?\d+(?:,\d{3})*(?:\.\d+)?/g)]
    .map((match) => normalizeNumericToken(match[0] ?? ""))
    .filter((token) => token !== "");
}

function termSet(text: string): Set<string> {
  return new Set(tokenizeText(text));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const term of a) {
    if (b.has(term)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** claim 数值是否全部出现在参考文本（含表格 / 正文；千分位容错） */
function numbersCoveredBy(numbers: readonly string[], text: string): boolean {
  if (numbers.length === 0) {
    return false;
  }
  const haystack = text.replace(/,/g, "");
  return numbers.every((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`).test(haystack);
  });
}

/**
 * 无数字 claim 的转述覆盖（M11.4 audit 修复）：claim 词元在冻结基线
 * 句 / 段落中的最佳覆盖率（非对称 containment）。
 *
 * 旧实现的缺陷（实证：Attempt 7 r1 —— 审阅对象就是冻结基线本身，仍产出
 * 1 条 revision_introduced）：旧路线用 claim 与基线「整段」的 Jaccard
 * （对称相似度）≥ 0.35 判 pre-existing。Reviewer 提取的 claim 是其转述
 * 短语（~10-15 个 token），与上百 token 的段落 Jaccard 数学上限 ≈
 * |claim| / |段落| ≈ 0.05-0.15 —— 结构上不可能达到 0.35，导致所有
 * 无数字的基线既有 claim（经转述）一律误判为修订引入。改用 claim 词元
 * 覆盖率（|claim ∩ 参考| / |claim|）：转述基线句的 claim 共享绝大多数
 * 内容词元（≥0.6），真正新引入的 claim 含基线没有的实体/概念词元。
 */
const PRE_EXISTING_TERM_CONTAINMENT = 0.6;

/** claim 词元在参考词元集中的覆盖率（转述检测；分母 = claim 词元数） */
function termContainment(claimTerms: ReadonlySet<string>, referenceTerms: ReadonlySet<string>): number {
  if (claimTerms.size === 0) {
    return 0;
  }
  let hit = 0;
  for (const term of claimTerms) {
    if (referenceTerms.has(term)) {
      hit += 1;
    }
  }
  return hit / claimTerms.size;
}

export function computeClaimGapAudit(input: ClaimGapAuditInput): ClaimGapAudit {
  const frozenAll = input.frozenFiles.map((file) => file.content).join("\n");
  const frozenNumbers = new Set(numberRuns(frozenAll));
  // 句级 + 段落级参考词元集（句级为主：转述通常对应单句；段落兜底跨句表述）
  const frozenBlocks = input.frozenFiles
    .flatMap((file) => file.content.replace(/\r\n/g, "\n").split(/\n\s*\n/))
    .filter((block) => block.trim() !== "");
  const frozenParagraphTerms = frozenBlocks.map((block) => termSet(block));
  const frozenSentenceTerms = frozenBlocks
    .flatMap((block) => block.split(/(?<=[。！？!?；;])/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "")
    .map((sentence) => termSet(sentence));

  const classifications: ClaimGapClassification[] = [];
  for (const entry of input.unsupportedClaims) {
    if (!isUnsupportedVerdict(entry.verdict)) {
      continue;
    }
    const numbers = [...new Set(numberRuns(entry.claim))];
    if (numbers.length > 0) {
      // 数值型 claim：全部数值存在于冻结基线 → 原稿既有声明
      if ([...numbers].every((token) => frozenNumbers.has(token))) {
        classifications.push({
          claimId: entry.claimId,
          section: entry.section,
          claim: entry.claim,
          verdict: entry.verdict,
          applicability: "excluded_pre_existing",
          basis: `claim 数值（${numbers.slice(0, 5).join("、")}${numbers.length > 5 ? " 等" : ""}）全部存在于冻结基线 rev-${input.baselineRevision}——原论文既有内容，返修语境不作为新 claim 重证（作者裁决）`,
        });
        continue;
      }
      // 作者实验数据覆盖：全部数值存在于 user_confirmed 证据文本
      const covering = input.authorEvidence.filter((record) => {
        const evidenceText = [record.claim, record.summary ?? "", record.quote ?? ""].join("\n");
        return numbersCoveredBy(numbers, evidenceText);
      });
      if (covering.length > 0) {
        classifications.push({
          claimId: entry.claimId,
          section: entry.section,
          claim: entry.claim,
          verdict: entry.verdict,
          applicability: "excluded_author_data",
          basis: `claim 数值由作者实验证据覆盖（user_confirmed，jsonPath 溯源）——作者自己的实验结果无需外部文献重证`,
          evidenceIds: covering.map((record) => record.id),
        });
        continue;
      }
    } else {
      // 无数字 claim：词元在冻结基线句 / 段落中的最佳覆盖 → 原稿既有表述（转述）
      const claimTerms = termSet(entry.claim);
      const best = [ ...frozenSentenceTerms, ...frozenParagraphTerms ].reduce(
        (max, terms) => Math.max(max, termContainment(claimTerms, terms)),
        0,
      );
      if (best >= PRE_EXISTING_TERM_CONTAINMENT) {
        classifications.push({
          claimId: entry.claimId,
          section: entry.section,
          claim: entry.claim,
          verdict: entry.verdict,
          applicability: "excluded_pre_existing",
          basis: `claim 词元在冻结基线 rev-${input.baselineRevision} 句/段落中覆盖率 ${best.toFixed(2)}（≥ ${PRE_EXISTING_TERM_CONTAINMENT}，转述检测）——原论文既有内容，返修语境不作为新 claim 重证（作者裁决）`,
        });
        continue;
      }
    }
    classifications.push({
      claimId: entry.claimId,
      section: entry.section,
      claim: entry.claim,
      verdict: entry.verdict,
      applicability: "revision_introduced",
      basis: "冻结基线与作者证据均不覆盖：按修订引入的无支撑 claim 处理（须补证 / 关联 / 弱化）",
    });
  }

  // ---- issue 归因（fact / evidence_gap 类 → 被排除 claim） ----
  const excludedClaims = classifications.filter(
    (item) => item.applicability !== "revision_introduced",
  );
  const attribution: IssueAttribution[] = [];
  let excludedCritical = 0;
  let excludedMajor = 0;
  let excludedBlocking = 0;
  for (const issue of input.issues) {
    const relevant =
      (issue.category === "fact" || issue.category === "evidence_gap") &&
      (issue.severity === "critical" || issue.severity === "major" || issue.blocking);
    if (!relevant) {
      continue;
    }
    const descriptionTerms = termSet(issue.description);
    const compactDescription = issue.description.replace(/\s+/g, "");
    const attributed = excludedClaims.find(
      (claim) =>
        sectionsCompatible(issue.section, claim.section) &&
        (jaccard(descriptionTerms, termSet(claim.claim)) >= 0.2 ||
          compactDescription.includes(compactSlice(claim.claim, 24))),
    );
    const excluded = attributed !== undefined;
    if (excluded) {
      if (issue.severity === "critical") {
        excludedCritical += 1;
      } else if (issue.severity === "major") {
        excludedMajor += 1;
      }
      if (issue.blocking) {
        excludedBlocking += 1;
      }
    }
    attribution.push({
      fingerprint: findingFingerprint(issue),
      category: issue.category,
      severity: issue.severity,
      blocking: issue.blocking,
      excluded,
      ...(attributed !== undefined ? { claimId: attributed.claimId } : {}),
    });
  }

  const excludedPreExisting = classifications.filter(
    (item) => item.applicability === "excluded_pre_existing",
  ).length;
  const excludedAuthorData = classifications.filter(
    (item) => item.applicability === "excluded_author_data",
  ).length;
  const revisionIntroduced = classifications.filter(
    (item) => item.applicability === "revision_introduced",
  ).length;
  return {
    schemaVersion: 1,
    reportId: `cga-r${input.round}`,
    projectId: input.projectId,
    round: input.round,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    taskKind: "existing_paper_improvement",
    baselineRevision: input.baselineRevision,
    claims: classifications,
    issueAttribution: attribution,
    counts: {
      unsupportedTotal: classifications.length,
      excludedPreExisting,
      excludedAuthorData,
      revisionIntroduced,
      issues: {
        critical: input.issues.filter((issue) => issue.severity === "critical").length,
        major: input.issues.filter((issue) => issue.severity === "major").length,
        blocking: input.issues.filter((issue) => issue.blocking).length,
        excludedCritical,
        excludedMajor,
        excludedBlocking,
      },
    },
  };
}

/** 章节引用兼容（中英 / 前缀差异不算失配；空引用视为全局匹配） */
function sectionsCompatible(a: string, b: string): boolean {
  const norm = (section: string) => section.trim().toLowerCase();
  const [x, y] = [norm(a), norm(b)];
  if (x === "" || y === "" || x === "(unknown)" || y === "(unknown)" || x === "(global)" || y === "(global)") {
    return true;
  }
  return x === y || x.includes(y) || y.includes(x);
}

/** claim 的空白剥离前缀片段（用于 issue 描述的逐字包含判定；两侧都去空白） */
function compactSlice(text: string, maxLength: number): string {
  return text.replace(/\s+/g, "").slice(0, maxLength);
}

/**
 * M11.2.3（D-2 根因口径）：issue → 本轮 unsupported claim 的根因标注。
 *
 * 结构：fact 路按 Reviewer 契约（prompt：无证据支撑的关键论断必须
 * UNSUPPORTED 并生成 critical/major issue）为同一根因同时产出 claim 级裁决
 * 与 issue 级 finding——规则 4（claim 口径）与规则 5/6（issue 口径）会把同一
 * 问题机械算成多个独立严重问题（M11.3 审计：r8 的 4 条失败规则里 3 条由同一
 * 批回归喂料）。本标注器用与 claimGapAudit 归因同源的确定性匹配（章节兼容 +
 * 描述词面重合 / 逐字包含）把 finding 回填 rootCauseKey = claimId；gate 据此
 * 去重计数（各规则仍分别报告，但 Quality Score / Blocking Count 不再重复计因）。
 *
 * 与 claimGapAudit 的分工：audit 只归因「被排除」的 claim（existing-paper
 * 作者级）；本标注覆盖全部本轮 unsupported claim（含计入阻断口径的 opaque），
 * excludeFingerprints 传入 audit 已归因的指纹防止双重排除。
 */
export function tagIssueRootCauses(
  issues: readonly ReviewIssue[],
  unsupportedClaims: readonly ClaimGroundingEntry[],
  options: { excludeFingerprints?: ReadonlySet<string> } = {},
): { issues: ReviewIssue[]; counts: { blocking: number; critical: number; major: number } } {
  const tagged: ReviewIssue[] = issues.map((issue) => ({ ...issue }));
  let blocking = 0;
  let critical = 0;
  let major = 0;
  for (const issue of tagged) {
    const relevant =
      (issue.category === "fact" || issue.category === "evidence_gap") &&
      (issue.severity === "critical" || issue.severity === "major" || issue.blocking);
    if (!relevant || options.excludeFingerprints?.has(findingFingerprint(issue))) {
      continue;
    }
    const descriptionTerms = termSet(issue.description);
    const compactDescription = issue.description.replace(/\s+/g, "");
    const attributed = unsupportedClaims.find(
      (claim) =>
        isUnsupportedVerdict(claim.verdict) &&
        sectionsCompatible(issue.section, claim.section) &&
        (jaccard(descriptionTerms, termSet(claim.claim)) >= 0.2 ||
          compactDescription.includes(compactSlice(claim.claim, 24))),
    );
    if (attributed === undefined) {
      continue;
    }
    issue.rootCauseKey = attributed.claimId;
    if (issue.severity === "critical") {
      critical += 1;
    } else if (issue.severity === "major") {
      major += 1;
    }
    if (issue.blocking) {
      blocking += 1;
    }
  }
  return { issues: tagged, counts: { blocking, critical, major } };
}
