/**
 * M14.9.5 P0：PDF→文本转写伪影的确定性检测（零模型；输入保真门第 7 步）。
 *
 * 形态取自 M14.9.4 两篇已人工逐页核对的真实投影（v3 → v3qa 修补账本），只检测能由投影文本结构 + 独立源证据
 * 判定的通用形态，不含任何论文 ID / 刊名硬编码，也不做任何自动「修复」——尤其不按上下文猜测私用区字形
 * 代表的符号，不改动研究数值（原文笔误必须原样送审）：
 *   - PRIVATE_USE_GLYPH（soft）：私用区码位（PDF 字体映射缺失），没有字体映射 / 原图证据时无法确定字形；
 *   - FURNITURE_HEADING_SPLICE（hard）/ FURNITURE_AS_HEADING（soft）：只出现在版边的文本或栏目装饰标签
 *     （「·论著·」类）成为 Markdown 标题；打断句子时为硬失败（切断段落并制造伪章节，审稿单元随之错切）；
 *   - SENTENCE_SPLIT_BY_BLOCK（soft）：段落在句中结束，被表格 / 标题 / 图占位隔开后续接正文
 *     （展示公式常合法地位于句中，不计）；
 *   - LINE_BREAK_HYPHEN_RESIDUE（正文 soft / 参考文献 info）：行末断词连字符残留（「differ‐ ences」）；
 *   - HEADING_TEXT_DUPLICATED（soft）：标题文字被重复粘在上一段末尾（随后又以 Markdown 标题出现）；
 *   - REFERENCE_FRAGMENT（soft）：参考文献节中不以编号开头的残段（跨栏续文、英文译文单独成段）；
 *   - BLINDING_RESIDUE（soft）：正文中残留的期刊引用行（「（刊名缩写 年，卷（期）：起‐止页）」）。
 *
 * 条目内重复转写不按子串重复检测：机构名 / 学会名在合法条目里本就重复出现（16 篇回放全部为误报）。
 * 不检测「标题吞入正文首句」：独立源证据的标题块按行截断（标题与其下正文在文本层连续、无字体信息），
 * 真实标题边界无法从文本层确定——这类问题留给人工 QA，不用长度阈值臆断。
 */

import { canon } from "./inputFidelityText.js";
import type { FidelityFinding, SourceEvidence } from "./inputFidelityTypes.js";

