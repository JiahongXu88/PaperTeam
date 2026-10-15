/**
 * M14.3 — 跨章一致性 MVP（确定性；不实现完整 ConsistencyLedger）。
 *
 * 检查项（全部非阻断，advisory / suspicious 两级）：
 *   1. 术语变体：同一归一化形式（casefold + 去空格/连字符/下划线）的术语在
 *      不同章以不同原文形态出现（数据集 / 方法 / 指标 / 参数名来自 ScientificFact
 *      key 与 surface）；
 *   2. 同实验跨章数值：同一 fact key（subject/dataset/metric）在多章的句子中
 *      出现数值 token，若与 authorConfirmed 事实数值不等价 → 疑点（双位置）；
 *   3. 章节间引用：\ref/\eqref 指向全文档未定义的 label。
 *
 * 确定性输出落盘 research/cross-chapter-consistency.json；confirmed unauthorized
 * 数值变更不在此处判定（published_facts_zero_drift 阻断语义不变）。
 */

import type { ResearchFactContext } from "./researchInputTypes.js";
import { compareFactValues } from "./factValues.js";

export interface ConsistencyLocation {
  chapterId: string;
  file: string;
  excerpt: string;
}

export interface ConsistencyFinding {
  kind: "term_variant" | "numeric_suspicion" | "undefined_reference";
  severity: "advisory" | "suspicious";
  summary: string;
  locations: ConsistencyLocation[];
}

export interface CrossChapterConsistencyResult {
  schemaVersion: 1;
  generatedAt: string;
  projectId: string;
  checked: { terms: number; factKeys: number; references: number; chapters: number };
  findings: ConsistencyFinding[];
}

/** 归一化：casefold + 去空白/连字符/下划线/点（DAVSOD ≈ DAVSOD ≈ dav-sod） */
function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/[\s\-_.]+/g, "");
}

/** 句子切分（中文句读 + 后随空白的英文句点——小数点不切断） */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。；;！？?])\s*|(?<=\.)(?=\s)/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && sentence.length < 600);
}

/** 独立数值 token（含百分号形态） */
function numericTokens(text: string): Array<{ raw: string; numeric: number }> {
  const tokens: Array<{ raw: string; numeric: number }> = [];
  for (const match of text.matchAll(/(?<![\w\\])(\d+(?:\.\d+)?%?)(?![\w])/g)) {
    const raw = match[1]!;
    const numeric = Number.parseFloat(raw.replace("%", ""));
    if (!Number.isNaN(numeric)) tokens.push({ raw, numeric });
  }
  return tokens;
}

