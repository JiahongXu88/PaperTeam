/**
 * Citation 静态核验（Layer 1，M3.1）。
 *
 * 纯确定性检查（不依赖 LLM、不依赖网络）：
 *   LaTeX \cite 族引用 ↔ references.bib 条目
 *   - cite key 在 bib 中不存在（missing）
 *   - bib 条目从未被引用（unused，警告级）
 *   - bib key 重复（duplicate）
 *   - 明显坏引用（\cite{} 空 key 等）
 * 网络不可用时本层仍可独立工作；外部网络故障不等于引用不存在。
 */

export interface BibEntrySummary {
  key: string;
  type: string;
  title?: string;
  year?: number;
  doi?: string;
}

export interface BibParseResult {
  entries: BibEntrySummary[];
  duplicateKeys: string[];
  malformed: number;
}

export interface CitationCheckResult {
  /** 正文引用的全部 key（去重） */
  citedKeys: string[];
  /** 引用了但 bib 中不存在 */
  missingKeys: string[];
  /** bib 中存在但从未被引用（警告级） */
  unusedKeys: string[];
  /** bib 中重复定义的 key */
  duplicateKeys: string[];
  /** 解析出的坏引用（如 \cite{} 空 key） */
  badCitations: { file: string; snippet: string }[];
  bibEntries: BibEntrySummary[];
}

/** \cite 族命令（含 natbib / biblatex 常用变体） */
const CITE_COMMAND_PATTERN =
  /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|parencite|textcite|autocite|nocite|footcite|smartcite)\*?(?:\[[^\]\n]*\])*\{([^{}]*)\}/g;

/** 解析 references.bib（容错：非法条目跳过并计数） */
export function parseBib(bibText: string): BibParseResult {
  const entries: BibEntrySummary[] = [];
  const duplicateKeys: string[] = [];
  const seen = new Set<string>();
  let malformed = 0;

  const pattern = /@([A-Za-z]+)\s*\{\s*([^,\s{}]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(bibText)) !== null) {
    const type = (match[1] ?? "").toLowerCase();
    if (type === "comment" || type === "preamble" || type === "string") {
      continue;
    }
    const key = match[2] ?? "";
    if (seen.has(key)) {
      duplicateKeys.push(key);
      continue;
    }
    seen.add(key);
    // 提取该条目正文（到平衡的右花括号；未闭合视为 malformed，按空体处理）
    const bodyStart = match.index + match[0].length;
    const rawBody = sliceEntryBody(bibText, bodyStart);
    if (rawBody === null) {
      malformed += 1;
    }
    const body = rawBody ?? "";
    const title = readField(body, "title");
    const yearRaw = readField(body, "year");
    const yearNumeric = yearRaw !== undefined ? Number.parseInt(yearRaw, 10) : Number.NaN;
    entries.push({
      key,
      type,
      ...(title !== undefined ? { title: stripBraces(title) } : {}),
      ...(Number.isInteger(yearNumeric) ? { year: yearNumeric } : {}),
      ...(readField(body, "doi") !== undefined ? { doi: readField(body, "doi") } : {}),
    });
  }
  return { entries, duplicateKeys, malformed };
}

/** 提取单个 .tex 文件中的引用 key（含坏引用检测） */
export function extractCitationKeys(
  file: string,
  tex: string,
): { keys: string[]; bad: { file: string; snippet: string }[] } {
  const keys = new Set<string>();
  const bad: { file: string; snippet: string }[] = [];
  CITE_COMMAND_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITE_COMMAND_PATTERN.exec(tex)) !== null) {
    const raw = match[1] ?? "";
    const command = match[0];
    if (raw.trim() === "") {
      bad.push({ file, snippet: command.slice(0, 40) });
      continue;
    }
    for (const part of raw.split(",")) {
      const key = part.trim();
      if (key === "") {
        bad.push({ file, snippet: command.slice(0, 40) });
        continue;
      }
      if (!/^[A-Za-z0-9_.:+*-]+$/.test(key)) {
        bad.push({ file, snippet: `可疑 key "${key}"` });
        continue;
      }
      keys.add(key);
    }
  }
  return { keys: [...keys], bad };
}

/** 静态一致性检查 */
export function checkCitations(
  texFiles: { file: string; content: string }[],
  bibText: string | null,
): CitationCheckResult {
  const cited = new Set<string>();
  const badCitations: { file: string; snippet: string }[] = [];
  for (const tex of texFiles) {
    const { keys, bad } = extractCitationKeys(tex.file, tex.content);
    for (const key of keys) {
      cited.add(key);
    }
    badCitations.push(...bad);
  }
  const bib = parseBib(bibText ?? "");
  const bibKeys = new Set(bib.entries.map((entry) => entry.key));

  const missingKeys = [...cited].filter((key) => !bibKeys.has(key)).sort();
  const unusedKeys = bib.entries
    .map((entry) => entry.key)
    .filter((key) => !cited.has(key))
    .sort();

  return {
    citedKeys: [...cited].sort(),
    missingKeys,
    unusedKeys,
    duplicateKeys: [...new Set(bib.duplicateKeys)].sort(),
    badCitations,
    bibEntries: bib.entries,
  };
}

// ---- 内部 ----

/** 提取 bib 字段（title = {…} 或 title = "…"） */
function readField(body: string, field: string): string | undefined {
  const pattern = new RegExp(`(?:^|[,\\s])${field}\\s*=\\s*(?:\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|\"([^\"]*)\")`, "i");
  const match = pattern.exec(body);
  if (match === null) {
    return undefined;
  }
  const value = (match[1] ?? match[2] ?? "").trim();
  return value === "" ? undefined : value;
}

/** 从 bodyStart 起截取平衡花括号的条目体 */
function sliceEntryBody(text: string, start: number): string | null {
  let depth = 1;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index);
      }
    }
  }
  return null; // 未闭合（malformed）
}

function stripBraces(value: string): string {
  return value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}
