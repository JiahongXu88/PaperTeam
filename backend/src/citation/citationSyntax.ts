/**
 * Deterministic Citation / LaTeX Syntax Repair（M11.3 Phase D）。
 *
 * 背景（MOT 真实残留 blocking 的定案）：连续三轮修不掉的「\cite 未闭合 /
 * 段落截断」critical 是 review digest 的**视图截断伪影**（buildManuscriptDigest
 * 每节 2500 字符硬切，恰好切在 \cite{ng 之间——稿件本身完好、编译通过）。
 * Writer 按伪影修稿当然修不掉；LLM Revision 在这里是纯浪费。
 *
 * 本模块的定位（§20–§24）：
 * - detect：对**真实文件**做确定性结构检查（未闭合 \cite 族 / 空 cite /
 *   空 key 段 / 同命令重复 key）——StaticCitationChecker 的正则只匹配已闭合
 *   命令，未闭合形式在旧检查里不可见；
 * - repair：只修「outcome 唯一明确」的结构问题（空命令移除、空段清理、
 *   重复 key 去重、key 完整匹配 bib 时的未闭合补右括号）；
 *   **绝不猜 key**（残缺 key 不自动补全、不换成「最像的 key」——歧义留给
 *   Quality Gate 报错 / Writer / 作者决策）；
 * - disconfirm：reviewer 的 build 类 finding（指控稿件截断 / cite 未闭合）
 *   与真实文件检测交叉核验——真实文件无此问题 = digest 伪影，finding 标注
 *   deterministicDisconfirmed，不再烧修订轮。
 */

/** 与 StaticCitationChecker 同源的 \cite 族命令前缀（不含闭合括号要求） */
const CITE_COMMAND_START =
  /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|parencite|textcite|autocite|nocite|footcite|smartcite)\*?(?:\[[^\]\n]*\])*\{/g;

export type CitationSyntaxIssueKind =
  | "unclosed_cite"
  | "empty_cite"
  | "empty_key_segment"
  | "duplicate_key"
  | "invalid_key_char";

export interface CitationSyntaxIssue {
  file: string;
  /** 1 起行号 */
  line: number;
  kind: CitationSyntaxIssueKind;
  /** 现场片段（人读；≤80 字符） */
  snippet: string;
  /** duplicate_key / invalid_key_char 的具体 key */
  key?: string;
}

export interface CitationSyntaxRepairResult {
  repaired: boolean;
  content: string;
  fixes: { kind: CitationSyntaxIssueKind; count: number }[];
  /** 检测到但不可自动修（歧义，留 Quality Gate / Writer / 作者决策） */
  unresolved: CitationSyntaxIssue[];
}

/**
 * 未闭合 \cite 检测：命令起始的 `{` 之后在「本行内」找不到 `}` 即未闭合
 * （跨行 cite 不是合法 LaTeX 排版；>200 字符窗口防误吞整段）。
 */
export function detectCitationSyntaxIssues(
  texFiles: readonly { file: string; content: string }[],
  bibKeys: readonly string[] = [],
): CitationSyntaxIssue[] {
  const issues: CitationSyntaxIssue[] = [];
  const keySet = new Set(bibKeys);
  for (const { file, content } of texFiles) {
    CITE_COMMAND_START.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITE_COMMAND_START.exec(content)) !== null) {
      const openAt = match.index + match[0].length - 1; // 指向 `{`
      const line = content.slice(0, openAt).split("\n").length;
      const lineEnd = content.indexOf("\n", openAt);
      const windowEnd = lineEnd === -1 ? content.length : Math.min(lineEnd, openAt + 200);
      const closeAt = content.indexOf("}", openAt);
      const snippetBase = content.slice(match.index, Math.min(windowEnd, match.index + 80));
      if (closeAt === -1 || closeAt > windowEnd) {
        // 未闭合：key 完整且在 bib 中 → 可确定性补括号；否则歧义
        const rawKey = content.slice(openAt + 1, windowEnd).trim();
        issues.push({
          file,
          line,
          kind: "unclosed_cite",
          snippet: snippetBase.replace(/\n/g, "⏎"),
          ...(rawKey !== "" ? { key: rawKey } : {}),
        });
        continue;
      }
      // 已闭合：检查内容质量
      const body = content.slice(openAt + 1, closeAt);
      if (body.trim() === "") {
        issues.push({ file, line, kind: "empty_cite", snippet: snippetBase.replace(/\n/g, "⏎") });
        continue;
      }
      const parts = body.split(",").map((part) => part.trim());
      if (parts.some((part) => part === "")) {
        issues.push({ file, line, kind: "empty_key_segment", snippet: snippetBase.replace(/\n/g, "⏎") });
      }
      const seen = new Set<string>();
      for (const part of parts) {
        if (part === "") {
          continue;
        }
        if (seen.has(part)) {
          issues.push({
            file,
            line,
            kind: "duplicate_key",
            snippet: snippetBase.replace(/\n/g, "⏎"),
            key: part,
          });
        }
        seen.add(part);
        if (!/^[A-Za-z0-9_.:+*-]+$/.test(part) && !keySet.has(part)) {
          issues.push({
            file,
            line,
            kind: "invalid_key_char",
            snippet: snippetBase.replace(/\n/g, "⏎"),
            key: part.slice(0, 40),
          });
        }
      }
    }
  }
  return issues;
}

