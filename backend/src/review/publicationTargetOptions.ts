/**
 * GET /api/publication-target/options 的响应（前端选择器的唯一事实源）：体系 / 层级 / 已核验期刊身份。
 * 期刊只列内置已核验 profile；分区 / 收录状态只展示官方自述（SELF_DECLARED）或「未核实」，不推断。
 */
import { listBuiltinJournalProfiles } from "../target/journal/profileRegistry.js";
import { profileTrust } from "../target/journal/profileVerification.js";
import {
  PUBLICATION_SCHEME_LABELS,
  PUBLICATION_SCHEMES,
  PUBLICATION_TIERS,
  REVIEW_POLICY_VERSION,
  tierLabel,
  type PublicationScheme,
} from "./publicationPolicy.js";

export function publicationTargetOptions(now: Date = new Date()): Record<string, unknown> {
  return {
    policyVersion: REVIEW_POLICY_VERSION,
    schemes: PUBLICATION_SCHEMES.map((scheme) => ({
      scheme,
      label: PUBLICATION_SCHEME_LABELS[scheme],
      tiers: scheme === "none"
        ? []
        : PUBLICATION_TIERS[scheme as Exclude<PublicationScheme, "none">].map((tier) => ({ tier, label: tierLabel({ scheme, tier }) ?? tier })),
      ...(scheme === "chinese_index" ? { note: "北大核心、CSCD、CSSCI 是彼此独立的收录 / 评价体系，不是同一条等级线" } : {}),
      ...(scheme === "cas" || scheme === "jcr" ? { note: "中科院分区与 JCR 分区是两套体系，层级不可互换；系统未接入分区数据，所选层级只作为审稿关注点" } : {}),
    })),
    journals: listBuiltinJournalProfiles().map((profile) => {
      const trust = profileTrust(profile, null, now);
      return {
        journalId: profile.journalId,
        displayName: profile.identity.nameZh ?? profile.identity.nameEn ?? profile.journalId,
        ...(profile.identity.nameEn !== undefined ? { nameEn: profile.identity.nameEn } : {}),
        language: profile.language,
        rulesVersion: profile.rulesVersion,
        retrievedAt: profile.source.retrievedAt,
        verification: { status: trust.status, trusted: trust.trusted },
        indexing: profile.indexing.map((entry) => ({
          label: entry.label,
          status: entry.status,
          ...(entry.year !== undefined ? { year: entry.year } : {}),
          ...(entry.sourceUrl !== undefined ? { sourceUrl: entry.sourceUrl } : {}),
        })),
      };
    }),
    statement: "发表目标用于决定审稿关注点；不预测录用，也不证明稿件达到某分区 / 期刊的学术水平。",
  };
}
