/**
 * M16 工程收口 C：finding 文字点名的表 / 图 / 公式 / 数字引文 / LaTeX 标签与引文键，在被审原文中的可判定性。
 *
 * 旧 danglingReferences 只按「编号 > 对象数」报「原文不存在」：PDF 转写稿的公式全是无编号的 \[…\]（提取丢了编号），
 * M16 新留出集 22 条「不存在」全部是这种公式编号——原文其实有这些公式，是本输入无法判定。现在每个引用三态：
 *   VALID        原文中存在对应对象（编号 ≤ 抽取到的对象数，或原文自身提到 / 标注了该编号，或 \label / 引文键存在）；
 *   INVALID      在确定性可判的范围内证明不存在（原文有该类结构且编号超出全部对象与原文自身提及；标签 / 键在有结构的原文中缺失）；
 *   UNVERIFIABLE 本输入缺少判定所需结构（无编号公式 / 无表图结构 / 无 \label / 无 \bibitem 的转写稿、分节编号、计数器重置、重复标签）。
 * 只有作者源稿（AUTHOR_SOURCE）上「该类对象一个都没有」才算可判定不存在；转写稿上一律 UNVERIFIABLE。
 * 本模块只给定位质量：不删除、不改写 finding；INVALID 的 finding 不得借此出具证书（见 verifiedFindings.ts）。
 */

import type { SourceVerification } from "./reviewContextSnapshot.js";

export type LocatorKind = "table" | "figure" | "equation" | "numeric_citation" | "label" | "citation_key";
export type LocatorRefStatus = "VALID" | "INVALID" | "UNVERIFIABLE";
export type FindingLocatorStatus = "NONE" | "VALID" | "INVALID_LOCATOR" | "UNVERIFIABLE_LOCATOR";

export interface LocatorRef {
  ref: string;
  kind: LocatorKind;
  status: LocatorRefStatus;
  /** 机器可读原因（如 NUMBER_EXCEEDS_OBJECTS_AND_MENTIONS / NO_NUMBERED_EQUATIONS_IN_INPUT / LABEL_NOT_DEFINED / DUPLICATE_LABEL） */
  reason: string;
}

export interface FindingLocatorAssessment {
  status: FindingLocatorStatus;
  refs: LocatorRef[];
}

/** 被审原文的定位结构索引（一次构建，逐条 finding 复用） */
export interface LocatorIndex {
  authoritativeStructure: boolean;
  tables: { objects: number; mentioned: Set<number> };
  figures: { objects: number; mentioned: Set<number> };
  equations: { numberedUpperBound: number; explicit: Set<number>; mentioned: Set<number>; counterReset: boolean };
  numericCitations: { bibitems: number; bracketNumbers: Set<number> };
  labels: Map<string, number>;
  citeKeys: Set<string>;
  hasCiteCommands: boolean;
}

const NUMBERED_ENV = /\\begin\{(equation|align|gather|multline|eqnarray|flalign|alignat)\}([\s\S]*?)\\end\{\1\}/g;

function numbersOf(text: string, pattern: RegExp): Set<number> {
  const out = new Set<number>();
  for (const match of text.matchAll(pattern)) out.add(Number(match[1]));
  return out;
}