/** 私用区码位（BMP 私用区 + 补充私用区 A/B） */
const PRIVATE_USE_SOURCE = "[\\uE000-\\uF8FF]|[\\uDB80-\\uDBFF][\\uDC00-\\uDFFF]";
const PRIVATE_USE = new RegExp(PRIVATE_USE_SOURCE);
/** 栏目 / 版头装饰标签：两侧为间隔点 / 项目符号的短标签（「·论著·」「• Original Article •」） */
const DECORATED_LABEL = /^[·•・●▪◆■]\s*[^\s·•・●▪◆■]{1,8}(?:\s[^\s·•・●▪◆■]{1,12}){0,2}\s*[·•・●▪◆■]$/u;
/** 句末（含引号 / 括号收尾）、冒号、分号：段落在这些字符处结束不算句中断开 */
const SENTENCE_END = /[。！？；：.!?;:…」』”"’'）)\]】．$]$/u;
/** 不是正文句子的行：Markdown 结构、表 / 图题、注、列表、中文序号标题、加粗独立行、关键词标签、短编号标题、占位符 */
const STRUCTURAL_LINE = new RegExp([
  "^(#{1,6}\\s|\\||\\$\\$|>\\s|[-*+]\\s|\\d+[.)]\\s)",
  "^\\*\\*\\s*(表|图|Table|Fig)", "^(表|图)\\s*\\d", "^(Table|Fig\\.?|Figure)\\s*\\d", "^(注|Notes?)\\s*[：:]",
  "^[一二三四五六七八九十]+\\s*[、.．]", "^[(（]\\s*[一二三四五六七八九十\\d]{1,3}\\s*[)）]",
  "^\\*\\*[^*]+\\*\\*$",
  "^(\\*\\*)?[【\\[]?\\s*(关键词|关键字|Key\\s*words?|Keywords?)",
  "^\\d+(?:\\s*[.．]\\s*\\d+)*\\s*[^\\s，。；,;]{1,30}$",
  "^（[^）]{1,16}）$",
  "^\\[FIGURE_CONTENT_NOT_EVALUATED",
].join("|"), "i");
const FIGURE_PLACEHOLDER = /^\[FIGURE_CONTENT_NOT_EVALUATED/;
/** 转写器给表格 / 公式加的未核验标记段（随后即表格 / 公式本体） */
const UNVERIFIED_MARKER = /^\[(TABLE|FORMULA)_UNVERIFIED/;
const JOURNAL_CITATION_LINE = /[(（]\s*[A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z.]*){1,9}\s+(?:19|20)\d{2}\s*[,，]\s*\d{1,3}\s*[(（]\s*\d{1,3}\s*[)）]\s*[:：]\s*\d+\s*[‐\-–]\s*\d+\s*[)）]/;
const LINE_BREAK_HYPHEN = /[A-Za-z]{2,}[\u2010\u00AD-]\s+(?!(?:and|or|to|und|et)\b)[a-z]{2,}/g;
const REFERENCES_HEADING = /^#{1,6}\s*(参\s*考\s*文\s*献|References?)(?![A-Za-z]).*$/im;
const NUMBERED_REFERENCE = /^(?:-\s*)?[[［]\s*\d{1,3}\s*[\]］]/;

type ParagraphKind = "heading" | "table" | "formula" | "figure" | "structural" | "text";
interface Paragraph { text: string; kind: ParagraphKind }

function paragraphs(text: string): Paragraph[] {
  return text.split(/\n[ \t]*\n/).map((raw) => raw.trim()).filter((raw) => raw !== "").map((raw) => {
    const first = raw.split("\n")[0]!;
    const kind: ParagraphKind = /^#{1,6}\s/.test(first) ? "heading"
      : /^\|/.test(first) ? "table"
        : /^\$\$/.test(first) ? "formula"
          : FIGURE_PLACEHOLDER.test(first) ? "figure"
            : UNVERIFIED_MARKER.test(first) ? "table"
            : STRUCTURAL_LINE.test(first) ? "structural" : "text";
    return { text: raw, kind };
  });
}

const headingText = (line: string): string => line.replace(/^#{1,6}\s*/, "").trim();

function endsMidSentence(paragraph: string): boolean {
  const last = paragraph.split("\n").pop()!.trim();
  if (last.length < 10 || STRUCTURAL_LINE.test(last)) return false;
  // 句末引文角标（「……[3]」「……［4-6］」）与强调标记不影响句末判断
  return !SENTENCE_END.test(last.replace(/\s*[[［][\d,，\s‐\-–]+[\]］]\s*$/, "").replace(/[*_]+$/, ""));
}

export function detectConversionArtifacts(text: string, source: Pick<SourceEvidence, "blocks">): FidelityFinding[] {
  const findings: FidelityFinding[] = [];
  const add = (finding: FidelityFinding) => findings.push(finding);
  const referencesHeading = REFERENCES_HEADING.exec(text);
  const body = referencesHeading !== null ? text.slice(0, referencesHeading.index) : text;
  const withoutFormulas = body.replace(/\$\$[\s\S]*?\$\$/g, " ");

  // ---- 私用区字形 ----
  const glyphCount = (withoutFormulas.match(new RegExp(PRIVATE_USE_SOURCE, "g")) ?? []).length;
  if (glyphCount > 0) {
    for (const line of withoutFormulas.split("\n").filter((entry) => PRIVATE_USE.test(entry)).slice(0, 5)) {
      const at = line.search(PRIVATE_USE);
      add({ code: "PRIVATE_USE_GLYPH", severity: "soft", detail: `投影正文含私用区字形（全篇 ${glyphCount} 处）：PDF 字体映射缺失，文本层无法确定其代表的符号；须对照原文字形 / 字体映射核对，不得按上下文猜测`, excerpt: line.slice(Math.max(0, at - 20), at + 40) });
    }
  }

  const paras = paragraphs(body);
  const sourceHeadings = new Set(source.blocks.filter((block) => block.role === "heading").map((block) => canon(block.text)));
  const bodyTexts = new Set(source.blocks.filter((block) => block.zone === "body").map((block) => canon(block.text)));
  const marginOnly = new Set(source.blocks.filter((block) => block.zone === "margin").map((block) => canon(block.text)).filter((value) => value.length >= 2 && !bodyTexts.has(value)));
  const furniture = new Set<number>();

  // ---- 版边 / 栏目标识成为标题 ----
  paras.forEach((paragraph, index) => {
    if (paragraph.kind !== "heading") return;
    const heading = headingText(paragraph.text.split("\n")[0]!);
    const own = canon(heading);
    // 文档题名（首段一级标题）常同时作为页眉重复出现，不是版边伪标题
    if (index === 0 && /^#\s/.test(paragraph.text)) return;
    if (own.length === 0 || sourceHeadings.has(own) || !(DECORATED_LABEL.test(heading) || marginOnly.has(own))) return;
    furniture.add(index);
    const before = paras[index - 1];
    const after = paras[index + 1];
    const splits = before !== undefined && before.kind === "text" && after !== undefined && after.kind === "text" && endsMidSentence(before.text);
    add({
      code: splits ? "FURNITURE_HEADING_SPLICE" : "FURNITURE_AS_HEADING",
      severity: splits ? "hard" : "soft",
      detail: splits
        ? "版边 / 栏目标识被插入句中并成为 Markdown 标题：句子被切断，并制造出不存在的章节（审稿单元随之错切）"
        : "版边 / 栏目标识成为 Markdown 标题（不是本文章节）",
      excerpt: `${before?.text.slice(-30) ?? ""} ⟦${heading}⟧ ${after?.text.slice(0, 30) ?? ""}`,
    });
  });

  // ---- 句子被表格 / 标题 / 图占位隔断（版边标识造成的断句已由上面判硬失败，不重复计） ----
  paras.forEach((paragraph, index) => {
    if (paragraph.kind !== "text" || !endsMidSentence(paragraph.text)) return;
    let next = index + 1;
    while (next < paras.length && paras[next]!.kind !== "text") next += 1;
    if (next === index + 1 || next >= paras.length) return;
    const between = paras.slice(index + 1, next);
    if (between.some((_entry, offset) => furniture.has(index + 1 + offset))) return;
    if (!between.some((entry) => entry.kind === "table" || entry.kind === "heading" || entry.kind === "figure")) return;
    const ownTail = canon(paragraph.text.slice(-80));
    const duplicated = between.find((entry) => entry.kind === "heading" && canon(headingText(entry.text)).length >= 4 && ownTail.endsWith(canon(headingText(entry.text))));
    if (duplicated !== undefined) {
      add({ code: "HEADING_TEXT_DUPLICATED", severity: "soft", detail: "标题文字被重复粘在上一段末尾，随后又以 Markdown 标题出现（转写重复）", excerpt: `${paragraph.text.slice(-40)} ⟦${headingText(duplicated.text).slice(0, 30)}⟧` });
      return;
    }
    add({ code: "SENTENCE_SPLIT_BY_BLOCK", severity: "soft", detail: `段落在句中结束，后接 ${between.map((entry) => entry.kind).join("+")} 再续正文（表格 / 标题 / 图插入句中，或句子后半被移位）`, excerpt: `${paragraph.text.slice(-40)} ⟦…⟧ ${paras[next]!.text.slice(0, 30)}` });
  });

  // ---- 行末断词连字符（正文影响审稿 = soft；参考文献只记录） ----
  const bodyHyphens = [...withoutFormulas.matchAll(LINE_BREAK_HYPHEN)];
  if (bodyHyphens.length > 0) {
    add({ code: "LINE_BREAK_HYPHEN_RESIDUE", severity: "soft", detail: `正文行末断词连字符残留 ${bodyHyphens.length} 处（单词被拆成两段；是否为复合词连字符需对照原文）`, excerpt: bodyHyphens.slice(0, 4).map((match) => match[0]).join(" / ") });
  }

  if (referencesHeading !== null) {
    const tail = text.slice(referencesHeading.index + referencesHeading[0].length);
    const end = tail.search(/^#{1,6}\s/m);
    const section = end >= 0 ? tail.slice(0, end) : tail;
    const referenceHyphens = [...section.matchAll(LINE_BREAK_HYPHEN)];
    if (referenceHyphens.length > 0) {
      add({ code: "LINE_BREAK_HYPHEN_RESIDUE", severity: "info", detail: `参考文献行末断词连字符残留 ${referenceHyphens.length} 处`, excerpt: referenceHyphens.slice(0, 4).map((match) => match[0]).join(" / ") });
    }
    // ---- 参考文献残段 / 重复转写 ----
    const entries = section.split(/\n[ \t]*\n/).map((entry) => entry.trim()).filter((entry) => entry !== "" && !FIGURE_PLACEHOLDER.test(entry));
    const fragments = entries.filter((entry) => !NUMBERED_REFERENCE.test(entry));
    if (fragments.length > 0) {
      add({ code: "REFERENCE_FRAGMENT", severity: "soft", detail: `参考文献节中有 ${fragments.length} 段不以「[n]」编号开头（跨栏续文 / 英文译文单独成段：会被当作另一条文献或孤立文本）`, excerpt: fragments[0]!.slice(0, 80) });
    }
  }

  // ---- 期刊引用行残留 ----
  const citation = JOURNAL_CITATION_LINE.exec(body.normalize("NFKC"));
  if (citation !== null) {
    add({ code: "BLINDING_RESIDUE", severity: "soft", detail: "参考文献之前残留期刊引用行（刊名缩写 + 年 / 卷 / 期 / 页码，可推断出处与期刊级别）", excerpt: citation[0].slice(0, 120) });
  }
  return findings;
}
