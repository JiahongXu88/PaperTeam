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
 * - grey_zone_author_decision（M11.4）：转述覆盖 ∈ [0.4, 0.6) 的灰区 claim
 *   ——无法确定性归层，不按引入计罚也不静默豁免，转作者裁决通道；
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
import { isUnsupportedVerdict, claimFingerprint, type ClaimGroundingEntry } from "./claimGrounding.js";
import { normalizeNumericToken } from "../quality/factPreservation.js";
import { tokenizeText } from "../retrieval/tokenize.js";

export type ClaimApplicability =
  | "excluded_pre_existing"
  | "excluded_author_data"
  | "grey_zone_author_decision"
  | "revision_introduced";

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
    /** 灰区（转述覆盖 0.4–0.6）：既不按引入计罚，也不静默豁免——转作者裁决 */
    greyZone: number;
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

/**
 * 数值 run（归一化；与 factPreservation 授权匹配同源思想）。
 * M11.4 Attempt 8 修复：紧随数字之后的连字符是区间分隔符（"1400-200-400
 * 划分"），不是负号——旧正则把审稿人转述里的区间读成负数 token（-200/-400），
 * 基线只存正数（200 段/400 段）→ 「全部数值存在于基线」被单个伪影数值破坏，
 * 基线既有数据集统计整条误判 revision_introduced（实证：c-e965ba5d2331，
 * clean run p-db07e4273daa）。负号仅在其前一字符不是数字/连字符时生效
 * （"提升 -3.0" 仍产生带符号 token，方向语义不丢）。
 */
function numberRuns(text: string): string[] {
  return [...text.matchAll(/(?:(?<![\d.\-−–—])[-−])?\d+(?:,\d{3})*(?:\.\d+)?/g)]
    .map((match) => normalizeNumericToken(match[0] ?? ""))
    .filter((token) => token !== "");
}