export function buildLocatorIndex(input: { files: ReadonlyArray<{ content: string; tables?: ReadonlyArray<{ floatStart?: number | null; start: number }> }>; sourceVerification: SourceVerification }): LocatorIndex {
  const all = input.files.map((file) => file.content).join("\n");
  const tableObjects = input.files.reduce((sum, file) => sum + new Set((file.tables ?? []).map((table) => table.floatStart ?? table.start)).size, 0);
  let numberedUpperBound = 0;
  for (const match of all.matchAll(NUMBERED_ENV)) {
    const env = match[1]!;
    const body = match[2]!;
    if (env === "equation" || env === "multline") {
      numberedUpperBound += /\\(?:nonumber|notag)\b/.test(body) ? 0 : 1;
      continue;
    }
    // 多行环境：每行一个编号（上界），\nonumber / \notag 的行不计
    const rows = body.split(/\\\\(?!\w)/);
    numberedUpperBound += rows.filter((row) => row.trim() !== "" && !/\\(?:nonumber|notag)\b/.test(row)).length;
  }
  const labels = new Map<string, number>();
  for (const match of all.matchAll(/\\label\{([^}]+)\}/g)) labels.set(match[1]!.trim(), (labels.get(match[1]!.trim()) ?? 0) + 1);
  const citeKeys = new Set<string>();
  let hasCiteCommands = false;
  for (const match of all.matchAll(/\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]+)\}/g)) {
    hasCiteCommands = true;
    for (const key of match[1]!.split(",")) citeKeys.add(key.trim());
  }
  for (const match of all.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) citeKeys.add(match[1]!.trim());
  for (const match of all.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) citeKeys.add(match[1]!.trim());
  const bracketNumbers = new Set<number>();
  for (const match of all.matchAll(/\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/g)) {
    for (const part of match[1]!.split(",")) {
      const range = part.split(/[–-]/).map((value) => Number(value.trim()));
      if (range.length === 2 && range[0]! <= range[1]! && range[1]! - range[0]! <= 50) for (let n = range[0]!; n <= range[1]!; n += 1) bracketNumbers.add(n);
      else bracketNumbers.add(range[0]!);
    }
  }
  return {
    authoritativeStructure: input.sourceVerification === "AUTHOR_SOURCE",
    tables: { objects: tableObjects, mentioned: new Set([...numbersOf(all, /\bTables?\s*~?\s*(\d+)\b/g), ...numbersOf(all, /表\s*(\d+)/g)]) },
    figures: {
      objects: (all.match(/\\begin\{figure\*?\}/g) ?? []).length,
      mentioned: new Set([...numbersOf(all, /\b(?:Figures?|Figs?\.)\s*~?\s*(\d+)\b/g), ...numbersOf(all, /图\s*(\d+)/g)]),
    },
    equations: {
      numberedUpperBound,
      explicit: new Set([...numbersOf(all, /\\tag\*?\{(\d+)\}/g), ...numbersOf(all, /\((\d{1,3})\)\s*(?:\$\$|\\\]|\$\s*$)/gm)]),
      mentioned: new Set([...numbersOf(all, /\b(?:Eqs?\.|Eqns?\.|Equations?)\s*~?\s*\(?(\d+)\)?/g), ...numbersOf(all, /(?:式|公式)\s*[（(]\s*(\d+)\s*[)）]/g)]),
      counterReset: /\\setcounter\{equation\}|\\numberwithin\{equation\}/.test(all),
    },
    numericCitations: { bibitems: (all.match(/\\bibitem/g) ?? []).length, bracketNumbers },
    labels,
    citeKeys,
    hasCiteCommands,
  };
}

function numberedRef(
  ref: string, kind: "table" | "figure" | "equation", n: number,
  objects: number, known: Set<number>, index: LocatorIndex, unverifiableReason: string,
): LocatorRef {
  // 编号是连续的：原文提到 / 标注了第 N 个，1..N 都存在
  const maxKnown = known.size === 0 ? 0 : Math.max(...known);
  if (n >= 1 && n <= Math.max(objects, maxKnown)) return { ref, kind, status: "VALID", reason: n <= objects ? "WITHIN_OBJECT_COUNT" : "WITHIN_NUMBERS_MENTIONED_IN_TEXT" };
  // 没抽取到任何该类对象：只有作者源稿能据此断言不存在（转写稿可能是抽取丢失，提及只给下界）
  if (objects === 0 && !index.authoritativeStructure) return { ref, kind, status: "UNVERIFIABLE", reason: unverifiableReason };
  return { ref, kind, status: "INVALID", reason: objects === 0 && maxKnown === 0 ? `NO_${kind.toUpperCase()}S_IN_AUTHOR_SOURCE` : "NUMBER_EXCEEDS_OBJECTS_AND_MENTIONS" };
}