export function checkCrossChapterConsistency(input: {
  projectId: string;
  now: string;
  chapters: ReadonlyArray<{ chapterId: string; titleZh: string; sectionFiles: readonly string[] }>;
  sectionContents: ReadonlyMap<string, string>;
  factContext: ResearchFactContext;
}): CrossChapterConsistencyResult {
  const { projectId, now, chapters, sectionContents, factContext } = input;
  const findings: ConsistencyFinding[] = [];

  // 章文本装配
  const chapterTexts = chapters.map((chapter) => ({
    chapterId: chapter.chapterId,
    titleZh: chapter.titleZh,
    text: chapter.sectionFiles.map((file) => sectionContents.get(file) ?? "").join("\n"),
    files: chapter.sectionFiles,
  }));

  // ---- 1. 术语变体 ----
  const terms = new Map<string, Map<string, Set<string>>>(); // normalized → raw → chapterIds
  const collectTerms = (raw: string, chapterId: string) => {
    const trimmed = raw.trim();
    if (trimmed.length < 2 || trimmed.length > 40) return;
    const normalized = normalizeTerm(trimmed);
    if (normalized === "") return;
    const byRaw = terms.get(normalized) ?? new Map<string, Set<string>>();
    const chaptersSet = byRaw.get(trimmed) ?? new Set<string>();
    chaptersSet.add(chapterId);
    byRaw.set(trimmed, chaptersSet);
    terms.set(normalized, byRaw);
  };
  for (const fact of [...factContext.facts.authorConfirmed, ...factContext.facts.sourceVerifiedUnconfirmed]) {
    const chapterIds = chapterTexts.map((chapter) => chapter.chapterId);
    for (const value of [fact.key.dataset, fact.key.metric, fact.key.subject, fact.key.parameter].filter(
      (entry): entry is string => entry !== undefined && entry !== "",
    )) {
      for (const chapterId of chapterIds) collectTerms(value, chapterId);
    }
  }
  // 只对实际出现在正文里的术语做变体比对
  for (const [normalized, byRaw] of terms) {
    const distinct = [...byRaw.keys()].filter((raw) =>
      chapterTexts.some((chapter) =>
        new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(raw)}([^A-Za-z0-9]|$)`, "u").test(chapter.text),
      ),
    );
    if (distinct.length > 1 && normalized.length >= 3) {
      findings.push({
        kind: "term_variant",
        severity: "advisory",
        summary: `术语「${distinct.join(" / ")}」跨章形态不一致（归一化后相同）`,
        locations: distinct.slice(0, 4).map((raw) => {
          const chapter = chapterTexts.find((entry) =>
            new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(raw)}([^A-Za-z0-9]|$)`, "u").test(entry.text),
          );
          const excerpt = extractExcerpt(chapter?.text ?? "", raw);
          return {
            chapterId: chapter?.chapterId ?? "",
            file: chapter?.files[0] ?? "",
            excerpt,
          };
        }),
      });
    }
  }

  // ---- 2. 同实验跨章数值疑点 ----
  const keys = new Map<string, { terms: string[]; chapters: Map<string, Array<{ raw: string; numeric: number; excerpt: string; file: string }>> }>();
  for (const fact of factContext.facts.authorConfirmed) {
    const keyTerms = [fact.key.dataset, fact.key.metric, fact.key.subject].filter(
      (entry): entry is string => entry !== undefined && entry !== "" && entry.length >= 2,
    );
    if (keyTerms.length === 0) continue;
    const keyId = keyTerms.map(normalizeTerm).sort().join("|");
    const entry = keys.get(keyId) ?? { terms: keyTerms, chapters: new Map() };
    keys.set(keyId, entry);
  }
  for (const [keyId, entry] of keys) {
    for (const chapter of chapterTexts) {
      for (const sentence of sentences(chapter.text)) {
        const mentionsTerm = entry.terms.some((term) =>
          new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(term)}([^A-Za-z0-9]|$)`, "iu").test(sentence),
        );
        if (!mentionsTerm) continue;
        for (const token of numericTokens(sentence)) {
          const list = entry.chapters.get(chapter.chapterId) ?? [];
          list.push({ raw: token.raw, numeric: token.numeric, excerpt: sentence.slice(0, 200), file: chapter.files[0] ?? "" });
          entry.chapters.set(chapter.chapterId, list);
        }
      }
    }
    // 同 key 多章出现不同数值 → 疑点（不去重合法重复）
    const byChapterValue = [...entry.chapters.entries()];
    if (byChapterValue.length >= 2) {
      const seen: Array<{ chapterId: string; raw: string; numeric: number }> = [];
      for (const [chapterId, list] of byChapterValue) {
        for (const item of list) {
          const conflict = seen.find(
            (other) => other.chapterId !== chapterId && !valuesEquivalent(other.numeric, item.numeric),
          );
          if (conflict !== undefined) {
            const otherChapter = byChapterValue.find(([id]) => id === conflict.chapterId)?.[1][0];
            findings.push({
              kind: "numeric_suspicion",
              severity: "suspicious",
              summary: `「${entry.terms.join("/")}」相关表述在 ${conflict.chapterId} 出现 ${conflict.raw}、在 ${chapterId} 出现 ${item.raw}（语义是否同一实验待作者判断）`,
              locations: [
                {
                  chapterId: conflict.chapterId,
                  file: otherChapter?.file ?? "",
                  excerpt: (otherChapter?.excerpt ?? "").slice(0, 200),
                },
                { chapterId, file: item.file, excerpt: item.excerpt },
              ],
            });
            break;
          }
        }
        for (const item of list) seen.push({ chapterId, raw: item.raw, numeric: item.numeric });
      }
    }
    void keyId;
  }

  // ---- 3. 未定义章节间引用 ----
  const allText = chapterTexts.map((chapter) => chapter.text).join("\n");
  const labels = new Set([...allText.matchAll(/\\label\{([^}]+)\}/g)].map((match) => match[1]!));
  for (const chapter of chapterTexts) {
    for (const match of chapter.text.matchAll(/\\(?:ref|eqref|autoref)\{([^}]+)\}/g)) {
      const label = match[1]!;
      if (labels.has(label)) continue;
      findings.push({
        kind: "undefined_reference",
        severity: "advisory",
        summary: `交叉引用 \\ref{${label}} 在全文档无对应 \\label（可能未解析）`,
        locations: [{ chapterId: chapter.chapterId, file: chapter.files[0] ?? "", excerpt: extractExcerpt(chapter.text, label) }],
      });
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: now,
    projectId,
    checked: { terms: terms.size, factKeys: keys.size, references: labels.size, chapters: chapters.length },
    findings,
  };
}

function valuesEquivalent(a: number, b: number): boolean {
  if (a === b) return true;
  const comparison = compareFactValues({ raw: String(a), numeric: a }, { raw: String(b), numeric: b });
  return (
    comparison.outcome === "equal" ||
    comparison.outcome === "rounding_difference" ||
    comparison.outcome === "equal_after_unit_normalization"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractExcerpt(text: string, needle: string, radius = 60): string {
  const index = text.indexOf(needle);
  if (index === -1) return "";
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + needle.length + radius)).replace(/\s+/g, " ");
}
