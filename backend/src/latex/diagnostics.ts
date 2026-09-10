/**
 * LaTeX 编译日志 → 结构化诊断（M4.7 Build Gate 产品化）。
 *
 * 从 build/compile.log 解析「文件 + 行号 + 错误信息 + 附近行」，供：
 * - Build Gate UI 的错误摘要（不再倾倒原始 stdout）
 * - Writer 修复循环的最小上下文（只给受影响文件与附近行，绝不整篇论文 + 整份日志）
 *
 * 确定性解析（无 LLM）：识别 "! Error" 行 + "l.NNN" 行号 + 括号文件栈。
 */

export interface LatexDiagnostic {
  /** 相对编译根（manuscript/）的文件路径；解析不出 → null */
  file: string | null;
  /** 出错行号；解析不出 → null */
  line: number | null;
  /** 错误信息（"!" 行原文） */
  message: string;
  /** 出错位置附近的内容行（供 Writer 精确定位；≤3 行） */
  contextLines: string[];
}

/** 最多保留的诊断条数（多错误日志只取前几个，上下文预算可控） */
export const MAX_DIAGNOSTICS = 5;

/**
 * 解析 compile.log（或编译 stdout）中的 LaTeX 错误。
 * 识别的形态（latexmk / xelatex nonstopmode 通用）：
 *   ! Undefined control sequence.
 *   l.42 \badcommand
 *   ("./sections/intro.tex" ... )  ← 括号文件栈，用于归属当前文件
 */
export function parseLatexDiagnostics(log: string): LatexDiagnostic[] {
  const lines = log.split(/\r?\n/);
  const diagnostics: LatexDiagnostic[] = [];

  // 文件栈：TeX 在日志里用 ( path 打开 / ) 关闭文件；栈顶 = 当前正在处理的文件
  const fileStack: string[] = [];
  let lastLineNo: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = raw.trim();

    // 错误行："! Undefined control sequence." / "! LaTeX Error: ..."（两种都以 "!" 开头）
    if (line.startsWith("!") && line.length > 1) {
      const message = line;
      // 向后看几行找 l.NNN 行号（TeX 在错误后紧跟 l.<行号> <该行内容>）
      let lineNo: number | null = null;
      const contextLines: string[] = [];
      for (let peek = index + 1; peek < Math.min(index + 6, lines.length); peek += 1) {
        const candidate = (lines[peek] ?? "").trim();
        const lineMatch = /^l\.(\d+)\s*(.*)$/.exec(candidate);
        if (lineMatch !== null && lineNo === null) {
          lineNo = Number(lineMatch[1]);
          const content = lineMatch[2];
          if (content !== undefined && content !== "") {
            contextLines.push(content.slice(0, 200));
          }
          continue;
        }
        if (candidate === "" || candidate.startsWith("!")) {
          break;
        }
        if (contextLines.length < 3 && !candidate.startsWith("(") && !candidate.startsWith(")")) {
          contextLines.push(candidate.slice(0, 200));
        }
      }
      diagnostics.push({
        file: currentFile(fileStack),
        line: lineNo ?? lastLineNo,
        message: message.slice(0, 300),
        contextLines,
      });
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        return diagnostics;
      }
      continue;
    }

    const lineNoMatch = /^l\.(\d+)/.exec(line);
    if (lineNoMatch !== null) {
      lastLineNo = Number(lineNoMatch[1]);
    }

    // 文件栈跟踪：只匹配明确的 .tex / .sty / .cls / .bib 打开（忽略零散括号）
    trackFileStack(fileStack, raw);
  }
  return diagnostics;
}

/** 当前正在处理的文件（栈顶最近的非空路径；全空 → null） */
function currentFile(stack: string[]): string | null {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const file = stack[index];
    if (file !== undefined && file !== "") {
      return file;
    }
  }
  return null;
}

/** 一行里所有 "(path" 打开与 ")" 关闭（TeX 日志的文件栈；原地维护 stack） */
function trackFileStack(stack: string[], rawLine: string): void {
  let index = 0;
  while (index < rawLine.length) {
    const ch = rawLine[index];
    if (ch === "(") {
      // 取 "(" 后到空白/括号的 token 作为文件名；裸 "(" 压入空占位
      const nameMatch = /^[^\s()]+/.exec(rawLine.slice(index + 1));
      if (nameMatch !== null) {
        stack.push(normalizeTexPath(nameMatch[0]));
        index += 1 + nameMatch[0].length;
        continue;
      }
      stack.push("");
      index += 1;
      continue;
    }
    if (ch === ")") {
      stack.pop();
    }
    index += 1;
  }
}

/** TeX 日志里的路径 → 相对 manuscript 的 POSIX 路径（./ 前缀与引号剥离） */
function normalizeTexPath(name: string): string {
  let path = name.replace(/^["'](.*?)["']$/, "$1");
  if (path.startsWith("./") || path.startsWith(".\\")) {
    path = path.slice(2);
  }
  return path.replaceAll("\\", "/");
}

/** 诊断 → Writer 修复上下文用的「受影响文件」列表（去重；null 文件跳过） */
export function diagnosticFiles(diagnostics: readonly LatexDiagnostic[]): string[] {
  const files: string[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.file === null) {
      continue;
    }
    if (!files.includes(diagnostic.file)) {
      files.push(diagnostic.file);
    }
  }
  return files;
}