/** finding 自由文本（description / reason）中的定位引用逐项判定 */
export function assessFindingLocators(text: string, index: LocatorIndex): FindingLocatorAssessment {
  const refs: LocatorRef[] = [];
  const seen = new Set<string>();
  const push = (entry: LocatorRef) => {
    if (seen.has(`${entry.kind}:${entry.ref}`)) return;
    seen.add(`${entry.kind}:${entry.ref}`);
    refs.push(entry);
  };
  const tableKnown = index.tables.mentioned;
  for (const match of text.matchAll(/\bTable\s*~?\s*(\d+)\b(?![.]\d)|表\s*(\d+)(?![.．]\d)/g)) {
    const n = Number(match[1] ?? match[2]);
    push(numberedRef(match[1] !== undefined ? `Table ${n}` : `表 ${n}`, "table", n, index.tables.objects, tableKnown, index, "NO_TABLE_STRUCTURE_IN_INPUT"));
  }
  for (const match of text.matchAll(/\b(Figure|Fig\.)\s*~?\s*(\d+)\b(?![.]\d)|图\s*(\d+)(?![.．]\d)/g)) {
    const n = Number(match[2] ?? match[3]);
    push(numberedRef(match[1] !== undefined ? `${match[1]} ${n}` : `图 ${n}`, "figure", n, index.figures.objects, index.figures.mentioned, index, "NO_FIGURE_STRUCTURE_IN_INPUT"));
  }
  for (const match of text.matchAll(/\b(?:Eq\.|Eqn\.|Equation)\s*~?\s*\(?(\d+)(\.\d+|[a-z])?\)?|(?:式|公式)\s*[（(]\s*(\d+)(\.\d+|[a-z])?\s*[)）]/g)) {
    const n = Number(match[1] ?? match[3]);
    const suffix = match[2] ?? match[4];
    const ref = match[1] !== undefined ? `Eq. (${n}${suffix ?? ""})` : `式(${n}${suffix ?? ""})`;
    if (suffix !== undefined || index.equations.counterReset) {
      push({ ref, kind: "equation", status: "UNVERIFIABLE", reason: suffix !== undefined ? "SECTIONED_OR_SUB_EQUATION_NUMBER" : "EQUATION_COUNTER_RESET" });
      continue;
    }
    const known = new Set([...index.equations.explicit, ...index.equations.mentioned]);
    push(numberedRef(ref, "equation", n, index.equations.numberedUpperBound, known, index, "NO_NUMBERED_EQUATIONS_IN_INPUT"));
  }
  for (const match of text.matchAll(/(?<![\w\\])\[(\d{1,3})\](?!\()/g)) {
    const n = Number(match[1]);
    const ref = `[${n}]`;
    if (n <= index.numericCitations.bibitems || index.numericCitations.bracketNumbers.has(n)) push({ ref, kind: "numeric_citation", status: "VALID", reason: "CITATION_NUMBER_PRESENT" });
    else if (index.numericCitations.bibitems > 0 || index.numericCitations.bracketNumbers.size > 0) push({ ref, kind: "numeric_citation", status: "INVALID", reason: "NUMBER_EXCEEDS_OBJECTS_AND_MENTIONS" });
    else push({ ref, kind: "numeric_citation", status: "UNVERIFIABLE", reason: "NO_NUMERIC_BIBLIOGRAPHY_IN_INPUT" });
  }
  for (const match of text.matchAll(/\\(?:eq|auto|c|C|page|name)?ref\*?\{([^}]+)\}/g)) {
    for (const raw of match[1]!.split(",")) {
      const key = raw.trim();
      const count = index.labels.get(key) ?? 0;
      const ref = `\\ref{${key}}`;
      if (count === 1) push({ ref, kind: "label", status: "VALID", reason: "LABEL_DEFINED" });
      else if (count > 1) push({ ref, kind: "label", status: "UNVERIFIABLE", reason: "DUPLICATE_LABEL" });
      else if (index.labels.size > 0) push({ ref, kind: "label", status: "INVALID", reason: "LABEL_NOT_DEFINED" });
      else push({ ref, kind: "label", status: "UNVERIFIABLE", reason: "NO_LABELS_IN_INPUT" });
    }
  }
  for (const match of text.matchAll(/\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]+)\}/g)) {
    for (const raw of match[1]!.split(",")) {
      const key = raw.trim();
      const ref = `\\cite{${key}}`;
      if (index.citeKeys.has(key)) push({ ref, kind: "citation_key", status: "VALID", reason: "CITATION_KEY_PRESENT" });
      else if (index.hasCiteCommands) push({ ref, kind: "citation_key", status: "INVALID", reason: "CITATION_KEY_NOT_IN_SOURCE" });
      else push({ ref, kind: "citation_key", status: "UNVERIFIABLE", reason: "NO_CITATION_KEYS_IN_INPUT" });
    }
  }
  const status: FindingLocatorStatus = refs.length === 0
    ? "NONE"
    : refs.some((entry) => entry.status === "INVALID")
      ? "INVALID_LOCATOR"
      : refs.some((entry) => entry.status === "UNVERIFIABLE")
        ? "UNVERIFIABLE_LOCATOR"
        : "VALID";
  return { status, refs };
}
