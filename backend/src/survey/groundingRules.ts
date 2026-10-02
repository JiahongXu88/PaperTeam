/**
 * Synthesis grounding 的确定性判定规则（M11.1.2）。
 *
 * 设计红线：LLM 可以生成 claim / classification / comparison wording，
 * 但无权决定自己的结论是否 grounded。groundingLevel 只能由本文件的
 * 纯函数计算（无 IO、无时钟、无模型），输入是已经过服务层 fail-closed
 * 核验的事实（引用存在、evidence 存在且归属正确）。
 *
 * 规则总表（deterministic，逐条可单测锁死）：
 *
 * | kind             | evidence_backed                        | literature_cited             | speculative               |
 * |------------------|----------------------------------------|------------------------------|---------------------------|
 * | taxonomy         | 不可能（组织骨架，不承载科学结论）     | 恒定                         | 不可能                    |
 * | trend            | ≥2 verified evidence 且 ≥2 distinct   | 有真实引用未达阈值           | 不进入（无引用被拒绝）    |
 * |                  | source                                 |                              |                           |
 * | comparison       | 同 trend                               | 同上                         | 同上                      |
 * | consensus        | ≥3 distinct source 且 ≥2 verified     | 2 source=observed_agreement  | 同上                      |
 * |                  | evidence（≥2 source）                  | 或未达阈值                   |                           |
 * | disagreement     | 每侧 ≥1 可靠锚点且每侧 ≥1 verified    | 仅单侧缺可靠锚点             | 两侧都缺可靠锚点          |
 * |                  | evidence（合计 ≥2 source）             |                              |                           |
 * | research_gap     | 不可能（不存在性论断无法被证据正向     | 恒定（trigger 白名单三选一） | 不可能（非法 trigger 已拒）|
 * |                  | 验证）                                 |                              |                           |
 * | future_direction | origin=cited_future_work 且达 evidence| origin=cited 未达阈值        | origin=inferred（硬规则， |
 * |                  | 阈值                                   |                              | 无论证据多强）            |
 *
 * 通用 evidence 阈值（trend / comparison / consensus / cited future）：
 * verified evidence ≥2 条、来自 ≥2 个不同 source、且 evidence 的 sourceId
 * 必须属于该 synthesis 的 sourceIds（归属一致性由服务层先行核验，这里的
 * 输入已是过滤后的集合——双保险在 deriveGroundingLevel 内再做一次）。
 */

import type { SynthesisGroundingLevel, SynthesisDetail, SurveySynthesisKind } from "./synthesisTypes.js";
import type { SynthesisEntryTrust } from "./synthesisTypes.js";

/** 已核验存在的 evidence 投影（verificationStatus / sourceId 来自 EvidenceRecord） */
export interface SynthesisEvidenceRef {
  id: string;
  verified: boolean;
  sourceId: string;
}

export interface GroundingDerivationInput {
  kind: SurveySynthesisKind;
  detail?: SynthesisDetail;
  /** 该 synthesis 引用的全部 entryIds（已核验存在） */
  entryIds: string[];
  /** entryIds 对应的信任投影（fulltext / abstract_only / 可靠锚点） */
  entries: SynthesisEntryTrust[];
  /** evidenceIds 对应的 evidence（已核验存在；含未 verified 的，如实参与降级） */
  evidence: SynthesisEvidenceRef[];
  /** 从 entryIds 派生的 sourceIds（升序） */
  sourceIds: string[];
}

export interface GroundingDecision {
  level: SynthesisGroundingLevel;
  /** 人读依据（审计 / HITL 展示） */
  reason: string;
}

/** disagreement 一侧的溯源能力（可靠锚点 + verified evidence 计数） */
function disagreementSideReadiness(
  sideEntryIds: string[],
  entries: SynthesisEntryTrust[],
  evidence: SynthesisEvidenceRef[],
): { entryIds: string[]; reliableAnchor: boolean; verifiedEvidence: number } {
  const entryIds = sideEntryIds.filter((id) => entries.some((entry) => entry.entryId === id));
  const sideSourceIds = new Set(
    entries.filter((entry) => entryIds.includes(entry.entryId)).map((entry) => entry.sourceId),
  );
  return {
    entryIds,
    reliableAnchor:
      entries.filter((entry) => entryIds.includes(entry.entryId) && entry.reliableAnchor).length > 0,
    verifiedEvidence: evidence.filter(
      (record) => record.verified && sideSourceIds.has(record.sourceId),
    ).length,
  };
}

/**
 * groundingLevel 判定（唯一入口；确定性纯函数）。
 * 输入已由服务层 fail-closed 核验（引用存在、evidence 归属正确）；本函数
 * 不再抛错——任何异常形态按最保守级别处理。
 */
