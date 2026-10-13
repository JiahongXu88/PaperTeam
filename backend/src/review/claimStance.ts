/**
 * Claim Stance（M13 Final Closure，A1）：区分「正面事实断言」与「对未证实命题的拒绝 /
 * 不确定性陈述」——确定性、无 LLM、保守。
 *
 * 背景（M13.7.11 §5.4 / §10-3 / §15-1 的真实样本）：稿件写「相干增益 G=2.27 与表面码
 * 2.4 倍寿命超越并非同一指标，不可据此判定优劣」，Fact Reviewer 把它绑到 partial 记录
 * E012（其内容恰是被拒绝的命题「二者是同一指标」）并判 SUPPORTED；claimGrounding 的
 * 「含数字 claim 要求 direct 证据」规则把这条**正确的科研限制**改判 UNSUPPORTED，连续
 * 三轮阻断 Quality Gate，并经 resolution 阶梯要求删除数值。
 *
 * 本模块只回答两个确定性问题，供 claimGrounding / claimResolution 联合使用：
 *
 * 1. `classifyClaimStance(text)`：这句话的**立场**是什么？
 *    - `refutation`  ：拒绝一条可比性 / 推断 / 归因 / 指标等同命题（并非同一指标、
 *                      不可据此判定、不能直接比较、不构成…证据、分属不同…）
 *    - `uncertainty` ：声明当前证据不足以判断（尚无法判断、仍是开放问题、有待验证）
 *    - `assertion`   ：其余一切——包括**否定形态的事实断言**（「未超越盈亏平衡」、
 *                      「不优于」、「低于」）：否定词 ≠ 拒绝命题，它们仍是需要证据的
 *                      事实主张，保持原有口径。
 *    拿不准（无任何拒绝 / 不确定谓词）一律 `assertion`——保守方向。
 *
 * 2. `numbersAnchoredInEvidence(text, pool)`：claim 中的特征数字是否**全部**出现在正式
 *    证据池文本中？拒绝句里的数字是对既有证据数值的转述，不是新事实；若有任何数字
 *    在池内找不到，则这句话携带了无来源数值，不得享受拒绝立场的豁免（防止把真正缺
 *    证据的数值主张包装成「并非同一指标」）。
 *
 * 词面重叠 `overlapsEvidenceRecord`：拒绝句必须与被绑定的 partial 记录（被拒绝的命题）
 * 共享 ≥ 2 个不同词项，证明拒绝的对象就是该命题，而不是碰巧绑到一条无关 partial。
 */

import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { tokenizeText } from "../retrieval/tokenize.js";

/**
 * M11.3（Phase B）数值锚定：claim 中的特征数字（小数 / 百分比 / ≥3 位整数，
 * 剔除纯年份）。定义在本模块（claimGrounding 再导出）以避免循环依赖。
 */
export function distinctiveNumbers(text: string): string[] {
  const matches = text.match(/\d+(?:\.\d+)?/g) ?? [];
  return matches.filter((value) => {
    if (value.includes(".")) {
      return true;
    }
    if (value.length < 3) {
      return false;
    }
    const numeric = Number.parseInt(value, 10);
    return !(numeric >= 1900 && numeric <= 2099); // 纯年份不构成特征数值
  });
}

export type ClaimStance = "assertion" | "refutation" | "uncertainty";

export interface ClaimStanceResult {
  stance: ClaimStance;
  /** 命中的谓词（审计 / 测试断言；assertion 为 null） */
  marker: string | null;
}

/**
 * 拒绝命题谓词：围绕「可比性 / 等同 / 据此推断 / 归因 / 排序」的否定。
 * 顺序即优先级；每条都要求否定词与认知谓词同现（否定词单独出现不算）。
 */
