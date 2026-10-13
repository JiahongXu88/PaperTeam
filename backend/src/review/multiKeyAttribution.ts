/**
 * Multi-key Citation Attribution Check（M13 Final Closure，A4）：多 key 引用句的归因稀释——
 * 一句话只描述了其中一篇文献的机制 / 数值，却以 \cite{a,b}（常带「等」）让另一篇文献「共同承担」。
 *
 * 真实样本（M13.7.9 §11）：「微波腔光子数态等离散变量…\cite{ni, sivak}」——只有 Ni 等的摘要含
 * 「微波腔光子数态」，Sivak 等不含；多 key 形态让 Ni 独有的描述覆盖了 Sivak。既有层（key 白名单 /
 * 引用保持 / multiKeyCiteRatio / Fact Reviewer 单 evidenceId 绑定 / Citation Integrity 的组级 judge）
 * 全部按「组共同支撑」口径工作，没有任何一层比较**每个 key** 与该句的对应关系。
 *
 * 本检查是只读、确定性、精度优先的**复审信号**（不是 Gate 规则、不自动改稿）：
 *   触发条件（全部满足才报）：
 *   1. 句子含一个多 key \cite 命令（≥ 2 个 key）；
 *   2. 每个 key 都能解析到正式证据（任一 key 无证据 = 不可核对，跳过——与 Citation Integrity 的
 *      「metadata-only 成员不参与判断」同口径）；
 *   3. 句子含具体内容（机制谓词或特征数字：classifyCitationIntent ∈ {method, result, comparison}）；
 *   4. 句子的区分性词项（去掉所有 key 共有的词后）命中**恰好一个** key 的证据 ≥ 2 项，其余 key 命中 0 项；
 *   5. 句子没有分配标记（分别 / 前者 / 后者 / respectively / 各自）——这些句子是合法的分述。
 *   输出 = 句子、文件、多 key 清单、唯一命中的 key、未命中的 key、命中词项；供 Fact Reviewer 复核与报告。
 */

import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { isFormalEvidence } from "../evidence/EvidenceSelectionService.js";
import { resolveEvidenceCitationKey } from "../citation/bibliography.js";
import { classifyCitationIntent } from "../citation/citationIntent.js";
import { tokenizeText } from "../retrieval/tokenize.js";
import { distinctiveNumbers } from "./claimStance.js";

export interface MultiKeyAttributionFinding {
  file: string;
  sentence: string;
  keys: string[];
  /** 句子具体内容词面唯一命中的 key */
  attributedKey: string;
  /** 证据零命中的 key（被稀释覆盖的文献） */
  uncoveredKeys: string[];
  matchedTerms: string[];
  intent: string;
}

export interface MultiKeyAttributionReport {
  schemaVersion: 1;
  generatedAt: string;
  revision?: number;
  sentencesWithMultiKeyCite: number;
  checkable: number;
  findings: MultiKeyAttributionFinding[];
  skipped: { reason: "key_without_evidence" | "no_specific_content" | "distribution_marker" | "shared_or_multi_hit"; count: number }[];
}

const CITE_PATTERN = /\\(?:cite|citep|citet|citealp|citealt|parencite|textcite|autocite)\*?(?:\[[^\]\n]*\])*\{([^{}]*)\}/g;
const DISTRIBUTION_MARKER = /分别|前者|后者|各自|其一|其二|一方面|另一方面|respectively|the former|the latter|one of them|the other/iu;
/** 多 key 共享的词项不具区分性：机制 / 数值词项至少要 2 个不同词项只命中一篇 */
const MIN_DISCRIMINATING_TERMS = 2;