/**
 * 单文件确定性修复（§22：outcome 唯一明确才动手）：
 * - empty_cite：整命令移除（含可能的前置 ~ / 空格收缩）——空引用不指向任何
 *   文献，移除是唯一无损动作；
 * - empty_key_segment：`a,,b` / `a,` → `a,b` / `a`；
 * - duplicate_key：同命令重复 key 去重（保序）；
 * - unclosed_cite：仅当 key（到行尾的剩余文本整体）**完整匹配** bib key 时
 *   补 `}`（无猜测：残缺 key / 拼写不完整一律不修，标 unresolved）。
 * 其余（invalid_key_char 等）不修，如实进 unresolved。
 */
export function repairCitationSyntax(
  content: string,
  file: string,
  bibKeys: readonly string[],
): CitationSyntaxRepairResult {
  const fixes = new Map<CitationSyntaxIssueKind, number>();
  const unresolved: CitationSyntaxIssue[] = [];
  let output = content;
  const keySet = new Set(bibKeys);

  // 1. 已闭合命令内的内容修复（空 cite / 空段 / 重复 key）；空 cite 移除时
  //    一并收缩紧邻的前置 ~ / 空格（~\cite{} 整体是无指向的悬空引用位）
  output = output.replace(
    /([~\t ]*)\\((?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|parencite|textcite|autocite|nocite|footcite|smartcite))\*?((?:\[[^\]\n]*\])*)\{([^{}\n]*)\}/g,
    (whole, lead: string, command: string, optional: string, body: string) => {
      if (body.trim() === "") {
        fixes.set("empty_cite", (fixes.get("empty_cite") ?? 0) + 1);
        return "";
      }
      const parts = body.split(",").map((part) => part.trim()).filter((part) => part !== "");
      if (parts.length === 0) {
        fixes.set("empty_cite", (fixes.get("empty_cite") ?? 0) + 1);
        return "";
      }
      const deduped: string[] = [];
      for (const part of parts) {
        if (!deduped.includes(part)) {
          deduped.push(part);
        }
      }
      if (deduped.length !== parts.length) {
        fixes.set("duplicate_key", (fixes.get("duplicate_key") ?? 0) + (parts.length - deduped.length));
      }
      const joined = deduped.join(",");
      if (joined !== body) {
        if (parts.length === deduped.length) {
          fixes.set("empty_key_segment", (fixes.get("empty_key_segment") ?? 0) + 1);
        }
        return `${lead}\\${command}${optional}{${joined}}`;
      }
      return whole;
    },
  );

  // 2. 未闭合命令：key 完整命中 bib → 补右括号（唯一明确）；否则 unresolved
  const found: { at: number; line: number; key: string }[] = [];
  const scanner = new RegExp(CITE_COMMAND_START.source, "g");
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(output)) !== null) {
    const openAt = match.index + match[0].length - 1;
    const lineEnd = output.indexOf("\n", openAt);
    const windowEnd = lineEnd === -1 ? output.length : Math.min(lineEnd, openAt + 200);
    const closeAt = output.indexOf("}", openAt);
    if (closeAt === -1 || closeAt > windowEnd) {
      const rawKey = output.slice(openAt + 1, windowEnd).trim();
      found.push({ at: openAt, line: output.slice(0, openAt).split("\n").length, key: rawKey });
    }
  }
  if (found.length > 0) {
    // 从后往前处理（保前面的偏移）
    let patched = output;
    for (const item of [...found].reverse()) {
      const lineEnd = patched.indexOf("\n", item.at);
      const segment = patched.slice(item.at + 1, lineEnd === -1 ? patched.length : lineEnd);
      const keyAt = item.key !== "" ? segment.indexOf(item.key) : -1;
      if (item.key !== "" && keyAt !== -1 && keySet.has(item.key)) {
        const insertAt = item.at + 1 + keyAt + item.key.length; // 紧跟 key 之后
        patched = patched.slice(0, insertAt) + "}" + patched.slice(insertAt);
        fixes.set("unclosed_cite", (fixes.get("unclosed_cite") ?? 0) + 1);
      } else {
        unresolved.push({
          file,
          line: item.line,
          kind: "unclosed_cite",
          snippet: patched.slice(Math.max(0, item.at - 10), item.at + 70).replace(/\n/g, "⏎"),
          ...(item.key !== "" ? { key: item.key.slice(0, 40) } : {}),
        });
      }
    }
    output = patched;
  }

  const fixList = [...fixes.entries()].map(([kind, count]) => ({ kind, count }));
  return {
    repaired: fixList.length > 0,
    content: output,
    fixes: fixList,
    unresolved,
  };
}