const REFUTATION_PATTERNS: readonly RegExp[] = [
  // 并非 / 不是 / 不属于 + 同一 … 指标 / 口径 / 量 / 概念 / 实验设定
  /(?:并非|并不是|不是|不属于|非)[^。；，]{0,8}?同一[^。；，]{0,10}?(?:指标|口径|量纲|维度|概念|范畴|设定|基准|实验|定义|对象)/u,
  // 分属不同 … 指标 / 实验 / 口径
  /分属(?:不同|两[类种套])[^。；，]{0,12}?(?:指标|口径|实验|设定|基准|体系|维度)/u,
  // 不可 / 不能 / 无法 / 不应 / 不宜 / 难以 / 不足以 + (据此) + 判定 / 比较 / 换算 / 推断 / 排序 / 等同 / 混同
  /(?:不可|不能|无法|不应|不宜|难以|不足以|不得|不允许|不支持|并不支持)[^。；，]{0,6}?(?:据此|直接|简单|互相|相互|彼此|横向)?[^。；，]{0,4}?(?:判定|判断|认定|推断|推论|比较|对比|换算|排序|排名|等同|混同|混为一谈|外推|类比|归因|得出|证明|说明)/u,
  // 不构成 / 不足以构成 / 不等价于 / 不等同于 / 不意味着 / 不代表 / 不能说明
  /(?:不构成|不足以构成|不等价于|不等同于|不意味着|并不意味着|不代表|并不代表|不能说明|并不能说明|不能证明|并不能证明)/u,
  // 英文（稿件可能为英文）
  /\b(?:are|is|be)\s+not\s+(?:the\s+same|directly\s+comparable|comparable|equivalent|interchangeable)\b/iu,
  /\bcannot\s+(?:be\s+)?(?:directly\s+)?(?:compared|used\s+to\s+(?:rank|judge|infer|conclude)|be\s+taken\s+as)\b/iu,
  /\bdoes\s+not\s+(?:imply|establish|demonstrate|constitute|support\s+(?:a\s+)?(?:ranking|comparison))\b/iu,
];

/** 不确定性谓词：声明证据不足以判断，而不是断言某个事实为真 / 为假。 */
const UNCERTAINTY_PATTERNS: readonly RegExp[] = [
  /(?:尚|仍|目前|现有证据|现有数据|现有材料)[^。；，]{0,6}?(?:无法|不能|不足以|难以|不足)[^。；，]{0,6}?(?:判断|判定|确定|比较|回答|证实|证明|排序|评估|得出)/u,
  /(?:仍|尚|仍然|依然)(?:是|属于|为)?[^。；，]{0,4}?开放(?:问题|议题)/u,
  /(?:有待|仍待|尚待|留待)[^。；，]{0,6}?(?:验证|核验|实验|检验|确认|研究|考察|证实)/u,
  /(?:尚无|尚未有|目前没有|目前尚无|仍无|缺乏)[^。；，]{0,6}?(?:证据|实验|数据|研究|验证)[^。；，]{0,6}?(?:表明|支持|证明|显示|验证|比较)?/u,
  /(?:能否|是否)[^。；，]{0,16}?(?:尚不清楚|尚无定论|尚无共识|仍不清楚|仍待|有待|尚待|尚不明确|尚未明确)/u,
  /\bremains?\s+(?:an\s+)?open\s+question\b/iu,
  /\b(?:cannot|can\s+not|could\s+not)\s+(?:yet\s+)?be\s+(?:determined|established|concluded|resolved)\s+(?:from|with|on)\s+(?:the\s+)?(?:current|available|existing|present)\s+(?:evidence|data)\b/iu,
  /\b(?:the\s+)?(?:current|available|existing)\s+evidence\s+(?:does\s+not|is\s+insufficient\s+to)\b/iu,
];

/**
 * 立场分类（纯函数）。uncertainty 先于 refutation 判定：「现有证据尚无法判断」同时含
 * 「无法…判断」（拒绝谓词）与「尚…无法…判断」（不确定谓词），语义上是证据不足的声明
 * 而非对命题的拒绝；两类立场在豁免规则上同等对待，顺序只影响标签。两者皆无 → assertion。
 */
export function classifyClaimStance(text: string): ClaimStanceResult {
  const normalized = text.normalize("NFKC");
  for (const pattern of UNCERTAINTY_PATTERNS) {
    const hit = pattern.exec(normalized);
    if (hit !== null) {
      return { stance: "uncertainty", marker: hit[0] };
    }
  }
  for (const pattern of REFUTATION_PATTERNS) {
    const hit = pattern.exec(normalized);
    if (hit !== null) {
      return { stance: "refutation", marker: hit[0] };
    }
  }
  return { stance: "assertion", marker: null };
}

/** 证据记录的全部文本面（与 findEvidenceCandidates 同口径：claim + quote + 标题） */
export function evidenceRecordText(record: EvidenceRecord): string {
  return [record.claim, record.quote ?? "", record.summary ?? "", record.source?.title ?? ""].join("\n");
}

/**
 * claim 中的特征数字是否全部锚定在正式证据池文本中（任一记录即可；池为空或 claim
 * 无特征数字时返回 `{ anchored: true, missing: [] }`——没有需要锚定的数字）。
 */