function stripLatexInline(text: string): string {
  return text
    .replace(/\\(?:label|ref|eqref|autoref|cref)\{[^{}]*\}/g, " ")
    .replace(/\$[^$\n]*\$/g, " ")
    .replace(/\\[A-Za-z]+\*?(?:\[[^\]\n]*\])?\{([^{}]*)\}/g, "$1")
    .replace(/\\[A-Za-z]+\*?/g, " ")
    .replace(/[{}~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把一段 LaTeX 拆成句子（保留 \cite 命令以便归属） */
export function splitLatexSentences(latex: string): string[] {
  const ESCAPED_PERCENT = "\u0001";
  const body = latex
    .replace(/\r\n/g, "\n")
    .replace(/\\%/g, ESCAPED_PERCENT) // 转义百分号是正文字符，不是注释起点（M13.7.8 教训）
    .replace(/%[^\n]*/g, " ")
    .replace(/\u0001/g, "%")
    .replace(/\\(?:sub)*section\*?\{[^{}]*\}/g, "\n")
    .replace(/\\begin\{[^{}]*\}|\\end\{[^{}]*\}/g, "\n");
  return body
    .split(/(?<=[。！？!?])|(?<=\.)(?=\s+[A-Z\u4e00-\u9fff])|\n{2,}/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence !== "");
}

function evidenceTermsByKey(
  evidence: readonly EvidenceRecord[],
  bibEntries: readonly { key: string; sourceId?: string; title?: string; doi?: string; year?: number }[],
): Map<string, { terms: Set<string>; numbers: Set<string> }> {
  const byKey = new Map<string, { terms: Set<string>; numbers: Set<string> }>();
  for (const record of evidence) {
    if (!isFormalEvidence(record)) {
      continue;
    }
    const key = resolveEvidenceCitationKey(record, bibEntries);
    if (key === null) {
      continue;
    }
    const text = [record.claim, record.quote ?? "", record.summary ?? ""].join("\n");
    const entry = byKey.get(key) ?? { terms: new Set<string>(), numbers: new Set<string>() };
    for (const term of tokenizeText(text)) {
      entry.terms.add(term);
    }
    for (const value of distinctiveNumbers(text)) {
      entry.numbers.add(value);
    }
    byKey.set(key, entry);
  }
  return byKey;
}

/** 单句判定（纯函数；供测试与批量调用） */
export function assessMultiKeySentence(
  sentence: string,
  keys: readonly string[],
  termsByKey: ReadonlyMap<string, { terms: Set<string>; numbers: Set<string> }>,
): { finding: Omit<MultiKeyAttributionFinding, "file"> | null; skipped: MultiKeyAttributionReport["skipped"][number]["reason"] | null } {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length < 2) {
    return { finding: null, skipped: null };
  }
  if (uniqueKeys.some((key) => !termsByKey.has(key))) {
    return { finding: null, skipped: "key_without_evidence" };
  }
  const plain = stripLatexInline(sentence.replace(CITE_PATTERN, " "));
  if (DISTRIBUTION_MARKER.test(plain)) {
    return { finding: null, skipped: "distribution_marker" };
  }
  const intent = classifyCitationIntent(plain);
  const numbers = distinctiveNumbers(plain);
  if (intent === "background" && numbers.length === 0) {
    return { finding: null, skipped: "no_specific_content" };
  }
  const sentenceTerms = new Set(tokenizeText(plain));
  // 区分性词项 = 句子词项中不被全部 key 共享的那些
  const hitsByKey = new Map<string, string[]>();
  for (const key of uniqueKeys) {
    const entry = termsByKey.get(key)!;
    const hits: string[] = [];
    for (const term of sentenceTerms) {
      if (term.length < 2) {
        continue;
      }
      if (!entry.terms.has(term)) {
        continue;
      }
      const sharedByAll = uniqueKeys.every((other) => termsByKey.get(other)!.terms.has(term));
      if (!sharedByAll) {
        hits.push(term);
      }
    }
    for (const value of numbers) {
      if (entry.numbers.has(value) && !uniqueKeys.every((other) => termsByKey.get(other)!.numbers.has(value))) {
        hits.push(`#${value}`);
      }
    }
    hitsByKey.set(key, hits);
  }
  const withHits = uniqueKeys.filter((key) => (hitsByKey.get(key)?.length ?? 0) > 0);
  if (withHits.length !== 1) {
    return { finding: null, skipped: "shared_or_multi_hit" };
  }
  const attributedKey = withHits[0]!;
  const matched = hitsByKey.get(attributedKey)!;
  if (matched.length < MIN_DISCRIMINATING_TERMS) {
    return { finding: null, skipped: "shared_or_multi_hit" };
  }
  return {
    finding: {
      sentence: plain.slice(0, 300),
      keys: uniqueKeys,
      attributedKey,
      uncoveredKeys: uniqueKeys.filter((key) => key !== attributedKey),
      matchedTerms: matched.slice(0, 12),
      intent,
    },
    skipped: null,
  };
}

export function computeMultiKeyAttribution(params: {
  files: readonly { file: string; content: string }[];
  evidence: readonly EvidenceRecord[];
  bibEntries: readonly { key: string; sourceId?: string; title?: string; doi?: string; year?: number }[];
  revision?: number;
  generatedAt?: string;
}): MultiKeyAttributionReport {
  const termsByKey = evidenceTermsByKey(params.evidence, params.bibEntries);
  const findings: MultiKeyAttributionFinding[] = [];
  const skipped = new Map<MultiKeyAttributionReport["skipped"][number]["reason"], number>();
  let multiKeySentences = 0;
  let checkable = 0;
  for (const file of params.files) {
    for (const sentence of splitLatexSentences(file.content)) {
      CITE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      let evaluated = false;
      while ((match = CITE_PATTERN.exec(sentence)) !== null) {
        const keys = (match[1] ?? "").split(",").map((key) => key.trim()).filter((key) => key !== "");
        if (keys.length < 2 || evaluated) {
          continue;
        }
        evaluated = true;
        multiKeySentences += 1;
        const assessment = assessMultiKeySentence(sentence, keys, termsByKey);
        if (assessment.skipped !== null) {
          skipped.set(assessment.skipped, (skipped.get(assessment.skipped) ?? 0) + 1);
          if (assessment.skipped !== "key_without_evidence") {
            checkable += 1;
          }
          continue;
        }
        checkable += 1;
        if (assessment.finding !== null) {
          findings.push({ file: file.file, ...assessment.finding });
        }
      }
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    ...(params.revision !== undefined ? { revision: params.revision } : {}),
    sentencesWithMultiKeyCite: multiKeySentences,
    checkable,
    findings,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

/** Fact Reviewer 用的有界 digest（≤ 6 条；无命中返回 undefined = 不注入） */
export function renderMultiKeyAttributionDigest(report: MultiKeyAttributionReport): string | undefined {
  if (report.findings.length === 0) {
    return undefined;
  }
  return [
    `多 key 引用归因观察（确定性词面信号，${report.findings.length} 句；只读，供逐句核验归因，不是缺陷判定）：`,
    ...report.findings.slice(0, 6).map(
      (finding) =>
        `- [${finding.file}] 「${finding.sentence.slice(0, 120)}」引用 {${finding.keys.join(", ")}}，但句中具体内容（${finding.matchedTerms.slice(0, 5).join("/")}）只命中 ${finding.attributedKey} 的证据；${finding.uncoveredKeys.join(", ")} 的证据零命中——请核对该句是否把一篇文献的机制 / 数值归给了整组。`,
    ),
  ].join("\n");
}