function termSet(text: string): Set<string> {
  return new Set(tokenizeText(text));
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
/**
 * 灰区下界（M11.4 Product Closure）：转述覆盖 ∈ [0.4, 0.6) 的 claim 既不能
 * 确证为基线既有，也不能确证为修订引入（实证：Attempt 7 r3 的 c-7b1a 0.48，
 * 基线存在措辞最接近的转述但覆盖不足）。二值判罚的两侧都是错判——按作者
 * 裁决通道呈现（gate 规则 4 不计罚，Revision Task Gate 计入 authorDecisions）。
 */
const GREY_ZONE_TERM_CONTAINMENT = 0.4;

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
  /**
   * M11.4 Attempt 8：全文级参考词元集（兜底层）。Reviewer 对表格 / 多句内容
   * 的压缩标签（"消融与 λ_smooth 扫描数值"）不对应任何单句 / 段落——句级
   * containment 对这类标签结构性失效（实证：c-dc50babe7207，0.38 < 0.4 灰区，
   * 三张消融表全部是基线既有内容）。文档级 containment 直接检验设计文档声
   * 明的判据——「真正新引入的 claim 含基线没有的实体/概念词元」——词元全部
   * 存在于全文任何位置时该判据不成立。仅在句/段落级未达阈值时启用。
   */
  const frozenDocumentTerms = termSet(frozenAll);

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
      // M11.4 Attempt 8：全文级兜底（表格/多句压缩标签不对应单句，见
      // frozenDocumentTerms 的注释）；句/段落级优先，未达阈值时才消费全文级。
      const docLevel = termContainment(claimTerms, frozenDocumentTerms);
      if (best >= PRE_EXISTING_TERM_CONTAINMENT || docLevel >= PRE_EXISTING_TERM_CONTAINMENT) {
        classifications.push({
          claimId: entry.claimId,
          section: entry.section,
          claim: entry.claim,
          verdict: entry.verdict,
          applicability: "excluded_pre_existing",
          basis: best >= PRE_EXISTING_TERM_CONTAINMENT
            ? `claim 词元在冻结基线 rev-${input.baselineRevision} 句/段落中覆盖率 ${best.toFixed(2)}（≥ ${PRE_EXISTING_TERM_CONTAINMENT}，转述检测）——原论文既有内容，返修语境不作为新 claim 重证（作者裁决）`
            : `claim 词元在冻结基线 rev-${input.baselineRevision} 全文中的覆盖率 ${docLevel.toFixed(2)}（≥ ${PRE_EXISTING_TERM_CONTAINMENT}，表格/多句压缩标签全文兜底；句级最佳 ${best.toFixed(2)}）——原论文既有内容，返修语境不作为新 claim 重证（作者裁决）`,
        });
        continue;
      }
      if (best >= GREY_ZONE_TERM_CONTAINMENT || docLevel >= GREY_ZONE_TERM_CONTAINMENT) {
        classifications.push({
          claimId: entry.claimId,
          section: entry.section,
          claim: entry.claim,
          verdict: entry.verdict,
          applicability: "grey_zone_author_decision",
          basis: `claim 词元对冻结基线 rev-${input.baselineRevision} 的覆盖率（句/段落级 ${best.toFixed(2)} / 全文级 ${docLevel.toFixed(2)}）落在灰区 [${GREY_ZONE_TERM_CONTAINMENT}, ${PRE_EXISTING_TERM_CONTAINMENT})——无法确定性归层，转作者裁决（不按修订引入计罚，也不静默豁免）`,
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

  // ---- issue 归因（→ 被排除 / 灰区 claim） ----
  // 灰区 claim 的伴随 finding 同样不计入规则 5/6 阻断口径（作者裁决层，
  // Revision Task Gate 的 authorDecisions 与投稿风险清单会呈现，不静默）。
  // M11.4 Reliability Closure（Run C 实证）：heavy finding 任意 category 都参与
  // 归因——强证据档（数值指纹 / 逐字引用 / 直接 id join）不依赖 category 标签
  //（学术审稿人把主表/消融矛盾 finding 标 academic，fact 审稿人标 fact——
  // 标签是噪声）；弱证据档（章节兼容 + 词元覆盖）仅限 fact / evidence_gap。
  const excludedClaims = classifications.filter(
    (item) => item.applicability !== "revision_introduced",
  );
  const attribution: IssueAttribution[] = [];
  let excludedCritical = 0;
  let excludedMajor = 0;
  let excludedBlocking = 0;
  for (const issue of input.issues) {
    const heavy = issue.severity === "critical" || issue.severity === "major" || issue.blocking;
    if (!heavy) {
      continue;
    }
    const allowTermTier = issue.category === "fact" || issue.category === "evidence_gap";
    const descriptionTerms = termSet(issue.description);
    const compactDescription = issue.description.replace(/\s+/g, "");
    // M11.4 Reliability Closure：直接 id join 优先（claimIndex lineage /
    // 机器回填的 rootCauseKey 指向被排除 claim → 直接归因，词面匹配只做兜底）
    const directJoin = issue.rootCauseKey !== undefined
      ? excludedClaims.find((claim) => claim.claimId === issue.rootCauseKey)
      : undefined;
    // M11.4 Attempt 8：归因谓词集中到 claimMatchesFinding（分层证据 + 数值指纹档）
    const attributed = directJoin ??
      excludedClaims.find(
        (claim) =>
          claimMatchesFinding(issue.section, claim.section, claim.claim, descriptionTerms, issue.description, compactDescription, allowTermTier),
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
  const greyZone = classifications.filter(
    (item) => item.applicability === "grey_zone_author_decision",
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
      greyZone,
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

/**
 * M11.4 Reliability Closure（Run Q 实证）：可引用标识符指纹——finding 的
 * section / description 与 claim 共享 ≥1 个规范标签（tab:…/fig:…/sec:… 等）
 * 即同一对象（标签是稿件全局唯一的规范 id，比词面/数值更强：finding 把表标签
 * 写在 section 字段、claim 写在正文，两者都不含对方词元时仍可归因）。
 */
const REFERENCABLE_ID_PATTERN = /(?:tab|fig|eq|sec|subsec|subsubsec|alg|table|figure):[A-Za-z0-9_-]{2,}/g;

function referencableIds(...texts: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(REFERENCABLE_ID_PATTERN)) {
      ids.add(match[0].toLowerCase().replace(/^(table|figure):/, (m) => (m.startsWith("table") ? "tab:" : "fig:")));
    }
  }
  return ids;
}

/**
 * M11.4 Attempt 8 修复：claim ↔ finding 描述的归因谓词（分层证据强度）。
 *
 * - 常规档（弱证据，仅 fact / evidence_gap 类）：章节兼容 ∧ claim 词元在
 *   描述词元中的覆盖率 ≥ 0.5；
 * - 引用档（强证据，任意类）：覆盖率 ≥ 0.75 或逐字片段——描述逐字引用 claim
 *   内容时，引文本身就是归因证据，章节标签噪声不能破坏归因；
 * - 数值指纹档（强证据，任意类）：claim 数值 ≥ 2 且描述含其半数以上 → 同一
 *   对象（Run C 实证：学术审稿人把主表/消融表矛盾 finding 标 category=academic
 *   ——同款 finding 在 8c 被标 fact；category 标签是噪声，数值指纹不是。
 *   强证据档不依赖 category，弱证据档保留 category 佐证）；
 * - 标识符指纹档（强证据，任意类）：共享 ≥1 个规范标签（Run Q 实证：
 *   evidence_gap finding「两张主对比表的全部数值…无支撑」不引任何数值/词元，
 *   但其 section 字段带 tab:main_bdd100k/tab:main_uadetrac，与 claim 的表标签
 *   重合——同一对象）。
 */
function claimMatchesFinding(
  issueSection: string,
  claimSection: string,
  claimText: string,
  descriptionTerms: ReadonlySet<string>,
  descriptionText: string,
  compactDescription: string,
  allowTermTier: boolean = true,
): boolean {
  const findingIds = referencableIds(issueSection, descriptionText, compactDescription);
  const claimIds = referencableIds(claimSection, claimText);
  if (findingIds.size > 0 && claimIds.size > 0) {
    for (const id of findingIds) {
      if (claimIds.has(id)) {
        return true;
      }
    }
  }
  const containment = termContainment(termSet(claimText), descriptionTerms);
  if (
    allowTermTier &&
    sectionsCompatible(issueSection, claimSection) && containment >= 0.5
  ) {
    return true;
  }
  if (containment >= 0.75 || compactDescription.includes(compactSlice(claimText, 24))) {
    return true;
  }
  // 数值指纹：必须用原始描述（含空白）——去空白会把 "IDF1 74.0" 压成
  // "IDF174.0"，数值边界被破坏（74.0 → 174.0），指纹失真。
  const claimNumbers = [...new Set(numberRuns(claimText))];
  if (claimNumbers.length >= 2) {
    const descriptionNumbers = new Set(numberRuns(descriptionText));
    const shared = claimNumbers.filter((token) => descriptionNumbers.has(token)).length;
    if (shared / claimNumbers.length >= 0.5) {
      return true;
    }
  } else if (claimNumbers.length === 1) {
    const descriptionNumbers = new Set(numberRuns(descriptionText));
    if (
      descriptionNumbers.has(claimNumbers[0]!) &&
      sectionsCompatible(issueSection, claimSection)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * M11.4 Reliability Closure：claimIndex creator-side lineage 解析（确定性）。
 *
 * fact Reviewer 同轮产出 claims 与 issues——issue 可携带 claimIndex（claims
 * 数组下标）声明其来源 claim。这是「创建者侧 lineage」：模型只命名自己刚生成
 * 的产物下标，机器做存在性 + 弱佐证校验（章节兼容 / 词元覆盖 ≥ 0.3 / 数值指纹
 * 之一），错下标不采信。比词面匹配优先：8c 实证的元描述 finding（“摘要仍声称
 * 均优于…无证据支撑”）与 claim 原文词面重叠 < 0.5，结构上不可归因。
 * 返回同形 issues，命中者携带 rootCauseKey=claimId（调用方在 claim grounding
 * 之后、claimGapAudit 之前执行；audit 归因与任务层归层消费同一 id）。
 */
export function resolveClaimIndexLinks<T extends { claimIndex?: number; section: string; description: string; rootCauseKey?: string }>(
  issues: readonly T[],
  factClaims: readonly { section: string; claim: string }[],
): T[] {
  if (factClaims.length === 0) {
    return [...issues];
  }
  return issues.map((issue) => {
    if (issue.rootCauseKey !== undefined) {
      return issue; // 机器已回填（防重复消费）；保留
    }
    const index = issue.claimIndex;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= factClaims.length) {
      return issue;
    }
    const claim = factClaims[index]!;
    // 弱佐证（防错下标）：章节兼容 / claim 词元覆盖 ≥ 0.3 / 数值指纹（≥半数）
    const descriptionTerms = termSet(issue.description);
    const claimTerms = termSet(claim.claim);
    const containment = termContainment(claimTerms, descriptionTerms);
    const claimNumbers = [...new Set(numberRuns(claim.claim))];
    const descriptionNumbers = new Set(numberRuns(issue.description));
    const numericCorroborated =
      claimNumbers.length >= 2 &&
      claimNumbers.filter((token) => descriptionNumbers.has(token)).length / claimNumbers.length >= 0.5;
    const corroborated =
      sectionsCompatible(issue.section, claim.section) || containment >= 0.3 || numericCorroborated;
    if (!corroborated) {
      return issue;
    }
    return { ...issue, rootCauseKey: claimFingerprint(claim.section, claim.claim) };
  });
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
    // D-2 契约保持：root-cause 标注只服务 fact 路的 claim/issue 配对去重
    //（M11.2.3 语义不变）；跨 category 归因（数值指纹等强证据档）由
    // computeClaimGapAudit 的 issueAttribution 承担（F15），它同样驱动
    // classifyFindingOrigins 的 excludedFingerprints 归层。
    const relevant =
      (issue.category === "fact" || issue.category === "evidence_gap") &&
      (issue.severity === "critical" || issue.severity === "major" || issue.blocking);
    if (!relevant || options.excludeFingerprints?.has(findingFingerprint(issue))) {
      continue;
    }
    // M11.4 Reliability Closure：claimIndex lineage 已回填 rootCauseKey 且指向
    // 本轮 unsupported claim → 机器 lineage 优先，不再重跑词面匹配（防止
    // 元描述 finding 被 word面匹配置换/丢失）
    if (issue.rootCauseKey !== undefined && unsupportedClaims.some((claim) => claim.claimId === issue.rootCauseKey)) {
      if (issue.severity === "critical") {
        critical += 1;
      } else if (issue.severity === "major") {
        major += 1;
      }
      if (issue.blocking) {
        blocking += 1;
      }
      continue;
    }
    const allowTermTier = issue.category === "fact" || issue.category === "evidence_gap";
    const descriptionTerms = termSet(issue.description);
    const compactDescription = issue.description.replace(/\s+/g, "");
    // M11.4 Attempt 8：归因谓词集中到 claimMatchesFinding（与 audit 同口径：
    // 强证据档任意 category，弱证据档仅 fact / evidence_gap；rootCauseKey
    // 断链则 Revision Task Gate 的 finding 归层退回修改区间启发式）
    const attributed = unsupportedClaims.find(
      (claim) =>
        isUnsupportedVerdict(claim.verdict) &&
        claimMatchesFinding(issue.section, claim.section, claim.claim, descriptionTerms, issue.description, compactDescription, allowTermTier),
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
