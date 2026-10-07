/**
 * LaTeX 文本转义（M12.3 C2）——图表 codegen 的唯一转义出口。
 *
 * 纪律（任务书 §12 注入安全）：
 * - spec 的全部用户文本（title / caption / 轴名 / series 名 / 类目标签 /
 *   节点与边 label / group label）必须经过本模块才能进入 .tex 输出；
 * - 覆盖全套 LaTeX 特殊字符：% $ & # _ { } ~ ^ \（处理顺序安全：单遍正则
 *   字符类替换，替换产物中的反斜杠不会被二次转义）；
 * - 反斜杠转义为 textbackslash 命令 + 空组（尾随 "{}" 保证后面紧跟字母时
 *   命令名正确终止，例如恶意输入 "\input{/etc/passwd}" 或 "\write18{rm -rf}"
 *   变成无害的纯文本形态，不再构成 TeX 控制序列）；
 * - schema 层（spec.ts）已拒绝控制字符，这里对残余控制字符做防御性归一
 *   （LF 保留给 escapeLatexMultiline 作受控换行；CR/CRLF 归一为 LF；其余
 *   控制字符归一为空格）——转义函数不允许把任何控制字符原样带进 TeX。
 *   控制字符判定用码点谓词而非正则转义：源文件保持纯 ASCII，避免编辑器
 *   / diff 工具把控制字符吞掉导致的静默损坏。
 *
 * 受控换行（DiagramSpec 节点 label 的多行语义）：spec 中用 LF 表示换行；
 * escapeLatexMultiline 先按 LF 切分、逐行转义、再以 TikZ 行分隔符（两个
 * 反斜杠）连接——仅在 TikZ 节点文本（样式含 align=center）中使用；用户
 * 输入里的反斜杠已变成 textbackslash 文本形态，不可能自行构造行分隔符。
 */

const LF = 0x0a;

/** 是否为需归一的控制字符（LF 除外）：C0、DEL、U+2028/2029 行分隔符 */
function isControlCharExceptNewline(code: number): boolean {
  return (
    code <= 0x09 ||
    (code >= 0x0b && code <= 0x1f) ||
    code === 0x7f ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/** CR/CRLF → LF；其余控制字符（LF 除外）→ 空格 */
function normalizeResidualControlChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === LF || code === 0x0d) {
      out += "\n";
    } else if (isControlCharExceptNewline(code)) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

/** 全套 LaTeX 特殊字符 → 安全形态（单遍替换，无二次转义风险） */
const LATEX_SPECIALS: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "%": "\\%",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

const LATEX_SPECIALS_CLASS = /[\\%$&#_{}~^]/g;

function escapeLine(line: string): string {
  return line.replace(LATEX_SPECIALS_CLASS, (ch) => LATEX_SPECIALS[ch] ?? ch);
}

/** 单行文本转义（残余换行归一为空格——单行上下文没有换行语义） */
export function escapeLatex(text: string): string {
  return normalizeResidualControlChars(text)
    .replace(/\n/g, " ")
    .replace(LATEX_SPECIALS_CLASS, escapeLine);
}

/**
 * 多行文本转义（TikZ 节点文本专用）：LF → TikZ 行分隔符（受控换行），
 * 每行内容经全套特殊字符转义。使用方必须同时设置 align=center 样式。
 */
export function escapeLatexMultiline(text: string): string {
  return normalizeResidualControlChars(text)
    .split("\n")
    .map(escapeLine)
    .join("\\\\");
}