export function deriveGroundingLevel(input: GroundingDerivationInput): GroundingDecision {
  const { kind, detail } = input;

  // evidence 归属双保险：只统计 sourceId ∈ synthesis sourceIds 的记录
  const ownedEvidence = input.evidence.filter((record) => input.sourceIds.includes(record.sourceId));
  const verified = ownedEvidence.filter((record) => record.verified);
  const verifiedSources = new Set(verified.map((record) => record.sourceId));
  const meetsEvidenceThreshold =
    verified.length >= 2 && verifiedSources.size >= 2;

  switch (kind) {
    case "taxonomy":
      // 组织骨架：文献归类聚合（abstract / fulltext 均可参与计数），不承载
      // 科学结论——永不 evidence_backed，也不因 unclassified 而 speculative
      return {
        level: "literature_cited",
        reason: "taxonomy 是确定性的文献归类聚合（组织骨架），不承载可验证的科学结论",
      };

    case "research_gap":
      // 不存在性论断（“文献中没有 X”）无法被 verified evidence 正向证明；
      // trigger 白名单（literature_limitation / taxonomy_empty / coverage_missing）
      // 已在 parse 阶段 fail-closed，能到这里的三选一
      return {
        level: "literature_cited",
        reason: `research_gap 基于${describeGapTrigger(detail)}的结构性陈述，不存在性论断不适用 evidence 验证路径`,
      };

    case "future_direction":
      if (detail?.kind === "future_direction" && detail.origin === "inferred") {
        // 硬规则：inferred（模型从趋势/局限/空缺推导）无论证据多强、模型
        // 自述 confidence 多高，一律 speculative——没有“模型觉得可信”通道
        return {
          level: "speculative",
          reason: "future_direction 由推断产生（origin=inferred），按规则一律 speculative",
        };
      }
      if (meetsEvidenceThreshold) {
        return {
          level: "evidence_backed",
          reason: `cited_future_work：${verified.length} 条 verified evidence 覆盖 ${verifiedSources.size} 个来源，达到 evidence 阈值`,
        };
      }
      return {
        level: "literature_cited",
        reason: `cited_future_work 但未达 evidence 阈值（verified=${verified.length}、来源=${verifiedSources.size}，需 ≥2 条且 ≥2 来源）`,
      };

    case "consensus": {
      const distinctSources = new Set(input.sourceIds).size;
      if (detail?.kind === "consensus") {
        detail.distinctSources = distinctSources;
      }
      if (distinctSources <= 2) {
        // 2 篇观点一致只是 observed agreement，不是 consensus；observedAgreement
        // 标记由 parse 默认 false、这里按事实回填（模型值不可信）
        if (detail?.kind === "consensus") {
          detail.observedAgreement = distinctSources === 2;
        }
        return {
          level: "literature_cited",
          reason:
            distinctSources === 2
              ? "仅 2 个来源观点一致：observed agreement，不构成 consensus（封顶 literature_cited）"
              : "来源数不足 2，consensus 语义不成立",
        };
      }
      if (meetsEvidenceThreshold) {
        return {
          level: "evidence_backed",
          reason: `${distinctSources} 个来源共识，${verified.length} 条 verified evidence 覆盖 ${verifiedSources.size} 个来源`,
        };
      }
      return {
        level: "literature_cited",
        reason: `${distinctSources} 个来源共识但 evidence 未达阈值（verified=${verified.length}、来源=${verifiedSources.size}，需 ≥2 条且 ≥2 来源）`,
      };
    }

    case "disagreement": {
      if (detail?.kind !== "disagreement") {
        return { level: "literature_cited", reason: "disagreement 缺少结构化 detail，按最保守引用级处理" };
      }
      const sideA = disagreementSideReadiness(detail.sideA.entryIds, input.entries, ownedEvidence);
      const sideB = disagreementSideReadiness(detail.sideB.entryIds, input.entries, ownedEvidence);
      if (!sideA.reliableAnchor && !sideB.reliableAnchor) {
        // 两侧都没有可靠锚点：这是从 Matrix 解释层推不出可靠对立的分歧
        return {
          level: "speculative",
          reason: "分歧两侧均无可靠 chunk 锚点（abstract-only / 弱锚定条目），对立结构不可溯源",
        };
      }
      if (!sideA.reliableAnchor || !sideB.reliableAnchor) {
        return {
          level: "literature_cited",
          reason: "仅一侧具备可靠 chunk 锚点，分歧可引用但不可 evidence 验证",
        };
      }
      if (sideA.verifiedEvidence >= 1 && sideB.verifiedEvidence >= 1 && verifiedSources.size >= 2) {
        return {
          level: "evidence_backed",
          reason: `两侧各 ≥1 条 verified evidence（合计 ${verified.length} 条 / ${verifiedSources.size} 来源），对立结论可回溯`,
        };
      }
      return {
        level: "literature_cited",
        reason: "两侧锚点可靠但 verified evidence 不足（需每侧 ≥1 条且合计 ≥2 来源）",
      };
    }

    case "trend":
    case "comparison":
    default: {
      if (meetsEvidenceThreshold) {
        return {
          level: "evidence_backed",
          reason: `${verified.length} 条 verified evidence 覆盖 ${verifiedSources.size} 个来源，达到 evidence 阈值`,
        };
      }
      return {
        level: "literature_cited",
        reason: `有真实文献引用但未达 evidence 阈值（verified=${verified.length}、来源=${verifiedSources.size}，需 ≥2 条且 ≥2 来源）`,
      };
    }
  }
}

function describeGapTrigger(detail: SynthesisDetail | undefined): string {
  if (detail?.kind === "research_gap") {
    switch (detail.trigger) {
      case "literature_limitation":
        return "多篇文献明确 limitation";
      case "taxonomy_empty":
        return "taxonomy 聚合结构空缺";
      case "coverage_missing":
        return "Survey coverage 缺口";
    }
  }
  return "未归类触发源";
}
