/**
 * Style Invariant Checker（M5.4）：style-only 修订前后的确定性守卫。
 *
 * 语言润色只允许改表达，不允许改事实。能确定性检查的在这里检查：
 *   A. citation key 多重集（\cite 及变体）不变
 *   B. 数字 literal（含小数 / 百分比 / 科学计数）+ 紧随单位的多重集不变
 *   C. 数学片段（$…$ / \(…\) / \[…\] / equation·align 等环境）多重集不变
 *   D. 关键 LaTeX 结构（\ref / \label / \eqref / \begin / \end 环境名）多重集不变
 *   E. 受保护术语（glossary / 调用方传入）出现次数不减少
 *   F. 否定 / 比较 / 结论强度 sentinel 词计数不变（保守哨兵）
 *
 * 诚实边界：这是「必要条件」守卫，不是语义等价证明——F 只是保守哨兵：哨兵词计数
 * 变化即阻断并要求复审；计数不变也不代表语义一定相同。最终语义保持仍需 Reviewer
 * 复审 + 人审（见 docs/ARCHITECTURE.md §13 与 M5_PLAN M5.4）。
 */

export type StyleInvariantRule =
  | "citation_keys"
  | "numeric_literals"
  | "math_segments"
  | "latex_structure"
  | "protected_terms"
  | "sentinel_words";

export interface StyleInvariantViolation {
  rule: StyleInvariantRule;
  /** 人类可读说明（含具体差异样本，有界） */
  detail: string;
  /** 修改前多 / 修改后多 的差异样本（各 ≤ 10 条） */
  missing: string[];
  added: string[];
}

export interface StyleInvariantReport {
  ok: boolean;
  violations: StyleInvariantViolation[];
  /** 逐规则结果（含通过项，便于 UI 展示「检查了什么」） */
  checks: Record<StyleInvariantRule, { passed: boolean; before: number; after: number }>;
}

export interface StyleInvariantOptions {
  /** 受保护术语（glossary / 调用方传入）：修改后出现次数不得少于修改前 */
  protectedTerms?: readonly string[];
}

/**
 * 否定 / 比较 / 结论强度哨兵词（保守列表；「不」单字过于常见，只取其常见复合形式，
 * 否则合法的润色也会被误伤）。计数变化即阻断。
 */
export const SENTINEL_WORDS: readonly string[] = [
  "未",
  "无法",
  "并非",
  "并不",
  "不能",
  "不会",
  "不再",
  "不足",
  "不同",
  "不显著",
  "低于",
  "高于",
  "优于",
  "差于",
  "劣于",
  "增加",
  "降低",
  "减少",
  "提高",
  "显著",
  "导致",
  "因此",
  "证明",
  "表明",
  "可能",
];

const CITE_PATTERN = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;
const REF_PATTERN = /\\(ref|eqref|label|autoref|cref|Cref|pageref)\{([^}]*)\}/g;
const ENV_PATTERN = /\\(begin|end)\{([^}]*)\}/g;
const MATH_ENVS = ["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "math"];
/**
 * 数字 literal：可选负号、整数 / 小数 / 千分位 / 科学计数，紧随的 %、‰、单位字母串
 * （如 ms、GB、dB、mAP、°C）或中文计量词（倍 / 个 / 次 / 张 / 项 / 例 / 年 / 月 / 天 / 篇 / 层）。
 * 不匹配 LaTeX 命令内部（如 \section 后的 label 编号），因此先剥离命令参数中的 label/ref。
 */
const NUMBER_PATTERN = /(?<![A-Za-z\\])[-−]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?(?:\s?(?:%|‰|°C|[A-Za-zμ]{1,6}|倍|个|次|张|项|例|年|月|天|篇|层|条|组|类|种|轮|步|位))?/g;

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function countMap(items: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item, (map.get(item) ?? 0) + 1);
  }
  return map;
}

/** 多重集差异：missing = before 多出的，added = after 多出的（各 ≤ 10 条样本） */
function diffMultiset(before: readonly string[], after: readonly string[]): { missing: string[]; added: string[] } {
  const a = countMap(before);
  const b = countMap(after);
  const missing: string[] = [];
  const added: string[] = [];
  for (const [key, count] of a) {
    const other = b.get(key) ?? 0;
    for (let i = 0; i < count - other && missing.length < 10; i += 1) {
      missing.push(key);
    }
  }
  for (const [key, count] of b) {
    const other = a.get(key) ?? 0;
    for (let i = 0; i < count - other && added.length < 10; i += 1) {
      added.push(key);
    }
  }
  return { missing, added };
}