/**
 * Reviewer build 类 finding 的确定性反证（§20 定案动作）：
 * finding 指控「截断 / \cite 未闭合 / 段落缺失」类结构缺陷，而真实文件检测
 * 无对应问题 → finding 是 digest 视图伪影（非稿件缺陷），标注后不计入
 * blocking 口径、不派发 Writer 修复。
 */
export function disconfirmBuildFindings(
  issues: readonly { category?: string; severity?: string; blocking?: boolean; description?: string; section?: string }[],
  texFiles: readonly { file: string; content: string }[],
  bibKeys: readonly string[] = [],
): {
  disconfirmedCount: number;
  isDisconfirmed: (issue: { category?: string; description?: string }) => boolean;
} {
  const detected = detectCitationSyntaxIssues(texFiles, bibKeys);
  const hasUnclosed = detected.some((issue) => issue.kind === "unclosed_cite" || issue.kind === "empty_cite");
  // 指控「未闭合 cite / 截断」的 finding 文本特征（中英；保守词面，宁漏勿错杀）
  const TRUNCATION_PATTERN = /未闭合|截断|缺失.*(条|项|内容)|unclosed|truncat/i;
  const disconfirmed = new Set<unknown>();
  for (const issue of issues) {
    if ((issue.category ?? "") !== "build") {
      continue;
    }
    const text = issue.description ?? "";
    if (!TRUNCATION_PATTERN.test(text)) {
      continue;
    }
    // 真实文件确有未闭合 → 指控成立，不反证
    if (hasUnclosed) {
      continue;
    }
    disconfirmed.add(issue);
  }
  return {
    disconfirmedCount: disconfirmed.size,
    isDisconfirmed: (issue) => disconfirmed.has(issue),
  };
}
