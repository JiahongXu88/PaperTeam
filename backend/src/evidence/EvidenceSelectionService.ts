/**
 * Evidence Selection Service（M6.6）：Evidence 使用策略的唯一事实源。
 *
 * 职责（§M6.6-9/§M6.6-10，架构审计指出 usableEvidence 业务逻辑不该堆在
 * workflow definitions）：判断哪些 Evidence 可以进入 Writer / Reviewer 的
 * 正式上下文。规则：
 *   formal（正式证据）= verificationStatus === "verified"
 *                       && source.sourceId 存在
 *                       && location.chunk（chunkId 锚点）存在
 *   其余一律排除——legacy unverified（§M6.6-11，标识 legacy_unverified，
 *   待 M6.7 收口）以及 plausible / mismatch / unverifiable / not_found。
 *
 * 保持 Retrieved ≠ Verified ≠ Grounded：本服务只做选择，不核验、不写入；
 * 读取面与 Agent 工具层一致（EvidenceReadAccess 只读投影）。
 */

import type {
  EvidenceRecord,
  EvidenceStore,
} from "./EvidenceStore.js";

/** 工具层 / 选择层可见的只读投影（类型层面不存在写方法） */
export type EvidenceReadAccess = Pick<EvidenceStore, "list" | "query">;

/** Evidence 的使用分级（派生标识，不改存储 schema） */
export type EvidenceUsageClass =
  | "grounded_verified" // 正式证据：verified + 三件套齐备
  | "verified_missing_anchor" // verified 但缺 sourceId / chunk 锚点（不可正式使用）
  | "legacy_unverified" // legacy 未核验（Researcher JSON 直追加路径；M6.7 收口）
  | "untrusted"; // plausible / mismatch / unverifiable / not_found

/** 正式证据上限（与旧 usableEvidence 的 20 一致；防 Evidence 淹没 Agent） */
export const FORMAL_EVIDENCE_LIMIT = 20;

/**
 * 正式证据判定（§M6.6-10）：verified 且有 evidenceId（record.id）/
 * sourceId / chunkId 锚点齐备。纯函数——工具层 writer 视图与 workflow
 * 选择共用同一规则，不会出现两套口径。
 */
export function isFormalEvidence(record: EvidenceRecord): boolean {
  return (
    record.verificationStatus === "verified" &&
    (record.source?.sourceId ?? "").trim() !== "" &&
    (record.location?.chunk ?? "").trim() !== ""
  );
}

/** 派生使用分级（legacy 标识的唯一事实源） */
export function classifyEvidence(record: EvidenceRecord): EvidenceUsageClass {
  if (record.verificationStatus === "verified") {
    return isFormalEvidence(record) ? "grounded_verified" : "verified_missing_anchor";
  }
  if (record.verificationStatus === "unverified") {
    return "legacy_unverified";
  }
  return "untrusted";
}

export interface EvidenceSelection {
  /** 可进入正式写作 / 审稿上下文的记录（限量排序） */
  formal: EvidenceRecord[];
  /** 排除统计（审计 / 日志可见；不进 prompt） */
  excluded: {
    legacyUnverified: number;
    untrusted: number;
    verifiedMissingAnchor: number;
  };
}

export interface EvidenceSelectionOptions {
  /** formal 池上限（缺省 FORMAL_EVIDENCE_LIMIT） */
  limit?: number;
}

/** Bibliography 条目（ResearcherService.BibliographyEntryInput 的结构子集） */
export interface BibliographyLikeEntry {
  key: string;
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
}

export class EvidenceSelectionService {
  private readonly evidence: EvidenceReadAccess;

  constructor(evidence: EvidenceReadAccess) {
    this.evidence = evidence;
  }

  /**
   * 选择可进入 Writer / Reviewer 正式上下文的 Evidence（§M6.6-10）。
   * 排序：direct 支撑优先（沿用旧 usableEvidence 语义），限量防淹没。
   */
  async selectForWriting(
    projectId: string,
    options: EvidenceSelectionOptions = {},
  ): Promise<EvidenceSelection> {
    const limit = options.limit ?? FORMAL_EVIDENCE_LIMIT;
    const records = await this.evidence.list(projectId);
    const formal: EvidenceRecord[] = [];
    const excluded = { legacyUnverified: 0, untrusted: 0, verifiedMissingAnchor: 0 };
    for (const record of records) {
      switch (classifyEvidence(record)) {
        case "grounded_verified":
          formal.push(record);
          break;
        case "verified_missing_anchor":
          excluded.verifiedMissingAnchor += 1;
          break;
        case "legacy_unverified":
          excluded.legacyUnverified += 1;
          break;
        default:
          excluded.untrusted += 1;
      }
    }
    formal.sort(
      (a, b) => (b.supportStrength === "direct" ? 1 : 0) - (a.supportStrength === "direct" ? 1 : 0),
    );
    return { formal: formal.slice(0, limit), excluded };
  }

  /**
   * EvidenceRecord → bibliography key 关联（§M6.6-12 Citation Integration）：
   * 引用生成优先从 EvidenceRecord 反查 source metadata 对应的 bib key。
   * 匹配顺序：DOI 精确 → 归一化 title（+ 年份容差）。无匹配返回 null。
   */
  static matchBibliographyKey(
    record: EvidenceRecord,
    entries: readonly BibliographyLikeEntry[],
  ): string | null {
    const doi = record.source?.doi?.trim().toLowerCase();
    if (doi !== undefined && doi !== "") {
      const byDoi = entries.find(
        (entry) => (entry.doi ?? "").trim().toLowerCase() === doi,
      );
      if (byDoi !== undefined) {
        return byDoi.key;
      }
    }
    const title = normalizeTitle(record.source?.title);
    if (title !== null) {
      const byTitle = entries.find((entry) => {
        const entryTitle = normalizeTitle(entry.title);
        if (entryTitle === null || entryTitle !== title) {
          return false;
        }
        // title 命中后年份必须一致（未提供年份的任一侧视为可接受）
        const evidenceYear = record.source?.year;
        if (evidenceYear !== undefined && entry.year !== undefined && evidenceYear !== entry.year) {
          return false;
        }
        return true;
      });
      if (byTitle !== undefined) {
        return byTitle.key;
      }
    }
    return null;
  }
}

/** title 归一化：小写 + 去除标点 / 空白（匹配跨大小写与连字符差异） */
function normalizeTitle(title: string | undefined): string | null {
  if (title === undefined) {
    return null;
  }
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "");
  return normalized === "" ? null : normalized;
}