/** \cite 类命令中的 key（逗号分隔逐个展开；多重集） */
export function extractCitationKeys(latex: string): string[] {
  const keys: string[] = [];
  for (const match of normalize(latex).matchAll(CITE_PATTERN)) {
    for (const key of (match[1] ?? "").split(",")) {
      const trimmed = key.trim();
      if (trimmed !== "") {
        keys.push(trimmed);
      }
    }
  }
  return keys.sort();
}

/** 数学片段（内容归一化空白后比较；多重集） */
export function extractMathSegments(latex: string): string[] {
  const text = normalize(latex);
  const segments: string[] = [];
  const push = (raw: string): void => {
    const compact = raw.replace(/\s+/g, " ").trim();
    if (compact !== "") {
      segments.push(compact);
    }
  };
  // 环境
  const envRegex = new RegExp(
    `\\\\begin\\{(${MATH_ENVS.map((env) => env.replace("*", "\\*")).join("|")})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
    "g",
  );
  let stripped = text.replace(envRegex, (_whole, _env: string, body: string) => {
    push(body);
    return " ";
  });
  // \[ … \] 与 \( … \)
  stripped = stripped.replace(/\\\[([\s\S]*?)\\\]/g, (_whole, body: string) => {
    push(body);
    return " ";
  });
  stripped = stripped.replace(/\\\(([\s\S]*?)\\\)/g, (_whole, body: string) => {
    push(body);
    return " ";
  });
  // $$ … $$ 与 $ … $（不跨越空行）
  stripped = stripped.replace(/\$\$([\s\S]*?)\$\$/g, (_whole, body: string) => {
    push(body);
    return " ";
  });
  stripped.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (_whole, body: string) => {
    push(body);
    return " ";
  });
  return segments.sort();
}

/** 去掉数学与命令参数后的「正文」（数字 / 哨兵词 / 术语在此上计数） */
function proseOf(latex: string): string {
  let text = normalize(latex);
  const envRegex = new RegExp(
    `\\\\begin\\{(${MATH_ENVS.map((env) => env.replace("*", "\\*")).join("|")})\\}[\\s\\S]*?\\\\end\\{\\1\\}`,
    "g",
  );
  text = text.replace(envRegex, " ");
  text = text.replace(/\\\[[\s\S]*?\\\]/g, " ").replace(/\\\([\s\S]*?\\\)/g, " ");
  text = text.replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/(?<!\\)\$[^$\n]+?(?<!\\)\$/g, " ");
  text = text.replace(CITE_PATTERN, " ").replace(REF_PATTERN, " ").replace(ENV_PATTERN, " ");
  // LaTeX 转义的百分号 / 千分号还原为符号（33.5\% 是 33.5%）
  text = text.replace(/\\%/g, "%").replace(/\\‰/g, "‰");
  // 其余命令名保留参数内容（\textbf{显著} 中的「显著」仍是正文）
  text = text.replace(/\\[A-Za-z@]+\*?/g, " ");
  return text;
}

/** 数字 literal（+ 紧随单位）多重集 */
export function extractNumericTokens(latex: string): string[] {
  const tokens: string[] = [];
  for (const match of proseOf(latex).matchAll(NUMBER_PATTERN)) {
    tokens.push(match[0].replace(/\s+/g, ""));
  }
  return tokens.sort();
}

/** \ref / \label / \eqref 等与 \begin / \end 环境名（多重集） */
export function extractLatexStructure(latex: string): string[] {
  const text = normalize(latex);
  const items: string[] = [];
  for (const match of text.matchAll(REF_PATTERN)) {
    items.push(`\\${match[1]}{${(match[2] ?? "").trim()}}`);
  }
  for (const match of text.matchAll(ENV_PATTERN)) {
    items.push(`\\${match[1]}{${(match[2] ?? "").trim()}}`);
  }
  return items.sort();
}

function countOccurrences(text: string, needle: string): number {
  if (needle === "") {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 哨兵词计数（正文上；多重集展开为重复项以复用 diff） */
export function extractSentinelWords(latex: string): string[] {
  const prose = proseOf(latex);
  const out: string[] = [];
  for (const word of SENTINEL_WORDS) {
    const count = countOccurrences(prose, word);
    for (let i = 0; i < count; i += 1) {
      out.push(word);
    }
  }
  return out.sort();
}

/**
 * 从章节内容确定性派生「必须保持」的清单（给 Writer 的受保护内容提示；
 * 与 invariant 检查同源，避免提示与检查口径不一致）。
 */
export function protectedInventory(latex: string): {
  citationKeys: string[];
  numbers: string[];
  mathSegments: number;
  structure: string[];
} {
  return {
    citationKeys: Array.from(new Set(extractCitationKeys(latex))),
    numbers: Array.from(new Set(extractNumericTokens(latex))),
    mathSegments: extractMathSegments(latex).length,
    structure: Array.from(new Set(extractLatexStructure(latex))),
  };
}

export function checkStyleInvariants(
  before: string,
  after: string,
  options: StyleInvariantOptions = {},
): StyleInvariantReport {
  const violations: StyleInvariantViolation[] = [];
  const checks = {} as StyleInvariantReport["checks"];

  const compare = (
    rule: StyleInvariantRule,
    beforeItems: string[],
    afterItems: string[],
    describe: (diff: { missing: string[]; added: string[] }) => string,
    allowGrowth = false,
  ): void => {
    const diff = diffMultiset(beforeItems, afterItems);
    const failed = diff.missing.length > 0 || (!allowGrowth && diff.added.length > 0);
    checks[rule] = { passed: !failed, before: beforeItems.length, after: afterItems.length };
    if (failed) {
      violations.push({ rule, detail: describe(diff), missing: diff.missing, added: diff.added });
    }
  };

  compare("citation_keys", extractCitationKeys(before), extractCitationKeys(after), (diff) =>
    `citation key 集合变化：缺少 [${diff.missing.join(", ")}]，新增 [${diff.added.join(", ")}]`,
  );
  compare("numeric_literals", extractNumericTokens(before), extractNumericTokens(after), (diff) =>
    `数字 / 单位变化：缺少 [${diff.missing.join(", ")}]，新增 [${diff.added.join(", ")}]`,
  );
  compare("math_segments", extractMathSegments(before), extractMathSegments(after), (diff) =>
    `数学片段变化：缺少 ${diff.missing.length} 段，新增 ${diff.added.length} 段（样本：${[...diff.missing, ...diff.added]
      .slice(0, 3)
      .map((segment) => segment.slice(0, 60))
      .join(" | ")}）`,
  );
  compare("latex_structure", extractLatexStructure(before), extractLatexStructure(after), (diff) =>
    `LaTeX 结构变化：缺少 [${diff.missing.join(", ")}]，新增 [${diff.added.join(", ")}]`,
  );

  // E. 受保护术语：只要求不减少（润色可能合理地把术语再提一次）
  const terms = Array.from(new Set((options.protectedTerms ?? []).map((term) => term.trim()).filter((term) => term !== "")));
  const beforeProse = proseOf(before);
  const afterProse = proseOf(after);
  const decreased: string[] = [];
  let beforeTermTotal = 0;
  let afterTermTotal = 0;
  for (const term of terms) {
    const b = countOccurrences(beforeProse, term);
    const a = countOccurrences(afterProse, term);
    beforeTermTotal += b;
    afterTermTotal += a;
    if (a < b) {
      decreased.push(`${term}（${b} → ${a}）`);
    }
  }
  checks.protected_terms = { passed: decreased.length === 0, before: beforeTermTotal, after: afterTermTotal };
  if (decreased.length > 0) {
    violations.push({
      rule: "protected_terms",
      detail: `受保护术语出现次数减少：${decreased.slice(0, 10).join("；")}`,
      missing: decreased.slice(0, 10),
      added: [],
    });
  }

  // F. 哨兵词：计数变化即阻断（保守；不是语义证明）
  compare("sentinel_words", extractSentinelWords(before), extractSentinelWords(after), (diff) =>
    `否定 / 比较 / 结论强度哨兵词计数变化：减少 [${diff.missing.join(", ")}]，增加 [${diff.added.join(", ")}]——需要复审确认语义未变`,
  );

  return { ok: violations.length === 0, violations, checks };
}