export function numbersAnchoredInEvidence(
  claimText: string,
  pool: readonly EvidenceRecord[],
): { anchored: boolean; numbers: string[]; missing: string[] } {
  const numbers = [...new Set(distinctiveNumbers(claimText.normalize("NFKC")))];
  if (numbers.length === 0) {
    return { anchored: true, numbers: [], missing: [] };
  }
  const poolNumbers = new Set<string>();
  for (const record of pool) {
    for (const value of distinctiveNumbers(evidenceRecordText(record).normalize("NFKC"))) {
      poolNumbers.add(value);
    }
  }
  const missing = numbers.filter((value) => !poolNumbers.has(value));
  return { anchored: missing.length === 0, numbers, missing };
}

/** claim 与证据记录的不同词项重叠数（tokenizer 与检索同源；中英兼容） */
export function overlapsEvidenceRecord(claimText: string, record: EvidenceRecord, minTerms = 2): boolean {
  const claimTerms = new Set(tokenizeText(claimText));
  if (claimTerms.size === 0) {
    return false;
  }
  const recordTerms = new Set(tokenizeText(evidenceRecordText(record)));
  let matched = 0;
  for (const term of claimTerms) {
    if (recordTerms.has(term)) {
      matched += 1;
      if (matched >= minTerms) {
        return true;
      }
    }
  }
  return false;
}

export interface PartialRefutationAssessment {
  /** 满足全部条件：可按「对 partial 命题的拒绝 / 不确定性陈述」处理 */
  qualifies: boolean;
  stance: ClaimStance;
  marker: string | null;
  numbersAnchored: boolean;
  missingNumbers: string[];
  overlapsRecord: boolean;
  /** 人读依据（写入 supportBoundary / resolution.reason） */
  reason: string;
}

/**
 * 「拒绝 partial 命题」的联合判定（claimGrounding 在数值规则之前调用）：
 *  1. 立场 ∈ {refutation, uncertainty}（词面谓词，不是单独的否定词）；
 *  2. 绑定记录 supportStrength === "partial"（direct 记录走原有口径；indirect /
 *     contradictory / 缺失一律不豁免）；
 *  3. claim 的特征数字全部锚定在正式证据池（含该 partial 记录）；
 *  4. claim 与该 partial 记录词项重叠 ≥ 2（拒绝的对象就是该命题）。
 * 任何一条不满足 → 不豁免（保持 M11.3 的「含数字 claim 要求 direct」口径）。
 */
export function assessPartialRefutation(
  claimText: string,
  record: EvidenceRecord,
  pool: readonly EvidenceRecord[],
): PartialRefutationAssessment {
  const { stance, marker } = classifyClaimStance(claimText);
  const anchoring = numbersAnchoredInEvidence(claimText, pool);
  const overlaps = overlapsEvidenceRecord(claimText, record);
  const isPartial = record.supportStrength === "partial";
  const qualifies = stance !== "assertion" && isPartial && anchoring.anchored && overlaps;
  let reason: string;
  if (qualifies) {
    reason =
      stance === "refutation"
        ? `Refutation of a partial proposition（谓词「${marker}」）：拒绝 partial 记录 ${record.id} 所述命题，数值 ${anchoring.numbers.join("、") || "（无）"} 全部锚定在正式证据池；按 PARTIALLY_SUPPORTED 保留，不按数值断言处置`
        : `Uncertainty statement about a partial proposition（谓词「${marker}」）：声明 partial 记录 ${record.id} 所述命题尚不能判断，数值 ${anchoring.numbers.join("、") || "（无）"} 全部锚定在正式证据池；按 PARTIALLY_SUPPORTED 保留`;
  } else if (stance === "assertion") {
    reason = "claim 为事实断言（含否定形态的事实断言），不适用拒绝命题豁免";
  } else if (!isPartial) {
    reason = `绑定记录 ${record.id} 不是 partial（${record.supportStrength ?? "unknown"}），拒绝命题豁免只针对 partial 命题`;
  } else if (!anchoring.anchored) {
    reason = `拒绝句携带正式证据池中不存在的数值（${anchoring.missing.join("、")}），不得豁免`;
  } else {
    reason = `claim 与 partial 记录 ${record.id} 词项重叠不足，无法确认拒绝对象即该命题`;
  }
  return {
    qualifies,
    stance,
    marker,
    numbersAnchored: anchoring.anchored,
    missingNumbers: anchoring.missing,
    overlapsRecord: overlaps,
    reason,
  };
}
